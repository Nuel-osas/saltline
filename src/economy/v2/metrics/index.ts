// The browser's half of the studio's numbers (server/metrics.ts, docs/DATA.md). It tells the server that someone is
// here and what they did, one small beacon at a time: `{ e: <event>, d: <device id> }` to POST /api/metrics.
//
//   visit            once per tab session, when a person shows up
//   signin           once per tab session, when the sign-in gate opens (login/): sent with the sign-in token, because
//                    the server counts a sign-in only if it can check it
//   pass             once per tab session, the first time the dock opens or a raid is signed: both need a dock pass
//   dock_open        each time the dock opens (not each tab inside it)
//   raid_start       `raid:started`: the contract signed a raid
//   raid_extract     `raid:extracted` with ok: the contract confirmed the extraction
//   raid_death       `raid:died`
//   practice_start   `run:start` in Practice (the offline game), where none of the five above is sent
//   heartbeat        once a minute while the tab is visible: "still here"
//
// **The device id** is 16 random bytes kept in this browser's localStorage. It is made here, from nothing: not from
// the browser's fingerprint, the wallet or the sign-in. The server keeps only a salted hash of it.
//
// **Nothing is sent until a person is there:** the page is visible and has had one trusted input (a real key, click,
// touch or wheel; `isTrusted` is set by the browser and a script's dispatchEvent can't fake it). A headless visit, a
// prerender or a tab opened in the background and never looked at counts for nothing. Until then events wait in a
// short queue.
//
// **It is silent.** Nothing here throws, logs, or waits on an answer, and the game never asks it anything. A beacon is
// a `keepalive` fetch, so the browser finishes it in the background. The server answers 204 to everything; any other
// answer means the endpoint isn't there (the built game on a static host, an older server), and then this stops for
// the rest of the page load instead of asking once a minute. Three sends in a row that never arrive stop it too.
//
// Why fetch and not navigator.sendBeacon: a beacon can't carry the Authorization header a `signin` needs, and it
// can't see the answer. Chrome writes "Failed to load resource" to the console for a beacon that gets a 404 just as
// it does for a fetch (checked in Chrome against `vite preview`, 14 Nov 2026), so only fetch can stop after the first.

/* eslint-disable @typescript-eslint/no-explicit-any -- the game context is the untyped bundle's G */
type Game = any;

export type MetricEvent = "visit" | "signin" | "pass" | "dock_open" | "raid_start" | "raid_extract" | "raid_death" | "practice_start" | "heartbeat";

export interface MetricsOptions {
  /** Where beacons go: metricsUrlFor(the faucet's address). */
  url: string;
  /** True in Practice (the offline mock). */
  offline: boolean;
  /** The sign-in token a `signin` is sent with, or null when nobody is signed in. */
  token?: () => Promise<string | null>;
  /** How often "still here" is said (ms). */
  beatMs?: number;
  // For tests: stand-ins for the browser.
  fetch?: typeof fetch;
  /** Where the device id lives (localStorage). */
  storage?: Pick<Storage, "getItem" | "setItem">;
  /** What this tab session has already sent (sessionStorage). */
  session?: Pick<Storage, "getItem" | "setItem">;
  visible?: () => boolean;
}

export interface Metrics {
  /** True once the page has been visible and had one trusted input. */
  readonly proven: boolean;
  /** Events waiting for that. */
  readonly waiting: number;
  stop(): void;
}

export const DEVICE_STORAGE_KEY = "saltline.device.v1";
export const SENT_STORAGE_KEY = "saltline.metrics.sent.v1";
export const BEAT_MS = 60_000;
/** Events held while nobody has shown up yet. A page does a handful of things before its first input, not hundreds. */
const QUEUE_MAX = 16;
/** Sends in a row that never arrived (offline, blocked) before it stops trying for this page load. */
const MISSES_MAX = 3;
const INPUTS = ["pointerdown", "keydown", "touchstart", "wheel"] as const;

/** `/api/faucet` → `/api/metrics`: the two live side by side. */
export const metricsUrlFor = (faucetUrl: string) => faucetUrl.replace(/faucet(\?.*)?$/, "metrics");

