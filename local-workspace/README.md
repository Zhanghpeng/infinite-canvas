# local-workspace

Infinite Canvas **本地模式**的工作区文件服务。

它把用户选定的工作区目录，通过一组受控的文件读写 API 暴露给画布前端，让画布项目与素材以**普通文件**形式落盘、可被文件管理器与其它工具读写，并可整体迁移。

## 启动

```bash
cd local-workspace
npm install
node index.js
# 或指定工作区目录
node index.js --workspace /path/to/my-canvas-workspace
# 或指定监听地址（默认 127.0.0.1；前端经端口转发/IP 访问时用 0.0.0.0）
node index.js --host 0.0.0.0
```

启动后输出：

```text
Local workspace URL: http://127.0.0.1:17400
Workspace path: /home/<user>/InfiniteCanvasWorkspace
Connect token: <hex>
```

在画布「设置 → 存储位置」中选择「本地目录」，填入地址与 token 即可。

## 配置

默认写在 `~/.infinite-canvas/local-workspace.json`（目录 0700、文件 0600），首次启动自动生成：

```json
{
    "port": 17400,
    "host": "127.0.0.1",
    "token": "<随机 hex>",
    "workspacePath": "/home/<user>/InfiniteCanvasWorkspace",
    "origins": []
}
```

- 端口可用环境变量 `PORT` 覆盖。
- 监听地址可用 `--host` 或环境变量 `HOST` 覆盖。默认 `127.0.0.1` 只允许本机访问；若前端通过端口转发或机器 IP 打开画布，需设为 `0.0.0.0`，否则浏览器连不上。
- 工作区目录可用 `--workspace` 覆盖。
- `--host` / `--workspace` 一旦传入会写回配置，后续重启沿用。
- `origins` 记录已放行的页面来源（首次连接自动加入 localhost 来源）。

## 安全

- 默认只监听 `127.0.0.1`，不对外暴露。
- 若因端口转发/远程访问需要设为 `--host 0.0.0.0`，服务会监听所有网卡（局域网可达）；此时依赖 token 校验与 Origin 白名单保护，请勿在不可信网络下开启。
- 除 `/health` 外，所有请求需带 `x-workspace-token`（或 `?token=`）。
- Origin 白名单：只放行显式记录或 localhost 来源，其余 403。
- 路径安全：所有 `path` 参数解析后必须落在工作区根内，越界一律 400 拒绝。

## 工作区目录

```
<workspacePath>/
  workspace.json                # 工作区清单（版本 + 项目索引 + 删除墓碑）
  projects/<id>/project.json    # 一个画布项目一个文件
  assets/                       # 全局素材（所有项目共享）
    images/  media/             # 图片 / 视频音频，文件名为 <键>.<真实扩展名>
  .meta/
    cache/  logs/  backups/
```

素材按**工作区全局**管理（不归属单个项目），由 `project.json` 中的 `storageKey` 引用。`.meta/cache` 下的缩略图为可再生缓存，可安全删除。

`workspace.json` 由服务维护（`/workspace/init` 初始化、后续由前端更新）。由于清单自描述（`app` + `version`）且引用均为相对路径，**复制整个工作区目录即可在另一台机器或另一个画布实例中使用**。

## API

| 方法 | 路径 | 参数 | 说明 |
| --- | --- | --- | --- |
| GET | `/health` | — | 探活（免鉴权） |
| GET | `/workspace` | — | 读工作区清单 |
| POST | `/workspace/init` | `{ path? }` | 初始化工作区目录结构 |
| GET | `/files` | `dir`, `recursive` | 列目录 |
| GET | `/file` | `path` | 读文件（二进制流） |
| PUT | `/file` | `path`, 请求体为内容 | 写文件（流式落盘，不受 JSON 体积限制） |
| DELETE | `/file` | `path` | 删除文件或目录 |
| POST | `/file/rename` | `{ from, to }` | 重命名 / 移动 |

## 超时约定

- 前端探活超时 1500ms：超时即判定服务不可用，回退浏览器模式。
- 文件读写超时 30s：超时直接报错，不重试。

## 说明

- 该服务与 `canvas-agent`（Codex/MCP）、`canvas-proxy`（CORS 转发）职责独立，不互相依赖。
- 服务端不保存业务数据，只做文件系统读写与工作区清单维护。
