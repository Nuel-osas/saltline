// Saltline v2's shared interfaces (docs/GAME.md, docs/CONTRACT_V2.md). Every lane builds against these: the
// contract's client (chain.ts), the offline mock (mock.ts), the raid and the dock. Change this file and the docs
// together.
//
// Amounts and prices are plain integers (scrip has no decimals). The contract sends u128 as JSON strings; chain.ts
// converts. A failed read is unknown, never zero: views reject on failure.

// ---------------------------------------------------------------------------------------------------------------
// Things players own

export type MaterialId = "copper" | "chips" | "fuel" | "meds" | "core" | "servo" | "rotor";
export type ModId = "mag2" | "barrel2" | "comp" | "optic";
export type ConsumableId = "plate" | "charge" | "ammo";
/** Stackable tokens (NEP-245 ids). Weapons are separate: one NEP-171 token each. */
export type TokenId = "scrip" | MaterialId | ModId | ConsumableId;
export type Amounts<K extends string = TokenId> = Partial<Record<K, number>>;

export type FrameId = "longshore" | "stevedore" | "pilot";
export type Grade = "A" | "B" | "C" | "D";
export type BlueprintId = FrameId | ModId | ConsumableId;

/** A gun's rolled numbers, before mods and wear (items.ts `effective` applies those). */
export interface Stats {
  /** Per round. */
  damage: number;
  /** Rounds a minute. */
  rpm: number;
  /** Rounds a magazine. */
  mag: number;
  /** Percent of the baseline kick: 100 is the baseline, lower is steadier. */
  recoil: number;
  /** Percent of the baseline reload time: lower is quicker. */
  reload: number;
  /** Metres. */
  range: number;
}

/** held: in the owner's stash. raid: locked in a raid. listed: on the market. vendor: a vendor's stock. */
export type WeaponState = "held" | "raid" | "listed" | "vendor" | "wreck" | "impound";

/** One gun: an NFT (NEP-171 token id = `serial`). */
export interface Weapon {
  serial: string;
  frame: FrameId;
  grade: Grade;
  /** 0–100: how well it rolled across its frame's bands. The grade comes from this. */
  quality: number;
  stats: Stats;
  /** Fitted mods, at most one per slot. */
  mods: ModId[];
  /** 0–100. */
  condition: number;
  /** The account that built it, and that account's callsign then. */
  maker: string;
  makerCallsign: string;
  owner: string;
  builtAt: number;
  raids: number;
  extractions: number;
  /** How many accounts have owned it, the first included. */
  owners: number;
  /** Times it was carried out of someone's wreck. */
  recovered: number;
  state: WeaponState;
  /** The contract's appraisal in scrip (frame, grade and condition). */
  value: number;
}

// ---------------------------------------------------------------------------------------------------------------
// Raids

/** What the player takes in. `weapon: null` is the issue rifle, which can't be lost or sold. */
export interface Loadout {
  weapon: string | null;
  /** 0 or 1. */
  plates: number;
  /** 0–3 breaker charges. */
  charges: number;
  /** Extra magazines, 0–8, on top of the three every raid issues. */
  mags: number;
}

export interface Container {
  /** Indexes the salvage spots (the same 16 as v1). */
  spot: number;
  tokenId: MaterialId;
  amount: number;
  /** A bonded container: only in the manifests of players carrying heavy arrears. */
  bonded: boolean;
}

export interface Wreck {
  id: number;
  spot: number;
  owner: string;
  callsign: string;
  weapon: Weapon | null;
  items: { tokenId: TokenId; amount: number }[];
  at: number;
  expiresAt: number;
}

export type Posture = "patrols" | "pursuit";

/** The Harbormaster's wallet and what it buys (docs/GAME.md → The invoice). */
export interface HarbormasterView {
  accountId: string;
  /** Scrip it holds. It spends it down continuously (a 12-hour half-life). */
  balance: number;
  /** 0–100, from its balance. */
  strength: number;
  /** Where its agent has put that strength. */
  posture: Posture;
  /** Extra Inspection Units in every wave and patrol (0–4). */
  bonusDrones: number;
  /** The invoice thresholds in force now (pursuit lowers the Bailiff's). */
  secondNoticeAt: number;
  bailiffAt: number;
  secondBailiffAt: number;
  foreclosureAt: number;
  lastMemo: string | null;
}

