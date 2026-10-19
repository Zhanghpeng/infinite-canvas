# 三批功能迁移方案

> 来源：`F:/canvas/infinite-canvas-merged-24fd83d`
> 落点：本仓库 `main`（v0.19.19）
> 日期：2026-10-19

---

## 0. 方法论

合并版是从 **main v0.19.7（2026-10-07）** 上叠出来的，本仓库已经是 **v0.19.19（2026-10-19）**，
中间隔了 12 个版本。**不能整目录覆盖**，否则会把 v0.19.8 ~ v0.19.19 的上游成果全部回退。

因此用 `v0.19.7` 标签做**三方比对**：

| 角色 | 来源 |
| --- | --- |
| 基线 base | `git archive v0.19.7`（本仓库 tag，587 文件） |
| 我方 ours | 本仓库 `main` HEAD（v0.19.19） |
| 对方 theirs | `infinite-canvas-merged-24fd83d/infinite-canvas-merged` |

比对前统一归一化行尾（CRLF→LF），排除 `.git` / `node_modules` / `dist` / `.vite` / `.dev-logs`。

### 全仓比对结果（826 个文件参与）

| 分类 | 含义 | 数量 | 处理方式 |
| --- | --- | --- | --- |
| `same` | 三方一致 | 439 | 不动 |
| `theirs-only-change` | base==ours，对方独有改动 | 257 | **可直接搬** |
| `ours-only-change` | base==theirs，我方上游演进 | 95 | **保留我方** |
| `CONFLICT` | 三方各不同 | **31** | 手工三方合并 |
| `both-same` | ours==theirs（都不同于 base） | 4 | 视为已具备 |

**真冲突只有 31 个**，其中还有一批属于"云 API 移植"（`use-config-store`、`channel-editor-drawer`、
`app-config-modal`、`home`、`pricing`、`router` 等），与本次三批功能无关。

---

## 1. 批次一：本地目录的使用与配置

### 1.1 覆盖范围

合并版把"纯浏览器 IndexedDB"升级成"浏览器 / 本地文件系统双模式"，涉及四层：

| 层 | 交付物 |
| --- | --- |
| 本地服务 | `local-workspace/`（Express，127.0.0.1:17400）文件 API + 工作区管理 |
| 本地代理 | `canvas-proxy/`（127.0.0.1:23210）纯 CORS 转发，给云 API 用 |
| 存储抽象 | `web/src/lib/storage/` 双后端（IndexedDB / LocalFs）+ 运行期门面 |
| 配置 UI | 存储位置页签、首次引导、本地代理配置页 |
| 项目目录 | 一项目一目录、`workspace.json` 清单、项目内素材归属 |

规格依据：`local-canvas-app/product-design.md`、`local-canvas-storage/{doc,tasks,summary}.md`、
`project-asset-scope/summary.md`。

### 1.2 文件清单（实测）

**专属新增 36 个，全部 `theirs-only-change`，零冲突：**

```
local-workspace/{README.md,index.js,package.json,package-lock.json}
canvas-proxy/{README.md,index.js,package.json}
scripts/{dev,package,setup,stop}.sh
start-canvas.bat

web/src/lib/storage/
  types.ts  index.ts  bootstrap.ts  storage-prefs.ts  storage-layout.ts
  indexeddb-backend.ts  local-fs-backend.ts  fsa-backend.ts  fsa-handle.ts
  path-io.ts  blob-store.ts  local-canvas-storage.ts
  __tests__/project-assets.test.ts

web/src/stores/use-storage-store.ts
web/src/services/api/{local-workspace.ts,local-proxy.ts}
web/src/services/{local-migration.ts,storage-self-check.ts}
web/src/components/layout/{config-storage.tsx,config-local-proxy.tsx,storage-onboarding.tsx}
web/src/components/canvas/workspace-bar.tsx
web/src/hooks/use-workspaces.ts
web/src/types/file-system-access.d.ts
```

**接线点 8 个，其中 7 个可整文件替换：**

