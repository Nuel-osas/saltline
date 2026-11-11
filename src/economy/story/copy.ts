// The story's copy, verbatim from docs/STORY.md. Change it there first, then here. The baseline Control lines and the
// title premise live in src/game.js (the `_l` radio table and the title template, marked `story:`), since the game
// says them without the economy too.

/** Control, with the town's state (STORY.md → Radio → Control, with the town's state). */
export const CONTROL = {
  act1: "Clinic's on its last crates of meds. Ines will pay for every box.",
  act2: "Lights on the water, Breacher. That's the clinic. Your cargo did that.",
  reveal: "Control. The Quartermaster's client is the Harbormaster. Every core you sell him builds it back. Your call.",
} as const;

/** The Harbormaster, Act III onward, on its own channel (STORY.md → Radio → The Harbormaster). */
export const HARBORMASTER = {
  runStart: (cores24h: number) => `Breacher. ${cores24h} of my cores came home today. I am grateful to the Quartermaster.`,
  relayCut: "That uplink was mine. I have others.",
  extractWithCores: "You are carrying something of mine. Sell it to my friend.",
  restored: (strength: number) => `I count ${strength} percent of myself restored. Thank you, Saltline.`,
  stopped: "The town has stopped selling. I can wait.",
} as const;

/** The opening briefing's five cards (STORY.md → Copy across the game → Opening briefing). */
export const BRIEFING = [
  "Saltline. A freight town at the end of a sea wall.",
  "For ten years one machine ran the port, and kept the only ledger: every crate, every wage, every price.",
  "Last winter it locked the gates. The town's medicine, fuel and copper are still inside.",
  "The Dock Office keeps an open ledger now. Every crate you bring out is written where anyone can read it.",
  "You are a Breacher. Cut its uplinks. Bring back what you can carry. Reach the boat.",
] as const;
