// The opening film's player: the letterbox, the subtitles, SKIP and the title card over a stage that frames each shot
// in the live scene (stage.ts). It plays on a player's first DEPLOY in v2, holding the raid's start as the text
// briefing did (G.ext.beforeRun → raid/index.ts), and again from INTRO on the title.
//
// The film's clock is the game's own frame: game.js asks G.ext.camera(dt) from the title's camera step, and that call
// is `frame(dt)` here. A film that can't play must never hold the raid: a stage that throws, or a game that stops
// asking for frames, ends the film at once and the raid starts as if it had been skipped.
import { FILM_SECONDS, SHOTS, type Subtitle, blackAt, locate, subtitleAt } from "./timeline";

/** What the film is shot on: stage.ts in the game, a recorder in the tests. */
export interface Stage {
  /** Build the cast and the props, take the camera, pin the score. `layer` is for marks drawn over the picture. */
  begin(layer: HTMLElement): void;
  /** Frame the film at `t` seconds; `dt` is the frame's own time. */
  frame(t: number, dt: number): void;
  /** Give everything back but the drop point. Called exactly once for each `begin`, however the film ends. */
  end(): void;
}

export interface FilmOptions {
  /** Where the overlay mounts (the game's #ui). */
  host: HTMLElement;
  stage: Stage;
  /** True once the player has seen it (played through, skipped, or failed). */
  seen(): boolean;
  markSeen(): void;
  /**
   * A skip by click or key: a user gesture, the moment game.js can capture the mouse. `run` is true when the skip
   * starts the held raid (a replay from the title starts nothing, so it must not capture anything).
   */
  onGesture?(run: boolean): void;
  /** Shown and hidden, for hiding the title under it. */
  onToggle?(on: boolean): void;
  /** `run` is true when the film that just ended was holding a raid's start. */
  onEnd?(run: boolean): void;
  /** Ms without a frame before the film gives up (default 2500). */
  stallMs?: number;
  /** Where the key and click listeners go (default window). */
  target?: Window;
}

export interface Film {
  readonly root: HTMLElement;
  readonly active: boolean;
  /** Seconds into the film. */
  readonly time: number;
  /** The shot on screen (0–4), or -1. */
  readonly shot: number;
  /** G.ext.beforeRun's part: takes the first raid's start from the title and plays first. */
  beforeRun(go: () => void, state: string | undefined): boolean;
  /** Play it now (the title's INTRO button). `then` runs when it ends or is skipped. */
  play(then?: () => void): void;
  skip(): void;
  /** One game frame. True while the film holds the camera. */
  frame(dt: number): boolean;
  /** Jump to `t` seconds (the frame captures and the tests). */
  seek(t: number): void;
  dispose(): void;
}

const WHO: Record<Subtitle["who"], string> = { control: "Control", moss: "Moss", harbormaster: "Harbormaster" };
const CLOSE_MS = 500;
/** Where and when it is, over the first shot. */
export const SLUG = { shot: "water", at: 1, for: 4.6, text: "05:40 · Saltline Terminal" } as const;

