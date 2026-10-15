import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
    AlertCircle,
    Check,
    Copy,
    Cpu,
    Download,
    Layers,
    RefreshCw,
    RotateCcw,
    Save,
    Sparkles,
    Star,
    Upload,
    Workflow as WorkflowIcon,
} from "lucide-react";
import { App, Button, Empty, Input, Select, Tag, Tooltip } from "antd";

import {
    getChannelWorkflows,
    getDefaultComfyWorkflowItems,
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
    type ComfyuiWorkflowJson,
} from "@/services/api/comfyui";
import { useCopyText } from "@/hooks/use-copy-text";

function formatFileSize(bytes?: number): string {
    if (!bytes || bytes <= 0) return "";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

const CATEGORY_TABS: Array<{ key: string; label: string }> = [
    { key: "all", label: "全部工作流" },
    { key: "t2i", label: "文生图" },
    { key: "i2i", label: "图生图" },
    { key: "inpaint", label: "局部编辑" },
    { key: "text", label: "文本生成" },
    { key: "omniVideo", label: "全能参考视频" },
    { key: "frameVideo", label: "首尾帧视频" },
    { key: "audio", label: "音乐音频" },
    { key: "faceRefine", label: "人脸精修" },
    { key: "depthVideo", label: "深度视频" },
];

export default function WorkflowsPage() {
    const { message } = App.useApp();
    const copyText = useCopyText();
    const fileInputRef = useRef<HTMLInputElement>(null);
    const [searchParams] = useSearchParams();

    const queryChannelId = searchParams.get("channelId");
    const queryWorkflowId = searchParams.get("id");
    const queryCategory = searchParams.get("category");

    const config = useEffectiveConfig();
    const saveWorkflowGlobally = useConfigStore((state) => state.saveWorkflowGlobally);
    const setChannelDefaultWorkflow = useConfigStore((state) => state.setChannelDefaultWorkflow);
    const resetChannelWorkflowToBuiltin = useConfigStore((state) => state.resetChannelWorkflowToBuiltin);

    // 当前渠道及基准端点（若 URL 传了 channelId 则锁定对应渠道，否则使用当前默认 ComfyUI 渠道）
    const primaryChannel = useMemo(() => {
        if (queryChannelId) {
            const found = config.channels?.find((c) => c.id === queryChannelId);
            if (found) return found;
        }
        return config.channels?.find((c) => c.apiFormat === "comfyui") || config.channels?.[0];
    }, [config.channels, queryChannelId]);

    const comfyEndpoint = useMemo(() => {
        return primaryChannel?.comfyuiProxyUrl || (primaryChannel?.id === "local" ? "http://127.0.0.1:8188" : "http://127.0.0.1:8188");
    }, [primaryChannel]);

    // 当前所有工作流列表
    const allWorkflows = useMemo(() => {
        return getChannelWorkflows(primaryChannel);
    }, [primaryChannel]);

    // 分类筛选与搜索
    const [selectedCategory, setSelectedCategory] = useState(queryCategory || "all");
    const [searchKeyword, setSearchKeyword] = useState("");

    // 当前选中的正在编辑的工作流
    const [activeWorkflowId, setActiveWorkflowId] = useState<string>(queryWorkflowId || "");

    // 响应 URL 参数变化定位目标工作流与分类
    useEffect(() => {
        if (queryCategory) {
            setSelectedCategory(queryCategory);
        }
        if (queryWorkflowId) {
            const found = allWorkflows.find((w) => w.id === queryWorkflowId || w.name === queryWorkflowId);
            if (found) {
                setActiveWorkflowId(found.id);
            }
        }
    }, [queryCategory, queryWorkflowId, allWorkflows]);

    const filteredWorkflows = useMemo(() => {
        return allWorkflows.filter((wf) => {
            const matchesCat = selectedCategory === "all" || wf.category === selectedCategory;
            const matchesKw = !searchKeyword.trim() || wf.name.toLowerCase().includes(searchKeyword.toLowerCase().trim());
            return matchesCat && matchesKw;
        });
    }, [allWorkflows, selectedCategory, searchKeyword]);

    useEffect(() => {
        if (!filteredWorkflows.length) {
            setActiveWorkflowId("");
            return;
        }
        if (!activeWorkflowId || !filteredWorkflows.some((w) => w.id === activeWorkflowId)) {
            setActiveWorkflowId(filteredWorkflows[0].id);
        }
    }, [filteredWorkflows, activeWorkflowId]);

    const activeWorkflow = useMemo(() => {
        return allWorkflows.find((w) => w.id === activeWorkflowId) || filteredWorkflows[0] || null;
    }, [allWorkflows, activeWorkflowId, filteredWorkflows]);

    // 检查是否有系统出厂内置对应项
    const builtinCounterpart = useMemo(() => {
        if (!primaryChannel || !activeWorkflow) return null;
        const defaults = getDefaultComfyWorkflowItems(primaryChannel);
        return defaults.find((w) => w.id === activeWorkflow.id || w.name === activeWorkflow.name) || null;
    }, [primaryChannel, activeWorkflow]);

    // 编辑状态
    const [currentJson, setCurrentJson] = useState<ComfyuiWorkflowJson>({});
    const [currentName, setCurrentName] = useState("");
    const [currentDesc, setCurrentDesc] = useState("");
    const [isDirty, setIsDirty] = useState(false);
    const [copied, setCopied] = useState(false);

    // 切换工作流时重置本地状态
    useEffect(() => {
        if (!activeWorkflow) return;
        setCurrentName(activeWorkflow.name || "");
        setCurrentDesc(activeWorkflow.description || "");
        setCurrentJson(activeWorkflow.json ? JSON.parse(JSON.stringify(activeWorkflow.json)) : {});
        setIsDirty(false);
    }, [activeWorkflow]);

    // 提取当前正在编辑工作流中的选择节点
    const selectNodes = useMemo(() => {
        return findWorkflowSelectNodes(currentJson);
    }, [currentJson]);

    // 独立缓存各分类模型（例如 diffusion_models, clip / text_encoders）
    const [modelsMap, setModelsMap] = useState<
        Record<string, { loading: boolean; error?: string; items: ComfyuiModelItem[] }>
    >({});

    const loadModelsForCategory = async (category: string, force = false) => {
        const catKey = category.trim().toLowerCase();
        if (!force && modelsMap[catKey]?.items?.length) return;

        setModelsMap((prev) => ({
            ...prev,
            [catKey]: { loading: true, error: undefined, items: prev[catKey]?.items || [] },
        }));

        try {
            const list = await fetchComfyuiModels(catKey, comfyEndpoint, primaryChannel?.comfyuiProxyToken);
            setModelsMap((prev) => ({
                ...prev,
                [catKey]: { loading: false, error: undefined, items: list },
            }));
        } catch (err) {
            const msg = err instanceof Error ? err.message : "获取模型列表失败";
            setModelsMap((prev) => ({
                ...prev,
                [catKey]: { loading: false, error: msg, items: prev[catKey]?.items || [] },
            }));
        }
    };

    // 自动触发当前工作流所需模型的加载
    useEffect(() => {
        for (const node of selectNodes) {
            if (node.modelType) {
                void loadModelsForCategory(node.modelType);
            }
        }
    }, [selectNodes, comfyEndpoint]);

    // 下拉框修改模型
    const handleModelChange = (nodeId: string, inputKey: string, nextValue: string) => {
        const nextJson = updateWorkflowNodeInput(currentJson, nodeId, inputKey, nextValue);
        setCurrentJson(nextJson);
        setIsDirty(true);
    };

    // 全局保存（全渠道即时生效）
    const handleSaveGlobal = () => {
        if (!activeWorkflow) return;
        const updatedWorkflow: ComfyWorkflowItem = {
            ...activeWorkflow,
            name: currentName.trim() || activeWorkflow.name,
            description: currentDesc.trim(),
            json: currentJson,
            isBuiltin: false,
            createdAt: Date.now(),
        };

        saveWorkflowGlobally(updatedWorkflow);
        setIsDirty(false);
        message.success(`已保存「${updatedWorkflow.name}」，全渠道与画布生成已实时生效！`);
    };

    // 恢复系统内置出厂版本
    const handleReset = () => {
        if (!primaryChannel || !activeWorkflow || !builtinCounterpart) return;
        resetChannelWorkflowToBuiltin(primaryChannel.id, activeWorkflow.id);
        setCurrentName(builtinCounterpart.name);
        setCurrentDesc(builtinCounterpart.description || "");
        setCurrentJson(JSON.parse(JSON.stringify(builtinCounterpart.json)));
        setIsDirty(false);
        message.success(`已恢复为系统内置版本「${builtinCounterpart.name}」`);
    };

    // 导出文件
    const handleExportJson = () => {
        const jsonStr = JSON.stringify(currentJson, null, 2);
        const blob = new Blob([jsonStr], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `${currentName || "workflow"}_api.json`;
        a.click();
        URL.revokeObjectURL(url);
    };

    // 复制代码
    const handleCopyJson = async () => {
        const jsonStr = JSON.stringify(currentJson, null, 2);
        await copyText(jsonStr);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
        message.success("工作流 JSON 代码已复制到剪贴板");
    };

    // 导入外部 JSON
    const handleImportJson = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = (event) => {
            try {
                const parsed = JSON.parse(event.target?.result as string);
                if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
                    throw new Error("工作流 JSON 必须为对象结构（ComfyUI API 格式）");
                }
                setCurrentJson(parsed as ComfyuiWorkflowJson);
                setIsDirty(true);
                message.success(`成功导入 ${file.name}`);
            } catch (err) {
                message.error(err instanceof Error ? err.message : "JSON 文件解析失败");
            }
        };
        reader.readAsText(file);
        if (fileInputRef.current) fileInputRef.current.value = "";
    };

    const isCustom = activeWorkflow && !activeWorkflow.isBuiltin;
    const jsonString = JSON.stringify(currentJson, null, 2);

    return (
        <main className="flex h-full flex-col overflow-hidden bg-background text-foreground">
            {/* 顶栏信息与分类导航条 */}
            <div className="shrink-0 border-b border-stone-200 bg-background/95 px-6 pt-4 pb-3 backdrop-blur-md dark:border-stone-800">
                <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                        <div className="flex items-center gap-2">
                            <WorkflowIcon className="size-5 text-blue-500" />
                            <h1 className="text-lg font-semibold text-stone-950 dark:text-stone-100">
                                工作流管理与大模型配置
                            </h1>
                        </div>
                        <p className="mt-0.5 text-xs text-stone-500">
                            实时从本地 ComfyUI 端点拉取并选择 Diffusion 扩散模型与 CLIP 编码器，一处修改全局所有渠道即刻生效。
                        </p>
                    </div>

                    <div className="flex items-center gap-2 text-xs">
                        <span className="text-stone-400">ComfyUI 实例：</span>
                        <code className="rounded bg-stone-100 px-2 py-0.5 font-mono text-[11px] text-stone-700 dark:bg-stone-800 dark:text-stone-300">
                            {comfyEndpoint}
                        </code>
                    </div>
                </div>

                {/* 分类标签栏与搜索 */}
                <div className="mt-3.5 flex flex-wrap items-center justify-between gap-3">
                    <div className="flex flex-wrap items-center gap-1.5">
                        {CATEGORY_TABS.map((tab) => {
                            const active = selectedCategory === tab.key;
                            return (
                                <button
                                    key={tab.key}
                                    type="button"
                                    onClick={() => setSelectedCategory(tab.key)}
                                    className={`rounded-full px-3 py-1 text-xs font-medium transition ${
                                        active
                                            ? "bg-stone-950 text-white shadow-xs dark:bg-white dark:text-stone-950"
                                            : "bg-stone-100 text-stone-600 hover:bg-stone-200 dark:bg-stone-850 dark:text-stone-400 dark:hover:bg-stone-800"
                                    }`}
                                >
                                    {tab.label}
                                </button>
                            );
                        })}
                    </div>

                    <div className="w-48">
                        <Input
                            size="small"
                            allowClear
                            placeholder="搜索工作流..."
                            value={searchKeyword}
                            onChange={(e) => setSearchKeyword(e.target.value)}
                        />
                    </div>
                </div>
            </div>

            {/* 工作台主体：左侧列表 + 右侧可视化参数编辑器 */}
            <div className="flex min-h-0 flex-1 overflow-hidden">
                {/* 左栏：工作流条目列表 */}
                <div className="thin-scrollbar flex w-72 shrink-0 flex-col overflow-y-auto border-r border-stone-200 bg-stone-50/50 p-3 sm:w-80 dark:border-stone-800 dark:bg-stone-900/30">
                    <div className="mb-2 px-1 text-[11px] font-semibold tracking-wider text-stone-400 uppercase">
                        工作流列表 ({filteredWorkflows.length})
                    </div>
                    <div className="space-y-1.5">
                        {filteredWorkflows.map((wf) => {
                            const isSelected = wf.id === activeWorkflowId;
                            const custom = !wf.isBuiltin;
                            return (
                                <button
                                    key={wf.id}
                                    type="button"
                                    onClick={() => setActiveWorkflowId(wf.id)}
                                    className={`w-full rounded-xl border p-3 text-left transition ${
                                        isSelected
                                            ? "border-blue-500 bg-white shadow-xs dark:border-blue-500/80 dark:bg-stone-850"
                                            : "border-stone-200/70 bg-white/70 hover:border-stone-300 hover:bg-white dark:border-stone-800/80 dark:bg-stone-900/40 dark:hover:border-stone-700 dark:hover:bg-stone-850/60"
                                    }`}
                                >
                                    <div className="flex items-center justify-between gap-1.5 mb-1">
                                        <span className="truncate text-xs font-semibold text-stone-900 dark:text-stone-100">
                                            {wf.name}
                                        </span>
                                        <div className="flex shrink-0 items-center gap-1">
                                            {wf.isDefault && (
                                                <span className="inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300">
                                                    默认
                                                </span>
                                            )}
                                            <span
                                                className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium ${
                                                    custom
                                                        ? "bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300"
                                                        : "bg-blue-100 text-blue-800 dark:bg-blue-950/60 dark:text-blue-300"
                                                }`}
                                            >
                                                {custom ? "自定义" : "内置"}
                                            </span>
                                        </div>
                                    </div>
                                    <div className="truncate text-[11px] text-stone-400">
                                        {wf.description || "无详细说明"}
                                    </div>
                                </button>
                            );
                        })}
                    </div>
                </div>

                {/* 右栏：当前工作流的可视化模型与参数配置面板 */}
                {activeWorkflow ? (
                    <div className="flex min-w-0 flex-1 flex-col overflow-hidden bg-background">
                        {/* 详情与操作工具栏 */}
                        <div className="flex shrink-0 items-center justify-between border-b border-stone-200 bg-white/70 px-6 py-3 backdrop-blur-md dark:border-stone-800 dark:bg-stone-900/60">
                            <div className="flex items-center gap-2.5">
                                <h2 className="text-sm font-semibold text-stone-950 dark:text-stone-100">
                                    {currentName}
                                </h2>
                                <span
                                    className={`inline-flex items-center rounded px-2 py-0.5 text-xs font-medium ${
                                        isCustom
                                            ? "bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300"
                                            : "bg-blue-100 text-blue-800 dark:bg-blue-950/60 dark:text-blue-300"
                                    }`}
                                >
                                    {isCustom ? "已自定义" : "系统出厂内置"}
                                </span>
                                <Tag className="m-0 text-xs">{activeWorkflow.category}</Tag>
                            </div>

                            <div className="flex items-center gap-2">
                                {activeWorkflow.isDefault ? (
                                    <Tag color="green" className="m-0 text-xs py-0.5">
                                        当前渠道默认
                                    </Tag>
                                ) : (
                                    <Button
                                        size="small"
                                        icon={<Star className="size-3.5 text-amber-500" />}
                                        onClick={() => {
                                            if (!primaryChannel || !activeWorkflow) return;
                                            setChannelDefaultWorkflow(primaryChannel.id, activeWorkflow.category, activeWorkflow.id);
                                            message.success(`已将「${activeWorkflow.name}」设为 ${primaryChannel.name} 的默认工作流`);
                                        }}
                                        title={`将此工作流设为当前渠道（${primaryChannel?.name}）该分类下的默认工作流`}
                                    >
                                        设为渠道默认
                                    </Button>
                                )}
                                {builtinCounterpart && (
                                    <Button
                                        size="small"
                                        icon={<RotateCcw className="size-3.5" />}
                                        onClick={handleReset}
                                        title="恢复为系统出厂配置"
                                    >
                                        恢复默认
                                    </Button>
                                )}
                                <Button
                                    size="small"
                                    type="primary"
                                    icon={<Save className="size-3.5" />}
                                    disabled={!isDirty}
                                    onClick={handleSaveGlobal}
                                >
                                    保存修改（全渠道生效）
                                </Button>
                            </div>
                        </div>

                        {/* 主内容区域 */}
                        <div className="thin-scrollbar flex-1 overflow-y-auto p-6 space-y-6">
                            {/* 大模型可视化选择核心卡片（严格分别调用独立接口） */}
                            <div className="rounded-2xl border border-stone-200/90 bg-white p-5 shadow-xs dark:border-stone-800 dark:bg-stone-900/50">
                                <div className="mb-4 flex items-center justify-between">
                                    <div className="flex items-center gap-2">
                                        <Layers className="size-4 text-blue-500" />
                                        <span className="text-sm font-semibold text-stone-900 dark:text-stone-100">
                                            大模型与文本编码器可视化配置
                                        </span>
                                    </div>
                                    <span className="text-xs text-stone-400">
                                        检测到 {selectNodes.length} 个模型选择槽位
                                    </span>
                                </div>

                                {selectNodes.length === 0 ? (
                                    <div className="rounded-xl border border-dashed border-stone-200 p-6 text-center dark:border-stone-800">
                                        <AlertCircle className="mx-auto size-6 text-stone-400 mb-2" />
                                        <div className="text-xs font-semibold text-stone-700 dark:text-stone-300">
                                            当前工作流未标注 select_models_* 选择槽位
                                        </div>
                                        <p className="mt-1 text-xs text-stone-400">
                                            可在 ComfyUI API 导出时为对应 Loader 节点标注{" "}
                                            <code>select_models_diffusion_models</code> 或 <code>select_models_clip</code>。
                                        </p>
                                    </div>
                                ) : (
                                    <div className="grid gap-4 md:grid-cols-2">
                                        {selectNodes.map((node) => {
                                            const isDiffusion = node.modelType === "diffusion_models" || node.modelType === "unet";
                                            const isClip = node.modelType === "clip" || node.modelType === "text_encoders";
                                            const catKey = node.modelType;
                                            const modelState = modelsMap[catKey] || { loading: false, items: [] };
                                            const isLoading = modelState.loading;
                                            const items = modelState.items;

                                            // 端点提示
                                            const endpointName = isClip
                                                ? "GET /api/experiment/models/text_encoders"
                                                : isDiffusion
                                                ? "GET /api/experiment/models/diffusion_models"
                                                : `GET /api/experiment/models/${catKey}`;

                                            const options = items.map((m) => ({
                                                value: m.name,
                                                label: (
                                                    <div className="flex items-center justify-between gap-2 py-0.5">
                                                        <span className="truncate font-medium text-xs">{m.name}</span>
                                                        <span className="shrink-0 text-[10px] text-stone-400">
                                                            {formatFileSize(m.size)}
                                                        </span>
                                                    </div>
                                                ),
                                            }));

                                            return (
                                                <div
                                                    key={`${node.nodeId}:${node.inputKey}`}
                                                    className="rounded-xl border border-stone-200/80 bg-stone-50/50 p-4 transition hover:border-stone-300 dark:border-stone-800 dark:bg-stone-850/40 dark:hover:border-stone-700"
                                                >
                                                    <div className="mb-2 flex items-center justify-between">
                                                        <div className="flex items-center gap-1.5">
                                                            {isDiffusion ? (
                                                                <Cpu className="size-4 text-purple-500" />
                                                            ) : isClip ? (
                                                                <Sparkles className="size-4 text-amber-500" />
                                                            ) : (
                                                                <Layers className="size-4 text-blue-500" />
                                                            )}
                                                            <span className="text-xs font-semibold text-stone-900 dark:text-stone-100">
                                                                {isDiffusion
                                                                    ? "扩散大模型 (Diffusion Model)"
                                                                    : isClip
                                                                    ? "CLIP / 文本编码模型 (Text Encoder)"
                                                                    : node.title}
                                                            </span>
                                                        </div>
                                                        <Tooltip title="重新从 ComfyUI 刷新此模型库">
                                                            <Button
                                                                size="small"
                                                                type="text"
                                                                icon={<RefreshCw className={`size-3 text-stone-500 ${isLoading ? "animate-spin" : ""}`} />}
                                                                onClick={() => void loadModelsForCategory(catKey, true)}
                                                            />
                                                        </Tooltip>
                                                    </div>

                                                    <div className="mb-2 text-[11px] text-stone-400">
                                                        实时接口：<code className="text-blue-600 dark:text-blue-400">{endpointName}</code>
                                                    </div>

                                                    <div className="space-y-1.5">
                                                        <Select
                                                            className="w-full"
                                                            showSearch
                                                            value={node.currentValue || undefined}
                                                            placeholder={isLoading ? "正在从 ComfyUI 实时获取..." : `请选择 ${catKey} 模型`}
                                                            loading={isLoading}
                                                            options={options}
                                                            onChange={(val) => handleModelChange(node.nodeId, node.inputKey, val)}
                                                            filterOption={(input, option) =>
                                                                (String(option?.value ?? "")).toLowerCase().includes(input.toLowerCase())
                                                            }
                                                            notFoundContent={
                                                                modelState.error ? (
                                                                    <div className="p-2 text-center text-xs text-rose-500">
                                                                        {modelState.error}
                                                                        <Button
                                                                            size="small"
                                                                            type="link"
                                                                            className="block mx-auto mt-1"
                                                                            onClick={() => void loadModelsForCategory(catKey, true)}
                                                                        >
                                                                            重试连接
                                                                        </Button>
                                                                    </div>
                                                                ) : (
                                                                    <div className="p-2 text-center text-xs text-stone-400">
                                                                        未在 ComfyUI 该分类中检测到模型文件
                                                                    </div>
                                                                )
                                                            }
                                                        />

                                                        {node.currentValue && (
                                                            <div className="truncate text-[11px] text-stone-500">
                                                                当前选用：
                                                                <span className="font-mono text-stone-700 dark:text-stone-300">
                                                                    {node.currentValue}
                                                                </span>
                                                            </div>
                                                        )}
                                                    </div>
                                                </div>
                                            );
                                        })}
                                    </div>
                                )}
                            </div>

                            {/* 基础元数据与 JSON 代码抽屉 */}
                            <div className="rounded-2xl border border-stone-200/90 bg-white p-5 shadow-xs dark:border-stone-800 dark:bg-stone-900/50">
                                <div className="mb-3 text-xs font-semibold text-stone-700 dark:text-stone-300">
                                    基础说明与元数据
                                </div>
                                <div className="grid gap-3 sm:grid-cols-2">
                                    <div>
                                        <label className="mb-1 block text-xs text-stone-500">工作流标题</label>
                                        <Input
                                            value={currentName}
                                            onChange={(e) => {
                                                setCurrentName(e.target.value);
                                                setIsDirty(true);
                                            }}
                                            placeholder="工作流名称"
                                        />
                                    </div>
                                    <div>
                                        <label className="mb-1 block text-xs text-stone-500">描述与采样建议</label>
                                        <Input
                                            value={currentDesc}
                                            onChange={(e) => {
                                                setCurrentDesc(e.target.value);
                                                setIsDirty(true);
                                            }}
                                            placeholder="建议步数、显存要求等..."
                                        />
                                    </div>
                                </div>

                                <div className="mt-5 border-t border-stone-100 pt-4 dark:border-stone-800">
                                    <div className="mb-2 flex items-center justify-between">
                                        <span className="text-xs font-semibold text-stone-700 dark:text-stone-300">
                                            底层 JSON 结构代码 (ComfyUI API 格式)
                                        </span>
                                        <div className="flex items-center gap-1.5">
                                            <input
                                                ref={fileInputRef}
                                                type="file"
                                                accept=".json"
                                                className="hidden"
                                                onChange={handleImportJson}
                                            />
                                            <Button
                                                size="small"
                                                icon={<Upload className="size-3.5" />}
                                                onClick={() => fileInputRef.current?.click()}
                                            >
                                                导入替换
                                            </Button>
                                            <Button
                                                size="small"
                                                icon={<Download className="size-3.5" />}
                                                onClick={handleExportJson}
                                            >
                                                导出文件
                                            </Button>
                                            <Button
                                                size="small"
                                                icon={copied ? <Check className="size-3.5 text-emerald-500" /> : <Copy className="size-3.5" />}
                                                onClick={handleCopyJson}
                                            >
                                                {copied ? "已复制" : "复制代码"}
                                            </Button>
                                        </div>
                                    </div>

                                    <div className="thin-scrollbar max-h-64 overflow-y-auto rounded-lg border border-stone-200 bg-stone-50 p-3 font-mono text-[11px] text-stone-700 select-text dark:border-stone-800 dark:bg-stone-950 dark:text-stone-300">
                                        <pre className="whitespace-pre-wrap break-all">{jsonString}</pre>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                ) : (
                    <div className="flex flex-1 items-center justify-center p-6">
                        <Empty description="请在左侧选择一个工作流进行配置" />
                    </div>
                )}
            </div>
        </main>
    );
}
