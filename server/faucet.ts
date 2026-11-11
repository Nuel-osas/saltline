// The dock-pass faucet (docs/ECONOMY.md → Wallets and accounts). POST { accountId, callsign }: the faucet account
// registers the callsign on the game contract and sends a new guest account 0.1 testnet NEAR, which creates it.
//
// A pure handler, `(request, env, deps) => Response`, so it can be tested; api/faucet.ts (Vercel) and the dev
// middleware in vite.config.js both call it.
//
// Fails closed:
// - Missing or malformed env (account, key, contract, network) answers 503 before anything else happens.
// - Registration goes first, and money moves only after it succeeds. A taken callsign, a bad request or an
//   already-registered account never costs the faucet anything.
// - An account that already exists on chain is never funded again, so a retried claim can't pay twice.
// - The key is read only from server-side env (FAUCET_PRIVATE_KEY, no VITE_ prefix). It is never logged or
//   returned: every log line and response body passes through redact().
//
// Relative imports carry .js so the compiled function also resolves them under Node's ES module rules on Vercel.
import { isPrivateKey, isValidAccountId } from "near-kit";
import { type Executed, decodeProfile, executeTx, isTransient, nearKitPort } from "../src/economy/chain.js";
import { TESTNET_RPC_URLS } from "../src/economy/config.js";
import { isAccountId, isImplicitAccountId, normalizeCallsign } from "../src/economy/wallet.js";

/** 0.1 NEAR in yoctoNEAR (10^24 per NEAR), kept as an integer end to end. A whole session (a run, its extract and a
 * handful of trades) burns about 0.005 NEAR of gas, so 0.1 lasts a player many sessions, and the faucet's 12 NEAR
 * covers about 120 players instead of 40. */
export const FUND_YOCTO = 1n * 10n ** 23n;

export type FaucetEnv = Record<string, string | undefined>;

export interface FaucetConfig {
  faucetId: string;
  privateKey: `ed25519:${string}`;
  contractId: string;
  rpcUrls: string[];
}

/** What the handler needs from the chain; the default is near-kit, tests pass a stub. */
export interface FaucetChain {
  /** The contract's profile view for the account (null when unregistered). Rejects on failure. */
  profile(accountId: string): Promise<unknown | null>;
  /** Rejects on failure; never turns an outage into "doesn't exist". */
  accountExists(accountId: string): Promise<boolean>;
  fund(accountId: string, yocto: bigint): Promise<Executed>;
  register(accountId: string, callsign: string): Promise<Executed>;
}

/** A sliding-window counter per key, in memory: per serverless instance, reset on a cold start. The durable guards
 * are the 409 on a registered account and never funding an account that exists. */
export class RateLimiter {
  private hits = new Map<string, number[]>();
  constructor(
    readonly limit: number,
    readonly windowMs: number,
  ) {}
  take(key: string, now: number): boolean {
    if (this.hits.size > 10_000) {
      for (const [k, ts] of this.hits) if (!ts.some((t) => now - t < this.windowMs)) this.hits.delete(k);
    }
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    const ok = recent.length < this.limit;
    if (ok) recent.push(now);
    this.hits.set(key, recent);
    return ok;
  }
  retryAfter(key: string, now: number): number {
    const ts = this.hits.get(key) ?? [];
    return ts.length ? Math.max(1, Math.ceil((ts[0] + this.windowMs - now) / 1000)) : 1;
  }
}

export interface FaucetLimits {
  ip: RateLimiter;
  account: RateLimiter;
}

export const newLimits = (): FaucetLimits => ({ ip: new RateLimiter(3, 3_600_000), account: new RateLimiter(3, 3_600_000) });

export interface FaucetDeps {
  chain?: (cfg: FaucetConfig) => FaucetChain;
  limits?: FaucetLimits;
  now?: () => number;
  log?: (line: string) => void;
  clientIp?: (request: Request) => string;
}

// One set per server instance, shared by every request it serves.
const sharedLimits = newLimits();
const inflight = new Set<string>();

const ACCOUNT_ID = (id: string) => isValidAccountId(id) || isImplicitAccountId(id);

