import { saveAs } from "file-saver";

import { createZip, readZip } from "@/lib/zip";
import { getMediaBlob, setMediaBlob } from "@/services/file-storage";
import { getImageBlob, setImageBlob } from "@/services/image-storage";
import type { Asset, BundleAsset, BundleConnection } from "@/stores/use-asset-store";

type AssetExportFile = {
    app: "infinite-canvas";
    // v1: 只有原子资产；v2: 增加组合(bundle)。解析逻辑对两者都兼容。
    version: 1 | 2;
    exportedAt: string;
    assets: Asset[];
    files: AssetExportItem[];
};

type AssetExportItem = {
    storageKey: string;
    path: string;
    mimeType: string;
    bytes: number;
};

export async function exportAssets(assets: Asset[], filename: string) {
    const files: AssetExportItem[] = [];
    const zipFiles: { name: string; data: BlobPart }[] = [];

    await Promise.all(
        assets.map(async (asset) => {
            if (asset.kind !== "image" && asset.kind !== "video" && asset.kind !== "audio") return;
            const storageKey = asset.data.storageKey;
            if (!storageKey) return;
            const blob = asset.kind === "image" ? await getImageBlob(storageKey) : await getMediaBlob(storageKey);
            if (!blob) return;
            const path = `files/${safeFileName(storageKey)}.${fileExtension(blob.type, asset.kind)}`;
            files.push({ storageKey, path, mimeType: blob.type || asset.data.mimeType, bytes: blob.size });
            zipFiles.push({ name: path, data: blob });
        }),
    );

    const data: AssetExportFile = { app: "infinite-canvas", version: 2, exportedAt: new Date().toISOString(), assets, files };
    const zip = await createZip([{ name: "assets.json", data: JSON.stringify(data, null, 2) }, ...zipFiles]);
    saveAs(zip, filename);
}

export async function readAssetPackage(file: File) {
    const zip = await readZip(file);
    const assetFile = zip.get("assets.json");
    if (!assetFile) throw new Error("missing assets.json");
    const data = JSON.parse(await assetFile.text()) as AssetExportFile;
    await Promise.all(
        data.files.map(async (item) => {
            const blob = zip.get(item.path);
            if (!blob) return;
            const typedBlob = blob.type ? blob : blob.slice(0, blob.size, item.mimeType);
            await (item.storageKey.startsWith("image:") ? setImageBlob(item.storageKey, typedBlob) : setMediaBlob(item.storageKey, typedBlob));
        }),
    );
    return data.assets;
}

/**
 * 导入时把组合条目里的"旧资产 id"换成"新分配的 id"。
 * 找不到映射（包里缺该资产）就保持原样，UI 会显示"条目已失效"，不会静默指向别的资产。
 */
export function remapBundleIds(bundle: BundleAsset, idMap: Map<string, string>): BundleAsset {
    const items = bundle.data.items.map((item, index) => ({ ...item, assetId: idMap.get(item.assetId) || item.assetId, order: index }));
    const coverAssetId = bundle.data.coverAssetId ? idMap.get(bundle.data.coverAssetId) || items[0]?.assetId : items[0]?.assetId;
    // 组合的组内连线也要跟着重映射资产 id，否则导入后会指向错误的节点。
    const connections: BundleConnection[] | undefined = bundle.data.connections?.map((conn) => ({
        ...conn,
        fromAssetId: idMap.get(conn.fromAssetId) || conn.fromAssetId,
        toAssetId: idMap.get(conn.toAssetId) || conn.toAssetId,
    }));
    return { ...bundle, data: { ...bundle.data, items, coverAssetId, ...(connections ? { connections } : {}) } };
}

function safeFileName(value: string) {
    return value.replace(/[\\/:*?"<>|]/g, "_");
}

function fileExtension(mimeType: string, kind: Asset["kind"]) {
    if (mimeType.includes("png")) return "png";
    if (mimeType.includes("jpeg")) return "jpg";
    if (mimeType.includes("webp")) return "webp";
    if (mimeType.includes("gif")) return "gif";
    if (mimeType.includes("mp4")) return kind === "audio" ? "m4a" : "mp4";
    if (mimeType.includes("webm")) return "webm";
    if (mimeType.includes("mpeg")) return "mp3";
    if (mimeType.includes("wav")) return "wav";
    if (mimeType.includes("ogg")) return "ogg";
    if (mimeType.includes("aac")) return "aac";
    if (kind === "image") return "png";
    if (kind === "audio") return "mp3";
    return "bin";
}
