//! Every number in Saltline v2, and the pure rules built on them (docs/GAME.md, docs/CONTRACT_V2.md).
//!
//! `src/economy/v2/items.ts` holds the same numbers for the game. This file is the authority: the `rules`,
//! `materials`, `frames` and `blueprints` views publish it so the client can check its copy.
//!
//! Integers only. Every division rounds down, once, at the end of its formula.

// -----------------------------------------------------------------------------------------------------------------
// Tokens (NEP-245 ids). Balances are `[u128; TOKEN_COUNT]`, indexed by these.
// -----------------------------------------------------------------------------------------------------------------

pub const SCRIP: usize = 0;
pub const COPPER: usize = 1;
pub const CHIPS: usize = 2;
pub const FUEL: usize = 3;
pub const MEDS: usize = 4;
pub const CORE: usize = 5;
pub const SERVO: usize = 6;
pub const ROTOR: usize = 7;
pub const MAG2: usize = 8;
pub const BARREL2: usize = 9;
pub const COMP: usize = 10;
pub const OPTIC: usize = 11;
pub const PLATE: usize = 12;
pub const CHARGE: usize = 13;
pub const AMMO: usize = 14;
pub const TOKEN_COUNT: usize = 15;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Kind {
    Currency,
    Material,
    Mod,
    Consumable,
}

pub struct Token {
    pub id: &'static str,
    pub name: &'static str,
    pub kind: Kind,
    /// Carry weight per unit (materials only).
    pub weight: u32,
    /// Materials: what a vendor pays at its target stock.
    pub bid: u128,
    /// Materials: what the export desk pays before recent volume.
    pub export: u128,
    /// Materials: the stock at which a vendor pays `bid`.
    pub target: u32,
}

const fn material(id: &'static str, name: &'static str, weight: u32, bid: u128, export: u128, target: u32) -> Token {
    Token { id, name, kind: Kind::Material, weight, bid, export, target }
}

const fn other(id: &'static str, name: &'static str, kind: Kind) -> Token {
    Token { id, name, kind, weight: 0, bid: 0, export: 0, target: 0 }
}

pub const TOKENS: [Token; TOKEN_COUNT] = [
    other("scrip", "Scrip", Kind::Currency),
    material("copper", "Copper coil", 1, 40, 25, 20),
    material("chips", "Boxed electronics", 1, 55, 35, 16),
    material("fuel", "Fuel cell", 2, 80, 55, 8),
    material("meds", "Cold-chain meds", 1, 60, 40, 10),
    material("core", "Relay core", 1, 150, 100, 6),
    material("servo", "Hound servo", 1, 70, 45, 8),
    material("rotor", "Gull rotor", 1, 45, 30, 8),
    other("mag2", "Extended magazine", Kind::Mod),
    other("barrel2", "Long barrel", Kind::Mod),
    other("comp", "Compensator", Kind::Mod),
    other("optic", "Optic", Kind::Mod),
    other("plate", "Armour plate", Kind::Consumable),
    other("charge", "Breaker charge", Kind::Consumable),
    other("ammo", "Magazine", Kind::Consumable),
];

/// The materials in items.ts order (the `materials` view lists them this way).
pub const MATERIALS: [usize; 7] = [COPPER, CHIPS, MEDS, FUEL, CORE, SERVO, ROTOR];
pub const MATERIAL_COUNT: usize = 7;
pub const MODS: [usize; 4] = [MAG2, BARREL2, COMP, OPTIC];

pub fn token_index(id: &str) -> Option<usize> {
    TOKENS.iter().position(|t| t.id == id)
}

pub fn is_material(t: usize) -> bool {
    TOKENS[t].kind == Kind::Material
}

pub fn is_mod(t: usize) -> bool {
    TOKENS[t].kind == Kind::Mod
}

/// A material's slot in per-material arrays (COPPER is 0).
pub fn material_slot(t: usize) -> usize {
    t - COPPER
}

