// @vitest-environment happy-dom
// "While you were away" (src/economy/dockside/away.ts): which ledger lines count, the diff against the snapshot, and
// that a failed read shows nothing rather than a wrong number. Then the card itself, through the Dockside on the
// shared offline mock (src/economy/mock.ts): a broker exports while the player is away and the dividend shows up.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDockside, type Dockside, type GameLike } from "../src/economy/dockside";
import { addWrecks, awayLines, listingSeller, loadSeen, MAX_LINES, noteNews, ownerShare, saveSeen, SEEN_KEY, seenFrom, wreckOwners, type AwayReads, type Seen } from "../src/economy/dockside/away";
import { BROKERS } from "../src/economy/items";
import { createMockChain, createMockWallet } from "../src/economy/mock";
import type { BrokerView, LedgerEvent } from "../src/economy/types";

const ME = "a".repeat(64);
const T0 = 1_800_000_000_000;

function broker(id: "moss" | "ines" | "qm", o: Partial<BrokerView> = {}): BrokerView {
  const base: Record<string, Pick<BrokerView, "name" | "bids">> = {
    moss: { name: "Moss", bids: [{ tokenId: "copper", price: 58, reason: "" }, { tokenId: "chips", price: 75, reason: "" }] },
    ines: { name: "Ines", bids: [{ tokenId: "meds", price: 90, reason: "" }, { tokenId: "fuel", price: 110, reason: "" }] },
    qm: { name: "Quartermaster", bids: [{ tokenId: "core", price: 160, reason: "" }, { tokenId: "fuel", price: 120, reason: "" }] },
  };
  return { id, accountId: `${id}.saltline.testnet`, open: true, scrip: 1200, stance: 100, stock: {}, asks: [], shares: [], lastMemo: null, ...base[id], ...o };
}
const ev = (kind: LedgerEvent["kind"], account: string, callsign: string, text: string, at: number): LedgerEvent => ({ kind, account, callsign, text, at });

function seen(o: Partial<Seen> = {}): Seen {
  return {
    v: 1,
    account: ME,
    at: T0,
    ledgerAt: T0,
    callsign: "WREN",
    scrip: 150,
    open: { moss: true, ines: true, qm: true },
    bids: { copper: 58, chips: 75, meds: 90, fuel: 120, core: 160 },
    haul: { best: 320, above: [], ranked: true },
    wrecks: [],
    ...o,
  };
}
function reads(o: Partial<AwayReads> = {}): AwayReads {
  return {
    balances: { scrip: 150 },
    brokers: [broker("moss"), broker("ines"), broker("qm")],
    recent: [],
    leaderboard: { netWorth: [], bestHaul: [{ accountId: ME, callsign: "WREN", value: 320 }], investors: [] },
    profile: { accountId: ME, callsign: "WREN", registeredAt: T0 - 1e6, runs: 3, extractions: 2, deaths: 1, bestHaul: 320 },
    wrecks: [],
    ...o,
  };
}

describe("reading the ledger", () => {
  it("finds whose wreck was brought back, in the contract's words and the mock's", () => {
    expect(wreckOwners("GULL made the boat with 2 copper. Haul worth 120. Brought back WREN's wreck.")).toEqual(["WREN"]);
    expect(wreckOwners("GULL made the boat with 2 copper. Haul worth 120. Brought back K. OSEI and WREN's wreck.")).toEqual(["K. OSEI", "WREN"]);
    expect(wreckOwners("GULL made the boat with 1 coil, and recovered WREN's wreck and sent 1 coil home.")).toEqual(["WREN"]);
    expect(wreckOwners("RECOVERED made the boat with 1 coil.")).toEqual([]); // a callsign is never the verb
    expect(wreckOwners("LOW TIDE made the boat with 1 coil. Brought back LOW WREN's wreck.")).toEqual(["LOW WREN"]);
    expect(listingSeller("GULL bought WREN's 2 coils for 140.")).toBe("WREN");
    expect(listingSeller("WREN listed 2 coils at 70 each.")).toBe(null);
  });

  it("splits a wreck the way the contract does: the finder's 70% rounds half up", () => {
    expect([1, 2, 3, 6].map(ownerShare)).toEqual([0, 1, 1, 2]);
  });
});

