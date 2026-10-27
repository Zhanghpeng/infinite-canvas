import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, ChevronLeft, Clock3, Film, LoaderCircle, Play, Scissors, Sparkles, UserRound, Users, Wand2 } from "lucide-react";
import { Button, Input, Modal, Segmented, Tooltip } from "antd";
import { useTranslation } from "react-i18next";

import { CanvasVideoSegmentTrack } from "./canvas-video-segment-track";
import { CanvasVideoTimeline, type TimelineSelection } from "./canvas-video-timeline";
import { clearPromptTemplate, loadAllPromptTemplates, savePromptTemplate } from "@/lib/canvas/prompt-template-store";
import { buildFilmstrip, buildSegmentStrips, captureFrameDataUrl, detectVideoScenes } from "@/lib/canvas/video-scene-detect";
import {
    formatDuration,
    formatTimecode,
    isRangeWithinLimits,
    isSegmentRunnable,
    planSegments,
    planSelectionRanges,
    promptTemplateKey,
    recommendSegmentTarget,
    type SceneCut,
    type SegmentLimits,
    type SegmentPlan,
    type VideoRange,
} from "@/lib/canvas/video-timeline";
import type { CanvasNodeData } from "@/types/canvas";
import i18n from "@/i18n";

/** 把内部错误码翻译成人能看懂的话：库抛的英文原始错误直接展示等于没提示。 */
function describeMediaError(error: unknown): string {
    const code = error instanceof Error ? error.message : String(error);
    const map: Record<string, string> = {
        VIDEO_LOAD_FAILED: "canvas.videoTimeline.error.loadFailed",
        NO_VIDEO_TRACK: "canvas.videoTimeline.error.noVideoTrack",
        VIDEO_NO_DURATION: "canvas.videoTimeline.error.noDuration",
        VIDEO_SEEK_TIMEOUT: "canvas.videoTimeline.error.seekTimeout",
        VIDEO_SEEK_FAILED: "canvas.videoTimeline.error.seekTimeout",
        VIDEO_LOAD_TIMEOUT: "canvas.videoTimeline.error.loadFailed",
        EMPTY_RANGE: "canvas.videoTimeline.reason.noRange",
    };
    const key = map[code];
    return key ? i18n.t(key) : code;
}

export type VideoEditMode = "repaint" | "character";

export type VideoEditPlan = {
    mode: "repaint" | "character-swap";
    /** 分段计划：每段可覆盖全局角色集合与提示词。 */
    ranges: SegmentPlan[];
    /** 源片总时长。局部重绘要靠它把选区之外的画面原样补回来。 */
    durationMs: number;
    /** 选区起止是否正好落在场景切点上：是则补回来的保留段不参与淡化。 */
    startAtCut: boolean;
    endAtCut: boolean;
    /** 角色替换时参与生成的角色图片节点。 */
    castNodeIds: string[];
    prompt: string;
    /** 段边界交叉淡化帧数，0 表示硬切。 */
    crossfadeFrames: number;
    /** 是否沿用原片音轨。 */
    keepAudio: boolean;
    /** 本次切段用的目标段长：重开弹窗时要按它复原同一套边界，否则接不上上一批。 */
    targetMs: number;
    /**
     * 这次只跑这些段（下标）。undefined = 全跑。
     * 逐段配角色是件慢活，配好一段就该能先跑一段，不必等整片配完。
     */
    onlyRangeIndices?: number[];
};

type CanvasVideoTimelineModalProps = {
    open: boolean;
    node: CanvasNodeData | null;
    /** 画布上可做角色参考的图片节点。 */
    imageNodes: CanvasNodeData[];
    submitting: boolean;
    /** 当前视频渠道的单段能力区间（MiniMax 是 5–15 秒）。 */
    limits: SegmentLimits;
    /**
     * 这一批实际下发的输出规格：工作流名 + 画面比例。
     *
     * 参数是否生效，用户只能从结果反推，这是最容易起疑的地方（"我明明选了 16:9"）。
     * 把即将下发的规格摆在弹窗里，点生成之前就能核对。
     */
    spec?: { workflow: string; size: string; frameWorkflow?: boolean } | null;
    /** 该源片上次未跑完的分批概况：有值就在弹窗顶部讲清楚"还差几段、怎么接上"。 */
    pendingBatch?: { done: number; total: number; runnableRemain: number } | null;
    /** 这批里已经生成好的段（按时间区间匹配）：段卡上打"已生成"，提交时跳过。 */
    doneRanges?: VideoRange[] | null;
    /**
     * 这批当初的切段参数与逐段配置：重开弹窗时复原成同一套，否则边界一变段级角色就作废，
     * 用户配了半天的东西全要重来。
     */
    restore?: {
        mode: VideoEditMode;
        targetMs: number;
        prompt: string;
        crossfadeFrames: number;
        keepAudio: boolean;
        selection?: { startMs: number; endMs: number } | null;
        /** 逐段配置，按时间区间匹配（序号会随分段参数变化，区间不会）。 */
        casts?: Array<{ startMs: number; endMs: number; castNodeIds?: string[]; prompt?: string }>;
    } | null;
    onClose: () => void;
    onSubmit: (plan: VideoEditPlan) => void;
};

type Phase = "idle" | "analyzing" | "ready" | "error";

