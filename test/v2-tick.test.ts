// POST /api/tick?game=v2 (server/tick.ts) and the game's own v2 tick (src/economy/v2/tick.ts): the v2 round runs at
// v1's pace on a clock of its own, answers 503 without a v2 key, never leaks a key, and leaves v1's path as it was
// (test/tick.test.ts still covers that path unchanged).
import { generateKey } from "near-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Line2 } from "../agents/v2/run";
import { TICK_EVERY_MS, handleTick, resetTick } from "../server/tick";
import { startTicksV2, tickUrlV2 } from "../src/economy/v2/tick";

const KEYS = { moss: generateKey().secretKey, harbormaster: generateKey().secretKey };

afterEach(() => resetTick());

describe("POST /api/tick?game=v2", () => {
  const post = (q = "?game=v2") => new Request(`http://x/api/tick${q}`, { method: "POST" });
  const ENV2 = { HARBORMASTER_KEY: KEYS.harbormaster, BROKER_MOSS_KEY: KEYS.moss, NEAR_NETWORK: "testnet" };
  const lines2: Line2[] = [
    { who: "moss", status: "sent", action: "build pilot", memo: `Built one. ${KEYS.moss}`, txHash: "ABC" },
    { who: "harbormaster", status: "held", action: "hold", note: KEYS.harbormaster },
  ];

  it("runs a v2 round, then waits 10 minutes, on a clock of its own", async () => {
    let t = 5_000_000;
    const roundV2 = vi.fn(async () => lines2);
    const round = vi.fn(async () => [{ broker: "qm" as const, status: "held" as const, action: "hold" }]);
    const deps = { now: () => t, round, roundV2, log: () => {} };
    const env = { ...ENV2, BROKER_QM_KEY: generateKey().secretKey };
    const first = await (await handleTick(post(), env, deps)).json();
    expect(first).toMatchObject({ ok: true, ran: true });
    expect(first.lines.map((l: { broker: string; action: string }) => `${l.broker} ${l.action}`)).toEqual(["moss build pilot", "harbormaster hold"]);
    expect(roundV2).toHaveBeenCalledTimes(1);
    expect(round).not.toHaveBeenCalled();
    // v1's round is not held back by v2's, and runs v1's runner.
    expect(await (await handleTick(post(""), env, deps)).json()).toMatchObject({ ran: true, lines: [{ broker: "qm" }] });
    expect(round).toHaveBeenCalledTimes(1);
    t += TICK_EVERY_MS - 1;
    expect(await (await handleTick(post(), env, deps)).json()).toMatchObject({ ran: false });
    expect(await (await handleTick(post(""), env, deps)).json()).toMatchObject({ ran: false });
    t += 1;
    expect(await (await handleTick(post(), env, deps)).json()).toMatchObject({ ran: true });
    expect(roundV2).toHaveBeenCalledTimes(2);
    expect(round).toHaveBeenCalledTimes(1);
  });

  it("is 503 when no v2 key is set, and runs nothing", async () => {
    const roundV2 = vi.fn(async () => lines2);
    const r = await handleTick(post(), { BROKER_QM_KEY: KEYS.moss, CONTRACT_ID_V2: "v2.saltline.testnet" }, { roundV2 });
    expect(r.status).toBe(503);
    expect(roundV2).not.toHaveBeenCalled();
    // …while v1, which has a key there, still runs.
    expect((await handleTick(post(""), { BROKER_QM_KEY: KEYS.moss }, { round: async () => [], log: () => {} })).status).toBe(200);
    // And v1 is still 503 when only the Harbormaster's key is set.
    expect((await handleTick(post(""), { HARBORMASTER_KEY: KEYS.harbormaster }, { round: async () => [] })).status).toBe(503);
  });

  it("never puts a key in a response or a log, and answers 502 when the round fails", async () => {
    const logged: string[] = [];
    const body = await (await handleTick(post(), ENV2, { roundV2: async () => lines2, log: (l) => logged.push(l) })).text();
    resetTick();
    const failed = await handleTick(post(), ENV2, { roundV2: async () => Promise.reject(new Error(`boom ${KEYS.harbormaster}`)), log: (l) => logged.push(l) });
    expect(failed.status).toBe(502);
    for (const k of [KEYS.moss, KEYS.harbormaster]) {
      expect(body).not.toContain(k);
      expect(await failed.clone().text()).not.toContain(k);
      expect(logged.join("\n")).not.toContain(k);
    }
    expect(logged[0]).toContain("[tick v2]");
  });

  it("only answers POST", async () => {
    expect((await handleTick(new Request("http://x/api/tick?game=v2"), ENV2, { roundV2: async () => lines2 })).status).toBe(405);
  });
});

describe("the game's v2 tick", () => {
  it("posts to /api/tick?game=v2 beside the faucet, on a record apart from v1's", () => {
    expect(tickUrlV2("/api/faucet")).toBe("/api/tick?game=v2");
    const store = new Map<string, string>([["saltline.tick.v1", "1000"]]); // v1 ticked a second ago
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    const fetch = vi.fn(async () => new Response("{}"));
    const handlers: ((e: unknown) => void)[] = [];
    let t = 2000;
    startTicksV2("/api/faucet", { on: (_n, fn) => handlers.push(fn) }, { fetch: fetch as never, now: () => t, storage });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith("/api/tick?game=v2", expect.objectContaining({ method: "POST" }));
    expect(store.get("saltline.tick.v1")).toBe("1000");
    handlers[0]({ state: "dead" });
    expect(fetch).toHaveBeenCalledTimes(1); // within its own 10 minutes
    t += 10 * 60_000;
    handlers[0]({ state: "complete" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
