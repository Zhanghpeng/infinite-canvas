# 画布配音能力设计分析

> 2026-10-22（v2）。范围：在画布中新增"配音 / FM 长文诵读"能力，底层走 ComfyUI（IndexTTS 系列），音色素材来自 `indextts_voice/`。
> 本文只做设计分析，不含代码改动。v1 只覆盖了"能不能跑通"，v2 补三块：IndexTTS 多控制维度的完整对接、与 H3 的边界、配音进视频节点且不阉割生成能力。
>
> **节点级实现设计见 `voice-node-design.md`**（第一版面板 / 音色选择 / `class_type` 绑定表 / 导入前必做标记）。
> 可直接导入的配音工作流：`indextts25-voice.api.json`（基于 T8 插件 `05_emotion_text`，已补 `_meta.title`）。

## 1. 结论

**不新造"配音节点"。现有 audio 节点升格为"声音节点"，用 `audioKind` 分流三条产线；配音是其中一个分叉，不是一条独立的节点类型。**

真实的缺口只有三处，且都不在节点层：

1. `applyAudioBindings`（`comfyui.ts:2615`）只绑 `caption/lyrics/duration/seed` —— 这是音乐工作流的字段，**音频工作流没有任何参考音频通道**。视频链路早在 `applyVideoBindings:2185` 就有了 `ref_audio_01..03` 的绑定 + 上传 + 未指派剪枝，配音要抄的就是这一段。
2. 画布 audio 面板只有一个"时长"控件（`CanvasAudioSettingKey = "audioSeconds"`），`audioVoice/audioFormat/audioSpeed/audioInstructions` 是 OpenAI TTS 时代的死字段，UI 与工作流都不消费。
3. agent 侧 `canvas_generate_audio` 在 `operations.ts:37` 直接抛错，所以所有内置技能只能写"音频走 H3 原生"，配音在 agent 层等于不存在。

**三条产线的分流：**

```ts
audioKind: "music" | "voice"
voiceMode?: "dub" | "narration"   // 仅 audioKind === "voice" 时有意义
```

| audioKind | voiceMode | 场景 | 节点粒度 |
| --- | --- | --- | --- |
| `music` | — | 配乐 / BGM（现状） | 单节点，`caption + lyrics` |
| `voice` | `dub` | 影视配音：多角色、短句、逐句返工 | **一句一节点** |
| `voice` | `narration` | FM 电台 / 有声书：单音色、长文连续 | **单节点，内部按段生成再拼** |

为什么 FM 和配音要分粒度：配音的核心动作是"第 7 句语气不对，只重跑这一句"，所以必须一句一节点；FM 的核心动作是"整集 25 分钟听起来顺不顺"，逐段铺节点只会让画布炸掉，正确做法是单节点内部循环、产物拼成一条。

---

## 2. 现状实测

| 能力 | 现状 | 位置 |
| --- | --- | --- |
| 音频节点类型 | 已有，含 `<audio controls>` 播放器 | `canvas-node.tsx:905` |
| 音频生成 | 已有，但只面向音乐（`[caption]/[lyrics]` 解析） | `comfyui.ts:2595` / `requestComfyuiAudio:2697` |
| 音频绑定器 | 只写 caption / lyrics / duration / seed | `applyAudioBindings:2615` |
| 参考音频插槽 | **视频侧已支持** `ref_audio_01..03`（上传+绑定+剪枝） | `applyVideoBindings:2185` / `submitComfyuiVideoJob:2488` |
| 音频工作流分类 | `WorkflowCategory` 有 `"audio"`，字段 `comfyuiAudioWorkflow` | `use-config-store.ts:39,41` |
| 画布音频设置 | 仅 `audioSeconds` | `canvas-audio-settings-popover.tsx:11` |
| audio metadata | 有 4 个 OpenAI 遗留死字段 | `types/canvas.ts:187-190` |
| agent 工具 | `canvas_generate_audio` 抛错 | `operations.ts:37` / `schemas.ts:205` |
| 画布角色实体 | **没有**，只有 `character-swap` 视频编辑模式 | `types/canvas.ts:143` |
| 视频音频参考收集 | `resourceInputs.map(i => i.audio)`，**顺序=连线顺序，无编号** | `canvas-node-generation.ts:50` |
| 视频音轨合成 | `concatVideoParts({ audio: sourceBlob })` 只支持**整轨替换**，不支持叠加 | `project.tsx:3995` |

