/**
 * 视频生成的尺寸口径：MiniMax 支持的真实像素档位，以及"分段该输出多大"的推导。
 *
 * 两件事放在一起，因为它们回答的是同一个问题：这条链路到底会按多大生成。
 *
 * 分段链路对尺寸有一条硬要求 —— 所有段必须同尺寸。成片是逐段拼接的，段与段
 * 尺寸不一，接缝处会被编码器拉伸，或者干脆丢一段画面。而"多大"不能直接沿用
 * 全局设置：全局是给"从零生成"用的，分段是"在一条已有视频上改"，方向必须跟
 * 参考片一致。竖屏段拼进横屏片，两边的画幅对不上，交付物直接报废。
 */

export type MiniMaxVideoTier = {
    /** 像素档位的展示副标签（0.5M 之类）。上游按模型 DSL 现场算档位时没有这一层。 */
    mp?: string;
    landscapeW: number;
    landscapeH: number;
};

/**
 * MiniMax H3 官方支持的 32 整数倍尺寸档位（最大支持到 0.98 MP）
 */
export const MINIMAX_VIDEO_SIZE_TIERS: MiniMaxVideoTier[] = [
    { mp: "0.2M", landscapeW: 608, landscapeH: 352 },
    { mp: "0.3M", landscapeW: 736, landscapeH: 416 },
    { mp: "0.4M", landscapeW: 864, landscapeH: 480 },
    { mp: "0.5M", landscapeW: 960, landscapeH: 544 },
    { mp: "0.6M", landscapeW: 1056, landscapeH: 608 },
    { mp: "0.7M", landscapeW: 1152, landscapeH: 640 },
    { mp: "0.8M", landscapeW: 1216, landscapeH: 672 },
    { mp: "0.9M", landscapeW: 1280, landscapeH: 736 },
    { mp: "0.98M", landscapeW: 1344, landscapeH: 768 },
];

export const videoSizeOptions = MINIMAX_VIDEO_SIZE_TIERS.flatMap((tier) => [
    { value: `${tier.landscapeW}x${tier.landscapeH}`, label: `16:9 · ${tier.landscapeW}×${tier.landscapeH}${tier.mp ? ` (${tier.mp})` : ""}`, width: tier.landscapeW, height: tier.landscapeH },
    { value: `${tier.landscapeH}x${tier.landscapeW}`, label: `9:16 · ${tier.landscapeH}×${tier.landscapeW}${tier.mp ? ` (${tier.mp})` : ""}`, width: tier.landscapeH, height: tier.landscapeW },
]);

/** 认不出尺寸时的默认值，保持历史行为（竖屏 0.5M）。 */
export const DEFAULT_VIDEO_SIZE = "544x960";
/** 分段自己推方向时用的档位：0.5M 是质量与耗时的平衡点。 */
const SEGMENT_DEFAULT_TIER = MINIMAX_VIDEO_SIZE_TIERS[3];
const PIXEL_SIZE_PATTERN = /^(\d+)\s*[x×]\s*(\d+)$/;

/** 只认 `宽x高` 这种实尺寸；比例字符串（16:9）与 auto 都不算。 */
export function isPixelVideoSize(value?: string): boolean {
    return PIXEL_SIZE_PATTERN.test((value || "").trim());
}

export function normalizeVideoSizeValue(value?: string, profile?: { capabilityConfig?: { size?: { values?: string[]; default?: string } } }) {
    const allowed = profile?.capabilityConfig?.size?.values;
    const fallback = profile?.capabilityConfig?.size?.default || DEFAULT_VIDEO_SIZE;
    if (!value) return fallback;
    if (allowed && allowed.length > 0) {
        const clean = value.toLowerCase().replace(/\s+/g, "");
        const matched = allowed.find((item) => item.toLowerCase().replace(/\s+/g, "") === clean);
        return matched || fallback;
    }
    const isValid = videoSizeOptions.some((option) => option.value === value);
    return isValid ? value : fallback;
}

export function parseVideoSize(sizeStr?: string, tiers?: MiniMaxVideoTier[]): { width: number; height: number; aspect: "16:9" | "9:16"; tier: MiniMaxVideoTier } {
    const raw = (sizeStr || "").trim().toLowerCase();
    const match = raw.match(PIXEL_SIZE_PATTERN);
    const w = Number(match?.[1]) || 544;
    const h = Number(match?.[2]) || 960;
    const availableTiers = tiers && tiers.length ? tiers : MINIMAX_VIDEO_SIZE_TIERS;

    const isLandscape = w >= h;
    const aspect: "16:9" | "9:16" = isLandscape ? "16:9" : "9:16";
    const longSide = Math.max(w, h);
    const shortSide = Math.min(w, h);

    // 寻找最接近的 tier（默认 0.5M）
    let matchedTier = SEGMENT_DEFAULT_TIER;
    let minDiff = Infinity;
    for (const t of availableTiers) {
        const diff = Math.abs(t.landscapeW - longSide) + Math.abs(t.landscapeH - shortSide);
        if (diff < minDiff) {
            minDiff = diff;
            matchedTier = t;
        }
    }

    const finalW = aspect === "16:9" ? matchedTier.landscapeW : matchedTier.landscapeH;
    const finalH = aspect === "16:9" ? matchedTier.landscapeH : matchedTier.landscapeW;

    return { width: finalW, height: finalH, aspect, tier: matchedTier };
}

/**
 * 分段这一批该按多大生成。
 *
 * 优先级：
 * 1. 节点上显式选过的尺寸（用户在视频设置里点过的宽高比 / 档位）—— 那是他的决定；
 * 2. 否则跟随**参考视频的方向**，档位取 0.5M。
 *
 * 第 2 条是这条链路的默认值。分段编辑的产物要拼回原片，画幅必须跟原片一致；
 * 之前这里直接吃了全局 `size`，而全局多半是 `auto` 或竖屏默认值 —— 横屏原片
 * 会跑出一列竖屏段，用户看到的结论就是"画面比例参数没生效"。
 */
export function resolveSegmentVideoSize(options: { size?: string; width?: number; height?: number }): string {
    const explicit = (options.size || "").trim().toLowerCase();
    const match = explicit.match(PIXEL_SIZE_PATTERN);
    if (match) return `${Number(match[1])}x${Number(match[2])}`;
    const width = options.width ?? 0;
    const height = options.height ?? 0;
    // 方向判不出来时按横屏给：本项目源片以横屏为主，判错的代价是整批不能用。
    return height > width ? `${SEGMENT_DEFAULT_TIER.landscapeH}x${SEGMENT_DEFAULT_TIER.landscapeW}` : `${SEGMENT_DEFAULT_TIER.landscapeW}x${SEGMENT_DEFAULT_TIER.landscapeH}`;
}
