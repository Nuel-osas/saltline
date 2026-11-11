//! The item table, the brokers and the run rules (docs/ECONOMY.md → Items, Brokers, Runs).
//!
//! Data only. `src/economy/items.ts` holds the same numbers for the game; this file is the authority, and the
//! `items` and `rules` views publish it so the client can check its copy.

/// Token indices. Balances are stored as `[u128; TOKEN_COUNT]`, indexed by these.
pub const SCRIP: usize = 0;
pub const COPPER: usize = 1;
pub const MEDS: usize = 2;
pub const CHIPS: usize = 3;
pub const FUEL: usize = 4;
pub const CORE: usize = 5;
pub const PLATE: usize = 6;
pub const MAG: usize = 7;
pub const CUTTER: usize = 8;
pub const TOKEN_COUNT: usize = 9;

pub const CARGO: [usize; 5] = [COPPER, MEDS, CHIPS, FUEL, CORE];
pub const GEAR: [usize; 3] = [PLATE, MAG, CUTTER];

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Kind {
    Currency,
    Cargo,
    Gear,
}

impl Kind {
    pub fn as_str(self) -> &'static str {
        match self {
            Kind::Currency => "currency",
            Kind::Cargo => "cargo",
            Kind::Gear => "gear",
        }
    }
}

pub struct Item {
    pub id: &'static str,
    pub name: &'static str,
    pub kind: Kind,
    /// Carry weight per unit (cargo only; 0 otherwise).
    pub weight: u32,
    /// Cargo: the bid at target stock. Gear: the ask with no recent sales. Scrip: 1.
    pub base: u128,
    /// Cargo only: what the freighter pays a broker per unit.
    pub export: Option<u128>,
    /// Cargo only: the stock at which a broker bids the base price.
    pub target: Option<u32>,
    /// How the dockside counts it, for the reason lines: one coil, 34 coils.
    pub one: &'static str,
    pub many: &'static str,
}

pub const ITEMS: [Item; TOKEN_COUNT] = [
    Item {
        id: "scrip",
        name: "Dock scrip",
        kind: Kind::Currency,
        weight: 0,
        base: 1,
        export: None,
        target: None,
        one: "scrip",
        many: "scrip",
    },
    Item {
        id: "copper",
        name: "Copper coil",
        kind: Kind::Cargo,
        weight: 1,
        base: 60,
        export: Some(35),
        target: Some(12),
        one: "coil",
        many: "coils",
    },
    Item {
        id: "meds",
        name: "Cold-chain meds",
        kind: Kind::Cargo,
        weight: 1,
        base: 90,
        export: Some(55),
        target: Some(8),
        one: "crate of meds",
        many: "crates of meds",
    },
    Item {
        id: "chips",
        name: "Boxed electronics",
        kind: Kind::Cargo,
        weight: 1,
        base: 75,
        export: Some(45),
        target: Some(10),
        one: "box",
        many: "boxes",
    },
    Item {
        id: "fuel",
        name: "Fuel cells",
        kind: Kind::Cargo,
        weight: 2,
        base: 110,
        export: Some(70),
        target: Some(6),
        one: "fuel cell",
        many: "fuel cells",
    },
    Item {
        id: "core",
        name: "Relay core",
        kind: Kind::Cargo,
        weight: 1,
        base: 160,
        export: Some(100),
        target: Some(4),
        one: "relay core",
        many: "relay cores",
    },
    Item {
        id: "plate",
        name: "Armour plate",
        kind: Kind::Gear,
        weight: 0,
        base: 80,
        export: None,
        target: None,
        one: "plate",
        many: "plates",
    },
    Item {
        id: "mag",
        name: "Extended mag",
        kind: Kind::Gear,
        weight: 0,
        base: 50,
        export: None,
        target: None,
        one: "mag",
        many: "mags",
    },
    Item {
        id: "cutter",
        name: "Seal cutter",
        kind: Kind::Gear,
        weight: 0,
        base: 65,
        export: None,
        target: None,
        one: "cutter",
        many: "cutters",
    },
];

pub fn token_index(id: &str) -> Option<usize> {
    ITEMS.iter().position(|i| i.id == id)
}

pub fn is_cargo(t: usize) -> bool {
    t < TOKEN_COUNT && ITEMS[t].kind == Kind::Cargo
}

pub fn is_gear(t: usize) -> bool {
    t < TOKEN_COUNT && ITEMS[t].kind == Kind::Gear
}

/// Cargo's base, export price and target as plain integers (only call for cargo).
pub fn cargo_terms(t: usize) -> (u128, u128, u128) {
    let i = &ITEMS[t];
    (i.base, i.export.unwrap_or(0), i.target.unwrap_or(1) as u128)
}

/// "1 coil", "34 coils".
pub fn count(t: usize, n: u128) -> String {
    let i = &ITEMS[t];
    format!("{n} {}", if n == 1 { i.one } else { i.many })
}

// ---------------------------------------------------------------------------------------------------------------
// Brokers
// ---------------------------------------------------------------------------------------------------------------

pub const MOSS: usize = 0;
pub const INES: usize = 1;
pub const QM: usize = 2;
pub const BROKER_COUNT: usize = 3;

pub struct BrokerInfo {
    pub id: &'static str,
    pub name: &'static str,
    pub buys: &'static [usize],
    pub sells: &'static [usize],
}

pub const BROKERS: [BrokerInfo; BROKER_COUNT] = [
    BrokerInfo { id: "moss", name: "Moss", buys: &[COPPER, CHIPS], sells: &[CUTTER] },
    BrokerInfo { id: "ines", name: "Ines", buys: &[MEDS, FUEL], sells: &[PLATE] },
    BrokerInfo { id: "qm", name: "Quartermaster", buys: &[CORE, FUEL], sells: &[MAG] },
];

