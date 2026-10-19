import { describe, expect, it } from "vitest";

import i18n from "@/i18n";
import {
    MAX_ASSISTANT_SOURCE_CHARS,
    appendOptimizedTextSlot,
    applyOptimizedText,
    buildNodeOutputRequest,
    buildPromptAssistantRequest,
    cleanOptimizedPrompt,
    readNodeText,
    resolveSkillProduces,
    assistantOutputSummaryText,
    resolveWorkflowConstraint,
    revertOptimizedTextSlot,
    summarizeAssistantOutput,
} from "@/lib/canvas/canvas-prompt-assistant";
import { BUILTIN_PROMPT_SKILLS, promptSkillInstruction, promptSkillOutputContract, promptSkillProduces } from "@/lib/canvas/prompt-skills";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

function textNode(content: string, extra: Partial<CanvasNodeData["metadata"]> = {}): CanvasNodeData {
    return {
        id: "t1",
        type: CanvasNodeType.Text,
        title: "t1",
        position: { x: 0, y: 0 },
        width: 340,
        height: 240,
        metadata: { content, status: "success", fontSize: 14, ...extra },
    };
}

describe("prompt-skills", () => {
    it("has unique ids and no missing instruction text", () => {
        const ids = BUILTIN_PROMPT_SKILLS.map((skill) => skill.id);
        expect(new Set(ids).size).toBe(ids.length);
        ids.forEach((id) => {
            expect(promptSkillInstruction(id)).toBeTruthy();
            expect(promptSkillInstruction(id)).not.toBe(`canvas.promptAssistant.skillInstructions.${id}`);
        });
    });

    it("marks the image-reverse skill as needing an image", () => {
        expect(BUILTIN_PROMPT_SKILLS.find((skill) => skill.id === "prompt-from-image")?.needsImage).toBe(true);
    });

    it("declares a produces form for every skill and keeps them consistent", () => {
        BUILTIN_PROMPT_SKILLS.forEach((skill) => expect(["inline", "nodes"]).toContain(skill.produces));
        expect(promptSkillProduces("novel-deconstruct")).toBe("nodes");
        expect(promptSkillProduces("storyboard")).toBe("nodes");
        expect(promptSkillProduces("prompt-image")).toBe("inline");
        expect(promptSkillProduces("prompt-video-minimax")).toBe("inline");
    });
});

describe("resolveSkillProduces", () => {
    const base = { backend: "agent" as const, skill: { kind: "builtin" as const, id: "prompt-polish" as const } };

    it("follows the builtin declaration by default", () => {
        expect(resolveSkillProduces(base)).toBe("inline");
        expect(resolveSkillProduces({ ...base, skill: { kind: "builtin", id: "novel-deconstruct" } })).toBe("nodes");
    });

    it("treats a runtime agent skill as node output by default", () => {
        expect(resolveSkillProduces({ ...base, skill: { kind: "agent", name: "novel-deconstruct", path: "/tmp/x" } })).toBe("nodes");
    });
});

describe("buildNodeOutputRequest", () => {
    it("carries the canvas-operating contract, the source and the one-line result contract", () => {
        const { prompt, truncated } = buildNodeOutputRequest({
            config: { backend: "agent", skill: { kind: "builtin", id: "novel-deconstruct" } },
            nodeId: "t1",
            nodeTitle: "第一章",
            nodeText: "他推开门，雨还在下。",
            chapterLabel: "当前是第 1 章。",
        });

        expect(truncated).toBe(false);
        expect(prompt).toContain(promptSkillInstruction("novel-deconstruct"));
        expect(prompt).toContain("t1");
        expect(prompt).toContain("canvas_create_text_nodes");
        expect(prompt).toContain("canvas_select_nodes");
        expect(prompt).toContain("当前是第 1 章。");
        expect(prompt).toContain("他推开门");
        expect(prompt).toContain(i18n.t("canvas.promptAssistant.nodeOutputResultContract"));
    });

    it("truncates an oversized source", () => {
        const { truncated } = buildNodeOutputRequest({ config: { backend: "agent", skill: { kind: "builtin", id: "novel-deconstruct" } }, nodeId: "t1", nodeTitle: "t", nodeText: "字".repeat(MAX_ASSISTANT_SOURCE_CHARS + 10) });
        expect(truncated).toBe(true);
    });
});

