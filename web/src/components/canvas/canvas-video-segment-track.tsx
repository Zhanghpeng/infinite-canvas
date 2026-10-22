import { AlertTriangle, CheckCircle2, Scissors } from "lucide-react";
import { useTranslation } from "react-i18next";

import { formatTimecode, isRangeWithinLimits, type SegmentLimits, type SegmentPlan } from "@/lib/canvas/video-timeline";
import type { CanvasNodeData } from "@/types/canvas";

export type SegmentTrackProps = {
    /** 当前分段计划。段号即下标，与 segmentCasts 的 key 对应。 */
    ranges: SegmentPlan[];
    /** 每段的三帧缩略（起点 / 中段 / 尾帧）；还没抽到时为空数组。 */
    strips: string[][];
    /** 正在抽帧：段卡显示骨架而不是空白。 */
    analyzing: boolean;
    /** 模型能接受的单段区间，用来给每段打合规标。 */
    limits: SegmentLimits;
    /** 画布上可做角色参考的图片节点。 */
    imageNodes: CanvasNodeData[];
    /** 全局角色集合：段没覆盖时用它。 */
    globalCastIds: string[];
    segmentCasts: Record<number, string[]>;
    selectedIndex: number | null;
    /** 这批里已经生成好的段：卡面打"已生成"，提交时会跳过它们。 */
    doneIndices?: Set<number>;
    /** 角色替换模式才在段卡上显示角色。 */
    showCast: boolean;
    onSelect: (index: number) => void;
};

/**
 * 分段轨道：把每一段摊成一张卡，横排铺开。
 *
 * 之前分段只是一列 56px 缩略图 + 24px 头像，用户看不出「这段里有几个人」，
 * 而角色替换要正对不同段挂不同参考图 —— 看不清就只能整批试错。
 * 现在每段给三帧（起 / 中 / 尾）+ 合规标记 + 已挂角色，判断依据都在卡面上。
 */
export function CanvasVideoSegmentTrack({ ranges, strips, analyzing, limits, imageNodes, globalCastIds, segmentCasts, selectedIndex, doneIndices, showCast, onSelect }: SegmentTrackProps) {
    const { t } = useTranslation();

    if (!ranges.length) {
        return <div className="rounded-lg border border-dashed border-stone-300 px-3 py-4 text-center text-[11px] text-stone-400 dark:border-stone-700">{t("canvas.videoTimeline.reason.noRange")}</div>;
    }

    return (
        <div className="space-y-1.5">
            <div className="flex items-center justify-between text-[11px]">
                <span className="flex items-center gap-1 font-medium text-stone-600 dark:text-stone-300">
                    <Scissors className="size-3 text-stone-400" />
                    {t("canvas.videoTimeline.track.title")}
                </span>
                <span className="text-stone-400">{t("canvas.videoTimeline.track.limits", { min: Math.round(limits.minMs / 1000), max: Math.round(limits.maxMs / 1000) })}</span>
            </div>
            <div className="flex gap-2 overflow-x-auto pb-1.5 pr-0.5">
                {ranges.map((range, index) => {
                    const frames = strips[index] ?? [];
                    const activeCast = (segmentCasts[index] ?? globalCastIds).map((id) => imageNodes.find((item) => item.id === id)).filter((item): item is CanvasNodeData => Boolean(item));
                    const lengthMs = range.endMs - range.startMs;
                    const within = isRangeWithinLimits(range, limits);
                    const selected = selectedIndex === index;
                    const done = Boolean(doneIndices?.has(index));
                    return (
                        <button
                            key={`${range.startMs}-${range.endMs}-${index}`}
                            type="button"
                            onClick={() => onSelect(index)}
                            title={t("canvas.videoTimeline.track.selectHint")}
                            className={`group w-[156px] shrink-0 overflow-hidden rounded-lg border-2 bg-white text-left transition dark:bg-stone-900 ${
                                selected ? "border-indigo-500 shadow-sm" : "border-stone-200 hover:border-stone-300 dark:border-stone-700 dark:hover:border-stone-600"
                            }`}
                        >
                            <div className="relative aspect-video w-full overflow-hidden bg-stone-200 dark:bg-stone-800">
                                {frames.length ? (
                                    <div className="flex size-full">
                                        {frames.map((frame, frameIndex) => (
                                            <img key={frameIndex} src={frame} alt="" className="h-full w-1/3 object-cover" />
                                        ))}
                                    </div>
                                ) : (
                                    <div className={`size-full ${analyzing ? "animate-pulse bg-stone-300/70 dark:bg-stone-700/70" : ""}`} />
                                )}
                                <span className="absolute left-1 top-1 rounded bg-black/60 px-1 py-px text-[9px] font-medium text-white">{t("canvas.videoTimeline.node.segmentBadge", { index: index + 1 })}</span>
                                {done ? (
                                    <span className="absolute bottom-1 left-1 flex items-center gap-0.5 rounded bg-emerald-500/90 px-1 py-px text-[9px] font-medium text-white">
                                        <CheckCircle2 className="size-2.5" />
                                        {t("canvas.videoTimeline.track.done")}
                                    </span>
                                ) : null}
                                <span
                                    className={`absolute right-1 top-1 flex items-center gap-0.5 rounded px-1 py-px text-[9px] font-medium ${
                                        within ? "bg-emerald-500/85 text-white" : "bg-red-500/90 text-white"
                                    }`}
                                    title={within ? t("canvas.videoTimeline.track.withinLimits") : t("canvas.videoTimeline.track.outOfLimits", { min: Math.round(limits.minMs / 1000), max: Math.round(limits.maxMs / 1000) })}
                                >
                                    {within ? <CheckCircle2 className="size-2.5" /> : <AlertTriangle className="size-2.5" />}
                                    {(lengthMs / 1000).toFixed(1)}s
                                </span>
                            </div>
                            <div className="space-y-1 px-1.5 py-1.5">
                                <div className="font-mono text-[10px] leading-none text-stone-400">
                                    {formatTimecode(range.startMs)}–{formatTimecode(range.endMs)}
                                </div>
                                {showCast ? (
                                    <div className="flex h-4 items-center gap-0.5">
                                        {activeCast.length ? (
                                            activeCast.slice(0, 4).map((cast) => (
                                                <span key={cast.id} title={cast.title} className="size-4 overflow-hidden rounded-full border border-white/70 dark:border-stone-800">
                                                    <img src={cast.metadata?.content} alt={cast.title} className="size-full object-cover" />
                                                </span>
                                            ))
                                        ) : (
                                            <span className="text-[9px] text-amber-600 dark:text-amber-400">{t("canvas.videoTimeline.track.noCast")}</span>
                                        )}
                                        {activeCast.length > 4 ? <span className="text-[9px] text-stone-400">+{activeCast.length - 4}</span> : null}
                                        {segmentCasts[index] ? <span className="ml-auto rounded bg-amber-200/70 px-0.5 text-[8px] leading-tight text-amber-800 dark:bg-amber-500/25 dark:text-amber-300">{t("canvas.videoTimeline.segment.overridden")}</span> : null}
                                    </div>
                                ) : null}
                            </div>
                        </button>
                    );
                })}
            </div>
        </div>
    );
}
