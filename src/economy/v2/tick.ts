// Wakes v2's characters (Moss, Ines, the Harbormaster) when someone plays: POST /api/tick?game=v2 (server/tick.ts).
// The pace and the rules are v1's (../tick.ts): fire and forget, at boot and when a raid ends, at most once every
// 10 minutes per browser. The browser's own record is kept apart from v1's, as the server's is.
import { startTicks, tickUrl } from "../tick";

export const tickUrlV2 = (faucetUrl: string): string => `${tickUrl(faucetUrl)}?game=v2`;

type Store = Pick<Storage, "getItem" | "setItem">;

export function startTicksV2(
  faucetUrl: string,
  events: { on(name: string, fn: (e: unknown) => void): unknown } | undefined,
  deps: { fetch?: typeof fetch; now?: () => number; storage?: Store } = {},
): () => void {
  const base = deps.storage ?? (typeof localStorage === "undefined" ? undefined : localStorage);
  // v1 keeps its last tick under one key; v2's goes beside it, so a v1 visit doesn't hold a v2 tick back.
  const storage: Store | undefined = base && { getItem: (k) => base.getItem(`${k}.game2`), setItem: (k, v) => base.setItem(`${k}.game2`, v) };
  return startTicks(tickUrlV2(faucetUrl), events, { ...deps, storage });
}
