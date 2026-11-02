/**
 * 收藏与最近使用的本地记忆。
 *
 * 分镜要角色服装/发型保持一致，同一件素材会被反复取用；没有这两个列表就只能
 * 在 1400 多张里重翻一遍。只存 `library:id` 键，不存图片，体积极小。
 */

const FAVORITES_KEY = "canvas.system-library.favorites";
const RECENTS_KEY = "canvas.system-library.recents";
const RECENTS_LIMIT = 24;

function readKeys(storageKey: string): string[] {
    if (typeof window === "undefined") return [];
    try {
        const raw = window.localStorage.getItem(storageKey);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : [];
    } catch {
        return [];
    }
}

function writeKeys(storageKey: string, keys: string[]): void {
    if (typeof window === "undefined") return;
    try {
        window.localStorage.setItem(storageKey, JSON.stringify(keys));
    } catch {
        // 配额满或被禁用时放弃持久化，不影响当次使用。
    }
}

export function readFavoriteKeys(): string[] {
    return readKeys(FAVORITES_KEY);
}

export function writeFavoriteKeys(keys: string[]): void {
    writeKeys(FAVORITES_KEY, keys);
}

export function readRecentKeys(): string[] {
    return readKeys(RECENTS_KEY);
}

export function pushRecentKey(key: string): string[] {
    const next = [key, ...readRecentKeys().filter((item) => item !== key)].slice(0, RECENTS_LIMIT);
    writeKeys(RECENTS_KEY, next);
    return next;
}
