import { evaluateModelAvailability, type ModelAvailability, type WorkflowModelProfile } from "@/services/api/models";
import type { ModelChannel } from "@/stores/use-config-store";

export type ChannelAvailabilityContext = {
    connectedImages: number;
    connectedVideos: number;
    connectedAudios: number;
    promptText: string;
};

export type ChannelModelEntry = {
    model: WorkflowModelProfile;
    availability: ModelAvailability;
};

export type ChannelAvailabilitySummary = {
    channel: ModelChannel;
    entries: ChannelModelEntry[];
    /** 该渠道下允许切换的模型数量（用于渠道级「N/M 可用」提示与置灰判断）。 */
    selectableCount: number;
    total: number;
    firstSelectable?: WorkflowModelProfile;
};

/**
 * 汇总某个渠道下整批模型的可用性。
 *
 * 渠道级与模型级必须用同一份上下文计算，否则会出现「渠道显示可用、点进去全是灰的」这类自相矛盾的列表。
 */
export function summarizeChannelAvailability(
    channel: ModelChannel,
    models: WorkflowModelProfile[],
    ctx: ChannelAvailabilityContext,
): ChannelAvailabilitySummary {
    const entries: ChannelModelEntry[] = models.map((model) => ({
        model,
        availability: evaluateModelAvailability({ targetModel: model, ...ctx, activeChannel: channel }),
    }));
    const selectable = entries.filter((entry) => entry.availability.isSelectable);
    return {
        channel,
        entries,
        selectableCount: selectable.length,
        total: models.length,
        firstSelectable: selectable[0]?.model,
    };
}

/**
 * 只切换渠道（没点到第二级模型）时该落到哪个模型。
 *
 * 优先保留当前模型——同一个模型在多个渠道都有，换渠道不该顺手把模型也换掉；
 * 当前模型在新渠道不可选时才退回该渠道第一个可选模型。
 */
export function resolveModelWhenSwitchingChannel(
    channel: ModelChannel,
    models: WorkflowModelProfile[],
    ctx: ChannelAvailabilityContext,
    currentModelId: string,
): WorkflowModelProfile | undefined {
    const summary = summarizeChannelAvailability(channel, models, ctx);
    const current = summary.entries.find((entry) => entry.model.id === currentModelId);
    if (current?.availability.isSelectable) return current.model;
    return summary.firstSelectable;
}

/**
 * 渠道 id 是否仍存在于配置中。
 *
 * 节点上钉着的渠道被删除后，选择器会静默回落到第一个渠道显示，而执行侧拿到的还是那个失效 id，
 * 于是「看到的」和「实际跑的」分叉。这里用来识别需要纠正的失效引用。
 */
export function isChannelAvailable(channels: ModelChannel[], channelId?: string): boolean {
    return Boolean(channelId && channels.some((channel) => channel.id === channelId));
}
