// 大窗口导演台：摆位与调机位都在这块大视口里做。
//
// 为什么是模态、为什么用原生 DOM：
//  - 画布节点是个小卡片，在里面转视角又小又容易和「拖动节点」抢手势；
//  - 画布整体有 translate/scale 变换，节点内部的 position:fixed 会被变换吃掉（还会被 overflow 裁掉），
//    所以模态必须挂到 document.body 上；而插件拿不到 ReactDOM（运行时只注入 React），
//    因此这里自建一层极简 DOM 工具，不再依赖 React。
// 视图只在编辑器打开时创建，关闭即释放 WebGL 上下文；卡片上只留一张最近一次的预览图。
import type { CanvasNodeContext } from "@infinite-canvas/plugin-sdk";

import { attachMotionVideoNode, downloadMotionVideo, exportCurrentView, exportFirstLast, exportMultiView, exportPrompt, renderMotionVideo } from "./actions";
import type { CaptureSession } from "./capture";
import { countStageAssetUsage, exportStageLibrary, findStageAssetByName, importStageLibrary, listStageAssets, modelStorageKey, readStageAsset, removeStageAsset, renameStageAsset, saveStageAsset, STAGE_ASSET_BUDGET_BYTES, stageAssetTotalBytes, type StageAsset } from "./assets";
import { backdropUnavailable, listImageNodeOptions, resolveBackdropSource } from "./backdrop";
import { assetById, assetGroups, assetObjectKind } from "./library";
import { LIGHTING_PRESETS, lightingPresetById } from "./lighting";
import { overviewCamera } from "./markers";
import { applySceneToState, sceneById, sceneGroups, type SceneTemplate } from "./scenes";
import { createStageShot, hasMovement, motionFrameCountFor, MOTION_DURATIONS, MOTION_FPS, sceneEndMs, STAGE_SHOT_LIMIT, STAGE_TRACK_LIMIT, type StageMotionEasing, type StageShot } from "./motion";
import { describeTemplate, listUserTemplates, removeUserTemplate, renameUserTemplate, saveUserTemplate, STAGE_TEMPLATE_IDS_KEY, STAGE_TEMPLATE_LIMIT, stageStateToTemplate, templateRefs, USER_TEMPLATE_GROUP } from "./templates";
import { checkScene } from "./check";
import { describeShotSequence, frameWarnings } from "./prompt";
import { createStage, type CameraPreset, type StageHandle, type StageStatus } from "./stage";
import { createStageObject, normalizeStageState, type StageObject, type StageState } from "./stage-state";
import { formatBytes, MotionVideoCancelled } from "./video";

/** 版本号：卡片与窗口都标出来，排查时一眼看出跑的是哪个版本（bundle 有缓存时尤其重要）。 */
export const STAGE_VERSION = "0.15.0";

const PRESETS: Array<{ key: CameraPreset; label: string }> = [
    { key: "overShoulder", label: "过肩" },
    { key: "frontal", label: "正打" },
    { key: "top", label: "俯视" },
    { key: "wide", label: "全景" },
];

type StyleMap = Record<string, string>;

/** 极简 DOM 构造器：够用就好（style 用 camelCase，on* 直接挂事件）。 */
function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, unknown> = {}, children: Array<Node | string | null | false> = []): HTMLElementTagNameMap[K] {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
        if (value === undefined || value === null || value === false) continue;
        if (key === "style" && typeof value === "object") {
            for (const [prop, raw] of Object.entries(value as StyleMap)) (el.style as unknown as StyleMap)[prop] = raw;
        } else if (key === "text") el.textContent = String(value);
        else if (key === "class") el.className = String(value);
        else if (key.startsWith("on") && typeof value === "function") el.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
        else el.setAttribute(key, String(value));
    }
    for (const child of children) {
        if (child === null || child === false) continue;
        el.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
    }
    return el;
}

