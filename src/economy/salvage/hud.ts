// The salvage interface, in the game's own HUD and menus: a cargo readout above the vitals, cargo and wreck markers
// through the HUD's marker system, a "Cargo lost" row on the dead card and a salvage block on the debrief card. Text
// goes in through textContent only: callsigns and chain errors come from other people.
import "./salvage.css";
import { RULES } from "../items";
import type { Amounts, CargoId } from "../types";
import { formatItems } from "./run";

export interface CargoView {
  mode: "off" | "pending" | "live";
  carried: Amounts<CargoId>;
  weight: number;
  /** Speed scale, 0.5–1. */
  pace: number;
  sealed: number;
  wrecks: number;
}

export interface Marker {
  id: string;
  short: string;
  label: string;
  pos: { x: number; y: number; z: number };
  /** The HUD's class for the marker: "cargo" or "wreck", plus " far" to keep only its compass tick. */
  kind: string;
}

export interface Ledger {
  text: string;
  href?: string | null;
  state: "pending" | "ok" | "refused";
}

export interface DebriefView {
  /** One line per item, e.g. `MEDS ×2`; empty for nothing taken. */
  haul: string[];
  value: string;
  ledger: Ledger;
}

export interface SalvageHud {
  setCargo(v: CargoView): void;
  /** Our markers, shown beside the game's own (relays, the boat). */
  setMarkers(list: Marker[]): void;
  setLost(text: string | null, state?: Ledger["state"]): void;
  setDebrief(v: DebriefView | null): void;
  dispose(): void;
}

const el = (tag: string, cls?: string, text?: string) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

const row = (dt: string, dd: string | Node, cls = "") => {
  const d = el("div", "sv-row " + cls);
  d.append(el("dt", "", dt));
  const v = el("dd");
  v.append(dd);
  d.append(v);
  return d;
};

/** Explorer links only: anything that isn't plain https is shown as text. */
const safeHref = (h: string | null | undefined) => (h && /^https:\/\/[^\s"'<>]+$/.test(h) ? h : null);

export function createSalvageHud(G: any): SalvageHud {
  if (typeof document === "undefined") {
    return { setCargo() {}, setMarkers() {}, setLost() {}, setDebrief() {}, dispose() {} };
  }
  const hud = G.hud || {};

  // The cargo readout lives inside the HUD root, so it shows and hides with the rest of the HUD.
  const box = el("div", "sv-cargo");
  box.setAttribute("aria-hidden", "true");
  box.append(el("div", "h-k", "Cargo"));
  const load = el("div", "sv-load");
  const cells: HTMLElement[] = [];
  for (let i = 0; i < RULES.carryLimit; i++) cells.push(load.appendChild(el("i", "off")));
  const count = load.appendChild(el("b", "", `0/${RULES.carryLimit}`));
  const items = el("div", "sv-items");
  const sub = el("div", "sv-sub");
  box.append(load, items, sub);
  (hud.root instanceof HTMLElement ? hud.root : document.getElementById("ui"))?.appendChild(box);
  let last = "";

  // Markers: the HUD rebuilds its whole list on every setMarkers, and the game calls it on reset and on each relay
  // cut. Wrapping it keeps the game's markers and ours on screen together.
  const baseSet = typeof hud.setMarkers === "function" ? hud.setMarkers.bind(hud) : null;
  let theirs: unknown[] = [];
  let ours: Marker[] = [];
  if (baseSet)
    hud.setMarkers = (list: unknown[]) => {
      theirs = Array.isArray(list) ? list : [];
      baseSet([...theirs, ...ours]);
    };

  const card = (s: string) => document.querySelector(`.menu [data-s="${s}"] .m-stats`);
  let lost: HTMLElement | null = null;
  let sec: HTMLElement | null = null;

  return {
    setCargo(v) {
      const key = JSON.stringify(v);
      if (key === last) return;
      last = key;
      box.classList.toggle("on", v.mode !== "off");
      box.classList.toggle("pending", v.mode === "pending");
      box.classList.toggle("heavy", v.pace < 0.8);
      const w = Math.min(RULES.carryLimit, v.weight);
      cells.forEach((c, i) => (c.className = i < w ? "" : "off"));
      count.textContent = `${v.weight}/${RULES.carryLimit}`;
      if (v.mode === "pending") {
        items.textContent = "Manifest pending";
        sub.textContent = "Run on. It will catch up";
        return;
      }
      items.textContent = formatItems(v.carried) || "Empty";
      const left = [`${v.sealed} sealed`, v.wrecks ? `${v.wrecks} ${v.wrecks === 1 ? "wreck" : "wrecks"}` : ""].filter(
        Boolean,
      );
      sub.textContent = (v.weight ? `Pace ${Math.round(v.pace * 100)}% · ` : "") + left.join(" · ");
    },
    setMarkers(list) {
      const same = list.length === ours.length && list.every((m, i) => m.id === ours[i].id && m.kind === ours[i].kind);
      ours = list;
      if (!same && baseSet) baseSet([...theirs, ...ours]);
    },
    setLost(text, state = "ok") {
      lost?.remove();
      lost = null;
      const dl = card("dead");
      if (!text || !dl) return;
      lost = row("Cargo lost", text, "sv-" + state);
      dl.append(lost);
    },
    setDebrief(v) {
      sec?.remove();
      sec = null;
      const dl = card("complete");
      if (!v || !dl) return;
      sec = el("div", "sv-sec");
      sec.append(el("div", "m-k", "Salvage"));
      const list = el("dl", "m-stats");
      const haul = el("span", "sv-lines");
      for (const line of v.haul.length ? v.haul : ["Nothing taken"]) haul.append(el("span", "", line));
      list.append(row("Haul", haul), row("Haul value", v.value, v.value === "unknown" ? "sv-pending" : ""));
      const href = safeHref(v.ledger.href);
      let ledger: Node = document.createTextNode(v.ledger.text);
      if (href) {
        const a = el("a", "", v.ledger.text + " ↗") as HTMLAnchorElement;
        a.href = href;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        ledger = a;
      }
      list.append(row("Ledger", ledger, "sv-" + v.ledger.state));
      sec.append(list);
      dl.after(sec);
    },
    dispose() {
      box.remove();
      lost?.remove();
      sec?.remove();
      if (baseSet) {
        hud.setMarkers = baseSet;
        baseSet(theirs);
      }
    },
  };
}
