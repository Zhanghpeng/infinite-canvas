import { describe, expect, it } from "vitest";

import { remapBundleIds } from "@/pages/assets/asset-transfer";
import type { BundleAsset } from "@/stores/use-asset-store";

function bundle(items: Array<{ assetId: string; order: number }>, coverAssetId?: string): BundleAsset {
    return { id: "b1", kind: "bundle", title: "b1", coverUrl: "", tags: [], createdAt: "", updatedAt: "", data: { items: items.map((item) => ({ ...item, slot: "reference" })), coverAssetId } };
}

describe("remapBundleIds", () => {
    it("points items and cover at the newly assigned ids", () => {
        const map = new Map([["old-a", "new-a"], ["old-c", "new-c"]]);
        const result = remapBundleIds(bundle([{ assetId: "old-c", order: 9 }, { assetId: "old-a", order: 3 }], "old-a"), map);
        expect(result.data.items.map((item) => item.assetId)).toEqual(["new-c", "new-a"]);
        expect(result.data.items.map((item) => item.order)).toEqual([0, 1]); // order 重排为连续
        expect(result.data.coverAssetId).toBe("new-a");
    });

    it("keeps unresolved ids as-is so the UI can show them as missing", () => {
        const result = remapBundleIds(bundle([{ assetId: "gone", order: 0 }]), new Map());
        expect(result.data.items[0].assetId).toBe("gone");
        expect(result.data.coverAssetId).toBe("gone");
    });
});
