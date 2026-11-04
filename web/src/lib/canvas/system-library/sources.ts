import { ALL_POSES, POSE_ANGLE_LABELS, POSE_SERIES_LIST, SAFE_POSE_COUNT, getPoseImageUrl, getPoseThumbUrl } from "@/lib/canvas/pose-presets";

import { readCache, writeCache } from "./cache";
import { COSTUME_FACET_GROUP_BY_KEYWORD } from "./facet-map";
import type { FacetGroup, LibraryItem, LibraryVariant, SystemLibraryId, SystemLibrarySource } from "./types";

/**
 * 上游索引与图片的取址。
 *
 * 索引统一走 GitHub Pages（带 `access-control-allow-origin: *`，可直接 fetch）；
 * 图片走作者自建的 Cloudflare Pages 镜像——写实服饰的原图 PNG 不在 Pages 目录里，
 * 所以写实服饰一律用 `img/` 预览图（webp 40~90KB），够做参考图又不至于拖慢插入。
 */
const INDEX_BASE = "https://deeyu.github.io/ai-costume-gallery-zh";

const CDN = {
    costume: "https://ai-costume-gallery.pages.dev",
    costumeAnime: "https://ai-costume-anime-gallery.pages.dev",
    portrait: "https://ai-portrait-gallery.pages.dev",
    anime: "https://charadb-2fi.pages.dev",
    depth: "https://ai-pose-depth-gallery.pages.dev",
};

export const SYSTEM_LIBRARY_FACETS: Record<SystemLibraryId, FacetGroup[]> = {
    costume: [
        { key: "season", labelKey: "season" },
        { key: "outfit", labelKey: "outfit" },
        { key: "color", labelKey: "color" },
        { key: "material", labelKey: "material" },
        { key: "cut", labelKey: "cut" },
        { key: "accessory", labelKey: "accessory" },
    ],
    portrait: [
        { key: "face", labelKey: "face" },
        { key: "length", labelKey: "length" },
    ],
    anime: [
        { key: "kind", labelKey: "kind" },
        { key: "category", labelKey: "category" },
    ],
    pose: [
        { key: "series", labelKey: "series" },
        { key: "category", labelKey: "category" },
    ],
};

/** 图库切换按钮上的静态总量，避免为了显示数字把四份索引全拉下来。 */
export const SYSTEM_LIBRARY_TOTALS: Record<SystemLibraryId, number> = {
    costume: 1407,
    portrait: 1499,
    anime: 843,
    pose: 0,
};

/** 姿势库总量来自本地数据，不进上面的常量表。敏感内容默认不算在内。 */
export function getSystemLibraryTotal(id: SystemLibraryId, options?: { includeSensitive?: boolean }): number {
    if (id !== "pose") return SYSTEM_LIBRARY_TOTALS[id];
    return options?.includeSensitive ? ALL_POSES.length : SAFE_POSE_COUNT;
}

// ---------------------------------------------------------------------------
// 上游原始结构（字段用中文，和索引一致）
// ---------------------------------------------------------------------------

type RawCostumeRow = {
    id: string;
    分类: string;
    关键词: string[];
    英文关键词: string;
    缩略图: string;
    预览图: string;
    原图: string;
    检索: string;
};

type RawPortraitRow = {
    id: string;
    类型: string;
    发长: string;
    发型: string;
    缩略图: string;
    原图: string;
    检索: string;
};

type RawAnimeRow = {
    id: string;
    类型: string;
    分类: string;
    名称: string;
    标签: string;
    子类型: string;
    父级: string;
    发色: string;
    线稿: string;
    缩略图: string;
    原图: string;
    检索: string;
};

const ANIME_COLOR_LABELS: Record<string, string> = {
    brown: "棕发",
    black: "黑发",
    blonde: "金发",
    pink: "粉发",
    silver: "银发",
};

const ANIME_COLOR_SWATCH: Record<string, string> = {
    brown: "#8b6b4a",
    black: "#2c2c2a",
    blonde: "#e3c37a",
    pink: "#ed93b1",
    silver: "#c3c7cc",
};

// ---------------------------------------------------------------------------
// 取数与归一化
// ---------------------------------------------------------------------------

async function fetchJson<T>(url: string): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) throw new Error(`${response.status} ${url}`);
        return (await response.json()) as T;
    } finally {
        clearTimeout(timer);
    }
}

