import { generateKey } from "near-kit";
import { describe, expect, it } from "vitest";
import vercel from "../api/faucet";
import type { Executed } from "../src/economy/chain";
import { FUND_YOCTO, type FaucetChain, type FaucetEnv, handleFaucet, newLimits, redact } from "../server/faucet";

const KEY = generateKey().secretKey;
const KEY_BODY = KEY.slice("ed25519:".length);
const ENV: FaucetEnv = {
  FAUCET_ACCOUNT_ID: "faucet.saltline.testnet",
  FAUCET_PRIVATE_KEY: KEY,
  VITE_CONTRACT_ID: "saltline.testnet",
  VITE_NEAR_NETWORK: "testnet",
};
const GUEST = "ab".repeat(32);
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
  let t = T0;
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
  let chainBuilt = 0;
  const post = async (body: unknown, ip = "203.0.113.7", env: FaucetEnv = ENV, method = "POST") => {
    const res = await handleFaucet(
      new Request("http://localhost/api/faucet", {
        method,
        headers: { "content-type": "application/json", "x-forwarded-for": ip },
        body: method === "GET" ? undefined : typeof body === "string" ? body : JSON.stringify(body),
      }),
      env,
      {
        chain: () => (chainBuilt++, chain),
        limits,
        now: () => t,
        log: (l) => logs.push(l),
      },
    );
    const text = await res.text();
    bodies.push(text);
    return { status: res.status, body: JSON.parse(text) as Record<string, unknown>, headers: res.headers };
  };
  return { post, calls, logs, bodies, advance: (ms: number) => (t += ms), chainBuilt: () => chainBuilt };
}

describe("faucet: validation", () => {
  it("answers POST only", async () => {
    const h = harness();
    expect((await h.post(null, undefined, ENV, "GET")).status).toBe(405);
  });

  it("rejects bad JSON, bad account ids and bad callsigns without touching the chain", async () => {
    const h = harness();
    expect((await h.post("{not json")).status).toBe(400);
    for (const accountId of ["", "Not.An.Account", "ab".repeat(33), "AB".repeat(32), 42]) {
      expect((await h.post({ accountId, callsign: "rook" })).status).toBe(400);
    }
    for (const callsign of ["ab", "x".repeat(17), "bad*char", "", null]) {
      expect((await h.post({ accountId: GUEST, callsign })).status).toBe(400);
    }
    expect(h.calls).toEqual([]);
  });

  it("accepts a valid named account and upper-cases the callsign", async () => {
    const h = harness({ exists: true });
    const r = await h.post({ accountId: "rook.testnet", callsign: " low tide " });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, accountId: "rook.testnet", callsign: "LOW TIDE", txHashes: ["REG"] });
    // It already exists, so it isn't funded.
    expect(h.calls).toEqual(["profile rook.testnet", "exists rook.testnet", "register rook.testnet LOW TIDE"]);
  });
});

describe("faucet: fail closed", () => {
  it("answers 503 and does nothing when any required env is missing or wrong", async () => {
    const broken: FaucetEnv[] = [
      { ...ENV, FAUCET_ACCOUNT_ID: undefined },
      { ...ENV, FAUCET_PRIVATE_KEY: undefined },
      { ...ENV, FAUCET_PRIVATE_KEY: "not-a-key" },
      { ...ENV, VITE_CONTRACT_ID: undefined },
      { ...ENV, VITE_NEAR_NETWORK: undefined },
      { ...ENV, VITE_NEAR_NETWORK: "mainnet" },
      { ...ENV, NEAR_RPC: "http://rpc.example" },
    ];
    for (const env of broken) {
      const h = harness();
      const r = await h.post({ accountId: GUEST, callsign: "rook" }, undefined, env);
      expect(r.status).toBe(503);
      expect(h.chainBuilt()).toBe(0);
      expect(h.calls).toEqual([]);
    }
  });

  it("sends nothing when the lookup fails", async () => {
    const h = harness({ exists: new Error("rpc down") });
    expect((await h.post({ accountId: GUEST, callsign: "rook" })).status).toBe(502);
    expect(h.calls.filter((c) => c.startsWith("fund") || c.startsWith("register"))).toEqual([]);
  });

  it("refuses an account that's already registered with 409", async () => {
    const h = harness({ profile: { account_id: GUEST }, exists: true });
    const r = await h.post({ accountId: GUEST, callsign: "rook" });
    expect(r.status).toBe(409);
    expect(h.calls).toEqual([`profile ${GUEST}`, `exists ${GUEST}`]);
  });

  it("never funds when registration is refused", async () => {
    const h = harness({ register: { ok: false, code: "E_CALLSIGN_TAKEN", error: "Callsign taken", txHash: "REG" } });
    const r = await h.post({ accountId: GUEST, callsign: "rook" });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("Callsign taken");
    expect(h.calls.some((c) => c.startsWith("fund"))).toBe(false);
  });

  it("won't create a named account that doesn't exist", async () => {
    const h = harness({ exists: false });
    expect((await h.post({ accountId: "nobody.testnet", callsign: "rook" })).status).toBe(400);
    expect(h.calls.some((c) => c.startsWith("fund") || c.startsWith("register"))).toBe(false);
  });
});

