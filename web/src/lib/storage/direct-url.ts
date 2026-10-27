// 媒体 URL 的「是否只在本机有效」判定。
//
// 本地存储模式下，媒体不再读成 Blob + objectURL，而是直接给工作区服务的文件地址。
// 这类地址与 blob: 一样是**临时**的：换台机器、换个端口就打不开。
// 协同广播、分享、导出这些要把内容交给别人的路径，必须先认出它们再换成 storageKey 派生的地址。

/** 本地工作区服务给出的媒体直链（形如 http://127.0.0.1:17400/file?path=...&token=...）。 */
export function isDirectMediaUrl(url?: string | null): boolean {
    return Boolean(url && url.includes("/file?path="));
}

/** 只在本机有效的媒体 URL：blob: 或本地服务直链。空值也算（没有可用地址）。 */
export function isEphemeralMediaUrl(url?: string | null): boolean {
    if (!url) return true;
    return url.startsWith("blob:") || isDirectMediaUrl(url);
}
