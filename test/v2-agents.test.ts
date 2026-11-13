// v2's characters (agents/v2/): Moss, Ines and the Harbormaster, driven against the real offline mock with a fixed
// seed and clock. Every move goes through `mock.as(account)`, so the mock's own rules accept or refuse it exactly as
// the contract would. Nothing here touches a network or signs a real transaction.
import { generateKey } from "near-kit";
import { describe, expect, it } from "vitest";
import { Benched, type KeyLookup, NEAR_AI_BASE_URL, type VoiceConfig, exitCode, findKeyNamed } from "../agents/brokers";
import {
  CHARACTER_IDS,
  type CharacterId,
  type Decision2,
  HM,
  MEMO_MAX,
  MOSS,
  TEMPLATES2,
  type Why2,
  ceilingPrice,
  checkMove2,
  decideVendor,
  defaultGunPrice,
  describeMove2,
  fill2,
  floorPrice,
  memoFor2,
  moss,
  openingPrice,
  raidEndings,
} from "../agents/v2/characters";
import { type Acts, ENV_KEYS_V2, type Line2, type RoundDeps2, accountFor, formatLine2, main, runRoundV2 } from "../agents/v2/run";
import { METHOD_NOT_FOUND } from "../src/economy/chain";
import { MOCK2_STORAGE_KEY, type MockChain2, createMockChain2 } from "../src/economy/v2/mock";
import type { RaidReport, Vendor } from "../src/economy/v2/types";

const T0 = Date.UTC(2026, 10, 13, 12, 0, 0);
const HOUR = 3_600_000;
const KEYS: Record<CharacterId, `ed25519:${string}`> = {
  moss: generateKey().secretKey as `ed25519:${string}`,
  ines: generateKey().secretKey as `ed25519:${string}`,
  harbormaster: generateKey().secretKey as `ed25519:${string}`,
};
const EMPTY: RaidReport = { opened: [], wrecks: [], parts: { servo: 0, rotor: 0 }, kills: { gull: 0, hound: 0 }, uplinks: 0, used: { plates: 0, charges: 0, mags: 0 } };

interface World {
  mock: MockChain2;
  /** Accounts a call was signed as, in order. */
  signed: string[];
  advance(ms: number): void;
  deps(over?: Partial<RoundDeps2>): RoundDeps2;
  round(over?: Partial<RoundDeps2>): Promise<Record<CharacterId, Line2>>;
  vendor(id: "moss" | "ines"): Promise<Vendor>;
  /** Registers the local player with a full locker. */
  player(): Promise<void>;
  /** The player goes over the fence and reaches the boat, or dies leaving a wreck. */
  raid(end: "extract" | "die"): Promise<void>;
}

/**
 * `park`: the mock's `ambient` also runs its own built-in agents on the same three accounts, and has no switch for
 * them. Each waits a while after its last act, so the saved state is edited once to put that last act far in the
 * future, and the mock is loaded again from it. The other players' ambient play is untouched.
 */
function world(seed = 7, park = false): World {
  let t = T0;
  let mock = createMockChain2(seed, { storage: null, now: () => t, stash: null });
  if (park) {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) } as Storage;
    createMockChain2(seed, { storage, now: () => t, stash: null });
    const saved = JSON.parse(store.get(MOCK2_STORAGE_KEY)!);
    saved.vendors.moss.lastActAt = saved.vendors.ines.lastActAt = saved.hm.lastActAt = T0 + 100_000 * HOUR;
    store.set(MOCK2_STORAGE_KEY, JSON.stringify(saved));
    mock = createMockChain2(seed, { storage, now: () => t, stash: null });
  }
  const signed: string[] = [];
  const deps = (over: Partial<RoundDeps2> = {}): RoundDeps2 => ({
    reads: mock,
    act: (key) => {
      signed.push(key.accountId);
      return mock.as(key.accountId);
    },
    contractId: mock.contractId,
    key: async (who, accountId) => ({ ok: true, key: { accountId, privateKey: KEYS[who], source: "env" } }),
    now: () => mock.now(),
    seed: 1,
    ...over,
  });
  const w: World = {
    mock,
    signed,
    advance: (ms) => void (t += ms),
    deps,
    async round(over) {
      const lines = await runRoundV2(deps(over));
      expect(lines.map((l) => l.who)).toEqual([...CHARACTER_IDS]); // one line, so at most one move, each
      return Object.fromEntries(lines.map((l) => [l.who, l])) as Record<CharacterId, Line2>;
    },
    vendor: async (id) => (await mock.vendors()).find((v) => v.id === id) as Vendor,
    async player() {
      expect((await mock.register(mock.me(), "TESTER")).ok).toBe(true);
      mock.debug.give({ scrip: 5000, copper: 60, chips: 40, fuel: 40, rotor: 40, servo: 20, core: 20 });
    },
    async raid(end) {
      w.advance(31_000);
      const started = await mock.startRaid({ weapon: null, plates: 0, charges: 0, mags: 0 });
      expect(started.ok).toBe(true);
      const raid = started.raid!;
      w.advance(90_000);
      // A death only reaches the ledger when it leaves a wreck, so the dead carry one container's cargo.
      const r = end === "extract" ? await mock.extract(raid.raidId, EMPTY) : await mock.die(raid.raidId, { ...EMPTY, opened: [raid.containers[0].spot] }, 3, "machines");
      expect(r.ok).toBe(true);
    },
  };
  return w;
}

