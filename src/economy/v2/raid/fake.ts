// A stand-in for G.v2 while the chain client and its offline mock aren't merged (DEV only; index.ts imports this
// behind import.meta.env.DEV when nothing has set G.v2 after 2 s). One registered player, ROOK, holding a B-grade
// Stevedore and a C-grade Longshore. startRaid hands back a manifest with eight containers, one bonded container and
// one wreck holding a gun; extract and die record what they were sent (`calls`) and move the gun as the contract
// would (wear, a wreck, the impound), so the raid can be played and tested end to end. It is not the chain.
import { CONDITION, INVOICE, RAID, appraise, gradeOf, invoiceStart, invoiceTotal, quality } from "../items";
import type { Amounts, Chain2, DeathBy, FrameId, HarbormasterView, Loadout, Profile, Raid, RaidReport, Stats, V2, Weapon } from "../types";

export interface FakeCall {
  method: "startRaid" | "extract" | "die";
  args: unknown[];
}

export interface FakeV2 extends V2 {
  /** Every call the raid made, in order. */
  readonly calls: FakeCall[];
  readonly profileNow: Profile;
  /** Test switches: refuse the next startRaid with this message, or never answer it. */
  refuseNext: string | null;
  hangNext: boolean;
  harbormasterNow: HarbormasterView;
}

const ACCOUNT = "rook.dev.testnet";

function gun(serial: string, frame: FrameId, stats: Stats, o: Partial<Weapon> = {}): Weapon {
  const q = quality(frame, stats);
  const grade = gradeOf(q);
  return {
    serial,
    frame,
    grade,
    quality: q,
    stats,
    mods: [],
    condition: 100,
    maker: "moss.saltline.testnet",
    makerCallsign: "MOSS",
    owner: ACCOUNT,
    builtAt: Date.now() - 86_400_000,
    raids: 3,
    extractions: 2,
    owners: 1,
    recovered: 0,
    state: "held",
    value: appraise(frame, grade, 100),
    ...o,
  };
}

