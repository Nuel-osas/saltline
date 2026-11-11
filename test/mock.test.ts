import { describe, expect, it } from "vitest";
import { ITEMS, RULES } from "../src/economy/items";
import {
  MARKET,
  MOCK_STORAGE_KEY,
  type MockState,
  askPrice,
  batchBid,
  bidPrice,
  bidReason,
  createMockChain,
  createMockWallet,
} from "../src/economy/mock";
import type { Manifest, WreckView } from "../src/economy/types";

const T0 = 1_800_000_000_000;

function memStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => void m.set(k, String(v)),
  };
}

/** A registered player ("ROOK") on a fresh mock, optionally with the saved state edited before reload. */
async function setup(edit?: (s: MockState) => void, seed = 7) {
  let t = T0;
  const clock = { now: () => t, advance: (ms: number) => (t += ms) };
  const storage = memStorage();
  let chain = createMockChain(seed, { storage, now: clock.now });
  expect((await createMockWallet(chain).claim("rook")).ok).toBe(true);
  if (edit) {
    const s = chain.snapshot();
    edit(s);
    storage.setItem(MOCK_STORAGE_KEY, JSON.stringify(s));
    chain = createMockChain(seed, { storage, now: clock.now });
  }
  return { chain, clock, storage, me: chain.me() };
}

const weightOf = (m: Manifest, spots: number[]) =>
  spots.reduce((w, s) => {
    const c = m.containers.find((x) => x.spot === s)!;
    return w + c.amount * ITEMS[c.tokenId].weight;
  }, 0);

/** Containers in manifest order that fit under the carry limit. */
function fit(m: Manifest): number[] {
  const out: number[] = [];
  for (const c of m.containers) if (weightOf(m, [...out, c.spot]) <= RULES.carryLimit) out.push(c.spot);
  return out;
}

describe("pricing curves", () => {
  it("bids 2× base at zero stock, base at target and half base at 3× target", () => {
    expect(bidPrice("copper", 0, 100)).toBe(120);
    expect(bidPrice("copper", 12, 100)).toBe(60);
    expect(bidPrice("copper", 36, 100)).toBe(30);
    expect(bidPrice("core", 4, 100)).toBe(160);
  });
  it("stance scales the bid", () => {
    expect(bidPrice("copper", 12, 80)).toBe(48);
    expect(bidPrice("copper", 12, 120)).toBe(72);
  });
  it("asks rise 1% per recent unit sold", () => {
    expect(askPrice("plate", 0, 100)).toBe(80);
    expect(askPrice("plate", 10, 100)).toBe(88);
    expect(askPrice("plate", 10, 110)).toBe(96);
  });
  it("prices a batch one unit at a time, so a big dump gets less per unit", () => {
    const ten = batchBid("copper", 12, 100, 10);
    let sum = 0;
    for (let i = 0; i < 10; i++) sum += bidPrice("copper", 12 + i, 100);
    expect(ten).toBe(sum);
    expect(ten).toBeLessThan(10 * bidPrice("copper", 12, 100));
  });
  it("gives the reason in the dockside voice", () => {
    expect(bidReason({ name: "Moss", open: true, scrip: 1500, stance: 100 }, "copper", 34)).toBe(
      "Sitting on 34 coils against a target of 12. Paying half.",
    );
    expect(bidReason({ name: "Moss", open: true, scrip: 1500, stance: 100 }, "copper", 0)).toMatch(/Paying double\.$/);
    expect(bidReason({ name: "Moss", open: false, scrip: 120, stance: 100 }, "copper", 3)).toMatch(/^Shut/);
  });
});

