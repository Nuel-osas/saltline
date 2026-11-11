import { describe, expect, it } from "vitest";
import { RULES } from "../src/economy/items";
import { WRECK_SLOTS, sealPoint, wreckPoint } from "../src/economy/salvage/place";
import { SALVAGE_SPOTS } from "../src/economy/salvage/spots";

// The world as game.js builds it: bounds oi.min/oi.max, and the quay edge (oi.quayX) past which is sea.
const WORLD = { minX: -40, maxX: 40, minZ: -30, maxZ: 30, quayX: 30 };
const inside = (x: number, z: number) => x > WORLD.minX && x < WORLD.quayX && z > WORLD.minZ && z < WORLD.maxZ;

describe("salvage spots", () => {
  it("has one spot per contract spot index, in order", () => {
    expect(SALVAGE_SPOTS).toHaveLength(16);
    expect(RULES.spotCount).toBe(SALVAGE_SPOTS.length);
    SALVAGE_SPOTS.forEach((s, i) => expect(s.id).toBe(i));
  });

  it("puts every spot at a different container, at least 2 m apart", () => {
    for (let i = 0; i < SALVAGE_SPOTS.length; i++)
      for (let j = i + 1; j < SALVAGE_SPOTS.length; j++) {
        const a = SALVAGE_SPOTS[i],
          b = SALVAGE_SPOTS[j];
        expect(Math.hypot(a.x - b.x, a.z - b.z), `spots ${i} and ${j}`).toBeGreaterThan(2);
      }
  });

  it("keeps doors, stand points, seals and wreck slots on land inside the world", () => {
    for (const s of SALVAGE_SPOTS) {
      expect(inside(s.x, s.z), `door ${s.id}`).toBe(true);
      expect(inside(s.standX, s.standZ), `stand ${s.id}`).toBe(true);
      const p = sealPoint(s);
      expect(inside(p.x, p.z), `seal ${s.id}`).toBe(true);
      WRECK_SLOTS.forEach((_, k) => {
        const w = wreckPoint(s, k);
        expect(inside(w.x, w.z), `wreck slot ${k} at ${s.id}`).toBe(true);
      });
    }
  });

  it("stands the player 1–2 m straight out from the doors", () => {
    for (const s of SALVAGE_SPOTS) {
      const dx = s.standX - s.x,
        dz = s.standZ - s.z,
        d = Math.hypot(dx, dz);
      expect(d).toBeGreaterThan(1);
      expect(d).toBeLessThan(2);
      // Along the facing (cos yaw, -sin yaw).
      expect((dx * Math.cos(s.yaw) - dz * Math.sin(s.yaw)) / d).toBeGreaterThan(0.99);
    }
  });

  it("spreads across the yard, shed and quay routes", () => {
    const zones = new Set(SALVAGE_SPOTS.map((s) => s.zone));
    for (const z of ["yard", "shed", "quay"]) expect(zones.has(z as never), z).toBe(true);
  });
});
