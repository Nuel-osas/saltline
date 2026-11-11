// Where things go at a salvage spot, in the door's own frame: +x out of the doors, +z across them, y up. Pure math
// on the static spot table, shared by the world (meshes), the interaction (reach) and the HUD (markers).
import type { SalvageSpot } from "./spots";

export interface Point {
  x: number;
  y: number;
  z: number;
}

/** A point in the spot's door frame, in world coordinates. three.js yaw turns local +x to (cos, -sin). */
export function atDoor(s: SalvageSpot, lx: number, ly: number, lz: number): Point {
  const c = Math.cos(s.yaw),
    n = Math.sin(s.yaw);
  return { x: s.x + c * lx + n * lz, y: ly, z: s.z - n * lx + c * lz };
}

/** Shut doors are sealed on the doors; open ones on a crate standing 0.85 m inside the doorway. */
export const CRATE_X = -0.85;

/** Where the seal is: what the player faces and holds E at. */
export const sealPoint = (s: SalvageSpot): Point =>
  s.open ? atDoor(s, CRATE_X + 0.5, 0.5, 0) : atDoor(s, 0.1, 1.15, 0);

/**
 * Where a wreck may lie, in the door frame, in order of preference: beside the doors on either side (so it never
 * blocks a seal at the same spot), then further out. The game picks the first slot with open floor.
 */
export const WRECK_SLOTS: readonly (readonly [number, number])[] = [
  [1.75, 1.6],
  [1.75, -1.6],
  [2.8, 1.5],
  [2.8, -1.5],
  [1.75, 2.7],
  [1.75, -2.7],
];

export const wreckPoint = (s: SalvageSpot, slot: number): Point => {
  const [lx, lz] = WRECK_SLOTS[slot] ?? WRECK_SLOTS[0];
  return atDoor(s, lx, 0, lz);
};
