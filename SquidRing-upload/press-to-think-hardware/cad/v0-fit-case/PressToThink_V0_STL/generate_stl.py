#!/usr/bin/env python3
"""Generate Press to Think V0 fit-check STL parts without external packages.

All dimensions are millimetres. This is a mechanical fit prototype, not a
sealed or production-ready wearable enclosure.
"""

from __future__ import annotations

import math
import struct
from pathlib import Path


OUT = Path(__file__).resolve().parent / "out"

# Measured component envelopes supplied by the user.
BOARD = (22.5, 18.0, 5.5)
BATTERY = (16.0, 12.0, 3.5)
BUTTON = (6.0, 6.0, 5.0)
WIRE_DIAMETER = 0.7

# Prototype parameters.
WALL = 1.4
FLOOR = 1.4
CLEAR_XY = 0.75
CLEAR_Z = 0.8
SEPARATOR = 0.6
LID_THICKNESS = 1.4
LIP_HEIGHT = 1.8
LIP_THICKNESS = 0.8
FIT_GAP = 0.30
RING_INNER_DIAMETER = 20.0
RING_BAND_RADIAL = 2.2
RING_BAND_WIDTH = 5.0

INNER_X = BOARD[0] + 2 * CLEAR_XY
INNER_Y = BOARD[1] + 2 * CLEAR_XY
INNER_Z = BATTERY[2] + SEPARATOR + BOARD[2] + CLEAR_Z
OUTER_X = INNER_X + 2 * WALL
OUTER_Y = INNER_Y + 2 * WALL
BODY_Z = FLOOR + INNER_Z

Triangle = tuple[tuple[float, float, float], tuple[float, float, float], tuple[float, float, float]]


def box(cx: float, cy: float, cz: float, sx: float, sy: float, sz: float) -> list[Triangle]:
    x0, x1 = cx - sx / 2, cx + sx / 2
    y0, y1 = cy - sy / 2, cy + sy / 2
    z0, z1 = cz - sz / 2, cz + sz / 2
    p = [
        (x0, y0, z0), (x1, y0, z0), (x1, y1, z0), (x0, y1, z0),
        (x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1),
    ]
    faces = [
        (0, 2, 1), (0, 3, 2),  # bottom
        (4, 5, 6), (4, 6, 7),  # top
        (0, 1, 5), (0, 5, 4),
        (1, 2, 6), (1, 6, 5),
        (2, 3, 7), (2, 7, 6),
        (3, 0, 4), (3, 4, 7),
    ]
    return [(p[a], p[b], p[c]) for a, b, c in faces]


def annular_band_y(inner_d: float, radial: float, width: float, segments: int = 96) -> list[Triangle]:
    """A ring around the Y axis, suitable for printing on its side."""
    ri = inner_d / 2
    ro = ri + radial
    y0, y1 = -width / 2, width / 2
    tris: list[Triangle] = []
    for i in range(segments):
        a0 = 2 * math.pi * i / segments
        a1 = 2 * math.pi * (i + 1) / segments
        def v(r: float, y: float, a: float):
            return (r * math.cos(a), y, r * math.sin(a))
        oi0, oi1 = v(ro, y0, a0), v(ro, y0, a1)
        oo0, oo1 = v(ro, y1, a0), v(ro, y1, a1)
        ii0, ii1 = v(ri, y0, a0), v(ri, y0, a1)
        io0, io1 = v(ri, y1, a0), v(ri, y1, a1)
        tris += [
            (oi0, oi1, oo1), (oi0, oo1, oo0),  # outer cylinder
            (ii0, io1, ii1), (ii0, io0, io1),  # inner cylinder
            (ii0, ii1, oi1), (ii0, oi1, oi0),  # y0 side
            (io0, oo1, io1), (io0, oo0, oo1),  # y1 side
        ]
    return tris


def translate(tris: list[Triangle], dx=0.0, dy=0.0, dz=0.0) -> list[Triangle]:
    return [tuple((x + dx, y + dy, z + dz) for x, y, z in tri) for tri in tris]  # type: ignore


def normal(tri: Triangle) -> tuple[float, float, float]:
    a, b, c = tri
    ux, uy, uz = b[0] - a[0], b[1] - a[1], b[2] - a[2]
    vx, vy, vz = c[0] - a[0], c[1] - a[1], c[2] - a[2]
    nx, ny, nz = uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx
    mag = math.sqrt(nx * nx + ny * ny + nz * nz) or 1.0
    return nx / mag, ny / mag, nz / mag


