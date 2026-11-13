// The raid's rules (src/economy/v2/raid): what the gun in the loadout does to the shooter, the live invoice against
// items.ts, the thresholds, the report the contract is sent, what killed the player, and signing on.
import { describe, expect, it } from "vitest";
import { FRAMES, HARBORMASTER, INVOICE, ISSUE, RAID, invoiceStart, invoiceTotal } from "../src/economy/v2/items";
import type { Chain2, FrameId, HarbormasterView, Loadout, Raid, Stats, Weapon } from "../src/economy/v2/types";
import { createFakeV2 } from "../src/economy/v2/raid/fake";
import {
  HOLD,
  RaidLedger,
  Thresholds,
  capKills,
  checkRaid,
  deathBy,
  dropsPart,
  foreclosureCores,
  gearUsed,
  nearestSpot,
  resolveGun,
  shooterSpec,
  thresholdsOf,
  zoneOf,
} from "../src/economy/v2/raid/rules";
import { signOn } from "../src/economy/v2/raid/signon";

const mid = (frame: FrameId): Stats => {
  const b = FRAMES[frame].bands;
  const m = (k: keyof Stats) => Math.round((b[k][0] + b[k][1]) / 2);
  return { damage: m("damage"), rpm: m("rpm"), mag: m("mag"), recoil: m("recoil"), reload: m("reload"), range: m("range") };
};
const gun = (frame: FrameId, o: Partial<Weapon> = {}): Weapon => ({
  serial: "S-000041",
  frame,
  grade: "C",
  quality: 50,
  stats: mid(frame),
  mods: [],
  condition: 100,
  maker: "moss.testnet",
  makerCallsign: "MOSS",
  owner: "rook.testnet",
  builtAt: 0,
  raids: 0,
  extractions: 0,
  owners: 1,
  recovered: 0,
  state: "held",
  value: 750,
  ...o,
});
const hm = (o: Partial<HarbormasterView> = {}): HarbormasterView => ({
  accountId: "harbormaster.testnet",
  balance: 0,
  strength: 0,
  posture: "patrols",
  bonusDrones: 0,
  secondNoticeAt: INVOICE.secondNotice,
  bailiffAt: INVOICE.bailiff,
  secondBailiffAt: INVOICE.secondBailiff,
  foreclosureAt: INVOICE.foreclosure,
  lastMemo: null,
  ...o,
});
const raid = (o: Partial<Raid> = {}): Raid => ({
  raidId: 12,
  startedAt: 0,
  loadout: { weapon: "S-000041", plates: 1, charges: 2, mags: 2 },
  containers: [
    { spot: 0, tokenId: "copper", amount: 2, bonded: false },
    { spot: 4, tokenId: "fuel", amount: 1, bonded: false },
    { spot: 5, tokenId: "meds", amount: 2, bonded: false },
    { spot: 12, tokenId: "core", amount: 2, bonded: true },
  ],
  wrecks: [
    { id: 301, spot: 1, owner: "marlowe.testnet", callsign: "MARLOWE", weapon: gun("pilot", { serial: "S-000023", state: "wreck" }), items: [{ tokenId: "copper", amount: 3 }], at: 0, expiresAt: 1 },
    { id: 302, spot: 2, owner: "gull.testnet", callsign: "GULL", weapon: null, items: [{ tokenId: "ammo", amount: 2 }], at: 0, expiresAt: 1 },
  ],
  invoiceStart: invoiceStart(1, 0),
  harbormaster: hm(),
  ...o,
});

