// The story in the game (docs/STORY.md): the opening briefing, Control's lines that follow the town's arc, the
// Harbormaster's channel from Act III, and its extra drones.
//
// It reads the town through economy.chain.town() (optional: a chain without it is Act I) and never waits on it: every
// read has a short timeout, a failed read is unknown, and unknown plays as Act I with no line that needs a number.
// The shooter never depends on any of it; on any failure the game plays on as before.
import "./story.css";
import type { Economy } from "../types";
import { createBriefing, type Briefing } from "./briefing";
import { HARBORMASTER } from "./copy";
import { coresSold24h, harbormasterAwake, runStartLines, type Line } from "./lines";
import { defaultStore, loadMemory, saveMemory } from "./memory";
import { createChannel, type Channel } from "./radio";
import { bonusOf, createTownReader, type TownRead, type TownReader } from "./town";
import { NO_BONUS, waveBonus } from "./waves";

/* eslint-disable @typescript-eslint/no-explicit-any -- the game context is the untyped bundle's G */
type Game = any;

/** How old a town read may be at a run's start, and how long a fresh one may take. */
const RUN_READ = { maxAge: 15_000, timeout: 2_500 };
/** Between runs and on the title, the next run's patrol follows the town at this pace (ms). */
const IDLE_POLL = 60_000;
/** Run-start lines that arrive later than this after the run started are dropped, not said out of place. */
const LATE_MS = 20_000;
const RECENT_LIMIT = 64;

export interface Story {
  readonly briefing: Briefing;
  readonly town: TownReader;
  readonly channel: Channel;
  /** For tests and screenshots: the read this run plays on. */
  readonly run: { read: TownRead | null; lines: Line[] };
  update(dt: number): void;
  dispose(): void;
}

