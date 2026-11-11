//! Saltline's salvage economy (docs/ECONOMY.md, docs/CONTRACT_API.md).
//!
//! - `lib.rs`: state, init, roles, the internal ledger, the event ring, profiles and registration
//! - `mt.rs`: NEP-245 multi-token core and its `nep245` events
//! - `items.rs`: the item table and run rules (data)
//! - `pricing.rs`: the pricing rules (the one readable file)
//! - `policy.rs`: the default broker policy (used by `advice` and `simulate`)
//! - `runs.rs`: start_run, extract, die, manifests and wrecks
//!
//! Integers only: amounts are whole scrip in `u128`, times are block milliseconds in `u64`.

#![allow(clippy::needless_range_loop)] // balances are parallel fixed arrays; indexing reads clearer

use std::collections::BTreeMap;

use near_sdk::json_types::U128;
use near_sdk::serde::Serialize;
use near_sdk::store::{IterableMap, LookupMap, Vector};
use near_sdk::{AccountId, PanicOnDefault, env, near};

pub mod items;
pub mod mt;
pub mod policy;
pub mod pricing;
pub mod runs;


use items::*;

// -----------------------------------------------------------------------------------------------------------------
// Errors: every refusal panics with `E_CODE: player-facing message` (CONTRACT_API.md → Errors)
// -----------------------------------------------------------------------------------------------------------------

pub mod err {
    pub const NOT_REGISTERED: &str = "E_NOT_REGISTERED";
    pub const ALREADY_REGISTERED: &str = "E_ALREADY_REGISTERED";
    pub const CALLSIGN_TAKEN: &str = "E_CALLSIGN_TAKEN";
    pub const BAD_CALLSIGN: &str = "E_BAD_CALLSIGN";
    pub const NOT_FAUCET: &str = "E_NOT_FAUCET";
    pub const NOT_BROKER: &str = "E_NOT_BROKER";
    pub const NO_RUN: &str = "E_NO_RUN";
    pub const RUN_CLOSED: &str = "E_RUN_CLOSED";
    pub const TOO_SOON: &str = "E_TOO_SOON";
    pub const NOT_IN_MANIFEST: &str = "E_NOT_IN_MANIFEST";
    pub const OVER_LIMIT: &str = "E_OVER_LIMIT";
    pub const DUPLICATE: &str = "E_DUPLICATE";
    pub const BROKER_CLOSED: &str = "E_BROKER_CLOSED";
    pub const BROKER_BROKE: &str = "E_BROKER_BROKE";
    pub const DOESNT_BUY: &str = "E_DOESNT_BUY";
    pub const DOESNT_SELL: &str = "E_DOESNT_SELL";
    pub const FUNDS: &str = "E_FUNDS";
    pub const NO_GEAR: &str = "E_NO_GEAR";
    pub const EXPORT_COOLDOWN: &str = "E_EXPORT_COOLDOWN";
    pub const EXPORT_STOCK: &str = "E_EXPORT_STOCK";
    pub const STANCE_RANGE: &str = "E_STANCE_RANGE";
    pub const NO_LISTING: &str = "E_NO_LISTING";
    pub const BAD_AMOUNT: &str = "E_BAD_AMOUNT";
    /// Not in CONTRACT_API.md's table: a bounded collection is full (500 profiles, 100 listings).
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
    pub runs: u32,
    pub extractions: u32,
    pub deaths: u32,
    pub best_haul: u128,
    /// When the player's last run started (the 30 s gap is measured start to start).
    pub last_run_at: u64,
    pub active_run: Option<u64>,
    /// Token balances, indexed by `items::SCRIP..CUTTER`.
    pub bal: [u128; TOKEN_COUNT],
    /// Shares held in each broker (one share per scrip invested).
    pub shares: [u128; BROKER_COUNT],
    /// Dividends already paid against those shares (`pricing::owed` at the last settlement).
    pub debt: [u128; BROKER_COUNT],
}

#[near(serializers = [borsh])]
pub struct Broker {
    pub account_id: AccountId,
    pub open: bool,
    pub stance: u32,
    /// Scrip and stock, indexed like a player's balances.
    pub bal: [u128; TOKEN_COUNT],
    /// Gear sold recently, in thousandths of a unit, as of `recent_at` (decays lazily: `pricing::decay_recent`).
    pub recent_milli: u128,
    pub recent_at: u64,
    /// When each token was last exported (0 = never).
    pub last_export: [u64; TOKEN_COUNT],
    pub total_shares: u128,
    /// Dividend per share × `pricing::ACC_SCALE`, summed over every export.
    pub acc: u128,
    /// Players holding shares, in the order they first invested (at most MAX_PROFILES).
    pub holders: Vec<u32>,
    pub last_memo: Option<String>,
}

