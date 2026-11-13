// Saltline v2's contract on NEAR testnet, behind the `Chain2` interface (types.ts).
//
// Wire format: docs/CONTRACT_V2.md. snake_case on the wire, camelCase here; U128 amounts arrive as JSON strings and
// leave as numbers, refusing any value a JS number can't hold exactly.
//
// The plumbing is v1's (../chain.ts), used as it is: views reject on failure and read at optimistic finality, every
// call goes through one queue, a transient failure re-sends the identical signed bytes, a contract panic is never
// retried and comes back as `{ ok: false, code, error }`, and a call that may have landed is `pending`.
//
// .js on the relative imports: the vendors' and the Harbormaster's agents run this file under Node's ES modules.
import {
  type CallResult,
  type ExecOptions,
  type Executed,
  type NearPort,
  BASE58_HASH,
  GAS_DEFAULT,
  GAS_RUN,
  WireError,
  amounts,
  bool,
  createContractClient,
  int,
  list,
  obj,
  optional,
  str,
  u128,
} from "../chain.js";
import type { SigningKey } from "../wallet";
import { BLUEPRINT_IDS, FRAME_IDS, MATERIAL_IDS, MOD_IDS, STAT_KEYS, TOKEN_NAMES, VENDORS } from "./items.js";
import type {
  Amounts,
  BlueprintId,
  Chain2,
  ConsumableId,
  Container,
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
  VendorGood,
  VendorId,
  Weapon,
  WeaponState,
  Wreck,
} from "./types";

// Prepaid gas, in Tgas (docs/CONTRACT_V2.md: 30 for raid calls, 20 for the rest). A guest account holds 0.1 NEAR and
// must be able to reserve the prepaid gas; ../chain.ts says why these two numbers.
export const GAS_RAID = GAS_RUN;
export const GAS_REST = GAS_DEFAULT;

/**
 * An account's page on the testnet explorer: the same site as v1's transaction links (../config.ts,
 * TESTNET_EXPLORER_TX), at /address/<id>. NOT VERIFIED: the path is nearblocks' usual one, written from memory on
 * 13 Nov 2026 and never opened (the site blocks scripted fetches, as ../config.ts found for /txns/). Open one link
 * by hand before the dock shows it; `config.explorerAccountUrl` overrides it.
 */
export const TESTNET_EXPLORER_ACCOUNT = "https://testnet.nearblocks.io/address/";

/** docs/CONTRACT_V2.md → Errors, as a player reads them when a panic carries a code and no text. */
export const ERROR_TEXT2: Record<string, string> = {
  E_NOT_REGISTERED: "No dock pass. Claim one first.",
  E_ALREADY_REGISTERED: "Already registered.",
  E_CALLSIGN_TAKEN: "That callsign is taken.",
  E_BAD_CALLSIGN: "Callsigns are 3–16 letters, digits, spaces, dashes, dots or underscores.",
  E_NOT_FAUCET: "Only the dock office can do that.",
  E_NOT_VENDOR: "Only a vendor's own account can do that.",
  E_NOT_HARBORMASTER: "Only the Harbormaster's account can do that.",
  E_NOT_OWNER: "That isn't yours.",
  E_PAUSED: "The dock is closed for now.",
  E_NO_RAID: "No such raid.",
  E_RAID_CLOSED: "That raid is already closed.",
  E_TOO_SOON: "Too soon.",
  E_NOT_IN_MANIFEST: "That wasn't on this raid's manifest.",
  E_OVER_LIMIT: "Over the carry limit.",
  E_DUPLICATE: "Listed twice.",
  E_BAD_REPORT: "The raid report doesn't add up.",
  E_NO_WEAPON: "No such gun.",
  E_WEAPON_BUSY: "That gun isn't in your stash right now.",
  E_WORN_OUT: "That gun is worn out. It can only be scrapped.",
  E_SLOT_TAKEN: "That slot already has a mod.",
  E_FUNDS: "Not enough scrip or items.",
  E_VENDOR_BROKE: "The vendor can't cover that sale.",
  E_DOESNT_BUY: "The vendor doesn't buy that.",
  E_DOESNT_SELL: "The vendor doesn't sell that.",
  E_NO_STOCK: "Out of stock.",
  E_NO_LISTING: "That listing is gone.",
  E_NOT_IMPOUNDED: "That gun isn't in the impound.",
  E_NOTHING_OWED: "Nothing is owed.",
  E_BAD_AMOUNT: "Zero or too large.",
  E_FULL: "The dock is full.",
};

