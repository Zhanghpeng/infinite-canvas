// 3D 导演台插件导出动作的单测：不跑浏览器、不跑 WebGL，只喂假的 ctx + 假截图，
// 验证「截图 / 场景状态 → 画布指令」这一步是确定的（节点数、位置、槽位、分组、文本内容）。
import { describe, expect, it } from "vitest";

import { attachMotionVideoNode, exportCurrentView, exportFirstLast, exportMultiView, exportPrompt, renderMotionVideo } from "../../../../../plugins/canvas/director-stage/src/actions";
import type { CaptureSession } from "../../../../../plugins/canvas/director-stage/src/capture";
import type { CapturedFrame } from "../../../../../plugins/canvas/director-stage/src/exporter";
import { createStageShot, DEFAULT_CAMERA, DEFAULT_MOTION, type StageState } from "../../../../../plugins/canvas/director-stage/src/stage-state";

type Op = Record<string, any>;

function makeCtx(downstream: Array<{ id: string; type: string }> = [], existing: Array<Op> = []) {
    const ops: Op[] = [];
    const node = { id: "stage-1", type: "director-stage:stage", title: "3D 导演台", position: { x: 100, y: 200 }, width: 560, height: 400, metadata: {} };
    const ctx = {
        node,
        getNodes: () => [node, ...existing],
        getDownstream: () => downstream,
        applyOps: (next: Op[]) => ops.push(...next),
    };
    return { ctx: ctx as never, ops };
}

const frame = (tag: string): CapturedFrame => ({ dataUrl: `data:image/jpeg;base64,${tag}AAAA`, width: 1280, height: 720 });

/** 假的截图会话：按调用顺序依次吐出给定的帧;相机入参记下来供断言。 */
function makeSession(frames: Array<CapturedFrame | null>) {
    const calls: Array<{ camera?: unknown; elapsedMs?: number }> = [];
    let index = 0;
    const session: CaptureSession = {
        capture: async (options) => {
            calls.push({ camera: options?.camera, elapsedMs: options?.elapsedMs });
            const frame = frames[Math.min(index, frames.length - 1)] ?? null;
            index += 1;
            return frame;
        },
        dispose: () => {},
    };
    return { session, cameras: calls };
}

const state = (extra: Partial<StageState> = {}): StageState => ({
    objects: [{ id: "a", name: "人物 1", kind: "person", visible: true, x: 0, z: 0, rotationYDeg: 0, scale: 1 }],
    camera: { ...DEFAULT_CAMERA },
    shots: [],
    motion: { ...DEFAULT_MOTION },
    lighting: "day",
    exportFormat: "jpeg",
    exportHeight: 720,
    promptLocale: "zh",
    ...extra,
});

describe("导出当前机位", () => {
    it("建一张图片节点，落在导演台右侧且带完整图片 metadata", async () => {
        const { ctx, ops } = makeCtx();
        const notice = await exportCurrentView(ctx, makeSession([frame("x")]).session, state());
        expect(notice).toContain("当前机位");
        expect(ops).toHaveLength(1);
        // 节点尺寸按宿主约定缩到最大边 420，真实分辨率留在 metadata
        expect(ops[0]).toMatchObject({ type: "add_node", nodeType: "image", title: "导演台 · 当前机位", width: 420, height: 236 });
        expect(ops[0].position.x).toBeGreaterThan(100 + 560);
        expect(ops[0].metadata).toMatchObject({ content: "data:image/jpeg;base64,xAAAA", status: "success", naturalWidth: 1280, naturalHeight: 720, mimeType: "image/jpeg" });
        expect(ops[0].metadata.bytes).toBeGreaterThan(0);
    });

    it("视口未就绪时只提示、不下发指令", async () => {
        const { ctx, ops } = makeCtx();
        expect(await exportCurrentView(ctx, makeSession([null]).session, state())).toContain("稍等");
        expect(ops).toHaveLength(0);
    });
});

