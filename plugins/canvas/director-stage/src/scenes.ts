// 场景模板：一整套可直接拍的东西 —— 环境 + 人物 + 道具 + 当前机位 + 关键帧机位 + 运镜 + 灯光。
// 参数参考真实拍法（过肩正反打、外反打、dolly-in、摇臂上摇、横移跟拍、环绕静物、群像横扫…），
// 目的是让人不用从空场景开始摆。
import { assetById, assetObjectKind } from "./library";
import type { StageLightingId } from "./stage-state";
import { createStageShot, DEFAULT_MOTION, normalizeTrack, type StageMotion, type StagePose } from "./motion";
import { createStageObject, DEFAULT_CAMERA, type StageCamera, type StageObjectKind, type StageState } from "./stage-state";

/**
 * 模板里的一个物体。内置模板只给 `assetId`（其余字段由素材推导）；
 * 用户模板（「我的模板」）会带上显式 `kind` / 导入模型的 `modelKey` / 走位 `track` —— 所以是超集。
 */
export type SceneTemplateObject = {
    name: string;
    x: number;
    z: number;
    assetId?: string;
    kind?: StageObjectKind;
    rotationYDeg?: number;
    scale?: number;
    track?: StagePose[];
    modelKey?: string;
    sourceName?: string;
    visible?: boolean;
};
export type SceneTemplate = {
    id: string;
    name: string;
    group: string;
    /** 用人话说这个场面与拍法 */
    description: string;
    lighting: StageLightingId;
    objects: SceneTemplateObject[];
    camera: StageCamera;
    shots: Array<{ name: string; camera: StageCamera; holdMs?: number }>;
    motion: StageMotion;
};

const cam = (patch: Partial<StageCamera> = {}): StageCamera => ({ ...DEFAULT_CAMERA, ...patch });
const motion = (durationMs: number, easing: "linear" | "easeInOut" = "easeInOut"): StageMotion => ({ ...DEFAULT_MOTION, durationMs, easing });

const ROOM = { assetId: "env-room", name: "客厅", x: 0, z: 0 } as const;
const STREET = { assetId: "env-street", name: "街道", x: 0, z: 0 } as const;
const SKYLINE = { assetId: "env-skyline", name: "远景楼群", x: 0, z: 0 } as const;

