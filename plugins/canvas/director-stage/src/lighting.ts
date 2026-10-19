// 摄影灯光预设：真实拍摄里"光"有时候比机位还决定画面。
// 这里给四档氛围级预设（主光方向/强度/色温 + 补光 + 环境光 + 背景色），
// 让夜景、室内、逆光在灰模里也一眼能读出来；导出的参考图吃的是同一套灯。
// 刻意不做物理光照：一来图元灰模不需要，二来参数多了反而难选。
import type { StageLightingId } from "./stage-state";

export type LightingLight = { azimuthDeg: number; elevationDeg: number; intensity: number; color: string };

export type LightingPreset = {
    id: StageLightingId;
    name: string;
    description: string;
    /** 主光（key light） */
    key: LightingLight;
    /** 补光（fill light） */
    fill: LightingLight;
    ambient: { intensity: number; sky: string; ground: string };
    background: string;
};

export const LIGHTING_PRESETS: LightingPreset[] = [
    {
        id: "day",
        name: "白天",
        description: "顶光偏侧，天空冷色补光，适合户外日景",
        key: { azimuthDeg: 40, elevationDeg: 58, intensity: 2.2, color: "#fff6e6" },
        fill: { azimuthDeg: -125, elevationDeg: 22, intensity: 0.5, color: "#cfe0ff" },
        ambient: { intensity: 0.8, sky: "#e9f1ff", ground: "#4a4438" },
        background: "#c6d5e6",
    },
    {
        id: "night",
        name: "夜晚",
        description: "弱主光 + 冷色环境，路灯/月光质感",
        key: { azimuthDeg: -55, elevationDeg: 32, intensity: 0.6, color: "#a9c6ff" },
        fill: { azimuthDeg: 120, elevationDeg: 14, intensity: 0.16, color: "#38467a" },
        ambient: { intensity: 0.22, sky: "#26304a", ground: "#0d1017" },
        background: "#0d1219",
    },
    {
        id: "indoor",
        name: "室内",
        description: "暖色主光从侧上方来，补光偏暖，适合客厅/办公室",
        key: { azimuthDeg: 28, elevationDeg: 44, intensity: 1.6, color: "#ffe8c6" },
        fill: { azimuthDeg: -140, elevationDeg: 18, intensity: 0.55, color: "#ffd6a8" },
        ambient: { intensity: 0.62, sky: "#f2e8da", ground: "#4a4038" },
        background: "#2b2721",
    },
    {
        id: "backlit",
        name: "逆光",
        description: "主光在人物背后，正面靠弱补光，剪影/情绪用",
        key: { azimuthDeg: 176, elevationDeg: 26, intensity: 2.8, color: "#fff0cd" },
        fill: { azimuthDeg: 8, elevationDeg: 12, intensity: 0.24, color: "#9db6e0" },
        ambient: { intensity: 0.34, sky: "#dfe8f5", ground: "#3a3a36" },
        background: "#b6c6d8",
    },
];

const BY_ID = new Map(LIGHTING_PRESETS.map((preset) => [preset.id, preset]));

export function lightingPresetById(id: StageLightingId): LightingPreset {
    return BY_ID.get(id) || LIGHTING_PRESETS[0];
}

export function normalizeLightingId(raw: unknown): StageLightingId {
    return typeof raw === "string" && BY_ID.has(raw as StageLightingId) ? (raw as StageLightingId) : "day";
}

/** 由方位角/高度角算灯的落点（与相机同一套方位约定：0° = +Z 方向）。 */
export function lightPosition(light: LightingLight, radius = 14): [number, number, number] {
    const azimuth = (light.azimuthDeg * Math.PI) / 180;
    const elevation = (light.elevationDeg * Math.PI) / 180;
    const horizontal = Math.cos(elevation) * radius;
    return [Math.sin(azimuth) * horizontal, Math.sin(elevation) * radius, Math.cos(azimuth) * horizontal];
}
