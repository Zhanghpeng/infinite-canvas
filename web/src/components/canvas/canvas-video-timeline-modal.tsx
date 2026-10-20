import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Film, LoaderCircle, Scissors, Sparkles, UserRound, Wand2 } from "lucide-react";
import { Button, Input, Modal, Segmented, Tooltip } from "antd";
import { useTranslation } from "react-i18next";

import { CanvasVideoTimeline, type TimelineSelection } from "./canvas-video-timeline";
import { buildFilmstrip, captureFrameDataUrl, detectVideoScenes } from "@/lib/canvas/video-scene-detect";
import { DEFAULT_MAX_SEGMENT_MS, formatDuration, formatTimecode, planSegments, planSelectionRanges, type SceneCut, type SegmentPlan, type VideoRange } from "@/lib/canvas/video-timeline";
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
    /** 分段计划：每段可覆盖全局角色集合。 */
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
};

type CanvasVideoTimelineModalProps = {
    open: boolean;
    node: CanvasNodeData | null;
    /** 画布上可做角色参考的图片节点。 */
    imageNodes: CanvasNodeData[];
    submitting: boolean;
    onClose: () => void;
    onSubmit: (plan: VideoEditPlan) => void;
};

type Phase = "idle" | "analyzing" | "ready" | "error";