export const SCENE_TEMPLATES: SceneTemplate[] = [
    {
        id: "dialogue-over-shoulder",
        name: "双人对话 · 过肩正反打",
        group: "对话",
        description: "客厅里两人隔茶几对坐，先过 B 的肩拍 A，再反打 A 的肩拍 B（50mm，正反打的标准机位）",
        lighting: "indoor",
        objects: [
            ROOM,
            { assetId: "prop-sofa", name: "沙发", x: 0, z: -2.35 },
            { assetId: "prop-table", name: "茶几", x: 0, z: -0.75 },
            { assetId: "prop-rug", name: "地毯", x: 0, z: -0.9 },
            { assetId: "prop-tablelamp", name: "台灯", x: 1.55, z: -1.05 },
            { assetId: "prop-plant", name: "盆栽", x: -2.5, z: -2.6 },
            { assetId: "person-sitting", name: "女主", x: -0.45, z: -1.95, rotationYDeg: 8 },
            { assetId: "person-man", name: "男主", x: 0.5, z: 0.95, rotationYDeg: 186 },
        ],
        camera: cam({ azimuthDeg: 0, elevationDeg: 12, distance: 3.4, targetY: 1.1, focalMm: 50 }),
        shots: [
            { name: "过肩拍女主", camera: cam({ azimuthDeg: 0, elevationDeg: 12, distance: 3.4, targetY: 1.1, focalMm: 50 }) },
            { name: "反打男主", camera: cam({ azimuthDeg: 180, elevationDeg: 12, distance: 3.2, targetY: 1.1, focalMm: 50 }) },
        ],
        motion: motion(4000),
    },
    {
        id: "dialogue-external-reverse",
        name: "双人对话 · 外反打（视线留白）",
        group: "对话",
        description: "公园长椅前两人侧面站立，从两人外侧各拍一次（85mm 压缩空间、留视线方向的空间）",
        lighting: "day",
        objects: [
            { assetId: "env-park", name: "公园", x: 0, z: 0 },
            { assetId: "prop-bench", name: "长椅", x: 0, z: -1.5 },
            { assetId: "prop-tree", name: "树", x: -3.6, z: -3.2 },
            { assetId: "person-woman", name: "女主", x: -0.7, z: 0.5, rotationYDeg: 200 },
            { assetId: "person-man", name: "男主", x: 0.7, z: 0.4, rotationYDeg: 160 },
        ],
        camera: cam({ azimuthDeg: -55, elevationDeg: 9, distance: 4.4, targetY: 1.15, focalMm: 85 }),
        shots: [
            { name: "外侧左", camera: cam({ azimuthDeg: -55, elevationDeg: 9, distance: 4.4, targetY: 1.15, focalMm: 85 }) },
            { name: "外侧右", camera: cam({ azimuthDeg: 55, elevationDeg: 9, distance: 4.4, targetY: 1.15, focalMm: 85 }) },
        ],
        motion: motion(4500),
    },
    {
        id: "solo-monologue-push-in",
        name: "单人独白 · 推近特写",
        group: "单人",
        description: "书桌前台灯亮着，人物坐着说话，镜头从半身缓推到脸部特写（50mm → 85mm）",
        lighting: "indoor",
        objects: [
            ROOM,
            { assetId: "prop-desk", name: "书桌", x: 0.2, z: -2.0 },
            { assetId: "prop-chair", name: "椅子", x: 0.15, z: -1.05, rotationYDeg: 180 },
            { assetId: "prop-tablelamp", name: "台灯", x: -0.6, z: -2.05 },
            { assetId: "prop-shelf", name: "书架", x: -2.6, z: -2.9 },
            { assetId: "person-sitting", name: "主角", x: 0.15, z: -1.15, rotationYDeg: 175 },
        ],
        camera: cam({ azimuthDeg: 4, elevationDeg: 10, distance: 3.6, targetY: 1.15, focalMm: 50 }),
        shots: [
            { name: "半身", camera: cam({ azimuthDeg: 4, elevationDeg: 10, distance: 3.6, targetY: 1.15, focalMm: 50 }) },
            { name: "脸部特写", camera: cam({ azimuthDeg: 0, elevationDeg: 6, distance: 1.9, targetY: 1.28, focalMm: 85 }) },
        ],
        motion: motion(5000),
    },
    {
        id: "hero-low-angle-crane",
        name: "英雄镜头 · 低角度上摇",
        group: "单人",
        description: "街头人物正面站立，低机位仰拍到 28mm 广角，再摇臂抬起到俯视（英雄出场感）",
        lighting: "backlit",
        objects: [
            STREET,
            SKYLINE,
            { assetId: "prop-streetlamp", name: "路灯", x: -2.6, z: 0.6 },
            { assetId: "prop-car", name: "路边车", x: 2.4, z: -3.2, rotationYDeg: 6 },
            { assetId: "person-man", name: "主角", x: 0, z: 0.2, rotationYDeg: 0 },
        ],
        camera: cam({ azimuthDeg: 0, elevationDeg: -8, distance: 3.6, targetY: 1.5, focalMm: 28 }),
        shots: [
            { name: "低机位仰拍", camera: cam({ azimuthDeg: 0, elevationDeg: -8, distance: 3.6, targetY: 1.5, focalMm: 28 }) },
            { name: "摇臂拉起", camera: cam({ azimuthDeg: 8, elevationDeg: 42, distance: 6.5, targetY: 1.2, focalMm: 35 }) },
        ],
        motion: motion(4000, "linear"),
    },
    {
        id: "rooftop-lookout-crane",
        name: "天台远眺 · 摇臂拉起",
        group: "风景",
        description: "两人背对镜头站在天台边看城市，镜头从背后中景抬起到高角度全景",
        lighting: "night",
        objects: [
            { assetId: "env-rooftop", name: "天台", x: 0, z: 0 },
            SKYLINE,
            { assetId: "prop-railing", name: "栏杆", x: 0, z: 2.4 },
            { assetId: "person-man", name: "男", x: -0.85, z: 1.2, rotationYDeg: 178 },
            { assetId: "person-woman", name: "女", x: 0.85, z: 1.25, rotationYDeg: 182 },
        ],
        camera: cam({ azimuthDeg: 2, elevationDeg: 12, distance: 4.6, targetY: 1.3, focalMm: 50 }),
        shots: [
            { name: "背后中景", camera: cam({ azimuthDeg: 2, elevationDeg: 10, distance: 4.8, targetY: 1.25, focalMm: 50 }) },
            { name: "摇臂拉起", camera: cam({ azimuthDeg: 6, elevationDeg: 48, distance: 10, targetY: 1.0, focalMm: 28 }) },
        ],
        motion: motion(5000),
    },
    {
        id: "tracking-street-walk",
        name: "横移跟拍 · 街头",
        group: "动作",
        description: "人物沿街走，镜头与他平行横移（两端各一个机位，50mm，匀速）",
        lighting: "day",
        objects: [
            STREET,
            { assetId: "prop-streetlamp", name: "路灯", x: -2.6, z: 1.4 },
            { assetId: "prop-streetlamp", name: "路灯 2", x: 2.6, z: -2.2 },
            { assetId: "prop-bicycle", name: "自行车", x: 2.3, z: 1.6, rotationYDeg: 200 },
            { assetId: "person-man", name: "行人", x: 0, z: 0, rotationYDeg: 270 },
        ],
        camera: cam({ azimuthDeg: -60, elevationDeg: 10, distance: 5.2, targetY: 1.15, focalMm: 50 }),
        shots: [
            { name: "左端起幅", camera: cam({ azimuthDeg: -60, elevationDeg: 10, distance: 5.2, targetY: 1.15, focalMm: 50 }) },
            { name: "右端收幅", camera: cam({ azimuthDeg: 60, elevationDeg: 10, distance: 5.2, targetY: 1.15, focalMm: 50 }) },
        ],
        motion: motion(3500, "linear"),
    },
    {
        id: "chase-low-night",
        name: "雨夜对峙 · 低机位推近",
        group: "动作",
        description: "夜街两人面对面，低机位拍全景再推到 85mm 特写（紧张感的标准拍法）",
        lighting: "night",
        objects: [
            STREET,
            SKYLINE,
            { assetId: "prop-streetlamp", name: "路灯", x: -2.6, z: 0.8 },
            { assetId: "prop-streetlamp", name: "路灯 2", x: 2.6, z: -1.6 },
            { assetId: "prop-car", name: "路边车", x: 2.1, z: -3.4, rotationYDeg: 8 },
            { assetId: "person-man", name: "甲", x: -0.15, z: 1.4, rotationYDeg: 180 },
            { assetId: "person-man", name: "乙", x: 0.15, z: -1.4 },
        ],
        camera: cam({ azimuthDeg: 0, elevationDeg: 6, distance: 6.4, targetY: 1.25, focalMm: 35 }),
        shots: [
            { name: "低角度全景", camera: cam({ azimuthDeg: 0, elevationDeg: 5, distance: 7, targetY: 1.3, focalMm: 35 }) },
            { name: "推近特写", camera: cam({ azimuthDeg: 0, elevationDeg: 4, distance: 3.2, targetY: 1.35, focalMm: 85 }) },
        ],
        motion: motion(3000, "linear"),
    },
    {
        id: "group-pan",
        name: "群像 · 横扫",
        group: "对话",
        description: "四人一排站着，镜头从左端扫到右端（50mm，适合交代人物关系）",
        lighting: "indoor",
        objects: [
            ROOM,
            { assetId: "prop-sofa", name: "沙发", x: 0, z: -2.6 },
            { assetId: "prop-counter", name: "吧台", x: -2.2, z: 0.4, rotationYDeg: 90 },
            { assetId: "person-man", name: "甲", x: -1.5, z: 0.2, rotationYDeg: 0 },
            { assetId: "person-woman", name: "乙", x: -0.5, z: 0.3, rotationYDeg: 0 },
            { assetId: "person-man", name: "丙", x: 0.5, z: 0.25, rotationYDeg: 0 },
            { assetId: "person-child", name: "小孩", x: 1.3, z: 0.35, rotationYDeg: 0 },
        ],
        camera: cam({ azimuthDeg: -35, elevationDeg: 10, distance: 6, targetY: 1.1, focalMm: 50 }),
        shots: [
            { name: "左端起幅", camera: cam({ azimuthDeg: -35, elevationDeg: 10, distance: 6, targetY: 1.1, focalMm: 50 }) },
            { name: "右端收幅", camera: cam({ azimuthDeg: 35, elevationDeg: 10, distance: 6, targetY: 1.1, focalMm: 50 }) },
        ],
        motion: motion(4500),
    },
    {
        id: "product-orbit",
        name: "静物产品 · 环绕",
        group: "静物",
        description: "桌面上摆好产品与陪衬道具，镜头 180° 环绕（50mm，适合产品演示）",
        lighting: "indoor",
        objects: [
            ROOM,
            { assetId: "prop-counter", name: "台面", x: 0, z: -1.6 },
            { assetId: "prop-box", name: "产品", x: -0.3, z: -1.5, scale: 0.9 },
            { assetId: "prop-tablelamp", name: "补光台灯", x: 1.1, z: -1.5 },
            { assetId: "prop-plant", name: "陪衬", x: -1.35, z: -1.75, scale: 0.8 },
        ],
        camera: cam({ azimuthDeg: -90, elevationDeg: 16, distance: 2.6, targetY: 0.95, focalMm: 50 }),
        shots: [
            { name: "左侧环绕位", camera: cam({ azimuthDeg: -90, elevationDeg: 16, distance: 2.6, targetY: 0.95, focalMm: 50 }) },
            { name: "右侧环绕位", camera: cam({ azimuthDeg: 90, elevationDeg: 16, distance: 2.6, targetY: 0.95, focalMm: 50 }) },
        ],
        motion: motion(5000, "linear"),
    },
    {
        id: "seaside-lookout",
        name: "海边远眺 · 缓推",
        group: "风景",
        description: "两人并肩看海，逆光，镜头从全景缓推到中近景（海平线构图）",
        lighting: "backlit",
        objects: [
            { assetId: "env-beach", name: "海边", x: 0, z: 0 },
            { assetId: "prop-rock", name: "礁石", x: -2.4, z: 0.8 },
            { assetId: "person-man", name: "男", x: -0.6, z: 1.0, rotationYDeg: 178 },
            { assetId: "person-woman", name: "女", x: 0.6, z: 1.05, rotationYDeg: 182 },
        ],
        camera: cam({ azimuthDeg: 0, elevationDeg: 8, distance: 5.6, targetY: 1.25, focalMm: 50 }),
        shots: [
            { name: "全景", camera: cam({ azimuthDeg: 0, elevationDeg: 8, distance: 5.6, targetY: 1.25, focalMm: 50 }) },
            { name: "缓推中近景", camera: cam({ azimuthDeg: 2, elevationDeg: 6, distance: 3.4, targetY: 1.3, focalMm: 85 }) },
        ],
        motion: motion(6000),
    },
];

