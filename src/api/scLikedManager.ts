import { YTMTrack } from './yt';
import { likedStore, ScLikedEntry } from './likedStore';
import { isScAuthed, getScLikedMeta, getScLikedEntries, addScLocalOnlyId, removeScLocalOnlyId, loadScLocalOnlyIds } from './soundcloud';

// Менеджер локального зеркала SoundCloud-лайков. Аналог likedManager, но для SC:
// дешёвая сверка (likes_count + первые id) → полный рефетч только при расхождении.
class ScLikedManager {
  private _isSyncing = false;
  private listeners: ((entries: ScLikedEntry[], syncing: boolean) => void)[] = [];

  get isSyncing() { return this._isSyncing; }

  subscribe(listener: (entries: ScLikedEntry[], syncing: boolean) => void) {
    this.listeners.push(listener);
    return () => { this.listeners = this.listeners.filter(l => l !== listener); };
  }

  private notify(entries: ScLikedEntry[], syncing: boolean) {
    this.listeners.forEach(l => l(entries, syncing));
  }

  async sync() {
    if (this._isSyncing) return;

    if (!isScAuthed()) {
      // Не чистим — localOnly-записи должны сохраниться
      const local = await likedStore.getAllScTracks();
      this.notify(local, false);
      return;
    }

    this._isSyncing = true;
    try {
      const local = await likedStore.getAllScTracks();
      // Фильтруем localOnly для head-match — иначе они будут вверху списка и head никогда не совпадёт
      const localWithoutLocalOnly = local.filter(e => !e.localOnly);
      this.notify(local, true);

      const meta = await getScLikedMeta();
      if (!meta) { this._isSyncing = false; this.notify(local, false); return; }

      const localCount = await likedStore.getScVirtualCount();
      const headLen = Math.min(5, meta.headIds.length, localWithoutLocalOnly.length);
      const headMatch = headLen > 0 && meta.headIds.slice(0, headLen).every((id, i) => localWithoutLocalOnly[i]?.scId === id);

      // Счётчик совпал и «голова» списка та же → зеркало актуально, без полной выгрузки.
      if (meta.count === localCount && headMatch && localWithoutLocalOnly.length > 0) {
        this._isSyncing = false;
        this.notify(local, false);
        return;
      }

      const fresh = await getScLikedEntries();

      // Merge: сохраняем localOnly-записи, которых нет на сервере
      const serverIds = new Set(fresh.map(e => e.scId));
      const localOnlyEntries = local.filter(e => e.localOnly && !serverIds.has(e.scId));

      // Если localOnly-трек уже есть на сервере — снимаем флаг
      for (const entry of fresh) {
        const existing = local.find(e => e.scId === entry.scId);
        if (existing?.localOnly) {
          // Оставляем likedAt от сервера (более точный)
          entry.likedAt = entry.likedAt || existing.likedAt;
        }
      }

      const merged = [...fresh, ...localOnlyEntries];
      await likedStore.replaceScTracks(merged);
      await likedStore.setScVirtualCount(meta.count || fresh.length);

      // Обновляем in-memory set локальных ID
      await loadScLocalOnlyIds();
      this._isSyncing = false;
      this.notify(merged, false);
    } catch (e) {
      console.error('[sc-liked] sync failed', e);
      this._isSyncing = false;
      this.notify(await likedStore.getAllScTracks(), false);
    }
  }

  // Оптимистичное обновление при успешном лайке/анлайке в приложении.
  async addLocal(track: YTMTrack, localOnly = false) {
    if (!track.scId) return;
    await likedStore.putScTrack({ scId: track.scId, track, likedAt: Date.now(), localOnly });
    const c = await likedStore.getScVirtualCount();
    if (localOnly) {
      addScLocalOnlyId(track.scId);
    } else {
      await likedStore.setScVirtualCount(c + 1);
    }
    this.notify(await likedStore.getAllScTracks(), false);
  }

  async removeLocal(scId: string) {
    const all = await likedStore.getAllScTracks();
    const entry = all.find(e => e.scId === scId);
    const wasLocalOnly = entry?.localOnly;

    await likedStore.deleteScTrack(scId);
    const c = await likedStore.getScVirtualCount();
    if (!wasLocalOnly) {
      await likedStore.setScVirtualCount(Math.max(0, c - 1));
    }
    removeScLocalOnlyId(scId);
    this.notify(await likedStore.getAllScTracks(), false);
  }
}

export const scLikedManager = new ScLikedManager();
