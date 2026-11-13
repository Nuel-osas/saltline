// The kit on the HUD and the menus: three charge pips beside the ammo count (in the ammo block's own look), a flash
// across the screen for a burst close by, and the two keys added to the title's controls strip and the controls pane.
// Everything is added to the game's own elements from here; src/game.js's template and src/ui.css are untouched.
import "./arsenal.css";
import { TUNE } from "./rules";

export interface ArsenalHud {
  /** The pips follow the charges carried; `cooling` dims them between throws. */
  setCharges(n: number, cooling?: boolean): void;
  /** A pip blinks: a charge was taken (`gain`) or there was none to throw (`empty`). */
  pulse(kind: "gain" | "empty"): void;
  /** 0–1: a burst's flash over the view. */
  flash(k: number): void;
  dispose(): void;
}

const NONE: ArsenalHud = { setCharges() {}, pulse() {}, flash() {}, dispose() {} };

const el = (tag: string, cls?: string, text?: string) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

/** `<span><kbd>G</kbd> Breaker charge</span>`, the title strip's own shape. */
function legend(key: string, text: string) {
  const s = el("span", "ar-copy");
  s.append(el("kbd", "", key), ` ${text}`);
  return s;
}

/** Adds the kit's keys to the title's controls strip and to the controls pane's keyboard list. Returns its undo. */
export function addControlsCopy(doc: Document = document): () => void {
  const added: Element[] = [];
  const restore: (() => void)[] = [];
  const strip = doc.querySelector(".m-legend");
  if (strip && !strip.querySelector(".ar-copy")) {
    const row = el("div", "ar-copy-row");
    row.append(legend("G", "Breaker charge"), legend("F", "Rifle butt"));
    strip.insertBefore(row, strip.querySelector(".lg-touch"));
    added.push(row);
  }
  // The pane's first list is the keyboard's; its "Melee" row has been there since the baseline.
  const keys = doc.querySelector('[data-pane="controls"] dl.keys');
  if (keys && !keys.querySelector(".ar-copy")) {
    const melee = [...keys.querySelectorAll("dt")].find((d) => d.textContent?.trim() === "Melee") ?? null;
    if (melee) {
      const was = melee.textContent;
      melee.textContent = "Rifle butt";
      restore.push(() => void (melee.textContent = was));
    }
    const row = el("div", "ar-copy");
    const dd = el("dd");
    dd.append(el("kbd", "", "G"));
    row.append(el("dt", "", "Breaker charge"), dd);
    keys.insertBefore(row, melee?.parentElement?.nextSibling ?? null);
    added.push(row);
  }
  return () => {
    for (const a of added) a.remove();
    for (const r of restore) r();
  };
}

/* eslint-disable-next-line @typescript-eslint/no-explicit-any -- the game context is the untyped bundle's G */
export function createArsenalHud(G: any): ArsenalHud {
  if (typeof document === "undefined") return NONE;
  const root: HTMLElement | null = G?.hud?.root ?? document.querySelector("#ui .hud");
  const row = root?.querySelector(".h-ammo-row");
  if (!root || !row) return NONE;

  const box = el("div", "ar-charges");
  box.setAttribute("aria-hidden", "true");
  const pips = el("div", "ar-pips");
  const cells: HTMLElement[] = [];
  for (let i = 0; i < TUNE.charge.cap; i++) {
    const c = el("i");
    cells.push(c);
    pips.append(c);
  }
  const k = el("div", "h-k ar-k");
  k.append(el("kbd", "", "G"), "Charge");
  box.append(pips, k);
  row.insertBefore(box, row.firstChild);

  const veil = el("div", "ar-flash");
  root.append(veil);

  let shown = -1;
  let dim: boolean | null = null;
  const undoCopy = addControlsCopy();
  return {
    setCharges(n, cooling = false) {
      if (n !== shown) {
        shown = n;
        cells.forEach((c, i) => c.classList.toggle("off", i >= n));
        box.classList.toggle("none", n <= 0);
      }
      if (cooling !== dim) {
        dim = cooling;
        box.classList.toggle("cooling", cooling);
      }
    },
    pulse(kind) {
      box.classList.remove("gain", "empty");
      void box.offsetWidth; // restart the animation
      box.classList.add(kind);
    },
    flash(v) {
      veil.style.opacity = v > 0.004 ? v.toFixed(3) : "0";
    },
    dispose() {
      box.remove();
      veil.remove();
      undoCopy();
    },
  };
}