// ---------------------------------------------------------------------------------------------------------------
// Wire decoding. Every decoder throws on a shape it doesn't expect, so a bad response rejects instead of showing a
// wrong number. Token, mod and event kinds this client doesn't know are skipped, so a newer contract doesn't blank
// a screen.

const TOKENS = new Set<string>(Object.keys(TOKEN_NAMES));
const MATERIALS = new Set<string>(MATERIAL_IDS);
const MODS = new Set<string>(MOD_IDS);
const GOODS = new Set<string>([...MOD_IDS, "plate", "charge", "ammo"]);
const FRAMES = new Set<string>(FRAME_IDS);
const GRADES = new Set<string>(["A", "B", "C", "D"]);
const STATES = new Set<string>(["held", "raid", "listed", "vendor", "wreck", "impound"]);
const POSTURES = new Set<string>(["patrols", "pursuit"]);
const VENDOR_IDS = new Set<string>(Object.keys(VENDORS));
const BLUEPRINTS = new Set<string>(BLUEPRINT_IDS);
const SERIAL = /^S-\d{6,}$/;
export const LEDGER_KINDS: readonly LedgerKind[] = [
  "raid_start",
  "extract",
  "wreck",
  "impound",
  "recover",
  "buy_back",
  "build",
  "fit",
  "repair",
  "scrap",
  "sale",
  "purchase",
  "export",
  "listing",
  "market_sale",
  "settle",
  "posture",
  "vendor_build",
  "vendor_price",
];
const KINDS = new Set<string>(LEDGER_KINDS);

function oneOf<T extends string>(v: unknown, field: string, set: Set<string>): T {
  const s = str(v, field);
  if (!set.has(s)) throw new WireError(`${field}: unexpected ${JSON.stringify(s)}`);
  return s as T;
}

function percent(v: unknown, field: string): number {
  const n = int(v, field);
  if (n > 100) throw new WireError(`${field}: ${n} is over 100`);
  return n;
}

export function decodeStats(raw: unknown, f = "stats"): Stats {
  const o = obj(raw, f);
  const out = {} as Stats;
  for (const k of STAT_KEYS) out[k] = int(o[k], `${f}.${k}`);
  return out;
}

export function decodeWeapon(raw: unknown, f = "weapon"): Weapon {
  const o = obj(raw, f);
  const serial = str(o.serial, `${f}.serial`);
  if (!SERIAL.test(serial)) throw new WireError(`${f}.serial: ${JSON.stringify(serial)} is not a serial`);
  return {
    serial,
    frame: oneOf<FrameId>(o.frame, `${f}.frame`, FRAMES),
    grade: oneOf<Grade>(o.grade, `${f}.grade`, GRADES),
    quality: percent(o.quality, `${f}.quality`),
    stats: decodeStats(o.stats, `${f}.stats`),
    mods: list(o.mods, `${f}.mods`, (x, g) => str(x, g)).filter((m): m is ModId => MODS.has(m)),
    condition: percent(o.condition, `${f}.condition`),
    maker: str(o.maker, `${f}.maker`),
    makerCallsign: str(o.maker_callsign, `${f}.maker_callsign`),
    owner: str(o.owner, `${f}.owner`),
    builtAt: int(o.built_at, `${f}.built_at`),
    raids: int(o.raids, `${f}.raids`),
    extractions: int(o.extractions, `${f}.extractions`),
    owners: int(o.owners, `${f}.owners`),
    recovered: int(o.recovered, `${f}.recovered`),
    state: oneOf<WeaponState>(o.state, `${f}.state`, STATES),
    value: u128(o.value, `${f}.value`),
  };
}

