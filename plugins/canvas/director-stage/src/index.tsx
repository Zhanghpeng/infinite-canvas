// 3D 导演台节点插件：卡片是「预览 + 入口」，真正的摆位与调机位在双击打开的大窗口里做。
//
// 为什么不把 3D 视口放在卡片上：卡片又小又和「拖动节点」抢手势，转视角纯属受罪；
// 这里把编辑搬到大窗口（见 editor.ts），卡片只留一张最近一次的预览图与常用动作，
// 顺带也就不存在「每个节点常驻一个 WebGL 上下文」的上下文数量问题。
//
// 产物落到现有工作流槽位：当前机位帧 → 参考图；机位 A/B → first_frame / last_frame；
// 多视图 → 参考图组；运镜提示词 → 文本节点。导出动作在 actions.ts。
import { definePlugin, useEffect, useState } from "@infinite-canvas/plugin-sdk";
import type { CanvasNodeContentProps, CanvasNodeContext, CanvasNodeToolbarItem } from "@infinite-canvas/plugin-sdk";

import { attachMotionVideoNode, exportCurrentView, exportFirstLast, exportMultiView, exportPrompt, renderMotionVideo } from "./actions";
import { createOffscreenSession } from "./capture";
import { checkScene, formatSceneCheck } from "./check";
import { pendingStageCommand, STAGE_CHECK_KEY, STAGE_COMMAND_ACK_KEY } from "./commands";
import { closeStageEditor, openStageEditor, STAGE_VERSION } from "./editor";
import { lightingPresetById } from "./lighting";
import { applySceneToState, sceneById } from "./scenes";
import { findUserTemplate } from "./templates";
import { createDefaultStageState, normalizeStageState, stageStateSummary } from "./stage-state";

const BUTTON: React.CSSProperties = { height: 28, padding: "0 10px", borderRadius: 8, border: "1px solid rgba(150,150,160,.4)", background: "rgba(255,255,255,.05)", color: "inherit", fontSize: 12, cursor: "pointer", whiteSpace: "nowrap" };
const PRIMARY: React.CSSProperties = { ...BUTTON, border: "1px solid rgba(59,130,246,.7)", background: "rgba(59,130,246,.22)" };