describe("registration", () => {
  it("registers once, upper-cases the callsign and mints the starter scrip", async () => {
    const { chain, me } = await setup();
    expect((await chain.profile(me))?.callsign).toBe("ROOK");
    expect(await chain.balances(me)).toEqual({ scrip: RULES.starterScrip });
    const again = await createMockWallet(chain).claim("ROOK 2");
    expect(again).toMatchObject({ ok: false });
    expect((await chain.register(me, "OTHER")).code).toBe("E_ALREADY_REGISTERED");
    expect((await chain.register("someone.testnet", "rook")).code).toBe("E_CALLSIGN_TAKEN");
    expect((await chain.register("someone.testnet", "a*")).code).toBe("E_BAD_CALLSIGN");
  });
  it("the mock wallet is kind mock with an implicit-looking account", async () => {
    const chain = createMockChain(3, { storage: null });
    const w = createMockWallet(chain);
    expect(w.kind).toBe("mock");
    expect(w.accountId()).toMatch(/^[0-9a-f]{64}$/);
    expect(await w.registered()).toBe(false);
    expect((await w.claim("gannet")).ok).toBe(true);
    expect(await w.registered()).toBe(true);
  });
});

describe("a run's lifecycle", () => {
  it("starts with a manifest, refuses an early extract, then mints what was opened", async () => {
    const { chain, clock, me } = await setup();
    const start = await chain.startRun([]);
    expect(start.ok).toBe(true);
    const m = start.manifest!;
    expect(m.containers).toHaveLength(RULES.containersPerRun);
    expect(new Set(m.containers.map((c) => c.spot)).size).toBe(RULES.containersPerRun);
    expect(m.containers.every((c) => c.spot >= 0 && c.spot < RULES.spotCount)).toBe(true);

    const opened = fit(m);
    expect((await chain.extract(m.runId, opened, [])).code).toBe("E_TOO_SOON");
    clock.advance((RULES.minRunSeconds + RULES.perContainerSeconds * opened.length) * 1000);
    const out = await chain.extract(m.runId, opened, []);
    expect(out.ok).toBe(true);
    const expected: Record<string, number> = {};
    for (const s of opened) {
      const c = m.containers.find((x) => x.spot === s)!;
      expected[c.tokenId] = (expected[c.tokenId] ?? 0) + c.amount;
    }
    expect(out.minted).toEqual(expected);
    const bal = await chain.balances(me);
    for (const [k, v] of Object.entries(expected)) expect(bal[k as keyof typeof bal]).toBe(v);
    expect((await chain.profile(me))?.extractions).toBe(1);
    expect((await chain.extract(m.runId, opened, [])).code).toBe("E_RUN_CLOSED");
  });

  it("refuses what isn't in the manifest, duplicates, overweight hauls and someone else's run", async () => {
    const { chain, clock } = await setup();
    const m = (await chain.startRun([])).manifest!;
    clock.advance(10 * 60_000);
    const free = Array.from({ length: RULES.spotCount }, (_, i) => i).find((s) => !m.containers.some((c) => c.spot === s))!;
    expect((await chain.extract(m.runId, [free], [])).code).toBe("E_NOT_IN_MANIFEST");
    expect((await chain.extract(m.runId, [], [12345])).code).toBe("E_NOT_IN_MANIFEST");
    const s0 = m.containers[0].spot;
    expect((await chain.extract(m.runId, [s0, s0], [])).code).toBe("E_DUPLICATE");
    const all = m.containers.map((c) => c.spot);
    if (weightOf(m, all) > RULES.carryLimit) expect((await chain.extract(m.runId, all, [])).code).toBe("E_OVER_LIMIT");
    expect((await chain.extract(m.runId + 99, [], [])).code).toBe("E_NO_RUN");
    // A refused extract changes nothing: the run is still open.
    expect((await chain.extract(m.runId, fit(m), [])).ok).toBe(true);
  });

  it("refuses an unregistered player, a second run within 30 s and gear you don't hold; a new run abandons the old", async () => {
    const stranger = createMockChain(9, { storage: null });
    expect((await stranger.startRun([])).code).toBe("E_NOT_REGISTERED");

    const { chain, clock, me } = await setup((s) => {
      s.accounts[s.me].balances.scrip = 1000;
    });
    expect((await chain.startRun(["plate"])).code).toBe("E_NO_GEAR");
    expect((await chain.buy("ines", "plate", 1)).ok).toBe(true);
    expect((await chain.startRun(["plate", "plate"])).code).toBe("E_DUPLICATE");
    const first = (await chain.startRun(["plate"])).manifest!;
    expect((await chain.balances(me)).plate).toBeUndefined();
    expect((await chain.startRun([])).code).toBe("E_TOO_SOON");
    clock.advance(MARKET.betweenRunsMs);
    const second = (await chain.startRun([])).manifest!;
    clock.advance(10 * 60_000);
    expect((await chain.extract(first.runId, [], [])).code).toBe("E_RUN_CLOSED");
    expect((await chain.extract(second.runId, [], [])).ok).toBe(true);
  });

  it("dying leaves a wreck with your callsign; the yard keeps the newest 24", async () => {
    const old: WreckView[] = Array.from({ length: 24 }, (_, i) => ({
      id: 1000 + i,
      spot: i % 16,
      owner: "gull.mock",
      callsign: "GULL",
      items: [{ tokenId: "copper", amount: 1 }],
      at: T0 - i,
    }));
    const { chain, me } = await setup((s) => {
      s.wrecks = old;
      s.nextWreck = 2000;
    });
    const m = (await chain.startRun([])).manifest!;
    const opened = fit(m).slice(0, 2);
    const r = await chain.die(m.runId, opened, [], 5);
    expect(r.ok).toBe(true);
    const wrecks = await chain.wrecks();
    expect(wrecks).toHaveLength(MARKET.maxWrecks);
    expect(wrecks[0]).toMatchObject({ owner: me, callsign: "ROOK", spot: 5 });
    expect(wrecks.some((w) => w.id === 1023)).toBe(false);
    expect((await chain.profile(me))?.deaths).toBe(1);
    expect((await chain.recent(1))[0].kind).toBe("wreck");
  });
});

