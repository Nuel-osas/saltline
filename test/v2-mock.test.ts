// The offline mock against docs/CONTRACT_V2.md → "Rules the contract enforces", one test per rule.
import { describe, expect, it } from "vitest";
import { LEDGER_KINDS } from "../src/economy/v2/chain";
import {
  BLUEPRINTS,
  BONDED_LOOT,
  CONTAINER_LOOT,
  FRAMES,
  INVOICE,
  MATERIALS,
  RAID,
  STAT_KEYS,
  appraise,
  gradeOf,
  invoiceStart,
  invoiceTotal,
  quality,
  weightOf,
} from "../src/economy/v2/items";
import {
  MOCK2,
  MOCK2_HARBORMASTER,
  MOCK2_STORAGE_KEY,
  type MockOptions2,
  createMockChain2,
  createMockWallet2,
  exportPrice,
  goodsPrice,
  gunPrice,
  mockStashParam,
  vendorBid,
} from "../src/economy/v2/mock";
import type { Amounts, MaterialId, Raid, RaidReport, Weapon } from "../src/economy/v2/types";

const T0 = 1_800_000_000_000;
const HOUR = 3_600_000;
const ROOK = "rook.mock";
const MARLOWE = "marlowe.mock";

function world(opts: MockOptions2 & { seed?: number } = {}) {
  let t = T0;
  const m = createMockChain2(opts.seed ?? 1, { storage: null, now: () => t, stash: null, ...opts });
  return { m, tick: (seconds: number) => void (t += seconds * 1000) };
}

/** A world with the player registered as TESTER. */
async function joined(opts: MockOptions2 & { seed?: number } = {}) {
  const w = world(opts);
  expect((await w.m.register(w.m.me(), "TESTER")).ok).toBe(true);
  return { ...w, me: w.m.me() };
}

/** …and holding a Longshore built by the rules. */
async function armed(opts: MockOptions2 & { seed?: number } = {}) {
  const w = await joined(opts);
  w.m.debug.give({ ...BLUEPRINTS.longshore.inputs, scrip: 1000 });
  const gun = (await w.m.build("longshore")).weapon as Weapon;
  return { ...w, gun };
}

const rep = (o: Partial<RaidReport> = {}): RaidReport => ({ opened: [], wrecks: [], parts: { servo: 0, rotor: 0 }, kills: { gull: 0, hound: 0 }, uplinks: 0, used: { plates: 0, charges: 0, mags: 0 }, ...o });
const BARE = { weapon: null, plates: 0, charges: 0, mags: 0 };

/** Containers of a raid that fit in `limit` weight, and what they hold. */
function within(raid: Raid, limit: number) {
  const opened: number[] = [];
  const cargo: Amounts<MaterialId> = {};
  let weight = 0;
  for (const c of raid.containers) {
    const w = c.amount * MATERIALS[c.tokenId].weight;
    if (weight + w > limit) continue;
    opened.push(c.spot);
    cargo[c.tokenId] = (cargo[c.tokenId] ?? 0) + c.amount;
    weight += w;
  }
  return { opened, cargo, weight };
}

const scripOf = async (m: ReturnType<typeof world>["m"], id: string) => (await m.balances(id)).scrip ?? 0;

// ---------------------------------------------------------------------------------------------------------------

describe("v2 mock: init and registration", () => {
  it("starts as the contract's init says: vendors' tills and stock, Moss's two guns, Ines's shelves, an empty Harbormaster", async () => {
    const { m } = world();
    const [moss, ines] = await m.vendors();
    expect([moss.id, ines.id]).toEqual(["moss", "ines"]);
    expect([moss.scrip, ines.scrip]).toEqual([1500, 1500]);
    expect(moss.stock).toEqual({ copper: 15, chips: 12, servo: 6, rotor: 6, core: 4 });
    expect(ines.stock).toEqual({ meds: 7, fuel: 6, chips: 12 });
    expect(moss.guns.map((g) => [g.weapon.frame, g.weapon.state, g.weapon.serial])).toEqual([
      ["longshore", "vendor", "S-000001"],
      ["stevedore", "vendor", "S-000002"],
    ]);
    for (const g of moss.guns) expect(g.price).toBe(Math.floor((g.weapon.value * 125) / 100));
    expect(Object.fromEntries(ines.goods.map((g) => [g.tokenId, g.stock]))).toEqual({ plate: 10, charge: 10, ammo: 40 });
    expect(moss.goods.map((g) => g.stock)).toEqual([0, 0, 0, 0]);
    const hm = await m.harbormaster();
    expect(hm).toMatchObject({ accountId: MOCK2_HARBORMASTER, balance: 0, strength: 0, posture: "patrols", bonusDrones: 0, bailiffAt: 1200, lastMemo: null });
    const eco = await m.economy();
    expect(eco).toMatchObject({ scripSupply: 3000 + 12 * RAID.starterScrip, players: 12, weaponsBuilt: 2, weaponsAlive: 2, weaponsDestroyed: 0, lastSales: [] });
  });

  it("register mints the dock pass's 150 scrip and returns the profile", async () => {
    const { m } = world();
    const r = await m.register(m.me(), "  tester ");
    expect(r.ok).toBe(true);
    expect(r.profile).toEqual({ accountId: m.me(), callsign: "TESTER", registeredAt: T0, raids: 0, extractions: 0, deaths: 0, arrears: 0, activeRaid: null, built: 0, royalties: 0 });
    expect(await m.balances(m.me())).toEqual({ scrip: 150 });
    expect((await m.economy()).minted24h).toBe(150);
    expect(await m.profile("nobody.mock")).toBeNull();
  });

  it("refuses a second registration, a taken callsign, a bad callsign and a full dock roll", async () => {
    const { m } = await joined();
    expect(await m.register(m.me(), "AGAIN")).toMatchObject({ ok: false, code: "E_ALREADY_REGISTERED" });
    expect(await m.register("b.mock", "rook")).toMatchObject({ ok: false, code: "E_CALLSIGN_TAKEN" });
    expect(await m.register("b.mock", "x")).toMatchObject({ ok: false, code: "E_BAD_CALLSIGN" });
    const full = world({ limits: { profiles: 12 } });
    expect(await full.m.register("b.mock", "LATE")).toMatchObject({ ok: false, code: "E_FULL" });
  });

  it("the mock wallet claims through the faucet's call and then reads as registered", async () => {
    const { m } = world();
    const wallet = createMockWallet2(m);
    expect(wallet.kind).toBe("mock");
    expect(await wallet.registered()).toBe(false);
    expect(await wallet.claim("x")).toMatchObject({ ok: false, code: "E_BAD_CALLSIGN" });
    expect((await wallet.claim("tester")).ok).toBe(true);
    expect(await wallet.registered()).toBe(true);
    expect(wallet.accountId()).toBe(m.me());
  });

  it("a call from an account with no dock pass is refused", async () => {
    const { m } = world();
    expect(await m.startRaid(BARE)).toMatchObject({ ok: false, code: "E_NOT_REGISTERED" });
    expect(await m.build("ammo")).toMatchObject({ ok: false, code: "E_NOT_REGISTERED" });
    expect(await m.settle(1)).toMatchObject({ ok: false, code: "E_NOT_REGISTERED" });
  });
});

