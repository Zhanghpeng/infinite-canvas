// 导演台自己的素材库：把导入过的 glb 登记成"可复用的素材"。
//
// 为什么需要：插件的私有存储本来就是**插件级全局**的（宿主按 pluginId 建 localforage 实例），
// 但导入的模型原来只写字节、不留索引 —— 除了当初那个物体，没人知道这份模型存在，
// 于是别的节点/场景只能重导一遍。这里只加一个索引，字节仍存在原来的 `director-stage:model:<id>` 上，
// 并且 id 同时就是物体的 modelKey，所以 stageState 的结构零改动。
import type { PluginStorage } from "@infinite-canvas/plugin-sdk";

export const ASSET_INDEX_KEY = "director-stage:assets:v1";
export const MODEL_PREFIX = "director-stage:model:";
/** 库总量上限：超了就提示，别把 IndexedDB 静默撑爆。 */
export const STAGE_ASSET_BUDGET_BYTES = 200 * 1024 * 1024;

export type StageAsset = { id: string; name: string; size: number; addedAt: number };
/** 存在插件存储里的模型本体（与旧数据同一形状，不迁移）。 */
export type StoredModel = { name: string; base64: string };

export function modelStorageKey(id: string): string {
    return `${MODEL_PREFIX}${id}`;
}

function isStageAsset(value: unknown): value is StageAsset {
    const asset = value as Partial<StageAsset> | null;
    return Boolean(asset && typeof asset === "object" && typeof asset.id === "string" && asset.id && typeof asset.name === "string" && typeof asset.size === "number");
}

/** 读素材索引；读失败/形状不对一律当空库（脏数据不能让大窗口打不开）。 */
export async function listStageAssets(storage: PluginStorage): Promise<StageAsset[]> {
    try {
        const raw = await storage.get<unknown>(ASSET_INDEX_KEY);
        return Array.isArray(raw) ? raw.filter(isStageAsset) : [];
    } catch {
        return [];
    }
}

async function writeIndex(storage: PluginStorage, assets: StageAsset[]): Promise<void> {
    try {
        await storage.set(ASSET_INDEX_KEY, assets);
    } catch {
        // 索引写不进去也不该把 UI 打崩：下次打开会退化成"库是空的"，字节还在。
    }
}

export function stageAssetTotalBytes(assets: StageAsset[]): number {
    return assets.reduce((sum, asset) => sum + (Number.isFinite(asset.size) ? asset.size : 0), 0);
}

/** 同名同大小视为同一份素材（只做判重，不猜"内容是不是同一个"）。 */
export function findStageAssetByName(assets: StageAsset[], name: string, size: number): StageAsset | null {
    return assets.find((asset) => asset.name === name && asset.size === size) ?? null;
}

/** 登记一份素材（幂等：同 id 已存在就原样返回）。 */
export async function saveStageAsset(storage: PluginStorage, entry: { id: string; name: string; size: number; addedAt?: number }): Promise<StageAsset[]> {
    const assets = await listStageAssets(storage);
    if (assets.some((asset) => asset.id === entry.id)) return assets;
    const next = [...assets, { id: entry.id, name: entry.name, size: entry.size, addedAt: entry.addedAt ?? Date.now() }];
    await writeIndex(storage, next);
    return next;
}

/** 从库里删掉一份素材（连同字节）。物体上的引用不动，加载失败由既有报错路径说明。 */
export async function removeStageAsset(storage: PluginStorage, id: string): Promise<StageAsset[]> {
    const next = (await listStageAssets(storage)).filter((asset) => asset.id !== id);
    await writeIndex(storage, next);
    try {
        await storage.remove(modelStorageKey(id));
    } catch {
        // 字节删不掉只是占空间，不影响正确性
    }
    return next;
}

export async function renameStageAsset(storage: PluginStorage, id: string, name: string): Promise<StageAsset[]> {
    const trimmed = name.trim();
    if (!trimmed) return listStageAssets(storage);
    const next = (await listStageAssets(storage)).map((asset) => (asset.id === id ? { ...asset, name: trimmed } : asset));
    await writeIndex(storage, next);
    return next;
}

/** 读一份素材的字节。 */
export async function readStageAsset(storage: PluginStorage, id: string): Promise<StoredModel | null> {
    try {
        const raw = await storage.get<StoredModel>(modelStorageKey(id));
        return raw && typeof raw.base64 === "string" && raw.base64 ? raw : null;
    } catch {
        return null;
    }
}

/** 画布上有多少物体在引用这份素材（删除前提示用）。 */
export function countStageAssetUsage(id: string, nodes: Array<{ type?: string; metadata?: unknown }>): number {
    let count = 0;
    for (const node of nodes) {
        if (!node || node.type !== "director-stage:stage") continue;
        const objects = (node.metadata as { stageState?: { objects?: unknown } } | undefined)?.stageState?.objects;
        if (!Array.isArray(objects)) continue;
        for (const object of objects) {
            if (object && typeof object === "object" && (object as { modelKey?: unknown }).modelKey === id) count += 1;
        }
    }
    return count;
}

export type LibraryBackup = { version: 1; assets: Array<{ id: string; name: string; base64: string }> };

/** 整库导出：让用户自己做的素材能被备份 / 换机器用（只做整库，不做资产管理器）。 */
export async function exportStageLibrary(storage: PluginStorage): Promise<LibraryBackup> {
    const assets: LibraryBackup["assets"] = [];
    for (const asset of await listStageAssets(storage)) {
        const stored = await readStageAsset(storage, asset.id);
        if (stored) assets.push({ id: asset.id, name: asset.name, base64: stored.base64 });
    }
    return { version: 1, assets };
}

/** 整库导入：只补库里没有的 id（不覆盖、不删）。 */
export async function importStageLibrary(storage: PluginStorage, raw: unknown): Promise<{ added: number; skipped: number }> {
    const backup = raw as Partial<LibraryBackup> | null;
    const entries = Array.isArray(backup?.assets) ? backup!.assets! : [];
    const existing = new Set((await listStageAssets(storage)).map((asset) => asset.id));
    let added = 0;
    let skipped = 0;
    for (const entry of entries) {
        if (!entry || typeof entry.id !== "string" || typeof entry.name !== "string" || typeof entry.base64 !== "string" || !entry.base64) {
            skipped += 1;
            continue;
        }
        if (existing.has(entry.id) || (await readStageAsset(storage, entry.id))) {
            skipped += 1;
            continue;
        }
        try {
            const base64 = entry.base64;
            await storage.set(modelStorageKey(entry.id), { name: entry.name, base64 });
            await saveStageAsset(storage, { id: entry.id, name: entry.name, size: Math.round((base64.length * 3) / 4) });
            existing.add(entry.id);
            added += 1;
        } catch {
            skipped += 1;
        }
    }
    return { added, skipped };
}
