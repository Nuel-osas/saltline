// The dock: Saltline v2's hub screens (docs/GAME.md → The loop). The lead's entry point calls mountDock(G) once the
// game has booted. It uses the chain client and wallet that v2 attaches to the game (G.v2). In dev, when nothing has
// attached after two seconds, it runs on the stand-in in fake.ts so the screens can be built and checked; a
// production build without G.v2 waits for `v2:ready` and otherwise shows no dock, rather than a made-up one.
import type { V2 } from "../types";
import { createDock, type Dock, type GameLike } from "./dock";

type Ctx = GameLike & { v2?: V2 };

const waitFor = async (G: Ctx, ms: number) => {
  for (let t = 0; t < ms && !G.v2; t += 100) await new Promise((r) => setTimeout(r, 100));
  return G.v2;
};

export async function mountDock(game: object): Promise<Dock | null> {
  const G = game as Ctx;
  let v2: V2 | undefined = G.v2 ?? (await waitFor(G, 2000));
  let fake: unknown = null;
  if (!v2 && import.meta.env.DEV) {
    const { createFake } = await import("./fake");
    const q = new URLSearchParams(location.search);
    // ?dock=new: a first-time player, to see the pass card. ?latency=<ms>: how long the stand-in's calls take.
    v2 = createFake({ registered: q.get("dock") !== "new", latency: q.has("latency") ? +q.get("latency")! : undefined });
    fake = v2;
    console.info("[dock] no chain client attached: running on the dev stand-in (fake.ts), not the chain");
  }
  if (!v2) {
    // The chain client is late or absent: mount if it ever announces itself.
    return new Promise((resolve) => {
      const on = G.events?.on;
      if (!on) return resolve(null);
      let done = false;
      on.call(G.events, "v2:ready", ((ready: V2) => {
        if (done) return;
        done = true;
        resolve(createDock(G, G.v2 ?? ready));
      }) as never);
    });
  }
  const dock = createDock(G, v2);
  if (import.meta.env.DEV) (window as unknown as { __dock2: unknown }).__dock2 = { dock, v2, fake };
  return dock;
}
