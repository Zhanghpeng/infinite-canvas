// 命令通道：客户端（Agent / 脚本 / 其他工具）只写一条指令，插件自己执行。
//
// 为什么不让客户端直接拼 stageState：
// - 场景模板只在插件里（复制到 agent 侧会漂移），所以「套用模板」只能由插件执行；
// - 有些动作必须由插件做（导出要渲染）—— 客户端没法自己渲染。
//
// 协议（都写在节点 metadata 上，与 stageState 互不干扰）：
//   metadata.directorStageCommand = { id, type, ... }   客户端写入
//   metadata.directorStageCommandAck = id               插件执行后回执（保证幂等、可重试）
import type { CanvasNodeMetadata } from "@infinite-canvas/plugin-sdk";

import type { SceneIssue } from "./check";
import type { StageLightingId } from "./stage-state";

export type StageExportMode = "prompt" | "current" | "firstLast" | "multiView" | "video";

export type StageCommand =
    | { id: string; type: "applyScene"; sceneId: string }
    | { id: string; type: "setLighting"; lighting: StageLightingId }
    | { id: string; type: "export"; mode: StageExportMode }
    | { id: string; type: "check" };

const LIGHTING_IDS: StageLightingId[] = ["day", "night", "indoor", "backlit"];
const EXPORT_MODES: StageExportMode[] = ["prompt", "current", "firstLast", "multiView", "video"];

/** 读取并校验命令；字段缺失/类型不对一律当作"没有命令"（不能让脏数据把节点打崩）。 */
export function readStageCommand(metadata: CanvasNodeMetadata | undefined): StageCommand | null {
    const raw = metadata?.directorStageCommand as Record<string, unknown> | undefined;
    if (!raw || typeof raw !== "object") return null;
    const id = typeof raw.id === "string" && raw.id ? raw.id : null;
    if (!id) return null;
    if (raw.type === "applyScene" && typeof raw.sceneId === "string" && raw.sceneId) return { id, type: "applyScene", sceneId: raw.sceneId };
    if (raw.type === "setLighting" && LIGHTING_IDS.includes(raw.lighting as StageLightingId)) return { id, type: "setLighting", lighting: raw.lighting as StageLightingId };
    if (raw.type === "export" && EXPORT_MODES.includes(raw.mode as StageExportMode)) return { id, type: "export", mode: raw.mode as StageExportMode };
    if (raw.type === "check") return { id, type: "check" };
    return null;
}

/** 还没执行过的命令（回执里已经是这个 id 就跳过，保证重挂载/多次渲染不会重复执行）。 */
export function pendingStageCommand(metadata: CanvasNodeMetadata | undefined): StageCommand | null {
    const command = readStageCommand(metadata);
    if (!command) return null;
    return metadata?.directorStageCommandAck === command.id ? null : command;
}

export const STAGE_COMMAND_ACK_KEY = "directorStageCommandAck";

export const STAGE_CHECK_KEY = "directorStageCheck";

/** 插件自检后写回的报告：Agent 读回它就知道"搭得对不对"。 */
export type StageCheckReport = {
    commandId: string;
    ok: boolean;
    subjects: number;
    shots: number;
    moving: boolean;
    issues: SceneIssue[];
    /** 给人/模型直接读的多行文本（formatSceneCheck 的产物）。 */
    text: string;
};

const LEVELS = ["error", "warn"];

/** 读取并校验自检报告；形状不对就当没有（脏数据不能让调用方炸掉）。 */
export function readStageCheck(metadata: CanvasNodeMetadata | undefined): StageCheckReport | null {
    const raw = metadata?.[STAGE_CHECK_KEY] as Record<string, unknown> | undefined;
    if (!raw || typeof raw !== "object" || typeof raw.commandId !== "string" || typeof raw.ok !== "boolean" || typeof raw.text !== "string") return null;
    if (!Array.isArray(raw.issues)) return null;
    const issues: SceneIssue[] = [];
    for (const item of raw.issues as unknown[]) {
        const issue = item as Record<string, unknown> | null;
        if (!issue || !LEVELS.includes(issue.level as string) || typeof issue.code !== "string" || typeof issue.text !== "string") return null;
        issues.push({ level: issue.level as SceneIssue["level"], code: issue.code as SceneIssue["code"], text: issue.text });
    }
    return {
        commandId: raw.commandId,
        ok: raw.ok,
        subjects: Number(raw.subjects) || 0,
        shots: Number(raw.shots) || 0,
        moving: Boolean(raw.moving),
        issues,
        text: raw.text,
    };
}

/** 把一条命令包装成 metadata 补丁（供 Agent 侧复用同一份协议）。 */
export function stageCommandPatch(command: StageCommand): CanvasNodeMetadata {
    return { directorStageCommand: command, [STAGE_COMMAND_ACK_KEY]: undefined } as CanvasNodeMetadata;
}
