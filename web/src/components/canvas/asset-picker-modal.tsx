import { useEffect, useMemo, useState } from "react";
import { Empty, Input, Modal, Pagination, Tag } from "antd";
import { Search } from "lucide-react";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";
import { resolveBundleCover, useAssetStore, type Asset, type BundleAsset, type BundleConnection, type BundleSlot } from "@/stores/use-asset-store";

export type LeafAssetPayload =
    | { kind: "text"; content: string; title: string }
    | { kind: "image"; dataUrl: string; title: string; storageKey?: string }
    | { kind: "video"; url: string; title: string; storageKey?: string; width?: number; height?: number }
    | { kind: "audio"; url: string; title: string; storageKey?: string; durationMs?: number };

export type BundleEntryPayload = { assetId: string; slot: BundleSlot; payload: LeafAssetPayload; position?: { x: number; y: number }; size?: { width: number; height: number } };
export type InsertAssetPayload = LeafAssetPayload | { kind: "bundle"; title: string; entries: BundleEntryPayload[]; connections?: BundleConnection[] };

/** 把单个原子资产转成插入载荷；组合/未知类型返回 null。 */
export function toLeafPayload(asset: Asset): LeafAssetPayload | null {
    if (asset.kind === "text") return { kind: "text", content: asset.data.content, title: asset.title };
    if (asset.kind === "video") return { kind: "video", url: asset.data.url, storageKey: asset.data.storageKey, title: asset.title, width: asset.data.width, height: asset.data.height };
    if (asset.kind === "audio") return { kind: "audio", url: asset.data.url, storageKey: asset.data.storageKey, title: asset.title, durationMs: asset.data.durationMs };
    if (asset.kind === "image") return { kind: "image", dataUrl: asset.data.dataUrl, storageKey: asset.data.storageKey, title: asset.title };
    return null;
}

/** 把组合资产解析成"槽位 + 原子载荷"列表（失效/不支持的条目会被跳过）。 */
export function toBundleEntries(bundle: BundleAsset, assetsById: Map<string, Asset>): BundleEntryPayload[] {
    return [...bundle.data.items]
        .sort((a, b) => a.order - b.order)
        .map((item): BundleEntryPayload | null => {
            const target = assetsById.get(item.assetId);
            const payload = target ? toLeafPayload(target) : null;
            return payload ? { assetId: item.assetId, slot: item.slot, payload, position: item.position, size: item.size } : null;
        })
        .filter((entry): entry is BundleEntryPayload => Boolean(entry));
}

type Props = {
    open: boolean;
    defaultTab?: string;
    onInsert: (payload: InsertAssetPayload) => void;
    onClose: () => void;
};

export function AssetPickerModal({ open, onInsert, onClose }: Props) {
    const { t } = useTranslation();
    return (
        <Modal title={t("canvas.assetPicker.title")} open={open} onCancel={onClose} footer={null} width={860} destroyOnHidden styles={{ body: { padding: "0 24px 24px", minHeight: 480 } }}>
            <MyAssetsTab onInsert={onInsert} />
        </Modal>
    );
}

const PAGE_SIZE = 8;

const kindOptions = ["all", "text", "image", "video", "audio", "bundle"];

function PickerCard({
    title,
    kind,
    cover,
    onClick,
    expandable,
    expanded,
    onToggleExpand,
}: {
    title: string;
    kind: string;
    cover: string;
    onClick: () => void;
    expandable?: boolean;
    expanded?: boolean;
    onToggleExpand?: () => void;
}) {
    const { t } = useTranslation();
    return (
        <div className="relative">
            <button
                type="button"
                className="group relative w-full cursor-pointer overflow-hidden rounded-lg border border-stone-200 bg-white text-left transition hover:border-stone-400 hover:shadow-md dark:border-stone-700 dark:bg-stone-900 dark:hover:border-stone-500"
                onClick={onClick}
            >
                {cover ? (
                    <img src={cover} alt={title} className="aspect-[4/3] w-full object-cover" />
                ) : (
                    <div className="flex aspect-[4/3] items-center justify-center bg-stone-100 p-3 text-center text-xs leading-5 text-stone-500 dark:bg-stone-800 dark:text-stone-400">{title}</div>
                )}
                <div className="p-2.5">
                    <div className="flex items-center justify-between gap-2">
                        <span className="line-clamp-1 text-xs font-medium text-stone-800 dark:text-stone-200">{title}</span>
                        <Tag className="m-0 shrink-0 text-[10px]">{t(`assets.kinds.${kind}`)}</Tag>
                    </div>
                </div>
                <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-stone-950/0 text-sm font-medium text-white opacity-0 transition group-hover:bg-stone-950/55 group-hover:opacity-100">{t("canvas.assetPicker.insert")}</div>
            </button>
            {expandable ? (
                <button
                    type="button"
                    className="absolute right-1.5 top-1.5 rounded bg-white/85 px-1.5 py-0.5 text-[10px] leading-4 text-stone-600 transition hover:bg-white dark:bg-black/60 dark:text-stone-300 dark:hover:bg-black/80"
                    onClick={(event) => {
                        event.stopPropagation();
                        onToggleExpand?.();
                    }}
                >
                    {expanded ? t("assets.collapse") : t("assets.expand")}
                </button>
            ) : null}
        </div>
    );
}

