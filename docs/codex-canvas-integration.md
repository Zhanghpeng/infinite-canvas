# 画布连接 Codex：现状盘点与功能设计

> 对照对象：`F:\canvas\infinite-canvas-merged-24fd83d`（下称 merged，2026-10-14 打包）
> 对照目的：merged 是「base（Codex 优先）+ main（WorkBuddy 优先）」的合并版，刻意保留了 Codex
> 通路；当前主干（本仓库）沿的是 main 方向，Codex 这一侧在代码上还在、在 UI 上被拆掉了。
> 本文只做分析与设计，不含实现。

## 1. 结论先说

Codex 通路在**后端是完整的**，断在**前端和资产**，共 6 处：

| # | 断点 | 证据 | 用户感知 |
|---|---|---|---|
| 1 | 默认 provider 是 `workbuddy`，但 WorkBuddy 配置卡片被注释隐藏 | `use-agent-store.ts:140` `agentProvider: "workbuddy"`；`agent-connect-view.tsx:108-160` 整块注释 | 面板默认走 WorkBuddy，却没有任何地方能配 token |
| 2 | 连接页只有「本地 Agent 服务」一条路，没有任何 Codex 接入引导 | `agent-connect-view.tsx` 全文 | 不知道 Codex 怎么连画布 |
| 3 | 技能 tab 被删（组件与 store 类型都还在） | `AgentPanelTab` 含 `"skills"`（store:40），但 `local-agent-panel.tsx:1353-1355` 只有 chat/history/log | 用不了 Codex 技能，「我的技能」永远空 |
| 4 | 三处把 assistant 标题写死 `"WorkBuddy"` | `agent-log-view.tsx:338`、`local-agent-panel.tsx:1251`、`:1320` | 明明是 Codex 在跑，日志写着 WorkBuddy |
| 5 | `plugins/infinite-canvas/` 与 `.agents/skills/` 不存在，但声明文件指向它们 | `.agents/plugins/marketplace.json` → `./plugins/infinite-canvas`（缺失）；`skills-lock.json` 声明 2 个技能（`.agents/skills/` 缺失） | Codex 侧插件/技能装不上，且报错难懂 |
| 6 | 模型/推理选择器被 `models={[]}` 关掉 | `local-agent-panel.tsx:1434`；`agent-chat-composer.tsx:94` 只在 `models.length` 时渲染 | 不能选模型、不能调推理强度 |

另有一处**假实现**（两端都有，merged 也没修）：画布节点提示词助手的「执行者」下拉选
Codex / WorkBuddy / Claude，`agentId` 只在 picker 里读写，没有任何消费方 ——
`runPromptAssistantTurn`（`project.tsx:2506`）硬编码打 `/agent/codex/turn`，
不看 `config.agentId` 也不看 `agentProvider`。

## 2. merged 值得借鉴的 5 项

### 2.1 双通道并存 + `agentProviderLabel()`（成本极低，收益最大）

merged 只做了一件事：`agentProvider` 默认 `"workbuddy"` → `"codex"`，再加一个
`agentProviderLabel()`（merged store:45-47）让事件/日志标题随 provider 变，不再硬编码。

- handler 不动：`codex` 走 `/agent/codex/turn`，`workbuddy` 走 `/agent/workbuddy/*`，两条路都在
- skills 加载的 gate 是 `agentProvider !== "workbuddy"`，默认改回 codex 后自动恢复

**它的不足**：没有 provider 切换 UI，改成 codex 就把 WorkBuddy 用户边缘化了。
我们该补一个显式选择，而不是靠改默认值。

### 2.2 连接页的「方式一 / 方式二」结构

merged 在「本地服务」之前插了一张 Codex 卡片：

```
方式一：在 Codex 中使用插件
  在 Codex app 安装 Infinite Canvas 插件后，通过插件启动画布，
  插件会自动启动本地 Agent 并带上连接信息。
  ┌ Codex 插件提醒 ─────────────────────────────┐
  │ 只有安装插件或手动添加 MCP，工具列表才会进  │
  │ Codex 上下文并增加 token 消耗；只跑          │
  │ npx -y @zhuyichuan/canvas-agent 不会装 MCP。 │
  │ 移除插件    codex plugin remove infinite-canvas  ⧉
  │ 移除手动 MCP codex mcp remove infinite-canvas    ⧉
  └──────────────────────────────────────────────┘

方式二：启动本地 Agent
  npx -y @zhuyichuan/canvas-agent
  再回到网页连接，或手动填 Local URL / Connect token
```

