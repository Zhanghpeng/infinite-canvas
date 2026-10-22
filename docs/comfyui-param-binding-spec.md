# ComfyUI 工作流参数对接规范

> 适用对象：所有要通过画布提交的 ComfyUI 工作流（生图 / 视频 / 文本 / 音乐 / 配音）。
> 目的：把"槽位标错就静默失效"变成"导入时就报出来"，并让新工作流按同一套规则接入，不用每次改绑定代码。

## 0. 一句话结论

**参数对接靠 `_meta.title`（槽位名），不靠 `class_type`。** 因为槽位是"这条工作流有哪些可变量"的声明，`class_type` 是插件实现细节；同一语义在不同插件里 class_type 完全不同，但槽位名可以统一。

代价是 title 是人手填的字符串 —— 打错、写中文、漏编号、标在消费方而不是源节点，**四种错法全部静默失效**，产物看起来正常只是参数没生效，最难查。所以规范的价值不在命名本身，而在配套的**导入期检查**（第 8 节）。

---

## 1. 你这份 `05_emotion_text.json` 的分析

这份比插件自带的 API 样例**好一个层次**，因为做了两件正确的事：

1. 台词和情绪**抽成了 `PrimitiveStringMultiline` 节点**（node 8 / 9），用连线注入目标节点，而不是写死在 `inputs` 里。
2. `output_audio` 标在了 `SaveAudio` 上。

这就是规范要推荐的标准形态。但有三处需要动：

| # | 位置 | 现状 | 问题 | 改成 |
|---|---|---|---|---|
| 1 | node 2 | `_meta.title = "ref_audio"` | 现有正则 `^ref_audio_(0[1-9])$` **不认无编号写法**，音色槽位等于没标 | `ref_audio_01` |
| 2 | node 9 | `_meta.title = "emotion"` | `emotion` 是新槽位，绑定器里还没有这个分支 | 保留（等待实现） |
| 3 | node 1/3/4 | title 是中文显示名 | 安全（不匹配任何槽位），但占用了 title 空间。将来有人把显示名写成 `Prompt` 就会被误绑 | 保留可，但**禁止显示名等于任何槽位名** |

另外 node 8 的 title 是 `prompt` —— **这个零改动就能用**，因为 `BINDING_TITLE_TO_INPUT_SLOT.prompt` 里已经有 `PrimitiveStringMultiline: "value"`。

还有一个隐性风险：`mode.emotion_text` 的值是 `["9", 0]`，也就是**带点的输入键也可以是连线引用**。绑定器绝对不能往这个键写字符串，否则连线被覆盖、工作流断链。见第 4 节铁律 1。

---

## 2. 槽位命名表

命名规则统一：**全小写、下划线、多槽位必须两位编号**（`01` 不是 `1`）。代码里统一 `.trim().toLowerCase()` 后比对，所以大小写不敏感，但请按规范写。

### 2.1 文案类（值是字符串）

| 槽位 | 语义 | 唯一 | 可挂在哪些节点 |
|---|---|---|---|
| `prompt` | 主提示词 / 台词 | 是 | `PrimitiveStringMultiline` / `PrimitiveString` / `CLIPTextEncode` / `TextEncode*` |
| `caption` | 音乐描述 | 是 | 同上 |
| `lyrics` | 歌词 | 是 | 同上 |
| `emotion` | **情绪描述（新增）** | 是 | 同上 |

`emotion` 是配音专用，值是一句自然语言（"克制但难掩喜悦，声音温柔"）。**留空是合法的**，IndexTTS 会拿台词本身去推断情绪 —— 所以它是可空槽位，不是必填。

### 2.2 数值类

| 槽位 | 语义 | 类型 | 唯一 | 可挂节点 |
|---|---|---|---|---|
| `width` / `height` | 画布尺寸 | int | 是 | `PrimitiveInt` / `PrimitiveFloat` |
| `duration` | 时长（秒） | float | 是 | `Float` / `PrimitiveInt` / `PrimitiveFloat` |
| `seed` | 随机种子 | int | 是 | `KSampler` / `KSamplerAdvanced` / `PrimitiveInt` / `PrimitiveFloat` |

### 2.3 文件类（值是 ComfyUI `input/` 下的文件名）

| 槽位 | 语义 | 唯一 |
|---|---|---|
| `ref_image_01..0N` | 参考图 | 每个编号唯一 |
| `ref_video_01..0N` | 参考视频 | 每个编号唯一 |
| `ref_audio_01..0N` | 参考音频 / **音色** | 每个编号唯一 |
| `first_frame` / `last_frame` | 首尾帧 | 各唯一 |
| `ref_mask` / `ref_mask_01` | 遮罩 | 唯一 |

**单槽位可省略编号**：`ref_audio` 等价 `ref_audio_01`。这是为了兼容已有的单音色工作流，新建工作流请照规范写两位编号。

### 2.4 产物标记

| 槽位 | 语义 |
|---|---|
| `output_image` | 图片产物节点 |
| `output_video` | 视频产物节点 |
| `output_text` | 文本产物节点 |
| `output_audio` | 音频产物节点 |

