import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { ChevronRight, Copy, Download, FileText, Group, Image as ImageIcon, Layers, Lock, Mic, Music2, Plus, Puzzle, RefreshCw, Star, Trash2, Video } from "lucide-react";

import { canvasThemes } from "@/lib/canvas-theme";
import { formatBytes } from "@/lib/image-utils";
import { getNodeDefinition } from "@/lib/canvas/node-registry";
import { buildNodeContext } from "@/lib/canvas/plugin-node-context";
import { useCollabStore } from "@/stores/use-collab-store";
import { useThemeStore } from "@/stores/use-theme-store";
import { CanvasResourceMentionTextarea } from "./canvas-resource-mention-textarea";
import { CanvasNodeType, type CanvasGroupKind, type CanvasGroupSummary, type CanvasNodeData, type CanvasNodeImage, type CanvasNodeText, type Position } from "@/types/canvas";
import type { CanvasNodeContext, CanvasPluginHost } from "@/types/canvas-plugin";
import type { CanvasResourceReference } from "@/lib/canvas/canvas-resource-references";
import { CanvasVideoPlayer } from "./canvas-video-player";
import { useTranslation } from "react-i18next";
import { formatNodeLoadingText, formatProgressCaption } from "@/lib/canvas/canvas-generation-helpers";
import { formatTimecode } from "@/lib/canvas/video-timeline";
import { CanvasGenerationError } from "./canvas-generation-error";

type ResizeCorner = "top-left" | "top-right" | "bottom-left" | "bottom-right";
const selectionBlue = "#2f80ff";
const GROUP_KIND_ICONS = { image: ImageIcon, video: Video, audio: Music2, text: FileText, other: Puzzle };

type CanvasNodeProps = {
    data: CanvasNodeData;
    scale: number;
    isSelected: boolean;
    isRelated: boolean;
    isFocusRelated: boolean;
    isConnectionTarget: boolean;
    isConnectionRejected?: boolean;
    hasInvalidConnections?: boolean;
    isConnecting: boolean;
    referenceSelectionState?: "target" | "disabled" | "available";
    showImageInfo: boolean;
    mentionReferences?: CanvasResourceReference[];
    pluginHost?: CanvasPluginHost;
    registryVersion?: number;
    renderNodeContent?: (node: CanvasNodeData) => ReactNode;
    groupChildCount?: number;
    groupSummary?: CanvasGroupSummary;
    isLocked?: boolean;
    onToggleGroupCollapse?: (nodeId: string) => void;
    isGroupDropTarget?: boolean;
    batchExpanded?: boolean;
    onMouseDown: (event: React.MouseEvent, nodeId: string) => void;
    onSelectCapture?: (event: React.MouseEvent, nodeId: string) => void;
    onHoverStart: (nodeId: string) => void;
    onHoverEnd: (nodeId: string) => void;
    onConnectStart: (event: React.MouseEvent, nodeId: string, handleType: "source" | "target") => void;
    onResizeStart: (nodeId: string) => void;
    onResize: (nodeId: string, width: number, height: number, position?: Position) => void;
    onResizeEnd: (nodeId: string) => void;
    onContentChange: (nodeId: string, content: string) => void;
    onTitleChange: (nodeId: string, title: string) => void;
    onEditingTitleChange?: (nodeId: string, isEditing: boolean) => void;
    onToggleBatch?: (nodeId: string) => void;
    onSetBatchPrimary?: (nodeId: string, itemId: string) => void;
    onDuplicateBatchImage?: (node: CanvasNodeData, imageId: string) => void;
    onDownloadBatchImage?: (node: CanvasNodeData, imageId: string) => void;
    onRetryBatchImage?: (node: CanvasNodeData, imageId: string) => void;
    onDeleteBatchImage?: (nodeId: string, imageId: string) => void;
    onRetry?: (node: CanvasNodeData) => void;
    onViewImage?: (node: CanvasNodeData, imageId?: string) => void;
    onSelectReference?: (nodeId: string) => void;
    onSelectGroupChildren?: (nodeId: string) => void;
    onContextMenu: (event: React.MouseEvent, nodeId: string) => void;
    onConnectClick?: (event: React.MouseEvent, nodeId: string, handleType: "source") => void;
    hasMultipleSelected?: boolean;
};

type NodeContentRendererProps = {
    node: CanvasNodeData;
    theme: (typeof canvasThemes)[keyof typeof canvasThemes];
    isEditingContent: boolean;
    textareaRef: React.RefObject<HTMLTextAreaElement | null>;
    isBatchRoot: boolean;
    batchCount: number;
    batchExpanded: boolean;
    renderNodeContent?: (node: CanvasNodeData) => ReactNode;
    pluginContext?: CanvasNodeContext | null;
    onContentChange: (nodeId: string, content: string) => void;
    onStopEditing: () => void;
    mentionReferences: CanvasResourceReference[];
    onRetry?: (node: CanvasNodeData) => void;
    onToggleBatch?: () => void;
    onSetBatchPrimary?: (itemId: string) => void;
    onDuplicateBatchImage?: (imageId: string) => void;
    onDownloadBatchImage?: (imageId: string) => void;
    onRetryBatchImage?: (imageId: string) => void;
    onDeleteBatchImage?: (imageId: string) => void;
    onViewBatchImage?: (imageId: string) => void;
    onViewMedia?: () => void;
    groupChildCount: number;
    groupSummary?: CanvasGroupSummary;
    isLocked?: boolean;
    /** 画布缩放比。节点内的标题栏按 1/scale 反算，避免分组放大时文字跟着糊成一片。 */
    scale?: number;
    onToggleGroupCollapse?: (nodeId: string) => void;
};

