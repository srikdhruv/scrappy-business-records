"""Draw the app icon (a marigold circle with a dark-brown ₹) as .ico and .png, standard library only.

The glyph is the same stroke path as `frontend/public/favicon.svg`, and the colours are the
theme's `--primary` and `--primary-foreground` from `frontend/src/index.css`.

    python scripts/make_icon.py OUT_DIR      # writes scrappy.ico and scrappy.png
"""

from __future__ import annotations

import math
import struct
import sys
import zlib
from pathlib import Path

MARIGOLD = (0xF2, 0xA9, 0x3B)  # --primary
BROWN = (0x3B, 0x24, 0x10)  # --primary-foreground
ICO_SIZES = (16, 24, 32, 48, 64, 128, 256)
PNG_SIZE = 512

# Everything below is in the favicon's 32x32 coordinate space.
_CENTRE, _RADIUS = (16.0, 16.0), 15.5
_STROKE = 2.6
# Straight strokes of the ₹, from favicon.svg: top bar, middle bar, bottom of the bowl, diagonal.
_SEGMENTS = (
    ((10.0, 9.5), (19.5, 9.5)),
    ((10.0, 13.0), (22.0, 13.0)),
    ((19.5, 16.5), (14.0, 16.5)),
    ((14.0, 16.5), (20.5, 23.0)),
)
# The bowl: right half of a circle of radius 3.5 centred at (19.5, 13).
_ARC_CENTRE, _ARC_RADIUS = (19.5, 13.0), 3.5


def _seg_dist(p: tuple[float, float], a: tuple[float, float], b: tuple[float, float]) -> float:
    (px, py), (ax, ay), (bx, by) = p, a, b
    dx, dy = bx - ax, by - ay
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
    return math.hypot(px - ax - t * dx, py - ay - t * dy)


def _glyph_dist(p: tuple[float, float]) -> float:
    d = min(_seg_dist(p, a, b) for a, b in _SEGMENTS)
    cx, cy = _ARC_CENTRE
    if p[0] >= cx:
        d = min(d, abs(math.hypot(p[0] - cx, p[1] - cy) - _ARC_RADIUS))
    return d


def render(size: int, samples: int = 4) -> bytes:
    """RGBA pixels, row by row, anti-aliased by `samples`² supersampling."""
    scale = 32.0 / size
    out = bytearray()
    step = 1.0 / samples
    for y in range(size):
        for x in range(size):
            fill = ink = 0
            for sy in range(samples):
                for sx in range(samples):
                    p = ((x + (sx + 0.5) * step) * scale, (y + (sy + 0.5) * step) * scale)
                    if math.hypot(p[0] - _CENTRE[0], p[1] - _CENTRE[1]) > _RADIUS:
                        continue
                    fill += 1
                    if _glyph_dist(p) <= _STROKE / 2:
                        ink += 1
            if fill == 0:
                out += b"\0\0\0\0"
                continue
            t = ink / fill
            rgb = (round(MARIGOLD[i] * (1 - t) + BROWN[i] * t) for i in range(3))
            out += bytes((*rgb, round(255 * fill / samples**2)))
    return bytes(out)


def png(size: int) -> bytes:
    raw = render(size)
    rows = b"".join(b"\0" + raw[y * size * 4 : (y + 1) * size * 4] for y in range(size))

    def chunk(kind: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data))
            + kind
            + data
            + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)
        )

    header = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)  # 8-bit RGBA
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", header)
        + chunk(b"IDAT", zlib.compress(rows, 9))
        + chunk(b"IEND", b"")
    )


def ico(sizes: tuple[int, ...] = ICO_SIZES) -> bytes:
    """A Windows icon with PNG-compressed images (supported since Windows Vista)."""
    images = [png(s) for s in sizes]
    header = struct.pack("<HHH", 0, 1, len(images))
    offset = 6 + 16 * len(images)
    entries = b""
    for size, data in zip(sizes, images, strict=True):
        dim = 0 if size >= 256 else size  # 0 means 256
        entries += struct.pack("<BBBBHHII", dim, dim, 0, 0, 1, 32, len(data), offset)
        offset += len(data)
    return header + entries + b"".join(images)


def write_icons(out_dir: Path) -> tuple[Path, Path]:
    out_dir.mkdir(parents=True, exist_ok=True)
    ico_path, png_path = out_dir / "scrappy.ico", out_dir / "scrappy.png"
    ico_path.write_bytes(ico())
    png_path.write_bytes(png(PNG_SIZE))
    return ico_path, png_path


if __name__ == "__main__":
    for path in write_icons(Path(sys.argv[1] if len(sys.argv) > 1 else ".")):
        print(path)
