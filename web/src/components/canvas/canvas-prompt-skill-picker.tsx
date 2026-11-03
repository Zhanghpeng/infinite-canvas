import { Select, type SelectProps } from "antd";
import { Bot, Cpu, Sparkles, WandSparkles } from "lucide-react";
import { useTranslation } from "react-i18next";

import { DUAL_PROMPT_SKILL_NAME, isInlineAgentSkill, resolveSkillProduces, type PromptAssistantConfig, type PromptAssistantSkillRef } from "@/lib/canvas/canvas-prompt-assistant";
import { BUILTIN_PROMPT_SKILLS, promptSkillHint, promptSkillLabel } from "@/lib/canvas/prompt-skills";
import { useAgentSkillStore } from "@/stores/use-agent-skill-store";
import { useAgentStore } from "@/stores/use-agent-store";
import { useEffectiveConfig } from "@/stores/use-config-store";

type ExecutorPickerProps = {
    config: PromptAssistantConfig;
    onChange: (patch: Partial<PromptAssistantConfig>) => void;
    /** 选了 ComfyUI 渠道时写回节点（工作流下拉会随之自动校准）。 */
    onChannelChange: (channelId: string) => void;
};

/**
 * 执行者下拉：把「渠道（含系统内置 ComfyUI）」与「本地 Agent」放在同一个下拉里。
 * 选渠道 = 用该渠道的文本工作流跑；选 Agent = 用本地 Agent + 技能跑。
 */
export function CanvasPromptExecutorPicker({ config, onChange, onChannelChange }: ExecutorPickerProps) {
    const { t } = useTranslation();
    const channels = useEffectiveConfig().channels || [];
    const agentConnected = useAgentStore((state) => state.connected);

    const activeChannelId = config.channelId || channels[0]?.id;
    // Agent 通道**只有 Codex 一条**：runPromptAssistantTurn 打的就是 /agent/codex/turn，
    // 不读 agentId 也不读 store 的 agentProvider。所以下拉里别让用户以为能选别的 ——
    // 选中一个禁不了、跑起来却仍是 Codex 的选项，比置灰更让人困惑。
    const value = config.backend === "agent" ? "agent:codex" : `channel:${activeChannelId || ""}`;

    const options: SelectProps["options"] = [
        {
            label: <span className="text-[11px] font-semibold text-stone-400">{t("canvas.promptAssistant.channels")}</span>,
            options: channels.map((channel, index) => ({
                value: `channel:${channel.id}`,
                label: (
                    <span className="flex w-[176px] items-center gap-1">
                        <Cpu className="size-3 shrink-0 text-stone-400" />
                        <span className="min-w-0 flex-1 truncate text-xs">{channel.name}</span>
                        {index === 0 ? <span className="shrink-0 text-[10px] opacity-55">{t("canvas.promptAssistant.defaultChannel")}</span> : null}
                    </span>
                ),
            })),
        },
        {
            label: <span className="text-[11px] font-semibold text-stone-400">{t("canvas.promptAssistant.agentGroup")}</span>,
            options: (["codex", "claude", "workbuddy"] as const).map((provider) => {
                // 只有 Codex 是通的。其余置灰并给可读原因：Claude 的 adapter 未经端到端验证，
                // WorkBuddy 要走右侧 Agent 面板（提示词助手的链路还没接它）。
                const reason = !agentConnected
                    ? t("canvas.promptAssistant.agentOffline")
                    : provider === "claude"
                      ? t("canvas.promptAssistant.agentUnavailable")
                      : provider === "workbuddy"
                        ? t("canvas.promptAssistant.agentCodexOnly")
                        : undefined;
                return {
                    value: `agent:${provider}`,
                    disabled: Boolean(reason),
                    label: (
                        <span className="flex w-[176px] items-center gap-1" title={reason}>
                            <Bot className="size-3 shrink-0 text-stone-400" />
                            <span className="min-w-0 flex-1 truncate text-xs">{t(`canvas.promptAssistant.agents.${provider}`)}</span>
                        </span>
                    ),
                };
            }),
        },
    ];

    return (
        <Select
            size="small"
            className="w-[130px] shrink-0"
            popupMatchSelectWidth={false}
            listHeight={260}
            value={value}
            onChange={(next: string) => {
                if (next.startsWith("channel:")) {
                    const channelId = next.replace("channel:", "");
                    onChannelChange(channelId);
                    onChange({ backend: "comfyui", agentId: undefined });
                    return;
                }
                onChange({ backend: "agent", agentId: next.replace("agent:", "") });
            }}
            options={options}
        />
    );
}

