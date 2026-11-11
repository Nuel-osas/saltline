// The broker agents (agents/): the characters' decisions, failing closed, refusals, keys, memos, dry runs and the
// LLM voice. Everything runs against a stub NearPort, so no test touches a network or signs a real transaction.
import { FunctionCallError, NetworkError, generateKey } from "near-kit";
import { describe, expect, it, vi } from "vitest";
import {
  Bench,
  type BrokerKey,
  type KeyLookup,
  type Line,
  NEAR_AI_BASE_URL,
  type RoundDeps,
  type VoiceConfig,
  acceptRewrite,
  createBoard,
  exitCode,
  findKey,
  formatLine,
  main,
  parseArgs,
  redact,
  runRound,
} from "../agents/brokers";
import {
  type Advice,
  type Decision,
  MEMO_MAX,
  type Why,
  decide,
  fill,
  memoFor,
  templatesFor,
} from "../agents/characters";
import type { CallSpec, NearPort, PreparedTx, RawOutcome } from "../src/economy/chain";
import type { BrokerId, BrokerView, CargoId } from "../src/economy/types";

const CONTRACT = "saltline.testnet";
const HASH = "9ZQ7wq3gL8kRrRk3BvTzv7bJ5yR1zH2bWm4cQe6sXyAa";
const IDS: BrokerId[] = ["moss", "ines", "qm"];
const KEYS: Record<BrokerId, `ed25519:${string}`> = {
  moss: generateKey().secretKey as `ed25519:${string}`,
  ines: generateKey().secretKey as `ed25519:${string}`,
  qm: generateKey().secretKey as `ed25519:${string}`,
};
const NAMES: Record<BrokerId, string> = { moss: "Moss", ines: "Ines", qm: "Quartermaster" };
const BUYS: Record<BrokerId, CargoId[]> = { moss: ["copper", "chips"], ines: ["meds", "fuel"], qm: ["core", "fuel"] };

// ---------------------------------------------------------------------------------------------------------------
// Fixtures

interface State {
  open?: boolean;
  scrip?: number;
  stance?: number;
  stock?: Partial<Record<CargoId, number>>;
}

function view(id: BrokerId, s: State = {}): BrokerView {
  const stock: Partial<Record<CargoId, number>> = {};
  for (const t of BUYS[id]) stock[t] = s.stock?.[t] ?? 0;
  return {
    id,
    accountId: `${id}.${CONTRACT}`,
    name: NAMES[id],
    open: s.open ?? true,
    scrip: s.scrip ?? 1_500,
    stance: s.stance ?? 100,
    stock,
    bids: [],
    asks: [],
    shares: [],
    lastMemo: null,
  };
}

/** The same state as the contract's JSON (docs/CONTRACT_API.md → brokers). */
function wire(id: BrokerId, s: State = {}) {
  const v = view(id, s);
  return {
    id,
    account_id: v.accountId,
    name: v.name,
    open: v.open,
    scrip: String(v.scrip),
    stance: v.stance,
    stock: Object.fromEntries(Object.entries(v.stock).map(([k, n]) => [k, String(n)])),
    bids: BUYS[id].map((t) => ({ token_id: t, price: "60", reason: "At target." })),
    asks: [],
    shares: [],
    last_memo: null,
  };
}

const none: Advice = { action: "none", tokenId: null, amount: null, stance: null, memo: "Holding." };
const exportAdvice = (tokenId: CargoId, amount: number): Advice => ({ action: "export", tokenId, amount, stance: null, memo: "Ship." });
const stanceAdvice = (stance: number): Advice => ({ action: "stance", tokenId: null, amount: null, stance, memo: "Stance." });
const adviceWire = (a: Advice) => ({ action: a.action, token_id: a.tokenId, amount: a.amount === null ? null : String(a.amount), stance: a.stance, memo: a.memo });

const ok = (value: unknown): RawOutcome => ({ status: { SuccessValue: btoa(JSON.stringify(value)) }, transaction: { hash: HASH } });
const refusal = (method: string, text: string) => new FunctionCallError(CONTRACT, method, `Smart contract panicked: ${text}`);

interface Stub {
  port: NearPort;
  specs: CallSpec[];
  views: { method: string; args: object; attempt: number }[];
}

