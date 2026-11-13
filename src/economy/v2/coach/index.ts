// The coach: a first raid taught by doing, one thing at a time, at the moment it matters (docs/GAME.md → The loop).
//
// - The rifle comes out of a crate. Every v2 raid starts with empty hands at the drop point: the rifle lies in an
//   open crate two metres ahead, and holding E there (a target in the raid's own interaction slot, like a seal)
//   brings it up into the player's hands. Until then nothing fires. On a retry after a death it is taken at the press.
// - The first raid's checklist: a small panel under the objective, one line lit at a time, each ticked when the
//   player does the thing (checklist.ts). It leaves when the raid ends and never returns after a first raid reaches
//   the boat, unless HOW TO PLAY on the title turns it back on.
// - Four moments outside the list, each said once, ever: the first Bailiff, the first wreck in sight, the first
//   death's card, the first debrief.
//
// It never pauses the game and never holds the raid up: every handler is guarded, and anything that fails here
// puts the rifle in the player's hands and gets out of the way.
import { INVOICE } from "../items";
import type { RaidApi, YardTarget } from "../raid";
import { deathBy } from "../raid/rules";
import type { Weapon } from "../types";
import { Checklist, loadCoach, saveCoach, type CoachMemory } from "./checklist";
import { MOMENT, PANEL, crateGun, deathLine, deviceOf, firstLine, stepLine, type Device, type MomentId, type StepId } from "./copy";
import { createCrateWorld, placeCrate, type CratePlace, type CrateWorld } from "./crate";
import { createCoachHud, type CoachHud, type PanelView } from "./hud";

/* eslint-disable @typescript-eslint/no-explicit-any -- the game context is the untyped bundle's G */
type Game = any;
type Store = Pick<Storage, "getItem" | "setItem">;

/** Seconds E is held at the crate. */
export const TAKE_SECONDS = 0.6;
/** Seconds the rifle takes to come up. */
const DRAW_SECONDS = 0.6;
/** Control's line for the rifle is never said in a raid's first seconds: the fence's greeting has the radio then. */
const FIRST_LINE_AFTER = 1.2;
/** Seconds a once-ever moment stays on the panel. */
const MOMENT_SECONDS = 8;
/** Seconds the panel stays dim after a hit. */
const DIM_SECONDS = 2.5;
/** A wreck is "seen" inside this many metres, ahead of the player and in the open. */
const WRECK_SIGHT = 14;
/** A frame's step longer than this (m) is a fall, a respawn or a test's teleport, not walking. */
const STRIDE = 1.5;

export interface CoachOptions {
  world?: CrateWorld;
  hud?: CoachHud;
  /** localStorage by default; null remembers for this page only. */
  store?: Store | null;
  /** The film lane's DROP.crate, when that module is in the build. */
  drop?: unknown;
  now?: () => number;
}

export interface Coach {
  readonly state: {
    /** The rifle is in the player's hands (always true outside a raid). */
    armed: boolean;
    /** This raid is being coached. */
    coached: boolean;
    step: StepId | null;
    ticked: boolean;
    /** What the panel reads. */
    text: string;
    moment: MomentId | null;
    /** The crate hands the rifle over at the press (a retry after a death). */
    instant: boolean;
    crate: CratePlace | null;
    /** A first raid has been completed: no checklist. */
    done: boolean;
    seen: MomentId[];
  };
  /** Hands the rifle over now, as holding E at the crate does. */
  take(): void;
  /** The title's HOW TO PLAY: turns the checklist on for the next raid, or off again. */
  howToPlay(): void;
  /** The film lane's DROP.crate arrived (its module is loaded after the game has booted). */
  setDrop(drop: unknown): void;
  update(dt: number): void;
  dispose(): void;
}

interface Run {
  armed: boolean;
  instant: boolean;
  place: CratePlace;
  gun: Weapon | null;
  /** Takes the crate back out of the raid's slot. */
  undo: (() => void) | null;
  /** Seconds since the rifle was taken, while it is still coming up. */
  draw: number | null;
  bolt: boolean;
  /** Seconds this raid has been in play. */
  played: number;
  /** Control's line for the rifle, until it is on the radio. */
  say: string | null;
  list: Checklist | null;
  ended: boolean;
  last: { x: number; z: number } | null;
  poll: number;
  grabs: number[];
}

