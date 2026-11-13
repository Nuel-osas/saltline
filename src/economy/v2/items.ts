// Saltline v2's numbers (docs/GAME.md): frames and their bands, mods, blueprints, materials, the invoice's rates
// and thresholds, and the pure rules both sides share. The contract (contract2/src/items.rs) holds the same
// numbers and is the authority; test/v2-items.test.ts checks this copy against its views when a contract is set.
import type { Amounts, BlueprintId, ConsumableId, FrameId, Grade, MaterialId, ModId, Stats, TokenId, Weapon } from "./types";

// ---------------------------------------------------------------------------------------------------------------
// Materials

export interface MaterialInfo {
  id: MaterialId;
  name: string;
  /** Carry weight per unit. */
  weight: number;
  /** What a vendor pays at its target stock, and what the export desk pays before today's volume. */
  bid: number;
  export: number;
  /** The stock level at which a vendor pays `bid`. */
  target: number;
}

export const MATERIALS: Record<MaterialId, MaterialInfo> = {
  copper: { id: "copper", name: "Copper coil", weight: 1, bid: 40, export: 25, target: 20 },
  chips: { id: "chips", name: "Boxed electronics", weight: 1, bid: 55, export: 35, target: 16 },
  meds: { id: "meds", name: "Cold-chain meds", weight: 1, bid: 60, export: 40, target: 10 },
  fuel: { id: "fuel", name: "Fuel cell", weight: 2, bid: 80, export: 55, target: 8 },
  core: { id: "core", name: "Relay core", weight: 1, bid: 150, export: 100, target: 6 },
  servo: { id: "servo", name: "Hound servo", weight: 1, bid: 70, export: 45, target: 8 },
  rotor: { id: "rotor", name: "Gull rotor", weight: 1, bid: 45, export: 30, target: 8 },
};
export const MATERIAL_IDS = Object.keys(MATERIALS) as MaterialId[];

/** What a container holds: chance in 100, and how many units (min–max). */
export const CONTAINER_LOOT: { id: MaterialId; chance: number; amount: [number, number] }[] = [
  { id: "copper", chance: 28, amount: [1, 2] },
  { id: "chips", chance: 24, amount: [1, 2] },
  { id: "meds", chance: 16, amount: [1, 2] },
  { id: "fuel", chance: 14, amount: [1, 1] },
  { id: "core", chance: 8, amount: [1, 1] },
  { id: "servo", chance: 5, amount: [1, 2] },
  { id: "rotor", chance: 5, amount: [1, 2] },
];
/** A bonded container (heavy arrears only): two units of one of these. */
export const BONDED_LOOT: MaterialId[] = ["core", "servo", "core", "chips"];

export const VENDORS = {
  moss: { name: "Moss", role: "Armourer", buys: ["copper", "chips", "servo", "rotor", "core"] as MaterialId[], builds: ["longshore", "stevedore", "pilot", "mag2", "barrel2", "comp", "optic"] as BlueprintId[] },
  ines: { name: "Ines", role: "Quartermaster", buys: ["meds", "fuel", "chips", "copper"] as MaterialId[], builds: ["plate", "charge", "ammo"] as BlueprintId[] },
} as const;

/** How vendors price what they sell, unless their agent set a price. */
export const VENDOR_PRICING = {
  /** Goods: the inputs' value at base bids, per unit made, times this percent (rounded down). */
  goodsPct: 135,
  /** …plus this percent for each unit under `scarceUnder` in stock. */
  scarcePct: 8,
  scarceUnder: 5,
  /** Guns: the appraisal times this percent. */
  gunPct: 125,
  /** A vendor refuses to buy when paying would leave it under this much scrip. */
  float: 100,
  /** Ines's meds go to the clinic: her meds stock halves this often, so her bid for them recovers. */
  medsHalfLifeHours: 12,
} as const;

// ---------------------------------------------------------------------------------------------------------------
// Guns

export interface FrameInfo {
  id: FrameId;
  name: string;
  line: string;
  /** Each stat is rolled uniformly inside its band (whole numbers). */
  bands: Record<keyof Stats, [number, number]>;
  /** Scrip: the appraisal of a C-grade gun in new condition. */
  base: number;
}

