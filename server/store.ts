// The database: one small key-value interface for users and metrics (docs/DATA.md), and the three places it can live.
//
// - **Upstash Redis**, over its REST API with plain `fetch` (the deployed game). No client library: the twelve
//   commands used here are one POST each, and commands issued together travel as one request.
// - **A JSON file** under `.saltline.local/` (local dev with no cloud account).
// - **Memory** (tests).
//
// Not configured is **off**: every write is skipped and every read answers null.
//
// The rule every caller relies on: **no method here ever rejects or throws.** A write that didn't land answers false.
// A read that failed, timed out or was never made answers null, which callers show as "unknown" and never as 0. An
// answer that was really read and is empty is not null: {} for a hash, [] for a range, 0 for a count.
//
// The game never waits on any of this for longer than a time-box, and never needs an answer from it: sign-in, the
// dock pass and play go on exactly the same with the store off, slow or failing (`quietly` below is that time-box).
//
// Verified 14 Nov 2026 against upstash.com/docs/redis/features/restapi:
// - `POST <url>/pipeline` with `Authorization: Bearer <token>` and a JSON array of command arrays; the answer is an
//   array with one `{"result": …}` or `{"error": …}` per command, in order. A pipeline is not atomic.
// - null, integers, strings and arrays come back as the same JSON types; HTTP 400 is a refused command, 401 a bad
//   token.
// - The commands used (GET SET HSET HSETNX HINCRBY HGETALL ZADD ZRANGE ZCOUNT ZREMRANGEBYSCORE PFADD PFCOUNT EXPIRE)
//   are all on Upstash's supported lists (docs/redis/commands/*).
// - Vercel's Upstash integration names the same pair KV_REST_API_URL / KV_REST_API_TOKEN (the names Vercel KV used;
//   upstash.com's own client reads either pair). Both are accepted here.
import { mkdirSync, readFileSync, renameSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

type Env = Record<string, string | undefined>;

export type StoreKind = "upstash" | "file" | "memory" | "off";
type Bound = number | "-inf" | "+inf";

export interface Store {
  readonly kind: StoreKind;
  /** null: no such key, or the read failed. Callers treat both as unknown. */
  get(key: string): Promise<string | null>;
  /** `ifAbsent` writes only when the key doesn't exist yet. */
  set(key: string, value: string, opts?: { ifAbsent?: boolean }): Promise<boolean>;
  /** `ifAbsent` writes each field only when that field isn't set yet. */
  hset(key: string, fields: Record<string, string>, opts?: { ifAbsent?: boolean }): Promise<boolean>;
  hincrby(key: string, field: string, by?: number): Promise<boolean>;
  /** {} when there is no such key; null when the read failed. */
  hgetall(key: string): Promise<Record<string, string> | null>;
  /** `ifAbsent` adds a new member and never moves one that is already there. */
  zadd(key: string, score: number, member: string, opts?: { ifAbsent?: boolean }): Promise<boolean>;
  /** Members by rank, lowest score first, or highest first with `rev`. `stop` is inclusive; -1 is the last. */
  zrange(key: string, start: number, stop: number, opts?: { rev?: boolean }): Promise<string[] | null>;
  zcount(key: string, min: Bound, max: Bound): Promise<number | null>;
  zremrangebyscore(key: string, min: Bound, max: Bound): Promise<boolean>;
  /** Adds to a HyperLogLog: a set that can only be counted, never listed. */
  pfadd(key: string, ...members: string[]): Promise<boolean>;
  /** How many distinct members were added, across all the keys together. */
  pfcount(...keys: string[]): Promise<number | null>;
  expire(key: string, seconds: number): Promise<boolean>;
}

// ---------------------------------------------------------------------------------------------------------------
// One typed face over a command runner. Every store below is a way of running Redis commands, so the three of them
// send the same commands and read the same answers, and the tests of one are the tests of all.

type Arg = string | number;
export type Command = [name: string, ...args: Arg[]];
/** What a command answers when it didn't run: the store is off, slow, unreachable, or refused it. */
const FAILED = Symbol("failed");
type Run = (command: Command) => Promise<unknown>;

function asHash(reply: unknown): Record<string, string> | null {
  // Redis answers a hash as [field, value, field, value, …]; a map is accepted too.
  if (Array.isArray(reply)) {
    if (reply.length % 2 !== 0 || !reply.every((x) => typeof x === "string")) return null;
    const out: Record<string, string> = {};
    for (let i = 0; i < reply.length; i += 2) out[reply[i]] = reply[i + 1];
    return out;
  }
  if (reply && typeof reply === "object" && Object.values(reply).every((x) => typeof x === "string")) return { ...(reply as Record<string, string>) };
  return null;
}

function storeOver(kind: StoreKind, runner: Run, prefix: string): Store {
  const run: Run = async (command) => {
    try {
      return await runner(command);
    } catch {
      return FAILED;
    }
  };
  const k = (key: string) => prefix + key;
  const wrote = async (...commands: Command[]) => (await Promise.all(commands.map(run))).every((r) => r !== FAILED);
  const count = async (command: Command) => {
    const r = await run(command);
    return typeof r === "number" && Number.isSafeInteger(r) && r >= 0 ? r : null;
  };
  return {
    kind,
    async get(key) {
      const r = await run(["GET", k(key)]);
      return typeof r === "string" ? r : null;
    },
    set: (key, value, o) => wrote(o?.ifAbsent ? ["SET", k(key), value, "NX"] : ["SET", k(key), value]),
    hset(key, fields, o) {
      const pairs = Object.entries(fields);
      if (!pairs.length) return Promise.resolve(true);
      return o?.ifAbsent ? wrote(...pairs.map(([f, v]): Command => ["HSETNX", k(key), f, v])) : wrote(["HSET", k(key), ...pairs.flat()]);
    },
    hincrby: (key, field, by = 1) => wrote(["HINCRBY", k(key), field, by]),
    async hgetall(key) {
      const r = await run(["HGETALL", k(key)]);
      return r === FAILED ? null : asHash(r);
    },
    zadd: (key, score, member, o) => wrote(o?.ifAbsent ? ["ZADD", k(key), "NX", score, member] : ["ZADD", k(key), score, member]),
    async zrange(key, start, stop, o) {
      const r = await run(o?.rev ? ["ZRANGE", k(key), start, stop, "REV"] : ["ZRANGE", k(key), start, stop]);
      return Array.isArray(r) && r.every((m) => typeof m === "string") ? (r as string[]) : null;
    },
    zcount: (key, min, max) => count(["ZCOUNT", k(key), min, max]),
    zremrangebyscore: (key, min, max) => wrote(["ZREMRANGEBYSCORE", k(key), min, max]),
    pfadd: (key, ...members) => (members.length ? wrote(["PFADD", k(key), ...members]) : Promise.resolve(true)),
    pfcount: (...keys) => (keys.length ? count(["PFCOUNT", ...keys.map(k)]) : Promise.resolve(null)),
    expire: (key, seconds) => wrote(["EXPIRE", k(key), seconds]),
  };
}

/** Every key is written under this, so preview deployments that share the production database keep their own numbers. */
export function keyPrefix(env: Env): string {
  const where = (env.VERCEL_ENV ?? "").trim();
  return where === "preview" || where === "development" ? `saltline:${where}:` : "saltline:";
}

// ---------------------------------------------------------------------------------------------------------------
// Off

export const offStore = (): Store => storeOver("off", async () => FAILED, "");

// ---------------------------------------------------------------------------------------------------------------
// Memory, and the file that is memory written down. A HyperLogLog here is the exact set it estimates.

interface Shapes {
  string: string;
  hash: Map<string, string>;
  zset: Map<string, number>;
  hll: Set<string>;
}
type Entry = { [T in keyof Shapes]: { t: T; v: Shapes[T]; expires?: number } }[keyof Shapes];
type Saved = { t: keyof Shapes; x?: number; v: unknown };

const WRITES = new Set(["SET", "HSET", "HSETNX", "HINCRBY", "ZADD", "ZREMRANGEBYSCORE", "PFADD", "EXPIRE"]);

/**
 * The commands above, with Redis's own answers, over a Map. Throws on anything Redis would refuse. Exported for the
 * tests, where it also stands in for the server behind Upstash's REST API.
 */
export function localRedis(now: () => number = Date.now) {
  const keys = new Map<string, Entry>();
  const live = (key: string): Entry | undefined => {
    const e = keys.get(key);
    if (e && e.expires !== undefined && e.expires <= now()) return void keys.delete(key);
    return e;
  };
  function at<T extends keyof Shapes>(key: string, t: T, make?: () => Shapes[T]): Shapes[T] | undefined {
    let e = live(key);
    if (!e && make) keys.set(key, (e = { t, v: make() } as Entry));
    if (e && e.t !== t) throw new Error("WRONGTYPE");
    return e?.v as Shapes[T] | undefined;
  }
  const int = (a: Arg | undefined): number => {
    const n = typeof a === "number" ? a : /^-?\d+$/.test(a ?? "") ? Number(a) : NaN;
    if (!Number.isSafeInteger(n)) throw new Error("ERR value is not an integer");
    return n;
  };
  const bound = (a: Arg | undefined): number => {
    const n = a === "-inf" ? -Infinity : a === "+inf" || a === "inf" ? Infinity : Number(a);
    if (a === undefined || a === "" || Number.isNaN(n)) throw new Error("ERR min or max is not a float");
    return n;
  };
  const text = (a: Arg | undefined): string => {
    if (a === undefined) throw new Error("ERR wrong number of arguments");
    return String(a);
  };
  const ranked = (z: Map<string, number>) => [...z].sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([m]) => m);

  function exec([name, ...a]: Command): unknown {
    const key = text(a[0]);
    switch (name) {
      case "GET":
        return at(key, "string") ?? null;
      case "SET": {
        if (a[2] !== undefined && a[2] !== "NX") throw new Error("ERR syntax error");
        if (a[2] === "NX" && live(key)) return null;
        keys.set(key, { t: "string", v: text(a[1]) });
        return "OK";
      }
      case "HSET": {
        if (a.length < 3 || a.length % 2 === 0) throw new Error("ERR wrong number of arguments");
        const h = at(key, "hash", () => new Map())!;
        let added = 0;
        for (let i = 1; i < a.length; i += 2) {
          if (!h.has(text(a[i]))) added++;
          h.set(text(a[i]), text(a[i + 1]));
        }
        return added;
      }
      case "HSETNX": {
        const h = at(key, "hash", () => new Map())!;
        if (h.has(text(a[1]))) return 0;
        h.set(text(a[1]), text(a[2]));
        return 1;
      }
      case "HINCRBY": {
        const by = int(a[2]);
        const h = at(key, "hash", () => new Map())!;
        const next = int(h.get(text(a[1])) ?? "0") + by;
        h.set(text(a[1]), String(next));
        return next;
      }
      case "HGETALL":
        return [...(at(key, "hash") ?? [])].flat();
      case "ZADD": {
        const nx = a[1] === "NX";
        const score = Number(a[nx ? 2 : 1]);
        const member = text(a[nx ? 3 : 2]);
        if (!Number.isFinite(score) || a.length !== (nx ? 4 : 3)) throw new Error("ERR syntax error");
        const z = at(key, "zset", () => new Map())!;
        const had = z.has(member);
        if (!had || !nx) z.set(member, score);
        return had ? 0 : 1;
      }
      case "ZRANGE": {
        if (a[3] !== undefined && a[3] !== "REV") throw new Error("ERR syntax error");
        const list = ranked(at(key, "zset") ?? new Map());
        if (a[3] === "REV") list.reverse();
        const from = int(a[1]) < 0 ? Math.max(0, list.length + int(a[1])) : int(a[1]);
        const to = int(a[2]) < 0 ? list.length + int(a[2]) : int(a[2]);
        return list.slice(from, to + 1);
      }
      case "ZCOUNT": {
        const [min, max] = [bound(a[1]), bound(a[2])];
        return [...(at(key, "zset")?.values() ?? [])].filter((s) => s >= min && s <= max).length;
      }
      case "ZREMRANGEBYSCORE": {
        const [min, max] = [bound(a[1]), bound(a[2])];
        const z = at(key, "zset");
        let gone = 0;
        for (const [m, s] of z ?? []) if (s >= min && s <= max) (z!.delete(m), gone++);
        if (z && !z.size) keys.delete(key);
        return gone;
      }
      case "PFADD": {
        const set = at(key, "hll", () => new Set())!;
        const before = set.size;
        for (const m of a.slice(1)) set.add(text(m));
        return set.size > before ? 1 : 0;
      }
      case "PFCOUNT": {
        const all = new Set<string>();
        for (const each of a) for (const m of at(text(each), "hll") ?? []) all.add(m);
        return all.size;
      }
      case "EXPIRE": {
        const e = live(key);
        if (!e) return 0;
        e.expires = now() + int(a[1]) * 1000;
        return 1;
      }
      default:
        throw new Error(`ERR unknown command '${name}'`);
    }
  }

  return {
    exec,
    save(): { v: 1; keys: [string, Saved][] } {
      const out: [string, Saved][] = [];
      for (const key of [...keys.keys()]) {
        const e = live(key);
        if (e) out.push([key, { t: e.t, ...(e.expires === undefined ? {} : { x: e.expires }), v: e.t === "string" ? e.v : [...e.v] }]);
      }
      return { v: 1, keys: out };
    },
    /** Takes back what `save` wrote. Throws on anything else, and then holds nothing. */
    load(data: unknown) {
      keys.clear();
      try {
        const d = data as { v?: unknown; keys?: unknown };
        if (!d || d.v !== 1 || !Array.isArray(d.keys)) throw new Error("not a store file");
        for (const [key, s] of d.keys as [string, Saved][]) {
          if (typeof key !== "string" || !s || (s.x !== undefined && typeof s.x !== "number")) throw new Error("not a store file");
          const pairs = <T>(ok: (x: unknown) => x is T) => {
            if (!Array.isArray(s.v) || !s.v.every((p) => Array.isArray(p) && p.length === 2 && typeof p[0] === "string" && ok(p[1]))) throw new Error("not a store file");
            return s.v as [string, T][];
          };
          let e: Entry;
          if (s.t === "string" && typeof s.v === "string") e = { t: "string", v: s.v };
          else if (s.t === "hash") e = { t: "hash", v: new Map(pairs((x): x is string => typeof x === "string")) };
          else if (s.t === "zset") e = { t: "zset", v: new Map(pairs((x): x is number => typeof x === "number" && Number.isFinite(x))) };
          else if (s.t === "hll" && Array.isArray(s.v) && s.v.every((m) => typeof m === "string")) e = { t: "hll", v: new Set(s.v as string[]) };
          else throw new Error("not a store file");
          if (s.x !== undefined) e.expires = s.x;
          keys.set(key, e);
        }
      } catch (err) {
        keys.clear();
        throw err;
      }
    },
  };
}

