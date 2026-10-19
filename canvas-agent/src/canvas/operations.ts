import crypto from "node:crypto";

import type { ToolName } from "./schemas.js";
import { nextCanvasX } from "./tools.js";
import type { CanvasNode, CanvasNodeType, CanvasSnapshot } from "./types.js";

export type CanvasToolRequest = { name: "canvas_apply_ops"; input: Record<string, unknown> };

/** 将上层画布工具调用转换为前端可执行的批量操作。 */
export function buildCanvasToolRequest(name: ToolName, input: Record<string, unknown>, state: CanvasSnapshot | null): CanvasToolRequest {
    if (name === "canvas_apply_ops") return { name, input };
    if (name === "canvas_create_node") {
        const data = input as { nodeType: CanvasNodeType; title?: string; x?: number; y?: number; width?: number; height?: number; metadata?: Record<string, unknown> };
        return applyOps([{ type: "add_node", nodeType: data.nodeType, title: data.title, position: { x: data.x ?? nextCanvasX(state), y: data.y ?? 0 }, width: data.width, height: data.height, metadata: data.metadata }]);
    }
    if (name === "canvas_create_text_node") {
        const data = input as { text?: string; x?: number; y?: number; title?: string; width?: number; height?: number };
        return applyOps([textNodeOp(data, data.x ?? nextCanvasX(state), data.y ?? 0)]);
    }
    if (name === "canvas_create_text_nodes") {
        const data = input as { items: Array<{ text: string; title?: string; x?: number; y?: number; width?: number; height?: number }>; x?: number; y?: number; gap?: number; direction?: "row" | "column" };
        const x = Number(data.x ?? nextCanvasX(state));
        const y = Number(data.y ?? 0);
        const gap = Number(data.gap ?? 40);
        return applyOps(data.items.map((item, index) => textNodeOp(item, item.x ?? (data.direction === "row" ? x + index * (340 + gap) : x), item.y ?? (data.direction === "row" ? y : y + index * (240 + gap)))));
    }
    if (name === "canvas_create_image_prompt_flow") return applyOps(generationFlowOps({ ...input, mode: "image" }, state));
    if (name === "canvas_create_config_node") {
        const x = Number(input.x ?? nextCanvasX(state));
        const y = Number(input.y ?? 0);
        const configId = `config-${crypto.randomUUID()}`;
        const mode = generationMode(input.mode);
        const prompt = String(input.prompt || "");
        return applyOps([configNodeOp(configId, input, x, y), ...(input.autoRun ? [runGenerationOp(configId, mode, prompt)] : [])]);
    }
    if (name === "canvas_create_generation_flow") return applyOps(generationFlowOps(input, state));
    if (name === "canvas_generate_audio") {
        throw new Error("当前项目尚未支持 ComfyUI 音频生成");
    }
    if (name === "canvas_generate_text" || name === "canvas_generate_image" || name === "canvas_generate_video") {
        return applyOps(generationFlowOps({ ...input, mode: name.replace("canvas_generate_", ""), autoRun: true }, state));
    }
    if (name === "canvas_update_node") {
        const data = input as { id: string; patch?: Record<string, unknown>; metadata?: Record<string, unknown> };
        return applyOps([{ type: "update_node", id: data.id, patch: data.patch, metadata: data.metadata }]);
    }
    if (name === "canvas_update_node_text") {
        const data = input as { id: string; text: string; title?: string };
        return applyOps([{ type: "update_node", id: data.id, patch: { ...(data.title ? { title: data.title } : {}) }, metadata: { content: data.text, status: "success" } }]);
    }
    if (name === "canvas_move_nodes") {
        const data = input as { items: Array<{ id: string; x?: number; y?: number; dx?: number; dy?: number }> };
        return applyOps(data.items.map((item) => {
            const current = findNode(state, item.id);
            return { type: "update_node", id: item.id, patch: { position: { x: item.x ?? ((current?.position.x || 0) + (item.dx || 0)), y: item.y ?? ((current?.position.y || 0) + (item.dy || 0)) } } };
        }));
    }
    if (name === "canvas_resize_node") {
        const data = input as { id: string; width: number; height: number; freeResize?: boolean };
        return applyOps([{ type: "update_node", id: data.id, patch: { width: data.width, height: data.height }, metadata: data.freeResize === undefined ? undefined : { freeResize: data.freeResize } }]);
    }
    if (name === "canvas_delete_nodes") return applyOps([{ type: "delete_node", ids: (input as { ids: string[] }).ids }]);
    if (name === "canvas_connect_nodes") {
        const data = input as { connections: Array<{ fromNodeId: string; toNodeId: string }> };
        return applyOps(data.connections.map((connection) => ({ type: "connect_nodes", ...connection })));
    }
    if (name === "canvas_select_nodes") return applyOps([{ type: "select_nodes", ids: (input as { ids: string[] }).ids }]);
    if (name === "canvas_set_viewport") return applyOps([{ type: "set_viewport", viewport: (input as { viewport: unknown }).viewport }]);
    if (name === "canvas_run_generation") {
        const data = input as { nodeId: string; mode?: string; prompt?: string };
        return applyOps([runGenerationOp(data.nodeId, generationMode(data.mode), data.prompt)]);
    }
    if (name === "canvas_director_stage") {
        const data = input as DirectorStageInput;
        // 指令型参数（sceneId / exportMode / check）：不在这里展开模板、也不在这里渲染/自检，
        // 只写一条 metadata 指令，由插件执行（模板数据只在插件里，导出需要渲染，自检要有真实节点）。
        // 一次调用只发一条指令，优先级：sceneId > exportMode > check。
        const command = data.sceneId
            ? { id: `stage-cmd-${crypto.randomUUID()}`, type: "applyScene", sceneId: data.sceneId }
            : data.exportMode
              ? { id: `stage-cmd-${crypto.randomUUID()}`, type: "export", mode: data.exportMode }
              : data.check
                ? { id: `stage-cmd-${crypto.randomUUID()}`, type: "check" }
                : null;
        if (command) {
            if (data.nodeId) return applyOps([{ type: "update_node", id: data.nodeId, metadata: { directorStageCommand: command, directorStageCommandAck: undefined } }]);
            // 自检必须有节点可查：没有 nodeId 时不要凭空建一个空节点，直接告诉调用方怎么做
            if (data.check) throw new Error("canvas_director_stage 的 check 需要 nodeId：先用 canvas_get_state 拿到导演台节点 id，再带 nodeId 调一次");
            const id = `director-stage:stage-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
            return applyOps([
                {
                    type: "add_node",
                    id,
                    nodeType: "director-stage:stage",
                    title: data.title,
                    position: { x: data.x ?? nextCanvasX(state), y: data.y ?? 0 },
                    width: data.width,
                    height: data.height,
                    metadata: { directorStageCommand: command },
                },
            ]);
        }
        const stageState = buildStageState(data, state);
        if (data.nodeId) return applyOps([{ type: "update_node", id: data.nodeId, metadata: { stageState } }]);
        return applyOps([
            {
                type: "add_node",
                nodeType: "director-stage:stage",
                title: data.title,
                position: { x: data.x ?? nextCanvasX(state), y: data.y ?? 0 },
                width: data.width,
                height: data.height,
                metadata: { stageState },
            },
        ]);
    }
    throw new Error(`未知工具：${name}`);
}

// --- 3D 导演台：把模型给的部分字段归一化成插件能直接吃的 stageState ---

export type DirectorStageInput = {
    nodeId?: string;
    title?: string;
    x?: number;
    y?: number;
    width?: number;
    height?: number;
    objects?: Array<Record<string, unknown>>;
    camera?: Record<string, unknown>;
    shots?: Array<Record<string, unknown>>;
    motion?: Record<string, unknown>;
    lighting?: "day" | "night" | "indoor" | "backlit";
    sceneId?: string;
    exportMode?: "prompt" | "current" | "firstLast" | "multiView" | "video";
    /** 让插件对 nodeId 指向的导演台做一次几何自检（结果写在节点 metadata.directorStageCheck）。 */
    check?: boolean;
    /** 把画布上这个图片节点当背景板（空串 = 清除）。 */
    backdropNodeId?: string;
    /** 背景板打开时环境类素材是否不渲染（默认 true）。 */
    backdropHideEnvironment?: boolean;
    exportFormat?: "jpeg" | "png";
    exportHeight?: 720 | 1080;
    promptLocale?: "zh" | "en";
};

const STAGE_OBJECT_LIMIT = 8;
const STAGE_SHOT_LIMIT = 8;

function clampNumber(value: unknown, min: number, max: number, fallback: number) {
    const num = Number(value);
    return Number.isFinite(num) ? Math.min(max, Math.max(min, num)) : fallback;
}

/** 角度要归一化而不是夹取：把 200° 夹成 180° 会静默改掉朝向。 */
function normalizeAngle(value: unknown, fallback: number) {
    const num = Number(value);
    if (!Number.isFinite(num)) return fallback;
    let angle = num % 360;
    if (angle > 180) angle -= 360;
    if (angle < -180) angle += 360;
    return angle;
}

function normalizeStageCamera(raw: Record<string, unknown>) {
    return {
        azimuthDeg: normalizeAngle(raw.azimuthDeg, 35),
        elevationDeg: clampNumber(raw.elevationDeg, -20, 80, 14),
        distance: clampNumber(raw.distance, 0.8, 30, 5.2),
        targetY: clampNumber(raw.targetY, 0, 6, 0.95),
        focalMm: clampNumber(raw.focalMm, 8, 300, 35),
    };
}

/**
 * 只覆盖模型显式给出的字段，其余沿用节点上原有的 stageState（配合插件的 normalizeStageState 兜底）。
 * 数值一律夹到插件文档里的合法范围，避免模型写出坏数据把画布节点打崩。
 */
export function buildStageState(input: DirectorStageInput, snapshot: CanvasSnapshot | null) {
    const existing = input.nodeId ? findNode(snapshot, input.nodeId)?.metadata?.stageState : undefined;
    const state: Record<string, unknown> = existing && typeof existing === "object" ? { ...(existing as Record<string, unknown>) } : {};

    if (Array.isArray(input.objects)) {
        state.objects = input.objects.slice(0, STAGE_OBJECT_LIMIT).map((raw, index) => {
            const object = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
            return {
                id: typeof object.id === "string" && object.id ? object.id : `agent-obj-${index + 1}`,
                name: typeof object.name === "string" && object.name ? object.name : `对象 ${index + 1}`,
                kind: object.kind === "prop" || object.kind === "model" || object.kind === "env" ? object.kind : "person",
                ...(typeof object.assetId === "string" && object.assetId ? { assetId: object.assetId } : {}),
                ...(Array.isArray(object.track) && object.track.length ? { track: normalizeAgentTrack(object.track) } : {}),
                visible: object.visible !== false,
                x: clampNumber(object.x, -12, 12, 0),
                z: clampNumber(object.z, -12, 12, 0),
                rotationYDeg: normalizeAngle(object.rotationYDeg, 0),
                scale: clampNumber(object.scale, 0.2, 5, 1),
            };
        });
    }
    if (input.camera && typeof input.camera === "object") state.camera = normalizeStageCamera(input.camera);
    if (Array.isArray(input.shots)) {
        state.shots = input.shots.slice(0, STAGE_SHOT_LIMIT).map((raw, index) => {
            const shot = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
            const camera = shot.camera && typeof shot.camera === "object" ? normalizeStageCamera(shot.camera as Record<string, unknown>) : undefined;
            return {
                id: typeof shot.id === "string" && shot.id ? shot.id : `agent-shot-${index + 1}`,
                name: typeof shot.name === "string" && shot.name ? shot.name : `机位 ${index + 1}`,
                ...(camera ? { camera } : {}),
                holdMs: clampNumber(shot.holdMs, 0, 5000, 0),
            };
        });
        // 旧的 cameraA/cameraB 与新 shots 并存会让插件不知道怎么取，交给 shots
        delete state.cameraA;
        delete state.cameraB;
    }
    if (input.motion && typeof input.motion === "object") {
        state.motion = {
            durationMs: clampNumber(input.motion.durationMs, 400, 20000, 3000),
            fps: clampNumber(input.motion.fps, 6, 60, 24),
            easing: input.motion.easing === "linear" ? "linear" : "easeInOut",
        };
    }
    if (typeof input.backdropNodeId === "string") {
        // 传空串 = 清除背景板；否则指向一个画布图片节点（活链：那张图重新生成后自动更新）
        if (input.backdropNodeId.trim()) {
            state.backdrop = { nodeId: input.backdropNodeId.trim(), ...(input.backdropHideEnvironment === false ? { hideEnvironment: false } : {}) };
        } else {
            delete state.backdrop;
        }
    }
    if (input.lighting === "day" || input.lighting === "night" || input.lighting === "indoor" || input.lighting === "backlit") state.lighting = input.lighting;
    if (input.exportFormat === "jpeg" || input.exportFormat === "png") state.exportFormat = input.exportFormat;
    if (input.exportHeight === 720 || input.exportHeight === 1080) state.exportHeight = input.exportHeight;
    if (input.promptLocale === "zh" || input.promptLocale === "en") state.promptLocale = input.promptLocale;
    return state;
}

/** 走位点归一化：数值夹取、朝向归一化、最多 12 个点（与插件端同规则）。 */
function normalizeAgentTrack(raw: unknown[]) {
    return raw
        .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
        .slice(0, 12)
        .map((item) => ({
            x: clampNumber(item.x, -12, 12, 0),
            z: clampNumber(item.z, -12, 12, 0),
            rotationYDeg: normalizeAngle(item.rotationYDeg, 0),
            holdMs: clampNumber(item.holdMs, 0, 5000, 0),
        }));
}

/** 按最大边限制计算附件图片节点尺寸，并保持原始比例。 */
export function fitAttachmentNodeSize(width: number, height: number) {
    const scale = Math.min(1, 640 / width, 640 / height);
    return { width: width * scale, height: height * scale };
}

/** 创建统一的批量画布操作请求。 */
function applyOps(ops: unknown[]): CanvasToolRequest {
    return { name: "canvas_apply_ops", input: { ops } };
}

/** 创建文本节点操作。 */
function textNodeOp(input: { id?: string; text?: string; title?: string; width?: number; height?: number }, x: number, y: number) {
    return { type: "add_node", id: input.id, nodeType: "text", title: input.title, position: { x, y }, width: input.width, height: input.height, metadata: { content: input.text || "", status: "success", fontSize: 14 } };
}

/** 创建生成配置节点操作。 */
function configNodeOp(id: string, input: Record<string, unknown>, x: number, y: number) {
    const mode = generationMode(input.mode);
    const prompt = String(input.prompt || "");
    return {
        type: "add_node",
        id,
        nodeType: "config",
        title: String(input.title || generationTitle(mode)),
        position: { x, y },
        width: typeof input.width === "number" ? input.width : undefined,
        height: typeof input.height === "number" ? input.height : undefined,
        metadata: cleanRecord({
            generationMode: mode,
            composerContent: prompt,
            prompt,
            status: "idle",
            model: input.model,
            size: input.size,
            quality: input.quality,
            count: input.count,
            seconds: input.seconds,
            vquality: input.vquality,
            generateAudio: input.generateAudio,
            watermark: input.watermark,
            audioVoice: input.audioVoice,
            audioFormat: input.audioFormat,
            audioSpeed: input.audioSpeed,
            audioInstructions: input.audioInstructions,
        }),
    };
}

/** 创建包含提示词、配置节点和引用连线的生成流程。 */
function generationFlowOps(input: Record<string, unknown>, state: CanvasSnapshot | null) {
    const mode = generationMode(input.mode);
    const prompt = String(input.prompt || "");
    const x = Number(input.x ?? nextCanvasX(state));
    const y = Number(input.y ?? 0);
    const textId = `text-${crypto.randomUUID()}`;
    const configId = `config-${crypto.randomUUID()}`;
    const referenceNodeIds = Array.isArray(input.referenceNodeIds) ? input.referenceNodeIds.filter((id): id is string => typeof id === "string") : [];
    // When the prompt only @-mentions nodes already passed as references, reuse them instead of minting a duplicate text node.
    const mentionedIds = [...prompt.matchAll(/@\[node:([\w-]+)\]/g)].map((match) => match[1]);
    const reuseReferences = referenceNodeIds.length > 0 && mentionedIds.length > 0
        && mentionedIds.every((id) => referenceNodeIds.includes(id))
        && prompt.replace(/@\[node:[\w-]+\]/g, "").trim() === "";
    const tokens = reuseReferences ? referenceNodeIds.map((id) => `@[node:${id}]`) : [`@[node:${textId}]`, ...referenceNodeIds.map((id) => `@[node:${id}]`)];
    return [
        ...(reuseReferences ? [] : [textNodeOp({ id: textId, text: prompt, title: String(input.title || "提示词") }, x, y)]),
        configNodeOp(configId, { ...input, prompt: tokens.join("\n") }, x + 420, y),
        ...(reuseReferences ? [] : [{ type: "connect_nodes", fromNodeId: textId, toNodeId: configId }]),
        ...referenceNodeIds.map((fromNodeId) => ({ type: "connect_nodes", fromNodeId, toNodeId: configId })),
        { type: "select_nodes", ids: [configId] },
        ...(input.autoRun ? [runGenerationOp(configId, mode, tokens.join("\n"))] : []),
    ];
}

/** 创建触发节点生成的画布操作。 */
function runGenerationOp(nodeId: string, mode: "text" | "image" | "video" | "audio", prompt?: string) {
    return { type: "run_generation", nodeId, mode, prompt };
}

/** 将未知生成模式归一为画布支持的模式。 */
function generationMode(value: unknown): "text" | "image" | "video" | "audio" {
    return value === "text" || value === "video" || value === "audio" ? value : "image";
}

/** 获取生成模式对应的默认节点标题。 */
function generationTitle(mode: "text" | "image" | "video" | "audio") {
    if (mode === "text") return "文本生成";
    if (mode === "video") return "视频生成";
    if (mode === "audio") return "音频生成";
    return "图片生成";
}

/** 按节点 ID 查找当前画布节点。 */
function findNode(state: CanvasSnapshot | null, id: string): CanvasNode | undefined {
    return (state?.nodes || []).find((node) => node.id === id);
}

/** 移除对象中未设置的生成参数。 */
function cleanRecord(value: Record<string, unknown>) {
    return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== ""));
}
