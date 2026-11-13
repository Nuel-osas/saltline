// A stand-in for the chain client, for building and testing the dock before the real one (another lane's) is
// attached. It is loaded only in dev (index.ts imports it dynamically under import.meta.env.DEV) and by the tests;
// a production build never ships it. It is NOT the contract: it follows docs/CONTRACT_V2.md closely enough for the
// screens to behave, holds everything in memory, and its calls land after a short delay.
import { appraise, BLUEPRINTS, CONDITION, FRAMES, gradeOf, HARBORMASTER, INVOICE, MARKET, MATERIALS, MODS, quality, RAID, STAT_KEYS, TOKEN_NAMES, VENDORS } from "../items";
import type {
  Amounts,
  BlueprintId,
  Chain2,
  ConsumableId,
  EconomyView,
  FrameId,
  Grade,
  HarbormasterView,
  Impounded,
  LedgerEvent,
  LedgerKind,
  Listing,
  MaterialId,
  ModId,
  Profile,
  Quote,
  Stats,
  TokenId,
  TxResult,
  V2,
  Vendor,
  VendorId,
  Wallet2,
  Weapon,
} from "../types";

export interface FakeOptions {
  registered?: boolean;
  /** Ms before a call or view answers (default 550). */
  latency?: number;
}

export interface FakeControls {
  /** Views named here reject (the dock must show them as unknown). */
  failViews: Set<string>;
  /** How the next call answers: landed, no answer (pending), thrown, or refused by the contract. */
  next: "ok" | "pending" | "throw" | "refuse";
  /** The grade the next built gun rolls (the screenshots ask for an A). */
  nextGrade: Grade | null;
  readonly me: string;
  readonly calls: string[];
  balances: Amounts;
  weapons: Weapon[];
  harbormaster: HarbormasterView;
  profile: Profile | null;
}

export type FakeV2 = V2 & { fake: FakeControls };

const ME = "breacher-7f3a.testnet";

/** The contract refusing a call: its code and its short reason. */
class Refusal {
  constructor(
    readonly code: string,
    readonly error: string,
  ) {}
}
const no = (code: string, error: string) => new Refusal(code, error);
const HOUR = 3_600_000;

/** A small seeded generator, so the fake's guns are the same on every load. */
function rng(seed: number) {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    return x / 4294967296;
  };
}

/** Stats landing about `t` (0–1) of the way to the good end of every band. */
function roll(frame: FrameId, t: number, rand: () => number): Stats {
  const out = {} as Stats;
  for (const k of STAT_KEYS) {
    const [lo, hi] = FRAMES[frame].bands[k];
    const lower = k === "recoil" || k === "reload";
    const g = Math.max(0, Math.min(1, t + (rand() - 0.5) * 0.24));
    out[k] = Math.round(lower ? hi - (hi - lo) * g : lo + (hi - lo) * g);
  }
  return out;
}

const TARGET: Record<Grade, number> = { A: 0.93, B: 0.72, C: 0.5, D: 0.2 };