/// One mod per slot, and each mod has its own slot: the bit a fitted mod sets on the gun.
pub fn mod_bit(t: usize) -> u8 {
    1 << (t - MAG2)
}

/// "3 copper", for the ledger's sentences.
pub fn count(t: usize, n: u128) -> String {
    format!("{n} {}", TOKENS[t].id)
}

/// What a container holds: (material, chance in 100, min, max).
pub const CONTAINER_LOOT: [(usize, u32, u32, u32); 7] = [
    (COPPER, 28, 1, 2),
    (CHIPS, 24, 1, 2),
    (MEDS, 16, 1, 2),
    (FUEL, 14, 1, 1),
    (CORE, 8, 1, 1),
    (SERVO, 5, 1, 2),
    (ROTOR, 5, 1, 2),
];
pub const LOOT_TOTAL: u32 = 100;
/// A bonded container (heavy arrears only): BONDED_UNITS of one of these.
pub const BONDED_LOOT: [usize; 4] = [CORE, SERVO, CORE, CHIPS];
pub const BONDED_UNITS: u32 = 2;

// -----------------------------------------------------------------------------------------------------------------
// Vendors
// -----------------------------------------------------------------------------------------------------------------

pub struct VendorInfo {
    pub id: &'static str,
    pub name: &'static str,
    pub role: &'static str,
    /// The callsign on the guns it builds.
    pub callsign: &'static str,
    pub buys: &'static [usize],
    /// Indices into BLUEPRINTS.
    pub builds: &'static [usize],
}

pub const MOSS: usize = 0;
pub const INES: usize = 1;
pub const VENDOR_COUNT: usize = 2;

pub const VENDORS: [VendorInfo; VENDOR_COUNT] = [
    VendorInfo {
        id: "moss",
        name: "Moss",
        role: "Armourer",
        callsign: "MOSS",
        buys: &[COPPER, CHIPS, SERVO, ROTOR, CORE],
        builds: &[BP_LONGSHORE, BP_STEVEDORE, BP_PILOT, BP_MAG2, BP_BARREL2, BP_COMP, BP_OPTIC],
    },
    VendorInfo {
        id: "ines",
        name: "Ines",
        role: "Quartermaster",
        callsign: "INES",
        buys: &[MEDS, FUEL, CHIPS, COPPER],
        builds: &[BP_PLATE, BP_CHARGE, BP_AMMO],
    },
];

pub fn vendor_index(id: &str) -> Option<usize> {
    VENDORS.iter().position(|v| v.id == id)
}

/// Each vendor starts with this much scrip, and its materials at this percent of target.
pub const VENDOR_SEED_SCRIP: u128 = 1_500;
pub const VENDOR_SEED_STOCK_PCT: u128 = 75;
/// Ines's opening shelf.
pub const INES_SEED: [(usize, u128); 3] = [(PLATE, 10), (CHARGE, 10), (AMMO, 40)];
/// Moss's opening rack: one of each of these frames, rolled at init.
pub const MOSS_SEED_FRAMES: [usize; 2] = [LONGSHORE, STEVEDORE];
/// A vendor refuses a sale that would take its scrip under this.
pub const VENDOR_FLOAT: u128 = 100;
/// items.ts VENDOR_PRICING. Default prices: goods at 135% of their inputs' value at base bids per unit made, guns
/// at 125% of appraisal.
pub const GOODS_PCT: u128 = 135;
pub const GUN_PCT: u128 = 125;
/// Goods cost more when the vendor holds few: +8% for each unit under this many.
pub const SCARCE_UNDER: u128 = 5;
pub const SCARCE_PCT: u128 = 8;
/// Ines's meds go to the clinic: her meds stock halves this often, so her bid for them recovers.
pub const MEDS_HALF_LIFE_HOURS: u64 = 12;
/// Fixed point for the two decaying balances (the Harbormaster's scrip, Ines's meds): millionths of a unit.
pub const MICRO: u128 = 1_000_000;

