// The level as data (src/level/): the replay runs every step through the kit in order, refuses a bad step with its
// place, and the play data stays inside the world. That the replay builds the same yard as the code it replaced is
// checked in a browser by scripts/level-fingerprint.mjs (the numbers are in the pull request).
import { describe, expect, it } from "vitest";
import { LEVEL, runLayout, type LevelKit, type Step } from "../src/level/layout";

/** A kit that writes down every call: the method and its arguments. */
function recordingKit() {
  const calls: [string, unknown[]][] = [];
  const kit = new Proxy({} as LevelKit, {
    get: (_, name: string) =>
      (...args: unknown[]) => {
        calls.push([name, args]);
        return { scale: { x: 1 } };
      },
  });
  return { kit, calls };
}

/** The world as game.js builds it: oi.min / oi.max. */
const WORLD = { x: [-40, 40], z: [-30, 30] };
const inside = (x: number, z: number) => x >= WORLD.x[0] && x <= WORLD.x[1] && z >= WORLD.z[0] && z <= WORLD.z[1];

describe("the level file", () => {
  it("has the yard and the gate, every step a known op", () => {
    expect(Object.keys(LEVEL.sections)).toEqual(["yard", "gate"]);
    for (const [name, steps] of Object.entries(LEVEL.sections)) {
      const { kit } = recordingKit();
      expect(runLayout(steps, kit, name)).toBe(steps.length);
    }
  });

  it("places what the yard had: 24 container stacks, 85 props, four fence runs", () => {
    const ops = (name: string) => LEVEL.sections[name].map((s) => s.op);
    expect(ops("yard").filter((o) => o === "stack")).toHaveLength(24);
    expect(ops("yard").filter((o) => o === "place")).toHaveLength(85);
    expect(ops("gate").filter((o) => o === "fence_run")).toHaveLength(4);
  });

  it("keeps everything on the ground inside the world", () => {
    for (const steps of Object.values(LEVEL.sections))
      for (const s of steps) if ("x" in s && "z" in s) expect(inside(s.x, s.z), JSON.stringify(s)).toBe(true);
    const p = LEVEL.play;
    for (const s of p.spawns) if (s.type === "ground") expect(inside(s.pos[0], s.pos[2])).toBe(true);
    for (const c of p.coverPoints) expect(inside(c[0], c[2])).toBe(true);
    expect(inside(p.playerStart.pos[0], p.playerStart.pos[2])).toBe(true);
  });

  it("gives every spawn a zone that exists", () => {
    const zones = new Set(LEVEL.play.zones.map((z) => z.name));
    expect(zones).toEqual(new Set(["gate", "yard", "shed", "quay"]));
    for (const s of LEVEL.play.spawns) expect(zones.has(s.zone), s.zone).toBe(true);
    expect(LEVEL.play.spawns.filter((s) => s.type === "air")).toHaveLength(17);
  });
});

describe("the replay", () => {
  it("calls the kit in step order with the step's values", () => {
    const { kit, calls } = recordingKit();
    runLayout(
      [
        { op: "stack", x: 1, z: 2, boxes: [[20, "red"]] },
        { op: "place", kind: "barrel", x: 3, z: 4, yaw: 0.5, opts: { seed: 7 } },
        { op: "col", min: [0, 0, 0], max: [1, 2, 3], surface: "wood" },
        { op: "lane_sign", x: 5, z: 6, text: "LANE 9", face: "x+" },
      ],
      kit,
    );
    expect(calls).toEqual([
      ["stack", [1, 2, [[20, "red"]], undefined, undefined]],
      ["place", ["barrel", 3, 4, 0.5, { seed: 7 }, undefined, undefined]],
      ["col", [0, 0, 0, 1, 2, 3, "wood", undefined]],
      ["laneSign", [5, 6, "LANE 9", "x+", undefined]],
    ]);
  });

  it("hands the kit copies, so the data never changes", () => {
    const step: Step = { op: "place", kind: "crate_wood", x: 0, z: 0, opts: { seed: 1 } };
    const kit = { place: (_k: string, _x: number, _z: number, _y?: number, o?: Record<string, unknown>) => ((o!.seed = 99), { scale: { x: 1 } }) } as unknown as LevelKit;
    runLayout([step], kit);
    expect(step.opts).toEqual({ seed: 1 });
  });

  it("refuses an unknown op, naming the section and step", () => {
    const { kit } = recordingKit();
    expect(() => runLayout([{ op: "teleporter" } as unknown as Step], kit, "docks")).toThrow('level docks[0]: unknown op "teleporter"');
  });

  it("refuses a step with a missing or broken number", () => {
    const { kit, calls } = recordingKit();
    const bad = [
      { op: "place", kind: "barrel", x: 1 },
      { op: "place", kind: "barrel", x: Number.NaN, z: 0 },
      { op: "col", min: [0, 0], max: [1, 1, 1] },
      { op: "stack", x: 0, z: 0, boxes: [] },
    ] as unknown as Step[];
    for (const s of bad) expect(() => runLayout([s], kit)).toThrow(/^level layout\[0\]/);
    expect(calls).toEqual([]);
  });

  it("stops at the first bad step, after building the good ones before it", () => {
    const { kit, calls } = recordingKit();
    expect(() =>
      runLayout([{ op: "chock", x: 0, z: 0 }, { op: "chock", z: 0 } as unknown as Step, { op: "chock", x: 1, z: 1 }], kit, "yard"),
    ).toThrow("level yard[1]: x must be a finite number");
    expect(calls).toHaveLength(1);
  });

  it("lays a fence run as stretched panels and two walls", () => {
    const { kit, calls } = recordingKit();
    runLayout([{ op: "fence_run", from: [-38, -30], to: [30, -30], seed: 100 }], kit);
    const panels = calls.filter(([m]) => m === "place");
    expect(panels).toHaveLength(20); // 68 m at ~3.35 m a panel
    expect(panels[0][1].slice(0, 4)).toEqual(["fence_panel", -38 + 68 * (0.5 / 20), -30, 0]);
    expect((panels[19][1][4] as { posts: string }).posts).toBe("both");
    const walls = calls.filter(([m]) => m === "col");
    expect(walls.map(([, a]) => a[4])).toEqual([2.4, 7]);
    expect(walls[1][1][7]).toEqual({ playerOnly: true });
  });

  it("hangs a cable on nine points, lowest in the middle", () => {
    const { kit, calls } = recordingKit();
    runLayout([{ op: "sag_cable", from: [0, 10, 0], to: [8, 10, 0], sag: 1 }], kit);
    const [mat, points, r] = calls[0][1] as [string, number[][], number];
    expect(mat).toBe("rubber");
    expect(r).toBe(0.018);
    expect(points).toHaveLength(9);
    expect(points[4]).toEqual([4, 9, 0]);
    expect(points[0][1]).toBe(10);
    expect(points[8][1]).toBe(10);
  });
});
