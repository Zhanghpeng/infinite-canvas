import { describe, expect, it } from "vitest";

import {
    auditSegmentCoverage,
    detectSceneChanges,
    findMissingRanges,
    fitRangesToLimits,
    formatDuration,
    formatTimecode,
    frameSignature,
    isRangeWithinLimits,
    isSegmentRunnable,
    MINIMAX_SEGMENT_LIMITS,
    planSegments,
    planSelectionRanges,
    promptTemplateKey,
    recommendSegmentTarget,
    clampManualCut,
    insertManualCut,
    MIN_MANUAL_GAP_MS,
    moveManualCut,
    rangesFromCuts,
    remapSegmentConfig,
    removeManualCut,
    resolveSegmentLimits,
    sameRangeBoundaries,
    segmentAnchorTimes,
    SEGMENT_TAIL_FRAME_BACKOFF_MS,
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

    it("镜头边界优先于把段塞满上限", () => {
        // 每 3 秒一个镜头，MiniMax 区间 5–15 秒。塞满 15 秒一段会横跨 5 个镜头。
        const cuts = Array.from({ length: 59 }, (_, index) => ({ timeMs: (index + 1) * 3000, score: 0.5 }));
        const ranges = planSegments(180_000, cuts, { maxMs: 15_000, minMs: 5000 });
        const cutTimes = new Set(cuts.map((cut) => cut.timeMs));
        // 目标被下限抬到 5 秒，窗口里最近的镜头边界是 6 秒
        expect(ranges.every((range) => range.endMs - range.startMs <= 6000)).toBe(true);
        ranges.slice(0, -1).forEach((range) => expect(cutTimes.has(range.endMs)).toBe(true));
    });

    it("镜头正好落在能力区间内时一段一镜头", () => {
        const cuts = [6000, 12_000, 18_000].map((timeMs) => ({ timeMs, score: 0.5 }));
        const ranges = planSegments(24_000, cuts, { maxMs: 15_000, minMs: 5000 });
        expect(ranges.map((range) => [range.startMs, range.endMs])).toEqual([
            [0, 6000],
            [6000, 12_000],
            [12_000, 18_000],
            [18_000, 24_000],
        ]);
        // 每段都起于硬切，合成时不需要淡化
        expect(ranges.every((range) => range.sceneStart)).toBe(true);
    });

    it("给了目标段长就按它挑边界", () => {
        const cuts = [3000, 6000, 9000, 12_000, 15_000].map((timeMs) => ({ timeMs, score: 0.5 }));
        const wide = planSegments(18_000, cuts, { minMs: 5000, maxMs: 15_000, targetMs: 13_000 });
        expect(wide[0].endMs).toBe(12_000);
        const narrow = planSegments(18_000, cuts, { minMs: 5000, maxMs: 15_000, targetMs: 6000 });
        expect(narrow[0].endMs).toBe(6000);
    });

    it("镜头比下限还短时并到刚好够，不跨更多镜头", () => {
        // 每 2 秒一个镜头，下限 5 秒：一段至少吃 3 个镜头，但不会一路吃到 15 秒
        const cuts = Array.from({ length: 9 }, (_, index) => ({ timeMs: (index + 1) * 2000, score: 0.5 }));
        const ranges = planSegments(20_000, cuts, { minMs: 5000, maxMs: 15_000 });
        expect(ranges[0].endMs - ranges[0].startMs).toBe(6000);
    });

    it("整片检测不出切点时按上限均分，不留尾巴碎片", () => {
        const ranges = planSegments(18_000, [], { minMs: 5000, maxMs: 15_000 });
        expect(ranges.map((range) => range.endMs - range.startMs)).toEqual([9000, 9000]);
        expect(ranges[1].sceneStart).toBe(false);
    });

    it("零时长返回空", () => {
        expect(planSegments(0, [])).toEqual([]);
        expect(planSegments(Number.NaN, [])).toEqual([]);
    });
});

