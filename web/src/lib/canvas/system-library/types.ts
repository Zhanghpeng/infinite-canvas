/**
 * 系统素材库的统一数据模型。
 *
 * 五套外部素材（写实服饰、二次元画风服饰、脸型、二次元造型、深度图）字段各不相同，
 * 在 `sources.ts` 里归一化成下面的形状，面板只认这一种结构。
 */

export type SystemLibraryId = "costume" | "portrait" | "anime" | "pose";

/** 同一件素材的另一种视图：姿势机位、发色变体、线稿、深度图。 */
export type LibraryVariant = {
    key: string;
    label: string;
    /** 卡片上的一字标签（机位/发色），没有就退回 label。 */
    short?: string;
    /** 有值时渲染成色点而不是文字胶囊。 */
    swatch?: string;
    thumb: string;
    image: string;
    /** 深度图等"第二形态"，切换时优先于 thumb / image。 */
    altThumb?: string;
    altImage?: string;
};

export type LibraryItem = {
    /** `${library}:${id}`，收藏与最近使用的稳定键。 */
    key: string;
    library: SystemLibraryId;
    id: string;
    /** 卡片主标题。 */
    title: string;
    /** 卡片副标题：分类 · 编号。 */
    meta: string;
    /** 可点选加筛选的中文标签。 */
    tags: string[];
    /** 可直接粘进提示词的英文关键词（多数库没有）。 */
    terms: string;
    thumb: string;
    preview: string;
    /** 插入画布时使用的高清图。 */
    image: string;
    /** 完整视图列表，首项即默认视图；为空时用 thumb / image。 */
    variants: LibraryVariant[];
    /** 分面：组键 → 该条目命中的取值。 */
    facets: Record<string, string[]>;
    /** 小写检索串（编号 + 分类 + 中英文关键词）。 */
    search: string;
    /** 服饰的画风切换：二次元画风下的对应图。 */
    altThumb?: string;
    altPreview?: string;
    altImage?: string;
};

export type SystemLibrarySource = {
    id: SystemLibraryId;
    items: LibraryItem[];
};

export type FacetGroup = {
    key: string;
    /** i18n 键后缀，面板用 `canvas.systemLibrary.facet.${labelKey}` 取文案。 */
    labelKey: string;
};

export type FacetSelection = Record<string, string[]>;
