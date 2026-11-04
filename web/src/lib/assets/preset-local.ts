/**
 * 预设资产的本地副本。
 *
 * 图片二进制不进仓库（详见 `scripts/fetch-system-presets.mjs`），由脚本拉到
 * `web/public/system-presets/` 并写一份 manifest；运行时命中 manifest 就走同源，
 * 没命中（没拉过 / 线上部署没带）就继续走公开 CDN。境外 CDN 在国内直连经常整片超时，
 * 本地副本是唯一能让素材库稳定出图的办法。
 */

const LOCAL_BASE = "/system-presets";

let pending: Promise<Set<string>> | undefined;

/** 本地已落盘的图片相对路径集合。取不到 manifest 时返回空集，全部回落 CDN。 */
export function loadPresetLocalPaths(): Promise<Set<string>> {
    pending ??= fetch(`${LOCAL_BASE}/manifest.json`)
        .then((response) => (response.ok ? response.json() : null))
        .then((data) => new Set<string>(Array.isArray(data?.files) ? data.files : []))
        .catch(() => new Set<string>());
    return pending;
}

/** 命中本地就换成同源地址，否则保持 CDN 原地址。 */
export function preferLocalPreset(localPaths: Set<string>, relPath: string, remote: string): string {
    return localPaths.has(relPath) ? `${LOCAL_BASE}/${relPath}` : remote;
}

/**
 * 远端 URL → 本地相对路径。服装/人像/动漫三类沿用 CDN 的 pathname（各库目录约定不同，
 * 与其在本地重建一套规则，不如原样镜像目录结构）。
 */
export function presetRelFromUrl(prefix: string, url: string): string {
    try {
        return `${prefix}${new URL(url).pathname}`;
    } catch {
        return "";
    }
}
