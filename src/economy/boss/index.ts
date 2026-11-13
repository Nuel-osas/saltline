// The Assessor, Chapter 3's boss (docs/STORY.md → The boss), in the game: it reads the town at each run's start and,
// in Chapter 3, builds the boss the moment the third relay is cut. Two `// ext:` hooks in src/game.js let it work:
//   G.ext.raycast(origin, dir, maxDist)  the player's shots can hit it (combat.playerShot)
//   G.ext.extractBlocked()               the boat won't come in while it stands (the run's boat check)
// A chain without town(), a failed or late read, or Chapters 1–2 leave both hooks inert and the run plays as before.
// Anything here that throws is caught: the shooter never depends on the boss.
import "./boss.css";
import { hooks } from "../hooks";
import type { Economy } from "../types";
import { createChannel, type Channel, type TimedChannel } from "../story/radio";
import { createTownReader, type TownRead, type TownReader } from "../story/town";
import { createBar } from "./bar";
import { createBolts } from "./bolts";
import { LINES, type LineId } from "./copy";
import { createFight, type Fight } from "./fight";
import { createModel } from "./model";
import { MAX_CORES, MIN_CORES, TUNE, assessorFor } from "./rules";
import type { Bar, Body, Bolts } from "./types";

/* eslint-disable @typescript-eslint/no-explicit-any -- the game context is the untyped bundle's G */
type Game = any;

/** A run's town read may be this old, and a fresh one may take this long (the story reads it at the same moment). */
const RUN_READ = { maxAge: 15_000, timeout: 2_500 };
/** Where the boat holds off while the Assessor stands (added to its berth). */
const BOAT_OFF = { x: 20, z: 9 };
const HINT = "The boat will not come in while the Assessor stands";
/**
 * How long each of its lines may wait for the radio to go quiet (ms) before it's dropped as stale. The boss speaks on
 * its own beats, not the billing lines' 8-second pacing (story/pacing.ts), but never over a line that's playing, and
 * it takes the first quiet moment ahead of a waiting bill. The arrival waits longest: the third cut brings Control's
 * lines first, and a run that cut its relays back to back can keep the radio busy for half a minute.
 */
export const VOICE_TTL: Record<LineId, number> = { arrival: 45_000, firstCore: 10_000, lastCore: 8_000, defeat: 8_000, death: 8_000 };

export interface Parts {
  body: Body;
  bolts: Bolts;
  bar: Bar;
}

export interface BossOptions {
  /** Builds the three.js body, its bolts and the HUD bar (tests pass stand-ins). */
  build?: (G: Game, cores: number) => Parts;
  /** The town reader; by default the story's, else one of its own. */
  town?: TownReader;
}

export interface Boss {
  readonly fight: Fight | null;
  /** This run's town read, once it's in. */
  readonly read: TownRead | null;
  /**
   * Stands the Assessor up now with `cores` relay cores, whatever the town says (v2: the invoice reached
   * foreclosure). False if one already stands, the run isn't being played, or it couldn't be built.
   */
  summon(cores: number): boolean;
  /** Removes it and lets the boat back in (the raid is over). */
  dismiss(): void;
  update(dt: number): void;
  dispose(): void;
}

function defaultParts(G: Game, cores: number): Parts {
  const host = G.hud?.root ?? document.getElementById("ui");
  return {
    body: createModel(G, cores, TUNE.arrive.from),
    bolts: createBolts(G),
    bar: createBar(host),
  };
}

/** The dock pass callsign the story puts in G.ext.callsign, or null (the line then says plain "Breacher"). */
export function callsignOf(G: Game): string | null {
  const c = G?.ext?.callsign;
  return typeof c === "string" && c.trim() ? c.trim() : null;
}

/** v2 has no town: every read is "missing", so only summon() ever builds the Assessor. */
const NO_TOWN: TownReader = { last: null, read: async () => ({ status: "missing", at: 0 }) };

