// 导出动作：调截图会话取图 → 用指令集建节点/连线/打组。返回一句提示给调用方显示（状态行）。
// 取图是异步的（卡片走离屏视口），所以渲染类动作都是 async；只有「提示词」是纯状态计算，保持同步。
import type { CanvasNodeContext } from "@infinite-canvas/plugin-sdk";

import type { CaptureSession } from "./capture";
import { createOffscreenVideoSource } from "./capture";
import { buildGroupOps, buildImageOps, buildVideoNodeOps, findDownstreamVideoNode, type CapturedFrame } from "./exporter";
import { cameraAtTime, frameCountFor, motionTimeline, sceneEndMs } from "./motion";
import { buildDirectorPrompt } from "./prompt";
import type { StageState } from "./stage-state";
import { encodeMotionVideo, formatBytes, MAX_MOTION_FRAMES, motionVideoSize, type MotionVideoResult } from "./video";

const NOT_READY = "视口还没准备好，稍等一秒再试";

export async function exportCurrentView(ctx: CanvasNodeContext, session: CaptureSession, state: StageState): Promise<string> {
    const frame = await session.capture();
    if (!frame) return NOT_READY;
    const images = buildImageOps(ctx, [{ frame, title: "导演台 · 当前机位" }], { format: state.exportFormat });
    ctx.applyOps(images.flatMap((image) => image.ops));
    return "已生成「当前机位」参考图，可直接连到生图工作流";
}

/** 机位 A→B 两帧：有下游视频节点就用显式 slot 接上去（首=A、尾=B，与连线先后无关）。 */
export async function exportFirstLast(ctx: CanvasNodeContext, session: CaptureSession, state: StageState): Promise<string> {
    if (state.shots.length < 2) return "先在右侧「机位」里记录至少两个机位（第 1 个是首帧、最后一个是尾帧），再导出首尾帧";
    const firstShot = state.shots[0];
    const lastShot = state.shots[state.shots.length - 1];
    // 首帧取 t=0、尾帧取 t=整段结束：这样人物走位也跟着，首帧就是走位起点
    const first = await session.capture({ camera: firstShot.camera, elapsedMs: 0 });
    const last = await session.capture({ camera: lastShot.camera, elapsedMs: sceneEndMs(state) });
    if (!first || !last) return NOT_READY;
    const images = buildImageOps(
        ctx,
        [
            { frame: first, title: `导演台 · ${firstShot.name}（首帧）` },
            { frame: last, title: `导演台 · ${lastShot.name}（尾帧）` },
        ],
        { format: state.exportFormat },
    );
    const ops = images.flatMap((image) => image.ops);
    const video = findDownstreamVideoNode(ctx);
    if (video) {
        // 显式 slot：不依赖连线先后顺序，首帧一定是 A、尾帧一定是 B。
        ops.push({ type: "connect_nodes", fromNodeId: images[0].id, toNodeId: video.id, slot: "first_frame" });
        ops.push({ type: "connect_nodes", fromNodeId: images[1].id, toNodeId: video.id, slot: "last_frame" });
    }
    ctx.applyOps(ops);
    return video ? "已生成首/尾帧并接到下游视频节点，可直接生成" : "已生成首/尾帧两张图；画布上没有下游视频节点，请手动接到首尾帧工作流";
}

/** 多视图：左前 / 正面 / 俯视三张，打成折叠分组。 */
export async function exportMultiView(ctx: CanvasNodeContext, session: CaptureSession, state: StageState): Promise<string> {
    const base = state.camera;
    const views: Array<{ camera: StageState["camera"]; title: string }> = [
        { camera: { ...base, azimuthDeg: base.azimuthDeg - 60, elevationDeg: 10 }, title: "导演台 · 视图 左前" },
        { camera: { ...base, azimuthDeg: base.azimuthDeg, elevationDeg: 8 }, title: "导演台 · 视图 正面" },
        { camera: { ...base, azimuthDeg: base.azimuthDeg, elevationDeg: 55, distance: base.distance + 3 }, title: "导演台 · 视图 俯视" },
    ];
    const frames: Array<{ frame: CapturedFrame; title: string }> = [];
    for (const view of views) {
        const frame = await session.capture({ camera: view.camera });
        if (frame) frames.push({ frame, title: view.title });
    }
    if (!frames.length) return NOT_READY;
    const images = buildImageOps(ctx, frames, { format: state.exportFormat });
    ctx.applyOps([...images.flatMap((image) => image.ops), ...buildGroupOps(images, `导演台 · 多视图 ${images.length} 张`)]);
    return `已生成 ${frames.length} 张多视图参考图并打成折叠分组`;
}

