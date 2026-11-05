import { CanvasNodeType, type CanvasConnection, type CanvasNodeData, type ConnectionHandle } from "@/types/canvas";
import { getModelProfile, imageQwen21Profile, textQwen35Profile, videoMinimaxH3OmniProfile } from "@/services/api/models";
import { getGroupResourceNodes } from "@/lib/canvas/canvas-resource-references";
import { getNodeDefinition } from "@/lib/canvas/node-registry";

export function nodeBounds(nodes: CanvasNodeData[]) {
    return nodes.reduce(
        (acc, node) => ({
            left: Math.min(acc.left, node.position.x),
            top: Math.min(acc.top, node.position.y),
            right: Math.max(acc.right, node.position.x + node.width),
            bottom: Math.max(acc.bottom, node.position.y + node.height),
        }),
        { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity },
    );
}

/**
 * 参考图落位：优先贴到目标节点左侧，其次右侧、上方。
 *
 * 「插入为参考图」如果仍按居中插入，新图会正好盖住目标节点，用户看不到
 * "参考图 → 主体"这层关系，还得手动拖开。左侧是连线输入端，符合从左往右的阅读习惯。
 */
export function findBesidePosition(
    anchor: CanvasNodeData,
    size: { width: number; height: number },
    nodes: CanvasNodeData[],
    options: { gutter?: number; visible?: { left: number; top: number; right: number; bottom: number } } = {},
) {
    const { gutter = 80, visible } = options;
    const centeredY = anchor.position.y + anchor.height / 2 - size.height / 2;
    const centeredX = anchor.position.x + anchor.width / 2 - size.width / 2;
    const candidates = [
        { x: anchor.position.x - size.width - gutter, y: centeredY },
        { x: anchor.position.x + anchor.width + gutter, y: centeredY },
        { x: centeredX, y: anchor.position.y - size.height - gutter },
        { x: centeredX, y: anchor.position.y + anchor.height + gutter },
    ];
    const blocks = nodes.filter((node) => node.type !== CanvasNodeType.Group);
    const overlaps = (position: { x: number; y: number }) =>
        blocks.some(
            (node) =>
                position.x < node.position.x + node.width &&
                position.x + size.width > node.position.x &&
                position.y < node.position.y + node.height &&
                position.y + size.height > node.position.y,
        );
    const clamp = (position: { x: number; y: number }) => {
        if (!visible) return position;
        const margin = 16;
        return {
            x: Math.min(Math.max(position.x, visible.left + margin), Math.max(visible.left + margin, visible.right - size.width - margin)),
            y: Math.min(Math.max(position.y, visible.top + margin), Math.max(visible.top + margin, visible.bottom - size.height - margin)),
        };
    };
    // 先按"不压住任何节点"选好方位，再夹进视口；
    // 夹进来反而压住目标（视口太窄时常见）就宁可保留原方位，让侧栏盖一点也不能盖住主体。
    const seen = candidates.find((candidate) => !overlaps(candidate));
    if (!seen) return clamp(candidates[0]);
    const clamped = clamp(seen);
    return overlaps(clamped) ? seen : clamped;
}

/**
 * 落位：给新建节点找一块不压住别人的地方。
 *
 * 素材库插入不给坐标时都落在视口正中，连点三张会叠成一摞，用户看不出插了几张。策略分三档：
 *   1. 右侧还有空位 → 横向排开（同一行放得下就一路往右）
 *   2. 下方还有空位 → 另起一行
 *   3. 视口被占满 → 沿右下阶梯错开 48px，并夹在视口内，至少让标题栏露出来
 * 分组节点不算占位（它只是视觉容器）。
 */
