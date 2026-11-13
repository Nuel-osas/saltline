//! Saltline v2 (docs/GAME.md, docs/CONTRACT_V2.md): guns are NEP-171 tokens that players build, risk, lose and
//! resell; everything else is a NEP-245 token; and the invoice a raid runs up funds the machine that hunts the
//! next one.
//!
//! - `lib.rs`: state, init, roles, pause, the internal ledger, the event ring, registration
//! - `items.rs`: every number, and the pure rules on them (the roll, quality, appraisal, the invoice, prices)
//! - `mt.rs`: NEP-245 core and its `nep245` events
//! - `nft.rs`: NEP-171 core and enumeration, its `nep171` events, and the custody of guns
//! - `weapons.rs`: build, fit, repair, scrap
//! - `raids.rs`: start_raid, extract, die, manifests, wrecks, impound
//! - `harbormaster.rs`: its decaying balance, strength and thresholds, settle, buy_back
//! - `vendors.rs`: sell, buy, buy_gun
//! - `export.rs`: the export desk, the only source of new scrip after genesis
//! - `market.rs`: listings in escrow, the fee and the maker's royalty
//! - `views.rs`: the read-only tables and boards
//!
//! Integers only: amounts are whole scrip in `u128`, times are block milliseconds in `u64`.
//!
//! **No admin mint.** The owner can `pause` and `unpause`, and nothing else. Tokens and guns are created only by
//! `new` (the vendors' opening stock), `register` (150 scrip, once per account), `export` (scrip for burned
//! materials), `extract` and `die` (the cargo and parts a checked report carries), `build` and `scrap`.

#![allow(clippy::needless_range_loop)] // balances are parallel fixed arrays; indexing reads clearer

use near_sdk::json_types::U128;
use near_sdk::serde::Serialize;
use near_sdk::store::{IterableMap, LookupMap, Vector};
use near_sdk::{AccountId, PanicOnDefault, env, near};

pub mod export;
pub mod harbormaster;
pub mod items;
pub mod market;
pub mod mt;
pub mod nft;
pub mod raids;
pub mod vendors;
pub mod views;
pub mod weapons;

#[cfg(test)]
mod tests;

use items::*;

// -----------------------------------------------------------------------------------------------------------------
// Errors: every refusal panics with `E_CODE: player-facing message` (CONTRACT_V2.md → Errors)
// -----------------------------------------------------------------------------------------------------------------

pub mod err {
    pub const NOT_REGISTERED: &str = "E_NOT_REGISTERED";
    pub const ALREADY_REGISTERED: &str = "E_ALREADY_REGISTERED";
    pub const CALLSIGN_TAKEN: &str = "E_CALLSIGN_TAKEN";
    pub const BAD_CALLSIGN: &str = "E_BAD_CALLSIGN";
    pub const NOT_FAUCET: &str = "E_NOT_FAUCET";
    pub const NOT_VENDOR: &str = "E_NOT_VENDOR";
    pub const NOT_HARBORMASTER: &str = "E_NOT_HARBORMASTER";
    pub const NOT_OWNER: &str = "E_NOT_OWNER";
    pub const PAUSED: &str = "E_PAUSED";
    pub const NO_RAID: &str = "E_NO_RAID";
    pub const RAID_CLOSED: &str = "E_RAID_CLOSED";
    pub const TOO_SOON: &str = "E_TOO_SOON";
    pub const NOT_IN_MANIFEST: &str = "E_NOT_IN_MANIFEST";
    pub const OVER_LIMIT: &str = "E_OVER_LIMIT";
    pub const DUPLICATE: &str = "E_DUPLICATE";
    pub const BAD_REPORT: &str = "E_BAD_REPORT";
    pub const NO_WEAPON: &str = "E_NO_WEAPON";
    pub const WEAPON_BUSY: &str = "E_WEAPON_BUSY";
    pub const WORN_OUT: &str = "E_WORN_OUT";
    pub const SLOT_TAKEN: &str = "E_SLOT_TAKEN";
    pub const FUNDS: &str = "E_FUNDS";
    pub const VENDOR_BROKE: &str = "E_VENDOR_BROKE";
    pub const DOESNT_BUY: &str = "E_DOESNT_BUY";
    pub const DOESNT_SELL: &str = "E_DOESNT_SELL";
    pub const NO_STOCK: &str = "E_NO_STOCK";
    pub const NO_LISTING: &str = "E_NO_LISTING";
    pub const NOT_IMPOUNDED: &str = "E_NOT_IMPOUNDED";
    pub const NOTHING_OWED: &str = "E_NOTHING_OWED";
    pub const BAD_AMOUNT: &str = "E_BAD_AMOUNT";
    pub const FULL: &str = "E_FULL";
}

