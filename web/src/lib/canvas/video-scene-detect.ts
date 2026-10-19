/**
 * 场景切点检测与胶片条抽帧。
 *
 * 思路：把视频当作一组静态帧来处理 —— 每 250ms 抽一帧压成 32×18 灰度，
 * 相邻帧的整体亮度差异超过阈值就算切点。硬切通常是 0.3 以上，推拉摇移一般不到 0.08，
 * 中间的区间靠阈值和去重窗口一起压住误判。
 *
 * 之所以不用「解码全部帧算直方图」，是因为浏览器 seek 到稀疏时间点比顺序解码整片快一个量级，
 * 而分段只需要秒级精度。
 */
import { detectSceneChanges, frameSignature, type FrameSignature, type SceneCut } from "./video-timeline";

const ANALYSIS_WIDTH = 32;
const ANALYSIS_HEIGHT = 18;

export type VideoSampleResult = {
    durationMs: number;
    width: number;
    height: number;
    samples: FrameSignature[];
};

export type SampleOptions = {
    /** 采样步长，默认 250ms。长片会自动放大，避免 3 分钟抽 720 帧。 */
    stepMs?: number;
    /** 采样点上限，默认 240。 */
    maxSamples?: number;
    onProgress?: (ratio: number) => void;
    signal?: AbortSignal;
};

/** 稀疏采样并返回每帧的签名。 */
export async function sampleVideoSignatures(src: string, options: SampleOptions = {}): Promise<VideoSampleResult> {
    return withVideo(src, options.signal, async (video, canvas, context) => {
        const durationMs = Math.round((video.duration || 0) * 1000);
        if (!durationMs) throw new Error("VIDEO_NO_DURATION");
        const stepMs = resolveStep(durationMs, options);
        const times: number[] = [];
        for (let time = 0; time < durationMs; time += stepMs) times.push(time);
        // 末尾补一个点：最后一个镜头多长也得有代表帧，否则尾巴上的切点检不出来。
        if (times[times.length - 1] < durationMs - 1) times.push(Math.max(0, durationMs - 20));

        const samples: FrameSignature[] = [];
        for (let index = 0; index < times.length; index += 1) {
            throwIfAborted(options.signal);
            await seekTo(video, times[index] / 1000);
            context.drawImage(video, 0, 0, ANALYSIS_WIDTH, ANALYSIS_HEIGHT);
            const pixels = context.getImageData(0, 0, ANALYSIS_WIDTH, ANALYSIS_HEIGHT).data;
            samples.push({ timeMs: Math.round(times[index]), signature: frameSignature(pixels, ANALYSIS_WIDTH, ANALYSIS_HEIGHT, ANALYSIS_WIDTH, ANALYSIS_HEIGHT) });
            options.onProgress?.((index + 1) / times.length);
        }
        return { durationMs, width: video.videoWidth, height: video.videoHeight, samples };
    });
}

/** 采样 + 切点检测一步到位。 */
export async function detectVideoScenes(src: string, options: SampleOptions & { threshold?: number } = {}): Promise<{ durationMs: number; cuts: SceneCut[]; width: number; height: number }> {
    const result = await sampleVideoSignatures(src, options);
    const cuts = detectSceneChanges(result.samples, { threshold: options.threshold });
    return { durationMs: result.durationMs, cuts, width: result.width, height: result.height };
}

/**
 * 胶片条：等间隔抽 N 张缩略图，给时间轴做视觉参照。
 * 用户拖选区时看得见画面，比纯刻度条好判断"瑕疵到底在哪一帧"。
 */
