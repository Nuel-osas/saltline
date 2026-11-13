// The Harbormaster waits its turn (docs/STORY.md → Radio). Its billing lines go through this queue rather than
// straight onto the radio, so that:
// - it never talks over Control: a line goes out only when the radio is idle (nothing playing, nothing queued);
// - two of its lines never stack: a line goes out only once `gapMs` (about 8 s) have passed since its last line ended,
//   whoever said that line (the boss says its own straight through the channel, and that counts too);
// - a line that waited too long for its turn is dropped rather than said out of place (each has its own deadline),
//   and of the lines waiting, the one with the nearest deadline goes first: an answer to a relay cut can't wait,
//   the morning's surcharge can.
// Pure apart from the clock and the radio it's given, so the rule can be tested.
import type { Line } from "./lines";

export const HM_GAP_MS = 8_000;
/** Most lines waiting at once; a later one is dropped while the queue is full. */
const MAX_WAITING = 4;

export interface PacerDeps {
  now(): number;
  /** The radio is saying a line or holding one in its queue. */
  busy(): boolean;
  /** When the Harbormaster's last line ended on the radio (ms on now()'s clock), or -Infinity. */
  lastHarbormasterEnd(): number;
  say(line: Line, seconds: number): void;
  gapMs?: number;
}

export interface Pacer {
  /** Wait for a turn; dropped if none comes within `ttl` ms. */
  add(text: string | null | undefined, opts?: { seconds?: number; ttl?: number }): void;
  /** Say the next line if its turn has come. Call every frame. */
  tick(): void;
  /** Forget every waiting line (a run ended or started over). */
  clear(): void;
  readonly waiting: number;
}

export function createPacer(deps: PacerDeps): Pacer {
  const gap = deps.gapMs ?? HM_GAP_MS;
  let queue: { text: string; seconds: number; until: number }[] = [];
  /** When this pacer last put a line on the radio: the radio's own clock only starts once the line does. */
  let saidAt = -Infinity;
  return {
    add(text, { seconds = 4.6, ttl = 12_000 } = {}) {
      if (!text || queue.length >= MAX_WAITING || queue.some((q) => q.text === text)) return;
      queue.push({ text, seconds, until: deps.now() + ttl });
    },
    tick() {
      if (!queue.length) return;
      const now = deps.now();
      queue = queue.filter((q) => q.until >= now);
      if (!queue.length || deps.busy()) return;
      if (now - Math.max(deps.lastHarbormasterEnd(), saidAt) < gap) return;
      let at = 0;
      for (let i = 1; i < queue.length; i++) if (queue[i].until < queue[at].until) at = i;
      const [next] = queue.splice(at, 1);
      saidAt = now;
      deps.say({ who: "harbormaster", text: next.text }, next.seconds);
    },
    clear() {
      queue = [];
    },
    get waiting() {
      return queue.length;
    },
  };
}
