// sight/'s pure rules (src/economy/v2/sight/rules.ts): the signal lamp's on-screen size, which machines get a threat marker, and where that marker sits on or off screen.
import { describe, expect, it } from "vitest";
import { SIGHT, isThreat, lampSize, lampTone, placeMarker } from "../src/economy/v2/sight/rules";

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
