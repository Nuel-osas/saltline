// v2's sign-in on the server: checking a Privy access token, deriving one wallet per sign-in (server/auth.ts),
// handing that wallet to its player (server/session.ts), and the faucet giving a dock pass to it and to no other.
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import { generateKey, isPrivateKey } from "near-kit";
import { beforeAll, describe, expect, it } from "vitest";
import { type AuthConfig, MIN_WALLET_SECRET, authConfig, bearer, deriveWallet, verifyToken } from "../server/auth";
import { FUND_YOCTO, type FaucetChain, type FaucetEnv, handleFaucet, newLimits } from "../server/faucet";
import { handleSession, newSessionLimit } from "../server/session";
import { implicitAccountId } from "../src/economy/wallet";

const APP = "cmtestappid0000000000000a";
const SECRET = "s".repeat(48);
const CFG: AuthConfig = { appId: APP, walletSecret: SECRET };
const ALICE = "did:privy:cmalice000000000000000001";
const BOB = "did:privy:cmbob00000000000000000002";

let keys: ReturnType<typeof createLocalJWKSet>;
let sign: (claims: Record<string, unknown>, opts?: { exp?: string | number | null; alg?: string }) => Promise<string>;

beforeAll(async () => {
  const pair = await generateKeyPair("ES256");
  const jwk = { ...(await exportJWK(pair.publicKey)), alg: "ES256", kid: "k1", use: "sig" };
  keys = createLocalJWKSet({ keys: [jwk] });
  sign = async (claims, opts = {}) => {
    const jwt = new SignJWT(claims).setProtectedHeader({ alg: "ES256", kid: "k1" }).setIssuedAt();
    if (opts.exp !== null) jwt.setExpirationTime(opts.exp ?? "1h");
    return jwt.sign(pair.privateKey);
  };
});
const good = (sub = ALICE) => sign({ iss: "privy.io", aud: APP, sub, sid: "session1" });

describe("authConfig", () => {
  it("is off with neither setting, on with both, and broken with half", () => {
    expect(authConfig({})).toEqual({ state: "off" });
    expect(authConfig({ PRIVY_APP_ID: " ", WALLET_SECRET: "" })).toEqual({ state: "off" });
    expect(authConfig({ PRIVY_APP_ID: APP, WALLET_SECRET: SECRET })).toEqual({ state: "on", cfg: CFG });
    expect(authConfig({ PRIVY_APP_ID: APP })).toEqual({ state: "broken", problems: ["WALLET_SECRET"] });
    expect(authConfig({ WALLET_SECRET: SECRET })).toEqual({ state: "broken", problems: ["PRIVY_APP_ID"] });
    expect(authConfig({ PRIVY_APP_ID: APP, WALLET_SECRET: "x".repeat(MIN_WALLET_SECRET - 1) })).toEqual({ state: "broken", problems: ["WALLET_SECRET"] });
    expect(authConfig({ PRIVY_APP_ID: "../../evil", WALLET_SECRET: SECRET })).toEqual({ state: "broken", problems: ["PRIVY_APP_ID"] });
  });
});

describe("bearer", () => {
  const req = (h?: string) => new Request("http://localhost/x", { headers: h ? { authorization: h } : {} });
  it("reads a token from the authorization header and nothing else", () => {
    const t = "a".repeat(40) + ".b-c_d";
    expect(bearer(req(`Bearer ${t}`))).toBe(t);
    expect(bearer(req())).toBeNull();
    expect(bearer(req("Basic abc"))).toBeNull();
    expect(bearer(req("Bearer short"))).toBeNull();
    expect(bearer(req(`Bearer ${t} extra`))).toBeNull();
  });
});