/** A port whose views answer from fixtures and whose transactions answer from `send`. */
function stub(opts: {
  brokers?: unknown;
  advice?: Partial<Record<BrokerId, unknown>>;
  send?: (spec: CallSpec) => RawOutcome | Error;
  viewHook?: (method: string, attempt: number) => Error | null;
}): Stub {
  const specs: CallSpec[] = [];
  const views: Stub["views"] = [];
  const port: NearPort = {
    async view(_contract, method, args, attempt) {
      views.push({ method, args, attempt });
      const hooked = opts.viewHook?.(method, attempt);
      if (hooked) throw hooked;
      const value = method === "brokers" ? opts.brokers : opts.advice?.[(args as { broker: BrokerId }).broker];
      if (value instanceof Error) throw value;
      if (value === undefined) throw new Error(`no stub for ${method}`);
      return value;
    },
    async accountExists() {
      return true;
    },
    prepare(spec) {
      specs.push(spec);
      let signed = false;
      const tx: PreparedTx = {
        hash: () => (signed ? HASH : null),
        async send() {
          signed = true;
          const r = opts.send ? opts.send(spec) : ok(spec.kind === "call" && spec.method === "broker_export" ? { earned: "250", dividend: "0" } : {});
          if (r instanceof Error) throw r;
          return r;
        },
        async resend() {
          throw new Error("resend not scripted");
        },
        async status() {
          return null;
        },
      };
      return tx;
    },
  };
  return { port, specs, views };
}

const allKeys = async (id: BrokerId, accountId: string): Promise<KeyLookup> => ({
  ok: true,
  key: { accountId, privateKey: KEYS[id], source: "env" } satisfies BrokerKey,
});

const FAST = { retries: 1, backoffMs: 0, sleep: async () => {} };

function round(s: Stub, extra: Partial<RoundDeps> = {}) {
  return runRound({ board: createBoard(s.port, CONTRACT, FAST), port: s.port, contractId: CONTRACT, key: allKeys, seed: 7, exec: FAST, ...extra });
}

/** A board where every broker has something to do: Moss ships copper, Ines tightens, the Quartermaster pays up. */
function busy(over: Partial<Parameters<typeof stub>[0]> = {}) {
  return stub({
    brokers: [wire("moss", { stock: { copper: 20 } }), wire("ines", { scrip: 1_200 }), wire("qm", { scrip: 1_000, stock: { core: 5 } })],
    advice: { moss: adviceWire(exportAdvice("copper", 8)), ines: adviceWire(none), qm: adviceWire(none) },
    ...over,
  });
}

const callArgs = (spec: CallSpec) => (spec.kind === "call" ? { signer: spec.signerId, method: spec.method, args: spec.args as Record<string, unknown> } : null);
const by = (lines: Line[], id: BrokerId) => lines.find((l) => l.broker === id) as Line;

// ---------------------------------------------------------------------------------------------------------------

