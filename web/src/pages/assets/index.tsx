import { Copy, Download, PencilLine, Search, Trash2, Upload } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { App, Button, Card, Checkbox, Drawer, Empty, Form, Image, Input, Modal, Pagination, Select, Space, Tag, Typography } from "antd";
import { saveAs } from "file-saver";
import { useTranslation } from "react-i18next";

import { useCopyText } from "@/hooks/use-copy-text";
import { AUDIO_FILE_EXTENSIONS } from "@/lib/canvas/canvas-generation-helpers";
import { formatBytes, readFileAsDataUrl } from "@/lib/image-utils";
import { uploadImage } from "@/services/image-storage";
import { cn } from "@/lib/utils";
import i18n from "@/i18n";
import { uploadMediaFile } from "@/services/file-storage";
import { resolveBundleCover, useAssetStore, type Asset, type AssetKind, type AudioAsset, type BundleAsset, type BundleItem, type ImageAsset, type VideoAsset } from "@/stores/use-asset-store";
import { exportAssets, readAssetPackage, remapBundleIds } from "./asset-transfer";

type AssetFormValues = {
    kind: AssetKind;
    title: string;
    coverUrl: string;
    tags: string[];
    source?: string;
    note?: string;
    content?: string;
};

type ImageDraft = ImageAsset["data"] | null;
type AudioDraft = AudioAsset["data"] | null;
type VideoDraft = VideoAsset["data"] | null;

const kindOptions = ["all", "text", "image", "video", "audio", "bundle"] as const;

