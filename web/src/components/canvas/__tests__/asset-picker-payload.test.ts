import { describe, expect, it } from "vitest";

import { toBundleEntries, toLeafPayload } from "@/components/canvas/asset-picker-modal";
import type { Asset, AudioAsset, BundleAsset, ImageAsset, TextAsset, VideoAsset } from "@/stores/use-asset-store";

const base = { title: "", coverUrl: "", tags: [] as string[], createdAt: "", updatedAt: "" };

function text(id: string, content = id): TextAsset {
    return { ...base, id, kind: "text", title: id, data: { content } };
}
function image(id: string): ImageAsset {
    return { ...base, id, kind: "image", title: id, data: { dataUrl: `${id}-url`, storageKey: `image:${id}`, width: 2, height: 3, bytes: 4, mimeType: "image/png" } };
}
function video(id: string): VideoAsset {
    return { ...base, id, kind: "video", title: id, data: { url: `${id}-url`, storageKey: `video:${id}`, width: 1280, height: 720, bytes: 5, mimeType: "video/mp4" } };
}
function audio(id: string): AudioAsset {
    return { ...base, id, kind: "audio", title: id, data: { url: `${id}-url`, storageKey: `audio:${id}`, durationMs: 1200, bytes: 6, mimeType: "audio/mpeg" } };
}
function bundle(id: string, items: Array<{ assetId: string; slot: BundleAsset["data"]["items"][number]["slot"]; order: number }>): BundleAsset {
    return { ...base, id, kind: "bundle", title: id, data: { items } };
}

describe("toLeafPayload", () => {
    it("maps each leaf asset kind to its insert payload", () => {
        expect(toLeafPayload(text("t", "hello"))).toEqual({ kind: "text", content: "hello", title: "t" });
        expect(toLeafPayload(image("i"))).toEqual({ kind: "image", dataUrl: "i-url", storageKey: "image:i", title: "i" });
        expect(toLeafPayload(video("v"))).toMatchObject({ kind: "video", url: "v-url", storageKey: "video:v", width: 1280, height: 720 });
        expect(toLeafPayload(audio("a"))).toMatchObject({ kind: "audio", url: "a-url", storageKey: "audio:a", durationMs: 1200 });
    });

    it("returns null for composite bundles", () => {
        expect(toLeafPayload(bundle("b", []))).toBeNull();
    });
});

describe("toBundleEntries", () => {
    const assets: Asset[] = [image("primary"), text("note"), audio("voice")];
    const byId = new Map(assets.map((asset) => [asset.id, asset]));

    it("resolves entries in order and carries the slot", () => {
        const entries = toBundleEntries(bundle("b", [{ assetId: "note", slot: "reference", order: 1 }, { assetId: "primary", slot: "primary", order: 0 }]), byId);
        expect(entries.map((entry) => [entry.assetId, entry.slot])).toEqual([["primary", "primary"], ["note", "reference"]]);
    });

    it("skips entries whose asset is missing or unsupported", () => {
        const entries = toBundleEntries(bundle("b", [{ assetId: "voice", slot: "voice", order: 0 }, { assetId: "gone", slot: "outfit", order: 1 }]), byId);
        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatchObject({ assetId: "voice", slot: "voice" });
    });

    it("does not mutate the stored item order", () => {
        const source = bundle("b", [{ assetId: "note", slot: "reference", order: 1 }, { assetId: "primary", slot: "primary", order: 0 }]);
        toBundleEntries(source, byId);
        expect(source.data.items.map((item) => item.assetId)).toEqual(["note", "primary"]);
    });
});
