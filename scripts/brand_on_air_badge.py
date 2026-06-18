#!/usr/bin/env python3
"""Recolor on_air_badge line art: gold (#c7af4f) fill, navy (#0d1424) ink."""
from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image

GOLD = (199, 175, 79, 255)
NAVY = (13, 20, 36, 255)
INK_LUM = 95


def recolor(src: Path, dst: Path) -> None:
    img = Image.open(src).convert("RGBA")
    px = img.load()
    w, h = img.size
    for y in range(h):
        for x in range(w):
            r, g, b, _a = px[x, y]
            lum = 0.299 * r + 0.587 * g + 0.114 * b
            px[x, y] = NAVY if lum < INK_LUM else GOLD
    img.save(dst)
    print(f"wrote {dst} ({w}x{h})")


if __name__ == "__main__":
    root = Path(__file__).resolve().parents[1]
    src = Path(sys.argv[1]) if len(sys.argv) > 1 else root / "assets" / "live_grid" / "on_air_badge_lineart.png"
    dst = Path(sys.argv[2]) if len(sys.argv) > 2 else root / "assets" / "live_grid" / "on_air_badge.png"
    recolor(src, dst)
