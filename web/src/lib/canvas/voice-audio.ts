import { listComfyuiInputAudio, uploadComfyuiAsset } from "@/services/api/comfyui";
import { resolveMediaUrl } from "@/services/file-storage";
import { resolveModelChannel, type AiConfig } from "@/stores/use-config-store";
import { voiceAssetUrl } from "./voice-library";

/** 媒体库的 storage key 形如 `audio:xxxx`；内置音色存的是 `voices/xxx.mp3` 这种资源路径。 */
const STORAGE_KEY_PATTERN = /^(audio|video|image|file):/;

/**
 * 把节点上记的音色来源解析成浏览器真能取到的地址。
 *
 * 两种来源语义不同：内置音色卡记的是 public 下的资源路径（要拼 BASE_URL），
 * 自定义音色记的是媒体库 storageKey（要换成 objectURL）。混着判断比分别存两个字段省事，
 * 但判断依据必须是前缀，不能看"像不像路径"—— storageKey 里也有冒号。
 */
export async function resolveVoiceSourceUrl(source?: string): Promise<string> {
    const value = (source || "").trim();
    if (!value) return "";
    if (STORAGE_KEY_PATTERN.test(value)) return resolveMediaUrl(value, "");
    if (/^(https?:|blob:|data:)/i.test(value)) return value;
    return voiceAssetUrl(value);
}

/**
 * 把音色音频送进 ComfyUI 的 input 目录，返回可以写进 `LoadAudio.audio` 的文件名。
 *
 * 三个约束决定了这里不能简单"每次都传"：
 * 1. 上传会加随机前缀（同一个文件传两次就是两个文件），频繁生成会白占磁盘；
 * 2. 反过来也不能只信本地记的文件名 —— 用户清了 input 目录、或换了台 ComfyUI，
 *    记的名字还在，生成时才会 `FileNotFoundError`，而报错指向工作流而不是"少个文件"；
 * 3. 所以先用 `/object_info/LoadAudio` 看现成文件里有没有，没有再传。
 */
export async function ensureVoiceAudioName(config: AiConfig, options: { channelId?: string; sourceUrl?: string; cachedName?: string; signal?: AbortSignal }): Promise<string> {
    const channel = options.channelId ? config.channels.find((item) => item.id === options.channelId) || resolveModelChannel(config, config.audioModel || config.model) : resolveModelChannel(config, config.audioModel || config.model);
    const baseUrl = (channel.comfyuiProxyUrl || "").trim();
    const token = channel.comfyuiProxyToken;

    const cached = (options.cachedName || "").trim();
    const available = await listComfyuiInputAudio(baseUrl, token);
    // 拿不到列表（老版本 ComfyUI / 代理挡了）时按"还有效"处理：宁可撞一次真实报错，
    // 也不要每次都重传一遍 5 MB 音频把生成拖慢。
    if (cached && (!available || available.includes(cached))) {
        return cached;
    }

    const sourceUrl = (options.sourceUrl || "").trim();
    if (!sourceUrl) {
        throw new Error("这个音色没有可用的音频文件，请重新选一个音色");
    }

    // 扩展名必须跟真实编码一致：LoadAudio 按文件后缀选解码器，把 mp3 存成 .wav
    // 会让它在解码阶段报一个跟音色毫无关系的错。
    const ext = /\.(mp3|wav|m4a|flac|ogg)(?:$|[?#])/i.exec(sourceUrl)?.[1]?.toLowerCase() || "mp3";
    const name = await uploadComfyuiAsset(baseUrl, token, sourceUrl, `voice_reference.${ext}`, options.signal);
    return name;
}
