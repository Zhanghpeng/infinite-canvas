// 导演台的「自检」：把"这一镜拍得对不对"变成确定性的问题清单。
//
// 为什么需要：Agent 在工具循环里看不到渲染结果（工具没有视觉），用户也常常要肉眼才发现
// "人出画了 / 主体太小 / 两个人叠在一起"。这些其实都能用已有数学判定 —— 全部基于
// frameFit / describeFraming / frameWarnings，不依赖 WebGL，所以卡片、编辑器、Agent 读回
// 用的是同一份实现。
import { hasMovement } from "./motion";
import { describeFraming, eyePosition, frameFit, frameWarnings } from "./prompt";
import type { StageObject, StageState } from "./stage-state";

export type SceneIssueLevel = "error" | "warn";

/** 检查项：code 既用于测试断言，也用于过滤（编辑器不重复展示走位预警）。 */
export type SceneIssueCode = "no-subject" | "out-of-frame" | "too-small" | "too-large" | "shot-out-of-frame" | "too-close" | "overlap" | "track" | "backdrop-unavailable";

export type SceneIssue = { level: SceneIssueLevel; code: SceneIssueCode; text: string };

export type SceneCheckContext = {
    /**
     * 背景板引用的图现在没有画面（生成中 / 失败 / 被清理）。
     * 由调用方用 backdrop.backdropUnavailable() 判定后传进来 —— check 模块不依赖画布节点结构。
     */
    backdropUnavailable?: { nodeId: string; title: string } | null;
};

export type SceneCheck = {
    /** 没有 error 就算通过（warn 只是提醒）。 */
    ok: boolean;
    subjects: number;
    shots: number;
    moving: boolean;
    issues: SceneIssue[];
};

/** 主体（写关系与构图的"人"）：人物与导入的人物模型；道具与环境都不算 —— 与提示词同一口径。 */
const isSubject = (object: StageObject) => object.kind === "person" || object.kind === "model";
const nameOf = (object: StageObject, fallback: string) => object.name?.trim() || fallback;

const MIN_HEIGHT_RATIO = 0.06;
const MAX_HEIGHT_RATIO = 0.95;
const TOO_CLOSE_M = 1;
const OVERLAP_M = 0.25;

const percent = (ratio: number) => `${Math.round(ratio * 100)}%`;

export function checkScene(state: StageState, context: SceneCheckContext = {}): SceneCheck {
    const issues: SceneIssue[] = [];
    const visible = state.objects.filter((object) => object.visible);
    const subjects = visible.filter(isSubject);
    const moving = visible.some((object) => hasMovement(object.track));
    const shots = state.shots.length;

    if (!subjects.length) {
        issues.push({ level: "error", code: "no-subject", text: "画面里没有主体（人物 / 模型）—— 加一个人物，或把隐藏的人物显示出来。" });
        return { ok: false, subjects: 0, shots, moving, issues };
    }

    // 当前机位：出画是 error（这就是成片第一帧），占比只提醒
    for (const subject of subjects) {
        const fit = frameFit(subject, state.camera);
        if (!fit.inFrame) {
            issues.push({ level: "error", code: "out-of-frame", text: `当前机位下「${nameOf(subject, "主体")}」${fit.reason} —— 调方位角 / 距离 / 焦距把它框回画面。` });
            continue;
        }
        const { heightRatio } = describeFraming(subject, state.camera);
        if (heightRatio < MIN_HEIGHT_RATIO) issues.push({ level: "warn", code: "too-small", text: `当前机位下「${nameOf(subject, "主体")}」只占画面高度约 ${percent(heightRatio)}，太小了 —— 拉近或换更长的焦距。` });
        else if (heightRatio > MAX_HEIGHT_RATIO) issues.push({ level: "warn", code: "too-large", text: `当前机位下「${nameOf(subject, "主体")}」约占画面高度 ${percent(heightRatio)}，快糊满画面 —— 退远一点或换广一点。` });
    }

    // 背景板：设了但那张图现在没有画面 → 交代清楚（导出会是一张没有环境底图的画面）
    if (state.backdrop?.nodeId && context.backdropUnavailable) {
        issues.push({ level: "warn", code: "backdrop-unavailable", text: `背景板引用的「${context.backdropUnavailable.title}」还没有画面（生成中或失败）—— 现在导出会是一张没有环境底图的画面。` });
    }

    // 关键帧机位：运镜过程中短暂出画可能是刻意的，所以只提醒
    state.shots.forEach((shot, index) => {
        const label = shot.name?.trim() || `机位 ${index + 1}`;
        for (const subject of subjects) {
            const fit = frameFit(subject, shot.camera);
            if (!fit.inFrame) issues.push({ level: "warn", code: "shot-out-of-frame", text: `机位「${label}」里「${nameOf(subject, "主体")}」${fit.reason}。` });
        }
    });

    // 贴脸：机位几乎贴在主体身上
    const eye = eyePosition(state.camera);
    for (const subject of subjects) {
        const away = Math.hypot(subject.x - eye.x, subject.z - eye.z);
        if (away < TOO_CLOSE_M) issues.push({ level: "warn", code: "too-close", text: `机位离「${nameOf(subject, "主体")}」只有约 ${away.toFixed(1)}m —— 几乎贴着，容易糊满画面。` });
    }

    // 重叠：两个可见的非环境物体几乎在同一位置
    const solids = visible.filter((object) => object.kind !== "env");
    for (let i = 0; i < solids.length; i += 1) {
        for (let j = i + 1; j < solids.length; j += 1) {
            const gap = Math.hypot(solids[i].x - solids[j].x, solids[i].z - solids[j].z);
            if (gap < OVERLAP_M) issues.push({ level: "warn", code: "overlap", text: `「${nameOf(solids[i], "物体")}」与「${nameOf(solids[j], "物体")}」几乎在同一个位置（相距约 ${gap.toFixed(2)}m）—— 挪开一点。` });
        }
    }

    // 走位出画：原样带上时间与原因（与编辑器「走位预警」同一句话）
    for (const warning of frameWarnings(state, 24)) issues.push({ level: "warn", code: "track", text: `走位出画：${warning}` });

    return { ok: !issues.some((issue) => issue.level === "error"), subjects: subjects.length, shots, moving, issues };
}

/** 一行摘要 + 明细：给 Agent 读、也给状态行报。 */
export function formatSceneCheck(check: SceneCheck, limit = 8): string {
    const head = `自检：${check.subjects} 个主体 · ${check.shots} 个机位${check.moving ? " · 有走位" : ""}`;
    if (!check.issues.length) return `${head}\n✓ 没发现问题`;
    const lines = check.issues.slice(0, limit).map((issue) => `${issue.level === "error" ? "✗" : "⚠"} ${issue.text}`);
    const rest = check.issues.length > lines.length ? `\n… 还有 ${check.issues.length - lines.length} 条` : "";
    return [head, ...lines].join("\n") + rest;
}
