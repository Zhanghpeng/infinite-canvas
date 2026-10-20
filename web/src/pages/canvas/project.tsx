import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent as ReactChangeEvent, DragEvent as ReactDragEvent, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Group, Video } from "lucide-react";
import { saveAs } from "file-saver";
import { useTranslation } from "react-i18next";

import { requestEdit, requestGeneration, requestImageQuestion } from "@/services/api/image";
import { generateRandomSeed, requestComfyuiImage } from "@/services/api/comfyui";
import { requestAudioGeneration, storeGeneratedAudio } from "@/services/api/audio";
import { requestVideoGeneration, storeGeneratedVideo } from "@/services/api/video";
import { defaultConfig, findWorkflow, getDefaultComfyWorkflowItems, getDefaultWorkflow, inpaintModelOptions, resolveModelChannel, useConfigStore, useEffectiveConfig, type AiConfig } from "@/stores/use-config-store";
import { resolveImageUrl, uploadImage } from "@/services/image-storage";
import { getMediaBlob, resolveMediaUrl, uploadMediaFile } from "@/services/file-storage";
import { nanoid } from "nanoid";
import { getDataUrlByteSize, readImageMeta } from "@/lib/image-utils";
import { canvasThemes, type CanvasBackgroundMode } from "@/lib/canvas-theme";
import { useAssetStore, type BundleConnection, type BundleItem, type BundleSlot } from "@/stores/use-asset-store";
import { useThemeStore } from "@/stores/use-theme-store";
import { cropDataUrl, splitDataUrl, upscaleDataUrl } from "@/lib/canvas/canvas-image-data";
import { fitNodeSize, nodeSizeFromRatio } from "@/lib/canvas/canvas-node-size";
import { captureVideoFrame, type VideoFramePosition } from "@/lib/canvas/canvas-video-frame";
import { extractAudioFromVideo } from "@/lib/canvas/canvas-video-audio";
import { concatVideoParts, cutVideoSegment, isMediaProcessingSupported, probeVideo, type ConcatPart } from "@/lib/canvas/video-clip";
import { captureFrameDataUrl } from "@/lib/canvas/video-scene-detect";
import { formatDuration, type VideoRange } from "@/lib/canvas/video-timeline";
import { App, Button, Modal } from "antd";
import { NODE_DEFAULT_SIZE, getNodeSpec } from "@/constant/canvas";
import { ActiveConnectionPath, ConnectionPath } from "@/components/canvas/canvas-connections";
import { CanvasConfigComposer } from "@/components/canvas/canvas-config-composer";
import { CanvasConfigNodePanel } from "@/components/canvas/canvas-config-node-panel";
import { CanvasNodeContextMenu } from "@/components/canvas/canvas-context-menu";
import { CanvasNodeCropDialog, type CanvasImageCropRect } from "@/components/canvas/canvas-node-crop-dialog";
import { CanvasNodeMaskEditDialog, type CanvasImageMaskEditPayload } from "@/components/canvas/canvas-node-mask-edit-dialog";
import { CanvasNodeSplitDialog, type CanvasImageSplitParams } from "@/components/canvas/canvas-node-split-dialog";
import { CanvasNodeUpscaleDialog, type CanvasImageUpscaleParams } from "@/components/canvas/canvas-node-upscale-dialog";
import { CanvasFaceRefineModal } from "@/components/canvas/canvas-face-refine-modal";
import { CanvasVideoTimelineModal, type VideoEditPlan } from "@/components/canvas/canvas-video-timeline-modal";
import { CanvasDepthVideoModal } from "@/components/canvas/canvas-depth-video-modal";
import { buildNodeGenerationContext, buildNodeGenerationInputs, buildNodeResponseMessages, hydrateNodeGenerationContext, type NodeGenerationContext, type NodeGenerationInput } from "@/components/canvas/canvas-node-generation";
import { CanvasNodeHoverToolbar, CanvasNodeInfoModal } from "@/components/canvas/canvas-node-hover-toolbar";
import { InfiniteCanvas } from "@/components/canvas/infinite-canvas";
import { Minimap } from "@/components/canvas/canvas-mini-map";
import { CanvasNode } from "@/components/canvas/canvas-node";
import { CanvasAlignmentGuides } from "@/components/canvas/canvas-alignment-guides";
import { CanvasMultiSelectionOverlay } from "@/components/canvas/canvas-multi-selection-overlay";
import { calculateAlignmentSnap, type AlignmentGuideLine } from "@/lib/canvas/canvas-alignment-snapping";
import { CanvasNodePromptPanel, type CanvasNodeGenerationMode } from "@/components/canvas/canvas-node-prompt-panel";
import { CanvasToolbar } from "@/components/canvas/canvas-toolbar";
import { AssetPickerModal, type BundleEntryPayload, type InsertAssetPayload } from "@/components/canvas/asset-picker-modal";
import { CanvasSidePanel } from "@/components/canvas/canvas-side-panel";
import { CanvasZoomControls } from "@/components/canvas/canvas-zoom-controls";
import { CanvasSelectionToolbar } from "@/components/canvas/canvas-selection-toolbar";
import { alignSelectedNodes, boundsOfNodes, distributeSelectedNodes, type NodeAlignMode, type NodeDistributeMode } from "@/lib/canvas/canvas-layout-actions";
import { useAgentStore } from "@/stores/use-agent-store";
import { useCanvasStore, type CanvasProject } from "@/stores/canvas/use-canvas-store";
import { useCollabStore } from "@/stores/use-collab-store";
import { useCanvasCollab } from "@/pages/canvas/hooks/use-canvas-collab";
import { CanvasCollabCursors, CanvasCollabSelectionOutlines } from "@/components/canvas/canvas-collab-cursors";
import { CanvasCollabModal } from "@/components/canvas/canvas-collab-modal";
import { useAgentBridge } from "@/pages/canvas/hooks/use-agent-bridge";
import { usePluginHost } from "@/pages/canvas/hooks/use-plugin-host";
import { buildNodeMentionReferences, getGroupResourceNodes, isCanvasReferenceNode, type CanvasResourceReference } from "@/lib/canvas/canvas-resource-references";
import { collectCollapsedNodeIds, collectGroupDescendantIds, isNodeLocked } from "@/lib/canvas/canvas-group-collapse";
import { applyOptimizedText, appendOptimizedTextSlot, assistantOutputSummaryText, buildNodeOutputRequest, buildPromptAssistantRequest, cleanOptimizedPrompt, collectWorkflowSlots, MAX_ASSISTANT_SOURCE_CHARS, readNodeText, resolveAssistantTargetCategory, resolveSkillProduces, resolveWorkflowConstraint, revertOptimizedTextSlot, summarizeAssistantOutput, type PromptAssistantConfig } from "@/lib/canvas/canvas-prompt-assistant";
import type { BuiltinPromptSkillId } from "@/lib/canvas/prompt-skills";
import { readAgentClientId } from "@/lib/agent/agent-client-id";
import { AgentApiError, fetchAgentJson, interruptCodexTurn } from "@/services/api/canvas-agent";
import { useAgentSkillStore } from "@/stores/use-agent-skill-store";
import { usePromptAssistantStore } from "@/stores/use-prompt-assistant-store";
import { exportCanvasProjects, safeFileName } from "@/lib/canvas/canvas-export";
import { applyNodeConfigPatch, audioMetadata, buildAudioGenerationMetadata, buildImageGenerationMetadata, cloneNodeMetadata, createCanvasNode, imageMetadata, videoMetadata } from "@/lib/canvas/canvas-node-factory";
import {
    calculateGroupBoundsForNodes,
    captureEnclosedNodesIntoGroup,
    findContainingGroupId,
    findGroupDropTarget,
    fitGroupToEnclosedChildren,
    getConnectionTargetAnchor,
    isNodeEnclosedInGroup,
    normalizeConnection,
    snapNodesIntoGroup,
    syncGroupMembershipAfterTransform,
    ungroupCanvasGroup,
} from "@/lib/canvas/canvas-node-geometry";
import {
    audioExtension,
    buildGeneratedNodeConnections,
    buildGenerationConfig,
    buildPastedNodeConnections,
    duplicateIncomingConnections,
    generateNextSeed,
    generationReferenceUrls,
    getGenerationCount,
    getInputSummary,
    hydrateAssistantImages,
    hydrateCanvasImages,
    countInterruptedTasks,
    hasInterruptedGeneration,
    imageExtension,
    isAudioFile,
    isGenerationCanceled,
    isInterruptedGenerationError,
    resetInterruptedGeneration,
    restoreGenerationContext,
    shouldMarkGenerationSourceStatus,
} from "@/lib/canvas/canvas-generation-helpers";
import { getNodeDefinition, isBuiltinNodeType as isBuiltinType, useNodeRegistryVersion } from "@/lib/canvas/node-registry";
import { registerBuiltinNodes } from "@/components/canvas/nodes/builtin-nodes";
import { CanvasInterruptedBanner } from "@/components/canvas/canvas-interrupted-banner";
import { CanvasPluginManagerModal } from "@/components/canvas/canvas-plugin-manager-modal";
import { CanvasRefreshShell } from "@/components/canvas/canvas-refresh-shell";
import { CanvasTopBar } from "@/components/canvas/canvas-top-bar";
import { ConnectionCreateMenu, NodeCreateMenu, type PendingConnectionCreate } from "@/components/canvas/canvas-create-menus";
import {
    CanvasNodeType,
    type CanvasAssistantImage,
    type CanvasAssistantSession,
    type CanvasConnection,
    type CanvasGenerationIntent,
    type CanvasGroupKind,
    type CanvasGroupSummary,
    type CanvasNodeData,
    type CanvasNodeImage,
    type CanvasNodeText,
    type CanvasNodeMetadata,
    type CanvasNodeTypeId,
    type ConnectionHandle,
    type ContextMenuState,
    type Position,
    type SelectionBox,
    type ViewportTransform,
} from "@/types/canvas";
import type { ReferenceImage } from "@/types/image";
import type { ReferenceAudio } from "@/types/media";

// Register built-in nodes in the shared registry once when the module loads.
registerBuiltinNodes();

type CanvasClipboard = {
    nodes: CanvasNodeData[];
    connections: CanvasConnection[];
};

type ConnectionDropTarget = {
    nodeId: string | null;
    isNearNode: boolean;
};

type CanvasHistoryEntry = Pick<CanvasClipboard, "nodes" | "connections"> & {
    chatSessions: CanvasAssistantSession[];
    activeChatId: string | null;
    backgroundMode: CanvasBackgroundMode;
    showImageInfo: boolean;
};

type CanvasGenerationRequest = {
    targetNodeId: string;
    originNodeId: string;
    runningNodeId: string;
    controller: AbortController;
};

const VIDEO_NODE_MAX_WIDTH = 420;
const VIDEO_NODE_MAX_HEIGHT = 420;
// Stable empty reference array prevents `... || []` from invalidating CanvasNode's React.memo on every render.
const EMPTY_REFERENCES: CanvasResourceReference[] = [];
const CONNECTION_HANDLE_HIT_RADIUS = 40;
const CONNECTION_NODE_HIT_PADDING = 32;
const NODE_STATUS_IDLE = "idle" as const;
const NODE_STATUS_LOADING = "loading" as const;
const NODE_STATUS_SUCCESS = "success" as const;
const NODE_STATUS_ERROR = "error" as const;
const GROUP_KIND_ORDER: Record<CanvasGroupKind, number> = { image: 0, video: 1, audio: 2, text: 3, other: 4 };

function groupMemberKind(node: CanvasNodeData): CanvasGroupKind {
    if (node.type === CanvasNodeType.Image) return "image";
    if (node.type === CanvasNodeType.Video) return "video";
    if (node.type === CanvasNodeType.Audio) return "audio";
    if (node.type === CanvasNodeType.Text) return "text";
    return "other";
}

/** 只有图片有廉价稳定的缩略图来源，其余类型在分组摘要里用图标代替。 */
function groupPreviewSource(node: CanvasNodeData) {
    if (node.type !== CanvasNodeType.Image) return undefined;
    return node.metadata?.images?.find((image) => image.id === node.metadata?.primaryImageId)?.content || node.metadata?.content;
}

/** 源视频可能落在 IndexedDB、本地目录或远端，统一取成 Blob 才能切分。 */
async function loadNodeVideoBlob(node: CanvasNodeData): Promise<Blob> {
    if (node.metadata?.storageKey) {
        const stored = await getMediaBlob(node.metadata.storageKey);
        if (stored) return stored;
    }
    const response = await fetch(node.metadata?.content || "");
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.blob();
}

export default function CanvasPage() {
    const [mounted, setMounted] = useState(false);

    useEffect(() => {
        setMounted(true);
    }, []);

    if (!mounted) return <CanvasRefreshShell />;

    return <InfiniteCanvasPage />;
}

function CanvasPreviewVideo({ src }: { src: string }) {
    const videoRef = useRef<HTMLVideoElement>(null);

    useEffect(() => {
        const video = videoRef.current;
        if (!video) return;

        const playPromise = video.play();
        if (playPromise !== undefined) {
            playPromise.catch(() => {
                // Autoplay with sound may be blocked by browser policy until user interacts
            });
        }

        return () => {
            video.pause();
        };
    }, [src]);

    return <video ref={videoRef} src={src} controls autoPlay playsInline loop className="max-h-[80vh] max-w-full rounded-xl bg-black object-contain shadow-2xl" />;
}

