// The raid's rules with no three.js or DOM (docs/GAME.md → The loop, Risk, The invoice; docs/CONTRACT_V2.md →
// Ending a raid): what the gun in the loadout does to the shooter, what a manifest may hold, what is carried, the
// live invoice and its thresholds, what killed the player, and the report the contract is sent. Pure, so the rules
// the contract enforces are tested here too.
import { SALVAGE_SPOTS } from "../../salvage/spots";
import { FRAMES, HARBORMASTER, INVOICE, ISSUE, MATERIALS, MATERIAL_IDS, RAID, TOKEN_NAMES, effective, invoiceTotal, speedScale, weightOf } from "../items";
import type { Amounts, DeathBy, HarbormasterView, Loadout, MaterialId, Raid, RaidReport, TokenId, Weapon, Wreck } from "../types";

// ---------------------------------------------------------------------------------------------------------------
// The gun drives the shooter

/** G.ext.weapon: what game.js's weapon reads at a run's reset (its `// ext:` hooks). */
export interface ShooterSpec {
  name: string;
  /** Per round. */
  damage: number;
  rpm: number;
  /** Rounds a magazine. */
  mag: number;
  /** Rounds in reserve at the fence: the three magazines every raid issues plus the ones brought. */
  reserve: number;
  /** Scales on the baseline's reload time and kick: 1 is the baseline. */
  reload: number;
  recoil: number;
  /** Metres. */
  range: number;
}

const whole = (n: unknown, lo: number, hi: number) => (typeof n === "number" && Number.isFinite(n) ? Math.max(lo, Math.min(hi, Math.floor(n))) : lo);

/** The view model's furniture per frame (game.js's `pac9_polymer_tan`, the Longshore's tan): the issue rifle is plain black. */
export const FINISH: Record<string, number> = { longshore: 0x5a4f3f, stevedore: 0x2b3a42, pilot: 0x3b4630, issue: 0x151515 };

/** The gun's name as the HUD shows it: its frame and grade, or the issue rifle's. */
export const gunName = (w: Pick<Weapon, "frame" | "grade"> | null) => (w ? `${FRAMES[w.frame].name} · ${w.grade}` : ISSUE.name);
/** A gun in a sentence or on a board: `Longshore S-000041`. */
export const gunTag = (w: Pick<Weapon, "frame" | "serial">) => `${FRAMES[w.frame].name.replace(/^PAC-\S+\s+/, "")} ${w.serial}`;

/** The shooter's numbers for a gun (rolled stats, mods, its level and wear) or, with none, the issue rifle. */
export function shooterSpec(weapon: (Pick<Weapon, "frame" | "grade" | "stats" | "mods" | "condition"> & { extractions?: number }) | null, mags: number): ShooterSpec {
  const s = weapon ? effective(weapon) : ISSUE.stats;
  return {
    name: gunName(weapon),
    damage: s.damage,
    rpm: s.rpm,
    mag: s.mag,
    reserve: (RAID.issuedMags + whole(mags, 0, RAID.maxMags)) * s.mag,
    reload: s.reload / 100,
    recoil: s.recoil / 100,
    range: s.range,
  };
}

/** A loadout as the contract will take it: every count inside its range. */
export const cleanLoadout = (l: Partial<Loadout> | null | undefined): Loadout => ({
  weapon: typeof l?.weapon === "string" && l.weapon ? l.weapon : null,
  plates: whole(l?.plates, 0, RAID.maxPlates),
  charges: whole(l?.charges, 0, RAID.maxCharges),
  mags: whole(l?.mags, 0, RAID.maxMags),
});

/**
 * The gun a loadout takes in. A loadout naming a gun the player no longer holds (sold, lost, impounded, listed, worn
 * to nothing, or not theirs) falls back to the issue rifle: `weapon: null`, with `fellBack` saying so.
 */
export function resolveGun(loadout: Loadout, weapon: Weapon | null | undefined, accountId: string | null): { loadout: Loadout; weapon: Weapon | null; fellBack: boolean } {
  const l = cleanLoadout(loadout);
  if (!l.weapon) return { loadout: l, weapon: null, fellBack: false };
  const ok = !!weapon && weapon.serial === l.weapon && weapon.state === "held" && weapon.condition > 0 && !!accountId && weapon.owner === accountId && isWeapon(weapon);
  return ok ? { loadout: l, weapon: weapon!, fellBack: false } : { loadout: { ...l, weapon: null }, weapon: null, fellBack: true };
}

