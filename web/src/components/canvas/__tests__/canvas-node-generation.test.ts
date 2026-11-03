import { describe, expect, it } from "vitest";

import i18n from "@/i18n";
import {
    CanvasNodeType,
    type CanvasConnection,
    type CanvasNodeData,
    type CanvasNodeMetadata,
    type CanvasNodeTypeId,
} from "@/types/canvas";

import { buildNodeGenerationContext } from "../canvas-node-generation";

const DATA_IMG = "data:image/png;base64,AA==";

function makeNode(
    id: string,
    type: CanvasNodeTypeId,
    metadata: CanvasNodeMetadata = {},
    title = id,
): CanvasNodeData {
    return {
        id,
        type,
        title,
        position: { x: 0, y: 0 },
        width: 100,
        height: 100,
        metadata,
    };
}

function input(from: string, to: string): CanvasConnection {
    return { id: `${from}->${to}`, fromNodeId: from, toNodeId: to, kind: "input" };
}

describe("buildNodeGenerationContext", () => {
    it("replaces only @[node:<id>] tokens, leaving plain node titles and Chinese label text untouched", () => {
        const textNode = makeNode("t1", CanvasNodeType.Text, { content: "这是中文说明" }, "节点标题");
        const imageNode = makeNode("img1", CanvasNodeType.Image, {
            content: DATA_IMG,
            mimeType: "image/png",
        }, "参考图片");
        const source = makeNode("out", CanvasNodeType.Image);
        const nodes = [textNode, imageNode, source];
        const connections = [input("t1", "out"), input("img1", "out")];
        const imageLabel = "<Picture 1>";

        const ctx = buildNodeGenerationContext(
            "out",
            nodes,
            connections,
            "保留 节点标题 与 这是中文说明 原文，替换 @[node:img1] 与 @[node:t1]",
        );

        expect(ctx.prompt).toBe(`保留 节点标题 与 这是中文说明 原文，替换 ${imageLabel} 与 这是中文说明`);
        expect(ctx.prompt).not.toContain("@[node:");
        expect(ctx.textCount).toBe(1);
        expect(ctx.imageCount).toBe(1);
        expect(ctx.referenceImages).toHaveLength(1);
        expect(ctx.referenceImages[0]?.dataUrl).toBe(DATA_IMG);
        expect(ctx.generationReferences.map((ref) => ref.nodeId)).toEqual(["t1", "img1"]);
    });

    it("throws the resourceMissing error synchronously when a token points to a nonexistent node", () => {
        const source = makeNode("out", CanvasNodeType.Image);
        const missingId = "ghost";

        expect(() =>
            buildNodeGenerationContext("out", [source], [], `引用 @[node:${missingId}]`),
        ).toThrow(i18n.t("agent.composer.mentions.resourceMissing", { title: missingId }));
    });

    it("throws the resourceMissing error synchronously when a token points to an existing but unconnected node", () => {
        const unconnected = makeNode(
            "t1",
            CanvasNodeType.Text,
            { content: "未被连接的文本" },
            "未连接文本",
        );
        const source = makeNode("out", CanvasNodeType.Image);

        expect(() =>
            buildNodeGenerationContext("out", [unconnected, source], [], "引用 @[node:t1]"),
        ).toThrow(i18n.t("agent.composer.mentions.resourceMissing", { title: "未连接文本" }));
    });

    it("with composerContent: submits only explicitly token-selected media and dedupes repeated references while keeping the label at every occurrence", () => {
        const img1 = makeNode("img1", CanvasNodeType.Image, {
            content: DATA_IMG,
            mimeType: "image/png",
        });
        const img2 = makeNode("img2", CanvasNodeType.Image, {
            content: DATA_IMG,
            mimeType: "image/png",
        });
        // Connected but never referenced by a token: must not be submitted.
        const unselected = makeNode("img3", CanvasNodeType.Image, {
            content: DATA_IMG,
            mimeType: "image/png",
        });
        const composerContent = "用 @[node:img1] 和 @[node:img2] 以及再次 @[node:img1] 生成";
        const config = makeNode("cfg", CanvasNodeType.Config, { composerContent });
        const nodes = [img1, img2, unselected, config];
        const connections = [input("img1", "cfg"), input("img2", "cfg"), input("img3", "cfg")];

        const ctx = buildNodeGenerationContext("cfg", nodes, connections, composerContent);

        const label1 = "<Picture 1>";
        const label2 = "<Picture 2>";
        expect(ctx.prompt).toBe(`用 ${label1} 和 ${label2} 以及再次 ${label1} 生成`);
        // img1 is referenced twice in the prompt but appears only once as a reference.
        expect(ctx.referenceImages).toHaveLength(2);
        expect(ctx.referenceImages.map((image) => image.id)).toEqual(["img1", "img2"]);
        expect(ctx.referenceImages[0]?.dataUrl).toBe(DATA_IMG);
        expect(ctx.imageCount).toBe(2);
        expect(ctx.generationReferences.map((ref) => ref.nodeId)).toEqual(["img1", "img2"]);
    });

    it("keeps every connected reference when the composer draft has no @ token (plain text must not drop images)", () => {
        const img1 = makeNode("img1", CanvasNodeType.Image, { content: DATA_IMG, mimeType: "image/png" });
        const img2 = makeNode("img2", CanvasNodeType.Image, { content: DATA_IMG, mimeType: "image/png" });
        // 合成面板每敲一个字都会写 composerContent；用户只是补了句画面描述，
        // 没有 @ 任何资源，这时连线上的参考图必须照常提交。
        const config = makeNode("cfg", CanvasNodeType.Config, { composerContent: "镜头缓慢推进，光线偏冷" });
        const nodes = [img1, img2, config];
        const connections = [input("img1", "cfg"), input("img2", "cfg")];

        const ctx = buildNodeGenerationContext("cfg", nodes, connections, "镜头缓慢推进，光线偏冷");

        expect(ctx.referenceImages.map((image) => image.id)).toEqual(["img1", "img2"]);
        expect(ctx.imageCount).toBe(2);
        expect(ctx.prompt).toBe("镜头缓慢推进，光线偏冷");
    });

    it("still narrows to @-selected resources when the composer prompt references nodes", () => {
        const img1 = makeNode("img1", CanvasNodeType.Image, { content: DATA_IMG, mimeType: "image/png" });
        const img2 = makeNode("img2", CanvasNodeType.Image, { content: DATA_IMG, mimeType: "image/png" });
        const config = makeNode("cfg", CanvasNodeType.Config, { composerContent: "用 @[node:img2] 这一段" });
        const nodes = [img1, img2, config];
        const connections = [input("img1", "cfg"), input("img2", "cfg")];

        const ctx = buildNodeGenerationContext("cfg", nodes, connections, "用 @[node:img2] 这一段");

        expect(ctx.referenceImages.map((image) => image.id)).toEqual(["img2"]);
    });

    it("expands a repeated text token once per occurrence in the prompt", () => {
        const text = makeNode("t1", CanvasNodeType.Text, { content: "第一段文本" });
        const source = makeNode("out", CanvasNodeType.Image);

        const ctx = buildNodeGenerationContext(
            "out",
            [text, source],
            [input("t1", "out")],
            "引用 @[node:t1] 再次 @[node:t1]",
        );

        expect(ctx.prompt).toBe("引用 第一段文本 再次 第一段文本");
        expect(ctx.prompt.match(/第一段文本/g)).toHaveLength(2);
        expect(ctx.textCount).toBe(1);
        expect(ctx.generationReferences.filter((ref) => ref.kind === "text")).toHaveLength(1);
        expect(ctx.referenceImages).toHaveLength(0);
    });
});
