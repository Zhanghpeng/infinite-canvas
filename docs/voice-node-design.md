# 配音节点设计（第一版）

> 读的是 `E:\ComfyUI-WorkFisher-V2\...\workflows\IndexTTS2.5\05_emotion_text.json`。
> 这份是 **UI 格式**（nodes/links/widgets_values），画布吃 **API 格式**（class_type/inputs）。
> 插件自带 `example_workflows/api/05_emotion_text.json`，两者节点结构一致，本文用 API 版为准。

## 0. 三点要求 → 落到哪

| 你的要求 | 落法 |
|---|---|
| 可以选择参考音色 | 面板 pill 行加「音色」下拉，27 张现成音色卡 + 上传自己的 |
| 第一版简单，输入框和音乐差不多，上面台词下面情绪 | 同一个 audio 面板，大输入区拆上下两块（台词 / 情绪），pill 行把「时长」换成「音色」 |
| 先读工作流 | 见第 1 节，读完发现 3 个必须知道的事 |

## 1. 你给的工作流读出了什么

5 个节点，非常干净：

```
T8_IndexTTS25_ModelLoader ──model──┐
LoadAudio(音色参考音频) ──speaker_audio──┤
T8_IndexTTS25_EmotionControl ──emotion──┴─→ T8_IndexTTS25_Generate ──→ SaveAudio
```

**参数是扁平的**，这一点最关键。API 格式里情绪节点长这样：

```json
"3": {
  "class_type": "T8_IndexTTS25_EmotionControl",
  "inputs": { "mode": "text", "mode.emotion_text": "克制但难掩喜悦…", "mode.strength": 0.85 }
}
```

`mode.emotion_text` 是一个**带点的平铺键**，不是嵌套对象。所以绑定就是 `inputs["mode.emotion_text"] = 值`，不需要理解动态下拉的内部结构。

三件必须知道的事：

1. **情绪有四种模式，互斥**（读 `nodes_v3.py` 确认）：
   - `speaker` — 跟随音色参考，最省显存，**无子参数**
   - `reference_audio` — 要另传一段情绪音频
   - `vector` — 八维（喜/怒/哀/惧/厌/低落/惊/平静）
   - `text` — 一句自然语言，**留空则自动分析台词本身**

   你给的 05 是 `text`。而 `indextts_voice` 里 27 张卡正好分成 21 张 text、6 张 speaker —— **两种模式就能覆盖全部 27 张，不需要 vector 和参考音频**。这是第一版能"简单"的根本原因。

2. **`text` 模式留空是合法且有用的**：T8 会拿台词本身去推断情绪。所以情绪框可以留空，不是必填。

3. **API 导出会丢 `_meta.title`**，而画布的导入校验**只认 title**。插件自带的 api 样例如果直接导入，会因为缺 `output_audio` 标记被拒。见第 6 节。

## 2. 节点形态：不新建节点

音频节点加一个 `audioKind: "music" | "voice"`，缺省 `music`（历史节点零迁移）。

不新建 Voice 节点的理由：新节点类型要动节点枚举、手柄规则、连线校验、组聚合、插件 SDK、agent schema，而收益只是"面板看起来分得清"。音频节点已经有播放器、能连线、能被视频当参考上游、能被 agent 创建 —— 缺的只有面板和绑定的分流。

升级阈值写在这里：**等需要"按句切分 + 逐句重跑"时再独立**（对应插件的 `31_per_line_emotion`）。

节点外观：沿用波形播放器，左下角加一个音色名小标签（`阿盖`），让画布上扫一眼能分清谁是配音谁是配乐。

## 3. 面板：上面台词，下面情绪

和音乐节点**同一个面板、同一个位置**，只改输入区结构和 pill 行：

```
┌────────────────────────────────────────────────────────┐
│ 已连参考： [文本节点 3]   [音频 铺垫.wav]                │ ← 现有参考条，不动
├────────────────────────────────────────────────────────┤
│  台词                                                   │
│  等了这么久，我们终于可以一起出发了。                    │ ← CanvasPromptChipInput h-24
│  支持 @文本节点 引用，也支持 <pause=0.8> 显式停顿        │
│  ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄  │ ← 1px 虚线分界
│  情绪  （可留空，留空则按台词自动判断）                   │
│  克制但难掩喜悦，声音温柔，结尾带一点笑意                 │ ← 纯 textarea h-16
├────────────────────────────────────────────────────────┤
│ [⛶] [📚] │ [🎭 阿盖 · 0.8 ▾] [工作流 ▾]   [ 生成 ]    │
└────────────────────────────────────────────────────────┘
```

音乐节点对照：

```
[⛶] [📚] │ [工作流 ▾] [时长 60s]  [ 生成 ]
```

**两个 pill 对两个 pill**，视觉重量一致。把「时长」换成「音色」，因为配音的时长由台词决定，输入秒数没有意义。

