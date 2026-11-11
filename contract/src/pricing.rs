//! # The pricing rules
//!
//! Every price in Saltline comes from this file. These are plain integer functions of a broker's state: no
//! floats, no owner overrides, and nothing hidden. The contract calls them for real trades, the `brokers` view
//! calls them for the prices on the stalls, and `simulate` calls the same ones for the fast-forward.
//!
//! Each `*_quote` function returns a price and the one-line reason the Dockside shows in its tooltip.
//!
//! ## Numbers
//! - Amounts and prices are whole scrip (`u128`). Scrip has no decimals.
//! - Every division rounds down, done once at the end of each formula so the error is under one scrip.
//! - Arithmetic saturates rather than wraps. Every input is bounded far below where that could matter (bases ≤ 160,
//!   targets ≤ 12, stances ≤ 120), so saturation is a guard, not a rule.
//! - Two fixed-point values, both stated where they're used:
//!   - recent gear sales are counted in **thousandths of a unit** ([`MILLI`]);
//!   - dividends per share are scaled by **10¹²** ([`ACC_SCALE`]).
//!
//! ## Rules this file settles that the design doc leaves open
//! 1. **When a broker closes:** [`should_close`]. It closes after a trade, export or stance change leaves it unable
//!    to pay for one more unit at its highest current bid and stay at or above the float.
//! 2. **Lazy decay of recent sales:** [`decay_recent`]. It halves every 6 hours and is computed from a stored value
//!    and a timestamp.
//! 3. **Per-unit batch pricing:** [`sale_value`] and [`purchase_cost`]. Each unit is priced on its own, with stock
//!    (or recent sales) moved by one between units.
//! 4. **The dividend split:** [`export_split`] and [`dividend_per_share`]. Shareholders get 10% of export proceeds,
//!    pro rata, rounded down.
//! 5. **The wreck split:** [`wreck_split`]. The finder gets 70% rounded down, so the player who died gets the
//!    remainder.

use crate::items::{self, ITEMS};

/// A broker can't go below this much scrip. A sale that would take it there is refused.
pub const FLOAT: u128 = 100;
/// A closed broker reopens when its scrip reaches this line (from investment or its own exports).
pub const REOPEN_LINE: u128 = 400;
/// The broker's lever on its prices, in percent: 80 is tight-fisted, 120 is generous.
pub const STANCE_MIN: u32 = 80;
pub const STANCE_NEUTRAL: u32 = 100;
pub const STANCE_MAX: u32 = 120;
/// Share of export proceeds paid to a broker's shareholders, in percent.
pub const DIVIDEND_PCT: u128 = 10;
/// A broker may export each item at most this often.
pub const EXPORT_COOLDOWN_MS: u64 = 60 * 60 * 1_000;
/// Recent gear sales halve over this long.
pub const RECENT_HALF_LIFE_MS: u64 = 6 * 60 * 60 * 1_000;
/// Fixed point for recent sales: 1 unit sold = 1,000.
pub const MILLI: u128 = 1_000;
/// Fixed point for dividends per share: 1 scrip per share = 10¹².
pub const ACC_SCALE: u128 = 1_000_000_000_000;

// -------------------------------------------------------------------------------------------------------------
// Bids: what a broker pays for cargo
// -------------------------------------------------------------------------------------------------------------

/// The bid for one unit:
///
/// ```text
/// bid = base × 2 × target / (target + stock) × stance / 100
/// ```
///
/// - At zero stock it is 2× base, at target stock it is base, and at three times the target it is half base.
/// - The whole product is formed before the one division.
/// - The bid never falls below 1 scrip, so a sale is never free.
pub fn bid(base: u128, target: u128, stock: u128, stance: u32) -> u128 {
    let top = base.saturating_mul(2).saturating_mul(target).saturating_mul(stance as u128);
    let bottom = target.saturating_add(stock).saturating_mul(100);
    (top / bottom.max(1)).max(1)
}

