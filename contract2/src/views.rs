//! The read-only tables and boards (docs/CONTRACT_V2.md → Views). Views that belong to one part of the game live
//! with it: `vendors` in vendors.rs, `export_prices` in export.rs, `listings` in market.rs, `wrecks` and `raid` in
//! raids.rs, `harbormaster` in harbormaster.rs, the NEP-245 and NEP-171 views in mt.rs and nft.rs.

use std::collections::BTreeMap;

use near_sdk::json_types::U128;
use near_sdk::serde_json::{Value, json};
use near_sdk::{AccountId, near};

use crate::items::*;
use crate::nft::WeaponView;
use crate::{IMPOUNDED, ProfileView, Saltline, SaltlineExt, now_ms};

#[near(serializers = [json])]
pub struct MaterialView {
    pub id: String,
    pub name: String,
    pub weight: u32,
    pub bid: U128,
    pub export: U128,
    pub target: u32,
}

#[near(serializers = [json])]
pub struct FrameView {
    pub id: String,
    pub name: String,
    /// `{ damage: [lo, hi], … }`
    pub bands: BTreeMap<String, (u32, u32)>,
    pub base: U128,
}

#[near(serializers = [json])]
pub struct BlueprintView {
    pub id: String,
    pub kind: String,
    pub inputs: BTreeMap<String, U128>,
    pub fee: U128,
    pub yields: u32,
}

#[near(serializers = [json])]
pub struct ImpoundView {
    pub weapon: WeaponView,
    pub fee: U128,
    pub expires_at: u64,
}

#[near(serializers = [json])]
pub struct LedgerView {
    pub kind: String,
    pub at: u64,
    pub account: AccountId,
    pub callsign: Option<String>,
    pub text: String,
}

/// A scrip amount from items.rs as a JSON number (every one is far below 2⁵³).
fn n(amount: u128) -> u64 {
    amount as u64
}

#[near]
impl Saltline {
    /// `{ raid, invoice, harbormaster, market, condition, vendor_pricing }`: each the snake_case of the same-named
    /// constant in items.ts, every number a JSON number. `limits` is the contract's own: what items.ts doesn't hold.
    pub fn rules(&self) -> Value {
        json!({
            "raid": {
                "spot_count": SPOT_COUNT,
                "containers": CONTAINERS,
                "bonded": BONDED,
                "wrecks": WRECKS_PER_RAID,
                "carry_limit": CARRY_LIMIT,
                "gun_weight": GUN_WEIGHT,
                // The one fraction in items.ts (0.06). The contract never computes with it.
                "slow_per_weight": SLOW_PER_WEIGHT_PCT as f64 / 100.0,
                "min_seconds": MIN_SECONDS,
                "per_container_seconds": PER_CONTAINER_SECONDS,
                "seconds_between_raids": SECONDS_BETWEEN_RAIDS,
                "issued_mags": ISSUED_MAGS,
                "max_mags": MAX_MAGS,
                "max_charges": MAX_CHARGES,
                "max_plates": MAX_PLATES,
                "plate_health": PLATE_HEALTH,
                "max_kills": { "gull": MAX_KILLS_GULL, "hound": MAX_KILLS_HOUND },
                "max_uplinks": MAX_UPLINKS,
                "seconds_per_kill": SECONDS_PER_KILL,
                "wreck_hours": WRECK_HOURS,
                "impound_hours": IMPOUND_HOURS,
                "buy_back_pct": n(BUY_BACK_PCT),
                "starter_scrip": n(STARTER_SCRIP),
            },
            "invoice": {
                "entry": n(INVOICE_ENTRY),
                "per_extraction": n(INVOICE_PER_EXTRACTION),
                "max_extractions_counted": MAX_EXTRACTIONS_COUNTED,
                "per_minute": n(INVOICE_PER_MINUTE),
                "seal": n(INVOICE_SEAL),
                "per_weight": n(INVOICE_PER_WEIGHT),
                "uplink": n(INVOICE_UPLINK),
                "gull": n(INVOICE_GULL),
                "hound": n(INVOICE_HOUND),
                "second_notice": n(SECOND_NOTICE_AT),
                "bailiff": n(BAILIFF_AT),
                "second_bailiff": n(SECOND_BAILIFF_AT),
                "foreclosure": n(FORECLOSURE_AT),
                "arrears_on_extract": n(ARREARS_ON_EXTRACT_PCT),
                "arrears_on_death": n(ARREARS_ON_DEATH_PCT),
                "carry_in_pct": n(CARRY_IN_PCT),
                "carry_in_max": n(CARRY_IN_MAX),
                "settle_rate": n(SETTLE_RATE),
                "bonded_at": n(BONDED_AT),
            },
            "harbormaster": {
                "scrip_per_strength": n(SCRIP_PER_STRENGTH),
                "half_life_hours": HM_HALF_LIFE_HOURS,
                "strength_per_drone": STRENGTH_PER_DRONE,
                "bailiff_drop_per_strength": n(BAILIFF_DROP_PER_STRENGTH),
            },
            "market": {
                "fee_pct": n(MARKET_FEE_PCT),
                "maker_pct": n(MAKER_PCT),
                "max_listings": MAX_LISTINGS,
            },
            "condition": {
                "per_raid": CONDITION_PER_RAID,
                "recovered": CONDITION_RECOVERED,
                "worn": CONDITION_WORN,
                "scrip_per_point": n(REPAIR_SCRIP_PER_POINT),
                "points_per_copper": REPAIR_POINTS_PER_COPPER,
                "scrap": SCRAP.iter().map(|&(t, k)| (TOKENS[t].id.to_string(), n(k))).collect::<BTreeMap<_, _>>(),
            },
            "vendor_pricing": {
                "goods_pct": n(GOODS_PCT),
                "scarce_pct": n(SCARCE_PCT),
                "scarce_under": n(SCARCE_UNDER),
                "gun_pct": n(GUN_PCT),
                "float": n(VENDOR_FLOAT),
                "meds_half_life_hours": MEDS_HALF_LIFE_HOURS,
            },
            "limits": {
                "profiles": MAX_PROFILES,
                "guns": MAX_GUNS,
                "guns_per_owner": MAX_GUNS_PER_OWNER,
                "wrecks": MAX_WRECKS,
                "batch": n(MAX_BATCH),
                "max_price": n(MAX_PRICE),
                "raid_expiry_seconds": RAID_EXPIRY_SECONDS,
                "expiries_per_call": SWEEP_PER_CALL,
                "export_drop_pct_per_unit": n(EXPORT_DROP_PER_UNIT),
                "export_half_life_hours": EXPORT_HALF_LIFE_HOURS,
            },
        })
    }