| 文件 | 状态 | 说明 |
| --- | --- | --- |
| `web/src/main.tsx` | theirs-only | 启动时序改造（先解析后端再动态导入） |
| `web/src/lib/localforage-storage.ts` | theirs-only | 内部改走门面，签名不变 |
| `web/src/services/image-storage.ts` | theirs-only | blob 读写走门面 |
| `web/src/services/file-storage.ts` | theirs-only | 同上 |
| `web/src/stores/canvas/use-canvas-store.ts` | theirs-only | 仅换 `storage` 实现 |
| `web/src/pages/image/index.tsx` | theirs-only | 生成日志走门面 |
| `web/src/pages/video/index.tsx` | theirs-only | 同上 |
| `web/src/services/app-sync.ts` | **same** | 三方一致，不用动 |
| `web/package.json` | **ours-only** | 需手工补依赖与脚本，不能覆盖 |

### 1.3 实施顺序（严格串行）

1. **本地服务先行**：`local-workspace/` 独立可跑 → 用 curl 验证 `/health`、`PUT/GET /file`、
   越界写 400、错 token 401。此步不碰前端，零风险。
2. **存储抽象层**：`lib/storage/*` 12 个文件整目录拷入。此时默认后端仍是 IndexedDB，**行为零变更**。
3. **改造调用点**：`localforage-storage` → `image-storage` → `file-storage` → `use-canvas-store`。
   每改一个跑一次 `typecheck`。
4. **启动时序**：`main.tsx`。**这是最容易出错的一步**——必须先 `await resolveStorageBackend()`
   再动态 `import` 应用，因为 zustand store 在 import 阶段就会 rehydrate，顺序反了会读到错的后端。
5. **配置 UI**：`config-storage.tsx` / `storage-onboarding.tsx` / `workspace-bar.tsx` + i18n。
6. **迁移与自检**：`local-migration.ts`（复制不移动，浏览器侧数据保留）、`storage-self-check.ts`。
7. **素材跟随项目**：`storage-layout.ts` 的 `projectIdFromKey` / `scopeDirForKey`，
   **键带项目 `image:<projectId>:<id>`**，旧键 `image:<id>` 继续解析到全局目录，零迁移。

### 1.4 风险点

| 风险 | 应对 |
| --- | --- |
| 启动时序错 → 读到 IndexedDB 却在写本地 | 单步验证：启本地后端后确认网络面板无 localforage 请求 |
| 两套数据"整包 vs 分项目"混写 | 不做无感迁移，只走显式"导入现有数据"按钮 |
| 删除项目直接删文件 | 墓碑驱动：`deletedAt` 存在才移入 `.meta/backups/` |
| 本地服务端口冲突 | 17400 可通过 `PORT` 覆盖 |
| 规格自述"端到端未验证" | **本地模式必须浏览器实跑**，不能只过 tsc |

### 1.5 验收标准

- 浏览器模式（IndexedDB）功能与现在完全一致（零回归）
- 本地模式：初始化工作区 → 建项目 → 画布节点落盘为普通文件 → 能在文件管理器里打开
- 素材写入 `projects/<id>/assets/images|media`，旧素材仍可读
- 本地服务不可达时启动有明确提示并回退浏览器模式
- `tsc` 不新增错误；`vitest` 不新增失败

---

## 2. 批次二：画布资产管理

### 2.1 覆盖范围

| 子项 | 交付物 |
| --- | --- |
| 音频资产 | `AssetKind` 增 `audio`，播放器、波形封面、导入导出、插入音频节点 |
| 组合资产（角色包） | `AssetKind` 增 `bundle`，槽位引用不复制，禁止嵌套，`BundleConnection` |
| 组合插入画布 | 插入时按 `entries[].position/size` 布局，按 `connections` 建连线 |
| 分组折叠 / 锁定 | 组节点 `metadata.collapsed/locked`，隐藏后代、阻断拖拽缩放删除连线 |

规格依据：`asset-model/`、`project-asset-scope/`、`canvas-group-collapse-lock/{doc,tasks,summary}.md`。

