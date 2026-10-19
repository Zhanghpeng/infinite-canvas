import assert from "node:assert/strict";
import { test } from "node:test";

import { buildCanvasToolRequest } from "./operations.js";

function opsOf(name: Parameters<typeof buildCanvasToolRequest>[0], input: Record<string, unknown>, state: Parameters<typeof buildCanvasToolRequest>[2] = null) {
    const request = buildCanvasToolRequest(name, input, state);
    return (request.input as { ops: Array<Record<string, any>> }).ops;
}

test("generation flow reuses referenced nodes when the prompt only mentions them", () => {
    const ops = opsOf("canvas_generate_image", { prompt: "@[node:text-1]", referenceNodeIds: ["text-1"], title: "Flow", autoRun: true });
    const addedTextNodes = ops.filter((op) => op.type === "add_node" && op.nodeType === "text");
    const config = ops.find((op) => op.type === "add_node" && op.nodeType === "config");
    const runs = ops.filter((op) => op.type === "run_generation");
    assert.equal(addedTextNodes.length, 0);
    assert.equal(ops.filter((op) => op.type === "connect_nodes" && op.fromNodeId === "text-1" && String(op.toNodeId).startsWith("config-")).length, 1);
    assert.match(String(config?.metadata?.prompt), /^@\[node:text-1\]$/);
    assert.equal(runs.length, 1);
});