function toCostumeItem(row: RawCostumeRow, alt?: RawCostumeRow): LibraryItem {
    const tags = Array.isArray(row.关键词) ? row.关键词 : [];
    const facets: Record<string, string[]> = { season: [row.分类] };
    for (const tag of tags) {
        const group = COSTUME_FACET_GROUP_BY_KEYWORD[tag];
        if (!group) continue;
        const bucket = facets[group];
        if (bucket) bucket.push(tag);
        else facets[group] = [tag];
    }
    // 标题优先"品类 + 颜色"（半身裙 · 黑色），比按原顺序取前三个词更能认出是哪一套。
    const outfits = facets.outfit ?? [];
    const colors = facets.color ?? [];
    const materials = facets.material ?? [];
    const title =
        [...outfits.slice(0, 2), ...colors.slice(0, 1), ...materials.slice(0, 1)].slice(0, 3).join(" · ") ||
        tags.slice(0, 3).join(" · ") ||
        row.id;
    const thumb = `${CDN.costume}/thumbs/${row.id}.webp`;
    const preview = `${CDN.costume}/img/${row.id}.webp`;
    return {
        key: `costume:${row.id}`,
        library: "costume",
        id: row.id,
        title,
        meta: `${row.分类} · ${row.id}`,
        tags,
        terms: row.英文关键词 || "",
        thumb,
        preview,
        image: preview,
        variants: [],
        facets,
        search: (row.检索 || `${row.id} ${row.分类} ${tags.join(" ")} ${row.英文关键词}`).toLowerCase(),
        altThumb: alt ? `${CDN.costumeAnime}/thumbs/${alt.id}.webp` : undefined,
        altPreview: alt ? `${CDN.costumeAnime}/img/${alt.id}.webp` : undefined,
        altImage: alt ? `${CDN.costumeAnime}/img/${alt.id}.webp` : undefined,
    };
}

async function loadCostume(): Promise<LibraryItem[]> {
    const [real, anime] = await Promise.all([
        fetchJson<RawCostumeRow[]>(`${INDEX_BASE}/data/costume-zh.json`),
        // 画风切换是加分项，拿不到就只保留写实版，不阻塞整个图库。
        fetchJson<RawCostumeRow[]>(`${INDEX_BASE}/costume-anime/data/costume-zh.json`).catch(() => [] as RawCostumeRow[]),
    ]);
    const animeById = new Map(anime.map((row) => [row.id, row]));
    return real.map((row) => toCostumeItem(row, animeById.get(row.id)));
}

async function loadPortrait(): Promise<LibraryItem[]> {
    const rows = await fetchJson<RawPortraitRow[]>(`${INDEX_BASE}/portrait/data/portrait-zh.json`);
    return rows.map((row) => ({
        key: `portrait:${row.id}`,
        library: "portrait",
        id: row.id,
        title: row.发型 || `${row.发长} · ${row.类型}`,
        meta: `${row.类型} · ${row.发长}`,
        tags: [row.发长, row.发型].filter((text): text is string => Boolean(text)),
        terms: "",
        thumb: row.缩略图,
        // 脸型只有 400×500 缩略图和 1122×1402 原图两档，悬停放大不做二次请求。
        preview: row.缩略图,
        image: row.原图,
        variants: [],
        facets: { face: [row.类型], length: row.发长 ? [row.发长] : [] },
        search: (row.检索 || `${row.id} ${row.类型} ${row.发长} ${row.发型}`).toLowerCase(),
    }));
}

