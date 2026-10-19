import { describe, expect, it } from "vitest";

import { resolveBundleCover, type Asset, type BundleAsset, type ImageAsset } from "@/stores/use-asset-store";

function image(id: string, cover: string): ImageAsset {
    return { id, kind: "image", title: id, coverUrl: cover, tags: [], createdAt: "", updatedAt: "", data: { dataUrl: `${cover}-full`, width: 1, height: 1, bytes: 1, mimeType: "image/png" } };
}
function bundle(id: string, items: Array<{ assetId: string; order: number }>, coverAssetId?: string): BundleAsset {
    return { id, kind: "bundle", title: id, coverUrl: "", tags: [], createdAt: "", updatedAt: "", data: { items: items.map((item) => ({ ...item, slot: "reference" })), coverAssetId } };
}

describe("resolveBundleCover", () => {
    const assets: Asset[] = [image("a", "cover-a"), image("b", "cover-b"), image("c", "cover-c")];

    it("uses the explicit cover item when set", () => {
        expect(resolveBundleCover(bundle("b1", [{ assetId: "a", order: 0 }, { assetId: "c", order: 1 }], "c"), assets)).toBe("cover-c");
    });

    it("falls back to the first item by order", () => {
        expect(resolveBundleCover(bundle("b2", [{ assetId: "c", order: 1 }, { assetId: "b", order: 0 }]), assets)).toBe("cover-b");
    });

    it("skips missing or cover-less items and returns empty when nothing is usable", () => {
        expect(resolveBundleCover(bundle("b3", [{ assetId: "missing", order: 0 }, { assetId: "a", order: 1 }]), assets)).toBe("cover-a");
        expect(resolveBundleCover(bundle("b4", [{ assetId: "missing", order: 0 }]), assets)).toBe("");
    });
});