describe("导出机位 A→B 首尾帧", () => {
    it("没有机位 A/B 时拒绝导出", async () => {
        const { ctx, ops } = makeCtx();
        expect(await exportFirstLast(ctx, makeSession([frame("a")]).session, state())).toContain("记录至少两个机位");
        expect(ops).toHaveLength(0);
    });

    it("有下游视频节点时用显式 slot 接线（首=A、尾=B，与连线顺序无关）", async () => {
        const { ctx, ops } = makeCtx([{ id: "video-9", type: "video" }]);
        const withShots = state({ shots: [createStageShot({ ...DEFAULT_CAMERA }, "机位 1"), createStageShot({ ...DEFAULT_CAMERA, distance: 3.4 }, "机位 2")] });
        // 一次导出两次取图：第 1 个机位取 t=0（走位起点）、最后一个机位取 t=整段结束（走位终点）
        const { session, cameras } = makeSession([frame("A"), frame("B")]);
        const notice = await exportFirstLast(ctx, session, withShots);
        expect(cameras.map((call) => call.camera)).toEqual([withShots.shots[0].camera, withShots.shots[1].camera]);
        expect(cameras[0].elapsedMs).toBe(0);
        expect(cameras[1].elapsedMs).toBeGreaterThan(0);

        expect(notice).toContain("接到下游视频节点");
        const adds = ops.filter((op) => op.type === "add_node");
        const connects = ops.filter((op) => op.type === "connect_nodes");
        expect(adds).toHaveLength(2);
        expect(adds.map((op) => op.title)).toEqual(["导演台 · 机位 1（首帧）", "导演台 · 机位 2（尾帧）"]);
        expect(adds.map((op) => op.metadata.content)).toEqual(["data:image/jpeg;base64,AAAAA", "data:image/jpeg;base64,BAAAA"]);
        expect(connects).toEqual([
            { type: "connect_nodes", fromNodeId: adds[0].id, toNodeId: "video-9", slot: "first_frame" },
            { type: "connect_nodes", fromNodeId: adds[1].id, toNodeId: "video-9", slot: "last_frame" },
        ]);
    });

    it("没有下游视频节点时只出两张图并提示手动接（不猜目标）", async () => {
        const { ctx, ops } = makeCtx();
        const withShots = state({ shots: [createStageShot({ ...DEFAULT_CAMERA }, "机位 1"), createStageShot({ ...DEFAULT_CAMERA }, "机位 2")] });
        const notice = await exportFirstLast(ctx, makeSession([frame("a"), frame("b")]).session, withShots);
        expect(notice).toContain("请手动接到首尾帧工作流");
        expect(ops.filter((op) => op.type === "connect_nodes")).toHaveLength(0);
        expect(ops.filter((op) => op.type === "add_node")).toHaveLength(2);
    });
});

describe("导出多视图", () => {
    it("三张图 + 一个折叠分组，分组包住三张图且 children 指回 groupId", async () => {
        const { ctx, ops } = makeCtx();
        const notice = await exportMultiView(ctx, makeSession([frame("v"), frame("v"), frame("v")]).session, state());
        expect(notice).toContain("3 张");
        const adds = ops.filter((op) => op.type === "add_node");
        const group = adds.find((op) => op.nodeType === "group");
        expect(adds.filter((op) => op.nodeType === "image")).toHaveLength(3);
        expect(group).toBeDefined();
        expect(group!.metadata).toMatchObject({ collapsed: true });

        const images = adds.filter((op) => op.nodeType === "image");
        const updates = ops.filter((op) => op.type === "update_node");
        expect(updates.map((op) => op.id)).toEqual(images.map((op) => op.id));
        expect(updates.every((op) => op.metadata.groupId === group!.id)).toBe(true);
        // 分组包围盒要真的包住三张图
        for (const image of images) {
            expect(image.position.x).toBeGreaterThanOrEqual(group!.position.x);
            expect(image.position.x + image.width).toBeLessThanOrEqual(group!.position.x + group!.width);
            expect(image.position.y).toBeGreaterThanOrEqual(group!.position.y);
            expect(image.position.y + image.height).toBeLessThanOrEqual(group!.position.y + group!.height);
        }
    });

    it("同一列多行时按网格往下排，不会互相重叠", async () => {
        const { ctx, ops } = makeCtx();
        await exportMultiView(ctx, makeSession([frame("v"), frame("v"), frame("v")]).session, state());
        const positions = ops.filter((op) => op.type === "add_node" && op.nodeType === "image").map((op) => `${op.position.x},${op.position.y}`);
        expect(new Set(positions).size).toBe(3);
    });
});

describe("导出运镜提示词", () => {
    it("写出文本节点，内容与状态一致", async () => {
        const { ctx, ops } = makeCtx();
        const notice = exportPrompt(ctx, state());
        expect(notice).toContain("提示词");
        expect(ops).toHaveLength(1);
        expect(ops[0]).toMatchObject({ type: "add_node", nodeType: "text", title: "导演台 · 运镜提示词" });
        expect(ops[0].metadata.content).toContain("场景关系：");
        expect(ops[0].metadata.content).toContain("运镜：固定机位");
        expect(ops[0].position.y).toBeLessThan(200);
    });

    it("英文 locale 走英文模板", async () => {
        const { ctx, ops } = makeCtx();
        exportPrompt(ctx, state({ promptLocale: "en" }));
        expect(ops[0].metadata.content).toContain("Scene layout:");
    });
});

const motionVideo = (durationMs = 3000) => ({
    blob: new Blob([new Uint8Array([1, 2, 3, 4])], { type: "video/mp4" }),
    container: "video/mp4" as const,
    frames: 72,
    width: 1280,
    height: 720,
    durationMs,
});

