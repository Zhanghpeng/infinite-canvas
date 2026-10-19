// 内置简易素材库：人物 / 道具 / 环境 / 街道的灰模，全部由**图元**拼出来（程序化生成），
// 不依赖任何外部模型文件（本环境访问不到 CDN，也不该要求用户先去建模）。
//
// 设计要点：
// - 素材是**纯数据**（部件列表），构建器只有一个 —— 网页侧能直接单测目录本身（id 唯一、高度与造型一致），
//   加素材只要加一条数据；
// - 高度与占地**从部件算出来**（assetHeight / assetRadius），不手写、不会与造型脱节；
// - 定位：灰模级 previz，用来搭关系、定构图；要好看的画面仍走 Blender 出图或模型生成。
import type { StageObjectKind } from "./stage-state";

type ThreeModule = typeof import("three");
type Group = import("three").Group;

export type AssetKind = "person" | "prop" | "env";
export type Vec3Tuple = [number, number, number];

type PartBase = { position: Vec3Tuple; rotation?: Vec3Tuple; color: string };
export type Part = PartBase &
    (
        | { shape: "box"; size: Vec3Tuple }
        | { shape: "cylinder"; radius: number; height: number; radiusTop?: number; segments?: number }
        | { shape: "sphere"; radius: number; segments?: number }
        | { shape: "cone"; radius: number; height: number; segments?: number }
        | { shape: "plane"; size: [number, number] }
    );

export type Asset = {
    id: string;
    name: string;
    kind: AssetKind;
    /** 下拉里的分组标题 */
    group: string;
    parts: Part[];
    /** 环境类不画接地阴影（房间/路面自己就是地面） */
    shadow?: "auto" | "none";
};

// --- 部件构造器：让目录读起来像"描述造型"而不是一堆对象字面量 ---
const box = (size: Vec3Tuple, position: Vec3Tuple, color: string, rotation?: Vec3Tuple): Part => ({ shape: "box", size, position, color, rotation });
const cyl = (radius: number, height: number, position: Vec3Tuple, color: string, rotation?: Vec3Tuple, segments = 16): Part => ({ shape: "cylinder", radius, height, position, color, rotation, segments });
const ball = (radius: number, position: Vec3Tuple, color: string): Part => ({ shape: "sphere", radius, position, color });
const cone = (radius: number, height: number, position: Vec3Tuple, color: string, segments = 18): Part => ({ shape: "cone", radius, height, position, color, segments });
const ground = (size: [number, number], position: Vec3Tuple, color: string): Part => ({ shape: "plane", size, position, color, rotation: [-Math.PI / 2, 0, 0] });
/** 桌椅腿：2 或 4 条，沿 ±x / ±z 张开。 */
const legs = (count: 2 | 4, size: Vec3Tuple, spreadX: number, spreadZ: number, height: number, color: string): Part[] =>
    (count === 4 ? ([[1, 1], [-1, 1], [1, -1], [-1, -1]] as Array<[number, number]>) : ([[1, 0], [-1, 0]] as Array<[number, number]>))
        .map(([sx, sz]) => box(size, [sx * spreadX, height / 2, sz * spreadZ], color));

// --- 配色 ---
const SKIN = "#e2cdb8";
const NOSE = "#e2685f";
const MAN = "#7f8fa6";
const WOMAN = "#a88b9c";
const CHILD = "#8fb59a";
const WOOD = "#a9835f";
const WOOD_DARK = "#7d6244";
const METAL = "#8d949e";
const DARK_METAL = "#4d545c";
const FOLIAGE = "#6d8f66";
const FOLIAGE_DARK = "#55744f";
const FABRIC = "#5f6f80";
const FABRIC_DARK = "#46525f";
const FABRIC_WARM = "#9e7f6a";
const WHITE_SOFT = "#e6e2da";
const GLASS = "#8fb7cc";
const WALL = "#b9bec7";
const FLOOR_INDOOR = "#9a9384";
const ROAD = "#3f4650";
const CURB = "#8b9199";
const PAVEMENT = "#7c8189";
const GROUND_GRASS = "#7d8a6f";
const SAND = "#cbb894";
const WATER = "#3d6a86";
const ROOF = "#6f757d";
const CITY = "#4a566b";