export interface LocalOptions {
  /** Prepended to every key (keyPrefix). */
  prefix?: string;
  now?: () => number;
  log?: (line: string) => void;
}

export function memoryStore(opts: LocalOptions = {}): Store {
  const db = localRedis(opts.now ?? Date.now);
  return storeOver("memory", async (c) => db.exec(c), opts.prefix ?? "");
}

export interface FileStore extends Store {
  /** Resolves once everything written so far is on disk. */
  flushed(): Promise<void>;
}

/** The dev store's home, under the folder the server was started in. It is in .gitignore. */
export const LOCAL_STORE_FILE = ".saltline.local/store.json";

/**
 * The memory store, read from `path` at the start and written back after every change (to a temporary file that is
 * then renamed over it, so a crash mid-write can't leave half a file). A file that can't be read is set aside as
 * `<path>.bad` and the store starts empty.
 */
export function fileStore(path: string, opts: LocalOptions = {}): FileStore {
  const log = opts.log ?? ((line: string) => console.warn(line));
  const db = localRedis(opts.now ?? Date.now);
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch {
    // the first write says so
  }
  try {
    db.load(JSON.parse(readFileSync(path, "utf8")));
  } catch (e) {
    if ((e as { code?: string })?.code !== "ENOENT") {
      log(`[store] file: couldn't read it, starting empty ${JSON.stringify({ error: (e as Error)?.name })}`);
      try {
        renameSync(path, `${path}.bad`);
      } catch {
        // nothing to set aside
      }
    }
  }
  let dirty = false;
  let saving: Promise<void> | null = null;
  let warned = false;
  const save = () => {
    dirty = true;
    saving ??= (async () => {
      try {
        while (dirty) {
          dirty = false;
          const tmp = `${path}.${process.pid}.tmp`;
          await writeFile(tmp, JSON.stringify(db.save()));
          await rename(tmp, path);
        }
      } catch (e) {
        if (!warned) ((warned = true), log(`[store] file: couldn't write it ${JSON.stringify({ error: (e as Error)?.name })}`));
      } finally {
        saving = null;
      }
    })();
  };
  const store = storeOver(
    "file",
    async (c) => {
      const reply = db.exec(c);
      if (WRITES.has(c[0])) save();
      return reply;
    },
    opts.prefix ?? "",
  );
  return { ...store, flushed: async () => void (await saving) };
}