### 2.2 文件清单与合并成本（实测）

| 文件 | 功能改动 | 上游演进 | 难度 |
| --- | --- | --- | --- |
| `stores/use-asset-store.ts` | 45 行 | 6 行 | 易 |
| `components/canvas/asset-picker-modal.tsx` | 113 行 | 15 行 | 易 |
| `components/canvas/canvas-context-menu.tsx` | 80 行 | 9 行 | 易 |
| `components/canvas/canvas-node-hover-toolbar.tsx` | 282 行 | 80 行 | 中 |
| `components/canvas/canvas-node.tsx` | 130 行 | 119 行 | 中 |
| `pages/canvas/project.tsx` | **1439 行** | **1043 行** | **难** |

可直接搬的 6 个：`lib/canvas/canvas-group-collapse.ts`、`pages/assets/{index.tsx,asset-transfer.ts}`、
`types/canvas.ts`、`components/canvas/__tests__/asset-picker-payload.test.ts`、
`lib/canvas/__tests__/canvas-group-collapse.test.ts`。

### 2.3 实施顺序

1. **数据层**（`use-asset-store.ts`、`types/canvas.ts`）：先让 `Asset` 联合类型成立，
   此时 UI 还不认识 audio/bundle，但类型检查会逐个指出待补点。
2. **资产页**（`pages/assets/`）：过滤项、上传表单、预览、导入导出扩展名。
3. **选择器**（`asset-picker-modal.tsx`）：bundle 可展开挑单项，或整包插入。
4. **画布插入**（`project.tsx` 的 `insertAssetBundle`）：**这是本批最大工作量**，
   需在 v0.19.19 的 `project.tsx`（5183 行）里重新落一遍，而不是覆盖文件。
5. **分组折叠锁定**（`canvas-group-collapse.ts` + `canvas-node.tsx` + 工具栏 + 右键菜单）。
   折叠/锁定逻辑本身是新增函数，干扰小；麻烦的是 `canvas-node.tsx` 的 `GroupNodeContent` 要
   与上游新增的节点能力共存。

### 2.4 风险点

| 风险 | 应对 |
| --- | --- |
| `project.tsx` 两边各改一千多行 | **不整文件覆盖**，按功能点逐个移植，每点一次 commit |
| 上游 v0.19.8+ 新增了音频节点能力，与 bundle 的 audio 语义可能重叠 | 先读上游 `CanvasNodeType.Audio` 现状，避免造两套 |
| 删除资产时组合内引用悬空 | `items` 只存 `assetId`，删除前需查引用（规格已提，需落实） |
| 折叠改变渲染列表，可能与上游新增的视口裁剪冲突 | 折叠过滤接在 `visibleNodes` 之后，不替换原逻辑 |

### 2.5 验收标准

- 资产页支持四种原子类型 + 组合，过滤、搜索、分页正常
- 组合资产插入画布后，节点位置/尺寸/连线与资产定义一致
- 分组折叠：收成标题条、隐藏后代与相关连线；展开原样恢复
- 分组锁定：拖拽/缩放/删除/连线全部被拦，且可撤销
- 旧数据（无 `collapsed/locked` 字段）零迁移

---

## 3. 批次三：3D 导演台插件

### 3.1 覆盖范围

`plugins/canvas/director-stage/` —— 以**插件**形态实现的 3D 场景编排台：

- 3D 舞台与相机（`stage.ts` / `stage-state.ts` / `editor.ts`）
- 灯光预设（`lighting.ts`）、背景板（`backdrop.ts`）、构图标记（`markers.ts`）
- 运镜与运动导出（`motion.ts` / `video.ts` / `exporter.ts`，含 `mp4-muxer` 合成）
- 资产库与用户模板（`library.ts` / `assets.ts` / `templates.ts` / `scenes.ts`）
- 提示词生成（`prompt.ts`）、自检（`check.ts`）、命令通道（`commands.ts`）

### 3.2 文件清单（实测）

**45 个文件全部 `theirs-only-change`，零冲突：**