describe("characters: decisions from fixed broker states", () => {
  it("everyone ships when the advice says ship", () => {
    expect(decide(view("moss", { stock: { copper: 20 } }), exportAdvice("copper", 8)).move).toEqual({ action: "export", tokenId: "copper", amount: 8 });
    expect(decide(view("ines", { stock: { meds: 11 } }), exportAdvice("meds", 3)).move).toEqual({ action: "export", tokenId: "meds", amount: 3 });
    expect(decide(view("qm", { stock: { core: 7 } }), exportAdvice("core", 3)).move).toEqual({ action: "export", tokenId: "core", amount: 3 });
    // Even when the till is thin: shipping is income.
    expect(decide(view("ines", { scrip: 900, stock: { fuel: 9 } }), exportAdvice("fuel", 3)).move.action).toBe("export");
  });

  it("Moss ships down to a quarter of target when she's shut, where the advice stops at half", () => {
    // Copper's target is 12: the advice ships 20 - 6 = 14; Moss ships 20 - 3 = 17.
    const d = decide(view("moss", { open: false, scrip: 150, stock: { copper: 20 } }), exportAdvice("copper", 14));
    expect(d.move).toEqual({ action: "export", tokenId: "copper", amount: 17 });
    expect(d.why).toBe("ship-shut");
  });

  it("Moss bids less while the shed is over target and the freighter can't take it yet", () => {
    // The advice holds because copper's export hour hasn't passed.
    const full = view("moss", { stock: { copper: 20 } });
    expect(decide(full, none)).toMatchObject({ move: { action: "stance", stance: 95 }, why: "shed-full", tokenId: "copper" });
    // A thin till too: she takes the advice's deeper cut.
    expect(decide(view("moss", { scrip: 600, stock: { copper: 20 } }), stanceAdvice(90)).move).toEqual({ action: "stance", stance: 90 });
    // She never raises into a full shed, even when the advice says the till is flush.
    expect(decide(view("moss", { scrip: 2_500, stock: { copper: 20 } }), stanceAdvice(105)).move).toEqual({ action: "stance", stance: 95 });
    // At the floor she holds and says why.
    expect(decide(view("moss", { stance: 80, stock: { copper: 20 } }), none)).toMatchObject({ move: { action: "hold" }, why: "shed-full-floor" });
  });

  it("Moss brings her bids back towards 100 once the shed is clear", () => {
    expect(decide(view("moss", { stance: 90, stock: { copper: 10 } }), none).move).toEqual({ action: "stance", stance: 95 });
    expect(decide(view("moss", { stance: 98 }), none).move).toEqual({ action: "stance", stance: 100 });
    // Not on a thin till.
    expect(decide(view("moss", { stance: 90, scrip: 650 }), none).move).toEqual({ action: "hold" });
    expect(decide(view("moss"), none)).toMatchObject({ move: { action: "hold" }, why: "steady" });
  });

  it("Ines tightens as soon as her scrip drops under 1,300, before the default policy would", () => {
    expect(decide(view("ines", { scrip: 1_200 }), none)).toMatchObject({ move: { action: "stance", stance: 95 }, why: "float" });
    // Under the policy's own thin line the advice cuts 10, and she takes it.
    expect(decide(view("ines", { scrip: 900 }), stanceAdvice(90))).toMatchObject({ move: { action: "stance", stance: 90 }, why: "thin" });
    expect(decide(view("ines", { scrip: 1_200, stance: 80 }), none)).toMatchObject({ move: { action: "hold" }, why: "float-floor" });
    expect(decide(view("ines", { scrip: 1_400 }), none).move).toEqual({ action: "hold" });
  });

  it("Ines only bids up with more than 3,000 in the till", () => {
    expect(decide(view("ines", { scrip: 2_700 }), stanceAdvice(105))).toMatchObject({ move: { action: "hold" }, why: "cautious" });
    expect(decide(view("ines", { scrip: 3_200 }), stanceAdvice(105))).toMatchObject({ move: { action: "stance", stance: 105 }, why: "flush" });
  });

  it("the Quartermaster pushes stance up while relay cores are flowing", () => {
    // Core's target is 4.
    expect(decide(view("qm", { scrip: 1_000, stock: { core: 5 } }), none)).toMatchObject({ move: { action: "stance", stance: 105 }, why: "cores" });
    expect(decide(view("qm", { scrip: 1_000, stance: 118, stock: { core: 4 } }), none).move).toEqual({ action: "stance", stance: 120 });
    // Not with under 800 scrip, not without cores, and not past 120.
    expect(decide(view("qm", { scrip: 700, stock: { core: 5 } }), none).move).toEqual({ action: "hold" });
    expect(decide(view("qm", { scrip: 1_000, stock: { core: 3 } }), none).move).toEqual({ action: "hold" });
    expect(decide(view("qm", { scrip: 1_000, stance: 120, stock: { core: 5 } }), none).move).toEqual({ action: "hold" });
    // A thin till still wins: he follows the advice's cut.
    expect(decide(view("qm", { scrip: 400, stock: { core: 5 } }), stanceAdvice(90)).move).toEqual({ action: "stance", stance: 90 });
  });

  it("a move that doesn't add up against the board is a hold, not a guess", () => {
    // Ines doesn't buy chips.
    expect(decide(view("ines", { stock: { meds: 20 } }), exportAdvice("chips", 3))).toMatchObject({ move: { action: "hold" }, invalid: true });
    // More than the board says the broker holds, for every character.
    expect(decide(view("ines", { stock: { meds: 2 } }), exportAdvice("meds", 5))).toMatchObject({ invalid: true });
    expect(decide(view("qm", { stock: { core: 2 } }), exportAdvice("core", 5))).toMatchObject({ invalid: true });
    expect(decide(view("moss", { stock: { copper: 20 } }), exportAdvice("copper", 30))).toMatchObject({ invalid: true });
    // A stance outside 80–120 from the advice.
    expect(decide(view("ines", { scrip: 3_500 }), stanceAdvice(250)).move).toEqual({ action: "stance", stance: 120 });
    expect(decide(view("qm"), stanceAdvice(-5)).move.action).not.toBe("export");
  });
});