export function findStaggeredPosition(
    nodes: CanvasNodeData[],
    size: { width: number; height: number },
    center: { x: number; y: number },
    options: { gutter?: number; maxSteps?: number; visible?: { left: number; top: number; right: number; bottom: number } } = {},
) {
    const { gutter = 16, maxSteps = 6, visible } = options;
    const margin = 16;
    const base = { x: center.x - size.width / 2, y: center.y - size.height / 2 };
    const blocks = nodes.filter((node) => node.type !== CanvasNodeType.Group);
    const overlaps = (position: { x: number; y: number }) =>
        blocks.some(
            (node) =>
                position.x < node.position.x + node.width &&
                position.x + size.width > node.position.x &&
                position.y < node.position.y + node.height &&
                position.y + size.height > node.position.y,
        );
    // 要求"露出一块能看见的部分"，不是完整包含：素材图常常比视口还高，
    // 按完整包含判定会把所有候选否掉；但只按 1px 相交又会把节点摆到屏幕外。
    const inside = (position: { x: number; y: number }) => {
        if (!visible) return true;
        const overlapWidth = Math.min(position.x + size.width, visible.right) - Math.max(position.x, visible.left);
        const overlapHeight = Math.min(position.y + size.height, visible.bottom) - Math.max(position.y, visible.top);
        return overlapWidth >= Math.min(240, size.width) && overlapHeight >= Math.min(120, size.height);
    };

    const candidates: Array<{ x: number; y: number }> = [base];
    for (let step = 1; step <= maxSteps; step += 1) {
        candidates.push({ x: base.x + step * (size.width + gutter), y: base.y });
    }
    for (let step = 1; step <= maxSteps; step += 1) {
        candidates.push({ x: base.x, y: base.y + step * (size.height + gutter) });
    }

    const clamp = (position: { x: number; y: number }) => {
        if (!visible) return position;
        const minX = visible.left + margin;
        const minY = visible.top + margin;
        const maxX = Math.max(minX, visible.right - size.width - margin);
        const maxY = Math.max(minY, visible.bottom - size.height - margin);
        return { x: Math.min(Math.max(position.x, minX), maxX), y: Math.min(Math.max(position.y, minY), maxY) };
    };

    const found = candidates.find((candidate) => !overlaps(candidate) && inside(candidate));
    if (found) return found;
    // 视口放不下第二张时，退回 48px 错位：至少能看到又插了一张，也能直接拖开。
    return clamp({ x: base.x + 48, y: base.y + 48 });
}

export function findGroupDropTarget(movedIds: Set<string>, nodes: CanvasNodeData[]) {
    if (nodes.some((node) => movedIds.has(node.id) && node.type === CanvasNodeType.Group)) return null;
    const movingNodes = nodes.filter((node) => movedIds.has(node.id) && node.type !== CanvasNodeType.Group);
    if (!movingNodes.length) return null;
    return (
        [...nodes].reverse().find((group) => {
            if (group.type !== CanvasNodeType.Group || movedIds.has(group.id)) return false;
            return movingNodes.some((node) => {
                const centerX = node.position.x + node.width / 2;
                const centerY = node.position.y + node.height / 2;
                return centerX >= group.position.x && centerX <= group.position.x + group.width && centerY >= group.position.y && centerY <= group.position.y + group.height;
            });
        }) || null
    );
}

export function snapNodesIntoGroup(movedIds: Set<string>, nodes: CanvasNodeData[], group: CanvasNodeData) {
    const movingNodes = nodes.filter((node) => movedIds.has(node.id) && node.type !== CanvasNodeType.Group);
    if (!movingNodes.length) return nodes;
    const pad = 24;
    const bounds = nodeBounds(movingNodes);
    const left = group.position.x + pad;
    const top = group.position.y + pad;
    const right = group.position.x + group.width - pad;
    const bottom = group.position.y + group.height - pad;
    const dx = bounds.right - bounds.left > right - left ? left - bounds.left : bounds.left < left ? left - bounds.left : bounds.right > right ? right - bounds.right : 0;
    const dy = bounds.bottom - bounds.top > bottom - top ? top - bounds.top : bounds.top < top ? top - bounds.top : bounds.bottom > bottom ? bottom - bounds.bottom : 0;
    return nodes.map((node) => {
        if (!movedIds.has(node.id) || node.type === CanvasNodeType.Group) return node;
        return { ...node, position: { x: node.position.x + dx, y: node.position.y + dy }, metadata: { ...node.metadata, groupId: group.id } };
    });
}