/// Refuse the call: panics with `CODE: message`, which reverts every change the call made.
pub(crate) fn fail(code: &str, msg: impl AsRef<str>) -> ! {
    env::panic_str(&format!("{code}: {}", msg.as_ref()))
}

/// Checked addition for balances and supply; an overflow refuses the call instead of wrapping.
pub(crate) fn add(a: u128, b: u128) -> u128 {
    a.checked_add(b).unwrap_or_else(|| fail(err::BAD_AMOUNT, "Amount too large"))
}

pub(crate) fn now_ms() -> u64 {
    env::block_timestamp_ms()
}

/// A non-zero amount no larger than `max`, or E_BAD_AMOUNT.
pub(crate) fn amount_in(amount: U128, max: u128) -> u128 {
    let n = amount.0;
    if n == 0 || n > max {
        fail(err::BAD_AMOUNT, format!("Amount must be 1 to {max}"));
    }
    n
}

pub(crate) fn check_memo(memo: &str) {
    if memo.len() > MAX_MEMO {
        fail(err::BAD_AMOUNT, format!("Memo over {MAX_MEMO} bytes"));
    }
}

// -----------------------------------------------------------------------------------------------------------------
// State
// -----------------------------------------------------------------------------------------------------------------

#[near(serializers = [borsh])]
pub struct Player {
    pub account_id: AccountId,
    pub callsign: String,
    pub registered_at: u64,
    pub raids: u32,
    pub extractions: u32,
    pub deaths: u32,
    /// What the player owes the Harbormaster.
    pub arrears: u128,
    /// When the player's last raid started (the 30 s gap is measured start to start).
    pub last_raid_at: u64,
    pub active_raid: Option<u64>,
    /// Guns built, and scrip earned as their maker.
    pub built: u32,
    pub royalties: u128,
    /// Token balances, indexed by `items::SCRIP..AMMO`.
    pub bal: [u128; TOKEN_COUNT],
    /// Every gun the player owns, in any state (at most MAX_GUNS_PER_OWNER).
    pub guns: Vec<u32>,
    /// The ones in the impound, with when each is destroyed: (serial, until).
    pub impounded: Vec<(u32, u64)>,
}

#[near(serializers = [borsh])]
pub struct Vendor {
    pub account_id: AccountId,
    /// Scrip, materials and the goods it built, indexed like a player's balances.
    pub bal: [u128; TOKEN_COUNT],
    /// The guns on its rack.
    pub guns: Vec<u32>,
    /// Its own price per token, where it set one (`vendor_price`); otherwise the default in items.rs.
    pub price: [Option<u128>; TOKEN_COUNT],
    pub last_memo: Option<String>,
}

/// The Harbormaster's wallet. Its scrip halves every 12 hours.
#[near(serializers = [borsh])]
pub struct Harbormaster {
    pub account_id: AccountId,
    /// The ledger balance: whole scrip, as of `at`.
    pub bal: [u128; TOKEN_COUNT],
    /// The same balance in millionths of a scrip, so decaying it often loses nothing to rounding.
    pub micro: u128,
    pub at: u64,
    pub posture: u8,
    pub last_memo: Option<String>,
}

pub const HELD: u8 = 0;
pub const IN_RAID: u8 = 1;
pub const LISTED: u8 = 2;
pub const AT_VENDOR: u8 = 3;
pub const IN_WRECK: u8 = 4;
pub const IMPOUNDED: u8 = 5;
pub const STATES: [&str; 6] = ["held", "raid", "listed", "vendor", "wreck", "impound"];

