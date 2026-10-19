import { describe, expect, it } from "vitest";

import {
    auditSegmentCoverage,
    detectSceneChanges,
    findMissingRanges,
    formatDuration,
    formatTimecode,
    frameSignature,
    planSegments,
    planSelectionRanges,
    signatureDistance,
    snapToCut,
    type FrameSignature,
} from "../video-timeline";

/** 造一帧纯色 RGBA，方便算签名。 */
function solidFrame(width: number, height: number, luminance: number): Uint8ClampedArray {
    return solidColorFrame(width, height, [luminance, luminance, luminance]);
}

function solidColorFrame(width: number, height: number, [r, g, b]: [number, number, number]): Uint8ClampedArray {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < data.length; i += 4) {
        data[i] = r;
        data[i + 1] = g;
        data[i + 2] = b;
        data[i + 3] = 255;
    }
    return data;
}

function sample(timeMs: number, luminance: number): FrameSignature {
    return { timeMs, signature: frameSignature(solidFrame(64, 36, luminance), 64, 36) };
}

describe("frameSignature", () => {
    it("把整帧压成 RGB 三层网格", () => {
        const signature = frameSignature(solidFrame(64, 36, 128), 64, 36);
        expect(signature.length).toBe(32 * 18 * 3);
        expect(signature.every((value) => Math.abs(value - 128) < 0.5)).toBe(true);
    });

    it("同色帧距离为 0，黑白帧距离为 1", () => {
        const black = frameSignature(solidFrame(64, 36, 0), 64, 36);
        const white = frameSignature(solidFrame(64, 36, 255), 64, 36);
        expect(signatureDistance(black, black)).toBe(0);
        expect(signatureDistance(black, white)).toBeCloseTo(1, 5);
    });

    it("同亮度但反色相的帧也要拉开距离（红切蓝）", () => {
        const red = frameSignature(solidColorFrame(64, 36, [217, 43, 43]), 64, 36);
        const blue = frameSignature(solidColorFrame(64, 36, [29, 78, 219]), 64, 36);
        // 只算亮度时这两个差不到 0.16，会被漏判成同一镜头
        expect(signatureDistance(red, blue)).toBeGreaterThan(0.35);
    });
});

describe("detectSceneChanges", () => {
    it("在硬切处给出切点，时间取新镜头的第一帧", () => {
        const samples = [sample(0, 20), sample(250, 22), sample(500, 20), sample(750, 230), sample(1000, 228)];
        const cuts = detectSceneChanges(samples);
        expect(cuts).toHaveLength(1);
        expect(cuts[0].timeMs).toBe(750);
        expect(cuts[0].score).toBeGreaterThan(0.7);
    });

    it("相邻的重复切点只保留一个", () => {
        const samples = [sample(0, 20), sample(200, 240), sample(400, 238), sample(600, 20)];
        const cuts = detectSceneChanges(samples, { dedupeMs: 400 });
        // 200ms 与 600ms 相隔 400，按窗口不合并；但两者都是真实切点
        expect(cuts.map((cut) => cut.timeMs)).toEqual([200, 600]);
    });

    it("小幅运动不当作切点", () => {
        const samples = [sample(0, 100), sample(250, 108), sample(500, 96), sample(750, 104)];
        expect(detectSceneChanges(samples)).toHaveLength(0);
    });
});