字段来源：

| 区块 | 存在哪 | 写入工作流 |
|---|---|---|
| 台词 | `node.prompt`（复用现有） | `T8_IndexTTS25_Generate.inputs.text` |
| 情绪 | `node.metadata.emotionText` | `T8_IndexTTS25_EmotionControl.inputs["mode.emotion_text"]` |
| 音色 | `node.metadata.voiceId` / `voiceAudioName` | `LoadAudio.inputs.audio` |
| 强度 | `node.metadata.emotionStrength` | `...inputs["mode.strength"]` |

三个刻意的决定：

- **台词复用 `node.prompt`**，不另开字段。这样 `@` 引用、提示词助手、提示词库、批量粘贴全部直接可用，一行不用改。
- **情绪是纯 textarea**，不用 `CanvasPromptChipInput`。情绪是给模型的自然语言，@ 引用在这里没有语义；而台词恰恰需要 @ 文本节点。
- **强度放进音色弹层，不单独占 pill**。强度是跟着音色卡走的（每张卡自带 `emo_weight`），语义上属于音色。放进弹层后 pill 上直接显示当前值 `阿盖 · 0.8`，不点开也看得见，不增加控件数量。

## 4. 音色选择：27 张卡怎么进画布

弹层结构：

```
┌────────────────────────────────────────┐
│ 🔍 搜索音色…                            │
│ [全部] [男声] [女声] [通用] [影视] …     │ ← type / style 分面
├────────────────────────────────────────┤
│ ◉ 阿盖      ○ 丝丝      ○ 卡卡          │
│   青年男声   温柔女声   电台旁白         │ ← 头像 + 名字 + description 首句
│   0.8       0.8        跟随音色          │ ← 情绪强度来源一目了然
│  …                                     │
├────────────────────────────────────────┤
│ 强度 ──────●────── 0.80                 │ ← 选中后可调
│ [ 上传音色文件 ]                         │
└────────────────────────────────────────┘
```

### 数据从哪来

三样东西分开处理，体积差很大：

| 内容 | 体积 | 做法 |
|---|---|---|
| 元数据（27 条 name/description/style/type/emo_text/emo_weight） | ~15 KB | 打成前端 JSON，随包走 |
| 参考音频（27 个 MP3） | 5.5 MB | 放 `web/public/voices/`，弹层打开时才按需 fetch |
| 头像（27 张） | **41 MB 原始 PNG** | **必须压缩**：转 128×128 webp，总共 ~80 KB |

头像这 41 MB 是坑：`indextts_voice/images/` 里有 81 张 PNG（27 张卡复用了其中一部分），原样塞前端会把仓库撑爆。压缩到 webp 是必做步骤，不是优化。

### 音色卡字段怎么用

音色卡的字段名是**官方 IndexTTS2 节点**的，跟 T8 节点对不上，需要一层映射：

| 音色卡字段 | 值示例 | 去向 |
|---|---|---|
| `reference_audio` | `resources\indextts_voice\voices\阿盖.MP3` | 上传后写入 `LoadAudio.inputs.audio` |
| `emo_control_method` | `Use text description to control emotion` | → `mode = "text"` |
| 同上 | `Same as the voice reference` | → `mode = "speaker"` |
| `emo_text` | `叙述语气，语速稍快` | 预填到情绪框 |
| `emo_weight` | `0.8` | → `mode.strength` |
| `vec_values` / `emo_reference_audio` | 全 0 / 空 | 第一版不用 |
| `description` / `style` / `type` | | 弹层展示与分面检索 |

两个体验点：

- **选中音色卡时，把卡里的 `emo_text` 预填到情绪框**（若框里已是用户手写内容则不覆盖）。这就是 27 张卡真正的价值：每张卡都带了一句实测过的情绪描述，白给。
- **文件名里有中文和空格**（`10月27日 (2).MP3`）。上传时统一重命名成 `voice_<hash>.wav`，避免中文、空格、括号在 ComfyUI 侧出问题。

### 音色文件上传

`indextts_voice` 里的 `reference_audio` 是 `resources\indextts_voice\voices\阿盖.MP3`，看着像 ComfyUI `input/` 下的相对路径 —— 但**当前这台的 input 目录里没有这个文件夹**，实测确认。所以必须上传。

用现成的 `uploadComfyuiAsset()`（走 `/upload/image`，它接受任意二进制，音频一样能传），返回文件名写进 `LoadAudio.inputs.audio`。

避免重复上传：上传成功后把返回的文件名存进 `metadata.voiceAudioName`，下次直接复用。**校验存在性用 `/object_info/LoadAudio`** —— 它返回的 `audio` 选项就是 input 目录的真实文件列表，在里面就直接用，不在就重传。这样既不会每次生成都传一遍，也不会因为 ComfyUI 清了 input 目录而 `FileNotFoundError`。

