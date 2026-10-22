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

/**
 * 计划中的一段，允许覆盖全局角色集合。
 *
 * 切点只按画面变化算，算不出"这一段里有几个人"。一段对话戏可能只有一个角色，
 * 另一个侧拍镜头有三个人 —— 全都喂同一套角色参考，模型会往画面里塞不存在的人。
 */
export type SegmentPlan = VideoRange & {
    /** 本段参与生成的角色参考图节点 id；为空表示跟随全局角色。 */
    castNodeIds?: string[];
    /** 本段的提示词覆盖；为空表示跟随全局提示词。 */
    prompt?: string;
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

/**
 * 单段时长的硬约束。
 *
 * 这不是审美偏好，是模型接口的能力边界：MiniMax 系列（海螺 / H3 reference-to-video）
 * 只接受 5–15 秒的参考视频，喂 2 秒进去会被拒绝或静默改成 5 秒 —— 后者更糟，
 * 用户以为成功了，拼回去才发现节奏全错。所以段长必须在规划阶段就落进区间。
 */
export type SegmentLimits = { minMs: number; maxMs: number };

export const MINIMAX_SEGMENT_LIMITS: SegmentLimits = { minMs: 5000, maxMs: 15000 };
/** 认不出渠道时的保守兜底：短段也能跑，只是段数会多。 */
export const FALLBACK_SEGMENT_LIMITS: SegmentLimits = { minMs: DEFAULT_MIN_SEGMENT_MS, maxMs: DEFAULT_MAX_SEGMENT_MS };

/**
 * 尾帧抽帧点相对区间终点的回退量（毫秒）。
 *
 * 区间是左闭右开，直接在 endMs 取值会落到下一段的第一帧上（如果正好是切点，就是
 * 另一场戏的画面），拿它当"尾帧锚定"等于把接缝锚错地方。回退一格视频帧即可。
 */
export const SEGMENT_TAIL_FRAME_BACKOFF_MS = 34;

/**
 * 一段首尾帧的实际抽帧时间点。
 *
 * 抽帧点和区间边界不是一回事，必须由同一个函数产出：预铺时记进 metadata 的值，
 * 要与真正抽帧时用的值一致，否则"节点上写的参考帧"和"模型吃的参考帧"不是同一张，
 * 事后核对就失去了意义。
 */
export function segmentAnchorTimes(range: { startMs: number; endMs: number }): { headMs: number; tailMs: number } {
    const headMs = Math.max(0, Math.round(range.startMs));
    const tailMs = Math.max(headMs, Math.round(range.endMs - SEGMENT_TAIL_FRAME_BACKOFF_MS));
    return { headMs, tailMs };
}

/**
 * 角色数 → 提示词模板档位。
 *
 * 人数必须写进提示词：单人段套双人模板，模型会凭空再画一个人；双人段套单人模板，
 * 第二个人会被抹掉。这种错模型不会报错，只会安静地多画或少画一个人，所以档位规则
 * 只在这里定一份 —— 弹窗填默认值、提交前的兜底都走它，免得两个地方各写一套分界。
 */
export function promptTemplateKey(count: number): "one" | "two" | "many" | null {
    if (!Number.isFinite(count) || count <= 0) return null;
    if (count === 1) return "one";
    if (count === 2) return "two";
    return "many";
}

/**
 * 从渠道/模型/工作流的名字里认出能力区间。
 *
 * 传进来的字符串越具体越好（工作流 id、模型名、渠道名一起传）。全都没给时按
 * MiniMax 处理 —— 本项目视频主力就是这个渠道，猜错方向的代价（提交必失败）比
 * 猜保守（段数偏多但能跑）大得多。
 */
export function resolveSegmentLimits(hints: Array<string | undefined | null>): SegmentLimits {
    const text = hints
        .filter((value): value is string => Boolean(value))
        .join(" ")
        .toLowerCase();
    if (!text.trim()) return MINIMAX_SEGMENT_LIMITS;
    if (/minimax|hailuo|海螺|abab|referencetovideo/.test(text)) return MINIMAX_SEGMENT_LIMITS;
    return FALLBACK_SEGMENT_LIMITS;
}

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
    return fitRangesToLimits(ranges, minMs, maxMs);
}

/**
 * 只处理用户选中的区间：在选区内部按切点或上限切分。
 * 选区起点通常落在保留段中间，所以 sceneStart 一律为 false —— 这一段的首帧要靠锚定帧接上前文。
 */