export function CanvasVideoTimelineModal({ open, node, imageNodes, submitting, onClose, onSubmit }: CanvasVideoTimelineModalProps) {
    const { t } = useTranslation();
    const videoRef = useRef<HTMLVideoElement>(null);

    const [phase, setPhase] = useState<Phase>("idle");
    const [analyzeProgress, setAnalyzeProgress] = useState(0);
    const [errorText, setErrorText] = useState("");
    const [durationMs, setDurationMs] = useState(0);
    const [frames, setFrames] = useState<{ timeMs: number; dataUrl: string }[]>([]);
    const [cuts, setCuts] = useState<SceneCut[]>([]);
    const [mode, setMode] = useState<VideoEditMode>("repaint");
    const [selection, setSelection] = useState<TimelineSelection | null>(null);
    const [currentTimeMs, setCurrentTimeMs] = useState(0);
    const [maxSeconds, setMaxSeconds] = useState(DEFAULT_MAX_SEGMENT_MS / 1000);
    const [prompt, setPrompt] = useState("");
    const [castNodeIds, setCastNodeIds] = useState<string[]>([]);
    const [crossfadeFrames, setCrossfadeFrames] = useState(3);
    const [keepAudio, setKeepAudio] = useState(true);
    /** 段级角色覆盖：key 是段在 ranges 里的下标。 */
    const [segmentCasts, setSegmentCasts] = useState<Record<number, string[]>>({});
    const [anchorFrames, setAnchorFrames] = useState<{ first?: string; last?: string }>({});

    const src = node?.metadata?.content || "";

    // 打开时重置并做一次画面分析：抽帧带 + 场景切点。
    useEffect(() => {
        if (!open || !src) return;
        let cancelled = false;
        setPhase("analyzing");
        setAnalyzeProgress(0);
        setErrorText("");
        setFrames([]);
        setCuts([]);
        setSelection(null);
        setAnchorFrames({});
        setPrompt("");
        setCastNodeIds([]);

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
                const strip = await buildFilmstrip(src, Math.min(24, Math.max(8, Math.round(scene.durationMs / 1000))), { width: 128 });
                if (cancelled) return;
                setFrames(strip.frames);
                // 默认选区：落在最长的一段里，省得用户自己去猜哪里有内容。
                const initialPlan = planSegments(scene.durationMs, scene.cuts, { maxMs: DEFAULT_MAX_SEGMENT_MS });
                const longest = initialPlan.reduce<VideoRange | null>((best, range) => (!best || range.endMs - range.startMs > best.endMs - best.startMs ? range : best), null);
                if (longest) setSelection({ startMs: longest.startMs, endMs: longest.endMs });
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
    }, [open, src]);

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

    const ranges = useMemo<SegmentPlan[]>(() => {
        if (!durationMs) return [];
        const maxMs = Math.max(1000, maxSeconds * 1000);
        const base: VideoRange[] =
            mode === "character" ? planSegments(durationMs, cuts, { maxMs }) : selection ? planSelectionRanges(selection.startMs, selection.endMs, cuts, { maxMs }) : [];
        // 段级角色覆盖：切点只按画面变化算，算不出"这段里有几个人"。
        // 不覆盖的段跟随全局角色，避免每段都要重选一遍。
        return base.map((range, index) => (segmentCasts[index] ? { ...range, castNodeIds: segmentCasts[index] } : range));
    }, [cuts, durationMs, maxSeconds, mode, selection, segmentCasts]);

    /** 段起始处最接近的抽帧，用来让人一眼看出这段里有几个人。 */
    const segmentThumb = useCallback(
        (timeMs: number) => {
            if (!frames.length) return undefined;
            return frames.reduce((best, frame) => (Math.abs(frame.timeMs - timeMs) < Math.abs(best.timeMs - timeMs) ? frame : best), frames[0]).dataUrl;
        },
        [frames],
    );

    /** 这一段当前生效的角色：有覆盖就用覆盖，否则跟随全局。 */
    const effectiveCastIds = useCallback(
        (index: number) => segmentCasts[index] ?? castNodeIds,
        [castNodeIds, segmentCasts],
    );

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

    const seek = useCallback((timeMs: number) => {
        const video = videoRef.current;
        setCurrentTimeMs(timeMs);
        if (video) video.currentTime = Math.min(durationMs / 1000, Math.max(0, timeMs / 1000));
    }, [durationMs]);

    const handleSubmit = useCallback(() => {
        if (!ranges.length) return;
        // 选区端点通常已经被时间轴吸到切点上，这里再判一次：落在切点上就说明边界本来就没有连续性。
        const atCut = (timeMs: number) => cuts.some((cut) => Math.abs(cut.timeMs - timeMs) <= 80);
        onSubmit({
            mode: mode === "repaint" ? "repaint" : "character-swap",
            ranges,
            durationMs,
            startAtCut: atCut(ranges[0].startMs),
            endAtCut: atCut(ranges[ranges.length - 1].endMs),
            castNodeIds,
            prompt: prompt.trim(),
            crossfadeFrames,
            keepAudio,
        });
    }, [castNodeIds, crossfadeFrames, cuts, durationMs, keepAudio, mode, onSubmit, prompt, ranges]);

    const disabledReason = useMemo(() => {
        if (phase !== "ready" || !ranges.length) return t("canvas.videoTimeline.reason.noRange");
        if (mode === "character" && !castNodeIds.length) return t("canvas.videoTimeline.reason.noCast");
        return "";
    }, [castNodeIds.length, mode, phase, ranges.length, t]);

    // 局部重绘只重建选区，选区之外的画面原样补回去 —— 用户得看得见这部分真的没丢。
    const keptRanges = useMemo(() => {
        if (mode !== "repaint" || !selection || !durationMs) return [];
        const result: Array<{ startMs: number; endMs: number }> = [];
        if (selection.startMs > 60) result.push({ startMs: 0, endMs: selection.startMs });
        if (durationMs - selection.endMs > 60) result.push({ startMs: selection.endMs, endMs: durationMs });
        return result;
    }, [durationMs, mode, selection]);

    /** 成片时长：两种模式都以源片长度为基准，淡化和拼接都不改变总长。 */
    const outputDurationMs = durationMs;

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
            width={960}
            footer={
                <div className="flex items-center justify-between gap-3 pt-2">
                    <div className="min-w-0 text-xs text-stone-400">
                        {disabledReason ? (
                            <span className="flex items-center gap-1 text-amber-600 dark:text-amber-400">
                                <AlertTriangle className="size-3.5 shrink-0" />
                                <span className="truncate">{disabledReason}</span>
                            </span>
                        ) : (
                            <span>
                                {t("canvas.videoTimeline.summary", {
                                    count: ranges.length,
                                    duration: formatDuration(outputDurationMs),
                                })}
                            </span>
                        )}
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                        <Button onClick={onClose} disabled={submitting}>
                            {t("canvas.videoTimeline.action.cancel")}
                        </Button>
                        <Button type="primary" icon={submitting ? <LoaderCircle className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />} disabled={Boolean(disabledReason) || submitting} onClick={handleSubmit}>
                            {mode === "character" ? t("canvas.videoTimeline.action.generateSegments", { count: ranges.length }) : t("canvas.videoTimeline.action.generateRepaint", { count: ranges.length })}
                        </Button>
                    </div>
                </div>
            }
        >
            <div className="grid gap-4 py-1 lg:grid-cols-[minmax(0,1fr)_260px]">
                {/* 左：预览 + 时间轴 */}
                <div className="space-y-3">
                    <div className="overflow-hidden rounded-xl bg-black">
                        <video
                            ref={videoRef}
                            src={src}
                            controls
                            playsInline
                            preload="metadata"
                            className="max-h-[260px] w-full bg-black object-contain"
                            onTimeUpdate={(event) => setCurrentTimeMs(Math.round(event.currentTarget.currentTime * 1000))}
                            onLoadedMetadata={(event) => {
                                const value = Math.round((event.currentTarget.duration || 0) * 1000);
                                if (value && !durationMs) setDurationMs(value);
                            }}
                        />
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
                            ranges={mode === "character" ? ranges : planSegments(durationMs, cuts, { maxMs: Math.max(1000, maxSeconds * 1000) })}
                            selection={mode === "character" ? null : selection}
                            currentTimeMs={currentTimeMs}
                            onSeek={seek}
                            onSelectionChange={setSelection}
                        />
                    )}

                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11px] text-stone-500 dark:text-stone-400">
                        <span className="flex items-center gap-1">
                            <span className="inline-block h-2 w-[2px] bg-amber-400" />
                            {t("canvas.videoTimeline.legend.cut", { count: cuts.length })}
                        </span>
                        <span className="flex items-center gap-1">
                            <span className="inline-block h-2 w-px bg-white/60" />
                            {t("canvas.videoTimeline.legend.boundary")}
                        </span>
                        <span className="flex items-center gap-1">
                            <span className="inline-block h-2 w-2 rounded-sm border border-blue-400" />
                            {t("canvas.videoTimeline.legend.selection")}
                        </span>
                        <label className="ml-auto flex items-center gap-1.5">
                            {t("canvas.videoTimeline.maxSeconds")}
                            <Input
                                type="number"
                                size="small"
                                min={2}
                                max={20}
                                value={maxSeconds}
                                onChange={(event) => setMaxSeconds(Math.max(2, Math.min(20, Number(event.target.value) || 2)))}
                                className="!w-14"
                            />
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
                                <span className="ml-1 font-mono">
                                    {keptRanges.length ? keptRanges.map((range) => `${formatTimecode(range.startMs)}–${formatTimecode(range.endMs)}`).join("  ·  ") : t("canvas.videoTimeline.anchor.none")}
                                </span>
                            </div>
                        </div>
                    ) : null}
                </div>

                {/* 右：模式 + 角色 + 提示词 */}
                <div className="space-y-3">
                    <Segmented
                        block
                        value={mode}
                        onChange={(value) => setMode(value as VideoEditMode)}
                        options={[
                            { value: "repaint", label: t("canvas.videoTimeline.mode.repaint"), icon: <Wand2 className="size-3.5" /> },
                            { value: "character", label: t("canvas.videoTimeline.mode.character"), icon: <UserRound className="size-3.5" /> },
                        ]}
                    />
                    <p className="text-[11px] leading-relaxed text-stone-500 dark:text-stone-400">{mode === "repaint" ? t("canvas.videoTimeline.mode.repaintHint") : t("canvas.videoTimeline.mode.characterHint")}</p>

                    {mode === "character" ? (
                        <div className="space-y-1.5">
                            <div className="flex items-center justify-between text-[11px] font-medium text-stone-600 dark:text-stone-300">
                                <span>{t("canvas.videoTimeline.cast.title")}</span>
                                <span className="font-normal text-stone-400">{t("canvas.videoTimeline.cast.selected", { count: castNodeIds.length })}</span>
                            </div>
                            {imageNodes.length ? (
                                <div className="grid max-h-[132px] grid-cols-4 gap-1.5 overflow-y-auto pr-0.5">
                                    {imageNodes.map((imageNode) => {
                                        const active = castNodeIds.includes(imageNode.id);
                                        return (
                                            <button
                                                key={imageNode.id}
                                                type="button"
                                                title={imageNode.title}
                                                onClick={() => setCastNodeIds((prev) => (prev.includes(imageNode.id) ? prev.filter((id) => id !== imageNode.id) : [...prev, imageNode.id]))}
                                                className={`group relative aspect-square overflow-hidden rounded-md border-2 transition ${active ? "border-indigo-500" : "border-transparent hover:border-stone-300 dark:hover:border-stone-700"}`}
                                            >
                                                <img src={imageNode.metadata?.content} alt={imageNode.title} className="size-full object-cover" />
                                                {active ? (
                                                    <span className="absolute right-0.5 top-0.5 flex size-3.5 items-center justify-center rounded-full bg-indigo-500 text-white">
                                                        <CheckCircle2 className="size-2.5" />
                                                    </span>
                                                ) : null}
                                                <span className="absolute inset-x-0 bottom-0 truncate bg-black/55 px-1 py-px text-[9px] text-white">{imageNode.title}</span>
                                            </button>
                                        );
                                    })}
                                </div>
                            ) : (
                                <div className="rounded-md border border-dashed border-stone-300 px-2 py-3 text-center text-[11px] text-stone-400 dark:border-stone-700">{t("canvas.videoTimeline.cast.empty")}</div>
                            )}
                            <p className="text-[10px] leading-relaxed text-stone-400">{t("canvas.videoTimeline.cast.hint")}</p>
                        </div>
                    ) : (
                        <div className="space-y-1">
                            <div className="flex items-center justify-between">
                                <span className="text-[11px] font-medium text-stone-600 dark:text-stone-300">{t("canvas.videoTimeline.segment.title")}</span>
                                <span className="text-[10px] text-stone-400">{t("canvas.videoTimeline.segment.castHint")}</span>
                            </div>
                            <div className="max-h-[240px] space-y-1.5 overflow-y-auto pr-0.5">
                                {ranges.length ? (
                                    ranges.map((range, index) => {
                                        const activeIds = effectiveCastIds(index);
                                        const overridden = Boolean(segmentCasts[index]);
                                        return (
                                            <div key={`${range.startMs}-${range.endMs}`} className="rounded-md bg-stone-100 p-1.5 dark:bg-stone-800">
                                                <button
                                                    type="button"
                                                    onClick={() => seek(range.startMs)}
                                                    className="flex w-full items-center gap-2 text-left"
                                                >
                                                    <SegmentThumb src={segmentThumb(range.startMs)} />
                                                    <span className="flex flex-1 flex-col">
                                                        <span className="flex items-center gap-1.5 text-[11px] text-stone-600 dark:text-stone-300">
                                                            <Scissors className="size-3 text-stone-400" />
                                                            {t("canvas.videoTimeline.segment.label", { index: index + 1 })}
                                                            {overridden ? <span className="rounded bg-amber-200/70 px-1 text-[9px] text-amber-800 dark:bg-amber-500/25 dark:text-amber-300">{t("canvas.videoTimeline.segment.overridden")}</span> : null}
                                                        </span>
                                                        <span className="font-mono text-[10px] text-stone-400">
                                                            {formatTimecode(range.startMs)} · {((range.endMs - range.startMs) / 1000).toFixed(1)}s
                                                        </span>
                                                    </span>
                                                </button>
                                                {/* 切点只按画面变化算，算不出这段里有几个人。逐个勾，模型才不会被
                                                            塞进画面里并不存在的人。 */}
                                                <div className="mt-1.5 flex flex-wrap gap-1">
                                                    {imageNodes.map((cast) => {
                                                        const active = activeIds.includes(cast.id);
                                                        return (
                                                            <button
                                                                key={cast.id}
                                                                type="button"
                                                                title={cast.title}
                                                                onClick={() => toggleSegmentCast(index, cast.id)}
                                                                className={`size-6 overflow-hidden rounded-full border-2 transition ${active ? "border-emerald-500 opacity-100" : "border-transparent opacity-40 hover:opacity-70"}`}
                                                            >
                                                                {cast.metadata?.content ? <img src={cast.metadata.content} alt={cast.title} className="size-full object-cover" /> : <span className="block size-full bg-stone-300 dark:bg-stone-600" />}
                                                            </button>
                                                        );
                                                    })}
                                                </div>
                                            </div>
                                        );
                                    })
                                ) : (
                                    <div className="py-2 text-center text-[11px] text-stone-400">{t("canvas.videoTimeline.reason.noRange")}</div>
                                )}
                            </div>
                        </div>
                    )}

                    <div className="space-y-1">
                        <div className="text-[11px] font-medium text-stone-600 dark:text-stone-300">{t("canvas.videoTimeline.prompt.label")}</div>
                        <Input.TextArea
                            rows={3}
                            value={prompt}
                            onChange={(event) => setPrompt(event.target.value)}
                            placeholder={mode === "repaint" ? t("canvas.videoTimeline.prompt.repaint") : t("canvas.videoTimeline.prompt.character")}
                            className="text-xs leading-relaxed"
                        />
                    </div>

                    <div className="space-y-1.5 rounded-md bg-stone-50 p-2 dark:bg-stone-900/60">
                        <div className="flex items-center justify-between text-[11px] text-stone-600 dark:text-stone-300">
                            <span className="flex items-center gap-1">
                                {t("canvas.videoTimeline.crossfade.label")}
                                <Tooltip title={t("canvas.videoTimeline.crossfade.hint")}>
                                    <span className="cursor-help text-stone-400">?</span>
                                </Tooltip>
                            </span>
                            <Input
                                type="number"
                                size="small"
                                min={0}
                                max={12}
                                value={crossfadeFrames}
                                onChange={(event) => setCrossfadeFrames(Math.max(0, Math.min(12, Number(event.target.value) || 0)))}
                                className="!w-14"
                            />
                        </div>
                        <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-stone-600 dark:text-stone-300">
                            <input type="checkbox" checked={keepAudio} onChange={(event) => setKeepAudio(event.target.checked)} className="size-3 accent-indigo-500" />
                            {t("canvas.videoTimeline.audio.keep")}
                        </label>
                    </div>
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

/** 段列表里的小缩略图：段起点的抽帧，用来判断这段里有几个人。 */
function SegmentThumb({ src }: { src?: string }) {
    return (
        <div className="aspect-video w-[56px] shrink-0 overflow-hidden rounded bg-stone-200 dark:bg-stone-700">
            {src ? <img src={src} alt="" className="size-full object-cover" /> : null}
        </div>
    );
}
