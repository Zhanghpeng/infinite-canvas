import { useEffect, useMemo, useState } from "react";
import { ArrowUp, LoaderCircle, Maximize2, Minimize2, RefreshCw, Sparkles, Square } from "lucide-react";
import { Button, Modal, Segmented, Select, Tooltip, message } from "antd";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";

import { AudioModelPicker } from "@/components/audio-model-picker";
import { VideoModelPicker } from "@/components/video-model-picker";
import { ImageModelPicker } from "@/components/image-model-picker";
import { TextModelPicker } from "@/components/text-model-picker";
import { decodeChannelModel, defaultConfig, encodeChannelModel, findWorkflow, getDefaultWorkflow, isModelSupportedByHost, resolveModelChannel, resolveModelForCapability, useConfigStore, useEffectiveConfig, type AiConfig } from "@/stores/use-config-store";
import { BUILTIN_VIDEO_WORKFLOW_MODELS, evaluateModelAvailability, getModelProfile, imageQwen21Profile, textQwen35Profile } from "@/services/api/models";
import { getNodeResourceCounts } from "@/lib/canvas/canvas-node-geometry";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import { ChannelWorkflowPicker } from "@/components/channel-workflow-picker";
import { CanvasImageSettingsPopover } from "./canvas-image-settings-popover";
import { CanvasPromptLibrary } from "./canvas-prompt-library";
import { CanvasAudioSettingsPopover, type CanvasAudioSettingKey } from "./canvas-audio-settings-popover";
import { CanvasPromptChipInput } from "./canvas-prompt-chip-input";
import { CanvasVideoSettingsPopover } from "./canvas-video-settings-popover";
import { CanvasTextSettingsPopover } from "./canvas-text-settings-popover";
import { CanvasPromptExecutorPicker, CanvasPromptSkillPicker } from "./canvas-prompt-skill-picker";
import { resolveSkillProduces, type PromptAssistantConfig } from "@/lib/canvas/canvas-prompt-assistant";
import { voiceAssetUrl, voiceAudioUrl, type CanvasVoice } from "@/lib/canvas/voice-library";
import { setAudioEdgeMode, type CanvasAudioEdgeMode } from "@/lib/canvas/canvas-audio-channels";
import { uploadMediaFile } from "@/services/file-storage";
import { CanvasNodeType, type CanvasGenerationIntent, type CanvasGenerationMode, type CanvasNodeData, type CanvasNodeMetadata } from "@/types/canvas";
import type { CanvasResourceReference } from "@/lib/canvas/canvas-resource-references";
import { CanvasVoicePicker } from "./canvas-voice-picker";
import { CanvasNodeReferenceBar } from "./canvas-node-reference-bar";
import { CanvasVideoSegmentReference } from "./canvas-video-segment-reference";

export type CanvasNodeGenerationMode = CanvasGenerationMode;

type CanvasNodePromptPanelProps = {
    node: CanvasNodeData;
    isRunning: boolean;
    onPromptChange: (nodeId: string, prompt: string) => void;
    onConfigChange: (nodeId: string, patch: Partial<CanvasNodeData["metadata"]>) => void;
    onGenerate: (nodeId: string, mode: CanvasNodeGenerationMode, prompt: string, intent?: CanvasGenerationIntent) => void;
    onStop: (nodeId: string) => void;
    mentionReferences?: CanvasResourceReference[];
    nodes: CanvasNodeData[];
    connectedNodes?: CanvasNodeData[];
    onDisconnectReference?: (fromNodeId: string, toNodeId: string) => void;
    onStartReferenceSelection?: (nodeId: string) => void;
    onReorderReferences?: (toNodeId: string, orderedSourceNodeIds: string[]) => void;
    onLocateNode?: (nodeId: string) => void;
    onSettingsOpenChange?: (open: boolean) => void;
    onImageSettingsOpenChange?: (open: boolean) => void;
    /** 文本节点：底部的「执行者 / 技能」选择与按技能执行。 */
    promptAssistantConfig?: PromptAssistantConfig;
    onPromptAssistantChange?: (patch: Partial<PromptAssistantConfig>) => void;
    onOptimizePrompt?: (scope: "chapter" | "group") => void;
    isOptimizingPrompt?: boolean;
    onCancelOptimizePrompt?: () => void;
    promptAssistantDisabledReason?: string;
    modeOverride?: CanvasNodeGenerationMode; // Plugin nodes set their generation type through useBuiltinPanel.mode.
};

