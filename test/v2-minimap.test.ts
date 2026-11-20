// The minimap's arithmetic (src/economy/v2/minimap/rules.ts): the disc turns with the player, far marks wait at its
// edge, only what the player could stand on or run into is drawn, and only machines that have seen the player show.
import { describe, expect, it } from "vitest";
import { MINI, clampToRing, drawnBoxes, extentOf, marks, tierOf, toDisc, type MarkInput } from "../src/economy/v2/minimap/rules";

const near = (a: { x: number; y: number }, b: { x: number; y: number }) => {
  expect(a.x).toBeCloseTo(b.x, 9);
  expect(a.y).toBeCloseTo(b.y, 9);
};

describe("the disc turns with the player", () => {
  it("facing −z (yaw 0) it reads like the plan: ahead is up, +x is right", () => {
    const v = { x: 10, z: 5, yaw: 0, k: 2 };
    near(toDisc(v, 10, -5), { x: 0, y: -20 }); // 10 m ahead
    near(toDisc(v, 13, 5), { x: 6, y: 0 }); // 3 m to the right
  });

  it("facing +x (yaw −π/2, the player's start) ahead is still up and +z is to the right", () => {
    const v = { x: -32, z: 6, yaw: -Math.PI / 2, k: 1 };
    near(toDisc(v, -22, 6), { x: 0, y: -10 }); // 10 m up the lane, into the yard
    near(toDisc(v, -32, 10), { x: 4, y: 0 }); // 4 m to the player's right
    near(toDisc(v, -36, 6), { x: 0, y: 4 }); // behind, toward the gate
  });

  it("the player's own spot is the centre at any heading", () => {
    for (const yaw of [0, 1, -2.5, Math.PI]) near(toDisc({ x: 3, z: -4, yaw, k: 3 }, 3, -4), { x: 0, y: 0 });
  });
});

describe("far marks", () => {
  it("stay where they are inside the ring and move in to its edge along their bearing outside it", () => {
    expect(clampToRing({ x: 3, y: 4 }, 10)).toEqual({ x: 3, y: 4, edge: false });
    const e = clampToRing({ x: 30, y: 40 }, 10);
    expect(e.edge).toBe(true);
    expect(e.x).toBeCloseTo(6, 9);
    expect(e.y).toBeCloseTo(8, 9);
  });
});

describe("what is drawn of the yard", () => {
  const b = (y0: number, y1: number, extra = {}) => ({ min: { x: 0, y: y0, z: 0 }, max: { x: 1, y: y1, z: 1 }, ...extra });

  it("leaves out invisible walls, floor slabs and what is overhead, and draws the rest lowest first", () => {
    const keep = [b(0, 2.59), b(2.59, 5.18), b(0, 0.9)];
    const drop = [b(0, 7, { playerOnly: true }), b(0, 2.4, { bulletOnly: true }), b(0, 0.05), b(7, 9.5)];
    expect(drawnBoxes([...drop, ...keep]).map((x) => x.max.y)).toEqual([0.9, 2.59, 5.18]);
  });

  it("shades by the top's height: cover, one container, two stacked, higher", () => {
    expect([0.9, 1.3, 2.59, 5.18, 7.77, 14].map(tierOf)).toEqual([0, 0, 1, 2, 3, 3]);
  });

  it("frames the boxes and the zones with a margin, and is null with nothing to draw", () => {
    const e = extentOf([{ min: { x: -10, y: 0, z: -5 }, max: { x: 20, y: 2, z: 8 } }], [{ min: [-40, -30], max: [40, 30] }]);
    expect(e).toEqual({ x0: -40 - MINI.margin, z0: -30 - MINI.margin, x1: 40 + MINI.margin, z1: 30 + MINI.margin });
    expect(extentOf([])).toBeNull();
  });
});

describe("the marks", () => {
  const base = (): MarkInput => ({
    relays: [
      { id: "relay_a", pos: { x: 1.5, z: 7.5 } },
      { id: "relay_b", pos: { x: -2, z: -19.5 } },
      { id: "relay_c", pos: { x: 23, z: 0 } },
    ],
    cut: new Set(),
    boat: { pos: { x: 29, z: 20 } },
    boatOpen: false,
    targets: [
      { kind: "seal", bonded: false, at: { x: 5, z: 5 } },
      { kind: "seal", bonded: true, at: { x: 6, z: 5 } },
      { kind: "wreck", bonded: false, at: { x: 7, z: 5 } },
    ],
    machines: [],
    player: { x: 0, y: 0, z: 0 },
  });

  it("names the uplinks still to cut by their letter and holds them at the edge", () => {
    const i = base();
    i.cut = new Set(["relay_b"]);
    const r = marks(i).filter((m) => m.kind === "relay");
    expect(r.map((m) => m.label)).toEqual(["A", "C"]);
    expect(r.every((m) => m.pinned)).toBe(true);
  });

  it("shows the boat shut until all three are cut, then open and held at the edge", () => {
    expect(marks(base()).find((m) => m.kind.startsWith("boat"))).toMatchObject({ kind: "boat-shut", pinned: false });
    const i = base();
    i.boatOpen = true;
    expect(marks(i).find((m) => m.kind.startsWith("boat"))).toMatchObject({ kind: "boat", pinned: true });
  });

  it("tells sealed, bonded and wrecked apart, and shows them only in range", () => {
    const t = marks(base()).filter((m) => ["seal", "bonded", "wreck"].includes(m.kind));
    expect(t.map((m) => m.kind)).toEqual(["seal", "bonded", "wreck"]);
    expect(t.every((m) => !m.pinned)).toBe(true);
  });

  it("shows a machine only once it has seen the player and is within the marker range, flying ones apart", () => {
    const i = base();
    i.machines = [
      { alive: true, mode: "patrol", pos: { x: 5, y: 0, z: 0 } }, // hasn't seen the player
      { alive: true, mode: "engage", pos: { x: 10, y: 0, z: 0 } }, // a hound that has
      { alive: true, mode: "engage", pos: { x: 0, y: 8, z: 12 } }, // a gull that has
      { alive: false, mode: "engage", pos: { x: 3, y: 0, z: 0 } }, // destroyed
      { alive: true, mode: "engage", pos: { x: 300, y: 0, z: 0 } }, // too far
    ];
    expect(marks(i).filter((m) => m.kind.startsWith("threat")).map((m) => [m.kind, m.x])).toEqual([
      ["threat", 10],
      ["threat-air", 0],
    ]);
  });
});
