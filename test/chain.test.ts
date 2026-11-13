import { FunctionCallError, NearError, NetworkError } from "near-kit";
import { describe, expect, it } from "vitest";
import {
  type CallSpec,
  type NearPort,
  type PreparedTx,
  type RawOutcome,
  createEventPoller,
  createTestnetChain,
  isMethodNotFound,
  METHOD_NOT_FOUND,
  parsePanic,
} from "../src/economy/chain";
import { TESTNET_EXPLORER_TX } from "../src/economy/config";
import type { LedgerEvent } from "../src/economy/types";

const HASH = "9ZQ7wq3gL8kRrRk3BvTzv7bJ5yR1zH2bWm4cQe6sXyAa";
const KEY = { accountId: "a".repeat(64), privateKey: "ed25519:stub" as const };
const ok = (value: unknown): RawOutcome => ({
  status: { SuccessValue: btoa(JSON.stringify(value)) },
  transaction: { hash: HASH },
});
const http503 = () => new NetworkError("HTTP 503: Service Unavailable", 503, true);
const panic = (text: string) => new FunctionCallError("saltline.testnet", "sell", `Smart contract panicked: ${text}`);

type Step = RawOutcome | Error | (() => Promise<RawOutcome>);

/** A prepared transaction that plays a script. `signs` is false for steps that fail before signing. */
class ScriptTx implements PreparedTx {
  signed = false;
  sends = 0;
  resends = 0;
  statuses = 0;
  constructor(
    private steps: Step[],
    private statusResult: RawOutcome | null | Error = null,
    private failsBeforeSigning = 0,
  ) {}
  hash() {
    return this.signed ? HASH : null;
  }
  private async next(): Promise<RawOutcome> {
    const s = this.steps.shift();
    if (!s) throw new Error("script ran out");
    if (s instanceof Error) throw s;
    if (typeof s === "function") return s();
    return s;
  }
  async send() {
    this.sends++;
    if (this.failsBeforeSigning > 0) {
      this.failsBeforeSigning--;
      return this.next();
    }
    this.signed = true;
    return this.next();
  }
  async resend() {
    this.resends++;
    return this.next();
  }
  async status() {
    this.statuses++;
    if (this.statusResult instanceof Error) throw this.statusResult;
    return this.statusResult;
  }
}

function setup(opts: { views?: Record<string, (args: object, attempt: number) => unknown>; txs?: ScriptTx[]; noKey?: boolean } = {}) {
  const specs: CallSpec[] = [];
  const viewCalls: { method: string; attempt: number }[] = [];
  const sleeps: number[] = [];
  const txs = opts.txs ?? [];
  const port: NearPort = {
    async view(_contract, method, args, attempt) {
      viewCalls.push({ method, attempt });
      const v = opts.views?.[method];
      if (!v) throw new Error(`no stub for ${method}`);
      return v(args, attempt);
    },
    async accountExists() {
      return true;
    },
    prepare(spec) {
      specs.push(spec);
      const tx = txs.shift();
      if (!tx) throw new Error("no scripted tx");
      return tx;
    },
  };
  const chain = createTestnetChain({
    config: { contractId: "saltline.testnet", rpcUrls: ["https://rpc.example"], explorerTxUrl: TESTNET_EXPLORER_TX },
    keys: () => (opts.noKey ? null : KEY),
    port,
    exec: { retries: 3, backoffMs: 10, sleep: async (ms) => void sleeps.push(ms) },
  });
  return { chain, specs, viewCalls, sleeps };
}