// 导出组件供单测渲染（命令通道的执行逻辑都在这里）
export function StageCard({ ctx }: CanvasNodeContentProps) {
    const [status, setStatus] = useState("");
    const [busy, setBusy] = useState(false);
    const state = normalizeStageState(ctx.node.metadata?.stageState ?? undefined);
    const preview = typeof ctx.node.metadata?.previewContent === "string" ? ctx.node.metadata.previewContent : "";
    const editing = Boolean(ctx.node.metadata?.editorOpen);
    const summary = stageStateSummary(state);

    // 节点被删掉/插件被禁用时，别把大窗口留成孤儿
    useEffect(() => () => closeStageEditor(ctx.node.id), [ctx.node.id]);

    // ---- 命令通道：客户端（Agent / 脚本）只写一条 metadata 指令，插件在这里执行 ----
    // 放在卡片里是因为"节点存在即挂载"——模态开不开都能执行；执行完写回执保证幂等。
    const command = pendingStageCommand(ctx.node.metadata);
    const commandId = command?.id ?? "";
    useEffect(() => {
        if (!command) return;
        let cancelled = false;
        const ack = () => {
            if (!cancelled) ctx.updateMetadata({ [STAGE_COMMAND_ACK_KEY]: command.id } as never);
        };
        void (async () => {
            try {
                if (command.type === "applyScene") {
                    // 先查内置场景模板，再查用户在节点里存的「我的模板」（见 metadata.stageTemplateIds）
                    const builtin = sceneById(command.sceneId);
                    const template = builtin ?? (await findUserTemplate(ctx.storage, command.sceneId));
                    if (!template) {
                        setStatus(`没有这个场景模板：${command.sceneId}`);
                        return;
                    }
                    const next = normalizeStageState(applySceneToState(state, template));
                    ctx.updateMetadata({ stageState: next });
                    setStatus(`已按指令套用${builtin ? "" : "我的"}模板「${template.name}」：${next.objects.length} 个物体 · ${next.shots.length} 个机位 · 灯光「${lightingPresetById(next.lighting).name}」`);
                    return;
                }
                if (command.type === "setLighting") {
                    const preset = lightingPresetById(command.lighting);
                    ctx.updateMetadata({ stageState: { ...state, lighting: preset.id } });
                    setStatus(`已按指令把灯光切到「${preset.name}」`);
                    return;
                }
                // 自检：纯计算（不用渲染），算完把报告写回 metadata 供客户端读回
                if (command.type === "check") {
                    const report = checkScene(state);
                    ctx.updateMetadata({
                        [STAGE_CHECK_KEY]: { commandId: command.id, ok: report.ok, subjects: report.subjects, shots: report.shots, moving: report.moving, issues: report.issues, text: formatSceneCheck(report) },
                    } as never);
                    setStatus(`自检：${report.ok ? "通过" : `${report.issues.filter((issue) => issue.level === "error").length} 个问题`}（报告写在 metadata.directorStageCheck）`);
                    return;
                }
                // 导出类：需要渲染，走卡片既有的离屏通路
                if (command.type === "export" && command.mode === "prompt") {
                    setStatus(exportPrompt(ctx, state));
                    return;
                }
                if (command.type === "export" && command.mode === "video") {
                    setBusy(true);
                    setStatus("按指令导出运镜视频…");
                    const result = await renderMotionVideo(state);
                    setStatus(await attachMotionVideoNode(ctx, result, state));
                    return;
                }
                if (command.type === "export") {
                    setBusy(true);
                    setStatus("按指令导出…");
                    const session = createOffscreenSession(state, { format: state.exportFormat, height: state.exportHeight });
                    try {
                        if (command.mode === "current") setStatus(await exportCurrentView(ctx, session, state));
                        else if (command.mode === "firstLast") setStatus(await exportFirstLast(ctx, session, state));
                        else setStatus(await exportMultiView(ctx, session, state));
                    } finally {
                        session.dispose();
                    }
                }
            } catch (error) {
                setStatus(`按指令执行失败：${error instanceof Error ? error.message : String(error)}`);
            } finally {
                ack();
                setBusy(false);
            }
        })();
        return () => {
            cancelled = true;
        };
        // 只在命令 id 变化时执行（busy/state 变化不该重复触发）
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [commandId]);

    const runOffscreen = async (action: (session: ReturnType<typeof createOffscreenSession>) => Promise<string>) => {
        if (busy) return;
        setBusy(true);
        setStatus("处理中…");
        // 卡片上不常驻视口：导出时临时建一个离屏视口，导完立刻释放。
        const session = createOffscreenSession(state, { format: state.exportFormat, height: state.exportHeight });
        try {
            setStatus(await action(session));
        } catch (error) {
            setStatus(`导出失败：${error instanceof Error ? error.message : String(error)}`);
        } finally {
            session.dispose();
            setBusy(false);
        }
    };

    return (
        // 卡片本身不吃鼠标事件：拖卡片=拖节点；只有按钮那一行拦下来，免得点按钮顺带把节点拖走。
        <div style={{ position: "relative", height: "100%", width: "100%", display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ position: "relative", flex: 1, minHeight: 0, borderRadius: 10, overflow: "hidden", background: "#1b1c1f", border: "1px solid rgba(255,255,255,.08)" }}>
                {preview ? (
                    <img src={preview} alt="导演台预览" draggable={false} style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
                ) : (
                    <div style={{ height: "100%", display: "grid", placeItems: "center", textAlign: "center", padding: 16, color: "rgba(255,255,255,.55)", fontSize: 12, lineHeight: 1.7 }}>
                        还没有预览
                        <br />
                        双击卡片 / 点「打开导演台」开始摆位
                    </div>
                )}
                {editing ? (
                    <div style={{ position: "absolute", left: 8, top: 8, padding: "2px 8px", borderRadius: 999, background: "rgba(59,130,246,.9)", fontSize: 11 }}>编辑中</div>
                ) : null}
            </div>

            <div onMouseDown={(event) => event.stopPropagation()} style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                <button type="button" style={PRIMARY} disabled={busy} onClick={() => openStageEditor(ctx)}>
                    打开导演台
                </button>
                <button type="button" style={BUTTON} disabled={busy} onClick={() => void runOffscreen((session) => exportCurrentView(ctx, session, state))}>
                    导出当前机位
                </button>
                <button type="button" style={BUTTON} disabled={busy} onClick={() => setStatus(exportPrompt(ctx, state))}>
                    运镜提示词
                </button>
                <span style={{ marginLeft: "auto", fontSize: 11, opacity: 0.6, whiteSpace: "nowrap" }}>
                    {summary.objects} 个物体 · {summary.focalMm}mm · 机位 {summary.shots}{summary.hasMove ? "（可运镜）" : ""} · v{STAGE_VERSION}
                </span>
            </div>

            {status ? <div style={{ fontSize: 11, opacity: 0.75 }}>{status}</div> : null}
        </div>
    );
}

/** 悬停工具条：给一个直达大窗口的入口（双击也能开）。 */
function stageToolbar(ctx: CanvasNodeContext): CanvasNodeToolbarItem[] {
    return [{ id: "director-stage-open", title: "打开导演台（大窗口摆位与调机位）", label: "导演台", icon: "🎬", onClick: () => openStageEditor(ctx) }];
}

export default definePlugin({
    id: "director-stage",
    name: "3D 导演台",
    version: STAGE_VERSION,
    description: "大窗口 3D 摆位与机位：导出参考图 / 首尾帧 / 多视图 / 运镜提示词，接生图与视频工作流",
    // 首尾帧靠连线的显式槽位（first_frame / last_frame）落点，宿主需要支持该字段。
    minAppVersion: "0.19.7",
    nodes: [
        {
            type: "director-stage:stage",
            title: "3D 导演台",
            icon: "🎬",
            description: "摆人物与道具、调机位，导出参考图与运镜提示词（双击打开大窗口）",
            defaultSize: { width: 480, height: 340 },
            defaultMetadata: { exportFormat: "jpeg", exportHeight: 720, promptLocale: "zh", stageState: createDefaultStageState() },
            Content: StageCard,
            // 双击卡片直接进大窗口，和卡片上的按钮同一个入口
            onDoubleClick: (ctx) => {
                openStageEditor(ctx);
                return true;
            },
            toolbar: stageToolbar,
        },
    ],
});
