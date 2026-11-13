// The story in the game (docs/STORY.md): the opening briefing, the chapter card that opens a run, Control's lines that
// follow the town's arc, the Harbormaster billing the player on its own channel from Chapter 1 (and counting its
// strength in Chapter 3), its extra drones, and the town's lights across the water.
//
// It reads the town through economy.chain.town() (optional: a chain without it is Chapter 1) and the player through
// chain.profile(), and never waits on either: every read has a short timeout, a failed read is unknown, and unknown
// plays as Chapter 1 with no line that needs a number. The shooter never depends on any of it; on any failure the
// game plays on as before.
import "./story.css";
import type { Economy, Profile } from "../types";
import { createBriefing, type Briefing } from "./briefing";
import { createChapterCard, type ChapterCard } from "./card";
import { HARBORMASTER, cleanCallsign, trespassFee } from "./copy";
import { coresSold24h, evidenceLine, harbormasterAwake, invoiceLine, relayLine, runStartLines, type Line } from "./lines";
import { createTownLights, lightsOf, type TownLights } from "./lights";
import { defaultStore, loadMemory, saveMemory } from "./memory";
import { createPacer, type Pacer } from "./pacing";
import { createChannel, type TimedChannel } from "./radio";
import { actOf, bonusOf, createTownReader, type TownRead, type TownReader } from "./town";
import { NO_BONUS, waveBonus } from "./waves";

/* eslint-disable @typescript-eslint/no-explicit-any -- the game context is the untyped bundle's G */
type Game = any;

/** How old a town read may be at a run's start, and how long a fresh one may take. */
const RUN_READ = { maxAge: 15_000, timeout: 2_500 };
/** Between runs and on the title, the far shore and the next run's patrol follow the town at this pace (ms). */
const IDLE_POLL = 60_000;
/** Run-start lines that arrive later than this after the run started are dropped, not said out of place. */
const LATE_MS = 20_000;
const RECENT_LIMIT = 64;
/** How long each kind of Harbormaster line may wait for its turn on the radio (pacing.ts) before it's dropped (ms). */
const WAIT = { runStart: 50_000, seal: 14_000, relay: 16_000, evidence: 14_000, invoice: 25_000 };

export interface Story {
  readonly briefing: Briefing;
  readonly lights: TownLights | null;
  readonly town: TownReader;
  readonly channel: TimedChannel;
  /** The Harbormaster's turn on the radio (pacing.ts). */
  readonly pacer: Pacer;
  readonly card: ChapterCard;
  /** The dock pass callsign once read this session, else null (Control says "Breacher"). */
  readonly callsign: string | null;
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
  const pacer = createPacer({
    now: () => performance.now(),
    busy: () => channel.busy(),
    lastHarbormasterEnd: () => channel.lastHarbormasterEnd(),
    say: (line, seconds) => channel.say(line, seconds),
  });
  const card = createChapterCard();

  const warned = new Set<string>();
  function guard<T>(where: string, fn: () => T): T | undefined {
    try {
      return fn();
    } catch (e) {
      if (!warned.has(where)) (warned.add(where), console.warn(`[story] ${where} failed; the game plays on`, e));
      return undefined;
    }
  }

