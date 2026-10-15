import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
    AlertCircle,
    ArrowLeft,
    Check,
    Copy,
    Download,
    Layers,
    RefreshCw,
    RotateCcw,
    Save,
    Sliders,
    Upload,
} from "lucide-react";
import { App, Button, Empty, Input, Select, Spin, Tag, Tooltip } from "antd";

import {
    getChannelWorkflows,
    getDefaultComfyWorkflowItems,
    useConfigStore,
    useEffectiveConfig,
    type ComfyWorkflowItem,
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

function formatDate(timestamp?: number): string {
    if (!timestamp) return "";
    const date = new Date(timestamp > 1e11 ? timestamp : timestamp * 1000);
    return date.toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

export default function WorkflowEditorPage() {
    const { channelId, workflowId } = useParams<{ channelId: string; workflowId: string }>();
    const navigate = useNavigate();
    const { message } = App.useApp();
    const copyText = useCopyText();
    const fileInputRef = useRef<HTMLInputElement>(null);

    const config = useEffectiveConfig();
    const saveChannelWorkflow = useConfigStore((state) => state.saveChannelWorkflow);
    const resetChannelWorkflowToBuiltin = useConfigStore((state) => state.resetChannelWorkflowToBuiltin);

    // 查找目标渠道
    const targetChannel = useMemo(() => {
        if (!config.channels?.length) return null;
        return config.channels.find((c) => c.id === channelId) || config.channels[0];
    }, [config.channels, channelId]);

    // 查找目标工作流
    const sourceWorkflow = useMemo(() => {
        if (!targetChannel) return null;
        const decodedId = decodeURIComponent(workflowId || "");
        const allWorkflows = getChannelWorkflows(targetChannel);
        const match = allWorkflows.find((w) => w.id === decodedId || w.name === decodedId);
        if (match) return match;

        // 尝试从内置备选找
        const defaults = getDefaultComfyWorkflowItems(targetChannel);
        return defaults.find((w) => w.id === decodedId || w.name === decodedId) || null;
    }, [targetChannel, workflowId]);

    // 检查是否有对应的系统内置工作流（用于重置功能）
    const builtinCounterpart = useMemo(() => {
        if (!targetChannel || !sourceWorkflow) return null;
        const defaults = getDefaultComfyWorkflowItems(targetChannel);
        return (
            defaults.find(
                (w) =>
                    w.id === sourceWorkflow.id ||
                    w.name === sourceWorkflow.name ||
                    (w.category === sourceWorkflow.category && w.isDefault)
            ) || null
        );
    }, [targetChannel, sourceWorkflow]);

    // 编辑器核心状态
    const [name, setName] = useState("");
    const [description, setDescription] = useState("");
    const [workflowJson, setWorkflowJson] = useState<ComfyuiWorkflowJson>({});
    const [isDirty, setIsDirty] = useState(false);
    const [copied, setCopied] = useState(false);

    // 模型数据缓存与加载状态
    const [modelsMap, setModelsMap] = useState<
        Record<string, { loading: boolean; error?: string; items: ComfyuiModelItem[] }>
    >({});

    // 初始化加载工作流内容
    useEffect(() => {
        if (!sourceWorkflow) return;
        setName(sourceWorkflow.name || "");
        setDescription(sourceWorkflow.description || "");
        setWorkflowJson(sourceWorkflow.json ? JSON.parse(JSON.stringify(sourceWorkflow.json)) : {});
        setIsDirty(false);
    }, [sourceWorkflow]);

    // 动态提取工作流中带有 select_models_* 的选择节点
    const selectNodes = useMemo(() => {
        return findWorkflowSelectNodes(workflowJson);
    }, [workflowJson]);

    // 加载指定分类的模型列表（如 diffusion_models, clip / text_encoders, loras, vae）
    const loadModels = async (category: string, force = false) => {
        if (!targetChannel) return;
        const catKey = category.trim().toLowerCase();
        if (!force && modelsMap[catKey]?.items?.length) return;

        setModelsMap((prev) => ({
            ...prev,
            [catKey]: { loading: true, error: undefined, items: prev[catKey]?.items || [] },
        }));

        const endpoint = targetChannel.comfyuiProxyUrl || "http://127.0.0.1:8188";
        try {
            const list = await fetchComfyuiModels(catKey, endpoint, targetChannel.comfyuiProxyToken);
            setModelsMap((prev) => ({
                ...prev,
                [catKey]: { loading: false, error: undefined, items: list },
            }));
        } catch (err) {
            const errMsg = err instanceof Error ? err.message : "连接 ComfyUI 获取模型失败";
            setModelsMap((prev) => ({
                ...prev,
                [catKey]: { loading: false, error: errMsg, items: prev[catKey]?.items || [] },
            }));
        }
    };

    // 页面加载或识别到新选择节点时，自动拉取对应模型
    useEffect(() => {
        for (const node of selectNodes) {
            if (node.modelType) {
                void loadModels(node.modelType);
            }
        }
    }, [selectNodes, targetChannel]);

    // 修改某个节点的模型选项
    const handleModelChange = (nodeId: string, inputKey: string, nextValue: string) => {
        const nextJson = updateWorkflowNodeInput(workflowJson, nodeId, inputKey, nextValue);
        setWorkflowJson(nextJson);
        setIsDirty(true);
    };

    // 保存工作流修改
    const handleSave = () => {
        if (!targetChannel || !sourceWorkflow) return;
        const updatedItem: ComfyWorkflowItem = {
            ...sourceWorkflow,
            name: name.trim() || sourceWorkflow.name,
            description: description.trim(),
            json: workflowJson,
            isBuiltin: false,
            createdAt: Date.now(),
        };

        saveChannelWorkflow(targetChannel.id, updatedItem);
        setIsDirty(false);
        message.success("工作流配置保存成功，各画布生成节点已同步更新");
    };

    // 恢复系统默认工作流
    const handleReset = () => {
        if (!targetChannel || !sourceWorkflow) return;
        if (!builtinCounterpart) {
            message.info("未找到对应的系统内置工作流");
            return;
        }

        resetChannelWorkflowToBuiltin(targetChannel.id, sourceWorkflow.id);
        setName(builtinCounterpart.name);
        setDescription(builtinCounterpart.description || "");
        setWorkflowJson(JSON.parse(JSON.stringify(builtinCounterpart.json)));
        setIsDirty(false);
        message.success("已恢复为系统内置默认工作流");
    };

    // 导出/下载 JSON 文件
    const handleExportJson = () => {
        const jsonStr = JSON.stringify(workflowJson, null, 2);
        const blob = new Blob([jsonStr], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `${name || "workflow"}_api.json`;
        a.click();
        URL.revokeObjectURL(url);
    };

    // 复制 JSON 到剪贴板
    const handleCopyJson = async () => {
        const jsonStr = JSON.stringify(workflowJson, null, 2);
        await copyText(jsonStr);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
        message.success("已复制完整工作流 JSON 代码");
    };

    // 上传/替换 JSON 文件
    const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = (event) => {
            try {
                const parsed = JSON.parse(event.target?.result as string);
                if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
                    throw new Error("工作流 JSON 必须为对象结构（ComfyUI API 格式）");
                }
                setWorkflowJson(parsed as ComfyuiWorkflowJson);
                setIsDirty(true);
                message.success(`成功导入 ${file.name}`);
            } catch (err) {
                message.error(err instanceof Error ? err.message : "JSON 文件解析失败");
            }
        };
        reader.readAsText(file);
        if (fileInputRef.current) fileInputRef.current.value = "";
    };

    if (!targetChannel || !sourceWorkflow) {
        return (
            <main className="flex h-full flex-col items-center justify-center p-6 bg-background">
                <Empty description="未找到对应的工作流或渠道配置" />
                <Button className="mt-4" icon={<ArrowLeft className="size-4" />} onClick={() => navigate("/config")}>
                    返回设置
                </Button>
            </main>
        );
    }

    const jsonString = JSON.stringify(workflowJson, null, 2);
    const nodeCount = Object.keys(workflowJson).length;
    const isCustom = !sourceWorkflow.isBuiltin;

    return (
        <main className="flex h-full flex-col overflow-hidden bg-background text-foreground">
            {/* 顶栏控制条 */}
            <header className="flex shrink-0 items-center justify-between border-b border-stone-200 bg-background/90 px-6 py-3 backdrop-blur-md dark:border-stone-800">
                <div className="flex items-center gap-3">
                    <Link
                        to="/config"
                        className="inline-flex items-center gap-1.5 rounded-lg border border-stone-200 bg-stone-50 px-3 py-1.5 text-xs font-medium text-stone-700 transition hover:bg-stone-100 dark:border-stone-800 dark:bg-stone-900/60 dark:text-stone-300 dark:hover:bg-stone-800"
                    >
                        <ArrowLeft className="size-3.5" />
                        <span>返回设置</span>
                    </Link>
                    <div className="h-4 w-px bg-stone-200 dark:bg-stone-800" />
                    <div className="flex items-center gap-2">
                        <Sliders className="size-4 text-blue-500" />
                        <h1 className="text-base font-semibold leading-none text-stone-950 dark:text-stone-100">
                            工作流配置与编辑
                        </h1>
                        <span
                            className={`inline-flex items-center rounded px-2 py-0.5 text-xs font-medium ${
                                isCustom
                                    ? "bg-amber-100 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300"
                                    : "bg-blue-100 text-blue-800 dark:bg-blue-950/50 dark:text-blue-300"
                            }`}
                        >
                            {isCustom ? "自定义版本" : "系统内置"}
                        </span>
                        <Tag className="m-0 text-xs">{sourceWorkflow.category}</Tag>
                    </div>
                </div>

                <div className="flex items-center gap-2.5">
                    {builtinCounterpart && (
                        <Button
                            size="small"
                            icon={<RotateCcw className="size-3.5" />}
                            onClick={handleReset}
                            title="恢复为系统出厂内置工作流"
                        >
                            恢复系统默认
                        </Button>
                    )}
                    <Button
                        size="small"
                        type="primary"
                        icon={<Save className="size-3.5" />}
                        disabled={!isDirty}
                        onClick={handleSave}
                    >
                        保存修改
                    </Button>
                </div>
            </header>

            {/* 主工作区（双栏布局） */}
            <div className="flex min-h-0 flex-1 overflow-hidden">
                {/* 左栏：基础信息与动态选择框面板 */}
                <div className="flex w-full flex-col border-r border-stone-200 lg:w-[480px] xl:w-[540px] dark:border-stone-800">
                    <div className="thin-scrollbar flex-1 overflow-y-auto p-5 space-y-5">
                        {/* 基础信息卡片 */}
                        <div className="rounded-xl border border-stone-200/90 bg-stone-50/50 p-4 dark:border-stone-800/80 dark:bg-stone-900/30">
                            <div className="text-xs font-semibold text-stone-700 dark:text-stone-300 mb-3 flex items-center justify-between">
                                <span>工作流基础信息</span>
                                <span className="text-[11px] font-normal text-stone-400">
                                    渠道：{targetChannel.name}
                                </span>
                            </div>
                            <div className="space-y-3">
                                <div>
                                    <label className="mb-1 block text-xs text-stone-500">工作流名称</label>
                                    <Input
                                        size="middle"
                                        value={name}
                                        onChange={(e) => {
                                            setName(e.target.value);
                                            setIsDirty(true);
                                        }}
                                        placeholder="工作流名称"
                                    />
                                </div>
                                <div>
                                    <label className="mb-1 block text-xs text-stone-500">工作流说明与描述</label>
                                    <Input.TextArea
                                        rows={2}
                                        value={description}
                                        onChange={(e) => {
                                            setDescription(e.target.value);
                                            setIsDirty(true);
                                        }}
                                        placeholder="填写适用模型规格、采样步数等说明..."
                                    />
                                </div>
                            </div>
                        </div>

                        {/* 动态大模型与参数选择框面板 */}
                        <div className="rounded-xl border border-stone-200/90 bg-white p-4 shadow-2xs dark:border-stone-800 dark:bg-stone-900/50">
                            <div className="mb-3 flex items-center justify-between">
                                <div className="flex items-center gap-2">
                                    <Layers className="size-4 text-stone-600 dark:text-stone-300" />
                                    <span className="text-xs font-semibold text-stone-800 dark:text-stone-200">
                                        工作流大模型与动态参数配置
                                    </span>
                                </div>
                                <span className="text-xs text-stone-400">
                                    检测到 {selectNodes.length} 个选择节点
                                </span>
                            </div>

                            {selectNodes.length === 0 ? (
                                <div className="rounded-lg border border-dashed border-stone-200 p-5 text-center dark:border-stone-800">
                                    <AlertCircle className="mx-auto size-6 text-stone-400 mb-2" />
                                    <div className="text-xs font-medium text-stone-700 dark:text-stone-300">
                                        当前工作流未标注 select_models_* 选择节点
                                    </div>
                                    <p className="mt-1 text-[11px] leading-relaxed text-stone-400">
                                        如需在此处启用大模型下拉选择，请在 ComfyUI 导出时，将对应 Loader 节点的{" "}
                                        <code className="rounded bg-stone-100 px-1 py-0.5 text-stone-700 dark:bg-stone-800 dark:text-stone-300">
                                            _meta.title
                                        </code>{" "}
                                        标注为例如{" "}
                                        <code className="rounded bg-stone-100 px-1 py-0.5 text-stone-700 dark:bg-stone-800 dark:text-stone-300">
                                            select_models_diffusion_models
                                        </code>{" "}
                                        或{" "}
                                        <code className="rounded bg-stone-100 px-1 py-0.5 text-stone-700 dark:bg-stone-800 dark:text-stone-300">
                                            select_models_clip
                                        </code>
                                        。
                                    </p>
                                </div>
                            ) : (
                                <div className="space-y-4">
                                    {selectNodes.map((node) => {
                                        const catKey = node.modelType;
                                        const modelState = modelsMap[catKey] || { loading: false, items: [] };
                                        const isLoading = modelState.loading;
                                        const items = modelState.items;
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
                                                className="rounded-lg border border-stone-200/70 bg-stone-50/40 p-3 dark:border-stone-800 dark:bg-stone-900/30"
                                            >
                                                <div className="mb-2 flex items-center justify-between gap-2">
                                                    <div className="flex items-center gap-1.5 truncate">
                                                        <span className="text-xs font-semibold text-stone-800 dark:text-stone-200">
                                                            {node.title}
                                                        </span>
                                                        <span className="text-[10px] text-stone-400">
                                                            (节点 #{node.nodeId} · {node.classType || "Loader"})
                                                        </span>
                                                    </div>
                                                    <Tooltip title="从 ComfyUI 重新刷新此模型列表">
                                                        <Button
                                                            size="small"
                                                            type="text"
                                                            icon={<RefreshCw className={`size-3 text-stone-500 ${isLoading ? "animate-spin" : ""}`} />}
                                                            onClick={() => void loadModels(catKey, true)}
                                                        />
                                                    </Tooltip>
                                                </div>

                                                <div className="space-y-1.5">
                                                    <div className="flex items-center justify-between text-[11px] text-stone-500">
                                                        <span>目标输入字段：<code className="text-blue-600 dark:text-blue-400">{node.inputKey}</code></span>
                                                        <span className="text-stone-400">ComfyUI 分类：{catKey}</span>
                                                    </div>

                                                    <Select
                                                        className="w-full"
                                                        showSearch
                                                        value={node.currentValue || undefined}
                                                        placeholder={isLoading ? "正在从 ComfyUI 获取模型列表..." : `请选择 ${node.modelType} 模型`}
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
                                                                        onClick={() => void loadModels(catKey, true)}
                                                                    >
                                                                        重试
                                                                    </Button>
                                                                </div>
                                                            ) : (
                                                                <div className="p-2 text-center text-xs text-stone-400">
                                                                    未找到该分类模型文件
                                                                </div>
                                                            )
                                                        }
                                                    />

                                                    {node.currentValue && (
                                                        <div className="truncate text-[11px] text-stone-400">
                                                            当前值：<span className="font-mono text-stone-600 dark:text-stone-300">{node.currentValue}</span>
                                                        </div>
                                                    )}
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
                            )}
                        </div>
                    </div>
                </div>

                {/* 右栏：工作流 JSON 预览与代码审查 */}
                <div className="hidden flex-1 flex-col bg-stone-50/30 lg:flex dark:bg-stone-950/20">
                    <div className="flex shrink-0 items-center justify-between border-b border-stone-200 bg-white px-5 py-2.5 dark:border-stone-800 dark:bg-stone-900/60">
                        <div className="flex items-center gap-2">
                            <span className="text-xs font-semibold text-stone-700 dark:text-stone-300">
                                工作流 JSON 预览
                            </span>
                            <span className="text-[11px] text-stone-400">
                                ({nodeCount} 个节点 · {jsonString.length < 1024 ? `${jsonString.length} B` : `${(jsonString.length / 1024).toFixed(1)} KB`})
                            </span>
                        </div>

                        <div className="flex items-center gap-1.5">
                            <input
                                ref={fileInputRef}
                                type="file"
                                accept=".json"
                                className="hidden"
                                onChange={handleFileChange}
                            />
                            <Button
                                size="small"
                                icon={<Upload className="size-3.5" />}
                                onClick={() => fileInputRef.current?.click()}
                            >
                                导入 JSON
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

                    <div className="thin-scrollbar flex-1 overflow-auto p-4">
                        <pre className="font-mono text-xs leading-relaxed text-stone-800 select-text dark:text-stone-200 whitespace-pre-wrap break-all">
                            {jsonString}
                        </pre>
                    </div>
                </div>
            </div>
        </main>
    );
}
