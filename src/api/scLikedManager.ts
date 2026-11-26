import { YTMTrack } from './yt';
import { likedStore, ScLikedEntry } from './likedStore';
import { tracksStore } from './tracks';
import { isScAuthed, getScLikedMeta, getScLikedEntries, addScLocalOnlyId, removeScLocalOnlyId, loadScLocalOnlyIds } from './soundcloud';
import type { PendingScLikeChange } from './scLikeQueue';

type PendingScChangesProvider = () => Map<string, PendingScLikeChange>;
let pendingChangesProvider: PendingScChangesProvider = () => new Map();

// Регистрация источника pending-лайков без циклического импорта с likedManager.ts.
export function registerScPendingChangesProvider(provider: PendingScChangesProvider): void {
  pendingChangesProvider = provider;
}

// Менеджер локального зеркала SoundCloud-лайков. Аналог likedManager, но для SC:
// дешевая сверка (likes_count + первые id) -> полный рефетч только при расхождении.
class ScLikedManager {
  private _isSyncing = false;
  private listeners: ((entries: ScLikedEntry[], syncing: boolean) => void)[] = [];
  private localOpChain: Promise<void> = Promise.resolve();
  private mutatedDuringSync = new Set<string>();

  get isSyncing() { return this._isSyncing; }

  subscribe(listener: (entries: ScLikedEntry[], syncing: boolean) => void) {
    this.listeners.push(listener);
    return () => { this.listeners = this.listeners.filter(l => l !== listener); };
  }

  private notify(entries: ScLikedEntry[], syncing: boolean) {
    this.listeners.forEach(l => l(entries, syncing));
  }

  // Сериализуем локальные записи в IndexedDB, чтобы быстрые клики Like/Unlike и sync не перетирали друг друга.
  private enqueueLocalOp(op: () => Promise<void>): Promise<void> {
    const next = this.localOpChain.then(op, op);
    this.localOpChain = next.catch(() => {});
    return next;
  }