  // ---- the town across the water ----
  const lights = guard("lights", () => createTownLights(G)) ?? null;
  let lightsSet = false;
  function apply(read: TownRead) {
    const s = lightsOf(read);
    if (s && lights) {
      lights.set(s, !lightsSet); // the first state of a visit is already on; later changes switch on one by one
      lightsSet = true;
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

  // ---- the player: the dock pass callsign (read once a session) and the profile the surcharge is billed from ----
  let callsign: string | null = null;
  const setCallsign = (c: string | null) => {
    if (!c || callsign) return;
    callsign = c;
    ext.callsign = c; // game.js fills Control's {callsign} from it (its `// ext:` hooks), else "Breacher"
  };
  /** The player's profile: null without an account or a pass, undefined when the read failed (unknown). */
  async function readProfile(): Promise<Profile | null | undefined> {
    const id = guard("account", () => economy.wallet?.accountId?.()) ?? null;
    if (!id) return null;
    const p = await Promise.race([
      Promise.resolve()
        .then(() => economy.chain.profile(id))
        .catch(() => undefined),
      new Promise<undefined>((ok) => setTimeout(() => ok(undefined), RUN_READ.timeout)),
    ]);
    if (p === null) return null;
    if (!p || typeof p !== "object") return undefined;
    setCallsign(cleanCallsign(p.callsign));
    return p;
  }
  void readProfile().catch(() => {});

  // ---- a run ----
  let token = 0;
  let runAt = 0;
  let runRead: TownRead | null = null;
  let pending: Line[] | null = null;
  let said: Line[] = [];
  /** Once a run: the seal, relay and evidence lines. */
  let voiced = { seal: false, relay: false, evidence: false };
  /** The carry weight after the last take this run; null before the first. */
  let weight: number | null = null;

  function flush() {
    if (!pending || G.game?.state !== "playing") return;
    const lines = pending;
    pending = null;
    if (performance.now() - runAt > LATE_MS) return;
    // Control's go straight after the game's intro; the Harbormaster's wait their turn (pacing.ts).
    for (const l of lines)
      if (l.who === "harbormaster") pacer.add(l.text, { seconds: 4.6, ttl: WAIT.runStart });
      else channel.say(l, 4.2);
    said = lines;
  }

  async function startRun() {
    const t = ++token;
    runAt = performance.now();
    runRead = null;
    pending = null;
    said = [];
    voiced = { seal: false, relay: false, evidence: false };
    weight = null;
    pacer.clear();
    channel.reset();
    // The chapter card shows half a second into the intro: fill it now from the last read (unknown is Chapter 1),
    // and again below if this run's read lands before it shows.
    guard("card", () => card.set(actOf(town.last)));
    const [read, profile] = await Promise.all([town.read(RUN_READ), readProfile().catch(() => undefined)]);
    if (t !== token) return;
    runRead = read;
    if (!card.showing && G.game?.state === "intro") guard("card", () => card.set(actOf(read)));
    apply(read);
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
    const fee = profile ? trespassFee(profile) : null;
    const out = runStartLines({ read, heard: memory.heard, session, peak: memory.peak, cores24h, callsign, fee });
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
    if (e?.state === "title" || e?.state === "dead") pacer.clear();
    if (e?.state === "title" || e?.state === "complete" || e?.state === "dead") idleRead();
  });
  // The Harbormaster's billing, from Chapter 1. Each line waits its turn (pacing.ts): after Control's own line for
  // the moment, which the game queues right after these events, and never within 8 s of its last line.
  on("objective:done", (e: { index?: number; total?: number }) => {
    if (voiced.relay) return;
    const text = relayLine(e?.index, e?.total);
    if (!text) return;
    voiced.relay = true;
    pacer.add(text, { seconds: 3.8, ttl: WAIT.relay });
  });
  const took = (e: { weight?: number } | undefined, seal: boolean) => {
    const before = weight;
    const after = e && typeof e.weight === "number" && Number.isFinite(e.weight) ? e.weight : null;
    if (after !== null) weight = after;
    // The evidence count says more than the seal: when one take does both, it's the one said.
    const evidence = voiced.evidence ? null : evidenceLine(before, after);
    if (evidence) {
      voiced.evidence = true;
      pacer.add(evidence, { seconds: 4, ttl: WAIT.evidence });
    } else if (seal && !voiced.seal) {
      voiced.seal = true;
      pacer.add(HARBORMASTER.sealCut, { seconds: 4.4, ttl: WAIT.seal });
    }
  };
  on("cargo:taken", (e) => took(e, true));
  on("wreck:found", (e) => took(e, false));
  on("player:dead", () => {
    pacer.clear();
    channel.reset(); // the game clears the radio on a death
  });
  on("extraction:reached", () => {
    pacer.clear(); // the game clears the radio and queues Control's "aboard" line right after this event
    channel.reset();
  });
  // Salvage settles the extraction and tells the debrief's value (salvage/index.ts): the invoice quotes it, and an
  // unknown value says nothing.
  on("run:extracted", (e: { value?: number | null; minted?: Record<string, number> } | undefined) => {
    const cargo = !!e?.minted && Object.values(e.minted).some((n) => typeof n === "number" && n > 0);
    if (cargo && G.game?.state === "complete") pacer.add(invoiceLine(e?.value), { seconds: 4.8, ttl: WAIT.invoice });
  });

  // ---- reads between runs ----
  let idleT = IDLE_POLL / 1000;
  function idleRead() {
    idleT = IDLE_POLL / 1000;
    town.read({ maxAge: 10_000 }).then(
      (r) => {
        const st = G.game?.state;
        if (st === "playing" || st === "intro" || st === "paused") return; // a run took over; its own read rules
        apply(r);
        setBonus(r);
      },
      () => {},
    );
  }
  idleRead();

  return {
    briefing,
    lights,
    town,
    channel,
    pacer,
    card,
    get callsign() {
      return callsign;
    },
    get run() {
      return { read: runRead, lines: said };
    },
    update(dt: number) {
      guard("update", () => {
        const st = G.game?.state;
        if (st === "paused") return;
        if (st === "playing" || st === "complete") pacer.tick();
        lights?.update(dt);
        if (!replayBtn?.isConnected) injectButton();
        if ((st === "title" || st === "complete" || st === "dead") && !document.hidden && (idleT -= dt) <= 0) idleRead();
      });
    },
    dispose() {
      for (const off of offs) off();
      if (ext.beforeRun) delete ext.beforeRun;
      ext.waveBonus = { ...NO_BONUS };
      if (ext.callsign === callsign) delete ext.callsign;
      pacer.clear();
      card.dispose();
      briefing.dispose();
      channel.dispose();
      lights?.dispose();
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
