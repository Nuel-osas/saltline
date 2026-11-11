// The shared interfaces of the economy layer (docs/ECONOMY.md). Every lane codes against these: the real chain
// (chain.ts), the in-memory mock (mock.ts), the in-run salvage code and the Dockside. Change this file and the doc
// together.
//
// Amounts are plain integers (scrip has no decimals). The contract sends u128 as JSON strings; chain.ts converts.
// A failed read is unknown, never zero: views reject on failure, and callers show "unknown" rather than a 0 balance.

export type CargoId = "copper" | "meds" | "chips" | "fuel" | "core";
export type GearId = "plate" | "mag" | "cutter";
export type TokenId = "scrip" | CargoId | GearId;
export type BrokerId = "moss" | "ines" | "qm";

export interface ItemInfo {
  id: TokenId;
  name: string;
  kind: "currency" | "cargo" | "gear";
  /** Carry weight per unit (cargo only; 0 otherwise). */
  weight: number;
  /** Base price in scrip (cargo: the bid at target stock; gear: the ask with no recent sales). */
  base: number;
  /** Cargo only: what the freighter pays a broker per unit. */
  export?: number;
  /** Cargo only: the stock level at which a broker bids the base price. */
  target?: number;
}

export type Amounts<K extends string = TokenId> = Partial<Record<K, number>>;

export interface Profile {
  accountId: string;
  callsign: string;
  /** Block timestamp, ms. */
  registeredAt: number;
  runs: number;
  extractions: number;
  deaths: number;
  /** The best single run's cargo value at the bids when it was extracted. */
  bestHaul: number;
  /** The run still open for this player, if any (lets a reload resume it). */
  activeRun?: number | null;
}

/** A price with the reason the broker gives for it (shown in the Dockside tooltip). */
export interface Quote {
  tokenId: TokenId;
  price: number;
  reason: string;
}

export interface BrokerView {
  id: BrokerId;
  accountId: string;
  name: string;
  open: boolean;
  scrip: number;
  /** The broker's bid lever, 80–120 (100 = neutral). */
  stance: number;
  stock: Amounts<CargoId>;
  /** What it pays for each cargo it buys. */
  bids: Quote[];
  /** What it charges for the gear it sells. */
  asks: Quote[];
  shares: { accountId: string; callsign: string; shares: number }[];
  /** The agent's last stated reason for an export or a stance change. */
  lastMemo: string | null;
}

/** A sealed container in this run. `spot` indexes SALVAGE_SPOTS (salvage/spots.ts) and the contract's spot table. */
export interface ManifestEntry {
  spot: number;
  tokenId: CargoId;
  amount: number;
}

export interface WreckView {
  id: number;
  spot: number;
  owner: string;
  callsign: string;
  items: { tokenId: CargoId; amount: number }[];
  /** Block timestamp, ms. */
  at: number;
}

export interface Manifest {
  runId: number;
  startedAt: number;
  containers: ManifestEntry[];
  wrecks: WreckView[];
}

export interface Listing {
  id: number;
  seller: string;
  callsign: string;
  tokenId: CargoId | GearId;
  amount: number;
  /** Scrip per unit. */
  price: number;
  at: number;
}

export type LedgerKind =
  | "run_start"
  | "extract"
  | "wreck"
  | "sale"
  | "purchase"
  | "invest"
  | "close"
  | "reopen"
  | "export"
  | "stance"
  | "listing";

export interface LedgerEvent {
  kind: LedgerKind;
  at: number;
  account: string;
  callsign?: string;
  /** One line for the ticker, written by the contract or the chain adapter. */
  text: string;
  txHash?: string;
}

export interface LeaderRow {
  accountId: string;
  callsign: string;
  value: number;
}

export interface Leaderboard {
  netWorth: LeaderRow[];
  bestHaul: LeaderRow[];
  investors: LeaderRow[];
}

export interface SimBroker {
  open: boolean;
  scrip: number;
  bids: Amounts<CargoId>;
  stock: Amounts<CargoId>;
}

export interface SimPoint {
  hour: number;
  brokers: Record<BrokerId, SimBroker>;
}

/** The town's shared arc on the open ledger (docs/STORY.md). */
export interface District {
  id: "clinic" | "generators";
  tokenId: CargoId;
  need: number;
  have: number;
  lit: boolean;
  litAt: number | null;
}

