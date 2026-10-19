import localforage from "localforage";
import type { StateStorage } from "zustand/middleware";

import { getStorage } from "@/lib/storage";

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

// 读写统一交给当前存储后端（默认 IndexedDB，本地模式为文件系统）。
// 后端不可用时回落到 localforage / localStorage，避免启动期报错。
const fallback: StateStorage = {
    getItem: async (name) => {
        if (typeof window === "undefined") return null;
        try {
            if (typeof localforage?.getItem === "function") {
                const val = await localforage.getItem<string>(name);
                if (val !== null && val !== undefined) return val;
            }
            return window.localStorage?.getItem(name) ?? null;
        } catch {
            return window.localStorage?.getItem(name) ?? null;
        }
    },
    setItem: async (name, value) => {
        if (typeof window === "undefined") return;
        try {
            if (typeof localforage?.setItem === "function") {
                await localforage.setItem(name, value);
                return;
            }
            window.localStorage?.setItem(name, value);
        } catch {
            window.localStorage?.setItem(name, value);
        }
    },
    removeItem: async (name) => {
        if (typeof window === "undefined") return;
        try {
            if (typeof localforage?.removeItem === "function") {
                await localforage.removeItem(name);
                return;
            }
            window.localStorage?.removeItem(name);
        } catch {
            window.localStorage?.removeItem(name);
        }
    },
};

export const localForageStorage: StateStorage = {
    getItem: async (name) => {
        try {
            return (await getStorage().get<string>("app_state", name)) || null;
        } catch {
            return await fallback.getItem(name);
        }
    },
    setItem: async (name, value) => {
        try {
            await getStorage().set("app_state", name, value);
        } catch {
            await fallback.setItem(name, value);
        }
    },
    removeItem: async (name) => {
        try {
            await getStorage().remove("app_state", name);
        } catch {
            await fallback.removeItem(name);
        }
    },
};