/// [`bid`] for an item in the table.
pub fn bid_for(cargo: usize, stock: u128, stance: u32) -> u128 {
    let (base, _, target) = items::cargo_terms(cargo);
    bid(base, target, stock, stance)
}

/// The bid for one unit, with the line the stall shows.
///
/// Example: copper at 34 against a target of 12 bids 31, with "Sitting on 34 coils against a target of 12. Paying
/// half."
pub fn bid_quote(cargo: usize, stock: u128, stance: u32, open: bool) -> (u128, String) {
    let price = bid_for(cargo, stock, stance);
    if !open {
        return (price, format!("Shut until someone invests. Would pay {price} at this stock."));
    }
    let item = &ITEMS[cargo];
    let target = item.target.unwrap_or(0) as u128;
    let shelf = if stock == 0 {
        format!("Not a {} in the shed.", item.one)
    } else if stock < target {
        format!("Short: {} against a target of {target}.", items::count(cargo, stock))
    } else if stock == target {
        format!("Holding {}, right on target.", items::count(cargo, stock))
    } else {
        format!("Sitting on {} against a target of {target}.", items::count(cargo, stock))
    };
    let paying = match price.saturating_mul(100) / item.base {
        190.. => "Paying double.",
        140..=189 => "Paying half again.",
        110..=139 => "Paying over base.",
        91..=109 => "Paying base.",
        70..=90 => "Paying under base.",
        58..=69 => "Paying two-thirds.",
        42..=57 => "Paying half.",
        28..=41 => "Paying a third.",
        _ => "Paying scrap rates.",
    };
    (price, format!("{shelf} {paying}{}", stance_note(stance)))
}

/// What a broker pays for `n` units sold together.
///
/// **Batches are priced one unit at a time, with stock rising by one between units**, so a big dump gets a worse
/// average than the first unit's bid. Dropping six coils on a broker at target pays 60 + 57 + 55 + 53 + 51 + 49.
pub fn sale_value(cargo: usize, stock: u128, stance: u32, n: u128) -> u128 {
    let mut total: u128 = 0;
    for i in 0..n {
        total = total.saturating_add(bid_for(cargo, stock.saturating_add(i), stance));
    }
    total
}

/// The most units of `cargo` (up to `n`) a broker holding `scrip` can buy without going under the float.
pub fn units_covered(cargo: usize, stock: u128, stance: u32, scrip: u128, n: u128) -> u128 {
    let mut paid: u128 = 0;
    for i in 0..n {
        paid = paid.saturating_add(bid_for(cargo, stock.saturating_add(i), stance));
        if !can_cover(scrip, paid) {
            return i;
        }
    }
    n
}

// -------------------------------------------------------------------------------------------------------------
// Asks: what gear costs
// -------------------------------------------------------------------------------------------------------------

/// The ask for one unit of gear:
///
/// ```text
/// ask = base × (100 + recent_sales) / 100 × stance / 100
/// ```
///
/// - `recent_sales` is in thousandths of a unit (`recent_milli`), so the formula runs as
///   `base × (100,000 + recent_milli) × stance / 10,000,000`.
/// - The ask never falls below 1 scrip.
pub fn ask(base: u128, recent_milli: u128, stance: u32) -> u128 {
    let top = base.saturating_mul(100 * MILLI + recent_milli).saturating_mul(stance as u128);
    (top / (100 * MILLI * 100)).max(1)
}

/// [`ask`] for an item in the table.
pub fn ask_for(gear: usize, recent_milli: u128, stance: u32) -> u128 {
    ask(ITEMS[gear].base, recent_milli, stance)
}