export default function AssetsPage() {
    const { message } = App.useApp();
    const { t } = useTranslation();
    const copyText = useCopyText();
    const [form] = Form.useForm<AssetFormValues>();
    const coverInputRef = useRef<HTMLInputElement>(null);
    const imageInputRef = useRef<HTMLInputElement>(null);
    const audioInputRef = useRef<HTMLInputElement>(null);
    const videoInputRef = useRef<HTMLInputElement>(null);
    const assetInputRef = useRef<HTMLInputElement>(null);
    const assets = useAssetStore((state) => state.assets);
    const addAsset = useAssetStore((state) => state.addAsset);
    const updateAsset = useAssetStore((state) => state.updateAsset);
    const removeAsset = useAssetStore((state) => state.removeAsset);
    const removeAssets = useAssetStore((state) => state.removeAssets);
    const [keyword, setKeyword] = useState("");
    const [kindFilter, setKindFilter] = useState<AssetKind | "all">("all");
    const [page, setPage] = useState(1);
    const [pageSize, setPageSize] = useState(10);
    const [editingAsset, setEditingAsset] = useState<Asset | null>(null);
    const [isAssetOpen, setIsAssetOpen] = useState(false);
    const [previewAsset, setPreviewAsset] = useState<Asset | null>(null);
    const [deletingAsset, setDeletingAsset] = useState<Asset | null>(null);
    const [batchDeleting, setBatchDeleting] = useState(false);
    const [formKind, setFormKind] = useState<AssetKind>("text");
    const [imageDraft, setImageDraft] = useState<ImageDraft>(null);
    const [audioDraft, setAudioDraft] = useState<AudioDraft>(null);
    const [videoDraft, setVideoDraft] = useState<VideoDraft>(null);
    const [selectedAssetIds, setSelectedAssetIds] = useState<string[]>([]);
    const coverUrl = Form.useWatch("coverUrl", form) || "";
    const title = Form.useWatch("title", form) || "";
    const tags = Form.useWatch("tags", form) || [];
    const content = Form.useWatch("content", form) || "";
    const validAssets = useMemo(() => assets.filter((asset) => asset.kind === "text" || asset.kind === "image" || asset.kind === "video" || asset.kind === "audio" || asset.kind === "bundle"), [assets]);

    const assetsById = useMemo(() => new Map(validAssets.map((asset) => [asset.id, asset])), [validAssets]);

    const filteredAssets = useMemo(() => {
        const query = keyword.trim().toLowerCase();
        return validAssets.filter((asset) => {
            if (kindFilter !== "all" && asset.kind !== kindFilter) return false;
            if (!query) return true;
            return assetSearchText(asset, assetsById).includes(query);
        });
    }, [validAssets, keyword, kindFilter, assetsById]);

    const visibleAssets = useMemo(() => {
        const start = (page - 1) * pageSize;
        return filteredAssets.slice(start, start + pageSize);
    }, [filteredAssets, page, pageSize]);

    useEffect(() => {
        const maxPage = Math.max(1, Math.ceil(filteredAssets.length / pageSize));
        setPage((value) => Math.min(value, maxPage));
    }, [filteredAssets.length, pageSize]);

    const openCreate = () => {
        setEditingAsset(null);
        setImageDraft(null);
        setAudioDraft(null);
        setVideoDraft(null);
        setFormKind("text");
        form.setFieldsValue({ kind: "text", title: "", coverUrl: "", tags: [], source: t("assets.manual"), note: "", content: "" });
        setIsAssetOpen(true);
    };

    const openEdit = (asset: Asset) => {
        setEditingAsset(asset);
        setFormKind(asset.kind);
        setImageDraft(asset.kind === "image" ? asset.data : null);
        setAudioDraft(asset.kind === "audio" ? asset.data : null);
        setVideoDraft(asset.kind === "video" ? asset.data : null);
        form.setFieldsValue({
            kind: asset.kind,
            title: asset.title,
            coverUrl: asset.coverUrl,
            tags: asset.tags || [],
            source: asset.source,
            note: asset.note,
            content: asset.kind === "text" ? asset.data.content : "",
        });
        setIsAssetOpen(true);
    };

    const saveAsset = async () => {
        const values = await form.validateFields();
        const base = {
            title: values.title.trim(),
            coverUrl: values.coverUrl?.trim() || (values.kind === "image" && imageDraft ? imageDraft.dataUrl : ""),
            tags: values.tags || [],
            source: values.source?.trim(),
            note: values.note?.trim(),
            metadata: editingAsset?.metadata || { source: "manual" },
        };

        if (values.kind === "text") {
            const asset = { ...base, kind: "text" as const, data: { content: (values.content || "").trim() } };
            editingAsset ? updateAsset(editingAsset.id, asset) : addAsset(asset);
        } else if (values.kind === "video") {
            if (!videoDraft) {
                message.error(t("assets.noVideoSelected"));
                return;
            }
            const asset = { ...base, kind: "video" as const, data: videoDraft };
            editingAsset ? updateAsset(editingAsset.id, asset) : addAsset(asset);
        } else if (values.kind === "audio") {
            if (!audioDraft) {
                message.error(t("assets.noAudioSelected"));
                return;
            }
            const asset = { ...base, kind: "audio" as const, data: audioDraft };
            editingAsset ? updateAsset(editingAsset.id, asset) : addAsset(asset);
        } else {
            if (!imageDraft) {
                message.error(t("assets.selectImage"));
                return;
            }
            const asset = { ...base, kind: "image" as const, data: imageDraft };
            editingAsset ? updateAsset(editingAsset.id, asset) : addAsset(asset);
        }

        message.success(editingAsset ? t("assets.updated") : t("assets.saved"));
        setIsAssetOpen(false);
    };

    const readCoverFile = async (file?: File) => {
        if (!file) return;
        const dataUrl = await readFileAsDataUrl(file);
        form.setFieldValue("coverUrl", dataUrl);
    };

    const readImageFile = async (file?: File) => {
        if (!file || !file.type.startsWith("image/")) return;
        const image = await uploadImage(file);
        const draft = { dataUrl: image.url, storageKey: image.storageKey, width: image.width, height: image.height, bytes: image.bytes, mimeType: image.mimeType };
        setImageDraft(draft);
        if (!form.getFieldValue("coverUrl")) form.setFieldValue("coverUrl", draft.dataUrl);
        if (!form.getFieldValue("title")) form.setFieldValue("title", file.name);
    };

    const readAudioFile = async (file?: File) => {
        if (!file || !file.type.startsWith("audio/")) return;
        const audio = await uploadMediaFile(file, "audio");
        setAudioDraft({ url: audio.url, storageKey: audio.storageKey, durationMs: audio.durationMs, bytes: audio.bytes, mimeType: audio.mimeType });
        if (!form.getFieldValue("title")) form.setFieldValue("title", file.name);
    };

    const readVideoFile = async (file?: File) => {
        if (!file || !file.type.startsWith("video/")) return;
        const video = await uploadMediaFile(file, "video");
        setVideoDraft({ url: video.url, storageKey: video.storageKey, width: video.width || 0, height: video.height || 0, bytes: video.bytes, mimeType: video.mimeType });
        if (!form.getFieldValue("title")) form.setFieldValue("title", file.name);
    };

    const copyAssetText = async (asset: Asset) => {
        if (asset.kind !== "text") return;
        copyText(asset.data.content, t("assets.textCopied"));
    };

    const downloadImage = (asset: Asset) => {
        if (asset.kind !== "image" && asset.kind !== "video" && asset.kind !== "audio") return;
        const url = asset.kind === "image" ? asset.data.dataUrl : asset.data.url;
        saveAs(url, `${asset.title || "asset"}.${asset.data.mimeType.split("/")[1] || "png"}`);
    };

    const exportAllAssets = async () => {
        if (!validAssets.length) {
            message.warning(t("assets.noneToExport"));
            return;
        }
        await exportAssets(validAssets, t("assets.packageName"));
    };

    const importAssetZip = async (file?: File) => {
        if (!file) return;
        try {
            const importedAssets = await readAssetPackage(file);
            const idMap = new Map<string, string>();
            // 先导入原子资产，记录 oldId → newId；再导入组合，把条目重映射到新 id。
            importedAssets
                .filter((asset) => asset.kind !== "bundle")
                .forEach((asset) => {
                    const { id, createdAt, updatedAt, ...rest } = asset;
                    idMap.set(id, addAsset(rest as Parameters<typeof addAsset>[0]));
                });
            importedAssets
                .filter((asset): asset is BundleAsset => asset.kind === "bundle")
                .forEach((bundle) => {
                    const { id, createdAt, updatedAt, ...rest } = bundle;
                    addAsset(remapBundleIds(rest as BundleAsset, idMap) as Parameters<typeof addAsset>[0]);
                });
            message.success(t("assets.imported", { count: importedAssets.length }));
        } catch {
            message.error(t("assets.importFailed"));
        } finally {
            if (assetInputRef.current) assetInputRef.current.value = "";
        }
    };

    const confirmDelete = () => {
        if (!deletingAsset) return;
        removeAsset(deletingAsset.id);
        message.success(t("assets.deleted"));
        setDeletingAsset(null);
    };

    const toggleAssetSelection = (id: string) =>
        setSelectedAssetIds((prev) => (prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]));

    const buildBundleItems = (ids: string[]) => ids.map((assetId, index) => ({ assetId, slot: "reference" as const, order: index }));

    const packSelectedIntoBundle = () => {
        if (!selectedAssetIds.length) return;
        addAsset({
            kind: "bundle",
            title: t("assets.bundleDefaultTitle"),
            coverUrl: "",
            tags: [],
            source: t("assets.manual"),
            data: { items: buildBundleItems(selectedAssetIds), coverAssetId: selectedAssetIds[0] },
        });
        setSelectedAssetIds([]);
        message.success(t("assets.saved"));
    };

    const addSelectedToBundle = (bundle: BundleAsset) => {
        if (!selectedAssetIds.length) return;
        const existing = new Set(bundle.data.items.map((item) => item.assetId));
        const additions = selectedAssetIds.filter((id) => !existing.has(id)).map((assetId, index) => ({ assetId, slot: "reference" as const, order: bundle.data.items.length + index }));
        if (!additions.length) {
            setSelectedAssetIds([]);
            return;
        }
        updateAsset(bundle.id, { data: { ...bundle.data, items: [...bundle.data.items, ...additions] } });
        setSelectedAssetIds([]);
    };

    const removeBundleItem = (bundle: BundleAsset, assetId: string) => {
        const items = bundle.data.items.filter((item) => item.assetId !== assetId).map((item, index) => ({ ...item, order: index }));
        updateAsset(bundle.id, { data: { items, coverAssetId: bundle.data.coverAssetId === assetId ? items[0]?.assetId : bundle.data.coverAssetId } });
    };

    const setBundleCover = (bundle: BundleAsset, assetId: string) => updateAsset(bundle.id, { data: { ...bundle.data, coverAssetId: assetId } });

    const setBundleItemSlot = (bundle: BundleAsset, assetId: string, slot: BundleItem["slot"]) =>
        updateAsset(bundle.id, { data: { ...bundle.data, items: bundle.data.items.map((item) => (item.assetId === assetId ? { ...item, slot } : item)) } });

    const moveBundleItem = (bundle: BundleAsset, index: number, delta: number) => {
        const items = [...bundle.data.items].sort((a, b) => a.order - b.order);
        const target = index + delta;
        if (target < 0 || target >= items.length) return;
        const swapped = [...items];
        [swapped[index], swapped[target]] = [swapped[target], swapped[index]];
        updateAsset(bundle.id, { data: { ...bundle.data, items: swapped.map((item, order) => ({ ...item, order })) } });
    };

    // 抽屉里的资产从 store 取最新一份，增删条目后自动刷新。
    const previewAssetLive = previewAsset ? validAssets.find((item) => item.id === previewAsset.id) || previewAsset : null;

    return (
        <div className="flex h-full flex-col overflow-hidden bg-background text-stone-900 dark:text-stone-100">
            <main className="min-h-0 flex-1 overflow-y-auto bg-[radial-gradient(#e5e7eb_1px,transparent_1px)] px-6 py-8 [background-size:16px_16px] dark:bg-[radial-gradient(rgba(245,245,244,.14)_1px,transparent_1px)]">
                <div className="pb-8">
                    <div className="mx-auto max-w-5xl text-center">
                        <h1 className="text-4xl font-semibold tracking-tight text-stone-950 dark:text-stone-100">{t("assets.title")}</h1>
                        <p className="mt-3 text-sm text-stone-500 dark:text-stone-400">{t("assets.description")}</p>
                    </div>

                    <div className="mx-auto mt-8 w-full max-w-2xl">
                        <Input.Search
                            className="w-full"
                            size="large"
                            allowClear
                            prefix={<Search className="size-4 text-stone-400" />}
                            value={keyword}
                            placeholder={t("assets.search")}
                            onChange={(event) => {
                                setPage(1);
                                setKeyword(event.target.value);
                            }}
                            onSearch={(value) => {
                                setPage(1);
                                setKeyword(value);
                            }}
                        />
                    </div>

                    <div className="mx-auto mt-6 grid max-w-6xl gap-3 text-left">
                        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                            <div className="grid gap-2 sm:grid-cols-[56px_minmax(0,1fr)] sm:items-center">
                                <div className="text-xs font-medium text-stone-500 dark:text-stone-400">{t("assets.type")}</div>
                                <div className="flex flex-wrap gap-2">
                                    {kindOptions.map((option) => (
                                        <Tag.CheckableTag
                                            key={option}
                                            checked={kindFilter === option}
                                            className={cn("prompt-filter-tag", kindFilter === option && "is-active")}
                                            onChange={() => {
                                                setPage(1);
                                                setKindFilter(option);
                                            }}
                                        >
                                            {option === "all" ? t("common.all") : t(`assets.kinds.${option}`)}
                                        </Tag.CheckableTag>
                                    ))}
                                </div>
                            </div>
                            <div className="flex flex-wrap gap-4">
                                <button
                                    type="button"
                                    className="cursor-pointer text-sm font-medium text-stone-700 underline-offset-4 hover:underline focus-visible:outline-none focus-visible:underline dark:text-stone-300"
                                    onClick={() => void exportAllAssets()}
                                >
                                    {t("assets.export")}
                                </button>
                                <button
                                    type="button"
                                    className="cursor-pointer text-sm font-medium text-stone-700 underline-offset-4 hover:underline focus-visible:outline-none focus-visible:underline dark:text-stone-300"
                                    onClick={() => assetInputRef.current?.click()}
                                >
                                    {t("assets.import")}
                                </button>
                                <button
                                    type="button"
                                    className="cursor-pointer text-sm font-medium text-stone-700 underline-offset-4 hover:underline focus-visible:outline-none focus-visible:underline dark:text-stone-300"
                                    onClick={openCreate}
                                >
                                    {t("assets.add")}
                                </button>
                            </div>
                        </div>
                    </div>
                </div>

                <div className="mx-auto flex max-w-7xl flex-col gap-5">
                    <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                        {visibleAssets.map((asset) => (
                            <AssetCard
                                key={asset.id}
                                asset={asset}
                                assetsById={assetsById}
                                selected={selectedAssetIds.includes(asset.id)}
                                onToggleSelect={() => toggleAssetSelection(asset.id)}
                                onOpen={() => setPreviewAsset(asset)}
                                onEdit={() => openEdit(asset)}
                                onCopy={copyAssetText}
                                onDownload={downloadImage}
                                onDelete={() => setDeletingAsset(asset)}
                            />
                        ))}
                    </div>

                    {!visibleAssets.length ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("assets.empty")} className="py-20" /> : null}

                    <div className="flex justify-center">
                        {selectedAssetIds.length ? (
                            <div className="flex flex-wrap items-center gap-3 rounded-lg border border-stone-200 bg-stone-50 px-3 py-2 text-sm dark:border-stone-800 dark:bg-stone-900">
                                <span className="font-medium">{t("assets.selectedCount", { count: selectedAssetIds.length })}</span>
                                <Button size="small" type="primary" onClick={packSelectedIntoBundle}>
                                    {t("assets.packSelected", { count: selectedAssetIds.length })}
                                </Button>
                                <Button size="small" danger onClick={() => setBatchDeleting(true)}>
                                    {t("assets.deleteSelected", { count: selectedAssetIds.length })}
                                </Button>
                                <button type="button" className="cursor-pointer text-xs underline underline-offset-4" onClick={() => setSelectedAssetIds([])}>
                                    {t("assets.clearSelection")}
                                </button>
                            </div>
                        ) : null}

                        <Pagination
                            current={page}
                            pageSize={pageSize}
                            total={filteredAssets.length}
                            showSizeChanger
                            pageSizeOptions={[10, 20, 50, 100]}
                            onChange={(nextPage, nextPageSize) => {
                                setPage(nextPage);
                                setPageSize(nextPageSize);
                            }}
                        />
                    </div>
                </div>
            </main>

            <Modal title={editingAsset ? t("assets.edit") : t("assets.add")} open={isAssetOpen} width={980} onCancel={() => setIsAssetOpen(false)} onOk={() => void saveAsset()} okText={t("common.save")} cancelText={t("common.cancel")} destroyOnHidden>
                <div className="grid gap-6 pt-1 lg:grid-cols-[minmax(0,1fr)_320px]">
                    <Form form={form} layout="vertical" requiredMark={false} initialValues={{ kind: "text", tags: [] }}>
                        <Form.Item name="kind" label={t("assets.type")}>
                            <Select
                                options={[
                                    { label: t("assets.kinds.text"), value: "text" },
                                    { label: t("assets.kinds.image"), value: "image" },
                                    { label: t("assets.kinds.audio"), value: "audio" },
                                    { label: t("assets.kinds.video"), value: "video" },
                                ]}
                                onChange={(value) => setFormKind(value)}
                            />
                        </Form.Item>
                        <Form.Item name="title" label={t("assets.fields.title")} rules={[{ required: true, message: t("assets.fields.titleRequired") }]}>
                            <Input size="large" placeholder={t("assets.fields.titlePlaceholder")} />
                        </Form.Item>
                        <Form.Item name="coverUrl" label={t("assets.fields.coverUrl")}>
                            <Space.Compact className="w-full">
                                <Input placeholder={t("assets.fields.coverPlaceholder")} />
                                <Button icon={<Upload className="size-3.5" />} onClick={() => coverInputRef.current?.click()}>
                                    {t("common.upload")}
                                </Button>
                            </Space.Compact>
                        </Form.Item>
                        <Form.Item name="tags" label={t("assets.fields.tags")}>
                            <Select mode="tags" tokenSeparators={[",", "，"]} placeholder={t("assets.fields.tagsPlaceholder")} />
                        </Form.Item>
                        <div className="grid gap-4 sm:grid-cols-2">
                            <Form.Item name="source" label={t("assets.fields.source")}>
                                <Input placeholder={t("assets.fields.sourcePlaceholder")} />
                            </Form.Item>
                            <Form.Item name="note" label={t("assets.fields.note")}>
                                <Input placeholder={t("assets.fields.optional")} />
                            </Form.Item>
                        </div>
                        {formKind === "text" ? (
                            <Form.Item name="content" label={t("assets.fields.textContent")} rules={[{ required: true, message: t("assets.fields.textRequired") }]}>
                                <Input.TextArea rows={8} placeholder={t("assets.fields.textPlaceholder")} />
                            </Form.Item>
                        ) : formKind === "video" ? (
                            <Form.Item label={t("assets.fields.imageContent")} required>
                                <div className="rounded-lg border border-dashed border-stone-300 p-4 dark:border-stone-700">
                                    <Button icon={<Upload className="size-4" />} onClick={() => videoInputRef.current?.click()}>
                                        {t("assets.selectVideoFile")}
                                    </Button>
                                    {videoDraft ? (
                                        <Typography.Text type="secondary" className="ml-3 text-xs">
                                            {videoDraft.width}x{videoDraft.height} · {formatBytes(videoDraft.bytes)}
                                        </Typography.Text>
                                    ) : (
                                        <Typography.Text type="secondary" className="ml-3 text-xs">
                                            {t("assets.noVideoSelected")}
                                        </Typography.Text>
                                    )}
                                </div>
                            </Form.Item>
                        ) : formKind === "audio" ? (
                            <Form.Item label={t("assets.fields.imageContent")} required>
                                <div className="rounded-lg border border-dashed border-stone-300 p-4 dark:border-stone-700">
                                    <Button icon={<Upload className="size-4" />} onClick={() => audioInputRef.current?.click()}>
                                        {t("assets.selectAudioFile")}
                                    </Button>
                                    {audioDraft ? (
                                        <Typography.Text type="secondary" className="ml-3 text-xs">
                                            {formatBytes(audioDraft.bytes)} · {audioDraft.mimeType}
                                        </Typography.Text>
                                    ) : (
                                        <Typography.Text type="secondary" className="ml-3 text-xs">
                                            {t("assets.noAudioSelected")}
                                        </Typography.Text>
                                    )}
                                </div>
                            </Form.Item>
                        ) : (
                            <Form.Item label={t("assets.fields.imageContent")} required>
                                <div className="rounded-lg border border-dashed border-stone-300 p-4 dark:border-stone-700">
                                    <Button icon={<Upload className="size-4" />} onClick={() => imageInputRef.current?.click()}>
                                        {t("assets.selectImageFile")}
                                    </Button>
                                    {imageDraft ? (
                                        <Typography.Text type="secondary" className="ml-3 text-xs">
                                            {imageDraft.width}x{imageDraft.height} · {formatBytes(imageDraft.bytes)}
                                        </Typography.Text>
                                    ) : (
                                        <Typography.Text type="secondary" className="ml-3 text-xs">
                                            {t("assets.noImageSelected")}
                                        </Typography.Text>
                                    )}
                                </div>
                            </Form.Item>
                        )}
                    </Form>
                    <div className="rounded-xl border border-stone-200 bg-stone-50 p-4 dark:border-stone-800 dark:bg-stone-950">
                        <Typography.Text strong>{t("assets.preview")}</Typography.Text>
                        <div className="mt-3 overflow-hidden rounded-lg border border-stone-200 bg-background dark:border-stone-800">
                            {coverUrl || imageDraft?.dataUrl ? (
                                <img src={coverUrl || imageDraft?.dataUrl} alt="" className="aspect-[4/3] w-full object-cover" />
                            ) : (
                                <div className="flex aspect-[4/3] items-center justify-center bg-stone-100 p-5 text-center text-sm text-stone-500 dark:bg-stone-900">{content || t("assets.noCover")}</div>
                            )}
                            <div className="p-4">
                                <Typography.Text strong ellipsis className="block">
                                    {title || t("assets.untitled")}
                                </Typography.Text>
                                <div className="mt-2 flex flex-wrap gap-1.5">
                                    {tags.length ? (
                                        tags.map((tag) => (
                                            <Tag key={tag} className="m-0">
                                                {tag}
                                            </Tag>
                                        ))
                                    ) : (
                                        <Tag className="m-0">{t("assets.untagged")}</Tag>
                                    )}
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
                <input
                    ref={coverInputRef}
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={(event) => {
                        void readCoverFile(event.target.files?.[0]);
                        event.target.value = "";
                    }}
                />
                <input
                    ref={imageInputRef}
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={(event) => {
                        void readImageFile(event.target.files?.[0]);
                        event.target.value = "";
                    }}
                />
                <input
                    ref={audioInputRef}
                    type="file"
                    accept={`audio/*,${AUDIO_FILE_EXTENSIONS.map((ext) => `.${ext}`).join(",")}`}
                    className="hidden"
                    onChange={(event) => {
                        void readAudioFile(event.target.files?.[0]);
                        event.target.value = "";
                    }}
                />
                <input
                    ref={videoInputRef}
                    type="file"
                    accept="video/*"
                    className="hidden"
                    onChange={(event) => {
                        void readVideoFile(event.target.files?.[0]);
                        event.target.value = "";
                    }}
                />
            </Modal>

            <AssetDrawer
                asset={previewAssetLive}
                assetsById={assetsById}
                selectedCount={selectedAssetIds.length}
                onClose={() => setPreviewAsset(null)}
                onCopy={copyAssetText}
                onDownload={downloadImage}
                onOpenAsset={(target) => setPreviewAsset(target)}
                onAddSelected={addSelectedToBundle}
                onRemoveItem={removeBundleItem}
                onSetCover={setBundleCover}
                onSetSlot={setBundleItemSlot}
                onMoveItem={moveBundleItem}
            />

            <input ref={assetInputRef} type="file" accept="application/zip,.zip" className="hidden" onChange={(event) => void importAssetZip(event.target.files?.[0])} />

            <Modal title={t("assets.deleteTitle")} open={Boolean(deletingAsset)} onCancel={() => setDeletingAsset(null)} onOk={confirmDelete} okText={t("common.delete")} okButtonProps={{ danger: true }} cancelText={t("common.cancel")}>
                {t("assets.deleteConfirm", { name: deletingAsset?.title })}
            </Modal>

            <Modal title={t("assets.deleteSelectedTitle")} open={batchDeleting} onCancel={() => setBatchDeleting(false)} onOk={() => { removeAssets(selectedAssetIds); message.success(t("assets.deleted")); setSelectedAssetIds([]); setBatchDeleting(false); }} okText={t("common.delete")} okButtonProps={{ danger: true }} cancelText={t("common.cancel")}>
                {t("assets.deleteSelectedConfirm", { count: selectedAssetIds.length })}
            </Modal>
        </div>
    );
}

