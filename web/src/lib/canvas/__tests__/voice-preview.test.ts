import { afterEach, describe, expect, it, vi } from "vitest";

import { previewVoiceAudio, stopVoicePreview } from "../voice-preview";

/**
 * 最小 Audio 替身。
 *
 * 用替身而不是真 Audio：这几个用例要断言的正是"谁被 pause 了、src 有没有清"，
 * 真元素在 happy-dom 里既不出声也不给播放状态。
 */
class FakeAudio {
    static instances: FakeAudio[] = [];

    /** 构造时拿到的地址。`src` 会在停止时被清掉，要找原始值只能靠它。 */
    readonly createdWith: string;
    src = "";
    paused = true;
    preload = "";
    play = vi.fn(() => {
        this.paused = false;
        return Promise.resolve();
    });
    pause = vi.fn(() => {
        this.paused = true;
    });
    removeAttribute = vi.fn((name: string) => {
        if (name === "src") this.src = "";
    });

    constructor(src: string) {
        this.createdWith = src;
        this.src = src;
        FakeAudio.instances.push(this);
    }
}

function useAudio(factory: typeof FakeAudio = FakeAudio) {
    vi.stubGlobal("Audio", factory as unknown as typeof Audio);
}

afterEach(() => {
    stopVoicePreview();
    FakeAudio.instances = [];
    vi.unstubAllGlobals();
});

describe("音色试听", () => {
    it("换一个音色时掐掉上一个，并把它的缓冲释放掉", () => {
        useAudio();
        previewVoiceAudio("/voices/voice-01.mp3");
        previewVoiceAudio("/voices/voice-02.mp3");

        const [first, second] = FakeAudio.instances;
        expect(first.createdWith).toBe("/voices/voice-01.mp3");
        expect(second.createdWith).toBe("/voices/voice-02.mp3");
        expect(first.pause).toHaveBeenCalledTimes(1);
        // 只 pause 不清 src 的话，5MB 的音频会在后台继续缓冲完
        expect(first.removeAttribute).toHaveBeenCalledWith("src");
        expect(first.src).toBe("");
        expect(second.paused).toBe(false);
    });

    it("停止之后再停一次不出事，也不会去动已经放手的那一个", () => {
        useAudio();
        previewVoiceAudio("/voices/voice-01.mp3");
        stopVoicePreview();
        expect(() => stopVoicePreview()).not.toThrow();

        const [audio] = FakeAudio.instances;
        expect(audio.pause).toHaveBeenCalledTimes(1);
        expect(audio.paused).toBe(true);
    });

    it("播放被浏览器拦下时不留一个放不响的实例", async () => {
        class BlockedAudio extends FakeAudio {
            play = vi.fn(() => Promise.reject(new Error("NotAllowedError")));
        }
        useAudio(BlockedAudio);

        expect(() => previewVoiceAudio("/voices/voice-01.mp3")).not.toThrow();
        await Promise.resolve();
        await Promise.resolve();

        const [audio] = BlockedAudio.instances;
        // 被拒说明它在响的可能是零，不该继续占着"当前正在播"的位置
        stopVoicePreview();
        expect(audio.pause).not.toHaveBeenCalled();
    });
});
