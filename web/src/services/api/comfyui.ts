import localforage from "localforage";

import { nanoid } from "nanoid";
import i18n from "@/i18n";
import { findWorkflow, getDefaultWorkflow, modelOptionName, resolveModelChannel, resolveModelRequestConfig, type AiConfig, type ChannelModel, type ComfyuiWorkflow, type ModelChannel, type WorkflowCategory } from "@/stores/use-config-store";
import { resolveExecutionWorkflow } from "@/lib/canvas/workflow-resolution";
import {
    DEFAULT_COMFYUI_FRAME_VIDEO_WORKFLOW,
    DEFAULT_COMFYUI_I2I_WORKFLOW,
    DEFAULT_COMFYUI_INPAINT_WORKFLOW,
    DEFAULT_COMFYUI_T2I_WORKFLOW,
    DEFAULT_COMFYUI_TEXT_WORKFLOW,
    DEFAULT_COMFYUI_VIDEO_WORKFLOW,
    getWorkflowForModelProfile,
} from "./comfyui-default-workflows";
import type { ReferenceImage } from "@/types/image";
import type { ReferenceAudio, ReferenceVideo } from "@/types/media";

export { formatIngestSuccessMessage, ingestWorkflow, type IngestOptions, type IngestResult, type DetectedSlotInfo, type AmbiguityInfo } from "./comfyui-adapter";
import {
    dispatchComfyuiModelWorkflow,
    getModelProfile,
    validateModelExecution,
    IMAGE_RESOLUTION_PRESETS,
    type ImageResolutionTier,
    type ImageAspectRatio,
} from "./models";
export * from "./models";

export type ComfyuiSize = {
    width: number;
    height: number;
};

const DEFAULT_SIZE: ComfyuiSize = { width: 512, height: 512 };
/** Hard ceiling per side for explicit pixel sizes; beyond this the input is treated as invalid. */
const MAX_PIXEL = 8192;

const PIXEL_SIZE_PATTERN = /^(\d+)\s*[x×]\s*(\d+)$/;
const RATIO_PATTERN = /^(\d+)\s*:\s*(\d+)(?:\s*[-_]\s*(1k|2k|4k))?$/i;

function roundToEven(value: number) {
    return Math.max(2, Math.round(value / 2) * 2);
}

/**
 * Parse an image size setting into pixel dimensions.
 * Accepts "auto"/empty (falls back to 512x512 1K), pixel sizes ("512x512", "1024x1024"),
 * and standard aspect ratios ("1:1", "16:9", "16:9-2k", "9:16-4k" matching 64px-aligned presets).
 * Anything else throws.
 */
export function parseSize(size?: string): ComfyuiSize {
    const value = (size || "").trim();
    if (!value || value.toLowerCase() === "auto") return { ...DEFAULT_SIZE };
    const pixelMatch = PIXEL_SIZE_PATTERN.exec(value);
    if (pixelMatch) {
        const widthRaw = Number(pixelMatch[1]);
        const heightRaw = Number(pixelMatch[2]);
        if (widthRaw <= 0 || heightRaw <= 0) throw new Error(`Invalid image size: ${value}`);
        const width = roundToEven(widthRaw);
        const height = roundToEven(heightRaw);
        if (width > MAX_PIXEL || height > MAX_PIXEL) throw new Error(`Invalid image size: ${value}`);
        return { width, height };
    }
    const ratioMatch = RATIO_PATTERN.exec(value);
    if (ratioMatch) {
        const a = Number(ratioMatch[1]);
        const b = Number(ratioMatch[2]);
        if (a <= 0 || b <= 0) throw new Error(`Invalid image size: ${value}`);
        const tier = (ratioMatch[3]?.toLowerCase() || "1k") as ImageResolutionTier;
        const ratioKey = `${a}:${b}` as ImageAspectRatio;
        const preset = IMAGE_RESOLUTION_PRESETS[tier]?.[ratioKey];
        if (preset) {
            return { width: preset.width, height: preset.height };
        }
        const base = tier === "4k" ? 2048 : tier === "2k" ? 1024 : 512;
        return a >= b
            ? { width: roundToEven((base * a) / b), height: base }
            : { width: base, height: roundToEven((base * b) / a) };
    }
    throw new Error(`Invalid image size: ${value}`);
}

function blobToDataUrl(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(new Error("Failed to read image"));
        reader.readAsDataURL(blob);
    });
}

export type ComfyuiWorkflowJson = Record<string, unknown>;

export type ComfyuiBindings = {
    prompt?: string;
    width?: number;
    height?: number;
    seed?: number;
    refImages?: string[];
    refMask?: string;
};

type WorkflowNodeRecord = {
    class_type?: string;
    inputs?: Record<string, unknown>;
    _meta?: { title?: unknown };
};

/**
 * _meta.title 槽位名 → class_type → inputs 键。
 *
 * 这里只放"这个 class_type 明确该写哪个键"的映射；表里没有的 class_type 走
 * SLOT_FALLBACK_KEYS 的顺序猜测。导入校验与绑定的键解析共用一份，避免两边判断不一致。
 */
const BINDING_TITLE_TO_INPUT_SLOT: Record<string, Record<string, string>> = {
    prompt: { CLIPTextEncode: "text", PrimitiveStringMultiline: "value", PrimitiveString: "value", TextEncodeBooguEdit: "prompt", TextEncodeQwenImageEditPlus: "prompt" },
    width: { PrimitiveInt: "value", PrimitiveFloat: "value" },
    height: { PrimitiveInt: "value", PrimitiveFloat: "value" },
    seed: { KSampler: "seed", KSamplerAdvanced: "noise_seed", PrimitiveInt: "value", PrimitiveFloat: "value" },
    ref_image: { LoadImage: "image", LoadImageMask: "image" },
    ref_mask: { LoadImage: "image", LoadImageMask: "image" },
    ref_video: { LoadVideo: "file", VHS_LoadVideo: "video" },
    ref_audio: { LoadAudio: "audio" },
    caption: { PrimitiveStringMultiline: "value", PrimitiveString: "value", CLIPTextEncode: "text" },
    lyrics: { PrimitiveStringMultiline: "value", PrimitiveString: "value", CLIPTextEncode: "text" },
    // 情绪描述与强度：IndexTTS 类工作流把台词/情绪抽成字符串节点，情绪只喂一句自然语言。
    emotion: { PrimitiveStringMultiline: "value", PrimitiveString: "value" },
    strength: { PrimitiveFloat: "value", PrimitiveInt: "value" },
    duration: { Float: "Number", PrimitiveInt: "value", PrimitiveFloat: "value" },
};

/** 无 class_type 映射时按顺序尝试的输入键，顺序即优先级。 */
const SLOT_FALLBACK_KEYS: Record<string, string[]> = {
    prompt: ["value", "text", "prompt"],
    caption: ["value", "text", "caption"],
    lyrics: ["value", "text", "lyrics"],
    emotion: ["value", "text", "emotion_text", "emotion"],
    strength: ["value", "strength"],
    width: ["value", "width"],
    height: ["value", "height"],
    seed: ["seed", "noise_seed", "value"],
    duration: ["Number", "value", "duration", "seconds", "max_duration", "frames"],
    ref_image: ["image"],
    ref_mask: ["image"],
    ref_video: ["file", "video"],
    ref_audio: ["audio", "file"],
    first_frame: ["image"],
    last_frame: ["image"],
};

/** 参考类槽位：ref_image_01 / ref_video_02 / ref_audio_01。无编号按 01 处理，兼容早期只标 ref_audio 的流程。 */
const REF_SLOT_PATTERN = /^(ref_image|ref_video|ref_audio)(?:_(\d{1,2}))?$/;

const REF_SLOT_DEFAULT_KEY: Record<string, string> = {
    ref_image: "image",
    ref_video: "file",
    ref_audio: "audio",
};

/** 是否是我们认识的槽位名（产物标记 output_* 与自定义 title 不在其列）。 */
export function isKnownSlotTitle(rawTitle: string): boolean {
    const title = rawTitle.trim().toLowerCase();
    if (REF_SLOT_PATTERN.test(title)) return true;
    return Boolean(SLOT_FALLBACK_KEYS[title]);
}

/**
 * 解析槽位应当写进哪个 inputs 键。返回 undefined 表示"这个节点没有可写的输入"。
 */
export function resolveSlotInputKey(rawTitle: string, record: WorkflowNodeRecord): string | undefined {
    const title = rawTitle.trim().toLowerCase();
    const inputs = record.inputs || {};
    const classType = record.class_type || "";
    const refMatch = REF_SLOT_PATTERN.exec(title);
    const slotName = refMatch ? refMatch[1] : title;

    const mapped = BINDING_TITLE_TO_INPUT_SLOT[slotName]?.[classType];
    if (mapped && mapped in inputs) return mapped;

    for (const key of SLOT_FALLBACK_KEYS[slotName] || []) {
        if (key in inputs) return key;
    }
    if (refMatch && REF_SLOT_DEFAULT_KEY[slotName] in inputs) return REF_SLOT_DEFAULT_KEY[slotName];
    return undefined;
}

/**
 * 把值写进槽位节点自己的 inputs。
 *
 * 两条铁律，都是为了把「提交成功但参数没生效」变成能看见的错误：
 * 1. 目标键当前是数组 = 它是一条连线（`["8", 0]`）。写字符串会把连线盖掉、源节点变孤儿，
 *    工作流照样跑完，只是那个参数永远停在旧值。这类 bug 从产物上完全看不出来。
 * 2. 类型跟随原值。`mode.strength` 是 float，写成 `"0.85"` 会被 ComfyUI 类型校验拒掉，
 *    而报错指向节点而不是参数，反查成本极高。
 */
export function writeSlot(record: WorkflowNodeRecord, slot: string, value: unknown, label = slot): void {
    if (!record.inputs) return;
    const current = record.inputs[slot];
    if (Array.isArray(current)) {
        throw new ComfyuiError(
            `槽位「${label}」指向 ${record.class_type || "节点"} 的 ${slot}，它是一条连线，不能直接写入。槽位应标在上游的字符串/数值/文件节点上，而不是消费方。`,
        );
    }
    record.inputs[slot] = coerceToOriginalType(current, value);
}

function coerceToOriginalType(current: unknown, value: unknown): unknown {
    if (typeof current === "number") {
        const num = Number(value);
        return Number.isFinite(num) ? num : current;
    }
    if (typeof current === "boolean") return Boolean(value);
    if (typeof current === "string") return typeof value === "string" ? value : String(value ?? "");
    return value;
}

/**
 * Validate a workflow JSON against a specific WorkflowCategory under the strict _meta.title protocol.
 */
export function validateComfyuiWorkflow(
    workflow: unknown,
    category: WorkflowCategory,
): { ok: boolean; error?: string; slots?: string[]; warnings?: string[] } {
    if (typeof workflow !== "object" || workflow === null || Array.isArray(workflow)) {
        return { ok: false, error: "工作流 JSON 必须为对象（ComfyUI API 格式）" };
    }

    type NodeRecord = { class_type?: string; inputs?: Record<string, unknown>; _meta?: { title?: unknown } };
    const nodes = Object.entries(workflow as Record<string, unknown>);
    if (nodes.length === 0) {
        return { ok: false, error: "工作流内容为空" };
    }

    const titleToNodeIds: Record<string, string[]> = {};
    const presentTitles = new Set<string>();

    for (const [nodeId, node] of nodes) {
        if (typeof node !== "object" || node === null) continue;
        const rec = node as NodeRecord;
        const rawTitle = rec._meta?.title;
        if (typeof rawTitle !== "string") continue;
        const title = rawTitle.trim().toLowerCase();
        if (!title) continue;
        presentTitles.add(title);
        if (!titleToNodeIds[title]) titleToNodeIds[title] = [];
        titleToNodeIds[title].push(nodeId);
    }

    // 1. 保留槽位唯一性检查
    const RESERVED_SINGLE_SLOTS = [
        "prompt", "seed", "width", "height", "duration",
        "first_frame", "last_frame", "ref_mask", "mask", "ref_mask_01",
        "output_image", "output_video", "output_text", "output_audio",
        "caption", "lyrics", "emotion", "strength",
    ];

    for (const slot of RESERVED_SINGLE_SLOTS) {
        if (titleToNodeIds[slot] && titleToNodeIds[slot].length > 1) {
            return { ok: false, error: `保留槽位 "${slot}" 标记了多个节点（节点 ID: ${titleToNodeIds[slot].join(", ")}），必须保持唯一` };
        }
    }

    for (const [title, ids] of Object.entries(titleToNodeIds)) {
        if (/^(ref_image_\d+|ref_video_\d+|ref_audio_\d+)$/.test(title) && ids.length > 1) {
            return { ok: false, error: `参考槽位 "${title}" 标记了多个节点（节点 ID: ${ids.join(", ")}），必须保持唯一` };
        }
    }

    // 2. 输出标记检查
    const hasOutputImage = Boolean(titleToNodeIds["output_image"]?.length || titleToNodeIds["out_image"]?.length);
    const hasOutputVideo = Boolean(titleToNodeIds["output_video"]?.length);
    const hasOutputText = Boolean(titleToNodeIds["output_text"]?.length);
    const hasOutputAudio = Boolean(titleToNodeIds["output_audio"]?.length);

    if (category === "t2i" || category === "i2i" || category === "inpaint" || category === "superResolve" || category === "angle" || category === "upscale") {
        if (!hasOutputImage) {
            return { ok: false, error: "生图工作流缺少 \"output_image\" 标记（请在 SaveImage 等保存节点上标记 _meta.title 为 output_image）" };
        }
        if (hasOutputVideo || hasOutputText || hasOutputAudio) {
            return { ok: false, error: "生图工作流不得包含 output_video、output_text 或 output_audio 标记" };
        }
    } else if (category === "omniVideo" || category === "frameVideo" || category === "faceRefine" || category === "depthVideo") {
        if (!hasOutputVideo) {
            return { ok: false, error: "生视频/人脸修复/深度视频工作流缺少 \"output_video\" 标记（请在 SaveVideo 或 VHS_VideoCombine 保存节点上标记 _meta.title 为 output_video）" };
        }
        if (hasOutputImage || hasOutputText || hasOutputAudio) {
            return { ok: false, error: "视频/人脸修复/深度视频工作流不得包含 output_image、output_text 或 output_audio 标记" };
        }
    } else if (category === "text") {
        if (!hasOutputText) {
            return { ok: false, error: "文本工作流缺少 \"output_text\" 标记（请在保存/展示节点上标记 _meta.title 为 output_text）" };
        }
        if (hasOutputImage || hasOutputVideo || hasOutputAudio) {
            return { ok: false, error: "文本工作流不得包含 output_image、output_video 或 output_audio 标记" };
        }
    } else if (category === "audio" || category === "voice") {
        if (!hasOutputAudio) {
            return { ok: false, error: "音频工作流缺少 \"output_audio\" 标记（请在 SaveAudioAdvanced 或 SaveAudio 保存节点上标记 _meta.title 为 output_audio）" };
        }
        if (hasOutputImage || hasOutputVideo || hasOutputText) {
            return { ok: false, error: "音频工作流不得包含 output_image、output_video 或 output_text 标记" };
        }
    }

    // 3. 各分类针对性槽位检查
    const hasPrompt = Boolean(titleToNodeIds["prompt"]?.length);
    const hasRefMask = Boolean(titleToNodeIds["ref_mask"]?.length || titleToNodeIds["mask"]?.length || titleToNodeIds["ref_mask_01"]?.length);
    const hasFirstFrame = Boolean(titleToNodeIds["first_frame"]?.length);
    const hasLastFrame = Boolean(titleToNodeIds["last_frame"]?.length);
    const hasRefImage = Array.from(presentTitles).some((t) => /^ref_image(_\d+)?$/.test(t));
    const hasRefVideo = Array.from(presentTitles).some((t) => /^ref_video(_\d+)?$/.test(t));
    const hasRefAudio = Array.from(presentTitles).some((t) => /^ref_audio(_\d+)?$/.test(t));
    const hasCaption = Boolean(titleToNodeIds["caption"]?.length);
    const hasLyrics = Boolean(titleToNodeIds["lyrics"]?.length);

    switch (category) {
        case "t2i":
            if (!hasPrompt) {
                return { ok: false, error: "文生图工作流缺少 \"prompt\" 提示词槽位节点" };
            }
            if (hasRefMask) {
                return { ok: false, error: "文生图工作流不应包含 \"ref_mask\" 局部重绘槽位（如需局部重绘，请添加为局部编辑工作流）" };
            }
            if (hasFirstFrame || hasLastFrame) {
                return { ok: false, error: "文生图工作流不应包含 first_frame / last_frame 首尾帧槽位" };
            }
            break;

        case "i2i":
            if (!hasPrompt) {
                return { ok: false, error: "图生图工作流缺少 \"prompt\" 提示词槽位节点" };
            }
            if (!hasRefImage) {
                return { ok: false, error: "图生图工作流缺少参考图槽位（至少需标记一个 \"ref_image_01\" 槽位节点）" };
            }
            if (hasRefMask) {
                return { ok: false, error: "图生图工作流不应包含 \"ref_mask\" 局部重绘槽位" };
            }
            break;

        case "inpaint":
            if (!hasRefMask) {
                return { ok: false, error: "局部编辑工作流缺少 \"ref_mask\" 遮罩槽位节点" };
            }
            if (!hasRefImage) {
                return { ok: false, error: "局部编辑工作流缺少 \"ref_image_01\" 底图槽位节点" };
            }
            break;

        case "superResolve":
            if (!hasRefImage) {
                return { ok: false, error: "超分工作流缺少原图输入槽位（至少需标记一个 \"ref_image_01\" 槽位节点）" };
            }
            if (hasRefMask) {
                return { ok: false, error: "超分工作流不应包含 \"ref_mask\" 局部重绘槽位" };
            }
            break;

        case "angle":
            if (!hasRefImage) {
                return { ok: false, error: "多角度工作流缺少基准原图输入槽位（至少需标记一个 \"ref_image_01\" 槽位节点）" };
            }
            if (!hasPrompt) {
                return { ok: false, error: "多角度工作流缺少 \"prompt\" 视角描述/相机参数槽位节点" };
            }
            if (hasRefMask) {
                return { ok: false, error: "多角度工作流不应包含 \"ref_mask\" 局部重绘槽位" };
            }
            break;

        case "upscale":
            if (!hasRefImage) {
                return { ok: false, error: "放大工作流缺少原图输入槽位（至少需标记一个 \"ref_image_01\" 槽位节点）" };
            }
            if (hasRefMask) {
                return { ok: false, error: "放大工作流不应包含 \"ref_mask\" 局部重绘槽位" };
            }
            break;

        case "text":
            if (!hasPrompt) {
                return { ok: false, error: "文本工作流缺少 \"prompt\" 提示词/指令槽位节点" };
            }
            break;

        case "omniVideo":
            if (!hasPrompt) {
                return { ok: false, error: "全能参考视频工作流缺少 \"prompt\" 提示词槽位节点" };
            }
            if (hasFirstFrame || hasLastFrame) {
                return { ok: false, error: "全能参考视频工作流不应包含 first_frame / last_frame 首尾帧槽位（请添加为首尾帧视频工作流）" };
            }
            break;

        case "frameVideo":
            if (!hasFirstFrame || !hasLastFrame) {
                return { ok: false, error: "首尾帧视频工作流必须同时包含 \"first_frame\" 与 \"last_frame\" 槽位节点" };
            }
            if (hasRefVideo || hasRefAudio) {
                return { ok: false, error: "首尾帧视频工作流不支持参考视频或参考音频槽位" };
            }
            break;

        case "audio":
            if (!hasPrompt && !hasCaption && !hasLyrics) {
                return { ok: false, error: "音频工作流缺少提示词槽位（请标记 prompt、caption 或 lyrics 之一）" };
            }
            break;

        case "voice":
            // 配音必须能拿到台词：没有台词就没什么可念的，只有情绪描述跑不出东西。
            if (!hasPrompt && !hasCaption) {
                return { ok: false, error: "配音工作流缺少台词槽位（请把台词抽成 PrimitiveStringMultiline 并标记 _meta.title 为 prompt）" };
            }
            // 音色是 IndexTTS 一类模型的必需输入，缺了要么跑不动、要么只能用它写死的那个音色。
            if (!hasRefAudio) {
                return { ok: false, error: "配音工作流缺少参考音色槽位（请把音色参考音频节点标记为 ref_audio_01）" };
            }
            break;

        case "faceRefine":
            if (!hasRefVideo) {
                return { ok: false, error: "视频人脸修复工作流缺少待修复视频输入槽位（必须标记 \"ref_video_01\" 槽位节点）" };
            }
            if (!hasPrompt) {
                return { ok: false, error: "视频人脸修复工作流缺少 \"prompt\" 提示词槽位节点" };
            }
            break;

        case "depthVideo":
            if (!hasRefVideo) {
                return { ok: false, error: "深度视频提取工作流缺少待提取视频输入槽位（必须标记 \"ref_video_01\" 槽位节点）" };
            }
            break;
    }

    // 4. 槽位自检：三条检查正好覆盖「静默不生效」的全部路径。
    //    槽位体系真正的价值不是命名整齐，而是标错时能说一句人话，而不是等产物不对再回头猜。
    const warnings: string[] = [];
    const rawNodes = workflow as Record<string, unknown>;
    for (const [title, ids] of Object.entries(titleToNodeIds)) {
        if (!isKnownSlotTitle(title)) continue;

        const refMatch = REF_SLOT_PATTERN.exec(title);
        if (refMatch && !refMatch[2]) {
            warnings.push(`槽位「${title}」没有编号，按 01 处理。建议写成 ${title}_01，多参考时才说得清顺序。`);
        }

        for (const nodeId of ids) {
            const node = rawNodes[nodeId] as WorkflowNodeRecord | undefined;
            if (!node || typeof node !== "object") continue;
            const key = resolveSlotInputKey(title, node);
            if (!key) {
                return {
                    ok: false,
                    error: `槽位「${title}」标在了节点 ${nodeId}（${node.class_type || "未知类型"}）上，但这个节点没有可写入的输入。请把槽位标到上游的字符串 / 数值 / 文件加载节点上（例如 PrimitiveStringMultiline.value、LoadAudio.audio）。`,
                };
            }
            if (Array.isArray(node.inputs?.[key])) {
                // GetVideoComponents 这类桥接节点的参考槽位天生就标在连线上（它本来就是解包上游视频的组件），
                // 属于全能参考视频的标准结构，不是标错位置，不能在这里拦。
                if (node.class_type === "GetVideoComponents") continue;
                return {
                    ok: false,
                    error: `槽位「${title}」标错了位置：节点 ${nodeId}（${node.class_type}）的 ${key} 是从别的节点连过来的。请把这个槽位改标到连线那头的源节点上，否则绑定时会盖掉连线，参数改了也不生效。`,
                };
            }
        }
    }

    return { ok: true, slots: Array.from(presentTitles), warnings: warnings.length ? warnings : undefined };
}

/** Generate a random safe integer seed for ComfyUI nodes (15-digit safe integer). */
export function generateRandomSeed(): number {
    return Math.floor(Math.random() * 1_000_000_000_000_000);
}

/**
 * Deep-copy a workflow and write generation params into the nodes marked by
 * _meta.title ("prompt", "width", "height", "seed", "ref_image", "ref_mask").
 * Nodes with a known title but an unrecognized class_type check fallback slot names before being skipped.
 * The original workflow object is never mutated.
 */
