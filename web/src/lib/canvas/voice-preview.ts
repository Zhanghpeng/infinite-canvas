/**
 * 音色试听只留一个声音。
 *
 * 卡片是两列网格，选音色的真实动作是「点开听、不满意、换一个再听」，连着点三四张很常见。
 * 每张卡各自持一个 `<audio>` 的话，声音会叠在一起，反而听不出音色差别。
 *
 * 状态由模块持有而不是组件：弹层可能被外部点击关掉、节点可能被切走，组件卸载时
 * 才 stop 的话，会留一条声音在那儿响到底。
 */
let current: HTMLAudioElement | null = null;

export function stopVoicePreview() {
    const audio = current;
    current = null;
    if (!audio) return;
    audio.pause();
    // 清掉 src 才算真的断开：留着的话浏览器会继续把 5MB 的音频缓冲完。
    audio.removeAttribute("src");
}

/**
 * 播放一段音色，返回 audio 供调用方挂 `ended`（用来复位按钮图标）。
 *
 * 播放被浏览器拦掉（自动播放策略）时不抛错：试听失败最多是没声音，
 * 不该把异常抛进渲染流程。
 */
export function previewVoiceAudio(url: string): HTMLAudioElement {
    stopVoicePreview();
    const audio = new Audio(url);
    audio.preload = "auto";
    current = audio;
    void audio.play().catch(() => {
        if (current === audio) current = null;
    });
    return audio;
}
