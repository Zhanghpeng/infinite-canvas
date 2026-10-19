import { afterAll, describe, expect, it } from "vitest";

import { getStorage, setStorageBackend } from "@/lib/storage";
import { LocalFsBackend } from "@/lib/storage/local-fs-backend";
import { createLocalCanvasStorage, projectFile, readWorkspaceIndex } from "@/lib/storage/local-canvas-storage";

// 本地服务（local-workspace）的集成测试。
//
// 需要一个真实的 local-workspace 服务在跑，因此默认跳过，只有显式提供地址与 token 时才执行：
//
//   cd local-workspace && node index.js        # 另开一个终端，记下打印的 token
//   cd web && IC_LOCAL_SERVICE_URL=http://127.0.0.1:17400 IC_LOCAL_SERVICE_TOKEN=<token> \
//     npx vitest run src/lib/storage/__tests__/local-service.test.ts
//
// 不放进 vitest 的默认阻塞路径，是因为它依赖外部进程与真实文件系统，不适合每条 CI 都跑。

const BASE_URL = process.env.IC_LOCAL_SERVICE_URL || "";
const TOKEN = process.env.IC_LOCAL_SERVICE_TOKEN || "";
const enabled = Boolean(BASE_URL && TOKEN);

const RUN = `${Date.now().toString(36)}`;

async function readText(path: string) {
    const blob = await getStorage().readPath(path);
    return blob ? await blob.text() : null;
}

describe.skipIf(!enabled)("LocalFsBackend（需要本地服务）", () => {
    const backend = new LocalFsBackend(BASE_URL, TOKEN);

    it("能探测到本地服务", async () => {
        expect(await backend.isAvailable()).toBe(true);
    });

    it("错误 token 无法读写", async () => {
        const wrong = new LocalFsBackend(BASE_URL, `${TOKEN}-wrong`);
        // 探活（/health）按设计不鉴权，所以能通；真正的鉴权在读写时校验。
        expect(await wrong.isAvailable()).toBe(true);
        await expect(wrong.writePath(`.meta/logs/auth-${RUN}.json`, "{}")).rejects.toThrow();
        await expect(wrong.readPath(`.meta/logs/auth-${RUN}.json`)).rejects.toThrow();
    });

    it("JSON scope 读写与枚举", async () => {
        setStorageBackend(backend);
        const key = `probe-${RUN}`;
        await backend.set("app_state", key, { hello: "world" });
        expect(await backend.get("app_state", key)).toEqual({ hello: "world" });
        expect(await backend.keys("app_state")).toContain(key);
        await backend.remove("app_state", key);
        expect(await backend.get("app_state", key)).toBeNull();
    });

    it("项目作用域的 blob 落到 projects/<id>/assets/images", async () => {
        setStorageBackend(backend);
        const projectId = `p-${RUN}`;
        const key = `image:${projectId}:n1`;
        await backend.setBlob("image_files", key, new Blob(["fake-png"], { type: "image/png" }));

        const entries = await backend.listPath(`projects/${projectId}/assets/images`);
        expect(entries.some((entry) => !entry.directory)).toBe(true);

        const readBack = await backend.getBlob("image_files", key);
        expect(await readBack?.text()).toBe("fake-png");
        expect(readBack?.type).toBe("image/png");

        await backend.removeBlob("image_files", key);
        expect(await backend.getBlob("image_files", key)).toBeNull();
    });

    it("旧键（无项目段）仍落到全局目录", async () => {
        setStorageBackend(backend);
        const key = `image:legacy-${RUN}`;
        await backend.setBlob("image_files", key, new Blob(["legacy"], { type: "image/png" }));
        const entries = await backend.listPath("assets/images");
        expect(entries.some((entry) => !entry.directory)).toBe(true);
        expect(await (await backend.getBlob("image_files", key))?.text()).toBe("legacy");
        await backend.removeBlob("image_files", key);
    });

    it("画布持久化写成一项目一文件 + 工作区索引", async () => {
        setStorageBackend(backend);
        const storage = createLocalCanvasStorage();
        const project = { id: `proj-${RUN}`, title: "集成测试", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), nodes: [], connections: [], viewport: { x: 0, y: 0, scale: 1 } };

        await storage.setItem("canvas", { state: { projects: [project] }, version: 0 } as never);
        // setItem 有 400ms 去抖，等它落盘。
        await new Promise((resolve) => setTimeout(resolve, 900));

        const raw = await readText(projectFile(project.id));
        expect(raw).toContain("集成测试");
        expect((await readWorkspaceIndex())?.projects.some((item) => item.id === project.id)).toBe(true);

        const hydrated = await storage.getItem("canvas");
        expect(hydrated?.state.projects.map((item) => item.id)).toContain(project.id);

        await backend.deletePath(`projects/${project.id}`);
    });
});
