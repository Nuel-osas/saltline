// Live presence, the pure part (squad/index.ts runs it): what one player tells the others about where they are, how
// what arrives is checked before it is believed, and how a figure is moved smoothly between two updates.
//
// Every message comes from another player's browser, so nothing in it is trusted: it is rebuilt field by field, and
// anything out of range is dropped. Nothing here can touch the chain, the player's health or their haul.

/** What a player sends, ten times a second while they are in a raid. Short keys: it travels a lot. */
export interface Wire {
  /** Callsign. */
  c: string;
  x: number;
  y: number;
  z: number;
  /** Yaw, radians (the game's: 0 looks down −z). */
  w: number;
  /** Speed over the ground, m/s. */
  m: number;
  /** Crouched. */
  k: 0 | 1;
  /** The gun in hand: a frame id, or "issue". */
  f: string;
}

export const LIMITS = {
  /** Updates a second. */
  sendHz: 10,
  /** A player not heard from for this long is gone (ms). */
  staleMs: 4000,
  /** Figures drawn at most: the nearest ones. */
  peers: 12,
  /** How far behind the newest update a figure is drawn, so there is always a next point to move toward (ms). */
  delayMs: 120,
  /** The yard, generously: a position outside this isn't one. */
  reach: 400,
} as const;

const FRAMES = new Set(["issue", "longshore", "stevedore", "pilot"]);
const num = (v: unknown, lo: number, hi: number): number | null => (typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi ? v : null);

/** A callsign as the game would print it: capitals, digits and a few marks, 16 at most. Anything else is "BREACHER". */
export function cleanCallsign(v: unknown): string {
  const s = typeof v === "string" ? v.toUpperCase().replace(/[^A-Z0-9 ._-]/g, "").trim().slice(0, 16) : "";
  return s.length >= 1 ? s : "BREACHER";
}

/** A message from another browser, rebuilt from scratch, or null if any of it is out of range. */
export function sanitize(raw: unknown): Wire | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const x = num(r.x, -LIMITS.reach, LIMITS.reach);
  const y = num(r.y, -10, 60);
  const z = num(r.z, -LIMITS.reach, LIMITS.reach);
  const w = num(r.w, -1000, 1000);
  if (x === null || y === null || z === null || w === null) return null;
  const f = typeof r.f === "string" && FRAMES.has(r.f) ? r.f : "issue";
  return { c: cleanCallsign(r.c), x, y, z, w: Math.atan2(Math.sin(w), Math.cos(w)), m: num(r.m, 0, 14) ?? 0, k: r.k === 1 ? 1 : 0, f };
}

/** What this player sends: their own state, rounded, in the same shape that is checked on arrival. */
export function encode(p: { callsign: string; x: number; y: number; z: number; yaw: number; speed: number; crouched: boolean; frame: string }): Wire {
  const r2 = (n: number) => Math.round(n * 100) / 100;
  return { c: cleanCallsign(p.callsign), x: r2(p.x), y: r2(p.y), z: r2(p.z), w: r2(p.yaw), m: r2(Math.max(0, Math.min(14, p.speed))), k: p.crouched ? 1 : 0, f: FRAMES.has(p.frame) ? p.frame : "issue" };
}

export interface Placed {
  x: number;
  y: number;
  z: number;
  yaw: number;
  speed: number;
  crouched: boolean;
}

const turn = (from: number, to: number, t: number) => from + Math.atan2(Math.sin(to - from), Math.cos(to - from)) * t;

/** One other player: their last two updates, and where to draw them between the two. */
export class Track {
  private prev: { s: Wire; at: number } | null = null;
  private last: { s: Wire; at: number } | null = null;

  /** `at` is this browser's clock when the update arrived. */
  push(s: Wire, at: number): void {
    // A jump no one could have run (a respawn, a new raid) is taken at once, not glided across.
    const far = this.last && Math.hypot(s.x - this.last.s.x, s.z - this.last.s.z) > 12;
    this.prev = far ? null : this.last;
    this.last = { s, at };
  }

  get state(): Wire | null {
    return this.last?.s ?? null;
  }

  stale(now: number): boolean {
    return !this.last || now - this.last.at > LIMITS.staleMs;
  }

