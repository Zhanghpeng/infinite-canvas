// 导演台的纯数据层：状态类型、默认值、序列化与归一化。
// 刻意不依赖 three / React / SDK，方便在 web 侧单测。

import { normalizeLightingId } from "./lighting";
import { createStageShot, DEFAULT_MOTION, normalizeMotion, normalizeTrack, STAGE_SHOT_LIMIT, type StageMotion, type StagePose, type StageShot } from "./motion";

export type StageObjectKind = "person" | "prop" | "model" | "env";

/** 摄影灯光预设（见 lighting.ts） */
export type StageLightingId = "day" | "night" | "indoor" | "backlit";

export type StageObject = {
    id: string;
    name: string;
    kind: StageObjectKind;
    /** 内置素材库里的素材 id（见 library.ts）；有它时按素材建 mesh */
    assetId?: string;
    /** 走位点（见 motion.ts）：≥2 个点就会按时间轴动起来；与相机关键帧共用同一条时间轴 */
    track?: StagePose[];
    /** 自定义模型的本地文件名（kind=model 时用于提示） */
    sourceName?: string;
    /** 插件私有存储里这份 glb 的键（kind=model 时用于刷新后重新装回场景） */
    modelKey?: string;
    visible: boolean;
    /** 地面坐标（米），y 恒为 0：人物脚底/道具底部贴地 */
    x: number;
    z: number;
    /** 朝向：绕 Y 轴角度（度），0 = 面向 +Z */
    rotationYDeg: number;
    scale: number;
};

/**
 * 背景板：把某张已生成的环境图当作场景背景，人和道具就合成在真画面里。
 * 只记节点 id（不拷字节）—— 那张图重新生成后背景板自动更新。
 */
export type StageBackdrop = {
    nodeId: string;
    /** 记下当时的标题，只为 UI 显示与排查；真实来源始终是 nodeId */
    title?: string;
    /** 背景板打开时环境类素材不再渲染（它们只是占位，真环境就是这张图）。默认 true */
    hideEnvironment?: boolean;
};

export type StageCamera = {
    /** 环绕角（度）：0 = 从 +Z 望向原点 */
    azimuthDeg: number;
    /** 仰角（度）：越大越俯视 */
    elevationDeg: number;
    /** 相机到目标的距离（米） */
    distance: number;
    /** 视线目标高度（米）：默认胸口高度 */
    targetY: number;
    /** 等效焦距（毫米，全画幅 24mm 传感器高） */
    focalMm: number;
};

export type StageState = {
    objects: StageObject[];
    camera: StageCamera;
    /** 可选：画布图片节点当背景板（见 backdrop.ts） */
    backdrop?: StageBackdrop;
    /** 关键帧机位序列（≥2 个才有运镜）；旧的 cameraA/cameraB 读入时会迁移到这里 */
    shots: StageShot[];
    /** 运镜时长/帧率/缓动（见 motion.ts） */
    motion: StageMotion;
    /** 灯光预设（见 lighting.ts） */
    lighting: StageLightingId;
    /** 导出用：JPEG 更适合参考图，PNG 用于关键帧 */
    exportFormat: "jpeg" | "png";
    exportHeight: 720 | 1080;
    promptLocale: "zh" | "en";
};

export const DEFAULT_CAMERA: StageCamera = { azimuthDeg: 35, elevationDeg: 14, distance: 5.2, targetY: 0.95, focalMm: 35 };

export { createStageShot, DEFAULT_MOTION, normalizeMotion } from "./motion";
export type { StageMotion, StageMotionEasing, StageShot } from "./motion";

export const HUMAN_HEIGHT_M = 1.75;
export const PERSON_RADIUS_M = 0.28;
export const PROP_SIZE_M = 0.6;

export function createStageObject(kind: StageObjectKind, name: string, x = 0, z = 0, id = `obj-${Math.random().toString(36).slice(2, 9)}`): StageObject {
    return { id, name, kind, visible: true, x, z, rotationYDeg: 0, scale: 1 };
}

export function createDefaultStageState(): StageState {
    return {
        // 先放一个人物当主体，加第二个人就能构成"关系"
        objects: [createStageObject("person", "人物 1", 0, 0)],
        camera: { ...DEFAULT_CAMERA },
        shots: [],
        motion: { ...DEFAULT_MOTION },
        lighting: "day",
        exportFormat: "jpeg",
        exportHeight: 720,
        promptLocale: "zh",
    };
}

