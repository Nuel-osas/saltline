// The seams between the Assessor's parts: the fight (fight.ts, the rules in time), its body (model.ts, three.js), its
// bolts (bolts.ts) and its HUD bar (bar.ts). The fight only talks to the others through these, so the tests can drive
// it with plain stand-ins.

export interface V3 {
  x: number;
  y: number;
  z: number;
}

export type Phase = "arriving" | "fighting" | "dying" | "dead";
export type CoreState = "live" | "hit" | "dark";

/** What the fight asks of the body each frame. */
export interface Drive {
  phase: Phase;
  /** Where the body should stand (centre of its feet, on the ground plane). */
  at: { x: number; z: number };
  /** Which way the upper works face (rad; 0 faces +z). */
  yaw: number;
  /** The inspection lamp: 0–1 brightness, world direction, length to what it hits, assessment heat 0–1, locked. */
  beam: { on: number; dir: V3; length: number; heat: number; lock: boolean };
  /** A foot lifted for a stamp (0–1), or null. */
  stamp: { foot: number; lift: number } | null;
  /** The slump, 0 standing to 1 down. */
  slump: number;
}

export interface BodyHit {
  dist: number;
  point: V3;
  normal: V3;
  /** The core hit, or -1 for the body. */
  core: number;
  /** Which body part (an index into the body's hit volumes), for debugging. */
  part?: number;
}

export interface Body {
  /** Where the body stands now (feet centre, ground level). */
  readonly pos: V3;
  lamp(out: V3): V3;
  muzzle(i: number, out: V3): V3;
  core(i: number, out: V3): V3;
  foot(i: number, out: V3): V3;
  readonly feet: number;
  /** The nearest part along a ray, within `max`. */
  raycast(origin: V3, dir: V3, max: number): BodyHit | null;
  setCore(i: number, state: CoreState): void;
  /** A stamp's shockwave starts at (x, z); the body draws its ring. */
  shockwave(x: number, z: number): void;
  update(dt: number, drive: Drive): void;
  dispose(): void;
}

export interface Bolts {
  fire(from: V3, dir: V3): void;
  update(dt: number): void;
  clear(): void;
  dispose(): void;
}

export interface Bar {
  show(cores: number): void;
  set(s: { health: number; live: boolean[]; assess: number; lock: boolean }): void;
  hide(): void;
  dispose(): void;
}
