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

const bridge = () => (window as any).bridge;

// Сброс привязок копию не трогает: из неё их потом можно вернуть.
async function saveManifest() {
  try {
    await bridge().writeOverridesManifest(await store.getAllOverrides());
  } catch (e) {
    console.warn('[overrides] manifest write failed', e);
  }
}

export const getOverride = (videoId: string) => store.getOverride(videoId);
export const setOverride = (override: LocalOverride) => store.setOverride(override).then(saveManifest);
export const deleteOverride = (videoId: string) => store.deleteOverride(videoId).then(saveManifest);
export const getAllOverrides = () => store.getAllOverrides();
export const clearAllOverrides = () => store.clearAllOverrides();

// Как sanitize в python/api.py: так id трека попадает в имя файла.
export function songFileId(id: string): string {
  let s = id.replace(/[<>:"/\\|?* ]/g, '-').replace(/^-+|-+$/g, '');
  while (s.includes('..')) s = s.replace(/\.\./g, '-');
  return s || 'Unknown';
}

const YT_ID = /^[A-Za-z0-9_-]{11}$/;
// <id>_<время в мс>.ext, у сохранённого потока с префиксом dl_direct_
const SONG_FILE = /^(?:dl_direct_)?(.+)_(\d{13})\.[^.]+$/;

export function parseSongFile(filename: string, idsByFileId: Map<string, string>) {
  const m = SONG_FILE.exec(filename);
  if (!m) return null;
  const videoId = idsByFileId.get(m[1]) ?? (YT_ID.test(m[1]) ? m[1] : null);
  return videoId ? { videoId, addedAt: Number(m[2]) } : null;
}

// Возвращает привязки из папки с треками: сначала из копии, для файлов без неё по имени.
// Существующие привязки не перезаписывает.
export async function restoreOverridesFromFolder(knownTrackIds: string[], onProgress?: (done: number, total: number) => void): Promise<number> {
  const files: string[] = await bridge().listSongFiles();
  const fileSet = new Set(files);
  const current = await store.getAllOverrides();
  const boundIds = new Set(current.map(o => o.videoId));
  const boundFiles = new Set(current.map(o => o.filename));

  const found = new Map<string, LocalOverride>();
  const manifest = await bridge().readOverridesManifest();
  for (const o of (Array.isArray(manifest) ? manifest : []) as LocalOverride[]) {
    if (o?.videoId && fileSet.has(o.filename)) found.set(o.videoId, o);
  }

  // Имя файла хранит id после sanitize; у SC-треков это URL, его сверяем с известными треками.
  const idsByFileId = new Map(knownTrackIds.map(id => [songFileId(id), id]));
  const fromNames: LocalOverride[] = [];
  const manifestFiles = new Set([...found.values()].map(o => o.filename));
  for (const filename of files) {
    if (manifestFiles.has(filename)) continue;
    const parsed = parseSongFile(filename, idsByFileId);
    if (!parsed || found.has(parsed.videoId)) continue;
    const prev = fromNames.find(o => o.videoId === parsed.videoId);
    if (prev && prev.addedAt >= parsed.addedAt) continue;
    if (prev) fromNames.splice(fromNames.indexOf(prev), 1);
    fromNames.push({ ...parsed, filename, sourceUrl: filename, sourceType: 'local', gainDb: 0 });
  }

  const toRestore = [...found.values(), ...fromNames].filter(o => !boundIds.has(o.videoId) && !boundFiles.has(o.filename));
  const songsPath = await bridge().getSongsPath();
  let done = 0;
  for (const o of toRestore) {
    if (fromNames.includes(o)) {
      const res = await bridge().pyCall('analyze_file', { filename: o.filename, songsPath });
      if (res?.status === 'ok') o.gainDb = res.gainDb ?? 0;
    }
    await store.setOverride(o);
    onProgress?.(++done, toRestore.length);
  }
  if (toRestore.length > 0 || !Array.isArray(manifest)) await saveManifest();
  return toRestore.length;
}