describe("the gun drives the shooter", () => {
  it.each(["longshore", "stevedore", "pilot"] as const)("a %s's rolled numbers are the shooter's", (frame) => {
    const w = gun(frame);
    const s = shooterSpec(w, 2);
    expect(s).toEqual({
      name: `${FRAMES[frame].name} · C`,
      damage: w.stats.damage,
      rpm: w.stats.rpm,
      mag: w.stats.mag,
      reserve: (RAID.issuedMags + 2) * w.stats.mag,
      reload: w.stats.reload / 100,
      recoil: w.stats.recoil / 100,
      range: w.stats.range,
    });
  });

  it("mods change the numbers: magazine, barrel, compensator, optic", () => {
    const base = gun("longshore", { stats: { damage: 25, rpm: 700, mag: 30, recoil: 100, reload: 100, range: 300 } });
    expect(shooterSpec({ ...base, mods: ["mag2"] }, 0)).toMatchObject({ mag: 40, reserve: 120 });
    expect(shooterSpec({ ...base, mods: ["barrel2"] }, 0)).toMatchObject({ damage: 28, range: 345, rpm: 658 });
    expect(shooterSpec({ ...base, mods: ["comp"] }, 0).recoil).toBe(0.75);
    expect(shooterSpec({ ...base, mods: ["optic"] }, 0).range).toBe(315);
  });

  it("a worn gun hits softer and kicks harder", () => {
    const w = gun("longshore", { stats: { damage: 26, rpm: 700, mag: 30, recoil: 100, reload: 100, range: 300 }, condition: 29 });
    expect(shooterSpec(w, 0)).toMatchObject({ damage: 22, recoil: 1.2 });
    expect(shooterSpec({ ...w, condition: 30 }, 0)).toMatchObject({ damage: 26, recoil: 1 });
  });

  it("no gun is the issue rifle, with three magazines plus the ones brought (0–8)", () => {
    expect(shooterSpec(null, 0)).toEqual({ name: ISSUE.name, damage: 21, rpm: 620, mag: 24, reserve: 72, reload: 1.15, recoil: 1.2, range: 220 });
    expect(shooterSpec(null, 8).reserve).toBe(11 * 24);
    expect(shooterSpec(null, 99).reserve).toBe(11 * 24);
    expect(shooterSpec(null, -3).reserve).toBe(72);
  });

  it("a loadout naming a gun the player no longer holds falls back to the issue rifle", () => {
    const l: Loadout = { weapon: "S-000041", plates: 1, charges: 9, mags: 2 };
    const held = gun("longshore");
    expect(resolveGun(l, held, "rook.testnet")).toMatchObject({ weapon: held, fellBack: false, loadout: { weapon: "S-000041", charges: 3 } });
    for (const lost of [null, gun("longshore", { state: "impound" }), gun("longshore", { state: "wreck" }), gun("longshore", { state: "listed" }), gun("longshore", { owner: "someone.testnet" }), gun("longshore", { condition: 0 }), gun("longshore", { serial: "S-000099" })])
      expect(resolveGun(l, lost, "rook.testnet")).toMatchObject({ weapon: null, fellBack: true, loadout: { weapon: null, plates: 1, mags: 2 } });
    expect(resolveGun({ ...l, weapon: null }, null, "rook.testnet")).toMatchObject({ weapon: null, fellBack: false });
  });
});

