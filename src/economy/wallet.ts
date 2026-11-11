// The guest wallet (docs/ECONOMY.md → Wallets and accounts). An ed25519 key made in the browser and kept in
// localStorage; the account is the key's implicit account (the public key as 64 lowercase hex characters), which
// exists on chain once the faucet sends it testnet NEAR. Every call after that is signed here, with no prompt.
//
// No import.meta in this file: server/faucet.ts imports the account and callsign checks from it.
import { generateKey, isPrivateKey, isValidAccountId, parseKey } from "near-kit";
import type { Profile, TxResult, Wallet } from "./types";

export const WALLET_STORAGE_KEY = "saltline.wallet.v1";
/** Where importKey() puts the key it replaced, so a mistaken import can't destroy a wallet. */
export const REPLACED_STORAGE_KEY = "saltline.wallet.v1.replaced";

const IMPLICIT = /^[0-9a-f]{64}$/;
const CALLSIGN = /^[A-Z0-9\-._ ]{3,16}$/;

export const isImplicitAccountId = (id: string) => IMPLICIT.test(id);

/** A 64-hex implicit account, or any other well-formed NEAR account id. */
export const isAccountId = (id: string) => typeof id === "string" && (IMPLICIT.test(id) || isValidAccountId(id));

/** Callsigns are 3–16 characters of A–Z 0–9 - . _ and space, stored upper-case. Returns null when invalid. */
export function normalizeCallsign(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const cs = raw.trim().toUpperCase();
  return CALLSIGN.test(cs) ? cs : null;
}

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

/** The implicit account id of an ed25519 key: its 32 public-key bytes as lowercase hex. */
export function implicitAccountId(privateKey: string): string {
  const pair = parseKey(privateKey);
  if (!privateKey.startsWith("ed25519:") || pair.publicKey.data.length !== 32) {
    throw new Error("Only ed25519 keys have implicit accounts");
  }
  return hex(pair.publicKey.data);
}

/** What the wallet needs to know about the chain; chain.ts provides it. */
export interface AccountLookup {
  accountExists(accountId: string): Promise<boolean>;
  profile(accountId: string): Promise<Profile | null>;
}

/** What chain.ts signs with. */
export interface SigningKey {
  accountId: string;
  privateKey: `ed25519:${string}`;
}

export interface GuestWallet extends Wallet {
  readonly kind: "guest";
  /** False when the browser refused localStorage: the key lives only as long as this tab. */
  readonly persistent: boolean;
  publicKey(): string;
  signingKey(): SigningKey;
  /** The secret key in NEAR's standard `ed25519:…` form, for Settings → "Back up wallet". */
  exportKey(): string;
  /** Replaces this browser's wallet with a backed-up key and returns its account id. Throws on a bad key. */
  importKey(key: string): string;
  setLookup(lookup: AccountLookup): void;
}

export interface GuestWalletOptions {
  storage?: Storage | null;
  faucetUrl?: string;
  fetch?: typeof fetch;
  lookup?: AccountLookup | null;
  now?: () => number;
}

interface Stored {
  v: 1;
  accountId: string;
  secretKey: string;
  createdAt: number;
}

