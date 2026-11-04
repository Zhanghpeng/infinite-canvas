import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { App, Empty, Input, Spin, Tooltip } from "antd";
import { ArrowUpToLine, ChevronDown, Copy, RotateCcw, Search, Star } from "lucide-react";
import { useTranslation } from "react-i18next";

import type { CanvasTheme } from "@/lib/canvas-theme";
import { pushRecentKey, readFavoriteKeys, readRecentKeys, writeFavoriteKeys } from "@/lib/canvas/system-library/memory";
import { collectFacetValues, countFacetValues, filterLibraryItems, tokenize } from "@/lib/canvas/system-library/query";
import { getSystemLibraryTotal, loadSystemLibrary, SYSTEM_LIBRARY_FACETS } from "@/lib/canvas/system-library/sources";
import type { FacetSelection, LibraryItem, SystemLibraryId } from "@/lib/canvas/system-library/types";
import { cn } from "@/lib/utils";

import type { InsertAssetPayload } from "./asset-picker-modal";

const LIBRARY_ORDER: SystemLibraryId[] = ["costume", "pose", "portrait", "anime"];

/** 各库卡片的固有比例，避免图片加载完才撑开导致网格跳动。 */
const LIBRARY_ASPECT: Record<SystemLibraryId, number> = {
    costume: 2 / 3,
    pose: 3 / 4,
    portrait: 4 / 5,
    anime: 3 / 4,
};

const PAGE_SIZE = 48;

type Scope = "all" | "favorite" | "recent";
type CostumeStyle = "real" | "anime";

