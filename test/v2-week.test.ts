// @vitest-environment happy-dom
// The fast-forward (dock/week.ts): a week of the offline port in a minute, sampled through the same views the dock
// reads. The economy underneath is the real offline port (mock.ts), not a stand-in, so these check that it moves.
import { afterEach, describe, expect, it } from "vitest";
import { type WeekSample, PRICED, canFastForward, runWeek, sampleNow, weekPanel, weekSummary } from "../src/economy/v2/dock/week";
import { MOCK2_WARMUP_SECONDS, createMockChain2 } from "../src/economy/v2/mock";
import type { Chain2 } from "../src/economy/v2/types";

/** A test that plays a simulated week: about 5 s on an idle laptop, so the 5 s default fails it on a busy or slower one. */
const LONG = 30_000;

const T0 = 1_800_000_000_000;
const port = (seed = 7) => createMockChain2(seed, { storage: null, now: () => T0, warmupSeconds: MOCK2_WARMUP_SECONDS });
const noSleep = async () => {};

describe("runWeek", () => {
  it("plays the port an hour at a time and reads it after each", async () => {
    const chain = port();
    const before = chain.now();
    const seen: number[] = [];
    const samples = await runWeek(chain, { hours: 48, sleep: noSleep, onSample: (_s, hour) => seen.push(hour) });
    expect(samples).toHaveLength(49);
    expect(seen).toEqual(Array.from({ length: 49 }, (_, i) => i));
    expect(samples.every((s) => s !== null)).toBe(true);
    expect(samples.map((s) => s!.hour)).toEqual(seen);
    expect(chain.now() - before).toBe(48 * 3_600_000);
  }, LONG); // 48 simulated hours

  it("the economy moves on its own: prices, wallets or guns change across a week", async () => {
    const chain = port(11);
    const samples = (await runWeek(chain, { hours: 168, sleep: noSleep })).filter((s): s is WeekSample => !!s);
    expect(samples).toHaveLength(169);
    const distinct = (pick: (s: WeekSample) => unknown) => new Set(samples.map((s) => JSON.stringify(pick(s)))).size;
    expect(distinct((s) => s.bids)).toBeGreaterThan(1); // what the vendors pay changed
    expect(distinct((s) => [s.moss, s.ines])).toBeGreaterThan(1); // their money moved
    expect(distinct((s) => s.harbormaster)).toBeGreaterThan(1); // the Harbormaster's wallet filled or halved
    for (const s of samples) {
      for (const v of [s.moss, s.ines, s.harbormaster, s.supply, s.gunsBuilt, s.gunsDestroyed]) expect(Number.isFinite(v) && v >= 0).toBe(true);
      for (const id of Object.keys(s.bids)) expect(PRICED).toContain(id);
    }
    const sum = weekSummary(samples)!;
    expect(sum.hours).toBe(168);
    expect(sum.gunsBuilt).toBeGreaterThanOrEqual(0);
    expect(sum.shutHours).toBeGreaterThanOrEqual(0);
  }, LONG); // 168 simulated hours

  it("stops when asked", async () => {
    const chain = port();
    const signal = { aborted: false };
    const samples = await runWeek(chain, { hours: 168, sleep: noSleep, signal, onSample: (_s, hour) => hour === 5 && (signal.aborted = true) });
    expect(samples).toHaveLength(6);
  });

  it("a reading that fails is a gap, never a row of zeros", async () => {
    const chain = port();
    const broken = Object.assign(Object.create(chain), { economy: async () => Promise.reject(new Error("rpc down")) }) as Chain2;
    expect(await sampleNow(broken, 3)).toBeNull();
    expect(await sampleNow(chain, 3)).toMatchObject({ hour: 3 });
    expect(weekSummary([null, null])).toBeNull();
  });

  it("only the offline port can be fast-forwarded", () => {
    expect(canFastForward(port())).toBe(true);
    expect(canFastForward({ network: "testnet" } as unknown as Chain2)).toBe(false);
    expect(canFastForward({ network: "mock" } as unknown as Chain2)).toBe(false); // says it is, but has no clock to move
  });
});

describe("the panel in the Ledger", () => {
  afterEach(() => (document.body.innerHTML = ""));
  const ctxFor = (chain: Chain2) => ({ chain, refresh: async () => {} }) as never;

  it("on the chain it points at Practice, because the chain's clock can't be moved", () => {
    const { el } = weekPanel(ctxFor({ network: "testnet" } as unknown as Chain2));
    expect(el.querySelector("button")).toBeNull();
    expect(el.textContent).toContain("runs in Practice");
    expect(el.querySelector("a")!.getAttribute("href")).toContain("mock=1");
  });

  it("in Practice one button plays the week and draws both charts with a labelled line each", async () => {
    const { el } = weekPanel(ctxFor(port(5)), { hours: 24, sleep: noSleep });
    document.body.append(el);
    const go = el.querySelector<HTMLButtonElement>("button")!;
    expect(go.textContent).toBe("Fast-forward a week");
    go.click();
    for (let i = 0; i < 400 && go.textContent !== "Run another week"; i++) await new Promise((r) => setTimeout(r, 5));
    expect(go.textContent).toBe("Run another week");
    const charts = [...el.querySelectorAll(".d2-week-chart")];
    expect(charts).toHaveLength(2);
    expect(charts[0].querySelectorAll(".d2-week-legend li")).toHaveLength(PRICED.length);
    expect(charts[1].querySelectorAll(".d2-week-legend li")).toHaveLength(3);
    expect(el.querySelectorAll("path.d2-week-line").length).toBeGreaterThanOrEqual(3);
    expect(el.querySelector(".d2-week-status")!.textContent).toMatch(/A week later \(24 hours\): scrip in existence [+−][\d,]+, [\d,]+ guns built/);
  });
});
