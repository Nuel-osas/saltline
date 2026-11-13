// The v2 guest wallet: the first game's key and account, asked about v2's contract.
import { describe, expect, it } from "vitest";
import { createMockChain2 } from "../src/economy/v2/mock";
import type { Profile } from "../src/economy/v2/types";
import { type AccountLookup2, createGuestWallet2 } from "../src/economy/v2/wallet";
import { WALLET_STORAGE_KEY, createGuestWallet, implicitAccountId } from "../src/economy/wallet";

function memory(): Storage {
  const m = new Map<string, string>();
  return { length: 0, clear: () => m.clear(), getItem: (k) => m.get(k) ?? null, key: () => null, removeItem: (k) => void m.delete(k), setItem: (k, v) => void m.set(k, String(v)) };
}

const PROFILE: Profile = { accountId: "x", callsign: "ROOK", registeredAt: 1, raids: 0, extractions: 0, deaths: 0, arrears: 0, activeRaid: null, built: 0, royalties: 0 };

function lookup(o: { exists?: boolean | Error; profile?: Profile | null | Error }) {
  const calls: string[] = [];
  const l: AccountLookup2 = {
    async accountExists(id) {
      calls.push(`exists ${id}`);
      if (o.exists instanceof Error) throw o.exists;
      return o.exists ?? true;
    },
    async profile(id) {
      calls.push(`profile ${id}`);
      if (o.profile instanceof Error) throw o.profile;
      return o.profile ?? null;
    },
  };
  return { l, calls };
}

describe("v2 guest wallet", () => {
  it("is the same browser key and account as the first game's wallet", () => {
    const storage = memory();
    const v1 = createGuestWallet({ storage });
    const v2 = createGuestWallet2({ storage });
    expect(v2.kind).toBe("guest");
    expect(v2.accountId()).toBe(v1.accountId());
    expect(v2.accountId()).toMatch(/^[0-9a-f]{64}$/);
    expect(v2.signingKey()).toEqual(v1.signingKey());
    expect(v2.publicKey()).toBe(v1.publicKey());
    expect(implicitAccountId(v2.exportKey())).toBe(v2.accountId());
    expect(v2.persistent).toBe(true);
    expect(JSON.parse(storage.getItem(WALLET_STORAGE_KEY) as string).accountId).toBe(v2.accountId());
  });

  it("registered() reads the v2 profile: no account or no profile is no, a profile is yes, and yes is remembered", async () => {
    const none = lookup({ exists: false });
    const w = createGuestWallet2({ storage: memory(), lookup: none.l });
    expect(await w.registered()).toBe(false);
    expect(none.calls).toEqual([`exists ${w.accountId()}`]);
    // The account exists (the first game funded it) but has no v2 profile yet.
    const funded = lookup({ exists: true, profile: null });
    w.setLookup(funded.l);
    expect(await w.registered()).toBe(false);
    expect(funded.calls).toEqual([`exists ${w.accountId()}`, `profile ${w.accountId()}`]);
    const yes = lookup({ exists: true, profile: PROFILE });
    w.setLookup(yes.l);
    expect(await w.registered()).toBe(true);
    expect(await w.registered()).toBe(true);
    expect(yes.calls).toHaveLength(2);
  });

  it("a failed read is unknown, never 'not registered'", async () => {
    const down = lookup({ exists: new Error("rpc down") });
    const w = createGuestWallet2({ storage: memory(), lookup: down.l });
    await expect(w.registered()).rejects.toThrow("rpc down");
    w.setLookup(lookup({ exists: true, profile: new Error("view failed") }).l);
    await expect(w.registered()).rejects.toThrow("view failed");
    await expect(createGuestWallet2({ storage: memory() }).registered()).rejects.toThrow(/No chain/);
  });

  it("works against the chain's own views", async () => {
    const mock = createMockChain2(1, { storage: null, stash: null });
    const w = createGuestWallet2({ storage: memory(), lookup: { accountExists: async () => true, profile: mock.profile } });
    expect(await w.registered()).toBe(false);
    await mock.register(w.accountId() as string, "ROOKIE");
    expect(await w.registered()).toBe(true);
  });

  it("claim posts { accountId, callsign, game: 'v2' } to the faucet", async () => {
    const sent: { url: string; init: RequestInit }[] = [];
    const fetchStub = (async (url: string, init: RequestInit) => {
      sent.push({ url, init });
      return new Response(JSON.stringify({ ok: true, accountId: "x", txHashes: ["H1", "H2"] }), { status: 200 });
    }) as unknown as typeof fetch;
    const w = createGuestWallet2({ storage: memory(), fetch: fetchStub, faucetUrl: "/api/faucet", lookup: lookup({ exists: false }).l });
    expect(await w.claim(" rook ")).toEqual({ ok: true, txHash: "H2" });
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe("/api/faucet");
    expect(sent[0].init.method).toBe("POST");
    expect(JSON.parse(String(sent[0].init.body))).toEqual({ accountId: w.accountId(), callsign: "ROOK", game: "v2" });
    // A confirmed claim is remembered without another read.
    expect(await w.registered()).toBe(true);
    // The secret key never leaves the browser.
    expect(String(sent[0].init.body)).not.toContain(w.exportKey().slice(8));
  });

  it("the first game's wallet still sends no game at all", async () => {
    const sent: RequestInit[] = [];
    const fetchStub = (async (_url: string, init: RequestInit) => {
      sent.push(init);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;
    const w = createGuestWallet({ storage: memory(), fetch: fetchStub });
    await w.claim("ROOK");
    expect(JSON.parse(String(sent[0].body))).toEqual({ accountId: w.accountId(), callsign: "ROOK" });
  });

  it("claim reports a refusal, a pending answer and an unreachable faucet without throwing", async () => {
    const answer = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
    const mk = (f: typeof fetch) => createGuestWallet2({ storage: memory(), fetch: f });
    expect(await mk(answer(200, { ok: true })).claim("x")).toMatchObject({ ok: false });
    expect(await mk(answer(409, { ok: false, error: "That callsign is taken." })).claim("ROOK")).toEqual({ ok: false, error: "That callsign is taken.", txHash: undefined });
    expect(await mk(answer(503, { ok: false, error: "The dock office is closed: the v2 faucet isn't configured." })).claim("ROOK")).toMatchObject({ ok: false, error: "The dock office is closed: the v2 faucet isn't configured." });
    expect(await mk(answer(202, { ok: false, pending: true, txHashes: ["H"], error: "Registration sent, not confirmed yet. Try again in a minute." })).claim("ROOK")).toMatchObject({ ok: false, pending: true, txHash: "H" });
    const dead = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    expect(await mk(dead).claim("ROOK")).toEqual({ ok: false, error: "Couldn't reach the dock office. Try again." });
  });

  it("importing a backed-up key forgets the old account's registration", async () => {
    const other = createGuestWallet2({ storage: memory() });
    const w = createGuestWallet2({ storage: memory(), lookup: lookup({ exists: true, profile: PROFILE }).l });
    expect(await w.registered()).toBe(true);
    expect(w.importKey(other.exportKey())).toBe(other.accountId());
    w.setLookup(lookup({ exists: false }).l);
    expect(await w.registered()).toBe(false);
    expect(() => w.importKey("nonsense")).toThrow();
  });
});
