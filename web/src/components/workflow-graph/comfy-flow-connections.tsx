import { memo, useMemo } from "react";
import type { ComfyFlowEdgeData, ComfyFlowNodeData } from "./comfy-flow-types";

const DATA_TYPE_COLORS: Record<string, string> = {
    MODEL: "#a855f7", // purple
    CLIP: "#eab308", // yellow
    CONDITIONING: "#f59e0b", // amber
    IMAGE: "#0ea5e9", // sky blue
    LATENT: "#ec4899", // pink
    VAE: "#ef4444", // red
    MASK: "#14b8a6", // teal
    VIDEO: "#8b5cf6", // violet
    AUDIO: "#f97316", // orange
    INT: "#64748b", // slate
    FLOAT: "#64748b",
    STRING: "#06b6d4", // cyan
    ANY: "#78716c", // stone
};

export function getDataTypeColor(type?: string): string {
    if (!type) return DATA_TYPE_COLORS.ANY;
    const upper = type.toUpperCase();
    return DATA_TYPE_COLORS[upper] || DATA_TYPE_COLORS.ANY;
}

interface ComfyFlowConnectionsProps {
    edges: ComfyFlowEdgeData[];
    nodesMap: Map<string, ComfyFlowNodeData>;
    selectedNodeId?: string | null;
    hoveredEdgeId?: string | null;
    onEdgeHover?: (edgeId: string | null) => void;
}

export const ComfyFlowConnections = memo(function ComfyFlowConnections({
    edges,
    nodesMap,
    selectedNodeId,
    hoveredEdgeId,
    onEdgeHover,
}: ComfyFlowConnectionsProps) {
    const hasSelection = Boolean(selectedNodeId);

    const renderedPaths = useMemo(() => {
        return edges.map((edge) => {
            const fromNode = nodesMap.get(edge.fromNodeId);
            const toNode = nodesMap.get(edge.toNodeId);
            if (!fromNode || !toNode) return null;

            const fromPort = fromNode.outputPorts.find((p) => p.slotIndex === edge.fromSlot);
            const toPort = toNode.inputPorts.find((p) => p.name === edge.toInputKey);

            const startX = fromPort?.x ?? fromNode.x + fromNode.width;
            const startY = fromPort?.y ?? fromNode.y + 40;
            const endX = toPort?.x ?? toNode.x;
            const endY = toPort?.y ?? toNode.y + 40;

            const dx = Math.abs(endX - startX);
            const curvature = Math.max(dx * 0.45, 40);
            const pathD = `M ${startX} ${startY} C ${startX + curvature} ${startY}, ${endX - curvature} ${endY}, ${endX} ${endY}`;

            const isRelatedToSelection =
                selectedNodeId === edge.fromNodeId || selectedNodeId === edge.toNodeId;
            const isHovered = hoveredEdgeId === edge.id;

            const baseColor = getDataTypeColor(edge.dataType);
            const strokeColor = isHovered || isRelatedToSelection ? baseColor : baseColor;
            const strokeWidth = isHovered ? 3.5 : isRelatedToSelection ? 3 : 2;
            const strokeOpacity = hasSelection
                ? isRelatedToSelection
                    ? 1
                    : 0.18
                : isHovered
                ? 1
                : 0.72;

            return (
                <g key={edge.id}>
                    {/* 扩大鼠标交互热区的透明粗线 */}
                    <path
                        d={pathD}
                        fill="none"
                        stroke="transparent"
                        strokeWidth={16}
                        style={{ cursor: "pointer", pointerEvents: "stroke" }}
                        onMouseEnter={() => onEdgeHover?.(edge.id)}
                        onMouseLeave={() => onEdgeHover?.(null)}
                    >
                        <title>{`${edge.fromNodeId} (${fromNode.title}) [${edge.fromSlot}] → ${edge.toNodeId} (${toNode.title}) [${edge.toInputKey}]`}</title>
                    </path>

                    {/* 可见连线 */}
                    <path
                        d={pathD}
                        fill="none"
                        stroke={strokeColor}
                        strokeWidth={strokeWidth}
                        strokeOpacity={strokeOpacity}
                        style={{
                            pointerEvents: "none",
                            transition: "stroke-opacity 0.2s ease, stroke-width 0.2s ease",
                            filter: isRelatedToSelection || isHovered ? `drop-shadow(0 0 6px ${baseColor}aa)` : undefined,
                        }}
                    />
                </g>
            );
        });
    }, [edges, nodesMap, selectedNodeId, hoveredEdgeId, hasSelection, onEdgeHover]);

    return <g className="comfy-flow-connections">{renderedPaths}</g>;
});
