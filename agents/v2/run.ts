/// <reference types="node" />
// The agents that run Saltline v2's characters: Moss, Ines and the Harbormaster (docs/GAME.md → Characters with
// wallets). Each round, for each in turn:
//
// 1. Read the contract's views: `vendors`, `economy`, `export_prices`, `harbormaster`, `recent`.
// 2. Decide with that character's rules (characters.ts): one move, and a memo of at most 90 characters.
// 3. Sign it with that character's own key: `vendor_build`, `vendor_price`, `export` or `hm_posture`.
// 4. Print one line: who, what, the memo, and the tx hash or the reason it held.
//
//   node --import ./agents/ts-hook.mjs agents/v2/run.ts --once        one round
//   node --import ./agents/ts-hook.mjs agents/v2/run.ts --loop 10     a round every 10 minutes (local demos)
//   add --dry-run to either to decide and print without signing
//
// The rules are v1's (agents/brokers.ts), and so is the code for them: fail closed (a read that fails leaves that
// character's state unknown, and unknown means no move), a refusal is logged and never re-sent (benched for an hour
// in --loop), keys come from env or the legacy keychain and never reach a log, a missing key skips only that
// character, and the optional NEAR AI voice only rewords a memo after the move is fixed.
import { fileURLToPath } from "node:url";
import {
  Benched,
  type BrokerKey,
  type KeyLookup,
  NEAR_AI_BASE_URL,
  NEAR_AI_MODEL,
  type Options,
  type Status,
  type VoiceConfig,
  describeError,
  everyRound,
  exitCode,
  findKeyNamed,
  parseArgs,
  redact,
  rewriteAs,
} from "../brokers.js";
import { type NearPort, nearKitPort } from "../../src/economy/chain.js";
import { ConfigError, resolveConfig } from "../../src/economy/config.js";
import { type AgentCalls, createTestnetChain2 } from "../../src/economy/v2/chain.js";
import type { Chain2, TxResult } from "../../src/economy/v2/types";
import {
  CHARACTER_IDS,
  type CharacterId,
  type Decision2,
  type HarbormasterBoard,
  MEMO_MAX,
  type Move2,
  PERSONAS2,
  type VendorBoard,
  decideHarbormaster,
  decideVendor,
  describeMove2,
  factsFor2,
  memoFor2,
} from "./characters.js";

export const DEFAULT_CONTRACT_ID_V2 = "v2.saltline.testnet";
/** Moss and Ines are the same accounts, with the same keys, as v1's brokers. The Harbormaster has its own. */
export const ENV_KEYS_V2: Record<CharacterId, string> = { moss: "BROKER_MOSS_KEY", ines: "BROKER_INES_KEY", harbormaster: "HARBORMASTER_KEY" };
const HOUR_MS = 3_600_000;
/** `recent` keeps 64 lines; the Harbormaster wants the last 20 raid endings among them. */
const RECENT = 64;

/** The views a round reads. They reject on failure; nothing here turns an unreadable value into a default. */
export type Reads = Pick<Chain2, "vendors" | "economy" | "exportPrices" | "harbormaster" | "recent">;
/** The calls a character's own account may make. */
export type Acts = AgentCalls & Pick<Chain2, "exportGoods">;

export interface Line2 {
  who: CharacterId;
  status: Status;
  /** "build pilot", "price S-000003 at 1425", "export 5 copper", "posture pursuit" or "hold". */
  action: string;
  memo?: string;
  voice?: "template" | "llm";
  txHash?: string;
  /** Why it held or skipped, what refused it, or who would sign in a dry run. */
  note?: string;
  /** Its state couldn't be read, so it didn't act. */
  unknown?: true;
}

export interface RoundDeps2 {
  reads: Reads;
  /** The calls, signed as this key's account. */
  act: (key: BrokerKey) => Acts;
  contractId: string;
  key: (who: CharacterId, accountId: string) => Promise<KeyLookup>;
  now: () => number;
  /** Picks the memo templates; the same seed gives the same memos. */
  seed: number;
  dryRun?: boolean;
  voice?: VoiceConfig | null;
  /** --loop only: refused moves wait out the hour here. */
  bench?: Benched;
}

