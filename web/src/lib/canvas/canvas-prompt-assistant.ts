import { nanoid } from "nanoid";

import i18n from "@/i18n";
import type { WorkflowCategory } from "@/stores/use-config-store";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData, type CanvasNodeMetadata, type CanvasNodeText } from "@/types/canvas";
import { DEFAULT_BUILTIN_PROMPT_SKILL, promptSkillInstruction, promptSkillOutputContract, promptSkillProduces, type BuiltinPromptSkillId, type PromptSkillProduces } from "./prompt-skills";

export type { PromptSkillProduces };

/** 提示词助手：把文本节点里的一段话交给本地 ComfyUI 文本工作流或本地 Agent 改写，再落回节点。 */
export type PromptAssistantBackend = "comfyui" | "agent";

export type PromptAssistantSkillRef = { kind: "builtin"; id: BuiltinPromptSkillId } | { kind: "agent"; name: string; path: string };

export type PromptAssistantConfig = {
    backend: PromptAssistantBackend;
    /** 执行者=渠道时用哪个渠道（不填=第一个/系统内置）。 */
    channelId?: string;
    agentId?: string;
    model?: string;
    effort?: string;
    /** 可不选：不选就是原来的文本生成，选了才按技能执行。 */
    skill?: PromptAssistantSkillRef;
    instruction?: string;
};

export const DEFAULT_PROMPT_ASSISTANT_CONFIG: PromptAssistantConfig = {
    backend: "comfyui",
    skill: { kind: "builtin", id: DEFAULT_BUILTIN_PROMPT_SKILL },
};

/** 单次处理的源文上限（字符）：超了要先按章节拆分或截断，避免把长文整段塞进上下文。 */
export const MAX_ASSISTANT_SOURCE_CHARS = 8000;

export function buildPromptAssistantRequest(input: { config: PromptAssistantConfig; nodeText: string; workflowConstraint?: string; contextBlock?: string; hasImages?: boolean }): { prompt: string; truncated: boolean } {
    const blocks: string[] = [];
    if (input.config.skill?.kind === "builtin") blocks.push(promptSkillInstruction(input.config.skill.id));
    if (input.config.instruction?.trim()) blocks.push(i18n.t("canvas.promptAssistant.extraInstructionTemplate", { instruction: input.config.instruction.trim() }));
    if (input.workflowConstraint?.trim()) blocks.push(input.workflowConstraint.trim());
    if (input.contextBlock?.trim()) blocks.push(input.contextBlock.trim());
    if (input.hasImages) blocks.push(i18n.t("canvas.promptAssistant.imageContext"));
    // 走 Agent 时它是「有工具的智能体」，必须明确禁用工具：否则可能去跑命令/读写文件，既慢又要等审批。
    if (input.config.backend === "agent") blocks.push(i18n.t("canvas.promptAssistant.agentTaskContract"));
    blocks.push(i18n.t("canvas.promptAssistant.outputContract"));

    const { text, truncated } = truncatePromptSource(input.nodeText);
    blocks.push(i18n.t("canvas.promptAssistant.sourceBlock", { text }));
    return { prompt: blocks.join("\n\n"), truncated };
}

function truncatePromptSource(source: string): { text: string; truncated: boolean } {
    const trimmed = source.trim();
    if (trimmed.length <= MAX_ASSISTANT_SOURCE_CHARS) return { text: trimmed, truncated: false };
    const head = Math.floor(MAX_ASSISTANT_SOURCE_CHARS * 0.6);
    const tail = MAX_ASSISTANT_SOURCE_CHARS - head;
    return { text: `${trimmed.slice(0, head)}\n${i18n.t("canvas.promptAssistant.truncatedMarker")}\n${trimmed.slice(-tail)}`, truncated: true };
}

/**
 * 面向工作流的人话约束：告诉模型这段提示词要被谁消费、有哪些槽位、该写成什么形态。
 * 只做定性提示（不编造硬性字数上限）；拿不到分类或槽位时返回空串，不阻塞优化。
 */
export function resolveWorkflowConstraint(category: WorkflowCategory | undefined, slots: string[]): string {
    if (!category) return "";
    const label = i18n.t(`config.channelEditor.workflowCategoryNames.${category}`);
    const visibleSlots = slots.filter((slot) => slot !== "prompt").slice(0, 8);
    const blocks = [i18n.t("canvas.promptAssistant.constraintTarget", { category: label })];
    if (visibleSlots.length) blocks.push(i18n.t("canvas.promptAssistant.constraintSlots", { slots: visibleSlots.join(" · ") }));
    const shape = resolveShapeHint(category, slots);
    if (shape) blocks.push(shape);
    return blocks.join("\n");
}

