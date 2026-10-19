import type { ReactNode } from "react";
import { useEffect, useRef } from "react";
import { App } from "antd";
import { useTranslation } from "react-i18next";

import { createModelChannel, useConfigStore } from "@/stores/use-config-store";
import { useStorageStore } from "@/stores/use-storage-store";
import { usePromptSourceScheduler } from "@/hooks/use-prompt-source-scheduler";
import { useComfyuiMixedContentListener } from "@/hooks/use-comfyui-mixed-content-listener";
import { StorageOnboarding } from "@/components/layout/storage-onboarding";

export function ClientRootInit({ children }: { children: ReactNode }) {
    const { message } = App.useApp();
    const { t } = useTranslation();
    const handledConfigParams = useRef(false);
    const handledStorageNotice = useRef(false);
    const updateConfig = useConfigStore((state) => state.updateConfig);
    const config = useConfigStore((state) => state.config);
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const storageStatus = useStorageStore((state) => state.status);

    usePromptSourceScheduler();
    useComfyuiMixedContentListener();

    // 本地模式"没准备好"时，启动期只提示一次；此时已回退到浏览器存储，不会静默写坏数据。
    useEffect(() => {
        if (handledStorageNotice.current) return;
        const noticeByStatus: Partial<Record<string, string>> = {
            "service-unavailable": t("config.storage.unreachable"),
            "directory-unsupported": t("config.storage.directoryUnsupported"),
            "directory-needs-permission": t("config.storage.directoryNeedsPermission"),
        };
        const notice = noticeByStatus[storageStatus];
        if (!notice) return;
        handledStorageNotice.current = true;
        message.warning(notice);
    }, [storageStatus, message, t]);

    useEffect(() => {
        if (handledConfigParams.current) return;
        const searchParams = new URLSearchParams(window.location.search);
        const baseUrl = searchParams.get("baseUrl") || searchParams.get("baseurl");
        const apiKey = searchParams.get("apiKey") || searchParams.get("apikey");
        if (!baseUrl && !apiKey) return;
        handledConfigParams.current = true;
        searchParams.delete("baseUrl");
        searchParams.delete("baseurl");
        searchParams.delete("apiKey");
        searchParams.delete("apikey");
        window.history.replaceState(null, "", `${window.location.pathname}${searchParams.size ? `?${searchParams}` : ""}${window.location.hash}`);
        const firstChannel = config.channels[0];
        updateConfig(
            "channels",
            firstChannel
                ? config.channels.map((channel, index) =>
                      index === 0
                          ? {
                                ...channel,
                                ...(baseUrl ? { baseUrl } : {}),
                                ...(apiKey ? { apiKey } : {}),
                            }
                          : channel,
                  )
                : [createModelChannel({ id: "default", name: t("config.channels.defaultName"), baseUrl: baseUrl || undefined, apiKey: apiKey || "" })],
        );
        if (baseUrl) updateConfig("baseUrl", baseUrl);
        if (apiKey) updateConfig("apiKey", apiKey);
        openConfigDialog(false);
        message.success(t("config.importedDirectConfig"));
    }, [config.channels, message, openConfigDialog, t, updateConfig]);

    return (
        <>
            <StorageOnboarding />
            {children}
        </>
    );
}