/** The account each character signs as: a sibling of the contract (`v2.saltline.testnet` → `moss.saltline.testnet`). */
export const accountFor = (who: CharacterId, contractId: string) => `${who}.${contractId.slice(contractId.indexOf(".") + 1)}`;

const benchKey = (who: CharacterId, m: Move2 | "any") =>
  m === "any" ? `${who}|any` : `${who}|${m.action}|${m.action === "build" ? m.blueprint : m.action === "price" ? m.serial : m.action === "export" ? m.tokenId : m.action === "posture" ? m.posture : ""}`;

type Read<T> = { ok: true; value: T } | { ok: false; why: string };
const settle = async <T>(p: Promise<T>): Promise<Read<T>> => p.then((value) => ({ ok: true as const, value }), (e: unknown) => ({ ok: false as const, why: describeError(e) }));

function send(acts: Acts, move: Exclude<Move2, { action: "hold" }>, memo: string): Promise<TxResult> {
  if (move.action === "build") return acts.vendorBuild(move.blueprint, memo);
  if (move.action === "price") return acts.vendorPrice({ serial: move.serial }, move.price, memo);
  // `export` takes no memo on the contract: the line and the ledger's own sentence carry it.
  if (move.action === "export") return acts.exportGoods(move.tokenId, move.amount);
  return acts.hmPosture(move.posture, memo);
}

async function turn(who: CharacterId, accountId: string, decision: Decision2, d: RoundDeps2): Promise<Line2> {
  // The contract says which account signs for this character. Anything but the expected sibling is held, so a bad
  // board never gets a local keychain key signing for an account it wasn't meant for.
  const expected = accountFor(who, d.contractId);
  if (accountId !== expected) return { who, status: "held", action: "hold", note: `the contract names ${accountId}, expected ${expected}`, unknown: true };
  const key = await d.key(who, accountId);
  if (!key.ok && !d.dryRun) return { who, status: "skipped", action: "hold", note: key.why };

  const move = decision.move;
  let memo = memoFor2(who, decision, d.seed);
  if (move.action === "hold") return { who, status: "held", action: "hold", memo, voice: "template", ...(decision.note ? { note: decision.note } : {}) };
  const benched = d.bench?.check(benchKey(who, "any"), benchKey(who, move));
  if (benched) {
    const until = new Date(benched).toISOString().slice(11, 16);
    return { who, status: "held", action: "hold", note: `${describeMove2(move)} was refused; benched until ${until} UTC` };
  }
  // The move is fixed from here on: the voice only ever returns the memo's words.
  let voice: Line2["voice"] = "template";
  if (d.voice) {
    const persona = `${PERSONAS2[who]} You write the one-line memo this character signs on the public ledger.`;
    const rewrite = await rewriteAs(persona, memo, factsFor2(who, decision), d.voice);
    if (rewrite && rewrite.length <= MEMO_MAX) {
      memo = rewrite;
      voice = "llm";
    }
  }
  const line: Line2 = { who, status: "held", action: describeMove2(move), memo, voice };
  if (d.dryRun) return { ...line, status: "dry-run", note: key.ok ? `would sign as ${key.key.accountId} (key from ${key.key.source})` : `would skip: ${key.why}` };
  if (!key.ok) return { ...line, status: "skipped", note: key.why };

  const r = await send(d.act(key.key), move, memo);
  const tx = r.txHash ? { txHash: r.txHash } : {};
  if (r.ok) return { ...line, status: "sent", ...tx };
  if (r.pending) {
    d.bench?.put(benchKey(who, "any"), 15 * 60_000);
    return { ...line, status: "pending", ...tx, note: "sent but not confirmed; check the tx before acting again" };
  }
  if (r.code) {
    // A refusal is final for this round. E_NOT_VENDOR and E_NOT_HARBORMASTER mean this key doesn't sign for them at all.
    const never = r.code === "E_NOT_VENDOR" || r.code === "E_NOT_HARBORMASTER";
    d.bench?.put(benchKey(who, never ? "any" : move), never ? Number.MAX_SAFE_INTEGER / 2 : HOUR_MS);
    return { ...line, status: "refused", ...tx, note: `${r.code}: ${r.error ?? ""}`.trim() };
  }
  return { ...line, status: "failed", ...tx, note: r.error ?? "unknown failure" };
}