describe("the away card's lines", () => {
  it("shows nothing on a first visit, or against another account's snapshot", () => {
    const now = reads({ balances: { scrip: 999 } });
    expect(awayLines(null, now, ME)).toEqual([]);
    expect(awayLines(seen({ account: "b".repeat(64) }), now, ME)).toEqual([]);
  });

  it("counts only ledger lines after the last look that name this player, and says what came home", () => {
    const prev = seen({ wrecks: [{ id: 4, items: [{ tokenId: "copper", amount: 3 }] }] });
    const now = reads({
      wrecks: [],
      recent: [
        ev("extract", "gull.testnet", "GULL", "GULL made the boat with 2 copper. Haul worth 120. Brought back WREN's wreck.", T0 + 60_000),
        ev("extract", "kite.testnet", "KITE", "KITE made the boat with 1 core. Brought back WREN's wreck.", T0 - 60_000), // before the last look
        ev("extract", ME, "WREN", "WREN made the boat with 1 coil. Brought back WREN's wreck.", T0 + 70_000), // their own run
        ev("extract", "tide.testnet", "LOW TIDE", "LOW TIDE made the boat. Brought back LOW WREN's wreck.", T0 + 80_000), // another callsign
        ev("wreck", "gull.testnet", "GULL", "GULL went down at spot 3. 1 copper left in the yard.", T0 + 90_000),
      ],
    });
    const lines = awayLines(prev, now, ME);
    expect(lines).toEqual([
      { kind: "wreck", tag: "Salvage", text: "GULL hauled your wreck out of the yard. Your 30% came home.", figure: "+1 coil", tone: "up" },
    ]);
  });

  it("leaves the figure off when the wrecks can't be matched, rather than guess", () => {
    const prev = seen({ wrecks: [{ id: 4, items: [{ tokenId: "copper", amount: 3 }] }, { id: 5, items: [{ tokenId: "core", amount: 2 }] }] });
    const recent = [ev("extract", "gull.testnet", "GULL", "GULL made the boat. Brought back WREN's wreck.", T0 + 1000)];
    // two gone, one recovery on the ledger (the other was lost to the sea): which came home is unknown
    expect(awayLines(prev, reads({ recent, wrecks: [] }), ME)[0]).toMatchObject({ kind: "wreck", figure: undefined });
    // the wrecks read failed
    expect(awayLines(prev, reads({ recent, wrecks: null }), ME)[0]).toMatchObject({ kind: "wreck", figure: undefined });
  });

  it("measures dividends against the snapshot and names the broker they hold shares in", () => {
    const moss = broker("moss", { shares: [{ accountId: ME, callsign: "WREN", shares: 100 }] });
    const now = reads({
      balances: { scrip: 162 },
      brokers: [moss, broker("ines"), broker("qm")],
      recent: [
        ev("export", moss.accountId, "Moss", "Moss shipped 6 coils to the freighter for 210. Shelves can't take more.", T0 + 5000),
        ev("export", "ines.saltline.testnet", "Ines", "Ines shipped 2 fuel cells to the freighter for 140.", T0 + 6000), // no shares there
      ],
    });
    expect(awayLines(seen(), now, ME)).toEqual([
      { kind: "scrip", tag: "Dividend", text: "Moss shipped to the freighter. Your dividend is in.", figure: "+12 scrip", tone: "up" },
    ]);
  });

  it("shows nothing rather than a wrong number when a read failed", () => {
    const moss = broker("moss", { shares: [{ accountId: ME, callsign: "WREN", shares: 100 }] });
    const recent = [ev("export", moss.accountId, "Moss", "Moss shipped 6 coils to the freighter for 210.", T0 + 5000)];
    // balances unknown: no scrip line, and no card at all
    expect(awayLines(seen(), reads({ balances: null, brokers: [moss], recent }), ME)).toEqual([]);
    // the snapshot's scrip was unknown: nothing to measure against
    expect(awayLines(seen({ scrip: null }), reads({ balances: { scrip: 162 }, brokers: [moss], recent }), ME)).toEqual([]);
    // the ledger unknown: the measured figure stands, but nobody is credited with it
    expect(awayLines(seen(), reads({ balances: { scrip: 162 }, brokers: [moss], recent: null }), ME)).toEqual([
      { kind: "scrip", tag: "Scrip in", text: "Scrip came in while you were out.", figure: "+12 scrip", tone: "up" },
    ]);
    // brokers unknown: no shut/reopen and no price lines, even with cargo held
    expect(awayLines(seen({ open: { moss: false } }), reads({ brokers: null, balances: { scrip: 150, copper: 3 } }), ME)).toEqual([]);
    // a spend (or anything below the snapshot) is not news
    expect(awayLines(seen(), reads({ balances: { scrip: 90 } }), ME)).toEqual([]);
  });

  it("says when a broker they hold shares in shut or reopened, and leaves the others out", () => {
    const share = [{ accountId: ME, callsign: "WREN", shares: 40 }];
    const now = reads({ brokers: [broker("moss", { open: false, shares: share }), broker("ines", { shares: share }), broker("qm", { open: false })] });
    const lines = awayLines(seen({ open: { moss: true, ines: false, qm: true } }), now, ME);
    expect(lines.map((l) => [l.tag, l.text])).toEqual([
      ["Shut", "Moss pulled the shutter down. Your shares wait on a reopening."],
      ["Reopened", "Ines is open again. Your shares are earning."],
    ]);
  });

  it("says when their best haul was beaten on the board", () => {
    const board = (rows: [string, string, number][]) => ({ netWorth: [], investors: [], bestHaul: rows.map(([accountId, callsign, value]) => ({ accountId, callsign, value })) });
    const prev = seen({ haul: { best: 320, above: ["salt"], ranked: true } });
    const now = reads({ leaderboard: board([["salt", "OLD SALT", 610], ["kes", "KESTREL-9", 410], [ME, "WREN", 320]]) });
    expect(awayLines(prev, now, ME)).toEqual([{ kind: "board", tag: "Board", text: "KESTREL-9 beat your best haul: 410 to your 320.", figure: "now #3", tone: "down" }]);
    // not on the board last time: not news
    expect(awayLines(seen({ haul: { best: 320, above: ["salt"], ranked: false } }), now, ME)).toEqual([]);
    // the board unknown: nothing
    expect(awayLines(prev, reads({ leaderboard: null }), ME)).toEqual([]);
  });

  it("calls out big moves on cargo they hold, biggest first, and ignores small ones and cargo they don't hold", () => {
    const now = reads({
      balances: { scrip: 150, copper: 3, meds: 2, core: 1 },
      brokers: [
        broker("moss", { bids: [{ tokenId: "copper", price: 58, reason: "" }, { tokenId: "chips", price: 30, reason: "" }] }),
        broker("ines", { bids: [{ tokenId: "meds", price: 84, reason: "" }, { tokenId: "fuel", price: 110, reason: "" }] }),
        broker("qm", { bids: [{ tokenId: "core", price: 96, reason: "" }, { tokenId: "fuel", price: 120, reason: "" }] }),
      ],
    });
    const lines = awayLines(seen({ bids: { copper: 41, chips: 75, meds: 90, core: 160 } }), now, ME);
    expect(lines).toEqual([
      { kind: "price", tag: "Price up", text: "Copper coil: Moss pays 58, was 41. You hold 3.", figure: "▲ 41%", tone: "up" },
      { kind: "price", tag: "Price down", text: "Relay core: best bid 96, was 160. You hold 1.", figure: "▼ 40%", tone: "down" },
    ]);
  });

  it("keeps it to four lines, the most personal first", () => {
    const share = [{ accountId: ME, callsign: "WREN", shares: 40 }];
    const prev = seen({ open: { moss: true, ines: false, qm: true }, bids: { copper: 20, core: 300 }, wrecks: [{ id: 1, items: [{ tokenId: "fuel", amount: 2 }] }] });
    const now = reads({
      balances: { scrip: 170, copper: 1, core: 1 },
      brokers: [broker("moss", { open: false, shares: share }), broker("ines", { shares: share }), broker("qm")],
      recent: [ev("extract", "g", "GULL", "GULL made the boat. Brought back WREN's wreck.", T0 + 1)],
      wrecks: [],
    });
    const lines = awayLines(prev, now, ME);
    expect(lines).toHaveLength(MAX_LINES);
    expect(lines.map((l) => l.kind)).toEqual(["wreck", "scrip", "broker", "broker"]);
    expect(lines[0].figure).toBe("+1 fuel cell");
  });
});

