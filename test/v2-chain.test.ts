// The v2 testnet client against docs/CONTRACT_V2.md, with a stubbed port: every view and call, U128 edges, panics,
// the one queue, the retry rules and `pending`.
import { FunctionCallError, NetworkError } from "near-kit";
import { describe, expect, it } from "vitest";
import type { CallSpec, NearPort, PreparedTx, RawOutcome } from "../src/economy/chain";
import { TESTNET_EXPLORER_TX } from "../src/economy/config";
import { ERROR_TEXT2, GAS_RAID, GAS_REST, TESTNET_EXPLORER_ACCOUNT, createTestnetChain2, decodeHarbormaster, decodeWeapon } from "../src/economy/v2/chain";
import type { RaidReport } from "../src/economy/v2/types";

const HASH = "9ZQ7wq3gL8kRrRk3BvTzv7bJ5yR1zH2bWm4cQe6sXyAa";
const KEY = { accountId: "a".repeat(64), privateKey: "ed25519:stub" as const };
const CONTRACT = "v2.saltline.testnet";
const ok = (value: unknown): RawOutcome => ({ status: { SuccessValue: btoa(JSON.stringify(value)) }, transaction: { hash: HASH } });
const http503 = () => new NetworkError("HTTP 503: Service Unavailable", 503, true);
const panic = (text: string) => new FunctionCallError(CONTRACT, "call", `Smart contract panicked: ${text}`);

type Step = RawOutcome | Error | (() => Promise<RawOutcome>);

class ScriptTx implements PreparedTx {
  signed = false;
  sends = 0;
  resends = 0;
  statuses = 0;
  constructor(
    private steps: Step[],
    private statusResult: RawOutcome | null = null,
    private failsBeforeSigning = 0,
  ) {}
  hash() {
    return this.signed ? HASH : null;
  }
  private async next(): Promise<RawOutcome> {
    const s = this.steps.shift();
    if (!s) throw new Error("script ran out");
    if (s instanceof Error) throw s;
    return typeof s === "function" ? s() : s;
  }
  async send() {
    this.sends++;
    if (this.failsBeforeSigning > 0) this.failsBeforeSigning--;
    else this.signed = true;
    return this.next();
  }
  async resend() {
    this.resends++;
    return this.next();
  }
  async status() {
    this.statuses++;
    return this.statusResult;
  }
}

