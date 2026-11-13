// The score, written down (docs/CAMPAIGN.md → The score). Everything the engine plays is in this file: one key, one
// tempo, a handful of motifs, and for each state which of them sound and how loud. Change the music here.
//
// Key: D minor, over a D pedal. Tempo: 72 bpm in 4/4, so a bar is 3.33 s and a sixteenth 208 ms.
//
// The motifs, and how they are related:
//   foghorn    D3 → A2. A falling fourth that stops on the dominant: a question, far off. The title asks it.
//   theme      Opens by turning the foghorn over (D4 up to A4), then leans on the semitone above (Bb → A) and walks
//              home by step. Eight bars. Only the ending plays it whole.
//   bailiff    Eb2 → D2. The theme's Bb → A lean, taken down to the tonic and left with nothing else: a low minor
//              second that falls and waits. It does not hurry, like the machine.
//   assessor   D, Eb, D, then the tritone Ab falling to G: the Bailiff's second with a tritone bolted on, since the
//              two machines are one family. A held A → Bb grinds above it.
//   foghornHome A2 → D2. The foghorn's answer, falling to the tonic at last. Only the ending's tail plays it.
import type { ScoreState } from "../campaign/types";

export const KEY = "D minor";
export const TEMPO = { bpm: 72, beatsPerBar: 4, stepsPerBeat: 4 } as const;
export const STEPS_PER_BAR = TEMPO.beatsPerBar * TEMPO.stepsPerBeat;

