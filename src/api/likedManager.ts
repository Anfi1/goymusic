import { getContinuation, rateSong, YTMTrack, getPlaylistTracks } from './yt';
import { isScAuthed, scSetLiked } from './soundcloud';
import { yandexSetLiked } from './yandex';
import { likedStore, LikedEntry, YtImportState, YT_IMPORT_VERSION } from './likedStore';
import { tracksStore } from './tracks';
import { scLikedManager } from './scLikedManager';

export type LikedSyncProgress =
  | { phase: 'idle' | 'checking' | 'saving' | 'failed' }
  | { phase: 'importing'; processed: number; total: number | null };

export function likedSyncLabel(progress: LikedSyncProgress): string | null {
  switch (progress.phase) {
    case 'idle': return null;
    case 'checking': return 'Checking YouTube likes…';
    case 'importing': return progress.total !== null && progress.total >= progress.processed
      ? `Syncing YouTube likes: ${progress.processed} of ${progress.total}`
      : `Syncing YouTube likes: ${progress.processed} processed`;
    case 'saving': return 'Saving YouTube likes…';
    case 'failed': return 'YouTube likes sync failed';
  }
}

class LikedManager {
  private _isSyncing = false;
  private _isEnabled = true;
  private ytRevision = 0;
  private syncTimer?: number;
  private progress: LikedSyncProgress = { phase: 'idle' };
  private progressListeners = new Set<() => void>();
  private listeners: ((tracks: LikedEntry[]) => void)[] = [];

  constructor() {
    this._isEnabled = localStorage.getItem('liked-mirror-enabled') !== 'false';
    if (typeof window !== 'undefined') {
      (window as any).likedSync = () => this.sync();
    }
  }

  getProgress = () => this.progress;
  subscribeProgress = (listener: () => void) => {
    this.progressListeners.add(listener);
    return () => { this.progressListeners.delete(listener); };
  };

  private setProgress(progress: LikedSyncProgress) {
    this.progress = progress;
    this.progressListeners.forEach(listener => listener());
  }
  get isEnabled() { return this._isEnabled; }

  toggleEnabled(value: boolean) {
    this._isEnabled = value;
    localStorage.setItem('liked-mirror-enabled', value.toString());
    if (value) {
      this.sync();
    } else {
      this.ytRevision++;
      clearTimeout(this.syncTimer);
      this.setProgress({ phase: 'idle' });
    }
  }