describe("the invoice", () => {
  it("follows items.ts invoiceTotal as things happen", () => {
    const L = new RaidLedger(raid());
    const facts = { start: 175, seconds: 0, seals: 0, weight: 0, uplinks: 0, gulls: 0, hounds: 0 };
    expect(L.invoice(0)).toBe(175);
    expect(L.invoice(90)).toBe(invoiceTotal({ ...facts, seconds: 90 }));
    expect(L.cut(0)).toEqual({ ok: true, items: [{ added: 80, why: "CUSTOMS SEAL" }, { added: 80, why: "CARGO · 2 WT" }] });
    expect(L.invoice(90)).toBe(invoiceTotal({ ...facts, seconds: 90, seals: 1, weight: 2 }));
    expect(L.kill("hound")).toEqual({ added: 120, why: "HOUND DESTROYED" });
    expect(L.kill("gull")).toEqual({ added: 40, why: "GULL DESTROYED" });
    expect(L.cutUplink()).toEqual({ added: 200, why: "UPLINK CUT" });
    expect(L.takePart("servo")).toEqual({ ok: true, items: [{ added: 40, why: "HOUND SERVO · 1 WT" }] });
    expect(L.invoice(120)).toBe(invoiceTotal({ start: 175, seconds: 120, seals: 1, weight: 3, uplinks: 1, gulls: 1, hounds: 1 }));
    expect(L.invoice(120)).toBe(175 + 120 + 80 + 120 + 200 + 40 + 120);
    // Every line item's amount is what the total moved by.
    const before = L.invoice(120);
    const r = L.cut(12);
    expect(r.ok && r.items.map((i) => i.why)).toEqual(["BONDED SEAL", "CARGO · 2 WT"]);
    expect(L.invoice(120) - before).toBe(r.ok ? r.items.reduce((a, i) => a + i.added, 0) : -1);
  });

  it("carries: weight slows, a gun weighs 2, and nothing goes over the limit", () => {
    const L = new RaidLedger(raid());
    L.cut(0); // copper ×2
    L.cut(4); // fuel ×1 = 2
    expect(L.weight()).toBe(4);
    expect(L.speed()).toBeCloseTo(1 - 0.06 * 4);
    expect(L.recover(301)).toEqual({ ok: true, items: [{ added: 80, why: "RECOVERED GUN · 2 WT" }] });
    expect(L.weight()).toBe(6);
    expect(L.guns.map((g) => g.serial)).toEqual(["S-000023"]);
    expect(L.cut(5)).toEqual({ ok: false }); // meds ×2 would make 8
    expect(L.kill("hound")).toBeTruthy();
    expect(L.takePart("servo")).toEqual({ ok: false }); // no room
    expect(L.recover(302)).toEqual({ ok: true, items: [] }); // no gun: its magazines weigh nothing here
    expect(L.cut(0)).toEqual({ ok: false }); // already cut
    expect(L.cut(3)).toEqual({ ok: false }); // not on the manifest
    expect(L.recover(301)).toEqual({ ok: false });
    expect(L.weight()).toBe(6);
  });

  it("a part needs a kill behind it", () => {
    const L = new RaidLedger(raid());
    expect(L.takePart("rotor")).toEqual({ ok: false });
    L.kill("gull");
    expect(L.takePart("rotor").ok).toBe(true);
    expect(L.takePart("rotor")).toEqual({ ok: false });
  });

  it("a hound drops a servo about 60% of the time and a gull a rotor 40%, the same for the same raid", () => {
    const share = (type: "hound" | "gull") => Array.from({ length: 4000 }, (_, n) => dropsPart(1 + (n % 40), n, type)).filter(Boolean).length / 4000;
    expect(share("hound")).toBeGreaterThan(0.56);
    expect(share("hound")).toBeLessThan(0.64);
    expect(share("gull")).toBeGreaterThan(0.36);
    expect(share("gull")).toBeLessThan(0.44);
    expect([0, 1, 2, 3, 4, 5].map((n) => dropsPart(12, n, "hound"))).toEqual([0, 1, 2, 3, 4, 5].map((n) => dropsPart(12, n, "hound")));
  });
});

