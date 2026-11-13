// scripts/v2-chain-check.mjs's comparisons, offline: a contract that sends items.ts's numbers passes, and each
// number that differs is named.
import { describe, expect, it } from "vitest";
import * as items from "../src/economy/v2/items";
import { createMockChain2, rulesWire } from "../src/economy/v2/mock";

interface Check {
  compareAll(views: Record<string, unknown>, items: unknown): { problems: string[]; notes: string[] };
  checkHarbormaster(h: unknown, items: unknown): string[];
  toWire(items: unknown): { rules: Record<string, Record<string, unknown>>; materials: Record<string, unknown>[]; frames: Record<string, unknown>[]; blueprints: Record<string, unknown>[] };
  flatten(o: unknown): Record<string, unknown>;
}
const path = "../scripts/v2-chain-check.mjs";
const load = async () => (await import(/* @vite-ignore */ path)) as Check;

describe("v2 chain check", () => {
  it("a contract that sends items.ts's numbers matches, and so does the mock's own rules view", async () => {
    const c = await load();
    const wire = c.toWire(items);
    expect(c.compareAll(wire, items)).toEqual({ problems: [], notes: [] });
    expect(wire.materials[0]).toEqual({ id: "copper", name: "Copper coil", weight: 1, bid: "40", export: "25", target: 20 });
    expect(Object.keys(wire.rules)).toEqual(["raid", "invoice", "harbormaster", "market", "condition", "vendor_pricing"]);
    expect(wire.rules.raid.carry_limit).toBe(6);
    expect(wire.rules.vendor_pricing).toEqual({ goods_pct: 135, scarce_pct: 8, scarce_under: 5, gun_pct: 125, float: 100, meds_half_life_hours: 12 });
    expect(rulesWire()).toEqual(wire.rules);
    expect(c.compareAll({ ...wire, rules: await createMockChain2(1, { storage: null, stash: null }).rules() }, items)).toEqual({ problems: [], notes: [] });
  });

  it("rules sent flat, or with numbers as strings, don't match the doc", async () => {
    const c = await load();
    const wire = c.toWire(items);
    const flat = Object.assign({}, ...Object.values(wire.rules)) as Record<string, unknown>;
    expect(c.compareAll({ ...wire, rules: flat }, items).problems).toContain("rules.raid.carry_limit: missing on the contract (items.ts has 6)");
    wire.rules.invoice.entry = "150";
    expect(c.compareAll(wire, items).problems).toEqual(['rules.invoice.entry: contract "150", items.ts 150']);
  });

  it("names every number that differs, is missing, or is extra", async () => {
    const c = await load();
    const wire = c.toWire(items);
    wire.rules.invoice.per_minute = 61;
    delete wire.rules.raid.carry_limit;
    delete wire.rules.raid.slow_per_weight;
    wire.rules.market.listing_days = 7;
    wire.rules.vendor_pricing.gun_pct = 130;
    wire.materials[0].bid = "41";
    wire.frames[2].bands = { ...(wire.frames[2].bands as object), damage: [44, 59] };
    (wire.blueprints[0].inputs as Record<string, string>).servo = "3";
    (wire.blueprints[0].inputs as Record<string, string>).fuel = "1";
    wire.blueprints.pop();
    wire.materials.push({ id: "gold", name: "Gold", weight: 1, bid: "1", export: "1", target: 1 });
    const { problems, notes } = c.compareAll(wire, items);
    expect(problems).toEqual([
      "rules.raid.carry_limit: missing on the contract (items.ts has 6)",
      "rules.invoice.per_minute: contract 61, items.ts 60",
      "rules.vendor_pricing.gun_pct: contract 130, items.ts 125",
      "materials.copper.bid: contract 41, items.ts 40",
      "materials.gold: on the contract, not in items.ts",
      "frames.pilot.bands.damage[1]: contract 59, items.ts 58",
      "blueprints.longshore.inputs.servo: contract 3, items.ts 2",
      "blueprints.longshore.inputs.fuel: contract 1, items.ts 0",
      "blueprints.ammo: missing on the contract",
    ]);
    expect(notes).toEqual(["rules.raid.slow_per_weight: not sent (the client's own number, 0.06)", "rules.market.listing_days: on the contract (7), not in items.ts"]);
  });

  it("checks the Harbormaster's view against its own balance and posture", async () => {
    const c = await load();
    const base = { balance: "1100", strength: 55, posture: "patrols", bonus_drones: 2, second_notice_at: "600", bailiff_at: "1200", second_bailiff_at: "2400", foreclosure_at: "4000" };
    expect(c.checkHarbormaster(base, items)).toEqual([]);
    expect(c.checkHarbormaster({ ...base, posture: "pursuit", bonus_drones: 0, bailiff_at: "980" }, items)).toEqual([]);
    expect(c.checkHarbormaster({ ...base, posture: "pursuit" }, items)).toHaveLength(2);
    expect(c.checkHarbormaster({ ...base, strength: 60 }, items)[0]).toMatch(/^harbormaster\.strength: contract 60, the rules give 55/);
  });
});