export function createBoss(G: Game, economy: Economy | null, opts: BossOptions = {}): Boss {
  G.ext ??= { speedScale: 1, gear: {} };
  const build = opts.build ?? defaultParts;
  const town = opts.town ?? G.story?.town ?? (economy ? createTownReader(economy.chain) : NO_TOWN);
  // One channel for both voices: a second one would relabel the story's lines as Control's (radio.ts).
  const own: Channel | null = G.story?.channel ? null : createChannel(G);
  const channel: Channel & Partial<TimedChannel> = G.story?.channel ?? own!;
  const rng: () => number = (() => {
    try {
      const f = G.rng?.fork?.();
      if (typeof f === "function") return f;
    } catch {
      /* fall through */
    }
    return Math.random;
  })();

  const warned = new Set<string>();
  function guard<T>(where: string, fn: () => T): T | undefined {
    try {
      return fn();
    } catch (e) {
      if (!warned.has(where)) (warned.add(where), console.warn(`[boss] ${where} failed; the game plays on`, e));
      return undefined;
    }
  }

  let token = 0;
  let read: TownRead | null = null;
  let fight: Fight | null = null;
  let hintAt = -1e9;

  function end() {
    voice = [];
    if (!fight) return;
    const f = fight;
    fight = null;
    guard("dispose", () => f.dispose());
  }

  // ---- the hooks ----
  // Registered through the shared registries (../hooks.ts): the Bailiff and the missions' set pieces use them too.
  const offShot = hooks(G).addShotTarget((origin: any, dir: any, max: number) => (fight ? (guard("raycast", () => fight!.raycast(origin, dir, max)) ?? null) : null));
  const offGate = hooks(G).addBoatGate(() => {
    const blocked = !!fight && (guard("blocked", () => fight!.blocked()) ?? false);
    if (blocked && performance.now() - hintAt > 6000) {
      hintAt = performance.now();
      guard("hint", () => G.hud?.message?.(HINT, 3.5));
    }
    return blocked;
  });

  // ---- the boat holds off while it stands ----
  const boat = G.backdrop?.boat ?? null;
  const berth = G.backdrop?.boatBase ?? null;
  let boatOff = 0;
  function moveBoat(dt: number) {
    if (!boat || !berth) return;
    const want = fight ? 1 - fight.boat : 0;
    if (Math.abs(want - boatOff) < 1e-4 && (boatOff === 0 || boatOff === 1)) return;
    const rate = want > boatOff ? 1 / 3.5 : 1 / TUNE.boatIn;
    boatOff = want > boatOff ? Math.min(want, boatOff + rate * dt) : Math.max(want, boatOff - rate * dt * 1.15);
    const k = boatOff * boatOff * (3 - 2 * boatOff);
    boat.position.x = berth.x + BOAT_OFF.x * k;
    boat.position.z = berth.z + BOAT_OFF.z * k;
  }
  function resetBoat() {
    boatOff = 0;
    if (boat && berth) ((boat.position.x = berth.x), (boat.position.z = berth.z));
  }

  // ---- a run ----
  async function startRun() {
    const t = ++token;
    end();
    resetBoat();
    read = null;
    const r = await town.read(RUN_READ);
    if (t !== token) return;
    read = r;
  }

  // ---- its voice: each line waits for a quiet radio, briefly, or is dropped ----
  let voice: { id: LineId; text: string; seconds: number; until: number }[] = [];
  // The HUD drops the box's "on" class the moment its queue runs dry, inside the game's frame; watching for it lets the
  // boss's line in before the story's pacer (which ticks on its own animation frame) fills the gap with a bill.
  let watched: Element | null = null;
  let watcher: MutationObserver | null = null;
  function watchRadio() {
    if (typeof MutationObserver === "undefined" || typeof document === "undefined") return;
    const box = document.querySelector("#ui > .comms") ?? document.querySelector(".comms");
    if (!box || box === watched) return;
    watcher?.disconnect();
    watched = box;
    watcher = new MutationObserver(() => voice.length && guard("speak", speak));
    watcher.observe(box, { attributes: true, attributeFilter: ["class"] });
  }
  function speak() {
    if (!voice.length) return;
    const now = performance.now();
    voice = voice.filter((v) => v.until >= now);
    if (!voice.length || (guard("busy", () => channel.busy?.()) ?? false)) return;
    const next = voice.shift()!;
    guard("say", () => channel.say({ who: "harbormaster", text: next.text }, next.seconds));
  }

  function arrive() {
    const boss = assessorFor(read);
    if (boss) stand(boss.cores);
  }

  /** Builds the Assessor with `cores` cores and starts its walk in. */
  function stand(cores: number): boolean {
    const boss = { cores: Math.max(MIN_CORES, Math.min(MAX_CORES, Math.floor(Number.isFinite(cores) ? cores : MIN_CORES))) };
    if (fight || G.game?.state !== "playing") return false;
    const parts = guard("build", () => build(G, boss.cores));
    if (!parts) return false;
    fight =
      guard("start", () =>
        createFight(
          {
            G,
            ...parts,
            rng,
            say: (text, seconds, id) => {
              // Once it's down, a beat still waiting for the radio is out of date: only the defeat goes out.
              if (id === "defeat") voice = voice.filter((v) => v.id === "death");
              voice.push({ id, text, seconds, until: performance.now() + VOICE_TTL[id] });
              guard("watch", watchRadio);
            },
            sfx: (name, o) => G.audio?.play?.(name, o),
          },
          { cores: boss.cores, callsign: callsignOf(G) },
        ),
      ) ?? null;
    if (!fight) {
      guard("cleanup", () => (parts.body.dispose(), parts.bolts.dispose(), parts.bar.dispose()));
      return false;
    }
    // A full reserve for the fight: the run's rounds went on the drones.
    guard("ammo", () => {
      const w = G.weapon;
      if (w && typeof w.addAmmo === "function" && typeof w.reserve === "number" && w.reserve < TUNE.reserve) w.addAmmo(TUNE.reserve - w.reserve);
    });
    return true;
  }

  const offs: (() => void)[] = [];
  const on = (name: string, fn: (e: any) => void) => {
    const off = G.events?.on?.(name, (e: any) => guard(name, () => fn(e)));
    if (typeof off === "function") offs.push(off);
  };
  on("run:start", () => void startRun().catch((e) => console.warn("[boss] run start", e)));
  // After the game's own reaction to the third cut (Control's line, the objective), so the Assessor speaks second.
  on("objective:all", () => queueMicrotask(() => guard("arrive", arrive)));
  // The game clears the radio on a death; the Harbormaster's condolences go out after that.
  on("player:dead", () => queueMicrotask(() => guard("dead", () => fight?.playerDied())));
  on("game:state", (e: { state?: string }) => {
    if (e?.state === "title") (token++, end(), resetBoat());
  });
  // The defeat line glitches harder than the channel's own flicker.
  on("radio:line", (e: { text?: string }) => {
    const box = document.querySelector<HTMLElement>("#ui > .comms") ?? document.querySelector<HTMLElement>(".comms");
    box?.classList.toggle("as-glitch", !!e && e.text === LINES.defeat);
  });

  return {
    get fight() {
      return fight;
    },
    get read() {
      return read;
    },
    summon: (cores: number) => guard("summon", () => stand(cores)) ?? false,
    dismiss() {
      end();
      resetBoat();
    },
    update(dt: number) {
      const st = G.game?.state;
      if (st === "paused" || st === "title") return;
      if (fight) guard("update", () => fight!.update(dt));
      speak();
      guard("boat", () => moveBoat(dt));
    },
    dispose() {
      token++;
      end();
      resetBoat();
      for (const off of offs) off();
      offShot();
      offGate();
      watcher?.disconnect();
      own?.dispose();
    },
  };
}

/** Starts the boss beside a booted game with an economy (main.ts), and drives it on animation frames. */
export function startBoss(G: Game): Boss | null {
  try {
    const economy: Economy | undefined = G.economy;
    if (!economy) return null; // ?noeconomy: the baseline game
    return drive(G, createBoss(G, economy));
  } catch (e) {
    console.warn("[boss] off:", e);
    return null;
  }
}

/**
 * Starts the Assessor for v2 (src/economy/v2/raid), which has no town to read: it stands only when summoned
 * (`G.boss.summon(cores)`, at foreclosure).
 */
export function startAssessor(G: Game): Boss | null {
  try {
    return drive(G, createBoss(G, null));
  } catch (e) {
    console.warn("[boss] off:", e);
    return null;
  }
}

function drive(G: Game, b: Boss): Boss {
  G.boss = b;
  let last = performance.now();
  const loop = (now: number) => {
    const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
    last = now;
    b.update(dt);
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  return b;
}
