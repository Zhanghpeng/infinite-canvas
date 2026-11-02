import { Tooltip } from "antd";
import { Workflow } from "lucide-react";
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
}

const SOURCE_LABEL_KEY: Record<ExecutionWorkflowSource, string> = {
    pinned: "canvas.executionWorkflow.pinned",
    model: "canvas.executionWorkflow.model",
    channel: "canvas.executionWorkflow.channel",
    "channel-default": "canvas.executionWorkflow.channelDefault",
};

/**
 * 节点「实际会跑哪条工作流」的状态指示。
 *
 * 四个节点的选择器现在直接显示工作流名（二级就是该渠道该分类的流），所以徽标不再重复
 * 显示流名 —— 只保留「这条流是不是跟随配置默认」这一个信号：
 *
 * - 跟随配置默认 / 模型档案：灰色图标
 * - 节点指定（pinned）/ 渠道绑定：琥珀色图标，提示换模型或改配置不会改变它
 *
 * 完整信息（流名、渠道、来源）在悬停里。判断用的输入必须与执行侧完全相同：模型走
 * buildGenerationConfig（含旧版 `metadata.model` 与按能力回退），渠道绑定流走
 * resolveChannelBoundWorkflow —— 徽标自己另写一套判断就会变成「界面说一套、实际跑一套」。
 */
export function CanvasExecutionWorkflowBadge({ node, mode, imageCount }: CanvasExecutionWorkflowBadgeProps) {
    const { t } = useTranslation();
    const config = useEffectiveConfig();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];

    // 配音走「工作流 + 音色卡」，选择器里已经直接显示工作流名称，这里再挂徽标只会重复。
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
            // 与执行侧同一步：选择器里列的就是配置里的流，默认标记要生效
            respectChannelDefault: true,
            channelWorkflow: mode === "audio" ? undefined : resolveChannelBoundWorkflow(channel, requestModel, category),
        });
    }, [built, channel, requestModel, category, mode]);

    if (isVoiceNode || !channel || !resolved) return null;

    const isPinned = resolved.source === "pinned";
    const isDetached = isPinned || resolved.source === "channel";
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

    return (
        <Tooltip title={tooltip}>
            <span
                className="inline-flex size-8 shrink-0 cursor-help items-center justify-center rounded-full transition-opacity hover:opacity-90"
                style={{ color: isDetached ? "#f59e0b" : theme.node.text, opacity: isDetached ? 0.95 : 0.4 }}
                aria-label={`${t("canvas.executionWorkflow.label")}：${resolved.name}（${sourceLabel}）`}
            >
                <Workflow className="size-3.5" />
            </span>
        </Tooltip>
    );
}