describe("views: wire mapping", () => {
  it("converts U128 strings to numbers and skips token ids it doesn't know", async () => {
    const { chain } = setup({ views: { balances: () => ({ scrip: "150", copper: "3", unobtainium: "9" }) } });
    expect(await chain.balances("x.testnet")).toEqual({ scrip: 150, copper: 3 });
  });

  it("rejects a U128 too large to hold exactly, and malformed amounts, instead of showing 0 or a rounded number", async () => {
    for (const bad of ["9007199254740993", "12.5", "-1", "", null, "0x10"]) {
      const { chain } = setup({ views: { balances: () => ({ scrip: bad }) } });
      await expect(chain.balances("x.testnet")).rejects.toThrow(/balances/);
    }
  });

  it("maps a broker from snake_case to camelCase", async () => {
    const wire = {
      id: "moss",
      account_id: "moss.saltline.testnet",
      name: "Moss",
      open: true,
      scrip: "1500",
      stance: 100,
      stock: { copper: "9", chips: "7" },
      bids: [{ token_id: "copper", price: "68", reason: "Holding 9 coils against a target of 12. Paying over base." }],
      asks: [{ token_id: "cutter", price: "65", reason: "List price." }],
      shares: [{ account_id: "rook.testnet", callsign: "ROOK", shares: "300" }],
      last_memo: null,
    };
    const { chain } = setup({ views: { brokers: () => [wire] } });
    expect(await chain.brokers()).toEqual([
      {
        id: "moss",
        accountId: "moss.saltline.testnet",
        name: "Moss",
        open: true,
        scrip: 1500,
        stance: 100,
        stock: { copper: 9, chips: 7 },
        bids: [{ tokenId: "copper", price: 68, reason: "Holding 9 coils against a target of 12. Paying over base." }],
        asks: [{ tokenId: "cutter", price: 65, reason: "List price." }],
        shares: [{ accountId: "rook.testnet", callsign: "ROOK", shares: 300 }],
        lastMemo: null,
      },
    ]);
  });

  it("maps profile, manifest, leaderboard and simulate; a missing profile stays null", async () => {
    const wreck = { id: 4, spot: 7, owner: "gull.testnet", callsign: "GULL", items: [{ token_id: "copper", amount: "2" }], at: 1700 };
    const { chain } = setup({
      views: {
        profile: (a) =>
          (a as { account_id: string }).account_id === "none.testnet"
            ? null
            : { account_id: "rook.testnet", callsign: "ROOK", registered_at: 1, runs: 2, extractions: 1, deaths: 1, best_haul: "240", active_run: 9 },
        manifest: () => ({ run_id: 9, started_at: 1000, containers: [{ spot: 3, token_id: "fuel", amount: "1" }], wrecks: [wreck] }),
        leaderboard: () => ({ net_worth: [{ account_id: "rook.testnet", callsign: "ROOK", value: "900" }], best_haul: [], investors: [] }),
        simulate: () => [
          {
            hour: 1,
            brokers: Object.fromEntries(["moss", "ines", "qm"].map((b) => [b, { open: true, scrip: "1500", bids: { copper: "60" }, stock: { copper: "12" } }])),
          },
        ],
        recent: () => [
          { kind: "sale", at: 5, account: "rook.testnet", callsign: "ROOK", text: "ROOK sold 3 coils to Moss for 141." },
          { kind: "something_new", at: 4, account: "x", text: "?" },
        ],
      },
    });
    expect(await chain.profile("none.testnet")).toBeNull();
    expect(await chain.profile("rook.testnet")).toMatchObject({ accountId: "rook.testnet", bestHaul: 240, registeredAt: 1, activeRun: 9 });
    expect(await chain.manifest(9)).toEqual({
      runId: 9,
      startedAt: 1000,
      containers: [{ spot: 3, tokenId: "fuel", amount: 1 }],
      wrecks: [{ id: 4, spot: 7, owner: "gull.testnet", callsign: "GULL", items: [{ tokenId: "copper", amount: 2 }], at: 1700 }],
    });
    expect((await chain.leaderboard()).netWorth).toEqual([{ accountId: "rook.testnet", callsign: "ROOK", value: 900 }]);
    expect((await chain.simulate(1, 1, 1))[0].brokers.qm).toEqual({ open: true, scrip: 1500, bids: { copper: 60 }, stock: { copper: 12 } });
    expect(await chain.recent(10)).toEqual([{ kind: "sale", at: 5, account: "rook.testnet", callsign: "ROOK", text: "ROOK sold 3 coils to Moss for 141." }]);
  });

  it("maps the town from snake_case and U128 strings, skipping a district it doesn't know", async () => {
    const wire = {
      act: 3,
      delivered: { meds: "17", fuel: "11", core: "12", copper: "40", unobtainium: "3" },
      districts: [
        { id: "clinic", token_id: "meds", need: "15", have: "17", lit: true, lit_at: 1700 },
        { id: "generators", token_id: "fuel", need: "10", have: "11", lit: true, lit_at: 1800 },
        { id: "cannery", token_id: "copper", need: "30", have: "40", lit: true, lit_at: 1900 },
      ],
      client: { need: "8", have: "12", revealed: true, revealed_at: 2000 },
      harbormaster: { strength: 62, recent_cores: "6200", bonus_drones: 2 },
    };
    const { chain } = setup({ views: { town: () => wire } });
    expect(await chain.town()).toEqual({
      act: 3,
      delivered: { meds: 17, fuel: 11, core: 12, copper: 40 },
      districts: [
        { id: "clinic", tokenId: "meds", need: 15, have: 17, lit: true, litAt: 1700 },
        { id: "generators", tokenId: "fuel", need: 10, have: 11, lit: true, litAt: 1800 },
      ],
      client: { need: 8, have: 12, revealed: true, revealedAt: 2000 },
      harbormaster: { strength: 62, recentCores: 6200, bonusDrones: 2 },
    });
    // Act I: optional times arrive as null
    const dark = setup({
      views: {
        town: () => ({
          ...wire,
          act: 1,
          districts: [{ id: "clinic", token_id: "meds", need: "15", have: "4", lit: false, lit_at: null }],
          client: { need: "8", have: "2", revealed: false, revealed_at: null },
          harbormaster: { strength: 0, recent_cores: "0", bonus_drones: 0 },
        }),
      },
    });
    const t = await dark.chain.town();
    expect(t.districts).toEqual([{ id: "clinic", tokenId: "meds", need: 15, have: 4, lit: false, litAt: null }]);
    expect(t.client).toEqual({ need: 8, have: 2, revealed: false, revealedAt: null });
  });

  it("rejects a town it can't read exactly, instead of showing an act or a strength it made up", async () => {
    const good = {
      act: 1,
      delivered: {},
      districts: [],
      client: { need: "8", have: "0", revealed: false, revealed_at: null },
      harbormaster: { strength: 0, recent_cores: "0", bonus_drones: 0 },
    };
    const bad: Record<string, unknown>[] = [
      { act: 4 },
      { act: "2" },
      { client: { need: "8", have: 1.5, revealed: false } },
      { harbormaster: { strength: 101, recent_cores: "0", bonus_drones: 0 } },
      { harbormaster: { strength: 50, recent_cores: "0", bonus_drones: 9 } },
      { districts: [{ id: "clinic", token_id: "meds", need: "15", have: "x", lit: false }] },
      { districts: [{ id: "clinic", token_id: "plate", need: "15", have: "1", lit: false }] },
    ];
    for (const b of bad) {
      const { chain } = setup({ views: { town: () => ({ ...good, ...b }) } });
      await expect(chain.town()).rejects.toThrow(/^town: /);
    }
  });

  it("rejects cleanly with METHOD_NOT_FOUND, without retrying, when the contract has no town view yet", async () => {
    // The text testnet RPCs answer with today (11 Nov 2026) for `town` on saltline.testnet, as near-kit wraps it.
    const missing = new FunctionCallError("saltline.testnet", "town", "wasm execution failed with error: MethodResolveError(MethodNotFound)");
    const { chain, viewCalls } = setup({
      views: {
        town: () => {
          throw missing;
        },
      },
    });
    const err = await chain.town().then(
      () => null,
      (e: Error & { code?: string; cause?: unknown }) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err!.code).toBe(METHOD_NOT_FOUND);
    expect(err!.message).toBe("town: the contract has no town view yet");
    expect(err!.cause).toBe(missing);
    expect(viewCalls).toHaveLength(1);
    // A node that sends it as a structured CONTRACT_EXECUTION_ERROR is read the same way.
    const structured = Object.assign(new Error("Contract execution failed: saltline.testnet.town"), {
      code: "CONTRACT_EXECUTION_ERROR",
      details: { vm_error: "MethodResolveError(MethodNotFound)" },
    });
    expect(isMethodNotFound(structured)).toBe(true);
    expect(isMethodNotFound(new FunctionCallError("saltline.testnet", "sell", "Smart contract panicked: E_FUNDS: Not enough"))).toBe(false);
    expect(isMethodNotFound(null)).toBe(false);
  });

  it("keeps the town's ledger lines: a district relit and the act moving on", async () => {
    const { chain } = setup({
      views: {
        recent: () => [
          { kind: "act", at: 9, account: "saltline.testnet", text: "The Quartermaster's client is the Harbormaster." },
          { kind: "district", at: 8, account: "saltline.testnet", text: "The clinic's lights are back on." },
        ],
      },
    });
    expect((await chain.recent(10)).map((e) => e.kind)).toEqual(["act", "district"]);
  });

  it("retries a view through transient failures, then rejects rather than returning a default", async () => {
    let n = 0;
    const flaky = setup({
      views: {
        balances: () => {
          if (n++ < 2) throw http503();
          return { scrip: "7" };
        },
      },
    });
    expect(await flaky.chain.balances("x.testnet")).toEqual({ scrip: 7 });
    expect(flaky.viewCalls.map((c) => c.attempt)).toEqual([0, 1, 2]);

    const down = setup({
      views: {
        balances: () => {
          throw http503();
        },
      },
    });
    await expect(down.chain.balances("x.testnet")).rejects.toThrow(/isn't answering/);
    expect(down.viewCalls).toHaveLength(4);
  });

  it("a view panic rejects with the contract's message, untried again", async () => {
    const { chain, viewCalls } = setup({
      views: {
        manifest: () => {
          throw new FunctionCallError("saltline.testnet", "manifest", 'wasm execution failed with error: HostError(GuestPanic { panic_msg: "E_NO_RUN: No such run" })');
        },
      },
    });
    await expect(chain.manifest(1)).rejects.toMatchObject({ message: "No such run", code: "E_NO_RUN" });
    expect(viewCalls).toHaveLength(1);
  });

  it("says the contract isn't deployed, as testnet answered on 11 Nov 2026 (saltline.testnet has no code yet)", async () => {
    const { chain } = setup({
      views: {
        profile: () => {
          throw new FunctionCallError(
            "saltline.testnet",
            "profile",
            'Contract call failed: saltline.testnet.profile - wasm execution failed with error: CompilationError(CodeDoesNotExist { account_id: "saltline.testnet" })',
          );
        },
      },
    });
    await expect(chain.profile("rook.testnet")).rejects.toThrow("The game contract isn't deployed yet.");
  });
});

describe("calls: wire format, errors and retries", () => {
  it("sends snake_case args with U128 strings and the documented gas, and decodes the reply", async () => {
    const { chain, specs } = setup({ txs: [new ScriptTx([ok({ paid: "141" })]), new ScriptTx([ok({ run_id: 3, started_at: 9, containers: [], wrecks: [] })])] });
    const r = await chain.sell("moss", "copper", 3);
    expect(r).toEqual({ ok: true, txHash: HASH, paid: 141 });
    expect(specs[0]).toMatchObject({ kind: "call", contractId: "saltline.testnet", method: "sell", args: { broker: "moss", token_id: "copper", amount: "3" }, gasTgas: 20, signerId: KEY.accountId });
    const run = await chain.startRun(["plate"]);
    expect(run.manifest).toEqual({ runId: 3, startedAt: 9, containers: [], wrecks: [] });
    expect(specs[1]).toMatchObject({ method: "start_run", args: { gear: ["plate"] }, gasTgas: 30 });
  });

  it("returns `E_CODE: message` panics as { ok: false, error: message } and never retries them", async () => {
    const tx = new ScriptTx([panic("E_BROKER_CLOSED: Moss is shut until someone invests")]);
    const { chain } = setup({ txs: [tx] });
    expect(await chain.sell("moss", "copper", 1)).toEqual({ ok: false, error: "Moss is shut until someone invests", code: "E_BROKER_CLOSED", txHash: HASH });
    expect(tx.sends + tx.resends).toBe(1);
  });

  it("retries a 503 by re-sending the identical signed transaction, with backoff", async () => {
    const tx = new ScriptTx([http503(), http503(), ok({ paid: "70" })]);
    const { chain, sleeps } = setup({ txs: [tx] });
    expect(await chain.sell("moss", "copper", 1)).toMatchObject({ ok: true, paid: 70, txHash: HASH });
    expect(tx.sends).toBe(1);
    expect(tx.resends).toBe(2);
    expect(sleeps).toHaveLength(2);
    expect(sleeps[1]).toBeGreaterThan(sleeps[0] - 10);
  });

  it("re-signs only while nothing has been signed yet", async () => {
    const tx = new ScriptTx([http503(), ok({ paid: "70" })], null, 1);
    const { chain } = setup({ txs: [tx] });
    expect((await chain.sell("moss", "copper", 1)).ok).toBe(true);
    expect(tx.sends).toBe(2);
    expect(tx.resends).toBe(0);
  });

  it("waits for a just-created account to reach the node, instead of refusing a new player's first call", async () => {
    const unseen = Object.assign(new Error("access key not found"), { code: "ACCESS_KEY_NOT_FOUND" });
    const tx = new ScriptTx([unseen, unseen, ok({ paid: "70" })], null, 2);
    const { chain, sleeps } = setup({ txs: [tx] });
    expect((await chain.sell("moss", "copper", 1)).ok).toBe(true);
    expect(tx.sends).toBe(3);
    expect(tx.resends).toBe(0);
    expect(sleeps.length).toBe(2);
  });

  it("still says there is no dock pass when the account never appears", async () => {
    const unseen = () => Object.assign(new Error("account not found"), { code: "ACCOUNT_NOT_FOUND" });
    const tx = new ScriptTx([unseen(), unseen(), unseen(), unseen()], null, 4);
    const { chain } = setup({ txs: [tx] });
    const r = await chain.sell("moss", "copper", 1);
    expect(r.ok).toBe(false);
    expect(r.pending).toBeUndefined();
    expect(r.error).toMatch(/dock pass/i);
  });

  it("stops at an executed failure that follows a transient one", async () => {
    const tx = new ScriptTx([http503(), panic("E_FUNDS: You've only got 1 coil.")]);
    const { chain } = setup({ txs: [tx] });
    expect(await chain.sell("moss", "copper", 2)).toMatchObject({ ok: false, code: "E_FUNDS", error: "You've only got 1 coil." });
    expect(tx.sends + tx.resends).toBe(2);
  });

  it("reports pending, not failed, when a signed transaction can't be confirmed", async () => {
    const tx = new ScriptTx([http503(), http503(), http503(), http503()], null);
    const { chain } = setup({ txs: [tx] });
    const r = await chain.sell("moss", "copper", 1);
    expect(r).toMatchObject({ ok: false, pending: true, txHash: HASH });
    expect(tx.statuses).toBe(1);
  });

  it("looks the transaction up by hash when a re-send is refused for its nonce", async () => {
    const nonce = new NearError("Invalid transaction nonce", "INVALID_NONCE");
    const tx = new ScriptTx([http503(), nonce], ok({ paid: "70" }));
    const { chain } = setup({ txs: [tx] });
    expect(await chain.sell("moss", "copper", 1)).toMatchObject({ ok: true, paid: 70 });
    expect(tx.statuses).toBe(1);
  });

  it("serialises calls through one queue", async () => {
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const first = new ScriptTx([
      async () => {
        order.push("first:start");
        await gate;
        order.push("first:end");
        return ok({ paid: "1" });
      },
    ]);
    const second = new ScriptTx([
      async () => {
        order.push("second:start");
        return ok({ paid: "2" });
      },
    ]);
    const { chain } = setup({ txs: [first, second] });
    const a = chain.sell("moss", "copper", 1);
    const b = chain.sell("moss", "chips", 1);
    await new Promise((r) => setTimeout(r, 5));
    expect(order).toEqual(["first:start"]);
    expect(chain.queued()).toBe(2);
    release();
    expect((await a).paid).toBe(1);
    expect((await b).paid).toBe(2);
    expect(order).toEqual(["first:start", "first:end", "second:start"]);
    expect(chain.queued()).toBe(0);
  });

  it("a failed call doesn't jam the queue", async () => {
    const { chain } = setup({ txs: [new ScriptTx([new Error("boom")]), new ScriptTx([ok({ paid: "5" })])] });
    expect((await chain.sell("moss", "copper", 1)).ok).toBe(false);
    expect((await chain.sell("moss", "copper", 1)).paid).toBe(5);
  });

  it("refuses bad amounts and a missing wallet without touching the chain", async () => {
    const { chain, specs } = setup();
    expect(await chain.sell("moss", "copper", 0)).toMatchObject({ ok: false, code: "E_BAD_AMOUNT" });
    expect(await chain.invest("moss", 1.5)).toMatchObject({ ok: false, code: "E_BAD_AMOUNT" });
    expect(specs).toHaveLength(0);
    const nokey = setup({ noKey: true });
    expect((await nokey.chain.sell("moss", "copper", 1)).ok).toBe(false);
  });

  it("links transactions to the testnet explorer", () => {
    const { chain } = setup();
    expect(chain.txUrl(HASH)).toBe(`https://testnet.nearblocks.io/txns/${HASH}`);
    expect(chain.txUrl("not a hash")).toBeNull();
    expect(chain.network).toBe("testnet");
  });
});

describe("parsePanic", () => {
  it("finds the code however the node wrapped it, keeping the message whole", () => {
    expect(parsePanic('FunctionCallError(ExecutionError("Smart contract panicked: E_TOO_SOON: wait (12 s)"))')).toEqual({ code: "E_TOO_SOON", message: "wait (12 s)" });
    expect(parsePanic("Smart contract panicked: E_OVER_LIMIT")).toEqual({ code: "E_OVER_LIMIT", message: "Over the carry limit" });
    expect(parsePanic("Exceeded the prepaid gas.")).toBeNull();
  });
});

describe("event poller", () => {
  it("delivers the window first, then only what's new, and keeps the window through a failure", async () => {
    const e = (at: number, text: string): LedgerEvent => ({ kind: "sale", at, account: "a", text });
    const feeds: (LedgerEvent[] | Error)[] = [[e(2, "b"), e(1, "a")], [e(3, "c"), e(2, "b"), e(1, "a")], new Error("rpc down")];
    const timers: (() => void)[] = [];
    const poller = createEventPoller(
      {
        recent: async () => {
          const f = feeds.shift()!;
          if (f instanceof Error) throw f;
          return f;
        },
      },
      { setTimer: (fn) => timers.push(fn), clearTimer: () => undefined },
    );
    const got: string[][] = [];
    const off = poller.subscribe((fresh) => got.push(fresh.map((x) => x.text)));
    await poller.poll();
    await poller.poll();
    await poller.poll();
    expect(got).toEqual([["b", "a"], ["c"]]);
    expect(poller.stale).toBe(true);
    expect(poller.latest().map((x) => x.text)).toEqual(["c", "b", "a"]);
    off();
  });
});
