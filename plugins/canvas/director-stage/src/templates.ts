// 「我的模板」：把当前场景（含人物走位、导入的模型）存成可复用的模板。
//
// 与内置场景模板共用同一个形状（SceneTemplate），所以套用走的是同一套 applySceneToState +
// normalizeStageState，不需要第二套逻辑；Agent 的 applyScene 指令也能按 id 套用用户模板。
import type { PluginStorage } from "@infinite-canvas/plugin-sdk";

import { lightingPresetById, normalizeLightingId } from "./lighting";
import { hasMovement, normalizeMotion, STAGE_SHOT_LIMIT } from "./motion";
import type { SceneTemplate, SceneTemplateObject } from "./scenes";
import { DEFAULT_CAMERA, type StageCamera, type StageState } from "./stage-state";

export const TEMPLATE_STORE_KEY = "director-stage:templates:v1";
export const STAGE_TEMPLATE_LIMIT = 20;
export const USER_TEMPLATE_GROUP = "我的模板";

/** Agent / 技能要按 id 套用用户模板，所以节点 metadata 里留一份只读清单。 */
export type StageTemplateRef = { id: string; name: string };
export const STAGE_TEMPLATE_IDS_KEY = "stageTemplateIds";

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object");
const num = (value: unknown, fallback: number) => (Number.isFinite(Number(value)) ? Number(value) : fallback);

/** 相机必须逐项校验：normalizeStageState 对 camera 是直接展开合并，NaN 会漏进去。 */
function sanitizeCamera(raw: unknown): StageCamera {
    const camera = isRecord(raw) ? raw : {};
    return {
        azimuthDeg: num(camera.azimuthDeg, DEFAULT_CAMERA.azimuthDeg),
        elevationDeg: num(camera.elevationDeg, DEFAULT_CAMERA.elevationDeg),
        distance: num(camera.distance, DEFAULT_CAMERA.distance),
        targetY: num(camera.targetY, DEFAULT_CAMERA.targetY),
        focalMm: num(camera.focalMm, DEFAULT_CAMERA.focalMm),
    };
}

function isTemplate(value: unknown): value is SceneTemplate {
    const template = value as Partial<SceneTemplate> | null;
    return Boolean(isRecord(template) && typeof template.id === "string" && template.id && typeof template.name === "string" && template.name && Array.isArray(template.objects) && Array.isArray(template.shots) && isRecord(template.camera) && isRecord(template.motion));
}

function sanitizeTemplate(raw: SceneTemplate): SceneTemplate {
    return {
        id: raw.id,
        name: raw.name,
        group: USER_TEMPLATE_GROUP,
        description: typeof raw.description === "string" ? raw.description : "",
        lighting: normalizeLightingId(raw.lighting),
        objects: raw.objects
            .filter(isRecord)
            .map((item) => {
                const object: SceneTemplateObject = {
                    name: String(item.name || "物体"),
                    x: num(item.x, 0),
                    z: num(item.z, 0),
                    rotationYDeg: num(item.rotationYDeg, 0),
                    scale: num(item.scale, 1),
                };
                if (typeof item.assetId === "string" && item.assetId) object.assetId = item.assetId;
                if (item.kind === "person" || item.kind === "prop" || item.kind === "model" || item.kind === "env") object.kind = item.kind;
                if (typeof item.modelKey === "string" && item.modelKey) object.modelKey = item.modelKey;
                if (typeof item.sourceName === "string" && item.sourceName) object.sourceName = item.sourceName;
                if (item.visible === false) object.visible = false;
                if (Array.isArray(item.track)) object.track = item.track as SceneTemplateObject["track"];
                return object;
            }),
        camera: sanitizeCamera(raw.camera),
        shots: raw.shots
            .filter(isRecord)
            .slice(0, STAGE_SHOT_LIMIT)
            .map((shot) => ({ name: String(shot.name || "机位"), camera: sanitizeCamera(shot.camera), holdMs: num(shot.holdMs, 0) })),
        motion: normalizeMotion(raw.motion),
    };
}

