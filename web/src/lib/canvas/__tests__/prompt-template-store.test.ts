import { beforeEach, describe, expect, it } from "vitest";

import { clearPromptTemplate, loadAllPromptTemplates, loadPromptTemplate, promptTemplateStorageKey, savePromptTemplate } from "../prompt-template-store";

describe("自定义提示词模板", () => {
    beforeEach(() => {
        window.localStorage.clear();
    });

    it("存进去能读回来，并且去掉首尾空白", () => {
        expect(savePromptTemplate(2, "  两个人，各自换掉  ")).toBe(true);
        expect(loadPromptTemplate(2)).toBe("两个人，各自换掉");
    });

    it("按精确人数隔离：3 人存的那份不会被 5 人读到", () => {
        savePromptTemplate(3, "三个人");
        // 人数写死在正文里，跨人数复用会让编号和人数都错，所以宁可回落内置模板。
        expect(loadPromptTemplate(5)).toBeNull();
        expect(loadPromptTemplate(3)).toBe("三个人");
    });

    it("空文本不落盘（存空等于让下次没模板可用）", () => {
        expect(savePromptTemplate(1, "   ")).toBe(false);
        expect(loadPromptTemplate(1)).toBeNull();
    });

    it("非法人数直接拒绝，不写出一堆奇怪 key", () => {
        expect(savePromptTemplate(0, "x")).toBe(false);
        expect(savePromptTemplate(-2, "x")).toBe(false);
        expect(savePromptTemplate(Number.NaN, "x")).toBe(false);
        expect(loadPromptTemplate(0)).toBeNull();
        expect(loadAllPromptTemplates()).toEqual({});
    });

    it("清除后回到内置（读回 null）", () => {
        savePromptTemplate(2, "自定义");
        clearPromptTemplate(2);
        expect(loadPromptTemplate(2)).toBeNull();
    });

    it("一次读全部时只认自己的前缀，别的 localStorage 数据不受影响", () => {
        window.localStorage.setItem("canvas-agent-panel-width", "440");
        savePromptTemplate(1, "一个");
        savePromptTemplate(4, "四个");
        expect(loadAllPromptTemplates()).toEqual({ 1: "一个", 4: "四个" });
    });

    it("key 带人数后缀，便于人工排查", () => {
        expect(promptTemplateStorageKey(3)).toBe("infinite-canvas:prompt-template:character:3");
    });
});
