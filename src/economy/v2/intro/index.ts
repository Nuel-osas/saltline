// Saltline v2's opening film (docs/GAME.md, docs/STORY.md): about fifty seconds in the game's own scene, in real
// time. The boat runs in, the dock workers stage the drop, Moss kicks open the crate with the issue rifle in it,
// the camera comes down from the crane over the three uplinks to what waits in the shed, and the title lands.
//
// It plays on a player's first DEPLOY in v2 in place of the text briefing (raid/index.ts asks G.intro.film before the
// sign-on), and again from INTRO on the title. The drop point (the open crate, the supply crate with the lamp on
// it, the coiled line) stays at the player's start afterwards: DROP says where.
//
// URL: ?intro=0 never plays it on DEPLOY (scripts that drive the title), ?intro=1 plays it on every first DEPLOY of
// a page load, seen or not.
/* eslint-disable @typescript-eslint/no-explicit-any -- the game context is the untyped bundle's G */
import { type Film, createFilm } from "./film";
import "./intro.css";
import { DROP } from "./props";
import { type FilmStage, createStage } from "./stage";

export { DROP } from "./props";
export { FILM_SECONDS, SHOTS } from "./timeline";

type Game = any;

export const INTRO_KEY = "saltline.intro.v1";

export interface Intro {
  readonly film: Film;
  readonly stage: FilmStage;
  /** Where the drop point is (the long crate, its yaw, the rifle in it). */
  readonly drop: typeof DROP;
  /** Play it now, as the title's INTRO button does. */
  play(): void;
  dispose(): void;
}

interface Store {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
}

/** Whether the film has been seen, kept in `store`. `force` is the URL's ?intro= (0 never, 1 once more). */
export function createSeen(store: Store | null, force: string | null = null) {
  let seen = force === "0";
  let forced = force === "1";
  if (!seen && !forced) {
    try {
      seen = store?.getItem(INTRO_KEY) === "1";
    } catch {
      seen = false; // storage is off: it plays once a page load
    }
  }
  return {
    seen: () => seen,
    markSeen() {
      seen = true;
      forced = false;
      try {
        store?.setItem(INTRO_KEY, "1");
      } catch {
        /* remembered for this page load only */
      }
    },
  };
}

export function startIntro(G: Game): Intro | null {
  if (!G?.THREE || !G.scene || !G.camera || !G.level?.playerStart) return null;
  const ext = (G.ext ??= { speedScale: 1, gear: {} });
  const host = document.getElementById("ui") ?? document.body;
  const app = document.getElementById("app");
  let store: Store | null = null;
  try {
    store = window.localStorage;
  } catch {
    store = null;
  }
  const memory = createSeen(store, new URLSearchParams(location.search).get("intro"));

  const stage = createStage(G);
  let sawLock = false;
  const film = createFilm({
    host,
    stage,
    seen: memory.seen,
    markSeen: memory.markSeen,
    onToggle: (on) => {
      app?.classList.toggle("in-playing", on);
      sawLock = on && !!G.input?.locked;
    },
    onEnd: (run) => stage.park(run),
    onGesture: (run) => {
      // A skip that starts the held raid is a click or a key: the moment the game can still capture the mouse for it.
      const input = G.input;
      if (run && input && input.mode === "lock" && !input.locked && G.game?.state === "title") input.requestLock?.();
    },
  });
  // game.js's hook (the title's camera step): while this returns true the camera, its field of view and the fade
  // are the film's.
  ext.camera = (dt: number) => film.frame(dt) || stage.parked(dt);

  // DEPLOY captured the mouse before the film took the start, and the browser keeps Esc for itself while it is
  // captured: losing the capture mid-film is that Esc, so it skips.
  const offLock = G.events?.on?.("input:lock", (e: any) => {
    if (e?.locked) sawLock = film.active;
    else if (film.active && sawLock) film.skip();
  });

  // INTRO, on its own short line under the title's actions (where v1 keeps BRIEFING).
  let button: HTMLButtonElement | null = null;
  function injectButton() {
    if (button?.isConnected) return;
    const row = G.game?.menus?.root?.querySelector?.('[data-s="title"] .m-actions') as HTMLElement | null;
    if (!row) return;
    const line = document.createElement("div");
    line.className = "st-replay-line in-replay-line";
    const b = document.createElement("button");
    b.className = "st-replay in-replay";
    b.type = "button";
    b.textContent = "Intro";
    b.setAttribute("aria-label", "Play the opening film");
    b.addEventListener("click", () => film.play(() => b.isConnected && b.focus({ preventScroll: true })));
    line.append(b);
    row.after(line);
    button = b;
  }
  try {
    injectButton();
  } catch {
    /* the film still plays on the first DEPLOY */
  }
  const offState = G.events?.on?.("game:state", (e: any) => {
    try {
      if (e?.state === "title") injectButton();
    } catch {
      /* as above */
    }
  });

  const intro: Intro = {
    film,
    stage,
    drop: DROP,
    play: () => film.play(),
    dispose() {
      if (ext.camera) delete ext.camera;
      if (typeof offLock === "function") offLock();
      if (typeof offState === "function") offState();
      film.dispose();
      stage.dispose();
      button?.parentElement?.remove();
      if (G.intro === intro) delete G.intro;
    },
  };
  G.intro = intro;
  return intro;
}
