// Metrics on the server: the beacon (server/metrics.ts), what it counts and under which keys (server/counts.ts), what
// the server counts itself (server/record.ts), and reading it all back (GET /api/stats, server/stats.ts). No network:
// the store is the JSON file in a temp folder, so the tests can also read exactly what was written.
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKey } from "near-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type AuthConfig, deriveWallet } from "../server/auth";
import { DAY_TTL_S, type DayStats, hashId, metricsSalt, readStats } from "../server/counts";
import { type FaucetChain, type FaucetEnv, handleFaucet, newLimits } from "../server/faucet";
import { BEACON_JOB_MS, MAX_BEACON_BYTES, handleMetrics, newMetricsLimits, parseBeacon } from "../server/metrics";
import { handleSession, newSessionLimit } from "../server/session";
import { type StatsAnswer, handleStats, newStatsLimit } from "../server/stats";
import { type Store, fileStore, memoryStore, offStore } from "../server/store";
import { listUsers } from "../server/users";

const APP = "cmtestappid0000000000000a";
const SECRET = "s".repeat(48);
const CFG: AuthConfig = { appId: APP, walletSecret: SECRET };
const SALT = "metrics-salt-for-tests-0123456789";
const ENV = { METRICS_SALT: SALT, PRIVY_APP_ID: APP, WALLET_SECRET: SECRET };
const ALICE = "did:privy:cmalice000000000000000001";
const BOB = "did:privy:cmbob00000000000000000002";
const [A, B, C] = ["a", "b", "c"].map((ch) => ch.repeat(32));
const IP = "203.0.113.77";
const CHROME = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const NOON = Date.UTC(2027, 0, 15, 12, 0, 0);
const DAY = 86_400_000;
const TOKEN = "t".repeat(40);

const zeroDay = (day: string): DayStats => ({ day, visits: 0, devices: 0, signIns: 0, sessions: 0, passes: 0, raidsStarted: 0, raidsExtracted: 0, raidsDied: 0, dockOpens: 0, practiceStarts: 0 });
const unknownDay = (day: string): DayStats => ({ day, visits: null, devices: null, signIns: null, sessions: null, passes: null, raidsStarted: null, raidsExtracted: null, raidsDied: null, dockOpens: null, practiceStarts: null });

function broken(how: "throws" | "hangs"): Store {
  const fail = () => {
    if (how === "throws") throw new Error("the database is down");
    return new Promise(() => {});
  };
  return new Proxy({ kind: "upstash" } as Store, { get: (t, p) => (p === "kind" ? t.kind : fail) });
}

interface Send {
  ua?: string | null;
  ip?: string;
  token?: string;
  method?: string;
  raw?: string;
  verify?: (token: string) => Promise<string>;
}

function world(env: Record<string, string> = ENV, given?: Store) {
  const clock = { t: NOON };
  const path = join(mkdtempSync(join(tmpdir(), "saltline-metrics-")), "store.json");
  const file = given ? null : fileStore(path, { now: () => clock.t });
  const store = given ?? file!;
  const limits = newMetricsLimits();
  const logs: string[] = [];
  const send = async (body: unknown, o: Send = {}) => {
    const headers: Record<string, string> = { "x-forwarded-for": o.ip ?? IP, "content-type": "text/plain;charset=UTF-8" };
    if (o.ua !== null) headers["user-agent"] = o.ua ?? CHROME;
    if (o.token) headers.authorization = `Bearer ${o.token}`;
    const method = o.method ?? "POST";
    const text = o.raw ?? JSON.stringify(body);
    return handleMetrics(new Request("http://localhost/api/metrics", { method, headers, body: method === "POST" ? text : undefined }), env, {
      store,
      limits,
      now: () => clock.t,
      verify: o.verify ?? (async () => ALICE),
      log: (l) => logs.push(l),
    });
  };
  const event = (e: string, d: string = A, o: Send = {}) => send({ e, d }, o);
  const stats = () => readStats(store, clock.t);
  const onDisk = async () => {
    await file?.flushed();
    return JSON.parse(readFileSync(path, "utf8")) as { keys: [string, unknown][] };
  };
  return { clock, store, send, event, stats, onDisk, logs };
}

