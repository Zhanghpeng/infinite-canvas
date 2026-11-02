import { Cascader, Tooltip } from "antd";
import { AlertTriangle, Film, HelpCircle, Music2, RotateCcw, ScanFace, Server, Sparkles, Workflow } from "lucide-react";
import { useEffect, useMemo } from "react";

import { evaluateModelAvailability, getModelProfile, type ModelAvailability, type WorkflowModelProfile } from "@/services/api/models";
import { getChannelWorkflows, useEffectiveConfig, type ComfyWorkflowItem, type ModelChannel, type WorkflowCategory } from "@/stores/use-config-store";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import { isChannelAvailable, type ChannelAvailabilityContext } from "@/lib/canvas/model-picker-channels";
import { resolveExecutionWorkflow, resolveProfileForWorkflowItem } from "@/lib/canvas/workflow-resolution";

export type CanvasNodeWorkflowSelection = {
    channelId: string;
    /** 由选中的那条流反推出来的模型档案 id —— 绑定规则必须跟着流走，不能沿用旧 modelId */
    modelId: string;
    profile: WorkflowModelProfile;
    /** 选中的工作流；`undefined` 表示「跟随配置里的默认流」 */
    workflow?: ComfyWorkflowItem;
};

export type CanvasNodeWorkflowPickerProps = {
    /**
     * 该节点允许的工作流分类。多分类时按传入顺序排布（视频：全能 → 首尾帧 → 人脸修复），
     * 每行带分类角标。
     */
    category: WorkflowCategory | WorkflowCategory[];
    channelId?: string;
    modelId?: string;
    workflowId?: string;
    /** 配置里标为默认的流是否压过模型档案，语义见 resolveExecutionWorkflow */
    respectChannelDefault?: boolean;
    /** 多分类时给每行加分类角标；单分类不必显示 */
    showCategoryBadge?: boolean;
    onChange: (selection: CanvasNodeWorkflowSelection) => void;
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

/** 分类 → 图标 + 短标签。标签用于多分类下的行内角标，必须短到不挤压流名。 */
const CATEGORY_META: Partial<Record<WorkflowCategory, { icon: React.ReactNode; label: string }>> = {
    t2i: { icon: <Workflow className="size-3.5 shrink-0 text-blue-500" />, label: "文生图" },
    i2i: { icon: <Workflow className="size-3.5 shrink-0 text-blue-500" />, label: "图生图" },
    inpaint: { icon: <Workflow className="size-3.5 shrink-0 text-blue-500" />, label: "局部重绘" },
    omniVideo: { icon: <Film className="size-3.5 shrink-0 text-emerald-500" />, label: "全能" },
    frameVideo: { icon: <Sparkles className="size-3.5 shrink-0 text-purple-500" />, label: "首尾帧" },
    faceRefine: { icon: <ScanFace className="size-3.5 shrink-0 text-pink-500" />, label: "人脸修复" },
    audio: { icon: <Music2 className="size-3.5 shrink-0 text-orange-500" />, label: "音频" },
    voice: { icon: <Music2 className="size-3.5 shrink-0 text-orange-500" />, label: "配音" },
    text: { icon: <Workflow className="size-3.5 shrink-0 text-emerald-500" />, label: "文本" },
};

function categoryMeta(category: WorkflowCategory) {
    return CATEGORY_META[category] || { icon: <Workflow className="size-3.5 shrink-0 text-blue-500" />, label: "" };
}

/**
 * 画布节点统一的「渠道 → 该渠道该分类的工作流」两级选择器。
 *
 * 四个节点（图像 / 视频 / 音频 / 文本）原来各有一份 `channels.map()` 包着写死的全局
 * 模型清单：展开后永远是同样四条内置模型，配置里那些自定义流（首尾帧 5 条、全能 7 条、
 * 反推提示词…）在节点上一条都看不到，名字也对不上 —— 看着像联动，实际只换了渠道高亮。
 *
 * 现在二级直接取 `getChannelWorkflows(channel, category)`，就是配置里那一批；选中即钉住
 * （`metadata.workflowId`），没钉住就跟随配置里标为默认的那条。展示值由
 * `resolveExecutionWorkflow` 算出 —— 与执行侧同一个函数、同一条优先级，所以「看到的流」
 * 和「实际跑的流」不可能再分叉。
 */
export function CanvasNodeWorkflowPicker({
    category,
    channelId,
    modelId,
    workflowId,
    respectChannelDefault = true,
    showCategoryBadge = false,
    onChange,
    className = "",
    disabled = false,
    connectedImages = 0,
    connectedVideos = 0,
    connectedAudios = 0,
    promptText = "",
}: CanvasNodeWorkflowPickerProps) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const config = useEffectiveConfig();

    const channels = useMemo(() => (config.channels && config.channels.length > 0 ? config.channels : [FALLBACK_CHANNEL]), [config.channels]);

    const activeChannel = useMemo(() => {
        return (channelId ? channels.find((c) => c.id === channelId) : null) || channels[0];
    }, [channels, channelId]);

    const availabilityContext = useMemo<ChannelAvailabilityContext>(
        () => ({ connectedImages, connectedVideos, connectedAudios, promptText }),
        [connectedImages, connectedVideos, connectedAudios, promptText],
    );

    const fallbackProfile = useMemo(() => getModelProfile(modelId), [modelId]);
    // 反推不出档案时的兜底：按第一个分类取内置档案（视频/音频/文本/图像都各有一条）。
    // 宁可放宽校验，也不能因为认不出流名就把这条流从列表里抹掉。
    const defaultProfile = useMemo(
        () => fallbackProfile || getModelProfile(Array.isArray(category) ? category[0] : category),
        [fallbackProfile, category],
    );

    const channelSummaries = useMemo<ChannelSummary[]>(() => {
        const order = Array.isArray(category) ? category : [category];
        return channels.map((channel) => {
            const list = getChannelWorkflows(channel, category);
            // 多分类按传入顺序排：全能在前、首尾帧其次，用户不用在一堆混排里找。
            const sorted = order.length > 1 ? [...list].sort((a, b) => order.indexOf(a.category) - order.indexOf(b.category)) : list;
            const entries: WorkflowEntry[] = [];
            for (const item of sorted) {
                const profile = resolveProfileForWorkflowItem(item, defaultProfile) || defaultProfile;
                if (!profile) continue;
                entries.push({
                    item,
                    profile,
                    availability: evaluateModelAvailability({ targetModel: profile, ...availabilityContext, activeChannel: channel }),
                });
            }
            return {
                channel,
                entries,
                selectableCount: entries.filter((entry) => entry.availability.isSelectable).length,
            };
        });
    }, [channels, category, availabilityContext, defaultProfile]);

    // 所有渠道都不可用时不再置灰，否则用户被锁死在当前渠道，连换主机自救都做不到。
    const hasSelectableChannel = channelSummaries.some((summary) => summary.selectableCount > 0);

    // 展示值与执行值同源：钉住 → 配置默认 → 模型档案 → 渠道绑定 → 渠道首项。
    const resolved = useMemo(
        () =>
            resolveExecutionWorkflow({
                config,
                channel: activeChannel,
                channelId: activeChannel.id,
                workflowId,
                modelId,
                category,
                respectChannelDefault,
            }),
        [config, activeChannel, workflowId, modelId, category, respectChannelDefault],
    );

    const activeProfile = resolved?.modelProfile || fallbackProfile || defaultProfile;
    const activeSummary = channelSummaries.find((summary) => summary.channel.id === activeChannel.id);
    // 只有「钉住的流」才算用户显式选择；跟随默认时不给假高亮（那一项本来就不在列表里也可能）。
    const activeEntry = workflowId ? activeSummary?.entries.find((entry) => entry.item.id === workflowId) : activeSummary?.entries.find((entry) => entry.item.id === resolved?.id);

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
                const meta = categoryMeta(item.category);

                return {
                    value: item.id,
                    disabled: isBlocked,
                    label: (
                        <div className={`flex items-center justify-between gap-2 py-0.5 min-w-[240px] ${isBlocked ? "opacity-60" : ""}`}>
                            <div className="flex min-w-0 items-center gap-1.5">
                                {meta.icon}
                                <span className="min-w-0 truncate font-medium text-xs" title={item.name}>
                                    {item.name}
                                </span>
                                {showCategoryBadge ? <span className="shrink-0 rounded px-1 text-[10px] text-stone-400 ring-1 ring-stone-300/30">{meta.label}</span> : null}
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
    }, [channelSummaries, hasSelectableChannel, showCategoryBadge]);

    const handleCascaderChange = (value: (string | number)[]) => {
        if (!value || value.length === 0) return;
        const selectedChannelId = String(value[0]);
        const channel = channels.find((item) => item.id === selectedChannelId) || activeChannel;
        const summary = channelSummaries.find((item) => item.channel.id === channel.id);

        // 只点到渠道那一级（changeOnSelect）：同一条流在新主机上也有就保留，没有就跟随新
        // 渠道的默认流 —— 换主机不该顺手把已经挑好的工作流换掉。
        if (value.length < 2) {
            const keep = summary?.entries.find((entry) => entry.item.id === workflowId);
            if (keep) {
                onChange({ channelId: channel.id, modelId: keep.profile.id, profile: keep.profile, workflow: keep.item });
                return;
            }
            const next = resolveExecutionWorkflow({ config, channel, channelId: channel.id, modelId, category, respectChannelDefault });
            const nextItem = next?.id ? summary?.entries.find((entry) => entry.item.id === next.id) : undefined;
            // 新渠道没有这类工作流时不要改动 —— 把 workflowId 写成空串执行侧会静默落到别的分类。
            if (!nextItem) return;
            onChange({ channelId: channel.id, modelId: nextItem.profile.id, profile: nextItem.profile, workflow: undefined });
            return;
        }

        const picked = summary?.entries.find((entry) => entry.item.id === String(value[1]));
        if (!picked) return;
        onChange({ channelId: channel.id, modelId: picked.profile.id, profile: picked.profile, workflow: picked.item });
    };

    // 节点上钉着的渠道被删除后，选择器会静默显示第一个渠道，而执行侧拿到的还是那个失效 id：
    // 看到的和实际跑的分叉。这里只纠正「引用不存在」，绝不按可用性改写用户已经做出的选择。
    useEffect(() => {
        if (!channelId || isChannelAvailable(channels, channelId)) return;
        const fallback = channelSummaries[0];
        if (!fallback) return;
        const target = fallback.entries.find((entry) => entry.availability.isSelectable) || fallback.entries[0];
        if (!target) return;
        onChange({ channelId: fallback.channel.id, modelId: target.profile.id, profile: target.profile, workflow: undefined });
    }, [channelId, channels, channelSummaries, onChange]);

    const activeAvailability = useMemo(() => {
        const target = activeEntry?.profile || activeProfile;
        if (!target) return { isAvailable: true, isSelectable: true, reasons: [], blockingReasons: [], warningReasons: [] };
        return evaluateModelAvailability({
            targetModel: target,
            ...availabilityContext,
            activeChannel,
        });
    }, [activeEntry, activeProfile, availabilityContext, activeChannel]);

    const handleClearPin = () => {
        const profile = activeProfile || activeEntry?.profile;
        if (!profile) return;
        onChange({ channelId: activeChannel.id, modelId: profile.id, profile, workflow: undefined });
    };

    const displayMeta = resolved?.category ? categoryMeta(resolved.category) : null;

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
                className="!h-10 !w-[268px] shrink-0"
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
                        {/* 渠道名与主机图标只在多渠道时才有信息量：单渠道下它永远不变，
                            省下的宽度全给工作流名（视频流名普遍长到 30 字符以上） */}
                        {channels.length > 1 ? (
                            <>
                                <Server className="size-3.5 shrink-0 text-blue-500 opacity-80" />
                                <span className="max-w-[56px] shrink-0 truncate font-medium opacity-85">{activeChannel.name || "ComfyUI"}</span>
                                <span className="shrink-0 opacity-30">/</span>
                            </>
                        ) : null}
                        {displayMeta?.icon}
                        <span className="min-w-0 flex-1 truncate font-medium" title={resolved?.name}>
                            {resolved?.name || "未配置工作流"}
                        </span>
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
