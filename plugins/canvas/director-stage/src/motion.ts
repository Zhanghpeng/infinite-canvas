// 运镜预演：机位 A→B 的插值与缓动。
// 纯计算，不依赖 three / React，方便在 web 侧单测（和 prompt.ts 一样的定位）。
import type { StageCamera } from "./stage-state";

export type StageMotionEasing = "linear" | "easeInOut";

export type StageMotion = {
    /** 整段运镜时长（毫秒） */
    durationMs: number;
    /** 导出时的帧率；预演播放按屏幕刷新率走，只为将来的逐帧导出保留 */
    fps: number;
    easing: StageMotionEasing;
};

export const DEFAULT_MOTION: StageMotion = { durationMs: 3000, fps: 24, easing: "easeInOut" };
export const MOTION_DURATIONS = [1500, 2000, 3000, 5000, 8000];
export const MOTION_FPS = [12, 24, 30];

const MIN_DURATION = 400;
const MAX_DURATION = 20000;
const MIN_FPS = 6;
const MAX_FPS = 60;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** 缓入缓出（smoothstep 的常见等价写法），两端更"肉"，中间快。 */
export function easeInOut(t: number): number {
    const x = clamp(t, 0, 1);
    return x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2;
}

/** 反序列化：字段缺失/越界时回落到默认值（时长与帧率都会夹到合理区间）。 */
export function normalizeMotion(raw: unknown): StageMotion {
    const value = (raw && typeof raw === "object" ? raw : {}) as Partial<StageMotion>;
    const duration = Number(value.durationMs);
    const fps = Number(value.fps);
    return {
        durationMs: Number.isFinite(duration) ? clamp(Math.round(duration), MIN_DURATION, MAX_DURATION) : DEFAULT_MOTION.durationMs,
        fps: Number.isFinite(fps) ? clamp(Math.round(fps), MIN_FPS, MAX_FPS) : DEFAULT_MOTION.fps,
        easing: value.easing === "linear" ? "linear" : "easeInOut",
    };
}

/**
 * 机位插值：t=0 得到 A、t=1 得到 B。
 * 方位角走**最短弧**（normalizeAngle 到 (-180,180]），所以 A/B 相差 350° 只会转 10° ——
 * 想表达超过半圈的大环绕，得自己在中间多插一个机位，这一版不做。
 */
export function interpolateCamera(from: StageCamera, to: StageCamera, t: number): StageCamera {
    const ratio = clamp(t, 0, 1);
    const azimuthDelta = normalizeAngle(to.azimuthDeg - from.azimuthDeg);
    const mix = (start: number, end: number) => start + (end - start) * ratio;
    return {
        azimuthDeg: from.azimuthDeg + azimuthDelta * ratio,
        elevationDeg: mix(from.elevationDeg, to.elevationDeg),
        distance: mix(from.distance, to.distance),
        targetY: mix(from.targetY, to.targetY),
        focalMm: mix(from.focalMm, to.focalMm),
    };
}

/** 一个关键帧机位：摆好的一台机位 + 到位后停留多久。 */
export type StageShot = {
    id: string;
    name: string;
    camera: StageCamera;
    holdMs: number;
};

export const STAGE_SHOT_LIMIT = 8;

export function createStageShot(camera: StageCamera, name: string, holdMs = 0, id?: string): StageShot {
    return { id: id || `shot-${Math.random().toString(36).slice(2, 9)}`, name, camera: { ...camera }, holdMs };
}

export type MotionTimeline = { segments: number; holdsMs: number; travelMs: number; segmentMs: number; totalMs: number };

/** 物体走位的一个"点"：位置 + 朝向 + 到这个点之后停留多久。 */
export type StagePose = { x: number; z: number; rotationYDeg: number; holdMs: number };

export const STAGE_TRACK_LIMIT = 12;

/**
 * 通用时间轴：行程 = max(200ms, 时长 − Σ停留)，均分给各段。
 * 相机关键帧（shots）与物体走位（track）**共用它** —— 这是"人动 + 镜头动"能对齐的唯一保证。
 */
