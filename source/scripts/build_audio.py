"""从发布包的 resources/ 提取听力音频，转码压缩到 frontend/public/audio/。

用法:
    python scripts/build_audio.py [bitrate]    # 默认 24k

依赖 scripts/audio_manifest.json（由 export_static.py 生成），
以及 build-input/v1.5.0-WithAudio.zip（含 resources/<中文相对路径>.m4a）。

产物:
    frontend/public/audio/<slug>.m4a          压缩后的音频（文件名 = audio_manifest 的 out）
"""
from __future__ import annotations

import json
import subprocess
import sys
import zipfile
from pathlib import Path

PROJECT = Path(__file__).resolve().parents[1]
ZIP = PROJECT / "build-input" / "v1.5.0-WithAudio.zip"
MANIFEST = PROJECT / "scripts" / "audio_manifest.json"
OUTDIR = PROJECT / "frontend" / "public" / "audio"
TMP = PROJECT / "build-input" / "_tmp_audio.m4a"


def realname(n: str) -> str:
    # 无 UTF-8 flag 的 zip 中文名被解为 cp437，还原为 GBK
    try:
        return n.encode("cp437").decode("gbk")
    except Exception:
        return n


def main():
    bitrate = sys.argv[1] if len(sys.argv) > 1 else "24k"
    if not ZIP.is_file():
        sys.exit(f"missing {ZIP}")
    mani = json.loads(MANIFEST.read_text(encoding="utf-8"))
    OUTDIR.mkdir(parents=True, exist_ok=True)

    z = zipfile.ZipFile(ZIP)
    entries = {}
    for n in z.namelist():
        if n.lower().endswith((".m4a", ".mp3", ".wav")):
            entries[realname(n).split("resources/", 1)[-1]] = n
    print(f"zip audio={len(entries)}  manifest={len(mani)}  bitrate={bitrate}")

    total = 0
    done = 0
    for m in mani:
        src, out = m["src"], m["out"]
        entry = entries.get(src)
        if not entry:
            print(f"MISS {src}")
            continue
        with z.open(entry) as s, open(TMP, "wb") as d:
            d.write(s.read())
        dst = OUTDIR / out
        subprocess.run(
            ["ffmpeg", "-y", "-v", "error", "-i", str(TMP), "-ac", "1",
             "-c:a", "aac", "-b:a", bitrate, str(dst)],
            check=True,
        )
        total += dst.stat().st_size
        done += 1
        print(f"[{done}/{len(mani)}] {out} {dst.stat().st_size/1024/1024:.2f}MB")

    if TMP.exists():
        TMP.unlink()
    print(f"DONE audio files={done} totalMB={total/1024/1024:.1f}")


if __name__ == "__main__":
    main()
