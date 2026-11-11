// The in-run bookkeeping, with no three.js or DOM: what the manifest offers, what was cut open or recovered, what is
// carried and what goes to the chain. Pure, so the rules the contract enforces are tested here too.
import { CARGO, GEAR, RULES, carriedWeight, speedScale } from "../items";
import type { Amounts, CargoId, GearId, Manifest, ManifestEntry, WreckView } from "../types";
import { SALVAGE_SPOTS } from "./spots";

export type Items = { tokenId: CargoId; amount: number }[];

/** Seconds of holding E to cut a seal or turn over a wreck (the relays take 2.4). */
export const SEAL_SECONDS = 1.6;

/** Short stencil names, for tags, prompts and markers. */
export const SHORT: Record<CargoId, string> = {
  copper: "COPPER",
  meds: "MEDS",
  chips: "CHIPS",
  fuel: "FUEL",
  core: "CORE",
};

/** G.ext.gear, the bonuses game.js reads (docs/ECONOMY.md → Extension points). */
export interface GearBonuses {
  health?: number;
  rounds?: number;
  cutTime?: number;
}

/** The gear list as given, cleaned: known ids only, each once, in table order. Anything else is dropped. */
export function cleanGear(list: unknown): GearId[] {
  if (!Array.isArray(list)) return [];
  return GEAR.filter((id) => list.includes(id));
}

/** The reset-time bonuses (health, magazine) for a gear list. */
export function resetBonuses(gear: readonly GearId[]): GearBonuses {
  const b: GearBonuses = {};
  if (gear.includes("plate")) b.health = RULES.gear.plateHealth;
  if (gear.includes("mag")) b.rounds = RULES.gear.magRounds;
  return b;
}

/** The cut-time multiplier for a gear list: a cutter takes 40% off every seal and relay. */
export const cutTime = (gear: readonly GearId[]) => (gear.includes("cutter") ? 1 - RULES.gear.cutterSpeed : 1);

const isCount = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n > 0 && n < 1e6;
const isCargo = (id: unknown): id is CargoId => typeof id === "string" && (CARGO as string[]).includes(id);
const isSpot = (n: unknown): n is number =>
  typeof n === "number" && Number.isInteger(n) && n >= 0 && n < SALVAGE_SPOTS.length;
const isItems = (items: unknown): items is Items =>
  Array.isArray(items) && items.length > 0 && items.every((it) => it && isCargo(it.tokenId) && isCount(it.amount));

/**
 * A manifest from the chain, checked before the game shows any of it. Fails closed: one malformed or duplicated entry
 * and the whole manifest is refused, so the run plays as the baseline rather than offering cargo the contract won't
 * mint.
 */
export function checkManifest(m: unknown): Manifest | null {
  if (!m || typeof m !== "object") return null;
  const x = m as Manifest;
  if (typeof x.runId !== "number" || !Number.isInteger(x.runId) || x.runId < 0) return null;
  if (!Array.isArray(x.containers) || !Array.isArray(x.wrecks)) return null;
  if (x.containers.length > RULES.containersPerRun || x.wrecks.length > RULES.wrecksPerRun) return null;
  const spots = new Set<number>();
  for (const c of x.containers) {
    if (!c || !isSpot(c.spot) || !isCargo(c.tokenId) || !isCount(c.amount) || spots.has(c.spot)) return null;
    spots.add(c.spot);
  }
  const ids = new Set<number>();
  for (const w of x.wrecks) {
    if (!w || typeof w.id !== "number" || !Number.isInteger(w.id) || ids.has(w.id) || !isSpot(w.spot)) return null;
    if (!isItems(w.items) || typeof w.callsign !== "string") return null;
    ids.add(w.id);
  }
  return x;
}

export const itemsWeight = (items: Items) => carriedWeight(toAmounts(items));

export function toAmounts(items: Items): Amounts<CargoId> {
  const out: Amounts<CargoId> = {};
  for (const it of items) out[it.tokenId] = (out[it.tokenId] ?? 0) + it.amount;
  return out;
}

export function toItems(amounts: Amounts<CargoId>): Items {
  return CARGO.filter((id) => (amounts[id] ?? 0) > 0).map((id) => ({ tokenId: id, amount: amounts[id]! }));
}

/** `MEDS ×2 · COPPER ×1`, in table order. Empty string for nothing. */
export function formatItems(items: Items | Amounts<CargoId>): string {
  const list = Array.isArray(items) ? toItems(toAmounts(items)) : toItems(items);
  return list.map((it) => `${SHORT[it.tokenId]} ×${it.amount}`).join(" · ");
}

