// automatic JSX 的 dev 变体(编译器在 dev 模式会引用 jsxDEV)。转发到同一套 createElement。

import type * as React from "react";

import { createElement, Fragment } from "./jsx-runtime";

export { Fragment };
export type { JSX } from "./jsx-runtime";

export function jsxDEV(type: unknown, props: Record<string, unknown> | null, key?: unknown, _isStaticChildren?: boolean, _source?: unknown, _self?: unknown): React.ReactElement {
    return createElement(type, props, key);
}
