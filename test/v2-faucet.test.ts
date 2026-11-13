// The faucet's v2 path: `game: "v2"` registers on CONTRACT_ID_V2 and nowhere else. test/faucet.test.ts still
// covers the first game, unchanged.
import { generateKey } from "near-kit";
import { describe, expect, it } from "vitest";
import type { Executed } from "../src/economy/chain";
import { FUND_YOCTO, type FaucetChain, type FaucetConfig, type FaucetEnv, handleFaucet, newLimits, v2ContractId } from "../server/faucet";

const KEY = generateKey().secretKey;
const KEY_BODY = KEY.slice("ed25519:".length);
const V1 = "saltline.testnet";
const V2 = "v2.saltline.testnet";
const ENV: FaucetEnv = { FAUCET_ACCOUNT_ID: "faucet.saltline.testnet", FAUCET_PRIVATE_KEY: KEY, VITE_CONTRACT_ID: V1, VITE_NEAR_NETWORK: "testnet", CONTRACT_ID_V2: V2 };
const GUEST = "cd".repeat(32);
const T0 = 1_800_000_000_000;

interface StubOpts {
  profile?: unknown | null | Error;
  exists?: boolean | Error;
  register?: Executed;
  fund?: Executed;
}

function harness(opts: StubOpts = {}) {
  const calls: string[] = [];
  const logs: string[] = [];
  const bodies: string[] = [];
  const configs: FaucetConfig[] = [];
  const limits = newLimits();
  const chain: FaucetChain = {
    async profile(id) {
      calls.push(`profile ${id}`);
      if (opts.profile instanceof Error) throw opts.profile;
      return opts.profile ?? null;
    },
    async accountExists(id) {
      calls.push(`exists ${id}`);
      if (opts.exists instanceof Error) throw opts.exists;
      return opts.exists ?? false;
    },
    async register(id, cs) {
      calls.push(`register ${id} ${cs}`);
      return opts.register ?? { ok: true, txHash: "REG" };
    },
    async fund(id, yocto) {
      calls.push(`fund ${id} ${yocto}`);
      return opts.fund ?? { ok: true, txHash: "FUND" };
    },
  };
  const post = async (body: unknown, env: FaucetEnv = ENV, ip = "203.0.113.9") => {
    const res = await handleFaucet(
      new Request("http://localhost/api/faucet", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": ip }, body: JSON.stringify(body) }),
      env,
      { chain: (cfg) => (configs.push(cfg), chain), limits, now: () => T0, log: (l) => logs.push(l) },
    );
    const text = await res.text();
    bodies.push(text);
    return { status: res.status, body: JSON.parse(text) as Record<string, unknown> };
  };
  return { post, calls, logs, bodies, configs };
}

describe("faucet: v2 claims", () => {
  it("registers on CONTRACT_ID_V2 and funds a new guest account", async () => {
    const h = harness();
    const r = await h.post({ accountId: GUEST, callsign: "rook", game: "v2" });
    expect(r).toEqual({ status: 200, body: { ok: true, accountId: GUEST, callsign: "ROOK", txHashes: ["REG", "FUND"] } });
    expect(h.configs).toHaveLength(1);
    expect(h.configs[0]).toMatchObject({ contractId: V2, game: "v2", faucetId: "faucet.saltline.testnet" });
    expect(h.calls).toEqual([`profile ${GUEST}`, `exists ${GUEST}`, `register ${GUEST} ROOK`, `fund ${GUEST} ${FUND_YOCTO}`]);
    expect(h.logs[h.logs.length - 1]).toContain('"game":"v2"');
  });

  it("a player the first game already funded is registered on v2 and not paid again", async () => {
    const h = harness({ exists: true, profile: null });
    const r = await h.post({ accountId: GUEST, callsign: "ROOK", game: "v2" });
    expect(r.status).toBe(200);
    expect(r.body.txHashes).toEqual(["REG"]);
    expect(h.calls.some((c) => c.startsWith("fund"))).toBe(false);
  });

  it("answers 503 without CONTRACT_ID_V2, before anything is read or sent", async () => {
    const h = harness();
    for (const bad of [undefined, "", "   ", "Not An Account", "UPPER.testnet"]) {
      const env = { ...ENV, CONTRACT_ID_V2: bad };
      const r = await h.post({ accountId: GUEST, callsign: "ROOK", game: "v2" }, env);
      expect(r.status).toBe(503);
      expect(r.body).toEqual({ ok: false, error: "The dock office is closed: the v2 faucet isn't configured." });
    }
    expect(h.calls).toEqual([]);
    expect(h.configs).toEqual([]);
    expect(h.logs.every((l) => l.includes("CONTRACT_ID_V2"))).toBe(true);
    // Five refusals spent none of the caller's tries.
    expect((await h.post({ accountId: GUEST, callsign: "ROOK", game: "v2" })).status).toBe(200);
  });

  it("has no default and no VITE_ fallback for the v2 contract", () => {
    expect(v2ContractId({})).toBeNull();
    expect(v2ContractId({ VITE_CONTRACT_ID_V2: V2, VITE_CONTRACT_ID: V1, CONTRACT_ID: V1 })).toBeNull();
    expect(v2ContractId({ CONTRACT_ID_V2: ` ${V2} ` })).toBe(V2);
  });

  it("validates a v2 claim like any other, and refuses a game it doesn't know", async () => {
    const h = harness();
    expect((await h.post({ accountId: "Not An Account", callsign: "ROOK", game: "v2" })).status).toBe(400);
    expect((await h.post({ accountId: GUEST, callsign: "x", game: "v2" })).status).toBe(400);
    for (const game of ["v3", "", null, 2, ["v2"]]) {
      const r = await h.post({ accountId: GUEST, callsign: "ROOK", game });
      expect(r).toEqual({ status: 400, body: { ok: false, error: "No such game." } });
    }
    expect(h.calls).toEqual([]);
  });

  it("still fails closed on the faucet's own env", async () => {
    const h = harness();
    for (const missing of ["FAUCET_ACCOUNT_ID", "FAUCET_PRIVATE_KEY", "VITE_NEAR_NETWORK"]) {
      const r = await h.post({ accountId: GUEST, callsign: "ROOK", game: "v2" }, { ...ENV, [missing]: undefined });
      expect(r.status).toBe(503);
    }
    expect((await h.post({ accountId: GUEST, callsign: "ROOK", game: "v2" }, { ...ENV, VITE_NEAR_NETWORK: "mainnet" })).status).toBe(503);
    expect(h.calls).toEqual([]);
  });

  it("an account already registered on v2 gets 409 and costs nothing", async () => {
    const h = harness({ exists: true, profile: { account_id: GUEST, callsign: "ROOK" } });
    expect(await h.post({ accountId: GUEST, callsign: "ROOK", game: "v2" })).toEqual({ status: 409, body: { ok: false, error: "Already registered." } });
    expect(h.calls).toEqual([`profile ${GUEST}`, `exists ${GUEST}`]);
  });

  it("the contract's refusals keep their status, and nothing is funded after one", async () => {
    for (const [code, status] of [
      ["E_CALLSIGN_TAKEN", 409],
      ["E_ALREADY_REGISTERED", 409],
      ["E_BAD_CALLSIGN", 400],
      ["E_FULL", 502],
    ] as const) {
      const h = harness({ register: { ok: false, code, error: `${code} happened`, txHash: "REG" } });
      const r = await h.post({ accountId: GUEST, callsign: "ROOK", game: "v2" });
      expect(r.status).toBe(status);
      expect(r.body.error).toBe(`${code} happened`);
      expect(h.calls.some((c) => c.startsWith("fund"))).toBe(false);
    }
  });

  it("a registration that may have landed is pending, and the money waits", async () => {
    const h = harness({ register: { ok: false, pending: true, txHash: "REG" } });
    const r = await h.post({ accountId: GUEST, callsign: "ROOK", game: "v2" });
    expect(r.status).toBe(202);
    expect(r.body).toMatchObject({ ok: false, pending: true, txHashes: ["REG"] });
    expect(h.calls.some((c) => c.startsWith("fund"))).toBe(false);
  });

  it("a failed lookup sends nothing", async () => {
    const h = harness({ profile: new Error("rpc down") });
    expect((await h.post({ accountId: GUEST, callsign: "ROOK", game: "v2" })).status).toBe(502);
    expect(h.calls.some((c) => c.startsWith("register") || c.startsWith("fund"))).toBe(false);
  });

  it("the key is never in a response or a log line, even when an error carries it", async () => {
    const h = harness({ register: { ok: false, code: "E_BAD_CALLSIGN", error: `bad ${KEY} and ${KEY_BODY}`, txHash: "REG" } });
    await h.post({ accountId: GUEST, callsign: "ROOK", game: "v2" });
    await h.post({ accountId: GUEST, callsign: "ROOK", game: "v2" }, { ...ENV, CONTRACT_ID_V2: undefined });
    const leak = harness({ profile: new Error(`boom ${KEY}`) });
    await leak.post({ accountId: GUEST, callsign: "ROOK", game: "v2" });
    const ok = harness();
    await ok.post({ accountId: GUEST, callsign: "ROOK", game: "v2" });
    const everything = [...h.logs, ...h.bodies, ...leak.logs, ...leak.bodies, ...ok.logs, ...ok.bodies].join("\n");
    expect(everything.length).toBeGreaterThan(100);
    expect(everything).not.toContain(KEY);
    expect(everything).not.toContain(KEY_BODY);
    expect(everything).toContain("[redacted]");
  });
});

describe("faucet: the first game is untouched by v2", () => {
  it("a claim without `game`, or with game v1, registers on the first contract whether or not v2 is configured", async () => {
    for (const env of [ENV, { ...ENV, CONTRACT_ID_V2: undefined }, { ...ENV, CONTRACT_ID_V2: "Not An Account" }]) {
      const h = harness();
      const r = await h.post({ accountId: GUEST, callsign: "rook" }, env);
      expect(r).toEqual({ status: 200, body: { ok: true, accountId: GUEST, callsign: "ROOK", txHashes: ["REG", "FUND"] } });
      expect(h.configs[0].contractId).toBe(V1);
      expect(h.configs[0].game).toBeUndefined();
      expect(h.logs[h.logs.length - 1]).toBe(`[faucet] claimed {"accountId":"${GUEST}","callsign":"ROOK","txHashes":["REG","FUND"]}`);
      const again = harness();
      expect((await again.post({ accountId: GUEST, callsign: "rook", game: "v1" }, env)).status).toBe(200);
      expect(again.configs[0]).toMatchObject({ contractId: V1 });
    }
  });
});
