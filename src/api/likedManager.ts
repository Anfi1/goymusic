import { getContinuation, rateSong, YTMTrack, getPlaylistTracks } from './yt';
import { isScAuthed, scSetLiked } from './soundcloud';
import { likedStore, LikedEntry, YtImportState } from './likedStore';
import { tracksStore } from './tracks';
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

  private async notify(tracks?: LikedEntry[]) {
    const visibleTracks = tracks ? [...tracks] : await likedStore.getAllTracks();
    this.listeners.forEach(l => l(visibleTracks, this._isSyncing));
  }

  async sync() {
    if (this._isSyncing || !this._isEnabled) return;
    this._isSyncing = true;
    await this.notify();

    let importState: YtImportState | null = null;
    try {
      const firstPage = await getPlaylistTracks('LM', 100);
      if (!firstPage || !Array.isArray(firstPage.tracks)) throw new Error('Liked Songs unavailable');

      const ytTotal = firstPage.trackCount || firstPage.tracks.length;
      const currentLocal = await likedStore.getAllTracks();
      const localVirtual = await likedStore.getVirtualCount();
      const completedImportVersion = await likedStore.getYtImportCompletedVersion();
      const headCount = Math.min(10, firstPage.tracks.length, currentLocal.length);
      let headMismatch = currentLocal.length === 0;
      for (let i = 0; i < headCount; i++) {
        if (currentLocal[i].trackId !== firstPage.tracks[i].id) {
          headMismatch = true;
          break;
        }
      }


      const savedImport = await likedStore.getYtImportState();
      const headIds = firstPage.tracks.slice(0, 10).map(track => track.id);
      const canResume = !!savedImport &&
        savedImport.version === 1 &&
        savedImport.ytTotal === ytTotal &&
        savedImport.continuation !== null &&
        savedImport.headIds.length === headIds.length &&
        savedImport.headIds.every((id, index) => id === headIds[index]);

      if (!savedImport && completedImportVersion === 1 && !headMismatch && ytTotal === localVirtual && currentLocal.length > 0) {
        this._isSyncing = false;
        await this.notify();
        return;
      }

      if (savedImport && !canResume) await likedStore.clearYtImport();

      const likedAtMap = await likedStore.getLikedAtMap();
      let entries: LikedEntry[];
      let continuation: string | null | undefined;
      if (canResume) {
        entries = await likedStore.getYtImportTracks();
        continuation = savedImport!.continuation;
        importState = savedImport!;
      } else {
        const seen = new Set<string>();
        const initialEntries = firstPage.tracks.flatMap((track) => {
          if (!track.id || seen.has(track.id)) return [];
          seen.add(track.id);
          tracksStore.upsertTrack(track);
          return [{ trackId: track.id, originalIndex: seen.size - 1, syncedAt: 0 }];
        });
        const initialContinuation = firstPage.continuation || null;
        const now = Date.now();
        const initialImportState: YtImportState = {
          version: 1,
          status: 'importing',
          ytTotal,
          scTotal: await likedStore.getScVirtualCount(),
          downloadedCount: initialEntries.length,
          continuation: initialContinuation,
          headIds,
          startedAt: now,
          updatedAt: now,
        };
        await likedStore.saveYtImportPage(initialEntries, initialImportState);
        entries = initialEntries;
        continuation = initialContinuation;
        importState = initialImportState;
      }

      await this.notify(entries);

      while (continuation) {
        const requestedContinuation: string = continuation;
        const next = await getContinuation(requestedContinuation);
        if (!Array.isArray(next.tracks) || next.tracks.length === 0) {
          throw new Error('Liked Songs continuation returned no tracks');
        }

        const knownIds = new Set(entries.map(entry => entry.trackId));
        const pageEntries: LikedEntry[] = [];
        for (const track of next.tracks) {
          if (!track.id || knownIds.has(track.id)) continue;
          knownIds.add(track.id);
          tracksStore.upsertTrack(track);
          pageEntries.push({ trackId: track.id, originalIndex: entries.length + pageEntries.length, syncedAt: 0 });
        }
        const nextContinuation = next.continuation || null;
        const nextCount = entries.length + pageEntries.length;
        if (nextContinuation === requestedContinuation || nextCount > 100000) {
          throw new Error('Liked Songs continuation did not advance');
        }

        const nextImportState: YtImportState = {
          ...importState!,
          status: 'importing',
          continuation: nextContinuation,
          downloadedCount: nextCount,
          updatedAt: Date.now(),
        };
        await likedStore.saveYtImportPage(pageEntries, nextImportState);
        entries.push(...pageEntries);
        continuation = nextContinuation;
        importState = nextImportState;
        await this.notify(entries);
      }

      const now = Date.now();
      const finalEntries: LikedEntry[] = entries.map((entry, index) => ({
        ...entry,
        originalIndex: index,
        syncedAt: now,
        likedAt: likedAtMap.get(entry.trackId),
      }));
      await likedStore.commitYtImport(finalEntries, ytTotal);
    } catch (error) {
      console.error('[liked] sync failed:', error);
      if (importState) {
        try {
          await likedStore.setYtImportState({ ...importState, status: 'failed', updatedAt: Date.now() });
        } catch (stateError) {
          console.error('[liked] failed to save import checkpoint:', stateError);
        }
      }
    } finally {
      this._isSyncing = false;
      await this.notify();
    }
  }

  private async legacySync() {
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
        if (currentLocal[i].trackId !== firstPage.tracks[i].id) {
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
          const entries = allTracks.map((t, i) => ({ trackId: t.id, originalIndex: i, syncedAt: 0 }));
          tracksStore.upsertTracksBatch(allTracks);
          this.listeners.forEach(l => l(entries as any, true));
          if (allTracks.length % 500 === 0) console.log(`[liked] Получено ${allTracks.length}...`);
        } catch (e) {
          console.error('[liked] Ошибка пагинации:', e);
          throw e;
        }
        if (allTracks.length > 100000) break;
      }

      // Сохраняем реальное время лайка (известно только для лайков из приложения) между синками.
      const likedAtMap = await likedStore.getLikedAtMap();
      const now = Date.now();
      const finalEntries: LikedEntry[] = allTracks.map((t, i) => ({
        trackId: t.id,
        originalIndex: i,
        syncedAt: now,
        likedAt: likedAtMap.get(t.id)
      }));

      await likedStore.replaceAllTracks(finalEntries);
      await likedStore.setVirtualCount(ytTotal);
      
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
          await tracksStore.upsertTrack({ ...track, likeStatus: 'LIKE' });
          await likedStore.putTrack({
            trackId: id,
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
