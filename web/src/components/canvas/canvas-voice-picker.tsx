import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { createPortal } from "react-dom";
import { Mic, Pause, Play, Search, Upload } from "lucide-react";
import { Button, Input, Slider } from "antd";

import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import { CANVAS_VOICES, searchVoices, voiceAudioUrl, voiceAssetUrl, voiceFacets, type CanvasVoice } from "@/lib/canvas/voice-library";
import { previewVoiceAudio, stopVoicePreview } from "@/lib/canvas/voice-preview";

type CanvasVoicePickerProps = {
    voiceId?: string;
    voiceName?: string;
    voiceAvatar?: string;
    /** 情绪强度，显示在 pill 上，不点开也看得见。 */
    strength: number;
    disabled?: boolean;
    buttonClassName?: string;
    onSelect: (voice: CanvasVoice) => void;
    onUpload: (file: File) => void;
    onStrengthChange: (value: number) => void;
    onOpenChange?: (open: boolean) => void;
};

/**
 * 音色选择弹层。
 *
 * 强度放在这里而不是单独一个 pill：强度是跟着音色卡走的（每张卡自带 emo_weight），
 * 语义上属于音色。塞进弹层后 pill 上直接显示 `阿盖 · 0.8`，不点开也看得见，
 * 控件数量没有增加 —— 而"再开一个滑杆入口"正是当年 audioSpeed 变成死字段的原因。
 */
