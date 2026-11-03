---
name: h3-ltx25-dual-prompt
description: "从「画面描述 + 参考图」一次产出两份可直接投喂的视频提示词：MiniMax H3 全能参考提示词，以及由它换轨得到的 LTX-2.5 精修段提示词，中间用固定分隔符分割，结果由画布写回当前文本节点。中文触发：H3和LTX提示词、双份提示词、一次出两份、H3+LTX2.5、视频提示词双份、写H3顺带转LTX、精修段提示词、辅助视频提示词。"
compatibility: 纯文本产出，不依赖外部 API、不调用画布工具、不读写文件；由 Infinite Canvas 文本节点的「本地 Agent · 技能」调用，答案由前端写回当前文本节点，不生成文件、不新建节点。
---

# H3 + LTX-2.5 双份视频提示词

本技能把 `h3-prompt-writing`（写 H3 原稿）与 `h3-to-ltx25-prompt`（H3 稿换轨成 LTX 精修段）
收编成**一轮对话**。两份提示词服务于同一条画布链路：文本节点出稿 → 用户复制 H3 段给全能参考
视频节点跑一采 → 复制 LTX 段给精修段节点跑二采。

**不要去读那两个技能的目录**，本文件已自包含所需规则；也不要执行它们的「中文对照版 /
桌面一键复制 HTML / check_ltx_prompt.py」交付流程 —— 那些是独立使用场景的产物，画布链路只需要两段正文。

## 0. 交付格式（最重要，先读这一节）

输出恰好由三部分组成，除此之外一个字都不要有：

1. **H3 提示词正文**（可多行）
2. **独占一行**的分隔符，内容严格等于下面这串 51 个字符（行内代码的两侧反引号不是内容）：
   `=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=`
3. **LTX-2.5 提示词正文**（可多行）

硬规则：

- 分隔符**只出现一次**，必须独占一行，前后不加标题、不加编号。
- 分隔符之前只有 H3 提示词，之后只有 LTX 提示词。
- 不写解释、前言、后记、统计、字段名说明、中文对照版、自检结果。
- 不用代码块围栏包裹输出，不把两段分别标成「H3:」「LTX:」。
- 两段正文都用**英文**写；台词、歌词、画面内可见文字保留原语言。
- 不调用任何工具，不读写文件，不新建或修改画布节点。

## 1. 输入与模式判定

输入是「原始提示词」文本块，可能附带若干参考图（附件 `reference-1.png`、`reference-2.png`…）。
请求里会带一张**编号映射表**，形如「附件 reference-1.png = `<Picture 1>` = `ref_image_01`」：
严格按那张表写标签，不要自己重排编号。

按输入判定 H3 模式：

| 情况 | H3 模式 | 第一段结构 |
|---|---|---|
| 无任何参考图 | T2VA | 三段结构（§3.2），无对齐指令行 |
| 1 张图、描述它作为起始画面 | I2VA | 对齐指令行 + 三段结构 |
| 2 张图、分别作首帧与尾帧 | FL2VA | 对齐指令行 + 三段结构 |
| 1 张图、作为结尾画面 | L2VA | 对齐指令行 + 三段结构 |
| 有图且需要逐项锁定人物/场景/音色，或图 ≥ 2 张且不是首尾帧 | Ref2VA | 六段结构（§3.1） |

拿不准时优先用 **Ref2VA 六段**：画布里连了参考图，通常就是要锁定主体特征。

## 2. 画布运行约定（替代外部 Hub 依赖）

- 生成链只有两条：**图片**（本地 ComfyUI 图像工作流）与**视频**（MiniMax H3 全能参考工作流 /
  LTX-2.5 精修段）。没有独立的语音合成、音乐生成、图库检索服务。
- **不要承诺** seedance / music-2.6 / ElevenLabs / 2K / 768P / 1080p，这台机器上没有。
- 尺寸只有 16:9 与 9:16 两个方向、9 档总像素（0.2M–0.98M），时长单段 5–15 秒。
  尺寸与时长由**节点参数**控制，**不要写进提示词正文**；但描述的时间轴要落在合理时长内。
- 声音只能靠 H3 / LTX 自带的音轨：需要旁白、环境声、配乐就写进 H3 的
  `overall_soundscape` 与 `non_diegetic_music`，以及 LTX 的收尾段，不要让用户先去别处生成。
- 参考图上限 9 张。`<Picture N>` 与画布槽位 `ref_image_0N` 是同一套编号，**连线顺序即编号顺序**。
  首尾帧是独立槽位，不是普通参考图；本技能只负责写文字标签，不负责连线。

