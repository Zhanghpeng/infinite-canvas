import type { WorkflowModelProfile } from "@/services/api/models";
import type { ComfyWorkflowItem } from "@/stores/use-config-store";

import { CanvasNodeWorkflowPicker } from "@/components/canvas/canvas-node-workflow-picker";

export type ImageModelPickerProps = {
    channelId?: string;
    modelId?: string;
    /** 节点上钉住的工作流；不传表示跟随配置里标为默认的那条 */
    workflowId?: string;
    onChange: (channelId: string, modelId: string, profile: WorkflowModelProfile, workflow?: ComfyWorkflowItem) => void;
    className?: string;
    disabled?: boolean;
    connectedImages?: number;
    connectedVideos?: number;
    connectedAudios?: number;
    promptText?: string;
};

/**
 * 图像节点的「渠道 → 工作流」两级选择。
 *
 * 分类跟着连线走：接了参考图就是图生图，否则文生图。执行侧 `requestComfyuiImage` 也是
 * 用 references 数量判的，两边必须同一口径，否则列出来的流和执行选中的流不是一批。
 */
export function ImageModelPicker({ channelId, modelId, workflowId, onChange, connectedImages = 0, ...rest }: ImageModelPickerProps) {
    return (
        <CanvasNodeWorkflowPicker
            category={connectedImages > 0 ? "i2i" : "t2i"}
            channelId={channelId}
            modelId={modelId}
            workflowId={workflowId}
            connectedImages={connectedImages}
            onChange={(selection) => onChange(selection.channelId, selection.modelId, selection.profile, selection.workflow)}
            {...rest}
        />
    );
}
