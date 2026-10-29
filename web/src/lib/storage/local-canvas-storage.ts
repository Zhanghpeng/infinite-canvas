import type { PersistStorage, StorageValue } from "zustand/middleware";

import { getStorage } from "@/lib/storage";
import type { CanvasProject } from "@/stores/canvas/use-canvas-store";

// 主干（main）的画布 store 没有回收站；这里本地声明，仅用于兼容工作区索引里可能存在的墓碑数据。
export type CanvasDeletedProject = { id: string; deletedAt: string };

// 本地模式下的画布持久化实现（新增分支，不影响浏览器模式）。
//
// 与浏览器模式的唯一区别是落点：
//   浏览器模式：整个 projects[] 以 JSON 字符串写进 IndexedDB 的一个 key（原逻辑，保持不动）
//   本地模式：  索引（workspace.json）+ 每个项目一个图文件（projects/<id>/graph.json）
//
// 事务全部经由 getStorage()（存储抽象层），因此本地目录(FSA) 与本地服务两种后端都能用。
//
// ── 为什么拆成「索引 + 图」两层（v2）──
// 以前是一个项目一个 project.json，启动时要把**所有**项目的节点、连线、会话一次性读出来并解析。
// 项目一多就是几十上百次读盘 + 全量 JSON.parse，而首屏只需要标题和节点数。
// 拆开之后：
//   · 启动：只读 workspace.json 一个文件（每项目一条元数据，几十字节）
//   · 打开项目：只读该项目自己的 graph.json
//   · 平移/缩放/改标题：只重写 workspace.json，不再重写整幅画布
// 未读取过的项目在内存里带 lazy 标记，落盘时被显式跳过，避免用空图覆盖磁盘上的真数据。

export const PROJECTS_DIR = "projects";
export const WORKSPACE_INDEX_FILE = "workspace.json";
export const PROJECT_BACKUP_DIR = ".meta/backups/projects";
const SAVE_DEBOUNCE_MS = 400;
// v1：workspace.json 只记 id/title/updatedAt，画布数据在 projects/<id>/project.json
// v2：workspace.json 记全部元数据，画布数据在 projects/<id>/graph.json
const INDEX_VERSION = 2;

export type CanvasPersistedState = { projects: CanvasProject[]; deletedProjects?: CanvasDeletedProject[] };

export type ProjectGraph = Pick<CanvasProject, "nodes" | "connections" | "chatSessions">;

export type WorkspaceProjectMeta = {
    id: string;
    title: string;
    createdAt: string;
    updatedAt: string;
    backgroundMode?: CanvasProject["backgroundMode"];
    showImageInfo?: boolean;
    activeChatId?: string | null;
    viewport?: CanvasProject["viewport"];
    nodeCount?: number;
    connectionCount?: number;
};

export type WorkspaceIndex = {
    app: string;
    version: number;
    createdAt: string;
    updatedAt: string;
    name?: string;
    projects: WorkspaceProjectMeta[];
    deletedProjects?: CanvasDeletedProject[];
};

export function projectDir(id: string) {
    return `${PROJECTS_DIR}/${id}`;
}

/** v1 的单文件格式。仅用于兼容读取，不再写入。 */
export function projectFile(id: string) {
    return `${projectDir(id)}/project.json`;
}

/** v2 的图文件：只有 nodes/connections/chatSessions。 */
export function graphFile(id: string) {
    return `${projectDir(id)}/graph.json`;
}

async function readJson<T>(path: string): Promise<T | null> {
    const blob = await getStorage().readPath(path);
    if (!blob) return null;
    return JSON.parse(await blob.text()) as T;
}

export async function readWorkspaceIndex(): Promise<WorkspaceIndex | null> {
    return await readJson<WorkspaceIndex>(WORKSPACE_INDEX_FILE);
}

/** 兼容 v1：整份 CanvasProject 的读取入口保留，供旧数据回退使用。 */
export async function readWorkspaceProject(id: string): Promise<CanvasProject | null> {
    try {
        return await readJson<CanvasProject>(projectFile(id));
    } catch {
        return null;
    }
}

