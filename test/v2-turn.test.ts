// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { landscapeNow, startTurn, wantsTurn } from "../src/economy/v2/turn";

/** A window whose screen shape and pointer the test sets. */
function fakeWin(opts: { portrait: boolean; coarse: boolean; fullscreen?: boolean }) {
  const listeners = new Map<string, Set<() => void>>();
  const mq = (query: string) => {
    const set = new Set<() => void>();
    listeners.set(query, set);
    return {
      get matches() {
        return query.includes("portrait") ? opts.portrait : query.includes("coarse") ? opts.coarse : false;
      },
      addEventListener: (_: string, f: () => void) => set.add(f),
      removeEventListener: (_: string, f: () => void) => set.delete(f),
    };
  };
  const calls: string[] = [];
  const doc = document;
  Object.defineProperty(doc, "fullscreenElement", { configurable: true, get: () => (opts.fullscreen ? doc.documentElement : null) });
  (doc.documentElement as any).requestFullscreen = () => (calls.push("fullscreen"), Promise.resolve());
  const win = {
    document: doc,
    matchMedia: mq,
    setTimeout: (f: () => void, ms: number) => setTimeout(f, ms),
    addEventListener: () => {},
    removeEventListener: () => {},
    screen: { orientation: { lock: (to: string) => (calls.push(`lock ${to}`), Promise.resolve()) } },
  } as unknown as Window;
  const turnPhone = (portrait: boolean) => {
    opts.portrait = portrait;
    for (const f of listeners.get("(orientation: portrait)") ?? []) f();
  };
  return { win, calls, turnPhone };
}

function fakeGame(state: string) {
  const handlers: ((e: unknown) => void)[] = [];
  const paused: string[] = [];
  const G = {
    game: { state, pause: () => paused.push("pause") },
    events: { on: (name: string, f: (e: unknown) => void) => (name === "game:state" && handlers.push(f), () => {}) },
  };
  return { G, paused, setState: (s: string) => ((G.game.state = s), handlers.forEach((f) => f({ state: s }))) };
}

describe("the turn card", () => {
  it("asks only on a touch screen held upright, while the yard is on screen", () => {
    for (const state of ["intro", "playing", "paused"]) expect(wantsTurn({ touch: true, portrait: true, state })).toBe(true);
    for (const state of ["title", "complete", "dead", null]) expect(wantsTurn({ touch: true, portrait: true, state })).toBe(false);
    expect(wantsTurn({ touch: true, portrait: false, state: "playing" })).toBe(false);
    expect(wantsTurn({ touch: false, portrait: true, state: "playing" })).toBe(false);
  });

  it("comes up when a raid starts on an upright phone, pauses it, and goes when the phone turns", async () => {
    const { win, turnPhone } = fakeWin({ portrait: true, coarse: true });
    const { G, paused, setState } = fakeGame("title");
    const turn = startTurn(G, win);
    const card = document.querySelector(".tn-card")!;
    expect(turn.shown()).toBe(false); // the lobby works upright
    setState("intro"); // the drop-in: the card is up, nothing to pause yet
    expect(turn.shown()).toBe(true);
    await new Promise((r) => setTimeout(r, 5));
    expect(paused).toEqual([]);
    setState("playing");
    expect(turn.shown()).toBe(true);
    expect(card.classList.contains("on")).toBe(true);
    expect(card.textContent).toContain("Turn your phone sideways");
    expect(paused).toEqual([]); // not while the raid is still starting
    await new Promise((r) => setTimeout(r, 5));
    expect(paused).toEqual(["pause"]);
    turnPhone(false);
    expect(turn.shown()).toBe(false);
    expect(card.classList.contains("on")).toBe(false);
    turn.stop();
    expect(document.querySelector(".tn-card")).toBeNull();
  });

  it("never shows on a desktop, whatever the window's shape", async () => {
    const { win } = fakeWin({ portrait: true, coarse: false });
    const { G, paused } = fakeGame("playing");
    const turn = startTurn(G, win);
    expect(turn.shown()).toBe(false);
    await new Promise((r) => setTimeout(r, 5));
    expect(paused).toEqual([]);
    turn.stop();
  });
});

describe("DEPLOY on a phone", () => {
  it("asks for full screen, then a landscape lock", async () => {
    const { win, calls } = fakeWin({ portrait: true, coarse: true });
    landscapeNow(win);
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toEqual(["fullscreen", "lock landscape"]);
  });
  it("already full screen: only the lock", () => {
    const { win, calls } = fakeWin({ portrait: true, coarse: true, fullscreen: true });
    landscapeNow(win);
    expect(calls).toEqual(["lock landscape"]);
  });
  it("does nothing with a mouse", () => {
    const { win, calls } = fakeWin({ portrait: false, coarse: false });
    landscapeNow(win);
    expect(calls).toEqual([]);
  });
});
