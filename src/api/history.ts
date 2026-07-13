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
  private pendingTrackMigrations: YTMTrack[] = [];

  async init() {
    if (this.initPromise) return this.initPromise;
    this.initPromise = new Promise((resolve, reject) => {
      console.log(`[history] Opening DB "${this.DB_NAME}" v${this.VERSION}...`);
      const request = indexedDB.open(this.DB_NAME, this.VERSION);
      request.onupgradeneeded = (e: any) => {
        const db = e.target.result;
        const oldVersion = e.oldVersion;
        console.log(`[history] onupgradeneeded: oldVersion=${oldVersion}, stores=[${Array.from(db.objectStoreNames)}]`);

        // ─── Fresh install: create plays store ───
        if (oldVersion === 0) {
          console.log('[history] Fresh install — creating plays store');
          const store = db.createObjectStore('plays', { keyPath: 'timestamp' });
          store.createIndex('trackId', 'trackId', { unique: false });
          return;
        }

        // ─── v1 → v3: migrate 'tracks' store (with inline track objects) → 'plays' ───
        if (oldVersion < 2 && db.objectStoreNames.contains('tracks')) {
          console.log('[history] v1→v3 migration: reading from tracks store...');
          const oldStore = e.target.transaction.objectStore('tracks');
          const migrated: { timestamp: number; trackId: string; listenedSeconds: number }[] = [];
          const trackBatch: YTMTrack[] = [];

          const cursorReq = oldStore.openCursor();
          cursorReq.onsuccess = (ev: any) => {
            const cursor = ev.target.result;
            if (cursor) {
              const old = cursor.value;
              const trackId = old.track?.id || old.videoId;
              migrated.push({
                timestamp: old.timestamp,
                trackId,
                listenedSeconds: old.listenedSeconds || 0,
              });
              if (old.track) trackBatch.push(old.track);
              cursor.continue();
            } else {
              console.log(`[history] v1→v3 migration: read ${migrated.length} entries, ${trackBatch.length} tracks`);
              db.deleteObjectStore('tracks');
              const store = db.createObjectStore('plays', { keyPath: 'timestamp' });
              store.createIndex('trackId', 'trackId', { unique: false });
              for (const entry of migrated) store.put(entry);
              this.pendingTrackMigrations = trackBatch;
              console.log('[history] v1→v3 migration: stores swapped, tracks queued for tracksStore');
            }
          };
          return;
        }

        // ─── v2 → v3: recreate 'plays' store with trackId index ───
        if (oldVersion < 3 && db.objectStoreNames.contains('plays')) {
          console.log('[history] v2→v3 migration: reading from plays store...');
          const oldStore = e.target.transaction.objectStore('plays');
          const migrated: { timestamp: number; trackId: string; listenedSeconds: number }[] = [];

          const cursorReq = oldStore.openCursor();
          cursorReq.onsuccess = (ev: any) => {
            const cursor = ev.target.result;
            if (cursor) {
              const old = cursor.value;
              migrated.push({
                timestamp: old.timestamp,
                trackId: old.trackId || (old as any).videoId,
                listenedSeconds: old.listenedSeconds || 0,
              });
              cursor.continue();
            } else {
              console.log(`[history] v2→v3 migration: read ${migrated.length} entries`);
              db.deleteObjectStore('plays');
              const store = db.createObjectStore('plays', { keyPath: 'timestamp' });
              store.createIndex('trackId', 'trackId', { unique: false });
              for (const entry of migrated) store.put(entry);
              console.log('[history] v2→v3 migration: done');
            }
          };
          return;
        }

        // ─── v2 without plays store: create fresh ───
        if (oldVersion < 3 && !db.objectStoreNames.contains('plays')) {
          console.log('[history] v2 without plays — creating fresh');
          const store = db.createObjectStore('plays', { keyPath: 'timestamp' });
          store.createIndex('trackId', 'trackId', { unique: false });
        }
      };
      request.onsuccess = (e: any) => {
        this.db = e.target.result;
        if (!this.db) { reject(new Error('DB is null')); return; }
        const stores = Array.from(this.db.objectStoreNames);
        console.log(`[history] DB opened. Stores: [${stores}]`);

        // Check plays count
        try {
          const tx = this.db.transaction('plays', 'readonly');
          const store = tx.objectStore('plays');
          const countReq = store.count();
          countReq.onsuccess = () => {
            console.log(`[history] plays store has ${countReq.result} entries`);
          };
          countReq.onerror = () => {
            console.log(`[history] failed to count plays: ${countReq.error}`);
          };
        } catch (err: any) {
          console.log(`[history] failed to open plays store: ${err.message}`);
        }

        if (this.pendingTrackMigrations.length > 0) {
          console.log(`[history] Migrating ${this.pendingTrackMigrations.length} tracks to tracksStore...`);
          tracksStore.upsertTracksBatch(this.pendingTrackMigrations)
            .then(() => console.log('[history] tracksStore migration complete'))
            .catch((err) => console.error('[history] tracksStore migration failed:', err));
          this.pendingTrackMigrations = [];
        }
        resolve();
      };
      request.onerror = (e) => {
        console.error(`[history] DB open FAILED:`, request.error);
        this.initPromise = null;
        reject(request.error);
      };
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
