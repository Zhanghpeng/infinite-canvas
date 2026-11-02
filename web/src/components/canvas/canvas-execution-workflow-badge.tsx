import { Tooltip } from "antd";
import { Workflow, X } from "lucide-react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { canvasThemes } from "@/lib/canvas-theme";
import { buildGenerationConfig } from "@/lib/canvas/canvas-generation-helpers";
import { resolveExecutionWorkflow, type ExecutionWorkflowSource } from "@/lib/canvas/workflow-resolution";
import { resolveChannelBoundWorkflow } from "@/services/api/comfyui";
import { modelOptionName, resolveModelChannel, useEffectiveConfig, type WorkflowCategory } from "@/stores/use-config-store";
import { useThemeStore } from "@/stores/use-theme-store";
import type { CanvasNodeData } from "@/types/canvas";

export type CanvasExecutionMode = "image" | "video" | "audio" | "text";

interface CanvasExecutionWorkflowBadgeProps {
    node: CanvasNodeData;
    mode: CanvasExecutionMode;
    imageCount: number;
    /** 节点上钉住的工作流与当前模型无关时，允许一键改回跟随模型 */
    onClearPinned: () => void;
}

const SOURCE_LABEL_KEY: Record<ExecutionWorkflowSource, string> = {
    pinned: "canvas.executionWorkflow.pinned",
    model: "canvas.executionWorkflow.model",
    channel: "canvas.executionWorkflow.channel",
    "channel-default": "canvas.executionWorkflow.channelDefault",
};

/**
 * 节点「实际会跑哪条工作流」。
 *
 * 选 Qwen 却跑 Z-Image 这类错配在界面上完全不可见，所以这里把执行结果摊开：
 *
 * - **跟随模型时只留一个图标**：绝大多数节点都是「执行流 = 所选模型的自带流」，把工作流名
 *   再抄一遍既占位置又和左侧选择器重复，还会把渠道/模型挤成「系…」「Qw…」。悬停能看到
 *   完整信息，不悬停也不误导。
 * - **只有真正偏离时才展开成胶囊**（节点指定 / 渠道绑定 / 渠道默认）：这才是用户需要
 *   知道、且需要能动手处理的三种情况。
 *
 * 判断用的输入必须与执行侧完全相同：模型走 buildGenerationConfig（含旧版 `metadata.model`
 * 与按能力回退），渠道绑定流走 resolveChannelBoundWorkflow。徽标自己另写一套判断，就会
 * 变成「界面说一套、实际跑一套」——正是它要解决的那个问题。
 */
export function CanvasExecutionWorkflowBadge({ node, mode, imageCount, onClearPinned }: CanvasExecutionWorkflowBadgeProps) {
    const { t } = useTranslation();
    const config = useEffectiveConfig();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];

    // 配音走「工作流 + 音色卡」，选择器里已经直接显示工作流名，这里再挂一枚徽标只会重复。
    const isVoiceNode = mode === "audio" && node.metadata?.audioKind === "voice";

    const built = useMemo(() => buildGenerationConfig(config, node, mode), [config, node, mode]);

    const modelId = mode === "image" ? built.imageModel : mode === "video" ? built.videoModel : mode === "text" ? built.textModel : built.audioModel;
    const requestModel = modelOptionName(modelId || "");
    const videoMode = built.videoMode === "frame" ? "frame" : "omni";

    const category: WorkflowCategory = mode === "image" ? (imageCount > 0 ? "i2i" : "t2i") : mode === "video" ? (videoMode === "frame" ? "frameVideo" : "omniVideo") : mode === "audio" ? "audio" : "text";

    const channel = useMemo(() => resolveModelChannel(built, requestModel || built.model || config.model), [built, requestModel, config.model]);

    const resolved = useMemo(() => {
        if (!channel || channel.apiFormat !== "comfyui") return undefined;
        return resolveExecutionWorkflow({
            config: built,
            channel,
            channelId: built.channelId || channel.id,
            workflowId: built.workflowId,
            modelId: requestModel,
            category,
            // 视频节点的 pin 可能指向 depthVideo / faceRefine 这类专用流，不能按分类过滤
            pinCategory: mode === "video" ? null : undefined,
            // 音频请求本身不看渠道绑定的流（只有 pin → 模型档案 → 渠道流列表），不要在此多算一层
            channelWorkflow: mode === "audio" ? undefined : resolveChannelBoundWorkflow(channel, requestModel, category),
        });
    }, [built, channel, requestModel, category, mode]);

    if (isVoiceNode || !channel || !resolved) return null;

    const isPinned = resolved.source === "pinned";
    const sourceLabel = t(SOURCE_LABEL_KEY[resolved.source]);

    const tooltip = (
        <div className="space-y-1 text-xs">
            <div className="font-semibold">
                {t("canvas.executionWorkflow.label")}：{resolved.name}
            </div>
            <div className="opacity-80">
                {channel.name} · {sourceLabel}
            </div>
            {resolved.source === "model" ? <div className="opacity-70">{t("canvas.executionWorkflow.matchesModel")}</div> : null}
            {isPinned ? <div className="text-amber-300">{t("canvas.executionWorkflow.pinnedHint")}</div> : null}
        </div>
    );

    // 跟随模型 = 没有偏差可看，只留一个可悬停的图标，不占横向空间。
    if (resolved.source === "model") {
        return (
            <Tooltip title={tooltip}>
                <button
                    type="button"
                    className="inline-flex size-8 shrink-0 cursor-help items-center justify-center rounded-full opacity-40 transition-opacity hover:opacity-80"
                    style={{ color: theme.node.text }}
                    aria-label={`${t("canvas.executionWorkflow.label")}：${resolved.name}`}
                >
                    <Workflow className="size-3.5" />
                </button>
            </Tooltip>
        );
    }

    return (
        <Tooltip title={tooltip}>
            <div
                className="inline-flex h-10 min-w-0 max-w-[180px] shrink items-center gap-1.5 rounded-full border px-2.5 text-xs"
                style={{ background: theme.node.fill, borderColor: isPinned ? "#f59e0b" : theme.node.stroke, color: theme.node.text }}
            >
                <Workflow className="size-3.5 shrink-0" style={{ color: isPinned ? "#f59e0b" : undefined }} />
                <span className="min-w-0 truncate">{resolved.name}</span>
                <span className="shrink-0 text-[10px] opacity-60">{sourceLabel}</span>
                {isPinned ? (
                    <button
                        type="button"
                        className="ml-0.5 inline-flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-full hover:bg-black/10"
                        title={t("canvas.executionWorkflow.clear")}
                        aria-label={t("canvas.executionWorkflow.clear")}
                        onClick={(event) => {
                            event.stopPropagation();
                            onClearPinned();
                        }}
                    >
                        <X className="size-3" />
                    </button>
                ) : null}
            </div>
        </Tooltip>
    );
}
