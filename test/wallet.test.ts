import { generateKey, parseKey } from "near-kit";
import { describe, expect, it } from "vitest";
import type { Profile } from "../src/economy/types";
import {
  REPLACED_STORAGE_KEY,
  WALLET_STORAGE_KEY,
  type AccountLookup,
  createGuestWallet,
  implicitAccountId,
  normalizeCallsign,
} from "../src/economy/wallet";

function memStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => void m.set(k, String(v)),
  };
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const profile: Profile = { accountId: "x", callsign: "ROOK", registeredAt: 1, runs: 0, extractions: 0, deaths: 0, bestHaul: 0 };

describe("guest wallet keys", () => {
  it("makes an ed25519 key, stores it, and uses its implicit account (64 lowercase hex of the public key)", () => {
    const storage = memStorage();
    const w = createGuestWallet({ storage });
    const id = w.accountId()!;
    expect(id).toMatch(/^[0-9a-f]{64}$/);
    const stored = JSON.parse(storage.getItem(WALLET_STORAGE_KEY)!);
    expect(stored).toMatchObject({ v: 1, accountId: id });
    expect(stored.secretKey).toMatch(/^ed25519:/);
    expect(hex(parseKey(stored.secretKey).publicKey.data)).toBe(id);
    expect(w.publicKey()).toBe(parseKey(stored.secretKey).publicKey.toString());
    expect(w.signingKey()).toEqual({ accountId: id, privateKey: stored.secretKey });
    expect(w.kind).toBe("guest");
  });

  it("keeps the same account across a reload", () => {
    const storage = memStorage();
    const a = createGuestWallet({ storage }).accountId();
    expect(createGuestWallet({ storage }).accountId()).toBe(a);
  });

  it("round-trips a backup: export on one browser, import on another", () => {
    const original = createGuestWallet({ storage: memStorage() });
    const backup = original.exportKey();
    const otherStorage = memStorage();
    const other = createGuestWallet({ storage: otherStorage });
    const replaced = other.accountId();
    expect(other.importKey(`  ${backup}\n`)).toBe(original.accountId());
    expect(other.accountId()).toBe(original.accountId());
    expect(createGuestWallet({ storage: otherStorage }).accountId()).toBe(original.accountId());
    // The key it replaced is kept aside, not destroyed.
    expect(JSON.parse(otherStorage.getItem(REPLACED_STORAGE_KEY)!).accountId).toBe(replaced);
  });

  it("refuses keys that aren't ed25519 secret keys", () => {
    const w = createGuestWallet({ storage: memStorage() });
    const before = w.accountId();
    for (const bad of ["", "hello", "ed25519:notbase58!!", w.publicKey(), `secp256k1:${"1".repeat(44)}`]) {
      expect(() => w.importKey(bad)).toThrow();
    }
    expect(w.accountId()).toBe(before);
  });

  it("derives the implicit id from any ed25519 key", () => {
    const k = generateKey();
    expect(implicitAccountId(k.secretKey)).toBe(hex(k.publicKey.data));
  });
});

describe("callsigns", () => {
  it("upper-cases and trims; allows A–Z 0–9 - . _ and space, 3–16 long", () => {
    expect(normalizeCallsign(" rook-7 ")).toBe("ROOK-7");
    expect(normalizeCallsign("low tide")).toBe("LOW TIDE");
    expect(normalizeCallsign("dock.rat_2")).toBe("DOCK.RAT_2");
    for (const bad of ["ab", "x".repeat(17), "bad*char", "émile", 42, null]) expect(normalizeCallsign(bad)).toBeNull();
  });
});

describe("guest wallet: registration and the faucet", () => {
  const lookup = (exists: boolean | Error, prof: Profile | null): AccountLookup => ({
    accountExists: async () => {
      if (exists instanceof Error) throw exists;
      return exists;
    },
    profile: async () => prof,
  });

  it("is registered only when the account exists and has a profile; an outage is an error, not a no", async () => {
    expect(await createGuestWallet({ storage: memStorage(), lookup: lookup(false, null) }).registered()).toBe(false);
    expect(await createGuestWallet({ storage: memStorage(), lookup: lookup(true, null) }).registered()).toBe(false);
    expect(await createGuestWallet({ storage: memStorage(), lookup: lookup(true, profile) }).registered()).toBe(true);
    await expect(createGuestWallet({ storage: memStorage(), lookup: lookup(new Error("rpc down"), null) }).registered()).rejects.toThrow("rpc down");
  });

  it("claims by POSTing { accountId, callsign } to the faucet", async () => {
    const sent: { url: string; init: RequestInit }[] = [];
    const fetchStub = async (url: RequestInfo | URL, init?: RequestInit) => {
      sent.push({ url: String(url), init: init! });
      return new Response(JSON.stringify({ ok: true, accountId: "x", txHashes: ["H1", "H2"] }), { status: 200 });
    };
    const w = createGuestWallet({ storage: memStorage(), faucetUrl: "/api/faucet", fetch: fetchStub as typeof fetch, lookup: lookup(false, null) });
    expect(await w.claim(" rook ")).toEqual({ ok: true, txHash: "H2" });
    expect(sent[0].url).toBe("/api/faucet");
    expect(sent[0].init.method).toBe("POST");
    expect(JSON.parse(String(sent[0].init.body))).toEqual({ accountId: w.accountId(), callsign: "ROOK" });
    // A successful claim is remembered, so the next check needs no RPC.
    expect(await w.registered()).toBe(true);
  });

  it("passes on the faucet's refusal, says pending when it does, and survives an unreachable faucet", async () => {
    const answer = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
    const taken = createGuestWallet({ storage: memStorage(), fetch: answer(409, { ok: false, error: "Callsign taken" }) });
    expect(await taken.claim("rook")).toEqual({ ok: false, error: "Callsign taken" });
    const pending = createGuestWallet({ storage: memStorage(), fetch: answer(202, { ok: false, pending: true, error: "Sent", txHashes: ["H"] }) });
    expect(await pending.claim("rook")).toEqual({ ok: false, pending: true, error: "Sent", txHash: "H" });
    const down = createGuestWallet({
      storage: memStorage(),
      fetch: (async () => {
        throw new TypeError("Failed to fetch");
      }) as unknown as typeof fetch,
    });
    expect(await down.claim("rook")).toMatchObject({ ok: false });
  });

  it("never calls the faucet with a bad callsign", async () => {
    let calls = 0;
    const w = createGuestWallet({ storage: memStorage(), fetch: (async () => (calls++, new Response("{}"))) as unknown as typeof fetch });
    expect((await w.claim("a*")).ok).toBe(false);
    expect(calls).toBe(0);
  });
});
