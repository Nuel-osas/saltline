// The minimap's arithmetic, kept apart from the page so it can be tested: where a point of the yard lands on the
// disc, what is drawn of the yard, and which markers show. index.ts draws what these return.
import { isThreat, type Watched } from "../sight/rules";

export const MINI = {
  /** Metres from the player to the disc's edge. */
  range: 30,
  /** The static yard's picture: pixels a metre. */
  ppm: 8,
  /** Metres added round the yard's boxes for the picture. */
  margin: 6,
  /** Boxes that start at or above this height are overhead (the shed roof, crane beams) and are not drawn. */
  overhead: 6,
  /** Tops of the four height bands, in metres: cover, a wall or one container, two stacked, higher. */
  tiers: [1.3, 3, 6] as readonly number[],
  /** Seconds between reads of the raid's targets (seals and wrecks), which are rebuilt on every read. */
  targetsEvery: 0.25,
} as const;

/** The game's yaw: 0 looks down −z, and a positive turn is to the left (forward is (−sin yaw, −cos yaw)). */
export interface View {
  x: number;
  z: number;
  yaw: number;
  /** Disc pixels a metre. */
  k: number;
}

/**
 * Where a point of the yard lands on the disc, in pixels from its centre, with the player's forward pointing up.
 * Right of the player is right on the disc. Facing −z (yaw 0) the yard reads as on a plan, −z at the top.
 */
export function toDisc(v: View, x: number, z: number): { x: number; y: number } {
  const dx = x - v.x;
  const dz = z - v.z;
  const c = Math.cos(v.yaw);
  const s = Math.sin(v.yaw);
  return { x: (dx * c - dz * s) * v.k, y: (dx * s + dz * c) * v.k };
}

/** A point held inside a circle of radius `r`: unchanged when inside, else moved in to the edge along its bearing. */
export function clampToRing(p: { x: number; y: number }, r: number): { x: number; y: number; edge: boolean } {
  const d = Math.hypot(p.x, p.y);
  if (d <= r) return { ...p, edge: false };
  return { x: (p.x / d) * r, y: (p.y / d) * r, edge: true };
}

export interface Box {
  min: { x: number; y: number; z: number };
  max: { x: number; y: number; z: number };
  playerOnly?: boolean;
  bulletOnly?: boolean;
}

/** The height band of a box's top: 0 waist-high cover … 3 above two stacked containers. */
export const tierOf = (top: number): number => MINI.tiers.filter((t) => top > t).length;

/** The boxes drawn on the map: solid ones you could run into, from the ground up, lowest first so stacks show their top. */
export function drawnBoxes<B extends Box>(boxes: readonly B[]): B[] {
  return boxes
    .filter((b) => !b.playerOnly && !b.bulletOnly && b.max.y > 0.15 && b.min.y < MINI.overhead)
    .sort((a, b) => a.max.y - b.max.y);
}

/** The picture's extent: every drawn box and the world's play area, with a margin, in metres. */
export function extentOf(boxes: readonly Box[], also: { min: [number, number]; max: [number, number] }[] = []) {
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const b of drawnBoxes(boxes)) {
    x0 = Math.min(x0, b.min.x); z0 = Math.min(z0, b.min.z);
    x1 = Math.max(x1, b.max.x); z1 = Math.max(z1, b.max.z);
  }
  for (const a of also) {
    x0 = Math.min(x0, a.min[0]); z0 = Math.min(z0, a.min[1]);
    x1 = Math.max(x1, a.max[0]); z1 = Math.max(z1, a.max[1]);
  }
  if (!Number.isFinite(x0)) return null;
  const m = MINI.margin;
  // Capped, so a stray far box can't ask for a picture the size of the sea.
  const cap = (v: number) => Math.max(-400, Math.min(400, v));
  return { x0: cap(x0 - m), z0: cap(z0 - m), x1: cap(x1 + m), z1: cap(z1 + m) };
}

export type MarkKind = "relay" | "boat" | "boat-shut" | "seal" | "bonded" | "wreck" | "threat" | "threat-air";

export interface Mark {
  kind: MarkKind;
  x: number;
  z: number;
  /** A letter drawn on the mark (the relay's). */
  label?: string;
  /** Held at the disc's edge when out of range (relays, the open boat, threats); the rest show only in range. */
  pinned: boolean;
}

export interface MarkInput {
  relays: { id: string; pos: { x: number; z: number } }[];
  cut: ReadonlySet<string>;
  boat: { pos: { x: number; z: number } } | null;
  boatOpen: boolean;
  targets: { kind: "seal" | "wreck"; bonded: boolean; at: { x: number; z: number } }[];
  machines: (Watched & { kind?: string })[];
  player: { x: number; y: number; z: number };
}

/** What the disc shows: the uplinks still to cut, the boat, seals and wrecks, and the machines that have seen you. */
export function marks(i: MarkInput): Mark[] {
  const out: Mark[] = [];
  for (const t of i.targets) out.push({ kind: t.kind === "wreck" ? "wreck" : t.bonded ? "bonded" : "seal", x: t.at.x, z: t.at.z, pinned: false });
  if (i.boat) out.push({ kind: i.boatOpen ? "boat" : "boat-shut", x: i.boat.pos.x, z: i.boat.pos.z, pinned: i.boatOpen });
  for (const r of i.relays) {
    if (i.cut.has(r.id)) continue;
    const letter = /([a-z0-9])$/i.exec(r.id)?.[1]?.toUpperCase() ?? "";
    out.push({ kind: "relay", x: r.pos.x, z: r.pos.z, label: letter, pinned: true });
  }
  // The same rule as the red markers on screen (sight/rules.ts isThreat): only a machine that has seen you shows.
  for (const m of i.machines) if (isThreat(m, i.player)) out.push({ kind: m.pos.y - i.player.y > 2.5 ? "threat-air" : "threat", x: m.pos.x, z: m.pos.z, pinned: true });
  return out;
}
