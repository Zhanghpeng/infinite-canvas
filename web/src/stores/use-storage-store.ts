import { create } from "zustand";

import { readStoragePrefs, writeStoragePrefs, type StoragePrefs } from "@/lib/storage/storage-prefs";

export type StorageStatus =
    | "browser" // 浏览器模式
    | "directory" // 本地目录(FSA) 已就绪
    | "service" // 本地服务已就绪
    | "directory-unsupported" // 浏览器不支持 FSA（非桌面 Chromium / 非安全上下文）
    | "directory-needs-permission" // 已选目录但权限未授予，需用户重新授权
    | "service-unavailable"; // 本地服务不可达

type StorageStore = StoragePrefs & {
    status: StorageStatus;
    setStatus: (status: StorageStatus) => void;
    update: (patch: Partial<StoragePrefs>) => void;
};

// 存储模式偏好本身存在 localStorage（见 storage-prefs），这里只做读写入口与运行状态。
export const useStorageStore = create<StorageStore>((set) => ({
    ...readStoragePrefs(),
    status: "browser",
    setStatus: (status) => set({ status }),
    update: (patch) => set(writeStoragePrefs(patch)),
}));
