// The level as data. `yard.json` holds what src/game.js builds for the yard and the gate, step by step, and the play
// data that goes with it (where the player starts, where machines spawn, cover, zones, the opening's camera path).
// `runLayout` replays one section through the level kit game.js makes (`lk` there), so a new area is a list of steps,
// not new code in the bundle.
//
// Order matters, twice. Container stacks draw jitter, seed and wear from the level's seeded random numbers, so the
// same steps in the same order build the same yard, byte for byte (scripts/level-fingerprint.mjs checks it). And the
// merged mesh and the collision list are built in step order.
//
// A step that is malformed or unknown stops the build with its section and index: a level that silently drops a
// wall is worse than one that doesn't load.
import level from "./yard.json";

export type Vec2 = [number, number];
export type Vec3 = [number, number, number];
type Opts = Record<string, unknown>;

/** One container in a stack: size 20, 40 or "hc" (40 ft high cube), a paint, and optional door, flip, reefer, offsets. */
export type StackBox = [20 | 40 | "hc", string] | [20 | 40 | "hc", string, Opts];

export type Step =
  /** A prop from the catalogue (game.js `Gi`) at x, z; y lifts it (onto a container: 2.59). flags.noCol: no collision. */
  | { op: "place"; kind: string; x: number; z: number; yaw?: number; y?: number; opts?: Opts; flags?: Opts }
  /** Containers stacked bottom first. jitter scales the random lean (default 1; 0 = none). */
  | { op: "stack"; x: number; z: number; yaw?: number; jitter?: number; boxes: StackBox[] }
  | { op: "stairs"; x: number; z: number; yaw?: number; y?: number; opts?: Opts }
  | { op: "catwalk"; x: number; z: number; yaw?: number; y?: number; opts?: Opts; rails?: [boolean, boolean] }
  /** An invisible collision box. opts: playerOnly, bulletOnly, noNav. */
  | { op: "col"; min: Vec3; max: Vec3; surface?: string; opts?: Opts }
  | { op: "box"; mat: string; size: Vec3; at: Vec3; opts?: Opts }
  | { op: "slab"; mat: string; min: Vec3; max: Vec3; opts?: Opts }
  | { op: "cyl"; mat: string; r: number; h: number; at: Vec3; opts?: Opts }
  | { op: "rod"; mat: string; from: Vec3; to: Vec3; r?: number; opts?: Opts }
  | { op: "tube"; mat: string; points: Vec3[]; r?: number; opts?: Opts }
  | { op: "decal"; name: string; size: number; at: Vec3; face?: string; rot?: number }
  | { op: "label"; text: string; size: number; at: Vec3; face?: string; opts?: Opts }
  /** A steel cage of bars with chain-link sides, 2.2 × 1.2 m. */
  | { op: "stillage"; x: number; z: number; yaw?: number; paint?: string; variant?: number }
  /** A small steel bin of scrap, 1.1 × 0.8 m. */
  | { op: "scrap_bin"; x: number; z: number; yaw?: number; paint?: string }
  /** A bundle of rebar on two timber bearers, 3.4 m long. */
  | { op: "rebar"; x: number; z: number; yaw?: number; count?: number }
  | { op: "chock"; x: number; z: number; yaw?: number }
  /** A post with a yellow lane board; face is the side the text faces ("x-", "x+", "z-", "z+"). */
  | { op: "lane_sign"; x: number; z: number; text: string; face?: string; height?: number }
  /** A cable lying on the ground through x, z points (a third value lifts that point). */
  | { op: "floor_cable"; points: number[][]; r?: number; mat?: string; y?: number }
  | { op: "junction_box"; x: number; z: number; yaw?: number }
  /** A cable hung between two points, sagging by `sag` metres in the middle. */
  | { op: "sag_cable"; from: Vec3; to: Vec3; sag: number; r?: number }
  /** A perimeter fence from one x, z to another: panels every ~3.35 m, a wall to bullets and a taller one to players. */
  | { op: "fence_run"; from: Vec2; to: Vec2; seed: number };

/** What a placed prop gives back: enough to stretch a fence panel. */
interface Placed {
  scale: { x: number };
}

