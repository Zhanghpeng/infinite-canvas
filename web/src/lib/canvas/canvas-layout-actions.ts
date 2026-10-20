import type { CanvasNodeData } from "@/types/canvas";

/**
 * 画布排版动作：对齐与分布。
 *
 * 都是纯函数，输入节点数组 + 选中集合，输出新数组（不改原数组），
 * 没有可动的东西时返回 null —— 让调用方能区分"已经对齐了"和"做不了"。
 *
 * 基准取「选集包围盒」，与 Figma / Sketch 的 Align to selection 一致：
 * 用户框选一片节点点左对齐，是让它们靠到这片区域的左边界，而不是画布原点。
 */

export type NodeAlignMode = "left" | "centerX" | "right" | "top" | "centerY" | "bottom";
export type NodeDistributeMode = "horizontal" | "vertical";

export type LayoutActionOptions = {
    /** 锁定节点不参与批量排版，与框选、批量删除的规则保持一致。 */
    lockedIds?: ReadonlySet<string>;
};

type Bounds = { left: number; top: number; right: number; bottom: number };

function boundsOf(nodes: CanvasNodeData[]): Bounds {
    let left = Infinity;
    let top = Infinity;
    let right = -Infinity;
    let bottom = -Infinity;
    for (const node of nodes) {
        left = Math.min(left, node.position.x);
        top = Math.min(top, node.position.y);
        right = Math.max(right, node.position.x + node.width);
        bottom = Math.max(bottom, node.position.y + node.height);
    }
    return { left, top, right, bottom };
}

/** 取出真正参与排版的目标：选中的、未被锁定的节点。 */
function pickTargets(nodes: CanvasNodeData[], ids: ReadonlySet<string>, options?: LayoutActionOptions): CanvasNodeData[] {
    const locked = options?.lockedIds;
    return nodes.filter((node) => ids.has(node.id) && !locked?.has(node.id));
}

/** 位置取整到 0.5，避免浮点误差在多次排版后累积出一堆 12.000001。 */
function snap(value: number) {
    return Math.round(value * 2) / 2;
}

/**
 * 对齐。两个节点以上才有意义，少于两个返回 null。
 */
export function alignSelectedNodes(nodes: CanvasNodeData[], ids: ReadonlySet<string>, mode: NodeAlignMode, options?: LayoutActionOptions): CanvasNodeData[] | null {
    const targets = pickTargets(nodes, ids, options);
    if (targets.length < 2) return null;

    const bounds = boundsOf(targets);
    const targetById = new Map(targets.map((node) => [node.id, node]));
    let changed = false;

    const next = nodes.map((node) => {
        const target = targetById.get(node.id);
        if (!target) return node;

        let x = node.position.x;
        let y = node.position.y;
        switch (mode) {
            case "left":
                x = bounds.left;
                break;
            case "centerX":
                x = (bounds.left + bounds.right) / 2 - node.width / 2;
                break;
            case "right":
                x = bounds.right - node.width;
                break;
            case "top":
                y = bounds.top;
                break;
            case "centerY":
                y = (bounds.top + bounds.bottom) / 2 - node.height / 2;
                break;
            case "bottom":
                y = bounds.bottom - node.height;
                break;
        }

        x = snap(x);
        y = snap(y);
        if (x === node.position.x && y === node.position.y) return node;
        changed = true;
        return { ...node, position: { x, y } };
    });

    return changed ? next : null;
}

/**
 * 分布：首尾两个节点保持在原位，中间的按**等间距**排开，间距 = (总跨度 - 总尺寸) / (n - 1)。
 *
 * 为什么是等间距而不是等中心：内容生产里一排素材横向铺开，视觉上要的是留白一致；
 * 等中心会让宽窄不一的节点看起来疏密不均。
 * 选集中的节点总尺寸超过跨度时（用户把它们叠在一起了），间距会算成负数，
 * 此时退回等中心分布 —— 至少不会让它们穿模。
 */
export function distributeSelectedNodes(nodes: CanvasNodeData[], ids: ReadonlySet<string>, mode: NodeDistributeMode, options?: LayoutActionOptions): CanvasNodeData[] | null {
    const targets = pickTargets(nodes, ids, options);
    if (targets.length < 3) return null;

    const horizontal = mode === "horizontal";
    const sorted = [...targets].sort((a, b) => (horizontal ? a.position.x - b.position.x || a.position.y - b.position.y : a.position.y - b.position.y || a.position.x - b.position.x));

    const first = sorted[0];
    const last = sorted[sorted.length - 1];
    const startEdge = horizontal ? first.position.x : first.position.y;
    const endEdge = horizontal ? last.position.x + last.width : last.position.y + last.height;
    const span = endEdge - startEdge;
    const totalSize = sorted.reduce((sum, node) => sum + (horizontal ? node.width : node.height), 0);
    const gap = (span - totalSize) / (sorted.length - 1);

    const positions = new Map<string, number>();
    if (gap >= 0) {
        let cursor = startEdge;
        sorted.forEach((node, index) => {
            // 首尾钉死，只用算中间的，避免累积误差把最后一个推离原位。
            if (index === 0) positions.set(node.id, horizontal ? node.position.x : node.position.y);
            else if (index === sorted.length - 1) positions.set(node.id, horizontal ? node.position.x : node.position.y);
            else {
                cursor += (horizontal ? sorted[index - 1].width : sorted[index - 1].height) + gap;
                positions.set(node.id, snap(cursor));
            }
        });
    } else {
        const firstCenter = horizontal ? first.position.x + first.width / 2 : first.position.y + first.height / 2;
        const lastCenter = horizontal ? last.position.x + last.width / 2 : last.position.y + last.height / 2;
        const step = (lastCenter - firstCenter) / (sorted.length - 1);
        sorted.forEach((node, index) => {
            if (index === 0 || index === sorted.length - 1) {
                positions.set(node.id, horizontal ? node.position.x : node.position.y);
                return;
            }
            const center = firstCenter + step * index;
            positions.set(node.id, snap(center - (horizontal ? node.width / 2 : node.height / 2)));
        });
    }

    let changed = false;
    const next = nodes.map((node) => {
        const value = positions.get(node.id);
        if (value === undefined) return node;
        const position = horizontal ? { x: value, y: node.position.y } : { x: node.position.x, y: value };
        if (position.x === node.position.x && position.y === node.position.y) return node;
        changed = true;
        return { ...node, position };
    });

    return changed ? next : null;
}

/** 可见节点的世界包围盒，供「适配视图」使用。 */
export function boundsOfNodes(nodes: CanvasNodeData[]): Bounds | null {
    if (!nodes.length) return null;
    return boundsOf(nodes);
}