export function decodeLoadout(raw: unknown, f = "loadout"): Loadout {
  const o = obj(raw, f);
  return {
    weapon: optional(o.weapon, (x) => str(x, `${f}.weapon`)),
    plates: int(o.plates, `${f}.plates`),
    charges: int(o.charges, `${f}.charges`),
    mags: int(o.mags, `${f}.mags`),
  };
}

function decodeContainer(raw: unknown, f: string): Container {
  const o = obj(raw, f);
  return {
    spot: int(o.spot, `${f}.spot`),
    tokenId: oneOf<MaterialId>(o.token_id, `${f}.token_id`, MATERIALS),
    amount: u128(o.amount, `${f}.amount`),
    bonded: bool(o.bonded, `${f}.bonded`),
  };
}

/** `[{ token_id, amount }]`, leaving out token ids this client doesn't know. */
function decodeItems(raw: unknown, f: string): { tokenId: TokenId; amount: number }[] {
  const out: { tokenId: TokenId; amount: number }[] = [];
  list(raw, f, (x, g) => {
    const i = obj(x, g);
    const t = str(i.token_id, `${g}.token_id`);
    const amount = u128(i.amount, `${g}.amount`);
    if (TOKENS.has(t)) out.push({ tokenId: t as TokenId, amount });
  });
  return out;
}

export function decodeWreck(raw: unknown, f = "wreck"): Wreck {
  const o = obj(raw, f);
  return {
    id: int(o.id, `${f}.id`),
    spot: int(o.spot, `${f}.spot`),
    owner: str(o.owner, `${f}.owner`),
    callsign: str(o.callsign, `${f}.callsign`),
    weapon: optional(o.weapon, (x) => decodeWeapon(x, `${f}.weapon`)),
    items: decodeItems(o.items, `${f}.items`),
    at: int(o.at, `${f}.at`),
    expiresAt: int(o.expires_at, `${f}.expires_at`),
  };
}

/** A strength over 100 or more than 4 bonus drones is refused rather than shown: the game would field them. */
export function decodeHarbormaster(raw: unknown, f = "harbormaster"): HarbormasterView {
  const o = obj(raw, f);
  const bonusDrones = int(o.bonus_drones, `${f}.bonus_drones`);
  if (bonusDrones > 4) throw new WireError(`${f}.bonus_drones: ${bonusDrones} is over 4`);
  return {
    accountId: str(o.account_id, `${f}.account_id`),
    balance: u128(o.balance, `${f}.balance`),
    strength: percent(o.strength, `${f}.strength`),
    posture: oneOf<Posture>(o.posture, `${f}.posture`, POSTURES),
    bonusDrones,
    secondNoticeAt: u128(o.second_notice_at, `${f}.second_notice_at`),
    bailiffAt: u128(o.bailiff_at, `${f}.bailiff_at`),
    secondBailiffAt: u128(o.second_bailiff_at, `${f}.second_bailiff_at`),
    foreclosureAt: u128(o.foreclosure_at, `${f}.foreclosure_at`),
    lastMemo: optional(o.last_memo, (x) => str(x, `${f}.last_memo`)),
  };
}

export function decodeRaid(raw: unknown, f = "raid"): Raid | null {
  if (raw === null) return null;
  const o = obj(raw, f);
  return {
    raidId: int(o.raid_id, `${f}.raid_id`),
    startedAt: int(o.started_at, `${f}.started_at`),
    loadout: decodeLoadout(o.loadout, `${f}.loadout`),
    containers: list(o.containers, `${f}.containers`, decodeContainer),
    wrecks: list(o.wrecks, `${f}.wrecks`, decodeWreck),
    invoiceStart: u128(o.invoice_start, `${f}.invoice_start`),
    harbormaster: decodeHarbormaster(o.harbormaster, `${f}.harbormaster`),
  };
}