  async sync() {
    if (this._isSyncing) return;

    if (!isScAuthed()) {
      // Не чистим: localOnly-записи должны сохраниться
      const local = await likedStore.getAllScTracks();
      this.notify(local, false);
      return;
    }

    this._isSyncing = true;
    this.mutatedDuringSync.clear();
    try {
      const pendingAtStart = pendingChangesProvider();
      const local = await likedStore.getAllScTracks();
      this.notify(local, true);

      const meta = await getScLikedMeta();
      if (!meta) {
        await this.localOpChain;
        const freshLocal = await likedStore.getAllScTracks();
        this._isSyncing = false;
        this.mutatedDuringSync.clear();
        this.notify(freshLocal, false);
        return;
      }

      await this.localOpChain;
      const freshLocal = await likedStore.getAllScTracks();
      // Фильтруем localOnly для head-match, иначе они будут вверху списка и head никогда не совпадет
      const freshLocalWithoutLocalOnly = freshLocal.filter(e => !e.localOnly);
      const localCount = await likedStore.getScVirtualCount();
      const headLen = Math.min(5, meta.headIds.length, freshLocalWithoutLocalOnly.length);
      const headMatch = headLen > 0 && meta.headIds.slice(0, headLen).every((id, i) => freshLocalWithoutLocalOnly[i]?.scId === id);

      // Счетчик совпал и "голова" списка та же -> зеркало актуально, без полной выгрузки
      // (если не было локальных мутаций во время синка и нет pending-лайков).
      if (
        this.mutatedDuringSync.size === 0 &&
        pendingAtStart.size === 0 &&
        pendingChangesProvider().size === 0 &&
        meta.count === localCount &&
        headMatch &&
        freshLocalWithoutLocalOnly.length > 0
      ) {
        this._isSyncing = false;
        this.mutatedDuringSync.clear();
        this.notify(freshLocal, false);
        return;
      }

      const fresh = await getScLikedEntries();
      if (!fresh) {
        await this.localOpChain;
        const freshLocalOnError = await likedStore.getAllScTracks();
        this._isSyncing = false;
        this.mutatedDuringSync.clear();
        this.notify(freshLocalOnError, false);
        return;
      }
      let finalMerged: ScLikedEntry[] = [];

      await this.enqueueLocalOp(async () => {
        const currentLocal = await likedStore.getAllScTracks();
        const currentLocalById = new Map(currentLocal.map(e => [e.scId, e]));
        const serverIds = new Set(fresh.map(e => e.scId));
        const localOnlyEntries = currentLocal.filter(e => e.localOnly && !serverIds.has(e.scId));

        for (const entry of fresh) {
          const existing = currentLocalById.get(entry.scId);
          if (existing?.localOnly) {
            entry.likedAt = entry.likedAt || existing.likedAt;
          }
        }

        let merged: ScLikedEntry[] = [...fresh, ...localOnlyEntries];
        const pendingNow = pendingChangesProvider();
        let pendingDelta = 0;

        // Треки, которые были в pending на старте или мутировали во время синка и успели подтвердиться
        // быстрее ответа getScLikedEntries(): для них currentLocal актуальнее снимка сервера.
        const settledIds = new Set<string>();
        for (const scId of pendingAtStart.keys()) {
          if (!pendingNow.has(scId)) settledIds.add(scId);
        }
        for (const scId of this.mutatedDuringSync) {
          if (!pendingNow.has(scId)) settledIds.add(scId);
        }

        if (pendingNow.size > 0 || settledIds.size > 0) {
          const filtered: ScLikedEntry[] = [];
          for (const entry of merged) {
            const pendingChange = pendingNow.get(entry.scId);
            if (pendingChange && !pendingChange.liked) {
              if (!entry.localOnly) pendingDelta -= 1;
              continue;
            }
            if (!pendingChange && settledIds.has(entry.scId) && !currentLocalById.has(entry.scId)) {
              if (!entry.localOnly) pendingDelta -= 1;
              continue;
            }
            filtered.push(entry);
          }
          merged = filtered;

          const presentIds = new Set(merged.map(e => e.scId));
          const additions: ScLikedEntry[] = [];

          for (const [scId, change] of pendingNow) {
            if (change.liked && !presentIds.has(scId)) {
              await tracksStore.upsertTrack({ ...change.track, likeStatus: 'LIKE' });
              const existingLocal = currentLocalById.get(scId);
              additions.push({
                scId,
                trackId: change.track.id,
                likedAt: existingLocal?.likedAt || Date.now(),
              });
              presentIds.add(scId);
              pendingDelta += 1;
            }
          }

          for (const scId of settledIds) {
            if (presentIds.has(scId)) continue;
            const localEntry = currentLocalById.get(scId);
            if (localEntry) {
              additions.push(localEntry);
              presentIds.add(scId);
              if (!localEntry.localOnly) pendingDelta += 1;
            }
          }

          if (additions.length > 0) {
            merged = [...additions, ...merged];
          }
        }

        await likedStore.replaceScTracks(merged);
        const baseCount = meta.count || fresh.length;
        await likedStore.setScVirtualCount(Math.max(0, baseCount + pendingDelta));
        finalMerged = merged;
      });

      // Обновляем in-memory set локальных ID
      await loadScLocalOnlyIds();
      this._isSyncing = false;
      this.mutatedDuringSync.clear();
      this.notify(finalMerged, false);
    } catch (e) {
      console.error('[sc-liked] sync failed', e);
      this._isSyncing = false;
      this.mutatedDuringSync.clear();
      this.notify(await likedStore.getAllScTracks(), false);
    }
  }

  // Оптимистичное обновление при лайке/анлайке в приложении.
  async addLocal(track: YTMTrack, localOnly = false) {
    if (!track.scId) return;
    const scId = track.scId;
    if (this._isSyncing) this.mutatedDuringSync.add(scId);
    return this.enqueueLocalOp(async () => {
      const existing = (await likedStore.getAllScTracks()).find(e => e.scId === scId);
      await tracksStore.upsertTrack(track);
      await likedStore.putScTrack({ scId, trackId: track.id, likedAt: Date.now(), localOnly });
      const c = await likedStore.getScVirtualCount();
      if (localOnly) {
        addScLocalOnlyId(scId);
      } else if (!existing || existing.localOnly) {
        await likedStore.setScVirtualCount(c + 1);
      }
      this.notify(await likedStore.getAllScTracks(), false);
    });
  }

  async removeLocal(scId: string) {
    if (this._isSyncing) this.mutatedDuringSync.add(scId);
    return this.enqueueLocalOp(async () => {
      const all = await likedStore.getAllScTracks();
      const entry = all.find(e => e.scId === scId);
      const wasLocalOnly = entry?.localOnly;

      await likedStore.deleteScTrack(scId);
      const c = await likedStore.getScVirtualCount();
      if (entry && !wasLocalOnly) {
        await likedStore.setScVirtualCount(Math.max(0, c - 1));
      }
      removeScLocalOnlyId(scId);
      this.notify(await likedStore.getAllScTracks(), false);
    });
  }
}

export const scLikedManager = new ScLikedManager();