function InfiniteCanvasPage() {
    const { message, modal } = App.useApp();
    const { t } = useTranslation();
    // Subscribe to the registry version so plugin registration changes rerender the canvas.
    const nodeRegistryVersion = useNodeRegistryVersion((state) => state.version);
    const params = useParams<{ id: string }>();
    const navigate = useNavigate();
    const [searchParams, setSearchParams] = useSearchParams();
    const projectId = params.id || "";
    const localAgentConnected = useAgentStore((state) => state.connected);
    const localAgentActivity = useAgentStore((state) => state.activity);
    const localAgentEnabled = useAgentStore((state) => state.enabled);
    const fragmentBootstrap = useAgentStore((state) => state.fragmentBootstrap);
    const agentPanelOpen = useAgentStore((state) => state.panelOpen);
    const toggleAgentPanel = useAgentStore((state) => state.togglePanel);
    const openAgentPanel = useAgentStore((state) => state.openPanel);
    const containerRef = useRef<HTMLDivElement>(null);
    const imageInputRef = useRef<HTMLInputElement>(null);
    const uploadTargetRef = useRef<{ nodeId?: string; position?: Position } | null>(null);
    const clipboardRef = useRef<CanvasClipboard | null>(null);
    const historyRef = useRef<{ past: CanvasHistoryEntry[]; future: CanvasHistoryEntry[] }>({ past: [], future: [] });
    const lastHistoryRef = useRef<CanvasHistoryEntry | null>(null);
    const historyCommitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const viewportSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const applyingHistoryRef = useRef(false);
    const historyPausedRef = useRef(false);
    const didInitialCenterRef = useRef(false);
    const rafRef = useRef<number | null>(null);
    const nodeDraggingRef = useRef(false);
    const dragRef = useRef<{
        isDraggingNode: boolean;
        hasMoved: boolean;
        startX: number;
        startY: number;
        initialSelectedNodes: { id: string; x: number; y: number }[];
        snappedDx?: number;
        snappedDy?: number;
    }>({
        isDraggingNode: false,
        hasMoved: false,
        startX: 0,
        startY: 0,
        initialSelectedNodes: [],
    });

    const config = useConfigStore((state) => state.config);
    const effectiveConfig = useEffectiveConfig();
    const inpaintOptions = inpaintModelOptions(effectiveConfig);
    const isAiConfigReady = useConfigStore((state) => state.isAiConfigReady);
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const addAsset = useAssetStore((state) => state.addAsset);
    const cleanupAssetImages = useAssetStore((state) => state.cleanupImages);
    const hydrated = useCanvasStore((state) => state.hydrated);
    const createProject = useCanvasStore((state) => state.createProject);
    const openProject = useCanvasStore((state) => state.openProject);
    const updateProject = useCanvasStore((state) => state.updateProject);
    const renameProject = useCanvasStore((state) => state.renameProject);
    const deleteProjects = useCanvasStore((state) => state.deleteProjects);
    const currentProject = useCanvasStore((state) => state.projects.find((project) => project.id === projectId));
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const [nodes, setNodes] = useState<CanvasNodeData[]>([]);
    const [connections, setConnections] = useState<CanvasConnection[]>([]);
    const [chatSessions, setChatSessions] = useState<CanvasAssistantSession[]>([]);
    const [activeChatId, setActiveChatId] = useState<string | null>(null);
    const [viewport, setViewport] = useState<ViewportTransform>({ x: 0, y: 0, k: 1 });
    const [canvasTool, setCanvasTool] = useState<"select" | "pan">("select");
    const [size, setSize] = useState({ width: 1200, height: 720 });
    const [selectedNodeIds, setSelectedNodeIds] = useState<Set<string>>(new Set());
    const [selectedConnectionId, setSelectedConnectionId] = useState<string | null>(null);
    const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
    const [connectingParams, setConnectingParams] = useState<ConnectionHandle | null>(null);
    const [connectionTargetNodeId, setConnectionTargetNodeId] = useState<string | null>(null);
    const [pendingConnectionCreate, setPendingConnectionCreate] = useState<PendingConnectionCreate | null>(null);
    const [mouseWorld, setMouseWorld] = useState<Position>({ x: 0, y: 0 });
    const [selectionBox, setSelectionBox] = useState<SelectionBox | null>(null);
    const [alignmentGuides, setAlignmentGuides] = useState<AlignmentGuideLine[]>([]);
    const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
    const [nodeCreatePosition, setNodeCreatePosition] = useState<Position | null>(null);
    const [runningNodeIds, setRunningNodeIds] = useState<Set<string>>(() => new Set());
    const [isMiniMapOpen, setIsMiniMapOpen] = useState(false);
    const [backgroundMode, setBackgroundMode] = useState<CanvasBackgroundMode>("lines");
    const [showImageInfo, setShowImageInfo] = useState(false);
    const [clearConfirmOpen, setClearConfirmOpen] = useState(false);
    const [deleteConfirmNodes, setDeleteConfirmNodes] = useState<Set<string> | null>(null);
    const [assetPickerOpen, setAssetPickerOpen] = useState(false);
    const [projectLoaded, setProjectLoaded] = useState(false);
    const [toolbarNodeId, setToolbarNodeId] = useState<string | null>(null);
    const [editingTitleNodeId, setEditingTitleNodeId] = useState<string | null>(null);
    const [nodeImageSettingsOpen, setNodeImageSettingsOpen] = useState(false);
    const [dialogNodeId, setDialogNodeId] = useState<string | null>(null);
    const [infoNodeId, setInfoNodeId] = useState<string | null>(null);
    const [pluginManagerOpen, setPluginManagerOpen] = useState(false);
    const [cropNodeId, setCropNodeId] = useState<string | null>(null);
    const [maskEditNodeId, setMaskEditNodeId] = useState<string | null>(null);
    const [splitNodeId, setSplitNodeId] = useState<string | null>(null);
    const [upscaleNodeId, setUpscaleNodeId] = useState<string | null>(null);
    const [faceRefineNode, setFaceRefineNode] = useState<CanvasNodeData | null>(null);
    const [depthVideoNode, setDepthVideoNode] = useState<CanvasNodeData | null>(null);
    const [videoTimelineNode, setVideoTimelineNode] = useState<CanvasNodeData | null>(null);
    const [videoTimelineSubmitting, setVideoTimelineSubmitting] = useState(false);
    const [previewNodeId, setPreviewNodeId] = useState<string | null>(null);
    const [previewImageId, setPreviewImageId] = useState<string | null>(null);
    const [titleEditing, setTitleEditing] = useState(false);
    const [titleDraft, setTitleDraft] = useState("");
    const [historyState, setHistoryState] = useState({ canUndo: false, canRedo: false });
    const [expandedBatchNodeIds, setExpandedBatchNodeIds] = useState<Set<string>>(new Set());
    const [isNodeDragging, setIsNodeDragging] = useState(false);
    const [isNodeResizing, setIsNodeResizing] = useState(false);
    const [dropTargetGroupId, setDropTargetGroupId] = useState<string | null>(null);
    const [referencePickerNodeId, setReferencePickerNodeId] = useState<string | null>(null);
    const [interruptedBannerDismissed, setInterruptedBannerDismissed] = useState(false);
    const [isResumingInterrupted, setIsResumingInterrupted] = useState(false);
    // 提示词助手：当前正在改写的节点（按钮切「停止优化」）与进行中的请求。
    const [promptAssistantNodeId, setPromptAssistantNodeId] = useState<string | null>(null);

    const nodesRef = useRef(nodes);
    const connectionsRef = useRef(connections);
    const selectedNodeIdsRef = useRef(selectedNodeIds);
    const viewportRef = useRef(viewport);
    const focusAnimRef = useRef<number | null>(null);
    const generateNodeRef = useRef<((nodeId: string, mode: CanvasNodeGenerationMode, prompt: string, intent?: CanvasGenerationIntent) => Promise<void>) | null>(null);
    const connectingParamsRef = useRef(connectingParams);
    const connectionTargetNodeIdRef = useRef(connectionTargetNodeId);
    const selectionBoxRef = useRef(selectionBox);
    const pendingConnectionCreateRef = useRef(pendingConnectionCreate);
    const generationRequestsRef = useRef(new Map<string, CanvasGenerationRequest>());
    const promptAssistantAbortRef = useRef<AbortController | null>(null);
    // 交互回调（鼠标事件、拖拽）里不便依赖 state，用 ref 兜住折叠/锁定集合。
    const collapsedNodeIdsRef = useRef<Set<string>>(new Set());
    const lockedNodeIdsRef = useRef<Set<string>>(new Set());

    const activeRoomId = useCollabStore((state) => state.activeRoomId);
    const collabRole = useCollabStore((state) => state.role);
    const startCollaboration = useCollabStore((state) => state.startCollaboration);
    const isViewer = Boolean(activeRoomId && collabRole === "viewer");
    const isViewerRef = useRef(isViewer);
    useEffect(() => {
        isViewerRef.current = isViewer;
    }, [isViewer]);

    const lastCursorBroadcastRef = useRef(0);

    const { broadcastCanvasSync, broadcastNodesPatch, broadcastGenerationStatus, broadcastCursor } = useCanvasCollab({
        onRemoteCanvasUpdate: (remoteNodes, remoteConnections, remoteTitle) => {
            setNodes(remoteNodes);
            setConnections(remoteConnections);
            if (remoteTitle && !titleEditing) setTitleDraft(remoteTitle);
        },
        onRemoteNodesPatch: (remoteNodes, remoteConnections) => {
            setNodes(remoteNodes);
            setConnections(remoteConnections);
        },
        onRemoteGenerationStatus: (nodeId, status, errorDetails, metadata) => {
            setNodes((prev) =>
                prev.map((n) =>
                    n.id === nodeId
                        ? {
                              ...n,
                              metadata: {
                                  ...n.metadata,
                                  ...metadata,
                                  status,
                                  errorDetails,
                              },
                          }
                        : n,
                ),
            );
        },
        getCurrentSnapshot: () => ({
            nodes: nodesRef.current,
            connections: connectionsRef.current,
            title: currentProject?.title || "",
        }),
    });

    const roomParam = searchParams.get("room");
    useEffect(() => {
        if (roomParam && activeRoomId !== roomParam) {
            let savedHostToken: string | null = null;
            try {
                savedHostToken = sessionStorage.getItem(`infinite-canvas:collab_host_${roomParam}`);
            } catch {
                // ignore
            }
            const currentHostToken = useCollabStore.getState().hostToken || savedHostToken;
            startCollaboration(roomParam, currentHostToken ? "host" : "viewer", currentHostToken || undefined);
        }
    }, [roomParam, activeRoomId, startCollaboration]);

    const handleStartCollab = useCallback(
        (roomId: string) => {
            startCollaboration(roomId, "host");
            setSearchParams((prev) => {
                const next = new URLSearchParams(prev);
                next.set("room", roomId);
                return next;
            }, { replace: true });
            broadcastCanvasSync(nodesRef.current, connectionsRef.current, currentProject?.title);
        },
        [broadcastCanvasSync, currentProject?.title, setSearchParams, startCollaboration],
    );

    const handleStopCollab = useCallback(() => {
        useCollabStore.getState().disconnect();
        setSearchParams((prev) => {
            const next = new URLSearchParams(prev);
            next.delete("room");
            return next;
        }, { replace: true });
    }, [setSearchParams]);

    const createHistoryEntry = useCallback(
        (): CanvasHistoryEntry => ({
            nodes: nodesRef.current,
            connections: connectionsRef.current,
            chatSessions,
            activeChatId,
            backgroundMode,
            showImageInfo,
        }),
        [activeChatId, backgroundMode, chatSessions, showImageInfo],
    );

    const cleanupCanvasFiles = useCallback(
        (extra?: unknown) => {
            cleanupAssetImages({ extra, history: historyRef.current, lastHistory: lastHistoryRef.current });
        },
        [cleanupAssetImages],
    );

    const startGenerationRequest = useCallback((targetNodeId: string, originNodeId: string, runningId = originNodeId, controller = new AbortController()) => {
        const previous = generationRequestsRef.current.get(targetNodeId);
        if (previous?.controller !== controller) previous?.controller.abort();
        generationRequestsRef.current.set(targetNodeId, { targetNodeId, originNodeId, runningNodeId: runningId, controller });
        setRunningNodeIds((current) => {
            const next = new Set(current);
            next.add(runningId);
            if (targetNodeId) next.add(targetNodeId);
            if (previous && previous.runningNodeId !== runningId && previous.runningNodeId !== targetNodeId && ![...generationRequestsRef.current.values()].some((request) => request.runningNodeId === previous.runningNodeId || request.targetNodeId === previous.runningNodeId)) {
                next.delete(previous.runningNodeId);
            }
            return next;
        });
        return controller;
    }, []);

    const finishGenerationRequest = useCallback((targetNodeId: string, controller: AbortController) => {
        const request = generationRequestsRef.current.get(targetNodeId);
        if (request?.controller !== controller) return;
        generationRequestsRef.current.delete(targetNodeId);
        setRunningNodeIds((current) => {
            const next = new Set(current);
            next.delete(targetNodeId);
            const remaining = [...generationRequestsRef.current.values()];
            if (!remaining.some((item) => item.runningNodeId === request.runningNodeId || item.targetNodeId === request.runningNodeId)) {
                next.delete(request.runningNodeId);
            }
            if (!remaining.some((item) => item.originNodeId === request.originNodeId || item.targetNodeId === request.originNodeId)) {
                next.delete(request.originNodeId);
            }
            return next;
        });
    }, []);

    const stopGenerationByRunningId = useCallback((runningId: string) => {
        const affectedNodeIds = new Set<string>();
        generationRequestsRef.current.forEach((request) => {
            if (request.runningNodeId !== runningId && request.targetNodeId !== runningId && request.originNodeId !== runningId) return;
            request.controller.abort();
            generationRequestsRef.current.delete(request.targetNodeId);
            affectedNodeIds.add(request.targetNodeId);
            affectedNodeIds.add(request.originNodeId);
            affectedNodeIds.add(request.runningNodeId);
        });
        setRunningNodeIds((current) => {
            const next = new Set(current);
            affectedNodeIds.forEach((id) => next.delete(id));
            next.delete(runningId);
            return next;
        });
        if (!affectedNodeIds.size) return;
        setNodes((prev) =>
            prev.map((node) => {
                if (!affectedNodeIds.has(node.id)) return node;
                const completedImages = node.metadata?.images?.filter((img) => Boolean(img.content)) || [];
                const completedTexts = node.metadata?.texts?.filter((txt) => Boolean(txt.content)) || [];
                const hasSuccess = completedImages.length > 0 || completedTexts.length > 0 || Boolean(node.metadata?.content);
                const primaryImage = completedImages.find((img) => img.id === node.metadata?.primaryImageId) || completedImages[0];
                const primaryText = completedTexts.find((txt) => txt.id === node.metadata?.primaryTextId) || completedTexts[0];
                return {
                    ...node,
                    metadata: {
                        ...node.metadata,
                        status: hasSuccess ? NODE_STATUS_SUCCESS : NODE_STATUS_IDLE,
                        errorDetails: undefined,
                        jobId: undefined,
                        isTimeout: undefined,
                        ...(hasSuccess && primaryImage && !node.metadata?.content
                            ? {
                                  content: primaryImage.content,
                                  storageKey: primaryImage.storageKey,
                                  primaryImageId: primaryImage.id,
                                  naturalWidth: primaryImage.naturalWidth,
                                  naturalHeight: primaryImage.naturalHeight,
                                  bytes: primaryImage.bytes,
                                  mimeType: primaryImage.mimeType,
                              }
                            : {}),
                        ...(hasSuccess && primaryText && !node.metadata?.content
                            ? {
                                  content: primaryText.content,
                                  primaryTextId: primaryText.id,
                              }
                            : {}),
                        images: completedImages.length > 0
                            ? node.metadata?.images?.map((image) =>
                                  image.status === NODE_STATUS_LOADING
                                      ? { ...image, status: NODE_STATUS_IDLE, errorDetails: undefined, jobId: undefined, isTimeout: undefined }
                                      : image,
                              )
                            : undefined,
                        texts: completedTexts.length > 0
                            ? node.metadata?.texts?.map((text) =>
                                  text.status === NODE_STATUS_LOADING
                                      ? { ...text, status: NODE_STATUS_IDLE, errorDetails: undefined, jobId: undefined, isTimeout: undefined }
                                      : text,
                              )
                            : undefined,
                    },
                };
            }),
        );
    }, []);

    const confirmStopGeneration = useCallback(
        (nodeId: string) => {
            modal.confirm({
                title: t("canvas.projectPage.stopTitle"),
                content: t("canvas.projectPage.stopDescription"),
                okText: t("canvas.projectPage.stop"),
                cancelText: t("canvas.projectPage.continue"),
                okButtonProps: { danger: true },
                onOk: () => stopGenerationByRunningId(nodeId),
            });
        },
        [modal, stopGenerationByRunningId, t],
    );

    useEffect(() => {
        if (!hydrated) return;
        setProjectLoaded(false);
        let project = openProject(projectId);
        if (!project) {
            if (searchParams.get("room")) {
                const now = new Date().toISOString();
                const placeholder: CanvasProject = {
                    id: projectId,
                    title: t("canvas.projectPage.collabCanvas", "协同画布"),
                    createdAt: now,
                    updatedAt: now,
                    nodes: [],
                    connections: [],
                    chatSessions: [],
                    activeChatId: null,
                    backgroundMode: "lines",
                    showImageInfo: false,
                    viewport: { x: 0, y: 0, k: 1 },
                };
                useCanvasStore.setState((s) => ({
                    projects: [placeholder, ...s.projects],
                }));
                project = placeholder;
            } else {
                navigate("/canvas", { replace: true });
                return;
            }
        }

        const restore = async () => {
            const restoredNodes = await hydrateCanvasImages(resetInterruptedGeneration(project.nodes));
            const restoredSessions = await hydrateAssistantImages(project.chatSessions || []);
            setNodes(restoredNodes);
            setConnections(project.connections);
            setChatSessions(restoredSessions);
            setActiveChatId(project.activeChatId || null);
            setBackgroundMode(project.backgroundMode);
            setShowImageInfo(project.showImageInfo || false);
            setViewport(project.viewport);
            historyRef.current = { past: [], future: [] };
            if (historyCommitTimerRef.current) {
                clearTimeout(historyCommitTimerRef.current);
                historyCommitTimerRef.current = null;
            }
            lastHistoryRef.current = {
                nodes: restoredNodes,
                connections: project.connections,
                chatSessions: restoredSessions,
                activeChatId: project.activeChatId || null,
                backgroundMode: project.backgroundMode,
                showImageInfo: project.showImageInfo || false,
            };
            setHistoryState({ canUndo: false, canRedo: false });
            setInterruptedBannerDismissed(false);
            setProjectLoaded(true);
        };
        void restore();
    }, [hydrated, navigate, openProject, projectId]);

    useEffect(() => {
        if (!projectLoaded || !["new", "recent", "choose"].includes(searchParams.get("mode") || "")) return;
        if (!searchParams.has("agentUrl") && !localAgentEnabled && !fragmentBootstrap) openAgentPanel();
    }, [fragmentBootstrap, localAgentEnabled, openAgentPanel, projectLoaded, searchParams]);

    useEffect(() => {
        if (!projectLoaded || applyingHistoryRef.current || historyPausedRef.current) return;
        const next = createHistoryEntry();
        const previous = lastHistoryRef.current;
        if (
            previous?.nodes === next.nodes &&
            previous.connections === next.connections &&
            previous.chatSessions === next.chatSessions &&
            previous.activeChatId === next.activeChatId &&
            previous.backgroundMode === next.backgroundMode &&
            previous.showImageInfo === next.showImageInfo
        )
            return;

        if (historyCommitTimerRef.current) clearTimeout(historyCommitTimerRef.current);
        historyCommitTimerRef.current = setTimeout(() => {
            const current = createHistoryEntry();
            const last = lastHistoryRef.current;
            if (!last) return;
            historyRef.current.past = [...historyRef.current.past.slice(-49), last];
            historyRef.current.future = [];
            setHistoryState({ canUndo: true, canRedo: false });
            lastHistoryRef.current = current;
            historyCommitTimerRef.current = null;
        }, 180);

        return () => {
            if (historyCommitTimerRef.current) {
                clearTimeout(historyCommitTimerRef.current);
                historyCommitTimerRef.current = null;
            }
        };
    }, [activeChatId, backgroundMode, chatSessions, connections, createHistoryEntry, nodes, projectLoaded, showImageInfo]);

    useEffect(() => {
        if (!projectLoaded || historyPausedRef.current) return;
        updateProject(projectId, { nodes, connections, chatSessions, activeChatId, backgroundMode, showImageInfo });
        if (activeRoomId && collabRole === "host") {
            broadcastCanvasSync(nodes, connections, currentProject?.title);
        }
    }, [activeChatId, activeRoomId, backgroundMode, broadcastCanvasSync, chatSessions, collabRole, connections, currentProject?.title, nodes, projectId, projectLoaded, showImageInfo, updateProject]);

    useEffect(() => {
        if (!dialogNodeId) setNodeImageSettingsOpen(false);
    }, [dialogNodeId]);

    useEffect(() => {
        if (!projectLoaded) return;
        if (viewportSaveTimerRef.current) clearTimeout(viewportSaveTimerRef.current);
        viewportSaveTimerRef.current = setTimeout(() => {
            updateProject(projectId, { viewport: viewportRef.current });
            viewportSaveTimerRef.current = null;
        }, 500);
        return () => {
            if (viewportSaveTimerRef.current) clearTimeout(viewportSaveTimerRef.current);
        };
    }, [projectId, projectLoaded, updateProject, viewport]);

    useLayoutEffect(() => {
        nodesRef.current = nodes;
        connectionsRef.current = connections;
        selectedNodeIdsRef.current = selectedNodeIds;
        viewportRef.current = viewport;
        connectingParamsRef.current = connectingParams;
        connectionTargetNodeIdRef.current = connectionTargetNodeId;
        pendingConnectionCreateRef.current = pendingConnectionCreate;
    }, [nodes, connections, selectedNodeIds, viewport, connectingParams, connectionTargetNodeId, pendingConnectionCreate]);

    useLayoutEffect(() => {
        selectionBoxRef.current = selectionBox;
    }, [selectionBox]);

    useEffect(() => {
        const el = containerRef.current;
        if (!el) return;

        const updateSize = () => {
            const rect = el.getBoundingClientRect();
            setSize({ width: rect.width, height: rect.height });
            if (!didInitialCenterRef.current) {
                didInitialCenterRef.current = true;
                setViewport({ x: rect.width / 2, y: rect.height / 2, k: 1 });
            }
        };

        updateSize();
        const resizeObserver = new ResizeObserver(updateSize);
        resizeObserver.observe(el);
        return () => resizeObserver.disconnect();
    }, []);

    const screenToCanvas = useCallback((clientX: number, clientY: number) => {
        const rect = containerRef.current?.getBoundingClientRect();
        const currentViewport = viewportRef.current;
        const localX = clientX - (rect?.left || 0);
        const localY = clientY - (rect?.top || 0);

        return {
            x: (localX - currentViewport.x) / currentViewport.k,
            y: (localY - currentViewport.y) / currentViewport.k,
        };
    }, []);

    const getCanvasCenter = useCallback(() => {
        const rect = containerRef.current?.getBoundingClientRect();
        return screenToCanvas((rect?.left || 0) + (rect?.width || size.width) / 2, (rect?.top || 0) + (rect?.height || size.height) / 2);
    }, [screenToCanvas, size.height, size.width]);

    const setConnecting = useCallback((next: ConnectionHandle | null) => {
        if (isViewerRef.current && next) return;
        connectingParamsRef.current = next;
        setConnectingParams(next);
        if (!next) {
            connectionTargetNodeIdRef.current = null;
            setConnectionTargetNodeId(null);
        }
    }, []);

    const keepNodeToolbar = useCallback(
        (nodeId: string) => {
            if (nodeDraggingRef.current || nodeImageSettingsOpen || !selectedNodeIdsRef.current.has(nodeId)) return;
            setToolbarNodeId(nodeId);
        },
        [nodeImageSettingsOpen],
    );

    const hideNodeToolbar = useCallback(() => {}, []);

    const connectNodes = useCallback(
        (current: ConnectionHandle, targetNodeId: string) => {
            if (current.nodeId === targetNodeId) return;

            const selected = selectedNodeIdsRef.current;
            const isBatch = selected.has(current.nodeId) && selected.size > 1;
            const sourceIds = isBatch ? Array.from(selected) : [current.nodeId];

            const newConnections: CanvasConnection[] = [];
            let currentConnections = connectionsRef.current;

            for (const sourceId of sourceIds) {
                if (sourceId === targetNodeId) continue;
                const connection = normalizeConnection(sourceId, targetNodeId, nodesRef.current, current.handleType, currentConnections);
                if (connection) {
                    const newConn: CanvasConnection = {
                        id: nanoid(),
                        fromNodeId: connection.fromNodeId,
                        toNodeId: connection.toNodeId,
                        kind: "input",
                    };
                    newConnections.push(newConn);
                    currentConnections = [...currentConnections, newConn];
                }
            }

            if (newConnections.length > 0) {
                setConnections((prev) => [...prev, ...newConnections]);
            } else {
                message.warning(t("canvas.projectPage.configConnection"));
            }
            setContextMenu(null);
        },
        [message, t],
    );

    const createConnectedNode = useCallback(
        (type: CanvasNodeType.Image | CanvasNodeType.Text | CanvasNodeType.Config | CanvasNodeType.Video | CanvasNodeType.Audio, pending: PendingConnectionCreate) => {
            const metadata = type === CanvasNodeType.Config ? { model: effectiveConfig.imageModel || effectiveConfig.model, size: effectiveConfig.size, count: getGenerationCount(effectiveConfig.canvasImageCount || effectiveConfig.count) } : undefined;
            const newNode = createCanvasNode(type, pending.position, metadata);
            const allNodes = [...nodesRef.current, newNode];

            const sourceIds = pending.sourceNodeIds && pending.sourceNodeIds.length > 0 ? pending.sourceNodeIds : [pending.connection.nodeId];
            const newConnections: CanvasConnection[] = [];
            let currentConnections = connectionsRef.current;

            for (const sourceId of sourceIds) {
                const connection = normalizeConnection(sourceId, newNode.id, allNodes, pending.connection.handleType, currentConnections);
                if (connection) {
                    const newConn: CanvasConnection = { id: nanoid(), ...connection, kind: "input" };
                    newConnections.push(newConn);
                    currentConnections = [...currentConnections, newConn];
                }
            }

            if (newConnections.length === 0) {
                message.warning(t("canvas.projectPage.configConnection"));
                return;
            }

            setNodes((prev) => [...prev, newNode]);
            setConnections((prev) => [...prev, ...newConnections]);
            setSelectedNodeIds(new Set([newNode.id]));
            setSelectedConnectionId(null);
            if (type !== CanvasNodeType.Text) setDialogNodeId(newNode.id);
            setPendingConnectionCreate(null);
            setConnecting(null);
        },
        [effectiveConfig.canvasImageCount, effectiveConfig.count, effectiveConfig.imageModel, effectiveConfig.model, effectiveConfig.size, message, setConnecting, t],
    );

    const cancelPendingConnectionCreate = useCallback(() => {
        setPendingConnectionCreate(null);
        setConnecting(null);
    }, [setConnecting]);

    const getConnectionDropTarget = useCallback(
        (clientX: number, clientY: number, current: ConnectionHandle): ConnectionDropTarget => {
            const world = screenToCanvas(clientX, clientY);
            const scale = Math.max(viewportRef.current.k, 0.05);
            const padding = CONNECTION_NODE_HIT_PADDING / scale;
            const handleRadius = CONNECTION_HANDLE_HIT_RADIUS / scale;
            let isNearNode = false;
            let bestNodeId: string | null = null;
            let bestPriority = Number.POSITIVE_INFINITY;
            const selected = selectedNodeIdsRef.current;
            const isBatch = selected.has(current.nodeId) && selected.size > 1;
            const candidateSourceIds = isBatch ? Array.from(selected) : [current.nodeId];

            [...nodesRef.current]
                .reverse()
                .forEach((node) => {
                    const anchor = getConnectionTargetAnchor(node, current);
                    const dx = world.x - anchor.x;
                    const dy = world.y - anchor.y;
                    const hitsHandle = dx * dx + dy * dy <= handleRadius * handleRadius;
                    const hitsInside = world.x >= node.position.x && world.x <= node.position.x + node.width && world.y >= node.position.y && world.y <= node.position.y + node.height;
                    const hitsExpanded = world.x >= node.position.x - padding && world.x <= node.position.x + node.width + padding && world.y >= node.position.y - padding && world.y <= node.position.y + node.height + padding;

                    if (!hitsHandle && !hitsInside && !hitsExpanded) return;
                    isNearNode = true;
                    const canConnect = candidateSourceIds.some(
                        (sourceId) => sourceId !== node.id && normalizeConnection(sourceId, node.id, nodesRef.current, current.handleType, connectionsRef.current),
                    );
                    if (!canConnect) return;

                    const priority = hitsInside ? 0 : hitsHandle ? 1 : 2;
                    if (priority < bestPriority) {
                        bestNodeId = node.id;
                        bestPriority = priority;
                    }
                });

            return { nodeId: bestNodeId, isNearNode };
        },
        [screenToCanvas],
    );

    // 折叠分组会把后代节点整棵藏起来；锁定则沿 groupId 向上传染。两者都在渲染与交互处统一走这两个集合。
    const collapsedNodeIds = useMemo(() => collectCollapsedNodeIds(nodes), [nodes]);
    // 折叠分组自己还留着标题栏，但它与外界之间的连线也要一起隐藏，否则会指向看不见的节点。
    const collapsedEndpointIds = useMemo(() => {
        const ids = new Set(collapsedNodeIds);
        for (const node of nodes) {
            if (node.metadata?.collapsed) ids.add(node.id);
        }
        return ids;
    }, [collapsedNodeIds, nodes]);
    const lockedNodeIds = useMemo(() => new Set(nodes.filter((node) => isNodeLocked(node, nodes)).map((node) => node.id)), [nodes]);

    useEffect(() => {
        collapsedNodeIdsRef.current = collapsedNodeIds;
        lockedNodeIdsRef.current = lockedNodeIds;
    }, [collapsedNodeIds, lockedNodeIds]);

    const visibleNodes = useMemo(() => {
        const padding = 280;
        const rect = containerRef.current?.getBoundingClientRect();
        const width = rect?.width || size.width;
        const height = rect?.height || size.height;
        const viewLeft = -viewport.x / viewport.k - padding;
        const viewTop = -viewport.y / viewport.k - padding;
        const viewRight = viewLeft + width / viewport.k + padding * 2;
        const viewBottom = viewTop + height / viewport.k + padding * 2;

        return nodes.filter((node) => !collapsedNodeIds.has(node.id) && node.position.x + node.width > viewLeft && node.position.x < viewRight && node.position.y + node.height > viewTop && node.position.y < viewBottom);
    }, [collapsedNodeIds, nodes, size.height, size.width, viewport.k, viewport.x, viewport.y]);

    const nodeById = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
    // The toolbar follows a single selected node selected by click, creation, marquee, or keyboard.
    // It stays hidden for multi-selection and while isNodeDragging is true.
    const singleSelectedNodeId = selectedNodeIds.size === 1 ? Array.from(selectedNodeIds)[0] : null;
    const toolbarNode = (toolbarNodeId ? nodeById.get(toolbarNodeId) || null : null) || (singleSelectedNodeId ? nodeById.get(singleSelectedNodeId) || null : null);
    const infoNode = infoNodeId ? nodeById.get(infoNodeId) || null : null;
    const cropNode = cropNodeId ? nodeById.get(cropNodeId) || null : null;
    const maskEditNode = maskEditNodeId ? nodeById.get(maskEditNodeId) || null : null;
    const splitNode = splitNodeId ? nodeById.get(splitNodeId) || null : null;
    const upscaleNode = upscaleNodeId ? nodeById.get(upscaleNodeId) || null : null;
    const contextMenuNode = contextMenu?.type === "node" ? nodeById.get(contextMenu.nodeId) || null : null;
    const previewNode = previewNodeId ? nodeById.get(previewNodeId) || null : null;
    const previewContent = previewImageId ? previewNode?.metadata?.images?.find((image) => image.id === previewImageId)?.content : previewNode?.metadata?.content;
    const hasMultipleSelectedNodes = selectedNodeIds.size > 1;
    const activeNodeId = hasMultipleSelectedNodes ? null : hoveredNodeId || (selectedNodeIds.size === 1 ? Array.from(selectedNodeIds)[0] : null);
    // 每个分组一份聚合摘要，直接画在分组节点上：折叠后不必展开也能知道里面有什么、还在不在跑。
    const groupSummaryById = useMemo(() => {
        const byId = new Map(nodes.map((node) => [node.id, node]));
        const map = new Map<string, CanvasGroupSummary>();
        nodes.forEach((node) => {
            if (node.type !== CanvasNodeType.Group) return;
            const kinds: CanvasGroupSummary["kinds"] = { image: 0, video: 0, audio: 0, text: 0, other: 0 };
            const members: CanvasGroupSummary["previews"] = [];
            let running = 0;
            let failed = 0;
            for (const id of collectGroupDescendantIds(node.id, nodes)) {
                const member = byId.get(id);
                if (!member) continue;
                const kind = groupMemberKind(member);
                kinds[kind] += 1;
                if (member.metadata?.status === "loading") running += 1;
                else if (member.metadata?.status === "error") failed += 1;
                members.push({ id, kind, src: groupPreviewSource(member) });
            }
            if (!members.length) return;
            // 图片排前面，这样只要组里有图，预览条就一定显示真图。
            members.sort((a, b) => GROUP_KIND_ORDER[a.kind] - GROUP_KIND_ORDER[b.kind]);
            map.set(node.id, { count: members.length, kinds, previews: members.slice(0, 4), running, failed });
        });
        return map;
    }, [nodes]);
    const groupChildCountById = useMemo(() => {
        const map = new Map<string, number>();
        nodes.forEach((node) => {
            const groupId = node.metadata?.groupId;
            if (groupId) map.set(groupId, (map.get(groupId) || 0) + 1);
        });
        return map;
    }, [nodes]);
    const relatedHighlight = useMemo(() => {
        const nodeIds = new Set<string>();
        const connectionIds = new Set<string>();

        if (!activeNodeId) return { nodeIds, connectionIds };

        const addNode = (nodeId: string) => {
            nodeIds.add(nodeId);
            if (nodeById.get(nodeId)?.type === CanvasNodeType.Group) nodes.forEach((node) => node.metadata?.groupId === nodeId && nodeIds.add(node.id));
        };
        addNode(activeNodeId);
        connections.forEach((connection) => {
            if (connection.fromNodeId !== activeNodeId && connection.toNodeId !== activeNodeId) return;
            connectionIds.add(connection.id);
            addNode(connection.fromNodeId);
            addNode(connection.toNodeId);
        });

        return { nodeIds, connectionIds };
    }, [activeNodeId, connections, nodeById, nodes]);

    const configInputsById = useMemo(() => {
        const map = new Map<string, NodeGenerationInput[]>();
        nodes.forEach((node) => {
            if (node.type !== CanvasNodeType.Config) return;
            map.set(node.id, buildNodeGenerationInputs(node.id, nodes, connections));
        });
        return map;
    }, [connections, nodes]);
    const mentionReferencesByNodeId = useMemo(() => {
        const map = new Map<string, ReturnType<typeof buildNodeMentionReferences>>();
        nodes.forEach((node) => map.set(node.id, buildNodeMentionReferences(node, nodes, connections)));
        return map;
    }, [connections, nodes]);
    const connectedNodesByNodeId = useMemo(() => {
        const map = new Map<string, CanvasNodeData[]>();
        connections.filter((connection) => connection.kind === "input").forEach((connection) => {
            const source = nodeById.get(connection.fromNodeId);
            if (!source) return;
            const connected = map.get(connection.toNodeId);
            if (connected) connected.push(source);
            else map.set(connection.toNodeId, [source]);
        });
        return map;
    }, [connections, nodeById]);
    const referenceConnectedNodeIds = useMemo(() => new Set([referencePickerNodeId, ...(referencePickerNodeId ? connectedNodesByNodeId.get(referencePickerNodeId)?.flatMap((node) => node.type === CanvasNodeType.Group ? [node.id, ...getGroupResourceNodes(node.id, nodes).map((child) => child.id)] : [node.id]) || [] : [])].filter((id): id is string => Boolean(id))), [connectedNodesByNodeId, nodes, referencePickerNodeId]);
    const { applyAgentOps } = useAgentBridge({
        projectId,
        title: currentProject?.title,
        nodes,
        connections,
        selectedNodeIds,
        viewport,
        nodesRef,
        connectionsRef,
        selectedNodeIdsRef,
        viewportRef,
        generateNodeRef,
        setNodes,
        setConnections,
        setSelectedNodeIds,
        setSelectedConnectionId,
        setViewport,
        setContextMenu,
    });

    const { pluginHost, renderPluginPanel, buildNodeToolbarItems } = usePluginHost({
        effectiveConfig,
        isAiConfigReady,
        openConfigDialog,
        theme,
        nodesRef,
        connectionsRef,
        viewportRef,
        setNodes,
        setDialogNodeId,
        applyAgentOps,
    });
    const createNode = useCallback(
        (type: CanvasNodeTypeId, position?: Position) => {
            const targetPosition = position || getCanvasCenter();
            const configMetadata =
                type === CanvasNodeType.Config
                    ? {
                          model: effectiveConfig.imageModel || effectiveConfig.model,
                          size: effectiveConfig.size,
                          count: getGenerationCount(effectiveConfig.canvasImageCount || effectiveConfig.count),
                      }
                    : undefined;
            const newNode = createCanvasNode(type, targetPosition, configMetadata);

            setNodes((prev) => {
                if (type === CanvasNodeType.Group) {
                    return prev.map((node) => {
                        if (node.type === CanvasNodeType.Group) return node;
                        if (isNodeEnclosedInGroup(node, newNode)) {
                            return { ...node, metadata: { ...node.metadata, groupId: newNode.id } };
                        }
                        return node;
                    }).concat(newNode);
                }
                return [...prev, newNode];
            });
            setSelectedNodeIds(new Set([newNode.id]));
            setSelectedConnectionId(null);
            const definition = getNodeDefinition(type);
            // Display-only plugin nodes with hidePanel do not open a panel; custom Panels require autoOpenPanel on creation.
            // Plugin nodes declaring useBuiltinPanel open the built-in generation panel on creation, like image nodes.
            // Built-in image, video, and config nodes retain their existing open-on-create behavior.
            const wantsPanel = definition?.hidePanel
                ? false
                : definition?.Panel
                  ? Boolean(definition.autoOpenPanel)
                  : definition?.useBuiltinPanel
                    ? true
                    : isBuiltinType(type) && type !== CanvasNodeType.Text && type !== CanvasNodeType.Group;
            if (wantsPanel) setDialogNodeId(newNode.id);
        },
        [effectiveConfig.canvasImageCount, effectiveConfig.count, effectiveConfig.imageModel, effectiveConfig.model, effectiveConfig.size, getCanvasCenter],
    );

    const groupSelectedNodes = useCallback(() => {
        const currentNodes = nodesRef.current;
        const selectedIds = selectedNodeIdsRef.current;
        const selected = currentNodes.filter((n) => selectedIds.has(n.id));

        if (selected.length > 0) {
            const selectedNonGroup = selected.filter((n) => n.type !== CanvasNodeType.Group);
            const targetNodes = selectedNonGroup.length > 0 ? selectedNonGroup : selected;
            const targetIds = new Set(targetNodes.map((n) => n.id));

            const bounds = calculateGroupBoundsForNodes(targetNodes);
            const newGroup = createCanvasNode(CanvasNodeType.Group, { x: 0, y: 0 });
            newGroup.position = { x: bounds.x, y: bounds.y };
            newGroup.width = bounds.width;
            newGroup.height = bounds.height;

            setNodes((prev) => {
                const nextNodes = prev.map((node) => {
                    if (targetIds.has(node.id)) {
                        return { ...node, metadata: { ...node.metadata, groupId: newGroup.id } };
                    }
                    return node;
                });
                return [...nextNodes, newGroup];
            });
            setSelectedNodeIds(new Set([newGroup.id]));
            setSelectedConnectionId(null);
            message.success(t("canvas.node.groupedSuccess", { count: targetNodes.length }));
            return newGroup.id;
        }

        const center = getCanvasCenter();
        const newGroup = createCanvasNode(CanvasNodeType.Group, center);

        setNodes((prev) => {
            let captured = 0;
            const nextNodes = prev.map((node) => {
                if (node.type === CanvasNodeType.Group) return node;
                if (isNodeEnclosedInGroup(node, newGroup)) {
                    captured++;
                    return { ...node, metadata: { ...node.metadata, groupId: newGroup.id } };
                }
                return node;
            });
            if (captured > 0) {
                message.success(t("canvas.node.capturedNodesSuccess", { count: captured }));
            }
            return [...nextNodes, newGroup];
        });
        setSelectedNodeIds(new Set([newGroup.id]));
        setSelectedConnectionId(null);
        return newGroup.id;
    }, [getCanvasCenter, message, t]);

    const ungroupSelected = useCallback(
        (targetGroupId?: string) => {
            const currentNodes = nodesRef.current;
            const selectedIds = selectedNodeIdsRef.current;
            const targetIds = targetGroupId
                ? [targetGroupId]
                : currentNodes.filter((n) => selectedIds.has(n.id) && n.type === CanvasNodeType.Group).map((n) => n.id);

            if (!targetIds.length) return;

            setNodes((prev) => {
                let next = prev;
                for (const gid of targetIds) {
                    next = ungroupCanvasGroup(gid, next);
                }
                return next;
            });
            setSelectedNodeIds(new Set());
            message.success(t("canvas.node.ungroupedSuccess"));
        },
        [message, t],
    );

    const handleCaptureGroupNodes = useCallback(
        (groupId: string) => {
            setNodes((prev) => {
                const { nextNodes, capturedCount } = captureEnclosedNodesIntoGroup(groupId, prev);
                if (capturedCount > 0) {
                    message.success(t("canvas.node.capturedNodesSuccess", { count: capturedCount }));
                } else {
                    message.info(t("canvas.node.noNewNodesCaptured"));
                }
                return nextNodes;
            });
        },
        [message, t],
    );

    const handleFitGroup = useCallback(
        (groupId: string) => {
            setNodes((prev) => fitGroupToEnclosedChildren(groupId, prev));
            message.success(t("canvas.node.fitGroupSuccess"));
        },
        [message, t],
    );

    // 折叠/锁定都只是 metadata 开关，因此自动走历史栈、并随项目一起持久化。
    const applyGroupCollapsed = useCallback((groupIds: string[], collapsed: boolean) => {
        const ids = new Set(groupIds);
        setNodes((prev) => prev.map((node) => (ids.has(node.id) && node.type === CanvasNodeType.Group ? { ...node, metadata: { ...node.metadata, collapsed } } : node)));
        if (!collapsed) return;
        // 折叠会把子树上所有节点藏起来，指向它们的选中/悬停/弹窗都要先放开，否则会留下操作不到的空引用。
        const hidden = new Set<string>();
        for (const groupId of groupIds) {
            for (const id of collectGroupDescendantIds(groupId, nodesRef.current)) hidden.add(id);
        }
        setSelectedNodeIds((current) => {
            const next = new Set([...current].filter((id) => !hidden.has(id)));
            return next.size === current.size ? current : next;
        });
        setHoveredNodeId((current) => (current && hidden.has(current) ? null : current));
        setToolbarNodeId((current) => (current && hidden.has(current) ? null : current));
        setDialogNodeId((current) => (current && hidden.has(current) ? null : current));
    }, []);

    const toggleGroupCollapse = useCallback(
        (groupId: string) => {
            const group = nodesRef.current.find((node) => node.id === groupId);
            applyGroupCollapsed([groupId], !group?.metadata?.collapsed);
        },
        [applyGroupCollapsed],
    );

    const toggleGroupLock = useCallback((groupId: string) => {
        setNodes((prev) => prev.map((node) => (node.id === groupId && node.type === CanvasNodeType.Group ? { ...node, metadata: { ...node.metadata, locked: !node.metadata?.locked } } : node)));
    }, []);

    const handleSelectGroupChildren = useCallback(
        (groupId: string) => {
            const childIds = nodesRef.current.filter((n) => n.metadata?.groupId === groupId).map((n) => n.id);
            if (childIds.length) {
                setSelectedNodeIds(new Set(childIds));
                setSelectedConnectionId(null);
            } else {
                message.info(t("canvas.node.noGroupChildren"));
            }
        },
        [message, t],
    );

    const deleteNodes = useCallback(
        (ids: Set<string>) => {
            if (isViewerRef.current) return;
            if (!ids.size) return;
            // 锁定节点（自身锁定，或位于锁定分组内）不允许删除。
            const protectedIds = new Set(nodesRef.current.filter((node) => isNodeLocked(node, nodesRef.current)).map((node) => node.id));
            const allIds = new Set([...ids].filter((id) => !protectedIds.has(id)));
            if (!allIds.size) return;
            setNodes((prev) => {
                const next = prev.filter((node) => !allIds.has(node.id));
                return next.map((node) => {
                    const groupId = node.metadata?.groupId;
                    if (groupId && allIds.has(groupId)) return { ...node, metadata: { ...node.metadata, groupId: undefined } };
                    return node;
                });
            });
            setConnections((prev) => prev.filter((conn) => !allIds.has(conn.fromNodeId) && !allIds.has(conn.toNodeId)));
            setSelectedNodeIds(new Set());
            setSelectedConnectionId(null);
            setHoveredNodeId((current) => (current && allIds.has(current) ? null : current));
            setToolbarNodeId((current) => (current && allIds.has(current) ? null : current));
            setDialogNodeId((current) => (current && allIds.has(current) ? null : current));
            setInfoNodeId((current) => (current && allIds.has(current) ? null : current));
            setCropNodeId((current) => (current && allIds.has(current) ? null : current));
            setMaskEditNodeId((current) => (current && allIds.has(current) ? null : current));
            setAngleNodeId((current) => (current && allIds.has(current) ? null : current));
            setPreviewNodeId((current) => (current && allIds.has(current) ? null : current));
            setRunningNodeIds((current) => {
                const next = new Set(current);
                let changed = false;
                allIds.forEach((id) => {
                    if (next.delete(id)) changed = true;
                });
                return changed ? next : current;
            });
            setReferencePickerNodeId((current) => (current && allIds.has(current) ? null : current));
            setExpandedBatchNodeIds((current) => new Set([...current].filter((nodeId) => !allIds.has(nodeId))));
            setContextMenu((current) => (current?.type === "node" && allIds.has(current.nodeId) ? null : current));
            cleanupCanvasFiles({ projectId, nodes: nodesRef.current.filter((node) => !allIds.has(node.id)), chatSessions });
        },
        [chatSessions, cleanupCanvasFiles, projectId],
    );

    const confirmDeleteNodes = useCallback((ids: Set<string>) => {
        if (isViewerRef.current || !ids.size) return;
        setDeleteConfirmNodes(new Set(ids));
    }, []);

    const handleConfirmDeleteNodes = useCallback(() => {
        const ids = deleteConfirmNodes;
        setDeleteConfirmNodes(null);
        if (ids && ids.size) {
            deleteNodes(ids);
        }
    }, [deleteConfirmNodes, deleteNodes]);

    const deleteConnection = useCallback((connectionId: string) => {
        if (isViewerRef.current) return;
        setConnections((prev) => prev.filter((conn) => conn.id !== connectionId));
        setSelectedConnectionId((current) => (current === connectionId ? null : current));
        setContextMenu((current) => (current?.type === "connection" && current.connectionId === connectionId ? null : current));
    }, []);

    const disconnectNodeReference = useCallback((fromNodeId: string, toNodeId: string) => {
        if (isViewerRef.current) return;
        setConnections((prev) => prev.filter((connection) => connection.fromNodeId !== fromNodeId || connection.toNodeId !== toNodeId));
    }, []);

    const reorderNodeReferences = useCallback((toNodeId: string, orderedSourceNodeIds: string[]) => {
        if (isViewerRef.current) return;
        setConnections((prev) => {
            const isTargetInput = (c: CanvasConnection) => c.toNodeId === toNodeId && (c.kind === "input" || !c.kind);
            const targetConns = prev.filter(isTargetInput);
            if (targetConns.length <= 1) return prev;

            const connByFromId = new Map(targetConns.map((c) => [c.fromNodeId, c]));
            const reordered: CanvasConnection[] = [];
            for (const fromId of orderedSourceNodeIds) {
                const conn = connByFromId.get(fromId);
                if (conn) {
                    reordered.push(conn);
                    connByFromId.delete(fromId);
                }
            }
            for (const conn of connByFromId.values()) {
                reordered.push(conn);
            }

            const hasChanged = targetConns.some((c, i) => c.id !== reordered[i]?.id);
            if (!hasChanged) return prev;

            let reorderIndex = 0;
            return prev.map((conn) => {
                if (isTargetInput(conn)) {
                    const nextConn = reordered[reorderIndex++];
                    return nextConn ?? conn;
                }
                return conn;
            });
        });
    }, []);

    const startNodeReferenceSelection = useCallback((nodeId: string) => {
        setReferencePickerNodeId(nodeId);
        setSelectedNodeIds(new Set([nodeId]));
        setSelectedConnectionId(null);
        setDialogNodeId(null);
    }, []);

    const exitNodeReferenceSelection = useCallback(() => {
        if (!referencePickerNodeId) return;
        setSelectedNodeIds(new Set([referencePickerNodeId]));
        setDialogNodeId(referencePickerNodeId);
        setReferencePickerNodeId(null);
    }, [referencePickerNodeId]);

    const selectNodeReference = useCallback((fromNodeId: string) => {
        if (!referencePickerNodeId || referenceConnectedNodeIds.has(fromNodeId)) return;
        const source = nodesRef.current.find((node) => node.id === fromNodeId);
        if (!source || !isCanvasReferenceNode(source, nodesRef.current)) return;
        setConnections((prev) => [...prev, { id: nanoid(), fromNodeId, toNodeId: referencePickerNodeId, kind: "input" }]);
    }, [referenceConnectedNodeIds, referencePickerNodeId]);

    useEffect(() => {
        if (!referencePickerNodeId) return;
        const exit = (event: KeyboardEvent) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            event.stopImmediatePropagation();
            exitNodeReferenceSelection();
        };
        window.addEventListener("keydown", exit, true);
        return () => window.removeEventListener("keydown", exit, true);
    }, [exitNodeReferenceSelection, referencePickerNodeId]);

    const deselectCanvas = useCallback(() => {
        cancelPendingConnectionCreate();
        setSelectedNodeIds(new Set());
        setSelectedConnectionId(null);
        setContextMenu(null);
        setSelectionBox(null);
        setHoveredNodeId(null);
        setToolbarNodeId(null);
        setDialogNodeId(null);
    }, [cancelPendingConnectionCreate]);

    const clearCanvas = useCallback(() => {
        setNodes([]);
        setConnections([]);
        setInfoNodeId(null);
        setCropNodeId(null);
        setMaskEditNodeId(null);
        setAngleNodeId(null);
        setPreviewNodeId(null);
        setRunningNodeIds(new Set());
        deselectCanvas();
        setClearConfirmOpen(false);
        cleanupCanvasFiles({ projectId, nodes: [], chatSessions: [] });
    }, [cleanupCanvasFiles, deselectCanvas, projectId]);

    const duplicateNode = useCallback((nodeId: string) => {
        const source = nodesRef.current.find((node) => node.id === nodeId);
        if (!source) return;

        const id = `${source.type}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        const clonedMetadata = cloneNodeMetadata(source.metadata, source.type);

        // 如果是 Group 组节点，级联复制组及其包含的所有子节点与内部连线
        if (source.type === CanvasNodeType.Group) {
            const childNodes = nodesRef.current.filter((node) => node.metadata?.groupId === source.id);
            const idMap = new Map<string, string>();
            idMap.set(source.id, id);

            const groupNext: CanvasNodeData = {
                ...source,
                id,
                title: source.title.endsWith(" Copy") ? source.title : `${source.title} Copy`,
                position: { x: source.position.x + 36, y: source.position.y + 36 },
                metadata: clonedMetadata,
            };

            const childNextNodes: CanvasNodeData[] = childNodes.map((child, index) => {
                const childId = `${child.type}-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 7)}`;
                idMap.set(child.id, childId);
                const childMetadata = cloneNodeMetadata(child.metadata, child.type);
                if (childMetadata) childMetadata.groupId = id;
                return {
                    ...child,
                    id: childId,
                    title: child.title.endsWith(" Copy") ? child.title : `${child.title} Copy`,
                    position: { x: child.position.x + 36, y: child.position.y + 36 },
                    metadata: childMetadata,
                };
            });

            const allGroupNodeIds = new Set([source.id, ...childNodes.map((c) => c.id)]);
            const groupConnections = connectionsRef.current.filter((c) => allGroupNodeIds.has(c.toNodeId));
            const nextConnections = buildPastedNodeConnections(groupConnections, idMap, nodesRef.current);

            setNodes((prev) => [...prev, groupNext, ...childNextNodes]);
            if (nextConnections.length) {
                connectionsRef.current = [...connectionsRef.current, ...nextConnections];
                setConnections((prev) => [...prev, ...nextConnections]);
            }
            setSelectedNodeIds(new Set([id, ...childNextNodes.map((c) => c.id)]));
            setSelectedConnectionId(null);
            return;
        }

        const next: CanvasNodeData = {
            ...source,
            id,
            title: source.title.endsWith(" Copy") ? source.title : `${source.title} Copy`,
            position: { x: source.position.x + 36, y: source.position.y + 36 },
            metadata: clonedMetadata,
        };

        // 如果原节点属于某个组，检查新位置是否仍落在组内；若偏移后脱离了组范围，则清除 groupId
        if (next.metadata?.groupId) {
            const containingGroupId = findContainingGroupId(next, nodesRef.current);
            next.metadata.groupId = containingGroupId;
        }

        const parentConnections = duplicateIncomingConnections(source.id, id, connectionsRef.current, nodesRef.current);

        setNodes((prev) => [...prev, next]);
        if (parentConnections.length) {
            connectionsRef.current = [...connectionsRef.current, ...parentConnections];
            setConnections((prev) => [...prev, ...parentConnections]);
        }
        setSelectedNodeIds(new Set([id]));
        setSelectedConnectionId(null);
        if (next.type !== CanvasNodeType.Group) setDialogNodeId(id);
    }, []);

    const copySelectedNodes = useCallback(() => {
        const selectedIds = new Set(selectedNodeIdsRef.current);
        if (!selectedIds.size) return;

        // 选中组节点时，自动连带包含其组内所有子节点
        nodesRef.current.forEach((node) => {
            if (node.type === CanvasNodeType.Group && selectedIds.has(node.id)) {
                nodesRef.current.forEach((child) => {
                    if (child.metadata?.groupId === node.id) selectedIds.add(child.id);
                });
            }
        });

        const copiedNodes = nodesRef.current
            .filter((node) => selectedIds.has(node.id))
            .map((node) => ({
                ...node,
                position: { ...node.position },
                metadata: node.metadata ? structuredClone(node.metadata) : undefined,
            }));

        if (!copiedNodes.length) return;

        clipboardRef.current = {
            nodes: copiedNodes,
            connections: connectionsRef.current
                .filter((connection) => selectedIds.has(connection.toNodeId))
                .map((connection) => ({ ...connection })),
        };
    }, []);

    const pasteCopiedNodes = useCallback(() => {
        const clipboard = clipboardRef.current;
        if (!clipboard?.nodes.length) return false;

        const center = getCanvasCenter();
        const bounds = clipboard.nodes.reduce(
            (acc, node) => ({
                left: Math.min(acc.left, node.position.x),
                top: Math.min(acc.top, node.position.y),
                right: Math.max(acc.right, node.position.x + node.width),
                bottom: Math.max(acc.bottom, node.position.y + node.height),
            }),
            { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity },
        );
        const dx = center.x - (bounds.left + bounds.right) / 2;
        const dy = center.y - (bounds.top + bounds.bottom) / 2;
        const idMap = new Map<string, string>();
        const nextNodes = clipboard.nodes.map((node, index) => {
            const id = `${node.type}-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 7)}`;
            idMap.set(node.id, id);
            return {
                ...node,
                id,
                title: node.title.endsWith(" Copy") ? node.title : `${node.title} Copy`,
                position: {
                    x: node.position.x + dx,
                    y: node.position.y + dy,
                },
                metadata: cloneNodeMetadata(node.metadata, node.type),
            };
        });

        const pastedNodes = nextNodes.map((node) => {
            const oldGroupId = node.metadata?.groupId;
            if (!oldGroupId) return node;
            const mappedGroupId = idMap.get(oldGroupId);
            if (mappedGroupId) {
                return { ...node, metadata: { ...node.metadata, groupId: mappedGroupId } };
            }
            // 若原分组未连带复制，检查新位置是否落在画布上某个既有组内
            const containingGroupId = findContainingGroupId(node, nodesRef.current);
            return { ...node, metadata: { ...node.metadata, groupId: containingGroupId } };
        });

        const nextConnections = buildPastedNodeConnections(clipboard.connections, idMap, nodesRef.current);

        setNodes((prev) => [...prev, ...pastedNodes]);
        if (nextConnections.length) {
            connectionsRef.current = [...connectionsRef.current, ...nextConnections];
            setConnections((prev) => [...prev, ...nextConnections]);
        }
        setSelectedNodeIds(new Set(pastedNodes.map((node) => node.id)));
        setSelectedConnectionId(null);
        setContextMenu(null);
        setDialogNodeId(pastedNodes[0]?.type === CanvasNodeType.Group ? null : pastedNodes[0]?.id || null);
        return true;
    }, [getCanvasCenter]);

    const resetViewport = useCallback(() => {
        setViewport({ x: size.width / 2, y: size.height / 2, k: 1 });
        setContextMenu(null);
    }, [size.height, size.width]);

    /** 视图过渡：所有"跳转视角"的动作都走这里，手感一致（450ms、easeOutCubic）。 */
    const animateToViewport = useCallback((target: ViewportTransform) => {
        if (focusAnimRef.current) cancelAnimationFrame(focusAnimRef.current);
        const start = { ...viewportRef.current };
        const duration = 450;
        const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);
        let startTime: number | null = null;
        const step = (now: number) => {
            if (startTime === null) startTime = now;
            const progress = Math.min((now - startTime) / duration, 1);
            const t = easeOutCubic(progress);
            setViewport({ x: start.x + (target.x - start.x) * t, y: start.y + (target.y - start.y) * t, k: start.k + (target.k - start.k) * t });
            focusAnimRef.current = progress < 1 ? requestAnimationFrame(step) : null;
        };
        focusAnimRef.current = requestAnimationFrame(step);
    }, []);

    const focusNode = useCallback(
        (nodeId: string) => {
            const node = nodesRef.current.find((item) => item.id === nodeId);
            if (!node) return;
            const worldX = node.position.x + node.width / 2;
            const worldY = node.position.y + node.height / 2;
            const k = Math.min(Math.max(Math.min((size.width * 0.6) / node.width, (size.height * 0.6) / node.height), 0.05), 1);
            const target = { x: size.width / 2 - worldX * k, y: size.height / 2 - worldY * k, k };
            setSelectedNodeIds(new Set([nodeId]));
            setSelectedConnectionId(null);
            setContextMenu(null);
            animateToViewport(target);
        },
        [animateToViewport, size.height, size.width],
    );

    /**
     * 适配视图：把所有内容（或只把选中的内容）缩放到刚好铺满可视区。
     *
     * 长片项目里节点一多，靠滚轮找东西非常低效 —— 这是一个专业画布的基本盘。
     * 会跳过折叠分组里的成员：它们不显示，算进包围盒只会白白留一圈空白。
     */
    const fitView = useCallback(
        (onlySelection: boolean) => {
            const selectedIds = selectedNodeIdsRef.current;
            const pool = nodesRef.current.filter((node) => !collapsedNodeIdsRef.current.has(node.id) && (!onlySelection || selectedIds.has(node.id)));
            const bounds = boundsOfNodes(pool);
            if (!bounds) {
                message.info(t("canvas.layout.emptyCanvas"));
                return;
            }
            const padding = 72;
            const contentWidth = Math.max(1, bounds.right - bounds.left);
            const contentHeight = Math.max(1, bounds.bottom - bounds.top);
            const k = Math.min(Math.max(Math.min((size.width - padding * 2) / contentWidth, (size.height - padding * 2) / contentHeight), 0.05), 1.2);
            const centerX = (bounds.left + bounds.right) / 2;
            const centerY = (bounds.top + bounds.bottom) / 2;
            animateToViewport({ x: size.width / 2 - centerX * k, y: size.height / 2 - centerY * k, k });
        },
        [animateToViewport, message, size.height, size.width, t],
    );

    /** 批量排版后同步分组关系：组框动了，成员归属要跟着重新判定，与拖拽组框的行为一致。 */
    const applyNodeLayout = useCallback(
        (next: CanvasNodeData[] | null) => {
            if (!next) return;
            const selectedIds = selectedNodeIdsRef.current;
            let resolved = next;
            for (const node of next) {
                if (selectedIds.has(node.id) && node.type === CanvasNodeType.Group) {
                    resolved = syncGroupMembershipAfterTransform(node.id, resolved);
                }
            }
            setNodes(resolved);
        },
        [setNodes],
    );

    const handleAlignNodes = useCallback(
        (mode: NodeAlignMode) => {
            applyNodeLayout(alignSelectedNodes(nodesRef.current, selectedNodeIdsRef.current, mode, { lockedIds: lockedNodeIdsRef.current }));
        },
        [applyNodeLayout],
    );

    const handleDistributeNodes = useCallback(
        (mode: NodeDistributeMode) => {
            applyNodeLayout(distributeSelectedNodes(nodesRef.current, selectedNodeIdsRef.current, mode, { lockedIds: lockedNodeIdsRef.current }));
        },
        [applyNodeLayout],
    );

    /** 排版工具条挂在选集正上方；贴到顶边放不下时翻到选集下方，永远在视野里。 */
    const selectionToolbar = useMemo(() => {
        if (selectedNodeIds.size < 2) return null;
        const selected = nodes.filter((node) => selectedNodeIds.has(node.id) && !collapsedNodeIds.has(node.id));
        const bounds = boundsOfNodes(selected);
        if (!bounds || selected.length < 2) return null;
        const left = Math.min(Math.max(((bounds.left + bounds.right) / 2) * viewport.k + viewport.x, 132), Math.max(132, size.width - 132));
        const above = bounds.top * viewport.k + viewport.y - 12;
        const placement: "above" | "below" = above > 64 ? "above" : "below";
        return { left, top: placement === "above" ? above : bounds.bottom * viewport.k + viewport.y + 12, placement, count: selected.length };
    }, [collapsedNodeIds, nodes, selectedNodeIds, size.width, viewport]);


    useEffect(() => () => void (focusAnimRef.current && cancelAnimationFrame(focusAnimRef.current)), []);

    const setZoomScale = useCallback(
        (scale: number) => {
            const nextScale = Math.min(Math.max(scale, 0.05), 5);
            setViewport((prev) => ({
                x: size.width / 2 - ((size.width / 2 - prev.x) / prev.k) * nextScale,
                y: size.height / 2 - ((size.height / 2 - prev.y) / prev.k) * nextScale,
                k: nextScale,
            }));
            setContextMenu(null);
        },
        [size.height, size.width],
    );

    const applyHistory = useCallback((entry: CanvasHistoryEntry) => {
        if (historyCommitTimerRef.current) {
            clearTimeout(historyCommitTimerRef.current);
            historyCommitTimerRef.current = null;
        }
        applyingHistoryRef.current = true;
        setNodes(entry.nodes);
        setConnections(entry.connections);
        setChatSessions(entry.chatSessions);
        setActiveChatId(entry.activeChatId);
        setBackgroundMode(entry.backgroundMode);
        setShowImageInfo(entry.showImageInfo);
        setSelectedNodeIds(new Set());
        setSelectedConnectionId(null);
        setContextMenu(null);
        setTimeout(() => {
            lastHistoryRef.current = entry;
            applyingHistoryRef.current = false;
            setHistoryState({ canUndo: historyRef.current.past.length > 0, canRedo: historyRef.current.future.length > 0 });
        });
    }, []);

    const undoCanvas = useCallback(() => {
        const previous = historyRef.current.past.pop();
        const current = lastHistoryRef.current;
        if (!previous || !current) return;
        historyRef.current.future.push(current);
        applyHistory(previous);
    }, [applyHistory]);

    const redoCanvas = useCallback(() => {
        const next = historyRef.current.future.pop();
        const current = lastHistoryRef.current;
        if (!next || !current) return;
        historyRef.current.past.push(current);
        applyHistory(next);
    }, [applyHistory]);

    const createAndOpenProject = useCallback(() => {
        const id = createProject(t("canvas.defaultTitle", { count: useCanvasStore.getState().projects.length + 1 }));
        navigate(`/canvas/${id}`);
    }, [createProject, navigate, t]);

    const deleteCurrentProject = useCallback(() => {
        deleteProjects([projectId]);
        cleanupAssetImages();
        navigate("/canvas");
    }, [cleanupAssetImages, deleteProjects, navigate, projectId]);

    const exportCurrentProject = useCallback(async () => {
        const project = useCanvasStore.getState().projects.find((item) => item.id === projectId);
        if (!project) return message.error(t("canvas.projectPage.notFound"));
        const hide = message.loading(t("canvas.projectPage.exporting"), 0);
        try {
            await exportCanvasProjects([project], project.title || t("canvas.title"));
            message.success(t("canvas.projectPage.exported"));
        } catch (error) {
            console.error(error);
            message.error(t("canvas.sidePanel.exportFailed"));
        } finally {
            hide();
        }
    }, [message, projectId, t]);

    const handleCanvasMouseDown = useCallback(
        (event: ReactPointerEvent<HTMLDivElement>) => {
            setContextMenu(null);
            setNodeCreatePosition(null);
            setHoveredNodeId(null);
            setToolbarNodeId(null);
            setDialogNodeId(null);
            if (pendingConnectionCreateRef.current) cancelPendingConnectionCreate();
            if (event.button !== 0) return;

            const world = screenToCanvas(event.clientX, event.clientY);
            const nextSelectionBox = {
                startWorldX: world.x,
                startWorldY: world.y,
                currentWorldX: world.x,
                currentWorldY: world.y,
                additive: event.shiftKey,
                initialSelectedNodeIds: event.shiftKey ? Array.from(selectedNodeIdsRef.current) : [],
            };
            selectionBoxRef.current = nextSelectionBox;
            setSelectionBox(nextSelectionBox);
            if (!event.shiftKey) {
                setSelectedNodeIds(new Set());
            }

            setSelectedConnectionId(null);
        },
        [cancelPendingConnectionCreate, screenToCanvas],
    );

    // Selection-only logic shared by the bubbling drag entry point and outer capture handler.
    // Returns the single target ID after the click, or null for multi-selection or deselection, to sync the toolbar.
    const selectNodeByEvent = useCallback((event: Pick<ReactMouseEvent, "shiftKey" | "metaKey" | "ctrlKey">, nodeId: string) => {
        const nextSelected = new Set(selectedNodeIdsRef.current);
        if (event.shiftKey || event.metaKey || event.ctrlKey) {
            if (nextSelected.has(nodeId)) nextSelected.delete(nodeId);
            else nextSelected.add(nodeId);
        } else if (!nextSelected.has(nodeId)) {
            nextSelected.clear();
            nextSelected.add(nodeId);
        }
        setSelectedNodeIds(nextSelected);
        const soloId = nextSelected.size === 1 && nextSelected.has(nodeId) ? nodeId : null;
        setToolbarNodeId(soloId);
        return { nextSelected, soloId };
    }, []);

    // Capture-phase selection lets any inner element, including textarea or iframe, select the node and show its toolbar.
    // It only selects; body onMouseDown still starts dragging, so text selection inside editors does not drag the node.
    // Cache the capture result for the following bubbling drag handler to avoid applying shift-selection twice.
    const pendingSelectionRef = useRef<Set<string> | null>(null);
    const handleNodeSelectCapture = useCallback(
        (event: ReactMouseEvent, nodeId: string) => {
            if (event.button !== 0) return;
            setContextMenu(null);
            setHoveredNodeId(null);
            setSelectedConnectionId(null);
            const { nextSelected } = selectNodeByEvent(event, nodeId);
            pendingSelectionRef.current = nextSelected;
        },
        [selectNodeByEvent],
    );

    const handleNodeMouseDown = useCallback((event: ReactMouseEvent, nodeId: string) => {
        event.stopPropagation();
        if (isViewerRef.current) return;
        // Capture already selected the node; this only starts dragging, with a fallback selection if capture did not run.
        const currentNodes = nodesRef.current;
        const nextSelected = pendingSelectionRef.current ?? selectNodeByEvent(event, nodeId).nextSelected;
        pendingSelectionRef.current = null;
        const dragIds = new Set(nextSelected);
        currentNodes.forEach((node) => {
            if (!nextSelected.has(node.id)) return;
            if (node.type === CanvasNodeType.Group) {
                currentNodes.forEach((child) => {
                    if (child.metadata?.groupId === node.id) dragIds.add(child.id);
                });
            }
        });
        // 锁定节点（自身锁定，或位于锁定分组内）不参与拖拽；全被锁时连拖拽会话都不开。
        for (const id of [...dragIds]) {
            const target = currentNodes.find((item) => item.id === id);
            if (target && isNodeLocked(target, currentNodes)) dragIds.delete(id);
        }
        if (!dragIds.size) return;
        dragRef.current = {
            isDraggingNode: true,
            hasMoved: false,
            startX: event.clientX,
            startY: event.clientY,
            initialSelectedNodes: currentNodes.filter((node) => dragIds.has(node.id)).map((node) => ({ id: node.id, x: node.position.x, y: node.position.y })),
            snappedDx: undefined,
            snappedDy: undefined,
        };
        historyPausedRef.current = true;
        nodeDraggingRef.current = true;
        setIsNodeDragging(true);
    }, []);

    const finishNodeDrag = useCallback((clientX?: number, clientY?: number) => {
        if (rafRef.current) {
            cancelAnimationFrame(rafRef.current);
            rafRef.current = null;
        }
        if (!dragRef.current.isDraggingNode) return;

        const wasClick = !dragRef.current.hasMoved && dragRef.current.initialSelectedNodes.length === 1;
        const clickedNodeId = dragRef.current.initialSelectedNodes[0]?.id;
        const currentViewport = viewportRef.current;
        const dx = clientX == null ? 0 : (dragRef.current.snappedDx ?? (clientX - dragRef.current.startX) / currentViewport.k);
        const dy = clientY == null ? 0 : (dragRef.current.snappedDy ?? (clientY - dragRef.current.startY) / currentViewport.k);
        const initialPositions = dragRef.current.initialSelectedNodes;

        setAlignmentGuides([]);
        historyPausedRef.current = false;
        nodeDraggingRef.current = false;
        setIsNodeDragging(false);
        setDropTargetGroupId(null);
        if (dragRef.current.hasMoved && clientX != null && clientY != null) {
            const movedIds = new Set(initialPositions.map((item) => item.id));
            setNodes((prev) => {
                let moved = prev.map((node) => {
                    const initial = initialPositions.find((item) => item.id === node.id);
                    return initial ? { ...node, position: { x: initial.x + dx, y: initial.y + dy } } : node;
                });
                const targetGroup = findGroupDropTarget(movedIds, moved);
                if (targetGroup) return snapNodesIntoGroup(movedIds, moved, targetGroup);

                // 若移动的节点中包含组节点，自动同步该组对画布上其他节点的包含关系
                const movedGroupIds = moved.filter((n) => movedIds.has(n.id) && n.type === CanvasNodeType.Group).map((n) => n.id);
                if (movedGroupIds.length > 0) {
                    for (const gid of movedGroupIds) {
                        moved = syncGroupMembershipAfterTransform(gid, moved);
                    }
                    return moved;
                }

                return moved.map((node) => {
                    if (!movedIds.has(node.id) || node.type === CanvasNodeType.Group) return node;
                    const groupId = findContainingGroupId(node, moved);
                    if (node.metadata?.groupId === groupId) return node;
                    return { ...node, metadata: { ...node.metadata, groupId } };
                });
            });
        }

        dragRef.current.isDraggingNode = false;
        dragRef.current.hasMoved = false;
        dragRef.current.initialSelectedNodes = [];
        dragRef.current.snappedDx = undefined;
        dragRef.current.snappedDy = undefined;
        if (wasClick && clickedNodeId) {
            const clickedNode = nodesRef.current.find((node) => node.id === clickedNodeId);
            const clickedDefinition = clickedNode ? getNodeDefinition(clickedNode.type) : undefined;
            if (clickedDefinition?.hidePanel) {
                // Clicking a display-only plugin node selects it without opening a lower panel.
                setDialogNodeId((current) => (current === clickedNodeId ? current : null));
            } else if (clickedNode?.type !== CanvasNodeType.Group) {
                setDialogNodeId(clickedNodeId);
            }
        }
    }, []);

    const handleGlobalMouseMove = useCallback(
        (event: MouseEvent) => {
            if (activeRoomId) {
                const now = performance.now();
                if (now - lastCursorBroadcastRef.current > 40) {
                    lastCursorBroadcastRef.current = now;
                    broadcastCursor(screenToCanvas(event.clientX, event.clientY), Array.from(selectedNodeIdsRef.current));
                }
            }
            const currentViewport = viewportRef.current;

            if (dragRef.current.isDraggingNode) {
                const rawDx = (event.clientX - dragRef.current.startX) / currentViewport.k;
                const rawDy = (event.clientY - dragRef.current.startY) / currentViewport.k;
                const initialPositions = dragRef.current.initialSelectedNodes;
                if (Math.abs(event.clientX - dragRef.current.startX) > 3 || Math.abs(event.clientY - dragRef.current.startY) > 3) {
                    dragRef.current.hasMoved = true;
                }

                const snapResult = calculateAlignmentSnap({
                    initialNodes: initialPositions,
                    rawDx,
                    rawDy,
                    allNodes: nodesRef.current,
                    viewportScale: currentViewport.k,
                    disabled: event.altKey,
                });

                const dx = snapResult.snappedDx;
                const dy = snapResult.snappedDy;
                dragRef.current.snappedDx = dx;
                dragRef.current.snappedDy = dy;
                setAlignmentGuides(snapResult.guides);

                const movedIds = new Set(initialPositions.map((item) => item.id));
                const previewNodes = nodesRef.current.map((node) => {
                    const initial = initialPositions.find((item) => item.id === node.id);
                    return initial ? { ...node, position: { x: initial.x + dx, y: initial.y + dy } } : node;
                });
                setDropTargetGroupId(findGroupDropTarget(movedIds, previewNodes)?.id || null);

                if (rafRef.current) cancelAnimationFrame(rafRef.current);
                rafRef.current = requestAnimationFrame(() => {
                    setNodes((prev) =>
                        prev.map((node) => {
                            const initial = initialPositions.find((item) => item.id === node.id);
                            return initial ? { ...node, position: { x: initial.x + dx, y: initial.y + dy } } : node;
                        }),
                    );
                    rafRef.current = null;
                });
                return;
            }

            if (selectedNodeIdsRef.current.size > 1 && !dragRef.current.isDraggingNode && !connectingParamsRef.current) {
                setMouseWorld(screenToCanvas(event.clientX, event.clientY));
            }

            if (connectingParamsRef.current && !pendingConnectionCreateRef.current) {
                const dropTarget = getConnectionDropTarget(event.clientX, event.clientY, connectingParamsRef.current);
                connectionTargetNodeIdRef.current = dropTarget.nodeId;
                setConnectionTargetNodeId(dropTarget.nodeId);
                setMouseWorld(screenToCanvas(event.clientX, event.clientY));
            }
        },
        [activeRoomId, broadcastCursor, finishNodeDrag, getConnectionDropTarget, screenToCanvas],
    );

    const handleGlobalPointerMove = useCallback(
        (event: PointerEvent) => {
            const currentSelection = selectionBoxRef.current;
            if (!currentSelection) return;

            if (event.buttons === 0) {
                selectionBoxRef.current = null;
                setSelectionBox(null);
                return;
            }

            const world = screenToCanvas(event.clientX, event.clientY);
            const rectX = Math.min(currentSelection.startWorldX, world.x);
            const rectY = Math.min(currentSelection.startWorldY, world.y);
            const rectW = Math.abs(world.x - currentSelection.startWorldX);
            const rectH = Math.abs(world.y - currentSelection.startWorldY);
            const nextSelected = new Set<string>(currentSelection.additive ? currentSelection.initialSelectedNodeIds : []);

            nodesRef.current
                // 折叠分组里看不见的节点、以及锁定节点都不参与框选：前者框不到，后者不该被批量操作带上。
                .filter((node) => !collapsedNodeIdsRef.current.has(node.id) && !lockedNodeIdsRef.current.has(node.id))
                .forEach((node) => {
                    const intersects = rectX < node.position.x + node.width && rectX + rectW > node.position.x && rectY < node.position.y + node.height && rectY + rectH > node.position.y;

                    if (intersects) nextSelected.add(node.id);
                });

            const nextSelectionBox = { ...currentSelection, currentWorldX: world.x, currentWorldY: world.y };
            selectionBoxRef.current = nextSelectionBox;
            setSelectionBox(nextSelectionBox);
            setSelectedNodeIds(nextSelected);
        },
        [screenToCanvas],
    );

    const handleGlobalMouseUp = useCallback(
        (event: MouseEvent) => {
            finishNodeDrag(event.clientX, event.clientY);

            selectionBoxRef.current = null;
            setSelectionBox(null);

            if (pendingConnectionCreateRef.current) return;

            const currentConnection = connectingParamsRef.current;
            if (currentConnection) {
                const dropTarget = getConnectionDropTarget(event.clientX, event.clientY, currentConnection);
                if (dropTarget.nodeId) {
                    connectNodes(currentConnection, dropTarget.nodeId);
                    setConnecting(null);
                } else if (dropTarget.isNearNode) {
                    setConnecting(null);
                } else {
                    const selected = selectedNodeIdsRef.current;
                    const isBatch = selected.has(currentConnection.nodeId) && selected.size > 1;
                    const sourceNodeIds = isBatch ? Array.from(selected) : [currentConnection.nodeId];
                    setMouseWorld(screenToCanvas(event.clientX, event.clientY));
                    setPendingConnectionCreate({
                        connection: currentConnection,
                        position: screenToCanvas(event.clientX, event.clientY),
                        sourceNodeIds,
                    });
                }
            }
        },
        [connectNodes, finishNodeDrag, getConnectionDropTarget, screenToCanvas, setConnecting],
    );

    useEffect(() => {
        const handlePointerUp = (event: PointerEvent) => finishNodeDrag(event.clientX, event.clientY);
        const cancelNodeDrag = () => finishNodeDrag();
        window.addEventListener("mousemove", handleGlobalMouseMove);
        window.addEventListener("mouseup", handleGlobalMouseUp);
        window.addEventListener("pointerup", handlePointerUp);
        window.addEventListener("pointercancel", cancelNodeDrag);
        window.addEventListener("blur", cancelNodeDrag);
        window.addEventListener("pointermove", handleGlobalPointerMove);
        return () => {
            window.removeEventListener("mousemove", handleGlobalMouseMove);
            window.removeEventListener("mouseup", handleGlobalMouseUp);
            window.removeEventListener("pointerup", handlePointerUp);
            window.removeEventListener("pointercancel", cancelNodeDrag);
            window.removeEventListener("blur", cancelNodeDrag);
            window.removeEventListener("pointermove", handleGlobalPointerMove);
        };
    }, [finishNodeDrag, handleGlobalMouseMove, handleGlobalMouseUp, handleGlobalPointerMove]);

    const createImageFileNode = useCallback(async (file: File, position: Position) => {
        const image = await uploadImage(file);
        const size = fitNodeSize(image.width, image.height);
        const id = `image-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        const newNode: CanvasNodeData = {
            id,
            type: CanvasNodeType.Image,
            title: file.name,
            position: { x: position.x - size.width / 2, y: position.y - size.height / 2 },
            width: size.width,
            height: size.height,
            metadata: imageMetadata(image),
        };

        setNodes((prev) => [...prev, newNode]);
        setSelectedNodeIds(new Set([id]));
        setSelectedConnectionId(null);
        setDialogNodeId(id);
    }, []);

    const createVideoFileNode = useCallback(async (file: File, position: Position) => {
        const video = await uploadMediaFile(file, "video");
        const size = fitNodeSize(video.width || 1280, video.height || 720, VIDEO_NODE_MAX_WIDTH, VIDEO_NODE_MAX_HEIGHT);
        const id = `video-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        setNodes((prev) => [
            ...prev,
            {
                id,
                type: CanvasNodeType.Video,
                title: file.name,
                position: { x: position.x - size.width / 2, y: position.y - size.height / 2 },
                width: size.width,
                height: size.height,
                metadata: videoMetadata(video),
            },
        ]);
        setSelectedNodeIds(new Set([id]));
        setSelectedConnectionId(null);
        setDialogNodeId(id);
    }, []);

    const createAudioFileNode = useCallback(async (file: File, position: Position) => {
        const audio = await uploadMediaFile(file, "audio");
        const spec = NODE_DEFAULT_SIZE[CanvasNodeType.Audio];
        const id = `audio-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        setNodes((prev) => [
            ...prev,
            {
                id,
                type: CanvasNodeType.Audio,
                title: file.name,
                position: { x: position.x - spec.width / 2, y: position.y - spec.height / 2 },
                width: spec.width,
                height: spec.height,
                metadata: audioMetadata(audio),
            },
        ]);
        setSelectedNodeIds(new Set([id]));
        setSelectedConnectionId(null);
    }, []);

    const createTextNodeFromClipboard = useCallback(
        (text: string) => {
            const trimmed = text.trim();
            if (!trimmed) return false;

            const node = {
                ...createCanvasNode(CanvasNodeType.Text, getCanvasCenter(), { content: trimmed, status: NODE_STATUS_SUCCESS }),
                title: trimmed.slice(0, 32) || t("canvas.projectPage.clipboardText"),
            };

            setNodes((prev) => [...prev, node]);
            setSelectedNodeIds(new Set([node.id]));
            setSelectedConnectionId(null);
            setContextMenu(null);
            setDialogNodeId(node.id);
            return true;
        },
        [getCanvasCenter, t],
    );

    const pasteSystemClipboard = useCallback(async () => {
        if (!navigator.clipboard) return;

        const items = await navigator.clipboard.read();
        const imageItem = items.find((item) => item.types.some((type) => type.startsWith("image/")));
        if (imageItem) {
            const imageType = imageItem.types.find((type) => type.startsWith("image/"));
            if (!imageType) return;
            const blob = await imageItem.getType(imageType);
            const file = new File([blob], "clipboard-image.png", { type: imageType });
            void createImageFileNode(file, getCanvasCenter());
            message.success(t("canvas.projectPage.clipboardImageAdded"));
            return;
        }

        const text = await navigator.clipboard.readText();
        if (createTextNodeFromClipboard(text)) message.success(t("canvas.projectPage.clipboardTextAdded"));
    }, [createImageFileNode, createTextNodeFromClipboard, getCanvasCenter, message, t]);

    useEffect(() => {
        const handleKeyDown = (event: KeyboardEvent) => {
            const target = event.target instanceof Element ? event.target : null;
            if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement || target?.closest("[contenteditable='true'],[data-canvas-no-zoom],[data-canvas-shortcuts-ignore]")) return;

            const key = event.key.toLowerCase();
            const isModifierShortcut = event.metaKey || event.ctrlKey;

            // Shift+1 适配全部、Shift+2 适配选中：用 code 判定，避免 Shift 把 1 变成 "!" 的键盘布局差异。
            if (!isModifierShortcut && !event.altKey && event.shiftKey && (event.code === "Digit1" || event.code === "Digit2")) {
                event.preventDefault();
                fitView(event.code === "Digit2");
                return;
            }

            if (isModifierShortcut && key === "c" && window.getSelection()?.toString()) return;

            if (isModifierShortcut && !event.altKey && key === "z") {
                event.preventDefault();
                if (event.shiftKey) redoCanvas();
                else undoCanvas();
                return;
            }

            if (isModifierShortcut && !event.altKey && key === "y") {
                event.preventDefault();
                redoCanvas();
                return;
            }

            if (isModifierShortcut && !event.altKey && key === "a") {
                event.preventDefault();
                setSelectedNodeIds(new Set(nodesRef.current.map((node) => node.id)));
                setSelectedConnectionId(null);
                setContextMenu(null);
                setSelectionBox(null);
                return;
            }

            if (isModifierShortcut && !event.altKey && key === "g") {
                event.preventDefault();
                if (event.shiftKey) {
                    ungroupSelected();
                } else {
                    groupSelectedNodes();
                }
                return;
            }

            if (isModifierShortcut && !event.altKey && event.shiftKey && (key === "e" || key === "l")) {
                const groups = nodesRef.current.filter((node) => node.type === CanvasNodeType.Group && selectedNodeIdsRef.current.has(node.id));
                if (!groups.length) return;
                event.preventDefault();
                if (key === "e") {
                    // 目标态取"多数"的反面：只要还有展开的，就全部折叠。
                    applyGroupCollapsed(
                        groups.map((group) => group.id),
                        groups.some((group) => !group.metadata?.collapsed),
                    );
                } else {
                    const locked = groups.some((group) => !group.metadata?.locked);
                    const ids = new Set(groups.map((group) => group.id));
                    setNodes((prev) => prev.map((node) => (ids.has(node.id) ? { ...node, metadata: { ...node.metadata, locked } } : node)));
                }
                return;
            }

            if (isModifierShortcut && !event.altKey && key === "c") {
                event.preventDefault();
                copySelectedNodes();
                return;
            }

            if (isModifierShortcut && !event.altKey && key === "v") {
                event.preventDefault();
                if (!pasteCopiedNodes()) void pasteSystemClipboard();
                return;
            }

            if (event.key === "Delete" || event.key === "Backspace") {
                if (selectedNodeIdsRef.current.size) {
                    deleteNodes(new Set(selectedNodeIdsRef.current));
                } else if (selectedConnectionId) {
                    deleteConnection(selectedConnectionId);
                }
            }

            if (event.key === "Escape") {
                setSelectedNodeIds(new Set());
                setSelectedConnectionId(null);
                setContextMenu(null);
                setNodeCreatePosition(null);
                setSelectionBox(null);
                setConnecting(null);
                setHoveredNodeId(null);
                setToolbarNodeId(null);
                setDialogNodeId(null);
                setInfoNodeId(null);
                setCropNodeId(null);
                setMaskEditNodeId(null);
                setPendingConnectionCreate(null);
            }
        };

        window.addEventListener("keydown", handleKeyDown);
        return () => window.removeEventListener("keydown", handleKeyDown);
    }, [applyGroupCollapsed, copySelectedNodes, deleteConnection, deleteNodes, fitView, pasteCopiedNodes, pasteSystemClipboard, redoCanvas, selectedConnectionId, setConnecting, undoCanvas]);

    const handleConnectStart = useCallback(
        (event: ReactMouseEvent | React.PointerEvent, nodeId: string, handleType: "source" | "target") => {
            event.stopPropagation();
            // 锁定节点不接受新的连线，避免"锁住了还能被接走/接进来"。
            if (lockedNodeIdsRef.current.has(nodeId)) {
                message.warning(t("canvas.node.locked"));
                return;
            }
            setMouseWorld(screenToCanvas(event.clientX, event.clientY));
            setConnecting({ nodeId, handleType });
            connectionTargetNodeIdRef.current = null;
            setConnectionTargetNodeId(null);
            setSelectedConnectionId(null);
        },
        [screenToCanvas, setConnecting],
    );

    const handleConnectClick = useCallback(
        (event: ReactMouseEvent, nodeId: string, handleType: "source") => {
            event.stopPropagation();
            const node = nodeById.get(nodeId);
            if (!node) return;
            const pos = { x: node.position.x + node.width + 48, y: node.position.y + node.height / 2 - 40 };
            setPendingConnectionCreate({
                connection: { nodeId, handleType },
                position: pos,
                sourceNodeIds: [nodeId],
            });
        },
        [nodeById],
    );

    const handleMultiSelectClickPlus = useCallback(
        (position: Position, primaryNodeId: string, sourceNodeIds: string[]) => {
            setPendingConnectionCreate({
                connection: { nodeId: primaryNodeId, handleType: "source" },
                position,
                sourceNodeIds,
            });
        },
        [],
    );

    const resizingNodeIdRef = useRef<string | null>(null);

    const handleNodeResize = useCallback((nodeId: string, width: number, height: number, position?: Position) => {
        resizingNodeIdRef.current = nodeId;
        setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, width, height, position: position || node.position } : node)));
    }, []);

    const handleNodeResizeStart = useCallback((nodeId?: string) => {
        if (nodeId && lockedNodeIdsRef.current.has(nodeId)) return;
        setIsNodeResizing(true);
    }, []);
    const handleNodeResizeEnd = useCallback(() => {
        setIsNodeResizing(false);
        const resizedId = resizingNodeIdRef.current;
        resizingNodeIdRef.current = null;
        if (resizedId) {
            const resizedNode = nodesRef.current.find((n) => n.id === resizedId);
            if (resizedNode?.type === CanvasNodeType.Group) {
                setNodes((prev) => syncGroupMembershipAfterTransform(resizedId, prev));
            }
        }
    }, []);

    const toggleNodeFreeResize = useCallback((nodeId: string) => {
        setNodes((prev) =>
            prev.map((node) => {
                if (node.id !== nodeId) return node;
                const freeResize = !node.metadata?.freeResize;
                if (freeResize || node.type !== CanvasNodeType.Image) return { ...node, metadata: { ...node.metadata, freeResize } };
                const ratio = (node.metadata?.naturalWidth || node.width) / (node.metadata?.naturalHeight || node.height || 1);
                const height = node.width / ratio;
                return { ...node, height, position: { x: node.position.x, y: node.position.y + node.height / 2 - height / 2 }, metadata: { ...node.metadata, freeResize } };
            }),
        );
    }, []);

    const handleNodeContentChange = useCallback((nodeId: string, content: string) => {
        setNodes((prev) =>
            prev.map((node) =>
                node.id === nodeId
                    ? { ...node, metadata: { ...node.metadata, content, texts: node.metadata?.texts?.map((text) => (text.id === node.metadata?.primaryTextId ? { ...text, content } : text)) } }
                    : node,
            ),
        );
    }, []);

    const handleNodeTitleChange = useCallback((nodeId: string, title: string) => {
        setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, title } : node)));
    }, []);

    // 提示词助手：组装「技能指令 + 工作流约束 + 原文」交给本地文本链路，流式写进一条新备选，完成后设为主文本。
    const promptAssistantConstraintFor = useCallback(
        (node: CanvasNodeData) => {
            const category = resolveAssistantTargetCategory(node.id, nodesRef.current, connectionsRef.current);
            if (!category) return "";
            const channel = resolveModelChannel(effectiveConfig, effectiveConfig.textModel || effectiveConfig.model);
            const workflow = getDefaultWorkflow(channel, category);
            return resolveWorkflowConstraint(category, workflow ? collectWorkflowSlots(workflow.json) : []);
        },
        [effectiveConfig],
    );

    /** 提示词助手的 agent 超时：长文本改写比生成侧慢，120s 后按超时处理。 */
    const PROMPT_ASSISTANT_AGENT_TIMEOUT_MS = 120_000;

    /** 走本地 Agent：把组装好的指令交给当前会话，等这一轮结束再取回助手正文（结果同时会出现在助手面板里）。 */
    const runPromptAssistantTurn = useCallback((prompt: string, config: PromptAssistantConfig, signal: AbortSignal, contextImages: string[] = []) => {
        const agent = useAgentStore.getState();
        const endpoint = agent.url;
        if (!agent.connected || !agent.token || !endpoint) return Promise.reject(new Error("AGENT_OFFLINE"));
        const messageId = nanoid();
        return fetchAgentJson<{ threadId?: string }>(endpoint, agent.token, "/agent/codex/turn", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                prompt,
                messageText: prompt.slice(0, 200),
                messageId,
                clientId: readAgentClientId(),
                threadId: agent.activeThreadId,
                conversationId: agent.conversation.conversationId,
                expectedRevision: agent.conversation.revision,
                // 改提示词不需要文件/网络权限：固定用最保守的模式，不继承对话面板里的设置。
                permissionMode: "request",
                model: config.model || agent.model || undefined,
                effort: config.effort || agent.reasoningEffort || undefined,
                skill: config.skill?.kind === "agent" ? { name: config.skill.name, path: config.skill.path } : undefined,
                attachments: contextImages.map((dataUrl, index) => ({ id: `assistant-${index}`, name: `reference-${index + 1}.png`, type: "image/png", size: 0, width: 0, height: 0, dataUrl })),
            }),
        }).then(
            () =>
                new Promise<string>((resolve, reject) => {
                    const startedAt = Date.now();
                    let started = false;
                    const cleanup = () => {
                        window.clearInterval(timer);
                        signal.removeEventListener("abort", onAbort);
                    };
                    const onAbort = () => {
                        cleanup();
                        reject(new Error("ABORTED"));
                    };
                    const timer = window.setInterval(() => {
                        const state = useAgentStore.getState();
                        if (state.waiting) started = true;
                        if (signal.aborted) return onAbort();
                        if (Date.now() - startedAt > PROMPT_ASSISTANT_AGENT_TIMEOUT_MS) {
                            cleanup();
                            reject(new Error("TIMEOUT"));
                            return;
                        }
                        if (!started || state.waiting) return;
                        cleanup();
                        const answer = [...state.messages].reverse().find((item) => item.role === "assistant" && item.text?.trim());
                        resolve(answer?.text || "");
                    }, 500);
                    signal.addEventListener("abort", onAbort);
                }),
        );
    }, []);

    /** 中断服务端那一轮：超时或用户取消都要调，否则会话会一直 busy，下一次会撞 CONVERSATION_BUSY。 */
    const interruptAgentTurn = useCallback(() => {
        const agent = useAgentStore.getState();
        const endpoint = agent.url;
        if (agent.connected && agent.token && endpoint && agent.activeThreadId) void interruptCodexTurn(endpoint, agent.token, agent.activeThreadId).catch(() => undefined);
    }, []);

    /**
     * nodes 形态：不回写当前节点，让 Agent 用画布工具自己建节点，前端只负责喂上下文 + 按画布 diff 报产出。
     * 只走 Agent（ComfyUI 文本工作流只会返回一段文字，建不了节点）。
     */
    const runPromptAssistantNodes = useCallback(
        async (node: CanvasNodeData, assistantConfig: PromptAssistantConfig, skillId?: BuiltinPromptSkillId, options?: { quiet?: boolean }) => {
            if (promptAssistantAbortRef.current) return null;
            if (node.type !== CanvasNodeType.Text) return null;
            if (isNodeLocked(node, nodesRef.current)) {
                if (!options?.quiet) message.warning(t("canvas.promptAssistant.disabledLocked"));
                return null;
            }
            const sourceText = readNodeText(node);
            if (!sourceText) {
                if (!options?.quiet) message.warning(t("canvas.promptAssistant.disabledEmpty"));
                return null;
            }
            if (sourceText.length > MAX_ASSISTANT_SOURCE_CHARS) {
                if (!options?.quiet) message.warning(t("canvas.promptAssistant.sourceTooLong", { max: MAX_ASSISTANT_SOURCE_CHARS }));
                return null;
            }

            const agent = useAgentStore.getState();
            if (!agent.connected) {
                if (!options?.quiet) message.warning(t("canvas.promptAssistant.nodesDisabledAgent"));
                return null;
            }
            if (agent.url && agent.token) void useAgentSkillStore.getState().loadSkills(agent.url, agent.token).catch(() => undefined);

            const config: PromptAssistantConfig = skillId ? { ...assistantConfig, skill: { kind: "builtin", id: skillId } } : assistantConfig;
            const before = { nodes: nodesRef.current, connections: connectionsRef.current };
            const { prompt } = buildNodeOutputRequest({ config, nodeId: node.id, nodeTitle: node.title, nodeText: sourceText });
            setPromptAssistantNodeId(node.id);
            const controller = new AbortController();
            promptAssistantAbortRef.current = controller;
            try {
                const answer = await runPromptAssistantTurn(prompt, { ...config, backend: "agent" }, controller.signal);
                const summary = summarizeAssistantOutput(before, { nodes: nodesRef.current, connections: connectionsRef.current });
                if (summary.addedNodes) {
                    setSelectedNodeIds(new Set(summary.addedIds));
                    setSelectedConnectionId(null);
                    if (!options?.quiet) message.success(assistantOutputSummaryText(summary));
                } else if (!options?.quiet) {
                    message.info(t("canvas.promptAssistant.nodesNone", { answer: cleanOptimizedPrompt(answer).slice(0, 120) }));
                }
                return summary;
            } catch (error) {
                if (controller.signal.aborted) {
                    message.info(t("canvas.promptAssistant.reverted"));
                } else if (error instanceof Error && error.message === "TIMEOUT") {
                    interruptAgentTurn();
                    message.warning(t("canvas.promptAssistant.timeout"));
                } else if (error instanceof AgentApiError && error.response?.code === "CONVERSATION_BUSY") {
                    message.warning(t("canvas.promptAssistant.agentBusy"));
                } else if (!options?.quiet) {
                    message.warning(t("canvas.promptAssistant.nodesRollbackHint"));
                }
                return null;
            } finally {
                promptAssistantAbortRef.current = null;
                setPromptAssistantNodeId(null);
            }
        },
        [interruptAgentTurn, message, runPromptAssistantTurn, t],
    );

    const runNodeSkillBatchRef = useRef<((node: CanvasNodeData, config: PromptAssistantConfig) => Promise<void>) | null>(null);

    /** 节点级配置覆盖全局默认（执行者 / 技能 / 模型 / 附加指令）。 */
    const promptAssistantConfigOf = useCallback(
        (node: CanvasNodeData): PromptAssistantConfig => ({ ...usePromptAssistantStore.getState().config, ...(node.metadata?.promptAssistant || {}) }),
        [],
    );

    const runPromptAssistant = useCallback(
        async (node: CanvasNodeData, config: PromptAssistantConfig, skillId?: BuiltinPromptSkillId, options?: { sourceText?: string; contextImages?: string[]; scope?: "chapter" | "group" }) => {
            if (promptAssistantAbortRef.current) return;
            if (node.type !== CanvasNodeType.Text) return;
            if (isNodeLocked(node, nodesRef.current)) return message.warning(t("canvas.promptAssistant.disabledLocked"));
            const sourceText = options?.sourceText ?? readNodeText(node);
            const contextImages = options?.contextImages || [];
            if (!sourceText && !contextImages.length) return message.warning(t("canvas.promptAssistant.disabledEmpty"));

            const assistantConfig: PromptAssistantConfig = skillId ? { ...config, skill: { kind: "builtin", id: skillId } } : config;
            // 形态由技能/配置决定：产出节点走另一条路径（不做写回）。
            if (!options?.sourceText && !contextImages.length && resolveSkillProduces(assistantConfig) === "nodes") {
                if (options?.scope === "group") return runNodeSkillBatchRef.current?.(node, assistantConfig);
                return runPromptAssistantNodes(node, assistantConfig, skillId);
            }
            const { prompt, truncated } = buildPromptAssistantRequest({ config: assistantConfig, nodeText: sourceText, workflowConstraint: promptAssistantConstraintFor(node), hasImages: contextImages.length > 0 });
            if (truncated) message.info(t("canvas.promptAssistant.truncatedHint"));

            // 原文不动：先挂一条空备选承接流式结果，显示仍留在原文上，直到第一个字回来。
            const { slotId, texts } = appendOptimizedTextSlot(node);
            setNodes((prev) => prev.map((item) => (item.id === node.id ? { ...item, metadata: { ...item.metadata, texts } } : item)));
            setPromptAssistantNodeId(node.id);

            const controller = new AbortController();
            promptAssistantAbortRef.current = controller;
            if (assistantConfig.backend === "agent") {
                // Agent 通道不发画布工具：结果由前端写回，保证「新增备选不覆盖原文」这条规则对两种后端一致。
                const agentOnline = useAgentStore.getState().connected;
                if (!agentOnline) {
                    setNodes((prev) => prev.map((item) => (item.id === node.id ? { ...item, metadata: { ...item.metadata, ...revertOptimizedTextSlot(item, slotId) } } : item)));
                    promptAssistantAbortRef.current = null;
                    setPromptAssistantNodeId(null);
                    message.warning(t("canvas.promptAssistant.agentOffline"));
                    return;
                }
                try {
                    // 顺手刷新「我的技能」列表，设置弹层里才能选到用户自己装的技能。
                    const agentState = useAgentStore.getState();
                    if (agentState.url && agentState.token) void useAgentSkillStore.getState().loadSkills(agentState.url, agentState.token).catch(() => undefined);
                    const answer = await runPromptAssistantTurn(prompt, assistantConfig, controller.signal, contextImages);
                    const finalText = cleanOptimizedPrompt(answer) || answer.trim();
                    if (!finalText) throw new Error("EMPTY_ANSWER");
                    setNodes((prev) =>
                        prev.map((item) =>
                            item.id === node.id ? { ...item, metadata: { ...item.metadata, ...applyOptimizedText(item, slotId, finalText), promptAssistant: { ...assistantConfig, optimizedAt: new Date().toISOString() } } } : item,
                        ),
                    );
                    message.success(t("canvas.promptAssistant.applied"));
                } catch (error) {
                    setNodes((prev) => prev.map((item) => (item.id === node.id ? { ...item, metadata: { ...item.metadata, ...revertOptimizedTextSlot(item, slotId) } } : item)));
                    if (controller.signal.aborted) {
                        message.info(t("canvas.promptAssistant.reverted"));
                    } else if (error instanceof Error && error.message === "TIMEOUT") {
                        // 超时也要把服务端那一轮中断掉，否则会话一直忙。
                        interruptAgentTurn();
                        message.warning(t("canvas.promptAssistant.timeout"));
                    } else if (error instanceof AgentApiError && error.response?.code === "CONVERSATION_BUSY") {
                        message.warning(t("canvas.promptAssistant.agentBusy"));
                    } else if (error instanceof AgentApiError && (error.response?.code === "CONVERSATION_NOT_READY" || error.status === 409)) {
                        message.warning(t("canvas.promptAssistant.agentOffline"));
                    } else {
                        message.error(t("canvas.promptAssistant.failed"));
                    }
                } finally {
                    promptAssistantAbortRef.current = null;
                    setPromptAssistantNodeId(null);
                }
                return;
            }
            try {
                let streamed = "";
                const answer = await requestImageQuestion(
                    buildGenerationConfig(effectiveConfig, node, "text"),
                    [{ role: "user", content: contextImages.length ? [{ type: "text" as const, text: prompt }, ...contextImages.map((url) => ({ type: "image_url" as const, image_url: { url } }))] : prompt }],
                    (delta) => {
                        streamed = delta;
                        setNodes((prev) => prev.map((item) => (item.id === node.id ? { ...item, metadata: { ...item.metadata, ...applyOptimizedText(item, slotId, delta, NODE_STATUS_LOADING) } } : item)));
                    },
                    { signal: controller.signal, seed: generateRandomSeed() },
                );
                const finalText = cleanOptimizedPrompt(answer || streamed) || streamed;
                setNodes((prev) =>
                    prev.map((item) =>
                        item.id === node.id
                            ? {
                                  ...item,
                                  metadata: {
                                      ...item.metadata,
                                      ...applyOptimizedText(item, slotId, finalText),
                                      promptAssistant: { ...assistantConfig, optimizedAt: new Date().toISOString() },
                                  },
                              }
                            : item,
                    ),
                );
                message.success(t("canvas.promptAssistant.applied"));
            } catch (error) {
                setNodes((prev) => prev.map((item) => (item.id === node.id ? { ...item, metadata: { ...item.metadata, ...revertOptimizedTextSlot(item, slotId) } } : item)));
                if (!isGenerationCanceled(error)) message.error(t("canvas.promptAssistant.failed"));
            } finally {
                promptAssistantAbortRef.current = null;
                setPromptAssistantNodeId(null);
            }
        },
        [effectiveConfig, interruptAgentTurn, message, promptAssistantConstraintFor, runPromptAssistantNodes, runPromptAssistantTurn, t],
    );

    /** 产出类技能跑「整个分组」：逐条串行执行（一次只喂一条，避免上下文爆掉）。 */
    const runNodeSkillBatch = useCallback(
        async (node: CanvasNodeData, config: PromptAssistantConfig) => {
            if (promptAssistantAbortRef.current) return;
            const targets = node.metadata?.groupId ? nodesRef.current.filter((item) => item.metadata?.groupId === node.metadata?.groupId) : [node];
            if (!targets.length) return;
            const batch = targets.length > 1;
            const totals = { addedNodes: 0, addedTextNodes: 0, addedGroups: 0, addedOtherNodes: 0, addedConnections: 0 };
            for (let index = 0; index < targets.length; index += 1) {
                if (promptAssistantAbortRef.current) break;
                if (batch) message.loading(t("canvas.promptAssistant.groupProgress", { done: index + 1, total: targets.length, title: targets[index].title }), 1.2);
                const summary = await runPromptAssistantNodes(targets[index], { ...config, backend: "agent" }, undefined, { quiet: batch });
                if (!summary) {
                    if (promptAssistantAbortRef.current) break;
                    continue;
                }
                totals.addedNodes += summary.addedNodes;
                totals.addedTextNodes += summary.addedTextNodes;
                totals.addedOtherNodes += summary.addedOtherNodes;
                totals.addedGroups += summary.addedGroups;
                totals.addedConnections += summary.addedConnections;
            }
            if (batch && totals.addedNodes) message.success(assistantOutputSummaryText(totals));
            else if (batch && !totals.addedNodes) message.info(t("canvas.promptAssistant.nodesNone", { answer: "" }));
        },
        [message, runPromptAssistantNodes, t],
    );

    useEffect(() => {
        runNodeSkillBatchRef.current = runNodeSkillBatch;
    }, [runNodeSkillBatch]);

    const cancelPromptAssistant = useCallback(() => {
        const controller = promptAssistantAbortRef.current;
        promptAssistantAbortRef.current = null;
        controller?.abort();
        interruptAgentTurn();
        setPromptAssistantNodeId(null);
    }, [interruptAgentTurn]);

    const handlePromptAssistantChange = useCallback((node: CanvasNodeData, config: PromptAssistantConfig) => {
        // 同时记住这次选择作为新节点的默认：否则每开一个文本节点都要重选执行者与技能，技能入口等于半残。
        // 只写回配置字段（节点 metadata 里还挂着 optimizedAt 之类的运行记录，别带进全局默认）。
        const { backend, skill, channelId, agentId, model, effort, instruction } = config;
        usePromptAssistantStore.getState().setConfig({ backend, skill, channelId, agentId, model, effort, instruction });
        setNodes((prev) => prev.map((item) => (item.id === node.id ? { ...item, metadata: { ...item.metadata, promptAssistant: config } } : item)));
    }, []);

    const handleNodeEditingTitleChange = useCallback((nodeId: string, isEditing: boolean) => {
        setEditingTitleNodeId((current) => {
            const next = isEditing ? nodeId : null;
            return current === next ? current : next;
        });
    }, []);

    const toggleBatchExpanded = useCallback((nodeId: string) => {
        setExpandedBatchNodeIds((current) => {
            const next = new Set(current);
            if (next.has(nodeId)) next.delete(nodeId);
            else next.add(nodeId);
            return next;
        });
    }, []);

    const setBatchPrimary = useCallback((nodeId: string, itemId: string) => {
        setNodes((prev) =>
            prev.map((node) => {
                if (node.id !== nodeId) return node;
                if (node.type === CanvasNodeType.Text) {
                    const text = node.metadata?.texts?.find((item) => item.id === itemId);
                    return text?.content ? { ...node, metadata: { ...node.metadata, content: text.content, primaryTextId: text.id } } : node;
                }
                const image = node.metadata?.images?.find((item) => item.id === itemId);
                if (!image?.content) return node;
                const edge = Math.max(node.width, node.height);
                const size = node.metadata?.freeResize ? { width: node.width, height: node.height } : fitNodeSize(image.naturalWidth, image.naturalHeight, edge, edge);
                return {
                    ...node,
                    position: { x: node.position.x + node.width / 2 - size.width / 2, y: node.position.y + node.height / 2 - size.height / 2 },
                    ...size,
                    metadata: {
                        ...node.metadata,
                        content: image.content,
                        storageKey: image.storageKey,
                        naturalWidth: image.naturalWidth,
                        naturalHeight: image.naturalHeight,
                        bytes: image.bytes,
                        mimeType: image.mimeType,
                        primaryImageId: image.id,
                        ...(image.seed !== undefined ? { seed: image.seed } : {}),
                    },
                };
            }),
        );
    }, []);

    const duplicateBatchImage = useCallback((node: CanvasNodeData, imageId: string) => {
        const image = node.metadata?.images?.find((item) => item.id === imageId);
        if (!image?.content) return;
        const id = nanoid();
        const edge = Math.max(node.width, node.height);
        const size = fitNodeSize(image.naturalWidth, image.naturalHeight, edge, edge);
        const copy: CanvasNodeData = {
            id,
            type: CanvasNodeType.Image,
            title: node.title,
            position: { x: node.position.x + node.width * 2 + 96, y: node.position.y + node.height / 2 - size.height / 2 },
            ...size,
            metadata: {
                content: image.content,
                storageKey: image.storageKey,
                naturalWidth: image.naturalWidth,
                naturalHeight: image.naturalHeight,
                bytes: image.bytes,
                mimeType: image.mimeType,
                status: NODE_STATUS_SUCCESS,
                prompt: node.metadata?.prompt,
                generationType: node.metadata?.generationType,
                model: node.metadata?.model,
                size: node.metadata?.size,
                quality: node.metadata?.quality,
                ...(image.seed !== undefined ? { seed: image.seed } : {}),
                background: node.metadata?.background,
                references: node.metadata?.references ? [...node.metadata.references] : undefined,
            },
        };
        const parentConnections = duplicateIncomingConnections(node.id, id, connectionsRef.current, nodesRef.current);
        setNodes((prev) => [...prev, copy]);
        if (parentConnections.length) {
            connectionsRef.current = [...connectionsRef.current, ...parentConnections];
            setConnections((prev) => [...prev, ...parentConnections]);
        }
        setSelectedNodeIds(new Set([id]));
        setSelectedConnectionId(null);
        setDialogNodeId(id);
    }, []);

    const handleSplitBatchImages = useCallback(
        (node: CanvasNodeData) => {
            setContextMenu(null);
            const images = node.metadata?.images || [];
            if (images.length <= 1) return;
            const allSuccess = images.every((img) => img.status === NODE_STATUS_SUCCESS && Boolean(img.content));
            if (!allSuccess) {
                message.warning(t("canvas.node.batchSplitNotReady"));
                return;
            }

            modal.confirm({
                title: t("canvas.node.confirmSplitTitle"),
                content: t("canvas.node.confirmSplitBatchContent", { count: images.length }),
                okText: t("common.confirm"),
                cancelText: t("common.cancel"),
                centered: true,
                onOk: () => {
                    const startX = node.position.x + node.width + 96;
                    const gap = 24;
                    const newNodes: CanvasNodeData[] = images.map((img, index) => {
                        const childId = nanoid();
                        return {
                            id: childId,
                            type: CanvasNodeType.Image,
                            title: `${node.title || t("assets.kinds.image")} #${index + 1}`,
                            position: {
                                x: startX,
                                y: node.position.y + index * (node.height + gap),
                            },
                            width: node.width,
                            height: node.height,
                            metadata: {
                                content: img.content,
                                storageKey: img.storageKey,
                                naturalWidth: img.naturalWidth,
                                naturalHeight: img.naturalHeight,
                                bytes: img.bytes,
                                mimeType: img.mimeType,
                                status: NODE_STATUS_SUCCESS,
                                prompt: node.metadata?.prompt,
                                generationType: node.metadata?.generationType,
                                model: node.metadata?.model,
                                size: node.metadata?.size,
                                quality: node.metadata?.quality,
                                ...(img.seed !== undefined ? { seed: img.seed } : node.metadata?.seed !== undefined ? { seed: node.metadata.seed } : {}),
                                channelId: node.metadata?.channelId,
                                workflowId: node.metadata?.workflowId,
                                effectivePrompt: node.metadata?.effectivePrompt,
                                background: node.metadata?.background,
                            },
                        };
                    });

                    setNodes((prev) => [...prev, ...newNodes]);
                    setSelectedNodeIds(new Set([node.id]));
                    setSelectedConnectionId(null);
                },
            });
        },
        [message, modal, t],
    );

    const handleNodePromptChange = useCallback((nodeId: string, prompt: string) => {
        setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, prompt } } : node)));
    }, []);

    const handleConfigNodeChange = useCallback((nodeId: string, patch: Partial<CanvasNodeData["metadata"]>) => {
        setNodes((prev) => prev.map((node) => (node.id === nodeId ? applyNodeConfigPatch(node, patch) : node)));
    }, []);

    const downloadNodeImage = useCallback(async (node: CanvasNodeData) => {
        if ((node.type !== CanvasNodeType.Image && node.type !== CanvasNodeType.Video && node.type !== CanvasNodeType.Audio) || !node.metadata?.content) return;
        const projectName = safeFileName(currentProject?.title?.trim() || t("canvas.title"));
        const titleOrType = safeFileName(node.title?.trim() || node.type);
        const shortId = node.id.slice(0, 4);
        const ext = node.type === CanvasNodeType.Video ? "mp4" : node.type === CanvasNodeType.Audio ? audioExtension(node.metadata.mimeType) : imageExtension(node.metadata.content);
        const filename = `${projectName}_${titleOrType}_${shortId}.${ext}`;
        const contentUrl = node.metadata.content;

        try {
            if (contentUrl.startsWith("data:")) {
                saveAs(contentUrl, filename);
                return;
            }
            const res = await fetch(contentUrl);
            if (!res.ok) throw new Error("fetch failed");
            const blob = await res.blob();
            saveAs(blob, filename);
        } catch {
            saveAs(contentUrl, filename);
        }
    }, [currentProject?.title, t]);

    const downloadBatchImage = useCallback(async (node: CanvasNodeData, imageId: string) => {
        const image = node.metadata?.images?.find((item) => item.id === imageId);
        if (!image?.content) return;
        const projectName = safeFileName(currentProject?.title?.trim() || t("canvas.title"));
        const titleOrType = safeFileName(node.title?.trim() || "image");
        const shortId = image.id.slice(0, 4);
        const filename = `${projectName}_${titleOrType}_${shortId}.${imageExtension(image.content)}`;
        const contentUrl = image.content;

        try {
            if (contentUrl.startsWith("data:")) {
                saveAs(contentUrl, filename);
                return;
            }
            const res = await fetch(contentUrl);
            if (!res.ok) throw new Error("fetch failed");
            const blob = await res.blob();
            saveAs(blob, filename);
        } catch {
            saveAs(contentUrl, filename);
        }
    }, [currentProject?.title, t]);

    const captureVideoNodeFrame = useCallback(
        async (nodeId: string, position: VideoFramePosition) => {
            setContextMenu(null);
            const node = nodesRef.current.find((item) => item.id === nodeId);
            const video = Array.from(containerRef.current!.querySelectorAll<HTMLVideoElement>("video[data-canvas-video]")).find((item) => item.dataset.canvasVideo === nodeId);
            if (node?.type !== CanvasNodeType.Video || !node.metadata?.content || !video) return message.error(t("canvas.videoFrames.failed"));
            try {
                const image = await uploadImage(await captureVideoFrame(node.metadata.content, position, video.currentTime));
                const size = fitNodeSize(image.width, image.height, VIDEO_NODE_MAX_WIDTH, VIDEO_NODE_MAX_HEIGHT);
                const id = nanoid();
                const x = node.position.x + node.width + 96;
                let y = node.position.y + node.height / 2 - size.height / 2;
                while (nodesRef.current.some((item) => item.id !== node.id && item.position.x < x + size.width && item.position.x + item.width > x && item.position.y < y + size.height && item.position.y + item.height > y)) y += size.height + 24;
                const child: CanvasNodeData = {
                    id,
                    type: CanvasNodeType.Image,
                    title: t(`canvas.videoFrames.${position}Title`, { name: node.title || t("assets.kinds.video") }),
                    position: { x, y },
                    ...size,
                    metadata: imageMetadata(image),
                };
                setNodes((prev) => [...prev, child]);
                setConnections((prev) => [...prev, { id: nanoid(), fromNodeId: node.id, toNodeId: id, kind: "lineage" }]);
                setSelectedNodeIds(new Set([id]));
                setSelectedConnectionId(null);
                setDialogNodeId(id);
                message.success(t("canvas.videoFrames.captured"));
            } catch {
                message.error(t("canvas.videoFrames.failed"));
            }
        },
        [message, t],
    );

    const handleSeparateAudio = useCallback(
        async (node: CanvasNodeData) => {
            if (node.type !== CanvasNodeType.Video || !node.metadata?.content) {
                message.warning(t("canvas.videoAudio.noVideo"));
                return;
            }
            const hideLoading = message.loading(t("canvas.videoAudio.separating"), 0);
            try {
                const wavBlob = await extractAudioFromVideo(node.metadata.content, node.metadata.storageKey);
                const audio = await uploadMediaFile(wavBlob, "audio");
                const spec = NODE_DEFAULT_SIZE[CanvasNodeType.Audio];
                const id = `audio-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
                const x = node.position.x + node.width + 96;
                let y = node.position.y + node.height / 2 - spec.height / 2;
                while (
                    nodesRef.current.some(
                        (item) => item.id !== node.id && item.position.x < x + spec.width && item.position.x + item.width > x && item.position.y < y + spec.height && item.position.y + item.height > y,
                    )
                ) {
                    y += spec.height + 24;
                }
                const titleSuffix = t("canvas.videoAudio.audioSuffix");
                const baseTitle = node.title || t("assets.kinds.video");
                const child: CanvasNodeData = {
                    id,
                    type: CanvasNodeType.Audio,
                    title: `${baseTitle} - ${titleSuffix}`,
                    position: { x, y },
                    width: spec.width,
                    height: spec.height,
                    metadata: audioMetadata(audio),
                };
                setNodes((prev) => [...prev, child]);
                setSelectedNodeIds(new Set([id]));
                setSelectedConnectionId(null);
                setDialogNodeId(id);
                message.success(t("canvas.videoAudio.separated"));
            } catch (error) {
                if (error instanceof Error && error.message === "NO_AUDIO_TRACK") {
                    message.warning(t("canvas.videoAudio.noAudioTrack"));
                } else {
                    message.error(t("canvas.videoAudio.separateFailed"));
                }
            } finally {
                hideLoading();
            }
        },
        [message, t],
    );

    const handleOpenDepthVideoModal = useCallback(
        (node: CanvasNodeData) => {
            setToolbarNodeId(null);
            setHoveredNodeId(null);
            setContextMenu(null);

            if (node.type !== CanvasNodeType.Video || !node.metadata?.content) {
                message.warning(t("canvas.depthVideo.noVideo") || "请选择已包含有效视频的视频节点");
                return;
            }

            setDepthVideoNode(node);
        },
        [message, t],
    );

    const handleExecuteDepthVideo = useCallback(
        async (node: CanvasNodeData, options: { channelId: string; workflowId: string }) => {
            const { channelId, workflowId } = options;
            const channel = effectiveConfig.channels?.find((c) => c.id === channelId) || effectiveConfig.channels?.[0];
            if (!channel) {
                message.error(t("canvas.depthVideo.noChannel") || "未找到可用的 ComfyUI 渠道");
                return;
            }

            const spec = NODE_DEFAULT_SIZE[CanvasNodeType.Video];
            const childId = nanoid();
            const baseTitle = node.title || t("assets.kinds.video");
            const childTitle = `${baseTitle} - ${t("canvas.depthVideo.titleSuffix") || "深度"}`;
            const x = node.position.x + node.width + 96;
            let y = node.position.y;
            while (
                nodesRef.current.some(
                    (item) => item.id !== node.id && item.position.x < x + (node.width || spec.width) && item.position.x + item.width > x && item.position.y < y + (node.height || spec.height) && item.position.y + item.height > y,
                )
            ) {
                y += (node.height || spec.height) + 24;
            }

            const newVideoNode: CanvasNodeData = {
                id: childId,
                type: CanvasNodeType.Video,
                title: childTitle,
                position: { x, y },
                width: node.width || spec.width,
                height: node.height || spec.height,
                metadata: {
                    ...cloneNodeMetadata(node.metadata, node.type),
                    status: NODE_STATUS_LOADING,
                    prompt: "",
                    effectivePrompt: "",
                    channelId,
                    workflowId,
                    videoMode: "omni",
                    content: undefined,
                    storageKey: undefined,
                    jobId: undefined,
                    isTimeout: undefined,
                    errorDetails: undefined,
                },
            };

            const newConnection: CanvasConnection = {
                id: nanoid(),
                fromNodeId: node.id,
                toNodeId: childId,
                kind: "lineage",
            };

            const nextNodes = [...nodesRef.current, newVideoNode];
            const nextConnections = [...connectionsRef.current, newConnection];
            nodesRef.current = nextNodes;
            connectionsRef.current = nextConnections;

            setNodes(nextNodes);
            setConnections(nextConnections);
            setSelectedNodeIds(new Set([childId]));
            setSelectedConnectionId(null);
            focusNode(childId);

            message.loading({ content: t("canvas.depthVideo.converting") || "正在提取视频时序深度...", key: `depth-video-${childId}`, duration: 2 });
            const controller = startGenerationRequest(childId, node.id, childId);

            try {
                const generationConfig: AiConfig = {
                    ...effectiveConfig,
                    videoMode: "omni",
                    channelId,
                    workflowId,
                };

                const videoResult = await requestVideoGeneration(
                    generationConfig,
                    "",
                    [],
                    {
                        signal: controller.signal,
                        videoMode: "omni",
                        referenceVideos: [{ id: node.id, url: node.metadata.content, storageKey: node.metadata.storageKey }],
                        workflowId,
                        channelId,
                        seed: generateRandomSeed(),
                        onProgress: (status, detail) => {
                            if (status === "submitted" && detail?.jobId) {
                                setNodes((prev) => prev.map((item) => (item.id === childId ? { ...item, metadata: { ...item.metadata, jobId: detail.jobId } } : item)));
                            }
                        },
                    },
                );

                const video = await storeGeneratedVideo(videoResult);
                const videoSize = fitNodeSize(video.width || node.width, video.height || node.height, VIDEO_NODE_MAX_WIDTH, VIDEO_NODE_MAX_HEIGHT);
                setNodes((prev) =>
                    prev.map((item) =>
                        item.id === childId
                            ? {
                                  ...item,
                                  width: videoSize.width,
                                  height: videoSize.height,
                                  position: { x: item.position.x + item.width / 2 - videoSize.width / 2, y: item.position.y + item.height / 2 - videoSize.height / 2 },
                                  metadata: {
                                      ...item.metadata,
                                      ...videoMetadata(video),
                                      status: NODE_STATUS_SUCCESS,
                                      jobId: undefined,
                                  },
                              }
                            : item,
                    ),
                );
                message.success({ content: t("canvas.depthVideo.converted") || "深度视频提取完成", key: `depth-video-${childId}` });
            } catch (error) {
                if (controller.signal.aborted) return;
                const errText = error instanceof Error ? error.message : String(error);
                setNodes((prev) =>
                    prev.map((item) =>
                        item.id === childId
                            ? {
                                  ...item,
                                  metadata: {
                                      ...item.metadata,
                                      status: NODE_STATUS_ERROR,
                                      errorDetails: errText,
                                      jobId: undefined,
                                  },
                              }
                            : item,
                    ),
                );
                message.error({ content: errText || (t("canvas.depthVideo.convertFailed") || "深度视频提取失败"), key: `depth-video-${childId}` });
            } finally {
                finishGenerationRequest(childId, node.id, childId);
            }
        },
        [effectiveConfig, focusNode, message, startGenerationRequest, finishGenerationRequest, t],
    );

    const saveNodeAsset = useCallback(
        async (node: CanvasNodeData) => {
            if (node.type === CanvasNodeType.Text) {
                const content = node.metadata?.content?.trim();
                if (!content) return message.error(t("canvas.projectPage.noTextToSave"));
                addAsset({ kind: "text", title: node.metadata?.prompt?.slice(0, 24) || t("canvas.projectPage.canvasText"), coverUrl: "", tags: [], source: "Canvas", data: { content }, metadata: { source: "canvas", nodeId: node.id } });
                message.success(t("common.addedToAssets"));
                return;
            }
            if (node.type === CanvasNodeType.Video) {
                if (!node.metadata?.content) return message.error(t("canvas.projectPage.noVideoToSave"));
                addAsset({
                    kind: "video",
                    title: node.metadata?.prompt?.slice(0, 24) || t("canvas.projectPage.canvasVideo"),
                    coverUrl: "",
                    tags: [],
                    source: "Canvas",
                    data: { url: node.metadata.content, storageKey: node.metadata.storageKey, width: node.width, height: node.height, bytes: node.metadata.bytes || 0, mimeType: node.metadata.mimeType || "video/mp4" },
                    metadata: { source: "canvas", nodeId: node.id, prompt: node.metadata?.prompt },
                });
                message.success(t("common.addedToAssets"));
                return;
            }
            if (node.type === CanvasNodeType.Audio) {
                if (!node.metadata?.content) return message.error(t("canvas.projectPage.noAudioToSave", "没有可保存的音频"));
                addAsset({
                    kind: "audio",
                    title: node.metadata?.prompt?.slice(0, 24) || t("canvas.projectPage.canvasAudio", "画布音频"),
                    coverUrl: "",
                    tags: [],
                    source: "Canvas",
                    data: {
                        url: node.metadata.content,
                        storageKey: node.metadata.storageKey,
                        durationMs: node.metadata.durationMs,
                        bytes: node.metadata.bytes || 0,
                        mimeType: node.metadata.mimeType || "audio/mpeg",
                    },
                    metadata: { source: "canvas", nodeId: node.id, prompt: node.metadata?.prompt },
                });
                message.success(t("common.addedToAssets"));
                return;
            }
            if (!node.metadata?.content) return message.error(t("canvas.projectPage.noImageToSave"));
            const dataUrl = node.metadata.storageKey ? "" : node.metadata.content;
            addAsset({
                kind: "image",
                title: node.metadata?.prompt?.slice(0, 24) || t("canvas.projectPage.canvasImage"),
                coverUrl: node.metadata.content,
                tags: [],
                source: "Canvas",
                data: {
                    dataUrl,
                    storageKey: node.metadata.storageKey,
                    width: node.metadata.naturalWidth || node.width,
                    height: node.metadata.naturalHeight || node.height,
                    bytes: node.metadata.bytes || getDataUrlByteSize(dataUrl),
                    mimeType: node.metadata.mimeType || "image/png",
                },
                metadata: { source: "canvas", nodeId: node.id, prompt: node.metadata?.prompt },
            });
            message.success(t("common.addedToAssets"));
        },
        [addAsset, message, t],
    );

    // 把画布分组里的素材整体收藏成一个「组合资产」：原子素材引用原 storageKey 入库（不复制文件），
    // 组合只记录各自的 id、槽位，以及相对分组的偏移和原始节点尺寸 —— 有这些信息，在别的画布里插入时
    // 才能 1:1 还原原始布局，而不是按默认尺寸重新堆一遍。
    const saveGroupAsset = useCallback(
        async (group: CanvasNodeData) => {
            const members = getGroupResourceNodes(group.id, nodesRef.current);
            let minX = Infinity;
            let minY = Infinity;
            for (const member of members) {
                if (!member.position) continue;
                minX = Math.min(minX, member.position.x);
                minY = Math.min(minY, member.position.y);
            }
            const hasLayout = Number.isFinite(minX) && Number.isFinite(minY);
            const items: BundleItem[] = [];
            // 记录"原始画布节点 id → 入库资产 id"，用来把组内连线映射成组合内部连线。
            const memberNodeIdToAssetId = new Map<string, string>();
            let imageIndex = 0;
            for (const member of members) {
                const meta = member.metadata;
                if (!meta?.content) continue;
                const title = (member.title || t("canvas.projectPage.canvasImage")).slice(0, 24);
                const offset = hasLayout && member.position ? { x: member.position.x - minX, y: member.position.y - minY } : undefined;
                // 原节点尺寸一起存：插入端按它还原，避免按默认尺寸/图片原始分辨率重算把布局撑乱。
                const size = { width: member.width, height: member.height };
                const base = { title, coverUrl: "", tags: [] as string[], source: "Canvas", metadata: { source: "canvas", nodeId: member.id } };
                let assetId: string | undefined;
                if (member.type === CanvasNodeType.Text) {
                    const content = meta.content.trim();
                    if (content) assetId = addAsset({ ...base, kind: "text", data: { content } });
                } else if (member.type === CanvasNodeType.Video) {
                    assetId = addAsset({
                        ...base,
                        kind: "video",
                        data: { url: meta.content, storageKey: meta.storageKey, width: member.width, height: member.height, bytes: meta.bytes || 0, mimeType: meta.mimeType || "video/mp4" },
                    });
                } else if (member.type === CanvasNodeType.Audio) {
                    assetId = addAsset({
                        ...base,
                        kind: "audio",
                        data: { url: meta.content, storageKey: meta.storageKey, durationMs: meta.durationMs, bytes: meta.bytes || 0, mimeType: meta.mimeType || "audio/mpeg" },
                    });
                } else {
                    const rawDataUrl = meta.storageKey ? "" : meta.content;
                    assetId = addAsset({
                        ...base,
                        kind: "image",
                        coverUrl: meta.content,
                        data: {
                            dataUrl: rawDataUrl,
                            storageKey: meta.storageKey,
                            width: meta.naturalWidth || member.width,
                            height: meta.naturalHeight || member.height,
                            bytes: meta.bytes || getDataUrlByteSize(rawDataUrl),
                            mimeType: meta.mimeType || "image/png",
                        },
                    });
                }
                if (!assetId) continue;
                memberNodeIdToAssetId.set(member.id, assetId);
                const slot: BundleSlot = member.type === CanvasNodeType.Image ? (imageIndex === 0 ? "primary" : "reference") : member.type === CanvasNodeType.Audio ? "voice" : "reference";
                items.push({ assetId, slot, order: items.length, position: offset, size });
                if (member.type === CanvasNodeType.Image) imageIndex += 1;
            }
            if (!items.length) return message.error(t("canvas.projectPage.emptyGroupSave"));
            // 只取两端都在本组内的连线，映射成 assetId 之间的连线随组合一起存。
            const memberNodeIds = new Set(memberNodeIdToAssetId.keys());
            const connections: BundleConnection[] = connectionsRef.current
                .filter((conn) => memberNodeIds.has(conn.fromNodeId) && memberNodeIds.has(conn.toNodeId))
                .map((conn) => {
                    const fromAssetId = memberNodeIdToAssetId.get(conn.fromNodeId);
                    const toAssetId = memberNodeIdToAssetId.get(conn.toNodeId);
                    if (!fromAssetId || !toAssetId) return undefined;
                    const mapped: BundleConnection = { fromAssetId, toAssetId, kind: conn.kind };
                    if (conn.slot) mapped.slot = conn.slot;
                    return mapped;
                })
                .filter((conn): conn is BundleConnection => Boolean(conn));
            addAsset({
                kind: "bundle",
                title: (group.title || t("canvas.node.group")).slice(0, 24),
                coverUrl: "",
                tags: [],
                source: "Canvas",
                data: { items, coverAssetId: items[0].assetId, connections: connections.length ? connections : undefined },
                metadata: { source: "canvas", nodeId: group.id },
            });
            message.success(t("common.addedToAssets"));
        },
        [addAsset, message, t],
    );

    const createImageReversePromptNodes = useCallback(
        (node: CanvasNodeData) => {
            if (node.type !== CanvasNodeType.Image || !node.metadata?.content) {
                message.warning(t("canvas.projectPage.emptyReverse"));
                return;
            }

            const gap = 96;
            const textSpec = NODE_DEFAULT_SIZE[CanvasNodeType.Text];
            const configSpec = NODE_DEFAULT_SIZE[CanvasNodeType.Config];
            const centerY = node.position.y + node.height / 2;
            const textNode = {
                ...createCanvasNode(CanvasNodeType.Text, { x: node.position.x + node.width + gap + textSpec.width / 2, y: centerY }, { content: t("canvas.projectPage.reversePreset"), prompt: t("canvas.projectPage.reversePreset"), status: NODE_STATUS_SUCCESS, fontSize: 14 }),
                title: t("canvas.projectPage.reverseTitle"),
            };
            const configNode = {
                ...createCanvasNode(
                    CanvasNodeType.Config,
                    { x: textNode.position.x + textNode.width + gap + configSpec.width / 2, y: centerY },
                    {
                        generationMode: "text",
                        model: effectiveConfig.textModel || effectiveConfig.model || defaultConfig.textModel,
                        count: 1,
                        composerContent: t("canvas.reverseComposer", { imageId: node.id, textId: textNode.id }),
                    },
                ),
                title: t("canvas.projectPage.reverseConfigTitle"),
            };

            setNodes((prev) => [...prev, textNode, configNode]);
            setConnections((prev) => [...prev, { id: nanoid(), fromNodeId: node.id, toNodeId: configNode.id, kind: "input" }, { id: nanoid(), fromNodeId: textNode.id, toNodeId: configNode.id, kind: "input" }]);
            setSelectedNodeIds(new Set([configNode.id]));
            setSelectedConnectionId(null);
            setDialogNodeId(configNode.id);
            setContextMenu(null);
        },
        [effectiveConfig.model, effectiveConfig.textModel, message, t],
    );

    const faceRefineUpstreamImages = useMemo(() => {
        if (!faceRefineNode) return [];
        const directImageNodes = connectionsRef.current
            .filter((conn) => conn.toNodeId === faceRefineNode.id && (conn.kind === "input" || conn.kind === "lineage"))
            .map((conn) => nodesRef.current.find((n) => n.id === conn.fromNodeId))
            .filter((n): n is CanvasNodeData => Boolean(n && n.type === CanvasNodeType.Image && n.metadata?.content));

        const lineageParentNodes = connectionsRef.current
            .filter((conn) => conn.toNodeId === faceRefineNode.id && conn.kind === "lineage")
            .map((conn) => nodesRef.current.find((n) => n.id === conn.fromNodeId))
            .filter((n): n is CanvasNodeData => Boolean(n));

        const parentImageNodes: CanvasNodeData[] = [];
        for (const parent of lineageParentNodes) {
            const imgs = connectionsRef.current
                .filter((conn) => conn.toNodeId === parent.id && (conn.kind === "input" || conn.kind === "lineage"))
                .map((conn) => nodesRef.current.find((n) => n.id === conn.fromNodeId))
                .filter((n): n is CanvasNodeData => Boolean(n && n.type === CanvasNodeType.Image && n.metadata?.content));
            parentImageNodes.push(...imgs);
        }

        const seen = new Set<string>();
        const list: CanvasNodeData[] = [];
        for (const img of [...directImageNodes, ...parentImageNodes]) {
            if (!seen.has(img.id)) {
                seen.add(img.id);
                list.push(img);
            }
        }
        return list;
    }, [faceRefineNode]);

    const handleOpenFaceRefineModal = useCallback(
        (node: CanvasNodeData) => {
            setToolbarNodeId(null);
            setHoveredNodeId(null);
            setContextMenu(null);

            if (node.type !== CanvasNodeType.Video || !node.metadata?.content) {
                message.warning(t("canvas.depthVideo.noVideo"));
                return;
            }

            setFaceRefineNode(node);
        },
        [message, t],
    );

    /** 可做角色参考的图片节点：画布上有内容的图片，按从左到右、从上到下排，符合「按出场顺序选」的直觉。 */
    const videoTimelineCastImages = useMemo(
        () =>
            nodes
                .filter((item) => item.type === CanvasNodeType.Image && Boolean(item.metadata?.content))
                .sort((a, b) => a.position.x - b.position.x || a.position.y - b.position.y),
        [nodes],
    );

    const handleOpenVideoTimeline = useCallback(
        (node: CanvasNodeData) => {
            setToolbarNodeId(null);
            setHoveredNodeId(null);
            setContextMenu(null);
            if (node.type !== CanvasNodeType.Video || !node.metadata?.content) {
                message.warning(t("canvas.videoTimeline.toast.noVideo"));
                return;
            }
            if (!isMediaProcessingSupported()) {
                message.warning(t("canvas.videoTimeline.toast.unsupported"));
                return;
            }
            // 分段链路要把原片片段当参考视频送进去，只有 omni 工作流吃这个槽位；首尾帧工作流会直接拒绝。
            // 与其让用户等一轮生成再看到失败，不如在入口处就讲清楚。
            const workflow = findWorkflow(effectiveConfig, effectiveConfig.channelId, effectiveConfig.workflowId);
            const modelName = (effectiveConfig.videoModel || effectiveConfig.model || "").toLowerCase();
            const frameOnlyWorkflow = workflow?.category === "frameVideo" || modelName.includes("frame") || modelName.includes("首尾帧");
            if (frameOnlyWorkflow) {
                Modal.confirm({
                    title: t("canvas.videoTimeline.channel.title"),
                    content: t("canvas.videoTimeline.channel.body"),
                    okText: t("canvas.videoTimeline.channel.proceed"),
                    cancelText: t("canvas.videoTimeline.channel.cancel"),
                    centered: true,
                    onOk: () => setVideoTimelineNode(node),
                });
                return;
            }
            setVideoTimelineNode(node);
        },
        [effectiveConfig, message, t],
    );

    /** 就地更新节点，同时同步 ref，避免长流程里读到旧快照。 */
    const patchCanvasNode = useCallback((nodeId: string, patch: Partial<CanvasNodeData>) => {
        nodesRef.current = nodesRef.current.map((item) => (item.id === nodeId ? { ...item, ...patch } : item));
        setNodes(nodesRef.current);
    }, [setNodes]);

    const appendCanvasNodes = useCallback(
        (newNodes: CanvasNodeData[], newConnections: CanvasConnection[]) => {
            nodesRef.current = [...nodesRef.current, ...newNodes];
            connectionsRef.current = [...connectionsRef.current, ...newConnections];
            setNodes(nodesRef.current);
            setConnections(connectionsRef.current);
        },
        [setConnections, setNodes],
    );

    /**
     * 分段执行：切分 → 逐段生成 → 合成。
     *
     * 局部重绘与角色替换共用这条链路，差别只在参考图构成：
     * - 局部重绘：参考视频 = 原片该段；参考图 = 该段首帧 + 尾帧（钉住接缝）
     * - 角色替换：参考视频 = 原片该段；参考图 = 角色图 + 该段首尾帧
     */
    const handleVideoEditSubmit = useCallback(
        async (plan: VideoEditPlan) => {
            const source = videoTimelineNode;
            if (!source?.metadata?.content) return;
            const sourceUrl = source.metadata.content;
            const sourceTitle = source.title || t("canvas.sidePanel.filter.video");
            const toastKey = `video-edit-${source.id}`;
            const composeKey = `video-compose-${source.id}`;
            const controller = new AbortController();

            setVideoTimelineSubmitting(true);
            const produced: { nodeId: string; blob: Blob; range: VideoRange }[] = [];

            try {
                const sourceBlob = await loadNodeVideoBlob(source);
                const castImages = plan.castNodeIds
                    .map((id) => nodesRef.current.find((item) => item.id === id))
                    .filter((item): item is CanvasNodeData => Boolean(item?.metadata?.content));
                const promptText = plan.prompt || (plan.mode === "repaint" ? t("canvas.videoTimeline.prompt.repaint") : t("canvas.videoTimeline.prompt.character"));
                const config: AiConfig = {
                    ...effectiveConfig,
                    videoMode: "omni",
                    channelId: source.metadata.channelId || effectiveConfig.channelId,
                    workflowId: source.metadata.workflowId || effectiveConfig.workflowId,
                };
                const segmentColumnX = source.position.x + source.width + 96;
                // 逐段串行生成，长片要跑十几分钟。没有进度估算用户只能干等，
                // 只能来问"跑完了吗"，所以从第二段起就给出已用时与预计剩余。
                const startedAt = Date.now();
                const segmentCosts: number[] = [];

                for (let index = 0; index < plan.ranges.length; index += 1) {
                    if (controller.signal.aborted) throw new DOMException("Aborted", "AbortError");
                    const range = plan.ranges[index];
                    const segmentStartedAt = Date.now();
                    if (index > 0 && segmentCosts.length) {
                        const average = segmentCosts.reduce((sum, cost) => sum + cost, 0) / segmentCosts.length;
                        const estimate = t("canvas.videoTimeline.toast.segmentEta", {
                            elapsed: formatDuration(Date.now() - startedAt),
                            remain: formatDuration(Math.round(average * (plan.ranges.length - index))),
                        });
                        message.loading({
                            content: `${t("canvas.videoTimeline.toast.segmentRunning", { index: index + 1, count: plan.ranges.length })} · ${estimate}`,
                            key: toastKey,
                            duration: 0,
                        });
                    } else {
                        message.loading({ content: t("canvas.videoTimeline.toast.segmentRunning", { index: index + 1, count: plan.ranges.length }), key: toastKey, duration: 0 });
                    }

                    const segmentId = nanoid();
                    appendCanvasNodes(
                        [
                            {
                                id: segmentId,
                                type: CanvasNodeType.Video,
                                title: t("canvas.videoTimeline.node.segmentTitle", { title: sourceTitle, index: index + 1 }),
                                position: { x: segmentColumnX, y: source.position.y + index * (source.height + 32) },
                                width: source.width,
                                height: source.height,
                                metadata: {
                                    status: NODE_STATUS_LOADING,
                                    generationMode: "video",
                                    videoMode: "omni",
                                    prompt: promptText,
                                    effectivePrompt: promptText,
                                    channelId: config.channelId,
                                    workflowId: config.workflowId,
                                    seconds: ((range.endMs - range.startMs) / 1000).toFixed(1),
                                    videoSegment: {
                                        sourceNodeId: source.id,
                                        sourceDurationMs: source.metadata.durationMs || undefined,
                                        startMs: range.startMs,
                                        endMs: range.endMs,
                                        index,
                                        sceneStart: range.sceneStart,
                                        mode: plan.mode,
                                        anchor: { firstFrameMs: range.startMs, lastFrameMs: range.endMs },
                                    },
                                },
                            },
                        ],
                        [{ id: nanoid(), fromNodeId: source.id, toNodeId: segmentId, kind: "lineage" }],
                    );

                    try {
                        // 1. 切出这一段：模型吃不了长片，也吃不了整片
                        const segmentBlob = await cutVideoSegment(sourceBlob, range.startMs, range.endMs);
                        const segmentUpload = await uploadMediaFile(segmentBlob, "video");

                        // 2. 参考图：角色在前（模型对靠前的参考更敏感），首尾帧在后钉住接缝
                        const referenceImages: ReferenceImage[] = castImages.map((castNode) => ({
                            id: castNode.id,
                            name: `${castNode.title || "cast"}.png`,
                            type: "image/png",
                            dataUrl: castNode.metadata?.content || "",
                            url: castNode.metadata?.content || "",
                        }));
                        // 传 signal：不传的话点取消后抽帧还在跑，且元数据加载没有超时兜底。
                        const headFrame = await captureFrameDataUrl(sourceUrl, range.startMs, { width: 960, signal: controller.signal });
                        const tailFrame = await captureFrameDataUrl(sourceUrl, Math.max(range.startMs, range.endMs - 34), { width: 960, signal: controller.signal });
                        referenceImages.push(
                            { id: `head-${segmentId}`, name: "segment_start.jpg", type: "image/jpeg", dataUrl: headFrame, url: headFrame },
                            { id: `tail-${segmentId}`, name: "segment_end.jpg", type: "image/jpeg", dataUrl: tailFrame, url: tailFrame },
                        );

                        // 3. 生成：参考视频给内容与节奏，首尾帧给接缝，角色图给外观
                        const result = await requestVideoGeneration(config, promptText, referenceImages, {
                            signal: controller.signal,
                            videoMode: "omni",
                            referenceVideos: [{ id: segmentId, name: `segment_${index + 1}.mp4`, type: "video/mp4", url: segmentUpload.url, storageKey: segmentUpload.storageKey, durationMs: segmentUpload.durationMs }],
                            seed: generateRandomSeed(),
                            onProgress: (status, detail) => {
                                if (status === "submitted" && detail?.jobId) patchCanvasNode(segmentId, { metadata: { ...nodesRef.current.find((item) => item.id === segmentId)?.metadata, jobId: detail.jobId } });
                            },
                        });
                        const video = await storeGeneratedVideo(result);
                        const storedBlob = video.storageKey ? await getMediaBlob(video.storageKey) : null;
                        const videoBlob = storedBlob ?? (await (await fetch(video.url)).blob());
                        produced.push({ nodeId: segmentId, blob: videoBlob, range });
                        segmentCosts.push(Date.now() - segmentStartedAt);

                        const videoSize = fitNodeSize(video.width || source.width, video.height || source.height, VIDEO_NODE_MAX_WIDTH, VIDEO_NODE_MAX_HEIGHT);
                        const currentNode = nodesRef.current.find((item) => item.id === segmentId);
                        const sizePatch: Partial<CanvasNodeData> = { width: videoSize.width, height: videoSize.height };
                        if (currentNode) sizePatch.position = { x: currentNode.position.x + currentNode.width / 2 - videoSize.width / 2, y: currentNode.position.y };
                        patchCanvasNode(segmentId, {
                            ...sizePatch,
                            metadata: { ...currentNode?.metadata, ...videoMetadata(video), status: NODE_STATUS_SUCCESS, prompt: promptText, effectivePrompt: promptText, errorDetails: undefined, jobId: undefined, isTimeout: undefined },
                        });
                        message.loading({ content: t("canvas.videoTimeline.toast.segmentDone", { index: index + 1, count: plan.ranges.length }), key: toastKey, duration: 1.2 });
                    } catch (error) {
                        if (isGenerationCanceled(error)) throw error;
                        const errorDetails = error instanceof Error ? error.message : t("canvas.videoTimeline.toast.cutFailed", { error: "" });
                        const currentNode = nodesRef.current.find((item) => item.id === segmentId);
                        patchCanvasNode(segmentId, { metadata: { ...currentNode?.metadata, status: NODE_STATUS_ERROR, errorDetails } });
                        message.error({ content: t("canvas.videoTimeline.toast.segmentFailed", { index: index + 1, error: errorDetails }), key: toastKey });
                        // 一段失败就停：继续只会产出一堆接不上的碎片。
                        // 但必须说清楚"到哪为止、成片有没有"，否则用户只看到一条红色报错，
                        // 不知道那些已经出画面的段还算不算数。
                        message.warning({
                            content: t("canvas.videoTimeline.toast.stoppedAfterFailure", { done: produced.length, count: plan.ranges.length }),
                            key: composeKey,
                            duration: 8,
                        });
                        break;
                    }
                }

                if (produced.length === plan.ranges.length && produced.length > 0) {
                    message.loading({ content: t("canvas.videoTimeline.toast.composing"), key: composeKey, duration: 0 });

                    // 局部重绘的成片 = 保留的原画头 + 重绘段 + 保留的原画尾。
                    // 只拼重绘段的话，用户拿到的是"10–15 秒那 5 秒"，不是他要的整条片子。
                    const parts: ConcatPart[] = [];
                    const rangeStart = plan.ranges[0].startMs;
                    const rangeEnd = plan.ranges[plan.ranges.length - 1].endMs;
                    if (plan.mode === "repaint" && rangeStart > 60) {
                        parts.push({ blob: await cutVideoSegment(sourceBlob, 0, rangeStart), sceneStart: true });
                    }
                    produced.forEach((part) => parts.push({ blob: part.blob, sceneStart: part.range.sceneStart }));
                    if (plan.mode === "repaint" && plan.durationMs - rangeEnd > 60) {
                        // 尾段起点正好是原片的场景切点时不做淡化，那里本来就没有连续性。
                        parts.push({ blob: await cutVideoSegment(sourceBlob, rangeEnd, plan.durationMs), sceneStart: plan.endAtCut });
                    }

                    const merged = await concatVideoParts(parts, {
                        crossfadeFrames: plan.crossfadeFrames,
                        audio: plan.keepAudio ? sourceBlob : null,
                        signal: controller.signal,
                        onProgress: (ratio) => {
                            message.loading({ content: `${t("canvas.videoTimeline.toast.composing")} ${Math.round(ratio * 100)}%`, key: composeKey, duration: 0 });
                        },
                    });
                    const uploaded = await uploadMediaFile(merged, "video");
                    // 成片时长对不上原片，说明保留段或拼接算错了。静默产出一个短片
                    // 比直接报错更糟 —— 用户会拿去用，等导出时才发现少了几秒。
                    const mergedDurationMs = await probeVideo(merged)
                        .then((probe) => probe.durationMs)
                        .catch(() => null);
                    if (mergedDurationMs && plan.durationMs > 0 && Math.abs(mergedDurationMs - plan.durationMs) > 500) {
                        message.warning({
                            content: t("canvas.videoTimeline.toast.durationMismatch", {
                                expected: formatDuration(plan.durationMs),
                                actual: formatDuration(mergedDurationMs),
                            }),
                            duration: 8,
                        });
                    }
                    const compositeId = nanoid();
                    appendCanvasNodes(
                        [
                            {
                                id: compositeId,
                                type: CanvasNodeType.Video,
                                title: t("canvas.videoTimeline.node.compositeTitle", { title: sourceTitle }),
                                position: { x: segmentColumnX + source.width + 96, y: source.position.y },
                                width: source.width,
                                height: source.height,
                                metadata: {
                                    ...videoMetadata(uploaded),
                                    prompt: promptText,
                                    effectivePrompt: promptText,
                                    videoComposite: {
                                        partNodeIds: produced.map((part) => part.nodeId),
                                        crossfadeMs: Math.round((plan.crossfadeFrames / 30) * 1000),
                                        sourceNodeId: source.id,
                                    },
                                },
                            },
                        ],
                        produced.map((part) => ({ id: nanoid(), fromNodeId: part.nodeId, toNodeId: compositeId, kind: "lineage" as const })),
                    );
                    message.success({ content: t("canvas.videoTimeline.toast.composed"), key: composeKey });
                }
                setVideoTimelineNode(null);
            } catch (error) {
                if (isGenerationCanceled(error)) {
                    message.info({ content: t("canvas.videoTimeline.toast.cancelled"), key: toastKey });
                } else {
                    const errorDetails = error instanceof Error ? error.message : String(error);
                    message.error({ content: t("canvas.videoTimeline.toast.composeFailed", { error: errorDetails }), key: composeKey });
                }
            } finally {
                setVideoTimelineSubmitting(false);
            }
        },
        [appendCanvasNodes, effectiveConfig, isGenerationCanceled, message, patchCanvasNode, t, videoTimelineNode],
    );

    const handleExecuteFaceRefine = useCallback(
        async (node: CanvasNodeData, options: { channelId: string; workflowId: string; prompt: string }) => {
            const { channelId, workflowId, prompt } = options;

            // 1. 直连到当前视频节点的图片节点
            const directImageNodes = connectionsRef.current
                .filter((conn) => conn.toNodeId === node.id && (conn.kind === "input" || conn.kind === "lineage"))
                .map((conn) => nodesRef.current.find((n) => n.id === conn.fromNodeId))
                .filter((n): n is CanvasNodeData => Boolean(n && n.type === CanvasNodeType.Image && n.metadata?.content));

            // 2. 当前视频的上游来源节点（如生成该视频的 ConfigNode）所连接的图片节点
            const lineageParentNodes = connectionsRef.current
                .filter((conn) => conn.toNodeId === node.id && conn.kind === "lineage")
                .map((conn) => nodesRef.current.find((n) => n.id === conn.fromNodeId))
                .filter((n): n is CanvasNodeData => Boolean(n));

            const parentImageNodes: CanvasNodeData[] = [];
            for (const parent of lineageParentNodes) {
                const imgs = connectionsRef.current
                    .filter((conn) => conn.toNodeId === parent.id && (conn.kind === "input" || conn.kind === "lineage"))
                    .map((conn) => nodesRef.current.find((n) => n.id === conn.fromNodeId))
                    .filter((n): n is CanvasNodeData => Boolean(n && n.type === CanvasNodeType.Image && n.metadata?.content));
                parentImageNodes.push(...imgs);
            }

            // 合并去重图片节点
            const seenImageNodeIds = new Set<string>();
            const upstreamImageNodes: CanvasNodeData[] = [];
            for (const img of [...directImageNodes, ...parentImageNodes]) {
                if (!seenImageNodeIds.has(img.id)) {
                    seenImageNodeIds.add(img.id);
                    upstreamImageNodes.push(img);
                }
            }

            const metadataReferences = Array.isArray(node.metadata?.references) ? node.metadata.references : [];
            const hasReferences = upstreamImageNodes.length > 0 || metadataReferences.length > 0;
            const isComplete = Boolean(hasReferences && prompt);

            const childId = nanoid();
            const childTitle = t("canvas.faceRefine.childTitle", { title: node.title || t("canvas.sidePanel.filter.video") });
            const childPos = { x: node.position.x + node.width + 96, y: node.position.y };

            const newVideoNode: CanvasNodeData = {
                id: childId,
                type: CanvasNodeType.Video,
                title: childTitle,
                position: childPos,
                width: node.width,
                height: node.height,
                metadata: {
                    ...cloneNodeMetadata(node.metadata, node.type),
                    status: isComplete ? NODE_STATUS_LOADING : undefined,
                    prompt,
                    effectivePrompt: prompt,
                    channelId,
                    workflowId,
                    videoMode: "omni",
                    content: undefined,
                    storageKey: undefined,
                    jobId: undefined,
                    isTimeout: undefined,
                    errorDetails: undefined,
                },
            };

            const newConnections: CanvasConnection[] = [
                { id: nanoid(), fromNodeId: node.id, toNodeId: childId, kind: "input" },
            ];
            for (const imgNode of upstreamImageNodes) {
                newConnections.push({ id: nanoid(), fromNodeId: imgNode.id, toNodeId: childId, kind: "input" });
            }

            const nextNodes = [...nodesRef.current, newVideoNode];
            const nextConnections = [...connectionsRef.current, ...newConnections];
            nodesRef.current = nextNodes;
            connectionsRef.current = nextConnections;

            setNodes(nextNodes);
            setConnections(nextConnections);
            setSelectedNodeIds(new Set([childId]));
            setSelectedConnectionId(null);
            focusNode(childId);

            if (!isComplete) {
                if (!prompt && !hasReferences) {
                    message.info(t("canvas.faceRefine.needReferenceAndPrompt"));
                } else if (!hasReferences) {
                    message.info(t("canvas.faceRefine.needReference"));
                } else {
                    message.info(t("canvas.faceRefine.needPrompt"));
                }
                setDialogNodeId(childId);
                return;
            }

            message.loading({ content: t("canvas.faceRefine.submitting"), key: `face-refine-${childId}`, duration: 2 });
            const controller = startGenerationRequest(childId, node.id, childId);
            try {
                let referenceImages: ReferenceImage[] = [];
                if (upstreamImageNodes.length > 0) {
                    referenceImages = upstreamImageNodes.map((imgNode) => ({
                        id: imgNode.id,
                        name: imgNode.title || "image.png",
                        type: "image/png",
                        width: imgNode.width,
                        height: imgNode.height,
                        dataUrl: imgNode.metadata?.content || "",
                        url: imgNode.metadata?.content || "",
                    }));
                } else if (metadataReferences.length > 0) {
                    referenceImages = metadataReferences.map((ref: any, idx: number) => ({
                        id: ref?.id || nanoid(),
                        name: ref?.name || `ref_${idx + 1}.png`,
                        type: "image/png",
                        dataUrl: typeof ref === "string" ? ref : ref?.dataUrl || ref?.url || "",
                        url: typeof ref === "string" ? ref : ref?.url || ref?.dataUrl || "",
                    }));
                }

                const generationConfig: AiConfig = {
                    ...effectiveConfig,
                    videoMode: "omni",
                    channelId,
                    workflowId,
                };

                const videoResult = await requestVideoGeneration(
                    generationConfig,
                    prompt,
                    referenceImages,
                    {
                        signal: controller.signal,
                        videoMode: "omni",
                        referenceVideos: [{ id: node.id, url: node.metadata.content }],
                        workflowId,
                        channelId,
                        seed: generateRandomSeed(),
                        onProgress: (status, detail) => {
                            if (status === "submitted" && detail?.jobId) {
                                setNodes((prev) => prev.map((item) => (item.id === childId ? { ...item, metadata: { ...item.metadata, jobId: detail.jobId } } : item)));
                            }
                        },
                    },
                );

                const video = await storeGeneratedVideo(videoResult);
                const videoSize = fitNodeSize(video.width || node.width, video.height || node.height, VIDEO_NODE_MAX_WIDTH, VIDEO_NODE_MAX_HEIGHT);
                setNodes((prev) =>
                    prev.map((item) =>
                        item.id === childId
                            ? {
                                  ...item,
                                  width: videoSize.width,
                                  height: videoSize.height,
                                  position: { x: item.position.x + item.width / 2 - videoSize.width / 2, y: item.position.y + item.height / 2 - videoSize.height / 2 },
                                  metadata: {
                                      ...item.metadata,
                                      ...videoMetadata(video),
                                      status: NODE_STATUS_SUCCESS,
                                      prompt,
                                      effectivePrompt: prompt,
                                      errorDetails: undefined,
                                  },
                              }
                            : item,
                    ),
                );
                message.success({ content: t("canvas.faceRefine.success"), key: `face-refine-${childId}` });
            } catch (error) {
                if (isGenerationCanceled(error)) return;
                const errorDetails = error instanceof Error ? error.message : t("canvas.faceRefine.failed");
                message.error({ content: errorDetails, key: `face-refine-${childId}` });
                setNodes((prev) =>
                    prev.map((item) =>
                        item.id === childId
                            ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_ERROR, errorDetails } }
                            : item,
                    ),
                );
            } finally {
                finishGenerationRequest(childId, controller);
            }
        },
        [effectiveConfig, finishGenerationRequest, focusNode, message, startGenerationRequest],
    );

    const cropImageNode = useCallback(async (node: CanvasNodeData, crop: CanvasImageCropRect) => {
        if (!node.metadata?.content) return;
        const cropped = await cropDataUrl(node.metadata.content, crop);
        const image = await uploadImage(cropped);
        const width = Math.min(node.width, Math.max(220, image.width));
        const childId = nanoid();
        const child: CanvasNodeData = {
            id: childId,
            type: CanvasNodeType.Image,
            title: "Cropped Image",
            position: { x: node.position.x + node.width + 96, y: node.position.y },
            width,
            height: width * (image.height / image.width),
            metadata: {
                ...imageMetadata(image),
                prompt: node.metadata?.prompt,
            },
        };
        setNodes((prev) => [...prev, child]);
        setConnections((prev) => [...prev, { id: nanoid(), fromNodeId: node.id, toNodeId: childId, kind: "lineage" }]);
        setSelectedNodeIds(new Set([childId]));
        setDialogNodeId(childId);
        setCropNodeId(null);
    }, []);

    const splitImageNode = useCallback(
        async (node: CanvasNodeData, params: CanvasImageSplitParams) => {
            if (!node.metadata?.content) return;
            setSplitNodeId(null);
            const pieces = await splitDataUrl(node.metadata.content, params);
            const gap = 16;
            const cellWidth = node.width / params.columns;
            const cellHeight = node.height / params.rows;
            const startX = node.position.x + node.width + 96;
            const startY = node.position.y;
            const childNodes = await Promise.all(
                pieces.map(async (piece) => {
                    const image = await uploadImage(piece.dataUrl);
                    const id = nanoid();
                    return {
                        id,
                        type: CanvasNodeType.Image,
                        title: t("canvas.projectPage.splitTitle", { name: node.title || t("assets.kinds.image"), row: piece.row + 1, column: piece.column + 1 }),
                        position: { x: startX + piece.column * (cellWidth + gap), y: startY + piece.row * (cellHeight + gap) },
                        width: cellWidth,
                        height: cellHeight,
                        metadata: {
                            ...imageMetadata(image),
                            prompt: node.metadata?.prompt,
                        },
                    } satisfies CanvasNodeData;
                }),
            );
            setNodes((prev) => [...prev, ...childNodes]);
            setConnections((prev) => [...prev, ...childNodes.map((child) => ({ id: nanoid(), fromNodeId: node.id, toNodeId: child.id, kind: "lineage" }))]);
            setSelectedNodeIds(new Set(childNodes.map((child) => child.id)));
            setSelectedConnectionId(null);
            setDialogNodeId(null);
            message.success(t("canvas.projectPage.splitSuccess", { count: childNodes.length }));
        },
        [message, t],
    );

    const maskEditImageNode = useCallback(
        async (node: CanvasNodeData, payload: CanvasImageMaskEditPayload) => {
            if (!node.metadata?.content) return;
            const generationConfig = {
                ...buildGenerationConfig(effectiveConfig, node, "image"),
                count: "1",
                size: node.metadata?.size || "auto",
                ...(payload.model ? { model: payload.model, imageModel: payload.model } : {}),
                ...(payload.channelId ? { channelId: payload.channelId } : {}),
                ...(payload.workflowId ? { workflowId: payload.workflowId } : {}),
            };
            if (!isAiConfigReady(generationConfig, generationConfig.model)) {
                openConfigDialog(true);
                return;
            }
            const userPrompt = payload.prompt.trim();
            const prompt = userPrompt;
            const childId = nanoid();
            const source = { id: node.id, name: `${node.title || node.id}.png`, type: node.metadata.mimeType || "image/png", dataUrl: node.metadata.content, storageKey: node.metadata.storageKey };
            const generationMetadata = buildImageGenerationMetadata("edit", generationConfig, 1, [source]);
            setMaskEditNodeId(null);
            setNodes((prev) => [
                ...prev,
                {
                    id: childId,
                    type: CanvasNodeType.Image,
                    title: userPrompt.slice(0, 32) || t("canvas.projectPage.maskResult"),
                    position: { x: node.position.x + node.width + 96, y: node.position.y },
                    width: node.width,
                    height: node.height,
                    metadata: {
                        prompt,
                        status: NODE_STATUS_LOADING,
                        channelId: payload.channelId || node.metadata?.channelId,
                        workflowId: payload.workflowId || node.metadata?.workflowId,
                        ...generationMetadata,
                    },
                },
            ]);
            setConnections((prev) => [...prev, { id: nanoid(), fromNodeId: node.id, toNodeId: childId, kind: "input" }]);
            setSelectedNodeIds(new Set([childId]));
            setSelectedConnectionId(null);
            setDialogNodeId(childId);
            const controller = startGenerationRequest(childId, node.id, childId);
            try {
                const image = await requestEdit(
                    generationConfig,
                    prompt,
                    [source],
                    { id: `${node.id}-mask`, name: "mask.png", type: "image/png", dataUrl: payload.maskDataUrl },
                    {
                        signal: controller.signal,
                        onProgress: (status, detail) => {
                            if (status === "submitted" && detail?.jobId) {
                                setNodes((prev) => prev.map((item) => (item.id === childId ? { ...item, metadata: { ...item.metadata, jobId: detail.jobId } } : item)));
                            }
                        },
                    },
                ).then((items) => items[0]);
                const uploaded = await uploadImage(image.dataUrl);
                const size = fitNodeSize(uploaded.width, uploaded.height, node.width, node.height);
                setNodes((prev) => prev.map((item) => (item.id === childId ? { ...item, width: size.width, height: size.height, metadata: { ...item.metadata, ...imageMetadata(uploaded), prompt, ...generationMetadata } } : item)));
            } catch (error) {
                if (isGenerationCanceled(error)) return;
                const errorDetails = error instanceof Error ? error.message : t("canvas.projectPage.maskFailed");
                message.error(errorDetails);
                setNodes((prev) => prev.map((item) => (item.id === childId ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_ERROR, errorDetails } } : item)));
            } finally {
                finishGenerationRequest(childId, controller);
            }
        },
        [effectiveConfig, finishGenerationRequest, isAiConfigReady, message, openConfigDialog, startGenerationRequest, t],
    );

    const upscaleImageNode = useCallback(async (node: CanvasNodeData, params: CanvasImageUpscaleParams) => {
        if (!node.metadata?.content) return;
        setUpscaleNodeId(null);
        const upscaled = await upscaleDataUrl(node.metadata.content, params);
        const image = await uploadImage(upscaled);
        const size = fitNodeSize(image.width, image.height);
        const childId = nanoid();
        const child: CanvasNodeData = {
            id: childId,
            type: CanvasNodeType.Image,
            title: "Upscaled Image",
            position: { x: node.position.x + node.width + 96, y: node.position.y },
            width: size.width,
            height: size.height,
            metadata: {
                ...imageMetadata(image),
                prompt: node.metadata?.prompt,
            },
        };
        setNodes((prev) => [...prev, child]);
        setConnections((prev) => [...prev, { id: nanoid(), fromNodeId: node.id, toNodeId: childId, kind: "lineage" }]);
        setSelectedNodeIds(new Set([childId]));
        setDialogNodeId(childId);
    }, []);

    const handleFontSizeChange = useCallback((nodeId: string, fontSize: number) => {
        setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, fontSize } } : node)));
    }, []);

    const handleUploadRequest = useCallback((nodeId?: string, position?: Position) => {
        uploadTargetRef.current = { nodeId, position };
        imageInputRef.current?.click();
    }, []);

    const handleImageInputChange = useCallback(
        async (event: ReactChangeEvent<HTMLInputElement>) => {
            const files = Array.from(event.target.files || []).filter(
                (f) => f.type.startsWith("image/") || f.type.startsWith("video/") || isAudioFile(f),
            );
            if (!files.length) {
                uploadTargetRef.current = null;
                event.target.value = "";
                return;
            }

            const target = uploadTargetRef.current;
            const basePosition =
                target?.position ||
                screenToCanvas(
                    (containerRef.current?.getBoundingClientRect().left || 0) + size.width / 2,
                    (containerRef.current?.getBoundingClientRect().top || 0) + size.height / 2,
                );
            const STAGGER = 40; // Offset between multiple imported files.

            // When replacing a target node, use the first file as the replacement and create the rest nearby.
            if (target?.nodeId) {
                const [first, ...rest] = files;

                // Replace the target node with the first file.
                if (isAudioFile(first)) {
                    const audio = await uploadMediaFile(first, "audio");
                    const spec = NODE_DEFAULT_SIZE[CanvasNodeType.Audio];
                    setNodes((prev) =>
                        prev.map((node) =>
                            node.id === target.nodeId
                                ? {
                                      ...node,
                                      type: CanvasNodeType.Audio,
                                      title: first.name,
                                      position: { x: node.position.x + node.width / 2 - spec.width / 2, y: node.position.y + node.height / 2 - spec.height / 2 },
                                      width: spec.width,
                                      height: spec.height,
                                      metadata: { ...node.metadata, ...audioMetadata(audio), errorDetails: undefined },
                                  }
                                : node,
                        ),
                    );
                    setSelectedNodeIds(new Set([target.nodeId]));
                    setSelectedConnectionId(null);
                } else if (first.type.startsWith("video/")) {
                    const video = await uploadMediaFile(first, "video");
                    const nextSize = fitNodeSize(video.width || 1280, video.height || 720, VIDEO_NODE_MAX_WIDTH, VIDEO_NODE_MAX_HEIGHT);
                    setNodes((prev) =>
                        prev.map((node) =>
                            node.id === target.nodeId
                                ? {
                                      ...node,
                                      type: CanvasNodeType.Video,
                                      title: first.name,
                                      position: { x: node.position.x + node.width / 2 - nextSize.width / 2, y: node.position.y + node.height / 2 - nextSize.height / 2 },
                                      width: nextSize.width,
                                      height: nextSize.height,
                                      metadata: { ...node.metadata, ...videoMetadata(video), errorDetails: undefined },
                                  }
                                : node,
                        ),
                    );
                    setSelectedNodeIds(new Set([target.nodeId]));
                    setSelectedConnectionId(null);
                } else {
                    const image = await uploadImage(first);
                    const s = fitNodeSize(image.width, image.height);
                    setNodes((prev) =>
                        prev.map((node) =>
                            node.id === target.nodeId
                                ? {
                                      ...node,
                                      type: CanvasNodeType.Image,
                                      title: first.name,
                                      width: s.width,
                                      height: s.height,
                                      metadata: {
                                          ...node.metadata,
                                          ...imageMetadata(image),
                                          errorDetails: undefined,
                                          freeResize: false,
                                          images: undefined,
                                          generationType: undefined,
                                          model: undefined,
                                          size: undefined,
                                          quality: undefined,
                                          count: undefined,
                                          references: undefined,
                                          primaryImageId: undefined,
                                      },
                                  }
                                : node,
                        ),
                    );
                    setSelectedNodeIds(new Set([target.nodeId]));
                    setSelectedConnectionId(null);
                }

                // Create the remaining files near the target node.
                for (let i = 0; i < rest.length; i++) {
                    const offsetPos = { x: basePosition.x + (i + 1) * STAGGER, y: basePosition.y + (i + 1) * STAGGER };
                    const f = rest[i];
                    if (isAudioFile(f)) {
                        void createAudioFileNode(f, offsetPos);
                    } else if (f.type.startsWith("video/")) {
                        void createVideoFileNode(f, offsetPos);
                    } else {
                        void createImageFileNode(f, offsetPos);
                    }
                }
            } else {
                // Without a replacement target, create all files near the canvas center.
                for (let i = 0; i < files.length; i++) {
                    const offsetPos = { x: basePosition.x + i * STAGGER, y: basePosition.y + i * STAGGER };
                    const f = files[i];
                    if (isAudioFile(f)) {
                        void createAudioFileNode(f, offsetPos);
                    } else if (f.type.startsWith("video/")) {
                        void createVideoFileNode(f, offsetPos);
                    } else {
                        void createImageFileNode(f, offsetPos);
                    }
                }
            }

            uploadTargetRef.current = null;
            event.target.value = "";
        },
        [createAudioFileNode, createImageFileNode, createVideoFileNode, screenToCanvas, size.height, size.width],
    );

    const insertAssistantImage = useCallback(
        async (image: CanvasAssistantImage, targetPosition?: Position) => {
            const resolvedUrl = image.storageKey ? await resolveImageUrl(image.storageKey, image.dataUrl) : image.dataUrl;
            const storedImage = image.storageKey ? { url: resolvedUrl, storageKey: image.storageKey, width: 1, height: 1, bytes: 0, mimeType: "image/png" } : await uploadImage(image.dataUrl);
            const meta = storedImage.width === 1 && storedImage.height === 1 ? await readImageMeta(storedImage.url) : storedImage;
            const config = fitNodeSize(meta.width, meta.height);
            const center = targetPosition ?? screenToCanvas((containerRef.current?.getBoundingClientRect().left || 0) + size.width / 2, (containerRef.current?.getBoundingClientRect().top || 0) + size.height / 2);
            const id = `image-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
            const node: CanvasNodeData = {
                id,
                type: CanvasNodeType.Image,
                title: image.prompt.slice(0, 32) || "Generated Image",
                position: { x: center.x - config.width / 2, y: center.y - config.height / 2 },
                width: config.width,
                height: config.height,
                metadata: { ...imageMetadata({ ...storedImage, url: resolvedUrl, width: meta.width, height: meta.height }), prompt: image.prompt },
            };

            setNodes((prev) => [...prev, node]);
            setSelectedNodeIds(new Set([id]));
            setSelectedConnectionId(null);
            setDialogNodeId(id);
        },
        [screenToCanvas, size.height, size.width],
    );

    const insertAssistantText = useCallback(
        (text: string, title?: string, targetPosition?: Position) => {
            const center = targetPosition ?? screenToCanvas((containerRef.current?.getBoundingClientRect().left || 0) + size.width / 2, (containerRef.current?.getBoundingClientRect().top || 0) + size.height / 2);
            const node = {
                ...createCanvasNode(CanvasNodeType.Text, center, { content: text, status: NODE_STATUS_SUCCESS }),
                title: title || text.slice(0, 32) || "Assistant Text",
            };

            setNodes((prev) => [...prev, node]);
            setSelectedNodeIds(new Set([node.id]));
            setSelectedConnectionId(null);
        },
        [screenToCanvas, size.height, size.width],
    );

    // 把组合资产插入画布：按条目里记录的原节点尺寸与组内偏移 1:1 还原布局，
    // 并按组合内保存的连线关系（assetId 之间）还原画布连线。
    const insertAssetBundle = useCallback(
        async (title: string, entries: BundleEntryPayload[], connections?: BundleConnection[], targetPosition?: Position) => {
            const slotOrder: Record<BundleSlot, number> = { primary: 0, outfit: 1, accessory: 2, voice: 3, reference: 4 };
            const ordered = [...entries].sort((a, b) => slotOrder[a.slot] - slotOrder[b.slot]);
            const center = targetPosition ?? screenToCanvas((containerRef.current?.getBoundingClientRect().left || 0) + size.width / 2, (containerRef.current?.getBoundingClientRect().top || 0) + size.height / 2);

            const created: { node: CanvasNodeData; slot: BundleSlot; position?: { x: number; y: number } }[] = [];
            // 记录"原子资产 id → 新画布节点 id"，用于把组合里保存的组内连线还原成画布连线。
            const assetIdToNewNodeId = new Map<string, string>();
            for (const entry of ordered) {
                const payload = entry.payload;
                const nodeTitle = payload.title.slice(0, 32) || title;
                let node: CanvasNodeData;
                if (payload.kind === "text") {
                    const spec = NODE_DEFAULT_SIZE[CanvasNodeType.Text];
                    node = { id: nanoid(), type: CanvasNodeType.Text, title: nodeTitle, position: { x: 0, y: 0 }, width: spec.width, height: spec.height, metadata: { content: payload.content, status: NODE_STATUS_SUCCESS } };
                } else if (payload.kind === "image") {
                    const resolvedUrl = payload.storageKey ? await resolveImageUrl(payload.storageKey, payload.dataUrl) : payload.dataUrl;
                    const meta = await readImageMeta(resolvedUrl);
                    const config = fitNodeSize(meta.width, meta.height);
                    node = {
                        id: nanoid(),
                        type: CanvasNodeType.Image,
                        title: nodeTitle,
                        position: { x: 0, y: 0 },
                        width: config.width,
                        height: config.height,
                        metadata: { content: resolvedUrl, ...(payload.storageKey ? { storageKey: payload.storageKey } : {}), status: NODE_STATUS_SUCCESS, naturalWidth: meta.width, naturalHeight: meta.height, bytes: 0, mimeType: "image/png" },
                    };
                } else if (payload.kind === "video") {
                    const resolvedUrl = payload.storageKey ? await resolveMediaUrl(payload.storageKey, payload.url) : payload.url;
                    const spec = NODE_DEFAULT_SIZE[CanvasNodeType.Video];
                    const config = fitNodeSize(payload.width || spec.width, payload.height || spec.height, VIDEO_NODE_MAX_WIDTH, VIDEO_NODE_MAX_HEIGHT);
                    node = {
                        id: nanoid(),
                        type: CanvasNodeType.Video,
                        title: nodeTitle,
                        position: { x: 0, y: 0 },
                        width: config.width,
                        height: config.height,
                        metadata: { content: resolvedUrl, storageKey: payload.storageKey, status: NODE_STATUS_SUCCESS, naturalWidth: payload.width, naturalHeight: payload.height },
                    };
                } else {
                    const resolvedUrl = payload.storageKey ? await resolveMediaUrl(payload.storageKey, payload.url) : payload.url;
                    const spec = NODE_DEFAULT_SIZE[CanvasNodeType.Audio];
                    node = {
                        id: nanoid(),
                        type: CanvasNodeType.Audio,
                        title: nodeTitle,
                        position: { x: 0, y: 0 },
                        width: spec.width,
                        height: spec.height,
                        metadata: audioMetadata({ url: resolvedUrl, storageKey: payload.storageKey || "", bytes: 0, mimeType: "audio/mpeg", durationMs: payload.durationMs }),
                    };
                }
                // 存组合时记录过原节点尺寸就原样还原：相对布局是按原尺寸算的，重算会把紧凑排布撑成堆叠。
                if (entry.size?.width && entry.size?.height) {
                    node = { ...node, width: entry.size.width, height: entry.size.height };
                }
                created.push({ node, slot: entry.slot, position: entry.position });
                assetIdToNewNodeId.set(entry.assetId, node.id);
            }
            if (!created.length) return;

            const hasLayout = created.some((item) => item.position);
            let placed: CanvasNodeData[];
            if (hasLayout) {
                // 按组合内记录的偏移还原相对布局，并整体居中到放置点。
                // 包围盒只用"记录了坐标"的条目算（旧数据条目没有 position，参与计算会把锚点撑歪）；
                // 没坐标的条目在还原出的布局下方另起一行横排，不挤进布局里。
                let minX = Infinity;
                let minY = Infinity;
                let maxX = -Infinity;
                let maxY = -Infinity;
                created.forEach((item, index) => {
                    const offset = item.position;
                    if (!offset) return;
                    minX = Math.min(minX, offset.x);
                    minY = Math.min(minY, offset.y);
                    maxX = Math.max(maxX, offset.x + created[index].node.width);
                    maxY = Math.max(maxY, offset.y + created[index].node.height);
                });
                const boundingWidth = Math.max(maxX - minX, 1);
                const boundingHeight = Math.max(maxY - minY, 1);
                const anchorX = center.x - boundingWidth / 2;
                const anchorY = center.y - boundingHeight / 2;
                const looseGap = 32;
                const looseNodes = created.filter((item) => !item.position);
                const looseTotalWidth = looseNodes.reduce((sum, item) => sum + item.node.width, 0) + looseGap * Math.max(0, looseNodes.length - 1);
                let looseCursor = anchorX + boundingWidth / 2 - looseTotalWidth / 2;
                const looseRowY = anchorY + boundingHeight + looseGap;
                placed = created.map((item) => {
                    const offset = item.position;
                    if (!offset) {
                        const looseNode = { ...item.node, position: { x: looseCursor, y: looseRowY } };
                        looseCursor += item.node.width + looseGap;
                        return looseNode;
                    }
                    return { ...item.node, position: { x: anchorX + (offset.x - minX), y: anchorY + (offset.y - minY) } };
                });
            } else {
                const gap = 32;
                const totalWidth = created.reduce((sum, item) => sum + item.node.width, 0) + gap * (created.length - 1);
                let cursor = center.x - totalWidth / 2;
                placed = created.map((item) => {
                    const positioned = { ...item.node, position: { x: cursor, y: center.y - item.node.height / 2 } };
                    cursor += item.node.width + gap;
                    return positioned;
                });
            }

            // 优先还原组合里保存的组内连线（assetId 之间），让新画布 1:1 复刻原布局的接法；
            // 老组合没有 connections 数据时，退回"主图作枢纽、其余汇入"的兼容逻辑。
            let nextConnections: CanvasConnection[];
            if (connections && connections.length) {
                nextConnections = connections
                    .map((conn) => {
                        const fromNodeId = assetIdToNewNodeId.get(conn.fromAssetId);
                        const toNodeId = assetIdToNewNodeId.get(conn.toAssetId);
                        if (!fromNodeId || !toNodeId) return undefined;
                        const restored: CanvasConnection = { id: nanoid(), fromNodeId, toNodeId, kind: conn.kind };
                        if (conn.slot) restored.slot = conn.slot;
                        return restored;
                    })
                    .filter((conn): conn is CanvasConnection => Boolean(conn));
            } else {
                const hub = placed[created.findIndex((item) => item.slot === "primary")] ?? placed[0];
                const videoNode = placed.find((node) => node.type === CanvasNodeType.Video);
                nextConnections = placed
                    .filter((node) => node.id !== hub.id)
                    .map((node) => {
                        const target = node.type === CanvasNodeType.Audio && videoNode ? videoNode : hub;
                        return { id: nanoid(), fromNodeId: node.id, toNodeId: target.id, kind: "input" as const };
                    });
            }

            setNodes((prev) => [...prev, ...placed]);
            if (nextConnections.length) setConnections((prev) => [...prev, ...nextConnections]);
            setSelectedNodeIds(new Set(placed.map((node) => node.id)));
            setSelectedConnectionId(null);
        },
        [screenToCanvas, size.height, size.width],
    );

    const handleAssetInsert = useCallback(
        async (payload: InsertAssetPayload, targetPosition?: Position) => {
            if (payload.kind === "bundle") {
                await insertAssetBundle(payload.title, payload.entries, payload.connections, targetPosition);
                setAssetPickerOpen(false);
                return;
            }
            if (payload.kind === "text") {
                insertAssistantText(payload.content, payload.title, targetPosition);
            } else if (payload.kind === "video") {
                const resolvedUrl = payload.storageKey ? await resolveMediaUrl(payload.storageKey, payload.url) : payload.url;
                const spec = NODE_DEFAULT_SIZE[CanvasNodeType.Video];
                const center = targetPosition ?? screenToCanvas((containerRef.current?.getBoundingClientRect().left || 0) + size.width / 2, (containerRef.current?.getBoundingClientRect().top || 0) + size.height / 2);
                const id = `video-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
                const nextSize = fitNodeSize(payload.width || spec.width, payload.height || spec.height, VIDEO_NODE_MAX_WIDTH, VIDEO_NODE_MAX_HEIGHT);
                setNodes((prev) => [
                    ...prev,
                    {
                        id,
                        type: CanvasNodeType.Video,
                        title: payload.title,
                        position: { x: center.x - nextSize.width / 2, y: center.y - nextSize.height / 2 },
                        width: nextSize.width,
                        height: nextSize.height,
                        metadata: { content: resolvedUrl, storageKey: payload.storageKey, status: NODE_STATUS_SUCCESS, naturalWidth: payload.width, naturalHeight: payload.height },
                    },
                ]);
                setSelectedNodeIds(new Set([id]));
                setSelectedConnectionId(null);
                setDialogNodeId(id);
            } else if (payload.kind === "audio") {
                const resolvedUrl = payload.storageKey ? await resolveMediaUrl(payload.storageKey, payload.url) : payload.url;
                const spec = NODE_DEFAULT_SIZE[CanvasNodeType.Audio];
                const center = targetPosition ?? screenToCanvas((containerRef.current?.getBoundingClientRect().left || 0) + size.width / 2, (containerRef.current?.getBoundingClientRect().top || 0) + size.height / 2);
                const id = `audio-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
                setNodes((prev) => [
                    ...prev,
                    {
                        id,
                        type: CanvasNodeType.Audio,
                        title: payload.title,
                        position: { x: center.x - spec.width / 2, y: center.y - spec.height / 2 },
                        width: spec.width,
                        height: spec.height,
                        metadata: audioMetadata({
                            url: resolvedUrl,
                            storageKey: payload.storageKey || "",
                            bytes: 0,
                            mimeType: "audio/mpeg",
                            durationMs: payload.durationMs,
                        }),
                    },
                ]);
                setSelectedNodeIds(new Set([id]));
                setSelectedConnectionId(null);
                setDialogNodeId(id);
            } else {
                await insertAssistantImage({ id: `asset-${Date.now()}`, prompt: payload.title, dataUrl: payload.dataUrl, storageKey: payload.storageKey }, targetPosition);
            }
            setAssetPickerOpen(false);
        },
        [insertAssetBundle, insertAssistantImage, insertAssistantText, screenToCanvas, size.height, size.width],
    );

    const handleDrop = useCallback(
        (event: ReactDragEvent<HTMLDivElement>) => {
            event.preventDefault();
            const assetJson = event.dataTransfer.getData("application/infinite-canvas-asset");
            if (assetJson) {
                try {
                    const raw = JSON.parse(assetJson);
                    const payload: InsertAssetPayload =
                        raw.kind === "image" && raw.data
                            ? { kind: "image", dataUrl: raw.data.dataUrl, storageKey: raw.data.storageKey, title: raw.title }
                            : raw.kind === "video" && raw.data
                              ? { kind: "video", url: raw.data.url, storageKey: raw.data.storageKey, title: raw.title, width: raw.data.width, height: raw.data.height }
                              : raw.kind === "audio" && raw.data
                                ? { kind: "audio", url: raw.data.url, storageKey: raw.data.storageKey, title: raw.title, durationMs: raw.data.durationMs }
                                : raw.kind === "text" && raw.data
                                  ? { kind: "text", content: raw.data.content, title: raw.title }
                                  : (raw as InsertAssetPayload);
                    const dropPos = screenToCanvas(event.clientX, event.clientY);
                    void handleAssetInsert(payload, dropPos);
                    return;
                } catch (e) {
                    console.error("Failed to parse dropped asset:", e);
                }
            }

            const files = Array.from(event.dataTransfer.files).filter(
                (item) => item.type.startsWith("image/") || item.type.startsWith("video/") || isAudioFile(item),
            );
            if (!files.length) return;

            const basePos = screenToCanvas(event.clientX, event.clientY);
            const STAGGER = 40;
            for (let i = 0; i < files.length; i++) {
                const pos = { x: basePos.x + i * STAGGER, y: basePos.y + i * STAGGER };
                const f = files[i];
                if (isAudioFile(f)) {
                    void createAudioFileNode(f, pos);
                } else if (f.type.startsWith("video/")) {
                    void createVideoFileNode(f, pos);
                } else {
                    void createImageFileNode(f, pos);
                }
            }
        },
        [createAudioFileNode, createImageFileNode, createVideoFileNode, handleAssetInsert, screenToCanvas],
    );

    const startTitleEditing = useCallback(() => {
        setTitleDraft(currentProject?.title || t("canvas.projectPage.untitledCanvas"));
        setTitleEditing(true);
    }, [currentProject?.title, t]);

    const finishTitleEditing = useCallback(() => {
        const nextTitle = titleDraft.trim();
        if (nextTitle) renameProject(projectId, nextTitle);
        setTitleEditing(false);
    }, [projectId, renameProject, titleDraft]);

    const preventCanvasContextMenu = useCallback((event: ReactMouseEvent) => {
        if ((event.target as HTMLElement).closest("[data-node-id]")) return;
        event.preventDefault();
        setContextMenu(null);
    }, []);

    const handleGenerateNode = useCallback(
        async (nodeId: string, mode: CanvasNodeGenerationMode, submittedPrompt: string, intent: CanvasGenerationIntent = "new") => {
            if (isViewerRef.current) {
                message.warning(t("canvas.collabWatchMode.warnOwnerOnly"));
                return;
            }
            const sourceNode = nodesRef.current.find((node) => node.id === nodeId);
            const prompt = intent === "repeat" ? (submittedPrompt.trim() || sourceNode?.metadata?.prompt || "") : submittedPrompt;
            const generationConfig = buildGenerationConfig(effectiveConfig, sourceNode, mode);
            if (!isAiConfigReady(generationConfig, generationConfig.model)) {
                openConfigDialog(true);
                return;
            }

            const previousSeed = sourceNode?.metadata?.seed ?? sourceNode?.metadata?.images?.[0]?.seed;
            const nextSeed = generateNextSeed(previousSeed, mode === "video" ? 1_000_000_000 : 9007199254740991);

            // useBuiltinPanel.writeBackToSelf reuses built-in generation while writing the result back to the plugin node.
            // Image mode currently supports display-only nodes such as panoramas, with a useBuiltinPanel.promptPrefix.
            const builtinPanel = sourceNode ? getNodeDefinition(sourceNode.type)?.useBuiltinPanel : undefined;
            if (sourceNode && builtinPanel?.writeBackToSelf && builtinPanel.mode === "image") {
                const scene = prompt.trim();
                if (!scene) return;
                const controller = startGenerationRequest(nodeId, nodeId, nodeId);
                setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, prompt: scene, status: NODE_STATUS_LOADING, errorDetails: undefined, seed: nextSeed } } : node)));
                try {
                    const fullPrompt = (builtinPanel.promptPrefix || "") + scene;
                    const context = await hydrateNodeGenerationContext(buildNodeGenerationContext(nodeId, nodesRef.current, connectionsRef.current, fullPrompt));
                    const refs = context.referenceImages;
                    const onProgress = (status: string, detail?: { jobId?: string }) => {
                        if (status === "submitted" && detail?.jobId) {
                            setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, jobId: detail.jobId } } : node)));
                        }
                    };
                    const image = refs.length
                        ? await requestEdit({ ...generationConfig, count: "1" }, context.prompt, refs, undefined, { signal: controller.signal, seed: nextSeed, onProgress }).then((items) => items[0])
                        : await requestGeneration({ ...generationConfig, count: "1" }, context.prompt, { signal: controller.signal, seed: nextSeed, onProgress }).then((items) => items[0]);
                    const uploaded = await uploadImage(image.dataUrl);
                    setNodes((prev) =>
                        prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, ...imageMetadata(uploaded), prompt: scene, model: generationConfig.model, status: NODE_STATUS_SUCCESS, errorDetails: undefined, seed: image.seed ?? nextSeed } } : node)),
                    );
                    setDialogNodeId(null);
                } catch (error) {
                    if (!isGenerationCanceled(error)) {
                        const errorDetails = error instanceof Error ? error.message : t("canvas.projectPage.generationFailed");
                        message.error(errorDetails);
                        setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, status: NODE_STATUS_ERROR, errorDetails } } : node)));
                    }
                } finally {
                    finishGenerationRequest(nodeId, controller);
                }
                return;
            }

            const runController = startGenerationRequest(nodeId, nodeId, nodeId);
            let generationContext: NodeGenerationContext;
            try {
                generationContext = await hydrateNodeGenerationContext(
                    buildNodeGenerationContext(nodeId, nodesRef.current, connectionsRef.current, prompt),
                );
            } catch (error) {
                message.error(error instanceof Error ? error.message : t("canvas.projectPage.referenceMissing"));
                finishGenerationRequest(nodeId, runController);
                return;
            }
            const effectivePrompt = generationContext.prompt.trim();
            if (runController.signal.aborted) {
                finishGenerationRequest(nodeId, runController);
                return;
            }
            const markSourceStatus = shouldMarkGenerationSourceStatus(sourceNode);
            if (!effectivePrompt && (mode === "text" || mode === "audio")) {
                finishGenerationRequest(nodeId, runController);
                return;
            }
            let pendingChildIds: string[] = [];
            if (markSourceStatus) setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, ...(node.type === CanvasNodeType.Config ? {} : { prompt }), status: NODE_STATUS_LOADING, errorDetails: undefined } } : node)));

            try {
                if (mode === "image") {
                    const count = getGenerationCount(generationConfig.count);
                    const isConfigNode = sourceNode?.type === CanvasNodeType.Config;
                    const isImageNode = sourceNode?.type === CanvasNodeType.Image;
                    const isEmptyImageNode = isImageNode && !sourceNode?.metadata?.content;
                    const referenceImages = generationContext.referenceImages;
                    const generationReferences = generationContext.generationReferences;
                    const generationType = referenceImages.length ? ("edit" as const) : ("generation" as const);
                    const generationMetadata = buildImageGenerationMetadata(generationType, generationConfig, count, referenceImages);
                    const parentConfig = NODE_DEFAULT_SIZE[isConfigNode ? CanvasNodeType.Config : isImageNode ? CanvasNodeType.Image : CanvasNodeType.Text];
                    const imageConfig = NODE_DEFAULT_SIZE[CanvasNodeType.Image];
                    const parentPosition = sourceNode?.position || { x: 0, y: 0 };
                    const rootId = isEmptyImageNode ? nodeId : nanoid();
                    const imageIds = Array.from({ length: count }, () => nanoid());
                    pendingChildIds = [rootId];
                    const isRepeat = intent === "repeat";
                    const rootNode: CanvasNodeData = {
                        id: rootId,
                        type: CanvasNodeType.Image,
                        title: isRepeat && sourceNode?.title ? sourceNode.title : (effectivePrompt.slice(0, 32) || "Generated Image"),
                        position: {
                            x: isEmptyImageNode ? parentPosition.x : parentPosition.x + (sourceNode?.width || parentConfig.width) + 96,
                            y: isEmptyImageNode ? parentPosition.y : isRepeat ? parentPosition.y : parentPosition.y + parentConfig.height / 2 - imageConfig.height / 2,
                        },
                        width: isEmptyImageNode ? sourceNode?.width || imageConfig.width : (isRepeat && sourceNode?.width ? sourceNode.width : imageConfig.width),
                        height: isEmptyImageNode ? sourceNode?.height || imageConfig.height : (isRepeat && sourceNode?.height ? sourceNode.height : imageConfig.height),
                        metadata: {
                            ...(isRepeat && sourceNode?.metadata ? cloneNodeMetadata(sourceNode.metadata, sourceNode.type) : {}),
                            prompt,
                            effectivePrompt,
                            channelId: sourceNode?.metadata?.channelId,
                            workflowId: sourceNode?.metadata?.workflowId,
                            status: NODE_STATUS_LOADING,
                            jobId: undefined,
                            isTimeout: undefined,
                            errorDetails: undefined,
                            seed: nextSeed,
                            images: imageIds.map((id, index) => ({ id, status: NODE_STATUS_LOADING, content: "", storageKey: "", naturalWidth: 0, naturalHeight: 0, bytes: 0, mimeType: "", seed: (nextSeed + index) % 9007199254740991 })),
                            primaryImageId: undefined,
                            content: undefined,
                            storageKey: undefined,
                            naturalWidth: undefined,
                            naturalHeight: undefined,
                            bytes: undefined,
                            mimeType: undefined,
                            ...generationMetadata,
                            generationMode: mode,
                            generationReferences,
                            generationOriginNodeId: sourceNode?.metadata?.generationOriginNodeId || nodeId,
                        },
                    };

                    setNodes((prev) => [
                        ...prev.map((node) =>
                            node.id === nodeId
                                ? isConfigNode
                                    ? {
                                          ...node,
                                          metadata: { ...node.metadata, status: NODE_STATUS_LOADING, errorDetails: undefined },
                                      }
                                    : isEmptyImageNode
                                      ? {
                                            ...node,
                                            position: rootNode.position,
                                            width: rootNode.width,
                                            height: rootNode.height,
                                            title: rootNode.title,
                                            metadata: { ...node.metadata, ...rootNode.metadata, errorDetails: undefined },
                                        }
                                      : isImageNode
                                        ? {
                                              ...node,
                                              metadata: { ...node.metadata, status: NODE_STATUS_SUCCESS, errorDetails: undefined },
                                          }
                                        : {
                                              ...node,
                                              type: CanvasNodeType.Text,
                                              title: prompt.slice(0, 32) || "Prompt",
                                              width: parentConfig.width,
                                              height: parentConfig.height,
                                              metadata: { ...node.metadata, content: prompt, prompt, status: NODE_STATUS_SUCCESS, fontSize: 14, errorDetails: undefined },
                                          }
                                : node,
                        ),
                        ...(isEmptyImageNode ? [] : [rootNode]),
                    ]);
                    if (!isEmptyImageNode) {
                        const nextConnections = buildGeneratedNodeConnections(nodeId, rootId, intent, connectionsRef.current, nodesRef.current);
                        connectionsRef.current = [...connectionsRef.current, ...nextConnections];
                        setConnections((prev) => [...prev, ...nextConnections]);
                    }
                    setSelectedNodeIds(new Set([nodeId]));
                    setSelectedConnectionId(null);
                    setDialogNodeId(nodeId);

                    const controller = rootId === nodeId ? runController : startGenerationRequest(rootId, nodeId, nodeId, runController);
                    let hasSuccess = false;
                    let hasFailure = false;
                    let firstError = "";
                    await Promise.all(
                        imageIds.map(async (imageId, index) => {
                            const slotSeed = (nextSeed + index) % 9007199254740991;
                            try {
                                const image = referenceImages.length
                                    ? await requestEdit({ ...generationConfig, count: "1" }, effectivePrompt, referenceImages, undefined, {
                                          signal: controller.signal,
                                          seed: slotSeed,
                                          onProgress: (status, detail) => {
                                              if (status === "submitted" && detail?.jobId) {
                                                  setNodes((prev) =>
                                                      prev.map((n) =>
                                                          n.id === rootId
                                                              ? {
                                                                    ...n,
                                                                    metadata: {
                                                                        ...n.metadata,
                                                                        ...(count === 1 ? { jobId: detail.jobId, isTimeout: undefined } : {}),
                                                                        images: n.metadata?.images?.map((item) => (item.id === imageId ? { ...item, jobId: detail.jobId, isTimeout: undefined } : item)),
                                                                    },
                                                                }
                                                              : n,
                                                      ),
                                                  );
                                              }
                                          },
                                      }).then((items) => items[0])
                                    : await requestGeneration({ ...generationConfig, count: "1" }, effectivePrompt, {
                                          signal: controller.signal,
                                          seed: slotSeed,
                                          onProgress: (status, detail) => {
                                              if (status === "submitted" && detail?.jobId) {
                                                  setNodes((prev) =>
                                                      prev.map((n) =>
                                                          n.id === rootId
                                                              ? {
                                                                    ...n,
                                                                    metadata: {
                                                                        ...n.metadata,
                                                                        ...(count === 1 ? { jobId: detail.jobId, isTimeout: undefined } : {}),
                                                                        images: n.metadata?.images?.map((item) => (item.id === imageId ? { ...item, jobId: detail.jobId, isTimeout: undefined } : item)),
                                                                    },
                                                                }
                                                              : n,
                                                      ),
                                                  );
                                              }
                                          },
                                      }).then((items) => items[0]);
                                const uploaded = await uploadImage(image.dataUrl);
                                const imageSize = fitNodeSize(uploaded.width, uploaded.height, imageConfig.width, imageConfig.height);
                                const item: CanvasNodeImage = {
                                    id: imageId,
                                    status: NODE_STATUS_SUCCESS,
                                    content: uploaded.url,
                                    storageKey: uploaded.storageKey,
                                    naturalWidth: uploaded.width,
                                    naturalHeight: uploaded.height,
                                    bytes: uploaded.bytes,
                                    mimeType: uploaded.mimeType,
                                    seed: image.seed ?? slotSeed,
                                };
                                setNodes((prev) =>
                                    prev.map((node) => {
                                        if (node.id !== rootId) return node;
                                        const images = node.metadata?.images?.map((image) => (image.id === imageId ? item : image)) || [];
                                        const hasActivePrimary = Boolean(node.metadata?.primaryImageId && images.some((image) => image.id === node.metadata?.primaryImageId && Boolean(image.content)));
                                        if (hasActivePrimary) return { ...node, metadata: { ...node.metadata, images } };
                                        const center = { x: node.position.x + node.width / 2, y: node.position.y + node.height / 2 };
                                        return {
                                            ...node,
                                            position: { x: center.x - imageSize.width / 2, y: center.y - imageSize.height / 2 },
                                            ...imageSize,
                                            metadata: {
                                                ...node.metadata,
                                                content: item.content,
                                                storageKey: item.storageKey,
                                                naturalWidth: item.naturalWidth,
                                                naturalHeight: item.naturalHeight,
                                                bytes: item.bytes,
                                                mimeType: item.mimeType,
                                                images,
                                                primaryImageId: imageId,
                                                seed: image.seed ?? slotSeed,
                                            },
                                        };
                                    }),
                                );
                                hasSuccess = true;
                                if (isConfigNode) setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, status: NODE_STATUS_SUCCESS, errorDetails: undefined, seed: image.seed ?? slotSeed } } : node)));
                                return true;
                            } catch (error) {
                                if (isGenerationCanceled(error)) return false;
                                const errorDetails = error instanceof Error ? error.message : t("canvas.projectPage.generationFailed");
                                const errorJobId = (error as { jobId?: string })?.jobId;
                                const isTimeout = (error as { name?: string })?.name === "ComfyuiTimeoutError" || errorDetails.includes("timeout") || errorDetails.includes("超时");
                                if (!firstError) firstError = errorDetails;
                                hasFailure = true;
                                setNodes((prev) =>
                                    prev.map((node) =>
                                        node.id === rootId
                                            ? {
                                                  ...node,
                                                  metadata: {
                                                      ...node.metadata,
                                                      ...(count === 1 ? { jobId: errorJobId || node.metadata?.jobId, isTimeout: isTimeout ? true : undefined } : {}),
                                                      images: node.metadata?.images?.map((image) =>
                                                          image.id === imageId ? { ...image, status: NODE_STATUS_ERROR, errorDetails, jobId: errorJobId || image.jobId, isTimeout: isTimeout ? true : undefined } : image,
                                                      ),
                                                  },
                                              }
                                            : node,
                                    ),
                                );
                            }
                            return false;
                        }),
                    );
                    if (rootId !== nodeId) finishGenerationRequest(rootId, controller);
                    if (controller.signal.aborted) {
                        setNodes((prev) =>
                            prev.map((node) => {
                                if (node.id !== rootId && node.id !== nodeId) return node;
                                const completedImages = node.metadata?.images?.filter((img) => Boolean(img.content)) || [];
                                const hasCompleted = completedImages.length > 0 || Boolean(node.metadata?.content);
                                const primaryImage = completedImages.find((img) => img.id === node.metadata?.primaryImageId) || completedImages[0];
                                return {
                                    ...node,
                                    metadata: {
                                        ...node.metadata,
                                        status: hasCompleted ? NODE_STATUS_SUCCESS : NODE_STATUS_IDLE,
                                        errorDetails: undefined,
                                        jobId: undefined,
                                        isTimeout: undefined,
                                        ...(hasCompleted && primaryImage && !node.metadata?.content
                                            ? {
                                                  content: primaryImage.content,
                                                  storageKey: primaryImage.storageKey,
                                                  primaryImageId: primaryImage.id,
                                                  naturalWidth: primaryImage.naturalWidth,
                                                  naturalHeight: primaryImage.naturalHeight,
                                                  bytes: primaryImage.bytes,
                                                  mimeType: primaryImage.mimeType,
                                              }
                                            : {}),
                                        images: completedImages.length > 0
                                            ? node.metadata?.images?.map((image) =>
                                                  image.status === NODE_STATUS_LOADING
                                                      ? { ...image, status: NODE_STATUS_IDLE, errorDetails: undefined, jobId: undefined, isTimeout: undefined }
                                                      : image,
                                              )
                                            : undefined,
                                    },
                                };
                            }),
                        );
                        return;
                    }
                    if (hasFailure) {
                        message.error(hasSuccess ? t("canvas.projectPage.partialFailed") : firstError || t("canvas.projectPage.generationFailed"));
                    }
                    setNodes((prev) =>
                        prev.map((node) =>
                            node.id === nodeId && isConfigNode
                                ? { ...node, metadata: { ...node.metadata, status: hasSuccess ? NODE_STATUS_SUCCESS : NODE_STATUS_ERROR, errorDetails: hasSuccess ? undefined : t("canvas.projectPage.generationFailed") } }
                                : node.id === rootId
                                  ? {
                                        ...node,
                                        metadata: {
                                            ...node.metadata,
                                            status: hasSuccess ? NODE_STATUS_SUCCESS : NODE_STATUS_ERROR,
                                            errorDetails: hasSuccess ? (hasFailure ? t("canvas.projectPage.partialFailed") : undefined) : t("canvas.projectPage.allFailed"),
                                            ...(hasSuccess ? { jobId: undefined, isTimeout: undefined } : {}),
                                            ...(hasSuccess && !node.metadata?.content
                                                ? (() => {
                                                      const successfulImage = node.metadata?.images?.find((img) => Boolean(img.content));
                                                      return successfulImage
                                                          ? {
                                                                content: successfulImage.content,
                                                                storageKey: successfulImage.storageKey,
                                                                primaryImageId: successfulImage.id,
                                                                naturalWidth: successfulImage.naturalWidth,
                                                                naturalHeight: successfulImage.naturalHeight,
                                                                bytes: successfulImage.bytes,
                                                                mimeType: successfulImage.mimeType,
                                                            }
                                                          : {};
                                                  })()
                                                : {}),
                                        },
                                    }
                                    : node,
                        ),
                    );
                    return;
                }

                if (mode === "video") {
                    const spec = nodeSizeFromRatio(generationConfig.size, NODE_DEFAULT_SIZE[CanvasNodeType.Video].width, NODE_DEFAULT_SIZE[CanvasNodeType.Video].height) || NODE_DEFAULT_SIZE[CanvasNodeType.Video];
                    const isEmptyVideoNode = sourceNode?.type === CanvasNodeType.Video && !sourceNode.metadata?.content;
                    const videoId = isEmptyVideoNode ? nodeId : nanoid();
                    const parent = sourceNode?.position || { x: 0, y: 0 };
                    const isRepeat = intent === "repeat";
                    const videoNode: CanvasNodeData = {
                        id: videoId,
                        type: CanvasNodeType.Video,
                        title: isRepeat && sourceNode?.title ? sourceNode.title : (effectivePrompt.slice(0, 32) || "Generated Video"),
                        position: isEmptyVideoNode ? sourceNode.position : { x: parent.x + (sourceNode?.width || spec.width) + 96, y: parent.y },
                        width: isEmptyVideoNode ? sourceNode.width : (isRepeat && sourceNode?.width ? sourceNode.width : spec.width),
                        height: isEmptyVideoNode ? sourceNode.height : (isRepeat && sourceNode?.height ? sourceNode.height : spec.height),
                        metadata: {
                            ...(isRepeat && sourceNode?.metadata ? cloneNodeMetadata(sourceNode.metadata, sourceNode.type) : {}),
                            prompt,
                            effectivePrompt,
                            channelId: sourceNode?.metadata?.channelId,
                            workflowId: sourceNode?.metadata?.workflowId,
                            status: NODE_STATUS_LOADING,
                            model: generationConfig.model,
                            size: generationConfig.size,
                            seconds: generationConfig.videoSeconds,
                            videoMode: generationConfig.videoMode,
                            vquality: generationConfig.vquality,
                            generateAudio: generationConfig.videoGenerateAudio,
                            watermark: generationConfig.videoWatermark,
                            references: generationReferenceUrls(generationContext),
                            generationMode: mode,
                            generationReferences: generationContext.generationReferences,
                            generationOriginNodeId: sourceNode?.metadata?.generationOriginNodeId || nodeId,
                            seed: nextSeed,
                            images: undefined,
                            primaryImageId: undefined,
                            texts: undefined,
                            primaryTextId: undefined,
                            content: undefined,
                            storageKey: undefined,
                            jobId: undefined,
                            isTimeout: undefined,
                            errorDetails: undefined,
                        },
                    };
                    pendingChildIds = [videoId];
                    setNodes((prev) =>
                        isEmptyVideoNode
                            ? prev.map((node) => (node.id === nodeId ? { ...node, ...videoNode } : node))
                            : [...prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, status: NODE_STATUS_SUCCESS } } : node)), videoNode],
                    );
                    if (!isEmptyVideoNode) {
                        const nextConnections = buildGeneratedNodeConnections(nodeId, videoId, intent, connectionsRef.current, nodesRef.current);
                        connectionsRef.current = [...connectionsRef.current, ...nextConnections];
                        setConnections((prev) => [...prev, ...nextConnections]);
                    }
                    const controller = startGenerationRequest(videoId, nodeId, nodeId, runController);
                    try {
                        const video = await storeGeneratedVideo(
                            await requestVideoGeneration(generationConfig, effectivePrompt, generationContext.referenceImages, {
                                signal: controller.signal,
                                videoMode: generationConfig.videoMode === "frame" ? "frame" : "omni",
                                firstFrame: generationContext.referenceImages[0],
                                lastFrame: generationContext.referenceImages[1],
                                referenceVideos: generationContext.referenceVideos,
                                referenceAudios: generationContext.referenceAudios,
                                seed: nextSeed,
                                onProgress: (status, detail) => {
                                    if (status === "submitted" && detail?.jobId) {
                                        setNodes((prev) => prev.map((node) => (node.id === videoId ? { ...node, metadata: { ...node.metadata, jobId: detail.jobId } } : node)));
                                    }
                                },
                            }),
                        );
                        const videoSize = fitNodeSize(video.width || spec.width, video.height || spec.height, VIDEO_NODE_MAX_WIDTH, VIDEO_NODE_MAX_HEIGHT);
                        setNodes((prev) =>
                            prev.map((node) =>
                                node.id === videoId
                                    ? {
                                          ...node,
                                          width: videoSize.width,
                                          height: videoSize.height,
                                          position: { x: node.position.x + node.width / 2 - videoSize.width / 2, y: node.position.y + node.height / 2 - videoSize.height / 2 },
                                          metadata: {
                                              ...node.metadata,
                                              ...videoMetadata(video),
                                              prompt,
                                              effectivePrompt,
                                              model: generationConfig.model,
                                              size: generationConfig.size,
                                              seconds: generationConfig.videoSeconds,
                                              videoMode: generationConfig.videoMode,
                                              vquality: generationConfig.vquality,
                                              generateAudio: generationConfig.videoGenerateAudio,
                                              watermark: generationConfig.videoWatermark,
                                              references: generationReferenceUrls(generationContext),
                                              seed: nextSeed,
                                          },
                                      }
                                    : node,
                            ),
                        );
                    } finally {
                        finishGenerationRequest(videoId, controller);
                    }
                    return;
                }

                if (mode === "audio") {
                    const spec = NODE_DEFAULT_SIZE[CanvasNodeType.Audio];
                    const isEmptyAudioNode = sourceNode?.type === CanvasNodeType.Audio && !sourceNode.metadata?.content;
                    const audioId = isEmptyAudioNode ? nodeId : nanoid();
                    const parent = sourceNode?.position || { x: 0, y: 0 };
                    const isRepeat = intent === "repeat";
                    const audioNode: CanvasNodeData = {
                        id: audioId,
                        type: CanvasNodeType.Audio,
                        title: isRepeat && sourceNode?.title ? sourceNode.title : (effectivePrompt.slice(0, 32) || "Generated Audio"),
                        position: isEmptyAudioNode ? sourceNode.position : { x: parent.x + (sourceNode?.width || spec.width) + 96, y: parent.y + ((sourceNode?.height || spec.height) - spec.height) / 2 },
                        width: isEmptyAudioNode ? sourceNode.width : (isRepeat && sourceNode?.width ? sourceNode.width : spec.width),
                        height: isEmptyAudioNode ? sourceNode.height : (isRepeat && sourceNode?.height ? sourceNode.height : spec.height),
                        metadata: {
                            ...(isRepeat && sourceNode?.metadata ? cloneNodeMetadata(sourceNode.metadata, sourceNode.type) : {}),
                            prompt,
                            effectivePrompt,
                            channelId: sourceNode?.metadata?.channelId,
                            workflowId: sourceNode?.metadata?.workflowId,
                            status: NODE_STATUS_LOADING,
                            generationMode: mode,
                            generationReferences: generationContext.generationReferences,
                            generationOriginNodeId: sourceNode?.metadata?.generationOriginNodeId || nodeId,
                            ...buildAudioGenerationMetadata(generationConfig),
                            images: undefined,
                            primaryImageId: undefined,
                            texts: undefined,
                            primaryTextId: undefined,
                            content: undefined,
                            storageKey: undefined,
                            jobId: undefined,
                            isTimeout: undefined,
                            errorDetails: undefined,
                        },
                    };
                    pendingChildIds = [audioId];
                    setNodes((prev) =>
                        isEmptyAudioNode
                            ? prev.map((node) => (node.id === nodeId ? { ...node, ...audioNode } : node))
                            : [...prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, status: NODE_STATUS_SUCCESS } } : node)), audioNode],
                    );
                    if (!isEmptyAudioNode) {
                        const nextConnections = buildGeneratedNodeConnections(nodeId, audioId, intent, connectionsRef.current, nodesRef.current);
                        connectionsRef.current = [...connectionsRef.current, ...nextConnections];
                        setConnections((prev) => [...prev, ...nextConnections]);
                    }
                    const controller = startGenerationRequest(audioId, nodeId, nodeId, runController);
                    try {
                        const duration = Number(sourceNode?.metadata?.seconds || generationConfig.audioSeconds) || 60;
                        const initialSeed = sourceNode?.metadata?.seed;
                        const result = await requestAudioGeneration(generationConfig, effectivePrompt, {
                            signal: controller.signal,
                            duration,
                            seed: initialSeed,
                            channelId: sourceNode?.metadata?.channelId,
                            workflowId: sourceNode?.metadata?.workflowId,
                        });
                        const audio = await storeGeneratedAudio(result.blob);
                        setNodes((prev) =>
                            prev.map((node) =>
                                node.id === audioId
                                    ? {
                                          ...node,
                                          metadata: {
                                              ...node.metadata,
                                              ...audioMetadata(audio),
                                              prompt,
                                              effectivePrompt,
                                              channelId: sourceNode?.metadata?.channelId,
                                              workflowId: sourceNode?.metadata?.workflowId,
                                              seconds: String(duration),
                                              seed: result.seed,
                                              jobId: result.jobId,
                                              status: NODE_STATUS_SUCCESS,
                                          },
                                      }
                                    : node,
                            ),
                        );
                    } finally {
                        finishGenerationRequest(audioId, controller);
                    }
                    return;
                }

                const isConfigNode = sourceNode?.type === CanvasNodeType.Config;
                const textCount = getGenerationCount(String(sourceNode?.metadata?.textCount || 1));
                const parentConfig = NODE_DEFAULT_SIZE[isConfigNode ? CanvasNodeType.Config : CanvasNodeType.Text];
                const textConfig = NODE_DEFAULT_SIZE[CanvasNodeType.Text];
                const parentPosition = sourceNode?.position || { x: 0, y: 0 };
                const sourceTextContent = sourceNode?.type === CanvasNodeType.Text ? sourceNode.metadata?.content?.trim() || "" : "";
                const isEmptyTextNode = sourceNode?.type === CanvasNodeType.Text && !sourceTextContent && intent !== "repeat";
                const rootId = isEmptyTextNode ? nodeId : nanoid();
                const textIds = Array.from({ length: textCount }, () => nanoid());
                const isRepeat = intent === "repeat";
                const rootNode: CanvasNodeData = {
                    id: rootId,
                    type: CanvasNodeType.Text,
                    title: isRepeat && sourceNode?.title ? sourceNode.title : (effectivePrompt.slice(0, 32) || "Generated Text"),
                    position: isEmptyTextNode ? sourceNode.position : { x: parentPosition.x + (sourceNode?.width || parentConfig.width) + 96, y: isRepeat ? parentPosition.y : parentPosition.y + parentConfig.height / 2 - textConfig.height / 2 },
                    width: isEmptyTextNode ? sourceNode.width : (isRepeat && sourceNode?.width ? sourceNode.width : textConfig.width),
                    height: isEmptyTextNode ? sourceNode.height : (isRepeat && sourceNode?.height ? sourceNode.height : textConfig.height),
                    metadata: {
                        ...(isRepeat && sourceNode?.metadata ? cloneNodeMetadata(sourceNode.metadata, sourceNode.type) : {}),
                        prompt,
                        effectivePrompt,
                        channelId: sourceNode?.metadata?.channelId,
                        workflowId: sourceNode?.metadata?.workflowId,
                        status: NODE_STATUS_LOADING,
                        fontSize: sourceNode?.metadata?.fontSize || 14,
                        model: generationConfig.model,
                        reasoningEffort: generationConfig.reasoningEffort,
                        generationMode: mode,
                        generationReferences: generationContext.generationReferences,
                        generationOriginNodeId: sourceNode?.metadata?.generationOriginNodeId || nodeId,
                        textCount,
                        seed: nextSeed,
                        images: undefined,
                        primaryImageId: undefined,
                        storageKey: undefined,
                        naturalWidth: undefined,
                        naturalHeight: undefined,
                        bytes: undefined,
                        mimeType: undefined,
                        content: "",
                        texts: textIds.map((id, index) => ({ id, status: NODE_STATUS_LOADING, content: "", seed: (nextSeed + index) % 9007199254740991 })),
                        primaryTextId: textIds[0],
                        jobId: undefined,
                        isTimeout: undefined,
                        errorDetails: undefined,
                    },
                };
                pendingChildIds = [rootId];
                setNodes((prev) =>
                    isEmptyTextNode
                        ? prev.map((node) => (node.id === nodeId ? { ...node, ...rootNode } : node))
                        : [
                              ...prev.map((node) =>
                                  node.id === nodeId
                                      ? isConfigNode
                                          ? { ...node, metadata: { ...node.metadata, status: NODE_STATUS_LOADING, errorDetails: undefined } }
                                          : { ...node, metadata: { ...node.metadata, status: NODE_STATUS_SUCCESS, errorDetails: undefined } }
                                      : node,
                              ),
                              rootNode,
                          ],
                );
                if (!isEmptyTextNode) {
                    const nextConnections = buildGeneratedNodeConnections(nodeId, rootId, intent, connectionsRef.current, nodesRef.current);
                    connectionsRef.current = [...connectionsRef.current, ...nextConnections];
                    setConnections((prev) => [...prev, ...nextConnections]);
                }
                setSelectedNodeIds(new Set([nodeId]));
                setSelectedConnectionId(null);
                setDialogNodeId(nodeId);

                const controller = rootId === nodeId ? runController : startGenerationRequest(rootId, nodeId, nodeId, runController);
                const results = await Promise.all(
                    textIds.map(async (textId, index): Promise<CanvasNodeText | null> => {
                        let streamed = "";
                        const slotSeed = (nextSeed + index) % 9007199254740991;
                        try {
                            const answer = await requestImageQuestion(
                                generationConfig,
                                buildNodeResponseMessages({ ...generationContext, prompt: effectivePrompt }),
                                (text) => {
                                    streamed = text;
                                    setNodes((prev) =>
                                        prev.map((node) =>
                                            node.id === rootId
                                                ? {
                                                      ...node,
                                                      metadata: {
                                                          ...node.metadata,
                                                          ...(node.metadata?.primaryTextId === textId ? { content: text } : {}),
                                                          texts: node.metadata?.texts?.map((item) => (item.id === textId ? { ...item, content: text } : item)),
                                                      },
                                                  }
                                                : node,
                                        ),
                                    );
                                },
                                {
                                    signal: controller.signal,
                                    seed: slotSeed,
                                    onProgress: (status, detail) => {
                                        if (status === "submitted" && detail?.jobId) {
                                            setNodes((prev) =>
                                                prev.map((n) =>
                                                    n.id === rootId
                                                        ? {
                                                              ...n,
                                                              metadata: {
                                                                  ...n.metadata,
                                                                  ...(textCount === 1 ? { jobId: detail.jobId, isTimeout: undefined } : {}),
                                                                  texts: n.metadata?.texts?.map((item) => (item.id === textId ? { ...item, jobId: detail.jobId, isTimeout: undefined } : item)),
                                                              },
                                                          }
                                                        : n,
                                                ),
                                            );
                                        }
                                    },
                                },
                            );
                            const content = answer || streamed;
                            setNodes((prev) =>
                                prev.map((node) =>
                                    node.id === rootId
                                        ? {
                                              ...node,
                                              metadata: {
                                                  ...node.metadata,
                                                  ...(node.metadata?.primaryTextId === textId ? { content } : {}),
                                                  texts: node.metadata?.texts?.map((item) => (item.id === textId ? { ...item, content, status: NODE_STATUS_SUCCESS, jobId: undefined, isTimeout: undefined, seed: slotSeed } : item)),
                                                  seed: nextSeed,
                                              },
                                          }
                                        : node,
                                ),
                            );
                            return { id: textId, status: NODE_STATUS_SUCCESS, content } satisfies CanvasNodeText;
                        } catch (error) {
                            if (isGenerationCanceled(error)) return null;
                            const errorDetails = error instanceof Error ? error.message : t("canvas.projectPage.generationFailed");
                            const errorJobId = (error as { jobId?: string })?.jobId;
                            const isTimeout = (error as { name?: string })?.name === "ComfyuiTimeoutError" || errorDetails.includes("timeout") || errorDetails.includes("超时");
                            setNodes((prev) =>
                                prev.map((node) =>
                                    node.id === rootId
                                        ? {
                                              ...node,
                                              metadata: {
                                                  ...node.metadata,
                                                  ...(textCount === 1 ? { jobId: errorJobId || node.metadata?.jobId, isTimeout: isTimeout ? true : undefined } : {}),
                                                  texts: node.metadata?.texts?.map((item) =>
                                                      item.id === textId ? { ...item, status: NODE_STATUS_ERROR, errorDetails, jobId: errorJobId || item.jobId, isTimeout: isTimeout ? true : undefined } : item,
                                                  ),
                                              },
                                          }
                                        : node,
                                ),
                            );
                            const currentJobId = errorJobId || nodesRef.current.find((n) => n.id === rootId)?.metadata?.texts?.find((item: CanvasNodeText) => item.id === textId)?.jobId;
                            return { id: textId, status: NODE_STATUS_ERROR, content: "", errorDetails, jobId: currentJobId, isTimeout: isTimeout ? true : undefined } satisfies CanvasNodeText;
                        }
                    }),
                );
                if (rootId !== nodeId) finishGenerationRequest(rootId, controller);
                if (controller.signal.aborted) {
                    setNodes((prev) =>
                        prev.map((node) => {
                            if (node.id !== rootId && node.id !== nodeId) return node;
                            const completedTexts = node.metadata?.texts?.filter((txt) => Boolean(txt.content)) || [];
                            const hasCompleted = completedTexts.length > 0 || Boolean(node.metadata?.content);
                            const primaryText = completedTexts.find((txt) => txt.id === node.metadata?.primaryTextId) || completedTexts[0];
                            return {
                                ...node,
                                metadata: {
                                    ...node.metadata,
                                    status: hasCompleted ? NODE_STATUS_SUCCESS : NODE_STATUS_IDLE,
                                    errorDetails: undefined,
                                    jobId: undefined,
                                    isTimeout: undefined,
                                    ...(hasCompleted && primaryText && !node.metadata?.content
                                        ? {
                                              content: primaryText.content,
                                              primaryTextId: primaryText.id,
                                          }
                                        : {}),
                                    texts: completedTexts.length > 0
                                        ? node.metadata?.texts?.map((text) =>
                                              text.status === NODE_STATUS_LOADING
                                                  ? { ...text, status: NODE_STATUS_IDLE, errorDetails: undefined, jobId: undefined, isTimeout: undefined }
                                                  : text,
                                          )
                                        : undefined,
                                },
                            };
                        }),
                    );
                    return;
                }
                const completedTexts = results.flatMap((item) => (item?.status === NODE_STATUS_SUCCESS ? [item] : []));
                const failedTexts = results.flatMap((item) => (item?.status === NODE_STATUS_ERROR ? [item] : []));
                const settledTexts = results.filter((item): item is CanvasNodeText => Boolean(item));
                const firstText = completedTexts[0];
                if (completedTexts.length <= 1) setExpandedBatchNodeIds((current) => new Set([...current].filter((id) => id !== rootId)));
                if (failedTexts.length) message.error(firstText ? t("canvas.projectPage.partialTextFailed") : failedTexts[0]?.errorDetails || t("canvas.projectPage.generationFailed"));
                setNodes((prev) =>
                    prev.map((node) => {
                        if (node.id === rootId) {
                            const primaryText = completedTexts.find((text) => text.id === node.metadata?.primaryTextId) || firstText;
                            return {
                                ...node,
                                metadata: {
                                    ...node.metadata,
                                    content: primaryText?.content || "",
                                    texts: settledTexts,
                                    primaryTextId: primaryText?.id,
                                    status: primaryText ? NODE_STATUS_SUCCESS : NODE_STATUS_ERROR,
                                    errorDetails: primaryText ? (failedTexts.length ? t("canvas.projectPage.partialTextFailed") : undefined) : t("canvas.projectPage.generationFailed"),
                                    ...(primaryText ? { jobId: undefined, isTimeout: undefined } : {}),
                                },
                            };
                        }
                        return node.id === nodeId && isConfigNode ? { ...node, metadata: { ...node.metadata, status: firstText ? NODE_STATUS_SUCCESS : NODE_STATUS_ERROR, errorDetails: firstText ? undefined : t("canvas.projectPage.generationFailed") } } : node;
                    }),
                );
            } catch (error) {
                if (isGenerationCanceled(error)) {
                    setNodes((prev) =>
                        prev.map((node) => {
                            if (node.id !== nodeId && !pendingChildIds.includes(node.id)) return node;
                            const completedImages = node.metadata?.images?.filter((img) => Boolean(img.content)) || [];
                            const completedTexts = node.metadata?.texts?.filter((txt) => Boolean(txt.content)) || [];
                            const hasCompleted = completedImages.length > 0 || completedTexts.length > 0 || Boolean(node.metadata?.content);
                            return {
                                ...node,
                                metadata: {
                                    ...node.metadata,
                                    status: hasCompleted ? NODE_STATUS_SUCCESS : NODE_STATUS_IDLE,
                                    errorDetails: undefined,
                                    jobId: undefined,
                                    isTimeout: undefined,
                                    images: completedImages.length > 0
                                        ? node.metadata?.images?.map((img) => (img.status === NODE_STATUS_LOADING ? { ...img, status: NODE_STATUS_IDLE, jobId: undefined, isTimeout: undefined } : img))
                                        : undefined,
                                    texts: completedTexts.length > 0
                                        ? node.metadata?.texts?.map((txt) => (txt.status === NODE_STATUS_LOADING ? { ...txt, status: NODE_STATUS_IDLE, jobId: undefined, isTimeout: undefined } : txt))
                                        : undefined,
                                },
                            };
                        }),
                    );
                    return;
                }
                const errorDetails = error instanceof Error ? error.message : t("canvas.projectPage.generationFailed");
                const errorJobId = (error as { jobId?: string })?.jobId;
                const isTimeout = (error as { name?: string })?.name === "ComfyuiTimeoutError" || errorDetails.includes("timeout") || errorDetails.includes("超时");
                message.error(errorDetails);
                setNodes((prev) =>
                    prev.map((node) => {
                        if (node.id === nodeId || pendingChildIds.includes(node.id)) {
                            if (node.id === nodeId && !markSourceStatus) return node;
                            return {
                                ...node,
                                metadata: {
                                    ...node.metadata,
                                    status: NODE_STATUS_ERROR,
                                    errorDetails,
                                    jobId: errorJobId || node.metadata?.jobId,
                                    isTimeout: isTimeout ? true : undefined,
                                },
                            };
                        }
                        return node;
                    }),
                );
            } finally {
                pendingChildIds.forEach((childId) => {
                    if (childId !== nodeId) {
                        const childRequest = generationRequestsRef.current.get(childId);
                        if (childRequest) finishGenerationRequest(childId, childRequest.controller);
                    }
                });
                finishGenerationRequest(nodeId, runController);
            }
        },
        [effectiveConfig, finishGenerationRequest, isAiConfigReady, message, openConfigDialog, startGenerationRequest, t],
    );
    useEffect(() => {
        generateNodeRef.current = handleGenerateNode;
    }, [handleGenerateNode]);

    const handleRetryNode = useCallback(
        async (node: CanvasNodeData, imageId?: string, intent: "retry" | "resume" = "retry") => {
            if (isViewerRef.current) {
                message.warning(t("canvas.collabWatchMode.warnOwnerOnly"));
                return;
            }
            const saved = node.metadata || {};
            let context: NodeGenerationContext | null;
            try {
                context = await restoreGenerationContext(saved);
            } catch (error) {
                message.error(error instanceof Error ? error.message : t("canvas.projectPage.referenceMissing"));
                return;
            }
            if (!context) {
                message.error(t("canvas.projectPage.generationSnapshotMissing"));
                return;
            }
            const prompt = (context.prompt || "").trim();
            const mode: CanvasNodeGenerationMode = node.type === CanvasNodeType.Text ? "text" : node.type === CanvasNodeType.Video ? "video" : node.type === CanvasNodeType.Audio ? "audio" : "image";
            if (!prompt && (mode === "text" || mode === "audio")) {
                message.warning(t("canvas.projectPage.retryPromptMissing"));
                return;
            }
            const generationConfig = { ...buildGenerationConfig(effectiveConfig, node, mode), count: "1" };
            if (!isAiConfigReady(generationConfig, generationConfig.model)) {
                openConfigDialog(true);
                return;
            }
            const imageSlot = imageId ? saved.images?.find((image) => image.id === imageId) : undefined;
            if (imageId && !imageSlot) {
                message.error(t("canvas.projectPage.generationSnapshotMissing"));
                return;
            }
            const sourceRef = imageSlot || saved;
            const isResume = intent === "resume" && Boolean(sourceRef.jobId);
            if (intent === "resume" && !isResume) {
                message.error(t("canvas.projectPage.generationSnapshotMissing"));
                return;
            }
            const resumeJobId = isResume ? sourceRef.jobId : undefined;

            setNodes((prev) =>
                prev.map((item) =>
                    item.id === node.id
                        ? {
                              ...item,
                              metadata: {
                                  ...item.metadata,
                                  status: imageId ? (item.metadata?.status === "error" ? NODE_STATUS_LOADING : item.metadata?.status) : NODE_STATUS_LOADING,
                                  errorDetails: undefined,
                                  ...(intent === "retry" ? { jobId: undefined } : {}),
                                  isTimeout: undefined,
                                  images: item.metadata?.images?.map((image) => (image.id === imageId ? { ...image, status: NODE_STATUS_LOADING, errorDetails: undefined, isTimeout: undefined, ...(intent === "retry" ? { jobId: undefined } : {}) } : image)),
                              },
                          }
                        : item,
                ),
            );
            const controller = startGenerationRequest(node.id, node.id, node.id);
            const originConfigId = saved.generationOriginNodeId;

            try {
                if (mode === "text") {
                    let streamed = "";
                    const answer = await requestImageQuestion(
                        generationConfig,
                        buildNodeResponseMessages({ ...context, prompt: context.prompt }),
                        (text) => {
                            streamed = text;
                            setNodes((prev) => prev.map((item) => (item.id === node.id ? { ...item, metadata: { ...item.metadata, content: text, status: NODE_STATUS_LOADING } } : item)));
                        },
                        {
                            signal: controller.signal,
                            jobId: resumeJobId,
                            onProgress: (status, detail) => {
                                if (status === "submitted" && detail?.jobId) {
                                    setNodes((prev) => prev.map((item) => (item.id === node.id ? { ...item, metadata: { ...item.metadata, jobId: detail.jobId } } : item)));
                                }
                            },
                        },
                    );
                    setNodes((prev) =>
                        prev.map((item) =>
                            item.id === node.id
                                ? { ...item, metadata: { ...item.metadata, content: answer || streamed, status: NODE_STATUS_SUCCESS, errorDetails: undefined, jobId: undefined, isTimeout: undefined } }
                                : item,
                        ),
                    );
                } else if (mode === "video") {
                    const video = await storeGeneratedVideo(
                        await requestVideoGeneration(generationConfig, prompt, context.referenceImages, {
                            signal: controller.signal,
                            videoMode: generationConfig.videoMode === "frame" ? "frame" : "omni",
                            firstFrame: context.referenceImages[0],
                            lastFrame: context.referenceImages[1],
                            referenceVideos: context.referenceVideos,
                            referenceAudios: context.referenceAudios,
                            jobId: resumeJobId,
                            onProgress: (status, detail) => {
                                if (status === "submitted" && detail?.jobId) {
                                    setNodes((prev) => prev.map((item) => (item.id === node.id ? { ...item, metadata: { ...item.metadata, jobId: detail.jobId } } : item)));
                                }
                            },
                        }),
                    );
                    const videoSize = fitNodeSize(video.width || node.width, video.height || node.height, VIDEO_NODE_MAX_WIDTH, VIDEO_NODE_MAX_HEIGHT);
                    setNodes((prev) =>
                        prev.map((item) =>
                            item.id === node.id
                                ? {
                                      ...item,
                                      width: videoSize.width,
                                      height: videoSize.height,
                                      position: { x: item.position.x + item.width / 2 - videoSize.width / 2, y: item.position.y + item.height / 2 - videoSize.height / 2 },
                                      metadata: {
                                          ...item.metadata,
                                          ...videoMetadata(video),
                                          status: NODE_STATUS_SUCCESS,
                                          errorDetails: undefined,
                                          jobId: undefined,
                                          isTimeout: undefined,
                                      },
                                  }
                                : item,
                        ),
                    );
                } else if (mode === "audio") {
                    const duration = Number(node.metadata?.seconds || generationConfig.audioSeconds) || 60;
                    const initialSeed = node.metadata?.seed;
                    const result = await requestAudioGeneration(generationConfig, prompt, {
                        signal: controller.signal,
                        duration,
                        seed: initialSeed,
                        channelId: node.metadata?.channelId,
                        workflowId: node.metadata?.workflowId,
                    });
                    const audio = await storeGeneratedAudio(result.blob);
                    setNodes((prev) =>
                        prev.map((item) =>
                            item.id === node.id
                                ? {
                                      ...item,
                                      metadata: {
                                          ...item.metadata,
                                          ...audioMetadata(audio),
                                          status: NODE_STATUS_SUCCESS,
                                          errorDetails: undefined,
                                          jobId: result.jobId,
                                          isTimeout: undefined,
                                          seconds: String(duration),
                                          seed: result.seed,
                                          channelId: node.metadata?.channelId,
                                          workflowId: node.metadata?.workflowId,
                                      },
                                  }
                                : item,
                        ),
                    );
                } else {
                    const referenceImages = context.referenceImages;
                    const useEdit = saved.generationType === "edit" || referenceImages.length > 0;
                    const image = useEdit
                        ? await requestEdit(generationConfig, prompt, referenceImages, undefined, {
                              signal: controller.signal,
                              jobId: resumeJobId,
                              onProgress: (status, detail) => {
                                  if (status === "submitted" && detail?.jobId) {
                                      setNodes((prev) =>
                                          prev.map((item) => {
                                              if (item.id !== node.id) return item;
                                              const images = item.metadata?.images?.map((slot) => (slot.id === imageId ? { ...slot, jobId: detail.jobId } : slot));
                                              return { ...item, metadata: { ...item.metadata, ...(imageId ? {} : { jobId: detail.jobId }), images } };
                                          }),
                                      );
                                  }
                              },
                          }).then((items) => items[0])
                        : await requestGeneration(generationConfig, prompt, {
                              signal: controller.signal,
                              jobId: resumeJobId,
                              onProgress: (status, detail) => {
                                  if (status === "submitted" && detail?.jobId) {
                                      setNodes((prev) =>
                                          prev.map((item) => {
                                              if (item.id !== node.id) return item;
                                              const images = item.metadata?.images?.map((slot) => (slot.id === imageId ? { ...slot, jobId: detail.jobId } : slot));
                                              return { ...item, metadata: { ...item.metadata, ...(imageId ? {} : { jobId: detail.jobId }), images } };
                                          }),
                                      );
                                  }
                              },
                          }).then((items) => items[0]);
                    const uploadedImage = await uploadImage(image.dataUrl);
                    const imageConfig = NODE_DEFAULT_SIZE[CanvasNodeType.Image];
                    const retryImage: CanvasNodeImage = {
                        id: imageId || node.metadata?.primaryImageId || nanoid(),
                        status: NODE_STATUS_SUCCESS,
                        content: uploadedImage.url,
                        storageKey: uploadedImage.storageKey,
                        naturalWidth: uploadedImage.width,
                        naturalHeight: uploadedImage.height,
                        bytes: uploadedImage.bytes,
                        mimeType: uploadedImage.mimeType,
                        ...(image.seed !== undefined ? { seed: image.seed } : {}),
                    };
                    const generationMetadata = buildImageGenerationMetadata(useEdit ? "edit" : "generation", generationConfig, saved.count || 1, referenceImages, image.seed);
                    setNodes((prev) =>
                        prev.map((item) => {
                            if (item.id !== node.id) return item;
                            const makePrimary = !imageId || !item.metadata?.content;
                            const edge = imageId ? Math.max(item.width, item.height) : 0;
                            const imageSize = imageId && item.metadata?.freeResize ? { width: item.width, height: item.height } : imageId ? fitNodeSize(uploadedImage.width, uploadedImage.height, edge, edge) : fitNodeSize(uploadedImage.width, uploadedImage.height, imageConfig.width, imageConfig.height);
                            return {
                                ...item,
                                type: CanvasNodeType.Image,
                                ...(makePrimary ? { width: imageSize.width, height: imageSize.height, ...(imageId ? { position: { x: item.position.x + item.width / 2 - imageSize.width / 2, y: item.position.y + item.height / 2 - imageSize.height / 2 } } : {}) } : {}),
                                metadata: {
                                    ...item.metadata,
                                    ...(makePrimary ? imageMetadata(uploadedImage) : { status: NODE_STATUS_SUCCESS }),
                                    images: item.metadata?.images?.map((current) => (current.id === retryImage.id ? retryImage : current)),
                                    primaryImageId: makePrimary ? retryImage.id : item.metadata?.primaryImageId,
                                    status: NODE_STATUS_SUCCESS,
                                    errorDetails: undefined,
                                    jobId: undefined,
                                    isTimeout: undefined,
                                    ...generationMetadata,
                                    generationReferences: saved.generationReferences,
                                    generationOriginNodeId: saved.generationOriginNodeId,
                                    count: saved.count || 1,
                                    ...(image.seed !== undefined ? { seed: image.seed } : {}),
                                },
                            };
                        }),
                    );
                }

                if (originConfigId && nodesRef.current.find((item) => item.id === originConfigId)?.type === CanvasNodeType.Config) {
                    setNodes((prev) => prev.map((item) => (item.id === originConfigId ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_SUCCESS, errorDetails: undefined } } : item)));
                }
            } catch (error) {
                if (isGenerationCanceled(error)) return;
                const errorDetails = error instanceof Error ? error.message : t("canvas.projectPage.generationFailed");
                const errorJobId = (error as { jobId?: string })?.jobId;
                const isTimeout = (error as { name?: string })?.name === "ComfyuiTimeoutError" || errorDetails.includes("timeout") || errorDetails.includes("超时");
                const keepJobId = isTimeout || (isResume && (error as { name?: string })?.name !== "ComfyuiJobError") ? errorJobId || sourceRef.jobId || saved.jobId : undefined;
                const fresh = nodesRef.current.find((item) => item.id === node.id);
                const hasSuccessImage = mode === "image" && Boolean(fresh?.metadata?.images?.some((image) => image.id !== imageId && image.status === NODE_STATUS_SUCCESS && image.content));
                message.error(hasSuccessImage ? t("canvas.projectPage.partialFailed") : errorDetails);
                setNodes((prev) =>
                    prev.map((item) => {
                        if (item.id !== node.id) return item;
                        return {
                            ...item,
                            metadata: {
                                ...item.metadata,
                                status: hasSuccessImage ? NODE_STATUS_SUCCESS : NODE_STATUS_ERROR,
                                errorDetails: hasSuccessImage ? t("canvas.projectPage.partialFailed") : errorDetails,
                                ...(imageId ? {} : { jobId: keepJobId, isTimeout: isTimeout ? true : undefined }),
                                images: item.metadata?.images?.map((image) => (image.id === imageId ? { ...image, status: NODE_STATUS_ERROR, errorDetails, jobId: keepJobId, isTimeout: isTimeout ? true : undefined } : image)),
                            },
                        };
                    }),
                );
            } finally {
                finishGenerationRequest(node.id, controller);
            }
        },
        [effectiveConfig, finishGenerationRequest, isAiConfigReady, message, openConfigDialog, startGenerationRequest, t],
    );

    const deleteBatchImage = useCallback((nodeId: string, imageId: string) => {
        const node = nodesRef.current.find((item) => item.id === nodeId);
        if ((node?.metadata?.images?.length || 0) <= 2) setExpandedBatchNodeIds((current) => new Set([...current].filter((id) => id !== nodeId)));
        setNodes((prev) =>
            prev.map((item) => {
                if (item.id !== nodeId) return item;
                const images = item.metadata?.images?.filter((image) => image.id !== imageId) || [];
                return { ...item, metadata: { ...item.metadata, images, count: images.length, primaryImageId: item.metadata?.primaryImageId === imageId ? images[0]?.id : item.metadata?.primaryImageId } };
            }),
        );
    }, []);

    const retryBatchImage = useCallback(
        (node: CanvasNodeData, imageId: string) => {
            const image = node.metadata?.images?.find((item) => item.id === imageId);
            const intent = Boolean(image?.jobId) ? "resume" : "retry";
            void handleRetryNode(node, imageId, intent);
        },
        [handleRetryNode],
    );

    const generateImageFromTextNode = useCallback(
        (node: CanvasNodeData) => {
            const prompt = (node.metadata?.content || node.metadata?.prompt || "").trim();
            if (!prompt) {
                message.warning(t("canvas.projectPage.emptyTextImage"));
                return;
            }
            const sourceNode = nodesRef.current.find((item) => item.id === node.id);
            if (!sourceNode) return;
            const nodeSize = getNodeSpec(CanvasNodeType.Config);
            const configNode = createCanvasNode(
                CanvasNodeType.Config,
                {
                    x: sourceNode.position.x + sourceNode.width + 96 + nodeSize.width / 2,
                    y: sourceNode.position.y + sourceNode.height / 2,
                },
                {
                    prompt: "",
                    model: effectiveConfig.imageModel || effectiveConfig.model,
                    size: effectiveConfig.size,
                    count: getGenerationCount(effectiveConfig.canvasImageCount || effectiveConfig.count),
                },
            );
            const connection = { id: nanoid(), fromNodeId: sourceNode.id, toNodeId: configNode.id, kind: "input" as const };
            const nextNodes = nodesRef.current.map((item) => (item.id === sourceNode.id ? { ...item, metadata: { ...item.metadata, content: prompt, prompt, status: NODE_STATUS_SUCCESS } } : item)).concat(configNode);
            const nextConnections = [...connectionsRef.current, connection];
            nodesRef.current = nextNodes;
            connectionsRef.current = nextConnections;
            setNodes(nextNodes);
            setConnections(nextConnections);
            setSelectedNodeIds(new Set([configNode.id]));
            setSelectedConnectionId(null);
            setDialogNodeId(configNode.id);
        },
        [effectiveConfig.canvasImageCount, effectiveConfig.count, effectiveConfig.imageModel, effectiveConfig.model, effectiveConfig.size, message, t],
    );


    // Memoize every callback and render function passed to CanvasNode.
    // CanvasNode uses React.memo, but new prop references would invalidate it on every render and rerender every node
    // during click, hover, or viewport changes, which is especially expensive for Markdown. These useCallback values
    // and their memoized map/handler dependencies remain stable during interaction, so unchanged nodes do not rerender.
    const handleNodeHoverStart = useCallback((nodeId: string) => {
        if (nodeDraggingRef.current) return;
        setHoveredNodeId(nodeId);
    }, []);
    const handleNodeHoverEnd = useCallback((nodeId: string) => {
        setHoveredNodeId((current) => (current === nodeId ? null : current));
    }, []);
    const handleNodeViewImage = useCallback((node: CanvasNodeData, imageId?: string) => {
        const canvasVideos = containerRef.current?.querySelectorAll<HTMLVideoElement>("video[data-canvas-video]");
        canvasVideos?.forEach((v) => {
            if (!v.paused) v.pause();
        });
        setPreviewNodeId(node.id);
        setPreviewImageId(imageId || null);
    }, []);
    const handleClosePreview = useCallback(() => {
        const canvasVideos = containerRef.current?.querySelectorAll<HTMLVideoElement>("video[data-canvas-video]");
        canvasVideos?.forEach((v) => {
            if (!v.paused) v.pause();
        });
        setPreviewNodeId(null);
        setPreviewImageId(null);
    }, []);
    const handleNodeRetry = useCallback(
        (node: CanvasNodeData) => {
            const intent = Boolean(node.metadata?.jobId) ? "resume" : "retry";
            void handleRetryNode(node, undefined, intent);
        },
        [handleRetryNode],
    );

    const interruptedNodes = useMemo(() => nodes.filter(hasInterruptedGeneration), [nodes]);
    const interruptedTaskCount = useMemo(() => countInterruptedTasks(interruptedNodes), [interruptedNodes]);
    const selectedInterruptedNodes = useMemo(
        () => nodes.filter((n) => selectedNodeIds.has(n.id) && hasInterruptedGeneration(n)),
        [nodes, selectedNodeIds],
    );

    const handleBatchRetryInterrupted = useCallback(
        async (targetNodes?: CanvasNodeData[]) => {
            const list = targetNodes && targetNodes.length > 0 ? targetNodes : interruptedNodes;
            if (list.length === 0) return;
            setIsResumingInterrupted(true);
            try {
                const tasks: Promise<void>[] = [];
                for (const node of list) {
                    const interruptedImages = node.metadata?.images?.filter(
                        (img) => img.status === "error" && isInterruptedGenerationError(img.errorDetails),
                    );
                    if (interruptedImages && interruptedImages.length > 0) {
                        for (const img of interruptedImages) {
                            const intent = Boolean(img.jobId) ? "resume" : "retry";
                            tasks.push(Promise.resolve(handleRetryNode(node, img.id, intent)));
                        }
                    } else {
                        const intent = Boolean(node.metadata?.jobId) ? "resume" : "retry";
                        tasks.push(Promise.resolve(handleRetryNode(node, undefined, intent)));
                    }
                }
                await Promise.allSettled(tasks);
            } finally {
                setIsResumingInterrupted(false);
            }
        },
        [handleRetryNode, interruptedNodes],
    );
    const handleNodeContextMenu = useCallback((event: ReactMouseEvent, nodeId: string) => {
        event.preventDefault();
        event.stopPropagation();
        setContextMenu({ type: "node", x: event.clientX, y: event.clientY, nodeId });
    }, []);

    const renderNodePanel = useCallback(
        (panelNode: CanvasNodeData) =>
            getNodeDefinition(panelNode.type)?.Panel ? (
                renderPluginPanel(panelNode)
            ) : panelNode.type === CanvasNodeType.Config ? (
                <CanvasConfigComposer
                    nodeId={panelNode.id}
                    nodes={nodes}
                    value={panelNode.metadata?.composerContent ?? panelNode.metadata?.prompt ?? ""}
                    inputs={configInputsById.get(panelNode.id) || []}
                    connectedNodes={connectedNodesByNodeId.get(panelNode.id) || []}
                    onChange={(composerContent) => handleConfigNodeChange(panelNode.id, { composerContent })}
                    onClose={() => setDialogNodeId(null)}
                    onDisconnectReference={disconnectNodeReference}
                    onStartReferenceSelection={startNodeReferenceSelection}
                    onReorderReferences={reorderNodeReferences}
                    onLocateNode={focusNode}
                />
            ) : (
                <CanvasNodePromptPanel
                    node={panelNode}
                    nodes={nodes}
                    isRunning={runningNodeIds.has(panelNode.id)}
                    mentionReferences={mentionReferencesByNodeId.get(panelNode.id) || EMPTY_REFERENCES}
                    connectedNodes={connectedNodesByNodeId.get(panelNode.id) || []}
                    onPromptChange={handleNodePromptChange}
                    onConfigChange={handleConfigNodeChange}
                    onGenerate={handleGenerateNode}
                    onStop={confirmStopGeneration}
                    onDisconnectReference={disconnectNodeReference}
                    onStartReferenceSelection={startNodeReferenceSelection}
                    onReorderReferences={reorderNodeReferences}
                    onLocateNode={focusNode}
                    modeOverride={getNodeDefinition(panelNode.type)?.useBuiltinPanel?.mode}
                    promptAssistantConfig={panelNode.type === CanvasNodeType.Text ? promptAssistantConfigOf(panelNode) : undefined}
                    onPromptAssistantChange={panelNode.type === CanvasNodeType.Text ? (patch) => handlePromptAssistantChange(panelNode, { ...promptAssistantConfigOf(panelNode), ...patch }) : undefined}
                    onOptimizePrompt={panelNode.type === CanvasNodeType.Text ? (scope) => void runPromptAssistant(panelNode, promptAssistantConfigOf(panelNode), undefined, { scope }) : undefined}
                    isOptimizingPrompt={promptAssistantNodeId === panelNode.id}
                    onCancelOptimizePrompt={cancelPromptAssistant}
                    promptAssistantDisabledReason={
                        panelNode.type !== CanvasNodeType.Text
                            ? undefined
                            : isNodeLocked(panelNode, nodes)
                              ? t("canvas.promptAssistant.disabledLocked")
                              : !readNodeText(panelNode)
                                ? t("canvas.promptAssistant.disabledEmpty")
                                : resolveSkillProduces(promptAssistantConfigOf(panelNode)) === "nodes" && !useAgentStore.getState().connected
                                  ? t("canvas.promptAssistant.nodesDisabledAgent")
                                  : undefined
                    }
                    onSettingsOpenChange={(open) => {
                        setNodeImageSettingsOpen(open);
                        if (open) setToolbarNodeId(null);
                    }}
                />
            ),
        [cancelPromptAssistant, configInputsById, confirmStopGeneration, connectedNodesByNodeId, disconnectNodeReference, focusNode, handleConfigNodeChange, handleGenerateNode, handleNodePromptChange, handlePromptAssistantChange, mentionReferencesByNodeId, nodes, promptAssistantConfigOf, promptAssistantNodeId, renderPluginPanel, reorderNodeReferences, runPromptAssistant, runningNodeIds, startNodeReferenceSelection, t],
    );

    const renderNodeContentPanel = useCallback(
        (contentNode: CanvasNodeData) => (
            <CanvasConfigNodePanel
                node={contentNode}
                isRunning={runningNodeIds.has(contentNode.id)}
                inputSummary={getInputSummary(configInputsById.get(contentNode.id) || [])}
                onConfigChange={handleConfigNodeChange}
                onComposerToggle={() => setDialogNodeId((current) => (current === contentNode.id ? null : contentNode.id))}
                onStop={confirmStopGeneration}
                onGenerate={(nodeId) => {
                    const target = nodesRef.current.find((item) => item.id === nodeId);
                    void handleGenerateNode(nodeId, target?.metadata?.generationMode || "image", target?.metadata?.composerContent ?? target?.metadata?.prompt ?? "");
                }}
            />
        ),
        [configInputsById, confirmStopGeneration, handleConfigNodeChange, handleGenerateNode, runningNodeIds],
    );

    if (!projectLoaded) return <CanvasRefreshShell />;

    return (
        <main className="flex h-full min-h-0 overflow-hidden" style={{ background: theme.canvas.background, color: theme.node.text }}>
            <CanvasSidePanel
                nodes={nodes}
                selectedNodeIds={selectedNodeIds}
                onFocusNode={focusNode}
                onPreviewNode={setPreviewNodeId}
                onInsertAsset={handleAssetInsert}
                onTitleChange={handleNodeTitleChange}
                projectTitle={currentProject?.title}
            />
            <section className="relative min-w-0 flex-1 overflow-hidden">
                <CanvasTopBar
                    title={currentProject?.title || t("canvas.projectPage.untitledCanvas")}
                    titleDraft={titleDraft}
                    isTitleEditing={titleEditing}
                    onTitleDraftChange={setTitleDraft}
                    onStartTitleEditing={startTitleEditing}
                    onFinishTitleEditing={finishTitleEditing}
                    onCancelTitleEditing={() => setTitleEditing(false)}
                    canUndo={historyState.canUndo}
                    canRedo={historyState.canRedo}
                    onHome={() => navigate("/")}
                    onProjects={() => navigate("/canvas")}
                    onCreateProject={createAndOpenProject}
                    onDeleteProject={deleteCurrentProject}
                    onExportProject={exportCurrentProject}
                    onImportImage={() => handleUploadRequest()}
                    onOpenPlugins={() => setPluginManagerOpen(true)}
                    onUndo={undoCanvas}
                    onRedo={redoCanvas}
                    agentOpen={agentPanelOpen}
                    compactAgentStatus={{ connected: localAgentConnected, enabled: localAgentEnabled, activity: localAgentActivity }}
                    onToggleAgent={toggleAgentPanel}
                />

                {!interruptedBannerDismissed && interruptedTaskCount > 0 && !isViewer ? (
                    <CanvasInterruptedBanner
                        count={interruptedTaskCount}
                        resuming={isResumingInterrupted}
                        onResumeAll={() => void handleBatchRetryInterrupted()}
                        onDismiss={() => setInterruptedBannerDismissed(true)}
                    />
                ) : null}

                <InfiniteCanvas
                    containerRef={containerRef}
                    viewport={viewport}
                    tool={canvasTool}
                    backgroundMode={backgroundMode}
                    onViewportChange={(next) => {
                        setViewport(next);
                        setContextMenu(null);
                    }}
                    onCanvasMouseDown={(event) => {
                        if (!referencePickerNodeId) handleCanvasMouseDown(event);
                    }}
                    onCanvasDeselect={referencePickerNodeId ? undefined : deselectCanvas}
                    onCanvasDoubleClick={(event) => {
                        if (referencePickerNodeId) return;
                        setContextMenu(null);
                        setNodeCreatePosition(screenToCanvas(event.clientX, event.clientY));
                    }}
                    onContextMenu={preventCanvasContextMenu}
                    onDrop={handleDrop}
                >
                    <svg className="absolute left-0 top-0 h-[10000px] w-[10000px] overflow-visible" style={{ pointerEvents: "none", transform: "translateZ(0)", zIndex: 0 }}>
                        {connections
                            .filter((connection) => !collapsedEndpointIds.has(connection.fromNodeId) && !collapsedEndpointIds.has(connection.toNodeId))
                            .map((connection) => {
                                const from = nodeById.get(connection.fromNodeId);
                                const to = nodeById.get(connection.toNodeId);
                                if (!from || !to) return null;

                                return (
                                    <ConnectionPath
                                        key={connection.id}
                                        connection={connection}
                                        from={from}
                                        to={to}
                                        active={selectedConnectionId === connection.id || relatedHighlight.connectionIds.has(connection.id)}
                                        onSelect={() => {
                                            setSelectedConnectionId(connection.id);
                                            setSelectedNodeIds(new Set());
                                            setContextMenu(null);
                                        }}
                                        onContextMenu={(event) => {
                                            setSelectedConnectionId(connection.id);
                                            setSelectedNodeIds(new Set());
                                            setContextMenu({ type: "connection", x: event.clientX, y: event.clientY, connectionId: connection.id });
                                        }}
                                    />
                                );
                            })}
                        {connectingParams ? (
                            <ActiveConnectionPath
                                node={nodeById.get(connectingParams.nodeId)}
                                nodes={
                                    selectedNodeIdsRef.current.has(connectingParams.nodeId) && selectedNodeIdsRef.current.size > 1
                                        ? Array.from(selectedNodeIdsRef.current).map((id) => nodeById.get(id)!).filter(Boolean)
                                        : undefined
                                }
                                handle={connectingParams}
                                mouseWorld={mouseWorld}
                                target={connectionTargetNodeId ? nodeById.get(connectionTargetNodeId) : undefined}
                            />
                        ) : null}
                        <CanvasAlignmentGuides guides={alignmentGuides} viewportScale={viewport.k} />
                    </svg>

                    {visibleNodes.map((node) => (
                        <CanvasNode
                            key={node.id}
                            data={node}
                            scale={viewport.k}
                            isSelected={selectedNodeIds.has(node.id)}
                            hasMultipleSelected={selectedNodeIds.size > 1}
                            isRelated={relatedHighlight.nodeIds.has(node.id)}
                            isFocusRelated={activeNodeId === node.id}
                            isConnectionTarget={connectionTargetNodeId === node.id}
                            isConnecting={Boolean(connectingParams)}
                            referenceSelectionState={!referencePickerNodeId ? undefined : node.id === referencePickerNodeId ? "target" : referenceConnectedNodeIds.has(node.id) || !isCanvasReferenceNode(node, nodes) ? "disabled" : "available"}
                            showPanel={!isNodeResizing && dialogNodeId === node.id && !selectionBox && !getNodeDefinition(node.type)?.hidePanel}
                            groupChildCount={groupChildCountById.get(node.id) || 0}
                            groupSummary={groupSummaryById.get(node.id)}
                            isLocked={lockedNodeIds.has(node.id)}
                            onToggleGroupCollapse={toggleGroupCollapse}
                            isGroupDropTarget={dropTargetGroupId === node.id}
                            batchExpanded={expandedBatchNodeIds.has(node.id)}
                            showImageInfo={showImageInfo}
                            mentionReferences={mentionReferencesByNodeId.get(node.id) || EMPTY_REFERENCES}
                            pluginHost={pluginHost}
                            registryVersion={nodeRegistryVersion}
                            renderPanel={renderNodePanel}
                            renderNodeContent={renderNodeContentPanel}
                            onMouseDown={handleNodeMouseDown}
                            onSelectCapture={handleNodeSelectCapture}
                            onHoverStart={handleNodeHoverStart}
                            onHoverEnd={handleNodeHoverEnd}
                            onConnectStart={handleConnectStart}
                            onConnectClick={handleConnectClick}
                            onResizeStart={handleNodeResizeStart}
                            onResize={handleNodeResize}
                            onResizeEnd={handleNodeResizeEnd}
                            onContentChange={handleNodeContentChange}
                            onTitleChange={handleNodeTitleChange}
                            onEditingTitleChange={handleNodeEditingTitleChange}
                            onToggleBatch={toggleBatchExpanded}
                            onSetBatchPrimary={setBatchPrimary}
                            onDuplicateBatchImage={duplicateBatchImage}
                            onDownloadBatchImage={downloadBatchImage}
                            onRetryBatchImage={retryBatchImage}
                            onDeleteBatchImage={deleteBatchImage}
                            onRetry={handleNodeRetry}
                            onViewImage={handleNodeViewImage}
                            onSelectReference={selectNodeReference}
                            onSelectGroupChildren={handleSelectGroupChildren}
                            onContextMenu={handleNodeContextMenu}
                        />
                    ))}

                    {selectedNodeIds.size > 1 && !selectionBox && !isNodeDragging ? (
                        <CanvasMultiSelectionOverlay
                            selectedNodes={nodes.filter((n) => selectedNodeIds.has(n.id))}
                            mouseWorldY={mouseWorld.y}
                            scale={viewport.k}
                            isConnecting={Boolean(connectingParams)}
                            onConnectStart={handleConnectStart}
                            onClickPlus={handleMultiSelectClickPlus}
                        />
                    ) : null}

                    {referencePickerNodeId ? <button type="button" className="absolute left-1/2 top-4 z-[90] -translate-x-1/2 rounded-full border px-4 py-2 text-sm font-medium shadow-lg backdrop-blur" style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border }} onClick={exitNodeReferenceSelection}>{t("canvas.references.selectingHint")}</button> : null}

                    {selectionBox ? (
                        <svg
                            className="pointer-events-none absolute z-[100] overflow-visible"
                            style={{
                                left: Math.min(selectionBox.startWorldX, selectionBox.currentWorldX),
                                top: Math.min(selectionBox.startWorldY, selectionBox.currentWorldY),
                                width: Math.abs(selectionBox.currentWorldX - selectionBox.startWorldX),
                                height: Math.abs(selectionBox.currentWorldY - selectionBox.startWorldY),
                            }}
                        >
                            <rect width="100%" height="100%" fill={theme.canvas.selectionFill} stroke={theme.canvas.selectionStroke} strokeOpacity={0.55} strokeWidth={1 / viewport.k} strokeDasharray={`${6 / viewport.k} ${4 / viewport.k}`} />
                        </svg>
                    ) : null}
                    {pendingConnectionCreate ? <ConnectionCreateMenu pending={pendingConnectionCreate} onCreate={(type) => createConnectedNode(type, pendingConnectionCreate)} onClose={cancelPendingConnectionCreate} /> : null}
                    {nodeCreatePosition ? (
                        <NodeCreateMenu
                            position={nodeCreatePosition}
                            onCreate={(type) => {
                                createNode(type, nodeCreatePosition);
                                setNodeCreatePosition(null);
                            }}
                            onClose={() => setNodeCreatePosition(null)}
                        />
                    ) : null}
                    <CanvasCollabCursors />
                    <CanvasCollabSelectionOutlines nodes={nodes} />
                </InfiniteCanvas>

                <CanvasNodeHoverToolbar
                    node={isNodeDragging || isNodeResizing || nodeImageSettingsOpen || expandedBatchNodeIds.has(toolbarNode?.id || "") || editingTitleNodeId === toolbarNode?.id ? null : toolbarNode}
                    viewport={viewport}
                    extraTools={toolbarNode ? buildNodeToolbarItems(toolbarNode) : undefined}
                    onKeep={keepNodeToolbar}
                    onLeave={hideNodeToolbar}
                    onInfo={(node) => setInfoNodeId(node.id)}
                    onDecreaseFont={(node) => handleFontSizeChange(node.id, Math.max(10, (node.metadata?.fontSize || 14) - 2))}
                    onIncreaseFont={(node) => handleFontSizeChange(node.id, Math.min(32, (node.metadata?.fontSize || 14) + 2))}
                    onToggleDialog={(node) => setDialogNodeId((current) => (current === node.id ? null : node.id))}
                    onGenerateImage={generateImageFromTextNode}
                    onUpload={(node) => handleUploadRequest(node.id)}
                    onDownload={downloadNodeImage}
                    onSaveAsset={(node) => void saveNodeAsset(node)}
                    onMaskEdit={(node) => setMaskEditNodeId(node.id)}
                    onCrop={(node) => setCropNodeId(node.id)}
                    onSplit={(node) => setSplitNodeId(node.id)}
                    onUpscale={(node) => setUpscaleNodeId(node.id)}
                    onViewImage={handleNodeViewImage}
                    onReversePrompt={createImageReversePromptNodes}
                    onFaceRefine={handleOpenFaceRefineModal}
                    onVideoTimeline={handleOpenVideoTimeline}
                    onDepthVideo={handleOpenDepthVideoModal}
                    onSeparateAudio={handleSeparateAudio}
                    onRetry={handleNodeRetry}
                    onToggleFreeResize={(node) => toggleNodeFreeResize(node.id)}
                    onDelete={(node) => confirmDeleteNodes(new Set([node.id]))}
                    onSelectGroupChildren={(node) => handleSelectGroupChildren(node.id)}
                    onCaptureGroupNodes={(node) => handleCaptureGroupNodes(node.id)}
                    onFitGroup={(node) => handleFitGroup(node.id)}
                    onUngroup={(node) => ungroupSelected(node.id)}
                    onSaveGroupAsset={(node) => void saveGroupAsset(node)}
                    onToggleGroupCollapse={(node) => toggleGroupCollapse(node.id)}
                    onToggleGroupLock={(node) => toggleGroupLock(node.id)}
                />

                {isViewer ? (
                    <div
                        className="pointer-events-auto absolute bottom-6 left-1/2 z-40 flex -translate-x-1/2 items-center gap-3 rounded-2xl px-4 py-2.5 shadow-lg backdrop-blur"
                        style={{
                            background: theme.toolbar.panel,
                            border: `1px solid ${theme.toolbar.border}`,
                            color: theme.node.text,
                        }}
                    >
                        <span className="flex items-center gap-2 text-xs font-medium">
                            <span className="relative flex size-2">
                                <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                                <span className="relative inline-flex size-2 rounded-full bg-emerald-500" />
                            </span>
                            <span>{t("canvas.collabWatchMode.badge")}</span>
                        </span>
                        <span className="h-4 w-px bg-stone-300 dark:bg-stone-700" />
                        <span className="text-xs opacity-60">{t("canvas.collabWatchMode.tip")}</span>
                    </div>
                ) : (
                    <CanvasToolbar
                        selectedCount={selectedNodeIds.size}
                        interruptedSelectedCount={selectedInterruptedNodes.length}
                        canvasTool={canvasTool}
                        canUndo={historyState.canUndo}
                        canRedo={historyState.canRedo}
                        backgroundMode={backgroundMode}
                        showImageInfo={showImageInfo}
                        onAddImage={() => createNode(CanvasNodeType.Image)}
                        onAddVideo={() => createNode(CanvasNodeType.Video)}
                        onAddAudio={() => createNode(CanvasNodeType.Audio)}
                        onAddText={() => createNode(CanvasNodeType.Text)}
                        onAddConfig={() => createNode(CanvasNodeType.Config)}
                        onAddGroup={groupSelectedNodes}
                        onAddExtensionNode={(type) => createNode(type)}
                        onUndo={undoCanvas}
                        onRedo={redoCanvas}
                        onUpload={() => handleUploadRequest()}
                        onDelete={() => confirmDeleteNodes(new Set(selectedNodeIds))}
                        onClear={() => setClearConfirmOpen(true)}
                        onRetryInterrupted={() => void handleBatchRetryInterrupted(selectedInterruptedNodes)}
                        onCanvasToolChange={setCanvasTool}
                        onBackgroundModeChange={setBackgroundMode}
                        onShowImageInfoChange={setShowImageInfo}
                    />
                )}

                {isMiniMapOpen ? <Minimap nodes={collapsedNodeIds.size ? nodes.filter((node) => !collapsedNodeIds.has(node.id)) : nodes} viewport={viewport} viewportSize={size} onViewportChange={setViewport} /> : null}

                <CanvasZoomControls
                    scale={viewport.k}
                    onScaleChange={setZoomScale}
                    onReset={resetViewport}
                    onFit={() => fitView(false)}
                    isMiniMapOpen={isMiniMapOpen}
                    onToggleMiniMap={() => setIsMiniMapOpen((value) => !value)}
                />

                {selectionToolbar ? (
                    <CanvasSelectionToolbar
                        left={selectionToolbar.left}
                        top={selectionToolbar.top}
                        placement={selectionToolbar.placement}
                        count={selectionToolbar.count}
                        onAlign={handleAlignNodes}
                        onDistribute={handleDistributeNodes}
                    />
                ) : null}

                {projectLoaded && nodes.length === 0 ? (
                    <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center px-8">
                        <div
                            className="pointer-events-auto w-full max-w-md rounded-2xl border border-dashed px-8 py-7 text-center shadow-sm backdrop-blur"
                            style={{ borderColor: theme.node.stroke, background: theme.toolbar.panel, color: theme.node.text }}
                        >
                            <div className="text-base font-medium">{t("canvas.emptyState.title")}</div>
                            <p className="mt-2 text-sm leading-relaxed" style={{ color: theme.node.muted }}>
                                {t("canvas.emptyState.body")}
                            </p>
                            <div className="mt-4 flex items-center justify-center gap-2">
                                <Button onClick={() => handleUploadRequest()}>{t("canvas.emptyState.upload")}</Button>
                                <Button type="primary" onClick={() => openAgentPanel()}>
                                    {t("canvas.emptyState.agent")}
                                </Button>
                            </div>
                        </div>
                    </div>
                ) : null}

                {contextMenu ? (
                    <CanvasNodeContextMenu
                        menu={contextMenu}
                        canCaptureVideoFrame={contextMenuNode?.type === CanvasNodeType.Video && Boolean(contextMenuNode.metadata?.content)}
                        isGroupNode={contextMenuNode?.type === CanvasNodeType.Group}
                        canGroupSelection={selectedNodeIds.size > 1 || (selectedNodeIds.size === 1 && contextMenuNode?.type !== CanvasNodeType.Group)}
                        canSplitBatchImages={contextMenuNode?.type === CanvasNodeType.Image && (contextMenuNode.metadata?.images?.length || 0) > 1}
                        onClose={() => setContextMenu(null)}
                        onCaptureVideoFrame={(position) => {
                            if (contextMenu.type !== "node") return;
                            void captureVideoNodeFrame(contextMenu.nodeId, position);
                        }}
                        onSplitBatchImages={() => {
                            if (contextMenuNode) handleSplitBatchImages(contextMenuNode);
                        }}
                        onDuplicate={() => {
                            if (contextMenu.type !== "node") return;
                            duplicateNode(contextMenu.nodeId);
                            setContextMenu(null);
                        }}
                        onGroup={() => {
                            groupSelectedNodes();
                            setContextMenu(null);
                        }}
                        onUngroup={() => {
                            if (contextMenuNode) ungroupSelected(contextMenuNode.id);
                            setContextMenu(null);
                        }}
                        onSelectGroupChildren={() => {
                            if (contextMenuNode) handleSelectGroupChildren(contextMenuNode.id);
                            setContextMenu(null);
                        }}
                        onCaptureGroupNodes={() => {
                            if (contextMenuNode) handleCaptureGroupNodes(contextMenuNode.id);
                            setContextMenu(null);
                        }}
                        onFitGroup={() => {
                            if (contextMenuNode) handleFitGroup(contextMenuNode.id);
                            setContextMenu(null);
                        }}
                        onSaveGroupAsset={() => {
                            if (contextMenuNode) void saveGroupAsset(contextMenuNode);
                            setContextMenu(null);
                        }}
                        groupCollapsed={Boolean(contextMenuNode?.metadata?.collapsed)}
                        groupLocked={Boolean(contextMenuNode?.metadata?.locked)}
                        onToggleGroupCollapse={() => {
                            if (contextMenuNode) toggleGroupCollapse(contextMenuNode.id);
                            setContextMenu(null);
                        }}
                        onToggleGroupLock={() => {
                            if (contextMenuNode) toggleGroupLock(contextMenuNode.id);
                            setContextMenu(null);
                        }}
                        onDelete={() => {
                            if (contextMenu.type === "node") {
                                const targetIds = selectedNodeIds.has(contextMenu.nodeId)
                                    ? new Set(selectedNodeIds)
                                    : new Set([contextMenu.nodeId]);
                                confirmDeleteNodes(targetIds);
                            } else {
                                deleteConnection(contextMenu.connectionId);
                            }
                            setContextMenu(null);
                        }}
                    />
                ) : null}

                <input ref={imageInputRef} type="file" multiple accept="image/*,video/*,audio/mpeg,audio/wav,audio/x-wav,.mp3,.wav" className="hidden" onChange={handleImageInputChange} />

                <CanvasNodeInfoModal node={infoNode} open={Boolean(infoNode)} onClose={() => setInfoNodeId(null)} />
                <CanvasPluginManagerModal open={pluginManagerOpen} onClose={() => setPluginManagerOpen(false)} />

                {cropNode?.metadata?.content ? <CanvasNodeCropDialog dataUrl={cropNode.metadata.content} open={Boolean(cropNode)} onClose={() => setCropNodeId(null)} onConfirm={(crop) => void cropImageNode(cropNode!, crop)} /> : null}

                {maskEditNode?.metadata?.content ? (
                    <CanvasNodeMaskEditDialog
                        dataUrl={maskEditNode.metadata.content}
                        open={Boolean(maskEditNode)}
                        onClose={() => setMaskEditNodeId(null)}
                        onConfirm={(payload) => void maskEditImageNode(maskEditNode!, payload)}
                        inpaintOptions={inpaintOptions}
                        defaultModel={effectiveConfig.imageModel}
                        defaultChannelId={maskEditNode.metadata.channelId}
                        defaultWorkflowId={maskEditNode.metadata.workflowId}
                    />
                ) : null}

                {splitNode?.metadata?.content ? <CanvasNodeSplitDialog dataUrl={splitNode.metadata.content} open={Boolean(splitNode)} onClose={() => setSplitNodeId(null)} onConfirm={(params) => void splitImageNode(splitNode!, params)} /> : null}

                {upscaleNode?.metadata?.content ? (
                    <CanvasNodeUpscaleDialog dataUrl={upscaleNode.metadata.content} open={Boolean(upscaleNode)} onClose={() => setUpscaleNodeId(null)} onConfirm={(params) => void upscaleImageNode(upscaleNode!, params)} />
                ) : null}

                <CanvasVideoTimelineModal
                    open={Boolean(videoTimelineNode)}
                    node={videoTimelineNode}
                    imageNodes={videoTimelineCastImages}
                    submitting={videoTimelineSubmitting}
                    onClose={() => {
                        if (!videoTimelineSubmitting) setVideoTimelineNode(null);
                    }}
                    onSubmit={(plan) => void handleVideoEditSubmit(plan)}
                />

                <CanvasFaceRefineModal
                    open={Boolean(faceRefineNode)}
                    node={faceRefineNode}
                    upstreamImageNodes={faceRefineUpstreamImages}
                    onClose={() => setFaceRefineNode(null)}
                    onConfirm={(payload) => {
                        if (faceRefineNode) {
                            void handleExecuteFaceRefine(faceRefineNode, payload);
                        }
                    }}
                />

                <CanvasDepthVideoModal
                    open={Boolean(depthVideoNode)}
                    node={depthVideoNode}
                    onClose={() => setDepthVideoNode(null)}
                    onConfirm={(payload) => {
                        if (depthVideoNode) {
                            void handleExecuteDepthVideo(depthVideoNode, payload);
                        }
                    }}
                />

                <Modal
                    title={previewNode?.type === CanvasNodeType.Video ? t("canvas.projectPage.videoDetails") : t("canvas.projectPage.imageDetails")}
                    open={Boolean(previewContent)}
                    centered
                    destroyOnHidden
                    onCancel={handleClosePreview}
                    footer={null}
                    width="auto"
                    styles={{ body: { padding: 0, display: "flex", justifyContent: "center", alignItems: "center", maxHeight: "80vh" } }}
                >
                    {previewContent ? (
                        previewNode?.type === CanvasNodeType.Video ? (
                            <CanvasPreviewVideo src={previewContent} />
                        ) : (
                            <img src={previewContent} alt={previewNode?.title || t("assets.kinds.image")} style={{ maxWidth: "100%", maxHeight: "80vh", objectFit: "contain" }} />
                        )
                    ) : null}
                </Modal>

                <Modal
                    title={t("canvas.projectPage.clearTitle")}
                    open={clearConfirmOpen}
                    centered
                    onCancel={() => setClearConfirmOpen(false)}
                    footer={
                        <>
                            <Button onClick={() => setClearConfirmOpen(false)}>{t("common.cancel")}</Button>
                            <Button danger type="primary" onClick={clearCanvas}>
                                {t("canvas.projectPage.clear")}
                            </Button>
                        </>
                    }
                >
                    <p className="text-sm opacity-60">{t("canvas.projectPage.clearDescription")}</p>
                </Modal>

                {deleteConfirmNodes ? (
                    <Modal
                        title={
                            deleteConfirmNodes.size > 1
                                ? t("canvas.node.confirmDeleteMultipleTitle", { count: deleteConfirmNodes.size })
                                : t("canvas.node.confirmDeleteSingleTitle")
                        }
                        open={true}
                        centered
                        destroyOnHidden
                        onCancel={(e) => {
                            e?.stopPropagation();
                            setDeleteConfirmNodes(null);
                        }}
                        footer={
                            <>
                                <Button
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        setDeleteConfirmNodes(null);
                                    }}
                                >
                                    {t("common.cancel")}
                                </Button>
                                <Button
                                    danger
                                    type="primary"
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        handleConfirmDeleteNodes();
                                    }}
                                >
                                    {t("common.delete")}
                                </Button>
                            </>
                        }
                    >
                        <p className="text-sm opacity-60">
                            {deleteConfirmNodes.size > 1
                                ? t("canvas.node.confirmDeleteMultipleContent", { count: deleteConfirmNodes.size })
                                : t("canvas.node.confirmDeleteSingleContent")}
                        </p>
                    </Modal>
                ) : null}

                <AssetPickerModal open={assetPickerOpen} onInsert={handleAssetInsert} onClose={() => setAssetPickerOpen(false)} />
                <CanvasCollabModal
                    projectId={projectId}
                    projectTitle={currentProject?.title || ""}
                    onStartCollab={handleStartCollab}
                    onStopCollab={handleStopCollab}
                />
            </section>
        </main>
    );
}