function MyAssetsTab({ onInsert }: { onInsert: (payload: InsertAssetPayload) => void }) {
    const { t } = useTranslation();
    const assets = useAssetStore((state) => state.assets);
    const [keyword, setKeyword] = useState("");
    const [kindFilter, setKindFilter] = useState("all");
    const [page, setPage] = useState(1);

    const filtered = useMemo(() => {
        const query = keyword.trim().toLowerCase();
        return assets
            .filter((a) => a.kind === "text" || a.kind === "image" || a.kind === "video" || a.kind === "audio" || a.kind === "bundle")
            .filter((a) => kindFilter === "all" || a.kind === kindFilter)
            .filter((a) => !query || [a.title, ...(a.tags || [])].join(" ").toLowerCase().includes(query));
    }, [assets, keyword, kindFilter]);

    const visible = useMemo(() => filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE), [filtered, page]);

    useEffect(() => {
        const maxPage = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
        setPage((v) => Math.min(v, maxPage));
    }, [filtered.length]);

    const assetsById = useMemo(() => new Map(assets.map((asset) => [asset.id, asset])), [assets]);
    const [expandedBundleId, setExpandedBundleId] = useState("");

    const handleInsert = (asset: Asset) => {
        if (asset.kind === "bundle") {
            const entries = toBundleEntries(asset, assetsById);
            if (!entries.length) return;
            onInsert({ kind: "bundle", title: asset.title, entries, connections: asset.data.connections });
            return;
        }
        const payload = toLeafPayload(asset);
        if (payload) onInsert(payload);
    };

    const insertBundleItem = (bundle: BundleAsset, assetId: string) => {
        const target = assetsById.get(assetId);
        const payload = target ? toLeafPayload(target) : null;
        if (payload) onInsert(payload);
    };

    return (
        <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-3">
                <Input
                    className="w-56"
                    size="small"
                    prefix={<Search className="size-3.5 text-stone-400" />}
                    placeholder={t("canvas.assetPicker.search")}
                    value={keyword}
                    allowClear
                    onChange={(e) => {
                        setPage(1);
                        setKeyword(e.target.value);
                    }}
                />
                <div className="flex gap-1.5">
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

            {visible.length ? (
                <div className="grid grid-cols-4 gap-3">
                    {visible.map((asset) => (
                        <div key={asset.id} className={asset.kind === "bundle" && expandedBundleId === asset.id ? "col-span-4" : undefined}>
                            <PickerCard
                                title={asset.title}
                                kind={asset.kind}
                                cover={asset.kind === "bundle" ? resolveBundleCover(asset, assets) : asset.coverUrl || (asset.kind === "image" ? asset.data.dataUrl : "")}
                                onClick={() => handleInsert(asset)}
                                expandable={asset.kind === "bundle"}
                                expanded={expandedBundleId === asset.id}
                                onToggleExpand={() => setExpandedBundleId((current) => (current === asset.id ? "" : asset.id))}
                            />
                            {asset.kind === "bundle" && expandedBundleId === asset.id ? (
                                <div className="mt-2 space-y-1.5 rounded-lg border border-stone-200 p-2 dark:border-stone-800">
                                    {toBundleEntries(asset, assetsById).map((entry, index) => (
                                        <button
                                            key={`${asset.id}-${index}`}
                                            type="button"
                                            className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs hover:bg-black/5 dark:hover:bg-white/10"
                                            onClick={() => insertBundleItem(asset, entry.assetId)}
                                        >
                                            <span className="shrink-0 rounded bg-stone-100 px-1.5 py-0.5 text-[10px] text-stone-500 dark:bg-stone-800 dark:text-stone-400">{t(`assets.slots.${entry.slot}`)}</span>
                                            <span className="min-w-0 flex-1 truncate">{entry.payload.title}</span>
                                            <span className="shrink-0 text-[10px] opacity-60">{t(`assets.kinds.${entry.payload.kind}`)}</span>
                                        </button>
                                    ))}
                                </div>
                            ) : null}
                        </div>
                    ))}
                </div>
            ) : (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("canvas.assetPicker.empty")} className="py-12" />
            )}

            {filtered.length > PAGE_SIZE && (
                <div className="flex justify-center">
                    <Pagination size="small" current={page} pageSize={PAGE_SIZE} total={filtered.length} onChange={setPage} showSizeChanger={false} />
                </div>
            )}
        </div>
    );
}