```
plugins/canvas/director-stage/
  package.json  build.mjs  tsconfig.json  README.md  package-lock.json
  src/ 24 个源文件（index.tsx + 23 个模块）
  dist/director-stage.js（914 KB 构建产物）
web/public/plugins/{index.json, director-stage.js}
web/src/lib/canvas/__tests__/director-stage-*.test.ts（11 个）
docs/content/docs/development/director-stage-state{,.zh-CN}.mdx
```

### 3.3 兼容性核查结论

插件只依赖 SDK 的 `definePlugin` / `useEffect` / `useState` 和几个类型，**没有反向依赖宿主业务模块**，
自包含程度很高。SDK 差异极小：

- `plugins/canvas/sdk/src/types.ts`：`connect_nodes` 操作增加 `slot?: "first_frame" | "last_frame"`
  （导演台用它把机位 A/B 接到首帧/尾帧槽位）
- `jsx-runtime.ts`：`createElement` 修正 children 传递方式以消除 dev 下的唯一 key 警告

**注意**：`types.ts` 与 `jsx-runtime.ts` 在本次比对中是 `theirs-only-change`（我方未改），
可直接覆盖；但 `plugins/canvas/sdk/README.md` 等若后续也要合并，需留意上游是否已独立演进。

### 3.4 实施顺序

1. 覆盖 SDK 两个文件 → `typecheck`
2. 整目录拷入 `plugins/canvas/director-stage/src`（**先不带 dist**，本地构建验证）
3. `web/public/plugins/` 放构建产物 + `index.json` 注册
4. 拷入 11 个测试，跑 `vitest`（测试用相对路径 `../../../../../plugins/...` 直接引源码，无需额外配置）
5. 文档两份 mdx

### 3.5 风险点

| 风险 | 应对 |
| --- | --- |
| `dist/` 914 KB 是否入版本库 | 建议**不入**，改为构建产物 + `.gitignore`；但 `public/plugins/` 需要有产物才能加载，需在 `package.sh` 里加构建步骤 |
| `mp4-muxer` 依赖 | 检查 `package.json` 已声明，安装时注意走代理 |
| WebGL 在无 GPU 环境退化 | 插件已有 `webgl-check.html`，加载前自检 |
| 插件体积/首屏 | 插件是懒加载还是启动即载，需确认 `index.json` 机制 |

### 3.6 验收标准

- 插件能在画布节点菜单里创建，3D 视口可操作
- 机位导出为 first_frame / last_frame 连线槽位生效
- 运镜可导出 mp4
- 11 个单测全绿

---

## 4. 执行顺序与依赖

```
批次一（本地存储）
  └─ 是批次二「素材跟随项目目录」的前置（blob-store 在 lib/storage 里）

批次二（资产 / 组合 / 分组）
  └─ 是批次三「导演台资产库」的体验前置（非硬依赖）

批次三（导演台插件）
  └─ 技术上独立，只依赖 SDK 两个文件
```

**建议顺序：一 → 二 → 三**。理由：批次一是地基且零冲突，最快见效；批次二冲突最多、
最需要精力；批次三最独立，适合放在最后收尾，或者**提前到空闲时段插队**（它不影响前两批）。

## 5. 每批的固定交付动作

- 独立分支：`feat/local-storage` / `feat/asset-bundle` / `feat/director-stage`
- 提交粒度：一个功能点一个 commit，`feat(scope): 中文描述`
- 每批结束跑：`web` typecheck + test + format:check；`canvas-agent` test + build
- 合并前 `git fetch upstream && git merge upstream/main`，避免二次脱节
- 每批结束更新 `CHANGELOG.md` 与 `docs/content/docs/progress/`

## 6. 明确不做

- 不做整目录覆盖（会回退 v0.19.8~v0.19.19 上游成果）
- 不迁移"云 API 移植"相关文件（`use-config-store`、`channel-editor-drawer`、`pricing`、`router` 等），
  那是合并版另一条主线，与本次三批目标无关
- 不做浏览器 → 本地的自动迁移，只提供显式按钮
- 不动 `core.autocrlf`，不新增 `.gitattributes`（避免与上游产生分叉点）