已有的一半比想象中多（播放器、连线、产物存证、被视频当参考、agent 可创建）；缺的一半很集中（绑定器没有音频通道、UI 没有音色概念、agent 入口封死）。

---

## 3. 与 H3 的边界（先划清，再谈功能）

用户的要求是明确的：**IndexTTS 的产物不许影响 H3 现有逻辑。** 这条要落成硬约束，而不是"注意一下"。

### 3.1 绝对不动的部分

| 不动 | 原因 |
| --- | --- |
| H3 提示词的 `overall_soundscape` / `non_diegetic_music` 写法 | 这是 H3 原生出声的唯一通道，改了就破坏已跑通的片子 |
| 视频节点 `generateAudio` 开关语义 | 同上 |
| `ref_audio_01..03` 的绑定与剪枝行为 | 配音只是**复用**这段代码，不改它的行为 |
| 视频工作流的 9 图 / 3 视频 / 3 音频配额 | 见 §4，配音默认不占配额 |
| 视频尺寸档位、时长档位、分段合成（`recomposeVideoCut`） | 与声音无关，一行不碰 |
| `h3-to-ltx25-prompt` / `h3-prompt-writing` / `director-shot-design` 的 H3 部分 | 技能里 H3 相关章节保持原样 |

### 3.2 隔离措施

1. **配音节点不写任何 H3 提示词字段。** 配音产物只落在自己的 audio 节点和视频节点的 `voiceTracks` 里，绝不回写到 prompt / effectivePrompt。
2. **配音产物进视频时，默认走"音轨"通道**（§4），不进工作流、不改提示词、不占配额。这是"不影响 H3"的默认保障——什么都不做，H3 行为就和今天完全一致。
3. **只有用户显式把用途切成"参考"**，配音才会占 `ref_audio` 配额。此时它是"H3 的一个参考音频"，语义与今天手动导入的音频文件完全等价，H3 侧代码零改动。
4. **技能层的表述要改，但不是删 H3**：`CANVAS-RUNTIME.md` 第 50 节现在写"唯一的音频来源是 H3 自己"，要改成"H3 原生出声 / 独立配音轨两条路，各自适用场景"，H3 那段解释保持原文。

### 3.3 一个必须说清的期望（写进 UI 文案）

**H3 的 `ref_audio` 是"参考"，不是"逐字对口型"。** 把配音连成参考，模型会参考它的音色、氛围、节奏，但**不会**让嘴形跟上每个字。要精确口型只有三条路：

1. 首尾帧锁镜头 + 后期把配音轨贴上去（音画靠剪辑对齐，最稳）
2. 专门的 lip-sync 工作流（**当前没有**；`faceRefine` 是人脸修复，不是口型）
3. 接受"参考级"近似

这条不写清楚，用户连上配音发现口型不对，会把账算到画布头上。

---

## 4. 配音音频怎么进视频节点（不阉割能力的核心）

现在的视频节点只有一种入边语义：**连线 = 参考**。9 图 / 3 视频 / 3 音频都算配额。如果配音也走这条，一个 3 角色短片 + 1 段音乐参考就把 3 个音频槽吃满了，等于用配音把 H3 的音频能力挤掉——这正是用户说的"阉割"。

解法：**把视频节点的音频入边分成两条通道**，用途显式可选，默认值按节点类型推断。

