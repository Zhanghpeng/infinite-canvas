import { useCallback, useMemo, useRef, useState } from "react";
import { Scissors } from "lucide-react";
import { useTranslation } from "react-i18next";

import { formatDuration, formatTimecode, snapToCut, type ManualCutBlockReason, type SceneCut, type VideoRange } from "@/lib/canvas/video-timeline";

export type TimelineSelection = { startMs: number; endMs: number };

type CanvasVideoTimelineProps = {
    durationMs: number;
    frames: { timeMs: number; dataUrl: string }[];
    cuts: SceneCut[];
    ranges: VideoRange[];
    selection: TimelineSelection | null;
    currentTimeMs: number;
    onSeek: (timeMs: number) => void;
    onSelectionChange: (selection: TimelineSelection | null) => void;
    /**
     * 拖动第 index 道段边界到 timeMs。不给就不显示手柄（只读或没有分段概念的地方）。
     * index 与 `ranges` 对齐：第 index 道边界位于 `ranges[index].endMs`。
     * 返回值是"被挡住的原因"：拖动被上限或邻段卡住时，把手旁边会标出来，
     * 否则用户只看到线不动，会以为是自己没拖上。
     */
    onBoundaryMove?: (index: number, timeMs: number) => ManualCutBlockReason | null | void;
    /** 双击第 index 道边界：合并左右两段。 */
    onBoundaryRemove?: (index: number) => void;
    /** 只显示，不允许改选区（角色替换看全片时用）。 */
    readOnly?: boolean;
};

type DragState = { mode: "new" | "resize-start" | "resize-end" | "move"; anchorMs: number; origin: TimelineSelection | null };

const MIN_RANGE_MS = 500;
const EDGE_HIT_PX = 10;
/** 拖段边界时的吸附容差。比拖选区的 300ms 小：微调的目的常常就是躲开自动切点。 */
const BOUNDARY_SNAP_MS = 120;
/** 段边界手柄的命中宽度（像素）。7px 差不多是"一指宽"，再宽会抢走拖选区的操作。 */
const BOUNDARY_HIT_PX = 9;