export function SystemLibraryPanel({
    theme,
    onInsert,
    selectedNodeId,
    initialLibrary = "costume",
}: {
    theme: CanvasTheme;
    onInsert: (payload: InsertAssetPayload) => void;
    selectedNodeId: string | null;
    initialLibrary?: SystemLibraryId;
}) {
    const { t } = useTranslation();
    const { message } = App.useApp();

    const [libraryId, setLibraryId] = useState<SystemLibraryId>(initialLibrary);
    const [items, setItems] = useState<LibraryItem[]>([]);
    const [loading, setLoading] = useState(true);
    const [failed, setFailed] = useState(false);
    const [reloadToken, setReloadToken] = useState(0);

    const [query, setQuery] = useState("");
    const deferredQuery = useDeferredValue(query);
    const [selection, setSelection] = useState<FacetSelection>({});
    const [openGroup, setOpenGroup] = useState<string | null>(null);
    const [scope, setScope] = useState<Scope>("all");
    const [costumeStyle, setCostumeStyle] = useState<CostumeStyle>("real");
    const [depthMode, setDepthMode] = useState(false);
    /** 姿势库的敏感内容（双人互动）：默认隐藏，和资产弹窗的开关同一语义。 */
    const [includeSensitive, setIncludeSensitive] = useState(false);
    const [limit, setLimit] = useState(PAGE_SIZE);

    const [favorites, setFavorites] = useState<string[]>(() => readFavoriteKeys());
    const [recents, setRecents] = useState<string[]>(() => readRecentKeys());

    useEffect(() => {
        let alive = true;
        setLoading(true);
        setFailed(false);
        setItems([]);
        loadSystemLibrary(libraryId)
            .then((source) => {
                if (!alive) return;
                setItems(source.items);
                setLoading(false);
            })
            .catch(() => {
                if (!alive) return;
                setFailed(true);
                setLoading(false);
            });
        return () => {
            alive = false;
        };
    }, [libraryId, reloadToken]);

    // 换库时清空筛选与分页，但保留搜索词——用户常常想"同一句话换个库再看看"。
    useEffect(() => {
        setSelection({});
        setOpenGroup(null);
        setLimit(PAGE_SIZE);
        setScope("all");
        // 敏感内容不跨库记忆：切走再回来默认回到隐藏状态。
        setIncludeSensitive(false);
    }, [libraryId]);

    useEffect(() => {
        setLimit(PAGE_SIZE);
    }, [deferredQuery, selection, scope, includeSensitive]);

    const facetGroups = SYSTEM_LIBRARY_FACETS[libraryId];

    const tokens = useMemo(() => tokenize(deferredQuery), [deferredQuery]);

    /**
     * 敏感内容在进入筛选与分面统计之前就被拦掉：否则「双人纠缠」这类分面 chip
     * 会挂着 0 计数留在界面上，看起来像坏了。
     */
    const gatedItems = useMemo(
        () => (includeSensitive ? items : items.filter((item) => !item.nsfw)),
        [items, includeSensitive],
    );

    const facetValues = useMemo(() => {
        const map: Record<string, string[]> = {};
        for (const group of facetGroups) map[group.key] = collectFacetValues(gatedItems, group.key);
        return map;
    }, [gatedItems, facetGroups]);

    const scopedItems = useMemo(() => {
        if (scope === "favorite") {
            const set = new Set(favorites);
            return gatedItems.filter((item) => set.has(item.key));
        }
        if (scope === "recent") {
            const order = new Map(recents.map((key, index) => [key, index]));
            return gatedItems
                .filter((item) => order.has(item.key))
                .sort((a, b) => (order.get(a.key) ?? 0) - (order.get(b.key) ?? 0));
        }
        return gatedItems;
    }, [gatedItems, scope, favorites, recents]);

    const filtered = useMemo(() => filterLibraryItems(scopedItems, tokens, selection), [scopedItems, tokens, selection]);

    const facetCounts = useMemo(() => {
        const map: Record<string, Map<string, number>> = {};
        if (loading) return map;
        for (const group of facetGroups) {
            map[group.key] = countFacetValues(scopedItems, tokens, selection, group.key);
        }
        return map;
    }, [facetGroups, loading, scopedItems, tokens, selection]);

    const visible = useMemo(() => filtered.slice(0, limit), [filtered, limit]);

    const scrollRef = useRef<HTMLDivElement>(null);
    const sentinelRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const sentinel = sentinelRef.current;
        if (!sentinel) return;
        const observer = new IntersectionObserver(
            (entries) => {
                if (entries.some((entry) => entry.isIntersecting)) {
                    setLimit((current) => (current >= filtered.length ? current : current + PAGE_SIZE));
                }
            },
            { root: scrollRef.current, rootMargin: "240px" },
        );
        observer.observe(sentinel);
        return () => observer.disconnect();
    }, [filtered.length]);

    const toggleFacet = useCallback((group: string, value: string) => {
        setSelection((current) => {
            const existing = current[group] ?? [];
            const next = existing.includes(value) ? existing.filter((item) => item !== value) : [...existing, value];
            return { ...current, [group]: next };
        });
    }, []);

    const toggleFavorite = useCallback((key: string) => {
        setFavorites((current) => {
            const next = current.includes(key) ? current.filter((item) => item !== key) : [key, ...current];
            writeFavoriteKeys(next);
            return next;
        });
    }, []);

    const handleInsert = useCallback(
        (item: LibraryItem, image: string, title: string, asReference: boolean) => {
            if (asReference && !selectedNodeId) return;
            const payload: InsertAssetPayload = {
                kind: "image",
                dataUrl: image,
                title,
                ...(asReference && selectedNodeId ? { asReferenceTo: selectedNodeId } : {}),
            };
            onInsert(payload);
            setRecents(pushRecentKey(item.key));
        },
        [onInsert, selectedNodeId],
    );

    const handleCopyTerms = useCallback(
        async (item: LibraryItem) => {
            if (!item.terms) return;
            try {
                await navigator.clipboard.writeText(item.terms);
                message.success(t("canvas.systemLibrary.copied"));
            } catch {
                message.error(t("canvas.systemLibrary.copyFailed"));
            }
        },
        [message, t],
    );

    const activeChips = useMemo(
        () => facetGroups.flatMap((group) => (selection[group.key] ?? []).map((value) => ({ group, value }))),
        [facetGroups, selection],
    );

    const aspect = LIBRARY_ASPECT[libraryId];
    const showStyleSwitch = libraryId === "costume" && items.some((item) => Boolean(item.altThumb));
    const showDepthSwitch = libraryId === "pose";
    const showSensitiveSwitch = libraryId === "pose" && items.some((item) => item.nsfw);

    return (
        <div className="flex h-full flex-col">
            <div className="px-3 pb-2">
                <div className="thin-scrollbar -mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1">
                    {LIBRARY_ORDER.map((id) => {
                        const active = id === libraryId;
                        return (
                            <button
                                key={id}
                                type="button"
                                onClick={() => setLibraryId(id)}
                                className={cn(
                                    "flex shrink-0 items-baseline gap-1 rounded-full border px-2.5 py-1 text-[11px] font-medium transition",
                                    active ? "border-transparent" : "opacity-60 hover:opacity-100",
                                )}
                                style={{
                                    borderColor: active ? "transparent" : theme.node.stroke,
                                    background: active ? theme.toolbar.activeBg : "transparent",
                                    color: active ? theme.toolbar.activeText : theme.node.text,
                                }}
                            >
                                {t(`canvas.systemLibrary.libraries.${id}`)}
                                {active ? (
                                    <span className="text-[10px] opacity-60">
                                        {gatedItems.length || getSystemLibraryTotal(id, { includeSensitive })}
                                    </span>
                                ) : null}
                            </button>
                        );
                    })}
                </div>
            </div>

            <div className="px-3 pb-2">
                <Input
                    size="small"
                    allowClear
                    prefix={<Search className="size-3.5 text-stone-400" />}
                    placeholder={t("canvas.systemLibrary.search")}
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                />
            </div>

            {(showStyleSwitch || showDepthSwitch || showSensitiveSwitch) && (
                <div className="flex flex-wrap gap-1 px-3 pb-2">
                    {showStyleSwitch ? (
                        <>
                            <MiniChip active={costumeStyle === "real"} theme={theme} onClick={() => setCostumeStyle("real")}>
                                {t("canvas.systemLibrary.styleReal")}
                            </MiniChip>
                            <MiniChip active={costumeStyle === "anime"} theme={theme} onClick={() => setCostumeStyle("anime")}>
                                {t("canvas.systemLibrary.styleAnime")}
                            </MiniChip>
                        </>
                    ) : null}
                    {showDepthSwitch ? (
                        <MiniChip active={depthMode} theme={theme} onClick={() => setDepthMode((value) => !value)}>
                            {t("canvas.systemLibrary.depth")}
                        </MiniChip>
                    ) : null}
                    {showSensitiveSwitch ? (
                        <MiniChip
                            active={includeSensitive}
                            theme={theme}
                            onClick={() => setIncludeSensitive((value) => !value)}
                        >
                            {t("canvas.systemLibrary.sensitive")}
                        </MiniChip>
                    ) : null}
                </div>
            )}

            {activeChips.length ? (
                <div className="flex flex-wrap items-center gap-1 px-3 pb-2">
                    {activeChips.map(({ group, value }) => (
                        <button
                            key={`${group.key}:${value}`}
                            type="button"
                            onClick={() => toggleFacet(group.key, value)}
                            className="flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] text-amber-800 transition hover:bg-amber-200 dark:bg-amber-500/20 dark:text-amber-200"
                        >
                            {value}
                            <span className="opacity-60">×</span>
                        </button>
                    ))}
                    <button
                        type="button"
                        onClick={() => setSelection({})}
                        className="px-1 text-[10px] opacity-45 transition hover:opacity-80"
                    >
                        {t("canvas.systemLibrary.clear")}
                    </button>
                </div>
            ) : null}

            <div className="min-h-0 flex-1 overflow-y-auto" ref={scrollRef}>
                {!loading && !failed && items.length ? (
                    <div className="px-3 pb-1.5">
                        {/* 侧栏窄，分面默认全部收起：只留一行组名，点开一组才铺取值，
                            否则六组 chip 会把首屏卡片全挤到折叠线以下。 */}
                        <div className="flex flex-wrap gap-1">
                            {facetGroups.map((group) => {
                                const chosen = selection[group.key]?.length ?? 0;
                                const open = openGroup === group.key;
                                if (!(facetValues[group.key] ?? []).length) return null;
                                return (
                                    <button
                                        key={group.key}
                                        type="button"
                                        onClick={() => setOpenGroup(open ? null : group.key)}
                                        className={cn(
                                            "flex items-center gap-0.5 rounded-full border px-2 py-0.5 text-[10px] font-medium transition",
                                            open ? "border-transparent" : "opacity-65 hover:opacity-100",
                                        )}
                                        style={{
                                            borderColor: open ? "transparent" : theme.node.stroke,
                                            background: open ? theme.toolbar.activeBg : chosen ? "rgba(251,191,36,0.16)" : "transparent",
                                            color: open ? theme.toolbar.activeText : theme.node.text,
                                        }}
                                    >
                                        {t(`canvas.systemLibrary.facet.${group.labelKey}`)}
                                        {chosen ? <span className="opacity-70">·{chosen}</span> : null}
                                        <ChevronDown className={cn("size-2.5 transition", open ? "rotate-180" : "")} />
                                    </button>
                                );
                            })}
                        </div>

                        {openGroup ? (
                            <div className="flex flex-wrap gap-1 pt-1.5">
                                {(facetValues[openGroup] ?? []).map((value) => {
                                    const active = Boolean(selection[openGroup]?.includes(value));
                                    const count = facetCounts[openGroup]?.get(value) ?? 0;
                                    const disabled = !active && count === 0;
                                    return (
                                        <button
                                            key={value}
                                            type="button"
                                            disabled={disabled}
                                            onClick={() => toggleFacet(openGroup, value)}
                                            className={cn(
                                                "rounded-full border px-1.5 py-0.5 text-[10px] leading-4 transition",
                                                active
                                                    ? "border-transparent bg-stone-900 text-white dark:bg-stone-100 dark:text-stone-900"
                                                    : disabled
                                                      ? "cursor-not-allowed opacity-30"
                                                      : "opacity-75 hover:opacity-100",
                                            )}
                                            style={active ? undefined : { borderColor: theme.node.stroke, color: theme.node.text }}
                                        >
                                            {value}
                                            <span className="ml-0.5 opacity-50">{count}</span>
                                        </button>
                                    );
                                })}
                            </div>
                        ) : null}
                    </div>
                ) : null}

                <div className="flex items-center gap-2 px-3 pb-1.5 pt-1 text-[10px] opacity-55">
                    <span>{t("canvas.systemLibrary.count", { count: filtered.length })}</span>
                    <div className="ml-auto flex items-center gap-1">
                        <ScopeChip active={scope === "all"} onClick={() => setScope("all")}>
                            {t("canvas.systemLibrary.scopeAll")}
                        </ScopeChip>
                        <ScopeChip active={scope === "favorite"} onClick={() => setScope("favorite")}>
                            ★ {favorites.length}
                        </ScopeChip>
                        <ScopeChip active={scope === "recent"} onClick={() => setScope("recent")}>
                            {t("canvas.systemLibrary.scopeRecent")}
                        </ScopeChip>
                    </div>
                </div>

                {loading ? (
                    <div className="grid gap-2 px-3 pb-3 pt-1" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(100px, 1fr))" }}>
                        {Array.from({ length: 6 }).map((_, index) => (
                            <div key={index} className="animate-pulse rounded-xl bg-black/5 dark:bg-white/5" style={{ aspectRatio: String(aspect) }} />
                        ))}
                    </div>
                ) : failed ? (
                    <div className="flex flex-col items-center gap-2 pt-16 text-xs opacity-60">
                        <span>{t("canvas.systemLibrary.loadFailed")}</span>
                        <button
                            type="button"
                            onClick={() => setReloadToken((value) => value + 1)}
                            className="flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] transition hover:opacity-80"
                            style={{ borderColor: theme.node.stroke }}
                        >
                            <RotateCcw className="size-3" />
                            {t("canvas.systemLibrary.retry")}
                        </button>
                    </div>
                ) : visible.length ? (
                    <div className="grid gap-2 px-3 pb-3 pt-1" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(100px, 1fr))" }}>
                        {visible.map((item) => (
                            <LibraryCard
                                key={item.key}
                                item={item}
                                aspect={aspect}
                                theme={theme}
                                style={costumeStyle}
                                depthMode={depthMode}
                                favorite={favorites.includes(item.key)}
                                canReference={Boolean(selectedNodeId)}
                                onInsert={handleInsert}
                                onCopyTerms={handleCopyTerms}
                                onToggleFavorite={toggleFavorite}
                                onTagClick={(tag) => setQuery((current) => (current.includes(tag) ? current : `${current} ${tag}`.trim()))}
                            />
                        ))}
                    </div>
                ) : (
                    <Empty
                        image={Empty.PRESENTED_IMAGE_SIMPLE}
                        description={t(scope === "favorite" ? "canvas.systemLibrary.emptyFavorite" : scope === "recent" ? "canvas.systemLibrary.emptyRecent" : "canvas.systemLibrary.empty")}
                        className="pt-14"
                    />
                )}
                <div ref={sentinelRef} className="h-2" />
                {loading ? (
                    <div className="flex justify-center pb-4 pt-1">
                        <Spin size="small" />
                    </div>
                ) : null}
            </div>
        </div>
    );
}

