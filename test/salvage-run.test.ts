import { describe, expect, it } from "vitest";
import { RULES } from "../src/economy/items";
import {
  SalvageLedger,
  checkManifest,
  cleanGear,
  cutTime,
  formatItems,
  haulValue,
  lostAgo,
  nearestSpot,
  resetBonuses,
} from "../src/economy/salvage/run";
import { SALVAGE_SPOTS } from "../src/economy/salvage/spots";
import type { Manifest } from "../src/economy/types";

const manifest = (over: Partial<Manifest> = {}): Manifest => ({
  runId: 7,
  startedAt: 0,
  containers: [
    { spot: 2, tokenId: "fuel", amount: 2 },
    { spot: 5, tokenId: "fuel", amount: 2 },
    { spot: 9, tokenId: "copper", amount: 2 },
    { spot: 11, tokenId: "meds", amount: 1 },
  ],
  wrecks: [
    { id: 40, spot: 3, owner: "a.testnet", callsign: "K. OSEI", items: [{ tokenId: "chips", amount: 2 }], at: 0 },
  ],
  ...over,
});

describe("weight and speed", () => {
  it("each unit carried slows the player; fuel weighs double", () => {
    const l = new SalvageLedger(manifest());
    expect(l.weight()).toBe(0);
    expect(l.speed()).toBe(1);
    expect(l.cut(11).ok).toBe(true); // meds ×1
    expect(l.weight()).toBe(1);
    expect(l.speed()).toBeCloseTo(0.94);
    expect(l.cut(2).ok).toBe(true); // fuel ×2 = 4
    expect(l.weight()).toBe(5);
    expect(l.speed()).toBeCloseTo(0.7);
  });

  it("a full load moves at 64%", () => {
    const l = new SalvageLedger(manifest());
    l.cut(2);
    l.cut(9);
    expect(l.weight()).toBe(RULES.carryLimit);
    expect(l.speed()).toBeCloseTo(0.64);
  });
});

describe("the carry limit", () => {
  it("refuses a seal that would go over, and leaves it sealed", () => {
    const l = new SalvageLedger(manifest());
    expect(l.cut(2).ok).toBe(true); // 4
    const r = l.cut(5); // +4 = 8 > 6
    expect(r).toEqual({ ok: false, reason: "limit", weight: 4, adds: 4 });
    expect(l.opened).toEqual([2]);
    expect(l.carried).toEqual({ fuel: 2 });
    expect(l.sealed().map((c) => c.spot)).toEqual([5, 9, 11]);
    expect(l.cut(9).ok).toBe(true); // copper ×2: exactly 6 fits
    expect(l.weight()).toBe(6);
  });

  it("weighs a wreck whole: all of it or none", () => {
    const l = new SalvageLedger(manifest());
    l.cut(2); // 4
    l.cut(11); // 5
    expect(l.recover(40)).toMatchObject({ ok: false, reason: "limit" }); // chips ×2 → 7
    expect(l.wrecks).toEqual([]);
  });

  it("can't take the same thing twice or something not in the manifest", () => {
    const l = new SalvageLedger(manifest());
    expect(l.cut(11).ok).toBe(true);
    expect(l.cut(11)).toEqual({ ok: false, reason: "gone" });
    expect(l.cut(0)).toEqual({ ok: false, reason: "gone" });
    expect(l.recover(41)).toEqual({ ok: false, reason: "gone" });
  });
});

describe("what goes to the chain", () => {
  it("extract gets the run, the spots cut in order and the wrecks recovered", () => {
    const l = new SalvageLedger(manifest());
    l.cut(11);
    l.recover(40);
    l.cut(9);
    expect(l.extractArgs()).toEqual([7, [11, 9], [40]]);
  });

  it("die adds the spot nearest where the player fell", () => {
    const l = new SalvageLedger(manifest());
    l.cut(2);
    const s = SALVAGE_SPOTS[13];
    expect(l.dieArgs(s.standX + 0.4, s.standZ - 0.3)).toEqual([7, [2], [], 13]);
  });

  it("hands out copies, so a call in flight can't change", () => {
    const l = new SalvageLedger(manifest());
    l.cut(11);
    const args = l.extractArgs();
    l.cut(9);
    expect(args).toEqual([7, [11], []]);
  });

  it("finds the nearest spot for any point", () => {
    for (const s of SALVAGE_SPOTS) expect(nearestSpot(s.standX, s.standZ)).toBe(s.id);
  });
});

