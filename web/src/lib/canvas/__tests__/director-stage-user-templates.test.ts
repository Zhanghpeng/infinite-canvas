// 「我的模板」：把当前场景（含走位与导入模型）存成可复用模板，并保证套用时这些字段不丢。
import { describe, expect, it } from "vitest";

// eslint-disable-next-line import/first
import { TEMPLATE_STORE_KEY, findUserTemplate, listUserTemplates, removeUserTemplate, renameUserTemplate, saveUserTemplate, stageStateToTemplate, templateRefs } from "../../../../../plugins/canvas/director-stage/src/templates";
// eslint-disable-next-line import/first
import { applySceneToState, sceneById } from "../../../../../plugins/canvas/director-stage/src/scenes";
// eslint-disable-next-line import/first
import { createDefaultStageState, normalizeStageState } from "../../../../../plugins/canvas/director-stage/src/stage-state";

function memoryStorage(initial: Record<string, unknown> = {}) {
    const map = new Map(Object.entries(initial));
    return {
        map,
        get: async (key: string) => (map.has(key) ? map.get(key) : null),
        set: async (key: string, value: unknown) => {
            map.set(key, value);
        },
        remove: async (key: string) => {
            map.delete(key);
        },
    };
}

/** 一个"有内容"的场景：导入的模型 + 人物走位 + 两个机位。 */
function richState() {
    const base = createDefaultStageState();
    return normalizeStageState({
        ...base,
        objects: [
            { id: "o1", name: "女主", kind: "person", assetId: "person-woman", x: -1.2, z: 1.4, rotationYDeg: 200, scale: 1, visible: true },
            {
                id: "o2",
                name: "hero",
                kind: "model",
                modelKey: "m1",
                sourceName: "hero.glb",
                x: 2,
                z: -1,
                rotationYDeg: 30,
                scale: 1.2,
                visible: true,
                track: [
                    { x: 2, z: -1, rotationYDeg: 30, holdMs: 0 },
                    { x: 0, z: 0.5, rotationYDeg: 180, holdMs: 500 },
                ],
            },
        ],
        shots: [
            { id: "s1", name: "过肩", camera: { azimuthDeg: 20, elevationDeg: 12, distance: 4.2, targetY: 0.95, focalMm: 50 }, holdMs: 0 },
            { id: "s2", name: "反打", camera: { azimuthDeg: -160, elevationDeg: 8, distance: 3.4, targetY: 0.95, focalMm: 35 }, holdMs: 500 },
        ],
        lighting: "night",
    });
}

describe("我的模板", () => {
    it("当前场景 → 模板：走位、导入模型、素材 id 都在", () => {
        const template = stageStateToTemplate(richState(), "雨夜对峙", "mine-1");
        expect(template).toMatchObject({ id: "mine-1", name: "雨夜对峙", group: "我的模板", lighting: "night" });
        expect(template.objects[0]).toMatchObject({ assetId: "person-woman", kind: "person" });
        expect(template.objects[1]).toMatchObject({ kind: "model", modelKey: "m1", sourceName: "hero.glb", scale: 1.2 });
        expect(template.objects[1].track).toHaveLength(2);
        expect(template.shots.map((shot) => shot.name)).toEqual(["过肩", "反打"]);
        expect(template.description).toContain("2 个物体");
        expect(template.description).toContain("含人物走位");
        expect(template.description).toContain("含 1 个导入模型");
    });

    it("套用模板后走位与模型不丢（这是这次要修的老缺口）", () => {
        const template = stageStateToTemplate(richState(), "雨夜对峙", "mine-1");
        const next = normalizeStageState(applySceneToState(createDefaultStageState(), template));
        const model = next.objects.find((object) => object.kind === "model");
        expect(model).toMatchObject({ modelKey: "m1", sourceName: "hero.glb" });
        expect(model?.track).toHaveLength(2);
        expect(model?.track?.[1]).toMatchObject({ x: 0, z: 0.5, rotationYDeg: 180, holdMs: 500 });
        expect(next.shots).toHaveLength(2);
        expect(next.lighting).toBe("night");
        // 物体 id 必须是新的（否则套两次会撞 id）
        const again = normalizeStageState(applySceneToState(next, template));
        expect(again.objects[0].id).not.toBe(next.objects[0].id);
        // 内置模板照旧（只有 assetId，kind 按素材推出来）
        const builtinObjects = applySceneToState(createDefaultStageState(), sceneById("seaside-lookout")!).objects;
        expect(builtinObjects.filter((object) => object.kind === "person").length).toBeGreaterThan(0);
        expect(builtinObjects.every((object) => ["person", "prop", "env", "model"].includes(object.kind))).toBe(true);
    });

    it("存取/改名/删除；脏数据当空库", async () => {
        const storage = memoryStorage();
        expect(await listUserTemplates(storage as never)).toEqual([]);
        await saveUserTemplate(storage as never, stageStateToTemplate(richState(), "A", "mine-a"));
        await saveUserTemplate(storage as never, stageStateToTemplate(richState(), "B", "mine-b"));
        expect((await listUserTemplates(storage as never)).map((template) => template.name)).toEqual(["A", "B"]);
        expect((await findUserTemplate(storage as never, "mine-b"))?.name).toBe("B");
        expect(await findUserTemplate(storage as never, "nope")).toBeNull();

        // 同名 id 覆盖
        await saveUserTemplate(storage as never, stageStateToTemplate(richState(), "A2", "mine-a"));
        expect((await listUserTemplates(storage as never)).map((template) => template.name)).toEqual(["A2", "B"]);

        expect(templateRefs(await renameUserTemplate(storage as never, "mine-a", "  改名后  "))).toEqual([{ id: "mine-a", name: "改名后" }, { id: "mine-b", name: "B" }]);
        expect(await removeUserTemplate(storage as never, "mine-a")).toHaveLength(1);

        // 损坏的存储内容：过滤掉非法项，不抛错
        const broken = memoryStorage({ [TEMPLATE_STORE_KEY]: [{ id: "x" }, null, { id: "y", name: "y", objects: [], shots: [], camera: {}, motion: {} }] });
        expect((await listUserTemplates(broken as never)).map((template) => template.id)).toEqual(["y"]);
    });

    it("模板数量上限：超出后只保留最近的", async () => {
        const storage = memoryStorage();
        for (let index = 0; index < 22; index += 1) await saveUserTemplate(storage as never, stageStateToTemplate(richState(), `T${index}`, `mine-${index}`));
        const templates = await listUserTemplates(storage as never);
        expect(templates).toHaveLength(20);
        expect(templates.at(-1)?.name).toBe("T21");
    });

    it("相机是 NaN 的脏模板会被兜回默认值（不能漏进场景）", async () => {
        const bad = { id: "z", name: "坏模板", group: "我的模板", description: "", lighting: "night", objects: [{ name: "甲", x: "x", z: null }], camera: { azimuthDeg: "abc", distance: null }, shots: [{ name: "机位", camera: { focalMm: "x" } }], motion: { durationMs: "x" } };
        const storage = memoryStorage({ [TEMPLATE_STORE_KEY]: [bad] });
        const template = (await listUserTemplates(storage as never))[0];
        expect(Number.isFinite(template.camera.azimuthDeg)).toBe(true);
        expect(Number.isFinite(template.objects[0].x)).toBe(true);
        expect(Number.isFinite(template.shots[0].camera.focalMm)).toBe(true);
        expect(Number.isFinite(template.motion.durationMs)).toBe(true);
    });
});
