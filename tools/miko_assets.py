# -*- coding: utf-8 -*-
"""巫女·和风主题的本地立绘加工。

★ 版权约束（主题预设-设计方案.md §4.4）：本仓库是 public，角色立绘**绝不入库**。
  - 源素材放在仓库根的 `素材/`（.gitignore 已排除，需要用户自行放置）；
  - 加工产物写到 `client/public/theme-local/miko/`（同样被 .gitignore 排除）；
  - 两处任一不存在时，主题里引用这些图的 CSS 规则只是 404 静默降级，不影响其它观感。

加工内容（全套 16 张里只取 2 张，其余用不上）：
  1. hero（首页问候条右侧的半身像）：取「微笑闭眼」那张的上半身——迎宾的语气；
  2. empty（「今天没有课」空态）：取「眼睛发亮」那张的上半身——兴奋的语气。
  裁剪策略：立绘是全身竖图（约 1900×3200），界面挂载高度只有 100~200px，
  直接缩放会小到看不清 → 先取上部（头+肩+手持物）再裁 alpha 包围盒，最后缩到目标高。
  输出 WebP（带 alpha，比 PNG 小一个量级）。

用法：
  uv run --with pillow python tools/miko_assets.py
"""

from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "素材"
OUT = ROOT / "client" / "public" / "theme-local" / "miko"

# (源文件名, 输出名, 取上部比例, 目标高度)
JOBS = [
    ("b_舞巫女服飾り無し_笑顔4.png", "hero-smile.webp", 0.50, 460),
    ("b_巫女服_キラキラ1.png", "empty-sparkle.webp", 0.52, 400),
]


def trim_alpha(img: Image.Image, pad: int = 8) -> Image.Image:
    """按 alpha 包围盒裁掉四周透明边，四周留 pad px 呼吸空隙。"""
    alpha = img.getchannel("A")
    bbox = alpha.getbbox()
    if not bbox:
        raise SystemExit("整张图都是透明的？检查源文件")
    left = max(0, bbox[0] - pad)
    top = max(0, bbox[1] - pad)
    right = min(img.width, bbox[2] + pad)
    bottom = min(img.height, bbox[3] + pad)
    return img.crop((left, top, right, bottom))


def main() -> None:
    if not SRC.exists():
        SystemExit(f"找不到源素材目录 {SRC}——把立绘放进去再跑（见文件头说明）")
    OUT.mkdir(parents=True, exist_ok=True)

    for name, out_name, top_ratio, target_h in JOBS:
        src_path = SRC / name
        if not src_path.exists():
            print(f"跳过：缺少源文件 {src_path}")
            continue
        img = Image.open(src_path).convert("RGBA")
        # 取上部（头肩像），再裁 alpha、缩放到目标高
        cut = img.crop((0, 0, img.width, int(img.height * top_ratio)))
        bust = trim_alpha(cut)
        scale = target_h / bust.height
        bust = bust.resize((round(bust.width * scale), target_h), Image.LANCZOS)
        out_path = OUT / out_name
        try:
            bust.save(out_path, "WEBP", quality=88, method=6)
        except Exception as e:  # noqa: BLE001 个别 Pillow 构建 WebP 支持不全
            print(f"WebP 保存失败（{e}），改存 PNG")
            out_path = OUT / out_name.replace(".webp", ".png")
            bust.save(out_path, "PNG", optimize=True)
        kb = out_path.stat().st_size / 1024
        print(f"{name} → {out_path.relative_to(ROOT)}  {bust.width}x{bust.height}  {kb:.0f}KB")


if __name__ == "__main__":
    try:
        main()
    except SystemExit as e:
        print(e)
        sys.exit(1)
