# 多人实时协同服务部署指南 (DEPLOY-Collaboration)

本文档详细说明 infinite-canvas 多人实时协同服务（Canvas Collaboration Service）的**架构原理、生产环境部署流程、systemd 守护进程配置、Nginx 反向代理配置及故障排查方法**。

---

## 1. 架构原理与核心机制

协同服务基于 **“房主本地算力 + 公网双通道中继”** 架构设计：

```
                ┌───────────────────────────────────┐
                │   公网生产服务器 (114.55.54.9)       │
                │                                   │
                │  Nginx (canvas.imihoo.com)        │
                │    ├─ location / (前端静态 SPA 页面) │
                │    ├─ location /ws/collab ────────┼───► 本地 Node 协同服务 (:3002)
                │    └─ location /api/collab/ ──────┼───► (信令广播 + 媒体资产流式中继)
                └───────▲───────────────────▲───────┘
                        │                   │
       WSS/HTTPS 协同通信│                   │ WSS/HTTPS 观看与下载
                        │                   │
            ┌───────────┴───┐           ┌───┴──────────┐
            │  房主 (Host)  │           │ 协作者 (Viewer)│
            │  (创作者电脑)  │           │ (全球任意访客) │
            └───────▲───────┘           └──────────────┘
                    │ 本地直连 (127.0.0.1:8188)
            ┌───────┴───────┐
            │ 本地 ComfyUI  │ (算力与模型隐私留在房主本地，
            │ (无需公网暴露) │  协作者零 GPU / 零门槛)
            └───────────────┘
```

### 核心设计特性：
1. **算力与隐私留在本地**：房主依然在自己的电脑直连本机 ComfyUI（`127.0.0.1:8188`），ComfyUI 端口**无需对外暴露**，服务器不需要任何 GPU 显卡。
2. **房主特权独占（Host-Authority）**：公网协作者通过链接进入天然为只读（Viewer）权限，无法修改画布、无法触发生成，杜绝盗刷算力；协作者可实时同步视口、观摩生成进度与下载原画/原视频。
3. **公网轻量中继**：
   - **WebSocket 信令（`/ws/collab`）**：同步光标位置、节点位置增量补丁（Patch）、生成状态机事件。
   - **媒体资产流式中继（`/api/collab/assets/`）**：房主生成完成后切片上传，服务器做磁盘缓存并支持 HTTP 206（Partial Content）分片流式播放，保障大视频秒开与原画快速下载。

---

## 2. 部署前置条件

- **操作系统**：Linux（推荐 Ubuntu 20.04 / 22.04 / 24.04）
- **Node.js**：`>= 18.0.0`（生产环境已验证 Node `v22.20.0`）
- **Web 服务器**：Nginx（已配置好 SSL 证书）
- **端口约定**：协同服务默认监听本地 `127.0.0.1:3002`（由 Nginx 在本机反向代理，**无需在安全组/防火墙开放 3002 外网端口**）

---

## 3. 服务器部署步骤

### 步骤 1：准备服务端目录与脚本

在服务器上创建专用目录，并从仓库 `web/server/` 同步服务端脚本：

```bash
# 1) 在服务器创建协同服务工作目录
mkdir -p /var/www/canvas-collab
cd /var/www/canvas-collab

# 2) 上传仓库 web/server/ 中的脚本（从本地开发机执行 scp）
# scp web/server/standalone.mjs web/server/collab-server.mjs root@<服务器IP>:/var/www/canvas-collab/

# 3) 初始化 npm 并安装依赖（仅依赖轻量 ws 库）
npm init -y
npm install ws --save

# 4) 设置运行权限为 www-data
chown -R www-data:www-data /var/www/canvas-collab
```

### 步骤 2：配置 systemd 常驻守护服务

使用 Linux 原生 `systemd` 守护进程，具备开机自启与崩溃自动拉起能力。

创建服务文件 `/etc/systemd/system/canvas-collab.service`：

```ini
[Unit]
Description=Infinite Canvas Collaboration Service
After=network.target

[Service]
Type=simple
User=www-data
Group=www-data
WorkingDirectory=/var/www/canvas-collab
ExecStart=/usr/local/bin/node /var/www/canvas-collab/standalone.mjs
Restart=always
RestartSec=3
Environment=NODE_ENV=production
Environment=COLLAB_PORT=3002

[Install]
WantedBy=multi-user.target
```

> **提示**：若服务器 Node 路径不同，可通过 `which node` 查看并替换 `ExecStart` 中的 node 路径。

启动并设置开机自启：

```bash
systemctl daemon-reload
systemctl enable --now canvas-collab

# 检查运行状态
systemctl status canvas-collab --no-pager
```

### 步骤 3：配置 Nginx 反向代理

打开站点配置文件（如 `/etc/nginx/sites-available/canvas.imihoo.com`），在 `server { listen 443 ssl; ... }` 配置块内追加以下代理规则：

```nginx
    # 1) 多人实时协同 WebSocket 路由 (WSS)
    location /ws/collab {
        proxy_pass http://127.0.0.1:3002;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
    }

    # 2) 协同媒体资产流式中继 (支持大图片/长视频 HTTP 206 流式分片中继与下载)
    location /api/collab/ {
        proxy_pass http://127.0.0.1:3002;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Host $host;
        client_max_body_size 100M;
        proxy_buffering off;
    }
```

测试配置合法性并平滑重载：

```bash
nginx -t && nginx -s reload
```

---

## 4. 验证服务运行状态

在服务器上执行以下命令进行回环与代理验证：

```bash
# 1. 验证 3002 本地服务监听
ss -tulpn | grep 3002

# 2. 验证公网代理接口返回（正常返回 {"ip":null}，安全屏蔽私有 IP）
curl -sk https://127.0.0.1/api/collab/network-ip -H "Host: canvas.imihoo.com"

# 3. 验证 WebSocket Upgrade 代理握手
curl -sk -i -N \
  -H "Connection: Upgrade" \
  -H "Upgrade: websocket" \
  -H "Host: canvas.imihoo.com" \
  -H "Sec-WebSocket-Key: SGVsbG8sIHdvcmxkIQ==" \
  -H "Sec-WebSocket-Version: 13" \
  https://127.0.0.1/ws/collab | head -5
```

---

## 5. 运维与常见问题排查

### 1. 查看协同服务实时运行日志
```bash
journalctl -u canvas-collab -f -n 50
```

### 2. 重启协同服务
```bash
systemctl restart canvas-collab
```

### 3. 上传大视频报错 `413 Request Entity Too Large`
- **原因**：Nginx 默认限制客户端请求 Body 较小（通常为 1MB）。
- **解决**：确认 Nginx `/api/collab/` 配置块中包含 `client_max_body_size 100M;`。

### 4. 媒体资产磁盘缓存轮转
协同过程中上传的图片和视频缓存在 `/var/www/canvas-collab/.collab-cache/`。若磁盘空间紧张，可随时安全清理：
```bash
# 清理 7 天前的历史协同缓存
find /var/www/canvas-collab/.collab-cache/ -type f -mtime +7 -delete
```
