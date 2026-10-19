// 内置素材库是纯数据，这里钉住"目录本身"的正确性：id 唯一、造型与高度/占地一致、分组齐全。
import { describe, expect, it } from "vitest";

import { assetById, assetGroups, assetHeight, assetObjectKind, assetRadius, BUILTIN_ASSETS } from "../../../../../plugins/canvas/director-stage/src/library";
import { objectHeight } from "../../../../../plugins/canvas/director-stage/src/prompt";
import { normalizeStageState } from "../../../../../plugins/canvas/director-stage/src/stage-state";

describe("素材目录", () => {
    it("id 唯一、都有名字与部件", () => {
        const ids = BUILTIN_ASSETS.map((asset) => asset.id);
        expect(new Set(ids).size).toBe(ids.length);
        for (const asset of BUILTIN_ASSETS) {
            expect(asset.name.length).toBeGreaterThan(0);
            expect(asset.parts.length).toBeGreaterThan(0);
            expect(assetById(asset.id)).toBe(asset);
        }
        expect(assetById("nope")).toBeUndefined();
    });

    it("分组齐全：人物 / 道具 / 环境", () => {
        const groups = assetGroups();
        expect(groups.map((group) => group.label)).toEqual(["人物", "家具", "街道", "户外", "环境"]);
        // 每个素材都能在分组里找到（分组覆盖全部素材且不重不漏）
        expect(groups.flatMap((group) => group.assets).length).toBe(BUILTIN_ASSETS.length);
        for (const [label, least] of [["人物", 4], ["家具", 10], ["街道", 7], ["户外", 4], ["环境", 5]] as Array<[string, number]>) {
            expect(groups.find((group) => group.label === label)!.assets.length).toBeGreaterThanOrEqual(least);
        }
    });

    it("高度与占地从部件算出来，和造型一致", () => {
        // 纸箱 0.6 立方、桌子面在 0.73 上方
        expect(assetHeight(assetById("prop-box")!)).toBeCloseTo(0.6, 6);
        expect(assetHeight(assetById("prop-table")!)).toBeCloseTo(0.765, 6);
        expect(assetRadius(assetById("prop-box")!)).toBeCloseTo(0.3, 6);
        // 人物高度落在合理区间（成年男 ≈1.8m、儿童明显更矮）
        const man = assetHeight(assetById("person-man")!);
        const child = assetHeight(assetById("person-child")!);
        expect(man).toBeGreaterThan(1.6);
        expect(man).toBeLessThan(2);
        expect(child).toBeLessThan(man - 0.4);
        // 房间墙高 2.8m、街道比房间更宽
        expect(assetHeight(assetById("env-room")!)).toBeCloseTo(2.8, 6);
        expect(assetRadius(assetById("env-street")!)).toBeGreaterThan(assetRadius(assetById("env-room")!));
        // 环境类不画接地阴影
        expect(assetById("env-room")!.shadow).toBe("none");
    });

    it("新素材的高度与占地也合理（床/帐篷/售货机/天台）", () => {
        expect(assetHeight(assetById("prop-bed")!)).toBeGreaterThan(0.8);
        expect(assetHeight(assetById("prop-bed")!)).toBeLessThan(1.0);
        expect(assetRadius(assetById("prop-tent")!)).toBeGreaterThan(1);
        expect(assetHeight(assetById("prop-vending")!)).toBeCloseTo(1.9, 6);
        expect(assetHeight(assetById("env-rooftop")!)).toBeCloseTo(1.3, 6);
        // 地毯是平铺件：高度兜底到 0.1，且不画接地阴影
        expect(assetHeight(assetById("prop-rug")!)).toBeCloseTo(0.1, 6);
        expect(assetById("prop-rug")!.shadow).toBe("none");
        // 全目录体检：没有离谱的尺寸（把单位写错会立刻被抓出来）。
        // 人物/道具要贴近真人真物尺度，环境允许大（比如海边 14m、远景楼群 12m 高）。
        for (const asset of BUILTIN_ASSETS) {
            const isEnv = asset.kind === "env";
            expect(assetHeight(asset)).toBeLessThanOrEqual(isEnv ? 14 : 6);
            expect(assetRadius(asset)).toBeLessThanOrEqual(isEnv ? 16 : 4);
            // 平铺类（地毯/路面/海面）高度就是 0，兜底到 0.1，所以这里是 >=
            expect(assetHeight(asset)).toBeGreaterThanOrEqual(0.1);
        }
    });

    it("素材 → 物体类别映射", () => {
        expect(assetObjectKind(assetById("person-woman")!)).toBe("person");
        expect(assetObjectKind(assetById("prop-sofa")!)).toBe("prop");
        expect(assetObjectKind(assetById("env-room")!)).toBe("env");
    });
});

describe("素材与状态/提示词的衔接", () => {
    it("归一化保留 assetId，kind 支持 env", () => {
        const state = normalizeStageState({ objects: [{ id: "a", kind: "env", assetId: "env-street", name: "街道" }] });
        expect(state.objects[0]).toMatchObject({ id: "a", kind: "env", assetId: "env-street", name: "街道" });
        expect(normalizeStageState({ objects: [{ id: "b", kind: "weird" }] }).objects[0].kind).toBe("person");
    });

    it("提示词里的高度用素材的真实高度（儿童明显比成年男矮）", () => {
        const base = { id: "x", name: "人", visible: true, x: 0, z: 0, rotationYDeg: 0, scale: 1 };
        const man = objectHeight({ ...base, kind: "person", assetId: "person-man" });
        const child = objectHeight({ ...base, kind: "person", assetId: "person-child" });
        expect(man).toBeGreaterThan(child);
        // 没有 assetId 时仍按约定高度兜底
        expect(objectHeight({ ...base, kind: "person" })).toBeCloseTo(objectHeight({ ...base, kind: "person", assetId: "person-man" }), 0);
    });
});
