// The opening film as data: five shots, their lengths, and every subtitle at its time. No DOM and no three.js here,
// so the cut can be read and tested on its own. film.ts plays it; stage.ts frames each shot in the live scene.
export type ShotId = "water" | "drop" | "crate" | "objective" | "title";
/** Who is speaking: Control is flat and tired, Moss is blunt, the Harbormaster is polite and bills people. */
export type Voice = "control" | "moss" | "harbormaster";

export interface Subtitle {
  /** Seconds after the shot starts. */
  at: number;
  /** Seconds on screen. */
  for: number;
  who: Voice;
  text: string;
}

export interface Shot {
  id: ShotId;
  seconds: number;
  /** What the shot is, for the people reading this file. */
  what: string;
  subtitles: readonly Subtitle[];
}

export const SHOTS: readonly Shot[] = [
  {
    id: "water",
    seconds: 9,
    what: "05:40. Low over the sea behind the boat as it runs in for the quay ladder, two hooded figures aboard.",
    subtitles: [{ at: 1.7, for: 6.6, who: "control", text: "Ten years ago they gave the port to a machine. Last winter it impounded the town." }],
  },
  {
    id: "drop",
    seconds: 10,
    what: "The drop point: dock workers against the dawn. Two carry a crate, one signals with a hand lamp, one coils a line.",
    subtitles: [{ at: 0.9, for: 8.3, who: "control", text: "Everything the town needs is behind that fence. Medicine. Fuel. Copper. You're the one going over it." }],
  },
  {
    id: "crate",
    seconds: 11.5,
    what: "Moss shoves a long crate across the wet concrete and kicks its latch. The lid opens on the rifle. Push in.",
    subtitles: [
      { at: 3.9, for: 4.2, who: "moss", text: "Issue rifle. Port Authority property. Everyone gets one. Nobody wants it." },
      { at: 8.4, for: 2.9, who: "moss", text: "Bring me back parts and I'll build you something better." },
    ],
  },
  {
    id: "objective",
    seconds: 13.5,
    what: "From the crane, down over the yard: the three uplinks, the sealed containers, then the shed and what waits in it.",
    subtitles: [
      { at: 0.7, for: 3.4, who: "control", text: "Three uplinks. Cut them and it goes blind." },
      { at: 4.5, for: 4.1, who: "control", text: "Take what you can carry. Everything you take goes on its invoice." },
      { at: 9.1, for: 4, who: "control", text: "When the invoice gets big enough, it sends something to collect." },
    ],
  },
  {
    id: "title",
    seconds: 4.5,
    what: "SALTLINE over black, and the Harbormaster's line under it.",
    subtitles: [{ at: 1.3, for: 3, who: "harbormaster", text: "Your visit is not authorised." }],
  },
];

/** The three uplinks, picked out one by one in the objective shot (seconds after that shot starts). */
export const MARKS: readonly { id: string; label: string; at: number }[] = [
  { id: "relay_a", label: "YARD", at: 1.0 },
  { id: "relay_b", label: "SHED", at: 1.9 },
  { id: "relay_c", label: "QUAY", at: 2.8 },
];
/** The markers go as the camera leaves the yard for the shed. */
export const MARKS_OFF = 8.2;
/** When the lens in the shed opens (seconds after the objective shot starts). */
export const LENS_AT = 10.6;

export const FILM_SECONDS = SHOTS.reduce((s, shot) => s + shot.seconds, 0);

/** When shot `i` starts, in seconds from the film's start. */
export function shotStart(i: number): number {
  let t = 0;
  for (let k = 0; k < i && k < SHOTS.length; k++) t += SHOTS[k].seconds;
  return t;
}

export interface Where {
  /** The shot's index, or -1 before the film and SHOTS.length after it. */
  index: number;
  shot: Shot | null;
  /** Seconds into the shot. */
  local: number;
  /** 0–1 through the shot. */
  u: number;
}

export function locate(t: number): Where {
  if (!(t >= 0)) return { index: -1, shot: null, local: 0, u: 0 };
  let start = 0;
  for (let i = 0; i < SHOTS.length; i++) {
    const s = SHOTS[i];
    if (t < start + s.seconds) return { index: i, shot: s, local: t - start, u: (t - start) / s.seconds };
    start += s.seconds;
  }
  return { index: SHOTS.length, shot: null, local: 0, u: 1 };
}

/** The subtitle on screen at film time `t`, or null. */
export function subtitleAt(t: number): Subtitle | null {
  const w = locate(t);
  if (!w.shot) return null;
  for (const s of w.shot.subtitles) if (w.local >= s.at && w.local < s.at + s.for) return s;
  return null;
}

const FADE_IN = 1.1;
const FADE_OUT = 0.7;
const CUT = 0.09;
/**
 * How black the screen is at film time `t` (0 clear, 1 black): up from black at the start, a few frames of black at
 * each cut, down to black before the title, which is black throughout.
 */
export function blackAt(t: number): number {
  const w = locate(t);
  if (!w.shot || w.shot.id === "title") return 1;
  const left = w.shot.seconds - w.local;
  let k = 0;
  if (w.index === 0) k = Math.max(k, 1 - w.local / FADE_IN);
  else k = Math.max(k, 1 - w.local / CUT);
  if (SHOTS[w.index + 1]?.id === "title") k = Math.max(k, 1 - left / FADE_OUT);
  else k = Math.max(k, 1 - left / CUT);
  return Math.min(1, Math.max(0, k));
}
