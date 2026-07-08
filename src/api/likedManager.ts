import { getContinuation, rateSong, YTMTrack, getPlaylistTracks } from './yt';
import { isScAuthed, scSetLiked } from './soundcloud';
import { likedStore, LikedEntry } from './likedStore';
import { scLikedManager } from './scLikedManager';

class LikedManager {
  private _isSyncing = false;
  private _isEnabled = true;
  private listeners: ((tracks: LikedEntry[], isSyncing: boolean) => void)[] = [];

  constructor() {
    this._isEnabled = localStorage.getItem('liked-mirror-enabled') !== 'false';
    if (typeof window !== 'undefined') {
      (window as any).likedSync = () => this.sync();
    }
  }

  get isSyncing() { return this._isSyncing; }
  get isEnabled() { return this._isEnabled; }

  toggleEnabled(value: boolean) {
    this._isEnabled = value;
    localStorage.setItem('liked-mirror-enabled', value.toString());
    if (value) {
      this.sync();
    }
  }

  subscribe(listener: (tracks: LikedEntry[], isSyncing: boolean) => void) {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter(l => l !== listener);
    };
  }

  private async notify() {
    const tracks = await likedStore.getAllTracks();
    this.listeners.forEach(l => l(tracks, this._isSyncing));
  }

  async sync() {
    if (this._isSyncing || !this._isEnabled) return;
    this._isSyncing = true;
    
    await this.notify();
    console.log('%c[liked] 🔄 Проверка обновлений...', 'color: #89b4fa; font-weight: bold;');

    try {
      const firstPage = await getPlaylistTracks('LM', 100);
      if (!firstPage || !firstPage.tracks) {
        this._isSyncing = false;
        return;
      }

      const ytTotal = firstPage.trackCount || firstPage.tracks.length;
      const currentLocal = await likedStore.getAllTracks();
      const localVirtual = await likedStore.getVirtualCount();
      
      const headCount = Math.min(10, firstPage.tracks.length, currentLocal.length);
      let headMismatch = currentLocal.length === 0;
      for (let i = 0; i < headCount; i++) {
        if (currentLocal[i].videoId !== firstPage.tracks[i].id) {
          headMismatch = true;
          break;
        }
      }

      // Сверка 2: Виртуальный счетчик из блокнота
      const countMismatch = ytTotal !== localVirtual;

      if (!headMismatch && !countMismatch && currentLocal.length > 0) {
        console.log('%c[liked] ✅ Зеркало актуально.', 'color: #a6e3a1;');
        this._isSyncing = false;
        await this.notify();
        return;
      }

      console.log(`[liked] 📥 Загрузка... Причина: ${headMismatch ? 'head ' : ''}${countMismatch ? 'count(' + localVirtual + ' vs ' + ytTotal + ')' : ''}`);

      await likedStore.setVirtualCount(ytTotal);

      let allTracks: YTMTrack[] = [...firstPage.tracks];
      let continuation = firstPage.continuation;

      while (continuation) {
        try {
          const next = await getContinuation(continuation);
          if (!next.tracks || next.tracks.length === 0) break;

          allTracks.push(...next.tracks);
          continuation = next.continuation;

          // Живое обновление: отдаём накопленный список после каждой страницы (~100),
          // чтобы лайки появлялись по мере загрузки, а не только в самом конце.
          const entries = allTracks.map((t, i) => ({ videoId: t.id, track: t, originalIndex: i, syncedAt: 0 }));
          this.listeners.forEach(l => l(entries as any, true));
          if (allTracks.length % 500 === 0) console.log(`[liked] Получено ${allTracks.length}...`);
        } catch (e) {
          console.error('[liked] Ошибка пагинации:', e);
          break;
        }
        if (allTracks.length > 100000) break;
      }

      // Сохраняем реальное время лайка (известно только для лайков из приложения) между синками.
      const likedAtMap = await likedStore.getLikedAtMap();
      const now = Date.now();
      const finalEntries: LikedEntry[] = allTracks.map((t, i) => ({
        videoId: t.id,
        track: t,
        originalIndex: i,
        syncedAt: now,
        likedAt: likedAtMap.get(t.id)
      }));

      await likedStore.clearAllTracks();
      await likedStore.putTracksBatch(finalEntries);
      
      console.log(`%c[liked] ✅ Синхронизация завершена. Всего: ${finalEntries.length}`, 'color: #a6e3a1; font-weight: bold;');
      this._isSyncing = false;
      await this.notify();
    } catch (e) {
      console.error('[liked] Сбой:', e);
      this._isSyncing = false;
      await this.notify();
    }
  }

  async toggleDislike(track: YTMTrack, currentStatus: string) {
    const id = track.id;
    const newStatus = currentStatus === 'DISLIKE' ? 'INDIFFERENT' : 'DISLIKE';

    window.dispatchEvent(new CustomEvent('track-like-start', { detail: { id } }));

    // У SoundCloud нет дизлайка — действие недоступно (сбрасываем кнопку).
    if (track.source === 'soundcloud') {
      window.dispatchEvent(new CustomEvent('track-like-updated', { detail: { id, status: 'error' } }));
      return false;
    }

    const success = await rateSong(id, newStatus as any);

    if (success) {
      // Если трек был лайкнут — убираем из локального стора лайков
      if (this._isEnabled && currentStatus === 'LIKE') {
        const virtualCount = await likedStore.getVirtualCount();
        await likedStore.deleteTrack(id);
        await likedStore.setVirtualCount(Math.max(0, virtualCount - 1));
      }

      window.dispatchEvent(new CustomEvent('track-like-updated', {
        detail: { id, status: 'success', likeStatus: newStatus }
      }));

      await this.notify();
      if (this._isEnabled && currentStatus === 'LIKE') {
        setTimeout(() => this.sync(), 5000);
      }
      return true;
    } else {
      window.dispatchEvent(new CustomEvent('track-like-updated', { detail: { id, status: 'error' } }));
      return false;
    }
  }

  async toggleLike(track: YTMTrack, currentStatus: string) {
    const id = track.id;
    const newStatus = currentStatus === 'LIKE' ? 'INDIFFERENT' : 'LIKE';
    
    // Глобальное событие начала
    window.dispatchEvent(new CustomEvent('track-like-start', { detail: { id } }));

    // SoundCloud-трек: лайк уходит на SoundCloud (нужен oauth_token), не в YT-библиотеку.
    if (track.source === 'soundcloud') {
      if (isScAuthed()) {
        const ok = await scSetLiked(track.scId, track.scUrl || track.id, newStatus === 'LIKE');
        if (ok) {
          if (newStatus === 'LIKE') scLikedManager.addLocal({ ...track, likeStatus: 'LIKE' });
          else if (track.scId) scLikedManager.removeLocal(track.scId);
          window.dispatchEvent(new CustomEvent('track-like-updated', { detail: { id, status: 'success', likeStatus: newStatus } }));
          return true;
        }
        window.dispatchEvent(new CustomEvent('track-like-updated', { detail: { id, status: 'error' } }));
        return false;
      }

      // Не авторизован — сохраняем локально с флагом localOnly
      if (newStatus === 'LIKE') scLikedManager.addLocal({ ...track, likeStatus: 'LIKE' }, true);
      else if (track.scId) scLikedManager.removeLocal(track.scId);
      window.dispatchEvent(new CustomEvent('track-like-updated', { detail: { id, status: 'success', likeStatus: newStatus } }));
      window.dispatchEvent(new CustomEvent('app-toast', {
        detail: {
          message: newStatus === 'LIKE'
            ? 'Лайк сохранён локально. Войдите в SoundCloud, чтобы синхронизировать'
            : 'Лайк убран локально',
          type: 'info',
        },
      }));
      return true;
    }

    const success = await rateSong(id, newStatus as any);

    if (success) {
      if (this._isEnabled) {
        const virtualCount = await likedStore.getVirtualCount();
        if (newStatus === 'LIKE') {
          const minIdx = await likedStore.getMinIndex();
          await likedStore.putTrack({
            videoId: id,
            track: { ...track, likeStatus: 'LIKE' },
            originalIndex: minIdx - 1,
            syncedAt: Date.now(),
            likedAt: Date.now()
          });
          // Если у трека нет длительности — не обновляем счётчик.
          // Sync увидит расхождение с YouTube и сделает полный рефетч с правильными данными.
          if (track.duration) {
            await likedStore.setVirtualCount(virtualCount + 1);
          }
        } else {
          await likedStore.deleteTrack(id);
          await likedStore.setVirtualCount(Math.max(0, virtualCount - 1));
        }
      }
      
      // Глобальное событие успеха (для Row и QueueItem)
      window.dispatchEvent(new CustomEvent('track-like-updated', { 
        detail: { id, status: 'success', likeStatus: newStatus } 
      }));

      await this.notify();
      if (this._isEnabled) {
        setTimeout(() => this.sync(), 5000);
      }
      return true;
    } else {
      window.dispatchEvent(new CustomEvent('track-like-updated', { detail: { id, status: 'error' } }));
      return false;
    }
  }
}

export const likedManager = new LikedManager();
