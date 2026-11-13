// Which game this page load runs: v1 (the first economy, live since 11 Nov) or v2 (docs/GAME.md). v1 is the
// default until v2 passes its checks; `?game=v2` (or `?game=v1`) picks one for a visit, and VITE_GAME sets the
// default for a deployment. v2 has its own contract (VITE_CONTRACT_ID_V2) and, without one or with `?mock`, runs on
// its offline mock.
import { type EconomyConfig, resolveConfig } from "../config";

export type GameVersion = "v1" | "v2";

export function readGame(env: Record<string, unknown>, search: string): GameVersion {
  const q = (new URLSearchParams(search).get("game") ?? "").trim().toLowerCase();
  if (q === "v1" || q === "v2") return q;
  return typeof env.VITE_GAME === "string" && env.VITE_GAME.trim().toLowerCase() === "v2" ? "v2" : "v1";
}

/** v2's config: the same rules as v1's (testnet only, https RPCs, a valid account id), on v2's contract. */
export function resolveV2Config(env: Record<string, unknown>, search: string): EconomyConfig {
  return resolveConfig({ ...env, VITE_CONTRACT_ID: env.VITE_CONTRACT_ID_V2 }, search);
}
