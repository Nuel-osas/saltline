// @vitest-environment happy-dom
// The browser's beacon (src/economy/v2/metrics): what it sends for which of the game's events, that it sends nothing
// until a person is there, and that it stays silent whatever goes wrong. The server's half is in v2-metrics.test.ts,
// and the last test here sends this module's beacons through the real handler to prove the two agree.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readStats } from "../server/counts";
import { handleMetrics, newMetricsLimits } from "../server/metrics";
import { memoryStore } from "../server/store";
import { BEAT_MS, DEVICE_STORAGE_KEY, type Metrics, SENT_STORAGE_KEY, deviceId, metricsUrlFor, startMetrics } from "../src/economy/v2/metrics";

const TOKEN = "tok_" + "a".repeat(40);
const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

function bus() {
  const subs = new Map<string, Set<(e: unknown) => void>>();
  return {
    on(name: string, fn: (e: unknown) => void) {
      if (!subs.has(name)) subs.set(name, new Set());
      subs.get(name)!.add(fn);
      return () => void subs.get(name)!.delete(fn);
    },
    emit(name: string, e?: unknown) {
      for (const fn of [...(subs.get(name) ?? [])]) fn(e);
    },
    count: () => [...subs.values()].reduce((n, s) => n + s.size, 0),
  };
}

function storage(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed));
  return { map, getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v) };
}

/** An input as the browser itself raises one. A script can't make these: here the test stands in for the browser. */
function input(type = "keydown", trusted = true) {
  const e = new Event(type);
  if (trusted) Object.defineProperty(e, "isTrusted", { value: true });
  window.dispatchEvent(e);
}

interface Sent {
  url: string;
  method?: string;
  keepalive?: boolean;
  auth: string | null;
  e: string;
  d: string;
}

interface Opts {
  offline?: boolean;
  token?: () => Promise<string | null>;
  visible?: boolean;
  local?: ReturnType<typeof storage>;
  session?: ReturnType<typeof storage>;
  /** What the server says to the nth beacon (from 0). The default is the real server's 204. */
  answer?: (n: number) => Response | Promise<Response>;
}

const running: Metrics[] = [];
function world(o: Opts = {}) {
  const local = o.local ?? storage();
  const session = o.session ?? storage();
  const sends: Sent[] = [];
  const state = { visible: o.visible ?? true };
  const G: any = { events: bus() };
  const metrics = startMetrics(G, {
    url: "/api/metrics",
    offline: !!o.offline,
    token: o.token ?? (async () => TOKEN),
    fetch: ((url: string, init?: RequestInit) => {
      sends.push({ url, method: init?.method, keepalive: init?.keepalive, auth: new Headers(init?.headers).get("authorization"), ...(JSON.parse(String(init?.body)) as { e: string; d: string }) });
      return Promise.resolve(o.answer ? o.answer(sends.length - 1) : new Response(null, { status: 204 }));
    }) as typeof fetch,
    storage: local,
    session,
    visible: () => state.visible,
  });
  running.push(metrics);
  const sent = () => sends.map((s) => s.e);
  const show = (visible: boolean) => {
    state.visible = visible;
    document.dispatchEvent(new Event("visibilitychange"));
  };
  return { G, metrics, sends, sent, show, local, session, emit: (name: string, e?: unknown) => G.events.emit(name, e) };
}

beforeEach(() => void vi.useFakeTimers());
afterEach(() => {
  for (const m of running.splice(0)) m.stop();
  vi.useRealTimers();
});

