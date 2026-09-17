# -*- coding: utf-8 -*-
"""从 图标.png 生成 favicon 成品集（可复现脚本，换源图时重跑，别手改 client/public 的成品）。

背景处理原理：
  只对「与图像最外圈连通的近白色像素」抠底（flood fill），
  角色轮廓内部的银白头发/高光因被包住而不受影响——这是"直接按亮度抠白"必然会踩的坑。
  抠完再做 alpha 羽化 + 去白边着色，避免缩到 16px 时出现白色描边。

依赖：pillow（用 uv 跑，无需改动项目依赖）
  uv run --with pillow python tools/icon/make_icons.py --preview
开关：
  --keep-bg        保留白底（旧行为）
  --pad 0.06       角色四周留白比例
  --tol 10         背景色容差，越小越保守（头发被吃掉就调小）
  --preview        输出三底色对比图，用来检查白边
"""
from PIL import Image, ImageDraw
Image.MAX_IMAGE_PIXELS = None
import collections, argparse, os, math

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SRC = os.path.join(ROOT, "图标.png")
OUT = os.path.join(ROOT, "client", "public")
TMP = os.path.join(ROOT, "tools", "icon", "tmp")
OUT_NAMES = ["favicon.ico", "favicon-32.png", "apple-touch-icon.png", "icon-192.png", "icon-512.png"]


def edge_bg_color(rgb):
    w, h = rgb.size
    cnt = collections.Counter()
    for x in range(w):
        for y in list(range(3)) + list(range(h - 3, h)):
            cnt[rgb.getpixel((x, y))] += 1
    for x in list(range(3)) + list(range(w - 3, w)):
        for y in range(h):
            cnt[rgb.getpixel((x, y))] += 1
    return cnt.most_common(1)[0][0]


def content_bbox(rgb, bg, tol=12):
    w, h = rgb.size
    pxs = rgb.load()
    x0, y0, x1, y1 = w, h, -1, -1
    for y in range(h):
        for x in range(w):
            if math.dist(pxs[x, y], bg) > tol:
                x0 = min(x0, x); x1 = max(x1, x); y0 = min(y0, y); y1 = max(y1, y)
    return (x0, y0, x1, y1)


def cutout_mask(rgb, tol):
    """返回 (mask, bg)：mask[y][x]=True 表示"背景"，只从最外圈连通填充"""
    w, h = rgb.size
    pxs = rgb.load()
    bg = edge_bg_color(rgb)

    def near_bg(c):
        return max(abs(c[0] - bg[0]), abs(c[1] - bg[1]), abs(c[2] - bg[2])) <= tol

    mask = bytearray(w * h)
    stack = []
    for x in range(w):
        stack.append((x, 0)); stack.append((x, h - 1))
    for y in range(h):
        stack.append((0, y)); stack.append((w - 1, y))
    while stack:
        x, y = stack.pop()
        i = y * w + x
        if mask[i]:
            continue
        if not near_bg(pxs[x, y]):
            continue
        mask[i] = 1
        if x > 0: stack.append((x - 1, y))
        if x < w - 1: stack.append((x + 1, y))
        if y > 0: stack.append((x, y - 1))
        if y < h - 1: stack.append((x, y + 1))
    return mask, bg


