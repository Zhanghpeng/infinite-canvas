import { describe, expect, it } from "vitest";

import posesJson from "@/data/system-presets/poses.json";

import { ALL_POSES, POSE_ANGLE_LABELS, POSE_SERIES_LIST, SAFE_POSE_COUNT } from "@/lib/canvas/pose-presets";

type RawPose = { id: string; series: string; group?: string; name: string; angles?: string[]; nsfw?: boolean };

const raw = posesJson as unknown as { series: { id: string; name: string; count: number; nsfw?: boolean }[]; assets: RawPose[] };

/**
 * 姿态数据的唯一来源是 `data/system-presets/poses.json`（资产弹窗与侧栏素材库共用）。
 * 之前侧栏还额外读一份 `data/pose-presets.json` 并硬编码剔除「双人纠缠」，
 * 结果弹窗 288、侧栏 233，同一份资产在两个入口数量对不上。
 */
describe("姿态预设数据源", () => {
    it("与系统预设索引逐条对齐（不再有第二份数据）", () => {
        expect(ALL_POSES).toHaveLength(raw.assets.length);
        expect(ALL_POSES.map((pose) => pose.id)).toEqual(raw.assets.map((asset) => asset.id));
        expect(POSE_SERIES_LIST.map((series) => series.id)).toEqual(raw.series.map((series) => series.id));
    });

    it("保留敏感分类，但默认可见数量只算安全项", () => {
        const sensitive = raw.assets.filter((asset) => asset.nsfw);
        // 双人互动是唯一被标 nsfw 的系列，且必须仍然可被开关取到
        expect(sensitive.length).toBeGreaterThan(0);
        expect(ALL_POSES.filter((pose) => pose.nsfw)).toHaveLength(sensitive.length);
        expect(SAFE_POSE_COUNT).toBe(ALL_POSES.length - sensitive.length);
    });

    it("系列计数与资产实际条数一致（数据同步漂移会在这里报出来）", () => {
        for (const series of POSE_SERIES_LIST) {
            const actual = ALL_POSES.filter((pose) => pose.series === series.id).length;
            expect(actual, `series ${series.id}`).toBe(series.count);
        }
    });

    it("每条姿态都有可渲染的机位与分组", () => {
        for (const pose of ALL_POSES) {
            expect(pose.angles.length, pose.id).toBeGreaterThan(0);
            for (const angle of pose.angles) expect(POSE_ANGLE_LABELS[angle], `${pose.id} ${angle}`).toBeTruthy();
            expect(pose.name, pose.id).toBeTruthy();
        }
    });
});