export function decodeProfile2(raw: unknown): Profile | null {
  if (raw === null) return null;
  const o = obj(raw, "profile");
  return {
    accountId: str(o.account_id, "profile.account_id"),
    callsign: str(o.callsign, "profile.callsign"),
    registeredAt: int(o.registered_at, "profile.registered_at"),
    raids: int(o.raids, "profile.raids"),
    extractions: int(o.extractions, "profile.extractions"),
    deaths: int(o.deaths, "profile.deaths"),
    arrears: u128(o.arrears, "profile.arrears"),
    activeRaid: optional(o.active_raid, (x) => int(x, "profile.active_raid")),
    built: int(o.built, "profile.built"),
    royalties: u128(o.royalties, "profile.royalties"),
  };
}

export const decodeBalances2 = (raw: unknown, f = "balances"): Amounts => amounts<TokenId>(raw, f, TOKENS);

/** A quote for a token this client doesn't know is left out. */
function decodeQuotes(raw: unknown, f: string): Quote[] {
  const out: Quote[] = [];
  list(raw, f, (x, g) => {
    const o = obj(x, g);
    const t = str(o.token_id, `${g}.token_id`);
    const q = { price: u128(o.price, `${g}.price`), reason: str(o.reason, `${g}.reason`) };
    if (TOKENS.has(t)) out.push({ tokenId: t as TokenId, ...q });
  });
  return out;
}

export function decodeVendor(raw: unknown, f = "vendor"): Vendor {
  const o = obj(raw, f);
  const goods: VendorGood[] = [];
  list(o.goods, `${f}.goods`, (x, g) => {
    const i = obj(x, g);
    const t = str(i.token_id, `${g}.token_id`);
    const good = { price: u128(i.price, `${g}.price`), stock: u128(i.stock, `${g}.stock`), reason: str(i.reason, `${g}.reason`) };
    if (GOODS.has(t)) goods.push({ tokenId: t as ModId | ConsumableId, ...good });
  });
  return {
    id: oneOf<VendorId>(o.id, `${f}.id`, VENDOR_IDS),
    accountId: str(o.account_id, `${f}.account_id`),
    name: str(o.name, `${f}.name`),
    open: bool(o.open, `${f}.open`),
    scrip: u128(o.scrip, `${f}.scrip`),
    stock: amounts<MaterialId>(o.stock, `${f}.stock`, MATERIALS),
    bids: decodeQuotes(o.bids, `${f}.bids`),
    goods,
    guns: list(o.guns, `${f}.guns`, (x, g) => {
      const i = obj(x, g);
      return { weapon: decodeWeapon(i.weapon, `${g}.weapon`), price: u128(i.price, `${g}.price`) };
    }),
    lastMemo: optional(o.last_memo, (x) => str(x, `${f}.last_memo`)),
  };
}

/** A listing is a gun or a lot of one token. One for a token this client doesn't know is left out (null). */
export function decodeListing2(raw: unknown, f = "listing"): Listing | null {
  const o = obj(raw, f);
  const out: Listing = {
    id: int(o.id, `${f}.id`),
    seller: str(o.seller, `${f}.seller`),
    callsign: str(o.callsign, `${f}.callsign`),
    price: u128(o.price, `${f}.price`),
    at: int(o.at, `${f}.at`),
  };
  const weapon = optional(o.weapon, (x) => decodeWeapon(x, `${f}.weapon`));
  if (weapon) return { ...out, weapon };
  if (o.item === null || o.item === undefined) throw new WireError(`${f}: neither a weapon nor an item`);
  const i = obj(o.item, `${f}.item`);
  const t = str(i.token_id, `${f}.item.token_id`);
  const amount = u128(i.amount, `${f}.item.amount`);
  if (!TOKENS.has(t) || t === "scrip") return null;
  return { ...out, item: { tokenId: t as TokenId, amount } };
}

