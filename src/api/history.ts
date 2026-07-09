import { YTMTrack } from './yt';

export interface HistoryEntry {
  timestamp: number;
  videoId: string;
  track: YTMTrack;
  listenedSeconds: number;
}

class HistoryStore {
  private db: IDBDatabase | null = null;
  private readonly DB_NAME = 'goymusic-history';
  private readonly STORE_NAME = 'tracks';
  private readonly VERSION = 1;

  async init() {
    if (this.db) return;
    return new Promise<void>((resolve, reject) => {
      const request = indexedDB.open(this.DB_NAME, this.VERSION);
      request.onupgradeneeded = (e: any) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(this.STORE_NAME)) {
          const store = db.createObjectStore(this.STORE_NAME, { keyPath: 'timestamp' });
          store.createIndex('videoId', 'videoId', { unique: false });
        }
      };
      request.onsuccess = (e: any) => {
        this.db = e.target.result;
        resolve();
      };
      request.onerror = () => reject(request.error);
    });
  }

  async addEntry(track: YTMTrack): Promise<number | null> {
    await this.init();
    if (!this.db) return null;

    const entry: HistoryEntry = {
      timestamp: Date.now(),
      videoId: track.id,
      track: JSON.parse(JSON.stringify(track)), // Deep copy
      listenedSeconds: 0
    };

    return new Promise<number | null>((resolve, reject) => {
      const tx = this.db!.transaction(this.STORE_NAME, 'readwrite');
      const store = tx.objectStore(this.STORE_NAME);

      // По умолчанию пишем новую запись; при дубле за 30с — переиспользуем её timestamp
      let resultTimestamp: number | null = entry.timestamp;

      const range = IDBKeyRange.lowerBound(Date.now() - 30000);
      const cursorReq = store.openCursor(range, 'prev');

      cursorReq.onsuccess = (e: any) => {
        const cursor = e.target.result;
        if (cursor && cursor.value.videoId === track.id) {
          resultTimestamp = cursor.value.timestamp; // переиспользуем существующую запись
          return; // дубликат не добавляем
        }
        store.add(entry);
      };

      tx.oncomplete = () => resolve(resultTimestamp);
      tx.onerror = () => reject(tx.error);
    });
  }

  async addListenedSeconds(timestamp: number, delta: number): Promise<void> {
    if (delta <= 0) return;
    await this.init();
    if (!this.db) return;

    return new Promise<void>((resolve, reject) => {
      const tx = this.db!.transaction(this.STORE_NAME, 'readwrite');
      const store = tx.objectStore(this.STORE_NAME);
      const getReq = store.get(timestamp);

      getReq.onsuccess = () => {
        const entry = getReq.result as HistoryEntry | undefined;
        if (!entry) { resolve(); return; }
        entry.listenedSeconds = (entry.listenedSeconds || 0) + delta;
        store.put(entry);
      };

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async getHistory(limit = Infinity): Promise<HistoryEntry[]> {
    await this.init();
    if (!this.db) return [];

    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(this.STORE_NAME, 'readonly');
      const store = tx.objectStore(this.STORE_NAME);
      const request = store.openCursor(null, 'prev'); // Newest first
      const results: HistoryEntry[] = [];

      request.onsuccess = (e: any) => {
        const cursor = e.target.result;
        if (cursor && results.length < limit) {
          results.push(cursor.value);
          cursor.continue();
        } else {
          resolve(results);
        }
      };
      request.onerror = () => reject(request.error);
    });
  }

  async clearAll() {
    await this.init();
    if (!this.db) return;
    const tx = this.db.transaction(this.STORE_NAME, 'readwrite');
    tx.objectStore(this.STORE_NAME).clear();
  }

  async deleteEntry(timestamp: number) {
    await this.init();
    if (!this.db) return;
    
    return new Promise<void>((resolve, reject) => {
      const tx = this.db!.transaction(this.STORE_NAME, 'readwrite');
      const store = tx.objectStore(this.STORE_NAME);
      const request = store.delete(timestamp);
      
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  async cleanup(interval: 'weekly' | 'monthly' | 'yearly' | 'none') {
    if (interval === 'none') return;
    await this.init();
    if (!this.db) return;

    const now = Date.now();
    let ms = 0;
    if (interval === 'weekly') ms = 7 * 24 * 60 * 60 * 1000;
    else if (interval === 'monthly') ms = 30 * 24 * 60 * 60 * 1000;
    else if (interval === 'yearly') ms = 365 * 24 * 60 * 60 * 1000;

    const limit = now - ms;
    const tx = this.db.transaction(this.STORE_NAME, 'readwrite');
    const store = tx.objectStore(this.STORE_NAME);
    const range = IDBKeyRange.upperBound(limit);
    
    return new Promise<void>((resolve, reject) => {
      const request = store.delete(range);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }
}

export const historyStore = new HistoryStore();