// -----------------------------------------------------------------------------------------------------------------
// Guns
// -----------------------------------------------------------------------------------------------------------------

pub const STAT_COUNT: usize = 6;
pub const STAT_KEYS: [&str; STAT_COUNT] = ["damage", "rpm", "mag", "recoil", "reload", "range"];
/// Lower is better for recoil and reload; higher is better for the rest.
pub const LOWER_IS_BETTER: [bool; STAT_COUNT] = [false, false, false, true, true, false];

pub struct Frame {
    pub id: &'static str,
    pub name: &'static str,
    /// "Longshore", for the ledger's sentences.
    pub short: &'static str,
    /// (lo, hi) for each stat in STAT_KEYS order. A stat is rolled uniformly inside its band.
    pub bands: [(u16, u16); STAT_COUNT],
    /// Scrip: the appraisal of a C-grade gun in new condition.
    pub base: u128,
}

pub const LONGSHORE: usize = 0;
pub const STEVEDORE: usize = 1;
pub const PILOT: usize = 2;
pub const FRAME_COUNT: usize = 3;

pub const FRAMES: [Frame; FRAME_COUNT] = [
    Frame {
        id: "longshore",
        name: "PAC-9 Longshore",
        short: "Longshore",
        bands: [(24, 30), (660, 760), (28, 34), (90, 110), (90, 110), (260, 320)],
        base: 750,
    },
    Frame {
        id: "stevedore",
        name: "PAC-9K Stevedore",
        short: "Stevedore",
        bands: [(16, 21), (880, 1000), (34, 42), (75, 95), (80, 95), (140, 190)],
        base: 600,
    },
    Frame {
        id: "pilot",
        name: "PAC-9M Pilot",
        short: "Pilot",
        bands: [(44, 58), (300, 380), (12, 16), (115, 140), (100, 120), (380, 460)],
        base: 950,
    },
];

/// (grade, the lowest quality that earns it, its value in percent of the frame's base), best first.
pub const GRADES: [(&str, u32, u128); 4] = [("A", 80, 220), ("B", 62, 140), ("C", 38, 100), ("D", 0, 80)];
pub const GRADE_COUNT: usize = 4;

/// 0–100: where each stat landed in its band, averaged (rounded down). items.ts `quality`.
pub fn quality(frame: usize, stats: &[u16; STAT_COUNT]) -> u32 {
    let mut sum: u32 = 0;
    for k in 0..STAT_COUNT {
        let (lo, hi) = FRAMES[frame].bands[k];
        let t = if hi == lo { 100 } else { (stats[k].saturating_sub(lo) as u32 * 100) / (hi - lo) as u32 };
        let t = t.min(100);
        sum += if LOWER_IS_BETTER[k] { 100 - t } else { t };
    }
    sum / STAT_COUNT as u32
}

/// The index into GRADES for a quality. items.ts `gradeOf`.
pub fn grade_of(q: u32) -> usize {
    GRADES.iter().position(|g| q >= g.1).unwrap_or(GRADE_COUNT - 1)
}

/// frame base × grade (percent) × (50 + condition / 2) percent, rounded down. items.ts `appraise`.
pub fn appraise(frame: usize, grade: usize, condition: u32) -> u128 {
    FRAMES[frame].base * GRADES[grade].2 * (50 + (condition / 2) as u128) / 10_000
}

/// Six stats, each uniform in its band.
pub fn roll_stats(rng: &mut Rng, frame: usize) -> [u16; STAT_COUNT] {
    let mut s = [0u16; STAT_COUNT];
    for k in 0..STAT_COUNT {
        let (lo, hi) = FRAMES[frame].bands[k];
        s[k] = lo + rng.below((hi - lo) as u64 + 1) as u16;
    }
    s
}