export function timelineFor(count: number, holdsMs: number, motion: StageMotion): MotionTimeline {
    const segments = Math.max(1, count - 1);
    const travelMs = Math.max(200, motion.durationMs - holdsMs);
    return { segments, holdsMs, travelMs, segmentMs: travelMs / segments, totalMs: holdsMs + travelMs };
}

/**
 * 运镜时间轴：`总时长 = ΣholdMs + travelMs`，`travelMs = max(200, durationMs − ΣholdMs)` 平均分给各段。
 * 停留时间优先于镜头运动 —— 用户说"停 1 秒再摇"时，运动时间就是被压缩的那部分。
 */
export function motionTimeline(shots: StageShot[], motion: StageMotion): MotionTimeline {
    return timelineFor(shots.length, shots.reduce((sum, shot) => sum + shot.holdMs, 0), motion);
}

/** 物体走位的时间轴（与相机同一套公式、同一个总时长）。 */
export function trackTimeline(track: StagePose[], motion: StageMotion): MotionTimeline {
    return timelineFor(track.length, track.reduce((sum, pose) => sum + pose.holdMs, 0), motion);
}

/** 这条走位是不是"真的会动"（≥2 个点且位置或朝向有变化）。 */
export function hasMovement(track: StagePose[] | undefined): boolean {
    if (!track || track.length < 2) return false;
    const first = track[0];
    return track.some((pose) => Math.abs(pose.x - first.x) > 1e-6 || Math.abs(pose.z - first.z) > 1e-6 || Math.abs(pose.rotationYDeg - first.rotationYDeg) > 1e-6);
}

/** 某时刻的走位；<2 个点时返回 null（静止，用物体自身的 x/z/朝向）。 */
export function poseAtTime(track: StagePose[], motion: StageMotion, elapsedMs: number): StagePose | null {
    if (track.length < 2) return null;
    const { segmentMs } = trackTimeline(track, motion);
    let time = Math.max(0, elapsedMs);
    for (let index = 0; index < track.length; index += 1) {
        const hold = track[index].holdMs;
        if (time <= hold) return { ...track[index] };
        time -= hold;
        if (index === track.length - 1) return { ...track[index] };
        if (time <= segmentMs) {
            const ratio = time / segmentMs;
            const from = track[index];
            const to = track[index + 1];
            return {
                x: from.x + (to.x - from.x) * ratio,
                z: from.z + (to.z - from.z) * ratio,
                // 朝向走最短弧，避免从 350° 转到 10° 时反向绕一圈
                rotationYDeg: from.rotationYDeg + normalizeAngle(to.rotationYDeg - from.rotationYDeg) * ratio,
                holdMs: 0,
            };
        }
        time -= segmentMs;
    }
    return { ...track[track.length - 1] };
}

const clampPose = (value: unknown, min: number, max: number, fallback: number) => {
    const num = Number(value);
    return Number.isFinite(num) ? Math.min(max, Math.max(min, num)) : fallback;
};

/** 走位点反序列化：非法项丢弃、数值夹取、朝向归一化；字段不存在时返回 null。 */
export function normalizeTrack(raw: unknown): StagePose[] | null {
    if (!Array.isArray(raw)) return null;
    const poses = raw
        .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
        .slice(0, STAGE_TRACK_LIMIT)
        .map((item) => ({
            x: clampPose(item.x, -12, 12, 0),
            z: clampPose(item.z, -12, 12, 0),
            rotationYDeg: Number.isFinite(Number(item.rotationYDeg)) ? normalizeAngle(Number(item.rotationYDeg)) : 0,
            holdMs: clampPose(item.holdMs, 0, 5000, 0),
        }));
    return poses.length ? poses : null;
}

