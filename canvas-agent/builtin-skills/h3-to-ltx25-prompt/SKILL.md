---
name: h3-to-ltx25-prompt
description: "把已写好的 MiniMax H3 提示词（REF 六段 / T2VA 三段）**换轨**成 LTX-2.5 能用的提示词。专治二采精修段「画面嘴型都对、声音听不懂」——精修段提示词留空时，LTX 的音频分支没有条件，只能照唇动自由编音素。当用户说「把这段 H3 提示词转成 LTX」「精修段提示词」「二采提示词」「H3转LTX」「套用到 LTX2.5」「把 H3 的稿子改成 LTX 格式」时使用。**只做转换，不做创作**：写 H3 原稿走别的技能（本技能原名 h3转ltx25精修提示词）。"
agent_created: true
---

# H3 提示词 → LTX-2.5 精修段提示词

## 0. 动手前三件事（缺一件就会写错）

1. **转换规则本技能自包含**（§2 字段映射 / §4 五条硬禁 / §5 镜头合并 / §6 输出结构）。
   上游 H3 原稿怎么写、LTX 端官方规范原文，不在本技能范围内 —— 如果工作区里另有
   `H3-REF全参考提示词` / `ltx25-prompt` / `comfyui-workflow-rewire`，先加载它们补格式细节；
   **没有就只按本文件执行**，并明确告诉用户「缺哪份参考文档」，不要凭记忆编官方规则。
2. **判断目标 LTX 变体**（决定段落结构与是否需要镜头合并）：

| 目标变体 | 特征 | 本 skill 的额外动作 |
|---|---|---|
| **二采精修段**（本 skill 的主用途） | 有上游 H3 生成的 latent 灌进来 | 必看 §1 —— 提示词**绝不能留空** |
| T2V 纯文字 | 无任何上游 latent / 参考图 | 常规转换 |
| I2V / FL2V | 有首帧或首尾帧图 | 首帧构图已锁，人物段可略写 |
| 挂了 MSR / IC-LoRA | 有参考图槽位 | 先走 §3 判断标签体系 |

3. **读一次 LoRA 的 `__metadata__`**，决定能不能点名参考图（见 §3）。

4. **附带资料按需读，不要一上来全读**（都很长，全读会挤爆上下文）：

| 文件 | 什么时候读 |
|---|---|
| `references/worked_example_dual_quarrel.md` | 不确定怎么转时，先看这份 before/after 逐条溯源 |
| `references/worked_example_ltx_output.txt` | 需要标准输出的样子时（自检 PASS 的范本） |
| `references/negative_sample_doubao.txt` | 想知道反面长什么样（脚本判 FAIL 8 项） |
| `AI视频情绪表演提示词生成系统_公开版_v2.md` | **写 H3 原稿或要补表演细节时**（107KB，本身是一套独立方法论，含 40 种情绪 / 四档强度 / 六条表演轨道） |
| `100种情绪表达_分类版.md` | 需要具体情绪的五轨拆解（眼神—呼吸—肩—身体—手—声线）时查 |
| `MiniMax文戏完整提示词模板.md` / `MiniMax武戏完整提示词模板.txt` | 上游 H3 稿要按模板补全时 |

⚠️ 本技能的职责是**转换**。上面三份 MiniMax / 情绪资料属于创作端，只在"用户让你顺手把原稿补完整"时才用；纯转换任务不要改写原稿内容。

## 1. 为什么必须转、必须转全（本 skill 存在的理由）

**机制**：LTX 的文本条件是一份文本 → 双通道投影（`comfy/text_encoders/lt.py` 的 `LTXAVTEModel`，
`DualLinearProjection` 同时投出 `video ⊕ audio`）。`comfy/ldm/lightricks/av_model.py` 的
`preprocess_text_embeds` 里，文本只有单段时 `context_vid = context_audio = context` ——
**同一份文本同时喂画面和声音**。

**推论（实测已验证）**：

