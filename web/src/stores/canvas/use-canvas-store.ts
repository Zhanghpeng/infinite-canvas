import { create } from "zustand";
import { persist, type PersistStorage, type StorageValue } from "zustand/middleware";

import { nanoid } from "nanoid";
import i18n from "@/i18n";
import { getStorage } from "@/lib/storage";
import { createLocalCanvasStorage } from "@/lib/storage/local-canvas-storage";
import { localForageStorage } from "@/lib/localforage-storage";
import type { CanvasBackgroundMode } from "@/lib/canvas-theme";
import type { CanvasAssistantSession, CanvasConnection, CanvasNodeData, ViewportTransform } from "@/types/canvas";

export type CanvasProject = {
    id: string;
    title: string;
    createdAt: string;
    updatedAt: string;
    nodes: CanvasNodeData[];
    connections: CanvasConnection[];
    chatSessions: CanvasAssistantSession[];
    activeChatId: string | null;
    backgroundMode: CanvasBackgroundMode;
    showImageInfo: boolean;
    viewport: ViewportTransform;
    // 仅本地存储 v2 的「骨架」会带这两个字段：索引里只有元数据，图还没从磁盘读出来。
    // lazy=true 的项目绝不写 graph，否则会把空节点覆盖掉磁盘上的真实画布。
    lazy?: boolean;
    // 列表页要显示节点数，但不想为了这个数字把整幅画布读出来，所以索引里带一份计数。
    nodeCount?: number;
    connectionCount?: number;
};

type CanvasStore = {
    hydrated: boolean;
    projects: CanvasProject[];
    createProject: (title?: string) => string;
    importProject: (project: Partial<CanvasProject>) => string;
    openProject: (id: string) => CanvasProject | null;
    renameProject: (id: string, title: string) => void;
    deleteProjects: (ids: string[]) => void;
    replaceProjects: (projects: CanvasProject[]) => void;
    setProjectGraph: (id: string, graph: Pick<CanvasProject, "nodes" | "connections" | "chatSessions">) => void;
    updateProject: (id: string, patch: Partial<Pick<CanvasProject, "nodes" | "connections" | "chatSessions" | "activeChatId" | "backgroundMode" | "showImageInfo" | "viewport">>) => void;
};

const initialViewport: ViewportTransform = { x: 0, y: 0, k: 1 };
const CANVAS_STORE_KEY = "infinite-canvas:canvas_store";
type PersistedCanvasState = Pick<CanvasStore, "projects">;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let queuedPersistState: PersistedCanvasState | null = null;

const canvasStorage: PersistStorage<CanvasStore> = {
    getItem: async (name) => {
        const value = await localForageStorage.getItem(name);
        if (!value) return null;
        const parsed = JSON.parse(value) as StorageValue<CanvasStore>;
        queuedPersistState = parsed.state as PersistedCanvasState;
        return parsed;
    },
    setItem: (name, value) => {
        const nextState = value.state as PersistedCanvasState;
        if (queuedPersistState && queuedPersistState.projects === nextState.projects) return;
        queuedPersistState = nextState;
        if (saveTimer) clearTimeout(saveTimer);
        saveTimer = setTimeout(() => {
            saveTimer = null;
            void localForageStorage.setItem(name, JSON.stringify(value));
        }, 400);
    },
    removeItem: (name) => localForageStorage.removeItem(name),
};

export const useCanvasStore = create<CanvasStore>()(
    persist(
        (set, get) => ({
            hydrated: false,
            projects: [],
            createProject: (title = i18n.t("canvas.project.untitled")) => {
                const now = new Date().toISOString();
                const id = nanoid();
                const project: CanvasProject = {
                    id,
                    title,
                    createdAt: now,
                    updatedAt: now,
                    nodes: [],
                    connections: [],
                    chatSessions: [],
                    activeChatId: null,
                    backgroundMode: "lines",
                    showImageInfo: false,
                    viewport: initialViewport,
                };
                set((state) => ({ projects: [project, ...state.projects] }));
                return id;
            },
            importProject: (source) => {
                const now = new Date().toISOString();
                const project: CanvasProject = {
                    id: nanoid(),
                    title: source.title || i18n.t("canvas.project.imported"),
                    createdAt: source.createdAt || now,
                    updatedAt: now,
                    nodes: source.nodes || [],
                    connections: source.connections || [],
                    chatSessions: source.chatSessions || [],
                    activeChatId: source.activeChatId || null,
                    backgroundMode: source.backgroundMode || "lines",
                    showImageInfo: source.showImageInfo || false,
                    viewport: source.viewport || initialViewport,
                };
                set((state) => ({ projects: [project, ...state.projects] }));
                return project.id;
            },
            openProject: (id) => {
                return get().projects.find((item) => item.id === id) || null;
            },
            renameProject: (id, title) =>
                set((state) => ({
                    projects: state.projects.map((project) => (project.id === id ? { ...project, title: title.trim() || project.title, updatedAt: new Date().toISOString() } : project)),
                })),
            deleteProjects: (ids) =>
                set((state) => {
                    const projects = state.projects.filter((project) => !ids.includes(project.id));
                    return { projects };
                }),
            replaceProjects: (projects) => set({ projects }),
            // 图从磁盘读到之后调用：补全 nodes/connections/chatSessions 并摘掉 lazy。
            // 引用必须原样塞进来（不要 deep clone），落盘侧靠引用比较判断"图有没有变"。
            setProjectGraph: (id, graph) =>
                set((state) => ({
                    projects: state.projects.map((project) =>
                        project.id === id ? { ...project, ...graph, lazy: false, nodeCount: graph.nodes.length, connectionCount: graph.connections.length } : project,
                    ),
                })),
            updateProject: (id, patch) =>
                set((state) => ({
                    projects: state.projects.map((project) => {
                        if (project.id !== id) return project;
                        const next: CanvasProject = { ...project, ...patch, updatedAt: new Date().toISOString() };
                        // 计数跟着图走：列表页只读索引，靠这里保持数字与画布一致。
                        if (patch.nodes) next.nodeCount = patch.nodes.length;
                        if (patch.connections) next.connectionCount = patch.connections.length;
                        return next;
                    }),
                })),
        }),
        {
            name: CANVAS_STORE_KEY,
            // 浏览器模式沿用原有整包持久化；本地模式走新增的「一项目一文件」分支。
            // 后端在 main.tsx 启动阶段就已定型，故此处可同步判定。
            storage: getStorage().kind === "local" ? createLocalCanvasStorage<CanvasStore>() : canvasStorage,
            partialize: (state) =>
                ({
                    projects: state.projects,
                }) as StorageValue<CanvasStore>["state"],
            onRehydrateStorage: () => () => {
                useCanvasStore.setState({ hydrated: true });
            },
        },
    ),
);
