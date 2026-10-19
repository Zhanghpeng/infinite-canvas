// 背景板：从画布图片节点解析出可用的背景来源（只记 nodeId，图重新生成后自动更新）。
import { describe, expect, it } from "vitest";

// eslint-disable-next-line import/first
import { backdropUnavailable, imageNodeUrl, listImageNodeOptions, resolveBackdropSource } from "../../../../../plugins/canvas/director-stage/src/backdrop";
// eslint-disable-next-line import/first
import { checkScene } from "../../../../../plugins/canvas/director-stage/src/check";
// eslint-disable-next-line import/first
import { createDefaultStageState, normalizeBackdrop, normalizeStageState } from "../../../../../plugins/canvas/director-stage/src/stage-state";

const imageNode = (id: string, title: string, content?: string) => ({ id, type: "image", title, position: { x: 0, y: 0 }, width: 320, height: 180, metadata: content ? { content } : {} });

describe("背景板来源解析", () => {
    const nodes = [imageNode("b", "B 街景", "blob:b"), imageNode("a", "A 房间", "blob:a"), imageNode("c", "C 生成中"), { id: "t", type: "text", title: "文本", position: { x: 0, y: 0 }, width: 1, height: 1, metadata: { content: "x" } }] as never[];

    it("下拉只列图片节点、标出有没有画面、按标题排序", () => {
        expect(listImageNodeOptions(nodes)).toEqual([
            { id: "a", title: "A 房间", ready: true },
            { id: "b", title: "B 街景", ready: true },
            { id: "c", title: "C 生成中", ready: false },
        ]);
    });

    it("解析：只有「有画面的图片节点」才给来源", () => {
        expect(resolveBackdropSource(nodes, "a")).toEqual({ nodeId: "a", title: "A 房间", url: "blob:a" });
        expect(resolveBackdropSource(nodes, "c")).toBeNull();
        expect(resolveBackdropSource(nodes, "t")).toBeNull();
        expect(resolveBackdropSource(nodes, "nope")).toBeNull();
        expect(resolveBackdropSource(nodes, undefined)).toBeNull();
        expect(imageNodeUrl(imageNode("x", "x", "  ") as never)).toBe("");
    });

    it("引用还在但没画面时能被识别（自检与状态行用）", () => {
        expect(backdropUnavailable(nodes, "c")).toMatchObject({ nodeId: "c", title: "C 生成中" });
        expect(backdropUnavailable(nodes, "gone")).toMatchObject({ nodeId: "gone" });
        expect(backdropUnavailable(nodes, "a")).toBeNull();
        expect(backdropUnavailable(nodes, undefined)).toBeNull();
    });

    it("归一化：缺 nodeId 一律当没有；hideEnvironment 默认 true", () => {
        expect(normalizeBackdrop(undefined)).toBeUndefined();
        expect(normalizeBackdrop({})).toBeUndefined();
        expect(normalizeBackdrop({ nodeId: "   " })).toBeUndefined();
        expect(normalizeBackdrop({ nodeId: " img-1 " })).toEqual({ nodeId: "img-1" });
        expect(normalizeBackdrop({ nodeId: "img-1", title: "夜街", hideEnvironment: false })).toEqual({ nodeId: "img-1", title: "夜街", hideEnvironment: false });
        expect(normalizeStageState({ ...createDefaultStageState(), backdrop: { nodeId: "img-9", hideEnvironment: true } }).backdrop).toEqual({ nodeId: "img-9" });
        expect(normalizeStageState(createDefaultStageState()).backdrop).toBeUndefined();
    });

    it("自检：背景板引用的图没画面时提醒（有画面 / 没设背景板都不报）", () => {
        const base = { ...createDefaultStageState(), backdrop: { nodeId: "img-2", title: "空镜" } };
        const warn = checkScene(base, { backdropUnavailable: { nodeId: "img-2", title: "空镜" } });
        expect(warn.issues.map((issue) => issue.code)).toContain("backdrop-unavailable");
        expect(warn.issues.find((issue) => issue.code === "backdrop-unavailable")?.text).toContain("空镜");
        expect(warn.ok).toBe(true);
        expect(checkScene(base, { backdropUnavailable: null }).issues.map((issue) => issue.code)).not.toContain("backdrop-unavailable");
        expect(checkScene(createDefaultStageState(), { backdropUnavailable: { nodeId: "x", title: "x" } }).issues.map((issue) => issue.code)).not.toContain("backdrop-unavailable");
    });
});
