# 实测样本：双人吵架三镜头（H3 → LTX-2.5）

**用途**：回归测试。拿 SKILL.md §2 的映射表重新转一遍，输出应与本文件的 LTX 版一致。
**场景前提**：二采精修段，锁脸 LoRA = `Best_FaceID_v1.0_LoRA`（overlap 布局，无槽位嵌入 → 零标签）。

---

## 一、输入：H3 REF 六段原稿

```
subject_definitions:
<Subject 1> is the elegant middle-aged Chinese woman in <Picture 1>, with smooth fair skin, arched brows, dark eyes, and black hair pulled into a neat low bun, wearing a sleeveless white mandarin-collar qipao dress with a side slit and red pointed high heels.
<Subject 2> is the young visual-kei man in <Picture 2>, with shaggy black hair sweeping over one eye, dramatic dark eye makeup, a silver earring, and a small red Chinese character "愛" tattooed on his forehead, wearing a black leather biker jacket over a black shirt, black slim pants, and black lace-up combat boots.
summary:
[reference generation] The target video shows a fierce 10-second family quarrel between <Subject 1> and <Subject 2> in a warmly lit Chinese living room. <Subject 1> stands frame-LEFT, <Subject 2> stands frame-RIGHT, facing each other. A three-shot sequence (two-shot, close-up of the man, close-up of the woman) delivers the argument with Chinese dialogue and ends on her breaking final line.
retention_analysis:
<Subject 1> (appears in [Shot 1], [Shot 3]): fully_preserved - her white mandarin-collar qipao, low black bun, fair skin, and red high heels are retained.
<Subject 2> (appears in [Shot 1], [Shot 2]): fully_preserved - his black leather biker jacket, shaggy black hair, dark eye makeup, silver earring, and the red "愛" forehead tattoo are retained.
detailed_description:
The target video is in a realistic Chinese family-melodrama style with warm indoor lighting and shallow depth of field.
[Shot 1] A static medium two-shot inside a warmly lit living room, a beige sofa and tea table soft in the background. <Subject 1>, the middle-aged woman in the white sleeveless qipao with her black hair in a low bun, stands on the LEFT side of the frame, turned toward the RIGHT, facing <Subject 2> directly. <Subject 2>, the young man in the black leather jacket with the red "愛" tattoo on his forehead, stands on the RIGHT side of the frame, turned toward the LEFT, addressing <Subject 1> directly. <Subject 1> raises her right hand, points at <Subject 2>, and says in a sharp trembling female voice, <d>[Chinese] 你把房子抵押了？</d> <Subject 2> clenches his jaw and glares back at her without stepping away, saying nothing.
[Shot 2] At 00:04.000, the shot cuts to a static close-up of <Subject 2> (S2), chest-up, facing screen-left toward the off-screen woman, his red "愛" forehead tattoo and dark eye makeup clearly visible under a warm key light. For the first beat he only breathes heavily with his fists at his sides, no dialogue. Then <Subject 2> (S2) snaps in a low defiant young male voice, <d>[Chinese] 那是我的自由！</d> He closes his mouth and holds a hard stare toward the off-screen woman.
[Shot 3] At 00:07.000, the shot cuts to a static close-up of <Subject 1> (S1), chest-up, facing screen-right toward the off-screen man, her white qipao collar visible at the bottom of the frame. Her eyes redden and glisten under the warm light; she only trembles slightly, no large movements. Then <Subject 1> (S1) says in a cracking, heartbroken female voice, <d>[Chinese] 我白养你三十年！</d> The video ends on her grief-stricken face frozen mid-gaze.
overall_soundscape:
Quiet living-room room tone with a faint wall-clock ticking continues throughout; the sharp crack of a palm striking the tea table is heard just before the final line in [Shot 3].
non_diegetic_music:
A low tense string drone tightens under the argument and cuts off abruptly on the final line.
```

---

## 二、输出：LTX-2.5 提示词

```
10-second realistic Chinese family-melodrama video, warm indoor living-room lighting, shallow depth of field.

An elegant middle-aged Chinese woman, smooth fair skin, arched brows, dark eyes, black hair pulled into a neat low bun, wearing a sleeveless white mandarin-collar qipao dress with a side slit and red pointed high heels. Her facial features, hairstyle and outfit stay fully consistent through the whole video.

A young visual-kei man, shaggy black hair sweeping over one eye, dramatic dark eye makeup, a silver earring, a small red Chinese character "愛" tattooed on his forehead, wearing a black leather biker jacket over a black shirt, black slim pants, black lace-up combat boots. His appearance remains unchanged for the full clip.

The room is a warmly lit Chinese living room, a beige sofa and a tea table soft and blurred behind them.

The video opens on a static medium two-shot inside the living room. The woman stands on the left side of the frame, turned toward the right, facing the young man directly. The young man stands on the right side of the frame, turned toward the left, facing her. She raises her right hand, points at him, and speaks in Chinese, her voice sharp and trembling: "你把房子抵押了？" He clenches his jaw and glares back at her without stepping away, saying nothing. A quiet living-room room tone and a faint wall-clock tick run underneath.

A hard cut transitions to a static chest-up close-up of the young man, facing screen-left toward the off-screen woman, a warm key light on his face so the red "愛" forehead tattoo and the heavy dark eye makeup read clearly. The room tone and the clock tick continue across the cut. For the first beat he only breathes heavily with his fists at his sides, no dialogue. Then he snaps in Chinese, his voice low and defiant: "那是我的自由！" He closes his mouth and holds a hard stare toward the off-screen woman.

A hard cut transitions to a static chest-up close-up of the middle-aged woman, facing screen-right toward the off-screen man, the white qipao collar visible at the bottom of the frame. The room tone keeps running, and the low string drone tightens. Her eyes redden and glisten under the warm light; she only trembles slightly, with no large movement. Then she speaks in Chinese, her voice cracking and heartbroken: "我白养你三十年！" The video ends holding on her grief-stricken face frozen mid-gaze.

A sharp crack of a palm striking the tea table lands just before her final line. A low, tense dark string drone builds steadily underneath the whole quarrel, then cuts off abruptly the moment her last spoken line finishes.

Realistic cinematic family drama, natural facial acting, consistent character look across the shot cuts, smooth hard cuts between the three shots, no face distortion, no body deformation.
```