/** The salvage spot nearest a point (by stand point), for die(). */
export function nearestSpot(x: number, z: number): number {
  let best = 0,
    d = Infinity;
  for (const s of SALVAGE_SPOTS) {
    const e = Math.hypot(s.standX - x, s.standZ - z);
    if (e < d) ((d = e), (best = s.id));
  }
  return best;
}

export type TakeResult =
  | { ok: true; items: Items; weight: number }
  | { ok: false; reason: "limit"; weight: number; adds: number }
  | { ok: false; reason: "gone" };

/** One run's ledger: what the manifest offers and what the player has taken from it. */
export class SalvageLedger {
  /** Manifest spots cut open, in the order they were cut (extract/die `opened`). */
  readonly opened: number[] = [];
  /** Wreck ids recovered, in order (extract/die `wrecks`). */
  readonly wrecks: number[] = [];
  readonly carried: Amounts<CargoId> = {};

  constructor(readonly manifest: Manifest) {}

  get runId() {
    return this.manifest.runId;
  }

  weight() {
    return carriedWeight(this.carried);
  }

  speed() {
    return speedScale(this.weight());
  }

  /** Containers still sealed. */
  sealed(): ManifestEntry[] {
    return this.manifest.containers.filter((c) => !this.opened.includes(c.spot));
  }

  /** Wrecks not yet recovered. */
  standing(): WreckView[] {
    return this.manifest.wrecks.filter((w) => !this.wrecks.includes(w.id));
  }

  /** Whether these items fit under the carry limit on top of what is carried. */
  fits(items: Items) {
    return this.weight() + itemsWeight(items) <= RULES.carryLimit;
  }

  /** Cut the seal at a manifest spot. Refused over the carry limit; the seal stays on. */
  cut(spot: number): TakeResult {
    const c = this.manifest.containers.find((e) => e.spot === spot);
    if (!c || this.opened.includes(spot)) return { ok: false, reason: "gone" };
    return this.take([{ tokenId: c.tokenId, amount: c.amount }], () => this.opened.push(spot));
  }

  /** Turn over a wreck. All of it or nothing: the contract weighs the whole wreck. */
  recover(id: number): TakeResult {
    const w = this.manifest.wrecks.find((e) => e.id === id);
    if (!w || this.wrecks.includes(id)) return { ok: false, reason: "gone" };
    return this.take(w.items, () => this.wrecks.push(id));
  }

  private take(items: Items, mark: () => void): TakeResult {
    const adds = itemsWeight(items);
    if (!this.fits(items)) return { ok: false, reason: "limit", weight: this.weight(), adds };
    mark();
    for (const it of items) this.carried[it.tokenId] = (this.carried[it.tokenId] ?? 0) + it.amount;
    return { ok: true, items, weight: this.weight() };
  }

  /** The arguments for chain.extract. Copies, so later changes can't reach a call in flight. */
  extractArgs(): [number, number[], number[]] {
    return [this.runId, [...this.opened], [...this.wrecks]];
  }

  /** The arguments for chain.die: the cargo becomes a wreck at the spot nearest where the player fell. */
  dieArgs(x: number, z: number): [number, number[], number[], number] {
    return [this.runId, [...this.opened], [...this.wrecks], nearestSpot(x, z)];
  }
}

/**
 * What a haul is worth at the brokers' current bids: the best open bid for each cargo. Null (unknown) when the bids
 * couldn't be read or any cargo in the haul has no open buyer; never a guess.
 */
export function haulValue(
  haul: Amounts<CargoId>,
  brokers: { open: boolean; bids: { tokenId: string; price: number }[] }[] | null,
): number | null {
  if (!brokers) return null;
  let total = 0;
  for (const it of toItems(haul)) {
    let best: number | null = null;
    for (const b of brokers)
      if (b.open)
        for (const q of b.bids)
          if (q.tokenId === it.tokenId && Number.isFinite(q.price) && (best === null || q.price > best)) best = q.price;
    if (best === null) return null;
    total += best * it.amount;
  }
  return total;
}

/** `LOST 2H AGO` for a wreck's timestamp. */
export function lostAgo(at: number, now = Date.now()) {
  const m = Math.max(0, Math.round((now - at) / 60000));
  if (m < 2) return "LOST JUST NOW";
  if (m < 60) return `LOST ${m}M AGO`;
  const h = Math.round(m / 60);
  return h < 48 ? `LOST ${h}H AGO` : `LOST ${Math.round(h / 24)}D AGO`;
}
