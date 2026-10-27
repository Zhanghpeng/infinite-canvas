import { describe, expect, it } from "vitest";

import { assetIdentityKeys, findDuplicateAsset, mergeIntoExisting } from "@/lib/canvas/asset-dedupe";

const image = (id: string, storageKey?: string, dataUrl = "") => ({ id, kind: "image" as const, tags: [] as string[], data: { dataUrl, storageKey } });
const text = (id: string, content: string) => ({ id, kind: "text" as const, tags: [] as string[], data: { content } });
const video = (id: string, storageKey?: string, url = "") => ({ id, kind: "video" as const, tags: [] as string[], data: { url, storageKey } });
const bundle = (id: string, items: Array<{ assetId: string; slot: string }>) => ({ id, kind: "bundle" as const, tags: [] as string[], data: { items } });

describe("资产去重", () => {
    it("图片按存储键判同一条", () => {
        const library = [image("a", "image:abc")];
        expect(findDuplicateAsset(library, image("a2", "image:abc"))?.id).toBe("a");
        expect(findDuplicateAsset(library, image("a2", "image:other"))).toBeUndefined();
    });

    it("只有内联内容的图也能对上（老数据没有存储键）", () => {
        const library = [image("a", undefined, "data:image/png;base64,AAA")];
        expect(findDuplicateAsset(library, image("a2", undefined, "data:image/png;base64,AAA"))?.id).toBe("a");
        expect(findDuplicateAsset(library, image("a2", undefined, "data:image/png;base64,BBB"))).toBeUndefined();
    });

    it("已落盘的图与同内容的内联图不会互相看不见", () => {
        // 两条键：存储键 + 内联内容。任一条相交就算同一条 —— 这正是"先存 dataUrl 后升级成文件"的场景。
        const library = [{ id: "a", kind: "image" as const, tags: [], data: { dataUrl: "data:image/png;base64,AAA", storageKey: "image:abc" } }];
        expect(findDuplicateAsset(library, image("a2", "image:abc"))?.id).toBe("a");
        expect(findDuplicateAsset(library, image("a2", undefined, "data:image/png;base64,AAA"))?.id).toBe("a");
    });

    it("文本按正文判同一条，首尾空白不计", () => {
        const library = [text("a", "一只猫在雪地里跑")];
        expect(findDuplicateAsset(library, text("a2", "  一只猫在雪地里跑\n"))?.id).toBe("a");
        expect(findDuplicateAsset(library, text("a2", "一只狗在雪地里跑"))).toBeUndefined();
    });

    it("视频/音频按存储键判同一条", () => {
        const library = [video("a", "video:xyz")];
        expect(findDuplicateAsset(library, video("a2", "video:xyz"))?.id).toBe("a");
        expect(findDuplicateAsset(library, video("a2", "video:other"))).toBeUndefined();
    });

    it("光有 url 不算身份：blob:/https: 都只是地址", () => {
        // blob: 每次 createObjectURL 都不同，https: 只是来源地址 —— 两者都不能证明是同一份字节。
        expect(findDuplicateAsset([video("b", undefined, "blob:http://x/y")], video("b2", undefined, "blob:http://x/y"))).toBeUndefined();
        expect(findDuplicateAsset([video("c", undefined, "https://x/y.mp4")], video("c2", undefined, "https://x/y.mp4"))).toBeUndefined();
    });

    it("组合按成员与槽位集合判同一条，顺序无关", () => {
        const library = [bundle("a", [{ assetId: "x", slot: "primary" }, { assetId: "y", slot: "reference" }])];
        expect(findDuplicateAsset(library, bundle("a2", [{ assetId: "y", slot: "reference" }, { assetId: "x", slot: "primary" }]))?.id).toBe("a");
        // 槽位变了就是另一个组合：同一个素材当主图还是当参考，是两种用法。
        expect(findDuplicateAsset(library, bundle("a2", [{ assetId: "x", slot: "reference" }, { assetId: "y", slot: "reference" }]))).toBeUndefined();
        // 成员全失效的组合不参与去重，避免把新组合并进一个空壳。
        expect(findDuplicateAsset([bundle("empty", [])], bundle("a2", []))).toBeUndefined();
    });

    it("不同类别互不干扰", () => {
        const library = [text("a", "image:abc")];
        expect(findDuplicateAsset(library, image("b", "image:abc"))).toBeUndefined();
    });

    it("无法判身份（既无存储键也无内联内容）时不当作重复", () => {
        expect(assetIdentityKeys({ kind: "image", data: {} })).toEqual([]);
        expect(findDuplicateAsset([{ id: "a", kind: "image", tags: [], data: {} }], { kind: "image", data: {} })).toBeUndefined();
    });

    it("命中时并标签，标题留给用户", () => {
        const existing = { id: "a", title: "我改过的名字", tags: ["猫"], source: "", note: "" };
        const merged = mergeIntoExisting(existing, { tags: ["猫", "雪"], source: "Canvas", note: "备注" });
        expect(merged).toMatchObject({ id: "a", title: "我改过的名字", tags: ["猫", "雪"], source: "Canvas", note: "备注" });
    });
});
