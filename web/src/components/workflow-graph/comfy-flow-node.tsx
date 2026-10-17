import { memo, useRef, type MouseEvent as ReactMouseEvent } from "react";
import { getDataTypeColor } from "./comfy-flow-connections";
import type { ComfyFlowNodeData } from "./comfy-flow-types";

const CATEGORY_HEADER_COLORS: Record<string, { bg: string; text: string; border: string }> = {
    output: {
        bg: "bg-emerald-500/15 dark:bg-emerald-950/40",
        text: "text-emerald-700 dark:text-emerald-300",
        border: "border-emerald-500/30",
    },
    prompt: {
        bg: "bg-blue-500/15 dark:bg-blue-950/40",
        text: "text-blue-700 dark:text-blue-300",
        border: "border-blue-500/30",
    },
    seed: {
        bg: "bg-indigo-500/15 dark:bg-indigo-950/40",
        text: "text-indigo-700 dark:text-indigo-300",
        border: "border-indigo-500/30",
    },
    model: {
        bg: "bg-purple-500/15 dark:bg-purple-950/40",
        text: "text-purple-700 dark:text-purple-300",
        border: "border-purple-500/30",
    },
    reference: {
        bg: "bg-amber-500/15 dark:bg-amber-950/40",
        text: "text-amber-700 dark:text-amber-300",
        border: "border-amber-500/30",
    },
    size: {
        bg: "bg-cyan-500/15 dark:bg-cyan-950/40",
        text: "text-cyan-700 dark:text-cyan-300",
        border: "border-cyan-500/30",
    },
    general: {
        bg: "bg-stone-100 dark:bg-stone-800/60",
        text: "text-stone-700 dark:text-stone-300",
        border: "border-stone-200 dark:border-stone-700/60",
    },
};

interface ComfyFlowNodeProps {
    node: ComfyFlowNodeData;
    isSelected: boolean;
    onSelect: (nodeId: string) => void;
    onNodeDragStart?: (e: ReactMouseEvent, nodeId: string) => void;
}

