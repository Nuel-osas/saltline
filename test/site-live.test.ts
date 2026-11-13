// The front page's read-only chain reads (src/site/live.ts) and the two-page layout (index.html, play/index.html).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type Fetcher, ago, amount, bestBid, fmt, meterValue, read, toMs, viewCall } from "../src/site/live";

const bytes = (v: unknown) => [...new TextEncoder().encode(JSON.stringify(v))];
const ok = (v: unknown): Response => new Response(JSON.stringify({ jsonrpc: "2.0", id: "x", result: { result: bytes(v) } }), { status: 200 });

describe("viewCall", () => {
  it("asks the contract's view and decodes its JSON", async () => {
    const seen: { url: string; body: any }[] = [];
    const fetcher: Fetcher = async (url, init) => {
      seen.push({ url, body: JSON.parse(String(init.body)) });
      return ok({ players: 7, scrip_supply: "4132" });
    };
    const out = await viewCall<{ players: number; scrip_supply: string }>(["https://rpc.one"], "v2.saltline.testnet", "recent", { limit: 8 }, fetcher);
    expect(out).toEqual({ players: 7, scrip_supply: "4132" });
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe("https://rpc.one");
    expect(seen[0].body.method).toBe("query");
    expect(seen[0].body.params).toMatchObject({ request_type: "call_function", account_id: "v2.saltline.testnet", method_name: "recent" });
    expect(JSON.parse(atob(seen[0].body.params.args_base64))).toEqual({ limit: 8 });
  });

  it("moves to the next RPC when one fails", async () => {
    const asked: string[] = [];
    const fetcher: Fetcher = async (url) => {
      asked.push(url);
      if (url.includes("one")) throw new Error("down");
      if (url.includes("two")) return new Response("busy", { status: 503 });
      return ok([1, 2, 3]);
    };
    expect(await viewCall(["https://one", "https://two", "https://three"], "c.testnet", "m", {}, fetcher)).toEqual([1, 2, 3]);
    expect(asked).toEqual(["https://one", "https://two", "https://three"]);
  });

  it("throws when no RPC answers with a result, and never invents one", async () => {
    const noResult: Fetcher = async () => new Response(JSON.stringify({ result: { error: "wasm execution failed" } }), { status: 200 });
    await expect(viewCall(["https://one"], "c.testnet", "m", {}, noResult)).rejects.toThrow("wasm execution failed");
    const garbage: Fetcher = async () => new Response(JSON.stringify({ result: { result: [110, 111] } }), { status: 200 }); // "no": not JSON
    await expect(viewCall(["https://one"], "c.testnet", "m", {}, garbage)).rejects.toThrow();
    await expect(viewCall([], "c.testnet", "m")).rejects.toThrow("No RPC to ask");
  });

  it("read() turns a failure into null: unknown, never zero", async () => {
    const down: Fetcher = async () => {
      throw new Error("offline");
    };
    expect(await read(["https://one"], "c.testnet", "economy", {}, down)).toBeNull();
    expect(await read(["https://one"], "c.testnet", "economy", {}, async () => ok({ players: 0 }))).toEqual({ players: 0 });
  });
});

describe("amounts and words", () => {
  it("amount() takes a U128 string or a whole number, and nothing else", () => {
    expect(amount("4132")).toBe(4132n);
    expect(amount("340282366920938463463374607431768211455")).toBe(340282366920938463463374607431768211455n);
    expect(amount(12)).toBe(12n);
    for (const bad of ["", "-1", "1.5", "1e3", " 7", "0x10", null, undefined, -1, 1.5, Number.NaN, {}, "1".repeat(40)]) expect(amount(bad)).toBeNull();
  });

  it("fmt() groups thousands and says unknown for null", () => {
    expect(fmt(0n)).toBe("0");
    expect(fmt(999n)).toBe("999");
    expect(fmt(4132n)).toBe("4,132");
    expect(fmt(1234567n)).toBe("1,234,567");
    expect(fmt(null)).toBe("unknown");
  });

  it("bestBid() is the highest price that parses", () => {
    const bids = [
      { token_id: "copper", price: "59", reason: "a" },
      { token_id: "core", price: "200", reason: "b" },
      { token_id: "chips", price: "nonsense", reason: "c" },
    ];
    expect(bestBid(bids)?.token_id).toBe("core");
    expect(bestBid([])).toBeNull();
    expect(bestBid(undefined)).toBeNull();
    expect(bestBid([{ token_id: "x", price: "?", reason: "" }])).toBeNull();
  });

  it("toMs() and ago() read the contract's milliseconds, and nanoseconds too", () => {
    const now = 1_794_600_000_000;
    expect(toMs(now)).toBe(now);
    expect(toMs(String(now * 1e6))).toBe(now);
    expect(toMs(0)).toBeNull();
    expect(toMs("soon")).toBeNull();
    expect(ago(now - 20_000, now)).toBe("now");
    expect(ago(now - 12 * 60_000, now)).toBe("12 min ago");
    expect(ago(now - 5 * 3_600_000, now)).toBe("5 h ago");
    expect(ago(now - 3 * 86_400_000, now)).toBe("3 d ago");
    expect(ago(now + 10 * 60_000, now)).toBe(""); // a time ahead of this clock isn't described
    expect(ago("soon", now)).toBe("");
  });

  it("meterValue() runs from 0 to the maximum in steps of 5", () => {
    expect(meterValue(0, 4000)).toBe(0);
    expect(meterValue(1, 4000)).toBe(4000);
    expect(meterValue(0.3001, 4000)).toBe(1200);
    expect(meterValue(-1, 4000)).toBe(0);
    expect(meterValue(7, 4000)).toBe(4000);
    expect(meterValue(Number.NaN, 4000)).toBe(0);
    for (const p of [0.07, 0.31, 0.777]) expect(meterValue(p, 4000) % 5).toBe(0);
  });
});

describe("the two pages", () => {
  const front = readFileSync("index.html", "utf8");
  const game = readFileSync("play/index.html", "utf8");
  const vite = readFileSync("vite.config.js", "utf8");

  it("the front page loads the landing script and every Play link opens the v2 game under play/", () => {
    expect(front).toContain('src="/src/site/landing.ts"');
    expect(front).not.toContain("/src/game.js");
    const plays = [...front.matchAll(/href="(play\/[^"]*)"/g)].map((m) => m[1]);
    expect(plays.length).toBeGreaterThanOrEqual(4);
    for (const href of plays) expect(href.startsWith("play/?game=v2")).toBe(true);
  });

  it("the game page still boots the game, and both pages are built", () => {
    expect(game).toContain('src="/src/game.js"');
    expect(game).toContain('src="/src/economy/main.ts"');
    expect(vite).toContain('main: "index.html"');
    expect(vite).toContain('play: "play/index.html"');
  });

  it("an old link that names a game option is sent on to the game", () => {
    const re = /if \((\/.+\/)\.test\(location\.search\)\)/.exec(front);
    expect(re).not.toBeNull();
    const pattern = new RegExp(re![1].slice(1, -1));
    for (const q of ["?game=v2", "?mock=1&stash=rich", "?noeconomy=1&noaudio=1", "?x=1&game=v1", "?intro=1"]) expect(pattern.test(q)).toBe(true);
    for (const q of ["", "?ref=x", "?utm_source=game", "?gamer=1"]) expect(pattern.test(q)).toBe(false);
  });
});
