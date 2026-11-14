// The numbers (docs/DATA.md → Metrics): what is counted, under which keys, and how it is read back.
//
// Counted per UTC day, in the store (server/store.ts):
//
//   m:day:<YYYY-MM-DD>               a hash of counters, one field per event
//   m:day:<YYYY-MM-DD>:devices       a HyperLogLog of the devices heard from that day
//   m:day:<YYYY-MM-DD>:users         a HyperLogLog of the sign-ins the server verified that day
//   m:day:<YYYY-MM-DD>:did:<step>    a HyperLogLog of the devices that reached a funnel step that day
//   m:online                         a sorted set: device → when it was last heard from
//   m:since                          when counting began (ms): days before it are unknown, not zero
//
// **Privacy.** No IP address is ever written. A device is a random id made in the browser, and a sign-in is a Privy
// user id; neither is written here as it is. What goes into the sets is HMAC-SHA256(salt, kind + ":" + id), cut to
// 128 bits, and a HyperLogLog can be counted but not listed. The salt is METRICS_SALT. Without one it is derived
// from WALLET_SECRET (HMAC-SHA256(WALLET_SECRET, "saltline:v2:metrics-salt")), which is one-way: the salt can't be
// turned back into the secret, and it signs nothing. With neither, nothing is counted.
//
// **Unknown is not zero.** A number that couldn't be read is null. So is every number for a day before counting
// began. A counter that was read and has never been added to is a true 0.
import { createHmac } from "node:crypto";
import { MIN_WALLET_SECRET } from "./auth.js";
import type { Store, StoreKind } from "./store.js";
import { countUsers } from "./users.js";

type Env = Record<string, string | undefined>;

/** What a browser may report (POST /api/metrics). Anything else is dropped. */
export const BROWSER_EVENTS = ["visit", "signin", "pass", "raid_start", "raid_extract", "raid_death", "dock_open", "practice_start"] as const;
export type BrowserEvent = (typeof BROWSER_EVENTS)[number];
/** "Still here": keeps a device in the online set and counts nothing. */
export const HEARTBEAT = "heartbeat";
/** What the server counts itself, where it happens (server/record.ts). */
export type ServerEvent = "session_issued" | "pass_issued";

/** "Online now" is every device heard from in this long. */
export const ONLINE_MS = 120_000;
/** Devices silent for this long are dropped from the online set when someone new arrives. */
const ONLINE_KEEP_MS = 600_000;
/** A day's counters and sets are kept this long, then Redis drops them. */
export const DAY_TTL_S = 90 * 86_400;
/** Stats cover today and this many days before it. */
export const STATS_DAYS = 14;

/** The funnel's steps after "visited", each a set of devices: the event that puts a device in it. */
const STEP: Partial<Record<BrowserEvent, string>> = { signin: "signin", pass: "pass", raid_start: "raid_start", raid_extract: "raid_extract" };

export const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const dayKey = (day: string) => `m:day:${day}`;
const ONLINE = "m:online";
const SINCE = "m:since";

/** A METRICS_SALT shorter than this is refused: it is all that stands between a hash and the id behind it. */
export const MIN_METRICS_SALT = 16;

/**
 * The salt ids are hashed with, or null when there is none and nothing may be counted. A METRICS_SALT that is set
 * but too short is null too: a bad setting closes the door, it doesn't fall back to the next one.
 */
export function metricsSalt(env: Env): string | null {
  const own = (env.METRICS_SALT ?? "").trim();
  if (own) return own.length >= MIN_METRICS_SALT ? own : null;
  const secret = (env.WALLET_SECRET ?? "").trim();
  return secret.length >= MIN_WALLET_SECRET ? createHmac("sha256", secret).update("saltline:v2:metrics-salt").digest("hex") : null;
}

/** The only form in which a device or a sign-in enters the metrics. */
export function hashId(salt: string, kind: "device" | "user", id: string): string {
  return createHmac("sha256", salt).update(`${kind}:${id}`).digest("hex").slice(0, 32);
}

// Housekeeping that a key needs once, not with every event: its expiry, and the mark of when counting began. Each
// server instance does it the first time it touches the key (a cold start does it again, which is harmless), so an
// event costs three or four commands instead of six or seven.
const tended = new WeakMap<Store, Set<string>>();
function once(store: Store, what: string, job: () => Promise<boolean>): Promise<boolean>[] {
  let seen = tended.get(store);
  if (!seen) tended.set(store, (seen = new Set()));
  if (seen.has(what)) return [];
  if (seen.size > 1000) seen.clear();
  seen.add(what);
  const mine = seen;
  return [job().then((ok) => (ok || mine.delete(what), ok))];
}
const keep = (store: Store, key: string) => once(store, key, () => store.expire(key, DAY_TTL_S));
const began = (store: Store, at: number) => once(store, SINCE, () => store.set(SINCE, String(at), { ifAbsent: true }));

/** One event from a browser. `device` is the raw id; only its hash is written. */
export async function countBeacon(store: Store, salt: string, b: { event: BrowserEvent | typeof HEARTBEAT; device: string; at: number }): Promise<boolean> {
  const who = hashId(salt, "device", b.device);
  const jobs: Promise<boolean>[] = [store.zadd(ONLINE, b.at, who)];
  if (b.event !== HEARTBEAT) {
    const day = dayKey(utcDay(b.at));
    jobs.push(store.hincrby(day, b.event, 1), ...keep(store, day), store.pfadd(`${day}:devices`, who), ...keep(store, `${day}:devices`), ...began(store, b.at));
    const step = STEP[b.event];
    if (step) jobs.push(store.pfadd(`${day}:did:${step}`, who), ...keep(store, `${day}:did:${step}`));
    if (b.event === "visit") jobs.push(store.zremrangebyscore(ONLINE, "-inf", b.at - ONLINE_KEEP_MS));
  }
  return (await Promise.all(jobs)).every(Boolean);
}

