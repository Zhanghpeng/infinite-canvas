import { createBlobStore } from "./blob-store";
import type { PathIo } from "./path-io";
import { decodeFileName, isJsonScope, scopeDir, scopeFilePath } from "./storage-layout";
import type { StorageBackend, StorageEntry, StorageScope } from "./types";

// 本地目录后端（File System Access API）：直接读写用户选定的本地目录，无需任何本地进程。
//
// 与本地服务后端落盘布局完全一致（共用 storage-layout / blob-store），因此两种模式可互换、工作区可迁移。
export class FsaBackend implements StorageBackend {
    readonly kind = "local" as const;

    private readonly io: PathIo;
    private readonly blobs: ReturnType<typeof createBlobStore>;

    constructor(private readonly root: FileSystemDirectoryHandle) {
        this.io = {
            read: (path) => this.readPath(path),
            write: (path, data) => this.writePath(path, data),
            remove: (path) => this.deletePath(path),
            list: (dir) => this.listPath(dir),
            move: (from, to) => this.movePath(from, to),
        };
        this.blobs = createBlobStore(this.io);
    }

    async isAvailable() {
        return (await this.root.queryPermission({ mode: "readwrite" })) === "granted";
    }

    // ---- 路径级原语 ----

    private async walk(segments: string[], create: boolean): Promise<FileSystemDirectoryHandle | null> {
        let handle = this.root;
        for (const segment of segments) {
            try {
                handle = await handle.getDirectoryHandle(segment, { create });
            } catch {
                return null;
            }
        }
        return handle;
    }

    async readPath(path: string): Promise<Blob | null> {
        const { segments, name } = splitPath(path);
        const directory = await this.walk(segments, false);
        if (!directory) return null;
        try {
            const fileHandle = await directory.getFileHandle(name);
            return await fileHandle.getFile();
        } catch {
            return null;
        }
    }

    async writePath(path: string, data: Blob | string): Promise<void> {
        const { segments, name } = splitPath(path);
        const directory = await this.walk(segments, true);
        if (!directory) throw new Error(`无法创建目录：${segments.join("/")}`);
        const fileHandle = await directory.getFileHandle(name, { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(data);
        await writable.close();
    }

    async deletePath(path: string): Promise<void> {
        const { segments, name } = splitPath(path);
        const directory = await this.walk(segments, false);
        if (!directory) return;
        await directory.removeEntry(name, { recursive: true }).catch(() => undefined);
    }

    async listPath(dir: string): Promise<Array<{ path: string; directory: boolean }>> {
        const directory = await this.walk(dir.split("/").filter(Boolean), false);
        if (!directory) return [];
        const result: Array<{ path: string; directory: boolean }> = [];
        for await (const entry of directory.values()) {
            result.push({ path: entry.name, directory: entry.kind === "directory" });
        }
        return result;
    }

    async movePath(from: string, to: string): Promise<void> {
        await this.copyPath(from, to);
        await this.deletePath(from);
    }

    private async copyPath(from: string, to: string): Promise<void> {
        const blob = await this.readPath(from);
        if (blob) {
            await this.writePath(to, blob);
            return;
        }
        for (const entry of await this.listPath(from)) {
            await this.copyPath(`${from}/${entry.path}`, `${to}/${entry.path}`);
        }
    }

    // ---- scope 读写（与 LocalFsBackend 同构） ----

    private async readBlob(scope: StorageScope, key: string): Promise<Blob | null> {
        return isJsonScope(scope) ? await this.readPath(scopeFilePath(scope, key)) : await this.blobs.getBlob(scope, key);
    }

    private async writeBlob(scope: StorageScope, key: string, blob: Blob): Promise<void> {
        if (isJsonScope(scope)) await this.writePath(scopeFilePath(scope, key), blob);
        else await this.blobs.setBlob(scope, key, blob);
    }

    private async removeEntry(scope: StorageScope, key: string): Promise<void> {
        if (isJsonScope(scope)) {
            await this.deletePath(scopeFilePath(scope, key));
            return;
        }
        await this.blobs.removeBlob(scope, key);
    }

    private async listKeys(scope: StorageScope): Promise<string[]> {
        if (!isJsonScope(scope)) return await this.blobs.keys(scope);
        const entries = await this.listPath(scopeDir(scope));
        return entries.filter((entry) => !entry.directory).map((entry) => decodeFileName(scope, entry.path));
    }

    async get<T = unknown>(scope: StorageScope, key: string): Promise<T | null> {
        const blob = await this.readBlob(scope, key);
        if (!blob) return null;
        return JSON.parse(await blob.text()) as T;
    }

    async set<T = unknown>(scope: StorageScope, key: string, value: T): Promise<void> {
        await this.writeBlob(scope, key, new Blob([JSON.stringify(value)], { type: "application/json" }));
    }

    async remove(scope: StorageScope, key: string): Promise<void> {
        await this.removeEntry(scope, key);
    }

    async clear(scope: StorageScope): Promise<void> {
        if (!isJsonScope(scope)) {
            await this.blobs.clear(scope);
            return;
        }
        const dir = scopeDir(scope);
        for (const entry of await this.listPath(dir)) {
            if (!entry.directory) await this.deletePath(`${dir}/${entry.path}`);
        }
    }

    async keys(scope: StorageScope): Promise<string[]> {
        return await this.listKeys(scope);
    }

    async entries<T = unknown>(scope: StorageScope): Promise<Array<StorageEntry<T>>> {
        const keys = await this.listKeys(scope);
        return await Promise.all(
            keys.map(async (key) => {
                const value = await this.get<T>(scope, key);
                return { key, value: value as T };
            }),
        );
    }

    async getBlob(scope: StorageScope, key: string): Promise<Blob | null> {
        return await this.readBlob(scope, key);
    }

    async setBlob(scope: StorageScope, key: string, blob: Blob): Promise<void> {
        await this.writeBlob(scope, key, blob);
    }

    async removeBlob(scope: StorageScope, key: string): Promise<void> {
        await this.removeEntry(scope, key);
    }
}

function splitPath(path: string) {
    const parts = path.split("/").filter(Boolean);
    return { segments: parts.slice(0, -1), name: parts[parts.length - 1] };
}
