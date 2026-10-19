import localforage from "localforage";

import type { StorageBackend, StorageEntry, StorageScope } from "./types";

type LocalForageInstance = typeof localforage;

// 默认实例固定为 app_state，保持与改造前完全一致。
// 测试环境可能 mock/缺省 localforage，这里与 localforage-storage 保持同样的防御写法。
if (typeof localforage?.config === "function") {
    try {
        localforage.config({
            name: "infinite-canvas",
            storeName: "app_state",
        });
    } catch {
        // ignore if already configured or mocked
    }
}

const STORE_NAME_BY_SCOPE: Record<StorageScope, string> = {
    app_state: "app_state",
    image_files: "image_files",
    media_files: "media_files",
    image_previews: "image_previews",
    image_logs: "image_generation_logs",
    video_logs: "video_generation_logs",
};

const instances = new Map<string, LocalForageInstance>();

function instanceFor(scope: StorageScope): LocalForageInstance {
    const storeName = STORE_NAME_BY_SCOPE[scope];
    let instance = instances.get(storeName);
    if (!instance) {
        instance = storeName === "app_state" ? localforage : localforage.createInstance({ name: "infinite-canvas", storeName });
        instances.set(storeName, instance);
    }
    return instance;
}

function hasWindow() {
    return typeof window !== "undefined";
}

// 浏览器后端：沿用 localforage(IndexedDB)。app_state 保留 localStorage 降级，行为与改造前一致。
export class IndexedDbBackend implements StorageBackend {
    readonly kind = "indexeddb" as const;

    async isAvailable() {
        return true;
    }

    async get<T = unknown>(scope: StorageScope, key: string): Promise<T | null> {
        if (!hasWindow()) return null;
        try {
            const value = await instanceFor(scope).getItem<T>(key);
            return (value as T) || null;
        } catch {
            if (scope !== "app_state") throw new Error(`storage read failed: ${scope}/${key}`);
            return (window.localStorage.getItem(key) as unknown as T) || null;
        }
    }

    async set<T = unknown>(scope: StorageScope, key: string, value: T): Promise<void> {
        if (!hasWindow()) return;
        try {
            await instanceFor(scope).setItem(key, value);
        } catch {
            if (scope !== "app_state") throw new Error(`storage write failed: ${scope}/${key}`);
            window.localStorage.setItem(key, String(value));
        }
    }

    async remove(scope: StorageScope, key: string): Promise<void> {
        if (!hasWindow()) return;
        try {
            await instanceFor(scope).removeItem(key);
        } catch {
            if (scope !== "app_state") throw new Error(`storage remove failed: ${scope}/${key}`);
            window.localStorage.removeItem(key);
        }
    }

    async clear(scope: StorageScope): Promise<void> {
        if (!hasWindow()) return;
        await instanceFor(scope).clear();
    }

    async entries<T = unknown>(scope: StorageScope): Promise<Array<StorageEntry<T>>> {
        if (!hasWindow()) return [];
        const items: Array<StorageEntry<T>> = [];
        await instanceFor(scope).iterate<T, void>((value, key) => {
            items.push({ key, value });
        });
        return items;
    }

    async keys(scope: StorageScope): Promise<string[]> {
        if (!hasWindow()) return [];
        const result: string[] = [];
        await instanceFor(scope).iterate((_value, key) => {
            result.push(key);
        });
        return result;
    }

    async getBlob(scope: StorageScope, key: string): Promise<Blob | null> {
        return await this.get<Blob>(scope, key);
    }

    async setBlob(scope: StorageScope, key: string, blob: Blob): Promise<void> {
        await this.set(scope, key, blob);
    }

    async removeBlob(scope: StorageScope, key: string): Promise<void> {
        await this.remove(scope, key);
    }

    // 路径级操作只对本地后端有意义；浏览器模式不会走到这里。
    async readPath(): Promise<Blob | null> {
        throw new Error("readPath 仅支持本地存储后端");
    }

    async writePath(): Promise<void> {
        throw new Error("writePath 仅支持本地存储后端");
    }

    async deletePath(): Promise<void> {
        throw new Error("deletePath 仅支持本地存储后端");
    }

    async listPath(): Promise<Array<{ path: string; directory: boolean }>> {
        throw new Error("listPath 仅支持本地存储后端");
    }

    async movePath(): Promise<void> {
        throw new Error("movePath 仅支持本地存储后端");
    }
}
