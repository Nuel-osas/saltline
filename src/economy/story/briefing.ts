// The opening briefing (docs/STORY.md → Copy across the game): five title cards over the title camera's slow pan, in
// the game's own type and colours. It plays once, on the first DEPLOY ever, before the run starts, and again whenever
// the player presses BRIEFING on the title. Esc, Enter, Space or a click skips it; unskipped it runs under 20 seconds.
//
// How it holds the first run: game.js asks G.ext.beforeRun(go) as a run is about to start (its `// ext:` hook, before
// the reset and run:start). The dock pass gate (dockside/gate.ts) holds the DEPLOY press before that, so the order is
// always gate → briefing → run. Returning true takes the start; `go` starts the run as the game would have.
import { BRIEFING } from "./copy";

export interface BriefingOptions {
  /** Where the overlay mounts (the game's #ui). */
  host: HTMLElement;
  cards?: readonly string[];
  /** True once the player has seen it (played through or skipped). */
  seen(): boolean;
  markSeen(): void;
  /**
   * A skip by click or key: a user gesture, the moment game.js can capture the mouse. `run` is true when the skip
   * starts the held run (a replay from the title starts nothing, so it must not capture anything).
   */
  onGesture?(run: boolean): void;
  /** Shown and hidden, for hiding the title under it. */
  onToggle?(on: boolean): void;
  /** Ms a card stays up (default: 900 + 140 per word). */
  cardMs?(text: string): number;
  /** Where the key and click listeners go (default window). Registered at creation, so they run before later ones. */
  target?: Window;
}

export interface Briefing {
  readonly root: HTMLElement;
  readonly active: boolean;
  /** The card on screen (0–4), or -1. */
  readonly card: number;
  /** G.ext.beforeRun: takes the first run's start from the title and plays first. */
  beforeRun(go: () => void, state: string | undefined): boolean;
  /** Play it now (the title's BRIEFING button). `then` runs when it ends or is skipped. */
  play(then?: () => void): void;
  skip(): void;
  dispose(): void;
}

/** A card's time on screen: enough to read it at an easy pace. The five come to about 18 seconds with the fades. */
export const cardMs = (text: string) => 900 + 140 * text.split(/\s+/).filter(Boolean).length;
const OPEN_MS = 450;
/** The card fades out (story.css: .4s) before the next one's text goes in. */
const GAP_MS = 420;
const CLOSE_MS = 500;

export function createBriefing(opts: BriefingOptions): Briefing {
  const cards = opts.cards ?? BRIEFING;
  const win = opts.target ?? window;
  const doc = opts.host.ownerDocument;
  const timeFor = opts.cardMs ?? cardMs;

  const root = doc.createElement("div");
  root.className = "st-brief";
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-modal", "true");
  root.setAttribute("aria-label", "Briefing");
  root.hidden = true;
  root.innerHTML = `
    <div class="st-veil"></div>
    <div class="st-bars"><i></i><i></i></div>
    <div class="st-card">
      <div class="st-k"><span class="st-tag">B4</span><span>Briefing</span><span class="st-n"></span></div>
      <p class="st-t" aria-live="polite"></p>
    </div>
    <div class="st-foot">
      <div class="st-ticks">${cards.map(() => "<i></i>").join("")}</div>
      <button class="st-skip" type="button">Skip <kbd>Esc</kbd></button>
    </div>`;
  opts.host.appendChild(root);
  const textEl = root.querySelector<HTMLElement>(".st-t")!;
  const numEl = root.querySelector<HTMLElement>(".st-n")!;
  const cardEl = root.querySelector<HTMLElement>(".st-card")!;
  const ticks = [...root.querySelectorAll<HTMLElement>(".st-ticks i")];
  const skipBtn = root.querySelector<HTMLButtonElement>(".st-skip")!;

  let active = false;
  let card = -1;
  let timers: ReturnType<typeof setTimeout>[] = [];
  /** The run waiting on the briefing (first DEPLOY), or the replay's callback. */
  let after: (() => void) | null = null;
  /** Holding the first run's start, rather than replaying from the title. */
  let holding = false;
  let closing: ReturnType<typeof setTimeout> | null = null;
  const later = (ms: number, fn: () => void) => timers.push(setTimeout(fn, ms));
  const clear = () => {
    timers.forEach(clearTimeout);
    timers = [];
  };

  function showCard(i: number) {
    card = i;
    textEl.textContent = cards[i];
    numEl.textContent = `${i + 1} / ${cards.length}`;
    ticks.forEach((t, k) => (t.className = k < i ? "done" : k === i ? "on" : ""));
    cardEl.classList.remove("in");
    void cardEl.offsetWidth; // restart the card's entrance
    cardEl.classList.add("in");
    later(timeFor(cards[i]), () => {
      cardEl.classList.remove("in");
      if (i + 1 < cards.length) later(GAP_MS, () => showCard(i + 1));
      else later(GAP_MS, () => finish());
    });
  }

  function play(then?: () => void, hold = false) {
    if (active) return;
    holding = hold;
    if (closing) (clearTimeout(closing), (closing = null));
    active = true;
    after = then ?? null;
    root.hidden = false;
    root.classList.remove("out");
    void root.offsetWidth;
    root.classList.add("on");
    opts.onToggle?.(true);
    try {
      skipBtn.focus({ preventScroll: true });
    } catch {
      /* focus is a nicety */
    }
    later(OPEN_MS, () => showCard(0));
  }

  function finish() {
    if (!active) return;
    clear();
    active = false;
    card = -1;
    opts.markSeen();
    root.classList.remove("on");
    root.classList.add("out");
    cardEl.classList.remove("in");
    if (doc.activeElement === skipBtn) skipBtn.blur();
    closing = setTimeout(() => {
      closing = null;
      if (!active) ((root.hidden = true), root.classList.remove("out"));
    }, CLOSE_MS);
    opts.onToggle?.(false);
    const then = after;
    after = null;
    then?.();
  }

  function gesture(e: Event) {
    e.preventDefault();
    e.stopImmediatePropagation();
    opts.onGesture?.(holding);
    finish();
  }
  // Capture phase on the window, registered before the Dockside's deploy gate and after nothing that matters: while
  // the briefing is up, its keys and clicks are its own (Enter on the title would otherwise deploy).
  const onKey = (e: KeyboardEvent) => {
    if (!active) return;
    if (e.code === "Escape" || e.code === "Enter" || e.code === "NumpadEnter" || e.code === "Space") gesture(e);
  };
  const onClick = (e: MouseEvent) => {
    if (active) gesture(e);
  };
  win.addEventListener("keydown", onKey, true);
  win.addEventListener("click", onClick, true);

  return {
    root,
    get active() {
      return active;
    },
    get card() {
      return card;
    },
    beforeRun(go, state) {
      // Another start while it plays is a skip. Holding the first run, that run then goes ahead, once; over a replay,
      // this start goes ahead.
      if (active) {
        const held = holding;
        finish();
        return held;
      }
      if (state !== "title" || opts.seen()) return false;
      play(go, true);
      return true;
    },
    play: (then?: () => void) => play(then),
    skip: finish,
    dispose() {
      clear();
      if (closing) clearTimeout(closing);
      active = false;
      after = null;
      win.removeEventListener("keydown", onKey, true);
      win.removeEventListener("click", onClick, true);
      root.remove();
    },
  };
}