export const CanvasNode = React.memo(function CanvasNode({
    data,
    scale,
    isSelected,
    isRelated,
    isFocusRelated,
    isConnectionTarget,
    isConnectionRejected = false,
    hasInvalidConnections = false,
    isConnecting,
    referenceSelectionState,
    showImageInfo,
    mentionReferences = [],
    pluginHost,
    renderNodeContent,
    groupChildCount = 0,
    groupSummary,
    isLocked = false,
    onToggleGroupCollapse,
    isGroupDropTarget = false,
    batchExpanded = false,
    onMouseDown,
    onSelectCapture,
    onHoverStart,
    onHoverEnd,
    onConnectStart,
    onResizeStart,
    onResize,
    onResizeEnd,
    onContentChange,
    onTitleChange,
    onEditingTitleChange,
    onToggleBatch,
    onSetBatchPrimary,
    onDuplicateBatchImage,
    onDownloadBatchImage,
    onRetryBatchImage,
    onDeleteBatchImage,
    onRetry,
    onViewImage,
    onSelectReference,
    onSelectGroupChildren,
    onContextMenu,
    onConnectClick,
    hasMultipleSelected = false,
}: CanvasNodeProps) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const { t } = useTranslation();
    const safeScale = scale > 0 ? scale : 1;
    const activeRoomId = useCollabStore((state) => state.activeRoomId);
    const collabRole = useCollabStore((state) => state.role);
    const isViewer = Boolean(activeRoomId && collabRole === "viewer");
    const [hovered, setHovered] = useState(false);
    const definition = getNodeDefinition(data.type);
    const pluginContext = useMemo<CanvasNodeContext | null>(() => (pluginHost ? buildNodeContext(pluginHost, data, theme, scale, isSelected) : null), [pluginHost, data, theme, scale, isSelected]);
    const [isEditingContent, setIsEditingContent] = useState(false);
    const [isEditingTitle, setIsEditingTitle] = useState(false);
    const [titleDraft, setTitleDraft] = useState(data.title || "");

    useEffect(() => {
        if (!isEditingTitle) return;
        onEditingTitleChange?.(data.id, true);
        return () => {
            onEditingTitleChange?.(data.id, false);
        };
    }, [data.id, isEditingTitle, onEditingTitleChange]);
    const hasImageContent = data.type === CanvasNodeType.Image && Boolean(data.metadata?.content || data.metadata?.images?.some((img) => Boolean(img.content)));
    const hasVideoContent = data.type === CanvasNodeType.Video && Boolean(data.metadata?.content);
    const hasAudioContent = data.type === CanvasNodeType.Audio && Boolean(data.metadata?.content);
    const isGroup = data.type === CanvasNodeType.Group;
    // A collapsed group shrinks to a compact title card, so its resize handles would fight the layout.
    const isCollapsedGroup = isGroup && Boolean(data.metadata?.collapsed);
    const batchCount = data.type === CanvasNodeType.Image ? data.metadata?.images?.length || 0 : data.type === CanvasNodeType.Text ? data.metadata?.texts?.length || 0 : 0;
    const isBatchRoot = batchCount > 1;
    // Nodes with the interaction/move toggle ignore content pointer events in move mode and allow interaction in interactive mode.
    // forceInteractive states such as editing stay interactive, as do empty nodes so their upload and generation actions remain usable.
    const supportsInteractionToggle = Boolean(definition?.interactionToggle);
    const forceInteractive = supportsInteractionToggle ? Boolean(definition?.forceInteractive?.(data)) : false;
    const contentInteractive = !supportsInteractionToggle || forceInteractive || !data.metadata?.content ? true : Boolean(data.metadata?.interactive);
    // Transparent nodes such as SVGs blend into the canvas while retaining outlines for selected or related states.
    const transparentBg = Boolean(definition?.transparentBackground);
    const isActive = isConnectionTarget || isSelected || isFocusRelated;
    const imageBorderColor = isActive ? selectionBlue : isRelated ? theme.node.muted : "transparent";
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const titleInputRef = useRef<HTMLInputElement>(null);
    const resizeRef = useRef({
        isResizing: false,
        corner: "bottom-right" as ResizeCorner,
        startX: 0,
        startY: 0,
        startLeft: 0,
        startTop: 0,
        startWidth: 0,
        startHeight: 0,
        keepRatio: false,
        ratio: 1,
    });

    useEffect(() => {
        setTitleDraft(data.title || "");
    }, [data.title]);

    useEffect(() => {
        if (!isEditingTitle) return;
        titleInputRef.current?.focus();
        titleInputRef.current?.select();
    }, [isEditingTitle]);

    const finishTitleEditing = useCallback(() => {
        const title = titleDraft.trim() || data.title || t("canvas.node.untitled");
        setTitleDraft(title);
        setIsEditingTitle(false);
        if (title !== data.title) onTitleChange(data.id, title);
    }, [data.id, data.title, onTitleChange, t, titleDraft]);

    useEffect(() => {
        if (!isEditingTitle) return;
        const handleOutsidePointerDown = (event: PointerEvent) => {
            const target = event.target;
            if (target instanceof Node && titleInputRef.current?.contains(target)) return;
            finishTitleEditing();
        };
        window.addEventListener("pointerdown", handleOutsidePointerDown, true);
        return () => window.removeEventListener("pointerdown", handleOutsidePointerDown, true);
    }, [finishTitleEditing, isEditingTitle]);

    useEffect(() => {
        const textarea = textareaRef.current;
        if (!textarea) return;

        const handleWheel = (event: WheelEvent) => event.stopPropagation();
        textarea.addEventListener("wheel", handleWheel, { passive: false });
        return () => textarea.removeEventListener("wheel", handleWheel);
    }, [data.type, isEditingContent]);

    useEffect(() => {
        if (!isEditingContent) return;
        const textarea = textareaRef.current;
        textarea?.focus();
        textarea?.setSelectionRange(textarea.value.length, textarea.value.length);
    }, [isEditingContent]);

    useEffect(() => {
        if (!isEditingContent) return;

        const handleOutsidePointerDown = (event: PointerEvent) => {
            const target = event.target;
            if (!(target instanceof Node)) return;
            if (target instanceof Element && target.closest("[data-canvas-resource-mention-menu]")) return;
            if (isEditingContent && textareaRef.current?.contains(target)) return;

            setIsEditingContent(false);
        };

        window.addEventListener("pointerdown", handleOutsidePointerDown, true);
        return () => window.removeEventListener("pointerdown", handleOutsidePointerDown, true);
    }, [isEditingContent]);

    const handleResizeMove = useCallback(
        (event: MouseEvent) => {
            if (!resizeRef.current.isResizing) return;

            const dx = (event.clientX - resizeRef.current.startX) / scale;
            const dy = (event.clientY - resizeRef.current.startY) / scale;
            const minWidth = 220;
            const minHeight = 160;
            const startRight = resizeRef.current.startLeft + resizeRef.current.startWidth;
            const startBottom = resizeRef.current.startTop + resizeRef.current.startHeight;
            const fromLeft = resizeRef.current.corner.includes("left");
            const fromTop = resizeRef.current.corner.includes("top");
            const rawWidth = Math.max(minWidth, resizeRef.current.startWidth + (fromLeft ? -dx : dx));
            const rawHeight = Math.max(minHeight, resizeRef.current.startHeight + (fromTop ? -dy : dy));
            let width = rawWidth;
            let height = rawHeight;
            if (resizeRef.current.keepRatio) {
                const ratio = resizeRef.current.ratio;
                if (Math.abs(dx) >= Math.abs(dy)) {
                    height = width / ratio;
                } else {
                    width = height * ratio;
                }
                if (height < minHeight) {
                    height = minHeight;
                    width = height * ratio;
                }
                if (width < minWidth) {
                    width = minWidth;
                    height = width / ratio;
                }
            }

            onResize(data.id, width, height, {
                x: fromLeft ? startRight - width : resizeRef.current.startLeft,
                y: fromTop ? startBottom - height : resizeRef.current.startTop,
            });
        },
        [data.id, onResize, scale],
    );

    const handleResizeUp = useCallback(() => {
        resizeRef.current.isResizing = false;
        window.removeEventListener("mousemove", handleResizeMove);
        window.removeEventListener("mouseup", handleResizeUp);
        onResizeEnd(data.id);
    }, [data.id, handleResizeMove, onResizeEnd]);

    const handleResizeMouseDown = (event: React.MouseEvent, corner: ResizeCorner) => {
        event.stopPropagation();
        event.preventDefault();
        onResizeStart(data.id);
        resizeRef.current = {
            isResizing: true,
            corner,
            startX: event.clientX,
            startY: event.clientY,
            startLeft: data.position.x,
            startTop: data.position.y,
            startWidth: data.width,
            startHeight: data.height,
            keepRatio: (data.type === CanvasNodeType.Image && !data.metadata?.freeResize) || data.type === CanvasNodeType.Video || Boolean(definition?.keepAspectRatio?.(data)),
            ratio: (data.metadata?.naturalWidth || data.width) / (data.metadata?.naturalHeight || data.height || 1),
        };
        window.addEventListener("mousemove", handleResizeMove);
        window.addEventListener("mouseup", handleResizeUp);
    };

    useEffect(() => {
        return () => {
            window.removeEventListener("mousemove", handleResizeMove);
            window.removeEventListener("mouseup", handleResizeUp);
        };
    }, [handleResizeMove, handleResizeUp]);

    return (
        <div
            data-node-id={data.id}
            className={`node-element absolute flex select-none flex-col transition-shadow duration-200 ${isGroup ? "z-[5]" : isSelected ? "z-50" : "z-10"} ${referenceSelectionState === "available" ? "cursor-pointer" : referenceSelectionState ? "cursor-not-allowed" : ""}`}
            style={{
                transform: `translate(${data.position.x}px, ${data.position.y}px)`,
                width: data.width,
                height: data.height,
                transition: "box-shadow 200ms ease",
                contain: "layout style",
            }}
            onMouseEnter={() => {
                setHovered(true);
                onHoverStart(data.id);
            }}
            onMouseLeave={() => {
                setHovered(false);
                onHoverEnd(data.id);
            }}
            onMouseDownCapture={(event) => {
                if (!referenceSelectionState) onSelectCapture?.(event, data.id);
            }}
            onContextMenu={(event) => {
                if (referenceSelectionState) event.preventDefault();
                else onContextMenu(event, data.id);
            }}
        >
            {!referenceSelectionState && (isSelected || hovered || isEditingTitle) && (
                <div
                    className="absolute left-3 bottom-full z-[65] origin-bottom-left"
                    style={{
                        transform: `scale(${1 / safeScale})`,
                        paddingBottom: 6,
                        maxWidth: `${Math.max(160, (data.width - 24) * safeScale)}px`,
                    }}
                    onMouseDown={(event) => event.stopPropagation()}
                    onPointerDown={(event) => event.stopPropagation()}
                >
                    {isEditingTitle ? (
                        <input
                            ref={titleInputRef}
                            value={titleDraft}
                            maxLength={64}
                            className="h-6 max-w-full border-0 border-b border-dashed bg-transparent px-0 text-left text-xs font-medium outline-none"
                            style={{ borderColor: theme.node.muted, color: theme.node.text }}
                            onChange={(event) => setTitleDraft(event.target.value)}
                            onBlur={finishTitleEditing}
                            onKeyDown={(event) => {
                                if (event.key === "Enter") finishTitleEditing();
                                if (event.key === "Escape") {
                                    setTitleDraft(data.title || "");
                                    setIsEditingTitle(false);
                                }
                            }}
                        />
                    ) : (
                        <button
                            type="button"
                            className="block max-w-full truncate border-b border-dashed border-transparent px-0 py-0.5 text-left text-xs font-medium opacity-75 transition hover:border-current hover:opacity-100"
                            style={{ color: theme.node.text }}
                            title={t("canvas.node.renameHint")}
                            onDoubleClick={(event) => {
                                event.stopPropagation();
                                if (isLocked) return;
                                setIsEditingTitle(true);
                            }}
                        >
                            {data.title || t("canvas.node.untitled")}
                        </button>
                    )}
                </div>
            )}

            <div
                className="relative h-full w-full overflow-visible rounded-3xl border-2"
                style={{
                    background: isGroup ? "transparent" : hasImageContent || hasVideoContent || transparentBg ? "transparent" : theme.node.fill,
                    borderColor: isConnectionRejected
                        ? "#ef4444"
                        : isGroup
                          ? (isGroupDropTarget || isActive ? selectionBlue : theme.node.stroke)
                          : hasImageContent
                            ? imageBorderColor
                            : isActive
                              ? selectionBlue
                              : isRelated
                                ? theme.node.muted
                                : hasInvalidConnections
                                  ? "#f59e0b"
                                  : transparentBg
                                    ? "transparent"
                                    : theme.node.stroke,
                    borderStyle: isGroup ? "dashed" : hasInvalidConnections && !isActive ? "dashed" : "solid",
                    boxShadow: isConnectionRejected
                        ? "0 0 0 2px #ef4444, 0 0 20px rgba(239, 68, 68, 0.45)"
                        : isGroupDropTarget
                          ? `0 0 0 2px ${selectionBlue}66, inset 0 0 0 999px ${selectionBlue}10`
                          : isActive
                            ? `0 0 0 1px ${selectionBlue}55`
                            : hasInvalidConnections
                              ? "0 0 0 1px #f59e0b55"
                              : isRelated
                                ? `0 0 0 1px ${theme.node.muted}55, 0 18px 48px rgba(0,0,0,.14)`
                                : undefined,
                }}
                onMouseDown={(event) => {
                    if (!referenceSelectionState) onMouseDown(event, data.id);
                    else if (event.button === 0 && referenceSelectionState === "available") {
                        event.stopPropagation();
                        onSelectReference?.(data.id);
                    }
                }}
                onDoubleClick={(event) => {
                    if (referenceSelectionState) {
                        event.stopPropagation();
                        return;
                    }
                    if (definition?.onDoubleClick && pluginContext) {
                        if (definition.onDoubleClick(pluginContext)) event.stopPropagation();
                        return;
                    }
                    if ((data.type === CanvasNodeType.Image && hasImageContent) || (data.type === CanvasNodeType.Video && hasVideoContent)) {
                        event.stopPropagation();
                        onViewImage?.(data);
                        return;
                    }
                    if (data.type === CanvasNodeType.Group) {
                        event.stopPropagation();
                        // 双击折叠的分组直接展开（和点击标题栏箭头一致），避免"看不见内容又选不中里面"的死角。
                        if (isCollapsedGroup) {
                            onToggleGroupCollapse?.(data.id);
                            return;
                        }
                        onSelectGroupChildren?.(data.id);
                        return;
                    }
                    if (data.type !== CanvasNodeType.Text) return;
                    event.stopPropagation();
                    if (isLocked) return;
                    setIsEditingContent(true);
                }}
            >
                <div
                    className={`relative flex h-full w-full items-center justify-center rounded-[inherit] ${isBatchRoot ? "overflow-visible" : "overflow-hidden"}`}
                    style={
                        {
                            background: isGroup ? "transparent" : hasImageContent || hasVideoContent || transparentBg ? "transparent" : theme.node.fill,
                            pointerEvents: contentInteractive ? undefined : "none",
                        } as React.CSSProperties
                    }
                >
                    <NodeContent
                        node={data}
                        theme={theme}
                        isEditingContent={isEditingContent}
                        textareaRef={textareaRef}
                        isBatchRoot={isBatchRoot}
                        batchCount={batchCount}
                        batchExpanded={batchExpanded}
                        renderNodeContent={renderNodeContent}
                        pluginContext={pluginContext}
                        mentionReferences={mentionReferences}
                        onContentChange={onContentChange}
                        onStopEditing={() => setIsEditingContent(false)}
                        onRetry={onRetry}
                        onToggleBatch={() => onToggleBatch?.(data.id)}
                        onSetBatchPrimary={(itemId) => onSetBatchPrimary?.(data.id, itemId)}
                        onDuplicateBatchImage={(imageId) => onDuplicateBatchImage?.(data, imageId)}
                        onDownloadBatchImage={(imageId) => onDownloadBatchImage?.(data, imageId)}
                        onRetryBatchImage={(imageId) => onRetryBatchImage?.(data, imageId)}
                        onDeleteBatchImage={(imageId) => onDeleteBatchImage?.(data.id, imageId)}
                        onViewBatchImage={(imageId) => onViewImage?.(data, imageId)}
                        onViewMedia={() => onViewImage?.(data)}
                        groupChildCount={groupChildCount}
                        groupSummary={groupSummary}
                        isLocked={isLocked}
                        scale={safeScale}
                        onToggleGroupCollapse={onToggleGroupCollapse}
                    />
                </div>

                {showImageInfo && hasImageContent ? <ImageInfoBar node={data} /> : null}

                {!isGroup && !hasImageContent && !hasVideoContent && !hasAudioContent ? <div className="pointer-events-none absolute inset-x-0 bottom-0 h-12" style={{ background: `linear-gradient(to top, ${theme.canvas.background}66, transparent)` }} /> : null}

                {referenceSelectionState && (referenceSelectionState !== "available" || hovered) ? (
                    <div className="pointer-events-none absolute inset-0 z-[60] grid place-items-center rounded-[inherit]" style={{ background: `color-mix(in srgb, ${theme.canvas.background} ${referenceSelectionState === "target" ? 78 : referenceSelectionState === "disabled" ? 60 : 34}%, transparent)`, boxShadow: referenceSelectionState === "available" ? `inset 0 0 0 2px ${selectionBlue}` : undefined }}>
                        {referenceSelectionState !== "disabled" ? <span className="rounded-lg px-3 py-2 text-sm font-medium shadow-sm" style={{ background: theme.toolbar.panel, color: theme.node.text }}>{t(referenceSelectionState === "target" ? "canvas.references.selecting" : "canvas.references.choose")}</span> : null}
                    </div>
                ) : null}

                {!referenceSelectionState && !isViewer && !isLocked && !isCollapsedGroup ? <ResizeHandle corner="top-left" onMouseDown={handleResizeMouseDown} /> : null}
                {!referenceSelectionState && !isViewer && !isLocked && !isCollapsedGroup ? <ResizeHandle corner="top-right" onMouseDown={handleResizeMouseDown} /> : null}
                {!referenceSelectionState && !isViewer && !isLocked && !isCollapsedGroup ? <ResizeHandle corner="bottom-left" onMouseDown={handleResizeMouseDown} /> : null}
                {!referenceSelectionState && !isViewer && !isLocked && !isCollapsedGroup ? <ResizeHandle corner="bottom-right" onMouseDown={handleResizeMouseDown} /> : null}
            </div>

            {!referenceSelectionState && !isGroup && !isViewer ? (
                <ConnectionHandleDot
                    side="left"
                    visible={hovered || isSelected || isConnecting}
                    scale={safeScale}
                    onMouseDown={(event) => onConnectStart(event, data.id, "target")}
                />
            ) : null}
            {!referenceSelectionState && !isViewer && (definition?.hasSourceHandle ?? true) && data.type !== CanvasNodeType.Config && !(hasMultipleSelected && isSelected) ? (
                <ConnectionHandleDot
                    side="right"
                    visible={hovered || isSelected || isConnecting}
                    scale={safeScale}
                    onMouseDown={(event) => onConnectStart(event, data.id, "source")}
                    onClick={(event) => onConnectClick?.(event, data.id, "source")}
                />
            ) : null}
        </div>
    );
});

