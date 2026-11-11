// Which story lines a run gets, from the town's state (docs/STORY.md → Radio). Pure, so the rules can be tested:
//
// - A failed town read says nothing that depends on the town. A missing town() is the start of the story (Act I).
// - Control: the Act I line on the first run of a visit; "Lights on the water" the first time a player sees Act II or
//   later; the reveal the first time after it. The last two are once ever (remembered in StoryMemory.heard).
// - The Harbormaster (Act III only, its own channel), one line at run start, by priority:
//   1. "stopped" when strength is under 10 after having been above 50 (and the peak starts over);
//   2. "restored" when strength is above 75;
//   3. "cores" with the count of relay cores sold to the Quartermaster in the last 24 hours, when that count is known
//      and above zero.
//   Mid-run, it answers the first relay cut, and an extraction that carries cores.
import type { LedgerEvent } from "../types";
import { CONTROL, HARBORMASTER } from "./copy";
import { actOf, known, strengthOf, type TownRead } from "./town";

export type Speaker = "control" | "harbormaster";
export interface Line {
  who: Speaker;
  text: string;
}

export interface RunStartInput {
  read: TownRead | null;
  /** Once-ever lines already said (StoryMemory.heard). */
  heard: readonly string[];
  /** Lines already said this visit. */
  session: readonly string[];
  /** StoryMemory.peak. */
  peak: number;
  /** Relay cores sold to the Quartermaster in the last 24 hours, or null when unknown. */
  cores24h: number | null;
}

export interface RunStartLines {
  lines: Line[];
  /** The once-ever ids to remember. */
  heard: string[];
  /** The this-visit ids to remember. */
  session: string[];
  peak: number;
}

export function runStartLines({ read, heard, session, peak, cores24h }: RunStartInput): RunStartLines {
  const out: RunStartLines = { lines: [], heard: [], session: [], peak };
  if (!known(read)) return out; // unknown town: no line that depends on it
  const act = actOf(read);
  const control = (text: string) => out.lines.push({ who: "control", text });
  if (act === 1 && !session.includes("act1")) {
    control(CONTROL.act1);
    out.session.push("act1");
  }
  if (act >= 2 && !heard.includes("act2")) {
    control(CONTROL.act2);
    out.heard.push("act2");
  }
  if (act >= 3 && !heard.includes("reveal")) {
    control(CONTROL.reveal);
    out.heard.push("reveal");
  }
  if (act === 3) {
    const s = strengthOf(read);
    const hm = (text: string) => out.lines.push({ who: "harbormaster", text });
    if (s < 10 && peak > 50) {
      hm(HARBORMASTER.stopped);
      out.peak = s;
      return out;
    }
    if (s > 75) hm(HARBORMASTER.restored(s));
    else if (cores24h !== null && cores24h > 0) hm(HARBORMASTER.runStart(cores24h));
    out.peak = Math.max(peak, s);
  }
  return out;
}

/** True when the Harbormaster speaks mid-run: Act III, read for this run. */
export const harbormasterAwake = (read: TownRead | null) => !!read && read.status === "ok" && read.view.act === 3;

const DAY = 24 * 3_600_000;
// The contract and the mock write "<callsign> sold 3 relay cores to Quartermaster for 480."; the Dockside's dev fake
// writes "<callsign> sold CORE ×3 to Quartermaster for 480".
const SOLD_CORES = [/\bsold (\d+) relay cores? to (?:the )?Quartermaster\b/i, /\bsold CORE ×(\d+) to (?:the )?Quartermaster\b/];

/**
 * Relay cores sold to the Quartermaster in the 24 hours before `now`, from `recent(limit)`. Null when the window
 * isn't all there: the ledger keeps the last `limit` events, so a full page that doesn't reach back a day is a lower
 * bound, and the Harbormaster doesn't round down.
 */
export function coresSold24h(events: readonly LedgerEvent[] | null | undefined, now: number, limit: number): number | null {
  if (!Array.isArray(events)) return null;
  const from = now - DAY;
  let n = 0;
  let oldest = Infinity;
  for (const e of events) {
    if (!e || typeof e.at !== "number" || !Number.isFinite(e.at)) return null;
    oldest = Math.min(oldest, e.at);
    if (e.kind !== "sale" || e.at < from || e.at > now + 60_000 || typeof e.text !== "string") continue;
    for (const re of SOLD_CORES) {
      const m = re.exec(e.text);
      if (m) {
        n += Number(m[1]);
        break;
      }
    }
  }
  if (events.length >= limit && oldest >= from) return null;
  return n;
}
