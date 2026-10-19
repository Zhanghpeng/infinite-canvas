import { FsaBackend } from "@/lib/storage/fsa-backend";
import { hasDirectoryPermission, isFileSystemAccessSupported, loadWorkspaceHandle, touchWorkspace } from "@/lib/storage/fsa-handle";
import { setStorageBackend } from "@/lib/storage";
import { LocalFsBackend } from "@/lib/storage/local-fs-backend";
import { readStoragePrefs } from "@/lib/storage/storage-prefs";
import { useStorageStore, type StorageStatus } from "@/stores/use-storage-store";

// 在应用 store 被导入之前解析存储模式并切换后端。
//
// 为什么必须在最前面：zustand persist 的 store 在模块导入时就会从后端 rehydrate，
// 一旦 store 已经按 IndexedDB 完成水合，再切后端就晚了。因此 main.tsx 先 await 本函数、
// 再动态导入应用模块。
//
// 任何"没准备好"的情况都回退浏览器模式（启动期回退，不是运行期静默降级），
// 并把原因写进 status 供界面提示。

function fallback(status: StorageStatus): StorageStatus {
    useStorageStore.getState().setStatus(status);
    return status;
}

export async function resolveStorageBackend(): Promise<StorageStatus> {
    const prefs = readStoragePrefs();

    if (prefs.mode === "service") {
        const backend = new LocalFsBackend(prefs.serviceUrl, prefs.serviceToken);
        if (!(await backend.isAvailable())) return fallback("service-unavailable");
        setStorageBackend(backend);
        return fallback("service");
    }

    if (prefs.mode === "directory") {
        if (!isFileSystemAccessSupported()) return fallback("directory-unsupported");
        const handle = prefs.directoryId ? await loadWorkspaceHandle(prefs.directoryId) : null;
        // 权限申请必须发生在用户手势中，启动期只能查询；未授权则回退并提示用户去重新授权。
        if (!handle || !(await hasDirectoryPermission(handle))) return fallback("directory-needs-permission");
        void touchWorkspace(prefs.directoryId);
        setStorageBackend(new FsaBackend(handle));
        return fallback("directory");
    }

    return fallback("browser");
}