const PITCH: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** "Bb3" → 58 (C4 is 60). */
export function midi(name: string): number {
  const m = /^([A-G])([b#]?)(-?\d)$/.exec(name);
  if (!m) throw new Error(`[score] not a note: ${name}`);
  return 12 * (Number(m[3]) + 1) + PITCH[m[1]] + (m[2] === "#" ? 1 : m[2] === "b" ? -1 : 0);
}
export const hz = (name: string): number => 440 * 2 ** ((midi(name) - 69) / 12);

/** A note of a phrase: the beat it starts on (from the phrase's start), its length in beats, its name, its weight. */
export type Note = readonly [beat: number, beats: number, note: string, vel?: number];
export type Phrase = readonly Note[];

export const MOTIFS = {
  foghorn: [
    [0, 3, "D3"],
    [3.5, 5, "A2", 0.85],
  ],
  foghornHome: [
    [0, 3, "A2"],
    [3.5, 7, "D2", 0.9],
  ],
  /** The dead card's horn: one note, no answer. */
  foghornAlone: [[0, 6, "D2", 0.8]],
  themeA: [
    [0, 2, "D4"],
    [2, 2, "A4"],
    [4, 3, "Bb4"],
    [7, 1, "A4", 0.8],
    [8, 2, "G4"],
    [10, 1, "F4", 0.8],
    [11, 1, "E4", 0.8],
    [12, 3.5, "E4", 0.7],
    [16, 2, "D4"],
    [18, 2, "A4"],
    [20, 3, "C5"],
    [23, 1, "Bb4", 0.8],
    [24, 2, "A4"],
    [26, 1, "G4", 0.8],
    [27, 1, "F4", 0.8],
    [28, 2, "E4", 0.8],
    [30, 2, "D4", 0.9],
  ],
  /** The middle eight: the same shape in the major, where the town is. */
  themeB: [
    [0, 2, "F#4"],
    [2, 2, "A4"],
    [4, 3, "B4"],
    [7, 1, "A4", 0.8],
    [8, 2, "Bb4"],
    [10, 1, "A4", 0.8],
    [11, 1, "G4", 0.8],
    [12, 3.5, "A4", 0.7],
    [16, 2, "D5"],
    [18, 2, "A4"],
    [20, 3, "B4"],
    [23, 1, "G4", 0.8],
    [24, 2, "Bb4"],
    [26, 2, "G4", 0.8],
    [28, 3.5, "E4", 0.8],
  ],
  /** The last note of the theme, held into the tail. */
  themeEnd: [[0, 7, "D4", 0.9]],
  bailiff: [
    [0, 3, "Eb2"],
    [3, 4.5, "D2", 0.9],
  ],
  assessor: [
    [0, 1.5, "D2"],
    [1.5, 0.5, "Eb2", 0.8],
    [2, 1, "D2"],
    [3, 1, "Ab2"],
    [4, 2, "G2"],
    [6, 1, "Eb2", 0.9],
    [7, 1, "D2"],
  ],
  assessorHigh: [
    [0, 7.5, "A4", 0.7],
    [8, 7.5, "Bb4", 0.8],
  ],
  /** The set piece's rising line: a step a bar, eight bars up the scale. */
  rise: [
    [0, 3.5, "D4", 0.6],
    [4, 3.5, "E4", 0.65],
    [8, 3.5, "F4", 0.7],
    [12, 3.5, "G4", 0.75],
    [16, 3.5, "A4", 0.8],
    [20, 3.5, "Bb4", 0.85],
    [24, 3.5, "C5", 0.9],
    [28, 3.5, "D5", 1],
  ],
  /** The boat is free: open fifths upward, no third, so it sits under the game's own minor and major stingers. */
  free: [
    [0, 1, "A3", 0.8],
    [1, 1, "D4", 0.9],
    [2, 1, "E4", 0.9],
    [3, 4.5, "A4"],
  ],
} satisfies Record<string, Phrase>;

/** The bass ostinato: two bars of eighths under combat (null is a rest). */
export const OSTINATO: readonly (string | null)[] = ["D2", "D2", null, "D2", "F2", null, "D2", "C2", "D2", "D2", null, "D2", "Eb2", null, "D2", "A1"];

/** Chords for the pad, low to high, over the D pedal. Each field is a way the port can feel. */
export const FIELDS = {
  /** Dm · Bb/D · Gm/D · Asus/D: the progression the theme is written over. One voice moves at a time. */
  tide: [
    ["D3", "A3", "F4"],
    ["D3", "Bb3", "F4"],
    ["D3", "Bb3", "G4"],
    ["D3", "A3", "E4"],
  ],
  /** The same, emptied to fifths and an octave down: the pad, thinned. */
  bare: [
    ["D2", "A2", "D3"],
    ["D2", "A2", "D3"],
    ["D2", "Bb2", "D3"],
    ["D2", "A2", "E3"],
  ],
  /** D · G/D · Gm/D · Asus/D: the major, with the minor fourth that remembers the port. */
  warm: [
    ["D3", "A3", "F#4"],
    ["D3", "B3", "G4"],
    ["D3", "Bb3", "G4"],
    ["D3", "A3", "E4"],
  ],
  /** No third, and the Bailiff's Eb leaning on the octave. */
  cold: [
    ["D2", "A2", "D3"],
    ["D2", "A2", "Eb3"],
  ],
  /** Dsus2: neither minor nor major. */
  free: [["D3", "A3", "E4"]],
  /** D major, where the ending comes to rest. */
  home: [["D3", "A3", "F#4"]],
} satisfies Record<string, readonly (readonly [string, string, string])[]>;
export type Field = keyof typeof FIELDS;

/**
 * Drum bars, a character a sixteenth: `L` the low drum (a sine drop under filtered noise), `T` the tom above it,
 * `g` a ghost of noise alone, `.` nothing.
 */
export const DRUMS = {
  sparse: "L.........L.....",
  combat: "L.....T...L....g",
  setpiece: "L..g..T.L.L.T.gg",
  /** 3 + 3 + 2: the Assessor walks in threes. */
  boss: "L..L..T.L..L..TT",
  /** The ending's last eight: a slow drum under the theme. */
  cortege: "L.......T.......",
} as const;

/** Metal ticks, a character a sixteenth: `x` a tick, `X` an accented one. */
export const TICKS = {
  combat: "..x...X...x...x.",
  setpiece: "x.X.x.X.x.X.x.Xx",
  boss: "X.xX.xX.X.xX.xXx",
} as const;

/** The sub pulse, a character a sixteenth: `O` full, `o` half. */
export const PULSE = {
  infiltrate: "O.........o.....",
  bar: "O...............",
} as const;

export interface Layer {
  phrase: Phrase;
  /** The phrase repeats after this many bars; `once` plays it a single time. */
  every: number | "once";
  /** The bar it first sounds on. */
  from?: number;
  /** 0–1. */
  level: number;
}

/** What plays in a state (or in one section of it). Levels are 0–1 of each layer's own ceiling. */
export interface Recipe {
  field: Field;
  barsPerChord: number;
  pad: number;
  /** The pad's low-pass, Hz. It drifts around this. */
  cutoff: number;
  /** How much of the mix goes to the reverb, 0–1. */
  wet: number;
  /** The horn: the foghorn, the theme, the rising line. */
  lead?: Layer;
  /** The low brass: the Assessor. (The Bailiff's figure is the stalker layer, over any state.) */
  low?: Layer;
  pulse?: { bar: string; level: number; everyBars?: number };
  /** A long breath of filtered noise every so many bars. */
  swell?: { everyBars: number; level: number };
  drums?: { bar: string; level: number };
  /** The ostinato: eighths, or sixteenths when driven. */
  bass?: { level: number; driven?: boolean };
  ticks?: { bar: string; level: number };
  /** The chance, each bar, of a halyard slapping a mast somewhere. */
  halyard?: number;
  /** Combat only: drums, bass and ticks follow the fight's intensity instead of playing at full. */
  followsIntensity?: boolean;
  /** How long this section lasts before the next one, in bars. The last section has none. */
  bars?: number;
}

/** Each state's music. A list is played in order, section by section, and stays on the last. */
export const RECIPES: Record<Exclude<ScoreState, "stalker" | "silent">, Recipe | readonly Recipe[]> = {
  title: {
    field: "tide",
    barsPerChord: 2,
    pad: 0.9,
    cutoff: 520,
    wet: 0.6,
    lead: { phrase: MOTIFS.foghorn, every: 4, from: 1, level: 0.42 },
    halyard: 0.45,
  },
  infiltrate: {
    field: "bare",
    barsPerChord: 4,
    pad: 0.45,
    cutoff: 300,
    wet: 0.5,
    pulse: { bar: PULSE.infiltrate, level: 0.8 },
    swell: { everyBars: 4, level: 0.7 },
    halyard: 0.12,
  },
  combat: {
    field: "bare",
    barsPerChord: 2,
    pad: 0.5,
    cutoff: 420,
    wet: 0.3,
    pulse: { bar: PULSE.bar, level: 0.9 },
    drums: { bar: DRUMS.combat, level: 0.9 },
    bass: { level: 0.85 },
    ticks: { bar: TICKS.combat, level: 0.7 },
    followsIntensity: true,
  },
  setpiece: {
    field: "tide",
    barsPerChord: 1,
    pad: 0.55,
    cutoff: 620,
    wet: 0.3,
    lead: { phrase: MOTIFS.rise, every: 8, level: 0.55 },
    pulse: { bar: PULSE.bar, level: 1 },
    drums: { bar: DRUMS.setpiece, level: 1 },
    bass: { level: 1, driven: true },
    ticks: { bar: TICKS.setpiece, level: 0.8 },
  },
  boss: {
    field: "tide",
    barsPerChord: 1,
    pad: 0.6,
    cutoff: 700,
    wet: 0.32,
    lead: { phrase: MOTIFS.assessorHigh, every: 4, level: 0.5 },
    low: { phrase: MOTIFS.assessor, every: 2, level: 1 },
    pulse: { bar: PULSE.bar, level: 1 },
    drums: { bar: DRUMS.boss, level: 1 },
    bass: { level: 1, driven: true },
    ticks: { bar: TICKS.boss, level: 0.8 },
  },
  clear: {
    field: "free",
    barsPerChord: 1,
    pad: 0.85,
    cutoff: 850,
    wet: 0.5,
    lead: { phrase: MOTIFS.free, every: "once", level: 0.7 },
    pulse: { bar: PULSE.bar, level: 0.8, everyBars: 2 },
  },
  debrief: {
    field: "warm",
    barsPerChord: 2,
    pad: 0.85,
    cutoff: 760,
    wet: 0.55,
    halyard: 0.2,
  },
  dead: {
    field: "cold",
    barsPerChord: 2,
    pad: 0.6,
    cutoff: 210,
    wet: 0.6,
    lead: { phrase: MOTIFS.foghornAlone, every: "once", from: 1, level: 0.4 },
    pulse: { bar: PULSE.bar, level: 0.6, everyBars: 2 },
    swell: { everyBars: 2, level: 0.8 },
  },
  // The theme, whole: 24 bars (80 s), then the tail for as long as the credits run.
  ending: [
    { bars: 8, field: "tide", barsPerChord: 1, pad: 0.7, cutoff: 600, wet: 0.5, lead: { phrase: MOTIFS.themeA, every: "once", level: 0.75 }, pulse: { bar: PULSE.bar, level: 0.5 } },
    {
      bars: 8,
      field: "warm",
      barsPerChord: 1,
      pad: 0.85,
      cutoff: 800,
      wet: 0.5,
      lead: { phrase: MOTIFS.themeB, every: "once", level: 0.8 },
      pulse: { bar: PULSE.bar, level: 0.7 },
      bass: { level: 0.35 },
    },
    {
      bars: 8,
      field: "tide",
      barsPerChord: 1,
      pad: 0.95,
      cutoff: 950,
      wet: 0.5,
      lead: { phrase: MOTIFS.themeA, every: "once", level: 0.9 },
      pulse: { bar: PULSE.bar, level: 0.9 },
      drums: { bar: DRUMS.cortege, level: 0.6 },
      bass: { level: 0.5 },
    },
    { bars: 2, field: "home", barsPerChord: 1, pad: 0.9, cutoff: 900, wet: 0.6, lead: { phrase: MOTIFS.themeEnd, every: "once", level: 0.8 }, pulse: { bar: PULSE.bar, level: 0.7, everyBars: 2 } },
    { field: "home", barsPerChord: 1, pad: 0.55, cutoff: 520, wet: 0.65, lead: { phrase: MOTIFS.foghornHome, every: 4, level: 0.45 }, halyard: 0.3 },
  ],
};

/** The Bailiff's layer, over whatever else plays. */
export const STALKER = {
  figure: { phrase: MOTIFS.bailiff, every: 2, level: 1 } satisfies Layer,
  /** Metres: where the layer starts, and where the heartbeat tops out. */
  far: 25,
  close: 3,
  /** Heartbeats a minute at `far` and at `close`. */
  slow: 54,
  fast: 150,
  /** On a knee: the figure stops and the heart slows to this, at this level. */
  kneeBpm: 46,
  kneeLevel: 0.3,
} as const;

/** The states' sections, as a list. */
export function sections(state: keyof typeof RECIPES): readonly Recipe[] {
  const r = RECIPES[state];
  return Array.isArray(r) ? (r as readonly Recipe[]) : [r as Recipe];
}
