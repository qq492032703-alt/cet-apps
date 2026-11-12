"""生成品牌图标：圆角/圆形底 + 白色单字，并同步自适应背景色。
用法: python scripts/make_icon.py [字] [RRGGBB]
"""
import os
import sys
from PIL import Image, ImageDraw, ImageFont

RES = r"C:\Users\Administrator\Desktop\cet-practice\frontend\android\app\src\main\res"
CHAR = sys.argv[1] if len(sys.argv) > 1 else "研"
HEX = (sys.argv[2] if len(sys.argv) > 2 else "2563EB").lstrip("#")
R, G, B = int(HEX[0:2], 16), int(HEX[2:4], 16), int(HEX[4:6], 16)
COLOR = (R, G, B, 255)
FONTS = [r"C:\Windows\Fonts\msyhbd.ttc", r"C:\Windows\Fonts\msyh.ttc", r"C:\Windows\Fonts\simhei.ttf"]


def get_font(sz):
    for f in FONTS:
        if os.path.exists(f):
            try:
                return ImageFont.truetype(f, sz, index=0)
            except Exception:
                try:
                    return ImageFont.truetype(f, sz)
                except Exception:
                    pass
    return ImageFont.load_default()


def center_text(d, box, ch, ft):
    b = d.textbbox((0, 0), ch, font=ft)
    w, h = b[2] - b[0], b[3] - b[1]
    x = box[0] + (box[2] - box[0] - w) / 2 - b[0]
    y = box[1] + (box[3] - box[1] - h) / 2 - b[1]
    d.text((x, y), ch, font=ft, fill=(255, 255, 255, 255))


legacy = {"mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}
fg = {"mdpi": 108, "hdpi": 162, "xhdpi": 216, "xxhdpi": 324, "xxxhdpi": 432}

for dens, sz in legacy.items():
    d0 = os.path.join(RES, f"mipmap-{dens}")
    os.makedirs(d0, exist_ok=True)
    img = Image.new("RGBA", (sz, sz), (0, 0, 0, 0))
    dr = ImageDraw.Draw(img)
    dr.rounded_rectangle([0, 0, sz - 1, sz - 1], radius=int(sz * 0.22), fill=COLOR)
    center_text(dr, (0, 0, sz, sz), CHAR, get_font(int(sz * 0.62)))
    img.save(os.path.join(d0, "ic_launcher.png"))

    img2 = Image.new("RGBA", (sz, sz), (0, 0, 0, 0))
    dr2 = ImageDraw.Draw(img2)
    dr2.ellipse([0, 0, sz - 1, sz - 1], fill=COLOR)
    center_text(dr2, (0, 0, sz, sz), CHAR, get_font(int(sz * 0.62)))
    img2.save(os.path.join(d0, "ic_launcher_round.png"))

for dens, sz in fg.items():
    d0 = os.path.join(RES, f"mipmap-{dens}")
    os.makedirs(d0, exist_ok=True)
    img = Image.new("RGBA", (sz, sz), (0, 0, 0, 0))
    dr = ImageDraw.Draw(img)
    center_text(dr, (0, 0, sz, sz), CHAR, get_font(int(sz * 0.40)))
    img.save(os.path.join(d0, "ic_launcher_foreground.png"))

# 同步自适应图标背景色
bg = os.path.join(RES, "values", "ic_launcher_background.xml")
if os.path.exists(bg):
    with open(bg, "w", encoding="utf-8") as fh:
        fh.write('<?xml version="1.0" encoding="utf-8"?>\n<resources>\n'
                 f'    <color name="ic_launcher_background">#{HEX.upper()}</color>\n</resources>\n')

print(f"icons done: char={CHAR} color=#{HEX.upper()} -> {RES}")
