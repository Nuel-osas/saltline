// POST /api/metrics: the browser's beacon (src/economy/v2/metrics). One event per request:
//
//   { "e": "<event>", "d": "<device id>" }      e: one of BROWSER_EVENTS or "heartbeat"; d: 32 hex characters
//
// A `signin` also carries the player's sign-in token in `authorization: Bearer …`, and is counted only if the server
// can verify it (server/auth.ts): the browser's word that someone signed in is not taken. A verified sign-in is the
// one place this file touches the user record (server/users.ts: last seen, and one more visit).
//
// It always answers 204 with nothing in it, whatever happened, so it tells a caller nothing and a page never waits
// on it. Fails closed: anything that isn't exactly one known event from one well-formed device id is dropped, and so
// is anything over MAX_BEACON_BYTES, anything past the rate limits, and anything from a crawler or a headless
// browser. With the store off or no salt (server/counts.ts → Privacy) nothing is counted at all.
//
// The client address is used for the rate limit, in memory, and is never written anywhere. Nothing is logged about
// a request but that the handler itself failed.
import { type AuthConfig, authConfig, bearer, deriveWallet, verifyToken } from "./auth.js";
import { BROWSER_EVENTS, type BrowserEvent, HEARTBEAT, countBeacon, countUser, metricsSalt } from "./counts.js";
import { RateLimiter, defaultIp } from "./faucet.js";
import { type Store, quietly, storeFor } from "./store.js";
import { sawUser } from "./users.js";

type Env = Record<string, string | undefined>;

/** A beacon is about 60 bytes. Anything over this is not one. */
export const MAX_BEACON_BYTES = 256;
/** The longest the handler works on one beacon (checking a sign-in, then one round trip to the store). */
export const BEACON_JOB_MS = 2500;

const DEVICE_ID = /^[a-f0-9]{32}$/;
const EVENTS: ReadonlySet<string> = new Set([...BROWSER_EVENTS, HEARTBEAT]);
/** Crawlers, link previews, headless browsers and scripts: none of them is a player. (Cubot is a phone maker.) */
const NOT_A_PLAYER = /(?<!cu)bot|crawl|spider|headless|lighthouse|prerender|preview|facebookexternalhit|whatsapp|curl|wget|python|node|undici|axios|postman/i;

export interface MetricsLimits {
  ip: RateLimiter;
  device: RateLimiter;
}

/**
 * Per minute: 240 beacons from one address (a whole room behind one router fits), 40 from one device (a player in a
 * raid sends about three). In memory per server instance, like the faucet's.
 */
export const newMetricsLimits = (): MetricsLimits => ({ ip: new RateLimiter(240, 60_000), device: new RateLimiter(40, 60_000) });
const sharedLimits = newMetricsLimits();

export interface MetricsDeps {
  store?: Store;
  verify?: (token: string, cfg: AuthConfig) => Promise<string>;
  limits?: MetricsLimits;
  now?: () => number;
  log?: (line: string) => void;
  clientIp?: (request: Request) => string;
}

/** The event and device of a well-formed beacon, or null. */
export function parseBeacon(text: string): { event: BrowserEvent | typeof HEARTBEAT; device: string } | null {
  if (Buffer.byteLength(text) > MAX_BEACON_BYTES) return null;
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return null;
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const { e, d, ...rest } = body as { e?: unknown; d?: unknown };
  if (Object.keys(rest).length) return null;
  if (typeof e !== "string" || !EVENTS.has(e)) return null;
  if (typeof d !== "string" || !DEVICE_ID.test(d)) return null;
  return { event: e as BrowserEvent | typeof HEARTBEAT, device: d };
}

export async function handleMetrics(request: Request, env: Env, deps: MetricsDeps = {}): Promise<Response> {
  const done = () => new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
  try {
    if (request.method !== "POST") return done();
    if (NOT_A_PLAYER.test(request.headers.get("user-agent") ?? "bot")) return done();
    const declared = Number(request.headers.get("content-length") ?? "0");
    if (!Number.isFinite(declared) || declared > MAX_BEACON_BYTES) return done();

    const limits = deps.limits ?? sharedLimits;
    const at = (deps.now ?? Date.now)();
    if (!limits.ip.take((deps.clientIp ?? defaultIp)(request), at)) return done();

    const beacon = parseBeacon(await request.text());
    if (!beacon) return done();
    if (!limits.device.take(beacon.device, at)) return done();

    await quietly(async () => {
      const store = deps.store ?? storeFor(env);
      const salt = metricsSalt(env);
      if (store.kind === "off" || !salt) return;
      if (beacon.event !== "signin") return void (await countBeacon(store, salt, { ...beacon, at }));

      // A sign-in counts only when the server can check it. No token, a bad one, or sign-in not set up here: dropped.
      const auth = authConfig(env);
      const token = auth.state === "on" ? bearer(request) : null;
      if (auth.state !== "on" || !token) return;
      let userId: string;
      try {
        userId = await (deps.verify ?? verifyToken)(token, auth.cfg);
      } catch {
        return;
      }
      await Promise.all([
        countBeacon(store, salt, { ...beacon, at }),
        countUser(store, salt, { userId, at }),
        sawUser(store, { userId, accountId: deriveWallet(auth.cfg, userId).accountId, at, as: "visit" }),
      ]);
    }, BEACON_JOB_MS);
    return done();
  } catch (e) {
    (deps.log ?? ((line: string) => console.log(line)))(`[metrics] failed ${JSON.stringify({ error: (e as Error)?.name })}`);
    return done();
  }
}