#[near(serializers = [borsh])]
#[derive(Clone)]
pub struct Container {
    pub spot: u8,
    pub token: u8,
    pub amount: u8,
}

#[near(serializers = [borsh])]
pub struct Run {
    pub id: u64,
    pub player: u32,
    pub started_at: u64,
    pub containers: Vec<Container>,
    pub wrecks: Vec<u64>,
}

#[near(serializers = [borsh])]
#[derive(Clone)]
pub struct Wreck {
    pub id: u64,
    pub spot: u8,
    pub owner: u32,
    pub owner_id: AccountId,
    pub callsign: String,
    /// (token, amount), one entry per cargo type, sorted by token.
    pub items: Vec<(u8, u32)>,
    pub at: u64,
    /// The run whose manifest holds this wreck, until `reserved_until` (the run's expiry).
    pub reserved_by: Option<u64>,
    pub reserved_until: u64,
}

impl Wreck {
    pub(crate) fn reserved(&self, now: u64) -> bool {
        self.reserved_by.is_some() && now < self.reserved_until
    }
}

#[near(serializers = [borsh])]
pub struct Listing {
    pub id: u64,
    pub seller: u32,
    pub seller_id: AccountId,
    pub callsign: String,
    pub token: u8,
    pub amount: u128,
    /// Scrip per unit.
    pub price: u128,
    pub at: u64,
}

#[near(serializers = [borsh])]
pub struct Ledger {
    pub kind: String,
    pub at: u64,
    pub account: AccountId,
    pub callsign: Option<String>,
    pub text: String,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Saltline {
    pub(crate) owner_id: AccountId,
    pub(crate) faucet_id: AccountId,
    /// Moss, Ines and the Quartermaster, in `items::BROKERS` order.
    pub(crate) brokers: Vec<Broker>,
    pub(crate) players: Vector<Player>,
    pub(crate) player_ix: LookupMap<AccountId, u32>,
    pub(crate) callsigns: LookupMap<String, u32>,
    /// Open runs only: a run is deleted when it closes, so storage holds at most one per player.
    pub(crate) runs: LookupMap<u64, Run>,
    pub(crate) next_run_id: u64,
    /// Oldest first, at most MAX_WRECKS.
    pub(crate) wrecks: Vec<Wreck>,
    pub(crate) next_wreck_id: u64,
    pub(crate) listings: IterableMap<u64, Listing>,
    pub(crate) next_listing_id: u64,
    /// The contract's own holdings: cargo and gear in escrow for listings.
    pub(crate) pool: [u128; TOKEN_COUNT],
    pub(crate) supply: [u128; TOKEN_COUNT],
    /// The Dockside ticker: a ring of the last RECENT_KEPT saltline events.
    pub(crate) recent: Vector<Ledger>,
    pub(crate) recent_next: u32,
}

/// Who holds a balance in the contract.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Holder {
    Player(u32),
    Broker(usize),
    /// The contract account itself (listing escrow).
    Pool,
}

// -----------------------------------------------------------------------------------------------------------------
// JSON shapes (CONTRACT_API.md)
// -----------------------------------------------------------------------------------------------------------------

#[near(serializers = [json])]
pub struct BrokerAccounts {
    pub moss: AccountId,
    pub ines: AccountId,
    pub qm: AccountId,
}

#[near(serializers = [json])]
pub struct ItemView {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub weight: u32,
    pub base: U128,
    pub export: Option<U128>,
    pub target: Option<u32>,
}

#[near(serializers = [json])]
pub struct RulesView {
    pub spot_count: u32,
    pub containers_per_run: u32,
    pub wrecks_per_run: u32,
    pub carry_limit: u32,
    pub min_run_seconds: u64,
    pub per_container_seconds: u64,
    pub finder_share_pct: u32,
    pub starter_scrip: U128,
}

