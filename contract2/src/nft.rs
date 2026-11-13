//! Guns as NEP-171 tokens (token id = serial), and their custody.
//!
//! Written by hand, as contract/src/mt.rs was for NEP-245: a gun's owner, state and history live in one record
//! that raids, wrecks, the impound, vendors and the market all move in a single step, and
//! near-contract-standards' NonFungibleToken keeps its own owner maps that would have to be kept in step with it.
//!
//! - core: `nft_transfer`, `nft_token`;
//! - enumeration: `nft_total_supply`, `nft_tokens`, `nft_tokens_for_owner`, `nft_supply_for_owner`;
//! - metadata (NEP-177): `nft_metadata`, and each token's `metadata` with its picture drawn by the contract;
//! - payout (NEP-199): `nft_payout`, so an outside marketplace can pay the maker's 2%;
//! - the NEP-297 `nep171` events `nft_mint`, `nft_transfer` and `nft_burn`, version 1.0.0.
//!
//! What is left out, and why:
//! - approvals and `nft_transfer_call` (CONTRACT_V2.md → NEP-171). Passing an approval is refused, not ignored.
//! - `owner_id` is always the account the gun belongs to, whatever its state. A gun in a raid, on the market, in
//!   a wreck or in the impound is locked (`E_WEAPON_BUSY`), not moved to the contract's name, so a wallet keeps
//!   showing it and no transfer event is logged for a lock.
//! - Receivers are registered players with room in their locker: the contract pays for storage.

use std::collections::BTreeMap;

use near_sdk::base64::Engine;
use near_sdk::json_types::U128;
use near_sdk::{AccountId, NearToken, env, near};

use crate::items::*;
use crate::{
    AT_VENDOR, Gun, HELD, Holder, IMPOUNDED, IN_RAID, IN_WRECK, STATES, Saltline, SaltlineExt, check_memo, err, fail,
    now_ms, raids,
};

fn emit(event: &str, data: near_sdk::serde_json::Value) {
    let ev = near_sdk::serde_json::json!({ "standard": "nep171", "version": "1.0.0", "event": event, "data": [data] });
    env::log_str(&format!("EVENT_JSON:{ev}"));
}

#[near(serializers = [json])]
#[derive(Clone)]
pub struct StatsView {
    pub damage: u32,
    pub rpm: u32,
    pub mag: u32,
    pub recoil: u32,
    pub reload: u32,
    pub range: u32,
}

#[near(serializers = [json])]
#[derive(Clone)]
pub struct WeaponView {
    pub serial: String,
    pub frame: String,
    pub grade: String,
    pub quality: u32,
    pub stats: StatsView,
    pub mods: Vec<String>,
    pub condition: u32,
    pub maker: AccountId,
    pub maker_callsign: String,
    pub owner: AccountId,
    pub built_at: u64,
    pub raids: u32,
    pub extractions: u32,
    pub owners: u32,
    pub recovered: u32,
    pub state: String,
    pub value: U128,
}

/// NEP-177 token metadata. `media` is an SVG data URI drawn from the gun's record at the time it is read
/// (`drawing`); nothing is stored for it. `extra` is the Weapon as JSON.
#[near(serializers = [json])]
pub struct TokenMetadata {
    pub title: Option<String>,
    pub description: Option<String>,
    pub media: Option<String>,
    pub media_hash: Option<String>,
    pub copies: Option<u64>,
    pub issued_at: Option<String>,
    pub expires_at: Option<String>,
    pub starts_at: Option<String>,
    pub updated_at: Option<String>,
    pub extra: Option<String>,
    pub reference: Option<String>,
    pub reference_hash: Option<String>,
}

#[near(serializers = [json])]
pub struct NftToken {
    pub token_id: String,
    pub owner_id: AccountId,
    pub metadata: Option<TokenMetadata>,
}

impl Gun {
    pub(crate) fn quality(&self) -> u32 {
        quality(self.frame as usize, &self.stats)
    }
    pub(crate) fn grade(&self) -> usize {
        grade_of(self.quality())
    }
    /// The contract's appraisal, from frame, grade and condition.
    pub(crate) fn value(&self) -> u128 {
        appraise(self.frame as usize, self.grade(), self.condition as u32)
    }
    /// "B-grade Pilot S-000041", for the ledger's sentences.
    pub(crate) fn label(&self) -> String {
        format!("{}-grade {} {}", GRADES[self.grade()].0, FRAMES[self.frame as usize].short, serial_text(self.serial))
    }
}

