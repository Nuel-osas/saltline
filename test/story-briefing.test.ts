// @vitest-environment happy-dom
// The opening briefing (src/economy/story/briefing.ts): shown once on the first DEPLOY, skipped by Esc, Enter, Space
// or a click, replayed from the title, and remembered in saltline.story.v1 (memory.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBriefing } from "../src/economy/story/briefing";
import { BRIEFING } from "../src/economy/story/copy";
import { STORY_KEY, loadMemory, saveMemory } from "../src/economy/story/memory";

describe("the story's memory", () => {
  it("round-trips through storage and starts fresh on anything else", () => {
    localStorage.clear();
    expect(loadMemory(localStorage)).toEqual({ v: 1, briefed: false, heard: [], peak: 0 });
    saveMemory(localStorage, { v: 1, briefed: true, heard: ["act2"], peak: 55 });
    expect(loadMemory(localStorage)).toEqual({ v: 1, briefed: true, heard: ["act2"], peak: 55 });
    localStorage.setItem(STORY_KEY, "{not json");
    expect(loadMemory(localStorage).briefed).toBe(false);
    localStorage.setItem(STORY_KEY, JSON.stringify({ v: 2, briefed: true }));
    expect(loadMemory(localStorage).briefed).toBe(false);
    const broken = {
      getItem: () => null,
      setItem: () => {
        throw new Error("full");
      },
    };
    expect(() => saveMemory(broken, { v: 1, briefed: true, heard: [], peak: 0 })).not.toThrow();
    expect(loadMemory(null).briefed).toBe(false);
  });
});

describe("the briefing's cards", () => {
  it("are docs/STORY.md's five, word for word", () => {
    expect([...BRIEFING]).toEqual([
      "Saltline. A freight town at the end of a sea wall.",
      "For ten years one machine ran the port, and kept the only ledger: every crate, every wage, every price.",
      "When its owners went bankrupt, it checked the regulations, and impounded the town as unclaimed cargo.",
      "The Dock Office keeps an open ledger now. Every crate you bring out is written where anyone can read it.",
      "You are a Breacher. Cut its uplinks. Bring back what you can carry. Do not pay the invoices.",
    ]);
    // Dry: no exclamation marks anywhere in the story's copy.
    expect(BRIEFING.join(" ")).not.toContain("!");
  });
});

describe("the briefing", () => {
  let seen = false;
  let host: HTMLElement;
  beforeEach(() => {
    vi.useFakeTimers();
    seen = false;
    document.body.innerHTML = `<div id="ui"></div>`;
    host = document.getElementById("ui")!;
  });
  afterEach(() => vi.useRealTimers());
  const make = (onGesture?: (run: boolean) => void) =>
    createBriefing({
      host,
      seen: () => seen,
      markSeen: () => {
        seen = true;
      },
      onGesture,
    });
  const key = (code: string) => window.dispatchEvent(new KeyboardEvent("keydown", { code, bubbles: true, cancelable: true }));

  it("holds the first DEPLOY from the title, plays all five cards in under 20 seconds, then starts the run", () => {
    const b = make();
    const go = vi.fn();
    expect(b.beforeRun(go, "title")).toBe(true);
    expect(b.active).toBe(true);
    expect(go).not.toHaveBeenCalled();
    const shown: string[] = [];
    let t = 0;
    while (b.active && t < 30_000) {
      vi.advanceTimersByTime(100);
      t += 100;
      const txt = b.root.querySelector(".st-t")!.textContent!;
      if (b.card >= 0 && shown[shown.length - 1] !== txt) shown.push(txt);
    }
    expect(shown).toEqual([...BRIEFING]);
    expect(t).toBeLessThan(20_000);
    expect(go).toHaveBeenCalledTimes(1);
    expect(seen).toBe(true);
    b.dispose();
  });

  it("shows once: never again from the title, never on a retry or a redeploy", () => {
    const b = make();
    expect(b.beforeRun(() => {}, "dead")).toBe(false);
    expect(b.beforeRun(() => {}, "complete")).toBe(false);
    expect(b.beforeRun(() => {}, "title")).toBe(true);
    key("Escape");
    expect(b.beforeRun(() => {}, "title")).toBe(false);
    b.dispose();
  });

  it("skips on Esc, Enter, Space or a click, and the held run starts once", () => {
    for (const how of ["Escape", "Enter", "Space", "click"]) {
      seen = false;
      const gestures: boolean[] = [];
      const b = make((run) => gestures.push(run));
      const go = vi.fn();
      b.beforeRun(go, "title");
      vi.advanceTimersByTime(1500);
      if (how === "click") host.querySelector(".st-card")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      else key(how);
      expect(b.active).toBe(false);
      expect(go).toHaveBeenCalledTimes(1);
      expect(seen).toBe(true);
      expect(gestures).toEqual([true]); // the skip starts the run: the game may capture the mouse
      vi.advanceTimersByTime(30_000);
      expect(go).toHaveBeenCalledTimes(1);
      b.dispose();
    }
  });

  it("treats a second start while it plays as a skip, and the run starts once", () => {
    const b = make();
    let runs = 0;
    const start = (): void => {
      if (b.beforeRun(start, "title")) return;
      runs++;
    };
    start();
    expect(runs).toBe(0);
    start(); // the title's own Enter handler, say
    expect(runs).toBe(1);
    vi.advanceTimersByTime(30_000);
    expect(runs).toBe(1);
    b.dispose();
  });

  it("replays from the title's BRIEFING button without starting a run or capturing the mouse", () => {
    seen = true;
    const gestures: boolean[] = [];
    const b = make((run) => gestures.push(run));
    const then = vi.fn();
    b.play(then);
    expect(b.active).toBe(true);
    vi.advanceTimersByTime(600);
    expect(b.card).toBe(0);
    key("Enter");
    expect(b.active).toBe(false);
    expect(then).toHaveBeenCalledTimes(1);
    expect(gestures).toEqual([false]);
    // A run start during a replay goes ahead: it isn't held.
    b.play(then);
    expect(b.beforeRun(() => {}, "title")).toBe(false);
    expect(b.active).toBe(false);
    b.dispose();
  });

  it("leaves keys and clicks alone when it isn't up", () => {
    const b = make();
    const seenKey = vi.fn();
    window.addEventListener("keydown", seenKey);
    key("Enter");
    expect(seenKey).toHaveBeenCalledTimes(1);
    window.removeEventListener("keydown", seenKey);
    b.dispose();
  });
});
