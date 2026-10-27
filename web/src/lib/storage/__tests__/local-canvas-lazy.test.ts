import { afterEach, describe, expect, it } from "vitest";

import { setStorageBackend } from "@/lib/storage";
import type { StorageBackend, StorageEntry, StorageScope } from "@/lib/storage/types";
import { createLocalCanvasStorage, ensureProjectGraphs, graphFile, projectFile, readProjectGraph, readWorkspaceIndex, readWorkspaceProject } from "@/lib/storage/local-canvas-storage";
import type { CanvasProject } from "@/stores/canvas/use-canvas-store";

// 本地画布存储 v2（索引 + 图文件）的行为约束。
//
// 这里用内存后端而不是真实本地服务：要验证的重点是「读了什么、写了什么」，
// 用写入记录来断言比看磁盘更直接，也不依赖外部进程。

type Writes = { graph: string[]; index: number; legacy: number };

function createMemoryBackend() {
    const files = new Map<string, string>();
    const writes: Writes = { graph: [], index: 0, legacy: 0 };

    const backend: StorageBackend = {
        kind: "local",
        async isAvailable() {
            return true;
        },
        async get<T>(scope: StorageScope, key: string) {
            const raw = files.get(`${scope}/${key}`);
            return raw ? (JSON.parse(raw) as T) : null;
        },
        async set(scope, key, value) {
            files.set(`${scope}/${key}`, JSON.stringify(value));
        },
        async remove(scope, key) {
            files.delete(`${scope}/${key}`);
        },
        async clear(scope) {
            Array.from(files.keys()).forEach((path) => path.startsWith(`${scope}/`) && files.delete(path));
        },
        async entries<T>(scope: StorageScope): Promise<Array<StorageEntry<T>>> {
            return Array.from(files.entries())
                .filter(([path]) => path.startsWith(`${scope}/`))
                .map(([path, raw]) => ({ key: path.slice(scope.length + 1), value: JSON.parse(raw) as T }));
        },
        async keys(scope) {
            return Array.from(files.keys())
                .filter((path) => path.startsWith(`${scope}/`))
                .map((path) => path.slice(scope.length + 1));
        },
        async getBlob() {
            return null;
        },
        async setBlob() {
            // 这个用例不涉及二进制。
        },
        async removeBlob() {
            // 同上。
        },
        async readPath(path) {
            const raw = files.get(path);
            return raw === undefined ? null : new Blob([raw]);
        },
        async writePath(path, data) {
            const text = typeof data === "string" ? data : await data.text();
            files.set(path, text);
            if (path.endsWith("/graph.json")) writes.graph.push(path);
            else if (path.endsWith("workspace.json")) writes.index += 1;
            else if (path.endsWith("/project.json")) writes.legacy += 1;
        },
        async deletePath(path) {
            files.delete(path);
        },
        async listPath(dir) {
            const prefix = `${dir}/`;
            return Array.from(files.keys())
                .filter((path) => path.startsWith(prefix))
                .map((path) => ({ path: path.slice(prefix.length), directory: false }));
        },
        async movePath(from, to) {
            Array.from(files.keys())
                .filter((path) => path === from || path.startsWith(`${from}/`))
                .forEach((path) => {
                    const raw = files.get(path)!;
                    files.delete(path);
                    files.set(`${to}${path.slice(from.length)}`, raw);
                });
        },
    };

    return { backend, files, writes };
}

function makeProject(id: string, nodeCount = 2): CanvasProject {
    const now = new Date().toISOString();
    return {
        id,
        title: `项目 ${id}`,
        createdAt: now,
        updatedAt: now,
        nodes: Array.from({ length: nodeCount }, (_, index) => ({ id: `${id}-n${index}`, type: "text", x: 0, y: 0, width: 100, height: 100, metadata: {} })) as unknown as CanvasProject["nodes"],
        connections: [],
        chatSessions: [],
        activeChatId: null,
        backgroundMode: "lines" as CanvasProject["backgroundMode"],
        showImageInfo: false,
        viewport: { x: 0, y: 0, k: 1 },
    };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 700));