/// One gun: a NEP-171 token whose id is its serial.
#[near(serializers = [borsh])]
#[derive(Clone)]
pub struct Gun {
    pub serial: u32,
    pub frame: u8,
    /// The roll, in items::STAT_KEYS order.
    pub stats: [u16; STAT_COUNT],
    /// Fitted mods, one bit each (items::mod_bit).
    pub mods: u8,
    pub condition: u8,
    pub maker: AccountId,
    pub maker_callsign: String,
    pub owner: AccountId,
    pub built_at: u64,
    pub raids: u32,
    pub extractions: u32,
    pub owners: u32,
    pub recovered: u32,
    pub state: u8,
    /// In a wreck or the impound: when it is destroyed.
    pub hold_until: u64,
    /// In the impound: what the Harbormaster wants for it.
    pub fee: u128,
    /// On a vendor's rack: the vendor's own price, if it set one.
    pub ask: Option<u128>,
}

#[near(serializers = [borsh])]
#[derive(Clone)]
pub struct Container {
    pub spot: u8,
    pub token: u8,
    pub amount: u8,
    pub bonded: bool,
}

#[near(serializers = [borsh])]
pub struct Raid {
    pub id: u64,
    pub player: u32,
    pub started_at: u64,
    /// The gun locked in for the raid; None is the issue rifle.
    pub gun: Option<u32>,
    pub plates: u8,
    pub charges: u8,
    pub mags: u8,
    pub containers: Vec<Container>,
    pub wrecks: Vec<u64>,
    pub invoice_start: u128,
}

#[near(serializers = [borsh])]
#[derive(Clone)]
pub struct Wreck {
    pub id: u64,
    pub spot: u8,
    pub owner: u32,
    pub owner_id: AccountId,
    pub callsign: String,
    pub gun: Option<u32>,
    /// (token, amount), sorted by token. Held by the contract account until recovered or burned.
    pub items: Vec<(u8, u32)>,
    pub at: u64,
    pub expires_at: u64,
    /// The raid whose manifest holds this wreck, until `reserved_until` (that raid's timeout).
    pub reserved_by: Option<u64>,
    pub reserved_until: u64,
}

impl Wreck {
    pub(crate) fn reserved(&self, now: u64) -> bool {
        self.reserved_by.is_some() && now < self.reserved_until
    }
    /// Past its 24 hours and in nobody's manifest: the next sweep burns it.
    pub(crate) fn dead(&self, now: u64) -> bool {
        now >= self.expires_at && !self.reserved(now)
    }
}

#[near(serializers = [borsh])]
pub struct Listing {
    pub id: u64,
    pub seller: u32,
    pub seller_id: AccountId,
    pub callsign: String,
    /// Scrip, for the whole lot.
    pub price: u128,
    pub at: u64,
    pub gun: Option<u32>,
    pub item: Option<(u8, u128)>,
}

#[near(serializers = [borsh])]
pub struct Ledger {
    pub kind: String,
    pub at: u64,
    pub account: AccountId,
    pub callsign: Option<String>,
    pub text: String,
}