const SCENE_BY_ID = new Map(SCENE_TEMPLATES.map((template) => [template.id, template]));

export function sceneById(id: string | undefined): SceneTemplate | undefined {
    return id ? SCENE_BY_ID.get(id) : undefined;
}

/** 模板分组（下拉用）。 */
export function sceneGroups(): Array<{ label: string; scenes: SceneTemplate[] }> {
    const labels = ["对话", "单人", "动作", "风景", "静物"];
    return labels.map((label) => ({ label, scenes: SCENE_TEMPLATES.filter((template) => template.group === label) })).filter((group) => group.scenes.length > 0);
}

/**
 * 把模板套到当前状态上：重建物体（新 id，避免和画布历史打架）、替换机位/关键帧/运镜/灯光，
 * **保留导出设置与语言**（那些是用户偏好，不该被模板改掉）。
 */
export function applySceneToState(state: StageState, template: SceneTemplate): StageState {
    const objects = template.objects.map((item) => {
        const asset = assetById(item.assetId);
        // 用户模板带显式 kind（导入模型/走位），内置模板只有 assetId
        const kind = item.kind ?? (asset ? assetObjectKind(asset) : "prop");
        const object = createStageObject(kind, item.name || asset?.name || "物体", item.x, item.z);
        const track = normalizeTrack(item.track);
        return {
            ...object,
            rotationYDeg: item.rotationYDeg ?? 0,
            scale: item.scale ?? 1,
            ...(item.visible === false ? { visible: false } : {}),
            ...(asset ? { assetId: asset.id } : {}),
            ...(item.modelKey ? { modelKey: item.modelKey } : {}),
            ...(item.sourceName ? { sourceName: item.sourceName } : {}),
            ...(track ? { track } : {}),
        };
    });
    return {
        ...state,
        objects,
        camera: { ...template.camera },
        shots: template.shots.map((shot) => createStageShot(shot.camera, shot.name, shot.holdMs ?? 0)),
        motion: { ...template.motion },
        lighting: template.lighting,
    };
}
