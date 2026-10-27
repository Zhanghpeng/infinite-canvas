# 资产去重

重复是怎么来的、在哪里被挡住、什么情况下挡不住。改这一块之前先读完。

## 三层，各管一件事

| 层 | 管什么 | 实现 |
| --- | --- | --- |
| 存储层 | 同一份字节只落一个文件 | 存储键 = `<kind>:<内容指纹>`（`lib/storage/content-fingerprint.ts`） |
| 资产层 | 同一件东西只有一个条目 | `findDuplicateAsset` / `assetIdentityKeys`（`lib/canvas/asset-dedupe.ts`） |
| 清理层 | 该留的别删 | `cleanupUnusedImages` / `cleanupUnusedMedia` 的引用扫描 |

只做前两层里的任何一层都不够：

- 只做存储层：盘上只有一份，但资产库里会排出一串指向同一文件的重复卡片。
- 只做资产层：库里干净，但"从画布收藏一张图"和"手动上传同一张图"仍然是两个文件。

## 存储层：内容指纹

以前键是 `<kind>:<nanoid>`，每上传一次换一个名字 —— 同一张图先拖进画布、再收藏进资产库、再被另一个画布引用，磁盘上就是三份。现在键变成 `<kind>:<sha>`，`setBlob` 到同一个键天然等于"只有一份"。

指纹算法（`fingerprintBlob`）：

- 结果形如 `<size36>-<hash前32位>`。**大小写在键里是硬约束**，它保证不同大小的文件绝不会被并到一起。
- `≤ 512KB` 整份算，等于真正的 SHA-256。
- 更大的文件取首/中/尾各 128KB。**这是明确的取舍**：几百 MB 的成片不整份读进 JS 堆。落在采样区之外的差异分辨不出来，`content-fingerprint.test.ts` 里有一条用例专门把这个盲区钉住了 —— 要改就一起改那里。
- `crypto.subtle` 拿不到（http 局域网访问不是安全上下文）时退回四路 FNV-1a。

写入前先问 `hasBlob`：键已在盘上就跳过整份写入。本地服务 / 目录句柄后端都实现了（查目录，不读字节）；IndexedDB 没实现，走"直接覆盖同一个键"，同样不会膨胀。

> 键前缀（`image:` / `video:` / `audio:` / `file:`）必须保留 —— `use-canvas-collab` 靠它判断一条引用是不是媒体，`canvas-export` 靠 `image:` 区分图片桶和媒体桶。

## 资产层：身份键

`assetIdentityKeys` 按类型给出"这两条是不是同一件东西"：

| 类型 | 身份 |
| --- | --- |
| 图片 / 视频 / 音频 | 存储键；没有存储键时用 `data:` 内联内容 |
| 文本 | 正文（首尾空白不计） |
| 组合 | 成员 + 槽位的集合，顺序无关；成员全失效的组合不参与 |

几条必须知道的边界：

- **URL 不算身份**。`blob:` 每次 `createObjectURL` 都不同，`https:` 只是来源地址，都不能证明是同一份字节。
- **槽位变了就是另一个组合**。同一个素材当主图还是当参考，是两种用法。
- **命中时不改标题**，只并标签、补空的来源/备注。用户改过的名字不能被"画布图片"这类默认标题盖掉。
- `addAsset` 内部就会去重（返回已有 id，所以导入包里 `oldId → newId` 的映射天然指向原条目）；需要提示"这次没新增"的调用方用 `addAssetDetailed`，拿 `duplicate`。

接入过的路径：画布节点/分组收藏（`pushAsset`）、侧栏批量上传、资产页新建与打包、资产包导入、提示词库加库、Agent 的 `assets_add`（返回体里带 `duplicate`）。

## 清理层：别误删

去重之后一份文件会被多处引用，清理逻辑错了就是数据丢失。两个必修点：

1. **扫引用前先补齐懒加载项目的图**。本地存储 v2 启动只读索引，未打开的项目在内存里 `nodes` 是空数组 —— 直接扫会把它们的媒体全判成"未引用"。`cleanupImages` 里先 `ensureProjectGraphs`。
2. **图读不出来就整轮放弃清理**。`ensureProjectGraphs` 遇到读不到的项目会保持 `lazy`，清理侧见到残留 `lazy` 直接 `return`。少删几个孤儿文件可以接受，误删用户的素材不行。

## 已有数据不会自动收拢

改之前落盘的老键是 `<kind>:<nanoid>`，同一张图的多份副本仍在磁盘上。现在的行为是"新的收敛，旧的等清理"：

- 老副本一旦不再被任何资产/画布引用，会被 `cleanupUnusedImages` / `cleanupUnusedMedia` 删掉。
- 仍被引用的老副本会一直留着 —— 要用它没有意义地重写一遍才能换成指纹键。

批量收拢（读所有媒体算指纹 → 归并键 → 改写全部引用）是一轮独立工作，涉及跨画布引用改写，没做。真要做的时候注意：引用分布在 `projects/<id>/graph.json`、资产库、`image_logs` / `video_logs` 三类地方，漏一处就会出现"文件在、但谁也不认"的悬空引用。

## 验证

```bash
cd web
./node_modules/.bin/vitest.exe run src/lib/canvas/__tests__/asset-dedupe.test.ts src/lib/storage/__tests__/content-fingerprint.test.ts

# 真实本地服务：指纹同键、hasBlob、重复写只落一份
IC_LOCAL_SERVICE_URL=http://127.0.0.1:17400 IC_LOCAL_SERVICE_TOKEN=<token> \
  ./node_modules/.bin/vitest.exe run src/lib/storage/__tests__/local-service.test.ts
```
