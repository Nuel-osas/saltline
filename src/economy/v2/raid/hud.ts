// The raid's interface, in the game's own HUD and menus: the invoice meter and its line items (top right), the
// cargo readout above the vitals, cargo and wreck markers through the HUD's marker system, the sign-on card over
// the title, the raid card that opens a run, and the rows a raid adds to the debrief and dead cards. Text goes in
// through textContent only: callsigns and chain errors come from other people.
import "../../salvage/salvage.css";
import "./raid.css";
import { RAID } from "../items";
import { money, type LineItem } from "./rules";

export interface InvoiceView {
  on: boolean;
  total: number;
  /** The threshold ahead and what it brings, or null past the last. */
  next: { at: number; what: string } | null;
}

export interface CargoView {
  mode: "off" | "live";
  /** `MEDS ×2 · SERVO ×1`, or empty. */
  items: string;
  weight: number;
  /** Speed scale, 0.5–1. */
  pace: number;
  sealed: number;
  wrecks: number;
  guns: number;
}

export interface Marker {
  id: string;
  short: string;
  label: string;
  pos: { x: number; y: number; z: number };
  /** The HUD's class for the marker: "cargo", "cargo bonded" or "wreck", plus " far" to keep only its compass tick. */
  kind: string;
}

export type RowState = "ok" | "pending" | "refused";
export interface Row {
  k: string;
  v: string | string[];
  state?: RowState;
  href?: string | null;
}

export interface RaidHud {
  setInvoice(v: InvoiceView): void;
  /** One addition, listed under the meter for a few seconds: `+80 CUSTOMS SEAL`. */
  addLine(item: LineItem): void;
  /** A threshold was reached: the meter flashes and names it. */
  flag(text: string): void;
  setCargo(v: CargoView): void;
  setMarkers(list: Marker[]): void;
  /** The card over the title while the contract locks the loadout. */
  signing(title: string, sub: string): void;
  /** The sign-on didn't go through: say why, and offer one raid off the books. */
  offer(title: string, why: string, onYes: () => void, onNo: () => void): void;
  signDone(): void;
  readonly signUp: boolean;
  /** The card that opens a raid (the game's location card). */
  raidCard(kicker: string, line: string, place: string): void;
  setDebrief(rows: Row[] | null): void;
  setDead(rows: Row[] | null): void;
  dispose(): void;
}

const el = (tag: string, cls?: string, text?: string) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

