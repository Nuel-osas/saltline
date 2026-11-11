// Trade feedback you can hear: a short "cash" (a register's drawer and two bell strikes, a few coins settling) when a
// sale is confirmed, and a softer coin tick when a purchase or an investment is. Both are synthesized here into
// sample buffers the first time they play; nothing is downloaded.
//
// The game's audio bus only plays its own named bank (the Dockside already borrows ui:click and ui:hover from it), and
// a new sound can't join that bank without changing game.js. So these play through the game's own AudioContext
// (G.audio.ctx, already unlocked by the game's first-gesture listeners) straight to its output, scaled by the master
// volume from the game's Settings (saltline.settings.v1), and stay silent with ?noaudio or when the game's audio is
// its silent stub.
export type Chime = "cash" | "soft";

/** The bits of a Web Audio context this needs (a real AudioContext, or a stand-in in tests). */
export interface ChimeContext {
  readonly state: string;
  readonly sampleRate: number;
  readonly destination: unknown;
  createBuffer(channels: number, length: number, sampleRate: number): { getChannelData(ch: number): Float32Array };
  createBufferSource(): { buffer: unknown; connect(node: unknown): unknown; start(when?: number): void };
  createGain(): { gain: { value: number }; connect(node: unknown): unknown };
}

export interface ChimeDeps {
  ctx(): ChimeContext | null;
  /** The game's master volume, 0–1. */
  volume(): number;
  muted(): boolean;
}

export interface Chimes {
  /** Plays it if sound is on; true when it was started. */
  play(kind: Chime): boolean;
  /** How many of each have played (the browser check reads it). */
  readonly played: Record<Chime, number>;
}

/** Peak level of each, before the master volume. A sale should be heard over the rain; a purchase only noticed. */
const LEVEL: Record<Chime, number> = { cash: 0.42, soft: 0.22 };
/** The settings key and default volume the game uses (game.js: fM, XC.volume). */
export const SETTINGS_KEY = "saltline.settings.v1";
const DEFAULT_VOLUME = 0.8;

// ---- synthesis ----

/** A struck bell: a few inharmonic partials, each dying away faster than the one below it. */
function bell(out: Float32Array, sr: number, at: number, f: number, amp: number, tau: number, partials: [number, number][]) {
  const start = Math.floor(at * sr);
  const n = Math.min(out.length - start, Math.floor(tau * 6 * sr));
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const attack = Math.min(1, t / 0.002);
    let s = 0;
    partials.forEach(([ratio, a], k) => {
      s += a * Math.sin(2 * Math.PI * f * ratio * t) * Math.exp(-t / (tau / (1 + k * 0.9)));
    });
    out[start + i] += amp * attack * s * (1 + 0.08 * Math.sin(2 * Math.PI * 6.5 * t));
  }
}

/** A burst of filtered noise (the drawer's catch, a coin's edge), from a fixed seed so every play sounds the same. */
function knock(out: Float32Array, sr: number, at: number, amp: number, tau: number, bright: number, seed: number) {
  const start = Math.floor(at * sr);
  const n = Math.min(out.length - start, Math.floor(tau * 6 * sr));
  let x = seed >>> 0;
  let lp = 0;
  for (let i = 0; i < n; i++) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    const white = x / 2147483648 - 1;
    lp += (white - lp) * bright;
    out[start + i] += amp * lp * Math.exp(-i / sr / tau);
  }
}

function thump(out: Float32Array, sr: number, at: number, f: number, amp: number, tau: number) {
  const start = Math.floor(at * sr);
  const n = Math.min(out.length - start, Math.floor(tau * 6 * sr));
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    out[start + i] += amp * Math.sin(2 * Math.PI * f * t * (1 - 0.3 * Math.min(1, t / tau))) * Math.exp(-t / tau);
  }
}

const BELL: [number, number][] = [
  [1, 1],
  [2.76, 0.42],
  [5.4, 0.18],
  [8.93, 0.07],
];

