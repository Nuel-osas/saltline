// =====================================================================================================================
// THE OFFLINE MOCK. An in-memory stand-in for the game contract, for tests and for playing without a network.
//
// It is NOT the authority. The contract (contract/src/*.rs) is; where this file and the contract disagree, the
// contract is right and this file gets fixed. It follows docs/ECONOMY.md and docs/CONTRACT_API.md, and the places
// where those left a choice open are marked "mock's reading" so the parity check can find them.
// =====================================================================================================================
import { BROKERS, CARGO, GEAR, ITEMS, RULES } from "./items";
import type {
  Amounts,
  BrokerId,
  BrokerView,
  CargoId,
  GearId,
  LedgerEvent,
  LedgerKind,
  Leaderboard,
  LeaderRow,
  Listing,
  Manifest,
  ManifestEntry,
  Profile,
  Quote,
  SimBroker,
  SimPoint,
  TokenId,
  Wallet,
  WreckView,
} from "./types";
import type { CallResult, DetailedChain } from "./chain";
import { normalizeCallsign } from "./wallet";

export const MOCK_STORAGE_KEY = "saltline.mock.v1";
export const MOCK_CONTRACT = "saltline.mock";

/** The economy's numbers that items.ts doesn't carry (docs/ECONOMY.md → Pricing rules). */
export const MARKET = {
  float: 100,
  reopenAt: 400,
  dividendPct: 10,
  exportCooldownMs: 3_600_000,
  recentHalfLifeMs: 6 * 3_600_000,
  betweenRunsMs: 30_000,
  maxWrecks: 24,
  maxRecent: 64,
  brokerSeedScrip: 1500,
  seedStockPct: 75,
  stanceMin: 80,
  stanceMax: 120,
  maxAmount: 10_000,
  maxSimHours: 168,
  maxSimTraders: 30,
} as const;

const BROKER_IDS: BrokerId[] = ["moss", "ines", "qm"];
const HOUR = 3_600_000;
/** The finder's share of a recovered wreck as a whole percentage, so the split is integer maths. */
const FINDER_PCT = Math.round(RULES.finderShare * 100);
/** Simulated and ambient players won't sell below this share of base. */
const HOLD_OUT = 0.4;

// ---------------------------------------------------------------------------------------------------------------
// Words

const NOUN: Record<TokenId, [string, string]> = {
  scrip: ["scrip", "scrip"],
  copper: ["coil", "coils"],
  meds: ["crate of meds", "crates of meds"],
  chips: ["box of electronics", "boxes of electronics"],
  fuel: ["fuel cell", "fuel cells"],
  core: ["relay core", "relay cores"],
  plate: ["armour plate", "armour plates"],
  mag: ["extended mag", "extended mags"],
  cutter: ["seal cutter", "seal cutters"],
};

/** "1 coil", "34 coils". */
export const units = (t: TokenId, n: number) => `${n} ${NOUN[t][n === 1 ? 0 : 1]}`;

const joinList = (parts: string[]) =>
  parts.length <= 1 ? (parts[0] ?? "") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;

const describe = (items: Amounts<CargoId>) =>
  joinList(CARGO.filter((c) => (items[c] ?? 0) > 0).map((c) => units(c, items[c]!))) || "nothing";

const PRONOUN: Record<BrokerId, string> = { moss: "she", ines: "she", qm: "he" };
const EXPORT_FLAVOUR: Record<BrokerId, string> = {
  moss: "Shelves can't take more.",
  ines: "Cold store's full.",
  qm: "The client wants it moving.",
};

// ---------------------------------------------------------------------------------------------------------------
// Pricing (mirrors contract/src/pricing.rs; integer maths, evaluated left to right as ECONOMY.md writes it)

/** bid = base × 2 × target / (target + stock) × stance / 100 */
export function bidPrice(c: CargoId, stock: number, stance: number): number {
  const base = ITEMS[c].base;
  const target = ITEMS[c].target!;
  return Math.floor((Math.floor((base * 2 * target) / (target + stock)) * stance) / 100);
}

/** ask = base × (100 + recent_sales) / 100 × stance / 100 */
export function askPrice(g: GearId, recentSales: number, stance: number): number {
  const base = ITEMS[g].base;
  return Math.floor((Math.floor((base * (100 + recentSales)) / 100) * stance) / 100);
}

/** What n units fetch, priced one at a time with stock rising between them. */
export function batchBid(c: CargoId, stock: number, stance: number, n: number): number {
  let total = 0;
  for (let i = 0; i < n; i++) total += bidPrice(c, stock + i, stance);
  return total;
}

export function batchAsk(g: GearId, recentSales: number, stance: number, n: number): number {
  let total = 0;
  for (let i = 0; i < n; i++) total += askPrice(g, recentSales + i, stance);
  return total;
}

function stanceNote(stance: number) {
  if (stance > 100) return ` Stance ${stance}: keen.`;
  if (stance < 100) return ` Stance ${stance}: tight-fisted.`;
  return "";
}

export function bidReason(b: { name: string; open: boolean; scrip: number; stance: number }, c: CargoId, stock: number): string {
  if (!b.open) return `Shut until someone invests. ${b.scrip} in the till, ${MARKET.reopenAt} to reopen.`;
  const target = ITEMS[c].target!;
  const base = ITEMS[c].base;
  const ratio = bidPrice(c, stock, 100) / base;
  const head =
    stock === 0
      ? `No ${NOUN[c][1]} on the shelf against a target of ${target}.`
      : stock < target
        ? `Holding ${units(c, stock)} against a target of ${target}.`
        : stock === target
          ? `Holding ${units(c, stock)}, right on target.`
          : `Sitting on ${units(c, stock)} against a target of ${target}.`;
  const pay =
    ratio >= 1.75
      ? "Paying double."
      : ratio >= 1.3
        ? "Paying well over base."
        : ratio > 1.02
          ? "Paying over base."
          : ratio >= 0.98
            ? "Paying base."
            : ratio >= 0.7
              ? "Paying under base."
              : ratio >= 0.45
                ? "Paying half."
                : "Paying scraps.";
  return `${head} ${pay}${stanceNote(b.stance)}`;
}

export function askReason(b: { open: boolean; stance: number }, g: GearId, recentSales: number): string {
  if (!b.open) return "Shut. Nothing leaves the rack until someone invests.";
  const head =
    recentSales === 0
      ? `${NOUN[g][1][0].toUpperCase()}${NOUN[g][1].slice(1)} on the rack, nobody buying. List price.`
      : `Sold ${units(g, recentSales)} in the last few hours. Up ${recentSales}%.`;
  return head + stanceNote(b.stance);
}

// ---------------------------------------------------------------------------------------------------------------
// State

interface RecentSales {
  /** Units × 1000, decayed to `at`. */
  milli: number;
  at: number;
}

export interface BrokerState {
  id: BrokerId;
  accountId: string;
  name: string;
  open: boolean;
  scrip: number;
  stance: number;
  stock: Amounts<CargoId>;
  recent: Partial<Record<GearId, RecentSales>>;
  /** Shares by account id; one share per scrip invested. */
  shares: Record<string, number>;
  lastMemo: string | null;
  lastExport: Partial<Record<CargoId, number>>;
  lastStanceAt: number;
}

