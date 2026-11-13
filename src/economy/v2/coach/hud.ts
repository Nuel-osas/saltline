// The coach on screen, in the game's own HUD and menus: the FIRST RAID panel under the objective (one line at a
// time, its key caps in the HUD's own <kbd>), the arrow at the invoice meter, the ammo block held back until the
// rifle is in hand, HOW TO PLAY on the title, and the one line the first death card and the first debrief carry.
// Text goes in through textContent only.
import "./coach.css";
import { PANEL, lineText, type Line, type Part } from "./copy";

export interface PanelView {
  /** Changes when the line does: the same key keeps the same element, a new one slides in. */
  key: string;
  kicker: string;
  line: Line;
  /** Just done: its box is ticked. */
  ticked: boolean;
  /** A once-ever moment, not a checklist line. */
  moment: boolean;
  /** The checklist's progress, or null for a moment outside it. */
  pips: boolean[] | null;
}

export interface CoachHud {
  /** The one line on the panel, or none. */
  show(v: PanelView | null): void;
  /** Out of the way: the player is being hit, or is aiming. */
  dim(on: boolean): void;
  /** The invoice meter pulses, with an arrow to it. */
  pointInvoice(on: boolean): void;
  /** No rifle yet: the ammo block waits. */
  unarmed(on: boolean): void;
  /** The title's HOW TO PLAY: `on` when the next raid will be coached. */
  howTo(on: boolean): void;
  /** One line on the dead card, or none. */
  deathCard(text: string | null): void;
  /** The debrief points at the DOCK button. False if there is no such button to point at. */
  debrief(on: boolean): boolean;
  /** What the panel reads now (for tests and screen readers). */
  readonly text: string;
  dispose(): void;
}

export const NO_HUD: CoachHud = { show() {}, dim() {}, pointInvoice() {}, unarmed() {}, howTo() {}, deathCard() {}, debrief: () => false, text: "", dispose() {} };

const el = (tag: string, cls?: string, text?: string) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

function parts(into: HTMLElement, list: Part[]) {
  for (const p of list) into.append(typeof p === "string" ? p : el("kbd", "", p.key));
}

/** A line's elements: a head with its detail under it, or a few short `LEAD tail` rows. */
function lineEl(v: PanelView): HTMLElement {
  const row = el("div", "co-line" + (v.line.length > 1 ? " rows" : ""));
  row.dataset.key = v.key;
  const box = el("i", "co-box");
  const body = el("div", "co-body");
  for (const p of v.line) {
    const r = el("div", "co-row");
    const lead = el("b", "co-lead");
    const tail = el("span", "co-tail");
    parts(lead, p.lead);
    parts(tail, p.tail);
    r.append(lead, tail);
    body.append(r);
  }
  row.append(box, body);
  return row;
}