## 5. 工作流对接：走槽位，不走 class_type

> 本节在 2026-10-22 晚按你提供的 `E:\confyui-api\workflow\05_emotion_text.json` 重写。
> 上一版主张"按 class_type 硬绑"，那份文件推翻了这个思路：**它把台词和情绪抽成 `PrimitiveStringMultiline` 节点、用连线注入，并打好了 `_meta.title` 槽位** —— 这正是画布已有的机制，而且比我提的方案更可扩展。完整规范见 `comfyui-param-binding-spec.md`。

`applyVoiceBindings` 沿用 `_meta.title` 定位，只写**槽位节点自己**的 `inputs`：

| 画布参数 | 槽位 title | 落点 | 类型 |
|---|---|---|---|
| 台词 | `prompt` | node 8 `PrimitiveStringMultiline.inputs.value` | string |
| 情绪 | `emotion` | node 9 `inputs.value` | string（可空） |
| 音色 | `ref_audio_01` | node 2 `LoadAudio.inputs.audio` | 文件名 |
| 种子 | `seed` | node 4 `inputs.seed` | int |
| 产物 | `output_audio` | node 5，取回按类型匹配 | — |

**绝对不能去写 node 4 的 `inputs.text`**（值是 `["8", 0]` 的连线引用）或 node 3 的 `inputs["mode.emotion_text"]`（同样是连线）。写字符串会把连线覆盖掉，源节点变孤儿、工作流断链 —— 而且提交不报错，只是台词不生效。

台词槽位**零代码**：`BINDING_TITLE_TO_INPUT_SLOT.prompt` 里已有 `PrimitiveStringMultiline: "value"`。只有 `emotion` 和音色是新加的。

**工作流里不绑、保持原值的参数**（作为这条工作流的默认风格）：

| 参数 | 值 | 为什么不绑 |
|---|---|---|
| `duration_factor` | 1.05 | 语速。要在 UI 上调就把它改成槽位 `speed`，第一版留在工作流里 |
| `mode.strength` | 0.85 | 情绪强度。第一版由音色卡带值写进工作流，或直接用它 |
| `language` / `postprocess_*` / `quality_*` | — | 与配音无关 |

### 切模式必须清残留子键

`mode="speaker"` 的时候，如果 `inputs` 里还留着 `mode.emotion_text` 和 `mode.strength`，ComfyUI 会按当前选中 option 校验，多出来的子键是未定义输入。规则：

- `speaker` → 删掉所有 `mode.*`，只留 `mode: "speaker"`
- `text` → 只留 `mode.emotion_text` + `mode.strength`

第一版只实现这两种，清理逻辑正好是这两种的差集，不会写错。等要上 `vector` 时再单独处理（它还要 `mode.use_random`）。

## 6. 导入前只有一处要改

你给的那份文件**已经把槽位标好了**（`output_audio` / `prompt` / `emotion`），比插件自带的 `example_workflows/api/05_emotion_text.json` 强很多 —— 后者一个 `_meta` 都没有，直接导入必被拒（"音频工作流缺少 output_audio 标记"）。

只有一处不合规范：

| 节点 | 现状 | 问题 | 改成 |
|---|---|---|---|
| node 2 `LoadAudio` | `ref_audio` | 现有正则 `^ref_audio_(0[1-9])$` 不认无编号写法，**音色槽位等于没标**（不报错，只是选什么音色都用工作流里那个 `妮妮女.MP3`） | `ref_audio_01` |

规范里允许 `ref_audio` 作为 `ref_audio_01` 的简写（为了兼容已跑通的单音色流程），但建议统一带编号，跟 `ref_image_01` / `ref_video_01` 对齐。

已按规范整理的成品：`docs/indextts25-voice.api.json`（7 节点，`prompt` / `emotion` 的 value 置空待画布填）。

## 7. 六个坑

1. **`duration+1` 不能套用**。`requestComfyuiAudio` 里那个 `+1s` 是给 MiniMax Music 少 1 秒打的补丁（`comfyui.ts:2736` 有注释）。配音没有时长参数，套上去只会让 `target_duration_seconds` 变成垃圾值。配音必须走独立函数。

2. **没选音色不能"剪枝"**。视频工作流的做法是"没连参考就剪掉该节点"，配音不行 —— `speaker_audio` 是 `Generate` 的必需输入，剪掉 `LoadAudio` 会让它缺输入直接 400。第一版策略：没选音色就**禁用生成按钮** + 提示"先选音色"。

3. **`LoadAudio.audio` 要的是文件名，不是路径**。写 `voices/阿盖.MP3` 或 `F:\...` 都读不到，只能是 ComfyUI `input/` 下真实存在的文件名。

