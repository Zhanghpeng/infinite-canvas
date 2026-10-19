import localforage from "localforage";
import { nanoid } from "nanoid";

// 本地目录(FSA) 的工作区句柄管理。
//
// FileSystemDirectoryHandle 可被结构化克隆，因此能直接存进 IndexedDB；
// 保留"最近工作区列表"，下次可一键切回（读回句柄后只需一次权限校验，无需重新点选）。

const store = localforage.createInstance({ name: "infinite-canvas", storeName: "fsa_handles" });
const WORKSPACES_KEY = "workspaces";

export type WorkspaceRecord = { id: string; name: string; handle: FileSystemDirectoryHandle; lastOpenedAt: string };
export type WorkspaceSummary = { id: string; name: string; lastOpenedAt: string };

export function isFileSystemAccessSupported(): boolean {
    return typeof window !== "undefined" && typeof window.showDirectoryPicker === "function";
}

// 让用户选目录；需在用户手势（点击）中调用。
export async function pickDirectory(): Promise<FileSystemDirectoryHandle | null> {
    if (!window.showDirectoryPicker) return null;
    return await window.showDirectoryPicker({ id: "infinite-canvas-workspace", mode: "readwrite" });
}

async function readAll(): Promise<Record<string, WorkspaceRecord>> {
    return (await store.getItem<Record<string, WorkspaceRecord>>(WORKSPACES_KEY)) ?? {};
}

export async function listWorkspaces(): Promise<WorkspaceSummary[]> {
    const all = await readAll();
    return Object.values(all)
        .map(({ id, name, lastOpenedAt }) => ({ id, name, lastOpenedAt }))
        .sort((a, b) => b.lastOpenedAt.localeCompare(a.lastOpenedAt));
}

// 记住一个目录（同名目录视为同一个工作区，只更新句柄与时间）；返回其 id 与名称。
export async function rememberWorkspace(handle: FileSystemDirectoryHandle): Promise<WorkspaceSummary> {
    const all = await readAll();
    const existing = Object.values(all).find((item) => item.name === handle.name);
    const id = existing?.id ?? nanoid();
    const lastOpenedAt = new Date().toISOString();
    all[id] = { id, name: handle.name, handle, lastOpenedAt };
    await store.setItem(WORKSPACES_KEY, all);
    return { id, name: handle.name, lastOpenedAt };
}

export async function touchWorkspace(id: string): Promise<void> {
    const all = await readAll();
    if (!all[id]) return;
    all[id].lastOpenedAt = new Date().toISOString();
    await store.setItem(WORKSPACES_KEY, all);
}

export async function forgetWorkspace(id: string): Promise<void> {
    const all = await readAll();
    if (!all[id]) return;
    delete all[id];
    await store.setItem(WORKSPACES_KEY, all);
}

export async function loadWorkspaceHandle(id: string): Promise<FileSystemDirectoryHandle | null> {
    const all = await readAll();
    return all[id]?.handle ?? null;
}

// 校验句柄是否仍被授权；只查询，不弹窗（弹窗必须在用户手势里做）。
export async function hasDirectoryPermission(handle: FileSystemDirectoryHandle): Promise<boolean> {
    return (await handle.queryPermission({ mode: "readwrite" })) === "granted";
}

// 申请权限；可能弹出系统授权框，需在用户手势中调用。
export async function requestDirectoryPermission(handle: FileSystemDirectoryHandle): Promise<boolean> {
    return (await handle.requestPermission({ mode: "readwrite" })) === "granted";
}
