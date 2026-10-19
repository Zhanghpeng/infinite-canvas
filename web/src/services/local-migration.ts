import { getStorage } from "@/lib/storage";
import { IndexedDbBackend } from "@/lib/storage/indexeddb-backend";
import { writeWorkspaceCanvas, type CanvasPersistedState } from "@/lib/storage/local-canvas-storage";
import type { StorageScope } from "@/lib/storage/types";

// 浏览器模式 → 本地模式的显式迁移。
//
// 关键点：
// - 迁移是「复制」而不是「移动」：浏览器(IndexedDB)侧数据原样保留，用户随时可切回。
// - 只走已有文件 API，不新增服务端点。
// - 缩略图(image_previews)是可再生缓存，不迁移，切到本地模式后按需重建。

const APP_STATE_KEYS = ["infinite-canvas:asset_store", "infinite-canvas:plugin_store"];
const CANVAS_STORE_KEY = "infinite-canvas:canvas_store";
const BLOB_SCOPES: StorageScope[] = ["image_files", "media_files"];
const JSON_SCOPES: StorageScope[] = ["image_logs", "video_logs"];

export type MigrationSummary = {
    projects: number;
    appStateKeys: number;
    blobs: number;
    logs: number;
};

export class MigrationError extends Error {}

function assertLocalTarget() {
    if (getStorage().kind !== "local") {
        throw new MigrationError("当前不是本地模式，无法迁移到本地工作区");
    }
}

// 判断浏览器侧是否还有可供迁移的数据。
export async function hasBrowserData(): Promise<boolean> {
    const source = new IndexedDbBackend();
    const canvas = await source.get<string>("app_state", CANVAS_STORE_KEY);
    if (canvas) return true;
    for (const scope of [...BLOB_SCOPES, ...JSON_SCOPES]) {
        const keys = await source.keys(scope);
        if (keys.length) return true;
    }
    const appStateKeys = await Promise.all(APP_STATE_KEYS.map((key) => source.get<string>("app_state", key)));
    return appStateKeys.some(Boolean);
}

export async function migrateBrowserDataToLocal(): Promise<MigrationSummary> {
    assertLocalTarget();
    const source = new IndexedDbBackend();
    const target = getStorage();

    let projects = 0;
    let appStateKeys = 0;
    let blobs = 0;
    let logs = 0;

    // 1) 画布：解析原整包 canvas_store，落盘为「一项目一文件 + 工作区索引」。
    const canvasRaw = await source.get<string>("app_state", CANVAS_STORE_KEY);
    if (canvasRaw) {
        try {
            const parsed = JSON.parse(canvasRaw) as { state?: Partial<CanvasPersistedState> };
            const state: CanvasPersistedState = { projects: parsed.state?.projects || [], deletedProjects: parsed.state?.deletedProjects || [] };
            await writeWorkspaceCanvas(state);
            projects = state.projects.length;
        } catch (error) {
            throw new MigrationError(`画布数据解析失败，已中止迁移：${error instanceof Error ? error.message : String(error)}`);
        }
    }

    // 2) 其余整包状态（我的资产、已装插件）走 app_state，直接按键复制。
    for (const key of APP_STATE_KEYS) {
        const value = await source.get<string>("app_state", key);
        if (!value) continue;
        await target.set("app_state", key, value);
        appStateKeys += 1;
    }

    // 3) 媒体 blob 按 key 逐个复制。
    for (const scope of BLOB_SCOPES) {
        const keys = await source.keys(scope);
        for (const key of keys) {
            const blob = await source.getBlob(scope, key);
            if (!blob) continue;
            await target.setBlob(scope, key, blob);
            blobs += 1;
        }
    }

    // 4) 生成日志（JSON）。
    for (const scope of JSON_SCOPES) {
        const keys = await source.keys(scope);
        for (const key of keys) {
            const value = await source.get(scope, key);
            if (value === null || value === undefined) continue;
            await target.set(scope, key, value);
            logs += 1;
        }
    }

    return { projects, appStateKeys, blobs, logs };
}
