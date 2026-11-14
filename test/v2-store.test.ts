// The database (server/store.ts): the same behaviour from memory, from the JSON file and from Upstash's REST API,
// what "off" means, and the rule that nothing in it ever throws into a request. No network: Upstash is stood in for
// by a fetch that speaks its documented REST shapes over the local Redis.
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type Command, LOCAL_STORE_FILE, type Store, fileStore, keyPrefix, localRedis, memoryStore, offStore, quietly, storeConfig, storeFor, upstashStore } from "../server/store";

// A reserved name (RFC 2606): no test here touches the network, and this address couldn't answer if one did.
const URL_ = "https://fine-koi-12345.upstash.example";
const TOKEN = "AbCdEf0123456789-test-token";
const T0 = 1_800_000_000_000;
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const tmp = () => mkdtempSync(join(tmpdir(), "saltline-store-"));

/** Upstash's REST API as its docs describe it: POST <url>/pipeline, a bearer token, one {result} or {error} per command. */
function fakeUpstash(now: () => number = Date.now) {
  const db = localRedis(now);
  const requests: { url: string; auth: string | null; commands: Command[] }[] = [];
  const doFetch = (async (url: string, init?: RequestInit) => {
    const commands = JSON.parse(String(init?.body)) as Command[];
    const auth = new Headers(init?.headers).get("authorization");
    requests.push({ url, auth, commands });
    if (auth !== `Bearer ${TOKEN}`) return json(401, { error: "Unauthorized" });
    return json(
      200,
      commands.map((c) => {
        try {
          return { result: db.exec(c) };
        } catch (e) {
          return { error: (e as Error).message };
        }
      }),
    );
  }) as typeof fetch;
  return { fetch: doFetch, requests };
}

const makers: [string, (now: () => number) => Store][] = [
  ["memory", (now) => memoryStore({ now })],
  ["file", (now) => fileStore(join(tmp(), "store.json"), { now })],
  ["upstash (REST stand-in)", (now) => upstashStore({ url: URL_, token: TOKEN }, { fetch: fakeUpstash(now).fetch, now })],
];

