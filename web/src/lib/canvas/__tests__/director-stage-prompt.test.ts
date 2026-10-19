// 3D 导演台插件（plugins/canvas/director-stage）纯逻辑单测。
// 插件本身没有测试运行器，这里直接引用它「无依赖」的纯模块（prompt.ts / stage-state.ts），
// 既覆盖「状态 → 提示词」的确定性拼接，也不给插件构建链路增加额外负担。
import { describe, expect, it } from "vitest";

import { buildDirectorPrompt, describeMotion, describePlacement, frameFit, frameWarnings } from "../../../../../plugins/canvas/director-stage/src/prompt";
import { createStageShot, createDefaultStageState, DEFAULT_CAMERA, DEFAULT_MOTION, normalizeStageState, stageStateSummary, type StageCamera, type StageObject, type StageState } from "../../../../../plugins/canvas/director-stage/src/stage-state";

const person = (id: string, name: string, x: number, z: number, rotationYDeg = 0): StageObject => ({ id, name, kind: "person", visible: true, x, z, rotationYDeg, scale: 1 });

const stageState = (objects: StageObject[], extra: Partial<StageState> = {}): StageState => ({
    objects,
    camera: { ...DEFAULT_CAMERA },
    shots: [],
    motion: { ...DEFAULT_MOTION },
    lighting: "day",
    exportFormat: "jpeg",
    exportHeight: 720,
    promptLocale: "zh",
    ...extra,
});

describe("director-stage 提示词拼接", () => {
    // 一台默认机位（方位 35°/仰角 14°/距离 5.2m/焦距 35mm）看两个人：一个站原点面向镜头，一个在右前方背对。
    const twoPeople = stageState([person("a", "人物 1", 0, 0, 0), person("b", "人物 2", 0.6, 2.4, 200)]);

    it("场景 + 机位 + 无 B 机位时降级为固定机位", () => {
        expect(buildDirectorPrompt(twoPeople, "zh")).toBe(
            [
                "场景关系：",
                "- 人物 1（人物）：画面中央·远景，约 5.0m，面向镜头",
                "- 人物 2（人物）：画面左侧·中景，约 2.9m，背对镜头",
                "关系：",
                "- 人物 1 ↔ 人物 2：相距 2.5m，人物 2在人物 1正前方，双方均面向对方",
                "构图：",
                "- 人物 1：约占画面高度 1/2，居中",
                "- 人物 2：约占画面高度 9/10，偏左",
                "机位：全景，平视（仰角 14°），距主体约 5.2m，等效 35mm（垂直视场角 38°），视线高度 0.95m。",
                "运镜：固定机位，画面内只有人物动作。",
            ].join("\n"),
        );
    });

    it("同样状态重复拼接结果完全一致", () => {
        expect(buildDirectorPrompt(twoPeople, "zh")).toBe(buildDirectorPrompt(twoPeople, "zh"));
        expect(buildDirectorPrompt(twoPeople, "zh")).toBe(buildDirectorPrompt(stageState([person("a", "人物 1", 0, 0, 0), person("b", "人物 2", 0.6, 2.4, 200)]), "zh"));
    });

    it("两个机位的差异翻成运镜，并补一句首尾帧说明", () => {
        const withShots = stageState(twoPeople.objects, { shots: [createStageShot({ ...DEFAULT_CAMERA }, "机位 1"), createStageShot({ ...DEFAULT_CAMERA, distance: 3.4 }, "机位 2")] });
        const prompt = buildDirectorPrompt(withShots, "zh");
        // 运镜现在带时间范围（视频模型更吃这种形式）
        expect(prompt).toContain("运镜：0.0s→3.0s 推近（dolly-in）。全程约 3.0s，节奏缓慢均匀。");
        expect(prompt).toContain("（首帧为第 1 个机位画面，尾帧为最后一个机位画面，请保持人物外观与场景一致。）");
    });

    it("多段运镜按顺序串起来，并带上停留时间", () => {
        const triple = stageState(twoPeople.objects, {
            shots: [
                createStageShot({ ...DEFAULT_CAMERA, distance: 6 }, "过肩", 500),
                createStageShot({ ...DEFAULT_CAMERA, distance: 3.4 }, "推近", 0),
                createStageShot({ ...DEFAULT_CAMERA, distance: 3.4, elevationDeg: 45 }, "抬高", 0),
            ],
        });
        const prompt = buildDirectorPrompt(triple, "zh");
        // 500ms 的停留会被写成独立时间段，两段运镜各自带时间范围
        expect(prompt).toContain("0.0s→0.5s 停留");
        expect(prompt).toContain("0.5s→1.8s 推近（dolly-in）");
        expect(prompt).toContain("1.8s→3.0s 镜头抬高（crane up）");
    });

    it("只有一个机位时退化成固定机位描述", () => {
        const one = stageState(twoPeople.objects, { shots: [createStageShot({ ...DEFAULT_CAMERA }, "机位 1")] });
        expect(buildDirectorPrompt(one, "zh")).toContain("运镜：固定机位，画面内只有人物动作。");
    });

    it("机位不动时不硬凑运动", () => {
        const same = { ...DEFAULT_CAMERA };
        expect(describeMotion(same, { ...same }, "zh")).toBe("运镜：机位基本不动，轻微手持呼吸感。");
        expect(describeMotion(same, { ...same, distance: 3.4 }, "zh")).toContain("推近（dolly-in）");
        expect(describeMotion(same, { ...same, distance: 7.4 }, "zh")).toContain("拉远（dolly-out）");
        expect(describeMotion(same, { ...same, azimuthDeg: 95 }, "zh")).toContain("向右环绕（orbit right）");
    });

    it("朝向按旋转角分成面向 / 侧对 / 背对镜头", () => {
        const facing = (rotationYDeg: number) => describePlacement(person("a", "人物 1", 0, 0, rotationYDeg), DEFAULT_CAMERA).facing;
        expect(facing(0)).toBe("面向镜头");
        expect(facing(125)).toBe("侧对镜头");
        expect(facing(200)).toBe("背对镜头");
    });

    it("英文产物用英文标签", () => {
        const prompt = buildDirectorPrompt(twoPeople, "en");
        expect(prompt).toContain("Scene layout:");
        expect(prompt).toContain("- 人物 1 (person): centre background, ~5.0m away, facing camera");
        expect(prompt).toContain("Camera: wide shot, eye level");
        expect(prompt).toContain("Camera motion: locked-off shot");
    });

    it("没有可⻅主体时明确说明场景为空", () => {
        const hidden = stageState([{ ...person("a", "人物 1", 0, 0), visible: false }]);
        expect(buildDirectorPrompt(hidden, "zh")).toContain("场景：暂无人物或道具。");
    });
});