export function findContainingGroupId(node: CanvasNodeData, nodes: CanvasNodeData[]) {
    const centerX = node.position.x + node.width / 2;
    const centerY = node.position.y + node.height / 2;
    return (
        [...nodes]
            .reverse()
            .find((group) => group.type === CanvasNodeType.Group && group.id !== node.id && centerX >= group.position.x && centerX <= group.position.x + group.width && centerY >= group.position.y && centerY <= group.position.y + group.height)?.id ||
        undefined
    );
}

export const CANVAS_HANDLE_OFFSET = 12;

export type CubicBezierCurve = [Position, Position, Position, Position];

export function getCubicBezierPoint(curve: CubicBezierCurve, t: number): Position {
    const [p0, p1, p2, p3] = curve;
    const oneMinusT = 1 - t;
    const oneMinusT2 = oneMinusT * oneMinusT;
    const oneMinusT3 = oneMinusT2 * oneMinusT;
    const t2 = t * t;
    const t3 = t2 * t;

    return {
        x: oneMinusT3 * p0.x + 3 * oneMinusT2 * t * p1.x + 3 * oneMinusT * t2 * p2.x + t3 * p3.x,
        y: oneMinusT3 * p0.y + 3 * oneMinusT2 * t * p1.y + 3 * oneMinusT * t2 * p2.y + t3 * p3.y,
    };
}

export function findClosestPointOnCubicBezier(curve: CubicBezierCurve, point: Position, samples = 36): Position {
    let minD2 = Infinity;
    let bestT = 0.5;

    for (let i = 0; i <= samples; i++) {
        const t = i / samples;
        const pt = getCubicBezierPoint(curve, t);
        const d2 = (pt.x - point.x) ** 2 + (pt.y - point.y) ** 2;
        if (d2 < minD2) {
            minD2 = d2;
            bestT = t;
        }
    }

    let left = Math.max(0, bestT - 1 / samples);
    let right = Math.min(1, bestT + 1 / samples);
    for (let iter = 0; iter < 5; iter++) {
        const mid1 = left + (right - left) / 3;
        const mid2 = right - (right - left) / 3;
        const pt1 = getCubicBezierPoint(curve, mid1);
        const pt2 = getCubicBezierPoint(curve, mid2);
        const d1 = (pt1.x - point.x) ** 2 + (pt1.y - point.y) ** 2;
        const d2 = (pt2.x - point.x) ** 2 + (pt2.y - point.y) ** 2;
        if (d1 < d2) {
            right = mid2;
        } else {
            left = mid1;
        }
    }

    return getCubicBezierPoint(curve, (left + right) / 2);
}

export function getConnectionTargetAnchor(node: CanvasNodeData, current: ConnectionHandle) {
    return {
        x: current.handleType === "source" ? node.position.x - CANVAS_HANDLE_OFFSET : node.position.x + node.width + CANVAS_HANDLE_OFFSET,
        y: node.position.y + node.height / 2,
    };
}

export type NodeResourceCounts = {
    images: number;
    videos: number;
    audios: number;
};

export function getNodeResourceCounts(node: CanvasNodeData, allNodes: CanvasNodeData[]): NodeResourceCounts {
    if (node.type === CanvasNodeType.Group) {
        const children = getGroupResourceNodes(node.id, allNodes);
        return children.reduce(
            (acc, child) => {
                const c = getNodeResourceCounts(child, allNodes);
                return {
                    images: acc.images + c.images,
                    videos: acc.videos + c.videos,
                    audios: acc.audios + c.audios,
                };
            },
            { images: 0, videos: 0, audios: 0 },
        );
    }

    if (node.type === CanvasNodeType.Image) return { images: 1, videos: 0, audios: 0 };
    if (node.type === CanvasNodeType.Video) return { images: 0, videos: 1, audios: 0 };
    if (node.type === CanvasNodeType.Audio) return { images: 0, videos: 0, audios: 1 };

    const res = getNodeDefinition(node.type)?.resource?.(node);
    if (res?.kind === "image") return { images: 1, videos: 0, audios: 0 };
    if (res?.kind === "video") return { images: 0, videos: 1, audios: 0 };
    if (res?.kind === "audio") return { images: 0, videos: 0, audios: 1 };

    return { images: 0, videos: 0, audios: 0 };
}