describe("v2 mock: building, fitting, repairing, scrapping", () => {
  it("build burns the inputs and the fee and rolls every stat inside the frame's band", async () => {
    const { m, me } = await joined();
    m.debug.give({ ...BLUEPRINTS.pilot.inputs, scrip: 200 });
    const before = await m.economy();
    const r = await m.build("pilot");
    expect(r.ok).toBe(true);
    const w = r.weapon as Weapon;
    for (const k of STAT_KEYS) {
      expect(w.stats[k]).toBeGreaterThanOrEqual(FRAMES.pilot.bands[k][0]);
      expect(w.stats[k]).toBeLessThanOrEqual(FRAMES.pilot.bands[k][1]);
      expect(Number.isInteger(w.stats[k])).toBe(true);
    }
    expect(await m.balances(me)).toEqual({ scrip: 350 - BLUEPRINTS.pilot.fee });
    expect((await m.economy()).burned24h - before.burned24h).toBe(BLUEPRINTS.pilot.fee);
    expect((await m.profile(me))?.built).toBe(1);
  });

  it("a built gun's quality, grade and value follow items.ts, the maker is the caller, and serials count up", async () => {
    const { m, me } = await joined();
    for (let i = 0; i < 3; i++) {
      m.debug.give({ ...BLUEPRINTS.stevedore.inputs, scrip: BLUEPRINTS.stevedore.fee });
      const w = (await m.build("stevedore")).weapon as Weapon;
      expect(w.quality).toBe(quality("stevedore", w.stats));
      expect(w.grade).toBe(gradeOf(w.quality));
      expect(w.value).toBe(appraise("stevedore", w.grade, 100));
      expect(w).toMatchObject({ serial: `S-00000${3 + i}`, maker: me, makerCallsign: "TESTER", owner: me, state: "held", condition: 100, mods: [], raids: 0, extractions: 0, owners: 1, recovered: 0, builtAt: T0 });
      expect(await m.weapon(w.serial)).toEqual(w);
    }
    expect((await m.weapons(me)).map((w) => w.serial)).toEqual(["S-000003", "S-000004", "S-000005"]);
  });

  it("build refuses without the parts or the fee, and makes mods and consumables in their yields", async () => {
    const { m, me } = await joined();
    expect(await m.build("longshore")).toMatchObject({ ok: false, code: "E_FUNDS" });
    m.debug.give({ copper: 3, chips: 1 });
    expect(await m.build("mag2")).toMatchObject({ ok: true, minted: { mag2: 1 } });
    expect(await m.build("ammo")).toMatchObject({ ok: true, minted: { ammo: 4 } });
    expect(await m.balances(me)).toEqual({ scrip: 150 - 30 - 10, mag2: 1, ammo: 4 });
    // The parts without the fee: 10 scrip left, and the bench wants 30.
    m.debug.setArrears(400);
    await m.settle(100);
    m.debug.give({ copper: 2, chips: 1 });
    expect(await m.build("mag2")).toMatchObject({ ok: false, code: "E_FUNDS" });
    expect(await m.balances(me)).toEqual({ scrip: 10, mag2: 1, ammo: 4, copper: 2, chips: 1 });
    expect(await m.build("flamethrower" as never)).toMatchObject({ ok: false, code: "E_BAD_AMOUNT" });
  });

  it("build refuses a gun past the limit on guns", async () => {
    const { m } = await joined({ limits: { guns: 2 } });
    m.debug.give({ ...BLUEPRINTS.longshore.inputs, scrip: 500 });
    expect(await m.build("longshore")).toMatchObject({ ok: false, code: "E_FULL" });
    expect((await m.build("ammo")).ok).toBe(true);
  });

  it("fit burns the mod into the gun, one per slot", async () => {
    const { m, me, gun } = await armed();
    expect(await m.fit(gun.serial, "comp")).toMatchObject({ ok: false, code: "E_FUNDS" });
    m.debug.give({ comp: 2, optic: 1 });
    const r = await m.fit(gun.serial, "comp");
    expect(r.weapon?.mods).toEqual(["comp"]);
    expect((await m.balances(me)).comp).toBe(1);
    expect(await m.fit(gun.serial, "comp")).toMatchObject({ ok: false, code: "E_SLOT_TAKEN" });
    expect((await m.fit(gun.serial, "optic")).weapon?.mods).toEqual(["comp", "optic"]);
    expect((await m.weapon(gun.serial))?.value).toBe(gun.value);
  });

  it("fit, repair and scrap need the gun held, and yours", async () => {
    const { m, gun } = await armed();
    m.debug.give({ comp: 1, copper: 5 });
    expect(await m.fit("S-999999", "comp")).toMatchObject({ ok: false, code: "E_NO_WEAPON" });
    expect(await m.as(ROOK).scrap(gun.serial)).toMatchObject({ ok: false, code: "E_NOT_OWNER" });
    await m.listWeapon(gun.serial, 500);
    expect(await m.fit(gun.serial, "comp")).toMatchObject({ ok: false, code: "E_WEAPON_BUSY" });
    expect(await m.repair(gun.serial)).toMatchObject({ ok: false, code: "E_WEAPON_BUSY" });
    expect(await m.scrap(gun.serial)).toMatchObject({ ok: false, code: "E_WEAPON_BUSY" });
  });

  it("repair costs 2 scrip a point, paid to Moss, and a copper per 20 points rounded up, burned", async () => {
    const { m, me } = await joined();
    const gun = m.debug.giveGun("longshore", { grade: "C", condition: 59 });
    m.debug.give({ copper: 5, scrip: 100 });
    const moss = (await m.vendors())[0].scrip;
    const r = await m.repair(gun.serial);
    expect(r).toMatchObject({ ok: true, cost: 82 });
    expect(r.weapon).toMatchObject({ condition: 100, value: appraise("longshore", "C", 100) });
    expect(await m.balances(me)).toEqual({ scrip: 250 - 82, copper: 5 - 3 });
    expect((await m.vendors())[0].scrip).toBe(moss + 82);
    expect(await m.repair(gun.serial)).toMatchObject({ ok: false, code: "E_BAD_AMOUNT" });
  });

  it("repair by points stops at 100, and a gun at 0 can only be scrapped", async () => {
    const { m } = await joined();
    const gun = m.debug.giveGun("stevedore", { grade: "C", condition: 90 });
    const dead = m.debug.giveGun("stevedore", { grade: "C", condition: 0 });
    m.debug.give({ copper: 5, scrip: 100 });
    expect(await m.repair(gun.serial, 5)).toMatchObject({ ok: true, cost: 10, weapon: { condition: 95 } });
    expect(await m.repair(gun.serial, 50)).toMatchObject({ ok: true, cost: 10, weapon: { condition: 100 } });
    expect(await m.repair(dead.serial)).toMatchObject({ ok: false, code: "E_WORN_OUT" });
    expect(await m.startRaid({ ...BARE, weapon: dead.serial })).toMatchObject({ ok: false, code: "E_WORN_OUT" });
    expect((await m.scrap(dead.serial)).ok).toBe(true);
  });

  it("scrap burns the gun and gives back 2 copper and 1 electronics", async () => {
    const { m, me, gun } = await armed();
    const r = await m.scrap(gun.serial);
    expect(r).toMatchObject({ ok: true, minted: { copper: 2, chips: 1 } });
    expect(await m.weapon(gun.serial)).toBeNull();
    expect(await m.weapons(me)).toEqual([]);
    expect(await m.balances(me)).toMatchObject({ copper: 2, chips: 1 });
    expect(await m.economy()).toMatchObject({ weaponsBuilt: 3, weaponsAlive: 2, weaponsDestroyed: 1 });
  });
});

describe("v2 mock: starting a raid", () => {
  it("the manifest is 8 of the 16 spots, each a material from the loot table, and nothing bonded", async () => {
    const { m } = await joined();
    const raid = (await m.startRaid(BARE)).raid as Raid;
    expect(raid.containers).toHaveLength(RAID.containers);
    expect(new Set(raid.containers.map((c) => c.spot)).size).toBe(RAID.containers);
    for (const c of raid.containers) {
      const loot = CONTAINER_LOOT.find((l) => l.id === c.tokenId);
      expect(loot).toBeDefined();
      expect(c.spot).toBeLessThan(RAID.spotCount);
      expect(c.amount).toBeGreaterThanOrEqual(loot!.amount[0]);
      expect(c.amount).toBeLessThanOrEqual(loot!.amount[1]);
      expect(c.bonded).toBe(false);
    }
    expect(raid).toMatchObject({ raidId: 1, startedAt: T0, loadout: BARE, wrecks: [], invoiceStart: INVOICE.entry });
    expect(raid.harbormaster).toEqual(await m.harbormaster());
    expect(await m.raid(1)).toEqual(raid);
    expect(await m.raid(99)).toBeNull();
    expect(await m.profile(m.me())).toMatchObject({ raids: 1, activeRaid: 1 });
  });

  it("locks the loadout: the gun becomes `raid` and the gear leaves the stash", async () => {
    const { m, me, gun } = await armed();
    m.debug.give({ plate: 1, charge: 3, ammo: 8 });
    const r = await m.startRaid({ weapon: gun.serial, plates: 1, charges: 2, mags: 5 });
    expect(r.raid?.loadout).toEqual({ weapon: gun.serial, plates: 1, charges: 2, mags: 5 });
    expect((await m.weapon(gun.serial))?.state).toBe("raid");
    expect(await m.balances(me)).toEqual({ scrip: 1150 - 120, charge: 1, ammo: 3 });
    expect(await m.listWeapon(gun.serial, 100)).toMatchObject({ ok: false, code: "E_WEAPON_BUSY" });
  });

  it("refuses gear over the limits, gear not held, and a gun that is busy, worn out, missing or someone else's", async () => {
    const { m, gun } = await armed();
    expect(await m.startRaid({ ...BARE, plates: 2 })).toMatchObject({ ok: false, code: "E_BAD_AMOUNT" });
    expect(await m.startRaid({ ...BARE, charges: 4 })).toMatchObject({ ok: false, code: "E_BAD_AMOUNT" });
    expect(await m.startRaid({ ...BARE, mags: 9 })).toMatchObject({ ok: false, code: "E_BAD_AMOUNT" });
    expect(await m.startRaid({ ...BARE, mags: 1 })).toMatchObject({ ok: false, code: "E_FUNDS" });
    expect(await m.startRaid({ ...BARE, weapon: "S-000404" })).toMatchObject({ ok: false, code: "E_NO_WEAPON" });
    expect(await m.as(ROOK).startRaid({ ...BARE, weapon: gun.serial })).toMatchObject({ ok: false, code: "E_NOT_OWNER" });
    await m.listWeapon(gun.serial, 100);
    expect(await m.startRaid({ ...BARE, weapon: gun.serial })).toMatchObject({ ok: false, code: "E_WEAPON_BUSY" });
    expect((await m.profile(m.me()))?.activeRaid).toBeNull();
  });

  it("one raid at a time, 30 seconds after the last: a new one abandons the old, returns its gun and loses its gear", async () => {
    const { m, me, gun, tick } = await armed();
    m.debug.give({ ammo: 2 });
    const first = (await m.startRaid({ weapon: gun.serial, plates: 0, charges: 0, mags: 2 })).raid as Raid;
    tick(29);
    expect(await m.startRaid(BARE)).toMatchObject({ ok: false, code: "E_TOO_SOON" });
    tick(1);
    const second = await m.startRaid(BARE);
    expect(second.ok).toBe(true);
    expect((await m.weapon(gun.serial))?.state).toBe("held");
    expect((await m.weapon(gun.serial))?.raids).toBe(0);
    expect((await m.balances(me)).ammo).toBeUndefined();
    tick(120);
    expect(await m.extract(first.raidId, rep())).toMatchObject({ ok: false, code: "E_RAID_CLOSED" });
    expect((await m.profile(me))?.activeRaid).toBe(second.raid?.raidId);
  });

  it("invoice_start is 150 + 25 per extraction + half the arrears up to 1,500", async () => {
    const { m, tick } = await joined();
    m.debug.setArrears(700);
    const r1 = (await m.startRaid(BARE)).raid as Raid;
    expect(r1.invoiceStart).toBe(150 + 350);
    tick(60);
    const out = await m.extract(r1.raidId, rep());
    m.debug.setArrears(9000);
    const r2 = (await m.startRaid(BARE)).raid as Raid;
    expect(out.ok).toBe(true);
    expect(r2.invoiceStart).toBe(invoiceStart(1, 9000));
    expect(r2.invoiceStart).toBe(150 + 25 + 1500);
  });

  it("arrears of 1,000 or more add two bonded containers of two units each", async () => {
    const { m } = await joined();
    m.debug.setArrears(999);
    expect((await m.startRaid(BARE)).raid?.containers.filter((c) => c.bonded)).toEqual([]);
    const b = await joined();
    b.m.debug.setArrears(1000);
    const raid = (await b.m.startRaid(BARE)).raid as Raid;
    const bonded = raid.containers.filter((c) => c.bonded);
    expect(raid.containers).toHaveLength(RAID.containers + RAID.bonded);
    expect(new Set(raid.containers.map((c) => c.spot)).size).toBe(10);
    expect(bonded).toHaveLength(2);
    for (const c of bonded) {
      expect(c.amount).toBe(2);
      expect(BONDED_LOOT).toContain(c.tokenId);
    }
  });

  it("attaches up to 3 live wrecks that aren't the caller's and reserves them from other raids", async () => {
    const { m } = await joined();
    for (let i = 0; i < 5; i++) m.debug.addWreck({ spot: i });
    const mine = (await m.startRaid(BARE)).raid as Raid;
    expect(mine.wrecks).toHaveLength(3);
    const owners = new Set(mine.wrecks.map((w) => w.owner));
    expect(owners.has(m.me())).toBe(false);
    const other = [ROOK, MARLOWE, "sprat.mock", "brine.mock"].find((id) => !owners.has(id)) as string;
    const theirs = (await m.as(other).startRaid(BARE)).raid as Raid;
    const taken = new Set(mine.wrecks.map((w) => w.id));
    expect(theirs.wrecks.every((w) => !taken.has(w.id))).toBe(true);
    expect(theirs.wrecks.length).toBeLessThanOrEqual(2);
  });

  it("never offers a player their own wreck", async () => {
    const { m, gun, tick } = await armed();
    const r = (await m.startRaid({ ...BARE, weapon: gun.serial })).raid as Raid;
    tick(60);
    expect((await m.die(r.raidId, rep(), 3, "machines")).wreckId).toBe(1);
    tick(60);
    expect((await m.startRaid(BARE)).raid?.wrecks).toEqual([]);
    expect((await m.as(ROOK).startRaid(BARE)).raid?.wrecks.map((w) => w.id)).toEqual([1]);
  });
});