function setup(opts: { views?: Record<string, (args: Record<string, unknown>, attempt: number) => unknown>; txs?: ScriptTx[]; replies?: unknown[]; noKey?: boolean } = {}) {
  const specs: CallSpec[] = [];
  const viewCalls: { method: string; args: object; attempt: number }[] = [];
  const txs = opts.txs ?? (opts.replies ?? []).map((r) => new ScriptTx([ok(r)]));
  const port: NearPort = {
    async view(contract, method, args, attempt) {
      expect(contract).toBe(CONTRACT);
      viewCalls.push({ method, args, attempt });
      const v = opts.views?.[method];
      if (!v) throw new Error(`no stub for ${method}`);
      return v(args as Record<string, unknown>, attempt);
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
  const chain = createTestnetChain2({
    config: { contractId: CONTRACT, rpcUrls: ["https://rpc.invalid"], explorerTxUrl: TESTNET_EXPLORER_TX },
    keys: () => (opts.noKey ? null : KEY),
    port,
    exec: { retries: 2, backoffMs: 1, sleep: async () => undefined },
  });
  const sent = () => specs.map((s) => (s.kind === "call" ? { method: s.method, args: s.args, gas: s.gasTgas, deposit: s.depositYocto } : s));
  return { chain, specs, sent, viewCalls };
}

// --- the wire, as the contract sends it

const STATS = { damage: 50, rpm: 340, mag: 14, recoil: 120, reload: 105, range: 430 };
const W = {
  serial: "S-000041",
  frame: "pilot",
  grade: "B",
  quality: 71,
  stats: STATS,
  mods: ["optic", "bayonet"],
  condition: 88,
  maker: "rook.testnet",
  maker_callsign: "ROOK",
  owner: "kestrel.testnet",
  built_at: 5,
  raids: 3,
  extractions: 2,
  owners: 2,
  recovered: 1,
  state: "held",
  value: "1210",
};
const WEAPON = {
  serial: "S-000041",
  frame: "pilot",
  grade: "B",
  quality: 71,
  stats: STATS,
  mods: ["optic"],
  condition: 88,
  maker: "rook.testnet",
  makerCallsign: "ROOK",
  owner: "kestrel.testnet",
  builtAt: 5,
  raids: 3,
  extractions: 2,
  owners: 2,
  recovered: 1,
  state: "held",
  value: 1210,
};
const HM_W = { account_id: "harbormaster.saltline.testnet", balance: "1100", strength: 55, posture: "pursuit", bonus_drones: 0, second_notice_at: "600", bailiff_at: "980", second_bailiff_at: "2400", foreclosure_at: "4000", last_memo: null };
const HM = { accountId: "harbormaster.saltline.testnet", balance: 1100, strength: 55, posture: "pursuit", bonusDrones: 0, secondNoticeAt: 600, bailiffAt: 980, secondBailiffAt: 2400, foreclosureAt: 4000, lastMemo: null };
const WRECK_W = { id: 4, spot: 9, owner: "marlowe.testnet", callsign: "MARLOWE", weapon: W, items: [{ token_id: "copper", amount: "2" }, { token_id: "gold", amount: "1" }], at: 100, expires_at: 200 };
const WRECK = { id: 4, spot: 9, owner: "marlowe.testnet", callsign: "MARLOWE", weapon: WEAPON, items: [{ tokenId: "copper", amount: 2 }], at: 100, expiresAt: 200 };
const RAID_W = { raid_id: 7, started_at: 9, loadout: { weapon: null, plates: 1, charges: 0, mags: 2 }, containers: [{ spot: 3, token_id: "core", amount: "2", bonded: true }], wrecks: [WRECK_W], invoice_start: "175", harbormaster: HM_W };
const RAID = { raidId: 7, startedAt: 9, loadout: { weapon: null, plates: 1, charges: 0, mags: 2 }, containers: [{ spot: 3, tokenId: "core", amount: 2, bonded: true }], wrecks: [WRECK], invoiceStart: 175, harbormaster: HM };
const REPORT: RaidReport = { opened: [3, 5], wrecks: [4], parts: { servo: 1, rotor: 0 }, kills: { gull: 2, hound: 1 }, uplinks: 1, used: { plates: 1, charges: 0, mags: 2 } };

describe("v2 chain: views", () => {
  it("profile maps snake_case and U128 strings, and null stays null", async () => {
    const { chain, viewCalls } = setup({
      views: {
        profile: (a) => (a.account_id === "x.testnet" ? null : { account_id: "rook.testnet", callsign: "ROOK", registered_at: 5, raids: 9, extractions: 6, deaths: 3, arrears: "1250", active_raid: null, built: 2, royalties: "41" }),
      },
    });
    expect(await chain.profile("rook.testnet")).toEqual({ accountId: "rook.testnet", callsign: "ROOK", registeredAt: 5, raids: 9, extractions: 6, deaths: 3, arrears: 1250, activeRaid: null, built: 2, royalties: 41 });
    expect(await chain.profile("x.testnet")).toBeNull();
    expect(viewCalls[0]).toEqual({ method: "profile", args: { account_id: "rook.testnet" }, attempt: 0 });
  });

  it("balances keeps the tokens it knows", async () => {
    const { chain } = setup({ views: { balances: () => ({ scrip: "150", servo: "2", mag2: "1", ammo: "8", doubloon: "5" }) } });
    expect(await chain.balances("rook.testnet")).toEqual({ scrip: 150, servo: 2, mag2: 1, ammo: 8 });
  });

  it("weapons and weapon decode a gun, dropping a mod this client doesn't know", async () => {
    const { chain, viewCalls } = setup({ views: { weapons: () => [W], weapon: (a) => (a.serial === "S-000041" ? W : null) } });
    expect(await chain.weapons("kestrel.testnet")).toEqual([WEAPON]);
    expect(await chain.weapon("S-000041")).toEqual(WEAPON);
    expect(await chain.weapon("S-000042")).toBeNull();
    expect(viewCalls.map((c) => c.args)).toEqual([{ account_id: "kestrel.testnet" }, { serial: "S-000041" }, { serial: "S-000042" }]);
  });

  it("vendors, export_prices, listings, wrecks, impound, harbormaster and raid", async () => {
    const vendor = {
      id: "moss",
      account_id: "moss.saltline.testnet",
      name: "Moss",
      open: true,
      scrip: "1500",
      stock: { copper: "15", unobtainium: "1" },
      bids: [{ token_id: "copper", price: "45", reason: "Low." }],
      goods: [{ token_id: "comp", price: "168", stock: "2", reason: "Parts plus 35%." }],
      guns: [{ weapon: { ...W, state: "vendor" }, price: "1512" }],
      last_memo: "Built one.",
    };
    const { chain, viewCalls } = setup({
      views: {
        vendors: () => [vendor],
        export_prices: () => [{ token_id: "core", price: "96", reason: "One sent." }],
        listings: () => [
          { id: 3, seller: "a.testnet", callsign: "A", price: "900", at: 7, weapon: { ...W, state: "listed" }, item: null },
          { id: 2, seller: "a.testnet", callsign: "A", price: "120", at: 6, weapon: null, item: { token_id: "copper", amount: "3" } },
          { id: 1, seller: "a.testnet", callsign: "A", price: "5", at: 5, weapon: null, item: { token_id: "doubloon", amount: "3" } },
        ],
        wrecks: () => [WRECK_W, { ...WRECK_W, id: 5, weapon: null, items: [] }],
        impound: () => [{ weapon: { ...W, state: "impound" }, fee: "484", expires_at: 999 }],
        harbormaster: () => HM_W,
        raid: (a) => (a.raid_id === 7 ? RAID_W : null),
      },
    });
    expect(await chain.vendors()).toEqual([
      {
        id: "moss",
        accountId: "moss.saltline.testnet",
        name: "Moss",
        open: true,
        scrip: 1500,
        stock: { copper: 15 },
        bids: [{ tokenId: "copper", price: 45, reason: "Low." }],
        goods: [{ tokenId: "comp", price: 168, stock: 2, reason: "Parts plus 35%." }],
        guns: [{ weapon: { ...WEAPON, state: "vendor" }, price: 1512 }],
        lastMemo: "Built one.",
      },
    ]);
    expect(await chain.exportPrices()).toEqual([{ tokenId: "core", price: 96, reason: "One sent." }]);
    expect(await chain.listings()).toEqual([
      { id: 3, seller: "a.testnet", callsign: "A", price: 900, at: 7, weapon: { ...WEAPON, state: "listed" } },
      { id: 2, seller: "a.testnet", callsign: "A", price: 120, at: 6, item: { tokenId: "copper", amount: 3 } },
    ]);
    expect(await chain.wrecks()).toEqual([WRECK, { ...WRECK, id: 5, weapon: null, items: [] }]);
    expect(await chain.impound("kestrel.testnet")).toEqual([{ weapon: { ...WEAPON, state: "impound" }, fee: 484, expiresAt: 999 }]);
    expect(await chain.harbormaster()).toEqual(HM);
    expect(await chain.raid(7)).toEqual(RAID);
    expect(await chain.raid(8)).toBeNull();
    expect(viewCalls.map((c) => c.method)).toEqual(["vendors", "export_prices", "listings", "wrecks", "impound", "harbormaster", "raid", "raid"]);
    expect(viewCalls[4].args).toEqual({ account_id: "kestrel.testnet" });
    expect(viewCalls[6].args).toEqual({ raid_id: 7 });
  });

  it("recent clamps the limit and drops kinds it doesn't know; economy and leaderboard decode", async () => {
    const { chain, viewCalls } = setup({
      views: {
        recent: () => [
          { kind: "build", at: 9, account: "rook.testnet", callsign: "ROOK", text: "ROOK built a B-grade Pilot, S-000041." },
          { kind: "meteor", at: 8, account: "x", text: "?" },
          { kind: "posture", at: 7, account: "harbormaster.saltline.testnet", callsign: null, text: "Pursuit." },
        ],
        economy: () => ({ scrip_supply: "4800", minted_24h: "150", burned_24h: "30", players: 13, weapons_built: 3, weapons_alive: 2, weapons_destroyed: 1, last_sales: [{ frame: "pilot", grade: "B", prices: ["900", "950"] }] }),
        leaderboard: () => ({ net_worth: [{ account_id: "a", callsign: "A", value: "2000" }], extractions: [{ account_id: "a", callsign: "A", value: "4" }], makers: [] }),
      },
    });
    expect(await chain.recent(500)).toEqual([
      { kind: "build", at: 9, account: "rook.testnet", callsign: "ROOK", text: "ROOK built a B-grade Pilot, S-000041." },
      { kind: "posture", at: 7, account: "harbormaster.saltline.testnet", text: "Pursuit." },
    ]);
    await chain.recent(0);
    expect(viewCalls.map((c) => c.args)).toEqual([{ limit: 64 }, { limit: 1 }]);
    expect(await chain.economy()).toEqual({ scripSupply: 4800, minted24h: 150, burned24h: 30, players: 13, weaponsBuilt: 3, weaponsAlive: 2, weaponsDestroyed: 1, lastSales: [{ frame: "pilot", grade: "B", prices: [900, 950] }] });
    expect(await chain.leaderboard()).toEqual({ netWorth: [{ accountId: "a", callsign: "A", value: 2000 }], extractions: [{ accountId: "a", callsign: "A", value: 4 }], makers: [] });
  });

  it("rules, materials, frames and blueprints come back as the contract sent them", async () => {
    const { chain } = setup({ views: { rules: () => ({ raid: { carry_limit: 6 } }), materials: () => [{ id: "copper" }], frames: () => [], blueprints: () => [{ id: "ammo", yields: 4 }] } });
    expect(await chain.rules()).toEqual({ raid: { carry_limit: 6 } });
    expect(await chain.materials()).toEqual([{ id: "copper" }]);
    expect(await chain.frames()).toEqual([]);
    expect(await chain.blueprints()).toEqual([{ id: "ammo", yields: 4 }]);
  });

  it("U128: holds the largest exact integer and rejects anything it can't hold exactly", async () => {
    expect(decodeWeapon({ ...W, value: "9007199254740991" }).value).toBe(Number.MAX_SAFE_INTEGER);
    expect(decodeWeapon({ ...W, value: "0" }).value).toBe(0);
    for (const bad of ["9007199254740993", "340282366920938463463374607431768211455", "-1", "1.5", "1e3", "", "0x10", null, 1.5, -2]) {
      expect(() => decodeWeapon({ ...W, value: bad }), String(bad)).toThrow(/value/);
    }
    const { chain } = setup({ views: { balances: () => ({ scrip: "9007199254740993" }) } });
    await expect(chain.balances("a")).rejects.toThrow(/too large/);
  });

  it("rejects a shape it doesn't expect rather than showing a wrong number", async () => {
    expect(() => decodeWeapon({ ...W, state: "lost" })).toThrow(/state/);
    expect(() => decodeWeapon({ ...W, frame: "bazooka" })).toThrow(/frame/);
    expect(() => decodeWeapon({ ...W, serial: "41" })).toThrow(/serial/);
    expect(() => decodeWeapon({ ...W, condition: 101 })).toThrow(/over 100/);
    expect(() => decodeWeapon({ ...W, stats: { ...STATS, rpm: "340" } })).toThrow(/rpm/);
    expect(() => decodeHarbormaster({ ...HM_W, strength: 101 })).toThrow(/over 100/);
    expect(() => decodeHarbormaster({ ...HM_W, bonus_drones: 5 })).toThrow(/over 4/);
    expect(() => decodeHarbormaster({ ...HM_W, posture: "siege" })).toThrow(/posture/);
    const { chain } = setup({ views: { harbormaster: () => ({ ...HM_W, balance: undefined }), listings: () => [{ id: 1, seller: "a", callsign: "A", price: "1", at: 1, weapon: null, item: null }] } });
    await expect(chain.harbormaster()).rejects.toThrow(/harbormaster/);
    await expect(chain.listings()).rejects.toThrow(/neither/);
  });

  it("a failed view rejects, after retrying what is transient; it never becomes a default", async () => {
    let n = 0;
    const { chain, viewCalls } = setup({
      views: {
        wrecks: () => {
          if (n++ < 2) throw http503();
          return [];
        },
        listings: () => {
          throw http503();
        },
        economy: () => {
          throw panic("E_PAUSED: The dock is closed.");
        },
      },
    });
    expect(await chain.wrecks()).toEqual([]);
    expect(viewCalls.map((c) => c.attempt)).toEqual([0, 1, 2]);
    await expect(chain.listings()).rejects.toThrow(/isn't answering/);
    await expect(chain.economy()).rejects.toMatchObject({ code: "E_PAUSED", message: "The dock is closed." });
  });

  it("links to the explorer for a real hash and a real account, and to nothing otherwise", () => {
    const { chain } = setup();
    expect(chain.network).toBe("testnet");
    expect(chain.contractId).toBe(CONTRACT);
    expect(chain.txUrl(HASH)).toBe(`https://testnet.nearblocks.io/txns/${HASH}`);
    expect(chain.txUrl("mock-000001")).toBeNull();
    expect(chain.accountUrl("rook.testnet")).toBe(`${TESTNET_EXPLORER_ACCOUNT}rook.testnet`);
    expect(chain.accountUrl("a".repeat(64))).toBe(`https://testnet.nearblocks.io/address/${"a".repeat(64)}`);
    expect(chain.accountUrl("../evil?x=1")).toBeNull();
  });
});

describe("v2 chain: calls", () => {
  it("start_raid, extract and die prepay 30 Tgas and carry the loadout and the report", async () => {
    const { chain, sent } = setup({
      replies: [RAID_W, { minted: { core: "2", servo: "1" }, weapon: W, recovered: [W], invoice: "940", arrears: "235" }, { wreck_id: 12, impounded: false, invoice: "500", arrears: "50" }, { wreck_id: null, impounded: true, invoice: "1300", arrears: "130" }],
    });
    expect(await chain.startRaid({ weapon: null, plates: 1, charges: 0, mags: 2 })).toEqual({ ok: true, txHash: HASH, raid: RAID });
    expect(await chain.extract(7, REPORT)).toEqual({ ok: true, txHash: HASH, minted: { core: 2, servo: 1 }, weapon: WEAPON, recovered: [WEAPON], invoice: 940, arrears: 235 });
    expect(await chain.die(7, REPORT, 11, "machines")).toEqual({ ok: true, txHash: HASH, wreckId: 12, impounded: false, invoice: 500, arrears: 50 });
    expect(await chain.die(7, REPORT, 11, "bailiff")).toEqual({ ok: true, txHash: HASH, wreckId: null, impounded: true, invoice: 1300, arrears: 130 });
    expect(sent()).toEqual([
      { method: "start_raid", args: { loadout: { weapon: null, plates: 1, charges: 0, mags: 2 } }, gas: 30, deposit: undefined },
      { method: "extract", args: { raid_id: 7, report: REPORT }, gas: 30, deposit: undefined },
      { method: "die", args: { raid_id: 7, report: REPORT, spot: 11, by: "machines" }, gas: 30, deposit: undefined },
      { method: "die", args: { raid_id: 7, report: REPORT, spot: 11, by: "bailiff" }, gas: 30, deposit: undefined },
    ]);
    expect([GAS_RAID, GAS_REST]).toEqual([30, 20]);
  });

  it("the armoury's calls prepay 20 Tgas", async () => {
    const { chain, sent } = setup({
      replies: [{ weapon: W, minted: {} }, { weapon: null, minted: { ammo: "4" } }, { weapon: W }, { weapon: W, cost: "24" }, { weapon: W, cost: "82" }, { minted: { copper: "2", chips: "1" } }],
    });
    expect(await chain.build("pilot")).toEqual({ ok: true, txHash: HASH, weapon: WEAPON, minted: {} });
    expect(await chain.build("ammo")).toEqual({ ok: true, txHash: HASH, minted: { ammo: 4 } });
    expect(await chain.fit("S-000041", "optic")).toEqual({ ok: true, txHash: HASH, weapon: WEAPON });
    expect(await chain.repair("S-000041", 12)).toEqual({ ok: true, txHash: HASH, weapon: WEAPON, cost: 24 });
    expect(await chain.repair("S-000041")).toEqual({ ok: true, txHash: HASH, weapon: WEAPON, cost: 82 });
    expect(await chain.scrap("S-000041")).toEqual({ ok: true, txHash: HASH, minted: { copper: 2, chips: 1 } });
    expect(sent()).toEqual([
      { method: "build", args: { blueprint: "pilot" }, gas: 20, deposit: undefined },
      { method: "build", args: { blueprint: "ammo" }, gas: 20, deposit: undefined },
      { method: "fit", args: { serial: "S-000041", mod: "optic" }, gas: 20, deposit: undefined },
      { method: "repair", args: { serial: "S-000041", points: 12 }, gas: 20, deposit: undefined },
      { method: "repair", args: { serial: "S-000041", points: null }, gas: 20, deposit: undefined },
      { method: "scrap", args: { serial: "S-000041" }, gas: 20, deposit: undefined },
    ]);
  });

  it("vendor, export, market and arrears calls send amounts as U128 strings", async () => {
    const { chain, sent } = setup({
      replies: [{ paid: "132" }, { cost: "432" }, { weapon: W, cost: "1512" }, { paid: "288" }, { id: 4 }, { id: 5 }, { paid: "900", weapon: W }, { paid: "100", weapon: null }, {}, { cleared: "200", arrears: "101" }, { weapon: W, cost: "484" }],
    });
    expect(await chain.sell("moss", "copper", 3)).toEqual({ ok: true, txHash: HASH, paid: 132 });
    expect(await chain.buy("ines", "plate", 2)).toEqual({ ok: true, txHash: HASH, cost: 432 });
    expect(await chain.buyGun("moss", "S-000041")).toEqual({ ok: true, txHash: HASH, weapon: WEAPON, cost: 1512 });
    expect(await chain.exportGoods("core", 3)).toEqual({ ok: true, txHash: HASH, paid: 288 });
    expect(await chain.listWeapon("S-000041", 900)).toEqual({ ok: true, txHash: HASH, id: 4 });
    expect(await chain.listItem("copper", 3, 120)).toEqual({ ok: true, txHash: HASH, id: 5 });
    expect(await chain.buyListing(4)).toEqual({ ok: true, txHash: HASH, paid: 900, weapon: WEAPON });
    expect(await chain.buyListing(5)).toEqual({ ok: true, txHash: HASH, paid: 100 });
    expect(await chain.cancelListing(5)).toEqual({ ok: true, txHash: HASH });
    expect(await chain.settle(100)).toEqual({ ok: true, txHash: HASH, cleared: 200, arrears: 101 });
    expect(await chain.buyBack("S-000041")).toEqual({ ok: true, txHash: HASH, weapon: WEAPON, cost: 484 });
    expect(sent().map((s) => [(s as { method: string }).method, (s as { args: object }).args, (s as { gas: number }).gas])).toEqual([
      ["sell", { vendor: "moss", token_id: "copper", amount: "3" }, 20],
      ["buy", { vendor: "ines", token_id: "plate", amount: "2" }, 20],
      ["buy_gun", { vendor: "moss", serial: "S-000041" }, 20],
      ["export", { token_id: "core", amount: "3" }, 20],
      ["list_weapon", { serial: "S-000041", price: "900" }, 20],
      ["list_item", { token_id: "copper", amount: "3", price: "120" }, 20],
      ["buy_listing", { id: 4 }, 20],
      ["buy_listing", { id: 5 }, 20],
      ["cancel_listing", { id: 5 }, 20],
      ["settle", { amount: "100" }, 20],
      ["buy_back", { serial: "S-000041" }, 20],
    ]);
  });

  it("the agents' calls and the NFT transfer, which attaches 1 yoctoNEAR and nothing else does", async () => {
    const { chain, sent } = setup({ replies: [{ weapon: W, minted: {} }, {}, {}, HM_W, {}] });
    expect(await chain.vendorBuild("pilot", "Reach.")).toEqual({ ok: true, txHash: HASH, weapon: WEAPON, minted: {} });
    expect((await chain.vendorPrice({ serial: "S-000041" }, 1400, "A good one.")).ok).toBe(true);
    expect((await chain.vendorPrice({ tokenId: "ammo" }, 12, "Cheap.")).ok).toBe(true);
    expect(await chain.hmPosture("pursuit", "Receipts are up.")).toEqual({ ok: true, txHash: HASH, harbormaster: HM });
    expect((await chain.nftTransfer("S-000041", "rook.testnet")).ok).toBe(true);
    expect(sent()).toEqual([
      { method: "vendor_build", args: { blueprint: "pilot", memo: "Reach." }, gas: 20, deposit: undefined },
      { method: "vendor_price", args: { serial: "S-000041", token_id: null, price: "1400", memo: "A good one." }, gas: 20, deposit: undefined },
      { method: "vendor_price", args: { serial: null, token_id: "ammo", price: "12", memo: "Cheap." }, gas: 20, deposit: undefined },
      { method: "hm_posture", args: { posture: "pursuit", memo: "Receipts are up." }, gas: 20, deposit: undefined },
      { method: "nft_transfer", args: { receiver_id: "rook.testnet", token_id: "S-000041" }, gas: 20, deposit: 1n },
    ]);
  });

  it("refuses bad numbers before anything is signed", async () => {
    const { chain, specs } = setup();
    for (const r of [
      await chain.sell("moss", "copper", 0),
      await chain.buy("ines", "plate", 1.5),
      await chain.exportGoods("core", -1),
      await chain.listWeapon("S-000041", 0),
      await chain.listItem("copper", 2 ** 60, 1),
      await chain.settle(Number.NaN),
      await chain.repair("S-000041", 0),
      await chain.buyListing(-1),
      await chain.vendorPrice({}, 5, "x"),
      await chain.vendorPrice({ serial: "S-000041", tokenId: "ammo" }, 5, "x"),
      await chain.startRaid({ weapon: null, plates: 0.5, charges: 0, mags: 0 }),
    ]) {
      expect(r).toEqual({ ok: false, code: "E_BAD_AMOUNT", error: ERROR_TEXT2.E_BAD_AMOUNT });
    }
    expect(await chain.extract(7, { ...REPORT, uplinks: 1.5 })).toMatchObject({ ok: false, code: "E_BAD_REPORT" });
    expect(await chain.die(7, { ...REPORT, opened: [-1] }, 3, "machines")).toMatchObject({ ok: false, code: "E_BAD_REPORT" });
    expect(await chain.die(7, REPORT, 3, "gravity" as never)).toMatchObject({ ok: false, code: "E_BAD_REPORT" });
    expect(specs).toEqual([]);
  });

  it("a panic comes back as its code and message, and is never retried", async () => {
    const txs = [new ScriptTx([panic("E_WORN_OUT: That gun is worn out. It can only be scrapped.")]), new ScriptTx([panic("E_VENDOR_BROKE")]), new ScriptTx([panic("E_SOMETHING_NEW")])];
    const { chain } = setup({ txs: [...txs] });
    expect(await chain.startRaid({ weapon: "S-000041", plates: 0, charges: 0, mags: 0 })).toEqual({ ok: false, code: "E_WORN_OUT", error: "That gun is worn out. It can only be scrapped.", txHash: HASH });
    // A code with no text gets this contract's wording.
    expect(await chain.sell("moss", "copper", 1)).toEqual({ ok: false, code: "E_VENDOR_BROKE", error: ERROR_TEXT2.E_VENDOR_BROKE, txHash: HASH });
    expect(await chain.settle(1)).toMatchObject({ ok: false, code: "E_SOMETHING_NEW" });
    expect(txs.map((t) => [t.sends, t.resends])).toEqual([
      [1, 0],
      [1, 0],
      [1, 0],
    ]);
  });

  it("every documented error has a line a player can read", () => {
    const codes = "E_NOT_REGISTERED E_ALREADY_REGISTERED E_CALLSIGN_TAKEN E_BAD_CALLSIGN E_NOT_FAUCET E_NOT_VENDOR E_NOT_HARBORMASTER E_NOT_OWNER E_PAUSED E_NO_RAID E_RAID_CLOSED E_TOO_SOON E_NOT_IN_MANIFEST E_OVER_LIMIT E_DUPLICATE E_BAD_REPORT E_NO_WEAPON E_WEAPON_BUSY E_WORN_OUT E_SLOT_TAKEN E_FUNDS E_VENDOR_BROKE E_DOESNT_BUY E_DOESNT_SELL E_NO_STOCK E_NO_LISTING E_NOT_IMPOUNDED E_NOTHING_OWED E_BAD_AMOUNT E_FULL";
    expect(Object.keys(ERROR_TEXT2).sort()).toEqual(codes.split(" ").sort());
  });

  it("calls go through one queue, one at a time, in order", async () => {
    const order: string[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const first = new ScriptTx([
      async () => {
        order.push("first in flight");
        await gate;
        order.push("first done");
        return ok({ paid: "1" });
      },
    ]);
    const second = new ScriptTx([
      async () => {
        order.push("second in flight");
        return ok({ cost: "2" });
      },
    ]);
    const { chain, specs } = setup({ txs: [first, second] });
    const a = chain.sell("moss", "copper", 1);
    const b = chain.buy("ines", "ammo", 1);
    await new Promise((r) => setTimeout(r, 5));
    expect(order).toEqual(["first in flight"]);
    expect(chain.queued()).toBe(2);
    expect(specs).toHaveLength(1);
    release();
    expect([(await a).paid, (await b).cost]).toEqual([1, 2]);
    expect(order).toEqual(["first in flight", "first done", "second in flight"]);
    expect(chain.queued()).toBe(0);
  });

  it("a transient failure before signing is sent again; after signing, only the identical bytes are", async () => {
    const early = new ScriptTx([http503(), ok({ paid: "5" })], null, 1);
    const late = new ScriptTx([http503(), ok({ paid: "6" })]);
    const { chain } = setup({ txs: [early, late] });
    expect(await chain.exportGoods("core", 1)).toEqual({ ok: true, txHash: HASH, paid: 5 });
    expect([early.sends, early.resends]).toEqual([2, 0]);
    expect(await chain.exportGoods("core", 1)).toEqual({ ok: true, txHash: HASH, paid: 6 });
    expect([late.sends, late.resends]).toEqual([1, 1]);
  });

  it("a call that may have landed is pending, never failed", async () => {
    const lost = new ScriptTx([http503(), http503(), http503()]);
    const found = new ScriptTx([http503(), http503(), http503()], ok({ cleared: "200", arrears: "0" }));
    const { chain } = setup({ txs: [lost, found] });
    const r = await chain.extract(7, REPORT);
    expect(r).toMatchObject({ ok: false, pending: true, txHash: HASH });
    expect(r.code).toBeUndefined();
    expect([lost.sends, lost.resends, lost.statuses]).toEqual([1, 2, 1]);
    // Asked by hash, the chain says it landed: the reply is read as if it had come back the first time.
    expect(await chain.settle(100)).toEqual({ ok: true, txHash: HASH, cleared: 200, arrears: 0 });
  });

  it("a reply that doesn't parse is still a call that happened", async () => {
    const warn = console.warn;
    console.warn = () => undefined;
    try {
      const { chain } = setup({ replies: [{ paid: "not a number" }, { weapon: { ...W, state: "lost" }, cost: "1" }] });
      expect(await chain.sell("moss", "copper", 1)).toEqual({ ok: true, txHash: HASH });
      expect(await chain.buyBack("S-000041")).toEqual({ ok: true, txHash: HASH });
    } finally {
      console.warn = warn;
    }
  });

  it("without a wallet nothing is signed", async () => {
    const { chain, specs } = setup({ noKey: true });
    expect(await chain.startRaid({ weapon: null, plates: 0, charges: 0, mags: 0 })).toMatchObject({ ok: false, error: "No wallet yet. Claim your dock pass." });
    expect(specs).toEqual([]);
  });
});