/** 技能：仅本地 Agent 执行时才有意义（ComfyUI 走工作流，不需要技能）。 */
export function CanvasPromptSkillPicker({ config, onChange }: { config: PromptAssistantConfig; onChange: (patch: Partial<PromptAssistantConfig>) => void }) {
    const { t } = useTranslation();
    const agentEndpoint = useAgentStore((state) => state.url);
    const agentToken = useAgentStore((state) => state.token);
    const agentSkills = useAgentSkillStore((state) => state.skills);
    const loadSkills = useAgentSkillStore((state) => state.loadSkills);

    // 视频提示词类技能单独成组，方便一次找到；标签一律按技能真实产出形态打，
    // 不再「运行时技能 = 产出节点」硬编码（技能执行默认就是写回本节点）。
    const videoRecipes = agentSkills.filter((skill) => isInlineAgentSkill(skill.name));
    const canvasSkills = agentSkills.filter((skill) => !isInlineAgentSkill(skill.name));
    const agentSkillOption = (skill: (typeof agentSkills)[number]) => {
        const produces = resolveSkillProduces({ backend: "agent", skill: { kind: "agent", name: skill.name, path: skill.path } });
        return {
            value: `agent:${skill.name}|${skill.path}`,
            label: (
                <OptionLabel
                    icon={<Sparkles className="size-3 shrink-0 text-stone-400" />}
                    text={skill.interface?.displayName || skill.name}
                    hint={skill.name === DUAL_PROMPT_SKILL_NAME ? t("canvas.promptAssistant.dualPromptSkillHint") : skill.shortDescription || skill.description}
                    tag={t(produces === "nodes" ? "canvas.promptAssistant.producesNodes" : "canvas.promptAssistant.producesInline")}
                />
            ),
        };
    };

    const options: SelectProps["options"] = [
        {
            label: <span className="text-[11px] font-semibold text-stone-400">{t("canvas.promptAssistant.builtinSkills")}</span>,
            options: BUILTIN_PROMPT_SKILLS.filter((skill) => skill.produces === "inline" || config.backend === "agent").map((skill) => ({
                value: `builtin:${skill.id}`,
                label: (
                    <OptionLabel
                        icon={<WandSparkles className="size-3 shrink-0 text-stone-400" />}
                        text={promptSkillLabel(skill.id)}
                        hint={promptSkillHint(skill.id)}
                        tag={t(skill.produces === "nodes" ? "canvas.promptAssistant.producesNodes" : "canvas.promptAssistant.producesInline")}
                    />
                ),
            })),
        },
        ...(videoRecipes.length
            ? [
                  {
                      label: <span className="text-[11px] font-semibold text-stone-400">{t("canvas.promptAssistant.videoPromptSkillGroup")}</span>,
                      options: videoRecipes.map(agentSkillOption),
                  },
              ]
            : []),
        ...(canvasSkills.length
            ? [
                  {
                      label: <span className="text-[11px] font-semibold text-stone-400">{t("canvas.promptAssistant.agentSkills")}</span>,
                      options: canvasSkills.map(agentSkillOption),
                  },
              ]
            : []),
    ];

    const value = config.skill ? (config.skill.kind === "builtin" ? `builtin:${config.skill.id}` : `agent:${config.skill.name}|${config.skill.path}`) : undefined;

    return (
        <Select
            size="small"
            className="min-w-[130px] max-w-[170px] shrink-0"
            popupMatchSelectWidth={false}
            listHeight={260}
            allowClear
            placeholder={t("canvas.promptAssistant.skillPlaceholder")}
            value={value}
            onOpenChange={(open) => {
                // 展开时按需拉一次本机 Skill 列表。
                if (open && agentEndpoint && agentToken) void loadSkills(agentEndpoint, agentToken).catch(() => undefined);
            }}
            onChange={(next?: string) => {
                if (!next) return onChange({ skill: undefined });
                if (next.startsWith("builtin:")) {
                    onChange({ skill: { kind: "builtin", id: next.replace("builtin:", "") } as PromptAssistantSkillRef });
                    return;
                }
                const [name, ...rest] = next.replace("agent:", "").split("|");
                // 运行时技能只有本地 Agent 跑得动：选中即切过去，省掉「先切执行者再选技能」这一步。
                onChange({ skill: { kind: "agent", name, path: rest.join("|") }, backend: "agent" });
            }}
            options={options}
        />
    );
}

/** 选项只要能认出是哪个就够：一行「图标 + 名称 + 标签」，说明文字改挂 title，弹层就不会被撑宽。 */
function OptionLabel({ icon, text, hint, tag }: { icon: React.ReactNode; text: string; hint?: string; tag?: string }) {
    return (
        <span className="flex w-[188px] items-center gap-1" title={hint}>
            {icon}
            <span className="min-w-0 flex-1 truncate text-xs">{text}</span>
            {tag ? <span className="shrink-0 rounded bg-black/5 px-1 text-[10px] opacity-70 dark:bg-white/10">{tag}</span> : null}
        </span>
    );
}
