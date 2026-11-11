// "While you were away": the return hook. When the Dockside opens and something changed since this player last
// looked, a short card at the top says what, in at most four lines: a wreck of theirs hauled out by someone else (so
// their 30% came home), dividends from a broker they hold shares in, one of those brokers shutting or reopening,
// their best haul beaten on the board, a big move in the price of cargo they hold.
//
// It is built from the chain's own reads (recent(64), balances, brokers, leaderboard, profile, wrecks) against a
// snapshot of what they last saw, kept in this browser (saltline.seen.v1). Ledger lines count when they mention
// their account or callsign. Money is measured, never claimed: the scrip line is the balance against the snapshot.
// A read that failed drops the lines that need it, so the card shows less, never a wrong number.
import { CARGO, ITEMS, RULES } from "../items";
import type { Amounts, BrokerId, BrokerView, CargoId, Leaderboard, LedgerEvent, Profile, WreckView } from "../types";
import { h } from "./dom";
import { ago, fmt } from "./format";

export const SEEN_KEY = "saltline.seen.v1";
/** A glance, not a report. */
export const MAX_LINES = 4;
/** A price move worth a line: at least this share of the old price, and at least this many scrip. */
const MOVE_PCT = 20;
const MOVE_MIN = 5;
const FINDER_PCT = Math.round(RULES.finderShare * 100);

/** What this player saw last time they looked. A null field was unknown then and is never diffed against. */
export interface Seen {
  v: 1;
  account: string;
  /** When they last looked, on this browser's clock (ms). */
  at: number;
  /** The newest ledger line they had seen, on the chain's clock (ms). */
  ledgerAt: number | null;
  callsign: string | null;
  scrip: number | null;
  open: Partial<Record<BrokerId, boolean>> | null;
  /** The best open bid for each cargo. */
  bids: Partial<Record<CargoId, number>> | null;
  /** Their best haul, who stood above it on the best-haul board, and whether they were on that board. */
  haul: { best: number; above: string[]; ranked: boolean } | null;
  /** Their wrecks still in the yard, with what is in them. */
  wrecks: { id: number; items: { tokenId: CargoId; amount: number }[] }[] | null;
  /** The brokers (account ids) they held shares in. */
  shareIn?: string[];
  /**
   * Ledger lines about them, caught while the Dockside was shut and kept until they look: the chain only serves the
   * last 64 lines, and on a busy dock a recovery can scroll out of that before they come back.
   */
  news?: LedgerEvent[];
}

/** How many caught lines the snapshot keeps. */
const NEWS_MAX = 24;

/** The chain now. Null is a read that failed (unknown, not "none"); undefined, in a merge, is a read not made. */
export interface AwayReads {
  balances: Amounts | null;
  brokers: BrokerView[] | null;
  recent: LedgerEvent[] | null;
  leaderboard: Leaderboard | null;
  profile: Profile | null;
  wrecks: WreckView[] | null;
}

export interface AwayLine {
  kind: "wreck" | "scrip" | "broker" | "board" | "price";
  tag: string;
  text: string;
  figure?: string;
  tone: "up" | "down" | "info";
}

// ---- reading the ledger's lines ----

/**
 * Whose wrecks an extract line says were brought back. The contract writes "… Brought back A and B's wreck." and the
 * mock "… recovered A's wreck and sent 2 coils home"; both name the owners just before "'s wreck". (Case-sensitive on
 * purpose: callsigns are upper case, so one can't be mistaken for the verb.)
 */
export function wreckOwners(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/(?:Brought back|recovered) (.+?)'s wreck/g))
    for (const name of m[1].split(/ and |, /)) if (name.trim()) out.push(name.trim());
  return out;
}

/** Whose listing a market line says was bought: "X bought SELLER's 2 coils for 140." */
export function listingSeller(text: string): string | null {
  const m = /\bbought (.+?)'s /.exec(text);
  return m ? m[1] : null;
}

/** The best bid an open broker pays for each cargo, and who pays it. */
export function bestBids(brokers: BrokerView[]): Partial<Record<CargoId, { price: number; broker: string }>> {
  const out: Partial<Record<CargoId, { price: number; broker: string }>> = {};
  for (const b of brokers) {
    if (!b.open) continue;
    for (const q of b.bids) {
      const c = q.tokenId as CargoId;
      if (!CARGO.includes(c) || !Number.isFinite(q.price)) continue;
      if (!out[c] || q.price > out[c]!.price) out[c] = { price: q.price, broker: b.name };
    }
  }
  return out;
}