// ---------------------------------------------------------------------------------------------------------------
// Upstash Redis over REST

/** A request to the database is given this long, then counted as failed. */
export const STORE_TIMEOUT_MS = 2000;
/** Upstash takes far more in one pipeline; this keeps any one request small. */
const MAX_BATCH = 100;

export interface UpstashOptions {
  prefix?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  log?: (line: string) => void;
  now?: () => number;
}

/**
 * Commands issued in the same turn of the event loop go out as one `POST /pipeline`, so recording an event costs one
 * round trip however many keys it touches. A request that fails, times out or answers nonsense fails every command
 * in it; a command Redis refuses fails alone. Nothing is retried: a counter that may have landed is not sent twice.
 * The URL and the token are never logged.
 */
export function upstashStore(cfg: { url: string; token: string }, opts: UpstashOptions = {}): Store {
  const doFetch = opts.fetch ?? ((u, i) => fetch(u, i));
  const timeoutMs = opts.timeoutMs ?? STORE_TIMEOUT_MS;
  const sink = opts.log ?? ((line: string) => console.warn(line));
  const now = opts.now ?? Date.now;
  const endpoint = `${cfg.url.replace(/\/+$/, "")}/pipeline`;
  let lastWarned = -Infinity;
  const warn = (why: string) => {
    // One line a minute at most: a database that is down fails every request, and the log should say so once.
    if (now() - lastWarned < 60_000) return;
    lastWarned = now();
    sink(`[store] upstash: a request failed ${JSON.stringify({ why })}`);
  };

  type Waiting = { command: Command; done: (reply: unknown) => void };
  let queue: Waiting[] = [];

  async function send(batch: Waiting[]) {
    let replies: unknown = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const abort = new AbortController();
      const asked = (async () => {
        const res = await doFetch(endpoint, {
          method: "POST",
          headers: { authorization: `Bearer ${cfg.token}`, "content-type": "application/json" },
          body: JSON.stringify(batch.map((w) => w.command)),
          signal: abort.signal,
        });
        if (!res.ok) return void warn(`http ${res.status}`);
        return (await res.json()) as unknown;
      })();
      // The timer decides, not the fetch: a fetch that ignores its signal still can't hold a request past the time-box.
      const late = new Promise<null>((ok) => {
        timer = setTimeout(() => (abort.abort(), warn("timeout"), ok(null)), timeoutMs);
      });
      asked.catch(() => {});
      replies = await Promise.race([asked, late]);
    } catch (e) {
      warn((e as Error)?.name || "error");
    } finally {
      clearTimeout(timer);
    }
    const list = Array.isArray(replies) && replies.length === batch.length ? (replies as unknown[]) : null;
    if (replies != null && !list) warn("unexpected answer");
    batch.forEach((w, i) => {
      const r = list?.[i] as { result?: unknown; error?: unknown } | null | undefined;
      w.done(r && typeof r === "object" && "result" in r && !("error" in r) ? r.result : FAILED);
    });
  }

  function flush() {
    const all = queue;
    queue = [];
    for (let i = 0; i < all.length; i += MAX_BATCH) void send(all.slice(i, i + MAX_BATCH));
  }

  return storeOver(
    "upstash",
    (command) =>
      new Promise((done) => {
        queue.push({ command, done });
        if (queue.length === 1) queueMicrotask(flush);
      }),
    opts.prefix ?? "",
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Which store this deployment uses

export type StoreConfig = { kind: "off"; problems: string[] } | { kind: "upstash"; url: string; token: string } | { kind: "file"; path: string };

function restUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    const local = u.hostname === "127.0.0.1" || u.hostname === "localhost";
    if (u.protocol !== "https:" && !(local && u.protocol === "http:")) return null;
    if (u.username || u.password || u.search || u.hash) return null;
    return u.href.replace(/\/+$/, "");
  } catch {
    return null;
  }
}

