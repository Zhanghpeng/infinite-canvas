# 画布加载的磁盘 IO：从哪来、怎么降的

> 背景：本地存储模式下，把窗口关掉再打开，任务管理器里磁盘占用会冲一段时间；
> 项目越多、画布上视频越多，冲得越久。本文记录这轮排查的结论与改动。

## 一、先说结论

原来的加载链路有三笔强 IO，全部发生在"进画布之前"：

| # | 位置 | 干了什么 | 代价 |
|---|---|---|---|
| 1 | `createLocalCanvasStorage.getItem` | 启动时把工作区里**所有**项目的 `project.json` 读出来并 `JSON.parse` | 项目数 × 单项目文件大小，与"你要打开哪个画布"完全无关 |
| 2 | `hydrateCanvasImages` | 打开画布时把**每个节点**的图片/视频/音频读成 Blob，再 `createObjectURL` | 一个 200MB 的成片就要整份进内存；20 个视频节点 = 几个 GB 的读 |
| 3 | `writeWorkspaceCanvas` 热路径 | 任何状态变化（连平移缩放）都在 400ms 后重写整份 `project.json` | 拖动画布一次 = 整幅画布序列化 + 落盘 |

还有两笔放大器：

- 本地服务 `/file` 对所有响应都返回 `Cache-Control: no-store`，且不带 `Content-Type`、不支持 Range。刷新一次等于全部重读，视频也无法 seek 流式播放。
- `blob-store` 定位文件靠"列目录 + 找前缀"，而 `/files` 会对目录里**每个文件** `stat` 一次（结果还被上层丢弃）；并且目录缓存只缓存"已完成的结果"，打开画布时几十个媒体并发解析，第一批会同时 miss，把一次列目录放大成几十次。

## 二、改成了什么样

### 1. 落盘拆成两层

```
workspace.json              # 索引：每个项目一条元数据（标题/时间/视口/节点数/连线数/背景模式）
projects/<id>/graph.json    # 图：nodes / connections / chatSessions
```

- 启动：只读 `workspace.json`，项目以 `lazy` 骨架进入内存（`nodes: []` + `nodeCount`）。
- 打开项目：只读该项目自己的 `graph.json`，读到后 `setProjectGraph` 摘掉 `lazy`。
- 保存：`lazy` 项目**显式跳过**写图；已加载的项目按 `nodes/connections/chatSessions` 的**引用**比较，没变就不写。
- 因此"改视口"只重写几 KB 的索引，"改节点"才写图文件。

安全边界（改动时务必守住）：

- `CanvasProject.lazy` 是"图还没从磁盘读出来"的唯一标志，**落盘时看到 lazy 必须跳过**，否则会用空节点覆盖真实画布。
- `nodeCount` / `connectionCount` 在索引里维护，`lazy` 项目只能沿用索引里的旧值，不能用 `nodes.length`（那是 0）。
- 导出（`exportCanvasProjects`）与 WebDAV 同步（`app-sync`）前必须 `ensureProjectGraphs` 补齐，否则导出的是空画布。
- v1 索引仍可读：读完全量后异步按 v2 重写一份，旧的 `project.json` 保留不删（回滚时还能用）。

### 2. 媒体改走直链

`LocalFsBackend` 实现 `StorageBackend.mediaUrl(scope, key)`，返回

```
http://127.0.0.1:17400/file?path=projects/<id>/assets/media/video%3A...mp4&token=<token>
```

`resolveImageUrl` / `resolveMediaUrl` 优先用它；IndexedDB 与目录句柄（FSA）后端没有直链可给，仍回退 Blob + `objectURL`。

配套的服务端能力（`local-workspace/index.js`）：

- `Content-Type` 按扩展名给真实类型（`application/octet-stream` 会让 `<img>/<video>` 拒绝解码）。
- 单区间 `Range` → 206，`Accept-Ranges: bytes`：视频可 seek、可分段加载。
- `ETag`（size + mtime）+ `Last-Modified` + `Cache-Control: private, max-age=0, must-revalidate`：刷新命中 304，只 stat 不读盘。
  用协商缓存而不是 `immutable`，是因为同一个 storageKey 被重新生成时会覆盖同名文件。