describe("wrecks: the 70/30 split", () => {
  const wreck: WreckView = {
    id: 77,
    spot: 3,
    owner: "gull.mock",
    callsign: "GULL",
    items: [
      { tokenId: "copper", amount: 3 },
      { tokenId: "core", amount: 1 },
    ],
    at: T0,
  };

  it("gives the finder 70% rounded half up and the owner the rest", async () => {
    const { chain, clock, me } = await setup((s) => {
      s.wrecks = [wreck];
      s.accounts["gull.mock"].balances = { scrip: 10 };
    });
    const m = (await chain.startRun([])).manifest!;
    expect(m.wrecks.map((w) => w.id)).toEqual([77]);
    clock.advance(RULES.minRunSeconds * 1000);
    const out = await chain.extract(m.runId, [], [77]);
    expect(out.ok).toBe(true);
    expect(out.minted).toEqual({ copper: 2, core: 1 });
    expect(await chain.balances("gull.mock")).toEqual({ scrip: 10, copper: 1 });
    expect((await chain.balances(me)).copper).toBe(2);
    expect(await chain.wrecks()).toEqual([]);
  });

  it.each([
    [1, 1, 0],
    [2, 1, 1],
    [3, 2, 1],
    [4, 3, 1],
    [5, 4, 1],
    [6, 4, 2],
  ])("a wreck of %i splits %i to the finder and %i to the owner", async (n, finder, owner) => {
    const w: WreckView = { ...wreck, id: 79, items: [{ tokenId: "copper", amount: n }] };
    const { chain, clock, me } = await setup((s) => {
      s.wrecks = [w];
      s.accounts["gull.mock"].balances = {};
    });
    const m = (await chain.startRun([])).manifest!;
    clock.advance(RULES.minRunSeconds * 1000);
    expect((await chain.extract(m.runId, [], [79])).ok).toBe(true);
    expect((await chain.balances(me)).copper ?? 0).toBe(finder);
    expect((await chain.balances("gull.mock")).copper ?? 0).toBe(owner);
  });

  it("recoverWreck: another crew hauls your wreck out by the same rules, and the ledger names you", async () => {
    const { chain, me } = await setup();
    const m = (await chain.startRun([])).manifest!;
    const opened = fit(m).slice(0, 1);
    const id = (await chain.die(m.runId, opened, [], 5)).wreckId!;
    const left = (await chain.wrecks()).find((w) => w.id === id)!;
    const before = await chain.balances(me);
    expect(chain.recoverWreck(id)).toBe(true);
    expect((await chain.wrecks()).some((w) => w.id === id)).toBe(false);
    const after = await chain.balances(me);
    for (const i of left.items) {
      const owner = i.amount - Math.floor((i.amount * 70 + 50) / 100);
      expect((after[i.tokenId] ?? 0) - (before[i.tokenId] ?? 0)).toBe(owner);
    }
    const line = (await chain.recent(5)).find((e) => e.kind === "extract")!;
    expect(line.account).not.toBe(me);
    expect(line.text).toContain("recovered ROOK's wreck");
    expect(chain.recoverWreck(id)).toBe(false); // it's gone
  });

  it("counts a wreck's whole weight against the carry limit", async () => {
    const heavy: WreckView = { ...wreck, id: 78, items: [{ tokenId: "fuel", amount: 4 }] };
    const { chain, clock } = await setup((s) => {
      s.wrecks = [heavy];
    });
    const m = (await chain.startRun([])).manifest!;
    clock.advance(RULES.minRunSeconds * 1000);
    expect((await chain.extract(m.runId, [], [78])).code).toBe("E_OVER_LIMIT");
  });
});