export function planSelectionRanges(startMs: number, endMs: number, cuts: SceneCut[], options: SegmentPlanOptions = {}): VideoRange[] {
    const maxMs = Math.max(500, options.maxMs ?? DEFAULT_MAX_SEGMENT_MS);
    const minMs = Math.max(0, options.minMs ?? DEFAULT_MIN_SEGMENT_MS);
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
    return fitRangesToLimits(ranges, minMs, maxMs);
}

/**
 * 把切出来的段捏进模型的能力区间。
 *
 * 场景检测只认画面变化，产出的段长完全不受模型约束：一段 0.8 秒的闪白、
 * 一段 22 秒的固定镜头都会原样冒出来。前者提交必被拒，后者超出上限被截断，
 * 都在用户按下生成之后才暴露 —— 所以要在规划阶段就修掉。
 *
 * 两条规则：
 * 1. 短于下限的段并入邻居（优先前一段），合并不下（会超上限）就留给第 2 步；
 * 2. 长于上限的段按上限均分 —— 均分天然满足下限（上限是下限的 3 倍以上时，
 *    每一份都 > 上限/2），比"从头硬切、尾段剩个零头"稳。
 *
 * sceneStart 只在原段起点保留：均分出来的后半段起于画面正中，本来就没有连续性。
 */
export function fitRangesToLimits(ranges: VideoRange[], minMs: number, maxMs: number): VideoRange[] {
    if (!ranges.length) return [];
    const floor = Math.max(0, minMs);
    const ceiling = Math.max(floor + 1, maxMs);

    // 1. 短段向前并。合并后可能超上限 —— 不在这里拦，交给第 2 步均分，
    //    否则会留下一个"并了超限、不并又不合规"的短段，两边都不成立。
    const merged: VideoRange[] = [];
    for (const range of ranges) {
        const previous = merged[merged.length - 1];
        if (previous && range.endMs - range.startMs < floor) {
            previous.endMs = range.endMs;
            continue;
        }
        merged.push({ ...range });
    }

    // 1.1 首段仍然过短，且只有它一个"没人可并"时并给下一段
    if (merged.length > 1 && merged[0].endMs - merged[0].startMs < floor) {
        const head = merged.shift() as VideoRange;
        merged[0] = { ...merged[0], startMs: head.startMs, sceneStart: head.sceneStart };
    }

    // 2. 超长段均分
    const result: VideoRange[] = [];
    for (const range of merged) {
        const length = range.endMs - range.startMs;
        if (length <= ceiling) {
            result.push(range);
            continue;
        }
        const parts = Math.ceil(length / ceiling);
        const piece = length / parts;
        for (let index = 0; index < parts; index += 1) {
            const startMs = index === 0 ? range.startMs : Math.round(range.startMs + piece * index);
            const endMs = index === parts - 1 ? range.endMs : Math.round(range.startMs + piece * (index + 1));
            result.push({ startMs, endMs, sceneStart: index === 0 ? range.sceneStart : false });
        }
    }
    return result;
}

/** 段长是否落在模型能接受的区间内。UI 用它给每张段卡打标、决定能不能提交。 */
export function isRangeWithinLimits(range: { startMs: number; endMs: number }, limits: SegmentLimits, toleranceMs = 60): boolean {
    const length = range.endMs - range.startMs;
    return length >= limits.minMs - toleranceMs && length <= limits.maxMs + toleranceMs;
}

/**
 * 这一段现在能不能直接跑。
 *
 * 局部重绘永远能跑（不需要角色参考图）。角色替换则要求"生效的角色集合"非空 ——
 * 没挂任何参考图跑角色替换，模型只会把原画面重新画一遍，白烧一轮额度。
 *
 * 显式给过（哪怕给的是空数组）都算能跑：空数组是"这段确定不换人"的有效语义，
 * 比如纯空镜，用户就是要它按原样重画一遍保持画质一致。
 */
export function isSegmentRunnable(range: SegmentPlan, globalCastIds: string[], requiresCast: boolean): boolean {
    if (!requiresCast) return true;
    if (range.castNodeIds !== undefined) return true;
    return globalCastIds.length > 0;
}

/**
 * 两组分段计划是不是同一套切法。
 *
 * 逐段配的角色是按序号存的，边界一变序号就指向另一段时间。所以"接着上一批跑"
 * 必须先确认边界完全一致，否则宁可开新批，也不能把角色套错人。
 */
export function sameRangeBoundaries(a: Array<{ startMs: number; endMs: number }>, b: Array<{ startMs: number; endMs: number }>): boolean {
    if (a.length !== b.length || !a.length) return false;
    return a.every((range, index) => range.startMs === b[index].startMs && range.endMs === b[index].endMs);
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
