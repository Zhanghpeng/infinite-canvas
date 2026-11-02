import { describe, expect, it } from "vitest";

import { buildGenerationConfig } from "@/lib/canvas/canvas-generation-helpers";
import { resolveConfiguredDefaultWorkflow, resolveExecutionWorkflow, resolveProfileForWorkflowItem } from "@/lib/canvas/workflow-resolution";
import { getWorkflowForModelProfile } from "@/services/api/comfyui-default-workflows";
import { getModelProfile } from "@/services/api/models";
import { createModelChannel, defaultConfig, getChannelWorkflows, getDefaultComfyWorkflowItems, getDefaultWorkflow, type AiConfig, type ComfyWorkflowItem } from "@/stores/use-config-store";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

/**
 * 节点工作流与实际执行的对照。
 *
 * 背景：渠道里存着工作流列表时，执行侧原来把「该分类的第一个流」当成兜底，
 * 而多数渠道的列表没有 isDefault 标记 —— 于是列表第一条（t2i 是 Z-Image-Turbo）
 * 会把模型档案顶掉：节点上选 Qwen 2.1，实际跑的却是 Z-Image 的图，还拿 Qwen 的
 * 绑定规则去改它。优先级必须固定为「显式 pin → 模型档案 → 渠道绑定流 → 渠道默认流」。
 */

function makeChannel(workflows?: ComfyWorkflowItem[]) {
    return createModelChannel({
        id: "c1",
        name: "测试主机",
        models: [{ name: "ComfyUI Image" } as never],
        workflows: workflows ?? [],
    });
}

function makeConfig(workflows?: ComfyWorkflowItem[]): AiConfig {
    return { ...defaultConfig, channels: [makeChannel(workflows)], channelId: "c1" };
}

/** 复刻线上配置：列表被重排过、且所有项都没有 isDefault 标记 */
function realisticWorkflows(): ComfyWorkflowItem[] {
    const channel = makeChannel();
    const builtin = getDefaultComfyWorkflowItems(channel).map((wf) => ({ ...wf, isDefault: false }));
    const t2i = builtin.filter((wf) => wf.category === "t2i").reverse();
    const rest = builtin.filter((wf) => wf.category !== "t2i");
    return [...t2i, ...rest];
}

