"""Shrink screenshots to 256-colour PNGs, for the pictures in docs/.

    uv run --no-project --with pillow python scripts/shrink_screenshots.py <from> <to>

Every `*.png` in <from> is written to <to> with the same name. UI screenshots have few colours,
so this keeps them sharp at a fraction of the size. Used by `make guide-screenshots`.
"""

from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image

TARGET_KB = 150


def main(src: Path, dst: Path) -> int:
    dst.mkdir(parents=True, exist_ok=True)
    total = 0
    for file in sorted(src.glob("*.png")):
        image = Image.open(file).convert("RGB")
        small = image.quantize(
            colors=256, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE
        )
        out = dst / file.name
        small.save(out, optimize=True)
        kb = out.stat().st_size // 1024
        total += kb
        warning = f"  (over {TARGET_KB} KB: crop it smaller)" if kb > TARGET_KB else ""
        print(f"{kb:5d} KB  {out.name}{warning}")
    print(f"{total:5d} KB  in total")
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print(__doc__)
        sys.exit(2)
    sys.exit(main(Path(sys.argv[1]), Path(sys.argv[2])))
