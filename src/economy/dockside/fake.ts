// A local fake Chain and Wallet for building the Dockside before the shared mock (mock.ts) lands. It moves on its
// own: other traders sell and haul, prices drift, brokers export, go broke and reopen, the ledger fills. It uses the
// pricing rules from docs/ECONOMY.md with integer maths, so what it shows is the right shape, but it is not the
// contract and not the shared mock. The lead swaps it out at integration; nothing outside dev and tests loads it.
import { BROKERS, CARGO, GEAR, ITEMS, RULES } from "../items";
import type {
  Amounts,
  BrokerId,
  BrokerView,
  CargoId,
  Chain,
  Economy,
  GearId,
  Leaderboard,
  LedgerEvent,
  LedgerKind,
  Listing,
  Profile,
  Quote,
  SimBroker,
  SimPoint,
  TokenId,
  TxResult,
  Wallet,
} from "../types";
import { checkCallsign, FLOAT_CLOSE, FLOAT_REOPEN } from "./format";

// ---- pricing (docs/ECONOMY.md → Pricing rules) ----

export const bidFor = (cargo: CargoId, stock: number, stance: number) => {
  const { base, target = 1 } = ITEMS[cargo];
  return Math.floor((base * 2 * target * stance) / ((target + stock) * 100));
};
export const askFor = (gear: GearId, recentSales: number, stance: number) =>
  Math.floor((ITEMS[gear].base * (100 + recentSales) * stance) / 10000);

const UNIT: Record<CargoId, string> = { copper: "coils", meds: "cases", chips: "boxes", fuel: "cells", core: "cores" };

function stanceNote(stance: number) {
  return stance < 95 ? ` Stance ${stance}: watching the cash.` : stance > 105 ? ` Stance ${stance}: paying over the odds.` : "";
}

export function bidReason(cargo: CargoId, stock: number, stance: number, open: boolean): string {
  if (!open) return `Shuttered. Not buying until the float is back to ${FLOAT_REOPEN}.`;
  const { base, target = 1 } = ITEMS[cargo];
  const p = Math.round((bidFor(cargo, stock, stance) * 100) / base);
  const u = UNIT[cargo];
  let s: string;
  if (stock >= target * 2) s = `Sitting on ${stock} ${u} against a target of ${target}. Paying ${p}% of base.`;
  else if (stock > target) s = `${stock} ${u} in the shed, target ${target}. Paying under base.`;
  else if (stock === target) s = `Right on target at ${target} ${u}. Paying base.`;
  else s = `Short: ${stock} ${u} against a target of ${target}. Paying ${p}% of base.`;
  return s + stanceNote(stance);
}

function askReason(gear: GearId, recent: number, stance: number): string {
  const p = Math.round((askFor(gear, recent, stance) * 100) / ITEMS[gear].base);
  const s = recent > 0 ? `${recent} sold in the last few hours. Asking ${p}% of list.` : "Quiet shelf. List price.";
  return s + stanceNote(stance);
}

// ---- seeded randomness ----

export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- state ----

interface BrokerState {
  id: BrokerId;
  open: boolean;
  scrip: number;
  stance: number;
  stock: Amounts<CargoId>;
  /** Units of each gear sold lately, decaying with a half-life (compressed to minutes on the fake). */
  sold: Partial<Record<GearId, { v: number; at: number }>>;
  shares: Map<string, { callsign: string; shares: number }>;
  memo: string | null;
  closedAt: number;
}

interface Trader {
  accountId: string;
  callsign: string;
  hold: Amounts;
  bestHaul: number;
  invested: number;
}

export interface FakeOptions {
  seed?: number;
  /** Start with a registered player holding a haul (default false: the first visit shows the dock pass card). */
  registered?: boolean;
  /** Milliseconds a call takes to settle; views take a third of it. */
  latency?: number;
  txUrl?: (hash: string) => string | null;
}

export interface FakeChain extends Chain {
  readonly wallet: Wallet;
  /** Methods named here reject, like a failed RPC read or a dropped call. */
  readonly failing: Set<string>;
  /** One move by the rest of the market. */
  tick(): void;
  /** Keep the market moving on a timer (dev). */
  start(everyMs?: number): void;
  stop(): void;
  /** Direct access for tests and the screenshot script. */
  readonly state: { brokers: Record<BrokerId, BrokerState>; player: Trader & { registered: boolean } };
}

