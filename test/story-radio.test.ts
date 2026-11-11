// @vitest-environment happy-dom
// The story on the radio (src/economy/story): which lines a run gets per act, the once-only memory, failed reads
// dropping lines, the 24-hour core count, the town reader and the Harbormaster's own channel.
import { afterEach, describe, expect, it, vi } from "vitest";
import { CONTROL, HARBORMASTER } from "../src/economy/story/copy";
import { coresSold24h, harbormasterAwake, runStartLines } from "../src/economy/story/lines";
import { loadMemory, saveMemory } from "../src/economy/story/memory";
import { createChannel } from "../src/economy/story/radio";
import { createTownReader } from "../src/economy/story/town";
import type { LedgerEvent, TownView } from "../src/economy/types";
import { FAILED, MISSING, input, ok, texts, view } from "./story-fixtures";

describe("run-start lines per act", () => {
  it("says nothing that needs the town when the read failed", () => {
    expect(runStartLines(input(FAILED, { cores24h: 5 })).lines).toEqual([]);
    expect(runStartLines(input(null)).lines).toEqual([]);
  });

  it("plays Act I on a chain without town(), once a visit", () => {
    const first = runStartLines(input(MISSING));
    expect(first.lines).toEqual([{ who: "control", text: CONTROL.act1 }]);
    expect(first.session).toEqual(["act1"]);
    expect(first.heard).toEqual([]);
    expect(runStartLines(input(MISSING, { session: ["act1"] })).lines).toEqual([]);
    expect(texts(runStartLines(input(ok(view(1)))))).toEqual([CONTROL.act1]);
  });

  it("says the lights are back the first time a player sees Act II, then never again", () => {
    const first = runStartLines(input(ok(view(2))));
    expect(texts(first)).toEqual([CONTROL.act2]);
    expect(first.heard).toEqual(["act2"]);
    expect(runStartLines(input(ok(view(2)), { heard: ["act2"] })).lines).toEqual([]);
  });

  it("gives the reveal once and wakes the Harbormaster in Act III", () => {
    const first = runStartLines(input(ok(view(3, { strength: 40 })), { heard: ["act2"], cores24h: 3 }));
    expect(first.lines).toEqual([
      { who: "control", text: CONTROL.reveal },
      { who: "harbormaster", text: HARBORMASTER.runStart(3) },
    ]);
    expect(first.heard).toEqual(["reveal"]);
    expect(first.peak).toBe(40);
    // A player who never saw Act II hears both once-only lines, in order.
    expect(texts(runStartLines(input(ok(view(3)))))).toEqual([CONTROL.act2, CONTROL.reveal]);
    // Heard: only the Harbormaster now.
    expect(texts(runStartLines(input(ok(view(3, { strength: 40 })), { heard: ["act2", "reveal"], cores24h: 1 })))).toEqual([
      "Breacher. 1 of my cores came home today. I am grateful to the Quartermaster.",
    ]);
  });

  it("picks the Harbormaster's line by priority and never invents the core count", () => {
    const heard = ["act2", "reveal"];
    // Above 75: the strength line, with the strength.
    expect(texts(runStartLines(input(ok(view(3, { strength: 82 })), { heard, cores24h: 4 })))).toEqual([
      "I count 82 percent of myself restored. Thank you, Saltline.",
    ]);
    // Unknown or zero cores: silent at the start.
    expect(runStartLines(input(ok(view(3, { strength: 30 })), { heard, cores24h: null })).lines).toEqual([]);
    expect(runStartLines(input(ok(view(3, { strength: 30 })), { heard, cores24h: 0 })).lines).toEqual([]);
    // Below 10 after having been above 50: the town stopped selling, and the peak starts over.
    const stopped = runStartLines(input(ok(view(3, { strength: 6 })), { heard, peak: 64, cores24h: 2 }));
    expect(texts(stopped)).toEqual([HARBORMASTER.stopped]);
    expect(stopped.peak).toBe(6);
    expect(runStartLines(input(ok(view(3, { strength: 6 })), { heard, peak: 6 })).lines).toEqual([]);
    // Below 10 without a high peak first: nothing.
    expect(runStartLines(input(ok(view(3, { strength: 4 })), { heard, peak: 40 })).lines).toEqual([]);
  });

  it("wakes the Harbormaster mid-run only on a read Act III", () => {
    expect(harbormasterAwake(ok(view(3)))).toBe(true);
    expect(harbormasterAwake(ok(view(2)))).toBe(false);
    expect(harbormasterAwake(MISSING)).toBe(false);
    expect(harbormasterAwake(FAILED)).toBe(false);
  });

  it("remembers the once-only lines: a remembered reveal isn't said twice", () => {
    localStorage.clear();
    const m = loadMemory(localStorage);
    const r = runStartLines(input(ok(view(3)), { heard: m.heard }));
    saveMemory(localStorage, { ...m, heard: [...m.heard, ...r.heard] });
    const again = runStartLines(input(ok(view(3)), { heard: loadMemory(localStorage).heard }));
    expect(again.lines).toEqual([]);
  });
});