/** The level kit: the builders game.js already has (`ob`), and the composite props it defines. */
export interface LevelKit {
  place(kind: string, x: number, z: number, yaw?: number, opts?: Opts, y?: number, flags?: Opts): Placed;
  stack(x: number, z: number, boxes: StackBox[], yaw?: number, jitter?: number): unknown;
  stairs(x: number, z: number, yaw?: number, y?: number, opts?: Opts): unknown;
  catwalk(x: number, z: number, yaw?: number, y?: number, opts?: Opts, rails?: [boolean, boolean]): unknown;
  col(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, surface?: string, opts?: Opts): unknown;
  box(mat: string, w: number, h: number, d: number, x: number, y: number, z: number, opts?: Opts): unknown;
  slab(mat: string, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, opts?: Opts): unknown;
  cyl(mat: string, r: number, h: number, x: number, y: number, z: number, opts?: Opts): unknown;
  rod(mat: string, from: Vec3, to: Vec3, r?: number, opts?: Opts): unknown;
  tube(mat: string, points: Vec3[], r?: number, opts?: Opts): unknown;
  decal(name: string, size: number, x: number, y: number, z: number, face?: string, rot?: number): unknown;
  label(text: string, size: number, x: number, y: number, z: number, face?: string, opts?: Opts): unknown;
  stillage(x: number, z: number, yaw?: number, paint?: string, variant?: number): unknown;
  scrapBin(x: number, z: number, yaw?: number, paint?: string): unknown;
  rebar(x: number, z: number, yaw?: number, count?: number): unknown;
  chock(x: number, z: number, yaw?: number): unknown;
  laneSign(x: number, z: number, text: string, face?: string, height?: number): unknown;
  floorCable(points: number[][], r?: number, mat?: string, y?: number): unknown;
  junctionBox(x: number, z: number, yaw?: number): unknown;
}

export interface Spawn {
  type: "ground" | "air";
  zone: string;
  pos: Vec3;
}

export interface PlayData {
  playerStart: { pos: Vec3; yaw: number };
  spawns: Spawn[];
  zones: { name: string; min: Vec2; max: Vec2 }[];
  cinematicPath: { pos: Vec3; look: Vec3 }[];
  coverPoints: Vec3[];
  vantage: { stairsFoot: Vec3; roof: Vec3 };
}

export interface LevelData {
  about: string;
  sections: Record<string, Step[]>;
  play: PlayData;
}

export const LEVEL = level as unknown as LevelData;

/** A fresh copy, so a builder that changes what it's given never changes the data. */
const copy = <T>(v: T): T => (v === undefined || v === null || typeof v !== "object" ? v : structuredClone(v));

const fail = (where: string, why: string): never => {
  throw new Error(`level ${where}: ${why}`);
};

function num(where: string, s: Record<string, unknown>, key: string, optional = false): number {
  const v = s[key];
  if (v === undefined && optional) return undefined as unknown as number;
  if (typeof v !== "number" || !Number.isFinite(v)) fail(where, `${key} must be a finite number`);
  return v as number;
}

function vec(where: string, s: Record<string, unknown>, key: string, n: 2 | 3): number[] {
  const v = s[key];
  if (!Array.isArray(v) || v.length !== n || !v.every((x) => typeof x === "number" && Number.isFinite(x)))
    fail(where, `${key} must be ${n} finite numbers`);
  return copy(v as number[]);
}

function str(where: string, s: Record<string, unknown>, key: string, optional = false): string {
  const v = s[key];
  if (v === undefined && optional) return undefined as unknown as string;
  if (typeof v !== "string" || !v) fail(where, `${key} must be a non-empty string`);
  return v as string;
}

/** fR's fence: panels stretched to fit the run, a wall bullets hit and a taller one players can't climb. */
function fenceRun(kit: LevelKit, [c, u]: number[], [h, f]: number[], seed: number): void {
  const d = Math.hypot(h - c, f - u);
  const v = Math.max(1, Math.round(d / 3.35));
  const g = d / (v * 3);
  const alongX = Math.abs(h - c) > Math.abs(f - u);
  for (let y = 0; y < v; y++) {
    const b = (y + 0.5) / v;
    const panel = kit.place(
      "fence_panel",
      c + (h - c) * b,
      u + (f - u) * b,
      alongX ? 0 : Math.PI / 2,
      { seed: seed + y, posts: y === v - 1 ? "both" : "left" },
      0,
      { noCol: true },
    );
    panel.scale.x = g;
  }
  kit.col(Math.min(c, h) - 0.05, 0, Math.min(u, f) - 0.05, Math.max(c, h) + 0.05, 2.4, Math.max(u, f) + 0.05, "metal");
  kit.col(Math.min(c, h) - 0.3, 0, Math.min(u, f) - 0.3, Math.max(c, h) + 0.3, 7, Math.max(u, f) + 0.3, "metal", {
    playerOnly: true,
  });
}

/** hR's hung cable: nine points on a parabola from one end to the other. */
function sagCable(kit: LevelKit, s: number[], o: number[], r: number, a = 0.018): void {
  const l: Vec3[] = [];
  for (let c = 0; c <= 8; c++) {
    const u = c / 8;
    l.push([s[0] + (o[0] - s[0]) * u, s[1] + (o[1] - s[1]) * u - r * 4 * u * (1 - u), s[2] + (o[2] - s[2]) * u]);
  }
  kit.tube("rubber", l, a, { radial: 5, tension: 0.5 });
}