function memoryStorage(): Storage {
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

function defaultStorage(): { storage: Storage; persistent: boolean } {
  try {
    const s = globalThis.localStorage;
    if (s) {
      s.setItem("saltline.probe", "1");
      s.removeItem("saltline.probe");
      return { storage: s, persistent: true };
    }
  } catch {
    // Private mode or storage disabled: fall through to memory.
  }
  return { storage: memoryStorage(), persistent: false };
}

function readStored(storage: Storage): Stored | null {
  let raw: string | null;
  try {
    raw = storage.getItem(WALLET_STORAGE_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const s = JSON.parse(raw) as Partial<Stored>;
    if (s.v !== 1 || typeof s.secretKey !== "string" || !isPrivateKey(s.secretKey)) return null;
    // Derive the id from the key rather than trusting the stored one.
    const accountId = implicitAccountId(s.secretKey);
    return { v: 1, accountId, secretKey: s.secretKey, createdAt: Number(s.createdAt) || 0 };
  } catch {
    return null;
  }
}

export function createGuestWallet(opts: GuestWalletOptions = {}): GuestWallet {
  const fallback = opts.storage === undefined ? defaultStorage() : null;
  const storage = opts.storage ?? fallback?.storage ?? memoryStorage();
  const persistent = opts.storage ? true : (fallback?.persistent ?? false);
  const now = opts.now ?? Date.now;
  const faucetUrl = opts.faucetUrl ?? "/api/faucet";
  const doFetch = opts.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  let lookup = opts.lookup ?? null;

  const write = (s: Stored) => {
    try {
      storage.setItem(WALLET_STORAGE_KEY, JSON.stringify(s));
    } catch (e) {
      console.warn("[economy] the wallet could not be saved in this browser; back it up from Settings", e);
    }
  };

  let current = readStored(storage);
  if (!current) {
    // A stored blob we couldn't read is kept aside, never overwritten silently.
    try {
      const bad = storage.getItem(WALLET_STORAGE_KEY);
      if (bad) storage.setItem(`${WALLET_STORAGE_KEY}.unreadable`, bad);
    } catch {
      // ignore
    }
    const pair = generateKey();
    current = { v: 1, accountId: hex(pair.publicKey.data), secretKey: pair.secretKey, createdAt: now() };
    write(current);
  }
  let state: Stored = current;
  // Registration never goes away, so a confirmed "yes" is cached; "no" and failures are asked again next time.
  let knownRegistered = false;

  return {
    kind: "guest",
    persistent,
    accountId: () => state.accountId,
    publicKey: () => parseKey(state.secretKey).publicKey.toString(),
    signingKey: () => ({ accountId: state.accountId, privateKey: state.secretKey as `ed25519:${string}` }),
    exportKey: () => state.secretKey,
    importKey(key: string) {
      const k = String(key ?? "").trim();
      if (!k.startsWith("ed25519:") || !isPrivateKey(k)) throw new Error("That isn't an ed25519 secret key.");
      const accountId = implicitAccountId(k);
      if (accountId === state.accountId) return accountId;
      try {
        storage.setItem(REPLACED_STORAGE_KEY, JSON.stringify(state));
      } catch {
        // ignore: the import still proceeds, the caller warned the player to back up first
      }
      state = { v: 1, accountId, secretKey: k, createdAt: now() };
      write(state);
      knownRegistered = false;
      return accountId;
    },
    setLookup(l: AccountLookup) {
      lookup = l;
    },
    async registered() {
      if (knownRegistered) return true;
      if (!lookup) throw new Error("No chain to check the account against");
      const id = state.accountId;
      // Both reads reject on failure, so an RPC outage comes back as an error, never as "not registered".
      if (!(await lookup.accountExists(id))) return false;
      const profile = await lookup.profile(id);
      knownRegistered = profile !== null && id === state.accountId;
      return profile !== null;
    },
    async claim(callsign: string): Promise<TxResult> {
      const cs = normalizeCallsign(callsign);
      if (!cs) return { ok: false, error: "Callsigns are 3–16 letters, digits, spaces, dashes, dots or underscores." };
      let res: Response;
      try {
        res = await doFetch(faucetUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ accountId: state.accountId, callsign: cs }),
        });
      } catch {
        // The faucet funds an account at most once and refuses a registered one, so asking again is safe.
        return { ok: false, error: "Couldn't reach the dock office. Try again." };
      }
      let body: { ok?: unknown; error?: unknown; txHashes?: unknown; pending?: unknown } | null = null;
      try {
        body = await res.json();
      } catch {
        body = null;
      }
      const hashes = Array.isArray(body?.txHashes) ? body.txHashes.filter((h): h is string => typeof h === "string") : [];
      if (res.ok && body?.ok === true) {
        knownRegistered = true;
        return { ok: true, txHash: hashes[hashes.length - 1] };
      }
      const error = typeof body?.error === "string" ? body.error : `The dock office answered ${res.status}.`;
      const out: TxResult & { pending?: boolean } = { ok: false, error, txHash: hashes[hashes.length - 1] };
      if (body?.pending === true) out.pending = true;
      return out;
    },
  };
}