| | 参考通道 | 音轨通道 |
| --- | --- | --- |
| 进 ComfyUI 工作流 | ✅ | ❌ |
| 占 3 音频配额 | ✅ | ❌ |
| 影响 H3 提示词 `<Audio N>` | ✅ | ❌ |
| 典型用途 | 音色/氛围/节奏参考 | 成片对白、旁白 |
| 现有实现 | 已有（视频侧链路可抄） | **新增**：metadata + 合成 |

**默认推断（省掉一次点击，也保证不误伤 H3）**

| 上游节点 | 默认用途 | 理由 |
| --- | --- | --- |
| `audioKind: "music"` | 参考 | 音乐不会有人拿来当对白轨，语义就是参考 |
| `audioKind: "voice"` | 音轨 | 配音是成片对白，默认不该被当成生成期参考 |

**用户可一键切换。** 视频节点入边区给每个音频输入一个"参考 / 音轨"角标，点一下切换——这样"我就是要让 H3 参考这个配音的音色"也能做到，能力一点没少。

### 配额账（说明为什么算"没阉割"）

- 上限仍是 **9 图 / 3 视频 / 3 音频**，一条没减。
- 音轨通道**不占任何一格**，所以叠 5 条配音轨也不会压缩参考能力（音轨数不设上限，但超过 3 条要在 UI 提示"混音较多，建议 P2 后用时间轴管"）。
- 首尾帧模式当前硬拒音频参考（`comfyui.ts:2439`），**建议放开**：参考通道照旧送，音轨通道本来就不过工作流。这是"解锁"而不是"改动 H3 逻辑"。

### 音轨通道的实现成本（不假装能做）

`concatVideoParts` 现在只支持"整轨取自源片"（`audio: plan.keepAudio ? sourceBlob : null`），**没有叠加混音**能力。所以音轨通道分两步走：

- **P0/P1**：音轨只做"登记 + 试听 + 时间对齐检查"。视频节点显示"已挂 2 条配音轨"，能逐条试听、看时长是否超出视频。**不做混音**，导出仍是原视频，用户在剪辑软件里合。
- **P2**：加 WebAudio 混音。`canvas-video-audio.ts` 已有 `audioBufferToWav` 与抽音轨能力，扩展成"多轨按偏移叠加 + 音量包络"，再交给 `concatVideoParts`。

宁可分两步说清楚，也不要在文档里承诺一个不存在的混音器。

---

## 5. IndexTTS 多控制维度怎么对接工作流

### 5.1 音色卡字段 → 节点参数（映射是 1:1 的）

`indextts_voice.json` 的 27 张卡，字段与 IndexTTS 的参数体系同源（`emo_control_method` 的取值字符串就是那套 API 的描述文本）：

| 音色卡字段 | 示例 | 去向 |
| --- | --- | --- |
| `reference_audio` | `voices\阿盖.MP3` | `LoadAudio` → `spk_audio_prompt`（**音色本体**） |
| `emo_control_method` | `Use text description to control emotion` | 决定 `emoControl` 取值（见 5.2） |
| `emo_text` | `叙述语气，语速稍快` | `emo_text`（method=3） |
| `emo_weight` | `0.8` | `emo_alpha`（情绪强度，0–2） |
| `emo_reference_audio` | 空 | `emo_audio_prompt`（method=1） |
| `vec_values[8]` | `[0,0,0,0,0,0,0.45,0]` | `emo_vector`（method=2），顺序 高兴/愤怒/悲伤/害怕/厌恶/忧郁/惊讶/平静 |
| `description` / `style` / `type` | `青年男性，声线清亮…` / `悬疑` / `男生` | 选角检索维度，**不进工作流** |
| `image` | `images/医生.png` | 卡面头像 |

**结论：配音节点需要的是"音色卡"，不是"voice 下拉框"。** alloy/nova 那套在这里是错的抽象——它只能选预设 ID，而配音的关键是"用谁的哪段声音 + 什么情绪 + 什么语气"。