---

## 7. 执行记录

### 7.1 批次一（本地目录）——已完成

分支 `feat/local-storage`。落点与验证结果：

| 项 | 结果 |
| --- | --- |
| `local-workspace` 服务 | 冒烟通过：`/health`、`PUT/GET/DELETE /file`、`/file/rename`、`/files`（含递归） |
| 鉴权 | 无 token / 错 token 均 401；`/health` 按设计不鉴权 |
| 路径越界 | `../`、URL 编码 `%2e%2e%2f`、绝对路径注入 全部 400 |
| `web` typecheck | 64 个错误 = 主干基线（±0） |
| `web` vitest | 9 个失败 = 主干基线（±0），另新增 3 个存储单测通过 |
| `web` build | 通过 |
| 本地服务集成测试 | `src/lib/storage/__tests__/local-service.test.ts` 6 个用例全通过 |

**与计划的三处修正（实测推翻了原判断）：**

1. **`pages/image/index.tsx`、`pages/video/index.tsx` 不属于批次一。**
   三方比对把它们归为"对方独有改动"，但实际差异全部是**渠道工作流选择器**
   （`workflowIds` / `getChannelWorkflows` / `ModelPicker.workflowGroup`），与存储无关。
   整文件替换会连带引入对 `use-config-store` 的依赖，已回退。

2. **`config-local-proxy.tsx` + `services/api/local-proxy.ts` 推迟。**
   它们依赖 `use-config-store` 的 `proxyUrl` / `proxyEnabled` / `normalizeLocalProxyUrl`，
   属于"渠道工作流 + 本地代理"那条主线。`canvas-proxy/` 服务本身保留（独立可跑），
   但其设置界面留到那条主线一起做。

3. **主干并非干净基线。** v0.19.19 自带 64 个 typecheck 错误、9 个 vitest 失败
   （集中在 `services/api/__tests__/comfyui.test.ts`、`stores/__tests__/use-config-store.test.ts`，
   另有 `project.tsx` 里 `setAngleNodeId` 未定义、`workflow-editor` 里 `useTranslation` 未导入）。
   因此验收标准改为"不新增"，而非"全绿"。

**修复的两个真实缺陷（合并版从未端到端验证，规格自己也承认）：**

| 缺陷 | 现象 | 修复 |
| --- | --- | --- |
| `express.json()` 全局挂载 | 前端写 JSON 内容用的是 `application/json` 类型的 Blob，`PUT /file` 的请求体被 json 中间件提前消费，落盘为 **0 字节**——本地模式下所有配置持久化全部失效 | 改为只在 `POST /workspace/init`、`POST /file/rename` 上挂载 |
| 响应无缓存头 | `GET /files` 被浏览器/测试环境的 fetch 缓存，写完文件立刻列目录仍返回旧结果 | 统一 `Cache-Control: no-store` |

另外补了一处 MIME 还原：本地服务读文件统一返回 `application/octet-stream`，
在 `blob-store.getBlob` 里按扩展名还原 `blob.type`，否则本地模式下 `<audio>` / `<video>` 拿到无类型 blob。

**其他调整：**

- `local-workspace/package-lock.json` 原文件 68 个 `resolved` 全指向 `registry.npm.baidu-int.com`
  （内网地址，外网 `npm ci` 直接失败）。已用官方源重建，`npm ci` 实测 1 秒完成。
- `scripts/package.sh` 未迁入：它假设合并版目录结构（`cd infinite-canvas-merged`）与一个不存在的 specs 路径，在本仓库是坏的。
- `scripts/setup.sh` 的源探测顺序改为 npmmirror 优先（实测比官方快约 10 倍）。
- `start-canvas.bat` 重写：原文件写死了合并版的绝对路径，改为相对脚本位置的路径。
- 未改动 `web/package.json`：存储功能没有引入任何新依赖。
- `web/bun.lock` 未改动（上游的 lock 缺 `ws` 声明，与本批次无关，不动）。

