// The Harbormaster's extra drones (docs/STORY.md → The dilemma → The fight). game.js reads G.ext.waveBonus where it
// builds the patrol and each wave and where it caps the drones alive (its `// ext:` hooks):
//   patrol and every wave: + gull gulls and + hound hounds; maxAlive: + alive.
// A wave's extra drones are at most one hound for every two gulls.
import { MAX_BONUS } from "./town";

export interface WaveBonus {
  gull: number;
  hound: number;
  /** Added to the cap on drones alive at once. */
  alive: number;
}

export const NO_BONUS: Readonly<WaveBonus> = Object.freeze({ gull: 0, hound: 0, alive: 0 });

/** `n` extra drones (clamped to 0–4, whole) split into gulls and hounds, at most a hound per two gulls. */
export function waveBonus(n: number): WaveBonus {
  const total = Number.isFinite(n) ? Math.max(0, Math.min(MAX_BONUS, Math.floor(n))) : 0;
  const hound = Math.floor(total / 3);
  return { gull: total - hound, hound, alive: total };
}
