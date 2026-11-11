// The story in the game (docs/STORY.md), beside the economy: the opening briefing on the first DEPLOY, replayable from
// the title. The shooter never depends on any of it; on any failure the game plays on as before.
import "./story.css";
import type { Economy } from "../types";
import { createBriefing, type Briefing } from "./briefing";
import { defaultStore, loadMemory, saveMemory } from "./memory";

/* eslint-disable @typescript-eslint/no-explicit-any -- the game context is the untyped bundle's G */
type Game = any;

export interface Story {
  readonly briefing: Briefing;
  update(dt: number): void;
  dispose(): void;
}

export function createStory(G: Game, _economy: Economy, opts: { store?: Storage | null } = {}): Story {
  const ext = (G.ext ??= { speedScale: 1, gear: {} });
  const store = opts.store === undefined ? defaultStore() : opts.store;
  const memory = loadMemory(store);

  const warned = new Set<string>();
  function guard<T>(where: string, fn: () => T): T | undefined {
    try {
      return fn();
    } catch (e) {
      if (!warned.has(where)) (warned.add(where), console.warn(`[story] ${where} failed; the game plays on`, e));
      return undefined;
    }
  }

  // ---- the briefing ----
  const host = document.getElementById("ui") ?? document.body;
  const app = document.getElementById("app");
  const briefing = createBriefing({
    host,
    seen: () => memory.briefed,
    markSeen: () => {
      if (!memory.briefed) ((memory.briefed = true), saveMemory(store, memory));
    },
    onToggle: (on) => app?.classList.toggle("st-briefing", on),
    onGesture: (run) =>
      guard("lock", () => {
        // A skip that starts the held run is a click or a key: the moment the game can still capture the mouse for it
        // (DEPLOY asked once already, but the dock pass gate may have held that press past its gesture).
        const input = G.input;
        if (run && input && input.mode === "lock" && !input.locked && G.game?.state === "title") input.requestLock?.();
      }),
  });
  ext.beforeRun = (go: () => void) => guard("briefing", () => briefing.beforeRun(go, G.game?.state)) ?? false;

  // BRIEFING gets its own short line under the title's action row, so the row keeps its shape (a fourth button there
  // wraps at laptop widths, and the eyebrow line wraps under the wordmark).
  let replayBtn: HTMLButtonElement | null = null;
  function injectButton() {
    if (replayBtn?.isConnected) return;
    const row = G.game?.menus?.root?.querySelector?.('[data-s="title"] .m-actions') as HTMLElement | null;
    if (!row) return;
    const line = document.createElement("div");
    line.className = "st-replay-line";
    const b = document.createElement("button");
    b.className = "st-replay";
    b.type = "button";
    b.textContent = "Briefing";
    b.setAttribute("aria-label", "Play the briefing");
    b.addEventListener("click", () => briefing.play(() => b.isConnected && b.focus({ preventScroll: true })));
    line.append(b);
    row.after(line);
    replayBtn = b;
  }
  guard("button", injectButton);

  return {
    briefing,
    update() {
      guard("update", () => {
        if (!replayBtn?.isConnected) injectButton();
      });
    },
    dispose() {
      if (ext.beforeRun) delete ext.beforeRun;
      briefing.dispose();
      replayBtn?.parentElement?.remove();
      app?.classList.remove("st-briefing");
    },
  };
}

/** Starts the story beside a booted game with an economy (main.ts), and drives it on animation frames. */
export function startStory(G: Game): Story | null {
  try {
    const economy: Economy | undefined = G.economy;
    if (!economy) return null; // ?noeconomy: the baseline game
    const s = createStory(G, economy);
    G.story = s;
    let last = performance.now();
    const loop = (now: number) => {
      const dt = Math.min(0.1, Math.max(0, (now - last) / 1000));
      last = now;
      s.update(dt);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
    return s;
  } catch (e) {
    console.warn("[story] off:", e);
    return null;
  }
}