function NodeContent(props: NodeContentRendererProps) {
    const { node } = props;
    const slots = (node.type === CanvasNodeType.Image ? node.metadata?.images : node.type === CanvasNodeType.Text ? node.metadata?.texts : undefined) || [];
    const hasError = node.metadata?.status === "error" || Boolean(node.metadata?.errorDetails) || slots.some((slot) => slot.status === "error");
    const hasContent = Boolean(node.metadata?.content || slots.some((slot) => slot.content));
    const isConfig = node.type === CanvasNodeType.Config && Boolean(props.renderNodeContent);
    const failedWithoutContent = !hasContent && (node.metadata?.status === "error" || slots.length > 0 && slots.every((slot) => slot.status === "error"));
    if (!isConfig && failedWithoutContent && !props.isBatchRoot) return <CanvasGenerationError node={node} onRetry={props.onRetry} />;
    const rendersSlots = node.type === CanvasNodeType.Image && props.isBatchRoot || node.type === CanvasNodeType.Text && slots.length > 0;
    if (!isConfig && node.metadata?.status === "loading" && !rendersSlots) return <LoadingContent theme={props.theme} node={node} />;

    const Renderer = nodeContentRenderers[node.type as CanvasNodeType];
    let content: ReactNode = isConfig ? props.renderNodeContent?.(node) : Renderer ? <Renderer {...props} /> : null;

    // Render plugin nodes with their registered renderer, or show the missing-plugin placeholder.
    if (!Renderer) {
        const definition = getNodeDefinition(node.type);
        const PluginContent = definition?.Content;
        content = PluginContent && props.pluginContext ? <PluginContent ctx={props.pluginContext} /> : <MissingPluginContent theme={props.theme} type={node.type} />;
    }
    if (!hasError) return content;
    return (
        <div className="flex h-full w-full min-w-0 flex-col">
            <div className={`relative min-h-0 flex-1 ${isConfig ? "thin-scrollbar overflow-y-auto" : ""}`}>{content}</div>
            <div className="min-h-0 basis-1/2 shrink-0"><CanvasGenerationError node={node} onRetry={isConfig ? undefined : props.onRetry} /></div>
        </div>
    );
}

