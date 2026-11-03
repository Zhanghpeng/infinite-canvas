import type { WorkflowModelProfile } from "./types";

/**
 * Qwen-3.5 统一多模态大模型
 * 支持多模态输入（0~多张图）：
 * - 无图连入时：充当纯文本生成、润色与提示词扩写助手；
 * - 连入参考图时：充当多模态视觉反推与看图提问模型。
 *
 * **参考图张数不做 1 张硬限制**：文本节点经常挂的是带 `ref_image_01..06` 多槽位的
 * 反推工作流（如 Qwen-Image 2.1 提示词反推），连第二张就被连线校验拦下与「多图反推」
 * 直接冲突。这里只留一个宽松上限兜底，真正的物理上限由工作流的槽位数决定——执行侧
 * `requestComfyuiText` 会按槽位数校验并给出明确报错，未填满的槽位会被裁掉。
 *
 * 注：底层 ComfyUI 工作流参数锁死，不支持深度思考开关与生成长度配置。
 */
export const textQwen35Profile: WorkflowModelProfile = {
    id: "text-qwen-35",
    name: "Qwen-3.5",
    capability: "text",
    protocol: "comfyui",
    category: "text",
    capabilityConfig: {
        version: 1,
        references: {
            promptMaxChars: 4000,
            minImages: 0,
            maxImages: 9,
            maskSupported: false,
            minVideos: 0,
            maxVideos: 0,
            maxAudios: 0,
        },
    },
    slotMapping: {
        prompt: "prompt",
        seed: "seed",
        images: "ref_image_01",
        textOutput: "output_text",
    },
    description: "Qwen-3.5 统一多模态大模型，支持纯文本生成/扩写，以及多张参考图的视觉反推与看图提问。",
};

// 兼容别名导出
export const textQwen35ChatProfile = textQwen35Profile;
export const textQwen35VlmProfile = textQwen35Profile;

export const TEXT_WORKFLOW_MODELS: WorkflowModelProfile[] = [
    textQwen35Profile,
];