describe("cores sold in the last 24 hours", () => {
  const now = 1_000_000_000_000;
  const sale = (text: string, ago: number, kind: LedgerEvent["kind"] = "sale"): LedgerEvent => ({ kind, at: now - ago, account: "a", text });
  const H = 3_600_000;

  it("adds up relay cores sold to the Quartermaster, in the contract's words and the dev fake's", () => {
    const events = [
      sale("K. OSEI sold 3 relay cores to Quartermaster for 480.", 2 * H),
      sale("R. VANCE sold 1 relay core to Quartermaster for 170.", 5 * H),
      sale("R. VANCE sold CORE ×2 to Quartermaster for 320", 6 * H),
      sale("K. OSEI sold 4 fuel cells to Quartermaster for 300.", 1 * H), // not cores
      sale("K. OSEI sold 2 relay cores to Moss for 100.", 1 * H), // not the QM
      sale("K. OSEI listed 5 relay cores to Quartermaster", 1 * H, "listing"), // not a sale
      sale("M. ADEYEMI sold 9 relay cores to Quartermaster for 1400.", 30 * H), // older than a day
    ];
    expect(coresSold24h(events, now, 64)).toBe(6);
  });

  it("is unknown when the page of events doesn't reach back a day, or isn't a list", () => {
    const full = Array.from({ length: 64 }, (_, i) => sale("X sold 1 relay core to Quartermaster for 1.", i * 60_000));
    expect(coresSold24h(full, now, 64)).toBeNull();
    // A full page that reaches past a day is complete.
    full[63] = sale("old", 25 * H);
    expect(coresSold24h(full, now, 64)).toBe(63);
    expect(coresSold24h(null, now, 64)).toBeNull();
    expect(coresSold24h([{ kind: "sale", at: Number.NaN, account: "a", text: "" }], now, 64)).toBeNull();
    expect(coresSold24h([], now, 64)).toBe(0);
  });
});

describe("the town reader", () => {
  afterEach(() => vi.useRealTimers());

  it("treats a chain without town() as the start, and caches it", async () => {
    const r = createTownReader({});
    expect((await r.read()).status).toBe("missing");
    expect(r.last?.status).toBe("missing");
  });

  it("fails closed on a rejection, a malformed view and a timeout", async () => {
    expect((await createTownReader({ town: () => Promise.reject(new Error("rpc down")) }).read()).status).toBe("failed");
    const throws = () => {
      throw new Error("sync");
    };
    expect((await createTownReader({ town: throws }).read()).status).toBe("failed");
    const bad = { ...view(3), harbormaster: { strength: 140, recentCores: 0, bonusDrones: 5 } };
    expect((await createTownReader({ town: async () => bad }).read()).status).toBe("failed");
    expect((await createTownReader({ town: async () => ({ act: 4 }) as unknown as TownView }).read()).status).toBe("failed");
    vi.useFakeTimers();
    const slow = createTownReader({ town: () => new Promise<TownView>(() => {}) }).read({ timeout: 2500 });
    vi.advanceTimersByTime(2500);
    expect(await slow).toMatchObject({ status: "failed", why: "timeout" });
  });

  it("reuses a fresh read and asks again once it's stale; a failure is never cached", async () => {
    let t = 0;
    const town = vi.fn(async () => view(2));
    const r = createTownReader({ town }, { now: () => t });
    await r.read({ maxAge: 15_000 });
    t = 10_000;
    await r.read({ maxAge: 15_000 });
    expect(town).toHaveBeenCalledTimes(1);
    t = 20_000;
    await r.read({ maxAge: 15_000 });
    expect(town).toHaveBeenCalledTimes(2);
    const flaky = vi.fn().mockRejectedValueOnce(new Error("x")).mockResolvedValue(view(1));
    const f = createTownReader({ town: flaky }, { now: () => t });
    expect((await f.read()).status).toBe("failed");
    expect((await f.read()).status).toBe("ok");
  });
});

describe("the Harbormaster's radio channel", () => {
  it("switches the HUD's radio box to its channel for its lines only", () => {
    document.body.innerHTML = `<div id="ui"><div class="comms"><span class="comms-who">Control</span><span class="comms-t"></span></div></div>`;
    const handlers: ((e: unknown) => void)[] = [];
    const said: string[] = [];
    const G = {
      events: { on: (_: string, fn: (e: unknown) => void) => (handlers.push(fn), () => {}) },
      hud: { radio: (t: string) => said.push(t) },
    };
    const ch = createChannel(G);
    const box = document.querySelector(".comms")!;
    ch.say({ who: "control", text: CONTROL.act1 });
    ch.say({ who: "harbormaster", text: HARBORMASTER.relayCut });
    expect(said).toEqual([CONTROL.act1, HARBORMASTER.relayCut]);
    const start = (text: string) => handlers.forEach((h) => h({ text }));
    start(CONTROL.act1);
    expect(box.classList.contains("st-hm")).toBe(false);
    start(HARBORMASTER.relayCut);
    expect(box.classList.contains("st-hm")).toBe(true);
    expect(box.querySelector(".comms-who")!.textContent).toBe("Harbormaster");
    // The game's own next line is Control's again.
    start("Two dark. It is throwing everything it has left at you.");
    expect(box.classList.contains("st-hm")).toBe(false);
    expect(box.querySelector(".comms-who")!.textContent).toBe("Control");
  });
});
