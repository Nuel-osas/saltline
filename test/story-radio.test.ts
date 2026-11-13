// @vitest-environment happy-dom
// The story on the radio (src/economy/story): which lines a run gets per chapter, the once-only memory, failed reads
// dropping lines, the callsign and the surcharge filled in or the line dropped, the Harbormaster's mid-run billing and
// its pacing, the 24-hour core count, the town reader and the Harbormaster's own channel.
import { afterEach, describe, expect, it, vi } from "vitest";
import { CONTROL, HARBORMASTER, callsignOr, cleanCallsign, fill, trespassFee } from "../src/economy/story/copy";
import { coresSold24h, evidenceLine, harbormasterAwake, invoiceLine, relayLine, runStartLines } from "../src/economy/story/lines";
import { loadMemory, saveMemory } from "../src/economy/story/memory";
import { HM_GAP_MS, createPacer } from "../src/economy/story/pacing";
import { createChannel, lineMs } from "../src/economy/story/radio";
import { createTownReader } from "../src/economy/story/town";
import type { LedgerEvent, TownView } from "../src/economy/types";
import { FAILED, MISSING, input, ok, texts, view } from "./story-fixtures";

const TRESPASS_OSEI = "Good morning, Breacher K. OSEI. Your visit is not authorised. A trespass surcharge of 200 scrip has been added to your account.";

