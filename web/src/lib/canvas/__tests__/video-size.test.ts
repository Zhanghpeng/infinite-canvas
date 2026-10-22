import { describe, expect, it } from "vitest";

import { isPixelVideoSize, normalizeVideoSizeValue, parseVideoSize, resolveSegmentVideoSize } from "../video-size";

/**
 * 分段尺寸推导。
 *
 * 这里守的是一条交付约束：整批段必须同尺寸，且方向要跟参考视频一致。
 * 之前的实现直接吃全局 `size`，横屏原片会跑出一列竖屏段（ComfyUI 在 size 认不出来时
 * 默认 544×960），拼回去画幅对不上 —— 用户看到的就是"画面比例没生效"。
 */
describe("resolveSegmentVideoSize", () => {
    it("节点上显式选过尺寸就照用", () => {
        expect(resolveSegmentVideoSize({ size: "1280x736", width: 420, height: 236 })).toBe("1280x736");
    });

    it("显式尺寸里的分隔符大小写/全角都归一", () => {
        expect(resolveSegmentVideoSize({ size: " 960 × 544 ", width: 420, height: 236 })).toBe("960x544");
    });

    it("没选过尺寸时跟随参考视频：横屏", () => {
        expect(resolveSegmentVideoSize({ width: 420, height: 236 })).toBe("960x544");
    });

    it("没选过尺寸时跟随参考视频：竖屏", () => {
        expect(resolveSegmentVideoSize({ width: 236, height: 420 })).toBe("544x960");
    });

    it("比例字符串与 auto 都不当作显式尺寸", () => {
        expect(resolveSegmentVideoSize({ size: "auto", width: 236, height: 420 })).toBe("544x960");
        expect(resolveSegmentVideoSize({ size: "16:9", width: 420, height: 236 })).toBe("960x544");
    });

    it("连方向都判不出来时按横屏给", () => {
        expect(resolveSegmentVideoSize({})).toBe("960x544");
        expect(resolveSegmentVideoSize({ width: 0, height: 0 })).toBe("960x544");
    });
});

describe("isPixelVideoSize", () => {
    it("只认宽x高", () => {
        expect(isPixelVideoSize("960x544")).toBe(true);
        expect(isPixelVideoSize("960×544")).toBe(true);
        expect(isPixelVideoSize("16:9")).toBe(false);
        expect(isPixelVideoSize("auto")).toBe(false);
        expect(isPixelVideoSize(undefined)).toBe(false);
    });
});

describe("parseVideoSize / normalizeVideoSizeValue", () => {
    it("解析出方向与最接近的档位", () => {
        const parsed = parseVideoSize("960x544");
        expect(parsed.aspect).toBe("16:9");
        expect(parsed.width).toBe(960);
        expect(parsed.height).toBe(544);
        expect(parsed.tier.mp).toBe("0.5M");
    });

    it("竖屏尺寸报 9:16", () => {
        expect(parseVideoSize("544x960").aspect).toBe("9:16");
    });

    it("非法尺寸回落到默认档位", () => {
        expect(normalizeVideoSizeValue("16:9")).toBe("544x960");
        expect(normalizeVideoSizeValue("960x544")).toBe("960x544");
    });
});