describe.each(makers)("the %s store", (_name, make) => {
  const world = () => {
    const clock = { t: T0 };
    return { store: make(() => clock.t), clock };
  };

  it("keeps a string, and writes one only-if-absent without replacing what is there", async () => {
    const { store } = world();
    expect(await store.get("since")).toBeNull();
    expect(await store.set("since", "100", { ifAbsent: true })).toBe(true);
    expect(await store.set("since", "200", { ifAbsent: true })).toBe(true); // it ran; it just didn't replace
    expect(await store.get("since")).toBe("100");
    expect(await store.set("since", "300")).toBe(true);
    expect(await store.get("since")).toBe("300");
  });

  it("keeps a hash: fields set, set once, and counted up from nothing", async () => {
    const { store } = world();
    expect(await store.hgetall("user:a")).toEqual({}); // read, and empty: not null
    await store.hset("user:a", { firstSeen: "1" }, { ifAbsent: true });
    await store.hset("user:a", { firstSeen: "2", accountId: "aa" }, { ifAbsent: true });
    await store.hset("user:a", { lastSeen: "5", accountId: "bb" });
    await store.hincrby("user:a", "sessions");
    await store.hincrby("user:a", "sessions", 2);
    expect(await store.hgetall("user:a")).toEqual({ firstSeen: "1", accountId: "bb", lastSeen: "5", sessions: "3" });
    expect(await store.hset("user:a", {})).toBe(true);
  });

  it("keeps a sorted set: ranked both ways, counted by score, pruned by score, and never moved by an only-if-absent add", async () => {
    const { store } = world();
    expect(await store.zrange("users", 0, -1)).toEqual([]);
    expect(await store.zcount("users", "-inf", "+inf")).toBe(0);
    await store.zadd("users", 30, "carol");
    await store.zadd("users", 10, "alice");
    await store.zadd("users", 20, "bob");
    await store.zadd("users", 99, "alice", { ifAbsent: true }); // alice keeps 10
    expect(await store.zrange("users", 0, -1)).toEqual(["alice", "bob", "carol"]);
    expect(await store.zrange("users", 0, 1, { rev: true })).toEqual(["carol", "bob"]);
    expect(await store.zcount("users", 20, "+inf")).toBe(2);
    expect(await store.zcount("users", "-inf", 10)).toBe(1);
    await store.zadd("users", 40, "alice"); // a plain add does move it
    expect(await store.zrange("users", 0, 0, { rev: true })).toEqual(["alice"]);
    expect(await store.zremrangebyscore("users", "-inf", 25)).toBe(true);
    expect(await store.zrange("users", 0, -1)).toEqual(["carol", "alice"]);
  });

  it("counts distinct members, in one HyperLogLog or across several", async () => {
    const { store } = world();
    expect(await store.pfcount("d:1")).toBe(0);
    await store.pfadd("d:1", "x", "y");
    await store.pfadd("d:1", "x");
    await store.pfadd("d:2", "y", "z");
    expect(await store.pfcount("d:1")).toBe(2);
    expect(await store.pfcount("d:1", "d:2", "d:none")).toBe(3);
    expect(await store.pfcount()).toBeNull(); // nothing was asked, so nothing is known
  });

  it("forgets a key when its time is up", async () => {
    const { store, clock } = world();
    await store.hincrby("day", "visit");
    expect(await store.expire("day", 60)).toBe(true);
    expect(await store.expire("nothing-here", 60)).toBe(true); // it ran
    clock.t += 59_000;
    expect(await store.hgetall("day")).toEqual({ visit: "1" });
    clock.t += 2_000;
    expect(await store.hgetall("day")).toEqual({});
  });

  it("answers false or null, and never throws, for a command Redis refuses", async () => {
    const { store } = world();
    await store.set("plain", "text");
    expect(await store.hincrby("plain", "n")).toBe(false);
    expect(await store.hgetall("plain")).toBeNull();
    expect(await store.zcount("plain", "-inf", "+inf")).toBeNull();
    expect(await store.pfadd("plain", "x")).toBe(false);
    expect(await store.get("plain")).toBe("text");
  });
});

describe("the store when it is off", () => {
  it("skips every write and answers null to every read", async () => {
    const s = offStore();
    expect(s.kind).toBe("off");
    expect(await Promise.all([s.set("a", "1"), s.hset("h", { f: "v" }), s.hincrby("h", "n"), s.zadd("z", 1, "m"), s.zremrangebyscore("z", 0, 1), s.pfadd("p", "m"), s.expire("a", 1)])).toEqual(Array(7).fill(false));
    expect(await Promise.all([s.get("a"), s.hgetall("h"), s.zrange("z", 0, -1), s.zcount("z", "-inf", "+inf"), s.pfcount("p")])).toEqual(Array(5).fill(null));
  });
});

describe("the file store", () => {
  it("is still there after a restart, expiries included", async () => {
    const path = join(tmp(), "nested", "store.json");
    const clock = { t: T0 };
    const a = fileStore(path, { now: () => clock.t });
    await Promise.all([a.set("since", "1"), a.hset("user:x", { callsign: "ROOK" }), a.zadd("users", 5, "x"), a.pfadd("devices", "d1", "d2"), a.hincrby("day", "visit")]);
    await a.expire("day", 60);
    await a.flushed();
    expect(JSON.parse(readFileSync(path, "utf8")).v).toBe(1);

    const b = fileStore(path, { now: () => clock.t });
    expect(await b.get("since")).toBe("1");
    expect(await b.hgetall("user:x")).toEqual({ callsign: "ROOK" });
    expect(await b.zrange("users", 0, -1)).toEqual(["x"]);
    expect(await b.pfcount("devices")).toBe(2);
    expect(await b.hgetall("day")).toEqual({ visit: "1" });
    clock.t += 61_000;
    expect(await fileStore(path, { now: () => clock.t }).hgetall("day")).toEqual({});
  });

  it("sets a file it can't read aside and starts empty, saying so once", async () => {
    const path = join(tmp(), "store.json");
    writeFileSync(path, "{ not json");
    const logs: string[] = [];
    const s = fileStore(path, { log: (l) => logs.push(l) });
    expect(await s.get("since")).toBeNull();
    expect(existsSync(`${path}.bad`)).toBe(true);
    expect(logs).toHaveLength(1);
    await s.set("since", "1");
    await s.flushed();
    expect(await fileStore(path).get("since")).toBe("1");
  });

  it("goes on in memory, without throwing, when it can't write", async () => {
    const dir = tmp();
    writeFileSync(join(dir, "a-file"), "x");
    const logs: string[] = [];
    const s = fileStore(join(dir, "a-file", "store.json"), { log: (l) => logs.push(l) });
    expect(await s.set("since", "1")).toBe(true);
    await s.set("other", "2");
    await s.flushed();
    expect(await s.get("since")).toBe("1");
    expect(logs.filter((l) => l.includes("couldn't write"))).toHaveLength(1);
  });
});