function MiniChip({ active, theme, onClick, children }: { active: boolean; theme: CanvasTheme; onClick: () => void; children: React.ReactNode }) {
    return (
        <button
            type="button"
            onClick={onClick}
            className={cn("rounded-full border px-2 py-0.5 text-[10px] font-medium transition", active ? "border-transparent" : "opacity-60 hover:opacity-100")}
            style={{
                borderColor: active ? "transparent" : theme.node.stroke,
                background: active ? theme.toolbar.activeBg : "transparent",
                color: active ? theme.toolbar.activeText : theme.node.text,
            }}
        >
            {children}
        </button>
    );
}

function ScopeChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
    return (
        <button
            type="button"
            onClick={onClick}
            className={cn("rounded-full px-1.5 py-0.5 text-[10px] leading-4 transition", active ? "bg-black/10 font-medium dark:bg-white/15" : "opacity-55 hover:opacity-90")}
        >
            {children}
        </button>
    );
}

function LibraryCard({
    item,
    aspect,
    theme,
    style,
    depthMode,
    favorite,
    canReference,
    onInsert,
    onCopyTerms,
    onToggleFavorite,
    onTagClick,
}: {
    item: LibraryItem;
    aspect: number;
    theme: CanvasTheme;
    style: CostumeStyle;
    depthMode: boolean;
    favorite: boolean;
    canReference: boolean;
    onInsert: (item: LibraryItem, image: string, title: string, asReference: boolean) => void;
    onCopyTerms: (item: LibraryItem) => void;
    onToggleFavorite: (key: string) => void;
    onTagClick: (tag: string) => void;
}) {
    const { t } = useTranslation();
    const [variantIndex, setVariantIndex] = useState(0);
    const [hovering, setHovering] = useState(false);

    const variant = item.variants[variantIndex];
    const useAnime = style === "anime" && Boolean(item.altThumb);
    const baseThumb = variant ? variant.thumb : item.thumb;
    const baseImage = variant ? variant.image : item.image;
    const thumb = useAnime ? (item.altThumb as string) : depthMode && variant?.altThumb ? variant.altThumb : baseThumb;
    const image = useAnime ? (item.altImage ?? item.altThumb ?? baseImage) : depthMode && variant?.altImage ? variant.altImage : baseImage;
    // 悬停放大跟着当前变体走：用库级 preview 会在换了机位/发色后跳回第一张，看起来像图错乱。
    const preview = hovering && image && image !== thumb ? image : thumb;
    // 服装的「动漫画风」挂在第三方镜像上，有几十个 id 整组缺图（CDN 对缺图回 200 + 首页 HTML）。
    // 落回写实缩略图，至少还能认出是哪一套，不至于整张卡片空白。
    const [brokenSrc, setBrokenSrc] = useState<string[]>([]);
    const thumbFallback = item.thumb && item.thumb !== preview ? item.thumb : undefined;
    const shownSrc = brokenSrc.includes(preview) ? thumbFallback : preview;

    const title = variant && item.variants.length > 1 ? `${item.title}（${variant.label}）` : item.title;

    const payload: InsertAssetPayload = { kind: "image", dataUrl: image, title };

    const handleDragStart = (event: React.DragEvent) => {
        event.dataTransfer.setData("application/infinite-canvas-asset", JSON.stringify(payload));
        event.dataTransfer.effectAllowed = "copy";
    };

    return (
        <div
            draggable
            onDragStart={handleDragStart}
            onMouseEnter={() => setHovering(true)}
            onMouseLeave={() => setHovering(false)}
            onClick={() => onInsert(item, image, title, false)}
            className="group relative flex cursor-grab flex-col overflow-hidden rounded-xl border transition duration-200 hover:-translate-y-0.5 hover:shadow-md active:cursor-grabbing"
            style={{ borderColor: theme.node.stroke, background: theme.node.panel, color: theme.node.text }}
            title={t("canvas.sidePanel.dragOrClickToInsert")}
        >
            <div className="relative w-full flex-1 overflow-hidden bg-black/5 dark:bg-white/5" style={{ aspectRatio: String(aspect) }}>
                <img
                    src={shownSrc}
                    alt={title}
                    loading="lazy"
                    className="size-full object-contain p-1 transition duration-200 group-hover:scale-[1.03]"
                    onError={() => setBrokenSrc((current) => (current.includes(preview) ? current : [...current, preview]))}
                />
                {/* 收藏/复制/连参考图常显半透明：只在 hover 才出现的话，触屏和没试过悬停的用户根本发现不了这三个出口。 */}
                <div
                    className="absolute right-1 top-1 flex flex-col gap-1 opacity-45 transition group-hover:opacity-100"
                    onClick={(event) => event.stopPropagation()}
                >
                    <CardAction
                        label={favorite ? t("canvas.systemLibrary.unfavorite") : t("canvas.systemLibrary.favorite")}
                        active={favorite}
                        onClick={() => onToggleFavorite(item.key)}
                    >
                        <Star className={cn("size-3", favorite && "fill-current")} />
                    </CardAction>
                    {item.terms ? (
                        <CardAction label={t("canvas.systemLibrary.copyTerms")} onClick={() => void onCopyTerms(item)}>
                            <Copy className="size-3" />
                        </CardAction>
                    ) : null}
                    <CardAction
                        label={canReference ? t("canvas.systemLibrary.insertReference") : t("canvas.systemLibrary.noReferenceTarget")}
                        disabled={!canReference}
                        onClick={() => onInsert(item, image, title, true)}
                    >
                        <ArrowUpToLine className="size-3" />
                    </CardAction>
                </div>
            </div>

            <div className="flex flex-col gap-1 p-1.5">
                <div>
                    <div className="line-clamp-1 text-[11px] font-medium" style={{ color: theme.node.text }}>
                        {item.title}
                    </div>
                    <div className="line-clamp-1 text-[10px] opacity-45">{item.meta}</div>
                </div>

                {item.variants.length > 1 ? (
                    <div className="flex flex-wrap items-center gap-0.5" onClick={(event) => event.stopPropagation()}>
                        {item.variants.map((entry, index) => {
                            const active = index === variantIndex;
                            if (entry.swatch) {
                                return (
                                    <Tooltip key={entry.key} title={entry.label}>
                                        <button
                                            type="button"
                                            onClick={() => setVariantIndex(index)}
                                            className={cn(
                                                "size-3.5 rounded-full border transition",
                                                active ? "scale-110 border-stone-900 shadow-sm dark:border-stone-100" : "border-black/15 opacity-70 hover:opacity-100",
                                            )}
                                            style={{ background: entry.swatch }}
                                            aria-label={entry.label}
                                        />
                                    </Tooltip>
                                );
                            }
                            return (
                                <Tooltip key={entry.key} title={entry.label}>
                                    <button
                                        type="button"
                                        onClick={() => setVariantIndex(index)}
                                        className={cn(
                                            // 侧栏卡片只有 90 多像素宽，五个机位单字要挤在一行：靠 px 收窄而不是换行。
                                            "rounded px-[3px] py-0.5 text-[10px] font-medium transition",
                                            active
                                                ? "bg-stone-900 text-white dark:bg-stone-100 dark:text-stone-900"
                                                : "bg-black/5 opacity-70 hover:opacity-100 dark:bg-white/10",
                                        )}
                                    >
                                        {entry.short ?? entry.label}
                                    </button>
                                </Tooltip>
                            );
                        })}
                    </div>
                ) : item.tags.length ? (
                    <div className="flex flex-wrap gap-0.5" onClick={(event) => event.stopPropagation()}>
                        {item.tags.slice(0, 2).map((tag) => (
                            <button
                                key={tag}
                                type="button"
                                onClick={() => onTagClick(tag)}
                                className="rounded bg-black/5 px-1 py-0.5 text-[10px] opacity-70 transition hover:opacity-100 dark:bg-white/10"
                            >
                                {tag}
                            </button>
                        ))}
                    </div>
                ) : null}
            </div>
        </div>
    );
}

function CardAction({
    label,
    onClick,
    disabled,
    active,
    children,
}: {
    label: string;
    onClick: () => void;
    disabled?: boolean;
    active?: boolean;
    children: React.ReactNode;
}) {
    return (
        <Tooltip title={label}>
            <button
                type="button"
                disabled={disabled}
                onClick={(event) => {
                    event.stopPropagation();
                    onClick();
                }}
                className={cn(
                    "grid size-5 place-items-center rounded-full border shadow-sm backdrop-blur transition",
                    disabled ? "cursor-not-allowed opacity-40" : "hover:scale-105",
                    active ? "border-transparent bg-amber-400 text-amber-900" : "bg-white/90 text-stone-700 dark:bg-black/70 dark:text-stone-100",
                )}
                style={active ? undefined : { borderColor: "rgba(0,0,0,0.08)" }}
                aria-label={label}
            >
                {children}
            </button>
        </Tooltip>
    );
}