/** Explorer links only: anything that isn't plain https is shown as text. */
const safeHref = (h: string | null | undefined) => (h && /^https:\/\/[^\s"'<>]+$/.test(h) ? h : null);

function rowEl(r: Row) {
  const d = el("div", "sv-row rd-row" + (r.state ? " sv-" + r.state : ""));
  d.append(el("dt", "", r.k));
  const v = el("dd");
  const lines = Array.isArray(r.v) ? r.v : [r.v];
  const href = safeHref(r.href);
  if (href) {
    const a = el("a", "", lines.join(" ") + " ↗") as HTMLAnchorElement;
    a.href = href;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    v.append(a);
  } else if (lines.length > 1) {
    const s = el("span", "sv-lines");
    for (const l of lines) s.append(el("span", "", l));
    v.append(s);
  } else v.textContent = lines[0] ?? "";
  d.append(v);
  return d;
}

const LINE_MS = 4200;
const MAX_LINES = 5;

export function createRaidHud(G: any): RaidHud {
  if (typeof document === "undefined") {
    return { setInvoice() {}, addLine() {}, flag() {}, setCargo() {}, setMarkers() {}, signing() {}, offer() {}, signDone() {}, signUp: false, raidCard() {}, setDebrief() {}, setDead() {}, dispose() {} };
  }
  const hud = G.hud || {};
  const host: HTMLElement | null = hud.root instanceof HTMLElement ? hud.root : document.getElementById("ui");
  const ui = document.getElementById("ui") ?? document.body;

  // ---- the invoice meter: inside the HUD root, so it shows and hides with the rest of the HUD ----
  const inv = el("div", "rd-inv");
  inv.setAttribute("aria-hidden", "true");
  const head = el("div", "rd-inv-head");
  const k = el("span", "h-k", "Invoice");
  const total = el("b", "rd-inv-n", "0");
  head.append(k, total);
  const next = el("div", "rd-inv-next");
  const bar = el("div", "rd-inv-bar");
  const fill = bar.appendChild(el("i"));
  const lines = el("div", "rd-inv-lines");
  inv.append(head, bar, next, lines);
  host?.appendChild(inv);
  let lastInv = "";
  let flagT: ReturnType<typeof setTimeout> | null = null;

  // ---- cargo readout (salvage.css's sv-cargo look) ----
  const box = el("div", "sv-cargo rd-cargo");
  box.setAttribute("aria-hidden", "true");
  box.append(el("div", "h-k", "Cargo"));
  const load = el("div", "sv-load");
  const cells: HTMLElement[] = [];
  for (let i = 0; i < RAID.carryLimit; i++) cells.push(load.appendChild(el("i", "off")));
  const count = load.appendChild(el("b", "", `0/${RAID.carryLimit}`));
  const items = el("div", "sv-items");
  const sub = el("div", "sv-sub");
  box.append(load, items, sub);
  host?.appendChild(box);
  let lastCargo = "";

  // ---- markers: the HUD rebuilds its whole list on every setMarkers; wrapping it keeps the game's and ours ----
  const baseSet = typeof hud.setMarkers === "function" ? hud.setMarkers.bind(hud) : null;
  let theirs: unknown[] = [];
  let ours: Marker[] = [];
  if (baseSet)
    hud.setMarkers = (list: unknown[]) => {
      theirs = Array.isArray(list) ? list : [];
      baseSet([...theirs, ...ours]);
    };

  // ---- the sign-on card ----
  const sign = el("div", "rd-sign");
  sign.setAttribute("role", "dialog");
  sign.setAttribute("aria-modal", "true");
  sign.setAttribute("aria-label", "Signing on");
  sign.hidden = true;
  const sKick = el("div", "rd-sign-k");
  sKick.append(el("span", "rd-sign-tag", "B4"), el("span", "", "Dock office"));
  const sTitle = el("p", "rd-sign-t");
  const sSub = el("p", "rd-sign-s");
  const sActs = el("div", "rd-sign-acts");
  const yes = el("button", "rd-btn rd-yes", "Raid off the books") as HTMLButtonElement;
  const no = el("button", "rd-btn", "Back") as HTMLButtonElement;
  yes.type = no.type = "button";
  const sNote = el("p", "rd-sign-n", "The issue rifle. No loot. Nothing goes on the ledger.");
  sActs.append(yes, no);
  const sCard = el("div", "rd-sign-card");
  sCard.append(sKick, sTitle, sSub, sActs, sNote);
  sign.append(el("div", "rd-sign-veil"), sCard);
  ui.appendChild(sign);
  let onYes: (() => void) | null = null;
  let onNo: (() => void) | null = null;
  const answer = (y: boolean) => {
    const f = y ? onYes : onNo;
    onYes = onNo = null;
    f?.();
  };
  yes.addEventListener("click", (e) => (e.stopPropagation(), answer(true)));
  no.addEventListener("click", (e) => (e.stopPropagation(), answer(false)));
  // While the card is up its keys are its own: Enter on the title would deploy again underneath it.
  const onKey = (e: KeyboardEvent) => {
    if (sign.hidden) return;
    const offering = !!onYes;
    if (e.code === "Enter" || e.code === "NumpadEnter" || e.code === "Space" || e.code === "Escape") {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (offering) answer(e.code !== "Escape");
    }
  };
  window.addEventListener("keydown", onKey, true);

  // ---- the raid card: the game's location card, filled before the intro shows it ----
  let cardOriginal: string | null = null;

  const stats = (s: string) => document.querySelector(`.menu [data-s="${s}"] .m-stats`);
  let debrief: HTMLElement | null = null;
  let dead: HTMLElement | null = null;
  function section(title: string, rows: Row[]) {
    const sec = el("div", "sv-sec rd-sec");
    sec.append(el("div", "m-k", title));
    const list = el("dl", "m-stats");
    for (const r of rows) list.append(rowEl(r));
    sec.append(list);
    return sec;
  }

  return {
    setInvoice(v) {
      const key = `${v.on}|${v.total}|${v.next?.at}|${v.next?.what}`;
      if (key === lastInv) return;
      lastInv = key;
      inv.classList.toggle("on", v.on);
      total.textContent = money(v.total);
      next.textContent = v.next ? `${v.next.what} AT ${money(v.next.at)}` : "ACCOUNT FORECLOSED";
      const near = v.next ? v.total / v.next.at : 1;
      fill.style.transform = `scaleX(${Math.max(0, Math.min(1, near)).toFixed(3)})`;
      inv.classList.toggle("near", !!v.next && near >= 0.85);
      inv.classList.toggle("past", !v.next);
      inv.dataset.text = `INVOICE ${money(v.total)}${v.next ? ` · ${v.next.what} AT ${money(v.next.at)}` : ""}`;
    },
    addLine(item) {
      const row = el("div", "rd-line");
      row.append(el("b", "", `+${money(item.added)}`), el("span", "", item.why));
      lines.prepend(row);
      while (lines.children.length > MAX_LINES) lines.lastElementChild?.remove();
      setTimeout(() => row.classList.add("out"), LINE_MS);
      setTimeout(() => row.remove(), LINE_MS + 600);
    },
    flag(text) {
      inv.classList.remove("flag");
      void inv.offsetWidth;
      inv.classList.add("flag");
      k.textContent = text;
      if (flagT) clearTimeout(flagT);
      flagT = setTimeout(() => ((k.textContent = "Invoice"), inv.classList.remove("flag")), 5000);
    },
    setCargo(v) {
      const key = JSON.stringify(v);
      if (key === lastCargo) return;
      lastCargo = key;
      box.classList.toggle("on", v.mode !== "off");
      box.classList.toggle("heavy", v.pace < 0.8);
      const w = Math.min(RAID.carryLimit, v.weight);
      cells.forEach((c, i) => (c.className = i < w ? "" : "off"));
      count.textContent = `${v.weight}/${RAID.carryLimit}`;
      items.textContent = [v.items, v.guns ? `GUN ×${v.guns}` : ""].filter(Boolean).join(" · ") || "Empty";
      const left = [`${v.sealed} sealed`, v.wrecks ? `${v.wrecks} ${v.wrecks === 1 ? "wreck" : "wrecks"}` : ""].filter(Boolean);
      sub.textContent = (v.weight ? `Pace ${Math.round(v.pace * 100)}% · ` : "") + left.join(" · ");
    },
    setMarkers(list) {
      const same = list.length === ours.length && list.every((m, i) => m.id === ours[i].id && m.kind === ours[i].kind);
      ours = list;
      if (!same && baseSet) baseSet([...theirs, ...ours]);
    },
    signing(title, text) {
      onYes = onNo = null;
      sign.hidden = false;
      sign.classList.remove("offer");
      sTitle.textContent = title;
      sSub.textContent = text;
    },
    offer(title, why, y, n) {
      sign.hidden = false;
      sign.classList.add("offer");
      sTitle.textContent = title;
      sSub.textContent = why;
      onYes = y;
      onNo = n;
      try {
        yes.focus({ preventScroll: true });
      } catch {
        /* focus is a nicety */
      }
    },
    signDone() {
      onYes = onNo = null;
      sign.hidden = true;
      sign.classList.remove("offer");
    },
    get signUp() {
      return !sign.hidden;
    },
    raidCard(kicker, line, place) {
      const card = document.querySelector<HTMLElement>(".loc-card");
      if (!card) return;
      if (cardOriginal === null) cardOriginal = card.innerHTML;
      const l = el("em", "st-ch-line", line);
      card.replaceChildren(el("i"), el("b", "", kicker), l, el("span", "", place));
      card.classList.add("st-chapter", "rd-card");
    },
    setDebrief(rows) {
      debrief?.remove();
      debrief = null;
      const dl = stats("complete");
      if (!rows || !dl) return;
      debrief = section("The raid", rows);
      dl.after(debrief);
    },
    setDead(rows) {
      dead?.remove();
      dead = null;
      const dl = stats("dead");
      if (!rows || !dl) return;
      dead = section("The ledger", rows);
      dl.after(dead);
    },
    dispose() {
      inv.remove();
      box.remove();
      sign.remove();
      debrief?.remove();
      dead?.remove();
      window.removeEventListener("keydown", onKey, true);
      const card = document.querySelector<HTMLElement>(".loc-card");
      if (card && cardOriginal !== null) ((card.innerHTML = cardOriginal), card.classList.remove("st-chapter", "rd-card"));
      if (baseSet) {
        hud.setMarkers = baseSet;
        baseSet(theirs);
      }
    },
  };
}
