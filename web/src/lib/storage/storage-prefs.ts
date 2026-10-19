// 存储模式偏好。
//
// 这份配置决定"用哪个存储后端"，因此不能存在后端自己里面——否则会出现
// "要读配置才知道用哪个后端，但要读后端才能拿到配置"的循环。
// 它体积极小（几百字节），按项目规范放 localStorage。

// browser  : 浏览器 IndexedDB
// directory: 本地目录（File System Access API，仅桌面 Chromium）
// service  : 本地服务 local-workspace（所有浏览器可用）
export type StorageMode = "browser" | "directory" | "service";

export type StoragePrefs = {
    // 用户是否已明确选择过存储位置（首次引导用；未选择时弹一次引导）。
    configured: boolean;
    mode: StorageMode;
    // directory 模式：当前工作区 id 与展示名（真实路径浏览器不暴露）。
    directoryId: string;
    directoryName: string;
    // service 模式：服务地址与 token。
    serviceUrl: string;
    serviceToken: string;
};

export const DEFAULT_SERVICE_URL = "http://127.0.0.1:17400";
export const STORAGE_PREF_KEY = "infinite-canvas:storage_prefs";

export const DEFAULT_STORAGE_PREFS: StoragePrefs = {
    configured: false,
    mode: "browser",
    directoryId: "",
    directoryName: "",
    serviceUrl: DEFAULT_SERVICE_URL,
    serviceToken: "",
};

export function readStoragePrefs(): StoragePrefs {
    if (typeof window === "undefined") return { ...DEFAULT_STORAGE_PREFS };
    try {
        const raw = window.localStorage.getItem(STORAGE_PREF_KEY);
        if (!raw) return { ...DEFAULT_STORAGE_PREFS };
        return { ...DEFAULT_STORAGE_PREFS, ...(JSON.parse(raw) as Partial<StoragePrefs>) };
    } catch {
        return { ...DEFAULT_STORAGE_PREFS };
    }
}

export function writeStoragePrefs(patch: Partial<StoragePrefs>): StoragePrefs {
    const next = { ...readStoragePrefs(), ...patch };
    if (typeof window !== "undefined") window.localStorage.setItem(STORAGE_PREF_KEY, JSON.stringify(next));
    return next;
}
