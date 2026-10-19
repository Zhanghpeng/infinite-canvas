// 命令通道：协议校验 + 幂等 + 卡片真的会执行（这条锁住"任何客户端写一条 metadata 指令就能驱动插件"）。
import { act } from "react";
import React from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// 插件 SDK 的 hooks 是转发到宿主 React 的（globalThis.InfiniteCanvasRuntime），单测里自己注入一份
beforeEach(() => {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    (globalThis as unknown as { InfiniteCanvasRuntime?: unknown }).InfiniteCanvasRuntime = {
        React,
        jsx: React.createElement,
        Fragment: React.Fragment,
        version: "test",
        emit: () => undefined,
        on: () => () => undefined,
        injectCSS: () => () => undefined,
    };
});

afterEach(() => {
    delete (globalThis as unknown as { InfiniteCanvasRuntime?: unknown }).InfiniteCanvasRuntime;
});

// eslint-disable-next-line import/first
import { pendingStageCommand, readStageCheck, readStageCommand, STAGE_CHECK_KEY, STAGE_COMMAND_ACK_KEY } from "../../../../../plugins/canvas/director-stage/src/commands";
// eslint-disable-next-line import/first
import { StageCard } from "../../../../../plugins/canvas/director-stage/src/index";
// eslint-disable-next-line import/first
import { TEMPLATE_STORE_KEY, stageStateToTemplate } from "../../../../../plugins/canvas/director-stage/src/templates";
// eslint-disable-next-line import/first
import { createDefaultStageState, normalizeStageState } from "../../../../../plugins/canvas/director-stage/src/stage-state";

type Patch = Record<string, unknown>;

function makeCtx(metadata: Patch = {}, patches: Patch[] = [], seeded: Patch = {}) {
    const node = { id: "stage-1", type: "director-stage:stage", title: "3D 导演台", position: { x: 0, y: 0 }, width: 480, height: 340, metadata };
    const ctx = {
        node,
        updateMetadata: (patch: Patch) => {
            patches.push(patch);
            node.metadata = { ...node.metadata, ...patch };
        },
        storage: { get: async (key: string) => (key in seeded ? seeded[key] : null), set: async () => undefined, remove: async () => undefined },
        getDownstream: () => [],
        getNodes: () => [node],
        applyOps: () => undefined,
        theme: {},
        scale: 1,
        isSelected: false,
    };
    return { ctx, node, patches };
}

const flush = async () => {
    await act(async () => {
        await Promise.resolve();
    });
};

describe("命令协议", () => {
    it("校验：合法命令解析出来，缺 id / 类型不对一律当没有", () => {
        expect(readStageCommand(undefined)).toBeNull();
        expect(readStageCommand({})).toBeNull();
        expect(readStageCommand({ directorStageCommand: { type: "applyScene", sceneId: "x" } })).toBeNull(); // 缺 id
        expect(readStageCommand({ directorStageCommand: { id: "c1", type: "applyScene" } })).toBeNull(); // 缺 sceneId
        expect(readStageCommand({ directorStageCommand: { id: "c1", type: "setLighting", lighting: "nope" } })).toBeNull();
        expect(readStageCommand({ directorStageCommand: { id: "c1", type: "export", mode: "nope" } })).toBeNull();
        expect(readStageCommand({ directorStageCommand: { id: "c1", type: "applyScene", sceneId: "seaside-lookout" } })).toEqual({ id: "c1", type: "applyScene", sceneId: "seaside-lookout" });
        expect(readStageCommand({ directorStageCommand: { id: "c2", type: "export", mode: "video" } })).toEqual({ id: "c2", type: "export", mode: "video" });
        expect(readStageCommand({ directorStageCommand: { id: "c3", type: "check" } })).toEqual({ id: "c3", type: "check" });
    });

    it("幂等：回执等于命令 id 就不再执行", () => {
        const metadata = { directorStageCommand: { id: "c1", type: "setLighting", lighting: "night" } };
        expect(pendingStageCommand(metadata as never)?.id).toBe("c1");
        expect(pendingStageCommand({ ...metadata, [STAGE_COMMAND_ACK_KEY]: "c1" } as never)).toBeNull();
        // 新 id 又来一条，继续执行
        expect(pendingStageCommand({ ...metadata, directorStageCommand: { id: "c2", type: "setLighting", lighting: "night" } } as never)?.id).toBe("c2");
    });
});

