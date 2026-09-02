import { YTMTrack } from './yt';
import { tracksStore } from './tracks';

export interface LikedEntry {
  trackId: string;
  originalIndex: number;
  syncedAt: number;
  likedAt?: number;
}

export interface HydratedLikedEntry extends LikedEntry {
  track: YTMTrack;
}

export interface ScLikedEntry {
  scId: string;
  trackId: string;
  likedAt: number;
  localOnly?: boolean;
}

export interface HydratedScLikedEntry extends ScLikedEntry {
  track: YTMTrack;
}

export interface YandexLikedEntry {
  yandexId: string;
  trackId: string;
  likedAt: number;
}

export interface HydratedYandexLikedEntry extends YandexLikedEntry {
  track: YTMTrack;
}

export interface YtImportState {
  version: 1;
  status: 'importing' | 'failed';
  ytTotal: number;
  scTotal: number;
  downloadedCount: number;
  continuation: string | null;
  headIds: string[];
  startedAt: number;
  updatedAt: number;
}

function ensureFinalStores(db: IDBDatabase) {
  if (!db.objectStoreNames.contains('yt_liked')) {
    const store = db.createObjectStore('yt_liked', { keyPath: 'trackId' });
    store.createIndex('originalIndex', 'originalIndex', { unique: false });
  }
  if (!db.objectStoreNames.contains('sc_liked')) {
    const sc = db.createObjectStore('sc_liked', { keyPath: 'scId' });
    sc.createIndex('likedAt', 'likedAt', { unique: false });
    sc.createIndex('trackId', 'trackId', { unique: false });
  }
  if (!db.objectStoreNames.contains('yt_import_liked')) {
    const pending = db.createObjectStore('yt_import_liked', { keyPath: 'trackId' });
    pending.createIndex('originalIndex', 'originalIndex', { unique: false });
  }
  if (!db.objectStoreNames.contains('yandex_liked')) {
    const yandex = db.createObjectStore('yandex_liked', { keyPath: 'yandexId' });
    yandex.createIndex('likedAt', 'likedAt', { unique: false });
    yandex.createIndex('trackId', 'trackId', { unique: false });
  }
  if (!db.objectStoreNames.contains('state')) db.createObjectStore('state');
}

function applyMigration(
  db: IDBDatabase,
  collected: Record<string, any[]>,
  trackBatch: YTMTrack[]
) {
  // Delete old stores
  for (const name of ['tracks', 'sc_tracks', 'yt_import_tracks']) {
    if (db.objectStoreNames.contains(name)) db.deleteObjectStore(name);
  }

  // Create new stores with migrated data
  if (collected['tracks']) {
    const store = db.createObjectStore('yt_liked', { keyPath: 'trackId' });
    store.createIndex('originalIndex', 'originalIndex', { unique: false });
    for (const old of collected['tracks']) {
      store.put({
        trackId: old.track?.id || old.videoId,
        originalIndex: old.originalIndex,
        syncedAt: old.syncedAt,
        likedAt: old.likedAt,
      });
    }
    console.log(`[liked] Created yt_liked: ${collected['tracks'].length} entries`);
  }

  if (collected['sc_tracks']) {
    const sc = db.createObjectStore('sc_liked', { keyPath: 'scId' });
    sc.createIndex('likedAt', 'likedAt', { unique: false });
    sc.createIndex('trackId', 'trackId', { unique: false });
    for (const old of collected['sc_tracks']) {
      sc.put({
        scId: old.scId,
        trackId: old.track?.id || old.scId,
        likedAt: old.likedAt,
        localOnly: old.localOnly,
      });
    }
    console.log(`[liked] Created sc_liked: ${collected['sc_tracks'].length} entries`);
  }

  if (collected['yt_import_tracks']) {
    const pending = db.createObjectStore('yt_import_liked', { keyPath: 'trackId' });
    pending.createIndex('originalIndex', 'originalIndex', { unique: false });
    for (const old of collected['yt_import_tracks']) {
      pending.put({
        trackId: old.track?.id || old.videoId,
        originalIndex: old.originalIndex,
        syncedAt: old.syncedAt,
        likedAt: old.likedAt,
      });
    }
    console.log(`[liked] Created yt_import_liked: ${collected['yt_import_tracks'].length} entries`);
  }

  ensureFinalStores(db);
  console.log('[liked] v3→v5 migration complete');
}

class LikedStore {
  private db: IDBDatabase | null = null;
  private readonly DB_NAME = 'goymusic-liked';
  private readonly VERSION = 6;
  private initPromise: Promise<void> | null = null;
  private pendingTrackMigrations: YTMTrack[] = [];

