// Signing on (docs/GAME.md → Custody): before a raid starts, the contract locks the loadout and hands back the
// manifest. The run waits for it, so a raid never starts with a gun the contract hasn't locked. A refusal, or no
// confirmation inside the time allowed, is said plainly; the game then offers one raid off the books (the issue
// rifle, no loot). No answer is not a refusal: the call may have landed, so it reads as unconfirmed, never failed.
import type { Chain2, Loadout, Raid, Wallet2, Weapon } from "../types";
import { checkRaid, cleanLoadout, resolveGun } from "./rules";

export const SIGN_ON_MS = 8_000;

export type SignOn =
  | { kind: "signed"; raid: Raid; weapon: Weapon | null; loadout: Loadout; /** The loadout's gun was gone: the issue rifle went instead. */ fellBack: boolean }
  | { kind: "refused"; why: string }
  | { kind: "unconfirmed"; why: string };

export interface SignOnDeps {
  /** `balances`, when given, is read so gear the stash no longer holds isn't asked for. */
  chain: Pick<Chain2, "weapon" | "startRaid"> & Partial<Pick<Chain2, "balances">>;
  wallet: Pick<Wallet2, "accountId">;
  loadout: Loadout;
  timeoutMs?: number;
  /** Resolves after `ms` (tests pass their own clock). */
  sleep?: (ms: number) => Promise<void>;
  /** Told which gun is going in once the armoury has answered (null: the issue rifle), for the card. */
  onGun?: (weapon: Weapon | null, fellBack: boolean) => void;
}

const TIMEOUT: unique symbol = Symbol("timeout");

export async function signOn(deps: SignOnDeps): Promise<SignOn> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((ok) => setTimeout(ok, ms)));
  const deadline: Promise<typeof TIMEOUT> = sleep(deps.timeoutMs ?? SIGN_ON_MS).then((): typeof TIMEOUT => TIMEOUT);
  const inTime = <T>(fn: () => Promise<T>): Promise<T | typeof TIMEOUT> => {
    let p: Promise<T>;
    try {
      p = Promise.resolve(fn());
    } catch (e) {
      p = Promise.reject(e);
    }
    return Promise.race<T | typeof TIMEOUT>([p, deadline]);
  };

  const account = deps.wallet.accountId();
  if (!account) return { kind: "refused", why: "No dock pass on file. Sign on at the dock." };

  // The gun the loadout names, as the contract holds it now. A failed read is unknown, and an unknown gun can't be
  // put in the player's hands.
  let named = cleanLoadout(deps.loadout);
  let weapon: Weapon | null = null;
  let fellBack = false;
  if (named.weapon) {
    let held: Weapon | null | typeof TIMEOUT;
    try {
      held = await inTime(() => deps.chain.weapon(named.weapon!));
    } catch {
      return { kind: "unconfirmed", why: "The armoury didn't answer. Your gun stays in the stash." };
    }
    if (held === TIMEOUT) return { kind: "unconfirmed", why: "The armoury didn't answer in time. Your gun stays in the stash." };
    const r = resolveGun(named, held, account);
    named = r.loadout;
    weapon = r.weapon;
    fellBack = r.fellBack;
  }
  try {
    deps.onGun?.(weapon, fellBack);
  } catch {
    /* the card is a nicety */
  }

  // Gear the stash no longer holds (used up, or lost with the last raid) can't be brought: the contract would refuse
  // the whole raid for it. A failed read is unknown, so the loadout goes as named and the contract decides.
  if (named.plates + named.charges + named.mags > 0 && deps.chain.balances) {
    try {
      const bal = await inTime(() => deps.chain.balances!(account));
      if (bal !== TIMEOUT && bal && typeof bal === "object") {
        const held = (n: unknown) => (typeof n === "number" && Number.isInteger(n) && n > 0 ? n : 0);
        named = { ...named, plates: Math.min(named.plates, held(bal.plate)), charges: Math.min(named.charges, held(bal.charge)), mags: Math.min(named.mags, held(bal.ammo)) };
      }
    } catch {
      /* unknown: the contract decides */
    }
  }

  let res: Awaited<ReturnType<Chain2["startRaid"]>> | typeof TIMEOUT;
  try {
    res = await inTime(() => deps.chain.startRaid(named));
  } catch {
    return { kind: "unconfirmed", why: "No answer from the ledger. The raid isn't confirmed." };
  }
  if (res === TIMEOUT) return { kind: "unconfirmed", why: "The ledger didn't confirm in time." };
  if (!res || !res.ok) {
    if (res && res.pending) return { kind: "unconfirmed", why: "Sent, not confirmed. It may still land." };
    return { kind: "refused", why: (res && res.error) || "The contract refused the raid." };
  }
  const raid = checkRaid(res.raid);
  if (!raid) return { kind: "refused", why: "The manifest came back unreadable." };
  return { kind: "signed", raid, weapon, loadout: named, fellBack };
}