describe("卡片执行命令", () => {
    it("applyScene：套用模板并把回执写回 metadata", async () => {
        const { ctx, node, patches } = makeCtx({ directorStageCommand: { id: "cmd-1", type: "applyScene", sceneId: "seaside-lookout" } });
        const container = document.createElement("div");
        document.body.appendChild(container);
        const root = createRoot(container);
        await act(async () => {
            root.render(React.createElement(StageCard, { ctx } as never));
        });
        await flush();

        const applied = patches.find((patch) => patch.stageState)?.stageState as { objects: Array<{ name: string }>; lighting: string; shots: unknown[] } | undefined;
        expect(applied).toBeTruthy();
        expect(applied!.objects.map((object) => object.name)).toContain("男");
        expect(applied!.lighting).toBe("backlit");
        expect(applied!.shots).toHaveLength(2);
        expect(patches.at(-1)).toMatchObject({ [STAGE_COMMAND_ACK_KEY]: "cmd-1" });

        await act(async () => {
            root.unmount();
        });
        container.remove();
    });

    it("applyScene：内置模板没命中时套用「我的模板」（按 sceneId 走用户模板 id）", async () => {
        const tracked = normalizeStageState({
            ...createDefaultStageState(),
            objects: [{ id: "o1", name: "甲", kind: "person", x: 0, z: 0, rotationYDeg: 0, scale: 1, visible: true, track: [{ x: 0, z: 0, rotationYDeg: 0, holdMs: 0 }, { x: 3, z: 1, rotationYDeg: 90, holdMs: 0 }] }],
        });
        const template = stageStateToTemplate(tracked, "我的夜戏", "mine-1");
        const { ctx, patches } = makeCtx({ directorStageCommand: { id: "cmd-mine", type: "applyScene", sceneId: "mine-1" } }, [], { [TEMPLATE_STORE_KEY]: [template] });
        const container = document.createElement("div");
        document.body.appendChild(container);
        const root = createRoot(container);
        await act(async () => {
            root.render(React.createElement(StageCard, { ctx } as never));
        });
        await flush();

        const applied = patches.find((patch) => patch.stageState)?.stageState as { objects: Array<{ name: string; track?: unknown[] }> } | undefined;
        expect(applied?.objects.find((object) => object.name === "甲")?.track).toHaveLength(2);
        expect(patches.at(-1)).toMatchObject({ [STAGE_COMMAND_ACK_KEY]: "cmd-mine" });

        // 内置模板照旧优先
        const builtin = makeCtx({ directorStageCommand: { id: "cmd-builtin", type: "applyScene", sceneId: "seaside-lookout" } });
        const container2 = document.createElement("div");
        document.body.appendChild(container2);
        const root2 = createRoot(container2);
        await act(async () => {
            root2.render(React.createElement(StageCard, { ctx: builtin.ctx } as never));
        });
        await flush();
        expect((builtin.patches.find((patch) => patch.stageState)?.stageState as { lighting: string } | undefined)?.lighting).toBe("backlit");

        await act(async () => {
            root.unmount();
        });
        container.remove();
        await act(async () => {
            root2.unmount();
        });
        container2.remove();
    });

    it("check：算出几何自检报告写回 metadata，并回执", async () => {
        const { ctx, node, patches } = makeCtx({ directorStageCommand: { id: "cmd-check", type: "check" } });
        const container = document.createElement("div");
        document.body.appendChild(container);
        const root = createRoot(container);
        await act(async () => {
            root.render(React.createElement(StageCard, { ctx } as never));
        });
        await flush();

        const report = patches.find((patch) => patch[STAGE_CHECK_KEY])?.[STAGE_CHECK_KEY] as { commandId: string; ok: boolean; text: string; issues: unknown[] } | undefined;
        expect(report?.commandId).toBe("cmd-check");
        expect(report?.ok).toBe(true);
        expect(report?.text).toContain("自检");
        expect(Array.isArray(report?.issues)).toBe(true);
        expect(patches.at(-1)).toMatchObject({ [STAGE_COMMAND_ACK_KEY]: "cmd-check" });
        // 写回的报告本身是合法的（readStageCheck 校验通过）
        expect(readStageCheck(node.metadata)).toMatchObject({ commandId: "cmd-check", ok: true });

        await act(async () => {
            root.unmount();
        });
        container.remove();
    });

    it("readStageCheck：形状不对一律当没有", () => {
        expect(readStageCheck(undefined)).toBeNull();
        expect(readStageCheck({})).toBeNull();
        expect(readStageCheck({ [STAGE_CHECK_KEY]: { commandId: "c", ok: true } })).toBeNull(); // 缺 text / issues
        expect(readStageCheck({ [STAGE_CHECK_KEY]: { commandId: "c", ok: true, text: "t", issues: [{ level: "nope", code: "x", text: "y" }] } })).toBeNull();
        expect(readStageCheck({ [STAGE_CHECK_KEY]: { commandId: "c", ok: false, subjects: 2, shots: 1, moving: true, text: "t", issues: [{ level: "error", code: "out-of-frame", text: "y" }] } })).toMatchObject({ ok: false, subjects: 2, moving: true });
    });

    it("setLighting：只改灯光；非法 sceneId 不崩、也要回执", async () => {
        const { ctx, patches } = makeCtx({ directorStageCommand: { id: "cmd-2", type: "setLighting", lighting: "night" } });
        const container = document.createElement("div");
        document.body.appendChild(container);
        const root = createRoot(container);
        await act(async () => {
            root.render(React.createElement(StageCard, { ctx } as never));
        });
        await flush();
        const patch = patches.find((item) => item.stageState)?.stageState as { lighting: string } | undefined;
        expect(patch?.lighting).toBe("night");

        await act(async () => {
            root.unmount();
        });
        container.remove();

        // 未知模板：不抛错、照样回执（否则会永远重试）
        const second = makeCtx({ directorStageCommand: { id: "cmd-3", type: "applyScene", sceneId: "nope" } });
        const container2 = document.createElement("div");
        document.body.appendChild(container2);
        const root2 = createRoot(container2);
        await act(async () => {
            root2.render(React.createElement(StageCard, { ctx: second.ctx } as never));
        });
        await flush();
        expect(second.patches.some((item) => item.stageState)).toBe(false);
        expect(second.patches.at(-1)).toMatchObject({ [STAGE_COMMAND_ACK_KEY]: "cmd-3" });
        await act(async () => {
            root2.unmount();
        });
        container2.remove();
    });
});
