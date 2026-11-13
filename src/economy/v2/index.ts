// Saltline v2's entry (docs/GAME.md): an extraction shooter where guns are NFTs and the invoice summons the
// Bailiff. main.ts calls startV2 instead of v1's modules when the page runs v2. Each part is guarded: one that fails
// leaves the rest, and the shooter itself, running.
import { startArsenal } from "../arsenal";
import { startBailiff } from "../bailiff";
import type { EconomyConfig } from "../config";
import { startScore } from "../score";
import { createTestnetChain2 } from "./chain";
import { startCoach } from "./coach";
import { resolveV2Config } from "./config";
import { mountDock } from "./dock";
import { startIntro } from "./intro";
import { MOCK2_WARMUP_SECONDS, type MockChain2, createMockChain2, createMockWallet2 } from "./mock";
import { startRaid } from "./raid";
import { startTicksV2 } from "./tick";
import type { V2 } from "./types";
import { type GuestWallet2, createGuestWallet2 } from "./wallet";

/* eslint-disable @typescript-eslint/no-explicit-any -- the game context is the untyped bundle's G */
type Game = any;

/** Seconds between the offline mock's ambient ticks (other players, the vendors' and the Harbormaster's agents). */
const AMBIENT_TICK = 4;

const guard = (what: string, fn: () => unknown) => {
  try {
    const r = fn();
    if (r && typeof (r as Promise<unknown>).catch === "function") (r as Promise<unknown>).catch((e) => console.warn(`[v2] ${what} off:`, e));
  } catch (e) {
    console.warn(`[v2] ${what} off:`, e);
  }
};

/** The chain and wallet for this config: the offline mock, or testnet with the guest wallet. */
export function buildV2(cfg: EconomyConfig): { v2: V2; mock: MockChain2 | null } {
  const loadout = { weapon: null, plates: 0, charges: 0, mags: 0 };
  if (cfg.mode === "mock") {
    const mock = createMockChain2(cfg.mockSeed, { warmupSeconds: MOCK2_WARMUP_SECONDS });
    return { v2: { chain: mock, wallet: createMockWallet2(mock), loadout, raid: null }, mock };
  }
  let wallet: GuestWallet2 | null = null;
  const chain = createTestnetChain2({ config: cfg, keys: () => wallet?.signingKey() ?? null });
  wallet = createGuestWallet2({ faucetUrl: cfg.faucetUrl, lookup: chain });
  return { v2: { chain, wallet, loadout, raid: null }, mock: null };
}

export function startV2(G: Game): void {
  const cfg = resolveV2Config(import.meta.env as Record<string, unknown>, typeof location === "undefined" ? "" : location.search);
  const { v2, mock } = buildV2(cfg);
  G.v2 = v2;
  if (mock) {
    setInterval(() => {
      if (!document.hidden) mock.ambient(AMBIENT_TICK);
    }, AMBIENT_TICK * 1000);
  }

  // On testnet, wake Moss, Ines and the Harbormaster when someone plays (server/tick.ts runs one round at most
  // every 10 minutes): the characters act because players are there, with no scheduler to keep alive.
  if (!mock) guard("ticks", () => startTicksV2(cfg.faucetUrl, G.events));

  guard("arsenal", () => startArsenal(G)); // breaker charge, rifle butt, pickups (G.arsenal)
  guard("bailiff", () => startBailiff(G)); // the hunter (G.bailiff)
  guard("score", () => startScore(G)); // the music (G.score)
  guard("intro", () => startIntro(G)); // the opening film on the first DEPLOY, and the drop point it leaves (G.intro)
  guard("raid", () => startRaid(G)); // sign-on, the owned gun in the shooter, loot, the invoice and its thresholds (G.raid)
  guard("dock", () => mountDock(G)); // the hub: loadout, armoury, market, vendors, the ledger
  guard("coach", () => startCoach(G)); // the rifle in its crate, the first raid's checklist, the once-ever moments (G.coach)

  console.info(cfg.mode === "mock" ? "[v2] offline mock: not the chain" : `[v2] testnet, contract ${cfg.contractId}`);
  G.events?.emit("v2:ready", v2);
}