/// Scrip minted and burned, by the hour, for the last day (the `economy` view sums it).
#[near(serializers = [borsh])]
pub struct Flow {
    pub hour: [u64; 24],
    pub minted: [u128; 24],
    pub burned: [u128; 24],
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Saltline {
    pub(crate) owner_id: AccountId,
    pub(crate) faucet_id: AccountId,
    pub(crate) paused: bool,
    pub(crate) hm: Harbormaster,
    /// Moss and Ines, in `items::VENDORS` order.
    pub(crate) vendors: Vec<Vendor>,
    pub(crate) players: Vector<Player>,
    pub(crate) player_ix: LookupMap<AccountId, u32>,
    pub(crate) callsigns: LookupMap<String, u32>,
    /// Every gun alive, by serial number.
    pub(crate) guns: IterableMap<u32, Gun>,
    pub(crate) next_serial: u32,
    pub(crate) guns_built: u32,
    pub(crate) guns_destroyed: u32,
    /// Open raids only: a raid is deleted when it closes, so storage holds at most one per player.
    pub(crate) raids: LookupMap<u64, Raid>,
    pub(crate) next_raid_id: u64,
    /// Oldest first, at most MAX_WRECKS.
    pub(crate) wrecks: Vec<Wreck>,
    pub(crate) next_wreck_id: u64,
    pub(crate) listings: IterableMap<u64, Listing>,
    pub(crate) next_listing_id: u64,
    /// The contract's own holdings: listed items, gear locked in raids, and what lies in wrecks.
    pub(crate) pool: [u128; TOKEN_COUNT],
    pub(crate) supply: [u128; TOKEN_COUNT],
    /// Ines's meds in millionths of a unit, as of the time beside it: the clinic uses half of them every 12 hours
    /// (vendors.rs).
    pub(crate) clinic: (u128, u64),
    /// Each material's recent exports in thousandths of a unit, as of the time beside it (items::material_slot).
    pub(crate) exported: [(u128, u64); MATERIAL_COUNT],
    /// The last SALES_KEPT market prices for each frame and grade (frame × GRADE_COUNT + grade), oldest first.
    pub(crate) last_sales: Vec<Vec<u128>>,
    pub(crate) flow: Flow,
    /// The dock's ticker: a ring of the last RECENT_KEPT saltline events.
    pub(crate) recent: Vector<Ledger>,
    pub(crate) recent_next: u32,
}

/// Who holds a balance in the contract.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Holder {
    Player(u32),
    Vendor(usize),
    Harbormaster,
    /// The contract account itself (escrow).
    Pool,
}

// -----------------------------------------------------------------------------------------------------------------
// JSON shapes (CONTRACT_V2.md)
// -----------------------------------------------------------------------------------------------------------------

#[near(serializers = [json])]
pub struct VendorAccounts {
    pub moss: AccountId,
    pub ines: AccountId,
}

#[near(serializers = [json])]
pub struct ProfileView {
    pub account_id: AccountId,
    pub callsign: String,
    pub registered_at: u64,
    pub raids: u32,
    pub extractions: u32,
    pub deaths: u32,
    pub arrears: U128,
    pub active_raid: Option<u64>,
    pub built: u32,
    pub royalties: U128,
}

#[near(serializers = [json])]
pub struct Empty {}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct SaltlineEvent<'a, T: Serialize> {
    standard: &'static str,
    version: &'static str,
    event: &'a str,
    data: [T; 1],
}

// -----------------------------------------------------------------------------------------------------------------
// The internal ledger
// -----------------------------------------------------------------------------------------------------------------

impl Saltline {
    pub(crate) fn holder_of(&self, id: &AccountId) -> Option<Holder> {
        if let Some(ix) = self.player_ix.get(id) {
            return Some(Holder::Player(*ix));
        }
        if let Some(v) = self.vendors.iter().position(|v| &v.account_id == id) {
            return Some(Holder::Vendor(v));
        }
        if *id == self.hm.account_id {
            return Some(Holder::Harbormaster);
        }
        if *id == env::current_account_id() {
            return Some(Holder::Pool);
        }
        None
    }

    pub(crate) fn account_of(&self, h: Holder) -> AccountId {
        match h {
            Holder::Player(ix) => self.player(ix).account_id.clone(),
            Holder::Vendor(v) => self.vendors[v].account_id.clone(),
            Holder::Harbormaster => self.hm.account_id.clone(),
            Holder::Pool => env::current_account_id(),
        }
    }

    pub(crate) fn player(&self, ix: u32) -> &Player {
        self.players.get(ix).unwrap_or_else(|| env::panic_str("player index out of range"))
    }

    pub(crate) fn player_mut(&mut self, ix: u32) -> &mut Player {
        self.players.get_mut(ix).unwrap_or_else(|| env::panic_str("player index out of range"))
    }

    /// (account, callsign) of a player, for events.
    pub(crate) fn who(&self, ix: u32) -> (AccountId, String) {
        let p = self.player(ix);
        (p.account_id.clone(), p.callsign.clone())
    }

