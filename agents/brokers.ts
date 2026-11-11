/// <reference types="node" />
// The broker agents (docs/ECONOMY.md → Brokers). Each round, for Moss, Ines and the Quartermaster in turn:
//
// 1. Read `brokers()` and `advice({ broker })` from the game contract.
// 2. Decide with that broker's character on top of the advice (characters.ts), and write a one-line memo.
// 3. Sign `broker_export` or `broker_stance` with that broker's own key.
// 4. Print one line: broker, action, memo, and the tx hash or the reason it held.
//
//   node --import ./agents/ts-hook.mjs agents/brokers.ts --once        one round (the cron)
//   node --import ./agents/ts-hook.mjs agents/brokers.ts --loop 10     a round every 10 minutes (local demos)
//   add --dry-run to either to decide and print without signing
//
// The rules this file keeps:
// - Fail closed. A read that fails or a reply that doesn't decode leaves that broker's state unknown, and an unknown
//   state means no action. A move that doesn't add up against the board is a hold, never a guess.
// - A contract refusal (`E_...`, the export cooldown included) is logged and skipped. It is never re-sent: chain.ts's
//   executeTx retries only failures that produced no outcome, and in --loop the refused move is benched for an hour.
// - Keys come from BROKER_MOSS_KEY, BROKER_INES_KEY and BROKER_QM_KEY, or from the legacy keychain at
//   ~/.near-credentials/testnet/<account>.json for local runs. A key is never printed: every line passes through
//   redact(). A missing key skips that broker with a line saying so; the others still run.
// - The optional LLM voice (NEAR_AI_API_KEY) only rewrites the memo's wording. The move is fixed before it is asked,
//   and a rewrite with a number the facts don't contain is thrown away.
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isPrivateKey } from "near-kit";
import {
  type ExecOptions,
  type Executed,
  type NearPort,
  type PreparedTx,
  WireError,
  decodeBroker,
  executeTx,
  isTransient,
  nearKitPort,
  parsePanic,
  u128,
} from "../src/economy/chain.js";
import { ConfigError, resolveConfig } from "../src/economy/config.js";
import { CARGO } from "../src/economy/items.js";
import type { BrokerId, BrokerView, CargoId } from "../src/economy/types";
import { type Advice, type Decision, type Move, MEMO_MAX, decide, factsFor, memoFor } from "./characters.js";

export const BROKER_IDS: readonly BrokerId[] = ["moss", "ines", "qm"];
export const DEFAULT_CONTRACT_ID = "saltline.testnet";
export const ENV_KEYS: Record<BrokerId, string> = { moss: "BROKER_MOSS_KEY", ines: "BROKER_INES_KEY", qm: "BROKER_QM_KEY" };
/** docs/CONTRACT_API.md: 50 Tgas for every call but start_run, extract and die. */
const GAS_TGAS = 50;
const HOUR_MS = 3_600_000;

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------------------------------------------
// Never print a key

/** Hides anything shaped like a NEAR key, and any of `secrets` verbatim. */
export function redact(text: string, secrets: readonly string[] = []): string {
  let out = text.replace(/\b(ed25519|secp256k1):[1-9A-HJ-NP-Za-km-z]{32,}/g, "$1:<redacted>");
  for (const s of secrets) if (s && s.length >= 8) out = out.split(s).join("<redacted>");
  return out;
}

const errCode = (e: unknown): string | undefined => {
  const c = e && typeof e === "object" ? (e as { code?: unknown }).code : undefined;
  return typeof c === "string" ? c : undefined;
};

/** One short line for an error, with its E_ code or RPC code when it has one. */
export function describeError(e: unknown): string {
  const o = (e && typeof e === "object" ? e : {}) as { panic?: unknown; message?: unknown; cause?: unknown };
  const p = parsePanic(o.panic) ?? parsePanic(o.message);
  if (p) return `${p.code}: ${p.message}`;
  const code = errCode(e) ?? errCode(o.cause);
  const msg = (typeof o.message === "string" ? o.message : String(e)).replace(/\s+/g, " ").trim();
  return redact(code && !msg.includes(code) ? `${code}: ${msg}` : msg).slice(0, 200);
}

