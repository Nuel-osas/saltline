// The score (docs/CAMPAIGN.md → The score): music synthesized in the browser that follows the game. state.ts decides
// which state plays from the game's events, theme.ts is the notes, engine.ts plays them; this file joins them to the
// game: its events, its audio context, its music bus and its volume.
//
// Sound goes into the game's own `music` bus (G.audio.ext.music, a `// ext:` hook in game.js), so it sits behind the
// game's master volume, its pause dip, the duck it already does under gunfire, and its master compressor. Without
// that hook it plays straight to the context's output, scaled by the master volume as the Dockside's chimes are.
//
// The baseline game has its own music: five baked loops mixed by intensity (game.js: music_drone … music_motif).
// Two scores at once is mud, so while this one runs it fades those loops out through a gain of its own, and lets
// them back in if it is disposed. `?noscore` leaves the baseline's music alone and starts nothing here.
import type { ScoreApi, ScoreState } from "../campaign/types";
import { gameMuted, gameVolume } from "../dockside/sound";
import { TIMER } from "./clock";
import { type Engine, createEngine } from "./engine";
import { EVENTS, type Reading, audible, createDirector, radioSeconds } from "./state";

/* eslint-disable @typescript-eslint/no-explicit-any -- the game context is the untyped bundle's G */
type Game = any;

export interface Score extends ScoreApi {
  /** For the smoke test and the console. */
  debug(): {
    reading: Reading;
    audible: boolean;
    route: "music" | "master" | null;
    /** True once the baseline's own music loops are faded out under the score. */
    tookBed: boolean;
    nodes: number;
    where: ReturnType<Engine["where"]> | null;
    output: AudioNode | null;
    /** Timer ticks so far and the main-thread milliseconds they took in all. */
    cost: { ticks: number; ms: number };
  };
  dispose(): void;
}

/** The Assessor is on the quay and not yet scrap. */
function bossActive(G: Game): boolean {
  const phase = G.boss?.fight?.phase;
  return phase === "arriving" || phase === "fighting";
}

export function startScore(G: Game): Score | null {
  try {
    if (G.params && typeof G.params === "object" && "noscore" in G.params) return null;
    const director = createDirector();
    const now = () => performance.now() / 1000;
    const guard = (what: string, fn: () => void) => {
      try {
        fn();
      } catch (e) {
        console.warn(`[score] ${what}`, e);
      }
    };

    let engine: Engine | null = null;
    let engineCtx: AudioContext | null = null;
    let route: "music" | "master" | null = null;
    let bed: GainNode | null = null;
    let level = -1;
    let volume = gameVolume(G);
    let volumeAt = now();
    let reading: Reading = director.read(now());
    let reported: ScoreState | null = null; // the first reading is announced too
    let sounding = false;
    const cost = { ticks: 0, ms: 0 };

    /** Reads the director and tells the game when the state has changed. */
    function observe(): Reading {
      reading = director.read(now(), { boss: bossActive(G) });
      if (reading.state !== reported) {
        reported = reading.state;
        guard("emit", () => G.events?.emit?.("score:state", { state: reported }));
      }
      return reading;
    }

    const context = (): AudioContext | null => (G.audio && !G.audio.silent && G.audio.ctx ? (G.audio.ctx as AudioContext) : null);

    function build(ctx: AudioContext) {
      engine?.dispose();
      const bus: AudioNode | undefined = G.audio?.ext?.music;
      route = bus ? "music" : "master";
      engine = createEngine(ctx, bus ?? ctx.destination);
      engineCtx = ctx;
      level = -1;
      bed = null;
    }

    /** Fades the baseline's baked music loops out, through a gain that can bring them back. */
    function takeBed(ctx: AudioContext) {
      const ext = G.audio?.ext;
      if (bed || !ext?.music || !ext.bed?.on) return;
      const g = ctx.createGain();
      g.connect(ext.music);
      for (const layer of Object.values(ext.bed.layers ?? {}) as { g: AudioNode }[]) {
        layer.g.disconnect();
        layer.g.connect(g);
      }
      g.gain.setTargetAtTime(0, ctx.currentTime, 0.5);
      bed = g;
    }

    function setLevel(v: number) {
      if (v === level || !engine) return;
      level = v;
      engine.level(v);
    }

    function poll() {
      const r = observe();
      const ctx = context();
      const t = now();
      if (t - volumeAt > 0.5) {
        volume = gameVolume(G);
        volumeAt = t;
      }
      sounding = audible({ muted: gameMuted(G), volume, hidden: typeof document !== "undefined" && document.hidden, context: ctx ? ctx.state : null });
      if (!sounding || !ctx) {
        setLevel(0);
        return;
      }
      if (!engine || engineCtx !== ctx) build(ctx);
      takeBed(ctx);
      engine!.set(r);
      // On the music bus the game's master volume is already downstream; on the output it is applied here.
      setLevel(route === "music" ? 1 : volume);
      engine!.tick();
    }

    const offs: (() => void)[] = [];
    const on = (name: string, fn: (e: unknown) => void) => {
      const off = G.events?.on?.(name, (e: unknown) => guard(name, () => fn(e)));
      if (typeof off === "function") offs.push(off);
    };
    for (const name of EVENTS) on(name, (e) => director.event(name, e, now()));
    on("radio:line", (e) => sounding && engine?.duck(radioSeconds((e as { text?: unknown } | null)?.text)));
    const timer = setInterval(() => {
      const t = performance.now();
      guard("tick", poll);
      cost.ticks++;
      cost.ms += performance.now() - t;
    }, TIMER * 1000);

    const score: Score = {
      state: () => observe().state,
      // (state() reports the music the game calls for even when sound is off, so screens and tests can follow it.)
      hold(state) {
        director.hold(state);
        observe();
      },
      debug: () => ({
        reading,
        audible: sounding,
        route,
        tookBed: !!bed,
        nodes: engine ? engine.nodes() + (bed ? 1 : 0) : 0,
        where: engine ? engine.where() : null,
        output: engine ? engine.output : null,
        cost: { ...cost },
      }),
      dispose() {
        clearInterval(timer);
        for (const off of offs) off();
        guard("bed", () => bed && engineCtx && bed.gain.setTargetAtTime(1, engineCtx.currentTime, 0.5));
        engine?.dispose();
        engine = null;
      },
    };
    G.score = score;
    return score;
  } catch (e) {
    console.warn("[score] off:", e);
    return null;
  }
}
