import type { PersistStorage, StorageValue } from "zustand/middleware";

import { getStorage } from "@/lib/storage";
import type { CanvasProject } from "@/stores/canvas/use-canvas-store";

// 主干（main）的画布 store 没有回收站；这里本地声明，仅用于兼容工作区索引里可能存在的墓碑数据。
export type CanvasDeletedProject = { id: string; deletedAt: string };

// 本地模式下的画布持久化实现（新增分支，不影响浏览器模式）。
//
// 与浏览器模式的唯一区别是落点：
//   浏览器模式：整个 projects[] 以 JSON 字符串写进 IndexedDB 的一个 key（原逻辑，保持不动）
//   本地模式：  每个项目一个 projects/<id>/project.json，工作区索引写 workspace.json
//
// 事务全部经由 getStorage()（存储抽象层），因此本地目录(FSA) 与本地服务两种后端都能用。

export const PROJECTS_DIR = "projects";
export const WORKSPACE_INDEX_FILE = "workspace.json";
export const PROJECT_BACKUP_DIR = ".meta/backups/projects";
const SAVE_DEBOUNCE_MS = 400;

export type CanvasPersistedState = { projects: CanvasProject[]; deletedProjects?: CanvasDeletedProject[] };

export type WorkspaceIndex = {
    app: string;
    version: number;
    createdAt: string;
    updatedAt: string;
    name?: string;
    projects: Array<{ id: string; title: string; updatedAt: string }>;
    deletedProjects?: CanvasDeletedProject[];
};

export function projectDir(id: string) {
    return `${PROJECTS_DIR}/${id}`;
}

export function projectFile(id: string) {
    return `${projectDir(id)}/project.json`;
}

async function readJson<T>(path: string): Promise<T | null> {
    const blob = await getStorage().readPath(path);
    if (!blob) return null;
    return JSON.parse(await blob.text()) as T;
}

export async function readWorkspaceIndex(): Promise<WorkspaceIndex | null> {
    return await readJson<WorkspaceIndex>(WORKSPACE_INDEX_FILE);
}

export async function readWorkspaceProject(id: string): Promise<CanvasProject | null> {
    try {
        return await readJson<CanvasProject>(projectFile(id));
    } catch {
        return null;
    }
}

function buildIndex(state: CanvasPersistedState, previous: WorkspaceIndex | null): WorkspaceIndex {
    const now = new Date().toISOString();
    return {
        app: "infinite-canvas",
        version: 1,
        createdAt: previous?.createdAt || now,
        updatedAt: now,
        name: previous?.name,
        projects: state.projects.map((project) => ({ id: project.id, title: project.title, updatedAt: project.updatedAt })),
        deletedProjects: state.deletedProjects ?? [],
    };
}

// 把内存态的 projects[] 落盘为「一项目一文件 + 工作区索引」。
// changedOnly=true 时按 updatedAt 跳过未变化的项目（持久化热路径）；
// changedOnly=false 时全量重写（迁移等一次性场景）。
export async function writeWorkspaceCanvas(state: CanvasPersistedState, options?: { changedOnly?: boolean; written?: Map<string, string> }): Promise<WorkspaceIndex> {
    const backend = getStorage();
    const changedOnly = options?.changedOnly ?? false;
    const written = options?.written ?? new Map<string, string>();
    const previous = await readWorkspaceIndex();

    const seen = new Set<string>();
    for (const project of state.projects) {
        seen.add(project.id);
        if (changedOnly && written.get(project.id) === project.updatedAt) continue;
        await backend.writePath(projectFile(project.id), JSON.stringify(project, null, 2));
        written.set(project.id, project.updatedAt);
    }

    // 删除只认墓碑：项目从 state 消失且带 deletedAt，才把目录移到备份区（可恢复，不直接删）。
    const deleted = new Set((state.deletedProjects ?? []).map((item) => item.id));
    for (const id of Array.from(written.keys())) {
        if (seen.has(id) || !deleted.has(id)) continue;
        await backend.movePath(projectDir(id), `${PROJECT_BACKUP_DIR}/${id}-${Date.now()}`);
        written.delete(id);
    }

    const index = buildIndex(state, previous);
    await backend.writePath(WORKSPACE_INDEX_FILE, JSON.stringify(index, null, 2));
    return index;
}

// 供其它模块（如工作区状态展示）复用：列出工作区内已落盘的项目 id。
export async function listWorkspaceProjectIds(): Promise<string[]> {
    const entries = await getStorage().listPath(PROJECTS_DIR);
    return entries.filter((entry) => entry.directory).map((entry) => entry.path);
}

export function createLocalCanvasStorage<S extends CanvasPersistedState>(): PersistStorage<S> {
    // 已落盘项目的 updatedAt 快照，用于保存时 diff。
    const written = new Map<string, string>();
    let queued: CanvasPersistedState | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function flush() {
        if (!queued) return;
        const state = queued;
        queued = null;
        await writeWorkspaceCanvas(state, { changedOnly: true, written });
    }

    return {
        getItem: async (): Promise<StorageValue<S> | null> => {
            const index = await readWorkspaceIndex();
            if (!index) return null;
            if (index.app !== "infinite-canvas") throw new Error("不是有效的工作区目录");
            if (index.version > 1) throw new Error(`工作区版本 ${index.version} 高于当前应用支持的版本，已中止读取`);

            const projects = (await Promise.all((index.projects || []).map((item) => readWorkspaceProject(item.id)))).filter((project): project is CanvasProject => Boolean(project));
            written.clear();
            projects.forEach((project) => written.set(project.id, project.updatedAt));

            return { state: { projects, deletedProjects: index.deletedProjects || [] } as S, version: 0 };
        },
        setItem: (_name, value) => {
            const next = value.state as CanvasPersistedState;
            if (queued && queued.projects === next.projects && (queued.deletedProjects ?? null) === (next.deletedProjects ?? null)) return;
            queued = next;
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => {
                timer = null;
                void flush();
            }, SAVE_DEBOUNCE_MS);
        },
        removeItem: async () => {
            // 清空索引即可；项目文件保留，避免误删用户数据。
            await writeWorkspaceCanvas({ projects: [], deletedProjects: [] });
            written.clear();
        },
    };
}
