import type { AiTextMessage } from "@/services/api/image";
import i18n from "@/i18n";
import type { ReferenceImage } from "@/types/image";
import type { ReferenceAudio, ReferenceVideo } from "@/types/media";
import { CanvasNodeType, type CanvasConnection, type CanvasGenerationReferenceSnapshot, type CanvasNodeData } from "@/types/canvas";
import { getGenerationResourceNodes, getGroupResourceNodes } from "@/lib/canvas/canvas-resource-references";
import { resolveAudioEdgeMode, supportsAudioEdgeModes } from "@/lib/canvas/canvas-audio-channels";
import { getNodeDefinition } from "@/lib/canvas/node-registry";

/** 只登记不上工作流的配音轨：成片对白，用户在剪辑软件里合。 */
export type NodeGenerationAudioTrack = {
    nodeId: string;
    title: string;
    url?: string;
    storageKey?: string;
    durationMs?: number;
};

export type NodeGenerationContext = {
    prompt: string;
    generationReferences: CanvasGenerationReferenceSnapshot[];
    referenceImages: ReferenceImage[];
    referenceVideos: ReferenceVideo[];
    referenceAudios: ReferenceAudio[];
    /** 挂在视频节点上、但不参与生成的配音轨。 */
    audioTracks: NodeGenerationAudioTrack[];
    textCount: number;
    imageCount: number;
    videoCount: number;
    audioCount: number;
};

type NodeGenerationResourceInput = {
    nodeId: string;
    type: "text" | "image" | "video" | "audio";
    title: string;
    text?: string;
    image?: ReferenceImage;
    video?: ReferenceVideo;
    audio?: ReferenceAudio;
};

type NodeGenerationGroupInput = {
    nodeId: string;
    type: "group";
    title: string;
    children: NodeGenerationResourceInput[];
};

export type NodeGenerationInput = NodeGenerationResourceInput | NodeGenerationGroupInput;

export function buildNodeGenerationContext(nodeId: string, nodes: CanvasNodeData[], connections: CanvasConnection[], prompt: string): NodeGenerationContext {
    const inputs = buildNodeGenerationInputs(nodeId, nodes, connections);
    const sourceNode = nodes.find((node) => node.id === nodeId);
    // 只有在提示词里真的 `@` 了资源，才算「合成模式挑过图」。合成面板每敲一个字都会把
    // 输入写进 composerContent，若只按 composerContent 非空就切精选模式，用户在面板里
    // 补一句纯文字、没 @ 任何资源时，连线上那些参考图会被整批丢掉，生成退化成纯文生。
    const pickedComposerResources = /@\[node:[^\]]+\]/.test(prompt);
    if (sourceNode?.type === CanvasNodeType.Config && Boolean(sourceNode.metadata?.composerContent?.trim()) && pickedComposerResources) {
        return buildComposerGenerationContext(inputs, nodes, prompt);
    }

    const orderedInputs = orderFrameSlotInputs(flattenGenerationInputs(inputs), nodeId, connections);
    const { referenceInputs: resourceInputs, audioTracks } = splitAudioTrackInputs(nodeId, orderedInputs, nodes);
    const referenceImages = resourceInputs.map((input) => input.image).filter((image): image is ReferenceImage => Boolean(image));
    const referenceVideos = resourceInputs.map((input) => input.video).filter((video): video is ReferenceVideo => Boolean(video));
    const referenceAudios = resourceInputs.map((input) => input.audio).filter((audio): audio is ReferenceAudio => Boolean(audio));
    const generationReferences = snapshotGenerationInputs(resourceInputs);

    const inputByNodeId = new Map(inputs.map((input) => [input.nodeId, input]));
    const resourceByNodeId = new Map(resourceInputs.map((resource) => [resource.nodeId, resource]));
    const nodeTitleById = new Map(nodes.map((node) => [node.id, node.title]));
    const consumedTextNodeIds = new Set<string>();
    const mediaLabelByNodeId = new Map<string, string>();

    const cleanPrompt = prompt.trim();
    let lastIndex = 0;
    let nextPrompt = "";

    for (const match of cleanPrompt.matchAll(/@\[node:([^\]]+)\]/g)) {
        if (match.index === undefined) continue;
        nextPrompt += cleanPrompt.slice(lastIndex, match.index);
        lastIndex = match.index + match[0].length;

        const refNodeId = match[1];
        const input = inputByNodeId.get(refNodeId) ?? resourceByNodeId.get(refNodeId);
        if (!input) {
            throw new Error(i18n.t("agent.composer.mentions.resourceMissing", { title: nodeTitleById.get(refNodeId) || refNodeId }));
        }

        const resources = flattenGenerationInputs([input]);
        const replacements: string[] = [];
        resources.forEach((resource) => {
            if (resource.type === "text") {
                const textContent = (resource.text || "").trim();
                consumedTextNodeIds.add(resource.nodeId);
                if (textContent) replacements.push(textContent);
            } else {
                let label = mediaLabelByNodeId.get(resource.nodeId);
                if (!label) {
                    label = resolveMediaLabel(resource, resourceInputs);
                    mediaLabelByNodeId.set(resource.nodeId, label);
                }
                replacements.push(label);
            }
        });
        nextPrompt += replacements.join("、");
    }

    nextPrompt += cleanPrompt.slice(lastIndex);
    const resolvedPrompt = nextPrompt.trim();

    const textResources = resourceInputs.filter((input) => input.type === "text" && Boolean(input.text));
    const unconsumedTexts = textResources
        .filter((textRes) => !consumedTextNodeIds.has(textRes.nodeId))
        .map((textRes) => (textRes.text || "").trim())
        .filter(Boolean);

    const textsToAppend = unconsumedTexts.filter((txt) => !resolvedPrompt.includes(txt));
    let finalPrompt = resolvedPrompt;
    if (!resolvedPrompt) {
        finalPrompt = unconsumedTexts.join("\n\n");
    } else if (textsToAppend.length > 0) {
        finalPrompt = `${resolvedPrompt}\n\n${textsToAppend.join("\n\n")}`;
    }

    return {
        prompt: finalPrompt.trim(),
        generationReferences,
        referenceImages,
        referenceVideos,
        referenceAudios,
        audioTracks,
        textCount: textResources.length,
        imageCount: referenceImages.length,
        videoCount: referenceVideos.length,
        audioCount: referenceAudios.length,
    };
}