describe("本地画布存储 v2", () => {
    afterEach(() => {
        // 每个用例自己 setStorageBackend，这里不重置，避免影响其它用例的默认后端断言。
    });

    it("落盘拆成 workspace.json + projects/<id>/graph.json，不再写 project.json", async () => {
        const { backend, files, writes } = createMemoryBackend();
        setStorageBackend(backend);
        const storage = createLocalCanvasStorage();
        const project = makeProject("p1");

        await storage.setItem("canvas", { state: { projects: [project] }, version: 0 } as never);
        await settle();

        expect(files.has(graphFile("p1"))).toBe(true);
        expect(files.has(projectFile("p1"))).toBe(false);
        expect(writes.legacy).toBe(0);
        const index = await readWorkspaceIndex();
        expect(index?.version).toBe(2);
        // 索引里带着列表页要用的元数据，启动时不必再读图。
        expect(index?.projects[0]).toMatchObject({ id: "p1", nodeCount: 2, connectionCount: 0 });
    });

    it("启动只读索引：项目带 lazy 标记、图为空、计数取自索引", async () => {
        const { backend, files } = createMemoryBackend();
        setStorageBackend(backend);
        await files.set(
            "workspace.json",
            JSON.stringify({
                app: "infinite-canvas",
                version: 2,
                createdAt: "t0",
                updatedAt: "t0",
                projects: [{ id: "p1", title: "已有项目", createdAt: "t0", updatedAt: "t1", nodeCount: 7, connectionCount: 3 }],
                deletedProjects: [],
            }),
        );
        const storage = createLocalCanvasStorage();
        const restored = await storage.getItem("canvas");
        const project = restored?.state.projects[0] as CanvasProject;
        expect(project.lazy).toBe(true);
        expect(project.nodes).toEqual([]);
        expect(project.nodeCount).toBe(7);
        expect(project.connectionCount).toBe(3);
    });

    it("打开项目时才读图，读到的对象直接可用", async () => {
        const { backend, files } = createMemoryBackend();
        setStorageBackend(backend);
        const project = makeProject("p1", 3);
        await files.set(graphFile("p1"), JSON.stringify({ nodes: project.nodes, connections: [], chatSessions: [] }));

        const graph = await readProjectGraph("p1");
        expect(graph?.nodes).toHaveLength(3);
    });

    it("lazy 项目落盘时绝不用空图覆盖磁盘上的真数据", async () => {
        const { backend, files, writes } = createMemoryBackend();
        setStorageBackend(backend);
        const project = makeProject("p1", 4);
        await files.set(graphFile("p1"), JSON.stringify({ nodes: project.nodes, connections: [], chatSessions: [] }));
        await files.set(
            "workspace.json",
            JSON.stringify({
                app: "infinite-canvas",
                version: 2,
                createdAt: "t0",
                updatedAt: "t0",
                projects: [{ id: "p1", title: "旧标题", createdAt: "t0", updatedAt: "t1", nodeCount: 4, connectionCount: 0 }],
                deletedProjects: [],
            }),
        );

        const storage = createLocalCanvasStorage();
        const restored = await storage.getItem("canvas");
        const skeleton = restored!.state.projects[0] as CanvasProject;
        // 只改标题（图仍未加载）。
        await storage.setItem("canvas", { state: { projects: [{ ...skeleton, title: "新标题" }] }, version: 0 } as never);
        await settle();

        expect(writes.graph).toEqual([]);
        const onDisk = JSON.parse(files.get(graphFile("p1"))!);
        expect(onDisk.nodes).toHaveLength(4);
        expect((await readWorkspaceIndex())?.projects[0]).toMatchObject({ title: "新标题", nodeCount: 4 });
    });

    it("只改视口不重写图文件", async () => {
        const { backend, writes } = createMemoryBackend();
        setStorageBackend(backend);
        const storage = createLocalCanvasStorage();
        const project = makeProject("p1");

        await storage.setItem("canvas", { state: { projects: [project] }, version: 0 } as never);
        await settle();
        expect(writes.graph).toHaveLength(1);

        // 视口变了，但 nodes/connections/chatSessions 还是同一份引用。
        const moved = { ...project, viewport: { x: 120, y: -40, k: 0.8 } };
        await storage.setItem("canvas", { state: { projects: [moved] }, version: 0 } as never);
        await settle();

        expect(writes.graph).toHaveLength(1);
        expect(writes.index).toBe(2);
        const index = await readWorkspaceIndex();
        expect(index?.projects[0]?.viewport).toEqual({ x: 120, y: -40, k: 0.8 });
    });

    it("图真的变了才重写图文件", async () => {
        const { backend, writes } = createMemoryBackend();
        setStorageBackend(backend);
        const storage = createLocalCanvasStorage();
        const project = makeProject("p1");

        await storage.setItem("canvas", { state: { projects: [project] }, version: 0 } as never);
        await settle();

        const edited = { ...project, nodes: [...project.nodes, ...makeProject("p1").nodes] };
        await storage.setItem("canvas", { state: { projects: [edited] }, version: 0 } as never);
        await settle();

        expect(writes.graph).toHaveLength(2);
    });

    it("ensureProjectGraphs 把未加载的图补齐（导出/同步用）", async () => {
        const { backend, files } = createMemoryBackend();
        setStorageBackend(backend);
        const project = makeProject("p1", 5);
        await files.set(graphFile("p1"), JSON.stringify({ nodes: project.nodes, connections: [], chatSessions: [] }));
        const skeleton = { ...project, nodes: [], lazy: true, nodeCount: 5 };

        const [filled] = await ensureProjectGraphs([skeleton]);
        expect(filled.lazy).toBe(false);
        expect(filled.nodes).toHaveLength(5);
    });

    it("v1 索引能读旧 project.json 并升级到 v2", async () => {
        const { backend, files } = createMemoryBackend();
        setStorageBackend(backend);
        const legacy = makeProject("p1", 2);
        await files.set(projectFile("p1"), JSON.stringify(legacy));
        await files.set(
            "workspace.json",
            JSON.stringify({ app: "infinite-canvas", version: 1, createdAt: "t0", updatedAt: "t0", projects: [{ id: "p1", title: legacy.title, updatedAt: legacy.updatedAt }], deletedProjects: [] }),
        );

        const storage = createLocalCanvasStorage();
        const restored = await storage.getItem("canvas");
        expect((restored!.state.projects[0] as CanvasProject).nodes).toHaveLength(2);

        // 升级是异步的，等它写完再把索引读回来确认版本已经抬到 2。
        await settle();
        expect((await readWorkspaceIndex())?.version).toBe(2);
        expect(files.has(graphFile("p1"))).toBe(true);
        // 旧文件保留，不做破坏性删除。
        expect((await readWorkspaceProject("p1"))?.nodes).toHaveLength(2);
    });
});