    fn bal_mut(&mut self, h: Holder) -> &mut [u128; TOKEN_COUNT] {
        match h {
            Holder::Player(ix) => &mut self.player_mut(ix).bal,
            Holder::Vendor(v) => &mut self.vendors[v].bal,
            Holder::Harbormaster => &mut self.hm.bal,
            Holder::Pool => &mut self.pool,
        }
    }

    /// The ledger balance. The Harbormaster's scrip is shown decayed by the views (`hm_balance`).
    pub(crate) fn balance(&self, h: Holder, t: usize) -> u128 {
        match h {
            Holder::Player(ix) => self.player(ix).bal[t],
            Holder::Vendor(v) => self.vendors[v].bal[t],
            Holder::Harbormaster => self.hm.bal[t],
            Holder::Pool => self.pool[t],
        }
    }

    pub(crate) fn credit(&mut self, h: Holder, t: usize, n: u128) {
        let b = self.bal_mut(h);
        b[t] = add(b[t], n);
    }

    pub(crate) fn debit(&mut self, h: Holder, t: usize, n: u128) {
        let b = self.bal_mut(h);
        if b[t] < n {
            fail(err::FUNDS, format!("Not enough {}: {} short", TOKENS[t].id, n - b[t]));
        }
        b[t] -= n;
    }

    pub(crate) fn mint(&mut self, h: Holder, t: usize, n: u128) {
        self.credit(h, t, n);
        self.supply[t] = add(self.supply[t], n);
        if t == SCRIP {
            self.flowed(n, true);
        }
    }

    pub(crate) fn burn(&mut self, h: Holder, t: usize, n: u128) {
        self.debit(h, t, n);
        self.supply[t] -= n;
        if t == SCRIP {
            self.flowed(n, false);
        }
    }

    pub(crate) fn move_tokens(&mut self, from: Holder, to: Holder, t: usize, n: u128) {
        self.debit(from, t, n);
        self.credit(to, t, n);
    }

    /// Count scrip minted or burned into this hour's bucket.
    fn flowed(&mut self, n: u128, minted: bool) {
        let hour = now_ms() / HOUR_MS;
        let i = (hour % 24) as usize;
        if self.flow.hour[i] != hour {
            self.flow.hour[i] = hour;
            self.flow.minted[i] = 0;
            self.flow.burned[i] = 0;
        }
        let bucket = if minted { &mut self.flow.minted[i] } else { &mut self.flow.burned[i] };
        *bucket = bucket.saturating_add(n);
    }

    // ---- roles ----

    /// Every call that changes state passes this first.
    pub(crate) fn guard(&self) {
        if self.paused {
            fail(err::PAUSED, "The dock is closed for maintenance. Try again shortly");
        }
    }

    /// The calling player, with timed-out raids and impounds tidied first, or E_NOT_REGISTERED.
    pub(crate) fn caller_player(&mut self) -> u32 {
        self.guard();
        let id = env::predecessor_account_id();
        let ix = *self
            .player_ix
            .get(&id)
            .unwrap_or_else(|| fail(err::NOT_REGISTERED, "Not registered. Claim a dock pass first"));
        self.tidy(ix);
        ix
    }

    /// Lazy expiry for one player (bounded work):
    /// - a raid that timed out is abandoned, so its gun comes home;
    /// - guns left in the impound past their 48 hours are destroyed, at most SWEEP_PER_CALL a call.
    fn tidy(&mut self, ix: u32) {
        let now = now_ms();
        if let Some(id) = self.player(ix).active_raid
            && self.raids.get(&id).is_none_or(|r| raids::expired(r, now))
        {
            self.abandon(id);
        }
        let due: Vec<u32> = self
            .player(ix)
            .impounded
            .iter()
            .filter(|(_, until)| now >= *until)
            .map(|x| x.0)
            .take(SWEEP_PER_CALL)
            .collect();
        for serial in due {
            self.burn_gun(serial, "impound lapsed");
        }
    }

    // ---- events ----