describe("verifyToken", () => {
  it("answers the Privy user id for a live token from this app", async () => {
    expect(await verifyToken(await good(), CFG, keys)).toBe(ALICE);
  });

  it("refuses an expired token, another app's token, another issuer's, and one with no expiry", async () => {
    await expect(verifyToken(await sign({ iss: "privy.io", aud: APP, sub: ALICE }, { exp: Math.floor(Date.now() / 1000) - 60 }), CFG, keys)).rejects.toThrow();
    await expect(verifyToken(await sign({ iss: "privy.io", aud: "cmanotherapp00000000000000", sub: ALICE }), CFG, keys)).rejects.toThrow();
    await expect(verifyToken(await sign({ iss: "evil.io", aud: APP, sub: ALICE }), CFG, keys)).rejects.toThrow();
    await expect(verifyToken(await sign({ iss: "privy.io", aud: APP, sub: ALICE }, { exp: null }), CFG, keys)).rejects.toThrow("no expiry");
  });

  it("refuses a token signed by a key that isn't the app's, an unsigned one, and garbage", async () => {
    const other = await generateKeyPair("ES256");
    const forged = await new SignJWT({ iss: "privy.io", aud: APP, sub: ALICE }).setProtectedHeader({ alg: "ES256", kid: "k1" }).setExpirationTime("1h").sign(other.privateKey);
    await expect(verifyToken(forged, CFG, keys)).rejects.toThrow();
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const unsigned = `${b64({ alg: "none" })}.${b64({ iss: "privy.io", aud: APP, sub: ALICE, exp: Math.floor(Date.now() / 1000) + 600 })}.`;
    await expect(verifyToken(unsigned, CFG, keys)).rejects.toThrow();
    await expect(verifyToken("not.a.token", CFG, keys)).rejects.toThrow();
  });

  it("refuses a token whose subject isn't a Privy user id", async () => {
    await expect(verifyToken(await sign({ iss: "privy.io", aud: APP, sub: "admin" }), CFG, keys)).rejects.toThrow("no Privy user");
    await expect(verifyToken(await sign({ iss: "privy.io", aud: APP }), CFG, keys)).rejects.toThrow("no Privy user");
  });
});

describe("deriveWallet", () => {
  it("gives one sign-in the same NEAR key every time, in the form the game's wallet reads", () => {
    const a = deriveWallet(CFG, ALICE);
    expect(deriveWallet(CFG, ALICE)).toEqual(a);
    expect(a.accountId).toMatch(/^[0-9a-f]{64}$/);
    expect(isPrivateKey(a.privateKey)).toBe(true);
    // The browser's wallet works the account out from the key on its own; the two must agree.
    expect(implicitAccountId(a.privateKey)).toBe(a.accountId);
  });

  it("gives different sign-ins, and different secrets, different keys", () => {
    const a = deriveWallet(CFG, ALICE);
    expect(deriveWallet(CFG, BOB).accountId).not.toBe(a.accountId);
    expect(deriveWallet({ ...CFG, walletSecret: "t".repeat(48) }, ALICE).accountId).not.toBe(a.accountId);
  });

  it("won't derive from a short secret or from something that isn't a Privy user id", () => {
    expect(() => deriveWallet({ ...CFG, walletSecret: "short" }, ALICE)).toThrow("too short");
    expect(() => deriveWallet(CFG, "alice")).toThrow("Not a Privy user id");
  });
});

describe("POST /api/session", () => {
  const ENV = { PRIVY_APP_ID: APP, WALLET_SECRET: SECRET };
  const ask = async (opts: { token?: string | null; env?: Record<string, string>; method?: string; verify?: (t: string) => Promise<string>; limit?: ReturnType<typeof newSessionLimit> } = {}) => {
    const logs: string[] = [];
    const headers: Record<string, string> = { "x-forwarded-for": "203.0.113.7" };
    if (opts.token !== null) headers.authorization = `Bearer ${opts.token ?? "t".repeat(40)}`;
    const res = await handleSession(new Request("http://localhost/api/session", { method: opts.method ?? "POST", headers }), opts.env ?? ENV, {
      verify: opts.verify ?? (async () => ALICE),
      limit: opts.limit ?? newSessionLimit(),
      now: () => 1_800_000_000_000,
      log: (l) => logs.push(l),
    });
    return { status: res.status, cache: res.headers.get("cache-control"), body: (await res.json()) as Record<string, unknown>, logs };
  };

  it("hands a signed-in player their account and key, uncached and unlogged", async () => {
    const r = await ask();
    const w = deriveWallet(CFG, ALICE);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, accountId: w.accountId, privateKey: w.privateKey });
    expect(r.cache).toBe("no-store");
    expect(r.logs.join("\n")).not.toContain(w.privateKey.slice(8));
    expect(r.logs.join("\n")).toContain(w.accountId);
  });

  it("answers 401 with no token or a refused one, and never a key", async () => {
    const none = await ask({ token: null });
    expect(none.status).toBe(401);
    const bad = await ask({
      verify: async () => {
        throw new Error("signature verification failed");
      },
    });
    expect(bad.status).toBe(401);
    for (const r of [none, bad]) expect(JSON.stringify(r.body)).not.toContain("ed25519:");
  });

  it("is 404 with sign-in off, 503 half-configured, and 405 for anything but POST", async () => {
    expect((await ask({ env: {} })).status).toBe(404);
    expect((await ask({ env: { PRIVY_APP_ID: APP } })).status).toBe(503);
    expect((await ask({ method: "GET" })).status).toBe(405);
  });

  it("limits asks per client address", async () => {
    const limit = newSessionLimit();
    let last = 0;
    for (let i = 0; i < 31; i++) last = (await ask({ limit })).status;
    expect(last).toBe(429);
  });
});

