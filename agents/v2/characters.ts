// Saltline v2's three characters (docs/GAME.md → Characters with wallets): who they are, as small rules.
//
// Each has its own NEAR account and can only do what the contract allows that account (docs/CONTRACT_V2.md):
// - Moss, the armourer: `vendor_build` (guns and mods from her own parts), `vendor_price` (her own guns), `export`.
// - Ines, the quartermaster: `vendor_build` (plates, charges, magazines), `export`.
// - The Harbormaster: `hm_posture`. Nothing else. It can't mint, bill or take anything: its strength is its balance.
//
// One move a round each. A move that doesn't add up against the board becomes a hold, never a guess. Every move
// carries a memo of at most 90 characters in that character's voice (docs/STORY.md).
//
// Pure functions of what the contract's views showed, with no I/O, so the tests can pin every rule.
import { BLUEPRINTS, FRAME_IDS, MATERIALS, MATERIAL_IDS, MODS, MOD_IDS, VENDORS, VENDOR_PRICING } from "../../src/economy/v2/items.js";
import type {
  BlueprintId,
  ConsumableId,
  EconomyView,
  FrameId,
  HarbormasterView,
  LedgerEvent,
  MaterialId,
  ModId,
  Posture,
  Quote,
  Vendor,
  VendorId,
  Weapon,
} from "../../src/economy/v2/types";
import { MEMO_MAX, hash } from "../characters.js";

export { MEMO_MAX };
export type CharacterId = VendorId | "harbormaster";
export const CHARACTER_IDS: readonly CharacterId[] = ["moss", "ines", "harbormaster"];

const HOUR_MS = 3_600_000;

/** Moss's numbers. */
export const MOSS = {
  /** She builds a gun while fewer than this many are for sale. */
  rack: 4,
  /** She makes mods once this many guns are racked, and keeps this many of each. */
  modsAfterGuns: 3,
  modShelf: 2,
  /** A gun unsold this long is dead weight: one cut of `cutPct` for each such stretch it has sat. */
  staleHours: 6,
  cutPct: 10,
  /** Never under this percent of the contract's appraisal. */
  floorPct: 90,
  /** What a fresh A or B asks, as a percent of its appraisal (the default is VENDOR_PRICING.gunPct, 125). */
  premiumPct: { A: 150, B: 135 } as Partial<Record<Weapon["grade"], number>>,
  /** She ships what she holds over this many times a material's target, at most `lot` units a round. */
  exportOver: 2,
  lot: 6,
} as const;

/** Ines's numbers. */
export const INES = {
  /** She restocks a shelf under these. */
  shelf: { plate: 6, charge: 8, ammo: 24 } as Record<ConsumableId, number>,
  /** Under this much scrip she ships fuel or electronics held over twice their target. */
  thinScrip: 600,
  exports: ["fuel", "chips"] as MaterialId[],
  exportOver: 2,
  lot: 6,
} as const;

/**
 * Neither vendor ships into a flooded desk: an export only adds up while the desk pays at least this percent of the
 * material's book export price (`export_prices` against items.ts). Not in the brief's rules: the 48-hour run had
 * Moss shipping relay cores at 6 scrip against a book price of 100. Set it to 0 for the rule as first written.
 */
export const EXPORT_MIN_PCT = 50;

/** The Harbormaster's numbers. */
export const HM = {
  /** Raid endings it looks back over. */
  window: 20,
  /** To pursuit when extractions are more than this many times the deaths… */
  ratio: 2,
  /** …and its strength is at least this. */
  minStrength: 25,
  /** Back to patrols only when extractions fall under this many tenths of the deaths (1.2 times)… */
  backRatioTenths: 12,
  /** …or its strength drops under this. */
  backStrength: 15,
  /** It never changes within this long of its last change. */
  dwellHours: 3,
} as const;

/** The one thing a character does this round. */
export type Move2 =
  | { action: "hold" }
  | { action: "build"; blueprint: BlueprintId }
  | { action: "price"; serial: string; price: number }
  | { action: "export"; tokenId: MaterialId; amount: number }
  | { action: "posture"; posture: Posture };

