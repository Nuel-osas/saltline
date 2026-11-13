//! The export desk (docs/GAME.md → Money; docs/CONTRACT_V2.md → Export): it buys materials for the freighter and
//! pays in new scrip. After the opening stock and the dock passes, this is the only way scrip is made.
//!
//! ```text
//! price per unit = export × 100 ÷ (100 + 4 × units of that material exported recently)
//! ```
//!
//! - A batch is priced one unit at a time, each unit adding one to the recent volume.
//! - "Recently" halves every 12 hours: the desk keeps each material's volume in thousandths of a unit with the
//!   time it was last updated, and decays it lazily (`items::halve`).
//! - The material is burned. A player or a vendor may export; the Harbormaster and the contract can't.

use near_sdk::json_types::U128;
use near_sdk::{env, near};

use crate::items::*;
use crate::mt::{self, BurnLog, MintLog};
use crate::vendors::{Paid, Quote};
use crate::{Holder, Saltline, SaltlineExt, amount_in, err, fail, now_ms};

impl Saltline {
    /// A material's recent export volume in thousandths of a unit, decayed to `now`.
    pub(crate) fn exported_recently(&self, t: usize, now: u64) -> u128 {
        let (milli, at) = self.exported[material_slot(t)];
        halve(milli, now.saturating_sub(at), EXPORT_HALF_LIFE_HOURS * HOUR_MS)
    }
}

#[near]
impl Saltline {
    /// Sell materials to the freighter for newly minted scrip.
    pub fn export(&mut self, token_id: String, amount: U128) -> Paid {
        self.guard();
        let who = env::predecessor_account_id();
        let h = match self.holder_of(&who) {
            Some(Holder::Player(_)) => Holder::Player(self.caller_player()),
            Some(h @ Holder::Vendor(_)) => h,
            _ => fail(err::NOT_REGISTERED, "Not registered. Claim a dock pass first"),
        };
        let t = token_index(&token_id)
            .filter(|&t| is_material(t))
            .unwrap_or_else(|| fail(err::DOESNT_BUY, format!("The export desk doesn't buy {token_id}")));
        let n = amount_in(amount, MAX_BATCH);
        let now = now_ms();
        // Ines's meds: what the clinic has used since they were last counted goes first.
        let clinic = h == Holder::Vendor(INES) && t == MEDS;
        if clinic {
            self.meds_decay(now);
        }
        if self.balance(h, t) < n {
            fail(err::FUNDS, format!("You don't have {}", count(t, n)));
        }
        if clinic {
            self.meds_moved(n, false);
        }
        let recent = self.exported_recently(t, now);
        let paid = export_value(t, recent, n);
        self.burn(h, t, n);
        self.mint(h, SCRIP, paid);
        self.exported[material_slot(t)] = (recent.saturating_add(n * MILLI), now);
        mt::emit_burn(vec![BurnLog::one(&who, t, n, Some("exported"))]);
        mt::emit_mint(vec![MintLog::one(&who, SCRIP, paid, Some("export"))]);
        let (name, callsign) = match h {
            Holder::Player(ix) => {
                let c = self.player(ix).callsign.clone();
                (c.clone(), Some(c))
            }
            Holder::Vendor(v) => (VENDORS[v].name.to_string(), None),
            _ => (who.to_string(), None),
        };
        let text = format!("{name} shipped {} on the freighter for {paid}.", count(t, n));
        self.record(
            "export",
            &who,
            callsign,
            text,
            near_sdk::serde_json::json!({ "token_id": TOKENS[t].id, "amount": U128(n), "paid": U128(paid) }),
        );
        Paid { paid: U128(paid) }
    }

    /// What the export desk pays for one unit of each material right now.
    pub fn export_prices(&self) -> Vec<Quote> {
        let now = now_ms();
        MATERIALS
            .iter()
            .map(|&t| {
                let recent = self.exported_recently(t, now);
                let price = export_price(t, recent);
                let units = recent / MILLI;
                let reason = if units == 0 {
                    format!("Nothing shipped lately. Paying the full {}.", TOKENS[t].export)
                } else {
                    format!("About {units} shipped lately. Down from {}.", TOKENS[t].export)
                };
                Quote { token_id: TOKENS[t].id.to_string(), price: U128(price), reason }
            })
            .collect()
    }
}
