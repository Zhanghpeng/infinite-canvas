import { Tooltip } from "antd";
import { Workflow, X } from "lucide-react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { canvasThemes } from "@/lib/canvas-theme";
import { resolveExecutionWorkflow, type ExecutionWorkflowSource } from "@/lib/canvas/workflow-resolution";
import { resolveModelChannel, useEffectiveConfig, type WorkflowCategory } from "@/stores/use-config-store";
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
 * 节点上原本只能看到模型，看不到这条模型最终落到哪条流上 —— 选 Qwen 却跑 Z-Image
 * 这类错配完全不可见。这里用与执行侧同一个解析函数（resolveExecutionWorkflow）
 * 展示结果与来源，来源为「节点指定」时给出一键解除，避免残留 pin 静默压掉模型。
 */
export function CanvasExecutionWorkflowBadge({ node, mode, imageCount, onClearPinned }: CanvasExecutionWorkflowBadgeProps) {
    const { t } = useTranslation();
    const config = useEffectiveConfig();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const audioKind = node.metadata?.audioKind === "voice" ? "voice" : "music";
    const videoMode = node.metadata?.videoMode === "frame" || config.videoMode === "frame" ? "frame" : "omni";

    const modelId = useMemo(() => {
        if (mode === "image") return node.metadata?.modelId || config.imageModel || "image-qwen-2.1";
        if (mode === "video") return node.metadata?.modelId || (videoMode === "frame" ? "frame-video-minimax-h3-fp8-4step-pdmd" : "omni-video-minimax-h3-fp8-4step-pdmd");
        if (mode === "text") return node.metadata?.modelId || config.textModel || "text-qwen-35";
        // 配音走工作流 + 音色卡，没有模型选择
        return audioKind === "voice" ? undefined : node.metadata?.modelId || "audio-minimax-music-3";
    }, [mode, node.metadata?.modelId, videoMode, config.imageModel, config.textModel, audioKind]);

    const category: WorkflowCategory =
        mode === "image" ? (imageCount > 0 ? "i2i" : "t2i") : mode === "video" ? (videoMode === "frame" ? "frameVideo" : "omniVideo") : mode === "audio" ? (audioKind === "voice" ? "voice" : "audio") : "text";

    const channel = useMemo(() => {
        const explicit = config.channels?.find((item) => item.id === (node.metadata?.channelId || config.channelId));
        return explicit || resolveModelChannel(config, modelId || config.model);
    }, [config, node.metadata?.channelId, modelId]);

    const resolved = useMemo(() => {
        if (!channel) return undefined;
        return resolveExecutionWorkflow({
            config,
            channel,
            channelId: channel.id,
            workflowId: node.metadata?.workflowId,
            modelId,
            category,
            // 视频节点的 pin 可能指向 depthVideo / faceRefine 这类专用流，不能按分类过滤
            pinCategory: mode === "video" ? null : undefined,
        });
    }, [config, channel, node.metadata?.workflowId, modelId, category, mode]);

    if (!channel || channel.apiFormat !== "comfyui" || !resolved) return null;

    const isPinned = resolved.source === "pinned";

    return (
        <Tooltip
            title={
                <div className="space-y-1 text-xs">
                    <div className="font-semibold">
                        {t("canvas.executionWorkflow.label")}：{resolved.name}
                    </div>
                    <div className="opacity-80">
                        {channel.name} · {t(SOURCE_LABEL_KEY[resolved.source])}
                    </div>
                    {isPinned ? <div className="text-amber-300">{t("canvas.executionWorkflow.pinnedHint")}</div> : null}
                </div>
            }
        >
            <div
                className="inline-flex h-10 min-w-0 max-w-[220px] shrink-0 items-center gap-1.5 rounded-full border px-3 text-xs"
                style={{ background: theme.node.fill, borderColor: isPinned ? "#f59e0b" : theme.node.stroke, color: theme.node.text }}
            >
                <Workflow className="size-3.5 shrink-0 opacity-70" />
                <span className="truncate">{resolved.name}</span>
                <span className="shrink-0 opacity-60">{t(SOURCE_LABEL_KEY[resolved.source])}</span>
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