export interface Raid {
  raidId: number;
  startedAt: number;
  loadout: Loadout;
  containers: Container[];
  wrecks: Wreck[];
  /** What is already on the invoice at the fence: the entry charge plus the share of arrears carried in. */
  invoiceStart: number;
  harbormaster: HarbormasterView;
}

/** What the game reports when a raid ends. The contract checks what it can (docs/CONTRACT_V2.md → Trust). */
export interface RaidReport {
  /** Spots of the containers opened. */
  opened: number[];
  /** Wreck ids recovered. */
  wrecks: number[];
  /** Parts picked up from destroyed machines. */
  parts: { servo: number; rotor: number };
  kills: { gull: number; hound: number };
  /** Uplinks cut, 0–3. */
  uplinks: number;
  used: { plates: number; charges: number; mags: number };
}

export type DeathBy = "machines" | "bailiff";

// ---------------------------------------------------------------------------------------------------------------
// The dock

export interface Profile {
  accountId: string;
  callsign: string;
  registeredAt: number;
  raids: number;
  extractions: number;
  deaths: number;
  /** What the player owes the Harbormaster. */
  arrears: number;
  activeRaid: number | null;
  /** Guns built, and scrip earned as maker's royalty. */
  built: number;
  royalties: number;
}

/** A price with the seller's or buyer's stated reason. */
export interface Quote {
  tokenId: TokenId;
  price: number;
  reason: string;
}

export type VendorId = "moss" | "ines";

export interface VendorGood {
  tokenId: ModId | ConsumableId;
  price: number;
  stock: number;
  reason: string;
}

export interface Vendor {
  id: VendorId;
  accountId: string;
  name: string;
  /** False when it can't cover another purchase: it buys nothing until it sells something. */
  open: boolean;
  scrip: number;
  /** Materials it holds to build from. */
  stock: Amounts<MaterialId>;
  /** What it pays for each material it buys. */
  bids: Quote[];
  /** What it sells that it built. */
  goods: VendorGood[];
  guns: { weapon: Weapon; price: number }[];
  lastMemo: string | null;
}

export interface Listing {
  id: number;
  seller: string;
  callsign: string;
  /** Scrip, for the whole lot. */
  price: number;
  at: number;
  weapon?: Weapon;
  item?: { tokenId: TokenId; amount: number };
}

export interface Impounded {
  weapon: Weapon;
  /** What the Harbormaster wants for it. */
  fee: number;
  expiresAt: number;
}

export interface Blueprint {
  id: BlueprintId;
  kind: "weapon" | "mod" | "consumable";
  inputs: Amounts<MaterialId>;
  /** Scrip, burned. */
  fee: number;
  /** Units made (ammunition comes four magazines at a time). */
  yields: number;
}

export interface EconomyView {
  scripSupply: number;
  minted24h: number;
  burned24h: number;
  players: number;
  weaponsBuilt: number;
  weaponsAlive: number;
  weaponsDestroyed: number;
  /** The last few sale prices for each frame and grade that has sold. */
  lastSales: { frame: FrameId; grade: Grade; prices: number[] }[];
}

export type LedgerKind =
  | "raid_start"
  | "extract"
  | "wreck"
  | "impound"
  | "recover"
  | "buy_back"
  | "build"
  | "fit"
  | "repair"
  | "scrap"
  | "sale"
  | "purchase"
  | "export"
  | "listing"
  | "market_sale"
  | "settle"
  | "posture"
  | "vendor_build"
  | "vendor_price";

export interface LedgerEvent {
  kind: LedgerKind;
  at: number;
  account: string;
  callsign?: string;
  text: string;
}

export interface LeaderRow {
  accountId: string;
  callsign: string;
  value: number;
}

export interface Leaderboard {
  /** Scrip plus the appraised value of guns held. */
  netWorth: LeaderRow[];
  extractions: LeaderRow[];
  /** Royalties earned as a maker. */
  makers: LeaderRow[];
}

// ---------------------------------------------------------------------------------------------------------------
// The contract, as the client sees it

export interface TxResult {
  ok: boolean;
  txHash?: string;
  /** Short, player-facing. */
  error?: string;
  /** The contract's error code (`E_…`) when it refused the call. */
  code?: string;
  /** It may have landed but couldn't be confirmed: show it as pending, never as failed, and don't resend it. */
  pending?: boolean;
}

/** Implemented by chain.ts (testnet) and mock.ts (in memory). */
export interface Chain2 {
  readonly network: "testnet" | "mock";
  readonly contractId: string;
  txUrl(txHash: string): string | null;
  accountUrl(accountId: string): string | null;