describe("nothing is sent until a person is there", () => {
  it("holds everything until the page is visible and has had one trusted input", async () => {
    const w = world();
    w.emit("dock:open", { tab: "loadout" });
    await vi.advanceTimersByTimeAsync(5 * BEAT_MS);
    expect(w.sent()).toEqual([]);
    expect(w.metrics).toMatchObject({ proven: false, waiting: 3 }); // visit, dock_open, pass
    input();
    expect(w.metrics).toMatchObject({ proven: true, waiting: 0 });
    expect(w.sent()).toEqual(["visit", "dock_open", "pass"]);
  });

  it("is not fooled by an input a script made", async () => {
    const w = world();
    for (const type of ["keydown", "pointerdown", "touchstart", "wheel"]) input(type, false);
    await vi.advanceTimersByTimeAsync(3 * BEAT_MS);
    expect(w.sent()).toEqual([]);
    expect(w.metrics.proven).toBe(false);
  });

  it("is not fooled by a hidden page: a background tab or a prerender waits until someone looks at it", async () => {
    const w = world({ visible: false });
    input();
    await vi.advanceTimersByTimeAsync(3 * BEAT_MS);
    expect(w.sent()).toEqual([]);
    w.show(true);
    expect(w.sent()).toEqual(["visit"]);
  });

  it("takes any of a key, a click, a touch or the wheel, and other events don't count", () => {
    for (const type of ["keydown", "pointerdown", "touchstart", "wheel"]) {
      const w = world();
      input(type);
      expect(w.sent()).toEqual(["visit"]);
      w.metrics.stop();
    }
    const w = world();
    for (const type of ["mousemove", "scroll", "focus", "load"]) input(type);
    expect(w.sent()).toEqual([]);
  });

  it("holds only a short queue while it waits", () => {
    const w = world();
    for (let i = 0; i < 100; i++) w.emit("raid:died", { by: "drone" });
    expect(w.metrics.waiting).toBe(16);
    input();
    expect(w.sent()).toHaveLength(16);
  });
});

describe("what it sends", () => {
  it("posts { e, d } to the metrics endpoint with this browser's device id, kept alive, and nothing else", () => {
    const w = world();
    input();
    expect(w.sends).toEqual([{ url: "/api/metrics", method: "POST", keepalive: true, auth: null, e: "visit", d: w.local.map.get(DEVICE_STORAGE_KEY) }]);
    expect(w.sends[0].d).toMatch(/^[a-f0-9]{32}$/);
    expect(metricsUrlFor("/api/faucet")).toBe("/api/metrics");
    expect(metricsUrlFor("https://x.example/api/faucet")).toBe("https://x.example/api/metrics");
  });

  it("keeps one random device id per browser, and makes a fresh one rather than trust a malformed one", () => {
    const local = storage();
    const a = deviceId(local);
    expect(deviceId(local)).toBe(a);
    expect(deviceId(storage())).not.toBe(a);
    expect(deviceId(storage({ [DEVICE_STORAGE_KEY]: "<script>" }))).toMatch(/^[a-f0-9]{32}$/);
    // Storage that refuses still gets an id, good for this page load.
    const refuses = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(deviceId(refuses)).toMatch(/^[a-f0-9]{32}$/);
    expect(deviceId(undefined)).toMatch(/^[a-f0-9]{32}$/);
  });

  it("counts one visit per tab session: a reload says only that someone is still here", () => {
    const local = storage();
    const session = storage();
    const first = world({ local, session });
    input();
    expect(first.sent()).toEqual(["visit"]);
    first.metrics.stop();
    const reloaded = world({ local, session }); // Practice, the way back from Google, the reload onto a new wallet
    input();
    expect(reloaded.sent()).toEqual(["heartbeat"]);
    reloaded.metrics.stop();
    const newTab = world({ local }); // same browser, a new tab: a new visit from the same device
    input();
    expect(newTab.sent()).toEqual(["visit"]);
    expect(newTab.sends[0].d).toBe(first.sends[0].d);
  });

  it("sends a sign-in with its token, once per tab session, and the token with nothing else", async () => {
    const w = world();
    input();
    w.emit("login:state", { state: "checking", who: null });
    w.emit("login:state", { state: "in", who: { id: "did:privy:x", label: "a•e@example.com" } });
    w.emit("login:state", { state: "in", who: { id: "did:privy:x", label: "a•e@example.com" } });
    w.emit("dock:open", { tab: "loadout" });
    await flush();
    expect(w.sends.map((s) => [s.e, s.auth])).toEqual([
      ["visit", null],
      ["dock_open", null],
      ["pass", null],
      ["signin", `Bearer ${TOKEN}`],
    ]);
    expect(JSON.stringify(w.sends.map(({ e, d }) => ({ e, d })))).not.toContain(TOKEN);
  });

  it("sends no sign-in without a token, and tries again the next time the gate opens", async () => {
    let token: string | null = null;
    const w = world({ token: async () => token });
    input();
    w.emit("login:state", { state: "in" });
    await flush();
    expect(w.sent()).toEqual(["visit"]);
    token = TOKEN;
    w.emit("login:state", { state: "in" });
    await flush();
    expect(w.sends.map((s) => [s.e, s.auth])).toEqual([
      ["visit", null],
      ["signin", `Bearer ${TOKEN}`],
    ]);
  });

  it("after a sign-out, the next sign-in in the same tab is sent again", async () => {
    const w = world();
    input();
    w.emit("login:state", { state: "in" });
    await flush();
    w.emit("login:state", { state: "out" });
    w.emit("login:state", { state: "in" });
    await flush();
    expect(w.sent()).toEqual(["visit", "signin", "signin"]);
  });

  it("on chain: the dock, the pass it proves, and a raid's start, extraction and death", () => {
    const w = world();
    input();
    w.emit("dock:open", { tab: "loadout" });
    w.emit("dock:open", { tab: "market" }); // a tab change inside the open dock
    w.emit("dock:closed", {});
    w.emit("dock:open", { tab: "market" });
    w.emit("raid:started", { raidId: 7 });
    w.emit("raid:extracted", { ok: false, invoice: null, arrears: null }); // refused or unconfirmed: not an extraction
    w.emit("raid:extracted", { ok: true, invoice: 120, arrears: 0 });
    w.emit("raid:started", { raidId: 8 });
    w.emit("raid:died", { by: "bailiff", impounded: true });
    w.emit("run:start", { retries: 0 }); // a run is Practice's event; on chain the contract's raid is what counts
    expect(w.sent()).toEqual(["visit", "dock_open", "pass", "dock_open", "raid_start", "raid_extract", "raid_start", "raid_death"]);
  });

  it("says the player holds a pass when a raid is signed, even if the dock was never opened", () => {
    const w = world();
    input();
    w.emit("raid:started", { raidId: 7 });
    w.emit("raid:started", { raidId: 8 });
    expect(w.sent()).toEqual(["visit", "raid_start", "pass", "raid_start"]);
  });

  it("in Practice: a run is a practice start, and the dock and the mock's raids are not reported as real ones", () => {
    const w = world({ offline: true });
    input();
    w.emit("run:start", { retries: 0 });
    w.emit("dock:open", { tab: "loadout" });
    w.emit("raid:started", { raidId: 1 });
    w.emit("raid:extracted", { ok: true });
    w.emit("raid:died", { by: "drone" });
    w.emit("run:start", { retries: 1 });
    expect(w.sent()).toEqual(["visit", "practice_start", "practice_start"]);
  });

  it("says it is still here once a minute while the tab is visible, and at once on coming back", async () => {
    const w = world();
    input();
    await vi.advanceTimersByTimeAsync(BEAT_MS * 2 + 5);
    expect(w.sent()).toEqual(["visit", "heartbeat", "heartbeat"]);
    w.show(false);
    await vi.advanceTimersByTimeAsync(BEAT_MS * 3);
    expect(w.sent()).toHaveLength(3);
    w.show(true);
    expect(w.sent()).toEqual(["visit", "heartbeat", "heartbeat", "heartbeat"]);
  });
});