def write_binary_stl(path: Path, name: str, tris: list[Triangle]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    header = (f"PressToThink {name}").encode("ascii")[:80].ljust(80, b" ")
    with path.open("wb") as f:
        f.write(header)
        f.write(struct.pack("<I", len(tris)))
        for tri in tris:
            values = (*normal(tri), *tri[0], *tri[1], *tri[2])
            f.write(struct.pack("<12fH", *values, 0))


def body() -> list[Triangle]:
    tris: list[Triangle] = []
    # Bottom and rear/side walls.
    tris += box(0, 0, FLOOR / 2, OUTER_X, OUTER_Y, FLOOR)
    tris += box(0, OUTER_Y / 2 - WALL / 2, BODY_Z / 2, OUTER_X, WALL, BODY_Z)
    tris += box(0, -OUTER_Y / 2 + WALL / 2, BODY_Z / 2, OUTER_X, WALL, BODY_Z)
    tris += box(OUTER_X / 2 - WALL / 2, 0, BODY_Z / 2, WALL, INNER_Y, BODY_Z)

    # USB-C end wall (-X) with a centred 11 x 5.2 mm opening at board level.
    slot_w = 11.0
    slot_h = 5.2
    slot_z0 = FLOOR + BATTERY[2] + SEPARATOR
    side_w = (INNER_Y - slot_w) / 2
    tris += box(-OUTER_X / 2 + WALL / 2, +(slot_w + side_w) / 2, BODY_Z / 2,
                WALL, side_w, BODY_Z)
    tris += box(-OUTER_X / 2 + WALL / 2, -(slot_w + side_w) / 2, BODY_Z / 2,
                WALL, side_w, BODY_Z)
    if slot_z0 > 0:
        tris += box(-OUTER_X / 2 + WALL / 2, 0, slot_z0 / 2, WALL, slot_w, slot_z0)
    top_h = max(0.0, BODY_Z - slot_z0 - slot_h)
    if top_h:
        tris += box(-OUTER_X / 2 + WALL / 2, 0, slot_z0 + slot_h + top_h / 2,
                    WALL, slot_w, top_h)

    # Two low battery locating rails; they do not clamp the pouch cell.
    rail_h = 0.8
    rail_t = 0.8
    for y in (-BATTERY[1] / 2 - 0.5, BATTERY[1] / 2 + 0.5):
        tris += box(2.0, y, FLOOR + rail_h / 2, BATTERY[0] + 1.0, rail_t, rail_h)
    return tris


def lid() -> list[Triangle]:
    tris: list[Triangle] = []
    z = LID_THICKNESS / 2
    tris += box(0, 0, z, OUTER_X, OUTER_Y, LID_THICKNESS)
    # Inner locating lip, deliberately loose for first-print tolerance.
    lip_x = INNER_X - 2 * FIT_GAP
    lip_y = INNER_Y - 2 * FIT_GAP
    zlip = LID_THICKNESS + LIP_HEIGHT / 2
    tris += box(0, +(lip_y / 2 - LIP_THICKNESS / 2), zlip, lip_x, LIP_THICKNESS, LIP_HEIGHT)
    tris += box(0, -(lip_y / 2 - LIP_THICKNESS / 2), zlip, lip_x, LIP_THICKNESS, LIP_HEIGHT)
    tris += box(+(lip_x / 2 - LIP_THICKNESS / 2), 0, zlip, LIP_THICKNESS,
                lip_y - 2 * LIP_THICKNESS, LIP_HEIGHT)
    tris += box(-(lip_x / 2 - LIP_THICKNESS / 2), 0, zlip, LIP_THICKNESS,
                lip_y - 2 * LIP_THICKNESS, LIP_HEIGHT)

    # External button cradle. Button is retained with removable tape in V0.
    cup_inner = BUTTON[0] + 0.6
    cup_wall = 1.2
    cup_h = 3.0
    cx = 2.0
    cy = 0.0
    zc = LID_THICKNESS + cup_h / 2
    tris += box(cx, cy + cup_inner / 2 + cup_wall / 2, zc,
                cup_inner + 2 * cup_wall, cup_wall, cup_h)
    tris += box(cx, cy - cup_inner / 2 - cup_wall / 2, zc,
                cup_inner + 2 * cup_wall, cup_wall, cup_h)
    tris += box(cx + cup_inner / 2 + cup_wall / 2, cy, zc,
                cup_wall, cup_inner, cup_h)
    tris += box(cx - cup_inner / 2 - cup_wall / 2, cy, zc,
                cup_wall, cup_inner, cup_h)
    return tris


def button_cap() -> list[Triangle]:
    # A simple oversized cap to make the 6 mm tactile switch easier to press.
    return box(0, 0, 1.2, 8.0, 8.0, 2.4)


def ring_mount() -> list[Triangle]:
    tris = annular_band_y(RING_INNER_DIAMETER, RING_BAND_RADIAL, RING_BAND_WIDTH)
    # Move ring below a flat mounting plate; adhesive/tape attachment for V0.
    ring_outer_r = RING_INNER_DIAMETER / 2 + RING_BAND_RADIAL
    tris = translate(tris, dz=-ring_outer_r)
    plate_z = -RING_BAND_RADIAL / 2
    tris += box(0, 0, plate_z, OUTER_X, OUTER_Y, RING_BAND_RADIAL)
    return tris


def bounds(tris: list[Triangle]):
    pts = [p for tri in tris for p in tri]
    return tuple((min(p[i] for p in pts), max(p[i] for p in pts)) for i in range(3))


def main() -> None:
    parts = {
        "ptt_v0_body.stl": body(),
        "ptt_v0_lid.stl": lid(),
        "ptt_v0_button_cap.stl": button_cap(),
        "ptt_v0_ring_20mm.stl": ring_mount(),
    }
    for filename, tris in parts.items():
        write_binary_stl(OUT / filename, filename[:-4], tris)
        print(f"{filename}: {len(tris)} triangles, bounds={bounds(tris)}")
    print(f"enclosure outer: {OUTER_X:.2f} x {OUTER_Y:.2f} x {BODY_Z + LID_THICKNESS:.2f} mm")
    print(f"enclosure inner: {INNER_X:.2f} x {INNER_Y:.2f} x {INNER_Z:.2f} mm")


if __name__ == "__main__":
    main()
