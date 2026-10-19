// 工作区路径级 IO 原语。
// 两个本地后端（本地目录 FSA / 本地服务）各自实现一份，供 blob-store 等共享逻辑复用。

export type PathEntry = { path: string; directory: boolean };

export type PathIo = {
    read: (path: string) => Promise<Blob | null>;
    write: (path: string, data: Blob | string) => Promise<void>;
    remove: (path: string) => Promise<void>;
    list: (dir: string) => Promise<PathEntry[]>;
    move: (from: string, to: string) => Promise<void>;
};
