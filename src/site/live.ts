// The landing page's read-only window on the v2 contract (docs/CONTRACT_V2.md → Views): view calls over NEAR's
// JSON-RPC with no key and no dependency, so the front page stays small. Nothing here can sign or spend.
//
// A read that fails is "unknown" (null), never 0: the page says the chain didn't answer.

export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

const toBase64 = (s: string) => btoa(unescape(encodeURIComponent(s)));

/**
 * One view call. The RPCs are tried in order; the first that answers with a result wins. Throws when none does, or
 * when what came back isn't the contract's JSON.
 */
export async function viewCall<T>(
  rpcUrls: readonly string[],
  contractId: string,
  method: string,
  args: unknown = {},
  fetcher: Fetcher = (u, i) => fetch(u, i),
  timeoutMs = 8000,
): Promise<T> {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: "saltline-site",
    method: "query",
    params: {
      request_type: "call_function",
      finality: "optimistic",
      account_id: contractId,
      method_name: method,
      args_base64: toBase64(JSON.stringify(args)),
    },
  });
  let last: unknown = new Error("No RPC to ask");
  for (const url of rpcUrls) {
    try {
      const res = await fetcher(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as {
        result?: { result?: unknown; error?: string };
        error?: { message?: string };
      };
      const bytes = json.result?.result;
      if (!Array.isArray(bytes)) throw new Error(json.result?.error ?? json.error?.message ?? "The RPC sent no result");
      return JSON.parse(new TextDecoder().decode(Uint8Array.from(bytes as number[]))) as T;
    } catch (e) {
      last = e;
    }
  }
  throw last;
}

/** The same call, answering null ("unknown") when it fails. */
export async function read<T>(rpcUrls: readonly string[], contractId: string, method: string, args: unknown = {}, fetcher?: Fetcher): Promise<T | null> {
  try {
    return await viewCall<T>(rpcUrls, contractId, method, args, fetcher);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The shapes read (snake_case, as the contract answers). Amounts are U128 decimal strings.

export interface Quote {
  token_id: string;
  price: string;
  reason: string;
}
export interface RackGun {
  weapon: {
    serial: string;
    frame: string;
    grade: string;
    condition: number;
    maker_callsign?: string;
  };
  price: string;
}
export interface VendorView {
  id: string;
  account_id: string;
  name: string;
  open: boolean;
  scrip: string;
  bids: Quote[];
  guns: RackGun[];
  last_memo?: string | null;
}
export interface HarbormasterView {
  account_id: string;
  balance: string;
  strength: number;
  posture: string;
  bonus_drones: number;
  bailiff_at: string;
  last_memo?: string | null;
}
export interface EconomyView {
  scrip_supply: string;
  minted_24h: string;
  burned_24h: string;
  players: number;
  weapons_built: number;
  weapons_alive: number;
  weapons_destroyed: number;
}
export interface RecentLine {
  kind: string;
  at: number | string;
  text: string;
}

// ---------------------------------------------------------------------------------------------------------------
// Pure helpers.

/** A U128 string or a JSON number as a bigint; null for anything else (an amount is never guessed). */
export function amount(v: unknown): bigint | null {
  if (typeof v === "number") return Number.isSafeInteger(v) && v >= 0 ? BigInt(v) : null;
  if (typeof v === "string" && /^\d{1,39}$/.test(v)) return BigInt(v);
  return null;
}

/** Whole units with thousands separators; "unknown" for null. */
export const fmt = (n: bigint | null): string => (n == null ? "unknown" : n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ","));

/** The vendor's highest bid, or null when it has none that parse. */
export function bestBid(bids: readonly Quote[] | undefined): Quote | null {
  let best: Quote | null = null;
  let top = -1n;
  for (const q of bids ?? []) {
    const p = amount(q.price);
    if (p != null && p > top) [best, top] = [q, p];
  }
  return best;
}

/** A contract timestamp in milliseconds. The contract writes milliseconds; nanoseconds are accepted too. */
export function toMs(at: number | string): number | null {
  const n = typeof at === "string" ? Number(at) : at;
  if (!Number.isFinite(n) || n <= 0) return null;
  return n > 1e15 ? Math.floor(n / 1e6) : n;
}

/** "now", "12 min ago", "3 h ago", "2 d ago"; "" when the time is unknown or ahead of the clock by more than a minute. */
export function ago(at: number | string, now: number): string {
  const ms = toMs(at);
  if (ms == null) return "";
  const s = Math.floor((now - ms) / 1000);
  if (s < -60) return "";
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

/** The invoice the page shows for a scroll position: 0 at the top, `max` at the foot, in steps of 5. */
export function meterValue(progress: number, max: number): number {
  const p = Math.min(1, Math.max(0, Number.isFinite(progress) ? progress : 0));
  return Math.round((p * max) / 5) * 5;
}
