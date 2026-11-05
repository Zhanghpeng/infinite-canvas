import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { submitJob, type ComfyuiWorkflowJson } from "@/services/api/comfyui";

/**
 * Int 常量节点的输入名在不同节点包里不一样：comfyui-logic 注册的 Int 用 value，
 * ComfyLiterals 风格的导出残留 Number。提交时必须统一成 value，
 * 否则 ComfyUI 报 required_input_missing「value」，而错误信息看不出是字段名的问题。
 */

let posted: { prompt: Record<string, { inputs: Record<string, unknown> }> } | undefined;

beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).endsWith("/prompt")) {
            posted = JSON.parse(String(init?.body));
            return Response.json({ prompt_id: "int-job" });
        }
        throw new Error(`Unexpected URL: ${String(input)}`);
    }));
});

afterEach(() => {
    posted = undefined;
    vi.unstubAllGlobals();
});

it("把 Int 节点的 Number 改写成 value，且数字字符串转成数字", async () => {
    const workflow: ComfyuiWorkflowJson = {
        "120": { class_type: "Int", inputs: { Number: "544" }, _meta: { title: "width" } },
        "121": { class_type: "Int", inputs: { Number: "960" }, _meta: { title: "height" } },
    };

    await expect(submitJob(workflow, "http://host:8188")).resolves.toBe("int-job");
    expect(posted?.prompt["120"].inputs).toEqual({ value: 544 });
    expect(posted?.prompt["121"].inputs).toEqual({ value: 960 });
});

it("不改动调用方传进来的工作流对象", async () => {
    const workflow: ComfyuiWorkflowJson = {
        "120": { class_type: "Int", inputs: { Number: "544" }, _meta: { title: "width" } },
    };

    await submitJob(workflow, "http://host:8188");
    expect((workflow["120"] as { inputs: Record<string, unknown> }).inputs).toEqual({ Number: "544" });
});

it("已经是 value 的 Int 与其它节点保持原样", async () => {
    const workflow: ComfyuiWorkflowJson = {
        "120": { class_type: "Int", inputs: { value: 544 }, _meta: { title: "width" } },
        "74": { class_type: "PrimitiveInt", inputs: { value: 4 }, _meta: { title: "4步" } },
        "18": { class_type: "PrimitiveStringMultiline", inputs: { value: "提示词" }, _meta: { title: "prompt" } },
    };

    await submitJob(workflow, "http://host:8188");
    expect(posted?.prompt["120"].inputs).toEqual({ value: 544 });
    expect(posted?.prompt["74"].inputs).toEqual({ value: 4 });
    expect(posted?.prompt["18"].inputs).toEqual({ value: "提示词" });
});
