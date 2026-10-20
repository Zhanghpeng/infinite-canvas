import { describe, expect, it } from "vitest";

import { alignSelectedNodes, boundsOfNodes, distributeSelectedNodes } from "../canvas-layout-actions";
import type { CanvasNodeData } from "@/types/canvas";

function node(id: string, x: number, y: number, width: number, height: number): CanvasNodeData {
    return { id, type: "image", title: id, position: { x, y }, width, height };
}

const ids = (...list: string[]) => new Set(list);
const positionOf = (nodes: CanvasNodeData[], id: string) => nodes.find((item) => item.id === id)!.position;

describe("alignSelectedNodes", () => {
    it("左对齐到选集左边界，宽度不同的节点右边缘不强制拉齐", () => {
        const nodes = [node("a", 100, 0, 100, 100), node("b", 260, 40, 60, 60)];
        const next = alignSelectedNodes(nodes, ids("a", "b"), "left")!;
        expect(positionOf(next, "a")).toEqual({ x: 100, y: 0 });
        expect(positionOf(next, "b")).toEqual({ x: 100, y: 40 });
    });

    it("水平居中按选区中线对齐，而不是各自中心", () => {
        const nodes = [node("a", 0, 0, 100, 100), node("b", 200, 0, 40, 40)];
        const next = alignSelectedNodes(nodes, ids("a", "b"), "centerX")!;
        // 选区 0..240，中线 120
        expect(positionOf(next, "a").x).toBe(70);
        expect(positionOf(next, "b").x).toBe(100);
    });

    it("右对齐贴到选区右边界", () => {
        const nodes = [node("a", 0, 0, 100, 100), node("b", 200, 0, 40, 40)];
        const next = alignSelectedNodes(nodes, ids("a", "b"), "right")!;
        expect(positionOf(next, "a").x).toBe(140);
        expect(positionOf(next, "b").x).toBe(200);
    });

    it("只在指定轴上移动，另一个轴原样保留", () => {
        const nodes = [node("a", 10, 10, 50, 50), node("b", 80, 200, 50, 50)];
        const next = alignSelectedNodes(nodes, ids("a", "b"), "top")!;
        expect(positionOf(next, "a")).toEqual({ x: 10, y: 10 });
        expect(positionOf(next, "b")).toEqual({ x: 80, y: 10 });
    });

    it("少于两个节点返回 null（单个节点无处可对齐）", () => {
        expect(alignSelectedNodes([node("a", 0, 0, 10, 10)], ids("a"), "left")).toBeNull();
    });

    it("已经对齐时返回 null，不产生无意义的历史记录", () => {
        const nodes = [node("a", 0, 0, 100, 100), node("b", 0, 120, 60, 60)];
        expect(alignSelectedNodes(nodes, ids("a", "b"), "left")).toBeNull();
    });

    it("锁定节点不参与，也不被移动", () => {
        const nodes = [node("a", 100, 0, 100, 100), node("b", 300, 40, 60, 60), node("locked", 500, 0, 40, 40)];
        const next = alignSelectedNodes(nodes, ids("a", "b", "locked"), "left", { lockedIds: ids("locked") })!;
        expect(positionOf(next, "b").x).toBe(100);
        expect(positionOf(next, "locked").x).toBe(500);
    });

    it("只选两个锁定节点时返回 null", () => {
        const nodes = [node("a", 100, 0, 100, 100), node("b", 300, 40, 60, 60)];
        expect(alignSelectedNodes(nodes, ids("a", "b"), "left", { lockedIds: ids("a", "b") })).toBeNull();
    });
});

describe("distributeSelectedNodes", () => {
    it("水平等间距：首尾不动，中间按留白一致排开", () => {
        // 跨度 0..400，总宽 100+100+100=300，两段间距各 50
        const nodes = [node("a", 0, 0, 100, 100), node("b", 120, 0, 100, 100), node("c", 300, 0, 100, 100)];
        const next = distributeSelectedNodes(nodes, ids("a", "b", "c"), "horizontal")!;
        expect(positionOf(next, "a").x).toBe(0);
        expect(positionOf(next, "b").x).toBe(150);
        expect(positionOf(next, "c").x).toBe(300);
    });

    it("宽窄不一时仍保证留白一致（这是与等中心分布的区别）", () => {
        // 跨度 0..400，总宽 60+160+60=280，两段间距各 60
        const nodes = [node("a", 0, 0, 60, 60), node("b", 100, 0, 160, 60), node("c", 340, 0, 60, 60)];
        const next = distributeSelectedNodes(nodes, ids("a", "b", "c"), "horizontal")!;
        expect(positionOf(next, "a").x).toBe(0);
        expect(positionOf(next, "b").x).toBe(120);
        expect(positionOf(next, "c").x).toBe(340);
    });

    it("垂直分布按 y 轴排序，与数组顺序无关", () => {
        const nodes = [node("c", 0, 400, 40, 100), node("a", 0, 0, 40, 100), node("b", 0, 130, 40, 100)];
        const next = distributeSelectedNodes(nodes, ids("a", "b", "c"), "vertical")!;
        expect(positionOf(next, "a").y).toBe(0);
        expect(positionOf(next, "b").y).toBe(200);
        expect(positionOf(next, "c").y).toBe(400);
    });

    it("节点总尺寸超过跨度时退回等中心分布，不产生负间距重叠", () => {
        const nodes = [node("a", 0, 0, 200, 100), node("b", 30, 0, 200, 100), node("c", 100, 0, 200, 100)];
        const next = distributeSelectedNodes(nodes, ids("a", "b", "c"), "horizontal")!;
        // 中心 100 / 200（跨度 0..300），中间节点中心对齐到 150，即 x = 50
        expect(positionOf(next, "a").x).toBe(0);
        expect(positionOf(next, "b").x).toBe(50);
        expect(positionOf(next, "c").x).toBe(100);
    });

    it("少于三个节点返回 null（两个节点之间没有可分布的空间）", () => {
        const nodes = [node("a", 0, 0, 10, 10), node("b", 100, 0, 10, 10)];
        expect(distributeSelectedNodes(nodes, ids("a", "b"), "horizontal")).toBeNull();
    });

    it("间距已均匀时返回 null", () => {
        const nodes = [node("a", 0, 0, 100, 100), node("b", 150, 0, 100, 100), node("c", 300, 0, 100, 100)];
        expect(distributeSelectedNodes(nodes, ids("a", "b", "c"), "horizontal")).toBeNull();
    });
});

describe("boundsOfNodes", () => {
    it("覆盖所有节点的外接矩形", () => {
        expect(boundsOfNodes([node("a", 10, 20, 100, 50), node("b", -30, 100, 40, 40)])).toEqual({ left: -30, top: 20, right: 110, bottom: 140 });
    });

    it("空数组返回 null", () => {
        expect(boundsOfNodes([])).toBeNull();
    });
});
