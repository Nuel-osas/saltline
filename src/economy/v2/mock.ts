// =====================================================================================================================
// THE OFFLINE MOCK FOR SALTLINE V2. The whole of docs/CONTRACT_V2.md's rules in memory, so the game plays without a
// network exactly as it does on chain. Every number comes from items.ts.
//
// It is NOT the authority. The contract (contract2/) is; where this file and the contract disagree, the contract is
// right and this file gets fixed. Wherever the doc left a choice open, the line says "mock's reading". They are all
// listed here so the contract can be matched against them:
//
//  1. A gun that isn't the caller's is refused with E_NOT_OWNER; one that doesn't exist with E_NO_WEAPON. Someone
//     else's listing can't be cancelled (E_NOT_OWNER).
//  2. Stats are rolled uniformly on whole numbers inside the band, ends included.
//  3. `start_raid`'s 30 s count from the last raid's START. A loadout over 1 plate, 3 charges or 8 magazines is
//     E_BAD_AMOUNT; gear the caller doesn't hold is E_FUNDS.
//  4. A raid is offered the three NEWEST live wrecks that aren't the caller's or reserved. A wreck reserved by an
//     open raid isn't burned by expiry until that raid ends, so a raid can't be refused for a wreck it was shown.
//  5. Bad report numbers (uplinks, kills, parts, used, the spot, `by`) are E_BAD_REPORT. Carry weight counts the
//     opened cargo, the parts and 2 per recovered gun; a wreck's loose items weigh nothing. The invoice uses that
//     weight in `die` too. A raid that isn't the caller's is E_NO_RAID.
//  6. `extract`'s `minted` is the cargo, the parts and the recovered wrecks' items; gear handed back isn't in it.
//  7. A gun's `raids` goes up when a raid ends with it, by the boat or by death (not when it is abandoned). A gun
//     takes no wear from dying, only the 15 when it is recovered. A profile's `raids` goes up at `start_raid`.
//  8. `die` by machines leaves a wreck if there is a gun OR anything at all to put in it (cargo, parts, unused
//     gear). The impound fee is fixed when the gun is taken. Wrecks picked up by a player who then dies stay put.
//  9. At the 40-wreck cap the oldest unreserved wreck is burned.
// 10. `repair` trims points to what the gun is missing; a gun at 100 is E_BAD_AMOUNT and one at 0 is E_WORN_OUT.
// 11. `settle` needs the scrip for what it takes (the amount, capped at ⌈arrears ÷ 2⌉), or it is E_FUNDS.
// 12. The Harbormaster starts on `patrols`. Pursuit moves only the Bailiff's threshold. Its balance and the export
//     desk's "recently" decay with v1's 16-step halving table (../mock.ts decayMilli), kept in thousandths.
// 13. Vendors start with 75% of target (rounded down) of each material they buy. Each unit sold to a vendor is
//     priced at the stock then, rounded down. `open` is false when no bid can be paid without going under the float.
//     Ines's meds decay lazily in thousandths with the same table as the Harbormaster's balance; what the clinic
//     uses is gone, not exported.
// 14. Each unit of goods bought is priced at the stock then (items.ts `goodsPrice`). A price set by `vendor_price`
//     is flat until it is set again.
// 15. A vendor's gun has the vendor as maker and first owner, so a buyer is its second.
// 16. Export prices each unit at ⌊export × 100 ÷ (100 + 4 × recent)⌋, one counter per material shared by everyone.
// 17. Market: for items both ⌊2%⌋ parts are burned. Only market sales enter `last_sales`, oldest first.
// 18. The 5,000-gun limit counts guns alive. `net_worth` is scrip plus guns in state `held`. Leaderboards leave out
//     zero rows. Genesis scrip is in `scrip_supply` and not in `minted_24h`.
// 19. Registration and a death that leaves nothing behind write no `recent` line (there is no kind for them).
// 20. `pause` isn't modelled: nothing here returns E_PAUSED.
// =====================================================================================================================
import { decayMilli } from "../mock";
import { normalizeCallsign } from "../wallet";
import type { AgentCalls } from "./chain";
import {
  BLUEPRINTS,
  BONDED_LOOT,
  CONDITION,
  CONTAINER_LOOT,
  FRAMES,
  FRAME_IDS,
  HARBORMASTER,
  INVOICE,
  MARKET,
  MATERIALS,
  MATERIAL_IDS,
  MODS,
  MOD_IDS,
  RAID,
  STAT_KEYS,
  VENDORS,
  VENDOR_PRICING,
  appraise,
  goodsPrice,
  gradeOf,
  invoiceStart,
  invoiceTotal,
  quality,
  weightOf,
} from "./items";
import type {
  Amounts,
  BlueprintId,
  Chain2,
  ConsumableId,
  Container,
  DeathBy,
  EconomyView,
  FrameId,
  Grade,
  HarbormasterView,
  Impounded,
  Leaderboard,
  LeaderRow,
  LedgerEvent,
  LedgerKind,
  Listing,
  Loadout,
  MaterialId,
  ModId,
  Posture,
  Profile,
  Quote,
  Raid,
  RaidReport,
  Stats,
  TokenId,
  TxResult,
  Vendor,
  VendorId,
  Wallet2,
  Weapon,
  Wreck,
} from "./types";

export const MOCK2_STORAGE_KEY = "saltline.v2.mock.v1";
export const MOCK2_CONTRACT = "v2.saltline.mock";
export const MOCK2_HARBORMASTER = "harbormaster.saltline.mock";

/** The contract's numbers that items.ts doesn't carry (docs/CONTRACT_V2.md → Init, Rules). */
export const MOCK2 = {
  vendorScrip: 1500,
  vendorStockPct: 75,
  /** Export: each unit exported recently takes this many percent off the divisor's base of 100. */
  exportStepPct: 4,
  maxRecent: 64,
  keptSales: 5,
  keptRaids: 30,
  maxAmount: 1_000_000,
  maxPrice: 1_000_000_000,
  limits: { profiles: 2000, guns: 5000, listings: MARKET.maxListings, wrecks: 40 },
  genesisGoods: { plate: 10, charge: 10, ammo: 40 },
  genesisGuns: ["longshore", "stevedore"] as FrameId[],
} as const;

/** How much history a brand-new offline world is given, so the dock isn't empty on a first visit. */
export const MOCK2_WARMUP_SECONDS = 6 * 3600;

const HOUR = 3_600_000;
const HALF_LIFE_MS = HARBORMASTER.halfLifeHours * HOUR;
const VENDOR_IDS = Object.keys(VENDORS) as VendorId[];
const CONSUMABLE_IDS: ConsumableId[] = ["plate", "charge", "ammo"];
type GoodId = ModId | ConsumableId;

// ---------------------------------------------------------------------------------------------------------------
// The rules that are pure, exported so tests and the dock can read the same prices

/** What a vendor pays for the next unit: `bid × 2 × target ÷ (target + stock)`, rounded down. */
export const vendorBid = (m: MaterialId, stock: number) => Math.floor((MATERIALS[m].bid * 2 * MATERIALS[m].target) / (MATERIALS[m].target + stock));

// items.ts declares `stock = VENDOR_PRICING.scarceUnder`, which TypeScript reads as the literal type 5 (the constant
// is `as const`), so no other stock type-checks. Until items.ts says `stock: number`, the mock calls it through this.
const unitPrice = goodsPrice as (id: ModId | ConsumableId, stock?: number) => number;

/** A vendor's default price for a gun: its appraisal × VENDOR_PRICING.gunPct. (Goods: `goodsPrice` in items.ts.) */
export const gunPrice = (value: number) => Math.floor((value * VENDOR_PRICING.gunPct) / 100);

const snake = (k: string) => k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
function snakeKeys(o: unknown): unknown {
  if (!o || typeof o !== "object" || Array.isArray(o)) return o;
  return Object.fromEntries(Object.entries(o).map(([k, v]) => [snake(k), snakeKeys(v)]));
}

/** The `rules` view as the contract sends it: each group the snake_case of the same-named constant in items.ts. */
export const rulesWire = (): Record<string, unknown> =>
  snakeKeys({ raid: RAID, invoice: INVOICE, harbormaster: HARBORMASTER, market: MARKET, condition: CONDITION, vendorPricing: VENDOR_PRICING }) as Record<string, unknown>;

/** What the export desk pays for the next unit, with `recentMilli` thousandths of a unit exported recently. */
export const exportPrice = (m: MaterialId, recentMilli: number) =>
  Math.floor((MATERIALS[m].export * 100_000) / (100_000 + MOCK2.exportStepPct * recentMilli));

/** The Harbormaster as every view shows it, from its balance and posture. */
export function harbormasterView(accountId: string, balance: number, posture: Posture, lastMemo: string | null): HarbormasterView {
  const strength = Math.min(100, Math.floor(balance / HARBORMASTER.scripPerStrength));
  const pursuit = posture === "pursuit";
  return {
    accountId,
    balance,
    strength,
    posture,
    bonusDrones: pursuit ? 0 : Math.floor(strength / HARBORMASTER.strengthPerDrone),
    secondNoticeAt: INVOICE.secondNotice,
    bailiffAt: pursuit ? INVOICE.bailiff - HARBORMASTER.bailiffDropPerStrength * strength : INVOICE.bailiff,
    secondBailiffAt: INVOICE.secondBailiff,
    foreclosureAt: INVOICE.foreclosure,
    lastMemo,
  };
}

/** `?stash=rich` on the page URL: start the offline player with a full locker, for testing screens. */
export function mockStashParam(search: string): "rich" | null {
  return new URLSearchParams(search).get("stash") === "rich" ? "rich" : null;
}

// ---------------------------------------------------------------------------------------------------------------
// Words