export function CanvasVideoTimelineModal({
    open,
    node,
    imageNodes,
    submitting,
    limits,
    spec,
    pendingBatch,
    doneRanges,
    restore,
    onClose,
    onSubmit,
}: CanvasVideoTimelineModalProps) {
    const { t } = useTranslation();
    const videoRef = useRef<HTMLVideoElement>(null);

    const [phase, setPhase] = useState<Phase>("idle");
    const [analyzeProgress, setAnalyzeProgress] = useState(0);
    const [errorText, setErrorText] = useState("");
    const [durationMs, setDurationMs] = useState(0);
    const [frames, setFrames] = useState<{ timeMs: number; dataUrl: string }[]>([]);
    const [cuts, setCuts] = useState<SceneCut[]>([]);
    const [mode, setMode] = useState<VideoEditMode>("character");
    const [selection, setSelection] = useState<TimelineSelection | null>(null);
    const [currentTimeMs, setCurrentTimeMs] = useState(0);
    const [targetSeconds, setTargetSeconds] = useState(limits.maxMs / 1000);
    const [prompt, setPrompt] = useState("");
    /**
     * 上一次自动填入的模板。
     *
     * 记着它才知道"这句提示词是自动填的、还是用户改过的"：改过的不能被人数变化
     * 静默覆盖，但也要能在人数对不上时一键重填。
     */
    const [autoTemplate, setAutoTemplate] = useState<{ text: string; count: number } | null>(null);
    /**
     * 用户自己存下来的模板，按精确人数存。
     *
     * 自动填入的那套只是起点：真实使用里每个人关心的点都不一样（要不要强调服装、
     * 镜头那几句留不留），每开一批重改一遍是纯损耗。存一份之后勾同样数量的角色就直接用它。
     */
    const [customTemplates, setCustomTemplates] = useState<Record<number, string>>({});
    /** 存默认失败（浏览器存储不可用）时说一声：不吭声的话用户会以为点上了。 */
    const [promptSaveFailed, setPromptSaveFailed] = useState(false);
    const [castNodeIds, setCastNodeIds] = useState<string[]>([]);
    const [crossfadeFrames, setCrossfadeFrames] = useState(3);
    const [keepAudio, setKeepAudio] = useState(true);
    /** 段级角色覆盖：key 是段在 ranges 里的下标；空数组表示"这段不挂任何角色"。 */
    const [segmentCasts, setSegmentCasts] = useState<Record<number, string[]>>({});
    /** 段级提示词覆盖：留空表示跟随全局。 */
    const [segmentPrompts, setSegmentPrompts] = useState<Record<number, string>>({});
    const [anchorFrames, setAnchorFrames] = useState<{ first?: string; last?: string }>({});
    /** 正在配置哪一段。null = 右栏显示全局设置。 */
    const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
    /** 主预览正在循环播放的段；null = 自由播放整片。 */
    const [previewIndex, setPreviewIndex] = useState<number | null>(null);
    const [strips, setStrips] = useState<string[][]>([]);
    const [stripsLoading, setStripsLoading] = useState(false);

    /**
     * 按角色数量取提示词模板：用户存过的优先，没有才用内置的。
     *
     * 人数必须写进提示词，而且是**必须说清**的那一件事：单人段套双人模板，模型会凭空
     * 再画一个人；双人段套单人模板，第二个人会被抹掉。光靠一个通用的"把人物换成参考图
     * 里的角色"兜不住，所以这里按人数分档。
     *
     * 自定义模板按**精确人数**存，不复用档位：正文里写死了人数与参考图编号，
     * 3 人存的那份拿去给 5 人用，数字就是错的（见 prompt-template-store 的注释）。
     */
    const templateFor = useCallback(
        (count: number) => {
            const custom = customTemplates[count]?.trim();
            if (custom) return custom;
            const key = promptTemplateKey(count);
            return key ? t(`canvas.videoTimeline.promptTemplate.${key}`, { count }) : "";
        },
        [customTemplates, t],
    );

    /** 提示词被用户改过（或从上一批恢复的），自动填入就不再覆盖它。 */
    const promptDirty = Boolean(prompt.trim()) && prompt.trim() !== (autoTemplate?.text ?? "").trim();
    /** 改过的提示词里写的人数已经跟当前勾选对不上 —— 这种错模型不会报，只会多画/少画一个人。 */
    const promptCountMismatch = promptDirty && Boolean(autoTemplate) && castNodeIds.length > 0 && autoTemplate!.count !== castNodeIds.length;
    /** 当前人数用的是自己存的模板（而不是内置的）。 */
    const usingCustomTemplate = Boolean(customTemplates[castNodeIds.length]?.trim());
    /** 内容就是存下来的那份，没再动过 —— 用于把"存为默认"换成"已存为默认"。 */
    const promptIsSavedDefault = usingCustomTemplate && !promptDirty && Boolean(prompt.trim());

    /** 按当前勾选人数重填模板：给"改过之后又增减了角色"的情况一个明确的出口。 */
    const refillPrompt = useCallback(() => {
        const next = templateFor(castNodeIds.length);
        if (!next) return;
        setAutoTemplate({ text: next, count: castNodeIds.length });
        setPrompt(next);
    }, [castNodeIds.length, templateFor]);

    /**
     * 把当前这版提示词存成"同样人数下的默认"。
     *
     * 存完把它当成新的基准（autoTemplate 跟着换），否则"是否改过"永远算成改过，
     * 每勾一次角色都弹一句"人数对不上，要不要重填"。
     */
    const savePromptAsDefault = useCallback(() => {
        const count = castNodeIds.length;
        if (!count) return;
        const text = prompt.trim();
        if (!text) return;
        if (!savePromptTemplate(count, text)) {
            // 存储不可用（隐私模式）时不能装作存好了：改还是有效的，只是下次要重改。
            setPromptSaveFailed(true);
            return;
        }
        setPromptSaveFailed(false);
        setCustomTemplates((previous) => ({ ...previous, [count]: text }));
        setAutoTemplate({ text, count });
    }, [castNodeIds.length, prompt]);

    /** 回到内置模板：连带把这份自定义删掉，否则下次又会填回来，看着像没生效。 */
    const restoreBuiltInPrompt = useCallback(() => {
        const count = castNodeIds.length;
        if (!count) return;
        clearPromptTemplate(count);
        setCustomTemplates((previous) => {
            const next = { ...previous };
            delete next[count];
            return next;
        });
        setPromptSaveFailed(false);
        const key = promptTemplateKey(count);
        if (!key) return;
        const builtIn = t(`canvas.videoTimeline.promptTemplate.${key}`, { count });
        setAutoTemplate({ text: builtIn, count });
        setPrompt(builtIn);
    }, [castNodeIds.length, t]);

    const src = node?.metadata?.content || "";
    // 复原参数只在"打开这一下"生效：放进 ref 是为了不让它进 useEffect 依赖，
    // 否则中途 pending 一变就会把用户正在配的东西重置掉。
    const restoreRef = useRef(restore);
    restoreRef.current = restore;
    /** 逐段配置只还原一次：之后用户的手动改动不该被再次覆盖。 */
    const restoreCastsAppliedRef = useRef(false);
    /** 上一次触发模板填写的角色数：只在人数真的变了时填，避免每次重渲染都覆盖输入。 */
    const lastCastCountRef = useRef(0);

    // 打开时重置并做一次画面分析：抽帧带 + 场景切点。
    useEffect(() => {
        if (!open || !src) return;
        let cancelled = false;
        const revived = restoreRef.current;
        setPhase("analyzing");
        setAnalyzeProgress(0);
        setErrorText("");
        setFrames([]);
        setCuts([]);
        setSelection(revived?.selection ? { startMs: revived.selection.startMs, endMs: revived.selection.endMs } : null);
        setAnchorFrames({});
        setPrompt(revived?.prompt ?? "");
        setAutoTemplate(null);
        // 自定义模板是跨批次的偏好，每次打开都重新读一次：另一个标签页刚存过的也能用上。
        setCustomTemplates(loadAllPromptTemplates());
        setPromptSaveFailed(false);
        lastCastCountRef.current = 0;
        setCastNodeIds([]);
        setSegmentCasts({});
        setSegmentPrompts({});
        setSelectedIndex(null);
        setPreviewIndex(null);
        setStrips([]);
        lastStripKeyRef.current = "";
        restoreCastsAppliedRef.current = false;
        setMode(revived?.mode ?? "character");
        setCrossfadeFrames(revived?.crossfadeFrames ?? 3);
        setKeepAudio(revived?.keepAudio ?? true);
        setTargetSeconds((revived?.targetMs ?? limits.maxMs) / 1000);

        void (async () => {
            try {
                const scene = await detectVideoScenes(src, {
                    onProgress: (value) => {
                        if (!cancelled) setAnalyzeProgress(value);
                    },
                });
                if (cancelled) return;
                setDurationMs(scene.durationMs);
                setCuts(scene.cuts);
                // 默认按镜头长度定目标段长（一段一镜头）。续跑上一批时不动：
                // 边界必须与上一批完全一致，否则按序号的段级配置会套到别的时间上。
                if (!revived?.targetMs) {
                    setTargetSeconds(recommendSegmentTarget(0, scene.durationMs, scene.cuts, limits.minMs, limits.maxMs) / 1000);
                }
                const strip = await buildFilmstrip(src, Math.min(24, Math.max(8, Math.round(scene.durationMs / 1000))), { width: 128 });
                if (cancelled) return;
                setFrames(strip.frames);
                // 默认选区：落在最长的一段里，省得用户自己去猜哪里有内容。
                // 续跑上一批时不改选区 —— 那是他当初拖好的范围，动了就接不上。
                if (!revived?.selection) {
                    const initialPlan = planSegments(scene.durationMs, scene.cuts, { maxMs: limits.maxMs, minMs: limits.minMs, targetMs: revived?.targetMs });
                    const longest = initialPlan.reduce<VideoRange | null>((best, range) => (!best || range.endMs - range.startMs > best.endMs - best.startMs ? range : best), null);
                    if (longest) setSelection({ startMs: longest.startMs, endMs: longest.endMs });
                }
                setPhase("ready");
            } catch (error) {
                if (cancelled) return;
                setErrorText(describeMediaError(error));
                setPhase("error");
            }
        })();

        return () => {
            cancelled = true;
        };
        // limits 变化（切换渠道）不该重跑分析；打开时取当下值即可。
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open, src]);

    /**
     * 勾几个角色，提示词就换成几个人的模板。
     *
     * 只换"还没被改过"的那一份：用户动过的文字不能因为多勾一张图就被冲掉。
     * 人数变 0（全取消）时不动提示词 —— 那多半是他正在改，清空等于添乱。
     */
    useEffect(() => {
        if (!open || mode !== "character") return;
        const count = castNodeIds.length;
        if (count === lastCastCountRef.current) return;
        lastCastCountRef.current = count;
        if (!count) return;
        const dirty = Boolean(prompt.trim()) && prompt.trim() !== (autoTemplate?.text ?? "").trim();
        if (dirty) return;
        const next = templateFor(count);
        setAutoTemplate({ text: next, count });
        setPrompt(next);
    }, [autoTemplate, castNodeIds.length, mode, open, prompt, templateFor]);

    // 选区两端各抽一帧，让用户看见「接缝钉在哪一帧上」。
    useEffect(() => {
        if (!open || !src || !selection) {
            setAnchorFrames({});
            return;
        }
        let cancelled = false;
        const timer = window.setTimeout(() => {
            void (async () => {
                try {
                    const [first, last] = await Promise.all([captureFrameDataUrl(src, selection.startMs, { width: 240 }), captureFrameDataUrl(src, Math.max(selection.startMs, selection.endMs - 34), { width: 240 })]);
                    if (!cancelled) setAnchorFrames({ first, last });
                } catch {
                    if (!cancelled) setAnchorFrames({});
                }
            })();
        }, 220);
        return () => {
            cancelled = true;
            window.clearTimeout(timer);
        };
    }, [open, selection, src]);

    const effectiveTargetMs = useMemo(
        () => Math.max(limits.minMs, Math.min(limits.maxMs, Math.round(targetSeconds * 1000))),
        [limits.maxMs, limits.minMs, targetSeconds],
    );

    const ranges = useMemo<SegmentPlan[]>(() => {
        if (!durationMs) return [];
        const options = { maxMs: limits.maxMs, minMs: limits.minMs, targetMs: effectiveTargetMs };
        const base: VideoRange[] = mode === "character" ? planSegments(durationMs, cuts, options) : selection ? planSelectionRanges(selection.startMs, selection.endMs, cuts, options) : [];
        // 段级覆盖：切点只按画面变化算，算不出"这段里有几个人"。不覆盖的段跟随全局，
        // 避免每段都要重选一遍；覆盖成空数组是有效语义（这段没有要换的人）。
        return base.map((range, index) => {
            const plan: SegmentPlan = { ...range };
            const castIds = segmentCasts[index] ?? castNodeIds;
            if (segmentCasts[index]) plan.castNodeIds = segmentCasts[index];
            const segmentPrompt = segmentPrompts[index]?.trim();
            if (segmentPrompt) plan.prompt = segmentPrompt;
            else if (!promptDirty && castIds.length > 0 && castIds.length !== castNodeIds.length) {
                // 这一段单独挂过角色、人数跟全局不同：沿用全局那句"两个人"会把这一段写坏。
                // 只在全局提示词还是自动模板时才补 —— 用户自己写的要求不能被静默替换。
                plan.prompt = templateFor(castIds.length);
            }
            return plan;
        });
    }, [castNodeIds, cuts, durationMs, effectiveTargetMs, limits.maxMs, limits.minMs, mode, promptDirty, segmentCasts, segmentPrompts, selection, templateFor]);

    /** 段长签名：只有段边界变了才重新抽帧，改角色不该触发一轮解码。 */
    const stripKey = useMemo(() => ranges.map((range) => `${range.startMs}-${range.endMs}`).join("|"), [ranges]);
    const stripCacheRef = useRef<Map<string, string[]>>(new Map());
    const rangesRef = useRef(ranges);
    rangesRef.current = ranges;

    /**
     * 段边界一变（改单段上限、切模式、拖选区），按序号的段级覆盖就会错位：
     * 原先第 3 段挂的角色会套到新计划的第 3 段上，而那已经是另一段时间。
     * 挑角色花的是人的判断力，宁可他重配，也不能静默换成别人。
     */
    const lastStripKeyRef = useRef("");
    useEffect(() => {
        if (!stripKey) return;
        if (lastStripKeyRef.current && lastStripKeyRef.current !== stripKey) {
            setSegmentCasts({});
            setSegmentPrompts({});
            setSelectedIndex(null);
            setPreviewIndex(null);
        }
        lastStripKeyRef.current = stripKey;
    }, [stripKey]);

    /**
     * 把上一批的逐段配置按时间区间放回去。
     *
     * 失败续跑或"先跑一批再配剩下的"时重开弹窗，如果段级角色全丢了，用户要重配七八段，
     * 而这个功能的意义恰恰是"配的东西不会白配"。按区间匹配而不是按序号：分段参数万一
     * 有变化，区间也不会指向另一段时间。
     */
    useEffect(() => {
        if (!open || restoreCastsAppliedRef.current) return;
        if (phase !== "ready" || !ranges.length) return;
        const casts: Record<number, string[]> = {};
        const prompts: Record<number, string> = {};
        const source = restore?.casts ?? [];
        if (!source.length) {
            restoreCastsAppliedRef.current = true;
            return;
        }
        ranges.forEach((range, index) => {
            const match = source.find((item) => item.startMs === range.startMs && item.endMs === range.endMs);
            if (!match) return;
            // 只有当初显式配过角色的段才还原：没配过的段继续跟随全局，不能凭空变成"确定不换人"。
            if (match.castNodeIds) casts[index] = match.castNodeIds;
            if (match.prompt?.trim()) prompts[index] = match.prompt;
        });
        if (Object.keys(casts).length) setSegmentCasts(casts);
        if (Object.keys(prompts).length) setSegmentPrompts(prompts);
        restoreCastsAppliedRef.current = true;
    }, [open, phase, ranges, restore]);

    useEffect(() => {
        if (!open || !src || !stripKey) {
            setStrips([]);
            return;
        }
        const plan = rangesRef.current;
        const cached = plan.map((range) => stripCacheRef.current.get(`${range.startMs}-${range.endMs}`));
        if (cached.every(Boolean)) {
            setStrips(cached as string[][]);
            return;
        }
        let cancelled = false;
        const controller = new AbortController();
        setStripsLoading(true);
        void (async () => {
            try {
                const built = await buildSegmentStrips(src, plan, { width: 200, signal: controller.signal });
                if (cancelled) return;
                plan.forEach((range, index) => stripCacheRef.current.set(`${range.startMs}-${range.endMs}`, built[index] ?? []));
                setStrips(built);
            } catch {
                if (!cancelled) setStrips([]);
            } finally {
                if (!cancelled) setStripsLoading(false);
            }
        })();
        return () => {
            cancelled = true;
            controller.abort();
        };
    }, [open, src, stripKey]);

    /** 某段当前生效的角色：有覆盖就用覆盖，否则跟随全局。 */
    const effectiveCastIds = useCallback((index: number) => segmentCasts[index] ?? castNodeIds, [castNodeIds, segmentCasts]);

    /**
     * 选中段的角色数与全局不同：这一段的提示词会被单独换成对应人数的模板。
     * 不说清楚的话，用户只会看到"我明明写的是两个人，怎么这段只有一个"。
     */
    const segmentCastDiff = useMemo(() => {
        if (selectedIndex === null) return "";
        const count = effectiveCastIds(selectedIndex).length;
        if (!count || count === castNodeIds.length) return "";
        return promptDirty
            ? t("canvas.videoTimeline.segment.castCountManual", { count, global: castNodeIds.length })
            : t("canvas.videoTimeline.segment.castCountAuto", { count, global: castNodeIds.length });
    }, [castNodeIds.length, effectiveCastIds, promptDirty, selectedIndex, t]);

    const toggleSegmentCast = useCallback(
        (index: number, castId: string) => {
            setSegmentCasts((previous) => {
                const current = previous[index] ?? castNodeIds;
                const next = current.includes(castId) ? current.filter((id) => id !== castId) : [...current, castId];
                const updated = { ...previous, [index]: next };
                // 选回跟全局一样就等于没覆盖，删掉覆盖让 UI 回到"跟随全局"的显示。
                if (next.length === castNodeIds.length && next.every((id) => castNodeIds.includes(id))) delete updated[index];
                return updated;
            });
        },
        [castNodeIds],
    );

    /** 这一段回到跟随全局。 */
    const resetSegmentCast = useCallback((index: number) => {
        setSegmentCasts((previous) => {
            const next = { ...previous };
            delete next[index];
            return next;
        });
    }, []);

    /** 把这一段配好的角色推广成全局，其他段的覆盖一并清掉 —— 用户点这个就是想"都按这段来"。 */
    const promoteSegmentCast = useCallback(
        (index: number) => {
            const ids = segmentCasts[index] ?? castNodeIds;
            setCastNodeIds(ids);
            setSegmentCasts({});
        },
        [castNodeIds, segmentCasts],
    );

    const seek = useCallback(
        (timeMs: number) => {
            const video = videoRef.current;
            setCurrentTimeMs(timeMs);
            if (video) video.currentTime = Math.min(durationMs / 1000, Math.max(0, timeMs / 1000));
        },
        [durationMs],
    );

    /** 点段卡：选中它、主预览循环播它 —— 这就是"看见这一段到底发生了什么"。 */
    const handleSelectSegment = useCallback(
        (index: number) => {
            const range = rangesRef.current[index];
            if (!range) return;
            setSelectedIndex(index);
            setPreviewIndex(index);
            seek(range.startMs);
            const video = videoRef.current;
            if (video) void video.play().catch(() => undefined);
        },
        [seek],
    );

    const handleBackToGlobal = useCallback(() => {
        setSelectedIndex(null);
        setPreviewIndex(null);
    }, []);

    const requiresCast = mode === "character";
    /**
     * 这批里已经生成好的段：按时间区间认 —— 序号会随分段参数变化，区间不会。
     * 给 40ms 容差：重开弹窗要重新读一次时长，浮点误差不该让"已生成"标丢。
     */
    const isDoneRange = useCallback(
        (range: VideoRange) => (doneRanges ?? []).some((done) => Math.abs(done.startMs - range.startMs) <= 40 && Math.abs(done.endMs - range.endMs) <= 40),
        [doneRanges],
    );
    const doneIndices = useMemo(() => {
        const result = new Set<number>();
        ranges.forEach((range, index) => {
            if (isDoneRange(range)) result.add(index);
        });
        return result;
    }, [isDoneRange, ranges]);
    const doneCount = doneIndices.size;

    /**
     * 分两拨：能直接跑的，和还没配好参考图的。
     *
     * 逐段配角色是件慢活（一段一段看画面、点人头），而生成更慢。让"配好的先跑"
     * 才能真正并行起来 —— 跑第一批的时候人接着配第二批。所以提交不再要求整片配完，
     * 只拦住"一段都跑不了"的情况。
     */
    const { runnableIndices, missingIndices } = useMemo(() => {
        const runnable: number[] = [];
        const missing: number[] = [];
        ranges.forEach((range, index) => {
            if (doneIndices.has(index)) return;
            if (isSegmentRunnable(range, castNodeIds, requiresCast)) runnable.push(index);
            else missing.push(index);
        });
        return { runnableIndices: runnable, missingIndices: missing };
    }, [castNodeIds, doneIndices, ranges, requiresCast]);

    /**
     * 拼提交计划。整批和单段走同一份字段，只有「跑哪几段」不同 ——
     * 两边各拼一份的话，漏一个字段就是两套行为，排查起来极其费劲。
     */
    const buildPlan = useCallback(
        (onlyRangeIndices?: number[]): VideoEditPlan => {
            // 选区端点通常已经被时间轴吸到切点上，这里再判一次：落在切点上就说明边界本来就没有连续性。
            const atCut = (timeMs: number) => cuts.some((cut) => Math.abs(cut.timeMs - timeMs) <= 80);
            return {
                mode: mode === "repaint" ? "repaint" : "character-swap",
                ranges,
                durationMs,
                startAtCut: atCut(ranges[0].startMs),
                endAtCut: atCut(ranges[ranges.length - 1].endMs),
                castNodeIds,
                prompt: prompt.trim(),
                crossfadeFrames,
                keepAudio,
                targetMs: effectiveTargetMs,
                onlyRangeIndices,
            };
        },
        [castNodeIds, crossfadeFrames, cuts, durationMs, effectiveTargetMs, keepAudio, mode, prompt, ranges],
    );

    const handleSubmit = useCallback(() => {
        if (!ranges.length) return;
        // 全都能跑就不用带下标；否则只跑这一拨，剩下的段留着下一批接上。
        onSubmit(buildPlan(runnableIndices.length === ranges.length ? undefined : runnableIndices));
    }, [buildPlan, onSubmit, ranges.length, runnableIndices]);

    /**
     * 只跑选中的这一段。
     *
     * 整批按钮跑的是"所有配好的段"，改完第 3 段想立刻看效果时，它会连带把
     * 没验过的段一起烧掉。逐段验是角色替换的常态操作，必须给这个粒度。
     */
    const handleSubmitOne = useCallback(
        (index: number) => {
            const range = ranges[index];
            if (!range || doneIndices.has(index)) return;
            if (!isSegmentRunnable(range, castNodeIds, requiresCast)) return;
            onSubmit(buildPlan([index]));
        },
        [buildPlan, castNodeIds, doneIndices, onSubmit, ranges, requiresCast],
    );

    const disabledReason = useMemo(() => {
        if (phase !== "ready" || !ranges.length) return t("canvas.videoTimeline.reason.noRange");
        if (runnableIndices.length) return "";
        if (doneCount >= ranges.length) return t("canvas.videoTimeline.reason.allGenerated");
        // 后面还有段等着配，这里的提示要指向"怎么先跑一部分"而不是"补第几段"。
        return t("canvas.videoTimeline.reason.segmentNoCastAny");
    }, [doneCount, phase, ranges.length, runnableIndices.length, t]);

    /** 整片就短于模型下限（或分段后仍有不合规的段）：不拦提交，但要讲清楚会发生什么。 */
    const outOfLimits = useMemo(() => ranges.filter((range) => !isRangeWithinLimits(range, limits)).length, [limits, ranges]);

    // 局部重绘只重建选区，选区之外的画面原样补回去 —— 用户得看得见这部分真的没丢。
    const keptRanges = useMemo(() => {
        if (mode !== "repaint" || !selection || !durationMs) return [];
        const result: Array<{ startMs: number; endMs: number }> = [];
        if (selection.startMs > 60) result.push({ startMs: 0, endMs: selection.startMs });
        if (durationMs - selection.endMs > 60) result.push({ startMs: selection.endMs, endMs: durationMs });
        return result;
    }, [durationMs, mode, selection]);

    const selectedRange = selectedIndex !== null ? ranges[selectedIndex] : undefined;
    const minSeconds = Math.round(limits.minMs / 1000);
    const maxLimitSeconds = Math.round(limits.maxMs / 1000);

    /**
     * 「只生成这一段」为什么不能用。
     *
     * 已生成的段不放行：单段重跑走的是画布上的节点重试链路，成片要等整批跑完才重合成，
     * 从弹窗里点会得到"段更新了、成片还是旧的"这种半成品状态。宁可指路，不做半套。
     */
    const selectedDone = selectedIndex !== null && doneIndices.has(selectedIndex);
    const oneDisabledReason = (() => {
        if (selectedIndex === null || !selectedRange) return "";
        if (selectedDone) return t("canvas.videoTimeline.reason.oneDone");
        if (requiresCast && !isSegmentRunnable(selectedRange, castNodeIds, requiresCast)) return t("canvas.videoTimeline.reason.segmentNoCast", { index: selectedIndex + 1 });
        return "";
    })();

    return (
        <Modal
            title={
                <div className="flex items-center gap-2">
                    <span className="flex size-7 items-center justify-center rounded-lg bg-indigo-500/10 text-indigo-500 dark:bg-indigo-400/20 dark:text-indigo-400">
                        <Film className="size-4" />
                    </span>
                    <div className="flex flex-col">
                        <span className="text-base font-semibold leading-tight">{t("canvas.videoTimeline.title")}</span>
                        <span className="text-[11px] font-normal text-stone-400">
                            {durationMs ? `${formatDuration(durationMs)} · ${t("canvas.videoTimeline.segmentCount", { count: ranges.length })}` : t("canvas.videoTimeline.subtitle")}
                        </span>
                    </div>
                </div>
            }
            open={open}
            onCancel={onClose}
            centered
            destroyOnHidden
            width={1160}
            footer={
                <div className="flex items-center justify-between gap-3 pt-2">
                    <div className="min-w-0 text-xs text-stone-400">
                        {disabledReason ? (
                            <span className="flex items-center gap-1 text-amber-600 dark:text-amber-400">
                                <AlertTriangle className="size-3.5 shrink-0" />
                                <span className="truncate">{disabledReason}</span>
                            </span>
                        ) : missingIndices.length ? (
                            // 提交不再被"还有段没配"挡住：配好的先跑，剩下的随时回来接。
                            <span className="flex items-center gap-1 text-amber-600 dark:text-amber-400">
                                <Clock3 className="size-3.5 shrink-0" />
                                <span className="truncate">{t("canvas.videoTimeline.partialHint", { count: missingIndices.length, ready: runnableIndices.length })}</span>
                            </span>
                        ) : (
                            <span>{t("canvas.videoTimeline.summary", { count: ranges.length, duration: formatDuration(durationMs) })}</span>
                        )}
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                        <Button onClick={onClose} disabled={submitting}>
                            {t("canvas.videoTimeline.action.cancel")}
                        </Button>
                        <Button type="primary" icon={submitting ? <LoaderCircle className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />} disabled={Boolean(disabledReason) || submitting} onClick={handleSubmit}>
                            {runnableIndices.length < ranges.length
                                ? missingIndices.length
                                    ? t("canvas.videoTimeline.action.generatePartial", { count: runnableIndices.length })
                                    : t("canvas.videoTimeline.action.continuePartial", { count: runnableIndices.length })
                                : mode === "character"
                                  ? t("canvas.videoTimeline.action.generateSegments", { count: ranges.length })
                                  : t("canvas.videoTimeline.action.generateRepaint", { count: ranges.length })}
                        </Button>
                    </div>
                </div>
            }
        >
            {/* 这批没跑完就把话说清楚：差几段、配好后点生成会自动接上，已生成的段不会重跑。
                真正动手的入口只有一个（底部生成按钮），避免两个按钮抢同一件事。 */}
            {pendingBatch && pendingBatch.total > pendingBatch.done ? (
                <div className="mb-3 flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-300">
                    <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                    <span className="flex-1">
                        {t("canvas.videoTimeline.pending.summary", { done: pendingBatch.done, total: pendingBatch.total, remain: pendingBatch.total - pendingBatch.done })}
                        {pendingBatch.runnableRemain === 0 ? <span className="ml-1">{t("canvas.videoTimeline.pending.needConfig")}</span> : null}
                    </span>
                </div>
            ) : null}
            <div className="grid gap-4 py-1 lg:grid-cols-[minmax(0,1fr)_304px]">
                {/* 左：预览 + 时间轴 + 分段轨道 */}
                <div className="space-y-3">
                    <div className="relative overflow-hidden rounded-xl bg-black">
                        <video
                            ref={videoRef}
                            src={src}
                            controls
                            playsInline
                            preload="metadata"
                            className="max-h-[248px] w-full bg-black object-contain"
                            onTimeUpdate={(event) => {
                                const ms = Math.round(event.currentTarget.currentTime * 1000);
                                setCurrentTimeMs(ms);
                                // 选中段时主预览循环播这一段：段与段之间的差异要看动态才看得出来。
                                if (previewIndex !== null) {
                                    const range = rangesRef.current[previewIndex];
                                    if (range && ms >= range.endMs - 40) event.currentTarget.currentTime = range.startMs / 1000;
                                }
                            }}
                            onLoadedMetadata={(event) => {
                                const value = Math.round((event.currentTarget.duration || 0) * 1000);
                                if (value && !durationMs) setDurationMs(value);
                            }}
                        />
                        {previewIndex !== null && ranges[previewIndex] ? (
                            <div className="pointer-events-none absolute left-2 top-2 flex items-center gap-1 rounded bg-indigo-500/90 px-1.5 py-0.5 text-[10px] font-medium text-white">
                                <Play className="size-2.5" />
                                {t("canvas.videoTimeline.track.previewing", { index: previewIndex + 1 })}
                            </div>
                        ) : null}
                    </div>

                    {phase === "analyzing" ? (
                        <div className="flex h-[72px] items-center justify-center gap-2 rounded-lg bg-stone-100 text-xs text-stone-500 dark:bg-stone-900 dark:text-stone-400">
                            <LoaderCircle className="size-3.5 animate-spin" />
                            {t("canvas.videoTimeline.analyzing", { percent: Math.round(analyzeProgress * 100) })}
                        </div>
                    ) : phase === "error" ? (
                        <div className="flex h-[72px] flex-col items-center justify-center gap-1 rounded-lg bg-red-50 text-xs text-red-600 dark:bg-red-950/40 dark:text-red-400">
                            <span>{t("canvas.videoTimeline.analyzeFailed")}</span>
                            <span className="font-mono text-[10px] opacity-70">{errorText}</span>
                        </div>
                    ) : (
                        <CanvasVideoTimeline
                            durationMs={durationMs}
                            frames={frames}
                            cuts={cuts}
                            ranges={ranges}
                            selection={mode === "character" ? null : selection}
                            currentTimeMs={currentTimeMs}
                            onSeek={(timeMs) => {
                                setPreviewIndex(null);
                                seek(timeMs);
                            }}
                            onSelectionChange={setSelection}
                        />
                    )}

                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11px] text-stone-500 dark:text-stone-400">
                        <span className="flex items-center gap-1">
                            <span className="inline-block h-2 w-[2px] bg-amber-400" />
                            {t("canvas.videoTimeline.legend.cut", { count: cuts.length })}
                        </span>
                        <span className="flex items-center gap-1">
                            <span className="inline-block h-2 w-2 rounded-sm border border-blue-400" />
                            {t("canvas.videoTimeline.legend.selection")}
                        </span>
                        <label className="ml-auto flex items-center gap-1.5">
                            {t("canvas.videoTimeline.targetSeconds")}
                            <Input
                                type="number"
                                size="small"
                                min={minSeconds}
                                max={maxLimitSeconds}
                                value={targetSeconds}
                                onChange={(event) => setTargetSeconds(Math.max(minSeconds, Math.min(maxLimitSeconds, Number(event.target.value) || minSeconds)))}
                                className="!w-14"
                            />
                            <span className="text-stone-400">
                                s / {minSeconds}–{maxLimitSeconds}s
                            </span>
                            <Tooltip title={t("canvas.videoTimeline.targetSecondsHint")}>
                                <span className="cursor-help text-stone-400 underline decoration-dotted">?</span>
                            </Tooltip>
                        </label>
                    </div>

                    {mode === "repaint" && selection ? (
                        <div className="rounded-lg border border-stone-200 bg-stone-50/60 p-2.5 dark:border-stone-800 dark:bg-stone-900/60">
                            <div className="mb-1.5 flex items-center justify-between text-[11px]">
                                <span className="font-medium text-stone-600 dark:text-stone-300">{t("canvas.videoTimeline.anchor.title")}</span>
                                <span className="font-mono text-stone-400">
                                    {formatTimecode(selection.startMs)} → {formatTimecode(selection.endMs)}
                                </span>
                            </div>
                            <div className="flex items-center gap-2">
                                <AnchorThumb label={t("canvas.videoTimeline.anchor.first")} src={anchorFrames.first} />
                                <div className="flex-1 text-center text-[10px] leading-relaxed text-stone-400">{t("canvas.videoTimeline.anchor.note")}</div>
                                <AnchorThumb label={t("canvas.videoTimeline.anchor.last")} src={anchorFrames.last} />
                            </div>
                            <div className="mt-1.5 border-t border-stone-200/70 pt-1.5 text-[10px] text-stone-400 dark:border-stone-700/60">
                                <span className="text-emerald-600 dark:text-emerald-400">{t("canvas.videoTimeline.anchor.keep")}</span>
                                <span className="ml-1 font-mono">{keptRanges.length ? keptRanges.map((range) => `${formatTimecode(range.startMs)}–${formatTimecode(range.endMs)}`).join("  ·  ") : t("canvas.videoTimeline.anchor.none")}</span>
                            </div>
                        </div>
                    ) : null}

                    {phase === "ready" ? (
                        <CanvasVideoSegmentTrack
                            ranges={ranges}
                            strips={strips}
                            analyzing={stripsLoading}
                            limits={limits}
                            imageNodes={imageNodes}
                            globalCastIds={castNodeIds}
                            segmentCasts={segmentCasts}
                            selectedIndex={selectedIndex}
                            doneIndices={doneIndices}
                            showCast={mode === "character"}
                            onSelect={handleSelectSegment}
                        />
                    ) : null}

                    {outOfLimits ? (
                        <div className="flex items-start gap-1.5 rounded-md bg-amber-50 px-2 py-1.5 text-[10px] leading-relaxed text-amber-700 dark:bg-amber-500/10 dark:text-amber-300">
                            <AlertTriangle className="mt-px size-3 shrink-0" />
                            <span>{t("canvas.videoTimeline.track.outOfLimitsNote", { count: outOfLimits, min: minSeconds, max: maxLimitSeconds })}</span>
                        </div>
                    ) : null}
                </div>

                {/* 右：全局设置 ⇄ 选中段设置 */}
                <div className="space-y-3">
                    {spec ? (
                        <div className="rounded-lg border border-stone-200 bg-stone-50/70 px-2.5 py-2 text-[11px] leading-relaxed dark:border-stone-800 dark:bg-stone-900/60">
                            <div className="mb-1 flex items-center gap-1 font-medium text-stone-600 dark:text-stone-300">
                                <Film className="size-3" />
                                {t("canvas.videoTimeline.spec.title")}
                            </div>
                            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-0.5">
                                <dt className="text-stone-400">{t("canvas.videoTimeline.spec.workflow")}</dt>
                                <dd className="truncate text-stone-700 dark:text-stone-200" title={spec.workflow}>
                                    {spec.workflow}
                                </dd>
                                <dt className="text-stone-400">{t("canvas.videoTimeline.spec.size")}</dt>
                                <dd className="text-stone-700 dark:text-stone-200">{spec.size}</dd>
                                <dt className="text-stone-400">{t("canvas.videoTimeline.spec.segment")}</dt>
                                <dd className="text-stone-700 dark:text-stone-200">{t("canvas.videoTimeline.spec.segmentValue", { min: Math.round(limits.minMs / 1000), max: Math.round(limits.maxMs / 1000) })}</dd>
                                <dt className="text-stone-400">{t("canvas.videoTimeline.spec.referenceFrames")}</dt>
                                <dd className="text-stone-700 dark:text-stone-200">
                                    {mode === "repaint" || spec.frameWorkflow ? t("canvas.videoTimeline.spec.referenceFramesSent") : t("canvas.videoTimeline.spec.referenceFramesValue")}
                                </dd>
                            </dl>
                            <p className="mt-1 text-[10px] leading-relaxed text-stone-400">{t("canvas.videoTimeline.spec.note")}</p>
                        </div>
                    ) : null}
                    <Segmented
                        block
                        value={mode}
                        onChange={(value) => {
                            setMode(value as VideoEditMode);
                            setSelectedIndex(null);
                            setPreviewIndex(null);
                        }}
                        options={[
                            { value: "character", label: t("canvas.videoTimeline.mode.character"), icon: <UserRound className="size-3.5" /> },
                            { value: "repaint", label: t("canvas.videoTimeline.mode.repaint"), icon: <Wand2 className="size-3.5" /> },
                        ]}
                    />

                    {selectedRange ? (
                        <div className="space-y-2.5">
                            <div className="flex items-center justify-between gap-2">
                                <span className="flex items-center gap-1.5 text-[11px] font-medium text-stone-700 dark:text-stone-200">
                                    <Scissors className="size-3 text-indigo-500" />
                                    {t("canvas.videoTimeline.segment.label", { index: (selectedIndex ?? 0) + 1 })}
                                    <span className="font-mono font-normal text-stone-400">{formatDuration(selectedRange.endMs - selectedRange.startMs)}</span>
                                </span>
                                <Button size="small" type="text" icon={<ChevronLeft className="size-3.5" />} onClick={handleBackToGlobal} className="!px-1.5 !text-[11px]">
                                    {t("canvas.videoTimeline.segment.toGlobal")}
                                </Button>
                            </div>
                            <div className="rounded-md bg-stone-100 px-2 py-1 font-mono text-[10px] text-stone-500 dark:bg-stone-800 dark:text-stone-400">
                                {formatTimecode(selectedRange.startMs)} → {formatTimecode(selectedRange.endMs)}
                            </div>

                            {mode === "character" ? (
                                <div className="space-y-1.5">
                                    <div className="flex items-center justify-between text-[11px]">
                                        <span className="font-medium text-stone-600 dark:text-stone-300">{t("canvas.videoTimeline.segment.castTitle")}</span>
                                        <span className={`text-[10px] ${segmentCasts[selectedIndex ?? 0] ? "text-amber-600 dark:text-amber-400" : "text-stone-400"}`}>
                                            {segmentCasts[selectedIndex ?? 0] ? t("canvas.videoTimeline.segment.overridden") : t("canvas.videoTimeline.segment.followGlobal")}
                                        </span>
                                    </div>
                                    {imageNodes.length ? (
                                        <div className="grid grid-cols-3 gap-1.5">
                                            {imageNodes.map((cast) => {
                                                const active = effectiveCastIds(selectedIndex ?? 0).includes(cast.id);
                                                return (
                                                    <button
                                                        key={cast.id}
                                                        type="button"
                                                        title={cast.title}
                                                        onClick={() => toggleSegmentCast(selectedIndex ?? 0, cast.id)}
                                                        className={`relative overflow-hidden rounded-md border-2 text-left transition ${active ? "border-indigo-500" : "border-transparent opacity-55 hover:opacity-90"}`}
                                                    >
                                                        <span className="block aspect-square overflow-hidden bg-stone-200 dark:bg-stone-700">
                                                            {cast.metadata?.content ? <img src={cast.metadata.content} alt={cast.title} className="size-full object-cover" /> : null}
                                                        </span>
                                                        <span className="block truncate bg-black/55 px-1 py-px text-[9px] leading-tight text-white">{cast.title}</span>
                                                        {active ? (
                                                            // 同样用序号：段级角色顺序也决定 ref_image 顺序。
                                                            <span className="absolute right-0.5 top-0.5 flex size-3.5 items-center justify-center rounded-full bg-indigo-500 text-[9px] font-semibold tabular-nums text-white">
                                                                {effectiveCastIds(selectedIndex ?? 0).indexOf(cast.id) + 1}
                                                            </span>
                                                        ) : null}
                                                    </button>
                                                );
                                            })}
                                        </div>
                                    ) : (
                                        <div className="rounded-md border border-dashed border-stone-300 px-2 py-3 text-center text-[11px] text-stone-400 dark:border-stone-700">{t("canvas.videoTimeline.cast.empty")}</div>
                                    )}
                                    <div className="flex flex-wrap gap-1">
                                        <Button size="small" onClick={() => resetSegmentCast(selectedIndex ?? 0)} disabled={!segmentCasts[selectedIndex ?? 0]}>
                                            {t("canvas.videoTimeline.segment.useGlobal")}
                                        </Button>
                                        <Button size="small" icon={<Users className="size-3" />} onClick={() => promoteSegmentCast(selectedIndex ?? 0)}>
                                            {t("canvas.videoTimeline.segment.applyToAll")}
                                        </Button>
                                    </div>
                                    <p className="text-[10px] leading-relaxed text-stone-400">{t("canvas.videoTimeline.segment.castNote")}</p>
                                </div>
                            ) : null}

                            <div className="space-y-1">
                                <div className="text-[11px] font-medium text-stone-600 dark:text-stone-300">{t("canvas.videoTimeline.segment.promptTitle")}</div>
                                <Input.TextArea
                                    rows={3}
                                    value={segmentPrompts[selectedIndex ?? 0] ?? ""}
                                    onChange={(event) => setSegmentPrompts((previous) => ({ ...previous, [selectedIndex ?? 0]: event.target.value }))}
                                    // placeholder 显示这一段真正会用的那句：段人数跟全局不同时，
                                    // 父组件会自动按段人数套模板，这里如实反映，别让用户以为沿用的是全局那句。
                                    placeholder={ranges[selectedIndex ?? 0]?.prompt || prompt.trim() || (mode === "repaint" ? t("canvas.videoTimeline.prompt.repaint") : t("canvas.videoTimeline.prompt.character"))}
                                    className="text-xs leading-relaxed"
                                />
                                {segmentCastDiff ? <p className="text-[10px] leading-relaxed text-amber-600 dark:text-amber-400">{segmentCastDiff}</p> : null}
                            </div>

                            {/* 单段入口：预览确认 → 只跑这一段。窄栏里竖排比两列更好读，
                                主次也对：先看，再决定跑。 */}
                            <div className="space-y-1.5">
                                <Button size="small" block icon={<Play className="size-3" />} onClick={() => handleSelectSegment(selectedIndex ?? 0)}>
                                    {t("canvas.videoTimeline.track.replay")}
                                </Button>
                                <Button
                                    size="small"
                                    block
                                    type="primary"
                                    icon={submitting ? <LoaderCircle className="size-3 animate-spin" /> : <Sparkles className="size-3" />}
                                    disabled={submitting || Boolean(oneDisabledReason)}
                                    onClick={() => handleSubmitOne(selectedIndex ?? 0)}
                                >
                                    {t("canvas.videoTimeline.action.generateOne", { index: (selectedIndex ?? 0) + 1 })}
                                </Button>
                                {oneDisabledReason ? <p className="text-[10px] leading-relaxed text-amber-600 dark:text-amber-400">{oneDisabledReason}</p> : null}
                            </div>
                        </div>
                    ) : (
                        <div className="space-y-3">
                            <p className="text-[11px] leading-relaxed text-stone-500 dark:text-stone-400">{mode === "repaint" ? t("canvas.videoTimeline.mode.repaintHint") : t("canvas.videoTimeline.mode.characterHint")}</p>

                            {mode === "character" ? (
                                <div className="space-y-1.5">
                                    <div className="flex items-center justify-between text-[11px] font-medium text-stone-600 dark:text-stone-300">
                                        <span>{t("canvas.videoTimeline.cast.title")}</span>
                                        <span className="font-normal text-stone-400">{t("canvas.videoTimeline.cast.selected", { count: castNodeIds.length })}</span>
                                    </div>
                                    {imageNodes.length ? (
                                        <div className="grid max-h-[168px] grid-cols-3 gap-1.5 overflow-y-auto pr-0.5">
                                            {imageNodes.map((imageNode) => {
                                                const active = castNodeIds.includes(imageNode.id);
                                                return (
                                                    <button
                                                        key={imageNode.id}
                                                        type="button"
                                                        title={imageNode.title}
                                                        onClick={() => setCastNodeIds((prev) => (prev.includes(imageNode.id) ? prev.filter((id) => id !== imageNode.id) : [...prev, imageNode.id]))}
                                                        className={`relative overflow-hidden rounded-md border-2 text-left transition ${active ? "border-indigo-500" : "border-transparent opacity-55 hover:opacity-90"}`}
                                                    >
                                                        <span className="block aspect-square overflow-hidden bg-stone-200 dark:bg-stone-700">
                                                            <img src={imageNode.metadata?.content} alt={imageNode.title} className="size-full object-cover" />
                                                        </span>
                                                        <span className="block truncate bg-black/55 px-1 py-px text-[9px] leading-tight text-white">{imageNode.title}</span>
                                                        {active ? (
                                                            // 角标用序号而不是对勾：提示词里写的是"参考图 1、参考图 2"，
                                                            // 序号在这张图上，用户才对得上自己写的是哪一张。
                                                            <span className="absolute right-0.5 top-0.5 flex size-3.5 items-center justify-center rounded-full bg-indigo-500 text-[9px] font-semibold tabular-nums text-white">
                                                                {castNodeIds.indexOf(imageNode.id) + 1}
                                                            </span>
                                                        ) : null}
                                                    </button>
                                                );
                                            })}
                                        </div>
                                    ) : (
                                        <div className="rounded-md border border-dashed border-stone-300 px-2 py-3 text-center text-[11px] text-stone-400 dark:border-stone-700">{t("canvas.videoTimeline.cast.empty")}</div>
                                    )}
                                    <p className="text-[10px] leading-relaxed text-stone-400">{t("canvas.videoTimeline.cast.hint")}</p>
                                </div>
                            ) : null}

                            <div className="space-y-1">
                                <div className="flex items-center justify-between gap-2">
                                    <span className="text-[11px] font-medium text-stone-600 dark:text-stone-300">{t("canvas.videoTimeline.prompt.label")}</span>
                                    {mode === "character" ? (
                                        promptCountMismatch ? (
                                            <Tooltip title={t("canvas.videoTimeline.prompt.refillHint", { count: castNodeIds.length })}>
                                                <button type="button" className="shrink-0 text-[10px] font-medium text-amber-600 underline decoration-dotted dark:text-amber-400" onClick={refillPrompt}>
                                                    {t("canvas.videoTimeline.prompt.refill", { count: castNodeIds.length })}
                                                </button>
                                            </Tooltip>
                                        ) : usingCustomTemplate ? (
                                            <Tooltip title={t("canvas.videoTimeline.prompt.customHint")}>
                                                <span className="shrink-0 cursor-help text-[10px] font-medium text-indigo-500 dark:text-indigo-400">{t("canvas.videoTimeline.prompt.customBadge")}</span>
                                            </Tooltip>
                                        ) : autoTemplate ? (
                                            <Tooltip title={t("canvas.videoTimeline.prompt.autoHint")}>
                                                <span className="shrink-0 cursor-help text-[10px] text-stone-400">{t("canvas.videoTimeline.prompt.autoFilled")}</span>
                                            </Tooltip>
                                        ) : null
                                    ) : null}
                                </div>
                                <Input.TextArea
                                    rows={6}
                                    value={prompt}
                                    onChange={(event) => {
                                        setPrompt(event.target.value);
                                        if (promptSaveFailed) setPromptSaveFailed(false);
                                    }}
                                    placeholder={mode === "repaint" ? t("canvas.videoTimeline.prompt.repaint") : t("canvas.videoTimeline.prompt.character")}
                                    className="text-xs leading-relaxed"
                                />
                                {mode === "character" ? (
                                    <div className="flex items-start justify-between gap-2">
                                        <p className="flex-1 text-[10px] leading-relaxed text-stone-400">{promptSaveFailed ? t("canvas.videoTimeline.prompt.saveFailed") : t("canvas.videoTimeline.prompt.editHint")}</p>
                                        {castNodeIds.length > 0 ? (
                                            <div className="flex shrink-0 flex-col items-end gap-0.5">
                                                {promptIsSavedDefault ? (
                                                    <span className="text-[10px] text-emerald-600 dark:text-emerald-400">{t("canvas.videoTimeline.prompt.savedDefault")}</span>
                                                ) : promptDirty ? (
                                                    <button type="button" className="text-[10px] font-medium text-indigo-600 underline decoration-dotted dark:text-indigo-400" onClick={savePromptAsDefault}>
                                                        {usingCustomTemplate ? t("canvas.videoTimeline.prompt.updateDefault") : t("canvas.videoTimeline.prompt.saveDefault")}
                                                    </button>
                                                ) : null}
                                                {usingCustomTemplate || promptDirty ? (
                                                    <button type="button" className="text-[10px] text-stone-400 underline decoration-dotted" onClick={restoreBuiltInPrompt}>
                                                        {t("canvas.videoTimeline.prompt.restoreBuiltIn")}
                                                    </button>
                                                ) : null}
                                            </div>
                                        ) : null}
                                    </div>
                                ) : null}
                            </div>

                            <div className="space-y-1.5 rounded-md bg-stone-50 p-2 dark:bg-stone-900/60">
                                <div className="flex items-center justify-between text-[11px] text-stone-600 dark:text-stone-300">
                                    <span className="flex items-center gap-1">
                                        {t("canvas.videoTimeline.crossfade.label")}
                                        <Tooltip title={t("canvas.videoTimeline.crossfade.hint")}>
                                            <span className="cursor-help text-stone-400">?</span>
                                        </Tooltip>
                                    </span>
                                    <Input type="number" size="small" min={0} max={12} value={crossfadeFrames} onChange={(event) => setCrossfadeFrames(Math.max(0, Math.min(12, Number(event.target.value) || 0)))} className="!w-14" />
                                </div>
                                <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-stone-600 dark:text-stone-300">
                                    <input type="checkbox" checked={keepAudio} onChange={(event) => setKeepAudio(event.target.checked)} className="size-3 accent-indigo-500" />
                                    {t("canvas.videoTimeline.audio.keep")}
                                </label>
                            </div>

                            <p className="text-[10px] leading-relaxed text-stone-400">{t("canvas.videoTimeline.segment.pickHint")}</p>
                        </div>
                    )}
                </div>
            </div>
        </Modal>
    );
}

function AnchorThumb({ label, src }: { label: string; src?: string }) {
    return (
        <div className="w-[84px] shrink-0">
            <div className="aspect-video overflow-hidden rounded border border-stone-200 bg-stone-200 dark:border-stone-700 dark:bg-stone-800">
                {src ? <img src={src} alt={label} className="size-full object-cover" /> : null}
            </div>
            <div className="mt-0.5 text-center text-[9px] text-stone-400">{label}</div>
        </div>
    );
}
