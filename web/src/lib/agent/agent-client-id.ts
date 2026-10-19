import { randomId } from "@/lib/utils";

/**
 * 浏览器在本机 Canvas Agent 里的客户端身份：同一标签页内稳定、多标签页互斥。
 * 抽成公共模块，让助手面板、提示词助手等其他入口共用同一个身份发 turn。
 */
const CLIENT_ID_KEY = "canvas-agent-client-id";

type AgentClientGlobal = typeof globalThis & { __infiniteCanvasAgentClientIdPromise?: Promise<string> };

export function readAgentClientId(): string {
    try {
        return sessionStorage.getItem(CLIENT_ID_KEY) || "";
    } catch {
        return "";
    }
}

function saveAgentClientId(clientId: string) {
    try {
        sessionStorage.setItem(CLIENT_ID_KEY, clientId);
    } catch {
        // 当前页面会话内的内存身份已足够保持请求归属一致。
    }
}

export function acquireAgentClientId(): Promise<string> {
    const scope = globalThis as AgentClientGlobal;
    scope.__infiniteCanvasAgentClientIdPromise ||= (async () => {
        const storedClientId = readAgentClientId();
        let clientId = storedClientId || randomId();
        if (!navigator.locks) {
            if (!storedClientId) saveAgentClientId(clientId);
            return clientId;
        }
        while (true) {
            const acquired = await new Promise<boolean>((resolve, reject) => {
                void navigator.locks
                    .request(`infinite-canvas-agent:${clientId}`, { ifAvailable: true }, async (lock) => {
                        if (!lock) return resolve(false);
                        resolve(true);
                        await new Promise<void>(() => undefined);
                    })
                    .catch(reject);
            });
            if (acquired) {
                saveAgentClientId(clientId);
                return clientId;
            }
            clientId = randomId();
        }
    })().catch(() => {
        const clientId = randomId();
        saveAgentClientId(clientId);
        return clientId;
    });
    return scope.__infiniteCanvasAgentClientIdPromise;
}
