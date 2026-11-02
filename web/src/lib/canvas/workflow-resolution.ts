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
import {
    getModelProfile,
    imageFlux2DevProfile,
    imageQwen21Profile,
    imageQwenInpaintProfile,
    imageZTurboProfile,
    type WorkflowModelProfile,
} from "@/services/api/models";
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
    /**
     * 渠道里被「设为默认」的流是否压过模型档案。
     *
     * 图像节点现在直接选工作流（一级渠道 / 二级该渠道的工作流），界面上看到的就是
     * 渠道配置里的那一条 —— 此时如果执行侧还让模型档案插队，界面与执行又会分叉。
     * 只有真的标了 `isDefault` 的项才算数，`list[0]` 兜底不算：历史上「列表第一条」
     * 正是把 Qwen 顶成 Z-Image 的元凶。
     */
    respectChannelDefault?: boolean;
    /** 渠道里绑在模型上的自定义流，优先级介于模型档案与渠道默认流之间 */
    channelWorkflow?: ComfyuiWorkflow;
    channelWorkflowName?: string;
}

/**
 * 统一解析工作流来源。
 *
 * 默认优先级：显式 pin → 模型档案 → 渠道自定义流 → 渠道默认流。
 *
 * **渠道默认流默认排在模型档案之后**：原来视频/图像/文本把「渠道该分类的默认流」
 * 放在了第一优先级，于是节点上选了模型也照样跑渠道默认流（选 Z-Image-Turbo 实际跑的
 * 是默认的 Qwen 流），模型选择器等于失效。音频那条链路一直是正确顺序，此处对齐它。
 *
 * 图像节点改成「二级直接列该渠道的工作流」后，传入 `respectChannelDefault`：
 * 用户在配置里标了默认的那条流要能作用到节点上，否则界面列的是配置里的流、执行跑的
 * 却是模型档案自带的那套 json，两者又分叉。**只认显式 `isDefault`**——`list[0]` 兜底
 * 不算，那正是历史上把 Qwen 顶成 Z-Image 的元凶。
 */
export function resolveExecutionWorkflow({
    config,
    channel,
    channelId,
    workflowId,
    modelId,
    category,
    pinCategory,
    respectChannelDefault,
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
        return toExecutionWorkflow(pinnedItem, "pinned", resolveProfileForWorkflowItem(pinnedItem, profile));
    }

    // 图像节点：配置里明确标了默认的那条流优先。
    if (respectChannelDefault) {
        const configured = resolveConfiguredDefaultWorkflow(channel, category);
        if (configured) {
            return toExecutionWorkflow(configured, "channel-default", resolveProfileForWorkflowItem(configured, profile));
        }
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
        return toExecutionWorkflow(channelDefault, "channel-default", resolveProfileForWorkflowItem(channelDefault, profile));
    }

    return undefined;
}

/**
 * 渠道里被**显式标为默认**（`isDefault`）的流。
 *
 * 不能用 `getDefaultWorkflow`：它在没有 `isDefault` 时回落 `list[0]`，而线上渠道的
 * 列表被重排过，`list[0]` 是 Z-Image —— 一回落就把模型顶掉了。
 */
export function resolveConfiguredDefaultWorkflow(
    channel?: ModelChannel | null,
    category?: WorkflowCategory | WorkflowCategory[],
): ComfyWorkflowItem | undefined {
    if (!channel || !Array.isArray(channel.workflows) || channel.workflows.length === 0) return undefined;
    const matches = (item: ComfyWorkflowItem) =>
        !category || (Array.isArray(category) ? category.includes(item.category) : item.category === category);
    return channel.workflows.find((item) => item.isDefault && matches(item));
}

/** 内联在工作流名里的架构关键字 → 模型档案。顺序敏感：先认更具体的。 */
const IMAGE_WORKFLOW_PROFILE_HINTS: Array<{ test: RegExp; profile: WorkflowModelProfile }> = [
    { test: /inpaint|局部/, profile: imageQwenInpaintProfile },
    { test: /flux/, profile: imageFlux2DevProfile },
    { test: /z[-_ ]?image|turbo/, profile: imageZTurboProfile },
    { test: /qwen/, profile: imageQwen21Profile },
];

/**
 * 工作流项 → 最贴得上的模型档案。
 *
 * 绑定阶段 `dispatchComfyuiModelWorkflow(profile, workflow)` 是按档案的 slotMapping 往
 * 工作流里写值的，档案和流对不上就会把 Qwen 的槽位写进 Z-Image 的图。节点现在直接选
 * 工作流，所以「档案」必须从选中的那条流反推，而不是继续用节点上旧的 modelId。
 *
 * 认不出来的自定义流按分类给最宽松的图像档案（qwen 10 张参考图），宁可放宽校验，
 * 也不要拿零参考图的 Z-Image 档案把用户刚接的参考图静默判为超限。
 */
export function resolveProfileForWorkflowItem(
    item: Pick<ComfyWorkflowItem, "id" | "name" | "category">,
    fallback?: WorkflowModelProfile,
): WorkflowModelProfile | undefined {
    const direct = getModelProfile(item.id) || getModelProfile(item.name);
    if (direct) return direct;

    const haystack = `${item.id} ${item.name}`.toLowerCase();
    const isImageCategory = item.category === "t2i" || item.category === "i2i" || item.category === "inpaint";
    if (isImageCategory || fallback?.capability === "image") {
        const hinted = IMAGE_WORKFLOW_PROFILE_HINTS.find((hint) => hint.test.test(haystack));
        if (hinted) return hinted.profile;
        return item.category === "inpaint" ? imageQwenInpaintProfile : imageQwen21Profile;
    }

    // 视频/音频/文本：分类本身就决定了档案家族。首尾帧与全能视频的参考图、时长配额
    // 完全不同，用错档案会在 validateModelExecution 里把合法参数判成超限（或反过来
    // 放过超限参数），所以这里按分类取档案而不是沿用节点上旧的 modelId。
    const byCategory = getModelProfile(item.category);
    if (byCategory) return byCategory;

    return fallback;
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
