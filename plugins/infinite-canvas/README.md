# Infinite Canvas Plugin（Codex / ZCode）

让 Codex / ZCode 打开并操作 Infinite Canvas：插件自带 MCP 配置与两个技能，
装上之后在 Codex 里说一句「帮我打开并连接到 Infinite Canvas」即可。

## 这个目录里有什么

```text
plugins/infinite-canvas/
├── .codex-plugin/plugin.json   # Codex 插件清单（skills + mcpServers）
├── .mcp.json                   # MCP 服务：npx -y @zhuyichuan/canvas-agent mcp
├── .zcode-plugin/plugin.json   # ZCode 插件清单
├── marketplace.json            # 本地 marketplace（.agents/plugins/marketplace.json 指向它）
├── skills/canvas/SKILL.md      # 操作画布的技能说明
├── skills/open-canvas/SKILL.md # 打开画布并自动连上本地 Agent
└── assets/icon.png
```

两条链路的分工（很容易混）：

- **MCP 进程**（`canvas-agent mcp`）：给 Codex 提供 `canvas_*` 工具，只走 stdio，不提供网页连接服务。
- **普通 Agent 进程**（`canvas-agent`）：提供 `Local URL` 与 `Connect token`，网页靠它连。
  两个进程读同一份本地配置（`~/.infinite-canvas/`），所以不需要手动填地址。

## 安装（本仓库内，推荐）

```bash
# 在仓库根目录执行
codex plugin marketplace add "$(pwd)"
codex plugin add infinite-canvas@infinite-canvas-local
```

Windows PowerShell 用 `"$PWD"`，Windows CMD 用 `%cd%`。

装完新建一个 Codex 任务，输入「帮我打开并连接到 Infinite Canvas」——
`open-canvas` 技能会起本地 Agent、带上连接信息打开画布。

## 安装（从远端仓库）

```bash
git clone https://github.com/basketikun/infinite-canvas.git
cd infinite-canvas
codex plugin marketplace add "$(pwd)"
codex plugin add infinite-canvas@infinite-canvas-local
```

## ZCode

Settings → Plugin Management → Discover → 右上角 `+` 添加 marketplace，
选择本仓库目录或 `plugins/infinite-canvas`，即可发现并安装该插件。

## 卸载

```bash
codex plugin remove infinite-canvas
codex mcp remove infinite-canvas     # 手动加过 MCP 时才有这条要清
```

## 调试本地改动

`.mcp.json` 默认跑 npm 上的发布版（`npx -y @zhuyichuan/canvas-agent mcp`）。
改了 `canvas-agent/` 想立刻生效，先 `cd canvas-agent && npm run build`，再把 `args` 换成：

```json
["node", "<仓库绝对路径>/canvas-agent/dist/index.js", "mcp"]
```
