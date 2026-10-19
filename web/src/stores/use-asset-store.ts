import { create } from "zustand";
import { persist, type PersistStorage, type StorageValue } from "zustand/middleware";

import type { CanvasConnectionKind, CanvasFrameSlot } from "@/types/canvas";
import { nanoid } from "nanoid";
import { localForageStorage } from "@/lib/localforage-storage";
import { cleanupUnusedImages, resolveImageUrl, uploadImage } from "@/services/image-storage";
import { cleanupUnusedMedia, resolveMediaUrl } from "@/services/file-storage";

export type AssetKind = "text" | "image" | "video" | "audio" | "bundle";
export type TextAsset = AssetBase<"text"> & { data: { content: string } };
export type ImageAsset = AssetBase<"image"> & { data: { dataUrl: string; storageKey?: string; width: number; height: number; bytes: number; mimeType: string } };
export type VideoAsset = AssetBase<"video"> & { data: { url: string; storageKey?: string; width: number; height: number; bytes: number; mimeType: string } };
export type AudioAsset = AssetBase<"audio"> & { data: { url: string; storageKey?: string; bytes: number; mimeType: string; durationMs?: number } };
/** 组合资产（如"一个角色"）里的条目槽位。 */
export type BundleSlot = "primary" | "outfit" | "accessory" | "voice" | "reference";
/**
 * 组合资产里的一个条目：只存被引用资产的 id，不复制素材。
 * position = 组内相对偏移（相对包围盒左上角），size = 原节点宽高 —— 两者一起才能在别的画布里 1:1 还原布局；
 * 只存偏移的话，插入端会按默认尺寸/图片原始分辨率重算节点大小，把原本紧凑的排布撑爆成堆叠。
 */
export type BundleItem = { assetId: string; slot: BundleSlot; order: number; position?: { x: number; y: number }; size?: { width: number; height: number } };
/**
 * 组合内部成员之间的连线（input / lineage）。用被引用资产的 assetId 而非原始画布节点 id 来记录，
 * 这样组合自洽、导入/导出重映射资产 id 时连线也能跟着改。插入组合时再把它还原成画布内的 CanvasConnection。
 */
export type BundleConnection = { fromAssetId: string; toAssetId: string; kind: CanvasConnectionKind; slot?: CanvasFrameSlot };
export type BundleAsset = AssetBase<"bundle"> & { data: { items: BundleItem[]; coverAssetId?: string; connections?: BundleConnection[] } };
export type Asset = TextAsset | ImageAsset | VideoAsset | AudioAsset | BundleAsset;

/** 组合资产的封面：优先用显式指定的封面条目，否则取第一个有条目封面的资产。 */
export function resolveBundleCover(bundle: BundleAsset, assets: Asset[]): string {
    const ordered = [...bundle.data.items].sort((a, b) => a.order - b.order);
    const byId = new Map(assets.map((asset) => [asset.id, asset]));
    const preferred = bundle.data.coverAssetId ? byId.get(bundle.data.coverAssetId) : undefined;
    const candidates = preferred ? [preferred, ...ordered.map((item) => byId.get(item.assetId))] : ordered.map((item) => byId.get(item.assetId));
    for (const candidate of candidates) {
        if (!candidate) continue;
        if (candidate.kind === "image") return candidate.coverUrl || candidate.data.dataUrl;
        if (candidate.coverUrl) return candidate.coverUrl;
    }
    return "";
}

type AssetBase<T extends AssetKind> = {
    id: string;
    kind: T;
    title: string;
    coverUrl: string;
    tags: string[];
    source?: string;
    note?: string;
    createdAt: string;
    updatedAt: string;
    metadata?: Record<string, unknown>;
};