describe("v2 mock: the report checks, on extract and on die", () => {
  async function inRaid(seconds = 600) {
    const w = await armed();
    w.m.debug.give({ plate: 1, charge: 1, ammo: 2 });
    w.m.debug.addWreck({ spot: 1, frame: "pilot" });
    const raid = (await w.m.startRaid({ weapon: w.gun.serial, plates: 1, charges: 1, mags: 2 })).raid as Raid;
    w.tick(seconds);
    return { ...w, raid, spot: raid.containers[0].spot };
  }
  const both = async (w: Awaited<ReturnType<typeof inRaid>>, report: RaidReport, code: string) => {
    const before = JSON.stringify(w.m.snapshot());
    expect(await w.m.extract(w.raid.raidId, report)).toMatchObject({ ok: false, code });
    expect(await w.m.die(w.raid.raidId, report, 2, "machines")).toMatchObject({ ok: false, code });
    // A refusal changes nothing.
    expect(JSON.stringify(w.m.snapshot())).toBe(before);
  };

  it("E_NO_RAID: no such raid, or somebody else's", async () => {
    const w = await inRaid();
    expect(await w.m.extract(77, rep())).toMatchObject({ ok: false, code: "E_NO_RAID" });
    expect(await w.m.die(77, rep(), 0, "machines")).toMatchObject({ ok: false, code: "E_NO_RAID" });
    expect(await w.m.as(ROOK).extract(w.raid.raidId, rep())).toMatchObject({ ok: false, code: "E_NO_RAID" });
  });

  it("E_RAID_CLOSED: a raid ends once", async () => {
    const w = await inRaid();
    expect((await w.m.extract(w.raid.raidId, rep())).ok).toBe(true);
    expect(await w.m.extract(w.raid.raidId, rep())).toMatchObject({ ok: false, code: "E_RAID_CLOSED" });
    expect(await w.m.die(w.raid.raidId, rep(), 0, "bailiff")).toMatchObject({ ok: false, code: "E_RAID_CLOSED" });
  });

  it("E_NOT_IN_MANIFEST: a spot or a wreck the raid wasn't given", async () => {
    const w = await inRaid();
    const off = Array.from({ length: 16 }, (_, i) => i).find((s) => !w.raid.containers.some((c) => c.spot === s)) as number;
    await both(w, rep({ opened: [off] }), "E_NOT_IN_MANIFEST");
    await both(w, rep({ wrecks: [99] }), "E_NOT_IN_MANIFEST");
  });

  it("E_DUPLICATE: a spot or a wreck twice", async () => {
    const w = await inRaid();
    await both(w, rep({ opened: [w.spot, w.spot] }), "E_DUPLICATE");
    await both(w, rep({ wrecks: [w.raid.wrecks[0].id, w.raid.wrecks[0].id] }), "E_DUPLICATE");
  });

  it("E_BAD_REPORT: more than 3 uplinks", async () => {
    const w = await inRaid();
    await both(w, rep({ uplinks: 4 }), "E_BAD_REPORT");
    expect((await w.m.extract(w.raid.raidId, rep({ uplinks: 3 }))).ok).toBe(true);
  });

  it("E_BAD_REPORT: more than 30 gulls or 15 hounds", async () => {
    const w = await inRaid();
    await both(w, rep({ kills: { gull: 31, hound: 0 } }), "E_BAD_REPORT");
    await both(w, rep({ kills: { gull: 0, hound: 16 } }), "E_BAD_REPORT");
    expect((await w.m.extract(w.raid.raidId, rep({ kills: { gull: 30, hound: 15 } }))).ok).toBe(true);
  });

  it("E_BAD_REPORT: more kills than one per 4 seconds of the raid", async () => {
    const w = await inRaid(100);
    await both(w, rep({ kills: { gull: 20, hound: 6 } }), "E_BAD_REPORT");
    expect((await w.m.extract(w.raid.raidId, rep({ kills: { gull: 20, hound: 5 } }))).ok).toBe(true);
  });

  it("E_BAD_REPORT: more parts than machines destroyed", async () => {
    const w = await inRaid();
    await both(w, rep({ kills: { gull: 2, hound: 1 }, parts: { servo: 2, rotor: 0 } }), "E_BAD_REPORT");
    await both(w, rep({ kills: { gull: 2, hound: 1 }, parts: { servo: 0, rotor: 3 } }), "E_BAD_REPORT");
  });

  it("E_BAD_REPORT: more gear used than brought, and a report that isn't whole numbers", async () => {
    const w = await inRaid();
    await both(w, rep({ used: { plates: 2, charges: 0, mags: 0 } }), "E_BAD_REPORT");
    await both(w, rep({ used: { plates: 0, charges: 2, mags: 0 } }), "E_BAD_REPORT");
    await both(w, rep({ used: { plates: 0, charges: 0, mags: 3 } }), "E_BAD_REPORT");
    await both(w, rep({ uplinks: 1.5 }), "E_BAD_REPORT");
    await both(w, rep({ kills: { gull: -1, hound: 0 } }), "E_BAD_REPORT");
  });

  it("E_BAD_REPORT: dying at a spot that doesn't exist, or of something unknown", async () => {
    const w = await inRaid();
    expect(await w.m.die(w.raid.raidId, rep(), 16, "machines")).toMatchObject({ ok: false, code: "E_BAD_REPORT" });
    expect(await w.m.die(w.raid.raidId, rep(), 0, "boredom" as never)).toMatchObject({ ok: false, code: "E_BAD_REPORT" });
  });

  it("E_OVER_LIMIT: carry weight over 6, counting cargo, parts and 2 for a recovered gun", async () => {
    const w = await inRaid();
    await both(w, rep({ opened: w.raid.containers.map((c) => c.spot) }), "E_OVER_LIMIT");
    const five = within(w.raid, 5);
    const parts = { servo: RAID.carryLimit - five.weight - 1, rotor: 0 };
    const kills = { gull: 0, hound: parts.servo };
    // Cargo and parts to 5, plus a 2-weight gun out of a wreck: 7.
    await both(w, rep({ opened: five.opened, parts, kills, wrecks: [w.raid.wrecks[0].id] }), "E_OVER_LIMIT");
    const four = within(w.raid, 4);
    const fill = { servo: 4 - four.weight, rotor: 0 };
    expect((await w.m.extract(w.raid.raidId, rep({ opened: four.opened, parts: fill, kills: { gull: 0, hound: fill.servo }, wrecks: [w.raid.wrecks[0].id] }))).ok).toBe(true);
  });

  it("E_TOO_SOON: extract needs 45 seconds plus 8 for each container opened; dying needs no time", async () => {
    const w = await inRaid(44);
    expect(await w.m.extract(w.raid.raidId, rep())).toMatchObject({ ok: false, code: "E_TOO_SOON" });
    w.tick(1);
    expect(await w.m.extract(w.raid.raidId, rep({ opened: [w.spot] }))).toMatchObject({ ok: false, code: "E_TOO_SOON" });
    w.tick(7);
    expect(await w.m.extract(w.raid.raidId, rep({ opened: [w.spot] }))).toMatchObject({ ok: false, code: "E_TOO_SOON" });
    w.tick(1);
    expect((await w.m.extract(w.raid.raidId, rep({ opened: [w.spot] }))).ok).toBe(true);
    const d = await inRaid(1);
    expect((await d.m.die(d.raid.raidId, rep(), 0, "machines")).ok).toBe(true);
  });
});

