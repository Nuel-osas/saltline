// GET /api/stats: the studio's numbers (server/counts.ts → readStats), for whoever holds STATS_ADMIN_TOKEN.
//
//   authorization: Bearer <STATS_ADMIN_TOKEN>
//
// The answer is today and the 14 days before it (visits, devices, sign-ins, passes, raids started / extracted /
// died), who is online now, how many users there are, and the funnel from a visit to an extraction. `?users=N` adds
// the N newest sign-ins (1 to 200). scripts/stats.mjs (`npm run stats`) prints it as a table.
//
// - With no STATS_ADMIN_TOKEN (or one under 16 characters) this answers 404: the page isn't there.
// - A missing or wrong token answers 401. Tokens are compared in constant time, and asks are limited per client
//   address so the token can't be guessed at speed.
// - **A number that couldn't be read is null, never 0.** With the store off, every number is null.
// - The answer is never cached, and the token is never logged or echoed.
import { createHash, timingSafeEqual } from "node:crypto";
import { type Stats, readStats } from "./counts.js";
import { RateLimiter, defaultIp } from "./faucet.js";
import { type Store, storeFor } from "./store.js";
import { listUsers } from "./users.js";

type Env = Record<string, string | undefined>;

/** A shorter admin token is treated as no token: a weak one must not open the door. */
export const MIN_ADMIN_TOKEN = 16;

/** 30 asks per 10 minutes per client address. */
export const newStatsLimit = () => new RateLimiter(30, 600_000);
const sharedLimit = newStatsLimit();

export interface StatsDeps {
  store?: Store;
  limit?: RateLimiter;
  now?: () => number;
  log?: (line: string) => void;
  clientIp?: (request: Request) => string;
}

/** A user as the stats answer shows one: times as ISO 8601, or null when not on the record. */
export interface StatsUser {
  id: string;
  accountId: string | null;
  callsign: string | null;
  firstSeen: string | null;
  lastSeen: string | null;
  passAt: string | null;
  sessions: number;
  visits: number;
}

export type StatsAnswer = { ok: true } & Stats & { users?: StatsUser[] | null };

const digest = (s: string) => createHash("sha256").update(s).digest();
/** Constant time, whatever the two lengths are. */
const same = (a: string, b: string) => timingSafeEqual(digest(a), digest(b));
const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

export async function handleStats(request: Request, env: Env, deps: StatsDeps = {}): Promise<Response> {
  const sink = deps.log ?? ((line: string) => console.log(line));
  const log = (msg: string, fields?: Record<string, unknown>) => sink(`[stats] ${msg}${fields ? ` ${JSON.stringify(fields)}` : ""}`);
  const reply = (status: number, body: object, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers } });
  try {
    const admin = (env.STATS_ADMIN_TOKEN ?? "").trim();
    if (admin.length < MIN_ADMIN_TOKEN) {
      if (admin) log("not configured", { problems: ["STATS_ADMIN_TOKEN"] });
      return reply(404, { ok: false, error: "Not found." });
    }
    if (request.method !== "GET") return reply(405, { ok: false, error: "GET only." }, { allow: "GET" });

    const limit = deps.limit ?? sharedLimit;
    const ip = (deps.clientIp ?? defaultIp)(request);
    const at = (deps.now ?? Date.now)();
    if (!limit.take(ip, at)) return reply(429, { ok: false, error: "Too many asks from here. Try again later." }, { "retry-after": String(limit.retryAfter(ip, at)) });

    const given = /^Bearer\s+(\S{1,512})$/.exec((request.headers.get("authorization") ?? "").trim())?.[1];
    if (!given || !same(given, admin)) return reply(401, { ok: false, error: "The admin token is missing or wrong." }, { "www-authenticate": "Bearer" });

    const store = deps.store ?? storeFor(env);
    const wanted = new URL(request.url).searchParams.get("users");
    const n = wanted === null ? 0 : Number(wanted);
    if (wanted !== null && (!Number.isInteger(n) || n < 1 || n > 200)) return reply(400, { ok: false, error: "users is a whole number from 1 to 200." });

    const [stats, users] = await Promise.all([readStats(store, at), n ? listUsers(store, n) : undefined]);
    const answer: StatsAnswer = { ok: true, ...stats };
    if (users !== undefined) answer.users = users && users.map((u) => ({ id: u.id, accountId: u.accountId, callsign: u.callsign, firstSeen: iso(u.firstSeen), lastSeen: iso(u.lastSeen), passAt: iso(u.passAt), sessions: u.sessions, visits: u.visits }));
    return reply(200, answer);
  } catch (e) {
    log("failed", { error: (e as Error)?.name });
    return reply(500, { ok: false, error: "Couldn't read the numbers. Try again." });
  }
}