/// The ask for one unit of gear, with the line the stall shows.
pub fn ask_quote(gear: usize, recent_milli: u128, stance: u32, open: bool) -> (u128, String) {
    let price = ask_for(gear, recent_milli, stance);
    if !open {
        return (price, "Shut. Not selling until someone invests.".to_string());
    }
    let item = &ITEMS[gear];
    let sold = recent_milli / MILLI;
    let demand = if sold == 0 {
        format!("Quiet on {} lately.", item.many)
    } else {
        format!("Sold about {} in the last few hours.", items::count(gear, sold))
    };
    let charging = match price.saturating_mul(100) / item.base {
        0..=91 => "Charging under list.",
        92..=108 => "Charging list.",
        109..=130 => "Charging over list.",
        _ => "Charging what the market bears.",
    };
    (price, format!("{demand} {charging}{}", stance_note(stance)))
}

/// What `n` units of gear cost bought together: one unit at a time, each sale adding one unit to recent sales.
pub fn purchase_cost(gear: usize, recent_milli: u128, stance: u32, n: u128) -> u128 {
    let mut total: u128 = 0;
    for i in 0..n {
        total = total.saturating_add(ask_for(gear, recent_milli.saturating_add(i.saturating_mul(MILLI)), stance));
    }
    total
}

/// **Lazy decay of recent sales.** The broker stores `recent_milli` and the time it was last updated. Anyone
/// reading it applies the decay for the time since then:
///
/// ```text
/// recent_now = recent_then × 2^(−elapsed / 6 h)
/// ```
///
/// - Whole half-lives are a right shift.
/// - The part of a half-life left over uses a 16-step table of 2^(−k/16) in parts per million, interpolated in a
///   straight line between steps. That is within 0.1% of the true curve, and integer-only.
/// - The stored value is rewritten only when a sale changes it. Reading it costs nothing and changes nothing.
pub fn decay_recent(recent_milli: u128, elapsed_ms: u64) -> u128 {
    // 2^(−k/16) × 1,000,000 for k = 0..=16.
    const HALVING_PPM: [u128; 17] = [
        1_000_000, 957_603, 917_004, 878_126, 840_896, 805_245, 771_105, 738_413, 707_107, 677_128, 648_420, 620_929,
        594_604, 569_394, 545_254, 522_137, 500_000,
    ];
    let halvings = elapsed_ms / RECENT_HALF_LIFE_MS;
    if halvings >= 64 || recent_milli == 0 {
        return 0;
    }
    let whole = recent_milli >> halvings;
    let rest = (elapsed_ms % RECENT_HALF_LIFE_MS) as u128; // 0 ≤ rest < half-life
    let span = RECENT_HALF_LIFE_MS as u128;
    let step = (rest * 16 / span) as usize; // 0..=15
    let into_step = rest * 16 % span; // how far between step and step + 1, out of span
    let (a, b) = (HALVING_PPM[step], HALVING_PPM[step + 1]);
    let ppm = a - (a - b) * into_step / span;
    whole * ppm / 1_000_000
}

// -------------------------------------------------------------------------------------------------------------
// Cash: covering, closing, reopening
// -------------------------------------------------------------------------------------------------------------

/// A broker can pay `paid` only if it keeps at least the float afterwards.
pub fn can_cover(scrip: u128, paid: u128) -> bool {
    scrip >= paid.saturating_add(FLOAT)
}

/// **When exactly a broker closes** (settled by the project lead, 11 Nov 2026):
///
/// ```text
/// close when  scrip < FLOAT + highest current bid
/// ```
///
/// - **A sale** is refused (`E_BROKER_BROKE`) only if paying for it would take the broker below the float of 100.
/// - **After every trade, export or stance change**, an open broker checks whether it could still pay for one more
///   unit at its highest current bid and stay at or above the float. If it couldn't, it closes and the ledger says
///   so (`close`).
/// - **A closed broker** refuses `sell` and `buy` with `E_BROKER_CLOSED`. It can still `broker_export`, which is how
///   it can recover by itself.
///
/// The doc's "a broker below the float is closed" can't be met literally, because a sale that would cross the float
/// is refused. This rule shuts the stall while it still has its float, before it can't honour its own top price.
///
/// One consequence: the reopen line (400) is below `FLOAT + top bid` for a broker whose top bid is over 300. That is
/// the Quartermaster with almost no relay cores, bidding 320 for the next one. Investors can reopen it, and the next
/// trade closes it again unless the till has grown past that bid. That is the trap from the doc: a broker that
/// overpays goes broke.
pub fn should_close(scrip: u128, top_bid: u128) -> bool {
    !can_cover(scrip, top_bid)
}