/** Why it made the move. It picks the memo. */
export type Why2 =
  | "fresh-grade" // Moss: a fresh A or B, priced above the default
  | "rack-lacks" // Moss: a frame the rack doesn't have
  | "selling" // Moss: the frame the market has been buying
  | "staple" // Moss: every frame racked and no sales to go on, so a Longshore
  | "markdown" // Moss: unsold too long
  | "mod" // Moss: three guns racked and short of a mod
  | "surplus" // Moss: over twice target, shipped
  | "restock" // Ines: a shelf under its line
  | "thin" // Ines: the clinic's till is thin, surplus shipped
  | "pursuit" // The Harbormaster: Breachers are getting away and it has the strength
  | "patrols" // The Harbormaster: they no longer are
  | "unfunded" // The Harbormaster: it can no longer afford pursuit
  | "steady"; // nothing to do

export interface Decision2 {
  move: Move2;
  why: Why2;
  /** The numbers and names the memo is filled from. */
  say: Record<string, string | number>;
  /** Set when a move was thrown out by `checkMove2`, or something the rules needed wasn't on the board. */
  note?: string;
  invalid?: true;
}

/** What each character's rules read. The runner leaves a character out when any of its reads failed. */
export interface VendorBoard {
  vendor: Vendor;
  /** `export_prices`: what the desk pays for the next unit. */
  quotes: Quote[];
  /** Moss only: the market's last sales. Left out when they couldn't be read; empty when there are none. */
  economy?: Pick<EconomyView, "lastSales">;
  now: number;
}
export interface HarbormasterBoard {
  harbormaster: HarbormasterView;
  /** `recent`, newest first: everything the ledger still shows. */
  recent: LedgerEvent[];
  now: number;
  /** A change this runner signed itself, and when, if it remembers one. */
  remembered?: { posture: Posture; at: number } | null;
}

const hold = (say: Decision2["say"] = {}, note?: string): Decision2 => ({ move: { action: "hold" }, why: "steady", say, ...(note ? { note } : {}) });
const held = (v: Vendor, m: MaterialId) => v.stock[m] ?? 0;
const hasParts = (v: Vendor, id: BlueprintId) => MATERIAL_IDS.every((m) => held(v, m) >= (BLUEPRINTS[id].inputs[m] ?? 0));
/** What the shelf holds of a mod or consumable, or null when the contract's board doesn't show that shelf. */
const shelf = (v: Vendor, id: ModId | ConsumableId): number | null => v.goods.find((g) => g.tokenId === id)?.stock ?? null;
const quoteOf = (quotes: Quote[], m: MaterialId) => quotes.find((q) => q.tokenId === m)?.price ?? null;

const FRAME_SHORT: Record<FrameId, string> = { longshore: "Longshore", stevedore: "Stevedore", pilot: "Pilot" };
const NOUNS: Record<MaterialId | ModId | ConsumableId, [one: string, many: string]> = {
  copper: ["coil", "coils"],
  chips: ["box of electronics", "boxes of electronics"],
  fuel: ["fuel cell", "fuel cells"],
  meds: ["crate of meds", "crates of meds"],
  core: ["relay core", "relay cores"],
  servo: ["servo", "servos"],
  rotor: ["rotor", "rotors"],
  mag2: ["extended magazine", "extended magazines"],
  barrel2: ["long barrel", "long barrels"],
  comp: ["compensator", "compensators"],
  optic: ["optic", "optics"],
  plate: ["plate", "plates"],
  charge: ["charge", "charges"],
  ammo: ["magazine", "magazines"],
};
export const count2 = (t: keyof typeof NOUNS, n: number) => `${n} ${NOUNS[t][n === 1 ? 0 : 1]}`;

// ---------------------------------------------------------------------------------------------------------------
// Moss: blunt, measures everything in tonnes, hates waste

/** The contract's default price for a vendor's gun. */
export const defaultGunPrice = (w: Weapon) => Math.floor((w.value * VENDOR_PRICING.gunPct) / 100);
/** The least Moss will ask for a gun: 90% of its appraisal, rounded up. */
export const floorPrice = (w: Weapon) => Math.ceil((w.value * MOSS.floorPct) / 100);
/** What she asks for it new: the premium for an A or B, the default otherwise. */
export const openingPrice = (w: Weapon) => (MOSS.premiumPct[w.grade] ? Math.floor((w.value * (MOSS.premiumPct[w.grade] as number)) / 100) : defaultGunPrice(w));
/** The most a gun may still ask after this long unsold: one cut per six hours on the rack, never under the floor. */
export function ceilingPrice(w: Weapon, now: number): number {
  const cuts = Math.min(24, Math.max(0, Math.floor((now - w.builtAt) / (MOSS.staleHours * HOUR_MS))));
  let p = openingPrice(w);
  for (let i = 0; i < cuts; i++) p = Math.floor((p * (100 - MOSS.cutPct)) / 100);
  return Math.max(floorPrice(w), p);
}

