import { useCallback, useMemo, useRef, useState } from "react";
import { Scissors } from "lucide-react";

import { formatTimecode, snapToCut, type SceneCut, type VideoRange } from "@/lib/canvas/video-timeline";

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
    /** 只显示，不允许改选区（角色替换看全片时用）。 */
    readOnly?: boolean;
};

type DragState = { mode: "new" | "resize-start" | "resize-end" | "move"; anchorMs: number; origin: TimelineSelection | null };

const MIN_RANGE_MS = 500;
const EDGE_HIT_PX = 10;

export function CanvasVideoTimeline({ durationMs, frames, cuts, ranges, selection, currentTimeMs, onSeek, onSelectionChange, readOnly = false }: CanvasVideoTimelineProps) {
    const trackRef = useRef<HTMLDivElement>(null);
    const dragRef = useRef<DragState | null>(null);
    const [dragging, setDragging] = useState(false);

    const ratio = useCallback((timeMs: number) => (durationMs > 0 ? Math.min(1, Math.max(0, timeMs / durationMs)) : 0), [durationMs]);

    const timeAt = useCallback(
        (clientX: number) => {
            const rect = trackRef.current?.getBoundingClientRect();
            if (!rect || rect.width <= 0) return 0;
            const value = ((clientX - rect.left) / rect.width) * durationMs;
            // 拖拽时吸到场景切点，避免用户手动对齐到 3187ms 这种别扭位置。
            return Math.round(Math.min(durationMs, Math.max(0, snapToCut(value, cuts, 300))));
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
                        <div key={`range-${range.startMs}`} className="absolute inset-y-0 w-px bg-white/45" style={{ left: `${ratio(range.startMs) * 100}%` }} />
                    ))}
                    {cuts.map((cut) => (
                        <div key={`cut-${cut.timeMs}`} className="absolute inset-y-0 w-[2px] bg-amber-400/90" style={{ left: `${ratio(cut.timeMs) * 100}%` }} title={`${formatTimecode(cut.timeMs)} · ${cut.score.toFixed(2)}`} />
                    ))}
                </div>

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