describe("a round: each broker signs its own move", () => {
  it("signs Moss's export, Ines's stance and the Quartermaster's stance with their own keys", async () => {
    const s = busy();
    const lines = await round(s);
    expect(s.specs.map(callArgs)).toEqual([
      { signer: "moss.saltline.testnet", method: "broker_export", args: { token_id: "copper", amount: "8", memo: by(lines, "moss").memo } },
      { signer: "ines.saltline.testnet", method: "broker_stance", args: { stance: 95, memo: by(lines, "ines").memo } },
      { signer: "qm.saltline.testnet", method: "broker_stance", args: { stance: 105, memo: by(lines, "qm").memo } },
    ]);
    for (const spec of s.specs) {
      if (spec.kind !== "call") throw new Error("expected calls");
      expect(spec.privateKey).toBe(KEYS[spec.signerId.split(".")[0] as BrokerId]);
      expect(spec.contractId).toBe(CONTRACT);
      expect(spec.gasTgas).toBe(50);
    }
    expect(lines.map((l) => [l.broker, l.status, l.action, l.txHash])).toEqual([
      ["moss", "sent", "export 8 copper", HASH],
      ["ines", "sent", "stance 95", HASH],
      ["qm", "sent", "stance 105", HASH],
    ]);
    expect(exitCode(lines)).toBe(0);
    expect(formatLine(by(lines, "moss"))).toContain(`tx ${HASH}`);
  });

  it("a broker with nothing to do holds with a memo and signs nothing", async () => {
    const s = stub({ brokers: IDS.map((id) => wire(id)), advice: { moss: adviceWire(none), ines: adviceWire(none), qm: adviceWire(none) } });
    const lines = await round(s);
    expect(s.specs).toHaveLength(0);
    expect(lines.every((l) => l.status === "held" && l.action === "hold" && (l.memo?.length ?? 0) > 0)).toBe(true);
    expect(exitCode(lines)).toBe(0);
  });

  it("retries a transient view failure on the next RPC", async () => {
    const s = busy({ viewHook: (method, attempt) => (method === "brokers" && attempt === 0 ? new NetworkError("HTTP 503", 503, true) : null) });
    const lines = await round(s);
    expect(s.views.filter((v) => v.method === "brokers").map((v) => v.attempt)).toEqual([0, 1]);
    expect(lines.every((l) => l.status === "sent")).toBe(true);
  });
});