afterEach(() => void vi.useRealTimers());

describe("POST /api/metrics", () => {
  it("answers 204 with nothing in it, whatever it was sent", async () => {
    const w = world();
    for (const res of [await w.event("visit"), await w.event("nonsense"), await w.send(null, { raw: "{ not json" }), await w.send(null, { method: "GET" }), await w.event("visit", A, { ua: "curl/8.7.1" })]) {
      expect(res.status).toBe(204);
      expect(await res.text()).toBe("");
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
    expect((await w.stats()).today.visits).toBe(1);
    expect(w.logs).toEqual([]);
  });

  it("counts each event on its UTC day", async () => {
    const w = world();
    w.clock.t = Date.UTC(2027, 0, 15, 23, 59, 59);
    await w.event("visit");
    await w.event("dock_open");
    await w.event("raid_start");
    await w.event("raid_death");
    w.clock.t = Date.UTC(2027, 0, 16, 0, 0, 1);
    await w.event("visit");
    await w.event("raid_start");
    await w.event("raid_extract");
    await w.event("practice_start");
    const s = await w.stats();
    expect(s.today).toEqual({ ...zeroDay("2027-01-16"), visits: 1, devices: 1, raidsStarted: 1, raidsExtracted: 1, practiceStarts: 1 });
    expect(s.days[0]).toEqual({ ...zeroDay("2027-01-15"), visits: 1, devices: 1, dockOpens: 1, raidsStarted: 1, raidsDied: 1 });
    expect(s.days).toHaveLength(14);
    expect(s.recordingSince).toBe("2027-01-15T23:59:59.000Z");
  });

  it("counts a device once a day however many events it sends", async () => {
    const w = world();
    await w.event("visit", A);
    await w.event("visit", A);
    await w.event("dock_open", A);
    await w.event("visit", B, { ip: "198.51.100.4" });
    const { today } = await w.stats();
    expect([today.visits, today.devices]).toEqual([3, 2]);
  });

  it("says who is online: every device heard from in the last two minutes", async () => {
    const w = world();
    await w.event("visit", A);
    await w.event("heartbeat", B);
    expect((await w.stats()).onlineNow).toBe(2);
    w.clock.t += 90_000;
    await w.event("heartbeat", A);
    expect((await w.stats()).onlineNow).toBe(2);
    w.clock.t += 31_000; // B was last heard from 121 s ago
    expect((await w.stats()).onlineNow).toBe(1);
    w.clock.t += 120_001;
    const s = await w.stats();
    expect(s.onlineNow).toBe(0);
    // A heartbeat keeps a device online and counts nothing else.
    expect([s.today.visits, s.today.devices]).toEqual([1, 1]);
  });

  it("drops anything that isn't exactly one known event from one well-formed device id", async () => {
    const w = world();
    await w.event("visit"); // the one that counts
    await w.event("purchase");
    await w.event("session_issued"); // the server's own event, not a browser's to send
    await w.event("pass_issued");
    await w.event("__proto__");
    await w.send({ e: "visit" });
    await w.send({ d: B });
    await w.send({ e: "visit", d: "A".repeat(32) });
    await w.send({ e: "visit", d: "a".repeat(31) });
    await w.send({ e: "visit", d: `${"a".repeat(31)}\n` });
    await w.send({ e: "visit", d: B, n: 500 });
    await w.send({ e: ["visit"], d: B });
    await w.send([{ e: "visit", d: B }]);
    await w.send("visit");
    await w.send(null, { raw: "" });
    await w.send(null, { raw: '{"e":"visit","d":"' + B + '"' });
    await w.send(null, { raw: JSON.stringify({ e: "visit", d: B }) + " ".repeat(MAX_BEACON_BYTES) });
    await w.event("visit", B, { method: "PUT" });
    const { today } = await w.stats();
    expect([today.visits, today.devices, today.sessions, today.passes]).toEqual([1, 1, 0, 0]);
    expect(parseBeacon(JSON.stringify({ e: "heartbeat", d: B }))).toEqual({ event: "heartbeat", device: B });
  });

  it("drops crawlers, link previews, headless browsers, scripts, and anything with no user agent", async () => {
    const w = world();
    const agents = [
      "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/141.0.0.0 Safari/537.36",
      "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
      "Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)",
      "curl/8.7.1",
      "node",
      "python-requests/2.32.3",
      null,
    ];
    for (const ua of agents) await w.event("visit", B, { ua });
    expect((await w.stats()).recordingSince).toBeNull();
    // A phone whose maker's name ends in "bot" is still a phone.
    await w.event("visit", B, { ua: "Mozilla/5.0 (Linux; Android 13; CUBOT NOTE 21) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36" });
    expect((await w.stats()).today.visits).toBe(1);
  });

  it("limits beacons per client address and per device", async () => {
    const w = world();
    for (let i = 0; i < 45; i++) await w.event("dock_open", A, { ip: `198.51.100.${i}` }); // one device, many addresses
    expect((await w.stats()).today.dockOpens).toBe(40);
    for (let i = 0; i < 250; i++) await w.event("visit", i.toString(16).padStart(32, "0")); // one address, many devices
    expect((await w.stats()).today.visits).toBe(240);
    w.clock.t += 60_001;
    await w.event("visit", B);
    expect((await w.stats()).today.visits).toBe(241);
  });

  it("writes no IP address, no device id and no Privy id into the metrics: only salted hashes", async () => {
    const w = world();
    await w.event("visit", A);
    await w.event("heartbeat", A);
    await w.event("signin", A, { token: TOKEN });
    await w.event("raid_start", A);
    const { keys } = await w.onDisk();
    const metrics = JSON.stringify(keys.filter(([k]) => k.startsWith("m:")));
    expect(metrics).toContain(hashId(SALT, "device", A));
    expect(metrics).toContain(hashId(SALT, "user", ALICE));
    for (const raw of [A, IP, ALICE, ALICE.slice("did:privy:".length), TOKEN, SALT, SECRET]) expect(metrics).not.toContain(raw);
    // And nowhere at all: the address, the token, the salt, the secret.
    for (const raw of [IP, TOKEN, SALT, SECRET, A]) expect(JSON.stringify(keys)).not.toContain(raw);
    expect(hashId(SALT, "device", A)).toMatch(/^[0-9a-f]{32}$/);
    expect(hashId(SALT, "device", A)).not.toBe(hashId(SALT, "user", A));
    expect(hashId(SALT, "device", A)).not.toBe(hashId(`${SALT}!`, "device", A));
  });

  it("counts a sign-in only when the server can verify it, and then knows the user", async () => {
    const w = world();
    await w.event("signin", A); // no token
    await w.event("signin", A, { token: TOKEN, verify: async () => Promise.reject(new Error("expired")) });
    let s = await w.stats();
    expect(s.recordingSince).toBeNull();
    expect(await listUsers(w.store)).toEqual([]);

    await w.event("signin", A, { token: TOKEN });
    w.clock.t += 5000;
    await w.event("signin", B, { token: TOKEN, ip: "198.51.100.4" }); // the same player on a second device
    await w.event("signin", C, { token: TOKEN, verify: async () => BOB, ip: "198.51.100.5" });
    s = await w.stats();
    expect(s.today.signIns).toBe(2);
    expect(s.funnel.signedIn).toBe(3);
    expect(s.totalUsers).toBe(2);
    expect((await listUsers(w.store))?.find((u) => u.id === ALICE)).toEqual({ id: ALICE, accountId: deriveWallet(CFG, ALICE).accountId, firstSeen: NOON, lastSeen: NOON + 5000, sessions: 0, visits: 2, callsign: null, passAt: null });
  });

  it("counts no sign-in where sign-in isn't set up on the server", async () => {
    const w = world({ METRICS_SALT: SALT });
    await w.event("signin", A, { token: TOKEN });
    await w.event("visit", A);
    const s = await w.stats();
    expect([s.today.visits, s.today.signIns, s.funnel.signedIn, s.totalUsers]).toEqual([1, 0, 0, 0]);
  });

  it("builds the funnel from distinct devices at each step", async () => {
    const w = world();
    for (const [i, d] of [A, B, C].entries()) await w.event("visit", d, { ip: `198.51.100.${i}` });
    await w.event("signin", A, { token: TOKEN });
    await w.event("signin", B, { token: TOKEN, verify: async () => BOB });
    for (const e of ["pass", "raid_start", "raid_start", "raid_death", "raid_start", "raid_extract"]) await w.event(e, A);
    w.clock.t += 3 * DAY; // three days on, it is still inside the window
    await w.event("visit", A);
    expect((await w.stats()).funnel).toEqual({ days: 15, visited: 3, signedIn: 2, gotPass: 1, startedRaid: 1, extracted: 1 });
    w.clock.t += 13 * DAY; // sixteen days after the first day: only the later visit is inside
    expect((await w.stats()).funnel).toEqual({ days: 15, visited: 1, signedIn: 0, gotPass: 0, startedRaid: 0, extracted: 0 });
  });

  it("lets a day's numbers go after ninety days", async () => {
    const w = world();
    await w.event("visit", A);
    await w.event("signin", A, { token: TOKEN });
    w.clock.t += (DAY_TTL_S - 60) * 1000;
    expect(await w.store.hgetall("m:day:2027-01-15")).toEqual({ visit: "1", signin: "1" });
    expect(await w.store.pfcount("m:day:2027-01-15:devices", "m:day:2027-01-15:users", "m:day:2027-01-15:did:signin")).toBe(2);
    w.clock.t += 120_000;
    expect(await w.store.hgetall("m:day:2027-01-15")).toEqual({});
    expect(await w.store.pfcount("m:day:2027-01-15:devices", "m:day:2027-01-15:users", "m:day:2027-01-15:did:signin")).toBe(0);
  });

  it("counts nothing without a salt: none set, or one too short to be one", async () => {
    const saltless: Record<string, string>[] = [{}, { METRICS_SALT: "short", WALLET_SECRET: SECRET }];
    for (const env of saltless) {
      const w = world(env);
      await w.event("visit");
      await w.event("heartbeat");
      expect((await w.onDisk().catch(() => ({ keys: [] }))).keys).toEqual([]);
    }
    expect(metricsSalt({})).toBeNull();
    expect(metricsSalt({ METRICS_SALT: "short", WALLET_SECRET: SECRET })).toBeNull();
    expect(metricsSalt({ METRICS_SALT: ` ${SALT} ` })).toBe(SALT);
  });

  it("takes its salt from WALLET_SECRET when it has none of its own, without ever storing or revealing the secret", async () => {
    const derived = metricsSalt({ WALLET_SECRET: SECRET })!;
    expect(derived).toMatch(/^[0-9a-f]{64}$/);
    expect(derived).not.toContain(SECRET);
    expect(metricsSalt({ WALLET_SECRET: SECRET })).toBe(derived);
    expect(metricsSalt({ WALLET_SECRET: "t".repeat(48) })).not.toBe(derived);
    expect(metricsSalt({ WALLET_SECRET: "too-short" })).toBeNull();
    const w = world({ WALLET_SECRET: SECRET, PRIVY_APP_ID: APP });
    await w.event("visit", A);
    const all = JSON.stringify((await w.onDisk()).keys);
    expect(all).toContain(hashId(derived, "device", A));
    expect(all).not.toContain(SECRET);
    expect(all).not.toContain(derived);
  });

  it("answers the same 204 with the store off or throwing", async () => {
    for (const store of [offStore(), broken("throws")]) {
      const w = world(ENV, store);
      expect((await w.event("visit")).status).toBe(204);
      expect((await w.event("signin", A, { token: TOKEN })).status).toBe(204);
      expect(w.logs).toEqual([]);
    }
  });

  it("gives up on a store that never answers", async () => {
    vi.useFakeTimers();
    const w = world(ENV, broken("hangs"));
    let status = 0;
    void w.event("visit").then((r) => (status = r.status));
    await vi.advanceTimersByTimeAsync(BEACON_JOB_MS - 1);
    expect(status).toBe(0);
    await vi.advanceTimersByTimeAsync(2);
    expect(status).toBe(204);
  });
});

describe("what the server counts itself", () => {
  const KEY = generateKey().secretKey;
  const FAUCET_ENV: FaucetEnv = { ...ENV, FAUCET_ACCOUNT_ID: "faucet.saltline.testnet", FAUCET_PRIVATE_KEY: KEY, VITE_CONTRACT_ID: "saltline.testnet", VITE_NEAR_NETWORK: "testnet", CONTRACT_ID_V2: "v2.saltline.testnet" };
  const chain: FaucetChain = { profile: async () => null, accountExists: async () => false, register: async () => ({ ok: true, txHash: "REG" }), fund: async () => ({ ok: true, txHash: "FUND" }) };
  const session = (store: Store, who: string, env: Record<string, string> = ENV) =>
    handleSession(new Request("http://localhost/api/session", { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "x-forwarded-for": IP } }), env, { verify: async () => who, limit: newSessionLimit(), now: () => NOON, log: () => {}, store });
  const pass = (store: Store, accountId: string, env: FaucetEnv = FAUCET_ENV, game: "v2" | null = "v2") =>
    handleFaucet(new Request("http://localhost/api/faucet", { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "x-forwarded-for": IP }, body: JSON.stringify({ accountId, callsign: "rook", ...(game ? { game } : {}) }) }), env, { chain: () => chain, limits: newLimits(), now: () => NOON, log: () => {}, verify: async () => ALICE, store });

  it("a wallet handed over is a session and a verified sign-in, counted on the server with no beacon", async () => {
    const store = memoryStore();
    expect((await session(store, ALICE)).status).toBe(200);
    expect((await session(store, ALICE)).status).toBe(200);
    expect((await session(store, BOB)).status).toBe(200);
    const s = await readStats(store, NOON);
    expect(s.today).toEqual({ ...zeroDay("2027-01-15"), sessions: 3, signIns: 2 });
    expect(s.totalUsers).toBe(2);
  });

  it("without a salt it still counts the session and keeps the user, and leaves the hashed set alone", async () => {
    const store = memoryStore();
    // A deployment can't have sign-in without WALLET_SECRET, so this is METRICS_SALT set badly: closed, not a fallback.
    await session(store, ALICE, { ...ENV, METRICS_SALT: "short" });
    const s = await readStats(store, NOON);
    expect([s.today.sessions, s.today.signIns, s.totalUsers]).toEqual([1, 0, 1]);
  });

  it("a v2 dock pass issued is counted, signed-in or guest; the first game's is not", async () => {
    const store = memoryStore();
    expect((await pass(store, deriveWallet(CFG, ALICE).accountId)).status).toBe(200);
    expect((await pass(store, "cd".repeat(32), { ...FAUCET_ENV, PRIVY_APP_ID: "", WALLET_SECRET: "" })).status).toBe(200);
    expect((await pass(store, "ef".repeat(32), FAUCET_ENV, null)).status).toBe(200);
    const s = await readStats(store, NOON);
    expect([s.today.passes, s.totalUsers]).toEqual([2, 1]);
  });
});

