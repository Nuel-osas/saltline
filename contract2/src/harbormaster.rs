//! The Harbormaster's wallet (docs/GAME.md → The invoice; docs/CONTRACT_V2.md → Arrears, The Harbormaster).
//!
//! The villain has a wallet, and its difficulty is its balance.
//! - **In:** `settle` (a player pays down arrears) and `buy_back` (an impound fee). Nothing else pays it.
//! - **Out:** the balance halves every 12 hours. The lost part is burned: that is the scrip it spent on machines.
//! - `strength` = min(100, balance ÷ 20).
//! - `patrols`: `bonus_drones` = strength ÷ 25, and the thresholds are 600 / 1,200 / 2,400 / 4,000.
//! - `pursuit`: no bonus drones, and the Bailiff's threshold is 1,200 − 4 × strength. The other three thresholds
//!   don't move.
//! - `hm_posture` is the Harbormaster's own call (its agent's): it picks where the strength goes. It can't change
//!   the balance, the strength or any number above.
//!
//! ## How the decay is kept honest
//! The balance is stored with the time it was last brought up to date, and decayed lazily: every view computes it
//! for now, and every payment first burns what has decayed since. Rounding a whole-scrip balance down on every
//! payment would bleed it faster the busier the dock is (one scrip a touch, however short the gap), so the wallet
//! also keeps its balance in millionths of a scrip. The decay runs on that, and the whole-scrip ledger balance
//! follows it down.
//!
//! What is left of the error: `items::halve` draws the curve as 16 straight steps per half-life, and a straight
//! step sits a little above the curve. A wallet left alone for 12 hours halves exactly. One paid every minute
//! decays about 1.5% slow over the same 12 hours (a half-life near 12 h 15 min). A test pins that bound.

use near_sdk::json_types::U128;
use near_sdk::{AccountId, env, near};

use crate::items::*;
use crate::mt::{self, BurnLog, TransferLog};
use crate::nft::WeaponView;
use crate::{HELD, Holder, IMPOUNDED, Saltline, SaltlineExt, amount_in, check_memo, err, fail, now_ms};

#[near(serializers = [json])]
pub struct HarbormasterView {
    pub account_id: AccountId,
    pub balance: U128,
    pub strength: u32,
    pub posture: String,
    pub bonus_drones: u32,
    pub second_notice_at: U128,
    pub bailiff_at: U128,
    pub second_bailiff_at: U128,
    pub foreclosure_at: U128,
    pub last_memo: Option<String>,
}

#[near(serializers = [json])]
pub struct SettleResult {
    /// Scrip taken from the caller.
    pub paid: U128,
    pub cleared: U128,
    pub arrears: U128,
}

#[near(serializers = [json])]
pub struct BuyBackResult {
    pub weapon: WeaponView,
    pub cost: U128,
}

/// (bonus drones, Bailiff threshold) for a posture at a strength.
pub fn posture_effect(posture: u8, strength: u32) -> (u32, u128) {
    if posture == PURSUIT {
        (0, BAILIFF_AT.saturating_sub(BAILIFF_DROP_PER_STRENGTH * strength as u128))
    } else {
        (strength / STRENGTH_PER_DRONE, BAILIFF_AT)
    }
}

impl Saltline {
    fn hm_micro(&self, now: u64) -> u128 {
        halve(self.hm.micro, now.saturating_sub(self.hm.at), HM_HALF_LIFE_HOURS * HOUR_MS)
    }

    /// The Harbormaster's scrip, decayed to `now`.
    pub(crate) fn hm_balance(&self, now: u64) -> u128 {
        self.hm_micro(now) / MICRO
    }

    /// Bring the wallet up to `now`: burn the scrip that has decayed since it was last touched.
    fn hm_decay(&mut self, now: u64) {
        let micro = self.hm_micro(now);
        let lost = self.hm.bal[SCRIP].saturating_sub(micro / MICRO);
        if lost > 0 {
            self.burn(Holder::Harbormaster, SCRIP, lost);
            mt::emit_burn(vec![BurnLog::one(&self.hm.account_id, SCRIP, lost, Some("spent on machines"))]);
        }
        self.hm.micro = micro;
        self.hm.at = now;
    }

    /// Pay the Harbormaster: the only way scrip reaches its wallet.
    pub(crate) fn hm_pay(&mut self, from: Holder, n: u128, memo: &str) {
        self.hm_decay(now_ms());
        self.move_tokens(from, Holder::Harbormaster, SCRIP, n);
        self.hm.micro = self.hm.micro.saturating_add(n.saturating_mul(MICRO));
        mt::emit_transfer(vec![TransferLog::one(&self.account_of(from), &self.hm.account_id, SCRIP, n, Some(memo))]);
    }