  async init() {
    if (this.initPromise) return this.initPromise;
    this.initPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(this.DB_NAME, this.VERSION);
      request.onupgradeneeded = (e: any) => {
        const db = e.target.result;
        const oldVersion = e.oldVersion;
        console.log(`[liked] onupgradeneeded: oldVersion=${oldVersion}, stores=[${Array.from(db.objectStoreNames)}]`);

        // ─── v3 → v5: migrate old stores ───
        if (oldVersion < 4) {
          const oldStores = ['tracks', 'sc_tracks', 'yt_import_tracks'].filter(s => db.objectStoreNames.contains(s));
          console.log(`[liked] v3→v5: old stores found: [${oldStores}]`);

          if (oldStores.length === 0) {
            // No old stores — just create fresh
            ensureFinalStores(db);
            return;
          }

          // Collect all data from old stores via cursors, then do schema changes
          const collected: Record<string, any[]> = {};
          const trackBatch: YTMTrack[] = [];
          let pending = oldStores.length;

          for (const storeName of oldStores) {
            collected[storeName] = [];
            const oldStore = e.target.transaction.objectStore(storeName);
            const cursorReq = oldStore.openCursor();
            cursorReq.onsuccess = (ev: any) => {
              const cursor = ev.target.result;
              if (cursor) {
                const old = cursor.value;
                if (old.track) trackBatch.push(old.track);
                collected[storeName].push(old);
                cursor.continue();
              } else {
                console.log(`[liked] Read ${collected[storeName].length} from ${storeName}`);
                if (--pending === 0) {
                  // All cursors done — now do schema changes
                  applyMigration(db, collected, trackBatch);
                  this.pendingTrackMigrations = trackBatch;
                }
              }
            };
            cursorReq.onerror = () => {
              if (--pending === 0) {
                applyMigration(db, collected, trackBatch);
                this.pendingTrackMigrations = trackBatch;
              }
            };
          }
          return;
        }

        // ─── v4 → v5: recreate 'yt_liked' with keyPath trackId ───
        if (oldVersion >= 4 && oldVersion < 5 && db.objectStoreNames.contains('yt_liked')) {
          const oldStore = e.target.transaction.objectStore('yt_liked');
          const entries: any[] = [];
          const cursorReq = oldStore.openCursor();
          cursorReq.onsuccess = (ev: any) => {
            const cursor = ev.target.result;
            if (cursor) {
              const old = cursor.value;
              entries.push({
                trackId: old.trackId || old.videoId,
                originalIndex: old.originalIndex,
                syncedAt: old.syncedAt,
                likedAt: old.likedAt,
              });
              cursor.continue();
            } else {
              db.deleteObjectStore('yt_liked');
              const store = db.createObjectStore('yt_liked', { keyPath: 'trackId' });
              store.createIndex('originalIndex', 'originalIndex', { unique: false });
              for (const entry of entries) store.put(entry);
              console.log(`[liked] v4→v5: migrated yt_liked: ${entries.length} entries`);
            }
          };
          return;
        }

        // ─── v5 → v6: add yandex_liked store ───
        if (oldVersion >= 5 && oldVersion < 6) {
          ensureFinalStores(db);
          return;
        }

        // ─── Fresh install: create all stores ───
        ensureFinalStores(db);
      };
      request.onsuccess = (e: any) => {
        this.db = e.target.result;
        if (!this.db) { reject(new Error('liked DB is null')); return; }
        const stores = Array.from(this.db.objectStoreNames);
        console.log(`[liked] DB opened. Stores: [${stores}]`);

        // Log counts
        for (const s of stores) {
          try {
            const tx = this.db.transaction(s, 'readonly');
            const countReq = tx.objectStore(s).count();
            countReq.onsuccess = () => console.log(`[liked] ${s}: ${countReq.result} entries`);
          } catch {}
        }

        if (this.pendingTrackMigrations.length > 0) {
          console.log(`[liked] Migrating ${this.pendingTrackMigrations.length} tracks to tracksStore...`);
          tracksStore.upsertTracksBatch(this.pendingTrackMigrations)
            .then(() => console.log('[liked] tracksStore migration complete'))
            .catch((err) => console.error('[liked] tracksStore migration failed:', err));
          this.pendingTrackMigrations = [];
        }
        resolve();
      };
      request.onerror = (e) => {
        console.error(`[liked] DB open FAILED:`, request.error);
        this.initPromise = null;
        reject(request.error);
      };
    });
    return this.initPromise;
  }

  // ─── state (virtual counts) ──────────────────────────────────────────────
  private async getState<T>(key: string, fallback: T): Promise<T> {
    await this.init();
    if (!this.db) return fallback;
    return new Promise((resolve) => {
      const tx = this.db!.transaction('state', 'readonly');
      const request = tx.objectStore('state').get(key);
      request.onsuccess = () => resolve(request.result ?? fallback);
      request.onerror = () => resolve(fallback);
    });
  }

  private async setState<T>(key: string, value: T): Promise<void> {
    await this.init();
    if (!this.db) return;
    return new Promise<void>((resolve, reject) => {
      const tx = this.db!.transaction('state', 'readwrite');
      tx.objectStore('state').put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  getVirtualCount() { return this.getState('virtualCount', 0); }
  setVirtualCount(count: number) { return this.setState('virtualCount', count); }
  getScVirtualCount() { return this.getState('scVirtualCount', 0); }
  setScVirtualCount(count: number) { return this.setState('scVirtualCount', count); }
  getYtImportCompletedVersion() { return this.getState('ytImportCompletedVersion', 0); }

  getYtImportState() { return this.getState<YtImportState | null>('ytImport', null); }
  setYtImportState(state: YtImportState) { return this.setState('ytImport', state); }

  async getYtImportTracks(): Promise<LikedEntry[]> {
    return this.getTracksFromStore('yt_import_liked');
  }

  async saveYtImportPage(entries: LikedEntry[], state: YtImportState) {
    await this.init();
    if (!this.db) return;
    return new Promise<void>((resolve, reject) => {
      const tx = this.db!.transaction(['yt_import_liked', 'state'], 'readwrite');
      const store = tx.objectStore('yt_import_liked');
      entries.forEach(entry => store.put(entry));
      tx.objectStore('state').put(state, 'ytImport');
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  async clearYtImport() {
    await this.init();
    if (!this.db) return;
    return new Promise<void>((resolve, reject) => {
      const tx = this.db!.transaction(['yt_import_liked', 'state'], 'readwrite');
      tx.objectStore('yt_import_liked').clear();
      tx.objectStore('state').delete('ytImport');
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  async commitYtImport(entries: LikedEntry[], virtualCount: number) {
    await this.init();
    if (!this.db) return;
    return new Promise<void>((resolve, reject) => {
      const tx = this.db!.transaction(['yt_liked', 'yt_import_liked', 'state'], 'readwrite');
      const tracks = tx.objectStore('yt_liked');
      tracks.clear();
      entries.forEach(entry => tracks.put(entry));
      tx.objectStore('yt_import_liked').clear();
      const state = tx.objectStore('state');
      state.put(virtualCount, 'virtualCount');
      state.put(1, 'ytImportCompletedVersion');
      state.delete('ytImport');
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  // ─── YouTube tracks ──────────────────────────────────────────────────────
  async getMinIndex(): Promise<number> {
    await this.init();
    return new Promise((resolve) => {
      const tx = this.db!.transaction('yt_liked', 'readonly');
      const store = tx.objectStore('yt_liked');
      const index = store.index('originalIndex');
      const request = index.openCursor(null, 'next');
      request.onsuccess = (e: any) => {
        const cursor = e.target.result;
        resolve(cursor ? cursor.value.originalIndex : 0);
      };
      request.onerror = () => resolve(0);
    });
  }

  async getAllTracks(): Promise<LikedEntry[]> {
    return this.getTracksFromStore('yt_liked');
  }

  private async getTracksFromStore(storeName: 'yt_liked' | 'yt_import_liked'): Promise<LikedEntry[]> {
    await this.init();
    if (!this.db) return [];
    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
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

  async hydrateTracks(entries: LikedEntry[]): Promise<HydratedLikedEntry[]> {
    if (entries.length === 0) return [];
    const ids = [...new Set(entries.map(e => e.trackId))];
    const trackMap = await tracksStore.getTracks(ids);
    return entries.map(e => ({
      ...e,
      track: trackMap.get(e.trackId)!,
    })).filter(e => e.track);
  }

  async hydrateScTracks(entries: ScLikedEntry[]): Promise<HydratedScLikedEntry[]> {
    if (entries.length === 0) return [];
    const ids = [...new Set(entries.map(e => e.trackId))];
    const trackMap = await tracksStore.getTracks(ids);
    return entries.map(e => ({
      ...e,
      track: trackMap.get(e.trackId)!,
    })).filter(e => e.track);
  }

  async getLikedAtMap(): Promise<Map<string, number>> {
    const entries = await this.getAllTracks();
    const map = new Map<string, number>();
    for (const e of entries) if (e.likedAt) map.set(e.trackId, e.likedAt);
    return map;
  }

  async putTrack(entry: LikedEntry) {
    await this.init();
    if (!this.db) return;
    return new Promise<void>((resolve, reject) => {
      const tx = this.db!.transaction('yt_liked', 'readwrite');
      tx.objectStore('yt_liked').put(entry);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async putTracksBatch(entries: LikedEntry[]) {
    await this.init();
    if (!this.db || entries.length === 0) return;
    return new Promise<void>((resolve, reject) => {
      const tx = this.db!.transaction('yt_liked', 'readwrite');
      const store = tx.objectStore('yt_liked');
      entries.forEach(entry => store.put(entry));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async deleteTrack(trackId: string) {
    await this.init();
    if (!this.db) return;
    const tx = this.db!.transaction('yt_liked', 'readwrite');
    tx.objectStore('yt_liked').delete(trackId);
  }

  async clearAllTracks() {
    await this.init();
    if (!this.db) return;
    const tx = this.db!.transaction('yt_liked', 'readwrite');
    tx.objectStore('yt_liked').clear();
  }

  async replaceAllTracks(entries: LikedEntry[]) {
    await this.init();
    if (!this.db) return;
    return new Promise<void>((resolve, reject) => {
      const tx = this.db!.transaction('yt_liked', 'readwrite');
      const store = tx.objectStore('yt_liked');
      try {
        store.clear();
        entries.forEach(entry => store.put(entry));
      } catch (error) {
        tx.abort();
        reject(error);
        return;
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  // ─── SoundCloud tracks ───────────────────────────────────────────────────
  async getAllScTracks(): Promise<ScLikedEntry[]> {
    await this.init();
    if (!this.db) return [];
    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction('sc_liked', 'readonly');
      const index = tx.objectStore('sc_liked').index('likedAt');
      const request = index.openCursor(null, 'prev');
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
      const tx = this.db!.transaction('sc_liked', 'readwrite');
      tx.objectStore('sc_liked').put(entry);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async putScTracksBatch(entries: ScLikedEntry[]) {
    await this.init();
    if (!this.db || entries.length === 0) return;
    return new Promise<void>((resolve, reject) => {
      const tx = this.db!.transaction('sc_liked', 'readwrite');
      const store = tx.objectStore('sc_liked');
      entries.forEach(entry => store.put(entry));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async deleteScTrack(scId: string) {
    await this.init();
    if (!this.db) return;
    const tx = this.db!.transaction('sc_liked', 'readwrite');
    tx.objectStore('sc_liked').delete(scId);
  }

  async clearScTracks() {
    await this.init();
    if (!this.db) return;
    const tx = this.db!.transaction('sc_liked', 'readwrite');
    tx.objectStore('sc_liked').clear();
  }

  async replaceScTracks(entries: ScLikedEntry[]) {
    await this.init();
    if (!this.db) return;
    return new Promise<void>((resolve, reject) => {
      const tx = this.db!.transaction('sc_liked', 'readwrite');
      const store = tx.objectStore('sc_liked');
      try {
        store.clear();
        entries.forEach(entry => store.put(entry));
      } catch (error) {
        tx.abort();
        reject(error);
        return;
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }
  // ─── Yandex Music tracks ─────────────────────────────────────────────────
  async getAllYandexTracks(): Promise<YandexLikedEntry[]> {
    await this.init();
    if (!this.db) return [];
    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction('yandex_liked', 'readonly');
      const index = tx.objectStore('yandex_liked').index('likedAt');
      const request = index.openCursor(null, 'prev');
      const results: YandexLikedEntry[] = [];
      request.onsuccess = (e: any) => {
        const cursor = e.target.result;
        if (cursor) { results.push(cursor.value); cursor.continue(); }
        else resolve(results);
      };
      request.onerror = () => reject(request.error);
    });
  }

  async hydrateYandexTracks(entries: YandexLikedEntry[]): Promise<HydratedYandexLikedEntry[]> {
    if (entries.length === 0) return [];
    const ids = [...new Set(entries.map(e => e.trackId))];
    const trackMap = await tracksStore.getTracks(ids);
    return entries.map(e => ({
      ...e,
      track: trackMap.get(e.trackId)!,
    })).filter(e => e.track);
  }

  async putYandexTrack(entry: YandexLikedEntry) {
    await this.init();
    if (!this.db) return;
    return new Promise<void>((resolve, reject) => {
      const tx = this.db!.transaction('yandex_liked', 'readwrite');
      tx.objectStore('yandex_liked').put(entry);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async deleteYandexTrack(yandexId: string) {
    await this.init();
    if (!this.db) return;
    const tx = this.db!.transaction('yandex_liked', 'readwrite');
    tx.objectStore('yandex_liked').delete(yandexId);
  }

  async replaceYandexTracks(entries: YandexLikedEntry[]) {
    await this.init();
    if (!this.db) return;
    return new Promise<void>((resolve, reject) => {
      const tx = this.db!.transaction('yandex_liked', 'readwrite');
      const store = tx.objectStore('yandex_liked');
      try {
        store.clear();
        entries.forEach(entry => store.put(entry));
      } catch (error) {
        tx.abort();
        reject(error);
        return;
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }
}

export const likedStore = new LikedStore();

export async function getScLocalOnlyCount(): Promise<number> {
  const all = await likedStore.getAllScTracks();
  return all.filter(e => e.localOnly).length;
}
