import posesData from "@/data/system-presets/poses.json";

export type PoseAngleKey = "front" | "side" | "diag" | "high" | "low";

export type PoseItem = {
    id: string;
    series: string;
    /** 姿势分组（站立 / 坐姿 / 跪立·四肢撑地 …）。 */
    category: string;
    name: string;
    angles: PoseAngleKey[];
    /** 敏感姿势（双人互动）。默认隐藏，由「显示敏感内容」开关放行。 */
    nsfw: boolean;
};

export type PoseSeriesItem = {
    id: string;
    name: string;
    count: number;
    nsfw: boolean;
};

export const POSE_CDN_BASE = "https://ai-pose-gallery.pages.dev";
export const POSE_DEPTH_CDN_BASE = "https://ai-pose-depth-gallery.pages.dev";
export const POSE_REPOSITORY_URL = "https://github.com/ZhuYichuan/pose-gallery";

export const POSE_ANGLE_LABELS: Record<PoseAngleKey, string> = {
    front: "正面",
    side: "侧面",
    diag: "斜向",
    high: "俯视",
    low: "仰视",
};

type RawSeries = { id: string; name: string; count: number; nsfw?: boolean };
type RawAsset = { id: string; series: string; group?: string; name: string; angles?: string[]; nsfw?: boolean };

const dataset = posesData as unknown as { series: RawSeries[]; assets: RawAsset[] };

/**
 * 姿势库的唯一数据源：`data/system-presets/poses.json`（与资产弹窗、素材库预置共用）。
 *
 * 以前这里还有一份 `data/pose-presets.json` + 硬编码的「双人纠缠」黑名单，
 * 结果是弹窗能看到 288 张、侧栏只有 233 张，两个入口对不上。现在敏感内容交给
 * `nsfw` 字段驱动、由开关放行（与上游 v0.22 一致），数据只留一份。
 */
export const POSE_SERIES_LIST: PoseSeriesItem[] = dataset.series.map((series) => ({
    id: series.id,
    name: series.name,
    count: series.count,
    nsfw: Boolean(series.nsfw),
}));

const DEFAULT_ANGLES: PoseAngleKey[] = ["front", "side", "diag", "high", "low"];

export const ALL_POSES: PoseItem[] = dataset.assets.map((asset) => ({
    id: asset.id,
    series: asset.series,
    category: asset.group ?? "",
    name: asset.name,
    angles: (asset.angles?.length ? asset.angles : DEFAULT_ANGLES) as PoseAngleKey[],
    nsfw: Boolean(asset.nsfw),
}));

/** 敏感开关关闭时可见的姿势数量（面板角标与「显示敏感内容」开关的文案都用它）。 */
export const SAFE_POSE_COUNT = ALL_POSES.filter((pose) => !pose.nsfw).length;

/**
 * 原图（PNG，插入节点 / 送生成用）。
 *
 * 路径必须带 `img/` 段：CDN 根目录只有 `thumbs/` 与 `img/` 两个子目录，根下取图会被
 * SPA 的 fallback 命中，返回 200 + `text/html` 的首页（450KB），前端一路静默存成坏图。
 */
export function getPoseImageUrl(poseId: string, angle: PoseAngleKey, cdnBase = POSE_CDN_BASE): string {
    return `${cdnBase.replace(/\/+$/, "")}/img/${poseId}_${angle}.png`;
}

/** 缩略图（JPG，网格与悬停预览用，比原图小一个量级）。 */
export function getPoseThumbUrl(poseId: string, angle: PoseAngleKey, cdnBase = POSE_CDN_BASE): string {
    return `${cdnBase.replace(/\/+$/, "")}/thumbs/${poseId}_${angle}.jpg`;
}
