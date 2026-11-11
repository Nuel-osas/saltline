//! The default broker policy: what a broker's agent does when it has nothing better to go on.
//!
//! - `advice` shows it to the agent runner, which may follow it or override it. Its own LLM agents sign their own
//!   calls.
//! - `simulate` runs it for every broker, every simulated hour.
//!
//! It is advice only. The contract never acts on it by itself.
//!
//! The rules, in order:
//! 1. **Ship surplus.** Export stock above the keep line, the item with the most scrip in it first, once its hour
//!    has passed.
//!    - The keep line is the target, or 1.5× target for the Quartermaster, who keeps a deeper shelf.
//!    - A closed broker ships down to half its target to get back on its feet.
//! 2. **Mind the till.** An open broker short of cash bids tighter: stance down 10, to its floor. One with cash to
//!    spare bids up: stance up 5, to its ceiling.
//! 3. Otherwise hold.

use crate::items::*;
use crate::pricing;

/// A broker's state as the policy reads it (built from the contract's `Broker`, or from the simulation's copy).
#[derive(Clone)]
pub struct Desk {
    pub broker: usize,
    pub open: bool,
    pub scrip: u128,
    pub stance: u32,
    pub stock: [u128; TOKEN_COUNT],
    pub last_export: [u64; TOKEN_COUNT],
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Move {
    Hold,
    Export { token: usize, amount: u128 },
    Stance(u32),
}

/// Each broker's character, in numbers.
pub struct Temper {
    /// Below this much scrip, bid tighter.
    pub thin: u128,
    /// Above this much, bid up.
    pub flush: u128,
    pub stance_floor: u32,
    pub stance_ceiling: u32,
    /// Keep stock up to target × keep_pct / 100 before shipping.
    pub keep_pct: u128,
}

/// Moss hates waste and ships everything over target. Ines is cautious: she tightens early and rarely bids up. The
/// Quartermaster spends fast: it keeps a deeper shelf and bids up as soon as the till allows.
pub const TEMPERS: [Temper; BROKER_COUNT] = [
    Temper { thin: 700, flush: 2_000, stance_floor: 80, stance_ceiling: 110, keep_pct: 100 },
    Temper { thin: 1_000, flush: 2_600, stance_floor: 80, stance_ceiling: 105, keep_pct: 100 },
    Temper { thin: 450, flush: 1_300, stance_floor: 85, stance_ceiling: 120, keep_pct: 150 },
];

/// The move the default policy makes now. Pure integer logic, no strings, so `simulate` can call it every hour.
pub fn advise(d: &Desk, now: u64) -> Move {
    let temper = &TEMPERS[d.broker];
    // 1. Ship surplus.
    let mut best: Option<(u128, usize, u128)> = None; // (scrip in it, token, amount)
    for &t in BROKERS[d.broker].buys {
        let (_, export, target) = cargo_terms(t);
        let keep = if d.open { target * temper.keep_pct / 100 } else { target / 2 };
        let ready = d.last_export[t] == 0 || now >= d.last_export[t].saturating_add(pricing::EXPORT_COOLDOWN_MS);
        if ready && d.stock[t] > keep {
            let amount = d.stock[t] - if d.open { target } else { keep };
            let value = amount.saturating_mul(export);
            if best.is_none_or(|(v, _, _)| value > v) {
                best = Some((value, t, amount));
            }
        }
    }
    if let Some((_, token, amount)) = best {
        return Move::Export { token, amount };
    }
    // 2. Mind the till.
    if d.open {
        if d.scrip < temper.thin && d.stance > temper.stance_floor {
            return Move::Stance(d.stance.saturating_sub(10).max(temper.stance_floor));
        }
        if d.scrip > temper.flush && d.stance < temper.stance_ceiling {
            return Move::Stance((d.stance + 5).min(temper.stance_ceiling));
        }
    }
    Move::Hold
}

/// The memo the agent would sign with, in the broker's voice.
pub fn memo(d: &Desk, mv: &Move) -> String {
    let name = BROKERS[d.broker].name;
    match mv {
        Move::Export { token, amount } => {
            let (_, export, _) = cargo_terms(*token);
            let what = count(*token, *amount);
            if !d.open {
                format!("Shut and short of float. Shipping {what} at {export} to get back on my feet.")
            } else {
                match d.broker {
                    MOSS => format!("Shipping {what} over target at {export} each. Waste is waste."),
                    INES => format!("Moving {what} to the freighter at {export}. Better cash than a full shed."),
                    _ => format!("The client wants scrip, not stock. {what} out at {export}."),
                }
            }
        }
        Move::Stance(s) if *s < d.stance => format!("Cash is thin at {} scrip. Bidding tighter: stance {s}.", d.scrip),
        Move::Stance(s) => format!("Plenty in the till at {} scrip. Paying up: stance {s}.", d.scrip),
        Move::Hold if !d.open => format!("{name} is shut. Nothing to ship; waiting on investors."),
        Move::Hold => "Holding. Nothing worth shipping and the till is steady.".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn desk(broker: usize) -> Desk {
        Desk { broker, open: true, scrip: 1_500, stance: 100, stock: [0; TOKEN_COUNT], last_export: [0; TOKEN_COUNT] }
    }

    #[test]
    fn ships_surplus_above_target() {
        let mut d = desk(MOSS);
        d.stock[COPPER] = 30;
        d.stock[CHIPS] = 12;
        // 18 copper × 35 = 630 beats 2 chips × 45 = 90.
        assert_eq!(advise(&d, 1), Move::Export { token: COPPER, amount: 18 });
        // Within the hour of the last copper export, it ships chips instead.
        d.last_export[COPPER] = 1;
        assert_eq!(advise(&d, 1_000), Move::Export { token: CHIPS, amount: 2 });
    }

    #[test]
    fn tightens_when_thin_and_holds_when_steady() {
        let mut d = desk(INES);
        assert_eq!(advise(&d, 1), Move::Hold);
        d.scrip = 400;
        assert_eq!(advise(&d, 1), Move::Stance(90));
        d.stance = 80;
        assert_eq!(advise(&d, 1), Move::Hold);
        assert!(memo(&d, &Move::Hold).starts_with("Holding"));
    }
}
