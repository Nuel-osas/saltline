// The kit's rules (docs/CAMPAIGN.md → The kit), as plain functions over plain numbers: the breaker charge's throw and
// burst, the rifle butt's cone, what a pickup gives and when it's refused, what a dead machine leaves, and which
// lockers a seed picks. Nothing here touches three.js or the game, so the tests read these directly.
import type { PickupKind, V2, V3 } from "../campaign/types";
import { LOCKER_SPOTS, type LockerSpot } from "./spots";

export const TUNE = {
  charge: {
    /** Charges carried at most. */
    cap: 3,
    /** Seconds from the throw to the burst if nothing is hit first. */
    fuse: 1.2,
    /** Metres a level throw travels before it lands. */
    range: 14,
    /** Seconds a level throw is in the air (just inside the fuse, so it bursts on the ground). */
    flight: 1.1,
    /** Height above the feet it leaves the hand, metres. */
    hand: 1.45,
    gravity: 9.81,
    /** The burst is 7 m across. */
    radius: 3.5,
    houndDamage: 80,
    /** Seconds a hound is held. */
    houndStun: 3,
    /** Seconds between throws. */
    cooldown: 0.8,
  },
  butt: {
    reach: 2.3,
    /** The whole cone, degrees. */
    cone: 60,
    damage: 70,
    /** Seconds between swings. */
    cooldown: 0.45,
    /** Metres a hound slides back (its push decays at 5/s, so the impulse is five times this). */
    knockback: 1.3,
    /** A target this far above or below the eye is out of the swing. */
    tall: 1.9,
  },
  pickup: {
    /** Rounds in a dropped magazine or a locker's. Raised from 30: the yard is meant to keep a breacher shooting. */
    ammo: 45,
    med: 35,
    charge: 1,
    /** Walking this close takes it, metres. */
    take: 1.2,
    /** The reserve is full here: the Assessor's top-up (boss/rules.ts TUNE.reserve) is the same ceiling. */
    reserveCap: 240,
  },
  drop: {
    /** The odds a dead machine leaves something. Raised (hound 0.35 ammo, gull 0.12 ammo and 0.08 med before). */
    hound: { ammo: 0.55, med: 0.1 },
    gull: { ammo: 0.22, med: 0.14 },
  },
  /** Until the campaign runner sets a mission up: charges and lockers for a run. */
  defaults: { charges: 2, lockers: 6 },
} as const;

export const clampCharges = (n: number) => Math.max(0, Math.min(TUNE.charge.cap, Math.floor(Number.isFinite(n) ? n : 0)));

// ---------------------------------------------------------------------------------------------------------------
// The throw

/**
 * The charge's velocity for a look direction. A level throw from hand height lands `range` metres out after `flight`
 * seconds: forward speed range / flight, plus the lift that keeps it up that long.
 */
export function throwVelocity(forward: V3): V3 {
  const C = TUNE.charge;
  const speed = C.range / C.flight;
  const lift = (0.5 * C.gravity * C.flight * C.flight - C.hand) / C.flight;
  const len = Math.hypot(forward.x, forward.y, forward.z) || 1;
  return { x: (forward.x / len) * speed, y: (forward.y / len) * speed + lift, z: (forward.z / len) * speed };
}

/** One step of the charge's flight (semi-implicit Euler: the same in the game and the tests). */
export function stepCharge(pos: V3, vel: V3, dt: number): void {
  vel.y -= TUNE.charge.gravity * dt;
  pos.x += vel.x * dt;
  pos.y += vel.y * dt;
  pos.z += vel.z * dt;
}

// ---------------------------------------------------------------------------------------------------------------
// The burst

export type MachineType = "gull" | "hound";
export type BurstEffect = { kind: "none" } | { kind: "destroy" } | { kind: "stun"; damage: number; seconds: number };

/** What a burst does to a machine `dist` metres from its centre. */
export function burstEffect(type: string, dist: number): BurstEffect {
  if (!(dist <= TUNE.charge.radius)) return { kind: "none" };
  if (type === "gull") return { kind: "destroy" };
  if (type === "hound") return { kind: "stun", damage: TUNE.charge.houndDamage, seconds: TUNE.charge.houndStun };
  return { kind: "none" };
}

/** A machine's middle: a hound's body rides 0.6 m above its feet, a gull's position is its hull. */
export function centreOf(type: string, pos: V3): V3 {
  return { x: pos.x, y: pos.y + (type === "hound" ? 0.6 : 0), z: pos.z };
}

