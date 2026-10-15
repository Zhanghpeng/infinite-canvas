import { useCallback, useEffect, useMemo, useState } from "react";
import { App, Select, Tooltip } from "antd";
import { Cpu, Layers, RefreshCw, Sparkles } from "lucide-react";

import {
    findWorkflow,
    getChannelWorkflows,
    getDefaultWorkflow,
    useConfigStore,
    useEffectiveConfig,
    type ComfyWorkflowItem,
    type WorkflowCategory,
} from "@/stores/use-config-store";
import {
    fetchComfyuiModels,
    findWorkflowSelectNodes,
    updateWorkflowNodeInput,
    type ComfyuiModelItem,
} from "@/services/api/comfyui";

function formatFileSize(bytes?: number): string {
    if (!bytes || bytes <= 0) return "";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

// 模块级模型列表缓存，减少跨节点切换时重复请求
const modelsCache: Record<string, { timestamp: number; data: ComfyuiModelItem[] }> = {};

export type CanvasWorkflowModelPickerProps = {
    channelId?: string;
    workflowId?: string;
    category?: WorkflowCategory | WorkflowCategory[];
    preferredCategory?: WorkflowCategory;
    className?: string;
};

export function CanvasWorkflowModelPicker({
    channelId,
    workflowId,
    category,
    preferredCategory,
    className,
}: CanvasWorkflowModelPickerProps) {
    const { message } = App.useApp();
    const config = useEffectiveConfig();
    const saveWorkflowGlobally = useConfigStore((state) => state.saveWorkflowGlobally);

    const activeChannel = useMemo(() => {
        const channels = config.channels || [];
        if (!channels.length) return null;
        return (channelId ? channels.find((c) => c.id === channelId) : null) || channels[0];
    }, [config.channels, channelId]);

    const activeWorkflow = useMemo(() => {
        if (!activeChannel) return null;
        if (workflowId) {
            const found = findWorkflow(config, activeChannel.id, workflowId);
            if (found) return found;
        }
        const cat = preferredCategory || (Array.isArray(category) ? category[0] : category);
        if (cat) {
            return getDefaultWorkflow(activeChannel, cat);
        }
        return getChannelWorkflows(activeChannel)[0] || null;
    }, [config, activeChannel, workflowId, category, preferredCategory]);

    const selectNodes = useMemo(() => {
        if (!activeWorkflow?.json) return [];
        return findWorkflowSelectNodes(activeWorkflow.json);
    }, [activeWorkflow?.json]);

    const comfyEndpoint = useMemo(() => {
        return activeChannel?.comfyuiProxyUrl || (activeChannel?.id === "local" ? "http://127.0.0.1:8188" : "http://127.0.0.1:8188");
    }, [activeChannel]);

    const [modelsMap, setModelsMap] = useState<
        Record<string, { loading: boolean; error?: string; items: ComfyuiModelItem[] }>
    >({});

    const loadModels = useCallback(
        async (modelType: string, force = false) => {
            const catKey = modelType.trim().toLowerCase();
            const cacheKey = `${comfyEndpoint}_${catKey}`;
            if (!force && modelsCache[cacheKey]) {
                setModelsMap((prev) => ({
                    ...prev,
                    [catKey]: { loading: false, items: modelsCache[cacheKey].data },
                }));
                return;
            }

            setModelsMap((prev) => ({
                ...prev,
                [catKey]: { loading: true, items: prev[catKey]?.items || [] },
            }));

            try {
                const items = await fetchComfyuiModels(catKey, comfyEndpoint, activeChannel?.comfyuiProxyToken);
                modelsCache[cacheKey] = { timestamp: Date.now(), data: items };
                setModelsMap((prev) => ({
                    ...prev,
                    [catKey]: { loading: false, items },
                }));
            } catch (err) {
                const msg = err instanceof Error ? err.message : "获取模型失败";
                setModelsMap((prev) => ({
                    ...prev,
                    [catKey]: { loading: false, error: msg, items: prev[catKey]?.items || [] },
                }));
            }
        },
        [comfyEndpoint, activeChannel?.comfyuiProxyToken]
    );

    useEffect(() => {
        for (const node of selectNodes) {
            if (node.modelType) {
                void loadModels(node.modelType);
            }
        }
    }, [selectNodes, loadModels]);

    const handleModelChange = (nodeId: string, inputKey: string, nextValue: string, modelType: string) => {
        if (!activeWorkflow) return;
        const nextJson = updateWorkflowNodeInput(activeWorkflow.json, nodeId, inputKey, nextValue);
        const updatedWorkflow: ComfyWorkflowItem = {
            ...activeWorkflow,
            json: nextJson,
            isBuiltin: false,
            createdAt: Date.now(),
        };

        // 全渠道生效保存
        saveWorkflowGlobally(updatedWorkflow);

        const isDiffusion = modelType === "diffusion_models" || modelType === "unet";
        const isClip = modelType === "clip" || modelType === "text_encoders";
        const label = isDiffusion ? "扩散模型" : isClip ? "CLIP编码器" : "模型";
        message.success(`已切换 ${label} 为「${nextValue}」（全渠道生效）`);
    };

    if (!selectNodes.length) {
        return null;
    }

    return (
        <div
            className={`flex items-center gap-1.5 ${className || ""}`}
            onMouseDown={(e) => e.stopPropagation()}
            onPointerDown={(e) => e.stopPropagation()}
        >
            {selectNodes.map((node) => {
                const isDiffusion = node.modelType === "diffusion_models" || node.modelType === "unet";
                const isClip = node.modelType === "clip" || node.modelType === "text_encoders";
                const catKey = node.modelType;
                const state = modelsMap[catKey] || { loading: false, items: [] };
                const isLoading = state.loading;
                const items = state.items;

                const options = items.map((m) => ({
                    value: m.name,
                    label: (
                        <div className="flex items-center justify-between gap-2 py-0.5 text-xs">
                            <span className="truncate">{m.name}</span>
                            <span className="shrink-0 text-[10px] text-stone-400">
                                {formatFileSize(m.size)}
                            </span>
                        </div>
                    ),
                }));

                const tooltipTitle = isDiffusion
                    ? `扩散大模型 (Diffusion): ${node.currentValue || "未选"}`
                    : isClip
                    ? `CLIP / 文本编码模型: ${node.currentValue || "未选"}`
                    : `模型: ${node.currentValue || "未选"}`;

                return (
                    <Tooltip key={`${node.nodeId}:${node.inputKey}`} title={tooltipTitle}>
                        <div className="flex items-center">
                            <Select
                                size="small"
                                showSearch
                                value={node.currentValue || undefined}
                                placeholder={
                                    isLoading
                                        ? "加载模型..."
                                        : isDiffusion
                                        ? "选择扩散模型"
                                        : isClip
                                        ? "选择CLIP"
                                        : "选择模型"
                                }
                                loading={isLoading}
                                options={options}
                                onChange={(val) => handleModelChange(node.nodeId, node.inputKey, val, node.modelType)}
                                className="w-[120px] max-w-[155px] shrink-0 sm:w-[135px]"
                                popupMatchSelectWidth={false}
                                filterOption={(input, option) =>
                                    String(option?.value ?? "").toLowerCase().includes(input.toLowerCase())
                                }
                                prefix={
                                    isDiffusion ? (
                                        <Cpu className="size-3 text-purple-500 shrink-0 mr-0.5" />
                                    ) : isClip ? (
                                        <Sparkles className="size-3 text-amber-500 shrink-0 mr-0.5" />
                                    ) : (
                                        <Layers className="size-3 text-blue-500 shrink-0 mr-0.5" />
                                    )
                                }
                                notFoundContent={
                                    state.error ? (
                                        <div className="p-2 text-center text-xs text-rose-500">
                                            {state.error}
                                            <button
                                                type="button"
                                                className="block mx-auto mt-1 text-[11px] text-blue-500 hover:underline"
                                                onClick={() => void loadModels(catKey, true)}
                                            >
                                                重试
                                            </button>
                                        </div>
                                    ) : (
                                        <div className="p-2 text-center text-xs text-stone-400">
                                            未检测到可用模型
                                        </div>
                                    )
                                }
                            />
                        </div>
                    </Tooltip>
                );
            })}
        </div>
    );
}