const nodeContentRenderers = {
    [CanvasNodeType.Text]: TextContent,
    [CanvasNodeType.Image]: ImageNodeContent,
    [CanvasNodeType.Config]: EmptyImageContent,
    [CanvasNodeType.Video]: VideoNodeContent,
    [CanvasNodeType.Audio]: AudioNodeContent,
    [CanvasNodeType.Group]: GroupNodeContent,
} satisfies Record<CanvasNodeType, (props: NodeContentRendererProps) => ReactNode>;

function GroupNodeContent({ node, theme, groupSummary, isLocked, scale, onToggleGroupCollapse }: NodeContentRendererProps) {
    const { t } = useTranslation();
    const collapsed = Boolean(node.metadata?.collapsed);
    const locked = isLocked ?? Boolean(node.metadata?.locked);
    const safeScale = scale && scale > 0 ? scale : 1;
    const collapseLabel = collapsed ? t("canvas.node.expand") : t("canvas.node.collapse");
    const kinds = groupSummary?.kinds;
    const kindEntries = (["image", "video", "audio", "text"] as CanvasGroupKind[]).filter((kind) => (kinds?.[kind] || 0) > 0);
    return (
        <div className={`pointer-events-none flex h-full w-full flex-col p-3 ${collapsed ? "gap-2" : "items-start"}`}>
            <div className="flex w-full max-w-full origin-top-left items-center gap-2 text-[13px] font-medium" style={{ color: theme.node.text, transform: `scale(${1 / safeScale})` }}>
                <button
                    type="button"
                    className="pointer-events-auto grid size-5 shrink-0 place-items-center rounded transition hover:bg-black/10 dark:hover:bg-white/10"
                    aria-label={collapseLabel}
                    title={collapseLabel}
                    onMouseDown={(event) => event.stopPropagation()}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => {
                        event.stopPropagation();
                        onToggleGroupCollapse?.(node.id);
                    }}
                >
                    <ChevronRight className={`size-3.5 shrink-0 transition-transform ${collapsed ? "" : "rotate-90"}`} style={{ color: theme.node.muted }} />
                </button>
                <Group className="size-3.5 shrink-0" style={{ color: theme.node.muted }} />
                <span className="truncate">{node.title || t("canvas.node.group")}</span>
                {locked ? <Lock className="size-3 shrink-0" style={{ color: theme.node.muted }} /> : null}
                {collapsed ? null : (
                    <>
                        <span className="shrink-0 text-[11px] font-normal" style={{ color: theme.node.muted }}>
                            {t("canvas.node.nodeCount", { count: groupSummary?.count || 0 })}
                        </span>
                        {groupSummary?.running ? <span className="shrink-0 text-[11px] font-normal" style={{ color: theme.node.activeStroke }}>{t("canvas.node.groupRunning", { count: groupSummary.running })}</span> : null}
                        {groupSummary?.failed ? <span className="shrink-0 text-[11px] font-normal text-red-400">{t("canvas.node.groupFailed", { count: groupSummary.failed })}</span> : null}
                    </>
                )}
            </div>
            {collapsed ? (
                <>
                    {/* 收起态把"里面有什么、还在不在跑"压成一行摘要 + 预览条，展开前也能判断要不要打开。 */}
                    <div className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 text-xs font-normal" style={{ color: theme.node.muted }}>
                        <span>{t("canvas.node.nodeCount", { count: groupSummary?.count || 0 })}</span>
                        {kindEntries.map((kind) => {
                            const KindIcon = GROUP_KIND_ICONS[kind];
                            return (
                                <span key={kind} className="flex shrink-0 items-center gap-1">
                                    <KindIcon className="size-3.5" />
                                    {kinds?.[kind]}
                                </span>
                            );
                        })}
                    </div>
                    <div className="flex w-full items-center gap-1.5">
                        {(groupSummary?.previews || []).map((preview) => {
                            const PreviewIcon = GROUP_KIND_ICONS[preview.kind];
                            return (
                                <span key={preview.id} className="grid size-11 shrink-0 place-items-center overflow-hidden rounded-lg border" style={{ borderColor: theme.node.stroke, background: theme.node.panel }}>
                                    {preview.src ? <img src={preview.src} alt="" className="size-full object-cover" /> : <PreviewIcon className="size-4" style={{ color: theme.node.muted }} />}
                                </span>
                            );
                        })}
                    </div>
                    {groupSummary?.running || groupSummary?.failed ? (
                        <div className="flex w-full items-center gap-3 text-xs font-normal">
                            {groupSummary.running ? <span style={{ color: theme.node.activeStroke }}>{t("canvas.node.groupRunning", { count: groupSummary.running })}</span> : null}
                            {groupSummary.failed ? <span className="text-red-400">{t("canvas.node.groupFailed", { count: groupSummary.failed })}</span> : null}
                        </div>
                    ) : null}
                </>
            ) : null}
        </div>
    );
}

function GenerationProgress({ theme, pct, caption }: { theme: NodeContentRendererProps["theme"]; pct?: number; caption?: string }) {
    if (typeof pct !== "number") return null;
    const width = Math.max(0, Math.min(100, pct));
    return (
        <div className="flex w-24 flex-col items-center gap-1.5">
            <div className="h-[3px] w-full overflow-hidden rounded-full" style={{ background: theme.node.stroke }}>
                <div className="h-full rounded-full transition-[width] duration-300 ease-out" style={{ width: `${width}%`, background: theme.node.activeStroke }} />
            </div>
            {caption ? (
                <span className="text-[10px] tracking-[0.1em]" style={{ color: theme.node.activeStroke }}>
                    {caption}
                </span>
            ) : null}
        </div>
    );
}

