#!/usr/bin/env python3
"""把 IndexTTS 音色卡库转成画布可用的前端资源。

源目录（`indextts_voice/`）是 IndexTTS 自己的音色库格式：
- `indextts_voice.json` 里 `materials[]` 是 27 张卡，字段名对应官方 IndexTTS2 节点
- `voices/*.MP3` 是参考音频，`images/*.png` 是头像

产物：
- `web/src/data/indextts-voices.json`  元数据索引（约 15 KB，随包走）
- `web/public/voices/voice-NN.mp3`     参考音频（弹层打开时才 fetch）
- `web/public/voice-avatars/voice-NN.webp` 压缩后的头像

头像必须压：源图 81 张 PNG 合计 41 MB，原样塞进 public 会把仓库撑爆；压完约 60 KB。

用法：
    python tools/build-voice-library.py [--source indextts_voice] [--ffmpeg ffmpeg]

`ffmpeg` 只用来转 webp，没装的话头像这一步会跳过（元数据与音频照常生成）。
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
AUDIO_EXT = {".mp3", ".wav", ".m4a", ".flac", ".ogg"}


def emo_mode(method: str) -> str:
    """音色卡的情绪控制方式 → 画布的两种模式。

    `Same as the voice reference` 在 T8 节点里对应 speaker（跟随音色，没有情绪子输入）；
    其余（Use text description…）走 text，由一句自然语言描述控制。
    """
    if "same as the voice reference" in method.lower():
        return "speaker"
    return "text"


def build(source: Path, ffmpeg: str | None) -> int:
    cards_file = source / "indextts_voice.json"
    if not cards_file.exists():
        print(f"找不到音色卡库：{cards_file}", file=sys.stderr)
        return 1

    materials = json.loads(cards_file.read_text(encoding="utf-8")).get("materials") or []
    if not materials:
        print("音色卡库是空的", file=sys.stderr)
        return 1

    audio_dir = ROOT / "web" / "public" / "voices"
    avatar_dir = ROOT / "web" / "public" / "voice-avatars"
    data_dir = ROOT / "web" / "src" / "data"
    for path in (audio_dir, avatar_dir, data_dir):
        path.mkdir(parents=True, exist_ok=True)

    voices = []
    copied_audio = 0
    converted_avatar = 0

    for index, card in enumerate(materials, start=1):
        voice_id = f"voice-{index:02d}"
        name = (card.get("name") or "").strip() or voice_id

        # reference_audio 里是别的机器上的相对路径（resources\indextts_voice\voices\x.MP3），
        # 只取文件名去源目录里找，绝不按那个路径拼。
        raw_audio = (card.get("reference_audio") or "").replace("\\", "/")
        audio_name = raw_audio.rsplit("/", 1)[-1]
        audio_source = source / "voices" / audio_name
        audio_rel = None
        if audio_source.exists() and audio_source.suffix.lower() in AUDIO_EXT:
            audio_target = audio_dir / f"{voice_id}{audio_source.suffix.lower()}"
            shutil.copyfile(audio_source, audio_target)
            audio_rel = f"voices/{audio_target.name}"
            copied_audio += 1
        elif audio_name:
            print(f"  跳过 {name}：找不到参考音频 {audio_name}")

        raw_image = (card.get("image") or "").replace("\\", "/")
        image_source = source / raw_image if raw_image else None
        avatar_rel = None
        if image_source and image_source.exists():
            avatar_target = avatar_dir / f"{voice_id}.webp"
            if ffmpeg:
                result = subprocess.run(
                    [
                        ffmpeg, "-y", "-hide_banner", "-loglevel", "error",
                        "-i", str(image_source),
                        # 先按短边放大再居中裁切，保证头像不变形；统一 128 见方，弹层里高度一致。
                        "-vf", "scale=128:128:force_original_aspect_ratio=increase,crop=128:128",
                        "-quality", "80",
                        str(avatar_target),
                    ],
                    capture_output=True,
                )
                if result.returncode == 0 and avatar_target.exists():
                    avatar_rel = f"voice-avatars/{avatar_target.name}"
                    converted_avatar += 1
                else:
                    print(f"  头像转换失败 {name}：{result.stderr.decode('utf-8', 'ignore').strip()[:120]}")
            else:
                print(f"  没有 ffmpeg，跳过 {name} 的头像")

        weight = card.get("emo_weight")
        voices.append(
            {
                "id": voice_id,
                "name": name,
                "description": (card.get("description") or "").strip(),
                "type": (card.get("type") or "").strip(),
                "style": (card.get("style") or "").strip(),
                "emoMode": emo_mode(card.get("emo_control_method") or ""),
                "emoText": (card.get("emo_text") or "").strip(),
                "emoWeight": float(weight) if isinstance(weight, (int, float)) else 0.8,
                "audio": audio_rel,
                "avatar": avatar_rel,
            }
        )

    target = data_dir / "indextts-voices.json"
    target.write_text(json.dumps(voices, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    total_audio = sum((ROOT / "web" / "public" / v["audio"]).stat().st_size for v in voices if v["audio"])
    total_avatar = sum((ROOT / "web" / "public" / v["avatar"]).stat().st_size for v in voices if v["avatar"])
    print(f"{len(voices)} 张音色卡 → {target.relative_to(ROOT)}")
    print(f"  参考音频 {copied_audio} 个 / {total_audio / 1048576:.1f} MB")
    print(f"  头像 {converted_avatar} 个 / {total_avatar / 1024:.0f} KB")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", default=str(ROOT / "indextts_voice"), help="音色卡库目录")
    parser.add_argument("--ffmpeg", default=shutil.which("ffmpeg") or "", help="ffmpeg 可执行文件路径")
    args = parser.parse_args()
    return build(Path(args.source), args.ffmpeg or None)


if __name__ == "__main__":
    raise SystemExit(main())
