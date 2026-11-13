//! The armoury (docs/CONTRACT_V2.md → Building; Fit, repair, scrap): `build`, `fit`, `repair`, `scrap`.
//!
//! - `build` burns the blueprint's inputs and fee from the caller. A weapon is rolled (`nft::mint_gun`); a mod or
//!   consumable is minted, `yields` units at a time.
//! - `fit` burns a mod token into the gun: one mod per slot, and it stays with the gun for good.
//! - `repair` costs 2 scrip per point, paid to Moss, and 1 copper per 20 points, rounded up, burned. It repairs to
//!   100, or by `points` (trimmed to what is missing). A gun at condition 0 can't be repaired, only scrapped.
//! - `scrap` burns the gun and mints 2 copper and 1 electronics.
//!
//! Fit, repair and scrap need the gun in its owner's hands (`held`).

use std::collections::BTreeMap;

use near_sdk::json_types::U128;
use near_sdk::near;

use crate::items::*;
use crate::mt::{self, BurnLog, MintLog, TransferLog};
use crate::nft::WeaponView;
use crate::{HELD, Holder, Saltline, SaltlineExt, err, fail};

#[near(serializers = [json])]
pub struct BuildResult {
    pub weapon: Option<WeaponView>,
    pub minted: BTreeMap<String, U128>,
}

#[near(serializers = [json])]
pub struct FitResult {
    pub weapon: WeaponView,
}

#[near(serializers = [json])]
pub struct RepairResult {
    pub weapon: WeaponView,
    pub cost: U128,
}

#[near(serializers = [json])]
pub struct ScrapResult {
    pub minted: BTreeMap<String, U128>,
}

#[near]
impl Saltline {
    /// Build from a blueprint: burn its inputs and fee, and make the thing. The caller is the maker.
    pub fn build(&mut self, blueprint: String) -> BuildResult {
        let ix = self.caller_player();
        let b = blueprint_index(&blueprint)
            .unwrap_or_else(|| fail(err::BAD_AMOUNT, format!("No blueprint called '{blueprint}'")));
        let bp = &BLUEPRINTS[b];
        let (me, callsign) = self.who(ix);
        let h = Holder::Player(ix);
        for &(t, n) in bp.inputs {
            let have = self.balance(h, t);
            if have < n {
                fail(err::FUNDS, format!("A {} takes {}; you have {have}", bp.id, count(t, n)));
            }
        }
        if self.balance(h, SCRIP) < bp.fee {
            fail(err::FUNDS, format!("The build fee is {} scrip", bp.fee));
        }
        let mut burned = BurnLog::new(&me, Some("built"));
        for &(t, n) in bp.inputs {
            self.burn(h, t, n);
            burned.push(t, n);
        }
        self.burn(h, SCRIP, bp.fee);
        burned.push(SCRIP, bp.fee);
        mt::emit_burn(vec![burned]);

        let mut minted = BTreeMap::new();
        let weapon = match bp.makes {
            Makes::Gun(frame) => {
                let n = self.mint_gun(h, frame, &me, &callsign, HELD);
                self.player_mut(ix).built += 1;
                let g = self.gun(n);
                let grade = GRADES[g.grade()].0;
                let text = format!("{callsign} built a {grade}-grade {}, {}.", FRAMES[frame].short, serial_text(n));
                let w = self.weapon_of(n);
                self.record(
                    "build",
                    &me,
                    Some(callsign),
                    text,
                    near_sdk::serde_json::json!({ "blueprint": bp.id, "serial": w.serial, "grade": w.grade, "quality": w.quality }),
                );
                Some(w)
            }
            Makes::Token(t) => {
                let n = bp.yields as u128;
                self.mint(h, t, n);
                mt::emit_mint(vec![MintLog::one(&me, t, n, Some("built"))]);
                minted.insert(TOKENS[t].id.to_string(), U128(n));
                let text = format!("{callsign} built {}.", count(t, n));
                self.record(
                    "build",
                    &me,
                    Some(callsign),
                    text,
                    near_sdk::serde_json::json!({ "blueprint": bp.id, "minted": minted }),
                );
                None
            }
        };
        BuildResult { weapon, minted }
    }