/** 资产封面：组合资产用"显式封面条目 → 第一个有条目封面的资产"来解析。 */
const BUNDLE_SLOT_OPTIONS: BundleItem["slot"][] = ["primary", "outfit", "accessory", "voice", "reference"];

function assetCover(asset: Asset, assetsById: Map<string, Asset>): string {
    if (asset.kind === "bundle") return resolveBundleCover(asset, [...assetsById.values()]);
    if (asset.kind === "image") return asset.coverUrl || asset.data.dataUrl;
    return asset.coverUrl;
}

function AssetCard({
    asset,
    assetsById,
    selected,
    onToggleSelect,
    onOpen,
    onEdit,
    onCopy,
    onDownload,
    onDelete,
}: {
    asset: Asset;
    assetsById: Map<string, Asset>;
    selected: boolean;
    onToggleSelect: () => void;
    onOpen: () => void;
    onEdit: () => void;
    onCopy: (asset: Asset) => void;
    onDownload: (asset: Asset) => void;
    onDelete: () => void;
}) {
    const { t } = useTranslation();
    const cover = assetCover(asset, assetsById);
    const summary = assetSummary(asset);
    return (
        <Card
            hoverable
            className="overflow-hidden"
            styles={{ body: { padding: 0 } }}
            cover={
                <div className="relative">
                    <button type="button" className="block w-full text-left" onClick={onOpen}>
                        {cover ? (
                            <img src={cover} alt={asset.title} className="aspect-[4/3] w-full object-cover" />
                        ) : (
                            <div className="flex aspect-[4/3] items-center justify-center bg-stone-100 p-5 text-center text-sm leading-6 text-stone-600 dark:bg-stone-900 dark:text-stone-300">{asset.kind === "text" ? asset.data.content : t("assets.noCover")}</div>
                        )}
                    </button>
                    <span className="absolute left-2 top-2 rounded bg-white/85 px-1.5 py-1 dark:bg-black/60">
                        <Checkbox checked={selected} aria-label={asset.title} onChange={onToggleSelect} />
                    </span>
                </div>
            }
        >
            <button type="button" className="block w-full text-left" onClick={onOpen}>
                <div className="p-4">
                    <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                            <h2 className="line-clamp-1 text-sm font-semibold text-stone-950 dark:text-stone-100">{asset.title}</h2>
                            <Typography.Text type="secondary" className="mt-1 block text-xs">
                                {asset.source || t("assets.unknownSource")}
                            </Typography.Text>
                        </div>
                        <Tag className="m-0 shrink-0 text-[11px]">{t(`assets.kinds.${asset.kind}`)}</Tag>
                    </div>
                    <Typography.Paragraph type="secondary" ellipsis={{ rows: 3 }} className="!mb-0 !mt-2 !text-xs !leading-5">
                        {summary}
                    </Typography.Paragraph>
                    <div className="mt-3 flex flex-wrap gap-1.5">
                        {(asset.tags || []).slice(0, 3).map((tag) => (
                            <Tag key={tag} className="m-0 text-[11px]">
                                {tag}
                            </Tag>
                        ))}
                        {!asset.tags?.length ? <Tag className="m-0 text-[11px]">{t("assets.noTags")}</Tag> : null}
                    </div>
                </div>
            </button>
            <div className="flex items-center gap-2 px-4 pb-4">
                <Button size="small" onClick={onOpen}>
                    {t("common.view")}
                </Button>
                {asset.kind !== "video" ? (
                    <Button size="small" icon={<PencilLine className="size-3.5" />} onClick={onEdit}>
                        {t("common.edit")}
                    </Button>
                ) : null}
                {asset.kind === "text" ? (
                    <Button size="small" icon={<Copy className="size-3.5" />} onClick={() => void onCopy(asset)}>
                        {t("common.copy")}
                    </Button>
                ) : null}
                {asset.kind === "image" || asset.kind === "video" ? (
                    <Button size="small" icon={<Download className="size-3.5" />} onClick={() => onDownload(asset)}>
                        {t("common.download")}
                    </Button>
                ) : null}
                <Button size="small" danger icon={<Trash2 className="size-3.5" />} onClick={onDelete}>
                    {t("common.delete")}
                </Button>
            </div>
        </Card>
    );
}