    pub(crate) fn hm_view(&self, now: u64) -> HarbormasterView {
        let balance = self.hm_balance(now);
        let s = strength(balance);
        let (bonus_drones, bailiff_at) = posture_effect(self.hm.posture, s);
        HarbormasterView {
            account_id: self.hm.account_id.clone(),
            balance: U128(balance),
            strength: s,
            posture: POSTURES[self.hm.posture as usize].to_string(),
            bonus_drones,
            second_notice_at: U128(SECOND_NOTICE_AT),
            bailiff_at: U128(bailiff_at),
            second_bailiff_at: U128(SECOND_BAILIFF_AT),
            foreclosure_at: U128(FORECLOSURE_AT),
            last_memo: self.hm.last_memo.clone(),
        }
    }
}

#[near]
impl Saltline {
    /// Pay down arrears: up to ⌈arrears ÷ 2⌉ scrip goes to the Harbormaster, and each scrip clears two.
    pub fn settle(&mut self, amount: U128) -> SettleResult {
        let ix = self.caller_player();
        let offered = amount_in(amount, u128::MAX);
        let arrears = self.player(ix).arrears;
        if arrears == 0 {
            fail(err::NOTHING_OWED, "You owe the Harbormaster nothing");
        }
        let pay = offered.min(arrears.div_ceil(SETTLE_RATE));
        if self.balance(Holder::Player(ix), SCRIP) < pay {
            fail(err::FUNDS, format!("That takes {pay} scrip"));
        }
        let cleared = arrears.min(pay.saturating_mul(SETTLE_RATE));
        self.hm_pay(Holder::Player(ix), pay, "arrears");
        let p = self.player_mut(ix);
        p.arrears -= cleared;
        let left = p.arrears;
        let (me, callsign) = self.who(ix);
        let text = format!("{callsign} paid the Harbormaster {pay}. {cleared} of arrears cleared, {left} still owed.");
        self.record(
            "settle",
            &me,
            Some(callsign),
            text,
            near_sdk::serde_json::json!({ "paid": U128(pay), "cleared": U128(cleared), "arrears": U128(left) }),
        );
        SettleResult { paid: U128(pay), cleared: U128(cleared), arrears: U128(left) }
    }

    /// Buy an impounded gun back: the fee goes to the Harbormaster and the gun comes home.
    pub fn buy_back(&mut self, serial: String) -> BuyBackResult {
        let ix = self.caller_player();
        let n = self.find_gun(&serial);
        let g = self.gun(n);
        if g.owner != self.player(ix).account_id {
            fail(err::NOT_OWNER, format!("{serial} isn't yours"));
        }
        if g.state != IMPOUNDED {
            fail(err::NOT_IMPOUNDED, format!("{serial} isn't in the impound"));
        }
        let fee = g.fee;
        let label = g.label();
        if self.balance(Holder::Player(ix), SCRIP) < fee {
            fail(err::FUNDS, format!("The Harbormaster wants {fee} scrip for {serial}"));
        }
        self.hm_pay(Holder::Player(ix), fee, "impound fee");
        let g = self.gun_mut(n);
        g.state = HELD;
        g.hold_until = 0;
        g.fee = 0;
        self.player_mut(ix).impounded.retain(|x| x.0 != n);
        let (me, callsign) = self.who(ix);
        let text = format!("{callsign} bought a {label} back from the Harbormaster for {fee}.");
        self.record(
            "buy_back",
            &me,
            Some(callsign),
            text,
            near_sdk::serde_json::json!({ "serial": serial, "cost": U128(fee) }),
        );
        BuyBackResult { weapon: self.weapon_of(n), cost: U128(fee) }
    }

    /// The Harbormaster, with its balance decayed to now.
    pub fn harbormaster(&self) -> HarbormasterView {
        self.hm_view(now_ms())
    }
}

#[near]
impl Saltline {
    /// The Harbormaster's own account puts its strength into `patrols` or `pursuit`.
    pub fn hm_posture(&mut self, posture: String, memo: String) -> HarbormasterView {
        self.guard();
        if env::predecessor_account_id() != self.hm.account_id {
            fail(err::NOT_HARBORMASTER, "Only the Harbormaster's own account can call this");
        }
        check_memo(&memo);
        let p = POSTURES
            .iter()
            .position(|x| *x == posture)
            .unwrap_or_else(|| fail(err::BAD_AMOUNT, "posture is 'patrols' or 'pursuit'"));
        self.hm.posture = p as u8;
        self.hm.last_memo = Some(memo.clone());
        let view = self.hm_view(now_ms());
        let text = if p as u8 == PURSUIT {
            format!("The Harbormaster turned to pursuit. The Bailiff is sent at {}.", view.bailiff_at.0)
        } else {
            format!("The Harbormaster turned to patrols: {} more Inspection Units on every raid.", view.bonus_drones)
        };
        let account = self.hm.account_id.clone();
        self.record(
            "posture",
            &account,
            None,
            text,
            near_sdk::serde_json::json!({
                "posture": posture, "strength": view.strength, "bonus_drones": view.bonus_drones,
                "bailiff_at": view.bailiff_at, "memo": memo
            }),
        );
        view
    }
}
