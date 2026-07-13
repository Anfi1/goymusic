import { YTMTrack } from './yt';
import { tracksStore } from './tracks';

export interface HistoryEntry {
  timestamp: number;
  trackId: string;
  listenedSeconds: number;
}

export interface HydratedHistoryEntry extends HistoryEntry {
  track: YTMTrack;
}

class HistoryStore {
  private db: IDBDatabase | null = null;
  private readonly DB_NAME = 'goymusic-history';
  private readonly STORE_NAME = 'plays';
  private readonly VERSION = 3;
  private initPromise: Promise<void> | null = null;

  async init() {
    if (this.initPromise) return this.initPromise;
    this.initPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(this.DB_NAME, this.VERSION);
      request.onupgradeneeded = (e: any) => {
        const db = e.target.result;
        const oldVersion = e.oldVersion;

        if (oldVersion < 2 && db.objectStoreNames.contains('tracks')) {
          // v0/v1: migrate old 'tracks' store (with full `track` object) → 'plays' with trackId
          const oldStore = e.target.transaction.objectStore('tracks');
          const migrated: any[] = [];
          const cursorReq = oldStore.openCursor();
          cursorReq.onsuccess = (ev: any) => {
            const cursor = ev.target.result;
            if (cursor) {
              const old = cursor.value;
              migrated.push({
                timestamp: old.timestamp,
                trackId: old.track?.id || old.videoId,
                listenedSeconds: old.listenedSeconds || 0,
              });
              if (old.track) tracksStore.upsertTrack(old.track);
              cursor.continue();
            } else {
              db.deleteObjectStore('tracks');
              for (const entry of migrated) {
                db.createObjectStore('plays', { keyPath: 'timestamp' })
                  .put(entry);
              }
            }
          };
        }

        if (oldVersion < 3) {
          // Recreate 'plays' store: drop videoId, keep trackId only
          if (db.objectStoreNames.contains('plays')) {
            // Read all existing data from v2 store
            const oldStore = e.target.transaction.objectStore('plays');
            const migrated: any[] = [];
            const cursorReq = oldStore.openCursor();
            cursorReq.onsuccess = (ev: any) => {
              const cursor = ev.target.result;
              if (cursor) {
                const old = cursor.value;
                migrated.push({
                  timestamp: old.timestamp,
                  trackId: old.trackId || old.videoId,
                  listenedSeconds: old.listenedSeconds || 0,
                });
                cursor.continue();
              } else {
                db.deleteObjectStore('plays');
                const store = db.createObjectStore('plays', { keyPath: 'timestamp' });
                store.createIndex('trackId', 'trackId', { unique: false });
                for (const entry of migrated) {
                  store.put(entry);
                }
              }
            };
          } else {
            // Fresh install: create 'plays' store
            const store = db.createObjectStore('plays', { keyPath: 'timestamp' });
            store.createIndex('trackId', 'trackId', { unique: false });
          }
        }
      };
      request.onsuccess = (e: any) => {
        this.db = e.target.result;
        resolve();
      };
      request.onerror = () => { this.initPromise = null; reject(request.error); };
    });
    return this.initPromise;
  }

  async addEntry(trackId: string): Promise<number | null> {
    await this.init();
    if (!this.db) return null;

    const timestamp = Date.now();
    const entry = { timestamp, trackId, listenedSeconds: 0 };

    return new Promise<number | null>((resolve, reject) => {
      const tx = this.db!.transaction(this.STORE_NAME, 'readwrite');
      const store = tx.objectStore(this.STORE_NAME);

      let resultTimestamp: number | null = entry.timestamp;

      const range = IDBKeyRange.lowerBound(Date.now() - 30000);
      const cursorReq = store.openCursor(range, 'prev');

      cursorReq.onsuccess = (e: any) => {
        const cursor = e.target.result;
        if (cursor && cursor.value.trackId === trackId) {
          resultTimestamp = cursor.value.timestamp;
          return;
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
      const request = store.openCursor(null, 'prev');
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

  async hydrateTracks(entries: HistoryEntry[]): Promise<HydratedHistoryEntry[]> {
    if (entries.length === 0) return [];
    const ids = [...new Set(entries.map(e => e.trackId))];
    const trackMap = await tracksStore.getTracks(ids);
    return entries.map(e => ({
      ...e,
      track: trackMap.get(e.trackId)!,
    })).filter(e => e.track);
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