/** 反序列化存储内容：字段缺失/类型不对时回落到默认值，避免坏数据把节点打崩。 */
export function normalizeStageState(raw: unknown): StageState {
    const fallback = createDefaultStageState();
    if (!raw || typeof raw !== "object") return fallback;
    const value = raw as Partial<StageState>;
    const rawObjects: unknown[] | null = Array.isArray(value.objects) ? (value.objects as unknown[]) : null;
    const objects: StageObject[] = rawObjects
        ? rawObjects
              .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
              .map((item, index) => ({
                  // 缺 id 就补一个，而不是把这条丢掉：外部（脚本 / Agent / 手写 metadata）少写字段时
                  // 之前会把整条物体清掉、节点看起来"空了"（真实踩过）。
                  ...createStageObject(
                      item.kind === "prop" || item.kind === "model" || item.kind === "env" ? item.kind : "person",
                      String(item.name || "未命名"),
                      Number(item.x) || 0,
                      Number(item.z) || 0,
                      typeof item.id === "string" && item.id ? item.id : `obj-recovered-${index}-${Date.now().toString(36)}`,
                  ),
                  assetId: typeof item.assetId === "string" ? item.assetId : undefined,
                  track: normalizeTrack(item.track) ?? undefined,
                  visible: item.visible !== false,
                  rotationYDeg: Number(item.rotationYDeg) || 0,
                  scale: Number(item.scale) || 1,
                  sourceName: typeof item.sourceName === "string" ? item.sourceName : undefined,
                  modelKey: typeof item.modelKey === "string" ? item.modelKey : undefined,
              }))
        : fallback.objects;

    return {
        objects,
        backdrop: normalizeBackdrop(value.backdrop),
        camera: { ...DEFAULT_CAMERA, ...(value.camera || {}) },
        shots: normalizeShots(value.shots) || legacyShots(raw),
        motion: normalizeMotion(value.motion),
        lighting: normalizeLightingId(value.lighting),
        exportFormat: value.exportFormat === "png" ? "png" : "jpeg",
        exportHeight: value.exportHeight === 1080 ? 1080 : 720,
        promptLocale: value.promptLocale === "en" ? "en" : "zh",
    };
}

/** 背景板：nodeId 非空才算有；hideEnvironment 默认 true；非法一律当作没有背景板。 */
export function normalizeBackdrop(raw: unknown): StageBackdrop | undefined {
    if (!raw || typeof raw !== "object") return undefined;
    const value = raw as Record<string, unknown>;
    const nodeId = typeof value.nodeId === "string" ? value.nodeId.trim() : "";
    if (!nodeId) return undefined;
    return {
        nodeId,
        ...(typeof value.title === "string" && value.title ? { title: value.title } : {}),
        ...(value.hideEnvironment === false ? { hideEnvironment: false } : {}),
    };
}

const clampHold = (value: unknown) => {
    const num = Number(value);
    return Number.isFinite(num) ? Math.min(5000, Math.max(0, Math.round(num))) : 0;
};

/** 机位序列：非法项直接丢弃，缺 id/名字补齐；返回 null 表示"没有这个字段"。 */
function normalizeShots(raw: unknown): StageShot[] | null {
    if (!Array.isArray(raw)) return null;
    return raw
        .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
        .slice(0, STAGE_SHOT_LIMIT)
        .map((item, index) => createStageShot({ ...DEFAULT_CAMERA, ...((item.camera as Partial<StageCamera>) || {}) }, typeof item.name === "string" && item.name ? item.name : `机位 ${index + 1}`, clampHold(item.holdMs), typeof item.id === "string" && item.id ? item.id : undefined));
}

/** 老数据兼容：只有 cameraA/cameraB 时迁移成机位序列。 */
function legacyShots(raw: unknown): StageShot[] {
    const value = (raw && typeof raw === "object" ? raw : {}) as { cameraA?: unknown; cameraB?: unknown };
    const shots: StageShot[] = [];
    if (value.cameraA && typeof value.cameraA === "object") shots.push(createStageShot({ ...DEFAULT_CAMERA, ...(value.cameraA as Partial<StageCamera>) }, "机位 1"));
    if (value.cameraB && typeof value.cameraB === "object") shots.push(createStageShot({ ...DEFAULT_CAMERA, ...(value.cameraB as Partial<StageCamera>) }, shots.length ? "机位 2" : "机位 1"));
    return shots;
}

/** 节点 metadata 上只留轻量摘要，画布每次变更都会带上它，不能塞大对象。 */
export function stageStateSummary(state: StageState) {
    return { objects: state.objects.length, focalMm: Math.round(state.camera.focalMm), shots: state.shots.length, hasMove: state.shots.length >= 2 };
}
