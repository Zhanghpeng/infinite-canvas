/**
 * 系统素材库索引的本地缓存。
 *
 * 五份上游索引合计约 4.4MB（未压缩），每次开面板重新拉一遍既慢又浪费上游带宽。
 * 用 IndexedDB 存归一化后的结果，7 天过期；隐私模式或配额不足时静默降级为纯内存。
 */

const DB_NAME = "infinite-canvas-system-library";
const STORE_NAME = "indexes";
const DB_VERSION = 1;
const TTL_MS = 7 * 24 * 60 * 60 * 1000;

type Entry<T> = { savedAt: number; value: T };

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve) => {
        if (typeof indexedDB === "undefined") {
            resolve(null);
            return;
        }
        try {
            const request = indexedDB.open(DB_NAME, DB_VERSION);
            request.onupgradeneeded = () => {
                const db = request.result;
                if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => resolve(null);
            request.onblocked = () => resolve(null);
        } catch {
            resolve(null);
        }
    });
    return dbPromise;
}

export async function readCache<T>(key: string): Promise<T | null> {
    const db = await openDb();
    if (!db) return null;
    return new Promise((resolve) => {
        try {
            const tx = db.transaction(STORE_NAME, "readonly");
            const request = tx.objectStore(STORE_NAME).get(key);
            request.onsuccess = () => {
                const entry = request.result as Entry<T> | undefined;
                if (!entry || !entry.savedAt || Date.now() - entry.savedAt > TTL_MS) {
                    resolve(null);
                    return;
                }
                resolve(entry.value);
            };
            request.onerror = () => resolve(null);
        } catch {
            resolve(null);
        }
    });
}

export async function writeCache<T>(key: string, value: T): Promise<void> {
    const db = await openDb();
    if (!db) return;
    await new Promise<void>((resolve) => {
        try {
            const tx = db.transaction(STORE_NAME, "readwrite");
            tx.objectStore(STORE_NAME).put({ savedAt: Date.now(), value } satisfies Entry<T>, key);
            tx.oncomplete = () => resolve();
            tx.onerror = () => resolve();
            tx.onabort = () => resolve();
        } catch {
            resolve();
        }
    });
}