export function createCoachHud(G: any, onHowTo: () => void): CoachHud {
  if (typeof document === "undefined") return NO_HUD;
  const hudRoot: HTMLElement | null = G?.hud?.root instanceof HTMLElement ? G.hud.root : document.querySelector<HTMLElement>("#ui .hud");
  if (!hudRoot) return NO_HUD;
  const q = <E extends HTMLElement>(sel: string) => document.querySelector<E>(sel);

  // ---- the panel: hung under the objective block, so it follows that block wherever a layout puts it ----
  const panel = el("div", "co-panel");
  panel.setAttribute("aria-hidden", "true");
  const head = el("div", "co-head");
  const kicker = el("span", "h-k");
  const pips = el("span", "co-pips");
  head.append(kicker, pips);
  const slot = el("div", "co-slot");
  panel.append(head, slot);
  (hudRoot.querySelector(".h-obj") ?? hudRoot).appendChild(panel);
  hudRoot.classList.add("co"); // coach.css's rules on the game's own HUD apply only where the coach runs
  let shown: PanelView | null = null;
  let line: HTMLElement | null = null;
  let text = "";

  // ---- the arrow at the invoice meter ----
  const arrow = el("span", "co-arrow");
  arrow.append(el("i"));

  // ---- HOW TO PLAY, after Settings on the title ----
  const how = el("button", "btn co-howto") as HTMLButtonElement;
  how.type = "button";
  how.append(el("span", "", PANEL.howTo), el("b", "co-howto-s"));
  how.addEventListener("click", (e) => {
    e.stopPropagation();
    onHowTo();
  });
  const placeHow = () => {
    if (how.isConnected) return;
    const acts = q('.menu [data-s="title"] .m-actions');
    if (!acts) return;
    const settings = acts.querySelector('[data-act="settings"]');
    if (settings) settings.after(how);
    else acts.append(how);
  };
  placeHow();

  let dead: HTMLElement | null = null;
  let dock: HTMLElement | null = null;
  let pointed: Element | null = null;

  return {
    show(v) {
      if (!v) {
        if (!shown) return;
        shown = null;
        text = "";
        panel.classList.remove("on");
        return;
      }
      const same = shown && shown.key === v.key;
      if (!same) {
        // One line, ever: the last one leaves as this one comes in.
        line = lineEl(v);
        slot.replaceChildren(line);
        text = lineText(v.line);
        kicker.textContent = v.kicker;
        panel.classList.toggle("moment", v.moment);
        panel.dataset.moment = v.moment ? v.key.split(":")[1] : "";
      }
      if (!same || shown!.ticked !== v.ticked) line?.classList.toggle("ticked", v.ticked);
      const sig = v.pips ? v.pips.map((d) => (d ? "1" : "0")).join("") : "";
      if (pips.dataset.sig !== sig) {
        pips.dataset.sig = sig;
        pips.replaceChildren(...(v.pips ?? []).map((d) => el("i", d ? "done" : "")));
      }
      shown = v;
      panel.classList.add("on");
    },
    dim(on) {
      panel.classList.toggle("dim", on);
    },
    pointInvoice(on) {
      const meter = hudRoot.querySelector(".rd-inv");
      if (!meter) return;
      meter.classList.toggle("co-point", on);
      // Beside the meter's own label, walking up to it.
      const row = meter.querySelector(".rd-inv-head") ?? meter;
      if (on && arrow.parentElement !== row) row.prepend(arrow);
      else if (!on) arrow.remove();
    },
    unarmed(on) {
      hudRoot.classList.toggle("co-unarmed", on);
    },
    howTo(on) {
      placeHow();
      how.setAttribute("aria-pressed", String(on));
      how.classList.toggle("on", on);
      (how.lastElementChild as HTMLElement).textContent = on ? "On" : "";
    },
    deathCard(t) {
      dead?.remove();
      dead = null;
      const acts = q('.menu [data-s="dead"] .m-actions');
      if (!t || !acts) return;
      dead = el("p", "co-card", t);
      acts.before(dead);
    },
    debrief(on) {
      dock?.remove();
      dock = null;
      pointed?.classList.remove("co-pointed");
      pointed = null;
      if (!on) return false;
      const btn = q('.menu [data-s="complete"] .m-actions .d2-entry');
      if (!btn) return false;
      dock = el("p", "co-dock");
      dock.append(el("span", "", PANEL.debrief), el("i"));
      btn.before(dock);
      btn.classList.add("co-pointed");
      pointed = btn;
      // A debrief with the raid's rows on it is taller than a small screen: bring what is pointed at into view.
      try {
        btn.scrollIntoView({ block: "nearest" });
      } catch {
        /* a nicety */
      }
      return true;
    },
    get text() {
      return shown ? text : "";
    },
    dispose() {
      panel.remove();
      arrow.remove();
      how.remove();
      dead?.remove();
      dock?.remove();
      pointed?.classList.remove("co-pointed");
      hudRoot.classList.remove("co", "co-unarmed");
      hudRoot.querySelector(".rd-inv")?.classList.remove("co-point");
    },
  };
}
