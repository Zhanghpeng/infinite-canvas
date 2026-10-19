import { App, Button, Form, Input, Radio } from "antd";
import { Check, FolderCog, FolderOpen, HardDriveDownload, ServerCog, ShieldCheck, Trash2, Wifi } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { DEFAULT_SERVICE_URL } from "@/lib/storage/storage-prefs";
import { useWorkspaces } from "@/hooks/use-workspaces";
import { checkLocalWorkspace, initWorkspace, readWorkspaceManifest } from "@/services/api/local-workspace";
import { hasBrowserData, migrateBrowserDataToLocal } from "@/services/local-migration";
import { selfCheckStorage } from "@/services/storage-self-check";
import { useStorageStore } from "@/stores/use-storage-store";

// 存储位置：浏览器 / 本地目录(FSA) / 本地服务，并提供工作区列表、连通性测试与一次性迁移入口。
export function ConfigStorage() {
    const { message, modal } = App.useApp();
    const { t } = useTranslation();
    const store = useStorageStore();
    const workspaces = useWorkspaces();
    const [busy, setBusy] = useState(false);
    const [checking, setChecking] = useState(false);
    const [migrating, setMigrating] = useState(false);
    const [workspacePath, setWorkspacePath] = useState("");

    const confirmReload = () => {
        modal.confirm({
            title: t("config.storage.reloadTitle"),
            content: t("config.storage.reloadContent"),
            okText: t("config.storage.reloadNow"),
            cancelText: t("config.storage.reloadLater"),
            onOk: () => window.location.reload(),
        });
    };

    const switchMode = (mode: "browser" | "directory" | "service") => {
        if (mode === store.mode) return;
        store.update({ configured: true, mode });
        confirmReload();
    };

    const test = async () => {
        setBusy(true);
        try {
            if (!(await checkLocalWorkspace(store.serviceUrl, store.serviceToken))) throw new Error(t("config.storage.unreachable"));
            const info = await readWorkspaceManifest(store.serviceUrl, store.serviceToken);
            setWorkspacePath(info.workspacePath);
            message.success(t("config.storage.available", { path: info.workspacePath }));
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("config.storage.unreachable"));
        } finally {
            setBusy(false);
        }
    };

    const initialize = async () => {
        setBusy(true);
        try {
            const info = await initWorkspace(store.serviceUrl, store.serviceToken);
            setWorkspacePath(info.workspacePath);
            message.success(t("config.storage.initialized", { path: info.workspacePath }));
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("config.storage.unreachable"));
        } finally {
            setBusy(false);
        }
    };

    const runSelfCheck = async () => {
        setChecking(true);
        try {
            const result = await selfCheckStorage();
            if (result.ok) message.success(t("config.storage.selfCheckOk", { detail: result.detail }));
            else message.error(t("config.storage.selfCheckFailed", { detail: result.detail }));
        } finally {
            setChecking(false);
        }
    };

    const migrate = async () => {
        setMigrating(true);
        try {
            if (!(await hasBrowserData())) {
                message.info(t("config.storage.noBrowserData"));
                return;
            }
            const summary = await migrateBrowserDataToLocal();
            message.success(t("config.storage.migrated", { projects: summary.projects, blobs: summary.blobs }));
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("config.storage.migrateFailed"));
        } finally {
            setMigrating(false);
        }
    };

    const directoryNotReady = store.status === "directory-unsupported" || store.status === "directory-needs-permission";

    return (
        <Form layout="vertical" requiredMark={false}>
            <section className="rounded-lg border border-stone-200 p-3 dark:border-stone-800">
                <div className="flex items-center gap-2 text-sm font-semibold">
                    <FolderCog className="size-4" />
                    {t("config.storage.title")}
                </div>
                <div className="mt-1 text-xs text-stone-500">{t("config.storage.description")}</div>

                <Radio.Group className="mt-3" value={store.mode} onChange={(event) => switchMode(event.target.value)}>
                    <Radio value="browser">{t("config.storage.modeBrowser")}</Radio>
                    <Radio value="directory">{t("config.storage.modeDirectory")}</Radio>
                    <Radio value="service">{t("config.storage.modeService")}</Radio>
                </Radio.Group>

                {store.mode === "directory" ? (
                    <>
                        <div className="mt-3 rounded-md bg-stone-100 px-3 py-2 text-xs text-stone-500 dark:bg-stone-900">{t("config.storage.directoryHint")}</div>
                        <Button className="mt-3" icon={<FolderOpen className="size-4" />} loading={workspaces.busy} disabled={!workspaces.supported} onClick={() => void workspaces.openWorkspace()}>
                            {t("config.storage.openWorkspace")}
                        </Button>

                        {workspaces.list.length ? (
                            <div className="mt-3 space-y-1">
                                <div className="text-xs text-stone-500">{t("config.storage.recentWorkspaces")}</div>
                                {workspaces.list.map((item) => (
                                    <div key={item.id} className="flex items-center justify-between gap-2 rounded-md border border-stone-200 px-2 py-1.5 dark:border-stone-800">
                                        <button type="button" className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={() => void workspaces.switchWorkspace(item)}>
                                            {item.id === workspaces.currentId ? <Check className="size-3.5 shrink-0" /> : <FolderOpen className="size-3.5 shrink-0 text-stone-400" />}
                                            <span className={`truncate text-xs ${item.id === workspaces.currentId ? "font-medium" : ""}`}>{item.name}</span>
                                        </button>
                                        <Button size="small" type="text" danger icon={<Trash2 className="size-3.5" />} onClick={() => void workspaces.removeWorkspace(item)} />
                                    </div>
                                ))}
                            </div>
                        ) : null}

                        {!workspaces.supported ? <div className="mt-2 text-xs text-red-500">{t("config.storage.directoryUnsupported")}</div> : null}
                        {workspaces.supported && directoryNotReady ? <div className="mt-2 text-xs text-amber-600">{t("config.storage.directoryNeedsPermission")}</div> : null}
                    </>
                ) : null}

                {store.mode === "service" ? (
                    <>
                        <div className="mt-3 rounded-md bg-stone-100 px-3 py-2 text-xs text-stone-500 dark:bg-stone-900">{t("config.storage.startHint")}</div>
                        <Form.Item label={t("config.storage.serviceUrl")} className="mt-3 mb-0">
                            <Input value={store.serviceUrl} placeholder={DEFAULT_SERVICE_URL} onChange={(event) => store.update({ serviceUrl: event.target.value })} />
                        </Form.Item>
                        <Form.Item label={t("config.storage.serviceToken")} className="mt-3 mb-0">
                            <Input.Password value={store.serviceToken} onChange={(event) => store.update({ serviceToken: event.target.value })} />
                        </Form.Item>
                        <div className="mt-3 flex flex-wrap items-center gap-2">
                            <Button icon={<Wifi className="size-4" />} loading={busy} onClick={() => void test()}>
                                {t("config.storage.test")}
                            </Button>
                            <Button icon={<ServerCog className="size-4" />} loading={busy} onClick={() => void initialize()}>
                                {t("config.storage.initialize")}
                            </Button>
                        </div>
                        {workspacePath ? <div className="mt-3 truncate text-xs text-stone-500">{t("config.storage.workspacePath", { path: workspacePath })}</div> : null}
                    </>
                ) : null}

                {store.mode !== "browser" ? (
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                        <Button icon={<ShieldCheck className="size-4" />} loading={checking} onClick={() => void runSelfCheck()}>
                            {t("config.storage.selfCheck")}
                        </Button>
                        <Button icon={<HardDriveDownload className="size-4" />} loading={migrating} onClick={() => void migrate()}>
                            {t("config.storage.migrate")}
                        </Button>
                    </div>
                ) : null}
            </section>
        </Form>
    );
}