// ---------------------------------------------------------------------------------------------------------------
// The manifest, checked before any of it is shown

const isInt = (n: unknown, lo = 0, hi = 1e9): n is number => typeof n === "number" && Number.isInteger(n) && n >= lo && n <= hi;
const isSpot = (n: unknown): n is number => isInt(n, 0, SALVAGE_SPOTS.length - 1);
const isMaterial = (id: unknown): id is MaterialId => typeof id === "string" && (MATERIAL_IDS as string[]).includes(id);

export function isWeapon(w: unknown): w is Weapon {
  if (!w || typeof w !== "object") return false;
  const x = w as Weapon;
  if (typeof x.serial !== "string" || !x.serial || !(x.frame in FRAMES) || !["A", "B", "C", "D"].includes(x.grade)) return false;
  if (!x.stats || !Array.isArray(x.mods) || !isInt(x.condition, 0, 100)) return false;
  return (["damage", "rpm", "mag", "recoil", "reload", "range"] as const).every((k) => isInt(x.stats[k], 1, 5000));
}

/**
 * A raid from the chain. Fails closed: one malformed or duplicated entry and the whole raid is refused, so the game
 * never offers cargo the contract won't mint or bills against thresholds it can't read.
 */
export function checkRaid(r: unknown): Raid | null {
  if (!r || typeof r !== "object") return null;
  const x = r as Raid;
  if (!isInt(x.raidId) || !isInt(x.invoiceStart, 0, 1e7)) return null;
  if (!Array.isArray(x.containers) || !Array.isArray(x.wrecks)) return null;
  if (x.containers.length > RAID.containers + RAID.bonded || x.wrecks.length > RAID.wrecks) return null;
  const spots = new Set<number>();
  for (const c of x.containers) {
    if (!c || !isSpot(c.spot) || !isMaterial(c.tokenId) || !isInt(c.amount, 1, 99) || typeof c.bonded !== "boolean" || spots.has(c.spot)) return null;
    spots.add(c.spot);
  }
  const ids = new Set<number>();
  for (const w of x.wrecks) {
    if (!w || !isInt(w.id) || ids.has(w.id) || !isSpot(w.spot) || typeof w.callsign !== "string" || !Array.isArray(w.items)) return null;
    if (w.weapon !== null && !isWeapon(w.weapon)) return null;
    for (const it of w.items) if (!it || !(it.tokenId in TOKEN_NAMES) || !isInt(it.amount, 1, 1e6)) return null;
    ids.add(w.id);
  }
  const h = x.harbormaster;
  if (!h || typeof h !== "object") return null;
  if (!isInt(h.secondNoticeAt, 1) || !isInt(h.bailiffAt, 1) || !isInt(h.secondBailiffAt, 1) || !isInt(h.foreclosureAt, 1)) return null;
  if (!isInt(h.strength, 0, 100) || !isInt(h.bonusDrones, 0, MAX_BONUS_DRONES)) return null;
  if (!x.loadout || typeof x.loadout !== "object") return null;
  return x;
}

// ---------------------------------------------------------------------------------------------------------------
// The invoice's thresholds

export type ThresholdId = "second_notice" | "bailiff" | "second_bailiff" | "foreclosure";

/** How the meter names what is ahead: `INVOICE 1,040 · BAILIFF AT 1,200`. */
export const THRESHOLD_LABEL: Record<ThresholdId, string> = {
  second_notice: "SECOND NOTICE",
  bailiff: "BAILIFF",
  second_bailiff: "SECOND BAILIFF",
  foreclosure: "FORECLOSURE",
};

export interface Threshold {
  id: ThresholdId;
  at: number;
}

/** The thresholds in force for this raid: the Harbormaster's own (its posture moves the Bailiff's), in order. */
export function thresholdsOf(h: Pick<HarbormasterView, "secondNoticeAt" | "bailiffAt" | "secondBailiffAt" | "foreclosureAt">): Threshold[] {
  return [
    { id: "second_notice", at: h.secondNoticeAt },
    { id: "bailiff", at: h.bailiffAt },
    { id: "second_bailiff", at: h.secondBailiffAt },
    { id: "foreclosure", at: h.foreclosureAt },
  ];
}

