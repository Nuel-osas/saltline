//! # The town's arc (docs/STORY.md → The arc, The dilemma, Contract additions)
//!
//! Saltline's shared story moves when players **deliver** cargo, meaning sell it to a broker with `sell`. Brokers'
//! exports to the freighter, player-to-player trades and transfers aren't deliveries. Every player reads the same
//! state through the `town` view, and nobody can move it except by delivering.
//!
//! - **Act I, Lockdown** is the start.
//! - **Districts** relight one at a time: the clinic at [`CLINIC_MEDS`] meds, the generators at [`GENERATOR_FUEL`]
//!   fuel cells. Fuel counts whichever broker buys it.
//! - **Act II, Lights on the Water** starts when both districts are lit.
//! - **Act III, The Client** starts in Act II once [`CLIENT_CORES`] relay cores have been sold to the Quartermaster
//!   in all. Cores sold before Act II count. The Quartermaster's client is revealed: the Harbormaster.
//! - **The Harbormaster's strength:** each relay core sold to the Quartermaster after the reveal feeds it, and it
//!   decays with a [`HARBORMASTER_HALF_LIFE_MS`] half-life. Before the reveal it is 0.
//!
//! Each district, act and the reveal is announced once, by the sale that causes it: a NEP-297 `saltline` event
//! (`district { id, at }` or `act { act, at }`) and a line in `recent`, credited to the player who delivered.
//!
//! ## Storage: why the town isn't a field of the contract struct
//! The contract was live on saltline.testnet, with players in it, before the story existed. A new field on
//! `Saltline` would change the Borsh layout of its root state, and the live state would no longer deserialize. So
//! the town is its own Borsh value under its own storage key, [`TOWN_KEY`], read with `env::storage_read` and
//! written with `env::storage_write`. The root struct is untouched.
//! - While the key is absent (from the upgrade until the first sale), the town is at Act I with nothing delivered.
//! - So the upgrade is a plain code deploy: no migration and no init call (contract/upgrade.sh).
//! - No other key starts with `t` (the collections use `p i c r l e`, the root uses `STATE`), so nothing collides.
//! - A later change to [`Town`]'s layout needs a new key or a migration, like any other state.
//!
//! A near-sdk collection with its own prefix would also have kept the root layout, but a `LazyOption` that isn't a
//! root field has to be rebuilt on every call and flushed by hand. A plain read and write says what it does.
//!
//! Integers only: counts are whole units in `u128`, the Harbormaster's recent cores are thousandths of a core
//! (`pricing::MILLI`), and times are block milliseconds.

use std::collections::BTreeMap;

use near_sdk::json_types::U128;
use near_sdk::{borsh, env, near};

use crate::items::*;
use crate::{Saltline, SaltlineExt, now_ms, pricing};

// -----------------------------------------------------------------------------------------------------------------
// The thresholds, all in one place (docs/STORY.md → The arc and The dilemma)
// -----------------------------------------------------------------------------------------------------------------

/// Meds delivered to relight the clinic, the first district of Act II (STORY.md → The arc, Act II).
pub const CLINIC_MEDS: u128 = 15;
/// Fuel cells delivered to restart the generators, the second district of Act II (STORY.md → The arc, Act II).
pub const GENERATOR_FUEL: u128 = 10;
/// Relay cores sold to the Quartermaster, at any act, for the reveal once Act II has started (STORY.md → The arc,
/// Act III).
pub const CLIENT_CORES: u128 = 8;
/// The Harbormaster's recent cores halve over this long: 12 hours (STORY.md → The dilemma).
pub const HARBORMASTER_HALF_LIFE_MS: u64 = 12 * 60 * 60 * 1_000;
/// Strength per whole recent core: `strength = min(100, recent_cores × 10)` (STORY.md → The dilemma).
pub const STRENGTH_PER_CORE: u128 = 10;
/// The most strength the Harbormaster can have (STORY.md → The dilemma: strength is 0–100).
pub const STRENGTH_MAX: u32 = 100;
/// One more drone in every wave for each this much strength: `floor(strength / 25)`, 0–4 (STORY.md → The fight).
pub const STRENGTH_PER_DRONE: u32 = 25;

/// Where the town lives in contract storage (see the module docs on storage).
pub const TOWN_KEY: &[u8] = b"town";

