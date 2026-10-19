import { Button, Dropdown, type MenuProps } from "antd";
import { Check, FolderOpen, HardDrive } from "lucide-react";
import { useTranslation } from "react-i18next";

import { useWorkspaces } from "@/hooks/use-workspaces";

// 画布列表页的工作区条：显示当前工作区，并可一键切换最近工作区 / 打开本地目录。
// 在浏览器模式下也显示，作为"切换到本地目录"的入口。
export function CanvasWorkspaceBar() {
    const { t } = useTranslation();
    const { supported, mode, currentId, currentName, servicePath, list, busy, openWorkspace, switchWorkspace } = useWorkspaces();

    if (!supported) return null;

    const items: MenuProps["items"] = [
        ...list.map((item) => ({
            key: item.id,
            icon: item.id === currentId ? <Check className="size-4" /> : undefined,
            label: item.name,
            onClick: () => void switchWorkspace(item),
        })),
        ...(list.length ? [{ type: "divider" as const }] : []),
        { key: "open", icon: <FolderOpen className="size-4" />, label: t("canvas.workspace.openOther"), onClick: () => void openWorkspace() },
    ];

    // 本地服务模式的目录由服务端决定，前端无法切换，只展示路径。
    const service = mode === "service";

    return (
        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-stone-500">
            <HardDrive className="size-3.5" />
            <span>
                {mode === "directory" ? t("canvas.workspace.current", { name: currentName || t("canvas.workspace.none") }) : service ? t("canvas.workspace.service", { path: servicePath || t("canvas.workspace.none") }) : t("canvas.workspace.browser")}
            </span>
            {service ? null : (
                <Dropdown menu={{ items }} trigger={["click"]} disabled={busy}>
                    <Button size="small" type="text">
                        {mode === "directory" ? t("canvas.workspace.switch") : t("canvas.workspace.open")}
                    </Button>
                </Dropdown>
            )}
        </div>
    );
}