describe("v2 mock: extract", () => {
  it("mints the cargo and parts, returns the gun worn by 5 with its counters up, and hands back unused gear", async () => {
    const { m, me, gun, tick } = await armed();
    m.debug.give({ plate: 1, charge: 2, ammo: 4 });
    const raid = (await m.startRaid({ weapon: gun.serial, plates: 1, charges: 2, mags: 4 })).raid as Raid;
    tick(240);
    const { opened, cargo, weight } = within(raid, 4);
    const kills = { gull: 3, hound: 2 };
    const parts = { servo: 1, rotor: 1 };
    const r = await m.extract(raid.raidId, rep({ opened, parts, kills, uplinks: 2, used: { plates: 1, charges: 1, mags: 3 } }));
    expect(r.ok).toBe(true);
    const minted = { ...cargo, servo: (cargo.servo ?? 0) + 1, rotor: (cargo.rotor ?? 0) + 1 };
    expect(r.minted).toEqual(minted);
    expect(r.weapon).toMatchObject({ serial: gun.serial, state: "held", condition: 95, raids: 1, extractions: 1, owner: me, value: appraise("longshore", gun.grade, 95) });
    expect(r.recovered).toEqual([]);
    expect(await m.balances(me)).toEqual({ scrip: 1030, ...minted, charge: 1, ammo: 1 });
    // The invoice, against items.ts.
    const invoice = invoiceTotal({ start: raid.invoiceStart, seconds: 240, seals: opened.length, weight: weight + 2, uplinks: 2, gulls: 3, hounds: 2 });
    expect(weightOf(minted)).toBe(weight + 2);
    expect(r.invoice).toBe(invoice);
    expect(r.invoice).toBe(150 + 240 + 80 * opened.length + 40 * (weight + 2) + 400 + 120 + 240);
    expect(r.arrears).toBe(Math.floor((invoice * 25) / 100));
    expect(await m.profile(me)).toMatchObject({ raids: 1, extractions: 1, deaths: 0, activeRaid: null, arrears: r.arrears });
  });

  it("the issue rifle comes back as no weapon at all", async () => {
    const { m, tick } = await joined();
    const raid = (await m.startRaid(BARE)).raid as Raid;
    tick(45);
    const r = await m.extract(raid.raidId, rep());
    expect(r).toMatchObject({ ok: true, weapon: null, minted: {}, invoice: 150 + 45, arrears: 48 });
  });

  it("a recovered wreck's gun changes owner, worn by 15, and its items are minted to the finder", async () => {
    const { m, me, gun, tick } = await armed();
    m.debug.give({ ammo: 3 });
    const mine = (await m.startRaid({ weapon: gun.serial, plates: 0, charges: 0, mags: 3 })).raid as Raid;
    tick(120);
    const box = within(mine, 2);
    const died = await m.die(mine.raidId, rep({ opened: box.opened, used: { plates: 0, charges: 0, mags: 1 } }), 9, "machines");
    expect(died.wreckId).toBe(1);
    const rook = m.as(ROOK);
    const theirs = (await rook.startRaid(BARE)).raid as Raid;
    expect(theirs.wrecks).toHaveLength(1);
    expect(theirs.wrecks[0]).toMatchObject({ id: 1, spot: 9, owner: me, callsign: "TESTER", weapon: { serial: gun.serial, state: "wreck", owner: me } });
    tick(60);
    const out = await rook.extract(theirs.raidId, rep({ wrecks: [1] }));
    expect(out.recovered).toHaveLength(1);
    expect(out.recovered?.[0]).toMatchObject({ serial: gun.serial, owner: ROOK, owners: 2, recovered: 1, state: "held", condition: 85, raids: 1, extractions: 0, value: appraise("longshore", gun.grade, 85), maker: me });
    expect(out.minted).toEqual({ ...box.cargo, ammo: 2 });
    expect(await m.balances(ROOK)).toEqual({ scrip: 150, ...box.cargo, ammo: 2 });
    expect(await m.wrecks()).toEqual([]);
    expect(await m.weapons(me)).toEqual([]);
    expect((await m.weapons(ROOK)).map((w) => w.serial)).toEqual([gun.serial]);
    // The gun's 2 weight is on the finder's invoice.
    expect(out.invoice).toBe(invoiceTotal({ start: theirs.invoiceStart, seconds: 60, seals: 0, weight: 2, uplinks: 0, gulls: 0, hounds: 0 }));
    expect((await m.recent(5)).some((e) => e.kind === "recover")).toBe(true);
  });
});

describe("v2 mock: die", () => {
  it("by machines: the gun, the cargo and the unused gear go into a wreck where the player fell, live for 24 hours", async () => {
    const { m, me, gun, tick } = await armed();
    m.debug.give({ plate: 1, charge: 2, ammo: 4 });
    const raid = (await m.startRaid({ weapon: gun.serial, plates: 1, charges: 2, mags: 4 })).raid as Raid;
    tick(200);
    const { opened, cargo, weight } = within(raid, 3);
    const r = await m.die(raid.raidId, rep({ opened, kills: { gull: 0, hound: 1 }, parts: { servo: 1, rotor: 0 }, used: { plates: 1, charges: 0, mags: 1 } }), 11, "machines");
    const invoice = invoiceTotal({ start: 150, seconds: 200, seals: opened.length, weight: weight + 1, uplinks: 0, gulls: 0, hounds: 1 });
    expect(r).toMatchObject({ ok: true, wreckId: 1, impounded: false, invoice, arrears: Math.floor((invoice * 10) / 100) });
    const [wreck] = await m.wrecks();
    const carried: Amounts = { ...cargo, servo: (cargo.servo ?? 0) + 1, charge: 2, ammo: 3 };
    expect(wreck).toMatchObject({ id: 1, spot: 11, owner: me, callsign: "TESTER", at: T0 + 200_000, expiresAt: T0 + 200_000 + 24 * HOUR });
    expect(Object.fromEntries(wreck.items.map((i) => [i.tokenId, i.amount]))).toEqual(carried);
    // Custody: still the owner's on the books, in state `wreck`, with no wear yet.
    expect(wreck.weapon).toMatchObject({ serial: gun.serial, owner: me, state: "wreck", condition: 100, raids: 1, extractions: 0 });
    expect((await m.weapons(me))[0].state).toBe("wreck");
    expect(await m.balances(me)).toEqual({ scrip: 1030 });
    expect(await m.profile(me)).toMatchObject({ deaths: 1, extractions: 0, activeRaid: null });
    expect(await m.scrap(gun.serial)).toMatchObject({ ok: false, code: "E_WEAPON_BUSY" });
  });

  it("by machines with the issue rifle and nothing carried: no wreck", async () => {
    const { m, tick } = await joined();
    const raid = (await m.startRaid(BARE)).raid as Raid;
    tick(30);
    expect(await m.die(raid.raidId, rep(), 4, "machines")).toMatchObject({ ok: true, wreckId: null, impounded: false, invoice: 180, arrears: 18 });
    expect(await m.wrecks()).toEqual([]);
  });

  it("by the Bailiff: the gun is impounded for 48 hours at 40% of its appraisal and everything else is destroyed", async () => {
    const { m, me, gun, tick } = await armed();
    m.debug.give({ ammo: 4 });
    const raid = (await m.startRaid({ weapon: gun.serial, plates: 0, charges: 0, mags: 4 })).raid as Raid;
    tick(100);
    const r = await m.die(raid.raidId, rep({ opened: within(raid, 4).opened }), 5, "bailiff");
    expect(r).toMatchObject({ ok: true, wreckId: null, impounded: true });
    expect(await m.wrecks()).toEqual([]);
    expect(await m.balances(me)).toEqual({ scrip: 1030 });
    expect(await m.impound(me)).toEqual([{ weapon: { ...gun, state: "impound", raids: 1 }, fee: Math.floor((gun.value * 40) / 100), expiresAt: T0 + 100_000 + 48 * HOUR }]);
    expect((await m.weapons(me))[0].state).toBe("impound");
    expect(await m.startRaid({ ...BARE, weapon: gun.serial })).toMatchObject({ ok: false, code: "E_WEAPON_BUSY" });
  });

  it("by the Bailiff with the issue rifle: nothing to impound", async () => {
    const { m, me, tick } = await joined();
    const raid = (await m.startRaid(BARE)).raid as Raid;
    tick(60);
    expect(await m.die(raid.raidId, rep(), 5, "bailiff")).toMatchObject({ ok: true, wreckId: null, impounded: false });
    expect(await m.impound(me)).toEqual([]);
  });

  it("releases the wrecks the raid had reserved, untouched", async () => {
    const { m, tick } = await joined();
    m.debug.addWreck({ spot: 2 });
    const raid = (await m.startRaid(BARE)).raid as Raid;
    expect((await m.as(ROOK).startRaid(BARE)).raid?.wrecks).toEqual([]);
    tick(60);
    await m.die(raid.raidId, rep({ wrecks: [raid.wrecks[0].id] }), 0, "machines");
    expect(await m.wrecks()).toHaveLength(1);
    const free = [MARLOWE, "sprat.mock"].find((id) => id !== raid.wrecks[0].owner) as string;
    expect((await m.as(free).startRaid(BARE)).raid?.wrecks.map((w) => w.id)).toEqual([raid.wrecks[0].id]);
  });
});

