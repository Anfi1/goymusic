import { YTMTrack } from './yt';
import { likedStore, ScLikedEntry } from './likedStore';
import { isScAuthed, getScLikedMeta, getScLikedEntries } from './soundcloud';

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
      await likedStore.clearScTracks();
      await likedStore.setScVirtualCount(0);
      this.notify([], false);
      return;
    }

    this._isSyncing = true;
    try {
      const local = await likedStore.getAllScTracks();
      this.notify(local, true);

      const meta = await getScLikedMeta();
      if (!meta) { this._isSyncing = false; this.notify(local, false); return; }

      const localCount = await likedStore.getScVirtualCount();
      const headLen = Math.min(5, meta.headIds.length, local.length);
      const headMatch = headLen > 0 && meta.headIds.slice(0, headLen).every((id, i) => local[i]?.scId === id);

      // Счётчик совпал и «голова» списка та же → зеркало актуально, без полной выгрузки.
      if (meta.count === localCount && headMatch && local.length > 0) {
        this._isSyncing = false;
        this.notify(local, false);
        return;
      }

      const fresh = await getScLikedEntries();
      await likedStore.clearScTracks();
      await likedStore.putScTracksBatch(fresh);
      await likedStore.setScVirtualCount(meta.count || fresh.length);
      this._isSyncing = false;
      this.notify(fresh, false);
    } catch (e) {
      console.error('[sc-liked] sync failed', e);
      this._isSyncing = false;
      this.notify(await likedStore.getAllScTracks(), false);
    }
  }

  // Оптимистичное обновление при успешном лайке/анлайке в приложении.
  async addLocal(track: YTMTrack) {
    if (!track.scId) return;
    await likedStore.putScTrack({ scId: track.scId, track, likedAt: Date.now() });
    const c = await likedStore.getScVirtualCount();
    await likedStore.setScVirtualCount(c + 1);
    this.notify(await likedStore.getAllScTracks(), false);
  }

  async removeLocal(scId: string) {
    await likedStore.deleteScTrack(scId);
    const c = await likedStore.getScVirtualCount();
    await likedStore.setScVirtualCount(Math.max(0, c - 1));
    this.notify(await likedStore.getAllScTracks(), false);
  }
}

export const scLikedManager = new ScLikedManager();