pub struct District {
    pub id: &'static str,
    /// The cargo that relights it.
    pub token: usize,
    pub need: u128,
    /// The `recent` line when it lights.
    pub line: &'static str,
}

pub const DISTRICT_COUNT: usize = 2;
pub const CLINIC: usize = 0;
pub const GENERATORS: usize = 1;

pub const DISTRICTS: [District; DISTRICT_COUNT] = [
    District { id: "clinic", token: MEDS, need: CLINIC_MEDS, line: "The clinic's lights are back on." },
    District {
        id: "generators",
        token: FUEL,
        need: GENERATOR_FUEL,
        line: "The generators are running. Lights on the water.",
    },
];

/// The `recent` line when Act II starts (both districts lit). STORY.md gives no ticker line for it; this one answers
/// Act I's "The town across the water is dark."
pub const ACT_II_LINE: &str = "The town across the water is lit again.";
/// The `recent` line at the reveal, when Act III starts.
pub const REVEAL_LINE: &str = "The Quartermaster's client is the Harbormaster.";

// -----------------------------------------------------------------------------------------------------------------
// State
// -----------------------------------------------------------------------------------------------------------------

/// The town, stored under [`TOWN_KEY`].
#[near(serializers = [borsh])]
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Town {
    /// Units of each cargo players have sold to brokers since the story upgrade, indexed like balances.
    pub delivered: [u128; TOKEN_COUNT],
    /// When each district lit, in [`DISTRICTS`] order.
    pub lit_at: [Option<u64>; DISTRICT_COUNT],
    /// Relay cores sold to the Quartermaster, at any act.
    pub client_cores: u128,
    /// When the Quartermaster's client was revealed (Act III).
    pub revealed_at: Option<u64>,
    /// Cores sold to the Quartermaster since the reveal, in thousandths, as of `recent_at`. Decays lazily, like a
    /// broker's recent gear sales (`pricing::decay_recent`).
    pub recent_cores_milli: u128,
    pub recent_at: u64,
}

/// Something a delivery changed, announced in the order it happened.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Change {
    /// The district at this index in [`DISTRICTS`] lit.
    District(usize),
    /// Act II or Act III started.
    Act(u8),
}

/// `min(100, recent_cores × 10)`, with `recent_cores` in thousandths: whole cores × 10, rounded down.
pub fn strength(recent_cores_milli: u128) -> u32 {
    let s = recent_cores_milli.saturating_mul(STRENGTH_PER_CORE) / pricing::MILLI;
    s.min(STRENGTH_MAX as u128) as u32
}

/// Extra drones in every wave: `floor(strength / 25)`.
pub fn bonus_drones(strength: u32) -> u32 {
    strength / STRENGTH_PER_DRONE
}

impl Town {
    /// The stored town, or Act I with nothing delivered while the key is absent. Unreadable bytes refuse the call
    /// rather than reset the arc.
    pub fn load() -> Self {
        match env::storage_read(TOWN_KEY) {
            None => Town::default(),
            Some(bytes) => borsh::from_slice(&bytes).unwrap_or_else(|_| env::panic_str("town state is unreadable")),
        }
    }

    pub fn save(&self) {
        let bytes = borsh::to_vec(self).unwrap_or_else(|_| env::panic_str("town state can't be written"));
        env::storage_write(TOWN_KEY, &bytes);
    }

    pub fn all_lit(&self) -> bool {
        self.lit_at.iter().all(Option::is_some)
    }

    pub fn act(&self) -> u8 {
        if self.revealed_at.is_some() {
            3
        } else if self.all_lit() {
            2
        } else {
            1
        }
    }

    /// The Harbormaster's recent cores at `now`, in thousandths, decayed since the last core sale.
    pub fn recent_cores(&self, now: u64) -> u128 {
        pricing::halve(self.recent_cores_milli, now.saturating_sub(self.recent_at), HARBORMASTER_HALF_LIFE_MS)
    }