/// A closed broker reopens once its scrip reaches the reopen line, through investment (`invest`) or its own exports
/// (`broker_export`), and the ledger says so (`reopen`).
pub fn should_reopen(scrip: u128) -> bool {
    scrip >= REOPEN_LINE
}

// -------------------------------------------------------------------------------------------------------------
// Splits: exports and wrecks
// -------------------------------------------------------------------------------------------------------------

/// **The dividend split.** An export of `amount` units pays `export_price × amount` in newly minted scrip.
///
/// - If the broker has shareholders, 10% of that, rounded down, is their dividend. The broker keeps the rest
///   (`earned`), so rounding favours the broker.
/// - With no shareholders the broker keeps it all.
///
/// Returns `(earned, dividend)`, and `earned + dividend` is the gross.
pub fn export_split(export_price: u128, amount: u128, total_shares: u128) -> (u128, u128) {
    let gross = export_price.saturating_mul(amount);
    let dividend = if total_shares == 0 { 0 } else { gross * DIVIDEND_PCT / 100 };
    (gross - dividend, dividend)
}

/// How a dividend is shared: pro rata to shares (one share per scrip invested).
///
/// - Paying every shareholder at export time would loop over all of them.
/// - Instead the broker keeps one running total, dividend per share × 10¹² ([`ACC_SCALE`]), and each export adds
///   to it.
/// - A shareholder is owed `shares × total / 10¹²` minus what they were owed when last paid ([`owed`]). That is
///   paid into their scrip the next time their account is touched, and shown in their balance until then.
/// - Rounding down here and in [`owed`] leaves under one scrip per shareholder, ever, unpaid.
pub fn dividend_per_share(dividend: u128, total_shares: u128) -> u128 {
    if total_shares == 0 { 0 } else { dividend.saturating_mul(ACC_SCALE) / total_shares }
}

/// A shareholder's lifetime dividend entitlement at the running total `acc`, in whole scrip.
pub fn owed(shares: u128, acc: u128) -> u128 {
    shares.saturating_mul(acc) / ACC_SCALE
}

/// **The wreck split.** Of each item in a recovered wreck, the finder gets 70% rounded down and the player who
/// died gets the rest, so rounding goes the original owner's way. One relay core goes back to its owner.
/// Returns `(finder, owner)`.
pub fn wreck_split(amount: u128) -> (u128, u128) {
    let finder = amount * items::FINDER_SHARE_PCT / 100;
    (finder, amount - finder)
}

