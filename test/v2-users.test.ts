// Users in the database (server/users.ts), written where the server sees them: when the dock office hands a sign-in
// its wallet (server/session.ts) and when the faucet issues a v2 dock pass (server/faucet.ts). And the rule above all
// of it: with the database off, failing or hanging, sign-in and the dock pass answer exactly as they did.
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKey } from "near-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type AuthConfig, deriveWallet } from "../server/auth";
import { FUND_YOCTO, type FaucetChain, type FaucetEnv, handleFaucet, newLimits } from "../server/faucet";
import { SIDE_JOB_MS } from "../server/record";
import { handleSession, newSessionLimit } from "../server/session";
import { type Store, fileStore, memoryStore, offStore } from "../server/store";
import { countUsers, gavePass, listUsers, sawUser } from "../server/users";

const APP = "cmtestappid0000000000000a";
const SECRET = "s".repeat(48);
const CFG: AuthConfig = { appId: APP, walletSecret: SECRET };
const ALICE = "did:privy:cmalice000000000000000001";
const BOB = "did:privy:cmbob00000000000000000002";
const T0 = 1_800_000_000_000;
const MINE = deriveWallet(CFG, ALICE).accountId;

/** A database that is broken in the way named: every call throws, rejects, or never answers. */
function broken(how: "throws" | "rejects" | "hangs"): Store {
  const fail = () => {
    if (how === "throws") throw new Error("the database is down");
    return how === "rejects" ? Promise.reject(new Error("the database is down")) : new Promise(() => {});
  };
  return new Proxy({ kind: "upstash" } as Store, { get: (t, p) => (p === "kind" ? t.kind : fail) });
}

afterEach(() => void vi.useRealTimers());

describe("the user record", () => {
  it("keeps when a sign-in was first seen, moves when it was last seen, and counts its sessions and visits", async () => {
    const store = memoryStore();
    expect(await sawUser(store, { userId: ALICE, accountId: MINE, at: T0, as: "session" })).toBe(true);
    await sawUser(store, { userId: ALICE, accountId: MINE, at: T0 + 5000, as: "visit" });
    await sawUser(store, { userId: ALICE, accountId: MINE, at: T0 + 9000, as: "session" });
    expect(await listUsers(store)).toEqual([{ id: ALICE, accountId: MINE, firstSeen: T0, lastSeen: T0 + 9000, sessions: 2, visits: 1, callsign: null, passAt: null }]);
  });

  it("takes the callsign and the pass time from the dock pass, and keeps the first pass time", async () => {
    const store = memoryStore();
    await sawUser(store, { userId: ALICE, accountId: MINE, at: T0, as: "session" });
    await gavePass(store, { userId: ALICE, accountId: MINE, callsign: "ROOK", at: T0 + 60_000 });
    await gavePass(store, { userId: ALICE, accountId: MINE, callsign: "ROOK", at: T0 + 90_000 });
    expect(await listUsers(store)).toEqual([{ id: ALICE, accountId: MINE, firstSeen: T0, lastSeen: T0 + 90_000, sessions: 1, visits: 0, callsign: "ROOK", passAt: T0 + 60_000 }]);
    // A pass for a sign-in the database has never seen starts its record.
    await gavePass(store, { userId: BOB, accountId: "bb".repeat(32), callsign: "WREN", at: T0 + 100_000 });
    expect((await listUsers(store))?.[0]).toEqual({ id: BOB, accountId: "bb".repeat(32), firstSeen: T0 + 100_000, lastSeen: T0 + 100_000, sessions: 0, visits: 0, callsign: "WREN", passAt: T0 + 100_000 });
  });

  it("counts users and lists the newest first, however often the older ones come back", async () => {
    const store = memoryStore();
    for (const [i, id] of ["a", "b", "c", "d"].entries()) await sawUser(store, { userId: `did:privy:cm${id.repeat(12)}`, accountId: id.repeat(64), at: T0 + i * 1000, as: "session" });
    await sawUser(store, { userId: `did:privy:cm${"a".repeat(12)}`, accountId: "a".repeat(64), at: T0 + 50_000, as: "visit" });
    expect(await countUsers(store)).toBe(4);
    expect((await listUsers(store, 3))?.map((u) => u.accountId?.[0])).toEqual(["d", "c", "b"]);
    expect(await listUsers(store, 0)).toHaveLength(1);
  });

  it("is unknown, not empty and not zero, when the database is off", async () => {
    expect(await countUsers(offStore())).toBeNull();
    expect(await listUsers(offStore())).toBeNull();
    expect(await sawUser(offStore(), { userId: ALICE, accountId: MINE, at: T0, as: "session" })).toBe(false);
    // A database that is there and has nobody in it is a real zero.
    expect(await countUsers(memoryStore())).toBe(0);
    expect(await listUsers(memoryStore())).toEqual([]);
  });

  it("is unknown when a record in the list can't be read: half a list is not shown as the whole", async () => {
    const store = memoryStore();
    await sawUser(store, { userId: ALICE, accountId: MINE, at: T0, as: "session" });
    await sawUser(store, { userId: BOB, accountId: "bb".repeat(32), at: T0 + 1, as: "session" });
    const flaky: Store = { ...store, hgetall: (key) => (key.endsWith(ALICE) ? Promise.resolve(null) : store.hgetall(key)) };
    expect(await listUsers(flaky)).toBeNull();
  });
});