/** 人形：腿柱 + 躯干盒 + 双臂 + 头球 + 鼻子（鼻子指 +Z，用来判断朝向）。 */
function personParts(options: { height: number; shoulder: number; color: string; sitting?: boolean }): Part[] {
    const { height, shoulder, color, sitting = false } = options;
    const headRadius = height * 0.09;
    const torsoHeight = height * 0.36;
    const hipHeight = sitting ? height * 0.28 : height * 0.47;
    const torsoY = hipHeight + torsoHeight / 2;
    const headY = hipHeight + torsoHeight + headRadius;
    const armLength = torsoHeight * 0.95;
    const parts: Part[] = [];
    if (sitting) parts.push(box([shoulder * 0.85, hipHeight, shoulder * 1.15], [0, hipHeight / 2, 0], color));
    else parts.push(cyl(shoulder * 0.42, hipHeight, [0, hipHeight / 2, 0], color, undefined, 14));
    parts.push(box([shoulder, torsoHeight, shoulder * 0.55], [0, torsoY, 0], color));
    for (const side of [-1, 1]) parts.push(box([shoulder * 0.16, armLength, shoulder * 0.16], [side * (shoulder / 2 + shoulder * 0.1), torsoY - armLength * 0.05, 0], color));
    parts.push(ball(headRadius, [0, headY, 0], SKIN), ball(headRadius * 0.3, [0, headY - headRadius * 0.1, headRadius * 0.85], NOSE));
    return parts;
}

