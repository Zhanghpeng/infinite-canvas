# MiniMax H3 官方技能接入

来源：[MiniMax-AI/MiniMax-H3 · skills](https://github.com/MiniMax-AI/MiniMax-H3/tree/main/skills)
落点：`canvas-agent/builtin-skills/`，随包发布，启动时同步到工作区 `.agents/skills/`。

共 9 个：1 个提示词写作 + 8 个题材生成器。上游目录结构与 `references/` 原样保留，
**方法论正文一个字没改**，只加了三处适配（见下）。

## 一、装了什么

| 技能 | 类型 | 触发场景 |
|---|---|---|
| `h3-prompt-writing` | 底座 | 任何要把"我想拍什么"变成 H3 能吃的提示词的时候 |
| `minimalist-product-ad-generator` | 题材 | 产品图 / 电商 / 新品发布 |
| `3d-animation-short-generator` | 题材 | 故事创意 → 风格化 3D 动画短片 |
| `brand-promo-video-generator` | 题材 | 品牌 / 官网 / App 宣传 |
| `music-video-subtitle-generator` | 题材 | MV、歌词动效、卡点字幕 |
| `paper-collage-explainer-generator` | 题材 | 纸拼贴科普、拼贴动画 |
| `papercraft-stop-motion-explainer` | 题材 | 纸艺定格、纸偶讲解 |
| `co-op-game-intro-generator` | 题材 | 双人游戏菜单 / 开场 |
| `handdrawn-live-video-generator` | 题材 | 手绘发光动画与实拍融合 |

8 个题材技能都带 `SKILL.cn.md` 中文全文；`h3-prompt-writing` 只有英文。

## 二、四处适配

**1. 中文触发词写进 description。** Codex 判断"要不要用这个技能"只看 frontmatter 的
`description`，正文写中文没用。所以每个技能的 description 末尾都加了一行
「中文触发：…」，词取自 `meta.yaml` 的 `display-name-zh` 与 `SKILL.cn.md` 的 `trigger-words`。

**2. `compatibility` 改写。** 上游 8 个题材技能的 frontmatter 原本写着：

> `compatibility: Requires the MiniMax Hub agent (canvas workspace and hub_generate_image/hub_generate_video tools); not portable to generic agent harnesses.`

这句话在本地是**假的**，而且会主动误导：模型读到"不可移植到通用 agent"就可能直接放弃执行。
已统一改成「需要一个带画布工具的 agent，执行前先读同目录的 `CANVAS-RUNTIME.md`」。
`h3-prompt-writing` 另有话说 —— 写提示词不依赖任何工具，所以它的 `compatibility` 保留
「纯本地文件即可」，只把槽位映射与尺寸档要求指向运行时约定。

**3. 每个技能目录放一份 `CANVAS-RUNTIME.md`。** 这是关键。翻译层写了七节：你不是在 Hub 上跑、
工具对照、参考槽位编号映射、尺寸与时长硬约束、声音的真实来源、落地三步、改一镜而不重拍全片。
源文件在 `builtin-skills/CANVAS-RUNTIME.md`，分发方式见 `builtin-skills/README.md`。

**4. `brand-promo-video-generator` 的 `allowed-tools` 换掉。** 它原本列了 13 个工具，
其中 11 个是 `hub_*`。若 Codex 尊重这个白名单，那个技能在本地一个工具都调不到，
等于完全跑不动。已换成 `canvas_get_state` / `canvas_create_generation_flow` /
`canvas_connect_nodes` / `canvas_run_generation` 等真实工具。

## 三、能力缺口（必须知道的四条）

| 官方技能假设 | 本地现实 | 处理 |
|---|---|---|
| 独立音乐生成 `hub_generate_music`、语音合成 `hub_synthesize_speech` | **没有音频生成**（`canvas_generate_audio` 直接返回"尚未支持"） | 声音只能写进 H3 提示词的 `overall_soundscape` / `non_diegetic_music` 两段，由模型原生生成 |
| 分辨率 2K / 768P / 1080p | 只有 16:9 与 9:16 各 9 档，总像素 0.2M–0.98M | 取最接近一档并如实报出，不许承诺 2K |
| 失败回退到 Seedance 2.0 | 只有本地 H3 一条链 | 回退梯改为：强化提示词 → 缩短到 6 秒内 → 简化动作 → 问用户 |
| 图库检索、媒体分析、视频剪辑 `hub_image_search` / `hub_analyse_media` / `hub_video_edit` | 都没有 | 素材由用户提供；改镜头靠改提示词后重跑该节点 |

其中音频那条影响最大：官方 8 个题材技能里有 5 个把"生成 BGM / 配音"当成独立步骤。
本地执行时必须改道，否则会卡在等一个永远不出现的工具调用上。

## 四、H3 标签与画布槽位是同一套编号

这是两个体系能直接对接的关键，也最容易出错：

| 提示词里写 | 画布槽位 | 谁决定编号 |
|---|---|---|
| `<Picture 1..9>` | `ref_image_01..09` | 连线顺序，先连的是 01 |
| `<Video 1..3>` | `ref_video_01..03` | 同上 |
| `<Audio 1..3>` | `ref_audio_01..03` | 同上 |
| 首帧 / 尾帧 | `first_frame` / `last_frame` | 必须显式标 `slot` |

所以「参考图顺序不能乱」不是风格建议，是语义正确性：`<Picture 2>` 指的就是
`ref_image_02` 那张图，顺序错了，六段里所有引用全错位，而且不会报错。

## 五、怎么用

对话里说：

- 「按极简产品广告做个这瓶香水的片子」→ 命中 `minimalist-product-ad-generator`
- 「把这个故事做成 3D 动画短片」→ `3d-animation-short-generator`
- 「这段歌词做成卡点 MV」→ `music-video-subtitle-generator`
- 「帮我把这段想法写成 H3 提示词」→ `h3-prompt-writing`

也可以显式 `$<技能名>`。题材技能跑完流程后，最终提示词的结构由 `h3-prompt-writing` 的
`references/ref-en.txt` 兜住 —— 一个管流程与创意，一个管字段与顺序。

## 六、还可以补的

- **音频链路**：有了 TTS 与音乐工作流之后，这 9 个技能里被跳过的段落可以恢复，
  对口型、旁白、换 BGM 才真正可做。
- **Seedance 类回退模型**：本地若有第二套视频工作流，`3d-animation-short-generator` 的
  双模型回退才能生效（现在只能走单模型重试梯）。
- **成片分组**：`hub_canvas_group_recent_outputs` 无对应操作，多镜头成片现在只能靠
  坐标排开。节点分组能力补上后，镜头表 → 分组 → 成片会更干净。
