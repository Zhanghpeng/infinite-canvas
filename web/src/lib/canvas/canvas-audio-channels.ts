import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

/**
 * 视频节点的音频入边有两种用途。
 *
 * - `reference`：进 ComfyUI 工作流，占 3 音频配额，会变成提示词里的 `<Audio N>`。
 * - `track`：成片对白轨，不占配额、不进工作流，只在画布上登记与试听。
 *
 * 分两条的原因是配音会把音乐参考挤出去：3 角色短片 + 1 段音乐参考，
 * 如果配音也算参考，配额当场就满了，H3 的音频能力等于被自己的配音功能削掉。
 */
export type CanvasAudioEdgeMode = "reference" | "track";

/**
 * 上游音频节点默认走哪条通道。
 *
 * 配音是成片的对白，默认不该被当成生成期参考；音乐语义本来就是参考。
 */
export function inferAudioEdgeMode(source: CanvasNodeData | undefined): CanvasAudioEdgeMode {
    return source?.metadata?.audioKind === "voice" ? "track" : "reference";
}

/** 用户手动切过的以记录为准，否则按上游推断。 */
export function resolveAudioEdgeMode(
    overrides: Record<string, CanvasAudioEdgeMode> | undefined,
    source: CanvasNodeData,
): CanvasAudioEdgeMode {
    return overrides?.[source.id] ?? inferAudioEdgeMode(source);
}

export function toggleAudioEdgeMode(mode: CanvasAudioEdgeMode): CanvasAudioEdgeMode {
    return mode === "track" ? "reference" : "track";
}

/**
 * 写回一份新的覆盖表。
 *
 * 和推断值一致的条目不写：否则上游以后从音乐改成配音，这条旧覆盖还压着，
 * 用户会看到"明明改成配音了，用途还是参考"这种没法解释的状态。
 */
export function setAudioEdgeMode(
    overrides: Record<string, CanvasAudioEdgeMode> | undefined,
    source: CanvasNodeData,
    mode: CanvasAudioEdgeMode,
): Record<string, CanvasAudioEdgeMode> {
    const next = { ...(overrides || {}) };
    if (mode === inferAudioEdgeMode(source)) delete next[source.id];
    else next[source.id] = mode;
    return next;
}

/** 目标节点是不是视频（只有视频节点区分这两条通道）。 */
export function supportsAudioEdgeModes(node: CanvasNodeData | undefined): boolean {
    return node?.type === CanvasNodeType.Video;
}