4. **写槽位必须跟随原值类型**。`mode.strength = 0.85` 是 float，写成 `"0.85"` 会让 ComfyUI 返 400，报错指向节点而不是参数，很难反查。绑定器统一走 `writeSlot()`：读原值 `typeof`，number 就转 number。这条对以后所有工作流都适用。

5. **产物取回按类型匹配，既不是 title 也不是 node id**。现有实现是 `outputs.find(类型是 audio / 扩展名是 mp3|wav|ogg…)`。所以 `output_audio` **只用于导入校验**；一个工作流里有多个 `SaveAudio` 会取到第一个音频产物。规范建议单产物节点。

6. **工作流分类必须新增 `voice`，不能复用 `audio`**。`getDefaultWorkflow(channel, category)` 只有一个默认值：混用时配音作业会静默产出配乐、配乐作业产出人声。产物类型都对（都是音频），只是内容荒谬，这类错最难发现。代价是 `validateComfyuiWorkflow` 要补一条 `case "voice"`（要求同上：`output_audio` + 三个提示词槽位之一），渠道配置多一个 `comfyuiVoiceWorkflow` 字段（旧数据走 fallback，不用迁移）。

## 8. 第一版不做什么

| 不做 | 原因 | 何时做 |
|---|---|---|
| `vector` / `reference_audio` 情绪模式 | 要处理子键残留与额外上传，且 27 张卡用不上 | 用户提"要精确调某一种情绪"时 |
| 一句一节点 | 画布会变密、`canvas_get_state` 会膨胀 | 有逐句返工需求时 |
| FM 长文分段（narration） | 节点内循环 + 拼接是独立工程 | 有整集旁白需求时 |
| 多角色对话（11/23 工作流） | 单节点内多角色会丢失"逐句可重跑" | 配音节点稳定之后 |
| 混音进成片 | `concatVideoParts` 只支持整轨替换，不支持叠加 | P2，见 `voice-dubbing-design.md` |

第一版能用的进阶能力（零额外成本）：台词里写 `<pause=0.8>` 做显式停顿（插件 `16_pause_control` 验证过），提示文案里带上就行。

## 9. 实施清单

| # | 文件 | 改什么 |
|---|---|---|
| 1 | `web/src/types/canvas.ts` | metadata 加 `audioKind` / `emotionText` / `emotionStrength` / `voiceId` / `voiceName` / `voiceAvatar` / `voiceAudioName` / `voiceMode` / `durationFactor` / `language` |
| 2 | `web/src/types/*`（工作流分类） | `WorkflowCategory` 加 `"voice"` |
| 3 | `web/src/stores/use-config-store.ts` | 渠道加 `comfyuiVoiceWorkflow`（含 fallback） |
| 4 | `web/src/services/api/comfyui.ts` | 抽 `writeSlot()`（类型跟随原值 + 目标是连线数组时报错）；`BINDING_TITLE_TO_INPUT_SLOT` 加 `emotion`；`applyAudioBindings` 加 `emotion` / 音色槽位分支；`validateComfyuiWorkflow` 加槽位格式检查 + `case "voice"` |
| 5 | 同上 | 新增 `requestComfyuiVoice()`：音色上传（`/object_info/LoadAudio` 判存在）+ 提交 + 按类型取产物（**不复用 `requestComfyuiAudio`**，避开 `duration+1` 与 caption/lyrics 解析） |
| 6 | `web/src/data/indextts-voices.json`（新） | 27 张卡的元数据索引 |
| 7 | `web/public/voices/*` + `web/public/voice-avatars/*`（新） | 5.5 MB 音频按需 fetch + 压缩后头像 |
| 8 | `web/src/components/canvas/canvas-node-prompt-panel.tsx` | audio 分支按 `audioKind` 分流：配音走「台词 / 情绪」双域 + 音色 pill |
| 9 | `web/src/components/canvas/canvas-voice-picker.tsx`（新） | 音色弹层（搜索 / 分面 / 强度 / 上传） |
| 10 | 生成入口（`handleGenerateNode` 的 audio 分支） | 按 `audioKind` 分流到 `requestComfyuiVoice`；产物回填实际时长（配音没有输入时长） |
| 11 | `canvas-agent/src/canvas/operations.ts` | `canvas_generate_audio` 落地：接 `voice` 参数，别继续抛"尚未支持" |

1–5 是不改 UI 也能跑通的底座，6–10 是面板，11 是 agent。可以分三批提交。

## 10. 和视频节点的关系（一句话）

配音产物进视频**默认走"音轨"通道**：不进工作流、不占 3 个音频配额、不改 H3 提示词，所以默认对 H3 零影响。想拿配音当音色参考时一键切"参考"通道，那时它跟手动导入的音频完全等价。完整论证见 `voice-dubbing-design.md` 第 3、4 节。
