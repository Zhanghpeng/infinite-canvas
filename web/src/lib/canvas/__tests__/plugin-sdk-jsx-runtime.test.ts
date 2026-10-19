// 插件 SDK 的 JSX 运行时把 props.children 转发给宿主 React.createElement。
// 关键点：React 只会把「作为独立参数传入」的子节点标记为已校验，数组必须展开传入，
// 否则开发模式下 React 会对静态多子节点报 "unique key" 警告（插件卡片上出现过）。
// 这里直接以编译产物的方式调用 jsxDEV（type, props, key, isStaticChildren）复现该路径。
import React from "react";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// eslint-disable-next-line import/first
import { jsxDEV } from "../../../../../plugins/canvas/sdk/src/jsx-dev-runtime";

const runtimeGlobal = globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean; InfiniteCanvasRuntime?: unknown };

beforeEach(() => {
    runtimeGlobal.IS_REACT_ACT_ENVIRONMENT = true;
    runtimeGlobal.InfiniteCanvasRuntime = {
        React,
        jsx: React.createElement,
        Fragment: React.Fragment,
        version: "test",
        emit: () => undefined,
        on: () => () => undefined,
        injectCSS: () => () => undefined,
    };
});

afterEach(() => {
    delete runtimeGlobal.InfiniteCanvasRuntime;
});

describe("插件 SDK JSX 运行时", () => {
    it("静态多子节点不再触发 React 的 key 警告", async () => {
        const errors: unknown[][] = [];
        const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
            errors.push(args);
        });

        // 与编译器产物一致：chrildren 在 props 里，isStaticChildren=true
        const Build = () =>
            jsxDEV(
                "div",
                {
                    style: { height: 100 },
                    children: [
                        jsxDEV("span", { children: "a" }, undefined, false),
                        jsxDEV("span", { children: "b" }, undefined, false),
                        jsxDEV("br", {}, undefined, false),
                    ],
                },
                undefined,
                true,
            ) as unknown as React.ReactElement;

        const container = document.createElement("div");
        document.body.appendChild(container);
        const root = createRoot(container);
        await act(async () => {
            root.render(React.createElement(Build));
        });

        const keyWarnings = errors.filter((args) => String(args[0]).includes('unique "key" prop'));
        expect(keyWarnings).toHaveLength(0);
        expect(container.textContent).toBe("ab");

        await act(async () => {
            root.unmount();
        });
        container.remove();
        spy.mockRestore();
    });
});
