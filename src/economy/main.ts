// The economy layer's entry point. It loads after src/game.js and attaches to the game's shared context
// (window.__G) once the game has booted. The shooter never depends on it: if anything here fails, the game plays on
// without an economy.

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
    G.events?.emit("economy:ready", {});
    // The Dockside, the between-runs market (src/economy/dockside). Guarded: if it fails, the shooter plays on.
    import("./dockside/mount").then((d) => d.mount(G)).catch((e) => console.warn("[dockside] off:", e));
  })
  .catch((e) => console.warn("[economy] off:", e));

export {};
