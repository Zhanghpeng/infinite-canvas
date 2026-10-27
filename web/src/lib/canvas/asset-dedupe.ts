// 资产去重：判断"这条资产是不是已经收过了"。
//
// 与存储层的内容指纹分工不同：
//   · 存储层指纹保证同一份字节只落一个文件（物理层面不膨胀）
//   · 这里的身份键保证同一个东西不会在资产库里出现两个条目（逻辑层面不膨胀）
// 两者都要有：只做物理去重，库里仍会堆出一串指向同一文件的重复卡片；只做条目去重，
// 从两条不同路径（画布收藏 / 手动上传）进来的同一张图仍是两个文件。
//
// 判定规则按类型分开，都取"用户心里的同一件东西"而不是"对象完全相同"：
//   · 图片/视频/音频 → 同一个存储键（= 同一份字节）；历史数据只有 dataUrl/url 时退回比内容
//   · 文本           → 正文完全一致（首尾空白不计）
//   · 组合           → 成员与槽位集合一致（成员 id 来自上面的判定，所以也是按内容传递的）

type AssetLike = { kind: string; data?: unknown };

type TextData = { content?: string };
type MediaData = { storageKey?: string; dataUrl?: string; url?: string };
type BundleData = { items?: Array<{ assetId?: string; slot?: string }> };

/**
 * 一条资产的身份键。同一份东西必然产生相同的键，不同东西的键不会相交。
 * 返回空数组表示"这条资产没法判身份"（例如占位图片既无键也无内容），调用方按不重复处理。
 */
export function assetIdentityKeys(asset: AssetLike): string[] {
    if (!asset?.data || typeof asset.data !== "object") return [];
    const keys: string[] = [];
    if (asset.kind === "text") {
        const content = (asset.data as TextData).content?.trim();
        if (content) keys.push(`text:${content}`);
        return keys;
    }
    if (asset.kind === "image" || asset.kind === "video" || asset.kind === "audio") {
        const data = asset.data as MediaData;
        // 存储键是最可靠的身份：内容指纹命名后，同键 = 同内容，跨来源也能对上。
        if (data.storageKey) keys.push(`key:${data.storageKey}`);
        // 老数据/未落盘的图只有内联内容，单独比一份，免得跟"已落盘的同图"互相看不见。
        const inline = data.dataUrl || data.url;
        if (inline && inline.startsWith("data:")) keys.push(`inline:${inline}`);
        return keys;
    }
    if (asset.kind === "bundle") {
        const items = ((asset.data as BundleData).items || []).filter((item) => item.assetId);
        // 成员全失效的组合不参与去重：否则第二次"选中若干资产打包"会静默并进一个空壳。
        if (!items.length) return keys;
        keys.push(`bundle:${items.map((item) => `${item.slot || "reference"}:${item.assetId}`).sort().join("|")}`);
        return keys;
    }
    return keys;
}

/** 在已有资产里找"同一条东西"。命中返回原资产，没有则 undefined。 */
export function findDuplicateAsset<T extends AssetLike>(assets: readonly T[], candidate: AssetLike): T | undefined {
    const incoming = assetIdentityKeys(candidate);
    if (!incoming.length) return undefined;
    for (const asset of assets) {
        if (asset.kind !== candidate.kind) continue;
        const existing = assetIdentityKeys(asset);
        if (!existing.length) continue;
        if (incoming.some((key) => existing.includes(key))) return asset;
    }
    return undefined;
}

/**
 * 命中重复时把新信息并进原条目：标签取并集，来源/备注只在原值为空时补。
 * 标题不动 —— 用户可能已经改过名，拿"画布图片"这类默认标题把它覆盖掉是净损失。
 */
export function mergeIntoExisting<T extends { tags?: string[]; source?: string; note?: string }>(existing: T, incoming: { tags?: string[]; source?: string; note?: string }): T {
    const tags = Array.from(new Set([...(existing.tags || []), ...(incoming.tags || [])].filter(Boolean)));
    return {
        ...existing,
        tags,
        source: existing.source || incoming.source,
        note: existing.note || incoming.note,
    };
}