describe("planSegments", () => {
    it("没有切点时按上限硬切，只有第一段算切点起点", () => {
        const ranges = planSegments(15_000, [], { maxMs: 6000, minMs: 1000 });
        expect(ranges).toEqual([
            { startMs: 0, endMs: 6000, sceneStart: true },
            { startMs: 6000, endMs: 12_000, sceneStart: false },
            { startMs: 12_000, endMs: 15_000, sceneStart: false },
        ]);
    });

    it("优先在场景切点断开", () => {
        const cuts = [
            { timeMs: 3200, score: 0.5 },
            { timeMs: 7000, score: 0.6 },
        ];
        const ranges = planSegments(9000, cuts, { maxMs: 6000, minMs: 1000 });
        expect(ranges).toEqual([
            { startMs: 0, endMs: 3200, sceneStart: true },
            { startMs: 3200, endMs: 7000, sceneStart: true },
            { startMs: 7000, endMs: 9000, sceneStart: true },
        ]);
    });

    it("切点太远时宁可按上限切，也不让单段超长", () => {
        const cuts = [{ timeMs: 9000, score: 0.6 }];
        const ranges = planSegments(10_000, cuts, { maxMs: 4000, minMs: 1000 });
        expect(ranges[0]).toEqual({ startMs: 0, endMs: 4000, sceneStart: true });
        expect(ranges[1].sceneStart).toBe(false);
        expect(ranges.every((range) => range.endMs - range.startMs <= 4000)).toBe(true);
    });

    it("尾巴太短时会合并，不留 300ms 这种碎片段", () => {
        const cuts = [
            { timeMs: 4000, score: 0.5 },
            { timeMs: 5600, score: 0.5 },
        ];
        const ranges = planSegments(5900, cuts, { maxMs: 6000, minMs: 1000 });
        expect(ranges).toEqual([
            { startMs: 0, endMs: 4000, sceneStart: true },
            { startMs: 4000, endMs: 5900, sceneStart: true },
        ]);
        expect(ranges.some((range) => range.endMs - range.startMs < 1000)).toBe(false);
    });

    it("零时长返回空", () => {
        expect(planSegments(0, [])).toEqual([]);
        expect(planSegments(Number.NaN, [])).toEqual([]);
    });
});

describe("planSelectionRanges", () => {
    it("选区内部按上限切分，首段不算切点起点", () => {
        const ranges = planSelectionRanges(10_000, 20_000, [], { maxMs: 4000 });
        expect(ranges.map((range) => [range.startMs, range.endMs])).toEqual([
            [10_000, 14_000],
            [14_000, 18_000],
            [18_000, 20_000],
        ]);
        expect(ranges[0].sceneStart).toBe(false);
    });

    it("选区内的场景切点会被用作边界", () => {
        const ranges = planSelectionRanges(10_000, 15_000, [{ timeMs: 12_500, score: 0.4 }], { maxMs: 4000 });
        expect(ranges.map((range) => [range.startMs, range.endMs])).toEqual([
            [10_000, 12_500],
            [12_500, 15_000],
        ]);
        expect(ranges[1].sceneStart).toBe(true);
    });

    it("空选区返回空", () => {
        expect(planSelectionRanges(5000, 5000, [])).toEqual([]);
    });
});

describe("snapToCut", () => {
    const cuts = [
        { timeMs: 3000, score: 0.5 },
        { timeMs: 9000, score: 0.5 },
    ];

    it("容差内吸到切点", () => {
        expect(snapToCut(3150, cuts, 350)).toBe(3000);
    });

    it("超容差保持原位", () => {
        expect(snapToCut(5000, cuts, 350)).toBe(5000);
    });
});

describe("auditSegmentCoverage", () => {
    it("首尾相接时判定完整", () => {
        const result = auditSegmentCoverage(
            [
                { startMs: 0, endMs: 5000 },
                { startMs: 5000, endMs: 10_000 },
            ],
            10_000,
        );
        expect(result.ok).toBe(true);
    });

    it("中间缺一段时给出空洞", () => {
        const result = auditSegmentCoverage(
            [
                { startMs: 0, endMs: 5000 },
                { startMs: 7000, endMs: 10_000 },
            ],
            10_000,
        );
        expect(result.ok).toBe(false);
        expect(result.gaps).toEqual([{ startMs: 5000, endMs: 7000 }]);
    });

    it("重叠会单独报出来", () => {
        const result = auditSegmentCoverage(
            [
                { startMs: 0, endMs: 6000 },
                { startMs: 5000, endMs: 10_000 },
            ],
            10_000,
        );
        expect(result.ok).toBe(false);
        expect(result.overlaps).toHaveLength(1);
    });

    it("尾部缺失算空洞", () => {
        expect(findMissingRanges([{ startMs: 0, endMs: 8000 }], 12_000)).toEqual([{ startMs: 8000, endMs: 12_000 }]);
    });
});

describe("时间格式化", () => {
    it("时间码保留一位小数", () => {
        expect(formatTimecode(3200)).toBe("00:03.2");
        expect(formatTimecode(0)).toBe("00:00.0");
        expect(formatTimecode(63_500)).toBe("01:03.5");
    });

    it("时长按秒/分显示", () => {
        expect(formatDuration(15_200)).toBe("15.2s");
        expect(formatDuration(123_000)).toBe("2m03s");
        expect(formatDuration(0)).toBe("0s");
    });
});
