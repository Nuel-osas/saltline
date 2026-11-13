// What one Bailiff's behaviour (unit.ts) needs from its body (model.ts) and from the game (index.ts), so the tests
// can drive it with stand-ins and no three.js.
import type { BailiffState, V2, V3 } from "../campaign/types";
import type { LineId } from "./copy";
import type { Uplink } from "./rules";

export type { V2, V3 };

export type Lens = "amber" | "red" | "dark";

/** What the behaviour tells the body each frame. */
export interface Pose {
  x: number;
  y: number;
  z: number;
  yaw: number;
  state: BailiffState;
  /** Metres a second over the ground. */
  speed: number;
  /** 0 folded in its crouch (before it is released), 1 upright. */
  up: number;
  /** 0 standing, 1 down on a knee. */
  kneel: number;
  /** The clamp arm: 0 hanging, 1 raised to strike. */
  raise: number;
  /** 1 as the clamp comes down, easing back to 0. */
  strike: number;
  lens: Lens;
  /** 0–1: the lens flares through the wind-up. */
  flare: number;
  /** What the head turns to, or null for the way it is walking. */
  look: V3 | null;
}

export interface BodyHit {
  dist: number;
  point: V3;
  normal: V3;
  /** The shot found the lens. */
  lens: boolean;
}

export interface Body {
  update(dt: number, pose: Pose): void;
  raycast(origin: V3, dir: V3, max: number): BodyHit | null;
  /** The lens's world position. */
  lens(out: V3): V3;
  dispose(): void;
}

export interface PlayerLike {
  pos: V3;
  eye?: V3;
  alive?: boolean;
}

/** The game, as one Bailiff sees it. */
export interface World {
  player(): PlayerLike | null;
  /** A clear line between two points. */
  los(a: V3, b: V3): boolean;
  walkable(x: number, z: number): boolean;
  /** Waypoints over the nav grid, or null where there is no way. */
  path(from: V2, to: V2): V2[] | null;
  /** The ground under (x, z), no higher than `maxY`. */
  ground(x: number, z: number, maxY: number): number;
  uplinks(): Uplink[];
  boat(): V2 | null;
  /** Damages the player. */
  hurt(amount: number, from: V3): void;
  /** Throws the player `metres` along (dx, dz) over `seconds`, stopping at walls. */
  shove(dx: number, dz: number, metres: number, seconds: number): void;
  sfx(name: string, opts?: Record<string, unknown>): void;
  emit(name: string, payload: unknown): void;
  say(id: LineId): void;
  /** Sparks where a shot lands. */
  spark(point: V3, normal: V3, lens: boolean): void;
  /** A point in the shape the game's combat expects (a THREE.Vector3 in the game). */
  vec(p: V3): V3;
}