/**
 * 把"音轨通道"的音频输入从生成输入里摘出来。
 *
 * 摘掉的这部分既不进 ComfyUI、也不占 3 音频配额、还不进 `generationReferences`：
 * 它是成片对白，混音是剪辑环节的事。留在生成输入里的话，配音会顶掉 H3 的音频参考名额，
 * 正是要避免的"阉割"。
 */
function splitAudioTrackInputs(nodeId: string, inputs: NodeGenerationResourceInput[], nodes: CanvasNodeData[]) {
    const target = nodes.find((node) => node.id === nodeId);
    if (!supportsAudioEdgeModes(target)) return { referenceInputs: inputs, audioTracks: [] as NodeGenerationAudioTrack[] };

    const overrides = target?.metadata?.audioEdgeModes;
    const sourceById = new Map(nodes.map((node) => [node.id, node]));
    const referenceInputs: NodeGenerationResourceInput[] = [];
    const audioTracks: NodeGenerationAudioTrack[] = [];

    for (const input of inputs) {
        if (input.type !== "audio") {
            referenceInputs.push(input);
            continue;
        }
        const source = sourceById.get(input.nodeId);
        if (!source || resolveAudioEdgeMode(overrides, source) === "reference") {
            referenceInputs.push(input);
            continue;
        }
        audioTracks.push({
            nodeId: input.nodeId,
            title: input.title,
            url: input.audio?.url,
            storageKey: input.audio?.storageKey,
            durationMs: input.audio?.durationMs,
        });
    }
    return { referenceInputs, audioTracks };
}

function buildComposerGenerationContext(inputs: NodeGenerationInput[], nodes: CanvasNodeData[], prompt: string): NodeGenerationContext {
    const inputByNodeId = new Map(inputs.map((input) => [input.nodeId, input]));
    const nodeTitleById = new Map(nodes.map((node) => [node.id, node.title]));
    const selectedInputs: NodeGenerationResourceInput[] = [];
    const snapshotInputs = new Map<string, NodeGenerationResourceInput>();
    const labelByNodeId = new Map<string, string>();
    const counts = { image: 0, video: 0, audio: 0, text: 0 };
    let hasToken = false;
    let lastIndex = 0;
    let nextPrompt = "";

    for (const match of prompt.matchAll(/@\[node:([^\]]+)\]/g)) {
        if (match.index === undefined) continue;
        hasToken = true;
        nextPrompt += prompt.slice(lastIndex, match.index);
        const input = inputByNodeId.get(match[1]);
        if (!input) {
            throw new Error(i18n.t("agent.composer.mentions.resourceMissing", { title: nodeTitleById.get(match[1]) || match[1] }));
        }
        const resources = flattenGenerationInputs([input]);
        resources.forEach((resource) => {
            if (!snapshotInputs.has(resource.nodeId)) snapshotInputs.set(resource.nodeId, resource);
        });
        const labels = resources.map((resource) => {
            if (resource.type === "text") {
                counts.text++;
                return (resource.text || "").trim();
            }
            let label = labelByNodeId.get(resource.nodeId);
            if (!label) {
                label = generationLabel(resource.type, counts[resource.type]++);
                labelByNodeId.set(resource.nodeId, label);
                selectedInputs.push(resource);
            }
            return label;
        });
        nextPrompt += labels.filter(Boolean).join("、");
        lastIndex = match.index + match[0].length;
    }

    nextPrompt += prompt.slice(lastIndex);
    const referenceImages = selectedInputs.map((input) => input.image).filter((image): image is ReferenceImage => Boolean(image));
    const referenceVideos = selectedInputs.map((input) => input.video).filter((video): video is ReferenceVideo => Boolean(video));
    const referenceAudios = selectedInputs.map((input) => input.audio).filter((audio): audio is ReferenceAudio => Boolean(audio));

    if (!hasToken) {
        return {
            prompt: prompt.trim(),
            generationReferences: [],
            referenceImages: [],
            referenceVideos: [],
            referenceAudios: [],
            audioTracks: [],
            textCount: 0,
            imageCount: 0,
            videoCount: 0,
            audioCount: 0,
        };
    }

    return {
        prompt: nextPrompt.trim(),
        generationReferences: snapshotGenerationInputs([...snapshotInputs.values()]),
        referenceImages,
        referenceVideos,
        referenceAudios,
        audioTracks: [],
        textCount: counts.text,
        imageCount: referenceImages.length,
        videoCount: referenceVideos.length,
        audioCount: referenceAudios.length,
    };
}