export function decodeImpounded(raw: unknown, f = "impound"): Impounded {
  const o = obj(raw, f);
  return { weapon: decodeWeapon(o.weapon, `${f}.weapon`), fee: u128(o.fee, `${f}.fee`), expiresAt: int(o.expires_at, `${f}.expires_at`) };
}

/** Events of a kind this client doesn't know are dropped, so a newer contract doesn't blank the ticker. */
export function decodeEvents2(raw: unknown): LedgerEvent[] {
  const out: LedgerEvent[] = [];
  list(raw, "recent", (x, f) => {
    const o = obj(x, f);
    const kind = str(o.kind, `${f}.kind`);
    const e: LedgerEvent = { kind: kind as LedgerKind, at: int(o.at, `${f}.at`), account: str(o.account, `${f}.account`), text: str(o.text, `${f}.text`) };
    if (o.callsign !== undefined && o.callsign !== null) e.callsign = str(o.callsign, `${f}.callsign`);
    if (KINDS.has(kind)) out.push(e);
  });
  return out;
}

export function decodeEconomy(raw: unknown): EconomyView {
  const o = obj(raw, "economy");
  return {
    scripSupply: u128(o.scrip_supply, "economy.scrip_supply"),
    minted24h: u128(o.minted_24h, "economy.minted_24h"),
    burned24h: u128(o.burned_24h, "economy.burned_24h"),
    players: int(o.players, "economy.players"),
    weaponsBuilt: int(o.weapons_built, "economy.weapons_built"),
    weaponsAlive: int(o.weapons_alive, "economy.weapons_alive"),
    weaponsDestroyed: int(o.weapons_destroyed, "economy.weapons_destroyed"),
    lastSales: list(o.last_sales, "economy.last_sales", (x, f) => {
      const s = obj(x, f);
      return {
        frame: oneOf<FrameId>(s.frame, `${f}.frame`, FRAMES),
        grade: oneOf<Grade>(s.grade, `${f}.grade`, GRADES),
        prices: list(s.prices, `${f}.prices`, (p, g) => u128(p, g)),
      };
    }),
  };
}

const decodeRow = (x: unknown, f: string): LeaderRow => {
  const o = obj(x, f);
  return { accountId: str(o.account_id, `${f}.account_id`), callsign: str(o.callsign, `${f}.callsign`), value: u128(o.value, `${f}.value`) };
};