「提醒」那段是真正有价值的部分：它解释了**为什么**要有两种方式（MCP 会吃 token），
以及怎么彻底卸掉（否则用户装完插件不知道怎么回退）。

### 2.3 端点解析：`activeEndpoint` + 同源代理回退

merged 把「用户填的地址」与「本次实际请求的地址」分开：

```ts
url: string             // 用户填的 / 保存的（设置页显示它）
activeEndpoint: string  // 本次实际用（回退到 /__agent 时与 url 不同）；空串表示直接用 url
```

`resolveAgentEndpoint(configured)`（merged store:67-88）：

1. 手动改过地址 → 忘掉回退记忆（`forgetEndpointMode()`）
2. 记住了「上次回退到同源」且 `/__agent` 可用 → 直接用同源，不再白试一次
3. 探配置地址，通就用它
4. 配置地址不通、`/__agent` 通 → 回退并记住，返回 `fellBack: true`
5. 都不通 → 返回配置地址，让后续流程报明确错误

配套 `vite.config.ts` 的 dev proxy：

```ts
"/__agent":   { target: "http://127.0.0.1:17371", changeOrigin: false, rewrite: strip("/__agent") }
"/__comfyui": { target: "http://127.0.0.1:8188",  changeOrigin: false, rewrite: strip("/__comfyui") }
```

**为什么需要**：端口转发/隧道会在路上把 `Origin` 规范化（例如剥掉端口），跨源请求的
`ACAO` 与页面真实 origin 对不上，被浏览器直接拦。走同源路径就没有 CORS 这一步。
回退必须**告知用户**（merged 用 `usingSameOriginProxy` toast），不能静默改地址。

### 2.4 `CANVAS_CODEX_BIN`

merged 的 `codex-client.ts` 用 `codexLaunch()` 替掉硬编码路径：

```ts
function codexBin() {
    const override = process.env.CANVAS_CODEX_BIN?.trim();
    if (override) return override;
    return path.join(path.dirname(require.resolve("@openai/codex/package.json")), "bin", "codex.js");
}
function codexLaunch() {
    const bin = codexBin();
    return /\.(c?js|mjs)$/i.test(bin) ? { command: process.execPath, args: [bin] } : { command: bin, args: [] };
}
```

价值：可以用**系统上已鉴权的 Codex**（或内网分发包），不必让 `@openai/codex` 依赖
里那份再走一遍登录；JS 入口与原生可执行文件自动分流。

### 2.5 模型 / 推理强度的显式选择记忆

merged 在 `local-agent-panel` 里把 `models / model / reasoningEffort / permissionMode`
真正传给 composer，并记三把钥匙：

| localStorage key | 含义 |
|---|---|
| `canvas-agent-model` | 当前模型（用于 turn） |
| `canvas-agent-model-explicit` | 用户是否**亲手选过**；没选过就走偏好默认，最后回落 codex 默认 |
| `canvas-agent-reasoning-effort` | 当前推理强度 |

+ `PREFERRED_AGENT_MODEL = "DeepSeek-V4-Flash-Vision-Exp"`（网关没有就回落 codex 默认）。

我们这一步更省事：`AgentChatComposer` / `AgentModelControls` 已经写好，
panel 里模型列表也**已经在拉**（`local-agent-panel.tsx:592-614`），
只是 composer 那行传了 `models={[]}` —— 把它接上即可。

## 3. 不值得照搬的

| merged 的做法 | 不照搬的原因 |
|---|---|
| 靠改默认值切 provider，没有切换 UI | 换一边就得改代码，另一边的用户被静默边缘化 |
| WorkBuddy 卡片保留但整块注释 | 默认 workbuddy + 卡片隐藏 = 死路；要么给配置入口，要么彻底移除分支 |
| `url` / `activeEndpoint` 双字段直接暴露给设置页 | 用户只需要填一个地址；`activeEndpoint` 应是内部实现细节，只在回退时用一句话说明 |
| `plugins/infinite-canvas/README.md` 里的 GitHub clone 安装法 | 与 `workbuddy-connector` 的市场化路径不统一，我们会两种都写清 |
| 把 `agentId` 当纯标签 | 这是"说了没生效"，必须修（见 4.4） |

