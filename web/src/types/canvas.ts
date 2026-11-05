import type { BuiltinPromptSkillId } from "@/lib/canvas/prompt-skills";
import type { ModelSupportedTools } from "@/services/api/models/types";

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
    queuePosition?: number;
    networkRetryText?: string;
    progressPct?: number;
    progressNodeClassType?: string;
    progressNodeStep?: number;
    progressNodeSteps?: number;
    isTimeout?: boolean;
};

export type CanvasNodeText = {
    id: string;
    status: CanvasNodeStatus;
    errorDetails?: string;
    content: string;
    jobId?: string;
    queuePosition?: number;
    networkRetryText?: string;
    progressPct?: number;
    progressNodeClassType?: string;
    progressNodeStep?: number;
    progressNodeSteps?: number;
    isTimeout?: boolean;
};

/**
 * 角色参考图快照。
 *
 * 段节点上的参考图片集是运行时构造的（勾选的角色图 + 从原片抽的首尾帧），
 * 它不体现为画布连线。要把它们"记在节点上"，否则用户点开一段只能看到结果与
 * 一句提示词，没法核对"当时到底喂了谁"。同理，节点被删后仍能说清用过哪几张图。
 */
export type CanvasVideoSegmentCast = {
    nodeId: string;
    title?: string;
    url?: string;
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
    /** 角色参考图的快照（节点 id / 标题 / 图片地址），勾选顺序即模型看到的 ref_image_01..0N 顺序。 */
    castSnapshot?: CanvasVideoSegmentCast[];
    /**
     * 生成本段时吃的首帧/尾帧约束（解释「为什么无缝」，也便于复现）。
     *
     * firstFrameMs/lastFrameMs 是区间边界；headFrameMs/tailFrameMs 是**实际抽帧**的时间点
     * ——尾帧为了避免抽到区间外的那一帧，会往回收几十毫秒。两个值都要记，
     * 否则重跑时抽到的帧跟首次不是同一张，接缝就对不上。
     */
    anchor?: { firstFrameMs?: number; lastFrameMs?: number; headFrameMs?: number; tailFrameMs?: number };
    /** 这一段实际吃进去的参考片段（切出来的那一段）。 */
    referenceClip?: { nodeId?: string; url?: string; storageKey?: string; durationMs?: number };
    /** 本段提示词的来源：段级覆盖 / 沿用全局。面板上要能说清"我改的是这一段还是所有段"。 */
    promptSource?: "segment" | "global";
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
    /**
     * 合成参数快照。单段重跑后要重新拼一遍成片，而这几个参数只存在于当时的提交里 ——
     * 不记下来就只能猜（猜错的表现是音画不同步、或接缝突然发虚）。
     */
    mode?: "repaint" | "character-swap";
    keepAudio?: boolean;
    endAtCut?: boolean;
    durationMs?: number;
};

export type CanvasNodeMetadata = {
    content?: string;
    composerContent?: string;
    prompt?: string;
    effectivePrompt?: string;
    generationReferences?: CanvasGenerationReferenceSnapshot[];
    generationOriginNodeId?: string;
    jobId?: string;
    queuePosition?: number;
    networkRetryText?: string;
    progressPct?: number;
    progressNodeClassType?: string;
    progressNodeStep?: number;
    progressNodeSteps?: number;
    isTimeout?: boolean;
    status?: CanvasNodeStatus;
    /**
     * 分段任务的排队位置（仅段节点用）。
     *
     * 一提交就把这一拨的段节点全部铺到画布上，轮到谁谁从 waiting 变 running ——
     * 否则用户点完"重绘"只能盯着空画布，等第一段切完才看见第一个节点。
     */
    queueState?: "waiting" | "running";
    errorDetails?: string;
    fontSize?: number;
    generationMode?: CanvasGenerationMode;
    generationType?: CanvasImageGenerationType;
    channelId?: string;
    workflowId?: string;
    model?: string;
    modelId?: string;
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
    /**
     * 音频节点的产线：配乐还是配音。
     *
     * 不新造节点类型 —— 音频节点已经有播放器、能连线、能被视频当参考上游、能被 agent 创建，
     * 缺的只是面板和绑定的分流。缺省按 `music` 处理，历史节点零迁移。
     * 升级阈值：等需要「按句切分 + 逐句重跑」时再独立成节点。
     */
    audioKind?: "music" | "voice";
    /** 台词。复用 `prompt` 存放，这里只是标记它同时是"要念的内容"。 */
    voiceScript?: string;
    /** 选中的音色卡 id（空表示用户上传的自定义音色）。 */
    voiceId?: string;
    /** 音色显示名，画布上扫一眼能分清谁在说话。 */
    voiceName?: string;
    /** 音色头像（压缩后的 webp 路径）。 */
    voiceAvatar?: string;
    /**
     * 音色音频的取用地址（内置卡是 public 下的路径，自定义音色是媒体库地址）。
     *
     * 记它是因为生成前要把音频送到 ComfyUI 的 input 目录，而这件事必须能重新做一遍：
     * 用户清了 input 目录、换了台 ComfyUI，`voiceAudioName` 就失效了。
     */
    voiceSource?: string;
    /**
     * 已上传到 ComfyUI input 目录的音色文件名。
     *
     * 存下来是为了不每次生成都重传（上传会加随机前缀，重传等于换文件、白占磁盘）。
     * 但它不代表"文件还在" —— 用户清了 input 目录或换了台 ComfyUI，
     * 这里仍会有值，所以生成前还要用 `/object_info/LoadAudio` 核一遍。
     */
    voiceAudioName?: string;
    /** 音色自带的情绪模式：text 用情绪描述，speaker 跟随音色参考（此时情绪框不生效）。 */
    voiceEmoMode?: "text" | "speaker";
    /** 情绪描述（给 IndexTTS 的一句自然语言）。留空则由模型按台词自行推断。 */
    emotionText?: string;
    /** 情绪强度，跟着音色卡走，可微调。 */
    emotionStrength?: number;
    /**
     * 视频节点上每条音频入边的用途，键是上游音频节点 id。
     *
     * 只有用户手动切过的才记在这里，没记的按上游的 `audioKind` 推断（配音=音轨，
     * 音乐=参考）。之所以不给每条连线都写一份：连线本身没有持久化的自定义字段，
     * 而"默认值随上游变"比"连上那一刻的快照"更符合直觉——上游从音乐改成配音，
     * 下游用途应该跟着变。
     */
    audioEdgeModes?: Record<string, "reference" | "track">;
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
    /** 视频节点：当前模型支持的工具（上游按模型能力动态出 UI）。 */
    supportedTools?: ModelSupportedTools;
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
