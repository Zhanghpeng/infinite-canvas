// 运镜预演的纯计算单测：插值端点、方位角最短弧、缓动曲线、时长/帧率归一化。
import { describe, expect, it } from "vitest";

import { cameraAtProgress, cameraAtTime, cameraFromEyeXZ, createStageShot, DEFAULT_MOTION, easeInOut, frameCountFor, hasMovement, interpolateCamera, motionFrameCount, motionFrameCountFor, motionTimeline, normalizeMotion, normalizeTrack, poseAtTime, sceneEndMs, trackTimeline } from "../../../../../plugins/canvas/director-stage/src/motion";
import { formatBytes, MAX_MOTION_FRAMES, motionVideoBitrate, motionVideoSize } from "../../../../../plugins/canvas/director-stage/src/video";
import { eyePosition, focalToFov } from "../../../../../plugins/canvas/director-stage/src/prompt";
import { DEFAULT_CAMERA, normalizeStageState, type StageCamera } from "../../../../../plugins/canvas/director-stage/src/stage-state";

const camera = (patch: Partial<StageCamera> = {}): StageCamera => ({ ...DEFAULT_CAMERA, ...patch });

describe("机位插值", () => {
    it("t=0 / t=1 精确落在 A / B 上", () => {
        const from = camera({ azimuthDeg: 0, elevationDeg: 10, distance: 5, targetY: 1, focalMm: 35 });
        const to = camera({ azimuthDeg: 90, elevationDeg: 40, distance: 2, targetY: 1.5, focalMm: 85 });
        expect(interpolateCamera(from, to, 0)).toEqual(from);
        expect(interpolateCamera(from, to, 1)).toEqual(to);
        expect(interpolateCamera(from, to, 0.5)).toEqual({
            azimuthDeg: 45,
            elevationDeg: 25,
            distance: 3.5,
            targetY: 1.25,
            focalMm: 60,
        });
    });

    it("方位角走最短弧：350° → 10° 只转 20°，不会绕 340°", () => {
        const mid = interpolateCamera(camera({ azimuthDeg: 350 }), camera({ azimuthDeg: 10 }), 0.5);
        expect(mid.azimuthDeg).toBe(360);
        // 函数不做 360 归一化（保证播放连续），370° 与 10° 等价
        expect(interpolateCamera(camera({ azimuthDeg: 350 }), camera({ azimuthDeg: 10 }), 1).azimuthDeg).toBe(370);
    });

    it("进度越界会被夹住", () => {
        const from = camera({ distance: 5 });
        const to = camera({ distance: 2 });
        expect(interpolateCamera(from, to, -3).distance).toBe(5);
        expect(interpolateCamera(from, to, 9).distance).toBe(2);
    });
});

describe("缓动", () => {
    it("easeInOut 端点与中点为定值，且单调不减", () => {
        expect(easeInOut(0)).toBe(0);
        expect(easeInOut(0.5)).toBe(0.5);
        expect(easeInOut(1)).toBe(1);
        let previous = -1;
        for (let step = 0; step <= 20; step += 1) {
            const value = easeInOut(step / 20);
            expect(value).toBeGreaterThanOrEqual(previous);
            previous = value;
        }
    });

    it("缓入缓出比匀速在开头更慢（同进度下走得更少）", () => {
        const from = camera({ distance: 5 });
        const to = camera({ distance: 1 });
        const eased = cameraAtProgress(from, to, { ...DEFAULT_MOTION, easing: "easeInOut" }, 0.25);
        const linear = cameraAtProgress(from, to, { ...DEFAULT_MOTION, easing: "linear" }, 0.25);
        expect(eased.distance).toBeGreaterThan(linear.distance);
        expect(linear.distance).toBe(4);
        // 两个曲线在终点必须汇合
        expect(cameraAtProgress(from, to, { ...DEFAULT_MOTION, easing: "easeInOut" }, 1).distance).toBe(1);
    });
});