## 4. 功能设计

### 4.1 P0 · 让 Codex 能连上、看得见（纯前端，不动后端）

**① provider 显式选择**（补 merged 的不足）

- `use-agent-store.ts`：`agentProvider` 默认 `"codex"`；新增 `agentProviderLabel()`
- 连接页顶部加一个极简分段控件：`Codex ｜ WorkBuddy`（沿用画布扁平风格，不引入胶囊底色）
- 选择结果落 localStorage（`canvas-agent-provider`），刷新后保持
- 切换时只清 `connectError`，**不自动重连**：本地 Agent 连接是同一个，切换只改变会话走哪条
  turn 通路（codex / workbuddy），连接状态不变

**② 连接页按 provider 分两张卡**

- Codex：方式一（插件接入 + 提醒 + 两条移除命令）/ 方式二（`npx -y @zhuyichuan/canvas-agent`）
- WorkBuddy：恢复被注释的 Access Token 卡片（含在线状态检测、权限需求说明）
- 共用底部「本地 Agent 服务」卡（地址 / token / 连接按钮）—— 两种 provider 都要它

**③ 恢复技能 tab**

`local-agent-panel.tsx` 的 tab items 补回 `skills`（`AgentSkillsView` 与 `skillCount` 均已在位），
渲染链补 `activeTab === "skills"` 分支。面板标题 `WorkBuddy` → 中性 `Agent`。

**④ 标题与日志不再写死 provider**

`agent-log-view.tsx:338`、`local-agent-panel.tsx:1251` / `:1320` 统一改 `agentProviderLabel()`。

### 4.2 P1 · 补齐资产，消除悬空引用（纯新增）

- `plugins/infinite-canvas/` 8 个文件：`.codex-plugin/plugin.json`、`.mcp.json`、
  `.zcode-plugin/plugin.json`、`marketplace.json`、`assets/icon.png`、`README.md`、
  `skills/{canvas,open-canvas}/SKILL.md`
- `.agents/skills/`：`frontend-design`、`vercel-react-best-practices`（与 `skills-lock.json` 对齐）

`.mcp.json` 与现有 `plugins/workbuddy-connector/mcp.json` 是同构的（都是
`npx -y @zhuyichuan/canvas-agent mcp`），差别只在 Codex 侧多 `startup_timeout_sec` /
`tool_timeout_sec`。**不改** `marketplace.json` 与 `skills-lock.json`，补上目录即自洽。

### 4.3 P2 · 连接健壮性（隧道 / 自定义 Codex / 模型选择）

- `activeEndpoint` + `resolveAgentEndpoint()` + `forgetEndpointMode()`（移植 merged 实现）
- `vite.config.ts` 加 `/__agent` 与 `/__comfyui` 同源代理
- 回退时给一条 `message.info`：「连不上你配置的地址，已临时改用同源代理（/__agent）」
- `canvas-agent/src/agent/codex-client.ts`：`CANVAS_CODEX_BIN` + `codexLaunch()`
- 模型/推理：panel 把 `models / model / reasoningEffort / onModelChange / onReasoningEffortChange /
  permissionMode / onPermissionModeChange` 传给 composer；选过模型写 `canvas-agent-model-explicit`

### 4.4 P2 · 让「执行者」选择真正生效

现状：画布节点提示词助手的执行者下拉（`codex / claude / workbuddy`）是标签，
`runPromptAssistantTurn` 永远打 `/agent/codex/turn`。

方案二选一（建议 A）：

- **A（诚实优先）**：只保留真实可用的执行者。`codex` 恒可选；`workbuddy` 仅在
  `agentProvider === "workbuddy"` 且已配置 token 时可选，否则置灰并给 `title` 原因；
  `claude` 维持现状（置灰 + 原因）。同时在 `PromptAssistantConfig` 里删掉没人消费的
  `agentId`，避免"存了个字段但不起作用"。
- **B（全通）**：`runPromptAssistantTurn` 按 `config.agentId` 分派 Codex / WorkBuddy 两套 turn。
  收益是可对比，代价是两条链路的流式与中断语义不同（codex 用 SSE + `interruptCodexTurn`，
  workbuddy 走 `runWorkbuddyTurn` 一次性返回），提示词助手依赖的"等 waiting 变 false 再取最后
  一条 assistant 消息"这套逻辑在 workbuddy 下需要单独验证。