describe("v2 mock: expiry, impound and arrears", () => {
  it("a wreck not recovered in 24 hours is burned with its gun", async () => {
    const { m, me, gun, tick } = await armed();
    const raid = (await m.startRaid({ ...BARE, weapon: gun.serial })).raid as Raid;
    tick(60);
    await m.die(raid.raidId, rep(), 0, "machines");
    tick(24 * 3600 - 1);
    expect(await m.wrecks()).toHaveLength(1);
    tick(1);
    expect(await m.wrecks()).toEqual([]);
    expect(await m.weapon(gun.serial)).toBeNull();
    expect(await m.weapons(me)).toEqual([]);
    expect((await m.economy()).weaponsDestroyed).toBe(1);
  });

  it("an impound not bought back in 48 hours is burned", async () => {
    const { m, me, gun, tick } = await armed();
    const raid = (await m.startRaid({ ...BARE, weapon: gun.serial })).raid as Raid;
    tick(60);
    await m.die(raid.raidId, rep(), 0, "bailiff");
    tick(48 * 3600 - 1);
    expect(await m.impound(me)).toHaveLength(1);
    tick(1);
    expect(await m.impound(me)).toEqual([]);
    expect(await m.weapon(gun.serial)).toBeNull();
    expect(await m.buyBack(gun.serial)).toMatchObject({ ok: false, code: "E_NOT_IMPOUNDED" });
  });

  it("at most 40 wrecks are kept: the oldest is burned to make room", async () => {
    const { m, tick } = await joined({ limits: { wrecks: 4 } });
    const old = [1, 2, 3, 4].map((spot) => m.debug.addWreck({ spot }).id);
    tick(40);
    // ROOK's raid is shown the newest three (of those that aren't ROOK's own), which holds them.
    const raid = (await m.as(ROOK).startRaid(BARE)).raid as Raid;
    expect(raid.wrecks).toHaveLength(3);
    m.debug.give({ ammo: 1 });
    const mine = (await m.startRaid({ ...BARE, mags: 1 })).raid as Raid;
    tick(10);
    expect((await m.die(mine.raidId, rep(), 3, "machines")).wreckId).toBe(5);
    const left = (await m.wrecks()).map((w) => w.id);
    expect(left).toHaveLength(4);
    expect(left).toContain(5);
    // The one burned was the oldest that no open raid had been shown, and its gun went with it.
    const gone = old.filter((id) => !left.includes(id));
    expect(gone).toHaveLength(1);
    expect(raid.wrecks.map((w) => w.id)).not.toContain(gone[0]);
    expect((await m.economy()).weaponsDestroyed).toBe(1);
  });

  it("buy_back pays the fee to the Harbormaster and returns the gun held", async () => {
    const { m, me, gun, tick } = await armed();
    const raid = (await m.startRaid({ ...BARE, weapon: gun.serial })).raid as Raid;
    tick(60);
    await m.die(raid.raidId, rep(), 0, "bailiff");
    const fee = Math.floor((gun.value * 40) / 100);
    expect(await m.as(ROOK).buyBack(gun.serial)).toMatchObject({ ok: false, code: "E_NOT_IMPOUNDED" });
    const r = await m.buyBack(gun.serial);
    expect(r).toMatchObject({ ok: true, cost: fee, weapon: { serial: gun.serial, state: "held", owner: me, owners: 1 } });
    expect(await scripOf(m, me)).toBe(1030 - fee);
    expect((await m.harbormaster()).balance).toBe(fee);
    expect(await m.impound(me)).toEqual([]);
    expect(await m.buyBack(gun.serial)).toMatchObject({ ok: false, code: "E_NOT_IMPOUNDED" });
  });

  it("buy_back without the fee is refused", async () => {
    const { m } = await joined();
    const gun = m.debug.giveGun("pilot", { grade: "B", impound: true });
    expect(await m.buyBack(gun.serial)).toMatchObject({ ok: false, code: "E_FUNDS" });
    expect((await m.weapon(gun.serial))?.state).toBe("impound");
  });

  it("settle takes up to half the arrears, rounded up, pays it to the Harbormaster and clears twice that", async () => {
    const { m, me } = await joined();
    m.debug.give({ scrip: 1000 });
    m.debug.setArrears(301);
    expect(await m.settle(100)).toMatchObject({ ok: true, cleared: 200, arrears: 101 });
    expect(await scripOf(m, me)).toBe(1050);
    expect((await m.harbormaster()).balance).toBe(100);
    // 101 owed: ⌈101 ÷ 2⌉ = 51 is the most it takes, and it clears the lot.
    expect(await m.settle(500)).toMatchObject({ ok: true, cleared: 101, arrears: 0 });
    expect(await scripOf(m, me)).toBe(999);
    expect((await m.harbormaster()).balance).toBe(151);
    expect(await m.settle(1)).toMatchObject({ ok: false, code: "E_NOTHING_OWED" });
  });

  it("settle refuses nothing, and more scrip than the player has", async () => {
    const { m } = await joined();
    m.debug.setArrears(1000);
    expect(await m.settle(0)).toMatchObject({ ok: false, code: "E_BAD_AMOUNT" });
    expect(await m.settle(151)).toMatchObject({ ok: false, code: "E_FUNDS" });
    expect(await m.settle(150)).toMatchObject({ ok: true, cleared: 300, arrears: 700 });
  });
});

describe("v2 mock: the Harbormaster", () => {
  it("strength is its balance ÷ 20, capped at 100", async () => {
    const { m } = world();
    for (const [paid, strength] of [
      [19, 0],
      [1, 1],
      [480, 25],
      [1499, 99],
      [1, 100],
      [5000, 100],
    ]) {
      m.debug.payHarbormaster(paid);
      expect((await m.harbormaster()).strength).toBe(strength);
    }
  });

  it("its balance halves every 12 hours, and the part lost is burned", async () => {
    const { m } = world();
    m.debug.payHarbormaster(1600);
    const supply = (await m.economy()).scripSupply;
    m.debug.advance(12);
    expect((await m.harbormaster()).balance).toBe(800);
    expect(await m.economy()).toMatchObject({ scripSupply: supply - 800, burned24h: 800 });
    m.debug.advance(6);
    expect((await m.harbormaster()).balance).toBe(Math.floor(800 * 0.707107));
    m.debug.advance(18);
    expect((await m.harbormaster()).balance).toBe(200);
  });

  it("patrols: an extra drone per 25 strength, and the thresholds are 600 / 1,200 / 2,400 / 4,000", async () => {
    const { m } = world();
    m.debug.payHarbormaster(1100);
    expect(await m.harbormaster()).toMatchObject({ balance: 1100, strength: 55, posture: "patrols", bonusDrones: 2, secondNoticeAt: 600, bailiffAt: 1200, secondBailiffAt: 2400, foreclosureAt: 4000 });
    m.debug.payHarbormaster(5000);
    expect((await m.harbormaster()).bonusDrones).toBe(4);
  });

  it("pursuit: no bonus drones, and the Bailiff's threshold is 1,200 − 4 × strength", async () => {
    const { m } = world();
    m.debug.payHarbormaster(1100);
    const r = await m.as(MOCK2_HARBORMASTER).hmPosture("pursuit", "Receipts are up.");
    expect(r.harbormaster).toMatchObject({ posture: "pursuit", strength: 55, bonusDrones: 0, secondNoticeAt: 600, bailiffAt: 1200 - 220, secondBailiffAt: 2400, foreclosureAt: 4000, lastMemo: "Receipts are up." });
    expect(await m.harbormaster()).toEqual(r.harbormaster);
    m.debug.payHarbormaster(5000);
    expect((await m.harbormaster()).bailiffAt).toBe(800);
    expect((await m.recent(1))[0]).toMatchObject({ kind: "posture", account: MOCK2_HARBORMASTER });
  });

  it("only the Harbormaster's account sets the posture", async () => {
    const { m } = await joined();
    expect(await m.hmPosture("pursuit", "mine now")).toMatchObject({ ok: false, code: "E_NOT_HARBORMASTER" });
    expect(await m.as(m.vendorAccount("moss")).hmPosture("pursuit", "x")).toMatchObject({ ok: false, code: "E_NOT_HARBORMASTER" });
    expect((await m.harbormaster()).posture).toBe("patrols");
  });

  it("a raid carries the Harbormaster as it stood at the fence", async () => {
    const { m } = await joined();
    m.debug.payHarbormaster(2000);
    await m.as(MOCK2_HARBORMASTER).hmPosture("pursuit", "Go.");
    const raid = (await m.startRaid(BARE)).raid as Raid;
    expect(raid.harbormaster).toMatchObject({ strength: 100, posture: "pursuit", bailiffAt: 800, bonusDrones: 0 });
  });
});

