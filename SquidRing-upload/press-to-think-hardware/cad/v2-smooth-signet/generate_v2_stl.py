#!/usr/bin/env python3
"""Press to Think V2: smooth-shoulder square signet with top button."""

from __future__ import annotations

import importlib.util
import math
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
OUTER = 27.0
INNER = 24.2
WALL = 1.4
FLOOR = 1.4
BATTERY = (16.0, 12.0, 3.5)
BOARD = (22.5, 18.0, 5.5)
PCB_SHELF_Z = FLOOR + BATTERY[2] + 0.7
INNER_Z = BATTERY[2] + 0.7 + BOARD[2] + 0.9
BODY_Z = FLOOR + INNER_Z

CAP_H = 6.4
CAP_TOP = 1.4
CAP_WALL = 1.4
BUTTON_BODY = 6.0
BUTTON_H = 5.0
BUTTON_HOLE = 3.4
LIP_H = 1.8
LIP_T = 0.8
FIT_GAP = 0.30


def smoothstep(v):
    return v * v * (3 - 2 * v)


def ellipse_loft(sections=20, radial_segments=48, side=1):
    """Organic shoulder solid joining upper ring flank to square platform."""
    rings = []
    for i in range(sections):
        u = i / (sections - 1)
        s = smoothstep(u)
        z = -8.8 + 8.8 * u
        # At the top, cx 8.0 + rx 5.5 = the 13.5 mm half-width of the face,
        # so the shoulder never bulges beyond the square signet platform.
        cx = side * (7.2 + 0.8 * s)
        rx = 2.2 + 3.3 * s
        ry = 3.1 + 10.4 * s
        ring = []
        for j in range(radial_segments):
            a = 2 * math.pi * j / radial_segments
            ring.append((cx + rx * math.cos(a), ry * math.sin(a), z))
        rings.append(ring)
    tris = []
    for i in range(sections - 1):
        for j in range(radial_segments):
            k = (j + 1) % radial_segments
            a, b = rings[i][j], rings[i][k]
            c, d = rings[i + 1][k], rings[i + 1][j]
            tris += [(a, b, c), (a, c, d)]
    # End caps.
    for ring, flip in ((rings[0], True), (rings[-1], False)):
        center = (sum(p[0] for p in ring) / radial_segments,
                  sum(p[1] for p in ring) / radial_segments,
                  ring[0][2])
        for j in range(radial_segments):
            k = (j + 1) % radial_segments
            tris.append((center, ring[k], ring[j]) if flip else (center, ring[j], ring[k]))
    return tris


def signet_body():
    t = []
    ro = RING_ID / 2 + RING_RADIAL
    t += mesh.translate(mesh.annular_band_y(RING_ID, RING_RADIAL, RING_WIDTH), dz=-ro)
    t += ellipse_loft(side=-1)
    t += ellipse_loft(side=1)
    # Thin underside platform unifies the shoulders and square enclosure.
    t += mesh.box(0, 0, -0.9, OUTER, OUTER, 1.8)
    t += mesh.box(0, 0, FLOOR / 2, OUTER, OUTER, FLOOR)

    # Rear and side walls; no side-button bay.
    t += mesh.box(0, -OUTER / 2 + WALL / 2, BODY_Z / 2, OUTER, WALL, BODY_Z)
    t += mesh.box(0, +OUTER / 2 - WALL / 2, BODY_Z / 2, OUTER, WALL, BODY_Z)
    t += mesh.box(+OUTER / 2 - WALL / 2, 0, BODY_Z / 2, WALL, INNER, BODY_Z)

    # USB-C end wall (-X), with central opening.
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

    # Battery XY locators.
    rail_h, rail_t, gap = 1.0, 0.8, 0.7
    bx, by, _ = BATTERY
    for y in (-by / 2 - gap, by / 2 + gap):
        t += mesh.box(0, y, FLOOR + rail_h / 2, bx + 2 * gap, rail_t, rail_h)
    for x in (-bx / 2 - gap, bx / 2 + gap):
        t += mesh.box(x, 0, FLOOR + rail_h / 2, rail_t, by + 2 * gap, rail_h)

    # PCB edge shelves and clear side wire lanes.
    shelf_w, shelf_h = 1.2, 0.8
    for y in (-BOARD[1] / 2 - 0.25, BOARD[1] / 2 + 0.25):
        t += mesh.box(0, y, PCB_SHELF_Z - shelf_h / 2,
                      BOARD[0] + 1.2, shelf_w, shelf_h)
    return t


