// The story's copy, verbatim from docs/STORY.md. Change it there first, then here. The baseline Control lines and the
// title premise live in src/game.js (the `_l` radio table and the title template, marked `story:`), since the game
// says them without the economy too.
//
// Lines with live numbers are templates: `{name}` is filled by fill() below, and a line whose number is unknown is
// dropped, never said with a guess.

/** What Control calls a player with no dock pass (STORY.md → Radio). */
export const CALLSIGN_FALLBACK = "Breacher";

/** Control, with the town's state (STORY.md → Radio → Control, with the town's state). */
export const CONTROL = {
  act1: "Clinic's down to its last crates of meds. Ines will pay for every box. She'll complain about it.",
  act2: "Lights on the water, {callsign}. That's the clinic. Your cargo did that. Don't let it go to your head.",
  reveal: "Control. The Quartermaster's client is the Harbormaster. Every core you sell him, it builds into something. Your call.",
} as const;

/** The Harbormaster, from Chapter 1 onward, on its own channel (STORY.md → Radio → The Harbormaster). */
export const HARBORMASTER = {
  /** A run starts. `{fee}` is trespassFee(): flavour, never charged. */
  trespass:
    "Good morning, Breacher {callsign}. Your visit is not authorised. A trespass surcharge of {fee} scrip has been added to your account.",
  sealCut: "Tampering with a customs seal. Fee applied. Please retain this message for your records.",
  relayCut: "That uplink was ours. We have others.",
  /** The player takes cargo past 4 weight. */
  evidence: "You are now carrying {weight} units of evidence. Thank you.",
  /** Extraction with cargo; `{haul}` is the debrief's value. */
  invoice: "Removal of goods noted. An invoice for {haul} scrip will follow. It will not be paid. We will send it anyway.",
  /** Chapter 3, run start. */
  coresHome: "{cores_24h} of our cores came home today. We are grateful to our Quartermaster.",
  /** Strength above 75. */
  restored: "We count {strength} percent of ourselves restored. Thank you, Saltline. Your account is in good standing.",
  /** Strength below 10 after being above 50. */
  stopped: "The town has stopped selling. We can wait. Interest accrues.",
} as const;

/** The opening briefing's five cards (STORY.md → Copy across the game → Opening briefing). */
export const BRIEFING = [
  "Saltline. A freight town at the end of a sea wall.",
  "For ten years one machine ran the port, and kept the only ledger: every crate, every wage, every price.",
  "When its owners went bankrupt, it checked the regulations, and impounded the town as unclaimed cargo.",
  "The Dock Office keeps an open ledger now. Every crate you bring out is written where anyone can read it.",
  "You are a Breacher. Cut its uplinks. Bring back what you can carry. Do not pay the invoices.",
] as const;

export type Fill = Record<string, string | number | null | undefined>;

/**
 * The template with each `{name}` filled from `values`, or null when any of them is unknown: missing, null, an empty
 * string, or a number that isn't a finite non-negative integer. A line never goes out with a hole or a guess in it.
 */
export function fill(template: string, values: Fill = {}): string | null {
  let unknown = false;
  const out = template.replace(/\{(\w+)\}/g, (_, name: string) => {
    const v = values[name];
    if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return String(v);
    if (typeof v === "string" && v.trim()) return v.trim();
    unknown = true;
    return "";
  });
  return unknown ? null : out;
}

/** A callsign fit to say on the radio: the dock pass's, trimmed; anything else is none. */
export function cleanCallsign(c: unknown): string | null {
  if (typeof c !== "string") return null;
  const t = c.trim();
  return t && t.length <= 32 ? t : null;
}

/** The callsign Control uses: the dock pass's, or "Breacher" without one. */
export const callsignOr = (callsign: string | null | undefined): string =>
  typeof callsign === "string" && callsign.trim() ? callsign.trim() : CALLSIGN_FALLBACK;

/**
 * The trespass surcharge the Harbormaster quotes at a run's start: 150 + 25 × the player's extractions so far, from
 * their profile. Null (the line is dropped) when the profile is unknown or doesn't hold a count.
 */
export function trespassFee(profile: { extractions?: unknown } | null | undefined): number | null {
  const n = profile?.extractions;
  return typeof n === "number" && Number.isSafeInteger(n) && n >= 0 ? 150 + 25 * n : null;
}
