import { Cascader, Tooltip } from "antd";
import { AlertTriangle, Eye, HelpCircle, MessageSquareText, Server, Sparkles } from "lucide-react";
import { useEffect, useMemo } from "react";

import {
    BUILTIN_TEXT_WORKFLOW_MODELS,
    evaluateModelAvailability,
    getModelProfile,
    textQwen35Profile,
    type WorkflowModelProfile,
} from "@/services/api/models";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import { useEffectiveConfig } from "@/stores/use-config-store";
import {
    isChannelAvailable,
    resolveModelWhenSwitchingChannel,
    summarizeChannelAvailability,
    type ChannelAvailabilityContext,
} from "@/lib/canvas/model-picker-channels";

export type TextModelPickerProps = {
    channelId?: string;
    modelId?: string;
    onChange: (channelId: string, modelId: string, profile: WorkflowModelProfile) => void;
    className?: string;
    disabled?: boolean;
    connectedImages?: number;
    connectedVideos?: number;
    connectedAudios?: number;
    promptText?: string;
};

function getModelIcon(modelId: string) {
    return <Sparkles className="size-3.5 shrink-0 text-emerald-500" />;
}

export function TextModelPicker({
    channelId,
    modelId,
    onChange,
    className = "",
    disabled = false,
    connectedImages = 0,
    connectedVideos = 0,
    connectedAudios = 0,
    promptText = "",
}: TextModelPickerProps) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const config = useEffectiveConfig();

    const channels = useMemo(() => {
        return config.channels && config.channels.length > 0
            ? config.channels
            : [{ id: "builtin", name: "系统内置 ComfyUI", baseUrl: "http://127.0.0.1:8188", apiKey: "", apiFormat: "comfyui" as const, models: [] }];
    }, [config.channels]);

    const activeChannel = useMemo(() => {
        return (channelId ? channels.find((c) => c.id === channelId) : null) || channels[0];
    }, [channels, channelId]);

    const activeProfile = useMemo(() => {
        return getModelProfile(modelId) || textQwen35Profile;
    }, [modelId]);

    const availabilityContext = useMemo<ChannelAvailabilityContext>(
        () => ({ connectedImages, connectedVideos, connectedAudios, promptText }),
        [connectedImages, connectedVideos, connectedAudios, promptText],
    );

    // 渠道级和模型级共用同一份可用性结果：列表里「这个渠道有几个能选」必须和展开后看到的置灰情况一致。
    const channelSummaries = useMemo(
        () => channels.map((channel) => summarizeChannelAvailability(channel, BUILTIN_TEXT_WORKFLOW_MODELS, availabilityContext)),
        [channels, availabilityContext],
    );

    // 只有存在别的可切换渠道时才置灰「一个模型都用不了」的渠道。
    const hasSelectableChannel = channelSummaries.some((summary) => summary.selectableCount > 0);

    // 级联递进选项：第一级为 API 提供商 (算力主机)，hover 展开第二级为模型
    const options = useMemo(() => {
        return channelSummaries.map((summary) => ({
            value: summary.channel.id,
            disabled: hasSelectableChannel && summary.selectableCount === 0,
            label: (
                <div className="flex items-center gap-1.5 py-0.5">
                    <Server className="size-3.5 text-blue-500 shrink-0" />
                    <span className="font-medium text-xs truncate max-w-[140px]">{summary.channel.name || "ComfyUI 主机"}</span>
                    <span
                        className={`ml-auto shrink-0 text-[10px] tabular-nums ${summary.selectableCount === 0 ? "text-rose-500" : "text-stone-400"}`}
                        title={`${summary.selectableCount}/${summary.total} 个模型可切换`}
                    >
                        {summary.selectableCount}/{summary.total}
                    </span>
                </div>
            ),
            rawName: summary.channel.name,
            children: summary.entries.map(({ model, availability }) => {
                const isBlocked = !availability.isSelectable;
                const needsInputs = availability.isSelectable && !availability.isAvailable;

                return {
                    value: model.id,
                    disabled: isBlocked,
                    label: (
                        <div className={`flex items-center justify-between gap-2 py-0.5 min-w-[200px] ${isBlocked ? "opacity-60" : ""}`}>
                            <div className="flex items-center gap-1.5 truncate">
                                {getModelIcon(model.id)}
                                <span className="font-medium text-xs truncate">{model.name}</span>
                            </div>
                            {isBlocked ? (
                                <Tooltip
                                    title={
                                        <div className="space-y-1 text-xs">
                                            <div className="font-semibold text-rose-400">无法切换（资源冲突）：</div>
                                            {availability.blockingReasons.map((r, i) => (
                                                <div key={i} className="flex items-start gap-1">
                                                    <span className="text-rose-400">•</span>
                                                    <span>{r}</span>
                                                </div>
                                            ))}
                                        </div>
                                    }
                                >
                                    <span
                                        className="pointer-events-auto flex items-center gap-0.5 text-rose-500 shrink-0 cursor-help p-0.5 hover:text-rose-600"
                                        onClick={(e) => e.stopPropagation()}
                                        onMouseDown={(e) => e.stopPropagation()}
                                    >
                                        <HelpCircle className="size-3.5" />
                                    </span>
                                </Tooltip>
                            ) : needsInputs ? (
                                <Tooltip
                                    title={
                                        <div className="space-y-1 text-xs">
                                            <div className="font-semibold text-amber-300">选定后前置要求：</div>
                                            {availability.warningReasons.map((r, i) => (
                                                <div key={i} className="flex items-start gap-1">
                                                    <span className="text-amber-400">•</span>
                                                    <span>{r}</span>
                                                </div>
                                            ))}
                                        </div>
                                    }
                                >
                                    <span
                                        className="pointer-events-auto flex items-center gap-0.5 text-amber-500 shrink-0 cursor-help p-0.5 hover:text-amber-600"
                                        onClick={(e) => e.stopPropagation()}
                                        onMouseDown={(e) => e.stopPropagation()}
                                    >
                                        <AlertTriangle className="size-3.5" />
                                    </span>
                                </Tooltip>
                            ) : null}
                        </div>
                    ),
                    model,
                    availability,
                };
            }),
        }));
    }, [channelSummaries, hasSelectableChannel]);

    // 当前渠道下真正对得上的模型。传进来的 modelId 可能已不属于该渠道，显示层回落到该渠道第一个可选模型。
    const effectiveProfile = useMemo(() => {
        const summary = channelSummaries.find((item) => item.channel.id === activeChannel.id);
        const present = summary?.entries.find((entry) => entry.model.id === activeProfile.id);
        return present?.model || summary?.firstSelectable || summary?.entries[0]?.model || activeProfile;
    }, [channelSummaries, activeChannel, activeProfile]);

    const cascaderValue = useMemo(() => {
        return [activeChannel.id, effectiveProfile.id];
    }, [activeChannel.id, effectiveProfile.id]);

    const handleCascaderChange = (value: (string | number)[]) => {
        if (!value || value.length === 0) return;
        const selectedChannelId = String(value[0]);
        const channel = channels.find((item) => item.id === selectedChannelId) || activeChannel;

        // 只点了渠道那一级（changeOnSelect）：保留当前模型，换不过去才退回新渠道第一个可选模型。
        if (value.length < 2) {
            const nextProfile = resolveModelWhenSwitchingChannel(channel, BUILTIN_TEXT_WORKFLOW_MODELS, availabilityContext, effectiveProfile.id);
            if (!nextProfile) return;
            onChange(channel.id, nextProfile.id, nextProfile);
            return;
        }

        const found = getModelProfile(String(value[1])) || activeProfile;
        onChange(channel.id, found.id, found);
    };

    // 钉着的渠道被删除后，选择器会静默显示第一个渠道而执行侧仍用失效 id。只纠正「引用不存在」。
    useEffect(() => {
        if (!channelId || isChannelAvailable(channels, channelId)) return;
        const fallback = channelSummaries[0];
        if (!fallback) return;
        const profile = fallback.firstSelectable || fallback.entries[0]?.model;
        if (!profile) return;
        onChange(fallback.channel.id, profile.id, profile);
    }, [channelId, channels, channelSummaries, onChange]);

    const activeAvailability = useMemo(() => {
        return evaluateModelAvailability({
            targetModel: effectiveProfile,
            connectedImages,
            connectedVideos,
            connectedAudios,
            promptText,
            activeChannel,
        });
    }, [effectiveProfile, connectedImages, connectedVideos, connectedAudios, promptText, activeChannel]);

    return (
        <Cascader
            value={cascaderValue}
            options={options}
            onChange={handleCascaderChange}
            expandTrigger="hover"
            // 允许只选到渠道那一级：换主机不该强制用户把模型再点一遍。
            changeOnSelect
            disabled={disabled}
            allowClear={false}
            popupClassName="canvas-model-picker-dropdown"
            className={`canvas-compact-control !h-8 !rounded-full !text-xs ${className}`}
            style={{
                background: theme.node.fill,
                borderColor: activeAvailability.isAvailable ? theme.node.stroke : "#f59e0b",
                color: theme.node.text,
            }}
            displayRender={() => (
                <div className="flex items-center gap-1.5 truncate max-w-[170px]">
                    {getModelIcon(effectiveProfile.id)}
                    <span className="font-semibold text-xs truncate">{effectiveProfile.name}</span>
                    {!activeAvailability.isAvailable && (
                        <Tooltip
                            title={
                                <div className="space-y-1 text-xs">
                                    <div className="font-semibold text-amber-300">当前不可用：</div>
                                    {activeAvailability.reasons.map((r, i) => (
                                        <div key={i} className="flex items-start gap-1">
                                            <span className="text-amber-400">•</span>
                                            <span>{r}</span>
                                        </div>
                                    ))}
                                </div>
                            }
                        >
                            <AlertTriangle className="size-3 text-amber-500 shrink-0" />
                        </Tooltip>
                    )}
                </div>
            )}
        />
    );
}