describe("运镜参数归一化", () => {
    it("坏数据回落默认值，越界值被夹住", () => {
        expect(normalizeMotion(null)).toEqual(DEFAULT_MOTION);
        expect(normalizeMotion({ durationMs: "abc" })).toEqual(DEFAULT_MOTION);
        expect(normalizeMotion({ durationMs: 1, fps: 999, easing: "weird" })).toEqual({ durationMs: 400, fps: 60, easing: "easeInOut" });
        expect(normalizeMotion({ durationMs: 3000, fps: 24, easing: "linear" })).toEqual({ durationMs: 3000, fps: 24, easing: "linear" });
    });

    it("整份状态反序列化时保留 motion", () => {
        const state = normalizeStageState({ objects: [{ id: "a" }], motion: { durationMs: 5000, fps: 30, easing: "linear" } });
        expect(state.motion).toEqual({ durationMs: 5000, fps: 30, easing: "linear" });
    });

    it("帧数按时长×帧率算，至少两帧", () => {
        expect(motionFrameCount({ durationMs: 3000, fps: 24, easing: "easeInOut" })).toBe(72);
        expect(motionFrameCount({ durationMs: 500, fps: 12, easing: "linear" })).toBe(6);
    });
});

describe("视频导出参数", () => {
    it("分辨率固定 16:9，码率随分辨率/帧率缩放", () => {
        expect(motionVideoSize(720)).toEqual({ width: 1280, height: 720 });
        expect(motionVideoSize(1080)).toEqual({ width: 1920, height: 1080 });
        expect(motionVideoBitrate(1280, 720, 24)).toBe(Math.round(1280 * 720 * 24 * 0.07));
        expect(motionVideoBitrate(1280, 720, 30)).toBeGreaterThan(motionVideoBitrate(1280, 720, 12));
    });

    it("体积格式化", () => {
        expect(formatBytes(512)).toBe("512B");
        expect(formatBytes(2048)).toBe("2KB");
        expect(formatBytes(3 * 1024 * 1024)).toBe("3.0MB");
    });

    it("帧数上限取得到边界值：8s@30fps 正好是上限", () => {
        expect(motionFrameCount({ durationMs: 8000, fps: 30, easing: "linear" })).toBe(MAX_MOTION_FRAMES);
    });
});

describe("关键帧时间轴", () => {
    const shot = (distance: number, name: string, holdMs = 0) => createStageShot(camera({ distance }), name, holdMs);

    it("总时长 = 停留 + 行程，行程平均分给各段", () => {
        const shots = [shot(6, "机位 1", 500), shot(4, "机位 2", 500), shot(2, "机位 3", 0)];
        const timeline = motionTimeline(shots, { durationMs: 4000, fps: 24, easing: "easeInOut" });
        expect(timeline.segments).toBe(2);
        expect(timeline.holdsMs).toBe(1000);
        expect(timeline.travelMs).toBe(3000);
        expect(timeline.segmentMs).toBe(1500);
        expect(timeline.totalMs).toBe(4000);
    });

    it("停留时间超过总时长时，行程至少保留 200ms", () => {
        const shots = [shot(6, "机位 1", 3000), shot(2, "机位 2", 3000)];
        const timeline = motionTimeline(shots, { durationMs: 1000, fps: 24, easing: "linear" });
        expect(timeline.travelMs).toBe(200);
        expect(timeline.totalMs).toBe(6200);
    });

    it("按时间取机位：停留段停在原机位，行程段按缓动插值，超时停在最后一个机位", () => {
        const shots = [shot(6, "机位 1", 1000), shot(2, "机位 2", 0)];
        const motion = { durationMs: 3000, fps: 24, easing: "linear" as const };
        // 0~1000ms 停在第一个机位
        expect(cameraAtTime(shots, motion, 0)?.distance).toBe(6);
        expect(cameraAtTime(shots, motion, 1000)?.distance).toBe(6);
        // 1000~3000ms 从 6 推到 2
        expect(cameraAtTime(shots, motion, 2000)?.distance).toBe(4);
        expect(cameraAtTime(shots, motion, 3000)?.distance).toBe(2);
        // 超出总时长 → 停在最后一个机位
        expect(cameraAtTime(shots, motion, 99999)?.distance).toBe(2);
    });

    it("三个机位：中段停留在第二个机位", () => {
        const shots = [shot(6, "机位 1", 0), shot(4, "机位 2", 1000), shot(2, "机位 3", 0)];
        const motion = { durationMs: 4000, fps: 24, easing: "linear" as const };
        // 段长 = (4000-1000)/2 = 1500：0~1500 推到 4，1500~2500 停，2500~4000 推到 2
        expect(cameraAtTime(shots, motion, 1500)?.distance).toBe(4);
        expect(cameraAtTime(shots, motion, 2000)?.distance).toBe(4);
        expect(cameraAtTime(shots, motion, 3250)?.distance).toBeCloseTo(3, 5);
        expect(cameraAtTime(shots, motion, 4000)?.distance).toBe(2);
    });

    it("没有机位返回 null，单个机位就是固定机位", () => {
        expect(cameraAtTime([], DEFAULT_MOTION, 100)).toBeNull();
        const single = [shot(5.2, "机位 1")];
        expect(cameraAtTime(single, DEFAULT_MOTION, 0)?.distance).toBe(5.2);
        expect(cameraAtTime(single, DEFAULT_MOTION, 9999)?.distance).toBe(5.2);
    });

    it("帧数按时间轴算：有停留时比按 durationMs 算得多", () => {
        const shots = [shot(6, "机位 1", 3000), shot(2, "机位 2", 3000)];
        const motion = { durationMs: 1000, fps: 24, easing: "linear" as const };
        expect(motionFrameCount(motion)).toBe(24);
        expect(motionFrameCountFor(shots, motion)).toBe(Math.round((6200 / 1000) * 24));
    });
});