/** A sign-in the server itself verified today. `userId` is the raw Privy id; only its hash is written. */
export async function countUser(store: Store, salt: string, u: { userId: string; at: number }): Promise<boolean> {
  const key = `${dayKey(utcDay(u.at))}:users`;
  return (await Promise.all([store.pfadd(key, hashId(salt, "user", u.userId)), ...keep(store, key), ...began(store, u.at)])).every(Boolean);
}

/** Something the server did itself. */
export async function countServer(store: Store, e: { event: ServerEvent; at: number }): Promise<boolean> {
  const day = dayKey(utcDay(e.at));
  return (await Promise.all([store.hincrby(day, e.event, 1), ...keep(store, day), ...began(store, e.at)])).every(Boolean);
}

// ---------------------------------------------------------------------------------------------------------------
// Reading

type Num = number | null;

export interface DayStats {
  /** YYYY-MM-DD, UTC. */
  day: string;
  /** Page sessions that showed a person was there. */
  visits: Num;
  /** Distinct devices heard from. */
  devices: Num;
  /** Distinct sign-ins the server verified. */
  signIns: Num;
  /** Wallets handed over by /api/session. */
  sessions: Num;
  /** v2 dock passes the faucet issued. */
  passes: Num;
  raidsStarted: Num;
  raidsExtracted: Num;
  raidsDied: Num;
  dockOpens: Num;
  practiceStarts: Num;
}

export interface Funnel {
  /** How many days it covers, today included. */
  days: number;
  /** Distinct devices at each step. */
  visited: Num;
  signedIn: Num;
  gotPass: Num;
  startedRaid: Num;
  extracted: Num;
}

export interface Stats {
  /** When this was read (ISO 8601, UTC). */
  at: string;
  store: StoreKind;
  /** When counting began, or null if nothing has been counted yet (or that couldn't be read). */
  recordingSince: string | null;
  onlineNow: Num;
  totalUsers: Num;
  today: DayStats;
  /** The days before today, newest first. */
  days: DayStats[];
  funnel: Funnel;
}

const FIELDS: [keyof DayStats, string][] = [
  ["visits", "visit"],
  ["sessions", "session_issued"],
  ["passes", "pass_issued"],
  ["raidsStarted", "raid_start"],
  ["raidsExtracted", "raid_extract"],
  ["raidsDied", "raid_death"],
  ["dockOpens", "dock_open"],
  ["practiceStarts", "practice_start"],
];

const unknownDay = (day: string): DayStats => ({ day, visits: null, devices: null, signIns: null, sessions: null, passes: null, raidsStarted: null, raidsExtracted: null, raidsDied: null, dockOpens: null, practiceStarts: null });

/** Every number for today and the STATS_DAYS before it. All the reads go out together: one round trip to Upstash. */
export async function readStats(store: Store, at: number): Promise<Stats> {
  const dayNames = Array.from({ length: STATS_DAYS + 1 }, (_, i) => utcDay(at - i * 86_400_000));
  const across = (suffix: string) => store.pfcount(...dayNames.map((d) => `${dayKey(d)}:${suffix}`));
  const totals = Promise.all([
    store.get(SINCE),
    store.zcount(ONLINE, at - ONLINE_MS, "+inf"),
    countUsers(store),
    across("devices"),
    across("did:signin"),
    across("did:pass"),
    across("did:raid_start"),
    across("did:raid_extract"),
  ]);
  const perDay = Promise.all(
    dayNames.map(async (day) => {
      const [counts, devices, users] = await Promise.all([store.hgetall(dayKey(day)), store.pfcount(`${dayKey(day)}:devices`), store.pfcount(`${dayKey(day)}:users`)]);
      return { day, counts, devices, users };
    }),
  );
  const [sinceRaw, online, totalUsers, visited, signedIn, gotPass, startedRaid, extracted] = await totals;
  const read = await perDay;

  const since = sinceRaw !== null && /^\d{10,16}$/.test(sinceRaw) ? Number(sinceRaw) : null;
  const firstDay = since === null ? null : utcDay(since);
  const rows = read.map(({ day, counts, devices, users }): DayStats => {
    // Before counting began there is nothing to read, and nothing is not zero.
    if (firstDay === null || day < firstDay) return unknownDay(day);
    const row = { ...unknownDay(day), devices, signIns: users };
    if (counts) {
      for (const [field, counter] of FIELDS) {
        const v = counts[counter];
        (row as Record<string, unknown>)[field] = v === undefined ? 0 : /^\d{1,15}$/.test(v) ? Number(v) : null;
      }
    }
    return row;
  });
  const counted = <T>(v: T): T | null => (since === null ? null : v);
  return {
    at: new Date(at).toISOString(),
    store: store.kind,
    recordingSince: since === null ? null : new Date(since).toISOString(),
    onlineNow: counted(online),
    totalUsers,
    today: rows[0],
    days: rows.slice(1),
    funnel: { days: dayNames.length, visited: counted(visited), signedIn: counted(signedIn), gotPass: counted(gotPass), startedRaid: counted(startedRaid), extracted: counted(extracted) },
  };
}