/** How many market sales of this frame the contract still remembers (it keeps the last five per frame and grade). */
const sold = (e: Pick<EconomyView, "lastSales">, f: FrameId) => e.lastSales.filter((s) => s.frame === f).reduce((n, s) => n + s.prices.length, 0);

/** True while the desk pays at least EXPORT_MIN_PCT of the book price for it. An unknown price is never worth it. */
export const worthShipping = (quotes: Quote[], m: MaterialId) => {
  const pays = quoteOf(quotes, m);
  return pays !== null && pays > 0 && pays * 100 >= MATERIALS[m].export * EXPORT_MIN_PCT;
};

/** What a vendor holds furthest over `times` its target, among `of`, and how much to ship: the excess, capped. */
function surplus(v: Vendor, quotes: Quote[], of: readonly MaterialId[], times: number, lot: number): { tokenId: MaterialId; amount: number } | null {
  const over = of
    .map((m) => ({ tokenId: m, amount: held(v, m) - times * MATERIALS[m].target }))
    .filter((x) => x.amount > 0 && worthShipping(quotes, x.tokenId))
    .sort((a, b) => b.amount * MATERIALS[a.tokenId].target - a.amount * MATERIALS[b.tokenId].target)[0];
  return over ? { tokenId: over.tokenId, amount: Math.min(lot, over.amount) } : null;
}

export function moss(b: VendorBoard): Decision2 {
  const v = b.vendor;
  const stale = MOSS.staleHours * HOUR_MS;
  const age = (w: Weapon) => b.now - w.builtAt;

  // A fresh A or B still at the default price: it asks what its grade is worth.
  const fresh = v.guns.find((g) => MOSS.premiumPct[g.weapon.grade] && age(g.weapon) <= stale && g.price === defaultGunPrice(g.weapon));
  if (fresh) {
    const w = fresh.weapon;
    return { move: { action: "price", serial: w.serial, price: openingPrice(w) }, why: "fresh-grade", say: { serial: w.serial, grade: w.grade, frame: FRAME_SHORT[w.frame], price: openingPrice(w) } };
  }

  // Fewer than four for sale and the parts for one: the frame the rack lacks, else the one the market is buying,
  // else (no sales to go on) a Longshore. Sales that couldn't be read are not "no sales": then she builds neither.
  if (v.guns.length < MOSS.rack) {
    const can = FRAME_IDS.filter((f) => hasParts(v, f));
    const lacking = can.find((f) => !v.guns.some((g) => g.weapon.frame === f));
    if (lacking) return { move: { action: "build", blueprint: lacking }, why: "rack-lacks", say: { frame: FRAME_SHORT[lacking] } };
    const e = b.economy;
    if (e) {
      const selling = [...can].sort((x, y) => sold(e, y) - sold(e, x))[0];
      if (selling && sold(e, selling) > 0) return { move: { action: "build", blueprint: selling }, why: "selling", say: { frame: FRAME_SHORT[selling], sales: sold(e, selling) } };
      if (can.includes("longshore")) return { move: { action: "build", blueprint: "longshore" }, why: "staple", say: { frame: FRAME_SHORT.longshore } };
    }
  }

  // Over six hours unsold and asking more than that long on the rack allows: 10% off, never under the floor.
  const tired = v.guns.filter((g) => age(g.weapon) > stale && g.price > ceilingPrice(g.weapon, b.now)).sort((x, y) => x.weapon.builtAt - y.weapon.builtAt)[0];
  if (tired) {
    const w = tired.weapon;
    const price = Math.max(floorPrice(w), Math.floor((tired.price * (100 - MOSS.cutPct)) / 100));
    return { move: { action: "price", serial: w.serial, price }, why: "markdown", say: { serial: w.serial, hours: Math.floor(age(w) / HOUR_MS), price, was: tired.price } };
  }

  // Three guns racked: keep two of each mod.
  if (v.guns.length >= MOSS.modsAfterGuns) {
    const mod = MOD_IDS.filter((m) => shelf(v, m) !== null && (shelf(v, m) as number) < MOSS.modShelf && hasParts(v, m)).sort((x, y) => (shelf(v, x) as number) - (shelf(v, y) as number))[0];
    if (mod) return { move: { action: "build", blueprint: mod }, why: "mod", say: { mod: MODS[mod].name.toLowerCase(), have: count2(mod, shelf(v, mod) as number) } };
  }

  // Anything held over twice its target is waste: to the freighter, to keep cash.
  const ship = surplus(v, b.quotes, MATERIAL_IDS, MOSS.exportOver, MOSS.lot);
  if (ship) return { move: { action: "export", ...ship }, why: "surplus", say: { count: count2(ship.tokenId, ship.amount), things: NOUNS[ship.tokenId][1], each: quoteOf(b.quotes, ship.tokenId) ?? "?" } };

  return hold({ guns: v.guns.length, scrip: v.scrip });
}

