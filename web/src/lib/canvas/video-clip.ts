/**
 * 浏览器端的视频切分与拼接。
 *
 * 两个场景都绕不开「把长片按时间切开」和「把段接回去」：
 * - 角色替换：模型吃不了长片，必须先切成 ≤6s 的参考视频
 * - 局部重绘：只把出问题的那几秒送去生成，再替换回原时间轴
 *
 * 依赖 mediabunny（WebCodecs 封装）。它只做编排，真正的解码/编码走浏览器原生硬编，
 * 因此不出 wasm、不占几十 MB。整包按需动态加载，不用视频功能就不会被下载。
 */
import type { VideoSample as MediaVideoSample } from "mediabunny";

let libraryPromise: Promise<typeof import("mediabunny")> | null = null;

function loadLibrary() {
    libraryPromise ||= import("mediabunny");
    return libraryPromise;
}

/** 运行时能力探测：老 Safari / 部分嵌入式浏览器没有 WebCodecs。 */
export function isMediaProcessingSupported(): boolean {
    return typeof VideoDecoder !== "undefined" && typeof VideoEncoder !== "undefined" && (typeof OffscreenCanvas !== "undefined" || typeof document !== "undefined");
}

export type VideoProbe = {
    durationMs: number;
    width: number;
    height: number;
    hasAudio: boolean;
};

export async function probeVideo(blob: Blob): Promise<VideoProbe> {
    const { MATROSKA, MP4, WEBM, BlobSource, Input } = await loadLibrary();
    const input = new Input({ formats: [MP4, WEBM, MATROSKA], source: new BlobSource(blob) });
    try {
        const track = await input.getPrimaryVideoTrack();
        if (!track) throw new Error("NO_VIDEO_TRACK");
        const durationSeconds = await input.computeDuration();
        return {
            durationMs: Math.round(durationSeconds * 1000),
            width: await track.getDisplayWidth(),
            height: await track.getDisplayHeight(),
            hasAudio: (await input.getAudioTracks()).length > 0,
        };
    } finally {
        await disposeInput(input);
    }
}

/**
 * 无损优先地截取一段：能直接搬运压缩包就搬运，边界落不到关键帧时库会自动只重编开头那一点。
 * 用于把长片喂给模型，以及给段节点生成可独立预览的文件。
 */
export async function cutVideoSegment(blob: Blob, startMs: number, endMs: number): Promise<Blob> {
    const { MATROSKA, MP4, WEBM, BlobSource, BufferTarget, Conversion, Input, Mp4OutputFormat, Output } = await loadLibrary();
    if (!(endMs > startMs)) throw new Error("EMPTY_RANGE");
    const input = new Input({ formats: [MP4, WEBM, MATROSKA], source: new BlobSource(blob) });
    const target = new BufferTarget();
    const output = new Output({ format: new Mp4OutputFormat({ fastStart: "in-memory" }), target });
    try {
        const conversion = await Conversion.init({
            input,
            output,
            trim: { start: startMs / 1000, end: endMs / 1000 },
            showWarnings: false,
        });
        if (!conversion.isValid) throw new Error("CUT_UNSUPPORTED");
        await conversion.execute();
        if (!target.buffer) throw new Error("CUT_EMPTY_OUTPUT");
        return new Blob([target.buffer], { type: "video/mp4" });
    } finally {
        await disposeInput(input);
    }
}

export type ConcatPart = {
    blob: Blob;
    /** 只取这一段里的某个区间（毫秒）。省略表示整段。 */
    startMs?: number;
    endMs?: number;
    /** 该段起点是否落在场景切点上；是则不参与交叉淡化（硬切处淡化反而会拖影）。 */
    sceneStart?: boolean;
};

export type ConcatOptions = {
    /** 段边界的交叉淡化帧数，按实际帧率折算。 */
    crossfadeFrames?: number;
    /** 音轨来源。局部重绘传原视频即可整轨保留，避免「声音也断一下」。 */
    audio?: Blob | null;
    onProgress?: (ratio: number) => void;
    signal?: AbortSignal;
};

