import { describe, expect, it } from "vitest";

import { fingerprintBlob } from "@/lib/storage/content-fingerprint";

function makeBlob(size: number, patch?: { at: number; byte: number }) {
    const bytes = new Uint8Array(size);
    // 用可预测的填充，方便定位"只改中间一个字节"这类场景。
    for (let index = 0; index < size; index += 1) bytes[index] = index % 251;
    if (patch) bytes[patch.at] = patch.byte;
    return new Blob([bytes], { type: "image/png" });
}

describe("内容指纹", () => {
    it("同一份内容无论包成几个 Blob 都是同一个指纹", async () => {
        const a = makeBlob(64 * 1024);
        const b = makeBlob(64 * 1024);
        expect(await fingerprintBlob(a)).toBe(await fingerprintBlob(b));
    });

    it("指纹带着大小，大小不同一定不同", async () => {
        const small = await fingerprintBlob(makeBlob(1024));
        const large = await fingerprintBlob(makeBlob(2048));
        expect(small).not.toBe(large);
        expect(small.startsWith(`${(1024).toString(36)}-`)).toBe(true);
    });

    it("小文件整份参与哈希：任意一个字节不同就不同", async () => {
        const base = makeBlob(64 * 1024);
        const changed = makeBlob(64 * 1024, { at: 30_000, byte: 0xff });
        expect(await fingerprintBlob(base)).not.toBe(await fingerprintBlob(changed));
    });

    it("大文件取首/中/尾三段：这三处的差异都能分辨", async () => {
        const size = 1024 * 1024;
        const base = makeBlob(size);
        const baseline = await fingerprintBlob(base);
        // 头、中、尾各改一个字节，都要能区分出来。
        for (const at of [10, Math.floor(size / 2), size - 10]) {
            expect(await fingerprintBlob(makeBlob(size, { at, byte: 0xfe }))).not.toBe(baseline);
        }
    });

    it("采样是明确的取舍：落在采样区之外的差异不会改变指纹", async () => {
        // 这是刻意的：几百 MB 的成片不整份读进内存。真要整份哈希，就把 FULL_READ_LIMIT 调大。
        const size = 1024 * 1024;
        const baseline = await fingerprintBlob(makeBlob(size));
        // 256KB 处落在 head(0–128KB) 与 middle(512KB–640KB) 之间。
        expect(await fingerprintBlob(makeBlob(size, { at: 256 * 1024, byte: 0xfe }))).toBe(baseline);
    });
});