| 精修段提示词 | 画面/嘴型 | 声音 |
|---|---|---|
| **留空** | ✅ 正常（有 latent 兜着） | ❌ 照着唇动自由编音素 → 「像人话但不是人话」 |
| **写全（含逐句台词）** | ✅ 正常 | ✅ 听得懂 |

⇒ **精修段给完整提示词不是"锦上添花"，是声音可懂的充要条件。** 转换时任何字段都不能"意思到了就行"，
尤其**台词必须逐字**。

**另一条必知的**：嘴型永远是对的，因为视频与音频 latent 在同一条 AV 联合去噪轨迹上产出。
所以转换时**不要**去调任何"对齐"参数，只需要把**内容**写对。

## 2. 字段映射表（核心）

| H3 字段 / 写法 | → LTX 落点 | 怎么处理 |
|---|---|---|
| `<Subject N>` 的外观描述 | **人物段**（每人独立一段） | 剥掉 `<Picture N>`/`<Subject N>` 标签，改写成名词开头的完整句。**特征逐字保留，一项不落**（肤色/眉/眼/发型/发髻/服装/鞋/纹身/耳饰）。锁脸靠这些词当文本锚点，省一句就可能贴错人 |
| `<Picture N>` 条目 | **丢弃** | LTX 靠 ref latent 认图，不需要文字声明"这是参考图" |
| `summary` | **丢弃** | 那是 H3 的任务类型头（`[reference generation]`）；LTX 无此概念，且常含跨段指代 |
| `retention_analysis` | **丢弃**（当核对表用） | 不进正文；但它列了"必须保住的特征"，**拿它反查人物段有没有漏** |
| `detailed_description` 的风格开场 | **首段**（时长/风格） | 原样保留 |
| `[Shot 1]` 里的场景描述 | **提出来单独成段** | 官方六要素里 "Set the Scene" 是独立一项；且人物段要保持干净 |
| `[Shot N]` 标签 | **删** | 官方明令禁 shot list / numbered beats / slugline（见 §4） |
| `At MM:SS.mmm` 时间码 | **删** | 官方明令禁时间码。要控节拍就**写成动作**：`A beat of silence.` / `A moment later,` |
| `the shot cuts to` | `A hard cut transitions to…` | 官方要求用自然语言点名剪辑方式 |
| `<Subject N>` 指代 | **描述性名词** + 方位：`the woman on the left` / `the young man on the right` | LTX 无标签机制，靠"顺序 + 方位"区分 |
| `(S1)` / `(S2)` 说话人标记 | **删**，改「音色描述」 | `her voice sharp and trembling` / `in a low defiant young male voice`。官方 Sample 就这么写；**同性双人**用音色比用编号更稳 |
| `<d>[Chinese] 台词</d>` | `she speaks in Chinese, her voice …: "台词原文"` | 引号 + 声明语言（官方 :52）；**台词逐字保留，不许概括、不许翻译、不许省** |
| `overall_soundscape` | **拆开**：每个切点一句连续性声明 + 结尾段汇总 | 官方 :110-116「Every Cut 四件事」之一 |
| `non_diegetic_music` | 结尾段统一写，或按切点写变化 | 同一条生成内可以说 "continues across the cut"（H3 那种"延续**上一段**"才是禁止的） |
| 值为 `N/A` 的字段 | 直接不写 | 别把 `N/A` 抄进 LTX 正文 |

🔴 **`<Subject N>` 不一定是人（2026-09-22 新增，直播带货稿首次遇到）**：H3 侧允许把**场景 / 布景 / 陈设**
也定义成 `<Subject N>`（例：`<Subject 2> is the livestream set-up … : a small bedroom with …, a ring light …, a small wooden table … holding a plate of sausages …`）。
转换前**先判断每个 `<Subject N>` 是人还是物**：
- 是**人物** → 走「人物段」，外观逐字复述。
- 是**场景 / 陈设** → 走「**场景段**」，并把道具清单原样搬全，末尾补一句
  `…and everything on it remain stationary throughout.`（二采防重绘漂移）。
⛔ **绝不能把场景 `<Subject N>` 写进人物段** —— 会被模型当成"第二个角色"去渲染出一个人来。
判据：看它列的是「脸/发/肤/衣饰」还是「墙/床/灯/桌/摆件」。

