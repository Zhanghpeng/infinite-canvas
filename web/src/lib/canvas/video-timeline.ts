/**
 * 长视频分段处理的纯逻辑层：场景切点检测、分段规划、选区吸附、段连续性校验。
 *
 * 这一层不碰 DOM、不碰网络，方便单测。所有时间单位统一为毫秒，区间语义为左闭右开 [startMs, endMs)。
 */

/** 采样帧的亮度签名，用于算帧间差异。 */
export type FrameSignature = {
    timeMs: number;
    /** 归一化后的低分辨率灰度网格，长度 = gridW * gridH。 */
    signature: number[];
};

export type SceneCut = {
    timeMs: number;
    /** 0~1，越大越像硬切。 */
    score: number;
};

export type VideoRange = {
    startMs: number;
    endMs: number;
    /**
     * 本段起点是否落在场景切点（含视频开头）。
     * 落在切点上的段边界天然没有画面连续性要求，合成时不做交叉淡化。
     */
    sceneStart: boolean;
};

export type SegmentPlanOptions = {
    /** 单段上限。主流视频模型给不了长片，默认 6 秒。 */
    maxMs?: number;
    /** 单段下限，太碎的段既费额度又难衔接。 */
    minMs?: number;
    /** 相邻切点去重窗口，默认 400ms。 */
    dedupeMs?: number;
};

export const DEFAULT_MAX_SEGMENT_MS = 6000;
export const DEFAULT_MIN_SEGMENT_MS = 1200;
/** 低于该分数视为渐变/运动，不算切点。 */
export const DEFAULT_SCENE_THRESHOLD = 0.22;

const GRID_W = 32;
const GRID_H = 18;

/**
 * 把一帧 RGBA 像素压成低分辨率签名，R/G/B 各一层，按 [R…, G…, B…] 排列。
 *
 * 不能只算亮度：红色切蓝色这类同亮度、反色相的转场在亮度空间里差不到 0.16，
 * 会被当成同一个镜头，分段就切在画面中间了。三通道一起算，红蓝差能到 0.5 以上。
 * 用最近邻下采样而不是双线性：切点检测只关心大面积变化，代价低且足够稳。
 */
export function frameSignature(data: Uint8ClampedArray | Uint8Array, width: number, height: number, gridW = GRID_W, gridH = GRID_H): number[] {
    const cells = gridW * gridH;
    if (width <= 0 || height <= 0) return new Array(cells * 3).fill(0);
    const sums = new Array(cells * 3).fill(0);
    const counts = new Array(cells).fill(0);
    for (let y = 0; y < height; y += 1) {
        const gy = Math.min(gridH - 1, Math.floor((y * gridH) / height));
        for (let x = 0; x < width; x += 1) {
            const gx = Math.min(gridW - 1, Math.floor((x * gridW) / width));
            const offset = (y * width + x) * 4;
            const index = gy * gridW + gx;
            sums[index] += data[offset];
            sums[cells + index] += data[offset + 1];
            sums[cells * 2 + index] += data[offset + 2];
            counts[index] += 1;
        }
    }
    const signature = new Array(cells * 3).fill(0);
    for (let index = 0; index < cells; index += 1) {
        const count = counts[index];
        if (!count) continue;
        signature[index] = sums[index] / count;
        signature[cells + index] = sums[cells + index] / count;
        signature[cells * 2 + index] = sums[cells * 2 + index] / count;
    }
    return signature;
}

/** 两个签名的平均绝对差，归一到 0~1。 */
export function signatureDistance(a: number[], b: number[]): number {
    const length = Math.min(a.length, b.length);
    if (!length) return 0;
    let total = 0;
    for (let i = 0; i < length; i += 1) total += Math.abs(a[i] - b[i]);
    return total / length / 255;
}

/**
 * 从采样序列里找切点。返回的时间是「变化之后那一帧」的时间，也就是新镜头的第一帧。
 * 过近的切点只保留分数最高的一个，避免一个快速运动被切成十几段。
 */
