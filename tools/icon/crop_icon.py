# -*- coding: utf-8 -*-
"""图标裁剪与出图（复用 make_icons.py 的抠底逻辑）。

设计目的：抠底（flood fill）只做一次并缓存成 RGBA 全图，
之后调裁剪参数几乎瞬间出图，方便对比 full / face 等方案。

用法（uv 自带干净环境，不动项目依赖）：
  uv run --with pillow python tools/icon/crop_icon.py --mode face --face-size 0.42
  uv run --with pillow python tools/icon/crop_icon.py --mode full --pad 0.06
  uv run --with pillow python tools/icon/crop_icon.py --list-presets

参数刻度说明（方便换源图后重新调）：
  face 模式的 --face-center / --face-size 都以「角色包围盒」为单位（0-1），
  而不是绝对像素——换个尺寸的源图，同一套比例仍然大致可用。
"""
from PIL import Image, ImageDraw
Image.MAX_IMAGE_PIXELS = None
import argparse
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from make_icons import cutout_mask, feather_alpha, edge_bg_color  # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SRC = os.path.join(ROOT, "图标.png")
OUT = os.path.join(ROOT, "client", "public")
TMP = os.path.join(ROOT, "tools", "icon", "tmp")
OUT_NAMES = ["favicon.ico", "favicon-32.png", "apple-touch-icon.png", "icon-192.png", "icon-512.png"]

# 预设：都基于角色包围盒比例
PRESETS = {
    "full": dict(mode="full", pad=0.06, note="全身 + 6% 留白：构图完整，16px 偏糊"),
    "tight": dict(mode="full", pad=0.01, note="全身紧贴边：比 full 稍清楚，仍不足以救 16px"),
    "face": dict(mode="face", face_center=(0.50, 0.58), face_size=0.42,
                 note="脸部特写：眼睛占满画布，16px 可辨，牺牲全身构图"),
    "head": dict(mode="head", head_crop=0.55, pad=0.06, note="上半身：介于两者之间的折中"),
}


def content_bbox(rgb, bg, tol=12, step=2):
    """非背景包围盒；step=2 跳采样，只用于裁剪定位，精度足够且快"""
    w, h = rgb.size
    pxs = rgb.load()
    x0, y0, x1, y1 = w, h, -1, -1
    for y in range(0, h, step):
        for x in range(0, w, step):
            c = pxs[x, y]
            if abs(c[0] - bg[0]) > tol or abs(c[1] - bg[1]) > tol or abs(c[2] - bg[2]) > tol:
                x0 = min(x0, x); x1 = max(x1, x); y0 = min(y0, y); y1 = max(y1, y)
    return (x0, y0, x1, y1)


def get_cutout(src, tol, verbose=True):
    """抠底结果缓存：key 含源图 mtime+size+tol，源图换了自动失效"""
    st = os.stat(SRC)
    cache = os.path.join(TMP, "cutout-%d-%d-tol%d.png" % (st.st_size, int(st.st_mtime), tol))
    bbox_cache = cache.replace(".png", "-bbox.txt")
    if os.path.exists(cache) and os.path.exists(bbox_cache):
        with open(bbox_cache) as f:
            x0, y0, x1, y1 = [int(v) for v in f.read().split()]
        if verbose:
            print("抠底: 命中缓存（%s）" % os.path.basename(cache))
        return Image.open(cache).convert("RGBA"), (x0, y0, x1, y1)
    t0 = time.time()
    rgb = src.convert("RGB")
    w, h = rgb.size
    mask, bg = cutout_mask(rgb, tol)
    rgba = rgb.convert("RGBA")
    px = rgba.load()
    mv = memoryview(mask)
    for y in range(h):
        row = y * w
        for x in range(w):
            if mv[row + x]:
                r, g, b, _ = px[x, y]
                px[x, y] = (r, g, b, 0)
    feather_alpha(rgba, mask, bg, tol)
    bb = rgba.getchannel("A").getbbox()
    os.makedirs(TMP, exist_ok=True)
    rgba.save(cache)
    with open(bbox_cache, "w") as f:
        f.write("%d %d %d %d" % bb)
    if verbose:
        print("抠底: 重新计算 %.1fs  背景像素 %.1f%%  包围盒 %s" % (time.time() - t0, sum(mask) / (w * h) * 100, str(bb)))
    return rgba, bb