🔴 **双人「左右」不是全局常量 —— 看两人是不是同框并列（2026-09-22 新增，出租屋分手稿）**：
- **两人同框并列**（双人中景/并排站坐）→ 用 `the woman on the left` / `the young man on the right`，
  方位**全片统一**，方便模型按顺序对槽位。
- **正反打 + 过肩收尾**（前几镜各只一人、最后一镜一人在前景一人在中景）→ **别钉全局左右**。
  改为**描述性名词定身份**（`the woman` / `the young man in the grey t-shirt`）+ **逐镜描述空间关系**
  （`the frame holding only him`、`her face large and fully lit`、`the back of his head filling the lower-left foreground`）。
  理由：这种镜位里两人的画面位置**每镜都变**，写死一个全局 left/right 反而会在某一镜里自相矛盾。
- ⛔ 无论哪种，**同一镜内出现的两个人都必须有可区分标签**（名词 or 方位），不能出现两个裸 `the person`。

## 3. 标签体系：三选一，由 LoRA 决定（最容易搞错）

**通用原理**（`bfsnodes/ltx_multiref_slots.py` 文件头原话）：

> The prompt tags are the part people get wrong. **Nothing in the model ties `<Image 1>` to slot 1**:
> that correspondence exists only because the **training captions** used it consistently.

⇒ **标签是训练 caption 的约定，不是模型机制。** 用之前先读 LoRA 的 safetensors metadata：

| metadata 长什么样 | 该用哪套 |
|---|---|
| 只有 `tass_*`（如 `Best_FaceID_v1.0`） | **纯散文，零标签** |
| 有 `reference_slot_embedding_*`（如 `LTX-2.5-Licon-MSR-V1`） | `Image N:` + 正文 `Figure N` |
| 官方 ID-LoRA（talkvid 系） | `[VISUAL]:` / `[SPEECH]:` / `[SOUNDS]:` 三段 |

⚠️ **H3 的 `<Picture N>` / `<Subject N>` 一套都别搬过去** —— 三套 LTX 体系里没有一套认尖括号。
⚠️ 反向也别把 LTX 的散文搬去 H3（H3 REF 六段是硬约定）。

## 4. 五条硬禁（来自实测翻车）

1. ⛔ **禁 `[Shot N]` / 编号节拍 / slugline**
2. ⛔ **禁 `0-4s` 之类时间码**（除非工作流挂了 PromptRelay 这类分段编码节点）
3. ⛔ **台词漏 `in Chinese`** —— H3 稿里的 `[Chinese]` 在转换时最常被丢掉，一丢就念成英文腔
4. ⛔ **每个切点不说声音延续** —— 官方要求每切一刀声明环境音/音乐是否继续
5. ⛔ **否定句要分类看，别一刀切**（实测修正 —— 这条我自己先判错过一次）：

| 否定句类型 | 例子 | 判定 |
|---|---|---|
| **质量 / 瑕疵类** | `no face distortion`、`no body deformation`、`avoid ugly`、`no artifacts` | ⛔ **禁写进正向**。官方把这类放进**负向节点**，且是**名词串**：`pc game, console game, video game, cartoon, childish, ugly` |
| **运动 / 机位 / 表演约束类** | `No pull-back; the only camera move is the continuous push-in.`、`no dipping or lowering of the head`、`no one leaves the frame` | ✅ **合法，官方 Sample 里就这么写** |

   官方 i2v 模板提示词原文佐证（`video_ltx2_3_i2v.json`）：
   > She walks steadily forward, head held level and gaze fixed ahead—**no dipping or lowering of the head**.
   > … **No pull-back**; the only camera move is the continuous push-in.

   注：负向在 CFG=1 时**完全不参与计算**，填了也是摆设 —— 先看 guider 的 cfg 值。

官方依据原文（`ltx25-prompt/references/official_prompting_guide_en.md`，转引勿改）：

> **Coming from another model?** Don't paste a prompt written for another video model into LTX unchanged —
> the content usually carries over, but **tag syntax and shot-list formatting don't**, and tend to underperform.