**产物标记只用于导入校验，实际取回是按产物类型/扩展名匹配的第一个**。所以：一个工作流**只保留一个音频产物节点**，多个 `SaveAudio` 可能取错。

---

## 3. 分类与槽位矩阵

| 分类 | 必需产物 | 必需输入槽位 | 允许的参考槽位 |
|---|---|---|---|
| `t2i` | `output_image` | `prompt` | 无 |
| `i2i` | `output_image` | `prompt` + `ref_image_01` | 图 |
| `inpaint` | `output_image` | `ref_mask` + `ref_image_01` | 图 + 遮罩 |
| `omniVideo` | `output_video` | `prompt` | 图/视频/音频 |
| `frameVideo` | `output_video` | `first_frame` + `last_frame` | **不得有**视频/音频 |
| `text` | `output_text` | `prompt` | 无 |
| `audio` | `output_audio` | `prompt` \| `caption` \| `lyrics` | 无 |
| `voice`（新增） | `output_audio` | `prompt` | `ref_audio_01`（音色）+ `emotion` |

`voice` 与 `audio` 必须分开：`getDefaultWorkflow(channel, category)` 只返回一个默认工作流，混用时配音作业会静默产出配乐、配乐作业产出人声 —— 产物类型都对，只是内容荒谬。

---

## 4. 绑定的四条铁律

### 铁律 1：只写源节点自己，绝不动消费方的连线引用

```
node 4 (Generate).inputs.text          = ["8", 0]   ← 连线，禁止写字符串
node 8 (PrimitiveString).inputs.value  = "台词…"    ← 真正要写的地方
```

绑定器遍历所有节点，只处理 `_meta.title` 命中的节点**自身**的 `inputs`。不要"找到消费方就去改它的 text"，那样会把连线引用覆盖成字符串，连线断、源节点变孤儿。

### 铁律 2：类型跟随原值，不一律写字符串

```ts
const original = node.inputs[slot];
if (typeof original === "number")  node.inputs[slot] = Number(value);
else if (typeof original === "boolean") node.inputs[slot] = Boolean(value);
else node.inputs[slot] = String(value);
```

`mode.strength = 0.85`（float）若写成 `"0.85"`（string），ComfyUI 返回 400，报错指向**节点**而不是参数，很难反查。

### 铁律 3：目标是数组 → 直接报错

```ts
if (Array.isArray(node.inputs[slot])) {
  throw new Error(`槽位 "${title}" 标在了消费方节点 ${id} 上（它的 ${slot} 是连线），请把槽位改标到上游源节点`);
}
```

这条把"标错节点"这个最高频错误，从静默失效变成一句能读懂的话。

### 铁律 4：槽位没命中 → 提交前提示，不静默

提交前统计"参数里有值、但工作流里找不到对应槽位"的项，给一条 warning：「工作流缺少 `emotion` 槽位，情绪描述将被忽略」。不阻断提交（有些参数本来就可选），但不能不吭声。

---

## 5. 文案的两种形态

| 形态 | 写法 | 适用 |
|---|---|---|
| **源节点（推荐）** | 独立 `PrimitiveStringMultiline`，`_meta.title = "emotion"`，目标节点用连线引用它 | 所有新工作流 |
| 内联值 | 直接写在目标节点 `inputs` 里 | 只适用于"整个工作流只有一个文案参数"的最简场景 |

推荐源节点的三个理由：可以单独替换而不动图结构；一个工作流能有多个文案槽位互不干扰；绑定逻辑统一（都是写 `inputs.value`），不用为每个插件猜字段名。

**内联形态的绑定目标**靠 fallback 猜（`value` → `text` → `prompt`），猜错了不报错。所以内联只用于兜底。

---

## 6. 文件类槽位

流程固定三步：

1. 上传文件到 ComfyUI `/upload/image`（该端点接受任意二进制，音频同样可传），拿到返回的文件名
2. 把文件名写进槽位节点的输入（`LoadAudio.audio` / `LoadImage.image`）
3. 记下文件名，下次复用（别每次生成都传一遍）

三个坑：

- **写的是文件名，不是路径**。`voices/阿盖.MP3`、`F:\...` 都读不到，只能是 `input/` 下真实存在的文件。
- **中文和空格文件名**统一重命名成 `voice_<hash>.wav`，避免不同平台的编码问题。
- **存在性用 `/object_info/<ClassType>` 判断**（它的选项列表就是真实文件列表），不在就重传。比"传了再说"省流量，比"记死文件名"抗 ComfyUI 清目录。

**音频工作流的特殊约束**：如果音色是生成节点的必需输入（`speaker_audio`），**不能沿用视频那套"未指派就剪掉参考节点"** —— 剪了生成节点会缺输入直接 400。只能前置拦截（没选音色禁用生成）。

---

## 7. 新工作流接入四步