// 已确认落盘（或已从磁盘读到）的图快照，用于判断"这一轮到底有没有改图"。
// 只做引用比较：store 里 nodes/connections/chatSessions 任一被替换才会产生新对象，
// 而改 viewport、改标题都只换外层 project 对象，内层引用不变。
const graphStates = new Map<string, ProjectGraph>();

function normalizeGraph(source: Partial<ProjectGraph> | null | undefined): ProjectGraph {
    return {
        nodes: Array.isArray(source?.nodes) ? source.nodes : [],
        connections: Array.isArray(source?.connections) ? source.connections : [],
        chatSessions: Array.isArray(source?.chatSessions) ? source.chatSessions : [],
    };
}

function sameGraph(left: ProjectGraph | undefined, right: ProjectGraph) {
    return Boolean(left) && left!.nodes === right.nodes && left!.connections === right.connections && left!.chatSessions === right.chatSessions;
}

/**
 * 读取某个项目的图数据（节点/连线/会话）。
 *
 * 优先 v2 的 graph.json；没有则回退 v1 的单文件。返回的图对象会被记入内部快照，
 * 调用方应把它**直接**塞回 store（保持引用一致），这样紧接着的一轮保存不会误判成"图变了"。
 */
export async function readProjectGraph(id: string): Promise<ProjectGraph | null> {
    try {
        const graph = await readJson<Partial<ProjectGraph>>(graphFile(id));
        if (graph) {
            const normalized = normalizeGraph(graph);
            graphStates.set(id, normalized);
            return normalized;
        }
        const legacy = await readWorkspaceProject(id);
        if (!legacy) return null;
        const normalized = normalizeGraph(legacy);
        graphStates.set(id, normalized);
        return normalized;
    } catch {
        return null;
    }
}

/** 把一批项目里还没加载图的那些补全（导出、同步等需要完整数据的一次性场景）。 */
export async function ensureProjectGraphs<T extends { id: string; lazy?: boolean; nodes?: unknown[]; connections?: unknown[]; chatSessions?: unknown[] }>(projects: T[]): Promise<T[]> {
    if (!projects.some((project) => project.lazy)) return projects;
    return await Promise.all(
        projects.map(async (project) => {
            if (!project.lazy) return project;
            const graph = await readProjectGraph(project.id);
            // 读不出来就维持 lazy：把空图标成"已加载"，下游（例如媒体清理）会当成该项目真的没有节点，
            // 从而把它的图片全判为未引用 —— 宁可让调用方知道"这份数据还没到手"。
            if (!graph) return project;
            return { ...project, ...graph, lazy: false };
        }),
    );
}

function toMeta(project: CanvasProject): WorkspaceProjectMeta {
    // lazy 项目的 nodes 是空骨架，节点数只能沿用索引里已有的值，否则一保存就被抹成 0。
    const nodeCount = project.lazy ? (project.nodeCount ?? 0) : project.nodes.length;
    const connectionCount = project.lazy ? (project.connectionCount ?? 0) : project.connections.length;
    return {
        id: project.id,
        title: project.title,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
        backgroundMode: project.backgroundMode,
        showImageInfo: project.showImageInfo,
        activeChatId: project.activeChatId,
        viewport: project.viewport,
        nodeCount,
        connectionCount,
    };
}

function fromMeta(meta: WorkspaceProjectMeta): CanvasProject {
    // 图未加载：只给骨架，lazy 让落盘逻辑跳过它，避免用空数组覆盖磁盘上的真数据。
    return {
        id: meta.id,
        title: meta.title,
        createdAt: meta.createdAt,
        updatedAt: meta.updatedAt,
        nodes: [],
        connections: [],
        chatSessions: [],
        activeChatId: meta.activeChatId ?? null,
        backgroundMode: meta.backgroundMode ?? "lines",
        showImageInfo: meta.showImageInfo ?? false,
        viewport: meta.viewport ?? { x: 0, y: 0, k: 1 },
        lazy: true,
        nodeCount: meta.nodeCount ?? 0,
        connectionCount: meta.connectionCount ?? 0,
    };
}