// ---------------------------------------------------------------------------------------------------------------
// Reads

/** The `advice` view's reply (docs/CONTRACT_API.md). Throws on any shape it doesn't expect. */
export function decodeAdvice(raw: unknown): Advice {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new WireError("advice: expected an object");
  const o = raw as Record<string, unknown>;
  const action = o.action;
  if (action !== "none" && action !== "export" && action !== "stance") {
    throw new WireError(`advice.action: unknown ${JSON.stringify(action)}`);
  }
  if (typeof o.memo !== "string") throw new WireError("advice.memo: expected a string");
  let tokenId: CargoId | null = null;
  if (o.token_id !== null && o.token_id !== undefined) {
    if (typeof o.token_id !== "string" || !(CARGO as string[]).includes(o.token_id)) {
      throw new WireError(`advice.token_id: ${JSON.stringify(o.token_id)} is not cargo`);
    }
    tokenId = o.token_id as CargoId;
  }
  const amount = o.amount === null || o.amount === undefined ? null : u128(o.amount, "advice.amount");
  let stance: number | null = null;
  if (o.stance !== null && o.stance !== undefined) {
    if (typeof o.stance !== "number" || !Number.isSafeInteger(o.stance)) throw new WireError("advice.stance: expected a whole number");
    stance = o.stance;
  }
  if (action === "export" && (!tokenId || !amount)) throw new WireError("advice: an export without its item or amount");
  if (action === "stance" && stance === null) throw new WireError("advice: a stance move without a stance");
  return { action, tokenId, amount, stance, memo: o.memo };
}

/** The two views the agents read. Both reject on failure; nothing here turns an unreadable value into a default. */
export interface Board {
  brokers(): Promise<BrokerView[]>;
  advice(broker: BrokerId): Promise<Advice>;
}

