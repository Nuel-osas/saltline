// What a haul is worth (dock/haul.ts): who pays most for each unit and why, what it comes to, a failed read as
// unknown, and the one next step the scrip unlocks.
import { describe, expect, it } from "vitest";
import { haulOf, nextStep, planSale, worthLine } from "../src/economy/v2/dock/haul";
import { BLUEPRINTS, MATERIALS, VENDOR_PRICING } from "../src/economy/v2/items";
import { vendorBid } from "../src/economy/v2/mock";
import type { Listing, MaterialId, Quote, Vendor, Weapon } from "../src/economy/v2/types";

const n = (v: number) => v.toLocaleString("en-US");

// ---- the stand-ins: a vendor and the export desk, priced by the contract's rules ----
const bid = (m: MaterialId, stock: number, why = `holds ${stock}`): Quote => ({ tokenId: m, price: vendorBid(m, stock), reason: why });
function vendor(o: Partial<Vendor> & Pick<Vendor, "id">): Vendor {
  const stock = o.stock ?? { copper: 4, servo: 2 };
  return {
    accountId: `${o.id}.test`,
    name: o.id === "moss" ? "Moss" : "Ines",
    open: true,
    scrip: 5000,
    stock,
    bids: (Object.keys(stock) as MaterialId[]).map((m) => bid(m, stock[m] ?? 0, `${o.id} holds ${stock[m]}`)),
    goods: [],
    guns: [],
    lastMemo: null,
    ...o,
  };
}
const desk = (prices: Partial<Record<MaterialId, number>> = {}): Quote[] =>
  (Object.keys(MATERIALS) as MaterialId[]).map((m) => ({ tokenId: m, price: prices[m] ?? MATERIALS[m].export, reason: "Nothing sent lately." }));

describe("what a haul is worth", () => {
  it("prices each unit at the stock it meets and sends it to whoever pays most, with that buyer's reason", () => {
    const moss = vendor({ id: "moss", stock: { servo: 4 } });
    const plan = planSale([{ tokenId: "servo", amount: 2 }], [moss], desk())!;
    expect(plan.lots).toEqual([{ tokenId: "servo", amount: 2, to: "moss", price: vendorBid("servo", 4), total: vendorBid("servo", 4) + vendorBid("servo", 5), reason: "moss holds 4" }]);
    expect(Number.isSafeInteger(plan.total)).toBe(true);
    expect(worthLine(plan)).toBe(`Worth about ${n(plan.total)} scrip at Moss's today.`);
  });

  it("splits a lot when the next unit pays more elsewhere, and names every counter it goes to", () => {
    // Moss holds half the copper she wants and Ines none: Ines takes the first units, then they share the rest.
    const moss = vendor({ id: "moss", stock: { copper: 10 } });
    const ines = vendor({ id: "ines", stock: { copper: 0 } });
    const plan = planSale([{ tokenId: "copper", amount: 30 }], [moss, ines], desk({ copper: 1 }))!;
    const to = Object.fromEntries(plan.lots.map((l) => [l.to, l.amount]));
    expect(to.ines).toBeGreaterThan(0);
    expect(to.moss).toBeGreaterThan(0);
    expect(to.ines + to.moss).toBe(30);
    expect(plan.total).toBe(plan.lots.reduce((s, l) => s + l.total, 0));
    // Each unit went to the higher of the two next prices.
    expect(plan.lots.find((l) => l.to === "ines")!.price).toBe(vendorBid("copper", 0));
    expect(worthLine(plan)).toMatch(/^Worth about [\d,]+ scrip at (Ines's and Moss's|Moss's and Ines's) today\.$/);
  });

  it("never plans a sale a till can't pay without going under the float, nor one to a shut counter", () => {
    const broke = vendor({ id: "moss", scrip: VENDOR_PRICING.float + vendorBid("servo", 2) + 1, stock: { servo: 2 } });
    const shut = vendor({ id: "ines", open: false, stock: { copper: 0 } });
    const plan = planSale(
      [
        { tokenId: "servo", amount: 3 },
        { tokenId: "copper", amount: 1 },
      ],
      [broke, shut],
      desk(),
    )!;
    expect(plan.lots.find((l) => l.to === "moss")?.amount).toBe(1); // one servo is all her till covers
    expect(plan.lots.find((l) => l.tokenId === "servo" && l.to === "export")?.amount).toBe(2);
    expect(plan.lots.some((l) => l.to === "ines")).toBe(false);
    expect(plan.lots.find((l) => l.tokenId === "copper")?.to).toBe("export");
  });

  it("ignores a malformed quote rather than pricing from it", () => {
    const moss = vendor({ id: "moss", stock: { servo: 1 } });
    moss.bids = [{ tokenId: "servo", price: Number.NaN, reason: "?" }];
    const plan = planSale([{ tokenId: "servo", amount: 1 }], [moss], desk({ servo: 0 }))!;
    expect(plan.lots).toEqual([]);
    expect(plan.unsold).toEqual([{ tokenId: "servo", amount: 1 }]);
    expect(worthLine(plan)).toBe("Nobody is buying it today.");
  });

  it("a failed read is worth unknown, never 0", () => {
    const items = [{ tokenId: "servo" as const, amount: 2 }];
    expect(planSale(items, null, desk())).toBeNull();
    expect(planSale(items, [vendor({ id: "moss" })], null)).toBeNull();
    expect(worthLine(null)).toBe("Worth unknown: the counters didn't answer.");
    expect(worthLine(null)).not.toMatch(/\b0 scrip/);
    expect(haulOf(null)).toEqual([]);
    expect(haulOf({ scrip: 900, servo: 2, plate: 1, copper: 0 })).toEqual([{ tokenId: "servo", amount: 2 }]);
  });
});

describe("the one next step", () => {
  const gun = (frame: Weapon["frame"], grade: Weapon["grade"]) => ({ frame, grade, serial: "S-1" }) as Weapon;
  it("says a gun can be built when the parts and fee are held", () => {
    const lo = BLUEPRINTS.longshore;
    expect(nextStep({ balances: { ...lo.inputs, scrip: lo.fee }, vendors: [], listings: [], me: null })).toEqual({ text: "You can build a Longshore: the bench is in the Armoury.", go: { tab: "armoury", label: "Open the Armoury" } });
  });
  it("names the cheapest gun the scrip now buys, else how far off it is, else a build a few parts away", () => {
    const moss = vendor({ id: "moss", guns: [{ weapon: gun("longshore", "C"), price: 937 }] });
    const listings: Listing[] = [{ id: 1, seller: "me", callsign: "ME", price: 400, at: 0, weapon: gun("pilot", "D") }]; // my own: not for me
    expect(nextStep({ balances: { scrip: 1000 }, vendors: [moss], listings, me: "me" })).toEqual({ text: "You can afford a C-grade Longshore for 937 scrip on Moss's rack.", go: { tab: "vendors", who: "moss", label: "See Moss's rack" } });
    expect(nextStep({ balances: { scrip: 329 }, vendors: [moss], listings, me: "me" })?.text).toBe("You're 608 scrip short of a C-grade Longshore on Moss's rack.");
    expect(nextStep({ balances: { scrip: 500, copper: 3, chips: 4, servo: 2 }, vendors: [moss], listings, me: "me" })?.text).toBe("You're 3 copper short of a Longshore.");
    expect(nextStep({ balances: null, vendors: [moss], listings, me: "me" })).toBeNull();
  });
});