describe("it is silent", () => {
  it("stops for the page load when the endpoint isn't there, instead of asking a static host once a minute", async () => {
    const w = world({ answer: () => new Response("Not found", { status: 404 }) });
    input();
    await flush();
    w.emit("raid:started", { raidId: 1 });
    w.emit("login:state", { state: "in" });
    await vi.advanceTimersByTimeAsync(BEAT_MS * 5);
    expect(w.sent()).toEqual(["visit"]);
    expect(w.G.events.count()).toBe(0);
  });

  it("stops after three sends in a row that never arrive, and one that arrives starts the count again", async () => {
    const offline = (async () => Promise.reject(new TypeError("offline"))) as unknown as () => Promise<Response>;
    const w = world({ answer: (n) => (n === 2 ? new Response(null, { status: 204 }) : offline()) });
    input(); // 0: lost
    await flush();
    // 1: lost. 2: arrives. 3, 4, 5: lost, three in a row. After that nothing is sent.
    for (let i = 0; i < 8; i++) {
      w.emit("raid:died", {});
      await flush();
    }
    await vi.advanceTimersByTimeAsync(BEAT_MS * 3);
    expect(w.sent()).toEqual(["visit", "raid_death", "raid_death", "raid_death", "raid_death", "raid_death"]);
  });

  it("never throws or logs when sending fails, storage refuses, the token can't be had, or the bus hands it nonsense", async () => {
    const noise = [vi.spyOn(console, "error").mockImplementation(() => {}), vi.spyOn(console, "warn").mockImplementation(() => {}), vi.spyOn(console, "log").mockImplementation(() => {})];
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    const refuses = () => {
      throw new Error("blocked");
    };
    const G: any = { events: bus() };
    const m = startMetrics(G, {
      url: "/api/metrics",
      offline: false,
      fetch: (() => {
        throw new TypeError("fetch itself threw");
      }) as unknown as typeof fetch,
      token: async () => Promise.reject(new Error("privy is down")),
      storage: { getItem: refuses, setItem: refuses },
      session: { getItem: refuses, setItem: refuses },
      visible: () => true,
    });
    running.push(m);
    expect(() => input()).not.toThrow();
    expect(() => {
      G.events.emit("login:state", { state: "in" });
      G.events.emit("login:state", undefined);
      G.events.emit("dock:open", null);
      G.events.emit("raid:extracted", "yes");
      G.events.emit("raid:started", { raidId: 1 });
    }).not.toThrow();
    await vi.advanceTimersByTimeAsync(BEAT_MS * 2);
    await flush();
    for (const spy of noise) expect(spy).not.toHaveBeenCalled();
    expect(unhandled).not.toHaveBeenCalled();
    process.off("unhandledRejection", unhandled);
    vi.restoreAllMocks();
  });

  it("starts with no event bus at all, and stop() takes every listener away", async () => {
    const quiet = { url: "/api/metrics", offline: false, storage: storage(), session: storage(), fetch: (async () => new Response(null, { status: 204 })) as unknown as typeof fetch };
    expect(() => startMetrics({}, quiet).stop()).not.toThrow();
    expect(() => startMetrics(undefined, quiet).stop()).not.toThrow();
    const w = world();
    input();
    expect(w.G.events.count()).toBeGreaterThan(0);
    w.metrics.stop();
    expect(w.G.events.count()).toBe(0);
    w.emit("raid:started", { raidId: 1 });
    input();
    await vi.advanceTimersByTimeAsync(BEAT_MS * 3);
    expect(w.sent()).toEqual(["visit"]);
    expect(w.session.map.get(SENT_STORAGE_KEY)).toBe('["visit"]');
  });
});

