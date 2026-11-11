// The game contract on NEAR testnet, behind the `Chain` interface (types.ts), through near-kit.
//
// Wire format: docs/CONTRACT_API.md. snake_case on the wire, camelCase here; U128 amounts arrive as JSON strings
// and leave as numbers, refusing any value a JS number can't hold exactly.
//
// The rules this file keeps:
// - Views reject on failure. Nothing here turns an unreadable value into 0.
// - Calls go through one queue, one at a time, so the wallet's nonces never collide.
// - A transient RPC failure (timeout, 429, 5xx, dropped connection) is retried with backoff, rotating RPCs. Once a
//   transaction is signed, a retry re-sends the identical signed bytes, which the chain executes at most once.
// - A call that executed and failed (a contract panic) is never retried. `E_CODE: message` comes back as
//   `{ ok: false, error: message, code }`.
// - When a transaction may have landed but can't be confirmed, the result says `pending: true`, never a plain
//   failure, so the player doesn't pay twice.
import { Near, type TransactionBuilder, type TxExecutionStatus } from "near-kit";
// .js: server/faucet.ts runs this file under Node's ES module rules on Vercel.
import { CARGO, ITEMS } from "./items.js";
import type {
  Amounts,
  BrokerId,
  BrokerView,
  CargoId,
  Chain,
  GearId,
  LedgerEvent,
  LedgerKind,
  Leaderboard,
  LeaderRow,
  Listing,
  Manifest,
  Profile,
  Quote,
  SimBroker,
  SimPoint,
  TokenId,
  TxResult,
  WreckView,
} from "./types";
import type { AccountLookup, SigningKey } from "./wallet";

/** A TxResult with the contract's error code and the pending flag (see the interface note in the lane report). */
export type CallResult = TxResult & { code?: string; pending?: boolean };

/** The calls as both chains implement them: the Chain interface's results plus `code`, `pending` and the reply fields. */
export interface DetailedCalls {
  startRun(gear: GearId[]): Promise<CallResult & { manifest?: Manifest }>;
  extract(runId: number, opened: number[], wrecks: number[]): Promise<CallResult & { minted?: Amounts<CargoId>; haulValue?: number }>;
  die(runId: number, opened: number[], wrecks: number[], spot: number): Promise<CallResult & { wreckId?: number | null }>;
  sell(broker: BrokerId, tokenId: CargoId, amount: number): Promise<CallResult & { paid?: number }>;
  buy(broker: BrokerId, tokenId: GearId, amount: number): Promise<CallResult & { cost?: number }>;
  invest(broker: BrokerId, amount: number): Promise<CallResult & { shares?: number; reopened?: boolean }>;
  list(tokenId: CargoId | GearId, amount: number, price: number): Promise<CallResult & { id?: number }>;
  buyListing(id: number): Promise<CallResult & { paid?: number }>;
  cancelListing(id: number): Promise<CallResult>;
}

/** A Chain whose calls return the detailed results. Assignable to Chain. */
export type DetailedChain = Omit<Chain, keyof DetailedCalls> & DetailedCalls;

// ---------------------------------------------------------------------------------------------------------------
// Contract errors

/** The meanings in docs/CONTRACT_API.md → Errors, used when a panic carries a code but no text. */
export const ERROR_TEXT: Record<string, string> = {
  E_NOT_REGISTERED: "Not registered",
  E_ALREADY_REGISTERED: "Already registered",
  E_CALLSIGN_TAKEN: "Callsign taken",
  E_BAD_CALLSIGN: "Bad callsign",
  E_NOT_FAUCET: "Only the faucet account can call this",
  E_NOT_BROKER: "Only the broker's own account can call this",
  E_NO_RUN: "No such run",
  E_RUN_CLOSED: "The run is already closed",
  E_TOO_SOON: "Too soon",
  E_NOT_IN_MANIFEST: "Not in this run's manifest",
  E_OVER_LIMIT: "Over the carry limit",
  E_DUPLICATE: "Listed twice",
  E_BROKER_CLOSED: "The broker is closed",
  E_BROKER_BROKE: "The broker can't cover the sale",
  E_DOESNT_BUY: "The broker doesn't buy this",
  E_DOESNT_SELL: "The broker doesn't sell this",
  E_FUNDS: "Not enough scrip or items",
  E_NO_GEAR: "Equipping gear you don't have",
  E_EXPORT_COOLDOWN: "An export within the hour",
  E_EXPORT_STOCK: "Exporting more than the broker holds",
  E_STANCE_RANGE: "Stance outside 80–120",
  E_NO_LISTING: "No such listing",
  E_BAD_AMOUNT: "Zero or too large",
};