function LoadingContent({ theme, node }: Pick<NodeContentRendererProps, "theme"> & { node?: CanvasNodeData }) {
    const { t } = useTranslation();
    // 分段任务的段节点一提交就全铺在画布上，轮到谁才真正开始跑。
    // 都画成转圈的话，十个节点长得一样，看不出"哪个在跑、哪些在等" ——
    // 排队用静止的虚线圈，跑起来的才转。
    const segment = node?.metadata?.videoSegment;
    const waiting = node?.metadata?.queueState === "waiting";
    const loadingText = waiting ? t("canvas.videoTimeline.node.queued") : formatNodeLoadingText(node?.metadata);
    return (
        <div className="flex h-full w-full flex-col items-center justify-center gap-3" style={{ color: theme.node.activeStroke }}>
            {waiting ? (
                <div className="size-9 rounded-full border-2 border-dashed opacity-50" style={{ borderColor: theme.node.activeStroke }} />
            ) : (
                <div className="size-10 animate-spin rounded-full border-2" style={{ borderColor: theme.node.stroke, borderTopColor: theme.node.activeStroke }} />
            )}
            <GenerationProgress theme={theme} pct={node?.metadata?.progressPct} caption={formatProgressCaption(node?.metadata)} />
            {segment ? <span className="rounded-full bg-indigo-600/80 px-2 py-0.5 text-[10px] font-medium text-white">{t("canvas.videoTimeline.node.segmentBadge", { index: segment.index + 1 })}</span> : null}
            <span className="text-[10px] tracking-[0.2em]">{loadingText}</span>
        </div>
    );
}

function MissingPluginContent({ theme, type }: Pick<NodeContentRendererProps, "theme"> & { type: string }) {
    const { t } = useTranslation();
    return (
        <div className="flex h-full w-full flex-col items-center justify-center gap-2 px-4 text-center" style={{ color: theme.node.placeholder }}>
            <Puzzle className="size-7 opacity-40" />
            <span className="text-sm">{t("canvas.node.missingPlugin")}</span>
            <span className="text-[11px] opacity-70">{t("canvas.node.missingPluginDescription", { type })}</span>
        </div>
    );
}

function TextContent({ node, theme, isEditingContent, textareaRef, mentionReferences, batchExpanded, onContentChange, onStopEditing, onToggleBatch, onSetBatchPrimary }: NodeContentRendererProps) {
    const { t } = useTranslation();
    const fontSize = node.metadata?.fontSize || 14;
    const textStyle = { fontSize: `${fontSize}px`, lineHeight: `${Math.round(fontSize * 1.65)}px`, color: theme.node.text, boxSizing: "border-box" } as React.CSSProperties;
    const texts = node.metadata?.texts || [];
    const batchCount = texts.length;
    const isBatchRoot = batchCount > 1;
    const primaryText =
        texts.find((text) => text.id === node.metadata?.primaryTextId && Boolean(text.content)) ||
        texts.find((text) => Boolean(text.content)) ||
        texts.find((text) => text.id === node.metadata?.primaryTextId) ||
        texts[0];
    const primaryTextId = primaryText?.id || node.metadata?.primaryTextId || texts[0]?.id;
    const content = primaryText?.content || node.metadata?.content || "";
    const paddingClass = isBatchRoot ? "px-4 pb-4 pt-14" : "p-4";

    return (
        <BatchFrame batchCount={batchCount} batchExpanded={batchExpanded}>
            {batchExpanded
                ? texts
                      .filter((text) => text.id !== primaryTextId)
                      .map((text, index) => <ExpandedTextCard key={text.id} node={node} text={text} index={index} onSetPrimary={() => onSetBatchPrimary?.(text.id)} />)
                : null}
            <div className="flex h-full w-full flex-col overflow-hidden rounded-3xl">
                {isEditingContent ? (
                    <CanvasResourceMentionTextarea
                        ref={textareaRef}
                        className={`thin-scrollbar block h-full w-full resize-none overflow-y-auto whitespace-pre-wrap break-words border-none bg-transparent m-0 font-mono outline-none select-text appearance-none ${paddingClass}`}
                        style={textStyle}
                        value={content}
                        references={mentionReferences}
                        highlightLabels={false}
                        onChange={(value) => onContentChange(node.id, value)}
                        onBlur={(event) => {
                            if (event.relatedTarget instanceof HTMLElement && event.relatedTarget.closest("[data-canvas-resource-mention-menu]")) {
                                return;
                            }
                            onStopEditing();
                        }}
                        onKeyDown={(event) => {
                            if (event.key === "Escape") onStopEditing();
                        }}
                        onMouseDown={(event) => event.stopPropagation()}
                        onPointerDown={(event) => event.stopPropagation()}
                        onWheel={(event) => event.stopPropagation()}
                    />
                ) : content ? (
                    <div className={`thin-scrollbar block h-full w-full overflow-y-auto whitespace-pre-wrap break-words bg-transparent font-mono ${paddingClass}`} style={textStyle} onWheel={(event) => event.stopPropagation()}>
                        {content}
                    </div>
                ) : primaryText ? (
                    <TextSlotStatus text={primaryText} />
                ) : (
                    <div className="p-4 font-mono" style={{ color: theme.node.placeholder }}>
                        {t("canvas.node.editText")}
                    </div>
                )}
            </div>
            {isBatchRoot ? (
                <button
                    type="button"
                    className="absolute right-2.5 top-2.5 z-30 flex h-8 items-center justify-center gap-1.5 rounded-full border px-3 text-xs font-semibold shadow-[0_6px_18px_rgba(28,25,23,.12)] backdrop-blur-md transition hover:scale-[1.02]"
                    style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.toolbar.activeText }}
                    aria-label={batchExpanded ? t("canvas.node.textBatchExpanded") : t("canvas.node.textBatchCollapsed")}
                    onClick={(event) => {
                        event.stopPropagation();
                        onToggleBatch?.();
                    }}
                    onMouseDown={(event) => event.stopPropagation()}
                    onPointerDown={(event) => event.stopPropagation()}
                >
                    <span className="leading-none">{t("canvas.controls.texts", { count: batchCount })}</span>
                    <ChevronRight className={`size-3.5 opacity-80 transition-transform ${batchExpanded ? "rotate-90" : ""}`} />
                </button>
            ) : null}
        </BatchFrame>
    );
}