test("generation flow still creates a prompt node for prose prompts", () => {
    const ops = opsOf("canvas_generate_image", { prompt: "a cat on a roof", referenceNodeIds: ["text-1"], autoRun: true });
    assert.equal(ops.filter((op) => op.type === "add_node" && op.nodeType === "text").length, 1);
    const config = ops.find((op) => op.type === "add_node" && op.nodeType === "config");
    assert.match(String(config?.metadata?.prompt), /@\[node:text-/);
});

test("canvas_generate_audio synchronously throws unsupported ComfyUI audio error", () => {
    assert.throws(
        () => buildCanvasToolRequest("canvas_generate_audio", { prompt: "some audio prompt" }, null),
        /当前项目尚未支持 ComfyUI 音频生成/,
    );
});

test("canvas_generate_image still produces run_generation", () => {
    const ops = opsOf("canvas_generate_image", { prompt: "a dog", autoRun: true });
    assert.ok(ops.some((op) => op.type === "run_generation"));
});

test("canvas_director_stage 建导演台节点并把摆位归一化", () => {
    const ops = opsOf("canvas_director_stage", {
        title: "对手戏",
        objects: [
            { name: "女主", x: -1.2, z: 1.4, rotationYDeg: 200 },
            { name: "男主", kind: "prop", x: 999, z: 0.4, scale: 0.01 },
        ],
        camera: { azimuthDeg: 500, focalMm: 50 },
        motion: { durationMs: 999999, fps: 3 },
    });

    const add = ops.find((op) => op.type === "add_node");
    assert.equal(add?.nodeType, "director-stage:stage");
    assert.equal(add?.title, "对手戏");
    const state = add?.metadata?.stageState as Record<string, any>;
    assert.equal(state.objects.length, 2);
    // 角度归一化到 (-180,180]：200° 等价于 -160°（夹成 180 会静默改朝向）
    assert.deepEqual(state.objects[0], { id: "agent-obj-1", name: "女主", kind: "person", visible: true, x: -1.2, z: 1.4, rotationYDeg: -160, scale: 1 });
    // 越界值被夹住：x 999 → 12、scale 0.01 → 0.2、方位角 500 → 140
    assert.equal(state.objects[1].x, 12);
    assert.equal(state.objects[1].scale, 0.2);
    assert.equal(state.objects[1].kind, "prop");
    assert.equal(state.camera.azimuthDeg, 140);
    assert.equal(state.camera.focalMm, 50);
    // 默认值补齐
    assert.equal(state.camera.elevationDeg, 14);
    assert.equal(state.motion.durationMs, 20000);
    assert.equal(state.motion.fps, 6);
    assert.equal(state.motion.easing, "easeInOut");
});

test("canvas_director_stage 传 nodeId 时只更新指定字段，其余沿用节点上原有的 stageState", () => {
    const snapshot = {
        nodes: [
            {
                id: "stage-1",
                type: "director-stage:stage" as const,
                position: { x: 0, y: 0 },
                width: 480,
                height: 340,
                metadata: { stageState: { objects: [{ id: "keep-me" }], camera: { focalMm: 85 }, promptLocale: "en" } },
            },
        ],
        connections: [],
    };
    const ops = opsOf("canvas_director_stage", { nodeId: "stage-1", motion: { fps: 30, durationMs: 5000 } }, snapshot);

    assert.equal(ops.length, 1);
    assert.equal(ops[0].type, "update_node");
    assert.equal(ops[0].id, "stage-1");
    const state = ops[0].metadata?.stageState as Record<string, any>;
    assert.deepEqual(state.objects, [{ id: "keep-me" }]);
    assert.deepEqual(state.camera, { focalMm: 85 });
    assert.equal(state.promptLocale, "en");
    assert.deepEqual(state.motion, { durationMs: 5000, fps: 30, easing: "easeInOut" });
});

test("canvas_director_stage 写 shots 时清掉旧的 cameraA/cameraB，避免两套机位并存", () => {
    const ops = opsOf("canvas_director_stage", {
        shots: [
            { name: "过肩", camera: { azimuthDeg: 20, focalMm: 50 }, holdMs: 400 },
            { name: "正面", camera: { azimuthDeg: 0, distance: 3.4 } },
        ],
    });
    const state = ops.find((op) => op.type === "add_node")?.metadata?.stageState as Record<string, any>;
    assert.equal(state.shots.length, 2);
    assert.equal(state.shots[0].holdMs, 400);
    assert.deepEqual(state.shots[1].camera, { azimuthDeg: 0, elevationDeg: 14, distance: 3.4, targetY: 0.95, focalMm: 35 });
    assert.equal(state.cameraA, undefined);
    assert.equal(state.cameraB, undefined);
});

test("canvas_director_stage 支持内置素材与环境类", () => {
    const ops = opsOf("canvas_director_stage", {
        objects: [
            { name: "女主", assetId: "person-woman", x: -1, z: 1 },
            { name: "房间", kind: "env", assetId: "env-room" },
            { name: "", assetId: "" },
        ],
    });
    const state = ops.find((op) => op.type === "add_node")?.metadata?.stageState as Record<string, any>;
    assert.equal(state.objects[0].assetId, "person-woman");
    assert.equal(state.objects[0].kind, "person");
    assert.equal(state.objects[1].kind, "env");
    assert.equal(state.objects[1].name, "房间");
    // 空字符串的 assetId 不写进去
    assert.equal(state.objects[2].assetId, undefined);
});

test("canvas_director_stage 支持人物走位（track）并归一化", () => {
    const ops = opsOf("canvas_director_stage", {
        objects: [
            { name: "女主", assetId: "person-woman", track: [ { x: -2.6, z: 1.2, rotationYDeg: 200, holdMs: 0 }, { x: 99, z: 0.5, holdMs: 9999 } ] },
            { name: "男主" },
        ],
    });
    const objects = ops.find((op) => op.type === "add_node").metadata.stageState.objects;
    assert.equal(objects[0].track.length, 2);
    assert.deepEqual(objects[0].track[0], { x: -2.6, z: 1.2, rotationYDeg: -160, holdMs: 0 });
    assert.deepEqual(objects[0].track[1], { x: 12, z: 0.5, rotationYDeg: 0, holdMs: 5000 });
    assert.equal(objects[1].track, undefined);
});

test("canvas_director_stage 支持背景板：backdropNodeId 写进 stageState.backdrop，空串清除", () => {
    const snapshot = {
        nodes: [
            {
                id: "stage-1",
                type: "director-stage:stage",
                title: "导演台",
                position: { x: 0, y: 0 },
                width: 480,
                height: 340,
                metadata: { stageState: { objects: [{ id: "keep-me" }], backdrop: { nodeId: "old-img" } } },
            },
        ],
        connections: [],
    };
    const set = opsOf("canvas_director_stage", { nodeId: "stage-1", backdropNodeId: "img-1" }, snapshot);
    assert.equal(set.length, 1);
    assert.deepEqual(set[0].metadata.stageState.backdrop, { nodeId: "img-1" });
    // 其它字段照旧保留
    assert.deepEqual(set[0].metadata.stageState.objects, [{ id: "keep-me" }]);

    const cleared = opsOf("canvas_director_stage", { nodeId: "stage-1", backdropNodeId: "" }, snapshot);
    assert.equal(cleared[0].metadata.stageState.backdrop, undefined);
    // hideEnvironment=false 才写进去（默认 true 不落字段，与插件归一化一致）
    const noHide = opsOf("canvas_director_stage", { nodeId: "stage-1", backdropNodeId: "img-2", backdropHideEnvironment: false }, snapshot);
    assert.deepEqual(noHide[0].metadata.stageState.backdrop, { nodeId: "img-2", hideEnvironment: false });
    // 不传就不动背景板
    const untouched = opsOf("canvas_director_stage", { nodeId: "stage-1", motion: { fps: 30 } }, snapshot);
    assert.deepEqual(untouched[0].metadata.stageState.backdrop, { nodeId: "old-img" });
});

test("canvas_director_stage 传 sceneId / exportMode 时只写指令给插件", () => {
    const apply = opsOf("canvas_director_stage", { nodeId: "stage-1", sceneId: "seaside-lookout" });
    assert.equal(apply.length, 1);
    assert.equal(apply[0].type, "update_node");
    assert.equal(apply[0].id, "stage-1");
    assert.equal(apply[0].metadata.directorStageCommand.type, "applyScene");
    assert.equal(apply[0].metadata.directorStageCommand.sceneId, "seaside-lookout");
    assert.match(apply[0].metadata.directorStageCommand.id, /^stage-cmd-/);
    // 传指令时不该顺手改 stageState（模板由插件展开）
    assert.equal(apply[0].metadata.stageState, undefined);

    const exported = opsOf("canvas_director_stage", { nodeId: "stage-1", exportMode: "video" });
    assert.deepEqual(exported[0].metadata.directorStageCommand.type, "export");
    assert.equal(exported[0].metadata.directorStageCommand.mode, "video");

    // 没给 nodeId 时新建一个带指令的导演台节点
    const created = opsOf("canvas_director_stage", { sceneId: "group-pan", title: "群像" });
    assert.equal(created[0].type, "add_node");
    assert.equal(created[0].nodeType, "director-stage:stage");
    assert.equal(created[0].metadata.directorStageCommand.sceneId, "group-pan");
});

test("canvas_director_stage 传 check 时只写自检指令，缺 nodeId 明确报错", () => {
    const apply = opsOf("canvas_director_stage", { nodeId: "stage-1", check: true });
    assert.equal(apply.length, 1);
    assert.equal(apply[0].type, "update_node");
    assert.equal(apply[0].metadata.directorStageCommand.type, "check");
    assert.match(apply[0].metadata.directorStageCommand.id, /^stage-cmd-/);
    // 自检不改 stageState，也要清掉旧回执（否则插件认为已经执行过）
    assert.equal(apply[0].metadata.stageState, undefined);
    assert.equal(apply[0].metadata.directorStageCommandAck, undefined);

    // 自检必须有节点可查：没给 nodeId 时不要凭空建空节点
    assert.throws(() => opsOf("canvas_director_stage", { check: true }), /check 需要 nodeId/);

    // 一次调用只发一条指令：sceneId 优先于 check
    const both = opsOf("canvas_director_stage", { nodeId: "stage-1", sceneId: "group-pan", check: true });
    assert.equal(both[0].metadata.directorStageCommand.type, "applyScene");
});
