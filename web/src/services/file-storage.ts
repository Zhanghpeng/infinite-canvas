import { nanoid } from "nanoid";

import { getStorage } from "@/lib/storage";

export type UploadedFile = { url: string; storageKey: string; bytes: number; mimeType: string; width?: number; height?: number; durationMs?: number };

const SCOPE = "media_files" as const;
const objectUrls = new Map<string, string>();

/** projectId 传入时，素材会落在该项目目录下（projects/<id>/assets/media/…）；不传则落工作区全局。 */
export async function uploadMediaFile(input: string | Blob, prefix = "file", projectId?: string): Promise<UploadedFile> {
    const blob = typeof input === "string" ? await (await fetch(input)).blob() : input;
    const storageKey = projectId ? `${prefix}:${projectId}:${nanoid()}` : `${prefix}:${nanoid()}`;
    await getStorage().setBlob(SCOPE, storageKey, blob);
    const url = URL.createObjectURL(blob);
    objectUrls.set(storageKey, url);
    const meta = blob.type.startsWith("video/") ? await readVideoMeta(url) : blob.type.startsWith("audio/") ? await readAudioMeta(url) : {};
    return { url, storageKey, bytes: blob.size, mimeType: blob.type || "application/octet-stream", ...meta };
}

export async function resolveMediaUrl(storageKey?: string, fallback = "") {
    if (!storageKey) return fallback;
    const cached = objectUrls.get(storageKey);
    if (cached) return cached;
    const blob = await getStorage().getBlob(SCOPE, storageKey);
    if (!blob) return fallback;
    const url = URL.createObjectURL(blob);
    objectUrls.set(storageKey, url);
    return url;
}

export async function getMediaBlob(storageKey: string) {
    return getStorage().getBlob(SCOPE, storageKey);
}

export async function setMediaBlob(storageKey: string, blob: Blob) {
    await getStorage().setBlob(SCOPE, storageKey, blob);
    const url = URL.createObjectURL(blob);
    objectUrls.set(storageKey, url);
    return url;
}

export async function deleteStoredMedia(keys: Iterable<string>) {
    await Promise.all(
        Array.from(new Set(keys)).map(async (key) => {
            const url = objectUrls.get(key);
            if (url) URL.revokeObjectURL(url);
            objectUrls.delete(key);
            await getStorage().remove(SCOPE, key);
        }),
    );
}

export async function cleanupUnusedMedia(usedData: unknown) {
    const usedKeys = collectMediaStorageKeys(usedData);
    const unused = (await getStorage().keys(SCOPE)).filter((key) => !usedKeys.has(key));
    await Promise.all(unused.map((key) => getStorage().remove(SCOPE, key)));
}

export function collectMediaStorageKeys(value: unknown, keys = new Set<string>()) {
    if (!value || typeof value !== "object") return keys;
    if ("storageKey" in value && typeof value.storageKey === "string" && value.storageKey.includes(":")) keys.add(value.storageKey);
    Object.values(value).forEach((item) => (Array.isArray(item) ? item.forEach((child) => collectMediaStorageKeys(child, keys)) : collectMediaStorageKeys(item, keys)));
    return keys;
}

function readVideoMeta(url: string) {
    return new Promise<{ width: number; height: number; durationMs?: number }>((resolve) => {
        const video = document.createElement("video");
        const done = () => resolve({ width: video.videoWidth || 1280, height: video.videoHeight || 720, durationMs: Number.isFinite(video.duration) ? Math.round(video.duration * 1000) : undefined });
        video.onloadedmetadata = done;
        video.onerror = done;
        video.src = url;
    });
}

function readAudioMeta(url: string) {
    return new Promise<{ durationMs?: number }>((resolve) => {
        const audio = document.createElement("audio");
        audio.preload = "metadata";
        let settled = false;
        const done = () => {
            if (settled) return;
            settled = true;
            resolve({ durationMs: Number.isFinite(audio.duration) ? Math.round(audio.duration * 1000) : undefined });
        };
        const timer = setTimeout(done, 3000);
        audio.onloadedmetadata = () => {
            clearTimeout(timer);
            done();
        };
        audio.onerror = () => {
            clearTimeout(timer);
            done();
        };
        audio.src = url;
    });
}
