// The economy layer's entry point. It loads after src/game.js and attaches to the game's shared context
// (window.__G) once the game has booted. The shooter never depends on it: if anything here fails, the game plays on
// without an economy.
import { startSalvage } from "./salvage";

type GameContext = { events?: { on(name: string, fn: (e: unknown) => void): () => void; emit(name: string, e?: unknown): void } } & Record<string, unknown>;

declare global {
  interface Window {
    __G?: GameContext;
    __ready?: boolean;
  }
}

function whenBooted(): Promise<GameContext> {
  return new Promise((resolve) => {
    const poll = () => (window.__G && window.__ready ? resolve(window.__G) : setTimeout(poll, 100));
    poll();
  });
}

whenBooted()
  .then((G) => {
    if (G.params && typeof G.params === "object" && "noeconomy" in G.params) return; // ?noeconomy: the baseline game
    G.events?.emit("economy:ready", {});
    startSalvage(G); // in-run salvage; guarded inside, and on the lane's fake chain until G.economy is set
  })
  .catch((e) => console.warn("[economy] off:", e));

export {};
