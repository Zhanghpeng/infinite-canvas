// 本地工作区服务的 HTTP 客户端。
//
// 只负责与 local-workspace 服务通信，不含任何业务语义（scope 与路径映射由 LocalFsBackend 决定）。
// 超时约定：探活 1500ms（超时即判定不可用）；文件读写 30s（超时直接报错，不重试）。

export type LocalWorkspaceEntry = { path: string; type: "file" | "directory"; size?: number; mtime?: number };

export type LocalWorkspaceManifest = {
    app: string;
    version: number;
    createdAt: string;
    updatedAt: string;
    name?: string;
    projects?: unknown[];
    library?: { version: number; count: number };
};

const HEALTH_TIMEOUT_MS = 1500;
const FILE_TIMEOUT_MS = 30_000;

function base(baseUrl: string) {
    return baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
}

function endpoint(baseUrl: string, path: string, params?: Record<string, string | undefined>) {
    const target = new URL(path, base(baseUrl));
    Object.entries(params || {}).forEach(([key, value]) => {
        if (value !== undefined && value !== null) target.searchParams.set(key, value);
    });
    return target.toString();
}

function authHeaders(token: string): Record<string, string> {
    return token ? { "x-workspace-token": token } : {};
}

async function readError(response: Response, fallback: string) {
    try {
        const body = (await response.json()) as { error?: string };
        return body.error || fallback;
    } catch {
        return fallback;
    }
}

export async function checkLocalWorkspace(baseUrl: string, token: string): Promise<boolean> {
    if (!baseUrl) return false;
    try {
        const response = await fetch(endpoint(baseUrl, "health"), { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
        return response.ok;
    } catch {
        return false;
    }
}

export async function readWorkspaceManifest(baseUrl: string, token: string) {
    const response = await fetch(endpoint(baseUrl, "workspace"), { headers: authHeaders(token), signal: AbortSignal.timeout(FILE_TIMEOUT_MS) });
    if (!response.ok) throw new Error(await readError(response, "读取工作区清单失败"));
    return (await response.json()) as { ok: boolean; workspacePath: string; manifest: LocalWorkspaceManifest | null };
}

export async function initWorkspace(baseUrl: string, token: string, workspacePath?: string) {
    const response = await fetch(endpoint(baseUrl, "workspace/init"), {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders(token) },
        body: JSON.stringify(workspacePath ? { path: workspacePath } : {}),
        signal: AbortSignal.timeout(FILE_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(await readError(response, "初始化工作区失败"));
    return (await response.json()) as { ok: boolean; workspacePath: string; manifest: LocalWorkspaceManifest };
}

export async function listWorkspaceFiles(baseUrl: string, token: string, dir: string, recursive = false) {
    const response = await fetch(endpoint(baseUrl, "files", { dir, recursive: recursive ? "true" : undefined }), { headers: authHeaders(token), signal: AbortSignal.timeout(FILE_TIMEOUT_MS) });
    if (!response.ok) throw new Error(await readError(response, "列目录失败"));
    const body = (await response.json()) as { ok: boolean; entries: LocalWorkspaceEntry[] };
    return body.entries;
}

export async function readWorkspaceFile(baseUrl: string, token: string, path: string): Promise<Blob | null> {
    const response = await fetch(endpoint(baseUrl, "file", { path }), { headers: authHeaders(token), signal: AbortSignal.timeout(FILE_TIMEOUT_MS) });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(await readError(response, "读取文件失败"));
    return await response.blob();
}

export async function writeWorkspaceFile(baseUrl: string, token: string, path: string, body: Blob | string) {
    const response = await fetch(endpoint(baseUrl, "file", { path }), {
        method: "PUT",
        headers: authHeaders(token),
        body,
        signal: AbortSignal.timeout(FILE_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(await readError(response, "写入文件失败"));
}

export async function deleteWorkspaceFile(baseUrl: string, token: string, path: string) {
    const response = await fetch(endpoint(baseUrl, "file", { path }), { method: "DELETE", headers: authHeaders(token), signal: AbortSignal.timeout(FILE_TIMEOUT_MS) });
    if (!response.ok) throw new Error(await readError(response, "删除文件失败"));
}

export async function renameWorkspaceFile(baseUrl: string, token: string, from: string, to: string) {
    const response = await fetch(endpoint(baseUrl, "file/rename"), {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders(token) },
        body: JSON.stringify({ from, to }),
        signal: AbortSignal.timeout(FILE_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(await readError(response, "重命名失败"));
}
