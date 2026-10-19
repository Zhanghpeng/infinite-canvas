// 场景模板是数据，这里钉住"模板本身能直接用"：素材都真实存在、机位/运镜参数在合法范围内、
// 套用后状态正确且不破坏用户的导出偏好。同时覆盖灯光预设。
import { describe, expect, it } from "vitest";

import { assetById, BUILTIN_ASSETS } from "../../../../../plugins/canvas/director-stage/src/library";
import { LIGHTING_PRESETS, lightingPresetById, lightPosition, normalizeLightingId } from "../../../../../plugins/canvas/director-stage/src/lighting";
import { applySceneToState, sceneById, sceneGroups, SCENE_TEMPLATES } from "../../../../../plugins/canvas/director-stage/src/scenes";
import { DEFAULT_CAMERA, DEFAULT_MOTION, normalizeStageState, type StageState } from "../../../../../plugins/canvas/director-stage/src/stage-state";

const stageState = (patch: Partial<StageState> = {}): StageState => ({
    objects: [],
    camera: { ...DEFAULT_CAMERA },
    shots: [],
    motion: { ...DEFAULT_MOTION },
    lighting: "day",
    exportFormat: "jpeg",
    exportHeight: 720,
    promptLocale: "zh",
    ...patch,
});

describe("场景模板数据", () => {
    it("id 唯一、分组齐全、每个模板都有描述与至少两个机位", () => {
        const ids = SCENE_TEMPLATES.map((template) => template.id);
        expect(new Set(ids).size).toBe(ids.length);
        expect(sceneGroups().flatMap((group) => group.scenes).length).toBe(SCENE_TEMPLATES.length);
        for (const template of SCENE_TEMPLATES) {
            expect(template.name.length).toBeGreaterThan(0);
            expect(template.description.length).toBeGreaterThan(10);
            expect(template.objects.length).toBeGreaterThanOrEqual(4);
            expect(template.shots.length).toBeGreaterThanOrEqual(2);
            expect(LIGHTING_PRESETS.map((preset) => preset.id)).toContain(template.lighting);
        }
        expect(sceneById("nope")).toBeUndefined();
    });

    it("模板引用的素材都存在，且都带环境", () => {
        for (const template of SCENE_TEMPLATES) {
            for (const item of template.objects) {
                expect(assetById(item.assetId), `${template.id} 引用了不存在的素材 ${item.assetId}`).toBeTruthy();
                expect(Math.abs(item.x)).toBeLessThanOrEqual(12);
                expect(Math.abs(item.z)).toBeLessThanOrEqual(12);
            }
            expect(template.objects.some((item) => assetById(item.assetId)?.kind === "env"), `${template.id} 没有环境`).toBe(true);
        }
    });

    it("机位与运镜参数都在合法范围内", () => {
        for (const template of SCENE_TEMPLATES) {
            for (const camera of [template.camera, ...template.shots.map((shot) => shot.camera)]) {
                expect(camera.distance).toBeGreaterThanOrEqual(0.8);
                expect(camera.distance).toBeLessThanOrEqual(30);
                expect(camera.focalMm).toBeGreaterThanOrEqual(8);
                expect(camera.focalMm).toBeLessThanOrEqual(300);
                expect(camera.elevationDeg).toBeGreaterThanOrEqual(-20);
                expect(camera.elevationDeg).toBeLessThanOrEqual(80);
                expect(camera.targetY).toBeGreaterThanOrEqual(0);
                expect(camera.targetY).toBeLessThanOrEqual(6);
            }
            expect(template.motion.durationMs).toBeGreaterThanOrEqual(400);
            expect(template.motion.durationMs).toBeLessThanOrEqual(20000);
            expect(template.motion.fps).toBeGreaterThanOrEqual(6);
            expect(template.motion.fps).toBeLessThanOrEqual(60);
        }
    });
});

describe("套用模板", () => {
    const template = sceneById("dialogue-over-shoulder")!;

    it("替换物体/机位/灯光，保留导出偏好，并给出全新的物体 id", () => {
        const before = stageState({ exportFormat: "png", exportHeight: 1080, promptLocale: "en", objects: [{ id: "old", name: "旧", kind: "person", visible: true, x: 0, z: 0, rotationYDeg: 0, scale: 1 }] });
        const after = applySceneToState(before, template);

        expect(after.objects.length).toBe(template.objects.length);
        expect(after.objects.some((object) => object.id === "old")).toBe(false);
        expect(new Set(after.objects.map((object) => object.id)).size).toBe(after.objects.length);
        expect(after.objects.every((object) => Boolean(object.assetId))).toBe(true);
        // 环境类物体 kind 归到 env，人物归到 person
        expect(after.objects.filter((object) => object.kind === "env").length).toBe(1);
        expect(after.objects.filter((object) => object.kind === "person").length).toBeGreaterThanOrEqual(2);

        expect(after.shots.map((shot) => shot.name)).toEqual(template.shots.map((shot) => shot.name));
        expect(after.camera).toEqual(template.camera);
        expect(after.lighting).toBe(template.lighting);
        // 导出设置与语言是用户偏好，不该被模板改掉
        expect(after).toMatchObject({ exportFormat: "png", exportHeight: 1080, promptLocale: "en" });
    });

    it("套用后的状态能被归一化原样读回", () => {
        const applied = applySceneToState(stageState(), template);
        const roundTrip = normalizeStageState(JSON.parse(JSON.stringify(applied)));
        expect(roundTrip.objects.length).toBe(applied.objects.length);
        expect(roundTrip.shots.length).toBe(applied.shots.length);
        expect(roundTrip.lighting).toBe(applied.lighting);
        expect(roundTrip.objects.map((object) => object.assetId)).toEqual(applied.objects.map((object) => object.assetId));
    });
});

describe("灯光预设", () => {
    it("四档齐全、id 唯一，未知值回落白天", () => {
        expect(LIGHTING_PRESETS.map((preset) => preset.id)).toEqual(["day", "night", "indoor", "backlit"]);
        expect(new Set(LIGHTING_PRESETS.map((preset) => preset.id)).size).toBe(4);
        expect(normalizeLightingId("night")).toBe("night");
        expect(normalizeLightingId("nope")).toBe("day");
        expect(normalizeLightingId(undefined)).toBe("day");
        expect(lightingPresetById("night").ambient.intensity).toBeLessThan(lightingPresetById("day").ambient.intensity);
    });

    it("灯的落点按方位角/高度角算（0° = +Z 方向）", () => {
        const [x0, y0, z0] = lightPosition({ azimuthDeg: 0, elevationDeg: 0, intensity: 1, color: "#fff" }, 10);
        expect(x0).toBeCloseTo(0, 6);
        expect(y0).toBeCloseTo(0, 6);
        expect(z0).toBeCloseTo(10, 6);
        const [x90] = lightPosition({ azimuthDeg: 90, elevationDeg: 0, intensity: 1, color: "#fff" }, 10);
        expect(x90).toBeCloseTo(10, 6);
        const [x, y] = lightPosition({ azimuthDeg: 0, elevationDeg: 90, intensity: 1, color: "#fff" }, 10);
        expect(x).toBeCloseTo(0, 6);
        expect(y).toBeCloseTo(10, 6);
    });
});
