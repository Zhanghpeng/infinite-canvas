import { Select, type SelectProps } from "antd";
import { Bot, Cpu, Sparkles, WandSparkles } from "lucide-react";
import { useTranslation } from "react-i18next";

import type { PromptAssistantConfig, PromptAssistantSkillRef } from "@/lib/canvas/canvas-prompt-assistant";
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
    const agentProvider = useAgentStore((state) => state.agentProvider);

    const activeChannelId = config.channelId || channels[0]?.id;
    const value = config.backend === "agent" ? `agent:${config.agentId || agentProvider || "codex"}` : `channel:${activeChannelId || ""}`;

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
            options: (["codex", "claude", "workbuddy"] as const).map((provider) => ({
                value: `agent:${provider}`,
                // 目前只有 Codex / WorkBuddy 有完整通路，Claude 先禁用以免误导。
                disabled: !agentConnected || provider === "claude",
                label: (
                    <span
                        className="flex w-[176px] items-center gap-1"
                        // Claude 仍禁用（adapter 未端到端验证），但要说清"为什么不能选"，别只是静默置灰
                        title={!agentConnected ? t("canvas.promptAssistant.agentOffline") : provider === "claude" ? t("canvas.promptAssistant.agentUnavailable") : undefined}
                    >
                        <Bot className="size-3 shrink-0 text-stone-400" />
                        <span className="min-w-0 flex-1 truncate text-xs">{t(`canvas.promptAssistant.agents.${provider}`)}</span>
                    </span>
                ),
            })),
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
        ...(agentSkills.length
            ? [
                  {
                      label: <span className="text-[11px] font-semibold text-stone-400">{t("canvas.promptAssistant.agentSkills")}</span>,
                      options: agentSkills.map((skill) => ({
                          value: `agent:${skill.name}|${skill.path}`,
                          label: (
                              <OptionLabel
                                  icon={<Sparkles className="size-3 shrink-0 text-stone-400" />}
                                  text={skill.interface?.displayName || skill.name}
                                  hint={skill.shortDescription || skill.description}
                                  tag={t("canvas.promptAssistant.producesNodes")}
                              />
                          ),
                      })),
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
                onChange({ skill: { kind: "agent", name, path: rest.join("|") } });
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
