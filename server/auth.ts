// Who is asking, and which account is theirs (v2's sign-in).
//
// A player signs in with Google (through Privy) in the browser and sends Privy's access token here. This file checks
// that token against Privy's public keys, and derives the player's NEAR key from their Privy user id and one server
// secret. The same sign-in gets the same key on any device, and the faucet gives one dock pass per sign-in.
//
// **What this is, stated plainly.** The key is derived by this server: whoever holds WALLET_SECRET can compute any
// player's key and sign as them. That is custody by the studio, and it is acceptable on testnet, where nothing has
// money value, and nowhere else. Mainnet has to move the key to the login provider's own custody (a Privy embedded
// wallet) so that no server secret can sign for a player. README → Trust says the same.
//
// Verified 13 Nov 2026:
// - docs.privy.io "Verifying the access token": an ES256 JWT with issuer "privy.io" and audience = the app id;
//   `sub` is the user's Privy DID.
// - https://auth.privy.io/api/v1/apps/<app id>/jwks.json answers a JWKS of ES256 P-256 signing keys for the app
//   (fetched for this project's app id). Checking a token needs the app id only, never the app secret.
import { createHmac, createPrivateKey, createPublicKey } from "node:crypto";
import { type JWTVerifyGetKey, createRemoteJWKSet, jwtVerify } from "jose";

type Env = Record<string, string | undefined>;

export interface AuthConfig {
  appId: string;
  walletSecret: string;
}

/** Privy app ids are lowercase letters and digits (this one is 25 long); nothing else is put in a URL. */
const APP_ID = /^[a-z0-9]{16,40}$/;
const PRIVY_DID = /^did:privy:[a-z0-9]{8,64}$/;
/** A derivation secret shorter than this is refused: it is the only thing between a login id and a key. */
export const MIN_WALLET_SECRET = 32;

/**
 * Sign-in is `off` when neither setting is present (local play, the end-to-end runs), `on` when both are good, and
 * `broken` otherwise. A broken config closes the door: nothing falls back to open.
 */
export function authConfig(env: Env): { state: "off" } | { state: "on"; cfg: AuthConfig } | { state: "broken"; problems: string[] } {
  const appId = (env.PRIVY_APP_ID ?? "").trim();
  const walletSecret = (env.WALLET_SECRET ?? "").trim();
  if (!appId && !walletSecret) return { state: "off" };
  const problems: string[] = [];
  if (!APP_ID.test(appId)) problems.push("PRIVY_APP_ID");
  if (walletSecret.length < MIN_WALLET_SECRET) problems.push("WALLET_SECRET");
  return problems.length ? { state: "broken", problems } : { state: "on", cfg: { appId, walletSecret } };
}

const remoteKeys = new Map<string, JWTVerifyGetKey>();
function privyKeys(appId: string): JWTVerifyGetKey {
  let keys = remoteKeys.get(appId);
  if (!keys) {
    keys = createRemoteJWKSet(new URL(`https://auth.privy.io/api/v1/apps/${appId}/jwks.json`));
    remoteKeys.set(appId, keys);
  }
  return keys;
}

/** The token from an `authorization: Bearer …` header, or null. */
export function bearer(request: Request): string | null {
  const m = /^Bearer\s+([A-Za-z0-9._-]{20,4096})$/.exec((request.headers.get("authorization") ?? "").trim());
  return m ? m[1] : null;
}

/**
 * The Privy user id a token was issued to. Throws unless the token is a live ES256 JWT signed by this app's Privy
 * keys, issued by privy.io for this app, with a well-formed user id. `keys` is for tests.
 */
export async function verifyToken(token: string, cfg: AuthConfig, keys: JWTVerifyGetKey = privyKeys(cfg.appId)): Promise<string> {
  const { payload } = await jwtVerify(token, keys, { issuer: "privy.io", audience: cfg.appId, algorithms: ["ES256"] });
  if (typeof payload.exp !== "number") throw new Error("The token has no expiry");
  if (typeof payload.sub !== "string" || !PRIVY_DID.test(payload.sub)) throw new Error("The token names no Privy user");
  return payload.sub;
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = "";
  for (; n > 0n; n /= 58n) out = B58[Number(n % 58n)] + out;
  for (const b of bytes) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out;
}

/** PKCS#8's fixed prefix for a raw 32-byte Ed25519 seed (RFC 8410). */
const ED25519_PKCS8 = Buffer.from("302e020100300506032b657004220420", "hex");

export interface DerivedWallet {
  /** The implicit account: the public key in hex. */
  accountId: string;
  /** NEAR's form: "ed25519:" + base58(seed ‖ public key). */
  privateKey: `ed25519:${string}`;
}

/** The wallet for one sign-in: seed = HMAC-SHA256(secret, "saltline:v2:wallet:" + user id). Same inputs, same key. */
export function deriveWallet(cfg: AuthConfig, userId: string): DerivedWallet {
  if (cfg.walletSecret.length < MIN_WALLET_SECRET) throw new Error("WALLET_SECRET is too short to derive a key from");
  if (!PRIVY_DID.test(userId)) throw new Error("Not a Privy user id");
  const seed = createHmac("sha256", cfg.walletSecret).update(`saltline:v2:wallet:${userId}`).digest();
  const key = createPrivateKey({ key: Buffer.concat([ED25519_PKCS8, seed]), format: "der", type: "pkcs8" });
  const publicKey = createPublicKey(key).export({ format: "der", type: "spki" }).subarray(-32);
  return { accountId: publicKey.toString("hex"), privateKey: `ed25519:${base58(Buffer.concat([seed, publicKey]))}` };
}