## 5. 批次与验收

| 批次 | 内容 | 验收 |
|---|---|---|
| P0 | provider 选择、连接页两卡、技能 tab、标题去写死 | 新装环境打开面板默认 Codex，技能列表能加载；切 WorkBuddy 有配置入口 |
| P1 | 插件与技能资产 | `marketplace.json` / `skills-lock.json` 指向的路径全部存在；Codex 里 `plugin add` 能装上 |
| P2 | 同源回退、`CANVAS_CODEX_BIN`、模型/推理、执行者生效 | 隧道场景能连上并有提示；系统 Codex 可指定；模型下拉可选且刷新后保持 |

统一口径：`tsc` 错误数不超过基线（当前 60）、`vitest` 失败数不超过 9、`vite build` 通过。

## 5.1 实施进度

| 项 | 状态 | 落点 |
|---|---|---|
| provider 默认 codex + 显式切换 | 已完成 | `use-agent-store.ts`（`agentProvider` 读 `canvas-agent-provider`）、`agent-connect-view.tsx`、`local-agent-panel.tsx` |
| 连接页按 provider 分卡 | 已完成 | `agent-connect-view.tsx`（Codex 两张卡 / WorkBuddy Token 卡；共用「启动本地 Agent」抽成 `directCard`） |
| 恢复技能 tab | 已完成 | `local-agent-panel.tsx`（tab item + 渲染分支 + 打开时拉一次技能） |
| 标题随 provider | 已完成 | `agentProviderLabel()`；`agent-log-view.tsx` 与 panel 两处消息标题 |
| 模型 / 推理 / 权限接上 | 已完成 | `local-agent-panel.tsx` 的 composer 传参（含三把 localStorage 钥匙） |
| Codex 插件资产 | 已完成 | `plugins/infinite-canvas/`（8 文件）+ README 重写 |
| 执行者 A 方案 | 已完成 | `canvas-prompt-skill-picker.tsx` + `agentCodexOnly` 文案 |
| `CANVAS_CODEX_BIN` | 已完成 | `canvas-agent/src/agent/codex-client.ts` |
| 同源代理回退（`/__agent`） | **未做** | 需要先确认是否真有隧道/端口转发场景；不确认就加，会多一条"连不上时偷偷换地址"的路径 |
| `.agents/skills/`（2 个通用技能） | **未做** | 与"连接 Codex"无直接关系，属第三方技能引入，待单独决定 |

验收（本次）：`tsc` 60 错（同基线，agent 相关模块 0 错）、`vitest` 424 过 9 败（同基线）、
`vite build` 通过、`canvas-agent` tsc 0 错 / 136 测试 134 过 0 败 2 跳过。


## 6. 已定口径（已拍板）

1. **默认 provider = `codex`，并在连接页顶部给显式切换**（`Codex ｜ WorkBuddy`，落 localStorage）。
   不照搬 merged 的"只改默认值"。
2. **恢复 WorkBuddy Access Token 卡片**，按 provider 显示：选 Codex 只露 Codex 两张卡，
   选 WorkBuddy 露出 token 卡。注释隐藏是最差状态，这次彻底消灭。
3. **执行者下拉走 A 方案（诚实收窄）**：`codex` 可选；`workbuddy` / `claude` 置灰并给出可读原因
   （提示词助手目前固定走本地 Agent 的 Codex turn）。`PromptAssistantConfig.agentId` 保留但
   只作"用户意图"记录，注释里写清未消费 —— 不删，避免动节点 metadata 结构。

> 下面第 6 节原为开放问题，保留作决策依据。


1. 默认 provider 定 `codex` 还是保留 `workbuddy`、只加显式选择？（merged 选了前者）
2. WorkBuddy 卡片是**恢复**还是**彻底移除**？现在注释隐藏是最差状态。
3. 执行者选择走 A（诚实收窄）还是 B（两套 turn 全通）？
4. `plugins/infinite-canvas/` 的 README 要不要写「从本仓目录 `codex plugin marketplace add`」
   这条本地安装法（merged 有），还是只讲市场安装？
