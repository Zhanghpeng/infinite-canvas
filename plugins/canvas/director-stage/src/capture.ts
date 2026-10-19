// 截图会话：把「渲染出某一机位的画面」这件事从视口里抽出来。
//
// 为什么要抽：卡片上不再挂常驻 WebGL 视口（每个节点一个上下文，画布上铺几个就顶到浏览器上限），
// 所以卡片的导出按钮要走「临时建一个离屏视口 → 渲染 → 导出 → 立即释放」这条路径；
// 而大窗口编辑器里已经有活的视口，直接用它截就行。两者对 actions 暴露同一个接口。
import type { CapturedFrame } from "./exporter";
import { createStage, type StageHandle, type StageStatus } from "./stage";
import type { StageCamera, StageState } from "./stage-state";

export type CaptureOptions = {
    /** 用哪台机位渲染；不传就是当前机位 */
    camera?: StageCamera;
    /** 取时间轴上某一刻（人物走位也跟着摆）；不传就是编辑态的位置 */
    elapsedMs?: number;
};

export type CaptureSession = {
    /** 渲染某一机位/某一时刻并取回画面；失败返回 null。 */
    capture: (options?: CaptureOptions) => Promise<CapturedFrame | null>;
    dispose: () => void;
};

type StageSettled = Extract<StageStatus, { phase: "ready" } | { phase: "error" }>;

/** 逐帧渲染的视频帧源：直接把 canvas 交给编码器读像素，不做 dataURL 转换。 */
export type VideoFrameSource = {
    /** 等离屏视口就绪（失败会抛出原因，让调用方把它带到界面上）。 */
    ready: () => Promise<void>;
    /** 渲染指定机位/时刻到目标分辨率，返回承载画面的 canvas（失败返回 null）。 */
    renderFrame: (camera: StageCamera, elapsedMs?: number) => HTMLCanvasElement | null;
    dispose: () => void;
};

/**
 * 一次性离屏「视频帧源」。
 * 与 createOffscreenSession 的区别：那个给单张图片用（每帧都转 dataURL），这个给逐帧编码用。
 * 位置放在视口正中而不是屏幕外：MediaRecorder 降级路径靠 canvas.captureStream，
 * 元素必须真的参与合成才会出帧；居中会被模态面板整块盖住，用户看不见。
 */
export function createOffscreenVideoSource(initial: StageState, options: { height: number }): VideoFrameSource {
    const container = document.createElement("div");
    container.style.cssText = `position:fixed;left:50%;top:50%;width:${OFFSCREEN_WIDTH}px;height:${OFFSCREEN_HEIGHT}px;transform:translate(-50%,-50%);z-index:0;pointer-events:none;`;
    document.body.appendChild(container);

    let handle: StageHandle | null = null;
    let ready: Promise<void> | null = null;
    let disposed = false;

    const ensure = () => {
        if (handle) return Promise.resolve();
        if (!ready) {
            let settle: (status: StageSettled) => void = () => {};
            ready = new Promise<void>((resolve, reject) => {
                settle = (status) => (status.phase === "ready" ? resolve() : reject(new Error(status.message)));
            });
            const created = createStage(container, initial, () => {}, (status) => {
                if (status.phase !== "loading") settle(status);
            });
            ready.then(
                () => {
                    if (disposed) created.dispose();
                    else handle = created;
                },
                () => created.dispose(),
            );
        }
        return ready;
    };

    return {
        ready: ensure,
        renderFrame: (camera, elapsedMs) => (disposed || !handle ? null : handle.renderFrame({ height: options.height, camera, elapsedMs })),
        dispose: () => {
            disposed = true;
            handle?.dispose();
            handle = null;
            container.remove();
        },
    };
}

/** 离屏视口的容器尺寸：只决定 WebGL 后备缓冲，实际导出分辨率由 capture({height}) 决定。 */
const OFFSCREEN_WIDTH = 480;
const OFFSCREEN_HEIGHT = 270;

/**
 * 一次性离屏截图会话：第一次 capture 时才建视口（三个机位共用同一个，省掉三次上下文创建），
 * 用完务必 dispose，否则会一直占着一个 WebGL 上下文。
 */
export function createOffscreenSession(initial: StageState, options: { format: "jpeg" | "png"; height: number }): CaptureSession {
    let handle: StageHandle | null = null;
    let container: HTMLDivElement | null = null;
    let ready: Promise<void> | null = null;
    let disposed = false;

    const ensure = () => {
        if (handle) return Promise.resolve();
        if (!ready) {
            container = document.createElement("div");
            container.style.cssText = `position:fixed;left:-10000px;top:0;width:${OFFSCREEN_WIDTH}px;height:${OFFSCREEN_HEIGHT}px;pointer-events:none;opacity:0;`;
            document.body.appendChild(container);
            let settle: (status: { phase: "ready" } | { phase: "error"; message: string }) => void = () => {};
            ready = new Promise<void>((resolve, reject) => {
                settle = (status) => (status.phase === "ready" ? resolve() : reject(new Error(status.message)));
            });
            const created = createStage(container, initial, () => {}, (status) => {
                if (status.phase !== "loading") settle(status);
            });
            ready.then(
                () => {
                    if (disposed) created.dispose();
                    else handle = created;
                },
                () => created.dispose(),
            );
        }
        return ready;
    };

    return {
        capture: async (captureOptions) => {
            if (disposed) return null;
            // 初始化失败（例如环境没有 WebGL）要把原因抛出去，不能吞成一句「视口没准备好」。
            await ensure();
            if (!handle || disposed) return null;
            return handle.capture({ format: options.format, height: options.height, camera: captureOptions?.camera, elapsedMs: captureOptions?.elapsedMs });
        },
        dispose: () => {
            disposed = true;
            handle?.dispose();
            handle = null;
            container?.remove();
            container = null;
        },
    };
}