  subscribe(listener: (tracks: LikedEntry[]) => void) {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter(l => l !== listener);
    };
  }

  private async notify(tracks?: LikedEntry[]) {
    const visibleTracks = tracks ? [...tracks] : await likedStore.getAllTracks();
    this.listeners.forEach(l => l(visibleTracks));
  }

  private scheduleSync() {
    clearTimeout(this.syncTimer);
    this.syncTimer = window.setTimeout(() => this.sync(), 5000);
  }

  async sync() {
    if (this._isSyncing || !this._isEnabled) return;
    this._isSyncing = true;
    const revision = this.ytRevision;
    this.setProgress({ phase: 'checking' });
    let failed = false;

    let importState: YtImportState | null = null;
    try {
      const currentLocal = await likedStore.getAllTracks();
      const completedVersion = await likedStore.getYtImportCompletedVersion();
      await this.notify(currentLocal);
      const firstPage = await getPlaylistTracks('LM');
      if (revision !== this.ytRevision) return;
      const ytTotal = firstPage.reportedTrackCount ?? null;
      if (!firstPage.tracks.length && !firstPage.unavailableCount && ytTotal !== 0) {
        throw new Error('Liked Songs response has no rows or confirmed empty count');
      }
      const headIds = firstPage.tracks.slice(0, 10).map(track => track.id);
      const savedImport = await likedStore.getYtImportState();
      if (!savedImport && ytTotal !== null && currentLocal.length === ytTotal &&
          (!firstPage.continuation || currentLocal.length > firstPage.tracks.length) &&
          headIds.every((id, i) => currentLocal[i]?.trackId === id) &&
          await likedStore.getVirtualCount() === ytTotal &&
          completedVersion === YT_IMPORT_VERSION) return;

      const canResume = savedImport?.version === YT_IMPORT_VERSION &&
        savedImport.status === 'importing' && savedImport.continuation !== null &&
        savedImport.ytTotal === ytTotal && savedImport.headIds.length === headIds.length &&
        savedImport.headIds.every((id, i) => id === headIds[i]);
      if (savedImport && !canResume) await likedStore.clearYtImport();

      const entries = canResume ? await likedStore.getYtImportTracks() : [];
      const knownIds = new Set(entries.map(entry => entry.trackId));
      const requestedTokens = new Set<string>();
      const now = Date.now();
      importState = canResume ? savedImport : {
        version: YT_IMPORT_VERSION, status: 'importing', ytTotal, unavailableCount: 0,
        downloadedCount: 0, continuation: null, headIds, startedAt: now, updatedAt: now,
      };

      const publishCheckpoint = (state: YtImportState) => {
        if (revision !== this.ytRevision) return;
        this.setProgress({
          phase: 'importing', processed: state.downloadedCount + state.unavailableCount, total: ytTotal,
        });
      };
      if (canResume) {
        publishCheckpoint(importState);
        if (!currentLocal.length && revision === this.ytRevision) await this.notify(entries);
      }
      const addPage = async (page: { tracks: YTMTrack[], continuation?: string | null, unavailableCount: number }, previous: YtImportState) => {
        const newTracks = page.tracks.filter(track => {
          if (!track.id) throw new Error('Invalid Liked Songs row');
          if (knownIds.has(track.id)) return false;
          knownIds.add(track.id);
          return true;
        });
        const pageEntries = newTracks.map((track, i) => ({
          trackId: track.id, originalIndex: entries.length + i, syncedAt: 0,
        }));
        // Hydration reads a separate DB: persist metadata before publishing any references.
        await tracksStore.upsertTracksBatch(newTracks);
        const nextState: YtImportState = {
          ...previous, downloadedCount: entries.length + pageEntries.length,
          unavailableCount: previous.unavailableCount + page.unavailableCount,
          continuation: page.continuation || null, updatedAt: Date.now(),
        };
        await likedStore.saveYtImportPage(pageEntries, nextState);
        entries.push(...pageEntries);
        publishCheckpoint(nextState);
        if (!currentLocal.length && revision === this.ytRevision) await this.notify(entries);
        return nextState;
      };

      if (!canResume) importState = await addPage(firstPage, importState);
      while (revision === this.ytRevision && importState.continuation) {
        const token: string = importState.continuation;
        if (requestedTokens.has(token)) throw new Error('Repeated Liked Songs continuation');
        requestedTokens.add(token);
        const next = await getContinuation(token, true);
        if (revision !== this.ytRevision) return;
        importState = await addPage(next, importState);
      }
      if (revision !== this.ytRevision) return;
      if ((ytTotal !== null && entries.length + importState.unavailableCount < ytTotal) ||
          (ytTotal === null && entries.length < currentLocal.length)) {
        throw new Error('Incomplete Liked Songs response');
      }

      // YouTube не отдаёт дату лайка, а у SC она есть всегда. Без даты лайк с телефона
      // уезжал в конец вкладки под все SC-треки, поэтому новому лайку ставим время,
      // когда синк его впервые увидел. При первом импорте новыми были бы все -- там не ставим.
      const likedAtMap = new Map(currentLocal.map(entry => [entry.trackId, entry.likedAt]));
      const syncedAt = Date.now();
      const finalEntries: LikedEntry[] = entries.map((entry, index) => ({
        ...entry,
        originalIndex: index,
        syncedAt,
        likedAt: likedAtMap.get(entry.trackId) ?? (completedVersion === YT_IMPORT_VERSION && !likedAtMap.has(entry.trackId) ? syncedAt : undefined),
      }));
      this.setProgress({ phase: 'saving' });
      await likedStore.commitYtImport(finalEntries, ytTotal ?? entries.length + importState.unavailableCount);
    } catch (error) {
      failed = true;
      console.error('[liked] sync failed:', error);
      if (importState) {
        try {
          await likedStore.setYtImportState({ ...importState, status: 'failed', updatedAt: Date.now() });
        } catch (stateError) {
          console.error('[liked] failed to save import checkpoint:', stateError);
        }
      }
    } finally {
      try {
        if (revision !== this.ytRevision) {
          // A successful rating changed LM while this cursor still described the old list.
          if (this._isEnabled) this.scheduleSync();
          await likedStore.clearYtImport();
        }
      } finally {
        try {
          await this.notify();
        } catch (error) {
          failed = true;
          console.error('[liked] failed to read committed mirror:', error);
        } finally {
          this._isSyncing = false;
          this.setProgress({ phase: failed && revision === this.ytRevision ? 'failed' : 'idle' });
        }
      }
    }
  }

  async toggleDislike(track: YTMTrack, currentStatus: string) {
    const id = track.id;
    const newStatus = currentStatus === 'DISLIKE' ? 'INDIFFERENT' : 'DISLIKE';

    window.dispatchEvent(new CustomEvent('track-like-start', { detail: { id } }));

    // У SoundCloud и Yandex Music нет дизлайка — действие недоступно (сбрасываем кнопку).
    if (track.source === 'soundcloud' || track.source === 'yandex') {
      window.dispatchEvent(new CustomEvent('track-like-updated', { detail: { id, status: 'error' } }));
      return false;
    }

    const success = await rateSong(id, newStatus as any);

    if (success) {
      this.ytRevision++;
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
        this.scheduleSync();
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

    // Yandex-трек: лайк уходит в Yandex Music (токен уже на бэкенде, sync всегда серверный).
    if (track.source === 'yandex') {
      const ok = await yandexSetLiked(track.yandexId, newStatus === 'LIKE');
      if (ok) {
        if (newStatus === 'LIKE') {
          // Сам трек тоже кладём в стор: запись лайка ссылается на него по trackId, и без
          // этого hydrateYandexTracks отфильтрует свежий лайк на следующем открытии вкладки.
          await tracksStore.upsertTrack({ ...track, likeStatus: 'LIKE' });
          await likedStore.putYandexTrack({ yandexId: track.yandexId!, trackId: track.id, likedAt: Date.now() });
        } else if (track.yandexId) {
          await likedStore.deleteYandexTrack(track.yandexId);
        }
        window.dispatchEvent(new CustomEvent('track-like-updated', { detail: { id, status: 'success', likeStatus: newStatus } }));
        return true;
      }
      window.dispatchEvent(new CustomEvent('track-like-updated', { detail: { id, status: 'error' } }));
      return false;
    }

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
      this.ytRevision++;
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
        this.scheduleSync();
      }
      return true;
    } else {
      window.dispatchEvent(new CustomEvent('track-like-updated', { detail: { id, status: 'error' } }));
      return false;
    }
  }
}

export const likedManager = new LikedManager();
