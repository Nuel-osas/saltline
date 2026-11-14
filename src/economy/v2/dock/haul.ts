// The haul: what the player holds that somebody buys, who pays most for each lot today and why, about what it comes
// to, and the one thing the scrip unlocks next. Pure, so the debrief and the Vendors tab say the same thing.
//
// Prices are the counters' own quotes. A lot of several units is estimated the way the counters price it, each unit
// at the stock it meets (mock.ts `vendorBid`, the contract's rule; the export desk's 4% a unit), so "about" stays
// close to what the sale pays. The sale itself always goes through the chain, and what it paid is what is shown.
// A read that failed is unknown: no plan, never a plan worth 0.
import { fmt } from "../../dockside/format";
import { BLUEPRINTS, MATERIALS, MATERIAL_IDS, VENDOR_PRICING } from "../items";
import { MOCK2, vendorBid } from "../mock";
import type { Amounts, FrameId, Listing, MaterialId, Quote, Vendor, VendorId, Weapon } from "../types";

export type Buyer = VendorId | "export";
export interface HaulItem {
  tokenId: MaterialId;
  amount: number;
}

/** One sale: `amount` of a material to one buyer. */
export interface Lot extends HaulItem {
  to: Buyer;
  /** What the buyer quotes for the first unit. */
  price: number;
  /** About what the lot fetches. */
  total: number;
  /** The buyer's own reason for its price. */
  reason: string;
}

export interface HaulPlan {
  lots: Lot[];
  total: number;
  /** Units nobody will take today (every counter shut or broke). */
  unsold: HaulItem[];
}

export const BUYER: Record<Buyer, { name: string; at: string }> = {
  moss: { name: "Moss", at: "Moss's" },
  ines: { name: "Ines", at: "Ines's" },
  export: { name: "The export desk", at: "the export desk" },
};

const FRAME_SHORT: Record<FrameId, string> = { longshore: "Longshore", stevedore: "Stevedore", pilot: "Pilot" };
const PART_WORD: Record<MaterialId, [string, string]> = {
  copper: ["copper", "copper"],
  chips: ["electronics", "electronics"],
  meds: ["meds", "meds"],
  fuel: ["fuel cell", "fuel cells"],
  core: ["relay core", "relay cores"],
  servo: ["servo", "servos"],
  rotor: ["rotor", "rotors"],
};
const part = (m: MaterialId, n: number) => `${fmt(n)} ${PART_WORD[m][n === 1 ? 0 : 1]}`;

const price = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n > 0;

/** The materials a balance holds, in items.ts order. */
export function haulOf(b: Amounts | null | undefined): HaulItem[] {
  if (!b) return [];
  return MATERIAL_IDS.filter((m) => Number.isSafeInteger(b[m]) && (b[m] as number) > 0).map((m) => ({ tokenId: m, amount: b[m] as number }));
}

/** What the export desk pays for the `n`th unit after the one it quotes `q` for: ⌊export × 100 ÷ (100 + 4 × recent)⌋. */
function exportNext(m: MaterialId, q: number, n: number): number {
  const list = MATERIALS[m].export;
  return Math.floor((100 * q * list) / (100 * list + MOCK2.exportStepPct * n * q));
}

/**
 * Who pays most for each unit, one unit at a time: Moss and Ines on their quote and stock, inside what their tills can
 * pay without going under the float, and the export desk on its quote. Grouped into one sale per material and buyer.
 * Null when either set of prices couldn't be read.
 */
export function planSale(items: HaulItem[], vendors: Vendor[] | null | undefined, exportQuotes: Quote[] | null | undefined): HaulPlan | null {
  if (!vendors || !exportQuotes) return null;
  const till = new Map<VendorId, number>(vendors.map((v) => [v.id, Number.isSafeInteger(v.scrip) ? v.scrip - VENDOR_PRICING.float : 0]));
  const lots = new Map<string, Lot>();
  const unsold: HaulItem[] = [];
  let total = 0;
  for (const it of items) {
    const m = it.tokenId;
    let left = 0;
    for (let i = 0; i < it.amount; i++) {
      let best: { to: Buyer; p: number; q: Quote } | null = null;
      for (const v of vendors) {
        const q = v.open ? v.bids.find((b) => b.tokenId === m) : undefined;
        if (!q || !price(q.price)) continue;
        const n = lots.get(`${m}:${v.id}`)?.amount ?? 0;
        const p = n === 0 ? q.price : Math.min(q.price, vendorBid(m, (v.stock[m] ?? 0) + n));
        if (p <= 0 || p > (till.get(v.id) ?? 0)) continue;
        if (!best || p > best.p) best = { to: v.id, p, q };
      }
      const eq = exportQuotes.find((q) => q.tokenId === m);
      if (eq && price(eq.price)) {
        const n = lots.get(`${m}:export`)?.amount ?? 0;
        const p = n === 0 ? eq.price : exportNext(m, eq.price, n);
        if (p > 0 && (!best || p > best.p)) best = { to: "export", p, q: eq };
      }
      if (!best) {
        left++;
        continue;
      }
      if (best.to !== "export") till.set(best.to, (till.get(best.to) ?? 0) - best.p);
      const key = `${m}:${best.to}`;
      const lot = lots.get(key) ?? { tokenId: m, amount: 0, to: best.to, price: best.q.price, total: 0, reason: best.q.reason };
      lot.amount++;
      lot.total += best.p;
      lots.set(key, lot);
      total += best.p;
    }
    if (left) unsold.push({ tokenId: m, amount: left });
  }
  return { lots: [...lots.values()], total, unsold };
}