const OVERLAY_STYLE: StyleMap = { position: "fixed", inset: "0", zIndex: "2147483000", display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(6,7,10,.62)", backdropFilter: "blur(2px)", fontFamily: "system-ui,-apple-system,'Segoe UI',sans-serif", fontSize: "12px", color: "#e5e7eb", outline: "none" };
const PANEL_STYLE: StyleMap = { width: "min(1480px,96vw)", height: "min(920px,94vh)", display: "flex", flexDirection: "column", overflow: "hidden", background: "#14161a", border: "1px solid rgba(255,255,255,.12)", borderRadius: "16px", boxShadow: "0 32px 90px rgba(0,0,0,.6)" };
const HEADER_STYLE: StyleMap = { display: "flex", alignItems: "center", gap: "10px", padding: "10px 14px", borderBottom: "1px solid rgba(255,255,255,.08)" };
const BODY_STYLE: StyleMap = { flex: "1", display: "flex", minHeight: "0" };
const VIEWPORT_STYLE: StyleMap = { position: "relative", flex: "1", minWidth: "0", background: "#1b1c1f" };
const RAIL_STYLE: StyleMap = { flex: "0 0 384px", width: "384px", padding: "12px", display: "flex", flexDirection: "column", gap: "14px", overflowY: "auto", borderLeft: "1px solid rgba(255,255,255,.08)", background: "#171a1f" };
const SECTION_STYLE: StyleMap = { display: "flex", flexDirection: "column", gap: "8px" };
const SECTION_TITLE_STYLE: StyleMap = { fontWeight: "600", opacity: "0.85" };
const BUTTON_STYLE: StyleMap = { height: "28px", padding: "0 10px", borderRadius: "8px", border: "1px solid rgba(150,150,160,.4)", background: "rgba(255,255,255,.04)", color: "inherit", fontSize: "12px", cursor: "pointer", whiteSpace: "nowrap" };
const PRIMARY_BUTTON_STYLE: StyleMap = { ...BUTTON_STYLE, border: "1px solid rgba(59,130,246,.7)", background: "rgba(59,130,246,.22)" };
const ROW_STYLE: StyleMap = { display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" };
const CONTROL_STYLE: StyleMap = { height: "26px", borderRadius: "7px", border: "1px solid rgba(150,150,160,.35)", background: "rgba(255,255,255,.04)", color: "inherit", fontSize: "12px", padding: "0 6px" };
const HINT_STYLE: StyleMap = { opacity: "0.55" };

type ControlGroup = "camera" | "selection";

/**
 * 探一次 WebGL 是否可用。
 * 每次尝试都用**新的 canvas**：同一个 canvas 上失败的上下文请求会污染后续请求，
 * 用一个 canvas 连试 webgl2/webgl 容易误判。同时收下 webglcontextcreationerror 的说明，
 * 出问题时能直接告诉用户浏览器给的原因。
 */
function detectWebgl(): { ok: boolean; reason: string } {
    let lastReason = "";
    for (const kind of ["webgl2", "webgl", "experimental-webgl"]) {
        const canvas = document.createElement("canvas");
        let reason = "";
        const onError = (event: Event) => {
            reason = (event as WebGLContextEvent).statusMessage || "";
        };
        canvas.addEventListener("webglcontextcreationerror", onError);
        let context: unknown = null;
        try {
            context = (canvas.getContext as (id: string) => unknown)(kind);
        } catch (error) {
            reason = error instanceof Error ? error.message : String(error);
        }
        canvas.removeEventListener("webglcontextcreationerror", onError);
        if (context) return { ok: true, reason: "" };
        if (reason) lastReason = reason;
    }
    return { ok: false, reason: lastReason };
}

/** 已打开的编辑器按节点 id 去重；卡片卸载（节点删掉）时可以据此关掉它。 */
const openEditors = new Map<string, () => void>();

export function isStageEditorOpen(nodeId: string) {
    return openEditors.has(nodeId);
}

export function closeStageEditor(nodeId: string) {
    openEditors.get(nodeId)?.();
}

export function openStageEditor(ctx: CanvasNodeContext): void {
    if (openEditors.has(ctx.node.id)) return;

    let state: StageState = normalizeStageState(ctx.node.metadata?.stageState ?? undefined);
    let selectedId: string | null = state.objects[0]?.id ?? null;
    let closed = false;
    let busy = false;
    let listSignature = "";
    let shotSignature = "";
    let selectionFormId: string | null | undefined = undefined;
    let persistTimer = 0;
    let stage: StageHandle | null = null;
    let playing = false;
    let playFrame = 0;
    /** 自由视角中：视口从外面看场景，不改动保存的机位。 */
    let previewing = false;
    /** 套用模板是破坏性的（替换物体/机位/灯光），所以要两段确认。 */
    let pendingSceneId: string | null = null;
    /** 我的素材（插件级、跨节点共享）与「我的模板」，打开时异步读一次 */
    let stageAssets: StageAsset[] = [];
    let userTemplates: SceneTemplate[] = [];
    let pendingSceneTimer = 0;
    /** 撤销栈：存"上一次settle后的状态"快照（大窗口里画布 Ctrl+Z 被忽略，得自己来）。 */
    const undoStack: StageState[] = [];
    const UNDO_LIMIT = 20;
    let settledSnapshot = "";
    let lastUndoAt = 0;
    let videoBusy = false;
    let videoCancelled = false;

    const controls: Array<{ group: ControlGroup; input: HTMLInputElement; valueEl: HTMLElement; read: () => number; digits: number; suffix: string }> = [];

    const snapshot = (): StageState => ({
        ...state,
        objects: state.objects.map((object) => ({ ...object, ...(object.track ? { track: object.track.map((pose) => ({ ...pose })) } : {}) })),
        camera: { ...state.camera },
        shots: state.shots.map((shot) => ({ ...shot, camera: { ...shot.camera } })),
        motion: { ...state.motion },
    });

    const persist = (immediate = false) => {
        window.clearTimeout(persistTimer);
        if (immediate) {
            if (!closed) ctx.updateMetadata({ stageState: snapshot() });
            return;
        }
        persistTimer = window.setTimeout(() => {
            if (!closed) ctx.updateMetadata({ stageState: snapshot() });
        }, 250);
    };

    // ---------- DOM ----------
    const statusEl = h("div", { style: { fontSize: "11px", opacity: "0.75", minHeight: "16px" } });
    const viewport = h("div", { style: VIEWPORT_STYLE });
    const overlayRow = h("div", { style: { position: "absolute", left: "10px", top: "10px", display: "flex", gap: "6px", zIndex: "2" } });
    const rail = h("div", { style: RAIL_STYLE });
    const objectList = h("div", { style: { display: "flex", flexDirection: "column", gap: "4px", maxHeight: "168px", overflowY: "auto", border: "1px dashed rgba(150,150,160,.28)", borderRadius: "10px", padding: "6px" } });
    const selectionForm = h("div", { style: { display: "grid", gridTemplateColumns: "repeat(2,minmax(0,1fr))", gap: "6px" } });
    const stageHolder = h("div", { style: { position: "absolute", inset: "0" } });
    const shotList = h("div", { style: { display: "flex", flexDirection: "column", gap: "4px", maxHeight: "168px", overflowY: "auto", border: "1px dashed rgba(150,150,160,.28)", borderRadius: "10px", padding: "6px" } });
    const recordShotButton = h("button", { type: "button", style: PRIMARY_BUTTON_STYLE, text: "+ 记录当前机位" });
    const overviewButton = h("button", { type: "button", style: BUTTON_STYLE, text: "看全场（自由视角）" });
    const shotHint = h("div", { style: HINT_STYLE });

    const root = h("div", { "data-canvas-no-zoom": "", "data-canvas-shortcuts-ignore": "", tabindex: "-1", style: OVERLAY_STYLE });
    const panel = h("div", { style: PANEL_STYLE });
    const undoButton = h("button", { type: "button", style: { ...BUTTON_STYLE, marginLeft: "auto" }, text: "撤销 (⌘Z)", title: "回退上一步操作（大窗口内的操作）", onclick: () => undo() }) as HTMLButtonElement;
    const closeButton = h("button", { type: "button", style: BUTTON_STYLE, text: "关闭 (Esc)", onclick: () => close() });
    const header = h("div", { style: HEADER_STYLE }, [
        h("strong", { text: "3D 导演台" }),
        h("span", { style: HINT_STYLE, text: `v${STAGE_VERSION}` }),
        h("span", { style: HINT_STYLE, text: "拖空白 = 转视角 · 拖人物 = 地面移动 · 滚轮 = 焦距 · 双击空白 = 适应全部 · 点相机元素 = 切到那台机位 · 拖相机元素 = 调那台机位" }),
        undoButton,
        closeButton,
    ]);
    panel.appendChild(header);
    panel.appendChild(h("div", { style: BODY_STYLE }, [viewport, rail]));
    root.appendChild(panel);

    // ---------- 工具 ----------
    const apply = (next: StageState, options: { toStage?: boolean } = {}) => {
        stopPlayback();
        if (options.toStage !== false) pushUndo();
        state = next;
        if (options.toStage !== false) stage?.setState(next, { commit: false });
        persist();
        render();
    };

    const setStatus = (text: string) => {
        statusEl.textContent = text;
    };

    const run = async (action: () => Promise<string> | string) => {
        if (busy) return;
        busy = true;
        setStatus("处理中…");
        try {
            setStatus(await action());
        } catch (error) {
            setStatus(`导出失败：${error instanceof Error ? error.message : String(error)}`);
        } finally {
            busy = false;
            refreshButtons();
        }
    };

    const liveSession: CaptureSession = {
        capture: async (captureOptions) =>
            stage ? stage.capture({ format: state.exportFormat, height: state.exportHeight, camera: captureOptions?.camera, elapsedMs: captureOptions?.elapsedMs }) : null,
        dispose: () => {},
    };

    const slider = (
        group: ControlGroup,
        label: string,
        options: { min: number; max: number; step: number; suffix?: string; read: () => number; write: (value: number) => void },
    ) => {
        const digits = options.step < 1 ? 1 : 0;
        const valueEl = h("span", { style: { width: "50px", textAlign: "right", opacity: "0.75", fontVariantNumeric: "tabular-nums" } });
        const input = h("input", {
            type: "range",
            min: options.min,
            max: options.max,
            step: options.step,
            style: { flex: "1", minWidth: "56px" },
            oninput: (event: Event) => options.write(Number((event.target as HTMLInputElement).value)),
        });
        controls.push({ group, input, valueEl, read: options.read, digits, suffix: options.suffix ?? "" });
        return h("label", { style: { display: "flex", alignItems: "center", gap: "6px" } }, [h("span", { style: { opacity: "0.62", whiteSpace: "nowrap" }, text: label }), input, valueEl]);
    };

    const dropGroup = (group: ControlGroup) => {
        for (let index = controls.length - 1; index >= 0; index -= 1) if (controls[index].group === group) controls.splice(index, 1);
    };

    const syncControls = () => {
        for (const item of controls) {
            const value = item.read();
            item.input.value = String(value);
            item.valueEl.textContent = `${value.toFixed(item.digits)}${item.suffix}`;
        }
    };

    const formatSelect = h("select", { style: CONTROL_STYLE, onchange: (event: Event) => apply({ ...state, exportFormat: (event.target as HTMLSelectElement).value === "png" ? "png" : "jpeg" }) }, [h("option", { value: "jpeg", text: "JPEG（体积小）" }), h("option", { value: "png", text: "PNG（关键帧）" })]);
    const heightSelect = h("select", { style: CONTROL_STYLE, onchange: (event: Event) => apply({ ...state, exportHeight: (event.target as HTMLSelectElement).value === "1080" ? 1080 : 720 }) }, [h("option", { value: "720", text: "720p" }), h("option", { value: "1080", text: "1080p" })]);
    const localeSelect = h("select", { style: CONTROL_STYLE, onchange: (event: Event) => apply({ ...state, promptLocale: (event.target as HTMLSelectElement).value === "en" ? "en" : "zh" }) }, [h("option", { value: "zh", text: "中文" }), h("option", { value: "en", text: "English" })]);

    // 「运镜预演」控件：播放期间相机是临时动画，停止后恢复成保存的机位。
    const motionHint = h("div", { style: { ...HINT_STYLE, lineHeight: "1.6", whiteSpace: "pre-line" } });
    const playButton = h("button", { type: "button", style: PRIMARY_BUTTON_STYLE, text: "▶ 播放运镜" }) as HTMLButtonElement;
    const progressFill = h("div", { style: { width: "0%", height: "100%", background: "rgba(59,130,246,.85)", transition: "none" } });
    const progressTrack = h("div", { style: { height: "4px", borderRadius: "999px", background: "rgba(255,255,255,.12)", overflow: "hidden" } }, [progressFill]);
    const durationSelect = h("select", { style: CONTROL_STYLE }) as HTMLSelectElement;
    const fpsSelect = h("select", { style: CONTROL_STYLE }) as HTMLSelectElement;
    const easingSelect = h("select", { style: CONTROL_STYLE }) as HTMLSelectElement;
    for (const value of Array.from(new Set([...MOTION_DURATIONS, state.motion.durationMs])).sort((a, b) => a - b)) {
        durationSelect.appendChild(h("option", { value: String(value), text: `${(value / 1000).toFixed(value % 1000 ? 1 : 0)}s` }));
    }
    for (const value of Array.from(new Set([...MOTION_FPS, state.motion.fps])).sort((a, b) => a - b)) {
        fpsSelect.appendChild(h("option", { value: String(value), text: `${value}fps` }));
    }
    easingSelect.appendChild(h("option", { value: "easeInOut", text: "缓入缓出" }));
    easingSelect.appendChild(h("option", { value: "linear", text: "匀速" }));

    const videoStatusEl = h("span", { style: HINT_STYLE });
    const exportVideoButton = h("button", { type: "button", style: PRIMARY_BUTTON_STYLE, text: "导出运镜视频 → 视频节点" }) as HTMLButtonElement;
    const downloadVideoButton = h("button", { type: "button", style: BUTTON_STYLE, text: "下载视频" }) as HTMLButtonElement;
    const cancelVideoButton = h("button", { type: "button", style: { ...BUTTON_STYLE, display: "none" }, text: "取消编码" }) as HTMLButtonElement;

    const outputButtons: HTMLButtonElement[] = [];
    const refreshButtons = () => {
        for (const button of outputButtons) button.disabled = busy;
    };

    const renderObjectList = () => {
        const signature = `${selectedId}|${state.objects.map((object) => `${object.id}:${object.kind}:${object.name}:${object.visible}`).join(",")}`;
        if (signature === listSignature) return;
        listSignature = signature;
        objectList.replaceChildren();
        if (!state.objects.length) {
            objectList.appendChild(h("span", { style: HINT_STYLE, text: "还没有内容。从上面的素材库选「成年男 / 沙发 / 房间」加进来，就能摆出场景与关系。" }));
            return;
        }
        for (const object of state.objects) {
            const active = object.id === selectedId;
            objectList.appendChild(
                h("div", { style: { display: "flex", alignItems: "center", gap: "6px", padding: "2px 4px", borderRadius: "6px", background: active ? "rgba(59,130,246,.18)" : "transparent" } }, [
                    h("button", {
                        type: "button",
                        style: { ...BUTTON_STYLE, height: "22px", padding: "0 6px" },
                        text: active ? "已选" : "选择",
                        onclick: () => selectObject(object.id === selectedId ? null : object.id),
                    }),
                    h("input", {
                        value: object.name,
                        style: { ...CONTROL_STYLE, flex: "1", minWidth: "0" },
                        onchange: (event: Event) =>
                            apply({ ...state, objects: state.objects.map((item) => (item.id === object.id ? { ...item, name: (event.target as HTMLInputElement).value } : item)) }),
                    }),
                    h("span", { style: HINT_STYLE, text: object.kind === "person" ? "人物" : object.kind === "prop" ? "道具" : object.kind === "env" ? "环境" : "模型" }),
                    h("button", {
                        type: "button",
                        style: { ...BUTTON_STYLE, height: "22px", padding: "0 6px", opacity: object.visible ? "1" : "0.5" },
                        text: object.visible ? "显示" : "隐藏",
                        onclick: () => apply({ ...state, objects: state.objects.map((item) => (item.id === object.id ? { ...item, visible: !item.visible } : item)) }),
                    }),
                    h("button", { type: "button", style: { ...BUTTON_STYLE, height: "22px", padding: "0 6px" }, text: "删除", onclick: () => removeObject(object) }),
                ]),
            );
        }
    };

    const patchShots = (mapper: (shot: StageShot) => StageShot) => apply({ ...state, shots: state.shots.map(mapper) });

    const selectedShotId = () => (typeof ctx.node.metadata?.selectedShotId === "string" ? (ctx.node.metadata.selectedShotId as string) : "");

    const renderShotList = () => {
        const signature = `${selectedShotId()}|${state.shots.map((shot) => `${shot.id}:${shot.name}:${shot.holdMs}`).join(",")}`;
        if (signature === shotSignature) return;
        shotSignature = signature;
        shotList.replaceChildren();
        if (!state.shots.length) {
            shotList.appendChild(h("span", { style: HINT_STYLE, text: "还没有机位。摆好一个机位点「+ 记录当前机位」，记两个以上就能预演与导出运镜。" }));
            return;
        }
        state.shots.forEach((shot, index) => {
            const hold = h("select", {
                style: { ...CONTROL_STYLE, height: "22px", padding: "0 2px" },
                title: "在这个机位停留多久再走下一段",
                onchange: (event: Event) => {
                    const value = Number((event.target as HTMLSelectElement).value);
                    patchShots((item) => (item.id === shot.id ? { ...item, holdMs: value } : item));
                },
            }) as HTMLSelectElement;
            const holdOptions: Array<[number, string]> = [[0, "停留 0s"], [500, "停 0.5s"], [1000, "停 1s"], [2000, "停 2s"]];
            // 值不在预设里（例如 Agent 写进来的 3000ms）也要能显示出来，否则下拉是空白的
            if (!holdOptions.some(([value]) => value === shot.holdMs)) holdOptions.push([shot.holdMs, `停 ${(shot.holdMs / 1000).toFixed(1)}s`]);
            for (const [value, label] of holdOptions.sort((a, b) => a[0] - b[0])) {
                hold.appendChild(h("option", { value: String(value), text: label }));
            }
            hold.value = String(shot.holdMs);

            const active = selectedShotId() === shot.id;
            shotList.appendChild(
                h("div", { style: { display: "flex", alignItems: "center", gap: "4px", padding: "2px 4px", borderRadius: "6px", background: active ? "rgba(47,128,255,.18)" : "transparent" } }, [
                    h("span", { style: { ...HINT_STYLE, width: "18px" }, text: `#${index + 1}` }),
                    h("input", {
                        value: shot.name,
                        style: { ...CONTROL_STYLE, flex: "1", minWidth: "0" },
                        onchange: (event: Event) => {
                            const name = (event.target as HTMLInputElement).value;
                            patchShots((item) => (item.id === shot.id ? { ...item, name } : item));
                        },
                    }),
                    h("button", {
                        type: "button",
                        style: { ...BUTTON_STYLE, height: "22px", padding: "0 6px" },
                        text: "切到",
                        title: "把当前镜头切到这台机位（之后记录机位、播放、导出都从它开始）",
                        onclick: () => switchToShot(shot.id),
                    }),
                    h("button", {
                        type: "button",
                        style: { ...BUTTON_STYLE, height: "22px", padding: "0 6px" },
                        text: "覆盖",
                        title: "把这一帧改成「当前机位」的样子；也可以直接在场景里拖动那台相机来调它",
                        onclick: () => patchShots((item) => (item.id === shot.id ? { ...item, camera: { ...state.camera } } : item)),
                    }),
                    hold,
                    h("button", {
                        type: "button",
                        style: { ...BUTTON_STYLE, height: "22px", padding: "0 5px" },
                        text: "×",
                        title: "删除这个机位",
                        onclick: () => apply({ ...state, shots: state.shots.filter((item) => item.id !== shot.id) }),
                    }),
                ]),
            );
        });
    };

    const trackSignature = (id: string | null) => {
        const object = state.objects.find((item) => item.id === id);
        return (object?.track || []).map((pose) => `${pose.x},${pose.z},${pose.rotationYDeg},${pose.holdMs}`).join("|");
    };

    const renderSelectionForm = () => {
        const formKey = `${selectedId}|${trackSignature(selectedId)}`;
        if (selectionFormId === formKey) return;
        selectionFormId = formKey;
        dropGroup("selection");
        selectionForm.replaceChildren();
        const selected = state.objects.find((object) => object.id === selectedId);
        if (!selected) {
            selectionForm.appendChild(h("span", { style: HINT_STYLE, text: "选中一个物体后可调它的位置、朝向与缩放。" }));
            return;
        }
        const select = (id: string) => state.objects.find((item) => item.id === id) || selected;
        const patch = (value: Partial<StageObject>) => apply({ ...state, objects: state.objects.map((item) => (item.id === selected.id ? { ...item, ...value } : item)) });
        const patchTrack = (mapper: (track: NonNullable<StageObject["track"]>) => StageObject["track"]) =>
            apply({ ...state, objects: state.objects.map((item) => (item.id === selected.id ? { ...item, track: mapper(item.track || []) } : item)) });

        selectionForm.append(
            slider("selection", "横向 x", { min: -8, max: 8, step: 0.1, read: () => select(selected.id).x, write: (value) => patch({ x: value }) }),
            slider("selection", "纵深 z", { min: -8, max: 8, step: 0.1, read: () => select(selected.id).z, write: (value) => patch({ z: value }) }),
            slider("selection", "朝向", { min: -180, max: 180, step: 5, suffix: "°", read: () => select(selected.id).rotationYDeg, write: (value) => patch({ rotationYDeg: value }) }),
            slider("selection", "缩放", { min: 0.5, max: 2, step: 0.05, read: () => select(selected.id).scale, write: (value) => patch({ scale: value }) }),
        );

        // 走位（blocking）：和机位一样是"按当前状态记点"，但共用同一条时间轴
        const track = selected.track || [];
        const trackHint = h("div", { style: { ...HINT_STYLE, gridColumn: "1 / -1", lineHeight: "1.6" } });
        const trackList = h("div", { style: { display: "flex", flexDirection: "column", gap: "3px", gridColumn: "1 / -1" } });
        if (!track.length) {
            trackHint.textContent = `把物体挪到位再点「记录走位点」；记两个以上就会在播放/导出时按时间轴移动（与机位共用同一条时间轴）。`;
        } else if (track.length < 2) {
            trackHint.textContent = `已记 ${track.length} 个走位点（还需要 ≥2 个才会动）；再挪一下位置记第二个点。`;
        } else {
            trackHint.textContent = `走位 ${track.length} 个点 · 与机位共用同一条时间轴（全程约 ${(sceneEndMs(state) / 1000).toFixed(1)}s）；播放与导出时${
                hasMovement(track) ? "会动" : "位置没变（几个点在同一处）"
            }。`;
        }
        trackList.appendChild(trackHint);
        track.forEach((pose, index) => {
            const hold = h("select", {
                style: { ...CONTROL_STYLE, height: "22px", padding: "0 2px" },
                title: "到这个点之后停留多久",
                onchange: (event: Event) => {
                    const value = Number((event.target as HTMLSelectElement).value);
                    patchTrack((current) => current.map((item, itemIndex) => (itemIndex === index ? { ...item, holdMs: value } : item)));
                },
            }) as HTMLSelectElement;
            const holdOptions: Array<[number, string]> = [[0, "停留 0s"], [500, "停 0.5s"], [1000, "停 1s"], [2000, "停 2s"]];
            if (!holdOptions.some(([value]) => value === pose.holdMs)) holdOptions.push([pose.holdMs, `停 ${(pose.holdMs / 1000).toFixed(1)}s`]);
            for (const [value, label] of holdOptions.sort((a, b) => a[0] - b[0])) hold.appendChild(h("option", { value: String(value), text: label }));
            hold.value = String(pose.holdMs);

            trackList.appendChild(
                h("div", { style: { display: "flex", alignItems: "center", gap: "4px" } }, [
                    h("span", { style: { ...HINT_STYLE, width: "18px" }, text: `#${index + 1}` }),
                    h("span", { style: { ...HINT_STYLE, flex: "1", minWidth: "0", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }, text: `(${pose.x.toFixed(1)}, ${pose.z.toFixed(1)}) · ${Math.round(pose.rotationYDeg)}°` }),
                    hold,
                    h("button", {
                        type: "button",
                        style: { ...BUTTON_STYLE, height: "22px", padding: "0 5px" },
                        text: "×",
                        title: "删除这个走位点",
                        onclick: () => patchTrack((current) => current.filter((_, itemIndex) => itemIndex !== index)),
                    }),
                ]),
            );
        });
        trackList.appendChild(
            h("div", { style: { display: "flex", gap: "4px", marginTop: "2px" } }, [
                h("button", {
                    type: "button",
                    style: { ...PRIMARY_BUTTON_STYLE, height: "24px", padding: "0 8px" },
                    text: "记录走位点",
                    title: "把物体当前的位置与朝向记成下一个走位点",
                    onclick: () => {
                        const object = select(selected.id);
                        if ((object.track || []).length >= STAGE_TRACK_LIMIT) {
                            setStatus(`走位点最多 ${STAGE_TRACK_LIMIT} 个，先删几个再记`);
                            return;
                        }
                        patchTrack((current) => [...current, { x: object.x, z: object.z, rotationYDeg: object.rotationYDeg, holdMs: 0 }]);
                        setStatus(`已记录「${object.name}」的第 ${(object.track || []).length + 1} 个走位点（点「播放运镜」看走位，与机位同步）`);
                    },
                }),
                h("button", {
                    type: "button",
                    style: { ...BUTTON_STYLE, height: "24px", padding: "0 8px" },
                    text: "清空走位",
                    onclick: () => patchTrack(() => undefined),
                }),
            ]),
        );
        selectionForm.append(trackList);
    };

    /**
     * 压栈：只压"与栈顶不同"的快照；连续拖动（400ms 内）合并成一步，免得一次拖拽产生几十条撤销。
     */
    const pushUndo = () => {
        if (!settledSnapshot) return;
        const now = performance.now();
        if (now - lastUndoAt < 400 && undoStack.length) {
            lastUndoAt = now;
            return;
        }
        lastUndoAt = now;
        if (undoStack.length && JSON.stringify(undoStack[undoStack.length - 1]) === settledSnapshot) return;
        undoStack.push(JSON.parse(settledSnapshot) as StageState);
        if (undoStack.length > UNDO_LIMIT) undoStack.shift();
    };

    const undo = () => {
        const previous = undoStack.pop();
        if (!previous) {
            setStatus("没有可撤销的操作了");
            render();
            return;
        }
        stopPlayback();
        state = previous;
        settledSnapshot = JSON.stringify(previous);
        stage?.setState(previous, { commit: false });
        persist(true);
        render();
        setStatus("已撤销上一步");
    };

    const render = () => {
        renderObjectList();
        renderSelectionForm();
        syncControls();
        renderShotList();
        const totalMs = sceneEndMs(state);
        lightingSelect.value = state.lighting;
        lightingHint.textContent = lightingPresetById(state.lighting).description;
        const confirming = pendingSceneId !== null && pendingSceneId === sceneSelect.value;
        applySceneButton.textContent = confirming ? "确认套用（会替换当前内容）" : "套用模板";
        applySceneButton.style.borderColor = confirming ? "rgba(239,68,68,.75)" : "rgba(59,130,246,.7)";
        sceneHint.textContent = confirming
            ? "再点一次即套用：会替换当前节点的物体、机位与灯光（导出格式/语言保留）。"
            : sceneById(sceneSelect.value)?.description || "";
        overviewButton.textContent = previewing ? "回到当前机位" : "看全场（自由视角）";
        shotHint.textContent = previewing
            ? "自由视角中：从外面看场景，能看到所有相机元素；转视角只影响这个视角，右侧「机位」滑块改的仍是当前机位 —— 所以可以在外面一边看一边把机位挪到位。点「回到当前机位」回到自己的镜头。"
            : state.shots.length < 2
              ? `记录至少两个机位才有运镜（现在 ${state.shots.length}/${STAGE_SHOT_LIMIT}）。点场景里的相机元素是「选中它并站到外面看全场」（方便调布局），要把它当作镜头就点列表里的「切到」。`
              : `共 ${state.shots.length} 个机位 · 全程约 ${(totalMs / 1000).toFixed(1)}s`;
        recordShotButton.disabled = state.shots.length >= STAGE_SHOT_LIMIT;
        recordShotButton.style.opacity = state.shots.length >= STAGE_SHOT_LIMIT ? "0.5" : "1";
        durationSelect.value = String(state.motion.durationMs);
        fpsSelect.value = String(state.motion.fps);
        easingSelect.value = state.motion.easing;
        const canPlay = state.shots.length >= 2;
        const hasBlocking = state.objects.some((object) => hasMovement(object.track));
        playButton.textContent = playing ? "■ 停止" : hasBlocking ? "▶ 播放（人物走位 + 运镜）" : "▶ 播放运镜";
        playButton.disabled = videoBusy || (!playing && !canPlay);
        playButton.style.opacity = !playing && (!canPlay || videoBusy) ? "0.5" : "1";
        exportVideoButton.disabled = videoBusy || !canPlay;
        downloadVideoButton.disabled = videoBusy || !canPlay;
        exportVideoButton.style.opacity = !canPlay ? "0.5" : "1";
        downloadVideoButton.style.opacity = !canPlay ? "0.5" : "1";
        cancelVideoButton.style.display = videoBusy ? "inline-flex" : "none";
        const warnings = frameWarnings(state, 24);
        const blockingSummary = hasBlocking
            ? `人物走位：${state.objects
                  .filter((object) => hasMovement(object.track))
                  .map((object) => `${object.name} ${(object.track || []).length} 点`)
                  .join(" · ")}（播放时与镜头同一条时间轴）`
            : "";
        // 自检：顺手显示"这一镜有什么问题"（走位出画单独一行，这里排除 track 免得重复）
        const check = checkScene(state, { backdropUnavailable: backdropUnavailable(ctx.getNodes(), state.backdrop?.nodeId) });
        const checkIssues = check.issues.filter((issue) => issue.code !== "track");
        const checkLine = !checkIssues.length ? "✓ 自检通过" : checkIssues.slice(0, 3).map((issue) => `${issue.level === "error" ? "✗" : "⚠"} ${issue.text}`).join("\n") + (checkIssues.length > 3 ? `\n… 还有 ${checkIssues.length - 3} 条` : "");
        motionHint.textContent = [
            canPlay ? describeShotSequence(state.shots, state.motion, state.promptLocale) : "先用上面的「记录当前机位」记两个以上机位，再播放 —— 播放的是这些机位之间的连续运镜。",
            blockingSummary,
            warnings.length ? `⚠ 走位预警：${warnings.slice(0, 3).join("；")}${warnings.length > 3 ? ` 等 ${warnings.length} 处` : ""}` : "",
            checkLine,
        ]
            .filter(Boolean)
            .join("\n");
        refreshBackdrop();
        undoButton.disabled = undoStack.length === 0;
        undoButton.style.opacity = undoStack.length === 0 ? "0.45" : "1";
        formatSelect.value = state.exportFormat;
        heightSelect.value = String(state.exportHeight);
        localeSelect.value = state.promptLocale;
        // 记下"这一轮渲染之后的状态"，作为下一次操作要压栈的回退点
        settledSnapshot = JSON.stringify(snapshot());
    };

    function stopPlayback() {
        if (!playing) return;
        playing = false;
        window.cancelAnimationFrame(playFrame);
        progressFill.style.width = "0%";
        // 预演不改状态：停止后把画面恢复到保存的机位与编辑态位置，并把编辑辅助放回来
        stage?.setPlayhead(null);
        stage?.setEditingAidsVisible(true);
        stage?.setRenderQuality(false);
        stage?.setInteractive(true);
        render();
    }

    function startPlayback() {
        if (state.shots.length < 2 || playing) return;
        const totalMs = sceneEndMs(state);
        if (previewing) {
            previewing = false;
            stage?.setPreviewCamera(null);
        }
        playing = true;
        stage?.setInteractive(false);
        // 播放就是"看成片"：不带选中高亮，也不带相机元素
        stage?.setEditingAidsVisible(false);
        stage?.setRenderQuality(true);
        render();
        const startedAt = performance.now();
        const tick = (now: number) => {
            if (!playing) return;
            const progress = Math.min(1, (now - startedAt) / totalMs);
            // 相机与人物在同一条时间轴上推进
            stage?.setPlayhead(progress * totalMs);
            progressFill.style.width = `${Math.round(progress * 100)}%`;
            if (progress >= 1) {
                stopPlayback();
                return;
            }
            playFrame = window.requestAnimationFrame(tick);
        };
        playFrame = window.requestAnimationFrame(tick);
    }

    /** 导出运镜视频：mode=node 落成画布视频节点，mode=download 直接下载。 */
    function runVideoExport(mode: "node" | "download") {
        if (videoBusy) return;
        if (state.shots.length < 2) {
            setStatus("先在「机位」里记录至少两个机位，再导出运镜视频");
            return;
        }
        stopPlayback();
        videoBusy = true;
        videoCancelled = false;
        const total = motionFrameCountFor(state.shots, state.motion);
        videoStatusEl.textContent = `编码中 0/${total}`;
        render();
        void (async () => {
            try {
                const result = await renderMotionVideo(state, {
                    onProgress: (done, count) => {
                        progressFill.style.width = `${Math.round((done / count) * 100)}%`;
                        videoStatusEl.textContent = `编码中 ${done}/${count}`;
                    },
                    shouldStop: () => videoCancelled,
                });
                const container = result.container === "video/mp4" ? "mp4" : "WebM（浏览器不支持 mp4 编码，已降级）";
                const size = formatBytes(result.blob.size);
                if (mode === "download") {
                    downloadMotionVideo(result);
                    setStatus(`已下载 ${container} · ${result.width}×${result.height} · ${(result.durationMs / 1000).toFixed(1)}s · ${size}`);
                } else {
                    setStatus(`${await attachMotionVideoNode(ctx, result, state)} ｜ ${container} · ${result.width}×${result.height} · ${size}`);
                }
            } catch (error) {
                setStatus(error instanceof MotionVideoCancelled ? "已取消编码" : `导出失败：${error instanceof Error ? error.message : String(error)}`);
            } finally {
                videoBusy = false;
                progressFill.style.width = "0%";
                videoStatusEl.textContent = "";
                render();
            }
        })();
    }

    exportVideoButton.addEventListener("click", () => runVideoExport("node"));
    downloadVideoButton.addEventListener("click", () => runVideoExport("download"));
    cancelVideoButton.addEventListener("click", () => {
        videoCancelled = true;
        videoStatusEl.textContent = "正在取消…";
    });

    const selectObject = (id: string | null) => {
        selectedId = id;
        stage?.setSelected(id);
        render();
    };

    const removeObject = (object: StageObject) => {
        // 字节归素材库所有：删物体不再删字节（否则会连带删掉别人在用的同一份素材）。
        // 真正不再需要这份素材时，在素材区「从素材库删除」里删（那里会提示还有几个物体在用）。
        if (selectedId === object.id) selectedId = null;
        stage?.setSelected(null);
        apply({ ...state, objects: state.objects.filter((item) => item.id !== object.id) });
    };

    const resolveTemplate = (id: string): SceneTemplate | null => userTemplates.find((template) => template.id === id) ?? sceneById(id) ?? null;

    const applyTemplate = (id: string) => {
        const template = resolveTemplate(id);
        if (!template) return;
        window.clearTimeout(pendingSceneTimer);
        pendingSceneId = null;
        // 模板可能来自插件存储（用户模板），过一遍归一化再进场景
        const next = normalizeStageState(applySceneToState(state, template));
        selectedId = next.objects[0]?.id ?? null;
        apply(next);
        stage?.setSelected(selectedId);
        restoreModels();
        setStatus(`已套用模板「${template.name}」：${next.objects.length} 个物体 · ${next.shots.length} 个机位 · 灯光「${lightingPresetById(next.lighting).name}」（导出设置保留）`);
    };

    /** 把当前场景存成「我的模板」（物体/机位/走位/运镜/灯光；导出偏好不进模板）。 */
    const saveCurrentAsTemplate = async () => {
        if (userTemplates.length >= STAGE_TEMPLATE_LIMIT) {
            setStatus(`「我的模板」最多 ${STAGE_TEMPLATE_LIMIT} 个，先删掉不用的再存`);
            return;
        }
        const name = (templateNameInput.value || "").trim() || `我的模板 ${userTemplates.length + 1}`;
        const template = stageStateToTemplate(state, name, `mine-${Date.now().toString(36)}-${Math.floor(Math.random() * 1000)}`);
        userTemplates = await saveUserTemplate(ctx.storage, template);
        syncTemplateRefs();
        refreshTemplateSelect(template.id);
        setStatus(`已存为「我的模板 · ${name}」：${template.description}`);
    };

    /** 从内置素材库添加：环境类落在原点（人站进去），人物/道具在镜头前错开排布。 */
    const addBuiltinAsset = (assetId: string) => {
        const asset = assetById(assetId);
        if (!asset) return;
        const kind = assetObjectKind(asset);
        const sameKind = state.objects.filter((object) => object.kind === kind).length;
        const spawn =
            asset.kind === "env"
                ? { x: 0, z: 0 }
                : { x: ((sameKind % 4) - 1.5) * 1.3, z: 0.7 - Math.floor(sameKind / 4) * 1.2 };
        const object = { ...createStageObject(kind, asset.name, spawn.x, spawn.z), assetId: asset.id };
        selectedId = object.id;
        apply({ ...state, objects: [...state.objects, object] });
        stage?.setSelected(object.id);
        setStatus(`已添加「${asset.name}」（${asset.kind === "person" ? "人物" : asset.kind === "prop" ? "道具" : "环境"}）`);
    };

    const blobToBase64 = async (blob: Blob) => {
        const buffer = new Uint8Array(await blob.arrayBuffer());
        let binary = "";
        for (let index = 0; index < buffer.length; index += 0x8000) binary += String.fromCharCode(...buffer.subarray(index, index + 0x8000));
        return btoa(binary);
    };

    const importModel = async (file: File) => {
        if (!stage) return;
        setStatus(`正在导入 ${file.name}…`);
        try {
            // 同名同大小就当同一份素材：直接复用库里的，不重复占存储、不重复上传
            const assets = await listStageAssets(ctx.storage);
            const reused = findStageAssetByName(assets, file.name, file.size);
            if (reused && (await readStageAsset(ctx.storage, reused.id))) {
                await addLibraryAsset(reused.id);
                setStatus(`已复用「我的素材」里的同名模型「${reused.name}」`);
                return;
            }
            const total = stageAssetTotalBytes(assets);
            const object = await stage.loadModel(file);
            const modelKey = object.id;
            await ctx.storage.set(modelStorageKey(modelKey), { name: file.name, base64: await blobToBase64(file) });
            stageAssets = await saveStageAsset(ctx.storage, { id: modelKey, name: file.name, size: file.size });
            refreshMyAssets();
            selectedId = object.id;
            apply({ ...state, objects: [...state.objects.filter((item) => item.id !== object.id), { ...object, modelKey }] });
            setStatus(
                total + file.size > STAGE_ASSET_BUDGET_BYTES
                    ? `已导入 ${file.name}（已进「我的素材」；素材库已占 ${formatBytes(total + file.size)}，建议先删掉不用的或导出备份）`
                    : `已导入 ${file.name}（已进「我的素材」，其它导演台节点也能直接选用）`,
            );
        } catch (error) {
            setStatus(`导入失败：${error instanceof Error ? error.message : String(error)}（确认是 .glb/.gltf，且文件没损坏）`);
        }
    };

    // ---------- 视口 ----------
    const presetRow = PRESETS.map((preset) =>
        h("button", {
            type: "button",
            style: BUTTON_STYLE,
            text: preset.label,
            onclick: () => {
                stage?.applyPreset(preset.key);
                if (stage) state = stage.getState();
                persist();
                render();
            },
        }),
    );
    presetRow.push(
        h("button", {
            type: "button",
            style: BUTTON_STYLE,
            text: "适应全部",
            onclick: () => {
                stage?.frameAll();
                if (stage) state = stage.getState();
                persist();
                render();
            },
        }),
    );
    overlayRow.append(...presetRow);
    viewport.append(stageHolder, overlayRow);

    // ---------- 侧栏 ----------
    const sceneSelect = h("select", { style: { ...CONTROL_STYLE, flex: "1", minWidth: "0" }, title: "场景模板：一整套环境/人物/道具/机位/运镜/灯光" }) as HTMLSelectElement;
    for (const group of sceneGroups()) {
        const optgroup = document.createElement("optgroup");
        optgroup.label = group.label;
        for (const scene of group.scenes) optgroup.appendChild(h("option", { value: scene.id, text: scene.name }));
        sceneSelect.appendChild(optgroup);
    }
    const applySceneButton = h("button", { type: "button", style: PRIMARY_BUTTON_STYLE, text: "套用模板" });
    const sceneHint = h("div", { style: { ...HINT_STYLE, lineHeight: "1.6" } });
    const lightingSelect = h("select", { style: { ...CONTROL_STYLE, flex: "1", minWidth: "0" }, title: "灯光预设：真实拍摄里光比机位还决定画面" }) as HTMLSelectElement;
    for (const preset of LIGHTING_PRESETS) lightingSelect.appendChild(h("option", { value: preset.id, text: `灯光 · ${preset.name}` }));
    const lightingHint = h("div", { style: HINT_STYLE });

    // 「我的模板」是动态分组：存/删/改名后重建（内置模板分组是静态的）
    const myTemplatesGroup = document.createElement("optgroup");
    myTemplatesGroup.label = USER_TEMPLATE_GROUP;
    sceneSelect.appendChild(myTemplatesGroup);
    const templateNameInput = h("input", { placeholder: "我的模板名（可选）", style: { ...CONTROL_STYLE, flex: "1", minWidth: "0" } }) as HTMLInputElement;
    const saveTemplateButton = h("button", { type: "button", style: BUTTON_STYLE, text: "存为我的模板", title: "把当前场景（物体 / 机位 / 走位 / 运镜 / 灯光）存成可复用的模板" });
    const templateNameEdit = h("input", { style: { ...CONTROL_STYLE, flex: "1", minWidth: "0" }, title: "重命名「我的模板」" }) as HTMLInputElement;
    const deleteTemplateButton = h("button", { type: "button", style: { ...BUTTON_STYLE, color: "#f87171" }, text: "删除这个模板" });
    const templateEditRow = h("div", { style: ROW_STYLE }, [templateNameEdit, deleteTemplateButton]);
    templateEditRow.style.display = "none";

    const assetSelect = h("select", { style: { ...CONTROL_STYLE, flex: "1", minWidth: "0" }, title: "内置素材库（人物 / 道具 / 环境）+ 我的素材" }) as HTMLSelectElement;
    for (const group of assetGroups()) {
        const optgroup = document.createElement("optgroup");
        optgroup.label = group.label;
        for (const asset of group.assets) optgroup.appendChild(h("option", { value: asset.id, text: asset.name }));
        assetSelect.appendChild(optgroup);
    }
    const myAssetsGroup = document.createElement("optgroup");
    myAssetsGroup.label = "我的素材";
    assetSelect.appendChild(myAssetsGroup);
    const addAssetButton = h("button", { type: "button", style: PRIMARY_BUTTON_STYLE, text: "+ 添加" });

    // 选中「我的素材」时出现的行：改名 / 从素材库删除
    const assetNameEdit = h("input", { style: { ...CONTROL_STYLE, flex: "1", minWidth: "0" }, title: "重命名这份素材（只改素材库里的名字，不影响场景里的物体名）" }) as HTMLInputElement;
    const deleteAssetButton = h("button", { type: "button", style: { ...BUTTON_STYLE, color: "#f87171" }, text: "从素材库删除" });
    const assetEditRow = h("div", { style: ROW_STYLE }, [assetNameEdit, deleteAssetButton]);
    assetEditRow.style.display = "none";
    const assetHint = h("div", { style: HINT_STYLE });

    // 背景板：把画布上某张已生成的图当场景背景（人物合成在真画面里）
    const backdropSelect = h("select", { style: { ...CONTROL_STYLE, flex: "1", minWidth: "0" }, title: "背景板：选一张画布上的图片当场景背景（只记节点 id，那张图重新生成后会自动更新）" }) as HTMLSelectElement;
    const applyBackdropButton = h("button", { type: "button", style: PRIMARY_BUTTON_STYLE, text: "设为背景板" });
    const clearBackdropButton = h("button", { type: "button", style: BUTTON_STYLE, text: "清除背景板" });
    const hideEnvCheckbox = h("input", { type: "checkbox", title: "背景板打开时环境类素材不再渲染（它们只是占位，真环境就是这张图）" }) as HTMLInputElement;
    const hideEnvLabel = h("label", { style: { display: "inline-flex", alignItems: "center", gap: "4px", ...HINT_STYLE }, title: "背景板打开时环境类素材不再渲染（它们只是占位，真环境就是这张图）" }, [hideEnvCheckbox, "隐藏环境类素材"]);
    const backdropHint = h("div", { style: { ...HINT_STYLE, lineHeight: "1.6" } });

    const fileInput = h("input", {
        type: "file",
        accept: ".glb,.gltf",
        style: { display: "none" },
        onchange: (event: Event) => {
            const input = event.target as HTMLInputElement;
            const file = input.files?.[0];
            input.value = "";
            if (file) void importModel(file);
        },
    });
    const importLabel = h("label", { style: { ...BUTTON_STYLE, display: "inline-flex", alignItems: "center" } }, ["导入 glb", fileInput]);
    const exportLibraryButton = h("button", { type: "button", style: BUTTON_STYLE, text: "导出素材库", title: "把自己做的素材备份成一个 JSON（换机器 / 清浏览器前留底）" });
    const libraryInput = h("input", {
        type: "file",
        accept: ".json,application/json",
        style: { display: "none" },
        onchange: (event: Event) => {
            const input = event.target as HTMLInputElement;
            const file = input.files?.[0];
            input.value = "";
            if (file) void importLibrary(file);
        },
    });
    const importLibraryLabel = h("label", { style: { ...BUTTON_STYLE, display: "inline-flex", alignItems: "center" } }, ["导入素材库", libraryInput]);

    // ---------- 素材库与「我的模板」 ----------
    const selectedLibraryId = () => (assetSelect.value.startsWith("mine:") ? assetSelect.value.slice("mine:".length) : "");

    const bytesFromBase64 = (base64: string) => Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));

    /** 重建素材下拉里的「我的素材」分组，以及说明行 / 编辑行。 */
    const refreshMyAssets = () => {
        const keep = assetSelect.value;
        myAssetsGroup.label = `我的素材（${stageAssets.length}）`;
        myAssetsGroup.replaceChildren(...stageAssets.map((asset) => h("option", { value: `mine:${asset.id}`, text: `${asset.name} · ${formatBytes(asset.size)}` })));
        if (stageAssets.some((asset) => `mine:${asset.id}` === keep)) assetSelect.value = keep;
        const current = stageAssets.find((asset) => asset.id === selectedLibraryId());
        assetEditRow.style.display = current ? "flex" : "none";
        if (current) assetNameEdit.value = current.name;
        const total = stageAssetTotalBytes(stageAssets);
        assetHint.textContent = stageAssets.length
            ? `我的素材：${stageAssets.length} 份 · 共 ${formatBytes(total)}（存在本机；同一个素材摆多个物体只解析/上传一次）`
            : "「我的素材」为空：导入 glb 后会自动进来，之后任何导演台节点都能直接选用它，不用再导一遍。";
    };

    /** 从「我的素材」添加一个物体：复用库里的字节，不重复存。 */
    const addLibraryAsset = async (id: string) => {
        const stored = await readStageAsset(ctx.storage, id);
        if (!stored) {
            setStatus("这份素材在本机找不到字节了（可能被浏览器清理过），请重新导入 glb");
            stageAssets = await listStageAssets(ctx.storage);
            refreshMyAssets();
            return;
        }
        const sameKind = state.objects.filter((object) => object.kind === "model").length;
        const object = {
            ...createStageObject("model", stored.name.replace(/\.[^.]+$/, "") || "模型", ((sameKind % 4) - 1.5) * 1.3, 0.7 - Math.floor(sameKind / 4) * 1.2),
            sourceName: stored.name,
            modelKey: id,
        };
        selectedId = object.id;
        apply({ ...state, objects: [...state.objects, object] });
        stage?.setSelected(object.id);
        void stage?.loadModel({ name: stored.name, arrayBuffer: async () => bytesFromBase64(stored.base64).buffer }, { objectId: object.id, cacheKey: id });
        setStatus(`已添加素材「${stored.name}」`);
    };

    let backdropSignature = "";
    /** 背景板：重建下拉、把贴图交给视口、写说明行。会在打开 / 切换图片节点 / 改状态后被调用。 */
    const refreshBackdrop = () => {
        const nodes = ctx.getNodes();
        const options = listImageNodeOptions(nodes);
        const currentId = state.backdrop?.nodeId ?? "";
        const hideEnvironment = state.backdrop?.hideEnvironment !== false;
        const signature = `${options.map((option) => `${option.id}:${option.title}:${option.ready}`).join(",")}|${currentId}|${hideEnvironment}`;
        if (signature !== backdropSignature) {
            backdropSignature = signature;
            backdropSelect.replaceChildren(...options.map((option) => h("option", { value: option.id, text: `${option.title}${option.ready ? "" : "（还没有画面）"}` })));
            if (options.some((option) => option.id === currentId)) backdropSelect.value = currentId;
            hideEnvCheckbox.checked = hideEnvironment;
        }
        // 贴图：setBackdrop 内部按 nodeId|url 去重，重复调用很便宜
        const source = resolveBackdropSource(nodes, currentId);
        stage?.setBackdrop(source ? { nodeId: source.nodeId, url: source.url } : null);
        const missing = backdropUnavailable(nodes, currentId || undefined);
        backdropHint.textContent = !currentId
            ? options.length
                ? "选一张画布上的图设为背景板：人物/道具会合成在这张真画面里，导出（参考图 / 首尾帧 / 运镜视频）都吃它。"
                : "画布上还没有图片节点：先生成或导入一张环境图，再回来「设为背景板」。"
            : missing
              ? `⚠ 背景板引用的「${missing.title}」还没有画面（生成中或失败）—— 现在导出会是一张没有环境底图的画面。`
              : `背景板：「${state.backdrop?.title || currentId}」（这张图重新生成后会自动更新）${hideEnvironment ? "；环境类素材不渲染" : ""}`;
        applyBackdropButton.disabled = !options.length;
        clearBackdropButton.disabled = !currentId;
        backdropSelect.disabled = !options.length;
    };

    /** 重建「我的模板」下拉分组与编辑行。 */
    const refreshTemplateSelect = (selectId?: string) => {
        const keep = selectId ?? sceneSelect.value;
        myTemplatesGroup.label = `${USER_TEMPLATE_GROUP}（${userTemplates.length}）`;
        myTemplatesGroup.replaceChildren(...userTemplates.map((template) => h("option", { value: template.id, text: template.name })));
        if (userTemplates.some((template) => template.id === keep)) sceneSelect.value = keep;
        const current = userTemplates.find((template) => template.id === sceneSelect.value);
        templateEditRow.style.display = current ? "flex" : "none";
        if (current) templateNameEdit.value = current.name;
        render();
    };

    /** 把模板清单写进节点 metadata：Agent / 技能据此知道有哪些「我的模板」可按 id 套用。 */
    const syncTemplateRefs = () => {
        const next = templateRefs(userTemplates);
        if (JSON.stringify(ctx.node.metadata?.[STAGE_TEMPLATE_IDS_KEY] ?? null) === JSON.stringify(next)) return;
        ctx.updateMetadata({ [STAGE_TEMPLATE_IDS_KEY]: next } as never);
    };

    const importLibrary = async (file: File) => {
        setStatus(`正在导入素材库 ${file.name}…`);
        try {
            const result = await importStageLibrary(ctx.storage, JSON.parse(await file.text()));
            stageAssets = await listStageAssets(ctx.storage);
            refreshMyAssets();
            setStatus(`素材库导入完成：新增 ${result.added} 份，跳过 ${result.skipped} 份（已存在的不会覆盖）`);
        } catch (error) {
            setStatus(`素材库导入失败：${error instanceof Error ? error.message : String(error)}（确认是本插件导出的 JSON）`);
        }
    };

    rail.append(
        h("div", { style: SECTION_STYLE }, [
            h("div", { style: SECTION_TITLE_STYLE, text: "场景模板（一键搭好整套）" }),
            h("div", { style: ROW_STYLE }, [sceneSelect]),
            h("div", { style: ROW_STYLE }, [applySceneButton, saveTemplateButton]),
            h("div", { style: ROW_STYLE }, [templateNameInput]),
            templateEditRow,
            sceneHint,
            h("div", { style: ROW_STYLE }, [lightingSelect]),
            lightingHint,
        ]),
        h("div", { style: SECTION_STYLE }, [
            h("div", { style: SECTION_TITLE_STYLE, text: "素材（人物 / 家具 / 街道 / 户外 / 环境）" }),
            h("div", { style: ROW_STYLE }, [assetSelect]),
            h("div", { style: ROW_STYLE }, [addAssetButton, importLabel, exportLibraryButton, importLibraryLabel]),
            assetEditRow,
            assetHint,
            h("div", { style: ROW_STYLE }, [backdropSelect]),
            h("div", { style: ROW_STYLE }, [applyBackdropButton, clearBackdropButton, hideEnvLabel]),
            backdropHint,
            objectList,
            selectionForm,
        ]),
        h("div", { style: SECTION_STYLE }, [
            h("div", { style: SECTION_TITLE_STYLE, text: "机位（关键帧，第 1 个是首帧、最后一个是尾帧）" }),
            slider("camera", "方位角", { min: -180, max: 180, step: 1, suffix: "°", read: () => state.camera.azimuthDeg, write: (value) => apply({ ...state, camera: { ...state.camera, azimuthDeg: value } }) }),
            slider("camera", "焦距", { min: 14, max: 135, step: 1, suffix: "mm", read: () => state.camera.focalMm, write: (value) => apply({ ...state, camera: { ...state.camera, focalMm: value } }) }),
            slider("camera", "距离", { min: 1.5, max: 14, step: 0.1, suffix: "m", read: () => state.camera.distance, write: (value) => apply({ ...state, camera: { ...state.camera, distance: value } }) }),
            slider("camera", "仰角", { min: -20, max: 80, step: 1, suffix: "°", read: () => state.camera.elevationDeg, write: (value) => apply({ ...state, camera: { ...state.camera, elevationDeg: value } }) }),
            slider("camera", "视线高度", { min: 0.4, max: 2, step: 0.05, suffix: "m", read: () => state.camera.targetY, write: (value) => apply({ ...state, camera: { ...state.camera, targetY: value } }) }),
            h("div", { style: ROW_STYLE }, [recordShotButton, overviewButton]),
            shotList,
            shotHint,
        ]),
        h("div", { style: SECTION_STYLE }, [
            h("div", { style: SECTION_TITLE_STYLE, text: "运镜预演" }),
            h("div", { style: ROW_STYLE }, [durationSelect, fpsSelect, easingSelect]),
            h("div", { style: ROW_STYLE }, [playButton]),
            progressTrack,
            motionHint,
            h("div", { style: ROW_STYLE }, [exportVideoButton, downloadVideoButton, cancelVideoButton]),
            h("div", { style: HINT_STYLE, text: "导出：优先 mp4（WebCodecs 编码），浏览器不支持时自动降级 WebM" }),
            videoStatusEl,
        ]),
        h("div", { style: SECTION_STYLE }, [
            h("div", { style: SECTION_TITLE_STYLE, text: "导出" }),
            h("div", { style: ROW_STYLE }, [formatSelect, heightSelect, localeSelect]),
            ...(() => {
                const make = (label: string, action: () => Promise<string> | string, primary = false) => {
                    const button = h("button", { type: "button", style: primary ? PRIMARY_BUTTON_STYLE : BUTTON_STYLE, text: label, onclick: () => void run(action) }) as HTMLButtonElement;
                    outputButtons.push(button);
                    return button;
                };
                return [
                    make("导出当前机位 → 参考图", () => exportCurrentView(ctx, liveSession, state), true),
                    make("导出机位 A→B → 首尾帧", () => exportFirstLast(ctx, liveSession, state)),
                    make("导出多视图 → 参考图组", () => exportMultiView(ctx, liveSession, state)),
                    make("生成运镜提示词 → 文本节点", () => exportPrompt(ctx, state)),
                ];
            })(),
            statusEl,
        ]),
    );

    // 记 A/B：记忆的是当前机位（只读快照）
    playButton.addEventListener("click", () => (playing ? stopPlayback() : startPlayback()));
    durationSelect.addEventListener("change", () => apply({ ...state, motion: { ...state.motion, durationMs: Number(durationSelect.value) } }));
    fpsSelect.addEventListener("change", () => apply({ ...state, motion: { ...state.motion, fps: Number(fpsSelect.value) } }));
    easingSelect.addEventListener("change", () => apply({ ...state, motion: { ...state.motion, easing: easingSelect.value as StageMotionEasing } }));

    addAssetButton.addEventListener("click", () => {
        const libraryId = selectedLibraryId();
        if (libraryId) void addLibraryAsset(libraryId);
        else addBuiltinAsset(assetSelect.value);
    });
    assetSelect.addEventListener("change", () => {
        const current = stageAssets.find((asset) => asset.id === selectedLibraryId());
        assetEditRow.style.display = current ? "flex" : "none";
        if (current) assetNameEdit.value = current.name;
    });
    assetNameEdit.addEventListener("change", async () => {
        const id = selectedLibraryId();
        if (!id) return;
        stageAssets = await renameStageAsset(ctx.storage, id, assetNameEdit.value);
        refreshMyAssets();
        setStatus(`素材已改名为「${assetNameEdit.value.trim()}」`);
    });
    deleteAssetButton.addEventListener("click", async () => {
        const id = selectedLibraryId();
        const asset = stageAssets.find((item) => item.id === id);
        if (!asset) return;
        const used = countStageAssetUsage(id, ctx.getNodes());
        if (!window.confirm(used ? `「${asset.name}」还有 ${used} 个物体在用，删除后这些物体会加载失败。仍要删除？` : `从素材库删除「${asset.name}」？`)) return;
        stageAssets = await removeStageAsset(ctx.storage, id);
        refreshMyAssets();
        setStatus(`已从素材库删除「${asset.name}」${used ? `（场景里还有 ${used} 个物体在引用它）` : ""}`);
    });
    exportLibraryButton.addEventListener("click", async () => {
        const backup = await exportStageLibrary(ctx.storage);
        const blob = new Blob([JSON.stringify(backup)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = "director-stage-assets.json";
        link.click();
        URL.revokeObjectURL(url);
        setStatus(`已导出素材库：${backup.assets.length} 份`);
    });
    applyBackdropButton.addEventListener("click", () => {
        const node = ctx.getNodes().find((item) => item.id === backdropSelect.value);
        if (!node) return;
        const ready = Boolean(node.metadata?.content);
        apply({ ...state, backdrop: { nodeId: node.id, title: node.title || undefined, ...(hideEnvCheckbox.checked ? {} : { hideEnvironment: false }) } });
        setStatus(ready ? `已把「${node.title}」设为背景板：导出时人物就合成在这张画面里（它重新生成后会自动更新）` : `已把「${node.title}」设为背景板，但这张图还没有画面 —— 等它生成出来就会显示`);
    });
    clearBackdropButton.addEventListener("click", () => {
        apply({ ...state, backdrop: undefined });
        setStatus("已清除背景板，回到灯光背景色");
    });
    hideEnvCheckbox.addEventListener("change", () => {
        if (!state.backdrop?.nodeId) return;
        apply({ ...state, backdrop: { ...state.backdrop, hideEnvironment: hideEnvCheckbox.checked ? undefined : false } });
    });
    saveTemplateButton.addEventListener("click", () => void saveCurrentAsTemplate());
    templateNameEdit.addEventListener("change", async () => {
        const id = sceneSelect.value;
        if (!userTemplates.some((template) => template.id === id)) return;
        userTemplates = await renameUserTemplate(ctx.storage, id, templateNameEdit.value);
        syncTemplateRefs();
        refreshTemplateSelect(id);
        setStatus(`模板已改名为「${templateNameEdit.value.trim()}」`);
    });
    deleteTemplateButton.addEventListener("click", async () => {
        const id = sceneSelect.value;
        const template = userTemplates.find((item) => item.id === id);
        if (!template || !window.confirm(`删除「我的模板 · ${template.name}」？`)) return;
        userTemplates = await removeUserTemplate(ctx.storage, id);
        syncTemplateRefs();
        refreshTemplateSelect();
        setStatus(`已删除模板「${template.name}」`);
    });
    sceneSelect.addEventListener("change", () => {
        pendingSceneId = null;
        window.clearTimeout(pendingSceneTimer);
        const current = userTemplates.find((template) => template.id === sceneSelect.value);
        templateEditRow.style.display = current ? "flex" : "none";
        if (current) templateNameEdit.value = current.name;
        render();
    });
    applySceneButton.addEventListener("click", () => {
        const id = sceneSelect.value;
        if (pendingSceneId === id) {
            applyTemplate(id);
            return;
        }
        pendingSceneId = id;
        window.clearTimeout(pendingSceneTimer);
        pendingSceneTimer = window.setTimeout(() => {
            pendingSceneId = null;
            render();
        }, 5000);
        render();
    });
    lightingSelect.addEventListener("change", () => {
        const preset = lightingPresetById(lightingSelect.value as never);
        apply({ ...state, lighting: preset.id });
        setStatus(`灯光切到「${preset.name}」：${preset.description}`);
    });

    /**
     * 站到外面看全场（上帝视角）。布局、拖人物、拖相机都应该在这里做 ——
     * 选中一台相机时**不要**把视口切进那台相机，否则人会"钻进相机里"、看不到全场。
     */
    const enterOverview = () => {
        // 已经在外面就不重置视角，保留用户自己转到的角度看
        if (previewing) return;
        previewing = true;
        stage?.setPreviewCamera(overviewCamera(state));
        render();
    };

    /** 回到"自己的镜头"（当前机位的第一视角）。 */
    const leaveOverview = () => {
        if (!previewing) return;
        previewing = false;
        stage?.setPreviewCamera(null);
        render();
    };

    /** 主动动作：把当前镜头切到某台机位（点列表里的「切到」，不要在点相机元素时顺手做）。 */
    const switchToShot = (shotId: string) => {
        const shot = state.shots.find((item) => item.id === shotId);
        if (!shot) return;
        ctx.updateMetadata({ selectedShotId: shotId });
        stage?.setSelectedShot(shotId);
        leaveOverview();
        apply({ ...state, camera: { ...shot.camera } });
        setStatus(`已切到「${shot.name}」当镜头：方位 ${Math.round(shot.camera.azimuthDeg)}° · 仰角 ${Math.round(shot.camera.elevationDeg)}° · 距离 ${shot.camera.distance.toFixed(1)}m · 焦距 ${Math.round(shot.camera.focalMm)}mm —— 想一边看全场一边调它，点「看全场（自由视角）」。`);
    };

    overviewButton.addEventListener("click", () => {
        if (previewing) leaveOverview();
        else enterOverview();
    });

    recordShotButton.addEventListener("click", () => {
        if (state.shots.length >= STAGE_SHOT_LIMIT) return;
        const shot = createStageShot(state.camera, `机位 ${state.shots.length + 1}`);
        apply({ ...state, shots: [...state.shots, shot] });
        const camera = state.camera;
        setStatus(`已记录「${shot.name}」：方位 ${Math.round(camera.azimuthDeg)}° · 仰角 ${Math.round(camera.elevationDeg)}° · 距离 ${camera.distance.toFixed(1)}m · 焦距 ${Math.round(camera.focalMm)}mm —— 点上面的「看全场」能看到它摆在场景里的位置`);
    });

    // ---------- 生命周期 ----------
    const onKeyDown = (event: KeyboardEvent) => {
        // 大窗口内自己接管 Ctrl+Z / ⌘Z（模态带 data-canvas-shortcuts-ignore，画布的快捷键在这里是失效的）
        if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "z") {
            event.preventDefault();
            event.stopPropagation();
            undo();
            return;
        }
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        close();
    };

    const onStatus = (status: StageStatus) => {
        if (status.phase === "error") setStatus(`3D 引擎初始化失败：${status.message}`);
    };

    const webgl = detectWebgl();

    if (!webgl.ok) {
        // 不支持就别放一块黑屏：把原因、以及一个自检页面直接摆在脸上。
        const banner = h("div", { style: { position: "absolute", inset: "0", display: "grid", placeItems: "center", padding: "24px", background: "#1b1c1f" } }, [
            h("div", { style: { maxWidth: "560px", lineHeight: "1.9", color: "#fca5a5" } }, [
                h("div", { text: "这个浏览器/环境拿不到 WebGL 上下文，3D 视口没法渲染。" }),
                h("div", { style: HINT_STYLE, text: "three.js 必须有 WebGL。常见原因：浏览器禁用了硬件加速、跑在没有 GPU 的远程桌面/内嵌浏览器里。" }),
                ...(webgl.reason ? [h("div", { style: { ...HINT_STYLE, marginTop: "6px", wordBreak: "break-all" }, text: `浏览器原话：${webgl.reason}` })] : []),
                h("div", { style: { marginTop: "10px", display: "flex", gap: "8px", justifyContent: "center" } }, [
                    h("a", { href: "/webgl-check.html", target: "_blank", style: { ...BUTTON_STYLE, display: "inline-flex", alignItems: "center", textDecoration: "none" }, text: "打开 WebGL 自检页" }),
                    h("span", { style: HINT_STYLE, text: "（或地址栏输入 chrome://gpu 看 WebGL 状态）" }),
                ]),
            ]),
        ]);
        viewport.appendChild(banner);
        setStatus(`环境拿不到 WebGL${webgl.reason ? `：${webgl.reason}` : ""}`);
    }

    // 先建视口：three 是本插件打包进来的本地模块，正常情况立刻就绪。
    if (webgl.ok) {
        stage = createStage(
            stageHolder,
            state,
            (next) => {
                // 视口里拖出来的改动（拖人物/转视角）也进撤销栈
                pushUndo();
                state = next;
                persist();
                render();
            },
            onStatus,
            {
                // 点场景里的相机元素 = 选中它 + 站到外面看全场（**不钻进相机**：布局与调机位要上帝视角）。
                // 要把它当镜头，用列表里的「切到」——那是主动动作，不该在点选时顺手发生。
                onPickShot: (shotId) => {
                    const shot = state.shots.find((item) => item.id === shotId);
                    if (!shot) return;
                    ctx.updateMetadata({ selectedShotId: shotId });
                    stage?.setSelectedShot(shotId);
                    enterOverview();
                    setStatus(`已选中「${shot.name}」—— 现在从外面看全场：直接拖它改方位/距离，或拖人物调布局；想把它当镜头就点列表里的「切到」。`);
                },
                // 按住相机元素 = 选中它（机身/取景锥变蓝 + 列表行高亮 + 状态行说明）
                onShotPressed: (shotId) => {
                    const shot = state.shots.find((item) => item.id === shotId);
                    if (!shot) return;
                    ctx.updateMetadata({ selectedShotId: shotId });
                    stage?.setSelectedShot(shotId);
                    setStatus(`已选中「${shot.name}」—— 拖动它即可调整这台机位（松手即保存）`);
                },
                // 拖相机元素 = 直接调这台机位（地面上拖，自动换算方位角与距离）
                onBackdropError: (message) => setStatus(message),
                onMoveShot: (shotId, camera) => {
                    const shot = state.shots.find((item) => item.id === shotId);
                    if (!shot) return;
                    apply({ ...state, shots: state.shots.map((item) => (item.id === shotId ? { ...item, camera } : item)) });
                    setStatus(`正在调整「${shot.name}」：方位 ${Math.round(camera.azimuthDeg)}° · 距离 ${camera.distance.toFixed(1)}m（松手即保存）`);
                },
            },
        );
        stage.setInteractive(true);
    stage.setSelectedShot(typeof ctx.node.metadata?.selectedShotId === "string" ? (ctx.node.metadata.selectedShotId as string) : null);
        stage.setSelected(selectedId);
    }
    render();
    refreshButtons();

    /**
     * 把场景里带 modelKey 的物体从素材库装回（打开大窗口、套用带模型的模板之后都要跑）。
     * 同一个 modelKey 会命中 stage 里的解析缓存，只解析/上传一次。
     */
    async function restoreModels() {
        for (const object of state.objects) {
            if (object.kind !== "model" || !object.modelKey) continue;
            const stored = await readStageAsset(ctx.storage, object.modelKey);
            if (!stored) continue;
            const bytes = bytesFromBase64(stored.base64);
            void stage?.loadModel({ name: stored.name || object.name, arrayBuffer: async () => bytes.buffer }, { objectId: object.id, cacheKey: object.modelKey });
        }
    }

    // 打开时读一次「我的素材」与「我的模板」，并把模板清单同步给 Agent / 技能。
    // 如果用户在读盘期间就先导入/存过了，以内存里那份（更新的）为准，别被刚读到的旧值盖掉。
    void (async () => {
        if (!stageAssets.length) {
            stageAssets = await listStageAssets(ctx.storage);
            refreshMyAssets();
        }
        if (!userTemplates.length) {
            userTemplates = await listUserTemplates(ctx.storage);
            syncTemplateRefs();
            refreshTemplateSelect();
        }
    })();
    void restoreModels();

    function close() {
        if (closed) return;
        closed = true;
        if (playing) {
            playing = false;
            window.cancelAnimationFrame(playFrame);
        }
        // 正在编码就让它尽快停：编码循环每帧都会查这个标志
        videoCancelled = true;
        openEditors.delete(ctx.node.id);
        document.removeEventListener("keydown", onKeyDown, true);
        window.clearTimeout(persistTimer);
        // 顺手留一张小预览：卡片上就用它表示「当前机位」，省掉节点上的常驻 WebGL 上下文
        const preview = stage?.capture({ format: "jpeg", height: 360 });
        ctx.updateMetadata({ stageState: snapshot(), editorOpen: false, ...(preview ? { previewContent: preview.dataUrl } : {}) });
        stage?.dispose();
        stage = null;
        root.remove();
    }

    document.body.appendChild(root);
    // 场景里有人物走位却没人点播放时，先提醒一句（否则很容易以为只有镜头会动）
    if (state.objects.some((object) => hasMovement(object.track))) {
        setStatus("这个场景有人物走位：点「▶ 播放（人物走位 + 运镜）」看人物移动（导出视频里也会动）");
    }
    document.addEventListener("keydown", onKeyDown, true);
    openEditors.set(ctx.node.id, close);
    ctx.updateMetadata({ editorOpen: true });
    root.focus();
}
