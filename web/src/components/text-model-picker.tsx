import type { WorkflowModelProfile } from "@/services/api/models";
import type { ComfyWorkflowItem } from "@/stores/use-config-store";

import { CanvasNodeWorkflowPicker } from "@/components/canvas/canvas-node-workflow-picker";

export type TextModelPickerProps = {
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
 * 文本节点的「渠道 → 工作流」两级选择。
 *
 * 二级是该渠道的 text 分类工作流（含自定义的「反推提示词」这类流），不再是一份写死的
 * 全局文本模型清单 —— 配置里改了文本流，节点上立刻能看到并选中。
 */
export function TextModelPicker({ channelId, modelId, workflowId, onChange, ...rest }: TextModelPickerProps) {
    return (
        <CanvasNodeWorkflowPicker
            category="text"
            channelId={channelId}
            modelId={modelId}
            workflowId={workflowId}
            onChange={(selection) => onChange(selection.channelId, selection.modelId, selection.profile, selection.workflow)}
            {...rest}
        />
    );
}
