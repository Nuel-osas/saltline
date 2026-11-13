// Saltline v2's entry (docs/GAME.md): an extraction shooter where guns are NFTs and the invoice summons the
// Bailiff. main.ts calls startV2 instead of v1's modules when the page runs v2. Each part is guarded: one that fails
// leaves the rest, and the shooter itself, running.
import { startArsenal } from "../arsenal";
import { startBailiff } from "../bailiff";
import { startScore } from "../score";

/* eslint-disable @typescript-eslint/no-explicit-any -- the game context is the untyped bundle's G */
type Game = any;

const guard = (what: string, fn: () => void) => {
  try {
    fn();
  } catch (e) {
    console.warn(`[v2] ${what} off:`, e);
  }
};

export function startV2(G: Game): void {
  guard("arsenal", () => startArsenal(G)); // breaker charge, rifle butt, pickups (G.arsenal)
  guard("bailiff", () => startBailiff(G)); // the hunter (G.bailiff)
  guard("score", () => startScore(G)); // the music (G.score)
  // The chain client and its offline mock (G.v2), the raid and the dock attach here as their lanes land.
  console.info("[v2] started");
}