// ---------------------------------------------------------------------------------------------------------------
// Ines: warm, a ruthless haggler, spends the clinic's money carefully

export function ines(b: VendorBoard): Decision2 {
  const v = b.vendor;
  const goods = Object.keys(INES.shelf) as ConsumableId[];
  const unseen = goods.filter((g) => shelf(v, g) === null);
  // The shortest shelf first: the one furthest under its own line.
  const short = goods
    .filter((g) => shelf(v, g) !== null && (shelf(v, g) as number) < INES.shelf[g] && hasParts(v, g))
    .sort((x, y) => (shelf(v, x) as number) * INES.shelf[y] - (shelf(v, y) as number) * INES.shelf[x])[0];
  if (short) {
    return { move: { action: "build", blueprint: short }, why: "restock", say: { have: count2(short, shelf(v, short) as number), made: BLUEPRINTS[short].yields } };
  }
  if (v.scrip < INES.thinScrip) {
    const ship = surplus(v, b.quotes, INES.exports, INES.exportOver, INES.lot);
    if (ship) return { move: { action: "export", ...ship }, why: "thin", say: { count: count2(ship.tokenId, ship.amount), scrip: v.scrip, each: quoteOf(b.quotes, ship.tokenId) ?? "?" } };
  }
  return hold({ scrip: v.scrip }, unseen.length ? `the board doesn't show her ${unseen.join(", ")} shelf` : undefined);
}

// ---------------------------------------------------------------------------------------------------------------
// The Harbormaster: polite, procedural, sincere. It bills people.

/** The last raid endings in `recent` (newest first): boats reached against wrecks left and guns impounded. */
export function raidEndings(recent: LedgerEvent[]): { extractions: number; deaths: number } {
  const ends = recent.filter((e) => e.kind === "extract" || e.kind === "wreck" || e.kind === "impound").slice(0, HM.window);
  const extractions = ends.filter((e) => e.kind === "extract").length;
  return { extractions, deaths: ends.length - extractions };
}

/**
 * When the posture last changed, as far as can be known: a time it changed at or before, "never", or null (unknown).
 * The ledger's newest `posture` line says. Without one, it is known only if the Harbormaster has never signed a
 * posture (it has no memo), or every line the ledger still shows is older than the dwell (so the change is older
 * still), or this runner signed the standing posture itself and remembers when.
 */
export function lastChange(b: HarbormasterBoard): number | "never" | null {
  const lines = b.recent.filter((e) => e.kind === "posture");
  if (lines.length) return Math.max(...lines.map((e) => e.at));
  if (b.harbormaster.lastMemo === null) return "never";
  const oldest = b.recent.length ? Math.min(...b.recent.map((e) => e.at)) : null;
  if (oldest !== null && b.now - oldest >= HM.dwellHours * HOUR_MS) return oldest;
  if (b.remembered && b.remembered.posture === b.harbormaster.posture) return b.remembered.at;
  return null;
}

