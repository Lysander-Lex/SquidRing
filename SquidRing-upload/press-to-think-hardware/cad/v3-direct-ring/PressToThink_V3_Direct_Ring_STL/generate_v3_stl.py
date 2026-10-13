#!/usr/bin/env python3
"""Press to Think V3: direct circular ring, square case, protected wire lanes."""

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
OUTER = 28.0
WALL = 1.4
INNER = OUTER - 2 * WALL  # 25.2 mm
FLOOR = 1.4
BATTERY = (16.0, 12.0, 3.5)
BOARD = (22.5, 18.0, 5.5)
WIRE_D = 0.7
PCB_SHELF_Z = FLOOR + BATTERY[2] + 0.8
INNER_Z = BATTERY[2] + 0.8 + BOARD[2] + 1.0
BODY_Z = FLOOR + INNER_Z

CAP_H = 6.4
CAP_TOP = 1.4
BUTTON_BODY = 6.0
BUTTON_H = 5.0
BUTTON_HOLE = 3.4
LIP_H = 1.8
LIP_T = 0.8
FIT_GAP = 0.30


def signet_body():
    t = []
    ro = RING_ID / 2 + RING_RADIAL
    # Direct annular ring: no shoulder or sculpted transition.
    t += mesh.translate(mesh.annular_band_y(RING_ID, RING_RADIAL, RING_WIDTH), dz=-ro)
    t += mesh.box(0, 0, -RING_RADIAL / 2, OUTER, OUTER, RING_RADIAL)
    t += mesh.box(0, 0, FLOOR / 2, OUTER, OUTER, FLOOR)

    # Main walls.
    t += mesh.box(0, -OUTER / 2 + WALL / 2, BODY_Z / 2, OUTER, WALL, BODY_Z)
    t += mesh.box(0, +OUTER / 2 - WALL / 2, BODY_Z / 2, OUTER, WALL, BODY_Z)
    t += mesh.box(+OUTER / 2 - WALL / 2, 0, BODY_Z / 2, WALL, INNER, BODY_Z)

    # USB-C end wall (-X), centered opening.
    usb_w, usb_h = 11.0, 5.4
    usb_z0 = PCB_SHELF_Z
    side_w = (INNER - usb_w) / 2
    t += mesh.box(-OUTER / 2 + WALL / 2, +(usb_w + side_w) / 2, BODY_Z / 2,
                  WALL, side_w, BODY_Z)
    t += mesh.box(-OUTER / 2 + WALL / 2, -(usb_w + side_w) / 2, BODY_Z / 2,
                  WALL, side_w, BODY_Z)
    t += mesh.box(-OUTER / 2 + WALL / 2, 0, usb_z0 / 2, WALL, usb_w, usb_z0)
    top_h = BODY_Z - usb_z0 - usb_h
    if top_h > 0:
        t += mesh.box(-OUTER / 2 + WALL / 2, 0, usb_z0 + usb_h + top_h / 2,
                      WALL, usb_w, top_h)

    # Battery corner locators, deliberately interrupted on all four sides.
    # The 4 mm centre gaps let either battery lead exit without a sharp bend.
    bx, by, _ = BATTERY
    gap, rail_t, rail_h = 0.8, 0.8, 1.0
    seg_x = (bx + 2 * gap - 4.0) / 2
    for y in (-by / 2 - gap, by / 2 + gap):
        for x in (-(seg_x + 4.0) / 2, +(seg_x + 4.0) / 2):
            t += mesh.box(x, y, FLOOR + rail_h / 2, seg_x, rail_t, rail_h)
    seg_y = (by + 2 * gap - 4.0) / 2
    for x in (-bx / 2 - gap, bx / 2 + gap):
        for y in (-(seg_y + 4.0) / 2, +(seg_y + 4.0) / 2):
            t += mesh.box(x, y, FLOOR + rail_h / 2, rail_t, seg_y, rail_h)

    # PCB shelves support only the long board edges. The space outside each
    # shelf is a dedicated wire lane, not part of the board fit.
    shelf_w, shelf_h = 1.0, 0.8
    for y in (-BOARD[1] / 2 - 0.3, BOARD[1] / 2 + 0.3):
        t += mesh.box(0, y, PCB_SHELF_Z - shelf_h / 2,
                      BOARD[0] + 1.4, shelf_w, shelf_h)

    # Four small cable keeper tabs sit above the lane floor. They keep a taped
    # 0.7 mm wire below the lid seam without clamping it.
    lane_y = BOARD[1] / 2 + 2.0
    for y in (-lane_y, lane_y):
        for x in (-7.0, 7.0):
            t += mesh.box(x, y, PCB_SHELF_Z + 0.55, 3.0, 0.7, 0.7)
    return t


