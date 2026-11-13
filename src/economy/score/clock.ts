// The score's bar maths. Time is counted in sixteenth-note steps from an anchor on the audio clock; everything the
// engine schedules lands on a step, and states change on a half-bar line so layers enter and leave in time.
import { STEPS_PER_BAR, TEMPO } from "./theme";

/** Seconds a sixteenth lasts. */
export const STEP = 60 / TEMPO.bpm / TEMPO.stepsPerBeat;
export const BAR = STEP * STEPS_PER_BAR;
/** How far ahead of the audio clock notes are scheduled, and how often the timer looks (seconds). */
export const LOOKAHEAD = 0.2;
export const TIMER = 0.05;
/** States change on a multiple of this many steps: the half bar. */
export const LATCH = STEPS_PER_BAR / 2;

/** When step `n` sounds, for a clock anchored at `t0`. */
export const stepTime = (n: number, t0: number): number => t0 + n * STEP;

/** Where a step falls: its bar, its beat in the bar, and its sixteenth in the bar (all from 0). */
export function position(step: number): { bar: number; beat: number; inBar: number } {
  const inBar = ((step % STEPS_PER_BAR) + STEPS_PER_BAR) % STEPS_PER_BAR;
  return { bar: Math.floor(step / STEPS_PER_BAR), beat: Math.floor(inBar / TEMPO.stepsPerBeat), inBar };
}

/** The first step at or after `step` that sits on a line every `every` steps. */
export const nextLine = (step: number, every: number): number => Math.ceil(step / every) * every;

/**
 * The steps to schedule now: from `next` up to (not including) the first one that sounds at or after `until`.
 * Called every TIMER seconds with `until` = now + LOOKAHEAD, each step is returned exactly once.
 */
export function due(next: number, t0: number, until: number): number[] {
  const out: number[] = [];
  for (let n = next; stepTime(n, t0) < until; n++) out.push(n);
  return out;
}

/**
 * A new anchor after the clock fell behind (the tab was hidden, the context suspended): step `next` is moved to
 * sound at `now + lead`, so the music picks up where it was instead of racing to catch up.
 */
export const reanchor = (next: number, now: number, lead = 0.06): number => now + lead - next * STEP;

/** True when step `next` should already have sounded: the clock has to be re-anchored. */
export const behind = (next: number, t0: number, now: number): boolean => stepTime(next, t0) < now - 0.005;
