import type { BuiltinPromptSkillId } from "@/lib/canvas/prompt-skills";

export type Position = {
    x: number;
    y: number;
};

export type ViewportTransform = {
    x: number;
    y: number;
    k: number;
};

export enum CanvasNodeType {
    Image = "image",
    Text = "text",
    Config = "config",
    Video = "video",
    Audio = "audio",
    Group = "group",
}

// Node types are open strings: built-ins use CanvasNodeType and plugins use "<pluginId>:<name>".
export type CanvasNodeTypeId = CanvasNodeType | (string & {});

export type CanvasNodeStatus = "idle" | "success" | "loading" | "error";
export type CanvasGenerationMode = "text" | "image" | "video" | "audio";
export type CanvasGenerationIntent = "new" | "repeat" | "retry" | "resume";
export type CanvasImageGenerationType = "generation" | "edit";

export type CanvasGenerationReferenceSnapshot = {
    nodeId: string;
    kind: "image" | "video" | "audio" | "text";
    storageKey?: string;
    url?: string;
    text?: string;
    mimeType?: string;
};

export type CanvasNodeImage = {
    id: string;
    status: CanvasNodeStatus;
    errorDetails?: string;
    content: string;
    storageKey: string;
    naturalWidth: number;
    naturalHeight: number;
    bytes: number;
    mimeType: string;
    seed?: number;
    jobId?: string;
    isTimeout?: boolean;
};

export type CanvasNodeText = {
    id: string;
    status: CanvasNodeStatus;
    errorDetails?: string;
    content: string;
    jobId?: string;
    isTimeout?: boolean;
};

/** 长视频分段处理：本节点是源视频中某个时间区间的一段。 */
export type CanvasVideoSegment = {
    /** 源视频节点 id。 */
    sourceNodeId: string;
    /** 源视频总时长（毫秒），用于合成时校验与展示。 */
    sourceDurationMs?: number;
    /** 本段在源视频中的起止（毫秒，左闭右开）。 */
    startMs: number;
    endMs: number;
    /** 拼接顺序，0 起。 */
    index: number;
    /** 本段首帧是否落在场景切点上；落在切点上时合成不做交叉淡化。 */
    sceneStart?: boolean;
    /** 段的生成方式：局部重绘 / 角色替换。 */
    mode: "repaint" | "character-swap";
    /** 本段实际参与生成的角色参考图节点 id。单段重试时按同一套参考重来，角色才跟同批其他段一致。 */
    castNodeIds?: string[];
    /** 生成本段时吃的首帧/尾帧约束（解释「为什么无缝」，也便于复现）。 */
    anchor?: { firstFrameMs?: number; lastFrameMs?: number };
    /**
     * 生成结果与原片段的目标时长之差（毫秒）。超过 500ms 才记录。
     *
     * 合成时会按目标时长归一化（多了截断、少了冻结尾帧），节奏不会错，
     * 但差得多说明这段内容没生成完整 —— 记下来让用户能看见、决定是否重做。
     */
    durationDriftMs?: number;
};

/**
 * 切出来送给模型的参考片段。
 *
 * 落成画布节点是为了让人能检查：模型到底吃了什么、这段里有几个人、
 * 时长多少。切点只按画面变化算，算不出"这段里有几个人"，
 * 逐段勾角色之前总得先看看这段的内容。
 */
export type CanvasVideoReferenceClip = {
    /** 源视频节点 id。 */
    sourceNodeId: string;
    /** 本段在源视频中的起止（毫秒，左闭右开）。 */
    startMs: number;
    endMs: number;
};

/** 长视频合成节点：按 partNodeIds 顺序拼接成完整成片。 */
export type CanvasVideoComposite = {
    partNodeIds: string[];
    /** 段间交叉淡化时长（毫秒），0 表示硬切。 */
    crossfadeMs: number;
    /** 源视频节点，便于追溯。 */
    sourceNodeId?: string;
};

