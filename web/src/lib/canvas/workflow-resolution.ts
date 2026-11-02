import {
    findWorkflow,
    getDefaultWorkflow,
    modelOptionName,
    type AiConfig,
    type ComfyuiWorkflow,
    type ComfyWorkflowItem,
    type ModelChannel,
    type WorkflowCategory,
} from "@/stores/use-config-store";
import { getModelProfile, type WorkflowModelProfile } from "@/services/api/models";
import { getWorkflowForModelProfile } from "@/services/api/comfyui-default-workflows";

/**
 * 一条 ComfyUI 请求最终跑的是哪个工作流。
 *
 * - `pinned`：节点/请求显式指定了 workflowId
 * - `model`：由模型档案决定（模型选择器的主语义）
 * - `channel`：渠道里绑在模型/分类上的自定义流
 * - `channel-default`：渠道该分类的默认流
 */
export type ExecutionWorkflowSource = "pinned" | "model" | "channel" | "channel-default";

export interface ExecutionWorkflow {
    json: Record<string, unknown>;
    /** 展示用名称（模型档案流用模型名，渠道流用工作流名） */
    name: string;
    source: ExecutionWorkflowSource;
    id?: string;
    category?: WorkflowCategory;
    /** 模型档案解析结果，调用方仍需它做参数校验 */
    modelProfile?: WorkflowModelProfile;
}

export interface ResolveExecutionWorkflowArgs {
    config: AiConfig;
    channel?: ModelChannel | null;
    channelId?: string;
    /** 显式指定的工作流 id */
    workflowId?: string;
    /** 模型 id 或渠道编码模型名（`channelId::model`） */
    modelId?: string;
    category?: WorkflowCategory | WorkflowCategory[];
    /**
     * 查找显式 pin 时的分类限制。默认与 `category` 相同；传 `null` 表示不限分类
     * （视频节点的 pin 可能指向 depthVideo / faceRefine 这类专用流，不能按
     * omniVideo / frameVideo 过滤，否则会静默退回普通视频流）。
     */
    pinCategory?: WorkflowCategory | WorkflowCategory[] | null;
    /** 渠道里绑在模型上的自定义流，优先级介于模型档案与渠道默认流之间 */
    channelWorkflow?: ComfyuiWorkflow;
    channelWorkflowName?: string;
}

/**
 * 统一解析工作流来源。
 *
 * 优先级：显式 pin → 模型档案 → 渠道自定义流 → 渠道默认流。
 *
 * **渠道默认流必须排在模型档案之后**：原来视频/图像/文本把「渠道该分类的默认流」
 * 放在了第一优先级，于是节点上选了模型也照样跑渠道默认流（选 Z-Image-Turbo 实际跑的
 * 是默认的 Qwen 流），模型选择器等于失效。音频那条链路一直是正确顺序，此处对齐它。
 */
export function resolveExecutionWorkflow({
    config,
    channel,
    channelId,
    workflowId,
    modelId,
    category,
    pinCategory,
    channelWorkflow,
    channelWorkflowName,
}: ResolveExecutionWorkflowArgs): ExecutionWorkflow | undefined {
    const profile = getModelProfile(modelId ? modelOptionName(modelId) : undefined);

    // 显式 pin 只有在「当前渠道 + 该分类」里确实存在时才生效。
    // 注意 findWorkflow 找不到时会**返回该分类的默认流**而不是 undefined —— 直接拿它
    // 当命中，就等于用默认流悄悄顶掉模型（pin 明明指向别处）。所以必须校验 id 真的
    // 对上了：id 不等说明这条 pin 属于别的分类或别的渠道，丢弃后回落到模型。
    const pinScope = pinCategory === undefined ? category : pinCategory ?? undefined;
    const pinnedItem = workflowId ? findWorkflow(config, channelId ?? channel?.id, workflowId, pinScope) : undefined;
    if (pinnedItem && pinnedItem.id === workflowId) {
        return toExecutionWorkflow(pinnedItem, "pinned", profile);
    }

    if (profile) {
        const profileWorkflow = getWorkflowForModelProfile(profile.id);
        if (profileWorkflow) {
            return {
                json: profileWorkflow.json,
                name: profile.name,
                id: profile.id,
                category: profile.category,
                source: "model",
                modelProfile: profile,
            };
        }
    }

    if (channelWorkflow) {
        return {
            json: channelWorkflow.json,
            name: channelWorkflowName || channelWorkflow.name || channel?.name || "",
            source: "channel",
            modelProfile: profile,
        };
    }

    // 渠道默认流只在「渠道确实配过工作流列表」时才兜底。内置清单是给界面列候选用的，
    // 不是执行默认值：拿它替没配过流的渠道凭空跑一套内置模板，只会在主机上撞出
    // 一堆缺节点的报错，把「没配置」变成一句看不懂的 ComfyUI 错误。
    const channelDefault = channel && Array.isArray(channel.workflows) ? getDefaultWorkflow(channel, category) : undefined;
    if (channelDefault) {
        return toExecutionWorkflow(channelDefault, "channel-default", profile);
    }

    return undefined;
}

function toExecutionWorkflow(item: ComfyWorkflowItem, source: ExecutionWorkflowSource, profile?: WorkflowModelProfile): ExecutionWorkflow {
    return {
        json: item.json,
        name: item.name,
        id: item.id,
        category: item.category,
        source,
        modelProfile: profile,
    };
}

/** 来源的展示文案（供 Tooltip / 徽标使用） */
export function executionWorkflowSourceLabelKey(source: ExecutionWorkflowSource): string {
    switch (source) {
        case "pinned":
            return "canvas.executionWorkflow.pinned";
        case "model":
            return "canvas.executionWorkflow.model";
        case "channel":
            return "canvas.executionWorkflow.channel";
        default:
            return "canvas.executionWorkflow.channelDefault";
    }
}