/** One round for every character. Never throws: each one's outcome, whatever it is, is a line. */
export async function runRoundV2(d: RoundDeps2): Promise<Line2[]> {
  const [vendors, economy, quotes, hm, recent] = await Promise.all([
    settle(d.reads.vendors()),
    settle(d.reads.economy()),
    settle(d.reads.exportPrices()),
    settle(d.reads.harbormaster()),
    settle(d.reads.recent(RECENT)),
  ]);
  const unknown = (who: CharacterId, why: string): Line2 => ({ who, status: "held", action: "hold", note: `state unknown: ${why}`, unknown: true });
  const now = d.now();
  const lines: Line2[] = [];
  for (const who of CHARACTER_IDS) {
    try {
      if (who === "harbormaster") {
        if (!hm.ok || !recent.ok) lines.push(unknown(who, !hm.ok ? hm.why : (recent as { why: string }).why));
        else {
          const board: HarbormasterBoard = { harbormaster: hm.value, recent: recent.value };
          lines.push(await turn(who, hm.value.accountId, decideHarbormaster(board), d));
        }
        continue;
      }
      // Moss reads the market's sales to choose a frame; both read the desk's prices before shipping anything.
      const failed = [vendors, quotes, ...(who === "moss" ? [economy] : [])].find((r) => !r.ok) as { why: string } | undefined;
      if (failed || !vendors.ok || !quotes.ok) {
        lines.push(unknown(who, failed?.why ?? "unreadable"));
        continue;
      }
      const vendor = vendors.value.find((v) => v.id === who);
      if (!vendor) {
        lines.push({ who, status: "held", action: "hold", note: "not on the contract's board", unknown: true });
        continue;
      }
      const board: VendorBoard = { vendor, quotes: quotes.value, now, ...(who === "moss" && economy.ok ? { economy: economy.value } : {}) };
      lines.push(await turn(who, vendor.accountId, decideVendor(who, board), d));
    } catch (e) {
      lines.push({ who, status: "failed", action: "hold", note: describeError(e) });
    }
  }
  return lines;
}

export function formatLine2(l: Line2, secrets: readonly string[] = []): string {
  const parts = [l.who.padEnd(12), l.status.padEnd(8), l.action.padEnd(24)];
  if (l.memo) parts.push(`"${l.memo}"${l.voice === "llm" ? " (llm)" : ""}`);
  if (l.txHash) parts.push(`tx ${l.txHash}`);
  if (l.note) parts.push(`(${l.note})`);
  return redact(parts.join("  "), secrets);
}

// ---------------------------------------------------------------------------------------------------------------
// Against testnet

export interface TestnetOptions {
  config: { contractId: string; rpcUrls: readonly string[]; explorerTxUrl: string };
  port?: NearPort;
}