describe("the snapshot", () => {
  it("takes what was read and keeps what wasn't", () => {
    const prev = seen({ scrip: 150, ledgerAt: T0 });
    const s = seenFrom(prev, { balances: null, recent: [ev("sale", "x", "X", "…", T0 + 9), ev("sale", "x", "X", "…", T0 + 4)] }, ME, T0 + 100);
    expect(s.scrip).toBe(150); // the failed read kept the old value
    expect(s.ledgerAt).toBe(T0 + 9);
    expect(s.at).toBe(T0 + 100);
    const t = seenFrom(prev, { balances: { scrip: 12 }, wrecks: [{ id: 2, spot: 1, owner: ME, callsign: "WREN", items: [{ tokenId: "meds", amount: 1 }], at: 0 }, { id: 3, spot: 1, owner: "x", callsign: "X", items: [], at: 0 }] }, ME, T0);
    expect(t.scrip).toBe(12);
    expect(t.wrecks).toEqual([{ id: 2, items: [{ tokenId: "meds", amount: 1 }] }]);
    // another account's snapshot is never carried over
    expect(seenFrom(seen({ account: "b".repeat(64), scrip: 999 }), {}, ME, T0).scrip).toBe(null);
  });

  it("catches lines about them while the Dockside is shut, so they survive the ledger's 64-line window", () => {
    const moss = "moss.saltline.testnet";
    const prev = seen({ shareIn: [moss], wrecks: [{ id: 4, items: [{ tokenId: "meds", amount: 2 }] }] });
    const busy = [
      ev("extract", "gull.testnet", "GULL", "GULL made the boat. Brought back WREN's wreck.", T0 + 10),
      ev("listing", "kite.testnet", "KITE", "KITE bought WREN's 1 coil for 70.", T0 + 11),
      ev("export", moss, "Moss", "Moss shipped 4 coils to the freighter for 140.", T0 + 12),
      ev("export", "ines.saltline.testnet", "Ines", "Ines shipped 2 fuel cells to the freighter for 140.", T0 + 13), // no shares
      ev("sale", "gull.testnet", "GULL", "GULL sold 2 coils to Moss for 110.", T0 + 14), // not about them
      ev("extract", "kite.testnet", "KITE", "KITE made the boat. Brought back WREN's wreck.", T0 - 5), // before the last look
    ];
    const caught = noteNews(prev, busy);
    expect(caught.news!.map((e) => e.kind)).toEqual(["export", "listing", "extract"]);
    expect(noteNews(caught, busy)).toBe(caught); // nothing new: unchanged
    // by the time they look, the ledger has moved on: the caught lines still tell it
    const later = Array.from({ length: 64 }, (_, i) => ev("sale", "x.testnet", "X", `X sold 1 coil to Moss for ${50 + i}.`, T0 + 1000 + i));
    const now = reads({
      balances: { scrip: 230 },
      brokers: [broker("moss", { accountId: moss, shares: [{ accountId: ME, callsign: "WREN", shares: 50 }] }), broker("ines"), broker("qm")],
      recent: later,
      wrecks: [],
    });
    expect(awayLines(caught, now, ME).map((l) => [l.kind, l.text, l.figure])).toEqual([
      ["wreck", "GULL hauled your wreck out of the yard. Your 30% came home.", "+1 case of meds"],
      ["scrip", "Moss paid a dividend, and your listing sold on the board.", "+80 scrip"],
    ]);
  });

  it("adds a new wreck without forgetting one that's gone", () => {
    const s = seen({ wrecks: [{ id: 1, items: [{ tokenId: "fuel", amount: 2 }] }] });
    const t = addWrecks(s, [{ id: 7, spot: 2, owner: ME, callsign: "WREN", items: [{ tokenId: "core", amount: 1 }], at: 0 }]);
    expect(t.wrecks!.map((w) => w.id)).toEqual([1, 7]);
  });

  it("is stored per account and survives a bad value", () => {
    saveSeen(localStorage, seen());
    expect(loadSeen(localStorage, ME)?.scrip).toBe(150);
    expect(loadSeen(localStorage, "b".repeat(64))).toBe(null);
    localStorage.setItem(SEEN_KEY, "{not json");
    expect(loadSeen(localStorage, ME)).toBe(null);
    localStorage.removeItem(SEEN_KEY);
  });
});

