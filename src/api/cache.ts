export interface CacheEntry {
    url: string;
    expires: number;
    loudness?: number | null;   // null = не знаем; 0 = трек ровно на -14 LUFS
    watchtimeUrl?: string;
}

class DbCache {
    private dbName = 'ytm-cache';
    private storeName = 'streams';
    // Громкость -- свойство самого аудио, а не подписанной ссылки: та меняется каждые
    // несколько часов, указывая на тот же файл. Поэтому отдельное хранилище без expires.
    private loudnessStore = 'loudness';
    private db: IDBDatabase | null = null;

    async init() {
        if (this.db) return;
        return new Promise<void>((resolve, reject) => {
            const request = indexedDB.open(this.dbName, 7); // Increased version
            request.onupgradeneeded = () => {
                const db = request.result;
                if (db.objectStoreNames.contains(this.storeName)) {
                    db.deleteObjectStore(this.storeName);
                }
                db.createObjectStore(this.storeName);
                if (!db.objectStoreNames.contains(this.loudnessStore)) {
                    db.createObjectStore(this.loudnessStore);
                }
            };
            request.onsuccess = () => {
                this.db = request.result;
                resolve();
            };
            request.onerror = () => reject(request.error);
        });
    }

    async get(id: string): Promise<CacheEntry | null> {
        if (!this.db || !id) return null;
        return new Promise((resolve) => {
            const transaction = this.db!.transaction(this.storeName, 'readwrite');
            const store = transaction.objectStore(this.storeName);
            const request = store.get(id);

            request.onsuccess = () => {
                const entry: CacheEntry = request.result;
                if (!entry) return resolve(null);

                const now = Math.floor(Date.now() / 1000);
                if (entry.expires > now + 10) {
                    resolve(entry);
                } else {
                    store.delete(id);
                    resolve(null);
                }
            };
            request.onerror = () => resolve(null);
        });
    }

    async delete(id: string): Promise<void> {
        if (!this.db || !id) return;
        return new Promise((resolve) => {
            const transaction = this.db!.transaction(this.storeName, 'readwrite');
            const request = transaction.objectStore(this.storeName).delete(id);
            request.onsuccess = () => resolve();
            request.onerror = () => resolve();
        });
    }

    async getLoudness(id: string): Promise<number | null> {
        if (!this.db || !id) return null;
        return new Promise((resolve) => {
            const request = this.db!.transaction(this.loudnessStore, 'readonly').objectStore(this.loudnessStore).get(id);
            request.onsuccess = () => resolve(typeof request.result === 'number' ? request.result : null);
            request.onerror = () => resolve(null);
        });
    }

    async setLoudness(id: string, loudness: number) {
        if (!this.db || !id) return;
        this.db.transaction(this.loudnessStore, 'readwrite').objectStore(this.loudnessStore).put(loudness, id);
    }

    async set(id: string, url: string, expires: number, loudness: number | null = null, watchtimeUrl?: string) {
        if (!this.db || !id || !url) return;
        const transaction = this.db.transaction(this.storeName, 'readwrite');
        transaction.objectStore(this.storeName).put({ url, expires, loudness, watchtimeUrl }, id);
    }

    async isFresh(id: string): Promise<boolean> {
        if (!this.db) return false;
        return new Promise((resolve) => {
            const request = this.db!.transaction(this.storeName, 'readonly').objectStore(this.storeName).get(id);
            request.onsuccess = () => {
                const entry: CacheEntry = request.result;
                const now = Math.floor(Date.now() / 1000);
                resolve(!!(entry && entry.expires > now + 600)); // 10 min
            };
            request.onerror = () => resolve(false);
        });
    }

    /**
     * Сброс всех ссылок на стримы. Громкость НЕ трогаем: она свойство самого аудио,
     * замеряется ffmpeg'ом целиком и стоит дорого, а ссылки протухают сами.
     * Нужен, когда закэширована ссылка не на ту запись (подмена клипа на альбомную
     * версию меняет то, что лежит под тем же id).
     */
    async clearStreams(): Promise<void> {
        await this.init();
        if (!this.db) return;
        return new Promise((resolve) => {
            const transaction = this.db!.transaction(this.storeName, 'readwrite');
            const request = transaction.objectStore(this.storeName).clear();
            request.onsuccess = () => resolve();
            request.onerror = () => resolve();
        });
    }

    async clearExpired() {
        if (!this.db) return;
        const transaction = this.db.transaction(this.storeName, 'readwrite');
        const store = transaction.objectStore(this.storeName);
        const now = Math.floor(Date.now() / 1000);
        const request = store.openCursor();
        request.onsuccess = (e: any) => {
            const cursor = e.target.result;
            if (cursor) {
                if (cursor.value.expires <= now) cursor.delete();
                cursor.continue();
            }
        };
    }
}

export const streamCache = new DbCache();