  // Views: free, no wallet. They reject on failure.
  profile(accountId: string): Promise<Profile | null>;
  balances(accountId: string): Promise<Amounts>;
  weapons(accountId: string): Promise<Weapon[]>;
  weapon(serial: string): Promise<Weapon | null>;
  vendors(): Promise<Vendor[]>;
  /** What the export desk pays for each material right now. */
  exportPrices(): Promise<Quote[]>;
  listings(): Promise<Listing[]>;
  wrecks(): Promise<Wreck[]>;
  impound(accountId: string): Promise<Impounded[]>;
  harbormaster(): Promise<HarbormasterView>;
  raid(raidId: number): Promise<Raid | null>;
  recent(limit: number): Promise<LedgerEvent[]>;
  economy(): Promise<EconomyView>;
  leaderboard(): Promise<Leaderboard>;

  // Calls: signed by the current wallet in the background.
  startRaid(loadout: Loadout): Promise<TxResult & { raid?: Raid }>;
  extract(
    raidId: number,
    report: RaidReport,
  ): Promise<TxResult & { minted?: Amounts; weapon?: Weapon | null; recovered?: Weapon[]; invoice?: number; arrears?: number }>;
  die(
    raidId: number,
    report: RaidReport,
    spot: number,
    by: DeathBy,
  ): Promise<TxResult & { wreckId?: number | null; impounded?: boolean; invoice?: number; arrears?: number }>;
  build(blueprint: BlueprintId): Promise<TxResult & { weapon?: Weapon; minted?: Amounts }>;
  fit(serial: string, mod: ModId): Promise<TxResult & { weapon?: Weapon }>;
  /** Repairs to 100, or by `points` if given. */
  repair(serial: string, points?: number): Promise<TxResult & { weapon?: Weapon; cost?: number }>;
  scrap(serial: string): Promise<TxResult & { minted?: Amounts }>;
  sell(vendor: VendorId, tokenId: MaterialId, amount: number): Promise<TxResult & { paid?: number }>;
  buy(vendor: VendorId, tokenId: ModId | ConsumableId, amount: number): Promise<TxResult & { cost?: number }>;
  buyGun(vendor: VendorId, serial: string): Promise<TxResult & { weapon?: Weapon; cost?: number }>;
  exportGoods(tokenId: MaterialId, amount: number): Promise<TxResult & { paid?: number }>;
  listWeapon(serial: string, price: number): Promise<TxResult & { id?: number }>;
  listItem(tokenId: Exclude<TokenId, "scrip">, amount: number, price: number): Promise<TxResult & { id?: number }>;
  buyListing(id: number): Promise<TxResult & { paid?: number; weapon?: Weapon }>;
  cancelListing(id: number): Promise<TxResult>;
  /** Pays `amount` scrip to the Harbormaster; each scrip clears two of arrears. */
  settle(amount: number): Promise<TxResult & { cleared?: number; arrears?: number }>;
  buyBack(serial: string): Promise<TxResult & { weapon?: Weapon; cost?: number }>;
}

export type WalletKind = "guest" | "mock";

export interface Wallet2 {
  readonly kind: WalletKind;
  accountId(): string | null;
  registered(): Promise<boolean>;
  /** First visit: the faucet funds the account and registers the callsign. */
  claim(callsign: string): Promise<TxResult>;
}

/** What v2 adds to the game's shared context: `window.__G.v2`. */
export interface V2 {
  chain: Chain2;
  wallet: Wallet2;
  /** What the player will take into the next raid (the dock's loadout screen sets it). */
  loadout: Loadout;
  /** The raid in play, or null between raids. */
  raid: Raid | null;
}

/** Events on G.events that v2 adds (noun:verb, like the baseline's). */
export interface V2Events {
  "v2:ready": V2;
  "raid:started": Raid;
  /** The live invoice changed. `next` is the threshold ahead and what it brings, or null past the last. */
  "invoice:changed": { total: number; added: number; why: string; next: { at: number; what: string } | null };
  "invoice:threshold": { at: number; what: "second_notice" | "bailiff" | "second_bailiff" | "foreclosure" };
  "raid:extracted": { ok: boolean; invoice: number | null; arrears: number | null };
  "raid:died": { by: DeathBy; impounded: boolean | null };
  "dock:open": { tab: string };
  "dock:closed": Record<string, never>;
  /** The player's holdings changed (after any confirmed call): screens re-read. */
  "stash:changed": Record<string, never>;
}
