import { YTMTrack } from './yt';

export interface LikedEntry {
  videoId: string;
  track: YTMTrack;
  originalIndex: number;
  syncedAt: number;
  // Реальное время лайка (ms). Для YouTube известно только для лайков, поставленных
  // в этом приложении (API YТ не отдаёт дату лайка). Сохраняется между полными синками.
  likedAt?: number;
}

// SoundCloud-лайки храним в отдельной таблице, чтобы не конфликтовать с YouTube.
export interface ScLikedEntry {
  scId: string;
  track: YTMTrack;
  likedAt: number; // created_at лайка из api-v2 (ms) — всегда известно
  localOnly?: boolean; // true = лайкнут без авторизации SC
}

class LikedStore {
  private db: IDBDatabase | null = null;
  private readonly DB_NAME = 'goymusic-liked';
  private readonly VERSION = 2;
  private initPromise: Promise<void> | null = null;

  async init() {
    if (this.initPromise) return this.initPromise;
    this.initPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(this.DB_NAME, this.VERSION);
      request.onupgradeneeded = (e: any) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('tracks')) {
          const store = db.createObjectStore('tracks', { keyPath: 'videoId' });
          store.createIndex('originalIndex', 'originalIndex', { unique: false });
        }
        if (!db.objectStoreNames.contains('state')) db.createObjectStore('state');
        // v2: отдельная таблица SoundCloud-лайков, сортировка по времени лайка.
        if (!db.objectStoreNames.contains('sc_tracks')) {
          const sc = db.createObjectStore('sc_tracks', { keyPath: 'scId' });
          sc.createIndex('likedAt', 'likedAt', { unique: false });
        }
      };
      request.onsuccess = (e: any) => { this.db = e.target.result; resolve(); };
      request.onerror = (e) => { this.initPromise = null; reject(e); };
    });
    return this.initPromise;
  }

  // ─── state (virtual counts) ──────────────────────────────────────────────
  private async getState(key: string): Promise<number> {
    await this.init();
    if (!this.db) return 0;
    return new Promise((resolve) => {
      const tx = this.db!.transaction('state', 'readonly');
      const request = tx.objectStore('state').get(key);
      request.onsuccess = () => resolve(request.result || 0);
      request.onerror = () => resolve(0);
    });
  }

  private async setState(key: string, value: number): Promise<void> {
    await this.init();
    if (!this.db) return;
    return new Promise((resolve) => {
      const tx = this.db!.transaction('state', 'readwrite');
      tx.objectStore('state').put(value, key);
      tx.oncomplete = () => resolve();
    });
  }

  getVirtualCount() { return this.getState('virtualCount'); }
  setVirtualCount(count: number) { return this.setState('virtualCount', count); }
  getScVirtualCount() { return this.getState('scVirtualCount'); }
  setScVirtualCount(count: number) { return this.setState('scVirtualCount', count); }

  // ─── YouTube tracks ──────────────────────────────────────────────────────
  async getMinIndex(): Promise<number> {
    await this.init();
    return new Promise((resolve) => {
      const tx = this.db!.transaction('tracks', 'readonly');
      const store = tx.objectStore('tracks');
      const index = store.index('originalIndex');
      const request = index.openCursor(null, 'next'); // Lowest index
      request.onsuccess = (e: any) => {
        const cursor = e.target.result;
        resolve(cursor ? cursor.value.originalIndex : 0);
      };
      request.onerror = () => resolve(0);
    });
  }

  async getAllTracks(): Promise<LikedEntry[]> {
    await this.init();
    if (!this.db) return [];
    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction('tracks', 'readonly');
      const store = tx.objectStore('tracks');
      const index = store.index('originalIndex');
      const request = index.openCursor(null, 'next');
      const results: LikedEntry[] = [];
      request.onsuccess = (e: any) => {
        const cursor = e.target.result;
        if (cursor) { results.push(cursor.value); cursor.continue(); }
        else resolve(results);
      };
      request.onerror = () => reject(request.error);
    });
  }

  // Карта videoId → likedAt существующих записей (чтобы сохранить время лайка при полном синке).
  async getLikedAtMap(): Promise<Map<string, number>> {
    const entries = await this.getAllTracks();
    const map = new Map<string, number>();
    for (const e of entries) if (e.likedAt) map.set(e.videoId, e.likedAt);
    return map;
  }

  async putTrack(entry: LikedEntry) {
    await this.init();
    if (!this.db) return;
    return new Promise<void>((resolve, reject) => {
      const tx = this.db!.transaction('tracks', 'readwrite');
      tx.objectStore('tracks').put(entry);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async putTracksBatch(entries: LikedEntry[]) {
    await this.init();
    if (!this.db || entries.length === 0) return;
    return new Promise<void>((resolve, reject) => {
      const tx = this.db!.transaction('tracks', 'readwrite');
      const store = tx.objectStore('tracks');
      entries.forEach(entry => store.put(entry));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async deleteTrack(videoId: string) {
    await this.init();
    if (!this.db) return;
    const tx = this.db!.transaction('tracks', 'readwrite');
    tx.objectStore('tracks').delete(videoId);
  }

  async clearAllTracks() {
    await this.init();
    if (!this.db) return;
    const tx = this.db!.transaction('tracks', 'readwrite');
    tx.objectStore('tracks').clear();
  }

  // ─── SoundCloud tracks (отдельная таблица) ───────────────────────────────
  async getAllScTracks(): Promise<ScLikedEntry[]> {
    await this.init();
    if (!this.db) return [];
    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction('sc_tracks', 'readonly');
      const index = tx.objectStore('sc_tracks').index('likedAt');
      const request = index.openCursor(null, 'prev'); // newest-liked first
      const results: ScLikedEntry[] = [];
      request.onsuccess = (e: any) => {
        const cursor = e.target.result;
        if (cursor) { results.push(cursor.value); cursor.continue(); }
        else resolve(results);
      };
      request.onerror = () => reject(request.error);
    });
  }

  async putScTrack(entry: ScLikedEntry) {
    await this.init();
    if (!this.db) return;
    return new Promise<void>((resolve, reject) => {
      const tx = this.db!.transaction('sc_tracks', 'readwrite');
      tx.objectStore('sc_tracks').put(entry);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async putScTracksBatch(entries: ScLikedEntry[]) {
    await this.init();
    if (!this.db || entries.length === 0) return;
    return new Promise<void>((resolve, reject) => {
      const tx = this.db!.transaction('sc_tracks', 'readwrite');
      const store = tx.objectStore('sc_tracks');
      entries.forEach(entry => store.put(entry));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async deleteScTrack(scId: string) {
    await this.init();
    if (!this.db) return;
    const tx = this.db!.transaction('sc_tracks', 'readwrite');
    tx.objectStore('sc_tracks').delete(scId);
  }

  async clearScTracks() {
    await this.init();
    if (!this.db) return;
    const tx = this.db!.transaction('sc_tracks', 'readwrite');
    tx.objectStore('sc_tracks').clear();
  }
}

export const likedStore = new LikedStore();

export async function getScLocalOnlyCount(): Promise<number> {
  const all = await likedStore.getAllScTracks();
  return all.filter(e => e.localOnly).length;
}