pub const CONDITION_NEW: u8 = 100;
/// Lost on each raid the gun survives, and when it is carried out of a wreck.
pub const CONDITION_PER_RAID: u8 = 5;
pub const CONDITION_RECOVERED: u8 = 15;
/// Under this the gun handles badly (the game applies it).
pub const CONDITION_WORN: u32 = 30;
/// Repair: scrip per point (paid to Moss), and one copper per this many points, rounded up (burned).
pub const REPAIR_SCRIP_PER_POINT: u128 = 2;
pub const REPAIR_POINTS_PER_COPPER: u32 = 20;
/// What scrapping a gun gives back.
pub const SCRAP: [(usize, u128); 2] = [(COPPER, 2), (CHIPS, 1)];

// -----------------------------------------------------------------------------------------------------------------
// Blueprints
// -----------------------------------------------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Makes {
    Gun(usize),
    Token(usize),
}

pub struct Blueprint {
    pub id: &'static str,
    pub kind: &'static str,
    pub inputs: &'static [(usize, u128)],
    /// Scrip, burned.
    pub fee: u128,
    pub yields: u32,
    pub makes: Makes,
}

pub const BP_LONGSHORE: usize = 0;
pub const BP_STEVEDORE: usize = 1;
pub const BP_PILOT: usize = 2;
pub const BP_MAG2: usize = 3;
pub const BP_BARREL2: usize = 4;
pub const BP_COMP: usize = 5;
pub const BP_OPTIC: usize = 6;
pub const BP_PLATE: usize = 7;
pub const BP_CHARGE: usize = 8;
pub const BP_AMMO: usize = 9;

const fn bp(
    id: &'static str,
    kind: &'static str,
    inputs: &'static [(usize, u128)],
    fee: u128,
    yields: u32,
    makes: Makes,
) -> Blueprint {
    Blueprint { id, kind, inputs, fee, yields, makes }
}

pub const BLUEPRINTS: [Blueprint; 10] = [
    bp("longshore", "weapon", &[(COPPER, 6), (CHIPS, 4), (SERVO, 2)], 120, 1, Makes::Gun(LONGSHORE)),
    bp("stevedore", "weapon", &[(COPPER, 4), (CHIPS, 3), (ROTOR, 3)], 90, 1, Makes::Gun(STEVEDORE)),
    bp("pilot", "weapon", &[(COPPER, 5), (CHIPS, 5), (SERVO, 2), (CORE, 1)], 180, 1, Makes::Gun(PILOT)),
    bp("mag2", "mod", &[(COPPER, 2), (CHIPS, 1)], 30, 1, Makes::Token(MAG2)),
    bp("barrel2", "mod", &[(COPPER, 3), (SERVO, 1)], 40, 1, Makes::Token(BARREL2)),
    bp("comp", "mod", &[(COPPER, 2), (ROTOR, 1)], 30, 1, Makes::Token(COMP)),
    bp("optic", "mod", &[(CHIPS, 3), (ROTOR, 1)], 50, 1, Makes::Token(OPTIC)),
    bp("plate", "consumable", &[(COPPER, 1), (FUEL, 1)], 20, 3, Makes::Token(PLATE)),
    bp("charge", "consumable", &[(CHIPS, 1), (FUEL, 1)], 15, 6, Makes::Token(CHARGE)),
    bp("ammo", "consumable", &[(COPPER, 1)], 10, 4, Makes::Token(AMMO)),
];

pub fn blueprint_index(id: &str) -> Option<usize> {
    BLUEPRINTS.iter().position(|b| b.id == id)
}

/// The blueprint that makes a mod or consumable.
pub fn blueprint_for(t: usize) -> Option<usize> {
    BLUEPRINTS.iter().position(|b| b.makes == Makes::Token(t))
}

/// A blueprint's inputs valued at the vendors' base bids.
pub fn inputs_value(b: usize) -> u128 {
    BLUEPRINTS[b].inputs.iter().map(|&(t, n)| TOKENS[t].bid * n).sum()
}

// -----------------------------------------------------------------------------------------------------------------
// Raids and the invoice
// -----------------------------------------------------------------------------------------------------------------

