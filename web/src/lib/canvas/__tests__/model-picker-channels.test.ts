import { describe, expect, it } from "vitest";

import {
    isChannelAvailable,
    resolveModelWhenSwitchingChannel,
    summarizeChannelAvailability,
    type ChannelAvailabilityContext,
} from "@/lib/canvas/model-picker-channels";
import { BUILTIN_IMAGE_WORKFLOW_MODELS } from "@/services/api/models";
import type { ModelChannel } from "@/stores/use-config-store";

function makeChannel(id: string, supportedModelIds?: string[]): ModelChannel {
    return {
        id,
        name: id,
        baseUrl: "",
        apiKey: "",
        apiFormat: "comfyui",
        models: [],
        supportedModelIds,
    };
}

const context: ChannelAvailabilityContext = {
    connectedImages: 0,
    connectedVideos: 0,
    connectedAudios: 0,
    promptText: "",
};

describe("model-picker-channels", () => {
    it("渠道级可用数与模型级置灰使用同一份约束结果", () => {
        // 主机只声明支持 Z-Image-Turbo，其余图像模型必须在渠道级暴露为不可用，而不是展开后才看到一片灰。
        const summary = summarizeChannelAvailability(makeChannel("only-z", ["image-z-turbo"]), BUILTIN_IMAGE_WORKFLOW_MODELS, context);

        expect(summary.total).toBe(4);
        expect(summary.selectableCount).toBe(1);
        expect(summary.firstSelectable?.id).toBe("image-z-turbo");
        expect(summary.entries.filter((entry) => entry.availability.isSelectable).map((entry) => entry.model.id)).toEqual([
            "image-z-turbo",
        ]);
    });

    it("换了输入条件后渠道可用数同步归零", () => {
        const channel = makeChannel("only-z", ["image-z-turbo"]);
        const summary = summarizeChannelAvailability(channel, BUILTIN_IMAGE_WORKFLOW_MODELS, {
            ...context,
            connectedImages: 2,
        });

        // Z-Image-Turbo 不支持参考图，接了图就一个都选不了。
        expect(summary.selectableCount).toBe(0);
        expect(summary.firstSelectable).toBeUndefined();
    });

    it("只切渠道时保留当前模型", () => {
        const channel = makeChannel("full");
        const next = resolveModelWhenSwitchingChannel(channel, BUILTIN_IMAGE_WORKFLOW_MODELS, context, "image-flux2-dev");

        expect(next?.id).toBe("image-flux2-dev");
    });

    it("当前模型在新渠道不可用时退回该渠道第一个可选模型", () => {
        const channel = makeChannel("only-z", ["image-z-turbo"]);
        const next = resolveModelWhenSwitchingChannel(channel, BUILTIN_IMAGE_WORKFLOW_MODELS, context, "image-qwen-2.1");

        expect(next?.id).toBe("image-z-turbo");
    });

    it("新渠道一个模型都用不了时不给候选，交由调用方保持原选择", () => {
        const channel = makeChannel("only-z", ["image-z-turbo"]);
        const next = resolveModelWhenSwitchingChannel(channel, BUILTIN_IMAGE_WORKFLOW_MODELS, { ...context, connectedImages: 2 }, "image-qwen-2.1");

        expect(next).toBeUndefined();
    });

    it("能识别已被删除的渠道引用", () => {
        const channels = [makeChannel("a"), makeChannel("b")];

        expect(isChannelAvailable(channels, "b")).toBe(true);
        expect(isChannelAvailable(channels, "gone")).toBe(false);
        expect(isChannelAvailable(channels, undefined)).toBe(false);
    });
});
