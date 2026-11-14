// Saltline v2's opening film (docs/GAME.md, docs/STORY.md): about fifty seconds in the game's own scene, in real
// time. The boat runs in, the dock workers stage the drop, Moss kicks open the crate with the issue rifle in it,
// the camera comes down from the crane over the three uplinks to what waits in the shed, and the title lands.
//
// It is the lobby's "The opening" and the title's INTRO: a player chooses to watch it. It no longer plays by itself
// on a first DEPLOY, because a first-time player waited 50 seconds for a gun (raid/index.ts still asks G.intro.film
// before the sign-on, for ?intro=1). Nothing of its set stays in the level: the rifle crate Moss kicks open
// is the coach's own (../coach/crate.ts), built by the film while it plays and by the coach when the raid starts, at
// the same spot, so the cut from the film to play lands on the same crate.
//
// URL: ?intro=1 plays it on the first DEPLOY of a page load, as it used to; without it DEPLOY goes straight to the
// raid. ?intro=0 is accepted and changes nothing.
/* eslint-disable @typescript-eslint/no-explicit-any -- the game context is the untyped bundle's G */
import { type Film, createFilm } from "./film";
import "./intro.css";
import { type FilmStage, createStage } from "./stage";

export { FILM_SECONDS, SHOTS } from "./timeline";

type Game = any;

export const INTRO_KEY = "saltline.intro.v1";

export interface Intro {
  readonly film: Film;
  readonly stage: FilmStage;
  /** Play it now, as the title's INTRO button does. */
  play(): void;
  dispose(): void;
}

interface Store {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
}

/**
 * Whether DEPLOY passes the film by: always, unless the URL asks for it (`force` is ?intro=; "1" plays it once on
 * DEPLOY). A full viewing is still remembered in `store`, for anything that wants to know it was seen.
 */
export function createSeen(store: Store | null, force: string | null = null) {
  let seen = force !== "1";
  return {
    seen: () => seen,
    markSeen() {
      seen = true;
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