export const BUILTIN_ASSETS: Asset[] = [
    // --- 人物 ---
    { id: "person-man", name: "成年男", kind: "person", group: "人物", parts: personParts({ height: 1.78, shoulder: 0.46, color: MAN }) },
    { id: "person-woman", name: "成年女", kind: "person", group: "人物", parts: personParts({ height: 1.64, shoulder: 0.39, color: WOMAN }) },
    { id: "person-child", name: "儿童", kind: "person", group: "人物", parts: personParts({ height: 1.15, shoulder: 0.3, color: CHILD }) },
    { id: "person-sitting", name: "坐姿人物", kind: "person", group: "人物", parts: personParts({ height: 1.28, shoulder: 0.44, color: MAN, sitting: true }) },

    // --- 家具 / 室内 ---
    { id: "prop-table", name: "桌子", kind: "prop", group: "家具", parts: [box([1.4, 0.07, 0.8], [0, 0.73, 0], WOOD), ...legs(4, [0.07, 0.72, 0.07], 0.62, 0.33, 0.72, WOOD)] },
    { id: "prop-chair", name: "椅子", kind: "prop", group: "家具", parts: [box([0.44, 0.06, 0.44], [0, 0.45, 0], WOOD), box([0.44, 0.52, 0.06], [0, 0.72, -0.19], WOOD), ...legs(4, [0.05, 0.45, 0.05], 0.18, 0.18, 0.45, WOOD)] },
    { id: "prop-sofa", name: "沙发", kind: "prop", group: "家具", parts: [box([1.8, 0.4, 0.85], [0, 0.2, 0], FABRIC), box([1.8, 0.5, 0.22], [0, 0.65, -0.32], FABRIC), box([0.22, 0.3, 0.85], [0.8, 0.5, 0], FABRIC), box([0.22, 0.3, 0.85], [-0.8, 0.5, 0], FABRIC)] },
    {
        id: "prop-bed",
        name: "床",
        kind: "prop",
        group: "家具",
        parts: [
            box([1.5, 0.4, 2.0], [0, 0.24, 0], WHITE_SOFT),
            box([1.54, 0.55, 0.14], [0, 0.6, -1.02], WOOD_DARK),
            box([1.46, 0.14, 1.2], [0, 0.5, 0.35], FABRIC),
            box([0.52, 0.14, 0.32], [0.34, 0.52, -0.72], WHITE_SOFT),
            box([0.52, 0.14, 0.32], [-0.34, 0.52, -0.72], WHITE_SOFT),
        ],
    },
    { id: "prop-desk", name: "书桌", kind: "prop", group: "家具", parts: [box([1.3, 0.06, 0.65], [0, 0.75, 0], WOOD), box([0.55, 0.4, 0.55], [0.32, 0.5, 0], WOOD_DARK), ...legs(2, [0.07, 0.72, 0.06], 0, 0, 0.72, WOOD)] },
    {
        id: "prop-shelf",
        name: "书架",
        kind: "prop",
        group: "家具",
        parts: [
            box([0.05, 1.8, 0.32], [0.45, 0.9, 0], WOOD_DARK),
            box([0.05, 1.8, 0.32], [-0.45, 0.9, 0], WOOD_DARK),
            ...[0.25, 0.72, 1.19, 1.66].map((y) => box([0.95, 0.05, 0.32], [0, y, 0], WOOD)),
            box([0.09, 0.26, 0.22], [-0.24, 0.4, 0], "#8c5a4a"),
            box([0.09, 0.26, 0.22], [-0.13, 0.4, 0], "#4a6b8a"),
            box([0.09, 0.26, 0.22], [0.12, 0.87, 0], "#5d7a52"),
            box([0.09, 0.26, 0.22], [0.23, 0.87, 0], "#b08b6a"),
        ],
    },
    { id: "prop-rug", name: "地毯", kind: "prop", group: "家具", shadow: "none", parts: [ground([2.6, 1.8], [0, 0.02, 0], "#8a5f52")] },
    { id: "prop-curtain", name: "窗帘", kind: "prop", group: "家具", parts: [box([0.5, 2.4, 0.07], [-0.55, 1.2, 0], "#c8b9a4"), box([0.5, 2.4, 0.07], [0, 1.2, 0], "#bcae99"), box([0.5, 2.4, 0.07], [0.55, 1.2, 0], "#c8b9a4")] },
    { id: "prop-tablelamp", name: "台灯", kind: "prop", group: "家具", parts: [cyl(0.13, 0.05, [0, 0.025, 0], DARK_METAL), cyl(0.025, 0.44, [0, 0.25, 0], DARK_METAL, undefined, 10), cone(0.2, 0.26, [0, 0.58, 0], "#f2e0ae")] },
    { id: "prop-tv", name: "电视", kind: "prop", group: "家具", parts: [box([0.95, 0.56, 0.06], [0, 1.15, 0], "#20242b"), box([0.87, 0.48, 0.02], [0, 1.15, 0.05], GLASS), box([0.08, 0.32, 0.08], [0, 0.95, 0], DARK_METAL), box([0.42, 0.05, 0.26], [0, 0.8, 0], DARK_METAL)] },
    { id: "prop-counter", name: "吧台", kind: "prop", group: "家具", parts: [box([2.2, 1.02, 0.6], [0, 0.51, 0], WOOD_DARK), box([2.3, 0.08, 0.68], [0, 1.06, 0], "#3a3f46")] },
    { id: "prop-plant", name: "盆栽", kind: "prop", group: "家具", parts: [cyl(0.19, 0.3, [0, 0.15, 0], "#9a6b52"), ball(0.34, [0, 0.62, 0], FOLIAGE), ball(0.2, [0.24, 0.86, 0.06], FOLIAGE_DARK)] },
    { id: "prop-wardrobe", name: "衣柜", kind: "prop", group: "家具", parts: [box([1.2, 2.0, 0.58], [0, 1.0, 0], WOOD), box([0.02, 1.9, 0.02], [0, 1.0, 0.3], WOOD_DARK), ball(0.03, [0.12, 1.05, 0.31], METAL), ball(0.03, [-0.12, 1.05, 0.31], METAL)] },
    { id: "prop-box", name: "纸箱", kind: "prop", group: "家具", parts: [box([0.6, 0.6, 0.6], [0, 0.3, 0], WOOD)] },

    // --- 街道 / 公共 ---
    { id: "prop-streetlamp", name: "路灯", kind: "prop", group: "街道", parts: [cyl(0.08, 4, [0, 2, 0], METAL, undefined, 10), box([0.2, 0.14, 0.6], [0, 4.06, 0.24], METAL), box([0.18, 0.06, 0.3], [0, 3.96, 0.3], "#f2e3a8")] },
    { id: "prop-bench", name: "长椅", kind: "prop", group: "街道", parts: [box([1.7, 0.07, 0.46], [0, 0.45, 0], WOOD), box([1.7, 0.4, 0.06], [0, 0.72, -0.22], WOOD), box([0.07, 0.45, 0.4], [0.72, 0.22, 0], DARK_METAL), box([0.07, 0.45, 0.4], [-0.72, 0.22, 0], DARK_METAL)] },
    { id: "prop-railing", name: "栏杆", kind: "prop", group: "街道", parts: [box([2.4, 0.06, 0.06], [0, 1.02, 0], METAL), box([2.4, 0.06, 0.06], [0, 0.56, 0], METAL), box([0.07, 1.06, 0.07], [-1.1, 0.53, 0], METAL), box([0.07, 1.06, 0.07], [0, 0.53, 0], METAL), box([0.07, 1.06, 0.07], [1.1, 0.53, 0], METAL)] },
    { id: "prop-busstop", name: "公交站牌", kind: "prop", group: "街道", parts: [cyl(0.05, 2.6, [0, 1.3, 0], METAL, undefined, 10), box([0.5, 0.72, 0.06], [0, 2.25, 0], "#3d6ea8"), box([0.38, 0.12, 0.02], [0, 2.45, 0.05], WHITE_SOFT)] },
    { id: "prop-vending", name: "售货机", kind: "prop", group: "街道", parts: [box([0.95, 1.9, 0.72], [0, 0.95, 0], "#b0473f"), box([0.72, 1.25, 0.03], [0, 1.12, 0.37], "#2b3038"), box([0.4, 0.14, 0.03], [0, 0.36, 0.37], "#2b3038")] },
    { id: "prop-shopsign", name: "店招", kind: "prop", group: "街道", parts: [box([1.8, 0.44, 0.12], [0, 3.0, 0], "#c8534a"), box([1.62, 0.28, 0.02], [0, 3.0, 0.07], "#f4e7d0"), box([0.08, 0.56, 0.08], [-0.7, 2.72, 0], DARK_METAL), box([0.08, 0.56, 0.08], [0.7, 2.72, 0], DARK_METAL)] },
    { id: "prop-car", name: "汽车", kind: "prop", group: "街道", parts: [box([1.8, 0.62, 4.2], [0, 0.66, 0], "#5c6b7a"), box([1.6, 0.52, 2.2], [0, 1.2, -0.25], "#48566b"), ...[1, -1].flatMap((sx) => [1, -1].map((sz) => cyl(0.32, 0.22, [sx * 0.92, 0.32, sz * 1.35], "#22262c", [0, 0, Math.PI / 2], 14)))] },
    { id: "prop-bicycle", name: "自行车", kind: "prop", group: "街道", parts: [cyl(0.34, 0.05, [-0.55, 0.34, 0], DARK_METAL, [Math.PI / 2, 0, 0], 16), cyl(0.34, 0.05, [0.55, 0.34, 0], DARK_METAL, [Math.PI / 2, 0, 0], 16), box([1.1, 0.06, 0.06], [0, 0.5, 0], "#8a5f52"), box([0.06, 0.52, 0.06], [0.55, 0.56, 0], "#8a5f52"), box([0.5, 0.05, 0.05], [0.6, 0.86, 0], DARK_METAL), box([0.1, 0.06, 0.24], [-0.4, 0.76, 0], "#2b3038")] },
    { id: "prop-rock", name: "石头", kind: "prop", group: "街道", parts: [ball(0.5, [0, 0.34, 0], "#7d8188"), ball(0.32, [0.36, 0.22, 0.16], "#6e727a")] },

    // --- 户外 / 自然 ---
    { id: "prop-tree", name: "树", kind: "prop", group: "户外", parts: [cyl(0.16, 1.6, [0, 0.8, 0], WOOD_DARK, undefined, 12), ball(0.95, [0, 2.15, 0], FOLIAGE), ball(0.6, [0.5, 1.75, 0.35], FOLIAGE_DARK)] },
    { id: "prop-tent", name: "帐篷", kind: "prop", group: "户外", parts: [cone(1.15, 1.2, [0, 0.6, 0], "#7a8a6b", 4), ground([1.5, 1.5], [0, 0.02, 0], "#5c6650")] },
    { id: "prop-campfire", name: "篝火", kind: "prop", group: "户外", parts: [ball(0.14, [0.55, 0.08, 0], "#7d8188"), ball(0.14, [-0.55, 0.08, 0], "#7d8188"), ball(0.14, [0, 0.08, 0.55], "#7d8188"), ball(0.14, [0, 0.08, -0.55], "#7d8188"), cyl(0.06, 0.52, [0, 0.12, 0], WOOD_DARK, [0, 0, Math.PI / 2], 8), cyl(0.06, 0.52, [0, 0.12, 0], WOOD_DARK, [Math.PI / 2, 0, 0], 8), cone(0.22, 0.5, [0, 0.42, 0], "#e8913c")] },
    { id: "prop-door", name: "门框", kind: "prop", group: "户外", parts: [box([0.12, 2.1, 0.12], [-0.5, 1.05, 0], WOOD), box([0.12, 2.1, 0.12], [0.5, 1.05, 0], WOOD), box([1.12, 0.14, 0.12], [0, 2.12, 0], WOOD)] },
    { id: "prop-pillar", name: "柱子", kind: "prop", group: "户外", parts: [cyl(0.22, 3, [0, 1.5, 0], METAL, undefined, 18)] },

    // --- 环境 ---
    {
        id: "env-room",
        name: "房间（6m）",
        kind: "env",
        group: "环境",
        shadow: "none",
        parts: [ground([6, 6], [0, 0.012, 0], FLOOR_INDOOR), box([6, 2.8, 0.14], [0, 1.4, -3], WALL), box([0.14, 2.8, 6], [-3, 1.4, 0], WALL), box([0.14, 2.8, 6], [3, 1.4, 0], WALL)],
    },
    {
        id: "env-street",
        name: "街道（10m）",
        kind: "env",
        group: "环境",
        shadow: "none",
        parts: [ground([10, 10], [0, 0.012, 0], ROAD), box([0.34, 0.16, 10], [-2.8, 0.08, 0], CURB), box([0.34, 0.16, 10], [2.8, 0.08, 0], CURB), box([0.1, 0.02, 3], [0, 0.02, 0], "#c9c9c9"), box([0.1, 0.02, 3], [0, 0.02, 5], "#c9c9c9"), box([0.1, 0.02, 3], [0, 0.02, -5], "#c9c9c9")],
    },
    {
        id: "env-rooftop",
        name: "天台（9m）",
        kind: "env",
        group: "环境",
        shadow: "none",
        parts: [
            ground([9, 9], [0, 0.012, 0], PAVEMENT),
            box([9, 0.9, 0.2], [0, 0.45, -4.4], ROOF),
            box([0.2, 0.9, 9], [-4.4, 0.45, 0], ROOF),
            box([0.2, 0.9, 9], [4.4, 0.45, 0], ROOF),
            box([1.3, 1.3, 1.3], [-2.8, 0.65, -3.0], ROOF),
            cyl(0.35, 1.1, [2.6, 0.55, -3.2], METAL, undefined, 14),
        ],
    },
    {
        id: "env-park",
        name: "公园（14m）",
        kind: "env",
        group: "环境",
        shadow: "none",
        parts: [ground([14, 14], [0, 0.012, 0], GROUND_GRASS), ground([1.8, 14], [0, 0.02, 0], "#9a9a90"), cone(2.2, 0.9, [-4.2, 0.45, -3.6], FOLIAGE_DARK), cone(1.6, 0.7, [4.3, 0.35, 2.8], FOLIAGE)],
    },
    {
        id: "env-beach",
        name: "海边（14m）",
        kind: "env",
        group: "环境",
        shadow: "none",
        parts: [ground([14, 14], [0, 0.012, 0], SAND), ground([14, 7], [0, 0.02, -9], WATER), box([14, 0.06, 0.4], [0, 0.05, -5.5], "#e8eef2")],
    },
    { id: "env-terrain", name: "地形地块（12m）", kind: "env", group: "环境", shadow: "none", parts: [ground([12, 12], [0, 0.012, 0], GROUND_GRASS), cone(2.6, 1.4, [-3.6, 0.7, -2.4], FOLIAGE_DARK), box([2.4, 0.5, 2.4], [3.4, 0.25, 1.2], FOLIAGE)] },
    {
        id: "env-skyline",
        name: "远景楼群",
        kind: "env",
        group: "环境",
        shadow: "none",
        parts: [[-7, 6, -9, 3], [-3.4, 9, -9.6, 3.4], [0.4, 4.5, -8.8, 3.2], [3.6, 12, -9.4, 3], [7.4, 7.5, -9.2, 3.6]].map(([x, height, z, width]) =>
            box([width, height, 2.4], [x, height / 2, z], CITY),
        )},
];

