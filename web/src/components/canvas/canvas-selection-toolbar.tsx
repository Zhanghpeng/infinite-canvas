import { AlignCenterHorizontal, AlignCenterVertical, AlignEndHorizontal, AlignEndVertical, AlignHorizontalDistributeCenter, AlignStartHorizontal, AlignStartVertical, AlignVerticalDistributeCenter } from "lucide-react";
import { Tooltip } from "antd";
import { useTranslation } from "react-i18next";

import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import type { NodeAlignMode, NodeDistributeMode } from "@/lib/canvas/canvas-layout-actions";

type CanvasSelectionToolbarProps = {
    /** 选集包围盒在屏幕坐标系里的左边与顶边。 */
    left: number;
    top: number;
    placement: "above" | "below";
    count: number;
    onAlign: (mode: NodeAlignMode) => void;
    onDistribute: (mode: NodeDistributeMode) => void;
};

const ALIGN_ITEMS: Array<{ mode: NodeAlignMode; icon: typeof AlignStartVertical; label: string }> = [
    { mode: "left", icon: AlignStartVertical, label: "canvas.layout.alignLeft" },
    { mode: "centerX", icon: AlignCenterVertical, label: "canvas.layout.alignCenterX" },
    { mode: "right", icon: AlignEndVertical, label: "canvas.layout.alignRight" },
    { mode: "top", icon: AlignStartHorizontal, label: "canvas.layout.alignTop" },
    { mode: "centerY", icon: AlignCenterHorizontal, label: "canvas.layout.alignCenterY" },
    { mode: "bottom", icon: AlignEndHorizontal, label: "canvas.layout.alignBottom" },
];

/**
 * 多选时浮在选集上方的排版工具条。
 *
 * 位置由外面按视口换算好传进来：画布内部是缩放过的世界坐标，
 * 直接放进世界层会让按钮跟着缩放，缩到 20% 就点不到了。
 */
export function CanvasSelectionToolbar({ left, top, placement, count, onAlign, onDistribute }: CanvasSelectionToolbarProps) {
    const { t } = useTranslation();
    const colorTheme = useThemeStore((state) => state.theme);
    const theme = canvasThemes[colorTheme];
    const canDistribute = count >= 3;

    return (
        <div
            className="absolute z-40 flex h-9 items-center gap-0.5 rounded-lg border px-1 shadow-lg backdrop-blur"
            style={{
                left,
                top,
                transform: placement === "above" ? "translate(-50%, -100%)" : "translate(-50%, 0)",
                background: theme.toolbar.panel,
                borderColor: theme.toolbar.border,
                color: theme.toolbar.item,
                boxShadow: colorTheme === "dark" ? "0 12px 30px rgba(0,0,0,.34)" : "0 10px 24px rgba(28,25,23,.14)",
            }}
            onMouseDown={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
        >
            {ALIGN_ITEMS.map(({ mode, icon: Icon, label }) => (
                <Tooltip key={mode} title={t(label)}>
                    <button type="button" className="flex size-7 items-center justify-center rounded-md transition-colors hover:opacity-70" style={{ color: theme.toolbar.item }} aria-label={t(label)} onClick={() => onAlign(mode)}>
                        <Icon className="size-4" />
                    </button>
                </Tooltip>
            ))}
            <span className="mx-1 h-4 w-px" style={{ background: theme.toolbar.border }} />
            <Tooltip title={canDistribute ? t("canvas.layout.distributeX") : t("canvas.layout.needThree")}>
                <button
                    type="button"
                    className="flex size-7 items-center justify-center rounded-md transition-colors hover:opacity-70 disabled:cursor-not-allowed disabled:opacity-30"
                    style={{ color: theme.toolbar.item }}
                    aria-label={t("canvas.layout.distributeX")}
                    disabled={!canDistribute}
                    onClick={() => onDistribute("horizontal")}
                >
                    <AlignHorizontalDistributeCenter className="size-4" />
                </button>
            </Tooltip>
            <Tooltip title={canDistribute ? t("canvas.layout.distributeY") : t("canvas.layout.needThree")}>
                <button
                    type="button"
                    className="flex size-7 items-center justify-center rounded-md transition-colors hover:opacity-70 disabled:cursor-not-allowed disabled:opacity-30"
                    style={{ color: theme.toolbar.item }}
                    aria-label={t("canvas.layout.distributeY")}
                    disabled={!canDistribute}
                    onClick={() => onDistribute("vertical")}
                >
                    <AlignVerticalDistributeCenter className="size-4" />
                </button>
            </Tooltip>
        </div>
    );
}