describe("运镜视频落成画布节点", () => {
    it("建视频节点：content 是可持久化的 dataURL，尺寸/时长/体积都带上", async () => {
        const { ctx, ops } = makeCtx();
        const notice = await attachMotionVideoNode(ctx, motionVideo(), state({ motion: { durationMs: 3000, fps: 24, easing: "easeInOut" } }));

        expect(ops).toHaveLength(1);
        const add = ops[0];
        expect(add).toMatchObject({ type: "add_node", nodeType: "video", title: "导演台 · 运镜 3.0s" });
        expect(String(add.metadata.content).startsWith("data:video/mp4;base64,")).toBe(true);
        expect(add).toMatchObject({ width: 420, height: 236 });
        expect(add.metadata).toMatchObject({ status: "success", mimeType: "video/mp4", bytes: 4, durationMs: 3000, seconds: "3.0", naturalWidth: 1280, naturalHeight: 720 });
        // 落在导演台右侧
        expect(add.position.x).toBeGreaterThan(100 + 560);
        expect(notice).toContain("手动连到参考视频槽位");
    });

    it("下游有视频节点时顺手接上（宿主按节点类型当参考视频）", async () => {
        const { ctx, ops } = makeCtx([{ id: "video-9", type: "video" }]);
        const notice = await attachMotionVideoNode(ctx, motionVideo(), state());

        const add = ops.find((op) => op.type === "add_node")!;
        expect(ops.find((op) => op.type === "connect_nodes")).toMatchObject({ fromNodeId: add.id, toNodeId: "video-9" });
        expect(notice).toContain("接到下游视频节点");
    });

    it("体积过大时明确提醒（而不是静默把项目撑胖）", async () => {
        const { ctx } = makeCtx();
        const huge = { ...motionVideo(), blob: new Blob([new Uint8Array(5 * 1024 * 1024)], { type: "video/mp4" }) };
        expect(await attachMotionVideoNode(ctx, huge, state())).toContain("体积偏大");
    });
});

describe("运镜视频导出前置校验", () => {
    it("没记住 A/B 直接拒绝", async () => {
        await expect(renderMotionVideo(state())).rejects.toThrow(/记录至少两个机位/);
    });

    it("帧数超过上限时在创建视口之前就拒绝", async () => {
        const tooLong = state({
            shots: [createStageShot({ ...DEFAULT_CAMERA }, "机位 1"), createStageShot({ ...DEFAULT_CAMERA, distance: 3.4 }, "机位 2")],
            motion: { durationMs: 8000, fps: 30, easing: "linear" },
        });
        // 8s × 30fps = 240 帧正好在上限；这里把帧率提到上限外（60）来触发放弃
        const overBudget = { ...tooLong, motion: { durationMs: 8000, fps: 60, easing: "linear" as const } };
        await expect(renderMotionVideo(overBudget)).rejects.toThrow(/超过上限/);
    });
});

describe("导出产物的落点", () => {
    const ANCHOR = { x: 100, y: 200, width: 560, height: 400 };
    const expectedX = ANCHOR.x + ANCHOR.width + 96;

    it("贴在导演台节点右侧、同一水平线，不飞到屏幕外", async () => {
        const { ctx, ops } = makeCtx();
        await exportCurrentView(ctx, makeSession([frame("x")]).session, state());
        const add = ops.find((op) => op.type === "add_node")!;
        expect(add.position).toEqual({ x: expectedX, y: ANCHOR.y });
    });

    it("一次导出多张时往下排，彼此不重叠", async () => {
        const { ctx, ops } = makeCtx();
        await exportMultiView(ctx, makeSession([frame("v"), frame("v"), frame("v")]).session, state());
        const positions = ops.filter((op) => op.type === "add_node" && op.nodeType === "image").map((op) => op.position);
        // 一行的高度 = 节点高 236 + 间距 96
        expect(positions).toEqual([
            { x: expectedX, y: ANCHOR.y },
            { x: expectedX, y: ANCHOR.y + 236 + 96 },
            { x: expectedX, y: ANCHOR.y + 2 * (236 + 96) },
        ]);
    });

    it("落点被已有节点占用时自动往下让位", async () => {
        // 画布上已经有一张图正好占住第一个格子
        const occupied = [{ id: "img-existing", type: "image", position: { x: expectedX, y: ANCHOR.y }, width: 420, height: 236, metadata: {} }];
        const { ctx, ops } = makeCtx([], occupied);
        await exportCurrentView(ctx, makeSession([frame("x")]).session, state());
        const add = ops.find((op) => op.type === "add_node")!;
        expect(add.position).toEqual({ x: expectedX, y: ANCHOR.y + 236 + 96 });
    });

    it("运镜视频节点也贴在右侧（不再按序号飞出去）", async () => {
        const { ctx, ops } = makeCtx();
        await attachMotionVideoNode(ctx, motionVideo(), state());
        const add = ops.find((op) => op.type === "add_node")!;
        expect(add.position).toEqual({ x: expectedX, y: ANCHOR.y });
    });
});