def top_button_cap():
    """Deep signet cap: flat face outside, 6 mm switch pocket underneath."""
    t = []
    # Perimeter skirt.
    t += mesh.box(0, -OUTER / 2 + CAP_WALL / 2, CAP_H / 2, OUTER, CAP_WALL, CAP_H)
    t += mesh.box(0, +OUTER / 2 - CAP_WALL / 2, CAP_H / 2, OUTER, CAP_WALL, CAP_H)
    t += mesh.box(-OUTER / 2 + CAP_WALL / 2, 0, CAP_H / 2,
                  CAP_WALL, INNER, CAP_H)
    t += mesh.box(+OUTER / 2 - CAP_WALL / 2, 0, CAP_H / 2,
                  CAP_WALL, INNER, CAP_H)

    # Flat top face split around a 3.4 mm square clearance; circular bezel makes
    # the visible opening round and supports the actual 3 mm plunger.
    zc = CAP_H - CAP_TOP / 2
    side = (OUTER - BUTTON_HOLE) / 2
    t += mesh.box(0, +(BUTTON_HOLE + side) / 2, zc, OUTER, side, CAP_TOP)
    t += mesh.box(0, -(BUTTON_HOLE + side) / 2, zc, OUTER, side, CAP_TOP)
    t += mesh.box(+(BUTTON_HOLE + side) / 2, 0, zc, side, BUTTON_HOLE, CAP_TOP)
    t += mesh.box(-(BUTTON_HOLE + side) / 2, 0, zc, side, BUTTON_HOLE, CAP_TOP)
    bezel = mesh.annular_band_y(BUTTON_HOLE, 2.0, CAP_TOP, segments=64)
    # Convert bezel axis Y to Z: (x,y,z) -> (x,z,y), then place at top.
    rotated = [tuple((p[0], p[2], p[1] + CAP_H - CAP_TOP / 2) for p in tri) for tri in bezel]
    t += rotated

    # Four internal walls locate the 6 x 6 x 5 mm switch body. Switch inserts
    # from below; its legs should be bent sideways and insulated.
    pocket = BUTTON_BODY + 0.6
    pw = 1.0
    pocket_h = BUTTON_H
    pz = CAP_H - CAP_TOP - pocket_h / 2
    t += mesh.box(0, +(pocket / 2 + pw / 2), pz, pocket + 2 * pw, pw, pocket_h)
    t += mesh.box(0, -(pocket / 2 + pw / 2), pz, pocket + 2 * pw, pw, pocket_h)
    t += mesh.box(+(pocket / 2 + pw / 2), 0, pz, pw, pocket, pocket_h)
    t += mesh.box(-(pocket / 2 + pw / 2), 0, pz, pw, pocket, pocket_h)

    # Loose locating lip at lower edge of cap.
    lip = INNER - 2 * FIT_GAP
    zl = -LIP_H / 2
    t += mesh.box(0, +(lip / 2 - LIP_T / 2), zl, lip, LIP_T, LIP_H)
    t += mesh.box(0, -(lip / 2 - LIP_T / 2), zl, lip, LIP_T, LIP_H)
    t += mesh.box(+(lip / 2 - LIP_T / 2), 0, zl, LIP_T, lip - 2 * LIP_T, LIP_H)
    t += mesh.box(-(lip / 2 - LIP_T / 2), 0, zl, LIP_T, lip - 2 * LIP_T, LIP_H)
    return t


def button_retainer():
    # Two rails taped beneath the button pocket keep the switch body from
    # dropping while leaving room for bent pins and wires.
    t = []
    t += mesh.box(-3.7, 0, 0.6, 1.6, 9.0, 1.2)
    t += mesh.box(+3.7, 0, 0.6, 1.6, 9.0, 1.2)
    return t


def main():
    parts = {
        "ptt_v2_smooth_signet_body_18mm.stl": signet_body(),
        "ptt_v2_top_button_cap.stl": top_button_cap(),
        "ptt_v2_button_retainer.stl": button_retainer(),
    }
    OUT.mkdir(parents=True, exist_ok=True)
    for filename, tris in parts.items():
        mesh.write_binary_stl(OUT / filename, filename[:-4], tris)
        print(filename, len(tris), mesh.bounds(tris))
    print(f"square face: {OUTER:.1f} x {OUTER:.1f} mm")
    print(f"ring ID: {RING_ID:.1f} mm")
    print(f"height above ring top: {BODY_Z + CAP_H:.1f} mm")


if __name__ == "__main__":
    main()
