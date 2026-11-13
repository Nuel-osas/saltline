//! The vendors (docs/CONTRACT_V2.md → Vendors): Moss the armourer and Ines the quartermaster. Each is a NEAR
//! account with its own scrip and stock, and each can run out of money.
//!
//! - `sell`: a player sells a material to a vendor that buys it. The vendor pays its bid per unit, priced one unit
//!   at a time as its stock rises (`items::bid`). A sale that would take its scrip under 100 is refused
//!   (`E_VENDOR_BROKE`).
//! - `buy`: a player buys mods or consumables the vendor holds, at the vendor's own price if it set one, otherwise
//!   the default (`items::good_price`), one unit at a time as the shelf empties.
//! - `buy_gun`: a player buys a gun off the vendor's rack, at the vendor's price or 125% of its appraisal.
//!
//! Each vendor's own account (its agent) makes two more calls:
//! - `vendor_build`: build from its own stock what `items::VENDORS` lists for it. No fee. A gun goes on its rack
//!   with the vendor as maker; goods go on its shelf.
//! - `vendor_price`: set its own flat price for a gun on its rack or for a good it sells, in place of the default.
//!   It can't set what it pays for materials: the bid curve is the contract's.
//!
//! Every price is a pure function in items.rs of state anyone can read; the `vendors` view shows the same numbers
//! with the reason for each.
//!
//! **Ines's meds go to the clinic.** Her meds stock halves every 12 hours, so her bid for them recovers by itself.
//! It is kept the way the Harbormaster's wallet is (harbormaster.rs): in millionths of a unit with the time it was
//! last brought up to date, decayed lazily. Views show it decayed to now; a sale or an export of her meds first
//! burns what the clinic has used since.

use std::collections::BTreeMap;

use near_sdk::json_types::U128;
use near_sdk::{AccountId, env, near};

use crate::items::*;
use crate::mt::{self, BurnLog, MintLog, TransferLog};
use crate::nft::{WeaponView, on_rack};
use crate::weapons::BuildResult;
use crate::{AT_VENDOR, Empty, HELD, Holder, Saltline, SaltlineExt, amount_in, check_memo, err, fail, now_ms};

#[near(serializers = [json])]
pub struct Quote {
    pub token_id: String,
    pub price: U128,
    pub reason: String,
}

#[near(serializers = [json])]
pub struct GoodView {
    pub token_id: String,
    pub price: U128,
    pub stock: U128,
    pub reason: String,
}

#[near(serializers = [json])]
pub struct RackView {
    pub weapon: WeaponView,
    pub price: U128,
}

#[near(serializers = [json])]
pub struct VendorView {
    pub id: String,
    pub account_id: AccountId,
    pub name: String,
    pub open: bool,
    pub scrip: U128,
    pub stock: BTreeMap<String, U128>,
    pub bids: Vec<Quote>,
    pub goods: Vec<GoodView>,
    pub guns: Vec<RackView>,
    pub last_memo: Option<String>,
}

#[near(serializers = [json])]
pub struct Paid {
    pub paid: U128,
}

#[near(serializers = [json])]
pub struct Cost {
    pub cost: U128,
}

#[near(serializers = [json])]
pub struct BuyGunResult {
    pub weapon: WeaponView,
    pub cost: U128,
}

/// A vendor can pay `paid` only if it keeps its float afterwards.
pub fn can_cover(scrip: u128, paid: u128) -> bool {
    scrip >= paid.saturating_add(VENDOR_FLOAT)
}

fn bid_reason(t: usize, stock: u128, price: u128) -> String {
    let target = TOKENS[t].target as u128;
    let shelf = if stock == 0 {
        "None on the shelf.".to_string()
    } else if stock < target {
        format!("Short: {stock} against a target of {target}.")
    } else if stock == target {
        format!("Holding {stock}, right on target.")
    } else {
        format!("Sitting on {stock} against a target of {target}.")
    };
    let paying = match price.saturating_mul(100) / TOKENS[t].bid.max(1) {
        190.. => "Paying double.",
        140..=189 => "Paying half again.",
        110..=139 => "Paying over base.",
        91..=109 => "Paying base.",
        70..=90 => "Paying under base.",
        42..=69 => "Paying about half.",
        _ => "Paying scrap rates.",
    };
    format!("{shelf} {paying}")
}