export const ComfyFlowNode = memo(function ComfyFlowNode({
    node,
    isSelected,
    onSelect,
    onNodeDragStart,
}: ComfyFlowNodeProps) {
    const headerStyle = CATEGORY_HEADER_COLORS[node.slotCategory || "general"] || CATEGORY_HEADER_COLORS.general;
    const cardRef = useRef<HTMLDivElement>(null);

    // 格式化字面量预览
    const previewLiterals = node.literalInputs.slice(0, 3);

    return (
        <div
            ref={cardRef}
            className={`absolute select-none rounded-xl border bg-white/95 text-xs shadow-md backdrop-blur-xs transition-shadow dark:bg-stone-900/95 ${
                isSelected
                    ? "ring-2 ring-blue-500 border-blue-500 shadow-lg shadow-blue-500/15 dark:ring-blue-400 dark:border-blue-400"
                    : "border-stone-200/90 hover:border-stone-400 dark:border-stone-800 dark:hover:border-stone-600"
            }`}
            style={{
                left: node.x,
                top: node.y,
                width: node.width,
                minHeight: node.height,
                cursor: "pointer",
            }}
            onClick={(e) => {
                e.stopPropagation();
                onSelect(node.id);
            }}
            onMouseDown={(e) => {
                // 仅允许左键拖拽
                if (e.button === 0 && onNodeDragStart) {
                    onNodeDragStart(e, node.id);
                }
            }}
        >
            {/* 节点顶栏 Header */}
            <div
                className={`flex items-center justify-between gap-1.5 rounded-t-xl border-b px-2.5 py-1.5 ${headerStyle.bg} ${headerStyle.border}`}
            >
                <div className="flex items-center gap-1.5 min-w-0">
                    <span className="font-mono text-[10px] font-bold text-stone-500 dark:text-stone-400 shrink-0">
                        #{node.id}
                    </span>
                    <span className={`truncate font-semibold text-xs ${headerStyle.text}`} title={node.title}>
                        {node.title}
                    </span>
                </div>

                {node.slotCategory && node.slotCategory !== "general" && (
                    <span
                        className={`shrink-0 rounded px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider ${headerStyle.bg} ${headerStyle.text} border ${headerStyle.border}`}
                    >
                        {node.slotCategory === "model" ? `MODEL` : node.slotCategory}
                    </span>
                )}
            </div>

            {/* 类名副标题 */}
            <div className="px-2.5 py-1 text-[10px] font-mono text-stone-400 dark:text-stone-500 truncate border-b border-stone-100 dark:border-stone-800/60">
                {node.classType}
            </div>

            {/* 端口与流向区域 */}
            <div className="p-2 space-y-1 relative">
                {/* 输入端口 (Left) 与 输出端口 (Right) 并排展现 */}
                <div className="flex justify-between items-start gap-2">
                    {/* 左侧：输入端口 */}
                    <div className="space-y-1.5 flex-1 min-w-0">
                        {node.inputPorts.map((port) => {
                            const color = getDataTypeColor(port.type);
                            return (
                                <div
                                    key={port.id}
                                    className="flex items-center gap-1.5 text-[11px] group relative"
                                    title={`输入: ${port.name} (${port.type || "ANY"})`}
                                >
                                    {/* 端口圆点 Socket */}
                                    <span
                                        className="-ml-3 size-2.5 rounded-full border border-white dark:border-stone-900 shadow-2xs shrink-0 transition-transform group-hover:scale-125"
                                        style={{ backgroundColor: color }}
                                    />
                                    <span
                                        className={`truncate ${
                                            port.isConnected
                                                ? "text-stone-800 dark:text-stone-200 font-medium"
                                                : "text-stone-400 dark:text-stone-500"
                                        }`}
                                    >
                                        {port.name}
                                    </span>
                                </div>
                            );
                        })}
                    </div>

                    {/* 右侧：输出端口 */}
                    <div className="space-y-1.5 flex-1 min-w-0 text-right">
                        {node.outputPorts.map((port) => {
                            const color = getDataTypeColor(port.type);
                            return (
                                <div
                                    key={port.id}
                                    className="flex items-center justify-end gap-1.5 text-[11px] group relative"
                                    title={`输出: ${port.name} (${port.type || "ANY"})`}
                                >
                                    <span
                                        className={`truncate ${
                                            port.isConnected
                                                ? "text-stone-800 dark:text-stone-200 font-medium"
                                                : "text-stone-400 dark:text-stone-500"
                                        }`}
                                    >
                                        {port.name}
                                    </span>
                                    {/* 端口圆点 Socket */}
                                    <span
                                        className="-mr-3 size-2.5 rounded-full border border-white dark:border-stone-900 shadow-2xs shrink-0 transition-transform group-hover:scale-125"
                                        style={{ backgroundColor: color }}
                                    />
                                </div>
                            );
                        })}
                    </div>
                </div>

                {/* 底部常量字面量摘要 (如果存在) */}
                {previewLiterals.length > 0 && (
                    <div className="mt-2 pt-1.5 border-t border-stone-100 dark:border-stone-800/60 space-y-0.5">
                        {previewLiterals.map((lit) => {
                            const valStr =
                                typeof lit.value === "string"
                                    ? lit.value.length > 20
                                        ? `${lit.value.slice(0, 20)}...`
                                        : lit.value
                                    : String(lit.value);
                            return (
                                <div
                                    key={lit.key}
                                    className="flex items-center justify-between text-[10px] text-stone-500 dark:text-stone-400 font-mono truncate"
                                >
                                    <span className="text-stone-400 dark:text-stone-500">{lit.key}:</span>
                                    <span className="truncate max-w-[120px] font-semibold text-stone-700 dark:text-stone-300">
                                        {valStr}
                                    </span>
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>
        </div>
    );
});
