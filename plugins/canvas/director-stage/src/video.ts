// 运镜视频编码：逐帧渲染好的 canvas → 视频文件。
//
// 主路径用 WebCodecs（VideoEncoder H.264）+ mp4-muxer 产出**真正的 .mp4**；
// 浏览器不支持 H.264 编码时降级用 MediaRecorder 录 WebM（按真实时间播放一遍）。
// 纯前端、不上传：帧直接从 WebGL canvas 读像素，省掉每帧一次 JPEG 编码。
import { ArrayBufferTarget, Muxer } from "mp4-muxer";

import type { VideoFrameSource } from "./capture";
import type { StageCamera } from "./stage-state";

/** 帧数上限：8s@30fps。再长就把标签页拖死了，宁可让用户缩短。 */
export const MAX_MOTION_FRAMES = 240;

export type MotionVideoContainer = "video/mp4" | "video/webm";

export type MotionVideoResult = {
    blob: Blob;
    container: MotionVideoContainer;
    frames: number;
    width: number;
    height: number;
    durationMs: number;
};

export type MotionVideoInput = {
    source: VideoFrameSource;
    width: number;
    height: number;
    fps: number;
    frames: number;
    /** progress ∈ [0,1] → 该帧的机位与时间点（人物走位要按同一时间摆）。 */
    frameAt: (progress: number) => { camera: StageCamera; elapsedMs: number };
    onProgress?: (done: number, total: number) => void;
    shouldStop?: () => boolean;
};

/** 用户主动取消（与真正的失败区分开，界面上提示"已取消"而不是"失败"）。 */
export class MotionVideoCancelled extends Error {
    constructor() {
        super("cancelled");
        this.name = "MotionVideoCancelled";
    }
}

/** 宽度固定 16:9，与图片导出保持一致。 */
export function motionVideoSize(height: number) {
    return { width: Math.round((height * 16) / 9), height };
}

/** 码率按分辨率与帧率给：720p24 ≈ 1.5Mbps，3s 约 600KB —— 够看，又不至于把节点 metadata 撑爆。 */
export function motionVideoBitrate(width: number, height: number, fps: number) {
    return Math.round(width * height * fps * 0.07);
}