export function validateInputConnection(
    fromNodeId: string,
    toNodeId: string,
    nodes: CanvasNodeData[],
    connections: CanvasConnection[] = [],
): { fromNodeId: string; toNodeId: string } | null {
    const fromNode = nodes.find((node) => node.id === fromNodeId);
    const toNode = nodes.find((node) => node.id === toNodeId);
    if (!fromNode || !toNode) return null;
    if (fromNodeId === toNodeId) return null;
    if (toNode.type === CanvasNodeType.Group) return null;
    if (fromNode.type === CanvasNodeType.Config) return null;
    if (connections.some((connection) => connection.fromNodeId === fromNodeId && connection.toNodeId === toNodeId)) return null;

    // 针对绑定了模型 DSL 的节点进行配额与多模态类型边界校验
    const modelId = toNode.metadata?.modelId || toNode.metadata?.videoMode || toNode.metadata?.model;
    const profile = getModelProfile(modelId) || (
        toNode.type === CanvasNodeType.Video
            ? videoMinimaxH3OmniProfile
            : toNode.type === CanvasNodeType.Image
            ? imageQwen21Profile
            : toNode.type === CanvasNodeType.Text
            ? textQwen35Profile
            : undefined
    );

    if (profile?.capabilityConfig.references) {
        const refs = profile.capabilityConfig.references;
        const incoming = getNodeResourceCounts(fromNode, nodes);

        // 严格拦截当前模型不支持的媒体类型
        if ((refs.maxImages ?? 0) === 0 && incoming.images > 0) return null;
        if ((refs.maxVideos ?? 0) === 0 && incoming.videos > 0) return null;
        if ((refs.maxAudios ?? 0) === 0 && incoming.audios > 0) return null;

        // 统计当前节点既有连线占用的资源配额
        const existingConnections = connections.filter(
            (c) => c.toNodeId === toNodeId && c.kind === "input" && c.fromNodeId !== fromNodeId,
        );
        let existingImages = 0;
        let existingVideos = 0;
        let existingAudios = 0;

        for (const conn of existingConnections) {
            const src = nodes.find((n) => n.id === conn.fromNodeId);
            if (!src) continue;
            const counts = getNodeResourceCounts(src, nodes);
            existingImages += counts.images;
            existingVideos += counts.videos;
            existingAudios += counts.audios;
        }

        if (refs.maxImages !== undefined && existingImages + incoming.images > refs.maxImages) {
            return null;
        }
        if (refs.maxVideos !== undefined && existingVideos + incoming.videos > refs.maxVideos) {
            return null;
        }
        if (refs.maxAudios !== undefined && existingAudios + incoming.audios > refs.maxAudios) {
            return null;
        }
    }

    return { fromNodeId, toNodeId };
}

export type ConnectionRejectionDetail = {
    key:
        | "connectionAlreadyExists"
        | "connectionMediaTypeUnsupported"
        | "connectionQuotaImagesExceeded"
        | "connectionQuotaVideosExceeded"
        | "connectionQuotaAudiosExceeded"
        | "connectionQuotaExceeded";
    params?: { max?: number; current?: number; incoming?: number };
    defaultMessage: string;
};

/**
 * 诊断连线被拒绝的具体原因（用于向用户输出友好的诊断提示）
 */
