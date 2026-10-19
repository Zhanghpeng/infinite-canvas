// 3D 导演台自检：把「这一镜拍得对不对」变成确定性问题清单（Agent 与用户看的是同一份）。
import { describe, expect, it } from "vitest";

// eslint-disable-next-line import/first
import { checkScene, formatSceneCheck } from "../../../../../plugins/canvas/director-stage/src/check";
// eslint-disable-next-line import/first
import { createDefaultStageState, createStageObject, type StageCamera, type StageObject, type StageState } from "../../../../../plugins/canvas/director-stage/src/stage-state";
// eslint-disable-next-line import/first
import { createStageShot } from "../../../../../plugins/canvas/director-stage/src/motion";

const DEFAULT_CAMERA: StageCamera = createDefaultStageState().camera;

function state(overrides: Partial<StageState>): StageState {
    return { ...createDefaultStageState(), ...overrides };
}

function person(name: string, x: number, z: number, extra: Partial<StageObject> = {}): StageObject {
    return { ...createStageObject("person", name, x, z), ...extra };
}

const codes = (issues: ReturnType<typeof checkScene>["issues"]) => issues.map((issue) => issue.code);

describe("checkScene", () => {
    it("默认场景（一个人物 + 默认机位）没有 error", () => {
        const check = checkScene(createDefaultStageState());
        expect(check.ok).toBe(true);
        expect(check.subjects).toBe(1);
        expect(check.moving).toBe(false);
    });

    it("没有可见主体时报 no-subject，且不再刷其它检查项", () => {
        const empty = checkScene(state({ objects: [] }));
        expect(empty.ok).toBe(false);
        expect(codes(empty.issues)).toEqual(["no-subject"]);

        // 只有道具与环境不算主体
        const propsOnly = checkScene(state({ objects: [createStageObject("prop", "桌子", 0, 0), createStageObject("env", "房间", 0, 0)] }));
        expect(codes(propsOnly.issues)).toEqual(["no-subject"]);
        expect(propsOnly.subjects).toBe(0);

        // 隐藏的人物也不算
        const hidden = checkScene(state({ objects: [person("女主", 0, 0, { visible: false })] }));
        expect(codes(hidden.issues)).toEqual(["no-subject"]);
    });

    it("当前机位下主体出画是 error", () => {
        const check = checkScene(state({ objects: [person("女主", 40, 0)] }));
        expect(check.ok).toBe(false);
        expect(codes(check.issues)).toContain("out-of-frame");
        expect(check.issues[0].level).toBe("error");
        expect(check.issues[0].text).toContain("女主");
    });

    it("主体太小 / 太大只提醒（warn）", () => {
        const small = checkScene(state({ objects: [person("小孩", 0, 0, { assetId: "person-child" })], camera: { ...DEFAULT_CAMERA, distance: 12, focalMm: 8 } }));
        expect(codes(small.issues)).toContain("too-small");
        expect(small.ok).toBe(true);

        // 长焦贴近：主体中心正对视线（targetY = 人物中心），所以先撞到"太大"而不是"出画"
        const large = checkScene(state({ camera: { ...DEFAULT_CAMERA, distance: 2, focalMm: 300, targetY: 0.875 } }));
        expect(codes(large.issues)).toContain("too-large");
        expect(large.ok).toBe(true);
    });

    it("某个关键帧机位里出画只提醒，并指名是哪个机位", () => {
        const camera = { ...DEFAULT_CAMERA, distance: 2, focalMm: 35 };
        const check = checkScene(state({ objects: [person("女主", 3, 0)], camera: { ...DEFAULT_CAMERA, distance: 12, focalMm: 8 }, shots: [createStageShot(camera, "近景反打")] }));
        expect(codes(check.issues)).toContain("shot-out-of-frame");
        const issue = check.issues.find((item) => item.code === "shot-out-of-frame");
        expect(issue?.level).toBe("warn");
        expect(issue?.text).toContain("近景反打");
        expect(check.shots).toBe(1);
    });

    it("机位贴脸与两个物体重叠都提醒", () => {
        const close = checkScene(state({ camera: { ...DEFAULT_CAMERA, distance: 0.8 } }));
        expect(codes(close.issues)).toContain("too-close");

        const overlapped = checkScene(state({ objects: [person("甲", 1, 1), person("乙", 1.1, 1.05)] }));
        const overlap = overlapped.issues.find((item) => item.code === "overlap");
        expect(overlap?.text).toContain("甲");
        expect(overlap?.text).toContain("乙");
    });

    it("走位过程中出画带上时间与原因，并标记 moving", () => {
        const check = checkScene(
            state({
                objects: [
                    person("女主", 0, 0, {
                        track: [
                            { x: 0, z: 0, rotationYDeg: 0, holdMs: 0 },
                            { x: -12, z: 0, rotationYDeg: 0, holdMs: 0 },
                        ],
                    }),
                ],
            }),
        );
        expect(check.moving).toBe(true);
        const track = check.issues.filter((item) => item.code === "track");
        expect(track.length).toBe(1);
        expect(track[0].level).toBe("warn");
        expect(track[0].text).toContain("走位出画");
    });
});

describe("formatSceneCheck", () => {
    it("通过时给出摘要与 ✓", () => {
        const text = formatSceneCheck(checkScene(createDefaultStageState()));
        expect(text).toContain("1 个主体");
        expect(text).toContain("✓ 没发现问题");
    });

    it("有问题时按级别标记，并截断多余条目", () => {
        const check = checkScene(
            state({
                objects: [person("女主", 40, 0), person("甲", 1, 1), person("乙", 1.05, 1.05)],
            }),
        );
        const text = formatSceneCheck(check, 1);
        expect(text).toContain("✗");
        expect(text).toMatch(/还有 \d+ 条/);
        expect(text).not.toContain("\n✗ ✗");
    });
});