async function loadAnime(): Promise<LibraryItem[]> {
    const rows = await fetchJson<RawAnimeRow[]>(`${INDEX_BASE}/anime/data/anime-zh.json`);
    // 发色变体（H001-black / -blonde …）挂在父级下做色点，不单独占卡片。
    const childrenByParent = new Map<string, RawAnimeRow[]>();
    for (const row of rows) {
        const parent = row.父级;
        if (!parent) continue;
        const list = childrenByParent.get(parent);
        if (list) list.push(row);
        else childrenByParent.set(parent, [row]);
    }
    const toVariant = (row: RawAnimeRow, label: string): LibraryVariant => ({
        key: row.id,
        label,
        short: row.发色 ? label.replace("发", "") : undefined,
        swatch: row.发色 ? ANIME_COLOR_SWATCH[row.发色] : undefined,
        thumb: row.缩略图,
        image: row.原图,
    });

    return rows
        .filter((row) => !row.父级)
        .map((row) => {
            const variants: LibraryVariant[] = [];
            const children = childrenByParent.get(row.id);
            if (children?.length) {
                variants.push(toVariant(row, ANIME_COLOR_LABELS[row.发色] || "原色"));
                for (const child of children) {
                    variants.push(toVariant(child, ANIME_COLOR_LABELS[child.发色] || child.名称));
                }
            } else if (row.线稿) {
                variants.push(toVariant(row, "彩图"));
                variants.push({ key: `${row.id}-line`, label: "线稿", thumb: row.线稿, image: row.线稿 });
            }
            return {
                key: `anime:${row.id}`,
                library: "anime" as const,
                id: row.id,
                title: row.名称 || row.id,
                meta: `${row.类型} · ${row.分类}`,
                tags: [row.分类, row.标签].filter((text): text is string => Boolean(text)),
                terms: row.标签 || "",
                thumb: row.缩略图,
                preview: row.原图,
                image: row.原图,
                variants,
                facets: { kind: [row.类型], category: row.分类 ? [row.分类] : [] },
                search: (row.检索 || `${row.id} ${row.名称} ${row.分类} ${row.标签}`).toLowerCase(),
            };
        });
}

function loadPose(): LibraryItem[] {
    const seriesName = new Map(POSE_SERIES_LIST.map((series) => [series.id, series.name]));
    return ALL_POSES.map((pose) => {
        const series = seriesName.get(pose.series) || pose.series;
        const variants: LibraryVariant[] = pose.angles.map((angle) => ({
            key: angle,
            label: POSE_ANGLE_LABELS[angle] || angle,
            short: (POSE_ANGLE_LABELS[angle] || angle).slice(0, 1),
            // 网格用 CDN 的 thumbs jpg，插入节点才取 PNG 原图。
            thumb: getPoseThumbUrl(pose.id, angle),
            image: getPoseImageUrl(pose.id, angle),
            // 深度图与姿势图共用 id 体系（`{组ID}_{视角}`），直接由 id 推导，不额外拉 1MB 索引。
            altThumb: `${CDN.depth}/thumbs/${pose.id}_${angle}.jpg`,
            altImage: `${CDN.depth}/img/${pose.id}_${angle}.png`,
        }));
        const base = variants[0];
        return {
            key: `pose:${pose.id}`,
            library: "pose" as const,
            id: pose.id,
            title: pose.name,
            meta: `${series} · ${pose.id}`,
            tags: [pose.category].filter(Boolean),
            terms: "",
            thumb: base?.thumb || "",
            preview: base?.thumb || "",
            image: base?.image || "",
            variants,
            facets: { series: [series], category: pose.category ? [pose.category] : [] },
            search: `${pose.id} ${pose.name} ${pose.category} ${series}`.toLowerCase(),
            nsfw: pose.nsfw,
        };
    });
}

async function buildLibrary(id: SystemLibraryId): Promise<LibraryItem[]> {
    if (id === "pose") return loadPose();
    if (id === "portrait") return loadPortrait();
    if (id === "anime") return loadAnime();
    return loadCostume();
}

const inflight = new Map<SystemLibraryId, Promise<SystemLibrarySource>>();

/**
 * 读取一个图库（IndexedDB 优先，7 天过期）。同一图库的并发请求共享一次加载。
 */
export function loadSystemLibrary(id: SystemLibraryId): Promise<SystemLibrarySource> {
    const existing = inflight.get(id);
    if (existing) return existing;

    const task = (async () => {
        // v4：姿势原图地址补上 `img/` 段（旧键里存的是根路径，取到的是 CDN 首页 HTML，
        // 插入画布后是一张坏图）。不换键的话老缓存会继续用坏地址，修了也看不到效果。
        const cacheKey = `syslib:v4:${id}`;
        const cached = await readCache<LibraryItem[]>(cacheKey);
        if (cached && cached.length) return { id, items: cached };
        const items = await buildLibrary(id);
        void writeCache(cacheKey, items);
        return { id, items };
    })();

    inflight.set(id, task);
    // 失败的不留在缓存里，下次重进面板会重试。
    void task.catch(() => inflight.delete(id));
    return task;
}
