// The story's copy, verbatim from docs/STORY.md. Change it there first, then here. The baseline Control lines and the
// title premise live in src/game.js (the `_l` radio table and the title template, marked `story:`), since the game
// says them without the economy too.

/** The opening briefing's five cards (STORY.md → Copy across the game → Opening briefing). */
export const BRIEFING = [
  "Saltline. A freight town at the end of a sea wall.",
  "For ten years one machine ran the port, and kept the only ledger: every crate, every wage, every price.",
  "Last winter it locked the gates. The town's medicine, fuel and copper are still inside.",
  "The Dock Office keeps an open ledger now. Every crate you bring out is written where anyone can read it.",
  "You are a Breacher. Cut its uplinks. Bring back what you can carry. Reach the boat.",
] as const;
