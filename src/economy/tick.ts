// Wakes the broker agents when someone plays (server/tick.ts). Fire and forget, testnet only, at most once every
// 10 minutes per browser: when the game boots and when a run ends. The server throttles again across all players.
const KEY = "saltline.tick.v1";
const EVERY_MS = 10 * 60_000;

export function tickUrl(faucetUrl: string): string {
  return faucetUrl.replace(/faucet\/?$/, "tick");
}

export function shouldTick(now: number, storage: Pick<Storage, "getItem" | "setItem"> | undefined): boolean {
  try {
    const raw = storage?.getItem(KEY);
    const last = raw == null ? null : Number(raw); // never ticked: no record, not "ticked at time zero"
    if (last !== null && Number.isFinite(last) && now - last < EVERY_MS) return false;
    storage?.setItem(KEY, String(now));
  } catch {
    // Storage refused: tick anyway; the server keeps its own pace.
  }
  return true;
}

export function startTicks(
  url: string,
  events: { on(name: string, fn: (e: unknown) => void): unknown } | undefined,
  deps: { fetch?: typeof fetch; now?: () => number; storage?: Pick<Storage, "getItem" | "setItem"> } = {},
): () => void {
  const go = () => {
    const storage = deps.storage ?? (typeof localStorage === "undefined" ? undefined : localStorage);
    if (!shouldTick((deps.now ?? Date.now)(), storage)) return;
    (deps.fetch ?? fetch)(url, { method: "POST", keepalive: true }).catch(() => {});
  };
  go();
  events?.on("game:state", (e) => {
    const state = (e as { state?: string } | null)?.state;
    if (state === "complete" || state === "dead") go();
  });
  return go;
}