/** Reads the faucet's env. Returns the names of what's missing or malformed, never their values. */
export function faucetConfig(env: FaucetEnv): { ok: true; cfg: FaucetConfig } | { ok: false; problems: string[] } {
  const v = (k: string) => (env[k] ?? "").trim();
  const problems: string[] = [];
  const faucetId = v("FAUCET_ACCOUNT_ID");
  const key = v("FAUCET_PRIVATE_KEY");
  const contractId = v("CONTRACT_ID") || v("VITE_CONTRACT_ID");
  const network = v("NEAR_NETWORK") || v("VITE_NEAR_NETWORK");
  if (!faucetId || !ACCOUNT_ID(faucetId)) problems.push("FAUCET_ACCOUNT_ID");
  if (!key.startsWith("ed25519:") || !isPrivateKey(key)) problems.push("FAUCET_PRIVATE_KEY");
  if (!contractId || !ACCOUNT_ID(contractId)) problems.push("CONTRACT_ID");
  // Testnet only, and it has to be said: a faucet must never guess its network.
  if (network !== "testnet") problems.push("NEAR_NETWORK");
  const rpcRaw = v("NEAR_RPC") || v("VITE_NEAR_RPC");
  const rpcUrls = rpcRaw ? rpcRaw.split(",").map((s) => s.trim()).filter(Boolean) : [...TESTNET_RPC_URLS];
  if (!rpcUrls.every((u) => /^https:\/\//.test(u) || /^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(u))) problems.push("NEAR_RPC");
  if (problems.length) return { ok: false, problems };
  return { ok: true, cfg: { faucetId, privateKey: key as `ed25519:${string}`, contractId, rpcUrls } };
}

/** Removes the key, and its base58 body on its own, from any text that leaves this file. */
export function redact(text: string, secret: string | undefined): string {
  if (!secret) return text;
  let out = text.split(secret).join("[redacted]");
  const body = secret.includes(":") ? secret.slice(secret.indexOf(":") + 1) : "";
  if (body.length >= 16) out = out.split(body).join("[redacted]");
  return out;
}

let cached: { sig: string; key: string; chain: FaucetChain } | null = null;

/** The real chain: near-kit, signing as the faucet account, through chain.ts's tested retry rules. */
function nearFaucetChain(cfg: FaucetConfig): FaucetChain {
  const sig = `${cfg.faucetId}|${cfg.contractId}|${cfg.rpcUrls.join(",")}`;
  if (cached && cached.sig === sig && cached.key === cfg.privateKey) return cached.chain;
  const port = nearKitPort({ rpcUrls: cfg.rpcUrls });
  const read = async <T>(fn: (attempt: number) => Promise<T>): Promise<T> => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn(attempt);
      } catch (e) {
        if (!isTransient(e) || attempt >= 2) throw e;
        await new Promise((r) => setTimeout(r, 300 * 2 ** attempt));
      }
    }
  };
  const chain: FaucetChain = {
    profile: async (id) => decodeProfile(await read((a) => port.view(cfg.contractId, "profile", { account_id: id }, a))),
    accountExists: (id) => read((a) => port.accountExists(id, a)),
    fund: (id, yocto) => executeTx(port.prepare({ kind: "transfer", signerId: cfg.faucetId, privateKey: cfg.privateKey, receiverId: id, yocto })),
    register: (id, callsign) =>
      executeTx(
        port.prepare({
          kind: "call",
          signerId: cfg.faucetId,
          privateKey: cfg.privateKey,
          contractId: cfg.contractId,
          method: "register",
          args: { account_id: id, callsign },
          gasTgas: 50,
        }),
      ),
  };
  cached = { sig, key: cfg.privateKey, chain };
  return chain;
}

function defaultIp(request: Request): string {
  // On Vercel both headers are set by the platform from the connection; the dev middleware sets x-forwarded-for.
  const h = request.headers;
  const ip = h.get("x-real-ip") || h.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  return ip.slice(0, 64);
}