#[near(serializers = [json])]
pub struct ProfileView {
    pub account_id: AccountId,
    pub callsign: String,
    pub registered_at: u64,
    pub runs: u32,
    pub extractions: u32,
    pub deaths: u32,
    pub best_haul: U128,
    pub active_run: Option<u64>,
}

#[near(serializers = [json])]
pub struct LedgerView {
    pub kind: String,
    pub at: u64,
    pub account: AccountId,
    pub callsign: Option<String>,
    pub text: String,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct SaltlineEvent<'a, T: Serialize> {
    standard: &'static str,
    version: &'static str,
    event: &'a str,
    data: [T; 1],
}

// -----------------------------------------------------------------------------------------------------------------
// Internal ledger
// -----------------------------------------------------------------------------------------------------------------

impl Saltline {
    pub(crate) fn holder_of(&self, id: &AccountId) -> Option<Holder> {
        if let Some(ix) = self.player_ix.get(id) {
            return Some(Holder::Player(*ix));
        }
        if let Some(b) = self.brokers.iter().position(|b| &b.account_id == id) {
            return Some(Holder::Broker(b));
        }
        if *id == env::current_account_id() {
            return Some(Holder::Pool);
        }
        None
    }

    pub(crate) fn player(&self, ix: u32) -> &Player {
        self.players.get(ix).unwrap_or_else(|| env::panic_str("player index out of range"))
    }

    pub(crate) fn player_mut(&mut self, ix: u32) -> &mut Player {
        self.players.get_mut(ix).unwrap_or_else(|| env::panic_str("player index out of range"))
    }

    fn bal_mut(&mut self, h: Holder) -> &mut [u128; TOKEN_COUNT] {
        match h {
            Holder::Player(ix) => &mut self.player_mut(ix).bal,
            Holder::Broker(b) => &mut self.brokers[b].bal,
            Holder::Pool => &mut self.pool,
        }
    }

    /// The settled balance: what the ledger (and the nep245 events) say.
    pub(crate) fn balance(&self, h: Holder, t: usize) -> u128 {
        match h {
            Holder::Player(ix) => self.player(ix).bal[t],
            Holder::Broker(b) => self.brokers[b].bal[t],
            Holder::Pool => self.pool[t],
        }
    }

    /// What the holder can spend right now: the settled balance plus, for scrip, dividends accrued but not yet
    /// paid in. Every call by a player pays those in first, so this is the honest number to show.
    pub(crate) fn spendable(&self, h: Holder, t: usize) -> u128 {
        let settled = self.balance(h, t);
        match (h, t) {
            (Holder::Player(ix), SCRIP) => settled.saturating_add(self.pending_dividends(self.player(ix))),
            _ => settled,
        }
    }

    pub(crate) fn credit(&mut self, h: Holder, t: usize, n: u128) {
        let b = self.bal_mut(h);
        b[t] = add(b[t], n);
    }

    pub(crate) fn debit(&mut self, h: Holder, t: usize, n: u128) {
        let b = self.bal_mut(h);
        if b[t] < n {
            fail(err::FUNDS, format!("Not enough {}: {} short", ITEMS[t].many, n - b[t]));
        }
        b[t] -= n;
    }

    pub(crate) fn mint(&mut self, h: Holder, t: usize, n: u128) {
        self.credit(h, t, n);
        self.supply[t] = add(self.supply[t], n);
    }

    pub(crate) fn burn(&mut self, h: Holder, t: usize, n: u128) {
        self.debit(h, t, n);
        self.supply[t] -= n;
    }

    pub(crate) fn move_tokens(&mut self, from: Holder, to: Holder, t: usize, n: u128) {
        self.debit(from, t, n);
        self.credit(to, t, n);
    }

    // ---- dividends (pricing::dividend_per_share explains the running total) ----

    pub(crate) fn pending_dividends(&self, p: &Player) -> u128 {
        (0..BROKER_COUNT)
            .map(|b| pricing::owed(p.shares[b], self.brokers[b].acc).saturating_sub(p.debt[b]))
            .fold(0u128, |a, x| a.saturating_add(x))
    }

