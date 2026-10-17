import {
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
    type MouseEvent as ReactMouseEvent,
    type WheelEvent as ReactWheelEvent,
} from "react";
import { Button, Tooltip } from "antd";
import {
    Focus,
    Maximize2,
    Minimize2,
    Plus,
    Minus,
    RotateCcw,
    Layers,
    Info,
} from "lucide-react";
import { parseWorkflowToGraph } from "./dag-layout";
import { ComfyFlowNode } from "./comfy-flow-node";
import { ComfyFlowConnections } from "./comfy-flow-connections";
import { ComfyFlowDrawer } from "./comfy-flow-drawer";
import type { ComfyFlowNodeData } from "./comfy-flow-types";
import type { ComfyuiModelItem, ComfyuiWorkflowJson } from "@/services/api/comfyui";

interface ComfyFlowGraphProps {
    workflowJson: ComfyuiWorkflowJson;
    modelsMap?: Record<string, { loading: boolean; error?: string; items: ComfyuiModelItem[] }>;
    onModelChange?: (nodeId: string, inputKey: string, nextValue: string) => void;
    onReloadModels?: (category: string) => void;
    className?: string;
}

export function ComfyFlowGraph({
    workflowJson,
    modelsMap,
    onModelChange,
    onReloadModels,
    className = "",
}: ComfyFlowGraphProps) {
    const containerRef = useRef<HTMLDivElement>(null);

    // 解析 DAG 布局
    const rawLayout = useMemo(() => {
        return parseWorkflowToGraph(workflowJson);
    }, [workflowJson]);

    // 允许用户拖拽微调节点位置的本地状态
    const [draggedPositions, setDraggedPositions] = useState<Map<string, { x: number; y: number }>>(
        new Map(),
    );

    // 当工作流 JSON 改变时重置拖拽位置
    useEffect(() => {
        setDraggedPositions(new Map());
    }, [workflowJson]);

    // 计算应用了微调位置后的节点列表与映射
    const { nodes, nodesMap, edges } = useMemo(() => {
        const updatedNodes: ComfyFlowNodeData[] = rawLayout.nodes.map((node) => {
            const customPos = draggedPositions.get(node.id);
            if (!customPos) return node;

            const dx = customPos.x - node.x;
            const dy = customPos.y - node.y;

            return {
                ...node,
                x: customPos.x,
                y: customPos.y,
                inputPorts: node.inputPorts.map((p) => ({
                    ...p,
                    x: (p.x ?? node.x) + dx,
                    y: (p.y ?? node.y) + dy,
                })),
                outputPorts: node.outputPorts.map((p) => ({
                    ...p,
                    x: (p.x ?? node.x + node.width) + dx,
                    y: (p.y ?? node.y) + dy,
                })),
            };
        });

        const map = new Map<string, ComfyFlowNodeData>();
        for (const n of updatedNodes) {
            map.set(n.id, n);
        }

        return {
            nodes: updatedNodes,
            nodesMap: map,
            edges: rawLayout.edges,
        };
    }, [rawLayout, draggedPositions]);

    // 视口状态 (平移与缩放)
    const [viewport, setViewport] = useState({ x: 60, y: 60, zoom: 0.85 });
    const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
    const [drawerOpen, setDrawerOpen] = useState(false);
    const [hoveredEdgeId, setHoveredEdgeId] = useState<string | null>(null);
    const [isFullscreen, setIsFullscreen] = useState(false);

    // 交互拖拽状态 (画布平移 / 节点拖拽)
    const dragStateRef = useRef<{
        isPanning: boolean;
        isDraggingNode: boolean;
        targetNodeId?: string;
        startX: number;
        startY: number;
        nodeInitialX?: number;
        nodeInitialY?: number;
    }>({
        isPanning: false,
        isDraggingNode: false,
        startX: 0,
        startY: 0,
    });

    // 自适应居中视口 (Fit View)
    const handleFitView = useCallback(() => {
        if (!containerRef.current || rawLayout.nodes.length === 0) return;
        const rect = containerRef.current.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return;

        const padding = 80;
        const graphWidth = rawLayout.bounds.width;
        const graphHeight = rawLayout.bounds.height;

        const scaleX = (rect.width - padding * 2) / graphWidth;
        const scaleY = (rect.height - padding * 2) / graphHeight;
        const nextZoom = Math.min(Math.max(Math.min(scaleX, scaleY), 0.2), 1.2);

        const centerX = (rect.width - graphWidth * nextZoom) / 2 - rawLayout.bounds.minX * nextZoom;
        const centerY = (rect.height - graphHeight * nextZoom) / 2 - rawLayout.bounds.minY * nextZoom;

        setViewport({
            x: Math.round(centerX),
            y: Math.round(centerY),
            zoom: Number(nextZoom.toFixed(2)),
        });
    }, [rawLayout]);

    // 初始化时自动 Fit View
    useEffect(() => {
        const timer = setTimeout(handleFitView, 60);
        return () => clearTimeout(timer);
    }, [handleFitView]);

    // 滚轮缩放 (以鼠标指针为锚点)
    const handleWheel = (e: ReactWheelEvent<HTMLDivElement>) => {
        e.preventDefault();
        if (!containerRef.current) return;
        const rect = containerRef.current.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;

        const zoomDelta = e.deltaY < 0 ? 1.1 : 0.9;
        const nextZoom = Math.min(Math.max(viewport.zoom * zoomDelta, 0.2), 2.5);

        const newX = mouseX - (mouseX - viewport.x) * (nextZoom / viewport.zoom);
        const newY = mouseY - (mouseY - viewport.y) * (nextZoom / viewport.zoom);

        setViewport({
            x: Math.round(newX),
            y: Math.round(newY),
            zoom: Number(nextZoom.toFixed(2)),
        });
    };

    // 画布背景拖拽开始 (Pan)
    const handleCanvasMouseDown = (e: ReactMouseEvent) => {
        if (e.button !== 0) return;
        dragStateRef.current = {
            isPanning: true,
            isDraggingNode: false,
            startX: e.clientX - viewport.x,
            startY: e.clientY - viewport.y,
        };
    };

    // 节点卡片拖拽开始 (Node Drag)
    const handleNodeDragStart = (e: ReactMouseEvent, nodeId: string) => {
        const node = nodesMap.get(nodeId);
        if (!node) return;
        e.stopPropagation();

        dragStateRef.current = {
            isPanning: false,
            isDraggingNode: true,
            targetNodeId: nodeId,
            startX: e.clientX,
            startY: e.clientY,
            nodeInitialX: node.x,
            nodeInitialY: node.y,
        };
    };

    // 鼠标移动全局监听 (处理平移与节点移动)
    const handleMouseMove = (e: ReactMouseEvent) => {
        const state = dragStateRef.current;
        if (state.isPanning) {
            setViewport((prev) => ({
                ...prev,
                x: e.clientX - state.startX,
                y: e.clientY - state.startY,
            }));
        } else if (state.isDraggingNode && state.targetNodeId && state.nodeInitialX !== undefined && state.nodeInitialY !== undefined) {
            const dx = (e.clientX - state.startX) / viewport.zoom;
            const dy = (e.clientY - state.startY) / viewport.zoom;
            const newX = Math.round(state.nodeInitialX + dx);
            const newY = Math.round(state.nodeInitialY + dy);

            setDraggedPositions((prev) => {
                const next = new Map(prev);
                next.set(state.targetNodeId!, { x: newX, y: newY });
                return next;
            });
        }
    };

    // 拖拽释放
    const handleMouseUp = () => {
        dragStateRef.current = {
            isPanning: false,
            isDraggingNode: false,
            startX: 0,
            startY: 0,
        };
    };

    // 节点选中并调出侧边详情
    const handleSelectNode = (nodeId: string) => {
        setSelectedNodeId(nodeId);
        setDrawerOpen(true);
    };

    const selectedNodeData = selectedNodeId ? nodesMap.get(selectedNodeId) || null : null;

    return (
        <div
            ref={containerRef}
            className={`relative size-full overflow-hidden select-none bg-stone-100/70 dark:bg-stone-950/80 ${
                isFullscreen ? "fixed inset-0 z-50 bg-background" : ""
            } ${className}`}
            onWheel={handleWheel}
            onMouseDown={handleCanvasMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onMouseLeave={handleMouseUp}
        >
            {/* 网格背景 */}
            <div
                className="absolute inset-0 pointer-events-none opacity-40 dark:opacity-20"
                style={{
                    backgroundImage: `radial-gradient(circle, currentColor 1px, transparent 1px)`,
                    backgroundSize: `${24 * viewport.zoom}px ${24 * viewport.zoom}px`,
                    backgroundPosition: `${viewport.x}px ${viewport.y}px`,
                }}
            />

            {/* 核心缩放平移图层 */}
            <div
                className="absolute origin-top-left will-change-transform"
                style={{
                    transform: `translate3d(${viewport.x}px, ${viewport.y}px, 0) scale(${viewport.zoom})`,
                }}
            >
                {/* SVG 导线层 */}
                <svg
                    className="absolute inset-0 pointer-events-none overflow-visible"
                    style={{
                        width: rawLayout.bounds.width + 800,
                        height: rawLayout.bounds.height + 800,
                    }}
                >
                    <ComfyFlowConnections
                        edges={edges}
                        nodesMap={nodesMap}
                        selectedNodeId={selectedNodeId}
                        hoveredEdgeId={hoveredEdgeId}
                        onEdgeHover={setHoveredEdgeId}
                    />
                </svg>

                {/* HTML 节点卡片层 */}
                <div className="absolute inset-0 pointer-events-auto">
                    {nodes.map((node) => (
                        <ComfyFlowNode
                            key={node.id}
                            node={node}
                            isSelected={selectedNodeId === node.id}
                            onSelect={handleSelectNode}
                            onNodeDragStart={handleNodeDragStart}
                        />
                    ))}
                </div>
            </div>

            {/* 顶部统计状态徽章 */}
            <div className="absolute top-3 left-3 flex items-center gap-2 rounded-xl border border-stone-200/80 bg-white/90 px-3 py-1.5 text-xs shadow-xs backdrop-blur-md dark:border-stone-800 dark:bg-stone-900/90">
                <Layers className="size-3.5 text-blue-500" />
                <span className="font-semibold text-stone-800 dark:text-stone-200">
                    {rawLayout.stats.totalNodes} 个节点
                </span>
                <span className="text-stone-300 dark:text-stone-700">|</span>
                <span className="text-stone-500 dark:text-stone-400">
                    {rawLayout.stats.totalEdges} 条连线
                </span>
                {rawLayout.stats.detectedSlots > 0 && (
                    <>
                        <span className="text-stone-300 dark:text-stone-700">|</span>
                        <span className="font-medium text-emerald-600 dark:text-emerald-400">
                            {rawLayout.stats.detectedSlots} 个标注槽位
                        </span>
                    </>
                )}
            </div>

            {/* 悬浮工具栏 (缩放与控制) */}
            <div className="absolute bottom-4 right-4 flex items-center gap-1 rounded-xl border border-stone-200/90 bg-white/95 p-1 shadow-lg backdrop-blur-md dark:border-stone-800 dark:bg-stone-900/95">
                <Tooltip title="缩小 (滚轮下滑)">
                    <Button
                        size="small"
                        type="text"
                        icon={<Minus className="size-3.5" />}
                        onClick={() =>
                            setViewport((prev) => ({
                                ...prev,
                                zoom: Math.max(Number((prev.zoom - 0.1).toFixed(2)), 0.2),
                            }))
                        }
                    />
                </Tooltip>

                <span className="min-w-[48px] text-center font-mono text-[11px] font-semibold text-stone-600 dark:text-stone-300">
                    {Math.round(viewport.zoom * 100)}%
                </span>

                <Tooltip title="放大 (滚轮上滑)">
                    <Button
                        size="small"
                        type="text"
                        icon={<Plus className="size-3.5" />}
                        onClick={() =>
                            setViewport((prev) => ({
                                ...prev,
                                zoom: Math.min(Number((prev.zoom + 0.1).toFixed(2)), 2.5),
                            }))
                        }
                    />
                </Tooltip>

                <div className="h-4 w-px bg-stone-200 dark:bg-stone-800 mx-0.5" />

                <Tooltip title="自适应适应画布">
                    <Button
                        size="small"
                        type="text"
                        icon={<Focus className="size-3.5" />}
                        onClick={handleFitView}
                    />
                </Tooltip>

                <Tooltip title="重置为 100%">
                    <Button
                        size="small"
                        type="text"
                        icon={<RotateCcw className="size-3.5" />}
                        onClick={() => setViewport({ x: 60, y: 60, zoom: 1.0 })}
                    />
                </Tooltip>

                <div className="h-4 w-px bg-stone-200 dark:bg-stone-800 mx-0.5" />

                <Tooltip title={isFullscreen ? "退出全屏" : "全屏放大审查"}>
                    <Button
                        size="small"
                        type="text"
                        icon={isFullscreen ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
                        onClick={() => setIsFullscreen((prev) => !prev)}
                    />
                </Tooltip>
            </div>

            {/* 节点详情抽屉 */}
            <ComfyFlowDrawer
                node={selectedNodeData}
                open={drawerOpen}
                onClose={() => setDrawerOpen(false)}
                edges={edges}
                allNodesMap={nodesMap}
                onSelectNode={handleSelectNode}
                modelsMap={modelsMap}
                onModelChange={onModelChange}
                onReloadModels={onReloadModels}
            />
        </div>
    );
}