function AssetDrawer({
    asset,
    assetsById,
    selectedCount,
    onClose,
    onCopy,
    onDownload,
    onOpenAsset,
    onAddSelected,
    onRemoveItem,
    onSetCover,
    onSetSlot,
    onMoveItem,
}: {
    asset: Asset | null;
    assetsById: Map<string, Asset>;
    selectedCount: number;
    onClose: () => void;
    onCopy: (asset: Asset) => void;
    onDownload: (asset: Asset) => void;
    onOpenAsset: (asset: Asset) => void;
    onAddSelected: (bundle: BundleAsset) => void;
    onRemoveItem: (bundle: BundleAsset, assetId: string) => void;
    onSetCover: (bundle: BundleAsset, assetId: string) => void;
    onSetSlot: (bundle: BundleAsset, assetId: string, slot: BundleItem["slot"]) => void;
    onMoveItem: (bundle: BundleAsset, index: number, delta: number) => void;
}) {
    const { t } = useTranslation();
    const cover = asset ? assetCover(asset, assetsById) : "";
    const bundleItems = asset?.kind === "bundle" ? [...asset.data.items].sort((a, b) => a.order - b.order) : [];
    return (
        <Drawer title={t("assets.details")} open={Boolean(asset)} size="large" onClose={onClose}>
            {asset ? (
                <div className="space-y-5">
                    {cover ? (
                        <Image src={cover} alt={asset.title} className="rounded-lg" />
                    ) : (
                        <div className="rounded-lg border border-stone-200 bg-stone-50 p-5 text-sm leading-6 text-stone-600 dark:border-stone-800 dark:bg-stone-900 dark:text-stone-300">{asset.kind === "text" ? asset.data.content : t("assets.noCover")}</div>
                    )}
                    <div>
                        <Typography.Title level={4} className="!mb-2">
                            {asset.title}
                        </Typography.Title>
                        <Space size={[4, 4]} wrap>
                            <Tag>{t(`assets.kinds.${asset.kind}`)}</Tag>
                            {(asset.tags || []).map((tag) => (
                                <Tag key={tag}>{tag}</Tag>
                            ))}
                        </Space>
                    </div>
                    <div className="rounded-lg border border-stone-200 p-4 dark:border-stone-800">
                        <Typography.Text type="secondary" className="block text-xs">
                            {t("assets.fields.textContent")}
                        </Typography.Text>
                        {asset.kind === "text" ? (
                            <Typography.Paragraph className="mt-2 whitespace-pre-wrap">{asset.data.content}</Typography.Paragraph>
                        ) : asset.kind === "video" ? (
                            <video src={asset.data.url} controls className="mt-2 aspect-video w-full rounded-lg bg-black" />
                        ) : asset.kind === "audio" ? (
                            <audio src={asset.data.url} controls className="mt-2 w-full" />
                        ) : asset.kind === "bundle" ? (
                            <Typography.Text className="mt-2 block">
                                {i18n.t("assets.bundleItemCount", { count: asset.data.items.length })}
                            </Typography.Text>
                        ) : (
                            <Typography.Text className="mt-2 block">
                                {asset.data.width}x{asset.data.height} · {formatBytes(asset.data.bytes)} · {asset.data.mimeType}
                            </Typography.Text>
                        )}
                    </div>
                    {asset.kind === "bundle" ? (
                        <div className="rounded-lg border border-stone-200 p-4 dark:border-stone-800">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                                <Typography.Text type="secondary" className="block text-xs">
                                    {t("assets.bundleItems")}
                                </Typography.Text>
                                {selectedCount ? (
                                    <Button size="small" type="primary" onClick={() => onAddSelected(asset)}>
                                        {t("assets.addSelectedToBundle", { count: selectedCount })}
                                    </Button>
                                ) : null}
                            </div>
                            <div className="mt-3 space-y-2">
                                {bundleItems.length ? (
                                    bundleItems.map((item, index) => {
                                        const target = assetsById.get(item.assetId);
                                        const isCover = asset.data.coverAssetId === item.assetId;
                                        return (
                                            <div key={`${item.assetId}-${index}`} className="flex items-center gap-3 rounded-lg border border-stone-200 p-2 dark:border-stone-800">
                                                <div className="size-10 shrink-0 overflow-hidden rounded bg-stone-100 dark:bg-stone-900">
                                                    {target && assetCover(target, assetsById) ? <img src={assetCover(target, assetsById)} alt="" className="size-full object-cover" /> : null}
                                                </div>
                                                <div className="min-w-0 flex-1">
                                                    <div className="truncate text-xs font-medium">{target?.title || t("assets.itemMissing")}</div>
                                                    <div className="mt-1 flex items-center gap-2 text-[11px] text-stone-500 dark:text-stone-400">
                                                        <Select
                                                            size="small"
                                                            className="min-w-[104px]"
                                                            value={item.slot}
                                                            onChange={(value: BundleItem["slot"]) => onSetSlot(asset, item.assetId, value)}
                                                            options={BUNDLE_SLOT_OPTIONS.map((slot) => ({ value: slot, label: i18n.t(`assets.slots.${slot}`) }))}
                                                        />
                                                        <span>{target ? t(`assets.kinds.${target.kind}`) : ""}{isCover ? ` · ${t("assets.setAsCover")}` : ""}</span>
                                                    </div>
                                                </div>
                                                <Space size={2}>
                                                    <Button size="small" type="text" disabled={index === 0} onClick={() => onMoveItem(asset, index, -1)}>
                                                        {t("assets.moveUp")}
                                                    </Button>
                                                    <Button size="small" type="text" disabled={index === bundleItems.length - 1} onClick={() => onMoveItem(asset, index, 1)}>
                                                        {t("assets.moveDown")}
                                                    </Button>
                                                    <Button size="small" type="text" disabled={!target || isCover} onClick={() => onSetCover(asset, item.assetId)}>
                                                        {t("assets.setAsCover")}
                                                    </Button>
                                                    {target ? (
                                                        <Button size="small" type="text" onClick={() => onOpenAsset(target)}>
                                                            {t("assets.preview")}
                                                        </Button>
                                                    ) : null}
                                                    <Button size="small" type="text" danger onClick={() => onRemoveItem(asset, item.assetId)}>
                                                        {t("assets.removeItem")}
                                                    </Button>
                                                </Space>
                                            </div>
                                        );
                                    })
                                ) : (
                                    <Typography.Text type="secondary" className="text-xs">
                                        {t("assets.bundleEmpty")}
                                    </Typography.Text>
                                )}
                            </div>
                        </div>
                    ) : null}
                    {asset.note ? (
                        <div>
                            <Typography.Text type="secondary">{t("assets.fields.note")}</Typography.Text>
                            <Typography.Paragraph className="mt-1">{asset.note}</Typography.Paragraph>
                        </div>
                    ) : null}
                    <Space>
                        {asset.kind === "text" ? (
                            <Button type="primary" icon={<Copy className="size-4" />} onClick={() => onCopy(asset)}>
                                {t("assets.copyText")}
                            </Button>
                        ) : null}
                        {asset.kind === "image" || asset.kind === "video" || asset.kind === "audio" ? (
                            <Button type="primary" icon={<Download className="size-4" />} onClick={() => onDownload(asset)}>
                                {asset.kind === "video" ? t("assets.downloadVideo") : asset.kind === "audio" ? t("assets.downloadAudio") : t("assets.downloadImage")}
                            </Button>
                        ) : null}
                    </Space>
                </div>
            ) : null}
        </Drawer>
    );
}

function assetSummary(asset: Asset) {
    if (asset.kind === "text") return asset.data.content;
    if (asset.kind === "bundle") return i18n.t("assets.bundleItemCount", { count: asset.data.items.length });
    if (asset.kind === "audio") {
        const seconds = asset.data.durationMs ? `${Math.round(asset.data.durationMs / 1000)}s · ` : "";
        return `${seconds}${formatBytes(asset.data.bytes)} · ${asset.data.mimeType}`;
    }
    return `${asset.data.width}x${asset.data.height} · ${formatBytes(asset.data.bytes)} · ${asset.data.mimeType}`;
}

function assetSearchText(asset: Asset, assetsById?: Map<string, Asset>) {
    if (asset.kind === "bundle") {
        // 组合资产要能被"内含资产的标题"搜到。
        const itemTitles = asset.data.items.map((item) => assetsById?.get(item.assetId)?.title || "").join(" ");
        return [asset.title, asset.source || "", asset.note || "", (asset.tags || []).join(" "), itemTitles].join(" ").toLowerCase();
    }
    return [asset.title, asset.source || "", asset.note || "", (asset.tags || []).join(" "), asset.kind === "text" ? asset.data.content : asset.data.mimeType].join(" ").toLowerCase();
}
