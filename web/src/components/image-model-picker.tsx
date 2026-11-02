import { Cascader, Tooltip } from "antd";
import { AlertTriangle, HelpCircle, RotateCcw, Server, Workflow } from "lucide-react";
import { useEffect, useMemo } from "react";

import { evaluateModelAvailability, getModelProfile, imageQwen21Profile, type ModelAvailability, type WorkflowModelProfile } from "@/services/api/models";
import { getChannelWorkflows, useEffectiveConfig, type ComfyWorkflowItem, type ModelChannel, type WorkflowCategory } from "@/stores/use-config-store";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import { isChannelAvailable, type ChannelAvailabilityContext } from "@/lib/canvas/model-picker-channels";
import { resolveExecutionWorkflow, resolveProfileForWorkflowItem } from "@/lib/canvas/workflow-resolution";

export type ImageModelPickerProps = {
    channelId?: string;
    modelId?: string;
    /**
     * 节点上钉住的工作流。不传表示「跟随配置」：执行侧会用该渠道该分类里被标为
     * 默认的那条流。
     */
    workflowId?: string;
    onChange: (channelId: string, modelId: string, profile: WorkflowModelProfile, workflow?: ComfyWorkflowItem) => void;
    className?: string;
    disabled?: boolean;
    connectedImages?: number;
    connectedVideos?: number;
    connectedAudios?: number;
    promptText?: string;
};

type WorkflowEntry = {
    item: ComfyWorkflowItem;
    profile: WorkflowModelProfile;
    availability: ModelAvailability;
};

type ChannelSummary = {
    channel: ModelChannel;
    entries: WorkflowEntry[];
    selectableCount: number;
};

const FALLBACK_CHANNEL: ModelChannel = {
    id: "builtin",
    name: "系统内置 ComfyUI",
    baseUrl: "http://127.0.0.1:8188",
    apiKey: "",
    apiFormat: "comfyui",
    models: [],
};

/**
 * 图像节点的「渠道 → 工作流」两级选择。
 *
 * 二级原来是一份写死的全局模型清单（`BUILTIN_IMAGE_WORKFLOW_MODELS`），跟渠道毫无关系：
 * 三个渠道展开都是同样四条模型，配置里那些自定义流（6-9 宫格、图像编辑…）永远选不到，
 * 名字也和配置里的对不上 —— 看起来像联动，实际只是在换一级高亮。
 *
 * 现在二级直接取该渠道该分类的工作流，选中即钉住（`metadata.workflowId`）；没钉住就跟随
 * 配置里标为默认的那条。展示值由 `resolveExecutionWorkflow` 算出，与执行侧同一个函数，
 * 所以「看到的」和「实际跑的」不可能再分叉。
 */