export function harbormaster(b: HarbormasterBoard): Decision2 {
  const h = b.harbormaster;
  const { extractions, deaths } = raidEndings(b.recent);
  const say = { out: extractions, lost: deaths, raids: extractions + deaths, balance: h.balance, strength: h.strength };
  // Two lines, not one, so it doesn't flip each time the count crosses a single threshold.
  const toPursuit = h.posture === "patrols" && extractions > HM.ratio * deaths && h.strength >= HM.minStrength;
  const unfunded = h.posture === "pursuit" && h.strength < HM.backStrength;
  const contained = h.posture === "pursuit" && extractions * 10 < HM.backRatioTenths * deaths;
  // It moves only when the posture changes…
  if (!toPursuit && !unfunded && !contained) return hold(say);
  const want: Posture = toPursuit ? "pursuit" : "patrols";
  const why: Why2 = toPursuit ? "pursuit" : unfunded ? "unfunded" : "patrols";
  // …and never within three hours of its last change. Not knowing when that was means no change.
  const last = lastChange(b);
  if (last === null) return hold(say, `${want} is due, but the ledger no longer shows when the posture last changed`);
  if (last !== "never" && b.now - last < HM.dwellHours * HOUR_MS) {
    return hold(say, `${want} is due, but the posture changed ${Math.max(0, Math.floor((b.now - last) / 60_000))} minutes ago and stands for ${HM.dwellHours} hours`);
  }
  return { move: { action: "posture", posture: want }, why, say };
}

// ---------------------------------------------------------------------------------------------------------------
// The check: only what the contract would accept from that account, and only what the board supports

/**
 * The move if it adds up, else why it doesn't. A build of something the vendor makes, with the parts on the board;
 * a whole price for a gun on her own rack, at or over the floor and different from what it asks now; an export of
 * a material she holds that much of, which the desk is paying for; a posture that isn't the current one.
 */
export function checkMove2(who: CharacterId, b: VendorBoard | HarbormasterBoard, move: Move2): string | null {
  const whole = (n: number) => Number.isSafeInteger(n) && n > 0;
  if (move.action === "hold") return null;
  if (move.action === "posture") {
    if (who !== "harbormaster" || !("harbormaster" in b)) return "only the Harbormaster sets a posture";
    if (move.posture !== "patrols" && move.posture !== "pursuit") return "no such posture";
    return move.posture === b.harbormaster.posture ? "that is already the posture" : null;
  }
  if (who === "harbormaster" || !("vendor" in b)) return "the Harbormaster only sets its posture";
  const v = b.vendor;
  if (move.action === "build") {
    if (!(VENDORS[who].builds as BlueprintId[]).includes(move.blueprint)) return `${v.name} doesn't make that`;
    return hasParts(v, move.blueprint) ? null : "the parts aren't on the board";
  }
  if (move.action === "price") {
    const g = v.guns.find((x) => x.weapon.serial === move.serial);
    if (who !== "moss" || !g) return "that gun isn't on her rack";
    if (!whole(move.price) || move.price < floorPrice(g.weapon)) return "that price is under 90% of the appraisal";
    return move.price === g.price ? "that is already its price" : null;
  }
  if (!Object.hasOwn(MATERIALS, move.tokenId)) return "the desk only takes materials";
  if (!whole(move.amount) || move.amount > held(v, move.tokenId)) return "more than the board shows she holds";
  if (quoteOf(b.quotes, move.tokenId) === null) return "the desk shows no price for it";
  return worthShipping(b.quotes, move.tokenId) ? null : `the desk pays under ${EXPORT_MIN_PCT}% of book for it`;
}

const RULES = { moss, ines } as const;

/** A vendor's decision for this round. A move that doesn't add up becomes a hold, never a guess. */
export function decideVendor(who: VendorId, b: VendorBoard): Decision2 {
  const d = RULES[who](b);
  const wrong = checkMove2(who, b, d.move);
  return wrong ? { ...hold(d.say, `${describeMove2(d.move)} didn't add up: ${wrong}`), invalid: true } : d;
}

export function decideHarbormaster(b: HarbormasterBoard): Decision2 {
  const d = harbormaster(b);
  const wrong = checkMove2("harbormaster", b, d.move);
  return wrong ? { ...hold(d.say, `${describeMove2(d.move)} didn't add up: ${wrong}`), invalid: true } : d;
}

/** "build pilot", "price S-000003 at 1425", "export 5 copper", "posture pursuit" or "hold". */
export function describeMove2(m: Move2): string {
  if (m.action === "build") return `build ${m.blueprint}`;
  if (m.action === "price") return `price ${m.serial} at ${m.price}`;
  if (m.action === "export") return `export ${m.amount} ${m.tokenId}`;
  if (m.action === "posture") return `posture ${m.posture}`;
  return "hold";
}

// ---------------------------------------------------------------------------------------------------------------
// Memos

type Templates = Partial<Record<Why2, string[]>>;

