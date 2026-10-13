#!/usr/bin/env python3
"""Press to Think V1 square signet-ring fit prototype.

The model intentionally uses removable foam/tape for V1 retention because the
exact PCB component map and wire exit coordinates have not yet been measured.
All dimensions are millimetres.
"""

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

# User measurements
BOARD_X, BOARD_Y, BOARD_Z = 22.5, 18.0, 5.5
BATTERY_X, BATTERY_Y, BATTERY_Z = 16.0, 12.0, 3.5
BUTTON_BODY = 6.0
BUTTON_PLUNGER_D = 3.0
WIRE_D = 0.7

# Design parameters
RING_ID = 18.0
RING_RADIAL = 2.2
RING_WIDTH = 6.0
WALL = 1.4
FLOOR = 1.4
INNER = 24.2
OUTER = INNER + 2 * WALL  # 27 mm square signet
BATTERY_GAP = 0.7
PCB_EDGE_CLEARANCE = 0.6
PCB_SHELF_Z = FLOOR + BATTERY_Z + 0.7
INNER_Z = BATTERY_Z + 0.7 + BOARD_Z + 0.9
BODY_Z = FLOOR + INNER_Z
LID_T = 1.4
LIP_H = 1.8
LIP_T = 0.8
FIT_GAP = 0.30


def signet_body():
    t = []
    # Integrated ring and broad square signet platform.
    ring_ro = RING_ID / 2 + RING_RADIAL
    t += mesh.translate(mesh.annular_band_y(RING_ID, RING_RADIAL, RING_WIDTH), dz=-ring_ro)
    t += mesh.box(0, 0, -RING_RADIAL / 2, OUTER, OUTER, RING_RADIAL)

    # Shoulder blocks strengthen the ring/platform joint. Their stepped form is
    # deliberately plain for V1 and can be sculpted after fit is confirmed.
    for x in (-9.8, 9.8):
        t += mesh.box(x, 0, -3.0, 7.4, 10.0, 6.0)
    for x in (-7.2, 7.2):
        t += mesh.box(x, 0, -6.0, 4.5, 8.0, 6.0)

    # Enclosure floor.
    t += mesh.box(0, 0, FLOOR / 2, OUTER, OUTER, FLOOR)

    # Walls. +Y wall leaves a central opening into the side-button pod.
    t += mesh.box(0, -OUTER / 2 + WALL / 2, BODY_Z / 2, OUTER, WALL, BODY_Z)
    t += mesh.box(+OUTER / 2 - WALL / 2, 0, BODY_Z / 2, WALL, INNER, BODY_Z)

    # USB-C wall at -X: centered opening 11 x 5.4 mm at PCB height.
    usb_w, usb_h = 11.0, 5.4
    usb_z0 = PCB_SHELF_Z
    side = (INNER - usb_w) / 2
    t += mesh.box(-OUTER / 2 + WALL / 2, +(usb_w + side) / 2, BODY_Z / 2,
                  WALL, side, BODY_Z)
    t += mesh.box(-OUTER / 2 + WALL / 2, -(usb_w + side) / 2, BODY_Z / 2,
                  WALL, side, BODY_Z)
    t += mesh.box(-OUTER / 2 + WALL / 2, 0, usb_z0 / 2, WALL, usb_w, usb_z0)
    top_h = BODY_Z - usb_z0 - usb_h
    if top_h > 0:
        t += mesh.box(-OUTER / 2 + WALL / 2, 0, usb_z0 + usb_h + top_h / 2,
                      WALL, usb_w, top_h)

    # +Y wall split around button/wire bay (8.2 mm wide).
    bay_w = 8.2
    wall_side = (OUTER - bay_w) / 2
    t += mesh.box(+(bay_w + wall_side) / 2, +OUTER / 2 - WALL / 2,
                  BODY_Z / 2, wall_side, WALL, BODY_Z)
    t += mesh.box(-(bay_w + wall_side) / 2, +OUTER / 2 - WALL / 2,
                  BODY_Z / 2, wall_side, WALL, BODY_Z)

    # Battery locating rails. They prevent XY sliding but never clamp the pouch.
    rail_h, rail_t = 1.0, 0.8
    for y in (-BATTERY_Y / 2 - BATTERY_GAP, BATTERY_Y / 2 + BATTERY_GAP):
        t += mesh.box(0, y, FLOOR + rail_h / 2, BATTERY_X + 2 * BATTERY_GAP,
                      rail_t, rail_h)
    for x in (-BATTERY_X / 2 - BATTERY_GAP, BATTERY_X / 2 + BATTERY_GAP):
        t += mesh.box(x, 0, FLOOR + rail_h / 2, rail_t,
                      BATTERY_Y + 2 * BATTERY_GAP, rail_h)

    # PCB edge shelves: board rests only on its long outer edges. Central area
    # stays open so underside components and battery are not crushed.
    shelf_w = 1.2
    shelf_h = 0.8
    for y in (-BOARD_Y / 2 - 0.25, BOARD_Y / 2 + 0.25):
        t += mesh.box(0, y, PCB_SHELF_Z - shelf_h / 2,
                      BOARD_X + 2 * PCB_EDGE_CLEARANCE, shelf_w, shelf_h)

    # Side-button pod. Switch rotates 90 degrees; its 3 mm plunger points +Y.
    pod_inner_x = BUTTON_BODY + 0.6
    pod_depth = BUTTON_BODY + 1.0
    pod_floor_t = 1.2
    pod_x_wall = 1.2
    pod_y0 = OUTER / 2 - 0.2
    pod_cy = pod_y0 + pod_depth / 2
    pod_z0 = 3.8
    pod_cz = pod_z0 + BUTTON_BODY / 2
    t += mesh.box(0, pod_cy, pod_z0 - pod_floor_t / 2,
                  pod_inner_x + 2 * pod_x_wall, pod_depth, pod_floor_t)
    for x in (-pod_inner_x / 2 - pod_x_wall / 2,
              pod_inner_x / 2 + pod_x_wall / 2):
        t += mesh.box(x, pod_cy, pod_cz, pod_x_wall, pod_depth, BUTTON_BODY + 0.6)

    # Circular bezel doubles as the front wall and gives a true 3.4 mm hole.
    bezel = mesh.annular_band_y(BUTTON_PLUNGER_D + 0.4, 2.7, WALL, segments=64)
    bezel_y = pod_y0 + pod_depth
    t += mesh.translate(bezel, dy=bezel_y, dz=pod_cz)
    return t


