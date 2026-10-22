import { useEffect, useState } from "react";
import { App, Button, Input, Tooltip } from "antd";
import copyToClipboard from "copy-to-clipboard";
import { Bot, Copy, KeyRound, Link2, PlugZap, RefreshCw, Sparkles, Terminal } from "lucide-react";
import { useTranslation } from "react-i18next";

import { canvasThemes } from "@/lib/canvas-theme";
import { agentProviderLabel, type AgentProvider } from "@/stores/use-agent-store";
import { fetchWorkbuddyConfig, fetchWorkbuddyStatus, saveWorkbuddyConfig } from "@/services/api/canvas-agent";

const LOCAL_AGENT_COMMAND = "npx -y @zhuyichuan/canvas-agent";
const AGENT_PLUGIN_REMOVE_COMMAND = "codex plugin remove infinite-canvas";
const AGENT_MCP_REMOVE_COMMAND = "codex mcp remove infinite-canvas";

/**
 * 连接页：先选「用谁当执行者」，再按这个选择给对应的接入方式。
 *
 * 之前这里只有「填地址 + token」一条路，Codex 侧完全没入口；而默认 provider 又指向
 * WorkBuddy、它的配置卡片还是注释状态 —— 两条路都是死的。现在 provider 显式可选，
 * 各自的方式摆在明面上。
 */
