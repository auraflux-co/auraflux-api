#!/usr/bin/env python3
"""Run RetinaFace face detection in isolation (subprocess only).

Why subprocess: tensorflow (retina-face dep) registers cuDNN 8 factories in-process
and breaks PyTorch cuDNN 9 on the same interpreter (see spike/cpd881/control.sh fixtf).

Usage:
  python face_detect_subprocess.py /path/to/portrait.png

Stdout: JSON {"y1": int, "y2": int, "x1": int, "x2": int, "height": int, "width": int}
Exit 1 if no face detected.

Requires (in THIS interpreter only — not the infer_flash torch env):
  pip install retina-face tensorflow==2.15.0
"""
from __future__ import annotations

import json
import sys

from PIL import Image
import numpy as np


def get_mask_coord(image_path: str):
    from retinaface import RetinaFace

    img = Image.open(image_path).convert("RGB")
    arr = np.array(img)[:, :, ::-1]
    facial_areas = RetinaFace.detect_faces(arr)
    if not facial_areas:
        raise RuntimeError(f"no face detected in {image_path}")
    face = facial_areas["face_1"]
    x, y, x2, y2 = face["facial_area"]
    height, width = arr.shape[:2]
    return {"y1": y, "y2": y2, "x1": x, "x2": x2, "height": height, "width": width}


def main():
    if len(sys.argv) != 2:
        print("usage: face_detect_subprocess.py <image.png>", file=sys.stderr)
        sys.exit(2)
    coords = get_mask_coord(sys.argv[1])
    print(json.dumps(coords))


if __name__ == "__main__":
    main()