const ASSET_BY_ID = new Map(BUILTIN_ASSETS.map((asset) => [asset.id, asset]));

export function assetById(id: string | undefined): Asset | undefined {
    return id ? ASSET_BY_ID.get(id) : undefined;
}

/** 素材分组（下拉用），按人物 / 家具 / 街道 / 户外 / 环境 分组。 */
export function assetGroups(): Array<{ label: string; assets: Asset[] }> {
    const labels = ["人物", "家具", "街道", "户外", "环境"];
    return labels.map((label) => ({ label, assets: BUILTIN_ASSETS.filter((asset) => asset.group === label) })).filter((group) => group.assets.length > 0);
}

/** 素材对应的物体类别（与 StageObjectKind 对齐）。 */
export function assetObjectKind(asset: Asset): StageObjectKind {
    return asset.kind === "env" ? "env" : asset.kind === "person" ? "person" : "prop";
}

function partHalfHeight(part: Part): number {
    if (part.shape === "box") return part.size[1] / 2;
    if (part.shape === "cylinder" || part.shape === "cone") return part.height / 2;
    if (part.shape === "sphere") return part.radius;
    return 0;
}

function partHalfWidth(part: Part): [number, number] {
    if (part.shape === "box") return [part.size[0] / 2, part.size[2] / 2];
    if (part.shape === "plane") return [part.size[0] / 2, part.size[1] / 2];
    if (part.shape === "cylinder" || part.shape === "cone") return [part.radius, part.radius];
    return [part.radius, part.radius];
}