### 5.2 情绪控制有四路，且互斥——`emoControl` 必须显式绑

| `emoControl` | 含义 | 绑定字段 | 其他字段状态 |
| --- | --- | --- | --- |
| `0` | 不加控制 | 无 | 继承音色参考音频自带的情绪 |
| `1` | 情绪参考音频 | `emo_audio` + `emo_alpha` | `emo_text` 失效 |
| `2` | 8 维情绪向量 | `emo_vector` | 其余失效 |
| `3` | 文本描述 | `emo_text` + `emo_alpha` | `emo_audio` 失效 |

**这一条是 v1 的设计错误，必须纠正：`emo_control` 不是可选标记，是必须显式的。** 如果靠"哪个字段有值就用哪路"去猜，用户同时留着一份情绪音频和一句情绪文本时，绑定器选哪路都"看起来合理"，产物却是两种完全不同的表演，而且不报错。显式声明才能把选择权交给用户。

音色卡的 `emo_control_method` → `emoControl` 的推导（导入卡片时算一次，之后跟着节点走）：

```
含 "text description"  → 3，带 emo_text
含 "audio"             → 1，带 emo_reference_audio + emo_weight
含 "vector" / vec 非全 0 → 2，带 vec_values
空或 "none"            → 0
```

注意卡里 `vec_values` 常常是 8 个 0（method 是 text 时向量并未启用），**不能见 8 个 0 就判成 method=2**。

### 5.3 参数范围（写进 UI 校验，避免 ComfyUI 侧 400）

| 参数 | 范围 | 依据 |
| --- | --- | --- |
| `emo_alpha` | 0–2，**建议 ≤1** | >1 开始"卡通化"，情绪夸张到失真 |
| `emo_vector` 单维 | 0–1.2 | 超出模型不认 |
| `emo_vector` 总和 | **≤1.5** | 超了会糊成一片情绪 |
| `speed` | 0.25–4.0 | 多数实现支持；**若工作流没有 speed 节点就别做滑杆** |
| 单次台词 | 建议 ≤600 字符 | 超了要分段（见 5.5） |
| 参考音频 | 建议 5–15 秒、单人、无 BGM | 官方经验；>15s 且带音乐会明显变糊 |
| `emo_audio` | 模型只取**前 15 秒** | 想借的情绪要前置 |

### 5.4 工作流标记协议（用户侧只改节点标题，不动图结构）

沿用现有约定（`docs/COMFYUI_WORKFLOW_GUIDE.md`）：**绑定只认 `_meta.title`，不依赖 class_type**；class_type 仅用于"已知节点优先匹配"，匹配不上再按输入键名兜底——与 `BINDING_TITLE_TO_INPUT_SLOT` 同路子。

| 标记（`_meta.title`） | 绑到 | 类型 | 必需 |
| --- | --- | --- | --- |
| `prompt` | 台词正文 | string | ✅ |
| `ref_audio_01` | 音色参考 `LoadAudio`（→ `spk_audio_prompt`） | 文件名 | ✅ |
| `emo_control` | 情绪控制方式 | int 0–3 | ✅ |
| `emo_text` | 情绪描述 | string | method=3 |
| `emo_audio` | 情绪参考 `LoadAudio`（→ `emo_audio_prompt`） | 文件名 | method=1 |
| `emo_alpha` | 情绪强度 | float | method=1/3 |
| `emo_vector` | 8 维向量 | string `"[0,0,0,0,0,0,0.45,0]"` | method=2 |
| `speed` | 语速 | float（**工作流有才绑**） | 可选 |
| `seed` | 采样种子 | int | 可选 |
| `output_audio` | 保存节点（`SaveAudio` / `SaveAudioAdvanced`） | — | ✅（`validateWorkflow` 已强制） |