impl Saltline {
    pub(crate) fn gun(&self, n: u32) -> &Gun {
        self.guns.get(&n).unwrap_or_else(|| fail(err::NO_WEAPON, format!("No gun {}", serial_text(n))))
    }

    pub(crate) fn gun_mut(&mut self, n: u32) -> &mut Gun {
        self.guns.get_mut(&n).unwrap_or_else(|| fail(err::NO_WEAPON, format!("No gun {}", serial_text(n))))
    }

    /// Destroyed in all but storage: its impound lapsed, or its wreck is past 24 hours and in nobody's manifest.
    /// The next sweep burns it; until then every view and call treats it as gone.
    pub(crate) fn gone(&self, g: &Gun, now: u64) -> bool {
        match g.state {
            IMPOUNDED => now >= g.hold_until,
            IN_WRECK => self.wrecks.iter().find(|w| w.gun == Some(g.serial)).is_none_or(|w| w.dead(now)),
            _ => false,
        }
    }

    /// The gun with this serial, or E_NO_WEAPON.
    pub(crate) fn find_gun(&self, serial: &str) -> u32 {
        parse_serial(serial)
            .filter(|&n| serial_text(n) == serial)
            .filter(|n| self.guns.get(n).is_some_and(|g| !self.gone(g, now_ms())))
            .unwrap_or_else(|| fail(err::NO_WEAPON, format!("No gun {serial}")))
    }

    /// A gun the player owns and has in hand: E_NO_WEAPON, E_NOT_OWNER or E_WEAPON_BUSY otherwise.
    pub(crate) fn own_held(&self, ix: u32, serial: &str) -> u32 {
        let n = self.find_gun(serial);
        let g = self.gun(n);
        if g.owner != self.player(ix).account_id {
            fail(err::NOT_OWNER, format!("{serial} isn't yours"));
        }
        if g.state != HELD {
            let wher = match g.state {
                IN_RAID => "out on a raid",
                crate::LISTED => "on the market",
                IN_WRECK => "in a wreck",
                IMPOUNDED => "in the impound",
                _ => "not in your locker",
            };
            fail(err::WEAPON_BUSY, format!("{serial} is {wher}"));
        }
        n
    }

    fn guns_of_mut(&mut self, h: Holder) -> &mut Vec<u32> {
        match h {
            Holder::Player(ix) => &mut self.player_mut(ix).guns,
            Holder::Vendor(v) => &mut self.vendors[v].guns,
            _ => env::panic_str("only players and vendors own guns"),
        }
    }

    pub(crate) fn guns_of(&self, h: Holder) -> &[u32] {
        match h {
            Holder::Player(ix) => &self.player(ix).guns,
            Holder::Vendor(v) => &self.vendors[v].guns,
            _ => &[],
        }
    }

    /// E_FULL unless the holder's locker has room for one more gun.
    pub(crate) fn room_for_gun(&self, h: Holder) {
        if self.guns_of(h).len() >= MAX_GUNS_PER_OWNER {
            fail(err::FULL, format!("That locker is full: {MAX_GUNS_PER_OWNER} guns"));
        }
    }

    /// Build a gun: the next serial, a roll inside the frame's bands from the block's random seed mixed with the
    /// serial, condition 100. The only place a gun is created; `build` and `new` are its only callers.
    pub(crate) fn mint_gun(
        &mut self,
        owner: Holder,
        frame: usize,
        maker: &AccountId,
        maker_callsign: &str,
        state: u8,
    ) -> u32 {
        if self.guns.len() >= MAX_GUNS {
            fail(err::FULL, format!("The armoury is full: {MAX_GUNS} guns exist"));
        }
        self.room_for_gun(owner);
        let serial = self.next_serial;
        self.next_serial += 1;
        let mut seed = env::random_seed_array().to_vec();
        seed.extend_from_slice(&serial.to_le_bytes());
        seed.extend_from_slice(b"gun");
        let stats = roll_stats(&mut Rng::from_bytes(&env::sha256_array(&seed)), frame);
        let owner_id = self.account_of(owner);
        self.guns.insert(
            serial,
            Gun {
                serial,
                frame: frame as u8,
                stats,
                mods: 0,
                condition: CONDITION_NEW,
                maker: maker.clone(),
                maker_callsign: maker_callsign.to_string(),
                owner: owner_id.clone(),
                built_at: now_ms(),
                raids: 0,
                extractions: 0,
                owners: 1,
                recovered: 0,
                state,
                hold_until: 0,
                fee: 0,
                ask: None,
            },
        );
        self.guns_of_mut(owner).push(serial);
        self.guns_built += 1;
        emit("nft_mint", near_sdk::serde_json::json!({ "owner_id": owner_id, "token_ids": [serial_text(serial)] }));
        serial
    }