## 5. 镜头数要合并（没人会想到的一条）

- 官方 :117：**Prefer 2–4 shots** in one generation。
- H3 短剧一段常 4–6 个 shot → 直接照搬会"切太碎、每镜信息不足"。
- **合并原则**：
  - 同一空间、同一机位、动作连续的两个 shot → 并成一个，用 `A beat later,` 衔接
  - 反打镜头 A→B→A→B 的来回 → 削掉一个来回（3 镜：双人 → 男 → 女 是最常用的收敛结果）
  - 景别阶梯保留：establish → detail → reaction（宽 → 中 → 近）
- **合并后每镜仍要"给一个明确任务"**，并在切点重述身份与方位。
- 🔴 **先数一遍再动手**：若 H3 原稿本身**已经**落在 2–4 镜区间（对白戏天然常是「男 → 女 → 双人」三镜），
  **直接照搬，别硬合**。合并的用途是把**超标**的砍进区间，不是把达标稿凑成更少。
  （2026-09-22 木兰圣女对峙稿：H3 原 3 镜 → 原样保留 → 脚本判 `镜头数 3，落在 2–4 区间` PASS）

## 6. 输出结构模板（LTX 散文五段）

```
① 首段      时长 + 风格 + 场景与光线（1–2 句）
② 人物段    每个角色独立一段，外观逐字复述（有几个角色就几段）
③ 场景段    首段没写全时的补充（可省）
④ 动作段    一条时间顺序流水散文：切点用 A hard cut transitions to… 连接、
            写清左右位置、台词带引号+语言、每个切点声明声音延续
⑤ 收尾段    音效小结 + 非叙事音乐 + 一行技术风格标记
```

- 现在时动词；情绪写**物理线索**（`eyes redden and glisten`），不写抽象标签（`she is sad`）。
- 单镜头版照官方 `4–8 句`；多镜头版按上面五段走。
- **不写时长前缀也行** —— 官方两个 Sample 都不带，时长由节点参数定。带了不算错，但别指望它控时。

## 7. 交付格式