export function formatBytes(bytes: number) {
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

/** 挑一个当前浏览器真的支持的 H.264 档位（越高越优先，1080p 需要 Main/4.0 及以上）。 */
async function pickAvcCodec(width: number, height: number, fps: number, bitrate: number): Promise<string | null> {
    if (typeof VideoEncoder === "undefined") return null;
    const candidates = height > 720 ? ["avc1.4d0028", "avc1.640028", "avc1.42001f"] : ["avc1.42001f", "avc1.4d0028", "avc1.42E01E"];
    for (const codec of candidates) {
        try {
            const support = await VideoEncoder.isConfigSupported({ codec, width, height, bitrate, framerate: fps });
            if (support.supported) return codec;
        } catch {
            // 档位串不合法/不支持，试下一个
        }
    }
    return null;
}

async function encodeWithWebCodecs(input: MotionVideoInput, codec: string): Promise<MotionVideoResult> {
    const bitrate = motionVideoBitrate(input.width, input.height, input.fps);
    const muxer = new Muxer({
        target: new ArrayBufferTarget(),
        video: { codec: "avc", width: input.width, height: input.height, frameRate: input.fps },
        fastStart: "in-memory",
    });
    let encodeError: unknown = null;
    const encoder = new VideoEncoder({
        output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
        error: (error) => {
            encodeError = error;
        },
    });
    // avc 长度前缀是 mp4 需要的封装格式（默认的 annexb 是给流式传输的）
    encoder.configure({ codec, width: input.width, height: input.height, bitrate, framerate: input.fps, avc: { format: "avc" } });

    const frameDuration = Math.round(1_000_000 / input.fps);
    const keyFrameEvery = Math.max(1, input.fps * 2);
    for (let index = 0; index < input.frames; index += 1) {
        if (input.shouldStop?.()) {
            encoder.close();
            throw new MotionVideoCancelled();
        }
        const frame = input.frameAt(input.frames === 1 ? 0 : index / (input.frames - 1));
        const canvas = input.source.renderFrame(frame.camera, frame.elapsedMs);
        if (!canvas) throw new Error("渲染失败：拿不到画布");
        const videoFrame = new VideoFrame(canvas, { timestamp: index * frameDuration, duration: frameDuration });
        encoder.encode(videoFrame, { keyFrame: index % keyFrameEvery === 0 });
        videoFrame.close();
        input.onProgress?.(index + 1, input.frames);
        // 背压：别让未编码的帧堆在内存里
        if (encoder.encodeQueueSize > 8) await new Promise((resolve) => window.setTimeout(resolve, 0));
        if (encodeError) throw encodeError instanceof Error ? encodeError : new Error(String(encodeError));
    }
    if (input.shouldStop?.()) {
        encoder.close();
        throw new MotionVideoCancelled();
    }
    await encoder.flush();
    encoder.close();
    muxer.finalize();
    const target = muxer.target as ArrayBufferTarget;
    return {
        blob: new Blob([target.buffer], { type: "video/mp4" }),
        container: "video/mp4",
        frames: input.frames,
        width: input.width,
        height: input.height,
        durationMs: Math.round((input.frames / input.fps) * 1000),
    };
}

/** 降级：按真实时间把运镜播一遍并录屏成 WebM（录不出 mp4，但总比不给强）。 */
async function recordWithMediaRecorder(input: MotionVideoInput): Promise<MotionVideoResult> {
    if (typeof MediaRecorder === "undefined") throw new Error("这个浏览器既不能编码 mp4，也不支持 MediaRecorder 录制");
    await input.source.ready();
    const firstFrame = input.frameAt(0);
    const first = input.source.renderFrame(firstFrame.camera, firstFrame.elapsedMs);
    if (!first) throw new Error("渲染失败：拿不到画布");
    const stream = first.captureStream(input.fps);
    const mimeType = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"].find((type) => MediaRecorder.isTypeSupported(type));
    if (!mimeType) throw new Error("这个浏览器不支持录制 WebM");
    const chunks: Blob[] = [];
    const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: motionVideoBitrate(input.width, input.height, input.fps) });
    recorder.ondataavailable = (event) => {
        if (event.data.size) chunks.push(event.data);
    };
    const stopped = new Promise<void>((resolve) => {
        recorder.onstop = () => resolve();
    });
    recorder.start();

    const durationMs = (input.frames / input.fps) * 1000;
    const startedAt = performance.now();
    let cancelled = false;
    await new Promise<void>((resolve) => {
        const tick = (now: number) => {
            if (input.shouldStop?.()) {
                cancelled = true;
                resolve();
                return;
            }
            const progress = Math.min(1, (now - startedAt) / durationMs);
            const frame = input.frameAt(progress);
            input.source.renderFrame(frame.camera, frame.elapsedMs);
            input.onProgress?.(Math.round(progress * input.frames), input.frames);
            if (progress >= 1) {
                resolve();
                return;
            }
            window.requestAnimationFrame(tick);
        };
        window.requestAnimationFrame(tick);
    });

    recorder.stop();
    await stopped;
    for (const track of stream.getTracks()) track.stop();
    if (cancelled) throw new MotionVideoCancelled();
    return {
        blob: new Blob(chunks, { type: "video/webm" }),
        container: "video/webm",
        frames: input.frames,
        width: input.width,
        height: input.height,
        durationMs: Math.round(durationMs),
    };
}

/**
 * 导出运镜视频：优先 mp4（WebCodecs），不行就降级 WebM。
 * 另外做了一层保险：WebCodecs 明明声明支持却中途失败（不同环境对 canvas → VideoFrame
 * 的支持有差异），也退回录制模式再试一次，而不是直接给用户一个失败。
 */
export async function encodeMotionVideo(input: MotionVideoInput): Promise<MotionVideoResult> {
    if (input.frames > MAX_MOTION_FRAMES) {
        throw new Error(`帧数 ${input.frames} 超过上限 ${MAX_MOTION_FRAMES}，请缩短时长或降低帧率`);
    }
    await input.source.ready();
    const bitrate = motionVideoBitrate(input.width, input.height, input.fps);
    const codec = await pickAvcCodec(input.width, input.height, input.fps, bitrate);
    if (!codec) return recordWithMediaRecorder(input);
    try {
        return await encodeWithWebCodecs(input, codec);
    } catch (error) {
        if (error instanceof MotionVideoCancelled) throw error;
        input.onProgress?.(0, input.frames);
        return recordWithMediaRecorder(input);
    }
}