`emo_vector` 有两种常见节点形态，绑定器都要支持：
- 单输入接受列表 → 写 `"[0,0,0,0,0,0,0.45,0]"`（字符串）
- 拆成 8 个输入 → 认 `emo_vector_1..8`（按上面顺序）

IndexTTS2 的 class_type 参考（以你实际工作流为准）：`IndexTTS2ModelLoader`、`IndexTTS2VoiceClone`（`text` / `spk_audio_prompt` / `temperature` / `top_k` / `top_p` / `use_random`）、`IndexTTS2EmotionText`、`IndexTTS2EmotionAudio`、`IndexTTS2EmotionVector`。

**台词与情绪必须分开绑**：台词是"说什么"，情绪是"怎么说"。合在一起的话，用户改一个标点就会连带改变表演。这也是不能复用音乐工作流 `caption/lyrics` 的根本原因——那套是"描述音乐"+"歌词"，语义不是一回事。

### 5.5 FM / 长文：分段是必须的，不是优化

单次生成有 token 上限（云端 600 字符；本地受 `max_mel_tokens` 约束）。FM 一集 25 分钟不可能一次出，必须：

1. **按句切分**，单句不超 `max_text_tokens_per_sentence`（默认 120）；
2. **逐段生成**，段间静音由 `interval_silence`（默认 200ms）控制；
3. **拼成一条**，产物是一个 audio 节点。

画布上的表达：`voiceMode = "narration"` **不铺多个节点**，而是单节点内部循环。理由——FM 的返工单位是"整集重录"，不是"第 43 句重来"，铺 200 个节点只会让画布不可读、让 agent 的 `canvas_get_state` 膨胀。

进度怎么体现：沿用视频分段的成熟做法（`prepareVideoBatch` 那套心智）——节点上显示"第 12/48 段"，可中断、可续跑，但画布上只有一个节点。

配音（`dub`）相反：一句一节点，逐句重跑只影响该句。

### 5.6 语速：别做独立滑杆（除非工作流真的有 speed）

音色卡里写的是 `emo_text: "叙述语气，语速稍快"` —— **既有实践就是靠情绪文本的自然语言控语速**。所以：

- 工作流有 `speed` 节点 → 面板给滑杆，绑 `speed`；
- 没有 → 面板不给滑杆，语速写进 `emo_text`（"语速稍快，尾音下沉"这种）。

做两个"语速"入口（一个滑杆、一个文本）比只做一个更糟：用户不知道该信哪个，而且滑杆在没有 speed 节点时会变成又一个死控件——正是 `audioSpeed` 现在的问题。

---

## 6. 画布交互

### 6.1 台词从哪来：走连线，不走输入框

配音节点自己做输入框最省事，但它把"剧本"变成了散落在各节点里的字符串，导演流程就断了。

**推荐链路**：`文本节点（剧本/分镜台词）` → `配音节点` → `视频节点`

理由：
- 画布已有 `text → 任意节点` 的连线语义，`restoreGenerationContext`（`canvas-generation-helpers.ts:34`）已能还原文本参考；
- 一个文本节点连多个配音节点 → 天然支持按角色拆分；
- skill 产出分镜后，agent 只建节点和连线，不用拼字符串。

多角色台词的解析约定（写在 skill 里，不进代码）：
```
[阿盖] 你走的那天，雨下得很大。
[丝丝] 我记得。
```
一个文本节点按行拆 → 每行一个配音节点，`[角色]` 映射到音色卡名字。这样"多角色对白"在画布层就切好了，不需要 IndexTTS 的双人会话模式（`dialogue_audio_s2` + `[S1]/[S2]`），而且能逐句重跑。双人模式留到 P2，只在"两人抢话/重叠"这种画布切不出来的场景才用。

### 6.2 面板（配音模式，最小三件）

1. **音色卡**：头像 + 名字 + 一句话描述（`description`），可搜；空态给"导入参考音频"
2. **情绪**：默认取卡片的 `emo_text` + 强度（默认 `emo_weight`，如 0.8）；切换 method 时按 5.2 显示对应字段
3. **渠道 / 工作流**：`category="voice"`

