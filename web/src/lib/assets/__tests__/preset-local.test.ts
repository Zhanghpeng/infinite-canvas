import { describe, expect, it } from "vitest";

import { preferLocalPreset, presetRelFromUrl } from "@/lib/assets/preset-local";

/**
 * 预设图的本地镜像：脚本把 CDN 目录原样拉到 `web/public/system-presets/`，
 * 前端命中同一相对路径就换同源地址。这条链路一旦拼错，图会静默 404（同源 404 不会回落 CDN）。
 */
describe("预设资产本地镜像取址", () => {
    it("命中清单走同源，未命中保持 CDN", () => {
        const local = new Set(["pose/img/full_sexy_P001_diag.png"]);
        expect(preferLocalPreset(local, "pose/img/full_sexy_P001_diag.png", "https://cdn.example.com/x.png")).toBe("/system-presets/pose/img/full_sexy_P001_diag.png");
        expect(preferLocalPreset(local, "pose/img/other.png", "https://cdn.example.com/x.png")).toBe("https://cdn.example.com/x.png");
    });

    it("空清单（没拉过镜像）时全部回落 CDN", () => {
        const remote = "https://ai-pose-gallery.pages.dev/img/full_single_P001_front.png";
        expect(preferLocalPreset(new Set(), "pose/img/full_single_P001_front.png", remote)).toBe(remote);
    });

    it("远端 URL 按 pathname 镜像，保留 CDN 自己的目录层级", () => {
        expect(presetRelFromUrl("anime", "https://charadb-2fi.pages.dev/thumb/H001.webp")).toBe("anime/thumb/H001.webp");
        expect(presetRelFromUrl("portrait", "https://ai-portrait-gallery.pages.dev/img/full/f71f980dde3.png")).toBe("portrait/img/full/f71f980dde3.png");
    });

    it("非法地址不会拼出奇怪的相对路径", () => {
        expect(presetRelFromUrl("anime", "not-a-url")).toBe("");
    });
});
