import { checkLocalWorkspace, deleteWorkspaceFile, listWorkspaceFiles, readWorkspaceFile, renameWorkspaceFile, writeWorkspaceFile } from "@/services/api/local-workspace";

import { createBlobStore } from "./blob-store";
import type { PathIo } from "./path-io";
import { decodeFileName, isJsonScope, scopeDir, scopeFilePath } from "./storage-layout";
import type { StorageBackend, StorageEntry, StorageScope } from "./types";

// 本地服务后端：把 scope+key 映射到工作区内的文件路径，通过本地服务(local-workspace)读写。
// JSON scope 走固定路径；二进制 scope 走 blob-store（可读文件名 + 动态扩展名）。
export class LocalFsBackend implements StorageBackend {
    readonly kind = "local" as const;

    private readonly io: PathIo;
    private readonly blobs: ReturnType<typeof createBlobStore>;

    constructor(
        private readonly baseUrl: string,
        private readonly token: string,
    ) {
        this.io = {
            read: (path) => readWorkspaceFile(baseUrl, token, path),
            write: (path, data) => writeWorkspaceFile(baseUrl, token, path, data),
            remove: (path) => deleteWorkspaceFile(baseUrl, token, path),
            // 这条链路只用文件名（上层 PathEntry 不带 size），所以不让服务端逐个 stat。
            list: async (dir) => (await listWorkspaceFiles(baseUrl, token, dir, { withStat: false })).map((entry) => ({ path: entry.path, directory: entry.type === "directory" })),
            move: (from, to) => renameWorkspaceFile(baseUrl, token, from, to),
        };
        this.blobs = createBlobStore(this.io);
    }

    async isAvailable() {
        return await checkLocalWorkspace(this.baseUrl, this.token);
    }

    private async readBlob(scope: StorageScope, key: string): Promise<Blob | null> {
        return isJsonScope(scope) ? await this.io.read(scopeFilePath(scope, key)) : await this.blobs.getBlob(scope, key);
    }

    private async writeBlob(scope: StorageScope, key: string, blob: Blob): Promise<void> {
        if (isJsonScope(scope)) await this.io.write(scopeFilePath(scope, key), blob);
        else await this.blobs.setBlob(scope, key, blob);
    }

    private async removeEntry(scope: StorageScope, key: string): Promise<void> {
        if (isJsonScope(scope)) {
            const path = scopeFilePath(scope, key);
            if (await this.io.read(path)) await this.io.remove(path);
            return;
        }
        await this.blobs.removeBlob(scope, key);
    }

    private async listKeys(scope: StorageScope): Promise<string[]> {
        if (!isJsonScope(scope)) return await this.blobs.keys(scope);
        const entries = await this.io.list(scopeDir(scope));
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
        const entries = await this.io.list(dir);
        await Promise.all(entries.filter((entry) => !entry.directory).map((entry) => this.io.remove(`${dir}/${entry.path}`)));
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

    // 媒体直链：让浏览器自己流式加载（支持 Range，可 seek），而不是把整份字节读进 JS 堆。
    // 视频节点最受益：一个 200MB 的成片以前要整份 blob 化才能播放。
    async mediaUrl(scope: StorageScope, key: string): Promise<string | null> {
        if (isJsonScope(scope) || !this.token) return null;
        const path = await this.blobs.filePath(scope, key);
        if (!path) return null;
        const base = this.baseUrl.endsWith("/") ? this.baseUrl : `${this.baseUrl}/`;
        const target = new URL("file", base);
        target.searchParams.set("path", path);
        // <video>/<audio> 无法带自定义请求头，token 只能走 query（服务端两种都认）。
        target.searchParams.set("token", this.token);
        return target.toString();
    }

    async setBlob(scope: StorageScope, key: string, blob: Blob): Promise<void> {
        await this.writeBlob(scope, key, blob);
    }

    async removeBlob(scope: StorageScope, key: string): Promise<void> {
        await this.removeEntry(scope, key);
    }

    async readPath(path: string): Promise<Blob | null> {
        return await this.io.read(path);
    }

    async writePath(path: string, data: Blob | string): Promise<void> {
        await this.io.write(path, data);
    }

    async deletePath(path: string): Promise<void> {
        await this.io.remove(path);
    }

    async listPath(dir: string): Promise<Array<{ path: string; directory: boolean }>> {
        return await this.io.list(dir);
    }

    async movePath(from: string, to: string): Promise<void> {
        await this.io.move(from, to);
    }
}