export function decodeLeaderboard2(raw: unknown): Leaderboard {
  const o = obj(raw, "leaderboard");
  return {
    netWorth: list(o.net_worth, "leaderboard.net_worth", decodeRow),
    extractions: list(o.extractions, "leaderboard.extractions", decodeRow),
    makers: list(o.makers, "leaderboard.makers", decodeRow),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Wire encoding

const whole = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
const positive = (n: unknown): n is number => whole(n) && n > 0;
const local = (code: string): CallResult => ({ ok: false, error: ERROR_TEXT2[code], code });

function reportOk(r: RaidReport): boolean {
  return (
    !!r &&
    Array.isArray(r.opened) &&
    r.opened.every(whole) &&
    Array.isArray(r.wrecks) &&
    r.wrecks.every(whole) &&
    !!r.parts &&
    whole(r.parts.servo) &&
    whole(r.parts.rotor) &&
    !!r.kills &&
    whole(r.kills.gull) &&
    whole(r.kills.hound) &&
    whole(r.uplinks) &&
    !!r.used &&
    whole(r.used.plates) &&
    whole(r.used.charges) &&
    whole(r.used.mags)
  );
}

/** The report as the contract reads it: the same names, with nothing extra the game may have hung on the object. */
export const encodeReport = (r: RaidReport) => ({
  opened: [...r.opened],
  wrecks: [...r.wrecks],
  parts: { servo: r.parts.servo, rotor: r.parts.rotor },
  kills: { gull: r.kills.gull, hound: r.kills.hound },
  uplinks: r.uplinks,
  used: { plates: r.used.plates, charges: r.used.charges, mags: r.used.mags },
});

// ---------------------------------------------------------------------------------------------------------------
// The chain

/** Calls only a vendor's or the Harbormaster's own account may make (their agents sign them). */
export interface AgentCalls {
  vendorBuild(blueprint: BlueprintId, memo: string): Promise<TxResult & { weapon?: Weapon; minted?: Amounts }>;
  /** Sets the price of one gun (`serial`) or one kind of goods (`tokenId`). */
  vendorPrice(what: { serial?: string; tokenId?: ModId | ConsumableId }, price: number, memo: string): Promise<TxResult>;
  hmPosture(posture: Posture, memo: string): Promise<TxResult & { harbormaster?: HarbormasterView }>;
}

export interface TestnetChain2Options {
  config: { contractId: string; rpcUrls: readonly string[]; explorerTxUrl: string; explorerAccountUrl?: string };
  /** The current wallet's key, or null before there is one. */
  keys: () => SigningKey | null;
  port?: NearPort;
  exec?: ExecOptions;
}

export interface TestnetChain2 extends Chain2, AgentCalls {
  readonly network: "testnet";
  accountExists(accountId: string): Promise<boolean>;
  /** The contract's own copy of the numbers in items.ts, as it sends them (scripts/v2-chain-check.mjs compares). */
  rules(): Promise<Record<string, unknown>>;
  materials(): Promise<unknown[]>;
  frames(): Promise<unknown[]>;
  blueprints(): Promise<unknown[]>;
  /** NEP-171: gives a gun away. Only while it is `held`; attaches the 1 yoctoNEAR the standard asks for. */
  nftTransfer(serial: string, receiverId: string): Promise<TxResult>;
  /** Calls queued or in flight. */
  queued(): number;
}

export function createTestnetChain2(opts: TestnetChain2Options): TestnetChain2 {
  const { contractId, explorerTxUrl } = opts.config;
  const explorerAccountUrl = opts.config.explorerAccountUrl ?? TESTNET_EXPLORER_ACCOUNT;
  const client = createContractClient(opts);
  const { view, withRetry, shape, queued, port } = client;

  /** One call through the queue. A panic with a code and no text gets this contract's wording. */
  async function call(method: string, args: object, gasTgas: number, depositYocto?: bigint): Promise<Executed> {
    const r = await client.call(method, args, gasTgas, depositYocto);
    if (!r.ok && r.code && (!r.error || r.error === r.code) && ERROR_TEXT2[r.code]) r.error = ERROR_TEXT2[r.code];
    return r;
  }

  const gun = (v: unknown, f: string) => decodeWeapon(obj(v, f).weapon, `${f}.weapon`);
  const built = (f: string) => (v: unknown) => {
    const o = obj(v, f);
    const weapon = optional(o.weapon, (x) => decodeWeapon(x, `${f}.weapon`));
    return { ...(weapon ? { weapon } : {}), minted: decodeBalances2(o.minted ?? {}, `${f}.minted`) };
  };

  return {
    network: "testnet",
    contractId,
    txUrl: (h) => (BASE58_HASH.test(h) ? explorerTxUrl + h : null),
    accountUrl: (id) => (typeof id === "string" && /^[a-z0-9._-]{2,64}$/.test(id) ? explorerAccountUrl + id : null),
    queued,
    accountExists: (accountId) => withRetry((a) => port.accountExists(accountId, a), "account"),

    rules: () => view("rules", {}, (r) => obj(r, "rules")),
    materials: () => view("materials", {}, (r) => list(r, "materials", (x) => x)),
    frames: () => view("frames", {}, (r) => list(r, "frames", (x) => x)),
    blueprints: () => view("blueprints", {}, (r) => list(r, "blueprints", (x) => x)),

    profile: (accountId) => view("profile", { account_id: accountId }, decodeProfile2),
    balances: (accountId) => view("balances", { account_id: accountId }, (r) => decodeBalances2(r)),
    weapons: (accountId) => view("weapons", { account_id: accountId }, (r) => list(r, "weapons", decodeWeapon)),
    weapon: (serial) => view("weapon", { serial }, (r) => optional(r, (x) => decodeWeapon(x))),
    vendors: () => view("vendors", {}, (r) => list(r, "vendors", decodeVendor)),
    exportPrices: () => view("export_prices", {}, (r) => decodeQuotes(r, "export_prices")),
    listings: () => view("listings", {}, (r) => list(r, "listings", decodeListing2).filter((l): l is Listing => l !== null)),
    wrecks: () => view("wrecks", {}, (r) => list(r, "wrecks", decodeWreck)),
    impound: (accountId) => view("impound", { account_id: accountId }, (r) => list(r, "impound", decodeImpounded)),
    harbormaster: () => view("harbormaster", {}, (r) => decodeHarbormaster(r)),
    raid: (raidId) => view("raid", { raid_id: raidId }, (r) => decodeRaid(r)),
    recent: (limit) => view("recent", { limit: Math.max(1, Math.min(64, Math.floor(limit) || 1)) }, decodeEvents2),
    economy: () => view("economy", {}, decodeEconomy),
    leaderboard: () => view("leaderboard", {}, decodeLeaderboard2),

    async startRaid(loadout) {
      if (!loadout || !whole(loadout.plates) || !whole(loadout.charges) || !whole(loadout.mags)) return local("E_BAD_AMOUNT");
      const args = { loadout: { weapon: loadout.weapon ?? null, plates: loadout.plates, charges: loadout.charges, mags: loadout.mags } };
      return shape(await call("start_raid", args, GAS_RAID), (v) => {
        const raid = decodeRaid(v, "start_raid");
        if (!raid) throw new WireError("start_raid returned no raid");
        return { raid };
      });
    },
    async extract(raidId, report) {
      if (!whole(raidId) || !reportOk(report)) return local("E_BAD_REPORT");
      return shape(await call("extract", { raid_id: raidId, report: encodeReport(report) }, GAS_RAID), (v) => {
        const o = obj(v, "extract");
        return {
          minted: decodeBalances2(o.minted, "extract.minted"),
          weapon: optional(o.weapon, (x) => decodeWeapon(x, "extract.weapon")),
          recovered: list(o.recovered, "extract.recovered", decodeWeapon),
          invoice: u128(o.invoice, "extract.invoice"),
          arrears: u128(o.arrears, "extract.arrears"),
        };
      });
    },
    async die(raidId, report, spot, by) {
      if (!whole(raidId) || !whole(spot) || !reportOk(report) || (by !== "machines" && by !== "bailiff")) return local("E_BAD_REPORT");
      return shape(await call("die", { raid_id: raidId, report: encodeReport(report), spot, by }, GAS_RAID), (v) => {
        const o = obj(v, "die");
        return {
          wreckId: optional(o.wreck_id, (x) => int(x, "die.wreck_id")),
          impounded: bool(o.impounded, "die.impounded"),
          invoice: u128(o.invoice, "die.invoice"),
          arrears: u128(o.arrears, "die.arrears"),
        };
      });
    },
    async build(blueprint) {
      if (!BLUEPRINTS.has(blueprint)) return local("E_BAD_AMOUNT");
      return shape(await call("build", { blueprint }, GAS_REST), built("build"));
    },
    async fit(serial, mod) {
      return shape(await call("fit", { serial, mod }, GAS_REST), (v) => ({ weapon: gun(v, "fit") }));
    },
    async repair(serial, points) {
      if (points !== undefined && !positive(points)) return local("E_BAD_AMOUNT");
      return shape(await call("repair", { serial, points: points ?? null }, GAS_REST), (v) => ({ weapon: gun(v, "repair"), cost: u128(obj(v, "repair").cost, "repair.cost") }));
    },
    async scrap(serial) {
      return shape(await call("scrap", { serial }, GAS_REST), (v) => ({ minted: decodeBalances2(obj(v, "scrap").minted, "scrap.minted") }));
    },
    async sell(vendor, tokenId, amount) {
      if (!positive(amount)) return local("E_BAD_AMOUNT");
      return shape(await call("sell", { vendor, token_id: tokenId, amount: String(amount) }, GAS_REST), (v) => ({ paid: u128(obj(v, "sell").paid, "sell.paid") }));
    },
    async buy(vendor, tokenId, amount) {
      if (!positive(amount)) return local("E_BAD_AMOUNT");
      return shape(await call("buy", { vendor, token_id: tokenId, amount: String(amount) }, GAS_REST), (v) => ({ cost: u128(obj(v, "buy").cost, "buy.cost") }));
    },
    async buyGun(vendor, serial) {
      return shape(await call("buy_gun", { vendor, serial }, GAS_REST), (v) => ({ weapon: gun(v, "buy_gun"), cost: u128(obj(v, "buy_gun").cost, "buy_gun.cost") }));
    },
    async exportGoods(tokenId, amount) {
      if (!positive(amount)) return local("E_BAD_AMOUNT");
      return shape(await call("export", { token_id: tokenId, amount: String(amount) }, GAS_REST), (v) => ({ paid: u128(obj(v, "export").paid, "export.paid") }));
    },
    async listWeapon(serial, price) {
      if (!positive(price)) return local("E_BAD_AMOUNT");
      return shape(await call("list_weapon", { serial, price: String(price) }, GAS_REST), (v) => ({ id: int(obj(v, "list_weapon").id, "list_weapon.id") }));
    },
    async listItem(tokenId, amount, price) {
      if (!positive(amount) || !positive(price)) return local("E_BAD_AMOUNT");
      const args = { token_id: tokenId, amount: String(amount), price: String(price) };
      return shape(await call("list_item", args, GAS_REST), (v) => ({ id: int(obj(v, "list_item").id, "list_item.id") }));
    },
    async buyListing(id) {
      if (!whole(id)) return local("E_BAD_AMOUNT");
      return shape(await call("buy_listing", { id }, GAS_REST), (v) => {
        const o = obj(v, "buy_listing");
        const weapon = optional(o.weapon, (x) => decodeWeapon(x, "buy_listing.weapon"));
        return { paid: u128(o.paid, "buy_listing.paid"), ...(weapon ? { weapon } : {}) };
      });
    },
    async cancelListing(id) {
      if (!whole(id)) return local("E_BAD_AMOUNT");
      return shape(await call("cancel_listing", { id }, GAS_REST), () => ({}));
    },
    async settle(amount) {
      if (!positive(amount)) return local("E_BAD_AMOUNT");
      return shape(await call("settle", { amount: String(amount) }, GAS_REST), (v) => {
        const o = obj(v, "settle");
        return { cleared: u128(o.cleared, "settle.cleared"), arrears: u128(o.arrears, "settle.arrears") };
      });
    },
    async buyBack(serial) {
      return shape(await call("buy_back", { serial }, GAS_REST), (v) => ({ weapon: gun(v, "buy_back"), cost: u128(obj(v, "buy_back").cost, "buy_back.cost") }));
    },

    async vendorBuild(blueprint, memo) {
      if (!BLUEPRINTS.has(blueprint)) return local("E_BAD_AMOUNT");
      return shape(await call("vendor_build", { blueprint, memo }, GAS_REST), built("vendor_build"));
    },
    async vendorPrice(what, price, memo) {
      if (!positive(price) || (what.serial === undefined) === (what.tokenId === undefined)) return local("E_BAD_AMOUNT");
      const args = { serial: what.serial ?? null, token_id: what.tokenId ?? null, price: String(price), memo };
      return shape(await call("vendor_price", args, GAS_REST), () => ({}));
    },
    async hmPosture(posture, memo) {
      return shape(await call("hm_posture", { posture, memo }, GAS_REST), (v) => ({ harbormaster: decodeHarbormaster(v, "hm_posture") }));
    },
    async nftTransfer(serial, receiverId) {
      return shape(await call("nft_transfer", { receiver_id: receiverId, token_id: serial }, GAS_REST, 1n), () => ({}));
    },
  };
}