def feather_alpha(rgb, mask, bg, tol, feather=1.6):
    """按"离背景的距离"给边缘像素渐进 alpha，消除 1px 级白边"""
    w, h = rgb.size
    pxs = rgb.load()
    maskv = memoryview(mask)
    near_bg_thr = tol + 30.0
    for y in range(h):
        for x in range(w):
            if maskv[y * w + x]:
                continue
            # 只处理紧邻背景的轮廓层，避免把角色内部也一起羽化
            touch = False
            for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                nx, ny = x + dx, y + dy
                if 0 <= nx < w and 0 <= ny < h and maskv[ny * w + nx]:
                    touch = True
                    break
            if not touch:
                continue
            c3 = pxs[x, y][:3]
            d = math.dist(c3, bg)
            if d >= near_bg_thr:
                continue
            t = (d - tol) / max(1e-6, feather * 18.0)
            a = int(max(0.0, min(1.0, t)) * 255)
            r, g, b = pxs[x, y][:3]
            if a < 255:
                # 去白边：把混进的白按 alpha 反推回角色本色（un-premultiply 近似）
                k = a / 255.0
                if k > 0.05:
                    r = int(max(0, min(255, (r - (1 - k) * 255) / k)))
                    g = int(max(0, min(255, (g - (1 - k) * 255) / k)))
                    b = int(max(0, min(255, (b - (1 - k) * 255) / k)))
            pxs[x, y] = (r, g, b, a)
    return rgb


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--keep-bg", action="store_true")
    ap.add_argument("--preview", action="store_true")
    ap.add_argument("--pad", type=float, default=0.06)
    ap.add_argument("--tol", type=int, default=10)
    ap.add_argument("--mode", choices=["full", "tight", "head", "face"], default="full",
                    help="full=全身+6%留白  tight=全身紧贴  head=头部特写（16px 可读，牺牲全身构图）")
    ap.add_argument("--head-crop", type=float, default=0.55, help="head 模式下取包围盒上半部分的比例")
    ap.add_argument("--face-center", type=float, nargs=2, default=[0.50, 0.58], metavar=("CX", "CY"),
                    help="face 模式：脸的方形中心（相对角色包围盒，0-1）")
    ap.add_argument("--face-size", type=float, default=0.42, help="face 模式：正方形边长（相对包围盒宽）")
    a = ap.parse_args()

    src = Image.open(SRC)
    W, H = src.size
    print("源图: %dx%d  模式=%s" % (W, H, src.mode))

    bg = edge_bg_color(src.convert("RGB"))
    print("背景色(最外圈众数): %s" % str(bg))

    if a.keep_bg:
        tight = src.convert("RGBA")
        bb = content_bbox(tight.convert("RGB"), bg, 12)
        print("模式: 保留白底")
    else:
        rgb = src.convert("RGB")
        t0 = __import__("time").time()
        mask, bg = cutout_mask(rgb, a.tol)
        n_bg = sum(mask)
        print("抠底: 容差=%d  背景像素 %d（%.1f%%）  连通域耗时 %.1fs"
              % (a.tol, n_bg, n_bg / (W * H) * 100, __import__("time").time() - t0))
        CACHE = os.path.join(TMP, "cutout-%dx%d-tol%d.png" % (W, H, a.tol))
        if os.path.exists(CACHE):
            rgba = Image.open(CACHE).convert("RGBA")
            print("抠底: 命中缓存 %s" % os.path.relpath(CACHE, ROOT))
        else:
            rgba = rgb.convert("RGBA")
        px = rgba.load()
        mv = memoryview(mask)
        for y in range(H):
            row = y * W
            for x in range(W):
                if mv[row + x]:
                    r, g, b, _ = px[x, y]
                    px[x, y] = (r, g, b, 0)
            feather_alpha(rgba, mask, bg, a.tol)
            os.makedirs(TMP, exist_ok=True)
            rgba.save(CACHE)
        tight = rgba
        bb = tight.getchannel("A").getbbox()

    x0, y0, x1, y1 = bb
    cw, ch = x1 - x0 + 1, y1 - y0 + 1
    print("角色包围盒: (%d,%d)-(%d,%d)  %dx%d  占源图 %.0f%% x %.0f%%"
          % (x0, y0, x1, y1, cw, ch, cw / W * 100, ch / H * 100))

    if a.mode == "face":
        side = int(round(cw * a.face_size))
        cx = int(round(x0 + cw * a.face_center[0]))
        cy = int(round(y0 + ch * a.face_center[1]))
        print("face 模式: 中心=(%d,%d) 边长=%d（包围盒的 %.0f%%）" % (cx, cy, side, a.face_size * 100))
    elif a.mode == "head":
        # 头部特写：只取包围盒上半部分（脸+双马尾上部），保证 16px 还能认出眼睛
        hh = int(ch * a.head_crop)
        x0, x1 = x0, x1
        y1 = y0 + hh - 1
        cw, ch = x1 - x0 + 1, y1 - y0 + 1
        side = int(round(max(cw, ch) * (1 + a.pad * 2)))
        cx, cy = x0 + cw // 2, y0 + ch // 2
        print("head 模式: 取上方 %d%% 高度 -> %dx%d" % (a.head_crop * 100, cw, ch))
    else:
        pad = 0.01 if a.mode == "tight" else a.pad
        side = int(round(max(cw, ch) * (1 + pad * 2)))
        cx, cy = x0 + cw // 2, y0 + ch // 2
    left, top = cx - side // 2, cy - side // 2
    canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    canvas.paste(tight.crop((left, top, left + side, top + side)), (0, 0))
    print("正方形裁剪: side=%d left=%d top=%d" % (side, left, top))

    os.makedirs(OUT, exist_ok=True)
    os.makedirs(TMP, exist_ok=True)
    base = canvas.resize((512, 512), Image.LANCZOS)
    base.save(os.path.join(TMP, "square-512.png"))
    base.resize((192, 192), Image.LANCZOS).save(os.path.join(OUT, "icon-192.png"))
    base.resize((180, 180), Image.LANCZOS).save(os.path.join(OUT, "apple-touch-icon.png"))
    base.resize((32, 32), Image.LANCZOS).save(os.path.join(OUT, "favicon-32.png"))
    base.resize((48, 48), Image.LANCZOS).save(os.path.join(OUT, "favicon.ico"), format="ICO",
                                             sizes=[(16, 16), (32, 32), (48, 48)])
    base.save(os.path.join(OUT, "icon-512.png"))

    print("\n产物:")
    for f in OUT_NAMES:
        p = os.path.join(OUT, f)
        im = Image.open(p)
        print("  %-22s %8.1f KB  %s %s" % (f, os.path.getsize(p) / 1024, im.size, im.mode))

    if a.preview:
        panel = Image.new("RGB", (512 * 3 + 40, 560), (40, 40, 44))
        dr = ImageDraw.Draw(panel)
        for i, (bgc, name) in enumerate([((255, 255, 255), "white"), ((17, 20, 26), "dark"), ((255, 0, 170), "magenta")]):
            tile = Image.new("RGB", (512, 512), bgc)
            tile.paste(base, (0, 0), base)
            ImageDraw.Draw(tile).rectangle([0, 0, 511, 511], outline=(0, 200, 120), width=1)
            panel.paste(tile, (10 + i * 520, 40))
            dr.text((12 + i * 520, 20), "%s background (halo visible => white fringe)" % name, fill=(230, 230, 230))
        out = os.path.join(TMP, "preview_bg.png")
        panel.save(out)
        print("预览: %s" % os.path.relpath(out, ROOT))


if __name__ == "__main__":
    main()