两个必须注意的副作用：

- 直链是跨源的。`<img>` 只显示不需要 CORS，但任何 `drawImage` 出图的地方都会因 canvas 被标脏而抛 `SecurityError` —— `loadImage` 统一声明 `crossOrigin="anonymous"`，视频抽帧处（`withVideo` / `captureVideoFrame`）本来就有。
- 直链只在本机有效。协同广播用 `isEphemeralMediaUrl`（`lib/storage/direct-url.ts`）把它和 `blob:` 一视同仁，换成由 storageKey 派生的地址再发出去。

### 3. 目录列举

- `/files` 支持 `stat=false`：只 `readdir`，不逐个 `stat`。定位媒体只要文件名，`PathEntry` 本来也不带 size。
- 需要 size 时（默认）`stat` 改为**并行**发起，不再是串行循环。
- `blob-store` 的目录缓存改存 Promise，并发解析同一目录只发一次请求。

## 三、怎么自己验证

服务端（需要重启本地服务才生效）：

```bash
T=<token>; B=http://127.0.0.1:17400
# 真实类型 + 协商缓存 + Range
curl -s --noproxy '*' -D - -o /dev/null "$B/file?path=projects/<id>/assets/images/xxx.png&token=$T"
curl -s --noproxy '*' -D - -o /dev/null "$B/file?path=...&token=$T" -H "Range: bytes=0-3"   # 期望 206
curl -s --noproxy '*' -o /dev/null -w '%{http_code}\n' "$B/file?path=...&token=$T" -H "If-None-Match: <etag>"  # 期望 304
# 列目录两种模式
curl -s --noproxy '*' "$B/files?dir=.meta/logs/perftest&token=$T"           # 带 stat
curl -s --noproxy '*' "$B/files?dir=.meta/logs/perftest&stat=false&token=$T" # 只 readdir
```

实测 600 个文件：11ms → 2.5ms（热缓存；冷缓存与更大目录差距更明显）。

前端：

```bash
cd web
./node_modules/.bin/vitest.exe run src/lib/storage/__tests__/local-canvas-lazy.test.ts
# 对真实服务跑（另一个终端先起 local-workspace）
IC_LOCAL_SERVICE_URL=http://127.0.0.1:17400 IC_LOCAL_SERVICE_TOKEN=<token> \
  ./node_modules/.bin/vitest.exe run src/lib/storage/__tests__/local-service.test.ts
```

`local-canvas-lazy.test.ts` 用内存后端断言"读了什么、写了什么"，覆盖：只写索引不写 project.json、
lazy 不被空图覆盖、只改视口不重写图、图变了才重写、`ensureProjectGraphs` 补齐、v1 自动升级。

浏览器侧还可以看 Network：

- 打开画布时，媒体请求应该是 200/206 的 `/file?path=...`，而不是"没有请求但内存涨一大截"。
- 刷新页面，媒体应命中 304。
- 平移/缩放画布，Network 里**不应**出现 `PUT /file?...graph.json`（只会偶尔有 `workspace.json`）。

## 四、还没做的

- **图片仍是"每张定位一次"**：首次打开项目会 list 一次 `assets/images`（现在只 readdir）。目录极大（上万文件）时首屏仍会多一次几十毫秒的请求。
- **没有缩略图**：`image_previews` scope 已定义但没人写。画布缩到 5% 时仍加载原图；真要做需要在写入时生成预览，属于独立一轮。
- **节点没有视口裁剪**：所有节点都参与渲染与 hydrate，与"只加载看得见的部分"相比，超大画布（几百节点）仍有优化空间。
- **拖动节点仍会写整幅图**：现在只有"图引用变化"才写，拖动过程中每 400ms 仍会写一次。要更省得引入"拖动期间暂停持久化"。