// ---- the card, through the Dockside on the offline mock ----
let docks: Dockside[] = [];
afterEach(() => {
  for (const d of docks) {
    d.close();
    d.deployGate.dispose();
  }
  docks = [];
  localStorage.clear();
  document.body.replaceChildren();
});

describe("the away card in the Dockside", () => {
  it("says nothing the first time, then shows a dividend that came in while they were gone, once", async () => {
    let clock = T0;
    const mock = createMockChain(7, { storage: null, now: () => clock });
    const wallet = createMockWallet(mock);
    expect((await wallet.claim("WREN")).ok).toBe(true);
    expect((await mock.invest("moss", 100)).ok).toBe(true);
    const ui = document.createElement("div");
    const menus = document.createElement("div");
    menus.innerHTML = `<section data-s="title"><div class="m-actions"><button data-act="deploy">Deploy</button></div></section>`;
    ui.append(menus);
    document.body.append(ui);
    const G: GameLike = { events: { on: () => () => {}, emit: () => {} }, game: { state: "title", menus: { root: menus } } };
    const dock = createDockside(G, { chain: mock, wallet, manifest: null, carried: {} }, { host: ui });
    docks.push(dock);

    // first look: no card, and the snapshot is taken
    await dock.open("title");
    await vi.waitFor(() => expect(dock.gate).toBe("in"));
    await vi.waitFor(() => expect(loadSeen(localStorage, wallet.accountId()!)?.scrip).toBe(50));
    expect(dock.root.querySelector(".dk-away")).toBe(null);
    dock.close();

    // while they're away, Moss ships copper; 10% of the export is the dividend, and they hold every share
    clock += 2 * 3_600_000;
    const ship = await mock.brokerExport("moss", "copper", 4, "Shelves can't take more.");
    expect(ship).toMatchObject({ ok: true, dividend: 14 });
    const scrip = (await mock.balances(wallet.accountId()!)).scrip;
    expect(scrip).toBe(64);

    await dock.open("title");
    await vi.waitFor(() => expect(dock.root.querySelector(".dk-away")).not.toBe(null));
    const card = dock.root.querySelector<HTMLElement>(".dk-away")!;
    expect(card.querySelector(".dk-away-h")!.textContent).toBe("While you were away");
    const rows = [...card.querySelectorAll(".dk-away-i")].map((r) => r.textContent);
    expect(rows).toEqual(["DividendMoss shipped to the freighter. Your dividend is in.+14 scrip"]);
    expect(dock.root.dataset.away).toBe("on");
    // Esc puts the slip away before it closes the Dockside
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "Escape", key: "Escape", bubbles: true }));
    expect(dock.root.dataset.away).toBeUndefined();
    expect(dock.isOpen).toBe(true);
    dock.close();

    // seen now: the next look is quiet
    await dock.open("title");
    await vi.waitFor(() => expect(dock.gate).toBe("in"));
    await new Promise((r) => setTimeout(r, 30));
    expect(dock.root.querySelector(".dk-away")).toBe(null);
  });

  it("doesn't count the player's own sale as scrip that came in while away, even when they leave before it settles", async () => {
    let clock = T0;
    const mock = createMockChain(7, { storage: null, now: () => clock });
    const wallet = createMockWallet(mock);
    await wallet.claim("WREN");
    // a run that made the boat, so there's cargo to sell
    const m = (await mock.startRun([])).manifest!;
    clock += 120_000;
    const box = m.containers[0];
    expect((await mock.extract(m.runId, [box.spot], [])).ok).toBe(true);
    const buyer = (["moss", "ines", "qm"] as const).find((b) => BROKERS[b].buys.includes(box.tokenId))!;
    const ui = document.createElement("div");
    document.body.append(ui);
    const G: GameLike = { events: { on: () => () => {}, emit: () => {} }, game: { state: "title", menus: { root: ui } } };
    const dock = createDockside(G, { chain: mock, wallet, manifest: null, carried: {} }, { host: ui });
    docks.push(dock);
    await dock.open("title");
    await vi.waitFor(() => expect(loadSeen(localStorage, wallet.accountId()!)?.scrip).toBe(150));
    // they sell one at the stall, and close the Dockside at once: the refresh after the sale is theirs
    const sell = () => dock.root.querySelector<HTMLButtonElement>(`.dk-stall[data-broker="${buyer}"] .dk-q[data-tok="${box.tokenId}"] [data-a="sell1"]`)!;
    await vi.waitFor(() => expect(sell().disabled).toBe(false));
    sell().click();
    dock.close();
    await vi.waitFor(() => expect(loadSeen(localStorage, wallet.accountId()!)!.scrip).toBeGreaterThan(150));
    await dock.open("title");
    await vi.waitFor(() => expect(dock.gate).toBe("in"));
    await new Promise((r) => setTimeout(r, 30));
    expect(dock.root.querySelector(".dk-away")).toBe(null);
  });
});