describe("selling, closing and reopening", () => {
  it("pays per unit at the bid, moves stock and the till, and explains the new price", async () => {
    const { chain, me } = await setup((s) => {
      s.accounts[s.me].balances.copper = 5;
    });
    const before = (await chain.brokers()).find((b) => b.id === "moss")!;
    expect(before.stock.copper).toBe(9); // seeded at 75% of target
    const r = await chain.sell("moss", "copper", 3);
    expect(r.ok).toBe(true);
    expect(r.paid).toBe(batchBid("copper", 9, 100, 3));
    const after = (await chain.brokers()).find((b) => b.id === "moss")!;
    expect(after.stock.copper).toBe(12);
    expect(after.scrip).toBe(MARKET.brokerSeedScrip - r.paid!);
    expect(after.bids.find((q) => q.tokenId === "copper")).toMatchObject({ price: 60, reason: "Holding 12 coils, right on target. Paying base." });
    expect(await chain.balances(me)).toEqual({ scrip: RULES.starterScrip + r.paid!, copper: 2 });
    expect((await chain.recent(1))[0]).toMatchObject({ kind: "sale", callsign: "ROOK" });
  });

  it("refuses cargo the broker doesn't buy and more than you hold", async () => {
    const { chain } = await setup((s) => {
      s.accounts[s.me].balances.copper = 1;
    });
    expect((await chain.sell("ines", "copper", 1)).code).toBe("E_DOESNT_BUY");
    expect((await chain.sell("moss", "copper", 2)).code).toBe("E_FUNDS");
    expect((await chain.sell("moss", "copper", 0)).code).toBe("E_BAD_AMOUNT");
  });

  it("refuses a sale that would take the till below the float, and shuts a broker that can't buy any more", async () => {
    const { chain } = await setup((s) => {
      s.accounts[s.me].balances.copper = 5;
      s.brokers.moss.scrip = 200;
    });
    // 68 + 65 would leave 67, under the float of 100.
    const big = await chain.sell("moss", "copper", 2);
    expect(big.code).toBe("E_BROKER_BROKE");
    expect((await chain.brokers())[0].scrip).toBe(200);
    // One coil leaves 132, which can't cover another unit of copper (65) or chips (88) above the float.
    expect((await chain.sell("moss", "copper", 1)).paid).toBe(68);
    const moss = (await chain.brokers())[0];
    expect(moss).toMatchObject({ open: false, scrip: 132 });
    expect(moss.bids[0].reason).toMatch(/^Shut until someone invests/);
    expect((await chain.recent(1))[0].kind).toBe("close");
    expect((await chain.sell("moss", "copper", 1)).code).toBe("E_BROKER_CLOSED");
    expect((await chain.buy("moss", "cutter", 1)).code).toBe("E_BROKER_CLOSED");
  });

  it("reopens when investors bring the till to 400, and records their shares", async () => {
    const { chain, me } = await setup((s) => {
      s.accounts[s.me].balances.scrip = 1000;
      s.brokers.moss.scrip = 132;
      s.brokers.moss.open = false;
    });
    const a = await chain.invest("moss", 150);
    expect(a).toMatchObject({ ok: true, shares: 150, reopened: false });
    expect((await chain.brokers())[0].open).toBe(false);
    const b = await chain.invest("moss", 150);
    expect(b).toMatchObject({ ok: true, reopened: true });
    const moss = (await chain.brokers())[0];
    expect(moss).toMatchObject({ open: true, scrip: 432 });
    expect(moss.shares).toEqual([{ accountId: me, callsign: "ROOK", shares: 300 }]);
    expect((await chain.recent(1))[0].kind).toBe("reopen");
    expect((await chain.invest("moss", 5000)).code).toBe("E_FUNDS");
  });
});