export function createStory(G: Game, economy: Economy, opts: { store?: Storage | null } = {}): Story {
  const ext = (G.ext ??= { speedScale: 1, gear: {} });
  const store = opts.store === undefined ? defaultStore() : opts.store;
  const memory = loadMemory(store);
  const session: string[] = [];
  const town = createTownReader(economy.chain);
  const channel = createChannel(G);

  const warned = new Set<string>();
  function guard<T>(where: string, fn: () => T): T | undefined {
    try {
      return fn();
    } catch (e) {
      if (!warned.has(where)) (warned.add(where), console.warn(`[story] ${where} failed; the game plays on`, e));
      return undefined;
    }
  }

  // ---- extra drones: game.js reads G.ext.waveBonus for the patrol (at the reset) and each wave ----
  ext.waveBonus = { ...NO_BONUS };
  const setBonus = (read: TownRead | null) => (ext.waveBonus = waveBonus(bonusOf(read)));

  // ---- the briefing ----
  const host = document.getElementById("ui") ?? document.body;
  const app = document.getElementById("app");
  const briefing = createBriefing({
    host,
    seen: () => memory.briefed,
    markSeen: () => {
      if (!memory.briefed) ((memory.briefed = true), saveMemory(store, memory));
    },
    onToggle: (on) => app?.classList.toggle("st-briefing", on),
    onGesture: (run) =>
      guard("lock", () => {
        // A skip that starts the held run is a click or a key: the moment the game can still capture the mouse for it
        // (DEPLOY asked once already, but the dock pass gate may have held that press past its gesture).
        const input = G.input;
        if (run && input && input.mode === "lock" && !input.locked && G.game?.state === "title") input.requestLock?.();
      }),
  });
  ext.beforeRun = (go: () => void) => guard("briefing", () => briefing.beforeRun(go, G.game?.state)) ?? false;

  // BRIEFING gets its own short line under the title's action row, so the row keeps its shape (a fourth button there
  // wraps at laptop widths, and the eyebrow line wraps under the wordmark).
  let replayBtn: HTMLButtonElement | null = null;
  function injectButton() {
    if (replayBtn?.isConnected) return;
    const row = G.game?.menus?.root?.querySelector?.('[data-s="title"] .m-actions') as HTMLElement | null;
    if (!row) return;
    const line = document.createElement("div");
    line.className = "st-replay-line";
    const b = document.createElement("button");
    b.className = "st-replay";
    b.type = "button";
    b.textContent = "Briefing";
    b.setAttribute("aria-label", "Play the briefing");
    b.addEventListener("click", () => briefing.play(() => b.isConnected && b.focus({ preventScroll: true })));
    line.append(b);
    row.after(line);
    replayBtn = b;
  }
  guard("button", injectButton);

  // ---- a run ----
  let token = 0;
  let runAt = 0;
  let runRead: TownRead | null = null;
  let pending: Line[] | null = null;
  let said: Line[] = [];
  let cutSaid = false;
  let cores = 0;

  function flush() {
    if (!pending || G.game?.state !== "playing") return;
    const lines = pending;
    pending = null;
    if (performance.now() - runAt > LATE_MS) return;
    for (const l of lines) channel.say(l, l.who === "harbormaster" ? 4.6 : 4.2);
    said = lines;
  }

  async function startRun() {
    const t = ++token;
    runAt = performance.now();
    runRead = null;
    pending = null;
    said = [];
    cutSaid = false;
    cores = 0;
    channel.reset();
    const read = await town.read(RUN_READ);
    if (t !== token) return;
    runRead = read;
    setBonus(read); // the waves of this run; the patrol already took the last known bonus at the reset
    let cores24h: number | null = null;
    if (harbormasterAwake(read)) {
      const events = await Promise.race([
        Promise.resolve()
          .then(() => economy.chain.recent(RECENT_LIMIT))
          .catch(() => null),
        new Promise<null>((ok) => setTimeout(() => ok(null), RUN_READ.timeout)),
      ]);
      if (t !== token) return;
      cores24h = coresSold24h(events, Date.now(), RECENT_LIMIT);
    }
    const out = runStartLines({ read, heard: memory.heard, session, peak: memory.peak, cores24h });
    for (const id of out.session) session.push(id);
    if (out.heard.length || out.peak !== memory.peak) {
      memory.heard = [...memory.heard, ...out.heard];
      memory.peak = out.peak;
      saveMemory(store, memory);
    }
    pending = out.lines;
    flush();
  }

  const offs: (() => void)[] = [];
  const on = (name: string, fn: (e: any) => void) => {
    const off = G.events?.on?.(name, (e: any) => guard(name, () => fn(e)));
    if (typeof off === "function") offs.push(off);
  };
  on("run:start", () => void startRun().catch((e) => console.warn("[story] run start", e)));
  on("game:state", (e: { state?: string }) => {
    if (e?.state === "playing") flush();
    if (e?.state === "title" || e?.state === "complete" || e?.state === "dead") idleRead();
  });
  on("objective:done", (e: { index?: number; total?: number }) => {
    if (cutSaid || !harbormasterAwake(runRead) || !e || !(Number(e.index) < Number(e.total))) return;
    cutSaid = true;
    // After Control's own line for the cut, which the game queues right after this event.
    queueMicrotask(() => channel.say({ who: "harbormaster", text: HARBORMASTER.relayCut }, 3.8));
  });
  const track = (e: { carried?: { core?: number } }) => {
    const n = e?.carried?.core;
    cores = typeof n === "number" && Number.isFinite(n) ? n : cores;
  };
  on("cargo:taken", track);
  on("wreck:found", track);
  on("player:dead", () => (cores = 0));
  on("extraction:reached", () => {
    if (!(cores > 0) || !harbormasterAwake(runRead)) return;
    // The game clears the radio and queues Control's "aboard" line right after this event: speak after it.
    queueMicrotask(() => channel.say({ who: "harbormaster", text: HARBORMASTER.extractWithCores }, 4.4));
  });

  // ---- reads between runs ----
  let idleT = IDLE_POLL / 1000;
  function idleRead() {
    idleT = IDLE_POLL / 1000;
    town.read({ maxAge: 10_000 }).then(
      (r) => {
        const st = G.game?.state;
        if (st === "playing" || st === "intro" || st === "paused") return; // a run took over; its own read rules
        setBonus(r);
      },
      () => {},
    );
  }
  idleRead();

  return {
    briefing,
    town,
    channel,
    get run() {
      return { read: runRead, lines: said };
    },
    update(dt: number) {
      guard("update", () => {
        if (G.game?.state === "paused") return;
        if (!replayBtn?.isConnected) injectButton();
        const st = G.game?.state;
        if ((st === "title" || st === "complete" || st === "dead") && !document.hidden && (idleT -= dt) <= 0) idleRead();
      });
    },
    dispose() {
      for (const off of offs) off();
      if (ext.beforeRun) delete ext.beforeRun;
      ext.waveBonus = { ...NO_BONUS };
      briefing.dispose();
      channel.dispose();
      replayBtn?.parentElement?.remove();
      app?.classList.remove("st-briefing");
    },
  };
}

/** Starts the story beside a booted game with an economy (main.ts), and drives it on animation frames. */
export function startStory(G: Game): Story | null {
  try {
    const economy: Economy | undefined = G.economy;
    if (!economy) return null; // ?noeconomy: the baseline game
    const s = createStory(G, economy);
    G.story = s;
    let last = performance.now();
    const loop = (now: number) => {
      const dt = Math.min(0.1, Math.max(0, (now - last) / 1000));
      last = now;
      s.update(dt);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
    return s;
  } catch (e) {
    console.warn("[story] off:", e);
    return null;
  }
}