describe("v2 mock: vendors", () => {
  it("sell pays the bid one unit at a time as the stock rises: bid × 2 × target ÷ (target + stock)", async () => {
    const { m, me } = await joined();
    m.debug.give({ copper: 5 });
    const [moss] = await m.vendors();
    expect(moss.bids.find((b) => b.tokenId === "copper")?.price).toBe(Math.floor((40 * 2 * 20) / (20 + 15)));
    const want = [15, 16, 17].reduce((s, stock) => s + vendorBid("copper", stock), 0);
    expect(want).toBe(45 + 44 + 43);
    expect(await m.sell("moss", "copper", 3)).toMatchObject({ ok: true, paid: want });
    expect(await m.balances(me)).toEqual({ scrip: 150 + want, copper: 2 });
    const after = (await m.vendors())[0];
    expect(after).toMatchObject({ scrip: 1500 - want, stock: { copper: 18 } });
    expect(vendorBid("copper", 20)).toBe(MATERIALS.copper.bid);
  });

  it("sell refuses what the vendor doesn't buy, what the player hasn't got, and nothing", async () => {
    const { m } = await joined();
    m.debug.give({ meds: 2, copper: 1 });
    expect(await m.sell("moss", "meds", 1)).toMatchObject({ ok: false, code: "E_DOESNT_BUY" });
    expect(await m.sell("ines", "copper", 1)).toMatchObject({ ok: false, code: "E_DOESNT_BUY" });
    expect(await m.sell("ines", "meds", 3)).toMatchObject({ ok: false, code: "E_FUNDS" });
    expect(await m.sell("ines", "meds", 0)).toMatchObject({ ok: false, code: "E_BAD_AMOUNT" });
    expect((await m.sell("ines", "meds", 2)).ok).toBe(true);
  });

  it("a vendor refuses a sale that would take its scrip under 100, and shows as closed when it can't buy", async () => {
    const { m } = await joined();
    m.debug.give({ core: 40 });
    expect(await m.sell("moss", "core", 40)).toMatchObject({ ok: false, code: "E_VENDOR_BROKE" });
    let sold = 0;
    while ((await m.sell("moss", "core", 1)).ok) sold++;
    const [moss] = await m.vendors();
    expect(sold).toBeGreaterThan(5);
    expect(moss.scrip).toBeGreaterThanOrEqual(MOCK2.vendorFloat);
    expect(moss.scrip - vendorBid("core", moss.stock.core ?? 0)).toBeLessThan(MOCK2.vendorFloat);
    // She can still afford cheaper things, so she is open until nothing fits.
    expect(moss.open).toBe(moss.bids.some((b) => moss.scrip - b.price >= MOCK2.vendorFloat));
    expect(await m.sell("moss", "core", 1)).toMatchObject({ ok: false, code: "E_VENDOR_BROKE" });
  });

  it("goods cost their inputs at base bids × 135%, and more when the vendor holds few", async () => {
    const { m, me } = await joined();
    m.debug.give({ scrip: 5000 });
    expect(goodsPrice("plate", 10)).toBe(Math.floor(((2 * 40 + 80) * 135) / 100));
    expect(goodsPrice("ammo", 40)).toBe(Math.floor((40 * 135) / 400));
    expect(goodsPrice("plate", 4)).toBeGreaterThan(goodsPrice("plate", 5));
    const [, ines] = await m.vendors();
    expect(ines.goods.find((g) => g.tokenId === "plate")?.price).toBe(216);
    expect(await m.buy("ines", "plate", 2)).toMatchObject({ ok: true, cost: 432 });
    expect(await m.balances(me)).toMatchObject({ scrip: 5150 - 432, plate: 2 });
    expect((await m.vendors())[1]).toMatchObject({ scrip: 1932 });
    // Six more take her from 8 to 2: the last two cost more than the first.
    const cost = [8, 7, 6, 5, 4, 3].reduce((s, stock) => s + goodsPrice("plate", stock), 0);
    expect(await m.buy("ines", "plate", 6)).toMatchObject({ ok: true, cost });
    expect(cost).toBeGreaterThan(6 * 216);
  });

  it("buy refuses what the vendor doesn't sell, what it has run out of, and what the player can't pay for", async () => {
    const { m } = await joined();
    expect(await m.buy("ines", "mag2", 1)).toMatchObject({ ok: false, code: "E_DOESNT_SELL" });
    expect(await m.buy("moss", "plate", 1)).toMatchObject({ ok: false, code: "E_DOESNT_SELL" });
    expect(await m.buy("moss", "mag2", 1)).toMatchObject({ ok: false, code: "E_NO_STOCK" });
    expect(await m.buy("ines", "ammo", 41)).toMatchObject({ ok: false, code: "E_NO_STOCK" });
    expect(await m.buy("ines", "plate", 1)).toMatchObject({ ok: false, code: "E_FUNDS" });
    expect(await m.buy("ines", "ammo", 0)).toMatchObject({ ok: false, code: "E_BAD_AMOUNT" });
  });

  it("buy_gun sells a vendor's gun at its appraisal × 125%", async () => {
    const { m, me } = await joined();
    const [moss] = await m.vendors();
    const { weapon, price } = moss.guns[0];
    expect(price).toBe(gunPrice(weapon.value));
    expect(await m.buyGun("moss", weapon.serial)).toMatchObject({ ok: false, code: "E_FUNDS" });
    m.debug.give({ scrip: 2000 });
    const r = await m.buyGun("moss", weapon.serial);
    expect(r).toMatchObject({ ok: true, cost: price, weapon: { serial: weapon.serial, owner: me, owners: 2, state: "held", maker: moss.accountId, makerCallsign: "MOSS" } });
    expect(await scripOf(m, me)).toBe(2150 - price);
    expect((await m.vendors())[0]).toMatchObject({ scrip: 1500 + price });
    expect((await m.vendors())[0].guns.map((g) => g.weapon.serial)).toEqual(["S-000002"]);
    expect(await m.buyGun("moss", weapon.serial)).toMatchObject({ ok: false, code: "E_NO_WEAPON" });
    expect(await m.buyGun("ines", "S-000002")).toMatchObject({ ok: false, code: "E_NO_WEAPON" });
  });

  it("vendor_price overrides the price of a gun and of goods, and only a vendor may", async () => {
    const { m } = await joined();
    const moss = m.as(m.vendorAccount("moss"));
    const ines = m.as(m.vendorAccount("ines"));
    expect(await m.vendorPrice({ serial: "S-000001" }, 5, "cheap")).toMatchObject({ ok: false, code: "E_NOT_VENDOR" });
    expect((await moss.vendorPrice({ serial: "S-000001" }, 99, "Fire sale.")).ok).toBe(true);
    expect((await ines.vendorPrice({ tokenId: "ammo" }, 3, "Bullets for all.")).ok).toBe(true);
    const [a, b] = await m.vendors();
    expect(a.guns[0].price).toBe(99);
    expect(a.lastMemo).toBe("Fire sale.");
    expect(b.goods.find((g) => g.tokenId === "ammo")?.price).toBe(3);
    expect(b.lastMemo).toBe("Bullets for all.");
    expect(await m.buyGun("moss", "S-000001")).toMatchObject({ ok: true, cost: 99 });
    expect(await m.buy("ines", "ammo", 5)).toMatchObject({ ok: true, cost: 15 });
    expect(await moss.vendorPrice({ serial: "S-000001" }, 50, "x")).toMatchObject({ ok: false, code: "E_NO_WEAPON" });
    expect(await ines.vendorPrice({ tokenId: "mag2" }, 50, "x")).toMatchObject({ ok: false, code: "E_DOESNT_SELL" });
    expect(await ines.vendorPrice({}, 50, "x")).toMatchObject({ ok: false, code: "E_BAD_AMOUNT" });
    expect(await ines.vendorPrice({ tokenId: "ammo" }, 0, "x")).toMatchObject({ ok: false, code: "E_BAD_AMOUNT" });
  });

  it("vendor_build uses the vendor's own materials, pays no fee, and makes only what its list allows", async () => {
    const { m } = world();
    const moss = m.as(m.vendorAccount("moss"));
    const ines = m.as(m.vendorAccount("ines"));
    const r = await moss.vendorBuild("pilot", "Somebody asked for reach.");
    expect(r).toMatchObject({ ok: true, weapon: { frame: "pilot", state: "vendor", owner: m.vendorAccount("moss"), maker: m.vendorAccount("moss"), serial: "S-000003" } });
    const [a] = await m.vendors();
    expect(a).toMatchObject({ scrip: 1500, stock: { copper: 10, chips: 7, servo: 4, core: 3, rotor: 6 }, lastMemo: "Somebody asked for reach." });
    expect(a.guns).toHaveLength(3);
    expect(a.guns[2].price).toBe(gunPrice(r.weapon!.value));
    expect(await moss.vendorBuild("comp", "Muzzles.")).toMatchObject({ ok: true, minted: { comp: 1 } });
    expect((await m.vendors())[0].goods.find((g) => g.tokenId === "comp")?.stock).toBe(1);
    expect(await ines.vendorBuild("charge", "Charges.")).toMatchObject({ ok: true, minted: { charge: 1 } });
    expect(await ines.vendorBuild("longshore", "x")).toMatchObject({ ok: false, code: "E_DOESNT_SELL" });
    expect(await moss.vendorBuild("ammo", "x")).toMatchObject({ ok: false, code: "E_DOESNT_SELL" });
    // Ines holds no copper, so a plate is beyond her (see the lane report: nothing she buys makes one).
    expect(await ines.vendorBuild("plate", "x")).toMatchObject({ ok: false, code: "E_NO_STOCK" });
    const player = await joined();
    expect(await player.m.vendorBuild("comp", "x")).toMatchObject({ ok: false, code: "E_NOT_VENDOR" });
  });
});

describe("v2 mock: the export desk", () => {
  it("mints scrip at export × 100 ÷ (100 + 4 × units exported recently), one unit at a time", async () => {
    const { m, me } = await joined();
    m.debug.give({ core: 5, copper: 1 });
    expect((await m.exportPrices()).find((q) => q.tokenId === "core")?.price).toBe(100);
    const before = await m.economy();
    const want = [0, 1, 2].reduce((s, n) => s + Math.floor((100 * 100) / (100 + 4 * n)), 0);
    expect(want).toBe(100 + 96 + 92);
    expect(await m.exportGoods("core", 3)).toMatchObject({ ok: true, paid: want });
    expect(await m.balances(me)).toEqual({ scrip: 150 + want, core: 2, copper: 1 });
    const after = await m.economy();
    expect(after.scripSupply - before.scripSupply).toBe(want);
    expect(after.minted24h - before.minted24h).toBe(want);
    expect((await m.exportPrices()).find((q) => q.tokenId === "core")?.price).toBe(exportPrice("core", 3000));
    // Each material has its own count.
    expect((await m.exportPrices()).find((q) => q.tokenId === "copper")?.price).toBe(25);
  });

  it("'recently' halves every 12 hours, so the price recovers", async () => {
    const { m } = await joined();
    m.debug.give({ fuel: 10 });
    await m.exportGoods("fuel", 10);
    const price = async () => (await m.exportPrices()).find((q) => q.tokenId === "fuel")?.price;
    expect(await price()).toBe(Math.floor((55 * 100) / 140));
    m.debug.advance(12);
    expect(await price()).toBe(Math.floor((55 * 100) / 120));
    m.debug.advance(24);
    expect(await price()).toBe(Math.floor((55 * 100) / 105));
  });

  it("refuses what the player hasn't got; a vendor exports from its own stock into its own till", async () => {
    const { m } = await joined();
    expect(await m.exportGoods("core", 1)).toMatchObject({ ok: false, code: "E_FUNDS" });
    expect(await m.exportGoods("ammo" as never, 1)).toMatchObject({ ok: false, code: "E_DOESNT_BUY" });
    const moss = m.as(m.vendorAccount("moss"));
    expect(await moss.exportGoods("copper", 2)).toMatchObject({ ok: true, paid: 25 + 24 });
    expect((await m.vendors())[0]).toMatchObject({ scrip: 1549, stock: { copper: 13 } });
    expect(await moss.exportGoods("meds", 1)).toMatchObject({ ok: false, code: "E_NO_STOCK" });
  });
});

