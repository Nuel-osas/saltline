import { describe, expect, it } from "vitest";
import { BROKERS, CARGO, ITEMS, RULES, carriedWeight, speedScale } from "../src/economy/items";

describe("item table", () => {
  it("bids above export for every cargo, so a broker can profit at target stock", () => {
    for (const id of CARGO) expect(ITEMS[id].base).toBeGreaterThan(ITEMS[id].export!);
  });
  it("every cargo has at least one broker that buys it", () => {
    for (const id of CARGO) expect(Object.values(BROKERS).some((b) => b.buys.includes(id))).toBe(true);
  });
  it("a full load slows the player to 64%", () => {
    expect(carriedWeight({ copper: 2, fuel: 2 })).toBe(RULES.carryLimit);
    expect(speedScale(RULES.carryLimit)).toBeCloseTo(0.64);
  });
});
