import i18n from "@/i18n";
import type { WorkflowCategory } from "@/stores/use-config-store";

/**
 * 内置提示词技能：不依赖用户装任何 Skill，随产品发布即可用。
 * 只放「有哪些技能、要不要图」这类结构信息，具体指令文案走 i18n。
 */
export type BuiltinPromptSkillId = "prompt-polish" | "prompt-shot" | "prompt-i18n" | "prompt-fit" | "prompt-from-image" | "prompt-image" | "prompt-video-minimax" | "storyboard" | "novel-deconstruct" | "director-stage-scene";

/** 技能产出形态：改写这段文字（inline），还是在画布上产出节点（nodes）。 */
export type PromptSkillProduces = "inline" | "nodes";

export type BuiltinPromptSkill = {
    id: BuiltinPromptSkillId;
    /** inline = 写回当前文本节点；nodes = 在画布上建节点（只能走 Agent）。 */
    produces: PromptSkillProduces;
    /** 需要输入图片（如反推），否则纯文本。 */
    needsImage?: boolean;
    /** 该技能建议配合的工作流分类（仅用于默认选中提示，不强制）。 */
    preferredCategory?: WorkflowCategory;
};

export const BUILTIN_PROMPT_SKILLS: BuiltinPromptSkill[] = [
    { id: "prompt-polish", produces: "inline" },
    { id: "prompt-shot", produces: "inline", preferredCategory: "omniVideo" },
    { id: "prompt-i18n", produces: "inline" },
    { id: "prompt-fit", produces: "inline" },
    { id: "prompt-from-image", produces: "inline", needsImage: true },
    { id: "prompt-image", produces: "inline", preferredCategory: "t2i" },
    { id: "prompt-video-minimax", produces: "inline", preferredCategory: "omniVideo" },
    { id: "storyboard", produces: "nodes" },
    { id: "novel-deconstruct", produces: "nodes" },
    { id: "director-stage-scene", produces: "nodes" },
];

export const DEFAULT_BUILTIN_PROMPT_SKILL: BuiltinPromptSkillId = "prompt-polish";

export function promptSkillLabel(id: BuiltinPromptSkillId): string {
    return i18n.t(`canvas.promptAssistant.skills.${id}`);
}

export function promptSkillHint(id: BuiltinPromptSkillId): string {
    return i18n.t(`canvas.promptAssistant.skillHints.${id}`);
}

export function promptSkillInstruction(id: BuiltinPromptSkillId): string {
    return i18n.t(`canvas.promptAssistant.skillInstructions.${id}`);
}

/** 该内置技能的产出形态；未知 id 按「改写」处理，避免误建节点。 */
export function promptSkillProduces(id: BuiltinPromptSkillId): PromptSkillProduces {
    return BUILTIN_PROMPT_SKILLS.find((skill) => skill.id === id)?.produces ?? "inline";
}

/**
 * nodes 技能的画布操作契约：不同技能要产出的东西不一样（文本卡 vs 3D 导演台节点），
 * 没有专属契约的技能返回 undefined，由调用方回退到通用契约。
 */
export function promptSkillOutputContract(id: BuiltinPromptSkillId): string | undefined {
    const key = `canvas.promptAssistant.skillOutputContracts.${id}`;
    return i18n.exists(key) ? i18n.t(key) : undefined;
}

export function isBuiltinPromptSkillId(value: unknown): value is BuiltinPromptSkillId {
    return typeof value === "string" && BUILTIN_PROMPT_SKILLS.some((skill) => skill.id === value);
}