describe("the Upstash store", () => {
  const store = (doFetch: typeof fetch, extra: { timeoutMs?: number; log?: (l: string) => void; prefix?: string; now?: () => number } = {}) =>
    upstashStore({ url: `${URL_}/`, token: TOKEN }, { fetch: doFetch, log: () => {}, ...extra });

  it("sends commands issued together as one authorised POST to /pipeline, under the key prefix", async () => {
    const up = fakeUpstash();
    const s = store(up.fetch, { prefix: "saltline:" });
    const [a, b, c] = await Promise.all([s.hincrby("m:day:2027-01-15", "visit"), s.pfadd("m:day:2027-01-15:devices", "abc"), s.zcount("m:online", 5, "+inf")]);
    expect([a, b, c]).toEqual([true, true, 0]);
    expect(up.requests).toEqual([
      {
        url: `${URL_}/pipeline`,
        auth: `Bearer ${TOKEN}`,
        commands: [
          ["HINCRBY", "saltline:m:day:2027-01-15", "visit", 1],
          ["PFADD", "saltline:m:day:2027-01-15:devices", "abc"],
          ["ZCOUNT", "saltline:m:online", 5, "+inf"],
        ],
      },
    ]);
    await s.get("m:since"); // a later turn is a later request
    expect(up.requests).toHaveLength(2);
  });

  it("splits a very large batch across requests and still answers each command", async () => {
    const up = fakeUpstash();
    const s = store(up.fetch);
    const done = await Promise.all(Array.from({ length: 230 }, (_, i) => s.pfadd("big", `m${i}`)));
    expect(done.every(Boolean)).toBe(true);
    expect(up.requests.map((r) => r.commands.length)).toEqual([100, 100, 30]);
    expect(await s.pfcount("big")).toBe(230);
  });

  it("reads a hash whether Redis answers it as a flat list or as a map", async () => {
    const flat = store((async () => json(200, [{ result: ["a", "1", "b", "2"] }])) as unknown as typeof fetch);
    const map = store((async () => json(200, [{ result: { a: "1", b: "2" } }])) as unknown as typeof fetch);
    expect(await flat.hgetall("h")).toEqual({ a: "1", b: "2" });
    expect(await map.hgetall("h")).toEqual({ a: "1", b: "2" });
  });

  it("fails one refused command alone", async () => {
    const up = fakeUpstash();
    const s = store(up.fetch);
    await s.set("plain", "text");
    expect(await Promise.all([s.hincrby("plain", "n"), s.hincrby("day", "visit"), s.get("plain")])).toEqual([false, true, "text"]);
  });

  const failing: [string, typeof fetch][] = [
    ["a refused token (401)", (async () => json(401, { error: "Unauthorized" })) as unknown as typeof fetch],
    ["a server error (500)", (async () => new Response("oops", { status: 500 })) as unknown as typeof fetch],
    ["no connection", (async () => Promise.reject(new TypeError(`fetch failed for ${URL_} with ${TOKEN}`))) as unknown as typeof fetch],
    ["an answer that isn't JSON", (async () => new Response("<html>", { status: 200 })) as unknown as typeof fetch],
    ["an answer of the wrong shape", (async () => json(200, { result: "OK" })) as unknown as typeof fetch],
    ["too few answers", (async () => json(200, [])) as unknown as typeof fetch],
    ["answers that are not results", (async () => json(200, [5])) as unknown as typeof fetch],
  ];
  it.each(failing)("answers unknown, not zero, and never throws on %s", async (_what, doFetch) => {
    const logs: string[] = [];
    const s = store(doFetch, { log: (l) => logs.push(l) });
    expect(await s.hincrby("day", "visit")).toBe(false);
    expect(await s.get("since")).toBeNull();
    expect(await s.hgetall("day")).toBeNull();
    expect(await s.zrange("users", 0, -1)).toBeNull();
    expect(await s.zcount("users", "-inf", "+inf")).toBeNull();
    expect(await s.pfcount("devices")).toBeNull();
    // Whatever went wrong is said once a minute at most, and never with the address or the token.
    expect(logs.length).toBeLessThanOrEqual(1);
    expect(logs.join("\n")).not.toContain(TOKEN);
    expect(logs.join("\n")).not.toContain("fine-koi");
  });

  it("gives up on a request that takes too long, and cancels it", async () => {
    let signal: AbortSignal | undefined;
    const hang = ((_u: string, init?: RequestInit) => ((signal = init?.signal ?? undefined), new Promise<Response>(() => {}))) as unknown as typeof fetch;
    const logs: string[] = [];
    const s = store(hang, { timeoutMs: 20, log: (l) => logs.push(l) });
    const began = Date.now();
    expect(await Promise.all([s.hincrby("day", "visit"), s.pfcount("devices")])).toEqual([false, null]);
    expect(Date.now() - began).toBeLessThan(1000);
    expect(signal?.aborted).toBe(true);
    expect(logs).toEqual(['[store] upstash: a request failed {"why":"timeout"}']);
  });

  it("says a failing database is failing once a minute, not once a request", async () => {
    const clock = { t: T0 };
    const logs: string[] = [];
    const s = store((async () => new Response("", { status: 503 })) as unknown as typeof fetch, { log: (l) => logs.push(l), now: () => clock.t });
    for (let i = 0; i < 5; i++) await s.get("since");
    expect(logs).toEqual(['[store] upstash: a request failed {"why":"http 503"}']);
    clock.t += 61_000;
    await s.get("since");
    expect(logs).toHaveLength(2);
  });
});

