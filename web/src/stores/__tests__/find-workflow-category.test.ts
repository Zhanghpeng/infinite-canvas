import { describe, expect, it } from "vitest";

import { createModelChannel, defaultConfig, findWorkflow, getChannelWorkflows, getDefaultWorkflow, type AiConfig } from "@/stores/use-config-store";

/**
 * 画布节点的工作流解析。
 *
 * 背景：图像节点把「当前有没有参考图」翻成 i2i / t2i 分类，再用 findWorkflow 取流。
 * 一旦兜底跨了分类，就会出现「选了文生图流、接上参考图却照跑文生图」这种静默错配
 * —— 文生图流没有参考图槽位，绑定阶段会把参考图丢掉，出图和参考无关又不报错。
 */

function makeConfig(): AiConfig {
    const channel = createModelChannel({ id: "c1", name: "测试主机", models: [{ name: "ComfyUI Image" } as never], workflows: [] });
    return { ...defaultConfig, channels: [channel], channelId: "c1" };
}

describe("findWorkflow 的分类约束", () => {
    it("内置 id 跨分类不再被硬套，回落到请求分类的默认流", () => {
        const config = makeConfig();
        const channel = config.channels[0];
        const zTurbo = getChannelWorkflows(channel, "t2i").find((wf) => wf.id.includes("z-image"))!;
        const i2iDefault = getDefaultWorkflow(channel, "i2i")!;

        const picked = findWorkflow(config, "c1", zTurbo.id, "i2i");

        expect(picked?.category).toBe("i2i");
        expect(picked?.id).toBe(i2iDefault.id);
    });

    it("同分类的内置 id 照旧命中，不受分类约束影响", () => {
        const config = makeConfig();
        const channel = config.channels[0];
        const zTurbo = getChannelWorkflows(channel, "t2i").find((wf) => wf.id.includes("z-image"))!;

        expect(findWorkflow(config, "c1", zTurbo.id, "t2i")?.id).toBe(zTurbo.id);
    });

    it("自定义流跨分类时同样回落到分类默认流", () => {
        const config = makeConfig();
        const channel = config.channels[0];
        const custom = {
            id: "customwf0001",
            name: "我的参考图流",
            category: "i2i" as const,
            json: getDefaultWorkflow(channel, "i2i")!.json,
            createdAt: 1,
            isBuiltin: false,
            isDefault: false,
        };
        const withCustom: AiConfig = { ...config, channels: [{ ...channel, workflows: [...(channel.workflows ?? []), custom] }] };

        expect(findWorkflow(withCustom, "c1", custom.id, "i2i")?.id).toBe(custom.id);
        expect(findWorkflow(withCustom, "c1", custom.id, "t2i")?.id).toBe(getDefaultWorkflow(withCustom.channels[0], "t2i")!.id);
    });

    it("不传分类时行为不变：按 id 命中，命不中退到列表首项", () => {
        const config = makeConfig();
        const channel = config.channels[0];
        const zTurbo = getChannelWorkflows(channel, "t2i").find((wf) => wf.id.includes("z-image"))!;

        expect(findWorkflow(config, "c1", zTurbo.id)?.id).toBe(zTurbo.id);
        expect(findWorkflow(config, "c1", "不存在的-id")?.id).toBe(getChannelWorkflows(channel)[0].id);
    });

    it("视频按多分类取流时，数组里的每一种分类都算命中", () => {
        const config = makeConfig();
        const channel = config.channels[0];
        const frame = getDefaultWorkflow(channel, "frameVideo")!;

        expect(findWorkflow(config, "c1", frame.id, ["omniVideo", "frameVideo", "faceRefine"])?.id).toBe(frame.id);
    });
});