**台词不进面板**（走连线），**时长也不进面板**——配音的时长是结果，不是参数（见坑 3）。

### 6.3 跨镜头音色一致性

同一角色在 10 个镜头里必须是同一个声音。不用新节点类型，用同一个 `refAudioStorageKey` 复制：

```ts
voiceCard?: {
  id?: string;                  // 内置库卡片才有
  name?: string;                // "阿盖"
  description?: string;         // 选角依据，agent 也读它
  refAudioStorageKey?: string;  // 音色参考音频
  emoControl?: 0 | 1 | 2 | 3;
  emoText?: string;
  emoAlpha?: number;
  emoVector?: number[];
  emoAudioStorageKey?: string;
}
```

agent 建第 2..N 个同角色节点时，从上一个节点复制整块。想"改一处全片变"，就重跑该角色所有配音节点（agent 循环）。

**不做独立音色节点**：那要求放开 config 节点的 source handle 或新建类型，代价超过收益。升级信号是"用户要求改一次音色、全片自动同步"，真出现了再议。

### 6.4 工作流分类必须新增 `voice`

不能复用 `audio`。`getDefaultWorkflow(channel, "audio")` 只有一个默认值：混用时配音作业会静默产出音乐、音乐作业产出人声——产物类型都对（都是 audio），只是内容荒谬，这类错最难查。

代价：`WorkflowCategory` union + `WORKFLOW_CATEGORY_TO_CHANNEL_FIELD` + `ModelChannel.comfyuiVoiceWorkflow` 三处小改，旧渠道数据不用迁移（走 fallback）。

---

## 7. agent 落地

改动很小，因为 `generationFlowOps` 已支持 `mode: "audio"`（`operations.ts:310`）：

1. `canvas_generate_audio`：从抛错改为 `generationFlowOps({...input, mode: "audio", autoRun: true})`，`schemas.ts:205` 的描述改写。
2. `generationOptionsSchema` 增加 `audioKind` / `voiceMode` / `voiceCard` / `emoControl` / `emoText` / `emoAlpha` / `emoVector` / `emoAudioNodeId`，透传进 config 节点 metadata（`add_node` 已支持任意 metadata）。
3. `canvas_create_generation_flow` 支持 `mode: "audio"` + 上述字段。
4. **`connect_nodes` 的 `slot` 扩展**（重要，见坑 5）：`CanvasFrameSlot` 扩成 `CanvasConnectionSlot = "first_frame" | "last_frame" | "ref_audio_01" | "ref_video_01" | "voice_track"`。
5. `canvas_get_state` 返回的 metadata 里，`voiceCard` 与 `voiceTracks` 就是 agent 判断"这个角色用哪个音色"的唯一依据——不再需要额外的状态载体。

技能层同步（H3 部分保持原样）：
- `CANVAS-RUNTIME.md` §5 改写为两条声道，并补配音标记与坑；
- `director-shot-design/SKILL.md`：分镜产出时把台词拆成 `[角色] 台词` 行，交给 agent 铺配音节点；H3 提示词只写画面与环境声，**原有写法不动**。

---

## 8. 坑清单（按严重度）