  /** Where the figure is at `now`: between the last two updates, a little behind the newest. */
  at(now: number): Placed | null {
    const b = this.last;
    if (!b) return null;
    const a = this.prev;
    if (!a || b.at <= a.at) return { x: b.s.x, y: b.s.y, z: b.s.z, yaw: b.s.w, speed: b.s.m, crouched: b.s.k === 1 };
    const t = Math.max(0, Math.min(1, (now - LIMITS.delayMs - a.at) / (b.at - a.at)));
    return {
      x: a.s.x + (b.s.x - a.s.x) * t,
      y: a.s.y + (b.s.y - a.s.y) * t,
      z: a.s.z + (b.s.z - a.s.z) * t,
      yaw: turn(a.s.w, b.s.w, t),
      speed: a.s.m + (b.s.m - a.s.m) * t,
      crouched: b.s.k === 1,
    };
  }
}

/** The peers to draw: the nearest `LIMITS.peers` to the player that are still being heard from. */
export function nearest<T extends { track: Track }>(peers: readonly T[], me: { x: number; z: number }, now: number): T[] {
  return peers
    .filter((p) => !p.track.stale(now) && p.track.state)
    .map((p) => ({ p, d: Math.hypot(p.track.state!.x - me.x, p.track.state!.z - me.z) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, LIMITS.peers)
    .map((e) => e.p);
}

// ---------------------------------------------------------------------------------------------------------------
// Shooting each other (Skirmish only: squad/index.ts says why).

interface P3 {
  x: number;
  y: number;
  z: number;
}

/** A figure as three spheres, feet at `at`: legs, chest and head. Sizes in metres. */
const BODY: readonly { y: number; r: number; head: boolean }[] = [
  { y: 0.45, r: 0.34, head: false },
  { y: 1.08, r: 0.42, head: false },
  { y: 1.63, r: 0.21, head: true },
];

/** Where a shot from `origin` along `dir` (a unit vector) first meets a figure standing at `at`, within `max`. */
export function rayHitsFigure(origin: P3, dir: P3, max: number, at: P3): { dist: number; head: boolean } | null {
  let best: { dist: number; head: boolean } | null = null;
  for (const s of BODY) {
    const ox = origin.x - at.x;
    const oy = origin.y - (at.y + s.y);
    const oz = origin.z - at.z;
    const b = ox * dir.x + oy * dir.y + oz * dir.z;
    const disc = b * b - (ox * ox + oy * oy + oz * oz - s.r * s.r);
    if (disc < 0) continue;
    const t = -b - Math.sqrt(disc);
    if (t < 0 || t > max || (best && t >= best.dist)) continue;
    best = { dist: t, head: s.head };
  }
  return best;
}

export const PVP = {
  /** A hit to the head does this much more. */
  headMult: 1.6,
  /** The most one hit is believed to do, whatever the message says. */
  maxDamage: 95,
  /** The most hits a second believed from one player: no gun in the game fires faster than 17 a second. */
  maxHitsPerSecond: 18,
  /** A hit claimed from further off than any gun reaches is not believed. */
  maxRange: 480,
  /** "Your hit dropped me" is believed only this soon after this player's last hit on them (ms). */
  koWithinMs: 2000,
  /** A dropped breacher isn't drawn again for this long, so their last updates in flight don't stand them back up (ms). */
  downMs: 1500,
} as const;

/**
 * Which claimed hits a player's own browser believes. The one being shot decides: a hit must come from a breacher
 * who is being heard from and is within any gun's reach, do no more than a gun can, and arrive no faster than a
 * gun fires. It is still that browser's word against another's, which is why this runs only where nothing is at
 * stake.
 */
export class HitGate {
  private recent = new Map<string, number[]>();

  /** The damage to apply, or 0 to ignore the claim. */
  accept(peerId: string, raw: unknown, now: number, distance: number | null): number {
    const d = raw && typeof raw === "object" ? (raw as { d?: unknown }).d : null;
    if (typeof d !== "number" || !Number.isFinite(d) || d < 1) return 0;
    if (distance === null || !(distance <= PVP.maxRange)) return 0;
    const times = (this.recent.get(peerId) ?? []).filter((t) => now - t < 1000);
    if (times.length >= PVP.maxHitsPerSecond) return (this.recent.set(peerId, times), 0);
    times.push(now);
    this.recent.set(peerId, times);
    return Math.min(PVP.maxDamage, Math.round(d));
  }
}