    /// Destroy a gun for good.
    pub(crate) fn burn_gun(&mut self, n: u32, memo: &str) {
        let Some(g) = self.guns.remove(&n) else { return };
        if let Some(h) = self.holder_of(&g.owner) {
            self.guns_of_mut(h).retain(|&s| s != n);
            if let Holder::Player(ix) = h {
                self.player_mut(ix).impounded.retain(|x| x.0 != n);
            }
        }
        self.guns_destroyed += 1;
        emit(
            "nft_burn",
            near_sdk::serde_json::json!({ "owner_id": g.owner, "token_ids": [serial_text(n)], "memo": memo }),
        );
    }

    /// Hand a gun to a new owner (`owners` + 1). The caller checks the new owner has room and sets the state.
    pub(crate) fn give_gun(&mut self, n: u32, to: Holder, memo: &str) {
        let old = self.gun(n).owner.clone();
        if let Some(from) = self.holder_of(&old) {
            self.guns_of_mut(from).retain(|&s| s != n);
        }
        let new = self.account_of(to);
        self.guns_of_mut(to).push(n);
        let g = self.gun_mut(n);
        g.owner = new.clone();
        g.owners += 1;
        g.ask = None;
        emit(
            "nft_transfer",
            near_sdk::serde_json::json!({
                "old_owner_id": old, "new_owner_id": new, "token_ids": [serial_text(n)], "memo": memo
            }),
        );
    }

    /// The state the views show. A gun still marked as on a raid that has closed or timed out is back in its
    /// owner's hands: their next call of any kind unlocks it before doing anything else.
    fn shown_state(&self, g: &Gun, now: u64) -> u8 {
        if g.state != IN_RAID {
            return g.state;
        }
        let live = self
            .player_ix
            .get(&g.owner)
            .and_then(|&ix| self.player(ix).active_raid)
            .and_then(|id| self.raids.get(&id))
            .is_some_and(|r| r.gun == Some(g.serial) && !raids::expired(r, now));
        if live { IN_RAID } else { HELD }
    }

    pub(crate) fn weapon_view(&self, g: &Gun) -> WeaponView {
        let q = g.quality();
        let grade = grade_of(q);
        WeaponView {
            serial: serial_text(g.serial),
            frame: FRAMES[g.frame as usize].id.to_string(),
            grade: GRADES[grade].0.to_string(),
            quality: q,
            stats: StatsView {
                damage: g.stats[0] as u32,
                rpm: g.stats[1] as u32,
                mag: g.stats[2] as u32,
                recoil: g.stats[3] as u32,
                reload: g.stats[4] as u32,
                range: g.stats[5] as u32,
            },
            mods: MODS.iter().filter(|&&m| g.mods & mod_bit(m) != 0).map(|&m| TOKENS[m].id.to_string()).collect(),
            condition: g.condition as u32,
            maker: g.maker.clone(),
            maker_callsign: g.maker_callsign.clone(),
            owner: g.owner.clone(),
            built_at: g.built_at,
            raids: g.raids,
            extractions: g.extractions,
            owners: g.owners,
            recovered: g.recovered,
            state: STATES[self.shown_state(g, now_ms()) as usize].to_string(),
            value: U128(appraise(g.frame as usize, grade, g.condition as u32)),
        }
    }

    pub(crate) fn weapon_of(&self, n: u32) -> WeaponView {
        self.weapon_view(self.gun(n))
    }

    /// Every gun the holder owns that still exists, in the order they came to own them.
    pub(crate) fn weapons_of(&self, h: Holder) -> Vec<WeaponView> {
        let now = now_ms();
        self.guns_of(h)
            .iter()
            .filter_map(|n| self.guns.get(n))
            .filter(|g| !self.gone(g, now))
            .map(|g| self.weapon_view(g))
            .collect()
    }