def crop_square(img, bb, mode, pad, head_crop, face_center, face_size):
    x0, y0, x1, y1 = bb
    cw, ch = x1 - x0 + 1, y1 - y0 + 1
    if mode == "face":
        side = int(round(cw * face_size))
        cx = int(round(x0 + cw * face_center[0]))
        cy = int(round(y0 + ch * face_center[1]))
    elif mode == "head":
        hh = int(ch * head_crop)
        y1 = y0 + hh - 1
        cw, ch = x1 - x0 + 1, y1 - y0 + 1
        side = int(round(max(cw, ch) * (1 + pad * 2)))
        cx, cy = x0 + cw // 2, y0 + ch // 2
    else:
        side = int(round(max(cw, ch) * (1 + pad * 2)))
        cx, cy = x0 + cw // 2, y0 + ch // 2
    left, top = cx - side // 2, cy - side // 2
    return img.crop((left, top, left + side, top + side)), (left, top, side)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", choices=["full", "tight", "face", "head"], default="face")
    ap.add_argument("--pad", type=float, default=None, help="full/head 模式留白比例（默认按预设）")
    ap.add_argument("--head-crop", type=float, default=None)
    ap.add_argument("--face-center", type=float, nargs=2, default=None, metavar=("CX", "CY"))
    ap.add_argument("--face-size", type=float, default=None)
    ap.add_argument("--tol", type=int, default=10)
    ap.add_argument("--preview", action="store_true")
    ap.add_argument("--dry", action="store_true", help="只算裁剪框，不写出成品")
    ap.add_argument("--list-presets", action="store_true")
    a = ap.parse_args()

    if a.list_presets:
        for k, v in PRESETS.items():
            print("%-6s %s" % (k, v["note"]))
        return

    pre = PRESETS.get("face" if a.mode == "face" else a.mode, {})
    pad = a.pad if a.pad is not None else pre.get("pad", 0.06)
    head_crop = a.head_crop if a.head_crop is not None else pre.get("head_crop", 0.55)
    fc = a.face_center if a.face_center is not None else list(pre.get("face_center", (0.5, 0.58)))
    fs = a.face_size if a.face_size is not None else pre.get("face_size", 0.42)

    src = Image.open(SRC)
    print("源图: %dx%d %s" % (src.size[0], src.size[1], src.mode))
    cut, bb = get_cutout(src, a.tol)
    print("角色包围盒: %s  %dx%d" % (str(bb), bb[2] - bb[0] + 1, bb[3] - bb[1] + 1))

    square, (left, top, side) = crop_square(cut, bb, a.mode, pad, head_crop, fc, fs)
    print("裁剪: mode=%s left=%d top=%d side=%d" % (a.mode, left, top, side))
    if a.dry:
        return

    os.makedirs(OUT, exist_ok=True)
    os.makedirs(TMP, exist_ok=True)
    base = square.resize((512, 512), Image.LANCZOS)
    base.save(os.path.join(TMP, "current-512.png"))
    base.save(os.path.join(OUT, "icon-512.png"))
    base.resize((192, 192), Image.LANCZOS).save(os.path.join(OUT, "icon-192.png"))
    base.resize((180, 180), Image.LANCZOS).save(os.path.join(OUT, "apple-touch-icon.png"))
    base.resize((32, 32), Image.LANCZOS).save(os.path.join(OUT, "favicon-32.png"))
    base.resize((48, 48), Image.LANCZOS).save(
        os.path.join(OUT, "favicon.ico"), format="ICO", sizes=[(16, 16), (32, 32), (48, 48)])

    print("\n产物:")
    for f in OUT_NAMES:
        p = os.path.join(OUT, f)
        im = Image.open(p)
        print("  %-22s %8.1f KB  %s %s" % (f, os.path.getsize(p) / 1024, im.size, im.mode))

    if a.preview:
        panel = Image.new("RGB", (512 * 3 + 40, 560), (40, 40, 44))
        d = ImageDraw.Draw(panel)
        for i, bgc in enumerate([(255, 255, 255), (17, 20, 26), (255, 0, 170)]):
            tile = Image.new("RGB", (512, 512), bgc)
            tile.paste(base, (0, 0), base)
            panel.paste(tile, (10 + i * 520, 40))
        out = os.path.join(TMP, "preview_bg.png")
        panel.save(out)
        print("预览: %s" % os.path.relpath(out, ROOT))


if __name__ == "__main__":
    main()