export const FRAMES: Record<FrameId, FrameInfo> = {
  longshore: {
    id: "longshore",
    name: "PAC-9 Longshore",
    line: "The carbine. Does everything, forgives most things.",
    bands: { damage: [24, 30], rpm: [660, 760], mag: [28, 34], recoil: [90, 110], reload: [90, 110], range: [260, 320] },
    base: 750,
  },
  stevedore: {
    id: "stevedore",
    name: "PAC-9K Stevedore",
    line: "Short and fast. Built for the gaps between containers.",
    bands: { damage: [16, 21], rpm: [880, 1000], mag: [34, 42], recoil: [75, 95], reload: [80, 95], range: [140, 190] },
    base: 600,
  },
  pilot: {
    id: "pilot",
    name: "PAC-9M Pilot",
    line: "Slow, heavy, and it reaches the far crane.",
    bands: { damage: [44, 58], rpm: [300, 380], mag: [12, 16], recoil: [115, 140], reload: [100, 120], range: [380, 460] },
    base: 950,
  },
};
export const FRAME_IDS = Object.keys(FRAMES) as FrameId[];

/** The issue rifle: every player's, never an NFT, never lost, never sold. */
export const ISSUE: { name: string; stats: Stats } = {
  name: "PAC-9 Issue",
  stats: { damage: 21, rpm: 620, mag: 24, recoil: 120, reload: 115, range: 220 },
};

/** Lower is better for these; higher is better for the rest. */
export const LOWER_IS_BETTER: (keyof Stats)[] = ["recoil", "reload"];
export const STAT_KEYS: (keyof Stats)[] = ["damage", "rpm", "mag", "recoil", "reload", "range"];

/** 0–100: where each stat landed in its band, averaged (whole number, rounded down). */
export function quality(frame: FrameId, stats: Stats): number {
  let sum = 0;
  for (const k of STAT_KEYS) {
    const [lo, hi] = FRAMES[frame].bands[k];
    const t = hi === lo ? 100 : Math.floor(((stats[k] - lo) * 100) / (hi - lo));
    sum += LOWER_IS_BETTER.includes(k) ? 100 - t : t;
  }
  return Math.floor(sum / STAT_KEYS.length);
}

export const GRADES: { grade: Grade; min: number; value: number }[] = [
  { grade: "A", min: 80, value: 220 },
  { grade: "B", min: 62, value: 140 },
  { grade: "C", min: 38, value: 100 },
  { grade: "D", min: 0, value: 80 },
];
export const gradeOf = (q: number): Grade => GRADES.find((g) => q >= g.min)!.grade;

/** The contract's appraisal: frame base × grade (percent) × (50 + condition / 2) percent, rounded down. */
export function appraise(frame: FrameId, grade: Grade, condition: number): number {
  const g = GRADES.find((x) => x.grade === grade)!.value;
  return Math.floor((FRAMES[frame].base * g * (50 + Math.floor(condition / 2))) / 10_000);
}

export interface ModInfo {
  id: ModId;
  name: string;
  slot: "magazine" | "barrel" | "muzzle" | "optic";
  line: string;
}
export const MODS: Record<ModId, ModInfo> = {
  mag2: { id: "mag2", name: "Extended magazine", slot: "magazine", line: "+10 rounds a magazine" },
  barrel2: { id: "barrel2", name: "Long barrel", slot: "barrel", line: "+12% damage, +15% range, −6% fire rate" },
  comp: { id: "comp", name: "Compensator", slot: "muzzle", line: "−25% recoil" },
  optic: { id: "optic", name: "Optic", slot: "optic", line: "Tighter aim, +5% range" },
};
export const MOD_IDS = Object.keys(MODS) as ModId[];

