import { describe, expect, it } from "vitest";

import { findBesidePosition, findStaggeredPosition } from "@/lib/canvas/canvas-node-geometry";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

const node = (id: string, x: number, y: number, width: number, height: number) =>
    ({ id, type: CanvasNodeType.Image, position: { x, y }, width, height }) as CanvasNodeData;

const overlaps = (a: { x: number; y: number; width: number; height: number }, b: CanvasNodeData) =>
    a.x < b.position.x + b.width && a.x + a.width > b.position.x && a.y < b.position.y + b.height && a.y + a.height > b.position.y;

describe("findStaggeredPosition", () => {
    it("空画布时落在中心", () => {
        const position = findStaggeredPosition([], { width: 200, height: 300 }, { x: 500, y: 400 });
        expect(position).toEqual({ x: 400, y: 250 });
    });

    it("中心被占用时错开且不重叠", () => {
        const existing = node("a", 400, 250, 200, 300);
        const position = findStaggeredPosition([existing], { width: 200, height: 300 }, { x: 500, y: 400 });
        expect(overlaps({ ...position, width: 200, height: 300 }, existing)).toBe(false);
    });

    it("连续插入三张互不重叠", () => {
        const placed: CanvasNodeData[] = [];
        for (let index = 0; index < 3; index += 1) {
            const position = findStaggeredPosition(placed, { width: 200, height: 300 }, { x: 500, y: 400 });
            expect(placed.some((item) => overlaps({ ...position, width: 200, height: 300 }, item))).toBe(false);
            placed.push(node(`n${index}`, position.x, position.y, 200, 300));
        }
    });

    it("视口很小时不把节点推出可见区域", () => {
        const visible = { left: 0, top: 0, right: 640, bottom: 480 };
        const existing = node("big", 0, 0, 640, 480);
        const position = findStaggeredPosition([existing], { width: 300, height: 400 }, { x: 320, y: 240 }, { visible });
        expect(position.x).toBeGreaterThanOrEqual(visible.left);
        expect(position.y).toBeGreaterThanOrEqual(visible.top);
        expect(position.x).toBeLessThanOrEqual(visible.right);
        expect(position.y).toBeLessThanOrEqual(visible.bottom);
    });

    it("分组节点不算占位", () => {
        const group = { ...node("g", 0, 0, 900, 900), type: CanvasNodeType.Group } as CanvasNodeData;
        const position = findStaggeredPosition([group], { width: 200, height: 300 }, { x: 500, y: 400 });
        expect(position).toEqual({ x: 400, y: 250 });
    });
});

describe("findBesidePosition", () => {
    const anchor = node("main", 400, 200, 400, 600);

    it("默认贴到目标左侧", () => {
        const position = findBesidePosition(anchor, { width: 200, height: 300 }, [anchor]);
        expect(position.x).toBe(400 - 200 - 80);
        expect(position.y).toBe(200 + 300 - 150);
    });

    it("左侧被占时改到右侧", () => {
        const blocker = node("left", 100, 300, 200, 400);
        const position = findBesidePosition(anchor, { width: 200, height: 300 }, [anchor, blocker]);
        expect(position.x).toBe(400 + 400 + 80);
    });

    it("结果不压住目标节点", () => {
        const position = findBesidePosition(anchor, { width: 200, height: 300 }, [anchor]);
        expect(overlaps({ ...position, width: 200, height: 300 }, anchor)).toBe(false);
    });
});