export function CanvasVoicePicker({ voiceId, voiceName, voiceAvatar, strength, disabled, buttonClassName, onSelect, onUpload, onStrengthChange, onOpenChange }: CanvasVoicePickerProps) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const buttonRef = useRef<HTMLSpanElement>(null);
    const panelRef = useRef<HTMLDivElement>(null);
    const fileRef = useRef<HTMLInputElement>(null);
    const [open, setOpen] = useState(false);
    const [buttonRect, setButtonRect] = useState<DOMRect | null>(null);
    const [keyword, setKeyword] = useState("");
    const [typeFilter, setTypeFilter] = useState<string>("");
    const [styleFilter, setStyleFilter] = useState<string>("");
    const [playingId, setPlayingId] = useState<string | null>(null);

    /** 关掉弹层就别再响了：声音留在后台、又找不到是哪儿发的，是最烦的一种状态。 */
    const stopPreview = () => {
        stopVoicePreview();
        setPlayingId(null);
    };

    const updateOpen = (next: boolean) => {
        if (!next) stopPreview();
        setOpen(next);
        onOpenChange?.(next);
    };

    useEffect(() => stopVoicePreview, []);

    useEffect(() => {
        if (!open) return;
        const syncPosition = () => setButtonRect(buttonRef.current?.getBoundingClientRect() || null);
        const closeOnOutsidePointer = (event: PointerEvent) => {
            const target = event.target;
            if (!(target instanceof Node)) return;
            if (buttonRef.current?.contains(target) || panelRef.current?.contains(target)) return;
            if (target instanceof Element && target.closest(".ant-tooltip, .ant-popover, .ant-slider")) return;
            if (document.activeElement instanceof HTMLElement && panelRef.current?.contains(document.activeElement)) {
                document.activeElement.blur();
            }
            updateOpen(false);
        };
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape") updateOpen(false);
        };

        syncPosition();
        window.addEventListener("resize", syncPosition);
        window.addEventListener("scroll", syncPosition, true);
        window.addEventListener("pointerdown", closeOnOutsidePointer, true);
        window.addEventListener("keydown", handleKeyDown);
        return () => {
            window.removeEventListener("resize", syncPosition);
            window.removeEventListener("scroll", syncPosition, true);
            window.removeEventListener("pointerdown", closeOnOutsidePointer, true);
            window.removeEventListener("keydown", handleKeyDown);
        };
    }, [open]);

    const { types, styles } = useMemo(() => voiceFacets(), []);
    const voices = useMemo(() => {
        const base = searchVoices(keyword);
        return base.filter((voice) => (!typeFilter || voice.type === typeFilter) && (!styleFilter || voice.style === styleFilter));
    }, [keyword, typeFilter, styleFilter]);

    const current = voiceName || "选择音色";
    const label = voiceId ? `${current} · ${strength.toFixed(2)}` : current;

    const togglePreview = (voice: CanvasVoice) => {
        const url = voiceAudioUrl(voice);
        if (!url) return;
        if (playingId === voice.id) {
            stopPreview();
            return;
        }
        // 试听的就是生成时会拿去当参考的那份文件，不存在「试听好听、生成变了」。
        const audio = previewVoiceAudio(url);
        setPlayingId(voice.id);
        audio.addEventListener("ended", () => setPlayingId((current) => (current === voice.id ? null : current)));
    };

    const handleFile = (event: ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        if (file) onUpload(file);
        event.target.value = "";
    };

    return (
        <>
            <span ref={buttonRef} className="inline-flex min-w-0" onMouseDown={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()}>
                <Button
                    size="small"
                    type="text"
                    disabled={disabled}
                    className={buttonClassName || "!h-8 !max-w-[150px] !justify-start !rounded-full !px-2.5"}
                    style={{ background: theme.node.fill, color: voiceId ? theme.node.text : theme.node.muted }}
                    onClick={() => updateOpen(!open)}
                    icon={voiceAvatar ? <img src={voiceAssetUrl(voiceAvatar)} alt="" className="size-4 shrink-0 rounded-full object-cover" /> : <Mic className="size-3.5" />}
                >
                    <span className="truncate">{label}</span>
                </Button>
            </span>
            {open && buttonRect
                ? createPortal(
                      <div
                          ref={panelRef}
                          data-canvas-no-zoom
                          className="canvas-image-settings-popover thin-scrollbar"
                          style={popoverStyle(buttonRect, theme)}
                          onPointerDown={(event) => event.stopPropagation()}
                          onMouseDown={(event) => event.stopPropagation()}
                          onClick={(event) => event.stopPropagation()}
                      >
                          <div className="space-y-3">
                              <Input
                                  size="small"
                                  allowClear
                                  value={keyword}
                                  prefix={<Search className="size-3.5 opacity-50" />}
                                  placeholder="搜索名字、人设、风格"
                                  onChange={(event) => setKeyword(event.target.value)}
                              />

                              <FacetRow label="音别" value={typeFilter} options={types} onChange={setTypeFilter} theme={theme} />
                              <FacetRow label="风格" value={styleFilter} options={styles} onChange={setStyleFilter} theme={theme} />

                              <div className="grid max-h-[260px] grid-cols-2 gap-2 overflow-y-auto pr-1">
                                  {voices.map((voice) => {
                                      const active = voice.id === voiceId;
                                      const previewing = playingId === voice.id;
                                      return (
                                          <div
                                              key={voice.id}
                                              role="button"
                                              tabIndex={0}
                                              className="flex cursor-pointer items-start gap-2 rounded-xl border p-2 text-left transition-colors"
                                              style={{ borderColor: active ? theme.node.text : theme.toolbar.border, background: active ? theme.node.fill : "transparent" }}
                                              onClick={() => onSelect(voice)}
                                              onKeyDown={(event) => {
                                                  if (event.key !== "Enter" && event.key !== " ") return;
                                                  event.preventDefault();
                                                  onSelect(voice);
                                              }}
                                          >
                                              <span className="relative shrink-0">
                                                  {voice.avatar ? (
                                                      <img src={voiceAssetUrl(voice.avatar)} alt="" className="size-9 rounded-lg object-cover" />
                                                  ) : (
                                                      <span className="flex size-9 items-center justify-center rounded-lg text-xs" style={{ background: theme.node.fill }}>
                                                          {voice.name.slice(0, 1)}
                                                      </span>
                                                  )}
                                                  {/* 常驻而不是悬停才出现：能不能试听必须一眼看出来，靠 hover 猜等于没有。 */}
                                                  {voice.audio ? (
                                                      <button
                                                          type="button"
                                                          title={previewing ? "停止试听" : "试听"}
                                                          className="absolute -bottom-1 -right-1 flex size-4 items-center justify-center rounded-full shadow-sm transition-transform hover:scale-110"
                                                          style={{ background: previewing ? theme.node.text : "rgba(28,25,23,0.72)", color: previewing ? theme.toolbar.panel : "#fff" }}
                                                          onClick={(event) => {
                                                              event.stopPropagation();
                                                              togglePreview(voice);
                                                          }}
                                                      >
                                                          {previewing ? <Pause className="size-2.5" fill="currentColor" /> : <Play className="size-2.5 translate-x-px" fill="currentColor" />}
                                                      </button>
                                                  ) : null}
                                              </span>
                                              <span className="min-w-0 flex-1">
                                                  <span className="flex items-center gap-1">
                                                      <span className="truncate text-xs font-medium">{voice.name}</span>
                                                      {voice.emoMode === "speaker" ? (
                                                          <span className="shrink-0 rounded px-1 text-[10px] opacity-60" title="这个音色的情绪跟随参考音频，情绪描述不生效">
                                                              跟随音色
                                                          </span>
                                                      ) : null}
                                                  </span>
                                                  <span className="mt-0.5 line-clamp-2 block text-[11px] leading-4 opacity-60">{voice.description}</span>
                                              </span>
                                          </div>
                                      );
                                  })}
                                  {voices.length === 0 ? <div className="col-span-2 py-6 text-center text-xs opacity-50">没有匹配的音色</div> : null}
                              </div>

                              <div className="space-y-1 border-t pt-3" style={{ borderColor: theme.toolbar.border }}>
                                  <div className="flex items-center justify-between text-[11px] opacity-70">
                                      <span>情绪强度</span>
                                      <span>{strength.toFixed(2)}</span>
                                  </div>
                                  <Slider min={0} max={1} step={0.05} value={strength} onChange={onStrengthChange} tooltip={{ open: false }} />
                                  <p className="text-[11px] leading-4 opacity-50">超过 1 会开始显得卡通化，建议 0.6–0.9。</p>
                              </div>

                              <Button size="small" block icon={<Upload className="size-3.5" />} onClick={() => fileRef.current?.click()}>
                                  上传自己的音色
                              </Button>
                              <input ref={fileRef} type="file" accept="audio/*" hidden onChange={handleFile} />
                          </div>
                      </div>,
                      document.body,
                  )
                : null}
        </>
    );
}