export const CONDITION = {
  /** Lost on each raid the gun survives, and when it is carried out of a wreck. */
  perRaid: 5,
  recovered: 15,
  /** Under this the gun handles badly: −15% damage, +20% recoil. */
  worn: 30,
  /** Repair: scrip per point, and one copper per this many points (rounded up). */
  scripPerPoint: 2,
  pointsPerCopper: 20,
  /** What scrapping a gun gives back. */
  scrap: { copper: 2, chips: 1 } as Amounts<MaterialId>,
} as const;

/** The numbers the shooter uses: the rolled stats with mods and wear applied. */
export function effective(w: Pick<Weapon, "stats" | "mods" | "condition">): Stats & { zoom: boolean } {
  const s = { ...w.stats };
  if (w.mods.includes("mag2")) s.mag += 10;
  if (w.mods.includes("barrel2")) {
    s.damage = Math.round(s.damage * 1.12);
    s.range = Math.round(s.range * 1.15);
    s.rpm = Math.round(s.rpm * 0.94);
  }
  if (w.mods.includes("comp")) s.recoil = Math.round(s.recoil * 0.75);
  if (w.mods.includes("optic")) s.range = Math.round(s.range * 1.05);
  if (w.condition < CONDITION.worn) {
    s.damage = Math.round(s.damage * 0.85);
    s.recoil = Math.round(s.recoil * 1.2);
  }
  return { ...s, zoom: w.mods.includes("optic") };
}

// ---------------------------------------------------------------------------------------------------------------
// Blueprints

export const BLUEPRINTS: Record<BlueprintId, { kind: "weapon" | "mod" | "consumable"; inputs: Amounts<MaterialId>; fee: number; yields: number }> = {
  longshore: { kind: "weapon", inputs: { copper: 6, chips: 4, servo: 2 }, fee: 120, yields: 1 },
  stevedore: { kind: "weapon", inputs: { copper: 4, chips: 3, rotor: 3 }, fee: 90, yields: 1 },
  pilot: { kind: "weapon", inputs: { copper: 5, chips: 5, servo: 2, core: 1 }, fee: 180, yields: 1 },
  mag2: { kind: "mod", inputs: { copper: 2, chips: 1 }, fee: 30, yields: 1 },
  barrel2: { kind: "mod", inputs: { copper: 3, servo: 1 }, fee: 40, yields: 1 },
  comp: { kind: "mod", inputs: { copper: 2, rotor: 1 }, fee: 30, yields: 1 },
  optic: { kind: "mod", inputs: { chips: 3, rotor: 1 }, fee: 50, yields: 1 },
  plate: { kind: "consumable", inputs: { copper: 1, fuel: 1 }, fee: 20, yields: 3 },
  charge: { kind: "consumable", inputs: { chips: 1, fuel: 1 }, fee: 15, yields: 6 },
  ammo: { kind: "consumable", inputs: { copper: 1 }, fee: 10, yields: 4 },
};
export const BLUEPRINT_IDS = Object.keys(BLUEPRINTS) as BlueprintId[];

/** A vendor's default price for one unit of a mod or consumable: plate 54, charge 30, magazine 13. */
export function goodsPrice(id: ModId | ConsumableId, stock = VENDOR_PRICING.scarceUnder): number {
  const b = BLUEPRINTS[id];
  const inputs = MATERIAL_IDS.reduce((sum, m) => sum + (b.inputs[m] ?? 0) * MATERIALS[m].bid, 0);
  const base = Math.floor((inputs * VENDOR_PRICING.goodsPct) / (100 * b.yields));
  const short = Math.max(0, VENDOR_PRICING.scarceUnder - stock);
  return Math.floor((base * (100 + VENDOR_PRICING.scarcePct * short)) / 100);
}

export const CONSUMABLES: Record<ConsumableId, { name: string; line: string }> = {
  plate: { name: "Armour plate", line: "+40 health for one raid" },
  charge: { name: "Breaker charge", line: "Drops drones and staggers the Bailiff" },
  ammo: { name: "Magazine", line: "One more magazine in the raid" },
};

