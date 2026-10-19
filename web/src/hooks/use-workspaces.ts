import { App } from "antd";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { forgetWorkspace, hasDirectoryPermission, isFileSystemAccessSupported, listWorkspaces, loadWorkspaceHandle, pickDirectory, rememberWorkspace, requestDirectoryPermission, type WorkspaceSummary } from "@/lib/storage/fsa-handle";
import { readWorkspaceManifest } from "@/services/api/local-workspace";
import { useStorageStore } from "@/stores/use-storage-store";

// 本地目录工作区的一等公民操作：最近列表、打开新目录、一键切换、移除记录。
// 供画布列表页的工作区条与设置页共用。
export function useWorkspaces() {
    const { message, modal } = App.useApp();
    const { t } = useTranslation();
    const store = useStorageStore();
    const [list, setList] = useState<WorkspaceSummary[]>([]);
    const [busy, setBusy] = useState(false);
    // 本地服务模式下的工作区路径：只有服务端知道真实目录，前端需读清单才能显示。
    const [servicePath, setServicePath] = useState("");

    const refresh = useCallback(async () => {
        setList(isFileSystemAccessSupported() ? await listWorkspaces() : []);
    }, []);

    useEffect(() => {
        void refresh();
    }, [refresh]);

    useEffect(() => {
        if (store.mode !== "service" || !store.serviceUrl) {
            setServicePath("");
            return;
        }
        let alive = true;
        void readWorkspaceManifest(store.serviceUrl, store.serviceToken)
            .then((info) => {
                if (alive) setServicePath(info.workspacePath);
            })
            .catch(() => {
                if (alive) setServicePath("");
            });
        return () => {
            alive = false;
        };
    }, [store.mode, store.serviceUrl, store.serviceToken]);

    const confirmReload = useCallback(() => {
        modal.confirm({
            title: t("config.storage.reloadTitle"),
            content: t("config.storage.reloadContent"),
            okText: t("config.storage.reloadNow"),
            cancelText: t("config.storage.reloadLater"),
            onOk: () => window.location.reload(),
        });
    }, [modal, t]);

    // 打开一个新目录并切为当前工作区。
    const openWorkspace = useCallback(async () => {
        if (!isFileSystemAccessSupported()) {
            message.error(t("config.storage.directoryUnsupported"));
            return;
        }
        setBusy(true);
        try {
            const handle = await pickDirectory();
            if (!handle) return;
            if (!(await requestDirectoryPermission(handle))) {
                message.error(t("config.storage.directoryDenied"));
                return;
            }
            const summary = await rememberWorkspace(handle);
            await refresh();
            store.update({ configured: true, mode: "directory", directoryId: summary.id, directoryName: summary.name });
            message.success(t("config.storage.workspaceOpened", { name: summary.name }));
            confirmReload();
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("config.storage.directoryPickFailed"));
        } finally {
            setBusy(false);
        }
    }, [message, t, refresh, store, confirmReload]);

    // 切换到最近工作区（必要时重新申请权限）。
    const switchWorkspace = useCallback(
        async (item: WorkspaceSummary) => {
            if (store.mode === "directory" && store.directoryId === item.id) return;
            try {
                const handle = await loadWorkspaceHandle(item.id);
                if (!handle) {
                    message.error(t("config.storage.workspaceMissing"));
                    await refresh();
                    return;
                }
                if (!(await hasDirectoryPermission(handle)) && !(await requestDirectoryPermission(handle))) {
                    message.error(t("config.storage.directoryDenied"));
                    return;
                }
                store.update({ configured: true, mode: "directory", directoryId: item.id, directoryName: item.name });
                confirmReload();
            } catch (error) {
                message.error(error instanceof Error ? error.message : t("config.storage.directoryPickFailed"));
            }
        },
        [message, t, refresh, store, confirmReload],
    );

    // 只从"最近"列表里移除记录，不删除磁盘上的目录。
    const removeWorkspace = useCallback(
        async (item: WorkspaceSummary) => {
            await forgetWorkspace(item.id);
            await refresh();
        },
        [refresh],
    );

    return {
        supported: isFileSystemAccessSupported(),
        mode: store.mode,
        currentId: store.directoryId,
        currentName: store.directoryName,
        servicePath,
        list,
        busy,
        openWorkspace,
        switchWorkspace,
        removeWorkspace,
    };
}
