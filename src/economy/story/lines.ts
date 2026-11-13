// Which story lines a run gets, from the town's state and the player's profile (docs/STORY.md → Radio). Pure, so the
// rules can be tested:
//
// - A failed town read says nothing that depends on the town. A missing town() is the start of the story (Chapter 1).
// - Control: the Chapter 1 line on the first run of a visit; "Lights on the water" the first time a player sees
//   Chapter 2 or later; the reveal the first time after it. The last two are once ever (remembered in
//   StoryMemory.heard). `{callsign}` is the dock pass's, or "Breacher".
// - The Harbormaster bills from Chapter 1 on, on its own channel. At run start:
//   1. the trespass surcharge, `{fee} = 150 + 25 × extractions` from profile(); an unknown profile drops it (and with
//      it the callsign it would address);
//   2. in Chapter 3 only, one line by priority: "stopped" when strength is under 10 after having been above 50 (and
//      the peak starts over); "restored" when strength is above 75; "cores home" with the relay cores sold to the
//      Quartermaster in the last 24 hours, when that count is known and above zero.
//   Mid-run it answers the first seal and the first relay cut, a load past 4 weight, and an extraction with cargo
//   (with the debrief's value). index.ts keeps them once a run and pacing.ts spaces them out.
import type { LedgerEvent } from "../types";
import { CONTROL, HARBORMASTER, callsignOr, fill } from "./copy";
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
  /** The dock pass callsign, or null when there's none or it's unknown. */
  callsign?: string | null;
  /** The trespass surcharge (copy.ts trespassFee), or null when the profile is unknown. */
  fee?: number | null;
}

export interface RunStartLines {
  lines: Line[];
  /** The once-ever ids to remember. */
  heard: string[];
  /** The this-visit ids to remember. */
  session: string[];
  peak: number;
}

export function runStartLines({ read, heard, session, peak, cores24h, callsign = null, fee = null }: RunStartInput): RunStartLines {
  const out: RunStartLines = { lines: [], heard: [], session: [], peak };
  const control = (text: string | null) => text && out.lines.push({ who: "control", text });
  const hm = (text: string | null) => text && out.lines.push({ who: "harbormaster", text });
  const act = known(read) ? actOf(read) : null; // unknown town: no line that depends on it
  if (act === 1 && !session.includes("act1")) {
    control(CONTROL.act1);
    out.session.push("act1");
  }
  if (act !== null && act >= 2 && !heard.includes("act2")) {
    control(fill(CONTROL.act2, { callsign: callsignOr(callsign) }));
    out.heard.push("act2");
  }
  if (act === 3 && !heard.includes("reveal")) {
    control(CONTROL.reveal);
    out.heard.push("reveal");
  }
  // The surcharge needs the profile, not the town: it's billed whatever the ledger says, and dropped when the profile
  // (so the fee and the name on the account) is unknown.
  hm(fill(HARBORMASTER.trespass, { callsign, fee }));
  if (act === 3) {
    const s = strengthOf(read);
    if (s < 10 && peak > 50) {
      hm(HARBORMASTER.stopped);
      out.peak = s;
    } else {
      if (s > 75) hm(fill(HARBORMASTER.restored, { strength: s }));
      else if (cores24h !== null && cores24h > 0) hm(fill(HARBORMASTER.coresHome, { cores_24h: cores24h }));
      out.peak = Math.max(peak, s);
    }
  }
  return out;
}

/** Carry weight past which the Harbormaster counts the evidence (STORY.md: "past 4 weight"). */
export const EVIDENCE_WEIGHT = 4;

/** The evidence line when this take carried the load past 4 weight, else null. `before` null means unknown. */
export function evidenceLine(before: number | null | undefined, after: unknown): string | null {
  if (typeof after !== "number" || !(after > EVIDENCE_WEIGHT)) return null;
  if (typeof before === "number" && before > EVIDENCE_WEIGHT) return null;
  return fill(HARBORMASTER.evidence, { weight: after });
}

/** The relay line on the first cut of a run, if there's more than one relay (later cuts get Control alone). */
export const relayLine = (index: unknown, total: unknown): string | null =>
  index === 1 && typeof total === "number" && total > 1 ? HARBORMASTER.relayCut : null;

/** The invoice for an extraction with cargo, with the debrief's value; null when that value is unknown. */
export const invoiceLine = (haul: number | null | undefined): string | null => fill(HARBORMASTER.invoice, { haul });

/** True in Chapter 3, read for this run: the Harbormaster's strength lines and the dilemma. */
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
