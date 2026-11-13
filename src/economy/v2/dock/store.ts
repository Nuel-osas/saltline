// What every dock screen shares: the reads (each one loading, ok or unknown: a failed read is never shown as 0),
// the action runner (settling, then a result; a call with no answer is pending, never failed), and small builders.
import { h } from "../../dockside/dom";
import { fmt, UNKNOWN } from "../../dockside/format";
import type {
  Amounts,
  Chain2,
  EconomyView,
  HarbormasterView,
  Impounded,
  LedgerEvent,
  Listing,
  Profile,
  Quote,
  TokenId,
  TxResult,
  V2,
  Vendor,
  Wallet2,
  Weapon,
} from "../types";

export type Read<T> = { s: "loading" } | { s: "ok"; v: T } | { s: "unknown"; error: string };
export const okv = <T>(r: Read<T>): T | null => (r.s === "ok" ? r.v : null);

export interface Reads {
  profile: Read<Profile | null>;
  balances: Read<Amounts>;
  weapons: Read<Weapon[]>;
  vendors: Read<Vendor[]>;
  exportPrices: Read<Quote[]>;
  listings: Read<Listing[]>;
  impound: Read<Impounded[]>;
  harbormaster: Read<HarbormasterView>;
  recent: Read<LedgerEvent[]>;
  economy: Read<EconomyView>;
}
export type ReadKey = keyof Reads;
export const READ_KEYS: ReadKey[] = ["profile", "balances", "weapons", "vendors", "exportPrices", "listings", "impound", "harbormaster", "recent", "economy"];

export const emptyReads = (): Reads => ({
  profile: { s: "loading" },
  balances: { s: "loading" },
  weapons: { s: "loading" },
  vendors: { s: "loading" },
  exportPrices: { s: "loading" },
  listings: { s: "loading" },
  impound: { s: "loading" },
  harbormaster: { s: "loading" },
  recent: { s: "loading" },
  economy: { s: "loading" },
});

export type NoteState = "idle" | "settling" | "ok" | "error" | "pending";

/** A call with no answer may have landed: it is never shown as failed, and never sent twice for the player. */
export const MAY_SETTLE = "No answer from the dock. It may still settle: check your stash before trying again.";

export interface ActSpec<T extends TxResult> {
  /** Names the action: any button drawn with this key shows that it is settling. */
  key: string;
  /** Said while the call is out ("Settling: Moss is building a Pilot…"). */
  settling: string;
  run(): Promise<T>;
  /** Said when it lands. */
  done(r: T): string;
  /** What to read again afterwards (the stash is always re-read). */
  refresh?: ReadKey[];
}

export interface Ctx {
  v2: V2;
  chain: Chain2;
  wallet: Wallet2;
  reads: Reads;
  me(): string | null;
  /** The player's callsign, when known. */
  callsign(): string | null;
  /** How many of a token the player holds; null when the balance couldn't be read. */
  holding(id: TokenId): number | null;
  busy(key?: string): boolean;
  refresh(...keys: ReadKey[]): Promise<void>;
  /** Runs one call: settling, then its result. Resolves to the result only when it is confirmed. */
  act<T extends TxResult>(spec: ActSpec<T>): Promise<T | null>;
  note(state: NoteState, text: string): void;
  /** Redraw every screen from the reads. */
  render(): void;
  emit(name: string, e?: unknown): void;
  /** Ms per step of the build reveal (tests shorten it; reduced motion makes it 0). */
  revealMs: number;
}

/** Short names for chips and rows (the full names are in items.ts). */
export const SHORT: Record<Exclude<TokenId, "scrip">, string> = {
  copper: "Copper",
  chips: "Electronics",
  fuel: "Fuel cells",
  meds: "Meds",
  core: "Relay cores",
  servo: "Servos",
  rotor: "Rotors",
  mag2: "Ext. magazine",
  barrel2: "Long barrel",
  comp: "Compensator",
  optic: "Optic",
  plate: "Plates",
  charge: "Charges",
  ammo: "Magazines",
};

// ---- small builders every screen uses ----

/** A number, or the word "unknown" when the read behind it failed or hasn't answered. */
export const numOr = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? UNKNOWN : fmt(n));