def lid():
    t = []
    t += mesh.box(0, 0, LID_T / 2, OUTER, OUTER, LID_T)
    lip = INNER - 2 * FIT_GAP
    z = LID_T + LIP_H / 2
    t += mesh.box(0, +(lip / 2 - LIP_T / 2), z, lip, LIP_T, LIP_H)
    t += mesh.box(0, -(lip / 2 - LIP_T / 2), z, lip, LIP_T, LIP_H)
    t += mesh.box(+(lip / 2 - LIP_T / 2), 0, z, LIP_T, lip - 2 * LIP_T, LIP_H)
    t += mesh.box(-(lip / 2 - LIP_T / 2), 0, z, LIP_T, lip - 2 * LIP_T, LIP_H)
    return t


def button_pod_cap():
    # Removable top cap for the sideways switch pocket; secure with thin tape in V1.
    return mesh.box(0, 0, 0.6, BUTTON_BODY + 3.0, BUTTON_BODY + 2.0, 1.2)


def sizing_ring(inner_d):
    # Thin, fast test ring. Print these before the full signet body.
    return mesh.annular_band_y(inner_d, 1.6, 4.0, segments=96)


def main():
    parts = {
        "ptt_v1_signet_body_18mm.stl": signet_body(),
        "ptt_v1_square_lid.stl": lid(),
        "ptt_v1_button_pod_cap.stl": button_pod_cap(),
        "size_test_17.2mm.stl": sizing_ring(17.2),
        "size_test_17.6mm.stl": sizing_ring(17.6),
        "size_test_18.0mm.stl": sizing_ring(18.0),
    }
    OUT.mkdir(parents=True, exist_ok=True)
    for filename, tris in parts.items():
        mesh.write_binary_stl(OUT / filename, filename[:-4], tris)
        print(filename, len(tris), mesh.bounds(tris))
    print(f"square top: {OUTER:.1f} x {OUTER:.1f} mm")
    print(f"electronics chamber: {INNER:.1f} x {INNER:.1f} x {INNER_Z:.1f} mm")
    print(f"body above finger: {BODY_Z + LID_T:.1f} mm")


if __name__ == "__main__":
    main()