describe("which store a deployment uses", () => {
  it("is off with nothing set, and Upstash with either pair of names", () => {
    expect(storeConfig({})).toEqual({ kind: "off", problems: [] });
    expect(storeConfig({ UPSTASH_REDIS_REST_URL: `${URL_}/`, UPSTASH_REDIS_REST_TOKEN: TOKEN })).toEqual({ kind: "upstash", url: URL_, token: TOKEN });
    expect(storeConfig({ KV_REST_API_URL: URL_, KV_REST_API_TOKEN: TOKEN })).toEqual({ kind: "upstash", url: URL_, token: TOKEN });
    expect(storeConfig({ SALTLINE_STORE: "upstash", UPSTASH_REDIS_REST_URL: "http://127.0.0.1:8079", UPSTASH_REDIS_REST_TOKEN: TOKEN })).toEqual({ kind: "upstash", url: "http://127.0.0.1:8079", token: TOKEN });
  });

  it("is off, naming what is wrong and never its value, when the settings are half there or malformed", () => {
    expect(storeConfig({ UPSTASH_REDIS_REST_URL: URL_ })).toEqual({ kind: "off", problems: ["UPSTASH_REDIS_REST_TOKEN"] });
    expect(storeConfig({ KV_REST_API_TOKEN: TOKEN })).toEqual({ kind: "off", problems: ["UPSTASH_REDIS_REST_URL"] });
    for (const bad of ["http://fine-koi.upstash.example", "not a url", `${URL_}?_token=${TOKEN}`, `https://user:${TOKEN}@fine-koi.upstash.example`, "redis://fine-koi.upstash.example:6379"]) {
      const cfg = storeConfig({ UPSTASH_REDIS_REST_URL: bad, UPSTASH_REDIS_REST_TOKEN: TOKEN });
      expect(cfg).toEqual({ kind: "off", problems: ["UPSTASH_REDIS_REST_URL"] });
      expect(JSON.stringify(cfg)).not.toContain(TOKEN);
    }
    expect(storeConfig({ UPSTASH_REDIS_REST_URL: URL_, UPSTASH_REDIS_REST_TOKEN: "two words" })).toEqual({ kind: "off", problems: ["UPSTASH_REDIS_REST_TOKEN"] });
  });

  it("SALTLINE_STORE picks the file or off on purpose, and anything else is off", () => {
    const pair = { UPSTASH_REDIS_REST_URL: URL_, UPSTASH_REDIS_REST_TOKEN: TOKEN };
    expect(storeConfig({ ...pair, SALTLINE_STORE: "off" })).toEqual({ kind: "off", problems: [] });
    const file = storeConfig({ ...pair, SALTLINE_STORE: "file" });
    expect(file.kind === "file" && file.path.endsWith(LOCAL_STORE_FILE)).toBe(true);
    expect(storeConfig({ SALTLINE_STORE: "file", VERCEL: "1" })).toEqual({ kind: "off", problems: ["SALTLINE_STORE"] });
    expect(storeConfig({ ...pair, SALTLINE_STORE: "postgres" })).toEqual({ kind: "off", problems: ["SALTLINE_STORE"] });
    expect(storeConfig({ SALTLINE_STORE: "upstash" })).toEqual({ kind: "off", problems: ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"] });
  });

  it("storeFor keeps one store per server instance and says what is misconfigured by name", async () => {
    const logs: string[] = [];
    const env = { UPSTASH_REDIS_REST_URL: URL_, UPSTASH_REDIS_REST_TOKEN: TOKEN };
    const a = storeFor(env, (l) => logs.push(l));
    expect(a.kind).toBe("upstash");
    expect(storeFor({ ...env }, (l) => logs.push(l))).toBe(a);
    expect(logs).toEqual([]);

    const off = storeFor({ UPSTASH_REDIS_REST_URL: URL_ }, (l) => logs.push(l));
    expect(off.kind).toBe("off");
    expect(await off.get("since")).toBeNull();
    expect(logs).toEqual(['[store] off: not configured {"problems":["UPSTASH_REDIS_REST_TOKEN"]}']);
    expect(storeFor({}, (l) => logs.push(l)).kind).toBe("off");
    expect(logs).toHaveLength(1);
  });

  it("keeps previews and local Vercel runs out of production's keys", () => {
    expect(keyPrefix({})).toBe("saltline:");
    expect(keyPrefix({ VERCEL_ENV: "production" })).toBe("saltline:");
    expect(keyPrefix({ VERCEL_ENV: "preview" })).toBe("saltline:preview:");
    expect(keyPrefix({ VERCEL_ENV: "development" })).toBe("saltline:development:");
  });
});

describe("quietly: the time-box for a request's side jobs", () => {
  it("says whether the job finished, swallows what it throws, and stops waiting when its time is up", async () => {
    expect(await quietly(async () => 1, 50)).toBe(true);
    expect(
      await quietly(async () => {
        throw new Error("the database is on fire");
      }, 50),
    ).toBe(false);
    expect(await quietly(() => Promise.reject(new Error("no")), 50)).toBe(false);
    expect(
      await quietly(() => {
        throw new Error("thrown before any promise");
      }, 50),
    ).toBe(false);
    const began = Date.now();
    expect(await quietly(() => new Promise(() => {}), 20)).toBe(false);
    expect(Date.now() - began).toBeLessThan(1000);
  });
});