export function CanvasVideoTimeline({ durationMs, frames, cuts, ranges, selection, currentTimeMs, onSeek, onSelectionChange, onBoundaryMove, onBoundaryRemove, readOnly = false }: CanvasVideoTimelineProps) {
    const { t } = useTranslation();
    const trackRef = useRef<HTMLDivElement>(null);
    const dragRef = useRef<DragState | null>(null);
    const boundaryRef = useRef<number | null>(null);
    const [dragging, setDragging] = useState(false);
    const [draggingBoundary, setDraggingBoundary] = useState<number | null>(null);
    // 被上限/邻段挡住时记下原因，跟时间码一起贴在把手上。
    const [boundaryBlock, setBoundaryBlock] = useState<ManualCutBlockReason | null>(null);

    const ratio = useCallback((timeMs: number) => (durationMs > 0 ? Math.min(1, Math.max(0, timeMs / durationMs)) : 0), [durationMs]);

    const timeAt = useCallback(
        (clientX: number, snapMs = 300) => {
            const rect = trackRef.current?.getBoundingClientRect();
            if (!rect || rect.width <= 0) return 0;
            const value = ((clientX - rect.left) / rect.width) * durationMs;
            // 拖拽时吸到场景切点，避免用户手动对齐到 3187ms 这种别扭位置。
            return Math.round(Math.min(durationMs, Math.max(0, snapToCut(value, cuts, snapMs))));
        },
        [cuts, durationMs],
    );

    const handlePointerDown = useCallback(
        (event: React.PointerEvent<HTMLDivElement>) => {
            if (event.button !== 0) return;
            event.stopPropagation();
            const timeMs = timeAt(event.clientX);
            if (readOnly) {
                onSeek(timeMs);
                return;
            }
            const rect = trackRef.current?.getBoundingClientRect();
            if (!rect) return;
            const toPx = (ms: number) => (ratio(ms) * rect.width);
            const x = event.clientX - rect.left;
            const startPx = selection ? toPx(selection.startMs) : null;
            const endPx = selection ? toPx(selection.endMs) : null;
            let mode: DragState["mode"] = "new";
            if (selection && startPx !== null && endPx !== null) {
                if (Math.abs(x - startPx) <= EDGE_HIT_PX) mode = "resize-start";
                else if (Math.abs(x - endPx) <= EDGE_HIT_PX) mode = "resize-end";
                else if (x > startPx && x < endPx) mode = "move";
            }
            dragRef.current = { mode, anchorMs: timeMs, origin: selection };
            setDragging(true);
            (event.target as HTMLElement).setPointerCapture?.(event.pointerId);
            if (mode === "new") onSelectionChange({ startMs: timeMs, endMs: Math.min(durationMs, timeMs + MIN_RANGE_MS) });
            if (mode !== "move") onSeek(timeMs);
        },
        [durationMs, onSeek, onSelectionChange, ratio, readOnly, selection, timeAt],
    );

    const handlePointerMove = useCallback(
        (event: React.PointerEvent<HTMLDivElement>) => {
            const drag = dragRef.current;
            if (!drag) return;
            const timeMs = timeAt(event.clientX);
            if (drag.mode === "new") {
                const start = Math.min(drag.anchorMs, timeMs);
                const end = Math.max(drag.anchorMs, timeMs);
                if (end - start >= MIN_RANGE_MS) onSelectionChange({ startMs: start, endMs: end });
                return;
            }
            if (!drag.origin) return;
            if (drag.mode === "resize-start") {
                onSelectionChange({ startMs: Math.min(timeMs, drag.origin.endMs - MIN_RANGE_MS), endMs: drag.origin.endMs });
                return;
            }
            if (drag.mode === "resize-end") {
                onSelectionChange({ startMs: drag.origin.startMs, endMs: Math.max(timeMs, drag.origin.startMs + MIN_RANGE_MS) });
                return;
            }
            // move：整体平移，撞到两端就贴边，不改变长度。
            const length = drag.origin.endMs - drag.origin.startMs;
            const delta = timeMs - drag.anchorMs;
            let start = drag.origin.startMs + delta;
            start = Math.max(0, Math.min(durationMs - length, start));
            onSelectionChange({ startMs: Math.round(start), endMs: Math.round(start + length) });
        },
        [durationMs, onSelectionChange, timeAt],
    );

    const endDrag = useCallback(() => {
        dragRef.current = null;
        setDragging(false);
    }, []);

    const handles = useMemo(() => {
        if (!selection) return null;
        const left = `${ratio(selection.startMs) * 100}%`;
        const right = `${(1 - ratio(selection.endMs)) * 100}%`;
        return { left, right, width: `${Math.max(0, ratio(selection.endMs) - ratio(selection.startMs)) * 100}%` };
    }, [ratio, selection]);

    return (
        <div className="space-y-1.5">
            <div
                ref={trackRef}
                className={`relative h-[72px] w-full select-none overflow-hidden rounded-lg bg-stone-900 ring-1 ring-inset ring-white/10 ${readOnly ? "cursor-pointer" : "cursor-crosshair"} ${dragging ? "ring-blue-400/60" : ""}`}
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={endDrag}
                onPointerCancel={endDrag}
                style={{ touchAction: "none" }}
            >
                {/* 胶片条：等宽铺满，作为时间轴的视觉参照 */}
                <div className="pointer-events-none absolute inset-0 flex">
                    {frames.length ? (
                        frames.map((frame) => <img key={frame.timeMs} src={frame.dataUrl} alt="" draggable={false} className="h-full min-w-0 flex-1 object-cover opacity-80" />)
                    ) : (
                        <div className="flex h-full w-full items-center justify-center text-[11px] text-white/40">…</div>
                    )}
                </div>

                {/* 段边界：细实线；场景切点：琥珀色高亮 */}
                <div className="pointer-events-none absolute inset-0">
                    {ranges.slice(1).map((range) => (
                        <div
                            key={`range-${range.startMs}`}
                            className={`absolute inset-y-0 w-px ${draggingBoundary === null ? "bg-white/45" : "bg-white/25"}`}
                            style={{ left: `${ratio(range.startMs) * 100}%` }}
                        />
                    ))}
                    {cuts.map((cut) => (
                        <div key={`cut-${cut.timeMs}`} className="absolute inset-y-0 w-[2px] bg-amber-400/90" style={{ left: `${ratio(cut.timeMs) * 100}%` }} title={`${formatTimecode(cut.timeMs)} · ${cut.score.toFixed(2)}`} />
                    ))}
                </div>

                {/* 段边界手柄：拖一下改切点，双击合并左右两段。
                    单独一层放在线条之上，是为了让"拖边界"优先于"拖选区" ——
                    两者都在同一条轨道上，不抢的话用户永远拖不中边界。 */}
                {onBoundaryMove
                    ? ranges.slice(0, -1).map((range, index) => {
                          const active = draggingBoundary === index;
                          return (
                              <div
                                  key={`handle-${range.endMs}`}
                                  role="separator"
                                  aria-orientation="vertical"
                                  aria-label={t("canvas.videoTimeline.boundary.handle", { time: formatTimecode(range.endMs) })}
                                  title={onBoundaryRemove ? t("canvas.videoTimeline.boundary.dragHint") : t("canvas.videoTimeline.boundary.dragOnly")}
                                  className="group/handle absolute inset-y-0 z-20 -translate-x-1/2 cursor-col-resize touch-none"
                                  style={{ left: `${ratio(range.endMs) * 100}%`, width: BOUNDARY_HIT_PX }}
                                  onPointerDown={(event) => {
                                      if (event.button !== 0) return;
                                      event.stopPropagation();
                                      boundaryRef.current = index;
                                      setDraggingBoundary(index);
                                      setBoundaryBlock(null);
                                      event.currentTarget.setPointerCapture?.(event.pointerId);
                                  }}
                                  onPointerMove={(event) => {
                                      if (boundaryRef.current !== index) return;
                                      // 拖动过程中实时回报，段长与合规标跟着变 —— 微调靠的就是这个即时反馈。
                                      const reason = onBoundaryMove(index, timeAt(event.clientX, BOUNDARY_SNAP_MS));
                                      setBoundaryBlock(reason ?? null);
                                  }}
                                  onPointerUp={(event) => {
                                      boundaryRef.current = null;
                                      setDraggingBoundary(null);
                                      setBoundaryBlock(null);
                                      event.currentTarget.releasePointerCapture?.(event.pointerId);
                                  }}
                                  onPointerCancel={() => {
                                      boundaryRef.current = null;
                                      setDraggingBoundary(null);
                                      setBoundaryBlock(null);
                                  }}
                                  onDoubleClick={(event) => {
                                      event.stopPropagation();
                                      boundaryRef.current = null;
                                      setDraggingBoundary(null);
                                      setBoundaryBlock(null);
                                      onBoundaryRemove?.(index);
                                  }}
                              >
                                  <div
                                      className={`pointer-events-none absolute inset-y-0 left-1/2 w-[3px] -translate-x-1/2 rounded-full transition-colors ${
                                          boundaryBlock ? "bg-amber-400" : active ? "bg-blue-400" : "bg-transparent group-hover/handle:bg-blue-400/70"
                                      }`}
                                  />
                                  {/* 上下两个小把手：光靠一条线看不出"这个能拖"，尤其在全灰的胶片上。 */}
                                  <div className={`pointer-events-none absolute left-1/2 top-0 size-1.5 -translate-x-1/2 rounded-full transition-opacity ${active ? "bg-blue-400" : "bg-white/70 opacity-0 group-hover/handle:opacity-100"}`} />
                                  <div className={`pointer-events-none absolute bottom-0 left-1/2 size-1.5 -translate-x-1/2 rounded-full transition-opacity ${active ? "bg-blue-400" : "bg-white/70 opacity-0 group-hover/handle:opacity-100"}`} />
                                  {active ? (
                                      // 拖动时把当前时间码与左段时长贴在把手上：
                                      // 微调关心的是"切在哪一帧、这段还剩多长"，不是拖了多远。
                                      <span
                                          className={`pointer-events-none absolute left-1/2 top-1 -translate-x-1/2 whitespace-nowrap rounded px-1.5 py-px text-center font-mono text-[10px] leading-tight text-white shadow ${
                                              boundaryBlock ? "bg-amber-500" : "bg-blue-500"
                                          }`}
                                      >
                                          {formatTimecode(range.endMs)}
                                          <span className="ml-1 opacity-80">{formatDuration(range.endMs - range.startMs)}</span>
                                          {boundaryBlock ? (
                                              <span className="mt-px block text-[9px] font-sans opacity-95">
                                                  {boundaryBlock === "max" ? t("canvas.videoTimeline.boundary.blockedMax") : t("canvas.videoTimeline.boundary.blockedNeighbor")}
                                              </span>
                                          ) : null}
                                      </span>
                                  ) : null}
                              </div>
                          );
                      })
                    : null}

                {/* 未选中区域压暗 */}
                {handles ? (
                    <div className="pointer-events-none absolute inset-0">
                        <div className="absolute inset-y-0 left-0 bg-black/55" style={{ width: handles.left }} />
                        <div className="absolute inset-y-0 right-0 bg-black/55" style={{ width: handles.right }} />
                    </div>
                ) : null}

                {/* 选区框 */}
                {selection && handles ? (
                    <div className="pointer-events-none absolute inset-y-0 border-y-2 border-blue-400" style={{ left: handles.left, width: handles.width }}>
                        <div className="absolute inset-y-0 left-0 w-[3px] bg-blue-400" />
                        <div className="absolute inset-y-0 right-0 w-[3px] bg-blue-400" />
                        {!readOnly ? (
                            <div className="absolute left-1/2 top-1 -translate-x-1/2 rounded-full bg-blue-500 px-1.5 py-px text-[10px] font-medium leading-tight text-white shadow">
                                {formatTimecode(selection.startMs)} – {formatTimecode(selection.endMs)}
                            </div>
                        ) : null}
                    </div>
                ) : null}

                {/* 播放头 */}
                <div className="pointer-events-none absolute inset-y-0 w-px bg-white shadow-[0_0_0_1px_rgba(0,0,0,0.4)]" style={{ left: `${ratio(currentTimeMs) * 100}%` }}>
                    <div className="absolute -top-px left-1/2 size-1.5 -translate-x-1/2 rounded-full bg-white" />
                </div>
            </div>

            {/* 刻度：0 / 中 / 尾，够用且不吵 */}
            <div className="flex items-center justify-between font-mono text-[10px] text-stone-400 dark:text-stone-500">
                <span>00:00.0</span>
                <span className="flex items-center gap-1 text-amber-500">
                    <Scissors className="size-2.5" />
                    {cuts.length}
                </span>
                <span>{formatTimecode(durationMs)}</span>
            </div>
        </div>
    );
}