export function detectSceneChanges(samples: FrameSignature[], options: { threshold?: number; dedupeMs?: number } = {}): SceneCut[] {
    const threshold = options.threshold ?? DEFAULT_SCENE_THRESHOLD;
    const dedupeMs = options.dedupeMs ?? 400;
    const cuts: SceneCut[] = [];
    for (let i = 1; i < samples.length; i += 1) {
        const score = signatureDistance(samples[i - 1].signature, samples[i].signature);
        if (score >= threshold) cuts.push({ timeMs: samples[i].timeMs, score });
    }
    return dedupeCuts(cuts, dedupeMs);
}

export function dedupeCuts(cuts: SceneCut[], windowMs: number): SceneCut[] {
    const sorted = [...cuts].sort((a, b) => a.timeMs - b.timeMs);
    const result: SceneCut[] = [];
    for (const cut of sorted) {
        const previous = result[result.length - 1];
        if (previous && cut.timeMs - previous.timeMs < windowMs) {
            // 同一处抖动：留分高的，位置取后者（新镜头已经开始了）。
            if (cut.score > previous.score) result[result.length - 1] = cut;
            continue;
        }
        result.push(cut);
    }
    return result;
}

/**
 * 全片分段：边界优先落在场景切点上，单段不超上限；没有切点可用时按上限硬切。
 * 硬切出来的边界会被标成非切点，合成时据此决定要不要交叉淡化。
 */
export function planSegments(durationMs: number, cuts: SceneCut[], options: SegmentPlanOptions = {}): VideoRange[] {
    const maxMs = Math.max(500, options.maxMs ?? DEFAULT_MAX_SEGMENT_MS);
    const minMs = Math.max(0, options.minMs ?? DEFAULT_MIN_SEGMENT_MS);
    if (!Number.isFinite(durationMs) || durationMs <= 0) return [];
    const inner = uniqueSorted(cuts.map((cut) => clamp(cut.timeMs, 0, durationMs)).filter((time) => time > 0 && time < durationMs));

    const ranges: VideoRange[] = [];
    let cursor = 0;
    let sceneStart = true;
    // 上限切分次数兜底，避免浮点/异常数据导致死循环。
    for (let guard = 0; guard < 1000 && cursor < durationMs - 1; guard += 1) {
        let end = durationMs;
        const withinMax = inner.filter((time) => time > cursor + 1 && time <= cursor + maxMs);
        if (withinMax.length) {
            end = withinMax[withinMax.length - 1];
            const rest = durationMs - end;
            // 留一个尾巴太短会很难看，往前退一个切点把尾巴吃掉。
            if (rest > 0 && rest < minMs && withinMax.length > 1) end = withinMax[withinMax.length - 2];
        } else if (durationMs - cursor > maxMs) {
            end = cursor + maxMs;
        }
        if (end <= cursor) end = Math.min(durationMs, cursor + maxMs);
        ranges.push({ startMs: cursor, endMs: end, sceneStart });
        sceneStart = inner.includes(end);
        cursor = end;
    }
    return mergeShortRanges(ranges, minMs, maxMs);
}

/**
 * 只处理用户选中的区间：在选区内部按切点或上限切分。
 * 选区起点通常落在保留段中间，所以 sceneStart 一律为 false —— 这一段的首帧要靠锚定帧接上前文。
 */
export function planSelectionRanges(startMs: number, endMs: number, cuts: SceneCut[], options: SegmentPlanOptions = {}): VideoRange[] {
    const maxMs = Math.max(500, options.maxMs ?? DEFAULT_MAX_SEGMENT_MS);
    const start = Math.max(0, Math.min(startMs, endMs));
    const end = Math.max(start, Math.max(startMs, endMs));
    if (end - start <= 1) return [];
    const inner = uniqueSorted(cuts.map((cut) => cut.timeMs).filter((time) => time > start + 1 && time < end - 1));

    const ranges: VideoRange[] = [];
    let cursor = start;
    for (let guard = 0; guard < 1000 && cursor < end - 1; guard += 1) {
        let next = end;
        const withinMax = inner.filter((time) => time > cursor + 1 && time <= cursor + maxMs);
        if (withinMax.length) next = withinMax[withinMax.length - 1];
        else if (end - cursor > maxMs) next = cursor + maxMs;
        if (next <= cursor) next = Math.min(end, cursor + maxMs);
        ranges.push({ startMs: cursor, endMs: next, sceneStart: cursor === start ? false : inner.includes(cursor) });
        cursor = next;
    }
    return ranges;
}