/** Each threshold fires once, in the order above, however far a single addition jumps. */
export class Thresholds {
  private fired = new Set<ThresholdId>();
  constructor(readonly list: readonly Threshold[]) {}
  /** The thresholds `total` has newly reached. */
  cross(total: number): Threshold[] {
    const out: Threshold[] = [];
    for (const t of this.list) {
      if (this.fired.has(t.id) || !(total >= t.at)) continue;
      this.fired.add(t.id);
      out.push(t);
    }
    return out;
  }
  /** The nearest threshold not yet fired, or null past the last. */
  next(): { at: number; what: string } | null {
    let best: Threshold | null = null;
    for (const t of this.list) if (!this.fired.has(t.id) && (!best || t.at < best.at)) best = t;
    return best ? { at: best.at, what: THRESHOLD_LABEL[best.id] } : null;
  }
  has(id: ThresholdId): boolean {
    return this.fired.has(id);
  }
}

/** The Assessor's cores at foreclosure: `3 + floor(strength / 20)` (boss/rules.ts clamps it to 3–8 as well). */
export const foreclosureCores = (strength: number) => 3 + Math.floor(whole(strength, 0, 100) / 20);

// ---------------------------------------------------------------------------------------------------------------
// Parts off destroyed machines

export type MachineType = "gull" | "hound";
export const PART_OF: Record<MachineType, { part: "servo" | "rotor"; chance: number }> = {
  hound: { part: "servo", chance: 0.6 },
  gull: { part: "rotor", chance: 0.4 },
};