describe("manifest checks (fail closed)", () => {
  it("accepts a well-formed manifest", () => {
    expect(checkManifest(manifest())).not.toBeNull();
    expect(checkManifest(manifest({ wrecks: [] }))).not.toBeNull();
  });

  it.each([
    ["a spot outside the table", { containers: [{ spot: 16, tokenId: "meds", amount: 1 }] }],
    [
      "a spot listed twice",
      {
        containers: [
          { spot: 1, tokenId: "meds", amount: 1 },
          { spot: 1, tokenId: "core", amount: 1 },
        ],
      },
    ],
    ["an unknown cargo", { containers: [{ spot: 1, tokenId: "gold", amount: 1 }] }],
    ["a zero amount", { containers: [{ spot: 1, tokenId: "meds", amount: 0 }] }],
    ["a fractional amount", { containers: [{ spot: 1, tokenId: "meds", amount: 1.5 }] }],
    [
      "more than eight containers",
      { containers: Array.from({ length: 9 }, (_, i) => ({ spot: i, tokenId: "meds", amount: 1 })) },
    ],
    ["a wreck with nothing in it", { wrecks: [{ id: 1, spot: 1, owner: "x", callsign: "X", items: [], at: 0 }] }],
    [
      "a wreck id twice",
      {
        wrecks: [1, 1].map((id) => ({
          id,
          spot: 2,
          owner: "x",
          callsign: "X",
          items: [{ tokenId: "meds", amount: 1 }],
          at: 0,
        })),
      },
    ],
    ["no run id", { runId: undefined }],
  ])("refuses %s", (_, over) => {
    expect(checkManifest(manifest(over as Partial<Manifest>))).toBeNull();
  });

  it("refuses things that aren't manifests", () => {
    for (const x of [null, undefined, 3, "m", {}, { runId: 1 }]) expect(checkManifest(x)).toBeNull();
  });
});

describe("gear", () => {
  it("keeps known gear, once each", () => {
    expect(cleanGear(["cutter", "plate", "cutter", "scrip", 4])).toEqual(["plate", "cutter"]);
    expect(cleanGear(undefined)).toEqual([]);
    expect(cleanGear("plate")).toEqual([]);
  });

  it("turns gear into the bonuses game.js reads", () => {
    expect(resetBonuses(["plate", "mag", "cutter"])).toEqual({ health: 40, rounds: 15 });
    expect(resetBonuses([])).toEqual({});
    expect(cutTime(["cutter"])).toBeCloseTo(0.6);
    expect(cutTime(["plate"])).toBe(1);
  });
});

describe("display", () => {
  it("formats a haul in table order", () => {
    expect(formatItems({ meds: 2, copper: 1 })).toBe("COPPER ×1 · MEDS ×2");
    expect(
      formatItems([
        { tokenId: "fuel", amount: 1 },
        { tokenId: "fuel", amount: 1 },
      ]),
    ).toBe("FUEL ×2");
    expect(formatItems({})).toBe("");
  });

  it("values a haul at the best open bid, or not at all", () => {
    const brokers = [
      {
        open: true,
        bids: [
          { tokenId: "meds", price: 90 },
          { tokenId: "fuel", price: 100 },
        ],
      },
      { open: true, bids: [{ tokenId: "fuel", price: 120 }] },
      { open: false, bids: [{ tokenId: "copper", price: 500 }] },
    ];
    expect(haulValue({ meds: 2, fuel: 1 }, brokers)).toBe(300);
    expect(haulValue({ copper: 1 }, brokers)).toBeNull(); // only a closed broker bids
    expect(haulValue({ meds: 1 }, null)).toBeNull(); // the bids couldn't be read
    expect(haulValue({}, brokers)).toBe(0);
  });

  it("says how long ago a wreck was lost", () => {
    const now = 10 * 86400_000;
    expect(lostAgo(now - 30_000, now)).toBe("LOST JUST NOW");
    expect(lostAgo(now - 40 * 60_000, now)).toBe("LOST 40M AGO");
    expect(lostAgo(now - 2 * 3600_000, now)).toBe("LOST 2H AGO");
    expect(lostAgo(now - 3 * 86400_000, now)).toBe("LOST 3D AGO");
  });
});