type CanvasTheme = (typeof canvasThemes)[keyof typeof canvasThemes];

function FacetRow({ label, value, options, onChange, theme }: { label: string; value: string; options: string[]; onChange: (value: string) => void; theme: CanvasTheme }) {
    if (options.length === 0) return null;
    return (
        <div className="flex flex-wrap items-center gap-1">
            <span className="mr-1 text-[11px] opacity-50">{label}</span>
            {["", ...options].map((option) => {
                const active = option === value;
                return (
                    <button
                        key={option || "all"}
                        type="button"
                        className="rounded-full px-2 py-0.5 text-[11px]"
                        style={{ background: active ? theme.node.text : theme.node.fill, color: active ? theme.toolbar.panel : theme.node.text }}
                        onClick={() => onChange(option)}
                    >
                        {option || "全部"}
                    </button>
                );
            })}
        </div>
    );
}

/** 弹层定位：优先向下展开，下方放不下且上方更宽裕时翻到上面。 */
function popoverStyle(buttonRect: DOMRect, theme: CanvasTheme) {
    const width = 340;
    const gap = 8;
    const margin = 12;
    const spaceAbove = buttonRect.top - gap - margin;
    const spaceBelow = window.innerHeight - buttonRect.bottom - gap - margin;
    const isTop = spaceBelow < 420 && spaceAbove > spaceBelow;
    const left = Math.max(margin, Math.min(window.innerWidth - width - margin, buttonRect.left));
    return {
        position: "fixed",
        zIndex: 1200,
        width,
        left,
        ...(isTop ? { bottom: window.innerHeight - buttonRect.top + gap } : { top: buttonRect.bottom + gap }),
        maxHeight: Math.max(240, Math.min(window.innerHeight - margin * 2, isTop ? spaceAbove : spaceBelow)),
        background: theme.toolbar.panel,
        borderRadius: 18,
        boxShadow: "0 18px 54px rgba(28, 25, 23, 0.16)",
        padding: 14,
        overflowY: "auto",
        overflowX: "hidden",
        boxSizing: "border-box",
        color: theme.node.text,
    } as const;
}
