import { Film, Image as ImageIcon, Users } from "lucide-react";
import { useTranslation } from "react-i18next";

import { canvasThemes } from "@/lib/canvas-theme";
import { formatTimecode } from "@/lib/canvas/video-timeline";
import { videoSizeLabel } from "@/components/video-settings-panel";
import { findWorkflow, useEffectiveConfig } from "@/stores/use-config-store";
import { useThemeStore } from "@/stores/use-theme-store";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

/**
 * 段节点的「参考内容」清单。
 *
 * 段节点吃进去的参考有两类，但两类都不体现为画布连线：从原片切出来的参考视频，
 * 以及运行时拼出来的参考图集（角色图；只有首尾帧类工作流才会额外带两张原片帧）。
 * 结果就是点开一段只能看到画面和一句提示词 —— 用户没法核对"模型到底喂了谁、
 * 喂了哪几张图"，更没法判断改提示词重跑有没有意义。
 *
 * 这里把 metadata 里记下的那份参考按模型看到的顺序摊开：角色图在前（ref_image_01..0N），
 * 顺序本身就是信息，所以不用网格而用带序号的一行。
 * 首尾帧仅对旧批次显示 —— 现在的 omni 链路一张原片帧都不送。
 */
export function CanvasVideoSegmentReference({ node, nodes, onLocateNode }: { node: CanvasNodeData; nodes: CanvasNodeData[]; onLocateNode?: (nodeId: string) => void }) {
    const { t } = useTranslation();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const globalConfig = useEffectiveConfig();
    const segment = node.metadata?.videoSegment;
    if (!segment) return null;

    const durationMs = Math.max(0, segment.endMs - segment.startMs);
    const seconds = (durationMs / 1000).toFixed(1);
    const clipNodeId = segment.referenceClip?.nodeId;
    // 兜底按区间反查：这一轮之前生成的段节点没记 referenceClip.nodeId，
    // 但画布上那条参考片段一直都在（referenceClip 节点保留了来源与区间）。
    // 不兜底的话，老段节点会显示"参考片段节点已被删除"——纯属吓人。
    const clipNode =
        (clipNodeId ? nodes.find((item) => item.id === clipNodeId && item.type === CanvasNodeType.Video) : undefined) ??
        nodes.find(
            (item) =>
                item.type === CanvasNodeType.Video &&
                item.metadata?.referenceClip?.sourceNodeId === segment.sourceNodeId &&
                item.metadata.referenceClip.startMs === segment.startMs &&
                item.metadata.referenceClip.endMs === segment.endMs,
        );
    const clipSrc = clipNode?.metadata?.content || segment.referenceClip?.url;

    // 快照优先：角色节点被删掉后，只剩快照能说清"当时喂的是哪几张"。
    const castItems = (segment.castSnapshot?.length
        ? segment.castSnapshot
        : (segment.castNodeIds ?? []).map((id) => {
              const castNode = nodes.find((item) => item.id === id);
              return { nodeId: id, title: castNode?.title, url: castNode?.metadata?.content };
          })
    ).map((item) => {
        // 用当前节点的图，快照的 url 只作兜底：节点被换图后，面板要显示现在会喂的那张。
        const liveNode = nodes.find((entry) => entry.id === item.nodeId);
        const url = liveNode?.metadata?.content || item.url;
        return { ...item, url, missing: !url, title: liveNode?.title || item.title };
    });
    const missingCount = castItems.filter((item) => item.missing).length;

    const headMs = segment.anchor?.headFrameMs ?? segment.anchor?.firstFrameMs ?? segment.startMs;
    const tailMs = segment.anchor?.tailFrameMs ?? segment.anchor?.lastFrameMs ?? segment.endMs;
    // 首尾帧分三种情况：角色替换不再送（新批次）/ 局部重绘会送 / 旧批次送过。
    // 三者对用户的意义完全不同，混成一句就会自相矛盾（一边说"不送"一边列出首帧时间）。
    const hasAnchorFrames = segment.anchor?.headFrameMs !== undefined || segment.anchor?.tailFrameMs !== undefined;
    const framesKind: "none" | "repaint" | "legacy" = !hasAnchorFrames ? "none" : segment.mode === "repaint" ? "repaint" : "legacy";
    const headSlot = castItems.length + 1;
    const tailSlot = castItems.length + 2;

    const workflow = findWorkflow(globalConfig, node.metadata?.channelId, node.metadata?.workflowId);
    const spec = [
        workflow?.name || t("canvas.videoTimeline.spec.workflowFallback"),
        videoSizeLabel(node.metadata?.size || ""),
        `${seconds}s`,
    ].join(" · ");

    const muted = { color: theme.node.muted };

    return (
        <div className="mb-2 rounded-xl border p-2.5" style={{ borderColor: theme.toolbar.border, background: theme.node.panel }}>
            <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] font-medium tracking-wide">{t("canvas.videoTimeline.reference.title")}</span>
                <span className="text-[10px] tabular-nums" style={muted}>
                    {t("canvas.videoTimeline.reference.range", { start: formatTimecode(segment.startMs), end: formatTimecode(segment.endMs), seconds })}
                </span>
            </div>

            {/* 参考视频：模型的内容与节奏全部来自它 */}
            <div className="mt-2 flex items-center gap-2">
                {clipSrc ? (
                    <video
                        src={clipSrc}
                        muted
                        playsInline
                        preload="metadata"
                        className="h-10 w-16 shrink-0 rounded-md object-cover"
                        data-canvas-no-zoom
                        onMouseDown={(event) => event.stopPropagation()}
                    />
                ) : (
                    <div className="grid h-10 w-16 shrink-0 place-items-center rounded-md border border-dashed" style={{ borderColor: theme.node.stroke, ...muted }}>
                        <Film className="size-4 opacity-50" />
                    </div>
                )}
                <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1 text-[11px]">
                        <Film className="size-3 shrink-0 opacity-60" />
                        <span className="truncate">{t("canvas.videoTimeline.reference.clip")}</span>
                    </div>
                    {clipSrc ? null : (
                        <div className="mt-0.5 text-[10px] leading-4" style={muted}>
                            {t("canvas.videoTimeline.reference.clipMissing")}
                        </div>
                    )}
                </div>
                {clipNode ? (
                    <button
                        type="button"
                        className="shrink-0 rounded-full border px-2 py-0.5 text-[10px]"
                        style={{ borderColor: theme.toolbar.border, ...muted }}
                        onClick={() => onLocateNode?.(clipNode.id)}
                        onMouseDown={(event) => event.stopPropagation()}
                    >
                        {t("canvas.sidePanel.focusNode")}
                    </button>
                ) : null}
            </div>

            {/* 角色参考图：顺序 = 模型看到的 ref_image_01..0N */}
            <div className="mt-2 flex items-center gap-1 text-[11px]">
                <Users className="size-3 shrink-0 opacity-60" />
                <span>{t("canvas.videoTimeline.reference.cast")}</span>
                {castItems.length ? <span className="text-[10px]" style={muted}>({castItems.length})</span> : null}
                {missingCount ? (
                    <span className="text-[10px] text-amber-500">{t("canvas.videoTimeline.reference.castMissing", { count: missingCount })}</span>
                ) : null}
            </div>
            {castItems.length ? (
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {castItems.map((item, index) => (
                        <button
                            key={`${item.nodeId}-${index}`}
                            type="button"
                            className="group relative overflow-hidden rounded-md border"
                            style={{ borderColor: theme.node.stroke }}
                            title={item.title || item.nodeId}
                            onClick={() => onLocateNode?.(item.nodeId)}
                            onMouseDown={(event) => event.stopPropagation()}
                        >
                            {item.url ? (
                                <img src={item.url} alt={item.title || ""} className="h-10 w-10 object-cover" draggable={false} />
                            ) : (
                                <div className="grid h-10 w-10 place-items-center bg-red-500/10">
                                    <ImageIcon className="size-3.5 text-red-400" />
                                </div>
                            )}
                            <span className="absolute left-0 top-0 rounded-br bg-black/65 px-1 text-[9px] font-medium text-white">
                                {t("canvas.videoTimeline.reference.castSlot", { index: index + 1 })}
                            </span>
                        </button>
                    ))}
                </div>
            ) : (
                <div className="mt-1 text-[10px]" style={muted}>
                    {t("canvas.videoTimeline.reference.castEmpty")}
                </div>
            )}

            {/* 说清"外观只来自角色图"：用户最容易怀疑的是"是不是还把原片首尾帧喂进去了"。 */}
            {framesKind === "none" ? (
                <div className="mt-1.5 text-[10px] leading-4" style={muted}>
                    {t("canvas.videoTimeline.reference.castSource")}
                </div>
            ) : null}

            {framesKind !== "none" ? (
                <>
                    <div className="mt-2 flex items-center gap-2 text-[10px]" style={muted}>
                        <span className="shrink-0">{framesKind === "repaint" ? t("canvas.videoTimeline.reference.frames") : t("canvas.videoTimeline.reference.framesLegacy")}</span>
                        <span className="tabular-nums">{t("canvas.videoTimeline.reference.frameHead", { time: formatTimecode(headMs) })}</span>
                        <span className="tabular-nums">{t("canvas.videoTimeline.reference.frameTail", { time: formatTimecode(tailMs) })}</span>
                    </div>
                    <div className="mt-0.5 text-[10px] leading-4" style={muted}>
                        {framesKind === "repaint"
                            ? t("canvas.videoTimeline.reference.framesNoteRepaint", { head: headSlot, tail: tailSlot })
                            : t("canvas.videoTimeline.reference.framesNote", { head: headSlot, tail: tailSlot })}
                    </div>
                </>
            ) : null}

            <div className="mt-2 flex items-center justify-between gap-2 border-t pt-1.5 text-[10px]" style={{ borderColor: theme.toolbar.border, ...muted }}>
                <span className="truncate">{spec}</span>
                <span className="shrink-0">
                    {segment.promptSource === "segment" ? t("canvas.videoTimeline.reference.promptSegment") : t("canvas.videoTimeline.reference.promptGlobal")}
                </span>
            </div>
        </div>
    );
}