describe("v2 mock: the market", () => {
  it("a listed gun is held by the market, shown newest first, and can't be used", async () => {
    const { m, me, gun } = await armed();
    m.debug.give({ copper: 4 });
    expect(await m.listWeapon(gun.serial, 900)).toMatchObject({ ok: true, id: 1 });
    expect(await m.listItem("copper", 3, 120)).toMatchObject({ ok: true, id: 2 });
    const listings = await m.listings();
    expect(listings.map((l) => l.id)).toEqual([2, 1]);
    expect(listings[1]).toEqual({ id: 1, seller: me, callsign: "TESTER", price: 900, at: T0, weapon: { ...gun, state: "listed" } });
    expect(listings[0]).toEqual({ id: 2, seller: me, callsign: "TESTER", price: 120, at: T0, item: { tokenId: "copper", amount: 3 } });
    expect((await m.balances(me)).copper).toBe(1);
    expect(await m.listWeapon(gun.serial, 900)).toMatchObject({ ok: false, code: "E_WEAPON_BUSY" });
    expect(await m.listItem("copper", 2, 10)).toMatchObject({ ok: false, code: "E_FUNDS" });
    expect(await m.listItem("scrip" as never, 2, 10)).toMatchObject({ ok: false, code: "E_BAD_AMOUNT" });
    expect(await m.listWeapon(gun.serial, 0)).toMatchObject({ ok: false, code: "E_BAD_AMOUNT" });
  });

  it("a gun's sale pays 96% to the seller, 2% to its maker and burns 2%", async () => {
    const { m, me, gun } = await armed();
    // The gun passes to ROOK first, so the maker, the seller and the buyer are three accounts.
    await m.listWeapon(gun.serial, 100);
    expect((await m.as(ROOK).buyListing(1)).ok).toBe(true);
    expect((await m.as(ROOK).listWeapon(gun.serial, 150)).id).toBe(2);
    const before = { me: await scripOf(m, me), rook: await scripOf(m, ROOK), eco: await m.economy() };
    expect(before.rook).toBe(50);
    const r = await m.as(MARLOWE).buyListing(2);
    expect(r).toMatchObject({ ok: true, paid: 150, weapon: { serial: gun.serial, owner: MARLOWE, owners: 3, state: "held", maker: me } });
    expect(await scripOf(m, MARLOWE)).toBe(0);
    expect(await scripOf(m, ROOK)).toBe(50 + 144);
    expect(await scripOf(m, me)).toBe(before.me + 3);
    expect((await m.profile(me))?.royalties).toBe(2 + 3);
    const eco = await m.economy();
    expect(eco.burned24h - before.eco.burned24h).toBe(3);
    expect(eco.scripSupply).toBe(before.eco.scripSupply - 3);
    expect(await m.listings()).toEqual([]);
    expect((await m.recent(1))[0].kind).toBe("market_sale");
  });

  it("a sale between three accounts splits exactly, with the fees rounded down", async () => {
    const { m, me, gun } = await armed();
    await m.listWeapon(gun.serial, 149);
    const start = { me: await scripOf(m, me), rook: await scripOf(m, ROOK) };
    expect(await m.as(ROOK).buyListing(1)).toMatchObject({ ok: true, paid: 149 });
    // 2% of 149 is 2.98: the maker gets 2, 2 are burned, the seller gets 145. Here the seller is the maker.
    expect(await scripOf(m, ROOK)).toBe(start.rook - 149);
    expect(await scripOf(m, me)).toBe(start.me + 145 + 2);
    expect((await m.weapon(gun.serial))?.owners).toBe(2);
  });

  it("an item's sale burns the whole 4%", async () => {
    const { m, me } = await joined();
    m.debug.give({ chips: 4 });
    await m.listItem("chips", 4, 100);
    const before = await m.economy();
    expect(await m.as(ROOK).buyListing(1)).toMatchObject({ ok: true, paid: 100 });
    expect(await m.balances(ROOK)).toEqual({ scrip: 50, chips: 4 });
    expect(await scripOf(m, me)).toBe(150 + 96);
    expect((await m.economy()).burned24h - before.burned24h).toBe(4);
    expect((await m.profile(me))?.royalties).toBe(0);
  });

  it("keeps the last five sale prices per frame and grade", async () => {
    const { m, gun } = await armed();
    m.debug.give({ scrip: 500 });
    const rook = m.as(ROOK);
    for (let i = 1; i <= 7; i++) {
      const [seller, buyer] = i % 2 ? [m, rook] : [rook, m];
      const id = (await seller.listWeapon(gun.serial, 10 + i)).id as number;
      expect((await buyer.buyListing(id)).ok).toBe(true);
    }
    expect((await m.economy()).lastSales).toEqual([{ frame: "longshore", grade: gun.grade, prices: [13, 14, 15, 16, 17] }]);
    expect((await m.weapon(gun.serial))?.owners).toBe(8);
  });

  it("cancel returns the gun or the items, and only the seller may", async () => {
    const { m, me, gun } = await armed();
    m.debug.give({ rotor: 2 });
    await m.listWeapon(gun.serial, 900);
    await m.listItem("rotor", 2, 80);
    expect(await m.as(ROOK).cancelListing(1)).toMatchObject({ ok: false, code: "E_NOT_OWNER" });
    expect(await m.cancelListing(9)).toMatchObject({ ok: false, code: "E_NO_LISTING" });
    expect((await m.cancelListing(1)).ok).toBe(true);
    expect((await m.cancelListing(2)).ok).toBe(true);
    expect((await m.weapon(gun.serial))?.state).toBe("held");
    expect((await m.balances(me)).rotor).toBe(2);
    expect(await m.listings()).toEqual([]);
  });

  it("refuses a listing that is gone, your own, or too dear", async () => {
    const { m, gun } = await armed();
    await m.listWeapon(gun.serial, 900);
    expect(await m.buyListing(1)).toMatchObject({ ok: false, code: "E_NO_LISTING" });
    expect(await m.as(ROOK).buyListing(1)).toMatchObject({ ok: false, code: "E_FUNDS" });
    expect(await m.as(ROOK).buyListing(2)).toMatchObject({ ok: false, code: "E_NO_LISTING" });
    expect((await m.weapon(gun.serial))?.state).toBe("listed");
  });

  it("at most 200 listings", async () => {
    const { m, gun } = await armed({ limits: { listings: 1 } });
    m.debug.give({ copper: 2 });
    expect((await m.listItem("copper", 1, 5)).ok).toBe(true);
    expect(await m.listItem("copper", 1, 5)).toMatchObject({ ok: false, code: "E_FULL" });
    expect(await m.listWeapon(gun.serial, 5)).toMatchObject({ ok: false, code: "E_FULL" });
    expect(MOCK2.limits).toEqual({ profiles: 2000, guns: 5000, listings: 200, wrecks: 40 });
  });
});

describe("v2 mock: the public views", () => {
  it("recent keeps 64 lines, newest first, each of a kind the contract names", async () => {
    const { m } = await joined();
    m.debug.give({ copper: 80 });
    for (let i = 0; i < 70; i++) await m.exportGoods("copper", 1);
    const all = await m.recent(500);
    expect(all).toHaveLength(64);
    expect(await m.recent(3)).toEqual(all.slice(0, 3));
    expect(await m.recent(0)).toHaveLength(1);
    expect(all[0]).toMatchObject({ kind: "export", account: m.me(), callsign: "TESTER" });
    expect(all[0].text).toMatch(/^TESTER sent 1 copper coil to the freighter for \d+ new scrip\.$/);
    for (const e of all) expect(LEDGER_KINDS).toContain(e.kind);
  });

  it("writes the ledger in the dock's voice", async () => {
    const { m, gun } = await armed();
    expect((await m.recent(1))[0].text).toBe(`TESTER built a${gun.grade === "A" ? "n" : ""} ${gun.grade}-grade Longshore, ${gun.serial}.`);
    const raid = (await m.startRaid({ ...BARE, weapon: gun.serial })).raid as Raid;
    expect((await m.recent(1))[0]).toMatchObject({ kind: "raid_start", text: `TESTER went over the fence with Longshore ${gun.serial}.` });
    await m.die(raid.raidId, rep(), 7, "machines");
    expect((await m.recent(1))[0]).toMatchObject({ kind: "wreck", text: `TESTER's Longshore ${gun.serial} is in a wreck in the yard, spot 7.` });
  });

  it("economy: the scrip supply is every scrip there is, and guns are counted built, alive and destroyed", async () => {
    const { m, me } = await armed();
    m.debug.give({ copper: 3 });
    await m.exportGoods("copper", 3);
    await m.settle(1);
    m.debug.setArrears(100);
    await m.settle(20);
    const s = m.snapshot();
    const held = Object.values(s.accounts).reduce((t, a) => t + (a.balances.scrip ?? 0), 0) + s.vendors.moss.scrip + s.vendors.ines.scrip + (await m.harbormaster()).balance;
    const eco = await m.economy();
    expect(eco.scripSupply).toBe(held);
    expect(eco).toMatchObject({ players: 13, weaponsBuilt: 3, weaponsAlive: 3, weaponsDestroyed: 0 });
    // Everything minted since genesis less everything burned is the change in supply.
    expect(eco.scripSupply).toBe(4800 + eco.minted24h - eco.burned24h);
    expect(await scripOf(m, me)).toBeGreaterThan(0);
  });

  it("leaderboard: net worth is scrip plus held guns, with extractions and makers' royalties, ten rows at most", async () => {
    const { m, me, gun, tick } = await armed();
    const lb = await m.leaderboard();
    expect(lb.netWorth[0]).toEqual({ accountId: me, callsign: "TESTER", value: 1030 + gun.value });
    expect(lb.netWorth).toHaveLength(10);
    expect(lb.extractions).toEqual([]);
    expect(lb.makers).toEqual([]);
    const raid = (await m.startRaid(BARE)).raid as Raid;
    tick(60);
    await m.extract(raid.raidId, rep());
    await m.listWeapon(gun.serial, 100);
    expect((await m.leaderboard()).netWorth.find((r) => r.accountId === me)?.value).toBe(1030);
    await m.as(ROOK).buyListing(1);
    const after = await m.leaderboard();
    expect(after.extractions).toEqual([{ accountId: me, callsign: "TESTER", value: 1 }]);
    expect(after.makers).toEqual([{ accountId: me, callsign: "TESTER", value: 2 }]);
    expect(after.netWorth.find((r) => r.accountId === ROOK)?.value).toBe(50 + gun.value);
  });

  it("has no explorer links offline", () => {
    const { m } = world();
    expect([m.network, m.txUrl("x"), m.accountUrl("x")]).toEqual(["mock", null, null]);
  });
});