describe("fail closed: an unknown state means no action", () => {
  it("holds every broker when brokers() can't be read", async () => {
    const s = busy({ brokers: new NetworkError("HTTP 503", 503, true) });
    const lines = await round(s);
    expect(s.specs).toHaveLength(0);
    expect(lines.map((l) => [l.broker, l.status, l.unknown])).toEqual(IDS.map((id) => [id, "held", true]));
    expect(lines[0].note).toMatch(/^state unknown: brokers:/);
    expect(exitCode(lines)).toBe(2);
  });

  it("treats a board that doesn't decode as unknown, never as zero", async () => {
    const bad = wire("moss", { stock: { copper: 20 } }) as Record<string, unknown>;
    bad.scrip = "a lot";
    const s = busy({ brokers: [bad, wire("ines", { scrip: 1_200 }), wire("qm")] });
    const lines = await round(s);
    expect(s.specs).toHaveLength(0);
    expect(lines.every((l) => l.unknown)).toBe(true);
  });

  it("holds only the broker whose advice failed; the others still act", async () => {
    const s = busy({ advice: { moss: adviceWire(exportAdvice("copper", 8)), ines: new Error("timeout"), qm: adviceWire(none) } });
    const lines = await round(s);
    expect(by(lines, "ines")).toMatchObject({ status: "held", unknown: true });
    expect(by(lines, "moss").status).toBe("sent");
    expect(by(lines, "qm").status).toBe("sent");
    expect(s.specs.map((x) => (x.kind === "call" ? x.signerId : ""))).toEqual(["moss.saltline.testnet", "qm.saltline.testnet"]);
  });

  it("holds on advice it can't read: an unknown action, or an export without an amount", async () => {
    const s = busy({
      advice: {
        moss: { action: "export", token_id: "copper", amount: null, stance: null, memo: "?" },
        ines: { action: "buy_everything", memo: "?" },
        qm: { action: "stance", stance: 105 },
      },
    });
    const lines = await round(s);
    expect(s.specs).toHaveLength(0);
    expect(lines.every((l) => l.status === "held" && l.unknown)).toBe(true);
  });

  it("holds when the contract names a different account for a broker, and never looks up its key", async () => {
    const odd = wire("moss", { stock: { copper: 20 } });
    odd.account_id = "someone-else.testnet";
    const key = vi.fn(allKeys);
    const s = busy({ brokers: [odd, wire("ines", { scrip: 1_200 }), wire("qm", { scrip: 1_000, stock: { core: 5 } })] });
    const lines = await round(s, { key });
    expect(by(lines, "moss")).toMatchObject({ status: "held", unknown: true });
    expect(key.mock.calls.map((c) => c[0])).toEqual(["ines", "qm"]);
    expect(s.specs).toHaveLength(2);
  });

  it("calls an unconfirmed transaction pending, not failed", async () => {
    const s = busy({ send: () => new NetworkError("socket hang up", undefined, true) });
    const lines = await round(s, { exec: { retries: 0, backoffMs: 0, sleep: async () => {} } });
    expect(by(lines, "moss")).toMatchObject({ status: "pending", txHash: HASH });
    expect(exitCode(lines)).toBe(2);
  });
});

describe("refusals and the export cooldown", () => {
  const cooldown = () => refusal("broker_export", "E_EXPORT_COOLDOWN: Moss shipped coils within the hour; 12 min to go");

  it("logs an E_ refusal and skips it, sending it once", async () => {
    const s = busy({ send: (spec) => (spec.kind === "call" && spec.method === "broker_export" ? cooldown() : ok({})) });
    const lines = await round(s);
    expect(by(lines, "moss")).toMatchObject({ status: "refused", note: "E_EXPORT_COOLDOWN: Moss shipped coils within the hour; 12 min to go" });
    expect(s.specs.filter((x) => x.kind === "call" && x.method === "broker_export")).toHaveLength(1);
    // A refusal is the contract saying no, not an unknown: the cron run stays green.
    expect(exitCode(lines)).toBe(0);
    expect(by(lines, "ines").status).toBe("sent");
  });

  it("in --loop, benches a refused move for the hour instead of re-sending it each round", async () => {
    let now = Date.UTC(2026, 10, 11, 13, 0);
    const bench = new Bench(() => now);
    const s = busy({ send: (spec) => (spec.kind === "call" && spec.method === "broker_export" ? cooldown() : ok({})) });
    await round(s, { bench });
    now += 15 * 60_000;
    const second = await round(s, { bench });
    expect(by(second, "moss")).toMatchObject({ status: "held", action: "hold" });
    expect(by(second, "moss").note).toMatch(/^export 8 copper was refused; benched until 14:00 UTC/);
    expect(s.specs.filter((x) => x.kind === "call" && x.method === "broker_export")).toHaveLength(1);
    now += 50 * 60_000;
    await round(s, { bench });
    expect(s.specs.filter((x) => x.kind === "call" && x.method === "broker_export")).toHaveLength(2);
  });

  it("benches a broker whose key the contract won't take (E_NOT_BROKER) for the rest of the loop", async () => {
    const bench = new Bench();
    const s = busy({ send: (spec) => (spec.kind === "call" && spec.signerId.startsWith("qm.") ? refusal("broker_stance", "E_NOT_BROKER: Only the broker's own account can call this") : ok({})) });
    await round(s, { bench });
    const second = await round(s, { bench });
    expect(by(second, "qm").note).toMatch(/was refused; benched/);
    expect(s.specs.filter((x) => x.kind === "call" && x.signerId.startsWith("qm."))).toHaveLength(1);
  });
});