export function applyBindings(workflow: ComfyuiWorkflowJson, params: ComfyuiBindings): ComfyuiWorkflowJson {
    const cloned = structuredClone(workflow);
    type NodeRecord = { class_type?: string; inputs?: Record<string, unknown>; _meta?: { title?: unknown } };
    let boundSeed = false;
    for (const node of Object.values(cloned)) {
        if (typeof node !== "object" || node === null) continue;
        const record = node as NodeRecord;
        const rawTitle = record._meta?.title;
        if (typeof rawTitle !== "string" || !record.class_type || !record.inputs) continue;
        const title = rawTitle.trim().toLowerCase();
        let slot: string | undefined;
        let value: unknown;
        if (title === "prompt" && params.prompt !== undefined) {
            slot = BINDING_TITLE_TO_INPUT_SLOT.prompt[record.class_type] || ("value" in record.inputs ? "value" : "text" in record.inputs ? "text" : "prompt" in record.inputs ? "prompt" : undefined);
            value = params.prompt;
        } else if (title === "width" && params.width !== undefined) {
            slot = BINDING_TITLE_TO_INPUT_SLOT.width[record.class_type] || ("value" in record.inputs ? "value" : "width" in record.inputs ? "width" : undefined);
            value = params.width;
        } else if (title === "height" && params.height !== undefined) {
            slot = BINDING_TITLE_TO_INPUT_SLOT.height[record.class_type] || ("value" in record.inputs ? "value" : "height" in record.inputs ? "height" : undefined);
            value = params.height;
        } else if (title === "seed" && params.seed !== undefined) {
            slot = BINDING_TITLE_TO_INPUT_SLOT.seed[record.class_type];
            if (!slot) {
                if ("seed" in record.inputs) slot = "seed";
                else if ("noise_seed" in record.inputs) slot = "noise_seed";
                else if ("value" in record.inputs) slot = "value";
            }
            value = params.seed;
            boundSeed = true;
        } else if (title.startsWith("ref_image") && params.refImages?.length) {
            const m = /^ref_image_(\d{2})$/.exec(title);
            const index = m ? Number(m[1]) - 1 : 0;
            if (params.refImages[index]) {
                slot = BINDING_TITLE_TO_INPUT_SLOT.ref_image[record.class_type] || "image";
                value = params.refImages[index];
            }
        } else if ((title === "ref_mask" || title === "mask" || title === "ref_mask_01") && params.refMask) {
            slot = BINDING_TITLE_TO_INPUT_SLOT.ref_mask[record.class_type] || "image";
            value = params.refMask;
        }
        if (slot) writeSlot(record, slot, value, title);
    }
    // Fallback: if no node had _meta.title === "seed", find any sampler with a literal numeric seed
    if (!boundSeed && params.seed !== undefined) {
        for (const node of Object.values(cloned)) {
            if (typeof node !== "object" || node === null) continue;
            const record = node as NodeRecord;
            if (!record.inputs) continue;
            if (typeof record.inputs.seed === "number") {
                record.inputs.seed = params.seed;
                break;
            } else if (typeof record.inputs.noise_seed === "number") {
                record.inputs.noise_seed = params.seed;
                break;
            }
        }
    }

    // 自动抹除未指派资产的参考节点（图片）及其级联连线与 ReferenceLatent 节点桥接
    const assignedImageCount = params.refImages?.length || 0;
    const removedNodeIds = new Set<string>();

    for (const [id, node] of Object.entries(cloned)) {
        if (typeof node !== "object" || node === null) continue;
        const record = node as NodeRecord;
        const rawTitle = record._meta?.title;
        const title = typeof rawTitle === "string" ? rawTitle.trim().toLowerCase() : "";

        const imgMatch = /^ref_image_(\d{2})$/.exec(title);
        if (imgMatch) {
            const idx = Number(imgMatch[1]) - 1;
            if (idx >= assignedImageCount) removedNodeIds.add(id);
        } else if (title === "ref_image" && assignedImageCount === 0) {
            removedNodeIds.add(id);
        }
    }

    // 级联处理与旁路桥接（例如 ReferenceLatent、ApplyControlNet、VAEEncode、ImageScaleToTotalPixels）
    let hasMorePruning = true;
    while (hasMorePruning) {
        hasMorePruning = false;
        for (const [id, node] of Object.entries(cloned)) {
            if (removedNodeIds.has(id)) continue;
            const record = node as NodeRecord;
            if (!record.inputs) continue;

            // 1. 如果是 ReferenceLatent 节点，且其 latent 输入节点被删除了
            if (record.class_type === "ReferenceLatent") {
                const latentInput = record.inputs.latent;
                if (Array.isArray(latentInput) && removedNodeIds.has(String(latentInput[0]))) {
                    const upstreamConditioning = record.inputs.conditioning;
                    if (Array.isArray(upstreamConditioning)) {
                        // 将所有消费当前 ReferenceLatent 输出的节点，重定向至 upstream conditioning
                        for (const [otherId, otherNode] of Object.entries(cloned)) {
                            if (otherId === id || typeof otherNode !== "object" || otherNode === null) continue;
                            const otherRec = otherNode as NodeRecord;
                            if (!otherRec.inputs) continue;
                            for (const [key, val] of Object.entries(otherRec.inputs)) {
                                if (Array.isArray(val) && String(val[0]) === id) {
                                    otherRec.inputs[key] = [upstreamConditioning[0], upstreamConditioning[1] ?? 0];
                                }
                            }
                        }
                    }
                    removedNodeIds.add(id);
                    hasMorePruning = true;
                    continue;
                }
            }

            // 2. 正向级联：如果当前节点的输入来自已删除节点（非 Flux2Scheduler 尺寸回退容错），则当前节点亦无法运行，一并抹除
            let hasRemovedInput = false;
            for (const [key, val] of Object.entries(record.inputs)) {
                if (Array.isArray(val) && removedNodeIds.has(String(val[0]))) {
                    if (record.class_type === "Flux2Scheduler" && (key === "width" || key === "height")) {
                        continue;
                    }
                    // 动态多模态插槽（如 TextEncodeQwenImage21 的 images.image_* 或 ComfySwitchNode）属于可选输入，只抹除插槽连线，不级联删除节点本身
                    if (
                        record.class_type === "TextEncodeQwenImage21" ||
                        record.class_type === "ComfySwitchNode" ||
                        key.startsWith("images.image_") ||
                        key.startsWith("image_")
                    ) {
                        continue;
                    }
                    hasRemovedInput = true;
                    break;
                }
            }
            if (hasRemovedInput) {
                removedNodeIds.add(id);
                hasMorePruning = true;
                continue;
            }

            // 3. 通用反向级联：若某非输出节点仅被已删除节点消费（无存活消费者），则一并抹除
            const isOutputNode = record.class_type?.startsWith("SaveImage") || record.class_type === "SaveVideo" || record.class_type === "PreviewImage";
            if (!isOutputNode && record.class_type !== "ComfySwitchNode" && record.class_type !== "TextEncodeQwenImage21") {
                let hasLiveConsumer = false;
                let hasRemovedConsumer = false;
                for (const [otherId, otherNode] of Object.entries(cloned)) {
                    if (otherId === id || typeof otherNode !== "object" || otherNode === null) continue;
                    const otherRec = otherNode as NodeRecord;
                    for (const val of Object.values(otherRec.inputs || {})) {
                        if (Array.isArray(val) && String(val[0]) === id) {
                            if (removedNodeIds.has(otherId)) hasRemovedConsumer = true;
                            else hasLiveConsumer = true;
                            break;
                        }
                    }
                    if (hasLiveConsumer) break;
                }
                if (hasRemovedConsumer && !hasLiveConsumer) {
                    removedNodeIds.add(id);
                    hasMorePruning = true;
                }
            }
        }
    }

    if (removedNodeIds.size > 0) {
        for (const id of removedNodeIds) {
            delete cloned[id];
        }
        for (const node of Object.values(cloned)) {
            if (typeof node !== "object" || node === null) continue;
            const record = node as NodeRecord;
            if (!record.inputs) continue;
            for (const [inputKey, val] of Object.entries(record.inputs)) {
                if (Array.isArray(val) && removedNodeIds.has(String(val[0]))) {
                    // 若是 Flux2Scheduler 的 width/height 丢失，回退到指定的尺寸
                    if (record.class_type === "Flux2Scheduler" && (inputKey === "width" || inputKey === "height")) {
                        record.inputs[inputKey] = inputKey === "width" ? params.width ?? 1024 : params.height ?? 1024;
                    } else {
                        delete record.inputs[inputKey];
                    }
                }
            }
        }
    }

    // 联动设置 ComfySwitchNode 开关（如 Qwen-Image-2.1）：
    // 若显式指定了 width 和 height，优先保持 switch=true（走 EmptyLatentImage 遵循指定尺寸与比例）；
    // 若未指定尺寸且有参考图，则走图生图参考图 Latent (switch=false)；无参考图则走 EmptyLatentImage (switch=true)
    for (const node of Object.values(cloned)) {
        if (typeof node !== "object" || node === null) continue;
        const record = node as NodeRecord;
        if (record.class_type === "ComfySwitchNode" && record.inputs && typeof record.inputs.switch === "boolean") {
            const hasCustomSize = params.width !== undefined && params.height !== undefined;
            if (hasCustomSize) {
                record.inputs.switch = true;
            } else {
                record.inputs.switch = (params.refImages?.length || 0) === 0;
            }
        }
    }

    return cloned;
}

/** Base class for every error raised by the ComfyUI service layer. */
export class ComfyuiError extends Error {
    channelName?: string;

    constructor(message: string) {
        super(message);
        this.name = "ComfyuiError";
    }
}

type ComfyuiNodeErrors = Record<string, {
    class_type?: string;
    errors?: { type?: string; message?: string; details?: string; extra_info?: { input_name?: string; input_config?: unknown; received_value?: unknown } }[];
}>;

export class ComfyuiApiError extends ComfyuiError {
    readonly status?: number;
    readonly nodeErrors?: ComfyuiNodeErrors;

    constructor(message: string, status?: number, request?: { url: string; method?: string }, nodeErrors?: ComfyuiNodeErrors) {
        const reason = status === 401 || status === 403 ? "，请检查渠道认证凭据与访问权限" : "";
        super(request ? `${message}；接口 ${describeComfyuiEndpoint(request.url, request.method)}${status ? ` 返回 HTTP ${status}${reason}` : ""}` : message);
        this.name = "ComfyuiApiError";
        this.status = status;
        this.nodeErrors = nodeErrors;
    }
}

/** Thrown when the proxy reports the job reached a failed or cancelled state. */
export class ComfyuiJobError extends ComfyuiError {
    readonly status: string;

    constructor(message: string, status: string) {
        super(message);
        this.name = "ComfyuiJobError";
        this.status = status;
    }
}

/**
 * 把 ComfyUI 的 `status.messages` 翻成一句人话。
 *
 * 原始值是一整个消息数组，直接 stringify 出来是几百字符的 JSON，用户只看到一堆括号，
 * 真正有用的信息（哪个节点、缺什么依赖、ImportError 还是显存不足）被埋在中间。
 * 这里只挑执行期的两条突发消息出来，其余原样返回，至少不丢信息。
 */
export function describeExecutionFailure(messages: unknown): string {
    if (!Array.isArray(messages)) return "";
    for (const entry of messages) {
        if (!Array.isArray(entry)) continue;
        const [type, payload] = entry as [unknown, unknown];
        if (type === "execution_interrupted") return "任务被中断";
        if (type !== "execution_error") continue;

        const info = (payload ?? {}) as Record<string, unknown>;
        const nodeType = typeof info.node_type === "string" && info.node_type ? info.node_type : "";
        const nodeId = typeof info.node_id === "string" || typeof info.node_id === "number" ? String(info.node_id) : "";
        const exceptionMessage = typeof info.exception_message === "string" ? info.exception_message.trim() : "";
        const exceptionType = typeof info.exception_type === "string" ? info.exception_type : "";
        const detail = exceptionMessage || exceptionType || "未知错误";

        // 节点类型比节点号可读，两个都给出来方便对着 ComfyUI 面板定位
        const where = nodeType ? `${nodeType}${nodeId ? `（节点 ${nodeId}）` : ""}` : nodeId ? `节点 ${nodeId}` : "";
        const text = detail.length > 400 ? `${detail.slice(0, 400)}…` : detail;
        return where ? `${where}：${text}` : text;
    }
    return "";
}

/** Thrown when the job has not reached a terminal state within the timeout window. */
export class ComfyuiTimeoutError extends ComfyuiError {
    readonly timeoutMs: number;
    readonly jobId?: string;

    constructor(timeoutMs: number, jobId?: string) {
        const durationDesc =
            timeoutMs >= 3600_000
                ? `${(timeoutMs / 3600_000).toFixed(1).replace(/\.0$/, "")}h`
                : timeoutMs >= 60_000
                  ? `${Math.floor(timeoutMs / 60_000)}m`
                  : `${Math.floor(timeoutMs / 1000)}s`;
        super(`${i18n.t("comfyui.timeout")} (after ${durationDesc})`);
        this.name = "ComfyuiTimeoutError";
        this.timeoutMs = timeoutMs;
        this.jobId = jobId;
    }
}

/** Thrown when the caller aborted the in-flight generation. */
export class ComfyuiAbortedError extends ComfyuiError {
    constructor(message = i18n.t("comfyui.cancelled")) {
        super(message);
        this.name = "ComfyuiAbortedError";
    }
}

/** Thrown when the ComfyUI job was lost (e.g. server restart, queue wipe, missing from queue and history). */
export class ComfyuiJobLostError extends ComfyuiError {
    readonly jobId: string;
    constructor(jobId: string, message = "ComfyUI 任务已丢失（服务可能已重启或队列已清空）") {
        super(message);
        this.name = "ComfyuiJobLostError";
        this.jobId = jobId;
    }
}

/** Thrown when the ComfyUI job ID does not exist. */
export class ComfyuiJobNotFoundError extends ComfyuiError {
    readonly jobId: string;
    constructor(jobId: string, message = "ComfyUI 任务不存在") {
        super(message);
        this.name = "ComfyuiJobNotFoundError";
        this.jobId = jobId;
    }
}

/** Thrown when the ComfyUI job was cancelled or interrupted. */
export class ComfyuiJobCancelledError extends ComfyuiError {
    readonly jobId: string;
    constructor(jobId: string, message = i18n.t("comfyui.cancelled")) {
        super(message);
        this.name = "ComfyuiJobCancelledError";
        this.jobId = jobId;
    }
}

/** Thrown when the selected model has no ComfyUI workflow attached. */
export class ComfyuiNoWorkflowError extends ComfyuiError {
    constructor(message = "No ComfyUI workflow is attached to this model") {
        super(message);
        this.name = "ComfyuiNoWorkflowError";
    }
}

/** Thrown when network connection to ComfyUI fails (e.g. server crash, offline, connection refused). */
export class ComfyuiNetworkError extends ComfyuiError {
    readonly baseUrl: string;
    readonly isOffline: boolean;
    readonly jobId?: string;

    constructor(baseUrl: string, jobId?: string, cause?: unknown, request?: { url: string; method?: string }) {
        const isOffline = typeof navigator !== "undefined" && !navigator.onLine;
        const cleanUrl = baseUrl.trim().replace(/\/+$/, "");
        let message = isOffline
            ? "本地网络连接已断开，请检查网络设置"
            : `无法连接 ComfyUI 服务（${cleanUrl}）。服务可能已崩溃或未启动，请检查服务状态与端口`;
        if (request) {
            message += `；接口 ${describeComfyuiEndpoint(request.url, request.method)} 未能联通`;
            if (!isOffline) message += "。请检查渠道地址、跨域（CORS）与浏览器本地网络权限；浏览器未提供更具体的失败原因";
        }
        super(message);
        this.name = "ComfyuiNetworkError";
        this.baseUrl = cleanUrl;
        this.isOffline = isOffline;
        this.jobId = jobId;
        if (cause && typeof cause === "object") {
            (this as { cause?: unknown }).cause = cause;
        }
    }
}

export function isMixedContentHttp(url?: string): boolean {
    if (typeof window === "undefined" || !url) return false;
    return window.location.protocol === "https:" && url.trim().toLowerCase().startsWith("http://");
}

export function notifyMixedContentBlocked(url: string) {
    if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("comfyui:mixed-content-blocked", { detail: { url } }));
    }
}

function describeComfyuiEndpoint(url: string, method = "GET") {
    try {
        const parsed = new URL(url);
        return `${method.toUpperCase()} ${parsed.origin}${parsed.pathname}`;
    } catch {
        return `${method.toUpperCase()}（渠道地址无效）`;
    }
}

function addComfyuiChannelContext(error: unknown, channelName: string): unknown {
    if (!(error instanceof ComfyuiNetworkError || error instanceof ComfyuiApiError)) return error;
    const name = channelName || "未命名渠道";
    if (error.channelName === name) return error;
    // 批量轮询可能把同一异常交给多个订阅，渠道上下文必须各自独立。
    const contextualError = Object.create(Object.getPrototypeOf(error), Object.getOwnPropertyDescriptors(error)) as typeof error;
    const message = error.channelName ? error.message.slice(`渠道「${error.channelName}」：`.length) : error.message;
    contextualError.channelName = name;
    contextualError.message = `渠道「${name}」：${message}`;
    return contextualError;
}

async function comfyuiFetch(url: string, init?: RequestInit, baseUrl = url): Promise<Response> {
    try {
        return await fetch(url, init);
    } catch (error) {
        if (error instanceof ComfyuiError) {
            throw error;
        }
        if (
            init?.signal?.aborted ||
            (error instanceof Error && error.name === "AbortError") ||
            (typeof DOMException !== "undefined" && error instanceof DOMException && error.name === "AbortError")
        ) {
            throw error;
        }
        throw new ComfyuiNetworkError(baseUrl, undefined, error, { url, method: init?.method });
    }
}

function normalizeBaseUrl(baseUrl: string) {
    return baseUrl.trim().replace(/\/+$/, "");
}

const comfyHostOsCache = new Map<string, "windows" | "linux">();

/**
 * 探测目标 ComfyUI 主机的操作系统（Windows 或 Linux/POSIX），结果在内存缓存
 */
export async function detectComfyuiHostOs(baseUrl: string, token?: string): Promise<"windows" | "linux"> {
    const normalized = normalizeBaseUrl(baseUrl);
    const cached = comfyHostOsCache.get(normalized);
    if (cached) return cached;

    const headers: Record<string, string> = {};
    if (token) headers.Authorization = `Bearer ${token}`;

    try {
        const res = await comfyuiFetch(`${normalized}/system_stats`, { headers }, baseUrl);
        if (res.ok) {
            const data = (await res.json()) as { system?: { os?: string } };
            const osName = (data?.system?.os || "").toLowerCase();
            const osType = osName === "nt" ? "windows" : "linux";
            comfyHostOsCache.set(normalized, osType);
            return osType;
        }
    } catch {
        // ignore probe error
    }

    return "linux";
}

/**
 * 针对跨平台（Windows 反斜杠与 Linux 正斜杠）差异，动态转换工作流中包含 segm/xxx 与 bbox/xxx 的模型路径
 */
export function adaptWorkflowModelPaths(
    workflow: ComfyuiWorkflowJson,
    targetOs: "windows" | "linux",
): ComfyuiWorkflowJson {
    if (!workflow || typeof workflow !== "object") return workflow;

    let modified = false;
    const cloned: ComfyuiWorkflowJson = JSON.parse(JSON.stringify(workflow));

    for (const node of Object.values(cloned)) {
        if (!node || typeof node !== "object" || !node.inputs || typeof node.inputs !== "object") {
            continue;
        }
        for (const [key, val] of Object.entries(node.inputs)) {
            if (typeof val === "string") {
                // 匹配形如 segm/...、bbox/... 等检测器模型路径
                const isPathWithBboxOrSegm = /(?:^|[\\/])(bbox|segm)[\\/]/i.test(val);
                if (isPathWithBboxOrSegm) {
                    const nextVal = targetOs === "windows" ? val.replace(/\//g, "\\") : val.replace(/\\/g, "/");
                    if (nextVal !== val) {
                        node.inputs[key] = nextVal;
                        modified = true;
                    }
                }
            }
        }
    }

    return modified ? cloned : workflow;
}

export const COMFYUI_CORE_PLUGINS = [
    {
        name: "ComfyUI-MiniMaxH3-Myang",
        url: "https://github.com/civilcoco/ComfyUI-MiniMaxH3-Myang",
        keywords: ["h3facetrackcrop", "h3injectvideolatent", "minimaxh3nativeaudiolock", "h3perframedenoise", "h3facestitch"],
        desc: "MiniMax H3 视频人脸追踪精修组件",
    },
    {
        name: "ComfyUI-VideoHelperSuite",
        url: "https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite",
        keywords: ["vhs_videocombine", "videohelpersuite", "loadvideo"],
        desc: "视频加载与音画封装输出",
    },
    {
        name: "ComfyUI-KJNodes",
        url: "https://github.com/kijai/ComfyUI-KJNodes",
        keywords: ["getvideocomponents", "kjnodes", "colormatch", "getimagesize"],
        desc: "全能参考视频及组件处理",
    },
    {
        name: "ComfyLiterals",
        url: "https://github.com/M1kep/ComfyLiterals",
        keywords: ["comfyliterals", "primitiveint", "primitivefloat"],
        desc: "首尾帧/全能视频字面量与基础常数",
    },
    {
        name: "Comfyui-kktools",
        url: "https://github.com/zhiwendesign/Comfyui-kktools",
        keywords: ["kktools", "prompt_expansion", "vision_llm", "kksomethingtoany"],
        desc: "文本生成与提示词反推",
    },
    {
        name: "ComfyUI-UniversalToolkit",
        url: "https://github.com/whmc76/ComfyUI-UniversalToolkit",
        keywords: ["universaltoolkit", "showany_utk", "toolkit"],
        desc: "通用工具与参数解析",
    },
    {
        name: "ComfyUI_LayerStyle",
        url: "https://github.com/chflame163/ComfyUI_LayerStyle",
        keywords: ["layerstyle", "layermask"],
        desc: "遮罩处理与图层合成",
    },
];

export function translateComfyuiValidationError(errMsg: string): string {
    let nodes: ComfyuiNodeErrors = {};
    try {
        const parsed = JSON.parse(errMsg);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) nodes = parsed;
    } catch { /* Non-JSON errors still carry explicit class-not-found messages. */ }
    const entries = Object.entries(nodes).filter(([, node]) => node && Array.isArray(node.errors));
    const missingClass = /class[_ ]not[_ ]found|node_type_not_found|node_class_not_found|cannot execute because node .+ does not exist/i;
    const missingDetails = entries.length
        ? entries.flatMap(([, node]) => node.errors!.filter((error) => missingClass.test(`${error.type} ${error.message}`)).map((error) => `${node.class_type} ${error.message}`)).join(" ")
        : missingClass.test(errMsg) ? errMsg : "";
    const guidance: string[] = [];
    for (const plugin of COMFYUI_CORE_PLUGINS) {
        if (plugin.keywords.some((kw) => missingDetails.toLowerCase().includes(kw))) {
            guidance.push(`缺少核心依赖插件「${plugin.name}」(${plugin.desc})。请在 ComfyUI 的 custom_nodes 目录安装：git clone ${plugin.url}`);
        }
    }
    const details = entries.flatMap(([id, node]) => node.errors!.map((error) => {
        const input = error.extra_info?.input_name || error.details;
        const reason = error.type === "required_input_missing" ? `缺少输入「${input}」`
            : error.type === "value_not_in_list" ? `输入「${input}」的值不在可用选项中：${error.details}`
            : [error.message, error.details].filter(Boolean).join("：");
        return `节点 ${id}（${node.class_type || "未知类型"}）：${reason}`;
    }));
    if (guidance.length || details.length || /prompt outputs failed validation/i.test(errMsg) || missingDetails) {
        return [`ComfyUI 节点校验失败`, ...guidance, ...details, `原始错误: ${errMsg}`].join("\n");
    }
    return errMsg;
}

