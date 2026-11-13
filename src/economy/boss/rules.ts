// The Assessor's rules (docs/STORY.md → The boss), pure so they can be tested: who gets a boss, how many cores, how
// damage lands, when it calls for help. The fight (fight.ts) runs on these numbers.
import type { TownRead } from "../story/town";

/** Fewest and most relay cores the Assessor carries. */
export const MIN_CORES = 3;
export const MAX_CORES = 8;

/** `3 + floor(strength / 20)`: every core the town sold it is one more weak point. A bad strength reads as 0. */
export function coreCount(strength: unknown): number {
  const s = typeof strength === "number" && Number.isFinite(strength) ? Math.max(0, Math.min(100, Math.floor(strength))) : 0;
  return Math.max(MIN_CORES, Math.min(MAX_CORES, MIN_CORES + Math.floor(s / 20)));
}

/**
 * The boss this run's town read calls for, or null. Only a good read in Chapter 3 builds one: a chain without town(),
 * a failed or late read, or Chapters 1–2 play the run as before.
 */
export function assessorFor(read: TownRead | null | undefined): { cores: number; strength: number } | null {
  if (!read || read.status !== "ok" || read.view.act !== 3) return null;
  const strength = read.view.harbormaster.strength;
  return { cores: coreCount(strength), strength };
}

/**
 * The tuning. A solo player at full strength (8 cores) should take about 60–120 s: each core is a short burst of
 * aimed fire, and the time goes on breaking the lamp's line of sight, jumping the stamps and the two calls.
 * Player references (src/game.js): rifle 26 a round at 720 rpm, weak points take 2.2×, health 100 regenerating 25/s
 * after 4 s, jump apex 1 m.
 */
export const TUNE = {
  /** One core: seven weak-point hits (7 × 26 × 2.2 = 400; six make 343). */
  coreHp: 390,
  /** The share of a body hit that reaches the nearest live core: 26 → 1.6, about 250 body hits a core. */
  bodyShare: 0.06,
  /** Seconds a core flashes when hit. */
  hitFlash: 0.07,
  /**
   * The player's reserve is topped up to this when it arrives. The game has no ammunition pickups and the run's drones
   * have had most of the 180 rounds; a player landing 3 rounds in 10 needs about 200 for 8 cores, plus the calls.
   */
  reserve: 240,
  arrive: {
    /** Where it comes from (behind the north containers, outside the fence) and where it plants itself. */
    from: { x: 22, z: -38 },
    post: { x: 23.5, z: 14.5 },
    /** Rumble before it shows, then walking pace (m/s). */
    rumble: 1.4,
    speed: 4.6,
    /** Seconds to settle at the post before it fights. */
    settle: 1.2,
  },
  /** The upper works slew to face the player (rad/s). */
  turnRate: 0.75,
  lamp: {
    range: 46,
    /** Half-angle of the beam that assesses (rad). */
    halfAngle: 0.15,
    /** The beam follows the player with a slow searching sway, this far either side (m) over this period (s), and
     *  moves this fast (m/s): a walking player stays lit, a sprinting one can outrun it for a while. */
    sweep: 3,
    period: 5.6,
    aimSpeed: 5.5,
    /** Full assessment after this many seconds in the beam. Out of the beam it drains slowly; out of its sight
     *  (behind steel) it drains fast. */
    fillSeconds: 2.2,
    decay: 0.15,
    decayHidden: 0.6,
    /** The lock (beam red, tracking tight) before the volley, and the rest after it. */
    lock: 1.05,
    cooldown: 3.4,
  },
  volley: { bolts: 10, gap: 0.11, speed: 54, damage: 6, spread: 0.035 },
  stamp: {
    /** It stamps when the player is this close to its centre, or this close to a foot (m, on the ground plane). */
    near: 7.5,
    nearFoot: 3.2,
    telegraph: 0.85,
    radius: 11,
    speed: 13,
    /** The wave's front is this thick (m); the player is caught if on the apron (below `apron` m) as it passes. */
    band: 1.1,
    apron: 0.6,
    damage: 24,
    knock: 8,
    cooldown: 3.6,
  },
  /** Health fractions at which it calls a pair of Inspection Units (each once). */
  calls: [2 / 3, 1 / 3],
  /** The slump, then the boat coming back in; the boat is blocked until it's in. */
  slump: 2.6,
  boatIn: 4.5,
} as const;

/** How a hit lands: a core takes it whole, the body passes a small share to the nearest live core. */
export function damageFor(part: "core" | "body", amount: number): number {
  if (!(amount > 0) || !Number.isFinite(amount)) return 0;
  return part === "core" ? amount : amount * TUNE.bodyShare;
}
