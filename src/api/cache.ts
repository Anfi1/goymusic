export interface CacheEntry {
    url: string;
    expires: number;
    loudness?: number;
    watchtimeUrl?: string;
}

class DbCache {
    private dbName = 'ytm-cache';
    private storeName = 'streams';
    private db: IDBDatabase | null = null;

    async init() {
        if (this.db) return;
        return new Promise<void>((resolve, reject) => {
            const request = indexedDB.open(this.dbName, 4); // Increased version
            request.onupgradeneeded = () => {
                const db = request.result;
                if (db.objectStoreNames.contains(this.storeName)) {
                    db.deleteObjectStore(this.storeName);
                }
                db.createObjectStore(this.storeName);
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

    async set(id: string, url: string, expires: number, loudness: number = 0, watchtimeUrl?: string) {
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