describe("the thresholds", () => {
  it("each fires once, in order, however far one addition jumps", () => {
    const T = new Thresholds(thresholdsOf(hm()));
    expect(T.next()).toEqual({ at: 600, what: "SECOND NOTICE" });
    expect(T.cross(599)).toEqual([]);
    expect(T.cross(600).map((t) => t.id)).toEqual(["second_notice"]);
    expect(T.cross(640)).toEqual([]);
    expect(T.next()).toEqual({ at: 1200, what: "BAILIFF" });
    expect(T.cross(2500).map((t) => t.id)).toEqual(["bailiff", "second_bailiff"]);
    expect(T.next()).toEqual({ at: 4000, what: "FORECLOSURE" });
    expect(T.cross(9000).map((t) => t.id)).toEqual(["foreclosure"]);
    expect(T.cross(9001)).toEqual([]);
    expect(T.next()).toBeNull();
    expect(new Thresholds(thresholdsOf(hm())).cross(5000).map((t) => t.id)).toEqual(["second_notice", "bailiff", "second_bailiff", "foreclosure"]);
  });

  it("the Harbormaster's pursuit brings the Bailiff sooner", () => {
    const bailiffAt = INVOICE.bailiff - HARBORMASTER.bailiffDropPerStrength * 100; // 800 at full strength
    const T = new Thresholds(thresholdsOf(hm({ posture: "pursuit", strength: 100, bailiffAt })));
    expect(T.cross(700).map((t) => t.id)).toEqual(["second_notice"]);
    expect(T.next()).toEqual({ at: 800, what: "BAILIFF" });
    expect(T.cross(800).map((t) => t.id)).toEqual(["bailiff"]);
    // The same invoice under patrols has only had its second notice.
    expect(new Thresholds(thresholdsOf(hm())).cross(800).map((t) => t.id)).toEqual(["second_notice"]);
  });

  it("foreclosure summons the Assessor with 3 + floor(strength / 20) cores", () => {
    expect([0, 19, 20, 55, 100, 400].map(foreclosureCores)).toEqual([3, 3, 4, 5, 8, 8]);
    expect(foreclosureCores(NaN)).toBe(3);
  });
});

describe("the report", () => {
  it("says what happened, inside every cap the contract checks", () => {
    const L = new RaidLedger(raid());
    L.cut(0);
    L.recover(301);
    for (let i = 0; i < 40; i++) L.kill("gull");
    for (let i = 0; i < 20; i++) L.kill("hound");
    L.takePart("servo");
    L.takePart("rotor");
    for (let i = 0; i < 5; i++) L.cutUplink();
    expect(L.kills).toEqual({ gull: 30, hound: 15 });
    const r = L.report(600, { plates: 3, charges: 9, mags: 9 });
    expect(r).toEqual({ opened: [0], wrecks: [301], parts: { servo: 1, rotor: 1 }, kills: { gull: 30, hound: 15 }, uplinks: 3, used: { plates: 1, charges: 2, mags: 2 } });
    expect(L.weight()).toBe(2 + 2 + 1 + 1);
    expect(L.weight()).toBeLessThanOrEqual(RAID.carryLimit);
  });

  it("kills are capped at one for every four seconds, and parts never exceed kills", () => {
    expect(capKills({ gull: 6, hound: 4 }, { servo: 0, rotor: 0 }, 400)).toEqual({ gull: 6, hound: 4 });
    expect(capKills({ gull: 6, hound: 4 }, { servo: 2, rotor: 1 }, 20)).toEqual({ gull: 1, hound: 4 }); // gulls go first, down to the rotor's
    expect(capKills({ gull: 6, hound: 4 }, { servo: 2, rotor: 1 }, 12)).toEqual({ gull: 1, hound: 2 });
    expect(capKills({ gull: 6, hound: 4 }, { servo: 2, rotor: 1 }, 4)).toEqual({ gull: 0, hound: 1 });
    const L = new RaidLedger(raid());
    for (let i = 0; i < 3; i++) (L.kill("hound"), L.takePart("servo"));
    const r = L.report(8, { plates: 0, charges: 0, mags: 0 });
    expect(r.kills).toEqual({ gull: 0, hound: 2 });
    expect(r.parts.servo).toBeLessThanOrEqual(r.kills.hound);
    expect(r.kills.gull + r.kills.hound).toBeLessThanOrEqual(Math.floor(8 / RAID.secondsPerKill));
  });

  it("gear used: the plate worn, charges thrown, and brought magazines only after the issued ones", () => {
    const l: Loadout = { weapon: null, plates: 1, charges: 2, mags: 2 };
    const full = (1 + 3 + 2) * 30;
    expect(gearUsed(l, 30, { chargesLeft: 2, roundsLeft: full })).toEqual({ plates: 1, charges: 0, mags: 0 });
    expect(gearUsed(l, 30, { chargesLeft: 0, roundsLeft: full - 120 })).toEqual({ plates: 1, charges: 2, mags: 0 });
    expect(gearUsed(l, 30, { chargesLeft: 1, roundsLeft: full - 121 })).toEqual({ plates: 1, charges: 1, mags: 1 });
    expect(gearUsed(l, 30, { chargesLeft: 3, roundsLeft: 0 })).toEqual({ plates: 1, charges: 0, mags: 2 });
    expect(gearUsed(l, 30, { chargesLeft: 5, roundsLeft: full + 60 })).toEqual({ plates: 1, charges: 0, mags: 0 }); // pickups
    // Unknown counts as used: the contract returns only what the game can vouch for.
    expect(gearUsed(l, 30, { chargesLeft: null, roundsLeft: null })).toEqual({ plates: 1, charges: 2, mags: 2 });
  });

  it("a manifest is checked before any of it is shown, and fails closed", () => {
    expect(checkRaid(raid())).toBeTruthy();
    expect(checkRaid(null)).toBeNull();
    expect(checkRaid(raid({ containers: [{ spot: 16, tokenId: "copper", amount: 1, bonded: false }] }))).toBeNull();
    expect(checkRaid(raid({ containers: [{ spot: 1, tokenId: "copper", amount: 1, bonded: false }, { spot: 1, tokenId: "meds", amount: 1, bonded: false }] }))).toBeNull();
    expect(checkRaid(raid({ containers: [{ spot: 1, tokenId: "gold" as never, amount: 1, bonded: false }] }))).toBeNull();
    expect(checkRaid(raid({ containers: [{ spot: 1, tokenId: "copper", amount: 0, bonded: false }] }))).toBeNull();
    expect(checkRaid(raid({ harbormaster: hm({ bailiffAt: NaN }) }))).toBeNull();
    expect(checkRaid(raid({ invoiceStart: -1 }))).toBeNull();
    expect(checkRaid(raid({ wrecks: [{ ...raid().wrecks[0], weapon: { frame: "cannon" } as never }] }))).toBeNull();
  });

  it("a bonded seal takes longer to cut", () => {
    expect(HOLD.bonded).toBeGreaterThan(HOLD.seal);
  });
});

