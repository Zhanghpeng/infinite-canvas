import { describe, expect, it } from "vitest";

import { COSTUME_FACET_GROUP_BY_KEYWORD } from "@/lib/canvas/system-library/facet-map";
import { collectFacetValues, countFacetValues, filterLibraryItems, hasAnyFacet, tokenize } from "@/lib/canvas/system-library/query";
import type { LibraryItem } from "@/lib/canvas/system-library/types";

function makeItem(id: string, facets: Record<string, string[]>, search = ""): LibraryItem {
    return {
        key: `costume:${id}`,
        library: "costume",
        id,
        title: id,
        meta: "",
        tags: [],
        terms: "",
        thumb: "",
        preview: "",
        image: "",
        variants: [],
        facets,
        search: `${id} ${search}`.toLowerCase(),
    } as unknown as LibraryItem;
}

const items = [
    makeItem("A", { season: ["夏装"], outfit: ["连衣裙"], color: ["白色"] }, "连衣裙 白色 蕾丝"),
    makeItem("B", { season: ["夏装"], outfit: ["半身裙"], color: ["黑色"] }, "半身裙 黑色 针织"),
    makeItem("C", { season: ["冬装"], outfit: ["连衣裙"], color: ["黑色"] }, "连衣裙 黑色 羊毛"),
];

describe("tokenize", () => {
    it("按空白切分并忽略大小写与多余空格", () => {
        expect(tokenize("  白色   Dress ")).toEqual(["白色", "dress"]);
        expect(tokenize("")).toEqual([]);
    });
});

describe("filterLibraryItems", () => {
    it("自由词之间是「且」", () => {
        expect(filterLibraryItems(items, ["连衣裙", "黑色"], {}).map((item) => item.id)).toEqual(["C"]);
    });

    it("同组多选是「或」", () => {
        expect(filterLibraryItems(items, [], { color: ["白色", "黑色"] })).toHaveLength(3);
    });

    it("跨组是「且」", () => {
        expect(filterLibraryItems(items, [], { color: ["黑色"], outfit: ["连衣裙"] }).map((item) => item.id)).toEqual(["C"]);
    });

    it("无任何条件时原样返回同一引用，避免多余渲染", () => {
        expect(filterLibraryItems(items, [], {})).toBe(items);
    });
});

describe("countFacetValues", () => {
    it("计数排除本组已选，组内多选后其余项不会归零", () => {
        const counts = countFacetValues(items, [], { color: ["白色"] }, "color");
        expect(counts.get("白色")).toBe(1);
        expect(counts.get("黑色")).toBe(2);
    });

    it("其他组的选择仍然收窄计数", () => {
        const counts = countFacetValues(items, [], { outfit: ["连衣裙"] }, "color");
        expect(counts.get("白色")).toBe(1);
        expect(counts.get("黑色")).toBe(1);
    });

    it("自由词同样参与计数", () => {
        const counts = countFacetValues(items, ["针织"], {}, "outfit");
        expect(counts.get("半身裙")).toBe(1);
        expect(counts.get("连衣裙")).toBeUndefined();
    });
});

describe("collectFacetValues", () => {
    it("按出现次数降序给出全库取值", () => {
        expect(collectFacetValues(items, "outfit")).toEqual(["连衣裙", "半身裙"]);
        expect(collectFacetValues(items, "season")).toEqual(["夏装", "冬装"]);
    });
});

describe("hasAnyFacet", () => {
    it("空数组不算已选", () => {
        expect(hasAnyFacet({ color: [] })).toBe(false);
        expect(hasAnyFacet({ color: ["黑色"] })).toBe(true);
    });
});

describe("服饰关键词分面映射", () => {
    const groups = new Set(["outfit", "color", "material", "cut", "accessory"]);

    it("覆盖上游 86 个关键词，且只落在五个组里", () => {
        const entries = Object.entries(COSTUME_FACET_GROUP_BY_KEYWORD);
        expect(entries).toHaveLength(86);
        for (const [, group] of entries) expect(groups.has(group)).toBe(true);
    });

    it("品类词不会漏进颜色组", () => {
        expect(COSTUME_FACET_GROUP_BY_KEYWORD["连衣裙"]).toBe("outfit");
        expect(COSTUME_FACET_GROUP_BY_KEYWORD["象牙白"]).toBe("color");
        expect(COSTUME_FACET_GROUP_BY_KEYWORD["针织"]).toBe("material");
        expect(COSTUME_FACET_GROUP_BY_KEYWORD["百褶"]).toBe("cut");
        expect(COSTUME_FACET_GROUP_BY_KEYWORD["乐福鞋"]).toBe("accessory");
    });
});