/** This browser's device id: the one it already has, or 16 fresh random bytes. */
export function deviceId(storage: Pick<Storage, "getItem" | "setItem"> | undefined): string {
  try {
    const have = storage?.getItem(DEVICE_STORAGE_KEY);
    if (have && /^[a-f0-9]{32}$/.test(have)) return have;
  } catch {
    // storage refused: this page load gets an id of its own
  }
  const bytes = new Uint8Array(16);
  try {
    crypto.getRandomValues(bytes);
  } catch {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  const id = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  try {
    storage?.setItem(DEVICE_STORAGE_KEY, id);
  } catch {
    // as above
  }
  return id;
}

const browserStorage = (which: "localStorage" | "sessionStorage") => {
  try {
    return globalThis[which];
  } catch {
    return undefined; // some browsers throw on the property itself when storage is blocked
  }
};

export function startMetrics(G: Game, opts: MetricsOptions): Metrics {
  const session = opts.session ?? browserStorage("sessionStorage");
  const visible = opts.visible ?? (() => document.visibilityState === "visible");
  const trusted = (e: Event) => e.isTrusted === true;
  const beatMs = opts.beatMs ?? BEAT_MS;
  const device = deviceId(opts.storage ?? browserStorage("localStorage"));
  let stopped = false;
  let proven = false;
  let input = false;
  let waiting: { event: MetricEvent; once: boolean }[] = [];
  let lastSent = 0;
  let beating = 0;

  /** Never lets anything out of this module: a metrics bug must not be the game's. */
  const safely = (fn: () => void) => {
    try {
      fn();
    } catch {
      // silent
    }
  };

  // ---- what this tab session has already sent (visit, signin, pass are once each) ----
  const sent = new Set<string>();
  safely(() => {
    const had = JSON.parse(session?.getItem(SENT_STORAGE_KEY) ?? "[]");
    if (Array.isArray(had)) for (const e of had) if (typeof e === "string") sent.add(e);
  });
  const remember = (event: string, was: boolean) => {
    if (was) sent.add(event);
    else sent.delete(event);
    safely(() => session?.setItem(SENT_STORAGE_KEY, JSON.stringify([...sent])));
  };

  // ---- sending ----
  let misses = 0;
  function send(event: MetricEvent, token: string | null = null) {
    if (stopped) return;
    lastSent = Date.now();
    const headers: Record<string, string> = { "content-type": "text/plain;charset=UTF-8" };
    if (token) headers.authorization = `Bearer ${token}`;
    let asked: Promise<Response>;
    try {
      asked = Promise.resolve((opts.fetch ?? fetch)(opts.url, { method: "POST", keepalive: true, headers, body: JSON.stringify({ e: event, d: device }) }));
    } catch (e) {
      asked = Promise.reject(e);
    }
    void asked.then(
      (res) => {
        misses = 0;
        if (res.status !== 204) stop(); // not our endpoint
      },
      () => void (++misses >= MISSES_MAX && stop()),
    );
  }
  /** A sign-in goes with its token or not at all: the server counts only what it can check. */
  async function sendSignin() {
    remember("signin", true); // now, so a second "in" while the token is fetched doesn't send twice
    let token: string | null = null;
    try {
      token = (await opts.token?.()) ?? null;
    } catch {
      token = null;
    }
    if (!token) return remember("signin", false); // not sent: the next time the gate opens may have one
    send("signin", token);
  }

  function emit(event: MetricEvent, once: boolean) {
    if (event === "signin") return void sendSignin();
    if (once) remember(event, true);
    send(event);
  }
  function track(event: MetricEvent, once = false) {
    if (stopped) return;
    if (once && (sent.has(event) || waiting.some((w) => w.event === event))) return;
    if (!proven) return void (waiting.length < QUEUE_MAX && waiting.push({ event, once }));
    safely(() => emit(event, once));
  }

  // ---- nothing until a person is there ----
  const beat = () => !stopped && proven && visible() && send("heartbeat");
  function check() {
    if (proven || stopped || !input || !visible()) return;
    proven = true;
    for (const type of INPUTS) window.removeEventListener(type, onInput, true);
    const queued = waiting;
    waiting = [];
    for (const w of queued) safely(() => emit(w.event, w.once));
    if (!queued.length) beat(); // a reload inside the same tab session: nothing new to say but "here"
    beating = window.setInterval(() => safely(beat), beatMs);
  }
  function onInput(e: Event) {
    if (!trusted(e)) return;
    input = true;
    safely(check);
  }
  const onVisibility = () =>
    safely(() => {
      check();
      // Back from another tab after more than a beat: say so now rather than up to a minute from now.
      if (proven && visible() && Date.now() - lastSent >= beatMs) beat();
    });
  for (const type of INPUTS) window.addEventListener(type, onInput, { capture: true, passive: true });
  document.addEventListener("visibilitychange", onVisibility);

  // ---- what the game does (its own events; nothing is asked of it) ----
  const offs: (() => void)[] = [];
  const on = (name: string, fn: (e: any) => void) => {
    const off = G?.events?.on?.(name, (e: unknown) => safely(() => fn(e)));
    if (typeof off === "function") offs.push(off);
  };
  on("login:state", (e) => {
    if (e?.state === "in") track("signin", true);
    else if (e?.state === "out") {
      // Signed out: the next sign-in in this tab is someone signing in again, perhaps someone else.
      remember("signin", false);
      remember("pass", false);
    }
  });
  if (opts.offline) {
    on("run:start", () => track("practice_start"));
  } else {
    let dockOpen = false;
    on("dock:open", () => {
      // The dock tells of every tab change with the same event: one open is counted until it closes.
      if (!dockOpen) track("dock_open");
      dockOpen = true;
      track("pass", true); // the dock only opens for an account that holds a pass
    });
    on("dock:closed", () => void (dockOpen = false));
    on("raid:started", () => {
      track("raid_start");
      track("pass", true); // and the contract only signs a raid for one
    });
    on("raid:extracted", (e) => e?.ok === true && track("raid_extract"));
    on("raid:died", () => track("raid_death"));
  }

  track("visit", true);
  // Started after the gate has already opened (it is started first in v2/index.ts, so this is for anything else).
  safely(() => G?.login?.state?.() === "in" && track("signin", true));

  function stop() {
    stopped = true;
    waiting = [];
    clearInterval(beating);
    for (const type of INPUTS) window.removeEventListener(type, onInput, true);
    document.removeEventListener("visibilitychange", onVisibility);
    for (const off of offs.splice(0)) safely(off);
  }

  const metrics: Metrics = {
    get proven() {
      return proven;
    },
    get waiting() {
      return waiting.length;
    },
    stop,
  };
  if (G) G.metrics = metrics;
  return metrics;
}