1. **`applyAudioBindings` 只写字符串。** `emo_control` 是 int、`emo_alpha` 是 float、`use_emo_text` 是 boolean，写 `"3"`/`"0.8"`/`"true"` 会让 ComfyUI 类型校验 400，报错指向工作流而不是参数，极难定位。绑定器必须**按原值 typeof 写**。
2. **`LoadAudio.audio` 要文件名，不是路径。** 必须先 `uploadComfyuiAsset` 上传到 ComfyUI input 目录再写文件名；音频工作流当前**完全没有上传逻辑**，这是必须新写的部分（抄 `submitComfyuiVideoJob:2488`）。
3. **没连参考音频时必须剪掉 `LoadAudio` 节点。** 否则 ComfyUI 拼默认文件名 → `FileNotFoundError`。`applyVideoBindings` 的 Pass1/Pass2 剪枝必须一起移植，不能只写绑定。
4. **配音不能沿用 `duration+1`。** `:2736` 那个 +1 是为 MiniMax Music 恒少 1 秒硬编码的。配音时长由台词长度决定，多送 1 秒无意义；`audioKind === "voice"` 时跳过。回填用探测到的真实时长写 `durationMs`（`types/canvas.ts:200` 已有），不要写 `seconds`（那是请求参数）。
5. **音频参考槽位没有编号。** 视频侧 `referenceAudios = resourceInputs.map(i => i.audio)`，顺序 = 连线顺序（`canvas-node-generation.ts:50`）。多角色配音 + 多参考音频时，`ref_audio_01/02/03` 谁对应谁全靠连接先后——与首尾帧当年踩过的是同一个坑。修法见 §7.4。
6. **首尾帧模式硬拒音频参考**（`comfyui.ts:2439`）。建议放开：参考通道照旧、音轨通道本来就不过工作流。
7. **遗留死字段会误导 agent。** `audioVoice` 看着像"能设音色"，实际无人消费。建议删 `audioVoice`，其余迁到 `voiceCard` / `emoText`，否则模型会自信地传 `audioVoice: "nova"`，然后什么也没发生。
8. **参考音频质量门槛要给提示，但不拦截。** IndexTTS 官方建议 5–15 秒单人干声。用户拿 3 分钟带 BGM 的素材进去必然糊，且会归因于"画布不行"。做法：面板检测时长，>15 秒时提示一句。**是提示不是校验器**（校验器方向已被否掉）。
9. **`emo_control` 显式绑定**（v1 的错误，见 5.2）。四路互斥，靠"有值就用"去猜会在多路共存时静默选错。

---

## 9. 分阶段

### P0 打通（一次跑通"文本 → 配音产物"）
- `audioKind` / `voiceMode` 分流；`applyVoiceBindings` + 参考音频上传 + 未指派剪枝
- 新增 `"voice"` 工作流分类与 `comfyuiVoiceWorkflow`
- 面板：台词（连线）/ 音色参考 / 情绪（method 四路）/ 强度
- `canvas_generate_audio` 恢复；`slot` 扩 `ref_audio_01`
- **验收**：文本节点连配音节点，选 `voices/阿盖.MP3`，出 8 秒中文人声；把这个 audio 节点连到视频节点，能选"参考 / 音轨"，选"音轨"时视频生成参数与今天完全一致。

### P1 好用（导演流程跑得动）
- 音色库索引（27 张卡元数据 + 头像），参考音频按需导入
- `[角色]` 批量拆分成多配音节点
- `narration` 长文分段 + 进度 + 续跑
- 音轨通道的登记 / 试听 / 时间对齐提示（**不做混音**）
- 技能层改写（台词与画面声音分离）
- **验收**：3 角色 6 镜头短片，agent 一次铺完配音；改第 7 句只重跑该句；视频节点的 9/3/3 配额一个没少。

### P2 专业（可选）
- 多轨混音（人声 + BGM + 音效）：扩展 `canvas-video-audio.ts` 到"按偏移叠加 + 音量包络"
- 句级时间轴与音画对齐、lip-sync 工作流接入
- 双人对话（`[S1]/[S2]` 会话模式）

---

## 10. 明确不做

- 独立"配音工作台"页面（画布就是工作台）
- 自动字幕 / ASR（需要额外模型，且与配音不是一回事）
- 配音结果的硬校验器（方向已否；只做质量提示）
- 用 `audioVoice` 假装支持 OpenAI 音色（删掉这个幻觉）
- 在没有混音能力时假装能"把配音贴进视频"