function resolveShapeHint(category: WorkflowCategory, slots: string[]): string {
    if (slots.includes("first_frame") || slots.includes("last_frame")) return i18n.t("canvas.promptAssistant.shapeFrameVideo");
    if (category === "inpaint" || slots.some((slot) => /^(ref_)?mask(_\d+)?$/.test(slot))) return i18n.t("canvas.promptAssistant.shapeInpaint");
    if (category === "i2i") return i18n.t("canvas.promptAssistant.shapeReferenceImage");
    if (category === "t2i") return i18n.t("canvas.promptAssistant.shapeTextToImage");
    if (category === "omniVideo") return i18n.t("canvas.promptAssistant.shapeVideo");
    if (category === "text") return i18n.t("canvas.promptAssistant.shapeText");
    return "";
}

/**
 * 推断这条文本最终会被谁消费：作为下游节点（生图/生视频）的输入时按下游推断，否则按文本生成。
 * 只用于生成「面向工作流」的约束提示，推不出来时返回 undefined 不影响优化。
 */
export function resolveAssistantTargetCategory(nodeId: string, nodes: CanvasNodeData[], connections: CanvasConnection[]): WorkflowCategory | undefined {
    const consumers = connections
        .filter((connection) => connection.kind === "input" && connection.fromNodeId === nodeId)
        .map((connection) => nodes.find((item) => item.id === connection.toNodeId))
        .filter((item): item is CanvasNodeData => Boolean(item));
    for (const consumer of consumers) {
        const mode = consumer.metadata?.generationMode;
        if (mode === "video") return consumer.metadata?.videoMode === "frame" ? "frameVideo" : "omniVideo";
        if (mode === "audio") return "audio";
        if (mode === "image") return consumer.metadata?.references?.length || consumer.metadata?.generationType === "edit" ? "i2i" : "t2i";
    }
    return "text";
}

/** 从工作流 JSON 里收集 _meta.title 槽位，供约束块使用。 */
export function collectWorkflowSlots(workflow: unknown): string[] {
    const slots = new Set<string>();
    const walk = (value: unknown) => {
        if (!value || typeof value !== "object") return;
        const record = value as Record<string, unknown>;
        const title = (record._meta as Record<string, unknown> | undefined)?.title;
        if (typeof title === "string" && title.trim()) slots.add(title.trim().toLowerCase());
        Object.values(record).forEach(walk);
    };
    walk(workflow);
    return [...slots].sort();
}

/** 文本节点当前展示的那段文字。 */
export function readNodeText(node: CanvasNodeData): string {
    if (node.type !== CanvasNodeType.Text) return "";
    const primary = node.metadata?.texts?.find((text) => text.id === node.metadata?.primaryTextId);
    return (primary?.content || node.metadata?.content || "").trim();
}

/** 优化结果先落成一条新备选（不覆盖原文），流式期间就挂在它上面，用户能边写边看。 */
export function appendOptimizedTextSlot(node: CanvasNodeData): { slotId: string; texts: CanvasNodeText[] } {
    const slotId = nanoid();
    const slot: CanvasNodeText = { id: slotId, status: "loading", content: "" };
    return { slotId, texts: [...(node.metadata?.texts || []), slot] };
}

/** 把流式/最终文本写进备选并设为主文本，同时同步 content（保持与 handleNodeContentChange 一致的语义）。 */
export function applyOptimizedText(node: CanvasNodeData, slotId: string, text: string, status: CanvasNodeText["status"] = "success"): Pick<CanvasNodeMetadata, "texts" | "primaryTextId" | "content"> {
    const texts = (node.metadata?.texts || []).map((slot) => (slot.id === slotId ? { ...slot, content: text, status, errorDetails: undefined } : slot));
    return { texts, primaryTextId: slotId, content: text };
}

/** 优化失败或取消时把临时备选摘掉，并让显示回到原文。 */
export function revertOptimizedTextSlot(node: CanvasNodeData, slotId: string): Pick<CanvasNodeMetadata, "texts" | "primaryTextId" | "content"> {
    const remaining = (node.metadata?.texts || []).filter((slot) => slot.id !== slotId);
    const original = remaining.find((slot) => slot.id === node.metadata?.primaryTextId) || remaining.find((slot) => slot.content?.trim()) || remaining[0];
    const content = original?.content || node.metadata?.content || "";
    return { texts: remaining, primaryTextId: original?.id, content };
}