describe("run-start lines per chapter", () => {
  it("says nothing that needs the town when the read failed", () => {
    expect(runStartLines(input(FAILED, { cores24h: 5 })).lines).toEqual([]);
    expect(runStartLines(input(null)).lines).toEqual([]);
  });

  it("plays Chapter 1 on a chain without town(), once a visit", () => {
    const first = runStartLines(input(MISSING));
    expect(first.lines).toEqual([{ who: "control", text: CONTROL.act1 }]);
    expect(first.lines[0].text).toBe("Clinic's down to its last crates of meds. Ines will pay for every box. She'll complain about it.");
    expect(first.session).toEqual(["act1"]);
    expect(first.heard).toEqual([]);
    expect(runStartLines(input(MISSING, { session: ["act1"] })).lines).toEqual([]);
    expect(texts(runStartLines(input(ok(view(1)))))).toEqual([CONTROL.act1]);
  });

  it("says the lights are back the first time a player sees Chapter 2, by callsign, then never again", () => {
    const first = runStartLines(input(ok(view(2)), { callsign: "K. OSEI" }));
    expect(texts(first)).toEqual(["Lights on the water, K. OSEI. That's the clinic. Your cargo did that. Don't let it go to your head."]);
    expect(first.heard).toEqual(["act2"]);
    // No dock pass: Control calls them Breacher.
    expect(texts(runStartLines(input(ok(view(2)))))[0]).toBe(
      "Lights on the water, Breacher. That's the clinic. Your cargo did that. Don't let it go to your head.",
    );
    expect(runStartLines(input(ok(view(2)), { heard: ["act2"] })).lines).toEqual([]);
  });

  it("gives the reveal once, and counts the cores home in Chapter 3", () => {
    const first = runStartLines(input(ok(view(3, { strength: 40 })), { heard: ["act2"], cores24h: 3 }));
    expect(first.lines).toEqual([
      { who: "control", text: CONTROL.reveal },
      { who: "harbormaster", text: "3 of our cores came home today. We are grateful to our Quartermaster." },
    ]);
    expect(CONTROL.reveal).toBe(
      "Control. The Quartermaster's client is the Harbormaster. Every core you sell him, it builds into something. Your call.",
    );
    expect(first.heard).toEqual(["reveal"]);
    expect(first.peak).toBe(40);
    // A player who never saw Chapter 2 hears both once-only lines, in order.
    expect(texts(runStartLines(input(ok(view(3)))))).toEqual([fill(CONTROL.act2, { callsign: "Breacher" }), CONTROL.reveal]);
  });

  it("picks the Harbormaster's Chapter 3 line by priority and never invents the core count", () => {
    const heard = ["act2", "reveal"];
    // Above 75: the strength line, with the strength.
    expect(texts(runStartLines(input(ok(view(3, { strength: 82 })), { heard, cores24h: 4 })))).toEqual([
      "We count 82 percent of ourselves restored. Thank you, Saltline. Your account is in good standing.",
    ]);
    // Unknown or zero cores: nothing about cores.
    expect(runStartLines(input(ok(view(3, { strength: 30 })), { heard, cores24h: null })).lines).toEqual([]);
    expect(runStartLines(input(ok(view(3, { strength: 30 })), { heard, cores24h: 0 })).lines).toEqual([]);
    // Below 10 after having been above 50: the town stopped selling, and the peak starts over.
    const stopped = runStartLines(input(ok(view(3, { strength: 6 })), { heard, peak: 64, cores24h: 2 }));
    expect(texts(stopped)).toEqual(["The town has stopped selling. We can wait. Interest accrues."]);
    expect(stopped.peak).toBe(6);
    expect(runStartLines(input(ok(view(3, { strength: 6 })), { heard, peak: 6 })).lines).toEqual([]);
    // Below 10 without a high peak first: nothing.
    expect(runStartLines(input(ok(view(3, { strength: 4 })), { heard, peak: 40 })).lines).toEqual([]);
  });

  it("bills the trespass surcharge in every chapter, town or no town, after Control", () => {
    for (const read of [MISSING, ok(view(1)), ok(view(2)), FAILED]) {
      const r = runStartLines(input(read, { heard: ["act2"], callsign: "K. OSEI", fee: 200 }));
      expect(r.lines[r.lines.length - 1]).toEqual({ who: "harbormaster", text: TRESPASS_OSEI });
      expect(r.lines.filter((l) => l.who === "harbormaster")).toHaveLength(1);
    }
    // Chapter 3: the surcharge first, then the strength line.
    const three = runStartLines(input(ok(view(3, { strength: 90 })), { heard: ["act2", "reveal"], callsign: "K. OSEI", fee: 200 }));
    expect(three.lines.map((l) => l.who)).toEqual(["harbormaster", "harbormaster"]);
    expect(three.lines[0].text).toBe(TRESPASS_OSEI);
  });

  it("drops the surcharge when the fee or the callsign is unknown", () => {
    const hm = (o: Parameters<typeof input>[1]) => runStartLines(input(MISSING, { session: ["act1"], ...o })).lines;
    expect(hm({ callsign: "K. OSEI", fee: null })).toEqual([]);
    expect(hm({ callsign: null, fee: 200 })).toEqual([]); // never "Breacher Breacher"
    expect(hm({ callsign: "K. OSEI" })).toEqual([]);
    expect(hm({ callsign: "K. OSEI", fee: 200 })).toEqual([{ who: "harbormaster", text: TRESPASS_OSEI }]);
  });

  it("wakes the Harbormaster's strength lines only on a read Chapter 3", () => {
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

describe("filling the live numbers", () => {
  it("fills {callsign} and {fee}, and drops the line when either is unknown", () => {
    expect(fill(HARBORMASTER.trespass, { callsign: "K. OSEI", fee: 200 })).toBe(TRESPASS_OSEI);
    expect(fill(HARBORMASTER.trespass, { callsign: "  K. OSEI ", fee: 150 })).toContain("Breacher K. OSEI. ");
    for (const bad of [{ fee: 200 }, { callsign: "", fee: 200 }, { callsign: "K", fee: null }, { callsign: "K", fee: Number.NaN }, { callsign: "K", fee: -5 }, { callsign: "K", fee: 1.5 }])
      expect(fill(HARBORMASTER.trespass, bad)).toBeNull();
    expect(fill(HARBORMASTER.sealCut)).toBe("Tampering with a customs seal. Fee applied. Please retain this message for your records.");
  });

  it("bills 150 + 25 × the extractions so far, from the profile; an unknown profile is no fee", () => {
    expect(trespassFee({ extractions: 0 })).toBe(150);
    expect(trespassFee({ extractions: 2 })).toBe(200);
    expect(trespassFee({ extractions: 13 })).toBe(475);
    expect(trespassFee(null)).toBeNull();
    expect(trespassFee(undefined)).toBeNull();
    expect(trespassFee({})).toBeNull();
    expect(trespassFee({ extractions: "3" })).toBeNull();
    expect(trespassFee({ extractions: -1 })).toBeNull();
  });

  it("calls a player without a dock pass Breacher, and takes only a real callsign from the profile", () => {
    expect(callsignOr("K. OSEI")).toBe("K. OSEI");
    expect(callsignOr(null)).toBe("Breacher");
    expect(callsignOr("   ")).toBe("Breacher");
    expect(cleanCallsign(" WREN ")).toBe("WREN");
    expect(cleanCallsign("")).toBeNull();
    expect(cleanCallsign(42)).toBeNull();
    expect(cleanCallsign("X".repeat(40))).toBeNull();
  });

  it("counts the evidence once the load goes past 4, and invoices only a known haul", () => {
    expect(evidenceLine(null, 5)).toBe("You are now carrying 5 units of evidence. Thank you.");
    expect(evidenceLine(3, 6)).toBe("You are now carrying 6 units of evidence. Thank you.");
    expect(evidenceLine(4, 4)).toBeNull(); // 4 is not past 4
    expect(evidenceLine(5, 6)).toBeNull(); // already past it
    expect(evidenceLine(2, undefined)).toBeNull();
    expect(invoiceLine(640)).toBe("Removal of goods noted. An invoice for 640 scrip will follow. It will not be paid. We will send it anyway.");
    expect(invoiceLine(null)).toBeNull();
    expect(invoiceLine(undefined)).toBeNull();
    expect(relayLine(1, 3)).toBe("That uplink was ours. We have others.");
    expect(relayLine(2, 3)).toBeNull();
    expect(relayLine(3, 3)).toBeNull();
  });
});

describe("the Harbormaster's pacing", () => {
  function rig() {
    let t = 0;
    let busy = false;
    let hmEnd = -Infinity;
    const said: { text: string; at: number }[] = [];
    const pacer = createPacer({
      now: () => t,
      busy: () => busy,
      lastHarbormasterEnd: () => hmEnd,
      say: (l) => said.push({ text: l.text, at: t }),
    });
    return {
      pacer,
      said,
      at: (ms: number) => ((t = ms), pacer.tick()),
      set busy(b: boolean) {
        busy = b;
      },
      set hmEnd(ms: number) {
        hmEnd = ms;
      },
    };
  }

  it("never talks over Control: waits for an idle radio", () => {
    const r = rig();
    r.busy = true; // Control is on
    r.pacer.add("A");
    r.at(1000);
    r.at(5000);
    expect(r.said).toEqual([]);
    r.busy = false;
    r.at(5100);
    expect(r.said).toEqual([{ text: "A", at: 5100 }]);
  });

  it("never stacks two of its lines within 8 s of the last one ending, whoever said it", () => {
    const r = rig();
    r.pacer.add("A", { ttl: 60_000 });
    r.pacer.add("B", { ttl: 60_000 });
    r.at(0);
    expect(r.said.map((s) => s.text)).toEqual(["A"]);
    // A plays until 6 s.
    r.busy = true;
    r.at(3000);
    r.hmEnd = 6000;
    r.busy = false;
    r.at(6500);
    r.at(6000 + HM_GAP_MS - 1);
    expect(r.said).toHaveLength(1);
    r.at(6000 + HM_GAP_MS);
    expect(r.said.map((s) => s.text)).toEqual(["A", "B"]);
    // A line the boss said straight through the channel counts too.
    r.hmEnd = 20_000;
    r.pacer.add("C", { ttl: 60_000 });
    r.at(25_000);
    expect(r.said).toHaveLength(2);
    r.at(28_000);
    expect(r.said.map((s) => s.text)).toEqual(["A", "B", "C"]);
  });

  it("lets the line with the nearest deadline go first: an answer to a cut before the morning's surcharge", () => {
    const r = rig();
    r.busy = true;
    r.pacer.add("surcharge", { ttl: 50_000 });
    r.at(2000);
    r.pacer.add("uplink", { ttl: 16_000 });
    r.busy = false;
    r.at(9000);
    expect(r.said.map((s) => s.text)).toEqual(["uplink"]);
    r.hmEnd = 13_000;
    r.at(13_000 + HM_GAP_MS);
    expect(r.said.map((s) => s.text)).toEqual(["uplink", "surcharge"]);
  });

  it("drops a line whose turn didn't come in time, and forgets everything on clear", () => {
    const r = rig();
    r.busy = true;
    r.pacer.add("late", { ttl: 5000 });
    r.at(6000);
    r.busy = false;
    r.at(6100);
    expect(r.said).toEqual([]);
    expect(r.pacer.waiting).toBe(0);
    r.pacer.add(null);
    r.pacer.add("");
    expect(r.pacer.waiting).toBe(0);
    r.busy = true;
    r.pacer.add("X");
    r.pacer.add("X"); // the same line twice waits once
    expect(r.pacer.waiting).toBe(1);
    r.pacer.clear();
    r.busy = false;
    r.at(7000);
    expect(r.said).toEqual([]);
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
  function hud() {
    document.body.innerHTML = `<div id="ui"><div class="comms"><span class="comms-who">Control</span><span class="comms-t"></span></div></div>`;
    const handlers: ((e: unknown) => void)[] = [];
    const said: string[] = [];
    const G = {
      events: { on: (_: string, fn: (e: unknown) => void) => (handlers.push(fn), () => {}) },
      hud: { radio: (t: string) => said.push(t) },
    };
    const start = (text: string) => handlers.forEach((h) => h({ text }));
    return { G, said, start, box: document.querySelector(".comms")! };
  }

  it("switches the HUD's radio box to its channel for its lines only", () => {
    const { G, said, start, box } = hud();
    const ch = createChannel(G);
    ch.say({ who: "control", text: CONTROL.act1 });
    ch.say({ who: "harbormaster", text: HARBORMASTER.relayCut });
    expect(said).toEqual([CONTROL.act1, HARBORMASTER.relayCut]);
    start(CONTROL.act1);
    expect(box.classList.contains("st-hm")).toBe(false);
    start(HARBORMASTER.relayCut);
    expect(box.classList.contains("st-hm")).toBe(true);
    expect(box.querySelector(".comms-who")!.textContent).toBe("Harbormaster");
    // The game's own next line is Control's again.
    start("Two dark. It's escalating to a supervisor. The supervisor is also it.");
    expect(box.classList.contains("st-hm")).toBe(false);
    expect(box.querySelector(".comms-who")!.textContent).toBe("Control");
  });

  it("keeps time for the pacing: busy while a line is queued or on, and when the Harbormaster's last line ended", () => {
    const { G, start, box } = hud();
    let t = 1000;
    const ch = createChannel(G, document, () => t);
    expect(ch.busy()).toBe(false);
    expect(ch.lastHarbormasterEnd()).toBe(-Infinity);
    ch.say({ who: "harbormaster", text: HARBORMASTER.sealCut }, 4.4);
    expect(ch.busy()).toBe(true); // queued, not started yet
    box.classList.add("on");
    start(HARBORMASTER.sealCut);
    expect(ch.lastHarbormasterEnd()).toBe(1000 + lineMs(HARBORMASTER.sealCut, 4.4));
    expect(ch.busy()).toBe(true); // on air
    box.classList.remove("on");
    expect(ch.busy()).toBe(false);
    // Control's next line starting ends it early.
    t = 3000;
    start("One uplink dark. It's filing a complaint. Machines inbound.");
    expect(ch.lastHarbormasterEnd()).toBe(3000);
    // A line the HUD cleared without a reset stops counting as queued after a minute.
    ch.say({ who: "harbormaster", text: "lost" });
    expect(ch.busy()).toBe(true);
    t += 61_000;
    expect(ch.busy()).toBe(false);
  });
});