describe("summarizeAssistantOutput", () => {
    const textNode = (id: string) => ({ id, type: CanvasNodeType.Text, title: id, position: { x: 0, y: 0 }, width: 10, height: 10, metadata: {} });
    const groupNode = (id: string) => ({ id, type: CanvasNodeType.Group, title: id, position: { x: 0, y: 0 }, width: 10, height: 10, metadata: {} });
    const before = { nodes: [textNode("old")], connections: [{ id: "c0", fromNodeId: "old", toNodeId: "old", kind: "input" as const }] };

    it("counts only newly added nodes and connections", () => {
        const after = {
            nodes: [textNode("old"), textNode("n1"), textNode("n2"), groupNode("g1")],
            connections: [...before.connections, { id: "c1", fromNodeId: "n1", toNodeId: "g1", kind: "input" as const }],
        };
        const summary = summarizeAssistantOutput(before, after);
        expect(summary).toMatchObject({ addedNodes: 3, addedTextNodes: 2, addedGroups: 1, addedConnections: 1 });
        expect(summary.addedIds).toEqual(["n1", "n2", "g1"]);
    });

    it("counts nodes that are neither text nor group as other", () => {
        const stageNode = { id: "s1", type: "director-stage:stage", title: "s1", position: { x: 0, y: 0 }, width: 10, height: 10, metadata: {} } as unknown as CanvasNodeData;
        const summary = summarizeAssistantOutput(before, { nodes: [...before.nodes, stageNode], connections: before.connections });
        expect(summary).toMatchObject({ addedNodes: 1, addedTextNodes: 0, addedGroups: 0, addedOtherNodes: 1, addedConnections: 0 });
    });

    it("reports nothing when the agent only edited existing nodes", () => {
        const summary = summarizeAssistantOutput(before, { nodes: [{ ...textNode("old"), title: "renamed" }], connections: before.connections });
        expect(summary).toMatchObject({ addedNodes: 0, addedTextNodes: 0, addedGroups: 0, addedConnections: 0 });
    });
});

describe("buildPromptAssistantRequest", () => {
    const config = { backend: "comfyui" as const, skill: { kind: "builtin" as const, id: "prompt-polish" as const } };

    it("orders skill → extra instruction → workflow constraint → context → contract → source", () => {
        const { prompt, truncated } = buildPromptAssistantRequest({
            config: { ...config, instruction: "更电影感" },
            nodeText: "一只猫",
            workflowConstraint: "会作为「文生图」工作流的输入。",
            contextBlock: "参考图 1：一只橘猫",
        });

        expect(truncated).toBe(false);
        const order = [promptSkillInstruction("prompt-polish"), "更电影感", "文生图", "参考图 1", i18n.t("canvas.promptAssistant.outputContract"), "一只猫"];
        let cursor = -1;
        order.forEach((fragment) => {
            const index = prompt.indexOf(fragment);
            expect(index).toBeGreaterThan(cursor);
            cursor = index;
        });
    });

    it("omits empty blocks instead of leaving blank sections", () => {
        const { prompt } = buildPromptAssistantRequest({ config, nodeText: "一只猫" });
        expect(prompt).toContain("一只猫");
        expect(prompt).not.toContain(i18n.t("canvas.promptAssistant.constraintTarget", { category: "" }));
    });

    it("keeps head and tail when the source is too long", () => {
        const source = `${"头".repeat(MAX_ASSISTANT_SOURCE_CHARS)}尾巴`;
        const { prompt, truncated } = buildPromptAssistantRequest({ config, nodeText: source });
        expect(truncated).toBe(true);
        expect(prompt).toContain(i18n.t("canvas.promptAssistant.truncatedMarker"));
        expect(prompt).toContain("尾巴");
        // 头 60% + 尾 40%：原文整段不再出现，但两端都保留。
        expect(prompt).not.toContain("头".repeat(MAX_ASSISTANT_SOURCE_CHARS));
        expect(prompt).toContain("头".repeat(Math.floor(MAX_ASSISTANT_SOURCE_CHARS * 0.6)));
    });
});

describe("resolveWorkflowConstraint", () => {
    it("returns nothing without a category so optimizing never blocks", () => {
        expect(resolveWorkflowConstraint(undefined, ["prompt"])).toBe("");
        expect(resolveWorkflowConstraint("t2i", [])).toContain("文生图");
    });

    it("names the category, lists slots and asks for the right shape", () => {
        const frame = resolveWorkflowConstraint("frameVideo", ["prompt", "first_frame", "last_frame", "output_video"]);
        expect(frame).toContain("首尾帧");
        expect(frame).toContain("first_frame");
        expect(frame).toContain(i18n.t("canvas.promptAssistant.shapeFrameVideo"));

        const inpaint = resolveWorkflowConstraint("inpaint", ["prompt", "ref_image_01", "ref_mask"]);
        expect(inpaint).toContain(i18n.t("canvas.promptAssistant.shapeInpaint"));
    });

    it("caps the slot list so the constraint stays readable", () => {
        const slots = ["prompt", ...Array.from({ length: 12 }, (_, index) => `ref_image_${String(index + 1).padStart(2, "0")}`)];
        const constraint = resolveWorkflowConstraint("i2i", slots);
        expect(constraint).toContain("ref_image_08");
        expect(constraint).not.toContain("ref_image_09");
    });
});

