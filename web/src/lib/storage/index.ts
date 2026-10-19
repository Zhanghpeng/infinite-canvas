import { IndexedDbBackend } from "./indexeddb-backend";
import type { StorageBackend } from "./types";

// 当前生效的存储后端。默认浏览器(IndexedDB)；本地模式在启动时由 storage-prefs 切换。
let backend: StorageBackend = new IndexedDbBackend();

export function getStorage(): StorageBackend {
    return backend;
}

export function setStorageBackend(next: StorageBackend) {
    backend = next;
}

export type { StorageBackend, StorageEntry, StorageKind, StorageScope } from "./types";