function ExpandedTextCard({ node, text, index, onSetPrimary }: { node: CanvasNodeData; text: CanvasNodeText; index: number; onSetPrimary: () => void }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const { t } = useTranslation();
    const count = node.metadata?.texts?.length || 0;
    const columns = Math.min(count, 4);
    const rows = Math.ceil(count / columns);
    const rootSlot = (rows - 1) * columns;
    const slot = index >= rootSlot ? index + 1 : index;
    const x = (slot % columns) * (node.width + 18);
    const y = (Math.floor(slot / columns) - rows + 1) * (node.height + 18);

    return (
        <div
            className="group absolute z-20 overflow-hidden rounded-3xl border shadow-[0_18px_50px_rgba(28,25,23,.14)]"
            style={
                {
                    left: x,
                    top: y,
                    width: node.width,
                    height: node.height,
                    background: theme.node.panel,
                    borderColor: theme.node.stroke,
                    "--batch-from-x": `${-x}px`,
                    "--batch-from-y": `${-y}px`,
                    "--batch-from-rotate": `${4 + index * 2}deg`,
                    animation: `canvas-batch-child-in 320ms ${index * 35}ms cubic-bezier(.2,.85,.18,1) both`,
                } as React.CSSProperties
            }
            onMouseDown={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
        >
            {text.content ? (
                <>
                    <div className="thin-scrollbar h-full overflow-y-auto whitespace-pre-wrap break-words p-4 font-mono text-sm leading-6" style={{ color: theme.node.text }} onWheel={(event) => event.stopPropagation()}>
                        {text.content}
                    </div>
                    <button
                        type="button"
                        className="absolute right-2.5 top-2.5 flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium opacity-0 transition-opacity duration-150 group-hover:opacity-100 hover:bg-black/5 dark:hover:bg-white/10"
                        style={{ color: theme.node.text }}
                        onClick={(event) => (event.stopPropagation(), onSetPrimary())}
                    >
                        <Star className="size-3.5" style={{ color: selectionBlue }} />
                        {t("canvas.node.setPrimaryText")}
                    </button>
                </>
            ) : (
                <TextSlotStatus text={text} />
            )}
        </div>
    );
}

function TextSlotStatus({ text }: { text: CanvasNodeText }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const { t } = useTranslation();
    const failed = text.status === "error";
    const loading = text.status === "loading";
    const loadingText = formatNodeLoadingText(text);

    return (
        <div className="flex h-full w-full flex-col items-center justify-center gap-3 px-6 text-center" style={{ background: theme.node.fill, color: failed ? theme.node.text : theme.node.activeStroke }}>
            {failed ? (
                <CanvasGenerationError errorDetails={text.errorDetails} />
            ) : loading ? (
                <div className="size-10 animate-spin rounded-full border-2" style={{ borderColor: theme.node.stroke, borderTopColor: theme.node.activeStroke }} />
            ) : (
                <span className="text-xs">{t("apiErrors.noContent")}</span>
            )}
            {loading ? <GenerationProgress theme={theme} pct={text.progressPct} caption={formatProgressCaption(text)} /> : null}
            {loading ? <span className="text-[10px] tracking-[0.2em]">{loadingText}</span> : null}
        </div>
    );
}

function ImageNodeContent(props: NodeContentRendererProps) {
    if (!props.node.metadata?.content && !props.isBatchRoot) return <EmptyImageContent {...props} />;

    return (
        <ImageContent
            node={props.node}
            batchExpanded={props.batchExpanded}
            onToggleBatch={props.onToggleBatch}
            onSetBatchPrimary={props.onSetBatchPrimary}
            onDuplicateBatchImage={props.onDuplicateBatchImage}
            onDownloadBatchImage={props.onDownloadBatchImage}
            onRetryBatchImage={props.onRetryBatchImage}
            onDeleteBatchImage={props.onDeleteBatchImage}
            onViewBatchImage={props.onViewBatchImage}
        />
    );
}

function EmptyImageContent({ theme }: NodeContentRendererProps) {
    const { t } = useTranslation();
    return (
        <div className="flex h-full w-full flex-col items-center justify-center gap-3" style={{ color: theme.node.placeholder }}>
            <div className="flex size-14 items-center justify-center rounded-2xl" style={{ background: theme.toolbar.activeBg }}>
                <ImageIcon className="size-6 opacity-30" />
            </div>
            <span className="text-[10px] tracking-[0.18em] opacity-50">{t("canvas.node.emptyImage")}</span>
        </div>
    );
}

function VideoNodeContent({ node, theme, onViewMedia }: NodeContentRendererProps) {
    const { t } = useTranslation();
    if (!node.metadata?.content) {
        return (
            <div className="flex h-full w-full flex-col items-center justify-center gap-2" style={{ color: theme.node.placeholder }}>
                <div className="flex size-12 items-center justify-center rounded-2xl bg-black/5 dark:bg-white/5">
                    <Video className="size-6 opacity-30" />
                </div>
                <span className="text-[10px] tracking-[0.18em] opacity-50">{t("canvas.node.emptyVideo")}</span>
            </div>
        );
    }
    // 段与成片都要能一眼认出来：画布上并排躺着十几个视频节点时，靠标题区分太慢。
    const segment = node.metadata.videoSegment;
    const composite = node.metadata.videoComposite;
    const referenceClip = node.metadata.referenceClip;
    const badge = segment
        ? `${t("canvas.videoTimeline.node.segmentBadge", { index: segment.index + 1 })} · ${formatTimecode(segment.startMs)}–${formatTimecode(segment.endMs)}`
        : composite
          ? t("canvas.videoTimeline.node.compositeParts", { count: composite.partNodeIds.length })
          : referenceClip
            ? `${t("canvas.videoTimeline.node.clipBadge")} · ${formatTimecode(referenceClip.startMs)}–${formatTimecode(referenceClip.endMs)}`
            : "";
    return (
        <div className="relative h-full w-full">
            <CanvasVideoPlayer nodeId={node.id} src={node.metadata.content} onPreview={onViewMedia} />
            {badge ? (
                <span
                    className={`pointer-events-none absolute left-2 top-2 z-20 flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium text-white shadow backdrop-blur ${
                        composite ? "bg-emerald-600/80" : referenceClip ? "bg-stone-600/80" : "bg-indigo-600/80"
                    }`}
                >
                    {composite ? <Layers className="size-2.5" /> : null}
                    {badge}
                </span>
            ) : null}
            {/* 这一段吃的参考：只有角色图（首尾帧类工作流才多两张原片帧）。
                徽章只报数，明细在节点右侧面板里。有它才能一眼看出"这段到底挂没挂角色"，
                而不是等到角色没换对才发现。 */}
            {segment ? (
                <span
                    className="pointer-events-none absolute right-2 top-2 z-20 rounded-full bg-indigo-600/70 px-2 py-0.5 text-[10px] font-medium text-white shadow backdrop-blur"
                    title={t("canvas.videoTimeline.node.referenceBadgeTip", { cast: segment.castSnapshot?.length ?? segment.castNodeIds?.length ?? 0 })}
                >
                    {t("canvas.videoTimeline.node.referenceBadge", { count: (segment.castSnapshot?.length ?? segment.castNodeIds?.length ?? 0) + (segment.anchor?.headFrameMs !== undefined ? 2 : 0) })}
                </span>
            ) : null}
            {/* 时长偏差提示：合成时已按目标归一化，节奏不会错，但差得多说明内容没生成完整。 */}
            {segment?.durationDriftMs ? (
                <span className="pointer-events-none absolute bottom-2 left-2 z-20 rounded-full bg-amber-600/85 px-2 py-0.5 text-[10px] font-medium text-white shadow backdrop-blur">
                    {t("canvas.videoTimeline.node.durationDrift", { seconds: (segment.durationDriftMs / 1000).toFixed(1) })}
                </span>
            ) : null}
        </div>
    );
}

function AudioNodeContent({ node, theme }: NodeContentRendererProps) {
    const { t } = useTranslation();
    // 同一个音频节点跑两条产线，画布上至少要能一眼分清谁在说什么、哪个是配乐。
    const isVoice = node.metadata?.audioKind === "voice";
    const KindIcon = isVoice ? Mic : Music2;
    const kindLabel = isVoice ? node.metadata?.voiceName || t("canvas.promptPanel.voiceKindVoice") : t("canvas.node.audio");
    if (!node.metadata?.content)
        return (
            <div className="flex h-full w-full flex-col items-center justify-center gap-2" style={{ color: theme.node.placeholder }}>
                <KindIcon className="size-7 opacity-35" />
                <span className="text-sm">{isVoice ? t("canvas.node.emptyVoice") : t("canvas.node.emptyAudio")}</span>
            </div>
        );
    return (
        <div className="flex h-full w-full flex-col justify-center gap-3 px-4" style={{ background: theme.node.fill, color: theme.node.text }}>
            {node.metadata?.status !== "error" ? (
                <div className="flex min-w-0 items-center gap-2 text-sm opacity-70">
                    <KindIcon className="size-4 shrink-0" />
                    <span className="truncate">{kindLabel}</span>
                </div>
            ) : null}
            <audio src={node.metadata.content} controls className="w-full" data-canvas-no-zoom />
        </div>
    );
}

function ImageContent({
    node,
    batchExpanded,
    onToggleBatch,
    onSetBatchPrimary,
    onDuplicateBatchImage,
    onDownloadBatchImage,
    onRetryBatchImage,
    onDeleteBatchImage,
    onViewBatchImage,
}: {
    node: CanvasNodeData;
    batchExpanded: boolean;
    onToggleBatch?: () => void;
    onSetBatchPrimary?: (imageId: string) => void;
    onDuplicateBatchImage?: (imageId: string) => void;
    onDownloadBatchImage?: (imageId: string) => void;
    onRetryBatchImage?: (imageId: string) => void;
    onDeleteBatchImage?: (imageId: string) => void;
    onViewBatchImage?: (imageId: string) => void;
}) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const { t } = useTranslation();
    const images = node.metadata?.images || [];
    const batchCount = images.length;
    const isBatchRoot = batchCount > 1;
    const primaryImage = images.find((image) => image.id === node.metadata?.primaryImageId && Boolean(image.content)) || images.find((image) => Boolean(image.content)) || images[0];
    const primaryImageId = primaryImage?.id || node.metadata?.primaryImageId || images[0]?.id;
    const primaryContent = primaryImage?.content || node.metadata?.content;

    return (
        <BatchFrame batchCount={batchCount} batchExpanded={batchExpanded}>
            {batchExpanded
                ? images
                      .filter((image) => image.id !== primaryImageId)
                      .map((image, index) => <ExpandedImageCard key={image.id} node={node} image={image} index={index} onView={() => onViewBatchImage?.(image.id)} onSetPrimary={() => onSetBatchPrimary?.(image.id)} onDuplicate={() => onDuplicateBatchImage?.(image.id)} onDownload={() => onDownloadBatchImage?.(image.id)} onRetry={() => onRetryBatchImage?.(image.id)} onDelete={() => onDeleteBatchImage?.(image.id)} />)
                : null}
            <div className="h-full w-full overflow-hidden rounded-3xl">
                {primaryContent ? (
                    <img
                        src={primaryContent}
                        alt={node.title}
                        draggable={false}
                        onDragStart={(event) => event.preventDefault()}
                        className={`pointer-events-none block h-full w-full select-none ${node.metadata?.freeResize ? "object-fill" : "object-contain"}`}
                    />
                ) : (
                    <ImageSlotStatus image={primaryImage} />
                )}
            </div>
            {isBatchRoot ? (
                <button
                    type="button"
                    className="absolute right-2.5 top-2.5 z-30 flex h-8 items-center justify-center gap-1.5 rounded-full border px-3 text-xs font-semibold shadow-[0_6px_18px_rgba(28,25,23,.16)] backdrop-blur-md transition hover:scale-[1.02]"
                    style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.toolbar.activeText }}
                    aria-label={batchExpanded ? t("canvas.node.batchExpanded") : t("canvas.node.batchCollapsed")}
                    onClick={(event) => {
                        event.stopPropagation();
                        onToggleBatch?.();
                    }}
                    onMouseDown={(event) => event.stopPropagation()}
                    onPointerDown={(event) => event.stopPropagation()}
                >
                    <span className="leading-none">{t("canvas.controls.images", { count: batchCount })}</span>
                    <ChevronRight className={`size-3.5 opacity-80 transition-transform ${batchExpanded ? "rotate-90" : ""}`} />
                </button>
            ) : null}
        </BatchFrame>
    );
}