/** The samples for a chime at a sample rate: mono, peak 0.9. Pure, so it can be tested. */
export function chimeSamples(kind: Chime, sr: number): Float32Array {
  const out = new Float32Array(Math.ceil((kind === "cash" ? 0.75 : 0.34) * sr));
  if (kind === "cash") {
    knock(out, sr, 0, 0.55, 0.018, 0.55, 7); // the drawer's catch
    thump(out, sr, 0, 120, 0.5, 0.05); // and the drawer landing
    bell(out, sr, 0.045, 2093, 0.55, 0.2, BELL); // ka-
    bell(out, sr, 0.11, 2637, 0.7, 0.3, BELL); // -ching
    for (const [t, f, s] of [
      [0.19, 4310, 11],
      [0.235, 5020, 12],
      [0.3, 4660, 13],
    ] as const) {
      bell(out, sr, t, f, 0.1, 0.03, [[1, 1]]); // coins settling
      knock(out, sr, t, 0.08, 0.006, 0.8, s);
    }
  } else {
    knock(out, sr, 0, 0.3, 0.006, 0.7, 3);
    bell(out, sr, 0, 1568, 0.5, 0.08, BELL.slice(0, 2));
    bell(out, sr, 0.06, 2093, 0.38, 0.11, BELL.slice(0, 2));
  }
  let peak = 0;
  for (const v of out) peak = Math.max(peak, Math.abs(v));
  if (peak > 0) for (let i = 0; i < out.length; i++) out[i] *= 0.9 / peak;
  // A short fade at the end so the buffer never stops on a click.
  const fade = Math.floor(0.01 * sr);
  for (let i = 0; i < fade; i++) out[out.length - 1 - i] *= i / fade;
  return out;
}

// ---- playing ----

export function createChimes(deps: ChimeDeps): Chimes {
  const played: Record<Chime, number> = { cash: 0, soft: 0 };
  let cacheFor: ChimeContext | null = null;
  const cache = new Map<Chime, unknown>();
  const last: Record<Chime, number> = { cash: -Infinity, soft: -Infinity };

  return {
    played,
    play(kind) {
      try {
        if (deps.muted()) return false;
        const vol = deps.volume();
        if (!(vol > 0)) return false;
        const ctx = deps.ctx();
        if (!ctx || ctx.state === "closed") return false;
        // Two of the same confirming in the same instant are one sound, not a stack of them.
        const now = typeof performance !== "undefined" ? performance.now() : Date.now();
        if (now - last[kind] < 60) return false;
        last[kind] = now;
        if (cacheFor !== ctx) {
          cache.clear();
          cacheFor = ctx;
        }
        let buf = cache.get(kind);
        if (!buf) {
          const samples = chimeSamples(kind, ctx.sampleRate);
          const b = ctx.createBuffer(1, samples.length, ctx.sampleRate);
          b.getChannelData(0).set(samples);
          cache.set(kind, (buf = b));
        }
        const src = ctx.createBufferSource();
        src.buffer = buf;
        const gain = ctx.createGain();
        gain.gain.value = Math.min(1, vol) * LEVEL[kind];
        src.connect(gain);
        gain.connect(ctx.destination);
        src.start();
        played[kind]++;
        return true;
      } catch {
        return false; // a sound is never worth an error
      }
    },
  };
}

/* eslint-disable @typescript-eslint/no-explicit-any -- the game context is the untyped bundle's G */

/** The game's master volume: the live Settings value, else what Settings saved, else the game's default. */
export function gameVolume(G: any): number {
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  const live = G?.game?.menus?.settings?.volume;
  if (typeof live === "number" && Number.isFinite(live)) return clamp(live);
  try {
    const saved = JSON.parse(globalThis.localStorage?.getItem(SETTINGS_KEY) ?? "null");
    if (saved && typeof saved.volume === "number" && Number.isFinite(saved.volume)) return clamp(saved.volume);
  } catch {
    /* unreadable settings: the default */
  }
  return DEFAULT_VOLUME;
}

/** ?noaudio, read the way the game reads it (any non-empty value), or the game's audio being its silent stub. */
export function gameMuted(G: any): boolean {
  let params: Record<string, unknown> | null = G?.params && typeof G.params === "object" ? G.params : null;
  if (!params && typeof location !== "undefined") params = Object.fromEntries(new URLSearchParams(location.search));
  return !!params?.noaudio || !!G?.audio?.silent;
}

/** Chimes on the game's own audio context, volume and mute. */
export function gameChimes(G: any): Chimes {
  return createChimes({
    ctx: () => (G?.audio && !G.audio.silent && G.audio.ctx ? (G.audio.ctx as ChimeContext) : null),
    volume: () => gameVolume(G),
    muted: () => gameMuted(G),
  });
}
