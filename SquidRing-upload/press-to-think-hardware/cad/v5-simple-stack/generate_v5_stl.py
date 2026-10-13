#!/usr/bin/env python3
"""Press to Think V5: simple two-piece case with lid-side retainers."""

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

RING_ID = 18.0
RING_RADIAL = 2.2
RING_WIDTH = 6.0
OUTER = 27.5
WALL = 1.4
INNER = OUTER - 2 * WALL
FLOOR = 1.2
LID_T = 1.2

BOARD = (22.5, 18.0, 5.5)
BATTERY = (16.0, 12.0, 3.5)
BUTTON = (6.0, 6.0, 5.0)
WIRE_D = 0.7

INSULATION = 0.5
LOWER_CLEAR = 5.8
UPPER_CLEAR = 5.3
INNER_Z = LOWER_CLEAR + INSULATION + UPPER_CLEAR
BODY_Z = FLOOR + INNER_Z

# Battery and button share the upper layer within the XIAO footprint.
BATTERY_CX = -3.5
BUTTON_CX = 8.3
BUTTON_HOLE = 3.4


def body():
    t = []
    ro = RING_ID / 2 + RING_RADIAL
    t += mesh.translate(mesh.annular_band_y(RING_ID, RING_RADIAL, RING_WIDTH), dz=-ro)
    t += mesh.box(0, 0, -RING_RADIAL / 2, OUTER, OUTER, RING_RADIAL)
    t += mesh.box(0, 0, FLOOR / 2, OUTER, OUTER, FLOOR)

    t += mesh.box(0, -OUTER / 2 + WALL / 2, BODY_Z / 2, OUTER, WALL, BODY_Z)
    t += mesh.box(0, +OUTER / 2 - WALL / 2, BODY_Z / 2, OUTER, WALL, BODY_Z)
    t += mesh.box(+OUTER / 2 - WALL / 2, 0, BODY_Z / 2, WALL, INNER, BODY_Z)

    # USB-C opening at the bottom XIAO layer.
    usb_w, usb_h, usb_z0 = 11.0, 5.4, FLOOR + 0.2
    side_w = (INNER - usb_w) / 2
    t += mesh.box(-OUTER / 2 + WALL / 2, +(usb_w + side_w) / 2,
                  BODY_Z / 2, WALL, side_w, BODY_Z)
    t += mesh.box(-OUTER / 2 + WALL / 2, -(usb_w + side_w) / 2,
                  BODY_Z / 2, WALL, side_w, BODY_Z)
    t += mesh.box(-OUTER / 2 + WALL / 2, 0, usb_z0 / 2, WALL, usb_w, usb_z0)
    top_h = BODY_Z - usb_z0 - usb_h
    t += mesh.box(-OUTER / 2 + WALL / 2, 0, usb_z0 + usb_h + top_h / 2,
                  WALL, usb_w, top_h)

    # XIAO edge locators on the floor. Four centre gaps allow wires to pass.
    lh, lt = 0.8, 0.7
    for y in (-BOARD[1] / 2 - 0.4, BOARD[1] / 2 + 0.4):
        for x in (-6.2, 6.2):
            t += mesh.box(x, y, FLOOR + lh / 2, 8.0, lt, lh)
    for x in (-BOARD[0] / 2 - 0.35, BOARD[0] / 2 + 0.35):
        for y in (-5.0, 5.0):
            t += mesh.box(x, y, FLOOR + lh / 2, lt, 6.0, lh)
    return t


def lid_with_inner_retainers():
    t = []
    # Thin top face with 3.4 mm aperture over the button.
    side_y = (OUTER - BUTTON_HOLE) / 2
    t += mesh.box(0, +(BUTTON_HOLE + side_y) / 2, LID_T / 2,
                  OUTER, side_y, LID_T)
    t += mesh.box(0, -(BUTTON_HOLE + side_y) / 2, LID_T / 2,
                  OUTER, side_y, LID_T)
    left_w = BUTTON_CX - BUTTON_HOLE / 2 + OUTER / 2
    right_w = OUTER / 2 - (BUTTON_CX + BUTTON_HOLE / 2)
    t += mesh.box(-OUTER / 2 + left_w / 2, 0, LID_T / 2,
                  left_w, BUTTON_HOLE, LID_T)
    t += mesh.box(BUTTON_CX + BUTTON_HOLE / 2 + right_w / 2, 0, LID_T / 2,
                  right_w, BUTTON_HOLE, LID_T)

    # Retainers extend inward (negative Z). They locate parts laterally only.
    # Battery frame has centre gaps on all sides for either lead direction.
    rh, rt, gap = 1.6, 0.7, 3.5
    bx, by, _ = BATTERY
    seg_x = (bx + 1.0 - gap) / 2
    for y in (-by / 2 - 0.5, by / 2 + 0.5):
        for xoff in (-(seg_x + gap) / 2, +(seg_x + gap) / 2):
            t += mesh.box(BATTERY_CX + xoff, y, -rh / 2,
                          seg_x, rt, rh)
    seg_y = (by + 1.0 - gap) / 2
    for x in (BATTERY_CX - bx / 2 - 0.5, BATTERY_CX + bx / 2 + 0.5):
        for yoff in (-(seg_y + gap) / 2, +(seg_y + gap) / 2):
            t += mesh.box(x, yoff, -rh / 2, rt, seg_y, rh)

    # Button frame, also open on ±Y for flattened pins and wires.
    p = BUTTON[0] + 0.6
    pw = 0.8
    t += mesh.box(BUTTON_CX - p / 2 - pw / 2, 0, -1.2,
                  pw, p, 2.4)
    t += mesh.box(BUTTON_CX + p / 2 + pw / 2, 0, -1.2,
                  pw, p, 2.4)
    t += mesh.box(BUTTON_CX, -(p / 2 + pw / 2), -1.2,
                  p + 2 * pw, pw, 2.4)
    t += mesh.box(BUTTON_CX, +(p / 2 + pw / 2), -1.2,
                  p + 2 * pw, pw, 2.4)

    # Four short lid-registration tabs; side gaps remain available for wiring.
    tab_h, tab_t, tab_len = 1.5, 0.8, 4.0
    lip = INNER - 0.6
    for y in (-(lip / 2 - tab_t / 2), +(lip / 2 - tab_t / 2)):
        for x in (-8.0, 8.0):
            t += mesh.box(x, y, -tab_h / 2, tab_len, tab_t, tab_h)
    return t


def main():
    parts = {
        "ptt_v5_simple_body_18mm.stl": body(),
        "ptt_v5_lid_with_battery_button_retainers.stl": lid_with_inner_retainers(),
    }
    OUT.mkdir(parents=True, exist_ok=True)
    for filename, tris in parts.items():
        mesh.write_binary_stl(OUT / filename, filename[:-4], tris)
        print(filename, len(tris), mesh.bounds(tris))
    print(f"parts: 2")
    print(f"footprint: {OUTER:.1f} x {OUTER:.1f} mm")
    print(f"height above ring top incl lid: {BODY_Z + LID_T:.1f} mm")
    print(f"XIAO side wire clearance: {(INNER - BOARD[1]) / 2:.2f} mm each side")


if __name__ == "__main__":
    main()