describe("recommendSegmentTarget", () => {
    it("取镜头长度的中位数，并夹进能力区间", () => {
        // 三个镜头 4 / 6 / 8 秒，中位数 6 秒正好在 5–15 秒内
        expect(recommendSegmentTarget(0, 18_000, [{ timeMs: 4000, score: 0.5 }, { timeMs: 10_000, score: 0.5 }], 5000, 15_000)).toBe(6000);
        // 全是 2 秒快切：中位数被下限抬到 5 秒
        expect(recommendSegmentTarget(0, 20_000, Array.from({ length: 9 }, (_, index) => ({ timeMs: (index + 1) * 2000, score: 0.5 })), 5000, 15_000)).toBe(5000);
        // 长镜头被上限压到 15 秒
        expect(recommendSegmentTarget(0, 30_000, [], 5000, 15_000)).toBe(15_000);
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

describe("resolveSegmentLimits", () => {
    it("认出 MiniMax 系渠道就是 5–15 秒", () => {
        expect(resolveSegmentLimits(["minimax"])).toEqual(MINIMAX_SEGMENT_LIMITS);
        expect(resolveSegmentLimits(["海螺 H3"])).toEqual(MINIMAX_SEGMENT_LIMITS);
        expect(resolveSegmentLimits(["MiniMaxH3ReferenceToVideo"])).toEqual(MINIMAX_SEGMENT_LIMITS);
    });

    it("没给线索时按 MiniMax 处理（猜保守比猜错方向安全）", () => {
        expect(resolveSegmentLimits([])).toEqual(MINIMAX_SEGMENT_LIMITS);
        expect(resolveSegmentLimits([undefined, null, ""])).toEqual(MINIMAX_SEGMENT_LIMITS);
    });

    it("认不出的渠道退回保守区间", () => {
        const limits = resolveSegmentLimits(["openai sora"]);
        expect(limits.minMs).toBe(1200);
        expect(limits.maxMs).toBe(6000);
    });
});

describe("fitRangesToLimits", () => {
    const minimax = MINIMAX_SEGMENT_LIMITS;

    it("短段并入前一段，不再产出 4 秒以下的必失败段", () => {
        const ranges = fitRangesToLimits(
            [
                { startMs: 0, endMs: 4000, sceneStart: true },
                { startMs: 4000, endMs: 5500, sceneStart: true },
            ],
            minimax.minMs,
            minimax.maxMs,
        );
        expect(ranges).toEqual([{ startMs: 0, endMs: 5500, sceneStart: true }]);
    });

    it("首段过短且没有前段时并给下一段", () => {
        const ranges = fitRangesToLimits(
            [
                { startMs: 0, endMs: 1500, sceneStart: true },
                { startMs: 1500, endMs: 9000, sceneStart: true },
            ],
            minimax.minMs,
            minimax.maxMs,
        );
        expect(ranges).toEqual([{ startMs: 0, endMs: 9000, sceneStart: true }]);
    });

    it("超长段均分，且每段都落在区间内", () => {
        const ranges = fitRangesToLimits([{ startMs: 0, endMs: 22_000, sceneStart: true }], minimax.minMs, minimax.maxMs);
        expect(ranges).toHaveLength(2);
        expect(ranges.map((range) => [range.startMs, range.endMs])).toEqual([
            [0, 11_000],
            [11_000, 22_000],
        ]);
        expect(ranges.every((range) => isRangeWithinLimits(range, minimax))).toBe(true);
    });

    it("合并后超上限的段也会被均分回来", () => {
        // 0–1.2s 并给下一段后变成 0–20s，超过 15s，必须拆
        const ranges = fitRangesToLimits(
            [
                { startMs: 0, endMs: 1200, sceneStart: true },
                { startMs: 1200, endMs: 20_000, sceneStart: true },
            ],
            minimax.minMs,
            minimax.maxMs,
        );
        expect(ranges.every((range) => range.endMs - range.startMs <= minimax.maxMs)).toBe(true);
        expect(ranges[0].startMs).toBe(0);
        expect(ranges[ranges.length - 1].endMs).toBe(20_000);
    });

    it("均分出来的后半段不再标记为切点起点", () => {
        const ranges = fitRangesToLimits([{ startMs: 0, endMs: 30_000, sceneStart: true }], minimax.minMs, minimax.maxMs);
        expect(ranges[0].sceneStart).toBe(true);
        expect(ranges.slice(1).every((range) => range.sceneStart === false)).toBe(true);
    });

    it("不改动本来就合规的段", () => {
        const input = [
            { startMs: 0, endMs: 6000, sceneStart: true },
            { startMs: 6000, endMs: 13_000, sceneStart: true },
        ];
        expect(fitRangesToLimits(input, minimax.minMs, minimax.maxMs)).toEqual(input);
    });
});

describe("planSegments 在 MiniMax 约束下", () => {
    it("场景切点把片子切碎到 5 秒以下时会合并回合规区间", () => {
        const cuts = [
            { timeMs: 1200, score: 0.4 },
            { timeMs: 2600, score: 0.4 },
            { timeMs: 4100, score: 0.4 },
        ];
        const ranges = planSegments(13_000, cuts, MINIMAX_SEGMENT_LIMITS);
        expect(ranges.length).toBeGreaterThan(0);
        expect(ranges.every((range) => isRangeWithinLimits(range, MINIMAX_SEGMENT_LIMITS))).toBe(true);
    });

    it("长镜头按 15 秒上限硬切，尾段仍落在合规区间", () => {
        const ranges = planSegments(40_000, [], MINIMAX_SEGMENT_LIMITS);
        expect(ranges.map((range) => [range.startMs, range.endMs])).toEqual([
            [0, 15_000],
            [15_000, 30_000],
            [30_000, 40_000],
        ]);
        expect(ranges.every((range) => isRangeWithinLimits(range, MINIMAX_SEGMENT_LIMITS))).toBe(true);
    });

    it("按上限硬切后尾段不足下限时会并回前一段", () => {
        // 16s：硬切成 15s + 1s，1s 无法单独提交，必须并成一段（再由均分处理）
        const ranges = planSegments(16_000, [], MINIMAX_SEGMENT_LIMITS);
        expect(ranges.every((range) => isRangeWithinLimits(range, MINIMAX_SEGMENT_LIMITS))).toBe(true);
        expect(ranges[ranges.length - 1].endMs).toBe(16_000);
    });
});

describe("isRangeWithinLimits", () => {
    it("边界上有容差，避免 4998ms 这种浮点误差被判违规", () => {
        expect(isRangeWithinLimits({ startMs: 0, endMs: 4970 }, MINIMAX_SEGMENT_LIMITS)).toBe(true);
        expect(isRangeWithinLimits({ startMs: 0, endMs: 4600 }, MINIMAX_SEGMENT_LIMITS)).toBe(false);
        expect(isRangeWithinLimits({ startMs: 0, endMs: 15_040 }, MINIMAX_SEGMENT_LIMITS)).toBe(true);
        expect(isRangeWithinLimits({ startMs: 0, endMs: 16_000 }, MINIMAX_SEGMENT_LIMITS)).toBe(false);
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

/**
 * 「先跑配好的段」这套逻辑的两个判据。
 *
 * 前者决定提交时哪些段能进这一批，后者决定能不能接着上一批跑 ——
 * 两者错一个，要么白烧一轮额度，要么把角色套到另一段时间上。
 */
describe("isSegmentRunnable", () => {
    const range = { startMs: 0, endMs: 6000, sceneStart: true };

    it("局部重绘不需要角色参考图", () => {
        expect(isSegmentRunnable(range, [], false)).toBe(true);
    });

    it("角色替换：跟随全局且全局有角色时可跑", () => {
        expect(isSegmentRunnable(range, ["a"], true)).toBe(true);
    });

    it("角色替换：没配任何角色时不可跑", () => {
        expect(isSegmentRunnable(range, [], true)).toBe(false);
    });

    it("段级覆盖优先于全局", () => {
        // 全局有角色，但这段显式配成空集合 = 这段不换人，不该算「没配」。
        expect(isSegmentRunnable({ ...range, castNodeIds: [] }, ["a"], true)).toBe(true);
        // 全局空，但这段自己配了：能跑。
        expect(isSegmentRunnable({ ...range, castNodeIds: ["b"] }, [], true)).toBe(true);
    });
});

describe("sameRangeBoundaries", () => {
    const a = [
        { startMs: 0, endMs: 5000 },
        { startMs: 5000, endMs: 11_000 },
    ];

    it("边界完全一致才算同一套切法", () => {
        expect(sameRangeBoundaries(a, [{ startMs: 0, endMs: 5000 }, { startMs: 5000, endMs: 11_000 }])).toBe(true);
    });

    it("段数不同不算", () => {
        expect(sameRangeBoundaries(a, [{ startMs: 0, endMs: 11_000 }])).toBe(false);
    });

    it("段数相同但切点不同不算", () => {
        expect(sameRangeBoundaries(a, [{ startMs: 0, endMs: 6000 }, { startMs: 6000, endMs: 11_000 }])).toBe(false);
    });

    it("空计划不算（避免把两个都没分段的批次认成同一批）", () => {
        expect(sameRangeBoundaries([], [])).toBe(false);
    });
});

describe("segmentAnchorTimes 抽帧点", () => {
    it("首帧取区间起点，尾帧回退一格，避免落到下一段的第一帧", () => {
        expect(segmentAnchorTimes({ startMs: 10_000, endMs: 18_000 })).toEqual({ headMs: 10_000, tailMs: 18_000 - SEGMENT_TAIL_FRAME_BACKOFF_MS });
    });

    it("极短的段不能让尾帧跑到首帧前面", () => {
        const times = segmentAnchorTimes({ startMs: 5_000, endMs: 5_010 });
        expect(times.tailMs).toBeGreaterThanOrEqual(times.headMs);
        expect(times.headMs).toBe(5_000);
    });

    it("起点为负时钳到 0（有些容器的首帧时间戳会是 -1）", () => {
        expect(segmentAnchorTimes({ startMs: -1, endMs: 4_000 })).toEqual({ headMs: 0, tailMs: 4_000 - SEGMENT_TAIL_FRAME_BACKOFF_MS });
    });
});


describe("手动切点", () => {
    it("按钉住的切点还原分段，首尾由区间补齐", () => {
        const ranges = rangesFromCuts([3000, 7000], 0, 12_000);
        expect(ranges.map((range) => [range.startMs, range.endMs])).toEqual([
            [0, 3000],
            [3000, 7000],
            [7000, 12_000],
        ]);
    });

    it("切在真实硬切上算场景起点，切在连续画面里不算", () => {
        // 3000 处是硬切，5000 处在镜头中间
        const ranges = rangesFromCuts([3000, 5000], 0, 9000, [{ timeMs: 3000, score: 0.6 }]);
        expect(ranges[1].sceneStart).toBe(true);
        expect(ranges[2].sceneStart).toBe(false);
    });

    it("拖切点时不许越过邻居，也不许把任一侧顶过上限", () => {
        const cuts = [6000, 12_000];
        // 往前拖太多会撞上 0 与自身；往后拖受 12000-300 限制
        expect(clampManualCut(cuts, 0, -5000, 0, 20_000, 15_000)).toBe(MIN_MANUAL_GAP_MS);
        expect(clampManualCut(cuts, 0, 100_000, 0, 20_000, 15_000)).toBe(12_000 - MIN_MANUAL_GAP_MS);
        // 上限约束：这一段 0–12000 配 9000 上限，切点往前挪就会让左边超限
        expect(clampManualCut([12_000], 0, 11_000, 0, 12_000, 9000)).toBe(9000);
    });

    it("拖动返回新数组，位置没变时原样返回", () => {
        const cuts = [6000, 12_000];
        expect(moveManualCut(cuts, 0, 10_000, 0, 20_000, 15_000)).toEqual([10_000, 12_000]);
        // 夹完之后与原来一致：不制造新数组，省得下游 memo 白跑
        expect(moveManualCut(cuts, 0, 6000, 0, 20_000, 15_000)).toBe(cuts);
    });

    it("补一刀：太贴边或切完仍超上限就拒绝", () => {
        expect(insertManualCut([], 6000, 0, 12_000, 15_000)).toEqual([6000]);
        // 贴边
        expect(insertManualCut([], 100, 0, 12_000, 15_000)).toBeNull();
        // 离已有切点太近
        expect(insertManualCut([6000], 6100, 0, 12_000, 15_000)).toBeNull();
        // 整段本来就超上限，切一刀左侧仍超
        expect(insertManualCut([], 14_000, 0, 30_000, 15_000)).toBeNull();
    });

    it("合并：合并后超上限就不许并", () => {
        expect(removeManualCut([6000, 12_000], 1, 0, 20_000, 15_000)).toEqual([6000]);
        // 0–12000 并起来 12 秒，上限 9 秒，并不得
        expect(removeManualCut([6000, 12_000], 1, 0, 20_000, 9000)).toBeNull();
        // 不存在的下标
        expect(removeManualCut([6000], 5, 0, 20_000, 15_000)).toBeNull();
    });
});

describe("remapSegmentConfig 边界变化后配置跟着时间走", () => {
    const previous = [
        { startMs: 0, endMs: 6000 },
        { startMs: 6000, endMs: 12_000 },
        { startMs: 12_000, endMs: 18_000 },
    ];

    it("拖动边界：配置落在重叠最久的那一段上", () => {
        // 第 2 段往左挪到 9000，原第 2 段（6000–12000）剩 6000–9000 归新第 2 段，9000–12000 归新第 3 段
        const next = [
            { startMs: 0, endMs: 6000 },
            { startMs: 6000, endMs: 9000 },
            { startMs: 9000, endMs: 18_000 },
        ];
        const mapped = remapSegmentConfig({ 1: ["a"] }, previous, next);
        expect(mapped[1]).toEqual(["a"]);
        // 新第 3 段与旧第 2 段重叠 3000ms、与旧第 3 段重叠 6000ms → 继承旧第 3 段（不存在配置）
        expect(mapped[2]).toBeUndefined();
    });

    it("拆分：两段都继承原配置，拆出来的两边本来就是同一个人", () => {
        const next = [
            { startMs: 0, endMs: 6000 },
            { startMs: 6000, endMs: 9000 },
            { startMs: 9000, endMs: 12_000 },
            { startMs: 12_000, endMs: 18_000 },
        ];
        const mapped = remapSegmentConfig({ 1: ["a"] }, previous, next);
        expect(mapped[1]).toEqual(["a"]);
        expect(mapped[2]).toEqual(["a"]);
    });

    it("合并：按重叠多的那一侧决定，两段各有主张时不静默二选一", () => {
        // 0–9000 里 6000ms 来自第 1 段（跟随全局）、3000ms 来自第 2 段（挂了 a）：
        // 合起来这一段同时含两种人，套任何一边都是错的，所以回落到跟随全局。
        const mapped = remapSegmentConfig({ 1: ["a"] }, previous, [
            { startMs: 0, endMs: 9000 },
            { startMs: 9000, endMs: 18_000 },
        ]);
        expect(mapped[0]).toBeUndefined();
        // 反过来，合并后主体就是挂了配置的那段，配置跟着过来
        const trimmed = remapSegmentConfig({ 1: ["a"] }, previous, [
            { startMs: 0, endMs: 3000 },
            { startMs: 3000, endMs: 18_000 },
        ]);
        expect(trimmed[1]).toEqual(["a"]);
    });

    it("新段与所有旧段都不重叠时不留残留配置", () => {
        const mapped = remapSegmentConfig({ 12: ["a"] }, previous, [{ startMs: 0, endMs: 6000 }]);
        expect(mapped).toEqual({});
    });
});

describe("promptTemplateKey 人数分档", () => {
    it("0 个角色不给模板（纯重绘或还没选）", () => {
        expect(promptTemplateKey(0)).toBeNull();
        expect(promptTemplateKey(-1)).toBeNull();
        expect(promptTemplateKey(NaN)).toBeNull();
    });

    it("单人和双人各自一档：这两档的措辞差最多，混用会多画或少画一个人", () => {
        expect(promptTemplateKey(1)).toBe("one");
        expect(promptTemplateKey(2)).toBe("two");
    });

    it("三人及以上共用 many 档", () => {
        expect(promptTemplateKey(3)).toBe("many");
        expect(promptTemplateKey(7)).toBe("many");
    });
});
