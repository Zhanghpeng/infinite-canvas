import { describe, expect, it } from "vitest";

import { createBlobStore } from "@/lib/storage/blob-store";
import type { PathIo } from "@/lib/storage/path-io";
import { projectIdFromKey, scopeDirForKey } from "@/lib/storage/storage-layout";

// 画布（项目）产出的素材必须跟着项目目录走，同时旧的"全局"键保持原目录（零迁移）。

describe("project-scoped storage keys", () => {
    it("recognises the project segment only on three-segment keys", () => {
        expect(projectIdFromKey("image:p1:abc")).toBe("p1");
        expect(projectIdFromKey("video:p2:abc")).toBe("p2");
        expect(projectIdFromKey("image:abc")).toBe(""); // 旧键：工作区全局
        expect(projectIdFromKey("image")).toBe("");
    });

    it("derives per-project directories for canvas assets", () => {
        expect(scopeDirForKey("image_files", "image:p1:abc")).toBe("projects/p1/assets/images");
        expect(scopeDirForKey("media_files", "video:p1:abc")).toBe("projects/p1/assets/media");
        expect(scopeDirForKey("media_files", "audio:p1:abc")).toBe("projects/p1/assets/media");
        // 旧键仍落工作区全局目录
        expect(scopeDirForKey("image_files", "image:abc")).toBe("assets/images");
        expect(scopeDirForKey("media_files", "video:abc")).toBe("assets/media");
        // 非二进制 scope 不受影响
        expect(scopeDirForKey("image_logs", "image:p1:abc")).toBe(".meta/logs/image");
    });

    it("writes project assets into the project directory and reads them back", async () => {
        const files = new Map<string, Blob>();
        const io: PathIo = {
            read: async (path) => files.get(path) ?? null,
            write: async (path, data) => void files.set(path, data instanceof Blob ? data : new Blob([data])),
            remove: async (path) => void files.delete(path),
            list: async (dir) => [...files.keys()].filter((p) => p.startsWith(`${dir}/`)).map((p) => ({ path: p.slice(dir.length + 1), directory: false })),
            move: async (from, to) => {
                const blob = files.get(from);
                if (blob) {
                    files.delete(from);
                    files.set(to, blob);
                }
            },
        };
        const store = createBlobStore(io);
        const blob = new Blob(["png"], { type: "image/png" });

        await store.setBlob("image_files", "image:p1:aaa", blob);
        expect([...files.keys()]).toEqual(["projects/p1/assets/images/image%3ap1%3aaaa.png"]);

        await store.setBlob("image_files", "image:legacy", blob);
        expect([...files.keys()]).toContain("assets/images/image%3alegacy.png");

        await expect(store.getBlob("image_files", "image:p1:aaa")).resolves.toBeTruthy();
        await expect(store.getBlob("image_files", "image:legacy")).resolves.toBeTruthy();

        await store.removeBlob("image_files", "image:p1:aaa");
        expect([...files.keys()]).toEqual(["assets/images/image%3alegacy.png"]);
    });
});