/** Views through the port, retrying transient RPC failures with backoff (the port rotates RPCs by attempt). */
export function createBoard(port: NearPort, contractId: string, exec: ExecOptions = {}): Board {
  const retries = exec.retries ?? 3;
  const backoff = exec.backoffMs ?? 400;
  const sleep = exec.sleep ?? realSleep;
  async function view<T>(method: string, args: object, decode: (raw: unknown) => T): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return decode(await port.view(contractId, method, args, attempt));
      } catch (e) {
        if (isTransient(e) && attempt < retries) {
          await sleep(backoff * 2 ** attempt);
          continue;
        }
        throw new Error(`${method}: ${describeError(e)}`, { cause: e });
      }
    }
  }
  return {
    brokers: () =>
      view("brokers", {}, (raw) => {
        if (!Array.isArray(raw)) throw new WireError("brokers: expected a list");
        return raw.map((b, i) => decodeBroker(b, `brokers[${i}]`));
      }),
    advice: (broker) => view("advice", { broker }, decodeAdvice),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Keys

export interface BrokerKey {
  accountId: string;
  privateKey: `ed25519:${string}`;
  source: "env" | "keychain";
}

export type KeyLookup = { ok: true; key: BrokerKey } | { ok: false; why: string };

export interface KeyOptions {
  /** The legacy keychain's network folder, ~/.near-credentials/testnet by default. */
  credentialsDir?: string;
  read?: (path: string) => Promise<string>;
  /** Called with each key as it is loaded, so the log can redact it verbatim. */
  onSecret?: (secret: string) => void;
}

const tilde = (path: string) => (path.startsWith(homedir()) ? `~${path.slice(homedir().length)}` : path);

/**
 * The broker's key: its env variable if set, else the legacy keychain file for its account. A malformed env key is
 * refused rather than passed over for the keychain, so a typo never signs with a different key than intended.
 */
export async function findKey(id: BrokerId, accountId: string, env: Record<string, string | undefined>, opts: KeyOptions = {}): Promise<KeyLookup> {
  const name = ENV_KEYS[id];
  const raw = env[name]?.trim();
  if (raw) {
    const key = raw.startsWith("ed25519:") ? raw : `ed25519:${raw}`;
    if (!isPrivateKey(key)) return { ok: false, why: `${name} is set but isn't an ed25519 secret key` };
    opts.onSecret?.(raw);
    return { ok: true, key: { accountId, privateKey: key as `ed25519:${string}`, source: "env" } };
  }
  const dir = opts.credentialsDir ?? join(homedir(), ".near-credentials", "testnet");
  const path = join(dir, `${accountId}.json`);
  let text: string;
  try {
    text = await (opts.read ?? ((p) => readFile(p, "utf8")))(path);
  } catch (e) {
    if (errCode(e) === "ENOENT") return { ok: false, why: `no key: set ${name} or add ${tilde(path)}` };
    return { ok: false, why: `couldn't read ${tilde(path)} (${errCode(e) ?? "unknown error"})` };
  }
  let file: unknown;
  try {
    file = JSON.parse(text);
  } catch {
    // The parser's message can quote the file, so it is never shown.
    return { ok: false, why: `${tilde(path)} isn't JSON` };
  }
  const f = (file && typeof file === "object" ? file : {}) as { account_id?: unknown; private_key?: unknown };
  if (f.account_id !== accountId) return { ok: false, why: `${tilde(path)} is not a key for ${accountId}` };
  const pk = f.private_key;
  if (typeof pk !== "string" || !pk.startsWith("ed25519:") || !isPrivateKey(pk)) {
    return { ok: false, why: `${tilde(path)} has no ed25519 private_key` };
  }
  opts.onSecret?.(pk);
  return { ok: true, key: { accountId, privateKey: pk as `ed25519:${string}`, source: "keychain" } };
}

// ---------------------------------------------------------------------------------------------------------------
// The optional LLM voice: NEAR AI Cloud, OpenAI-compatible.
//
// Checked on 11 Nov 2026: the near/agent-skills `near-ai-cloud` skill gives the base URL https://cloud-api.near.ai/v1
// with Bearer auth and POST /chat/completions (an unauthenticated POST there answers 401 missing_auth_header). The
// public catalog at /v1/model/list lists Qwen/Qwen3.6-35B-A3B-FP8 as a private (TEE, verifiable) model, the cheap
// one picked here. NEAR_AI_MODEL overrides it.

export const NEAR_AI_BASE_URL = "https://cloud-api.near.ai/v1";
export const NEAR_AI_MODEL = "Qwen/Qwen3.6-35B-A3B-FP8";

export interface VoiceConfig {
  apiKey: string;
  model: string;
  baseUrl: string;
  fetch: typeof fetch;
  timeoutMs: number;
}

const PERSONAS: Record<BrokerId, string> = {
  moss: "Moss runs a scrap-metal stall on a rusting dock overrun by drones. Thinks in tonnes, hates waste. Blunt.",
  ines: "Ines trades cold-chain meds and fuel on the dock. Cautious, keeps a fat float. Dry and exact.",
  qm: "The Quartermaster buys relay cores for an unnamed client. Pays well, spends fast. Clipped, military.",
};

/**
 * The rewrite if it's safe to sign, else null: one line, at most MEMO_MAX characters and 160 bytes (the contract's
 * limit), no control characters or markup, and no number that isn't in `truth`. A memo can't claim a different
 * amount or stance than the move.
 */
export function acceptRewrite(text: unknown, truth: string): string | null {
  if (typeof text !== "string") return null;
  const line =
    text
      .replace(/<think>[\s\S]*?<\/think>/gi, "")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find(Boolean) ?? "";
  const s = line
    .replace(/^["'`‘’“”]+|["'`‘’“”]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!s || s.length > MEMO_MAX || new TextEncoder().encode(s).length > 160) return null;
  if (/[\u0000-\u001f\u007f<>{}\\]/.test(s)) return null;
  const allowed = new Set(truth.match(/\d+/g) ?? []);
  for (const n of s.match(/\d+/g) ?? []) if (!allowed.has(n)) return null;
  return s;
}

/** Asks NEAR AI Cloud to say the memo in character. Any failure (network, status, shape, a bad line) is null. */
export async function rewriteMemo(id: BrokerId, memo: string, facts: string, v: VoiceConfig): Promise<string | null> {
  try {
    const res = await v.fetch(`${v.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${v.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: v.model,
        max_tokens: 400,
        temperature: 0.8,
        messages: [
          {
            role: "system",
            content:
              `${PERSONAS[id]} You write the one-line memo this broker signs on the public ledger. ` +
              `Rewrite the memo in your voice. Keep it true to the facts. Use no number that isn't in the facts. ` +
              `At most ${MEMO_MAX} characters, one line, no quotes, no emoji. Reply with the memo only.`,
          },
          { role: "user", content: `Facts: ${facts}\nMemo: ${memo}` },
        ],
      }),
      signal: AbortSignal.timeout(v.timeoutMs),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { choices?: { message?: { content?: unknown } }[] };
    return acceptRewrite(body?.choices?.[0]?.message?.content, `${facts} ${memo}`);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Signing

/**
 * Signs and sends one broker call through chain.ts's executeTx (its retry rules: transient failures only, identical
 * signed bytes, `pending` when unconfirmed). `cause` is the underlying error code when executeTx's text is generic.
 */
async function sign(port: NearPort, contractId: string, key: BrokerKey, method: string, args: object, exec: ExecOptions) {
  let last: unknown = null;
  const tx = port.prepare({ kind: "call", signerId: key.accountId, privateKey: key.privateKey, contractId, method, args, gasTgas: GAS_TGAS });
  const keep = (e: unknown) => {
    last = e;
    throw e;
  };
  const watched: PreparedTx = {
    hash: () => tx.hash(),
    send: (n) => tx.send(n).catch(keep),
    resend: (n) => tx.resend(n).catch(keep),
    status: (n) => tx.status(n).catch(keep),
  };
  const r: Executed & { cause?: string } = await executeTx(watched, exec);
  if (!r.ok && !r.code && last) r.cause = describeError(last);
  return r;
}

// ---------------------------------------------------------------------------------------------------------------
// The loop's memory: a refused move isn't sent again for an hour

export class Bench {
  private until = new Map<string, number>();
  private now: () => number;
  constructor(now: () => number = Date.now) {
    this.now = now;
  }
  private static key(id: BrokerId, move: Move | "any") {
    if (move === "any") return `${id}|any`;
    return `${id}|${move.action}|${move.action === "export" ? move.tokenId : move.action === "stance" ? move.stance : ""}`;
  }
  /** Bench a move (or "any" move) for `ms`. */
  put(id: BrokerId, move: Move | "any", ms: number) {
    this.until.set(Bench.key(id, move), this.now() + ms);
  }
  /** When the move comes off the bench, or null if it isn't on it. */
  check(id: BrokerId, move: Move): number | null {
    const t = Math.max(this.until.get(Bench.key(id, "any")) ?? 0, this.until.get(Bench.key(id, move)) ?? 0);
    return t > this.now() ? t : null;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// A round

export type Status = "sent" | "dry-run" | "held" | "skipped" | "refused" | "pending" | "failed";

export interface Line {
  broker: BrokerId;
  status: Status;
  /** "export 14 copper", "stance 95" or "hold". */
  action: string;
  memo?: string;
  voice?: "template" | "llm";
  txHash?: string;
  /** Why it held or skipped, what refused it, or who would sign in a dry run. */
  note?: string;
  /** The broker's state couldn't be read, so it didn't act. */
  unknown?: true;
}

export interface RoundDeps {
  board: Board;
  port: NearPort;
  contractId: string;
  key: (id: BrokerId, accountId: string) => Promise<KeyLookup>;
  /** Picks the memo templates; the same seed gives the same memos. */
  seed: number;
  dryRun?: boolean;
  voice?: VoiceConfig | null;
  exec?: ExecOptions;
  /** --loop only: refused moves wait out the hour here. */
  bench?: Bench;
}

const describeMove = (m: Move) =>
  m.action === "export" ? `export ${m.amount} ${m.tokenId}` : m.action === "stance" ? `stance ${m.stance}` : "hold";

async function turn(id: BrokerId, board: BrokerView[], d: RoundDeps): Promise<Line> {
  const view = board.find((b) => b.id === id);
  if (!view) return { broker: id, status: "held", action: "hold", note: "not on the contract's board", unknown: true };
  // The contract says which account signs for this broker. Anything but <broker>.<contract> is held, so a bad
  // board never gets a local keychain key signing for an account it wasn't meant for.
  const expected = `${id}.${d.contractId}`;
  if (view.accountId !== expected) {
    return { broker: id, status: "held", action: "hold", note: `the contract names ${view.accountId}, expected ${expected}`, unknown: true };
  }
  const key = await d.key(id, view.accountId);
  if (!key.ok && !d.dryRun) return { broker: id, status: "skipped", action: "hold", note: key.why };

  let advice: Advice;
  try {
    advice = await d.board.advice(id);
  } catch (e) {
    return { broker: id, status: "held", action: "hold", note: `state unknown: ${describeError(e)}`, unknown: true };
  }
  const decision: Decision & { invalid?: true } = decide(view, advice);
  const move = decision.move;
  let memo = memoFor(view, decision, d.seed);
  if (move.action === "hold") {
    const held: Line = { broker: id, status: "held", action: "hold", memo, voice: "template" };
    if (decision.invalid) held.note = "the advice didn't add up against the board";
    return held;
  }
  const benched = d.bench?.check(id, move);
  if (benched) {
    const until = new Date(benched).toISOString().slice(11, 16);
    return { broker: id, status: "held", action: "hold", note: `${describeMove(move)} was refused; benched until ${until} UTC` };
  }
  // The move is fixed from here on: the voice only ever returns the memo's words.
  let voice: Line["voice"] = "template";
  if (d.voice) {
    const rewrite = await rewriteMemo(id, memo, factsFor(view, decision), d.voice);
    if (rewrite) {
      memo = rewrite;
      voice = "llm";
    }
  }
  const line: Line = { broker: id, status: "held", action: describeMove(move), memo, voice };
  if (d.dryRun) {
    return { ...line, status: "dry-run", note: key.ok ? `would sign as ${key.key.accountId} (key from ${key.key.source})` : `would skip: ${key.why}` };
  }
  if (!key.ok) return { ...line, status: "skipped", note: key.why };

  const r =
    move.action === "export"
      ? await sign(d.port, d.contractId, key.key, "broker_export", { token_id: move.tokenId, amount: String(move.amount), memo }, d.exec ?? {})
      : await sign(d.port, d.contractId, key.key, "broker_stance", { stance: move.stance, memo }, d.exec ?? {});
  const tx = r.txHash ? { txHash: r.txHash } : {};
  if (r.ok) return { ...line, status: "sent", ...tx };
  if (r.pending) {
    d.bench?.put(id, "any", 15 * 60_000);
    return { ...line, status: "pending", ...tx, note: "sent but not confirmed; check the tx before acting again" };
  }
  if (r.code) {
    // A refusal is final for this round. E_NOT_BROKER means this key doesn't sign for the broker at all.
    d.bench?.put(id, r.code === "E_NOT_BROKER" ? "any" : move, r.code === "E_NOT_BROKER" ? Number.MAX_SAFE_INTEGER / 2 : HOUR_MS);
    return { ...line, status: "refused", ...tx, note: `${r.code}: ${r.error ?? ""}`.trim() };
  }
  return { ...line, status: "failed", ...tx, note: r.cause ?? r.error ?? "unknown failure" };
}

/** One round for every broker. Never throws: each broker's outcome, whatever it is, is a line. */
export async function runRound(d: RoundDeps): Promise<Line[]> {
  let board: BrokerView[];
  try {
    board = await d.board.brokers();
  } catch (e) {
    const note = `state unknown: ${describeError(e)}`;
    return BROKER_IDS.map((id) => ({ broker: id, status: "held" as const, action: "hold", note, unknown: true as const }));
  }
  const lines: Line[] = [];
  for (const id of BROKER_IDS) {
    try {
      lines.push(await turn(id, board, d));
    } catch (e) {
      lines.push({ broker: id, status: "failed", action: "hold", note: describeError(e) });
    }
  }
  return lines;
}

export function formatLine(l: Line, secrets: readonly string[] = []): string {
  const parts = [l.broker.padEnd(4), l.status.padEnd(8), l.action.padEnd(17)];
  if (l.memo) parts.push(`"${l.memo}"${l.voice === "llm" ? " (llm)" : ""}`);
  if (l.txHash) parts.push(`tx ${l.txHash}`);
  if (l.note) parts.push(`(${l.note})`);
  return redact(parts.join("  "), secrets);
}

/** 2: some broker's state or outcome is unknown (a failed read, a failed or unconfirmed call). 0 otherwise. */
export const exitCode = (lines: Line[]) => (lines.some((l) => l.unknown || l.status === "failed" || l.status === "pending") ? 2 : 0);

// ---------------------------------------------------------------------------------------------------------------
// The command line

export interface Options {
  mode: "once" | "loop";
  minutes: number;
  dryRun: boolean;
  seed: number | null;
}

export const USAGE = `usage: node --import ./agents/ts-hook.mjs agents/brokers.ts [--once | --loop <minutes>] [--dry-run] [--seed <n>]

  --once            one round, then exit (the default; what the cron runs)
  --loop <minutes>  a round every <minutes> (1 to 1440), until Ctrl-C
  --dry-run         decide and print, never sign
  --seed <n>        fix the memo templates' seed (default: the current 15-minute slot)

env: BROKER_MOSS_KEY, BROKER_INES_KEY, BROKER_QM_KEY (else ~/.near-credentials/testnet/<account>.json),
     CONTRACT_ID (default ${DEFAULT_CONTRACT_ID}), NEAR_RPC (comma-separated), NEAR_AI_API_KEY and NEAR_AI_MODEL (optional voice)`;

export function parseArgs(argv: readonly string[]): Options {
  const o: Options = { mode: "once", minutes: 0, dryRun: false, seed: null };
  let modes = 0;
  const args = argv.flatMap((a) => (a.startsWith("--") && a.includes("=") ? [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)] : [a]));
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--once") {
      o.mode = "once";
      modes++;
    } else if (a === "--loop") {
      const m = Number(args[++i]);
      if (!Number.isFinite(m) || m < 1 || m > 1440) throw new Error("--loop needs a number of minutes from 1 to 1440");
      o.mode = "loop";
      o.minutes = m;
      modes++;
    } else if (a === "--dry-run") {
      o.dryRun = true;
    } else if (a === "--seed") {
      const s = Number(args[++i]);
      if (!Number.isSafeInteger(s) || s < 0) throw new Error("--seed needs a whole number");
      o.seed = s;
    } else {
      throw new Error(`unknown argument: ${a}`);
    }
  }
  if (modes > 1) throw new Error("pick one of --once and --loop");
  return o;
}

export async function main(argv: readonly string[], env: Record<string, string | undefined>, out = console.log, err = console.error): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    out(USAGE);
    return 0;
  }
  let opts: Options;
  let config: { contractId: string; rpcUrls: string[] };
  try {
    opts = parseArgs(argv);
    // The game's own config rules: testnet only, a valid account id, https RPCs.
    config = resolveConfig({ VITE_NEAR_NETWORK: env.NEAR_NETWORK, VITE_CONTRACT_ID: env.CONTRACT_ID?.trim() || DEFAULT_CONTRACT_ID, VITE_NEAR_RPC: env.NEAR_RPC }, "");
  } catch (e) {
    // resolveConfig names the game's VITE_ variables; the agents read the same names without the prefix.
    const message = (e as Error).message.replace(/\bVITE_/g, "");
    err(`brokers: ${message}${e instanceof ConfigError ? "" : `\n\n${USAGE}`}`);
    return 1;
  }

  const secrets: string[] = [...Object.values(ENV_KEYS).map((k) => env[k] ?? ""), env.NEAR_AI_API_KEY ?? ""].filter(Boolean);
  const say = (line: string) => out(redact(line, secrets));
  const actions = env.GITHUB_ACTIONS === "true";
  const port = nearKitPort({ rpcUrls: config.rpcUrls });
  const voice: VoiceConfig | null = env.NEAR_AI_API_KEY?.trim()
    ? { apiKey: env.NEAR_AI_API_KEY.trim(), model: env.NEAR_AI_MODEL?.trim() || NEAR_AI_MODEL, baseUrl: NEAR_AI_BASE_URL, fetch: globalThis.fetch, timeoutMs: 10_000 }
    : null;
  const bench = opts.mode === "loop" ? new Bench() : undefined;
  const deps = (seed: number): RoundDeps => ({
    board: createBoard(port, config.contractId),
    port,
    contractId: config.contractId,
    key: (id, accountId) => findKey(id, accountId, env, { onSecret: (s) => secrets.push(s) }),
    seed,
    dryRun: opts.dryRun,
    voice,
    bench,
  });

  const rpc = new URL(config.rpcUrls[0]).host + (config.rpcUrls.length > 1 ? ` (+${config.rpcUrls.length - 1} fallback)` : "");
  say(
    `saltline brokers · ${config.contractId} · ${rpc} · ${opts.mode === "loop" ? `every ${opts.minutes} min` : "once"}` +
      `${opts.dryRun ? " · dry run, nothing signed" : ""} · memos: ${voice ? `NEAR AI ${voice.model}` : "templates"}`,
  );

  let stop = false;
  let wake: (() => void) | null = null;
  const halt = () => {
    stop = true;
    wake?.();
  };
  if (opts.mode === "loop") {
    process.once("SIGINT", halt);
    process.once("SIGTERM", halt);
  }

  let code = 0;
  do {
    const startedAt = new Date().toISOString().slice(0, 19) + "Z";
    const lines = await runRound(deps(opts.seed ?? Math.floor(Date.now() / 900_000)));
    for (const l of lines) {
      const text = `${startedAt}  ${formatLine(l, secrets)}`;
      say(text);
      if (actions && (l.unknown || l.status === "failed" || l.status === "pending")) say(`::error::${formatLine(l, secrets)}`);
      else if (actions && (l.status === "skipped" || l.status === "refused")) say(`::warning::${formatLine(l, secrets)}`);
    }
    code = exitCode(lines);
    if (opts.mode === "loop" && !stop) {
      await new Promise<void>((r) => {
        const t = setTimeout(r, opts.minutes * 60_000);
        wake = () => {
          clearTimeout(t);
          r();
        };
      });
      wake = null;
    }
  } while (opts.mode === "loop" && !stop);
  return opts.mode === "loop" ? 0 : code;
}

const entry = process.argv[1] ? fileURLToPath(import.meta.url) === process.argv[1] : false;
if (entry) {
  main(process.argv.slice(2), process.env).then(
    (code) => process.exit(code),
    (e) => {
      console.error(`brokers: ${describeError(e)}`);
      process.exit(1);
    },
  );
}