function mergeShortRanges(ranges: VideoRange[], minMs: number, maxMs: number): VideoRange[] {
    const result: VideoRange[] = [];
    for (const range of ranges) {
        const previous = result[result.length - 1];
        const tooShort = range.endMs - range.startMs < minMs;
        // 合并后会超过上限 1.2 倍就宁可留一个短段，也不要让单段超模型能力。
        if (previous && tooShort && range.endMs - previous.startMs <= maxMs * 1.2) {
            previous.endMs = range.endMs;
            continue;
        }
        result.push({ ...range });
    }
    return result;
}

/** 把时间点吸到最近的切点上；超出容差就原样返回。 */
export function snapToCut(timeMs: number, cuts: SceneCut[], toleranceMs = 350): number {
    let best: number | null = null;
    let bestDistance = toleranceMs;
    for (const cut of cuts) {
        const distance = Math.abs(cut.timeMs - timeMs);
        if (distance <= bestDistance) {
            best = cut.timeMs;
            bestDistance = distance;
        }
    }
    return best ?? timeMs;
}

/** 已覆盖区间之外的空洞，用来提示「合成会缺一段」。 */
export function findMissingRanges(ranges: Array<{ startMs: number; endMs: number }>, durationMs: number, toleranceMs = 120): Array<{ startMs: number; endMs: number }> {
    const sorted = [...ranges].filter((range) => range.endMs > range.startMs).sort((a, b) => a.startMs - b.startMs);
    const gaps: Array<{ startMs: number; endMs: number }> = [];
    let cursor = 0;
    for (const range of sorted) {
        if (range.startMs > cursor + toleranceMs) gaps.push({ startMs: cursor, endMs: range.startMs });
        cursor = Math.max(cursor, range.endMs);
    }
    if (durationMs > cursor + toleranceMs) gaps.push({ startMs: cursor, endMs: durationMs });
    return gaps;
}

/**
 * 合成前校验：段是否首尾相接、顺序是否完整。
 * 返回 problems 便于 UI 直接给出人能看懂的提示。
 */
export function auditSegmentCoverage(segments: Array<{ startMs: number; endMs: number }>, durationMs: number): { ok: boolean; gaps: Array<{ startMs: number; endMs: number }>; overlaps: Array<{ startMs: number; endMs: number }> } {
    const sorted = [...segments].sort((a, b) => a.startMs - b.startMs);
    const gaps: Array<{ startMs: number; endMs: number }> = [];
    const overlaps: Array<{ startMs: number; endMs: number }> = [];
    let cursor = 0;
    for (const segment of sorted) {
        if (segment.startMs > cursor + 120) gaps.push({ startMs: cursor, endMs: segment.startMs });
        else if (segment.startMs < cursor - 120) overlaps.push({ startMs: segment.startMs, endMs: Math.min(cursor, segment.endMs) });
        cursor = Math.max(cursor, segment.endMs);
    }
    if (durationMs > cursor + 120) gaps.push({ startMs: cursor, endMs: durationMs });
    return { ok: gaps.length === 0 && overlaps.length === 0, gaps, overlaps };
}

/** 00:03.2 这类时间码，剪辑器习惯，避免用户自己换算毫秒。 */
export function formatTimecode(ms: number): string {
    if (!Number.isFinite(ms) || ms < 0) return "00:00.0";
    const totalSeconds = ms / 1000;
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds - minutes * 60;
    return `${String(minutes).padStart(2, "0")}:${seconds.toFixed(1).padStart(4, "0")}`;
}

/** 时长的人类可读写法：15.2s / 2m03s。 */
export function formatDuration(ms: number): string {
    if (!Number.isFinite(ms) || ms <= 0) return "0s";
    const totalSeconds = ms / 1000;
    if (totalSeconds < 60) return `${totalSeconds.toFixed(1).replace(/\.0$/, "")}s`;
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = Math.round(totalSeconds - minutes * 60);
    return `${minutes}m${String(seconds).padStart(2, "0")}s`;
}

function uniqueSorted(values: number[]): number[] {
    const sorted = [...values].sort((a, b) => a - b);
    const result: number[] = [];
    for (const value of sorted) {
        const previous = result[result.length - 1];
        if (previous === undefined || Math.abs(value - previous) > 1) result.push(value);
    }
    return result;
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}
