// The pure half of sight/: how much of a machine's hit reaches a new player, how big a machine's signal lamp is on
// screen, which machines count as a threat, and where a threat's marker sits (on the machine, or held at the screen's
// edge pointing at it). No three.js and no DOM here, so the rules are tested on their own (test/v2-sight.test.ts).

export const SIGHT = {
  /** Seconds after the rifle is taken before a machine's hit lands. */
  graceSeconds: 3,
  /** What a machine's hit is worth on a player's first raid (no extraction yet). */
  firstRaidScale: 0.5,
  /** Metres within which an alerted machine gets a marker. */
  markerRange: 40,
  /** The lamp's glow is never smaller than this many pixels across, out to `lampFar` metres. */
  lampPx: 18,
  /** Its physical size up close (metres), and the largest it grows to. */
  lampMin: 0.24,
  lampMax: 2.6,
  /** Past `lampFar` metres the floor fades out, so a machine across the yard is a lamp again, not a beacon. */
  lampFar: 60,
  lampGone: 95,
  /** Pixels between a held marker and the screen's edge. */
  edgeInset: 44,
} as const;

/** What the damage rule needs to know about the player right now. */
export interface FairContext {
  /** G.coach.state.armed: false while the rifle is still in its crate; undefined when there is no coach. */
  armed: boolean | undefined;
  /** Seconds of play since the player was last seen without the rifle this raid (Infinity if never). */
  sinceUnarmed: number;
  /** No extraction on record yet. */
  firstRaid: boolean;
}

/**
 * What a machine's hit of `amount` does to the player: nothing before the rifle is taken and for `graceSeconds`
 * after, half on a first raid, else all of it. Anything that is not a positive number passes through untouched (the
 * game ignores it either way).
 */
export function machineDamage(amount: number, c: FairContext): number {
  if (!(amount > 0)) return amount;
  if (c.armed === false) return 0;
  if (!(c.sinceUnarmed >= SIGHT.graceSeconds)) return 0;
  return c.firstRaid ? amount * SIGHT.firstRaidScale : amount;
}

/**
 * Whether the player has extracted before, from what can be read: the profile's count when the chain answered (null
 * when it did not), and this browser's own note of an extraction. Either one is enough; neither means a first raid.
 */
export function hasExtracted(profileExtractions: number | null | undefined, localFlag: boolean): boolean {
  return localFlag || (typeof profileExtractions === "number" && profileExtractions > 0);
}

export type LampTone = "watch" | "seen";

/** Amber while it patrols or investigates a noise; red once it has seen the player (the game's own "engage"). */
export const lampTone = (mode: string | undefined): LampTone => (mode === "engage" ? "seen" : "watch");

/**
 * The lamp glow's world size (metres) at `dist` metres for a camera of vertical field of view `fovDeg` drawing
 * `viewportH` pixels: big enough to be `SIGHT.lampPx` across on screen, never smaller than the lamp itself, and
 * fading back to the lamp's own size between `lampFar` and `lampGone`.
 */
export function lampSize(dist: number, fovDeg: number, viewportH: number): number {
  const d = Math.max(0, dist);
  const perPx = (2 * d * Math.tan((fovDeg * Math.PI) / 360)) / Math.max(1, viewportH);
  const far = d <= SIGHT.lampFar ? 1 : d >= SIGHT.lampGone ? 0 : 1 - (d - SIGHT.lampFar) / (SIGHT.lampGone - SIGHT.lampFar);
  const want = SIGHT.lampPx * perPx * far;
  return Math.min(SIGHT.lampMax, Math.max(SIGHT.lampMin, want));
}

/** A machine as the marker sees it. */
export interface Watched {
  alive: boolean;
  mode?: string;
  pos: { x: number; y: number; z: number };
}

/** An alerted, living machine within `markerRange` of the player. */
export function isThreat(e: Watched, player: { x: number; y: number; z: number }): boolean {
  if (!e.alive || e.mode !== "engage") return false;
  const dx = e.pos.x - player.x,
    dy = e.pos.y - player.y,
    dz = e.pos.z - player.z;
  return dx * dx + dy * dy + dz * dz <= SIGHT.markerRange * SIGHT.markerRange;
}

export interface MarkerPlace {
  /** Screen pixels, from the top left. */
  x: number;
  y: number;
  /** On the machine (true), or held at the screen's edge (false). */
  on: boolean;
  /** Where a held marker points, in radians, screen axes (0 is right, PI/2 is down). */
  angle: number;
}

/**
 * Where a machine's marker goes, from the machine's position in camera space (x right, y up, -z ahead), the camera's
 * tan(vfov/2) and a `w`×`h` screen. In view and inside the inset frame, it sits on the machine; otherwise it is held
 * near the screen's edge in the machine's direction. Behind the camera that is the side it is on, and straight behind
 * reads as the bottom edge.
 */
export function placeMarker(vx: number, vy: number, vz: number, tanHalfFovY: number, w: number, h: number, inset: number = SIGHT.edgeInset): MarkerPlace {
  const cx = w / 2,
    cy = h / 2;
  const tanY = Math.max(1e-6, tanHalfFovY),
    tanX = tanY * (w / Math.max(1, h));
  let dx: number, dy: number;
  if (vz < -0.05) {
    const nx = vx / -vz / tanX,
      ny = vy / -vz / tanY;
    const sx = cx + nx * cx,
      sy = cy - ny * cy;
    if (sx >= inset && sx <= w - inset && sy >= inset && sy <= h - inset) return { x: sx, y: sy, on: true, angle: 0 };
    dx = sx - cx;
    dy = sy - cy;
  } else {
    // Behind: the lower half (a machine overhead behind the player must not read as one up ahead), on the side it is
    // on, so one behind and to the right is on the right edge rather than the bottom.
    dx = vx;
    dy = Math.max(0, -vy) + 0.25 * Math.abs(vx);
    if (Math.hypot(dx, dy) < 1e-3) dy = 1;
  }
  // Held on an ellipse just inside the edges rather than the frame itself, so it stays clear of the HUD's corner
  // blocks (objective, cargo, ammo, invoice) and a little further in from the bottom, where the radio line runs.
  const rx = Math.max(1, cx - inset),
    ry = Math.max(1, cy - inset * 1.6);
  const t = 1 / Math.max(1e-9, Math.hypot(dx / rx, dy / ry));
  return { x: cx + dx * t, y: cy + dy * t, on: false, angle: Math.atan2(dy, dx) };
}
