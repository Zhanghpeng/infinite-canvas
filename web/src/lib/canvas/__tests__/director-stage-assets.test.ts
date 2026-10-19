// 导演台素材库：索引、判重复用、占用统计、整库备份。
import { describe, expect, it } from "vitest";

// eslint-disable-next-line import/first
import { ASSET_INDEX_KEY, MODEL_PREFIX, countStageAssetUsage, exportStageLibrary, findStageAssetByName, importStageLibrary, listStageAssets, modelStorageKey, readStageAsset, removeStageAsset, renameStageAsset, saveStageAsset, stageAssetTotalBytes } from "../../../../../plugins/canvas/director-stage/src/assets";

function memoryStorage(initial: Record<string, unknown> = {}) {
    const map = new Map(Object.entries(initial));
    return {
        map,
        get: async (key: string) => (map.has(key) ? map.get(key) : null),
        set: async (key: string, value: unknown) => {
            map.set(key, value);
        },
        remove: async (key: string) => {
            map.delete(key);
        },
    };
}

const stageNode = (objects: Array<{ modelKey?: string }>) => ({ type: "director-stage:stage", metadata: { stageState: { objects } } });

describe("导演台素材库", () => {
    it("读索引：空库 / 脏数据一律当空，不抛错", async () => {
        expect(await listStageAssets(memoryStorage() as never)).toEqual([]);
        expect(await listStageAssets(memoryStorage({ [ASSET_INDEX_KEY]: "nope" }) as never)).toEqual([]);
        expect(await listStageAssets(memoryStorage({ [ASSET_INDEX_KEY]: [{ id: "a" }] }) as never)).toEqual([]);
        const ok = [{ id: "a", name: "hero.glb", size: 10, addedAt: 1 }];
        expect(await listStageAssets(memoryStorage({ [ASSET_INDEX_KEY]: ok }) as never)).toHaveLength(1);
    });

    it("登记幂等；同名同大小按判重命中；总量可算", async () => {
        const storage = memoryStorage();
        await saveStageAsset(storage as never, { id: "a", name: "hero.glb", size: 100, addedAt: 1 });
        await saveStageAsset(storage as never, { id: "a", name: "hero.glb", size: 100, addedAt: 1 });
        const assets = await saveStageAsset(storage as never, { id: "b", name: "sofa.glb", size: 300, addedAt: 2 });
        expect(assets.map((asset) => asset.id)).toEqual(["a", "b"]);
        expect(stageAssetTotalBytes(assets)).toBe(400);
        expect(findStageAssetByName(assets, "hero.glb", 100)?.id).toBe("a");
        // 同名不同大小不算同一份
        expect(findStageAssetByName(assets, "hero.glb", 101)).toBeNull();
    });

    it("改名字只改索引；删除会连字节一起删", async () => {
        const storage = memoryStorage({ [modelStorageKey("a")]: { name: "hero.glb", base64: "AAA" } });
        await saveStageAsset(storage as never, { id: "a", name: "hero.glb", size: 3, addedAt: 1 });
        expect((await renameStageAsset(storage as never, "a", "  主角.glb  "))[0].name).toBe("主角.glb");
        // 空名字不生效
        expect((await renameStageAsset(storage as never, "a", "   "))[0].name).toBe("主角.glb");

        expect(await readStageAsset(storage as never, "a")).toMatchObject({ base64: "AAA" });
        const left = await removeStageAsset(storage as never, "a");
        expect(left).toEqual([]);
        expect(storage.map.has(modelStorageKey("a"))).toBe(false);
        expect(await readStageAsset(storage as never, "a")).toBeNull();
    });

    it("占用统计扫的是画布上所有导演台节点", () => {
        const nodes = [stageNode([{ modelKey: "a" }, { modelKey: "b" }]), stageNode([{ modelKey: "a" }]), { type: "text", metadata: { stageState: { objects: [{ modelKey: "a" }] } } }];
        expect(countStageAssetUsage("a", nodes)).toBe(2);
        expect(countStageAssetUsage("b", nodes)).toBe(1);
        expect(countStageAssetUsage("c", nodes)).toBe(0);
        expect(countStageAssetUsage("a", [])).toBe(0);
    });

    it("整库导出/导入：只补没有的 id，不覆盖已有", async () => {
        const storage = memoryStorage({ [modelStorageKey("a")]: { name: "hero.glb", base64: "AAAA" } });
        await saveStageAsset(storage as never, { id: "a", name: "hero.glb", size: 3, addedAt: 1 });
        const backup = await exportStageLibrary(storage as never);
        expect(backup).toMatchObject({ version: 1 });
        expect(backup.assets).toHaveLength(1);

        // 导入到另一个"机器"：a 不存在 → 新增
        const fresh = memoryStorage();
        expect(await importStageLibrary(fresh as never, backup)).toEqual({ added: 1, skipped: 0 });
        expect(await listStageAssets(fresh as never)).toHaveLength(1);
        expect(await readStageAsset(fresh as never, "a")).toMatchObject({ base64: "AAAA" });

        // 再导一次：id 已存在 → 跳过
        expect(await importStageLibrary(fresh as never, backup)).toEqual({ added: 0, skipped: 1 });
        // 非法条目跳过
        expect(await importStageLibrary(fresh as never, { assets: [null, { id: "x" }] })).toEqual({ added: 0, skipped: 2 });
        expect(await importStageLibrary(fresh as never, "nope")).toEqual({ added: 0, skipped: 0 });
    });

    it("存储前缀与物体 modelKey 对得上（metadata 结构零改动）", () => {
        expect(modelStorageKey("abc")).toBe(`${MODEL_PREFIX}abc`);
    });
});
