//! `simulate`: the fast-forward. It copies the three brokers into memory and plays simulated traders against them,
//! hour by hour, with the same `pricing.rs` rules and the default `policy.rs`. It returns one point per hour (hour 0
//! is the market now) with each broker's open state, scrip, bids and stock.
//!
//! - It is a view: free, needs no wallet, and changes nothing. The same state and seed always give the same week.
//! - Its budget: 168 hours × 30 traders fits a view call's gas limit. Measured numbers are in contract/README.md.
//!
//! The simulated traders are a model of real players, not a replay. Each hour, each trader:
//! 1. goes out on a run 85% of the time. It deals 8 containers from the real loot table, takes the best value per
//!    weight up to the carry limit, and makes the boat 80% of the time; otherwise the cargo is lost.
//! 2. sells what it holds, up to 12 units an hour, one unit at a time to whichever open broker bids most and can
//!    cover it.
//! 3. buys a piece of gear one hour in three, if it has scrip to spare.
//! 4. invests 150 scrip in a closed broker half the time, if it has 250 or more.
//!
//! Each hour opens with the brokers' turn: each follows `policy::advise`, making as many exports as are due and at
//! most one stance change. Then the traders take their turns.
//! - Point `h` is the market at the end of hour h's trading. A broker flooded and shut during the hour shows as
//!   shut, even if its exports reopen it at the top of the next hour.
//! - Dividends leave the broker as they would on chain, but the model doesn't pay them to the simulated traders.

use std::collections::BTreeMap;

use near_sdk::json_types::U128;
use near_sdk::near;

use crate::items::*;
use crate::policy::{self, Desk, Move};
use crate::pricing;
use crate::runs::{Rng, roll_container};
use crate::{Saltline, SaltlineExt, err, fail, now_ms};

pub const MAX_SIM_HOURS: u32 = 168;
pub const MAX_SIM_TRADERS: u32 = 30;
const HOUR_MS: u64 = 60 * 60 * 1_000;
const OUT_PCT: u64 = 85;
const SURVIVE_PCT: u64 = 80;
const SELL_CAP: u32 = 12;
const GEAR_SPARE: u128 = 300;
const INVEST_FLOOR: u128 = 250;
const INVEST_STAKE: u128 = 150;
/// Best value per unit of weight first: core 160, meds 90, chips 75, copper 60, fuel 55.
const GREED: [usize; 5] = [CORE, MEDS, CHIPS, COPPER, FUEL];

#[near(serializers = [json])]
pub struct SimBroker {
    pub open: bool,
    pub scrip: U128,
    pub bids: BTreeMap<String, U128>,
    pub stock: BTreeMap<String, U128>,
}

#[near(serializers = [json])]
pub struct SimBrokers {
    pub moss: SimBroker,
    pub ines: SimBroker,
    pub qm: SimBroker,
}

#[near(serializers = [json])]
pub struct SimPoint {
    pub hour: u32,
    pub brokers: SimBrokers,
}

/// A broker in memory: the policy's view plus what pricing needs.
#[derive(Clone)]
pub struct SimDesk {
    pub desk: Desk,
    pub recent_milli: u128,
    pub recent_at: u64,
    pub total_shares: u128,
}

struct Trader {
    scrip: u128,
    hold: [u128; TOKEN_COUNT],
}

fn cheapest_bid(d: &Desk) -> u128 {
    BROKERS[d.broker].buys.iter().map(|&t| pricing::bid_for(t, d.stock[t], d.stance)).min().unwrap_or(1)
}

/// The contract's close and reopen rule (Saltline::review_broker), on the copy.
fn review(d: &mut Desk) {
    if d.open && pricing::should_close(d.scrip, cheapest_bid(d)) {
        d.open = false;
    } else if !d.open && pricing::should_reopen(d.scrip) {
        d.open = true;
    }
}

fn point(hour: u32, m: &[SimDesk; BROKER_COUNT]) -> SimPoint {
    let one = |b: usize| {
        let d = &m[b].desk;
        SimBroker {
            open: d.open,
            scrip: U128(d.scrip),
            bids: BROKERS[b]
                .buys
                .iter()
                .map(|&t| (ITEMS[t].id.to_string(), U128(pricing::bid_for(t, d.stock[t], d.stance))))
                .collect(),
            stock: BROKERS[b].buys.iter().map(|&t| (ITEMS[t].id.to_string(), U128(d.stock[t]))).collect(),
        }
    };
    SimPoint { hour, brokers: SimBrokers { moss: one(MOSS), ines: one(INES), qm: one(QM) } }
}

