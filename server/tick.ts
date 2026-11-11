// POST /api/tick: wakes the broker agents when people play. The game calls it when it boots and when a run ends, at
// most once every 10 minutes per browser. This runs one round (agents/brokers.ts's runRound: read the board, decide
// in character, sign with the broker's own key) at most once every 10 minutes per server instance.
//
// Why it exists: GitHub never fired the brokers' scheduled workflow (zero scheduled runs on this repo), so the
// brokers would sit still through judging. This wakes them exactly when someone is there to see them move.
//
// What a caller can and can't do: anyone may call it. A call can only make the brokers run their own fixed policy
// inside the contract's rules (an export at most once an hour per item, a stance from 80 to 120), at gas they pay
// from their own accounts. The keys are read only from server-side env (BROKER_*_KEY) and never appear in a response
// or a log. Fails closed: no keys means 503, and a broker whose state can't be read holds (runRound's own rule).
import { DEFAULT_CONTRACT_ID, ENV_KEYS, type Line, createBoard, findKey, redact, runRound } from "../agents/brokers.js";
import { nearKitPort } from "../src/economy/chain.js";
import { resolveConfig } from "../src/economy/config.js";

export type TickEnv = Record<string, string | undefined>;

/** The shortest gap between two rounds this instance runs. */
export const TICK_EVERY_MS = 10 * 60_000;

export interface TickDeps {
  now?: () => number;
  /** Runs one real round. Tests replace it; the default is agents/brokers.ts's runRound against the configured chain. */
  round?: (env: TickEnv, seed: number) => Promise<Line[]>;
  log?: (line: string) => void;
}

/** Per server instance: a cold start forgets it, which costs at most one extra round. */
let lastRound = 0;
let running: Promise<Line[]> | null = null;

/** For tests. */
export function resetTick() {
  lastRound = 0;
  running = null;
}

function defaultRound(env: TickEnv, seed: number): Promise<Line[]> {
  const config = resolveConfig(
    { VITE_NEAR_NETWORK: env.NEAR_NETWORK, VITE_CONTRACT_ID: env.CONTRACT_ID?.trim() || DEFAULT_CONTRACT_ID, VITE_NEAR_RPC: env.NEAR_RPC },
    "",
  );
  const port = nearKitPort({ rpcUrls: config.rpcUrls });
  // Env keys only: on a server there is no keychain to fall back to, so a missing key skips that broker.
  const envOnly = { read: async () => Promise.reject(Object.assign(new Error("no keychain on the server"), { code: "ENOENT" })) };
  return runRound({
    board: createBoard(port, config.contractId),
    port,
    contractId: config.contractId,
    key: (id, accountId) => findKey(id, accountId, env, envOnly),
    seed,
  });
}

export async function handleTick(request: Request, env: TickEnv, deps: TickDeps = {}): Promise<Response> {
  const secrets = Object.values(ENV_KEYS)
    .map((k) => env[k] ?? "")
    .filter(Boolean);
  const reply = (status: number, body: Record<string, unknown>) =>
    new Response(redact(JSON.stringify(body), secrets), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
  const log = (line: string) => (deps.log ?? ((l: string) => console.log(l)))(redact(`[tick] ${line}`, secrets));

  if (request.method !== "POST") return reply(405, { ok: false, error: "POST only." });
  if (!secrets.length) return reply(503, { ok: false, error: "The brokers are off shift." });

  const now = (deps.now ?? Date.now)();
  if (running) return reply(200, { ok: true, ran: false, reason: "a round is already running" });
  if (lastRound && now - lastRound < TICK_EVERY_MS) {
    return reply(200, { ok: true, ran: false, reason: "the brokers moved recently", nextInSeconds: Math.ceil((lastRound + TICK_EVERY_MS - now) / 1000) });
  }

  lastRound = now;
  const seed = Math.floor(now / 900_000);
  running = (deps.round ?? defaultRound)(env, seed);
  try {
    const lines = await running;
    const summary = lines.map((l) => ({ broker: l.broker, status: l.status, action: l.action, memo: l.memo ?? null, txHash: l.txHash ?? null }));
    log(summary.map((l) => `${l.broker} ${l.status} ${l.action}${l.txHash ? ` ${l.txHash}` : ""}`).join(" · "));
    return reply(200, { ok: true, ran: true, lines: summary });
  } catch (e) {
    log(`round failed: ${(e as Error)?.message ?? String(e)}`);
    return reply(502, { ok: false, error: "The brokers didn't answer. They'll try again." });
  } finally {
    running = null;
  }
}
