// The economy layer's entry point. It loads after src/game.js and attaches to the game's shared context
// (window.__G) once the game has booted. The shooter never depends on it: if anything here fails, the game plays on
// without an economy.
import { createTestnetChain } from "./chain";
import { type EconomyConfig, readConfig } from "./config";
import { type MockChain, createMockChain, createMockWallet } from "./mock";
import { startSalvage } from "./salvage";
import { startStory } from "./story";
import type { Economy } from "./types";
import { type GuestWallet, createGuestWallet } from "./wallet";

type GameContext = {
  events?: { on(name: string, fn: (e: unknown) => void): () => void; emit(name: string, e?: unknown): void };
  economy?: Economy;
} & Record<string, unknown>;

declare global {
  interface Window {
    __G?: GameContext;
    __ready?: boolean;
  }
}

/** Seconds between the offline mock's ambient ticks (other players and the brokers' agents). */
const AMBIENT_TICK = 3;

/** The chain and wallet for this config: the offline mock, or testnet with the guest wallet. */
export function buildEconomy(cfg: EconomyConfig): { economy: Economy; mock: MockChain | null } {
  if (cfg.mode === "mock") {
    const mock = createMockChain(cfg.mockSeed, { warmupSeconds: 240 });
    return { economy: { chain: mock, wallet: createMockWallet(mock), manifest: null, carried: {} }, mock };
  }
  let wallet: GuestWallet | null = null;
  const chain = createTestnetChain({ config: cfg, keys: () => wallet?.signingKey() ?? null });
  wallet = createGuestWallet({ faucetUrl: cfg.faucetUrl, lookup: chain });
  return { economy: { chain, wallet, manifest: null, carried: {} }, mock: null };
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
    const cfg = readConfig();
    const { economy, mock } = buildEconomy(cfg);
    G.economy = economy;
    if (mock) {
      setInterval(() => {
        if (!document.hidden) mock.ambient(AMBIENT_TICK);
      }, AMBIENT_TICK * 1000);
    }

    startSalvage(G); // in-run salvage (src/economy/salvage); guarded inside
    // The story (src/economy/story): briefing, radio, the Harbormaster, the town's lights. Guarded inside. Started
    // before the Dockside so its key and click capture runs ahead of the deploy gate's while the briefing is up.
    startStory(G);
    // The Dockside, the between-runs market (src/economy/dockside). Guarded: if it fails, the shooter plays on.
    import("./dockside/mount").then((d) => d.mount(G)).catch((e) => console.warn("[dockside] off:", e));

    console.info(cfg.mode === "mock" ? "[economy] offline mock: not the chain" : `[economy] testnet, contract ${cfg.contractId}`);
    G.events?.emit("economy:ready", economy);
  })
  .catch((e) => console.warn("[economy] off:", e));