/**
 * Reads the store's settings. `problems` names what is missing or malformed, never a value.
 *
 * - `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` (or Vercel's names for the same pair, `KV_REST_API_URL` +
 *   `KV_REST_API_TOKEN`) switch the database on. With neither, it is off and nothing is a problem.
 * - `SALTLINE_STORE` overrides: `file` is the JSON file (never on Vercel, whose disk doesn't last), `off` is off,
 *   `upstash` insists on the pair above. Anything half-set or malformed is off, not a guess.
 */
export function storeConfig(env: Env): StoreConfig {
  const v = (k: string) => (env[k] ?? "").trim();
  const want = v("SALTLINE_STORE").toLowerCase();
  if (want === "off") return { kind: "off", problems: [] };
  if (want === "file") return v("VERCEL") ? { kind: "off", problems: ["SALTLINE_STORE"] } : { kind: "file", path: resolve(LOCAL_STORE_FILE) };
  if (want !== "" && want !== "upstash") return { kind: "off", problems: ["SALTLINE_STORE"] };

  const rawUrl = v("UPSTASH_REDIS_REST_URL") || v("KV_REST_API_URL");
  const token = v("UPSTASH_REDIS_REST_TOKEN") || v("KV_REST_API_TOKEN");
  if (!rawUrl && !token) return { kind: "off", problems: want === "upstash" ? ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"] : [] };
  const problems: string[] = [];
  const url = restUrl(rawUrl);
  if (!url) problems.push("UPSTASH_REDIS_REST_URL");
  if (token.length < 8 || /\s/.test(token)) problems.push("UPSTASH_REDIS_REST_TOKEN");
  return problems.length || !url ? { kind: "off", problems } : { kind: "upstash", url, token };
}

let current: { signature: string; store: Store } | null = null;

/** The store for this server instance: built once and kept, so batches and the dev file are shared by every request. */
export function storeFor(env: Env, log: (line: string) => void = (line) => console.warn(line)): Store {
  try {
    const cfg = storeConfig(env);
    const prefix = keyPrefix(env);
    const signature = JSON.stringify([cfg, prefix]); // compared in memory only, never logged
    if (current?.signature === signature) return current.store;
    if (cfg.kind === "off" && cfg.problems.length) log(`[store] off: not configured ${JSON.stringify({ problems: cfg.problems })}`);
    const store = cfg.kind === "upstash" ? upstashStore(cfg, { prefix }) : cfg.kind === "file" ? fileStore(cfg.path, { prefix }) : offStore();
    current = { signature, store };
    return store;
  } catch {
    return offStore();
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The time-box for anything a request does on the side

/**
 * Runs a side job (writing a user down, counting an event) that must never hold up or break the request it rides on:
 * it is given `ms`, and whatever it throws is swallowed. Answers true when the job finished in time.
 */
export async function quietly(job: () => Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const late = new Promise<false>((ok) => {
      timer = setTimeout(() => ok(false), ms);
    });
    return await Promise.race([Promise.resolve().then(job).then(() => true), late]);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