describe("keys", () => {
  const env = { BROKER_MOSS_KEY: KEYS.moss };
  const noFile = async () => {
    throw Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" });
  };

  it("takes the broker's key from its env variable", async () => {
    const r = await findKey("moss", "moss.saltline.testnet", env, { read: noFile });
    expect(r).toEqual({ ok: true, key: { accountId: "moss.saltline.testnet", privateKey: KEYS.moss, source: "env" } });
  });

  it("refuses a malformed env key instead of falling back to the keychain", async () => {
    const read = vi.fn(noFile);
    const r = await findKey("moss", "moss.saltline.testnet", { BROKER_MOSS_KEY: "ed25519:not-a-key" }, { read });
    expect(r).toEqual({ ok: false, why: "BROKER_MOSS_KEY is set but isn't an ed25519 secret key" });
    expect(read).not.toHaveBeenCalled();
  });

  it("falls back to the legacy keychain file for the broker's account", async () => {
    const read = vi.fn(async () => JSON.stringify({ account_id: "ines.saltline.testnet", public_key: "ed25519:x", private_key: KEYS.ines }));
    const r = await findKey("ines", "ines.saltline.testnet", {}, { credentialsDir: "/creds/testnet", read });
    expect(read).toHaveBeenCalledWith("/creds/testnet/ines.saltline.testnet.json");
    expect(r).toEqual({ ok: true, key: { accountId: "ines.saltline.testnet", privateKey: KEYS.ines, source: "keychain" } });
  });

  it("says plainly where to put a missing key", async () => {
    const r = await findKey("qm", "qm.saltline.testnet", {}, { credentialsDir: "/creds/testnet", read: noFile });
    expect(r).toEqual({ ok: false, why: "no key: set BROKER_QM_KEY or add /creds/testnet/qm.saltline.testnet.json" });
  });

  it("refuses a keychain file for another account, or one that isn't JSON, without quoting it", async () => {
    const other = await findKey("qm", "qm.saltline.testnet", {}, { read: async () => JSON.stringify({ account_id: "moss.saltline.testnet", private_key: KEYS.moss }) });
    expect(other.ok).toBe(false);
    const broken = await findKey("qm", "qm.saltline.testnet", {}, { credentialsDir: "/c", read: async () => `{"private_key":"${KEYS.qm}"` });
    expect(broken).toEqual({ ok: false, why: "/c/qm.saltline.testnet.json isn't JSON" });
  });

  it("skips a broker with no key and still runs the others", async () => {
    const s = busy();
    const key = async (id: BrokerId, accountId: string): Promise<KeyLookup> =>
      id === "qm" ? { ok: false, why: "no key: set BROKER_QM_KEY or add ~/.near-credentials/testnet/qm.saltline.testnet.json" } : allKeys(id, accountId);
    const lines = await round(s, { key });
    expect(by(lines, "qm")).toEqual({ broker: "qm", status: "skipped", action: "hold", note: expect.stringContaining("BROKER_QM_KEY") });
    expect(by(lines, "moss").status).toBe("sent");
    expect(by(lines, "ines").status).toBe("sent");
    expect(s.specs).toHaveLength(2);
    expect(exitCode(lines)).toBe(0);
  });

  it("never prints a key, even when an error message carries one", async () => {
    const s = busy({ send: () => Object.assign(new Error(`signer ${KEYS.moss} rejected`), { code: "SIGNATURE_ERROR" }) });
    const lines = await round(s);
    const printed = lines.map((l) => formatLine(l)).join("\n");
    for (const k of Object.values(KEYS)) expect(printed).not.toContain(k.slice(8));
    expect(printed).toContain("ed25519:<redacted>");
    expect(redact("token sk-near-0123456789abcdef here", ["sk-near-0123456789abcdef"])).toBe("token <redacted> here");
  });
});