describe("resolveExecutionWorkflow 的优先级", () => {
    it("渠道列表第一项是 Z-Image 时，选 Qwen 2.1 仍然跑 Qwen 的流", () => {
        const config = makeConfig(realisticWorkflows());
        const zImage = getChannelWorkflows(config.channels[0], "t2i").find((wf) => wf.id.includes("z-image"))!;
        // 先确认这个渠道的默认流确实是 Z-Image —— 就是线上那份配置的形态
        expect(getDefaultWorkflow(config.channels[0], "t2i")?.id).toBe(zImage.id);

        const resolved = resolveExecutionWorkflow({ config, channel: config.channels[0], channelId: "c1", modelId: "image-qwen-2.1", category: "t2i" });

        expect(resolved?.source).toBe("model");
        expect(resolved?.json).toBe(getWorkflowForModelProfile("image-qwen-2.1")!.json);
        expect(resolved?.json).not.toBe(zImage.json);
    });

    it("显式 pin 优先于模型档案", () => {
        const config = makeConfig(realisticWorkflows());
        const zImage = getChannelWorkflows(config.channels[0], "t2i").find((wf) => wf.id.includes("z-image"))!;

        const resolved = resolveExecutionWorkflow({
            config,
            channel: config.channels[0],
            channelId: "c1",
            modelId: "image-qwen-2.1",
            workflowId: zImage.id,
            category: "t2i",
        });

        expect(resolved?.source).toBe("pinned");
        expect(resolved?.id).toBe(zImage.id);
    });

    it("跨分类的残留 pin 被丢弃，回落到模型档案", () => {
        const config = makeConfig(realisticWorkflows());
        const i2i = getDefaultWorkflow(config.channels[0], "i2i")!;

        // 视频请求带着图像节点的 i2i pin：该分类下找不到，不能拿来覆盖模型
        const resolved = resolveExecutionWorkflow({
            config,
            channel: config.channels[0],
            channelId: "c1",
            modelId: "image-qwen-2.1",
            workflowId: i2i.id,
            category: "t2i",
        });

        expect(resolved?.source).toBe("model");
        expect(resolved?.id).toBe("image-qwen-2.1");
    });

    it("pinCategory 传 null 时不受分类过滤，depthVideo 之类的专用 pin 仍然生效", () => {
        const config = makeConfig(realisticWorkflows());
        const depth = getDefaultWorkflow(config.channels[0], "depthVideo");
        expect(depth).toBeTruthy();

        const scoped = resolveExecutionWorkflow({
            config,
            channel: config.channels[0],
            channelId: "c1",
            modelId: "omni-video-minimax-h3-fp8-4step-pdmd",
            workflowId: depth!.id,
            category: "omniVideo",
        });
        expect(scoped?.source).toBe("model");

        const unrestricted = resolveExecutionWorkflow({
            config,
            channel: config.channels[0],
            channelId: "c1",
            modelId: "omni-video-minimax-h3-fp8-4step-pdmd",
            workflowId: depth!.id,
            pinCategory: null,
            category: "omniVideo",
        });
        expect(unrestricted?.source).toBe("pinned");
        expect(unrestricted?.category).toBe("depthVideo");
    });

    it("没有模型档案时回落到渠道绑定流，再回落到渠道默认流", () => {
        const config = makeConfig(realisticWorkflows());
        const channel = config.channels[0];
        const channelWorkflow = { name: "渠道自定义", json: { node: {} }, createdAt: 1 };

        const withChannel = resolveExecutionWorkflow({ config, channel, channelId: "c1", modelId: "我的自定义图像模型", category: "t2i", channelWorkflow });
        expect(withChannel?.source).toBe("channel");
        expect(withChannel?.json).toBe(channelWorkflow.json);

        const withDefault = resolveExecutionWorkflow({ config, channel, channelId: "c1", modelId: "我的自定义图像模型", category: "t2i" });
        expect(withDefault?.source).toBe("channel-default");
    });

    it("渠道绑定的流同样不会压过模型档案", () => {
        const config = makeConfig(realisticWorkflows());
        const channel = config.channels[0];
        const channelWorkflow = { name: "渠道自定义", json: { node: {} }, createdAt: 1 };

        const resolved = resolveExecutionWorkflow({ config, channel, channelId: "c1", modelId: "image-qwen-2.1", category: "t2i", channelWorkflow });

        expect(resolved?.source).toBe("model");
        expect(resolved?.json).toBe(getWorkflowForModelProfile("image-qwen-2.1")!.json);
    });
});

describe("图像节点：配置里的默认流要真的作用到节点上", () => {
    function withDefaultT2i(): ComfyWorkflowItem[] {
        return realisticWorkflows().map((wf) => ({
            ...wf,
            isDefault: wf.category === "t2i" && wf.name.includes("Qwen-Image-2.1 文生图"),
        }));
    }

    it("标了 isDefault 的那条压过模型档案", () => {
        const config = makeConfig(withDefaultT2i());
        const channel = config.channels[0];
        const configured = resolveConfiguredDefaultWorkflow(channel, "t2i")!;
        expect(configured.name).toBe("Qwen-Image-2.1 文生图");

        const resolved = resolveExecutionWorkflow({
            config,
            channel,
            channelId: "c1",
            modelId: "image-z-turbo",
            category: "t2i",
            respectChannelDefault: true,
        });

        expect(resolved?.source).toBe("channel-default");
        expect(resolved?.id).toBe(configured.id);
        // 档案跟着流走：跑的既然是 Qwen 的流，就不能再用 Z-Image 的绑定规则去改它
        expect(resolved?.modelProfile?.id).toBe("image-qwen-2.1");
    });

    it("没有任何 isDefault 标记时仍然走模型档案，不会被 list[0] 顶掉", () => {
        const config = makeConfig(realisticWorkflows());
        const channel = config.channels[0];
        expect(resolveConfiguredDefaultWorkflow(channel, "t2i")).toBeUndefined();

        const resolved = resolveExecutionWorkflow({
            config,
            channel,
            channelId: "c1",
            modelId: "image-qwen-2.1",
            category: "t2i",
            respectChannelDefault: true,
        });

        expect(resolved?.source).toBe("model");
    });

    it("不传 respectChannelDefault 时（视频/文本）行为不变", () => {
        const config = makeConfig(withDefaultT2i());
        const resolved = resolveExecutionWorkflow({
            config,
            channel: config.channels[0],
            channelId: "c1",
            modelId: "image-z-turbo",
            category: "t2i",
        });

        expect(resolved?.source).toBe("model");
        expect(resolved?.modelProfile?.id).toBe("image-z-turbo");
    });

    it("pin 到 Z-Image 的流时档案跟着变成 Z-Image", () => {
        const config = makeConfig(withDefaultT2i());
        const zImage = getChannelWorkflows(config.channels[0], "t2i").find((wf) => wf.id.includes("z-image"))!;

        const resolved = resolveExecutionWorkflow({
            config,
            channel: config.channels[0],
            channelId: "c1",
            modelId: "image-qwen-2.1",
            workflowId: zImage.id,
            category: "t2i",
            respectChannelDefault: true,
        });

        expect(resolved?.source).toBe("pinned");
        expect(resolved?.modelProfile?.id).toBe("image-z-turbo");
    });
});

