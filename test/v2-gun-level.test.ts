// @vitest-environment happy-dom
// Gun levels (items.ts gunLevel, effective): earned by raids brought home, kept with the gun, applied in the raid.
import { describe, expect, it } from "vitest";
import { gunCard, gunTile, levelEl } from "../src/economy/v2/dock/guncard";
import { CONDITION, GUN_LEVELS, effective, gunLevel } from "../src/economy/v2/items";
import { createMockChain2 } from "../src/economy/v2/mock";
import { shooterSpec } from "../src/economy/v2/raid/rules";
import type { Stats, Weapon } from "../src/economy/v2/types";

const STATS: Stats = { damage: 50, rpm: 700, mag: 30, recoil: 100, reload: 100, range: 300 };
const gun = (over: Partial<Weapon> = {}): Weapon =>
  ({ serial: "S-000041", frame: "longshore", grade: "B", quality: 70, stats: STATS, mods: [], condition: 90, maker: "moss.testnet", makerCallsign: "MOSS", owner: "me.testnet", builtAt: 0, raids: 0, extractions: 0, owners: 1, recovered: 0, state: "held", value: 900, ...over }) as Weapon;

describe("gunLevel", () => {
  it("climbs with raids brought home", () => {
    expect(gunLevel(0)).toEqual({ level: 1, name: "New", into: 0, need: 1, max: false, bonusPct: 0 });
    expect(gunLevel(1)).toMatchObject({ level: 2, name: "Broken in", into: 0, need: 2, bonusPct: 2 });
    expect(gunLevel(5)).toMatchObject({ level: 3, into: 2, need: 3, bonusPct: 4 });
    expect(gunLevel(14)).toMatchObject({ level: 5, name: "Storied", into: 4, need: 5, bonusPct: 8 });
  });
  it("tops out at the last level, and an unknown count is level 1", () => {
    expect(gunLevel(400)).toEqual({ level: GUN_LEVELS.at.length, name: "Notorious", into: 1, need: 1, max: true, bonusPct: 10 });
    for (const bad of [null, undefined, Number.NaN, -4]) expect(gunLevel(bad as number).level).toBe(1);
  });
  it("needs more raids for each level than the one before", () => {
    const steps = GUN_LEVELS.at.slice(1).map((at, i) => at - GUN_LEVELS.at[i]);
    for (let i = 1; i < steps.length; i++) expect(steps[i]).toBeGreaterThan(steps[i - 1]);
    expect(GUN_LEVELS.names).toHaveLength(GUN_LEVELS.at.length);
  });
});

describe("a levelled gun in the hands", () => {
  it("a new gun is exactly its rolled stats", () => {
    expect(effective(gun())).toMatchObject(STATS);
  });
  it("each level adds damage and takes recoil and reload off, and touches nothing else", () => {
    const e = effective(gun({ extractions: 6 })); // level 4: 6%
    expect(e).toMatchObject({ damage: 53, recoil: 94, reload: 94, rpm: 700, mag: 30, range: 300 });
    expect(effective(gun({ extractions: 15 }))).toMatchObject({ damage: 55, recoil: 90, reload: 90 });
  });
  it("stacks on mods, and a worn gun still pays for being worn", () => {
    const modded = effective(gun({ extractions: 3, mods: ["barrel2", "comp"] })); // level 3: 4%
    expect(modded.damage).toBe(Math.round((Math.round(50 * 1.12) * 104) / 100));
    expect(modded.recoil).toBe(Math.round((Math.round(100 * 0.75) * 96) / 100));
    const worn = effective(gun({ extractions: 15, condition: CONDITION.worn - 1 }));
    expect(worn.damage).toBe(Math.round(55 * 0.85));
    expect(worn.recoil).toBe(Math.round(90 * 1.2));
  });
  it("the raid's own numbers come from it: the same gun shoots harder at level 6 than at level 1", () => {
    const fresh = shooterSpec(gun(), 0);
    const old = shooterSpec(gun({ extractions: 15 }), 0);
    expect(old.damage).toBeGreaterThan(fresh.damage);
    expect(old.reload).toBeLessThan(fresh.reload);
    expect(old.mag).toBe(fresh.mag);
  });
});

describe("on the card and the rack", () => {
  it("the card says the level, the way to the next and what it adds", () => {
    const card = gunCard(gun({ extractions: 4 }));
    const lv = card.querySelector(".d2-lv")!;
    expect(lv.getAttribute("data-level")).toBe("3");
    expect(lv.textContent).toContain("Seasoned · 2 more raids home to level 4");
    expect(lv.textContent).toContain("+4% damage · −4% recoil and reload");
    expect(levelEl(5).textContent).toContain("1 more raid home to level 4");
    expect(levelEl(0).textContent).toContain("It levels up as it comes home from raids");
    expect(levelEl(99).textContent).toContain("Notorious · top level");
  });
  it("the rack's tile carries the level", () => {
    expect(gunTile(gun({ extractions: 10 })).textContent).toContain("Lv 5 · S-000041");
  });
  it("Practice's full locker has guns with a history, so levels show at once", async () => {
    const chain = createMockChain2(3, { storage: null, stash: "rich" });
    const levels = (await chain.weapons(chain.me())).map((w) => gunLevel(w.extractions).level).sort();
    expect(levels[levels.length - 1]).toBe(6);
    expect(new Set(levels).size).toBeGreaterThan(2);
  });
});