export async function buildFilmstrip(src: string, count: number, options: { width?: number; signal?: AbortSignal } = {}): Promise<{ durationMs: number; frames: { timeMs: number; dataUrl: string }[] }> {
    const frameCount = Math.max(1, Math.min(40, Math.round(count)));
    const thumbWidth = Math.max(48, options.width ?? 128);
    return withVideo(src, options.signal, async (video, canvas, context) => {
        const durationMs = Math.round((video.duration || 0) * 1000);
        if (!durationMs) throw new Error("VIDEO_NO_DURATION");
        const aspect = video.videoHeight && video.videoWidth ? video.videoHeight / video.videoWidth : 9 / 16;
        const thumbHeight = Math.max(2, Math.round(thumbWidth * aspect));
        canvas.width = thumbWidth;
        canvas.height = thumbHeight;
        const frames: { timeMs: number; dataUrl: string }[] = [];
        for (let index = 0; index < frameCount; index += 1) {
            throwIfAborted(options.signal);
            // 取每格正中，避开转场那一两帧。
            const timeMs = Math.round(((index + 0.5) / frameCount) * durationMs);
            await seekTo(video, Math.min(durationMs - 20, timeMs) / 1000);
            context.drawImage(video, 0, 0, thumbWidth, thumbHeight);
            frames.push({ timeMs, dataUrl: canvas.toDataURL("image/jpeg", 0.6) });
        }
        return { durationMs, frames };
    });
}

/** 抽某一时刻的单帧，用于首尾帧锚定。 */
export async function captureFrameDataUrl(src: string, timeMs: number, options: { width?: number; signal?: AbortSignal } = {}): Promise<string> {
    return withVideo(src, options.signal, async (video, canvas, context) => {
        const durationMs = Math.round((video.duration || 0) * 1000);
        const safeTime = Math.max(0, Math.min(Math.max(0, durationMs - 20), timeMs));
        await seekTo(video, safeTime / 1000);
        const width = options.width ?? (video.videoWidth || 1280);
        const height = video.videoWidth ? Math.round((width * video.videoHeight) / video.videoWidth) : Math.round(width * 0.5625);
        canvas.width = width;
        canvas.height = Math.max(2, height);
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        return canvas.toDataURL("image/jpeg", 0.92);
    });
}

async function withVideo<T>(src: string, signal: AbortSignal | undefined, run: (video: HTMLVideoElement, canvas: HTMLCanvasElement, context: CanvasRenderingContext2D) => Promise<T>): Promise<T> {
    const video = document.createElement("video");
    video.crossOrigin = "anonymous";
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    const canvas = document.createElement("canvas");
    canvas.width = ANALYSIS_WIDTH;
    canvas.height = ANALYSIS_HEIGHT;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("NO_CANVAS_CONTEXT");
    try {
        const metadata = waitFor(video, "loadedmetadata");
        video.src = src;
        video.load();
        await metadata;
        throwIfAborted(signal);
        return await run(video, canvas, context);
    } finally {
        video.removeAttribute("src");
        video.load();
    }
}

function resolveStep(durationMs: number, options: SampleOptions): number {
    const maxSamples = Math.max(8, options.maxSamples ?? 240);
    const preferred = Math.max(120, options.stepMs ?? 250);
    return Math.max(preferred, Math.ceil(durationMs / maxSamples / 50) * 50);
}

function seekTo(video: HTMLVideoElement, seconds: number): Promise<void> {
    if (Math.abs(video.currentTime - seconds) < 0.001 && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
            cleanup();
            reject(new Error("VIDEO_SEEK_TIMEOUT"));
        }, 8000);
        const done = () => {
            cleanup();
            resolve();
        };
        const failed = () => {
            cleanup();
            reject(new Error("VIDEO_SEEK_FAILED"));
        };
        const cleanup = () => {
            clearTimeout(timer);
            video.removeEventListener("seeked", done);
            video.removeEventListener("error", failed);
        };
        video.addEventListener("seeked", done, { once: true });
        video.addEventListener("error", failed, { once: true });
        video.currentTime = seconds;
    });
}

function waitFor(video: HTMLVideoElement, eventName: "loadedmetadata" | "loadeddata") {
    return new Promise<void>((resolve, reject) => {
        const done = () => {
            cleanup();
            resolve();
        };
        const failed = () => {
            cleanup();
            reject(new Error("VIDEO_LOAD_FAILED"));
        };
        const cleanup = () => {
            video.removeEventListener(eventName, done);
            video.removeEventListener("error", failed);
        };
        video.addEventListener(eventName, done, { once: true });
        video.addEventListener("error", failed, { once: true });
    });
}

function throwIfAborted(signal: AbortSignal | undefined) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
}