impl Saltline {
    fn vendor_from_id(id: &str) -> usize {
        vendor_index(id).unwrap_or_else(|| fail(err::NOT_VENDOR, format!("No vendor called '{id}'")))
    }

    /// Ines's meds, decayed to `now`.
    pub(crate) fn ines_meds(&self, now: u64) -> u128 {
        halve(self.clinic.0, now.saturating_sub(self.clinic.1), MEDS_HALF_LIFE_HOURS * HOUR_MS) / MICRO
    }

    /// What a vendor holds of a token at `now`: its ledger balance, or for Ines's meds what the clinic has left.
    pub(crate) fn stock_of(&self, v: usize, t: usize, now: u64) -> u128 {
        if v == INES && t == MEDS { self.ines_meds(now) } else { self.vendors[v].bal[t] }
    }

    /// Bring Ines's meds up to `now`: burn what the clinic used since they were last touched.
    pub(crate) fn meds_decay(&mut self, now: u64) {
        let micro = halve(self.clinic.0, now.saturating_sub(self.clinic.1), MEDS_HALF_LIFE_HOURS * HOUR_MS);
        let used = self.vendors[INES].bal[MEDS].saturating_sub(micro / MICRO);
        if used > 0 {
            self.burn(Holder::Vendor(INES), MEDS, used);
            mt::emit_burn(vec![BurnLog::one(&self.vendors[INES].account_id, MEDS, used, Some("used by the clinic"))]);
        }
        self.clinic = (micro, now);
    }

    /// Ines's meds changed by a sale (`added`) or an export: keep the fine-grained count in step with the ledger.
    pub(crate) fn meds_moved(&mut self, n: u128, added: bool) {
        let d = n.saturating_mul(MICRO);
        self.clinic.0 = if added { self.clinic.0.saturating_add(d) } else { self.clinic.0.saturating_sub(d) };
    }

    /// What `n` units of a good cost at this vendor now: its own price for each, or the default curve.
    pub(crate) fn goods_cost_at(&self, v: usize, t: usize, n: u128) -> u128 {
        let stock = self.vendors[v].bal[t];
        match (self.vendors[v].price[t], blueprint_for(t)) {
            (Some(p), _) => p.saturating_mul(n),
            (None, Some(b)) => goods_cost(b, stock, n),
            (None, None) => u128::MAX,
        }
    }

    /// A vendor's price for a gun on its rack: its own, or 125% of the appraisal.
    pub(crate) fn rack_price(&self, n: u32) -> u128 {
        let g = self.gun(n);
        g.ask.unwrap_or_else(|| gun_price(g.value()))
    }