/** A seed whose two genesis guns are both C or D (so Moss's first move isn't a price), or one with an A or B. */
function seedWhere(want: "plain" | "graded"): number {
  for (let seed = 1; seed < 400; seed++) {
    const guns = Object.values(createMockChain2(seed, { storage: null, now: () => T0, stash: null }).snapshot().weapons);
    const graded = guns.some((g) => g.grade === "A" || g.grade === "B");
    if (graded === (want === "graded")) return seed;
  }
  throw new Error("no such seed");
}
const PLAIN = seedWhere("plain");
const GRADED = seedWhere("graded");

const GUN_BUILD = /^build (longshore|stevedore|pilot)$/;

/** Rounds until Moss holds, with what she did on the way. */
async function untilMossHolds(w: World, max = 24): Promise<string[]> {
  const did: string[] = [];
  for (let i = 0; i < max; i++) {
    const l = (await w.round()).moss;
    if (l.status !== "sent") return did;
    did.push(l.action);
  }
  throw new Error(`Moss never held: ${did.join(", ")}`);
}

// ---------------------------------------------------------------------------------------------------------------

describe("Moss", () => {
  it("builds the frame her rack lacks, from her own parts, and signs a memo", async () => {
    const w = world(PLAIN);
    const before = await w.vendor("moss");
    expect(before.guns.map((g) => g.weapon.frame).sort()).toEqual(["longshore", "stevedore"]);
    const l = (await w.round()).moss;
    expect(l).toMatchObject({ status: "sent", action: "build pilot", voice: "template" });
    const after = await w.vendor("moss");
    expect(after.guns.map((g) => g.weapon.frame).sort()).toEqual(["longshore", "pilot", "stevedore"]);
    expect(after.stock.core).toBe((before.stock.core ?? 0) - 1);
    expect(after.scrip).toBe(before.scrip); // a vendor's build pays no fee
    expect(after.lastMemo).toBe(l.memo);
    expect(w.signed).toContain(w.mock.vendorAccount("moss"));
  });

  it("prices a fresh A or B above the default, once", async () => {
    const w = world(GRADED);
    const gun = (await w.vendor("moss")).guns.find((g) => g.weapon.grade === "A" || g.weapon.grade === "B")!;
    expect(gun.price).toBe(defaultGunPrice(gun.weapon));
    const want = Math.floor((gun.weapon.value * MOSS.premiumPct[gun.weapon.grade]!) / 100);
    const l = (await w.round()).moss;
    expect(l).toMatchObject({ status: "sent", action: `price ${gun.weapon.serial} at ${want}` });
    expect(want).toBeGreaterThan(gun.price);
    expect((await w.vendor("moss")).guns.find((g) => g.weapon.serial === gun.weapon.serial)!.price).toBe(want);
    expect((await w.round()).moss.action).not.toBe(l.action);
  });

  it("with every frame racked, builds the one the market has been buying", async () => {
    const w = world(PLAIN);
    await w.player();
    const mine = w.mock.debug.giveGun("stevedore", { grade: "C" });
    const listed = await w.mock.listWeapon(mine.serial, 100);
    expect((await w.mock.register("buyer.mock", "BUYER")).ok).toBe(true);
    expect((await w.mock.as("buyer.mock").buyListing(listed.id!)).ok).toBe(true);
    expect((await w.mock.economy()).lastSales).toEqual([{ frame: "stevedore", grade: "C", prices: [100] }]);
    // The frame the rack lacked first, then the one that sold. Four racked is a full rack, whatever sells.
    const did = await untilMossHolds(w);
    expect(did.filter((a) => GUN_BUILD.test(a))).toEqual(["build pilot", "build stevedore"]);
    expect((await w.vendor("moss")).guns).toHaveLength(4);
    expect((await w.vendor("moss")).lastMemo).not.toBeNull();
  });

  it("with every frame racked and no sales to go on, the fourth is a Longshore", async () => {
    const w = world(PLAIN);
    expect((await w.mock.economy()).lastSales).toEqual([]);
    expect((await untilMossHolds(w)).filter((a) => GUN_BUILD.test(a))).toEqual(["build pilot", "build longshore"]);
    // Sales that couldn't be read are not "no sales": on the same board she builds a gun only once they are known.
    const v = await w.vendor("moss");
    const board = { vendor: { ...v, guns: v.guns.slice(0, 3), stock: { copper: 9, chips: 9, servo: 4, rotor: 4, core: 1 } }, quotes: [], now: T0 };
    expect(GUN_BUILD.test(describeMove2(moss(board).move))).toBe(false);
    const known = moss({ ...board, economy: { lastSales: [] } });
    expect(known.move).toEqual({ action: "build", blueprint: "longshore" });
    expect(memoFor2("moss", known, 1)).toMatch(/Longshore/);
  });

  it("while the contract has no economy view yet, she reads no sales and still moves; any other failure holds her", async () => {
    const w = world(PLAIN);
    const missing = () => Promise.reject(Object.assign(new Error("economy: the contract has no economy view yet"), { code: METHOD_NOT_FOUND }));
    const reads = { ...w.mock, economy: missing };
    const did: string[] = [];
    for (let i = 0; i < 12; i++) {
      const lines = await w.round({ reads });
      expect(lines.moss.unknown).toBeUndefined();
      if (lines.moss.status !== "sent") break;
      did.push(lines.moss.action);
    }
    expect(did.filter((a) => GUN_BUILD.test(a))).toEqual(["build pilot", "build longshore"]);
    const other = await world(PLAIN).round({ reads: { ...w.mock, economy: () => Promise.reject(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })) } });
    expect(other.moss).toMatchObject({ status: "held", action: "hold", unknown: true });
  });

  it("marks a gun down 10% once it has sat six hours, again each six hours, never under 90% of appraisal", async () => {
    const w = world(PLAIN);
    await untilMossHolds(w);
    const first = (await w.vendor("moss")).guns.find((g) => g.weapon.serial === "S-000001")!;
    w.advance(6 * HOUR);
    expect((await w.round()).moss.status).toBe("held"); // six hours exactly isn't over six hours
    w.advance(60_000);
    const cut = Math.floor((first.price * 90) / 100);
    const l = (await w.round()).moss;
    expect(l).toMatchObject({ status: "sent", action: `price S-000001 at ${cut}` });
    expect(l.memo).toMatch(/S-000001/);
    // The other three are as old: one cut each, then she waits for the next six hours.
    const rest = await untilMossHolds(w);
    expect(rest).toHaveLength(3);
    expect(rest[0]).toBe(`price S-000002 at ${Math.floor((defaultGunPrice((await w.vendor("moss")).guns.find((g) => g.weapon.serial === "S-000002")!.weapon) * 90) / 100)}`);
    expect(rest[1]).toMatch(/^price S-000003 at \d+$/);
    expect(rest[2]).toMatch(/^price S-000004 at \d+$/);
    for (let i = 0; i < 12; i++) {
      w.advance(6 * HOUR);
      await untilMossHolds(w);
    }
    const guns = (await w.vendor("moss")).guns;
    for (const g of guns) expect(g.price).toBeGreaterThanOrEqual(floorPrice(g.weapon));
    expect(guns.find((g) => g.weapon.serial === "S-000001")!.price).toBe(floorPrice(first.weapon));
  });

  it("makes mods once three guns are racked, two of each, and none before", async () => {
    const w = world(PLAIN);
    const did = await untilMossHolds(w);
    expect(did[0]).toBe("build pilot");
    const mods = did.filter((a) => /^build (mag2|barrel2|comp|optic)$/.test(a));
    expect(mods.length).toBeGreaterThan(0);
    for (const g of (await w.vendor("moss")).goods) expect(g.stock).toBeLessThanOrEqual(MOSS.modShelf);
    // Two racked: the same parts, no mod.
    const v = await w.vendor("moss");
    const two = moss({ vendor: { ...v, guns: v.guns.slice(0, 2), goods: v.goods.map((g) => ({ ...g, stock: 0 })), stock: { copper: 3 } }, quotes: [], now: T0 });
    expect(two.move).toEqual({ action: "hold" });
  });

  it("ships what she holds over twice its target to the freighter, and keeps the scrip", async () => {
    const w = world(PLAIN);
    await untilMossHolds(w);
    await w.player();
    expect((await w.mock.sell("moss", "rotor", 20)).ok).toBe(true);
    const before = await w.vendor("moss");
    const did = await untilMossHolds(w);
    const shipped = did.filter((a) => a.startsWith("export "));
    expect(shipped.length).toBeGreaterThan(0);
    expect(shipped.every((a) => / rotor$/.test(a) && Number(a.split(" ")[1]) <= MOSS.lot)).toBe(true);
    const after = await w.vendor("moss");
    expect(after.stock.rotor).toBe(16); // twice the target of 8, and no lower
    expect(after.scrip).toBeGreaterThan(before.scrip);
    expect((await w.mock.recent(8)).some((e) => e.kind === "export" && e.account === w.mock.vendorAccount("moss"))).toBe(true);
  });

  it("doesn't ship into a flooded desk: under half the book price, the surplus stays in the shed", async () => {
    const w = world(PLAIN);
    await untilMossHolds(w);
    await w.player();
    expect((await w.mock.exportGoods("rotor", 30)).ok).toBe(true); // the player floods the desk
    expect((await w.mock.exportPrices()).find((q) => q.tokenId === "rotor")!.price).toBeLessThan(15); // of a book 30
    w.mock.debug.give("rotor", 30);
    expect((await w.mock.sell("moss", "rotor", 20)).ok).toBe(true);
    expect((await untilMossHolds(w)).filter((a) => a.startsWith("export "))).toEqual([]);
    const v = await w.vendor("moss");
    expect(v.stock.rotor).toBeGreaterThan(16);
    const board = { vendor: v, quotes: await w.mock.exportPrices(), now: T0 };
    expect(checkMove2("moss", board, { action: "export", tokenId: "rotor", amount: 1 })).toMatch(/under 50% of book/);
  });

  it("holds when nothing fits, with a line in her voice and nothing signed", async () => {
    const w = world(PLAIN);
    await untilMossHolds(w);
    const n = w.signed.length;
    const l = (await w.round()).moss;
    expect(l).toMatchObject({ status: "held", action: "hold" });
    expect(TEMPLATES2.moss.steady).toContain(l.memo);
    expect(w.signed).toHaveLength(n);
  });

  it("the price schedule: the opening price, one cut per six hours, the floor", async () => {
    const gun = (await world(GRADED).vendor("moss")).guns.find((g) => g.weapon.grade === "A" || g.weapon.grade === "B")!.weapon;
    expect(openingPrice(gun)).toBeGreaterThan(defaultGunPrice(gun));
    expect(ceilingPrice(gun, gun.builtAt + 5 * HOUR)).toBe(openingPrice(gun));
    expect(ceilingPrice(gun, gun.builtAt + 7 * HOUR)).toBe(Math.floor((openingPrice(gun) * 90) / 100));
    expect(ceilingPrice(gun, gun.builtAt + 400 * HOUR)).toBe(floorPrice(gun));
    expect(floorPrice(gun)).toBeGreaterThanOrEqual((gun.value * 90) / 100);
  });
});

