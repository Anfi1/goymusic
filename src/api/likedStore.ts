import { YTMTrack } from './yt';

export interface LikedEntry {
  videoId: string;
  track: YTMTrack;
  originalIndex: number; 
  syncedAt: number;
}

class LikedStore {
  private db: IDBDatabase | null = null;
  private readonly DB_NAME = 'goymusic-liked';
  private readonly VERSION = 1;
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
      };
      request.onsuccess = (e: any) => { this.db = e.target.result; resolve(); };
      request.onerror = (e) => { this.initPromise = null; reject(e); };
    });
    return this.initPromise;
  }

  async getVirtualCount(): Promise<number> {
    await this.init();
    if (!this.db) return 0;
    return new Promise((resolve) => {
      const tx = this.db!.transaction('state', 'readonly');
      const request = tx.objectStore('state').get('virtualCount');
      request.onsuccess = () => resolve(request.result || 0);
      request.onerror = () => resolve(0);
    });
  }

  async setVirtualCount(count: number): Promise<void> {
    await this.init();
    if (!this.db) return;
    return new Promise((resolve) => {
      const tx = this.db!.transaction('state', 'readwrite');
      tx.objectStore('state').put(count, 'virtualCount');
      tx.oncomplete = () => resolve();
    });
  }

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
}

export const likedStore = new LikedStore();