const HALF_LIFE_MS = 10 * 60_000;
const SIDE_INCOME: Record<BrokerId, number> = { moss: 30, ines: 28, qm: 30 };
const NPC = [
  "K. OSEI",
  "R. VANCE",
  "TALLYMAN",
  "M. ADEYEMI",
  "NORTH-7",
  "J. LINDQVIST",
  "HOOK",
  "S. PARK",
  "BOSUN_9",
  "E. MORROW",
  "DRY.DOCK",
  "A. NWOSU",
];

export function createFakeChain(opts: FakeOptions = {}): FakeChain {
  const rand = mulberry32(opts.seed ?? 4207);
  const latency = opts.latency ?? 900;
  const failing = new Set<string>();
  const hex = (n: number) => Array.from({ length: n }, () => "0123456789abcdef"[Math.floor(rand() * 16)]).join("");
  const b58 = () =>
    Array.from({ length: 44 }, () => "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"[Math.floor(rand() * 57)]).join("");
  const now = () => Date.now();
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)];
  const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  const mkBroker = (id: BrokerId, open: boolean, scrip: number, stance: number, stock: Amounts<CargoId>, memo: string): BrokerState => ({
    id,
    open,
    scrip,
    stance,
    stock,
    sold: {},
    shares: new Map(),
    memo,
    // Counted from page load, not from the seeded "40 min ago", so the player gets the first go at reopening.
    closedAt: open ? 0 : now(),
  });
  const brokers: Record<BrokerId, BrokerState> = {
    moss: mkBroker("moss", true, 1240, 96, { copper: 22, chips: 7 }, "Too much copper in the shed. Shipped 18 coils at 35 and cut the stance."),
    ines: mkBroker("ines", false, 62, 88, { meds: 14, fuel: 9 }, "Can't cover another fuel buy. Shutting the hatch until the float's back."),
    qm: mkBroker("qm", true, 640, 116, { core: 2, fuel: 5 }, "The client wants cores by Friday. Paying over the odds."),
  };
  brokers.moss.sold.cutter = { v: 6, at: now() };
  brokers.qm.sold.mag = { v: 3, at: now() };
  brokers.ines.shares.set("m-adeyemi.fake", { callsign: "M. ADEYEMI", shares: 40 });
  brokers.moss.shares.set("tallyman.fake", { callsign: "TALLYMAN", shares: 300 });

  const traders: Trader[] = NPC.map((callsign, i) => ({
    accountId: callsign.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") + ".fake",
    callsign,
    hold: { scrip: 200 + Math.floor(rand() * 1400), copper: Math.floor(rand() * 6), meds: Math.floor(rand() * 4), fuel: Math.floor(rand() * 3), core: i % 4 === 0 ? 1 : 0 },
    bestHaul: 120 + Math.floor(rand() * 520),
    invested: 0,
  }));
  traders.find((t) => t.callsign === "TALLYMAN")!.invested = 300;
  traders.find((t) => t.callsign === "M. ADEYEMI")!.invested = 40;

  const player: Trader & { registered: boolean } = {
    accountId: hex(64),
    callsign: "",
    hold: {},
    bestHaul: 0,
    invested: 0,
    registered: false,
  };
  const STARTER_HAUL: Amounts = { copper: 5, chips: 2, meds: 3, fuel: 2, core: 1, plate: 1, mag: 1 };
  const register = (callsign: string) => {
    player.callsign = callsign;
    player.registered = true;
    // The fake skips the first run: it hands over a starter haul so the stalls have something to buy.
    player.hold = { scrip: RULES.starterScrip, ...STARTER_HAUL };
    player.bestHaul = 412;
  };
  if (opts.registered) {
    register("WREN");
    player.hold.scrip = 412;
  }

  // ---- ledger ----
  const ledger: LedgerEvent[] = [];
  const log = (kind: LedgerKind, account: string, callsign: string | undefined, text: string, at = now()) => {
    const ev: LedgerEvent = { kind, at, account, callsign, text, txHash: b58() };
    ledger.unshift(ev);
    ledger.sort((a, b) => b.at - a.at);
    ledger.length = Math.min(ledger.length, 64);
    return ev;
  };
  const ago = (min: number) => now() - min * 60_000;
  log("export", "moss.fake", "Moss", "Moss shipped COPPER ×18 to the freighter: “Too much copper in the shed.”", ago(52));
  log("close", "ines.fake", "Ines", "Ines shuttered: the float is down to 62", ago(40));
  log("sale", "k-osei.fake", "K. OSEI", "K. OSEI sold FUEL ×2 to Ines for 238", ago(41));
  log("invest", "m-adeyemi.fake", "M. ADEYEMI", "M. ADEYEMI put 40 scrip into Ines", ago(31));
  log("stance", "qm.fake", "Quartermaster", "Quartermaster set stance 116: “The client wants cores by Friday.”", ago(24));
  log("wreck", "j-lindqvist.fake", "J. LINDQVIST", "J. LINDQVIST went down in the yard. Wreck: FUEL ×2", ago(18));
  log("extract", "r-vance.fake", "R. VANCE", "R. VANCE hauled COPPER ×4 out of the yard", ago(12));
  log("sale", "r-vance.fake", "R. VANCE", "R. VANCE sold COPPER ×4 to Moss for 176", ago(11));
  log("purchase", "hook.fake", "HOOK", "HOOK bought MAG ×1 from the Quartermaster for 58", ago(7));
  log("extract", "k-osei.fake", "K. OSEI", "K. OSEI hauled MEDS ×3 out of the yard", ago(2));

  // ---- listings ----
  let nextListing = 41;
  const listings: Listing[] = [
    { id: 36, seller: "hook.fake", callsign: "HOOK", tokenId: "core", amount: 1, price: 205, at: ago(33) },
    { id: 37, seller: "s-park.fake", callsign: "S. PARK", tokenId: "meds", amount: 3, price: 96, at: ago(21) },
    { id: 38, seller: "north-7.fake", callsign: "NORTH-7", tokenId: "plate", amount: 1, price: 74, at: ago(14) },
    { id: 39, seller: "a-nwosu.fake", callsign: "A. NWOSU", tokenId: "fuel", amount: 2, price: 120, at: ago(9) },
    { id: 40, seller: "bosun-9.fake", callsign: "BOSUN_9", tokenId: "chips", amount: 4, price: 70, at: ago(4) },
  ];

  // ---- helpers ----
  const recentSales = (b: BrokerState, g: GearId) => {
    const s = b.sold[g];
    if (!s) return 0;
    return Math.round(s.v * Math.pow(0.5, (now() - s.at) / HALF_LIFE_MS));
  };
  const bump = (b: BrokerState, g: GearId, n: number) => {
    b.sold[g] = { v: recentSales(b, g) + n, at: now() };
  };
  const name = (id: BrokerId) => BROKERS[id].name;
  const fail = (m: string) => {
    if (failing.has(m)) throw new Error(`fake: ${m} unreachable`);
  };
  const view = async <T>(m: string, fn: () => T): Promise<T> => {
    await wait(latency / 3);
    fail(m);
    return fn();
  };
  const call = async <T extends TxResult>(m: string, fn: () => T): Promise<T> => {
    await wait(latency);
    fail(m);
    const r = fn();
    if (r.ok) r.txHash = b58();
    return r;
  };
  const refuse = <T extends TxResult>(error: string) => ({ ok: false, error }) as T;
  const bal = (t: Trader, id: TokenId) => t.hold[id] ?? 0;
  const add = (t: Trader, id: TokenId, n: number) => {
    t.hold[id] = bal(t, id) + n;
  };
  const sharesTotal = (b: BrokerState) => [...b.shares.values()].reduce((s, x) => s + x.shares, 0);
  const closeBroker = (b: BrokerState) => {
    if (!b.open) return;
    b.open = false;
    b.closedAt = now();
    b.memo = `Float's down to ${b.scrip}. Can't cover another buy. Shutting until someone invests.`;
    log("close", `${b.id}.fake`, name(b.id), `${name(b.id)} shuttered: the float is down to ${b.scrip}`);
  };

  /** Price a batch one unit at a time, stock rising between units. Null when the broker can't cover it. */
  const batch = (b: BrokerState, cargo: CargoId, amount: number) => {
    let stock = b.stock[cargo] ?? 0;
    let total = 0;
    for (let i = 0; i < amount; i++) total += bidFor(cargo, stock++, b.stance);
    return b.scrip - total < FLOAT_CLOSE ? null : total;
  };

  const doSell = (t: Trader, brokerId: BrokerId, cargo: CargoId, amount: number): TxResult & { paid?: number } => {
    const b = brokers[brokerId];
    if (!b) return refuse("No such broker");
    if (!BROKERS[brokerId].buys.includes(cargo)) return refuse(`${name(brokerId)} doesn't buy ${ITEMS[cargo].name.toLowerCase()}`);
    if (!b.open) return refuse(`${name(brokerId)} is shut until someone invests`);
    if (!Number.isInteger(amount) || amount <= 0) return refuse("Zero or too large");
    if (bal(t, cargo) < amount) return refuse("Not enough cargo");
    const paid = batch(b, cargo, amount);
    if (paid == null) {
      if (batch(b, cargo, 1) == null) closeBroker(b);
      return refuse(`${name(brokerId)} can't cover that sale`);
    }
    add(t, cargo, -amount);
    add(t, "scrip", paid);
    b.stock[cargo] = (b.stock[cargo] ?? 0) + amount;
    b.scrip -= paid;
    log("sale", t.accountId, t.callsign, `${t.callsign} sold ${cargo.toUpperCase()} ×${amount} to ${name(brokerId)} for ${paid}`);
    if (batch(b, cargo, 1) == null) closeBroker(b);
    return { ok: true, paid };
  };

  const doBuy = (t: Trader, brokerId: BrokerId, gear: GearId, amount: number): TxResult & { cost?: number } => {
    const b = brokers[brokerId];
    if (!BROKERS[brokerId].sells.includes(gear)) return refuse(`${name(brokerId)} doesn't sell that`);
    if (!b.open) return refuse(`${name(brokerId)} is shut until someone invests`);
    if (!Number.isInteger(amount) || amount <= 0) return refuse("Zero or too large");
    let cost = 0;
    for (let i = 0; i < amount; i++) cost += askFor(gear, recentSales(b, gear) + i, b.stance);
    if (bal(t, "scrip") < cost) return refuse("Not enough scrip");
    add(t, "scrip", -cost);
    add(t, gear, amount);
    b.scrip += cost;
    bump(b, gear, amount);
    log("purchase", t.accountId, t.callsign, `${t.callsign} bought ${gear.toUpperCase()} ×${amount} from ${name(brokerId)} for ${cost}`);
    return { ok: true, cost };
  };

  const doInvest = (t: Trader, brokerId: BrokerId, amount: number): TxResult => {
    const b = brokers[brokerId];
    if (!b) return refuse("No such broker");
    if (!Number.isInteger(amount) || amount <= 0) return refuse("Zero or too large");
    if (bal(t, "scrip") < amount) return refuse("Not enough scrip");
    add(t, "scrip", -amount);
    b.scrip += amount;
    t.invested += amount;
    const cur = b.shares.get(t.accountId);
    b.shares.set(t.accountId, { callsign: t.callsign, shares: (cur?.shares ?? 0) + amount });
    log("invest", t.accountId, t.callsign, `${t.callsign} put ${amount} scrip into ${name(brokerId)}`);
    if (!b.open && b.scrip >= FLOAT_REOPEN) {
      b.open = true;
      b.memo = `Back open. ${sharesTotal(b)} scrip of shares on the books; paying out of the freighter margin.`;
      log("reopen", `${b.id}.fake`, name(b.id), `${name(b.id)} reopened: investors put the float back to ${b.scrip}`);
    }
    return { ok: true };
  };

  const quotes = (b: BrokerState): { bids: Quote[]; asks: Quote[] } => ({
    bids: BROKERS[b.id].buys.map((c) => ({
      tokenId: c,
      price: bidFor(c, b.stock[c] ?? 0, b.stance),
      reason: bidReason(c, b.stock[c] ?? 0, b.stance, b.open),
    })),
    asks: BROKERS[b.id].sells.map((g) => ({
      tokenId: g,
      price: askFor(g, recentSales(b, g), b.stance),
      reason: askReason(g, recentSales(b, g), b.stance),
    })),
  });

  const bestBid = (c: CargoId) =>
    Math.max(0, ...Object.values(brokers).filter((b) => b.open && BROKERS[b.id].buys.includes(c)).map((b) => bidFor(c, b.stock[c] ?? 0, b.stance)));
  const worth = (t: Trader) =>
    bal(t, "scrip") + CARGO.reduce((s, c) => s + bal(t, c) * bestBid(c), 0) + GEAR.reduce((s, g) => s + bal(t, g) * ITEMS[g].base, 0);

  // ---- the rest of the market, one move at a time ----
  function tick() {
    const r = rand();
    const t = pick(traders);
    const open = Object.values(brokers).filter((b) => b.open);
    if (r < 0.4 && open.length) {
      const b = pick(open);
      const c = pick(BROKERS[b.id].buys);
      const n = 1 + Math.floor(rand() * 3);
      if (bal(t, c) < n) add(t, c, n);
      doSell(t, b.id, c, n);
    } else if (r < 0.56) {
      const c = pick(CARGO);
      const n = 1 + Math.floor(rand() * 3);
      add(t, c, n);
      log("extract", t.accountId, t.callsign, `${t.callsign} hauled ${c.toUpperCase()} ×${n} out of the yard`);
    } else if (r < 0.64 && open.length) {
      const b = pick(open);
      if (bal(t, "scrip") < 200) add(t, "scrip", 300);
      doBuy(t, b.id, pick(BROKERS[b.id].sells), 1);
    } else if (r < 0.78 && open.length) {
      const b = pick(open);
      const c = BROKERS[b.id].buys.find((c) => (b.stock[c] ?? 0) > (ITEMS[c].target ?? 0));
      if (!c) return;
      const n = (b.stock[c] ?? 0) - (ITEMS[c].target ?? 0);
      const earned = n * (ITEMS[c].export ?? 0);
      b.stock[c] = ITEMS[c].target;
      b.scrip += earned - Math.floor(earned / 10);
      b.memo = `Overstocked on ${ITEMS[c].name.toLowerCase()}. Shipped ${n} to the freighter at ${ITEMS[c].export}.`;
      log("export", `${b.id}.fake`, name(b.id), `${name(b.id)} shipped ${c.toUpperCase()} ×${n} to the freighter: “Clearing the shed.”`);
    } else if (r < 0.86 && open.length) {
      const b = pick(open);
      const s = Math.max(80, Math.min(120, b.stance + (rand() < 0.5 ? -4 : 4)));
      if (s === b.stance) return;
      b.stance = s;
      b.memo = s < 100 ? `Cash is tight. Stance down to ${s}.` : `Shelves are thin. Stance up to ${s}.`;
      log("stance", `${b.id}.fake`, name(b.id), `${name(b.id)} set stance ${s}: “${b.memo}”`);
    } else {
      // Other players only bail out a broker that has been shut a while, so the player gets the first chance.
      const shut = Object.values(brokers).filter((b) => !b.open && now() - b.closedAt > 3 * 60_000);
      if (!shut.length) return;
      if (bal(t, "scrip") < 200) add(t, "scrip", 300);
      doInvest(t, pick(shut).id, 80 + Math.floor(rand() * 120));
    }
  }

  // ---- the fast-forward (simulate) ----
  function simulate(hours: number, nTraders: number, seed: number): SimPoint[] {
    const r = mulberry32(seed);
    const s = Object.fromEntries(
      Object.values(brokers).map((b) => [b.id, { open: b.open, scrip: b.scrip, stance: b.stance, stock: { ...b.stock }, shut: b.open ? 0 : 6 }]),
    ) as Record<BrokerId, { open: boolean; scrip: number; stance: number; stock: Amounts<CargoId>; shut: number; calm?: number }>;
    const weights: [CargoId, number][] = [["copper", 0.3], ["chips", 0.24], ["meds", 0.2], ["fuel", 0.16], ["core", 0.1]];
    const cargoPick = () => {
      let x = r();
      for (const [c, w] of weights) if ((x -= w) <= 0) return c;
      return "copper" as CargoId;
    };
    const snap = (hour: number): SimPoint => ({
      hour,
      brokers: Object.fromEntries(
        (Object.keys(s) as BrokerId[]).map((id) => {
          const b = s[id];
          const out: SimBroker = {
            open: b.open,
            scrip: b.scrip,
            stock: { ...b.stock },
            bids: Object.fromEntries(BROKERS[id].buys.map((c) => [c, bidFor(c, b.stock[c] ?? 0, b.stance)])),
          };
          return [id, out];
        }),
      ) as Record<BrokerId, SimBroker>,
    });
    const points: SimPoint[] = [snap(0)];
    for (let hour = 1; hour <= hours; hour++) {
      const tod = hour % 24;
      const activity = 0.45 + 0.55 * Math.max(0, Math.sin(((tod - 8) / 24) * Math.PI * 2));
      for (let t = 0; t < nTraders; t++) {
        if (r() > 0.11 * activity) continue;
        const c = cargoPick();
        const n = 1 + Math.floor(r() * 3);
        let best: BrokerId | null = null;
        let bestBid = -1;
        for (const id of Object.keys(s) as BrokerId[]) {
          const b = s[id];
          if (!b.open || !BROKERS[id].buys.includes(c)) continue;
          const bid = bidFor(c, b.stock[c] ?? 0, b.stance);
          if (bid > bestBid) (bestBid = bid), (best = id);
        }
        if (!best) continue;
        const b = s[best];
        for (let i = 0; i < n; i++) {
          const bid = bidFor(c, b.stock[c] ?? 0, b.stance);
          if (b.scrip - bid < FLOAT_CLOSE) {
            b.open = false;
            b.shut = 0;
            break;
          }
          b.scrip -= bid;
          b.stock[c] = (b.stock[c] ?? 0) + 1;
        }
        if (r() < 0.25) {
          const id = pick(Object.keys(s) as BrokerId[]);
          if (s[id].open) s[id].scrip += askFor(BROKERS[id].sells[0], 2, s[id].stance);
        }
      }
      for (const id of Object.keys(s) as BrokerId[]) {
        const b = s[id];
        if (b.open) {
          for (const c of BROKERS[id].buys) {
            const over = (b.stock[c] ?? 0) - (ITEMS[c].target ?? 0);
            if (over > 0 && r() < 0.3) {
              const earned = over * (ITEMS[c].export ?? 0);
              b.scrip += earned - Math.floor(earned / 10);
              b.stock[c] = ITEMS[c].target;
            }
          }
          b.calm = Math.max(0, (b.calm ?? 0) - 1);
          // Other trade the fake doesn't model (gear, dock fees, the freighter contract), as a steady trickle.
          b.scrip += SIDE_INCOME[id];
          // Policies: Moss leans on her copper pile, Ines pinches when cash is low, the Quartermaster overpays
          // (the trap) except for a day after investors bail him out.
          if (id === "moss") b.stance = Math.max(80, Math.min(110, 100 - Math.floor(((b.stock.copper ?? 0) - 12) / 2)));
          if (id === "ines") b.stance = b.scrip < 700 ? 84 : 94;
          if (id === "qm") b.stance = b.calm ? 92 : 120;
        } else {
          b.shut++;
          if (b.shut > 10 && r() < 0.2) {
            b.scrip += 250 + Math.floor(r() * 450);
            if (b.scrip >= FLOAT_REOPEN) (b.open = true), (b.calm = 40);
          }
        }
        // The town uses a little of what a broker holds below target, so stock can dip and bids climb again.
        for (const c of BROKERS[id].buys) if ((b.stock[c] ?? 0) > 1 && r() < 0.05) b.stock[c] = (b.stock[c] ?? 0) - 1;
      }
      points.push(snap(hour));
    }
    return points;
  }

  // ---- the Chain ----
  let timer: ReturnType<typeof setInterval> | null = null;
  const chain: FakeChain = {
    network: "mock",
    contractId: "saltline.fake",
    txUrl: (hash) => (opts.txUrl ? opts.txUrl(hash) : null),
    failing,
    state: { brokers, player },
    tick,
    start(everyMs = 3500) {
      if (!timer) timer = setInterval(tick, everyMs);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },

    profile: (id) =>
      view("profile", (): Profile | null => {
        const t = id === player.accountId ? (player.registered ? player : null) : traders.find((x) => x.accountId === id);
        if (!t) return null;
        return { accountId: t.accountId, callsign: t.callsign, registeredAt: ago(60 * 24 * 3), runs: 6, extractions: 4, deaths: 2, bestHaul: t.bestHaul };
      }),
    balances: (id) =>
      view("balances", (): Amounts => {
        const t = id === player.accountId ? player : traders.find((x) => x.accountId === id);
        return Object.fromEntries(Object.entries(t?.hold ?? {}).filter(([, v]) => (v ?? 0) > 0));
      }),
    brokers: () =>
      view("brokers", (): BrokerView[] =>
        (Object.keys(brokers) as BrokerId[]).map((id) => {
          const b = brokers[id];
          return {
            id,
            accountId: `${id}.saltline.fake`,
            name: name(id),
            open: b.open,
            scrip: b.scrip,
            stance: b.stance,
            stock: { ...b.stock },
            ...quotes(b),
            shares: [...b.shares].map(([accountId, x]) => ({ accountId, callsign: x.callsign, shares: x.shares })),
            lastMemo: b.memo,
          };
        }),
      ),
    wrecks: () => view("wrecks", () => []),
    listings: () => view("listings", () => listings.map((l) => ({ ...l }))),
    recent: (limit) => view("recent", () => ledger.slice(0, limit).map((e) => ({ ...e }))),
    leaderboard: () =>
      view("leaderboard", (): Leaderboard => {
        const all = player.registered ? [...traders, player] : traders;
        const rows = (f: (t: Trader) => number) =>
          all
            .map((t) => ({ accountId: t.accountId, callsign: t.callsign, value: f(t) }))
            .filter((x) => x.value > 0)
            .sort((a, b) => b.value - a.value)
            .slice(0, 10);
        return { netWorth: rows(worth), bestHaul: rows((t) => t.bestHaul), investors: rows((t) => t.invested) };
      }),
    simulate: (hours, n, seed) => view("simulate", () => simulate(Math.min(168, hours), Math.min(30, n), seed)),

    startRun: (gear) =>
      call("startRun", () => {
        for (const g of gear) if (bal(player, g) < 1) return refuse<TxResult>("Equipping gear you don't have");
        for (const g of gear) add(player, g, -1);
        return { ok: true };
      }),
    extract: () => call("extract", () => refuse<TxResult>("No run on the fake chain")),
    die: () => call("die", () => refuse<TxResult>("No run on the fake chain")),
    sell: (b, c, n) => call("sell", () => (player.registered ? doSell(player, b, c, n) : refuse("Not registered"))),
    buy: (b, g, n) => call("buy", () => (player.registered ? doBuy(player, b, g, n) : refuse("Not registered"))),
    invest: (b, n) => call("invest", () => (player.registered ? doInvest(player, b, n) : refuse("Not registered"))),
    list: (tokenId, amount, price) =>
      call("list", (): TxResult & { id?: number } => {
        if (!Number.isInteger(amount) || amount <= 0 || !Number.isInteger(price) || price <= 0) return refuse("Zero or too large");
        if (bal(player, tokenId) < amount) return refuse("Not enough scrip or items");
        add(player, tokenId, -amount);
        const id = nextListing++;
        listings.push({ id, seller: player.accountId, callsign: player.callsign, tokenId, amount, price, at: now() });
        log("listing", player.accountId, player.callsign, `${player.callsign} listed ${tokenId.toUpperCase()} ×${amount} at ${price}`);
        return { ok: true, id };
      }),
    buyListing: (id) =>
      call("buyListing", (): TxResult => {
        const i = listings.findIndex((l) => l.id === id);
        if (i < 0) return refuse("No such listing");
        const l = listings[i];
        const cost = l.amount * l.price;
        if (bal(player, "scrip") < cost) return refuse("Not enough scrip");
        add(player, "scrip", -cost);
        add(player, l.tokenId, l.amount);
        listings.splice(i, 1);
        log("purchase", player.accountId, player.callsign, `${player.callsign} bought ${l.tokenId.toUpperCase()} ×${l.amount} from ${l.callsign} for ${cost}`);
        return { ok: true };
      }),
    cancelListing: (id) =>
      call("cancelListing", (): TxResult => {
        const i = listings.findIndex((l) => l.id === id && l.seller === player.accountId);
        if (i < 0) return refuse("No such listing");
        add(player, listings[i].tokenId, listings[i].amount);
        listings.splice(i, 1);
        return { ok: true };
      }),

    wallet: {
      kind: "mock",
      accountId: () => player.accountId,
      registered: async () => {
        await wait(latency / 3);
        fail("registered");
        return player.registered;
      },
      claim: async (raw) => {
        await wait(latency * 1.4);
        fail("claim");
        const c = checkCallsign(raw);
        if (!c.ok) return { ok: false, error: "Bad callsign" };
        if (player.registered) return { ok: false, error: "Already registered" };
        if (NPC.includes(c.callsign)) return { ok: false, error: "Callsign taken" };
        register(c.callsign);
        log("extract", player.accountId, c.callsign, `${c.callsign} signed on at Berth 4 with ${RULES.starterScrip} scrip`);
        return { ok: true, txHash: b58() };
      },
    },
  };
  return chain;
}

export type FakeEconomy = Economy & { chain: FakeChain };

export function createFakeEconomy(opts: FakeOptions = {}): FakeEconomy {
  const chain = createFakeChain(opts);
  return { chain, wallet: chain.wallet, manifest: null, carried: {}, equipped: [] };
}