async function submitJobInternal(workflow: ComfyuiWorkflowJson, baseUrl: string, token?: string): Promise<string> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;
    const clientId = nanoid();
    const url = `${normalizeBaseUrl(baseUrl)}/prompt`;
    const request = { url, method: "POST" };
    const response = await comfyuiFetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ prompt: workflow, client_id: clientId }),
    }, baseUrl);
    if (!response.ok) {
        let errDetail = `${response.status}`;
        let nodeErrors: ComfyuiNodeErrors | undefined;
        try {
            const errJson = (await response.json()) as { error?: { message?: string; details?: string; type?: string }; node_errors?: ComfyuiNodeErrors };
            if (errJson?.node_errors && Object.keys(errJson.node_errors).length) {
                nodeErrors = errJson.node_errors;
                errDetail = JSON.stringify(errJson.node_errors);
            } else if (errJson?.error?.message) {
                errDetail = [errJson.error.type, errJson.error.message, errJson.error.details].filter(Boolean).join(": ");
            }
        } catch {
            // ignore
        }
        const friendlyDetail = translateComfyuiValidationError(errDetail);
        throw new ComfyuiApiError(`ComfyUI 任务提交失败: ${friendlyDetail}`, response.status, request, nodeErrors);
    }
    const data = (await response.json()) as { prompt_id?: unknown; node_errors?: Record<string, unknown> };
    if (data?.node_errors && Object.keys(data.node_errors).length > 0) {
        const friendly = translateComfyuiValidationError(JSON.stringify(data.node_errors));
        throw new ComfyuiApiError(`ComfyUI 工作流校验报错: ${friendly}`, undefined, request);
    }
    if (typeof data?.prompt_id !== "string") throw new ComfyuiApiError("ComfyUI /prompt 响应未返回 prompt_id", undefined, request);
    return data.prompt_id;
}

function workflowHasYoloPaths(workflow: ComfyuiWorkflowJson): boolean {
    for (const node of Object.values(workflow)) {
        if (!node || typeof node !== "object" || !node.inputs || typeof node.inputs !== "object") continue;
        for (const val of Object.values(node.inputs)) {
            if (typeof val === "string" && /(?:^|[\\/])(bbox|segm)[\\/]/i.test(val)) {
                return true;
            }
        }
    }
    return false;
}

/**
 * Submit a bound workflow to ComfyUI's /prompt endpoint; returns prompt_id as jobId.
 * 适配检测器路径；仅在 HTTP 400 明确拒绝任务且提供等价路径选项时修正后重试一次。
 */
export async function submitJob(workflow: ComfyuiWorkflowJson, baseUrl: string, token?: string): Promise<string> {
    if (!workflow || typeof workflow !== "object" || Object.keys(workflow).length === 0) {
        throw new ComfyuiNoWorkflowError("工作流拓扑为空，请检查当前渠道工作流配置或重新选择有效的工作流");
    }

    // 1. 若工作流包含 segm/bbox 路径，探测主机操作系统并自适应转换路径
    if (!workflowHasYoloPaths(workflow)) {
        return await submitJobInternal(workflow, baseUrl, token);
    }

    const targetOs = await detectComfyuiHostOs(baseUrl, token);
    const adaptedWorkflow = adaptWorkflowModelPaths(workflow, targetOs);

    try {
        return await submitJobInternal(adaptedWorkflow, baseUrl, token);
    } catch (error) {
        if (!(error instanceof ComfyuiApiError) || error.status !== 400 || !error.nodeErrors) throw error;
        const corrected = structuredClone(adaptedWorkflow);
        let changed = false;
        for (const [id, nodeError] of Object.entries(error.nodeErrors)) {
            const node = corrected[id] as { inputs?: Record<string, unknown> } | undefined;
            for (const issue of Array.isArray(nodeError?.errors) ? nodeError.errors : []) {
                if (issue.type !== "value_not_in_list") continue;
                const input = issue.extra_info?.input_name;
                const value = input && node?.inputs?.[input];
                const options = issue.extra_info?.input_config;
                if (typeof value !== "string" || !/(?:^|[\\/])(bbox|segm)[\\/]/i.test(value) || !Array.isArray(options) || !Array.isArray(options[0])) continue;
                const candidate = options[0].find((option: unknown) => typeof option === "string" && option.replace(/\\/g, "/") === value.replace(/\\/g, "/"));
                if (typeof candidate === "string" && candidate !== value) {
                    node!.inputs![input!] = candidate;
                    changed = true;
                }
            }
        }
        if (changed) return await submitJobInternal(corrected, baseUrl, token);
        throw error;
    }
}

/** How often the job status is polled when running tasks exist (2 seconds). */
export const JOB_POLL_INTERVAL_RUNNING_MS = 2_000;
/** How often the job status is polled when all active tasks are in pending/queue (3.5 seconds). */
export const JOB_POLL_INTERVAL_PENDING_MS = 3_500;
/** Default poll interval for backward compatibility. */
export const JOB_POLL_INTERVAL_MS = 2_000;
/** Total window allowed for the job to complete before the request times out (18 hours). */
export const JOB_TIMEOUT_MS = 64_800_000;

type ComfyuiJobResponse = {
    status?: {
        status_str?: string;
        completed?: boolean;
        messages?: unknown[];
    };
    outputs?: Record<string, unknown>;
};

/**
 * Rank ComfyUI output asset item types:
 * 0 = "output" (saved generation final output, highest priority)
 * 1 = "temp" / unspecified (preview output or generic media)
 * 2 = "input" (reference input assets or intermediate cache, lowest priority)
 */
export function getOutputTypeRank(outputType?: string, id?: string): number {
    const ot = (outputType || "").toLowerCase().trim();
    if (ot === "output") return 0;
    if (ot === "temp") return 1;
    if (ot === "input") return 2;
    if (id) {
        if (/[?&]type=output(?=&|$)/i.test(id)) return 0;
        if (/[?&]type=temp(?=&|$)/i.test(id)) return 1;
        if (/[?&]type=input(?=&|$)/i.test(id)) return 2;
    }
    return 1;
}

/** Collect the image asset identifiers from outputs, prioritizing type = "output". */
export function collectImageAssetIds(outputs: unknown): string[] {
    if (!Array.isArray(outputs)) return [];
    const outputIds: string[] = [];
    const tempIds: string[] = [];
    const otherIds: string[] = [];

    for (const entry of outputs) {
        if (!entry || typeof entry !== "object") continue;
        const { id, type, output_type, content_type, filename } = entry as { id?: unknown; type?: unknown; output_type?: unknown; content_type?: unknown; filename?: unknown };
        const assetId = typeof id === "string" && id ? id : typeof filename === "string" ? filename : "";
        if (!assetId) continue;
        const fn = typeof filename === "string" ? filename.toLowerCase() : "";
        if (fn.endsWith(".mp4") || fn.endsWith(".webm") || fn.endsWith(".mov") || fn.endsWith(".mkv")) continue;
        if (type === "image" || (typeof content_type === "string" && content_type.startsWith("image/"))) {
            const rank = getOutputTypeRank(typeof output_type === "string" ? output_type : undefined, assetId);
            if (rank === 0) outputIds.push(assetId);
            else if (rank === 1) tempIds.push(assetId);
            else otherIds.push(assetId);
        }
    }
    if (outputIds.length > 0) return outputIds;
    if (tempIds.length > 0) return tempIds;
    return otherIds;
}

export function prioritizeInpaintOutput(outputs: unknown, workflow: ComfyuiWorkflowJson): string[] {
    if (!Array.isArray(outputs)) return [];
    let compositeSaveNodeId: string | undefined;
    for (const [nodeId, node] of Object.entries(workflow)) {
        if (typeof node !== "object" || node === null) continue;
        const rec = node as { class_type?: string; inputs?: { images?: [string, number] } };
        if (rec.class_type === "SaveImage" && Array.isArray(rec.inputs?.images) && rec.inputs.images[0]) {
            const upstreamId = String(rec.inputs.images[0]);
            const upstream = workflow[upstreamId] as { class_type?: string } | undefined;
            if (upstream?.class_type === "ImageCompositeMasked") {
                compositeSaveNodeId = nodeId;
                break;
            }
        }
    }

    const items: Array<{ id: string; nodeId?: string }> = [];
    for (const entry of outputs) {
        if (!entry || typeof entry !== "object") continue;
        const { id, type, content_type, node_id, filename } = entry as { id?: unknown; type?: unknown; content_type?: unknown; node_id?: unknown; filename?: unknown };
        const assetId = typeof id === "string" && id ? id : typeof filename === "string" ? filename : "";
        if (!assetId) continue;
        const fn = typeof filename === "string" ? filename.toLowerCase() : "";
        if (fn.endsWith(".mp4") || fn.endsWith(".webm") || fn.endsWith(".mov") || fn.endsWith(".mkv")) continue;
        if (type === "image" || (typeof content_type === "string" && content_type.startsWith("image/"))) {
            items.push({ id: assetId, nodeId: typeof node_id === "string" ? node_id : undefined });
        }
    }

    if (compositeSaveNodeId) {
        items.sort((a, b) => (a.nodeId === compositeSaveNodeId ? -1 : b.nodeId === compositeSaveNodeId ? 1 : 0));
    }
    return items.map((item) => item.id);
}

export type PollJobResult = {
    outputs: Array<{
        id: string;
        filename?: string;
        subfolder?: string;
        type?: string;
        output_type?: string;
        content_type?: string;
        node_id?: string;
        text?: string;
        value?: string;
        url?: string;
    }>;
    job: ComfyuiJobResponse;
};

export function isComfyuiJobInterrupted(jobEntry: ComfyuiJobResponse): boolean {
    const messages = jobEntry.status?.messages;
    if (!Array.isArray(messages)) return false;
    return messages.some((m) => {
        if (Array.isArray(m) && m[0] === "execution_interrupted") return true;
        if (typeof m === "object" && m !== null && (m as Record<string, unknown>).type === "execution_interrupted") return true;
        return typeof m === "string" && m.includes("execution_interrupted");
    });
}

export function extractOutputsFromComfyuiJob(jobEntry: ComfyuiJobResponse): PollJobResult["outputs"] {
    const rawOutputs = jobEntry.outputs || {};
    const outputs: PollJobResult["outputs"] = [];

    for (const [nodeId, nodeOut] of Object.entries(rawOutputs)) {
        if (!nodeOut || typeof nodeOut !== "object") continue;
        const out = nodeOut as {
            images?: Array<{ filename: string; subfolder?: string; type?: string }>;
            videos?: Array<{ filename: string; subfolder?: string; type?: string }>;
            gifs?: Array<{ filename: string; subfolder?: string; type?: string }>;
            audio?: unknown;
            text?: string[] | string;
            string?: string[] | string;
            animated?: boolean[];
            ui?: Record<string, unknown>;
        };

        if (Array.isArray(out.images)) {
            for (const img of out.images) {
                if (img?.filename) {
                    const subfolder = img.subfolder || "";
                    const itemType = img.type || "output";
                    const isVideo = /\.(mp4|webm|mov|avi|mkv)$/i.test(img.filename);
                    const isAnimated = Boolean(Array.isArray(out.animated) && out.animated[0]);
                    const contentType = isVideo ? "video/mp4" : isAnimated ? "image/gif" : "image/png";
                    const viewPath = `/api/view?filename=${encodeURIComponent(img.filename)}&type=${encodeURIComponent(itemType)}&subfolder=${encodeURIComponent(subfolder)}`;
                    outputs.push({
                        id: viewPath,
                        filename: img.filename,
                        subfolder,
                        type: isVideo ? "video" : itemType,
                        output_type: itemType,
                        content_type: contentType,
                        node_id: nodeId,
                    });
                }
            }
        }

        if (Array.isArray(out.videos)) {
            for (const vid of out.videos) {
                if (vid?.filename) {
                    const subfolder = vid.subfolder || "";
                    const itemType = vid.type || "output";
                    const viewPath = `/api/view?filename=${encodeURIComponent(vid.filename)}&type=${encodeURIComponent(itemType)}&subfolder=${encodeURIComponent(subfolder)}`;
                    outputs.push({
                        id: viewPath,
                        filename: vid.filename,
                        subfolder,
                        type: "video",
                        output_type: itemType,
                        content_type: "video/mp4",
                        node_id: nodeId,
                    });
                }
            }
        }

        if (Array.isArray(out.gifs)) {
            for (const gif of out.gifs) {
                if (gif?.filename) {
                    const subfolder = gif.subfolder || "";
                    const itemType = gif.type || "output";
                    const viewPath = `/api/view?filename=${encodeURIComponent(gif.filename)}&type=${encodeURIComponent(itemType)}&subfolder=${encodeURIComponent(subfolder)}`;
                    outputs.push({
                        id: viewPath,
                        filename: gif.filename,
                        subfolder,
                        type: "video",
                        output_type: itemType,
                        content_type: "video/mp4",
                        node_id: nodeId,
                    });
                }
            }
        }

        const rawAudioList = Array.isArray(out.audio)
            ? out.audio
            : Array.isArray((out.ui as any)?.audio)
            ? (out.ui as any).audio
            : Array.isArray((out as any)?.audios)
            ? (out as any).audios
            : Array.isArray((out.ui as any)?.audios)
            ? (out.ui as any).audios
            : out.audio && typeof out.audio === "object"
            ? [out.audio]
            : (out.ui as any)?.audio && typeof (out.ui as any).audio === "object"
            ? [(out.ui as any).audio]
            : [];

        if (rawAudioList.length > 0) {
            for (const aud of rawAudioList) {
                const filename = typeof aud === "string" ? aud : aud?.filename || aud?.name || "";
                if (filename) {
                    const subfolder = typeof aud === "object" && aud?.subfolder ? aud.subfolder : "";
                    const itemType = typeof aud === "object" && aud?.type ? aud.type : "output";
                    const ext = filename.split(".").pop()?.toLowerCase() || "";
                    const contentType =
                        ext === "wav" ? "audio/wav" :
                        ext === "ogg" ? "audio/ogg" :
                        ext === "flac" ? "audio/flac" :
                        ext === "opus" ? "audio/opus" :
                        ext === "m4a" || ext === "aac" ? "audio/mp4" :
                        "audio/mpeg";
                    const viewPath = `/api/view?filename=${encodeURIComponent(filename)}&type=${encodeURIComponent(itemType)}&subfolder=${encodeURIComponent(subfolder)}`;
                    outputs.push({
                        id: viewPath,
                        filename,
                        subfolder,
                        type: "audio",
                        output_type: itemType,
                        content_type: contentType,
                        node_id: nodeId,
                    });
                }
            }
        } else {
            const scanObj = (out.ui && typeof out.ui === "object" ? { ...out, ...(out.ui as any) } : out) as Record<string, unknown>;
            for (const [key, val] of Object.entries(scanObj)) {
                if (key === "text" || key === "string" || key === "ui") continue;
                const items = Array.isArray(val) ? val : [val];
                for (const item of items) {
                    if (!item) continue;
                    const fn = typeof item === "string" ? item : typeof item === "object" && "filename" in item ? String((item as any).filename) : typeof item === "object" && "name" in item ? String((item as any).name) : "";
                    if (fn && /\.(mp3|wav|ogg|flac|m4a|aac|opus)$/i.test(fn)) {
                        const subfolder = typeof item === "object" && "subfolder" in item ? String((item as any).subfolder || "") : "";
                        const itemType = typeof item === "object" && "type" in item ? String((item as any).type || "output") : "output";
                        const viewPath = `/api/view?filename=${encodeURIComponent(fn)}&type=${encodeURIComponent(itemType)}&subfolder=${encodeURIComponent(subfolder)}`;
                        outputs.push({
                            id: viewPath,
                            filename: fn,
                            subfolder,
                            type: "audio",
                            output_type: itemType,
                            content_type: "audio/mpeg",
                            node_id: nodeId,
                        });
                    }
                }
            }
        }

        if (out.text) {
            const textVal = Array.isArray(out.text) ? out.text.join("\n") : String(out.text);
            if (textVal.trim()) {
                outputs.push({
                    id: `text_${nodeId}`,
                    text: textVal,
                    content_type: "text/plain",
                    node_id: nodeId,
                });
            }
        }
        if (out.string) {
            const strVal = Array.isArray(out.string) ? out.string.join("\n") : String(out.string);
            if (strVal.trim()) {
                outputs.push({
                    id: `text_${nodeId}`,
                    text: strVal,
                    content_type: "text/plain",
                    node_id: nodeId,
                });
            }
        }
    }

    outputs.sort((a, b) => getOutputTypeRank(a.output_type, a.id) - getOutputTypeRank(b.output_type, b.id));
    return outputs;
}

export type ComfyuiTaskStatus =
    | "pending"     // 排队中 (在 queue_pending)
    | "running"     // 执行中 (在 queue_running)
    | "success"     // 执行成功 (在 history 且 status_str === "success")
    | "error"       // 执行出错 (在 history 且 status_str === "error" 且非中断)
    | "cancelled"   // 任务已取消 (在 history 且 messages 含 execution_interrupted，或本地标记取消)
    | "lost"        // 任务丢失 (本地在等待，但服务端 /queue 与 /history 均无痕迹)
    | "not_found";  // 任务不存在 (服务端查无此任务，且无本地等待上下文)

export interface ComfyuiTaskStatusResult {
    status: ComfyuiTaskStatus;
    queuePosition?: number;
    error?: string;
    outputs?: PollJobResult["outputs"];
    job?: ComfyuiJobResponse;
}

function evaluateFinishedJobEntry(jobEntry: ComfyuiJobResponse, isLocallyCancelled?: boolean): ComfyuiTaskStatusResult {
    if (isComfyuiJobInterrupted(jobEntry) || isLocallyCancelled) {
        return { status: "cancelled", job: jobEntry };
    }
    const statusStr = jobEntry.status?.status_str;
    if (statusStr === "error") {
        const msg = Array.isArray(jobEntry.status?.messages) ? JSON.stringify(jobEntry.status?.messages) : statusStr;
        return { status: "error", error: msg, job: jobEntry };
    }
    const outputs = extractOutputsFromComfyuiJob(jobEntry);
    if (statusStr === "success" || jobEntry.status?.completed || outputs.length > 0) {
        return { status: "success", outputs, job: jobEntry };
    }
    return { status: "running", job: jobEntry };
}

/**
 * 显式查询任务状态（一次性主动检测，不发起长时间轮询）
 */
export async function queryComfyuiJobStatus(
    jobId: string,
    baseUrl: string,
    token?: string,
    options?: { isLocallyActive?: boolean; isLocallyCancelled?: boolean },
): Promise<ComfyuiTaskStatusResult> {
    if (!jobId) {
        return { status: "not_found" };
    }
    const headers: Record<string, string> = {};
    if (token) headers.Authorization = `Bearer ${token}`;

    const normalized = normalizeBaseUrl(baseUrl);
    const historyUrl = `${normalized}/history/${jobId}`;
    const queueUrl = `${normalized}/queue`;

    // 1. 查询 /history/{jobId}
    const historyResponse = await comfyuiFetch(historyUrl, { headers }, baseUrl);
    if (!historyResponse.ok) throw new ComfyuiApiError(`Failed to fetch ComfyUI history: ${historyResponse.status}`, historyResponse.status);
    const historyData = (await historyResponse.json()) as Record<string, ComfyuiJobResponse>;
    const jobEntry = historyData?.[jobId];

    if (jobEntry) {
        return evaluateFinishedJobEntry(jobEntry, options?.isLocallyCancelled);
    }

    // 2. /history 为空，查询 /queue
    const queueResponse = await comfyuiFetch(queueUrl, { headers }, baseUrl);
    if (!queueResponse.ok) throw new ComfyuiApiError(`Failed to fetch ComfyUI queue: ${queueResponse.status}`, queueResponse.status);
    const queueData = (await queueResponse.json()) as { queue_running?: unknown[]; queue_pending?: unknown[] };
    const pendingList = Array.isArray(queueData.queue_pending) ? queueData.queue_pending : [];
    const runningList = Array.isArray(queueData.queue_running) ? queueData.queue_running : [];

    const pendingIndex = pendingList.findIndex((item) => Array.isArray(item) && String(item[1]) === jobId);
    if (pendingIndex >= 0) {
        return { status: "pending", queuePosition: pendingIndex + 1 };
    }
    const isRunning = runningList.some((item) => Array.isArray(item) && String(item[1]) === jobId);
    if (isRunning) {
        return { status: "running" };
    }

    // 3. 防竞态检查：若队列中无记录，二次拉取 /history（防止刚好完成从 running 移入 history 的瞬间）
    const recheckResponse = await comfyuiFetch(historyUrl, { headers }, baseUrl);
    if (recheckResponse.ok) {
        const recheckData = (await recheckResponse.json()) as Record<string, ComfyuiJobResponse>;
        const recheckEntry = recheckData?.[jobId];
        if (recheckEntry) {
            return evaluateFinishedJobEntry(recheckEntry, options?.isLocallyCancelled);
        }
    }

    // 4. 队列与历史均查无此任务
    if (options?.isLocallyCancelled) {
        return { status: "cancelled" };
    }
    if (options?.isLocallyActive) {
        return { status: "lost" };
    }
    return { status: "not_found" };
}

export const MAX_POLL_NETWORK_RETRIES = 5;

interface TrackedJobSubscription {
    startedAt: number;
    deadlineMs?: number;
    token?: string;
    signal?: AbortSignal;
    onProgress?: (status: string, detail?: Record<string, unknown>) => void;
    resolve: (result: PollJobResult | undefined) => void;
    reject: (error: unknown) => void;
    onAbort?: () => void;
}

interface TrackedJobEntry {
    jobId: string;
    token?: string;
    seenInQueue: boolean;
    unseenTicks: number;
    status: "pending" | "running" | "checking_history" | "unknown";
    queuePosition?: number;
    subscriptions: TrackedJobSubscription[];
}

/**
 * 统一批量轮询调度器 (按 baseUrl 聚合实例)
 * 多个并发任务共享单次 /queue 批量查询，大幅减轻对 ComfyUI 服务端的请求压力；
 * 采用自适应节拍：全 pending 时放缓至 3.5s，有 running 时保持 2s，出队时精准拉取 /history。
 */
export class ComfyuiJobBatchPoller {
    readonly baseUrl: string;
    private jobs = new Map<string, TrackedJobEntry>();
    private isRunning = false;
    private hasRunningJobs = false;
    private consecutiveNetworkErrors = 0;

    constructor(baseUrl: string) {
        this.baseUrl = normalizeBaseUrl(baseUrl);
    }

    poll(
        jobId: string,
        token?: string,
        signal?: AbortSignal,
        deadlineMs?: number,
        onProgress?: (status: string, detail?: Record<string, unknown>) => void,
    ): Promise<PollJobResult | undefined> {
        if (signal?.aborted) return Promise.resolve(undefined);

        const startedAt = Date.now();
        const effectiveDeadline = deadlineMs ?? (startedAt + JOB_TIMEOUT_MS);

        return new Promise<PollJobResult | undefined>((resolve, reject) => {
            let entry = this.jobs.get(jobId);
            if (!entry) {
                entry = {
                    jobId,
                    token,
                    seenInQueue: false,
                    unseenTicks: 0,
                    status: "unknown",
                    subscriptions: [],
                };
                this.jobs.set(jobId, entry);
            } else if (token && !entry.token) {
                entry.token = token;
            }

            const sub: TrackedJobSubscription = {
                startedAt,
                deadlineMs: effectiveDeadline,
                token,
                signal,
                onProgress,
                resolve,
                reject,
            };

            if (signal) {
                const onAbort = () => {
                    this.removeSubscription(jobId, sub);
                    resolve(undefined);
                };
                sub.onAbort = onAbort;
                signal.addEventListener("abort", onAbort, { once: true });
            }

            entry.subscriptions.push(sub);

            // 若已有现成进度状态，立即同步一次
            if (entry.status === "pending" && entry.queuePosition !== undefined) {
                onProgress?.("pending", { queuePosition: entry.queuePosition });
            } else if (entry.status === "running") {
                onProgress?.("running");
            }

            this.ensureLoop();
        });
    }