export interface TownView {
  act: 1 | 2 | 3;
  /** All-time units of each cargo sold to brokers by players (counted from the story upgrade). */
  delivered: Amounts<CargoId>;
  districts: District[];
  /** The Quartermaster's client: revealed once the lights are back and 8 cores have been sold to him in total. */
  client: { need: number; have: number; revealed: boolean; revealedAt: number | null };
  /** 0–100. Zero before the reveal. Each wave gets `bonusDrones` extra drones. */
  harbormaster: { strength: number; recentCores: number; bonusDrones: number };
}

export interface TxResult {
  ok: boolean;
  txHash?: string;
  /** Short, player-facing. */
  error?: string;
  /** The contract's error code (`E_…`) when it refused the call. */
  code?: string;
  /** The transaction may have landed but couldn't be confirmed: show it as pending, never as failed, and don't
   * resend it (the player might pay twice). */
  pending?: boolean;
}

/** The game contract, as the client sees it. Implemented by chain.ts (testnet) and mock.ts (in memory). */
export interface Chain {
  readonly network: "testnet" | "mock";
  readonly contractId: string;
  /** Explorer link for a transaction, or null on the mock. */
  txUrl(txHash: string): string | null;

  // Views: free, no wallet needed. They reject on failure.
  profile(accountId: string): Promise<Profile | null>;
  balances(accountId: string): Promise<Amounts>;
  brokers(): Promise<BrokerView[]>;
  wrecks(): Promise<WreckView[]>;
  listings(): Promise<Listing[]>;
  recent(limit: number): Promise<LedgerEvent[]>;
  leaderboard(): Promise<Leaderboard>;
  simulate(hours: number, traders: number, seed: number): Promise<SimPoint[]>;
  /** A run's manifest, or null when there is no such run. */
  manifest(runId: number): Promise<Manifest | null>;
  /** The town's arc (docs/STORY.md). Optional until every implementation has it; callers treat absence as Act I. */
  town?(): Promise<TownView>;

  // Calls: signed by the current wallet in the background, no prompts.
  startRun(gear: GearId[]): Promise<TxResult & { manifest?: Manifest }>;
  extract(
    runId: number,
    opened: number[],
    wrecks: number[],
  ): Promise<TxResult & { minted?: Amounts<CargoId>; haulValue?: number }>;
  die(runId: number, opened: number[], wrecks: number[], spot: number): Promise<TxResult & { wreckId?: number | null }>;
  sell(broker: BrokerId, tokenId: CargoId, amount: number): Promise<TxResult & { paid?: number }>;
  buy(broker: BrokerId, tokenId: GearId, amount: number): Promise<TxResult & { cost?: number }>;
  invest(broker: BrokerId, amount: number): Promise<TxResult & { shares?: number; reopened?: boolean }>;
  list(tokenId: CargoId | GearId, amount: number, price: number): Promise<TxResult & { id?: number }>;
  buyListing(id: number): Promise<TxResult & { paid?: number }>;
  cancelListing(id: number): Promise<TxResult>;
}

export type WalletKind = "guest" | "privy" | "near-connect" | "mock";

/** Who the player is on chain. */
export interface Wallet {
  readonly kind: WalletKind;
  /** The NEAR account id, or null before one exists. */
  accountId(): string | null;
  /** True once the account exists on chain and has a profile. */
  registered(): Promise<boolean>;
  /** First run only: the faucet funds the account and registers the callsign. */
  claim(callsign: string): Promise<TxResult>;
}

/** What the economy layer adds to the game's shared context (window.__G.economy). */
export interface Economy {
  chain: Chain;
  wallet: Wallet;
  /** The current run's manifest while a run is on, else null. */
  manifest: Manifest | null;
  /** Cargo carried in this run, by token. */
  carried: Amounts<CargoId>;
  /**
   * Gear equipped for the next run, set by the Dockside. The salvage module applies it at the run's reset (through
   * G.ext.gear), sends it to startRun, and empties the list once the chain confirms the run burned it.
   */
  equipped?: GearId[];
  /**
   * Set by the Dockside's deploy gate when a player without a dock pass picks "Play without a pass". The salvage
   * module reads it at the next run start, clears it, and plays that one run as the baseline, saying so.
   */
  passless?: boolean;
}
