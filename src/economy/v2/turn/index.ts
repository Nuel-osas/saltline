// Saltline plays sideways on a phone (G.turn). On a touch screen held upright while the yard is on screen, a card asks
// the player to turn the phone, and a raid in progress pauses behind it. DEPLOY, being a tap, also asks the browser
// for full screen and a landscape lock where it allows them: Android's Chrome does; an iPhone's Safari doesn't, and
// there the card is the whole answer. The lobby and the dock work either way up.
import "./turn.css";

/* eslint-disable @typescript-eslint/no-explicit-any -- the game context is the untyped bundle's G */
type Game = any;

/** The states in which the yard is on screen and the thumbs are on the controls. */
const YARD = new Set(["intro", "playing", "paused"]);

export interface TurnFacts {
  touch: boolean;
  portrait: boolean;
  state: string | null;
}

/** Whether to ask the player to turn the phone. */
export const wantsTurn = (f: TurnFacts): boolean => f.touch && f.portrait && f.state !== null && YARD.has(f.state);

/** On a touch screen, full screen and a landscape lock, where the browser allows them. Call it inside a tap. */
export function landscapeNow(win: Window = window): void {
  try {
    if (!win.matchMedia?.("(pointer: coarse)").matches) return;
    const doc = win.document;
    const lock = () => {
      const o = win.screen?.orientation as (ScreenOrientation & { lock?: (to: string) => Promise<void> }) | undefined;
      const p = o?.lock?.("landscape");
      if (p && typeof p.catch === "function") p.catch(() => {});
    };
    const el = doc.documentElement;
    if (!doc.fullscreenElement && typeof el.requestFullscreen === "function") {
      const p = el.requestFullscreen({ navigationUI: "hide" });
      if (p && typeof p.then === "function") p.then(lock, () => {});
    } else lock();
  } catch {
    // a browser that refuses keeps the card
  }
}

export interface Turn {
  /** Whether the card is up. */
  shown(): boolean;
  stop(): void;
}

export function startTurn(G: Game, win: Window = window): Turn {
  const doc = win.document;
  const card = doc.createElement("div");
  card.className = "tn-card";
  card.setAttribute("role", "alert");
  card.innerHTML = '<div class="tn-phone" aria-hidden="true"><i></i></div><b>Turn your phone sideways</b><p>Saltline plays in landscape.</p>';
  (doc.getElementById("app") ?? doc.body).appendChild(card);

  let state: string | null = typeof G?.game?.state === "string" ? G.game.state : null;
  let up = false;
  const portrait = win.matchMedia("(orientation: portrait)");
  const coarse = win.matchMedia("(pointer: coarse)");
  const touch = () => coarse.matches || doc.documentElement.classList.contains("is-touch");
  const draw = () => {
    const want = wantsTurn({ touch: touch(), portrait: portrait.matches, state });
    if (want !== up) {
      up = want;
      card.classList.toggle("on", up);
    }
    // A raid in progress waits behind the card rather than playing on unseen; the player resumes it from the pause menu
    // (and if they resume still upright, it waits again). Whenever the raid reaches "playing" under the card, not only
    // when the card comes up: the card is often up already during the drop-in intro. On the next tick, because
    // "playing" is announced while the game is still starting the raid, and a pause asked for then is undone.
    if (up && state === "playing")
      win.setTimeout(() => {
        try {
          if (up && G.game?.state === "playing") G.game.pause?.();
        } catch {
          // the card still covers it
        }
      }, 0);
  };
  const off = G?.events?.on?.("game:state", (e: any) => {
    state = typeof e?.state === "string" ? e.state : null;
    draw();
  });
  const onTurn = () => draw();
  portrait.addEventListener?.("change", onTurn);
  win.addEventListener("resize", onTurn);
  draw();

  const turn: Turn = {
    shown: () => up,
    stop() {
      if (typeof off === "function") off();
      portrait.removeEventListener?.("change", onTurn);
      win.removeEventListener("resize", onTurn);
      card.remove();
    },
  };
  if (G) G.turn = turn;
  return turn;
}