/**
 * 按顺序拼接成片。统一重编码：段可能来自不同模型、不同分辨率，
 * 直接拼压缩包会出现参数不一致的花屏，重编码后参数一致、接缝不可见。
 */
export async function concatVideoParts(parts: ConcatPart[], options: ConcatOptions = {}): Promise<Blob> {
    if (!parts.length) throw new Error("NO_PARTS");
    const { AudioBufferSink, AudioBufferSource, BlobSource, BufferTarget, Input, Mp4OutputFormat, Output, QUALITY_HIGH, VideoSample, VideoSampleSink, VideoSampleSource, WebMOutputFormat, getFirstEncodableVideoCodec } = await loadLibrary();

    const probe = await probeVideo(parts[0].blob);
    const width = even(Math.max(2, probe.width));
    const height = even(Math.max(2, probe.height));
    const codec = await getFirstEncodableVideoCodec(["avc", "vp9", "av1"], { width, height, quality: QUALITY_HIGH });
    if (!codec) throw new Error("NO_ENCODABLE_CODEC");
    const useMp4 = codec === "avc" || codec === "hevc" || codec === "av1";

    const target = new BufferTarget();
    const output = new Output({
        format: useMp4 ? new Mp4OutputFormat({ fastStart: "in-memory" }) : new WebMOutputFormat(),
        target,
    });
    const videoSource = new VideoSampleSource({ codec, quality: QUALITY_HIGH });
    output.addVideoTrack(videoSource);

    let audioSource: InstanceType<typeof AudioBufferSource> | null = null;
    if (options.audio) {
        try {
            audioSource = new AudioBufferSource({ codec: useMp4 ? "aac" : "opus", bitrate: 128_000 });
            output.addAudioTrack(audioSource);
        } catch {
            audioSource = null;
        }
    }

    const canvas = createCanvas(width, height);
    const context = canvas.getContext("2d") as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
    if (!context) throw new Error("NO_CANVAS_CONTEXT");

    const totalMs = parts.reduce((sum, part) => sum + Math.max(0, (part.endMs ?? probe.durationMs) - (part.startMs ?? 0)), 0) || 1;
    const crossfadeFrames = Math.max(0, Math.min(12, Math.round(options.crossfadeFrames ?? 0)));

    await output.start();
    let completed = false;
    try {
        let outputTime = 0;
        let frameDuration = 1 / 30;
        /** 延迟写出的队尾：留几帧给下一段做交叉淡化。 */
        const pending: Array<{ sample: MediaVideoSample; duration: number }> = [];

        const emit = async (sample: MediaVideoSample, duration: number, blend?: { other: MediaVideoSample; alpha: number }) => {
            context.clearRect(0, 0, width, height);
            context.fillStyle = "#000";
            context.fillRect(0, 0, width, height);
            if (blend) {
                context.globalAlpha = 1 - blend.alpha;
                drawContained(context, blend.other, width, height);
                context.globalAlpha = blend.alpha;
                drawContained(context, sample, width, height);
                context.globalAlpha = 1;
            } else {
                drawContained(context, sample, width, height);
            }
            const frame = new VideoSample(canvas, { timestamp: outputTime, duration });
            outputTime += duration;
            await videoSource.add(frame);
            frame.close();
            options.onProgress?.(Math.min(1, (outputTime * 1000) / totalMs));
        };

        for (let partIndex = 0; partIndex < parts.length; partIndex += 1) {
            const part = parts[partIndex];
            const fade = crossfadeFrames > 0 && partIndex > 0 && part.sceneStart !== true ? crossfadeFrames : 0;
            // 最后一段不留队尾：没有下一段要跟它做淡化。
            const keep = partIndex === parts.length - 1 ? 0 : crossfadeFrames;
            // 必须显式给区间：无损切出来的文件带着 edit list，头部会残留上一个关键帧到切点之间的数据，
            // 直接按整段解码会把这部分也算进输出，段越长误差越大。
            const partStartMs = part.startMs ?? 0;
            const partEndMs = part.endMs ?? (await probeVideo(part.blob)).durationMs;
            let indexInPart = 0;
            await forEachSample(part.blob, partStartMs, partEndMs, options.signal, async (sample) => {
                const duration = sample.duration > 0 ? sample.duration : frameDuration;
                frameDuration = duration;
                if (fade > 0 && indexInPart < fade && pending.length > 0) {
                    const head = pending.shift()!;
                    const alpha = Math.min(1, (indexInPart + 1) / fade);
                    await emit(sample, duration, { other: head.sample, alpha });
                    head.sample.close();
                    sample.close();
                    indexInPart += 1;
                    return;
                }
                pending.push({ sample, duration });
                indexInPart += 1;
                while (pending.length > keep) {
                    const next = pending.shift()!;
                    await emit(next.sample, next.duration);
                    next.sample.close();
                }
            });
        }
        while (pending.length) {
            const next = pending.shift()!;
            await emit(next.sample, next.duration);
            next.sample.close();
        }

        if (audioSource && options.audio) {
            for await (const wrapped of readAudioBuffers(options.audio, options.signal)) {
                // WrappedAudioBuffer 只是给时间戳加了包装，编码只关心 PCM 本身，顺序由解码顺序保证。
                await audioSource.add(wrapped.buffer);
            }
        }

        options.onProgress?.(1);
        await output.finalize();
        completed = true;
        if (!target.buffer) throw new Error("CONCAT_EMPTY_OUTPUT");
        return new Blob([target.buffer], { type: useMp4 ? "video/mp4" : "video/webm" });
    } finally {
        if (!completed) {
            try {
                await output.cancel();
            } catch {
                // 已经结束的输出会抛，忽略。
            }
        }
    }
}