    pub fn materials(&self) -> Vec<MaterialView> {
        MATERIALS
            .iter()
            .map(|&t| MaterialView {
                id: TOKENS[t].id.to_string(),
                name: TOKENS[t].name.to_string(),
                weight: TOKENS[t].weight,
                bid: U128(TOKENS[t].bid),
                export: U128(TOKENS[t].export),
                target: TOKENS[t].target,
            })
            .collect()
    }

    pub fn frames(&self) -> Vec<FrameView> {
        FRAMES
            .iter()
            .map(|f| FrameView {
                id: f.id.to_string(),
                name: f.name.to_string(),
                bands: (0..STAT_COUNT)
                    .map(|k| (STAT_KEYS[k].to_string(), (f.bands[k].0 as u32, f.bands[k].1 as u32)))
                    .collect(),
                base: U128(f.base),
            })
            .collect()
    }

    pub fn blueprints(&self) -> Vec<BlueprintView> {
        BLUEPRINTS
            .iter()
            .map(|b| BlueprintView {
                id: b.id.to_string(),
                kind: b.kind.to_string(),
                inputs: b.inputs.iter().map(|&(t, n)| (TOKENS[t].id.to_string(), U128(n))).collect(),
                fee: U128(b.fee),
                yields: b.yields,
            })
            .collect()
    }

    pub fn profile(&self, account_id: AccountId) -> Option<ProfileView> {
        self.player_ix.get(&account_id).map(|&ix| self.profile_of(ix, now_ms()))
    }

    /// Non-zero balances of any holder: a player, a vendor, the Harbormaster or the contract itself.
    pub fn balances(&self, account_id: AccountId) -> BTreeMap<String, U128> {
        let mut out = BTreeMap::new();
        if let Some(h) = self.holder_of(&account_id) {
            for (t, token) in TOKENS.iter().enumerate() {
                let n = self.shown_balance(h, t);
                if n > 0 {
                    out.insert(token.id.to_string(), U128(n));
                }
            }
        }
        out
    }

    /// Every gun the account owns, in any state.
    pub fn weapons(&self, account_id: AccountId) -> Vec<WeaponView> {
        self.holder_of(&account_id).map(|h| self.weapons_of(h)).unwrap_or_default()
    }

    pub fn weapon(&self, serial: String) -> Option<WeaponView> {
        let n = parse_serial(&serial).filter(|&n| serial_text(n) == serial)?;
        self.guns.get(&n).filter(|g| !self.gone(g, now_ms())).map(|g| self.weapon_view(g))
    }

    /// The account's guns in the impound, with what each costs to buy back and when it is destroyed.
    pub fn impound(&self, account_id: AccountId) -> Vec<ImpoundView> {
        let now = now_ms();
        let Some(&ix) = self.player_ix.get(&account_id) else { return vec![] };
        self.player(ix)
            .impounded
            .iter()
            .filter(|(_, until)| now < *until)
            .filter_map(|(n, _)| self.guns.get(n))
            .filter(|g| g.state == IMPOUNDED)
            .map(|g| ImpoundView { weapon: self.weapon_view(g), fee: U128(g.fee), expires_at: g.hold_until })
            .collect()
    }

    /// The last saltline events, newest first (at most 64 are kept).
    pub fn recent(&self, limit: u32) -> Vec<LedgerView> {
        let len = self.recent.len();
        let take = limit.min(len);
        let mut out = Vec::with_capacity(take as usize);
        if len == 0 {
            return out;
        }
        let mut i = (self.recent_next + len - 1) % len;
        for _ in 0..take {
            if let Some(e) = self.recent.get(i) {
                out.push(LedgerView {
                    kind: e.kind.clone(),
                    at: e.at,
                    account: e.account.clone(),
                    callsign: e.callsign.clone(),
                    text: e.text.clone(),
                });
            }
            i = (i + len - 1) % len;
        }
        out
    }
}