/** 读用户模板；读失败 / 形状不对一律当没有（脏数据不能让大窗口打不开）。 */
export async function listUserTemplates(storage: PluginStorage): Promise<SceneTemplate[]> {
    try {
        const raw = await storage.get<unknown>(TEMPLATE_STORE_KEY);
        return Array.isArray(raw) ? raw.filter(isTemplate).map(sanitizeTemplate) : [];
    } catch {
        return [];
    }
}

export async function findUserTemplate(storage: PluginStorage, id: string): Promise<SceneTemplate | null> {
    return (await listUserTemplates(storage)).find((template) => template.id === id) ?? null;
}

export async function saveUserTemplate(storage: PluginStorage, template: SceneTemplate): Promise<SceneTemplate[]> {
    const templates = await listUserTemplates(storage);
    const sanitized = sanitizeTemplate(template);
    // 同一个 id 再存 = 覆盖那一条（保持它在列表里的位置，不跳到末尾）
    const at = templates.findIndex((item) => item.id === template.id);
    const next = (at >= 0 ? templates.map((item, index) => (index === at ? sanitized : item)) : [...templates, sanitized]).slice(-STAGE_TEMPLATE_LIMIT);
    await writeTemplates(storage, next);
    return next;
}

export async function removeUserTemplate(storage: PluginStorage, id: string): Promise<SceneTemplate[]> {
    const next = (await listUserTemplates(storage)).filter((template) => template.id !== id);
    await writeTemplates(storage, next);
    return next;
}

export async function renameUserTemplate(storage: PluginStorage, id: string, name: string): Promise<SceneTemplate[]> {
    const trimmed = name.trim();
    if (!trimmed) return listUserTemplates(storage);
    const next = (await listUserTemplates(storage)).map((template) => (template.id === id ? { ...template, name: trimmed } : template));
    await writeTemplates(storage, next);
    return next;
}

async function writeTemplates(storage: PluginStorage, templates: SceneTemplate[]): Promise<void> {
    try {
        await storage.set(TEMPLATE_STORE_KEY, templates);
    } catch {
        // 写不进去就退化成"没保存"，不打断编辑
    }
}

export function templateRefs(templates: SceneTemplate[]): StageTemplateRef[] {
    return templates.map((template) => ({ id: template.id, name: template.name }));
}

/** 当前场景 → 模板：物体带 assetId 的按素材存，导入的模型带 modelKey，走位一起存。 */
export function stageStateToTemplate(state: StageState, name: string, id: string): SceneTemplate {
    return {
        id,
        name,
        group: USER_TEMPLATE_GROUP,
        description: describeTemplate(state),
        lighting: state.lighting,
        objects: state.objects.map((object) => ({
            name: object.name,
            x: object.x,
            z: object.z,
            rotationYDeg: object.rotationYDeg,
            scale: object.scale,
            ...(object.assetId ? { assetId: object.assetId } : {}),
            kind: object.kind,
            ...(object.modelKey ? { modelKey: object.modelKey } : {}),
            ...(object.sourceName ? { sourceName: object.sourceName } : {}),
            ...(object.visible === false ? { visible: false } : {}),
            ...(object.track?.length ? { track: object.track.map((pose) => ({ ...pose })) } : {}),
        })),
        camera: { ...state.camera },
        shots: state.shots.map((shot) => ({ name: shot.name, camera: { ...shot.camera }, holdMs: shot.holdMs })),
        motion: { ...state.motion },
    };
}

/** 用人话概括这个模板里有什么（下拉旁边的说明行用）。 */
export function describeTemplate(state: StageState): string {
    const moving = state.objects.some((object) => hasMovement(object.track));
    const models = state.objects.filter((object) => object.kind === "model").length;
    return [
        `${state.objects.length} 个物体`,
        state.shots.length ? `${state.shots.length} 个机位` : "单机位",
        moving ? "含人物走位" : "",
        models ? `含 ${models} 个导入模型` : "",
        `灯光「${lightingPresetById(state.lighting).name}」`,
    ]
        .filter(Boolean)
        .join(" · ");
}