type AssetStore = {
    hydrated: boolean;
    assets: Asset[];
    addAsset: (asset: Omit<Asset, "id" | "createdAt" | "updatedAt">) => string;
    updateAsset: (id: string, patch: Partial<Omit<Asset, "id" | "createdAt">>) => void;
    removeAsset: (id: string) => void;
    removeAssets: (ids: string[]) => void;
    replaceAssets: (assets: Asset[]) => void;
    cleanupImages: (extra?: unknown) => void;
};

const ASSET_STORE_KEY = "infinite-canvas:asset_store";

const assetStorage: PersistStorage<AssetStore> = {
    getItem: async (name) => {
        const value = await localForageStorage.getItem(name);
        if (!value) return null;
        const parsed = JSON.parse(value) as StorageValue<AssetStore>;
        parsed.state.assets = await Promise.all(
            parsed.state.assets.map(async (asset): Promise<Asset> => {
                if (asset.kind === "video" && asset.data.storageKey) return { ...asset, data: { ...asset.data, url: await resolveMediaUrl(asset.data.storageKey, asset.data.url) } };
                if (asset.kind === "audio" && asset.data.storageKey) return { ...asset, data: { ...asset.data, url: await resolveMediaUrl(asset.data.storageKey, asset.data.url) } };
                if (asset.kind !== "image") return asset;
                if (asset.data.storageKey)
                    return {
                        ...asset,
                        coverUrl: asset.coverUrl.startsWith("blob:") ? await resolveImageUrl(asset.data.storageKey, asset.coverUrl) : asset.coverUrl,
                        data: { ...asset.data, dataUrl: await resolveImageUrl(asset.data.storageKey, asset.data.dataUrl) },
                    };
                if (!asset.data.dataUrl.startsWith("data:image/")) return asset;
                const image = await uploadImage(asset.data.dataUrl);
                return { ...asset, coverUrl: asset.coverUrl.startsWith("data:image/") ? image.url : asset.coverUrl, data: { ...asset.data, dataUrl: image.url, storageKey: image.storageKey, bytes: image.bytes, mimeType: image.mimeType } };
            }),
        );
        return parsed;
    },
    setItem: (name, value) => localForageStorage.setItem(name, JSON.stringify(value)),
    removeItem: (name) => localForageStorage.removeItem(name),
};

export const useAssetStore = create<AssetStore>()(
    persist(
        (set, get) => ({
            hydrated: false,
            assets: [],
            addAsset: (asset) => {
                const now = new Date().toISOString();
                const id = nanoid();
                set((state) => ({ assets: [{ ...asset, id, createdAt: now, updatedAt: now } as Asset, ...state.assets] }));
                return id;
            },
            updateAsset: (id, patch) =>
                set((state) => ({
                    assets: state.assets.map((asset) => (asset.id === id ? ({ ...asset, ...patch, updatedAt: new Date().toISOString() } as Asset) : asset)),
                })),
            removeAsset: (id) =>
                set((state) => {
                    const assets = state.assets.filter((asset) => asset.id !== id);
                    get().cleanupImages({ assets });
                    return { assets };
                }),
            removeAssets: (ids) =>
                set((state) => {
                    const removing = new Set(ids);
                    const assets = state.assets.filter((asset) => !removing.has(asset.id));
                    get().cleanupImages({ assets });
                    return { assets };
                }),
            replaceAssets: (assets) => set({ assets }),
            cleanupImages: (extra) => {
                window.setTimeout(async () => {
                    const { useCanvasStore } = await import("@/stores/canvas/use-canvas-store");
                    await cleanupUnusedImages({ assets: get().assets, projects: useCanvasStore.getState().projects, extra });
                    await cleanupUnusedMedia({ assets: get().assets, projects: useCanvasStore.getState().projects, extra });
                }, 0);
            },
        }),
        {
            name: ASSET_STORE_KEY,
            storage: assetStorage,
            partialize: (state) => ({ assets: state.assets }) as StorageValue<AssetStore>["state"],
            onRehydrateStorage: () => () => {
                useAssetStore.setState({ hydrated: true });
            },
        },
    ),
);