describe("resolveProfileForWorkflowItem：从工作流反推绑定规则", () => {
    it("按名字识别线上那几条自定义流", () => {
        expect(resolveProfileForWorkflowItem({ id: "y_2RHZvoU4SKLzJCoGKvl", name: "qwen_image_21_文生图", category: "t2i" })?.id).toBe("image-qwen-2.1");
        expect(resolveProfileForWorkflowItem({ id: "-bX2LGJ_c6LGW4oJ7luAf", name: "qwenimage2.1参考图6-9宫格", category: "i2i" })?.id).toBe("image-qwen-2.1");
        expect(resolveProfileForWorkflowItem({ id: "yL50Le6T6gyekGyZOdnIu", name: "qwenimage2.1局部图像编辑", category: "inpaint" })?.id).toBe("image-qwen-inpaint");
        expect(resolveProfileForWorkflowItem({ id: "builtin-i2i-flux2-dev", name: "Flux2.Dev 图生图", category: "i2i" })?.id).toBe("image-flux2-dev");
        expect(resolveProfileForWorkflowItem({ id: "builtin-t2i-z-image-turbo", name: "Z-Image-Turbo 文生图", category: "t2i" })?.id).toBe("image-z-turbo");
    });

    it("完全认不出来的图像流按分类给最宽松的档案，不用零参考图的档案误杀", () => {
        expect(resolveProfileForWorkflowItem({ id: "custom-1", name: "我的自定义流", category: "i2i" })?.id).toBe("image-qwen-2.1");
        expect(resolveProfileForWorkflowItem({ id: "custom-2", name: "我的自定义重绘", category: "inpaint" })?.id).toBe("image-qwen-inpaint");
    });

    it("非图像分类不猜，保持调用方传入的档案", () => {
        const fallback = getModelProfile("omni-video-minimax-h3-fp8-4step-pdmd");
        expect(resolveProfileForWorkflowItem({ id: "custom-3", name: "我的视频流", category: "omniVideo" }, fallback)).toBe(fallback);
        expect(resolveProfileForWorkflowItem({ id: "custom-4", name: "我的视频流", category: "omniVideo" })).toBeUndefined();
    });
});

describe("buildGenerationConfig 的 workflowId 来源", () => {
    function makeImageNode(metadata: Record<string, unknown>): CanvasNodeData {
        return { id: "n1", type: CanvasNodeType.Image, position: { x: 0, y: 0 }, width: 100, height: 100, metadata } as unknown as CanvasNodeData;
    }

    it("节点已经选了模型时，不再回落到全局 workflowId", () => {
        const config = { ...makeConfig(realisticWorkflows()), workflowId: "c1-t2i-z-image-turbo" };
        const node = makeImageNode({ modelId: "image-qwen-2.1" });

        expect(buildGenerationConfig(config, node, "image").workflowId).toBeUndefined();
    });

    it("节点自己钉住的工作流照常透传", () => {
        const config = { ...makeConfig(realisticWorkflows()), workflowId: "c1-t2i-qwen-image-21" };
        const node = makeImageNode({ modelId: "image-qwen-2.1", workflowId: "c1-t2i-z-image-turbo" });

        expect(buildGenerationConfig(config, node, "image").workflowId).toBe("c1-t2i-z-image-turbo");
    });

    it("完全没有模型的节点才沿用它所属的全局配置", () => {
        const config = { ...makeConfig(realisticWorkflows()), workflowId: "c1-t2i-qwen-image-21" };
        const node = makeImageNode({});

        expect(buildGenerationConfig(config, node, "image").workflowId).toBe("c1-t2i-qwen-image-21");
    });
});