    private removeSubscription(jobId: string, sub: TrackedJobSubscription) {
        if (sub.signal && sub.onAbort) {
            sub.signal.removeEventListener("abort", sub.onAbort);
        }
        const entry = this.jobs.get(jobId);
        if (!entry) return;
        const idx = entry.subscriptions.indexOf(sub);
        if (idx >= 0) {
            entry.subscriptions.splice(idx, 1);
        }
        if (entry.subscriptions.length === 0) {
            this.jobs.delete(jobId);
        }
    }

    private ensureLoop() {
        if (this.isRunning || this.jobs.size === 0) return;
        this.isRunning = true;
        void this.loop();
    }

    private async loop() {
        while (this.isRunning && this.jobs.size > 0) {
            await this.tick();
            if (!this.isRunning || this.jobs.size === 0) break;
            const interval = this.hasRunningJobs ? JOB_POLL_INTERVAL_RUNNING_MS : JOB_POLL_INTERVAL_PENDING_MS;
            await new Promise((resolve) => setTimeout(resolve, interval));
        }
        this.isRunning = false;
    }

    private async tick() {
        const now = Date.now();

        // 1. 检查各任务的所有订阅是否超时
        for (const [jobId, entry] of Array.from(this.jobs.entries())) {
            const timedOutSubs: TrackedJobSubscription[] = [];
            for (const sub of entry.subscriptions) {
                if (sub.deadlineMs !== undefined && now >= sub.deadlineMs) {
                    timedOutSubs.push(sub);
                }
            }
            for (const sub of timedOutSubs) {
                this.removeSubscription(jobId, sub);
                sub.reject(new ComfyuiTimeoutError(Math.max(0, (sub.deadlineMs || now) - sub.startedAt), jobId));
            }
        }
        if (this.jobs.size === 0) return;

        // 2. 尝试批量单次请求 /queue
        const anyToken = Array.from(this.jobs.values()).find((e) => e.token)?.token;
        const headers: Record<string, string> = {};
        if (anyToken) headers.Authorization = `Bearer ${anyToken}`;

        let queueData: { queue_running?: unknown[]; queue_pending?: unknown[] } | null = null;
        let fallbackToHistory = false;

        try {
            const queueRes = await comfyuiFetch(`${this.baseUrl}/queue`, { headers }, this.baseUrl);
            if (queueRes.ok) {
                queueData = (await queueRes.json()) as { queue_running?: unknown[]; queue_pending?: unknown[] };
                this.consecutiveNetworkErrors = 0;
            } else {
                fallbackToHistory = true;
            }
        } catch (error) {
            if (error instanceof ComfyuiNetworkError) {
                this.consecutiveNetworkErrors++;
                if (this.consecutiveNetworkErrors <= MAX_POLL_NETWORK_RETRIES) {
                    for (const entry of this.jobs.values()) {
                        for (const sub of entry.subscriptions) {
                            sub.onProgress?.("network_retry", {
                                retryCount: this.consecutiveNetworkErrors,
                                maxRetries: MAX_POLL_NETWORK_RETRIES,
                                baseUrl: this.baseUrl,
                                message: `服务连接中断，正在重试 (${this.consecutiveNetworkErrors}/${MAX_POLL_NETWORK_RETRIES})...`,
                            });
                        }
                    }
                    return;
                }
                const entries = Array.from(this.jobs.values());
                this.jobs.clear();
                for (const entry of entries) {
                    for (const sub of entry.subscriptions) {
                        if (sub.signal && sub.onAbort) sub.signal.removeEventListener("abort", sub.onAbort);
                        sub.reject(new ComfyuiNetworkError(this.baseUrl, entry.jobId, error));
                    }
                }
                return;
            }
            throw error;
        }

        if (fallbackToHistory || !queueData) {
            await this.checkHistoryForEntries(Array.from(this.jobs.values()));
            return;
        }

        // 3. 解析 /queue 列表
        const pendingList = Array.isArray(queueData.queue_pending) ? queueData.queue_pending : [];
        const runningList = Array.isArray(queueData.queue_running) ? queueData.queue_running : [];

        const pendingMap = new Map<string, number>();
        pendingList.forEach((item, index) => {
            if (Array.isArray(item) && item[1]) {
                pendingMap.set(String(item[1]), index + 1);
            }
        });

        const runningSet = new Set<string>();
        runningList.forEach((item) => {
            if (Array.isArray(item) && item[1]) {
                runningSet.add(String(item[1]));
            }
        });

        this.hasRunningJobs = runningSet.size > 0;

        const entriesToCheckHistory: TrackedJobEntry[] = [];

        for (const [jobId, entry] of Array.from(this.jobs.entries())) {
            if (pendingMap.has(jobId)) {
                entry.seenInQueue = true;
                entry.unseenTicks = 0;
                const pos = pendingMap.get(jobId)!;
                entry.status = "pending";
                entry.queuePosition = pos;
                for (const sub of entry.subscriptions) {
                    sub.onProgress?.("pending", { queuePosition: pos });
                }
            } else if (runningSet.has(jobId)) {
                entry.seenInQueue = true;
                entry.unseenTicks = 0;
                entry.status = "running";
                entry.queuePosition = undefined;
                for (const sub of entry.subscriptions) {
                    sub.onProgress?.("running");
                }
            } else {
                entry.unseenTicks++;
                entriesToCheckHistory.push(entry);
            }
        }

        if (entriesToCheckHistory.length > 0) {
            await this.checkHistoryForEntries(entriesToCheckHistory);
        }
    }

    private async checkHistoryForEntries(entries: TrackedJobEntry[]) {
        for (const entry of entries) {
            if (!this.jobs.has(entry.jobId)) continue;
            const headers: Record<string, string> = {};
            if (entry.token) headers.Authorization = `Bearer ${entry.token}`;

            try {
                const res = await comfyuiFetch(`${this.baseUrl}/history/${entry.jobId}`, { headers }, this.baseUrl);
                if (!res.ok) {
                    throw new ComfyuiApiError("ComfyUI 任务状态查询失败", res.status, { url: `${this.baseUrl}/history/${entry.jobId}` });
                }
                const data = (await res.json()) as Record<string, ComfyuiJobResponse>;
                const jobEntry = data?.[entry.jobId];

                if (jobEntry) {
                    this.jobs.delete(entry.jobId);
                    if (isComfyuiJobInterrupted(jobEntry)) {
                        for (const sub of entry.subscriptions) {
                            if (sub.signal && sub.onAbort) sub.signal.removeEventListener("abort", sub.onAbort);
                            sub.reject(new ComfyuiJobCancelledError(entry.jobId));
                        }
                        continue;
                    }
                    const statusStr = jobEntry.status?.status_str;
                    if (statusStr === "error") {
                        const msg = Array.isArray(jobEntry.status?.messages) ? JSON.stringify(jobEntry.status?.messages) : statusStr;
                        for (const sub of entry.subscriptions) {
                            if (sub.signal && sub.onAbort) sub.signal.removeEventListener("abort", sub.onAbort);
                            sub.reject(new ComfyuiJobError(`ComfyUI 执行失败: ${msg}`, statusStr));
                        }
                        continue;
                    }
                    const outputs = extractOutputsFromComfyuiJob(jobEntry);
                    if (statusStr === "success" || jobEntry.status?.completed || outputs.length > 0) {
                        for (const sub of entry.subscriptions) {
                            if (sub.signal && sub.onAbort) sub.signal.removeEventListener("abort", sub.onAbort);
                            sub.resolve({ outputs, job: jobEntry });
                        }
                        continue;
                    }
                } else {
                    const isLost = entry.seenInQueue ? entry.unseenTicks >= 2 : entry.unseenTicks >= 3;
                    if (isLost) {
                        this.jobs.delete(entry.jobId);
                        for (const sub of entry.subscriptions) {
                            if (sub.signal && sub.onAbort) sub.signal.removeEventListener("abort", sub.onAbort);
                            sub.reject(new ComfyuiJobLostError(entry.jobId));
                        }
                    }
                }
            } catch (error) {
                if (error instanceof ComfyuiNetworkError) {
                    continue;
                }
                this.jobs.delete(entry.jobId);
                for (const sub of entry.subscriptions) {
                    if (sub.signal && sub.onAbort) sub.signal.removeEventListener("abort", sub.onAbort);
                    sub.reject(error);
                }
            }
        }
    }

    clear() {
        this.isRunning = false;
        this.hasRunningJobs = false;
        this.consecutiveNetworkErrors = 0;
        for (const entry of this.jobs.values()) {
            for (const sub of entry.subscriptions) {
                if (sub.signal && sub.onAbort) sub.signal.removeEventListener("abort", sub.onAbort);
            }
        }
        this.jobs.clear();
    }
}

const batchPollers = new Map<string, ComfyuiJobBatchPoller>();

export function getBatchPoller(baseUrl: string): ComfyuiJobBatchPoller {
    const normalized = normalizeBaseUrl(baseUrl);
    let poller = batchPollers.get(normalized);
    if (!poller) {
        poller = new ComfyuiJobBatchPoller(normalized);
        batchPollers.set(normalized, poller);
    }
    return poller;
}

export function resetComfyuiBatchPollers() {
    for (const poller of batchPollers.values()) {
        poller.clear();
    }
    batchPollers.clear();
}

export function pollJobRaw(
    jobId: string,
    baseUrl: string,
    token?: string,
    signal?: AbortSignal,
    deadlineMs?: number,
    onProgress?: (status: string, detail?: Record<string, unknown>) => void,
): Promise<PollJobResult | undefined> {
    const poller = getBatchPoller(baseUrl);
    return poller.poll(jobId, token, signal, deadlineMs, onProgress);
}

/**
 * Poll ComfyUI /history endpoint until the job reaches a terminal state.
 */
export async function pollJob(
    jobId: string,
    baseUrl: string,
    token?: string,
    signal?: AbortSignal,
    deadlineMs?: number,
    collector: (outputs: unknown) => string[] = collectImageAssetIds,
    onProgress?: (status: string, detail?: Record<string, unknown>) => void,
): Promise<string[] | undefined> {
    const res = await pollJobRaw(jobId, baseUrl, token, signal, deadlineMs, onProgress);
    return res !== undefined ? collector(res.outputs) : undefined;
}

/**
 * Download an asset from ComfyUI /view endpoint and convert it to a data URL.
 */
export async function downloadAsset(
    assetIdOrFilename: string,
    baseUrl: string,
    token?: string,
    options?: { subfolder?: string; type?: string },
): Promise<{ blob: Blob; dataUrl: string }> {
    const headers: Record<string, string> = {};
    if (token) headers.Authorization = `Bearer ${token}`;

    let url: string;
    if (assetIdOrFilename.startsWith("http://") || assetIdOrFilename.startsWith("https://")) {
        url = assetIdOrFilename;
    } else if (assetIdOrFilename.startsWith("/view?") || assetIdOrFilename.startsWith("/api/view?")) {
        url = `${normalizeBaseUrl(baseUrl)}${assetIdOrFilename}`;
    } else {
        let filename = assetIdOrFilename;
        let subfolder = options?.subfolder || "";
        if (!subfolder && filename.includes("/")) {
            const parts = filename.split("/");
            filename = parts.pop() || filename;
            subfolder = parts.join("/");
        }
        const type = options?.type || "output";
        url = `${normalizeBaseUrl(baseUrl)}/view?filename=${encodeURIComponent(filename)}&subfolder=${encodeURIComponent(subfolder)}&type=${encodeURIComponent(type)}`;
    }

    let response = await comfyuiFetch(url, { headers }, baseUrl);
    if (!response.ok && response.status === 404) {
        let altUrl = "";
        if (url.includes("/api/view?")) {
            altUrl = url.replace("/api/view?", "/view?");
        } else if (url.includes("/view?")) {
            altUrl = url.replace("/view?", "/api/view?");
        }
        if (altUrl) {
            try {
                const altResponse = await comfyuiFetch(altUrl, { headers }, baseUrl);
                if (altResponse.ok) {
                    response = altResponse;
                }
            } catch {
                // keep original response
            }
        }
    }
    if (!response.ok) throw new ComfyuiApiError(`Failed to download asset from ComfyUI: ${response.status}`, response.status);
    const blob = await response.blob();
    if (!blob.size) throw new ComfyuiApiError("Downloaded asset is empty");
    return { blob, dataUrl: await blobToDataUrl(blob) };
}

/**
 * 按任务取消：任务仍在排队（queue_pending）时 POST /queue { delete: [jobId] } 删除该排队任务；
 * 仅在确认目标任务正在运行（queue_running）时才 POST /interrupt 中断。
 * 任务不在队列、GET/解析/请求失败均 best-effort 静默返回，绝不全局 interrupt。
 */
export async function cancelJob(jobId: string, baseUrl: string, token?: string): Promise<void> {
    if (!jobId) return;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;
    const queueUrl = `${normalizeBaseUrl(baseUrl)}/queue`;
    try {
        const queueResponse = await comfyuiFetch(queueUrl, { headers }, baseUrl);
        if (!queueResponse.ok) return;
        const queue = (await queueResponse.json()) as { queue_running?: unknown[]; queue_pending?: unknown[] };
        const isQueued = Array.isArray(queue.queue_pending) && queue.queue_pending.some((item) => Array.isArray(item) && String(item[1]) === jobId);
        const isRunning = Array.isArray(queue.queue_running) && queue.queue_running.some((item) => Array.isArray(item) && String(item[1]) === jobId);
        if (isQueued) {
            await comfyuiFetch(queueUrl, { method: "POST", headers, body: JSON.stringify({ delete: [jobId] }) }, baseUrl);
            return;
        }
        if (isRunning) {
            await comfyuiFetch(`${normalizeBaseUrl(baseUrl)}/interrupt`, { method: "POST", headers, body: "{}" }, baseUrl);
        }
    } catch {
        // Best-effort: 无法确认目标任务位置时静默返回，绝不全局 interrupt。
    }
}

const generationLogStore = localforage.createInstance({ name: "infinite-canvas", storeName: "image_generation_logs" });

export type ComfyuiGenerationLog = {
    model: string;
    prompt: string;
    provider: "comfyui";
    jobId?: string;
    durationMs: number;
    status: "success" | "failed";
    imageCount?: number;
    images?: Array<{ id: string; dataUrl: string; seed?: number }>;
    errorMessage?: string;
    seed?: number;
};

/**
 * Persist a ComfyUI generation into the shared `image_generation_logs` localforage
 * store (the same store the OpenAI/Gemini workbench logs use) so it shows up in the
 * workbench history. The entry keeps the fields the image page's log normalizer
 * understands, plus ComfyUI-specific extras (provider / jobId / errorMessage).
 * Returns the entry id.
 */
export async function logImageGeneration(entry: ComfyuiGenerationLog): Promise<string> {
    const id = nanoid();
    const succeeded = entry.status === "success";
    const imageCount = entry.imageCount ?? 0;
    const record: Record<string, unknown> = {
        id,
        createdAt: Date.now(),
        title: entry.prompt.slice(0, 12),
        prompt: entry.prompt,
        model: entry.model,
        provider: entry.provider,
        jobId: entry.jobId || "",
        status: entry.status,
        durationMs: entry.durationMs,
        successCount: succeeded ? imageCount : 0,
        failCount: succeeded ? 0 : 1,
        imageCount: succeeded ? imageCount : 0,
        images: succeeded ? entry.images ?? [] : [],
    };
    if (entry.errorMessage) record.errorMessage = entry.errorMessage;
    if (entry.seed !== undefined) record.seed = entry.seed;
    await generationLogStore.setItem(id, record);
    return id;
}

export interface ComfyuiImageRequest {
    config: AiConfig;
    model: string;
    prompt: string;
    size?: string;
    seed?: number;
    jobId?: string;
    references?: ReferenceImage[];
    channelId?: string;
    workflowId?: string;
    category?: WorkflowCategory;
    signal?: AbortSignal;
    onProgress?: (status: string, detail?: Record<string, unknown>) => void;
}

export interface ComfyuiImageResult {
    items: Array<{ id: string; dataUrl: string; seed?: number }>;
    jobId: string;
    seed?: number;
}

function isT2iWorkflowModel(m?: ChannelModel): boolean {
    if (!m) return false;
    const name = m.name.toLowerCase();
    if (name.includes("i2i") || m.name.includes("图生图") || name.includes("inpaint") || m.name.includes("局部") || name.includes("遮罩") || name.includes("video") || m.name.includes("视频") || name.includes("audio") || name.includes("音频") || name.includes("llm")) {
        return false;
    }
    return m.name === "ComfyUI T2I" || name.includes("t2i") || m.name.includes("文生图") || m.capability === "image";
}

function isI2iWorkflowModel(m?: ChannelModel): boolean {
    if (!m) return false;
    const name = m.name.toLowerCase();
    return m.name === "ComfyUI I2I" || name.includes("i2i") || m.name.includes("图生图");
}

function isInpaintWorkflowModel(m?: ChannelModel): boolean {
    if (!m) return false;
    const name = m.name.toLowerCase();
    return m.name === "ComfyUI Inpaint" || name.includes("inpaint") || m.name.includes("局部编辑") || m.name.includes("局部修改") || m.name.includes("局部") || m.name.includes("遮罩");
}

function isTextWorkflowModel(m?: ChannelModel): boolean {
    if (!m) return false;
    const name = m.name.toLowerCase();
    return m.capability === "text" || m.name === "ComfyUI LLM" || name.includes("llm") || name.includes("text") || name.includes("文本") || name.includes("qwen") || name.includes("chat");
}

function isFrameVideoWorkflowModel(m?: ChannelModel): boolean {
    if (!m) return false;
    const name = m.name.toLowerCase();
    return m.name === "ComfyUI Frame Video" || name.includes("frame") || m.name.includes("首尾帧");
}

function isOmniVideoWorkflowModel(m?: ChannelModel): boolean {
    if (!m) return false;
    const name = m.name.toLowerCase();
    if (name.includes("frame") || m.name.includes("首尾帧")) return false;
    return m.name === "ComfyUI Video" || m.capability === "video" || name.includes("video") || m.name.includes("视频");
}

/**
 * 渠道里「为该模型 / 该分类」绑定的自定义工作流。
 *
 * 执行侧与节点上的「执行流」徽标共用这一处：徽标如果自己再写一套判断，就会出现
 * 「界面说跑 A、实际跑 B」——而这正是徽标要解决的问题。
 */
export function resolveChannelBoundWorkflow(channel: ModelChannel, requestModel: string | undefined, category: WorkflowCategory): ComfyuiWorkflow | undefined {
    const channelModel = requestModel ? channel.models.find((model) => model.name === requestModel) : undefined;
    switch (category) {
        case "i2i":
            return (
                (isI2iWorkflowModel(channelModel) ? channelModel?.comfyuiWorkflow : undefined) ||
                channel.comfyuiI2iWorkflow ||
                channel.models.find((model) => isI2iWorkflowModel(model))?.comfyuiWorkflow
            );
        case "inpaint":
            return (
                (isInpaintWorkflowModel(channelModel) ? channelModel?.comfyuiWorkflow : undefined) ||
                channel.comfyuiInpaintWorkflow ||
                channel.models.find((model) => isInpaintWorkflowModel(model))?.comfyuiWorkflow
            );
        case "text":
            return (
                (isTextWorkflowModel(channelModel) ? channelModel?.comfyuiWorkflow : undefined) ||
                channel.comfyuiTextWorkflow ||
                channel.models.find((model) => isTextWorkflowModel(model))?.comfyuiWorkflow
            );
        case "frameVideo":
            return (
                (isFrameVideoWorkflowModel(channelModel) ? channelModel?.comfyuiWorkflow : undefined) ||
                channel.comfyuiFrameVideoWorkflow ||
                channel.models.find((model) => isFrameVideoWorkflowModel(model))?.comfyuiWorkflow
            );
        case "omniVideo":
        case "faceRefine":
            return (
                (isOmniVideoWorkflowModel(channelModel) ? channelModel?.comfyuiWorkflow : undefined) ||
                channel.comfyuiVideoWorkflow ||
                channel.models.find((model) => isOmniVideoWorkflowModel(model))?.comfyuiWorkflow
            );
        case "t2i":
            return (
                (isT2iWorkflowModel(channelModel) ? channelModel?.comfyuiWorkflow : undefined) ||
                channel.comfyuiT2iWorkflow ||
                channel.models.find((model) => isT2iWorkflowModel(model))?.comfyuiWorkflow
            );
        default:
            return undefined;
    }
}

function imageReferenceSlots(workflow: ComfyuiWorkflowJson) {
    return Object.values(workflow)
        .map((node) => (node && typeof node === "object" ? (node as { _meta?: { title?: unknown } })._meta?.title : undefined))
        .filter((title): title is string => typeof title === "string")
        .map((title) => title.trim().toLowerCase())
        .filter((title) => /^ref_image(_\d{2})?$/.test(title))
        .sort();
}

/**
 * 文本工作流的参考图槽位数：除了 `ref_image_01..NN`，还要认老工作流那个不编号的
 * `image` 槽位（`imageReferenceSlots` 的严格正则故意不含它，图像链路别动）。
 */
function textReferenceSlots(workflow: ComfyuiWorkflowJson) {
    return Object.values(workflow).filter((node) => {
        const title = node && typeof node === "object" ? (node as { _meta?: { title?: unknown } })._meta?.title : undefined;
        if (typeof title !== "string") return false;
        const normalized = title.trim().toLowerCase();
        return normalized === "image" || normalized === "ref_image" || /^ref_image_\d{2}$/.test(normalized);
    });
}

/**
 * Run a full ComfyUI image generation: resolve the channel and model, bind the
 * generation params into the model's workflow, submit the job, poll it until
 * completion and download the outputs as data urls.
 *
 * - Aborting the signal cancels the matching ComfyUI job and rejects with
 *   ComfyuiAbortedError; the timeout window does NOT cancel the job, it only
 *   rejects with ComfyuiTimeoutError.
 * - Exactly one image_generation_logs entry (success or failed) is written
 *   before the result is returned or the error rethrown.
 */