describe("POST /api/session and the database", () => {
  const ENV = { PRIVY_APP_ID: APP, WALLET_SECRET: SECRET };
  const ask = async (store?: Store, at = T0) => {
    const res = await handleSession(new Request("http://localhost/api/session", { method: "POST", headers: { authorization: `Bearer ${"t".repeat(40)}`, "x-forwarded-for": "203.0.113.7" } }), ENV, {
      verify: async () => ALICE,
      limit: newSessionLimit(),
      now: () => at,
      log: () => {},
      store,
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  const want = { status: 200, body: { ok: true, ...deriveWallet(CFG, ALICE) } };

  it("writes the sign-in down when it hands over the wallet", async () => {
    const store = memoryStore();
    expect(await ask(store)).toEqual(want);
    expect(await ask(store, T0 + 7000)).toEqual(want);
    expect(await listUsers(store)).toEqual([{ id: ALICE, accountId: MINE, firstSeen: T0, lastSeen: T0 + 7000, sessions: 2, visits: 0, callsign: null, passAt: null }]);
  });

  it("writes nothing for a sign-in it refuses", async () => {
    const store = memoryStore();
    const res = await handleSession(new Request("http://localhost/api/session", { method: "POST", headers: { authorization: `Bearer ${"t".repeat(40)}` } }), ENV, {
      verify: async () => Promise.reject(new Error("expired")),
      limit: newSessionLimit(),
      log: () => {},
      store,
    });
    expect(res.status).toBe(401);
    expect(await countUsers(store)).toBe(0);
  });

  it("never writes the key: the database holds the account and nothing that could sign for it", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "saltline-users-")), "store.json");
    const store = fileStore(path);
    await ask(store);
    await store.flushed();
    const onDisk = readFileSync(path, "utf8");
    expect(onDisk).toContain(MINE);
    expect(onDisk).not.toContain("ed25519");
    expect(onDisk).not.toContain(deriveWallet(CFG, ALICE).privateKey.slice(8));
    expect(onDisk).not.toContain(SECRET);
  });

  it("answers exactly the same with the database off, throwing or rejecting", async () => {
    expect(await ask(offStore())).toEqual(want);
    expect(await ask(broken("throws"))).toEqual(want);
    expect(await ask(broken("rejects"))).toEqual(want);
  });

  it("waits a second at most for a database that never answers, then hands the wallet over anyway", async () => {
    vi.useFakeTimers();
    let done: Awaited<ReturnType<typeof ask>> | null = null;
    void ask(broken("hangs")).then((r) => (done = r));
    await vi.advanceTimersByTimeAsync(SIDE_JOB_MS - 1);
    expect(done).toBeNull();
    await vi.advanceTimersByTimeAsync(2);
    expect(done).toEqual(want);
  });
});