```
① 抽源节点  →  把可变参数抽成 Primitive* / Load* 节点，用连线接进目标节点
② 打槽位    →  给源节点 _meta.title = 槽位名（照第 2 节表）
③ 打产物    →  给保存节点 _meta.title = output_xxx
④ 导入校验  →  画布导入，检查第 8 节清单全绿
```

如果出现**表里没有的新语义**，按这个顺序加（一次只加一处，别散着改）：

1. `BINDING_TITLE_TO_INPUT_SLOT` 加一行（槽位名 → class_type → input）
2. `RESERVED_SINGLE_SLOTS` 加槽位名（触发唯一性保护）
3. 对应分类的 `validateComfyuiWorkflow` 分支加必需性检查
4. 绑定函数加一个 `title === "新槽位"` 分支

---

## 8. 导入期检查清单

导入时逐条跑，任何一条不过就**明确报出节点 ID 和槽位名**：

| # | 检查 | 报错文案 |
|---|---|---|
| 1 | JSON 是 API 格式（不是 nodes/links） | 「这是 UI 格式，请在 ComfyUI 用 Export (API) 重新导出」 |
| 2 | 必需产物槽位存在 | 「缺少 output_audio 标记」 |
| 3 | 必需输入槽位存在 | 「缺少 prompt 槽位」 |
| 4 | 槽位名格式合法 | 「`ref_audio` 建议改为 `ref_audio_01`」 |
| 5 | 单值槽位唯一 | 「`prompt` 标记了 3 个节点」 |
| 6 | 槽位节点可写（目标 input 不是连线） | 「`emotion` 标在了消费方节点 3 上，请改标到上游源节点」 |
| 7 | 槽位节点 class_type 可识别 | 「`prompt` 所在节点 class_type `XXX` 不认识，无法写入」 |
| 8 | 无跨类产物标记 | 「音频工作流不得包含 output_video」 |

第 4、6、7 条是现在缺的。它们恰好覆盖了"静默失效"的全部路径 —— 有了这三条，槽位体系才真正可靠。

---

## 9. 配音工作流对接（本规范的首个应用）

`docs/indextts25-voice.api.json` 已按本规范整理。绑定表：

| 画布参数 | 槽位 | 落点 | 类型 |
|---|---|---|---|
| 台词 | `prompt` | node 8 `inputs.value` | string |
| 情绪 | `emotion` | node 9 `inputs.value` | string（可空） |
| 音色 | `ref_audio_01` | node 2 `inputs.audio` | 文件名 |
| 种子 | `seed` | node 4 `inputs.seed` | int |
| 产物 | `output_audio` | node 5 → 取回按类型 | — |

**工作流里不绑的参数**（保持工作流原值，作为"这条工作流的默认风格"）：

- `duration_factor`（1.05）— 语速。要在 UI 上调语速时，改成槽位 `speed` 再加分支；第一版留在工作流里
- `mode.strength`（0.85）— 情绪强度。同理，第一版由音色卡带值或留在工作流里
- `language`（ZH）、`postprocess_*`、`quality_*` — 与配音无关

**配音必须走独立请求函数，不能复用 `requestComfyuiAudio`**，两个硬理由：

1. 它会对 prompt 调 `parseAudioPrompt()`，把 `[caption]` / `[lyrics]` 标记当分隔符。台词里的方括号标注（`[笑声]`、`[停顿]`）会被误吞。
2. 它对时长做了 `duration + 1` 的补偿（给 MiniMax Music 少 1 秒打的补丁）。配音没有时长参数，套上去只会污染 `target_duration_seconds`。

---

## 10. 实施清单

| # | 文件 | 改动 |
|---|---|---|
| 1 | `web/src/services/api/comfyui.ts` | `BINDING_TITLE_TO_INPUT_SLOT` 加 `emotion`（`PrimitiveString*: value`、`CLIPTextEncode: text`） |
| 2 | 同上 | 抽 `writeSlot(node, slot, value)`：类型跟随原值 + 数组报错（铁律 2、3） |
| 3 | 同上 | `applyAudioBindings` 加 `emotion` 分支；`applyBindings` 同步 |
| 4 | 同上 | 文件槽位支持单槽位无编号（`ref_audio` ≡ `ref_audio_01`） |
| 5 | 同上 | `validateComfyuiWorkflow` 加第 8 节第 4/6/7 条检查 |
| 6 | 同上 | 新增 `case "voice"`：`output_audio` + `prompt` |
| 7 | 同上 | 新增 `requestComfyuiVoice()`：上传音色 → 绑定 → 提交 → 按类型取产物 → 回填真实时长 |
| 8 | `web/src/types/*` | `WorkflowCategory` 加 `"voice"` |
| 9 | `web/src/stores/use-config-store.ts` | 渠道加 `comfyuiVoiceWorkflow`（旧数据 fallback） |
| 10 | `RESERVED_SINGLE_SLOTS` | 加 `emotion` |

1–2 是底座（纯函数、可单测），3–6 是规范落地，7–10 是配音接线。建议 1–6 一次提交（规范），7–10 一次提交（配音）。
