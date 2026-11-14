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
import type { Dock } from "./dock/dock";
import { startHome } from "./home";
import { startIntro } from "./intro";
import { type Login, startLogin } from "./login";
import { sessionUrlFor, withToken } from "./login/session";
import { metricsUrlFor, startMetrics } from "./metrics";
import { MOCK2_WARMUP_SECONDS, type MockChain2, createMockChain2, createMockWallet2 } from "./mock";
import { startRaid } from "./raid";
import { squadOn, startSquad } from "./squad";
import { startSight } from "./sight";
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

/**
 * The chain and wallet for this config: the offline mock, or testnet with the guest wallet. `token` is the sign-in
 * token to send with a dock-pass request (login/): absent, or answering null, the request goes without one.
 */
export function buildV2(cfg: EconomyConfig, token?: () => Promise<string | null>): { v2: V2; mock: MockChain2 | null; guest: GuestWallet2 | null } {
  const loadout = { weapon: null, plates: 0, charges: 0, mags: 0 };
  if (cfg.mode === "mock") {
    const mock = createMockChain2(cfg.mockSeed, { warmupSeconds: MOCK2_WARMUP_SECONDS });
    return { v2: { chain: mock, wallet: createMockWallet2(mock), loadout, raid: null }, mock, guest: null };
  }
  let wallet: GuestWallet2 | null = null;
  const chain = createTestnetChain2({ config: cfg, keys: () => wallet?.signingKey() ?? null });
  wallet = createGuestWallet2({ faucetUrl: cfg.faucetUrl, lookup: chain, ...(token ? { fetch: withToken(cfg.faucetUrl, token) } : {}) });
  return { v2: { chain, wallet, loadout, raid: null }, mock: null, guest: wallet };
}

export function startV2(G: Game): void {
  const cfg = resolveV2Config(import.meta.env as Record<string, unknown>, typeof location === "undefined" ? "" : location.search);
  // Sign-in is on when the build names a Privy app (VITE_PRIVY_APP_ID). Everyone signs in before they play, Practice
  // (the offline mock) included; there the sign-in only opens the door, because there is no wallet to fetch.
  const privyAppId = typeof import.meta.env.VITE_PRIVY_APP_ID === "string" ? import.meta.env.VITE_PRIVY_APP_ID.trim() : "";
  let login: Login | null = null;
  const { v2, mock, guest } = buildV2(cfg, async () => login?.token() ?? null);
  G.v2 = v2;
  if (mock) {
    setInterval(() => {
      if (!document.hidden) mock.ambient(AMBIENT_TICK);
    }, AMBIENT_TICK * 1000);
  }

  // On testnet, wake Moss, Ines and the Harbormaster when someone plays (server/tick.ts runs one round at most
  // every 10 minutes): the characters act because players are there, with no scheduler to keep alive.
  if (!mock) guard("ticks", () => startTicksV2(cfg.faucetUrl, G.events));
  // The studio's numbers (docs/DATA.md): a beacon for a visit, a sign-in, the dock and a raid's start and end, sent
  // only once a person is there. Started before the parts it listens to, so it hears their first events. It is
  // silent, and nothing below waits on it or reads from it (G.metrics).
  guard("metrics", () => startMetrics(G, { url: metricsUrlFor(cfg.faucetUrl), offline: !!mock, token: async () => login?.token() ?? null }));

  guard("arsenal", () => startArsenal(G)); // breaker charge, rifle butt, pickups (G.arsenal)
  guard("bailiff", () => startBailiff(G)); // the hunter (G.bailiff)
  guard("score", () => startScore(G)); // the music (G.score)
  guard("intro", () => startIntro(G)); // the opening film on the first DEPLOY, and the drop point it leaves (G.intro)
  guard("raid", () => startRaid(G)); // sign-on, the owned gun in the shooter, loot, the invoice and its thresholds (G.raid)
  let dock: Dock | null = null;
  guard("dock", () => Promise.resolve(mountDock(G)).then((d) => void (dock = d ?? null))); // the hub: loadout, armoury, market, vendors, the ledger
  guard("coach", () => startCoach(G)); // the rifle in its crate, the first raid's checklist, the once-ever moments (G.coach)
  guard("sight", () => startSight(G)); // the machines' signal lamps and threat markers, and the fair first raid (G.sight)

  // Last, so its lock wraps the raid's own start: nobody deploys or opens the dock before signing on (G.login).
  if (privyAppId) guard("login", () => void (login = startLogin(G, { appId: privyAppId, sheet: true, ...(guest ? { sessionUrl: sessionUrlFor(cfg.faucetUrl), wallet: guest } : {}) })));
  // The start screen: a lobby over the title card (G.home). Its buttons press the title's own, so everything above
  // starts as it did.
  // Skirmish is the offline game with fighting on (?mock&pvp=1): its own yard, so nobody in Practice can be shot.
  const skirmish = !!mock && typeof location !== "undefined" && new URLSearchParams(location.search).get("pvp") === "1";
  guard("home", () => startHome(G, { v2, offline: !!mock, skirmish, login: () => login, dock: () => dock }));

  // Live presence: other breachers in a raid right now appear in your yard (G.squad). Off for automated browsers.
  if (squadOn(typeof location === "undefined" ? "" : location.search, typeof navigator !== "undefined" && !!navigator.webdriver)) {
    let callsign = "BREACHER";
    const me = v2.wallet.accountId();
    // The callsign is on the player's record, which a new player only has once they sign on: look until it is there.
    let looks = 0;
    const look = () => {
      if (!me || ++looks > 24) return;
      void Promise.resolve()
        .then(() => v2.chain.profile(me))
        .then((p) => (p ? void (callsign = p.callsign) : void setTimeout(look, 5000)), () => void setTimeout(look, 5000));
    };
    look();
    guard("squad", () =>
      startSquad(G, {
        room: skirmish ? "yard-skirmish-v1" : mock ? "yard-practice-v1" : `yard-${cfg.contractId}`,
        pvp: skirmish, // shooting each other only where the player chose it and nothing is at stake (squad/index.ts says why)
        callsign: () => callsign,
        frame: () => (G.v2?.raid?.weapon ? String((G.v2.raid.weapon as { frame?: string }).frame ?? "issue") : "issue"),
      }),
    );
  }

  console.info(cfg.mode === "mock" ? "[v2] offline mock: not the chain" : `[v2] testnet, contract ${cfg.contractId}`);
  G.events?.emit("v2:ready", v2);
}
