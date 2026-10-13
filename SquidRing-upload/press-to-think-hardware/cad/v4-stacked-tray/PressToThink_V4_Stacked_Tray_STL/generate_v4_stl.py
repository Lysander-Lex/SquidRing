#!/usr/bin/env python3
"""Press to Think V4: XIAO below, battery + top button side-by-side above."""

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
BOARD = (22.5, 18.0, 5.5)
BATTERY = (16.0, 12.0, 3.5)
BUTTON = (6.0, 6.0, 5.0)
WIRE_D = 0.7

LOWER_CLEAR_H = 6.0
TRAY_T = 0.8
UPPER_CLEAR_H = 5.4
BODY_Z = FLOOR + LOWER_CLEAR_H + TRAY_T + UPPER_CLEAR_H
LID_T = 1.2
BUTTON_HOLE = 3.4

TRAY_X = 23.6
TRAY_Y = 14.2
BATTERY_CX = -3.5
BUTTON_CX = 8.3
TRAY_BOTTOM_Z = FLOOR + LOWER_CLEAR_H


def body():
    t = []
    ro = RING_ID / 2 + RING_RADIAL
    t += mesh.translate(mesh.annular_band_y(RING_ID, RING_RADIAL, RING_WIDTH), dz=-ro)
    t += mesh.box(0, 0, -RING_RADIAL / 2, OUTER, OUTER, RING_RADIAL)
    t += mesh.box(0, 0, FLOOR / 2, OUTER, OUTER, FLOOR)

    # Main walls.
    t += mesh.box(0, -OUTER / 2 + WALL / 2, BODY_Z / 2, OUTER, WALL, BODY_Z)
    t += mesh.box(0, +OUTER / 2 - WALL / 2, BODY_Z / 2, OUTER, WALL, BODY_Z)
    t += mesh.box(+OUTER / 2 - WALL / 2, 0, BODY_Z / 2, WALL, INNER, BODY_Z)

    # USB-C opening on -X wall at the lower XIAO layer.
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

    # Lower-layer XIAO locators. These only touch board edges.
    locator_h, locator_t = 1.0, 0.7
    for y in (-BOARD[1] / 2 - 0.45, BOARD[1] / 2 + 0.45):
        t += mesh.box(0, y, FLOOR + locator_h / 2,
                      BOARD[0] + 0.8, locator_t, locator_h)
    for x in (-BOARD[0] / 2 - 0.35, BOARD[0] / 2 + 0.35):
        t += mesh.box(x, 0, FLOOR + locator_h / 2,
                      locator_t, BOARD[1] + 0.8, locator_h)

    # Four tray supports transfer upper-layer load to the enclosure walls, not
    # to the XIAO. Side gaps remain open as vertical wire chases.
    support_z = TRAY_BOTTOM_Z - 0.6
    for x in (-10.7, 10.7):
        for y in (-10.7, 10.7):
            t += mesh.box(x, y, support_z, 3.0, 3.0, 1.2)
    return t


def upper_tray():
    t = []
    t += mesh.box(0, 0, TRAY_T / 2, TRAY_X, TRAY_Y, TRAY_T)
    rail_h, rail_t = 0.8, 0.7

    # Battery corner locators; interrupted edges leave wire exits.
    bx, by, _ = BATTERY
    for y in (-by / 2 - 0.45, by / 2 + 0.45):
        t += mesh.box(BATTERY_CX - 5.0, y, TRAY_T + rail_h / 2, 5.0, rail_t, rail_h)
        t += mesh.box(BATTERY_CX + 5.0, y, TRAY_T + rail_h / 2, 5.0, rail_t, rail_h)
    for x in (BATTERY_CX - bx / 2 - 0.45, BATTERY_CX + bx / 2 + 0.45):
        t += mesh.box(x, -3.8, TRAY_T + rail_h / 2, rail_t, 3.5, rail_h)
        t += mesh.box(x, +3.8, TRAY_T + rail_h / 2, rail_t, 3.5, rail_h)

    # Button locators. Bent pins point toward ±Y and then drop through the open
    # side gap between tray and enclosure wall.
    pw = 0.8
    p = BUTTON[0] + 0.5
    t += mesh.box(BUTTON_CX, +(p / 2 + pw / 2), TRAY_T + 1.3,
                  p + 2 * pw, pw, 2.6)
    t += mesh.box(BUTTON_CX, -(p / 2 + pw / 2), TRAY_T + 1.3,
                  p + 2 * pw, pw, 2.6)
    t += mesh.box(BUTTON_CX + p / 2 + pw / 2, 0, TRAY_T + 1.3,
                  pw, p, 2.6)
    t += mesh.box(BUTTON_CX - p / 2 - pw / 2, 0, TRAY_T + 1.3,
                  pw, p, 2.6)
    return t


def lid():
    # Thin lid with button aperture aligned to the upper tray switch.
    t = []
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

    # Short corner tabs locate the lid but leave all side wire chases open.
    tab_h, tab_t, tab_len = 1.6, 0.8, 4.0
    lip = INNER - 0.6
    z = -tab_h / 2
    for y in (-(lip / 2 - tab_t / 2), +(lip / 2 - tab_t / 2)):
        for x in (-8.0, 8.0):
            t += mesh.box(x, y, z, tab_len, tab_t, tab_h)
    return t


def main():
    parts = {
        "ptt_v4_stacked_body_18mm.stl": body(),
        "ptt_v4_upper_battery_button_tray.stl": upper_tray(),
        "ptt_v4_thin_top_lid.stl": lid(),
    }
    OUT.mkdir(parents=True, exist_ok=True)
    for filename, tris in parts.items():
        mesh.write_binary_stl(OUT / filename, filename[:-4], tris)
        print(filename, len(tris), mesh.bounds(tris))
    print(f"footprint: {OUTER:.1f} x {OUTER:.1f} mm")
    print(f"height above ring top incl lid: {BODY_Z + LID_T:.1f} mm")
    print(f"side wire chase each side of XIAO: {(INNER - BOARD[1]) / 2:.2f} mm")
    print(f"gap beside upper tray each side: {(INNER - TRAY_Y) / 2:.2f} mm")


if __name__ == "__main__":
    main()