    /// Fit a mod: the token is burned into the gun. One mod per slot.
    pub fn fit(&mut self, serial: String, r#mod: String) -> FitResult {
        let ix = self.caller_player();
        let n = self.own_held(ix, &serial);
        let t = token_index(&r#mod)
            .filter(|&t| is_mod(t))
            .unwrap_or_else(|| fail(err::BAD_AMOUNT, format!("'{}' isn't a mod", r#mod)));
        if self.gun(n).mods & mod_bit(t) != 0 {
            fail(err::SLOT_TAKEN, format!("{serial} already has {} fitted", TOKENS[t].name.to_lowercase()));
        }
        let (me, callsign) = self.who(ix);
        if self.balance(Holder::Player(ix), t) == 0 {
            fail(err::FUNDS, format!("You have no {}", TOKENS[t].name.to_lowercase()));
        }
        self.burn(Holder::Player(ix), t, 1);
        mt::emit_burn(vec![BurnLog::one(&me, t, 1, Some("fitted"))]);
        self.gun_mut(n).mods |= mod_bit(t);
        let text = format!("{callsign} fitted {} to {serial}.", TOKENS[t].name.to_lowercase());
        self.record(
            "fit",
            &me,
            Some(callsign),
            text,
            near_sdk::serde_json::json!({ "serial": serial, "mod": TOKENS[t].id }),
        );
        FitResult { weapon: self.weapon_of(n) }
    }

    /// Repair to 100, or by `points`. The scrip goes to Moss; the copper is used up.
    pub fn repair(&mut self, serial: String, points: Option<u32>) -> RepairResult {
        let ix = self.caller_player();
        let n = self.own_held(ix, &serial);
        let condition = self.gun(n).condition as u32;
        if condition == 0 {
            fail(err::WORN_OUT, format!("{serial} is worn out. It can only be scrapped"));
        }
        let room = CONDITION_NEW as u32 - condition;
        // More points than are missing are trimmed to what is missing.
        let points = points.unwrap_or(room).min(room);
        if points == 0 {
            fail(err::BAD_AMOUNT, format!("{serial} is at {condition}: nothing to repair"));
        }
        let cost = points as u128 * REPAIR_SCRIP_PER_POINT;
        let copper = points.div_ceil(REPAIR_POINTS_PER_COPPER) as u128;
        let h = Holder::Player(ix);
        if self.balance(h, SCRIP) < cost || self.balance(h, COPPER) < copper {
            fail(err::FUNDS, format!("{points} points cost {cost} scrip and {}", count(COPPER, copper)));
        }
        let (me, callsign) = self.who(ix);
        let moss = self.vendors[MOSS].account_id.clone();
        self.move_tokens(h, Holder::Vendor(MOSS), SCRIP, cost);
        self.burn(h, COPPER, copper);
        mt::emit_transfer(vec![TransferLog::one(&me, &moss, SCRIP, cost, Some("repair"))]);
        mt::emit_burn(vec![BurnLog::one(&me, COPPER, copper, Some("repair"))]);
        self.gun_mut(n).condition = (condition + points) as u8;
        let text = format!("Moss brought {callsign}'s {serial} up to {} for {cost}.", condition + points);
        self.record(
            "repair",
            &me,
            Some(callsign),
            text,
            near_sdk::serde_json::json!({ "serial": serial, "points": points, "cost": U128(cost), "copper": U128(copper) }),
        );
        RepairResult { weapon: self.weapon_of(n), cost: U128(cost) }
    }

    /// Break a gun down for parts. It is gone for good.
    pub fn scrap(&mut self, serial: String) -> ScrapResult {
        let ix = self.caller_player();
        let n = self.own_held(ix, &serial);
        let (me, callsign) = self.who(ix);
        let label = self.gun(n).label();
        self.burn_gun(n, "scrapped");
        let mut minted = BTreeMap::new();
        let mut log = MintLog::new(&me, Some("scrap"));
        for (t, k) in SCRAP {
            self.mint(Holder::Player(ix), t, k);
            log.push(t, k);
            minted.insert(TOKENS[t].id.to_string(), U128(k));
        }
        mt::emit_mint(vec![log]);
        let text = format!("{callsign} scrapped a {label}.");
        self.record(
            "scrap",
            &me,
            Some(callsign),
            text,
            near_sdk::serde_json::json!({ "serial": serial, "minted": minted }),
        );
        ScrapResult { minted }
    }
}