/** 运镜提示词：纯状态 → 文本，不涉及渲染。 */
export function exportPrompt(ctx: CanvasNodeContext, state: StageState): string {
    const text = buildDirectorPrompt(state, state.promptLocale);
    const id = `stage-prompt-${ctx.node.id}-${Date.now().toString(36)}`;
    ctx.applyOps([
        {
            type: "add_node",
            id,
            nodeType: "text",
            title: "导演台 · 运镜提示词",
            position: { x: ctx.node.position.x, y: ctx.node.position.y - 260 },
            width: 380,
            height: 240,
            metadata: { content: text, status: "success" },
        },
    ]);
    return "已生成运镜提示词文本节点；需要更专业措辞可用画布里的视频提示词技能再润色一次";
}

const LARGE_VIDEO_BYTES = 4 * 1024 * 1024;

/**
 * 把「机位 A→B 的运镜」渲成视频：逐帧渲染离屏视口 → 编码（优先 mp4，降级 WebM）。
 * 这里只负责产出 Blob，落成节点还是下载交给调用方决定。
 */
export async function renderMotionVideo(
    state: StageState,
    options: { onProgress?: (done: number, total: number) => void; shouldStop?: () => boolean } = {},
): Promise<MotionVideoResult> {
    if (state.shots.length < 2) throw new Error("先在「机位」里记录至少两个机位，再导出运镜视频");
    const shots = state.shots;
    const motion = state.motion;
    const shotsTimeline = motionTimeline(shots, motion);
    // 整段时长取"相机与人物走位里最长的那个"，帧数按时长算 —— 人与镜头走到同一终点
    const totalMs = sceneEndMs(state);
    const shotEndMs = shotsTimeline.totalMs;
    const frames = frameCountFor(totalMs, motion.fps);
    if (frames > MAX_MOTION_FRAMES) throw new Error(`帧数 ${frames} 超过上限 ${MAX_MOTION_FRAMES}：把时长缩到 4 秒内，或把帧率降下来`);
    const size = motionVideoSize(state.exportHeight);
    const source = createOffscreenVideoSource(state, { height: state.exportHeight });
    try {
        return await encodeMotionVideo({
            source,
            width: size.width,
            height: size.height,
            fps: motion.fps,
            frames,
            frameAt: (progress) => {
                const elapsedMs = progress * totalMs;
                // 相机时间轴可能比整段短（人物走得久），超出了就停在最后一个机位
                return { camera: cameraAtTime(shots, motion, Math.min(elapsedMs, shotEndMs)) || state.camera, elapsedMs };
            },
            onProgress: options.onProgress,
            shouldStop: options.shouldStop,
        });
    } finally {
        source.dispose();
    }
}

/** 落成画布视频节点；下游有视频节点就顺手接上（宿主会按节点类型把它当参考视频）。 */
export async function attachMotionVideoNode(ctx: CanvasNodeContext, result: MotionVideoResult, state: StageState): Promise<string> {
    const { id, ops } = buildVideoNodeOps(ctx, {
        dataUrl: await blobToDataUrl(result.blob),
        mimeType: result.container,
        width: result.width,
        height: result.height,
        bytes: result.blob.size,
        durationMs: result.durationMs,
        title: `导演台 · 运镜 ${(result.durationMs / 1000).toFixed(1)}s`,
    });
    const downstream = findDownstreamVideoNode(ctx);
    if (downstream) ops.push({ type: "connect_nodes", fromNodeId: id, toNodeId: downstream.id });
    ctx.applyOps(ops);
    const container = result.container === "video/mp4" ? "mp4" : "WebM";
    const size = formatBytes(result.blob.size);
    const huge = result.blob.size > LARGE_VIDEO_BYTES ? "（体积偏大，已写进节点 metadata，必要时改用「下载」）" : "";
    return downstream
        ? `已生成 ${container} 运镜视频节点（${size}）并接到下游视频节点，宿主会按类型把它当参考视频${huge}`
        : `已生成 ${container} 运镜视频节点（${size}）；画布上没有下游视频节点，可手动连到参考视频槽位${huge}`;
}

/** 下载成文件。 */
export function downloadMotionVideo(result: MotionVideoResult) {
    const extension = result.container === "video/mp4" ? "mp4" : "webm";
    const url = URL.createObjectURL(result.blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `director-stage-motion-${result.durationMs}ms-${result.frames}f.${extension}`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

async function blobToDataUrl(blob: Blob): Promise<string> {
    const buffer = new Uint8Array(await blob.arrayBuffer());
    let binary = "";
    for (let index = 0; index < buffer.length; index += 0x8000) binary += String.fromCharCode(...buffer.subarray(index, index + 0x8000));
    return `data:${blob.type};base64,${btoa(binary)}`;
}
