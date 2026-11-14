// sight/'s pure rules (src/economy/v2/sight/rules.ts): a machine's hit on a new player, the first-raid test, the
// signal lamp's on-screen size, which machines get a threat marker, and where that marker sits on or off screen.
import { describe, expect, it } from "vitest";
import { SIGHT, hasExtracted, isThreat, lampSize, lampTone, machineDamage, placeMarker } from "../src/economy/v2/sight/rules";

describe("machineDamage", () => {
  const armed = { armed: true, sinceUnarmed: Infinity, firstRaid: false };

  it("lands in full on an armed veteran", () => {
    expect(machineDamage(12, armed)).toBe(12);
    expect(machineDamage(12, { ...armed, armed: undefined })).toBe(12); // no coach in the build: nothing to wait for
  });

  it("does nothing while the rifle is still in its crate", () => {
    expect(machineDamage(12, { ...armed, armed: false, sinceUnarmed: 0 })).toBe(0);
    expect(machineDamage(12, { ...armed, armed: false, sinceUnarmed: 99 })).toBe(0);
  });

  it("does nothing for 3 s after the rifle is taken, then lands", () => {
    expect(machineDamage(12, { ...armed, sinceUnarmed: 0 })).toBe(0);
    expect(machineDamage(12, { ...armed, sinceUnarmed: 2.99 })).toBe(0);
    expect(machineDamage(12, { ...armed, sinceUnarmed: SIGHT.graceSeconds })).toBe(12);
    expect(machineDamage(12, { ...armed, sinceUnarmed: NaN })).toBe(0); // unknown is not "long ago"
  });

  it("halves a hit on a first raid", () => {
    expect(machineDamage(12, { ...armed, firstRaid: true })).toBe(6);
    expect(machineDamage(7, { ...armed, firstRaid: true })).toBe(3.5);
    expect(machineDamage(12, { ...armed, firstRaid: true, sinceUnarmed: 1 })).toBe(0);
  });

  it("passes a non-hit through untouched", () => {
    expect(machineDamage(0, armed)).toBe(0);
    expect(machineDamage(-5, { ...armed, firstRaid: true })).toBe(-5);
    expect(Number.isNaN(machineDamage(NaN, armed))).toBe(true);
  });
});

describe("hasExtracted", () => {
  it("is a first raid only when neither the profile nor this browser has an extraction", () => {
    expect(hasExtracted(0, false)).toBe(false);
    expect(hasExtracted(null, false)).toBe(false);
    expect(hasExtracted(undefined, false)).toBe(false);
    expect(hasExtracted(2, false)).toBe(true);
    expect(hasExtracted(0, true)).toBe(true);
    expect(hasExtracted(null, true)).toBe(true);
  });
});

describe("lamp", () => {
  it("is amber until the machine has seen the player, then red", () => {
    expect(lampTone("patrol")).toBe("watch");
    expect(lampTone("investigate")).toBe("watch");
    expect(lampTone(undefined)).toBe("watch");
    expect(lampTone("engage")).toBe("seen");
  });

  it("stays the same size on screen out to lampFar, never below the lamp itself", () => {
    const px = (d: number) => (lampSize(d, 75, 720) * 720) / (2 * d * Math.tan((75 * Math.PI) / 360));
    expect(lampSize(1, 75, 720)).toBe(SIGHT.lampMin);
    expect(px(15)).toBeCloseTo(SIGHT.lampPx, 5);
    expect(px(30)).toBeCloseTo(SIGHT.lampPx, 5);
    expect(lampSize(30, 75, 720)).toBeGreaterThan(lampSize(15, 75, 720));
    expect(lampSize(SIGHT.lampGone + 10, 75, 720)).toBe(SIGHT.lampMin);
    expect(lampSize(5000, 75, 720)).toBeLessThanOrEqual(SIGHT.lampMax);
  });
});