    /// Count `n` units of `token` sold by a player to `broker` at `now`, and return what that changed, in order:
    /// districts lit, then Act II, then the reveal.
    ///
    /// Cores sold to the Quartermaster always count towards the reveal. They feed the Harbormaster only once the
    /// reveal has happened, so the sale that causes the reveal doesn't feed it.
    pub fn deliver(&mut self, broker: usize, token: usize, n: u128, now: u64) -> Vec<Change> {
        let was_act_ii = self.all_lit();
        let was_revealed = self.revealed_at.is_some();
        self.delivered[token] = self.delivered[token].saturating_add(n);
        if broker == QM && token == CORE {
            self.client_cores = self.client_cores.saturating_add(n);
            if was_revealed {
                self.recent_cores_milli = self.recent_cores(now).saturating_add(n.saturating_mul(pricing::MILLI));
                self.recent_at = now;
            }
        }

        let mut changes = Vec::new();
        for (d, district) in DISTRICTS.iter().enumerate() {
            if self.lit_at[d].is_none() && self.delivered[district.token] >= district.need {
                self.lit_at[d] = Some(now);
                changes.push(Change::District(d));
            }
        }
        if !was_act_ii && self.all_lit() {
            changes.push(Change::Act(2));
        }
        if !was_revealed && self.all_lit() && self.client_cores >= CLIENT_CORES {
            self.revealed_at = Some(now);
            self.recent_cores_milli = 0;
            self.recent_at = now;
            changes.push(Change::Act(3));
        }
        changes
    }

    pub fn view(&self, now: u64) -> TownView {
        let recent = self.recent_cores(now);
        let s = strength(recent);
        TownView {
            act: self.act(),
            delivered: CARGO.iter().map(|&t| (ITEMS[t].id.to_string(), U128(self.delivered[t]))).collect(),
            districts: DISTRICTS
                .iter()
                .enumerate()
                .map(|(d, x)| DistrictView {
                    id: x.id.to_string(),
                    token_id: ITEMS[x.token].id.to_string(),
                    need: U128(x.need),
                    have: U128(self.delivered[x.token]),
                    lit: self.lit_at[d].is_some(),
                    lit_at: self.lit_at[d],
                })
                .collect(),
            client: ClientView {
                need: U128(CLIENT_CORES),
                have: U128(self.client_cores),
                revealed: self.revealed_at.is_some(),
                revealed_at: self.revealed_at,
            },
            harbormaster: HarbormasterView { strength: s, recent_cores: U128(recent), bonus_drones: bonus_drones(s) },
        }
    }
}

// -----------------------------------------------------------------------------------------------------------------
// JSON shapes (CONTRACT_API.md → Views → town)
// -----------------------------------------------------------------------------------------------------------------

#[near(serializers = [json])]
pub struct DistrictView {
    pub id: String,
    pub token_id: String,
    pub need: U128,
    pub have: U128,
    pub lit: bool,
    pub lit_at: Option<u64>,
}

#[near(serializers = [json])]
pub struct ClientView {
    pub need: U128,
    /// Relay cores sold to the Quartermaster, at any act.
    pub have: U128,
    pub revealed: bool,
    pub revealed_at: Option<u64>,
}

#[near(serializers = [json])]
pub struct HarbormasterView {
    /// 0–100.
    pub strength: u32,
    /// Cores sold to the Quartermaster since the reveal, decayed to now, in thousandths.
    pub recent_cores: U128,
    pub bonus_drones: u32,
}

#[near(serializers = [json])]
pub struct TownView {
    pub act: u8,
    /// Every cargo, zeros included.
    pub delivered: BTreeMap<String, U128>,
    pub districts: Vec<DistrictView>,
    pub client: ClientView,
    pub harbormaster: HarbormasterView,
}

// -----------------------------------------------------------------------------------------------------------------
// The contract side: count each sale and announce what it changed
// -----------------------------------------------------------------------------------------------------------------

impl Saltline {
    /// Called by `sell` once a player's sale has gone through: count it as a delivery, store the town, and record
    /// any district, act or reveal it caused (an event and a `recent` line each, credited to the seller).
    pub(crate) fn deliver(&mut self, ix: u32, broker: usize, token: usize, n: u128) {
        let now = now_ms();
        let mut town = Town::load();
        let changes = town.deliver(broker, token, n, now);
        town.save();
        if changes.is_empty() {
            return;
        }
        let p = self.player(ix);
        let (me, callsign) = (p.account_id.clone(), p.callsign.clone());
        for change in changes {
            let (kind, text, data) = match change {
                Change::District(d) => {
                    ("district", DISTRICTS[d].line, near_sdk::serde_json::json!({ "id": DISTRICTS[d].id, "at": now }))
                }
                Change::Act(act) => {
                    let line = if act == 3 { REVEAL_LINE } else { ACT_II_LINE };
                    ("act", line, near_sdk::serde_json::json!({ "act": act, "at": now }))
                }
            };
            self.record(kind, &me, Some(callsign.clone()), text.to_string(), data);
        }
    }
}