export type CanvasNodeMetadata = {
    content?: string;
    composerContent?: string;
    prompt?: string;
    effectivePrompt?: string;
    generationReferences?: CanvasGenerationReferenceSnapshot[];
    generationOriginNodeId?: string;
    jobId?: string;
    isTimeout?: boolean;
    status?: CanvasNodeStatus;
    errorDetails?: string;
    fontSize?: number;
    generationMode?: CanvasGenerationMode;
    generationType?: CanvasImageGenerationType;
    channelId?: string;
    workflowId?: string;
    model?: string;
    reasoningEffort?: "auto" | "low" | "medium" | "high" | "xhigh";
    size?: string;
    quality?: string;
    seed?: number;
    background?: string;
    count?: number;
    textCount?: number;
    texts?: CanvasNodeText[];
    primaryTextId?: string;
    seconds?: string;
    videoMode?: string;
    vquality?: string;
    generateAudio?: string;
    watermark?: string;
    audioVoice?: string;
    audioFormat?: string;
    audioSpeed?: string;
    audioInstructions?: string;
    references?: string[];
    naturalWidth?: number;
    naturalHeight?: number;
    freeResize?: boolean;
    images?: CanvasNodeImage[];
    primaryImageId?: string;
    storageKey?: string;
    mimeType?: string;
    bytes?: number;
    durationMs?: number;
    groupId?: string;
    /** 文本节点：最近一次用提示词助手改写时用的配置（后端/技能/模型等），便于重复与溯源。 */
    promptAssistant?: {
        backend: "comfyui" | "agent";
        agentId?: string;
        model?: string;
        effort?: string;
        // 与 lib/canvas/canvas-prompt-assistant 的 PromptAssistantSkillRef 同构（types 层不反向依赖 lib）。
        skill?: { kind: "builtin"; id: BuiltinPromptSkillId } | { kind: "agent"; name: string; path: string };
        instruction?: string;
        optimizedAt?: string;
    };
    collapsed?: boolean; // Group node: hide descendants (and their connections), render a compact title bar.
    locked?: boolean; // Group node: block drag/resize/delete/connect for the group and its descendants.
    interactive?: boolean; // Plugin node interaction/move state; see CanvasNodeDefinition.interactionToggle.
    /** 视频节点：本节点是长视频里的一段（分段重绘 / 角色替换的产物）。 */
    videoSegment?: CanvasVideoSegment;
    /** 视频节点：由若干段按顺序拼成的成片。 */
    videoComposite?: CanvasVideoComposite;
    /** 视频节点：从源片切出来、作为生成输入的参考片段（非结果，供人工检查）。 */
    referenceClip?: CanvasVideoReferenceClip;
};

export type CanvasNodeData = {
    id: string;
    type: CanvasNodeTypeId;
    title: string;
    position: Position;
    width: number;
    height: number;
    metadata?: CanvasNodeMetadata;
};

export type CanvasGroupKind = "image" | "video" | "audio" | "text" | "other";

/** Aggregated view of a group's subtree, rendered on the group node so a collapsed group still tells you what is inside. */
export type CanvasGroupSummary = {
    count: number;
    kinds: Record<CanvasGroupKind, number>;
    /** Up to 4 members with a preview source, images first. */
    previews: { id: string; kind: CanvasGroupKind; src?: string }[];
    running: number;
    failed: number;
};

export type CanvasConnectionKind = "input" | "lineage";

/** 首尾帧视频节点的显式槽位；不依赖连线先后顺序。 */
export type CanvasFrameSlot = "first_frame" | "last_frame";

export type CanvasConnection = {
    id: string;
    fromNodeId: string;
    toNodeId: string;
    kind: CanvasConnectionKind;
    slot?: CanvasFrameSlot;
};

export type CanvasAssistantReference = {
    id: string;
    type: CanvasNodeTypeId;
    title: string;
    dataUrl?: string;
    storageKey?: string;
    text?: string;
};

export type CanvasAssistantImage = {
    id: string;
    dataUrl: string;
    storageKey?: string;
    prompt: string;
};

export type CanvasAssistantMessage = {
    id: string;
    role: "user" | "assistant" | "system" | "tool" | "error";
    title?: string;
    text: string;
    meta?: string;
    detail?: unknown;
    references?: CanvasAssistantReference[];
};

export type CanvasAssistantSession = {
    id: string;
    title: string;
    messages: CanvasAssistantMessage[];
    createdAt: string;
    updatedAt: string;
};

export type ConnectionHandle = {
    nodeId: string;
    handleType: "source" | "target";
};

export type SelectionBox = {
    startWorldX: number;
    startWorldY: number;
    currentWorldX: number;
    currentWorldY: number;
    additive: boolean;
    initialSelectedNodeIds: string[];
};

export type ContextMenuState =
    | {
          type: "node";
          x: number;
          y: number;
          nodeId: string;
      }
    | {
          type: "connection";
          x: number;
          y: number;
          connectionId: string;
      };
