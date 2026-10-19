// 存储抽象层：统一 scope 与后端接口，让浏览器(IndexedDB)与本地文件系统两种后端可互换。
// 调用方只依赖 StorageBackend 接口，不直接依赖具体后端实现。

export type StorageScope =
    | "app_state" // 通用配置与 zustand persist 的 JSON 字符串
    | "image_files" // 图片 blob
    | "media_files" // 视频 / 音频 blob
    | "image_previews" // 图片缩略图
    | "image_logs" // 生图工作台生成日志
    | "video_logs"; // 视频创作台生成日志

export type StorageKind = "indexeddb" | "local";

// 一条存储记录。value 可能是可序列化对象，也可能是 Blob。
export type StorageEntry<T = unknown> = { key: string; value: T };

export interface StorageBackend {
    readonly kind: StorageKind;
    // 后端当前是否可用（本地模式用它探测本地服务是否已启动）。
    isAvailable(): Promise<boolean>;

    // 通用读写：value 为 JSON 可序列化对象；getBlob/setBlob 语义一致，仅用于二进制。
    get<T = unknown>(scope: StorageScope, key: string): Promise<T | null>;
    set<T = unknown>(scope: StorageScope, key: string, value: T): Promise<void>;
    remove(scope: StorageScope, key: string): Promise<void>;
    clear(scope: StorageScope): Promise<void>;
    entries<T = unknown>(scope: StorageScope): Promise<Array<StorageEntry<T>>>;
    // 仅列键，避免为了清理等场景把 blob 内容也读出来。
    keys(scope: StorageScope): Promise<string[]>;

    // Blob 专用：本地后端据此区分二进制落盘与 JSON 落盘。
    getBlob(scope: StorageScope, key: string): Promise<Blob | null>;
    setBlob(scope: StorageScope, key: string, blob: Blob): Promise<void>;
    removeBlob(scope: StorageScope, key: string): Promise<void>;

    // 工作区路径级操作：用于 projects/、workspace.json 等不适用 scope+key 的结构。
    // 仅在本地后端可用（浏览器后端调用会抛错）。
    readPath(path: string): Promise<Blob | null>;
    writePath(path: string, data: Blob | string): Promise<void>;
    deletePath(path: string): Promise<void>;
    listPath(dir: string): Promise<Array<{ path: string; directory: boolean }>>;
    movePath(from: string, to: string): Promise<void>;
}
