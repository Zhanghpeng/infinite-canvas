// 背景板：把画布上某张**已生成的图**当作 3D 场景的背景，人物就能合成在真画面里。
//
// 为什么不拷贝图片字节：只记节点 id —— 那张图重新生成后，背景板自动跟着更新（活链）。
// 图片 URL 从节点的 `metadata.content` 取：宿主在加载工程时会按 `metadata.storageKey` 把它
// 重新解析成可用的 blob:/data: URL（见 web/src/lib/canvas/canvas-generation-helpers.ts），
// 所以插件不需要新增宿主契约就能拿到可喂 WebGL 的地址。
import type { CanvasNodeData } from "@infinite-canvas/plugin-sdk";

export type BackdropSource = { nodeId: string; title: string; url: string };

/** 图片节点在画布上的类型名（内置节点）。 */
const IMAGE_NODE_TYPE = "image";

export function isImageNode(node: CanvasNodeData): boolean {
    return node.type === IMAGE_NODE_TYPE;
}

/** 这张图现在能不能当背景板（有可用的图片地址）。 */
export function imageNodeUrl(node: CanvasNodeData): string {
    const content = node.metadata?.content;
    return typeof content === "string" && content.trim() ? content.trim() : "";
}

/** 画布上可以当背景板的图片节点（供下拉选择）。 */
export function listImageNodeOptions(nodes: CanvasNodeData[]): Array<{ id: string; title: string; ready: boolean }> {
    return nodes
        .filter(isImageNode)
        .map((node) => ({ id: node.id, title: node.title || "未命名图片", ready: Boolean(imageNodeUrl(node)) }))
        .sort((a, b) => a.title.localeCompare(b.title));
}

/** 解析背景板来源；节点不在 / 不是图片 / 还没有画面 → null（调用方据此给明确提示）。 */
export function resolveBackdropSource(nodes: CanvasNodeData[], nodeId: string | undefined): BackdropSource | null {
    if (!nodeId) return null;
    const node = nodes.find((item) => item.id === nodeId && isImageNode(item));
    if (!node) return null;
    const url = imageNodeUrl(node);
    if (!url) return null;
    return { nodeId: node.id, title: node.title || "未命名图片", url };
}

/** 背景板引用还在、但这张图现在没有画面（生成中 / 失败 / 被清理）—— 给自检与状态行用。 */
export function backdropUnavailable(nodes: CanvasNodeData[], nodeId: string | undefined): { nodeId: string; title: string } | null {
    if (!nodeId) return null;
    const node = nodes.find((item) => item.id === nodeId);
    if (node && isImageNode(node) && imageNodeUrl(node)) return null;
    return { nodeId, title: node?.title || "背景板图片" };
}