interface AccountState {
  accountId: string;
  callsign: string;
  registeredAt: number;
  runs: number;
  extractions: number;
  deaths: number;
  bestHaul: number;
  activeRun: number | null;
  lastRunAt: number | null;
  balances: Amounts;
  npc: boolean;
}

interface RunState {
  id: number;
  player: string;
  startedAt: number;
  containers: ManifestEntry[];
  wrecks: WreckView[];
  closed: boolean;
}

export interface MockState {
  v: 1;
  seed: number;
  /** The PRNG's state (mulberry32), so ambient play replays exactly from a saved state. */
  rng: number;
  me: string;
  accounts: Record<string, AccountState>;
  brokers: Record<BrokerId, BrokerState>;
  runs: Record<string, RunState>;
  wrecks: WreckView[];
  listings: Listing[];
  recent: LedgerEvent[];
  nextRun: number;
  nextWreck: number;
  nextListing: number;
  nextTx: number;
}

type Rng = { rng: number };

function rand(r: Rng): number {
  let t = (r.rng = (r.rng + 0x6d2b79f5) >>> 0);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

const pickOne = <T>(r: Rng, xs: readonly T[]): T => xs[Math.floor(rand(r) * xs.length)];

function shuffle<T>(r: Rng, xs: T[]): T[] {
  for (let i = xs.length - 1; i > 0; i--) {
    const j = Math.floor(rand(r) * (i + 1));
    [xs[i], xs[j]] = [xs[j], xs[i]];
  }
  return xs;
}

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

/** The mock's loot table (mock's reading: the contract's spot tables decide on chain). */
const LOOT: { c: CargoId; w: number; min: number; max: number }[] = [
  { c: "copper", w: 30, min: 1, max: 3 },
  { c: "chips", w: 24, min: 1, max: 2 },
  { c: "meds", w: 20, min: 1, max: 2 },
  { c: "fuel", w: 16, min: 1, max: 1 },
  { c: "core", w: 10, min: 1, max: 1 },
];

function lootDraw(r: Rng): { c: CargoId; n: number } {
  let roll = rand(r) * LOOT.reduce((s, l) => s + l.w, 0);
  for (const l of LOOT) {
    if ((roll -= l.w) < 0) return { c: l.c, n: l.min + Math.floor(rand(r) * (l.max - l.min + 1)) };
  }
  return { c: "copper", n: 1 };
}

const NPCS: [string, string][] = [
  ["gull.mock", "GULL"],
  ["kestrel-9.mock", "KESTREL-9"],
  ["low-tide.mock", "LOW TIDE"],
  ["dock-rat.mock", "DOCK.RAT"],
  ["bosun-k.mock", "BOSUN_K"],
  ["halyard.mock", "HALYARD"],
  ["sprat.mock", "SPRAT"],
  ["tin-can.mock", "TIN CAN"],
  ["marlow.mock", "MARLOW"],
  ["old-salt.mock", "OLD SALT"],
];

function freshBroker(id: BrokerId, now: number): BrokerState {
  const stock: Amounts<CargoId> = {};
  for (const c of BROKERS[id].buys) stock[c] = Math.floor((ITEMS[c].target! * MARKET.seedStockPct) / 100);
  return {
    id,
    accountId: `${id}.${MOCK_CONTRACT}`,
    name: BROKERS[id].name,
    open: true,
    scrip: MARKET.brokerSeedScrip,
    stance: 100,
    stock,
    recent: {},
    shares: {},
    lastMemo: null,
    lastExport: {},
    lastStanceAt: now - HOUR,
  };
}

function freshState(seed: number, now: number): MockState {
  const r: Rng = { rng: (seed * 2654435761) >>> 0 || 1 };
  let me = "";
  for (let i = 0; i < 8; i++) me += Math.floor(rand(r) * 2 ** 32).toString(16).padStart(8, "0");
  const accounts: Record<string, AccountState> = {};
  for (const [accountId, callsign] of NPCS) {
    const balances: Amounts = { scrip: RULES.starterScrip };
    const d = lootDraw(r);
    balances[d.c] = d.n;
    accounts[accountId] = {
      accountId,
      callsign,
      registeredAt: now - Math.floor(rand(r) * 72 * HOUR),
      runs: 0,
      extractions: 0,
      deaths: 0,
      bestHaul: 0,
      activeRun: null,
      lastRunAt: null,
      balances,
      npc: true,
    };
  }
  return {
    v: 1,
    seed,
    rng: r.rng,
    me,
    accounts,
    brokers: { moss: freshBroker("moss", now), ines: freshBroker("ines", now), qm: freshBroker("qm", now) },
    runs: {},
    wrecks: [],
    listings: [],
    recent: [],
    nextRun: 1,
    nextWreck: 1,
    nextListing: 1,
    nextTx: 0,
  };
}

function validState(s: unknown): s is MockState {
  const m = s as MockState;
  return !!m && m.v === 1 && typeof m.me === "string" && !!m.accounts && BROKER_IDS.every((id) => !!m.brokers?.[id]) && Array.isArray(m.recent);
}

// ---------------------------------------------------------------------------------------------------------------
// Refusals: the contract's `E_CODE: message` panics

class Refusal extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const refuse = (code: string, message: string): never => {
  throw new Refusal(code, message);
};

const isWhole = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;

function amountOk(n: unknown): number {
  if (!isWhole(n) || n === 0 || n > MARKET.maxAmount) refuse("E_BAD_AMOUNT", "Zero or too large.");
  return n as number;
}

// ---------------------------------------------------------------------------------------------------------------
// Broker rules, shared by play, ambient and simulate

function recentUnits(b: BrokerState, g: GearId, now: number): number {
  const r = b.recent[g];
  if (!r) return 0;
  const decayed = r.milli * 0.5 ** (Math.max(0, now - r.at) / MARKET.recentHalfLifeMs);
  return Math.floor(decayed / 1000);
}

function addRecent(b: BrokerState, g: GearId, n: number, now: number) {
  const r = b.recent[g];
  const decayed = r ? r.milli * 0.5 ** (Math.max(0, now - r.at) / MARKET.recentHalfLifeMs) : 0;
  b.recent[g] = { milli: decayed + n * 1000, at: now };
}

/**
 * Mock's reading of "a broker below the float is closed": a sale that would take the till below the float is
 * refused, and a broker whose till can't stay above the float for even one more unit of anything it buys shuts.
 * (Read literally, the doc's two rules leave no way to close; see the lane report.)
 */
function cantBuyAnything(b: BrokerState): boolean {
  return BROKERS[b.id].buys.every((c) => b.scrip - bidPrice(c, b.stock[c] ?? 0, b.stance) < MARKET.float);
}

/** The broker takes n units of cargo. Returns what it pays. */
function brokerTakes(b: BrokerState, c: CargoId, n: number): number {
  if (!BROKERS[b.id].buys.includes(c)) refuse("E_DOESNT_BUY", `${b.name} doesn't deal in ${NOUN[c][1]}.`);
  if (!b.open) refuse("E_BROKER_CLOSED", `${b.name} is shut until someone invests.`);
  const total = batchBid(c, b.stock[c] ?? 0, b.stance, n);
  if (b.scrip - total < MARKET.float) {
    refuse("E_BROKER_BROKE", `${b.name} can't cover ${units(c, n)} without dropping below ${PRONOUN[b.id] === "he" ? "his" : "her"} float.`);
  }
  b.scrip -= total;
  b.stock[c] = (b.stock[c] ?? 0) + n;
  return total;
}

/** The broker sells n units of gear. Returns the cost. */
function brokerGearCost(b: BrokerState, g: GearId, n: number, now: number): number {
  if (!BROKERS[b.id].sells.includes(g)) refuse("E_DOESNT_SELL", `${b.name} doesn't stock ${NOUN[g][1]}.`);
  if (!b.open) refuse("E_BROKER_CLOSED", `${b.name} is shut until someone invests.`);
  return batchAsk(g, recentUnits(b, g, now), b.stance, n);
}

/** Ships stock to the freighter. Returns what was minted and who gets the dividend. */
function brokerShip(b: BrokerState, c: CargoId, n: number, now: number): { earned: number; payouts: [string, number][] } {
  if (!BROKERS[b.id].buys.includes(c)) refuse("E_EXPORT_STOCK", `${b.name} holds no ${NOUN[c][1]}.`);
  if (n > (b.stock[c] ?? 0)) refuse("E_EXPORT_STOCK", `${b.name} only holds ${units(c, b.stock[c] ?? 0)}.`);
  const last = b.lastExport[c];
  if (last !== undefined && now - last < MARKET.exportCooldownMs) refuse("E_EXPORT_COOLDOWN", "The freighter took a load within the hour.");
  const earned = n * ITEMS[c].export!;
  const pool = Math.floor((earned * MARKET.dividendPct) / 100);
  const total = Object.values(b.shares).reduce((s, x) => s + x, 0);
  // Mock's reading: with no shareholders there is no dividend; each holder's cut rounds down and the dust stays.
  const payouts: [string, number][] =
    total > 0 ? Object.entries(b.shares).map(([a, s]): [string, number] => [a, Math.floor((pool * s) / total)]).filter(([, x]) => x > 0) : [];
  const paid = payouts.reduce((s, [, x]) => s + x, 0);
  b.stock[c] = (b.stock[c] ?? 0) - n;
  b.scrip += earned - paid;
  b.lastExport[c] = now;
  return { earned, payouts };
}

export interface Advice {
  action: "none" | "export" | "stance";
  tokenId?: CargoId;
  amount?: number;
  stance?: number;
  memo: string;
}

/** The default broker policy (the contract's `advice` view, used by the agent runner). */
function policy(b: BrokerState, now: number): Advice {
  // The fullest shelf ships first; each cargo has its own hourly slot with the freighter.
  const byGlut = [...BROKERS[b.id].buys].sort(
    (x, y) => ((b.stock[y] ?? 0) - ITEMS[y].target!) / ITEMS[y].target! - ((b.stock[x] ?? 0) - ITEMS[x].target!) / ITEMS[x].target!,
  );
  for (const c of byGlut) {
    const surplus = (b.stock[c] ?? 0) - ITEMS[c].target!;
    const last = b.lastExport[c];
    if (surplus > 0 && (last === undefined || now - last >= MARKET.exportCooldownMs)) {
      return { action: "export", tokenId: c, amount: surplus, memo: `Shipping ${units(c, surplus)} to the freighter. ${EXPORT_FLAVOUR[b.id]}` };
    }
  }
  const lowShelves = BROKERS[b.id].buys.some((c) => (b.stock[c] ?? 0) < ITEMS[c].target! / 2);
  if (b.scrip < 500 && b.stance > MARKET.stanceMin) {
    return { action: "stance", stance: b.stance - 10, memo: "Till's running thin. Tightening up." };
  }
  if (b.scrip > 2500 && lowShelves && b.stance < MARKET.stanceMax) {
    return { action: "stance", stance: b.stance + 10, memo: "Cash to spare and bare shelves. Bidding up." };
  }
  if (b.stance !== 100 && b.scrip >= 900 && b.scrip <= 2500) {
    return { action: "stance", stance: b.stance + (b.stance < 100 ? 10 : -10), memo: "Back to standard terms." };
  }
  return { action: "none", memo: "Holding steady." };
}

function quotes(b: BrokerState, now: number): { bids: Quote[]; asks: Quote[] } {
  return {
    bids: BROKERS[b.id].buys.map((c) => ({ tokenId: c, price: bidPrice(c, b.stock[c] ?? 0, b.stance), reason: bidReason(b, c, b.stock[c] ?? 0) })),
    asks: BROKERS[b.id].sells.map((g) => {
      const r = recentUnits(b, g, now);
      return { tokenId: g, price: askPrice(g, r, b.stance), reason: askReason(b, g, r) };
    }),
  };
}

/** The best single-unit bid for a cargo across all brokers (what net worth and haul value use). */
function bestBid(brokers: Record<BrokerId, BrokerState>, c: CargoId): number {
  let best = 0;
  for (const id of BROKER_IDS) {
    const b = brokers[id];
    if (BROKERS[id].buys.includes(c)) best = Math.max(best, bidPrice(c, b.stock[c] ?? 0, b.stance));
  }
  return best;
}

// ---------------------------------------------------------------------------------------------------------------
// The mock chain

export interface MockChain extends DetailedChain {
  readonly network: "mock";
  /** The local player's account id (what the mock wallet signs as). */
  me(): string;
  isRegistered(accountId: string): boolean;
  /** The faucet's call: creates the profile and mints the starter scrip. */
  register(accountId: string, callsign: string): Promise<CallResult & { profile?: Profile }>;
  manifest(runId: number): Promise<Manifest | null>;
  advice(broker: BrokerId): Advice;
  /** Calls made as the broker's own account (the agent runner's, on chain). */
  brokerExport(broker: BrokerId, tokenId: CargoId, amount: number, memo: string): Promise<CallResult & { earned?: number; dividend?: number }>;
  brokerStance(broker: BrokerId, stance: number, memo: string): Promise<CallResult>;
  /** Other players selling, hauling, dying and investing, plus the broker policy, over `seconds` of play. */
  ambient(seconds: number): void;
  /** Wipes the saved mock and starts again from the seed. */
  reset(): void;
  /** A copy of the whole state, for tests and the debug console. */
  snapshot(): MockState;
}

export interface MockOptions {
  /** Where to persist; null for none. Defaults to localStorage when there is one. */
  storage?: Storage | null;
  now?: () => number;
  /** Seconds of ambient play to run when the state is brand new, so the Dockside isn't empty. */
  warmupSeconds?: number;
}

function defaultStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function createMockChain(seed = 1, opts: MockOptions = {}): MockChain {
  const now = opts.now ?? Date.now;
  const storage = opts.storage === undefined ? defaultStorage() : opts.storage;

  function load(): MockState | null {
    if (!storage) return null;
    try {
      const raw = storage.getItem(MOCK_STORAGE_KEY);
      if (!raw) return null;
      const s = JSON.parse(raw);
      return validState(s) ? s : null;
    } catch {
      return null;
    }
  }

  let state = load();
  const fresh = !state;
  if (!state) state = freshState(seed, now());
  let S: MockState = state;

  function save() {
    if (!storage) return;
    try {
      // Closed runs are only kept for a while; open ones stay.
      const runs = Object.values(S.runs).sort((a, b) => b.id - a.id);
      for (const r of runs.slice(30)) if (r.closed) delete S.runs[r.id];
      storage.setItem(MOCK_STORAGE_KEY, JSON.stringify(S));
    } catch (e) {
      console.warn("[economy] mock state not saved:", e);
    }
  }

  const txHash = () => `mock-${String(++S.nextTx).padStart(6, "0")}`;

  function log(kind: LedgerKind, account: string, text: string) {
    const callsign = S.accounts[account]?.callsign ?? BROKER_IDS.map((id) => S.brokers[id]).find((b) => b.accountId === account)?.name;
    const e: LedgerEvent = { kind, at: now(), account, text };
    if (callsign) e.callsign = callsign;
    S.recent.unshift(e);
    if (S.recent.length > MARKET.maxRecent) S.recent.length = MARKET.maxRecent;
  }

  const bal = (a: AccountState, t: TokenId) => a.balances[t] ?? 0;
  function credit(accountId: string, t: TokenId, n: number) {
    const a = S.accounts[accountId];
    if (!a || n <= 0) return;
    a.balances[t] = bal(a, t) + n;
  }
  function debit(a: AccountState, t: TokenId, n: number) {
    const left = bal(a, t) - n;
    if (left < 0) refuse("E_FUNDS", "Not enough.");
    if (left === 0) delete a.balances[t];
    else a.balances[t] = left;
  }

  function player(accountId: string): AccountState {
    const a = S.accounts[accountId];
    if (!a) refuse("E_NOT_REGISTERED", "No dock pass. Claim one first.");
    return a as AccountState;
  }

  function broker(id: BrokerId): BrokerState {
    const b = S.brokers[id];
    if (!b) refuse("E_NOT_BROKER", `No broker called ${String(id)} on this dock.`);
    return b;
  }

  function closeCheck(b: BrokerState) {
    if (b.open && cantBuyAnything(b)) {
      b.open = false;
      log("close", b.accountId, `${b.name} is shut. ${b.scrip} in the till, under the float.`);
    }
  }
  function reopenCheck(b: BrokerState): boolean {
    if (!b.open && b.scrip >= MARKET.reopenAt) {
      b.open = true;
      log("reopen", b.accountId, `${b.name} is open again. ${b.scrip} in the till.`);
      return true;
    }
    return false;
  }

  /** Runs one state change; a refusal leaves the state as it was. */
  function tx<T extends object>(fn: () => T): CallResult & Partial<T> {
    const before = JSON.stringify(S);
    try {
      const out = fn();
      save();
      return { ok: true, txHash: txHash(), ...out };
    } catch (e) {
      S = JSON.parse(before) as MockState;
      if (e instanceof Refusal) return { ok: false, error: e.message, code: e.code } as CallResult & Partial<T>;
      console.warn("[economy] mock error:", e);
      return { ok: false, error: "Something went wrong at the dock. Try again." } as CallResult & Partial<T>;
    }
  }

  // --- the rules, with an explicit actor and time so ambient players use exactly the same ones

  function doRegister(accountId: string, callsign: string): Profile {
    const cs = normalizeCallsign(callsign);
    if (!cs) refuse("E_BAD_CALLSIGN", "Callsigns are 3–16 letters, digits, spaces, dashes, dots or underscores.");
    if (S.accounts[accountId]) refuse("E_ALREADY_REGISTERED", "Already on the dock roll.");
    if (Object.values(S.accounts).some((a) => a.callsign === cs)) refuse("E_CALLSIGN_TAKEN", "Someone's already working under that callsign.");
    const at = now();
    S.accounts[accountId] = {
      accountId,
      callsign: cs as string,
      registeredAt: at,
      runs: 0,
      extractions: 0,
      deaths: 0,
      bestHaul: 0,
      activeRun: null,
      lastRunAt: null,
      balances: { scrip: RULES.starterScrip },
      npc: false,
    };
    return profileOf(S.accounts[accountId]);
  }

  function doStartRun(actor: string, gear: GearId[], at: number): Manifest {
    const a = player(actor);
    if (!Array.isArray(gear)) refuse("E_NO_GEAR", "Bad gear list.");
    if (new Set(gear).size !== gear.length) refuse("E_DUPLICATE", "Same gear listed twice.");
    for (const g of gear) {
      if (!GEAR.includes(g)) refuse("E_NO_GEAR", `${String(g)} isn't gear.`);
      if (bal(a, g) < 1) refuse("E_NO_GEAR", `You don't have ${/^[aeiou]/.test(NOUN[g][0]) ? "an" : "a"} ${NOUN[g][0]} to equip.`);
    }
    if (a.lastRunAt !== null && at - a.lastRunAt < MARKET.betweenRunsMs) {
      refuse("E_TOO_SOON", `Too soon. Wait ${Math.ceil((MARKET.betweenRunsMs - (at - a.lastRunAt)) / 1000)} s between runs.`);
    }
    // One run at a time: a new one abandons the old, and the old run's cargo is lost.
    if (a.activeRun !== null && S.runs[a.activeRun]) S.runs[a.activeRun].closed = true;
    for (const g of gear) debit(a, g, 1);
    const r: Rng = S;
    const spots = shuffle(r, Array.from({ length: RULES.spotCount }, (_, i) => i))
      .slice(0, RULES.containersPerRun)
      .sort((x, y) => x - y);
    const containers = spots.map((spot) => {
      const d = lootDraw(r);
      return { spot, tokenId: d.c, amount: d.n };
    });
    // Mock's reading: the newest wrecks left by other players.
    const wrecks = clone(S.wrecks.filter((w) => w.owner !== actor).slice(0, RULES.wrecksPerRun));
    const run: RunState = { id: S.nextRun++, player: actor, startedAt: at, containers, wrecks, closed: false };
    S.runs[run.id] = run;
    a.runs++;
    a.lastRunAt = at;
    a.activeRun = run.id;
    log("run_start", actor, gear.length ? `${a.callsign} went into the yard with ${joinList(gear.map((g) => NOUN[g][0]))}.` : `${a.callsign} went into the yard.`);
    return manifestOf(run);
  }

  /** The checks extract and die share. Returns the cargo the player is carrying. */
  function carried(actor: string, runId: number, opened: number[], wreckIds: number[]): { run: RunState; boxes: ManifestEntry[]; wrecks: WreckView[] } {
    const run = isWhole(runId) ? S.runs[runId] : undefined;
    if (!run || run.player !== actor) refuse("E_NO_RUN", "No such run.");
    const r = run as RunState;
    if (r.closed) refuse("E_RUN_CLOSED", "That run's already closed.");
    if (!Array.isArray(opened) || !Array.isArray(wreckIds)) refuse("E_NOT_IN_MANIFEST", "Bad manifest list.");
    if (new Set(opened).size !== opened.length || new Set(wreckIds).size !== wreckIds.length) refuse("E_DUPLICATE", "Same container listed twice.");
    const boxes = opened.map((spot) => r.containers.find((c) => c.spot === spot) ?? refuse("E_NOT_IN_MANIFEST", `Spot ${spot} wasn't on this run's manifest.`));
    const wrecks = wreckIds.map((id) => r.wrecks.find((w) => w.id === id) ?? refuse("E_NOT_IN_MANIFEST", `Wreck ${id} wasn't on this run's manifest.`));
    const weight =
      boxes.reduce((s, c) => s + c.amount * ITEMS[c.tokenId].weight, 0) +
      wrecks.reduce((s, w) => s + w.items.reduce((t, i) => t + i.amount * ITEMS[i.tokenId].weight, 0), 0);
    if (weight > RULES.carryLimit) refuse("E_OVER_LIMIT", `That's ${weight} weight. The limit is ${RULES.carryLimit}.`);
    return { run: r, boxes, wrecks };
  }

  function doExtract(actor: string, runId: number, opened: number[], wreckIds: number[], at: number) {
    const a = player(actor);
    const { run, boxes, wrecks } = carried(actor, runId, opened, wreckIds);
    const minimum = (RULES.minRunSeconds + RULES.perContainerSeconds * opened.length) * 1000;
    if (at - run.startedAt < minimum) {
      refuse("E_TOO_SOON", `Too fast. A run with ${opened.length} container${opened.length === 1 ? "" : "s"} takes at least ${minimum / 1000} s.`);
    }
    const minted: Amounts<CargoId> = {};
    const add = (c: CargoId, n: number) => {
      if (n > 0) minted[c] = (minted[c] ?? 0) + n;
    };
    for (const b of boxes) add(b.tokenId, b.amount);
    const notes: string[] = [];
    for (const w of wrecks) {
      // Mock's reading: a wreck someone else recovered first yields nothing; the rest of the haul still counts.
      const live = S.wrecks.findIndex((x) => x.id === w.id);
      if (live < 0) continue;
      const wreck = S.wrecks[live];
      S.wrecks.splice(live, 1);
      const home: Amounts<CargoId> = {};
      for (const i of wreck.items) {
        // The finder's share rounds half up (docs/ECONOMY.md → Runs on-chain): 1 → 1/0, 2 → 1/1, 3 → 2/1, 6 → 4/2.
        const finder = Math.floor((i.amount * FINDER_PCT + 50) / 100);
        add(i.tokenId, finder);
        home[i.tokenId] = (home[i.tokenId] ?? 0) + (i.amount - finder);
        credit(wreck.owner, i.tokenId, i.amount - finder);
      }
      notes.push(`recovered ${wreck.callsign}'s wreck and sent ${describe(home)} home`);
    }
    for (const c of CARGO) credit(actor, c, minted[c] ?? 0);
    run.closed = true;
    a.activeRun = null;
    a.extractions++;
    const haulValue = CARGO.reduce((s, c) => s + (minted[c] ?? 0) * bestBid(S.brokers, c), 0);
    a.bestHaul = Math.max(a.bestHaul, haulValue);
    log("extract", actor, `${a.callsign} made the boat with ${describe(minted)}${notes.length ? `, and ${joinList(notes)}` : ""}.`);
    return { minted, haulValue };
  }

  function doDie(actor: string, runId: number, opened: number[], wreckIds: number[], spot: number) {
    const a = player(actor);
    const { run, boxes, wrecks } = carried(actor, runId, opened, wreckIds);
    if (!isWhole(spot) || spot >= RULES.spotCount) refuse("E_BAD_AMOUNT", `No salvage spot ${spot} in this yard.`);
    const items: Amounts<CargoId> = {};
    for (const b of boxes) items[b.tokenId] = (items[b.tokenId] ?? 0) + b.amount;
    // Mock's reading: a recovered wreck you were carrying goes down with you, into your wreck.
    for (const w of wrecks) {
      const live = S.wrecks.findIndex((x) => x.id === w.id);
      if (live < 0) continue;
      for (const i of S.wrecks[live].items) items[i.tokenId] = (items[i.tokenId] ?? 0) + i.amount;
      S.wrecks.splice(live, 1);
    }
    run.closed = true;
    a.activeRun = null;
    a.deaths++;
    const list = CARGO.filter((c) => (items[c] ?? 0) > 0).map((c) => ({ tokenId: c, amount: items[c]! }));
    if (!list.length) return { wreckId: null as number | null };
    const wreck: WreckView = { id: S.nextWreck++, spot, owner: actor, callsign: a.callsign, items: list, at: now() };
    S.wrecks.unshift(wreck);
    if (S.wrecks.length > MARKET.maxWrecks) S.wrecks.length = MARKET.maxWrecks; // the oldest is lost to the sea
    log("wreck", actor, `${a.callsign} went down at spot ${spot} with ${describe(items)}. The wreck's up for grabs.`);
    return { wreckId: wreck.id as number | null };
  }

  function doSell(actor: string, id: BrokerId, c: CargoId, amount: number) {
    const a = player(actor);
    const n = amountOk(amount);
    const b = broker(id);
    if (!CARGO.includes(c)) refuse("E_DOESNT_BUY", `${b.name} doesn't buy that.`);
    if (BROKERS[id].buys.includes(c) && b.open && bal(a, c) < n) refuse("E_FUNDS", `You've only got ${units(c, bal(a, c))}.`);
    const paid = brokerTakes(b, c, n);
    debit(a, c, n);
    credit(actor, "scrip", paid);
    log("sale", actor, `${a.callsign} sold ${units(c, n)} to ${b.name} for ${paid}.`);
    closeCheck(b);
    return { paid };
  }

  function doBuy(actor: string, id: BrokerId, g: GearId, amount: number, at: number) {
    const a = player(actor);
    const n = amountOk(amount);
    const b = broker(id);
    if (!GEAR.includes(g)) refuse("E_DOESNT_SELL", `${b.name} doesn't sell that.`);
    const cost = brokerGearCost(b, g, n, at);
    if (bal(a, "scrip") < cost) refuse("E_FUNDS", `That's ${cost} scrip. You've got ${bal(a, "scrip")}.`);
    debit(a, "scrip", cost);
    credit(actor, g, n);
    b.scrip += cost;
    addRecent(b, g, n, at);
    log("purchase", actor, `${a.callsign} bought ${units(g, n)} from ${b.name} for ${cost}.`);
    return { cost };
  }

  function doInvest(actor: string, id: BrokerId, amount: number) {
    const a = player(actor);
    const n = amountOk(amount);
    const b = broker(id);
    if (bal(a, "scrip") < n) refuse("E_FUNDS", `You've got ${bal(a, "scrip")} scrip.`);
    debit(a, "scrip", n);
    b.scrip += n;
    b.shares[actor] = (b.shares[actor] ?? 0) + n;
    log("invest", actor, `${a.callsign} put ${n} into ${b.name}.`);
    const reopened = reopenCheck(b);
    return { shares: n, reopened };
  }

  function doList(actor: string, t: CargoId | GearId, amount: number, price: number) {
    const a = player(actor);
    const n = amountOk(amount);
    const p = amountOk(price);
    if (!CARGO.includes(t as CargoId) && !GEAR.includes(t as GearId)) refuse("E_BAD_AMOUNT", "Only cargo and gear go on the board.");
    if (bal(a, t) < n) refuse("E_FUNDS", `You've only got ${units(t, bal(a, t))}.`);
    debit(a, t, n);
    const listing: Listing = { id: S.nextListing++, seller: actor, callsign: a.callsign, tokenId: t, amount: n, price: p, at: now() };
    S.listings.unshift(listing);
    log("listing", actor, `${a.callsign} listed ${units(t, n)} at ${p} each.`);
    return { id: listing.id };
  }

  function doBuyListing(actor: string, id: number) {
    const a = player(actor);
    const i = S.listings.findIndex((l) => l.id === id);
    if (i < 0) refuse("E_NO_LISTING", "That listing's gone.");
    const l = S.listings[i];
    const cost = l.amount * l.price;
    if (bal(a, "scrip") < cost) refuse("E_FUNDS", `That's ${cost} scrip. You've got ${bal(a, "scrip")}.`);
    debit(a, "scrip", cost);
    credit(l.seller, "scrip", cost);
    credit(actor, l.tokenId, l.amount);
    S.listings.splice(i, 1);
    log("listing", actor, `${a.callsign} bought ${l.callsign}'s ${units(l.tokenId, l.amount)} for ${cost}.`);
    return { paid: cost };
  }

  function doCancel(actor: string, id: number) {
    const a = player(actor);
    const i = S.listings.findIndex((l) => l.id === id && l.seller === actor);
    if (i < 0) refuse("E_NO_LISTING", "No listing of yours with that number.");
    const l = S.listings[i];
    credit(actor, l.tokenId, l.amount);
    S.listings.splice(i, 1);
    log("listing", actor, `${a.callsign} took ${units(l.tokenId, l.amount)} off the board.`);
    return {};
  }

  function doExport(id: BrokerId, c: CargoId, amount: number, memo: string, at: number) {
    const b = broker(id);
    const n = amountOk(amount);
    const { earned, payouts } = brokerShip(b, c, n, at);
    for (const [acct, x] of payouts) credit(acct, "scrip", x);
    const dividend = payouts.reduce((s, [, x]) => s + x, 0);
    b.lastMemo = memo;
    log("export", b.accountId, `${b.name} shipped ${units(c, n)} to the freighter for ${earned}${dividend ? `, ${dividend} to shareholders` : ""}. "${memo}"`);
    reopenCheck(b);
    return { earned, dividend };
  }

  function doStance(id: BrokerId, stance: number, memo: string, at: number) {
    const b = broker(id);
    if (!isWhole(stance) || stance < MARKET.stanceMin || stance > MARKET.stanceMax) refuse("E_STANCE_RANGE", "Stance runs 80 to 120.");
    b.stance = stance;
    b.lastMemo = memo;
    b.lastStanceAt = at;
    log("stance", b.accountId, `${b.name} set stance ${stance}. "${memo}"`);
    closeCheck(b);
    return {};
  }

  // --- views

  function profileOf(a: AccountState): Profile {
    return { accountId: a.accountId, callsign: a.callsign, registeredAt: a.registeredAt, runs: a.runs, extractions: a.extractions, deaths: a.deaths, bestHaul: a.bestHaul };
  }

  function manifestOf(r: RunState): Manifest {
    return clone({ runId: r.id, startedAt: r.startedAt, containers: r.containers, wrecks: r.wrecks });
  }

  function brokerView(b: BrokerState): BrokerView {
    const q = quotes(b, now());
    return {
      id: b.id,
      accountId: b.accountId,
      name: b.name,
      open: b.open,
      scrip: b.scrip,
      stance: b.stance,
      stock: { ...b.stock },
      bids: q.bids,
      asks: q.asks,
      shares: Object.entries(b.shares)
        .sort((x, y) => y[1] - x[1])
        .map(([accountId, shares]) => ({ accountId, callsign: S.accounts[accountId]?.callsign ?? accountId, shares })),
      lastMemo: b.lastMemo,
    };
  }

  function leaderboard(): Leaderboard {
    const players = Object.values(S.accounts);
    const top = (rows: LeaderRow[]) => rows.filter((r) => r.value > 0).sort((x, y) => y.value - x.value || x.callsign.localeCompare(y.callsign)).slice(0, 10);
    const row = (a: AccountState, value: number): LeaderRow => ({ accountId: a.accountId, callsign: a.callsign, value });
    const escrow = (id: string, c: CargoId) => S.listings.filter((l) => l.seller === id && l.tokenId === c).reduce((s, l) => s + l.amount, 0);
    return {
      // Mock's reading: scrip plus cargo (held or listed) at the best current bid; gear has no bid, so it isn't counted.
      netWorth: top(players.map((a) => row(a, bal(a, "scrip") + CARGO.reduce((s, c) => s + (bal(a, c) + escrow(a.accountId, c)) * bestBid(S.brokers, c), 0)))),
      bestHaul: top(players.map((a) => row(a, a.bestHaul))),
      investors: top(players.map((a) => row(a, BROKER_IDS.reduce((s, id) => s + (S.brokers[id].shares[a.accountId] ?? 0), 0)))),
    };
  }

  function simulate(hours: number, traders: number, seed: number): SimPoint[] {
    if (!isWhole(hours) || hours > MARKET.maxSimHours) throw new Error(`hours must be 0–${MARKET.maxSimHours}`);
    if (!isWhole(traders) || traders > MARKET.maxSimTraders) throw new Error(`traders must be 0–${MARKET.maxSimTraders}`);
    if (!isWhole(seed)) throw new Error("seed must be a whole number");
    const r: Rng = { rng: ((seed % 4294967296) ^ 0x9e3779b9) >>> 0 || 1 };
    const brokers = clone(S.brokers);
    const t0 = now();
    const scrip = Array.from({ length: traders }, () => RULES.starterScrip);
    const attempt = <T>(fn: () => T): T | null => {
      try {
        return fn();
      } catch (e) {
        if (e instanceof Refusal) return null;
        throw e;
      }
    };
    const points: SimPoint[] = [];
    for (let h = 1; h <= hours; h++) {
      const at = t0 + h * HOUR;
      for (let t = 0; t < traders; t++) {
        if (rand(r) < 0.55) {
          // A run that made the boat: one to three containers, sold to whoever bids best, one batch per cargo.
          const haul: Amounts<CargoId> = {};
          const boxes = 1 + Math.floor(rand(r) * 3);
          for (let k = 0; k < boxes; k++) {
            const d = lootDraw(r);
            haul[d.c] = (haul[d.c] ?? 0) + d.n;
          }
          for (const c of CARGO) {
            let n = haul[c] ?? 0;
            while (n > 0) {
              const open = BROKER_IDS.map((id) => brokers[id]).filter((b) => b.open && BROKERS[b.id].buys.includes(c));
              if (!open.length) break;
              const b = open.sort((x, y) => bidPrice(c, y.stock[c] ?? 0, y.stance) - bidPrice(c, x.stock[c] ?? 0, x.stance))[0];
              // Like the ambient players: hold out rather than sell for scraps.
              if (bidPrice(c, b.stock[c] ?? 0, b.stance) < ITEMS[c].base * HOLD_OUT) break;
              const paid = attempt(() => brokerTakes(b, c, n));
              if (paid === null) {
                // Too big for the till: try the rest one unit at a time, then give up on this cargo.
                const one = attempt(() => brokerTakes(b, c, 1));
                if (one === null) {
                  closeCheck2(b);
                  break;
                }
                scrip[t] += one;
                n -= 1;
              } else {
                scrip[t] += paid;
                n = 0;
              }
              closeCheck2(b);
            }
          }
        }
        if (rand(r) < 0.15) {
          const g = pickOne(r, GEAR);
          const b = brokers[BROKER_IDS.find((id) => BROKERS[id].sells.includes(g))!];
          const cost = attempt(() => brokerGearCost(b, g, 1, at));
          if (cost !== null && scrip[t] >= cost) {
            scrip[t] -= cost;
            b.scrip += cost;
            addRecent(b, g, 1, at);
          }
        }
        const closed = BROKER_IDS.map((id) => brokers[id]).filter((b) => !b.open);
        if (closed.length && scrip[t] >= 150 && rand(r) < 0.25) {
          const b = pickOne(r, closed);
          scrip[t] -= 100;
          b.scrip += 100;
          b.shares[`sim-${t}`] = (b.shares[`sim-${t}`] ?? 0) + 100;
          if (b.scrip >= MARKET.reopenAt) b.open = true;
        }
      }
      // Mock's reading: each hour's point is the market after the hour's trading, before the brokers' agents act.
      const snap = {} as Record<BrokerId, SimBroker>;
      for (const id of BROKER_IDS) {
        const b = brokers[id];
        const bids: Amounts<CargoId> = {};
        for (const c of BROKERS[id].buys) bids[c] = bidPrice(c, b.stock[c] ?? 0, b.stance);
        snap[id] = { open: b.open, scrip: b.scrip, bids, stock: { ...b.stock } };
      }
      points.push({ hour: h, brokers: snap });
      // Then the brokers' agents: export every surplus with a free slot, maybe change stance.
      for (const id of BROKER_IDS) {
        const b = brokers[id];
        let adv = policy(b, at);
        for (let i = 0; i < BROKERS[id].buys.length && adv.action === "export" && adv.tokenId && adv.amount; i++) {
          const { tokenId, amount } = adv;
          const shipped = attempt(() => brokerShip(b, tokenId, amount, at));
          if (!shipped) break;
          for (const [acct, x] of shipped.payouts) {
            const k = acct.startsWith("sim-") ? Number(acct.slice(4)) : -1;
            if (k >= 0 && k < traders) scrip[k] += x;
          }
          if (!b.open && b.scrip >= MARKET.reopenAt) b.open = true;
          adv = policy(b, at);
        }
        if (adv.action === "stance" && adv.stance) {
          b.stance = adv.stance;
          closeCheck2(b);
        }
      }
    }
    return points;
  }

  /** closeCheck without a ledger entry, for the simulation's private copy. */
  function closeCheck2(b: BrokerState) {
    if (b.open && cantBuyAnything(b)) b.open = false;
  }

  // --- other players and the brokers' agents

  const npcs = () => Object.values(S.accounts).filter((a) => a.npc);
  const attemptNpc = (fn: () => unknown): boolean => {
    const before = JSON.stringify(S);
    try {
      fn();
      return true;
    } catch (e) {
      S = JSON.parse(before) as MockState;
      if (!(e instanceof Refusal)) console.warn("[economy] mock ambient error:", e);
      return false;
    }
  };

  function npcRun(a: AccountState, at: number, survive: boolean): boolean {
    if (a.lastRunAt !== null && at - a.lastRunAt < 12 * 60_000) return false;
    const gear = GEAR.filter((g) => bal(a, g) > 0);
    const started = at - 5 * 60_000;
    return attemptNpc(() => {
      const m = doStartRun(a.accountId, gear, started);
      const opened: number[] = [];
      let weight = 0;
      const want = 1 + Math.floor(rand(S) * 4);
      for (const c of shuffle(S, [...m.containers])) {
        const w = c.amount * ITEMS[c.tokenId].weight;
        if (opened.length < want && weight + w <= RULES.carryLimit) {
          opened.push(c.spot);
          weight += w;
        }
      }
      const wrecks: number[] = [];
      for (const w of m.wrecks) {
        const ww = w.items.reduce((s, i) => s + i.amount * ITEMS[i.tokenId].weight, 0);
        if (rand(S) < 0.4 && weight + ww <= RULES.carryLimit) {
          wrecks.push(w.id);
          weight += ww;
        }
      }
      if (survive) doExtract(a.accountId, m.runId, opened, wrecks, at);
      else doDie(a.accountId, m.runId, opened, wrecks, Math.floor(rand(S) * RULES.spotCount));
    });
  }

  function npcSell(a: AccountState, at: number): boolean {
    const held = CARGO.filter((c) => bal(a, c) > 0);
    if (!held.length) return npcRun(a, at, true);
    const c = pickOne(S, held);
    const open = BROKER_IDS.filter((id) => BROKERS[id].buys.includes(c) && S.brokers[id].open);
    if (!open.length) return false;
    const best = open.sort((x, y) => bidPrice(c, S.brokers[y].stock[c] ?? 0, S.brokers[y].stance) - bidPrice(c, S.brokers[x].stock[c] ?? 0, S.brokers[x].stance))[0];
    // Other players hold out rather than sell for scraps.
    if (bidPrice(c, S.brokers[best].stock[c] ?? 0, S.brokers[best].stance) < ITEMS[c].base * HOLD_OUT) return false;
    const n = 1 + Math.floor(rand(S) * Math.min(3, bal(a, c)));
    return attemptNpc(() => doSell(a.accountId, best, c, n));
  }

  function npcBuyGear(a: AccountState, at: number): boolean {
    const g = pickOne(S, GEAR);
    const id = BROKER_IDS.find((b) => BROKERS[b].sells.includes(g))!;
    const b = S.brokers[id];
    if (!b.open || bal(a, "scrip") < askPrice(g, recentUnits(b, g, at), b.stance) + 40) return false;
    return attemptNpc(() => doBuy(a.accountId, id, g, 1, at));
  }

  function npcInvest(a: AccountState): boolean {
    const s = bal(a, "scrip");
    const closed = BROKER_IDS.filter((id) => !S.brokers[id].open);
    if (closed.length && s >= 120) {
      const amount = 40 + Math.floor(rand(S) * Math.min(160, s - 80));
      return attemptNpc(() => doInvest(a.accountId, pickOne(S, closed), amount));
    }
    if (s > 300 && rand(S) < 0.25) return attemptNpc(() => doInvest(a.accountId, pickOne(S, BROKER_IDS), 20 + Math.floor(rand(S) * 41)));
    return false;
  }

  function npcList(a: AccountState): boolean {
    const held = CARGO.filter((c) => bal(a, c) > 0);
    if (!held.length || S.listings.length >= 12) return false;
    const c = pickOne(S, held);
    const price = Math.max(1, Math.round(bestBid(S.brokers, c) * (1.05 + rand(S) * 0.25)));
    return attemptNpc(() => doList(a.accountId, c, 1, price));
  }

  function npcBuyListing(a: AccountState, at: number): boolean {
    const offers = S.listings.filter((l) => l.seller !== a.accountId);
    if (!offers.length) return false;
    const l = pickOne(S, offers);
    const ref = CARGO.includes(l.tokenId as CargoId)
      ? bestBid(S.brokers, l.tokenId as CargoId)
      : (() => {
          const id = BROKER_IDS.find((b) => BROKERS[b].sells.includes(l.tokenId as GearId))!;
          return askPrice(l.tokenId as GearId, recentUnits(S.brokers[id], l.tokenId as GearId, at), S.brokers[id].stance);
        })();
    if (l.price > ref * 1.25 || bal(a, "scrip") < l.amount * l.price) return false;
    return attemptNpc(() => doBuyListing(a.accountId, l.id));
  }

  function npcAct(at: number): boolean {
    const crew = npcs();
    if (!crew.length) return false;
    const a = pickOne(S, crew);
    const w = rand(S) * 100;
    if (w < 38) return npcSell(a, at);
    if (w < 56) return npcRun(a, at, true);
    if (w < 64) return npcRun(a, at, false);
    if (w < 74) return npcBuyGear(a, at);
    if (w < 82) return npcInvest(a);
    if (w < 90) return npcList(a);
    return npcBuyListing(a, at);
  }

  function brokerAct(id: BrokerId, at: number): boolean {
    const b = S.brokers[id];
    let adv = policy(b, at);
    let shipped = false;
    // Every cargo with a surplus and a free slot ships in the same tick.
    for (let i = 0; i < BROKERS[id].buys.length && adv.action === "export" && adv.tokenId && adv.amount; i++) {
      const { tokenId, amount, memo } = adv;
      if (!attemptNpc(() => doExport(id, tokenId, amount, memo, at))) break;
      shipped = true;
      adv = policy(S.brokers[id], at);
    }
    if (shipped) return true;
    // The mock paces its agents: one stance change per broker per 20 minutes.
    if (adv.action === "stance" && adv.stance && at - b.lastStanceAt >= 20 * 60_000) return attemptNpc(() => doStance(id, adv.stance!, adv.memo, at));
    return false;
  }

  function ambient(seconds: number) {
    const s = Math.max(0, Math.min(600, Math.floor(Number(seconds) || 0)));
    const at = now();
    let changed = false;
    // About five actions a minute across the whole crew: enough that the Dockside visibly moves.
    for (let i = 0; i < s; i++) if (rand(S) < 1 / 12) changed = npcAct(at) || changed;
    for (const id of BROKER_IDS) changed = brokerAct(id, at) || changed;
    if (changed) save();
  }

  const me = () => S.me;

  if (fresh) {
    if (opts.warmupSeconds) ambient(opts.warmupSeconds);
    save();
  }

  const reject = (e: unknown) => Promise.reject(e instanceof Error ? e : new Error(String(e)));

  return {
    network: "mock",
    contractId: MOCK_CONTRACT,
    txUrl: () => null,
    me,
    isRegistered: (accountId) => !!S.accounts[accountId],
    snapshot: () => clone(S),
    reset() {
      try {
        storage?.removeItem(MOCK_STORAGE_KEY);
      } catch {
        // ignore
      }
      S = freshState(seed, now());
      save();
    },
    advice: (id) => policy(broker(id), now()),
    ambient,

    async profile(accountId) {
      const a = S.accounts[accountId];
      return a ? profileOf(a) : null;
    },
    async balances(accountId) {
      const a = S.accounts[accountId];
      if (!a) return {};
      const out: Amounts = {};
      for (const [k, v] of Object.entries(a.balances)) if ((v ?? 0) > 0) out[k as TokenId] = v;
      return out;
    },
    async brokers() {
      return BROKER_IDS.map((id) => brokerView(S.brokers[id]));
    },
    async wrecks() {
      return clone(S.wrecks);
    },
    async listings() {
      return clone(S.listings);
    },
    async recent(limit) {
      return clone(S.recent.slice(0, Math.max(1, Math.min(MARKET.maxRecent, Math.floor(limit) || 1))));
    },
    async leaderboard() {
      return leaderboard();
    },
    simulate(hours, traders, seed) {
      try {
        return Promise.resolve(simulate(hours, traders, seed));
      } catch (e) {
        return reject(e);
      }
    },
    async manifest(runId) {
      const r = S.runs[runId];
      return r ? manifestOf(r) : null;
    },

    async register(accountId, callsign) {
      return tx(() => ({ profile: doRegister(accountId, callsign) }));
    },
    async startRun(gear) {
      return tx(() => ({ manifest: doStartRun(me(), gear, now()) }));
    },
    async extract(runId, opened, wrecks) {
      return tx(() => doExtract(me(), runId, opened, wrecks, now()));
    },
    async die(runId, opened, wrecks, spot) {
      return tx(() => doDie(me(), runId, opened, wrecks, spot));
    },
    async sell(id, c, amount) {
      return tx(() => doSell(me(), id, c, amount));
    },
    async buy(id, g, amount) {
      return tx(() => doBuy(me(), id, g, amount, now()));
    },
    async invest(id, amount) {
      return tx(() => doInvest(me(), id, amount));
    },
    async list(t, amount, price) {
      return tx(() => doList(me(), t, amount, price));
    },
    async buyListing(id) {
      return tx(() => doBuyListing(me(), id));
    },
    async cancelListing(id) {
      return tx(() => doCancel(me(), id));
    },
    async brokerExport(id, c, amount, memo) {
      return tx(() => doExport(id, c, amount, memo, now()));
    },
    async brokerStance(id, stance, memo) {
      return tx(() => doStance(id, stance, memo, now()));
    },
  };
}

/** The offline wallet: the mock's local player, registered through the mock's faucet call. */
export function createMockWallet(chain: MockChain): Wallet & { readonly kind: "mock" } {
  return {
    kind: "mock",
    accountId: () => chain.me(),
    registered: async () => chain.isRegistered(chain.me()),
    claim: async (callsign: string) => {
      const r = await chain.register(chain.me(), callsign);
      return { ok: r.ok, ...(r.txHash ? { txHash: r.txHash } : {}), ...(r.error ? { error: r.error } : {}) };
    },
  };
}