const NOUN: Record<TokenId, [string, string]> = {
  scrip: ["scrip", "scrip"],
  copper: ["copper coil", "copper coils"],
  chips: ["box of electronics", "boxes of electronics"],
  meds: ["crate of meds", "crates of meds"],
  fuel: ["fuel cell", "fuel cells"],
  core: ["relay core", "relay cores"],
  servo: ["hound servo", "hound servos"],
  rotor: ["gull rotor", "gull rotors"],
  mag2: ["extended magazine", "extended magazines"],
  barrel2: ["long barrel", "long barrels"],
  comp: ["compensator", "compensators"],
  optic: ["optic", "optics"],
  plate: ["armour plate", "armour plates"],
  charge: ["breaker charge", "breaker charges"],
  ammo: ["magazine", "magazines"],
};
const TOKEN_ORDER = Object.keys(NOUN) as TokenId[];
export const units2 = (t: TokenId, n: number) => `${n} ${NOUN[t][n === 1 ? 0 : 1]}`;
const FRAME_SHORT: Record<FrameId, string> = { longshore: "Longshore", stevedore: "Stevedore", pilot: "Pilot" };
const gunName = (w: Pick<Weapon, "frame" | "serial">) => `${FRAME_SHORT[w.frame]} ${w.serial}`;
const graded = (w: Pick<Weapon, "frame" | "grade">) => `${w.grade === "A" ? "an" : "a"} ${w.grade}-grade ${FRAME_SHORT[w.frame]}`;
const joinList = (parts: string[]) => (parts.length <= 1 ? (parts[0] ?? "nothing") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`);
const describe = (items: Amounts) => joinList(TOKEN_ORDER.filter((t) => (items[t] ?? 0) > 0).map((t) => units2(t, items[t] as number)));

// ---------------------------------------------------------------------------------------------------------------
// State

interface AccountState extends Profile {
  balances: Amounts;
  lastRaidAt: number | null;
  npc: boolean;
}

interface VendorState {
  id: VendorId;
  accountId: string;
  name: string;
  scrip: number;
  stock: Amounts<MaterialId>;
  goods: Partial<Record<GoodId, number>>;
  /** Prices set by `vendor_price`, by token id or serial. */
  prices: Record<string, number>;
  /** Ines only: when her meds were last decayed, and the thousandths of a unit left over then. */
  medsAt?: number;
  medsMilli?: number;
  lastMemo: string | null;
  lastActAt: number;
}

interface RaidState {
  id: number;
  player: string;
  startedAt: number;
  loadout: Loadout;
  containers: Container[];
  wreckIds: number[];
  invoiceStart: number;
  harbormaster: HarbormasterView;
  closed: boolean;
}

interface WreckState {
  id: number;
  spot: number;
  owner: string;
  callsign: string;
  serial: string | null;
  items: { tokenId: TokenId; amount: number }[];
  at: number;
  expiresAt: number;
  /** The open raid this wreck is on offer to, if any. */
  reservedBy: number | null;
}

interface ImpoundState {
  serial: string;
  owner: string;
  fee: number;
  expiresAt: number;
}

interface ListingState {
  id: number;
  seller: string;
  callsign: string;
  price: number;
  at: number;
  serial?: string;
  item?: { tokenId: TokenId; amount: number };
}

export interface MockState2 {
  v: 1;
  seed: number;
  /** The PRNG's state (mulberry32), so play replays exactly from a saved state. */
  rng: number;
  me: string;
  /** The latest time any rule has seen; the mock's clock never runs backwards. */
  clock: number;
  /** Added to the real clock by `debug.advance`. */
  skewMs: number;
  accounts: Record<string, AccountState>;
  vendors: Record<VendorId, VendorState>;
  weapons: Record<string, Weapon>;
  raids: Record<string, RaidState>;
  wrecks: WreckState[];
  impound: ImpoundState[];
  listings: ListingState[];
  recent: LedgerEvent[];
  hm: { milli: number; at: number; posture: Posture; lastMemo: string | null; lastActAt: number };
  exported: Partial<Record<MaterialId, { milli: number; at: number }>>;
  /** Scrip minted and burned, in ten-minute buckets, for the 24-hour figures. */
  flow: { bucket: number; minted: number; burned: number }[];
  built: number;
  destroyed: number;
  sales: Record<string, number[]>;
  nextSerial: number;
  nextRaid: number;
  nextWreck: number;
  nextListing: number;
  nextTx: number;
  /** True once `?stash=rich` has filled the locker, so a reload doesn't fill it twice. */
  rich: boolean;
}

type Rng = { rng: number };

function rand(r: Rng): number {
  let t = (r.rng = (r.rng + 0x6d2b79f5) >>> 0);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const below = (r: Rng, n: number) => Math.floor(rand(r) * n);
const pickOne = <T>(r: Rng, xs: readonly T[]): T => xs[below(r, xs.length)];
function shuffle<T>(r: Rng, xs: T[]): T[] {
  for (let i = xs.length - 1; i > 0; i--) {
    const j = below(r, i + 1);
    [xs[i], xs[j]] = [xs[j], xs[i]];
  }
  return xs;
}
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

/** Reading 2: each stat uniform on the whole numbers of its band, ends included. */
function rollStats(r: Rng, frame: FrameId): Stats {
  const stats = {} as Stats;
  for (const k of STAT_KEYS) {
    const [lo, hi] = FRAMES[frame].bands[k];
    stats[k] = lo + below(r, hi - lo + 1);
  }
  return stats;
}

function lootDraw(r: Rng): { id: MaterialId; n: number } {
  let roll = rand(r) * 100;
  for (const l of CONTAINER_LOOT) {
    roll -= l.chance;
    if (roll < 0) return { id: l.id, n: l.amount[0] + below(r, l.amount[1] - l.amount[0] + 1) };
  }
  return { id: CONTAINER_LOOT[0].id, n: CONTAINER_LOOT[0].amount[0] };
}

const NPCS: [string, string][] = [
  ["rook.mock", "ROOK"],
  ["marlowe.mock", "MARLOWE"],
  ["kestrel-9.mock", "KESTREL-9"],
  ["low-tide.mock", "LOW TIDE"],
  ["dock-rat.mock", "DOCK.RAT"],
  ["bosun-k.mock", "BOSUN_K"],
  ["halyard.mock", "HALYARD"],
  ["sprat.mock", "SPRAT"],
  ["tin-can.mock", "TIN CAN"],
  ["old-salt.mock", "OLD SALT"],
  ["brine.mock", "BRINE"],
  ["cutwater.mock", "CUTWATER"],
];

function freshAccount(accountId: string, callsign: string, at: number, npc: boolean): AccountState {
  return {
    accountId,
    callsign,
    registeredAt: at,
    raids: 0,
    extractions: 0,
    deaths: 0,
    arrears: 0,
    activeRaid: null,
    built: 0,
    royalties: 0,
    balances: { scrip: RAID.starterScrip },
    lastRaidAt: null,
    npc,
  };
}

function freshState(seed: number, at: number): MockState2 {
  const r: Rng = { rng: (seed * 2654435761) >>> 0 || 1 };
  let me = "";
  for (let i = 0; i < 8; i++) me += below(r, 2 ** 32).toString(16).padStart(8, "0");
  const vendors = {} as Record<VendorId, VendorState>;
  for (const id of VENDOR_IDS) {
    const stock: Amounts<MaterialId> = {};
    // Reading 13: 75% of target, rounded down, of each material the vendor buys.
    for (const m of VENDORS[id].buys) stock[m] = Math.floor((MATERIALS[m].target * MOCK2.vendorStockPct) / 100);
    vendors[id] = { id, accountId: `${id}.saltline.mock`, name: VENDORS[id].name, scrip: MOCK2.vendorScrip, stock, goods: {}, prices: {}, lastMemo: null, lastActAt: at };
  }
  vendors.ines.goods = { ...MOCK2.genesisGoods };
  vendors.ines.medsAt = at;
  const S: MockState2 = {
    v: 1,
    seed,
    rng: r.rng,
    me,
    clock: at,
    skewMs: 0,
    accounts: {},
    vendors,
    weapons: {},
    raids: {},
    wrecks: [],
    impound: [],
    listings: [],
    recent: [],
    hm: { milli: 0, at, posture: "patrols", lastMemo: null, lastActAt: at },
    exported: {},
    flow: [],
    built: 0,
    destroyed: 0,
    sales: {},
    nextSerial: 1,
    nextRaid: 1,
    nextWreck: 1,
    nextListing: 1,
    nextTx: 0,
    rich: false,
  };
  // Moss's two guns, rolled at init.
  for (const frame of MOCK2.genesisGuns) {
    const stats = rollStats(S, frame);
    const q = quality(frame, stats);
    const serial = `S-${String(S.nextSerial++).padStart(6, "0")}`;
    S.weapons[serial] = {
      serial,
      frame,
      grade: gradeOf(q),
      quality: q,
      stats,
      mods: [],
      condition: 100,
      maker: vendors.moss.accountId,
      makerCallsign: vendors.moss.name.toUpperCase(),
      owner: vendors.moss.accountId,
      builtAt: at,
      raids: 0,
      extractions: 0,
      owners: 1,
      recovered: 0,
      state: "vendor",
      value: appraise(frame, gradeOf(q), 100),
    };
    S.built++;
  }
  // The other players, each registered by the faucet's rule: a dock pass and its 150 scrip.
  for (const [accountId, callsign] of NPCS) S.accounts[accountId] = freshAccount(accountId, callsign, at, true);
  return S;
}

function validState(s: unknown): s is MockState2 {
  if (!s || typeof s !== "object") return false;
  const o = s as Partial<MockState2>;
  return (
    o.v === 1 &&
    typeof o.me === "string" &&
    typeof o.rng === "number" &&
    typeof o.clock === "number" &&
    !!o.accounts &&
    !!o.vendors &&
    VENDOR_IDS.every((id) => !!o.vendors?.[id]) &&
    !!o.weapons &&
    !!o.raids &&
    !!o.hm &&
    !!o.sales &&
    Array.isArray(o.wrecks) &&
    Array.isArray(o.impound) &&
    Array.isArray(o.listings) &&
    Array.isArray(o.recent) &&
    Array.isArray(o.flow)
  );
}

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
function amountOk(n: unknown, max: number = MOCK2.maxAmount): number {
  if (!isWhole(n) || n === 0 || n > max) refuse("E_BAD_AMOUNT", "Zero or too large.");
  return n as number;
}

// ---------------------------------------------------------------------------------------------------------------
// The mock chain

type CallName =
  | "startRaid"
  | "extract"
  | "die"
  | "build"
  | "fit"
  | "repair"
  | "scrap"
  | "sell"
  | "buy"
  | "buyGun"
  | "exportGoods"
  | "listWeapon"
  | "listItem"
  | "buyListing"
  | "cancelListing"
  | "settle"
  | "buyBack";

/** Every call, as one account makes it. `mock.as(id)` gives these for any account; the chain's own are the player's. */
export type Calls2 = Pick<Chain2, CallName> & AgentCalls;

export interface MockDebug {
  /** Puts tokens in the player's locker from nowhere. Scrip given this way counts as minted. */
  give(what: TokenId | Amounts, amount?: number): void;
  /** Puts a gun in the player's locker: the frame, and the grade, condition and mods asked for. */
  giveGun(frame: FrameId, o?: { grade?: Grade; condition?: number; mods?: ModId[]; impound?: boolean }): Weapon;
  /** Moves the mock's clock on, so wrecks and impounds expire and the Harbormaster's balance decays. */
  advance(hours: number): void;
  setArrears(amount: number): void;
  /** Leaves another player's wreck in the yard, with a gun unless `frame` is null. */
  addWreck(o?: { spot?: number; frame?: FrameId | null; grade?: Grade; items?: Amounts }): Wreck;
  /** Pays the Harbormaster from nowhere (counts as minted), to see the yard at a given strength. */
  payHarbormaster(scrip: number): void;
}

export interface MockChain2 extends Chain2, AgentCalls {
  readonly network: "mock";
  /** The local player's account id (what the mock wallet signs as). */
  me(): string;
  isRegistered(accountId: string): boolean;
  /** The faucet's call: creates the profile and mints the starter scrip. */
  register(accountId: string, callsign: string): Promise<TxResult & { profile?: Profile }>;
  /** The same calls made as another account: a second player, a vendor, the Harbormaster. */
  as(accountId: string): Calls2;
  vendorAccount(id: VendorId): string;
  /** Other players raid, die, build, trade and settle, and the vendors' and the Harbormaster's agents act, over `seconds`. */
  ambient(seconds: number): void;
  /** The contract's `rules` view: items.ts's numbers, in the shape the contract sends them. */
  rules(): Promise<Record<string, unknown>>;
  /** Wipes the saved mock and starts again from the seed. */
  reset(): void;
  /** A copy of the whole state, for tests and the debug console. */
  snapshot(): MockState2;
  /** The mock's clock: the real one plus whatever `debug.advance` added. */
  now(): number;
  readonly debug: MockDebug;
}

export interface MockOptions2 {
  /** Where to persist; null for none. Defaults to localStorage when there is one. */
  storage?: Storage | null;
  now?: () => number;
  /** Seconds of history to play when the state is brand new (MOCK2_WARMUP_SECONDS is a good first visit). */
  warmupSeconds?: number;
  /** `"rich"` fills the player's locker. Read from `?stash=` on the page URL when left out. */
  stash?: "rich" | null;
  /** Lower limits, so tests can reach them. */
  limits?: Partial<Record<keyof typeof MOCK2.limits, number>>;
}

function defaultStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function pageSearch(): string {
  try {
    return typeof location === "undefined" ? "" : location.search;
  } catch {
    return "";
  }
}

export function createMockChain2(seed = 1, opts: MockOptions2 = {}): MockChain2 {
  const base = opts.now ?? Date.now;
  const storage = opts.storage === undefined ? defaultStorage() : opts.storage;
  const LIMITS = { ...MOCK2.limits, ...opts.limits };
  const stash = opts.stash === undefined ? mockStashParam(pageSearch()) : opts.stash;
  const warmup = Math.max(0, Math.min(24 * 3600, Math.floor(opts.warmupSeconds ?? 0)));

  function load(): MockState2 | null {
    if (!storage) return null;
    try {
      const raw = storage.getItem(MOCK2_STORAGE_KEY);
      if (!raw) return null;
      const s = JSON.parse(raw);
      return validState(s) ? s : null;
    } catch {
      return null;
    }
  }

  const loaded = load();
  let S: MockState2 = loaded ?? freshState(seed, base() - warmup * 1000);

  function save() {
    if (!storage) return;
    try {
      storage.setItem(MOCK2_STORAGE_KEY, JSON.stringify(S));
    } catch (e) {
      console.warn("[economy] v2 mock state not saved:", e);
    }
  }

  const now = () => base() + S.skewMs;
  /** The time for the next rule: the clock, never earlier than anything already seen. */
  function tick(): number {
    S.clock = Math.max(S.clock, now());
    return S.clock;
  }
  const txHash = () => `mock-${String(++S.nextTx).padStart(6, "0")}`;

  // --- bookkeeping

  const vendorByAccount = (accountId: string) => VENDOR_IDS.map((id) => S.vendors[id]).find((v) => v.accountId === accountId);

  function log(kind: LedgerKind, account: string, text: string, at: number) {
    const callsign = S.accounts[account]?.callsign ?? vendorByAccount(account)?.name ?? (account === MOCK2_HARBORMASTER ? "The Harbormaster" : undefined);
    const e: LedgerEvent = { kind, at, account, text };
    if (callsign) e.callsign = callsign;
    S.recent.unshift(e);
    if (S.recent.length > MOCK2.maxRecent) S.recent.length = MOCK2.maxRecent;
  }

  function flow(at: number, minted: number, burned: number) {
    if (minted <= 0 && burned <= 0) return;
    const bucket = Math.floor(at / 600_000);
    const last = S.flow[S.flow.length - 1];
    if (last && last.bucket === bucket) {
      last.minted += minted;
      last.burned += burned;
    } else S.flow.push({ bucket, minted, burned });
    const floor = Math.floor((at - 24 * HOUR) / 600_000);
    while (S.flow.length && S.flow[0].bucket < floor) S.flow.shift();
  }
  const minted = (n: number, at: number) => flow(at, n, 0);
  const burned = (n: number, at: number) => flow(at, 0, n);

  const bal = (a: { balances: Amounts }, t: TokenId) => a.balances[t] ?? 0;
  function credit(accountId: string, t: TokenId, n: number) {
    const a = S.accounts[accountId];
    if (!a || n <= 0) return;
    a.balances[t] = bal(a, t) + n;
  }
  function debit(a: AccountState, t: TokenId, n: number) {
    const left = bal(a, t) - n;
    if (left < 0) refuse("E_FUNDS", t === "scrip" ? `That's ${n} scrip. You've got ${bal(a, t)}.` : `You need ${units2(t, n)}. You've got ${bal(a, t)}.`);
    if (left === 0) delete a.balances[t];
    else a.balances[t] = left;
  }
  function player(accountId: string): AccountState {
    const a = S.accounts[accountId];
    if (!a) refuse("E_NOT_REGISTERED", "No dock pass. Claim one first.");
    return a as AccountState;
  }

  // --- the Harbormaster's wallet (reading 12)

  const hmMilli = (at: number) => decayMilli(S.hm.milli, at - S.hm.at, HALF_LIFE_MS);
  const hmBalance = (at: number) => Math.floor(hmMilli(at) / 1000);
  /** Decays the balance to now and burns the part lost. */
  function hmTouch(at: number) {
    const m = hmMilli(at);
    burned(Math.floor(S.hm.milli / 1000) - Math.floor(m / 1000), at);
    S.hm.milli = m;
    S.hm.at = at;
  }
  function hmPay(n: number, at: number) {
    hmTouch(at);
    S.hm.milli += n * 1000;
  }
  const hmView = (at: number) => harbormasterView(MOCK2_HARBORMASTER, hmBalance(at), S.hm.posture, S.hm.lastMemo);

  // --- guns

  const aliveGuns = () => Object.keys(S.weapons).length;
  function setCondition(w: Weapon, c: number) {
    w.condition = Math.max(0, Math.min(100, Math.floor(c)));
    w.value = appraise(w.frame, w.grade, w.condition);
  }
  function mintWeapon(frame: FrameId, stats: Stats, maker: string, makerCallsign: string, state: Weapon["state"], at: number): Weapon {
    // Reading 18: the limit counts guns alive.
    if (aliveGuns() >= LIMITS.guns) refuse("E_FULL", "The armoury's register is full.");
    const q = quality(frame, stats);
    const grade = gradeOf(q);
    const serial = `S-${String(S.nextSerial++).padStart(6, "0")}`;
    const w: Weapon = {
      serial,
      frame,
      grade,
      quality: q,
      stats,
      mods: [],
      condition: 100,
      maker,
      makerCallsign,
      owner: maker,
      builtAt: at,
      raids: 0,
      extractions: 0,
      owners: 1,
      recovered: 0,
      state,
      value: appraise(frame, grade, 100),
    };
    S.weapons[serial] = w;
    S.built++;
    return w;
  }
  function destroy(serial: string) {
    if (!S.weapons[serial]) return;
    delete S.weapons[serial];
    S.destroyed++;
  }
  /** Reading 1. */
  function gunOf(actor: string, serial: unknown): Weapon {
    const w = typeof serial === "string" ? S.weapons[serial] : undefined;
    if (!w) refuse("E_NO_WEAPON", "No such gun.");
    if ((w as Weapon).owner !== actor) refuse("E_NOT_OWNER", "That gun isn't yours.");
    return w as Weapon;
  }
  const BUSY: Record<Weapon["state"], string> = {
    held: "",
    raid: "That gun is out on a raid.",
    listed: "That gun is on the market. Take the listing down first.",
    vendor: "That gun is a vendor's stock.",
    wreck: "That gun is lying in a wreck in the yard.",
    impound: "That gun is in the impound. Buy it back first.",
  };
  function heldGun(actor: string, serial: unknown): Weapon {
    const w = gunOf(actor, serial);
    if (w.state !== "held") refuse("E_WEAPON_BUSY", BUSY[w.state]);
    return w;
  }
  const gunsOf = (accountId: string) =>
    Object.values(S.weapons)
      .filter((w) => w.owner === accountId)
      .sort((a, b) => (a.serial < b.serial ? -1 : 1));
  const heldGuns = (accountId: string) => gunsOf(accountId).filter((w) => w.state === "held");

  // --- expiry (lazy on chain; here every call and view sweeps first)

  const raidOpen = (id: number | null) => id !== null && !!S.raids[id] && !S.raids[id].closed;
  function burnWreck(i: number) {
    const w = S.wrecks[i];
    if (w.serial) destroy(w.serial);
    S.wrecks.splice(i, 1);
  }
  /**
   * Ines's meds go to the clinic: her stock halves every VENDOR_PRICING.medsHalfLifeHours, decayed lazily like the
   * Harbormaster's balance (thousandths, the same table), so her bid for meds recovers. What is used is simply gone.
   */
  function useMeds(at: number) {
    const v = S.vendors.ines;
    const since = v.medsAt ?? at;
    const milli = (v.stock.meds ?? 0) * 1000 + (v.medsMilli ?? 0);
    const left = at > since ? decayMilli(milli, at - since, VENDOR_PRICING.medsHalfLifeHours * HOUR) : milli;
    v.stock.meds = Math.floor(left / 1000);
    v.medsMilli = left % 1000;
    v.medsAt = Math.max(since, at);
  }
  function sweep(at: number) {
    useMeds(at);
    // Reading 4: a wreck on offer to an open raid waits for that raid.
    for (let i = S.wrecks.length - 1; i >= 0; i--) if (S.wrecks[i].expiresAt <= at && !raidOpen(S.wrecks[i].reservedBy)) burnWreck(i);
    for (let i = S.impound.length - 1; i >= 0; i--) {
      if (S.impound[i].expiresAt > at) continue;
      destroy(S.impound[i].serial);
      S.impound.splice(i, 1);
    }
  }

  /** Runs one state change; a refusal leaves the state as it was. */
  function tx<T extends object>(fn: (at: number) => T): TxResult & Partial<T> {
    const before = JSON.stringify(S);
    try {
      const at = tick();
      sweep(at);
      const out = fn(at);
      const hash = txHash();
      save();
      return { ok: true, txHash: hash, ...out };
    } catch (e) {
      S = JSON.parse(before) as MockState2;
      if (e instanceof Refusal) return { ok: false, error: e.message, code: e.code } as TxResult & Partial<T>;
      console.warn("[economy] v2 mock error:", e);
      return { ok: false, error: "Something went wrong at the dock. Try again." } as TxResult & Partial<T>;
    }
  }

  // =============================================================================================================
  // The rules, with an explicit actor and time so the other players use exactly the same ones

  function doRegister(accountId: string, callsign: string, at: number): Profile {
    const cs = normalizeCallsign(callsign);
    if (!cs) refuse("E_BAD_CALLSIGN", "Callsigns are 3–16 letters, digits, spaces, dashes, dots or underscores.");
    if (typeof accountId !== "string" || !accountId) refuse("E_BAD_AMOUNT", "No account.");
    if (S.accounts[accountId]) refuse("E_ALREADY_REGISTERED", "Already registered.");
    if (Object.values(S.accounts).some((a) => a.callsign === cs)) refuse("E_CALLSIGN_TAKEN", `${cs} is taken.`);
    if (Object.keys(S.accounts).length >= LIMITS.profiles) refuse("E_FULL", "The dock roll is full.");
    S.accounts[accountId] = freshAccount(accountId, cs as string, at, false);
    minted(RAID.starterScrip, at);
    return profileOf(S.accounts[accountId]);
  }

  // --- building

  function doBuild(actor: string, blueprint: BlueprintId, at: number) {
    const a = player(actor);
    const bp = BLUEPRINTS[blueprint];
    if (!bp || !Object.hasOwn(BLUEPRINTS, blueprint)) refuse("E_BAD_AMOUNT", "No such blueprint.");
    for (const m of MATERIAL_IDS) if (bal(a, m) < (bp.inputs[m] ?? 0)) refuse("E_FUNDS", `That takes ${describe(bp.inputs)}.`);
    if (bal(a, "scrip") < bp.fee) refuse("E_FUNDS", `The bench fee is ${bp.fee} scrip. You've got ${bal(a, "scrip")}.`);
    if (bp.kind === "weapon" && aliveGuns() >= LIMITS.guns) refuse("E_FULL", "The armoury's register is full.");
    for (const m of MATERIAL_IDS) if (bp.inputs[m]) debit(a, m, bp.inputs[m] as number);
    debit(a, "scrip", bp.fee);
    burned(bp.fee, at);
    if (bp.kind === "weapon") {
      const w = mintWeapon(blueprint as FrameId, rollStats(S, blueprint as FrameId), actor, a.callsign, "held", at);
      a.built++;
      log("build", actor, `${a.callsign} built ${graded(w)}, ${w.serial}.`, at);
      return { weapon: clone(w), minted: {} as Amounts };
    }
    credit(actor, blueprint as GoodId, bp.yields);
    log("build", actor, `${a.callsign} built ${units2(blueprint as GoodId, bp.yields)}.`, at);
    return { minted: { [blueprint]: bp.yields } as Amounts };
  }

  function doFit(actor: string, serial: string, mod: ModId, at: number) {
    const a = player(actor);
    const w = heldGun(actor, serial);
    if (!Object.hasOwn(MODS, mod)) refuse("E_BAD_AMOUNT", "No such mod.");
    if (w.mods.some((m) => MODS[m].slot === MODS[mod].slot)) refuse("E_SLOT_TAKEN", `The ${MODS[mod].slot} slot already has a mod.`);
    debit(a, mod, 1);
    w.mods.push(mod);
    log("fit", actor, `${a.callsign} fitted ${/^[aeiou]/.test(NOUN[mod][0]) ? "an" : "a"} ${NOUN[mod][0]} to ${gunName(w)}.`, at);
    return { weapon: clone(w) };
  }

  function doRepair(actor: string, serial: string, points: number | undefined | null, at: number) {
    const a = player(actor);
    const w = heldGun(actor, serial);
    // Reading 10.
    if (w.condition === 0) refuse("E_WORN_OUT", "It's worn out. It can only be scrapped.");
    const room = 100 - w.condition;
    if (room === 0) refuse("E_BAD_AMOUNT", "It's already as good as new.");
    const pts = points === undefined || points === null ? room : Math.min(room, amountOk(points, 100));
    const cost = pts * CONDITION.scripPerPoint;
    const copper = Math.ceil(pts / CONDITION.pointsPerCopper);
    if (bal(a, "scrip") < cost) refuse("E_FUNDS", `That's ${cost} scrip. You've got ${bal(a, "scrip")}.`);
    debit(a, "copper", copper);
    debit(a, "scrip", cost);
    S.vendors.moss.scrip += cost;
    setCondition(w, w.condition + pts);
    log("repair", actor, `${a.callsign} had ${gunName(w)} repaired to ${w.condition}. Moss took ${cost}.`, at);
    return { weapon: clone(w), cost };
  }

  function doScrap(actor: string, serial: string, at: number) {
    const a = player(actor);
    const w = heldGun(actor, serial);
    destroy(w.serial);
    const out: Amounts = {};
    for (const m of MATERIAL_IDS) {
      const n = CONDITION.scrap[m] ?? 0;
      if (n > 0) {
        credit(actor, m, n);
        out[m] = n;
      }
    }
    log("scrap", actor, `${a.callsign} scrapped ${gunName(w)} for ${describe(out)}.`, at);
    return { minted: out };
  }

  // --- raids

  function closeRaid(r: RaidState) {
    r.closed = true;
    for (const w of S.wrecks) if (w.reservedBy === r.id) w.reservedBy = null;
    // Closed raids are only kept for a while; open ones stay.
    const closed = Object.values(S.raids).filter((x) => x.closed);
    if (closed.length > MOCK2.keptRaids * 2) for (const x of closed.sort((a, b) => b.id - a.id).slice(MOCK2.keptRaids)) delete S.raids[x.id];
  }

  function wreckView(w: WreckState): Wreck {
    return { id: w.id, spot: w.spot, owner: w.owner, callsign: w.callsign, weapon: w.serial && S.weapons[w.serial] ? clone(S.weapons[w.serial]) : null, items: clone(w.items), at: w.at, expiresAt: w.expiresAt };
  }
  function raidView(r: RaidState): Raid {
    const wrecks = r.wreckIds.map((id) => S.wrecks.find((w) => w.id === id)).filter((w): w is WreckState => !!w);
    return {
      raidId: r.id,
      startedAt: r.startedAt,
      loadout: { ...r.loadout },
      containers: clone(r.containers),
      wrecks: wrecks.map(wreckView),
      invoiceStart: r.invoiceStart,
      harbormaster: { ...r.harbormaster },
    };
  }

  /** `startedAt` is `at` for the player; the other players' raids are entered already over. */
  function doStartRaid(actor: string, loadout: Loadout, at: number, startedAt = at): Raid {
    const a = player(actor);
    const l = loadout as Partial<Loadout> | null;
    if (!l || typeof l !== "object" || !isWhole(l.plates) || !isWhole(l.charges) || !isWhole(l.mags)) refuse("E_BAD_AMOUNT", "Bad loadout.");
    const lo = l as Loadout;
    // Reading 3.
    if (lo.plates > RAID.maxPlates || lo.charges > RAID.maxCharges || lo.mags > RAID.maxMags) {
      refuse("E_BAD_AMOUNT", `A raid takes ${RAID.maxPlates} plate, ${RAID.maxCharges} charges and ${RAID.maxMags} magazines at most.`);
    }
    if (a.lastRaidAt !== null && startedAt - a.lastRaidAt < RAID.secondsBetweenRaids * 1000) {
      refuse("E_TOO_SOON", `Too soon. Wait ${Math.ceil((RAID.secondsBetweenRaids * 1000 - (startedAt - a.lastRaidAt)) / 1000)} s between raids.`);
    }
    // One raid at a time: a new one abandons the old. Its gun comes back; its other gear is lost.
    if (a.activeRaid !== null && raidOpen(a.activeRaid)) {
      const old = S.raids[a.activeRaid];
      if (old.loadout.weapon && S.weapons[old.loadout.weapon]) S.weapons[old.loadout.weapon].state = "held";
      closeRaid(old);
    }
    let gun: Weapon | null = null;
    if (lo.weapon !== null && lo.weapon !== undefined) {
      gun = heldGun(actor, lo.weapon);
      if (gun.condition <= 0) refuse("E_WORN_OUT", "That gun is worn out. It can only be scrapped.");
    }
    debit(a, "plate", lo.plates);
    debit(a, "charge", lo.charges);
    debit(a, "ammo", lo.mags);
    if (gun) gun.state = "raid";

    const spots = shuffle(S, Array.from({ length: RAID.spotCount }, (_, i) => i));
    const containers: Container[] = spots.slice(0, RAID.containers).map((spot) => {
      const d = lootDraw(S);
      return { spot, tokenId: d.id, amount: d.n, bonded: false };
    });
    if (a.arrears >= INVOICE.bondedAt) {
      for (const spot of spots.slice(RAID.containers, RAID.containers + RAID.bonded)) containers.push({ spot, tokenId: pickOne(S, BONDED_LOOT), amount: 2, bonded: true });
    }
    containers.sort((x, y) => x.spot - y.spot);

    const id = S.nextRaid++;
    // Reading 4: the newest live wrecks that aren't the caller's or on offer to another open raid.
    const wrecks = S.wrecks.filter((w) => w.owner !== actor && w.expiresAt > at && !raidOpen(w.reservedBy)).slice(0, RAID.wrecks);
    for (const w of wrecks) w.reservedBy = id;
    const raid: RaidState = {
      id,
      player: actor,
      startedAt,
      loadout: { weapon: gun ? gun.serial : null, plates: lo.plates, charges: lo.charges, mags: lo.mags },
      containers,
      wreckIds: wrecks.map((w) => w.id),
      invoiceStart: invoiceStart(a.extractions, a.arrears),
      harbormaster: hmView(at),
      closed: false,
    };
    S.raids[id] = raid;
    a.raids++;
    a.lastRaidAt = startedAt;
    a.activeRaid = id;
    log("raid_start", actor, `${a.callsign} went over the fence with ${gun ? gunName(gun) : "the issue rifle"}.`, at);
    return raidView(raid);
  }

  function reportShape(r: RaidReport): boolean {
    return (
      !!r &&
      typeof r === "object" &&
      Array.isArray(r.opened) &&
      r.opened.every(isWhole) &&
      Array.isArray(r.wrecks) &&
      r.wrecks.every(isWhole) &&
      !!r.parts &&
      isWhole(r.parts.servo) &&
      isWhole(r.parts.rotor) &&
      !!r.kills &&
      isWhole(r.kills.gull) &&
      isWhole(r.kills.hound) &&
      isWhole(r.uplinks) &&
      !!r.used &&
      isWhole(r.used.plates) &&
      isWhole(r.used.charges) &&
      isWhole(r.used.mags)
    );
  }

  /** The checks `extract` and `die` share (docs/CONTRACT_V2.md → Ending a raid), and the invoice. */
  function ending(actor: string, raidId: number, report: RaidReport, at: number) {
    const a = player(actor);
    const found = isWhole(raidId) ? S.raids[raidId] : undefined;
    // Reading 5: somebody else's raid is no raid of yours.
    if (!found || found.player !== actor) refuse("E_NO_RAID", "No such raid.");
    const r = found as RaidState;
    if (r.closed) refuse("E_RAID_CLOSED", "That raid is already closed.");
    if (!reportShape(report)) refuse("E_BAD_REPORT", "The raid report is malformed.");
    if (new Set(report.opened).size !== report.opened.length) refuse("E_DUPLICATE", "A container is in the report twice.");
    if (new Set(report.wrecks).size !== report.wrecks.length) refuse("E_DUPLICATE", "A wreck is in the report twice.");
    const boxes = report.opened.map((spot) => r.containers.find((c) => c.spot === spot) ?? refuse("E_NOT_IN_MANIFEST", `Spot ${spot} wasn't on this raid's manifest.`));
    const wrecks = report.wrecks.map((id) => {
      const w = r.wreckIds.includes(id) ? S.wrecks.find((x) => x.id === id) : undefined;
      return w ?? refuse("E_NOT_IN_MANIFEST", `Wreck ${id} wasn't on this raid's manifest.`);
    });
    const seconds = Math.max(0, Math.floor((at - r.startedAt) / 1000));
    const { kills, parts, used } = report;
    if (report.uplinks > RAID.maxUplinks) refuse("E_BAD_REPORT", `There are only ${RAID.maxUplinks} uplinks.`);
    if (kills.gull > RAID.maxKills.gull || kills.hound > RAID.maxKills.hound) refuse("E_BAD_REPORT", "More machines than the yard holds.");
    if (kills.gull + kills.hound > Math.floor(seconds / RAID.secondsPerKill)) refuse("E_BAD_REPORT", "More machines than the time allows.");
    if (parts.servo > kills.hound || parts.rotor > kills.gull) refuse("E_BAD_REPORT", "More parts than machines destroyed.");
    if (used.plates > r.loadout.plates || used.charges > r.loadout.charges || used.mags > r.loadout.mags) refuse("E_BAD_REPORT", "More gear used than was brought.");
    const cargo: Amounts<MaterialId> = {};
    for (const c of boxes) cargo[c.tokenId] = (cargo[c.tokenId] ?? 0) + c.amount;
    if (parts.servo) cargo.servo = (cargo.servo ?? 0) + parts.servo;
    if (parts.rotor) cargo.rotor = (cargo.rotor ?? 0) + parts.rotor;
    // Reading 5: cargo and parts at their weights, 2 for each recovered gun.
    const weight = weightOf(cargo, wrecks.filter((w) => w.serial).length);
    if (weight > RAID.carryLimit) refuse("E_OVER_LIMIT", `That's ${weight} weight. The limit is ${RAID.carryLimit}.`);
    const invoice = invoiceTotal({ start: r.invoiceStart, seconds, seals: boxes.length, weight, uplinks: report.uplinks, gulls: kills.gull, hounds: kills.hound });
    const unused = { plate: r.loadout.plates - used.plates, charge: r.loadout.charges - used.charges, ammo: r.loadout.mags - used.mags };
    return { a, r, boxes, wrecks, cargo, seconds, invoice, unused };
  }

  function doExtract(actor: string, raidId: number, report: RaidReport, at: number) {
    const { a, r, boxes, wrecks, cargo, seconds, invoice, unused } = ending(actor, raidId, report, at);
    const need = RAID.minSeconds + RAID.perContainerSeconds * boxes.length;
    if (seconds < need) refuse("E_TOO_SOON", `The boat isn't in yet. ${need - seconds} s.`);
    const out: Amounts = {};
    const mint = (t: TokenId, n: number) => {
      if (n <= 0) return;
      credit(actor, t, n);
      out[t] = (out[t] ?? 0) + n;
    };
    for (const m of MATERIAL_IDS) mint(m, cargo[m] ?? 0);
    let weapon: Weapon | null = null;
    if (r.loadout.weapon && S.weapons[r.loadout.weapon]) {
      const w = S.weapons[r.loadout.weapon];
      setCondition(w, w.condition - CONDITION.perRaid);
      w.raids++;
      w.extractions++;
      w.state = "held";
      weapon = clone(w);
    }
    // Reading 6: gear handed back is the caller's own, not minted.
    for (const t of CONSUMABLE_IDS) credit(actor, t, unused[t]);
    const recovered: Weapon[] = [];
    for (const wr of wrecks) {
      if (wr.serial && S.weapons[wr.serial]) {
        const g = S.weapons[wr.serial];
        g.owner = actor;
        g.owners++;
        g.recovered++;
        setCondition(g, g.condition - CONDITION.recovered);
        g.state = "held";
        recovered.push(clone(g));
        log("recover", actor, `${a.callsign} carried ${wr.callsign}'s ${gunName(g)} out of a wreck.`, at);
      } else if (wr.items.length) {
        log("recover", actor, `${a.callsign} cleared out ${wr.callsign}'s wreck.`, at);
      }
      for (const it of wr.items) mint(it.tokenId, it.amount);
      S.wrecks.splice(S.wrecks.indexOf(wr), 1);
    }
    closeRaid(r);
    a.extractions++;
    a.activeRaid = null;
    a.arrears += Math.floor((invoice * INVOICE.arrearsOnExtract) / 100);
    log("extract", actor, `${a.callsign} reached the boat with ${describe(out)}. Invoice ${invoice}.`, at);
    return { minted: out, weapon, recovered, invoice, arrears: a.arrears };
  }

  function doDie(actor: string, raidId: number, report: RaidReport, spot: number, by: DeathBy, at: number) {
    const { a, r, cargo, invoice, unused } = ending(actor, raidId, report, at);
    if (!isWhole(spot) || spot >= RAID.spotCount) refuse("E_BAD_REPORT", "No such spot.");
    if (by !== "machines" && by !== "bailiff") refuse("E_BAD_REPORT", "Killed by what?");
    const gun = r.loadout.weapon ? (S.weapons[r.loadout.weapon] ?? null) : null;
    // Reading 7.
    if (gun) gun.raids++;
    let wreckId: number | null = null;
    let impounded = false;
    if (by === "machines") {
      const items: { tokenId: TokenId; amount: number }[] = [];
      for (const m of MATERIAL_IDS) if (cargo[m]) items.push({ tokenId: m, amount: cargo[m] as number });
      for (const t of CONSUMABLE_IDS) if (unused[t] > 0) items.push({ tokenId: t, amount: unused[t] });
      // Reading 8: the issue rifle and nothing at all leaves no wreck.
      if (gun || items.length) {
        // Reading 9.
        while (S.wrecks.length >= LIMITS.wrecks) {
          let i = S.wrecks.length - 1;
          while (i > 0 && raidOpen(S.wrecks[i].reservedBy) && S.wrecks[i].reservedBy !== r.id) i--;
          burnWreck(i);
        }
        wreckId = S.nextWreck++;
        S.wrecks.unshift({ id: wreckId, spot, owner: actor, callsign: a.callsign, serial: gun ? gun.serial : null, items, at, expiresAt: at + RAID.wreckHours * HOUR, reservedBy: null });
        if (gun) gun.state = "wreck";
        log("wreck", actor, gun ? `${a.callsign}'s ${gunName(gun)} is in a wreck in the yard, spot ${spot}.` : `${a.callsign} left a wreck in the yard, spot ${spot}: ${describe(Object.fromEntries(items.map((i) => [i.tokenId, i.amount])))}.`, at);
      }
    } else if (gun) {
      const fee = Math.floor((gun.value * RAID.buyBackPct) / 100);
      gun.state = "impound";
      S.impound.push({ serial: gun.serial, owner: actor, fee, expiresAt: at + RAID.impoundHours * HOUR });
      impounded = true;
      log("impound", actor, `The Bailiff took ${a.callsign}'s ${gunName(gun)}. ${fee} scrip releases it.`, at);
    }
    closeRaid(r);
    a.deaths++;
    a.activeRaid = null;
    a.arrears += Math.floor((invoice * INVOICE.arrearsOnDeath) / 100);
    return { wreckId, impounded, invoice, arrears: a.arrears };
  }

  // --- arrears

  function doSettle(actor: string, amount: number, at: number) {
    const a = player(actor);
    amountOk(amount);
    if (a.arrears <= 0) refuse("E_NOTHING_OWED", "Nothing is owed.");
    const pay = Math.min(amount, Math.ceil(a.arrears / INVOICE.settleRate));
    // Reading 11.
    if (bal(a, "scrip") < pay) refuse("E_FUNDS", `That's ${pay} scrip. You've got ${bal(a, "scrip")}.`);
    const cleared = Math.min(a.arrears, pay * INVOICE.settleRate);
    debit(a, "scrip", pay);
    hmPay(pay, at);
    a.arrears -= cleared;
    log("settle", actor, `${a.callsign} paid the Harbormaster ${pay}. ${a.arrears ? `${a.arrears} still owed` : "Account clear"}.`, at);
    return { cleared, arrears: a.arrears };
  }

  function doBuyBack(actor: string, serial: string, at: number) {
    const a = player(actor);
    const i = S.impound.findIndex((x) => x.serial === serial && x.owner === actor);
    if (i < 0 || !S.weapons[serial]) refuse("E_NOT_IMPOUNDED", "That gun isn't in the impound.");
    const { fee } = S.impound[i];
    if (bal(a, "scrip") < fee) refuse("E_FUNDS", `The release fee is ${fee} scrip. You've got ${bal(a, "scrip")}.`);
    debit(a, "scrip", fee);
    hmPay(fee, at);
    S.impound.splice(i, 1);
    const w = S.weapons[serial];
    w.state = "held";
    log("buy_back", actor, `${a.callsign} bought ${gunName(w)} back from the impound for ${fee}.`, at);
    return { weapon: clone(w), cost: fee };
  }

  // --- vendors

  const goodsOf = (id: VendorId) => (VENDORS[id].builds as BlueprintId[]).filter((b) => BLUEPRINTS[b].kind !== "weapon") as GoodId[];
  const goodPrice = (v: VendorState, g: GoodId, stock: number) => v.prices[g] ?? unitPrice(g, stock);
  const gunAsk = (v: VendorState, w: Weapon) => v.prices[w.serial] ?? gunPrice(w.value);
  const vendorGuns = (v: VendorState) => gunsOf(v.accountId).filter((w) => w.state === "vendor");
  const vendorOpen = (v: VendorState) => VENDORS[v.id].buys.some((m) => v.scrip - vendorBid(m, v.stock[m] ?? 0) >= VENDOR_PRICING.float);

  /** What `amount` units fetch, each priced at the stock it meets (reading 13). */
  function sellQuote(v: VendorState, m: MaterialId, amount: number): number {
    let paid = 0;
    for (let i = 0; i < amount; i++) paid += vendorBid(m, (v.stock[m] ?? 0) + i);
    return paid;
  }

  function doSell(actor: string, id: VendorId, token: MaterialId, amount: number, at: number) {
    const a = player(actor);
    const v = S.vendors[id];
    if (!v || !Object.hasOwn(VENDORS, id)) refuse("E_DOESNT_BUY", "Nobody by that name buys here.");
    amountOk(amount);
    if (!(VENDORS[id].buys as readonly string[]).includes(token)) refuse("E_DOESNT_BUY", `${v.name} doesn't buy that.`);
    if (bal(a, token) < amount) refuse("E_FUNDS", `You've got ${units2(token, bal(a, token))}.`);
    const paid = sellQuote(v, token, amount);
    if (v.scrip - paid < VENDOR_PRICING.float) refuse("E_VENDOR_BROKE", `${v.name} can't cover that. Her till is at ${v.scrip}.`);
    debit(a, token, amount);
    v.scrip -= paid;
    v.stock[token] = (v.stock[token] ?? 0) + amount;
    credit(actor, "scrip", paid);
    log("sale", actor, `${a.callsign} sold ${units2(token, amount)} to ${v.name} for ${paid}.`, at);
    return { paid };
  }

  function doBuy(actor: string, id: VendorId, token: GoodId, amount: number, at: number) {
    const a = player(actor);
    const v = S.vendors[id];
    if (!v || !Object.hasOwn(VENDORS, id)) refuse("E_DOESNT_SELL", "Nobody by that name sells here.");
    amountOk(amount);
    if (!goodsOf(id).includes(token)) refuse("E_DOESNT_SELL", `${v.name} doesn't sell that.`);
    const stock = v.goods[token] ?? 0;
    if (stock < amount) refuse("E_NO_STOCK", stock ? `${v.name} has ${units2(token, stock)}.` : `${v.name} is out of ${NOUN[token][1]}.`);
    let cost = 0;
    for (let i = 0; i < amount; i++) cost += goodPrice(v, token, stock - i);
    if (bal(a, "scrip") < cost) refuse("E_FUNDS", `That's ${cost} scrip. You've got ${bal(a, "scrip")}.`);
    debit(a, "scrip", cost);
    v.scrip += cost;
    v.goods[token] = stock - amount;
    credit(actor, token, amount);
    log("purchase", actor, `${a.callsign} bought ${units2(token, amount)} from ${v.name} for ${cost}.`, at);
    return { cost };
  }

  function doBuyGun(actor: string, id: VendorId, serial: string, at: number) {
    const a = player(actor);
    const v = S.vendors[id];
    if (!v || !Object.hasOwn(VENDORS, id)) refuse("E_DOESNT_SELL", "Nobody by that name sells here.");
    const w = typeof serial === "string" ? S.weapons[serial] : undefined;
    if (!w || w.owner !== v.accountId || w.state !== "vendor") refuse("E_NO_WEAPON", `${v.name} has no such gun for sale.`);
    const gun = w as Weapon;
    const cost = gunAsk(v, gun);
    if (bal(a, "scrip") < cost) refuse("E_FUNDS", `That's ${cost} scrip. You've got ${bal(a, "scrip")}.`);
    debit(a, "scrip", cost);
    v.scrip += cost;
    delete v.prices[gun.serial];
    gun.owner = actor;
    gun.owners++;
    gun.state = "held";
    log("purchase", actor, `${a.callsign} bought ${graded(gun)}, ${gun.serial}, from ${v.name} for ${cost}.`, at);
    return { weapon: clone(gun), cost };
  }

  function vendorOf(actor: string): VendorState {
    return vendorByAccount(actor) ?? refuse("E_NOT_VENDOR", "Only a vendor's own account can do that.");
  }

  function doVendorBuild(actor: string, blueprint: BlueprintId, memo: string, at: number) {
    const v = vendorOf(actor);
    const bp = Object.hasOwn(BLUEPRINTS, blueprint) ? BLUEPRINTS[blueprint] : undefined;
    // Reading 15.
    if (!bp || !(VENDORS[v.id].builds as BlueprintId[]).includes(blueprint)) refuse("E_DOESNT_SELL", `${v.name} doesn't make that.`);
    const b = bp as (typeof BLUEPRINTS)[BlueprintId];
    for (const m of MATERIAL_IDS) if ((v.stock[m] ?? 0) < (b.inputs[m] ?? 0)) refuse("E_NO_STOCK", `${v.name} hasn't the parts: that takes ${describe(b.inputs)}.`);
    if (b.kind === "weapon" && aliveGuns() >= LIMITS.guns) refuse("E_FULL", "The armoury's register is full.");
    for (const m of MATERIAL_IDS) if (b.inputs[m]) v.stock[m] = (v.stock[m] ?? 0) - (b.inputs[m] as number);
    v.lastMemo = String(memo ?? "").slice(0, 280) || null;
    if (b.kind === "weapon") {
      const w = mintWeapon(blueprint as FrameId, rollStats(S, blueprint as FrameId), v.accountId, v.name.toUpperCase(), "vendor", at);
      log("vendor_build", actor, `${v.name} built ${graded(w)}, ${w.serial}.`, at);
      return { weapon: clone(w), minted: {} as Amounts };
    }
    v.goods[blueprint as GoodId] = (v.goods[blueprint as GoodId] ?? 0) + b.yields;
    log("vendor_build", actor, `${v.name} built ${units2(blueprint as GoodId, b.yields)}.`, at);
    return { minted: { [blueprint]: b.yields } as Amounts };
  }

  function doVendorPrice(actor: string, what: { serial?: string | null; tokenId?: GoodId | null }, price: number, memo: string, at: number) {
    const v = vendorOf(actor);
    amountOk(price, MOCK2.maxPrice);
    const serial = what?.serial ?? null;
    const token = what?.tokenId ?? null;
    if ((serial === null) === (token === null)) refuse("E_BAD_AMOUNT", "Price one gun or one kind of goods.");
    if (serial !== null) {
      const w = S.weapons[serial];
      if (!w || w.owner !== v.accountId || w.state !== "vendor") refuse("E_NO_WEAPON", `${v.name} has no such gun for sale.`);
      v.prices[serial] = price;
      log("vendor_price", actor, `${v.name} priced ${gunName(w)} at ${price}.`, at);
    } else {
      if (!goodsOf(v.id).includes(token as GoodId)) refuse("E_DOESNT_SELL", `${v.name} doesn't sell that.`);
      v.prices[token as GoodId] = price;
      log("vendor_price", actor, `${v.name} priced ${NOUN[token as GoodId][1]} at ${price}.`, at);
    }
    v.lastMemo = String(memo ?? "").slice(0, 280) || null;
    return {};
  }

  // --- the export desk (reading 16)

  const recentMilli = (m: MaterialId, at: number) => {
    const e = S.exported[m];
    return e ? decayMilli(e.milli, at - e.at, HALF_LIFE_MS) : 0;
  };

  function doExport(actor: string, token: MaterialId, amount: number, at: number) {
    const v = vendorByAccount(actor);
    const a = v ? null : player(actor);
    amountOk(amount);
    if (!Object.hasOwn(MATERIALS, token)) refuse("E_DOESNT_BUY", "The export desk only takes materials.");
    if (v && (v.stock[token] ?? 0) < amount) refuse("E_NO_STOCK", `${v.name} holds ${units2(token, v.stock[token] ?? 0)}.`);
    if (a && bal(a, token) < amount) refuse("E_FUNDS", `You've got ${units2(token, bal(a, token))}.`);
    let milli = recentMilli(token, at);
    let paid = 0;
    for (let i = 0; i < amount; i++) {
      paid += exportPrice(token, milli);
      milli += 1000;
    }
    S.exported[token] = { milli, at };
    if (v) {
      v.stock[token] = (v.stock[token] ?? 0) - amount;
      v.scrip += paid;
    } else if (a) {
      debit(a, token, amount);
      credit(actor, "scrip", paid);
    }
    minted(paid, at);
    log("export", actor, `${v ? v.name : (a as AccountState).callsign} sent ${units2(token, amount)} to the freighter for ${paid} new scrip.`, at);
    return { paid };
  }

  // --- the market

  function doListWeapon(actor: string, serial: string, price: number, at: number) {
    const a = player(actor);
    amountOk(price, MOCK2.maxPrice);
    const w = heldGun(actor, serial);
    if (S.listings.length >= LIMITS.listings) refuse("E_FULL", "The board is full.");
    w.state = "listed";
    const id = S.nextListing++;
    S.listings.unshift({ id, seller: actor, callsign: a.callsign, price, at, serial: w.serial });
    log("listing", actor, `${a.callsign} listed ${graded(w)}, ${w.serial}, for ${price}.`, at);
    return { id };
  }

  function doListItem(actor: string, token: Exclude<TokenId, "scrip">, amount: number, price: number, at: number) {
    const a = player(actor);
    amountOk(amount);
    amountOk(price, MOCK2.maxPrice);
    if (!Object.hasOwn(NOUN, token) || (token as TokenId) === "scrip") refuse("E_BAD_AMOUNT", "That can't be listed.");
    if (bal(a, token) < amount) refuse("E_FUNDS", `You've got ${units2(token, bal(a, token))}.`);
    if (S.listings.length >= LIMITS.listings) refuse("E_FULL", "The board is full.");
    debit(a, token, amount);
    const id = S.nextListing++;
    S.listings.unshift({ id, seller: actor, callsign: a.callsign, price, at, item: { tokenId: token, amount } });
    log("listing", actor, `${a.callsign} listed ${units2(token, amount)} for ${price}.`, at);
    return { id };
  }

  function doBuyListing(actor: string, id: number, at: number) {
    const a = player(actor);
    const i = S.listings.findIndex((l) => l.id === id);
    if (i < 0) refuse("E_NO_LISTING", "That listing is gone.");
    const l = S.listings[i];
    // Reading 1.
    if (l.seller === actor) refuse("E_NO_LISTING", "That's your own listing. Take it down instead.");
    if (bal(a, "scrip") < l.price) refuse("E_FUNDS", `That's ${l.price} scrip. You've got ${bal(a, "scrip")}.`);
    // Reading 17.
    const makerCut = Math.floor((l.price * MARKET.makerPct) / 100);
    const burnCut = Math.floor((l.price * (MARKET.feePct - MARKET.makerPct)) / 100);
    debit(a, "scrip", l.price);
    credit(l.seller, "scrip", l.price - makerCut - burnCut);
    S.listings.splice(i, 1);
    if (l.serial && S.weapons[l.serial]) {
      const w = S.weapons[l.serial];
      const maker = S.accounts[w.maker];
      const makerVendor = vendorByAccount(w.maker);
      if (maker) {
        credit(maker.accountId, "scrip", makerCut);
        maker.royalties += makerCut;
        burned(burnCut, at);
      } else if (makerVendor) {
        makerVendor.scrip += makerCut;
        burned(burnCut, at);
      } else burned(burnCut + makerCut, at);
      w.owner = actor;
      w.owners++;
      w.state = "held";
      const key = `${w.frame}:${w.grade}`;
      S.sales[key] = [...(S.sales[key] ?? []), l.price].slice(-MOCK2.keptSales);
      log("market_sale", actor, `${a.callsign} bought ${l.callsign}'s ${w.grade}-grade ${gunName(w)} for ${l.price}. ${w.makerCallsign} earned ${makerCut} as its maker.`, at);
      return { paid: l.price, weapon: clone(w) };
    }
    burned(burnCut + makerCut, at);
    if (l.item) {
      credit(actor, l.item.tokenId, l.item.amount);
      log("market_sale", actor, `${a.callsign} bought ${l.callsign}'s ${units2(l.item.tokenId, l.item.amount)} for ${l.price}.`, at);
    }
    return { paid: l.price };
  }

  function doCancelListing(actor: string, id: number, at: number) {
    const a = player(actor);
    const i = S.listings.findIndex((l) => l.id === id);
    if (i < 0) refuse("E_NO_LISTING", "That listing is gone.");
    const l = S.listings[i];
    if (l.seller !== actor) refuse("E_NOT_OWNER", "That isn't your listing.");
    if (l.serial && S.weapons[l.serial]) S.weapons[l.serial].state = "held";
    if (l.item) credit(actor, l.item.tokenId, l.item.amount);
    S.listings.splice(i, 1);
    log("listing", actor, `${a.callsign} took ${l.serial && S.weapons[l.serial] ? gunName(S.weapons[l.serial]) : l.item ? units2(l.item.tokenId, l.item.amount) : "a listing"} off the board.`, at);
    return {};
  }

  // --- the Harbormaster's agent

  function doPosture(actor: string, posture: Posture, memo: string, at: number) {
    if (actor !== MOCK2_HARBORMASTER) refuse("E_NOT_HARBORMASTER", "Only the Harbormaster's account can do that.");
    if (posture !== "patrols" && posture !== "pursuit") refuse("E_BAD_AMOUNT", "No such posture.");
    hmTouch(at);
    S.hm.posture = posture;
    S.hm.lastMemo = String(memo ?? "").slice(0, 280) || null;
    const h = hmView(at);
    log("posture", actor, posture === "pursuit" ? `The Harbormaster ordered pursuit. The Bailiff goes out at ${h.bailiffAt}.` : `The Harbormaster ordered patrols. ${h.bonusDrones} extra units in the yard.`, at);
    return { harbormaster: h };
  }

  // =============================================================================================================
  // Views

  function profileOf(a: AccountState): Profile {
    const { accountId, callsign, registeredAt, raids, extractions, deaths, arrears, activeRaid, built, royalties } = a;
    return { accountId, callsign, registeredAt, raids, extractions, deaths, arrears, activeRaid, built, royalties };
  }

  function vendorView(v: VendorState): Vendor {
    const she = v.name;
    const open = vendorOpen(v);
    const bids: Quote[] = VENDORS[v.id].buys.map((m) => {
      const stock = v.stock[m] ?? 0;
      const target = MATERIALS[m].target;
      const price = vendorBid(m, stock);
      const reason = !open
        ? `${she}'s till is at ${v.scrip}. She isn't buying until she sells something.`
        : stock < target
          ? `${she} holds ${stock} of the ${target} she wants, so she pays over the book.`
          : stock > target
            ? `${she} holds ${stock}, more than the ${target} she wants, so she pays under the book.`
            : `${she} holds the ${target} she wants. Book price.`;
      return { tokenId: m, price, reason };
    });
    const goods = goodsOf(v.id).map((g) => {
      const stock = v.goods[g] ?? 0;
      const set = v.prices[g] !== undefined;
      const reason = stock === 0 ? "Out of stock." : set ? `${she}'s own price.` : stock < VENDOR_PRICING.scarceUnder ? `Only ${stock} left, so it costs more.` : `Parts at book, plus her ${VENDOR_PRICING.goodsPct - 100}%.`;
      return { tokenId: g, price: goodPrice(v, g, stock), stock, reason };
    });
    const stock: Amounts<MaterialId> = {};
    for (const m of MATERIAL_IDS) if ((v.stock[m] ?? 0) > 0) stock[m] = v.stock[m];
    return {
      id: v.id,
      accountId: v.accountId,
      name: v.name,
      open,
      scrip: v.scrip,
      stock,
      bids,
      goods,
      guns: vendorGuns(v).map((w) => ({ weapon: clone(w), price: gunAsk(v, w) })),
      lastMemo: v.lastMemo,
    };
  }

  function listingView(l: ListingState): Listing {
    const out: Listing = { id: l.id, seller: l.seller, callsign: l.callsign, price: l.price, at: l.at };
    if (l.serial && S.weapons[l.serial]) out.weapon = clone(S.weapons[l.serial]);
    if (l.item) out.item = { ...l.item };
    return out;
  }

  function economyView(at: number): EconomyView {
    const floor = Math.floor((at - 24 * HOUR) / 600_000);
    const day = S.flow.filter((f) => f.bucket >= floor);
    const scrip = Object.values(S.accounts).reduce((s, a) => s + bal(a, "scrip"), 0) + VENDOR_IDS.reduce((s, id) => s + S.vendors[id].scrip, 0) + hmBalance(at);
    // The Harbormaster's decay since it was last touched is burned already, as far as the supply shows.
    const pendingBurn = Math.floor(S.hm.milli / 1000) - hmBalance(at);
    const lastSales: EconomyView["lastSales"] = [];
    for (const frame of FRAME_IDS) {
      for (const grade of ["A", "B", "C", "D"] as Grade[]) {
        const prices = S.sales[`${frame}:${grade}`];
        if (prices?.length) lastSales.push({ frame, grade, prices: [...prices] });
      }
    }
    return {
      scripSupply: scrip,
      minted24h: day.reduce((s, f) => s + f.minted, 0),
      burned24h: day.reduce((s, f) => s + f.burned, 0) + pendingBurn,
      players: Object.keys(S.accounts).length,
      weaponsBuilt: S.built,
      weaponsAlive: aliveGuns(),
      weaponsDestroyed: S.destroyed,
      lastSales,
    };
  }

  function leaderboard(): Leaderboard {
    const rows = (value: (a: AccountState) => number): LeaderRow[] =>
      Object.values(S.accounts)
        .map((a) => ({ accountId: a.accountId, callsign: a.callsign, value: value(a) }))
        .filter((r) => r.value > 0)
        .sort((x, y) => y.value - x.value || (x.accountId < y.accountId ? -1 : 1))
        .slice(0, 10);
    return {
      // Reading 18.
      netWorth: rows((a) => bal(a, "scrip") + heldGuns(a.accountId).reduce((s, w) => s + w.value, 0)),
      extractions: rows((a) => a.extractions),
      makers: rows((a) => a.royalties),
    };
  }

  // =============================================================================================================
  // Ambient play: the other players and the three agents, through the rules above

  const npcs = () => Object.values(S.accounts).filter((a) => a.npc);
  /** One attempt at a rule by somebody who isn't the player; a refusal is undone and isn't news. */
  function attempt(fn: () => void): boolean {
    const before = JSON.stringify(S);
    try {
      fn();
      return true;
    } catch (e) {
      S = JSON.parse(before) as MockState2;
      if (!(e instanceof Refusal)) console.warn("[economy] v2 mock: ambient error:", e);
      return false;
    }
  }

  /** What another player keeps back to build with. A broke one keeps nothing. */
  const KEEP: Amounts<MaterialId> = { copper: 6, chips: 5, servo: 2, rotor: 3, core: 1 };
  const canBuild = (a: AccountState, id: BlueprintId) => bal(a, "scrip") >= BLUEPRINTS[id].fee && MATERIAL_IDS.every((m) => bal(a, m) >= (BLUEPRINTS[id].inputs[m] ?? 0));

  function npcRaid(a: AccountState, at: number): boolean {
    if (a.lastRaidAt !== null && at - a.lastRaidAt < 25 * 60_000) return false;
    return attempt(() => {
      const guns = heldGuns(a.accountId)
        .filter((w) => w.condition > 0)
        .sort((x, y) => y.value - x.value);
      const gun = guns.length && rand(S) < 0.8 ? guns[0] : null;
      const loadout: Loadout = { weapon: gun ? gun.serial : null, plates: Math.min(1, bal(a, "plate")), charges: Math.min(1, bal(a, "charge")), mags: Math.min(2, bal(a, "ammo")) };
      const dur = 180 + below(S, 300);
      const raid = doStartRaid(a.accountId, loadout, at, at - dur * 1000);
      const fate = rand(S);
      // A better gun gets its owner home more often.
      const dies = fate >= (gun ? 0.78 : 0.66);
      const room = dies ? 3 : RAID.carryLimit;
      let weight = 0;
      const wrecks: number[] = [];
      if (!dies) {
        for (const w of raid.wrecks) {
          const g = w.weapon ? RAID.gunWeight : 0;
          // Most wrecks are left where they lie: some are carried out, the rest run out their 24 hours.
          if (weight + g <= room && rand(S) < 0.06) {
            wrecks.push(w.id);
            weight += g;
          }
        }
      }
      const opened: number[] = [];
      for (const c of raid.containers) {
        const w = c.amount * MATERIALS[c.tokenId].weight;
        if (weight + w <= room && rand(S) < 0.8) {
          opened.push(c.spot);
          weight += w;
        }
      }
      const kills = { gull: below(S, 5), hound: below(S, 3) };
      const parts = { servo: 0, rotor: 0 };
      for (let i = 0; i < kills.hound; i++) {
        if (weight < room && rand(S) < 0.6) {
          parts.servo++;
          weight++;
        }
      }
      for (let i = 0; i < kills.gull; i++) {
        if (weight < room && rand(S) < 0.5) {
          parts.rotor++;
          weight++;
        }
      }
      const report: RaidReport = {
        opened,
        wrecks,
        parts,
        kills,
        uplinks: rand(S) < 0.2 ? 1 : 0,
        used: { plates: loadout.plates && rand(S) < 0.6 ? 1 : 0, charges: loadout.charges && rand(S) < 0.5 ? 1 : 0, mags: Math.min(loadout.mags, below(S, 3)) },
      };
      if (!dies) doExtract(a.accountId, raid.raidId, report, at);
      else doDie(a.accountId, raid.raidId, report, below(S, RAID.spotCount), fate < 0.985 ? "machines" : "bailiff", at);
    });
  }

  function npcTrade(a: AccountState, at: number): boolean {
    const broke = bal(a, "scrip") < 80;
    const spare = MATERIAL_IDS.filter((m) => bal(a, m) > (broke ? 0 : (KEEP[m] ?? 0)));
    if (!spare.length) return false;
    const m = pickOne(S, spare);
    const n = Math.min(3, bal(a, m) - (broke ? 0 : (KEEP[m] ?? 0)));
    let best: { id: VendorId; paid: number } | null = null;
    for (const id of VENDOR_IDS) {
      const v = S.vendors[id];
      if (!(VENDORS[id].buys as readonly string[]).includes(m)) continue;
      const paid = sellQuote(v, m, n);
      // The crew leaves a vendor's till alone once it is low, so the player usually finds the vendor open.
      if (v.scrip - paid >= 600 && (!best || paid > best.paid)) best = { id, paid };
    }
    let milli = recentMilli(m, at);
    let desk = 0;
    for (let i = 0; i < n; i++) {
      desk += exportPrice(m, milli);
      milli += 1000;
    }
    const to = best && best.paid >= desk ? best.id : null;
    return attempt(() => void (to ? doSell(a.accountId, to, m, n, at) : doExport(a.accountId, m, n, at)));
  }

  function npcBuild(a: AccountState, at: number): boolean {
    const mine = heldGuns(a.accountId);
    if (mine.length < 3) {
      const frame = shuffle(S, [...FRAME_IDS]).find((f) => canBuild(a, f));
      if (frame) return attempt(() => void doBuild(a.accountId, frame, at));
    }
    const gun = mine[0];
    if (gun) {
      const free = MOD_IDS.filter((m) => !gun.mods.some((x) => MODS[x].slot === MODS[m].slot));
      const have = free.find((m) => bal(a, m) > 0);
      if (have) return attempt(() => void doFit(a.accountId, gun.serial, have, at));
      const make = free.find((m) => canBuild(a, m));
      if (make && rand(S) < 0.5) return attempt(() => void doBuild(a.accountId, make, at));
    }
    if (bal(a, "ammo") < 2 && canBuild(a, "ammo") && bal(a, "copper") > (KEEP.copper ?? 0)) return attempt(() => void doBuild(a.accountId, "ammo", at));
    return false;
  }

  function npcList(a: AccountState, at: number): boolean {
    const own = S.listings.filter((l) => l.seller === a.accountId);
    const stale = own.find((l) => at - l.at > 5 * HOUR);
    if (stale) return attempt(() => void doCancelListing(a.accountId, stale.id, at));
    if (own.length >= 2) return false;
    const guns = heldGuns(a.accountId);
    if (guns.length >= 2 || (guns.length === 1 && rand(S) < 0.25)) {
      const w = guns[guns.length - 1];
      const price = Math.max(1, Math.floor((w.value * (88 + below(S, 40))) / 100));
      return attempt(() => void doListWeapon(a.accountId, w.serial, price, at));
    }
    const lots = (TOKEN_ORDER.filter((t) => t !== "scrip") as Exclude<TokenId, "scrip">[]).filter((t) => bal(a, t) > ((KEEP as Amounts)[t] ?? 0) + 1);
    if (!lots.length) return false;
    const t = pickOne(S, lots);
    const n = 1 + below(S, Math.min(3, bal(a, t) - ((KEEP as Amounts)[t] ?? 0)));
    const each = Object.hasOwn(MATERIALS, t) ? MATERIALS[t as MaterialId].bid : goodsPrice(t as GoodId);
    return attempt(() => void doListItem(a.accountId, t, n, Math.max(1, Math.floor((n * each * (95 + below(S, 35))) / 100)), at));
  }

  function npcShop(a: AccountState, at: number): boolean {
    const scrip = bal(a, "scrip");
    const guns = heldGuns(a.accountId).length;
    for (const l of [...S.listings].reverse()) {
      if (l.seller === a.accountId || l.price > scrip) continue;
      if (l.serial) {
        const w = S.weapons[l.serial];
        if (w && guns < 2 && l.price <= Math.floor(w.value * 1.2)) return attempt(() => void doBuyListing(a.accountId, l.id, at));
      } else if (l.item) {
        const { tokenId, amount } = l.item;
        const each = Object.hasOwn(MATERIALS, tokenId) ? MATERIALS[tokenId as MaterialId].bid : goodsPrice(tokenId as GoodId);
        if (scrip - l.price >= 100 && l.price <= amount * each * 1.25) return attempt(() => void doBuyListing(a.accountId, l.id, at));
      }
    }
    if (guns === 0 || (guns === 1 && rand(S) < 0.15)) {
      const moss = S.vendors.moss;
      const cheapest = vendorGuns(moss).sort((x, y) => gunAsk(moss, x) - gunAsk(moss, y))[0];
      if (cheapest && gunAsk(moss, cheapest) <= scrip) return attempt(() => void doBuyGun(a.accountId, "moss", cheapest.serial, at));
    }
    if (scrip >= 260 && rand(S) < 0.5) {
      const ines = S.vendors.ines;
      const want = pickOne(S, CONSUMABLE_IDS);
      const n = want === "ammo" ? 2 : 1;
      if ((ines.goods[want] ?? 0) >= n && bal(a, want) < 3) return attempt(() => void doBuy(a.accountId, "ines", want, n, at));
    }
    return false;
  }

  function npcDues(a: AccountState, at: number): boolean {
    const scrip = bal(a, "scrip");
    const held = S.impound.find((x) => x.owner === a.accountId);
    if (held && scrip >= held.fee && rand(S) < 0.3) return attempt(() => void doBuyBack(a.accountId, held.serial, at));
    // Most of the dock lets its bill ride. If everyone paid in full the Harbormaster would never be off full strength.
    if (a.arrears >= 200 && scrip >= 120 && rand(S) < 0.04) return attempt(() => void doSettle(a.accountId, 20 + below(S, 41), at));
    const worn = heldGuns(a.accountId).find((w) => w.condition > 0 && w.condition <= 70);
    if (worn) {
      const pts = Math.min(30, 100 - worn.condition);
      if (scrip >= pts * CONDITION.scripPerPoint + 60 && bal(a, "copper") >= Math.ceil(pts / CONDITION.pointsPerCopper)) return attempt(() => void doRepair(a.accountId, worn.serial, pts, at));
    }
    return false;
  }

  function npcAct(at: number): boolean {
    const crew = npcs();
    if (!crew.length) return false;
    const a = pickOne(S, crew);
    const acts = [npcRaid, npcRaid, npcRaid, npcTrade, npcTrade, npcBuild, npcBuild, npcList, npcShop, npcShop, npcDues];
    const first = below(S, acts.length);
    // Somebody who can't do what they meant to does the next thing instead, so a tick is rarely wasted.
    for (let i = 0; i < 4; i++) if (acts[(first + i * 3) % acts.length](a, at)) return true;
    return false;
  }

  /** A vendor sends what it holds over target to the freighter when the till is thin. */
  function vendorRefill(v: VendorState, at: number): boolean {
    if (v.scrip >= 700) return false;
    // With the till nearly empty it sells down to half of what it wants to hold.
    const floor = (m: MaterialId) => (v.scrip < 300 ? Math.floor(MATERIALS[m].target / 2) : MATERIALS[m].target);
    const over = MATERIAL_IDS.filter((m) => (v.stock[m] ?? 0) > floor(m)).sort((x, y) => (v.stock[y] ?? 0) - floor(y) - ((v.stock[x] ?? 0) - floor(x)));
    if (!over.length) return false;
    const m = over[0];
    return attempt(() => void doExport(v.accountId, m, Math.min(6, (v.stock[m] ?? 0) - floor(m)), at));
  }
  const vendorCan = (v: VendorState, id: BlueprintId) => MATERIAL_IDS.every((m) => (v.stock[m] ?? 0) >= (BLUEPRINTS[id].inputs[m] ?? 0));

  /** Moss's agent: builds what her stock allows, prices it by how it rolled, and marks down what won't move. */
  function mossAct(at: number): boolean {
    const v = S.vendors.moss;
    if (at - v.lastActAt < 8 * 60_000) return false;
    v.lastActAt = at;
    if (vendorRefill(v, at)) return true;
    const guns = vendorGuns(v);
    if (guns.length < 3) {
      // What has been selling comes first; otherwise whatever the bench can make.
      const sold = (f: FrameId) => (["A", "B", "C", "D"] as Grade[]).reduce((s, g) => s + (S.sales[`${f}:${g}`]?.length ?? 0), 0);
      const frame = shuffle(S, [...FRAME_IDS])
        .sort((x, y) => sold(y) - sold(x))
        .find((f) => vendorCan(v, f));
      if (frame) {
        return attempt(() => {
          const w = doVendorBuild(v.accountId, frame, `${FRAME_SHORT[frame]}s have been ${sold(frame) ? "moving" : "asked for"}. I had the parts, so I built one.`, at).weapon as Weapon;
          const pct = { A: 150, B: 135, C: 125, D: 110 }[w.grade];
          const price = Math.floor((w.value * pct) / 100);
          const say = { A: "It rolled an A. It costs what an A costs.", B: "A good one. Priced like it.", C: "An honest gun at an honest price.", D: "It rolled badly. I've priced it to go." }[w.grade];
          doVendorPrice(v.accountId, { serial: w.serial }, price, `${w.serial}: ${say}`, at);
        });
      }
    }
    // With the till nearly empty she lets a gun go under its appraisal.
    const least = (w: Weapon) => (v.scrip < 300 ? Math.floor((w.value * 85) / 100) : w.value);
    const tired = guns.find((w) => at - w.builtAt > 3 * HOUR && gunAsk(v, w) > least(w));
    if (tired) {
      const price = Math.max(least(tired), Math.floor((gunAsk(v, tired) * 90) / 100));
      return attempt(() => void doVendorPrice(v.accountId, { serial: tired.serial }, price, `No takers for ${tired.serial}. ${price} now.`, at));
    }
    const mod = MOD_IDS.find((m) => (v.goods[m] ?? 0) < 2 && vendorCan(v, m));
    if (mod) return attempt(() => void doVendorBuild(v.accountId, mod, `Down to ${v.goods[mod] ?? 0} ${NOUN[mod][1]}. Made another.`, at));
    return false;
  }

  /** Ines's agent: keeps the shelves stocked from what she is sold. */
  function inesAct(at: number): boolean {
    const v = S.vendors.ines;
    if (at - v.lastActAt < 8 * 60_000) return false;
    v.lastActAt = at;
    if (vendorRefill(v, at)) return true;
    const low: [ConsumableId, number][] = [
      ["ammo", 24],
      ["plate", 6],
      ["charge", 6],
    ];
    const short = low.find(([g, min]) => (v.goods[g] ?? 0) < min && vendorCan(v, g));
    if (short) return attempt(() => void doVendorBuild(v.accountId, short[0], `${NOUN[short[0]][1].replace(/^./, (c) => c.toUpperCase())} were down to ${v.goods[short[0]] ?? 0}. Restocked.`, at));
    return false;
  }

  /** The Harbormaster's agent: pursuit when it is in funds, patrols when it isn't, and it says why. */
  function harbormasterAct(at: number): boolean {
    if (at - S.hm.lastActAt < 20 * 60_000) return false;
    const h = hmView(at);
    const want: Posture = h.strength >= 40 ? "pursuit" : "patrols";
    if (want === S.hm.posture && S.hm.lastMemo !== null && at - S.hm.lastActAt < 3 * HOUR) return false;
    S.hm.lastActAt = at;
    const memo =
      want === "pursuit"
        ? `Receipts stand at ${h.balance} scrip. Final demands will be issued early.`
        : `Receipts stand at ${h.balance} scrip. Funds are assigned to Inspection Units.`;
    return attempt(() => void doPosture(MOCK2_HARBORMASTER, want, memo, at));
  }

  const agentsAct = (at: number) => [mossAct(at), inesAct(at), harbormasterAct(at)].some(Boolean);

  /** Plays the seconds from `from` to `to`: about four moves a minute across the crew, the agents every ten minutes. */
  function live(from: number, to: number): boolean {
    const steps = Math.max(0, Math.floor((to - from) / 1000));
    let changed = false;
    for (let i = 1; i <= steps; i++) {
      const agents = i % 600 === 0 || i === steps;
      const acts = rand(S) < 1 / 15;
      if (!agents && !acts) continue;
      const at = (S.clock = Math.max(S.clock, from + i * 1000));
      sweep(at);
      if (acts) changed = npcAct(at) || changed;
      if (agents) changed = agentsAct(at) || changed;
    }
    return changed;
  }

  function ambient(seconds: number) {
    const s = Math.max(0, Math.min(3600, Math.floor(Number(seconds) || 0)));
    const to = tick();
    if (live(to - s * 1000, to)) save();
  }

  // =============================================================================================================
  // Debug: outside the rules, for testing screens. Nothing here exists on chain.

  /** A gun of a chosen grade: stats placed in the band to land it, with a little seeded spread. */
  function debugStats(frame: FrameId, grade: Grade | undefined): Stats {
    if (!grade) return rollStats(S, frame);
    const aim = { A: 90, B: 70, C: 50, D: 20 }[grade];
    for (const spread of [8, 0]) {
      const stats = {} as Stats;
      for (const k of STAT_KEYS) {
        const [lo, hi] = FRAMES[frame].bands[k];
        const t = Math.max(0, Math.min(100, aim + (spread ? below(S, spread * 2 + 1) - spread : 0)));
        const better = k === "recoil" || k === "reload" ? 100 - t : t;
        stats[k] = lo + Math.round(((hi - lo) * better) / 100);
      }
      if (gradeOf(quality(frame, stats)) === grade) return stats;
    }
    return rollStats(S, frame);
  }

  function mutate<T>(fn: (at: number) => T): T {
    const at = tick();
    const out = fn(at);
    save();
    return out;
  }

  const debug: MockDebug = {
    give(what, amount = 1) {
      mutate((at) => {
        const a = player(S.me);
        const all: Amounts = typeof what === "string" ? { [what]: amount } : what;
        for (const t of TOKEN_ORDER) {
          const n = Math.floor(all[t] ?? 0);
          if (n <= 0) continue;
          credit(a.accountId, t, n);
          if (t === "scrip") minted(n, at);
        }
      });
    },
    giveGun(frame, o = {}) {
      return mutate((at) => {
        const a = player(S.me);
        const w = mintWeapon(frame, debugStats(frame, o.grade), a.accountId, a.callsign, "held", at);
        if (o.condition !== undefined) setCondition(w, o.condition);
        for (const m of o.mods ?? []) if (!w.mods.some((x) => MODS[x].slot === MODS[m].slot)) w.mods.push(m);
        if (o.impound) {
          w.state = "impound";
          S.impound.push({ serial: w.serial, owner: a.accountId, fee: Math.floor((w.value * RAID.buyBackPct) / 100), expiresAt: at + RAID.impoundHours * HOUR });
        }
        return clone(w);
      });
    },
    advance(hours) {
      S.skewMs += Math.max(0, Math.floor(Number(hours) * HOUR) || 0);
      mutate((at) => sweep(at));
    },
    setArrears(amount) {
      mutate(() => void (player(S.me).arrears = Math.max(0, Math.floor(Number(amount) || 0))));
    },
    addWreck(o = {}) {
      return mutate((at) => {
        const owner = npcs()[below(S, Math.max(1, npcs().length))] ?? refuse("E_NOT_REGISTERED", "Nobody else is on the dock.");
        let serial: string | null = null;
        if (o.frame !== null) {
          const frame = o.frame ?? pickOne(S, FRAME_IDS);
          const w = mintWeapon(frame, debugStats(frame, o.grade), owner.accountId, owner.callsign, "wreck", at);
          setCondition(w, 60 + below(S, 35));
          serial = w.serial;
        }
        const items = TOKEN_ORDER.filter((t) => t !== "scrip" && (o.items?.[t] ?? 0) > 0).map((t) => ({ tokenId: t, amount: Math.floor(o.items?.[t] as number) }));
        const spot = isWhole(o.spot) && o.spot < RAID.spotCount ? o.spot : below(S, RAID.spotCount);
        while (S.wrecks.length >= LIMITS.wrecks) burnWreck(S.wrecks.length - 1);
        const w: WreckState = { id: S.nextWreck++, spot, owner: owner.accountId, callsign: owner.callsign, serial, items, at, expiresAt: at + RAID.wreckHours * HOUR, reservedBy: null };
        S.wrecks.unshift(w);
        return wreckView(w);
      });
    },
    payHarbormaster(scrip) {
      mutate((at) => {
        const n = Math.max(0, Math.floor(Number(scrip) || 0));
        hmPay(n, at);
        minted(n, at);
      });
    },
  };

  /** `?stash=rich`: registered, in funds, armed three ways, one gun in the impound and a bill outstanding. */
  function fillLocker() {
    const at = tick();
    if (!S.accounts[S.me]) {
      const taken = new Set(Object.values(S.accounts).map((a) => a.callsign));
      doRegister(S.me, taken.has("BREACHER") ? `BREACHER-${S.nextTx % 100}` : "BREACHER", at);
    }
    S.rich = true;
    debug.give({ scrip: 2400, copper: 14, chips: 10, servo: 4, rotor: 4, core: 2, fuel: 3, meds: 3, comp: 1, optic: 1, barrel2: 1, plate: 2, charge: 3, ammo: 8 });
    debug.giveGun("longshore", { grade: "A", condition: 96, mods: ["mag2", "comp"] });
    debug.giveGun("stevedore", { grade: "C", condition: 24 });
    debug.giveGun("pilot", { grade: "B", condition: 78 });
    debug.giveGun("longshore", { grade: "D", condition: 88, impound: true });
    debug.setArrears(1150);
    debug.addWreck({ frame: "stevedore", grade: "B", items: { copper: 2, ammo: 2 } });
  }

  if (!loaded) {
    if (warmup) live(S.clock, base());
    save();
  }
  if (stash === "rich" && !S.rich) {
    try {
      fillLocker();
      save();
    } catch (e) {
      console.warn("[economy] v2 mock: the rich stash couldn't be filled:", e);
    }
  }

  // =============================================================================================================
  // The interface

  /** A view: expiry first, as any call on chain would, then the read. */
  const read = async <T>(fn: (at: number) => T): Promise<T> => {
    const at = tick();
    sweep(at);
    return fn(at);
  };

  const callsFor = (actor: () => string): Calls2 => ({
    startRaid: async (loadout) => tx((at) => ({ raid: doStartRaid(actor(), loadout, at) })),
    extract: async (raidId, report) => tx((at) => doExtract(actor(), raidId, report, at)),
    die: async (raidId, report, spot, by) => tx((at) => doDie(actor(), raidId, report, spot, by, at)),
    build: async (blueprint) => tx((at) => doBuild(actor(), blueprint, at)),
    fit: async (serial, mod) => tx((at) => doFit(actor(), serial, mod, at)),
    repair: async (serial, points) => tx((at) => doRepair(actor(), serial, points, at)),
    scrap: async (serial) => tx((at) => doScrap(actor(), serial, at)),
    sell: async (vendor, tokenId, amount) => tx((at) => doSell(actor(), vendor, tokenId, amount, at)),
    buy: async (vendor, tokenId, amount) => tx((at) => doBuy(actor(), vendor, tokenId, amount, at)),
    buyGun: async (vendor, serial) => tx((at) => doBuyGun(actor(), vendor, serial, at)),
    exportGoods: async (tokenId, amount) => tx((at) => doExport(actor(), tokenId, amount, at)),
    listWeapon: async (serial, price) => tx((at) => doListWeapon(actor(), serial, price, at)),
    listItem: async (tokenId, amount, price) => tx((at) => doListItem(actor(), tokenId, amount, price, at)),
    buyListing: async (id) => tx((at) => doBuyListing(actor(), id, at)),
    cancelListing: async (id) => tx((at) => doCancelListing(actor(), id, at)),
    settle: async (amount) => tx((at) => doSettle(actor(), amount, at)),
    buyBack: async (serial) => tx((at) => doBuyBack(actor(), serial, at)),
    vendorBuild: async (blueprint, memo) => tx((at) => doVendorBuild(actor(), blueprint, memo, at)),
    vendorPrice: async (what, price, memo) => tx((at) => doVendorPrice(actor(), what, price, memo, at)),
    hmPosture: async (posture, memo) => tx((at) => doPosture(actor(), posture, memo, at)),
  });

  return {
    network: "mock",
    contractId: MOCK2_CONTRACT,
    txUrl: () => null,
    accountUrl: () => null,
    me: () => S.me,
    now,
    isRegistered: (accountId) => !!S.accounts[accountId],
    vendorAccount: (id) => S.vendors[id].accountId,
    snapshot: () => clone(S),
    reset() {
      try {
        storage?.removeItem(MOCK2_STORAGE_KEY);
      } catch {
        // ignore
      }
      S = freshState(seed, base() - warmup * 1000);
      if (warmup) live(S.clock, base());
      save();
    },
    ambient,
    debug,
    as: (accountId) => callsFor(() => accountId),
    rules: async () => rulesWire(),

    profile: (accountId) => read(() => (S.accounts[accountId] ? profileOf(S.accounts[accountId]) : null)),
    balances: (accountId) =>
      read(() => {
        const out: Amounts = {};
        const a = S.accounts[accountId];
        if (a) for (const t of TOKEN_ORDER) if (bal(a, t) > 0) out[t] = bal(a, t);
        return out;
      }),
    weapons: (accountId) => read(() => clone(gunsOf(accountId))),
    weapon: (serial) => read(() => (S.weapons[serial] ? clone(S.weapons[serial]) : null)),
    vendors: () => read(() => VENDOR_IDS.map((id) => vendorView(S.vendors[id]))),
    exportPrices: () =>
      read((at) =>
        MATERIAL_IDS.map((m): Quote => {
          const milli = recentMilli(m, at);
          const price = exportPrice(m, milli);
          const n = Math.round(milli / 1000);
          return { tokenId: m, price, reason: n ? `${n} sent to the freighter lately. The desk pays ${price} of its ${MATERIALS[m].export}.` : `Nothing sent lately. The desk pays its full ${MATERIALS[m].export}.` };
        }),
      ),
    listings: () => read(() => S.listings.map(listingView)),
    wrecks: () => read((at) => S.wrecks.filter((w) => w.expiresAt > at).map(wreckView)),
    impound: (accountId) =>
      read(() =>
        S.impound
          .filter((x) => x.owner === accountId && S.weapons[x.serial])
          .map((x): Impounded => ({ weapon: clone(S.weapons[x.serial]), fee: x.fee, expiresAt: x.expiresAt })),
      ),
    harbormaster: () => read((at) => hmView(at)),
    raid: (raidId) => read(() => (S.raids[raidId] ? raidView(S.raids[raidId]) : null)),
    recent: (limit) => read(() => clone(S.recent.slice(0, Math.max(1, Math.min(MOCK2.maxRecent, Math.floor(limit) || 1))))),
    economy: () => read((at) => economyView(at)),
    leaderboard: () => read(() => leaderboard()),

    register: async (accountId, callsign) => tx((at) => ({ profile: doRegister(accountId, callsign, at) })),
    ...callsFor(() => S.me),
  };
}

/** The offline wallet: the mock's local player, registered through the mock's faucet call. */
export function createMockWallet2(chain: MockChain2): Wallet2 & { readonly kind: "mock" } {
  return {
    kind: "mock",
    accountId: () => chain.me(),
    registered: async () => chain.isRegistered(chain.me()),
    claim: async (callsign: string) => {
      const r = await chain.register(chain.me(), callsign);
      const out: TxResult = { ok: r.ok };
      if (r.txHash) out.txHash = r.txHash;
      if (r.error) out.error = r.error;
      if (r.code) out.code = r.code;
      return out;
    },
  };
}
