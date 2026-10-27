// 内容指纹：同一份字节永远得到同一个 id，用来给媒体文件命名。
//
// 为什么需要它：媒体键以前是 `<kind>:<nanoid>`，每次上传都换一个新名字 ——
// 同一张图先拖进画布、再收藏进资产库、再被另一个画布引用，磁盘上就是三份。
// 改成按内容命名之后，"写到同一个键"天然等价于"只存一份"。
//
// 采样策略（大文件不整份读进内存）：
//   · 小文件（≤ FULL_READ_LIMIT）整份算 —— 结果就是真正的 SHA-256
//   · 大文件取首/中/尾各 128KB。要撞上必须"大小完全相同 + 三段采样完全相同"，
//     偶然发生的概率可以忽略；而键里带了文件大小，大小不同的文件绝不会被并到一起。
//     代价是省掉了把几百 MB 视频读进 JS 堆的那一下 —— 这在 200MB 成片上很关键。

const SAMPLE_BYTES = 128 * 1024;
const FULL_READ_LIMIT = SAMPLE_BYTES * 4;

/** 指纹：`<size36>-<hash>`。带 size 前缀是硬约束 —— 它保证不同大小的文件绝不共用键。 */
export type ContentFingerprint = string;

export async function fingerprintBlob(blob: Blob): Promise<ContentFingerprint> {
    const bytes = await sampleBytes(blob);
    const hash = await hashBytes(bytes);
    return `${blob.size.toString(36)}-${hash}`;
}

async function sampleBytes(blob: Blob): Promise<Uint8Array> {
    if (blob.size <= FULL_READ_LIMIT) return new Uint8Array(await blob.arrayBuffer());
    const head = new Uint8Array(await blob.slice(0, SAMPLE_BYTES).arrayBuffer());
    const middle = new Uint8Array(await blob.slice(Math.floor(blob.size / 2), Math.floor(blob.size / 2) + SAMPLE_BYTES).arrayBuffer());
    const tail = new Uint8Array(await blob.slice(blob.size - SAMPLE_BYTES).arrayBuffer());
    const merged = new Uint8Array(head.length + middle.length + tail.length);
    merged.set(head, 0);
    merged.set(middle, head.length);
    merged.set(tail, head.length + middle.length);
    return merged;
}

async function hashBytes(bytes: Uint8Array): Promise<string> {
    const subtle = globalThis.crypto?.subtle;
    if (subtle) {
        try {
            const digest = await subtle.digest("SHA-256", toArrayBuffer(bytes));
            return toHex(new Uint8Array(digest)).slice(0, 32);
        } catch {
            // 非安全上下文（http 局域网访问）下 subtle 存在但会抛：退回下面的纯 JS 实现。
        }
    }
    return fnv128(bytes);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
    // 只有裁剪过的视图才需要复制：subtle.digest 不接受带 offset 的视图。
    if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) return bytes.buffer as ArrayBuffer;
    return bytes.slice().buffer as ArrayBuffer;
}

function toHex(bytes: Uint8Array) {
    let out = "";
    for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
    return out;
}

// SHA-256 拿不到时的兜底：四路 FNV-1a（不同偏移基）拼成 128 位。
// 强度不如 SHA-256，但用于"同一份文件必须同名"足够 —— 它只需要抗偶发碰撞。
function fnv128(bytes: Uint8Array) {
    const seeds = [0x811c9dc5, 0x01000193, 0x9e3779b9, 0x85ebca6b];
    return seeds.map((seed) => {
        let hash = seed >>> 0;
        for (let index = 0; index < bytes.length; index += 1) {
            hash ^= bytes[index];
            hash = Math.imul(hash, 0x01000193) >>> 0;
        }
        return hash.toString(16).padStart(8, "0");
    }).join("");
}