    /// Emit a NEP-297 `saltline` event and keep it in the ring for the dock's ticker.
    pub(crate) fn record(
        &mut self,
        kind: &str,
        account: &AccountId,
        callsign: Option<String>,
        text: String,
        mut data: near_sdk::serde_json::Value,
    ) {
        if let Some(obj) = data.as_object_mut() {
            obj.insert("account".into(), account.to_string().into());
            obj.insert("text".into(), text.clone().into());
        }
        let ev = SaltlineEvent { standard: "saltline", version: "2.0.0", event: kind, data: [data] };
        env::log_str(&format!("EVENT_JSON:{}", near_sdk::serde_json::to_string(&ev).unwrap_or_default()));

        let entry = Ledger { kind: kind.to_string(), at: now_ms(), account: account.clone(), callsign, text };
        let slot = self.recent_next;
        if slot < self.recent.len() {
            self.recent.set(slot, entry);
        } else {
            self.recent.push(entry);
        }
        self.recent_next = (slot + 1) % RECENT_KEPT;
    }

    pub(crate) fn profile_of(&self, ix: u32, now: u64) -> ProfileView {
        let p = self.player(ix);
        let active_raid = p.active_raid.filter(|id| self.raids.get(id).is_some_and(|r| !raids::expired(r, now)));
        ProfileView {
            account_id: p.account_id.clone(),
            callsign: p.callsign.clone(),
            registered_at: p.registered_at,
            raids: p.raids,
            extractions: p.extractions,
            deaths: p.deaths,
            arrears: U128(p.arrears),
            active_raid,
            built: p.built,
            royalties: U128(p.royalties),
        }
    }
}

/// Callsigns are 3–16 characters from `A–Z 0–9 - . _ space`, stored upper-case. Fail closed on anything else,
/// including leading, trailing or doubled spaces, so two callsigns can't differ only by whitespace.
pub(crate) fn normalise_callsign(raw: &str) -> String {
    let up = raw.to_ascii_uppercase();
    let len = up.chars().count();
    let ok_chars =
        up.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || matches!(c, '-' | '.' | '_' | ' '));
    if !(3..=16).contains(&len) || !ok_chars || up.starts_with(' ') || up.ends_with(' ') || up.contains("  ") {
        fail(err::BAD_CALLSIGN, "Callsigns are 3–16 of A–Z 0–9 - . _ and single spaces");
    }
    up
}

// -----------------------------------------------------------------------------------------------------------------
// Init, registration and the pause
// -----------------------------------------------------------------------------------------------------------------