/** Build one section, in order. Returns the number of steps run; throws on the first bad one. */
export function runLayout(steps: readonly Step[], kit: LevelKit, section = "layout"): number {
  if (!Array.isArray(steps)) fail(section, "is not a list of steps");
  steps.forEach((step, i) => {
    const where = `${section}[${i}]`;
    if (!step || typeof step !== "object") fail(where, "is not an object");
    const s = step as unknown as Record<string, unknown>;
    const o = copy(s.opts) as Opts | undefined;
    switch (step.op) {
      case "place":
        kit.place(str(where, s, "kind"), num(where, s, "x"), num(where, s, "z"), num(where, s, "yaw", true), o, num(where, s, "y", true), copy(step.flags));
        break;
      case "stack":
        if (!Array.isArray(step.boxes) || !step.boxes.length) fail(where, "boxes must be a non-empty list");
        kit.stack(num(where, s, "x"), num(where, s, "z"), copy(step.boxes), num(where, s, "yaw", true), num(where, s, "jitter", true));
        break;
      case "stairs":
        kit.stairs(num(where, s, "x"), num(where, s, "z"), num(where, s, "yaw", true), num(where, s, "y", true), o);
        break;
      case "catwalk":
        kit.catwalk(num(where, s, "x"), num(where, s, "z"), num(where, s, "yaw", true), num(where, s, "y", true), o, copy(step.rails));
        break;
      case "col": {
        const [x0, y0, z0] = vec(where, s, "min", 3);
        const [x1, y1, z1] = vec(where, s, "max", 3);
        kit.col(x0, y0, z0, x1, y1, z1, str(where, s, "surface", true), o);
        break;
      }
      case "box": {
        const [w, h, d] = vec(where, s, "size", 3);
        const [x, y, z] = vec(where, s, "at", 3);
        kit.box(str(where, s, "mat"), w, h, d, x, y, z, o);
        break;
      }
      case "slab": {
        const [x0, y0, z0] = vec(where, s, "min", 3);
        const [x1, y1, z1] = vec(where, s, "max", 3);
        kit.slab(str(where, s, "mat"), x0, y0, z0, x1, y1, z1, o);
        break;
      }
      case "cyl": {
        const [x, y, z] = vec(where, s, "at", 3);
        kit.cyl(str(where, s, "mat"), num(where, s, "r"), num(where, s, "h"), x, y, z, o);
        break;
      }
      case "rod":
        kit.rod(str(where, s, "mat"), vec(where, s, "from", 3) as Vec3, vec(where, s, "to", 3) as Vec3, num(where, s, "r", true), o);
        break;
      case "tube":
        if (!Array.isArray(step.points) || step.points.length < 2) fail(where, "points must list at least two points");
        kit.tube(str(where, s, "mat"), copy(step.points), num(where, s, "r", true), o);
        break;
      case "decal": {
        const [x, y, z] = vec(where, s, "at", 3);
        kit.decal(str(where, s, "name"), num(where, s, "size"), x, y, z, str(where, s, "face", true), num(where, s, "rot", true));
        break;
      }
      case "label": {
        const [x, y, z] = vec(where, s, "at", 3);
        kit.label(str(where, s, "text"), num(where, s, "size"), x, y, z, str(where, s, "face", true), o);
        break;
      }
      case "stillage":
        kit.stillage(num(where, s, "x"), num(where, s, "z"), num(where, s, "yaw", true), str(where, s, "paint", true), num(where, s, "variant", true));
        break;
      case "scrap_bin":
        kit.scrapBin(num(where, s, "x"), num(where, s, "z"), num(where, s, "yaw", true), str(where, s, "paint", true));
        break;
      case "rebar":
        kit.rebar(num(where, s, "x"), num(where, s, "z"), num(where, s, "yaw", true), num(where, s, "count", true));
        break;
      case "chock":
        kit.chock(num(where, s, "x"), num(where, s, "z"), num(where, s, "yaw", true));
        break;
      case "lane_sign":
        kit.laneSign(num(where, s, "x"), num(where, s, "z"), str(where, s, "text"), str(where, s, "face", true), num(where, s, "height", true));
        break;
      case "floor_cable":
        if (!Array.isArray(step.points) || step.points.length < 2) fail(where, "points must list at least two points");
        kit.floorCable(copy(step.points), num(where, s, "r", true), str(where, s, "mat", true), num(where, s, "y", true));
        break;
      case "junction_box":
        kit.junctionBox(num(where, s, "x"), num(where, s, "z"), num(where, s, "yaw", true));
        break;
      case "sag_cable":
        sagCable(kit, vec(where, s, "from", 3), vec(where, s, "to", 3), num(where, s, "sag"), num(where, s, "r", true));
        break;
      case "fence_run":
        fenceRun(kit, vec(where, s, "from", 2), vec(where, s, "to", 2), num(where, s, "seed"));
        break;
      default:
        fail(where, `unknown op ${JSON.stringify((step as { op?: unknown }).op)}`);
    }
  });
  return steps.length;
}
