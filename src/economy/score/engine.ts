// The score's instrument and its conductor. A small fixed set of Web Audio nodes (oscillators, one noise loop,
// filters, a convolver whose impulse is made here) is built once, and a step scheduler writes notes onto their
// parameters a little ahead of the audio clock. Nothing is downloaded and no samples are used: the only buffers are
// a noise loop, the reverb's impulse and two struck-metal sounds, all generated below.
//
// What it plays comes from theme.ts (the notes and each state's recipe) and from a Reading (state.ts). It runs on an
// AudioContext in the game and on an OfflineAudioContext in scripts/render-score.mjs, the same code in both.
import { LATCH, LOOKAHEAD, STEP, behind, due, reanchor, stepTime } from "./clock";
import type { BaseState, Reading } from "./state";
import { FIELDS, OSTINATO, STALKER, STEPS_PER_BAR, TEMPO, hz, sections, type Layer, type Note, type Phrase, type Recipe } from "./theme";

/** Each layer's ceiling, before the limiter. Set from the offline renders (scripts/render-score.mjs). */
const GAIN = { pad: 0.05, horn: 0.2, brass: 0.22, bass: 0.3, sub: 0.32, kick: 0.42, drum: 0.9, heart: 0.45, swell: 0.3, metal: 0.11, wet: 0.5 };
/** The score's level after its limiter: its loudest peaks land about 12 dB under a rifle shot once the music bus has it. */
const MASTER = 0.5;
/** Sustained layers move to a new state's level with this time constant: about 1.5 s to arrive. */
const FADE = 0.5;
/** Under a radio line. */
const DUCK = 0.6;

const SILENT: Reading = { state: "silent", base: "silent", stalker: 0, heartBpm: 0, intensity: 0 };
const IN_RUN: ReadonlySet<BaseState> = new Set<BaseState>(["infiltrate", "combat", "setpiece", "boss", "clear"]);

export interface Engine {
  /** The score's output node (after its limiter and level): what the smoke test listens to. */
  readonly output: AudioNode;
  set(reading: Reading): void;
  /** In the game: schedules what is due, from a timer. */
  tick(): void;
  /** Schedules every step that sounds before `until` (an offline render calls it once for the whole file). */
  advance(until: number): void;
  /** The overall level, 0–1 (the master volume when the score is not on the game's music bus). */
  level(v: number): void;
  /** Dips under a radio line for this long. */
  duck(seconds: number): void;
  /** Live audio nodes: the fixed set plus any struck metal still ringing. */
  nodes(): number;
  where(): { state: BaseState | null; section: number; bar: number };
  dispose(): void;
}

function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- generated buffers ----

function noiseLoop(ctx: BaseAudioContext, rnd: () => number): AudioBuffer {
  const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 2.3), ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = rnd() * 2 - 1;
  return buf;
}

/** A wet quay and steel walls: decaying noise that darkens as it dies, different in each ear. */
function impulse(ctx: BaseAudioContext, rnd: () => number): AudioBuffer {
  const sr = ctx.sampleRate;
  const buf = ctx.createBuffer(2, Math.floor(sr * 2.6), sr);
  const pre = Math.floor(sr * 0.018);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let lp = 0;
    for (let i = pre; i < d.length; i++) {
      const t = (i - pre) / sr;
      lp += (rnd() * 2 - 1 - lp) * (0.55 * Math.exp(-t / 0.9) + 0.06);
      d[i] = lp * Math.exp(-t / 0.5) * Math.min(1, t / 0.004);
    }
  }
  return buf;
}

/** Struck metal: a few inharmonic partials under a click. `ring` seconds for the lowest; the rest die sooner. */
function struck(ctx: BaseAudioContext, rnd: () => number, f: number, ring: number, partials: readonly [number, number][]): AudioBuffer {
  const sr = ctx.sampleRate;
  const buf = ctx.createBuffer(1, Math.floor(sr * ring * 5), sr);
  const d = buf.getChannelData(0);
  const fade = Math.floor(sr * 0.01);
  for (let i = 0; i < d.length; i++) {
    const t = i / sr;
    let s = (rnd() * 2 - 1) * 0.5 * Math.exp(-t / 0.002);
    partials.forEach(([ratio, a], k) => (s += a * Math.sin(2 * Math.PI * f * ratio * t) * Math.exp(-t / (ring / (1 + k * 0.8)))));
    d[i] = s * Math.min(1, i / 24) * Math.min(1, (d.length - i) / fade);
  }
  return buf;
}

