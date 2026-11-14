// POST /api/session: a signed-in player asks for their wallet key (v2's sign-in, server/auth.ts).
//
// The request carries Privy's access token in `authorization: Bearer …`. If the token is good, the answer is the
// account and key derived for that sign-in: { ok, accountId, privateKey }. The browser keeps the key where the guest
// key was kept, and everything after that (signing a raid, selling, building) works as it did.
//
// - The key goes to the signed-in player and nowhere else: it is never logged, and the answer is never cached.
// - With sign-in off (no PRIVY_APP_ID and no WALLET_SECRET) this answers 404; half-configured, 503.
// - Requests are limited per client address, so a stolen token can't be used to hammer the key derivation.
// - A hand-over is written down for the studio (server/record.ts: who, which account, when; never the key). The
//   answer waits at most a second for that and never depends on it.
import { type AuthConfig, authConfig, bearer, deriveWallet, verifyToken } from "./auth.js";
import { RateLimiter, defaultIp } from "./faucet.js";
import { sessionIssued } from "./record.js";
import type { Store } from "./store.js";

type Env = Record<string, string | undefined>;

export interface SessionDeps {
  verify?: (token: string, cfg: AuthConfig) => Promise<string>;
  limit?: RateLimiter;
  now?: () => number;
  log?: (line: string) => void;
  clientIp?: (request: Request) => string;
  /** The database, for tests; the default is the deployment's own (server/store.ts). */
  store?: Store;
}

/** 30 asks per 10 minutes per client address: a page load asks once. */
export const newSessionLimit = () => new RateLimiter(30, 600_000);
const sharedLimit = newSessionLimit();

export async function handleSession(request: Request, env: Env, deps: SessionDeps = {}): Promise<Response> {
  const sink = deps.log ?? ((line: string) => console.log(line));
  const log = (msg: string, fields?: Record<string, unknown>) => sink(`[session] ${msg}${fields ? ` ${JSON.stringify(fields)}` : ""}`);
  const reply = (status: number, body: Record<string, unknown>, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers } });
  try {
    if (request.method !== "POST") return reply(405, { ok: false, error: "POST only." }, { allow: "POST" });

    const auth = authConfig(env);
    if (auth.state === "off") return reply(404, { ok: false, error: "Sign-in isn't switched on here." });
    if (auth.state === "broken") {
      log("not configured", { problems: auth.problems });
      return reply(503, { ok: false, error: "The dock office is closed: sign-in isn't configured." });
    }

    const limit = deps.limit ?? sharedLimit;
    const ip = (deps.clientIp ?? defaultIp)(request);
    const t = (deps.now ?? Date.now)();
    if (!limit.take(ip, t)) return reply(429, { ok: false, error: "Too many sign-ins from here. Try again later." }, { "retry-after": String(limit.retryAfter(ip, t)) });

    const token = bearer(request);
    if (!token) return reply(401, { ok: false, error: "Sign in first." });
    let userId: string;
    try {
      userId = await (deps.verify ?? verifyToken)(token, auth.cfg);
    } catch (e) {
      log("refused", { error: (e as Error)?.message });
      return reply(401, { ok: false, error: "Your sign-in has expired. Sign in again." });
    }
    const wallet = deriveWallet(auth.cfg, userId);
    await sessionIssued(env, { userId, accountId: wallet.accountId, at: t }, { store: deps.store });
    log("issued", { accountId: wallet.accountId });
    return reply(200, { ok: true, accountId: wallet.accountId, privateKey: wallet.privateKey });
  } catch (e) {
    log("failed", { error: (e as Error)?.name });
    return reply(500, { ok: false, error: "The dock office hit a snag. Try again." });
  }
}