    /// Pay a player's accrued dividends into their scrip (minted now, with an `mt_mint` event).
    pub(crate) fn settle(&mut self, ix: u32) {
        let accs: [u128; BROKER_COUNT] = [self.brokers[0].acc, self.brokers[1].acc, self.brokers[2].acc];
        let p = self.player_mut(ix);
        let mut due: u128 = 0;
        for b in 0..BROKER_COUNT {
            if p.shares[b] > 0 {
                let owed = pricing::owed(p.shares[b], accs[b]);
                due = due.saturating_add(owed.saturating_sub(p.debt[b]));
                p.debt[b] = owed;
            }
        }
        if due > 0 {
            let account = p.account_id.clone();
            self.mint(Holder::Player(ix), SCRIP, due);
            mt::emit_mint(vec![mt::MintLog::one(&account, SCRIP, due, Some("dividend"))]);
        }
    }

    /// The calling player, with their dividends paid in, or E_NOT_REGISTERED.
    pub(crate) fn caller_player(&mut self) -> u32 {
        let id = env::predecessor_account_id();
        let ix = *self
            .player_ix
            .get(&id)
            .unwrap_or_else(|| fail(err::NOT_REGISTERED, "Not registered. Claim a dock pass first"));
        self.settle(ix);
        ix
    }

    // ---- brokers ----

    pub(crate) fn cheapest_bid(&self, b: usize) -> u128 {
        let br = &self.brokers[b];
        BROKERS[b].buys.iter().map(|&t| pricing::bid_for(t, br.bal[t], br.stance)).min().unwrap_or(1)
    }

    /// Close an open broker that can no longer cover a unit, or reopen a closed one that reached the line
    /// (pricing::should_close, pricing::should_reopen). Logs the change.
    pub(crate) fn review_broker(&mut self, b: usize) {
        let scrip = self.brokers[b].bal[SCRIP];
        let name = BROKERS[b].name;
        if self.brokers[b].open {
            if pricing::should_close(scrip, self.cheapest_bid(b)) {
                self.brokers[b].open = false;
                let account = self.brokers[b].account_id.clone();
                let text = format!(
                    "{name} shut the stall on {scrip} scrip. Float is {}; needs {} to reopen.",
                    pricing::FLOAT,
                    pricing::REOPEN_LINE
                );
                self.record(
                    "close",
                    &account,
                    None,
                    text,
                    near_sdk::serde_json::json!({ "broker": BROKERS[b].id, "scrip": U128(scrip) }),
                );
            }
        } else if pricing::should_reopen(scrip) {
            self.brokers[b].open = true;
            let account = self.brokers[b].account_id.clone();
            let text = format!("{name} is open again on {scrip} scrip.");
            self.record(
                "reopen",
                &account,
                None,
                text,
                near_sdk::serde_json::json!({ "broker": BROKERS[b].id, "scrip": U128(scrip) }),
            );
        }
    }

    // ---- events ----

    /// Emit a NEP-297 `saltline` event and keep it in the ring for the Dockside ticker.
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
        let ev = SaltlineEvent { standard: "saltline", version: "1.0.0", event: kind, data: [data] };
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