pub const SPOT_COUNT: u32 = 16;
pub const CONTAINERS: u32 = 8;
pub const BONDED: u32 = 2;
pub const WRECKS_PER_RAID: u32 = 3;
pub const CARRY_LIMIT: u32 = 6;
pub const GUN_WEIGHT: u32 = 2;
/// The game slows the player by this percent per unit of weight (the contract only publishes it).
pub const SLOW_PER_WEIGHT_PCT: u32 = 6;
pub const MIN_SECONDS: u64 = 45;
pub const PER_CONTAINER_SECONDS: u64 = 8;
pub const SECONDS_BETWEEN_RAIDS: u64 = 30;
/// Not in items.ts: a raid left open this long has timed out. Its gun goes home and its other gear is lost.
pub const RAID_EXPIRY_SECONDS: u64 = 30 * 60;
pub const ISSUED_MAGS: u32 = 3;
pub const MAX_MAGS: u32 = 8;
pub const MAX_CHARGES: u32 = 3;
pub const MAX_PLATES: u32 = 1;
pub const PLATE_HEALTH: u32 = 40;
pub const MAX_KILLS_GULL: u32 = 30;
pub const MAX_KILLS_HOUND: u32 = 15;
pub const SECONDS_PER_KILL: u64 = 4;
pub const MAX_UPLINKS: u32 = 3;
pub const WRECK_HOURS: u64 = 24;
pub const IMPOUND_HOURS: u64 = 48;
pub const BUY_BACK_PCT: u128 = 40;
pub const STARTER_SCRIP: u128 = 150;
pub const HOUR_MS: u64 = 60 * 60 * 1_000;

pub const INVOICE_ENTRY: u128 = 150;
pub const INVOICE_PER_EXTRACTION: u128 = 25;
/// Past extractions counted toward the entry charge, so it tops out at 500.
pub const MAX_EXTRACTIONS_COUNTED: u32 = 14;
pub const INVOICE_PER_MINUTE: u128 = 60;
pub const INVOICE_SEAL: u128 = 80;
pub const INVOICE_PER_WEIGHT: u128 = 40;
pub const INVOICE_UPLINK: u128 = 200;
pub const INVOICE_GULL: u128 = 40;
pub const INVOICE_HOUND: u128 = 120;
pub const SECOND_NOTICE_AT: u128 = 600;
pub const BAILIFF_AT: u128 = 1_200;
pub const SECOND_BAILIFF_AT: u128 = 2_400;
pub const FORECLOSURE_AT: u128 = 4_000;
pub const ARREARS_ON_EXTRACT_PCT: u128 = 25;
pub const ARREARS_ON_DEATH_PCT: u128 = 10;
pub const CARRY_IN_PCT: u128 = 50;
pub const CARRY_IN_MAX: u128 = 1_500;
pub const SETTLE_RATE: u128 = 2;
pub const BONDED_AT: u128 = 1_000;

/// What is on the invoice at the fence. items.ts `invoiceStart`.
pub fn invoice_start(extractions: u32, arrears: u128) -> u128 {
    INVOICE_ENTRY
        + INVOICE_PER_EXTRACTION * extractions.min(MAX_EXTRACTIONS_COUNTED) as u128
        + CARRY_IN_MAX.min(arrears.saturating_mul(CARRY_IN_PCT) / 100)
}

pub struct InvoiceFacts {
    pub start: u128,
    pub seconds: u64,
    pub seals: u32,
    pub weight: u32,
    pub uplinks: u32,
    pub gulls: u32,
    pub hounds: u32,
}

/// The invoice from a raid's facts. items.ts `invoiceTotal`.
pub fn invoice_total(f: &InvoiceFacts) -> u128 {
    f.start
        .saturating_add((f.seconds as u128).saturating_mul(INVOICE_PER_MINUTE) / 60)
        .saturating_add(f.seals as u128 * INVOICE_SEAL)
        .saturating_add(f.weight as u128 * INVOICE_PER_WEIGHT)
        .saturating_add(f.uplinks as u128 * INVOICE_UPLINK)
        .saturating_add(f.gulls as u128 * INVOICE_GULL)
        .saturating_add(f.hounds as u128 * INVOICE_HOUND)
}

