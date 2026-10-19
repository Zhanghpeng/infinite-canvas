import { describe, expect, it } from "vitest";

import { applyCanvasAgentOps, type CanvasAgentSnapshot } from "@/lib/canvas/canvas-agent-ops";
import { buildNodeGenerationContext } from "@/components/canvas/canvas-node-generation";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

function node(id: string, type: CanvasNodeData["type"]): CanvasNodeData {
    return { id, type, title: id, position: { x: 0, y: 0 }, width: 100, height: 100, metadata: {} };
}

const DATA_IMG = "data:image/png;base64,AA==";

const snapshot = (nodes: CanvasNodeData[]): CanvasAgentSnapshot => ({ projectId: "p", title: "t", nodes, connections: [], selectedNodeIds: [], viewport: { x: 0, y: 0, k: 1 } });

describe("connect_nodes slot", () => {
    it("carries an explicit first/last frame slot onto the connection", () => {
        const nodes = [node("imgA", CanvasNodeType.Image), node("imgB", CanvasNodeType.Image), node("video", CanvasNodeType.Video)];
        const { connections } = applyCanvasAgentOps(snapshot(nodes), [
            { type: "connect_nodes", fromNodeId: "imgA", toNodeId: "video", slot: "first_frame" },
            { type: "connect_nodes", fromNodeId: "imgB", toNodeId: "video", slot: "last_frame" },
        ]);

        expect(connections).toHaveLength(2);
        expect(connections.find((c) => c.fromNodeId === "imgA")?.slot).toBe("first_frame");
        expect(connections.find((c) => c.fromNodeId === "imgB")?.slot).toBe("last_frame");
        expect(connections.every((c) => c.kind === "input")).toBe(true);
    });

    it("keeps first before last even when the last frame was connected first", () => {
        const images = [
            { ...node("imgA", CanvasNodeType.Image), metadata: { content: DATA_IMG, mimeType: "image/png" } },
            { ...node("imgB", CanvasNodeType.Image), metadata: { content: DATA_IMG, mimeType: "image/png" } },
        ];
        const video = node("video", CanvasNodeType.Video);
        // 故意先连尾帧，再连首帧
        const { connections } = applyCanvasAgentOps(snapshot([...images, video]), [
            { type: "connect_nodes", fromNodeId: "imgB", toNodeId: "video", slot: "last_frame" },
            { type: "connect_nodes", fromNodeId: "imgA", toNodeId: "video", slot: "first_frame" },
        ]);

        const context = buildNodeGenerationContext("video", [...images, video], connections, "");
        expect(context.generationReferences.map((reference) => reference.nodeId)).toEqual(["imgA", "imgB"]);
    });

    it("still connects without a slot", () => {
        const nodes = [node("a", CanvasNodeType.Image), node("b", CanvasNodeType.Video)];
        const { connections } = applyCanvasAgentOps(snapshot(nodes), [{ type: "connect_nodes", fromNodeId: "a", toNodeId: "b" }]);
        expect(connections[0].slot).toBeUndefined();
    });
});