function snapshotGenerationInputs(inputs: NodeGenerationResourceInput[]): CanvasGenerationReferenceSnapshot[] {
    return inputs.flatMap((input): CanvasGenerationReferenceSnapshot[] => {
        if (input.type === "text" && input.text !== undefined) return [{ nodeId: input.nodeId, kind: "text", text: input.text }];
        if (input.type === "image" && input.image) {
            const url = input.image.storageKey ? undefined : input.image.url || (!input.image.dataUrl.startsWith("data:") ? input.image.dataUrl : undefined);
            return [{ nodeId: input.nodeId, kind: "image", storageKey: input.image.storageKey, url, mimeType: input.image.type }];
        }
        if (input.type === "video" && input.video) {
            return [{ nodeId: input.nodeId, kind: "video", storageKey: input.video.storageKey, url: input.video.storageKey ? undefined : input.video.url, mimeType: input.video.type }];
        }
        if (input.type === "audio" && input.audio) {
            return [{ nodeId: input.nodeId, kind: "audio", storageKey: input.audio.storageKey, url: input.audio.storageKey ? undefined : input.audio.url, mimeType: input.audio.type }];
        }
        return [];
    });
}

export function buildNodeGenerationInputs(nodeId: string, nodes: CanvasNodeData[], connections: CanvasConnection[]): NodeGenerationInput[] {
    return getGenerationResourceNodes(nodeId, nodes, connections).flatMap((node): NodeGenerationInput[] => {
        if (node.type === CanvasNodeType.Group) {
            const children = getGroupResourceNodes(node.id, nodes).flatMap(readNodeGenerationResource);
            return children.length ? [{ nodeId: node.id, type: "group", title: node.title, children }] : [];
        }
        return readNodeGenerationResource(node);
    });
}

function flattenGenerationInputs(inputs: NodeGenerationInput[]) {
    const resources = inputs.flatMap((input) => (input.type === "group" ? input.children : [input]));
    return [...new Map(resources.map((input) => [input.nodeId, input])).values()];
}

/** 首帧必须在尾帧之前：把显式标记了槽位的输入提到最前，其余保持连线顺序（sort 稳定）。 */
export function orderFrameSlotInputs(inputs: NodeGenerationResourceInput[], nodeId: string, connections: CanvasConnection[]) {
    const rankByNodeId = new Map<string, number>();
    for (const connection of connections) {
        if (connection.toNodeId !== nodeId) continue;
        rankByNodeId.set(connection.fromNodeId, connection.slot === "first_frame" ? 0 : 1);
    }
    return [...inputs].sort((a, b) => (rankByNodeId.get(a.nodeId) ?? 2) - (rankByNodeId.get(b.nodeId) ?? 2));
}

function resolveMediaLabel(resource: NodeGenerationResourceInput, resourceInputs: NodeGenerationResourceInput[]): string {
    if (resource.type === "text") return "";
    const index = resourceInputs.filter((input) => input.type === resource.type).findIndex((input) => input.nodeId === resource.nodeId);
    return generationLabel(resource.type, index);
}