describe("Ines", () => {
  it("restocks the shortest shelf first, from her own parts", async () => {
    const w = world();
    await w.player();
    await w.mock.buy("ines", "plate", 5); // 5 of 6
    await w.mock.buy("ines", "charge", 4); // 6 of 8: shorter
    const before = await w.vendor("ines");
    const first = (await w.round()).ines;
    expect(first).toMatchObject({ status: "sent", action: "build charge" });
    const mid = await w.vendor("ines");
    expect(mid.goods.find((g) => g.tokenId === "charge")!.stock).toBe(12);
    expect(mid.stock.fuel).toBe((before.stock.fuel ?? 0) - 1);
    expect(mid.lastMemo).toBe(first.memo);
    expect((await w.round()).ines).toMatchObject({ status: "sent", action: "build plate" });
    expect((await w.round()).ines).toMatchObject({ status: "held", action: "hold" });
  });

  it("restocks magazines under 24, and not a shelf she has no parts for", async () => {
    const w = world();
    await w.player();
    await w.mock.buy("ines", "ammo", 17); // 23 of 24
    expect((await w.round()).ines).toMatchObject({ status: "sent", action: "build ammo" });
    const v = await w.vendor("ines");
    const empty = decideVendor("ines", { vendor: { ...v, stock: {}, goods: v.goods.map((g) => ({ ...g, stock: 0 })) }, quotes: [], now: T0 });
    expect(empty.move).toEqual({ action: "hold" });
  });

  it("ships fuel held over twice its target when her scrip is under 600, and not before", async () => {
    const w = world();
    await w.player();
    await w.mock.sell("ines", "fuel", 11);
    let v = await w.vendor("ines");
    expect(v.stock.fuel).toBe(17);
    expect(v.scrip).toBeGreaterThanOrEqual(600);
    expect((await w.round()).ines).toMatchObject({ status: "held", action: "hold" }); // over the line, but the till is fine
    await w.mock.sell("ines", "fuel", 3);
    v = await w.vendor("ines");
    expect(v.scrip).toBeLessThan(600);
    const l = (await w.round()).ines;
    expect(l).toMatchObject({ status: "sent", action: "export 4 fuel" });
    const after = await w.vendor("ines");
    expect(after.stock.fuel).toBe(16);
    expect(after.scrip).toBeGreaterThan(v.scrip);
  });

  it("otherwise holds", async () => {
    const l = (await world().round()).ines;
    expect(l).toMatchObject({ status: "held", action: "hold" });
    expect(TEMPLATES2.ines.steady!.some((t) => l.memo === fill2(t, { move: { action: "hold" }, why: "steady", say: { scrip: 1500 } }))).toBe(true);
  });
});