describe("director-stage 关系与构图描述", () => {
    /** 相机在 +Z 正对原点：z 越大离相机越近。 */
    const frontal = { azimuthDeg: 0, elevationDeg: 8, distance: 5.2, targetY: 0.95, focalMm: 35 };

    it("前后站且横向对齐时报遮挡（近似判断）", () => {
        const state = stageState([person("a", "男主", 0, 2.2, 180), person("b", "女主", 0.1, 0, 0)], { camera: { ...frontal } });
        const prompt = buildDirectorPrompt(state, "zh");
        expect(prompt).toContain("女主在男主正前方");
        expect(prompt).toContain("双方均面向对方");
        expect(prompt).toContain("男主大致挡住女主");
    });

    it("横向错开时不报遮挡（两人并排站着不该说互相遮挡）", () => {
        const state = stageState([person("a", "甲", -2.6, 1, 0), person("b", "乙", 2.6, 1, 0)], { camera: { ...frontal } });
        expect(buildDirectorPrompt(state, "zh")).not.toContain("大致挡住");
    });

    it("朝向不一时逐人说明（谁看谁、谁背对谁）", () => {
        const state = stageState([person("a", "男主", 0, 2.2, 0), person("b", "女主", 0, 0, 0)], { camera: { ...frontal } });
        const prompt = buildDirectorPrompt(state, "zh");
        expect(prompt).toContain("男主背对对方、女主面向对方");
    });

    it("构图给出占画面高度与左右位置", () => {
        const state = stageState([person("a", "近景路人", 2.6, 2.6, 0), person("b", "远处路人", -2.6, -1.6, 0)], { camera: { ...frontal } });
        const prompt = buildDirectorPrompt(state, "zh");
        expect(prompt).toContain("构图：");
        expect(prompt).toMatch(/- 近景路人：约占画面高度 [\d/]+，偏右/);
        expect(prompt).toMatch(/- 远处路人：约占画面高度 [\d/]+，偏左/);
    });

    it("只有一个人物时不输出关系段（避免自说自话）", () => {
        const one = stageState([person("a", "独行者", 0, 0, 0)], { camera: { ...frontal } });
        const prompt = buildDirectorPrompt(one, "zh");
        expect(prompt).toContain("构图：");
        expect(prompt).not.toContain("↔");
    });
});