describe("机位序列归一化", () => {
    it("旧的 cameraA / cameraB 迁移成机位序列", () => {
        const state = normalizeStageState({ objects: [{ id: "x" }], cameraA: { distance: 6 }, cameraB: { distance: 3 } });
        expect(state.shots.map((item) => item.camera.distance)).toEqual([6, 3]);
        expect(state.shots.map((item) => item.name)).toEqual(["机位 1", "机位 2"]);
    });

    it("已有 shots 时忽略旧字段，非法项被丢弃、缺字段补齐", () => {
        const state = normalizeStageState({
            objects: [{ id: "x" }],
            cameraA: { distance: 9 },
            shots: [{ camera: { distance: 4, focalMm: 85 }, name: "过肩", holdMs: 700 }, "garbage", { holdMs: 99999 }],
        });
        expect(state.shots).toHaveLength(2);
        expect(state.shots[0]).toMatchObject({ name: "过肩", holdMs: 700 });
        expect(state.shots[0].camera).toMatchObject({ distance: 4, focalMm: 85 });
        expect(state.shots[1].name).toBe("机位 2");
        expect(state.shots[1].holdMs).toBe(5000);
        expect(state.shots[1].camera.distance).toBe(DEFAULT_CAMERA.distance);
    });
});

describe("物体走位（blocking）", () => {
    const pose = (x: number, z: number, rotationYDeg = 0, holdMs = 0) => ({ x, z, rotationYDeg, holdMs });
    const motion = { durationMs: 3000, fps: 24, easing: "linear" as const };

    it("与相机共用同一套时间轴：同样的点数列出同样的总时长", () => {
        const shots = [createStageShot(camera({ distance: 5 }), "机位 1", 500), createStageShot(camera({ distance: 3 }), "机位 2", 0)];
        const track = [pose(0, 0, 0, 500), pose(4, 0)];
        expect(trackTimeline(track, motion).totalMs).toBe(motionTimeline(shots, motion).totalMs);
        expect(trackTimeline(track, motion).holdsMs).toBe(500);
    });

    it("poseAtTime：端点精确、停留期间停住、位置线性插值、朝向走最短弧", () => {
        const track = [pose(0, 0, 350, 0), pose(4, 2, 10)];
        expect(poseAtTime(track, motion, 0)).toMatchObject({ x: 0, z: 0, rotationYDeg: 350 });
        // 与相机插值一致：函数不做 360 归一化（保证连续），370° 等价于 10°
        expect(poseAtTime(track, motion, 3000)).toMatchObject({ x: 4, z: 2, rotationYDeg: 370 });
        const middle = poseAtTime(track, motion, 1500)!;
        expect(middle.x).toBeCloseTo(2, 6);
        expect(middle.z).toBeCloseTo(1, 6);
        // 350° → 10° 走最短弧（+20°），中点应是 360° 而不是 180°
        expect(middle.rotationYDeg).toBeCloseTo(360, 6);

        const withHold = [pose(0, 0, 0, 1000), pose(4, 0)];
        expect(poseAtTime(withHold, motion, 1000)).toMatchObject({ x: 0 });
        expect(poseAtTime(withHold, motion, 2000)!.x).toBeCloseTo(2, 6);
        expect(poseAtTime(withHold, motion, 99999)).toMatchObject({ x: 4 });
    });

    it("少于两个点不动；方向没变也算不动", () => {
        expect(poseAtTime([], motion, 100)).toBeNull();
        expect(poseAtTime([pose(1, 1)], motion, 100)).toBeNull();
        expect(hasMovement([pose(1, 1), pose(1, 1), pose(1, 1)])).toBe(false);
        expect(hasMovement([pose(1, 1), pose(1, 1, 90)])).toBe(true);
        expect(hasMovement([pose(1, 1), pose(2, 1)])).toBe(true);
        expect(hasMovement(undefined)).toBe(false);
    });

    it("归一化：非法项丢弃、数值夹取、朝向归一化", () => {
        expect(normalizeTrack(undefined)).toBeNull();
        expect(normalizeTrack([])).toBeNull();
        const track = normalizeTrack([{ x: 99, z: "2", rotationYDeg: 200, holdMs: 9999 }, "garbage", { x: 1 }])!;
        expect(track).toHaveLength(2);
        expect(track[0]).toEqual({ x: 12, z: 2, rotationYDeg: -160, holdMs: 5000 });
        expect(track[1]).toEqual({ x: 1, z: 0, rotationYDeg: 0, holdMs: 0 });
    });

    it("sceneEndMs 取相机与各走位里最长的那个（不短于设定时长）", () => {
        const shots = [createStageShot(camera({ distance: 5 }), "机位 1"), createStageShot(camera({ distance: 3 }), "机位 2")];
        expect(sceneEndMs({ shots, objects: [], motion })).toBe(3000);
        // 走位停留 3000+3000 已超过设定时长 → 行程被夹到下限 200ms，整段 = 6200ms（比相机的 3000 长）
        expect(sceneEndMs({ shots, objects: [{ track: [pose(0, 0, 0, 3000), pose(4, 0, 0, 3000)] }], motion })).toBe(6200);
        expect(frameCountFor(6200, 24)).toBe(149);
    });
});

