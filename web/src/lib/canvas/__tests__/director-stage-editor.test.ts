// 大窗口导演台的生命周期单测：不依赖 WebGL（happy-dom 里必然建不出上下文，正好顺带验证失败路径），
// 只验证「DOM 建出来 / 交互写回状态 / 关闭后不留孤儿」这些不跑浏览器也能确定的事。
import { afterEach, describe, expect, it } from "vitest";

import { closeStageEditor, isStageEditorOpen, openStageEditor } from "../../../../../plugins/canvas/director-stage/src/editor";
// eslint-disable-next-line import/first
import { createStageShot } from "../../../../../plugins/canvas/director-stage/src/motion";
// eslint-disable-next-line import/first
import { createDefaultStageState, normalizeStageState } from "../../../../../plugins/canvas/director-stage/src/stage-state";
// eslint-disable-next-line import/first
import { ASSET_INDEX_KEY, modelStorageKey } from "../../../../../plugins/canvas/director-stage/src/assets";

type Patch = Record<string, unknown>;

function makeCtx(patches: Patch[], seeded: Record<string, unknown> = {}, canvasNodes: unknown[] = []) {
    const node = { id: "stage-1", type: "director-stage:stage", title: "3D 导演台", position: { x: 0, y: 0 }, width: 480, height: 340, metadata: {} };
    return {
        node,
        updateMetadata: (patch: Patch) => {
            patches.push(patch);
            node.metadata = { ...node.metadata, ...patch } as Record<string, unknown>;
        },
        storage: { get: async (key: string) => (key in seeded ? seeded[key] : null), set: async () => {}, remove: async () => {} },
        getDownstream: () => [],
        getNodes: () => canvasNodes,
        applyOps: () => {},
        theme: {},
        scale: 1,
        isSelected: false,
    };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const overlay = () => document.body.querySelector('[data-canvas-no-zoom][tabindex="-1"]');

const buttonsIn = (root: Element | null) => Array.from(root?.querySelectorAll("button") ?? []).map((button) => button.textContent ?? "");

afterEach(() => {
    closeStageEditor("stage-1");
});

describe("导演台大窗口", () => {
    it("打开后挂在 body 上，标出编辑态，并带齐侧栏控件", () => {
        const patches: Patch[] = [];
        openStageEditor(makeCtx(patches) as never);

        const root = overlay();
        expect(root).toBeTruthy();
        expect(isStageEditorOpen("stage-1")).toBe(true);
        expect(patches.at(-1)).toMatchObject({ editorOpen: true });

        const labels = buttonsIn(root);
        expect(labels).toEqual(expect.arrayContaining(["关闭 (Esc)", "+ 添加", "+ 记录当前机位", "看全场（自由视角）", "▶ 播放运镜", "导出运镜视频 → 视频节点", "下载视频", "取消编码", "导出当前机位 → 参考图", "导出机位 A→B → 首尾帧", "导出多视图 → 参考图组", "生成运镜提示词 → 文本节点"]));
        expect(root!.textContent).toContain("运镜预演");
        // 默认状态里有一个人物，列表应有一行（名字在输入框里）
        // 只比有内容的：侧栏还有「我的模板名」「素材名」这类空文本框
        const nameInputs = (Array.from(root!.querySelectorAll("input[type=text], input:not([type])")) as HTMLInputElement[]).filter((input) => input.value);
        expect(nameInputs.map((input) => input.value)).toEqual(["人物 1"]);
        expect(root!.textContent).toContain("拖空白 = 转视角");
    });

    it("重复打开只保留一个窗口", () => {
        const patches: Patch[] = [];
        const ctx = makeCtx(patches);
        openStageEditor(ctx as never);
        openStageEditor(ctx as never);
        expect(document.body.querySelectorAll('[data-canvas-no-zoom][tabindex="-1"]').length).toBe(1);
    });

    it("没记录机位前不能播放；记录两个机位后可以播放并给出运镜描述", () => {
        const patches: Patch[] = [];
        openStageEditor(makeCtx(patches) as never);
        const find = (label: string) => Array.from(document.querySelectorAll("button")).find((button) => button.textContent === label)!;

        const play = find("▶ 播放运镜") as HTMLButtonElement;
        expect(play.disabled).toBe(true);
        // 没记机位时也不能导出运镜视频（编码前置校验 + 按钮禁用）
        expect((find("导出运镜视频 → 视频节点") as HTMLButtonElement).disabled).toBe(true);
        expect((find("下载视频") as HTMLButtonElement).disabled).toBe(true);
        // 「取消编码」只在编码中出现
        expect((find("取消编码") as HTMLButtonElement).style.display).toBe("none");
        expect(document.body.textContent).toContain("记录至少两个机位");

        find("+ 记录当前机位").click();
        // 机位名在输入框里（物体列表在前、机位列表在后）
        const nameInputs = (Array.from(document.querySelectorAll("input:not([type])")) as HTMLInputElement[]).filter((input) => input.value);
        expect(nameInputs.map((input) => input.value)).toEqual(["人物 1", "机位 1"]);
        expect(document.body.textContent).toContain("#1");
        // 只记一个机位仍然不能播放
        expect((find("▶ 播放运镜") as HTMLButtonElement).disabled).toBe(true);

        find("+ 记录当前机位").click();
        expect((find("▶ 播放运镜") as HTMLButtonElement).disabled).toBe(false);
        expect((find("导出运镜视频 → 视频节点") as HTMLButtonElement).disabled).toBe(false);
        // 两个机位是同一个机位 → 描述应是"基本不动"，而不是硬凑运动
        expect(document.body.textContent).toContain("运镜：机位基本不动");
        // 机位行上有「覆盖」与停留时长
        expect(document.body.textContent).toContain("停留 0s");
    });

    it("给物体记录走位点：与机位共用同一条时间轴", () => {
        const patches: Patch[] = [];
        openStageEditor(makeCtx(patches) as never);
        const find = (label: string) => Array.from(document.querySelectorAll("button")).find((button) => button.textContent === label)!;

        // 默认选中「人物 1」，先记第一个走位点（起点）
        find("记录走位点").click();
        expect(document.body.textContent).toContain("已记录「人物 1」的第 1 个走位点");
        expect(document.body.textContent).toContain("还需要 ≥2 个");

        // 用「横向 x」滑块把物体挪到 x=3（选中区的 4 个滑块排在最前），再记第二个点
        const sliders = Array.from(document.querySelectorAll("input[type=range]")) as HTMLInputElement[];
        sliders[0].value = "3";
        sliders[0].dispatchEvent(new Event("input"));
        find("记录走位点").click();

        expect(document.body.textContent).toContain("已记录「人物 1」的第 2 个走位点");
        expect(document.body.textContent).toContain("走位 2 个点");
        expect(document.body.textContent).toContain("会动");
        expect(document.body.textContent).toContain("#2");

        // 状态写入是防抖的，关窗会 flush —— 借此断言走位点真的进了状态
        closeStageEditor("stage-1");
        const stageState = patches.at(-1)!.stageState as { objects: Array<{ track?: Array<{ x: number; z: number }> }> };
        expect(stageState.objects[0].track).toHaveLength(2);
        expect(stageState.objects[0].track![1].x).toBeCloseTo(3, 5);
    });

    it("套用模板后可以撤销回原状态（大窗口里的 Ctrl+Z）", () => {
        const patches: Patch[] = [];
        openStageEditor(makeCtx(patches) as never);
        const find = (label: string) => Array.from(document.querySelectorAll("button")).find((button) => button.textContent === label)!;

        // 打开时撤销栈是空的
        expect((find("撤销 (⌘Z)") as HTMLButtonElement).disabled).toBe(true);

        find("套用模板").click();
        find("确认套用（会替换当前内容）").click();
        const appliedNames = (Array.from(document.querySelectorAll("input:not([type])")) as HTMLInputElement[]).map((input) => input.value);
        expect(appliedNames.length).toBeGreaterThan(3);
        expect((find("撤销 (⌘Z)") as HTMLButtonElement).disabled).toBe(false);

        find("撤销 (⌘Z)").click();
        expect(document.body.textContent).toContain("已撤销上一步");
        expect((find("撤销 (⌧Z)".replace("⌧", "⌘")) as HTMLButtonElement).disabled).toBe(true);

        closeStageEditor("stage-1");
        const flushed = patches.at(-1)!.stageState as { objects: Array<{ name: string }>; shots: unknown[] };
        expect(flushed.objects.map((object) => object.name)).toEqual(["人物 1"]);
        expect(flushed.shots).toHaveLength(0);
    });

    it("清空走位把走位点去掉", () => {
        const patches: Patch[] = [];
        openStageEditor(makeCtx(patches) as never);
        const find = (label: string) => Array.from(document.querySelectorAll("button")).find((button) => button.textContent === label)!;

        find("记录走位点").click();
        expect(document.body.textContent).toContain("第 1 个走位点");
        find("清空走位").click();
        expect(document.body.textContent).toContain("记录走位点"); // 提示回到"还没记"

        closeStageEditor("stage-1");
        const stageState = patches.at(-1)!.stageState as { objects: Array<{ track?: unknown }> };
        expect(stageState.objects[0].track).toBeUndefined();
    });

    it("场景模板：两段确认后才套用，且能切灯光", () => {
        const patches: Patch[] = [];
        openStageEditor(makeCtx(patches) as never);
        const find = (label: string) => Array.from(document.querySelectorAll("button")).find((button) => button.textContent === label)!;

        const sceneSelect = document.querySelector("select[title^='场景模板']") as HTMLSelectElement;
        expect(sceneSelect).toBeTruthy();
        expect(Array.from(sceneSelect.querySelectorAll("optgroup")).map((group) => group.label)).toEqual(["对话", "单人", "动作", "风景", "静物", "我的模板"]);
        expect(sceneSelect.value).toBe("dialogue-over-shoulder");
        expect(document.body.textContent).toContain("正反打"); // 选中模板的描述

        // 第一下只是进入确认态（套用是破坏性的）
        find("套用模板").click();
        expect(find("确认套用（会替换当前内容）")).toBeTruthy();
        // 第二下才真的套用：物体列表换成模板内容
        find("确认套用（会替换当前内容）").click();
        const names = (Array.from(document.querySelectorAll("input:not([type])")) as HTMLInputElement[]).map((input) => input.value);
        expect(names).toContain("女主");
        expect(names).toContain("沙发");
        expect(document.body.textContent).toContain("已套用模板");

        // 灯光预设可切换
        const lightingSelect = document.querySelector("select[title^='灯光预设']") as HTMLSelectElement;
        expect(lightingSelect).toBeTruthy();
        lightingSelect.value = "night";
        lightingSelect.dispatchEvent(new Event("change"));
        expect(document.body.textContent).toContain("灯光切到「夜晚」");
    });

    it("「看全场」切换自由视角并说明现状", () => {
        const patches: Patch[] = [];
        openStageEditor(makeCtx(patches) as never);
        const find = (label: string) => Array.from(document.querySelectorAll("button")).find((button) => button.textContent === label)!;

        find("看全场（自由视角）").click();
        expect(find("回到当前机位")).toBeTruthy();
        expect(document.body.textContent).toContain("自由视角中");

        find("回到当前机位").click();
        expect(find("看全场（自由视角）")).toBeTruthy();
        expect(document.body.textContent).not.toContain("自由视角中");
    });

    it("「切到」才把镜头切到那台机位；点相机元素只负责选中（不钻进相机）", () => {
        const patches: Patch[] = [];
        const ctx = makeCtx(patches);
        const base = createDefaultStageState();
        // 预置两个机位，让列表行渲染出来
        ctx.node.metadata = {
            stageState: {
                ...base,
                shots: [createStageShot({ ...base.camera, azimuthDeg: 120, distance: 3 }, "反打"), createStageShot({ ...base.camera, azimuthDeg: 20, focalMm: 85 }, "过肩")],
            },
        };
        openStageEditor(ctx as never);

        const switches = () => Array.from(document.querySelectorAll("button")).filter((button) => button.textContent === "切到");
        expect(switches()).toHaveLength(2);

        switches()[1].click();
        expect(document.body.textContent).toContain("已切到「过肩」当镜头");
        closeStageEditor("stage-1");
        const flushed = patches.at(-1)!.stageState as { camera: { azimuthDeg: number; focalMm: number } };
        // 当前机位变成了第 2 台（不是第 1 台）
        expect(flushed.camera.azimuthDeg).toBe(20);
        expect(flushed.camera.focalMm).toBe(85);
    });

    it("「我的素材」：导入过的模型能直接添加（复用库里那份字节）", async () => {
        const patches: Patch[] = [];
        const ctx = makeCtx(patches, {
            [ASSET_INDEX_KEY]: [{ id: "m1", name: "hero.glb", size: 2048, addedAt: 1 }],
            [modelStorageKey("m1")]: { name: "hero.glb", base64: "AAAA" },
        });
        openStageEditor(ctx as never);
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(Array.from(document.querySelectorAll("optgroup")).map((group) => group.label)).toContain("我的素材（1）");
        const assetSelect = Array.from(document.querySelectorAll("select")).find((item) => (item.getAttribute("title") ?? "").startsWith("内置素材库")) as HTMLSelectElement;
        assetSelect.value = "mine:m1";
        assetSelect.dispatchEvent(new Event("change"));
        Array.from(document.querySelectorAll("button")).find((button) => button.textContent === "+ 添加")!.click();
        await flush();

        closeStageEditor("stage-1");
        const flushed = patches.at(-1)!.stageState as { objects: Array<{ kind: string; modelKey?: string; sourceName?: string }> };
        expect(flushed.objects.at(-1)).toMatchObject({ kind: "model", modelKey: "m1", sourceName: "hero.glb" });
    });

    it("「我的模板」：存当前场景 → 套用回来走位不丢 → 清单同步给 Agent", async () => {
        const patches: Patch[] = [];
        const ctx = makeCtx(patches);
        ctx.node.metadata = {
            stageState: normalizeStageState({
                ...createDefaultStageState(),
                objects: [{ id: "o1", name: "甲", kind: "person", x: 0, z: 0, rotationYDeg: 0, scale: 1, visible: true, track: [{ x: 0, z: 0, rotationYDeg: 0, holdMs: 0 }, { x: 3, z: 1, rotationYDeg: 90, holdMs: 0 }] }],
            }),
        };
        openStageEditor(ctx as never);
        const find = (label: string) => Array.from(document.querySelectorAll("button")).find((button) => button.textContent === label)!;
        const sceneSelect = document.querySelectorAll("select")[0] as HTMLSelectElement;
        const pick = (value: string) => {
            sceneSelect.value = value;
            sceneSelect.dispatchEvent(new Event("change"));
        };

        find("存为我的模板").click();
        await flush();
        const mineId = Array.from(sceneSelect.querySelectorAll("option")).map((option) => option.value).find((value) => value.startsWith("mine-"));
        expect(mineId).toBeTruthy();
        // 清单写进 metadata：Agent / 技能据此按 id 套用
        expect(patches.some((patch) => Array.isArray(patch.stageTemplateIds) && (patch.stageTemplateIds as unknown[]).length === 1)).toBe(true);

        // 先套一个内置模板把内容（含走位）冲掉，再套回「我的模板」
        pick((sceneSelect.querySelectorAll("option")[0] as HTMLOptionElement).value);
        find("套用模板").click();
        find("确认套用（会替换当前内容）").click();
        pick(mineId!);
        find("套用模板").click();
        find("确认套用（会替换当前内容）").click();

        closeStageEditor("stage-1");
        const flushed = patches.at(-1)!.stageState as { objects: Array<{ name: string; track?: unknown[] }> };
        expect(flushed.objects.find((object) => object.name === "甲")?.track).toHaveLength(2);
    });

    it("背景板：把画布上的图片节点设为场景背景，能清除", () => {
        const patches: Patch[] = [];
        const imageNode = { id: "img-1", type: "image", title: "夜街空镜", position: { x: 0, y: 0 }, width: 320, height: 180, metadata: { content: "blob:fake-plate", naturalWidth: 1280, naturalHeight: 720 } };
        const ctx = makeCtx(patches, {}, [imageNode]);
        openStageEditor(ctx as never);
        const find = (label: string) => Array.from(document.querySelectorAll("button")).find((button) => button.textContent === label) as HTMLButtonElement;

        const backdropSelect = document.querySelector("select[title^='背景板']") as HTMLSelectElement;
        expect(Array.from(backdropSelect.querySelectorAll("option")).map((option) => option.textContent)).toEqual(["夜街空镜"]);
        backdropSelect.value = "img-1";
        find("设为背景板").click();
        expect(document.body.textContent).toContain("背景板：「夜街空镜」");
        // 状态是防抖写回的：关窗会立即 flush
        closeStageEditor("stage-1");
        expect(patches.at(-1)!.stageState).toMatchObject({ backdrop: { nodeId: "img-1", title: "夜街空镜" } });

        // 重新打开（状态已带背景板）→ 清除
        openStageEditor(ctx as never);
        expect(document.body.textContent).toContain("背景板：「夜街空镜」");
        Array.from(document.querySelectorAll("button")).find((button) => button.textContent === "清除背景板")!.click();
        expect(document.body.textContent).toContain("已清除背景板");
        closeStageEditor("stage-1");
        expect((patches.at(-1)!.stageState as { backdrop?: unknown }).backdrop).toBeUndefined();
    });

    it("背景板：图还没生成出来时明确提示", () => {
        const patches: Patch[] = [];
        const imageNode = { id: "img-2", type: "image", title: "生成中的空镜", position: { x: 0, y: 0 }, width: 320, height: 180, metadata: {} };
        const ctx = makeCtx(patches, {}, [imageNode]);
        ctx.node.metadata = { stageState: { ...createDefaultStageState(), backdrop: { nodeId: "img-2", title: "生成中的空镜" } } };
        openStageEditor(ctx as never);
        expect(document.body.textContent).toContain("还没有画面");
    });

    it("侧栏加人物会写回状态；关闭时 flush 掉待写的状态并留一张预览字段", () => {
        const patches: Patch[] = [];
        openStageEditor(makeCtx(patches) as never);

        // 素材库下拉：默认第一项是成年男
        const assetSelect = document.querySelector("select[title^='内置素材库']") as HTMLSelectElement;
        expect(assetSelect).toBeTruthy();
        expect(Array.from(assetSelect.querySelectorAll("optgroup")).map((group) => group.label)).toEqual(["人物", "家具", "街道", "户外", "环境", "我的素材"]);
        expect(assetSelect.value).toBe("person-man");

        const add = Array.from(document.querySelectorAll("button")).find((button) => button.textContent === "+ 添加")!;
        add.click();

        closeStageEditor("stage-1");
        expect(overlay()).toBeNull();
        expect(isStageEditorOpen("stage-1")).toBe(false);

        const last = patches.at(-1)!;
        expect(last).toMatchObject({ editorOpen: false });
        const stageState = last.stageState as { objects: Array<{ name: string; assetId?: string }> };
        // 默认场景里是「人物 1」，点「+ 添加」加进来的是素材名（默认第一项：成年男）
        expect(stageState.objects.map((object) => object.name)).toEqual(["人物 1", "成年男"]);
        expect(stageState.objects[1].assetId).toBe("person-man");
        // happy-dom 建不出 WebGL 上下文，所以拿不到预览图 —— 但不该崩，也不该塞脏数据
        expect(last.previewContent).toBeUndefined();
    });
});