/** 去除模型爱加的前后缀（代码块、解释性开场白），只留提示词正文。 */
export function cleanOptimizedPrompt(raw: string): string {
    let text = raw.trim();
    const fence = /^```[a-zA-Z]*\n([\s\S]*?)\n?```$/.exec(text);
    if (fence) text = fence[1].trim();
    text = text.replace(/^(优化后的?提示词|提示词|prompt)\s*[:：]\s*/i, "");
    return text.trim();
}

/** 产出形态由技能决定：内置技能按声明，运行时 Skill 默认「产出节点」；没选技能时返回 undefined（走普通生成）。 */
export function resolveSkillProduces(config: PromptAssistantConfig): PromptSkillProduces | undefined {
    if (!config.skill) return undefined;
    if (config.skill.kind === "builtin") return promptSkillProduces(config.skill.id);
    return "nodes";
}

/**
 * nodes 形态的请求：技能负责「建什么节点」，这里补上「怎么操作画布」的约定与产出契约。
 * 不回写当前节点，产出统计由前端按画布 diff 计算。
 */
export function buildNodeOutputRequest(input: { config: PromptAssistantConfig; nodeId: string; nodeTitle: string; nodeText: string; chapterLabel?: string; canvasHint?: string }): { prompt: string; truncated: boolean } {
    const blocks: string[] = [];
    if (input.config.skill?.kind === "builtin") blocks.push(promptSkillInstruction(input.config.skill.id));
    if (input.config.instruction?.trim()) blocks.push(i18n.t("canvas.promptAssistant.extraInstructionTemplate", { instruction: input.config.instruction.trim() }));
    // 画布操作契约由技能决定：导演台要建的是 3D 节点，不是通用契约里的文本卡。
    const skillContract = input.config.skill?.kind === "builtin" ? promptSkillOutputContract(input.config.skill.id) : undefined;
    blocks.push(
        skillContract ??
            i18n.t("canvas.promptAssistant.nodeOutputContract", {
                title: input.nodeTitle || i18n.t("canvas.node.untitled"),
                id: input.nodeId,
                chapter: input.chapterLabel || "",
            }),
    );
    if (input.canvasHint?.trim()) blocks.push(input.canvasHint.trim());

    const { text, truncated } = truncatePromptSource(input.nodeText);
    blocks.push(i18n.t("canvas.promptAssistant.sourceBlock", { text }));
    blocks.push(i18n.t("canvas.promptAssistant.nodeOutputResultContract"));
    return { prompt: blocks.join("\n\n"), truncated };
}

/** 产出统计文案（单条与分组批量共用）：文本卡/分组之外的节点（图片、导演台…）在数量大于 0 时追加一段。 */
export function assistantOutputSummaryText(counts: Omit<AssistantOutputSummary, "addedIds">): string {
    const base = i18n.t("canvas.promptAssistant.nodesDone", { nodes: counts.addedNodes, text: counts.addedTextNodes, groups: counts.addedGroups, connections: counts.addedConnections });
    if (!counts.addedOtherNodes) return base;
    return `${base} · ${i18n.t("canvas.promptAssistant.nodesDoneOther", { others: counts.addedOtherNodes })}`;
}

export type AssistantOutputSummary = {
    addedNodes: number;
    addedTextNodes: number;
    /** 既不是文本卡也不是分组的产出（图片、导演台节点…），文案里单独报。 */
    addedOtherNodes: number;
    addedGroups: number;
    addedConnections: number;
    addedIds: string[];
};

/** 产出统计只看「新增」：按前后画布 diff 计算，不采信模型自述。 */
export function summarizeAssistantOutput(before: { nodes: CanvasNodeData[]; connections: CanvasConnection[] }, after: { nodes: CanvasNodeData[]; connections: CanvasConnection[] }): AssistantOutputSummary {
    const beforeIds = new Set(before.nodes.map((node) => node.id));
    const added = after.nodes.filter((node) => !beforeIds.has(node.id));
    const beforeConnectionIds = new Set(before.connections.map((connection) => connection.id));
    return {
        addedNodes: added.length,
        addedTextNodes: added.filter((node) => node.type === CanvasNodeType.Text).length,
        addedOtherNodes: added.filter((node) => node.type !== CanvasNodeType.Text && node.type !== CanvasNodeType.Group).length,
        addedGroups: added.filter((node) => node.type === CanvasNodeType.Group).length,
        addedConnections: after.connections.filter((connection) => !beforeConnectionIds.has(connection.id)).length,
        addedIds: added.map((node) => node.id),
    };
}