// -----------------------------------------------------------------------------------------------------------------
// The Harbormaster
// -----------------------------------------------------------------------------------------------------------------

pub const SCRIP_PER_STRENGTH: u128 = 20;
pub const STRENGTH_MAX: u32 = 100;
pub const HM_HALF_LIFE_HOURS: u64 = 12;
pub const STRENGTH_PER_DRONE: u32 = 25;
pub const BAILIFF_DROP_PER_STRENGTH: u128 = 4;
pub const PATROLS: u8 = 0;
pub const PURSUIT: u8 = 1;
pub const POSTURES: [&str; 2] = ["patrols", "pursuit"];

/// 0–100: `min(100, balance ÷ 20)`.
pub fn strength(balance: u128) -> u32 {
    (balance / SCRIP_PER_STRENGTH).min(STRENGTH_MAX as u128) as u32
}

// -----------------------------------------------------------------------------------------------------------------
// The market, the export desk and the limits
// -----------------------------------------------------------------------------------------------------------------

/// 4% of every sale: 2% to the gun's maker (burned for items) and 2% burned.
pub const MARKET_FEE_PCT: u128 = 4;
pub const MAKER_PCT: u128 = 2;
pub const SALES_KEPT: usize = 5;

/// The export desk's price falls 4% of a unit's worth for every unit of that material exported recently, and
/// "recently" halves every 12 hours.
pub const EXPORT_DROP_PER_UNIT: u128 = 4;
pub const EXPORT_HALF_LIFE_HOURS: u64 = 12;
/// Fixed point for recent exports: 1 unit = 1,000.
pub const MILLI: u128 = 1_000;

pub const MAX_PROFILES: u32 = 2_000;
pub const MAX_GUNS: u32 = 5_000;
pub const MAX_LISTINGS: u32 = 200;
pub const MAX_WRECKS: usize = 40;
/// Not in CONTRACT_V2.md: one account's locker holds at most this many guns, so every per-owner view is bounded.
pub const MAX_GUNS_PER_OWNER: usize = 50;
/// The most units one `sell`, `buy` or `export` moves (each unit is priced on its own).
pub const MAX_BATCH: u128 = 50;
pub const MAX_PRICE: u128 = 1_000_000_000;
pub const MAX_MEMO: usize = 140;
pub const RECENT_KEPT: u32 = 64;
/// Lazy expiry burns at most this many wrecks, and this many impounded guns, in one call.
pub const SWEEP_PER_CALL: usize = 3;

// -----------------------------------------------------------------------------------------------------------------
// Prices
// -----------------------------------------------------------------------------------------------------------------

/// What a vendor pays for one unit of a material: `bid × 2 × target ÷ (target + stock)`, never under 1.
/// Double the bid at an empty shelf, the bid at target, half of it at three times the target.
pub fn bid(t: usize, stock: u128) -> u128 {
    let target = TOKENS[t].target as u128;
    (TOKENS[t].bid.saturating_mul(2).saturating_mul(target) / target.saturating_add(stock).max(1)).max(1)
}

/// What a vendor pays for `n` units together: one unit at a time, its stock rising by one between units.
pub fn sale_value(t: usize, stock: u128, n: u128) -> u128 {
    (0..n).fold(0u128, |sum, i| sum.saturating_add(bid(t, stock.saturating_add(i))))
}

/// A vendor's default price for one unit of something it built, holding `stock` of it. items.ts `goodsPrice`:
///
/// ```text
/// base  = inputs' value at base bids × 135% ÷ yields, rounded down    (plate 54, charge 30, magazine 13)
/// price = base × (100 + 8 × units short of 5)%, rounded down
/// ```
pub fn good_price(blueprint: usize, stock: u128) -> u128 {
    let b = &BLUEPRINTS[blueprint];
    let base = inputs_value(blueprint) * GOODS_PCT / (100 * b.yields as u128);
    let short = SCARCE_UNDER.saturating_sub(stock);
    (base * (100 + SCARCE_PCT * short) / 100).max(1)
}

