import i18n from "@/i18n";
import { readImageMeta } from "@/lib/image-utils";
import { getStorage } from "@/lib/storage";
import { fingerprintBlob } from "@/lib/storage/content-fingerprint";

export type UploadedImage = {
    url: string;
    storageKey: string;
    width: number;
    height: number;
    bytes: number;
    mimeType: string;
};

const IMAGE_SCOPE = "image_files" as const;
const IMAGE_LOG_SCOPE = "image_logs" as const;
const VIDEO_LOG_SCOPE = "video_logs" as const;
const objectUrls = new Map<string, string>();

/** projectId 传入时，素材会落在该项目目录下（projects/<id>/assets/images/…）；不传则落工作区全局。 */
export async function uploadImage(input: string | Blob, projectId?: string): Promise<UploadedImage> {
    const blob = typeof input === "string" ? await (await fetch(input)).blob() : input;
    // 键 = 内容指纹：同一张图无论从画布、资产库还是 Agent 进来，都落到同一个键上，磁盘只留一份。
    const fingerprint = await fingerprintBlob(blob);
    const storageKey = projectId ? `image:${projectId}:${fingerprint}` : `image:${fingerprint}`;
    const backend = getStorage();
    // 已经在盘上就跳过整份写入：重复收藏同一张图不该再压一次盘。
    if (!backend.hasBlob || !(await backend.hasBlob(IMAGE_SCOPE, storageKey))) await backend.setBlob(IMAGE_SCOPE, storageKey, blob);
    // 字节就在手里，直接给 objectURL，省掉一次"回头再读一遍"的 IO。
    let url = objectUrls.get(storageKey);
    if (!url) {
        url = URL.createObjectURL(blob);
        objectUrls.set(storageKey, url);
    }
    const meta = await readImageMeta(url);
    return { url, storageKey, width: meta.width, height: meta.height, bytes: blob.size, mimeType: blob.type || meta.mimeType };
}

export async function resolveImageUrl(storageKey?: string, fallback = "") {
    if (!storageKey) return fallback;
    const cached = objectUrls.get(storageKey);
    if (cached) return cached;
    // 本地后端给直链：图片交给浏览器自己加载/缓存，不再把整份字节读进 JS 堆。
    // 显示侧不需要 CORS；只有 drawImage 出图的地方要 crossOrigin，已在 loadImage 里统一声明。
    const backend = getStorage();
    const direct = backend.mediaUrl ? await backend.mediaUrl(IMAGE_SCOPE, storageKey) : null;
    if (direct) {
        objectUrls.set(storageKey, direct);
        return direct;
    }
    const blob = await backend.getBlob(IMAGE_SCOPE, storageKey);
    if (!blob) return fallback;
    const url = URL.createObjectURL(blob);
    objectUrls.set(storageKey, url);
    return url;
}

export async function getImageBlob(storageKey: string) {
    return getStorage().getBlob(IMAGE_SCOPE, storageKey);
}

export async function setImageBlob(storageKey: string, blob: Blob) {
    await getStorage().setBlob(IMAGE_SCOPE, storageKey, blob);
    const url = URL.createObjectURL(blob);
    objectUrls.set(storageKey, url);
    return url;
}

export async function imageToDataUrl(image: { url?: string; dataUrl?: string; storageKey?: string }) {
    const url = image.dataUrl || (await resolveImageUrl(image.storageKey, image.url || ""));
    if (!url || url.startsWith("data:")) return url;
    const response = await fetch(url);
    if (!response.ok) throw new Error(i18n.t("common.imageReadFailed"));
    return blobToDataUrl(await response.blob());
}

export async function deleteStoredImages(keys: Iterable<string>) {
    await Promise.all(
        Array.from(new Set(keys)).map(async (key) => {
            const url = objectUrls.get(key);
            if (url) URL.revokeObjectURL(url);
            objectUrls.delete(key);
            await getStorage().remove(IMAGE_SCOPE, key);
        }),
    );
}

export async function cleanupUnusedImages(usedData: unknown) {
    const usedKeys = collectImageStorageKeys(usedData);
    await Promise.all([
        getStorage()
            .entries<unknown>(IMAGE_LOG_SCOPE)
            .then((items) => items.forEach((entry) => collectImageStorageKeys(entry.value, usedKeys))),
        getStorage()
            .entries<unknown>(VIDEO_LOG_SCOPE)
            .then((items) => items.forEach((entry) => collectImageStorageKeys(entry.value, usedKeys))),
    ]);
    const unused = (await getStorage().keys(IMAGE_SCOPE)).filter((key) => !usedKeys.has(key));
    await deleteStoredImages(unused);
}

export function collectImageStorageKeys(value: unknown, keys = new Set<string>()) {
    if (!value || typeof value !== "object") return keys;
    if ("storageKey" in value && typeof value.storageKey === "string" && value.storageKey.startsWith("image:")) keys.add(value.storageKey);
    Object.values(value).forEach((item) => (Array.isArray(item) ? item.forEach((child) => collectImageStorageKeys(child, keys)) : collectImageStorageKeys(item, keys)));
    return keys;
}

function blobToDataUrl(blob: Blob) {
    return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(new Error(i18n.t("common.imageReadFailed")));
        reader.readAsDataURL(blob);
    });
}