const defaultStore = (): Store | null => {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
};
/** The rifle's rise: fast out of the crate, a little past level, settling. */
const rise = (t: number) => {
  const u = Math.max(0, Math.min(1, t)) - 1;
  return 1 + 2.2 * u * u * u + 1.2 * u * u;
};

export function createCoach(G: Game, opts: CoachOptions = {}): Coach {
  const ext = (G.ext ??= { speedScale: 1, gear: {} });
  const now = opts.now ?? (() => performance.now());
  const store = opts.store === undefined ? defaultStore() : opts.store;
  const memory: CoachMemory = loadCoach(store);
  let drop = opts.drop;
  let run: Run | null = null;
  let diedLast = false;
  let moment: { id: "bailiff" | "wreck"; left: number } | null = null;
  let due: ("bailiff" | "wreck")[] = [];
  let dimUntil = 0;
  let debriefDue = false;
  let broken = false;

  const warned = new Set<string>();
  /** Runs a piece of the coach. If it throws, the player gets the rifle and the raid plays on without us. */
  function guard<T>(where: string, fn: () => T): T | undefined {
    try {
      return fn();
    } catch (e) {
      if (!warned.has(where)) (warned.add(where), console.warn(`[coach] ${where} failed; the raid plays on`, e));
      broken = true;
      handOver();
      return undefined;
    }
  }
  const quiet = (fn: () => void) => {
    try {
      fn();
    } catch {
      /* a nicety (a sound, a class): never worth stopping for */
    }
  };

  const world: CrateWorld = opts.world ?? createCrateWorld(G);
  const hud: CoachHud = opts.hud ?? createCoachHud(G, () => api.howToPlay());
  const raid = (): RaidApi | null => (G.raid && typeof G.raid.addTarget === "function" ? (G.raid as RaidApi) : null);
  const device = (): Device => deviceOf(G.input);
  const save = () => saveCoach(store, memory);
  const seen = (id: MomentId) => memory.seen.includes(id);
  const see = (id: MomentId) => {
    if (!seen(id)) (memory.seen.push(id), save());
  };

  // ---- the rifle ----
  /** The shooter's own state for empty hands: nothing drawn, nothing fires, no sights (game.js `// ext:` hooks). */
  function hands(empty: boolean) {
    ext.unarmed = empty;
    ext.draw = empty ? 1 : 0;
    const w = G.weapon;
    if (w?.debug) w.debug.noFire = empty;
    if (typeof w?.setVisible === "function") w.setVisible(!empty);
    quiet(() => hud.unarmed(empty));
  }
  /** The plain way out: the rifle is in the player's hands with no ceremony, whatever state the coach was in. */
  function handOver() {
    ext.unarmed = false;
    ext.draw = 0;
    quiet(() => {
      const st = G.game?.state;
      if (G.weapon?.debug) G.weapon.debug.noFire = false;
      if ((st === "playing" || st === "intro" || st === "paused") && typeof G.weapon?.setVisible === "function") G.weapon.setVisible(true);
    });
    const r = run;
    if (r) {
      r.armed = true;
      r.draw = null;
      const undo = r.undo;
      r.undo = null;
      if (undo) quiet(undo);
    }
    quiet(() => hud.unarmed(false));
    quiet(() => hud.show(null));
    quiet(() => hud.pointInvoice(false));
    quiet(() => world.take());
  }

  function take() {
    const r = run;
    if (!r || r.armed || r.ended) return;
    r.armed = true;
    r.undo?.();
    r.undo = null;
    hands(false);
    ext.draw = 1; // it starts below the frame and comes up over DRAW_SECONDS (update)
    if (G.weapon?.debug) G.weapon.debug.noFire = true;
    r.draw = 0;
    r.bolt = false;
    quiet(() => G.weapon?.snap?.());
    world.take();
    // The latch, then steel on steel as it clears the crate; the bolt goes home as it comes level (update).
    quiet(() => G.audio?.play?.("ui_click", { gain: 0.9, pitch: 0.62 }));
    quiet(() => G.audio?.play?.("reload_magin", { gain: 0.95, pitch: 0.88 }));
    quiet(() => G.player?.addShake?.(0.06));
    r.say = firstLine(r.gun);
    r.list?.did("rifle");
  }

  // ---- a run ----
  function startRun() {
    endRun();
    quiet(() => (hud.deathCard(null), hud.debrief(false)));
    debriefDue = false;
    moment = null;
    due = [];
    dimUntil = 0;
    const slot = raid();
    if (broken || !slot) return; // no slot to take it from: the raid starts armed, as it always did
    const state = slot.state;
    const gun = state.gun ?? null;
    const place = placeCrate(G.level?.playerStart, drop, (x, z) => {
      const y = Number(G.physics?.groundHeight?.(x, z, 1));
      return Number.isFinite(y) && Math.abs(y) < 1.5 ? y : 0;
    });
    const instant = diedLast;
    const list = memory.done ? null : new Checklist(memory.taught, (id) => (memory.taught.includes(id) || memory.taught.push(id), save()));
    list?.begin({ signed: state.mode === "signed", device: device() });
    run = { armed: false, instant, place, gun, undo: null, draw: null, bolt: false, played: 0, say: null, list, ended: false, last: null, poll: 0, grabs: [] };
    world.build(place, crateGun(gun));
    hands(true);
    const target: YardTarget = {
      key: "rifle",
      at: { x: place.x, y: place.y + 0.3, z: place.z },
      verb: "Take the rifle",
      seconds: instant ? 0 : TAKE_SECONDS,
      marker: { short: "RIFLE", label: "Rifle crate" },
      taken: () => guard("take", take),
    };
    run.undo = slot.addTarget(target);
  }

  /** The raid is over (the boat, a death, the title): the panel leaves and nothing of the coach is left in the shooter. */
  function endRun() {
    const r = run;
    if (!r) return;
    r.ended = true;
    r.undo?.();
    r.undo = null;
    r.draw = null;
    ext.unarmed = false;
    ext.draw = 0;
    if (G.weapon?.debug) G.weapon.debug.noFire = false;
    moment = null;
    due = [];
    quiet(() => hud.unarmed(false));
    quiet(() => hud.show(null));
    quiet(() => hud.pointInvoice(false));
    quiet(() => raid()?.lead(false));
  }

  /** A moment is due. It is said once the rifle is in hand and the panel is free: never over another, never to empty hands. */
  function showMoment(id: "bailiff" | "wreck") {
    if (seen(id) || !run || run.ended || due.includes(id)) return;
    due.push(id);
  }
  function nextMoment(r: Run) {
    if (moment || !due.length || !r.armed || r.draw !== null) return;
    const id = due.shift()!;
    see(id);
    moment = { id, left: MOMENT_SECONDS };
  }

  /** The first wreck the player can see: near, ahead of them, with nothing in between. */
  function wreckInSight(targets: readonly { kind: string; at: { x: number; y: number; z: number } }[]): boolean {
    const p = G.player;
    if (!p?.pos) return false;
    const f = p.forward ?? { x: 0, z: -1 };
    const fl = Math.hypot(f.x, f.z) || 1;
    for (const t of targets) {
      if (t.kind !== "wreck") continue;
      const dx = t.at.x - p.pos.x,
        dz = t.at.z - p.pos.z,
        d = Math.hypot(dx, dz);
      if (d > WRECK_SIGHT || (d > 2 && (dx * f.x + dz * f.z) / (d * fl) < 0.55)) continue;
      let clear = true;
      try {
        // To a point a metre short of it and above it: the wreck's own crate is solid, and would hide itself.
        const V = G.THREE?.Vector3;
        const k = Math.max(0, d - 1) / (d || 1);
        if (V && p.eye && typeof G.physics?.lineOfSight === "function") clear = !!G.physics.lineOfSight(p.eye, new V(p.pos.x + dx * k, t.at.y + 0.9, p.pos.z + dz * k));
      } catch {
        clear = true;
      }
      if (clear) return true;
    }
    return false;
  }

  function onDeath() {
    const r = run;
    if (!r || r.ended) return;
    const diedAt = now();
    diedLast = true;
    endRun();
    if (seen("death")) return;
    // The clamp's damage, the death and the Bailiff's own event land in one call: read the grabs after it unwinds.
    queueMicrotask(() =>
      guard("death card", () => {
        hud.deathCard(deathLine(r.gun, deathBy(diedAt, r.grabs)));
        see("death");
      }),
    );
  }

  function onExtract() {
    const r = run;
    if (!r || r.ended) return;
    diedLast = false;
    r.list?.did("boat");
    endRun();
    if (!memory.done) ((memory.done = true), save(), quiet(() => hud.howTo(false)));
    debriefDue = !seen("debrief");
  }

  const offs: (() => void)[] = [];
  const on = (name: string, fn: (e: any) => void) => {
    const off = G.events?.on?.(name, (e: any) => guard(name, () => fn(e)));
    if (typeof off === "function") offs.push(off);
  };
  const live = () => (run && !run.ended ? run : null);
  on("run:start", startRun);
  on("player:dead", onDeath);
  on("extraction:reached", onExtract);
  on("game:state", (e: { state?: string }) => {
    // game.js shows the rifle as a run starts, after run:start: empty hands are put back before a frame is drawn.
    if ((e?.state === "intro" || e?.state === "playing") && run && !run.armed && !run.ended) G.weapon?.setVisible?.(false);
    if (e?.state === "title") {
      endRun();
      world.clear();
      quiet(() => (hud.debrief(false), hud.deathCard(null), hud.howTo(!memory.done)));
      debriefDue = false;
    }
  });
  on("enemy:alert", () => live()?.list?.did("alert"));
  on("enemy:killed", () => live()?.list?.did("kill"));
  on("weapon:reload", (e: { phase?: string }) => e?.phase === "start" && live()?.list?.did("reload"));
  on("weapon:melee", () => live()?.list?.did("kit"));
  on("emp:detonated", () => live()?.list?.did("kit"));
  on("objective:done", (e: { index?: number; total?: number }) => Number(e?.index) >= Number(e?.total ?? 3) && live()?.list?.did("uplinks"));
  on("objective:all", () => live()?.list?.did("uplinks"));
  on("player:hit", () => (dimUntil = now() + DIM_SECONDS * 1000));
  on("bailiff:spawned", () => showMoment("bailiff"));
  on("bailiff:grab", () => live()?.grabs.push(now()));
  guard("title", () => hud.howTo(!memory.done));

  function view(r: Run, dt: number, playing: boolean): PanelView | null {
    const dev = device();
    if (playing) nextMoment(r);
    if (moment) {
      if (playing) moment.left -= dt;
      if (moment.left <= 0) moment = null;
      else return { key: `moment:${moment.id}:${dev}`, kicker: MOMENT[moment.id].kicker, line: MOMENT[moment.id].line(dev), ticked: false, moment: true, pips: null };
    }
    if (!r.list) return null;
    const v = r.list.tick(dt, { device: dev, playing });
    const bailiffAt = Number(G.v2?.raid?.harbormaster?.bailiffAt) || INVOICE.bailiff;
    const line = v.step ? stepLine(v.step, dev, { bailiffAt }) : null;
    if (!v.step || !line) return null;
    return { key: `${v.step}:${dev}`, kicker: PANEL.kicker, line, ticked: v.ticked, moment: false, pips: v.steps.map((s) => s.done) };
  }

  let shownStep: StepId | null = null;
  let shownTicked = false;
  const api: Coach = {
    get state() {
      return {
        armed: !run || run.ended || run.armed,
        coached: !!run && !run.ended && !!run.list,
        step: shownStep,
        ticked: shownTicked,
        text: hud.text,
        moment: moment?.id ?? null,
        instant: !!run && run.instant,
        crate: run ? run.place : null,
        done: memory.done,
        seen: [...memory.seen],
      };
    },
    take: () => void guard("take", take),
    howToPlay() {
      guard("how to play", () => {
        // On for the next raid, with every line to be taught again; pressed again, it is off as it was.
        memory.done = !memory.done;
        if (!memory.done) memory.taught = [];
        save();
        hud.howTo(!memory.done);
      });
    },
    setDrop(d) {
      drop = d;
    },
    update(dt) {
      if (broken) return;
      guard("update", () => {
        const state = G.game?.state;
        if (state !== "paused") world.update(dt);
        // The debrief's pointer waits for the card (and for the dock's own button) to be up.
        if (debriefDue && state === "complete" && G.game?.menus?.screen === "complete" && hud.debrief(true)) ((debriefDue = false), see("debrief"));
        const r = live();
        if (!r) {
          shownStep = null;
          shownTicked = false;
          return;
        }
        const playing = state === "playing";
        if (!r.armed && (state === "playing" || state === "intro") && G.weapon?.root?.visible) G.weapon.setVisible(false);
        if (r.draw !== null && state !== "paused") {
          r.draw += dt;
          const t = r.draw / DRAW_SECONDS;
          ext.draw = Math.max(-0.08, 1 - rise(t));
          if (!r.bolt && t >= 0.55) {
            r.bolt = true;
            quiet(() => G.audio?.play?.("reload_bolt", { gain: 0.9, pitch: 1.05 }));
            quiet(() => G.weapon?.kick?.(0.5, 1.6, 0.4, -1.4));
            if (G.weapon?.debug) G.weapon.debug.noFire = false;
          }
          if (t >= 1) ((r.draw = null), (ext.draw = 0));
        }
        if (playing) {
          r.played += dt;
          // The Harbormaster greets a raid at the fence in its first moment of play: Control's line follows it on
          // the one radio, even when the rifle is snatched up at once (a retry takes it at the press).
          if (r.say && r.played >= FIRST_LINE_AFTER) {
            const line = r.say;
            r.say = null;
            quiet(() => G.hud?.radio?.(line, 4.6));
          }
          const p = G.player?.pos;
          if (p && G.player?.alive !== false) {
            if (r.last) {
              const d = Math.hypot(p.x - r.last.x, p.z - r.last.z);
              if (d < STRIDE) r.list?.walk(d);
            }
            r.last = { x: p.x, z: p.z };
          }
          if ((r.poll -= dt) <= 0) {
            r.poll = 0.2;
            const s = raid()?.state;
            if (s) {
              if (s.opened.length > 0) r.list?.did("seal");
              r.list?.carry(s.weight);
              if (!seen("wreck") && r.armed && wreckInSight(s.targets)) showMoment("wreck");
            }
          }
        }
        const v = view(r, dt, playing);
        shownStep = v && !v.moment ? (v.key.split(":")[0] as StepId) : null;
        shownTicked = !!v && v.ticked;
        hud.show(playing || state === "paused" ? v : null);
        hud.dim(now() < dimUntil || (G.player?.ads ?? 0) > 0.5);
        hud.pointInvoice(playing && shownStep === "invoice" && !shownTicked);
        raid()?.lead(shownStep === "seal" && !shownTicked);
      });
    },
    dispose() {
      for (const off of offs) off();
      endRun();
      quiet(() => world.clear());
      quiet(() => hud.dispose());
      delete ext.unarmed;
      delete ext.draw;
    },
  };
  return api;
}

/** The film lane's module, if it is in this build: it exports where its crate stands as `DROP.crate`. */
const INTRO = import.meta.glob<{ DROP?: { crate?: unknown } }>("../intro/index.ts");

/** Starts the coach beside a booted game (v2/index.ts, after the raid) as G.coach, and drives it on animation frames. */
export function startCoach(G: Game): Coach | null {
  try {
    const c = createCoach(G);
    G.coach = c;
    const load = Object.values(INTRO)[0];
    if (load)
      load().then(
        (m) => c.setDrop(m?.DROP?.crate),
        () => {},
      );
    let last = performance.now();
    const loop = (t: number) => {
      const dt = Math.min(0.05, Math.max(0, (t - last) / 1000));
      last = t;
      c.update(dt);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
    return c;
  } catch (e) {
    console.warn("[coach] off:", e);
    // Whatever stopped it, nobody is left with empty hands.
    try {
      if (G.ext) ((G.ext.unarmed = false), (G.ext.draw = 0));
      if (G.weapon?.debug) G.weapon.debug.noFire = false;
    } catch {
      /* nothing more to undo */
    }
    return null;
  }
}