/** "Moss's", "Moss's and the export desk", "Moss's, Ines's and the export desk": the buyers, biggest share first. */
export function buyersAt(plan: HaulPlan): string {
  const share = new Map<Buyer, number>();
  for (const l of plan.lots) share.set(l.to, (share.get(l.to) ?? 0) + l.total);
  const at = [...share.entries()].sort((a, b) => b[1] - a[1]).map(([b]) => BUYER[b].at);
  return at.length <= 1 ? (at[0] ?? "") : `${at.slice(0, -1).join(", ")} and ${at[at.length - 1]}`;
}

/** The debrief's line: "worth about 186 scrip at Moss's today", or "worth unknown" when the counters didn't answer. */
export function worthLine(plan: HaulPlan | null): string {
  if (!plan) return "Worth unknown: the counters didn't answer.";
  if (!plan.lots.length) return "Nobody is buying it today.";
  return `Worth about ${fmt(plan.total)} scrip at ${buyersAt(plan)} today.`;
}

export interface NextStep {
  text: string;
  go?: { tab: "armoury" | "market" | "vendors"; who?: VendorId; label: string };
}

type ForSale = { w: Weapon; price: number; where: VendorId | "market"; seller?: string };

/**
 * The one thing to do next with what is held: build a gun if the parts and fee are there, else buy the cheapest gun
 * that can be afforded, else how far off the nearest gun is. Null when the stash couldn't be read.
 */
export function nextStep(o: { balances: Amounts | null; vendors: Vendor[] | null; listings: Listing[] | null; me: string | null }): NextStep | null {
  const b = o.balances;
  if (!b) return null;
  const scrip = Number.isSafeInteger(b.scrip) ? (b.scrip as number) : 0;
  const frames: FrameId[] = ["longshore", "stevedore", "pilot"];
  const short = (f: FrameId) =>
    MATERIAL_IDS.filter((m) => (BLUEPRINTS[f].inputs[m] ?? 0) > (b[m] ?? 0)).map((m) => ({ m, n: (BLUEPRINTS[f].inputs[m] ?? 0) - (b[m] ?? 0) }));
  for (const f of frames)
    if (!short(f).length && scrip >= BLUEPRINTS[f].fee) return { text: `You can build a ${FRAME_SHORT[f]}: the bench is in the Armoury.`, go: { tab: "armoury", label: "Open the Armoury" } };

  const guns: ForSale[] = [
    ...(o.vendors ?? []).flatMap((v) => v.guns.filter((g) => price(g.price)).map((g): ForSale => ({ w: g.weapon, price: g.price, where: v.id }))),
    ...(o.listings ?? []).filter((l) => l.weapon && l.seller !== o.me && price(l.price)).map((l): ForSale => ({ w: l.weapon!, price: l.price, where: "market", seller: l.callsign })),
  ].sort((x, y) => x.price - y.price);
  const name = (g: ForSale) => `${g.w.grade}-grade ${FRAME_SHORT[g.w.frame]}`;
  const place = (g: ForSale) => (g.where === "market" ? "on the Market" : `on ${BUYER[g.where].at} rack`);
  const go = (g: ForSale): NextStep["go"] => (g.where === "market" ? { tab: "market", label: "Open the Market" } : { tab: "vendors", who: g.where, label: `See ${BUYER[g.where].at} rack` });
  const buy = guns.find((g) => g.price <= scrip);
  if (buy) return { text: `You can afford a ${name(buy)} for ${fmt(buy.price)} scrip ${place(buy)}.`, go: go(buy) };

  // Nothing affordable: the nearer of a build a few parts away and the cheapest gun for sale.
  const near = frames.map((f) => ({ f, need: short(f) })).sort((x, y) => x.need.reduce((s, n) => s + n.n, 0) - y.need.reduce((s, n) => s + n.n, 0))[0];
  const parts = near.need.reduce((s, n) => s + n.n, 0);
  if (parts <= 3) {
    const fee = Math.max(0, BLUEPRINTS[near.f].fee - scrip);
    const list = [...near.need.map((n) => part(n.m, n.n)), ...(fee ? [`${fmt(fee)} scrip`] : [])];
    return { text: `You're ${list.join(", ").replace(/, ([^,]*)$/, " and $1")} short of a ${FRAME_SHORT[near.f]}.`, go: { tab: "armoury", label: "Open the Armoury" } };
  }
  const cheap = guns[0];
  if (cheap) return { text: `You're ${fmt(cheap.price - scrip)} scrip short of a ${name(cheap)} ${place(cheap)}.`, go: go(cheap) };
  return { text: "Redeploy. The next haul gets you closer to a gun." };
}
