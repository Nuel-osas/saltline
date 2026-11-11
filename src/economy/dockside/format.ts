// Formatting and validation shared by the Dockside panels. Amounts stay integers end to end; these only make
// display strings. A value that could not be read is shown as UNKNOWN, never as 0.
import { ITEMS } from "../items";
import type { TokenId } from "../types";

export const UNKNOWN = "unknown";

/** docs/ECONOMY.md → Pricing rules: a broker below the closing float shuts; investment up to the reopen line opens it. */
export const FLOAT_CLOSE = 100;
export const FLOAT_REOPEN = 400;

export const fmt = (n: number) => Math.round(n).toLocaleString("en-US");

/** A number, or "unknown" when the read failed (null/undefined). Never 0 for a missing value. */
export const fmtOr = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? UNKNOWN : fmt(n));

export const tokenWord = (id: TokenId) => id.toUpperCase();
export const itemName = (id: TokenId) => ITEMS[id]?.name ?? id;

/** "now", "40 s"-free: "2 min", "3 h", "2 d". */
export function ago(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 50) return "now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const hr = Math.round(m / 60);
  if (hr < 48) return `${hr} h`;
  return `${Math.round(hr / 24)} d`;
}

/** Implicit accounts are 64 hex characters; show the ends. Named accounts show whole up to 24 characters. */
export const shortAccount = (id: string) => (id.length > 24 ? `${id.slice(0, 6)}…${id.slice(-6)}` : id);

export const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : 0);

// ---- callsigns (docs/CONTRACT_API.md → Callsigns: 3–16 of A–Z 0–9 - . _ space, stored upper-case) ----

export const CALLSIGN_MIN = 3;
export const CALLSIGN_MAX = 16;
const ALLOWED = /^[A-Z0-9 ._-]$/;

export type CallsignCheck = { ok: true; callsign: string } | { ok: false; callsign: string; error: string };

/** Upper-cases and trims the ends, then checks the contract's rule. Fails closed with a plain-words reason. */
export function checkCallsign(raw: string): CallsignCheck {
  const callsign = raw.toUpperCase().trim();
  if (!callsign) return { ok: false, callsign, error: `Pick a callsign: ${CALLSIGN_MIN} to ${CALLSIGN_MAX} characters.` };
  const bad = [...callsign].find((c) => !ALLOWED.test(c));
  if (bad) return { ok: false, callsign, error: `“${bad}” can’t go on a pass. Use A–Z, 0–9, space, - . _` };
  if (callsign.length < CALLSIGN_MIN) return { ok: false, callsign, error: `At least ${CALLSIGN_MIN} characters.` };
  if (callsign.length > CALLSIGN_MAX) return { ok: false, callsign, error: `${CALLSIGN_MAX} characters at most.` };
  return { ok: true, callsign };
}

/** Explorer page for an account. Only testnet has one; the mock has none.
 *  Constant: https://testnet.nearblocks.io/address/<account>. Checked 11 Nov 2026: the host answers (behind a bot
 *  challenge, so the page itself was not fetched) and its API (api-testnet.nearblocks.io/v3/accounts/<id>) resolves
 *  testnet accounts; /address/<id> is nearblocks' account path, the sibling of the /txns/<hash> path. */
export function accountUrl(network: string, accountId: string): string | null {
  return network === "testnet" ? `https://testnet.nearblocks.io/address/${encodeURIComponent(accountId)}` : null;
}

/** What a rejected call means to the player. A rejection is ambiguous (it may have landed), so it never says
 *  "failed": it says the status is unknown and to check before trying again. */
export const AMBIGUOUS = "No answer from the dock. It may still settle: check your hold before trying again.";
