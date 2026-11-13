// The Assessor's lines, verbatim from docs/STORY.md → The boss: the Assessor → What it says. They play on the
// Harbormaster's channel. Change them there first, then here.

export const ASSESSOR_BAR = "THE ASSESSOR · FINAL NOTICE";

export type LineId = "arrival" | "firstCore" | "lastCore" | "defeat" | "death";

/** "Breacher {callsign}." with the dock pass callsign; plain "Breacher." without one (never "Breacher Breacher"). */
export const arrival = (callsign: string | null) =>
  `Breacher${callsign ? " " + callsign : ""}. We have assessed your conduct. The Assessor will now deliver our findings in person.`;

export const LINES = {
  firstCore: "That component is town property, purchased in good faith from our Quartermaster.",
  lastCore: "This will be reflected in your file.",
  /** Cut off mid-word: the channel glitches as it goes. */
  defeat: "Claim denied. Claim denied. Cla",
  death: "Thank you for your cooperation. Your remains have been logged as cargo.",
} as const;