    pub(crate) fn broker_from_id(id: &str) -> usize {
        broker_index(id).unwrap_or_else(|| fail(err::NOT_BROKER, format!("No broker called '{id}'")))
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
// Init, registration and the simple views
// -----------------------------------------------------------------------------------------------------------------

#[near]
impl Saltline {
    /// Deploy-time setup. Callable once, by the contract account itself.
    #[init]
    #[private]
    pub fn new(owner_id: AccountId, faucet_id: AccountId, brokers: BrokerAccounts) -> Self {
        let accounts = [brokers.moss, brokers.ines, brokers.qm];
        let me = env::current_account_id();
        for (i, a) in accounts.iter().enumerate() {
            if accounts[..i].contains(a) || *a == me || *a == faucet_id {
                fail(err::DUPLICATE, format!("Broker account {a} is used twice"));
            }
        }
        let mut c = Self {
            owner_id,
            faucet_id,
            brokers: Vec::with_capacity(BROKER_COUNT),
            players: Vector::new(b"p"),
            player_ix: LookupMap::new(b"i"),
            callsigns: LookupMap::new(b"c"),
            runs: LookupMap::new(b"r"),
            next_run_id: 1,
            wrecks: Vec::new(),
            next_wreck_id: 1,
            listings: IterableMap::new(b"l"),
            next_listing_id: 1,
            pool: [0; TOKEN_COUNT],
            supply: [0; TOKEN_COUNT],
            recent: Vector::new(b"e"),
            recent_next: 0,
        };
        let mut mints = Vec::new();
        for (b, account_id) in accounts.into_iter().enumerate() {
            c.brokers.push(Broker {
                account_id: account_id.clone(),
                open: true,
                stance: pricing::STANCE_NEUTRAL,
                bal: [0; TOKEN_COUNT],
                recent_milli: 0,
                recent_at: now_ms(),
                last_export: [0; TOKEN_COUNT],
                total_shares: 0,
                acc: 0,
                holders: Vec::new(),
                last_memo: None,
            });
            let mut log = mt::MintLog::one(&account_id, SCRIP, BROKER_SEED_SCRIP, Some("opening float"));
            c.mint(Holder::Broker(b), SCRIP, BROKER_SEED_SCRIP);
            for &t in BROKERS[b].buys {
                let stock = ITEMS[t].target.unwrap_or(0) as u128 * BROKER_SEED_STOCK_PCT / 100;
                c.mint(Holder::Broker(b), t, stock);
                log.push(t, stock);
            }
            mints.push(log);
        }
        mt::emit_mint(mints);
        c
    }

    /// The faucet registers a new player: a profile, a unique callsign and the starter scrip. Once per account.
    pub fn register(&mut self, account_id: AccountId, callsign: String) -> ProfileView {
        if env::predecessor_account_id() != self.faucet_id {
            fail(err::NOT_FAUCET, "Only the faucet account can register players");
        }
        if self.holder_of(&account_id).is_some() {
            fail(err::ALREADY_REGISTERED, "That account already has a dock pass");
        }
        let callsign = normalise_callsign(&callsign);
        if self.callsigns.contains_key(&callsign) {
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
            runs: 0,
            extractions: 0,
            deaths: 0,
            best_haul: 0,
            last_run_at: 0,
            active_run: None,
            bal: [0; TOKEN_COUNT],
            shares: [0; BROKER_COUNT],
            debt: [0; BROKER_COUNT],
        });
        self.player_ix.insert(account_id.clone(), ix);
        self.callsigns.insert(callsign, ix);
        self.mint(Holder::Player(ix), SCRIP, STARTER_SCRIP);
        mt::emit_mint(vec![mt::MintLog::one(&account_id, SCRIP, STARTER_SCRIP, Some("starter scrip"))]);
        self.profile_of(ix, now)
    }

    pub fn items(&self) -> Vec<ItemView> {
        ITEMS
            .iter()
            .map(|i| ItemView {
                id: i.id.to_string(),
                name: i.name.to_string(),
                kind: i.kind.as_str().to_string(),
                weight: i.weight,
                base: U128(i.base),
                export: i.export.map(U128),
                target: i.target,
            })
            .collect()
    }

    pub fn rules(&self) -> RulesView {
        RulesView {
            spot_count: SPOT_COUNT,
            containers_per_run: CONTAINERS_PER_RUN,
            wrecks_per_run: WRECKS_PER_RUN,
            carry_limit: CARRY_LIMIT,
            min_run_seconds: MIN_RUN_SECONDS,
            per_container_seconds: PER_CONTAINER_SECONDS,
            finder_share_pct: FINDER_SHARE_PCT as u32,
            starter_scrip: U128(STARTER_SCRIP),
        }
    }

    pub fn profile(&self, account_id: AccountId) -> Option<ProfileView> {
        self.player_ix.get(&account_id).map(|&ix| self.profile_of(ix, now_ms()))
    }

    /// Non-zero balances, with accrued dividends counted in scrip (see `spendable`).
    pub fn balances(&self, account_id: AccountId) -> BTreeMap<String, U128> {
        let mut out = BTreeMap::new();
        if let Some(h) = self.holder_of(&account_id) {
            for (t, item) in ITEMS.iter().enumerate() {
                let n = self.spendable(h, t);
                if n > 0 {
                    out.insert(item.id.to_string(), U128(n));
                }
            }
        }
        out
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

impl Saltline {
    pub(crate) fn profile_of(&self, ix: u32, now: u64) -> ProfileView {
        let p = self.player(ix);
        let active_run = p.active_run.filter(|id| self.runs.get(id).is_some_and(|r| !runs::expired(r, now)));
        ProfileView {
            account_id: p.account_id.clone(),
            callsign: p.callsign.clone(),
            registered_at: p.registered_at,
            runs: p.runs,
            extractions: p.extractions,
            deaths: p.deaths,
            best_haul: U128(p.best_haul),
            active_run,
        }
    }
}