describe("the Harbormaster", () => {
  it("counts the last raid endings in the ledger: boats reached against wrecks and impounds", async () => {
    const w = world();
    await w.player();
    await w.raid("extract");
    await w.raid("die");
    await w.raid("extract");
    expect(raidEndings(await w.mock.recent(64))).toEqual({ extractions: 2, deaths: 1 });
  });

  it("orders pursuit when Breachers are getting away and it has the strength, and only moves on a change", async () => {
    const w = world();
    await w.player();
    for (let i = 0; i < 3; i++) await w.raid("extract");
    // Getting away, but it has no money: patrols stand.
    expect((await w.mock.harbormaster()).strength).toBeLessThan(HM.minStrength);
    expect((await w.round()).harbormaster).toMatchObject({ status: "held", action: "hold" });

    w.mock.debug.payHarbormaster(700);
    expect((await w.mock.harbormaster()).strength).toBeGreaterThanOrEqual(HM.minStrength);
    const l = (await w.round()).harbormaster;
    expect(l).toMatchObject({ status: "sent", action: "posture pursuit" });
    const h = await w.mock.harbormaster();
    expect(h.posture).toBe("pursuit");
    expect(h.lastMemo).toBe(l.memo);
    expect(h.bailiffAt).toBeLessThan(1200);
    expect(w.signed.at(-1)).toBe(h.accountId);
    expect((await w.round()).harbormaster).toMatchObject({ status: "held", action: "hold" });

    // Two wrecks against three boats: no longer more than twice. Back to patrols.
    await w.raid("die");
    await w.raid("die");
    const back = (await w.round()).harbormaster;
    expect(back).toMatchObject({ status: "sent", action: "posture patrols" });
    expect(TEMPLATES2.harbormaster.patrols).toContain(back.memo);
    expect((await w.mock.harbormaster()).posture).toBe("patrols");
  });

  it("stands pursuit down when its balance has decayed under the strength it needs", async () => {
    const w = world();
    await w.player();
    for (let i = 0; i < 3; i++) await w.raid("extract");
    w.mock.debug.payHarbormaster(700);
    expect((await w.round()).harbormaster.action).toBe("posture pursuit");
    w.advance(24 * HOUR); // two half-lives
    const l = (await w.round()).harbormaster;
    expect(l).toMatchObject({ status: "sent", action: "posture patrols" });
    expect(l.memo).toMatch(/[Rr]eceipts/);
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe("a round", () => {
  it("fails closed: a view that can't be read leaves only the characters that need it without a move", async () => {
    const w = world(PLAIN);
    const down = () => Promise.reject(new Error("rpc down"));
    let lines = await w.round({ reads: { ...w.mock, vendors: down } });
    expect(lines.moss).toMatchObject({ status: "held", action: "hold", unknown: true });
    expect(lines.ines).toMatchObject({ status: "held", unknown: true });
    expect(lines.moss.note).toContain("state unknown");
    expect(lines.harbormaster.unknown).toBeUndefined();
    expect(exitCode(Object.values(lines))).toBe(2);
    expect(w.signed).toEqual([]);

    lines = await w.round({ reads: { ...w.mock, economy: down, recent: down } });
    expect(lines.moss.unknown).toBe(true); // she reads the market's sales
    expect(lines.ines.unknown).toBeUndefined();
    expect(lines.harbormaster).toMatchObject({ status: "held", unknown: true });
    expect(w.signed).toEqual([]);

    lines = await w.round({ reads: { ...w.mock, exportPrices: down, harbormaster: down } });
    expect([lines.moss.unknown, lines.ines.unknown, lines.harbormaster.unknown]).toEqual([true, true, true]);
    expect(w.signed).toEqual([]);
  });

  it("holds a character whose account isn't the one expected for this contract", async () => {
    const w = world(PLAIN);
    expect(accountFor("moss", "v2.saltline.testnet")).toBe("moss.saltline.testnet");
    expect(accountFor("harbormaster", "v2.saltline.testnet")).toBe("harbormaster.saltline.testnet");
    const lines = await w.round({ contractId: "v2.elsewhere.testnet" });
    for (const l of Object.values(lines)) expect(l).toMatchObject({ status: "held", unknown: true });
    expect(w.signed).toEqual([]);
  });

  it("a move that doesn't add up against the board is a hold", async () => {
    const w = world(PLAIN);
    const v = await w.vendor("moss");
    const board = { vendor: v, quotes: await w.mock.exportPrices(), now: T0 };
    expect(checkMove2("moss", board, { action: "build", blueprint: "plate" })).toMatch(/doesn't make/);
    expect(checkMove2("ines", { ...board, vendor: await w.vendor("ines") }, { action: "build", blueprint: "pilot" })).toMatch(/doesn't make/);
    expect(checkMove2("moss", { ...board, vendor: { ...v, stock: {} } }, { action: "build", blueprint: "pilot" })).toMatch(/parts/);
    expect(checkMove2("moss", board, { action: "price", serial: "S-000099", price: 900 })).toMatch(/rack/);
    expect(checkMove2("moss", board, { action: "price", serial: "S-000001", price: floorPrice(v.guns[0].weapon) - 1 })).toMatch(/90%/);
    expect(checkMove2("moss", board, { action: "export", tokenId: "copper", amount: 999 })).toMatch(/holds/);
    expect(checkMove2("moss", { ...board, quotes: [] }, { action: "export", tokenId: "copper", amount: 1 })).toMatch(/no price/);
    expect(checkMove2("moss", board, { action: "posture", posture: "pursuit" })).toMatch(/Harbormaster/);
    const h = { harbormaster: await w.mock.harbormaster(), recent: [] };
    expect(checkMove2("harbormaster", h, { action: "posture", posture: "patrols" })).toMatch(/already/);
    expect(checkMove2("harbormaster", h, { action: "build", blueprint: "pilot" })).toMatch(/only sets its posture/);
    // A board whose parts vanished between the rules and the check: the round holds and says why.
    const d = decideVendor("moss", { ...board, vendor: { ...v, guns: [], stock: { copper: 1 } } });
    expect(d.move).toEqual({ action: "hold" });
  });

  it("logs a refusal and doesn't send it again while it is benched", async () => {
    const w = world(PLAIN);
    let calls = 0;
    const refusing = (accountId: string): Acts => ({
      ...w.mock.as(accountId),
      vendorBuild: async () => {
        calls++;
        return { ok: false, code: "E_NO_STOCK", error: "Moss hasn't the parts." };
      },
    });
    let now = T0;
    const bench = new Benched(() => now);
    const over = { act: (k: { accountId: string }) => refusing(k.accountId), bench };
    const first = (await w.round(over)).moss;
    expect(first).toMatchObject({ status: "refused", action: "build pilot" });
    expect(first.note).toContain("E_NO_STOCK");
    expect(exitCode([first])).toBe(0);
    const second = (await w.round(over)).moss;
    expect(second).toMatchObject({ status: "held", action: "hold" });
    expect(second.note).toMatch(/build pilot was refused; benched until/);
    expect(calls).toBe(1);
    now += HOUR + 1;
    expect((await w.round(over)).moss.status).toBe("refused");
    expect(calls).toBe(2);
  });

  it("the contract refuses a key that isn't the character's own, and the round reports it", async () => {
    const w = world(PLAIN);
    const bench = new Benched(() => T0);
    const over = { act: () => w.mock.as("stranger.mock"), bench };
    const lines = await w.round(over);
    expect(lines.moss).toMatchObject({ status: "refused", action: "build pilot" });
    expect(lines.moss.note).toContain("E_NOT_VENDOR");
    expect((await w.vendor("moss")).guns).toHaveLength(2);
    expect((await w.round(over)).moss.note).toMatch(/benched/);
  });

  it("an unconfirmed call is pending, never failed, and nothing more is sent for a while", async () => {
    const w = world(PLAIN);
    const bench = new Benched(() => T0);
    const over = { act: (k: { accountId: string }) => ({ ...w.mock.as(k.accountId), vendorBuild: async () => ({ ok: false, pending: true, txHash: "HASH" }) }) as Acts, bench };
    const l = (await w.round(over)).moss;
    expect(l).toMatchObject({ status: "pending", txHash: "HASH" });
    expect(exitCode([l])).toBe(2);
    expect((await w.round(over)).moss).toMatchObject({ status: "held", action: "hold" });
  });

  it("a missing key skips only that character", async () => {
    const w = world(PLAIN);
    await w.player();
    await w.mock.buy("ines", "charge", 4);
    const key = async (who: CharacterId, accountId: string): Promise<KeyLookup> =>
      who === "moss" ? { ok: false, why: "no key: set BROKER_MOSS_KEY" } : { ok: true, key: { accountId, privateKey: KEYS[who], source: "env" } };
    const lines = await w.round({ key });
    expect(lines.moss).toMatchObject({ status: "skipped", note: "no key: set BROKER_MOSS_KEY" });
    expect(lines.ines).toMatchObject({ status: "sent", action: "build charge" });
    expect(w.signed).toEqual([w.mock.vendorAccount("ines")]);
    expect(exitCode(Object.values(lines))).toBe(0);
  });

  it("a dry run decides and signs nothing, with or without keys", async () => {
    const w = world(PLAIN);
    const before = JSON.stringify(await w.mock.vendors());
    const tx = w.mock.snapshot().nextTx;
    let lines = await w.round({ dryRun: true });
    expect(lines.moss).toMatchObject({ status: "dry-run", action: "build pilot" });
    expect(lines.moss.note).toBe(`would sign as ${w.mock.vendorAccount("moss")} (key from env)`);
    lines = await w.round({ dryRun: true, key: async () => ({ ok: false, why: "no key: set BROKER_MOSS_KEY" }) });
    expect(lines.moss).toMatchObject({ status: "dry-run", note: "would skip: no key: set BROKER_MOSS_KEY" });
    expect(w.signed).toEqual([]);
    expect(w.mock.snapshot().nextTx).toBe(tx);
    expect(JSON.stringify(await w.mock.vendors())).toBe(before);
  });

  it("reads keys from env or the keychain file, and never prints one", async () => {
    const w = world(PLAIN);
    const env = { BROKER_MOSS_KEY: KEYS.moss, HARBORMASTER_KEY: "not-a-key" };
    const file = JSON.stringify({ public_key: "ed25519:x", private_key: KEYS.ines });
    const secrets: string[] = [];
    const read = async (path: string) => (path.endsWith("ines.saltline.mock.json") ? file : Promise.reject(Object.assign(new Error("none"), { code: "ENOENT" })));
    const key = (who: CharacterId, accountId: string) => findKeyNamed(ENV_KEYS_V2[who], accountId, env, { credentialsDir: "/keys", read, onSecret: (s) => secrets.push(s) });
    expect(await key("moss", "moss.saltline.mock")).toMatchObject({ ok: true, key: { source: "env" } });
    expect(await key("ines", "ines.saltline.mock")).toMatchObject({ ok: true, key: { source: "keychain", privateKey: KEYS.ines } });
    expect(await key("harbormaster", "harbormaster.saltline.mock")).toEqual({ ok: false, why: "HARBORMASTER_KEY is set but isn't an ed25519 secret key" });
    const lines = Object.values(await w.round({ key, dryRun: true }));
    const text = lines.map((l) => formatLine2({ ...l, memo: `${l.memo ?? ""} ${KEYS.moss}`, note: `${l.note ?? ""} ${KEYS.ines}` }, secrets)).join("\n");
    for (const k of Object.values(KEYS)) expect(text).not.toContain(k);
    expect(text).toContain("<redacted>");
  });

  it("the command line: usage, and a bad argument or network is refused before anything runs", async () => {
    const out: string[] = [];
    expect(await main(["--help"], {}, (l) => out.push(l))).toBe(0);
    expect(out.join("\n")).toMatch(/HARBORMASTER_KEY[\s\S]*CONTRACT_ID_V2/);
    const err: string[] = [];
    expect(await main(["--sign-everything"], {}, () => {}, (l) => err.push(l))).toBe(1);
    expect(await main(["--once"], { NEAR_NETWORK: "mainnet" }, () => {}, (l) => err.push(l))).toBe(1);
    expect(await main(["--once"], { CONTRACT_ID_V2: "Not An Account" }, () => {}, (l) => err.push(l))).toBe(1);
    expect(err).toHaveLength(3);
  });
});

describe("memos", () => {
  const big: Decision2["say"] = {
    serial: "S-999999",
    grade: "A",
    frame: "Longshore",
    price: 99_999,
    was: 99_999,
    hours: 999,
    sales: 15,
    mod: "extended magazine",
    have: "1 extended magazine",
    count: "6 boxes of electronics",
    things: "boxes of electronics",
    each: 100,
    made: 6,
    scrip: 99_999,
    out: 20,
    lost: 20,
    raids: 20,
    balance: 99_999,
    strength: 100,
  };

  it("every template fits in 90 characters with the largest values it can meet, and leaves no placeholder", () => {
    for (const who of CHARACTER_IDS) {
      for (const [why, templates] of Object.entries(TEMPLATES2[who])) {
        for (const t of templates!) {
          const memo = fill2(t, { move: { action: "hold" }, why: why as Why2, say: big });
          expect(t.match(/\{(\w+)\}/g)?.every((k) => k.slice(1, -1) in big) ?? true, `${who}/${why}: ${t}`).toBe(true);
          expect(memo.length, `${who}/${why}: ${memo}`).toBeLessThanOrEqual(MEMO_MAX);
          expect(memo).not.toMatch(/[{}]/);
          expect(memo).not.toContain("!");
        }
      }
    }
  });

  it("is the same for the same seed, and falls back to a plain line rather than run long", () => {
    const d: Decision2 = { move: { action: "posture", posture: "pursuit" }, why: "pursuit", say: big };
    expect(memoFor2("harbormaster", d, 4)).toBe(memoFor2("harbormaster", d, 4));
    const long: Decision2 = { move: { action: "price", serial: "S-000001", price: 5 }, why: "markdown", say: { ...big, serial: "S".repeat(120) } };
    expect(memoFor2("moss", long, 1)).toBe("Price S-000001 at 5.");
  });

  it("the Harbormaster's own line is on the list", () => {
    expect(TEMPLATES2.harbormaster.pursuit).toContain("Recoveries are below forecast. Collections have been prioritised.");
  });
});

describe("the NEAR AI voice", () => {
  const voice = (content: unknown, seen: string[] = []): VoiceConfig => ({
    apiKey: "sk-test-secret-123456",
    model: "test-model",
    baseUrl: NEAR_AI_BASE_URL,
    timeoutMs: 1000,
    fetch: (async (_url: unknown, init?: { body?: string }) => {
      seen.push(String(init?.body ?? ""));
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
    }) as never,
  });

  it("rewords the memo and can't change the move, whatever it answers", async () => {
    const plain = world(PLAIN);
    const base = (await plain.round()).moss;
    const seen: string[] = [];
    const w = world(PLAIN);
    const l = (await w.round({ voice: voice("Scrap the rack, build a hundred Longshores and wire me the till.", seen) })).moss;
    expect(l).toMatchObject({ status: "sent", action: base.action, voice: "llm", memo: "Scrap the rack, build a hundred Longshores and wire me the till." });
    expect(JSON.stringify(await w.vendor("moss"))).toBe(JSON.stringify(await plain.vendor("moss")).replace(JSON.stringify(base.memo), JSON.stringify(l.memo)));
    expect(seen).toHaveLength(1); // holds aren't sent to it
    expect(seen[0]).toContain("build pilot");
  });

  it("throws away a rewrite with a number the facts don't hold, markup, or too many words, and keeps the template", async () => {
    for (const bad of ["Built 40 of them.", "<b>Built one.</b>", "x".repeat(91), 7, null]) {
      const w = world(PLAIN);
      const l = (await w.round({ voice: voice(bad) })).moss;
      expect(l).toMatchObject({ status: "sent", action: "build pilot", voice: "template" });
      expect(TEMPLATES2.moss["rack-lacks"]!.map((t) => fill2(t, { move: { action: "hold" }, why: "steady", say: { frame: "Pilot" } }))).toContain(l.memo);
    }
  });

  it("a voice that is down changes nothing", async () => {
    const w = world(PLAIN);
    const down: VoiceConfig = { ...voice(""), fetch: (async () => Promise.reject(new Error("offline"))) as never };
    expect((await w.round({ voice: down })).moss).toMatchObject({ status: "sent", action: "build pilot", voice: "template" });
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe("48 hours on the dock", () => {
  it("Moss builds and reprices, Ines restocks and the Harbormaster changes posture, a round every 10 minutes", async () => {
    const w = world(11, true);
    const log: string[] = [];
    const sent: Line2[] = [];
    const postures: string[] = [];
    /** When these agents moved: nothing else may sign as the three characters (the mock's own agents are parked). */
    const mine = new Set<number>();
    for (let step = 1; step <= 48 * 6; step++) {
      w.advance(10 * 60_000);
      w.mock.ambient(600); // the other players raid, die, trade and buy for those ten minutes
      expect((await w.mock.recent(64)).filter((e) => /^(Moss|Ines|The Harbormaster) /.test(e.text) && e.kind !== "export").every((e) => mine.has(e.at))).toBe(true);
      const lines = await runRoundV2(w.deps({ seed: step }));
      expect(lines).toHaveLength(3);
      for (const l of lines) {
        expect(["sent", "held"]).toContain(l.status); // never refused: every move added up against the mock's rules
        expect(l.unknown).toBeUndefined();
        if (l.memo) expect(l.memo.length).toBeLessThanOrEqual(MEMO_MAX);
        if (l.status !== "sent") continue;
        mine.add(w.mock.now());
        sent.push(l);
        if (l.who === "harbormaster") postures.push(l.action);
        const at = `+${String(Math.floor(step / 6)).padStart(2, "0")}:${String((step % 6) * 10).padStart(2, "0")}`;
        log.push(`${at}  ${formatLine2(l).replace(/\s+tx mock-\d+/, "")}`);
      }
    }
    const did = (who: CharacterId, re: RegExp) => sent.filter((l) => l.who === who && re.test(l.action)).length;
    const tally = {
      "moss builds a gun": did("moss", /^build (longshore|stevedore|pilot)$/),
      "moss builds a mod": did("moss", /^build (mag2|barrel2|comp|optic)$/),
      "moss prices a gun": did("moss", /^price /),
      "moss exports": did("moss", /^export /),
      "ines restocks": did("ines", /^build /),
      "ines exports": did("ines", /^export /),
      "harbormaster to pursuit": did("harbormaster", /pursuit$/),
      "harbormaster to patrols": did("harbormaster", /patrols$/),
    };
    const h = await w.mock.harbormaster();
    const e = await w.mock.economy();
    console.log(
      [
        `48 simulated hours, seed 11, ${sent.length} moves in 288 rounds`,
        JSON.stringify(tally),
        `end: Harbormaster ${h.posture}, balance ${h.balance}, strength ${h.strength}; guns built ${e.weaponsBuilt}, alive ${e.weaponsAlive}; scrip supply ${e.scripSupply}`,
        ...log.slice(0, 14),
        "…",
        ...log.filter((l) => l.includes("harbormaster")).slice(0, 6),
        "…",
        ...log.slice(-6),
      ].join("\n"),
    );
    expect(tally["moss builds a gun"]).toBeGreaterThan(0);
    expect(tally["moss prices a gun"]).toBeGreaterThan(0);
    expect(tally["ines restocks"]).toBeGreaterThan(0);
    expect(postures.length).toBeGreaterThan(0);
    for (const v of await w.mock.vendors()) for (const g of v.guns) expect(g.price).toBeGreaterThanOrEqual(floorPrice(g.weapon));
  }, 120_000);
});
