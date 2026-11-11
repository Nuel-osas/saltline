// What every Dockside panel shares: the economy, the latest reads, and one way to run an action so each shows
// "settling…" while pending, then the TxResult. Reads are tri-state: loading, ok, or unknown (a failed read is
// never shown as zero). A rejected call is ambiguous (it may still land), so it shows as unknown, never as failed.
import { h, text } from "./dom";
import { AMBIGUOUS } from "./format";
import type { Amounts, BrokerView, Chain, Economy, GearId, Leaderboard, LedgerEvent, Listing, Profile, TxResult, Wallet } from "../types";

export type Read<T> = { s: "loading" } | { s: "ok"; v: T } | { s: "unknown"; error: string };
export const okv = <T>(r: Read<T>): T | null => (r.s === "ok" ? r.v : null);

export interface Reads {
  brokers: Read<BrokerView[]>;
  balances: Read<Amounts>;
  profile: Read<Profile | null>;
  listings: Read<Listing[]>;
  recent: Read<LedgerEvent[]>;
  leaderboard: Read<Leaderboard>;
}
export type ReadKey = keyof Reads;

export type EconomyWithGear = Omit<Economy, "equipped"> & { equipped?: GearId[] };

export interface Ctx {
  readonly economy: Economy;
  readonly chain: Chain;
  readonly wallet: Wallet;
  readonly reads: Reads;
  me(): string | null;
  refresh(...keys: ReadKey[]): Promise<void>;
  /** Run a call: the slot shows settling, then the result; the named reads refresh afterwards. */
  act<T extends TxResult>(slot: Slot, run: ActSpec<T>): Promise<T | null>;
  /** The game's UI sounds, if the game is there. */
  sound(kind: "click" | "hover"): void;
  /** Throttled flap tick. */
  flapTick(): void;
  /** Repaint everything from the current reads. */
  render(): void;
}

export interface ActSpec<T extends TxResult> {
  pending: string;
  call: () => Promise<T>;
  done: (r: T) => string;
  refresh: ReadKey[];
}

export type SlotState = "idle" | "pending" | "ok" | "error" | "unknown";

/** A receipt line: where an action's progress and result show. */
export interface Slot {
  readonly el: HTMLElement;
  readonly state: SlotState;
  set(state: SlotState, msg?: string, href?: string | null): void;
  /** Called when the state changes (panels lock their buttons while pending). */
  onChange?: (s: SlotState) => void;
}

export function createSlot(className = ""): Slot {
  const msg = h("span", { class: "dk-slot-t" });
  const link = h("a", { class: "dk-slot-a", target: "_blank", rel: "noopener" }, "tx ↗");
  const el = h("p", { class: `dk-slot ${className}`.trim(), "data-state": "idle", role: "status", "aria-live": "polite" }, h("i", { "aria-hidden": "true" }), msg, link);
  link.hidden = true;
  let state: SlotState = "idle";
  let fade: ReturnType<typeof setTimeout> | null = null;
  const slot: Slot = {
    el,
    get state() {
      return state;
    },
    set(s, m = "", href = null) {
      state = s;
      el.dataset.state = s;
      text(msg, m);
      link.hidden = !href;
      if (href) link.href = href;
      if (fade) clearTimeout(fade);
      // Results stay up a while, then quieten and clear (errors and unknowns stay until the next action).
      if (s === "ok")
        fade = setTimeout(() => {
          el.classList.add("old");
          fade = setTimeout(() => slot.state === "ok" && slot.set("idle"), 6000);
        }, 9000);
      el.classList.remove("old");
      slot.onChange?.(s);
    },
  };
  return slot;
}

export async function runAct<T extends TxResult>(ctx: Pick<Ctx, "chain" | "refresh">, slot: Slot, spec: ActSpec<T>): Promise<T | null> {
  if (slot.state === "pending") return null;
  slot.set("pending", spec.pending);
  let r: T;
  try {
    r = await spec.call();
  } catch {
    slot.set("unknown", AMBIGUOUS);
    await ctx.refresh(...spec.refresh);
    return null;
  }
  // The chain client marks a call that may have landed but couldn't be confirmed as `pending` (main's TxResult):
  // that is the same ambiguous case as a rejection, so it shows as unknown, never as failed.
  const unconfirmed = !!r && !r.ok && (r as TxResult & { pending?: boolean }).pending === true;
  if (r && r.ok) slot.set("ok", spec.done(r), r.txHash ? ctx.chain.txUrl(r.txHash) : null);
  else if (unconfirmed) slot.set("unknown", AMBIGUOUS, r.txHash ? ctx.chain.txUrl(r.txHash) : null);
  else slot.set("error", (r && r.error) || "The dock refused that.");
  await ctx.refresh(...spec.refresh);
  return r;
}