/** 素材实际高度（米）：从部件算出来，不手写维护，保证与造型一致。 */
export function assetHeight(asset: Asset): number {
    return Math.max(0.1, ...asset.parts.map((part) => part.position[1] + partHalfHeight(part)));
}

/** 素材水平占地半径（米）：接地阴影与提示词里的"体型"都用它。 */
export function assetRadius(asset: Asset): number {
    return Math.max(0.1, ...asset.parts.map((part) => {
        const [halfWidth, halfDepth] = partHalfWidth(part);
        return Math.max(Math.abs(part.position[0]) + halfWidth, Math.abs(part.position[2]) + halfDepth);
    }));
}

/** 把素材的部件拼成一个 Group（材质随素材创建，随视口 dispose 一起释放）。 */
export function buildAssetGroup(t: ThreeModule, asset: Asset): Group {
    const group = new t.Group();
    for (const part of asset.parts) {
        const material = new t.MeshStandardMaterial({ color: part.color, roughness: 0.78, metalness: 0.06 });
        let mesh;
        if (part.shape === "box") mesh = new t.Mesh(new t.BoxGeometry(...part.size), material);
        else if (part.shape === "cylinder") mesh = new t.Mesh(new t.CylinderGeometry(part.radiusTop ?? part.radius, part.radius, part.height, part.segments ?? 16), material);
        else if (part.shape === "cone") mesh = new t.Mesh(new t.ConeGeometry(part.radius, part.height, part.segments ?? 18), material);
        else if (part.shape === "sphere") mesh = new t.Mesh(new t.SphereGeometry(part.radius, part.segments ?? 18, 12), material);
        else mesh = new t.Mesh(new t.PlaneGeometry(part.size[0], part.size[1]), material);
        mesh.position.set(...part.position);
        if (part.rotation) mesh.rotation.set(...part.rotation);
        group.add(mesh);
    }
    return group;
}