export function AgentConnectView({
    theme,
    provider,
    onProviderChange,
    url,
    token,
    enabled,
    connected,
    activity,
    connectError,
    onUrlChange,
    onTokenChange,
    onToggleEnabled,
}: {
    theme: (typeof canvasThemes)[keyof typeof canvasThemes];
    provider: AgentProvider;
    onProviderChange: (provider: AgentProvider) => void;
    url: string;
    token: string;
    enabled: boolean;
    connected: boolean;
    activity: string;
    connectError: string;
    onUrlChange: (value: string) => void;
    onTokenChange: (value: string) => void;
    onToggleEnabled: () => void;
}) {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const [wbToken, setWbToken] = useState("");
    const [wbOnline, setWbOnline] = useState<boolean | null>(null);
    const [wbChecking, setWbChecking] = useState(false);
    const [wbSaving, setWbSaving] = useState(false);

    useEffect(() => {
        if (!connected || !url || !token) return;
        let active = true;
        void fetchWorkbuddyConfig(url, token).then((res) => {
            if (!active) return;
            if (res.hasToken) {
                void fetchWorkbuddyStatus(url, token).then((status) => {
                    if (active) setWbOnline(Boolean(status.online));
                });
            }
        });
        return () => { active = false; };
    }, [connected, url, token]);

    const handleCheckWbStatus = async () => {
        if (!connected) return;
        setWbChecking(true);
        try {
            const res = await fetchWorkbuddyStatus(url, token);
            setWbOnline(Boolean(res.online));
            if (res.online) message.success(t("agent.connect.wbOnlineToast"));
            else message.warning(res.error || t("agent.connect.wbOfflineToast"));
        } catch {
            setWbOnline(false);
            message.error(t("agent.connect.wbCheckFailed"));
        } finally {
            setWbChecking(false);
        }
    };

    const handleSaveWbToken = async () => {
        if (!connected) {
            message.warning(t("agent.connect.wbNeedAgent"));
            return;
        }
        setWbSaving(true);
        try {
            await saveWorkbuddyConfig(url, token, { accessToken: wbToken.trim() });
            message.success(t("agent.connect.wbSaved"));
            void handleCheckWbStatus();
        } catch (err) {
            message.error(err instanceof Error ? err.message : t("agent.connect.wbSaveFailed"));
        } finally {
            setWbSaving(false);
        }
    };

    const statusText = connectError ? t("agent.status.failed") : connected ? activity : enabled ? t("agent.status.connecting") : t("agent.status.disconnected");
    const statusColor = connectError ? "#dc2626" : connected ? "#16a34a" : enabled ? "#d97706" : theme.node.muted;

    const copyCommand = (command: string) => {
        copyToClipboard(command);
        message.success(t("agent.connect.commandCopied"));
    };

    /** 一条命令 + 复制按钮：连接页里所有需要粘到终端的东西都长这样。 */
    const commandRow = (label: string, command: string) => (
        <div key={command} className="flex items-center gap-2 rounded-md border bg-transparent px-2 py-1.5" style={{ borderColor: theme.node.stroke, color: theme.node.text }}>
            {label ? (
                <span className="shrink-0 text-[11px]" style={{ color: theme.node.muted }}>
                    {label}
                </span>
            ) : null}
            <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap text-[11px] leading-5">{command}</code>
            <Tooltip title={t("agent.connect.copyCommand")}>
                <Button size="small" type="text" className="!h-6 !w-6 !min-w-6" icon={<Copy className="size-3.5" />} onClick={() => copyCommand(command)} />
            </Tooltip>
        </div>
    );

    /**
     * 「启动本地 Agent」这张卡两种 provider 都要：网页连的是它，Codex 的 MCP 也读它的配置。
     * 只有最后那句提示不同（Codex 讲 MCP 没装会怎样，WorkBuddy 讲连接器能代启）。
     */
    const directCard = (hintKey: string) => (
        <div className="rounded-lg border p-3.5" style={{ borderColor: theme.node.stroke }}>
            <div className="flex items-center gap-2">
                <Terminal className="size-4 shrink-0" />
                <div className="text-sm font-medium leading-5">{t("agent.connect.directTitle")}</div>
            </div>
            <div className="mt-1 text-xs leading-5" style={{ color: theme.node.muted }}>
                {t("agent.connect.directText")}
            </div>
            <div className="mt-2.5">{commandRow("", LOCAL_AGENT_COMMAND)}</div>
            <div className="mt-2 text-[11px] leading-4" style={{ color: theme.node.muted }}>
                {t(hintKey)}
            </div>
        </div>
    );

    return (
        <div className="thin-scrollbar min-h-0 flex-1 overflow-y-auto p-4">
            <div className="space-y-4">
                <div>
                    <div className="text-base font-semibold leading-6">{t("agent.connect.title")}</div>
                    <div className="mt-1 text-xs leading-5" style={{ color: theme.node.muted }}>
                        {t("agent.connect.description")}
                    </div>
                    {/* 执行者先选清楚：它决定会话走哪条 turn 通路，也决定下面该看哪套接入方式 */}
                    <div className="mt-2.5 flex items-center gap-1">
                        {(["codex", "workbuddy"] as const).map((item) => {
                            const active = provider === item;
                            return (
                                <button
                                    key={item}
                                    type="button"
                                    className="rounded-md px-2.5 py-1 text-xs font-medium transition hover:bg-black/5 dark:hover:bg-white/10"
                                    style={{ background: active ? theme.toolbar.activeBg : undefined, color: active ? theme.toolbar.activeText : theme.node.muted }}
                                    onClick={() => onProviderChange(item)}
                                >
                                    {agentProviderLabel(item)}
                                </button>
                            );
                        })}
                    </div>
                    <div className="mt-1.5 text-[11px] leading-4" style={{ color: theme.node.muted }}>
                        {t(`agent.connect.providerHint.${provider}`)}
                    </div>
                </div>

                {/* 1. 本地 Agent 服务：两种 provider 共用，先连上它才谈得上会话 */}
                <div className="rounded-lg border p-3.5" style={{ borderColor: theme.node.stroke }}>
                    <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                            <div className="flex min-w-0 items-center gap-2">
                                <span className="shrink-0 text-sm font-medium leading-5">{t("agent.connect.webConnection")}</span>
                                <span
                                    className="inline-flex min-w-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] leading-4"
                                    style={{ borderColor: connected || enabled || connectError ? statusColor : theme.node.stroke, color: statusColor }}
                                >
                                    <span className="size-1.5 shrink-0 rounded-full" style={{ background: statusColor }} />
                                    <span className="truncate">{statusText}</span>
                                </span>
                            </div>
                            <div className="mt-1 text-xs leading-5" style={{ color: theme.node.muted }}>
                                {t("agent.connect.autoDiscover")}
                            </div>
                        </div>
                        <Button className="!h-8 !px-3" type={enabled ? "default" : "primary"} icon={<PlugZap className="size-4" />} onClick={onToggleEnabled}>
                            {t(enabled ? "agent.connect.disconnect" : "agent.connect.connect")}
                        </Button>
                    </div>
                    <div className="mt-3 grid gap-2.5">
                        <label className="grid gap-1.5">
                            <span className="flex items-center gap-1.5 text-xs font-medium" style={{ color: theme.node.muted }}>
                                <Link2 className="size-3.5" />
                                {t("agent.connect.localAddress")}
                                <span className="font-normal opacity-70">Local URL</span>
                            </span>
                            <Input size="large" prefix={<Link2 className="mr-1 size-4" style={{ color: theme.node.faint }} />} value={url} onChange={(event) => onUrlChange(event.target.value)} placeholder={t("agent.connect.urlPlaceholder")} />
                        </label>
                        <label className="grid gap-1.5">
                            <span className="flex items-center gap-1.5 text-xs font-medium" style={{ color: theme.node.muted }}>
                                <KeyRound className="size-3.5" />
                                {t("agent.connect.token")}
                                <span className="font-normal opacity-70">Connect token</span>
                            </span>
                            <Input.Password
                                size="large"
                                prefix={<KeyRound className="mr-1 size-4" style={{ color: theme.node.faint }} />}
                                value={token}
                                onChange={(event) => onTokenChange(event.target.value)}
                                placeholder={t("agent.connect.tokenPlaceholder")}
                            />
                        </label>
                        {connectError ? (
                            <div className="rounded-md border px-2.5 py-2 text-xs leading-5" style={{ borderColor: "rgba(220,38,38,.35)", color: "#dc2626" }}>
                                {connectError}
                            </div>
                        ) : null}
                    </div>
                </div>

                {provider === "codex" ? (
                    <>
                        {/* 2. 方式一：在 Codex 里装插件（MCP + 技能一起进来） */}
                        <div className="rounded-lg border p-3.5" style={{ borderColor: theme.node.stroke }}>
                            <div className="flex items-center gap-2">
                                <Sparkles className="size-4 shrink-0" />
                                <div className="text-sm font-medium leading-5">{t("agent.connect.pluginTitle")}</div>
                            </div>
                            <div className="mt-1 text-xs leading-5" style={{ color: theme.node.muted }}>
                                {t("agent.connect.pluginText")}
                            </div>
                            <div className="mt-2 rounded-lg border px-3 py-2.5 text-xs leading-5" style={{ borderColor: theme.node.stroke, color: theme.node.muted }}>
                                <div className="font-medium" style={{ color: theme.node.text }}>
                                    {t("agent.connect.pluginReminder")}
                                </div>
                                <div className="mt-1">{t("agent.connect.pluginReminderText")}</div>
                                <div className="mt-2 grid gap-1.5">
                                    {commandRow(t("agent.connect.removePlugin"), AGENT_PLUGIN_REMOVE_COMMAND)}
                                    {commandRow(t("agent.connect.removeMcp"), AGENT_MCP_REMOVE_COMMAND)}
                                </div>
                            </div>
                        </div>

                        {/* 3. 方式二：只起本地 Agent（不装 MCP，不额外吃 token） */}
                        {directCard("agent.connect.directHintCodex")}
                    </>
                ) : (
                    <>
                        {/* 2'. WorkBuddy 桌面助理：Access Token 决定 workbuddy 通路能不能跑 */}
                        <div className="rounded-lg border p-3.5" style={{ borderColor: theme.node.stroke }}>
                            <div className="flex flex-wrap items-start justify-between gap-3">
                                <div className="min-w-0 flex-1">
                                    <div className="flex min-w-0 items-center gap-2">
                                        <Bot className="size-4 shrink-0" />
                                        <span className="shrink-0 text-sm font-medium leading-5">{t("agent.connect.wbTitle")}</span>
                                        <span
                                            className="inline-flex min-w-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] leading-4"
                                            style={{
                                                borderColor: wbOnline ? "#16a34a" : wbOnline === false ? "#d97706" : theme.node.stroke,
                                                color: wbOnline ? "#16a34a" : wbOnline === false ? "#d97706" : theme.node.muted,
                                            }}
                                        >
                                            <span className="size-1.5 shrink-0 rounded-full" style={{ background: wbOnline ? "#16a34a" : wbOnline === false ? "#d97706" : theme.node.muted }} />
                                            <span className="truncate">{wbChecking ? t("agent.connect.wbChecking") : wbOnline ? t("agent.connect.wbOnline") : wbOnline === false ? t("agent.connect.wbOffline") : t("agent.connect.wbUnset")}</span>
                                        </span>
                                    </div>
                                    <div className="mt-1 text-xs leading-5" style={{ color: theme.node.muted }}>
                                        {t("agent.connect.wbText")}
                                    </div>
                                </div>
                                <Button className="!h-8 !px-3" icon={<RefreshCw className={`size-3.5 ${wbChecking ? "animate-spin" : ""}`} />} onClick={() => void handleCheckWbStatus()} disabled={!connected}>
                                    {t("agent.connect.wbRefresh")}
                                </Button>
                            </div>
                            <div className="mt-3 grid gap-2.5">
                                <label className="grid gap-1.5">
                                    <span className="flex items-center gap-1.5 text-xs font-medium" style={{ color: theme.node.muted }}>
                                        <KeyRound className="size-3.5" />
                                        {t("agent.connect.wbTokenLabel")}
                                        <span className="font-normal opacity-70">open.workbuddy.cn</span>
                                    </span>
                                    <Input.Password
                                        size="large"
                                        prefix={<KeyRound className="mr-1 size-4" style={{ color: theme.node.faint }} />}
                                        value={wbToken}
                                        onChange={(event) => setWbToken(event.target.value)}
                                        placeholder={t("agent.connect.wbTokenPlaceholder")}
                                    />
                                </label>
                                <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                                    <span className="text-[11px]" style={{ color: theme.node.muted }}>
                                        {t("agent.connect.wbScope")}
                                    </span>
                                    <Button type="primary" className="!h-8 !px-3" loading={wbSaving} onClick={() => void handleSaveWbToken()} disabled={!connected}>
                                        {t("agent.connect.wbSave")}
                                    </Button>
                                </div>
                            </div>
                        </div>

                        {/* 3'. 起本地 Agent：workbuddy 也依赖它转发 */}
                        {directCard("agent.connect.directHintWorkbuddy")}
                    </>
                )}
            </div>
        </div>
    );
}
