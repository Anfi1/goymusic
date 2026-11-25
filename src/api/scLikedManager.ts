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
    try {
      const local = await likedStore.getAllScTracks();
      // Фильтруем localOnly для head-match, иначе они будут вверху списка и head никогда не совпадет
      const localWithoutLocalOnly = local.filter(e => !e.localOnly);
      this.notify(local, true);

      const meta = await getScLikedMeta();
      if (!meta) { this._isSyncing = false; this.notify(local, false); return; }

      const localCount = await likedStore.getScVirtualCount();
      const headLen = Math.min(5, meta.headIds.length, localWithoutLocalOnly.length);
      const headMatch = headLen > 0 && meta.headIds.slice(0, headLen).every((id, i) => localWithoutLocalOnly[i]?.scId === id);

      // Счетчик совпал и "голова" списка та же -> зеркало актуально, без полной выгрузки (если нет pending-лайков).
      if (pendingChangesProvider().size === 0 && meta.count === localCount && headMatch && localWithoutLocalOnly.length > 0) {
        this._isSyncing = false;
        this.notify(local, false);
        return;
      }

      const fresh = await getScLikedEntries();
      let finalMerged: ScLikedEntry[] = [];

      await this.enqueueLocalOp(async () => {
        const currentLocal = await likedStore.getAllScTracks();
        const serverIds = new Set(fresh.map(e => e.scId));
        const localOnlyEntries = currentLocal.filter(e => e.localOnly && !serverIds.has(e.scId));

        for (const entry of fresh) {
          const existing = currentLocal.find(e => e.scId === entry.scId);
          if (existing?.localOnly) {
            entry.likedAt = entry.likedAt || existing.likedAt;
          }
        }

        let merged: ScLikedEntry[] = [...fresh, ...localOnlyEntries];
        const pending = pendingChangesProvider();
        let pendingDelta = 0;

        if (pending.size > 0) {
          const filtered: ScLikedEntry[] = [];
          for (const entry of merged) {
            const change = pending.get(entry.scId);
            if (change && !change.liked) {
              if (!entry.localOnly) pendingDelta -= 1;
              continue;
            }
            filtered.push(entry);
          }
          merged = filtered;

          const presentIds = new Set(merged.map(e => e.scId));
          const pendingAdditions: ScLikedEntry[] = [];
          for (const [scId, change] of pending) {
            if (change.liked && !presentIds.has(scId)) {
              await tracksStore.upsertTrack({ ...change.track, likeStatus: 'LIKE' });
              const existingLocal = currentLocal.find(e => e.scId === scId);
              pendingAdditions.push({
                scId,
                trackId: change.track.id,
                likedAt: existingLocal?.likedAt || Date.now(),
              });
              presentIds.add(scId);
              pendingDelta += 1;
            }
          }
          if (pendingAdditions.length > 0) {
            merged = [...pendingAdditions, ...merged];
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
      this.notify(finalMerged, false);
    } catch (e) {
      console.error('[sc-liked] sync failed', e);
      this._isSyncing = false;
      this.notify(await likedStore.getAllScTracks(), false);
    }
  }

  // Оптимистичное обновление при лайке/анлайке в приложении.
  async addLocal(track: YTMTrack, localOnly = false) {
    if (!track.scId) return;
    const scId = track.scId;
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
