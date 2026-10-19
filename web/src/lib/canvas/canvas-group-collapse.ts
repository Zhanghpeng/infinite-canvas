import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

/** Child nodes link back to their container through `metadata.groupId`. */
function buildChildrenIndex(nodes: CanvasNodeData[]) {
    const index = new Map<string, string[]>();
    for (const node of nodes) {
        const groupId = node.metadata?.groupId;
        if (!groupId) continue;
        const children = index.get(groupId);
        if (children) children.push(node.id);
        else index.set(groupId, [node.id]);
    }
    return index;
}

/** All descendants of a group (nested groups included). The group itself is not part of the result. */
export function collectGroupDescendantIds(groupId: string, nodes: CanvasNodeData[]): Set<string> {
    const childrenByGroup = buildChildrenIndex(nodes);
    const descendants = new Set<string>();
    const queue = [...(childrenByGroup.get(groupId) || [])];
    while (queue.length) {
        const id = queue.shift() as string;
        if (descendants.has(id)) continue;
        descendants.add(id);
        queue.push(...(childrenByGroup.get(id) || []));
    }
    // Cyclic membership would otherwise report the group as its own descendant.
    descendants.delete(groupId);
    return descendants;
}

/** Ids that are hidden because some ancestor group is collapsed. */
export function collectCollapsedNodeIds(nodes: CanvasNodeData[]): Set<string> {
    const hidden = new Set<string>();
    for (const node of nodes) {
        if (node.type !== CanvasNodeType.Group || !node.metadata?.collapsed) continue;
        for (const id of collectGroupDescendantIds(node.id, nodes)) hidden.add(id);
    }
    return hidden;
}

/** A node is locked when it is locked itself or sits inside a locked group. */
export function isNodeLocked(node: CanvasNodeData, nodes: CanvasNodeData[]): boolean {
    if (node.metadata?.locked) return true;
    const nodeById = new Map(nodes.map((item) => [item.id, item]));
    const visited = new Set<string>();
    let groupId = node.metadata?.groupId;
    while (groupId && !visited.has(groupId)) {
        visited.add(groupId);
        const group = nodeById.get(groupId);
        if (!group) return false;
        if (group.metadata?.locked) return true;
        groupId = group.metadata?.groupId;
    }
    return false;
}