describe("gear asks with decaying recent sales", () => {
  it("rises with each unit sold and decays with a 6-hour half-life", async () => {
    const { chain, clock } = await setup((s) => {
      s.accounts[s.me].balances.scrip = 1000;
    });
    const r = await chain.buy("moss", "cutter", 2);
    expect(r.cost).toBe(askPrice("cutter", 0, 100) + askPrice("cutter", 1, 100));
    const ask = async () => (await chain.brokers())[0].asks.find((q) => q.tokenId === "cutter")!;
    expect((await ask()).price).toBe(askPrice("cutter", 2, 100));
    expect((await ask()).reason).toMatch(/^Sold 2 seal cutters in the last few hours\. Up 2%\./);
    clock.advance(MARKET.recentHalfLifeMs);
    expect((await ask()).price).toBe(askPrice("cutter", 1, 100));
    clock.advance(MARKET.recentHalfLifeMs * 4);
    expect((await ask()).price).toBe(ITEMS.cutter.base);
    expect((await chain.buy("moss", "plate", 1)).code).toBe("E_DOESNT_SELL");
  });
});

describe("exports and dividends", () => {
  it("mints the export price, pays 10% to shareholders pro rata, and allows one export per item per hour", async () => {
    const { chain, clock, me } = await setup((s) => {
      s.brokers.moss.stock.copper = 20;
      s.brokers.moss.shares = { [s.me]: 300, "gull.mock": 100 };
      s.accounts["gull.mock"].balances = {};
    });
    expect(chain.advice("moss")).toMatchObject({ action: "export", tokenId: "copper", amount: 8 });
    const r = await chain.brokerExport("moss", "copper", 8, "Shelves can't take more.");
    expect(r).toMatchObject({ ok: true, earned: 8 * ITEMS.copper.export!, dividend: 28 });
    expect((await chain.balances(me)).scrip).toBe(RULES.starterScrip + 21);
    expect(await chain.balances("gull.mock")).toEqual({ scrip: 7 });
    const moss = (await chain.brokers())[0];
    expect(moss).toMatchObject({ scrip: MARKET.brokerSeedScrip + 280 - 28, lastMemo: "Shelves can't take more." });
    expect(moss.stock.copper).toBe(12);
    expect((await chain.brokerExport("moss", "copper", 1, "again")).code).toBe("E_EXPORT_COOLDOWN");
    clock.advance(MARKET.exportCooldownMs);
    expect((await chain.brokerExport("moss", "copper", 13, "too much")).code).toBe("E_EXPORT_STOCK");
    expect((await chain.brokerStance("moss", 130, "greedy")).code).toBe("E_STANCE_RANGE");
    expect((await chain.brokerStance("moss", 110, "keen")).ok).toBe(true);
    expect((await chain.brokers())[0].bids[0].price).toBe(bidPrice("copper", 12, 110));
  });
});