function readNodeGenerationResource(node: CanvasNodeData): NodeGenerationResourceInput[] {
    const image = readReferenceImage(node);
    if (image) return [{ nodeId: node.id, type: "image", title: node.title, image }];
    const video = readReferenceVideo(node);
    if (video) return [{ nodeId: node.id, type: "video", title: node.title, video }];
    const audio = readReferenceAudio(node);
    if (audio) return [{ nodeId: node.id, type: "audio", title: node.title, audio }];
    const resource = getNodeDefinition(node.type)?.resource?.(node);
    if (resource?.kind === "image" && resource.url) return [{ nodeId: node.id, type: "image", title: node.title, image: { id: node.id, name: `${node.title || node.id}.png`, type: node.metadata?.mimeType || "image/png", dataUrl: resource.url, storageKey: node.metadata?.storageKey } }];
    if (resource?.kind === "video" && resource.url) return [{ nodeId: node.id, type: "video", title: node.title, video: { id: node.id, name: `${node.title || node.id}.mp4`, type: node.metadata?.mimeType || "video/mp4", url: resource.url, storageKey: node.metadata?.storageKey } }];
    if (resource?.kind === "audio" && resource.url) return [{ nodeId: node.id, type: "audio", title: node.title, audio: { id: node.id, name: `${node.title || node.id}.mp3`, type: node.metadata?.mimeType || "audio/mpeg", url: resource.url, storageKey: node.metadata?.storageKey } }];
    if (resource?.kind === "text" && resource.text) return [{ nodeId: node.id, type: "text", title: node.title, text: resource.text }];
    const text = readNodeTextInput(node);
    return text ? [{ nodeId: node.id, type: "text", title: node.title, text }] : [];
}

export function buildNodeResponseMessages(context: NodeGenerationContext): AiTextMessage[] {
    if (!context.referenceImages.length) {
        return [{ role: "user", content: context.prompt }];
    }

    return [
        {
            role: "user",
            content: [{ type: "text" as const, text: context.prompt }, ...context.referenceImages.map((image) => ({ type: "image_url" as const, image_url: { url: image.dataUrl } }))],
        },
    ];
}

export async function hydrateNodeGenerationContext(context: NodeGenerationContext) {
    const { imageToDataUrl } = await import("@/services/image-storage");
    return { ...context, referenceImages: await Promise.all(context.referenceImages.map(async (image) => ({ ...image, dataUrl: await imageToDataUrl(image) }))) };
}

/**
 * 只取「连到这个节点的参考图」，按连线顺序，转成可直接发出去的 dataUrl。
 *
 * 技能执行（提示词产出）只需要图：生成上下文里那套 `@[node:x]` 引用展开、上游文本节点正文拼接
 * 都是生成侧的职责，混进技能输入会把「处理当前节点这一句」变成「处理整条上游链路」。
 * 这里给空 prompt 走一遍上下文构造，就只为拿按序排好的 referenceImages。
 */
export async function collectNodeReferenceImages(nodeId: string, nodes: CanvasNodeData[], connections: CanvasConnection[]): Promise<ReferenceImage[]> {
    const context = buildNodeGenerationContext(nodeId, nodes, connections, "");
    if (!context.referenceImages.length) return [];
    const hydrated = await hydrateNodeGenerationContext(context);
    return hydrated.referenceImages.filter((image) => Boolean(image.dataUrl));
}

function readNodeTextInput(node: CanvasNodeData) {
    if (node.type === CanvasNodeType.Text) return node.metadata?.content || node.metadata?.prompt || "";
    return node.metadata?.prompt || "";
}

function generationLabel(type: NodeGenerationResourceInput["type"], index: number) {
    if (type === "image") return `<Picture ${index + 1}>`;
    if (type === "video") return `<Video ${index + 1}>`;
    if (type === "audio") return `<Audio ${index + 1}>`;
    return i18n.t("canvas.composer.resources.text", { index: index + 1 });
}

function readReferenceImage(node: CanvasNodeData): ReferenceImage | null {
    if (node.type !== CanvasNodeType.Image || !node.metadata?.content) return null;
    return {
        id: node.id,
        name: `${node.title || node.id}.png`,
        type: node.metadata.mimeType || "image/png",
        dataUrl: node.metadata.content,
        storageKey: node.metadata.storageKey,
    };
}

function readReferenceVideo(node: CanvasNodeData): ReferenceVideo | null {
    if (node.type !== CanvasNodeType.Video || !node.metadata?.content) return null;
    return {
        id: node.id,
        name: `${node.title || node.id}.mp4`,
        type: node.metadata.mimeType || "video/mp4",
        url: node.metadata.content,
        storageKey: node.metadata.storageKey,
        bytes: node.metadata.bytes,
        width: node.metadata.naturalWidth,
        height: node.metadata.naturalHeight,
        durationMs: node.metadata.durationMs,
    };
}

function readReferenceAudio(node: CanvasNodeData): ReferenceAudio | null {
    if (node.type !== CanvasNodeType.Audio || !node.metadata?.content) return null;
    return {
        id: node.id,
        name: `${node.title || node.id}.mp3`,
        type: node.metadata.mimeType || "audio/mpeg",
        url: node.metadata.content,
        storageKey: node.metadata.storageKey,
        durationMs: node.metadata.durationMs,
    };
}
