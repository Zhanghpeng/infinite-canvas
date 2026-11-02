import type { FacetSelection, LibraryItem } from "./types";

/**
 * 检索与分面计数。
 *
 * 规则和电商分面一致：自由词之间是「且」，同一分面组内是「或」，组与组之间是「且」。
 * 计数时会把当前组自身的选择排除掉，否则组内多选后其余项全部归零、点不动。
 */

export function tokenize(query: string): string[] {
    const trimmed = query.trim().toLowerCase();
    return trimmed ? trimmed.split(/\s+/).filter(Boolean) : [];
}

function matchesTokens(item: LibraryItem, tokens: string[]): boolean {
    return tokens.every((token) => item.search.includes(token));
}

function matchesFacets(item: LibraryItem, selection: FacetSelection, skipGroup?: string): boolean {
    for (const group in selection) {
        if (group === skipGroup) continue;
        const values = selection[group];
        if (!values?.length) continue;
        const own = item.facets[group];
        if (!own || !values.some((value) => own.includes(value))) return false;
    }
    return true;
}

export function filterLibraryItems(items: LibraryItem[], tokens: string[], selection: FacetSelection): LibraryItem[] {
    if (!tokens.length) {
        const hasFacet = Object.values(selection).some((values) => values?.length);
        if (!hasFacet) return items;
    }
    return items.filter((item) => matchesTokens(item, tokens) && matchesFacets(item, selection));
}

/** 全库取值表，按出现次数降序；用于渲染固定位置的 chip（计数会随后变化）。 */
export function collectFacetValues(items: LibraryItem[], group: string): string[] {
    const counts = new Map<string, number>();
    for (const item of items) {
        for (const value of item.facets[group] ?? []) {
            counts.set(value, (counts.get(value) ?? 0) + 1);
        }
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([value]) => value);
}

/** 当前检索条件下的组内计数，缺席的取值记为 0（面板据此置灰）。 */
export function countFacetValues(items: LibraryItem[], tokens: string[], selection: FacetSelection, group: string): Map<string, number> {
    const pool = items.filter((item) => matchesTokens(item, tokens) && matchesFacets(item, selection, group));
    const counts = new Map<string, number>();
    for (const item of pool) {
        for (const value of item.facets[group] ?? []) {
            counts.set(value, (counts.get(value) ?? 0) + 1);
        }
    }
    return counts;
}

export function hasAnyFacet(selection: FacetSelection): boolean {
    return Object.values(selection).some((values) => values?.length);
}