export async function requestComfyuiImage(req: ComfyuiImageRequest): Promise<ComfyuiImageResult> {
    const startedAt = Date.now();
    let requestConfig: ReturnType<typeof resolveModelRequestConfig> | undefined;
    let channelName = "";
    let jobId = req.jobId || "";
    let seed: number | undefined = req.seed;
    try {
        const rawModel = req.model || req.config.imageModel || req.config.model;
        requestConfig = resolveModelRequestConfig(req.config, rawModel);
        const channel = resolveModelChannel(req.config, rawModel);
        channelName = channel.name;
        const requestModel = modelOptionName(rawModel);
        const channelModel = channel.models.find((model) => model.name === requestModel);
        const references = req.references || [];
        const isI2i = references.length > 0;
        const category: WorkflowCategory = req.category || (isI2i ? "i2i" : "t2i");
        const channelId = req.channelId || req.config.channelId || channel.id;
        const workflowId = req.workflowId || req.config.workflowId;
        // 渠道为该模型绑定的流；判断逻辑与节点上的「执行流」徽标共用一处。
        const channelWorkflow = resolveChannelBoundWorkflow(channel, requestModel, isI2i ? "i2i" : "t2i");

        // 渠道里存着工作流列表时，原来的兜底是「该分类的第一个流」，且多数渠道没有
        // isDefault 标记 —— 于是列表第一条（t2i 是 Z-Image-Turbo）会把模型档案顶掉，
        // 选 Qwen 也照样跑 Z-Image。优先级统一由 resolveExecutionWorkflow 决定：
        // 显式 pin → 模型档案 → 渠道绑定的流 → 渠道默认流。
        const resolved = resolveExecutionWorkflow({
            config: req.config,
            channel,
            channelId,
            workflowId,
            modelId: rawModel,
            category,
            // 图像节点的二级下拉直接列该渠道的工作流，配置里标为默认的那条必须真的作用到节点上，
            // 否则「界面列的是配置里的流、执行跑的是模型档案」再次分叉。
            respectChannelDefault: true,
            channelWorkflow,
        });
        const modelProfile = resolved?.modelProfile ?? getModelProfile(req.model || rawModel);
        if (modelProfile) {
            validateModelExecution(modelProfile, {
                imagesCount: references.length,
                size: req.size,
            });
        }
        const workflow = resolved ? { json: resolved.json } : undefined;
        if (!workflow) throw new ComfyuiNoWorkflowError(i18n.t("comfyui.noWorkflow", { model: requestModel }));
        const baseUrl = (channel.comfyuiProxyUrl || "").trim();
        const token = channel.comfyuiProxyToken;

        if (!jobId) {
            if (!modelProfile) {
                const referenceSlots = imageReferenceSlots(workflow.json);
                if (references.length && !referenceSlots.length) throw new ComfyuiError(i18n.t("comfyui.noImageReferenceSlot"));
                if (references.length > referenceSlots.length) throw new ComfyuiError(i18n.t("comfyui.imageReferenceLimit", { count: referenceSlots.length }));
            }

            const size = parseSize(req.size);
            if (seed === undefined) seed = generateRandomSeed();
            const refImages = await Promise.all(references.map((image, index) => uploadComfyuiAsset(baseUrl, token, image.dataUrl, image.name || `ref_image_${index + 1}.png`, req.signal)));
            const boundWorkflow = modelProfile
                ? dispatchComfyuiModelWorkflow(modelProfile, workflow.json, {
                      prompt: req.prompt,
                      width: size.width,
                      height: size.height,
                      seed,
                      assetIds: refImages,
                  })
                : applyBindings(workflow.json, { prompt: req.prompt, width: size.width, height: size.height, seed, refImages });
            jobId = await submitJob(boundWorkflow, baseUrl, token);
            req.onProgress?.("submitted", { jobId });
        }

        const signal = req.signal;
        if (signal?.aborted) {
            await cancelJob(jobId, baseUrl, token);
            throw new ComfyuiAbortedError();
        }

        const polling = pollJob(jobId, baseUrl, token, signal, startedAt + JOB_TIMEOUT_MS, collectImageAssetIds, req.onProgress);
        let waiting: Promise<string[] | undefined> = polling;
        if (signal) {
            // `{ once: true }` keeps the cancel call idempotent across repeated aborts;
            // the timeout path never reaches this listener. Aborting rejects the race
            // immediately so polling can stop without leaking on the heap.
            const aborted: Promise<never> = new Promise((_resolve, reject) => {
                signal.addEventListener("abort", () => {
                    void cancelJob(jobId, baseUrl, token).catch(() => undefined);
                    reject(new ComfyuiAbortedError());
                }, { once: true });
            });
            waiting = Promise.race([polling, aborted]);
        }
        const resultAssetIds = await waiting;
        if (!resultAssetIds) {
            // pollJob exited silently because the signal aborted; the abort listener already cancelled the job.
            throw new ComfyuiAbortedError();
        }
        if (resultAssetIds.length === 0) {
            throw new ComfyuiError(i18n.t("comfyui.noImageOutput"));
        }

        const items: Array<{ id: string; dataUrl: string; seed?: number }> = [];
        for (const assetId of resultAssetIds) {
            const { dataUrl } = await downloadAsset(assetId, baseUrl, token);
            items.push({ id: nanoid(), dataUrl, seed });
        }

        void logImageGeneration({ model: requestConfig.model, prompt: req.prompt, provider: "comfyui", jobId, durationMs: Date.now() - startedAt, status: "success", imageCount: items.length, images: items, seed }).catch(() => undefined);
        return { items, jobId, seed };
    } catch (error) {
        error = addComfyuiChannelContext(error, channelName);
        void logImageGeneration({
            model: requestConfig?.model ?? req.model,
            prompt: req.prompt,
            provider: "comfyui",
            jobId: jobId || undefined,
            durationMs: Date.now() - startedAt,
            status: "failed",
            errorMessage: error instanceof Error ? error.message : String(error),
            seed,
        }).catch(() => undefined);
        throw error;
    }
}

/**
 * Upload an image/media (dataURL or blob URL) to ComfyUI's /upload/image endpoint.
 * Returns the uploaded file name.
 */