/** Placeholders are the keys of the decision's `say`. */
export const TEMPLATES2: Record<CharacterId, Templates> = {
  moss: {
    "fresh-grade": ["{serial} rolled {grade}. {price}, and not a gram under.", "{grade}-grade {frame}, {serial}. Worth its weight: {price}."],
    "rack-lacks": ["No {frame} on the rack. Had the parts sitting idle, so I built one.", "Rack was a {frame} short. Fixed. Idle parts are waste."],
    selling: ["{frame}s are moving on the board. Built another before the parts rust.", "The market keeps lifting {frame}s. One more on the rack."],
    staple: ["Nothing's moved on the board. Built a {frame}: it does every job.", "Rack's a gun short. A {frame}, till the market says otherwise."],
    markdown: ["{serial} has sat {hours} hours. Dead weight. {price} now.", "Nobody's lifted {serial} in {hours} hours. Down from {was} to {price}."],
    mod: ["Three guns racked and {have}. Made one from offcuts.", "Rack's stocked. Turned spare parts into one {mod}."],
    surplus: ["{count} over double what I need. To the freighter at {each}. Waste is waste.", "Shed's a tonne over on {things}. Shipping {count} at {each}."],
    steady: ["Rack's stocked, shed's tidy. Nothing to weigh.", "Holding. Not a tonne out of place."],
  },
  ines: {
    restock: ["Down to {have}, love. Made {made} more from what I had.", "{have} left on the shelf. Restocked, and not a scrip wasted."],
    thin: ["The clinic's till is at {scrip}. Sent {count} to the freighter at {each}.", "{scrip} scrip won't keep the lights on. {count} to the freighter at {each}."],
    steady: ["Shelves are full and the clinic's money is safe. Holding.", "Nothing needs doing, love. Holding at {scrip} scrip."],
  },
  harbormaster: {
    pursuit: ["Recoveries are below forecast. Collections have been prioritised.", "{out} of the last {raids} trespassers departed with cargo. Final demands will be issued early."],
    patrols: ["Losses are within tolerance. Funds are reassigned to Inspection Units.", "Collections are on schedule. Patrols resume. Thank you for your cooperation."],
    unfunded: ["Receipts stand at {balance} scrip. Pursuit is suspended pending funds.", "Pursuit is deferred: receipts of {balance} scrip do not cover it. Patrols resume."],
    steady: ["No change to posture. Your cooperation is noted.", "Posture reviewed and retained. Receipts stand at {balance} scrip."],
  },
};

/** The last resort when every template runs long: plain, short, true. */
const plainMemo2 = (d: Decision2) => `${describeMove2(d.move).replace(/^./, (c) => c.toUpperCase())}.`;

export function fill2(template: string, d: Decision2): string {
  const out = template.replace(/\{(\w+)\}/g, (_, k: string) => String(d.say[k] ?? ""));
  return out.charAt(0).toUpperCase() + out.slice(1);
}

/** The decision's memo: one line, at most MEMO_MAX characters, the same for the same seed. */
export function memoFor2(who: CharacterId, d: Decision2, seed: number): string {
  const options = TEMPLATES2[who][d.why] ?? [];
  const start = options.length ? hash(`${seed}|${who}|${d.why}`) % options.length : 0;
  for (let i = 0; i < options.length; i++) {
    const memo = fill2(options[(start + i) % options.length], d);
    if (memo.length <= MEMO_MAX) return memo;
  }
  return plainMemo2(d).slice(0, MEMO_MAX);
}

export const PERSONAS2: Record<CharacterId, string> = {
  moss: "Moss is the armourer on a rusting dock overrun by drones. Blunt. Measures everything in tonnes. Hates waste.",
  ines: "Ines is the quartermaster who runs the clinic's stores with the clinic's money. Warm, and a ruthless haggler.",
  harbormaster: "The Harbormaster is the port's AI, which bills trespassers. Unfailingly polite, procedural and sincere.",
};

/** The facts the memo must stay true to (the LLM voice gets these and may not add a number to them). */
export function factsFor2(who: CharacterId, d: Decision2): string {
  const name = who === "harbormaster" ? "The Harbormaster" : VENDORS[who].name;
  const said = Object.entries(d.say)
    .map(([k, v]) => `${k} ${v}`)
    .join(", ");
  return `${name}: ${describeMove2(d.move)}.${said ? ` ${said}.` : ""}`;
}