describe("v2 mock: determinism, ambient play and persistence", () => {
  const play = async (seed: number) => {
    const w = await armed({ seed, warmupSeconds: 3600 });
    const raid = (await w.m.startRaid({ ...BARE, weapon: w.gun.serial })).raid as Raid;
    w.tick(300);
    w.m.ambient(300);
    await w.m.extract(raid.raidId, rep({ opened: within(raid, 5).opened }));
    w.tick(600);
    w.m.ambient(600);
    return JSON.stringify(w.m.snapshot());
  };

  it("is deterministic for a seed, and differs between seeds", async () => {
    const [a, b, c] = [await play(7), await play(7), await play(8)];
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it("ambient play moves the world: listings appear and sell, wrecks come and go, the Harbormaster's balance moves", async () => {
    let t = T0;
    const m = createMockChain2(3, { storage: null, now: () => t, stash: null, warmupSeconds: 6 * 3600 });
    const start = { listings: (await m.listings()).map((l) => l.id), wrecks: (await m.wrecks()).map((w) => w.id), hm: (await m.harbormaster()).balance, eco: await m.economy() };
    expect(start.eco.weaponsBuilt).toBeGreaterThan(4);
    expect(start.listings.length).toBeGreaterThan(0);
    const balances = new Set<number>([start.hm]);
    const postures = new Set<string>();
    for (let i = 0; i < 6 * 720; i++) {
      t += 5000;
      m.ambient(5);
      if (i % 360 === 0) {
        const hm = await m.harbormaster();
        balances.add(hm.balance);
        postures.add(hm.posture);
        if (hm.lastMemo) expect(hm.lastMemo).toMatch(/^Receipts stand at \d+ scrip\./);
      }
    }
    const end = { listings: (await m.listings()).map((l) => l.id), wrecks: (await m.wrecks()).map((w) => w.id), eco: await m.economy() };
    expect(end.listings.some((id) => !start.listings.includes(id))).toBe(true);
    expect(start.listings.some((id) => !end.listings.includes(id))).toBe(true);
    expect(end.wrecks.some((id) => !start.wrecks.includes(id))).toBe(true);
    expect(end.eco.lastSales.length).toBeGreaterThan(0);
    expect(end.eco.weaponsBuilt).toBeGreaterThan(start.eco.weaponsBuilt);
    expect(balances.size).toBeGreaterThan(3);
    expect(postures.size).toBeGreaterThan(0);
    const [moss, ines] = await m.vendors();
    expect(moss.lastMemo).toBeTruthy();
    expect(ines.lastMemo).toBeTruthy();
    const kinds = new Set((await m.recent(64)).map((e) => e.kind));
    for (const k of kinds) expect(LEDGER_KINDS).toContain(k);
    expect(kinds.size).toBeGreaterThan(5);
  });

  it("ambient play keeps the books: no scrip from nowhere, and every gun in exactly one place", async () => {
    let t = T0;
    const m = createMockChain2(11, { storage: null, now: () => t, stash: null, warmupSeconds: 12 * 3600 });
    for (let i = 0; i < 30 * 60; i++) {
      t += 60_000;
      m.ambient(60);
    }
    const s = m.snapshot();
    const eco = await m.economy();
    const scrip = Object.values(s.accounts).reduce((n, a) => n + (a.balances.scrip ?? 0), 0) + s.vendors.moss.scrip + s.vendors.ines.scrip + (await m.harbormaster()).balance;
    expect(eco.scripSupply).toBe(scrip);
    expect(eco.weaponsAlive).toBe(Object.keys(s.weapons).length);
    expect(eco.weaponsBuilt - eco.weaponsDestroyed).toBe(eco.weaponsAlive);
    // 42 hours on: wrecks have expired with guns in them.
    expect(eco.weaponsDestroyed).toBeGreaterThan(0);
    for (const a of Object.values(s.accounts)) for (const v of Object.values(a.balances)) expect(v).toBeGreaterThan(0);
    for (const v of Object.values(s.vendors)) expect(v.scrip).toBeGreaterThanOrEqual(MOCK2.vendorFloat);
    const listed = new Set(s.listings.map((l) => l.serial).filter(Boolean));
    const wrecked = new Set(s.wrecks.map((w) => w.serial).filter(Boolean));
    const impounded = new Set(s.impound.map((x) => x.serial));
    const vendors = new Set(Object.values(s.vendors).map((v) => v.accountId));
    for (const w of Object.values(s.weapons)) {
      expect(listed.has(w.serial)).toBe(w.state === "listed");
      expect(wrecked.has(w.serial)).toBe(w.state === "wreck");
      expect(impounded.has(w.serial)).toBe(w.state === "impound");
      expect(vendors.has(w.owner)).toBe(w.state === "vendor");
      expect(w.state).not.toBe("raid");
      expect(w.value).toBe(appraise(w.frame, w.grade, w.condition));
      expect(w.grade).toBe(gradeOf(quality(w.frame, w.stats)));
    }
    expect(s.wrecks.length).toBeLessThanOrEqual(40);
    expect(s.listings.length).toBeLessThanOrEqual(200);
    expect(Object.keys(s.raids).length).toBeLessThanOrEqual(80);
  });

  function memory(): Storage & { data: Map<string, string> } {
    const data = new Map<string, string>();
    return { data, length: 0, clear: () => data.clear(), getItem: (k) => data.get(k) ?? null, key: () => null, removeItem: (k) => void data.delete(k), setItem: (k, v) => void data.set(k, v) };
  }

  it("persists under saltline.v2.mock.v1 and picks up where it left off", async () => {
    const storage = memory();
    const a = createMockChain2(5, { storage, now: () => T0, stash: null });
    await a.register(a.me(), "TESTER");
    a.debug.give({ copper: 3 });
    await a.exportGoods("copper", 2);
    expect(storage.data.has(MOCK2_STORAGE_KEY)).toBe(true);
    const b = createMockChain2(99, { storage, now: () => T0 + 1000, stash: null });
    expect(b.me()).toBe(a.me());
    expect(b.snapshot()).toEqual(a.snapshot());
    expect(await b.balances(b.me())).toEqual({ scrip: 150 + 25 + 24, copper: 1 });
    b.reset();
    expect(await b.profile(b.me())).toBeNull();
    expect(createMockChain2(99, { storage, now: () => T0, stash: null }).me()).toBe(b.me());
  });

  it("survives storage that throws, and saved state it can't read", async () => {
    const broken: Storage = {
      length: 0,
      clear: () => undefined,
      key: () => null,
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("quota");
      },
      removeItem: () => {
        throw new Error("denied");
      },
    };
    const warn = console.warn;
    console.warn = () => undefined;
    try {
      const m = createMockChain2(1, { storage: broken, now: () => T0, stash: null });
      expect((await m.register(m.me(), "TESTER")).ok).toBe(true);
      expect((await m.startRaid(BARE)).ok).toBe(true);
      m.ambient(60);
      m.reset();
      expect(await m.profile(m.me())).toBeNull();
    } finally {
      console.warn = warn;
    }
    const junk = memory();
    junk.setItem(MOCK2_STORAGE_KEY, "{not json");
    expect((await createMockChain2(1, { storage: junk, now: () => T0, stash: null }).economy()).players).toBe(12);
    junk.setItem(MOCK2_STORAGE_KEY, JSON.stringify({ v: 1, me: "x" }));
    expect((await createMockChain2(1, { storage: junk, now: () => T0, stash: null }).economy()).players).toBe(12);
  });
});

describe("v2 mock: debug", () => {
  it("?stash=rich is read from the page's query", () => {
    expect(mockStashParam("?mock&stash=rich")).toBe("rich");
    expect(mockStashParam("?stash=poor")).toBeNull();
    expect(mockStashParam("")).toBeNull();
  });

  it("stash=rich starts the player registered, in funds, with three guns of different frames and grades, one worn and one modded, an impounded gun and arrears", async () => {
    const storage = (() => {
      const data = new Map<string, string>();
      return { length: 0, clear: () => data.clear(), getItem: (k: string) => data.get(k) ?? null, key: () => null, removeItem: (k: string) => void data.delete(k), setItem: (k: string, v: string) => void data.set(k, v) } as Storage;
    })();
    const m = createMockChain2(1, { storage, now: () => T0, stash: "rich" });
    const me = m.me();
    expect(await createMockWallet2(m).registered()).toBe(true);
    const profile = await m.profile(me);
    expect(profile?.arrears).toBeGreaterThanOrEqual(INVOICE.bondedAt);
    const bal = await m.balances(me);
    expect(bal.scrip).toBeGreaterThan(2000);
    for (const t of ["copper", "chips", "servo", "rotor", "core", "plate", "charge", "ammo"] as const) expect(bal[t]).toBeGreaterThan(0);
    const guns = await m.weapons(me);
    const held = guns.filter((g) => g.state === "held");
    expect(held).toHaveLength(3);
    expect(new Set(held.map((g) => g.frame)).size).toBe(3);
    expect(new Set(held.map((g) => g.grade)).size).toBe(3);
    expect(held.some((g) => g.condition < 30)).toBe(true);
    expect(held.some((g) => g.mods.length > 0)).toBe(true);
    for (const g of guns) expect(g.grade).toBe(gradeOf(quality(g.frame, g.stats)));
    const impound = await m.impound(me);
    expect(impound).toHaveLength(1);
    expect(impound[0].fee).toBe(Math.floor((impound[0].weapon.value * 40) / 100));
    // Every screen has something on it at once: a wreck with a gun on offer, and bonded containers.
    const raid = (await m.startRaid({ weapon: held[0].serial, plates: 1, charges: 1, mags: 2 })).raid as Raid;
    expect(raid.wrecks.some((w) => w.weapon)).toBe(true);
    expect(raid.containers.filter((c) => c.bonded)).toHaveLength(2);
    // A reload doesn't fill the locker twice.
    const again = createMockChain2(1, { storage, now: () => T0, stash: "rich" });
    expect((await again.balances(me)).scrip).toBe(bal.scrip);
    expect(await again.weapons(me)).toHaveLength(guns.length);
  });

  it("give, giveGun, setArrears, addWreck and advance do what they say", async () => {
    const { m, me } = await joined();
    m.debug.give("copper", 3);
    m.debug.give({ scrip: 50, plate: 1 });
    expect(await m.balances(me)).toEqual({ scrip: 200, copper: 3, plate: 1 });
    for (const grade of ["A", "B", "C", "D"] as const) {
      for (const frame of ["longshore", "stevedore", "pilot"] as const) expect(m.debug.giveGun(frame, { grade })).toMatchObject({ frame, grade, owner: me, state: "held" });
    }
    m.debug.setArrears(321);
    expect((await m.profile(me))?.arrears).toBe(321);
    const w = m.debug.addWreck({ spot: 6, frame: null, items: { core: 2 } });
    expect(w).toMatchObject({ spot: 6, weapon: null, items: [{ tokenId: "core", amount: 2 }] });
    expect(await m.wrecks()).toHaveLength(1);
    const t = m.now();
    m.debug.advance(25);
    expect(m.now() - t).toBe(25 * HOUR);
    expect(await m.wrecks()).toEqual([]);
  });
});
