import { YTMTrack } from './yt';

class TracksStore {
  private db: IDBDatabase | null = null;
  private readonly DB_NAME = 'goymusic-tracks';
  private readonly STORE_NAME = 'tracks';
  private readonly VERSION = 1;

  async init() {
    if (this.db) return;
    return new Promise<void>((resolve, reject) => {
      console.log(`[tracks] Opening DB "${this.DB_NAME}" v${this.VERSION}...`);
      const request = indexedDB.open(this.DB_NAME, this.VERSION);
      request.onupgradeneeded = (e: any) => {
        const db = e.target.result;
        console.log(`[tracks] onupgradeneeded: stores=[${Array.from(db.objectStoreNames)}]`);
        if (!db.objectStoreNames.contains(this.STORE_NAME)) {
          console.log('[tracks] Creating tracks store');
          db.createObjectStore(this.STORE_NAME, { keyPath: 'id' });
        }
      };
      request.onsuccess = (e: any) => {
        this.db = e.target.result;
        if (!this.db) { reject(new Error('DB is null')); return; }
        const stores = Array.from(this.db.objectStoreNames);
        console.log(`[tracks] DB opened. Stores: [${stores}]`);

        try {
          const tx = this.db.transaction(this.STORE_NAME, 'readonly');
          const countReq = tx.objectStore(this.STORE_NAME).count();
          countReq.onsuccess = () => console.log(`[tracks] tracks store has ${countReq.result} entries`);
        } catch (err: any) {
          console.log(`[tracks] failed to count: ${err.message}`);
        }

        resolve();
      };
      request.onerror = () => {
        console.error(`[tracks] DB open FAILED:`, request.error);
        reject(request.error);
      };
    });
  }

  async upsertTrack(track: YTMTrack): Promise<void> {
    await this.init();
    if (!this.db) return;
    return new Promise<void>((resolve, reject) => {
      const tx = this.db!.transaction(this.STORE_NAME, 'readwrite');
      tx.objectStore(this.STORE_NAME).put(track);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async upsertTracksBatch(tracks: YTMTrack[]): Promise<void> {
    await this.init();
    if (!this.db || tracks.length === 0) return;
    return new Promise<void>((resolve, reject) => {
      const tx = this.db!.transaction(this.STORE_NAME, 'readwrite');
      const store = tx.objectStore(this.STORE_NAME);
      for (const track of tracks) {
        store.put(track);
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async getTrack(id: string): Promise<YTMTrack | null> {
    await this.init();
    if (!this.db) return null;
    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(this.STORE_NAME, 'readonly');
      const request = tx.objectStore(this.STORE_NAME).get(id);
      request.onsuccess = () => resolve(request.result ?? null);
      request.onerror = () => reject(request.error);
    });
  }

  async getTracks(ids: string[]): Promise<Map<string, YTMTrack>> {
    await this.init();
    if (!this.db || ids.length === 0) return new Map();
    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(this.STORE_NAME, 'readonly');
      const store = tx.objectStore(this.STORE_NAME);
      const map = new Map<string, YTMTrack>();
      let pending = ids.length;
      if (pending === 0) { resolve(map); return; }
      for (const id of ids) {
        const req = store.get(id);
        req.onsuccess = () => {
          if (req.result) map.set(id, req.result);
          if (--pending === 0) resolve(map);
        };
        req.onerror = () => {
          if (--pending === 0) resolve(map);
        };
      }
    });
  }

  async deleteTrack(id: string): Promise<void> {
    await this.init();
    if (!this.db) return;
    const tx = this.db.transaction(this.STORE_NAME, 'readwrite');
    tx.objectStore(this.STORE_NAME).delete(id);
  }

  async clearAll(): Promise<void> {
    await this.init();
    if (!this.db) return;
    const tx = this.db.transaction(this.STORE_NAME, 'readwrite');
    tx.objectStore(this.STORE_NAME).clear();
  }

  async getAllIds(): Promise<string[]> {
    await this.init();
    if (!this.db) return [];
    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(this.STORE_NAME, 'readonly');
      const request = tx.objectStore(this.STORE_NAME).getAllKeys();
      request.onsuccess = () => resolve(request.result as string[]);
      request.onerror = () => reject(request.error);
    });
  }
}

export const tracksStore = new TracksStore();