describe("reading the numbers: unknown is never shown as zero", () => {
  it("is all unknown with the store off", async () => {
    const s = await readStats(offStore(), NOON);
    expect(s.store).toBe("off");
    expect(s.recordingSince).toBeNull();
    expect([s.onlineNow, s.totalUsers]).toEqual([null, null]);
    expect(s.today).toEqual(unknownDay("2027-01-15"));
    expect(s.days.every((d) => Object.entries(d).every(([k, v]) => k === "day" || v === null))).toBe(true);
    expect(s.funnel).toEqual({ days: 15, visited: null, signedIn: null, gotPass: null, startedRaid: null, extracted: null });
  });

  it("is unknown before anything has been counted, though a store with no users has zero users", async () => {
    const s = await readStats(memoryStore(), NOON);
    expect(s.store).toBe("memory");
    expect(s.recordingSince).toBeNull();
    expect(s.today).toEqual(unknownDay("2027-01-15"));
    expect(s.onlineNow).toBeNull();
    expect(s.funnel.visited).toBeNull();
    expect(s.totalUsers).toBe(0);
  });

  it("is unknown for the days before counting began, and a true zero for a quiet day after", async () => {
    const w = world();
    w.clock.t = NOON - 2 * DAY;
    await w.event("visit");
    w.clock.t = NOON;
    const s = await w.stats();
    expect(s.today).toEqual(zeroDay("2027-01-15"));
    expect(s.days[0]).toEqual(zeroDay("2027-01-14"));
    expect(s.days[1]).toEqual({ ...zeroDay("2027-01-13"), visits: 1, devices: 1 });
    expect(s.days[2]).toEqual(unknownDay("2027-01-12"));
    expect(s.days[13]).toEqual(unknownDay("2027-01-01"));
  });

  it("is unknown for exactly the numbers whose read failed", async () => {
    const w = world();
    await w.event("visit");
    const noHashes: Store = { ...w.store, hgetall: async () => null };
    const a = await readStats(noHashes, NOON);
    expect(a.today).toEqual({ ...unknownDay("2027-01-15"), devices: 1, signIns: 0 });
    expect(a.onlineNow).toBe(1);
    const noCounts: Store = { ...w.store, pfcount: async () => null, zcount: async () => null };
    const b = await readStats(noCounts, NOON);
    expect(b.today).toEqual({ ...zeroDay("2027-01-15"), visits: 1, devices: null, signIns: null });
    expect([b.onlineNow, b.totalUsers, b.funnel.visited]).toEqual([null, null, null]);
    const garbled: Store = { ...w.store, hgetall: async () => ({ visit: "many", raid_start: "-3", dock_open: "2" }) };
    const c = await readStats(garbled, NOON);
    expect([c.today.visits, c.today.raidsStarted, c.today.dockOpens, c.today.raidsDied]).toEqual([null, null, 2, 0]);
  });
});