    fn vendor_view(&self, v: usize) -> VendorView {
        let info = &VENDORS[v];
        let vendor = &self.vendors[v];
        let scrip = vendor.bal[SCRIP];
        let now = now_ms();
        let mut stock = BTreeMap::new();
        for &t in MATERIALS.iter() {
            let held = self.stock_of(v, t, now);
            if info.buys.contains(&t) || held > 0 {
                stock.insert(TOKENS[t].id.to_string(), U128(held));
            }
        }
        let bids: Vec<Quote> = info
            .buys
            .iter()
            .map(|&t| {
                let held = self.stock_of(v, t, now);
                let price = bid(t, held);
                let reason = if can_cover(scrip, price) {
                    bid_reason(t, held, price)
                } else {
                    format!("Can't pay {price} and keep the {VENDOR_FLOAT} float. Buy something first.")
                };
                Quote { token_id: TOKENS[t].id.to_string(), price: U128(price), reason }
            })
            .collect();
        let open = info.buys.iter().any(|&t| can_cover(scrip, bid(t, self.stock_of(v, t, now))));
        let goods = info
            .builds
            .iter()
            .filter_map(|&b| match BLUEPRINTS[b].makes {
                Makes::Token(t) => Some(t),
                Makes::Gun(_) => None,
            })
            .map(|t| {
                let held = vendor.bal[t];
                let reason = if held == 0 {
                    "None left.".to_string()
                } else if vendor.price[t].is_some() {
                    format!("{held} on the shelf. {}'s own price.", info.name)
                } else if held < SCARCE_UNDER {
                    format!("Only {held} left: priced up.")
                } else {
                    format!("{held} on the shelf. List price.")
                };
                GoodView {
                    token_id: TOKENS[t].id.to_string(),
                    price: U128(self.goods_cost_at(v, t, 1)),
                    stock: U128(held),
                    reason,
                }
            })
            .collect();
        let guns = vendor
            .guns
            .iter()
            .filter_map(|n| self.guns.get(n))
            .filter(|g| on_rack(g))
            .map(|g| RackView { weapon: self.weapon_view(g), price: U128(self.rack_price(g.serial)) })
            .collect();
        VendorView {
            id: info.id.to_string(),
            account_id: vendor.account_id.clone(),
            name: info.name.to_string(),
            open,
            scrip: U128(scrip),
            stock,
            bids,
            goods,
            guns,
            last_memo: vendor.last_memo.clone(),
        }
    }
}

#[near]
impl Saltline {
    /// Sell a material to a vendor at its bid, priced unit by unit. Refused whole if the vendor can't cover it.
    pub fn sell(&mut self, vendor: String, token_id: String, amount: U128) -> Paid {
        let ix = self.caller_player();
        let v = Self::vendor_from_id(&vendor);
        let name = VENDORS[v].name;
        let t = token_index(&token_id)
            .filter(|t| VENDORS[v].buys.contains(t))
            .unwrap_or_else(|| fail(err::DOESNT_BUY, format!("{name} doesn't buy {token_id}")));
        let n = amount_in(amount, MAX_BATCH);
        let h = Holder::Player(ix);
        if self.balance(h, t) < n {
            fail(err::FUNDS, format!("You don't have {}", count(t, n)));
        }
        let now = now_ms();
        let paid = sale_value(t, self.stock_of(v, t, now), n);
        if !can_cover(self.vendors[v].bal[SCRIP], paid) {
            fail(err::VENDOR_BROKE, format!("{name} can't pay {paid} and keep the {VENDOR_FLOAT} float"));
        }
        if v == INES && t == MEDS {
            self.meds_decay(now);
            self.meds_moved(n, true);
        }
        self.move_tokens(h, Holder::Vendor(v), t, n);
        self.move_tokens(Holder::Vendor(v), h, SCRIP, paid);
        let (me, callsign) = self.who(ix);
        let vendor_id = self.vendors[v].account_id.clone();
        mt::emit_transfer(vec![
            TransferLog::one(&me, &vendor_id, t, n, Some("sale")),
            TransferLog::one(&vendor_id, &me, SCRIP, paid, Some("sale")),
        ]);
        let text = format!("{callsign} sold {} to {name} for {paid}.", count(t, n));
        self.record(
            "sale",
            &me,
            Some(callsign),
            text,
            near_sdk::serde_json::json!({ "vendor": VENDORS[v].id, "token_id": TOKENS[t].id, "amount": U128(n), "paid": U128(paid) }),
        );
        Paid { paid: U128(paid) }
    }