export async function handleFaucet(request: Request, env: FaucetEnv, deps: FaucetDeps = {}): Promise<Response> {
  const secret = (env.FAUCET_PRIVATE_KEY ?? "").trim() || undefined;
  const now = deps.now ?? Date.now;
  const limits = deps.limits ?? sharedLimits;
  const sink = deps.log ?? ((line: string) => console.log(line));
  const log = (msg: string, fields?: Record<string, unknown>) => sink(redact(`[faucet] ${msg}${fields ? ` ${JSON.stringify(fields)}` : ""}`, secret));
  const reply = (status: number, body: Record<string, unknown>, headers: Record<string, string> = {}) =>
    new Response(redact(JSON.stringify(body), secret), {
      status,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
    });

  let held: string | null = null;
  try {
    if (request.method !== "POST") return reply(405, { ok: false, error: "POST only." }, { allow: "POST" });

    const conf = faucetConfig(env);
    if (!conf.ok) {
      log("not configured", { problems: conf.problems });
      return reply(503, { ok: false, error: "The dock office is closed: the faucet isn't configured." });
    }
    const { cfg } = conf;

    let body: unknown;
    try {
      const text = await request.text();
      if (text.length > 2048) return reply(413, { ok: false, error: "Request too large." });
      body = JSON.parse(text);
    } catch {
      return reply(400, { ok: false, error: "Send JSON: { accountId, callsign }." });
    }
    const { accountId, callsign } = (body && typeof body === "object" ? body : {}) as { accountId?: unknown; callsign?: unknown };
    if (typeof accountId !== "string" || !isAccountId(accountId)) return reply(400, { ok: false, error: "That isn't a NEAR account id." });
    const cs = normalizeCallsign(callsign);
    if (!cs) return reply(400, { ok: false, error: "Callsigns are 3–16 letters, digits, spaces, dashes, dots or underscores." });

    const ip = (deps.clientIp ?? defaultIp)(request);
    const t = now();
    if (!limits.ip.take(ip, t)) {
      return reply(429, { ok: false, error: "Too many dock passes from here. Try again later." }, { "retry-after": String(limits.ip.retryAfter(ip, t)) });
    }
    if (!limits.account.take(accountId, t)) {
      return reply(429, { ok: false, error: "Too many tries for this account. Try again later." }, { "retry-after": String(limits.account.retryAfter(accountId, t)) });
    }
    if (inflight.has(accountId)) return reply(429, { ok: false, error: "Already working on this account." }, { "retry-after": "5" });
    inflight.add(accountId);
    held = accountId;

    const chain = (deps.chain ?? nearFaucetChain)(cfg);
    let profile: unknown | null;
    let exists: boolean;
    try {
      [profile, exists] = await Promise.all([chain.profile(accountId), chain.accountExists(accountId)]);
    } catch (e) {
      log("lookup failed", { accountId, error: (e as Error)?.message });
      return reply(502, { ok: false, error: "Couldn't check the dock roll. Nothing was sent. Try again." });
    }
    if (profile !== null && exists) return reply(409, { ok: false, error: "Already registered." });
    if (!exists && !isImplicitAccountId(accountId)) {
      return reply(400, { ok: false, error: "That account doesn't exist. The faucet only creates new guest accounts." });
    }

    const txHashes: string[] = [];
    if (profile === null) {
      const reg = await chain.register(accountId, cs);
      if (reg.txHash) txHashes.push(reg.txHash);
      if (reg.pending) {
        log("register pending", { accountId, txHashes });
        return reply(202, { ok: false, pending: true, accountId, txHashes, error: "Registration sent, not confirmed yet. Try again in a minute." });
      }
      if (!reg.ok) {
        log("register refused", { accountId, code: reg.code, error: reg.error, txHashes });
        const status = reg.code === "E_ALREADY_REGISTERED" || reg.code === "E_CALLSIGN_TAKEN" ? 409 : reg.code === "E_BAD_CALLSIGN" ? 400 : 502;
        return reply(status, { ok: false, accountId, txHashes, error: reg.error ?? "Registration failed. Nothing was sent." });
      }
    }

    if (!exists) {
      const fund = await chain.fund(accountId, FUND_YOCTO);
      if (fund.txHash) txHashes.push(fund.txHash);
      if (fund.pending) {
        log("fund pending", { accountId, txHashes });
        return reply(202, { ok: false, pending: true, accountId, txHashes, error: "Funding sent, not confirmed yet. Try again in a minute." });
      }
      if (!fund.ok) {
        log("fund failed", { accountId, error: fund.error, txHashes });
        return reply(502, { ok: false, accountId, txHashes, error: "Registered, but the account couldn't be funded. Try again." });
      }
    }

    log("claimed", { accountId, callsign: cs, txHashes });
    return reply(200, { ok: true, accountId, callsign: cs, txHashes });
  } catch (e) {
    log("error", { error: (e as Error)?.message ?? String(e) });
    return reply(500, { ok: false, error: "The dock office hit a snag. Try again." });
  } finally {
    if (held) inflight.delete(held);
  }
}