export function getConnectionRejectionDetail(
    fromNodeId: string,
    toNodeId: string,
    nodes: CanvasNodeData[],
    connections: CanvasConnection[] = [],
): ConnectionRejectionDetail | null {
    const fromNode = nodes.find((node) => node.id === fromNodeId);
    const toNode = nodes.find((node) => node.id === toNodeId);
    if (!fromNode || !toNode || fromNodeId === toNodeId || toNode.type === CanvasNodeType.Group || fromNode.type === CanvasNodeType.Config) {
        return null;
    }

    if (connections.some((connection) => connection.fromNodeId === fromNodeId && connection.toNodeId === toNodeId)) {
        return {
            key: "connectionAlreadyExists",
            defaultMessage: "连接已存在",
        };
    }

    const modelId = toNode.metadata?.modelId || toNode.metadata?.videoMode || toNode.metadata?.model;
    const profile = getModelProfile(modelId) || (
        toNode.type === CanvasNodeType.Video
            ? videoMinimaxH3OmniProfile
            : toNode.type === CanvasNodeType.Image
            ? imageQwen21Profile
            : toNode.type === CanvasNodeType.Text
            ? textQwen35Profile
            : undefined
    );

    if (profile?.capabilityConfig.references) {
        const refs = profile.capabilityConfig.references;
        const incoming = getNodeResourceCounts(fromNode, nodes);

        if ((refs.maxImages ?? 0) === 0 && incoming.images > 0) {
            return {
                key: "connectionMediaTypeUnsupported",
                defaultMessage: profile.capability === "text"
                    ? "连接被拒绝：该模型不支持连入参考图片"
                    : "连接被拒绝：当前模型不支持参考图",
            };
        }
        if ((refs.maxVideos ?? 0) === 0 && incoming.videos > 0) {
            return {
                key: "connectionMediaTypeUnsupported",
                defaultMessage: "连接被拒绝：当前模型不支持参考视频",
            };
        }
        if ((refs.maxAudios ?? 0) === 0 && incoming.audios > 0) {
            return {
                key: "connectionMediaTypeUnsupported",
                defaultMessage: "连接被拒绝：当前模型不支持参考音频",
            };
        }

        const existingConnections = connections.filter(
            (c) => c.toNodeId === toNodeId && c.kind === "input" && c.fromNodeId !== fromNodeId,
        );
        let existingImages = 0;
        let existingVideos = 0;
        let existingAudios = 0;

        for (const conn of existingConnections) {
            const src = nodes.find((n) => n.id === conn.fromNodeId);
            if (!src) continue;
            const counts = getNodeResourceCounts(src, nodes);
            existingImages += counts.images;
            existingVideos += counts.videos;
            existingAudios += counts.audios;
        }

        if (refs.maxImages !== undefined && existingImages + incoming.images > refs.maxImages) {
            return {
                key: "connectionQuotaImagesExceeded",
                params: { max: refs.maxImages, current: existingImages, incoming: incoming.images },
                defaultMessage: `连接被拒绝：超出参考图上限（该模型最多支持 ${refs.maxImages} 张，当前已有 ${existingImages} 张）`,
            };
        }
        if (refs.maxVideos !== undefined && existingVideos + incoming.videos > refs.maxVideos) {
            return {
                key: "connectionQuotaVideosExceeded",
                params: { max: refs.maxVideos, current: existingVideos, incoming: incoming.videos },
                defaultMessage: `连接被拒绝：超出参考视频上限（该模型最多支持 ${refs.maxVideos} 个，当前已有 ${existingVideos} 个）`,
            };
        }
        if (refs.maxAudios !== undefined && existingAudios + incoming.audios > refs.maxAudios) {
            return {
                key: "connectionQuotaAudiosExceeded",
                params: { max: refs.maxAudios, current: existingAudios, incoming: incoming.audios },
                defaultMessage: `连接被拒绝：超出参考音频上限（该模型最多支持 ${refs.maxAudios} 个，当前已有 ${existingAudios} 个）`,
            };
        }
    }

    return null;
}

/**
 * 探测指定节点当前输入连线中超出模型 DSL 配额或类型不兼容的既有连线 ID 集合
 */