    /// Buy mods or consumables a vendor holds, at its price.
    pub fn buy(&mut self, vendor: String, token_id: String, amount: U128) -> Cost {
        let ix = self.caller_player();
        let v = Self::vendor_from_id(&vendor);
        let name = VENDORS[v].name;
        let t = token_index(&token_id)
            .filter(|&t| blueprint_for(t).is_some_and(|b| VENDORS[v].builds.contains(&b)))
            .unwrap_or_else(|| fail(err::DOESNT_SELL, format!("{name} doesn't sell {token_id}")));
        let n = amount_in(amount, MAX_BATCH);
        let held = self.vendors[v].bal[t];
        if held < n {
            fail(err::NO_STOCK, format!("{name} has {} left", count(t, held)));
        }
        let cost = self.goods_cost_at(v, t, n);
        let h = Holder::Player(ix);
        if self.balance(h, SCRIP) < cost {
            fail(err::FUNDS, format!("{} costs {cost} scrip", count(t, n)));
        }
        self.move_tokens(h, Holder::Vendor(v), SCRIP, cost);
        self.move_tokens(Holder::Vendor(v), h, t, n);
        let (me, callsign) = self.who(ix);
        let vendor_id = self.vendors[v].account_id.clone();
        mt::emit_transfer(vec![
            TransferLog::one(&me, &vendor_id, SCRIP, cost, Some("purchase")),
            TransferLog::one(&vendor_id, &me, t, n, Some("purchase")),
        ]);
        let text = format!("{callsign} bought {} from {name} for {cost}.", count(t, n));
        self.record(
            "purchase",
            &me,
            Some(callsign),
            text,
            near_sdk::serde_json::json!({ "vendor": VENDORS[v].id, "token_id": TOKENS[t].id, "amount": U128(n), "cost": U128(cost) }),
        );
        Cost { cost: U128(cost) }
    }

    /// Buy a gun off a vendor's rack.
    pub fn buy_gun(&mut self, vendor: String, serial: String) -> BuyGunResult {
        let ix = self.caller_player();
        let v = Self::vendor_from_id(&vendor);
        let name = VENDORS[v].name;
        let n = self.find_gun(&serial);
        let g = self.gun(n);
        if g.owner != self.vendors[v].account_id || !on_rack(g) {
            fail(err::DOESNT_SELL, format!("{serial} isn't on {name}'s rack"));
        }
        let label = g.label();
        let cost = self.rack_price(n);
        let h = Holder::Player(ix);
        if self.balance(h, SCRIP) < cost {
            fail(err::FUNDS, format!("{name} wants {cost} scrip for {serial}"));
        }
        self.room_for_gun(h);
        self.move_tokens(h, Holder::Vendor(v), SCRIP, cost);
        self.give_gun(n, h, "bought from a vendor");
        self.gun_mut(n).state = HELD;
        let (me, callsign) = self.who(ix);
        let vendor_id = self.vendors[v].account_id.clone();
        mt::emit_transfer(vec![TransferLog::one(&me, &vendor_id, SCRIP, cost, Some("purchase"))]);
        let text = format!("{callsign} bought a {label} from {name} for {cost}.");
        self.record(
            "purchase",
            &me,
            Some(callsign),
            text,
            near_sdk::serde_json::json!({ "vendor": VENDORS[v].id, "serial": serial, "cost": U128(cost) }),
        );
        BuyGunResult { weapon: self.weapon_of(n), cost: U128(cost) }
    }

    /// Both stalls: scrip, stock, what each pays and charges, and why.
    pub fn vendors(&self) -> Vec<VendorView> {
        (0..VENDOR_COUNT).map(|v| self.vendor_view(v)).collect()
    }
}

// -----------------------------------------------------------------------------------------------------------------
// The vendors' own calls
// -----------------------------------------------------------------------------------------------------------------

impl Saltline {
    /// The calling vendor, or E_NOT_VENDOR.
    fn caller_vendor(&self) -> usize {
        self.guard();
        let me = env::predecessor_account_id();
        self.vendors
            .iter()
            .position(|v| v.account_id == me)
            .unwrap_or_else(|| fail(err::NOT_VENDOR, "Only a vendor's own account can call this"))
    }
}

