import { Sliders } from "lucide-react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";

import type { ComfyuiWorkflow, ComfyWorkflowItem } from "@/stores/use-config-store";

const BUILTIN_WORKFLOW_IDENTIFIERS = new Set([
    "t2i_z_image_turbo_api.json",
    "Z-Image-Turbo 文生图",
    "i2i_flux2_dev_api.json",
    "Flux2.Dev 图生图",
    "inpaint_qwen_image_api.json",
    "Qwen-Image 局部编辑",
    "text_qwen3_5_api.json",
    "Qwen-3.5 文本生成/反推",
    "video_minimax_h3_omni_fp8_20step_api.json",
    "MiniMax H3 全能参考 (FP8 20步)",
    "video_minimax_h3_omni_fp8_4step_pdmd_api.json",
    "minimax_h3_ref2v_4step_pdmd_api.json",
    "MiniMax H3 全能视频 (FP8 4步 PDMD)",
    "MiniMax H3 全能参考 (FP8 4步 PDMD)",
    "video_minimax_h3_omni_bf16_8step_turbo_api.json",
    "MiniMax H3 全能参考 (BF16 8步极速)",
    "video_minimax_h3_omni_bf16_20step_api.json",
    "minimax_h3_ref2va_bf16_20step_api.json",
    "MiniMax H3 全能参考 (BF16 20步)",
    "MiniMax H3 全能视频 (BF16 20步)",
    "video_minimax_h3_frame_fp8_20step_api.json",
    "MiniMax H3 首尾帧 (FP8 20步)",
    "video_minimax_h3_frame_fp8_4step_pdmd_api.json",
    "minimax_h3_fl2va_fp8_4step_pdmd_api.json",
    "MiniMax H3 首尾帧视频 (FP8 4步 PDMD)",
    "MiniMax H3 首尾帧 (FP8 4步 PDMD)",
    "video_minimax_h3_frame_bf16_8step_turbo_api.json",
    "MiniMax H3 首尾帧 (BF16 8步极速)",
    "video_minimax_h3_frame_bf16_20step_api.json",
    "minimax_h3_fl2va_bf16_20step_api.json",
    "MiniMax H3 首尾帧 (BF16 20步)",
    "MiniMax H3 首尾帧视频 (BF16 20步)",
    "qwen_image_21_api.json",
    "Qwen-Image-2.1 文生图",
    "Qwen-Image-2.1 多图参考图生图",
    "Qwen-Image-2.1 全能生图",
]);

/**
 * Displays attached ComfyUI workflow information (built-in or custom).
 */
export function ComfyuiWorkflowEditor({
    channelId,
    workflowId,
    value,
    defaultWorkflow,
    isBuiltin,
}: {
    channelId?: string;
    workflowId?: string;
    value?: ComfyuiWorkflow | ComfyWorkflowItem;
    defaultWorkflow?: ComfyuiWorkflow | ComfyWorkflowItem;
    isBuiltin?: boolean;
    onChange?: (value?: ComfyuiWorkflow) => void;
}) {
    const { t } = useTranslation();

    const isCustom = (() => {
        if (typeof isBuiltin === "boolean") {
            return !isBuiltin;
        }
        if (value && "isBuiltin" in value && typeof value.isBuiltin === "boolean") {
            return !value.isBuiltin;
        }
        if (!value || value === defaultWorkflow) {
            return false;
        }
        if (value.name && BUILTIN_WORKFLOW_IDENTIFIERS.has(value.name)) {
            return false;
        }
        if (defaultWorkflow && value.name === defaultWorkflow.name) {
            return false;
        }
        return true;
    })();
    const activeWorkflow = value || defaultWorkflow;

    return (
        <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0 flex-1 truncate text-sm text-stone-500" title={activeWorkflow?.name}>
                {activeWorkflow ? (
                    <span className="flex items-center gap-1.5">
                        <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium ${isCustom ? "bg-amber-100 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300" : "bg-blue-100 text-blue-800 dark:bg-blue-950/50 dark:text-blue-300"}`}>
                            {isCustom ? t("comfyui.customWorkflow") : t("comfyui.defaultBuiltin")}
                        </span>
                        <span className="truncate">{activeWorkflow.name} · {formatWorkflowSize(activeWorkflow.json)}</span>
                    </span>
                ) : (
                    t("comfyui.noWorkflowAttached")
                )}
            </div>
            {channelId && activeWorkflow && (
                <Link
                    to={`/config/workflows/${encodeURIComponent(channelId)}/${encodeURIComponent(workflowId || activeWorkflow.name)}`}
                    className="inline-flex items-center gap-1.5 rounded border border-stone-200/80 bg-white px-2 py-1 text-xs font-medium text-stone-700 shadow-xs transition hover:bg-stone-50 dark:border-stone-700 dark:bg-stone-800 dark:text-stone-200 dark:hover:bg-stone-750"
                    title="配置与编辑工作流参数"
                >
                    <Sliders className="size-3 text-stone-500" />
                    <span>配置工作流</span>
                </Link>
            )}
        </div>
    );
}

function formatWorkflowSize(json: Record<string, unknown>) {
    const bytes = JSON.stringify(json).length;
    return bytes < 1024 ? `${bytes}B` : `${(bytes / 1024).toFixed(1)}KB`;
}
