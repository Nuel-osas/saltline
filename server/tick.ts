// POST /api/tick: wakes the broker agents when people play. The game calls it when it boots and when a run ends, at
// most once every 10 minutes per browser. This runs one round (agents/brokers.ts's runRound: read the board, decide
// in character, sign with the broker's own key) at most once every 10 minutes per server instance.
//
// POST /api/tick?game=v2 does the same for v2's characters (agents/v2/run.ts's runRoundV2: Moss, Ines and the
// Harbormaster on CONTRACT_ID_V2), at the same pace, kept separately from v1's. Without the parameter nothing here
// changes for v1.
//
// Why it exists: GitHub never fired the brokers' scheduled workflow (zero scheduled runs on this repo), so the
// brokers would sit still through judging. This wakes them exactly when someone is there to see them move.
//
// What a caller can and can't do: anyone may call it. A call can only make the brokers run their own fixed policy
// inside the contract's rules (an export at most once an hour per item, a stance from 80 to 120; in v2 a build from
// their own stock, a price on their own gun, an export of their own stock, a posture), at gas they pay from their
// own accounts. The keys are read only from server-side env (BROKER_*_KEY, HARBORMASTER_KEY) and never appear in a
// response or a log. Fails closed: no keys means 503, and a broker whose state can't be read holds (the round's own
// rule).
import { DEFAULT_CONTRACT_ID, ENV_KEYS, type KeyOptions, type Line, createBoard, findKey, findKeyNamed, redact, runRound } from "../agents/brokers.js";
import { DEFAULT_CONTRACT_ID_V2, ENV_KEYS_V2, type Line2, type PostureMemory, runRoundV2, testnetDeps } from "../agents/v2/run.js";
import { nearKitPort } from "../src/economy/chain.js";
import { resolveConfig } from "../src/economy/config.js";

export type TickEnv = Record<string, string | undefined>;

/** The shortest gap between two rounds this instance runs. */
export const TICK_EVERY_MS = 10 * 60_000;

export interface TickDeps {
  now?: () => number;
  /** Runs one real round. Tests replace it; the default is agents/brokers.ts's runRound against the configured chain. */
  round?: (env: TickEnv, seed: number) => Promise<Line[]>;
  /** The same for `?game=v2`; the default is agents/v2/run.ts's runRoundV2 against CONTRACT_ID_V2. */
  roundV2?: (env: TickEnv, seed: number) => Promise<Line2[]>;
  log?: (line: string) => void;
}

interface Pace<L> {
  lastRound: number;
  running: Promise<L[]> | null;
}

/** Per server instance: a cold start forgets it, which costs at most one extra round. v1 and v2 each keep their own. */
const v1: Pace<Line> = { lastRound: 0, running: null };
const v2: Pace<Line2> = { lastRound: 0, running: null };
/** When this instance last changed the Harbormaster's posture. A cold start forgets it, and then only the ledger says. */
const postures: PostureMemory = { last: null };

/** For tests. */
export function resetTick() {
  v1.lastRound = v2.lastRound = 0;
  v1.running = v2.running = null;
  postures.last = null;
}

// Env keys only: on a server there is no keychain to fall back to, so a missing key skips that broker.
const envOnly: KeyOptions = { read: async () => Promise.reject(Object.assign(new Error("no keychain on the server"), { code: "ENOENT" })) };

function defaultRound(env: TickEnv, seed: number): Promise<Line[]> {
  const config = resolveConfig(
    { VITE_NEAR_NETWORK: env.NEAR_NETWORK, VITE_CONTRACT_ID: env.CONTRACT_ID?.trim() || DEFAULT_CONTRACT_ID, VITE_NEAR_RPC: env.NEAR_RPC },
    "",
  );
  const port = nearKitPort({ rpcUrls: config.rpcUrls });
  return runRound({
    board: createBoard(port, config.contractId),
    port,
    contractId: config.contractId,
    key: (id, accountId) => findKey(id, accountId, env, envOnly),
    seed,
  });
}

function defaultRoundV2(env: TickEnv, seed: number): Promise<Line2[]> {
  const config = resolveConfig(
    { VITE_NEAR_NETWORK: env.NEAR_NETWORK, VITE_CONTRACT_ID: env.CONTRACT_ID_V2?.trim() || DEFAULT_CONTRACT_ID_V2, VITE_NEAR_RPC: env.NEAR_RPC },
    "",
  );
  return runRoundV2({ ...testnetDeps({ config }), key: (who, accountId) => findKeyNamed(ENV_KEYS_V2[who], accountId, env, envOnly), seed, memory: postures });
}

const wantsV2 = (request: Request): boolean => {
  try {
    return new URL(request.url).searchParams.get("game") === "v2";
  } catch {
    return false;
  }
};

export async function handleTick(request: Request, env: TickEnv, deps: TickDeps = {}): Promise<Response> {
  const game2 = wantsV2(request);
  // Every key this server holds is hidden from every reply, whichever game was asked for.
  const hide = [...Object.values(ENV_KEYS), ...Object.values(ENV_KEYS_V2)].map((k) => env[k] ?? "").filter(Boolean);
  const secrets = Object.values(game2 ? ENV_KEYS_V2 : ENV_KEYS)
    .map((k) => env[k] ?? "")
    .filter(Boolean);
  const reply = (status: number, body: Record<string, unknown>) =>
    new Response(redact(JSON.stringify(body), hide), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
  const log = (line: string) => (deps.log ?? ((l: string) => console.log(l)))(redact(`[tick${game2 ? " v2" : ""}] ${line}`, hide));

  if (request.method !== "POST") return reply(405, { ok: false, error: "POST only." });
  if (!secrets.length) return reply(503, { ok: false, error: "The brokers are off shift." });

  const now = (deps.now ?? Date.now)();
  const pace: Pace<Line> | Pace<Line2> = game2 ? v2 : v1;
  if (pace.running) return reply(200, { ok: true, ran: false, reason: "a round is already running" });
  if (pace.lastRound && now - pace.lastRound < TICK_EVERY_MS) {
    return reply(200, { ok: true, ran: false, reason: "the brokers moved recently", nextInSeconds: Math.ceil((pace.lastRound + TICK_EVERY_MS - now) / 1000) });
  }

  pace.lastRound = now;
  const seed = Math.floor(now / 900_000);
  try {
    let summary: { broker: string; status: string; action: string; memo: string | null; txHash: string | null }[];
    if (game2) {
      v2.running = (deps.roundV2 ?? defaultRoundV2)(env, seed);
      summary = (await v2.running).map((l) => ({ broker: l.who, status: l.status, action: l.action, memo: l.memo ?? null, txHash: l.txHash ?? null }));
    } else {
      v1.running = (deps.round ?? defaultRound)(env, seed);
      summary = (await v1.running).map((l) => ({ broker: l.broker, status: l.status, action: l.action, memo: l.memo ?? null, txHash: l.txHash ?? null }));
    }
    log(summary.map((l) => `${l.broker} ${l.status} ${l.action}${l.txHash ? ` ${l.txHash}` : ""}`).join(" · "));
    return reply(200, { ok: true, ran: true, lines: summary });
  } catch (e) {
    log(`round failed: ${(e as Error)?.message ?? String(e)}`);
    return reply(502, { ok: false, error: "The brokers didn't answer. They'll try again." });
  } finally {
    pace.running = null;
  }
}