#[near]
impl Saltline {
    /// A vendor builds from its own stock: the blueprint's inputs are burned, no fee is paid, and the vendor is
    /// the maker. Only what `items::VENDORS` lists for it.
    pub fn vendor_build(&mut self, blueprint: String, memo: String) -> BuildResult {
        let v = self.caller_vendor();
        check_memo(&memo);
        let info = &VENDORS[v];
        let b = blueprint_index(&blueprint)
            .filter(|b| info.builds.contains(b))
            .unwrap_or_else(|| fail(err::DOESNT_SELL, format!("{} doesn't make '{blueprint}'", info.name)));
        let bp = &BLUEPRINTS[b];
        let h = Holder::Vendor(v);
        let now = now_ms();
        for &(t, n) in bp.inputs {
            // `stock_of`, not the ledger: Ines's meds are what the clinic has left. No blueprint takes meds today.
            let have = self.stock_of(v, t, now);
            if have < n {
                fail(
                    err::NO_STOCK,
                    format!("{} is short of {}: a {} takes {n}, {have} in stock", info.name, TOKENS[t].id, bp.id),
                );
            }
        }
        let vendor_id = self.vendors[v].account_id.clone();
        let mut burned = BurnLog::new(&vendor_id, Some("built"));
        for &(t, n) in bp.inputs {
            if v == INES && t == MEDS {
                self.meds_decay(now);
                self.meds_moved(n, false);
            }
            self.burn(h, t, n);
            burned.push(t, n);
        }
        mt::emit_burn(vec![burned]);

        let mut minted = BTreeMap::new();
        let (weapon, text) = match bp.makes {
            Makes::Gun(frame) => {
                let n = self.mint_gun(h, frame, &vendor_id, info.callsign, AT_VENDOR);
                let w = self.weapon_of(n);
                let text = format!("{} built a {}-grade {}, {}.", info.name, w.grade, FRAMES[frame].short, w.serial);
                (Some(w), text)
            }
            Makes::Token(t) => {
                let n = bp.yields as u128;
                self.mint(h, t, n);
                mt::emit_mint(vec![MintLog::one(&vendor_id, t, n, Some("built"))]);
                minted.insert(TOKENS[t].id.to_string(), U128(n));
                (None, format!("{} built {}.", info.name, count(t, n)))
            }
        };
        self.vendors[v].last_memo = Some(memo.clone());
        self.record(
            "vendor_build",
            &vendor_id,
            None,
            text,
            near_sdk::serde_json::json!({
                "vendor": info.id, "blueprint": bp.id, "serial": weapon.as_ref().map(|w| w.serial.clone()),
                "minted": minted, "memo": memo
            }),
        );
        BuildResult { weapon, minted }
    }

    /// A vendor sets its own flat price: for a gun on its rack (`serial`) or for a good it sells (`token_id`).
    pub fn vendor_price(
        &mut self,
        serial: Option<String>,
        token_id: Option<String>,
        price: U128,
        memo: String,
    ) -> Empty {
        let v = self.caller_vendor();
        check_memo(&memo);
        let price = amount_in(price, MAX_PRICE);
        let info = &VENDORS[v];
        let vendor_id = self.vendors[v].account_id.clone();
        let text = match (&serial, &token_id) {
            (Some(serial), None) => {
                let n = self.find_gun(serial);
                let g = self.gun(n);
                if g.owner != vendor_id || !on_rack(g) {
                    fail(err::DOESNT_SELL, format!("{serial} isn't on {}'s rack", info.name));
                }
                let label = g.label();
                self.gun_mut(n).ask = Some(price);
                format!("{} priced a {label} at {price}.", info.name)
            }
            (None, Some(token)) => {
                let t = token_index(token)
                    .filter(|&t| blueprint_for(t).is_some_and(|b| info.builds.contains(&b)))
                    .unwrap_or_else(|| fail(err::DOESNT_SELL, format!("{} doesn't sell {token}", info.name)));
                self.vendors[v].price[t] = Some(price);
                format!("{} priced {} at {price} each.", info.name, TOKENS[t].id)
            }
            _ => fail(err::BAD_AMOUNT, "Give a serial or a token_id, one of the two"),
        };
        self.vendors[v].last_memo = Some(memo.clone());
        self.record(
            "vendor_price",
            &vendor_id,
            None,
            text,
            near_sdk::serde_json::json!({
                "vendor": info.id, "serial": serial, "token_id": token_id, "price": U128(price), "memo": memo
            }),
        );
        Empty {}
    }
}