describe("the two halves agree", () => {
  it("a session's beacons, sent through the real handler, come out as that session's numbers", async () => {
    vi.useRealTimers();
    const store = memoryStore();
    const limits = newMetricsLimits();
    const env = { METRICS_SALT: "metrics-salt-for-tests-0123456789", PRIVY_APP_ID: "cmtestappid0000000000000a", WALLET_SECRET: "s".repeat(48) };
    const answers: Promise<Response>[] = [];
    const G: any = { events: bus() };
    const m = startMetrics(G, {
      url: "/api/metrics",
      offline: false,
      token: async () => TOKEN,
      storage: storage(),
      session: storage(),
      visible: () => true,
      fetch: ((_url: string, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        headers.set("user-agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36");
        headers.set("x-forwarded-for", "203.0.113.5");
        const answer = handleMetrics(new Request("http://localhost/api/metrics", { method: init?.method, headers, body: init?.body }), env, { store, limits, verify: async () => "did:privy:cmalice000000000000000001" });
        answers.push(answer);
        return answer;
      }) as typeof fetch,
    });
    running.push(m);
    input();
    G.events.emit("login:state", { state: "in" });
    G.events.emit("dock:open", { tab: "loadout" });
    G.events.emit("dock:closed", {});
    G.events.emit("raid:started", { raidId: 1 });
    G.events.emit("raid:died", { by: "drone" });
    G.events.emit("raid:started", { raidId: 2 });
    G.events.emit("raid:extracted", { ok: true });
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
    expect((await Promise.all(answers)).map((r) => r.status)).toEqual(Array(8).fill(204));
    const s = await readStats(store, Date.now());
    expect(s.today).toMatchObject({ visits: 1, devices: 1, signIns: 1, dockOpens: 1, raidsStarted: 2, raidsDied: 1, raidsExtracted: 1, practiceStarts: 0 });
    expect(s.funnel).toEqual({ days: 15, visited: 1, signedIn: 1, gotPass: 1, startedRaid: 1, extracted: 1 });
    expect([s.onlineNow, s.totalUsers]).toEqual([1, 1]);
  });
});
