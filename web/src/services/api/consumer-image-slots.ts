/**
 * 「谁真正吃参考图」的识别。
 *
 * 不能只看 `_meta.title`：从适配工坊导入的自定义 H3 流，作者常常只给一部分
 * LoadImage 打了 `ref_image_0N` 标题，甚至一个都没打（保留 ComfyUI 默认的
 * 「加载图像」），标号也可能从 03 起跳。此时按「title 编号 = 第 N 张图」硬对应，
 * 用户连的第 1、2 张图没有任何槽位接收，槽位里录制的示例文件名被原样提交 ——
 * 生成结果与参考图无关，还不报错。
 *
 * 真正可靠的依据是消费端：主节点的 `ref_images.ref_image_N` 输入键，按 N 升序
 * 就是槽位顺序。图片按这个顺序依次填充，`<Picture N>` 的编号才和实际一致。
 */

type WorkflowNodeRecord = {
    class_type?: string;
    inputs?: Record<string, unknown>;
};

export type ConsumerImageSlot = {
    /** 提供图片的节点 id（LoadImage 之类） */
    nodeId: string;
    /** 消费该槽位的主节点 id 与输入键（ref_images.ref_image_0 等） */
    consumerId: string;
    consumerKey: string;
    /** 主节点输入键的序号（0 基） */
    index: number;
    /** 写进上游节点 inputs 的字段名 */
    inputKey: string;
};

/** class_type 明确该写哪个键；表里没有的走 `IMAGE_FALLBACK_KEYS` 顺序猜。 */
const IMAGE_WRITE_KEYS: Record<string, string> = {
    LoadImage: "image",
    LoadImageMask: "image",
    VHS_LoadImagePath: "image",
};

const IMAGE_FALLBACK_KEYS = ["image"];

/** 上游节点能不能接图片；能接就返回写入字段。 */
export function resolveImageWriteKey(record: WorkflowNodeRecord): string | undefined {
    const inputs = record.inputs || {};
    const byClass = IMAGE_WRITE_KEYS[record.class_type || ""];
    if (byClass && byClass in inputs) return byClass;
    for (const key of IMAGE_FALLBACK_KEYS) {
        if (key in inputs) return key;
    }
    return undefined;
}

/** 全能视频流里真正吃图的槽位，按主节点 `ref_images.ref_image_N` 的 N 升序。 */
export function collectConsumerImageSlots(workflow: Record<string, unknown>): ConsumerImageSlot[] {
    const slots: ConsumerImageSlot[] = [];
    for (const [consumerId, node] of Object.entries(workflow)) {
        if (!node || typeof node !== "object") continue;
        const record = node as WorkflowNodeRecord;
        if (!record.inputs) continue;
        for (const [key, value] of Object.entries(record.inputs)) {
            const match = /^ref_images\.ref_image_(\d+)$/.exec(key);
            if (!match || !Array.isArray(value)) continue;
            const nodeId = String(value[0]);
            const upstream = workflow[nodeId] as WorkflowNodeRecord | undefined;
            if (!upstream?.inputs) continue;
            const inputKey = resolveImageWriteKey(upstream);
            if (!inputKey) continue;
            slots.push({ nodeId, consumerId, consumerKey: key, index: Number(match[1]), inputKey });
        }
    }
    return slots.sort((a, b) => a.index - b.index);
}
