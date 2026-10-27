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

    // 这个键是否已经有文件。媒体键按内容指纹命名后，写入前先问一句就能跳过整份重写
    // （200MB 的成片重复入库不该再压一次盘）。不实现就用"直接覆盖写"兜底 —— 同键覆盖本身也不会膨胀。
    hasBlob?(scope: StorageScope, key: string): Promise<boolean>;

    // 媒体直链：给 <img>/<video>/<audio> 用的可流式 URL。
    // 返回 null 表示该后端拿不到直链（IndexedDB / 目录句柄），只能读成 Blob 再转 objectURL。
    // 存在的意义：视频动辄上百 MB，读成 Blob 会把整份字节搬进 JS 堆，且无法 Range 播放。
    mediaUrl?(scope: StorageScope, key: string): Promise<string | null>;

    // 工作区路径级操作：用于 projects/、workspace.json 等不适用 scope+key 的结构。
    // 仅在本地后端可用（浏览器后端调用会抛错）。
    readPath(path: string): Promise<Blob | null>;
    writePath(path: string, data: Blob | string): Promise<void>;
    deletePath(path: string): Promise<void>;
    listPath(dir: string): Promise<Array<{ path: string; directory: boolean }>>;
    movePath(from: string, to: string): Promise<void>;
}