describe("the player market", () => {
  it("escrows a listing, cancels it back, and settles a purchase between two accounts", async () => {
    const { chain, me } = await setup((s) => {
      s.accounts[s.me].balances.copper = 3;
      s.listings = [{ id: 50, seller: "gull.mock", callsign: "GULL", tokenId: "meds", amount: 2, price: 40, at: T0 }];
      s.nextListing = 51;
      s.accounts["gull.mock"].balances = {};
    });
    const l = await chain.list("copper", 2, 70);
    expect(l).toMatchObject({ ok: true, id: 51 });
    expect((await chain.balances(me)).copper).toBe(1);
    expect((await chain.listings()).map((x) => x.id)).toEqual([51, 50]);
    expect((await chain.cancelListing(50)).code).toBe("E_NO_LISTING");
    expect((await chain.cancelListing(51)).ok).toBe(true);
    expect((await chain.balances(me)).copper).toBe(3);

    expect((await chain.buyListing(50)).ok).toBe(true);
    expect(await chain.balances("gull.mock")).toEqual({ scrip: 80 });
    expect(await chain.balances(me)).toMatchObject({ scrip: RULES.starterScrip - 80, meds: 2 });
    expect(await chain.listings()).toEqual([]);
    expect((await chain.buyListing(50)).code).toBe("E_NO_LISTING");
    expect((await chain.list("scrip" as never, 1, 1)).code).toBe("E_BAD_AMOUNT");
  });

  it("ranks the leaderboard by net worth at current bids", async () => {
    const { chain } = await setup((s) => {
      s.accounts[s.me].balances.core = 3;
    });
    const lb = await chain.leaderboard();
    expect(lb.netWorth[0]).toMatchObject({ callsign: "ROOK" });
    expect(lb.netWorth[0].value).toBe(RULES.starterScrip + 3 * bidPrice("core", 3, 100));
  });
});

describe("simulate", () => {
  it("is deterministic for a seed, varies with the seed, and leaves the market untouched", async () => {
    const { chain } = await setup();
    const before = await chain.brokers();
    const a = await chain.simulate(72, 12, 42);
    const b = await chain.simulate(72, 12, 42);
    const c = await chain.simulate(72, 12, 43);
    expect(a).toHaveLength(72);
    expect(a.map((p) => p.hour)).toEqual(Array.from({ length: 72 }, (_, i) => i + 1));
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
    expect(await chain.brokers()).toEqual(before);
    expect(Object.keys(a[0].brokers).sort()).toEqual(["ines", "moss", "qm"]);
    expect(Object.keys(a[0].brokers.moss.bids).sort()).toEqual(["chips", "copper"]);
  });
  it("rejects out-of-range arguments as a view would", async () => {
    const { chain } = await setup();
    await expect(chain.simulate(169, 1, 1)).rejects.toThrow();
    await expect(chain.simulate(1, 31, 1)).rejects.toThrow();
    await expect(chain.simulate(1.5, 1, 1)).rejects.toThrow();
  });
});

describe("ambient play and persistence", () => {
  it("moves the market deterministically for a seed", async () => {
    const run = () => {
      const chain = createMockChain(11, { storage: null, now: () => T0 });
      chain.ambient(600);
      chain.ambient(600);
      return chain.snapshot();
    };
    const a = run();
    expect(a).toEqual(run());
    expect(a.recent.length).toBeGreaterThan(5);
    const kinds = new Set(a.recent.map((e) => e.kind));
    expect(kinds.has("sale") || kinds.has("extract")).toBe(true);
    const fresh = createMockChain(11, { storage: null, now: () => T0 }).snapshot();
    expect(a.brokers).not.toEqual(fresh.brokers);
  });

  it("keeps your cargo and your open run across a reload", async () => {
    const { chain, storage, clock, me } = await setup();
    const m = (await chain.startRun([])).manifest!;
    const reloaded = createMockChain(7, { storage, now: clock.now });
    expect(reloaded.me()).toBe(me);
    expect((await reloaded.profile(me))?.callsign).toBe("ROOK");
    expect(await reloaded.manifest(m.runId)).toEqual(m);
    clock.advance(10 * 60_000);
    expect((await reloaded.extract(m.runId, fit(m), [])).ok).toBe(true);
  });

  it("marks itself as the mock", () => {
    const chain = createMockChain(1, { storage: null });
    expect(chain.network).toBe("mock");
    expect(chain.txUrl("anything")).toBeNull();
  });
});
