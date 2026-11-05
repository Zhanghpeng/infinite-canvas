import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { submitJob, type ComfyuiWorkflowJson } from "@/services/api/comfyui";

/**
 * 数值常量节点的输入名在不同节点包里不一样：comfyui-logic 注册的 Int / Float 用 value，
 * ComfyLiterals 风格的导出残留 Number。提交时必须统一成 value，
 * 否则 ComfyUI 报 required_input_missing「value」，而错误信息看不出是字段名的问题。
 */

let posted: { prompt: Record<string, { inputs: Record<string, unknown> }> } | undefined;

beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).endsWith("/prompt")) {
            posted = JSON.parse(String(init?.body));
            return Response.json({ prompt_id: "const-job" });
        }
        throw new Error(`Unexpected URL: ${String(input)}`);
    }));
});

afterEach(() => {
    posted = undefined;
    vi.unstubAllGlobals();
});

it("把 Int / Float 节点的 Number 改写成 value，且数字字符串转成数字", async () => {
    const workflow: ComfyuiWorkflowJson = {
        "120": { class_type: "Int", inputs: { Number: "544" }, _meta: { title: "width" } },
        "121": { class_type: "Int", inputs: { Number: "960" }, _meta: { title: "height" } },
        "123": { class_type: "Float", inputs: { Number: "5" }, _meta: { title: "duration" } },
        "124": { class_type: "Float", inputs: { Number: "2.5" }, _meta: { title: "scale" } },
    };

    await expect(submitJob(workflow, "http://host:8188")).resolves.toBe("const-job");
    expect(posted?.prompt["120"].inputs).toEqual({ value: 544 });
    expect(posted?.prompt["121"].inputs).toEqual({ value: 960 });
    expect(posted?.prompt["123"].inputs).toEqual({ value: 5 });
    expect(posted?.prompt["124"].inputs).toEqual({ value: 2.5 });
});

it("空值补成节点默认值，避免空字符串过不了数值类型校验", async () => {
    const workflow: ComfyuiWorkflowJson = {
        "123": { class_type: "Float", inputs: { Number: "" }, _meta: { title: "duration" } },
    };

    await submitJob(workflow, "http://host:8188");
    expect(posted?.prompt["123"].inputs).toEqual({ value: 0 });
});

it("不改动调用方传进来的工作流对象", async () => {
    const workflow: ComfyuiWorkflowJson = {
        "120": { class_type: "Int", inputs: { Number: "544" }, _meta: { title: "width" } },
        "123": { class_type: "Float", inputs: { Number: "5" }, _meta: { title: "duration" } },
    };

    await submitJob(workflow, "http://host:8188");
    expect((workflow["120"] as { inputs: Record<string, unknown> }).inputs).toEqual({ Number: "544" });
    expect((workflow["123"] as { inputs: Record<string, unknown> }).inputs).toEqual({ Number: "5" });
});

it("已经是 value 的节点与其它节点保持原样", async () => {
    const workflow: ComfyuiWorkflowJson = {
        "120": { class_type: "Int", inputs: { value: 544 }, _meta: { title: "width" } },
        "123": { class_type: "Float", inputs: { value: 5 }, _meta: { title: "duration" } },
        "74": { class_type: "PrimitiveInt", inputs: { value: 4 }, _meta: { title: "4步" } },
        "18": { class_type: "PrimitiveStringMultiline", inputs: { value: "提示词" }, _meta: { title: "prompt" } },
    };

    await submitJob(workflow, "http://host:8188");
    expect(posted?.prompt["120"].inputs).toEqual({ value: 544 });
    expect(posted?.prompt["123"].inputs).toEqual({ value: 5 });
    expect(posted?.prompt["74"].inputs).toEqual({ value: 4 });
    expect(posted?.prompt["18"].inputs).toEqual({ value: "提示词" });
});