describe("拖相机元素调机位（眼睛位置 → 方位角/距离）", () => {
    it("水平位置换算：+Z 方向是 0°、+X 方向是 90°，距离按高度角还原", () => {
        const flat = camera({ elevationDeg: 0 });
        expect(cameraFromEyeXZ(0, 5, flat)).toMatchObject({ azimuthDeg: 0, distance: 5 });
        expect(cameraFromEyeXZ(5, 0, flat).azimuthDeg).toBeCloseTo(90, 6);
        // 仰角 60° 时水平半径只有距离的一半，换算要还原成 5m
        const tilted = camera({ elevationDeg: 60 });
        expect(cameraFromEyeXZ(0, 2.5, tilted).distance).toBeCloseTo(5, 6);
    });

    it("与 eyePosition 互逆（换成机位再算眼睛位置应回到原处）", () => {
        const base = camera({ azimuthDeg: 35, elevationDeg: 14, distance: 5.2, targetY: 0.95, focalMm: 35 });
        const eye = eyePosition(base);
        const round = cameraFromEyeXZ(eye.x, eye.z, base);
        expect(round.azimuthDeg).toBeCloseTo(base.azimuthDeg, 6);
        expect(round.distance).toBeCloseTo(base.distance, 6);
        // 其他参数不动
        expect(round).toMatchObject({ elevationDeg: base.elevationDeg, targetY: base.targetY, focalMm: base.focalMm });
    });

    it("距离夹在 0.8~30m，拖到极远处也不会爆", () => {
        const base = camera({ elevationDeg: 0 });
        expect(cameraFromEyeXZ(0, 999, base).distance).toBe(30);
        expect(cameraFromEyeXZ(0, 0, base).distance).toBe(0.8);
    });
});
