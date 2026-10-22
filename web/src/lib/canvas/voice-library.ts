import voicesJson from "@/data/indextts-voices.json";

/**
 * 一张音色卡。
 *
 * 字段来自 IndexTTS 自己的音色库（`indextts_voice/`），由 `tools/build-voice-library.py` 转成
 * 前端索引。两边的语义差别只有一处：官方卡用 `emo_control_method` 描述情绪控制方式，
 * 这里已经折成 `emoMode` —— 画布只认 text / speaker 两种，其余模式第一版不做。
 */
export type CanvasVoice = {
    id: string;
    name: string;
    /** 一句话人设，选自检索用。 */
    description: string;
    /** 男生 / 女生。 */
    type: string;
    /** 通用 / 解说 / 悬疑。 */
    style: string;
    /** text：用一句自然语言描述情绪；speaker：跟随音色参考，情绪框不生效。 */
    emoMode: "text" | "speaker";
    /** 卡里自带的情绪描述，选中时预填到情绪框。 */
    emoText: string;
    /** 卡里自带的情绪强度。 */
    emoWeight: number;
    /** 参考音频（相对 public 的路径），没有则不能用于生成。 */
    audio: string | null;
    /** 头像（压缩后的 webp）。 */
    avatar: string | null;
};

export const CANVAS_VOICES: CanvasVoice[] = voicesJson as CanvasVoice[];

const VOICE_BY_ID = new Map(CANVAS_VOICES.map((voice) => [voice.id, voice]));

export function findVoice(voiceId?: string): CanvasVoice | undefined {
    return voiceId ? VOICE_BY_ID.get(voiceId) : undefined;
}

/** 静态资源的绝对地址。`BASE_URL` 保证部署在子路径时也不丢前缀。 */
export function voiceAssetUrl(path: string): string {
    const base = import.meta.env.BASE_URL || "/";
    return `${base.replace(/\/$/, "")}/${path.replace(/^\//, "")}`;
}

/** 音色卡的音频地址。自定义上传的音色没有卡，用 `voiceSource` 存地址。 */
export function voiceAudioUrl(voice: CanvasVoice | undefined): string | undefined {
    return voice?.audio ? voiceAssetUrl(voice.audio) : undefined;
}

/** 弹层的分面：只用数据里真实出现过的值，避免出现点了没结果的空分类。 */
export function voiceFacets(voices: CanvasVoice[] = CANVAS_VOICES): { types: string[]; styles: string[] } {
    const types = Array.from(new Set(voices.map((v) => v.type).filter(Boolean)));
    const styles = Array.from(new Set(voices.map((v) => v.style).filter(Boolean)));
    return { types, styles };
}

/** 按名字 / 人设 / 风格检索，空查询返回全部。 */
export function searchVoices(keyword: string, voices: CanvasVoice[] = CANVAS_VOICES): CanvasVoice[] {
    const text = keyword.trim().toLowerCase();
    if (!text) return voices;
    return voices.filter((voice) => [voice.name, voice.description, voice.style, voice.type].some((field) => field.toLowerCase().includes(text)));
}
