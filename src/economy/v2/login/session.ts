// The browser's half of POST /api/session (server/session.ts): trade a sign-in token for the player's wallet, and
// send that token with every dock-pass request so the faucet knows who is asking.
import { isPrivateKey } from "near-kit";
import { implicitAccountId } from "../../wallet";

export interface SessionWallet {
  accountId: string;
  privateKey: `ed25519:${string}`;
}

/**
 * The signed-in player's wallet. Throws with the dock office's own words when it refuses, and refuses itself anything
 * that isn't a well-formed key whose account matches the one named: a wrong key is never put in the wallet.
 */
export async function fetchWallet(url: string, token: string, doFetch: typeof fetch = (u, i) => fetch(u, i)): Promise<SessionWallet> {
  let res: Response;
  try {
    res = await doFetch(url, { method: "POST", headers: { authorization: `Bearer ${token}` } });
  } catch {
    throw new Error("Couldn't reach the dock office. Try again.");
  }
  let body: { ok?: unknown; error?: unknown; accountId?: unknown; privateKey?: unknown } | null = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok || body?.ok !== true) throw new Error(typeof body?.error === "string" ? body.error : `The dock office answered ${res.status}.`);
  const { accountId, privateKey } = body;
  const notAKey = new Error("The dock office sent something that isn't a key.");
  if (typeof privateKey !== "string" || !privateKey.startsWith("ed25519:") || !isPrivateKey(privateKey)) throw notAKey;
  let derived: string;
  try {
    derived = implicitAccountId(privateKey); // near-kit's isPrivateKey is loose; this parses the key for real
  } catch {
    throw notAKey;
  }
  if (typeof accountId !== "string" || derived !== accountId) throw new Error("The dock office sent a key for a different account.");
  return { accountId, privateKey: privateKey as `ed25519:${string}` };
}

/**
 * A fetch that adds the sign-in token to requests for `url` (the faucet) and leaves every other request alone. With
 * no token the request goes as it is, and the faucet answers that a sign-in is needed.
 */
export function withToken(url: string, token: () => Promise<string | null>, doFetch: typeof fetch = (u, i) => fetch(u, i)): typeof fetch {
  return async (input, init) => {
    if (input !== url) return doFetch(input, init);
    const t = await token().catch(() => null);
    if (!t) return doFetch(input, init);
    const headers = new Headers(init?.headers);
    headers.set("authorization", `Bearer ${t}`);
    return doFetch(input, { ...init, headers });
  };
}

/** `/api/faucet` → `/api/session`: the two live side by side. */
export const sessionUrlFor = (faucetUrl: string) => faucetUrl.replace(/faucet(\?.*)?$/, "session");