export async function uploadComfyuiAsset(
    baseUrl: string,
    token: string | undefined,
    dataUrl: string,
    filename = "image.png",
    signal?: AbortSignal,
): Promise<string> {
    const res = await fetch(dataUrl);
    const blob = await res.blob();
    const form = new FormData();
    const safeFilename = `${nanoid(8)}_${filename.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
    form.append("image", blob, safeFilename);
    form.append("overwrite", "true");
    form.append("type", "input");

    const headers: Record<string, string> = {};
    if (token) headers.Authorization = `Bearer ${token}`;

    const url = `${normalizeBaseUrl(baseUrl)}/upload/image`;
    const request = { url, method: "POST" };
    const uploadRes = await comfyuiFetch(url, {
        method: "POST",
        headers,
        body: form,
        signal,
    }, baseUrl);
    if (!uploadRes.ok) {
        throw new ComfyuiApiError("ComfyUI 参考资源上传失败", uploadRes.status, request);
    }
    const data = (await uploadRes.json()) as { name?: string; subfolder?: string };
    if (!data?.name) throw new ComfyuiApiError("ComfyUI 参考资源上传接口未返回文件名", undefined, request);
    return data.subfolder ? `${data.subfolder}/${data.name}` : data.name;
}

export interface ComfyuiInpaintRequest {
    config: AiConfig;
    model?: string;
    prompt: string;
    sourceDataUrl: string;
    maskDataUrl: string;
    channelId?: string;
    workflowId?: string;
    seed?: number;
    jobId?: string;
    signal?: AbortSignal;
    onProgress?: (status: string, detail?: { jobId?: string }) => void;
}

export async function requestComfyuiInpaint(req: ComfyuiInpaintRequest): Promise<ComfyuiImageResult> {
    const startedAt = Date.now();
    let channelName = "";
    let jobId = req.jobId || "";
    let seed: number | undefined = req.seed;
    try {
        const rawModel = req.model || req.config.imageModel || req.config.model;
        const channel = resolveModelChannel(req.config, rawModel);
        channelName = channel.name;
        const requestModel = modelOptionName(rawModel);
        const channelModel = channel.models.find((model) => model.name === requestModel);
        const channelId = req.channelId || req.config.channelId || channel.id;
        const workflowId = req.workflowId || req.config.workflowId;
        const resolved = resolveExecutionWorkflow({
            config: req.config,
            channel,
            channelId,
            workflowId,
            modelId: rawModel,
            category: "inpaint",
            respectChannelDefault: true,
            channelWorkflow: resolveChannelBoundWorkflow(channel, requestModel, "inpaint"),
        });
        const modelProfile = resolved?.modelProfile ?? getModelProfile(req.model || rawModel || "inpaint");
        const inpaintWorkflow = resolved ? { json: resolved.json } : undefined;
        if (!inpaintWorkflow) {
            throw new ComfyuiNoWorkflowError(i18n.t("comfyui.noInpaintWorkflow"));
        }
        const baseUrl = (channel.comfyuiProxyUrl || "").trim();
        const token = channel.comfyuiProxyToken;

        if (!jobId) {
            // 1. Upload source image and mask image
            const [refAssetId, maskAssetId] = await Promise.all([
                uploadComfyuiAsset(baseUrl, token, req.sourceDataUrl, "ref_image.png", req.signal),
                uploadComfyuiAsset(baseUrl, token, req.maskDataUrl, "ref_mask.png", req.signal),
            ]);

            // 2. Bind parameters into workflow
            if (seed === undefined) seed = generateRandomSeed();
            const boundWorkflow = modelProfile
                ? dispatchComfyuiModelWorkflow(modelProfile, inpaintWorkflow.json, {
                      prompt: req.prompt,
                      seed,
                      assetIds: [refAssetId],
                      maskAssetId,
                  })
                : applyBindings(inpaintWorkflow.json, {
                      prompt: req.prompt,
                      seed,
                      refImages: [refAssetId],
                      refMask: maskAssetId,
                  });

            // 3. Submit job
            jobId = await submitJob(boundWorkflow, baseUrl, token);
            req.onProgress?.("submitted", { jobId });
        }

        const signal = req.signal;
        if (signal?.aborted) {
            await cancelJob(jobId, baseUrl, token);
            throw new ComfyuiAbortedError();
        }

        // 4. Poll job
        const polling = pollJob(jobId, baseUrl, token, signal, startedAt + JOB_TIMEOUT_MS, (outputs) => prioritizeInpaintOutput(outputs, inpaintWorkflow.json), req.onProgress);
        let waiting: Promise<string[] | undefined> = polling;
        if (signal) {
            const aborted: Promise<never> = new Promise((_resolve, reject) => {
                signal.addEventListener("abort", () => {
                    void cancelJob(jobId, baseUrl, token).catch(() => undefined);
                    reject(new ComfyuiAbortedError());
                }, { once: true });
            });
            waiting = Promise.race([polling, aborted]);
        }
        const resultAssetIds = await waiting;
        if (!resultAssetIds) {
            throw new ComfyuiAbortedError();
        }
        if (resultAssetIds.length === 0) {
            throw new ComfyuiError(i18n.t("comfyui.noImageOutput"));
        }

        // 5. Download outputs
        const items: Array<{ id: string; dataUrl: string; seed?: number }> = [];
        for (const assetId of resultAssetIds) {
            const { dataUrl } = await downloadAsset(assetId, baseUrl, token);
            items.push({ id: nanoid(), dataUrl, seed });
        }

        void logImageGeneration({ model: "ComfyUI Inpaint", prompt: req.prompt, provider: "comfyui", jobId, durationMs: Date.now() - startedAt, status: "success", imageCount: items.length, images: items, seed }).catch(() => undefined);
        return { items, jobId, seed };
    } catch (error) {
        error = addComfyuiChannelContext(error, channelName);
        void logImageGeneration({
            model: "ComfyUI Inpaint",
            prompt: req.prompt,
            provider: "comfyui",
            jobId: jobId || undefined,
            durationMs: Date.now() - startedAt,
            status: "failed",
            errorMessage: error instanceof Error ? error.message : String(error),
            seed,
        }).catch(() => undefined);
        throw error;
    }
}

/** Built-in fallback workflow JSON for ComfyUI LLM text generation and visual prompt inference (Qwen-3.5 VLM). */
export const FALLBACK_COMFYUI_TEXT_WORKFLOW_JSON: ComfyuiWorkflowJson = {
    "1": {
        inputs: {
            clip_name: "qwen3.5_4b_bf16.safetensors",
            type: "stable_diffusion",
            device: "default",
        },
        class_type: "CLIPLoader",
        _meta: { title: "加载CLIP" },
    },
    "3": {
        inputs: {
            prompt: ["8", 0],
            max_length: 256,
            sampling_mode: "on",
            "sampling_mode.temperature": 0.7,
            "sampling_mode.top_k": 64,
            "sampling_mode.top_p": 0.95,
            "sampling_mode.min_p": 0.05,
            "sampling_mode.repetition_penalty": 1.05,
            "sampling_mode.seed": ["26", 0],
            "sampling_mode.presence_penalty": 0,
            thinking: false,
            use_default_template: true,
            clip: ["1", 0],
            image: ["12", 0],
        },
        class_type: "TextGenerate",
        _meta: { title: "TextGenerate" },
    },
    "8": {
        inputs: {
            value: "请根据参考图片反推一段适合用于 AI 生图的提示词。\n\n要求：\n1. 只输出提示词正文，不要解释。\n2. 覆盖主体、构图、风格、光线、色彩、材质、镜头和氛围。\n3. 尽量写成可直接用于生图模型的完整提示词。",
        },
        class_type: "PrimitiveStringMultiline",
        _meta: { title: "prompt" },
    },
    "12": {
        inputs: {
            image: "",
        },
        class_type: "LoadImage",
        _meta: { title: "image" },
    },
    "15": {
        inputs: {
            output_file_path: "output/prompt",
            file_name: ["25", 0],
            file_extension: "txt",
            overwrite: true,
            text: ["16", 0],
        },
        class_type: "easy saveText",
        _meta: { title: "保存文本" },
    },
    "16": {
        inputs: {
            source: ["3", 0],
        },
        class_type: "PreviewAny",
        _meta: { title: "预览任意" },
    },
    "23": {
        inputs: {
            input_type: "INT",
            output_type: "STRING",
            string_input: "",
            int_input: ["26", 0],
            float_input: 0,
            boolean_input: false,
        },
        class_type: "kkSomethingToAny",
        _meta: { title: "kkSomethingToAny（任意类型转换）" },
    },
    "25": {
        inputs: {
            text: "4747",
            data: ["23", 0],
        },
        class_type: "ShowAny_UTK",
        _meta: { title: "Show Any (UTK)" },
    },
    "26": {
        inputs: {
            value: 388590439460300,
        },
        class_type: "PrimitiveInt",
        _meta: { title: "seed" },
    },
};

/**
 * Deep-copy a text/LLM workflow and bind prompt, random seed, and optional image.
 * If NO image asset is provided, nodes with _meta.title === "image" are removed from the graph,
 * and any links pointing to them are cleanly removed so the node runs text-to-text.
 */
export function applyTextBindings(
    workflow: ComfyuiWorkflowJson,
    params: {
        prompt: string;
        /** 单图参考（老调用点）：等价于只有一张的 `assetIds` */
        assetId?: string;
        /** 多图参考，按连线顺序依次写入 ref_image_01..NN */
        assetIds?: string[];
        seed?: number;
        maxLength?: number;
        thinking?: boolean;
    },
): ComfyuiWorkflowJson {
    const cloned = structuredClone(workflow);
    type NodeRecord = {
        class_type?: string;
        inputs?: Record<string, unknown>;
        _meta?: { title?: unknown };
    };

    // 单图调用点继续沿用 assetId；多图按连线顺序占位（第 1 张 → ref_image_01）。
    const assetIds = (params.assetIds?.length ? params.assetIds : params.assetId ? [params.assetId] : []).filter(
        (asset): asset is string => typeof asset === "string" && Boolean(asset),
    );

    /** ref_image_01..NN：编号就是连线顺序（生成侧 <Picture N> 与之一一对应） */
    const numberedSlots: Array<{ nodeId: string; index: number }> = [];
    /** 老工作流只有一个不编号的 image / ref_image 槽位 */
    const legacySlots: string[] = [];

    // 1. 找到 prompt / seed 节点，同时收集参考图槽位
    let boundSeedTitle = false;
    for (const [nodeId, node] of Object.entries(cloned)) {
        if (typeof node !== "object" || node === null) continue;
        const record = node as NodeRecord;
        const rawTitle = record._meta?.title;
        if (typeof rawTitle !== "string") continue;
        const title = rawTitle.trim().toLowerCase();

        const numbered = /^ref_image_(\d{2})$/.exec(title);
        if (numbered) {
            numberedSlots.push({ nodeId, index: Number(numbered[1]) - 1 });
            continue;
        }
        if (title === "image" || title === "ref_image") {
            legacySlots.push(nodeId);
            continue;
        }

        if (title === "prompt" && record.inputs) {
            const defaultVlmPrompt =
                "请根据参考图片反推一段适合用于 AI 生图的提示词。\n\n要求：\n1. 只输出提示词正文，不要解释。\n2. 覆盖主体、构图、风格、光线、色彩、材质、镜头和氛围。\n3. 尽量写成可直接用于生图模型的完整提示词。";
            const promptVal = params.prompt && params.prompt.trim()
                ? params.prompt
                : assetIds.length
                ? (typeof record.inputs.value === "string" && record.inputs.value && record.inputs.value.includes("反推")
                    ? record.inputs.value
                    : defaultVlmPrompt)
                : params.prompt;
            if ("value" in record.inputs) record.inputs.value = promptVal;
            else if ("text" in record.inputs) record.inputs.text = promptVal;
            else if ("prompt" in record.inputs) record.inputs.prompt = promptVal;
        } else if (title === "seed" && params.seed !== undefined && record.inputs) {
            if ("value" in record.inputs) record.inputs.value = params.seed;
            else if ("seed" in record.inputs) record.inputs.seed = params.seed;
            else if ("int_input" in record.inputs) record.inputs.int_input = params.seed;
            boundSeedTitle = true;
        }
    }

    // 2. 参考图槽位按顺序占位；没图可填的槽位连同节点与下游连线一起摘掉。
    //
    //    以前这里只认「一个」image 节点，多槽位工作流（ref_image_01..06）只有第一个被
    //    绑定，其余 LoadImage 保留着 JSON 里录制的示例文件名直接提交，ComfyUI 于是报
    //    `Custom validation failed for node: image - Invalid image file: xxx.png`。
    //    参考图生图的处理方式：连接几张就绑定几张，未填充的槽位从执行图里裁掉。
    numberedSlots.sort((a, b) => a.index - b.index);
    const removedNodeIds = new Set<string>();
    const writeSlotImage = (nodeId: string, assetId: string) => {
        const record = cloned[nodeId] as NodeRecord | undefined;
        if (record?.inputs) record.inputs.image = assetId;
    };

    let cursor = 0;
    for (const slot of numberedSlots) {
        if (cursor < assetIds.length) writeSlotImage(slot.nodeId, assetIds[cursor++]);
        else removedNodeIds.add(slot.nodeId);
    }
    for (const nodeId of legacySlots) {
        if (cursor < assetIds.length) writeSlotImage(nodeId, assetIds[cursor++]);
        else removedNodeIds.add(nodeId);
    }

    // 3. 落盘删除：节点本体 + 所有指向它的连线参数（`["12", 0]` 这类）
    for (const nodeId of removedNodeIds) delete cloned[nodeId];
    if (removedNodeIds.size > 0) {
        for (const node of Object.values(cloned)) {
            if (typeof node !== "object" || node === null) continue;
            const record = node as NodeRecord;
            if (!record.inputs) continue;
            for (const [inputKey, val] of Object.entries(record.inputs)) {
                if (Array.isArray(val) && removedNodeIds.has(String(val[0]))) delete record.inputs[inputKey];
            }
        }
    }

    // 4. Fallback: handle seed only if no node has _meta.title === "seed"
    if (params.seed !== undefined && !boundSeedTitle) {
        for (const node of Object.values(cloned)) {
            if (typeof node !== "object" || node === null) continue;
            const record = node as NodeRecord;
            if (!record.inputs) continue;
            if ("sampling_mode.seed" in record.inputs && !Array.isArray(record.inputs["sampling_mode.seed"])) {
                record.inputs["sampling_mode.seed"] = params.seed;
            } else if ("seed" in record.inputs && !Array.isArray(record.inputs.seed)) {
                record.inputs.seed = params.seed;
            }
        }
    }

    // 5. Handle text generator parameters: max_length, thinking
    for (const node of Object.values(cloned)) {
        if (typeof node !== "object" || node === null) continue;
        const record = node as NodeRecord;
        if (!record.inputs) continue;
        if (params.maxLength !== undefined && "max_length" in record.inputs && typeof record.inputs.max_length === "number") {
            record.inputs.max_length = params.maxLength;
        }
        if (params.thinking !== undefined && "thinking" in record.inputs && typeof record.inputs.thinking === "boolean") {
            record.inputs.thinking = params.thinking;
        }
    }

    return cloned;
}

/** Clean raw text output: unwrap JSON arrays, JSON objects, or quoted strings. */
export function cleanExtractedText(raw: string): string {
    let cleaned = raw.trim();
    if ((cleaned.startsWith("[") && cleaned.endsWith("]")) || (cleaned.startsWith("{") && cleaned.endsWith("}"))) {
        try {
            const parsed = JSON.parse(cleaned);
            if (Array.isArray(parsed) && typeof parsed[0] === "string") {
                cleaned = parsed[0].trim();
            } else if (parsed && typeof parsed === "object") {
                const rec = parsed as Record<string, unknown>;
                const val = rec.text || rec.content || rec.value || rec.prompt;
                if (typeof val === "string") cleaned = val.trim();
                else if (Array.isArray(val) && typeof val[0] === "string") cleaned = val[0].trim();
            }
        } catch {
            // keep raw
        }
    } else if (cleaned.startsWith('"') && cleaned.endsWith('"')) {
        try {
            cleaned = JSON.parse(cleaned);
        } catch {
            // keep raw
        }
    }
    return cleaned;
}

/** Recursively search job status response object for text outputs (e.g. ComfyUI history or UI outputs). */
export function extractTextFromJobResponse(data: unknown): string {
    if (!data || typeof data !== "object") return "";
    const visited = new Set<unknown>();

    function search(obj: unknown, depth: number): string {
        if (!obj || depth > 6 || visited.has(obj)) return "";
        visited.add(obj);

        if (typeof obj === "string") {
            const trimmed = obj.trim();
            if (trimmed.length > 20 && !trimmed.startsWith("http://") && !trimmed.startsWith("https://") && !/^[0-9a-f-]{36}$/i.test(trimmed)) {
                return trimmed;
            }
            return "";
        }

        if (Array.isArray(obj)) {
            for (const item of obj) {
                const res = search(item, depth + 1);
                if (res) return res;
            }
            return "";
        }

        if (typeof obj === "object") {
            const rec = obj as Record<string, unknown>;
            for (const key of ["text", "ui", "string", "ui_string", "prompt", "result", "history", "outputs"]) {
                if (key in rec && rec[key] !== undefined) {
                    const res = search(rec[key], depth + 1);
                    if (res) return res;
                }
            }
            for (const val of Object.values(rec)) {
                const res = search(val, depth + 1);
                if (res) return res;
            }
        }
        return "";
    }

    return search(data, 0);
}

/**
 * Download a text asset's content from ComfyUI /view endpoint and return as string.
 */
export async function downloadComfyuiText(assetIdOrUrl: string, baseUrl: string, token?: string): Promise<string> {
    const headers: Record<string, string> = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    const url = assetIdOrUrl.startsWith("http://") || assetIdOrUrl.startsWith("https://")
        ? assetIdOrUrl
        : assetIdOrUrl.startsWith("/view?")
          ? `${normalizeBaseUrl(baseUrl)}${assetIdOrUrl}`
          : `${normalizeBaseUrl(baseUrl)}/view?filename=${encodeURIComponent(assetIdOrUrl)}&type=output`;
    const response = await comfyuiFetch(url, { headers }, baseUrl);
    if (!response.ok) throw new ComfyuiApiError(`Failed to download text asset: ${response.status}`, response.status);
    return await response.text();
}

export interface ComfyuiTextRequest {
    config: AiConfig;
    prompt: string;
    model?: string;
    /** 单图（兼容老调用点） */
    imageDataUrl?: string;
    /** 多图参考，按连线顺序依次写入 ref_image_01..NN */
    imageDataUrls?: string[];
    channelId?: string;
    workflowId?: string;
    seed?: number;
    maxLength?: number;
    thinking?: boolean;
    jobId?: string;
    signal?: AbortSignal;
    onProgress?: (status: string, detail?: { jobId?: string }) => void;
    onDelta?: (text: string) => void;
}

export async function requestComfyuiText(req: ComfyuiTextRequest): Promise<{ text: string; jobId: string }> {
    const startedAt = Date.now();
    let channelName = "";
    let jobId = req.jobId || "";
    let seed: number | undefined = req.seed;
    try {
        const rawModel = req.model || req.config.textModel || req.config.model;
        const channel = resolveModelChannel(req.config, rawModel);
        channelName = channel.name;
        const requestModel = modelOptionName(rawModel);
        const channelModel = channel.models.find((model) => model.name === requestModel);
        const channelId = req.channelId || req.config.channelId || channel.id;
        const workflowId = req.workflowId || req.config.workflowId;
        const resolved = resolveExecutionWorkflow({
            config: req.config,
            channel,
            channelId,
            workflowId,
            modelId: rawModel,
            category: "text",
            // 文本节点二级同样列该渠道配置里的流（含自定义反推提示词），默认标记要生效。
            respectChannelDefault: true,
            channelWorkflow: resolveChannelBoundWorkflow(channel, requestModel, "text"),
        });
        const textWorkflow = resolved ? { json: resolved.json } : undefined;

        if (!textWorkflow) {
            throw new ComfyuiNoWorkflowError(i18n.t("comfyui.noTextWorkflow"));
        }
        const baseUrl = (channel.comfyuiProxyUrl || "").trim();
        const token = channel.comfyuiProxyToken;

        if (!jobId) {
            // 文本节点可以连 0..N 张参考图：0 张＝纯文本扩写，N 张＝多图反推。
            // 工作流里录制的 ref_image_0N 槽位未必都有图，未填充的槽位由 applyTextBindings
            // 从执行图里裁掉（和参考图生图同一套处理），否则那些 LoadImage 会带着 JSON 里
            // 录制的示例文件名提交，ComfyUI 直接判 `Invalid image file`。
            const imageDataUrls = (req.imageDataUrls?.length
                ? req.imageDataUrls
                : req.imageDataUrl
                  ? [req.imageDataUrl]
                  : []
            ).filter((url): url is string => typeof url === "string" && Boolean(url));

            const referenceSlots = textReferenceSlots(textWorkflow.json as unknown as ComfyuiWorkflowJson);
            if (imageDataUrls.length > 0 && referenceSlots.length === 0) {
                throw new ComfyuiError(i18n.t("comfyui.noImageReferenceSlot"));
            }
            if (referenceSlots.length > 0 && imageDataUrls.length > referenceSlots.length) {
                throw new ComfyuiError(i18n.t("comfyui.imageReferenceLimit", { count: referenceSlots.length }));
            }

            const assetIds = await Promise.all(
                imageDataUrls.map((dataUrl, index) =>
                    uploadComfyuiAsset(baseUrl, token, dataUrl, `ref_image_${String(index + 1).padStart(2, "0")}.png`, req.signal),
                ),
            );

            if (seed === undefined) seed = generateRandomSeed();
            const boundWorkflow = applyTextBindings(textWorkflow.json as unknown as ComfyuiWorkflowJson, {
                prompt: req.prompt,
                assetIds,
                seed,
                maxLength: req.maxLength,
                thinking: req.thinking,
            });

            jobId = await submitJob(boundWorkflow, baseUrl, token);
            req.onProgress?.("submitted", { jobId });
        }

        const signal = req.signal;
        if (signal?.aborted) {
            await cancelJob(jobId, baseUrl, token);
            throw new ComfyuiAbortedError();
        }

        const polling = pollJobRaw(jobId, baseUrl, token, signal, startedAt + JOB_TIMEOUT_MS, req.onProgress);
        let waiting: Promise<PollJobResult | undefined> = polling;
        if (signal) {
            const aborted: Promise<never> = new Promise((_resolve, reject) => {
                signal.addEventListener(
                    "abort",
                    () => {
                        void cancelJob(jobId, baseUrl, token).catch(() => undefined);
                        reject(new ComfyuiAbortedError());
                    },
                    { once: true },
                );
            });
            waiting = Promise.race([polling, aborted]);
        }
        const pollResult = await waiting;
        if (!pollResult) {
            throw new ComfyuiAbortedError();
        }

        let text = "";
        const outputs = pollResult.outputs;

        // 1. Sort outputs prioritizing text, txt/json/md file assets
        const prioritizedOutputs = [...outputs].sort((a, b) => {
            const getScore = (item: unknown) => {
                if (!item || typeof item !== "object") return 0;
                const rec = item as { type?: unknown; name?: unknown; content_type?: unknown };
                const type = String(rec.type || "").toLowerCase();
                const name = String(rec.name || "").toLowerCase();
                const ct = String(rec.content_type || "").toLowerCase();
                if (type === "text" || name.endsWith(".txt") || ct.startsWith("text/")) return 3;
                if (type === "file" || name.endsWith(".json") || name.endsWith(".md")) return 2;
                if (type === "image" || type === "video") return -1;
                return 1;
            };
            return getScore(b) - getScore(a);
        });

        for (const entry of prioritizedOutputs) {
            if (!entry || typeof entry !== "object") continue;
            const rec = entry as { id?: unknown; url?: unknown; text?: unknown; value?: unknown; type?: unknown; content_type?: unknown; name?: unknown };
            if (typeof rec.text === "string" && rec.text.trim()) {
                text = cleanExtractedText(rec.text);
                break;
            } else if (typeof rec.value === "string" && rec.value.trim()) {
                text = cleanExtractedText(rec.value);
                break;
            } else if (typeof rec.id === "string" || typeof rec.url === "string") {
                const target = typeof rec.url === "string" && rec.url ? rec.url : String(rec.id);
                try {
                    const raw = await downloadComfyuiText(target, baseUrl, token);
                    const cleaned = cleanExtractedText(raw);
                    if (cleaned) {
                        text = cleaned;
                        break;
                    }
                } catch {
                    // continue to next output entry
                }
            }
        }

        // 2. If no text found in outputs, inspect job status response (history/result/ui)
        if (!text && pollResult.job) {
            text = extractTextFromJobResponse(pollResult.job);
        }

        if (!text) {
            console.warn("[ComfyUI] Text generation succeeded but no text was extracted from job:", pollResult.job);
            throw new Error("ComfyUI 执行成功但未获取到文本输出，请确认工作流中包含保存文本节点（如 easy saveText）或有效文本输出节点。");
        }

        req.onDelta?.(text);
        return { text, jobId };
    } catch (error) {
        throw addComfyuiChannelContext(error, channelName);
    }
}

/**
 * Download a video asset's content from ComfyUI /view endpoint and return as data URL.
 */
export async function downloadComfyuiVideo(assetId: string, baseUrl: string, token?: string): Promise<{ dataUrl: string; mimeType: string }> {
    const { blob, dataUrl } = await downloadAsset(assetId, baseUrl, token);
    const mimeType = blob.type || "video/mp4";
    return { dataUrl, mimeType };
}

/**
 * Collect output asset ids for video generation jobs, prioritizing type = "output".
 */
export function collectVideoAssetIds(outputs: unknown): string[] {
    if (!Array.isArray(outputs)) return [];
    const outputIds: string[] = [];
    const tempIds: string[] = [];
    const otherIds: string[] = [];

    for (const item of outputs) {
        if (!item || typeof item !== "object") continue;
        const rec = item as { id?: unknown; type?: unknown; output_type?: unknown; content_type?: unknown; url?: unknown; filename?: unknown; subfolder?: unknown };
        const id = typeof rec.id === "string" && rec.id ? rec.id : typeof rec.url === "string" && rec.url ? rec.url : typeof rec.filename === "string" ? rec.filename : "";
        if (!id) continue;
        const filename = typeof rec.filename === "string" ? rec.filename.toLowerCase() : "";
        const idLower = id.toLowerCase();
        const type = String(rec.type || "").toLowerCase();
        const contentType = String(rec.content_type || "").toLowerCase();
        const isVideo =
            type === "video" ||
            contentType.startsWith("video/") ||
            filename.endsWith(".mp4") ||
            filename.endsWith(".webm") ||
            filename.endsWith(".mov") ||
            filename.endsWith(".mkv") ||
            idLower.includes(".mp4") ||
            idLower.includes(".webm") ||
            idLower.includes(".mov") ||
            idLower.includes(".mkv");

        if (isVideo) {
            const rank = getOutputTypeRank(typeof rec.output_type === "string" ? rec.output_type : undefined, id);
            if (rank === 0) {
                outputIds.push(id);
            } else if (rank === 1) {
                tempIds.push(id);
            } else {
                otherIds.push(id);
            }
        }
    }

    if (outputIds.length > 0) return outputIds;
    if (tempIds.length > 0) return tempIds;
    if (otherIds.length > 0) return otherIds;

    for (const item of outputs) {
        if (item && typeof item === "object") {
            const rec = item as { id?: unknown; url?: unknown; filename?: unknown; output_type?: unknown };
            const fallbackId = typeof rec.id === "string" && rec.id ? rec.id : typeof rec.url === "string" && rec.url ? rec.url : typeof rec.filename === "string" ? rec.filename : "";
            if (fallbackId) {
                const rank = getOutputTypeRank(typeof rec.output_type === "string" ? rec.output_type : undefined, fallbackId);
                if (rank === 0) outputIds.push(fallbackId);
                else if (rank === 1) tempIds.push(fallbackId);
                else otherIds.push(fallbackId);
            }
        }
    }
    if (outputIds.length > 0) return outputIds;
    if (tempIds.length > 0) return tempIds;
    return otherIds;
}

/**
 * Collect output asset ids for audio generation jobs, prioritizing type = "output".
 */
export function collectAudioAssetIds(outputs: unknown): string[] {
    if (!Array.isArray(outputs)) return [];
    const outputIds: string[] = [];
    const tempIds: string[] = [];
    const otherIds: string[] = [];

    for (const item of outputs) {
        if (!item || typeof item !== "object") continue;
        const rec = item as { id?: unknown; type?: unknown; output_type?: unknown; content_type?: unknown; filename?: unknown; url?: unknown };
        const id = typeof rec.id === "string" && rec.id ? rec.id : typeof rec.url === "string" && rec.url ? rec.url : typeof rec.filename === "string" ? rec.filename : "";
        if (!id) continue;
        const fn = typeof rec.filename === "string" ? rec.filename.toLowerCase() : "";
        const idLower = id.toLowerCase();
        const type = String(rec.type || "").toLowerCase();
        const contentType = String(rec.content_type || "").toLowerCase();
        const isAudio =
            type === "audio" ||
            contentType.startsWith("audio/") ||
            /\.(mp3|wav|ogg|flac|m4a|aac|opus)$/i.test(fn) ||
            /\.(mp3|wav|ogg|flac|m4a|aac|opus)/i.test(idLower);

        if (isAudio) {
            const rank = getOutputTypeRank(typeof rec.output_type === "string" ? rec.output_type : undefined, id);
            if (rank === 0) {
                outputIds.push(id);
            } else if (rank === 1) {
                tempIds.push(id);
            } else {
                otherIds.push(id);
            }
        }
    }
    if (outputIds.length > 0) return outputIds;
    if (tempIds.length > 0) return tempIds;
    return otherIds;
}

/**
 * Deep-copy a video workflow and bind prompt, reference images, and random seed.
 */

export function applyVideoBindings(
    workflow: ComfyuiWorkflowJson,
    params: {
        prompt: string;
        assetIds?: string[];
        videoAssetIds?: string[];
        audioAssetIds?: string[];
        firstFrameAssetId?: string;
        lastFrameAssetId?: string;
        videoMode?: "omni" | "frame";
        width?: number;
        height?: number;
        duration?: number;
        seed?: number;
    },
): ComfyuiWorkflowJson {
    const cloned = structuredClone(workflow);
    type NodeRecord = {
        class_type?: string;
        inputs?: Record<string, unknown>;
        _meta?: { title?: unknown };
    };

    let boundPrompt = false;
    let refIndex = 0;
    for (const node of Object.values(cloned)) {
        if (typeof node !== "object" || node === null) continue;
        const record = node as NodeRecord;
        const rawTitle = record._meta?.title;
        const title = typeof rawTitle === "string" ? rawTitle.trim().toLowerCase() : "";
        if (!record.inputs) continue;

        if (title === "prompt") {
            if ("value" in record.inputs) record.inputs.value = params.prompt;
            else if ("text" in record.inputs) record.inputs.text = params.prompt;
            else if ("prompt" in record.inputs) record.inputs.prompt = params.prompt;
            boundPrompt = true;
        }

        if (title === "width" && params.width !== undefined) {
            if ("Number" in record.inputs) record.inputs.Number = String(params.width);
            else if ("value" in record.inputs) record.inputs.value = params.width;
            else if ("width" in record.inputs) record.inputs.width = params.width;
        }

        if (title === "height" && params.height !== undefined) {
            if ("Number" in record.inputs) record.inputs.Number = String(params.height);
            else if ("value" in record.inputs) record.inputs.value = params.height;
            else if ("height" in record.inputs) record.inputs.height = params.height;
        }

        if (title === "duration" && params.duration !== undefined) {
            if ("Number" in record.inputs) record.inputs.Number = String(params.duration);
            else if ("value" in record.inputs) record.inputs.value = params.duration;
            else if ("duration" in record.inputs) record.inputs.duration = params.duration;
            else if ("frames" in record.inputs) record.inputs.frames = params.duration;
        }

        // 首尾帧插槽绑定
        if (title === "first_frame" && params.firstFrameAssetId) {
            record.inputs.image = params.firstFrameAssetId;
        } else if (title === "last_frame" && params.lastFrameAssetId) {
            record.inputs.image = params.lastFrameAssetId;
        }

        // 1. 全能参考 - 图片插槽绑定
        if (params.assetIds && params.assetIds.length > 0) {
            const numberedMatch = /^ref_image_(\d{2})$/.exec(title);
            if (numberedMatch) {
                const idx = Number(numberedMatch[1]) - 1;
                if (params.assetIds[idx]) {
                    record.inputs.image = params.assetIds[idx];
                }
            } else if (title === "ref_image" || title === "image" || title.includes("input_image")) {
                const assetId = params.assetIds[refIndex % params.assetIds.length];
                refIndex++;
                record.inputs.image = assetId;
            }
        }

        // 2. 全能参考 - 视频插槽绑定
        if (params.videoAssetIds && params.videoAssetIds.length > 0) {
            const numberedMatch = /^ref_video_(0[1-9])$/.exec(title);
            if (numberedMatch) {
                const idx = Number(numberedMatch[1]) - 1;
                if (params.videoAssetIds[idx]) {
                    const assetVal = params.videoAssetIds[idx];
                    if ("file" in record.inputs) record.inputs.file = assetVal;
                    else if ("video" in record.inputs) record.inputs.video = assetVal;
                    else record.inputs.file = assetVal;
                }
            }
        }

        // 3. 全能参考 - 音频插槽绑定
        if (params.audioAssetIds && params.audioAssetIds.length > 0) {
            const numberedMatch = /^ref_audio_(0[1-9])$/.exec(title);
            if (numberedMatch) {
                const idx = Number(numberedMatch[1]) - 1;
                if (params.audioAssetIds[idx]) {
                    const assetVal = params.audioAssetIds[idx];
                    if ("audio" in record.inputs) record.inputs.audio = assetVal;
                    else if ("file" in record.inputs) record.inputs.file = assetVal;
                    else record.inputs.audio = assetVal;
                }
            }
        }

        if (params.seed !== undefined) {
            if ("seed" in record.inputs) record.inputs.seed = params.seed;
            else if ("sampling_mode.seed" in record.inputs) record.inputs["sampling_mode.seed"] = params.seed;
            else if ("noise_seed" in record.inputs) record.inputs.noise_seed = params.seed;
            else if ("value" in record.inputs && title === "seed") record.inputs.value = params.seed;
        }
    }

    if (!boundPrompt && params.prompt) {
        for (const node of Object.values(cloned)) {
            if (typeof node !== "object" || node === null) continue;
            const record = node as NodeRecord;
            if (!record.inputs) continue;
            if ("prompt" in record.inputs && typeof record.inputs.prompt === "string") {
                record.inputs.prompt = params.prompt;
                break;
            } else if ("text" in record.inputs && typeof record.inputs.text === "string") {
                record.inputs.text = params.prompt;
                break;
            }
        }
    }

    // 自动抹除未指派资产的参考节点及其级联连线，避免向 ComfyUI 提交旧文件或断链
    const assignedImageCount = params.assetIds?.length || 0;
    const assignedVideoCount = params.videoAssetIds?.length || 0;
    const assignedAudioCount = params.audioAssetIds?.length || 0;
    const removedNodeIds = new Set<string>();

    // Pass 1: 按 _meta.title 匹配 ref_image_NN / ref_video_NN / ref_audio_NN / first_frame / last_frame
    for (const [id, node] of Object.entries(cloned)) {
        if (typeof node !== "object" || node === null) continue;
        const record = node as NodeRecord;
        const rawTitle = record._meta?.title;
        const title = typeof rawTitle === "string" ? rawTitle.trim().toLowerCase() : "";

        if (title === "first_frame" && !params.firstFrameAssetId) {
            removedNodeIds.add(id);
        }
        if (title === "last_frame" && !params.lastFrameAssetId) {
            removedNodeIds.add(id);
        }

        const imgMatch = /^ref_image_(\d{2})$/.exec(title);
        if (imgMatch) {
            const idx = Number(imgMatch[1]) - 1;
            if (idx >= assignedImageCount) removedNodeIds.add(id);
        }
        const vidMatch = /^ref_video_(0[1-9])$/.exec(title);
        if (vidMatch) {
            const idx = Number(vidMatch[1]) - 1;
            if (idx >= assignedVideoCount) removedNodeIds.add(id);
        }
        const audMatch = /^ref_audio_(0[1-9])$/.exec(title);
        if (audMatch) {
            const idx = Number(audMatch[1]) - 1;
            if (idx >= assignedAudioCount) removedNodeIds.add(id);
        }
    }

    const hasExternalLiveConsumers = (targetId: string, currentRemoved: Set<string>): boolean => {
        for (const [otherId, otherNode] of Object.entries(cloned)) {
            if (currentRemoved.has(otherId)) continue;
            if (typeof otherNode !== "object" || otherNode === null) continue;
            const otherRec = otherNode as NodeRecord;
            for (const val of Object.values(otherRec.inputs || {})) {
                if (Array.isArray(val) && String(val[0]) === targetId) {
                    return true;
                }
            }
        }
        return false;
    };

    // Pass 2: 按主节点输入键名（ref_images.ref_image_N / ref_videos.ref_video_N / ref_audios.ref_audio_N）
    // 反向追溯未指派插槽的上游节点，解决 LoadVideo/LoadAudio 无 ref 标题无法被 Pass 1 捕获的问题
    for (const [consumerId, node] of Object.entries(cloned)) {
        if (removedNodeIds.has(consumerId)) continue;
        if (typeof node !== "object" || node === null) continue;
        const record = node as NodeRecord;
        if (!record.inputs) continue;
        for (const [inputKey, val] of Object.entries(record.inputs)) {
            if (!Array.isArray(val)) continue;
            const upstreamId = String(val[0]);
            const upstreamNode = cloned[upstreamId] as NodeRecord | undefined;
            if (!upstreamNode) continue;

            // 若上游是 GetVideoComponents 且其输入的视频节点存活有效，则属于有效视频的组件提取，绝不抹除
            if (upstreamNode.class_type === "GetVideoComponents") {
                const videoInput = upstreamNode.inputs?.video;
                if (Array.isArray(videoInput) && !removedNodeIds.has(String(videoInput[0]))) {
                    continue;
                }
            }

            let shouldPrune = false;
            const imgIn = /^ref_images\.ref_image_(\d+)$/.exec(inputKey);
            if (imgIn && Number(imgIn[1]) >= assignedImageCount) shouldPrune = true;
            const vidIn = /^ref_videos\.ref_video_(\d+)$/.exec(inputKey);
            if (vidIn && Number(vidIn[1]) >= assignedVideoCount) shouldPrune = true;
            const audIn = /^ref_audios\.ref_audio_(\d+)$/.exec(inputKey);
            if (audIn && Number(audIn[1]) >= assignedAudioCount) shouldPrune = true;

            if (shouldPrune) {
                delete record.inputs[inputKey];
                if (!hasExternalLiveConsumers(upstreamId, removedNodeIds)) {
                    removedNodeIds.add(upstreamId);
                }
            }
        }
    }

    // 通用反向级联：若某节点仅被已删除节点消费（无存活消费者），则一并抹除
    let hasMorePruning = true;
    while (hasMorePruning) {
        hasMorePruning = false;
        for (const [id] of Object.entries(cloned)) {
            if (removedNodeIds.has(id)) continue;
            let hasLiveConsumer = false;
            let hasRemovedConsumer = false;
            for (const [otherId, otherNode] of Object.entries(cloned)) {
                if (typeof otherNode !== "object" || otherNode === null) continue;
                const otherRec = otherNode as NodeRecord;
                for (const val of Object.values(otherRec.inputs || {})) {
                    if (Array.isArray(val) && String(val[0]) === id) {
                        if (removedNodeIds.has(otherId)) hasRemovedConsumer = true;
                        else hasLiveConsumer = true;
                        break;
                    }
                }
                if (hasLiveConsumer) break;
            }
            if (hasRemovedConsumer && !hasLiveConsumer) {
                removedNodeIds.add(id);
                hasMorePruning = true;
            }
        }
    }

    if (removedNodeIds.size > 0) {
        for (const id of removedNodeIds) {
            delete cloned[id];
        }
        for (const node of Object.values(cloned)) {
            if (typeof node !== "object" || node === null) continue;
            const record = node as NodeRecord;
            if (!record.inputs) continue;
            for (const [inputKey, val] of Object.entries(record.inputs)) {
                if (Array.isArray(val) && removedNodeIds.has(String(val[0]))) {
                    delete record.inputs[inputKey];
                }
            }
        }
    }

    // 动态切换潜空间路由开关（例如文生图与图生图/多图参考切换的 ComfySwitchNode）
    for (const node of Object.values(cloned)) {
        if (typeof node !== "object" || node === null) continue;
        const record = node as NodeRecord;
        if (record.class_type === "ComfySwitchNode" && record.inputs) {
            const onTrue = record.inputs.on_true;
            const onFalse = record.inputs.on_false;
            if (Array.isArray(onTrue) && Array.isArray(onFalse)) {
                const trueTargetId = String(onTrue[0]);
                const falseTargetId = String(onFalse[0]);
                const trueTargetNode = cloned[trueTargetId] as NodeRecord | undefined;
                const falseTargetNode = cloned[falseTargetId] as NodeRecord | undefined;

                const trueIsEmptyLatent = Boolean(trueTargetNode?.class_type?.includes("EmptyLatent"));
                const falseIsEmptyLatent = Boolean(falseTargetNode?.class_type?.includes("EmptyLatent"));

                if (trueIsEmptyLatent && !falseIsEmptyLatent) {
                    record.inputs.switch = assignedImageCount === 0;
                } else if (falseIsEmptyLatent && !trueIsEmptyLatent) {
                    record.inputs.switch = assignedImageCount > 0;
                }
            }
        }
    }

    return cloned;
}

export interface ComfyuiVideoRequest {
    config: AiConfig;
    model?: string;
    prompt: string;
    references?: ReferenceImage[];
    referenceVideos?: ReferenceVideo[];
    referenceAudios?: ReferenceAudio[];
    firstFrame?: ReferenceImage;
    lastFrame?: ReferenceImage;
    videoMode?: "omni" | "frame";
    channelId?: string;
    workflowId?: string;
    /**
     * 本次生成的秒数，优先于 config.videoSeconds。
     * 分段重绘 / 角色替换按段时长传：各段 2–6 秒不等，
     * 只认全局固定值会让每段都生成出同一个时长，拼回去节奏全错。
     */
    seconds?: number;
    seed?: number;
    signal?: AbortSignal;
    jobId?: string;
    onProgress?: (status: string, detail?: { jobId?: string }) => void;
}

export function validateVideoToolInputs(category: "faceRefine" | "depthVideo", input: {
    prompt: string;
    referenceImages?: ReferenceImage[];
    referenceVideos?: ReferenceVideo[];
    referenceAudios?: ReferenceAudio[];
}): void {
    const name = category === "faceRefine" ? "人脸修复" : "深度视频";
    if (input.referenceVideos?.length !== 1) throw new ComfyuiApiError(`${name}需要且只能提供 1 个源视频，请重新选择原视频后执行`);
    const source = input.referenceVideos[0];
    if (!source.url?.trim() && !source.storageKey?.trim()) throw new ComfyuiApiError(`${name}的源视频不可用，请重新选择原视频后执行`);
    if (input.referenceAudios?.length) throw new ComfyuiApiError(`${name}不支持额外参考音频，请移除后执行`);
    if (input.referenceImages && input.referenceImages.length > 9) throw new ComfyuiApiError(`${name}最多支持 9 张参考图`);
    if (category === "faceRefine") {
        if (!input.prompt.trim()) throw new ComfyuiApiError("人脸修复需要填写提示词");
        if (!input.referenceImages?.length || input.referenceImages.some((image) => !image.dataUrl?.trim())) throw new ComfyuiApiError("人脸修复需要至少 1 张有效参考图");
    }
}

function resolveVideoRequestChannel(req: ComfyuiVideoRequest, rawModel: string): ModelChannel {
    if (!req.channelId) return resolveModelChannel(req.config, rawModel);
    const channel = req.config.channels.find((item) => item.id === req.channelId);
    if (!channel) throw new ComfyuiApiError(`所选渠道「${req.channelId}」不存在，请重新选择渠道后执行`);
    return channel;
}

export async function submitComfyuiVideoJob(req: ComfyuiVideoRequest): Promise<{ jobId: string; baseUrl: string; token?: string }> {
    const rawModel = req.model || req.config.videoModel || req.config.model;
    const channel = resolveVideoRequestChannel(req, rawModel);
    const requestModel = modelOptionName(rawModel);
    const channelModel = channel.models.find((model) => model.name === requestModel);
    const initialVideoMode = req.videoMode || (req.config.videoMode === "frame" ? "frame" : "omni");
    const channelId = req.channelId || req.config.channelId || channel.id;
    const workflowId = req.workflowId || req.config.workflowId;
    // 视频的 pin 可能指向 depthVideo / faceRefine 这类专用流，查找时不能按
    // omniVideo / frameVideo 过滤，否则专用流会被判为「不存在」而退回普通视频流。
    const targetWorkflowItem = workflowId ? findWorkflow(req.config, channelId, workflowId) : undefined;
    if (workflowId && targetWorkflowItem?.id !== workflowId) {
        throw addComfyuiChannelContext(new ComfyuiApiError(`所选工作流「${workflowId}」不存在，请重新选择工作流后执行`), channel.name);
    }
    // 工具流（换脸/景深）不吃模型档案：它没有对应的生成模型，按档案校验会误报配额错误。
    const isVideoTool = targetWorkflowItem?.category === "faceRefine" || targetWorkflowItem?.category === "depthVideo";
    const modelProfile = isVideoTool ? undefined : getModelProfile(req.model || targetWorkflowItem?.id || targetWorkflowItem?.name || rawModel || initialVideoMode);
    const isFrameWorkflow = targetWorkflowItem?.category === "frameVideo";
    const isFrameMode = !isVideoTool && (modelProfile?.category === "frameVideo" || isFrameWorkflow || initialVideoMode === "frame");
    const videoMode = isFrameMode ? "frame" : "omni";
    const frameImages: ReferenceImage[] = [];
    if (isFrameMode) {
        const frameCandidates: Array<ReferenceImage | undefined> = [req.firstFrame, req.lastFrame, ...(req.references || [])];
        const seenFrameIds = new Set<string>();
        for (const candidate of frameCandidates) {
            if (!candidate) continue;
            const id = candidate.id || candidate.url || candidate.dataUrl || String(frameImages.length);
            if (seenFrameIds.has(id)) continue;
            seenFrameIds.add(id);
            frameImages.push(candidate);
        }
    }
    if (modelProfile) {
        validateModelExecution(modelProfile, {
            imagesCount: isFrameMode ? frameImages.length : (req.references?.length || 0),
            videosCount: req.referenceVideos?.length || 0,
            audiosCount: req.referenceAudios?.length || 0,
            size: req.config.size,
            duration: req.config.videoSeconds ? Number(req.config.videoSeconds) : undefined,
        });
    }

    // 与图像/文本同一套优先级：显式 pin → 模型档案 → 渠道绑定的流 → 渠道默认流。
    // 原来「渠道该分类的第一个流」排在模型前面，渠道里存着工作流列表（多数没有
    // isDefault 标记）时，列表第一条会把刚选的模型顶掉。
    const resolved = resolveExecutionWorkflow({
        config: req.config,
        channel,
        channelId,
        workflowId,
        modelId: req.model || rawModel || initialVideoMode,
        pinCategory: null,
        category: videoMode === "frame" ? "frameVideo" : "omniVideo",
        // 视频节点二级列的就是该渠道配置里的流，配置里标为默认的那条必须真的作用到节点上。
        respectChannelDefault: true,
        channelWorkflow: resolveChannelBoundWorkflow(channel, requestModel, videoMode === "frame" ? "frameVideo" : "omniVideo"),
    });
    const videoWorkflow = resolved
        ? { json: resolved.json }
        : { json: (videoMode === "frame" ? DEFAULT_COMFYUI_FRAME_VIDEO_WORKFLOW : DEFAULT_COMFYUI_VIDEO_WORKFLOW).json };

    const baseUrl = (channel.comfyuiProxyUrl || "").trim();
    const token = channel.comfyuiProxyToken;

    try {
        let toolSourceUrl: string | undefined;
        if (isVideoTool) {
            validateVideoToolInputs(targetWorkflowItem.category, { prompt: req.prompt, referenceImages: req.references, referenceVideos: req.referenceVideos, referenceAudios: req.referenceAudios });
            const { resolveMediaUrl } = await import("@/services/file-storage");
            const source = req.referenceVideos![0];
            toolSourceUrl = await resolveMediaUrl(source.storageKey, source.url);
            if (!toolSourceUrl?.trim()) throw new ComfyuiApiError("工具的源视频不可用，请重新选择原视频后执行");
        }
        let firstFrameAssetId: string | undefined;
        let lastFrameAssetId: string | undefined;
        const assetIds: string[] = [];
        const videoAssetIds: string[] = [];
        const audioAssetIds: string[] = [];

        if (videoMode === "frame") {
            // 首尾帧模式 - 严格校验（Fail-loud）：在任何上传之前先校验数量/类型
            if (frameImages.length > 2) {
                throw new ComfyuiError(`首尾帧模式最多支持 2 张参考图，已连接 ${frameImages.length} 张`);
            }
            if ((req.referenceVideos && req.referenceVideos.length > 0) || (req.referenceAudios && req.referenceAudios.length > 0)) {
                throw new ComfyuiError("首尾帧模式不支持视频或音频参考，请移除后再生成");
            }
            const firstFrameImg = frameImages[0];
            const lastFrameImg = frameImages[1];
            if (firstFrameImg?.dataUrl) {
                firstFrameAssetId = await uploadComfyuiAsset(baseUrl, token, firstFrameImg.dataUrl, "first_frame.png", req.signal);
            }
            if (lastFrameImg?.dataUrl) {
                lastFrameAssetId = await uploadComfyuiAsset(baseUrl, token, lastFrameImg.dataUrl, "last_frame.png", req.signal);
            }
        } else {
            // 全能参考模式 - 严格校验（Fail-loud）
            if (req.references && req.references.length > 9) {
                throw new Error(`当前视频工作流最多支持 9 张参考图，已连接 ${req.references.length} 张，请精简连线后再生成`);
            }
            if (req.referenceVideos && req.referenceVideos.length > 3) {
                throw new Error(`当前视频工作流最多支持 3 个参考视频，已连接 ${req.referenceVideos.length} 个，请精简连线后再生成`);
            }
            if (req.referenceAudios && req.referenceAudios.length > 3) {
                throw new Error(`当前视频工作流最多支持 3 个参考音频，已连接 ${req.referenceAudios.length} 个，请精简连线后再生成`);
            }

            // 上传图片参考资产
            if (req.references?.length) {
                for (let i = 0; i < req.references.length; i++) {
                    const dataUrl = req.references[i]?.dataUrl;
                    if (dataUrl) {
                        const id = await uploadComfyuiAsset(baseUrl, token, dataUrl, `ref_${i + 1}.png`, req.signal);
                        assetIds.push(id);
                    }
                }
            }

            // 上传视频参考资产
            if (req.referenceVideos?.length) {
                const { resolveMediaUrl } = await import("@/services/file-storage");
                for (let i = 0; i < req.referenceVideos.length; i++) {
                    const ref = req.referenceVideos[i];
                    const rawUrl = ref?.url || (ref as unknown as { dataUrl?: string })?.dataUrl || (ref as unknown as { src?: string })?.src || "";
                    const resolvedUrl = toolSourceUrl || await resolveMediaUrl(ref?.storageKey, rawUrl);
                    if (resolvedUrl) {
                        const id = await uploadComfyuiAsset(baseUrl, token, resolvedUrl, `ref_video_${i + 1}.mp4`, req.signal);
                        videoAssetIds.push(id);
                    }
                }
            }

            // 上传音频参考资产
            if (req.referenceAudios?.length) {
                const { resolveMediaUrl } = await import("@/services/file-storage");
                for (let i = 0; i < req.referenceAudios.length; i++) {
                    const ref = req.referenceAudios[i];
                    const rawUrl = ref?.url || (ref as unknown as { dataUrl?: string })?.dataUrl || (ref as unknown as { src?: string })?.src || "";
                    const resolvedUrl = await resolveMediaUrl(ref?.storageKey, rawUrl);
                    if (resolvedUrl) {
                        const id = await uploadComfyuiAsset(baseUrl, token, resolvedUrl, `ref_audio_${i + 1}.mp3`, req.signal);
                        audioAssetIds.push(id);
                    }
                }
            }
        }

        const sizeMatch = (req.config.size || "").match(/^(\d+)x(\d+)$/);
        const width = sizeMatch ? Number(sizeMatch[1]) : 544;
        const height = sizeMatch ? Number(sizeMatch[2]) : 960;
        // 请求级秒数优先：分段任务按段时长传，避免 4 秒的段生成出 5 秒画面
        const duration = req.seconds !== undefined ? Math.max(1, Math.round(req.seconds)) : req.config.videoSeconds ? Number(req.config.videoSeconds) : 5;

        const seed = req.seed !== undefined ? req.seed : generateRandomSeed() % 1_000_000_000;
        const boundWorkflow = modelProfile
            ? dispatchComfyuiModelWorkflow(modelProfile, videoWorkflow.json, {
                  prompt: req.prompt,
                  width,
                  height,
                  duration,
                  seed,
                  firstFrameAssetId,
                  lastFrameAssetId,
                  assetIds,
                  videoAssetIds,
                  audioAssetIds,
              })
            : applyVideoBindings(videoWorkflow.json, {
                  prompt: req.prompt,
                  assetIds,
                  videoAssetIds,
                  audioAssetIds,
                  firstFrameAssetId,
                  lastFrameAssetId,
                  videoMode,
                  seed,
                  width,
                  height,
                  duration,
              });

        const jobId = await submitJob(boundWorkflow, baseUrl, token);
        return { jobId, baseUrl, token };
    } catch (error) {
        throw addComfyuiChannelContext(error, channel.name);
    }
}

export async function pollComfyuiVideoJob(
    jobId: string,
    baseUrl: string,
    token?: string,
    signal?: AbortSignal,
    onProgress?: (status: string, detail?: Record<string, unknown>) => void,
): Promise<{ url: string; mimeType: string }> {
    const assetIds = await pollJob(jobId, baseUrl, token, signal, Date.now() + JOB_TIMEOUT_MS, collectVideoAssetIds, onProgress);
    if (!assetIds) {
        throw new ComfyuiAbortedError();
    }
    if (assetIds.length === 0) {
        throw new ComfyuiError(i18n.t("comfyui.noVideoOutput"));
    }
    const { dataUrl, mimeType } = await downloadComfyuiVideo(assetIds[0], baseUrl, token);
    return { url: dataUrl, mimeType };
}

export async function requestComfyuiVideo(req: ComfyuiVideoRequest): Promise<{ url: string; mimeType: string; jobId: string }> {
    const rawModel = req.model || req.config.videoModel || req.config.model;
    const channel = resolveVideoRequestChannel(req, rawModel);
    const baseUrl = (channel.comfyuiProxyUrl || "").trim();
    const token = channel.comfyuiProxyToken;

    let jobId = req.jobId;
    try {
        if (!jobId) {
            const submitted = await submitComfyuiVideoJob({ ...req, model: rawModel });
            jobId = submitted.jobId;
            req.onProgress?.("submitted", { jobId });
        }

        const signal = req.signal;
        if (signal?.aborted) {
            await cancelJob(jobId, baseUrl, token);
            throw new ComfyuiAbortedError();
        }

        const polling = pollComfyuiVideoJob(jobId, baseUrl, token, signal, req.onProgress);
        let waiting: Promise<{ url: string; mimeType: string }> = polling;
        if (signal) {
            // `{ once: true }` keeps the cancel call idempotent across repeated aborts;
            // the timeout path never reaches this listener. Aborting rejects the race
            // immediately so polling can stop without leaking on the heap.
            const aborted: Promise<never> = new Promise((_resolve, reject) => {
                signal.addEventListener("abort", () => {
                    void cancelJob(jobId, baseUrl, token).catch(() => undefined);
                    reject(new ComfyuiAbortedError());
                }, { once: true });
            });
            waiting = Promise.race([polling, aborted]);
        }
        const result = await waiting;
        return { ...result, jobId };
    } catch (error) {
        if (error instanceof ComfyuiTimeoutError && !error.jobId) {
            throw new ComfyuiTimeoutError(error.timeoutMs, jobId);
        }
        throw addComfyuiChannelContext(error, channel.name);
    }
}

export type ComfyuiAudioBindings = {
    prompt?: string;
    caption?: string;
    lyrics?: string;
    duration?: number;
    seed?: number;
    /** 情绪描述（配音）。空串也要写 —— 清空情绪框必须真的清掉工作流里的旧值。 */
    emotion?: string;
    /** 情绪强度（配音）。跟随音色卡，落在 strength 槽位。 */
    strength?: number;
    /** 参考音色（配音）。必须是 ComfyUI input 目录下真实存在的文件名。 */
    refAudio?: string;
    /** 情绪模式（配音）。结构开关，不能当普通槽位走连线，见 applyEmotionMode。 */
    emotionMode?: "text" | "speaker";
};

/**
 * 情绪模式作用在这些节点上。它决定节点存在哪些子输入，所以没法像台词那样抽成
 * 独立字符串节点用连线注入 —— 只能按 class_type 直接改。
 */
const EMOTION_CONTROL_CLASS_TYPES = new Set(["T8_IndexTTS25_EmotionControl"]);

/**
 * 切情绪模式，并清掉上一个模式的残留子键。
 *
 * ComfyUI 按"当前选中的 option"校验输入：`mode="speaker"` 时还留着 `mode.emotion_text`，
 * 就是未定义输入，直接 400。反过来漏清会把上一句的情绪描述带进下一句。
 * 绑定发生在每次任务的克隆副本上，所以这里删连线不会影响原始工作流。
 */
function applyEmotionMode(record: WorkflowNodeRecord, mode: "text" | "speaker"): void {
    const inputs = record.inputs;
    if (!inputs) return;
    if (mode === "speaker") {
        for (const key of Object.keys(inputs)) {
            if (key.startsWith("mode.")) delete inputs[key];
        }
    }
    inputs.mode = mode;
}

export function applyAudioBindings(workflow: ComfyuiWorkflowJson, params: ComfyuiAudioBindings): ComfyuiWorkflowJson {
    const cloned = structuredClone(workflow);
    type NodeRecord = WorkflowNodeRecord;
    let boundSeed = false;

    for (const node of Object.values(cloned)) {
        if (typeof node !== "object" || node === null) continue;
        const record = node as NodeRecord;
        const rawTitle = record._meta?.title;
        if (!record.class_type || !record.inputs) continue;
        const title = typeof rawTitle === "string" ? rawTitle.trim().toLowerCase() : "";

        if (params.emotionMode && EMOTION_CONTROL_CLASS_TYPES.has(record.class_type)) {
            applyEmotionMode(record, params.emotionMode);
        }
        if (!title) continue;

        let slot: string | undefined;
        let value: unknown;

        if (title === "caption" && params.caption !== undefined) {
            slot = BINDING_TITLE_TO_INPUT_SLOT.caption?.[record.class_type] ||
                ("value" in record.inputs ? "value" : "text" in record.inputs ? "text" : "caption" in record.inputs ? "caption" : undefined);
            value = params.caption;
        } else if (title === "lyrics" && params.lyrics !== undefined) {
            slot = BINDING_TITLE_TO_INPUT_SLOT.lyrics?.[record.class_type] ||
                ("value" in record.inputs ? "value" : "text" in record.inputs ? "text" : "lyrics" in record.inputs ? "lyrics" : undefined);
            value = params.lyrics;
        } else if ((title === "duration" || title === "max_duration") && params.duration !== undefined) {
            slot = BINDING_TITLE_TO_INPUT_SLOT.duration?.[record.class_type] ||
                ("Number" in record.inputs ? "Number" : "value" in record.inputs ? "value" : "duration" in record.inputs ? "duration" : "max_duration" in record.inputs ? "max_duration" : undefined);
            // 绑定音频生成时长（秒）。注意：params.duration 已由上层调用包含针对 MiniMax Music 03 产物少 1 秒的 +1s 补偿值
            value = params.duration;
        } else if (title === "emotion" && params.emotion !== undefined) {
            // 情绪走原值类型跟随：PrimitiveStringMultiline.value 是字符串，直接写。
            slot = resolveSlotInputKey(title, record);
            value = params.emotion;
        } else if (title === "strength" && params.strength !== undefined) {
            // 强度是 float，writeSlot 会按原值类型转成数字，写字符串会被 ComfyUI 类型校验拒掉。
            slot = resolveSlotInputKey(title, record);
            value = params.strength;
        } else if (params.refAudio !== undefined && /^ref_audio(_0?1)?$/.test(title)) {
            slot = resolveSlotInputKey(title, record);
            value = params.refAudio;
        } else if (title === "prompt" && params.prompt !== undefined) {
            slot = BINDING_TITLE_TO_INPUT_SLOT.prompt[record.class_type] ||
                ("value" in record.inputs ? "value" : "text" in record.inputs ? "text" : "prompt" in record.inputs ? "prompt" : undefined);
            value = params.prompt || params.caption || "";
        } else if (title === "seed" && params.seed !== undefined) {
            slot = BINDING_TITLE_TO_INPUT_SLOT.seed[record.class_type];
            if (!slot) {
                if ("seed" in record.inputs) slot = "seed";
                else if ("noise_seed" in record.inputs) slot = "noise_seed";
                else if ("value" in record.inputs) slot = "value";
            }
            value = params.seed;
            boundSeed = true;
        }

        if (slot) writeSlot(record, slot, value, title);
    }

    if (!boundSeed && params.seed !== undefined) {
        for (const node of Object.values(cloned)) {
            if (typeof node !== "object" || node === null) continue;
            const record = node as NodeRecord;
            if (!record.inputs) continue;
            if (typeof record.inputs.seed === "number") {
                record.inputs.seed = params.seed;
                break;
            } else if (typeof record.inputs.noise_seed === "number") {
                record.inputs.noise_seed = params.seed;
                break;
            }
        }
    }

    return cloned;
}

/**
 * Split prompt strictly by [caption] and [lyrics] tags.
 * If neither tag is present, the whole text is passed as caption.
 */
// parseAudioPrompt 已迁移至 ./models/audio-models 并统一导出

export type ComfyuiAudioRequest = {
    config: AiConfig;
    prompt: string;
    model?: string;
    channelId?: string;
    duration?: number;
    seed?: number;
    workflowId?: string;
    signal?: AbortSignal;
    jobId?: string;
    onProgress?: (status: string, detail?: { jobId?: string }) => void;
};

export type ComfyuiAudioResult = {
    blob: Blob;
    dataUrl: string;
    seed: number;
    jobId: string;
};

export async function requestComfyuiAudio(req: ComfyuiAudioRequest): Promise<ComfyuiAudioResult> {
    const rawModel = req.model || req.config.audioModel || req.config.model;
    const channel = req.channelId
        ? req.config.channels?.find((c) => c.id === req.channelId) || resolveModelChannel(req.config, rawModel)
        : resolveModelChannel(req.config, rawModel);
    const baseUrl = (channel.comfyuiProxyUrl || "").trim();
    const token = channel.comfyuiProxyToken;

    const modelProfile = getModelProfile(rawModel || "audio-minimax-music-3");

    // 与图像/视频/文本同一套优先级：显式 pin → 配置里标为默认的流 → 模型档案 → 渠道绑定 →
    // 渠道列表首项。原来这里是「pin → 模型档案 → getDefaultWorkflow」，缺了「配置里的默认流」
    // 这一档，且 getDefaultWorkflow 在没有 isDefault 时会取列表首项 —— 两者都会让配置页里
    // 的默认标记对节点不生效。
    const resolved = resolveExecutionWorkflow({
        config: req.config,
        channel,
        channelId: channel.id,
        workflowId: req.workflowId || req.config.workflowId,
        modelId: rawModel || "audio-minimax-music-3",
        category: "audio",
        respectChannelDefault: true,
        channelWorkflow: channel.comfyuiAudioWorkflow,
        channelWorkflowName: channel.comfyuiAudioWorkflow?.name,
    });
    if (!resolved) {
        throw new ComfyuiError("未找到可用的 ComfyUI 音频工作流");
    }

    const seed = req.seed !== undefined && req.seed >= 0 ? req.seed : generateRandomSeed();
    const duration = req.duration ?? (Number(req.config.audioSeconds) || 60);

    let jobId = req.jobId || "";
    try {
        if (!jobId) {
            // 档案跟着流走：选了自定义配乐流时仍用音频档案的绑定规则，不沿用节点上别的能力档案
            const profileToUse = resolved.modelProfile || modelProfile || getModelProfile("audio-minimax-music-3")!;
            validateModelExecution(profileToUse, { prompt: req.prompt, duration });
            const boundWorkflow = dispatchComfyuiModelWorkflow(profileToUse, resolved.json, { prompt: req.prompt, duration, seed });
            jobId = await submitJob(boundWorkflow, baseUrl, token);
            req.onProgress?.("submitted", { jobId });
        }

        const signal = req.signal;
        if (signal?.aborted) {
            await cancelJob(jobId, baseUrl, token);
            throw new ComfyuiAbortedError();
        }

        const result = await waitForAudioJob({ jobId, baseUrl, token, signal: req.signal, onProgress: req.onProgress });
        return { ...result, seed, jobId };
    } catch (error) {
        if (error instanceof ComfyuiTimeoutError && !error.jobId) {
            throw new ComfyuiTimeoutError(error.timeoutMs, jobId);
        }
        throw addComfyuiChannelContext(error, channel.name);
    }
}

/**
 * 等一个音频作业跑完并取回产物。配乐与配音共用这一段：
 * 两者只差"提交前怎么绑参数"，取产物的规则完全一样 —— 按类型/扩展名找音频，
 * 不认 `output_audio` 标记（那个标记只给导入校验用）。
 */
async function waitForAudioJob(opts: { jobId: string; baseUrl: string; token?: string; signal?: AbortSignal; onProgress?: ComfyuiAudioRequest["onProgress"] }): Promise<{ blob: Blob; dataUrl: string }> {
    const { jobId, baseUrl, token, signal, onProgress } = opts;
    if (signal?.aborted) {
        await cancelJob(jobId, baseUrl, token);
        throw new ComfyuiAbortedError();
    }

    const startedAt = Date.now();
    const polling = pollJobRaw(jobId, baseUrl, token, signal, startedAt + JOB_TIMEOUT_MS, onProgress as ((status: string, detail?: Record<string, unknown>) => void) | undefined);
    let waiting: Promise<PollJobResult | undefined> = polling;
    if (signal) {
        const aborted: Promise<never> = new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => {
                void cancelJob(jobId, baseUrl, token).catch(() => undefined);
                reject(new ComfyuiAbortedError());
            }, { once: true });
        });
        waiting = Promise.race([polling, aborted]);
    }

    const pollResult = await waiting;
    if (!pollResult || !pollResult.outputs?.length) {
        throw new ComfyuiError("ComfyUI 未生成音频产物");
    }

    const audioOutput = pollResult.outputs.find((out) =>
        out.type === "audio" ||
        out.content_type?.startsWith("audio/") ||
        /\.(mp3|wav|ogg|flac|m4a|aac|opus)$/i.test(out.filename || "") ||
        /\.(mp3|wav|ogg|flac|m4a|aac|opus)/i.test(out.id || "")
    );
    if (!audioOutput) {
        throw new ComfyuiError("ComfyUI 任务完成但未找到音频文件产物");
    }

    const targetAssetId = audioOutput.id || (audioOutput.filename ? `/api/view?filename=${encodeURIComponent(audioOutput.filename)}&type=${encodeURIComponent(audioOutput.type || "output")}&subfolder=${encodeURIComponent(audioOutput.subfolder || "")}` : "");
    return downloadAsset(targetAssetId, baseUrl, token);
}

export type ComfyuiVoiceRequest = {
    config: AiConfig;
    /** 台词。空则不生成 —— 配音没台词就没什么可念的。 */
    prompt: string;
    /** 情绪描述，可留空：留空时 IndexTTS 会按台词本身推断情绪。 */
    emotion?: string;
    /** 情绪强度，跟随音色卡。 */
    strength?: number;
    /** 情绪模式：text 用情绪描述，speaker 跟随音色参考。 */
    emotionMode?: "text" | "speaker";
    /** 参考音色：已经存在于 ComfyUI input 目录的文件名。 */
    refAudioName: string;
    model?: string;
    channelId?: string;
    workflowId?: string;
    seed?: number;
    signal?: AbortSignal;
    onProgress?: (status: string, detail?: { jobId?: string }) => void;
};

export type ComfyuiVoiceResult = {
    blob: Blob;
    dataUrl: string;
    seed: number;
    jobId: string;
};

/**
 * 配音走独立函数，不复用 `requestComfyuiAudio`。
 *
 * 两个东西套不得：
 * 1. 那里对时长做 `+1s` 补偿，是给 MiniMax Music 少 1 秒打的补丁。配音的时长由台词决定，
 *    套上去只会把 `target_duration_seconds` 写成垃圾值。
 * 2. 那里把提示词按 `[caption]` / `[lyrics]` 拆开。配音的台词就是台词，写进 caption 槽位
 *    等于让它去找歌词。
 */
export async function requestComfyuiVoice(req: ComfyuiVoiceRequest): Promise<ComfyuiVoiceResult> {
    const rawModel = req.model || req.config.audioModel || req.config.model;
    const channel = req.channelId
        ? req.config.channels?.find((c) => c.id === req.channelId) || resolveModelChannel(req.config, rawModel)
        : resolveModelChannel(req.config, rawModel);
    const baseUrl = (channel.comfyuiProxyUrl || "").trim();
    const token = channel.comfyuiProxyToken;

    const text = (req.prompt || "").trim();
    if (!text) throw new ComfyuiError("配音需要台词，请先填写要念的内容");
    const refAudioName = (req.refAudioName || "").trim();
    // 不能像视频那样"没连参考就剪掉那个节点"：speaker_audio 是生成节点的必需输入，
    // 剪了只会变成缺输入的 400，报错还指向工作流。只能在这里把话说明白。
    if (!refAudioName) throw new ComfyuiError("配音需要先选一个参考音色");

    const workflowItem = (req.workflowId ? findWorkflow(req.config, channel.id, req.workflowId, "voice") : undefined) || getDefaultWorkflow(channel, "voice");
    if (!workflowItem) {
        throw new ComfyuiError("未找到可用的配音工作流，请先在渠道配置里导入一个配音工作流");
    }

    const seed = req.seed !== undefined && req.seed >= 0 ? req.seed : generateRandomSeed();
    const boundWorkflow = applyAudioBindings(workflowItem.json, {
        prompt: text,
        emotion: req.emotion ?? "",
        strength: req.strength,
        refAudio: refAudioName,
        emotionMode: req.emotionMode || "text",
        seed,
    });

    const jobId = await submitJob(boundWorkflow, baseUrl, token);
    req.onProgress?.("submitted", { jobId });

    try {
        const result = await waitForAudioJob({ jobId, baseUrl, token, signal: req.signal });
        return { ...result, seed, jobId };
    } catch (error) {
        if (error instanceof ComfyuiTimeoutError && !error.jobId) {
            throw new ComfyuiTimeoutError(error.timeoutMs, jobId);
        }
        throw addComfyuiChannelContext(error, channel.name);
    }
}

/**
 * 从 `/object_info` 的 COMBO 定义里取出可选项。
 *
 * 这个字段的形态换过一次版本，两种都要认：
 * - 新版本：`["COMBO", { options: ["a.mp3", ...] }]`
 * - 旧版本：`[["a.mp3", ...], {...}]`
 * 只认一种的后果是静默拿到 undefined —— 表现出来就是"音色文件明明传过，却每次都重传"，
 * 或者更糟：判不出文件已丢，生成时才 FileNotFoundError。
 */
function readComboOptions(definition: unknown): string[] | undefined {
    if (!Array.isArray(definition)) return undefined;
    const meta = definition[1] as { options?: unknown } | undefined;
    const list = Array.isArray(meta?.options) ? meta.options : Array.isArray(definition[0]) ? definition[0] : undefined;
    if (!Array.isArray(list)) return undefined;
    return list.filter((item): item is string => typeof item === "string");
}

/**
 * 读出 ComfyUI input 目录里现成的音频文件名（`LoadAudio` 的可选项就是它）。
 *
 * 用它判断音色要不要重传，而不是在本地记一个"传过了"的标记：用户可能清了 input 目录，
 * 或者换了台 ComfyUI。标记还在、文件没了，生成时才会 FileNotFoundError，而那个报错
 * 指向的是工作流文件名，看起来完全不像"少传一个文件"。
 */
export async function listComfyuiInputAudio(baseUrl: string, token?: string): Promise<string[] | undefined> {
    const headers: Record<string, string> = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    try {
        const res = await comfyuiFetch(`${normalizeBaseUrl(baseUrl)}/object_info/LoadAudio`, { headers }, baseUrl);
        if (!res.ok) return undefined;
        const data = (await res.json()) as { LoadAudio?: { input?: { required?: { audio?: unknown } } } };
        return readComboOptions(data?.LoadAudio?.input?.required?.audio);
    } catch {
        // 拿不到列表不等于不能生成，交给上传流程去撞真实错误。
        return undefined;
    }
}

export async function checkComfyuiConnection(baseUrl: string, token?: string): Promise<{ ok: boolean; error?: string }> {
    const headers: Record<string, string> = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    try {
        const res = await comfyuiFetch(`${normalizeBaseUrl(baseUrl)}/system_stats`, { headers }, baseUrl);
        if (res.ok) {
            try {
                const data = (await res.json()) as { system?: { os?: string } };
                const osName = (data?.system?.os || "").toLowerCase();
                comfyHostOsCache.set(normalizeBaseUrl(baseUrl), osName === "nt" ? "windows" : "linux");
            } catch {
                // ignore
            }
            return { ok: true };
        }
        return { ok: false, error: new ComfyuiApiError("连接测试失败", res.status, { url: `${normalizeBaseUrl(baseUrl)}/system_stats` }).message };
    } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
}

export type ComfyuiModelItem = {
    name: string;
    size?: number;
    modified?: number;
    pathIndex?: number;
};

export type WorkflowSelectNodeInfo = {
    nodeId: string;
    title: string;
    classType?: string;
    modelType: string;
    inputKey: string;
    currentValue: string;
};

/**
 * 扫描工作流 JSON 中所有以 select_models_ 开头（或 select_ 开头）的动态选择框节点
 */
export function findWorkflowSelectNodes(workflow: ComfyuiWorkflowJson): WorkflowSelectNodeInfo[] {
    if (!workflow || typeof workflow !== "object") return [];
    const results: WorkflowSelectNodeInfo[] = [];

    const nodes = Object.entries(workflow);
    for (const [nodeId, rawNode] of nodes) {
        if (!rawNode || typeof rawNode !== "object") continue;
        const node = rawNode as {
            class_type?: string;
            inputs?: Record<string, unknown>;
            _meta?: { title?: unknown };
        };
        const rawTitle = node._meta?.title;
        if (typeof rawTitle !== "string") continue;
        const title = rawTitle.trim();
        if (!title.startsWith("select_models_") && !title.startsWith("select_")) continue;

        let modelType = "";
        if (title.startsWith("select_models_")) {
            modelType = title.slice("select_models_".length).trim().toLowerCase();
        } else if (title.startsWith("select_")) {
            modelType = title.slice("select_".length).trim().toLowerCase();
        }

        const inputs = node.inputs || {};

        let candidateKeys: string[] = [];
        if (modelType === "diffusion_models" || modelType === "unet") {
            candidateKeys = ["unet_name", "model_name", "diffusion_model_name", "value"];
        } else if (modelType === "clip" || modelType === "text_encoders") {
            candidateKeys = ["clip_name", "text_encoder_name", "clip_name1", "value"];
        } else if (modelType === "checkpoints" || modelType === "checkpoint") {
            candidateKeys = ["ckpt_name", "model_name", "value"];
        } else if (modelType === "vae") {
            candidateKeys = ["vae_name", "value"];
        } else if (modelType === "loras" || modelType === "lora") {
            candidateKeys = ["lora_name", "value"];
        } else if (modelType === "controlnet") {
            candidateKeys = ["control_net_name", "value"];
        } else {
            candidateKeys = [`${modelType}_name`, "model_name", "name", "value"];
        }

        let targetKey = "";
        for (const cand of candidateKeys) {
            if (cand in inputs && !Array.isArray(inputs[cand])) {
                targetKey = cand;
                break;
            }
        }

        if (!targetKey) {
            for (const [k, v] of Object.entries(inputs)) {
                if (typeof v === "string" && !Array.isArray(v) && !["device", "weight_dtype", "type"].includes(k)) {
                    targetKey = k;
                    break;
                }
            }
        }

        if (targetKey) {
            results.push({
                nodeId,
                title,
                classType: node.class_type,
                modelType,
                inputKey: targetKey,
                currentValue: String(inputs[targetKey] ?? ""),
            });
        }
    }

    return results;
}

/**
 * 更新工作流中指定节点的输入参数值
 */
export function updateWorkflowNodeInput(
    workflow: ComfyuiWorkflowJson,
    nodeId: string,
    inputKey: string,
    value: unknown
): ComfyuiWorkflowJson {
    const clone = JSON.parse(JSON.stringify(workflow)) as ComfyuiWorkflowJson;
    const targetNode = clone[nodeId] as { inputs?: Record<string, unknown> } | undefined;
    if (targetNode && typeof targetNode === "object") {
        if (!targetNode.inputs) {
            targetNode.inputs = {};
        }
        targetNode.inputs[inputKey] = value;
    }
    return clone;
}

/**
 * 实时获取 ComfyUI 模型列表
 * 支持 diffusion_models, clip (自动映射为 text_encoders), checkpoints, vae, loras 等
 */
export async function fetchComfyuiModels(
    category: string,
    baseUrl: string,
    token?: string
): Promise<ComfyuiModelItem[]> {
    const rawCat = category.trim().toLowerCase();
    const endpointCat = rawCat === "clip" ? "text_encoders" : rawCat;

    const normalized = normalizeBaseUrl(baseUrl);
    const headers: Record<string, string> = {
        Accept: "*/*",
    };
    if (token) headers.Authorization = `Bearer ${token}`;

    const res = await comfyuiFetch(`${normalized}/api/experiment/models/${encodeURIComponent(endpointCat)}`, { headers }, baseUrl);
    if (!res.ok) {
        throw new Error(`ComfyUI 获取模型列表失败: HTTP ${res.status}`);
    }

    const data = (await res.json()) as Array<{ name?: string; size?: number; modified?: number; pathIndex?: number }>;
    if (Array.isArray(data)) {
        return data
            .filter((item) => item && typeof item.name === "string" && item.name.trim().length > 0)
            .map((item) => ({
                name: item.name!.trim(),
                size: item.size,
                modified: item.modified,
                pathIndex: item.pathIndex,
            }));
    }
    return [];
}

/**
 * ComfyUI 内存与模型卸载请求参数
 * 对应 POST /free 与 POST /api/free 端点
 */
export type ComfyuiFreeRequest = {
    /**
     * 是否卸载显存中已缓存的模型权重 (Checkpoint, UNET, CLIP, VAE, LoRA 等)
     * 若为 true，底层执行 model_management.unload_all_models()
     */
    unload_models?: boolean;
    /**
     * 是否释放 PyTorch 显存缓存与系统内存垃圾回收
     * 若为 true，底层执行 model_management.soft_empty_cache() (torch.cuda.empty_cache / gc.collect)
     */
    free_memory?: boolean;
};

/**
 * ComfyUI 宿主机 CPU 运行指标
 * 来源于 GET /api/kktools/runtime_stats
 */
export type ComfyuiRuntimeCpu = {
    /** CPU 当前整体使用率百分比，取值范围 0.0 ~ 100.0 */
    percent: number;
    /** CPU 逻辑处理器总核心数 */
    logical_cores: number;
};

/**
 * ComfyUI 宿主机系统物理内存 (RAM) 运行指标
 * 来源于 GET /api/kktools/runtime_stats
 */
export type ComfyuiRuntimeMemory = {
    /** 宿主机物理内存总容量，单位：字节 (Bytes) */
    total: number;
    /** 宿主机当前可用空闲物理内存，单位：字节 (Bytes) */
    available: number;
    /** 宿主机当前已使用物理内存，单位：字节 (Bytes) */
    used: number;
    /** 宿主机物理内存使用率百分比，取值范围 0.0 ~ 100.0 */
    percent: number;
};

/**
 * ComfyUI 服务进程自身资源占用与生命周期
 * 来源于 GET /api/kktools/runtime_stats
 */
export type ComfyuiRuntimeProcess = {
    /** ComfyUI 后端 Python 进程当前占用的物理内存 (RSS)，单位：字节 (Bytes) */
    memory_used: number;
    /** ComfyUI 服务进程自启动以来的累计运行秒数 (Seconds) */
    uptime_seconds: number;
};

/**
 * 单个 GPU/加速设备运行状态指标
 * 来源于 GET /api/kktools/runtime_stats
 */
export type ComfyuiRuntimeDevice = {
    /** 设备名称与内存分配器描述 (例如 "cuda:0 NVIDIA GeForce RTX 3090 Ti : cudaMallocAsync") */
    name: string;
    /** 设备类型，通常为 "cuda"、"mps"、"cpu" 等 */
    type: string;
    /** 设备在系统中的物理序号索引 (0, 1, ...) */
    index: number;
    /** GPU 计算核心实时利用率百分比，取值范围 0.0 ~ 100.0 */
    utilization: number;
    /** GPU 物理显存总容量 (VRAM Total)，单位：字节 (Bytes) */
    memory_total: number;
    /** GPU 物理显存当前空闲剩余量 (VRAM Free)，单位：字节 (Bytes) */
    memory_free: number;
    /** GPU 物理显存当前已占用量 (VRAM Used)，单位：字节 (Bytes) */
    memory_used: number;
    /** GPU 显存占用率百分比，取值范围 0.0 ~ 100.0 */
    memory_percent: number;
};

/**
 * ComfyUI 运行时监控指标整体响应数据结构
 * 来源于 GET /api/kktools/runtime_stats
 */
export type ComfyuiRuntimeStats = {
    /** 请求是否成功 */
    ok: boolean;
    /** 运行状态核心监控数据 */
    data: {
        /** CPU 负载指标 */
        cpu: ComfyuiRuntimeCpu;
        /** 宿主机系统内存 (RAM) 负载指标 */
        memory: ComfyuiRuntimeMemory;
        /** ComfyUI 服务进程自身指标 */
        process: ComfyuiRuntimeProcess;
        /** 各 GPU / 计算加速设备状态列表 */
        devices: ComfyuiRuntimeDevice[];
    };
};

/**
 * ComfyUI 官方原生系统设备信息
 * 来源于 GET /system_stats
 */
export type ComfyuiSystemDevice = {
    /** 设备名称与分配器信息 (例如 "cuda:0 NVIDIA GeForce RTX 3090 Ti : cudaMallocAsync") */
    name: string;
    /** 设备类型 (例如 "cuda", "mps", "cpu") */
    type: string;
    /** 设备序号 */
    index: number;
    /** 显存总容量，单位：字节 (Bytes) */
    vram_total: number;
    /** 显存剩余容量，单位：字节 (Bytes) */
    vram_free: number;
    /** PyTorch 显存保留总量，单位：字节 (Bytes) */
    torch_vram_total?: number;
    /** PyTorch 显存空闲可用量，单位：字节 (Bytes) */
    torch_vram_free?: number;
};

/**
 * ComfyUI 官方原生环境与系统统计响应
 * 来源于 GET /system_stats
 */
export type ComfyuiSystemStats = {
    /** 系统与运行环境详情 */
    system: {
        /** 操作系统平台 (例如 "win32", "linux", "darwin") */
        os?: string;
        /** 系统总内存 (RAM)，单位：字节 (Bytes) */
        ram_total?: number;
        /** 系统可用空闲内存 (RAM)，单位：字节 (Bytes) */
        ram_free?: number;
        /** ComfyUI 核心版本号 */
        comfyui_version?: string;
        /** Python 运行环境版本及编译详情 */
        python_version?: string;
        /** PyTorch 与 CUDA/ROCm 版本号 */
        pytorch_version?: string;
        /** 是否使用便携嵌入式 Python 环境 */
        embedded_python?: boolean;
        /** 启动命令行参数数组 */
        argv?: string[];
        [key: string]: unknown;
    };
    /** 加速设备列表 */
    devices: ComfyuiSystemDevice[];
};

/**
 * 请求 ComfyUI 执行清理动作，卸载已加载的模型并释放系统与显存缓存
 * 优先调用 /api/free，降级兼容 /free
 * @param baseUrl ComfyUI 服务基础 URL
 * @param token 可选鉴权 Bearer Token
 * @param options 清理选项，默认两者皆为 true
 * @returns 是否成功释放
 */
export async function freeComfyuiMemory(
    baseUrl: string,
    token?: string,
    options: ComfyuiFreeRequest = { unload_models: true, free_memory: true }
): Promise<boolean> {
    const normalized = normalizeBaseUrl(baseUrl);
    const headers: Record<string, string> = {
        "Content-Type": "application/json",
        Accept: "*/*",
    };
    if (token) headers.Authorization = `Bearer ${token}`;

    const body = JSON.stringify({
        unload_models: options.unload_models !== false,
        free_memory: options.free_memory !== false,
    });

    try {
        // 优先打 /api/free
        let res = await comfyuiFetch(`${normalized}/api/free`, { method: "POST", headers, body }, baseUrl);
        if (res.status === 404) {
            // 降级回退至 /free
            res = await comfyuiFetch(`${normalized}/free`, { method: "POST", headers, body }, baseUrl);
        }
        return res.ok;
    } catch (error) {
        if (error instanceof ComfyuiError) throw error;
        return false;
    }
}

/**
 * 获取 ComfyUI 硬件实时运行状态 (基于 Comfyui-kktools 插件)
 * @param baseUrl ComfyUI 服务基础 URL
 * @param token 可选鉴权 Bearer Token
 * @returns 实时监控数据对象，若端点不可用或报错返回 null
 */
export async function getComfyuiRuntimeStats(
    baseUrl: string,
    token?: string
): Promise<ComfyuiRuntimeStats | null> {
    const normalized = normalizeBaseUrl(baseUrl);
    const headers: Record<string, string> = {
        Accept: "*/*",
    };
    if (token) headers.Authorization = `Bearer ${token}`;

    try {
        const res = await comfyuiFetch(`${normalized}/api/kktools/runtime_stats?t=${Date.now()}`, { headers }, baseUrl);
        if (!res.ok) return null;
        const json = (await res.json()) as ComfyuiRuntimeStats;
        if (json && json.ok && json.data) {
            return json;
        }
        return null;
    } catch {
        return null;
    }
}

/**
 * 获取 ComfyUI 原生系统统计与设备信息 (基于官方原生 /system_stats)
 * @param baseUrl ComfyUI 服务基础 URL
 * @param token 可选鉴权 Bearer Token
 * @returns 系统统计数据对象，若端点不可用或报错返回 null
 */
export async function getComfyuiSystemStats(
    baseUrl: string,
    token?: string
): Promise<ComfyuiSystemStats | null> {
    const normalized = normalizeBaseUrl(baseUrl);
    const headers: Record<string, string> = {
        Accept: "*/*",
    };
    if (token) headers.Authorization = `Bearer ${token}`;

    try {
        const res = await comfyuiFetch(`${normalized}/system_stats`, { headers }, baseUrl);
        if (!res.ok) return null;
        return (await res.json()) as ComfyuiSystemStats;
    } catch {
        return null;
    }
}

/**
 * ComfyUI 队列统计数据
 * 来源于 GET /queue
 */
export type ComfyuiQueueStats = {
    /** 当前正在 GPU 上计算执行的任务数 */
    runningCount: number;
    /** 在队列中排队等待执行的任务数 */
    pendingCount: number;
    /** 总活跃任务数 (running + pending) */
    totalActive: number;
};

/**
 * 获取 ComfyUI 任务队列状态 (基于官方原生 /queue)
 * @param baseUrl ComfyUI 服务基础 URL
 * @param token 可选鉴权 Bearer Token
 * @returns 队列统计对象，若请求失败或服务离线返回 null
 */
export async function getComfyuiQueueStats(
    baseUrl: string,
    token?: string
): Promise<ComfyuiQueueStats | null> {
    const normalized = normalizeBaseUrl(baseUrl);
    const headers: Record<string, string> = {
        Accept: "*/*",
    };
    if (token) headers.Authorization = `Bearer ${token}`;

    try {
        const res = await comfyuiFetch(`${normalized}/queue`, { headers }, baseUrl);
        if (!res.ok) return null;
        const data = (await res.json()) as { queue_running?: unknown[]; queue_pending?: unknown[] };
        const runningCount = Array.isArray(data.queue_running) ? data.queue_running.length : 0;
        const pendingCount = Array.isArray(data.queue_pending) ? data.queue_pending.length : 0;
        return {
            runningCount,
            pendingCount,
            totalActive: runningCount + pendingCount,
        };
    } catch {
        return null;
    }
}