describe("isThreat", () => {
  const me = { x: 0, y: 0, z: 0 };
  it("marks a living machine that has seen the player within 40 m", () => {
    expect(isThreat({ alive: true, mode: "engage", pos: { x: 39, y: 0, z: 0 } }, me)).toBe(true);
    expect(isThreat({ alive: true, mode: "engage", pos: { x: 41, y: 0, z: 0 } }, me)).toBe(false);
    expect(isThreat({ alive: true, mode: "patrol", pos: { x: 5, y: 0, z: 0 } }, me)).toBe(false);
    expect(isThreat({ alive: true, mode: "investigate", pos: { x: 5, y: 0, z: 0 } }, me)).toBe(false);
    expect(isThreat({ alive: false, mode: "engage", pos: { x: 5, y: 0, z: 0 } }, me)).toBe(false);
  });
});

describe("placeMarker", () => {
  const W = 1280,
    H = 720,
    tan = Math.tan((75 * Math.PI) / 360),
    inset = SIGHT.edgeInset;
  const inside = (m: { x: number; y: number }) => m.x >= 0 && m.x <= W && m.y >= 0 && m.y <= H;

  it("sits on a machine straight ahead", () => {
    const m = placeMarker(0, 0, -20, tan, W, H);
    expect(m.on).toBe(true);
    expect(m.x).toBeCloseTo(W / 2);
    expect(m.y).toBeCloseTo(H / 2);
  });

  it("follows a machine across the view", () => {
    const m = placeMarker(5, -1, -20, tan, W, H);
    expect(m.on).toBe(true);
    expect(m.x).toBeGreaterThan(W / 2);
    expect(m.y).toBeGreaterThan(H / 2);
  });

  it("holds a machine off to the right at the right edge, pointing right", () => {
    const m = placeMarker(40, 0, -5, tan, W, H);
    expect(m.on).toBe(false);
    expect(m.x).toBeCloseTo(W - inset);
    expect(m.y).toBeCloseTo(H / 2);
    expect(m.angle).toBeCloseTo(0);
  });

  it("holds a machine behind on its own side, in the lower half, never in the middle", () => {
    const right = placeMarker(6, -1.5, 10, tan, W, H);
    expect(right.on).toBe(false);
    expect(right.x).toBeGreaterThan(W / 2);
    expect(right.y).toBeGreaterThanOrEqual(H / 2);
    const left = placeMarker(-6, 4, 10, tan, W, H); // above the eye, behind: still the lower half
    expect(left.x).toBeLessThan(W / 2);
    expect(left.y).toBeGreaterThanOrEqual(H / 2);
    const straight = placeMarker(0, 0, 10, tan, W, H);
    expect(straight.on).toBe(false);
    expect(straight.x).toBeCloseTo(W / 2);
    expect(straight.y).toBeGreaterThan(H / 2 + 100);
  });

  it("keeps every held marker on screen and clear of the corners", () => {
    for (let a = 0; a < Math.PI * 2; a += Math.PI / 16) {
      for (const z of [-3, 0, 3, 30]) {
        const m = placeMarker(Math.cos(a) * 50, Math.sin(a) * 50, z, tan, W, H);
        expect(inside(m)).toBe(true);
        if (!m.on) {
          expect(m.x).toBeGreaterThanOrEqual(inset - 1e-6);
          expect(m.x).toBeLessThanOrEqual(W - inset + 1e-6);
          // Never in a corner block: the HUD's objective, invoice, cargo and ammo panels live there.
          const cornerX = Math.min(m.x, W - m.x),
            cornerY = Math.min(m.y, H - m.y);
          expect(cornerX < 200 && cornerY < 120).toBe(false);
        }
      }
    }
  });

  it("treats a machine level with the camera as behind it", () => {
    const m = placeMarker(3, 0, 0, tan, W, H);
    expect(m.on).toBe(false);
    expect(m.x).toBeGreaterThan(W / 2);
  });
});