describe("director-stage 状态归一化", () => {
    it("坏数据回落到默认（一个人物）", () => {
        expect(normalizeStageState(null).objects).toHaveLength(1);
        expect(normalizeStageState({ objects: "nope" }).objects).toHaveLength(1);
        expect(normalizeStageState(createDefaultStageState()).objects).toHaveLength(1);
    });

    it("物体缺 id 时补一个而不是丢掉（外部手写 metadata 少字段不能把节点清空）", () => {
        const state = normalizeStageState({ objects: [{ name: "无 id 的人", kind: "person", x: 1.5, z: -2 }] });
        expect(state.objects).toHaveLength(1);
        expect(state.objects[0].id).toMatch(/^obj-recovered-/);
        expect(state.objects[0]).toMatchObject({ name: "无 id 的人", kind: "person", x: 1.5, z: -2 });
        // 只剩脏项时也不用默认场景兜底（数组给了就以数组为准）
        expect(normalizeStageState({ objects: [{ name: "a" }, null, "x"] }).objects).toHaveLength(1);
    });

    it("保留合法字段、纠正越界枚举", () => {
        const state = normalizeStageState({
            objects: [{ id: "x", name: "女主", kind: "weird", x: "1.5", z: -2, rotationYDeg: "30", scale: 0 }],
            camera: { focalMm: 85 },
            exportFormat: "webp",
            exportHeight: 1080,
            promptLocale: "jp",
        });
        expect(state.objects).toHaveLength(1);
        expect(state.objects[0]).toMatchObject({ id: "x", name: "女主", kind: "person", visible: true, x: 1.5, z: -2, rotationYDeg: 30, scale: 1 });
        expect(state.camera.focalMm).toBe(85);
        expect(state.camera.azimuthDeg).toBe(DEFAULT_CAMERA.azimuthDeg);
        expect(state.exportFormat).toBe("jpeg");
        expect(state.exportHeight).toBe(1080);
        expect(state.promptLocale).toBe("zh");
    });

    it("摘要只留轻量字段（不塞大对象）", () => {
        const summary = stageStateSummary(normalizeStageState({ objects: [{ id: "x" }], cameraA: { focalMm: 50 } }));
        // 顺带验证旧数据迁移：只有 cameraA 时也会变成 1 个机位
        expect(summary).toEqual({ objects: 1, focalMm: 35, shots: 1, hasMove: false });
        expect(Object.keys(summary)).toHaveLength(4);
    });
});

describe("director-stage 相机换算", () => {
    it("焦距 → 垂直视场角单调递减", () => {
        const asCamera = (focalMm: number): StageCamera => ({ ...DEFAULT_CAMERA, focalMm });
        const wide = describePlacement(person("a", "人物 1", 0, 0), asCamera(24)).facing;
        expect(wide).toBe("面向镜头");
        expect(buildDirectorPrompt(stageState([person("a", "人物 1", 0, 0)]), "zh")).toContain("等效 35mm（垂直视场角 38°）");
    });
});