/** A number in [0, 1) from a raid's id and a counter: the same raid drops the same parts (mulberry32). */
export function roll(seed: number, n: number): number {
  let a = (Math.imul(seed | 0, 0x9e3779b1) ^ Math.imul((n | 0) + 1, 0x85ebca6b)) >>> 0;
  a = (a + 0x6d2b79f5) >>> 0;
  let t = a;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** Whether machine number `n` destroyed in raid `raidId` drops its part: a hound's servo 60%, a gull's rotor 40%. */
export const dropsPart = (raidId: number, n: number, type: MachineType) => roll(raidId, n) < PART_OF[type].chance;

// ---------------------------------------------------------------------------------------------------------------
// What killed the player

/** A grab this close to the death (ms) is what killed them: the clamp's damage and the death land in one frame. */
export const GRAB_WINDOW_MS = 250;

/** `bailiff` when a Bailiff's grab landed at the moment of death, else `machines`. */
export function deathBy(diedAt: number, grabs: readonly number[]): DeathBy {
  return grabs.some((t) => Math.abs(diedAt - t) <= GRAB_WINDOW_MS) ? "bailiff" : "machines";
}

/** The salvage spot nearest (x, z): where a wreck is logged. */
export function nearestSpot(x: number, z: number): number {
  let best = 0,
    bd = Infinity;
  for (const s of SALVAGE_SPOTS) {
    const d = Math.hypot(s.x - x, s.z - z);
    if (d < bd) ((bd = d), (best = s.id));
  }
  return best;
}

/** Where a spot is, in the yard's words: `by the shed`. */
export const zoneOf = (spot: number) => {
  const z = SALVAGE_SPOTS[spot]?.zone;
  return z === "shed" ? "by the shed" : z === "quay" ? "on the quay" : z === "gate" ? "by the gate" : "in the yard";
};

// ---------------------------------------------------------------------------------------------------------------
// The raid's bookkeeping

/** Uplinks a report may claim (items.ts). */
export const MAX_UPLINKS: number = RAID.maxUplinks;
/** The most extra Inspection Units the Harbormaster's strength buys (items.ts: one per 25 strength, strength 0–100). */
const MAX_BONUS_DRONES = Math.floor(100 / HARBORMASTER.strengthPerDrone);

export type Items = { tokenId: TokenId; amount: number }[];

/** Short stencil names, for tags, prompts and markers. */
export const SHORT: Record<MaterialId, string> = { copper: "COPPER", chips: "CHIPS", meds: "MEDS", fuel: "FUEL", core: "CORE", servo: "SERVO", rotor: "ROTOR" };
const shortOf = (id: TokenId) => (SHORT as Record<string, string>)[id] ?? TOKEN_NAMES[id].toUpperCase();

export const formatItems = (items: Items) => items.map((it) => `${shortOf(it.tokenId)} ×${it.amount}`).join(" · ");
export const toItems = (a: Amounts<MaterialId>): Items => MATERIAL_IDS.filter((id) => (a[id] ?? 0) > 0).map((id) => ({ tokenId: id, amount: a[id]! }));
export const money = (n: number) => Math.round(n).toLocaleString("en-US");

/** One addition to the invoice, as the HUD lists it: `+80 CUSTOMS SEAL`. */
export interface LineItem {
  added: number;
  why: string;
}

/** What a wreck weighs to carry: 2 for its gun; what else is in it rides with the gun (CONTRACT_V2.md → Ending a raid). */
export const wreckWeight = (w: Pick<Wreck, "weapon">) => (w.weapon ? RAID.gunWeight : 0);

export interface Gear {
  /** Charges left on the belt, or null when unknown. */
  chargesLeft: number | null;
  /** Rounds left (magazine and reserve), or null when unknown. */
  roundsLeft: number | null;
}

/** What of the loadout was used up. Unknown counts as used: the contract returns only what the game can vouch for. */
export function gearUsed(loadout: Loadout, magSize: number, gear: Gear): RaidReport["used"] {
  const charges = gear.chargesLeft === null ? loadout.charges : Math.max(0, Math.min(loadout.charges, loadout.charges - gear.chargesLeft));
  // The magazine in the gun and the three issued ones go first; a brought magazine is used once a round of it is.
  const free = (1 + RAID.issuedMags) * magSize;
  const all = free + loadout.mags * magSize;
  const spent = gear.roundsLeft === null ? all : Math.max(0, all - gear.roundsLeft);
  const mags = magSize > 0 ? Math.max(0, Math.min(loadout.mags, Math.ceil((spent - free) / magSize))) : loadout.mags;
  return { plates: loadout.plates, charges, mags };
}

/**
 * Kills as the contract will accept them: at most 30 gulls and 15 hounds, and one machine for every four seconds of
 * the raid. Kills over the time cap are dropped gulls first, keeping the ones that back a part where it can.
 */
export function capKills(kills: { gull: number; hound: number }, parts: { servo: number; rotor: number }, seconds: number): { gull: number; hound: number } {
  let gull = whole(kills.gull, 0, RAID.maxKills.gull);
  let hound = whole(kills.hound, 0, RAID.maxKills.hound);
  const cap = Math.max(0, Math.floor(seconds / RAID.secondsPerKill));
  while (gull + hound > cap) {
    if (gull > parts.rotor) gull--;
    else if (hound > parts.servo) hound--;
    else if (gull > 0) gull--;
    else hound--;
  }
  return { gull, hound };
}

export class RaidLedger {
  readonly opened: number[] = [];
  readonly wrecks: number[] = [];
  readonly parts = { servo: 0, rotor: 0 };
  readonly kills = { gull: 0, hound: 0 };
  uplinks = 0;
  /** Cargo and parts carried, by material. */
  readonly carried: Amounts<MaterialId> = {};
  /** Guns taken from wrecks. */
  readonly guns: Weapon[] = [];
  /** What else the recovered wrecks held: minted with them at the boat, weightless here. */
  readonly salvaged: Items = [];

  constructor(readonly raid: Raid) {}

  weight(): number {
    return weightOf(this.carried, this.guns.length);
  }
  speed(): number {
    return speedScale(this.weight());
  }
  fits(more: number): boolean {
    return this.weight() + more <= RAID.carryLimit;
  }
  sealed() {
    return this.raid.containers.filter((c) => !this.opened.includes(c.spot));
  }
  standing() {
    return this.raid.wrecks.filter((w) => !this.wrecks.includes(w.id));
  }

  /** Cuts the seal at `spot` and takes what is inside, or refuses (not on the manifest, already cut, too heavy). */
  cut(spot: number): { ok: true; items: LineItem[] } | { ok: false } {
    const c = this.raid.containers.find((e) => e.spot === spot);
    if (!c || this.opened.includes(spot)) return { ok: false };
    const w = MATERIALS[c.tokenId].weight * c.amount;
    if (!this.fits(w)) return { ok: false };
    this.opened.push(spot);
    this.carried[c.tokenId] = (this.carried[c.tokenId] ?? 0) + c.amount;
    return { ok: true, items: [{ added: INVOICE.seal, why: c.bonded ? "BONDED SEAL" : "CUSTOMS SEAL" }, cargoLine(w)] };
  }

  /** Takes a wreck: its gun (2 weight) and whatever else it held. */
  recover(id: number): { ok: true; items: LineItem[] } | { ok: false } {
    const w = this.raid.wrecks.find((e) => e.id === id);
    if (!w || this.wrecks.includes(id) || !this.fits(wreckWeight(w))) return { ok: false };
    this.wrecks.push(id);
    if (w.weapon) this.guns.push(w.weapon);
    this.salvaged.push(...w.items);
    return { ok: true, items: w.weapon ? [cargoLine(RAID.gunWeight, "RECOVERED GUN")] : [] };
  }

  /** A machine was destroyed. Past the contract's caps it is not billed (and can't back a part). */
  kill(type: MachineType): LineItem | null {
    if (this.kills[type] >= RAID.maxKills[type]) return null;
    this.kills[type]++;
    return type === "hound" ? { added: INVOICE.hound, why: "HOUND DESTROYED" } : { added: INVOICE.gull, why: "GULL DESTROYED" };
  }

  /** Picks a part up: only one a kill backs, and only if there is room. */
  takePart(part: "servo" | "rotor"): { ok: true; items: LineItem[] } | { ok: false } {
    const backed = part === "servo" ? this.kills.hound : this.kills.gull;
    const w = MATERIALS[part].weight;
    if (this.parts[part] >= backed || !this.fits(w)) return { ok: false };
    this.parts[part]++;
    this.carried[part] = (this.carried[part] ?? 0) + 1;
    return { ok: true, items: [cargoLine(w, part === "servo" ? "HOUND SERVO" : "GULL ROTOR")] };
  }

  cutUplink(): LineItem | null {
    if (this.uplinks >= MAX_UPLINKS) return null;
    this.uplinks++;
    return { added: INVOICE.uplink, why: "UPLINK CUT" };
  }

  /** The invoice `seconds` into the raid: items.ts invoiceTotal over what has been done so far. */
  invoice(seconds: number): number {
    return invoiceTotal({
      start: this.raid.invoiceStart,
      seconds: Math.max(0, Math.floor(seconds)),
      seals: this.opened.length,
      weight: this.weight(),
      uplinks: this.uplinks,
      gulls: this.kills.gull,
      hounds: this.kills.hound,
    });
  }

  /** What the contract is told when the raid ends, inside every cap it checks. */
  report(seconds: number, used: RaidReport["used"]): RaidReport {
    const kills = capKills(this.kills, this.parts, seconds);
    const l = this.raid.loadout;
    return {
      opened: [...this.opened],
      wrecks: [...this.wrecks],
      parts: { servo: Math.min(this.parts.servo, kills.hound), rotor: Math.min(this.parts.rotor, kills.gull) },
      kills,
      uplinks: Math.min(MAX_UPLINKS, this.uplinks),
      used: {
        plates: whole(used.plates, 0, whole(l.plates, 0, RAID.maxPlates)),
        charges: whole(used.charges, 0, whole(l.charges, 0, RAID.maxCharges)),
        mags: whole(used.mags, 0, whole(l.mags, 0, RAID.maxMags)),
      },
    };
  }
}

const cargoLine = (weight: number, what = "CARGO"): LineItem => ({ added: weight * INVOICE.perWeight, why: `${what} · ${weight} WT` });

// ---------------------------------------------------------------------------------------------------------------
// The contract's clock (docs/CONTRACT_V2.md → Ending a raid, and the rules the live contract settled)

/**
 * A raid lapses this many minutes after start_raid: `extract` and `die` then answer E_RAID_CLOSED, the gun is back
 * in the stash and the gear is lost. The contract's number; items.ts doesn't carry it yet.
 */
export const RAID_MINUTES = 30;

/** Seconds still to wait before the contract will take `extract`: 45 s plus 8 s for each container opened. */
export const extractWait = (opened: number, seconds: number) => Math.max(0, RAID.minSeconds + RAID.perContainerSeconds * opened - seconds);
/** Seconds still to wait before it will take `die`: 8 s for each container opened. */
export const dieWait = (opened: number, seconds: number) => Math.max(0, RAID.perContainerSeconds * opened - seconds);

/** Seconds of holding E: a customs seal, a bonded one (it takes longer), a wreck. */
export const HOLD = { seal: 1.6, bonded: 3.2, wreck: 1.6 } as const;
