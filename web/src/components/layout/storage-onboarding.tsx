import { Button, Modal } from "antd";
import { FolderOpen, Globe } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { useWorkspaces } from "@/hooks/use-workspaces";
import { useStorageStore } from "@/stores/use-storage-store";

// 首次使用引导：把"存储位置"这件事显式摆到用户面前，并推荐本地目录（本地优先）。
// 只在"从未选择过 且 浏览器支持本地目录"时出现一次；用户做出任一选择后不再打扰。
export function StorageOnboarding() {
    const { t } = useTranslation();
    const store = useStorageStore();
    const workspaces = useWorkspaces();
    const [open, setOpen] = useState(() => !store.configured && workspaces.supported);

    const chooseBrowser = () => {
        store.update({ configured: true });
        setOpen(false);
    };

    const chooseLocal = async () => {
        setOpen(false);
        await workspaces.openWorkspace();
        // 选目录失败/被拒时也要标记"已选择过"，否则每次刷新都会再弹一次。
        if (useStorageStore.getState().mode !== "directory") store.update({ configured: true });
    };

    // 关闭 = 先用浏览器存储；标记已选择过，避免反复打扰。
    const dismiss = () => {
        store.update({ configured: true });
        setOpen(false);
    };

    return (
        <Modal open={open} title={t("storageOnboarding.title")} footer={null} width={520} onCancel={dismiss}>
            <p className="text-sm text-stone-500">{t("storageOnboarding.description")}</p>
            <div className="mt-4 space-y-3">
                <section className="rounded-lg border border-stone-200 p-3 dark:border-stone-800">
                    <div className="flex items-center gap-2 text-sm font-semibold">
                        <FolderOpen className="size-4" />
                        {t("storageOnboarding.localTitle")}
                    </div>
                    <div className="mt-1 text-xs text-stone-500">{t("storageOnboarding.localDescription")}</div>
                    <Button className="mt-3" type="primary" loading={workspaces.busy} onClick={() => void chooseLocal()}>
                        {t("storageOnboarding.localAction")}
                    </Button>
                </section>
                <section className="rounded-lg border border-stone-200 p-3 dark:border-stone-800">
                    <div className="flex items-center gap-2 text-sm font-semibold">
                        <Globe className="size-4" />
                        {t("storageOnboarding.browserTitle")}
                    </div>
                    <div className="mt-1 text-xs text-stone-500">{t("storageOnboarding.browserDescription")}</div>
                    <Button className="mt-3" onClick={chooseBrowser}>
                        {t("storageOnboarding.browserAction")}
                    </Button>
                </section>
            </div>
        </Modal>
    );
}