describe("环境类素材", () => {
    const frontal = { azimuthDeg: 0, elevationDeg: 8, distance: 5.2, targetY: 0.95, focalMm: 35 };

    it("环境单独一行，不参与关系与构图（房间不该写成「面向镜头」）", () => {
        const state = stageState(
            [
                person("a", "女主", 0, 1.2, 180),
                { id: "room", name: "房间（6m）", kind: "env", visible: true, x: 0, z: 0, rotationYDeg: 0, scale: 1, assetId: "env-room" },
            ],
            { camera: { ...frontal } },
        );
        const prompt = buildDirectorPrompt(state, "zh");
        expect(prompt).toContain("环境：房间（6m）");
        // 环境不写景别/朝向，也不进构图段
        expect(prompt).not.toContain("房间（6m）（环境）");
        expect(prompt.split("构图：")[1] ?? "").not.toContain("房间");
        expect(prompt).toContain("女主");
    });

    it("只有环境时明确说明还没有主体", () => {
        const state = stageState([{ id: "room", name: "房间（6m）", kind: "env", visible: true, x: 0, z: 0, rotationYDeg: 0, scale: 1, assetId: "env-room" }]);
        expect(buildDirectorPrompt(state, "zh")).toContain("只有环境");
    });
});

describe("道具在描述里的角色", () => {
    const frontal = { azimuthDeg: 0, elevationDeg: 6, distance: 6.4, targetY: 1.25, focalMm: 35 };
    const prop = (id: string, name: string, x: number, z: number) => ({ id, name, kind: "prop" as const, visible: true, x, z, rotationYDeg: 0, scale: 1 });

    it("道具不写朝向、道具之间不写关系、构图只算人物", () => {
        const state = stageState([person("a", "甲", 0, 1.4, 180), person("b", "乙", 0, -1.4, 0), prop("lamp", "路灯", -2.4, 1.4), prop("lamp2", "路灯 2", 2.4, -1.4)], {
            camera: { ...frontal },
        });
        const prompt = buildDirectorPrompt(state, "zh");

        // 道具行只给位置与景别，没有编造出来的朝向
        expect(prompt).toContain("- 路灯（道具）：画面");
        expect(prompt).not.toMatch(/路灯（道具）：[^\n]*(面向|侧对|背对)镜头/);
        // 道具与道具之间不写关系（真实数据里出现过「路灯 ↔ 路灯 2：双方均侧对对方」这种噪音）
        expect(prompt).not.toContain("路灯 ↔ 路灯 2");
        // 人物与最近道具的关系保留，但只说方位与距离
        expect(prompt).toMatch(/- 甲 ↔ 路灯：相距 [\d.]+m，路灯在甲[^\n]*$/m);
        // 构图段只算人物
        const framing = prompt.split("构图：")[1] ?? "";
        expect(framing).toContain("甲");
        expect(framing).toContain("乙");
        expect(framing).not.toContain("路灯");
    });

    it("人物之间的朝向照旧写全", () => {
        const state = stageState([person("a", "甲", 0, 1.4, 180), person("b", "乙", 0, -1.4, 0)], { camera: { ...frontal } });
        expect(buildDirectorPrompt(state, "zh")).toMatch(/甲 ↔ 乙：相距 2.8m，乙在甲正前方，/);
    });
});

describe("表演段（人物走位的时间化描述）", () => {
    const frontal = { azimuthDeg: 0, elevationDeg: 10, distance: 5, targetY: 1.1, focalMm: 50 };
    const walker = (track: Array<{ x: number; z: number; rotationYDeg: number; holdMs: number }>) => ({ ...person("a", "女主", -2.6, 1.2, 90), track });
    const stander = person("b", "男主", 0.6, 0.6, 180);

    it("逐段给出时间范围、位移与转向", () => {
        const state = stageState([walker([{ x: -2.6, z: 1.2, rotationYDeg: 90, holdMs: 0 }, { x: -0.2, z: 0.5, rotationYDeg: 90, holdMs: 1000 }, { x: -0.2, z: 0.5, rotationYDeg: 186, holdMs: 0 }]), stander], {
            camera: { ...frontal },
            motion: { durationMs: 4000, fps: 24, easing: "easeInOut" },
        });
        const prompt = buildDirectorPrompt(state, "zh");
        expect(prompt).toContain("表演：");
        expect(prompt).toMatch(/- 女主：0\.0s→[\d.]+s 从画面.+走到画面.+（约 2\.5m）/);
        expect(prompt).toContain("原地停留");
        // 只转身不位移的段落写成「原地转身」，不再写「从 A 走到 A（约 0.0m）」
        expect(prompt).toContain("原地转身，转向背对镜头");
        expect(prompt).not.toContain("（约 0.0m）");
        // 没走位的人物单独说明保持原位
        expect(prompt).toContain("（其余人物保持原位：男主）");
    });

    it("没有走位时不输出表演段", () => {
        const state = stageState([person("a", "女主", 0, 0, 0), stander], { camera: { ...frontal } });
        expect(buildDirectorPrompt(state, "zh")).not.toContain("表演：");
    });

    it("英文产物也带时间范围", () => {
        const state = stageState([walker([{ x: -2.6, z: 1.2, rotationYDeg: 90, holdMs: 0 }, { x: -0.2, z: 0.5, rotationYDeg: 90, holdMs: 0 }])], {
            camera: { ...frontal },
            motion: { durationMs: 3000, fps: 24, easing: "linear" },
        });
        const prompt = buildDirectorPrompt(state, "en");
        expect(prompt).toContain("Performance:");
        expect(prompt).toMatch(/- 女主: 0\.0s→[\d.]+s walk from .+ to .+ \(~[\d.]+m\)/);
    });
});

