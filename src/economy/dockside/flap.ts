// A split-flap number, the kind bolted over terminal gates: each digit is a card that falls in halves, cycling
// forward through the digits until it reaches the new value. The final value is set on the element at once (data-value
// and aria-label), so readers and tests never wait for the animation.
import { h, reducedMotion } from "./dom";

const CYCLE = " 0123456789";
const STEP_MS = 74;
const STAGGER_MS = 46;

interface Cell {
  el: HTMLElement;
  top: HTMLElement;
  bot: HTMLElement;
  ft: HTMLElement;
  fb: HTMLElement;
  ch: string;
  gen: number;
}

export interface Flap {
  readonly el: HTMLElement;
  readonly value: string;
  /** Show a new value. Animates unless told not to (or the player prefers reduced motion). */
  set(value: string, animate?: boolean): Promise<void>;
}

export interface FlapOptions {
  cells: number;
  className?: string;
  /** Called on each falling card (the Dockside plays the game's soft tick from it, throttled). */
  onStep?: () => void;
}

const half = (cls: string) => h("span", { class: cls }, h("b", null, " "));

function makeCell(): Cell {
  const top = half("dk-fc-t");
  const bot = half("dk-fc-b");
  const ft = half("dk-fc-ft");
  const fb = half("dk-fc-fb");
  const el = h("span", { class: "dk-fc", "aria-hidden": "true" }, top, bot, ft, fb);
  return { el, top, bot, ft, fb, ch: " ", gen: 0 };
}

const put = (half: HTMLElement, ch: string) => {
  const b = half.firstChild as HTMLElement;
  if (b.textContent !== ch) b.textContent = ch;
};

function show(cell: Cell, ch: string) {
  cell.ch = ch;
  put(cell.top, ch);
  put(cell.bot, ch);
  cell.el.classList.toggle("blank", ch === " ");
}

/** The cards a cell falls through from one character to another (digits cycle forward, like a real board). */
export function flapSteps(from: string, to: string): string[] {
  if (from === to) return [];
  const a = CYCLE.indexOf(from);
  const b = CYCLE.indexOf(to);
  if (a < 0 || b < 0) return [to];
  const out: string[] = [];
  for (let i = (a + 1) % CYCLE.length; ; i = (i + 1) % CYCLE.length) {
    out.push(CYCLE[i]);
    if (i === b) return out;
  }
}

const canAnimate = (el: HTMLElement) => typeof el.animate === "function" && !reducedMotion();
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function fall(cell: Cell, from: string, to: string) {
  put(cell.top, to);
  put(cell.bot, from);
  put(cell.ft, from);
  put(cell.fb, to);
  cell.el.classList.add("flipping");
  cell.el.classList.remove("blank");
  const opts = { duration: STEP_MS / 2, fill: "forwards" as FillMode };
  const a = cell.ft.animate([{ transform: "rotateX(0deg)" }, { transform: "rotateX(-90deg)" }], { ...opts, easing: "cubic-bezier(.55,0,1,.45)" });
  await a.finished.catch(() => {});
  const b = cell.fb.animate([{ transform: "rotateX(90deg)" }, { transform: "rotateX(0deg)" }], { ...opts, easing: "cubic-bezier(0,.55,.45,1)" });
  await b.finished.catch(() => {});
  put(cell.bot, to);
  a.cancel();
  b.cancel();
  cell.el.classList.remove("flipping");
}

export function createFlap(opts: FlapOptions): Flap {
  const cells: Cell[] = [];
  const el = h("span", { class: `dk-flap ${opts.className ?? ""}`.trim(), role: "img", "aria-label": "", "data-value": "" });
  let value = "";
  const ensure = (n: number) => {
    while (cells.length < n) {
      const c = makeCell();
      cells.unshift(c);
      el.prepend(c.el);
    }
  };
  ensure(opts.cells);
  for (const c of cells) show(c, " ");

  async function run(cell: Cell, to: string, delay: number) {
    const gen = ++cell.gen;
    const steps = flapSteps(cell.ch, to);
    if (!steps.length) return;
    if (delay) await sleep(delay);
    for (const ch of steps) {
      if (cell.gen !== gen) return;
      const from = cell.ch;
      cell.ch = ch;
      opts.onStep?.();
      await fall(cell, from, ch);
    }
    if (cell.gen === gen) show(cell, to);
  }

  return {
    el,
    get value() {
      return value;
    },
    set(next: string, animate = true) {
      value = next;
      el.dataset.value = next;
      el.setAttribute("aria-label", next);
      ensure(next.length);
      const padded = next.padStart(cells.length, " ");
      if (!animate || !canAnimate(el) || !el.isConnected) {
        cells.forEach((c, i) => {
          c.gen++;
          c.el.classList.remove("flipping");
          show(c, padded[i]);
        });
        return Promise.resolve();
      }
      let lead = 0;
      return Promise.all(
        cells.map((c, i) => {
          if (c.ch === padded[i]) return Promise.resolve();
          return run(c, padded[i], STAGGER_MS * lead++);
        }),
      ).then(() => {});
    },
  };
}
