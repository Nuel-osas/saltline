// The Bailiff's lines, verbatim from docs/CAMPAIGN.md → The Bailiff → Lines. They play on the Harbormaster's channel
// under the label BAILIFF. Change them there first, then here.

export const CHIP_LABEL = "BAILIFF";

export type LineId = "released" | "near" | "grab" | "staggered" | "recovered" | "lost";

/** "Breacher {callsign}." with the dock pass callsign; plain "Breacher." without one (never "Breacher Breacher"). */
export const released = (callsign: string | null) =>
  `Breacher${callsign ? " " + callsign : ""}. You are in arrears. An officer has been dispatched to collect.`;

export const LINES = {
  near: "Please remain where you are.",
  grab: "You are being repossessed.",
  staggered: "Service has been interrupted.",
  recovered: "Service of the writ will now resume.",
  lost: "Your location has been noted. It is in the schedule.",
} as const;

/** Seconds each line is held on the radio after it has typed out. */
export const HOLD: Record<LineId, number> = { released: 4.6, near: 2.6, grab: 2.2, staggered: 2.8, recovered: 2.8, lost: 3.6 };

/**
 * How long each line may wait for a quiet radio (ms) before it is dropped as stale: a line about a grab is no use two
 * seconds after the clamp has closed, while the release can wait out Control's reaction to the cut, and "remain where
 * you are" holds good for as long as it is still coming.
 */
export const TTL: Record<LineId, number> = { released: 30_000, near: 15_000, grab: 2_500, staggered: 4_000, recovered: 4_000, lost: 8_000 };

/** Every line plays at most once a run, except the grab's, which may come again after this long (ms). */
export const GRAB_REPEAT_MS = 20_000;

export interface Voice {
  /** Asks for a line. Returns its text if it may play now, or null (already said this run, or the grab's too soon). */
  ask(id: LineId, callsign?: string | null): string | null;
  /** A new run: every line may play again. */
  reset(): void;
  /** True if `text` is one of the Bailiff's lines said this run (the radio relabels it). */
  owns(text: string): boolean;
}

/** The once-a-run rule, on a clock the tests can drive. */
export function createVoice(now: () => number = () => performance.now()): Voice {
  const said = new Map<LineId, number>();
  const texts = new Set<string>();
  return {
    ask(id, callsign = null) {
      const last = said.get(id);
      const t = now();
      if (last !== undefined && (id !== "grab" || t - last < GRAB_REPEAT_MS)) return null;
      said.set(id, t);
      const text = id === "released" ? released(callsign) : LINES[id];
      texts.add(text);
      return text;
    },
    reset() {
      said.clear();
      texts.clear();
    },
    owns: (text) => texts.has(text),
  };
}