pub fn broker_index(id: &str) -> Option<usize> {
    BROKERS.iter().position(|b| b.id == id)
}

pub fn buys(b: usize, t: usize) -> bool {
    BROKERS[b].buys.contains(&t)
}

pub fn sells(b: usize, t: usize) -> bool {
    BROKERS[b].sells.contains(&t)
}

/// Scrip each broker opens with (CONTRACT_API.md → Init).
pub const BROKER_SEED_SCRIP: u128 = 1_500;
/// Opening stock: 75% of target for each cargo the broker buys, rounded down (chips 7, fuel 4).
pub const BROKER_SEED_STOCK_PCT: u128 = 75;

// ---------------------------------------------------------------------------------------------------------------
// Run rules (the `rules` view publishes the first eight)
// ---------------------------------------------------------------------------------------------------------------

/// Salvage spots in the level; manifests and wrecks index them 0..SPOT_COUNT.
pub const SPOT_COUNT: u32 = 16;
/// Sealed containers in one run's manifest.
pub const CONTAINERS_PER_RUN: u32 = 8;
/// Other players' wrecks offered in one run's manifest, at most.
pub const WRECKS_PER_RUN: u32 = 3;
/// Total weight a player can carry out.
pub const CARRY_LIMIT: u32 = 6;
/// A run must last this long before extraction...
pub const MIN_RUN_SECONDS: u64 = 45;
/// ...plus this long for each sealed container opened (also the floor before a death, with no base).
pub const PER_CONTAINER_SECONDS: u64 = 8;
/// Of a recovered wreck, the finder keeps this share (rounded half up: runs::wreck_split); the rest goes back to whoever died.
pub const FINDER_SHARE_PCT: u128 = 70;
/// Minted to a new player at registration.
pub const STARTER_SCRIP: u128 = 150;

/// A player can start a run at most this often (measured start to start).
pub const RUN_GAP_SECONDS: u64 = 30;
/// A run left open this long has timed out: it can no longer extract or die, and its wreck reservations lapse.
pub const RUN_EXPIRY_SECONDS: u64 = 30 * 60;

// ---------------------------------------------------------------------------------------------------------------
// Bounds (every loop over state is bounded by one of these)
// ---------------------------------------------------------------------------------------------------------------

pub const MAX_PROFILES: u32 = 500;
pub const MAX_WRECKS: usize = 24;
pub const MAX_LISTINGS: u32 = 100;
pub const RECENT_KEPT: u32 = 64;
pub const LEADERBOARD_ROWS: usize = 10;
/// Units in one sell or buy call (each unit is priced on its own).
pub const MAX_BATCH: u128 = 100;
/// Highest price per unit on a player listing.
pub const MAX_LISTING_PRICE: u128 = 1_000_000;
/// Longest memo on an export, a stance change or a transfer, in bytes.
pub const MAX_MEMO: usize = 160;

// ---------------------------------------------------------------------------------------------------------------
// Loot: what a sealed container holds
// ---------------------------------------------------------------------------------------------------------------

pub struct Loot {
    pub token: usize,
    /// Relative odds out of LOOT_WEIGHT_TOTAL.
    pub odds: u32,
    pub min: u32,
    pub max: u32,
}

/// Common cargo is heavier in the table and relay cores are rare: 5 in 100 containers, so about one run in three
/// sees one (1 − 0.95⁸ ≈ 34%).
pub const LOOT: [Loot; 5] = [
    Loot { token: COPPER, odds: 36, min: 1, max: 2 },
    Loot { token: CHIPS, odds: 26, min: 1, max: 2 },
    Loot { token: MEDS, odds: 18, min: 1, max: 1 },
    Loot { token: FUEL, odds: 15, min: 1, max: 1 },
    Loot { token: CORE, odds: 5, min: 1, max: 1 },
];
pub const LOOT_WEIGHT_TOTAL: u32 = 100;

#[cfg(test)]
mod tests {
    use super::*;

    /// (id, base, export, target, weight) as in docs/ECONOMY.md.
    type Row = (&'static str, u128, Option<u128>, Option<u32>, u32);

    #[test]
    fn table_matches_the_design_doc() {
        let expect: [Row; 9] = [
            ("scrip", 1, None, None, 0),
            ("copper", 60, Some(35), Some(12), 1),
            ("meds", 90, Some(55), Some(8), 1),
            ("chips", 75, Some(45), Some(10), 1),
            ("fuel", 110, Some(70), Some(6), 2),
            ("core", 160, Some(100), Some(4), 1),
            ("plate", 80, None, None, 0),
            ("mag", 50, None, None, 0),
            ("cutter", 65, None, None, 0),
        ];
        for (i, (id, base, export, target, weight)) in expect.iter().enumerate() {
            assert_eq!(ITEMS[i].id, *id);
            assert_eq!(ITEMS[i].base, *base);
            assert_eq!(ITEMS[i].export, *export);
            assert_eq!(ITEMS[i].target, *target);
            assert_eq!(ITEMS[i].weight, *weight);
        }
        assert_eq!(LOOT.iter().map(|l| l.odds).sum::<u32>(), LOOT_WEIGHT_TOTAL);
        // A full load (2 copper + 2 fuel) is exactly the carry limit, as in items.ts.
        assert_eq!(2 * ITEMS[COPPER].weight + 2 * ITEMS[FUEL].weight, CARRY_LIMIT);
    }

    #[test]
    fn every_cargo_has_a_buyer_and_every_gear_a_seller() {
        for t in CARGO {
            assert!((0..BROKER_COUNT).any(|b| buys(b, t)));
        }
        for t in GEAR {
            assert!((0..BROKER_COUNT).any(|b| sells(b, t)));
        }
    }
}