---

## 三、逐条溯源（证明规则完整，无自由发挥）

| 输出片段 | 来源字段 | 施用的规则 |
|---|---|---|
| 首段风格与光线 | `detailed_description` 第一句 | §2「风格开场 → 首段」 |
| `10-second` 前缀 | 无（**本次新增**） | ⚠️ §6：官方 Sample 不带；见下方「两处遗留问题」 |
| 人物段 ①（女人） | `<Subject 1>` | §2：剥标签 + 逐字保留全部特征 |
| 人物段 ②（男人） | `<Subject 2>` | 同上；**顺序 = H3 的 `<Subject 1>`→`<Subject 2>`**，保证与参考图排列顺序一致 |
| 一致性后缀（`stay fully consistent…`） | 无（**本次新增**） | 强化锁脸锚点，非官方要求，属可选项 |
| 场景段 | `[Shot 1]` 里的 "inside a warmly lit living room, a beige sofa and tea table soft in the background" | §2「场景从 Shot 里提出来单独成段」 |
| 动作段 · 切点 1 | `[Shot 1]` | §2：删 `[Shot 1]`；`<Subject 1>`→`the woman`；`LEFT/RIGHT`→`left/right side of the frame`；`<d>[Chinese] X</d>`→`speaks in Chinese, her voice sharp and trembling: "X"` |
| `A quiet living-room room tone and a faint wall-clock tick run underneath.` | `overall_soundscape` 前半 | §2「soundscape 拆到每个切点」 |
| 切点 2 的转场句 | `the shot cuts to` | §2：改 `A hard cut transitions to…` |
| `At 00:04.000` | — | §4 硬禁 2：**删** |
| `(S2)` 标记 | — | §2：**删**，保留 `his voice low and defiant` 音色描述 |
| `The room tone and the clock tick continue across the cut.` | — | §4 硬禁 4：切点声明声音延续（**新增句，规则要求**） |
| 切点 3 的 `the low string drone tightens` | `non_diegetic_music` | §2「按切点写变化」 |
| 收尾段音效 | `overall_soundscape` 后半（拍桌） | §2「结尾段汇总」 |
| 收尾段音乐 | `non_diegetic_music` 全句 | 原样搬运 |
| 结尾技术风格标记 | 无（**本次新增**） | §6 第 ⑤ 段；⚠️ 见下方「两处遗留问题」 |
| `summary` / `retention_analysis` / `<Picture N>` | — | §2：**丢弃**（`retention_analysis` 仅用于反查人物段有没有漏特征） |

**镜头数**：H3 是 3 个 shot，落在官方 2–4 区间内 → **无需合并**。若 H3 是 5–6 镜，按 §5 收敛。

---

## 四、两处遗留问题（下次转换时要处理）

1. **`10-second` 前缀**
   官方两个 Sample 都不带时长前缀，时长由节点参数决定。属于本样本的可删冗余项，
   留着不出错，但别指望它控时。

2. **结尾的 `no face distortion, no body deformation`**
   违反 §4 硬禁 5 —— 质量类否定不该出现在正向提示词里。官方三个 LTX-2.3 模板的负向节点一律是
   名词串（`pc game, console game, video game, cartoon, childish, ugly`）。
   ⚠️ 该样本对应的工作流 `#27 LTXVDualCFGGuider` 的 `video_cfg` / `audio_cfg` 都是 **1**，
   负向完全不参与计算 —— 所以**这条实际是无效句，建议直接删**。
   ⇒ `references/worked_example_ltx_output.txt`（回归基准）里**已删掉这一句**，其余与原件一致。

---

## 五、回归测试怎么跑

```bash
python scripts/check_ltx_prompt.py \
  --ltx references/worked_example_ltx_output.txt \
  --h3  references/worked_example_h3_input.txt
# 期望: 结论: PASS（退出码 0）
```

配套反例 `negative_sample_doubao.txt`（把 H3 原稿的格式直接搬过去的典型错法），
期望 **FAIL 8 项**。两个样本合起来构成自检器的正反回归对。

> **踩坑记录**：写完检查器后拿官方 Sample 一比对，才发现我最初那条
> 「否定式一律不许写进正向」是**过严**的 —— 官方 i2v 模板里有
> `No pull-back; the only camera move is the continuous push-in.` 和
> `no dipping or lowering of the head`。运动/机位类否定是合法的，只有**质量/瑕疵类**才该挪去负向。
> 已修正 SKILL.md §4 第 5 条。