#[near]
impl Saltline {
    /// Deploy-time setup. Callable once, by the contract account itself. The scrip and stock minted here are all
    /// that exists before the first registration and the first export.
    #[init]
    #[private]
    pub fn new(owner_id: AccountId, faucet_id: AccountId, harbormaster_id: AccountId, vendors: VendorAccounts) -> Self {
        let me = env::current_account_id();
        let roles = [vendors.moss.clone(), vendors.ines.clone(), harbormaster_id.clone(), faucet_id.clone(), me];
        for (i, a) in roles.iter().enumerate() {
            if roles[..i].contains(a) {
                fail(err::DUPLICATE, format!("{a} is given two roles"));
            }
        }
        let now = now_ms();
        let mut c = Self {
            owner_id,
            faucet_id,
            paused: false,
            hm: Harbormaster {
                account_id: harbormaster_id,
                bal: [0; TOKEN_COUNT],
                micro: 0,
                at: now,
                posture: PATROLS,
                last_memo: None,
            },
            vendors: Vec::with_capacity(VENDOR_COUNT),
            players: Vector::new(b"p"),
            player_ix: LookupMap::new(b"i"),
            callsigns: LookupMap::new(b"c"),
            guns: IterableMap::new(b"g"),
            next_serial: 1,
            guns_built: 0,
            guns_destroyed: 0,
            raids: LookupMap::new(b"r"),
            next_raid_id: 1,
            wrecks: Vec::new(),
            next_wreck_id: 1,
            listings: IterableMap::new(b"l"),
            next_listing_id: 1,
            pool: [0; TOKEN_COUNT],
            supply: [0; TOKEN_COUNT],
            clinic: (0, now),
            exported: [(0, now); MATERIAL_COUNT],
            last_sales: vec![Vec::new(); FRAME_COUNT * GRADE_COUNT],
            flow: Flow { hour: [0; 24], minted: [0; 24], burned: [0; 24] },
            recent: Vector::new(b"e"),
            recent_next: 0,
        };
        let mut mints = Vec::new();
        for (v, account_id) in [vendors.moss, vendors.ines].into_iter().enumerate() {
            c.vendors.push(Vendor {
                account_id: account_id.clone(),
                bal: [0; TOKEN_COUNT],
                guns: Vec::new(),
                price: [None; TOKEN_COUNT],
                last_memo: None,
            });
            let mut log = mt::MintLog::one(&account_id, SCRIP, VENDOR_SEED_SCRIP, Some("opening stock"));
            c.mint(Holder::Vendor(v), SCRIP, VENDOR_SEED_SCRIP);
            for &t in VENDORS[v].buys {
                let stock = TOKENS[t].target as u128 * VENDOR_SEED_STOCK_PCT / 100;
                c.mint(Holder::Vendor(v), t, stock);
                log.push(t, stock);
            }
            if v == INES {
                for (t, n) in INES_SEED {
                    c.mint(Holder::Vendor(v), t, n);
                    log.push(t, n);
                }
            }
            mints.push(log);
        }
        mt::emit_mint(mints);
        c.clinic = (c.vendors[INES].bal[MEDS] * MICRO, now);
        let moss = c.vendors[MOSS].account_id.clone();
        for frame in MOSS_SEED_FRAMES {
            c.mint_gun(Holder::Vendor(MOSS), frame, &moss, VENDORS[MOSS].callsign, AT_VENDOR);
        }
        c
    }

    /// The faucet registers a new player: a profile, a unique callsign and the starter scrip. Once per account.
    pub fn register(&mut self, account_id: AccountId, callsign: String) -> ProfileView {
        self.guard();
        if env::predecessor_account_id() != self.faucet_id {
            fail(err::NOT_FAUCET, "Only the faucet account can register players");
        }
        if self.holder_of(&account_id).is_some() || account_id == self.faucet_id {
            fail(err::ALREADY_REGISTERED, "That account already has a dock pass");
        }
        let callsign = normalise_callsign(&callsign);
        if self.callsigns.contains_key(&callsign) || VENDORS.iter().any(|v| v.callsign == callsign) {
            fail(err::CALLSIGN_TAKEN, format!("{callsign} is taken"));
        }
        let ix = self.players.len();
        if ix >= MAX_PROFILES {
            fail(err::FULL, format!("The dock is full: {MAX_PROFILES} passes issued"));
        }
        let now = now_ms();
        self.players.push(Player {
            account_id: account_id.clone(),
            callsign: callsign.clone(),
            registered_at: now,
            raids: 0,
            extractions: 0,
            deaths: 0,
            arrears: 0,
            last_raid_at: 0,
            active_raid: None,
            built: 0,
            royalties: 0,
            bal: [0; TOKEN_COUNT],
            guns: Vec::new(),
            impounded: Vec::new(),
        });
        self.player_ix.insert(account_id.clone(), ix);
        self.callsigns.insert(callsign, ix);
        self.mint(Holder::Player(ix), SCRIP, STARTER_SCRIP);
        mt::emit_mint(vec![mt::MintLog::one(&account_id, SCRIP, STARTER_SCRIP, Some("dock pass"))]);
        self.profile_of(ix, now)
    }

    /// The owner stops every call that changes state. Views still answer. This and `unpause` are all the owner
    /// can do.
    pub fn pause(&mut self) -> Empty {
        self.only_owner();
        self.paused = true;
        Empty {}
    }

    pub fn unpause(&mut self) -> Empty {
        self.only_owner();
        self.paused = false;
        Empty {}
    }

    pub fn paused(&self) -> bool {
        self.paused
    }
}

impl Saltline {
    fn only_owner(&self) {
        if env::predecessor_account_id() != self.owner_id {
            fail(err::NOT_OWNER, "Only the owner can pause the dock");
        }
    }
}