## 3. 第一段：H3 提示词

### 3.1 Ref2VA 六段（字段名、顺序照抄，不得改名或增删）

```text
subject_definitions:
<Subject 1> is … in <Picture 1>, with …
<Subject 2> is … in <Picture 2>, with …

summary:
[reference generation] …

retention_analysis:
<Subject 1> (appears in [Shot 1], [Shot 2]): fully_preserved - …

detailed_description:
[Shot 1] …
[Shot 2] At 00:03.000, the shot cuts to …

overall_soundscape:
…

non_diegetic_music:
…
```

- `subject_definitions` 每个需要单独追踪的主体一行；`<Picture N>` / `<Video N>` / `<Audio N>` 只作来源时
  内嵌在该行里，不另起一行。标签一旦分配，六段里含义保持一致。
- `retention_analysis` 用 `fully_preserved` / `partially_preserved` / `transferred` / `reused` 等关系词，
  逐项核对「必须保住的特征」，它是后面 LTX 转换的核对表。
- `detailed_description` 按播放顺序写：每镜的构图、主体外观与位置、环境与光线、动作与状态变化、
  镜头运动、当前声音、以及参考内容实际生效的点。生成任务一般 350–500 英文词；不要写成剧情梗概。
- 说话人按实际发声顺序标 `(S1)` / `(S2)` 并复用；台词与歌词只写在 `<d>[语言] 原文</d>` 里，
  不要在两个音频段重复。
- `overall_soundscape` 写全片环境声与物理动作声，`non_diegetic_music` 写角色听不到的配乐；
  没有就写 `N/A`。
- `[Shot N]` 与 `At MM:SS.mmm` 时间码在 H3 段是**合法的**，必须保留（LTX 段才要删）。

### 3.2 三段结构（T2VA / I2VA / FL2VA / L2VA）

```text
integrated_multimodal_description: [Shot 1] …

overall_soundscape: …

non_diegetic_music: …
```

- 有图时第一段之前加**对齐指令行**，与三段之间空一行。I2VA 固定用：
  `For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.`
- FL2VA / L2VA 用 `How the reference pictures align with the target video — <Picture 1> … aligns with the S.SS-second mark of the target video.`，
  时长按两位小数写实际值。
- `integrated_multimodal_description` 沿时间轴写画面、动作、分镜、说话人、台词、演唱与同期声；
  镜头运动写「类型 + 幅度 + 速度」（如 `pushes in with small amplitude at slow speed`）。

### 3.3 H3 段自检

- 字段名与顺序一字不差；没有的字段写 `N/A`，不要删字段。
- 标签在六个段落里含义一致，无悬空标签。
- 描述的是可见/可听的内容，不是抽象评价（少用 cinematic / beautiful）。
- 时间轴与镜头数自洽，不要出现跨段未解释的指代。

## 4. 第二段：LTX-2.5 提示词

### 4.1 为什么必须写满

LTX 的文本条件是一份文本经双通道投影，同一份文本同时喂画面与声音。精修段有上游 latent 兜着画面，
**提示词留空时音频分支没有条件，只能照唇动自由编音素**，成片「像人话但不是人话」。
所以第二段不是摘要，必须是完整的、可直接投喂的提示词，尤其**台词要逐字保留**。

### 4.2 从 H3 到 LTX 的字段映射

| H3 | LTX 落点 | 处理 |
|---|---|---|
| `<Subject N>` 外观 | 人物段，每人独立一段 | 剥掉标签，改写成名词开头的完整句；肤色/眉眼/发型/发髻/服装/鞋/纹身/耳饰**逐字保留，一项不落** |
| `<Picture N>` 条目 | 丢弃 | LTX 靠 ref latent 认图，不需要文字声明 |
| `summary` / `retention_analysis` | 丢弃 | `retention_analysis` 只拿来反查人物段有没有漏特征 |
| `detailed_description` 风格开场 | 首段（时长 + 风格 + 场景光线） | 原样保留 |
| `[Shot N]` 里的场景描述 | 单独成段 | 与人物段分开 |
| `[Shot N]` 标签 | 删 | 禁 shot list / 编号节拍 / slugline |
| `At MM:SS.mmm` 时间码 | 删 | 用动作控节拍：`A beat of silence.` / `A moment later,` |
| `the shot cuts to` | `A hard cut transitions to…` | 用自然语言点名剪辑方式 |
| `<Subject N>` 指代 | 描述性名词 + 方位 | `the woman on the left`；正反打/过肩机位改为逐镜写空间关系，别钉全局左右 |
| `(S1)` / `(S2)` | 删，改音色描述 | `her voice sharp and trembling` / `in a low defiant young male voice` |
| `<d>[Chinese] 台词</d>` | `she speaks in Chinese, her voice …: "台词原文"` | 引号 + 声明语言；**逐字保留，不概括、不翻译、不省** |
| `overall_soundscape` | 每个切点一句连续性声明 + 结尾汇总 | 每切一刀交代环境音/音乐是否继续 |
| `non_diegetic_music` | 结尾段统一写 | 同一条生成内可写 `continues across the cut` |
| 值为 `N/A` | 不写 | 别把 `N/A` 抄进正文 |

