export interface LocalOverride {
  videoId: string;
  filename: string;
  sourceUrl: string;
  sourceType: 'soundcloud' | 'youtube' | 'direct' | 'local';
  gainDb: number;
  addedAt: number;
}

const OVERRIDE_EVENT = 'local-override-changed';

type OverrideChangeAction = 'set' | 'delete' | 'reset';
type OverrideChangeDetail = { videoId?: string; action: OverrideChangeAction };

function emitOverrideChanged(detail: OverrideChangeDetail) {
  try {
    window.dispatchEvent(new CustomEvent(OVERRIDE_EVENT, { detail }));
  } catch {
    // no-op (e.g. during SSR/tests)
  }
}

export function onOverrideChanged(
  callback: (e: CustomEvent<OverrideChangeDetail>) => void
) {
  const handler = callback as unknown as EventListener;
  window.addEventListener(OVERRIDE_EVENT, handler);
  return () => window.removeEventListener(OVERRIDE_EVENT, handler);
}

class LocalOverridesStore {
  private db: IDBDatabase | null = null;
  private readonly DB_NAME = 'goymusic-overrides';
  private readonly VERSION = 1;
  private initPromise: Promise<void> | null = null;

  async init() {
    if (this.initPromise) return this.initPromise;
    this.initPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(this.DB_NAME, this.VERSION);
      request.onupgradeneeded = (e: any) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('overrides')) {
          db.createObjectStore('overrides', { keyPath: 'videoId' });
        }
      };
      request.onsuccess = (e: any) => { this.db = e.target.result; resolve(); };
      request.onerror = (e) => { this.initPromise = null; reject(e); };
    });
    return this.initPromise;
  }

  async getOverride(videoId: string): Promise<LocalOverride | undefined> {
    await this.init();
    if (!this.db) return undefined;
    return new Promise((resolve) => {
      const tx = this.db!.transaction('overrides', 'readonly');
      const request = tx.objectStore('overrides').get(videoId);
      request.onsuccess = () => resolve(request.result ?? undefined);
      request.onerror = () => resolve(undefined);
    });
  }

  async setOverride(override: LocalOverride): Promise<void> {
    await this.init();
    if (!this.db) return;
    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction('overrides', 'readwrite');
      tx.objectStore('overrides').put(override);
      tx.oncomplete = () => {
        emitOverrideChanged({ videoId: override.videoId, action: 'set' });
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    });
  }

  async deleteOverride(videoId: string): Promise<void> {
    await this.init();
    if (!this.db) return;
    return new Promise((resolve) => {
      const tx = this.db!.transaction('overrides', 'readwrite');
      tx.objectStore('overrides').delete(videoId);
      tx.oncomplete = () => {
        emitOverrideChanged({ videoId, action: 'delete' });
        resolve();
      };
    });
  }

  async clearAllOverrides(): Promise<void> {
    await this.init();
    if (!this.db) return;
    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction('overrides', 'readwrite');
      tx.objectStore('overrides').clear();
      tx.oncomplete = () => {
        emitOverrideChanged({ action: 'reset' });
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    });
  }

  async getAllOverrides(): Promise<LocalOverride[]> {
    await this.init();
    if (!this.db) return [];
    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction('overrides', 'readonly');
      const request = tx.objectStore('overrides').getAll();
      request.onsuccess = () => resolve(request.result ?? []);
      request.onerror = () => reject(request.error);
    });
  }
}

const store = new LocalOverridesStore();

export const getOverride = (videoId: string) => store.getOverride(videoId);
export const setOverride = (override: LocalOverride) => store.setOverride(override);
export const deleteOverride = (videoId: string) => store.deleteOverride(videoId);
export const getAllOverrides = () => store.getAllOverrides();
export const clearAllOverrides = () => store.clearAllOverrides();