export function createFakeV2(): FakeV2 {
  const calls: FakeCall[] = [];
  const profile: Profile = { accountId: ACCOUNT, callsign: "ROOK", registeredAt: Date.now() - 3 * 86_400_000, raids: 11, extractions: 1, deaths: 2, arrears: 0, activeRaid: null, built: 0, royalties: 0 };
  const guns: Weapon[] = [
    gun("S-000007", "stevedore", { damage: 20, rpm: 970, mag: 40, recoil: 80, reload: 85, range: 172 }),
    gun("S-000041", "longshore", { damage: 27, rpm: 710, mag: 31, recoil: 100, reload: 100, range: 290 }),
  ];
  const wreckGun = gun("S-000023", "pilot", { damage: 52, rpm: 345, mag: 14, recoil: 126, reload: 108, range: 425 }, { owner: "marlowe.testnet", makerCallsign: "MARLOWE", condition: 64, state: "wreck" });
  const hm: HarbormasterView = {
    accountId: "harbormaster.saltline.testnet",
    balance: 600,
    strength: 30,
    posture: "patrols",
    bonusDrones: 1,
    secondNoticeAt: INVOICE.secondNotice,
    bailiffAt: INVOICE.bailiff,
    secondBailiffAt: INVOICE.secondBailiff,
    foreclosureAt: INVOICE.foreclosure,
    lastMemo: "Collections are up. Patrols funded.",
  };
  let raids = profile.raids;
  let open: Raid | null = null;
  const later = <T>(v: T, ms = 350) => new Promise<T>((ok) => setTimeout(() => ok(v), ms));
  const no = (): never => {
    throw new Error("the dev fake has no dock");
  };
  const seconds = () => (open ? Math.floor((Date.now() - open.startedAt) / 1000) : 0);
  const billed = (r: RaidReport, weight: number) =>
    invoiceTotal({ start: open!.invoiceStart, seconds: seconds(), seals: r.opened.length, weight, uplinks: r.uplinks, gulls: r.kills.gull, hounds: r.kills.hound });
  const weightOfReport = (r: RaidReport) => {
    let w = r.parts.servo + r.parts.rotor + 2 * r.wrecks.filter((id) => open!.wrecks.find((x) => x.id === id)?.weapon).length;
    for (const s of r.opened) {
      const c = open!.containers.find((x) => x.spot === s);
      if (c) w += c.amount * (c.tokenId === "fuel" ? 2 : 1);
    }
    return w;
  };

  const chain = {
    network: "mock",
    contractId: "fake.v2",
    txUrl: () => null,
    accountUrl: () => null,
    profile: async (id: string) => (id === ACCOUNT ? { ...profile } : null),
    balances: async () => ({ scrip: 150, plate: 2, charge: 3, ammo: 8 }) as Amounts,
    weapons: async (id: string) => (id === ACCOUNT ? guns.map((g) => ({ ...g })) : []),
    weapon: async (serial: string) => {
      const g = guns.find((x) => x.serial === serial);
      return g ? { ...g } : null;
    },
    harbormaster: async () => ({ ...v2.harbormasterNow }),
    raid: async (id: number) => (open && open.raidId === id ? open : null),
    async startRaid(loadout: Loadout) {
      calls.push({ method: "startRaid", args: [structuredClone(loadout)] });
      if (v2.hangNext) return ((v2.hangNext = false), new Promise<never>(() => {}));
      if (v2.refuseNext) {
        const error = v2.refuseNext;
        v2.refuseNext = null;
        return later({ ok: false, error, code: "E_TOO_SOON" });
      }
      const g = loadout.weapon ? guns.find((x) => x.serial === loadout.weapon) : null;
      if (loadout.weapon && (!g || g.state !== "held")) return later({ ok: false, error: "That gun isn't in your stash.", code: "E_WEAPON_BUSY" });
      if (g) g.state = "raid";
      raids++;
      profile.raids = raids;
      const raid: Raid = {
        raidId: raids,
        startedAt: Date.now(),
        loadout: { ...loadout },
        containers: [
          { spot: 0, tokenId: "copper", amount: 2, bonded: false },
          { spot: 4, tokenId: "chips", amount: 1, bonded: false },
          { spot: 5, tokenId: "meds", amount: 2, bonded: false },
          { spot: 7, tokenId: "fuel", amount: 1, bonded: false },
          { spot: 8, tokenId: "copper", amount: 1, bonded: false },
          { spot: 9, tokenId: "core", amount: 1, bonded: false },
          { spot: 11, tokenId: "chips", amount: 2, bonded: false },
          { spot: 13, tokenId: "rotor", amount: 1, bonded: false },
          { spot: 12, tokenId: "core", amount: 2, bonded: true },
        ],
        wrecks: [{ id: 301, spot: 1, owner: "marlowe.testnet", callsign: "MARLOWE", weapon: { ...wreckGun }, items: [{ tokenId: "copper", amount: 1 }], at: Date.now() - 3_600_000 * 5, expiresAt: Date.now() + 3_600_000 * 19 }],
        invoiceStart: invoiceStart(profile.extractions, profile.arrears),
        harbormaster: { ...v2.harbormasterNow },
      };
      open = raid;
      profile.activeRaid = raid.raidId;
      return later({ ok: true, txHash: "FAKEstart" + raid.raidId, raid: structuredClone(raid) });
    },
    async extract(raidId: number, report: RaidReport) {
      calls.push({ method: "extract", args: [raidId, structuredClone(report)] });
      if (!open || open.raidId !== raidId) return later({ ok: false, error: "No such raid.", code: "E_NO_RAID" });
      const minted: Amounts = {};
      for (const s of report.opened) {
        const c = open.containers.find((x) => x.spot === s);
        if (c) minted[c.tokenId] = (minted[c.tokenId] ?? 0) + c.amount;
      }
      if (report.parts.servo) minted.servo = (minted.servo ?? 0) + report.parts.servo;
      if (report.parts.rotor) minted.rotor = (minted.rotor ?? 0) + report.parts.rotor;
      const recovered: Weapon[] = [];
      for (const id of report.wrecks) {
        const w = open.wrecks.find((x) => x.id === id);
        if (!w) continue;
        for (const it of w.items) minted[it.tokenId] = (minted[it.tokenId] ?? 0) + it.amount;
        if (w.weapon) {
          const g: Weapon = { ...w.weapon, owner: ACCOUNT, owners: w.weapon.owners + 1, recovered: w.weapon.recovered + 1, condition: Math.max(0, w.weapon.condition - CONDITION.recovered), state: "held" };
          g.value = appraise(g.frame, g.grade, g.condition);
          guns.push(g);
          recovered.push({ ...g });
        }
      }
      const g = open.loadout.weapon ? guns.find((x) => x.serial === open!.loadout.weapon) : null;
      if (g) {
        g.state = "held";
        g.condition = Math.max(0, g.condition - CONDITION.perRaid);
        g.raids++;
        g.extractions++;
        g.value = appraise(g.frame, g.grade, g.condition);
      }
      const invoice = billed(report, weightOfReport(report));
      profile.arrears += Math.floor((invoice * INVOICE.arrearsOnExtract) / 100);
      profile.extractions++;
      profile.activeRaid = null;
      open = null;
      return later({ ok: true, txHash: "FAKEextract" + raidId, minted, weapon: g ? { ...g } : null, recovered, invoice, arrears: profile.arrears });
    },
    async die(raidId: number, report: RaidReport, spot: number, by: DeathBy) {
      calls.push({ method: "die", args: [raidId, structuredClone(report), spot, by] });
      if (!open || open.raidId !== raidId) return later({ ok: false, error: "No such raid.", code: "E_NO_RAID" });
      const g = open.loadout.weapon ? guns.find((x) => x.serial === open!.loadout.weapon) : null;
      if (g) g.state = by === "bailiff" ? "impound" : "wreck";
      const invoice = billed(report, weightOfReport(report));
      profile.arrears += Math.floor((invoice * INVOICE.arrearsOnDeath) / 100);
      profile.deaths++;
      profile.activeRaid = null;
      const carried = report.opened.length + report.parts.servo + report.parts.rotor > 0;
      open = null;
      return later({ ok: true, txHash: "FAKEdie" + raidId, wreckId: by === "machines" && (g || carried) ? 900 + raidId : null, impounded: by === "bailiff" && !!g, invoice, arrears: profile.arrears });
    },
    vendors: no,
    exportPrices: no,
    listings: no,
    wrecks: async () => [],
    impound: async () => guns.filter((x) => x.state === "impound").map((weapon) => ({ weapon: { ...weapon }, fee: Math.floor((weapon.value * RAID.buyBackPct) / 100), expiresAt: Date.now() + RAID.impoundHours * 3_600_000 })),
    recent: async () => [],
    economy: no,
    leaderboard: no,
    build: no,
    fit: no,
    repair: no,
    scrap: no,
    sell: no,
    buy: no,
    buyGun: no,
    exportGoods: no,
    listWeapon: no,
    listItem: no,
    buyListing: no,
    cancelListing: no,
    settle: no,
    buyBack: no,
  } as unknown as Chain2;

  const v2: FakeV2 = {
    chain,
    wallet: { kind: "mock", accountId: () => ACCOUNT, registered: async () => true, claim: async () => ({ ok: true }) },
    loadout: { weapon: "S-000007", plates: 1, charges: 2, mags: 2 },
    raid: null,
    calls,
    profileNow: profile,
    refuseNext: null,
    hangNext: false,
    harbormasterNow: hm,
  };
  return v2;
}