#[near]
impl Saltline {
    /// The town's arc as it stands now: the act, deliveries, districts, the Quartermaster's client and the
    /// Harbormaster's strength with its decay applied up to this block (docs/STORY.md).
    pub fn town(&self) -> TownView {
        Town::load().view(now_ms())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const H: u64 = 60 * 60 * 1_000;

    #[test]
    fn the_thresholds_are_the_story_bibles() {
        assert_eq!((CLINIC_MEDS, GENERATOR_FUEL, CLIENT_CORES), (15, 10, 8));
        assert_eq!(HARBORMASTER_HALF_LIFE_MS, 12 * H);
        assert_eq!((DISTRICTS[CLINIC].id, DISTRICTS[CLINIC].token, DISTRICTS[CLINIC].need), ("clinic", MEDS, 15));
        assert_eq!(
            (DISTRICTS[GENERATORS].id, DISTRICTS[GENERATORS].token, DISTRICTS[GENERATORS].need),
            ("generators", FUEL, 10)
        );
    }

    #[test]
    fn strength_is_ten_per_whole_core_capped_at_100_with_a_drone_per_25() {
        assert_eq!(strength(0), 0);
        assert_eq!(strength(999), 9, "rounded down: 0.999 cores is 9.99");
        assert_eq!(strength(1_000), 10);
        assert_eq!(strength(2_500), 25);
        assert_eq!(strength(9_999), 99);
        assert_eq!(strength(10_000), 100);
        assert_eq!(strength(50_000), 100, "capped");
        assert_eq!(strength(u128::MAX), 100, "saturates, never wraps");
        let drones: Vec<u32> = [0, 24, 25, 49, 50, 75, 99, 100].iter().map(|&s| bonus_drones(s)).collect();
        assert_eq!(drones, vec![0, 0, 1, 1, 2, 3, 3, 4]);
    }

    #[test]
    fn recent_cores_halve_every_twelve_hours() {
        let t = Town { revealed_at: Some(0), recent_cores_milli: 8_000, recent_at: 0, ..Town::default() };
        assert_eq!(t.recent_cores(0), 8_000);
        assert_eq!(t.recent_cores(12 * H), 4_000);
        assert_eq!(t.recent_cores(24 * H), 2_000);
        // Six hours is half a half-life: 2^-0.5 = 0.7071.
        assert_eq!(t.recent_cores(6 * H), 5_656);
        assert_eq!(t.recent_cores(64 * 12 * H), 0);
        // The same curve as the brokers' recent sales, stretched to 12 hours.
        assert_eq!(t.recent_cores(12 * H), pricing::decay_recent(8_000, 6 * H));
    }

    #[test]
    fn deliveries_light_districts_then_act_ii_then_the_reveal() {
        let mut t = Town::default();
        assert_eq!(t.act(), 1);
        // Cores first, in Act I: they count towards the reveal but can't trigger it.
        assert!(t.deliver(QM, CORE, 9, 1).is_empty());
        assert_eq!((t.client_cores, t.act(), t.recent_cores_milli), (9, 1, 0));
        assert!(t.deliver(INES, MEDS, 14, 2).is_empty());
        assert_eq!(t.deliver(INES, MEDS, 1, 3), vec![Change::District(CLINIC)]);
        assert_eq!(t.act(), 1, "one district isn't Act II");
        // The sale that lights the second district starts Act II, and with 9 cores already sold, the reveal.
        assert_eq!(t.deliver(QM, FUEL, 10, 4), vec![Change::District(GENERATORS), Change::Act(2), Change::Act(3)]);
        assert_eq!((t.act(), t.lit_at, t.revealed_at), (3, [Some(3), Some(4)], Some(4)));
        assert_eq!(t.recent_cores(4), 0, "cores sold before the reveal don't feed the Harbormaster");
        // Each change is announced once.
        assert!(t.deliver(INES, MEDS, 50, 5).is_empty());
        assert_eq!(t.lit_at[CLINIC], Some(3));
        assert!(t.deliver(QM, CORE, 1, 6).is_empty());
        assert_eq!(t.recent_cores(6), 1_000);
    }
}
