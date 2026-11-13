// The Bailiff's rules (docs/CAMPAIGN.md → The Bailiff), pure so they can be tested: its numbers, how the stagger
// meter grows, and where it walks when it has lost the player. unit.ts runs one Bailiff on these.
import type { V2 } from "../campaign/types";

export const TUNE = {
  /** It walks at this pace, always (m/s). The player walks at 3.8, sprints at 6.4, and walks a full load at 2.4. */
  speed: 2.6,
  /** It pivots on the spot when its path turns more than `pivot` rad away, at `turn` rad/s. */
  turn: 2.4,
  pivot: 0.7,
  accel: 7,
  /** Seconds between plans on the nav grid: twice a second. */
  replan: 0.5,
  /** Rising from its crouch when it is released, and standing again after a stagger. */
  rise: 2.0,
  stand: 1.0,
  stagger: {
    /** The first stagger takes this much; each one after takes `step` more, up to `cap`. */
    first: 450,
    step: 200,
    cap: 1050,
    /** The first lasts this long (s); each one after `less` shorter, down to `floor`. */
    seconds: 9,
    less: 1,
    floor: 5,
    /** A lens hit counts this many times over. */
    lens: 2,
  },
  grab: {
    range: 2.2,
    /** It reaches a player standing this far above its feet (the top of one container), no higher. */
    reachUp: 3.0,
    windup: 0.6,
    /** The clamp closes on a player still within this of it when the wind-up ends: the range and a lunge. */
    connect: 2.9,
    damage: 55,
    /** Metres the player is thrown, over `shoveSeconds`. */
    shove: 4,
    shoveSeconds: 0.28,
    /** Seconds after a grab before it can grab again; it stands over the swing for the first `hold` of them. */
    recovery: 2.5,
    hold: 0.8,
  },
  /** Seconds without sight of the player before it stops following them and works through the lost-sight routine. */
  lostAfter: 6,
  /** It has arrived at a lost-sight target inside this (m). */
  arrive: 1.6,
  /** Sight: the lens sees this far (m). */
  sight: 60,
  /** `bailiff:near` and the HUD chip inside `chip` m, every `every` s; its first-contact line inside `line` m. */
  near: { chip: 30, every: 0.5, line: 12 },
  /** Footfalls shake the camera inside this (m). */
  shake: 10,
  /** The game multiplies a "weak" hit by this before the target sees it (src/game.js, combat.playerShot). */
  weakMult: 2.2,
} as const;

/**
 * Where the debug switch and the missions stand one up. Each is on the level's nav grid with at least a metre clear
 * all round, outside every solid box (scripts/smoke-bailiff.mjs asserts it against the running game): `shed` is the
 * open floor west of Relay B; `yard` is the lane between the container stacks at the yard's south end, out of sight
 * of the yard's middle. `shedAlt` are tried, in order, when the player can see `shed` at the moment it is released
 * (the east floor, then the floor inside the yard door), so it doesn't appear in view. The run's salvage is placed
 * at other spots (salvage/spots.ts); should anything ever stand on one of these, spawn() takes the nearest clear cell.
 */
export const SPAWN = {
  shed: { x: -12, z: -21 },
  yard: { x: -8, z: 22 },
  shedAlt: [
    { x: 14, z: -19 },
    { x: -2, z: -15 },
  ],
} as const;

/** The damage the stagger meter takes before stagger number `n` (0 for the first). */
export function staggerThreshold(n: number): number {
  const S = TUNE.stagger;
  return Math.min(S.cap, S.first + S.step * Math.max(0, Math.floor(n)));
}

/** How long stagger number `n` (0 for the first) lasts, in seconds. */
export function staggerSeconds(n: number): number {
  const S = TUNE.stagger;
  return Math.max(S.floor, S.seconds - S.less * Math.max(0, Math.floor(n)));
}

/**
 * What a hit adds to the meter. `amount` is what the target was handed; a lens hit the game already scaled as a weak
 * point (`scaled`) is unscaled first, so a lens hit counts exactly double whoever delivers it.
 */
export function meterGain(amount: number, lens: boolean, scaled = false): number {
  if (!(amount > 0) || !Number.isFinite(amount)) return 0;
  if (!lens) return amount;
  return (scaled ? amount / TUNE.weakMult : amount) * TUNE.stagger.lens;
}

export interface Uplink extends V2 {
  id: string;
  live: boolean;
}
export type LostKind = "lastSeen" | "uplink" | "boat" | "hold";
export interface LostTarget extends V2 {
  kind: LostKind;
  /** The uplink's id, for `uplink`. */
  id?: string;
}

/**
 * The lost-sight routine: with no sight of the player for `TUNE.lostAfter` seconds it goes to where it last saw
 * them, then to the nearest uplink still live that it hasn't already checked, then to the boat, where it waits.
 * `checkedLastSeen` and `checked` are what it has reached since it lost them.
 */
export function lostTarget(input: {
  from: V2;
  lastSeen: V2 | null;
  checkedLastSeen: boolean;
  uplinks: readonly Uplink[];
  checked: ReadonlySet<string>;
  boat: V2 | null;
}): LostTarget {
  const { from, lastSeen, checkedLastSeen, uplinks, checked, boat } = input;
  if (lastSeen && !checkedLastSeen) return { kind: "lastSeen", x: lastSeen.x, z: lastSeen.z };
  let best: Uplink | null = null;
  let bd = Infinity;
  for (const u of uplinks) {
    if (!u.live || checked.has(u.id)) continue;
    const d = Math.hypot(u.x - from.x, u.z - from.z);
    if (d < bd) ((bd = d), (best = u));
  }
  if (best) return { kind: "uplink", id: best.id, x: best.x, z: best.z };
  if (boat) return { kind: "boat", x: boat.x, z: boat.z };
  return { kind: "hold", x: from.x, z: from.z };
}

/** True when a blast at `pos` with `radius` reaches a Bailiff standing at `at` (measured along the ground). */
export function inBlast(at: V2, pos: V2, radius: number): boolean {
  return Number.isFinite(radius) && radius > 0 && Math.hypot(at.x - pos.x, at.z - pos.z) <= radius;
}