fn stance_note(stance: u32) -> String {
    match stance {
        s if s < STANCE_NEUTRAL => format!(" Tight-fisted today: stance {s}."),
        s if s > STANCE_NEUTRAL => format!(" Generous today: stance {s}."),
        _ => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::items::*;

    #[test]
    fn bid_is_double_base_at_zero_stock_base_at_target_half_at_three_times() {
        for t in CARGO {
            let (base, _, target) = cargo_terms(t);
            assert_eq!(bid_for(t, 0, 100), 2 * base, "{}", ITEMS[t].id);
            assert_eq!(bid_for(t, target, 100), base, "{}", ITEMS[t].id);
            assert_eq!(bid_for(t, 3 * target, 100), base / 2, "{}", ITEMS[t].id);
        }
    }

    #[test]
    fn stance_scales_the_bid_and_the_ask() {
        assert_eq!(bid_for(COPPER, 12, 80), 48);
        assert_eq!(bid_for(COPPER, 12, 120), 72);
        assert_eq!(bid_for(CORE, 0, 120), 384);
        assert_eq!(ask_for(CUTTER, 0, 100), 65);
        assert_eq!(ask_for(CUTTER, 0, 80), 52);
        assert_eq!(ask_for(PLATE, 0, 120), 96);
    }

    #[test]
    fn the_doc_example_reads_as_written() {
        let (price, why) = bid_quote(COPPER, 34, 100, true);
        assert_eq!(price, 31);
        assert_eq!(why, "Sitting on 34 coils against a target of 12. Paying half.");
        let (_, short) = bid_quote(CORE, 1, 90, true);
        assert_eq!(
            short,
            "Short: 1 relay core against a target of 4. Paying half again. Tight-fisted today: stance 90."
        );
        let (_, shut) = bid_quote(MEDS, 8, 100, false);
        assert!(shut.starts_with("Shut until someone invests."));
    }

    #[test]
    fn bids_never_reach_zero() {
        assert_eq!(bid_for(COPPER, u128::MAX, 80), 1);
        assert_eq!(bid_for(COPPER, 1_000_000, 80), 1);
    }

    #[test]
    fn a_batch_gets_worse_with_every_unit() {
        // Six coils into a broker at target: 60, 57, 55, 53, 51, 49.
        assert_eq!(sale_value(COPPER, 12, 100, 6), 60 + 57 + 55 + 53 + 51 + 49);
        let one_by_one: Vec<u128> = (0..6).map(|i| bid_for(COPPER, 12 + i, 100)).collect();
        assert!(one_by_one.windows(2).all(|w| w[1] < w[0]));
        // Selling 6 together pays less than 6 × the first unit's bid.
        assert!(sale_value(COPPER, 12, 100, 6) < 6 * bid_for(COPPER, 12, 100));
        // Gear gets dearer as it sells.
        assert_eq!(purchase_cost(CUTTER, 0, 100, 1), 65);
        assert!(purchase_cost(CUTTER, 0, 100, 3) > 3 * 65);
    }

    #[test]
    fn recent_sales_halve_every_six_hours() {
        let h = 60 * 60 * 1_000;
        assert_eq!(decay_recent(8_000, 0), 8_000);
        assert_eq!(decay_recent(8_000, 6 * h), 4_000);
        assert_eq!(decay_recent(8_000, 12 * h), 2_000);
        // Three hours is half a half-life: 2^-0.5 = 0.7071.
        assert_eq!(decay_recent(8_000, 3 * h), 5_656);
        // Monotone, never negative, and gone after long enough.
        let mut last = u128::MAX;
        for m in 0..200 {
            let v = decay_recent(10_000, m * 15 * 60 * 1_000);
            assert!(v <= last);
            last = v;
        }
        assert_eq!(decay_recent(10_000, 400 * h), 0);
    }

    #[test]
    fn closing_and_reopening_lines() {
        assert!(can_cover(160, 60));
        assert!(!can_cover(159, 60));
        assert!(should_close(150, 60));
        assert!(!should_close(160, 60));
        assert!(!should_reopen(399));
        assert!(should_reopen(400));
    }

    #[test]
    fn splits_round_the_right_way() {
        assert_eq!(export_split(35, 10, 0), (350, 0));
        assert_eq!(export_split(35, 10, 200), (315, 35));
        assert_eq!(export_split(35, 3, 200), (95, 10)); // 105 gross, 10.5 → 10 to shareholders
        assert_eq!(wreck_split(1), (0, 1));
        assert_eq!(wreck_split(2), (1, 1));
        assert_eq!(wreck_split(3), (2, 1));
        assert_eq!(wreck_split(10), (7, 3));
        let acc = dividend_per_share(35, 200);
        assert_eq!(owed(150, acc), 26); // 35 × 150/200 = 26.25
        assert_eq!(owed(50, acc), 8); // 8.75; the 0.99 left over is never minted
    }
}
