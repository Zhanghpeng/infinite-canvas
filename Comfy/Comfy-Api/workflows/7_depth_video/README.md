# ReShot 视频深度估计工作流 (Depth Video)

本工作流为系统内置的高性能视频单目深度估计流水线，基于 [ComfyUI-ReShot](https://github.com/maosika-ai/ComfyUI-ReShot) 与字节跳动开源的 **Video Depth Anything** 模型构建，支持纯前端浏览器直连自建 ComfyUI 原生 API 运行。

核心主打**「复制走位与运镜，不复制演员与画风」**：将输入参考视频的高清画面转换为连续稳定的时序深度灰度视频（近白远黑）。保留画面中人物的空间站位、肢体动作编排与摄像机运动轨迹，同时彻底剥离面孔身份、服装材质、光影氛围与原始画风。生成的深度视频可无缝作为下游视频扩散大模型（如 MiniMax H3、Seedance 2.5、Wan 等）或深度 ControlNet 的强结构条件输入，实现分镜复刻与角色重拍。

---

## 包含文件

- [API 格式工作流（画布直连执行）](./depth_video_api.json)
- [UI 可视化工作流（ComfyUI 导入查看编辑）](./depth_video_workflow.json)

---

## 模型信息

- **模型名称**: `Video Depth Anything Small`
- **论文与技术出处**: ByteDance CVPR 2025 (`depth-anything/Video-Depth-Anything-Small`, Apache-2.0 协议)
- **模型架构**: 单目视频时序一致性深度估计模型（以 32 帧时序重叠窗口逐帧预测相对逆深度并平滑对齐，整段做全局动态归一化导出 8-bit 灰度）
- **适用场景**:
  - 影视分镜、打斗动作、舞蹈走位与运镜轨迹精准提取
  - 剥离真人演员肖像，规避生成模型的内容安全审核拦截与肖像侵权风险
  - 为 MiniMax H3 全能参考视频 (`5_omni_video`) 提供时序骨架与空间深度参考（`ref_video_01`）
  - 为深度 ControlNet 或 Wan VACE 提取逐帧连续深度图序列

### 核心权重文件与缓存机制

| 模型名称 | 文件名 | 体积 | 默认下载/缓存位置 |
| :--- | :--- | :---: | :--- |
| **Video Depth Anything Small** | `video_depth_anything_vits.pth` | 约 111 MB | `~/.cache/huggingface/hub/models--depth-anything--Video-Depth-Anything-Small/` |

> [!NOTE]
> **自动下载与国内镜像加速**：
> - 首次在 ComfyUI 中执行该节点时，插件会自动从 Hugging Face 官方仓库拉取权重，仅下载一次并在 ComfyUI 进程中常驻内存。
> - **国内网络环境**：启动 ComfyUI 前请设置镜像环境变量，避免网络挂起：
>   - Linux / macOS：`export HF_ENDPOINT=https://hf-mirror.com`
>   - Windows 便携版：在 `run_nvidia_gpu.bat` 中添加 `set HF_ENDPOINT=https://hf-mirror.com`
> - **离线部署环境**：可提前在联网机器下载 [Video-Depth-Anything-Small](https://huggingface.co/depth-anything/Video-Depth-Anything-Small)，将包含 `video_depth_anything_vits.pth` 的整个文件夹完整拷贝至上述缓存路径。

---

## 依赖扩展插件

运行本工作流必须在 ComfyUI 的 `custom_nodes/` 目录下安装以下插件：

### 1. ComfyUI-ReShot（核心插件）
- **GitHub 仓库**: `https://github.com/maosika-ai/ComfyUI-ReShot`
- **提供节点**: `ReShotDepthVideo` (视频深度提取)、`ReShotDepthMap` (图像深度提取)、`ReShotPoseVideo`、`ReShotCannyVideo` 等
- **安装方法**：
  - **方法一（ComfyUI Manager 推荐）**：
    打开 ComfyUI → Manager → Custom Nodes Manager → Install via Git URL，输入 `https://github.com/maosika-ai/ComfyUI-ReShot` 安装并重启。
  - **方法二（Git 手动安装）**：
    ```bash
    cd ComfyUI/custom_nodes
    git clone https://github.com/maosika-ai/ComfyUI-ReShot
    # 必须使用 ComfyUI 相同的 Python 环境安装依赖：
    python -m pip install -r ComfyUI-ReShot/requirements.txt
    ```
  - **Windows 便携版**：
    ```bat
    cd ComfyUI_windows_portable\ComfyUI\custom_nodes
    git clone https://github.com/maosika-ai/ComfyUI-ReShot
    cd ..\..
    python_embeded\python.exe -m pip install -r ComfyUI\custom_nodes\ComfyUI-ReShot\requirements.txt
    ```

### 2. ComfyUI 原生视频支持
- 依赖 ComfyUI 原生内置的 `LoadVideo` 与 `SaveVideo` 节点（需要 2025-04 或更新版本的 ComfyUI 核心，具备原生 `VIDEO` 管道类型支持）。
- 节点自身不依赖外部 ffmpeg 命令，直接走 ComfyUI 内建视频编解码管线。

---

## 槽位契约与参数映射

工作流已严格遵循系统的 `_meta.title` 槽位命名规范，在向自建 ComfyUI 原生 API 发起调度时自动完成以下插槽映射：

| 槽位名 (`_meta.title`) | 节点类别 (`class_type`) | 内部输入/输出名 | 数据流与说明 |
| :--- | :--- | :--- | :--- |
| **`ref_video_01`** | `LoadVideo` | `file` | 待提取深度的原始输入视频（支持 MP4、MOV、WebM 等常规视频格式） |
| **`output_video`** | `SaveVideo` | `video` | 深度视频最终产物输出端口，无声封装导出为 MP4 文件（保存路径前缀：`reshot/depth`） |

---

## 节点参数详解 (`ReShotDepthVideo`)

工作流中间核心处理节点为 `ReShotDepthVideo`，各参数配置与作用如下：

| 参数项 | 当前预设值 | 可选值 | 功能说明与调优指引 |
| :--- | :---: | :--- | :--- |
| **`target`** | `h3` | `h3`<br/>`seedance`<br/>`wan`<br/>`none` | **目标模型硬件规格对齐**：<br/>• `h3`：锁定 24 fps，宽高自动居中裁切至 **32 的整数倍**（严禁黑边填充，完美对齐 MiniMax H3 原生规格）；<br/>• `seedance`：锁定 24 fps，宽高 16 的倍数（Seedance 2.0 / 2.5 参考视频标准）；<br/>• `wan`：锁定 16 fps，宽高 16 的倍数（Wan 2.1 VACE 标准）；<br/>• `none`：保持源片 fps，仅将尺寸转为偶数。 |
| **`quality`** | `full` | `fast`<br/>`full` | **模型推理视口分辨率**（输出视频分辨率不受影响）：<br/>• `full`：以 924×518 等高精视口推理，细节、手指边缘及散发轮廓更锐利，显存峰值约 11~12 GB；<br/>• `fast`：以 644×364 视口推理，显存占用仅约 3 GB，推理速度快 2.5 倍，适合消费级单卡或快速预览。 |
| **`invert`** | `false` | `false`<br/>`true` | **深度图黑白极性映射**：<br/>• `false`（默认推荐）：**近白远黑**。与 MiniMax H3、Seedance 及主流 Depth ControlNet 预训练分布完全一致；<br/>• `true`：远白近黑，供反转极性的特殊控制网使用。 |
| **`clip_percent`** | `0` | `0` ~ `10` | **深度极值截断裁剪比例**（%）：缩放至 0~255 灰阶前从两端裁掉的比例。若镜头前有特写肢体（如冲到镜头前的拳头或兵器）导致背景全局被压得过暗，可设为 `0.5 ~ 1.0` 进行平衡；日常保留 `0` 即可。 |
| **`gamma`** | `1.0` | `0.2` ~ `3.0` | **灰阶伽马校正**：`1.0` 为线性分布；`> 1.0` 压暗中间调拉开近景层次；`< 1.0` 提亮暗部。一般保持 `1.0`。 |
| **`max_side`** | `0` | 整数 (≥ 0) | **输出长边像素上限**：`0` 代表不主动缩放，按原视频长宽比及 `target` 规则裁切对齐。 |

---

## 硬件配置与性能实测建议

| 运行环境 | 推理画质 (`quality`) | 显存占用 (VRAM) | 推荐素材规格与表现 |
| :--- | :---: | :---: | :--- |
| **消费级 (RTX 3060/4060 8G~12G)** | `fast` | 约 3 GB | 720p / 1080p, 10~15 秒内素材，流畅稳定 |
| **主力级 (RTX 3090/4090 24G)** | `full` | 约 11~12 GB | 1080p 全精度提取，边缘极锐，速度适中 |
| **Apple Silicon (Mac M系列)** | `fast` / `full` | 统一内存 | 支持 MPS 加速推理，耗时稍长于独立 GPU |

> [!TIP]
> - **输入时长建议**：建议参考视频控制在 5 ~ 15 秒以内。由于视频扩散模型单次生成多为 5~10 秒，过长视频会线性增加时序内存开销。
> - **杜绝黑边干扰（Crop vs Pad）**：ReShot 针对目标尺寸采用居中智能裁切策略，绝不对视频边缘填充黑边。若填充黑边，下游视频生成模型容易将黑边误判为远端深色墙体或遮挡物，导致画面边缘异常变形。

---

## 典型联动场景：配合 MiniMax H3 全能参考视频重拍

本工作流生成的深度视频可直接作为 MiniMax H3 全能参考视频（`5_omni_video`）的核心参考源：

```text
[原始真人/版权动作视频]
         ↓
[7_depth_video: ReShot 深度提取]
         ↓ 输出无声近白远黑深度视频
[5_omni_video: MiniMax H3 ref2va] (作为 ref_video_01 连线输入)
         + [文本提示词 prompt] (定义全新的人物长相、服装质感、光影场景)
         ↓
[全新角色复刻相同镜头走位与打斗的高清视频]
```

通过这一流水线，创作者可将经典电影镜头、武打走位、舞蹈律动以极高精度复刻为全新数字艺术作品，同时实现演员与风格的彻底脱敏。