function ExpandedImageCard({ node, image, index, onView, onSetPrimary, onDuplicate, onDownload, onRetry, onDelete }: { node: CanvasNodeData; image: CanvasNodeImage; index: number; onView: () => void; onSetPrimary: () => void; onDuplicate: () => void; onDownload: () => void; onRetry: () => void; onDelete: () => void }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const { t } = useTranslation();
    const count = node.metadata?.images?.length || 0;
    const columns = Math.min(count, 4);
    const rows = Math.ceil(count / columns);
    const rootSlot = (rows - 1) * columns;
    const slot = index >= rootSlot ? index + 1 : index;
    const column = slot % columns;
    const row = Math.floor(slot / columns);
    const x = column * (node.width + 18);
    const y = (row - rows + 1) * (node.height + 18);

    return (
        <div
            className={`group absolute z-20 overflow-hidden rounded-3xl ${image.content ? "" : "border shadow-[0_18px_50px_rgba(28,25,23,.18)]"}`}
            style={
                {
                    left: x,
                    top: y,
                    width: node.width,
                    height: node.height,
                    background: "transparent",
                    borderColor: theme.node.stroke,
                    "--batch-from-x": `${-x}px`,
                    "--batch-from-y": `${-y}px`,
                    "--batch-from-rotate": `${4 + index * 2}deg`,
                    animation: `canvas-batch-child-in 320ms ${index * 35}ms cubic-bezier(.2,.85,.18,1) both`,
                } as React.CSSProperties
            }
            onMouseDown={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
            onDoubleClick={(event) => {
                if (!image.content || (event.target instanceof Element && event.target.closest("button"))) return;
                event.stopPropagation();
                onView();
            }}
        >
            {image.content ? <img src={image.content} alt={node.title} draggable={false} className="pointer-events-none h-full w-full select-none object-contain" /> : <ImageSlotStatus image={image} />}
            {image.content ? (
                <div className="absolute inset-x-2 top-2 flex items-center gap-1 opacity-0 transition-opacity duration-150 group-hover:opacity-100 pointer-events-none group-hover:pointer-events-auto">
                    <button type="button" className="flex h-8 min-w-0 flex-1 items-center justify-center gap-1 rounded-lg border px-1.5 text-[10px] font-medium shadow-[0_6px_18px_rgba(15,23,42,.16)] backdrop-blur-md transition hover:scale-[1.02]" style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.toolbar.activeText }} title={t("common.download")} onClick={(event) => (event.stopPropagation(), onDownload())}>
                        <Download className="size-3 shrink-0" />
                        <span className="truncate">{t("common.download")}</span>
                    </button>
                    <button type="button" className="flex h-8 min-w-0 flex-1 items-center justify-center gap-1 rounded-lg border px-1.5 text-[10px] font-medium shadow-[0_6px_18px_rgba(15,23,42,.16)] backdrop-blur-md transition hover:scale-[1.02]" style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.toolbar.activeText }} title={t("canvas.node.createCopy")} onClick={(event) => (event.stopPropagation(), onDuplicate())}>
                        <Copy className="size-3 shrink-0" />
                        <span className="truncate">{t("canvas.node.createCopy")}</span>
                    </button>
                    <button type="button" className="flex h-8 min-w-0 flex-1 items-center justify-center gap-1 rounded-lg border px-1.5 text-[10px] font-medium shadow-[0_6px_18px_rgba(15,23,42,.16)] backdrop-blur-md transition hover:scale-[1.02]" style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.toolbar.activeText }} title={t("canvas.node.setPrimary")} onClick={(event) => (event.stopPropagation(), onSetPrimary())}>
                        <Star className="size-3 shrink-0" style={{ color: selectionBlue }} />
                        <span className="truncate">{t("canvas.node.setPrimary")}</span>
                    </button>
                </div>
            ) : null}
        </div>
    );
}

function ImageSlotStatus({ image }: { image?: CanvasNodeImage }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const { t } = useTranslation();
    const failed = image?.status === "error";
    const loading = image?.status === "loading";
    const loadingText = formatNodeLoadingText(image);

    return (
        <div className="flex h-full w-full flex-col items-center justify-center gap-3 px-6 text-center" style={{ background: theme.node.fill, color: failed ? theme.node.text : theme.node.activeStroke }}>
            {failed ? (
                <CanvasGenerationError errorDetails={image?.errorDetails} />
            ) : loading ? (
                <>
                    <div className="size-10 animate-spin rounded-full border-2" style={{ borderColor: theme.node.stroke, borderTopColor: theme.node.activeStroke }} />
                    <GenerationProgress theme={theme} pct={image?.progressPct} caption={formatProgressCaption(image)} />
                    <span className="text-[10px] tracking-[0.2em]">{loadingText}</span>
                </>
            ) : (
                <div className="flex flex-col items-center justify-center gap-2" style={{ color: theme.node.placeholder }}>
                    <div className="flex size-12 items-center justify-center rounded-2xl" style={{ background: theme.toolbar.activeBg }}>
                        <ImageIcon className="size-5 opacity-30" />
                    </div>
                    <span className="text-[10px] tracking-[0.18em] opacity-50">{t("canvas.node.emptyImage")}</span>
                </div>
            )}
        </div>
    );
}

function ImageInfoBar({ node }: { node: CanvasNodeData }) {
    const width = Math.round(node.metadata?.naturalWidth || node.width);
    const height = Math.round(node.metadata?.naturalHeight || node.height);
    const size = formatBytes(node.metadata?.bytes || 0);
    return (
        <div className="pointer-events-none absolute bottom-3 right-3 z-40 max-w-[calc(100%-24px)]">
            <span className="max-w-full truncate rounded-md bg-black/55 px-2 py-1 text-[11px] font-medium leading-none text-white backdrop-blur-sm">
                {width} x {height}
                {size ? ` · ${size}` : ""}
            </span>
        </div>
    );
}