async function forEachSample(blob: Blob, startMs: number | undefined, endMs: number | undefined, signal: AbortSignal | undefined, handler: (sample: MediaVideoSample) => Promise<void>) {
    const { MATROSKA, MP4, WEBM, BlobSource, Input, VideoSampleSink } = await loadLibrary();
    const input = new Input({ formats: [MP4, WEBM, MATROSKA], source: new BlobSource(blob) });
    try {
        const track = await input.getPrimaryVideoTrack();
        if (!track) throw new Error("NO_VIDEO_TRACK");
        const sink = new VideoSampleSink(track);
        const startSeconds = startMs === undefined ? undefined : startMs / 1000;
        const endSeconds = endMs === undefined ? undefined : endMs / 1000;
        for await (const sample of sink.samples(startSeconds, endSeconds)) {
            if (signal?.aborted) {
                sample.close();
                throw new DOMException("Aborted", "AbortError");
            }
            await handler(sample);
        }
    } finally {
        await disposeInput(input);
    }
}

async function* readAudioBuffers(blob: Blob, signal: AbortSignal | undefined) {
    const { MATROSKA, MP4, WEBM, AudioBufferSink, BlobSource, Input } = await loadLibrary();
    const input = new Input({ formats: [MP4, WEBM, MATROSKA], source: new BlobSource(blob) });
    try {
        const [track] = await input.getAudioTracks();
        if (!track) return;
        const sink = new AudioBufferSink(track);
        for await (const buffer of sink.buffers()) {
            if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
            yield buffer;
        }
    } finally {
        await disposeInput(input);
    }
}

function drawContained(context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, sample: MediaVideoSample, width: number, height: number) {
    const sourceWidth = sample.squarePixelWidth || width;
    const sourceHeight = sample.squarePixelHeight || height;
    const scale = Math.min(width / sourceWidth, height / sourceHeight);
    const drawWidth = sourceWidth * scale;
    const drawHeight = sourceHeight * scale;
    sample.draw(context, (width - drawWidth) / 2, (height - drawHeight) / 2, drawWidth, drawHeight);
}

function createCanvas(width: number, height: number): HTMLCanvasElement | OffscreenCanvas {
    if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(width, height);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    return canvas;
}

function even(value: number): number {
    return value % 2 === 0 ? value : value - 1;
}

async function disposeInput(input: unknown) {
    const disposable = input as { dispose?: () => unknown } | undefined;
    try {
        await Promise.resolve(disposable?.dispose?.());
    } catch {
        // 输入已释放。
    }
}
