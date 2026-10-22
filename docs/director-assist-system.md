# 导演辅助：skill 编排，agent 落地

一句话：**skill 负责导演级的编排与提示词，agent 负责把它在画布上变成节点。**
不做阶段机、不做 manifest 状态机、不做校验器 —— 那些是拿代码替导演做判断，方向错了。

## 1. 分工

| 角色 | 干什么 | 不干什么 |
|---|---|---|
| **skill** | 定调、拆镜、选机位、写提示词、给判据 | 不直接调工具，不关心节点 id |
| **agent** | 读 skill、查画布现状、建节点、连线、跑生成、汇报 | 不自己发明镜头结构 |
| **画布** | 承载产物，用户看得见、拖得动、能单独重跑 | 不内置创作规则 |

三者靠 `SKILL.md` 里的**落地步骤**衔接：skill 明确写清"第几步调哪个工具、参数怎么填"，
agent 照着做。不需要额外协议或中间层。

## 2. skill 是可迭代资产

内置技能在 `canvas-agent/builtin-skills/`，随包发布，启动时铺到工作区
`.agents/skills/`，Codex 的 `skills/list` 直接发现。

- 包升级会覆盖内置技能 → **要定制就复制改名**，别就地改
- 用户自己装的同名技能不会被碰（靠 `.builtin.json` 标记区分）
- 派生方法见 `canvas-agent/builtin-skills/README.md`

现在只有一个：`director-shot-design`（通用导演方法 + 画布落地步骤 + 风格层）。
不同题材 = 复制这份，**只换第五节的风格段**。

## 3. 落地用的工具（已实测）

| 要做的事 | 工具 | 关键参数 |
|---|---|---|
| 看画布现状（找角色图 / 已有镜头） | `canvas_get_state` | — |
| 一镜一条（提示词节点 + 视频节点 + 连线） | `canvas_create_generation_flow` | `mode: "video"`；`referenceNodeIds` 顺序即 ref_image 编号 |
| 首尾帧过渡 | `canvas_connect_nodes` | `slot: "first_frame"` / `"last_frame"` |
| 跑生成 | `canvas_run_generation` | `nodeId` 是 config 节点 |
| 改一镜 | `canvas_update_node_text` + 重跑 | 只重跑这一镜，不整批重建 |
| 看进度 | `generation_get_status` | — |

`referenceNodeIds` 的顺序就是模型看到的 `ref_image_01..0N`。角色图在前、场景图在后。
顺序一乱，模型会把环境当人物参考。

## 4. 这一轮改了什么

### 补上 `connect_nodes` 的 `slot`

`schema` 里没有这个字段，zod 直接 strip 掉，agent 根本没法把图连进 `first_frame` /
`last_frame` 具名槽位 —— 只能靠连线先后顺序隐式决定。顺序一乱、首尾帧颠倒，
**模型不报错，只是生成一条接不上的片子**。画布侧 `CanvasAgentOp.connect_nodes` 早就支持
`slot`，断的只是 agent 这一层。顺带把工具描述写清楚：模型不知道有这字段就不会用。

### 技能进仓库

解决"换机器 / 换工作区就丢技能"。`config.ts` 的 `initializeWorkspace` 里同步：
只覆盖带 `.builtin.json` 标记的目录，包版本没变就跳过，用户自己的技能不碰。

### 写了一个能落地的导演技能

原来的 `korean-thriller-asset-to-video` 只讲创作方法，产物是对话里的文字，
用户还得自己搬进节点。新技能把"第四步：画布落地"写进去了 ——
调哪个工具、参数怎么填、什么时候 `autoRun: false`、首尾帧什么时候需要。
这是"skill 编排 + agent 落地"真正接上的地方。

## 5. 一次创作长什么样

```
用户：把这段剧本做成 15 秒的片子，韩剧悬疑风
  ↓
agent 读 director-shot-design，先 canvas_get_state 看画布上有什么
  ↓ 没有角色图 → 先生成角色图，跑出来拿节点 id
  ↓
skill 给出镜头表（3–4 镜 / 总长 15s / 每镜 1–2 机位 / 一句台词只出现一次）
  ↓
agent 每镜一条 canvas_create_generation_flow（autoRun: false）
  ↓
agent 只跑第一镜 → 给用户看画面 → 认可后跑剩下的
  ↓
用户：第二镜太闷
  ↓
agent 找到那一镜的 config 节点 → 改提示词 → 只重跑这一镜
```

关键在最后一步：**改一镜不用整批重来**，因为产物是节点、有 id、能单独重跑。
这也是为什么不需要 manifest 中间层 —— 画布本身就是状态。

## 6. 还没做的，以及为什么

| 事项 | 为什么先不做 |
|---|---|
| 阶段机 / 制作档案节点 | 没有产物支撑时，界面上只是几个灰按钮，点下去"没变化" |
| 校验器 | 数量、格式可以算，但导演判断不能。真正会漏的（脸漂移、接不上）本来就算不出来 |
| 镜头表 → 分段批次 | 分段编辑是"一条长片切成几段"，skill 产出是"从零生成几条独立镜头"，两者不是一回事 |
| 情绪素材检索 | skill 里写清"什么情绪选什么镜头语言"就够了 |
| 分镜表 UI | 先用节点标题 + 文本节点承载，跑两周看是否真需要表格编辑 |