describe("出画判定与预警", () => {
    const frontal = { azimuthDeg: 0, elevationDeg: 8, distance: 5, targetY: 1.1, focalMm: 50 };

    it("在画面里 / 横向出画 / 不在镜头前方", () => {
        const subject = person("a", "甲", 0, 0, 0);
        expect(frameFit(subject, { ...frontal }).inFrame).toBe(true);
        expect(frameFit({ ...subject, x: 12 }, { ...frontal })).toMatchObject({ inFrame: false, reason: "横向出画" });
        // 站到相机背后
        expect(frameFit({ ...subject, z: 12 }, { ...frontal })).toMatchObject({ inFrame: false, reason: "不在镜头前方" });
    });

    it("广角比长焦更不容易出画", () => {
        const subject = { ...person("a", "甲", 2.2, 0, 0) };
        expect(frameFit(subject, { ...frontal, focalMm: 24 }).inFrame).toBe(true);
        expect(frameFit(subject, { ...frontal, focalMm: 135 }).reason).toBe("横向出画");
    });

    // 回归：纵向判定的"相机上方向"必须真正垂直于视线。之前用了一个符号混错的交叉积，
    // 相机一俯仰 + 长焦时 dot(to, up) 不为 0，会假报"纵向出画"（长焦特写必现）。
    it("长焦 + 俯仰角下，正对视线目标的主体不会被误判纵向出画", () => {
        for (const focalMm of [50, 135, 300]) {
            for (const elevationDeg of [0, 14, 40, 70]) {
                const camera = { azimuthDeg: 35, elevationDeg, distance: 2.5, targetY: 0.875, focalMm };
                // 主体中心（0, 0.875, 0）就是视线目标，必然在画面正中
                expect(frameFit(person("a", "甲", 0, 0, 0), camera).inFrame).toBe(true);
            }
        }
    });

    it("预警给出首次出画的时间点，不出画就不报", () => {
        const walkOut = { ...person("a", "甲", -1, 0, 0), track: [{ x: -1, z: 0, rotationYDeg: 0, holdMs: 0 }, { x: 12, z: 0, rotationYDeg: 0, holdMs: 0 }] };
        const warnings = frameWarnings(stageState([walkOut], { camera: { ...frontal }, motion: { durationMs: 4000, fps: 24, easing: "linear" } }), 24);
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toMatch(/^\d+\.\ds 起「甲」横向出画$/);

        const walkIn = { ...person("a", "甲", -1, 0, 0), track: [{ x: -1, z: 0, rotationYDeg: 0, holdMs: 0 }, { x: 1, z: 0, rotationYDeg: 0, holdMs: 0 }] };
        expect(frameWarnings(stageState([walkIn], { camera: { ...frontal }, motion: { durationMs: 4000, fps: 24, easing: "linear" } }), 24)).toHaveLength(0);
        // 没有走位的静止人物不参与预警
        expect(frameWarnings(stageState([person("a", "甲", 0, 0, 0)], { camera: { ...frontal } }), 24)).toHaveLength(0);
    });
});