def top_button_cap():
    t = []
    # Perimeter cap walls.
    t += mesh.box(0, -OUTER / 2 + WALL / 2, CAP_H / 2, OUTER, WALL, CAP_H)
    t += mesh.box(0, +OUTER / 2 - WALL / 2, CAP_H / 2, OUTER, WALL, CAP_H)
    t += mesh.box(-OUTER / 2 + WALL / 2, 0, CAP_H / 2, WALL, INNER, CAP_H)
    t += mesh.box(+OUTER / 2 - WALL / 2, 0, CAP_H / 2, WALL, INNER, CAP_H)

    # Flat face with central button opening.
    zc = CAP_H - CAP_TOP / 2
    side = (OUTER - BUTTON_HOLE) / 2
    t += mesh.box(0, +(BUTTON_HOLE + side) / 2, zc, OUTER, side, CAP_TOP)
    t += mesh.box(0, -(BUTTON_HOLE + side) / 2, zc, OUTER, side, CAP_TOP)
    t += mesh.box(+(BUTTON_HOLE + side) / 2, 0, zc, side, BUTTON_HOLE, CAP_TOP)
    t += mesh.box(-(BUTTON_HOLE + side) / 2, 0, zc, side, BUTTON_HOLE, CAP_TOP)
    bezel = mesh.annular_band_y(BUTTON_HOLE, 2.0, CAP_TOP, segments=64)
    t += [tuple((p[0], p[2], p[1] + CAP_H - CAP_TOP / 2) for p in tri) for tri in bezel]

    # Button body pocket.
    pocket, pw = BUTTON_BODY + 0.6, 1.0
    pz = CAP_H - CAP_TOP - BUTTON_H / 2
    t += mesh.box(0, +(pocket / 2 + pw / 2), pz, pocket + 2 * pw, pw, BUTTON_H)
    t += mesh.box(0, -(pocket / 2 + pw / 2), pz, pocket + 2 * pw, pw, BUTTON_H)
    t += mesh.box(+(pocket / 2 + pw / 2), 0, pz, pw, pocket, BUTTON_H)
    t += mesh.box(-(pocket / 2 + pw / 2), 0, pz, pw, pocket, BUTTON_H)

    # Four short corner locating tabs replace continuous lips. Long gaps along
    # both sides are explicit wire passages, so the cap cannot pinch the leads.
    lip = INNER - 2 * FIT_GAP
    tab_len = 5.0
    zl = -LIP_H / 2
    for y in (-(lip / 2 - LIP_T / 2), +(lip / 2 - LIP_T / 2)):
        for x in (-(lip / 2 - tab_len / 2 - 1.0), +(lip / 2 - tab_len / 2 - 1.0)):
            t += mesh.box(x, y, zl, tab_len, LIP_T, LIP_H)
    for x in (-(lip / 2 - LIP_T / 2), +(lip / 2 - LIP_T / 2)):
        for y in (-(lip / 2 - tab_len / 2 - 1.0), +(lip / 2 - tab_len / 2 - 1.0)):
            t += mesh.box(x, y, zl, LIP_T, tab_len, LIP_H)
    return t


def button_retainer():
    t = []
    t += mesh.box(-3.7, 0, 0.6, 1.6, 9.0, 1.2)
    t += mesh.box(+3.7, 0, 0.6, 1.6, 9.0, 1.2)
    return t


def main():
    parts = {
        "ptt_v3_direct_ring_body_18mm.stl": signet_body(),
        "ptt_v3_top_button_cap.stl": top_button_cap(),
        "ptt_v3_button_retainer.stl": button_retainer(),
    }
    OUT.mkdir(parents=True, exist_ok=True)
    for filename, tris in parts.items():
        mesh.write_binary_stl(OUT / filename, filename[:-4], tris)
        print(filename, len(tris), mesh.bounds(tris))
    side_lane = (INNER - BOARD[1]) / 2
    end_clearance = (INNER - BOARD[0]) / 2
    print(f"square face: {OUTER:.1f} x {OUTER:.1f} mm")
    print(f"ring ID: {RING_ID:.1f} mm")
    print(f"side wire lane each side: {side_lane:.2f} mm for {WIRE_D:.1f} mm wire")
    print(f"board end clearance each end: {end_clearance:.2f} mm")


if __name__ == "__main__":
    main()
