import { FsaBackend } from "@/lib/storage/fsa-backend";
import { hasDirectoryPermission, loadWorkspaceHandle, requestDirectoryPermission } from "@/lib/storage/fsa-handle";
import { readStoragePrefs, type StoragePrefs } from "@/lib/storage/storage-prefs";
import { deleteWorkspaceFile, readWorkspaceFile, writeWorkspaceFile } from "@/services/api/local-workspace";

// 存储自检：往目标工作区写一个探针文件，读回校验，再删掉。
// 用于在真正使用前确认"写-读-删"链路是通的（对本地目录与本地服务两种模式都适用）。

export type SelfCheckResult = { ok: boolean; detail: string };

type ProbeIo = {
    read: (path: string) => Promise<Blob | null>;
    write: (path: string, data: Blob | string) => Promise<void>;
    remove: (path: string) => Promise<void>;
};

const PROBE_PATH = ".meta/selftest.json";

async function probe(io: ProbeIo): Promise<SelfCheckResult> {
    const token = `selftest-${Date.now()}`;
    try {
        await io.write(PROBE_PATH, JSON.stringify({ token }));
    } catch (error) {
        return { ok: false, detail: `写入失败：${messageOf(error)}` };
    }
    try {
        const blob = await io.read(PROBE_PATH);
        if (!blob) return { ok: false, detail: "写入成功但读回为空" };
        const parsed = JSON.parse(await blob.text()) as { token?: string };
        if (parsed.token !== token) return { ok: false, detail: "读回内容与写入不一致" };
    } catch (error) {
        return { ok: false, detail: `读回失败：${messageOf(error)}` };
    }
    try {
        await io.remove(PROBE_PATH);
    } catch {
        // 删不掉不影响结论，探针文件位于 .meta 下。
    }
    return { ok: true, detail: "读写正常" };
}

export async function selfCheckStorage(prefs: StoragePrefs = readStoragePrefs()): Promise<SelfCheckResult> {
    if (prefs.mode === "service") {
        const { serviceUrl, serviceToken } = prefs;
        return await probe({
            read: (path) => readWorkspaceFile(serviceUrl, serviceToken, path),
            write: (path, data) => writeWorkspaceFile(serviceUrl, serviceToken, path, data),
            remove: (path) => deleteWorkspaceFile(serviceUrl, serviceToken, path),
        });
    }

    if (prefs.mode === "directory") {
        const handle = prefs.directoryId ? await loadWorkspaceHandle(prefs.directoryId) : null;
        if (!handle) return { ok: false, detail: "尚未选择目录" };
        if (!(await hasDirectoryPermission(handle))) {
            // 自检由按钮触发，处于用户手势中，可以直接申请权限。
            if (!(await requestDirectoryPermission(handle))) return { ok: false, detail: "未获得目录读写权限" };
        }
        const backend = new FsaBackend(handle);
        return await probe({
            read: (path) => backend.readPath(path),
            write: (path, data) => backend.writePath(path, data),
            remove: (path) => backend.deletePath(path),
        });
    }

    return { ok: true, detail: "浏览器模式使用 IndexedDB，无需自检" };
}

function messageOf(error: unknown) {
    return error instanceof Error ? error.message : String(error);
}