export function ImageModelPicker({
    channelId,
    modelId,
    workflowId,
    onChange,
    className = "",
    disabled = false,
    connectedImages = 0,
    connectedVideos = 0,
    connectedAudios = 0,
    promptText = "",
}: ImageModelPickerProps) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const config = useEffectiveConfig();

    const channels = useMemo(() => (config.channels && config.channels.length > 0 ? config.channels : [FALLBACK_CHANNEL]), [config.channels]);

    const activeChannel = useMemo(() => {
        return (channelId ? channels.find((c) => c.id === channelId) : null) || channels[0];
    }, [channels, channelId]);

    // 分类跟着连线走：接了参考图就是图生图，否则文生图。执行侧 requestComfyuiImage 也是
    // 用 references 数量判的，两边必须同一口径，否则列出来的流和执行选中的流不是一批。
    const category: WorkflowCategory = connectedImages > 0 ? "i2i" : "t2i";

    const availabilityContext = useMemo<ChannelAvailabilityContext>(
        () => ({ connectedImages, connectedVideos, connectedAudios, promptText }),
        [connectedImages, connectedVideos, connectedAudios, promptText],
    );

    const channelSummaries = useMemo<ChannelSummary[]>(() => {
        return channels.map((channel) => {
            const entries: WorkflowEntry[] = getChannelWorkflows(channel, category).map((item) => {
                const profile = resolveProfileForWorkflowItem(item) || getModelProfile(modelId) || imageQwen21Profile;
                return {
                    item,
                    profile,
                    availability: evaluateModelAvailability({ targetModel: profile, ...availabilityContext, activeChannel: channel }),
                };
            });
            return {
                channel,
                entries,
                selectableCount: entries.filter((entry) => entry.availability.isSelectable).length,
            };
        });
    }, [channels, category, availabilityContext, modelId]);

    // 所有渠道都不可用时不再置灰，否则用户被锁死在当前渠道，连换主机自救都做不到。
    const hasSelectableChannel = channelSummaries.some((summary) => summary.selectableCount > 0);

    // 演示值与执行值同源：pin → 配置默认 → 模型档案 → 渠道绑定 → 渠道默认。
    const resolved = useMemo(
        () =>
            resolveExecutionWorkflow({
                config,
                channel: activeChannel,
                channelId: activeChannel.id,
                workflowId,
                modelId,
                category,
                respectChannelDefault: true,
            }),
        [config, activeChannel, workflowId, modelId, category],
    );

    const activeProfile = resolved?.modelProfile || getModelProfile(modelId) || imageQwen21Profile;
    const activeSummary = channelSummaries.find((summary) => summary.channel.id === activeChannel.id);
    const activeEntry = activeSummary?.entries.find((entry) => entry.item.id === resolved?.id);

    const cascaderValue = useMemo(() => {
        return activeEntry ? [activeChannel.id, activeEntry.item.id] : [activeChannel.id];
    }, [activeChannel.id, activeEntry]);

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
                        title={`${summary.selectableCount}/${summary.entries.length} 条工作流可切换`}
                    >
                        {summary.selectableCount}/{summary.entries.length}
                    </span>
                </div>
            ),
            children: summary.entries.map(({ item, availability }) => {
                const isBlocked = !availability.isSelectable;
                const needsInputs = availability.isSelectable && !availability.isAvailable;

                return {
                    value: item.id,
                    disabled: isBlocked,
                    label: (
                        <div className={`flex items-center justify-between gap-2 py-0.5 min-w-[220px] ${isBlocked ? "opacity-60" : ""}`}>
                            <div className="flex items-center gap-1.5 truncate">
                                <Workflow className="size-3.5 shrink-0 text-blue-500" />
                                <span className="font-medium text-xs truncate">{item.name}</span>
                                {item.isDefault ? <span className="shrink-0 text-[10px] text-stone-400">·默认</span> : null}
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
                };
            }),
        }));
    }, [channelSummaries, hasSelectableChannel]);

    const handleCascaderChange = (value: (string | number)[]) => {
        if (!value || value.length === 0) return;
        const selectedChannelId = String(value[0]);
        const channel = channels.find((item) => item.id === selectedChannelId) || activeChannel;
        const summary = channelSummaries.find((item) => item.channel.id === channel.id);

        // 只点到渠道那一级（changeOnSelect）：同一个工作流在多台主机上都有就保留，
        // 没有就跟随新渠道的默认流——换主机不该顺手把已经挑好的工作流换掉。
        if (value.length < 2) {
            const keep = summary?.entries.find((entry) => entry.item.id === resolved?.id);
            if (keep) {
                onChange(channel.id, keep.profile.id, keep.profile, keep.item);
                return;
            }
            const next = resolveExecutionWorkflow({ config, channel, channelId: channel.id, modelId, category, respectChannelDefault: true });
            if (!next) return;
            onChange(channel.id, next.modelProfile?.id || activeProfile.id, next.modelProfile || activeProfile, undefined);
            return;
        }

        const picked = summary?.entries.find((entry) => entry.item.id === String(value[1]));
        if (!picked) return;
        onChange(channel.id, picked.profile.id, picked.profile, picked.item);
    };

    // 节点上钉着的渠道被删除后，选择器会静默显示第一个渠道，而执行侧拿到的还是那个失效 id：
    // 看到的和实际跑的分叉。这里只纠正「引用不存在」，绝不按可用性改写用户已经做出的选择。
    useEffect(() => {
        if (!channelId || isChannelAvailable(channels, channelId)) return;
        const fallback = channelSummaries[0];
        if (!fallback) return;
        const target = fallback.entries.find((entry) => entry.availability.isSelectable) || fallback.entries[0];
        if (!target) return;
        onChange(fallback.channel.id, target.profile.id, target.profile, undefined);
    }, [channelId, channels, channelSummaries, onChange]);

    const activeAvailability = useMemo(() => {
        return evaluateModelAvailability({
            targetModel: activeEntry?.profile || activeProfile,
            ...availabilityContext,
            activeChannel,
        });
    }, [activeEntry, activeProfile, availabilityContext, activeChannel]);

    const handleClearPin = () => {
        onChange(activeChannel.id, activeProfile.id, activeProfile, undefined);
    };

    return (
        <div className={`flex min-w-0 items-center gap-1 ${className}`}>
            <Cascader
                value={cascaderValue}
                options={options}
                onChange={handleCascaderChange}
                expandTrigger="hover"
                // 允许只选到渠道那一级：换主机不该强制用户把工作流再点一遍。
                changeOnSelect
                allowClear={false}
                disabled={disabled}
                // 固定宽度：antd 的 Cascader 宽度由内容撑，内容里带 truncate 就会一路缩到
                // 「系…」「Qw…」。渠道与工作流名必须各自有确定的空间。
                className="!h-10 !w-[240px] shrink-0"
                styles={{
                    root: {
                        background: "transparent",
                        color: theme.node.text,
                        height: "40px",
                    },
                }}
                // 不用 antd 解析出来的 label：工作流可能不在当前渠道列表里（例如配置被改过），
                // 那时 antd 会渲染成空白，而执行侧照样会跑它 —— 显示的必须是我们算出来的那一条。
                displayRender={() => (
                    <div className="flex w-full min-w-0 items-center gap-1.5 text-xs">
                        <Server className="size-3.5 shrink-0 text-blue-500 opacity-80" />
                        {/* 只有一个渠道时渠道名是纯噪声（它永远不变），省下的宽度全给工作流名 */}
                        {channels.length > 1 ? (
                            <>
                                <span className="max-w-[56px] shrink-0 truncate font-medium opacity-85">{activeChannel.name || "ComfyUI"}</span>
                                <span className="shrink-0 opacity-30">/</span>
                            </>
                        ) : null}
                        <Workflow className="size-3.5 shrink-0 text-blue-500 opacity-80" />
                        <span className="min-w-0 flex-1 truncate font-medium">{resolved?.name || "未配置工作流"}</span>
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
                                <span className="flex items-center gap-0.5 text-[10px] text-amber-500 font-medium shrink-0 cursor-help">
                                    <AlertTriangle className="size-3" />
                                    <HelpCircle className="size-3" />
                                </span>
                            </Tooltip>
                        )}
                    </div>
                )}
            />
            {workflowId ? (
                <Tooltip title="改回跟随配置里的默认工作流">
                    <button
                        type="button"
                        className="inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-full opacity-50 transition-opacity hover:opacity-90"
                        style={{ color: theme.node.text }}
                        aria-label="改回跟随配置里的默认工作流"
                        onClick={(event) => {
                            event.stopPropagation();
                            handleClearPin();
                        }}
                    >
                        <RotateCcw className="size-3" />
                    </button>
                </Tooltip>
            ) : null}
        </div>
    );
}