describe("memos", () => {
  const whys: Why[] = ["ship", "ship-shut", "shed-full", "shed-full-floor", "shed-clear", "float", "float-floor", "cautious", "cores", "thin", "flush", "steady", "shut"];

  it("keeps every template within 90 characters at the largest plausible numbers", () => {
    let checked = 0;
    for (const id of IDS) {
      const big = view(id, { scrip: 9_999_999, stance: 120, stock: Object.fromEntries(BUYS[id].map((t) => [t, 9_999])) });
      for (const why of whys) {
        for (const t of templatesFor(id, why)) {
          for (const tokenId of BUYS[id]) {
            const d: Decision = { move: why.startsWith("ship") ? { action: "export", tokenId, amount: 9_999 } : { action: "stance", stance: 120 }, why, tokenId };
            const memo = fill(t, big, d);
            expect(memo.length, `${id}/${why}: ${memo}`).toBeLessThanOrEqual(MEMO_MAX);
            expect(memo).not.toMatch(/[{}\n]/);
            checked++;
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(40);
  });

  it("falls back to a plain line rather than run over", () => {
    const d: Decision = { move: { action: "export", tokenId: "chips", amount: 9_007_199_254_740 }, why: "ship", tokenId: "chips" };
    const memo = memoFor(view("moss", { scrip: 9_007_199_254_740_991, stock: { chips: 9_007_199_254_740 } }), d, 1);
    expect(memo.length).toBeLessThanOrEqual(MEMO_MAX);
    expect(memo).toContain("9007199254740");
  });

  it("is stable for a seed and varies across seeds", () => {
    const b = view("moss", { stock: { copper: 20 } });
    const d = decide(b, exportAdvice("copper", 8));
    expect(memoFor(b, d, 42)).toBe(memoFor(b, d, 42));
    const seen = new Set(Array.from({ length: 30 }, (_, seed) => memoFor(b, d, seed)));
    expect(seen.size).toBeGreaterThan(1);
    for (const m of seen) expect(m).toMatch(/8 coils/);
  });

  it("signs memos of at most 90 characters in a round", async () => {
    const s = busy();
    await round(s);
    for (const spec of s.specs) {
      const memo = spec.kind === "call" ? (spec.args as { memo: string }).memo : "";
      expect(memo.length).toBeGreaterThan(0);
      expect(memo.length).toBeLessThanOrEqual(MEMO_MAX);
    }
  });
});

describe("--dry-run", () => {
  it("decides and prints but never signs", async () => {
    const s = busy();
    const lines = await round(s, { dryRun: true });
    expect(s.specs).toHaveLength(0);
    expect(lines.map((l) => [l.broker, l.status, l.action])).toEqual([
      ["moss", "dry-run", "export 8 copper"],
      ["ines", "dry-run", "stance 95"],
      ["qm", "dry-run", "stance 105"],
    ]);
    expect(by(lines, "moss").note).toBe("would sign as moss.saltline.testnet (key from env)");
  });

  it("still shows the decision for a broker with no key", async () => {
    const s = busy();
    const lines = await round(s, { dryRun: true, key: async () => ({ ok: false, why: "no key: set BROKER_MOSS_KEY" }) });
    expect(s.specs).toHaveLength(0);
    expect(by(lines, "moss")).toMatchObject({ status: "dry-run", action: "export 8 copper", note: "would skip: no key: set BROKER_MOSS_KEY" });
  });
});

describe("the LLM voice can't change the move", () => {
  function voiceWith(reply: () => Promise<Response>) {
    const fetch = vi.fn(async (..._args: Parameters<typeof globalThis.fetch>) => reply());
    const voice: VoiceConfig = { apiKey: "near-ai-test-key-123456", model: "test/model", baseUrl: NEAR_AI_BASE_URL, fetch: fetch as unknown as typeof globalThis.fetch, timeoutMs: 1_000 };
    return { fetch, voice };
  }
  const chat = (content: unknown, status = 200) => async () => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status });
  const moves = (s: Stub) => s.specs.map((x) => (x.kind === "call" ? { method: x.method, ...(x.args as object), memo: undefined } : null));

  it("uses an in-character rewrite as the memo and signs the same move", async () => {
    const plain = busy();
    await round(plain);
    const { fetch, voice } = voiceWith(chat("Eight coils out. Rust waits for nobody."));
    const s = busy();
    const lines = await round(s, { voice });
    expect(moves(s)).toEqual(moves(plain));
    expect(by(lines, "moss")).toMatchObject({ memo: "Eight coils out. Rust waits for nobody.", voice: "llm", action: "export 8 copper" });
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe("https://cloud-api.near.ai/v1/chat/completions");
    expect((init?.headers as Record<string, string>).authorization).toBe("Bearer near-ai-test-key-123456");
    expect(JSON.parse(String(init?.body)).model).toBe("test/model");
  });

  it("throws away a rewrite that names a different amount, or tries to issue orders", async () => {
    const plain = busy();
    const plainLines = await round(plain);
    for (const reply of ["Shipping 500 coils and setting stance 120.", '{"action":"stance","stance":120}', "x".repeat(91), ""]) {
      const { voice } = voiceWith(chat(reply));
      const s = busy();
      const lines = await round(s, { voice });
      expect(moves(s)).toEqual(moves(plain));
      expect(lines.map((l) => [l.memo, l.voice])).toEqual(plainLines.map((l) => [l.memo, "template"]));
    }
  });

  it("falls back to the template when NEAR AI errors, times out or answers garbage", async () => {
    for (const reply of [
      chat("fine", 500),
      async () => {
        throw new DOMException("timed out", "TimeoutError");
      },
      async () => new Response("not json", { status: 200 }),
    ]) {
      const { voice } = voiceWith(reply);
      const s = busy();
      const lines = await round(s, { voice });
      expect(lines.every((l) => l.status === "sent" && l.voice === "template")).toBe(true);
    }
  });

  it("isn't asked about holds, and isn't asked at all without a key", async () => {
    const { fetch, voice } = voiceWith(chat("Quiet day."));
    const quiet = stub({ brokers: IDS.map((id) => wire(id)), advice: { moss: adviceWire(none), ines: adviceWire(none), qm: adviceWire(none) } });
    await round(quiet, { voice });
    expect(fetch).not.toHaveBeenCalled();
    const spy = vi.spyOn(globalThis, "fetch");
    await round(busy());
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("isn't asked about a move that's benched after a refusal", async () => {
    const { fetch, voice } = voiceWith(chat("Eight coils out."));
    const bench = new Bench();
    bench.put("moss", { action: "export", tokenId: "copper", amount: 8 }, 3_600_000);
    const s = busy();
    const lines = await round(s, { voice, bench });
    expect(by(lines, "moss")).toMatchObject({ status: "held", action: "hold" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("keeps a rewrite to one plain line", () => {
    const truth = "Moss is open with 1500 scrip at stance 100. Shipping 8 coils to the freighter at 35 each.";
    expect(acceptRewrite("<think>numbers 999</think>\n\"Eight coils, 35 apiece. Gone.\"\nextra", truth)).toBe("Eight coils, 35 apiece. Gone.");
    expect(acceptRewrite("Shipping 8 coils at 36.", truth)).toBeNull();
    expect(acceptRewrite("Ship <b>now</b>", truth)).toBeNull();
    expect(acceptRewrite(42, truth)).toBeNull();
  });
});

describe("command line", () => {
  it("parses the modes", () => {
    expect(parseArgs([])).toEqual({ mode: "once", minutes: 0, dryRun: false, seed: null });
    expect(parseArgs(["--once", "--dry-run"])).toMatchObject({ mode: "once", dryRun: true });
    expect(parseArgs(["--loop", "10"])).toMatchObject({ mode: "loop", minutes: 10 });
    expect(parseArgs(["--loop=5", "--seed", "3"])).toMatchObject({ mode: "loop", minutes: 5, seed: 3 });
    expect(() => parseArgs(["--loop", "0"])).toThrow(/1 to 1440/);
    expect(() => parseArgs(["--loop"])).toThrow(/1 to 1440/);
    expect(() => parseArgs(["--once", "--loop", "5"])).toThrow(/pick one/);
    expect(() => parseArgs(["--yolo"])).toThrow(/unknown argument/);
  });

  it("refuses a bad config before touching the network", async () => {
    const err = vi.fn();
    expect(await main(["--once"], { NEAR_NETWORK: "mainnet" }, vi.fn(), err)).toBe(1);
    expect(err.mock.calls[0][0]).toMatch(/only testnet/);
    expect(await main(["--once"], { CONTRACT_ID: "Not An Account" }, vi.fn(), err)).toBe(1);
    expect(await main(["--once"], { NEAR_RPC: "http://rpc.example" }, vi.fn(), err)).toBe(1);
    expect(err.mock.calls[2][0]).toMatch(/use https/);
  });
});