describe("faucet: a v2 dock pass with sign-in on", () => {
  const KEY = generateKey().secretKey;
  const ENV: FaucetEnv = {
    FAUCET_ACCOUNT_ID: "faucet.saltline.testnet",
    FAUCET_PRIVATE_KEY: KEY,
    VITE_CONTRACT_ID: "saltline.testnet",
    VITE_NEAR_NETWORK: "testnet",
    CONTRACT_ID_V2: "v2.saltline.testnet",
    PRIVY_APP_ID: APP,
    WALLET_SECRET: SECRET,
  };
  const MINE = deriveWallet(CFG, ALICE).accountId;
  const OTHER = "cd".repeat(32);

  function harness() {
    const calls: string[] = [];
    const chain: FaucetChain = {
      profile: async () => null,
      accountExists: async () => false,
      register: async (id, cs) => (calls.push(`register ${id} ${cs}`), { ok: true, txHash: "REG" }),
      fund: async (id, yocto) => (calls.push(`fund ${id} ${yocto}`), { ok: true, txHash: "FUND" }),
    };
    const post = async (body: unknown, opts: { token?: string | null; env?: FaucetEnv; verify?: (t: string) => Promise<string> } = {}) => {
      const headers: Record<string, string> = { "content-type": "application/json", "x-forwarded-for": "203.0.113.9" };
      if (opts.token !== null) headers.authorization = `Bearer ${opts.token ?? "t".repeat(40)}`;
      const res = await handleFaucet(new Request("http://localhost/api/faucet", { method: "POST", headers, body: JSON.stringify(body) }), opts.env ?? ENV, {
        chain: () => chain,
        limits: newLimits(),
        now: () => 1_800_000_000_000,
        log: () => {},
        verify: opts.verify ?? (async () => ALICE),
      });
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };
    return { post, calls };
  }

  it("goes to the signed-in player's own account", async () => {
    const h = harness();
    const r = await h.post({ accountId: MINE, callsign: "rook", game: "v2" });
    expect(r.status).toBe(200);
    expect(h.calls).toEqual([`register ${MINE} ROOK`, `fund ${MINE} ${FUND_YOCTO}`]);
  });

  it("is refused without a sign-in, with a bad one, and for any account but the sign-in's own; nothing is sent", async () => {
    const h = harness();
    expect((await h.post({ accountId: MINE, callsign: "rook", game: "v2" }, { token: null })).status).toBe(401);
    const bad = await h.post(
      { accountId: MINE, callsign: "rook", game: "v2" },
      {
        verify: async () => {
          throw new Error("expired");
        },
      },
    );
    expect(bad.status).toBe(401);
    const other = await h.post({ accountId: OTHER, callsign: "rook", game: "v2" });
    expect(other).toEqual({ status: 403, body: { ok: false, error: "That isn't this sign-in's account." } });
    expect(h.calls).toEqual([]);
  });

  it("closes the office when sign-in is half-configured, rather than handing out passes unsigned", async () => {
    const h = harness();
    const r = await h.post({ accountId: MINE, callsign: "rook", game: "v2" }, { env: { ...ENV, WALLET_SECRET: "" } });
    expect(r.status).toBe(503);
    expect(h.calls).toEqual([]);
  });

  it("leaves the first game's passes, and v2's with sign-in off, as they were", async () => {
    const h = harness();
    expect((await h.post({ accountId: OTHER, callsign: "rook" }, { token: null })).status).toBe(200);
    const off = { ...ENV, PRIVY_APP_ID: "", WALLET_SECRET: "" };
    expect((await h.post({ accountId: OTHER, callsign: "rook", game: "v2" }, { token: null, env: off })).status).toBe(200);
  });
});
