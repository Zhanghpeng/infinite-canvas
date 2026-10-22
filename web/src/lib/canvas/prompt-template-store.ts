/**
 * 角色替换提示词：用户自定义的默认模板。
 *
 * 自动填入的模板只是**起点**。实际用起来每个人都有自己的写法（要不要强调服装、
 * 要不要提水印、镜头那几句留不留），每开一批都得重改一遍是纯损耗。这里把改好的
 * 版本按人数存下来，下次勾选同样数量的角色就直接用它。
 *
 * 为什么按**精确人数**存、而不是按 one/two/many 三档存：模板正文里写死了人数与
 * 参考图编号（"参考图 1 至参考图 {{count}}"）。按档存的话，3 人时存的版本会被
 * 5 人的段拿去用，人数就是错的 —— 而这种错模型不会报，只会少画两个人。
 * 换了人数就该用对应人数的措辞，所以宁可回到内置模板，也不复用一个数字不对的自定义版。
 */

const STORAGE_PREFIX = "infinite-canvas:prompt-template:character";

/** 存 localStorage 可能直接抛（隐私模式、存储被禁用），提示词功能不能因此挂掉。 */
function storage(): Storage | null {
    try {
        if (typeof window === "undefined") return null;
        return window.localStorage;
    } catch {
        return null;
    }
}

export function promptTemplateStorageKey(count: number): string {
    return `${STORAGE_PREFIX}:${count}`;
}

/** 读某个人数下的自定义模板；没有或已被清空时返回 null（调用方回落到内置模板）。 */
export function loadPromptTemplate(count: number): string | null {
    if (!Number.isFinite(count) || count <= 0) return null;
    const raw = storage()?.getItem(promptTemplateStorageKey(Math.round(count)));
    const trimmed = raw?.trim();
    return trimmed ? trimmed : null;
}

/** 存为默认。返回 false 表示没存下（空文本或不给存储），调用方据此提示用户。 */
export function savePromptTemplate(count: number, text: string): boolean {
    const trimmed = text.trim();
    if (!trimmed || !Number.isFinite(count) || count <= 0) return false;
    const target = storage();
    if (!target) return false;
    try {
        target.setItem(promptTemplateStorageKey(Math.round(count)), trimmed);
        return true;
    } catch {
        return false;
    }
}

/** 一次读全部自定义模板（key 是人数）。弹窗打开时载一次，避免每次渲染都读存储。 */
export function loadAllPromptTemplates(): Record<number, string> {
    const target = storage();
    const result: Record<number, string> = {};
    if (!target) return result;
    try {
        for (let index = 0; index < target.length; index += 1) {
            const key = target.key(index);
            if (!key || !key.startsWith(`${STORAGE_PREFIX}:`)) continue;
            const count = Number(key.slice(STORAGE_PREFIX.length + 1));
            const text = target.getItem(key)?.trim();
            if (Number.isFinite(count) && count > 0 && text) result[count] = text;
        }
    } catch {
        // 读到一半抛了就把已经拿到的返回去：少几条自定义模板不影响本次使用。
    }
    return result;
}

/** 清掉自定义模板，回到内置版本。 */
export function clearPromptTemplate(count: number): void {
    if (!Number.isFinite(count) || count <= 0) return;
    try {
        storage()?.removeItem(promptTemplateStorageKey(Math.round(count)));
    } catch {
        // 清不掉也不影响本次使用：内存里的状态已经回到内置模板了。
    }
}