export function createFilm(opts: FilmOptions): Film {
  const win = opts.target ?? window;
  const doc = opts.host.ownerDocument;
  const stallMs = opts.stallMs ?? 2500;

  const root = doc.createElement("div");
  root.className = "in-film";
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-modal", "true");
  root.setAttribute("aria-label", "Opening film");
  root.hidden = true;
  root.innerHTML = `
    <div class="in-black"></div>
    <div class="in-marks" aria-hidden="true"></div>
    <div class="in-bars"><i></i><i></i></div>
    <div class="in-slug"><span class="in-tag">B4</span><span class="in-slug-t"></span></div>
    <div class="in-title"><b>SALTLINE</b><p class="in-hm"></p></div>
    <div class="in-sub" aria-live="polite"><span class="in-who"></span><p class="in-line"></p></div>
    <button class="in-skip" type="button">Skip <kbd>Esc</kbd></button>`;
  opts.host.appendChild(root);
  const q = <T extends HTMLElement>(sel: string) => root.querySelector<T>(sel)!;
  const blackEl = q(".in-black");
  const marksEl = q(".in-marks");
  const slugEl = q(".in-slug");
  const titleEl = q(".in-title");
  const hmEl = q(".in-hm");
  const subEl = q(".in-sub");
  const whoEl = q(".in-who");
  const lineEl = q(".in-line");
  const skipBtn = q<HTMLButtonElement>(".in-skip");
  q(".in-slug-t").textContent = SLUG.text;

  let active = false;
  let t = 0;
  /** The raid waiting on the film (first DEPLOY), or the replay's callback. */
  let after: (() => void) | null = null;
  /** Holding the first raid's start, rather than replaying from the title. */
  let holding = false;
  let closing: ReturnType<typeof setTimeout> | null = null;
  let watch: ReturnType<typeof setInterval> | null = null;
  let framesSeen = 0;
  let quiet = 0;
  let shown: Subtitle | null = null;
  let black = -1;

  const warn = (what: string, e: unknown) => console.warn(`[intro] ${what}; the raid goes ahead`, e);

  /** The overlay at film time `t`: the subtitle, the black, the slug and the title card. All from timeline.ts. */
  function paint() {
    const w = locate(t);
    const k = Math.round(blackAt(t) * 100) / 100;
    if (k !== black) ((black = k), (blackEl.style.opacity = String(k)));
    const sub = subtitleAt(t);
    if (sub !== shown) {
      shown = sub;
      const title = sub?.who === "harbormaster";
      subEl.classList.toggle("on", !!sub && !title);
      if (sub && !title) ((whoEl.textContent = WHO[sub.who]), (lineEl.textContent = sub.text), (subEl.dataset.who = sub.who));
      if (title) hmEl.textContent = sub!.text;
      hmEl.classList.toggle("on", !!title);
    }
    titleEl.classList.toggle("on", w.shot?.id === "title" && w.local > 0.25);
    slugEl.classList.toggle("on", w.shot?.id === SLUG.shot && w.local >= SLUG.at && w.local < SLUG.at + SLUG.for);
    root.dataset.shot = w.shot?.id ?? "";
  }

  function play(then?: () => void, hold = false) {
    if (active) return;
    holding = hold;
    if (closing) (clearTimeout(closing), (closing = null));
    active = true;
    t = 0;
    after = then ?? null;
    shown = null;
    black = -1;
    hmEl.textContent = "";
    root.hidden = false;
    root.classList.remove("out");
    void root.offsetWidth;
    root.classList.add("on");
    try {
      opts.onToggle?.(true);
    } catch {
      /* the title stays up under the film */
    }
    try {
      opts.stage.begin(marksEl);
      paint();
    } catch (e) {
      warn("the film couldn't start", e);
      finish();
      return;
    }
    try {
      skipBtn.focus({ preventScroll: true });
    } catch {
      /* focus is a nicety */
    }
    // The game draws the film. If it stops asking for frames (a hidden tab, a missing hook), the raid can't wait.
    framesSeen = 0;
    quiet = 0;
    const step = Math.min(500, stallMs);
    watch = setInterval(() => {
      if (framesSeen > 0) ((framesSeen = 0), (quiet = 0));
      else if ((quiet += step) >= stallMs) (warn("no frames", "stalled"), finish());
    }, step);
  }

  function finish() {
    if (!active) return;
    active = false;
    if (watch) (clearInterval(watch), (watch = null));
    try {
      opts.stage.end();
    } catch (e) {
      warn("the stage didn't clear cleanly", e);
    }
    try {
      opts.markSeen();
    } catch {
      /* it plays again next time */
    }
    root.classList.remove("on");
    root.classList.add("out");
    subEl.classList.remove("on");
    marksEl.textContent = "";
    if (doc.activeElement === skipBtn) skipBtn.blur();
    closing = setTimeout(() => {
      closing = null;
      if (!active) ((root.hidden = true), root.classList.remove("out"), titleEl.classList.remove("on"));
    }, CLOSE_MS);
    const held = holding;
    holding = false;
    try {
      opts.onToggle?.(false);
      opts.onEnd?.(held);
    } catch {
      /* decoration */
    }
    const then = after;
    after = null;
    then?.();
  }

  function frame(dt: number): boolean {
    if (!active) return false;
    framesSeen++;
    t += Math.min(Math.max(Number.isFinite(dt) ? dt : 0, 0), 0.1);
    if (t >= FILM_SECONDS) {
      finish();
      return false;
    }
    try {
      opts.stage.frame(t, dt);
      paint();
    } catch (e) {
      warn("a shot failed", e);
      finish();
      return false;
    }
    return true;
  }

  function gesture(e: Event) {
    e.preventDefault();
    e.stopImmediatePropagation();
    try {
      opts.onGesture?.(holding);
    } catch {
      /* capturing the mouse is a nicety */
    }
    finish();
  }
  // Capture phase on the window: while the film is up, its keys and clicks are its own (Enter on the title would
  // otherwise deploy again).
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
    get time() {
      return t;
    },
    get shot() {
      return active ? Math.min(locate(t).index, SHOTS.length - 1) : -1;
    },
    beforeRun(go, state) {
      // Another start while it plays is a skip. Holding the first raid, that raid then goes ahead, once; over a
      // replay, this start goes ahead.
      if (active) {
        const held = holding;
        finish();
        return held;
      }
      if (state !== "title" || opts.seen()) return false;
      play(go, true); // a film that fails to start has already called `go`: the start is taken either way
      return true;
    },
    play: (then?: () => void) => play(then),
    skip: finish,
    frame,
    seek(to) {
      if (active) t = Math.min(Math.max(0, to), FILM_SECONDS - 0.001);
    },
    dispose() {
      finish();
      if (closing) clearTimeout(closing);
      win.removeEventListener("keydown", onKey, true);
      win.removeEventListener("click", onClick, true);
      root.remove();
    },
  };
}