/** What the owner of a recovered wreck gets back of one item (the finder's share rounds half up). */
export const ownerShare = (amount: number) => amount - Math.floor((amount * FINDER_PCT + 50) / 100);

const NOUN: Record<CargoId, [string, string]> = {
  copper: ["coil", "coils"],
  meds: ["case of meds", "cases of meds"],
  chips: ["box", "boxes"],
  fuel: ["fuel cell", "fuel cells"],
  core: ["core", "cores"],
};
const goods = (a: Amounts<CargoId>) =>
  CARGO.filter((c) => (a[c] ?? 0) > 0)
    .map((c) => `+${a[c]} ${NOUN[c][a[c] === 1 ? 0 : 1]}`)
    .join(" · ");
const names = (xs: string[]) => (xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
const unique = <T>(xs: T[]) => [...new Set(xs)];
const isNum = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

// ---- the lines ----

const lineKey = (e: LedgerEvent) => `${e.kind}|${e.at}|${e.account}|${e.text}`;

/** A ledger line about this player: their wreck hauled out, their listing bought, a broker of theirs shipping. */
export function aboutThem(e: LedgerEvent, me: string, callsign: string | null, shareIn: readonly string[]): boolean {
  if (e.account === me) return false;
  if (e.kind === "extract") return !!callsign && wreckOwners(e.text).includes(callsign);
  if (e.kind === "listing") return !!callsign && listingSeller(e.text) === callsign;
  return e.kind === "export" && shareIn.includes(e.account);
}

/** Keeps the lines about them that came after their last look, so a long absence doesn't lose them. */
export function noteNews(seen: Seen, recent: LedgerEvent[]): Seen {
  const since = seen.ledgerAt ?? seen.at;
  const have = seen.news ?? [];
  const keys = new Set(have.map(lineKey));
  const more = recent.filter((e) => isNum(e.at) && e.at > since && !keys.has(lineKey(e)) && aboutThem(e, seen.account, seen.callsign, seen.shareIn ?? []));
  if (!more.length) return seen;
  return { ...seen, news: [...have, ...more].sort((a, b) => b.at - a.at).slice(0, NEWS_MAX) };
}

/** What changed for `me` since `prev`. Nothing on a first visit, or when the snapshot was another account's. */
export function awayLines(prev: Seen | null, now: AwayReads, me: string): AwayLine[] {
  if (!prev || prev.account !== me) return [];
  const lines: AwayLine[] = [];
  const callsign = now.profile?.callsign ?? prev.callsign;
  const since = prev.ledgerAt ?? prev.at;
  // The ledger now, plus the lines about them caught while they were gone (already read, so never a guess).
  const caught = prev.news ?? [];
  const pool = now.recent || caught.length ? [...caught, ...(now.recent ?? [])].filter((e, i, all) => all.findIndex((x) => lineKey(x) === lineKey(e)) === i) : null;
  const fresh = pool ? pool.filter((e) => isNum(e.at) && e.at > since) : null;
  // Brokers they hold shares in (shares only ever grow, so today's list covers the whole time away).
  const theirs = now.brokers ? now.brokers.filter((b) => b.shares.some((s) => s.accountId === me && s.shares > 0)) : null;

  // A wreck of theirs, hauled out by someone else.
  if (fresh && callsign) {
    const found = fresh.filter((e) => e.kind === "extract" && e.account !== me && wreckOwners(e.text).includes(callsign));
    const count = found.reduce((n, e) => n + wreckOwners(e.text).filter((c) => c === callsign).length, 0);
    if (count > 0) {
      const who = names(unique(found.map((e) => e.callsign || "Another crew")));
      const what = count === 1 ? "your wreck" : `${count} of your wrecks`;
      // What came home, from the wrecks they last saw that are gone now, only when that matches the count exactly.
      let home: Amounts<CargoId> | null = null;
      if (prev.wrecks && now.wrecks) {
        const gone = prev.wrecks.filter((w) => !now.wrecks!.some((x) => x.id === w.id));
        if (gone.length === count) {
          home = {};
          for (const w of gone) for (const i of w.items) home[i.tokenId] = (home[i.tokenId] ?? 0) + ownerShare(i.amount);
        }
      }
      if (home && !goods(home))
        lines.push({ kind: "wreck", tag: "Salvage", text: `${who} hauled ${what} out of the yard. Too small to split: the finder keeps it.`, tone: "info" });
      else
        lines.push({
          kind: "wreck",
          tag: "Salvage",
          text: `${who} hauled ${what} out of the yard. Your ${100 - FINDER_PCT}% came home.`,
          figure: home ? goods(home) : undefined,
          tone: "up",
        });
    }
  }

  // Scrip that came in: measured against the snapshot, then put down to whatever on the ledger explains it.
  if (isNum(prev.scrip) && now.balances) {
    const delta = (now.balances.scrip ?? 0) - prev.scrip;
    if (delta > 0) {
      const payers =
        fresh && theirs
          ? unique(fresh.filter((e) => e.kind === "export").flatMap((e) => theirs.filter((b) => b.accountId === e.account).map((b) => b.name)))
          : [];
      const sold = fresh && callsign ? fresh.filter((e) => e.kind === "listing" && e.account !== me && listingSeller(e.text) === callsign).length : 0;
      const text =
        payers.length && sold
          ? `${names(payers)} paid a dividend, and your listing sold on the board.`
          : payers.length
            ? `${names(payers)} shipped to the freighter. Your dividend is in.`
            : sold
              ? `Your listing sold on the board.`
              : "Scrip came in while you were out.";
      lines.push({ kind: "scrip", tag: payers.length && !sold ? "Dividend" : "Scrip in", text, figure: `+${fmt(delta)} scrip`, tone: "up" });
    }
  }

  // A broker they hold shares in shut, or opened again.
  if (theirs && prev.open) {
    for (const b of theirs) {
      const was = prev.open[b.id];
      if (was === undefined || was === b.open) continue;
      lines.push(
        b.open
          ? { kind: "broker", tag: "Reopened", text: `${b.name} is open again. Your shares are earning.`, tone: "up" }
          : { kind: "broker", tag: "Shut", text: `${b.name} pulled the shutter down. Your shares wait on a reopening.`, tone: "down" },
      );
    }
  }

  // Their best haul beaten on the board (only if they were on it).
  if (now.leaderboard && now.profile && prev.haul?.ranked && now.profile.bestHaul > 0) {
    const best = now.profile.bestHaul;
    const rows = now.leaderboard.bestHaul;
    const beat = rows.filter((r) => r.accountId !== me && r.value > best && !prev.haul!.above.includes(r.accountId));
    if (beat.length) {
      const top = [...beat].sort((a, b) => b.value - a.value)[0];
      const rank = rows.findIndex((r) => r.accountId === me);
      lines.push({
        kind: "board",
        tag: "Board",
        text:
          beat.length === 1
            ? `${top.callsign} beat your best haul: ${fmt(top.value)} to your ${fmt(best)}.`
            : `${top.callsign} and ${beat.length - 1} more beat your best haul of ${fmt(best)}.`,
        figure: rank >= 0 ? `now #${rank + 1}` : "off the board",
        tone: "down",
      });
    }
  }

  // Big moves on cargo they hold, biggest first.
  if (now.brokers && now.balances && prev.bids) {
    const best = bestBids(now.brokers);
    const moves = CARGO.flatMap((c) => {
      const held = now.balances![c] ?? 0;
      const was = prev.bids![c];
      const is = best[c];
      if (held <= 0 || !isNum(was) || was <= 0 || !is) return [];
      const d = is.price - was;
      const pct = Math.round((Math.abs(d) * 100) / was);
      return pct >= MOVE_PCT && Math.abs(d) >= MOVE_MIN ? [{ c, held, was, is, d, pct }] : [];
    }).sort((a, b) => b.pct - a.pct);
    for (const m of moves)
      lines.push({
        kind: "price",
        tag: m.d > 0 ? "Price up" : "Price down",
        text:
          m.d > 0
            ? `${ITEMS[m.c].name}: ${m.is.broker} pays ${m.is.price}, was ${m.was}. You hold ${m.held}.`
            : `${ITEMS[m.c].name}: best bid ${m.is.price}, was ${m.was}. You hold ${m.held}.`,
        figure: `${m.d > 0 ? "▲" : "▼"} ${m.pct}%`,
        tone: m.d > 0 ? "up" : "down",
      });
  }

  return lines.slice(0, MAX_LINES);
}

// ---- the snapshot ----

/** The snapshot after these reads: what was read replaces what was seen, and a failed or missing read keeps it. */
export function seenFrom(prev: Seen | null, r: Partial<AwayReads>, me: string, at: number): Seen {
  const s: Seen =
    prev && prev.account === me
      ? { ...prev }
      : { v: 1, account: me, at, ledgerAt: null, callsign: null, scrip: null, open: null, bids: null, haul: null, wrecks: null };
  s.at = at;
  if (r.profile) s.callsign = r.profile.callsign;
  if (r.balances) s.scrip = r.balances.scrip ?? 0;
  if (r.brokers) {
    s.open = Object.fromEntries(r.brokers.map((b) => [b.id, b.open]));
    s.bids = Object.fromEntries(Object.entries(bestBids(r.brokers)).map(([c, q]) => [c, q!.price]));
    s.shareIn = r.brokers.filter((b) => b.shares.some((x) => x.accountId === me && x.shares > 0)).map((b) => b.accountId);
  }
  if (r.recent && r.recent.length) {
    const newest = Math.max(...r.recent.map((e) => (isNum(e.at) ? e.at : 0)));
    s.ledgerAt = Math.max(s.ledgerAt ?? 0, newest);
  }
  const best = r.profile ? r.profile.bestHaul : s.haul?.best;
  if (r.leaderboard && isNum(best)) {
    const rows = r.leaderboard.bestHaul;
    s.haul = { best, above: rows.filter((x) => x.accountId !== me && x.value > best).map((x) => x.accountId), ranked: rows.some((x) => x.accountId === me) };
  }
  if (r.wrecks) s.wrecks = mine(r.wrecks, me);
  return s;
}

/** Adds wrecks of theirs to the snapshot without dropping any (a wreck gone since is news for the next look). */
export function addWrecks(seen: Seen, wrecks: WreckView[]): Seen {
  const have = seen.wrecks ?? [];
  const more = mine(wrecks, seen.account).filter((w) => !have.some((x) => x.id === w.id));
  return more.length ? { ...seen, wrecks: [...have, ...more] } : seen;
}

const mine = (wrecks: WreckView[], me: string) =>
  wrecks.filter((w) => w.owner === me).map((w) => ({ id: w.id, items: w.items.map((i) => ({ tokenId: i.tokenId, amount: i.amount })) }));

function validSeen(s: unknown): s is Seen {
  const x = s as Seen;
  return !!x && typeof x === "object" && x.v === 1 && typeof x.account === "string" && isNum(x.at);
}

export function loadSeen(storage: Storage | null, account: string): Seen | null {
  try {
    const raw = storage?.getItem(SEEN_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    return validSeen(s) && s.account === account ? s : null;
  } catch {
    return null;
  }
}

export function saveSeen(storage: Storage | null, seen: Seen) {
  try {
    storage?.setItem(SEEN_KEY, JSON.stringify(seen));
  } catch {
    /* a browser that won't store it just doesn't get the card next time */
  }
}

// ---- the card ----

export function createAwayCard(lines: AwayLine[], since: number, onDismiss: () => void): { el: HTMLElement; ok: HTMLButtonElement } {
  const a = ago(since);
  const ok = h("button", { class: "btn small dk-away-ok", type: "button", onclick: onDismiss }, "Noted");
  const el = h(
    "section",
    { class: "dk-away", role: "region", "aria-labelledby": "dk-away-h" },
    h(
      "header",
      { class: "dk-away-hd" },
      h("div", { class: "m-k" }, `Dock office · last look ${a === "now" ? "moments" : a} ago`),
      h("h3", { class: "dk-away-h", id: "dk-away-h" }, "While you were away"),
    ),
    h(
      "ul",
      { class: "dk-away-list" },
      ...lines.map((l, i) =>
        h(
          "li",
          { class: "dk-away-i", "data-kind": l.kind, "data-tone": l.tone, style: `--i:${i}` },
          h("span", { class: "dk-away-tag" }, l.tag),
          h("span", { class: "dk-away-t" }, l.text),
          l.figure ? h("b", { class: "dk-away-f" }, l.figure) : null,
        ),
      ),
    ),
    h("footer", { class: "dk-away-ft" }, ok),
  );
  return { el, ok };
}