describe("optimized text write-back", () => {
    it("appends a slot, promotes it to primary and keeps content in sync", () => {
        const node = textNode("原文", { texts: [{ id: "s0", status: "success", content: "原文" }], primaryTextId: "s0" });
        const { slotId, texts } = appendOptimizedTextSlot(node);
        expect(texts).toHaveLength(2);

        const patch = applyOptimizedText({ ...node, metadata: { ...node.metadata, texts } }, slotId, "优化后的提示词");
        expect(patch.primaryTextId).toBe(slotId);
        expect(patch.content).toBe("优化后的提示词");
        expect(patch.texts?.find((slot) => slot.id === slotId)?.content).toBe("优化后的提示词");
        // 原文仍在备选里，可星标切回。
        expect(patch.texts?.find((slot) => slot.id === "s0")?.content).toBe("原文");
    });

    it("restores the original when the run is cancelled or fails", () => {
        const node = textNode("原文", { texts: [{ id: "s0", status: "success", content: "原文" }], primaryTextId: "s0" });
        const { slotId, texts } = appendOptimizedTextSlot(node);
        const streaming = { ...node, metadata: { ...node.metadata, ...applyOptimizedText(node, slotId, "半截") } };
        const reverted = revertOptimizedTextSlot({ ...streaming, metadata: { ...streaming.metadata, texts } }, slotId);

        expect(reverted.primaryTextId).toBe("s0");
        expect(reverted.content).toBe("原文");
        expect(reverted.texts).toHaveLength(1);
        expect(reverted.texts?.[0].id).toBe("s0");
    });

    it("reads the primary slot first, then falls back to legacy content", () => {
        expect(readNodeText(textNode("legacy"))).toBe("legacy");
        expect(readNodeText(textNode("legacy", { texts: [{ id: "s0", status: "success", content: " 主文本 " }], primaryTextId: "s0" }))).toBe("主文本");
        expect(readNodeText({ ...textNode("x"), type: CanvasNodeType.Image })).toBe("");
    });
});

describe("cleanOptimizedPrompt", () => {
    it("strips code fences and leading labels", () => {
        expect(cleanOptimizedPrompt("```\n一只猫，电影感\n```")).toBe("一只猫，电影感");
        expect(cleanOptimizedPrompt("优化后的提示词：一只猫")).toBe("一只猫");
        expect(cleanOptimizedPrompt("Prompt: a cat")).toBe("a cat");
        expect(cleanOptimizedPrompt("  一只猫  ")).toBe("一只猫");
    });
});

describe("previz skill", () => {
    it("is registered as a nodes skill with its own canvas contract", () => {
        expect(promptSkillProduces("director-stage-scene")).toBe("nodes");
        expect(promptSkillOutputContract("director-stage-scene")).toBeTruthy();
        // 其它 nodes 技能没有专属契约 -> 回退通用契约
        expect(promptSkillOutputContract("storyboard")).toBeUndefined();
        expect(promptSkillOutputContract("novel-deconstruct")).toBeUndefined();
    });

    it("tells the agent to build a director-stage node instead of text cards", () => {
        const { prompt } = buildNodeOutputRequest({
            config: { backend: "agent", skill: { kind: "builtin", id: "director-stage-scene" } },
            nodeId: "t1",
            nodeTitle: "夜街",
            nodeText: "深夜街头，男的靠着路灯抽烟，女的从远处走近，镜头低角度慢慢推上去",
        });
        expect(prompt).toContain("canvas_director_stage");
        expect(prompt).toContain("exportMode: current");
        expect(prompt).toContain("3D 导演台");
        // 通用契约（建文本卡 + 打组）必须被专属契约替换掉
        expect(prompt).not.toContain("建文本卡（一条一个主体");
        expect(prompt).not.toContain("metadata.groupId");
        expect(prompt).toContain("深夜街头");
    });

    it("keeps the generic contract for the other nodes skills", () => {
        const { prompt } = buildNodeOutputRequest({
            config: { backend: "agent", skill: { kind: "builtin", id: "storyboard" } },
            nodeId: "t1",
            nodeTitle: "剧本",
            nodeText: "第一场：夜，街头。",
        });
        expect(prompt).toContain("canvas_create_text_nodes");
        expect(prompt).not.toContain("canvas_director_stage");
    });
});

describe("assistantOutputSummaryText", () => {
    it("keeps the original wording when the batch has no other nodes", () => {
        const text = assistantOutputSummaryText({ addedNodes: 3, addedTextNodes: 2, addedGroups: 1, addedOtherNodes: 0, addedConnections: 1 });
        expect(text).toBe(i18n.t("canvas.promptAssistant.nodesDone", { nodes: 3, text: 2, groups: 1, connections: 1 }));
    });

    it("appends the other-nodes segment for a director-stage build", () => {
        const text = assistantOutputSummaryText({ addedNodes: 2, addedTextNodes: 0, addedGroups: 0, addedOtherNodes: 2, addedConnections: 0 });
        expect(text).toContain(i18n.t("canvas.promptAssistant.nodesDoneOther", { others: 2 }));
    });
});