    fn token_of(&self, g: &Gun) -> NftToken {
        let w = self.weapon_view(g);
        let frame = &FRAMES[g.frame as usize];
        NftToken {
            token_id: w.serial.clone(),
            owner_id: g.owner.clone(),
            metadata: Some(TokenMetadata {
                title: Some(format!("{} {} · grade {}", frame.name, w.serial, w.grade)),
                description: Some(format!(
                    "Built by {} · {} extractions · {} owners · recovered {} times · condition {}",
                    g.maker_callsign, g.extractions, g.owners, g.recovered, g.condition
                )),
                media: Some(drawing(g)),
                media_hash: None,
                copies: Some(1),
                issued_at: Some(g.built_at.to_string()),
                expires_at: None,
                starts_at: None,
                updated_at: None,
                extra: near_sdk::serde_json::to_string(&w).ok(),
                reference: None,
                reference_hash: None,
            }),
        }
    }
}

#[near]
impl Saltline {
    /// NEP-171 transfer to another registered player. Only a gun in the owner's hands (`held`) moves. Attach
    /// exactly 1 yoctoNEAR, as the standard requires.
    #[payable]
    pub fn nft_transfer(
        &mut self,
        receiver_id: AccountId,
        token_id: String,
        approval_id: Option<u64>,
        memo: Option<String>,
    ) {
        if env::attached_deposit() != NearToken::from_yoctonear(1) {
            fail(err::BAD_AMOUNT, "Attach exactly 1 yoctoNEAR to transfer");
        }
        if approval_id.is_some() {
            fail(err::BAD_AMOUNT, "Approvals aren't supported here");
        }
        if let Some(m) = &memo {
            check_memo(m);
        }
        let ix = self.caller_player();
        let n = self.own_held(ix, &token_id);
        let to = match self.holder_of(&receiver_id) {
            Some(Holder::Player(to)) => to,
            _ => fail(err::NOT_REGISTERED, format!("{receiver_id} has no dock pass")),
        };
        if to == ix {
            fail(err::DUPLICATE, "Sender and receiver are the same");
        }
        self.room_for_gun(Holder::Player(to));
        self.give_gun(n, Holder::Player(to), memo.as_deref().unwrap_or("transfer"));
    }

    pub fn nft_token(&self, token_id: String) -> Option<NftToken> {
        let n = parse_serial(&token_id).filter(|&n| serial_text(n) == token_id)?;
        self.guns.get(&n).filter(|g| !self.gone(g, now_ms())).map(|g| self.token_of(g))
    }

    /// Guns alive, counting any whose wreck or impound lapsed and that the next sweep will burn.
    pub fn nft_total_supply(&self) -> U128 {
        U128(self.guns.len() as u128)
    }

    pub fn nft_supply_for_owner(&self, account_id: AccountId) -> U128 {
        let now = now_ms();
        let n = match self.holder_of(&account_id) {
            Some(h) => self.guns_of(h).iter().filter_map(|n| self.guns.get(n)).filter(|g| !self.gone(g, now)).count(),
            None => 0,
        };
        U128(n as u128)
    }

    pub fn nft_tokens_for_owner(
        &self,
        account_id: AccountId,
        from_index: Option<U128>,
        limit: Option<u64>,
    ) -> Vec<NftToken> {
        let now = now_ms();
        let Some(h) = self.holder_of(&account_id) else { return vec![] };
        let from = from_index.map(|i| i.0).unwrap_or(0).min(MAX_GUNS_PER_OWNER as u128) as usize;
        let limit = limit.unwrap_or(MAX_GUNS_PER_OWNER as u64).min(MAX_GUNS_PER_OWNER as u64) as usize;
        self.guns_of(h)
            .iter()
            .filter_map(|n| self.guns.get(n))
            .filter(|g| !self.gone(g, now))
            .skip(from)
            .take(limit)
            .map(|g| self.token_of(g))
            .collect()
    }
}

/// A vendor's rack: its guns in state `vendor`.
pub(crate) fn on_rack(g: &Gun) -> bool {
    g.state == AT_VENDOR
}

// -----------------------------------------------------------------------------------------------------------------
// Metadata, the drawing, enumeration of every gun, and the maker's payout
// -----------------------------------------------------------------------------------------------------------------

#[near(serializers = [json])]
pub struct NftContractMetadata {
    pub spec: String,
    pub name: String,
    pub symbol: String,
    pub icon: Option<String>,
    pub base_uri: Option<String>,
    pub reference: Option<String>,
    pub reference_hash: Option<String>,
}

#[near(serializers = [json])]
pub struct Payout {
    pub payout: BTreeMap<AccountId, U128>,
}