export const unknownChip = (what?: string) => h("span", { class: "d2-unk", "data-unknown": "1" }, what ? `${what}: ${UNKNOWN}` : UNKNOWN);

/** A figure in scrip: `1,155` with the unit small after it. */
export const scripEl = (n: number | null | undefined, cls = "") =>
  n == null ? h("span", { class: `d2-scrip unk ${cls}`.trim(), "data-unknown": "1" }, UNKNOWN) : h("span", { class: `d2-scrip ${cls}`.trim() }, h("b", null, fmt(n)), h("i", null, "scrip"));

export interface BtnSpec {
  /** The action key (see ActSpec.key), also what keeps focus on the button across redraws. */
  k: string;
  label: string | Node;
  cls?: string;
  disabled?: boolean;
  /** Why it can't be pressed, said under the pointer and to screen readers. */
  why?: string | null;
  onclick: () => void;
}

/** A button that shows it is settling while its action is out, and waits while any other action is. */
export function actBtn(ctx: Ctx, s: BtnSpec): HTMLButtonElement {
  const mine = ctx.busy(s.k);
  const b = h(
    "button",
    {
      class: `d2-b ${s.cls ?? ""} ${mine ? "busy" : ""}`.trim().replace(/\s+/g, " "),
      type: "button",
      "data-k": s.k,
      disabled: s.disabled || ctx.busy() || null,
      title: s.why ?? null,
      "aria-busy": mine ? "true" : null,
      onclick: () => {
        if (!ctx.busy()) s.onclick();
      },
    },
    mine ? "Settling…" : s.label,
  );
  return b;
}

/** A section heading in the game's label style, with an optional note on the right. */
export const head = (title: string, note?: string | Node | null) =>
  h("div", { class: "d2-h" }, h("h3", null, title), note ? h("span", null, note) : null);

export const emptyLine = (text: string, unknown = false) => h("p", { class: `d2-empty${unknown ? " unk" : ""}`, "data-unknown": unknown ? "1" : null }, text);

/** "47 h 12 min", "3 h 05 min", "12 min", "gone". */
export function countdown(until: number, now = Date.now()): string {
  const s = Math.floor((until - now) / 1000);
  if (s <= 0) return "gone";
  const hrs = Math.floor(s / 3600);
  const min = Math.floor((s % 3600) / 60);
  if (hrs > 0) return `${hrs} h ${String(min).padStart(2, "0")} min`;
  return min > 0 ? `${min} min` : "under a minute";
}

export const plural = (n: number, one: string, many = `${one}s`) => `${fmt(n)} ${n === 1 ? one : many}`;

/** Redraws a screen only when what it is drawn from has changed, and keeps focus (by data-k) and scroll (by
 *  data-scroll) across the redraw, so a poll never moves the player's hands. */
export function painter(el: HTMLElement, sig: () => unknown, draw: () => (Node | null | false | undefined)[]) {
  let last: string | null = null;
  return (force = false) => {
    const s = JSON.stringify(sig());
    if (!force && s === last) return;
    last = s;
    const active = document.activeElement as HTMLElement | null;
    const k = active && el.contains(active) ? active.dataset.k : undefined;
    const scrolls = new Map<string, number>();
    for (const sc of el.querySelectorAll<HTMLElement>("[data-scroll]")) scrolls.set(sc.dataset.scroll!, sc.scrollTop);
    el.replaceChildren(...(draw().filter(Boolean) as Node[]));
    for (const sc of el.querySelectorAll<HTMLElement>("[data-scroll]")) {
      const top = scrolls.get(sc.dataset.scroll!);
      if (top) sc.scrollTop = top;
    }
    if (k != null) {
      const next = [...el.querySelectorAll<HTMLElement>("[data-k]")].find((n) => n.dataset.k === k);
      try {
        next?.focus({ preventScroll: true });
        // A redrawn text field keeps the caret where typing left it: at the end.
        if (next instanceof HTMLInputElement) next.setSelectionRange?.(next.value.length, next.value.length);
      } catch {
        /* focus is best effort */
      }
    }
  };
}
