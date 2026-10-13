#!/usr/bin/env python3
"""Press to Think V6: compact XIAO-footprint stack, 1 mm buffer per side."""

from __future__ import annotations

import importlib.util
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
V0_SCRIPT = ROOT / "v0-fit-case" / "generate_stl.py"
spec = importlib.util.spec_from_file_location("v0mesh", V0_SCRIPT)
mesh = importlib.util.module_from_spec(spec)
assert spec and spec.loader
spec.loader.exec_module(mesh)

OUT = Path(__file__).resolve().parent / "out"

BOARD = (22.5, 18.0, 5.5)
BATTERY = (16.0, 12.0, 3.5)
BUTTON = (6.0, 6.0, 5.0)

BUFFER = 1.0
WALL = 1.0
INNER_X = BOARD[0] + 2 * BUFFER  # 24.5
INNER_Y = BOARD[1] + 2 * BUFFER  # 20.0
OUTER_X = INNER_X + 2 * WALL     # 26.5
OUTER_Y = INNER_Y + 2 * WALL     # 22.0

RING_ID = 18.0
RING_RADIAL = 2.0
RING_WIDTH = 5.5
FLOOR = 1.2
LID_T = 1.2
INSULATION = 0.5
LOWER_CLEAR = 5.8
UPPER_CLEAR = 5.3
INNER_Z = LOWER_CLEAR + INSULATION + UPPER_CLEAR
BODY_Z = FLOOR + INNER_Z

BATTERY_CX = -3.25
BUTTON_CX = 8.25
BUTTON_HOLE = 3.4


def body():
    t = []
    ro = RING_ID / 2 + RING_RADIAL
    t += mesh.translate(mesh.annular_band_y(RING_ID, RING_RADIAL, RING_WIDTH), dz=-ro)
    t += mesh.box(0, 0, -RING_RADIAL / 2, OUTER_X, OUTER_Y, RING_RADIAL)
    t += mesh.box(0, 0, FLOOR / 2, OUTER_X, OUTER_Y, FLOOR)

    t += mesh.box(0, -OUTER_Y / 2 + WALL / 2, BODY_Z / 2,
                  OUTER_X, WALL, BODY_Z)
    t += mesh.box(0, +OUTER_Y / 2 - WALL / 2, BODY_Z / 2,
                  OUTER_X, WALL, BODY_Z)
    t += mesh.box(+OUTER_X / 2 - WALL / 2, 0, BODY_Z / 2,
                  WALL, INNER_Y, BODY_Z)

    # USB-C opening on -X wall.
    usb_w, usb_h, usb_z0 = 11.0, 5.4, FLOOR + 0.2
    side_w = (INNER_Y - usb_w) / 2
    t += mesh.box(-OUTER_X / 2 + WALL / 2, +(usb_w + side_w) / 2,
                  BODY_Z / 2, WALL, side_w, BODY_Z)
    t += mesh.box(-OUTER_X / 2 + WALL / 2, -(usb_w + side_w) / 2,
                  BODY_Z / 2, WALL, side_w, BODY_Z)
    t += mesh.box(-OUTER_X / 2 + WALL / 2, 0, usb_z0 / 2,
                  WALL, usb_w, usb_z0)
    top_h = BODY_Z - usb_z0 - usb_h
    t += mesh.box(-OUTER_X / 2 + WALL / 2, 0,
                  usb_z0 + usb_h + top_h / 2, WALL, usb_w, top_h)

    # Minimal interrupted XIAO edge locators.
    lh, lt = 0.7, 0.55
    for y in (-BOARD[1] / 2 - 0.3, BOARD[1] / 2 + 0.3):
        for x in (-6.0, 6.0):
            t += mesh.box(x, y, FLOOR + lh / 2, 8.0, lt, lh)
    for x in (-BOARD[0] / 2 - 0.25, BOARD[0] / 2 + 0.25):
        for y in (-4.7, 4.7):
            t += mesh.box(x, y, FLOOR + lh / 2, lt, 5.5, lh)
    return t