export function CanvasNodePromptPanel({
    node,
    nodes,
    isRunning,
    onPromptChange,
    onConfigChange,
    onGenerate,
    onStop,
    mentionReferences = [],
    connectedNodes = [],
    onDisconnectReference,
    onStartReferenceSelection,
    onReorderReferences,
    onLocateNode,
    onSettingsOpenChange,
    onImageSettingsOpenChange,
    promptAssistantConfig,
    onPromptAssistantChange,
    onOptimizePrompt,
    isOptimizingPrompt = false,
    onCancelOptimizePrompt,
    promptAssistantDisabledReason,
    modeOverride,
}: CanvasNodePromptPanelProps) {
    const handleSettingsOpenChange = onSettingsOpenChange || onImageSettingsOpenChange;
    const { t } = useTranslation();
    const [scope, setScope] = useState<"chapter" | "group">("chapter");
    const globalConfig = useEffectiveConfig();
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const mode = modeOverride ?? defaultMode(node.type);
    const config = buildNodeConfig(globalConfig, node, mode);
    const hasTextContent = node.type === CanvasNodeType.Text && Boolean(node.metadata?.content?.trim());
    const hasImageContent = node.type === CanvasNodeType.Image && Boolean(node.metadata?.content);
    const hasVideoContent = node.type === CanvasNodeType.Video && Boolean(node.metadata?.content);
    const hasAudioContent = node.type === CanvasNodeType.Audio && Boolean(node.metadata?.content);
    const isEditingExistingContent = hasTextContent || hasImageContent || hasVideoContent || hasAudioContent;
    // 段节点：它的参考（角色图 + 首尾帧 + 参考片段）由分段处理写入 metadata，
    // 不来自画布连线。展示与生成都得走分段那套，否则用户改完提示词点生成，
    // 拿到的是另一条不带任何参考的独立视频。
    const segmentInfo = node.metadata?.videoSegment;
    const canRepeat = node.metadata?.status === "success";
    const isGenerating = isRunning || node.metadata?.status === "loading";
    const [prompt, setPrompt] = useState(node.metadata?.composerContent ?? node.metadata?.prompt ?? "");
    const [emotionText, setEmotionText] = useState(node.metadata?.emotionText ?? "");
    // 同一个音频节点跑两条产线：配乐（caption/lyrics）与配音（台词 + 情绪 + 音色）。
    // 不新造节点类型 —— 缺省按 music 处理，历史节点零迁移。
    const audioKind = node.metadata?.audioKind === "voice" ? "voice" : "music";
    const isVoiceNode = mode === "audio" && audioKind === "voice";
    const voiceEmoMode = node.metadata?.voiceEmoMode === "speaker" ? "speaker" : "text";
    const [expanded, setExpanded] = useState(false);
    const [isFullscreen, setIsFullscreen] = useState(false);

    const connectedResources = useMemo(() => {
        let images = 0;
        let videos = 0;
        let audios = 0;
        for (const src of connectedNodes) {
            const counts = getNodeResourceCounts(src, nodes);
            images += counts.images;
            videos += counts.videos;
            audios += counts.audios;
        }
        return { images, videos, audios };
    }, [connectedNodes, nodes]);

    const videoModelAvailability = useMemo(() => {
        if (mode !== "video") return { isAvailable: true, reasons: [] };
        const effectiveModelId = node.metadata?.modelId || (node.metadata?.videoMode === "frame" || config.videoMode === "frame" ? "frame-video-minimax-h3-fp8-4step-pdmd" : "omni-video-minimax-h3-fp8-4step-pdmd");
        const profile = getModelProfile(effectiveModelId) || BUILTIN_VIDEO_WORKFLOW_MODELS[0];
        const activeChannel = globalConfig.channels.find((c) => c.id === (node.metadata?.channelId || globalConfig.channelId)) || globalConfig.channels[0];
        return evaluateModelAvailability({
            targetModel: profile,
            connectedImages: connectedResources.images,
            connectedVideos: connectedResources.videos,
            connectedAudios: connectedResources.audios,
            promptText: prompt,
            activeChannel,
        });
    }, [mode, node.metadata?.modelId, node.metadata?.videoMode, node.metadata?.channelId, config.videoMode, globalConfig.channels, globalConfig.channelId, connectedResources, prompt]);

    const imageModelAvailability = useMemo(() => {
        if (mode !== "image") return { isAvailable: true, reasons: [] };
        const effectiveModelId = node.metadata?.modelId || config.imageModel || "image-qwen-2.1";
        const profile = getModelProfile(effectiveModelId) || imageQwen21Profile;
        const activeChannel = globalConfig.channels.find((c) => c.id === (node.metadata?.channelId || globalConfig.channelId)) || globalConfig.channels[0];
        return evaluateModelAvailability({
            targetModel: profile,
            connectedImages: connectedResources.images,
            connectedVideos: connectedResources.videos,
            connectedAudios: connectedResources.audios,
            promptText: prompt,
            activeChannel,
        });
    }, [mode, node.metadata?.modelId, config.imageModel, node.metadata?.channelId, globalConfig.channels, globalConfig.channelId, connectedResources, prompt]);

    const textModelAvailability = useMemo(() => {
        if (mode !== "text") return { isAvailable: true, reasons: [] };
        const effectiveModelId = node.metadata?.modelId || "text-qwen-35";
        const profile = getModelProfile(effectiveModelId) || textQwen35Profile;
        const activeChannel = globalConfig.channels.find((c) => c.id === (node.metadata?.channelId || globalConfig.channelId)) || globalConfig.channels[0];
        return evaluateModelAvailability({
            targetModel: profile,
            connectedImages: connectedResources.images,
            connectedVideos: connectedResources.videos,
            connectedAudios: connectedResources.audios,
            promptText: prompt,
            activeChannel,
        });
    }, [mode, node.metadata?.modelId, node.metadata?.channelId, globalConfig.channels, globalConfig.channelId, connectedResources, prompt]);

    const isCurrentModelAvailable = mode === "video"
        ? videoModelAvailability.isAvailable
        : mode === "image"
        ? imageModelAvailability.isAvailable
        : mode === "text"
        ? textModelAvailability.isAvailable
        : true;
    const currentModelUnavailabilityReasons = mode === "video"
        ? videoModelAvailability.reasons
        : mode === "image"
        ? imageModelAvailability.reasons
        : mode === "text"
        ? textModelAvailability.reasons
        : [];

    // Restore prompts only when switching nodes; preserve the current input after generation on the same node.
    useEffect(() => {
        setPrompt(node.metadata?.composerContent ?? node.metadata?.prompt ?? "");
        setEmotionText(node.metadata?.emotionText ?? "");
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [node.id]);

    const updatePrompt = (value: string) => {
        setPrompt(value);
        if (isEditingExistingContent) onConfigChange(node.id, { composerContent: value });
        else onPromptChange(node.id, value);
    };

    const hasVoice = Boolean(node.metadata?.voiceSource || node.metadata?.voiceId);

    /**
     * 切换某条音频入边的用途。
     *
     * 写回时会把"与默认推断一致"的条目删掉，所以上游以后从音乐改成配音，
     * 这条入边会跟着变回音轨，而不是被一条看不见的旧覆盖压住。
     */
    const handleAudioEdgeModeChange = (sourceNodeId: string, edgeMode: CanvasAudioEdgeMode) => {
        const source = nodes.find((item) => item.id === sourceNodeId);
        if (!source) return;
        onConfigChange(node.id, { audioEdgeModes: setAudioEdgeMode(node.metadata?.audioEdgeModes, source, edgeMode) });
    };

    const patchMetadata = (patch: Partial<CanvasNodeMetadata>) => onConfigChange(node.id, patch);

    /** 选中音色卡：音色、模式、强度、参考音频一次性落到节点上。 */
    const selectVoice = (voice: CanvasVoice) => {
        const patch: Partial<CanvasNodeMetadata> = {
            voiceId: voice.id,
            voiceName: voice.name,
            voiceAvatar: voice.avatar || undefined,
            voiceSource: voiceAudioUrl(voice),
            voiceEmoMode: voice.emoMode,
            emotionStrength: voice.emoWeight,
            // 换了音色，之前缓存的 ComfyUI 文件名指向的是上一个音色的文件，必须作废。
            voiceAudioName: undefined,
        };
        // 卡里那句情绪描述是实测过的，白给；但只在用户还没动手写的时候才填。
        if (!emotionText.trim() && voice.emoMode === "text" && voice.emoText) {
            patch.emotionText = voice.emoText;
            setEmotionText(voice.emoText);
        }
        patchMetadata(patch);
    };

    const uploadVoice = async (file: File) => {
        try {
            const uploaded = await uploadMediaFile(file, "audio");
            patchMetadata({
                voiceId: undefined,
                voiceName: file.name.replace(/\.[^.]+$/, ""),
                voiceAvatar: undefined,
                // 自定义音色没有卡片，存媒体库的 storageKey；生成前再解析成可取用的地址。
                voiceSource: uploaded.storageKey,
                voiceEmoMode: "text",
                voiceAudioName: undefined,
                emotionStrength: node.metadata?.emotionStrength ?? 0.8,
            });
        } catch {
            message.error(t("canvas.promptPanel.voiceUploadFailed"));
        }
    };

    // 选了技能就走技能执行（执行者/形态由技能决定），没选就是原来的文本生成。
    const canSkillRun = Boolean(mode === "text" && promptAssistantConfig?.backend === "agent" && promptAssistantConfig.skill && onOptimizePrompt);
    // 执行者已是本地 Agent 但还没选技能：按钮置灰并说明先选技能，避免落到「渠道生成」的歧义上。
    const agentNeedsSkill = Boolean(mode === "text" && promptAssistantConfig?.backend === "agent" && !promptAssistantConfig.skill);
    const promptAssistantScopeVisible = Boolean(canSkillRun && resolveSkillProduces(promptAssistantConfig!) === "nodes" && node.metadata?.groupId);
    // 上游：只有图片参考时允许空提示词直接提交（纯反推 / 风格提取这类）。
    const canSubmitEmptyPrompt = mode === "text" && connectedResources.images > 0;

    const submit = (intent: CanvasGenerationIntent = canRepeat ? "repeat" : "new") => {
        if (isGenerating || isOptimizingPrompt) return;
        // 选了技能（且执行者是本地 Agent）时，回车与主按钮都按技能执行。
        if (canSkillRun) {
            onOptimizePrompt?.(scope);
            return;
        }
        const text = prompt.trim();
        if ((!text && intent !== "repeat" && !canSubmitEmptyPrompt) || isGenerating) return;

        // 没选音色时不能像视频那样"剪掉参考节点"：音色是配音生成节点的必需输入，
        // 剪了只会变成缺输入的 400，报错还指向工作流。所以在入口把话说明白。
        if (isVoiceNode && !hasVoice) {
            message.warning(t("canvas.promptPanel.voiceRequired"));
            return;
        }

        // 视频生成前校验当前主机与模型多维约束（规范模式）
        if (mode === "video") {
            if (!videoModelAvailability.isAvailable) {
                Modal.warning({
                    title: "无法生成视频（存在不兼容项）",
                    content: (
                        <div className="space-y-2 pt-2 text-xs">
                            <div>当前视频节点存在以下约束限制，请修正后再生成：</div>
                            <div className="space-y-1 rounded bg-stone-100 p-2 dark:bg-stone-800">
                                {videoModelAvailability.reasons.map((r, i) => (
                                    <div key={i} className="flex items-start gap-1.5">
                                        <span className="text-amber-500 font-bold">•</span>
                                        <span>{r}</span>
                                    </div>
                                ))}
                            </div>
                        </div>
                    ),
                    okText: "我知道了",
                });
                return;
            }
        }

        // 图片生成前校验当前主机与模型多维约束（规范模式）
        if (mode === "image") {
            if (!imageModelAvailability.isAvailable) {
                Modal.warning({
                    title: "无法生成图片（存在不兼容项）",
                    content: (
                        <div className="space-y-2 pt-2 text-xs">
                            <div>当前图片节点存在以下约束限制，请修正后再生成：</div>
                            <div className="space-y-1 rounded bg-stone-100 p-2 dark:bg-stone-800">
                                {imageModelAvailability.reasons.map((r, i) => (
                                    <div key={i} className="flex items-start gap-1.5">
                                        <span className="text-amber-500 font-bold">•</span>
                                        <span>{r}</span>
                                    </div>
                                ))}
                            </div>
                        </div>
                    ),
                    okText: "我知道了",
                });
                return;
            }
        }
        onGenerate(node.id, mode, text, intent);
    };

    const openExpandedEditor = () => {
        setExpanded(true);
        setIsFullscreen(false);
    };

    const closeExpandedEditor = () => {
        setExpanded(false);
        setIsFullscreen(false);
    };

    return (
        <div
            data-canvas-no-zoom
            className="rounded-2xl border p-3 shadow-2xl backdrop-blur"
            style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text }}
            onMouseDown={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
            onWheel={(event) => event.stopPropagation()}
        >
            {segmentInfo ? (
                <CanvasVideoSegmentReference node={node} nodes={nodes} onLocateNode={onLocateNode} />
            ) : (
                <>
                    <CanvasNodeReferenceBar
                        nodeId={node.id}
                        nodes={nodes}
                        connectedNodes={connectedNodes}
                        onDisconnect={onDisconnectReference}
                        onStartSelection={onStartReferenceSelection}
                        onReorder={onReorderReferences}
                        onLocateNode={onLocateNode}
                        onAudioEdgeModeChange={handleAudioEdgeModeChange}
                    />
                    {mode === "text" && connectedResources.images > 0 && (
                        <div className="mb-2 flex items-center gap-1.5 overflow-x-auto py-0.5 text-xs">
                            <span className="shrink-0 text-stone-400 dark:text-stone-500">快捷指令:</span>
                            <button
                                type="button"
                                className="shrink-0 rounded-full border border-stone-200 px-2.5 py-0.5 text-xs transition hover:border-purple-400 hover:text-purple-500 dark:border-stone-700"
                                onClick={() => updatePrompt("请根据参考图片反推一段适合用于 AI 生图的提示词。涵盖主体、构图、光影、色彩与质感。")}
                            >
                                生图反推
                            </button>
                            <button
                                type="button"
                                className="shrink-0 rounded-full border border-stone-200 px-2.5 py-0.5 text-xs transition hover:border-purple-400 hover:text-purple-500 dark:border-stone-700"
                                onClick={() => updatePrompt("详细分析提取这张图片的视觉风格、艺术流派、配色方案与渲染材质。")}
                            >
                                风格提取
                            </button>
                            <button
                                type="button"
                                className="shrink-0 rounded-full border border-stone-200 px-2.5 py-0.5 text-xs transition hover:border-purple-400 hover:text-purple-500 dark:border-stone-700"
                                onClick={() => updatePrompt("用详细的自然语言描述画面中的主体、人物姿态、镜头机位与环境分镜。")}
                            >
                                分镜描述
                            </button>
                        </div>
                    )}
                </>
            )}
            <CanvasPromptChipInput
                value={prompt}
                references={mentionReferences}
                onChange={updatePrompt}
                onSubmit={submit}
                className={cn("thin-scrollbar w-full cursor-text resize-none rounded-xl px-3 py-2 text-sm leading-5 outline-none", isVoiceNode ? "h-32" : "h-40")}
                style={{ background: "transparent", color: theme.node.text }}
                placeholder={
                    isVoiceNode
                        ? t("canvas.promptPanel.voiceScript")
                        : mode === "text" && connectedResources.images > 0
                        ? "输入看图指令（留空默认执行生图提示词反推）..."
                        : t(`canvas.promptPanel.${mode === "image" && hasImageContent ? "editImage" : mode === "text" && hasTextContent ? "editText" : mode}`)
                }
            />

            {isVoiceNode ? (
                <>
                    {/* 台词要能 @ 引用文本节点，情绪不需要 —— 它是给模型的一句自然语言描述。 */}
                    <div className="my-2 border-t border-dashed" style={{ borderColor: theme.toolbar.border }} />
                    <div className="px-3">
                        <div className="mb-1 flex items-baseline justify-between gap-2 text-[11px]" style={{ color: theme.node.muted }}>
                            <span>{t("canvas.promptPanel.voiceEmotion")}</span>
                            {voiceEmoMode === "speaker" ? <span className="shrink-0">{t("canvas.promptPanel.voiceEmotionDisabled")}</span> : null}
                        </div>
                        <textarea
                            className="thin-scrollbar h-16 w-full resize-none rounded-xl px-3 py-2 text-sm leading-5 outline-none"
                            style={{ background: "transparent", color: theme.node.text, opacity: voiceEmoMode === "speaker" ? 0.5 : 1 }}
                            value={emotionText}
                            disabled={voiceEmoMode === "speaker"}
                            placeholder={voiceEmoMode === "speaker" ? t("canvas.promptPanel.voiceEmotionDisabled") : t("canvas.promptPanel.voiceEmotionHint")}
                            onChange={(event) => {
                                setEmotionText(event.target.value);
                                patchMetadata({ emotionText: event.target.value });
                            }}
                        />
                    </div>
                </>
            ) : null}

            <div className="mt-2 flex min-w-0 flex-wrap items-center justify-between gap-2">
                <div className="flex min-w-0 flex-1 items-center gap-2">
                    <Tooltip title={t("canvas.promptPanel.expandEditor")}>
                        <Button type="text" className="!h-8 !w-8 !min-w-8 shrink-0 !rounded-full !bg-transparent !p-0" style={{ color: theme.node.text }} icon={<Maximize2 className="size-3.5" />} onClick={openExpandedEditor} aria-label={t("canvas.promptPanel.expandEditor")} />
                    </Tooltip>
                    <CanvasPromptLibrary onSelect={updatePrompt} />
                    {mode === "image" ? (
                        <>
                            <ImageModelPicker
                                channelId={node.metadata?.channelId || config.channelId}
                                modelId={node.metadata?.modelId || config.imageModel || "image-qwen-2.1"}
                                connectedImages={connectedResources.images}
                                connectedVideos={connectedResources.videos}
                                connectedAudios={connectedResources.audios}
                                promptText={prompt}
                                onChange={(nextChannelId, nextModelId) => {
                                    onConfigChange(node.id, {
                                        channelId: nextChannelId,
                                        modelId: nextModelId,
                                    });
                                }}
                            />
                            <CanvasImageSettingsPopover
                                modelId={node.metadata?.modelId || config.imageModel || "image-qwen-2.1"}
                                config={config}
                                placement="topLeft"
                                buttonClassName="!h-10 min-w-0 !max-w-[160px] !justify-start !rounded-full !px-3"
                                onConfigChange={(key, value) => onConfigChange(node.id, key === "count" ? { count: Number(value) || 1 } : { [key]: value })}
                                onMissingConfig={() => openConfigDialog(true)}
                                onOpenChange={handleSettingsOpenChange}
                            />
                        </>
                    ) : mode === "video" ? (
                        <>
                            <VideoModelPicker
                                channelId={node.metadata?.channelId || config.channelId}
                                modelId={node.metadata?.modelId || (node.metadata?.videoMode === "frame" || config.videoMode === "frame" ? "frame-video-minimax-h3-fp8-4step-pdmd" : "omni-video-minimax-h3-fp8-4step-pdmd")}
                                connectedImages={connectedResources.images}
                                connectedVideos={connectedResources.videos}
                                connectedAudios={connectedResources.audios}
                                promptText={prompt}
                                onChange={(nextChannelId, nextModelId, profile) => {
                                    const nextVideoMode = profile.category === "frameVideo" ? "frame" : "omni";
                                    onConfigChange(node.id, {
                                        channelId: nextChannelId,
                                        modelId: nextModelId,
                                        videoMode: nextVideoMode,
                                    });
                                }}
                            />
                            <CanvasVideoSettingsPopover
                                modelId={node.metadata?.modelId || (node.metadata?.videoMode === "frame" || config.videoMode === "frame" ? "frame-video-minimax-h3-fp8-4step-pdmd" : "omni-video-minimax-h3-fp8-4step-pdmd")}
                                size={node.metadata?.size || config.size}
                                duration={node.metadata?.seconds || config.videoSeconds}
                                videoMode={(node.metadata?.videoMode as "omni" | "frame") || (config.videoMode as "omni" | "frame")}
                                onParamChange={(patch) => {
                                    onConfigChange(node.id, patch);
                                }}
                                config={config}
                                buttonClassName="!h-10 min-w-0 !max-w-[160px] !justify-start !rounded-full !px-3"
                                onConfigChange={(key, value) => onConfigChange(node.id, videoConfigPatch(key, value, config))}
                                onOpenChange={handleSettingsOpenChange}
                            />
                        </>
                    ) : mode === "audio" ? (
                        <>
                            <Segmented
                                size="small"
                                value={audioKind}
                                onChange={(value) =>
                                    onConfigChange(node.id, {
                                        audioKind: value === "voice" ? "voice" : "music",
                                        // 换了产线，之前选的工作流属于另一条产线，留着会拿配乐工作流去配音。
                                        workflowId: undefined,
                                    })
                                }
                                options={[
                                    { label: t("canvas.promptPanel.voiceKindMusic"), value: "music" },
                                    { label: t("canvas.promptPanel.voiceKindVoice"), value: "voice" },
                                ]}
                            />
                            {isVoiceNode ? (
                                <>
                                    <ChannelWorkflowPicker
                                        category="voice"
                                        channelId={node.metadata?.channelId}
                                        workflowId={node.metadata?.workflowId}
                                        onChange={(channelId, workflowId) => onConfigChange(node.id, { channelId, workflowId })}
                                    />
                                    <CanvasVoicePicker
                                        voiceId={node.metadata?.voiceId}
                                        voiceName={node.metadata?.voiceName}
                                        voiceAvatar={node.metadata?.voiceAvatar}
                                        strength={node.metadata?.emotionStrength ?? 0.8}
                                        buttonClassName="!h-10 min-w-0 !max-w-[160px] !justify-start !rounded-full !px-3"
                                        onSelect={selectVoice}
                                        onUpload={(file) => void uploadVoice(file)}
                                        onStrengthChange={(value) => patchMetadata({ emotionStrength: value })}
                                        onOpenChange={handleSettingsOpenChange}
                                    />
                                </>
                            ) : (
                                <>
                                    <AudioModelPicker
                                        channelId={node.metadata?.channelId || config.channelId}
                                        modelId={node.metadata?.modelId || "audio-minimax-music-3"}
                                        connectedImages={connectedResources.images}
                                        connectedVideos={connectedResources.videos}
                                        connectedAudios={connectedResources.audios}
                                        promptText={prompt}
                                        onChange={(nextChannelId, nextModelId) => {
                                            onConfigChange(node.id, {
                                                channelId: nextChannelId,
                                                modelId: nextModelId,
                                            });
                                        }}
                                    />
                                    <CanvasAudioSettingsPopover
                                        config={config}
                                        modelId={node.metadata?.modelId || "audio-minimax-music-3"}
                                        buttonClassName="!h-10 min-w-0 !max-w-[160px] !justify-start !rounded-full !px-3"
                                        onConfigChange={(key, value) => onConfigChange(node.id, audioConfigPatch(key, value))}
                                        onOpenChange={handleSettingsOpenChange}
                                    />
                                </>
                            )}
                        </>
                    ) : (
                        <>
                            <TextModelPicker
                                channelId={node.metadata?.channelId || config.channelId}
                                modelId={node.metadata?.modelId || "text-qwen-35"}
                                connectedImages={connectedResources.images}
                                connectedVideos={connectedResources.videos}
                                connectedAudios={connectedResources.audios}
                                promptText={prompt}
                                onChange={(nextChannelId, nextModelId) => {
                                    onConfigChange(node.id, {
                                        channelId: nextChannelId,
                                        modelId: nextModelId,
                                    });
                                }}
                            />
                            {promptAssistantConfig && onPromptAssistantChange ? (
                                <>
                                    <CanvasPromptExecutorPicker
                                        config={{ ...promptAssistantConfig, channelId: promptAssistantConfig.channelId || node.metadata?.channelId }}
                                        onChange={onPromptAssistantChange}
                                        onChannelChange={(channelId) => onConfigChange(node.id, { channelId })}
                                    />
                                    {/* 渠道执行时保留原来的文本工作流下拉（只渲染工作流，渠道已在上面的执行者里选）；选了技能就不需要它了。 */}
                                    {promptAssistantConfig.backend === "comfyui" ? (
                                        <ChannelWorkflowPicker
                                            category="text"
                                            showChannel={false}
                                            channelId={node.metadata?.channelId}
                                            workflowId={node.metadata?.workflowId}
                                            onChange={(channelId, workflowId) => onConfigChange(node.id, { channelId, workflowId })}
                                        />
                                    ) : null}
                                    {promptAssistantConfig.backend === "agent" ? <CanvasPromptSkillPicker config={promptAssistantConfig} onChange={onPromptAssistantChange} /> : null}
                                    {promptAssistantScopeVisible ? (
                                        <Select
                                            size="small"
                                            className="w-[104px] shrink-0"
                                            popupMatchSelectWidth={false}
                                            value={scope}
                                            onChange={setScope}
                                            options={[
                                                { value: "chapter", label: t("canvas.promptAssistant.scopeSingle") },
                                                { value: "group", label: t("canvas.promptAssistant.scopeGroup") },
                                            ]}
                                        />
                                    ) : null}
                                </>
                            ) : null}
                            <CanvasTextSettingsPopover
                                modelId={node.metadata?.modelId || "text-qwen-35"}
                                maxLength={node.metadata?.maxLength}
                                thinking={node.metadata?.thinking}
                                onParamChange={(patch) => onConfigChange(node.id, patch)}
                                config={config}
                                count={node.metadata?.textCount || 1}
                                buttonClassName="!h-10 min-w-0 !max-w-[160px] !justify-start !rounded-full !px-3"
                                onCountChange={(textCount) => onConfigChange(node.id, { textCount })}
                                onOpenChange={handleSettingsOpenChange}
                            />
                        </>
                    )}
                </div>
                {isOptimizingPrompt ? (
                    <Button type="primary" danger className="ml-auto !h-10 shrink-0 !rounded-full !px-3" onClick={() => onCancelOptimizePrompt?.()} aria-label={t("canvas.promptAssistant.cancel")}>
                        <span className="flex items-center gap-1.5">
                            <LoaderCircle className="size-4 animate-spin" />
                            <Square className="size-3.5 fill-current" />
                        </span>
                    </Button>
                ) : isGenerating ? (
                    <Button type="primary" danger className="ml-auto !h-10 shrink-0 !rounded-full !px-3" onClick={() => onStop(node.id)} aria-label={t("canvas.promptPanel.stopGeneration")}>
                        <span className="flex items-center gap-1.5">
                            <LoaderCircle className="size-4 animate-spin" />
                            <Square className="size-3.5 fill-current" />
                            <span className="text-xs font-medium">{t("canvas.promptPanel.stop")}</span>
                        </span>
                    </Button>
                ) : canSkillRun ? (
                    <Tooltip title={promptAssistantDisabledReason || t("canvas.promptAssistant.entryHint")}>
                        <Button type="primary" className="ml-auto !h-10 !min-w-16 shrink-0 !rounded-full !px-3" disabled={Boolean(promptAssistantDisabledReason)} onClick={() => onOptimizePrompt?.(scope)} aria-label={t("canvas.promptAssistant.runSkill")}>
                            <Sparkles className="size-4" />
                        </Button>
                    </Tooltip>
                ) : canRepeat ? (
                    !isCurrentModelAvailable ? (
                        <Tooltip
                            title={
                                <div className="space-y-1 text-xs">
                                    <div className="font-semibold text-amber-300">无法再次生成（存在不兼容项）：</div>
                                    {currentModelUnavailabilityReasons.map((r, i) => (
                                        <div key={i}>• {r}</div>
                                    ))}
                                </div>
                            }
                        >
                            <span>
                                <Button type="primary" className="ml-auto !h-10 !rounded-full !px-4" icon={<RefreshCw className="size-3.5" />} disabled>
                                    {t("canvas.promptPanel.repeatGeneration")}
                                </Button>
                            </span>
                        </Tooltip>
                    ) : (
                        <span className="ml-auto shrink-0">
                            <Tooltip title={segmentInfo ? t("canvas.videoTimeline.reference.rerunHint") : undefined}>
                                <Button type="primary" className="!h-10 !rounded-full !px-4" icon={<RefreshCw className="size-3.5" />} onClick={() => submit("repeat")}>
                                    {segmentInfo ? t("canvas.videoTimeline.reference.rerun") : t("canvas.promptPanel.repeatGeneration")}
                                </Button>
                            </Tooltip>
                        </span>
                    )
                ) : (
                    !isCurrentModelAvailable ? (
                        <Tooltip
                            title={
                                <div className="space-y-1 text-xs">
                                    <div className="font-semibold text-amber-300">无法生成（存在不兼容项）：</div>
                                    {currentModelUnavailabilityReasons.map((r, i) => (
                                        <div key={i}>• {r}</div>
                                    ))}
                                </div>
                            }
                        >
                            <span>
                                <Button type="primary" className="ml-auto !h-10 !min-w-16 shrink-0 !rounded-full !px-3" disabled aria-label={t("canvas.promptPanel.generate")}>
                                    <ArrowUp className="size-4" />
                                </Button>
                            </span>
                        </Tooltip>
                    ) : (
                        <Tooltip title={agentNeedsSkill ? t("canvas.promptAssistant.pickSkillFirst") : undefined}>
                            <Button
                                type="primary"
                                className="ml-auto !h-10 !min-w-16 shrink-0 !rounded-full !px-3"
                                disabled={agentNeedsSkill || (!prompt.trim() && !canSubmitEmptyPrompt)}
                                onClick={() => submit("new")}
                                aria-label={t("canvas.promptPanel.generate")}
                            >
                                <ArrowUp className="size-4" />
                            </Button>
                        </Tooltip>
                    )
                )}
            </div>
            <Modal
                title={
                    <div className="flex items-center justify-between pr-8">
                        <span className="text-base font-semibold">{t("canvas.promptPanel.editorTitle")}</span>
                        <Tooltip title={isFullscreen ? t("canvas.promptPanel.exitFullscreen") : t("canvas.promptPanel.fullscreen")}>
                            <Button
                                type="text"
                                size="small"
                                className="!flex !h-7 !w-7 !items-center !justify-center !rounded-lg !bg-transparent hover:!bg-black/5 dark:hover:!bg-white/10"
                                style={{ color: theme.node.text }}
                                icon={isFullscreen ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
                                onClick={() => setIsFullscreen((prev) => !prev)}
                                aria-label={isFullscreen ? t("canvas.promptPanel.exitFullscreen") : t("canvas.promptPanel.fullscreen")}
                            />
                        </Tooltip>
                    </div>
                }
                open={expanded}
                centered={!isFullscreen}
                width={isFullscreen ? "100vw" : 800}
                style={isFullscreen ? { top: 0, margin: 0, maxWidth: "100vw", paddingBottom: 0 } : undefined}
                wrapClassName={isFullscreen ? "!p-0" : undefined}
                styles={{
                    content: isFullscreen
                        ? { height: "100vh", borderRadius: 0, display: "flex", flexDirection: "column", padding: "16px 24px" }
                        : { display: "flex", flexDirection: "column" },
                    body: isFullscreen
                        ? { flex: 1, minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden" }
                        : { display: "flex", flexDirection: "column" },
                }}
                footer={
                    <div className="flex items-center justify-between pt-2">
                        <div className="flex items-center gap-3 text-xs" style={{ color: theme.node.placeholder }}>
                            <CanvasPromptLibrary onSelect={updatePrompt} />
                            <span>{t("canvas.promptPanel.charCount", { count: prompt.length })}</span>
                        </div>
                        <Button type="primary" className="!rounded-full !px-5" onClick={closeExpandedEditor}>
                            {t("canvas.promptPanel.done")}
                        </Button>
                    </div>
                }
                onCancel={closeExpandedEditor}
                destroyOnHidden
            >
                <div
                    data-canvas-no-zoom
                    className={cn("flex flex-col pt-2", isFullscreen ? "flex-1 min-h-0" : "")}
                    onWheelCapture={(event) => event.stopPropagation()}
                >
                    <CanvasNodeReferenceBar
                        nodeId={node.id}
                        nodes={nodes}
                        connectedNodes={connectedNodes}
                        onDisconnect={onDisconnectReference}
                        onStartSelection={(nodeId) => {
                            closeExpandedEditor();
                            onStartReferenceSelection?.(nodeId);
                        }}
                        onReorder={onReorderReferences}
                        onAudioEdgeModeChange={(sourceNodeId, edgeMode) => {
                            closeExpandedEditor();
                            handleAudioEdgeModeChange(sourceNodeId, edgeMode);
                        }}
                        onLocateNode={(targetId) => {
                            closeExpandedEditor();
                            onLocateNode?.(targetId);
                        }}
                    />
                    <CanvasPromptChipInput
                        value={prompt}
                        references={mentionReferences}
                        onChange={updatePrompt}
                        containerClassName={isFullscreen ? "flex-1 min-h-0 flex flex-col" : ""}
                        className={cn(
                            "thin-scrollbar w-full cursor-text overflow-y-auto rounded-xl border p-4 text-[15px] leading-6 outline-none",
                            isFullscreen ? "flex-1 min-h-[50vh] h-full" : "h-[52dvh] min-h-80"
                        )}
                        style={{ background: "transparent", borderColor: theme.toolbar.border, color: theme.node.text }}
                        placeholder={
                            mode === "text" && connectedResources.images > 0
                                ? "输入看图指令（留空默认执行生图提示词反推）..."
                                : t(`canvas.promptPanel.${mode === "image" && hasImageContent ? "editImage" : mode === "text" && hasTextContent ? "editText" : mode}`)
                        }
                    />
                </div>
            </Modal>
        </div>
    );
}

function defaultMode(type: CanvasNodeData["type"]): CanvasNodeGenerationMode {
    return type === CanvasNodeType.Text ? "text" : type === CanvasNodeType.Video ? "video" : type === CanvasNodeType.Audio ? "audio" : "image";
}

function buildNodeConfig(globalConfig: AiConfig, node: CanvasNodeData, mode: CanvasNodeGenerationMode): AiConfig {
    const rawModel = node.metadata?.modelId || node.metadata?.model;
    const model = resolveModelForCapability(globalConfig, rawModel, mode);
    const isFrame = node.metadata?.modelId === "video_minimax_h3_frame" || node.metadata?.modelId?.includes("frame") || model.toLowerCase().includes("frame") || model.includes("首尾帧");
    const isOmni = node.metadata?.modelId === "video_minimax_h3_omni" || node.metadata?.modelId?.includes("omni") || model.toLowerCase().endsWith("comfyui video") || model.toLowerCase().includes("omni");
    let videoMode = node.metadata?.videoMode;
    if (mode === "video" && node.metadata?.workflowId) {
        const wf = findWorkflow(globalConfig, node.metadata.channelId, node.metadata.workflowId);
        if (wf?.category === "frameVideo") videoMode = "frame";
        else if (wf?.category === "omniVideo") videoMode = "omni";
    }
    if (!videoMode) {
        videoMode = isFrame ? "frame" : isOmni ? "omni" : globalConfig.videoMode || defaultConfig.videoMode || "omni";
    }

    return {
        ...globalConfig,
        model,
        videoModel: mode === "video" ? model : globalConfig.videoModel,
        imageModel: mode === "image" ? model : globalConfig.imageModel,
        textModel: mode === "text" ? model : globalConfig.textModel,
        audioModel: mode === "audio" ? model : globalConfig.audioModel,
        videoMode,
        reasoningEffort: node.metadata?.reasoningEffort || globalConfig.reasoningEffort || defaultConfig.reasoningEffort,
        quality: node.metadata?.quality || globalConfig.quality || defaultConfig.quality,
        size: node.metadata?.size || globalConfig.size || defaultConfig.size,
        background: node.metadata?.background ?? globalConfig.background ?? defaultConfig.background,
        videoSeconds: node.metadata?.seconds || globalConfig.videoSeconds || defaultConfig.videoSeconds,
        audioSeconds: node.metadata?.seconds || globalConfig.audioSeconds || defaultConfig.audioSeconds || "60",
        vquality: node.metadata?.vquality || globalConfig.vquality || defaultConfig.vquality,
        videoGenerateAudio: node.metadata?.generateAudio || globalConfig.videoGenerateAudio || defaultConfig.videoGenerateAudio,
        videoWatermark: node.metadata?.watermark || globalConfig.videoWatermark || defaultConfig.videoWatermark,
        audioVoice: node.metadata?.audioVoice || globalConfig.audioVoice || defaultConfig.audioVoice,
        audioFormat: node.metadata?.audioFormat || globalConfig.audioFormat || defaultConfig.audioFormat,
        audioSpeed: node.metadata?.audioSpeed || globalConfig.audioSpeed || defaultConfig.audioSpeed,
        audioInstructions: node.metadata?.audioInstructions || globalConfig.audioInstructions || defaultConfig.audioInstructions,
        count: String(node.metadata?.count || (mode === "image" ? globalConfig.canvasImageCount || globalConfig.count : globalConfig.count) || defaultConfig.count),
    };
}

function videoConfigPatch(key: keyof AiConfig, value: string, config?: AiConfig) {
    if (key === "videoSeconds") return { seconds: value };
    if (key === "videoGenerateAudio") return { generateAudio: value };
    if (key === "videoWatermark") return { watermark: value };
    if (key === "videoMode") {
        const patch: Record<string, unknown> = {
            videoMode: value,
            modelId: value === "frame" ? "frame-video-minimax-h3-fp8-4step-pdmd" : "omni-video-minimax-h3-fp8-4step-pdmd",
        };
        if (config) {
            const channel = resolveModelChannel(config, config.model || config.videoModel);
            if (value === "frame") {
                const frameModel = channel.models.find((m) => m.name === "ComfyUI Frame Video" || m.name.toLowerCase().includes("frame") || m.name.includes("首尾帧"));
                if (frameModel) patch.model = encodeChannelModel(channel.id, frameModel.name);
                const defaultFrameWf = getDefaultWorkflow(channel, "frameVideo");
                if (defaultFrameWf) patch.workflowId = defaultFrameWf.id;
            } else if (value === "omni") {
                const omniModel = channel.models.find((m) => m.name === "ComfyUI Video" || (!m.name.toLowerCase().includes("frame") && !m.name.includes("首尾帧") && m.capability === "video"));
                if (omniModel) patch.model = encodeChannelModel(channel.id, omniModel.name);
                const defaultOmniWf = getDefaultWorkflow(channel, "omniVideo");
                if (defaultOmniWf) patch.workflowId = defaultOmniWf.id;
            }
        }
        return patch;
    }
    return { [key]: value };
}

function audioConfigPatch(key: CanvasAudioSettingKey, value: string) {
    if (key === "audioSeconds") return { seconds: value, audioSeconds: value };
    return { [key]: value };
}
