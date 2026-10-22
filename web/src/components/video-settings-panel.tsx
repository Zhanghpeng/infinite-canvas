import { Slider } from "antd";
import { type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import i18n from "@/i18n";
import { ImageSettingsTheme } from "@/components/image-settings-panel";
import { type CanvasTheme } from "@/lib/canvas-theme";
import { MINIMAX_VIDEO_SIZE_TIERS, normalizeVideoSizeValue, parseVideoSize, videoSizeOptions, type MiniMaxVideoTier } from "@/lib/canvas/video-size";
import { type AiConfig } from "@/stores/use-config-store";

// 尺寸档位与解析逻辑在 lib 里（分段链路也要用同一套口径），这里只做转出，
// 免得页面与组件各自维护一份档位表，改一处漏一处。
export { MINIMAX_VIDEO_SIZE_TIERS, normalizeVideoSizeValue, parseVideoSize, videoSizeOptions };
export type { MiniMaxVideoTier };

const quickSecondOptions = [5, 10, 15];

export const videoSecondOptions = quickSecondOptions.map((value) => String(value));
export const videoResolutionOptions = [{ value: "720", label: "720p" }];

type VideoSettingsPanelProps = {
    config: AiConfig;
    onConfigChange: (key: "vquality" | "size" | "videoSeconds" | "videoGenerateAudio" | "videoWatermark" | "videoMode", value: string) => void;
    theme: CanvasTheme;
    showTitle?: boolean;
    className?: string;
};

export function VideoSettingsPanel({ config, onConfigChange, theme, showTitle = true, className = "w-[320px] space-y-4 rounded-2xl px-1 py-0.5" }: VideoSettingsPanelProps) {
    const { t } = useTranslation();
    const videoMode = config.videoMode === "frame" ? "frame" : "omni";
    const rawSeconds = Number(config.videoSeconds);
    const secondsNum = Math.min(15, Math.max(1, Number.isFinite(rawSeconds) && rawSeconds > 0 ? rawSeconds : 5));
    const currentSize = normalizeVideoSizeValue(config.size);
    const { width: currentW, height: currentH, aspect, tier: selectedTier } = parseVideoSize(currentSize);

    const handleSelectTier = (tier: MiniMaxVideoTier) => {
        const nextW = aspect === "16:9" ? tier.landscapeW : tier.landscapeH;
        const nextH = aspect === "16:9" ? tier.landscapeH : tier.landscapeW;
        onConfigChange("size", `${nextW}x${nextH}`);
    };

    const handleSwitchAspect = (nextAspect: "16:9" | "9:16") => {
        if (nextAspect === aspect) return;
        const nextW = nextAspect === "16:9" ? selectedTier.landscapeW : selectedTier.landscapeH;
        const nextH = nextAspect === "16:9" ? selectedTier.landscapeH : selectedTier.landscapeW;
        onConfigChange("size", `${nextW}x${nextH}`);
    };

    return (
        <ImageSettingsTheme theme={theme}>
            <div className={className} style={{ color: theme.node.text }} onMouseDown={(event) => event.stopPropagation()}>
                {showTitle ? <div className="text-lg font-semibold">{t("settingsPanels.video.title")}</div> : null}

                {/* 0. 生成模式切换：全能参考 vs 首尾帧 */}
                <SettingGroup title="生成模式" color={theme.node.muted}>
                    <div className="grid grid-cols-2 gap-2">
                        <button
                            type="button"
                            className="flex h-10 cursor-pointer flex-col items-center justify-center rounded-xl border text-xs font-medium transition hover:opacity-85"
                            style={{
                                borderColor: videoMode === "omni" ? theme.node.text : theme.node.stroke,
                                background: videoMode === "omni" ? (theme.mode === "dark" ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.05)") : "transparent",
                                color: theme.node.text,
                            }}
                            onMouseDown={(event) => event.stopPropagation()}
                            onClick={() => onConfigChange("videoMode", "omni")}
                        >
                            <span className="font-semibold">全能参考 (Omni)</span>
                            <span className="text-[10px] leading-none opacity-55">多模态 (图/音/视频)</span>
                        </button>
                        <button
                            type="button"
                            className="flex h-10 cursor-pointer flex-col items-center justify-center rounded-xl border text-xs font-medium transition hover:opacity-85"
                            style={{
                                borderColor: videoMode === "frame" ? theme.node.text : theme.node.stroke,
                                background: videoMode === "frame" ? (theme.mode === "dark" ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.05)") : "transparent",
                                color: theme.node.text,
                            }}
                            onMouseDown={(event) => event.stopPropagation()}
                            onClick={() => onConfigChange("videoMode", "frame")}
                        >
                            <span className="font-semibold">首尾帧 (Frame)</span>
                            <span className="text-[10px] leading-none opacity-55">首帧 / 首尾帧插帧</span>
                        </button>
                    </div>
                </SettingGroup>

                {/* 1. 比例切换：16:9 横屏 vs 9:16 竖屏 */}
                <SettingGroup title="视频宽高比" color={theme.node.muted}>
                    <div className="grid grid-cols-2 gap-2">
                        <button
                            type="button"
                            className="flex h-9 cursor-pointer items-center justify-center gap-2 rounded-xl border text-xs font-medium transition hover:opacity-85"
                            style={{
                                borderColor: aspect === "16:9" ? theme.node.text : theme.node.stroke,
                                background: aspect === "16:9" ? (theme.mode === "dark" ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.05)") : "transparent",
                                color: theme.node.text,
                            }}
                            onMouseDown={(event) => event.stopPropagation()}
                            onClick={() => handleSwitchAspect("16:9")}
                        >
                            <span className="inline-block h-2.5 w-4 rounded-sm border-2" style={{ borderColor: theme.node.text }} />
                            <span>16:9 横屏</span>
                        </button>
                        <button
                            type="button"
                            className="flex h-9 cursor-pointer items-center justify-center gap-2 rounded-xl border text-xs font-medium transition hover:opacity-85"
                            style={{
                                borderColor: aspect === "9:16" ? theme.node.text : theme.node.stroke,
                                background: aspect === "9:16" ? (theme.mode === "dark" ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.05)") : "transparent",
                                color: theme.node.text,
                            }}
                            onMouseDown={(event) => event.stopPropagation()}
                            onClick={() => handleSwitchAspect("9:16")}
                        >
                            <span className="inline-block h-4 w-2.5 rounded-sm border-2" style={{ borderColor: theme.node.text }} />
                            <span>9:16 竖屏</span>
                        </button>
                    </div>
                </SettingGroup>

                {/* 2. 尺寸清晰度档位：直接显示当前比例下的真实宽高像素，副显档位说明 */}
                <SettingGroup title={`生成尺寸规格 (${aspect === "16:9" ? "横屏" : "竖屏"}，当前: ${currentW} × ${currentH})`} color={theme.node.muted}>
                    <div className="grid grid-cols-3 gap-2">
                        {MINIMAX_VIDEO_SIZE_TIERS.map((tier) => {
                            const itemW = aspect === "16:9" ? tier.landscapeW : tier.landscapeH;
                            const itemH = aspect === "16:9" ? tier.landscapeH : tier.landscapeW;
                            const isSelected = selectedTier.mp === tier.mp;

                            return (
                                <button
                                    key={tier.mp}
                                    type="button"
                                    className="flex h-[54px] cursor-pointer flex-col items-center justify-center gap-0.5 rounded-xl border transition hover:opacity-80"
                                    style={{
                                        borderColor: isSelected ? theme.node.text : theme.node.stroke,
                                        background: isSelected ? (theme.mode === "dark" ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.05)") : "transparent",
                                        color: theme.node.text,
                                    }}
                                    onMouseDown={(event) => event.stopPropagation()}
                                    onClick={() => handleSelectTier(tier)}
                                >
                                    <span className="text-xs font-semibold leading-tight tracking-tight">
                                        {itemW} × {itemH}
                                    </span>
                                    <span className="text-[10px] leading-none opacity-55">
                                        {tier.mp}
                                    </span>
                                </button>
                            );
                        })}
                    </div>
                </SettingGroup>

                {/* 3. 视频时长 */}
                <SettingGroup title={`视频时长: ${secondsNum} 秒`} color={theme.node.muted}>
                    <div className="grid grid-cols-3 gap-2">
                        {quickSecondOptions.map((value) => (
                            <OptionPill
                                key={value}
                                selected={secondsNum === value}
                                theme={theme}
                                onClick={() => onConfigChange("videoSeconds", String(value))}
                            >
                                {value} 秒
                            </OptionPill>
                        ))}
                    </div>
                    <div className="px-1 pt-1">
                        <Slider
                            min={1}
                            max={15}
                            step={1}
                            value={secondsNum}
                            tooltip={{ formatter: (v) => `${v} 秒` }}
                            onChange={(val) => onConfigChange("videoSeconds", String(val))}
                        />
                    </div>
                </SettingGroup>
            </div>
        </ImageSettingsTheme>
    );
}

export function videoResolutionLabel(_value: string) {
    return "720p";
}

export function videoSizeLabel(value: string) {
    const size = normalizeVideoSizeValue(value);
    const { width, height, aspect } = parseVideoSize(size);
    return `${width}×${height} (${aspect})`;
}

export function videoSecondsLabel(value: string) {
    const raw = Number(value);
    const s = Math.min(15, Math.max(1, Number.isFinite(raw) && raw > 0 ? raw : 5));
    return `${s}s`;
}

export function normalizeVideoResolutionValue(value?: string) {
    return "720";
}

function OptionPill({ selected, disabled = false, theme, onClick, children }: { selected: boolean; disabled?: boolean; theme: CanvasTheme; onClick: () => void; children: ReactNode }) {
    return (
        <button type="button" disabled={disabled} className="h-9 cursor-pointer rounded-xl border px-2 text-xs font-medium transition hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-35" style={{ background: selected ? (theme.mode === "dark" ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.05)") : "transparent", borderColor: selected ? theme.node.text : theme.node.stroke, color: theme.node.text }} onMouseDown={(event) => event.stopPropagation()} onClick={onClick}>
            {children}
        </button>
    );
}

function SettingGroup({ title, color, children }: { title: string; color: string; children: ReactNode }) {
    return (
        <div className="space-y-2">
            <div className="text-xs font-medium" style={{ color }}>
                {title}
            </div>
            {children}
        </div>
    );
}
