import { generateKey } from "near-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Line } from "../agents/brokers";
import { TICK_EVERY_MS, handleTick, resetTick } from "../server/tick";
import { shouldTick, startTicks, tickUrl } from "../src/economy/tick";

const KEY = generateKey().secretKey;
const ENV = { BROKER_QM_KEY: KEY, CONTRACT_ID: "saltline.testnet", NEAR_NETWORK: "testnet" };
const post = () => new Request("http://x/api/tick", { method: "POST" });
const lines: Line[] = [
  { broker: "moss", status: "held", action: "hold", memo: "Kettle's on." },
  { broker: "qm", status: "sent", action: "stance 115", memo: `Paying up. ${KEY}`, txHash: "ABC" },
];

afterEach(() => resetTick());

describe("POST /api/tick", () => {
  it("only answers POST", async () => {
    expect((await handleTick(new Request("http://x/api/tick"), ENV, { round: async () => lines })).status).toBe(405);
  });

  it("is off shift (503) with no broker keys, and runs nothing", async () => {
    const round = vi.fn(async () => lines);
    const r = await handleTick(post(), { CONTRACT_ID: "saltline.testnet" }, { round });
    expect(r.status).toBe(503);
    expect(round).not.toHaveBeenCalled();
  });

  it("runs one round, then waits 10 minutes before the next", async () => {
    let t = 1_000_000;
    const round = vi.fn(async () => lines);
    const deps = { now: () => t, round, log: () => {} };
    const first = await (await handleTick(post(), ENV, deps)).json();
    expect(first).toMatchObject({ ok: true, ran: true });
    expect(first.lines.map((l: { broker: string }) => l.broker)).toEqual(["moss", "qm"]);
    t += TICK_EVERY_MS - 1;
    expect(await (await handleTick(post(), ENV, deps)).json()).toMatchObject({ ran: false });
    t += 1;
    expect(await (await handleTick(post(), ENV, deps)).json()).toMatchObject({ ran: true });
    expect(round).toHaveBeenCalledTimes(2);
  });

  it("never puts a broker key in a response or a log", async () => {
    const logged: string[] = [];
    const r = await handleTick(post(), ENV, { round: async () => lines, log: (l) => logged.push(l) });
    const body = await r.text();
    expect(body).not.toContain(KEY);
    expect(logged.join("\n")).not.toContain(KEY);
  });

  it("answers 502 when the round itself fails, and doesn't leak the error's secrets", async () => {
    const r = await handleTick(post(), ENV, { round: async () => Promise.reject(new Error(`boom ${KEY}`)), log: () => {} });
    expect(r.status).toBe(502);
    expect(await r.text()).not.toContain(KEY);
  });
});

describe("the game's tick", () => {
  it("points at /api/tick next to the faucet", () => {
    expect(tickUrl("/api/faucet")).toBe("/api/tick");
    expect(tickUrl("https://saltline-lac.vercel.app/api/faucet")).toBe("https://saltline-lac.vercel.app/api/tick");
  });

  it("ticks at most once every 10 minutes per browser", () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    expect(shouldTick(1_000_000, storage)).toBe(true);
    expect(shouldTick(1_000_000 + 9 * 60_000, storage)).toBe(false);
    expect(shouldTick(1_000_000 + 10 * 60_000, storage)).toBe(true);
  });

  it("ticks at boot and when a run ends, never mid-run", () => {
    const fetch = vi.fn(async () => new Response("{}"));
    const handlers: ((e: unknown) => void)[] = [];
    let t = 0;
    startTicks("/api/tick", { on: (_n, fn) => handlers.push(fn) }, { fetch: fetch as never, now: () => t, storage: { getItem: () => null, setItem: () => {} } });
    expect(fetch).toHaveBeenCalledTimes(1);
    t = 1;
    handlers[0]({ state: "playing" });
    expect(fetch).toHaveBeenCalledTimes(1);
    handlers[0]({ state: "complete" });
    handlers[0]({ state: "dead" });
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});