export const TOKEN_NAMES: Record<TokenId, string> = {
  scrip: "Scrip",
  ...(Object.fromEntries(MATERIAL_IDS.map((m) => [m, MATERIALS[m].name])) as Record<MaterialId, string>),
  ...(Object.fromEntries(MOD_IDS.map((m) => [m, MODS[m].name])) as Record<ModId, string>),
  plate: CONSUMABLES.plate.name,
  charge: CONSUMABLES.charge.name,
  ammo: CONSUMABLES.ammo.name,
};

// ---------------------------------------------------------------------------------------------------------------
// Raids and the invoice

export const RAID = {
  spotCount: 16,
  containers: 8,
  /** Extra bonded containers when arrears are at or over INVOICE.bondedAt. */
  bonded: 2,
  wrecks: 3,
  carryLimit: 6,
  /** A recovered gun's carry weight. */
  gunWeight: 2,
  slowPerWeight: 0.06,
  minSeconds: 45,
  perContainerSeconds: 8,
  secondsBetweenRaids: 30,
  /** Magazines every raid issues, before the ones brought. */
  issuedMags: 3,
  maxMags: 8,
  maxCharges: 3,
  maxPlates: 1,
  plateHealth: 40,
  /** Caps on what a report may claim. */
  maxKills: { gull: 30, hound: 15 },
  maxUplinks: 3,
  secondsPerKill: 4,
  wreckHours: 24,
  impoundHours: 48,
  /** Percent of a gun's appraisal the Harbormaster wants for it. */
  buyBackPct: 40,
  starterScrip: 150,
} as const;

export const INVOICE = {
  entry: 150,
  perExtraction: 25,
  /** Past extractions counted toward the entry charge, so it tops out at 500. */
  maxExtractionsCounted: 14,
  perMinute: 60,
  seal: 80,
  perWeight: 40,
  uplink: 200,
  gull: 40,
  hound: 120,
  /** Thresholds before the Harbormaster's posture moves them. */
  secondNotice: 600,
  bailiff: 1200,
  secondBailiff: 2400,
  foreclosure: 4000,
  /** Percent of the final invoice that becomes arrears. */
  arrearsOnExtract: 25,
  arrearsOnDeath: 10,
  /** Percent of arrears already on the meter at the fence, and its cap. */
  carryInPct: 50,
  carryInMax: 1500,
  /** Arrears cleared per scrip paid. */
  settleRate: 2,
  bondedAt: 1000,
} as const;

/** What is on the invoice at the fence. */
export const invoiceStart = (extractions: number, arrears: number) =>
  INVOICE.entry + INVOICE.perExtraction * Math.min(extractions, INVOICE.maxExtractionsCounted) + Math.min(INVOICE.carryInMax, Math.floor((arrears * INVOICE.carryInPct) / 100));

/** The invoice from a raid's facts. The contract computes the same from the report and block time. */
export function invoiceTotal(f: { start: number; seconds: number; seals: number; weight: number; uplinks: number; gulls: number; hounds: number }): number {
  return (
    f.start +
    Math.floor((f.seconds * INVOICE.perMinute) / 60) +
    f.seals * INVOICE.seal +
    f.weight * INVOICE.perWeight +
    f.uplinks * INVOICE.uplink +
    f.gulls * INVOICE.gull +
    f.hounds * INVOICE.hound
  );
}

/** The Harbormaster: strength from its balance, and what each posture does with it. */
export const HARBORMASTER = {
  /** Scrip per point of strength (strength caps at 100). */
  scripPerStrength: 20,
  halfLifeHours: 12,
  /** patrols: one extra drone per this much strength (up to 4). */
  strengthPerDrone: 25,
  /** pursuit: the Bailiff's threshold drops by this much per point of strength (1,200 → 800 at full strength). */
  bailiffDropPerStrength: 4,
} as const;

export const MARKET = { feePct: 4, makerPct: 2, maxListings: 200 } as const;

export const weightOf = (carried: Amounts<MaterialId>, guns = 0) =>
  MATERIAL_IDS.reduce((w, id) => w + (carried[id] ?? 0) * MATERIALS[id].weight, 0) + guns * RAID.gunWeight;

export const speedScale = (weight: number) => Math.max(0.5, 1 - RAID.slowPerWeight * weight);