/// Play `hours` hours of `traders` traders against the market `m`, starting at `start` (ms).
pub fn run(mut m: [SimDesk; BROKER_COUNT], hours: u32, traders: u32, seed: u64, start: u64) -> Vec<SimPoint> {
    let mut rng = Rng::new(seed ^ 0x5A17_11E5_0000_0000);
    let mut crew: Vec<Trader> = (0..traders).map(|_| Trader { scrip: STARTER_SCRIP, hold: [0; TOKEN_COUNT] }).collect();
    let mut out = Vec::with_capacity(hours as usize + 1);
    out.push(point(0, &m));

    for hour in 1..=hours {
        let now = start.saturating_add((hour as u64 - 1) * HOUR_MS);
        // The brokers' turn, at the top of the hour: ship what last hour left, change stance, reopen.
        for sd in m.iter_mut() {
            for _ in 0..(BROKERS[sd.desk.broker].buys.len() + 1) {
                match policy::advise(&sd.desk, now) {
                    Move::Export { token, amount } => {
                        let (_, export, _) = cargo_terms(token);
                        let (earned, _dividend) = pricing::export_split(export, amount, sd.total_shares);
                        sd.desk.stock[token] -= amount;
                        sd.desk.scrip += earned;
                        sd.desk.last_export[token] = now;
                        review(&mut sd.desk);
                    }
                    Move::Stance(s) => {
                        sd.desk.stance = s;
                        review(&mut sd.desk);
                        break;
                    }
                    Move::Hold => break,
                }
            }
        }
        for k in 0..traders as usize {
            let tr = &mut crew[(k + hour as usize) % traders as usize];

            // 1. A run.
            if rng.below(100) < OUT_PCT {
                let mut found = [0u128; TOKEN_COUNT];
                for _ in 0..CONTAINERS_PER_RUN {
                    let (t, n) = roll_container(&mut rng);
                    found[t] += n as u128;
                }
                let mut room = CARRY_LIMIT as u128;
                let mut carried = [0u128; TOKEN_COUNT];
                for &t in GREED.iter() {
                    let w = ITEMS[t].weight as u128;
                    let take = found[t].min(room / w);
                    carried[t] = take;
                    room -= take * w;
                }
                if rng.below(100) < SURVIVE_PCT {
                    for t in CARGO {
                        tr.hold[t] += carried[t];
                    }
                }
            }

            // 2. Sell, unit by unit, to the best open bid that can be covered.
            let mut sold = 0;
            for &t in GREED.iter() {
                while tr.hold[t] > 0 && sold < SELL_CAP {
                    let mut best: Option<(u128, usize)> = None;
                    for (b, sd) in m.iter().enumerate() {
                        let d = &sd.desk;
                        if d.open && buys(b, t) {
                            let bid = pricing::bid_for(t, d.stock[t], d.stance);
                            if pricing::can_cover(d.scrip, bid) && best.is_none_or(|(p, _)| bid > p) {
                                best = Some((bid, b));
                            }
                        }
                    }
                    let Some((bid, b)) = best else { break };
                    let d = &mut m[b].desk;
                    d.stock[t] += 1;
                    d.scrip -= bid;
                    tr.hold[t] -= 1;
                    tr.scrip += bid;
                    sold += 1;
                    review(d);
                }
            }

            // 3. Gear, now and then.
            if tr.scrip >= GEAR_SPARE && rng.below(3) == 0 {
                let b = rng.below(BROKER_COUNT as u64) as usize;
                let sd = &mut m[b];
                if sd.desk.open {
                    let g = BROKERS[b].sells[0];
                    let recent = pricing::decay_recent(sd.recent_milli, now.saturating_sub(sd.recent_at));
                    let price = pricing::ask_for(g, recent, sd.desk.stance);
                    if tr.scrip >= price {
                        tr.scrip -= price;
                        sd.desk.scrip += price;
                        sd.recent_milli = recent + pricing::MILLI;
                        sd.recent_at = now;
                    }
                }
            }

            // 4. Back a closed broker.
            for sd in m.iter_mut() {
                if !sd.desk.open && tr.scrip >= INVEST_FLOOR && rng.below(2) == 0 {
                    tr.scrip -= INVEST_STAKE;
                    sd.desk.scrip += INVEST_STAKE;
                    sd.total_shares += INVEST_STAKE;
                    review(&mut sd.desk);
                }
            }
        }

        out.push(point(hour, &m));
    }
    out
}

#[near]
impl Saltline {
    /// Fast-forward the market: `hours` (1–168) of `traders` (0–30) simulated players, from the market as it is now.
    pub fn simulate(&self, hours: u32, traders: u32, seed: u64) -> Vec<SimPoint> {
        if hours == 0 || hours > MAX_SIM_HOURS {
            fail(err::BAD_AMOUNT, format!("Simulate 1 to {MAX_SIM_HOURS} hours"));
        }
        if traders > MAX_SIM_TRADERS {
            fail(err::BAD_AMOUNT, format!("Simulate at most {MAX_SIM_TRADERS} traders"));
        }
        let m: [SimDesk; BROKER_COUNT] = core::array::from_fn(|b| {
            let br = &self.brokers[b];
            SimDesk {
                desk: self.desk(b),
                recent_milli: br.recent_milli,
                recent_at: br.recent_at,
                total_shares: br.total_shares,
            }
        });
        run(m, hours, traders, seed, now_ms())
    }
}