export function findInvalidNodeConnections(
    toNodeId: string,
    nodes: CanvasNodeData[],
    connections: CanvasConnection[],
): Set<string> {
    const invalidIds = new Set<string>();
    const toNode = nodes.find((n) => n.id === toNodeId);
    if (!toNode) return invalidIds;

    const modelId = toNode.metadata?.modelId || toNode.metadata?.videoMode || toNode.metadata?.model;
    // 文本节点也要按 DSL 兜底判一遍（此前缺了 Text 分支，超配的参考图不会标红）。
    const profile =
        getModelProfile(modelId) ||
        (toNode.type === CanvasNodeType.Video
            ? videoMinimaxH3OmniProfile
            : toNode.type === CanvasNodeType.Image
            ? imageQwen21Profile
            : toNode.type === CanvasNodeType.Text
            ? textQwen35Profile
            : undefined);
    if (!profile?.capabilityConfig.references) return invalidIds;

    const refs = profile.capabilityConfig.references;
    const incomingConnections = connections.filter((c) => c.toNodeId === toNodeId && c.kind === "input");

    let imagesCount = 0;
    let videosCount = 0;
    let audiosCount = 0;

    for (const conn of incomingConnections) {
        const fromNode = nodes.find((n) => n.id === conn.fromNodeId);
        if (!fromNode) {
            invalidIds.add(conn.id);
            continue;
        }

        const counts = getNodeResourceCounts(fromNode, nodes);
        let isInvalid = false;

        // 校验图片配额
        if (counts.images > 0) {
            if ((refs.maxImages ?? 0) === 0 || imagesCount + counts.images > (refs.maxImages ?? Infinity)) {
                isInvalid = true;
            } else {
                imagesCount += counts.images;
            }
        }

        // 校验视频配额
        if (counts.videos > 0) {
            if ((refs.maxVideos ?? 0) === 0 || videosCount + counts.videos > (refs.maxVideos ?? Infinity)) {
                isInvalid = true;
            } else {
                videosCount += counts.videos;
            }
        }

        // 校验音频配额
        if (counts.audios > 0) {
            if ((refs.maxAudios ?? 0) === 0 || audiosCount + counts.audios > (refs.maxAudios ?? Infinity)) {
                isInvalid = true;
            } else {
                audiosCount += counts.audios;
            }
        }

        if (isInvalid) {
            invalidIds.add(conn.id);
        }
    }

    return invalidIds;
}

/**
 * 汇总全画布所有输入连线中超出模型 DSL 配额或类型不合规的连线集合
 */
export function getAllInvalidConnectionIds(
    nodes: CanvasNodeData[],
    connections: CanvasConnection[],
): Set<string> {
    const allInvalid = new Set<string>();
    const targetNodeIds = new Set(connections.filter((c) => c.kind === "input").map((c) => c.toNodeId));
    for (const targetId of targetNodeIds) {
        const invalidForTarget = findInvalidNodeConnections(targetId, nodes, connections);
        for (const id of invalidForTarget) {
            allInvalid.add(id);
        }
    }
    return allInvalid;
}

export function normalizeConnection(
    firstNodeId: string,
    secondNodeId: string,
    nodes: CanvasNodeData[],
    firstHandleType: "source" | "target",
    connections: CanvasConnection[] = [],
) {
    const first = nodes.find((node) => node.id === firstNodeId);
    const second = nodes.find((node) => node.id === secondNodeId);
    if (!first || !second) return null;
    const [fromNodeId, toNodeId] =
        first.type === CanvasNodeType.Config && firstHandleType === "target"
            ? [second.id, first.id]
            : [first.id, second.id];
    return validateInputConnection(fromNodeId, toNodeId, nodes, connections);
}

/**
 * 检查节点是否与指定的组相交或被其包含（判定标准：节点中心落在组内）
 */
export function isNodeEnclosedInGroup(node: CanvasNodeData, group: CanvasNodeData): boolean {
    if (node.id === group.id || node.type === CanvasNodeType.Group) return false;
    const centerX = node.position.x + node.width / 2;
    const centerY = node.position.y + node.height / 2;
    return (
        centerX >= group.position.x &&
        centerX <= group.position.x + group.width &&
        centerY >= group.position.y &&
        centerY <= group.position.y + group.height
    );
}

