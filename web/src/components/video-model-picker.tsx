import type { WorkflowModelProfile } from "@/services/api/models";
import type { ComfyWorkflowItem, WorkflowCategory } from "@/stores/use-config-store";

import { CanvasNodeWorkflowPicker } from "@/components/canvas/canvas-node-workflow-picker";

export type VideoModelPickerProps = {
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
 * 视频节点可用的工作流分类。
 *
 * 三类一起列：全能参考视频、首尾帧视频、人脸修复。原来二级是写死的 4 条内置视频模型，
 * 配置里那 7 条全能 + 5 条首尾帧自定义流在节点上一条都看不到 —— 这就是「自定义配置的
 * 看不见了」。分类角标让用户知道选中后会在哪种模式下跑（首尾帧 vs 全能）。
 *
 * 模块级常量：作为 prop 传给选择器时引用必须稳定，否则每次渲染都会让内部 memo 失效。
 */
const VIDEO_NODE_CATEGORIES: WorkflowCategory[] = ["omniVideo", "frameVideo", "faceRefine"];

/**
 * 视频节点的「渠道 → 工作流」两级选择。
 *
 * 与图像节点共用同一个选择器与同一套解析：二级列的是该渠道该分类的工作流，选中即钉住，
 * 没钉住就跟随配置里标为默认的那条。
 */
export function VideoModelPicker({ channelId, modelId, workflowId, onChange, ...rest }: VideoModelPickerProps) {
    return (
        <CanvasNodeWorkflowPicker
            category={VIDEO_NODE_CATEGORIES}
            showCategoryBadge
            channelId={channelId}
            modelId={modelId}
            workflowId={workflowId}
            onChange={(selection) => onChange(selection.channelId, selection.modelId, selection.profile, selection.workflow)}
            {...rest}
        />
    );
}
