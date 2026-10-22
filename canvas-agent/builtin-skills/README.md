# 内置技能

这里的每个子目录都是一个技能，随 `canvas-agent` 发布，启动时自动铺到工作区的
`.agents/skills/`，Codex 的 `skills/list` 能直接发现，网页 Agent 面板的技能 tab 里可见。

## 同步规则

- 只覆盖带 `.builtin.json` 标记的目录。用户自己装的同名技能永不碰。
- **包版本与内容哈希都一致**才跳过（`sourceHash` 由目录内容算出）。改了 `SKILL.md` 但不升版本，
  重启后照样会重铺 —— 光看版本号会让开发期一直在跑旧内容，而且看不出来。
- **就地改这里的技能会被下次升级覆盖。** 要定制就复制一份改名。

## 现在有哪几个

### MiniMax H3 官方技能（`h3-prompt-writing` + 8 个题材）

来源 [MiniMax-AI/MiniMax-H3 · skills](https://github.com/MiniMax-AI/MiniMax-H3/tree/main/skills)，
保留上游目录结构与 `references/`，只做了三件适配：加中文触发词、每个技能目录里放一份
`CANVAS-RUNTIME.md`（画布运行时翻译层）、`brand-promo` 的 `allowed-tools` 换成画布真实工具。

| 技能 | 中文名 | 干什么 |
|---|---|---|
| `h3-prompt-writing` | — | 把创作意图写成 H3 能吃下的提示词：T2VA / I2VA / FL2VA / L2VA / Ref2VA 五种模式，六段结构 |
| `minimalist-product-ad-generator` | 极简产品广告生成器 | 产品图 → 三张锚点图 → 节拍分镜 → 极简产品广告片 |
| `3d-animation-short-generator` | 3D动画短片生成器 | 故事创意 → 角色/场景卡 → 镜头表 → 单镜生成 → 全片拼接 |
| `brand-promo-video-generator` | 品牌宣传短片生成器 | 品牌事实梳理 → 叙事方向 → 节拍镜头 → 宣传片 |
| `music-video-subtitle-generator` | 音乐MV动态字幕生成器 | 节拍与唱词分析 → 歌词字体动效 → 多镜头拼接 MV |
| `paper-collage-explainer-generator` | 纸拼贴讲解动画生成器 | 知识点 → 视觉隐喻 → 纸拼贴层景 → 科普解说 |
| `papercraft-stop-motion-explainer` | 纸艺定格科普视频生成器 | 知识 → 纸偶与层景 → 定格分镜 → 科普短片 |
| `co-op-game-intro-generator` | 双人游戏开场视频生成器 | 双人身份锁定 → 菜单确认图 → 界面动效开场 |
| `handdrawn-live-video-generator` | 手绘实拍融合视频生成器 | 手绘发光动画与实拍接触变形，15 秒单场景 |

`h3-prompt-writing` 只有英文版；其余 8 个都带 `SKILL.cn.md` 中文全文，可直接给用户看。

### 画布自研技能

| 技能 | 干什么 | 带脚本 |
|---|---|---|
| `director-shot-design` | 把剧本编排成镜头表，并直接调工具在画布上建节点、连线、跑生成 | — |
| `h3-to-ltx25-prompt` | 把 MiniMax H3 提示词换轨成 LTX-2.5 二采精修段提示词（原名 `h3转ltx25精修提示词`） | `check_ltx_prompt.py` 自检、`make_copy_html.py` 出复制页 |

带脚本的技能要求运行环境有 `python`（无第三方依赖，标准库即可）。
`h3-to-ltx25-prompt` 里那几份大文件（情绪表演系统 107KB、100 种情绪、MiniMax 文戏/武戏模板）
是**按需读**的参考资料，SKILL.md §0 有索引，不会常驻上下文。

## CANVAS-RUNTIME.md（改这里，别改副本）

官方那 9 个技能假定背后是 MiniMax Hub 云端（`hub_generate_image` / `hub_generate_video` /
`hub_generate_music` 等一串工具，外加 2K / 768P 分辨率）。本地画布完全不是这套，所以每个技能
目录里都放了一份同名文件做翻译层：工具对照、`<Picture N>` ↔ `ref_image_0N` 的编号对应、
尺寸九档、音频只有 H3 原生一条路。

**源文件是根目录这一份**，改完分发下去：

```bash
cd canvas-agent/builtin-skills
for d in */; do [ -f "$d/SKILL.md" ] && cp CANVAS-RUNTIME.md "$d"; done
```

`h3-to-ltx25-prompt` 不涉及画布生成，没有分发 —— 所以上面那句只补有 `SKILL.md` 的目录，
要排除它就在循环里加条件。

## 派生一个场景技能

用户要的是「不同场景不同风格」，做法是**复制 + 只改风格层**，不要从零写：

```bash
cd canvas-agent/builtin-skills
cp -r director-shot-design director-ad-film     # 广告
```

然后改三处：

1. `SKILL.md` 的 frontmatter：`name` 改成新目录名（必须一致），`description` 换成新场景的触发语句。
   description 是模型决定要不要用这个技能的唯一依据，要写清"用户说什么话时该用我"，**中文触发词也要写进去**。
2. `SKILL.md` 第五节「风格层」：整段替换成新题材的调性。
3. 需要新的方法论细节就加 `references/`，SKILL.md 里用相对路径引用，模型按需去读，不占常驻上下文。

**第五节要写可执行的判断**，不要写形容词：

| 别写 | 写成 |
|---|---|
| 有电影感 | 单光源，硬边阴影，人物半边脸在暗处 |
| 节奏要快 | 对话镜头 2–4 秒一切 |
| 画面要高级 | 少平视，机位偏低，三分线构图 |

前四节（开工前看画布、三步流程、镜头表字段、画布落地步骤）是所有场景共用的方法，
派生时不要改 —— 改了就会有一半技能不会建节点。

## 本地调试

改完不用重启 agent：

```bash
# 直接覆盖工作区那份（绕过版本与哈希判断）
rm -rf ~/.infinite-canvas/codex-workspaces/site/.agents/skills/<技能名>
# 然后重启 canvas-agent，启动时会重新铺
```

或者在 `canvas-agent` 里改完 `SKILL.md` 后手工复制过去：

```bash
cp -r canvas-agent/builtin-skills/<技能名> \
      ~/.infinite-canvas/codex-workspaces/site/.agents/skills/
```

验证是否被发现：

```bash
TOKEN=$(node -e "console.log(require(require('os').homedir()+'/.infinite-canvas/canvas-agent.json').token)")
curl -s --noproxy '*' -H "x-canvas-agent-token: $TOKEN" \
  "http://127.0.0.1:17371/agent/codex/skills?forceReload=1" | grep <技能名>
```