function buildIndex(state: CanvasPersistedState, previous: WorkspaceIndex | null): WorkspaceIndex {
    const now = new Date().toISOString();
    return {
        app: "infinite-canvas",
        version: INDEX_VERSION,
        createdAt: previous?.createdAt || now,
        updatedAt: now,
        name: previous?.name,
        projects: state.projects.map(toMeta),
        deletedProjects: state.deletedProjects ?? [],
    };
}

/**
 * 落盘。
 *
 * incremental=true（persist 热路径）：只写「图确实变了」的项目；
 *   图没变（例如只是平移画布、改标题、改视口）就只重写 workspace.json —— 后者每个项目只有几十字节。
 * incremental=false（迁移等一次性场景）：所有项目都重写。
 */
export async function writeWorkspaceCanvas(state: CanvasPersistedState, options?: { incremental?: boolean; previous?: WorkspaceIndex | null }): Promise<WorkspaceIndex> {
    const backend = getStorage();
    const incremental = options?.incremental ?? false;
    const previous = options?.previous !== undefined ? options.previous : await readWorkspaceIndex();

    const alive = new Set<string>();
    for (const project of state.projects) {
        alive.add(project.id);
        // 图未从磁盘读过：磁盘上的 graph.json 才是准的，这里绝不能写。
        if (project.lazy) continue;
        const graph: ProjectGraph = { nodes: project.nodes, connections: project.connections, chatSessions: project.chatSessions };
        if (incremental && sameGraph(graphStates.get(project.id), graph)) continue;
        await backend.writePath(graphFile(project.id), JSON.stringify(graph));
        graphStates.set(project.id, graph);
    }

    // 删除只认墓碑：项目从 state 消失且带 deletedAt，才把目录移到备份区（可恢复，不直接删）。
    const deleted = new Set((state.deletedProjects ?? []).map((item) => item.id));
    for (const id of Array.from(graphStates.keys())) {
        if (alive.has(id) || !deleted.has(id)) continue;
        await backend.movePath(projectDir(id), `${PROJECT_BACKUP_DIR}/${id}-${Date.now()}`);
        graphStates.delete(id);
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
    let queued: CanvasPersistedState | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // 索引的原值（createdAt/name 要沿用），避免每次落盘都读一遍。
    let indexCache: WorkspaceIndex | null = null;
    let indexLoaded = false;

    async function loadIndex(): Promise<WorkspaceIndex | null> {
        if (indexLoaded) return indexCache;
        indexCache = await readWorkspaceIndex();
        indexLoaded = true;
        return indexCache;
    }

    async function flush() {
        if (!queued) return;
        const state = queued;
        queued = null;
        indexCache = await writeWorkspaceCanvas(state, { incremental: true, previous: await loadIndex() });
    }

    return {
        getItem: async (): Promise<StorageValue<S> | null> => {
            const index = await readWorkspaceIndex();
            indexCache = index;
            indexLoaded = true;
            if (!index) return null;
            if (index.app !== "infinite-canvas") throw new Error("不是有效的工作区目录");
            if (index.version > INDEX_VERSION) throw new Error(`工作区版本 ${index.version} 高于当前应用支持的版本，已中止读取`);

            if (index.version >= INDEX_VERSION) {
                // 快路径：只有元数据，一个文件搞定。图等打开项目时再读。
                graphStates.clear();
                return { state: { projects: index.projects.map(fromMeta), deletedProjects: index.deletedProjects || [] } as S, version: 0 };
            }

            // v1 升级：此时索引里没有元数据，只能把每个 project.json 读一遍。
            // 读完全量后立刻按 v2 重写一份，下一次启动就走快路径了。
            const projects = (await Promise.all((index.projects || []).map((item) => readWorkspaceProject(item.id)))).filter((project): project is CanvasProject => Boolean(project));
            projects.forEach((project) => graphStates.set(project.id, { nodes: project.nodes, connections: project.connections, chatSessions: project.chatSessions }));
            const migrated: CanvasPersistedState = { projects, deletedProjects: index.deletedProjects || [] };
            void writeWorkspaceCanvas(migrated, { previous: index })
                .then((next) => {
                    indexCache = next;
                })
                .catch(() => undefined);
            return { state: migrated as S, version: 0 };
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
            graphStates.clear();
        },
    };
}
