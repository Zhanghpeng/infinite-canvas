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

    it("视频/音频/文本按分类反推档案：首尾帧与全能不能共用一套配额", () => {
        const omni = resolveProfileForWorkflowItem({ id: "custom-3", name: "我的全能视频流", category: "omniVideo" });
        const frame = resolveProfileForWorkflowItem({ id: "custom-4", name: "我的首尾帧流", category: "frameVideo" });

        expect(omni?.category).toBe("omniVideo");
        expect(frame?.category).toBe("frameVideo");
        expect(omni?.id).not.toBe(frame?.id);
        // 首尾帧档案只吃 2 张参考图，全能更多 —— 拿错档案会把合法参数判成超限
        expect(frame?.capabilityConfig.references.maxImages).toBe(2);

        expect(resolveProfileForWorkflowItem({ id: "custom-5", name: "我的音频流", category: "audio" })?.capability).toBe("audio");
        expect(resolveProfileForWorkflowItem({ id: "custom-6", name: "我的文本流", category: "text" })?.capability).toBe("text");
    });

    it("分类里没有对应的档案家族时保持调用方传入的档案", () => {
        const fallback = getModelProfile("omni-video-minimax-h3-fp8-4step-pdmd");
        expect(resolveProfileForWorkflowItem({ id: "custom-7", name: "人脸修复", category: "faceRefine" }, fallback)).toBe(fallback);
    });
});

describe("视频节点的可用工作流清单", () => {
    it("配置里的全能/首尾帧/人脸修复流全部进得了节点的二级列表，且每条都能反推出档案", () => {
        const config = makeConfig(realisticWorkflows());
        const channel = config.channels[0];
        const listed = getChannelWorkflows(channel, ["omniVideo", "frameVideo", "faceRefine"]);

        // 三类都要在：原来节点二级是写死的 4 条视频模型，配置里这些流一条都看不到
        expect(listed.some((wf) => wf.category === "omniVideo")).toBe(true);
        expect(listed.some((wf) => wf.category === "frameVideo")).toBe(true);
        expect(listed.some((wf) => wf.category === "faceRefine")).toBe(true);

        // 反推不出档案的行会被选择器整行丢掉 —— 那等于又把自定义流藏起来
        const fallback = getModelProfile("omni-video-minimax-h3-fp8-4step-pdmd");
        for (const item of listed) {
            expect(resolveProfileForWorkflowItem(item, fallback)).toBeDefined();
        }
    });

    it("视频的三类流按传入顺序排：全能 → 首尾帧 → 人脸修复", () => {
        const config = makeConfig(realisticWorkflows());
        const order = ["omniVideo", "frameVideo", "faceRefine"];
        const sorted = [...getChannelWorkflows(config.channels[0], order as never)].sort((a, b) => order.indexOf(a.category) - order.indexOf(b.category));

        const firstFrameIndex = sorted.findIndex((wf) => wf.category === "frameVideo");
        const firstFaceIndex = sorted.findIndex((wf) => wf.category === "faceRefine");
        const lastOmniIndex = sorted.map((wf) => wf.category).lastIndexOf("omniVideo");

        expect(lastOmniIndex).toBeLessThan(firstFrameIndex);
        expect(firstFrameIndex).toBeLessThan(firstFaceIndex);
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

describe("视频节点的 videoMode 跟随所选工作流", () => {
    function makeVideoNode(metadata: Record<string, unknown>): CanvasNodeData {
        return { id: "v1", type: CanvasNodeType.Video, position: { x: 0, y: 0 }, width: 100, height: 100, metadata } as unknown as CanvasNodeData;
    }

    it("钉住首尾帧流时 videoMode 变成 frame，即使节点上还留着全能的 modelId", () => {
        const config = makeConfig(realisticWorkflows());
        const frameWf = getChannelWorkflows(config.channels[0], "frameVideo")[0]!;
        const node = makeVideoNode({ workflowId: frameWf.id, modelId: "omni-video-minimax-h3-fp8-4step-pdmd", videoMode: "omni" });

        // 首尾帧流与全能流的输入结构完全不同，模式必须跟着流走
        expect(buildGenerationConfig(config, node, "video").videoMode).toBe("frame");
    });

    it("钉住全能流时 videoMode 保持 omni", () => {
        const config = makeConfig(realisticWorkflows());
        const omniWf = getChannelWorkflows(config.channels[0], "omniVideo")[0]!;
        const node = makeVideoNode({ workflowId: omniWf.id, modelId: "frame-video-minimax-h3-fp8-4step-pdmd", videoMode: "frame" });

        expect(buildGenerationConfig(config, node, "video").videoMode).toBe("omni");
    });

    it("没有钉住工作流时，尊重节点上显式选择的模式（不再被 modelId 覆盖）", () => {
        const config = makeConfig(realisticWorkflows());
        // 老实现是「只要有 modelId 就按 id 里的 frame 字样推」，会把用户手动切的模式吃掉
        const node = makeVideoNode({ videoMode: "frame", modelId: "omni-video-minimax-h3-fp8-4step-pdmd" });

        expect(buildGenerationConfig(config, node, "video").videoMode).toBe("frame");
    });
});
