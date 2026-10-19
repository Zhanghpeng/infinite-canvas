import type { PathIo } from "./path-io";
import { decodeKey, encodeKey, scopeDir, scopeDirForKey } from "./storage-layout";
import type { StorageScope } from "./types";

// 二进制 scope（图片/媒体/缩略图）的共享读写实现。
//
// 目标：文件名 = <可逆 key 主干>.<真实扩展名>，例如 assets/images/image%3a<nanoid>.png。
// 因为扩展名随写入时的 mime 变化，读取时无法从 key 反推文件名，故按 "stem 前缀" 在目录内定位。
// 目录列表按 scope 缓存，写入/删除后失效——因此不需要额外索引文件，目录始终自描述。

const MIME_EXTENSION: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/avif": "avif",
    "image/bmp": "bmp",
    "image/svg+xml": "svg",
    "video/mp4": "mp4",
    "video/webm": "webm",
    "video/quicktime": "mov",
    "audio/mpeg": "mp3",
    "audio/mp3": "mp3",
    "audio/wav": "wav",
    "audio/x-wav": "wav",
    "audio/ogg": "ogg",
    "audio/mp4": "m4a",
    "audio/aac": "aac",
};

export function extensionFor(mimeType?: string): string {
    const mime = (mimeType || "").toLowerCase().split(";")[0].trim();
    if (MIME_EXTENSION[mime]) return MIME_EXTENSION[mime];
    const subtype = mime.split("/")[1];
    if (subtype && /^[a-z0-9]{1,5}$/.test(subtype)) return subtype;
    return "bin";
}

// 反向映射：由扩展名还原 mime。
// 本地服务读文件统一返回 application/octet-stream（它不存 mime），
// 若不还原，blob.type 会在本地模式下丢失——<audio>/<video> 拿到的就是无类型 blob。
const EXTENSION_MIME: Record<string, string> = Object.entries(MIME_EXTENSION).reduce<Record<string, string>>((acc, [mime, ext]) => {
    if (!acc[ext]) acc[ext] = mime;
    return acc;
}, {});

export function mimeForFileName(fileName: string): string {
    const ext = fileName.split(".").pop()?.toLowerCase() || "";
    return EXTENSION_MIME[ext] || "application/octet-stream";
}

function withMime(blob: Blob, path: string): Blob {
    if (blob.type && blob.type !== "application/octet-stream") return blob;
    return new Blob([blob], { type: mimeForFileName(path) });
}

export function createBlobStore(io: PathIo) {
    // 列表缓存按「目录」缓存：同一个 scope 可能同时分布在全局目录与各项目目录下。
    const listingCache = new Map<string, string[]>();

    async function fileNames(dir: string): Promise<string[]> {
        const cached = listingCache.get(dir);
        if (cached) return cached;
        const entries = await io.list(dir);
        const names = entries.filter((entry) => !entry.directory).map((entry) => entry.path);
        listingCache.set(dir, names);
        return names;
    }

    // 按 key 主干 + "." 前缀定位既有文件（扩展名未知，故用前缀匹配）。
    async function locate(scope: StorageScope, key: string): Promise<string | null> {
        const dir = scopeDirForKey(scope, key);
        const prefix = `${encodeKey(key)}.`;
        const name = (await fileNames(dir)).find((item) => item.startsWith(prefix));
        return name ? `${dir}/${name}` : null;
    }

    return {
        // 目录可能分布在多处（全局 + 各项目），整体失效最省事也最安全。
        invalidate(_scope: StorageScope) {
            listingCache.clear();
        },

        async getBlob(scope: StorageScope, key: string): Promise<Blob | null> {
            const path = await locate(scope, key);
            if (!path) return null;
            const blob = await io.read(path);
            // 本地服务不保存 mime，按文件扩展名还原，保证 blob.type 与写入时一致。
            return blob ? withMime(blob, path) : null;
        },

        async setBlob(scope: StorageScope, key: string, blob: Blob): Promise<void> {
            const dir = scopeDirForKey(scope, key);
            const stem = encodeKey(key);
            const file = `${dir}/${stem}.${extensionFor(blob.type)}`;
            const existing = await locate(scope, key);
            // 扩展名变化时先删旧文件，避免同名主干残留两份。
            if (existing && existing !== file) await io.remove(existing).catch(() => undefined);
            await io.write(file, blob);
            listingCache.delete(dir);
        },

        async removeBlob(scope: StorageScope, key: string): Promise<void> {
            const path = await locate(scope, key);
            if (!path) return;
            await io.remove(path);
            listingCache.delete(scopeDirForKey(scope, key));
        },

        // 注意：只枚举工作区全局目录；项目目录内的文件不在这里。
        // 因此清理只会清理全局桶（"少删"而非"误删"，是安全的一侧）；读写仍按 key 正常推导到项目目录。
        async keys(scope: StorageScope): Promise<string[]> {
            // 去掉末尾 ".扩展名" 后解码回原始 key。
            return (await fileNames(scopeDir(scope))).map((name) => decodeKey(name.replace(/\.[^./]+$/, "")));
        },

        async clear(scope: StorageScope): Promise<void> {
            const names = await fileNames(scopeDir(scope));
            await Promise.all(names.map((name) => io.remove(`${scopeDir(scope)}/${name}`)));
            listingCache.delete(scopeDir(scope));
        },
    };
}
