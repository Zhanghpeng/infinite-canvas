# 画布运行约定（Infinite Canvas Runtime）

这份技能来自 MiniMax Hub，假定背后是云端一条龙（图像 / 视频 / 语音 / 音乐都能生成）。
当前运行环境是**本地 Infinite Canvas + 自建 ComfyUI**，能力与槽位都不一样。执行前先读这一份，
把技能里的"生成""参考""尺寸"按下面翻译成实际调用。

## 一、你不是在 Hub 上跑

- 生成只有两条链：**图片**（本地 ComfyUI 图像工作流）与**视频**（MiniMax H3 全能参考工作流）。
- **没有**：独立的语音合成、音乐生成、视频剪辑、图库检索、媒体分析服务。
- 不要在回复里承诺 seedance / music-2.6 / ElevenLabs / 2K / 768P —— 这台机器上没有，说了就是骗用户。

## 二、工具对照

| 技能里写的 | 实际用 |
|---|---|
| `hub_generate_image` | `canvas_create_generation_flow({ mode: "image", ... })`，或直接 `canvas_generate_image` |
| `hub_generate_video` | `canvas_create_generation_flow({ mode: "video", ... })`，或直接 `canvas_generate_video` |
| `hub_canvas_get_node` | `canvas_get_state`（返回全部节点，含 `metadata`） |
| `hub_canvas_group_recent_outputs` | 无对应操作，不要分组；用 `canvas_move_nodes` 把成片按镜头顺序排开 |
| `hub_video_edit` | 无对应。要改某镜：找到那镜的 config 节点改提示词 → `canvas_run_generation` 只重跑这一镜 |
| `hub_analyse_media` / `hub_audio_meta` / `hub_image_search` | 无对应。素材由用户提供；需要判断画面就读节点上已有的图片 |
| `hub_synthesize_speech` / `hub_generate_music` / `hub_generate_audio` | **不可用**，见第五节 |

## 三、参考槽位与标签是同一套编号（最容易出错的地方）

H3 提示词里写 `<Picture 1>`、`<Video 1>`、`<Audio 1>`，画布里的槽位是：
`ref_image_01..09`、`ref_video_01..03`、`ref_audio_01..03`、`first_frame`、`last_frame`。

**两者编号必须一一对应**：`<Picture 2>` 就是连到底 `ref_image_02` 的那张图。

而槽位编号由**连线顺序**决定 —— 先连的图是 01，第二个是 02。所以：

- 连线顺序 = 提示词里的编号顺序，连之前先想清楚谁该是 `<Picture 1>`。
- 首尾帧不是参考图，必须显式标 `slot: "first_frame"` / `"last_frame"`，否则会被当成普通参考图插到中间去。
- 角色替换场景**不要把带旧人物的首尾帧当参考图送进去**，那是换不干净的直接原因。

上限：参考图 9 张、参考视频 3 段、参考音频 3 段。超了会显式报错，不要试图绕过。

## 四、硬约束（写死在代码里，改不了）

- **尺寸**：只有 16:9 与 9:16 两个方向，各 9 档，总像素 0.2M–0.98M（如 960×544、544×960）。
  技能里的 "2K / 768P / 1080p" 一律换成这九档里最接近的一个，并在回复里报实际档位。
- **时长**：单段 5–15 秒。超过 15 秒的片子必须分段，分段用画布的时间轴切段，不要硬塞。
- **提示词**：H3 的全能参考提示词是六段结构（`subject_definitions` / `summary` /
  `retention_analysis` / `detailed_description` / `overall_soundscape` / `non_diegetic_music`），
  整段写进生成节点的 `prompt`。字段名与顺序照 `h3-prompt-writing` 技能的 `references/ref-en.txt`，
  不要自己发明。

## 五、声音怎么办（唯一的音频来源是 H3 自己）

H3 生成视频时会**原生带一条音轨**。所以：

- 需要旁白、环境声、配乐时，**写进提示词的 `overall_soundscape` 与 `non_diegetic_music` 两段**，
  不要让用户先去别处生成再传回来。
- 技能里"用 music-2.6 生成一段更长 BGM 换轨""用 ElevenLabs 配音"这类步骤，**直接跳过**，
  改为把音乐方向写进 `non_diegetic_music`。
- 用户如果坚持要独立音轨，只能自己导入音频文件当参考（`ref_audio_01..03` 是作为**参考**喂给模型，
  不是往成片上叠音轨）。

## 六、落地三步（不要只给文字镜头表）

1. **先看画布**：`canvas_get_state`，确认已有节点、已有参考图、下游工作流的真实槽位。
2. **再建节点**：每镜一次 `canvas_create_generation_flow({ mode: "video", referenceNodeIds: [...], autoRun: false })`，
   参考图顺序就是 `referenceNodeIds` 的顺序。首尾帧随后用 `canvas_connect_nodes` 显式标 slot。
3. **只先跑第一镜**：`canvas_run_generation` 跑一镜给用户看。对了再批量跑剩下的，
   不要一次烧完全部段。

## 七、改一镜而不是重拍全片

用户说"第 3 镜太闷"时：定位到那一镜的 config 节点 → 改 `prompt` → `canvas_run_generation` 只重跑它。
其余镜头保持不动。整片重跑是最后手段，不是默认。
