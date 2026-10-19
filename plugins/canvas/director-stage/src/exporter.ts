// 导出：把渲染出的画面 / 生成的提示词落成画布节点，并接到现有工作流槽位。
// 只用 SDK 的 ctx.applyOps（宿主指令集），不直接改画布内部状态。
import type { CanvasAgentOp, CanvasNodeContext, CanvasNodeData } from "@infinite-canvas/plugin-sdk";

export type ExportFormat = "jpeg" | "png";

export type CapturedFrame = { dataUrl: string; width: number; height: number };

const GAP = 96;
/**
 * 画布上媒体节点的最大边：与宿主保持一致。
 * 宿主的抽帧/生成结果都走 fitNodeSize(w, h, VIDEO_NODE_MAX_WIDTH, VIDEO_NODE_MAX_HEIGHT)（都是 420），
 * 节点大小只是展示框，真正的分辨率写在 metadata.naturalWidth/Height 里。
 */
const MEDIA_NODE_MAX_EDGE = 420;
/** 找空位时最多往下试多少格，防止在一个塞满的区域里死循环。 */
const MAX_SPOT_TRIES = 24;

type Rect = { x: number; y: number; width: number; height: number };

function bytesOf(dataUrl: string) {
    const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
    return Math.round(base64.length * 0.75);
}

function mimeOf(format: ExportFormat) {
    return format === "png" ? "image/png" : "image/jpeg";
}

/** 按最大边等比缩放（与宿主 canvas-node-size.ts 的 fitNodeSize 同规则）。 */
function fitNodeSize(width: number, height: number) {
    const scale = Math.min(1, MEDIA_NODE_MAX_EDGE / Math.max(1, width), MEDIA_NODE_MAX_EDGE / Math.max(1, height));
    return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

const overlaps = (a: Rect, b: Rect) =>
    a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/**
 * 在导演台节点右侧「一列往下」找空位：紧贴节点、第一个一定在同一水平线上，
 * 后续产物依次往下排，并自动避开画布上已有的节点与本次已排的产物。
 *
 * 之前按「第 N 个产物」去算 `index % 3 / floor(index / 3)`，导出多张时会一路排到
 * 节点上方几千像素的地方，用户根本看不到 —— 这里不再用全局序号，只用锚点 + 占位判断。
 */
function findExportSpot(ctx: CanvasNodeContext, size: { width: number; height: number }, placed: Rect[]): { x: number; y: number } {
    const anchor = ctx.node;
    const occupied: Rect[] = [
        ...ctx.getNodes().map((node) => ({ x: node.position.x, y: node.position.y, width: node.width, height: node.height })),
        ...placed,
    ];
    const cellHeight = size.height + GAP;
    const startX = anchor.position.x + anchor.width + GAP;
    for (let row = 0; row < MAX_SPOT_TRIES; row += 1) {
        const spot = { x: startX, y: anchor.position.y + row * cellHeight };
        if (!occupied.some((item) => overlaps({ ...spot, ...size }, item))) return spot;
    }
    return { x: startX, y: anchor.position.y };
}

function imageMetadata(frame: CapturedFrame, format: ExportFormat) {
    return {
        content: frame.dataUrl,
        status: "success" as const,
        naturalWidth: frame.width,
        naturalHeight: frame.height,
        mimeType: mimeOf(format),
        bytes: bytesOf(frame.dataUrl),
    };
}

export type ExportedImage = { id: string; ops: CanvasAgentOp[] };

/** 建一张图片节点（不连线），返回节点 id，供后续连线/分组。 */
export function buildImageOps(ctx: CanvasNodeContext, frames: Array<{ frame: CapturedFrame; title: string }>, options: { format: ExportFormat }): ExportedImage[] {
    const node = ctx.node;
    const placed: Rect[] = [];
    return frames.map((item, index) => {
        const id = `stage-${node.id}-${Date.now().toString(36)}-${index}-${Math.random().toString(36).slice(2, 6)}`;
        const size = fitNodeSize(item.frame.width, item.frame.height);
        const position = findExportSpot(ctx, size, placed);
        placed.push({ ...position, ...size });
        const ops: CanvasAgentOp[] = [
            {
                type: "add_node",
                id,
                nodeType: "image",
                title: item.title,
                position,
                width: size.width,
                height: size.height,
                metadata: { ...imageMetadata(item.frame, options.format) },
            },
        ];
        return { id, ops };
    });
}

/** 把产出物打成一个折叠分组：算出包围盒建 group，并把 children 的 groupId 指过去。 */
export function buildGroupOps(images: ExportedImage[], title: string, padding = 36): CanvasAgentOp[] {
    if (images.length < 2) return [];
    const rects = images.map((image) => {
        const op = image.ops[0];
        if (op.type !== "add_node") return { x: 0, y: 0, width: 0, height: 0 };
        return { x: op.position?.x ?? op.x ?? 0, y: op.position?.y ?? op.y ?? 0, width: op.width ?? 0, height: op.height ?? 0 };
    });
    const left = Math.min(...rects.map((rect) => rect.x)) - padding;
    const top = Math.min(...rects.map((rect) => rect.y)) - padding - 8;
    const right = Math.max(...rects.map((rect) => rect.x + rect.width)) + padding;
    const bottom = Math.max(...rects.map((rect) => rect.y + rect.height)) + padding;
    const groupId = `stage-group-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    return [
        {
            type: "add_node",
            id: groupId,
            nodeType: "group",
            title,
            position: { x: left, y: top },
            width: right - left,
            height: bottom - top,
            metadata: { collapsed: true },
        },
        ...images.map((image) => ({ type: "update_node" as const, id: image.id, metadata: { groupId } })),
    ];
}

export type ExportedVideo = { id: string; ops: CanvasAgentOp[] };

/** 建一个视频节点承载运镜预演：content 存 dataURL（唯一能持久化的形式）。 */
export function buildVideoNodeOps(
    ctx: CanvasNodeContext,
    video: { dataUrl: string; mimeType: string; width: number; height: number; bytes: number; durationMs: number; title: string },
): ExportedVideo {
    const node = ctx.node;
    const id = `stage-video-${node.id}-${Date.now().toString(36)}`;
    const size = fitNodeSize(video.width, video.height);
    return {
        id,
        ops: [
            {
                type: "add_node",
                id,
                nodeType: "video",
                title: video.title,
                position: findExportSpot(ctx, size, []),
                width: size.width,
                height: size.height,
                metadata: {
                    content: video.dataUrl,
                    status: "success",
                    mimeType: video.mimeType,
                    bytes: video.bytes,
                    durationMs: video.durationMs,
                    seconds: (video.durationMs / 1000).toFixed(1),
                    naturalWidth: video.width,
                    naturalHeight: video.height,
                },
            },
        ],
    };
}

/** 找到下游第一个视频节点：导出首尾帧时把两帧直接接上去。 */
export function findDownstreamVideoNode(ctx: CanvasNodeContext) {
    return ctx.getDownstream().find((node) => node.type === "video");
}