def lid():
    t = []
    # Thin face with button aperture at the upper-layer button position.
    top_band = (OUTER_Y - BUTTON_HOLE) / 2
    t += mesh.box(0, +(BUTTON_HOLE + top_band) / 2, LID_T / 2,
                  OUTER_X, top_band, LID_T)
    t += mesh.box(0, -(BUTTON_HOLE + top_band) / 2, LID_T / 2,
                  OUTER_X, top_band, LID_T)
    left_w = BUTTON_CX - BUTTON_HOLE / 2 + OUTER_X / 2
    right_w = OUTER_X / 2 - (BUTTON_CX + BUTTON_HOLE / 2)
    t += mesh.box(-OUTER_X / 2 + left_w / 2, 0, LID_T / 2,
                  left_w, BUTTON_HOLE, LID_T)
    t += mesh.box(BUTTON_CX + BUTTON_HOLE / 2 + right_w / 2, 0,
                  LID_T / 2, right_w, BUTTON_HOLE, LID_T)

    # Shallow, interrupted battery frame on lid underside.
    rh, rt, centre_gap = 1.4, 0.55, 3.0
    bx, by, _ = BATTERY
    seg_x = (bx + 0.8 - centre_gap) / 2
    for y in (-by / 2 - 0.4, by / 2 + 0.4):
        for xo in (-(seg_x + centre_gap) / 2, +(seg_x + centre_gap) / 2):
            t += mesh.box(BATTERY_CX + xo, y, -rh / 2, seg_x, rt, rh)
    seg_y = (by + 0.8 - centre_gap) / 2
    for x in (BATTERY_CX - bx / 2 - 0.4, BATTERY_CX + bx / 2 + 0.4):
        for yo in (-(seg_y + centre_gap) / 2, +(seg_y + centre_gap) / 2):
            t += mesh.box(x, yo, -rh / 2, rt, seg_y, rh)

    # Button frame, open toward ±Y for bent pins and wiring.
    p, pw, ph = BUTTON[0] + 0.4, 0.55, 2.0
    t += mesh.box(BUTTON_CX - p / 2 - pw / 2, 0, -ph / 2, pw, p, ph)
    t += mesh.box(BUTTON_CX + p / 2 + pw / 2, 0, -ph / 2, pw, p, ph)
    t += mesh.box(BUTTON_CX, -(p / 2 + pw / 2), -ph / 2,
                  p + 2 * pw, pw, ph)
    t += mesh.box(BUTTON_CX, +(p / 2 + pw / 2), -ph / 2,
                  p + 2 * pw, pw, ph)

    # Four tiny registration tabs only; no continuous lip stealing clearance.
    tab_h, tab_t, tab_len = 1.2, 0.55, 3.2
    for y in (-(INNER_Y / 2 - tab_t / 2 - 0.2), +(INNER_Y / 2 - tab_t / 2 - 0.2)):
        for x in (-6.0, 2.0):
            t += mesh.box(x, y, -tab_h / 2, tab_len, tab_t, tab_h)
    return t


def main():
    parts = {
        "ptt_v6_compact_body_18mm.stl": body(),
        "ptt_v6_compact_lid_with_retainers.stl": lid(),
    }
    OUT.mkdir(parents=True, exist_ok=True)
    for filename, tris in parts.items():
        mesh.write_binary_stl(OUT / filename, filename[:-4], tris)
        print(filename, len(tris), mesh.bounds(tris))
    print(f"XIAO: {BOARD[0]} x {BOARD[1]} mm")
    print(f"internal: {INNER_X:.1f} x {INNER_Y:.1f} mm")
    print(f"external: {OUTER_X:.1f} x {OUTER_Y:.1f} mm")
    print(f"height above ring top: {BODY_Z + LID_T:.1f} mm")


if __name__ == "__main__":
    main()
