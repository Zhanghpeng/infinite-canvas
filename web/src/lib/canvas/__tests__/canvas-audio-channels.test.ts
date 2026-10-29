import { describe, expect, it } from "vitest";

import { buildNodeGenerationContext } from "@/components/canvas/canvas-node-generation";
import { inferAudioEdgeMode, resolveAudioEdgeMode, setAudioEdgeMode, supportsAudioEdgeModes, toggleAudioEdgeMode } from "@/lib/canvas/canvas-audio-channels";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData, type CanvasNodeMetadata } from "@/types/canvas";

function makeNode(id: string, type: CanvasNodeData["type"], metadata: CanvasNodeMetadata = {}): CanvasNodeData {
    return {
        id,
        type,
        title: id,
        position: { x: 0, y: 0 },
        width: 100,
        height: 100,
        metadata,
    };
}

function makeConnection(fromNodeId: string, toNodeId: string): CanvasConnection {
    return { id: `${fromNodeId}->${toNodeId}`, fromNodeId, toNodeId, kind: "input" };
}

const VOICE = "audio-voice";
const MUSIC = "audio-music";

function buildInputs(targetMetadata: CanvasNodeMetadata = {}) {
    const target = makeNode("video-1", CanvasNodeType.Video, targetMetadata);
    const voice = makeNode(VOICE, CanvasNodeType.Audio, { audioKind: "voice", content: "https://cdn.example/voice.mp3", durationMs: 3200 });
    const music = makeNode(MUSIC, CanvasNodeType.Audio, { audioKind: "music", content: "https://cdn.example/music.mp3" });
    const nodes = [target, voice, music];
    const connections = [makeConnection(VOICE, target.id), makeConnection(MUSIC, target.id)];
    return { target, nodes, connections };
}

describe("audio edge channels", () => {
    it("defaults voice audio to the track channel and music to reference", () => {
        expect(inferAudioEdgeMode(makeNode(VOICE, CanvasNodeType.Audio, { audioKind: "voice" }))).toBe("track");
        expect(inferAudioEdgeMode(makeNode(MUSIC, CanvasNodeType.Audio, { audioKind: "music" }))).toBe("reference");
        // 没标 audioKind 的历史节点按音乐处理，保持既有行为
        expect(inferAudioEdgeMode(makeNode("audio-plain", CanvasNodeType.Audio))).toBe("reference");
        expect(inferAudioEdgeMode(undefined)).toBe("reference");
    });

    it("lets an explicit override win in both directions", () => {
        const voice = makeNode(VOICE, CanvasNodeType.Audio, { audioKind: "voice" });
        const music = makeNode(MUSIC, CanvasNodeType.Audio, { audioKind: "music" });
        // 用户就是想让 H3 参考这个配音的音色
        expect(resolveAudioEdgeMode({ [VOICE]: "reference" }, voice)).toBe("reference");
        // 用户想把这段音乐当对白轨
        expect(resolveAudioEdgeMode({ [MUSIC]: "track" }, music)).toBe("track");
        expect(resolveAudioEdgeMode(undefined, voice)).toBe("track");
    });

    it("does not persist an override that equals the inferred default", () => {
        const music = makeNode(MUSIC, CanvasNodeType.Audio, { audioKind: "music" });
        // 切到 track 要记下来；再切回 reference 等于默认，就该删掉
        const tracked = setAudioEdgeMode(undefined, music, "track");
        expect(tracked).toEqual({ [MUSIC]: "track" });
        expect(setAudioEdgeMode(tracked, music, "reference")).toEqual({});
    });

    it("keeps other edges untouched when one is switched", () => {
        const voice = makeNode(VOICE, CanvasNodeType.Audio, { audioKind: "voice" });
        const music = makeNode(MUSIC, CanvasNodeType.Audio, { audioKind: "music" });
        const next = setAudioEdgeMode({ [MUSIC]: "track" }, voice, "reference");
        expect(next).toEqual({ [MUSIC]: "track", [VOICE]: "reference" });
    });

    it("only offers the two channels on video nodes", () => {
        expect(supportsAudioEdgeModes(makeNode("video-1", CanvasNodeType.Video))).toBe(true);
        expect(supportsAudioEdgeModes(makeNode("audio-1", CanvasNodeType.Audio))).toBe(false);
        expect(supportsAudioEdgeModes(undefined)).toBe(false);
    });

    it("toggles between the two channels", () => {
        expect(toggleAudioEdgeMode("reference")).toBe("track");
        expect(toggleAudioEdgeMode("track")).toBe("reference");
    });
});

describe("audio channels in the generation context", () => {
    it("keeps voice out of the audio quota and registers it as a track", () => {
        const { target, nodes, connections } = buildInputs();
        const context = buildNodeGenerationContext(target.id, nodes, connections, "一个女孩在窗边说话");

        // 只有音乐占 3 音频配额，配音不挤占
        expect(context.referenceAudios.map((audio) => audio.id)).toEqual([MUSIC]);
        expect(context.audioCount).toBe(1);
        expect(context.audioTracks.map((track) => track.nodeId)).toEqual([VOICE]);
        expect(context.audioTracks[0]).toMatchObject({ title: VOICE, url: "https://cdn.example/voice.mp3", durationMs: 3200 });
        // 音轨不进生成快照，重跑一次也不会把它当参考送出去
        expect(context.generationReferences.filter((reference) => reference.kind === "audio").map((reference) => reference.nodeId)).toEqual([MUSIC]);
    });

    it("moves a voice edge back into references when the user asks for it", () => {
        const { target, nodes, connections } = buildInputs({ audioEdgeModes: { [VOICE]: "reference" } });
        const context = buildNodeGenerationContext(target.id, nodes, connections, "参考这段配音的音色");

        expect(new Set(context.referenceAudios.map((audio) => audio.id))).toEqual(new Set([VOICE, MUSIC]));
        expect(context.audioCount).toBe(2);
        expect(context.audioTracks).toEqual([]);
    });

    it("keeps music as a track when the user forces it", () => {
        const { target, nodes, connections } = buildInputs({ audioEdgeModes: { [MUSIC]: "track" } });
        const context = buildNodeGenerationContext(target.id, nodes, connections, "旁白");

        expect(context.referenceAudios).toEqual([]);
        expect(context.audioTracks.map((track) => track.nodeId)).toEqual([VOICE, MUSIC]);
    });

    it("treats every audio edge as a reference on non-video targets", () => {
        const config = makeNode("config-1", CanvasNodeType.Config);
        const voice = makeNode(VOICE, CanvasNodeType.Audio, { audioKind: "voice", content: "https://cdn.example/voice.mp3" });
        const context = buildNodeGenerationContext(config.id, [config, voice], [makeConnection(VOICE, config.id)], "@[node:audio-voice] 说这句");

        expect(context.audioTracks).toEqual([]);
        expect(context.referenceAudios.map((audio) => audio.id)).toEqual([VOICE]);
    });
});
