import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { submitJob, type ComfyuiWorkflowJson } from "@/services/api/comfyui";

/**
 * `minimax_h3_fl2va_pruned_fp8_scaled` 是转换时写空权重的残次文件：能加载，但出片是整帧彩色噪点。
 * 渠道里保存的工作流快照、用户另存的工作流副本都带着这个文件名，改仓库里的内置 JSON 覆盖不到，
 * 所以提交前必须按文件名兜一层，否则用户看到的就是「工作流明明改过了还是乱码」。
 */

const BROKEN = "minimax_h3_fl2va_pruned_fp8_scaled.safetensors";
const USABLE = "minimax_h3_fl2va_pruned_int8_convrot.safetensors";

let posted: { prompt: Record<string, { inputs: Record<string, unknown> }> } | undefined;
let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
    posted = undefined;
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).endsWith("/prompt")) {
            posted = JSON.parse(String(init?.body));
            return Response.json({ prompt_id: "broken-model-job" });
        }
        throw new Error(`Unexpected URL: ${String(input)}`);
    }));
});

afterEach(() => {
    posted = undefined;
    warn.mockRestore();
    vi.unstubAllGlobals();
});

it("把指向损坏底模的 unet_name 换成可用模型", async () => {
    const workflow: ComfyuiWorkflowJson = {
        "135": { class_type: "UNETLoader", inputs: { unet_name: BROKEN, weight_dtype: "default" } },
    };

    await expect(submitJob(workflow, "http://host:8188")).resolves.toBe("broken-model-job");
    expect(posted?.prompt["135"].inputs).toEqual({ unet_name: USABLE, weight_dtype: "default" });
    expect(warn).toHaveBeenCalled();
});

it("按输入值匹配，换到别的字段名也能兜住", async () => {
    const workflow: ComfyuiWorkflowJson = {
        "105:6": { class_type: "SomeOtherLoader", inputs: { model_name: BROKEN } },
    };

    await submitJob(workflow, "http://host:8188");
    expect(posted?.prompt["105:6"].inputs).toEqual({ model_name: USABLE });
});

it("已经是可用模型的不做改动", async () => {
    const workflow: ComfyuiWorkflowJson = {
        "135": { class_type: "UNETLoader", inputs: { unet_name: USABLE, weight_dtype: "default" } },
    };

    await submitJob(workflow, "http://host:8188");
    expect(posted?.prompt["135"].inputs).toEqual({ unet_name: USABLE, weight_dtype: "default" });
    expect(warn).not.toHaveBeenCalled();
});

it("不改动调用方传进来的工作流对象", async () => {
    const workflow: ComfyuiWorkflowJson = {
        "135": { class_type: "UNETLoader", inputs: { unet_name: BROKEN } },
    };

    await submitJob(workflow, "http://host:8188");
    expect((workflow["135"] as { inputs: Record<string, unknown> }).inputs).toEqual({ unet_name: BROKEN });
});

it("与常量节点归一化同时生效", async () => {
    const workflow: ComfyuiWorkflowJson = {
        "123": { class_type: "Float", inputs: { Number: "5" } },
        "135": { class_type: "UNETLoader", inputs: { unet_name: BROKEN } },
    };

    await submitJob(workflow, "http://host:8188");
    expect(posted?.prompt["123"].inputs).toEqual({ value: 5 });
    expect(posted?.prompt["135"].inputs).toEqual({ unet_name: USABLE });
});