describe("GET /api/stats", () => {
  const ADMIN = "admin-token-0123456789abcdef";
  const ask = async (opts: { token?: string | null; env?: Record<string, string>; method?: string; store?: Store; query?: string; limit?: ReturnType<typeof newStatsLimit> } = {}) => {
    const logs: string[] = [];
    const headers: Record<string, string> = { "x-forwarded-for": IP };
    if (opts.token !== null) headers.authorization = `Bearer ${opts.token ?? ADMIN}`;
    const res = await handleStats(new Request(`http://localhost/api/stats${opts.query ?? ""}`, { method: opts.method ?? "GET", headers }), opts.env ?? { STATS_ADMIN_TOKEN: ADMIN }, {
      store: opts.store ?? memoryStore(),
      limit: opts.limit ?? newStatsLimit(),
      now: () => NOON,
      log: (l) => logs.push(l),
    });
    return { status: res.status, cache: res.headers.get("cache-control"), text: await res.clone().text(), body: (await res.json()) as StatsAnswer & { error?: string }, logs };
  };

  it("isn't there until an admin token is configured, and a short one doesn't count", async () => {
    expect((await ask({ env: {} })).status).toBe(404);
    expect((await ask({ env: { STATS_ADMIN_TOKEN: "  " } })).status).toBe(404);
    const short = await ask({ env: { STATS_ADMIN_TOKEN: "hunter2" }, token: "hunter2" });
    expect(short.status).toBe(404);
    expect(short.logs).toEqual(['[stats] not configured {"problems":["STATS_ADMIN_TOKEN"]}']);
  });

  it("answers 401 with no token or the wrong one, and never says what the right one is", async () => {
    for (const r of [await ask({ token: null }), await ask({ token: "wrong-token-0123456789abcdef" }), await ask({ token: ADMIN.slice(0, -1) }), await ask({ token: `${ADMIN}x` })]) {
      expect(r.status).toBe(401);
      expect(r.text).not.toContain(ADMIN);
      expect(r.logs.join("\n")).not.toContain(ADMIN);
      expect(r.body).toEqual({ ok: false, error: "The admin token is missing or wrong." });
    }
  });

  it("gives the holder of the token today, fourteen days, who is online, the users and the funnel, uncached", async () => {
    const w = world();
    await w.event("visit", A);
    await w.event("signin", A, { token: TOKEN });
    await w.event("raid_start", A);
    const r = await ask({ store: w.store });
    expect(r.status).toBe(200);
    expect(r.cache).toBe("no-store");
    expect(r.body).toEqual({
      ok: true,
      at: "2027-01-15T12:00:00.000Z",
      store: "file",
      recordingSince: "2027-01-15T12:00:00.000Z",
      onlineNow: 1,
      totalUsers: 1,
      today: { ...zeroDay("2027-01-15"), visits: 1, devices: 1, signIns: 1, raidsStarted: 1 },
      days: Array.from({ length: 14 }, (_, i) => unknownDay(new Date(NOON - (i + 1) * DAY).toISOString().slice(0, 10))),
      funnel: { days: 15, visited: 1, signedIn: 1, gotPass: 0, startedRaid: 1, extracted: 0 },
    });
    expect(r.text).not.toContain(ADMIN);
    expect("users" in r.body).toBe(false);
  });

  it("lists the newest users when asked, with times a person can read", async () => {
    const w = world();
    await w.event("signin", A, { token: TOKEN });
    w.clock.t += 60_000;
    await w.event("signin", B, { token: TOKEN, verify: async () => BOB });
    const r = await ask({ store: w.store, query: "?users=1" });
    expect(r.body.users).toEqual([{ id: BOB, accountId: deriveWallet(CFG, BOB).accountId, callsign: null, firstSeen: "2027-01-15T12:01:00.000Z", lastSeen: "2027-01-15T12:01:00.000Z", passAt: null, sessions: 0, visits: 1 }]);
    expect((await ask({ store: w.store, query: "?users=2" })).body.users).toHaveLength(2);
    for (const bad of ["?users=0", "?users=201", "?users=abc", "?users=1.5", "?users="]) expect((await ask({ query: bad })).status).toBe(400);
  });

  it("answers 200 with every number unknown, not zero, when the store is off", async () => {
    const r = await ask({ store: offStore(), query: "?users=5" });
    expect(r.status).toBe(200);
    expect(r.body.store).toBe("off");
    expect([r.body.onlineNow, r.body.totalUsers, r.body.today.visits, r.body.funnel.visited, r.body.users]).toEqual([null, null, null, null, null]);
    expect(r.text).not.toMatch(/":0[,}]/);
  });

  it("is GET only, and limits asks per client address so the token can't be guessed at speed", async () => {
    expect((await ask({ method: "POST" })).status).toBe(405);
    const limit = newStatsLimit();
    let last = 0;
    for (let i = 0; i < 31; i++) last = (await ask({ limit, token: "wrong-token-0123456789abcdef" })).status;
    expect(last).toBe(429);
    expect((await ask({ limit })).status).toBe(429); // the right token waits too
  });
});