/** 某时刻的机位；shots 为空时返回 null（调用方用当前机位兜底）。 */
export function cameraAtTime(shots: StageShot[], motion: StageMotion, elapsedMs: number): StageCamera | null {
    if (!shots.length) return null;
    if (shots.length === 1) return shots[0].camera;
    const { segmentMs } = motionTimeline(shots, motion);
    let time = Math.max(0, elapsedMs);
    for (let index = 0; index < shots.length; index += 1) {
        const hold = shots[index].holdMs;
        if (time <= hold) return shots[index].camera;
        time -= hold;
        if (index === shots.length - 1) return shots[index].camera;
        if (time <= segmentMs) return cameraAtProgress(shots[index].camera, shots[index + 1].camera, motion, time / segmentMs);
        time -= segmentMs;
    }
    return shots[shots.length - 1].camera;
}

/**
 * 各关键帧的"到达时间"（毫秒）：第 i 个点到达 → 停留 holds[i] → 走 segmentMs 到下一个点。
 * 相机与走位共用同一套算法，所以提示词里的时间段能直接对齐（"0.0→1.5s 甲走到桌前"）。
 */
export function marksFor(holds: number[], timeline: MotionTimeline): number[] {
    const arrivals: number[] = [];
    let time = 0;
    for (let index = 0; index < holds.length; index += 1) {
        arrivals.push(time);
        time += holds[index];
        if (index < holds.length - 1) time += timeline.segmentMs;
    }
    return arrivals;
}

/**
 * 把"相机眼睛在地面上的水平位置"换算回机位（方位角 + 距离），高度角/焦距/视线高度保持不变。
 * 拖相机元素调机位就用它 —— 与 prompt.ts 的 eyePosition 互逆。
 */
export function cameraFromEyeXZ(x: number, z: number, base: StageCamera): StageCamera {
    const horizontal = Math.hypot(x, z);
    const azimuthDeg = (Math.atan2(x, z) * 180) / Math.PI;
    const distance = horizontal / Math.max(0.2, Math.cos((base.elevationDeg * Math.PI) / 180));
    return { ...base, azimuthDeg, distance: Math.min(30, Math.max(0.8, distance)) };
}

/** 帧数：按时长 × 帧率，至少两帧。 */
export function frameCountFor(totalMs: number, fps: number): number {
    return Math.max(2, Math.round((totalMs / 1000) * fps));
}

/**
 * 整段拍摄的总时长：相机时间轴与各物体走位时间轴里最长的那个（不短于 motion.durationMs）。
 * 导出、首尾帧、进度条、播放都用它，保证"人动 + 镜头动"从同一起点走到同一终点。
 */
export function sceneEndMs(state: { shots: StageShot[]; objects: Array<{ track?: StagePose[] }>; motion: StageMotion }): number {
    const cameraTotal = state.shots.length >= 2 ? motionTimeline(state.shots, state.motion).totalMs : 0;
    const trackTotals = state.objects.map((object) => (object.track && hasMovement(object.track) ? trackTimeline(object.track, state.motion).totalMs : 0));
    return Math.max(state.motion.durationMs, cameraTotal, ...trackTotals);
}

/** 按时间轴总时长算实际帧数（有停留时时间轴比 motion.durationMs 长，用它更准）。 */
export function motionFrameCountFor(shots: StageShot[], motion: StageMotion): number {
    const totalMs = shots.length ? motionTimeline(shots, motion).totalMs : motion.durationMs;
    return frameCountFor(totalMs, motion.fps);
}

/** 预演/导出时的实际帧数（只用于进度与将来的逐帧导出）。 */
export function motionFrameCount(motion: StageMotion): number {
    return Math.max(2, Math.round((motion.durationMs / 1000) * motion.fps));
}

/** 按当前进度算相机（把 easing 也包进来，播放与导出共用同一条曲线）。 */
export function cameraAtProgress(from: StageCamera, to: StageCamera, motion: StageMotion, progress: number): StageCamera {
    const ratio = clamp(progress, 0, 1);
    return interpolateCamera(from, to, motion.easing === "linear" ? ratio : easeInOut(ratio));
}

function normalizeAngle(value: number): number {
    let angle = value % 360;
    if (angle > 180) angle -= 360;
    if (angle < -180) angle += 360;
    return angle;
}