/** The reads and the signer for a contract on testnet: one client for the views, one per key for its calls. */
export function testnetDeps(o: TestnetOptions): Pick<RoundDeps2, "reads" | "act" | "contractId" | "now"> {
  const port = o.port ?? nearKitPort({ rpcUrls: [...o.config.rpcUrls] });
  const signers = new Map<string, Acts>();
  return {
    reads: createTestnetChain2({ config: o.config, keys: () => null, port }),
    act(key) {
      const have = signers.get(key.accountId);
      if (have) return have;
      const chain = createTestnetChain2({ config: o.config, keys: () => ({ accountId: key.accountId, privateKey: key.privateKey }), port });
      signers.set(key.accountId, chain);
      return chain;
    },
    contractId: o.config.contractId,
    now: Date.now,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// The command line

export const USAGE_V2 = `usage: node --import ./agents/ts-hook.mjs agents/v2/run.ts [--once | --loop <minutes>] [--dry-run] [--seed <n>]

  --once            one round, then exit (the default)
  --loop <minutes>  a round every <minutes> (1 to 1440), until Ctrl-C
  --dry-run         decide and print, never sign
  --seed <n>        fix the memo templates' seed (default: the current 15-minute slot)

env: BROKER_MOSS_KEY, BROKER_INES_KEY, HARBORMASTER_KEY (else ~/.near-credentials/testnet/<account>.json),
     CONTRACT_ID_V2 (default ${DEFAULT_CONTRACT_ID_V2}), NEAR_RPC (comma-separated), NEAR_AI_API_KEY and NEAR_AI_MODEL (optional voice)`;

export async function main(argv: readonly string[], env: Record<string, string | undefined>, out = console.log, err = console.error): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    out(USAGE_V2);
    return 0;
  }
  let opts: Options;
  let config: { contractId: string; rpcUrls: string[]; explorerTxUrl: string };
  try {
    opts = parseArgs(argv);
    // The game's own config rules: testnet only, a valid account id, https RPCs.
    config = resolveConfig({ VITE_NEAR_NETWORK: env.NEAR_NETWORK, VITE_CONTRACT_ID: env.CONTRACT_ID_V2?.trim() || DEFAULT_CONTRACT_ID_V2, VITE_NEAR_RPC: env.NEAR_RPC }, "");
  } catch (e) {
    const message = (e as Error).message.replace(/\bVITE_CONTRACT_ID\b/g, "CONTRACT_ID_V2").replace(/\bVITE_/g, "");
    err(`v2 agents: ${message}${e instanceof ConfigError ? "" : `\n\n${USAGE_V2}`}`);
    return 1;
  }

  const secrets: string[] = [...Object.values(ENV_KEYS_V2).map((k) => env[k] ?? ""), env.NEAR_AI_API_KEY ?? ""].filter(Boolean);
  const say = (line: string) => out(redact(line, secrets));
  const voice: VoiceConfig | null = env.NEAR_AI_API_KEY?.trim()
    ? { apiKey: env.NEAR_AI_API_KEY.trim(), model: env.NEAR_AI_MODEL?.trim() || NEAR_AI_MODEL, baseUrl: NEAR_AI_BASE_URL, fetch: globalThis.fetch, timeoutMs: 10_000 }
    : null;
  const chain = testnetDeps({ config });
  const bench = opts.mode === "loop" ? new Benched() : undefined;

  const rpc = new URL(config.rpcUrls[0]).host + (config.rpcUrls.length > 1 ? ` (+${config.rpcUrls.length - 1} fallback)` : "");
  say(
    `saltline v2 agents · ${config.contractId} · ${rpc} · ${opts.mode === "loop" ? `every ${opts.minutes} min` : "once"}` +
      `${opts.dryRun ? " · dry run, nothing signed" : ""} · memos: ${voice ? `NEAR AI ${voice.model}` : "templates"}`,
  );

  return everyRound(opts, async () => {
    const startedAt = new Date().toISOString().slice(0, 19) + "Z";
    const lines = await runRoundV2({
      ...chain,
      key: (who, accountId) => findKeyNamed(ENV_KEYS_V2[who], accountId, env, { onSecret: (s) => secrets.push(s) }),
      seed: opts.seed ?? Math.floor(Date.now() / 900_000),
      dryRun: opts.dryRun,
      voice,
      bench,
    });
    for (const l of lines) say(`${startedAt}  ${formatLine2(l, secrets)}`);
    return exitCode(lines);
  });
}

const entry = process.argv[1] ? fileURLToPath(import.meta.url) === process.argv[1] : false;
if (entry) {
  main(process.argv.slice(2), process.env).then(
    (code) => process.exit(code),
    (e) => {
      console.error(`v2 agents: ${describeError(e)}`);
      process.exit(1);
    },
  );
}