1. **英文版**（实际生成用）
2. **中文对照版**（供核对站位/景别/台词）
3. **桌面一键复制 HTML**（`<button>` + `navigator.clipboard.writeText`，带 `execCommand` 兜底）
   🔴 **一律用脚本生成，不要手写**：
   `python "<本技能目录>/scripts/make_copy_html.py" --md "<稿.md>" [--sub "副标题"] [--note "警示段"]`
   —— 从 md 抽 ```text 块、自动 HTML 转义、套模板，**生成完自带「md ↔ `<pre>` 逐字比对」校验**；
   改稿后重跑一次即同步，根治手写时「中文引号敲成弯引号 / 漏转义 `<`」的两处不一致。
4. 🔴 **落盘位置**：默认写到当前画布项目目录下的 `prompt-output/<作品名>/`（不存在则新建）。
   用户明确指定了位置（桌面 / 网盘 / 某个项目文件夹）就按他说的来，**别自己猜用户名去拼路径** ——
   原稿里出现过 `C:\Users\<某个用户>\Desktop\...` 这种别人的机器路径，照抄会写进不存在的地方。
   ⛔ 不塞时间戳临时目录。交付后在回复里写明真实路径。

## 8. 生成前自检

- [ ] 全文**搜不到** `[Shot `、`00:` / `MM:SS`、`<Subject`、`<Picture`、`<d>`、`(S1)` / `(S2)`
- [ ] 每句台词都有：引号 + `in Chinese` + 音色描述？台词**逐字**没被概括？
- [ ] 每个切点都声明了声音是否延续？
- [ ] 人物外观**一项不漏**（拿 H3 的 `retention_analysis` 反查）？
- [ ] 双人：每个人的**左右方位**都写死了？景别装得下两个人（`medium two-shot`，不是 `close-up`）？
- [ ] 镜头数收敛到 **2–4**？
- [ ] 正向提示词里**没有**质量类否定（`no distortion` / `avoid…`）？运动类否定（`No pull-back`）可以有
- [ ] 标签体系跟 LoRA metadata 对得上（§3）？
- [ ] **认脸关键特征**没丢（纹身 / 耳饰 / 发髻 / 发型 / 特殊记号）？拿 `retention_analysis` 反查
- [ ] 英文版 + 中文对照版 + 桌面 HTML 三样都给了？
- [ ] 🔴 **`.md` 与 HTML `<pre>` 逐字一致**？——尤其**中文对照版里的引号**：手写 HTML 时极易把
      `"台词"` 敲成 `“台词”`，同一份稿两处不一致（2026-09-22 时尚 MV 稿踩到）。
      统一口径：**英文块用直引号 `"`，中文块用中文弯引号 `“”`**。
      收尾必跑一次「剥掉 HTML 实体后逐字比对」的脚本（`html.unescape(pre) == md 的 code block`）。
      ✅ **2026-09-22 起一律用 `H3-REF全参考提示词\scripts\make_copy_html.py` 生成 HTML** → 此步自动完成。

## 9. 自动化自检（先把清单跑一遍，再交稿）

```bash
python <本技能目录>/scripts/check_ltx_prompt.py --ltx <你的LTX提示词.txt> --h3 <H3原稿.txt>
```

退出码 0 = PASS。它把 §8 的清单变成了机器检查，能自动抓：
残留 `[Shot N]` / 时间码 / 尖括号标签、台词缺语言声明、镜头块没交代声音、
镜头数超 4、正向混入质量类否定、认脸关键特征词丢失。

⚠️ 它会拒绝读 POSIX 风格路径（`/c/Users/...`）—— Windows 上传 `C:/Users/...` 或 `C:\Users\...`。

**三条判据口径（2026-09-22 修，写稿前先知道，免得误以为是自己的问题）**：
1. **「声音延续」只检查前 n−1 个镜头块** —— 最后一镜后面没有切点，官方那条不适用于它，
   声音写进收尾段即可。（改前会把最后一镜误报成 FAIL）
2. 🔴 **声音词表按子串匹配，收的是 `continue`** ⇒ 只有 **`continues` / `continued`** 能命中
   （它们是 `continue`+后缀）。**`continuously` / `continuity` / `continuing` 都匹配不上**
   （`continue` 不是它们的子串）—— 别用这几个词交代声音延续，直接用 `continues` / `continued`，
   或改用同表其它词（`sound` / `silence` / `quiet` / `keeps running`）。
   词表刻意**不**收 `sea` / `wind` / `wave` / `creak` 这类环境名词 —— 它们常出现在纯视觉描述里
   （`the sea wind lifting her veil`），收了会大面积误判。
3. 🔴 **「块」的边界 = 上一个切点句 → 下一个切点句之前**（脚本 `shot_blocks()` 一遇到含
   `hard cut transitions to` 的句子就先收束当前块、再以该句开头另起新块）。
   ⇒ **把 `continues uninterrupted across the cut` 只写在切点句之后，它归入「新块」，
   而它前面那一块（上一镜的内容）仍然一个声音词都没有 → 第 1 个镜头块 FAIL**
   （2026-09-22 夜市忘带钱稿踩到：3 块里块 1 = 跟随镜那一句，无声音词 → FAIL）。
   ✅ **正确写法：让每个「切点之前」的块自己带一个声音词** —— 最省事就是把延续声明挂在**切点句之前**
   的句尾，例：`…while neither of them speaks and the market ambience continues around them.
   A hard cut transitions to …`。（切点句之后的延续句保留也无妨，两块都有词更稳。）

**实测有效性**（三版对照，见 `references/`）：
- 2026-09-22 老鼠爸爸与鸭儿子稿（H3 REF 六段 · **3 镜皮克斯 3D 双人**（侧后双人镜 + 正反打）· 2 句中文 → LTX 散文五段）→ **PASS（零 WARN）**
  （2 句台词语言齐、**2 个切点声音延续齐**、镜头数 3 落在 2–4 区间原样保留、2 个 `<Subject N>` 特征词 100% 覆盖。
  ⚠️ 写稿时自己先踩了 §9 第 2 条：写成 `the quiet room tone continuing uninterrupted`（`continuing` 匹配不上）
  → 改成独立句 `The quiet room tone continues uninterrupted.`。**这条判据在实战中确实会踩，写时直接用 `continues`。**）

- 2026-09-22 夜市忘带钱稿（H3 REF 六段 · **3 镜双人**（侧后跟随镜 + 正反打）· 2 句中文 → LTX 散文五段）→ **PASS（零 WARN）**
  （2 句台词语言齐、**2 个切点声音延续齐**、镜头数 3 落在 2–4 区间原样保留、正向无质量类否定、
  **2 个 `<Subject N>` 特征词 100% 覆盖**。
  首轮 FAIL 与 WARN 各抓到一个真问题，都已修：
  ① **块 1 无声音词** —— 跟随镜那句没提声音，`continues across the cut` 又落在切点**之后**的新块里
  （踩中上面第 3 条口径）；
  ② **`spiky` / `dark` 两个 H3 特征词丢失** —— 男段我写 `standing up in loose spikes`（丢了 `spiky`）
  且**漏写眼睛颜色**（H3 是 `dark eyes`）→ 补 `jet-black and spiky, standing up in loose tufts` + `his eyes dark`。
  ⚠️ 这条提醒：**认脸关键词的「词形」也算**，同义换词（spiky→spikes）脚本会当丢失；眼睛颜色这种
  "一改就换脸"的特征更是必须逐字搬。）
- 2026-09-22 红发旗袍·时尚 MV 稿（H3 REF 六段 · **4 镜 MV 快切** · 2 句中文独白 → LTX 散文五段）→ **PASS**
  （零 FAIL；唯一 WARN 是 `trails` —— H3 写 `overlay that trails on the ground`，LTX 改写为 `pooling on the ground`，
  特征本身在（`floor-length sheer black overlay`），换动词属正常误报；
  4 镜落在 2–4 区间 → 原样保留；3 个切点声音延续齐；
  **单主体远镜用「背身起手 + 三分之四侧身」规避铁律⑤正脸必糊**）

- 规范样本 `worked_example_ltx_output.txt` → **PASS**
- 2026-09-22 求婚稿（H3 REF 六段 → LTX 散文五段）→ **PASS**
- 2026-09-22 木兰圣女对峙稿（H3 REF 六段 · 3 镜双人对白 → LTX 散文）→ **PASS**
  （2 句台词语言齐、2 个切点声音延续齐、2 个 `<Subject N>` 的特征词 100% 覆盖到 LTX）
- 2026-09-22 出租屋分手稿（H3 REF 六段 · 3 镜双人对白 · 正反打 + 过肩收尾 → LTX 散文五段）→ **PASS**（零 WARN）
  （2 句台词语言齐；2 个切点声音延续齐；`<Subject 1>`/`<Subject 2>` 特征词 **100% 覆盖**（含 `bun`/`qipao`/`earrings` 三个认脸关键词）；
  3 镜落在 2–4 区间 → **原样保留、未合并**；H3 的 `<Subject N>` = 布景道具（床垫/墙/灯泡/木凳/纸箱/门框/窗）→ 落场景段 + `remain stationary throughout`）
- 2026-09-22 直播卖香肠稿（H3 REF 六段 · **1 镜到底**单人带货 → LTX 散文五段）→ **PASS**
  （3 句台词语言齐；单镜无切点 → 声音收尾段统一交代；`<Subject 2>` 是**场景不是人** → 落场景段 + `remain stationary throughout`；
  唯一 WARN 是 `worn` 一词（"戴着小珍珠耳环"特征本身在，只是换了动词），属正常误报）
- 一份把 H3 原稿直接搬格式的稿子 `negative_sample_doubao.txt` → **FAIL 8 项**
  （分镜标签 ×3、时间码 ×3、台词缺 `in Chinese` ×3、镜头块无声音 ×2、质量类否定 ×1、认脸特征词丢失）

## 10. 验证记录

- `references/worked_example_dual_quarrel.md` —— 双人吵架三镜头稿的完整 before/after 逐条溯源，
  用来回归测试本 skill 的规则：**拿规则重新转一遍，输出应与该样本一致**。

---

## 11. 改画风任务：H3 稿换了画风，LTX 稿怎么跟（2026-09-22）

> 场景：用户先让改写 H3 稿的画风（如「改成 3D 国漫风」），随后要求「转成 LTX 精修格式」。
> H3 端的改法见 `H3-REF全参考提示词` skill §1.1.1；本节讲 LTX 端的对应做法。

**原则：只改渲染层，分镜 / 站位 / 台词 / 声音延续一个字不动。**

| 位置 | 怎么改 |
|---|---|
| **首段（风格+场景）** | 把写实风格词整段换成目标画风的**渲染特征**；场景描述照搬 |
| **人物段（每个角色）** | 写实词换渲染词：`fair skin` → `fair skin with soft subsurface scattering and no photoreal pore texture`；`black hair` → `hair built from sculpted clumped locks`；`dark eyes` → `dark eyes with crisp specular iris highlights` |
| **各镜景别** | 景别词前挂风格前缀：`medium two-shot` → `3D CG medium two-shot`（不要改景别本身） |
| **收尾段（技术风格标记）** | 换成本次画风的标记串：`cel-shaded characters with sculpted hair clumps, crisp ink-like line accents along the costume edges, ... smooth hard cuts between shots` |
| `retention_analysis` 里的 `attribute_transfer` | 仅当核对表用，不进正文 |

**措辞经验**：具体渲染词（`cel-shaded` / `sculpted hair clumps` / `ink-like line accents` /
`subsurface scattering`）比抽象品类名（`Chinese animation style` / `anime style`）有效得多 ——
前者是模型学过的视觉描述，后者只是品类标签。

### 🔴 二采的结构性限制（**机制推论，未实测，转述给用户时必须标注**）
二采精修段的上游有 H3 一采 latent 灌进来，LTX 做的是**重绘/精修**：画面骨架、构图、大体风格
由**上游 latent 主导**，提示词负责补细节 + 给音频分支提供剧本。
⇒ 若一采跑的是写实风，二采提示词写满目标画风也**只能部分拉动**，可能出现"写实脸 + 卡通描边"混搭。
⇒ **建议（同样待验证）**：一采就用目标画风的 H3 稿，两采同风格成片才干净。
⚠️ 这条**没有实测**，交付时写明"属于机制推论"，别当结论讲（用户反复强调过不要瞎出主意）。

### 自检
```bash
python <本技能目录>/scripts/check_ltx_prompt.py --ltx <LTX稿.txt> --h3 <H3原稿.txt>
```
改画风任务额外人工核：**分镜数、左右方位、台词逐字、每个切点的声音延续**是否与改风格前一致。
（脚本的 `[WARN] 普通特征词未出现` 会列出 H3 元数据词如 `reference` / `photographic` / `serves` /
`composition` / `transferred` —— 这些**本来就该丢弃**，属正常误报，不用管。）

🔴 **误报的第二个来源（2026-09-22 差点被我自己"修"掉）**：官方 §1.2 推荐的写法是
`<Subject 1> is … in <Picture 1>, with …`，**`<Picture N>` 定义行里内嵌了 `<Subject N>`**。
脚本的 `subject_definitions` 块按"行里含 `<Subject`"筛选，于是**把 `<Picture 1>` 那行也算成一个 subject**，
它里面的 `reference` / `image` / `identity` / `anchor` / `serves` / `defining` / `features` /
`hairstyle` / `facial` / `proportions` / `body` / `every` 全被报成"未出现的特征词"。
⇒ 判读口径：**WARN 列表里若全是这类元数据词、且没有 `CRITICAL_TRAITS`（纹身/耳饰/发髻/旗袍…），
就是正常误报，不必为了消 WARN 往正文里硬塞 `reference image` 这种词**（那反而污染提示词）。
真正的特征词（肤色/发型/服装/五官）漏了才会同时命中 FAIL 或出现在 WARN 里，届时要补。