const PANIC = /(E_[A-Z][A-Z0-9_]*)(?::\s*([^"\\\n]*))?/;

/** Finds `E_CODE: message` in a panic string, however deeply near-kit or the node wrapped it. */
export function parsePanic(text: unknown): { code: string; message: string } | null {
  if (typeof text !== "string") return null;
  const m = PANIC.exec(text);
  if (!m) return null;
  const message = (m[2] ?? "").trim() || ERROR_TEXT[m[1]] || m[1];
  return { code: m[1], message };
}

const errCode = (e: unknown) => (e && typeof e === "object" ? (e as { code?: unknown }).code : undefined);

/** Executed on chain and failed: retrying would run it again. */
function executedFailure(e: unknown): boolean {
  const code = errCode(e);
  return code === "FUNCTION_CALL_ERROR" || code === "CONTRACT_EXECUTION_ERROR";
}

/** Safe to try again: the request never produced an outcome. near-kit flags these `retryable`. */
export function isTransient(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  const code = errCode(e);
  if (code === "INVALID_NONCE" || executedFailure(e)) return false;
  return (e as { retryable?: unknown }).retryable === true;
}

function panicOf(e: unknown): { code: string; message: string } | null {
  if (!e || typeof e !== "object") return null;
  const o = e as { panic?: unknown; message?: unknown; details?: unknown };
  return parsePanic(o.panic) ?? parsePanic(o.message) ?? parsePanic(o.details ? JSON.stringify(o.details) : null);
}

/** A short, player-facing line for an error that isn't a contract refusal. */
function friendly(e: unknown): string {
  const code = errCode(e);
  const msg = e instanceof Error ? e.message : String(e);
  if (code === "ACCOUNT_NOT_FOUND" || code === "ACCESS_KEY_NOT_FOUND") return "No dock pass on chain yet. Claim one first.";
  if (code === "INSUFFICIENT_BALANCE" || /NotEnoughBalance|LackBalanceForState/.test(msg)) {
    return "This wallet is out of testnet NEAR for gas.";
  }
  if (code === "INVALID_TRANSACTION") return "The chain refused the transaction.";
  if (code === "NO_CONTRACT_CODE" || /CodeDoesNotExist/.test(msg)) return "The game contract isn't deployed yet.";
  if (isTransient(e)) return "The chain isn't answering. Try again in a moment.";
  return "Something went wrong at the dock. Try again.";
}

// ---------------------------------------------------------------------------------------------------------------
// Wire decoding. Every decoder throws on a shape it doesn't expect, so a bad response rejects instead of
// showing a wrong number.

export class WireError extends Error {
  override name = "WireError";
}

/** A U128 (JSON string of an integer) as a number, refusing anything a JS number can't hold exactly. */
export function u128(v: unknown, field: string): number {
  if (typeof v === "string" && /^\d{1,39}$/.test(v)) {
    const n = Number(v);
    if (!Number.isSafeInteger(n)) throw new WireError(`${field}: ${v} is too large to show exactly`);
    return n;
  }
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return v;
  throw new WireError(`${field}: expected a U128 string, got ${JSON.stringify(v)}`);
}

function int(v: unknown, field: string): number {
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return v;
  throw new WireError(`${field}: expected a whole number, got ${JSON.stringify(v)}`);
}

function str(v: unknown, field: string): string {
  if (typeof v === "string") return v;
  throw new WireError(`${field}: expected a string, got ${JSON.stringify(v)}`);
}

function bool(v: unknown, field: string): boolean {
  if (typeof v === "boolean") return v;
  throw new WireError(`${field}: expected true or false, got ${JSON.stringify(v)}`);
}

function obj(v: unknown, field: string): Record<string, unknown> {
  if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  throw new WireError(`${field}: expected an object`);
}

function list<T>(v: unknown, field: string, each: (x: unknown, f: string) => T): T[] {
  if (!Array.isArray(v)) throw new WireError(`${field}: expected a list`);
  return v.map((x, i) => each(x, `${field}[${i}]`));
}

const optional = <T>(v: unknown, f: (x: unknown) => T): T | null => (v === null || v === undefined ? null : f(v));

const TOKENS = new Set<string>(Object.keys(ITEMS));
const CARGOS = new Set<string>(CARGO);
const BROKER_IDS = new Set<string>(["moss", "ines", "qm"]);
const KINDS = new Set<string>([
  "run_start",
  "extract",
  "wreck",
  "sale",
  "purchase",
  "invest",
  "close",
  "reopen",
  "export",
  "stance",
  "listing",
]);

function token(v: unknown, field: string): TokenId {
  const t = str(v, field);
  if (!TOKENS.has(t)) throw new WireError(`${field}: unknown token ${t}`);
  return t as TokenId;
}

function cargo(v: unknown, field: string): CargoId {
  const t = str(v, field);
  if (!CARGOS.has(t)) throw new WireError(`${field}: ${t} is not cargo`);
  return t as CargoId;
}

/** `{ "<token>": U128 }`. Token ids this client doesn't know are skipped, not guessed at. */
function amounts<K extends string>(v: unknown, field: string, keep: Set<string>): Amounts<K> {
  const out: Record<string, number> = {};
  for (const [k, x] of Object.entries(obj(v, field))) if (keep.has(k)) out[k] = u128(x, `${field}.${k}`);
  return out as Amounts<K>;
}

export function decodeProfile(raw: unknown): (Profile & { activeRun: number | null }) | null {
  if (raw === null) return null;
  const o = obj(raw, "profile");
  return {
    accountId: str(o.account_id, "profile.account_id"),
    callsign: str(o.callsign, "profile.callsign"),
    registeredAt: int(o.registered_at, "profile.registered_at"),
    runs: int(o.runs, "profile.runs"),
    extractions: int(o.extractions, "profile.extractions"),
    deaths: int(o.deaths, "profile.deaths"),
    bestHaul: u128(o.best_haul, "profile.best_haul"),
    activeRun: optional(o.active_run, (x) => int(x, "profile.active_run")),
  };
}

export const decodeBalances = (raw: unknown): Amounts => amounts<TokenId>(raw, "balances", TOKENS);

function decodeQuote(raw: unknown, f: string): Quote {
  const o = obj(raw, f);
  return { tokenId: token(o.token_id, `${f}.token_id`), price: u128(o.price, `${f}.price`), reason: str(o.reason, `${f}.reason`) };
}

export function decodeBroker(raw: unknown, f = "broker"): BrokerView {
  const o = obj(raw, f);
  const id = str(o.id, `${f}.id`);
  if (!BROKER_IDS.has(id)) throw new WireError(`${f}.id: unknown broker ${id}`);
  return {
    id: id as BrokerId,
    accountId: str(o.account_id, `${f}.account_id`),
    name: str(o.name, `${f}.name`),
    open: bool(o.open, `${f}.open`),
    scrip: u128(o.scrip, `${f}.scrip`),
    stance: int(o.stance, `${f}.stance`),
    stock: amounts<CargoId>(o.stock, `${f}.stock`, CARGOS),
    bids: list(o.bids, `${f}.bids`, decodeQuote),
    asks: list(o.asks, `${f}.asks`, decodeQuote),
    shares: list(o.shares, `${f}.shares`, (s, g) => {
      const x = obj(s, g);
      return { accountId: str(x.account_id, `${g}.account_id`), callsign: str(x.callsign, `${g}.callsign`), shares: u128(x.shares, `${g}.shares`) };
    }),
    lastMemo: optional(o.last_memo, (x) => str(x, `${f}.last_memo`)),
  };
}

export function decodeWreck(raw: unknown, f = "wreck"): WreckView {
  const o = obj(raw, f);
  return {
    id: int(o.id, `${f}.id`),
    spot: int(o.spot, `${f}.spot`),
    owner: str(o.owner, `${f}.owner`),
    callsign: str(o.callsign, `${f}.callsign`),
    items: list(o.items, `${f}.items`, (x, g) => {
      const i = obj(x, g);
      return { tokenId: cargo(i.token_id, `${g}.token_id`), amount: u128(i.amount, `${g}.amount`) };
    }),
    at: int(o.at, `${f}.at`),
  };
}

export function decodeManifest(raw: unknown): Manifest | null {
  if (raw === null) return null;
  const o = obj(raw, "manifest");
  return {
    runId: int(o.run_id, "manifest.run_id"),
    startedAt: int(o.started_at, "manifest.started_at"),
    containers: list(o.containers, "manifest.containers", (x, g) => {
      const c = obj(x, g);
      return { spot: int(c.spot, `${g}.spot`), tokenId: cargo(c.token_id, `${g}.token_id`), amount: u128(c.amount, `${g}.amount`) };
    }),
    wrecks: list(o.wrecks, "manifest.wrecks", decodeWreck),
  };
}

export function decodeListing(raw: unknown, f = "listing"): Listing {
  const o = obj(raw, f);
  const t = token(o.token_id, `${f}.token_id`);
  if (t === "scrip") throw new WireError(`${f}.token_id: scrip can't be listed`);
  return {
    id: int(o.id, `${f}.id`),
    seller: str(o.seller, `${f}.seller`),
    callsign: str(o.callsign, `${f}.callsign`),
    tokenId: t,
    amount: u128(o.amount, `${f}.amount`),
    price: u128(o.price, `${f}.price`),
    at: int(o.at, `${f}.at`),
  };
}

/** Events of a kind this client doesn't know are dropped, so a newer contract doesn't blank the ticker. */
export function decodeEvents(raw: unknown): LedgerEvent[] {
  if (!Array.isArray(raw)) throw new WireError("recent: expected a list");
  const out: LedgerEvent[] = [];
  raw.forEach((x, i) => {
    const f = `recent[${i}]`;
    const o = obj(x, f);
    const kind = str(o.kind, `${f}.kind`);
    if (!KINDS.has(kind)) return;
    const e: LedgerEvent = { kind: kind as LedgerKind, at: int(o.at, `${f}.at`), account: str(o.account, `${f}.account`), text: str(o.text, `${f}.text`) };
    if (o.callsign !== undefined && o.callsign !== null) e.callsign = str(o.callsign, `${f}.callsign`);
    out.push(e);
  });
  return out;
}

const decodeRow = (x: unknown, f: string): LeaderRow => {
  const o = obj(x, f);
  return { accountId: str(o.account_id, `${f}.account_id`), callsign: str(o.callsign, `${f}.callsign`), value: u128(o.value, `${f}.value`) };
};

export function decodeLeaderboard(raw: unknown): Leaderboard {
  const o = obj(raw, "leaderboard");
  return {
    netWorth: list(o.net_worth, "leaderboard.net_worth", decodeRow),
    bestHaul: list(o.best_haul, "leaderboard.best_haul", decodeRow),
    investors: list(o.investors, "leaderboard.investors", decodeRow),
  };
}

export function decodeSim(raw: unknown): SimPoint[] {
  return list(raw, "simulate", (x, f) => {
    const o = obj(x, f);
    const b = obj(o.brokers, `${f}.brokers`);
    const brokers = {} as Record<BrokerId, SimBroker>;
    for (const id of ["moss", "ines", "qm"] as BrokerId[]) {
      const s = obj(b[id], `${f}.brokers.${id}`);
      brokers[id] = {
        open: bool(s.open, `${f}.brokers.${id}.open`),
        scrip: u128(s.scrip, `${f}.brokers.${id}.scrip`),
        bids: amounts<CargoId>(s.bids, `${f}.brokers.${id}.bids`, CARGOS),
        stock: amounts<CargoId>(s.stock, `${f}.brokers.${id}.stock`, CARGOS),
      };
    }
    return { hour: int(o.hour, `${f}.hour`), brokers };
  });
}

// ---------------------------------------------------------------------------------------------------------------
// The port: the few things this file needs from NEAR. nearKitPort() is the real one; tests pass a stub.

export type CallSpec =
  | { kind: "call"; signerId: string; privateKey: `ed25519:${string}`; contractId: string; method: string; args: object; gasTgas: number }
  | { kind: "transfer"; signerId: string; privateKey: `ed25519:${string}`; receiverId: string; yocto: bigint };

/** An execution outcome as the RPC returns it (only the fields read here). */
export interface RawOutcome {
  status?: unknown;
  transaction?: { hash?: string };
}

export interface PreparedTx {
  /** The signed transaction's hash, or null before it has been signed. */
  hash(): string | null;
  /** Signs (if not yet signed) and broadcasts. near-kit re-signs only when the node rejected the nonce, i.e. nothing ran. */
  send(attempt: number): Promise<RawOutcome>;
  /** Broadcasts the identical signed bytes again, after a failure that may have hidden a success. */
  resend(attempt: number): Promise<RawOutcome>;
  /** The outcome by hash; null when no node will say. Throws a FUNCTION_CALL_ERROR for an executed failure. */
  status(attempt: number): Promise<RawOutcome | null>;
}

export interface NearPort {
  view(contractId: string, method: string, args: object, attempt: number): Promise<unknown>;
  accountExists(accountId: string, attempt: number): Promise<boolean>;
  prepare(spec: CallSpec): PreparedTx;
}

export function nearKitPort(opts: { rpcUrls: readonly string[]; waitUntil?: TxExecutionStatus }): NearPort {
  if (!opts.rpcUrls.length) throw new Error("nearKitPort: no RPC URLs");
  const waitUntil = opts.waitUntil ?? "EXECUTED_OPTIMISTIC";
  // near-kit's own retries are off: this file owns the retry policy, so there is one, and it is tested.
  const nears = opts.rpcUrls.map((rpcUrl) => new Near({ network: { rpcUrl, networkId: "testnet" }, retryConfig: { maxRetries: 0 } }));
  const pick = (attempt: number) => nears[attempt % nears.length];
  return {
    async view(contractId, method, args, attempt) {
      // Views read at "optimistic" finality, the same point calls wait for (EXECUTED_OPTIMISTIC). near-kit's default,
      // "final", runs about two blocks behind, so a haul just extracted wasn't in the hold yet when the Dockside read it.
      const r = await pick(attempt).view(contractId, method, args, { finality: "optimistic" });
      if (r === undefined) throw new WireError(`${method}: the contract returned nothing`);
      return r;
    },
    async accountExists(accountId, attempt) {
      try {
        await pick(attempt).rpc.getAccount(accountId);
        return true;
      } catch (e) {
        if (errCode(e) === "ACCOUNT_NOT_FOUND") return false;
        throw e;
      }
    },
    prepare(spec) {
      let builder: TransactionBuilder | null = null;
      const build = (near: Near) => {
        const b = near.transaction(spec.signerId).signWith(spec.privateKey);
        return spec.kind === "transfer"
          ? b.transfer(spec.receiverId, spec.yocto)
          : b.functionCall(spec.contractId, spec.method, spec.args, { gas: `${spec.gasTgas} Tgas` });
      };
      return {
        hash: () => builder?.getHash() ?? null,
        async send(attempt) {
          if (!builder?.getHash()) builder = build(pick(attempt));
          return (await builder.send({ waitUntil })) as RawOutcome;
        },
        async resend(attempt) {
          if (!builder?.getHash()) throw new Error("resend before the transaction was signed");
          return (await pick(attempt).rpc.sendTransaction(builder.serialize(), waitUntil)) as RawOutcome;
        },
        async status(attempt) {
          const h = builder?.getHash();
          if (!h) return null;
          try {
            return (await pick(attempt).rpc.getTransactionStatus(h, spec.signerId, waitUntil)) as RawOutcome;
          } catch (e) {
            if (executedFailure(e)) throw e;
            return null;
          }
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Executing one transaction

export interface ExecOptions {
  /** Retries after the first attempt, for transient failures only. */
  retries?: number;
  backoffMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface Executed extends CallResult {
  value?: unknown;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function decodeSuccess(outcome: RawOutcome): { done: true; value: unknown } | { done: false } {
  const s = outcome?.status;
  if (!s || typeof s !== "object") return { done: false };
  if ("SuccessReceiptId" in s) return { done: true, value: undefined };
  if (!("SuccessValue" in s)) return { done: false };
  const b64 = (s as { SuccessValue: unknown }).SuccessValue;
  if (typeof b64 !== "string" || b64 === "") return { done: true, value: undefined };
  const text = new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
  try {
    return { done: true, value: JSON.parse(text) };
  } catch {
    return { done: true, value: text };
  }
}

const PENDING_TEXT = "Sent, but not confirmed yet. Check the ledger before trying again.";

function refusal(e: unknown, txHash: string | undefined): Executed {
  const p = panicOf(e);
  const out: Executed = { ok: false, error: p ? p.message : "The contract refused that." };
  if (p) out.code = p.code;
  if (txHash) out.txHash = txHash;
  return out;
}

/**
 * Sends one prepared transaction under the retry rules at the top of this file. Never throws: every outcome is a
 * result, and an ambiguous one is `pending`.
 */
export async function executeTx(tx: PreparedTx, opts: ExecOptions = {}): Promise<Executed> {
  const retries = opts.retries ?? 3;
  const backoff = opts.backoffMs ?? 400;
  const sleep = opts.sleep ?? realSleep;
  const hashOf = (o?: RawOutcome) => tx.hash() ?? o?.transaction?.hash ?? undefined;

  const settle = (outcome: RawOutcome): Executed => {
    const d = decodeSuccess(outcome);
    const txHash = hashOf(outcome);
    if (!d.done) return { ok: false, pending: true, error: PENDING_TEXT, ...(txHash ? { txHash } : {}) };
    return { ok: true, value: d.value, ...(txHash ? { txHash } : {}) };
  };

  const reconcile = async (attempt: number): Promise<Executed> => {
    try {
      const st = await tx.status(attempt);
      if (st) return settle(st);
    } catch (e) {
      if (executedFailure(e)) return refusal(e, hashOf());
    }
    const txHash = hashOf();
    return { ok: false, pending: true, error: PENDING_TEXT, ...(txHash ? { txHash } : {}) };
  };

  // Once a signed transaction might have reached a node, only its identical bytes are ever sent again.
  let mayHaveLanded = false;
  for (let attempt = 0; ; attempt++) {
    try {
      return settle(mayHaveLanded ? await tx.resend(attempt) : await tx.send(attempt));
    } catch (e) {
      if (executedFailure(e)) return refusal(e, hashOf());
      // A re-send refused for its nonce means the first copy (or another tab's call) used it: ask by hash.
      if (errCode(e) === "INVALID_NONCE" && mayHaveLanded) return reconcile(attempt + 1);
      if (isTransient(e)) {
        if (tx.hash()) mayHaveLanded = true;
        if (attempt < retries) {
          await sleep(backoff * 2 ** attempt + Math.floor(Math.random() * backoff));
          continue;
        }
        if (mayHaveLanded) return reconcile(attempt + 1);
      }
      const txHash = hashOf();
      return { ok: false, error: friendly(e), ...(txHash ? { txHash } : {}) };
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The chain

export interface TestnetChainOptions {
  config: { contractId: string; rpcUrls: readonly string[]; explorerTxUrl: string };
  /** The current wallet's key, or null before there is one. */
  keys: () => SigningKey | null;
  port?: NearPort;
  exec?: ExecOptions;
}

export interface TestnetChain extends DetailedChain, AccountLookup {
  readonly network: "testnet";
  manifest(runId: number): Promise<Manifest | null>;
  /** Calls queued or in flight. */
  queued(): number;
}

// Prepaid gas, in Tgas. NEAR reserves prepaid gas at a pessimistic price (about 10× the base price), so a guest
// account must hold roughly 0.001 NEAR per Tgas prepaid before it may send a call, even though unused gas comes
// back. On testnet, every game call burned about 2.5 Tgas in its function receipt (start_run 2.51, sell 2.47), so
// 30 and 20 leave 8–12× headroom while reserving 0.03 and 0.02 NEAR. At 100 Tgas, the reservation (0.1009 NEAR)
// was more than a whole dock pass, and the first start_run was refused with NotEnoughBalance.
export const GAS_RUN = 30;
export const GAS_DEFAULT = 20;
const BASE58_HASH = /^[1-9A-HJ-NP-Za-km-z]{32,64}$/;

const whole = (n: unknown) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
const positive = (n: unknown) => whole(n) && (n as number) > 0;
const badAmount = (): CallResult => ({ ok: false, error: ERROR_TEXT.E_BAD_AMOUNT, code: "E_BAD_AMOUNT" });

export function createTestnetChain(opts: TestnetChainOptions): TestnetChain {
  const { contractId, explorerTxUrl } = opts.config;
  const port = opts.port ?? nearKitPort({ rpcUrls: opts.config.rpcUrls });
  const retries = opts.exec?.retries ?? 3;
  const backoff = opts.exec?.backoffMs ?? 400;
  const sleep = opts.exec?.sleep ?? realSleep;

  // --- views
  async function withRetry<T>(fn: (attempt: number) => Promise<T>, what: string): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn(attempt);
      } catch (e) {
        if (isTransient(e) && attempt < retries) {
          await sleep(backoff * 2 ** attempt);
          continue;
        }
        const p = panicOf(e);
        const err = new Error(p ? p.message : `${what}: ${friendly(e)}`) as Error & { code?: string; cause?: unknown };
        if (p) err.code = p.code;
        err.cause = e;
        throw err;
      }
    }
  }

  async function view<T>(method: string, args: object, decode: (raw: unknown) => T): Promise<T> {
    const raw = await withRetry((a) => port.view(contractId, method, args, a), method);
    try {
      return decode(raw);
    } catch (e) {
      throw new Error(`${method}: ${(e as Error).message}`, { cause: e });
    }
  }

  // --- calls, one at a time
  let tail: Promise<unknown> = Promise.resolve();
  let waiting = 0;
  function enqueue<T>(fn: () => Promise<T>): Promise<T> {
    waiting++;
    const run = tail.then(fn);
    tail = run.catch(() => undefined);
    return run.finally(() => waiting--);
  }

  function call(method: string, args: object, gasTgas: number): Promise<Executed> {
    return enqueue(async () => {
      const key = opts.keys();
      if (!key) return { ok: false, error: "No wallet yet. Claim your dock pass." };
      const tx = port.prepare({ kind: "call", signerId: key.accountId, privateKey: key.privateKey, contractId, method, args, gasTgas });
      return executeTx(tx, { retries, backoffMs: backoff, sleep });
    });
  }

  /** Strips `value` and adds decoded fields, keeping ok:true if the reply didn't parse (the call did happen). */
  function shape<X extends object>(r: Executed, decode: (v: unknown) => X): CallResult & Partial<X> {
    const { value, ...rest } = r;
    const bare = rest as CallResult & Partial<X>;
    if (!r.ok) return bare;
    try {
      return { ...bare, ...decode(value) };
    } catch (e) {
      console.warn("[economy] call succeeded but its reply didn't parse:", (e as Error).message);
      return bare;
    }
  }

  return {
    network: "testnet",
    contractId,
    txUrl: (h) => (BASE58_HASH.test(h) ? explorerTxUrl + h : null),
    queued: () => waiting,

    profile: (accountId) => view("profile", { account_id: accountId }, decodeProfile),
    balances: (accountId) => view("balances", { account_id: accountId }, decodeBalances),
    brokers: () => view("brokers", {}, (r) => list(r, "brokers", decodeBroker)),
    wrecks: () => view("wrecks", {}, (r) => list(r, "wrecks", decodeWreck)),
    listings: () => view("listings", {}, (r) => list(r, "listings", decodeListing)),
    recent: (limit) => view("recent", { limit: Math.max(1, Math.min(64, Math.floor(limit) || 1)) }, decodeEvents),
    leaderboard: () => view("leaderboard", {}, decodeLeaderboard),
    simulate: (hours, traders, seed) => view("simulate", { hours, traders, seed }, decodeSim),
    manifest: (runId) => view("manifest", { run_id: runId }, decodeManifest),
    accountExists: (accountId) => withRetry((a) => port.accountExists(accountId, a), "account"),

    async startRun(gear: GearId[]) {
      const r = await call("start_run", { gear }, GAS_RUN);
      return shape(r, (v) => {
        const manifest = decodeManifest(v);
        if (!manifest) throw new WireError("start_run returned no manifest");
        return { manifest };
      });
    },
    async extract(runId, opened, wrecks) {
      if (!whole(runId) || !opened.every(whole) || !wrecks.every(whole)) return badAmount();
      const r = await call("extract", { run_id: runId, opened, wrecks }, GAS_RUN);
      return shape(r, (v) => {
        const o = obj(v, "extract");
        return { minted: amounts<CargoId>(o.minted, "extract.minted", CARGOS), haulValue: u128(o.haul_value, "extract.haul_value") };
      });
    },
    async die(runId, opened, wrecks, spot) {
      if (!whole(runId) || !whole(spot) || !opened.every(whole) || !wrecks.every(whole)) return badAmount();
      const r = await call("die", { run_id: runId, opened, wrecks, spot }, GAS_RUN);
      return shape(r, (v) => ({ wreckId: optional(obj(v, "die").wreck_id, (x) => int(x, "die.wreck_id")) }));
    },
    async sell(broker: BrokerId, tokenId: CargoId, amount: number) {
      if (!positive(amount)) return badAmount();
      const r = await call("sell", { broker, token_id: tokenId, amount: String(amount) }, GAS_DEFAULT);
      return shape(r, (v) => ({ paid: u128(obj(v, "sell").paid, "sell.paid") }));
    },
    async buy(broker: BrokerId, tokenId: GearId, amount: number) {
      if (!positive(amount)) return badAmount();
      const r = await call("buy", { broker, token_id: tokenId, amount: String(amount) }, GAS_DEFAULT);
      return shape(r, (v) => ({ cost: u128(obj(v, "buy").cost, "buy.cost") }));
    },
    async invest(broker: BrokerId, amount: number) {
      if (!positive(amount)) return badAmount();
      const r = await call("invest", { broker, amount: String(amount) }, GAS_DEFAULT);
      return shape(r, (v) => {
        const o = obj(v, "invest");
        return { shares: u128(o.shares, "invest.shares"), reopened: bool(o.reopened, "invest.reopened") };
      });
    },
    async list(tokenId: CargoId | GearId, amount: number, price: number) {
      if (!positive(amount) || !positive(price)) return badAmount();
      const r = await call("list", { token_id: tokenId, amount: String(amount), price: String(price) }, GAS_DEFAULT);
      return shape(r, (v) => ({ id: int(obj(v, "list").id, "list.id") }));
    },
    async buyListing(id: number) {
      if (!whole(id)) return badAmount();
      const r = await call("buy_listing", { id }, GAS_DEFAULT);
      return shape(r, (v) => ({ paid: u128(obj(v, "buy_listing").paid, "buy_listing.paid") }));
    },
    async cancelListing(id: number) {
      if (!whole(id)) return badAmount();
      return shape(await call("cancel_listing", { id }, GAS_DEFAULT), () => ({}));
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// The ledger ticker's feed

export interface EventPoller {
  /** `fresh` is what arrived since the last delivery (all of it, the first time); `all` is the current window. Both newest first. */
  subscribe(fn: (fresh: LedgerEvent[], all: LedgerEvent[]) => void): () => void;
  latest(): LedgerEvent[];
  /** True while the last poll failed; the window shown is then the last one that loaded. */
  readonly stale: boolean;
  poll(): Promise<void>;
  stop(): void;
}

export interface PollerOptions {
  intervalMs?: number;
  limit?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}

const eventKey = (e: LedgerEvent) => `${e.kind}|${e.at}|${e.account}|${e.text}`;

/** Polls `recent` while anyone is subscribed. Works on the mock too. A failed poll keeps the last window and backs off. */
export function createEventPoller(chain: Pick<Chain, "recent">, opts: PollerOptions = {}): EventPoller {
  const interval = opts.intervalMs ?? 4000;
  const limit = opts.limit ?? 32;
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  const subs = new Set<(fresh: LedgerEvent[], all: LedgerEvent[]) => void>();
  let window: LedgerEvent[] = [];
  let seen = new Set<string>();
  let loaded = false;
  let stale = false;
  let failures = 0;
  let timer: unknown = null;
  let inflight: Promise<void> | null = null;

  const schedule = () => {
    if (!subs.size || timer !== null) return;
    const wait = Math.min(60_000, interval * 2 ** Math.min(failures, 4));
    timer = setTimer(() => {
      timer = null;
      void poll().finally(schedule);
    }, wait);
  };

  async function poll(): Promise<void> {
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        const events = await chain.recent(limit);
        const fresh = events.filter((e) => !seen.has(eventKey(e)));
        window = events;
        seen = new Set(events.map(eventKey));
        stale = false;
        failures = 0;
        if (fresh.length || !loaded) for (const fn of subs) fn(fresh, window);
        loaded = true;
      } catch {
        stale = true;
        failures++;
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  }

  return {
    subscribe(fn) {
      subs.add(fn);
      if (loaded) fn(window, window);
      else void poll();
      schedule();
      return () => {
        subs.delete(fn);
        if (!subs.size && timer !== null) {
          clearTimer(timer);
          timer = null;
        }
      };
    },
    latest: () => window,
    get stale() {
      return stale;
    },
    poll,
    stop() {
      subs.clear();
      if (timer !== null) clearTimer(timer);
      timer = null;
    },
  };
}