// ---- the instrument ----

interface Mono {
  oscs: OscillatorNode[];
  ratios: readonly number[];
  filter: BiquadFilterNode;
  amp: GainNode;
  cutoff: number;
  gain: number;
}
interface Thump {
  osc: OscillatorNode;
  amp: GainNode;
  level: number;
}

export function createEngine(ctx: BaseAudioContext, dest: AudioNode, opts: { seed?: number } = {}): Engine {
  const rnd = mulberry(opts.seed ?? 0x5a17);
  let fixed = 0;
  let ringing = 0;
  const gain = (v: number) => {
    const g = ctx.createGain();
    g.gain.value = v;
    fixed++;
    return g;
  };
  const lowpass = (f: number, q: number) => {
    const b = ctx.createBiquadFilter();
    b.type = "lowpass";
    b.frequency.value = f;
    b.Q.value = q;
    fixed++;
    return b;
  };
  const sources: AudioScheduledSourceNode[] = [];
  const osc = (type: OscillatorType, cents = 0) => {
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.value = 73.42;
    o.detune.value = cents;
    o.start();
    sources.push(o);
    fixed++;
    return o;
  };

  // Out: everything sums into a limiter, then the radio duck, then the level.
  const sum = gain(1);
  const limiter = ctx.createDynamicsCompressor();
  fixed++;
  limiter.threshold.value = -18;
  limiter.knee.value = 6;
  limiter.ratio.value = 12;
  limiter.attack.value = 0.003;
  limiter.release.value = 0.25;
  const ducker = gain(1);
  const out = gain(0);
  sum.connect(limiter);
  limiter.connect(ducker);
  ducker.connect(out);
  out.connect(dest);
  // Space: one convolver, fed by the layers that should sound far away.
  const send = gain(0);
  const verb = ctx.createConvolver();
  fixed++;
  verb.buffer = impulse(ctx, rnd);
  send.connect(verb);
  verb.connect(sum);

  function mono(type: OscillatorType, ratios: readonly number[], cents: readonly number[], cutoff: number, q: number, level: number, far: boolean): Mono {
    const filter = lowpass(cutoff, q);
    const amp = gain(0);
    const oscs = ratios.map((_, i) => {
      const o = osc(type, cents[i]);
      o.connect(filter);
      return o;
    });
    filter.connect(amp);
    amp.connect(sum);
    if (far) amp.connect(send);
    return { oscs, ratios, filter, amp, cutoff, gain: level };
  }
  function thump(level: number): Thump {
    const o = osc("triangle");
    const amp = gain(0);
    o.connect(amp);
    amp.connect(sum);
    return { osc: o, amp, level };
  }

  // The pad: four detuned saws through a slow low-pass. Two on the chord's low note, one each on the others.
  const pad = mono("sawtooth", [1, 1, 1, 1], [-7, 6, -4, 5], 300, 0.5, GAIN.pad, true);
  // The horn (the foghorn, the theme, the rising line) and the low brass (the Bailiff, the Assessor): saw pairs
  // whose filter opens with the note, as a brass player's tone does.
  const horn = mono("sawtooth", [1, 1], [-5, 6], 420, 0.8, GAIN.horn, true);
  const brass = mono("sawtooth", [1, 2], [-4, 5], 240, 1, GAIN.brass, true);
  const bass = mono("sawtooth", [1], [0], 160, 1.4, GAIN.bass, false);
  const sub = thump(GAIN.sub);
  sub.osc.type = "sine";
  const kick = thump(GAIN.kick);
  const heart = thump(GAIN.heart);
  // One noise loop, heard two ways: short and low for the drums, long and moving for the swells.
  const noise = ctx.createBufferSource();
  fixed++;
  noise.buffer = noiseLoop(ctx, rnd);
  noise.loop = true;
  noise.start();
  sources.push(noise);
  const drumF = lowpass(260, 1.2);
  const drumG = gain(0);
  const swellF = lowpass(170, 1.4);
  const swellG = gain(0);
  noise.connect(drumF);
  drumF.connect(drumG);
  drumG.connect(sum);
  noise.connect(swellF);
  swellF.connect(swellG);
  swellG.connect(sum);
  swellG.connect(send);
  const metalBuf = {
    clink: struck(ctx, rnd, 1180, 0.32, [
      [1, 1],
      [2.32, 0.5],
      [3.87, 0.28],
      [5.21, 0.12],
    ]),
    tick: struck(ctx, rnd, 2350, 0.03, [
      [1, 1],
      [1.83, 0.6],
      [2.91, 0.3],
    ]),
  };

  // ---- playing a note ----

  function note(v: Mono, t: number, f: number, dur: number, vel: number, attack: number, release: number, bright: number) {
    v.oscs.forEach((o, i) => o.frequency.setTargetAtTime(f * v.ratios[i], t, 0.006));
    v.filter.frequency.setTargetAtTime(v.cutoff * (1 + bright * vel), t, attack / 2);
    v.filter.frequency.setTargetAtTime(v.cutoff, t + dur, release / 2);
    v.amp.gain.setTargetAtTime(vel * v.gain, t, attack / 3);
    v.amp.gain.setTargetAtTime(0, t + dur, release / 3);
  }
  /** A pitched drop: the drum's body, the sub pulse, a heartbeat. `fall` must be shorter than the gap to the next. */
  function drop(v: Thump, t: number, f0: number, f1: number, fall: number, vel: number, decay: number) {
    v.osc.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) v.osc.frequency.exponentialRampToValueAtTime(f1, t + fall);
    v.amp.gain.setTargetAtTime(vel * v.level, t, 0.003);
    v.amp.gain.setTargetAtTime(0, t + 0.03, decay);
  }
  function drum(t: number, kind: string, vel: number) {
    if (kind === "L") drop(kick, t, 118, 46, 0.09, vel, 0.11);
    else if (kind === "T") drop(kick, t, 176, 84, 0.07, vel * 0.8, 0.08);
    drumF.frequency.setValueAtTime(kind === "L" ? 230 : kind === "T" ? 420 : 950, t);
    drumG.gain.setTargetAtTime(vel * GAIN.drum * (kind === "g" ? 0.3 : 1), t, 0.002);
    drumG.gain.setTargetAtTime(0, t + 0.012, kind === "L" ? 0.07 : 0.04);
  }
  let swellEnds = -Infinity;
  function swell(t: number, len: number, vel: number) {
    if (t < swellEnds) return; // one breath at a time: its filter sweep is a single line of automation
    swellEnds = t + len;
    swellF.frequency.setValueAtTime(170, t);
    swellF.frequency.exponentialRampToValueAtTime(620, t + len * 0.5);
    swellF.frequency.exponentialRampToValueAtTime(170, t + len);
    swellG.gain.setTargetAtTime(vel * GAIN.swell, t, len * 0.18);
    swellG.gain.setTargetAtTime(0, t + len * 0.5, len * 0.14);
  }
  function metal(t: number, kind: keyof typeof metalBuf, rate: number, vel: number) {
    const src = ctx.createBufferSource();
    const g = ctx.createGain();
    src.buffer = metalBuf[kind];
    src.playbackRate.value = rate;
    g.gain.value = vel * GAIN.metal;
    src.connect(g);
    g.connect(sum);
    g.connect(send);
    ringing += 2;
    src.onended = () => {
      ringing -= 2;
      try {
        g.disconnect();
      } catch {
        /* already gone */
      }
    };
    src.start(t);
  }
  function beat(t: number, bpm: number, vel: number) {
    const gap = Math.min(0.2, (0.3 * 60) / bpm);
    drop(heart, t, 96, 54, 0.06, vel, 0.045);
    drop(heart, t + gap, 80, 47, 0.06, vel * 0.7, 0.06);
  }

  // ---- the conductor ----

  const beatSec = STEP * TEMPO.stepsPerBeat;
  const byStep = new WeakMap<Phrase, Map<number, Note>>();
  function at(phrase: Phrase, step: number): Note | undefined {
    let m = byStep.get(phrase);
    if (!m) byStep.set(phrase, (m = new Map(phrase.map((n) => [Math.round(n[0] * TEMPO.stepsPerBeat), n]))));
    return m.get(step);
  }
  /** The note of a layer that starts on this step of the section, if any. */
  function due1(layer: Layer, local: number): Note | undefined {
    const rel = local - (layer.from ?? 0) * STEPS_PER_BAR;
    if (rel < 0) return undefined;
    return at(layer.phrase, layer.every === "once" ? rel : rel % (layer.every * STEPS_PER_BAR));
  }

  let reading = SILENT;
  let t0 = 0;
  let next = 0;
  let anchored = false;
  let cursor = 0;
  let cur: { state: BaseState; secs: readonly Recipe[]; idx: number; origin: number } | null = null;
  let chord: readonly string[] | null = null;
  let stalkFrom: number | null = null;
  let heartNext = Infinity;

  /** Lets go of whatever a voice is holding, and of the note ends still queued for it, so a new state starts clean. */
  function release(v: Mono, t: number) {
    v.amp.gain.cancelScheduledValues(t);
    v.amp.gain.setTargetAtTime(0, t, 0.12);
    v.filter.frequency.cancelScheduledValues(t);
    v.filter.frequency.setTargetAtTime(v.cutoff, t, 0.12);
  }

  function apply(rec: Recipe | null, t: number) {
    pad.amp.gain.setTargetAtTime(rec ? rec.pad * pad.gain : 0, t, FADE);
    pad.filter.frequency.setTargetAtTime(rec ? rec.cutoff : 200, t, FADE);
    send.gain.setTargetAtTime(rec ? rec.wet * GAIN.wet : 0, t, FADE);
  }

  function barStart(rec: Recipe, bar: number, n: number, t: number) {
    const chords = FIELDS[rec.field];
    const c = chords[Math.floor(bar / rec.barsPerChord) % chords.length];
    if (c !== chord) {
      chord = c;
      const f = [hz(c[0]), hz(c[0]), hz(c[1]), hz(c[2])];
      pad.oscs.forEach((o, i) => o.frequency.setTargetAtTime(f[i], t, 0.12));
    }
    // The low-pass breathes over seven bars, so the pad is never the same twice against a four-chord round.
    pad.filter.frequency.setTargetAtTime(rec.cutoff * (1 + 0.28 * Math.sin((2 * Math.PI * Math.floor(n / STEPS_PER_BAR)) / 7)), t, 1.2);
    if (rec.swell && bar % rec.swell.everyBars === rec.swell.everyBars >> 1) swell(t, STEP * STEPS_PER_BAR * 1.9, rec.swell.level);
    if (rec.halyard && rnd() < rec.halyard) {
      const off = [2, 5, 7, 10, 13][Math.floor(rnd() * 5)];
      const rate = [0.79, 0.89, 1, 1.12, 1.26][Math.floor(rnd() * 5)];
      const vel = 0.45 + rnd() * 0.55;
      metal(t + off * STEP, "clink", rate, vel);
      if (rnd() < 0.4) metal(t + (off + 2 + Math.floor(rnd() * 2)) * STEP, "clink", rate * 1.01, vel * 0.5);
    }
  }

  function step(n: number, t: number) {
    // States change on the half bar; the new one counts its bars from there.
    if (n % LATCH === 0 && (!cur || cur.state !== reading.base)) {
      const state = reading.base;
      const had = cur?.secs[cur.idx];
      cur = { state, secs: state === "silent" ? [] : sections(state), idx: 0, origin: n };
      chord = null;
      release(horn, t);
      if (had?.low || cur.secs[0]?.low || !IN_RUN.has(state)) {
        release(brass, t);
        stalkFrom = null;
      }
      apply(cur.secs[0] ?? null, t);
    }
    if (!cur || !cur.secs.length) return;
    let rec = cur.secs[cur.idx];
    let local = n - cur.origin;
    if (rec.bars !== undefined && local >= rec.bars * STEPS_PER_BAR && cur.idx < cur.secs.length - 1) {
      cur.idx++;
      cur.origin = n;
      local = 0;
      rec = cur.secs[cur.idx];
      apply(rec, t);
    }
    const inBar = local % STEPS_PER_BAR;
    const bar = Math.floor(local / STEPS_PER_BAR);
    if (inBar === 0) barStart(rec, bar, n, t);

    // Rhythm layers come in over their first bar, and in combat follow the fight.
    const k = rec.followsIntensity ? reading.intensity : 1;
    const ease = Math.min(1, (local + 10) / STEPS_PER_BAR) * (rec.followsIntensity ? 0.55 + 0.45 * k : 1);
    const human = 0.9 + rnd() * 0.1;

    if (rec.pulse && bar % (rec.pulse.everyBars ?? 1) === 0) {
      const ch = rec.pulse.bar[inBar];
      if (ch === "O" || ch === "o") drop(sub, t, hz("D2"), hz("D2"), 0.05, rec.pulse.level * (ch === "O" ? 1 : 0.5), 0.3);
    }
    if (rec.drums) {
      const ch = rec.drums.bar[inBar];
      if (ch === "L" || (ch === "T" && k > 0.45) || (ch === "g" && k > 0.7)) drum(t, ch, rec.drums.level * ease * human);
    }
    if (rec.bass) {
      const name = OSTINATO[Math.floor(local / 2) % OSTINATO.length];
      const on = local % 2 === 0;
      if (name && (on || rec.bass.driven)) note(bass, t, hz(name), STEP * (on ? 1.3 : 0.7), rec.bass.level * ease * human * (on ? 1 : 0.55), 0.012, 0.16, 3.2);
    }
    if (rec.ticks) {
      const ch = rec.ticks.bar[inBar];
      if (ch === "X" || (ch === "x" && k > 0.5)) metal(t, "tick", ch === "X" ? 1 : 1.19, rec.ticks.level * ease * human * (ch === "X" ? 1 : 0.6));
    }
    if (rec.lead) {
      const nt = due1(rec.lead, local);
      // Below middle C it is the foghorn: slow to speak, dark, long to die.
      if (nt) {
        const far = hz(nt[2]) < 200;
        note(horn, t, hz(nt[2]), nt[1] * beatSec - 0.03, (nt[3] ?? 1) * rec.lead.level, far ? 0.5 : 0.16, far ? 1.6 : 0.5, far ? 0.5 : 1.6);
      }
    }
    const boss = rec.low ? due1(rec.low, local) : undefined;
    if (rec.low && boss) note(brass, t, hz(boss[2]), boss[1] * beatSec - 0.03, (boss[3] ?? 1) * rec.low.level, 0.09, 0.3, 2.6);

    // The Bailiff's figure, over any state in a run, from the next bar line after it comes near.
    if (reading.stalker >= 1 && IN_RUN.has(cur.state) && !rec.low) {
      if (stalkFrom === null && n % STEPS_PER_BAR === 0) stalkFrom = n;
      const nt = stalkFrom === null ? undefined : due1(STALKER.figure, n - stalkFrom);
      if (nt) note(brass, t, hz(nt[2]), nt[1] * beatSec - 0.03, (nt[3] ?? 1) * STALKER.figure.level, 0.22, 0.7, 2.2);
    } else stalkFrom = null;
  }

  /** The heartbeat keeps its own time: its rate is the Bailiff's distance, not the tempo. */
  function hearts(until: number) {
    const on = reading.heartBpm > 0 && reading.stalker > 0 && !!cur && IN_RUN.has(cur.state);
    if (!on) {
      heartNext = Infinity;
      return;
    }
    if (heartNext === Infinity || heartNext < cursor) heartNext = cursor + 0.02;
    while (heartNext < until) {
      beat(heartNext, reading.heartBpm, reading.stalker);
      heartNext += 60 / reading.heartBpm;
    }
  }

  function advance(until: number) {
    if (!anchored) {
      t0 = reanchor(next, cursor);
      anchored = true;
    }
    for (const n of due(next, t0, until)) {
      step(n, stepTime(n, t0));
      next = n + 1;
    }
    hearts(until);
    cursor = Math.max(cursor, until);
  }

  return {
    output: out,
    set(r) {
      reading = r;
    },
    tick() {
      const now = ctx.currentTime;
      if (!anchored || behind(next, t0, now)) {
        t0 = reanchor(next, now);
        anchored = true;
        heartNext = Infinity;
        cursor = now;
      }
      advance(now + LOOKAHEAD);
    },
    advance,
    level(v) {
      out.gain.setTargetAtTime(Math.min(1, Math.max(0, v)) * MASTER, ctx.currentTime, 0.06);
    },
    duck(seconds) {
      const now = ctx.currentTime;
      ducker.gain.cancelScheduledValues(now);
      ducker.gain.setTargetAtTime(DUCK, now, 0.08);
      ducker.gain.setTargetAtTime(1, now + Math.max(0.5, seconds), 0.4);
    },
    nodes: () => fixed + ringing,
    where: () => ({ state: cur ? cur.state : null, section: cur ? cur.idx : 0, bar: cur ? Math.floor((next - cur.origin) / STEPS_PER_BAR) : 0 }),
    dispose() {
      for (const s of sources) {
        try {
          s.stop();
          s.disconnect();
        } catch {
          /* already stopped */
        }
      }
      try {
        out.disconnect();
      } catch {
        /* never connected */
      }
    },
  };
}