- `<Subject N>` **不一定是人**：列的是墙/床/灯/桌/摆件就属于场景段，把道具清单搬全，
  末尾补 `…and everything on it remain stationary throughout.`，绝不能写进人物段渲染成第二个角色。
- 同一镜里出现两个人都必须有可区分标签（名词或方位），不能出现两个裸 `the person`。
- 标签体系：画布不暴露 LoRA 的 safetensors metadata，**默认走纯散文、零标签**。
  不要搬 H3 的尖括号标签，也不要自称用了官方三段标签体系。

### 4.3 五条硬禁

1. 禁 `[Shot N]` / 编号节拍 / slugline。
2. 禁 `0-4s` 之类时间码。
3. 禁台词漏 `in Chinese`（H3 的 `[Chinese]` 转换时最常被丢，一丢就念成英文腔）。
4. 禁每个切点不交代声音延续 —— 用 `continues` / `continued` / `sound` / `quiet` 这类词，
   且**延续声明要写在切点句之前**的那一块里。
5. 否定句分类看：`no face distortion` / `avoid ugly` 这类质量瑕疵否定**不要写进正向**（属于负向节点，
   且 CFG=1 时不参与计算）；`No pull-back; the only camera move is the continuous push-in.` 这类
   运动/机位/表演约束**合法**，官方样例就这么写。

### 4.4 镜头合并与输出结构

- 官方建议一次生成 **2–4 镜**。H3 稿若已有 2–4 镜就**原样保留，别硬合**；超过 4 镜才合并：
  同空间同机位动作连续的两镜并成一个用 `A beat later,` 衔接，反打来回削掉一个来回。
- 合并后每镜仍要有明确任务，切点重述身份与方位。
- 输出为散文五段（不写段名，不要空行分段标记以外的编号）：

```text
① 首段      时长 + 风格 + 场景与光线（1–2 句）
② 人物段    每个角色独立一段，外观逐字复述
③ 场景段    首段没写全时的补充（可省）
④ 动作段    时间顺序流水散文；切点用 A hard cut transitions to… 连接，
            台词带引号 + 语言，每个切点声明声音延续
⑤ 收尾段    音效小结 + 非叙事音乐 + 一行技术风格标记
```

- 现在时动词；情绪写物理线索（`eyes redden and glisten`），不写抽象标签（`she is sad`）。
- 单镜头版 4–8 句；多镜头版按上面五段走。不写时长前缀也行，时长由节点参数定。

### 4.5 LTX 段自检

- 全文搜不到 `[Shot `、`00:` / `MM:SS`、`<Subject`、`<Picture`、`<d>`、`(S1)` / `(S2)`。
- 每句台词都有：引号 + `in Chinese`（或对应语言）+ 音色描述，且逐字未改。
- 每个切点都声明了声音是否延续，且延续词落在切点句之前。
- 人物外观一项不漏（拿 H3 的 `retention_analysis` 反查）；认脸关键特征（纹身 / 耳饰 / 发髻 / 发型 / 眼睛颜色）逐字保留。
- 双人：每人方位或描述性名词可区分；景别装得下两个人。
- 镜头数收敛到 2–4；正向里没有质量类否定。

## 5. 最后再检查一次交付格式

- 只有两段正文 + 一行分隔符；分隔符是 `=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=` 且只出现一次。
- 没有任何解释、标题、代码块围栏、中文对照版、文件路径、脚本或统计。
- 两段都不含对不存在能力的承诺（2K / 768P / TTS / BGM 生成 / 换轨工具）。
- 输出将原样写入画布文本节点，用户会自行复制其中一段使用 —— **不要替他决定只给哪一段**。