/// The gun's card as an SVG: frame, serial, maker, grade, a silhouette whose barrel and magazine follow the frame,
/// a condition bar and its history. Plain ASCII, under 1 kB before encoding.
pub(crate) fn card(g: &Gun) -> String {
    let frame = &FRAMES[g.frame as usize];
    let grade = GRADES[g.grade()].0;
    let ink = ["#f2c14e", "#5ec8e5", "#9fb3bd", "#8a7460"][g.grade()];
    // (barrel length, magazine depth) per frame: the carbine, the short one, the marksman's.
    let (barrel, mag) = [(150, 34), (96, 46), (214, 22)][g.frame as usize];
    let bar = g.condition as u32 * 280 / 100;
    format!(
        concat!(
            "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 320 200' font-family='monospace'>",
            "<rect width='320' height='200' fill='#0d1418'/>",
            "<rect x='5' y='5' width='310' height='190' fill='none' stroke='{ink}' stroke-width='2'/>",
            "<text x='20' y='36' fill='#e6edf0' font-size='19'>{name}</text>",
            "<text x='20' y='56' fill='#8aa0aa' font-size='12'>{serial} | built by {maker}</text>",
            "<text x='300' y='62' fill='{ink}' font-size='54' text-anchor='end'>{grade}</text>",
            "<g fill='{ink}'><rect x='64' y='98' width='{barrel}' height='9'/>",
            "<rect x='50' y='92' width='104' height='22'/><rect x='20' y='98' width='36' height='26'/>",
            "<rect x='112' y='114' width='15' height='{mag}'/></g>",
            "<rect x='20' y='164' width='280' height='7' fill='#22303a'/>",
            "<rect x='20' y='164' width='{bar}' height='7' fill='{ink}'/>",
            "<text x='20' y='188' fill='#8aa0aa' font-size='11'>",
            "condition {condition} | {extractions} out | {owners} owners | recovered {recovered}</text></svg>"
        ),
        ink = ink,
        name = frame.name,
        serial = serial_text(g.serial),
        maker = g.maker_callsign,
        grade = grade,
        barrel = barrel,
        mag = mag,
        bar = bar,
        condition = g.condition,
        extractions = g.extractions,
        owners = g.owners,
        recovered = g.recovered,
    )
}

/// The card as a data URI a wallet can show without fetching anything.
pub(crate) fn drawing(g: &Gun) -> String {
    format!("data:image/svg+xml;base64,{}", near_sdk::base64::engine::general_purpose::STANDARD.encode(card(g)))
}

#[near]
impl Saltline {
    pub fn nft_metadata(&self) -> NftContractMetadata {
        NftContractMetadata {
            spec: "nft-1.0.0".to_string(),
            name: "Saltline Armoury".to_string(),
            symbol: "PAC9".to_string(),
            icon: None,
            base_uri: None,
            reference: None,
            reference_hash: None,
        }
    }

    /// Every gun alive, in the order the contract holds them, at most NFT_PAGE a page. A gun whose wreck or impound
    /// has lapsed is left out of its page before the sweep that burns it, so a page can come back short.
    pub fn nft_tokens(&self, from_index: Option<U128>, limit: Option<u64>) -> Vec<NftToken> {
        let now = now_ms();
        let from = from_index.map(|i| i.0).unwrap_or(0).min(u32::MAX as u128) as usize;
        let limit = limit.unwrap_or(NFT_PAGE).min(NFT_PAGE) as usize;
        // `iter().skip` jumps by index (the map's iterator has its own `nth`), so a late page costs no more.
        self.guns
            .iter()
            .skip(from)
            .take(limit)
            .map(|(_, g)| g)
            .filter(|g| !self.gone(g, now))
            .map(|g| self.token_of(g))
            .collect()
    }

    /// NEP-199: who is paid what out of a sale of `balance`. The maker gets 2% (rounded down), the owner the rest.
    pub fn nft_payout(&self, token_id: String, balance: U128, max_len_payout: Option<u32>) -> Payout {
        let n = self.find_gun(&token_id);
        let g = self.gun(n);
        let royalty = balance.0 / 100 * PAYOUT_MAKER_PCT + balance.0 % 100 * PAYOUT_MAKER_PCT / 100;
        let mut payout = BTreeMap::new();
        payout.insert(g.owner.clone(), U128(balance.0 - royalty));
        if royalty > 0 {
            let to_maker = payout.entry(g.maker.clone()).or_insert(U128(0));
            to_maker.0 += royalty;
        }
        if max_len_payout.is_some_and(|max| payout.len() as u32 > max) {
            fail(err::BAD_AMOUNT, format!("This gun pays {} accounts", payout.len()));
        }
        Payout { payout }
    }
}
