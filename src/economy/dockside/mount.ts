// Starts the Dockside from main.ts. It uses the economy the chain client attaches to the game (G.economy). In dev,
// until that exists, it runs on the local fake in fake.ts so the screen can be built and checked; a production build
// without an economy shows no Dockside rather than a made-up market.
import type { Economy } from "../types";
import { createDockside, type Dockside, type GameLike } from "./index";

type Ctx = GameLike & { economy?: Economy };

const waitFor = async (G: Ctx, ms: number) => {
  for (let t = 0; t < ms && !G.economy; t += 100) await new Promise((r) => setTimeout(r, 100));
  return G.economy;
};

export async function mount(game: object): Promise<Dockside | null> {
  const G = game as Ctx;
  let economy: Economy | undefined = G.economy ?? (await waitFor(G, 1500));
  let fake: unknown = null;
  if (!economy && import.meta.env.DEV) {
    const { createFakeEconomy } = await import("./fake");
    const q = new URLSearchParams(location.search);
    const f = createFakeEconomy({ registered: q.get("dock") === "registered", latency: q.has("latency") ? +q.get("latency")! : undefined });
    if (q.get("drift") !== "0") f.chain.start();
    economy = f;
    fake = f;
  }
  if (!economy) return null;
  const dockside = createDockside(G, economy);
  if (import.meta.env.DEV) (window as unknown as { __dock: unknown }).__dock = { dockside, economy, fake };
  return dockside;
}