describe("what killed the player", () => {
  it("is the Bailiff when its grab landed at the moment of death", () => {
    expect(deathBy(10_000, [])).toBe("machines");
    expect(deathBy(10_000, [10_000])).toBe("bailiff");
    expect(deathBy(10_000, [3_000, 9_990])).toBe("bailiff");
    expect(deathBy(10_000, [10_004])).toBe("bailiff"); // the Bailiff's event comes just after the death
    expect(deathBy(10_000, [8_000])).toBe("machines"); // grabbed, survived, shot by a drone two seconds later
  });

  it("the wreck is logged at the nearest salvage spot", () => {
    expect(nearestSpot(-10, 2)).toBe(0);
    expect(nearestSpot(-22, -26)).toBe(9);
    expect(zoneOf(9)).toBe("by the shed");
    expect(zoneOf(0)).toBe("in the yard");
  });
});

describe("signing on", () => {
  const never = () => new Promise<void>(() => {});
  const now = () => Promise.resolve();
  const wallet = { accountId: () => "rook.testnet" as string | null };
  const loadout: Loadout = { weapon: "S-000041", plates: 1, charges: 2, mags: 2 };
  const chain = (o: Partial<Pick<Chain2, "weapon" | "startRaid">> = {}): Pick<Chain2, "weapon" | "startRaid"> => ({
    weapon: async () => gun("longshore"),
    startRaid: async (l) => ({ ok: true, raid: raid({ loadout: l }) }),
    ...o,
  });

  it("signed: the contract's raid and the gun it locked", async () => {
    const r = await signOn({ chain: chain(), wallet, loadout, sleep: never });
    expect(r).toMatchObject({ kind: "signed", fellBack: false, weapon: { serial: "S-000041" }, raid: { raidId: 12 } });
  });

  it("refused: the contract's reason, and nothing signed", async () => {
    const r = await signOn({ chain: chain({ startRaid: async () => ({ ok: false, error: "Too soon after your last raid.", code: "E_TOO_SOON" }) }), wallet, loadout, sleep: never });
    expect(r).toEqual({ kind: "refused", why: "Too soon after your last raid." });
    expect(await signOn({ chain: chain(), wallet: { accountId: () => null }, loadout, sleep: never })).toMatchObject({ kind: "refused" });
    // A manifest that doesn't hold together is refused whole.
    expect(await signOn({ chain: chain({ startRaid: async () => ({ ok: true, raid: raid({ invoiceStart: NaN }) }) }), wallet, loadout, sleep: never })).toMatchObject({ kind: "refused" });
  });

  it("unconfirmed, never failed: no answer in time, a thrown call, or a pending one", async () => {
    expect(await signOn({ chain: chain({ startRaid: () => new Promise(() => {}) }), wallet, loadout, sleep: now })).toMatchObject({ kind: "unconfirmed" });
    expect(await signOn({ chain: chain({ startRaid: () => Promise.reject(new Error("rpc down")) }), wallet, loadout, sleep: never })).toMatchObject({ kind: "unconfirmed" });
    expect(await signOn({ chain: chain({ startRaid: async () => ({ ok: false, pending: true }) }), wallet, loadout, sleep: never })).toMatchObject({ kind: "unconfirmed" });
    // A gun that can't be read can't be put in the player's hands.
    let started = 0;
    const r = await signOn({ chain: chain({ weapon: () => Promise.reject(new Error("rpc down")), startRaid: async () => (started++, { ok: true, raid: raid() }) }), wallet, loadout, sleep: never });
    expect(r).toMatchObject({ kind: "unconfirmed" });
    expect(started).toBe(0);
  });

  it("a lost gun falls back to the issue rifle before the contract is asked", async () => {
    const sent: Loadout[] = [];
    const r = await signOn({ chain: chain({ weapon: async () => gun("longshore", { state: "impound" }), startRaid: async (l) => (sent.push(l), { ok: true, raid: raid({ loadout: l }) }) }), wallet, loadout, sleep: never });
    expect(r).toMatchObject({ kind: "signed", weapon: null, fellBack: true });
    expect(sent).toEqual([{ weapon: null, plates: 1, charges: 2, mags: 2 }]);
    expect(shooterSpec(r.kind === "signed" ? r.weapon : gun("pilot"), 2).name).toBe(ISSUE.name);
  });

  it("the dev fake plays the contract's part: a lock, a manifest with a bonded container and a wreck holding a gun, an impound", async () => {
    const v2 = createFakeV2();
    const a = await signOn({ chain: v2.chain, wallet: v2.wallet, loadout: v2.loadout, sleep: never });
    if (a.kind !== "signed") throw new Error(a.kind);
    expect(a.weapon).toMatchObject({ frame: "stevedore", grade: "B" });
    expect((await v2.chain.weapon("S-000041"))?.grade).toBe("C");
    expect(a.raid.containers.filter((c) => c.bonded)).toHaveLength(1);
    expect(a.raid.wrecks.filter((w) => w.weapon)).toHaveLength(1);
    expect(a.raid.invoiceStart).toBe(175);
    const L = new RaidLedger(a.raid);
    const d = await v2.chain.die(a.raid.raidId, L.report(60, { plates: 1, charges: 0, mags: 0 }), 9, "bailiff");
    expect(d).toMatchObject({ ok: true, impounded: true, wreckId: null });
    expect(v2.calls.map((c) => c.method)).toEqual(["startRaid", "die"]);
    const b = await signOn({ chain: v2.chain, wallet: v2.wallet, loadout: v2.loadout, sleep: never });
    expect(b).toMatchObject({ kind: "signed", weapon: null, fellBack: true });
  });
});