/// What `n` units cost bought together: one unit at a time, the shelf falling by one between units.
pub fn goods_cost(blueprint: usize, stock: u128, n: u128) -> u128 {
    (0..n).fold(0u128, |sum, i| sum.saturating_add(good_price(blueprint, stock.saturating_sub(i))))
}

/// A vendor's default price for a gun: its appraisal × 125%.
pub fn gun_price(value: u128) -> u128 {
    (value * GUN_PCT / 100).max(1)
}

/// What the export desk pays for one unit: `export × 100 ÷ (100 + 4 × units exported recently)`, never under 1.
/// `recent_milli` is in thousandths of a unit.
pub fn export_price(t: usize, recent_milli: u128) -> u128 {
    let top = TOKENS[t].export.saturating_mul(100 * MILLI);
    (top / (100 * MILLI).saturating_add(EXPORT_DROP_PER_UNIT.saturating_mul(recent_milli))).max(1)
}

/// What `n` units export for together: one unit at a time, each adding one to the recent volume.
pub fn export_value(t: usize, recent_milli: u128, n: u128) -> u128 {
    (0..n).fold(0u128, |sum, i| sum.saturating_add(export_price(t, recent_milli.saturating_add(i * MILLI))))
}

/// `value × 2^(−elapsed / half_life)`, integer-only (contract/src/pricing.rs `halve`, unchanged).
/// Whole half-lives are a right shift; the rest uses a 16-step table of 2^(−k/16) in parts per million,
/// interpolated in a straight line between steps (within 0.1% of the true curve).
pub fn halve(value: u128, elapsed_ms: u64, half_life_ms: u64) -> u128 {
    const HALVING_PPM: [u128; 17] = [
        1_000_000, 957_603, 917_004, 878_126, 840_896, 805_245, 771_105, 738_413, 707_107, 677_128, 648_420, 620_929,
        594_604, 569_394, 545_254, 522_137, 500_000,
    ];
    let half_life_ms = half_life_ms.max(1);
    let halvings = elapsed_ms / half_life_ms;
    if halvings >= 64 || value == 0 {
        return 0;
    }
    let whole = value >> halvings;
    let rest = (elapsed_ms % half_life_ms) as u128;
    let span = half_life_ms as u128;
    let step = (rest * 16 / span) as usize;
    let into_step = rest * 16 % span;
    let (a, b) = (HALVING_PPM[step], HALVING_PPM[step + 1]);
    let ppm = a - (a - b) * into_step / span;
    whole.saturating_mul(ppm) / 1_000_000
}

// -----------------------------------------------------------------------------------------------------------------
// Randomness
// -----------------------------------------------------------------------------------------------------------------

/// SplitMix64 (contract/src/runs.rs, unchanged), seeded from `env::random_seed()` mixed with a serial or raid id.
pub struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Self {
        Rng(seed)
    }

    pub fn from_bytes(b: &[u8]) -> Self {
        let mut x = [0u8; 8];
        x.copy_from_slice(&b[..8]);
        Rng(u64::from_le_bytes(x))
    }

    pub fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    /// Uniform in 0..n (n > 0); the modulo bias is under 2⁻⁵⁸ for the small n used here.
    pub fn below(&mut self, n: u64) -> u64 {
        self.next_u64() % n
    }
}

/// `S-000041`.
pub fn serial_text(n: u32) -> String {
    format!("S-{n:06}")
}

/// The number in `S-000041`, or None for anything else.
pub fn parse_serial(s: &str) -> Option<u32> {
    let digits = s.strip_prefix("S-")?;
    if !(6..=9).contains(&digits.len()) || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    digits.parse().ok().filter(|&n| n > 0)
}