/**
 * 根据一组目标节点计算包围该组节点的 Group 容器参数（带 padding）
 */
export function calculateGroupBoundsForNodes(
    nodes: CanvasNodeData[],
    padX = 36,
    padTop = 44,
    padBottom = 36,
): { x: number; y: number; width: number; height: number } {
    if (!nodes.length) {
        return { x: 0, y: 0, width: 760, height: 480 };
    }
    const bounds = nodeBounds(nodes);
    const contentW = bounds.right - bounds.left + padX * 2;
    const contentH = bounds.bottom - bounds.top + padTop + padBottom;
    const extraW = Math.max(0, 280 - contentW);
    const extraH = Math.max(0, 200 - contentH);

    return {
        x: bounds.left - padX - extraW / 2,
        y: bounds.top - padTop - extraH / 2,
        width: contentW + extraW,
        height: contentH + extraH,
    };
}

/**
 * 调整指定组节点的尺寸与位置，使其紧密自适应包裹组内所有子节点
 */
export function fitGroupToEnclosedChildren(
    groupId: string,
    nodes: CanvasNodeData[],
    padX = 36,
    padTop = 44,
    padBottom = 36,
): CanvasNodeData[] {
    const group = nodes.find((n) => n.id === groupId && n.type === CanvasNodeType.Group);
    if (!group) return nodes;
    const children = nodes.filter((n) => n.metadata?.groupId === groupId);
    if (!children.length) return nodes;

    const newBounds = calculateGroupBoundsForNodes(children, padX, padTop, padBottom);
    return nodes.map((node) => {
        if (node.id !== groupId) return node;
        return {
            ...node,
            position: { x: newBounds.x, y: newBounds.y },
            width: newBounds.width,
            height: newBounds.height,
        };
    });
}

/**
 * 一键吸附：将几何位置落在指定组内的所有非组节点归入该组
 */
export function captureEnclosedNodesIntoGroup(
    groupId: string,
    nodes: CanvasNodeData[],
): { nextNodes: CanvasNodeData[]; capturedCount: number } {
    const group = nodes.find((n) => n.id === groupId && n.type === CanvasNodeType.Group);
    if (!group) return { nextNodes: nodes, capturedCount: 0 };

    let capturedCount = 0;
    const nextNodes = nodes.map((node) => {
        if (node.type === CanvasNodeType.Group || node.id === groupId) return node;
        if (isNodeEnclosedInGroup(node, group)) {
            if (node.metadata?.groupId !== groupId) {
                capturedCount++;
                return { ...node, metadata: { ...node.metadata, groupId } };
            }
        }
        return node;
    });

    return { nextNodes, capturedCount };
}

/**
 * 解散组：删除指定组节点，并将该组内所有子节点的 groupId 清除
 */
export function ungroupCanvasGroup(groupId: string, nodes: CanvasNodeData[]): CanvasNodeData[] {
    return nodes
        .filter((node) => node.id !== groupId)
        .map((node) => {
            if (node.metadata?.groupId === groupId) {
                return { ...node, metadata: { ...node.metadata, groupId: undefined } };
            }
            return node;
        });
}

/**
 * 组发生移动或缩放后，自动同步节点所属组关系
 */
export function syncGroupMembershipAfterTransform(
    groupNodeId: string,
    nodes: CanvasNodeData[],
): CanvasNodeData[] {
    const group = nodes.find((n) => n.id === groupNodeId && n.type === CanvasNodeType.Group);
    if (!group) return nodes;

    return nodes.map((node) => {
        if (node.type === CanvasNodeType.Group) return node;
        const isInside = isNodeEnclosedInGroup(node, group);
        if (isInside) {
            if (node.metadata?.groupId !== group.id) {
                return { ...node, metadata: { ...node.metadata, groupId: group.id } };
            }
        } else if (node.metadata?.groupId === group.id) {
            // 原先属于该组但缩放或移动后脱离了该组
            const containingGroupId = findContainingGroupId(node, nodes);
            return { ...node, metadata: { ...node.metadata, groupId: containingGroupId } };
        }
        return node;
    });
}