export function createFake(opts: FakeOptions = {}): FakeV2 {
  const latency = opts.latency ?? 550;
  const rand = rng(20261113);
  const now = () => Date.now();
  let serialNo = 80;
  let listingNo = 30;
  let txNo = 0;

  function gun(frame: FrameId, want: Grade, o: Partial<Weapon> = {}): Weapon {
    let stats = roll(frame, TARGET[want], rand);
    for (let i = 0; i < 40 && gradeOf(quality(frame, stats)) !== want; i++) stats = roll(frame, TARGET[want], rand);
    const q = quality(frame, stats);
    const grade = gradeOf(q);
    const condition = o.condition ?? 100;
    return {
      serial: o.serial ?? `S-${String(++serialNo).padStart(6, "0")}`,
      frame,
      grade,
      quality: q,
      stats,
      mods: [],
      condition,
      maker: "rook.testnet",
      makerCallsign: "ROOK",
      owner: ME,
      builtAt: now() - 9 * 24 * HOUR,
      raids: 0,
      extractions: 0,
      owners: 1,
      recovered: 0,
      state: "held",
      ...o,
      value: appraise(frame, grade, condition),
    };
  }

  let profile: Profile | null =
    opts.registered === false
      ? null
      : { accountId: ME, callsign: "WREN", registeredAt: now() - 12 * 24 * HOUR, raids: 14, extractions: 9, deaths: 5, arrears: 1240, activeRaid: null, built: 3, royalties: 86 };
  const balances: Amounts = { scrip: 2400, copper: 14, chips: 9, fuel: 3, meds: 4, core: 2, servo: 5, rotor: 4, mag2: 1, comp: 1, optic: 1, plate: 1, charge: 2, ammo: 6 };

  const weapons: Weapon[] = [
    gun("pilot", "A", { serial: "S-000041", mods: ["optic", "barrel2"], condition: 82, raids: 19, extractions: 14, owners: 3, recovered: 1 }),
    gun("longshore", "B", { serial: "S-000017", maker: ME, makerCallsign: "WREN", condition: 96, raids: 7, extractions: 6 }),
    gun("stevedore", "C", { serial: "S-000052", maker: "marlowe.testnet", makerCallsign: "MARLOWE", condition: 24, raids: 12, extractions: 9, owners: 2 }),
    gun("longshore", "D", { serial: "S-000063", maker: ME, makerCallsign: "WREN", condition: 88, raids: 2, extractions: 2, state: "listed" }),
  ];
  const impound: Impounded[] = [];
  {
    const w = gun("pilot", "B", { serial: "S-000029", maker: "halyard.testnet", makerCallsign: "HALYARD", condition: 71, raids: 11, extractions: 8, owners: 2, state: "impound" });
    impound.push({ weapon: w, fee: Math.floor((w.value * RAID.buyBackPct) / 100), expiresAt: now() + 31 * HOUR + 12 * 60_000 });
  }

  const other = (frame: FrameId, g: Grade, who: string, o: Partial<Weapon> = {}) =>
    gun(frame, g, { owner: `${who.toLowerCase()}.testnet`, maker: `${who.toLowerCase()}.testnet`, makerCallsign: who, state: "listed", ...o });
  const listings: Listing[] = [];
  const list = (w: Weapon, who: string, price: number, hoursAgo: number) => listings.push({ id: ++listingNo, seller: w.owner, callsign: who, price, at: now() - hoursAgo * HOUR, weapon: w });
  list(other("pilot", "A", "KESTREL", { mods: ["optic"], condition: 100, raids: 3, extractions: 3 }), "KESTREL", 2650, 1);
  list(other("longshore", "A", "ROOK", { mods: ["comp", "mag2"], condition: 94, raids: 8, extractions: 7 }), "ROOK", 1980, 2);
  list(other("stevedore", "B", "MARLOWE", { condition: 90, raids: 5, extractions: 4 }), "MARLOWE", 890, 3);
  list(other("pilot", "C", "HALYARD", { condition: 67, raids: 14, extractions: 9, owners: 2, recovered: 1, maker: "rook.testnet", makerCallsign: "ROOK" }), "HALYARD", 840, 5);
  list(other("longshore", "B", "TERN", { mods: ["barrel2"], condition: 78, raids: 9, extractions: 8 }), "TERN", 1040, 6);
  list(other("stevedore", "D", "BOSUN", { condition: 55, raids: 16, extractions: 10, owners: 4, recovered: 2, maker: "marlowe.testnet", makerCallsign: "MARLOWE" }), "BOSUN", 360, 9);
  list(other("longshore", "C", "GANTRY", { condition: 100 }), "GANTRY", 760, 11);
  listings.push({ id: ++listingNo, seller: ME, callsign: "WREN", price: 520, at: now() - 4 * HOUR, weapon: weapons[3] });
  listings.push({ id: ++listingNo, seller: "tern.testnet", callsign: "TERN", price: 310, at: now() - 2 * HOUR, item: { tokenId: "core", amount: 2 } });
  listings.push({ id: ++listingNo, seller: "bosun.testnet", callsign: "BOSUN", price: 95, at: now() - 7 * HOUR, item: { tokenId: "optic", amount: 1 } });
  listings.sort((a, b) => b.at - a.at);

  const vendorState: Record<VendorId, { scrip: number; stock: Amounts<MaterialId>; goods: Vendor["goods"]; guns: Vendor["guns"]; memo: string }> = {
    moss: {
      scrip: 1320,
      stock: { copper: 12, chips: 14, servo: 3, rotor: 7, core: 2 },
      goods: [
        { tokenId: "barrel2", price: 215, stock: 2, reason: "Rifled it myself. It shoots where you point it." },
        { tokenId: "comp", price: 150, stock: 3, reason: "Three on the shelf. I'd rather they were on rifles." },
        { tokenId: "mag2", price: 165, stock: 1, reason: "Last one. Springs are hard to come by." },
        { tokenId: "optic", price: 290, stock: 1, reason: "Glass off a crane camera. You won't find better." },
      ],
      guns: [],
      memo: "Servos are short and everyone wants a Longshore. Bring me servos and I'll build two more this week.",
    },
    ines: {
      scrip: 940,
      stock: { meds: 6, fuel: 5, chips: 9 },
      goods: [
        { tokenId: "plate", price: 62, stock: 8, reason: "Steel is steel. Wear it." },
        { tokenId: "charge", price: 48, stock: 6, reason: "Fuel cells are dear this week, so these are too." },
        { tokenId: "ammo", price: 12, stock: 34, reason: "Take more than you think. Everyone runs dry at the cranes." },
      ],
      guns: [],
      memo: "Three Breachers came back without their rifles yesterday. All three skipped the plate.",
    },
  };
  {
    const a = gun("longshore", "C", { serial: "S-000070", owner: "moss.saltline.testnet", maker: "moss.saltline.testnet", makerCallsign: "MOSS", state: "vendor" });
    const b = gun("stevedore", "B", { serial: "S-000071", owner: "moss.saltline.testnet", maker: "moss.saltline.testnet", makerCallsign: "MOSS", state: "vendor", mods: ["comp"] });
    vendorState.moss.guns.push({ weapon: a, price: Math.floor(a.value * 1.25) }, { weapon: b, price: Math.floor(b.value * 1.25) });
  }
  const BID_WHY: Record<MaterialId, [string, string]> = {
    copper: ["Every rifle starts as a coil of this.", "I'm stacked with coil. Price drops till I use it."],
    chips: ["Trigger groups, optics, all of it needs boards.", "Boards I have. Bring something else."],
    servo: ["No servos, no Longshores. I'm paying over the odds.", "Enough servos for now."],
    rotor: ["Gull rotors make good muzzle work.", "Plenty of rotors on the bench."],
    core: ["A relay core is the heart of a Pilot. I'll always take one.", "Two cores is all I can afford to sit on."],
    meds: ["Injectors don't fill themselves.", "The cold box is full."],
    fuel: ["Charges and plates both eat fuel cells.", "I've cells enough for the week."],
  };
  const bidOf = (v: VendorId, id: MaterialId, stock = vendorState[v].stock[id] ?? 0) => Math.floor((MATERIALS[id].bid * 2 * MATERIALS[id].target) / (MATERIALS[id].target + stock));

  const exported: Amounts<MaterialId> = { copper: 9, chips: 4, core: 1, fuel: 2 };
  const exportOf = (id: MaterialId, n = exported[id] ?? 0) => Math.floor((MATERIALS[id].export * 100) / (100 + 4 * n));

  const hm: HarbormasterView = {
    accountId: "harbormaster.saltline.testnet",
    balance: 1180,
    strength: 59,
    posture: "patrols",
    bonusDrones: 2,
    secondNoticeAt: INVOICE.secondNotice,
    bailiffAt: INVOICE.bailiff,
    secondBailiffAt: INVOICE.secondBailiff,
    foreclosureAt: INVOICE.foreclosure,
    lastMemo: "Receipts are up 14% on the day. The surplus has been allocated to patrol coverage. Thank you for your prompt payment.",
  };
  function restrength() {
    hm.strength = Math.min(100, Math.floor(hm.balance / HARBORMASTER.scripPerStrength));
    hm.bonusDrones = hm.posture === "patrols" ? Math.min(4, Math.floor(hm.strength / HARBORMASTER.strengthPerDrone)) : 0;
    hm.bailiffAt = hm.posture === "pursuit" ? INVOICE.bailiff - HARBORMASTER.bailiffDropPerStrength * hm.strength : INVOICE.bailiff;
  }

  const economy: EconomyView = {
    scripSupply: 48_250,
    minted24h: 6_420,
    burned24h: 5_130,
    players: 212,
    weaponsBuilt: 143,
    weaponsAlive: 97,
    weaponsDestroyed: 46,
    lastSales: [
      { frame: "pilot", grade: "A", prices: [2480, 2710, 2390] },
      { frame: "pilot", grade: "B", prices: [1420, 1380] },
      { frame: "pilot", grade: "C", prices: [900, 860, 930, 880] },
      { frame: "longshore", grade: "A", prices: [1890, 2050] },
      { frame: "longshore", grade: "B", prices: [1010, 980, 1120, 1060, 990] },
      { frame: "longshore", grade: "C", prices: [720, 770, 740] },
      { frame: "longshore", grade: "D", prices: [540, 500] },
      { frame: "stevedore", grade: "B", prices: [860, 910] },
      { frame: "stevedore", grade: "C", prices: [590, 610, 570] },
    ],
  };

  const recent: LedgerEvent[] = [];
  const log = (kind: LedgerKind, text: string, account = ME, callsign = profile?.callsign ?? "WREN", at = now()) => void recent.unshift({ kind, at, account, callsign, text });
  log("vendor_build", "Moss built a B-grade Stevedore, S-000071.", "moss.saltline.testnet", "MOSS", now() - 52 * 60_000);
  log("wreck", "MARLOWE's Longshore S-000038 is in a wreck by the shed.", "marlowe.testnet", "MARLOWE", now() - 41 * 60_000);
  log("market_sale", "KESTREL bought a B-grade Longshore from TERN for 1,060.", "kestrel.testnet", "KESTREL", now() - 33 * 60_000);
  log("settle", "HALYARD paid the Harbormaster 240. It thanks them.", "halyard.testnet", "HALYARD", now() - 27 * 60_000);
  log("impound", "The Bailiff took WREN's Pilot S-000029. It is in the impound.", ME, "WREN", now() - 17 * HOUR);
  log("export", "BOSUN exported 6 copper coil for 131.", "bosun.testnet", "BOSUN", now() - 19 * 60_000);
  log("build", "ROOK built an A-grade Pilot, S-000077.", "rook.testnet", "ROOK", now() - 12 * 60_000);
  log("recover", "TERN carried GANTRY's Stevedore S-000044 out of a wreck.", "tern.testnet", "TERN", now() - 8 * 60_000);
  log("posture", "The Harbormaster moved its strength to patrols.", hm.accountId, "HARBORMASTER", now() - 5 * 60_000);
  log("extract", "KESTREL reached the boat with 5 weight. Invoice 980.", "kestrel.testnet", "KESTREL", now() - 2 * 60_000);
  recent.sort((a, b) => b.at - a.at);

  const controls: FakeControls = {
    failViews: new Set(),
    next: "ok",
    nextGrade: null,
    me: ME,
    calls: [],
    balances,
    weapons,
    harbormaster: hm,
    get profile() {
      return profile;
    },
    set profile(p) {
      profile = p;
    },
  };

  const wait = () => new Promise<void>((r) => setTimeout(r, latency));
  const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v));
  async function view<T>(name: string, f: () => T): Promise<T> {
    await new Promise<void>((r) => setTimeout(r, Math.min(latency, 120)));
    if (controls.failViews.has(name)) throw new Error(`${name}: no answer`);
    return copy(f());
  }
  const have = (id: TokenId) => balances[id] ?? 0;
  const add = (id: TokenId, n: number) => void (balances[id] = have(id) + n);

  /** One call: the delay, then the contract's answer. `f` returns the result's fields, or a refusal as [code, message]. */
  async function call<T extends object>(name: string, f: () => T | Refusal): Promise<TxResult & Partial<T>> {
    controls.calls.push(name);
    await wait();
    const mode = controls.next;
    controls.next = "ok";
    if (mode === "throw") throw new Error("network");
    if (mode === "refuse") return { ok: false, code: "E_PAUSED", error: "The dock is closed for inspection" } as TxResult & Partial<T>;
    if (!profile) return { ok: false, code: "E_NOT_REGISTERED", error: "No dock pass" } as TxResult & Partial<T>;
    const r = f();
    if (r instanceof Refusal) return { ok: false, code: r.code, error: r.error } as TxResult & Partial<T>;
    // No answer: it landed (the state above changed), but the client couldn't confirm it.
    if (mode === "pending") return { ok: false, pending: true } as TxResult & Partial<T>;
    return { ok: true, txHash: `fake${++txNo}`, ...copy(r) } as TxResult & Partial<T>;
  }
  const mine = (serial: string) => weapons.find((w) => w.serial === serial);
  const revalue = (w: Weapon) => void (w.value = appraise(w.frame, w.grade, w.condition));

  const chain: Chain2 = {
    network: "mock",
    contractId: "fake.dock",
    txUrl: () => null,
    accountUrl: () => null,

    profile: (id) => view("profile", () => (id === ME ? profile : null)),
    balances: () => view("balances", () => balances),
    // Every gun the account owns, in any state (docs/CONTRACT_V2.md): the impounded ones too.
    weapons: () => view("weapons", () => [...weapons, ...impound.map((i) => i.weapon)]),
    weapon: (serial) => view("weapon", () => mine(serial) ?? null),
    vendors: () =>
      view("vendors", () =>
        (["moss", "ines"] as VendorId[]).map((id): Vendor => {
          const v = vendorState[id];
          return {
            id,
            accountId: `${id}.saltline.testnet`,
            name: VENDORS[id].name,
            open: v.scrip >= 100,
            scrip: v.scrip,
            stock: v.stock,
            bids: VENDORS[id].buys.map((m) => {
              const stock = v.stock[m] ?? 0;
              return { tokenId: m, price: bidOf(id, m), reason: BID_WHY[m][stock > MATERIALS[m].target ? 1 : 0] };
            }),
            goods: v.goods,
            guns: v.guns,
            lastMemo: v.memo,
          };
        }),
      ),
    exportPrices: () =>
      view("exportPrices", () =>
        (Object.keys(MATERIALS) as MaterialId[]).map((id): Quote => {
          const n = exported[id] ?? 0;
          return { tokenId: id, price: exportOf(id), reason: n ? `${n} already loaded today` : "None loaded today" };
        }),
      ),
    listings: () => view("listings", () => listings),
    wrecks: () => view("wrecks", () => []),
    impound: () => view("impound", () => impound),
    harbormaster: () => view("harbormaster", () => hm),
    raid: () => view("raid", () => null),
    recent: (limit) => view("recent", () => recent.slice(0, limit)),
    economy: () => view("economy", () => economy),
    leaderboard: () => view("leaderboard", () => ({ netWorth: [], extractions: [], makers: [] })),

    startRaid: () => call("startRaid", () => no("E_NO_RAID", "The dock's stand-in has no yard")),
    extract: () => call("extract", () => no("E_NO_RAID", "No raid")),
    die: () => call("die", () => no("E_NO_RAID", "No raid")),

    build: (bp: BlueprintId) =>
      call("build", () => {
        const b = BLUEPRINTS[bp];
        if (!b) return no("E_BAD_AMOUNT", "No such blueprint");
        for (const [m, n] of Object.entries(b.inputs) as [MaterialId, number][]) if (have(m) < n) return no("E_FUNDS", `Not enough ${TOKEN_NAMES[m].toLowerCase()}`);
        if (have("scrip") < b.fee) return no("E_FUNDS", "Not enough scrip");
        for (const [m, n] of Object.entries(b.inputs) as [MaterialId, number][]) add(m, -n);
        add("scrip", -b.fee);
        economy.burned24h += b.fee;
        economy.scripSupply -= b.fee;
        if (b.kind === "weapon") {
          const want = controls.nextGrade ?? (["C", "B", "C", "D", "B", "A"] as Grade[])[Math.floor(rand() * 6)];
          controls.nextGrade = null;
          const w = gun(bp as FrameId, want, { maker: ME, makerCallsign: profile!.callsign, builtAt: now() });
          weapons.unshift(w);
          profile!.built++;
          economy.weaponsBuilt++;
          economy.weaponsAlive++;
          log("build", `${profile!.callsign} built ${w.grade === "A" ? "an" : "a"} ${w.grade}-grade ${FRAMES[w.frame].name.split(" ")[1]}, ${w.serial}.`);
          return { weapon: w, minted: {} as Amounts };
        }
        add(bp as ModId | ConsumableId, b.yields);
        log("build", `${profile!.callsign} built ${b.yields} ${TOKEN_NAMES[bp as TokenId].toLowerCase()}.`);
        return { minted: { [bp]: b.yields } as Amounts };
      }),
    fit: (serial, mod) =>
      call("fit", () => {
        const w = mine(serial);
        if (!w) return no("E_NO_WEAPON", "No such gun");
        if (w.state !== "held") return no("E_WEAPON_BUSY", "That gun isn't in your stash");
        if (have(mod) < 1) return no("E_FUNDS", "You don't hold that mod");
        if (w.mods.some((m) => MODS[m].slot === MODS[mod].slot)) return no("E_SLOT_TAKEN", "That slot is taken");
        add(mod, -1);
        w.mods.push(mod);
        log("fit", `${profile!.callsign} fitted ${MODS[mod].name.toLowerCase()} to ${w.serial}.`);
        return { weapon: w };
      }),
    repair: (serial, points) =>
      call("repair", () => {
        const w = mine(serial);
        if (!w) return no("E_NO_WEAPON", "No such gun");
        if (w.state !== "held") return no("E_WEAPON_BUSY", "That gun isn't in your stash");
        const pts = Math.min(100 - w.condition, points ?? 100);
        const cost = pts * CONDITION.scripPerPoint;
        const copper = Math.ceil(pts / CONDITION.pointsPerCopper);
        if (have("scrip") < cost || have("copper") < copper) return no("E_FUNDS", "Not enough scrip or copper");
        add("scrip", -cost);
        add("copper", -copper);
        vendorState.moss.scrip += cost;
        w.condition += pts;
        revalue(w);
        log("repair", `Moss repaired ${w.serial} for ${cost}.`);
        return { weapon: w, cost };
      }),
    scrap: (serial) =>
      call("scrap", () => {
        const i = weapons.findIndex((w) => w.serial === serial);
        if (i < 0) return no("E_NO_WEAPON", "No such gun");
        if (weapons[i].state !== "held") return no("E_WEAPON_BUSY", "That gun isn't in your stash");
        weapons.splice(i, 1);
        for (const [m, n] of Object.entries(CONDITION.scrap) as [MaterialId, number][]) add(m, n);
        economy.weaponsAlive--;
        economy.weaponsDestroyed++;
        log("scrap", `${profile!.callsign} scrapped ${serial} for parts.`);
        return { minted: { ...CONDITION.scrap } as Amounts };
      }),
    sell: (vendor, tokenId, amount) =>
      call("sell", () => {
        const v = vendorState[vendor];
        if (!(VENDORS[vendor].buys as MaterialId[]).includes(tokenId)) return no("E_DOESNT_BUY", `${VENDORS[vendor].name} doesn't buy that`);
        if (amount < 1 || have(tokenId) < amount) return no("E_FUNDS", "You don't hold that many");
        let paid = 0;
        let stock = v.stock[tokenId] ?? 0;
        for (let i = 0; i < amount; i++) paid += bidOf(vendor, tokenId, stock++);
        if (v.scrip - paid < 100) return no("E_VENDOR_BROKE", `${VENDORS[vendor].name} can't cover that`);
        v.stock[tokenId] = stock;
        v.scrip -= paid;
        add(tokenId, -amount);
        add("scrip", paid);
        log("sale", `${profile!.callsign} sold ${amount} ${TOKEN_NAMES[tokenId].toLowerCase()} to ${VENDORS[vendor].name} for ${paid}.`);
        return { paid };
      }),
    buy: (vendor, tokenId, amount) =>
      call("buy", () => {
        const g = vendorState[vendor].goods.find((x) => x.tokenId === tokenId);
        if (!g) return no("E_DOESNT_SELL", `${VENDORS[vendor].name} doesn't sell that`);
        if (g.stock < amount) return no("E_NO_STOCK", "Sold out");
        const cost = g.price * amount;
        if (have("scrip") < cost) return no("E_FUNDS", "Not enough scrip");
        g.stock -= amount;
        add("scrip", -cost);
        add(tokenId, amount);
        vendorState[vendor].scrip += cost;
        log("purchase", `${profile!.callsign} bought ${amount} ${TOKEN_NAMES[tokenId].toLowerCase()} from ${VENDORS[vendor].name} for ${cost}.`);
        return { cost };
      }),
    buyGun: (vendor, serial) =>
      call("buyGun", () => {
        const v = vendorState[vendor];
        const i = v.guns.findIndex((g) => g.weapon.serial === serial);
        if (i < 0) return no("E_NO_STOCK", "That gun is gone");
        const { weapon, price } = v.guns[i];
        if (have("scrip") < price) return no("E_FUNDS", "Not enough scrip");
        v.guns.splice(i, 1);
        add("scrip", -price);
        v.scrip += price;
        Object.assign(weapon, { owner: ME, state: "held", owners: weapon.owners + 1 });
        weapons.unshift(weapon);
        log("purchase", `${profile!.callsign} bought ${weapon.serial} from ${VENDORS[vendor].name} for ${price}.`);
        return { weapon, cost: price };
      }),
    exportGoods: (tokenId, amount) =>
      call("exportGoods", () => {
        if (amount < 1 || have(tokenId) < amount) return no("E_FUNDS", "You don't hold that many");
        let paid = 0;
        let n = exported[tokenId] ?? 0;
        for (let i = 0; i < amount; i++) paid += exportOf(tokenId, n++);
        exported[tokenId] = n;
        add(tokenId, -amount);
        add("scrip", paid);
        economy.minted24h += paid;
        economy.scripSupply += paid;
        log("export", `${profile!.callsign} exported ${amount} ${TOKEN_NAMES[tokenId].toLowerCase()} for ${paid}.`);
        return { paid };
      }),
    listWeapon: (serial, price) =>
      call("listWeapon", () => {
        const w = mine(serial);
        if (!w) return no("E_NO_WEAPON", "No such gun");
        if (w.state !== "held") return no("E_WEAPON_BUSY", "That gun isn't in your stash");
        if (!Number.isInteger(price) || price < 1) return no("E_BAD_AMOUNT", "Set a price");
        w.state = "listed";
        const id = ++listingNo;
        listings.unshift({ id, seller: ME, callsign: profile!.callsign, price, at: now(), weapon: w });
        log("listing", `${profile!.callsign} listed ${w.serial} for ${price}.`);
        return { id };
      }),
    listItem: (tokenId, amount, price) =>
      call("listItem", () => {
        if (amount < 1 || have(tokenId) < amount) return no("E_FUNDS", "You don't hold that many");
        add(tokenId, -amount);
        const id = ++listingNo;
        listings.unshift({ id, seller: ME, callsign: profile!.callsign, price, at: now(), item: { tokenId, amount } });
        return { id };
      }),
    buyListing: (id) =>
      call("buyListing", () => {
        const i = listings.findIndex((l) => l.id === id);
        if (i < 0) return no("E_NO_LISTING", "That listing is gone");
        const l = listings[i];
        if (have("scrip") < l.price) return no("E_FUNDS", "Not enough scrip");
        listings.splice(i, 1);
        add("scrip", -l.price);
        const burned = Math.floor((l.price * (MARKET.feePct - MARKET.makerPct)) / 100);
        economy.burned24h += burned;
        economy.scripSupply -= burned;
        if (l.weapon) {
          const w = l.weapon;
          Object.assign(w, { owner: ME, state: "held", owners: w.owners + 1 });
          weapons.unshift(w);
          const s = economy.lastSales.find((x) => x.frame === w.frame && x.grade === w.grade);
          if (s) s.prices = [l.price, ...s.prices].slice(0, 5);
          else economy.lastSales.push({ frame: w.frame, grade: w.grade, prices: [l.price] });
          log("market_sale", `${profile!.callsign} bought ${w.serial} from ${l.callsign} for ${l.price}.`);
          return { paid: l.price, weapon: w };
        }
        if (l.item) add(l.item.tokenId, l.item.amount);
        return { paid: l.price };
      }),
    cancelListing: (id) =>
      call("cancelListing", () => {
        const i = listings.findIndex((l) => l.id === id && l.seller === ME);
        if (i < 0) return no("E_NO_LISTING", "That listing is gone");
        const [l] = listings.splice(i, 1);
        if (l.weapon) {
          const w = mine(l.weapon.serial);
          if (w) w.state = "held";
        }
        if (l.item) add(l.item.tokenId, l.item.amount);
        return {};
      }),
    settle: (amount) =>
      call("settle", () => {
        if (!profile!.arrears) return no("E_NOTHING_OWED", "Nothing is owed");
        if (!Number.isInteger(amount) || amount < 1) return no("E_BAD_AMOUNT", "Pay at least 1 scrip");
        const pay = Math.min(amount, Math.ceil(profile!.arrears / INVOICE.settleRate));
        if (have("scrip") < pay) return no("E_FUNDS", "Not enough scrip");
        const cleared = Math.min(profile!.arrears, pay * INVOICE.settleRate);
        add("scrip", -pay);
        profile!.arrears -= cleared;
        hm.balance += pay;
        restrength();
        log("settle", `${profile!.callsign} paid the Harbormaster ${pay}. It thanks them.`);
        return { cleared, arrears: profile!.arrears };
      }),
    buyBack: (serial) =>
      call("buyBack", () => {
        const i = impound.findIndex((x) => x.weapon.serial === serial);
        if (i < 0) return no("E_NOT_IMPOUNDED", "That gun isn't in the impound");
        const { weapon, fee } = impound[i];
        if (have("scrip") < fee) return no("E_FUNDS", "Not enough scrip");
        impound.splice(i, 1);
        add("scrip", -fee);
        hm.balance += fee;
        restrength();
        weapon.state = "held";
        weapons.unshift(weapon);
        log("buy_back", `${profile!.callsign} bought ${weapon.serial} back from the impound for ${fee}.`);
        return { weapon, cost: fee };
      }),
  };

  const wallet: Wallet2 = {
    kind: "mock",
    accountId: () => ME,
    registered: async () => {
      await new Promise<void>((r) => setTimeout(r, Math.min(latency, 120)));
      if (controls.failViews.has("registered")) throw new Error("registered: no answer");
      return !!profile;
    },
    claim: async (callsign) => {
      await wait();
      if (profile) return { ok: false, code: "E_ALREADY_REGISTERED", error: "You already hold a pass" };
      profile = { accountId: ME, callsign, registeredAt: now(), raids: 0, extractions: 0, deaths: 0, arrears: 0, activeRaid: null, built: 0, royalties: 0 };
      return { ok: true, txHash: `fake${++txNo}` };
    },
  };

  return { chain, wallet, loadout: { weapon: null, plates: 0, charges: 0, mags: 0 }, raid: null, fake: controls };
}
