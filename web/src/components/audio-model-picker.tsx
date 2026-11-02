import type { WorkflowModelProfile } from "@/services/api/models";
import type { ComfyWorkflowItem } from "@/stores/use-config-store";

import { CanvasNodeWorkflowPicker } from "@/components/canvas/canvas-node-workflow-picker";

export type AudioModelPickerProps = {
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
 * 配乐节点的「渠道 → 工作流」两级选择。
 *
 * 只处理 music 产线（audio 分类）；配音（voice）走 ChannelWorkflowPicker + 音色卡。
 * 两条产线的分类必须严格分开，否则会拿配乐流去配音 —— 产物类型对、内容荒谬。
 */
export function AudioModelPicker({ channelId, modelId, workflowId, onChange, ...rest }: AudioModelPickerProps) {
    return (
        <CanvasNodeWorkflowPicker
            category="audio"
            channelId={channelId}
            modelId={modelId}
            workflowId={workflowId}
            onChange={(selection) => onChange(selection.channelId, selection.modelId, selection.profile, selection.workflow)}
            {...rest}
        />
    );
}
