# -*- coding: utf-8 -*-
"""对比几种裁剪方案在真实小尺寸下的可读性（放大用最近邻，保持像素真相）。

前置：先跑 crop_icon.py 生成 512 母版，并把 tools/icon/tmp/current-512.png
      另存为 <mode>-512.png（例如 full-512.png / face-512.png）。
      缺图时跳过该列而不是报错。

用法：uv run --with pillow python tools/icon/compare_modes.py
"""
from PIL import Image, ImageDraw
import os

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
TMP = os.path.join(ROOT, "tools", "icon", "tmp")
VARIANTS = [("full", "full 全身 + 6% 留白"), ("face", "face 脸部特写")]
SIZES = [16, 24, 32, 48]
SCALE = 5


def main():
    avail = [(n, lb) for n, lb in VARIANTS if os.path.exists(os.path.join(TMP, "%s-512.png" % n))]
    if not avail:
        print("没有可对比的母版（先跑 crop_icon.py）")
        return
    cell_w = sum(s * SCALE + 26 for s in SIZES) + 20
    cell_h = max(SIZES) * SCALE + 34
    col_w = cell_w + 30
    sheet = Image.new("RGB", (20 + col_w * len(avail), 44 + (cell_h + 60) * 2), (18, 18, 22))
    dr = ImageDraw.Draw(sheet)
    for c, (_n, label) in enumerate(avail):
        dr.text((20 + c * col_w, 10), label, fill=(235, 235, 245))

    for r, (bgc, bgname) in enumerate([((255, 255, 255), "light tab bar"), ((26, 28, 34), "dark tab bar")]):
        y0 = 44 + r * (cell_h + 60)
        dr.rectangle([10, y0 - 26, sheet.size[0] - 10, y0 + cell_h + 24], fill=bgc)
        fg = (60, 60, 70) if r == 0 else (190, 190, 200)
        dr.text((16, y0 - 20), bgname, fill=fg)
        for c, (name, _label) in enumerate(avail):
            im = Image.open(os.path.join(TMP, "%s-512.png" % name)).convert("RGBA")
            x = 20 + c * col_w
            for s in SIZES:
                small = im.resize((s, s), Image.LANCZOS)
                big = small.resize((s * SCALE, s * SCALE), Image.NEAREST)
                tile = Image.new("RGB", (s * SCALE, s * SCALE), bgc)
                tile.paste(big, (0, 0), big)
                sheet.paste(tile, (x, y0))
                dr.text((x + 2, y0 + s * SCALE + 6), "%dpx" % s,
                        fill=(120, 120, 135) if r == 0 else (150, 150, 165))
                x += s * SCALE + 26

    out = os.path.join(TMP, "mode_compare.png")
    sheet.save(out)
    print("对比图:", os.path.relpath(out, ROOT), sheet.size)


if __name__ == "__main__":
    main()