function BatchFrame({ batchCount, batchExpanded, children }: { batchCount: number; batchExpanded: boolean; children: ReactNode }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const isBatchRoot = batchCount > 1;
    return (
        <div className="group/batch relative h-full w-full overflow-visible">
            {isBatchRoot ? (
                <div className="pointer-events-none absolute inset-0 overflow-visible">
                    {Array.from({ length: Math.min(batchCount - 1, 3) }).map((_, index) => (
                        <div
                            key={index}
                            className="absolute rounded-[inherit] border shadow-[0_10px_24px_rgba(68,64,60,.12)] transition-all duration-300 group-hover/batch:translate-x-1"
                            style={{
                                inset: 0,
                                background: `linear-gradient(135deg, ${theme.node.panel}, ${theme.node.fill})`,
                                borderColor: theme.node.stroke,
                                opacity: batchExpanded ? 0 : 1,
                                transform: `translate(${10 + index * 6}px, ${4 + index * 3}px) rotate(${1.5 + index}deg)`,
                                zIndex: -index - 1,
                            }}
                        />
                    ))}
                </div>
            ) : null}
            {children}
        </div>
    );
}
function ResizeHandle({ corner, onMouseDown }: { corner: ResizeCorner; onMouseDown: (event: React.MouseEvent, corner: ResizeCorner) => void }) {
    const positionClass = {
        "top-left": "-left-[14px] -top-[14px] cursor-nwse-resize",
        "top-right": "-right-[14px] -top-[14px] cursor-nesw-resize",
        "bottom-left": "-bottom-[14px] -left-[14px] cursor-nesw-resize",
        "bottom-right": "-bottom-[14px] -right-[14px] cursor-nwse-resize",
    }[corner];

    return <div className={`absolute z-50 size-7 ${positionClass}`} onMouseDown={(event) => onMouseDown(event, corner)} />;
}

function ConnectionHandleDot({
    side,
    visible,
    scale = 1,
    onMouseDown,
    onClick,
}: {
    side: "left" | "right";
    visible: boolean;
    scale?: number;
    onMouseDown: (event: React.MouseEvent) => void;
    onClick?: (event: React.MouseEvent) => void;
}) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const containerRef = useRef<HTMLDivElement>(null);
    const [isHovered, setIsHovered] = useState(false);
    const [stickyOffset, setStickyOffset] = useState<{ x: number; y: number } | null>(null);
    const isDraggingRef = useRef(false);
    const dragStartPosRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
    const safeScale = scale > 0 ? scale : 1;
    const isRight = side === "right";
    const dragThreshold = isRight ? 46 : 38;

    // 鼠标在触点感应范围悬浮移动时，触点磁吸粘连跟随鼠标移动（仅向外侧延伸，禁止向节点内部移动）
    const handlePointerMove = (event: React.PointerEvent) => {
        if (isDraggingRef.current) return;
        const container = containerRef.current;
        if (!container) return;

        const rect = container.getBoundingClientRect();
        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;
        const dx = event.clientX - centerX;
        const dy = event.clientY - centerY;

        // 向节点内部移动时立即解除粘连并回弹原位（右触点禁止向左内移，左触点禁止向右内移）
        const isInward = isRight ? dx <= 0 : dx >= 0;
        if (isInward) {
            setStickyOffset(null);
            return;
        }

        const distance = Math.hypot(dx, dy);

        if (distance > 0) {
            // 仅向节点外侧粘连跟随
            const maxFollow = isRight ? 28 : 18;
            const pull = Math.min(distance * 0.7, maxFollow);
            setStickyOffset({
                x: (dx / distance) * pull,
                y: (dy / distance) * pull,
            });
        }
    };

    // 鼠标离开且没有发生拖拽时，触点平滑弹回原位
    const handlePointerLeave = () => {
        setIsHovered(false);
        if (!isDraggingRef.current) {
            setStickyOffset(null);
        }
    };

    // 鼠标按下进入拖拽连线流程
    const handlePointerDown = (event: React.PointerEvent) => {
        event.stopPropagation();
        if (event.button !== 0) return;

        dragStartPosRef.current = { x: event.clientX, y: event.clientY };
        isDraggingRef.current = true;

        const onWindowPointerMove = (moveEvent: PointerEvent) => {
            if (!isDraggingRef.current) return;
            const dx = moveEvent.clientX - dragStartPosRef.current.x;
            const dy = moveEvent.clientY - dragStartPosRef.current.y;

            // 拖拽时若向节点内部移动，也禁止向内拉伸，保持在原位
            const isInward = isRight ? dx <= 0 : dx >= 0;
            if (isInward) {
                setStickyOffset(null);
                return;
            }

            const distance = Math.hypot(dx, dy);

            if (distance < dragThreshold) {
                // 拖拽拉伸
                setStickyOffset({ x: dx * 0.65, y: dy * 0.65 });
            } else {
                // 达到拖拽阈值：触点弹回原位并抽出连线
                isDraggingRef.current = false;
                setStickyOffset(null);
                window.removeEventListener("pointermove", onWindowPointerMove);
                window.removeEventListener("pointerup", onWindowPointerUp);
                onMouseDown(moveEvent as unknown as React.MouseEvent);
            }
        };

        const onWindowPointerUp = (upEvent: PointerEvent) => {
            if (!isDraggingRef.current) return;
            isDraggingRef.current = false;
            window.removeEventListener("pointermove", onWindowPointerMove);
            window.removeEventListener("pointerup", onWindowPointerUp);

            const dx = Math.abs(upEvent.clientX - dragStartPosRef.current.x);
            const dy = Math.abs(upEvent.clientY - dragStartPosRef.current.y);
            setStickyOffset(null);

            // 未达到阈值松开时触发点击
            if (dx < dragThreshold && dy < dragThreshold) {
                onClick?.(upEvent as unknown as React.MouseEvent);
            }
        };

        window.addEventListener("pointermove", onWindowPointerMove);
        window.addEventListener("pointerup", onWindowPointerUp);
    };

    const isVisible = visible || isHovered || Boolean(stickyOffset);
    const containerSize = isRight ? "size-20" : "size-14";
    const bridgeClass = isRight ? "w-8 -left-8" : "w-6 -right-6";

    return (
        <div
            ref={containerRef}
            data-connection-handle
            className={`absolute z-30 flex ${containerSize} cursor-crosshair items-center justify-center transition-opacity duration-150 ${
                isVisible ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0"
            }`}
            style={{
                left: isRight ? "calc(100% + 12px)" : "-12px",
                top: "50%",
                transform: `translate(-50%, -50%) scale(${1 / safeScale})`,
                transformOrigin: "center center",
            }}
            onMouseEnter={() => setIsHovered(true)}
            onPointerMove={handlePointerMove}
            onPointerLeave={handlePointerLeave}
            onPointerDown={handlePointerDown}
            title={isRight ? "点击快捷创建 / 拖拽连线" : "拖拽连线"}
            aria-label="连接触点"
        >
            <div className={`pointer-events-auto absolute top-0 h-full ${bridgeClass}`} />
            {isRight ? (
                <div
                    className={`flex size-6.5 items-center justify-center rounded-full border shadow-sm ${
                        isHovered || stickyOffset ? "scale-125 shadow-md" : ""
                    }`}
                    style={{
                        background: theme.node.panel,
                        borderColor: theme.node.activeStroke || theme.node.stroke,
                        color: theme.node.text,
                        transform: stickyOffset ? `translate(${stickyOffset.x}px, ${stickyOffset.y}px)` : "translate(0, 0)",
                        transition: stickyOffset
                            ? "transform 40ms ease-out"
                            : "transform 240ms cubic-bezier(0.34, 1.56, 0.64, 1), scale 150ms ease",
                    }}
                >
                    <Plus className="size-3.5 stroke-[2.5]" />
                </div>
            ) : (
                <div
                    className={`size-3 rounded-full border-2 ${isHovered || stickyOffset ? "scale-125" : ""}`}
                    style={{
                        background: theme.node.panel,
                        borderColor: theme.node.muted,
                        transform: stickyOffset ? `translate(${stickyOffset.x}px, ${stickyOffset.y}px)` : "translate(0, 0)",
                        transition: stickyOffset
                            ? "transform 40ms ease-out"
                            : "transform 240ms cubic-bezier(0.34, 1.56, 0.64, 1), scale 150ms ease",
                    }}
                />
            )}
        </div>
    );
}
