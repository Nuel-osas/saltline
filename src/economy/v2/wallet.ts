// The guest wallet for v2: the same browser key and implicit account as the first game (../wallet.ts, same storage
// key, so a returning player keeps their account and its testnet NEAR). What differs is which contract it asks
// about: `registered()` reads the v2 profile, and `claim` tells the faucet to register on the v2 contract.
import type { Profile as V1Profile } from "../types";
import { type AccountLookup, type GuestWallet, type GuestWalletOptions, createGuestWallet } from "../wallet";
import type { Chain2, TxResult, Wallet2 } from "./types";

/** What the wallet needs from the v2 chain; createTestnetChain2 provides both. */
export interface AccountLookup2 {
  accountExists(accountId: string): Promise<boolean>;
  profile: Chain2["profile"];
}

export interface GuestWallet2 extends Wallet2, Pick<GuestWallet, "persistent" | "publicKey" | "signingKey" | "exportKey" | "importKey"> {
  readonly kind: "guest";
  setLookup(lookup: AccountLookup2): void;
}

export type GuestWallet2Options = Omit<GuestWalletOptions, "lookup" | "game"> & { lookup?: AccountLookup2 | null };

// The first game's wallet only asks whether the profile is null, so the v2 profile can stand in for its own.
const adapt = (l: AccountLookup2): AccountLookup => ({
  accountExists: (id) => l.accountExists(id),
  profile: async (id) => (await l.profile(id)) as unknown as V1Profile | null,
});

export function createGuestWallet2(opts: GuestWallet2Options = {}): GuestWallet2 {
  const { lookup, ...rest } = opts;
  const inner = createGuestWallet({ ...rest, game: "v2", lookup: lookup ? adapt(lookup) : null });
  return {
    kind: "guest",
    persistent: inner.persistent,
    accountId: () => inner.accountId(),
    publicKey: () => inner.publicKey(),
    signingKey: () => inner.signingKey(),
    exportKey: () => inner.exportKey(),
    importKey: (key) => inner.importKey(key),
    setLookup: (l) => inner.setLookup(adapt(l)),
    registered: () => inner.registered(),
    claim: (callsign): Promise<TxResult> => inner.claim(callsign),
  };
}