export const dist3 = (a: V3, b: V3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

// ---------------------------------------------------------------------------------------------------------------
// The rifle butt

/**
 * True if `target` is inside the swing from `eye` facing `yaw` (the game's forward is (-sin yaw, 0, -cos yaw)).
 * Reach and cone are measured on the ground plane, so looking up or down doesn't change what the stock reaches; a
 * target more than `tall` above or below the eye is out. Something right on top of the player is always in.
 */
export function inSwing(eye: V3, yaw: number, target: V3): boolean {
  const B = TUNE.butt;
  const dx = target.x - eye.x,
    dz = target.z - eye.z;
  const d = Math.hypot(dx, dz);
  if (d > B.reach || Math.abs(target.y - eye.y) > B.tall) return false;
  if (d < 0.5) return true;
  const fx = -Math.sin(yaw),
    fz = -Math.cos(yaw);
  const cos = (dx * fx + dz * fz) / d;
  return cos >= Math.cos(((B.cone / 2) * Math.PI) / 180) - 1e-9;
}

/** A cooldown clock for the swing and the throw: `ready()`, then `fire()` starts the wait. */
export function cooldown(seconds: number) {
  let left = 0;
  return {
    ready: () => left <= 0,
    fire: () => void (left = seconds),
    tick: (dt: number) => void (left = Math.max(0, left - dt)),
    reset: () => void (left = 0),
    get left() {
      return left;
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Pickups

export interface Carrying {
  health: number;
  maxHealth: number;
  /** Rounds in reserve (not the magazine). */
  reserve: number;
  charges: number;
}

/**
 * What taking a pickup gives: the amount actually added (rounds, health or charges), or 0 when it's refused: an
 * injector at full health, a tin at a full reserve, a charge with three on the belt. A refused pickup stays put.
 */
export function pickupAmount(kind: PickupKind, c: Carrying): number {
  const P = TUNE.pickup;
  if (kind === "ammo") return Math.max(0, Math.min(P.ammo, P.reserveCap - Math.floor(c.reserve)));
  if (kind === "med") return c.health >= c.maxHealth - 0.5 ? 0 : Math.max(0, Math.min(P.med, Math.ceil(c.maxHealth - c.health)));
  if (kind === "charge") return Math.max(0, Math.min(P.charge, TUNE.charge.cap - c.charges));
  return 0;
}

export const FEED: Record<PickupKind, (n: number) => string> = {
  ammo: (n) => `+${n} ROUNDS`,
  med: (n) => `+${n} HEALTH`,
  charge: (n) => `+${n} BREAKER CHARGE`,
};

/** What a destroyed machine leaves, for one roll in [0, 1). The med band sits after the ammo band. */
export function dropFor(type: string, roll: number): PickupKind | null {
  const odds = type === "hound" ? TUNE.drop.hound : type === "gull" ? TUNE.drop.gull : null;
  if (!odds) return null;
  if (roll < odds.ammo) return "ammo";
  if (roll < odds.ammo + odds.med) return "med";
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// Lockers

/** A small seeded generator (mulberry32): the same seed always places the same lockers. */
export function seeded(seed: number): () => number {
  let a = (Math.floor(seed) ^ 0x9e3779b9) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface LockerPlan {
  spot: LockerSpot;
  kind: PickupKind;
}

/** What six lockers hold, cycled for other counts: mostly rounds, one charge in every six. */
const LOADOUT: readonly PickupKind[] = ["ammo", "med", "ammo", "charge", "ammo", "med"];

/**
 * `count` lockers for a seed: distinct spots from the checked table, dealt zone by zone (yard, shed, quay, …) so a
 * mission's lockers are spread over the terminal, each with its pickup.
 */
export function planLockers(seed: number, count: number, table: readonly LockerSpot[] = LOCKER_SPOTS): LockerPlan[] {
  const rnd = seeded(seed);
  const shuffle = <T>(xs: T[]) => {
    for (let i = xs.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [xs[i], xs[j]] = [xs[j], xs[i]];
    }
    return xs;
  };
  const zones = new Map<string, LockerSpot[]>();
  for (const s of table) (zones.get(s.zone) ?? zones.set(s.zone, []).get(s.zone)!).push(s);
  const piles = shuffle([...zones.values()].map((pile) => shuffle([...pile])));
  const n = Math.max(0, Math.min(Math.floor(count) || 0, table.length));
  const spots: LockerSpot[] = [];
  for (let i = 0; spots.length < n; i++) {
    const pile = piles[i % piles.length];
    if (pile.length) spots.push(pile.pop()!);
  }
  const kinds = shuffle(Array.from({ length: n }, (_, i) => LOADOUT[i % LOADOUT.length]));
  return spots.map((spot, i) => ({ spot, kind: kinds[i] }));
}

/** Where a locker's pickup sits (on its shelf, just inside the open front) and where its front faces. */
export function lockerFront(s: LockerSpot): V2 {
  return { x: Math.sin(s.yaw), z: Math.cos(s.yaw) };
}