describe("the faucet's v2 dock pass and the database", () => {
  const KEY = generateKey().secretKey;
  const ENV: FaucetEnv = { FAUCET_ACCOUNT_ID: "faucet.saltline.testnet", FAUCET_PRIVATE_KEY: KEY, VITE_CONTRACT_ID: "saltline.testnet", VITE_NEAR_NETWORK: "testnet", CONTRACT_ID_V2: "v2.saltline.testnet", PRIVY_APP_ID: APP, WALLET_SECRET: SECRET };
  const GUEST_ENV: FaucetEnv = { ...ENV, PRIVY_APP_ID: "", WALLET_SECRET: "" };
  const OTHER = "cd".repeat(32);

  function harness(store: Store | undefined, chainOpts: { registered?: boolean; pendingRegister?: boolean } = {}) {
    const calls: string[] = [];
    const chain: FaucetChain = {
      profile: async (id) => (chainOpts.registered ? { account_id: id } : null),
      accountExists: async () => !!chainOpts.registered,
      register: async (id, cs) => (calls.push(`register ${id} ${cs}`), chainOpts.pendingRegister ? { ok: false, pending: true, txHash: "REG" } : { ok: true, txHash: "REG" }),
      fund: async (id, yocto) => (calls.push(`fund ${id} ${yocto}`), { ok: true, txHash: "FUND" }),
    };
    const post = async (body: unknown, opts: { env?: FaucetEnv; token?: boolean } = {}) => {
      const headers: Record<string, string> = { "content-type": "application/json", "x-forwarded-for": "203.0.113.9" };
      if (opts.token !== false) headers.authorization = `Bearer ${"t".repeat(40)}`;
      const res = await handleFaucet(new Request("http://localhost/api/faucet", { method: "POST", headers, body: JSON.stringify(body) }), opts.env ?? ENV, {
        chain: () => chain,
        limits: newLimits(),
        now: () => T0,
        log: () => {},
        verify: async () => ALICE,
        store,
      });
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };
    return { post, calls };
  }
  const claimed = { status: 200, body: { ok: true, accountId: MINE, callsign: "ROOK", txHashes: ["REG", "FUND"] } };
  const sent = [`register ${MINE} ROOK`, `fund ${MINE} ${FUND_YOCTO}`];

  it("puts the callsign and the pass time on the sign-in's record once the pass is issued", async () => {
    const store = memoryStore();
    const h = harness(store);
    expect(await h.post({ accountId: MINE, callsign: "rook", game: "v2" })).toEqual(claimed);
    expect(await listUsers(store)).toEqual([{ id: ALICE, accountId: MINE, firstSeen: T0, lastSeen: T0, sessions: 0, visits: 0, callsign: "ROOK", passAt: T0 }]);
  });

  it("writes nothing for a pass that wasn't issued: refused, already held, or sent and not yet confirmed", async () => {
    const store = memoryStore();
    expect((await harness(store).post({ accountId: OTHER, callsign: "rook", game: "v2" })).status).toBe(403);
    expect((await harness(store).post({ accountId: MINE, callsign: "rook", game: "v2" }, { token: false })).status).toBe(401);
    expect((await harness(store, { registered: true }).post({ accountId: MINE, callsign: "rook", game: "v2" })).status).toBe(409);
    expect((await harness(store, { pendingRegister: true }).post({ accountId: MINE, callsign: "rook", game: "v2" })).status).toBe(202);
    expect(await countUsers(store)).toBe(0);
  });

  it("keeps no record for the first game's passes, or for a guest's v2 pass with sign-in off", async () => {
    const store = memoryStore();
    expect((await harness(store).post({ accountId: OTHER, callsign: "rook" }, { token: false })).status).toBe(200);
    expect((await harness(store).post({ accountId: OTHER, callsign: "rook", game: "v2" }, { token: false, env: GUEST_ENV })).status).toBe(200);
    expect(await countUsers(store)).toBe(0);
  });

  it("issues the pass exactly the same with the database off, throwing or rejecting", async () => {
    for (const store of [offStore(), broken("throws"), broken("rejects")]) {
      const h = harness(store);
      expect(await h.post({ accountId: MINE, callsign: "rook", game: "v2" })).toEqual(claimed);
      expect(h.calls).toEqual(sent);
    }
  });

  it("waits a second at most for a database that never answers, after the chain has already confirmed the pass", async () => {
    vi.useFakeTimers();
    const h = harness(broken("hangs"));
    let done: unknown = null;
    void h.post({ accountId: MINE, callsign: "rook", game: "v2" }).then((r) => (done = r));
    await vi.advanceTimersByTimeAsync(SIDE_JOB_MS - 1);
    expect(done).toBeNull();
    expect(h.calls).toEqual(sent); // the pass was issued before the database was asked anything
    await vi.advanceTimersByTimeAsync(2);
    expect(done).toEqual(claimed);
  });
});