describe("faucet: the claim", () => {
  it("registers, then sends 0.1 NEAR in yocto to the new implicit account", async () => {
    const h = harness();
    const r = await h.post({ accountId: GUEST, callsign: "rook" });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, accountId: GUEST, callsign: "ROOK", txHashes: ["REG", "FUND"] });
    expect(FUND_YOCTO).toBe(100_000_000_000_000_000_000_000n);
    expect(h.calls.slice(2)).toEqual([`register ${GUEST} ROOK`, `fund ${GUEST} ${FUND_YOCTO}`]);
  });

  it("finishes a half-done claim (registered, never funded) by funding only", async () => {
    const h = harness({ profile: { account_id: GUEST }, exists: false });
    const r = await h.post({ accountId: GUEST, callsign: "rook" });
    expect(r.status).toBe(200);
    expect(h.calls.slice(2)).toEqual([`fund ${GUEST} ${FUND_YOCTO}`]);
  });

  it("says pending, never failed, when the transfer can't be confirmed", async () => {
    const h = harness({ fund: { ok: false, pending: true, txHash: "FUND", error: "Sent, not confirmed" } });
    const r = await h.post({ accountId: GUEST, callsign: "rook" });
    expect(r.status).toBe(202);
    expect(r.body).toMatchObject({ ok: false, pending: true, txHashes: ["REG", "FUND"] });
  });

  it("reports a failed transfer after registration as 502 with the hashes so far", async () => {
    const h = harness({ fund: { ok: false, error: "The chain refused the transaction." } });
    const r = await h.post({ accountId: GUEST, callsign: "rook" });
    expect(r.status).toBe(502);
    expect(r.body.txHashes).toEqual(["REG"]);
  });
});

describe("faucet: rate limits", () => {
  it("allows 3 claims an hour per IP", async () => {
    const h = harness({ profile: { account_id: "x" }, exists: true });
    for (let i = 0; i < 3; i++) expect((await h.post({ accountId: `p${i}.testnet`, callsign: "rook" })).status).toBe(409);
    const blocked = await h.post({ accountId: "p9.testnet", callsign: "rook" });
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await h.post({ accountId: "p9.testnet", callsign: "rook" }, "198.51.100.1")).status).toBe(409);
    h.advance(3_600_000);
    expect((await h.post({ accountId: "p9.testnet", callsign: "rook" })).status).toBe(409);
  });

  it("allows 3 tries an hour per account, whatever the IP", async () => {
    const h = harness({ profile: { account_id: GUEST }, exists: true });
    for (let i = 0; i < 3; i++) expect((await h.post({ accountId: GUEST, callsign: "rook" }, `10.0.0.${i}`)).status).toBe(409);
    expect((await h.post({ accountId: GUEST, callsign: "rook" }, "10.0.0.99")).status).toBe(429);
  });
});

describe("faucet: the key", () => {
  it("never appears in a response or a log line, whatever goes wrong", async () => {
    const leaky = new Error(`signing failed with ${KEY} (body ${KEY_BODY})`);
    const scenarios: ReturnType<typeof harness>[] = [];
    const run = async (opts: StubOpts, body: unknown = { accountId: GUEST, callsign: "rook" }, env: FaucetEnv = ENV) => {
      const h = harness(opts);
      scenarios.push(h);
      await h.post(body, undefined, env);
    };
    await run({});
    await run({ profile: leaky });
    await run({ exists: leaky });
    await run({ register: { ok: false, error: `boom ${KEY}` } });
    await run({ fund: { ok: false, error: `boom ${KEY_BODY}` } });
    await run({}, "{bad");
    await run({}, { accountId: GUEST, callsign: "rook" }, { ...ENV, VITE_CONTRACT_ID: undefined });
    for (const h of scenarios) {
      for (const text of [...h.bodies, ...h.logs]) {
        expect(text).not.toContain(KEY);
        expect(text).not.toContain(KEY_BODY);
      }
    }
    expect(scenarios.flatMap((h) => h.logs).some((l) => l.includes("[redacted]"))).toBe(true);
  });

  it("redact() removes the key and its bare body", () => {
    expect(redact(`a ${KEY} b ${KEY_BODY} c`, KEY)).toBe("a [redacted] b [redacted] c");
  });
});

describe("api/faucet.ts (the Vercel function)", () => {
  it("exports a fetch handler that answers through the faucet", async () => {
    const res = await vercel.fetch(new Request("http://localhost/api/faucet", { method: "GET" }));
    expect(res.status).toBe(405);
  });
});
