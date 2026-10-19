import type { StorageScope } from "./types";

// 存储 scope → 工作区目录/落盘形式的统一映射。
// 本地目录(FSA) 与本地服务(local-workspace) 两种后端共用，保证同一个 scope 在两种模式下落到同一路径。

export type ScopeLayout = { dir: string; ext: string; binary: boolean };

export const LAYOUT_BY_SCOPE: Record<StorageScope, ScopeLayout> = {
    app_state: { dir: "state", ext: ".json", binary: false },
    image_files: { dir: "assets/images", ext: "", binary: true },
    media_files: { dir: "assets/media", ext: "", binary: true },
    image_previews: { dir: ".meta/cache/previews", ext: "", binary: true },
    image_logs: { dir: ".meta/logs/image", ext: ".json", binary: false },
    video_logs: { dir: ".meta/logs/video", ext: ".json", binary: false },
};

// 画布（项目）产出的素材跟着项目目录走。
//
// 键格式约定：`<kind>:<projectId>:<id>` 表示"属于某个项目"；旧键 `<kind>:<id>`（两段）仍落到工作区全局目录。
// 这样既能按项目归档，又完全向后兼容（历史数据不动、不需要迁移）。
const PROJECT_SCOPED_BUCKET: Partial<Record<StorageScope, string>> = {
    image_files: "assets/images",
    media_files: "assets/media",
};

/** 从存储键里取出项目 id；不是项目作用域的键返回空串。 */
export function projectIdFromKey(key: string): string {
    const parts = key.split(":");
    return parts.length >= 3 ? parts[1] : "";
}

/** 该键应当落在哪个目录：项目作用域 → projects/<id>/assets/…，否则沿用 scope 的全局目录。 */
export function scopeDirForKey(scope: StorageScope, key: string): string {
    const bucket = PROJECT_SCOPED_BUCKET[scope];
    const projectId = bucket ? projectIdFromKey(key) : "";
    return projectId ? `projects/${projectId}/${bucket}` : scopeDir(scope);
}

// key 里可能含 ":" 等文件系统不友好字符，做可逆编码；文件名尽量保持可读。
export function encodeKey(key: string) {
    return key.replace(/[^A-Za-z0-9._-]/g, (ch) => `%${ch.charCodeAt(0).toString(16).padStart(2, "0")}`);
}

export function decodeKey(encoded: string) {
    return encoded.replace(/%([0-9a-f]{2})/gi, (_match, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

export function fileNameFor(scope: StorageScope, key: string) {
    return `${encodeKey(key)}${LAYOUT_BY_SCOPE[scope].ext}`;
}

export function decodeFileName(scope: StorageScope, fileName: string) {
    const ext = LAYOUT_BY_SCOPE[scope].ext;
    const stripped = ext && fileName.endsWith(ext) ? fileName.slice(0, -ext.length) : fileName;
    return decodeKey(stripped);
}

export function scopeDir(scope: StorageScope) {
    return LAYOUT_BY_SCOPE[scope].dir;
}

export function scopeDirSegments(scope: StorageScope) {
    return LAYOUT_BY_SCOPE[scope].dir.split("/");
}

export function scopeFilePath(scope: StorageScope, key: string) {
    return `${scopeDir(scope)}/${fileNameFor(scope, key)}`;
}

// JSON scope 用固定 ".json" 扩展名 + 可逆编码 key（配置/日志）；二进制 scope 走 blob-store（动态扩展名）。
export function isJsonScope(scope: StorageScope) {
    return LAYOUT_BY_SCOPE[scope].ext === ".json";
}
