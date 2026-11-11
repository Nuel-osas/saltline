//! Market calls (docs/ECONOMY.md → Market calls): selling to brokers, buying gear, investing, the player market
//! and the brokers' own calls. Plus the views that read the market: `brokers`, `listings`, `leaderboard`, `advice`.
//!
//! Every price comes from `pricing.rs`. This file moves the tokens and writes the ledger.

use std::collections::BTreeMap;

use near_sdk::json_types::U128;
use near_sdk::{AccountId, env, near};

use crate::items::*;
use crate::mt::{self, BurnLog, MintLog, TransferLog};
use crate::policy::{self, Move};
use crate::{Holder, Listing, Saltline, SaltlineExt, amount_in, check_memo, err, fail, now_ms, pricing};

#[near(serializers = [json])]
pub struct Quote {
    pub token_id: String,
    pub price: U128,
    pub reason: String,
}

#[near(serializers = [json])]
pub struct ShareView {
    pub account_id: AccountId,
    pub callsign: String,
    pub shares: U128,
}

#[near(serializers = [json])]
pub struct BrokerView {
    pub id: String,
    pub account_id: AccountId,
    pub name: String,
    pub open: bool,
    pub scrip: U128,
    pub stance: u32,
    pub stock: BTreeMap<String, U128>,
    pub bids: Vec<Quote>,
    pub asks: Vec<Quote>,
    pub shares: Vec<ShareView>,
    pub last_memo: Option<String>,
}

#[near(serializers = [json])]
pub struct ListingView {
    pub id: u64,
    pub seller: AccountId,
    pub callsign: String,
    pub token_id: String,
    pub amount: U128,
    pub price: U128,
    pub at: u64,
}

#[near(serializers = [json])]
pub struct LeaderRow {
    pub account_id: AccountId,
    pub callsign: String,
    pub value: U128,
}

#[near(serializers = [json])]
pub struct Leaderboard {
    pub net_worth: Vec<LeaderRow>,
    pub best_haul: Vec<LeaderRow>,
    pub investors: Vec<LeaderRow>,
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
pub struct InvestResult {
    /// The caller's shares in this broker after the call (one share per scrip ever invested).
    pub shares: U128,
    pub reopened: bool,
}

#[near(serializers = [json])]
pub struct ListResult {
    pub id: u64,
}

#[near(serializers = [json])]
pub struct Empty {}

#[near(serializers = [json])]
pub struct ExportResult {
    /// Scrip the broker kept (gross minus dividend).
    pub earned: U128,
    /// Scrip owed to its shareholders (paid into their balances; see pricing::dividend_per_share).
    pub dividend: U128,
}

#[near(serializers = [json])]
pub struct AdviceView {
    pub action: String,
    pub token_id: Option<String>,
    pub amount: Option<U128>,
    pub stance: Option<u32>,
    pub memo: String,
}

impl Saltline {
    fn caller_broker(&self) -> usize {
        let me = env::predecessor_account_id();
        self.brokers
            .iter()
            .position(|b| b.account_id == me)
            .unwrap_or_else(|| fail(err::NOT_BROKER, "Only the broker's own account can call this"))
    }

    /// The board's copy of a broker, as `policy.rs` sees it.
    pub(crate) fn desk(&self, b: usize) -> policy::Desk {
        let br = &self.brokers[b];
        policy::Desk {
            broker: b,
            open: br.open,
            scrip: br.bal[SCRIP],
            stance: br.stance,
            stock: br.bal,
            last_export: br.last_export,
        }
    }

    fn broker_view(&self, b: usize, now: u64) -> BrokerView {
        let br = &self.brokers[b];
        let info = &BROKERS[b];
        let recent = pricing::decay_recent(br.recent_milli, now.saturating_sub(br.recent_at));
        let mut holders: Vec<ShareView> = br
            .holders
            .iter()
            .map(|&ix| {
                let p = self.player(ix);
                ShareView { account_id: p.account_id.clone(), callsign: p.callsign.clone(), shares: U128(p.shares[b]) }
            })
            .collect();
        holders.sort_by(|a, z| z.shares.0.cmp(&a.shares.0).then_with(|| a.account_id.cmp(&z.account_id)));
        BrokerView {
            id: info.id.to_string(),
            account_id: br.account_id.clone(),
            name: info.name.to_string(),
            open: br.open,
            scrip: U128(br.bal[SCRIP]),
            stance: br.stance,
            stock: info.buys.iter().map(|&t| (ITEMS[t].id.to_string(), U128(br.bal[t]))).collect(),
            bids: info
                .buys
                .iter()
                .map(|&t| {
                    let (price, reason) = pricing::bid_quote(t, br.bal[t], br.stance, br.open);
                    Quote { token_id: ITEMS[t].id.to_string(), price: U128(price), reason }
                })
                .collect(),
            asks: info
                .sells
                .iter()
                .map(|&t| {
                    let (price, reason) = pricing::ask_quote(t, recent, br.stance, br.open);
                    Quote { token_id: ITEMS[t].id.to_string(), price: U128(price), reason }
                })
                .collect(),
            shares: holders,
            last_memo: br.last_memo.clone(),
        }
    }

    fn listing_view(l: &Listing) -> ListingView {
        ListingView {
            id: l.id,
            seller: l.seller_id.clone(),
            callsign: l.callsign.clone(),
            token_id: ITEMS[l.token as usize].id.to_string(),
            amount: U128(l.amount),
            price: U128(l.price),
            at: l.at,
        }
    }
}

fn top(mut rows: Vec<LeaderRow>) -> Vec<LeaderRow> {
    rows.retain(|r| r.value.0 > 0);
    rows.sort_by(|a, z| z.value.0.cmp(&a.value.0).then_with(|| a.account_id.cmp(&z.account_id)));
    rows.truncate(LEADERBOARD_ROWS);
    rows
}

#[near]
impl Saltline {
    // -------------------------------------------------------------------------------------------------------------
    // Players and brokers
    // -------------------------------------------------------------------------------------------------------------

    /// Sell cargo to a broker at its bid, priced unit by unit. Refused whole if the broker can't cover it.
    /// Every unit sold is delivered to the town (`town.rs`).
    pub fn sell(&mut self, broker: String, token_id: String, amount: U128) -> Paid {
        let ix = self.caller_player();
        let b = Self::broker_from_id(&broker);
        let name = BROKERS[b].name;
        let t = token_index(&token_id)
            .filter(|&t| buys(b, t))
            .unwrap_or_else(|| fail(err::DOESNT_BUY, format!("{name} doesn't buy {token_id}")));
        let n = amount_in(amount, MAX_BATCH);
        if self.balance(Holder::Player(ix), t) < n {
            fail(err::FUNDS, format!("You don't have {}", count(t, n)));
        }
        let br = &self.brokers[b];
        if !br.open {
            fail(err::BROKER_CLOSED, format!("{name} is shut until someone invests"));
        }
        let paid = pricing::sale_value(t, br.bal[t], br.stance, n);
        if !pricing::can_cover(br.bal[SCRIP], paid) {
            let can = pricing::units_covered(t, br.bal[t], br.stance, br.bal[SCRIP], n);
            let msg = if can == 0 {
                format!("{name} can't cover a single {}", ITEMS[t].one)
            } else {
                format!("{name} can cover {} at most", count(t, can))
            };
            fail(err::BROKER_BROKE, msg);
        }

        self.move_tokens(Holder::Player(ix), Holder::Broker(b), t, n);
        self.move_tokens(Holder::Broker(b), Holder::Player(ix), SCRIP, paid);
        let me = self.player(ix).account_id.clone();
        let callsign = self.player(ix).callsign.clone();
        let broker_id = self.brokers[b].account_id.clone();
        mt::emit_transfer(vec![
            TransferLog::one(&me, &broker_id, t, n, Some("sale")),
            TransferLog::one(&broker_id, &me, SCRIP, paid, Some("sale")),
        ]);
        let text = format!("{callsign} sold {} to {name} for {paid}.", count(t, n));
        self.record(
            "sale",
            &me,
            Some(callsign),
            text,
            near_sdk::serde_json::json!({ "broker": BROKERS[b].id, "token_id": ITEMS[t].id, "amount": U128(n), "paid": U128(paid) }),
        );
        // A sale to a broker is a delivery to the town (town.rs); it may light a district or start an act.
        self.deliver(ix, b, t, n);
        self.review_broker(b);
        Paid { paid: U128(paid) }
    }

    /// Buy gear from a broker at its ask; each unit sold raises the next unit's ask.
    pub fn buy(&mut self, broker: String, token_id: String, amount: U128) -> Cost {
        let ix = self.caller_player();
        let b = Self::broker_from_id(&broker);
        let name = BROKERS[b].name;
        let t = token_index(&token_id)
            .filter(|&t| sells(b, t))
            .unwrap_or_else(|| fail(err::DOESNT_SELL, format!("{name} doesn't sell {token_id}")));
        let n = amount_in(amount, MAX_BATCH);
        let now = now_ms();
        let br = &self.brokers[b];
        if !br.open {
            fail(err::BROKER_CLOSED, format!("{name} is shut until someone invests"));
        }
        let recent = pricing::decay_recent(br.recent_milli, now.saturating_sub(br.recent_at));
        let cost = pricing::purchase_cost(t, recent, br.stance, n);
        if self.balance(Holder::Player(ix), SCRIP) < cost {
            fail(err::FUNDS, format!("{} costs {cost} scrip", count(t, n)));
        }

        self.move_tokens(Holder::Player(ix), Holder::Broker(b), SCRIP, cost);
        self.mint(Holder::Player(ix), t, n);
        let br = &mut self.brokers[b];
        br.recent_milli = recent.saturating_add(n.saturating_mul(pricing::MILLI));
        br.recent_at = now;
        let me = self.player(ix).account_id.clone();
        let callsign = self.player(ix).callsign.clone();
        let broker_id = self.brokers[b].account_id.clone();
        mt::emit_transfer(vec![TransferLog::one(&me, &broker_id, SCRIP, cost, Some("gear"))]);
        mt::emit_mint(vec![MintLog::one(&me, t, n, Some("gear"))]);
        let text = format!("{callsign} bought {} from {name} for {cost}.", count(t, n));
        self.record(
            "purchase",
            &me,
            Some(callsign),
            text,
            near_sdk::serde_json::json!({ "broker": BROKERS[b].id, "token_id": ITEMS[t].id, "amount": U128(n), "cost": U128(cost) }),
        );
        // Every trade is followed by the closing check (pricing::should_close).
        self.review_broker(b);
        Cost { cost: U128(cost) }
    }

    /// Put scrip into a broker for shares (one per scrip). Reopens a closed broker once it reaches the line.
    pub fn invest(&mut self, broker: String, amount: U128) -> InvestResult {
        let ix = self.caller_player();
        let b = Self::broker_from_id(&broker);
        let name = BROKERS[b].name;
        let n = amount_in(amount, u128::MAX);
        if self.balance(Holder::Player(ix), SCRIP) < n {
            fail(err::FUNDS, format!("You don't have {n} scrip"));
        }
        self.move_tokens(Holder::Player(ix), Holder::Broker(b), SCRIP, n);
        // The caller was settled on entry, so their debt is current; reset it for the new share count.
        let acc = self.brokers[b].acc;
        let p = self.player_mut(ix);
        let first = p.shares[b] == 0;
        p.shares[b] = crate::add(p.shares[b], n);
        p.debt[b] = pricing::owed(p.shares[b], acc);
        let shares = p.shares[b];
        let me = p.account_id.clone();
        let callsign = p.callsign.clone();
        let br = &mut self.brokers[b];
        br.total_shares = crate::add(br.total_shares, n);
        if first {
            br.holders.push(ix);
        }
        let broker_id = br.account_id.clone();
        let was_open = br.open;
        mt::emit_transfer(vec![TransferLog::one(&me, &broker_id, SCRIP, n, Some("investment"))]);
        let text = format!("{callsign} put {n} scrip into {name}.");
        self.record(
            "invest",
            &me,
            Some(callsign),
            text,
            near_sdk::serde_json::json!({ "broker": BROKERS[b].id, "amount": U128(n), "shares": U128(shares) }),
        );
        self.review_broker(b);
        InvestResult { shares: U128(shares), reopened: !was_open && self.brokers[b].open }
    }

    /// List cargo or gear for other players at a price per unit. The goods sit in escrow with the contract.
    pub fn list(&mut self, token_id: String, amount: U128, price: U128) -> ListResult {
        let ix = self.caller_player();
        let t = token_index(&token_id).unwrap_or_else(|| fail(err::FUNDS, format!("You hold no '{token_id}'")));
        if t == SCRIP {
            fail(err::BAD_AMOUNT, "Scrip can't be listed");
        }
        let n = amount_in(amount, u128::MAX);
        let price = amount_in(price, MAX_LISTING_PRICE);
        if self.balance(Holder::Player(ix), t) < n {
            fail(err::FUNDS, format!("You don't have {}", count(t, n)));
        }
        if self.listings.len() >= MAX_LISTINGS {
            fail(err::FULL, format!("The board is full: {MAX_LISTINGS} listings"));
        }
        self.move_tokens(Holder::Player(ix), Holder::Pool, t, n);
        let id = self.next_listing_id;
        self.next_listing_id += 1;
        let p = self.player(ix);
        let (me, callsign) = (p.account_id.clone(), p.callsign.clone());
        self.listings.insert(
            id,
            Listing {
                id,
                seller: ix,
                seller_id: me.clone(),
                callsign: callsign.clone(),
                token: t as u8,
                amount: n,
                price,
                at: now_ms(),
            },
        );
        mt::emit_transfer(vec![TransferLog::one(&me, &env::current_account_id(), t, n, Some("listing escrow"))]);
        let text = format!("{callsign} listed {} at {price} each.", count(t, n));
        self.record(
            "listing",
            &me,
            Some(callsign),
            text,
            near_sdk::serde_json::json!({ "action": "list", "id": id, "token_id": ITEMS[t].id, "amount": U128(n), "price": U128(price) }),
        );
        ListResult { id }
    }

    /// Buy a whole listing: scrip to the seller, the goods out of escrow to the buyer.
    pub fn buy_listing(&mut self, id: u64) -> Paid {
        let ix = self.caller_player();
        let l = self.listings.get(&id).unwrap_or_else(|| fail(err::NO_LISTING, format!("No listing {id}")));
        if l.seller == ix {
            fail(err::NO_LISTING, "That's your own listing; cancel it instead");
        }
        let (seller, seller_id, seller_callsign, t, n) =
            (l.seller, l.seller_id.clone(), l.callsign.clone(), l.token as usize, l.amount);
        let total = l.price.checked_mul(n).unwrap_or_else(|| fail(err::BAD_AMOUNT, "Listing total too large"));
        if self.balance(Holder::Player(ix), SCRIP) < total {
            fail(err::FUNDS, format!("That listing costs {total} scrip"));
        }
        self.listings.remove(&id);
        self.move_tokens(Holder::Player(ix), Holder::Player(seller), SCRIP, total);
        self.move_tokens(Holder::Pool, Holder::Player(ix), t, n);
        let p = self.player(ix);
        let (me, callsign) = (p.account_id.clone(), p.callsign.clone());
        mt::emit_transfer(vec![
            TransferLog::one(&me, &seller_id, SCRIP, total, Some("listing bought")),
            TransferLog::one(&env::current_account_id(), &me, t, n, Some("listing bought")),
        ]);
        let text = format!("{callsign} bought {seller_callsign}'s {} for {total}.", count(t, n));
        self.record(
            "listing",
            &me,
            Some(callsign),
            text,
            near_sdk::serde_json::json!({ "action": "buy", "id": id, "token_id": ITEMS[t].id, "amount": U128(n), "paid": U128(total), "seller": seller_id }),
        );
        Paid { paid: U128(total) }
    }

    /// Take a listing down and get the goods back. The seller only.
    pub fn cancel_listing(&mut self, id: u64) -> Empty {
        let ix = self.caller_player();
        let l = self.listings.get(&id).unwrap_or_else(|| fail(err::NO_LISTING, format!("No listing {id}")));
        if l.seller != ix {
            fail(err::NO_LISTING, format!("Listing {id} isn't yours"));
        }
        let (t, n) = (l.token as usize, l.amount);
        self.listings.remove(&id);
        self.move_tokens(Holder::Pool, Holder::Player(ix), t, n);
        let p = self.player(ix);
        let (me, callsign) = (p.account_id.clone(), p.callsign.clone());
        mt::emit_transfer(vec![TransferLog::one(&env::current_account_id(), &me, t, n, Some("listing cancelled"))]);
        let text = format!("{callsign} pulled {} off the board.", count(t, n));
        self.record(
            "listing",
            &me,
            Some(callsign),
            text,
            near_sdk::serde_json::json!({ "action": "cancel", "id": id }),
        );
        Empty {}
    }

    /// The broker ships cargo to the freighter at the export price, in newly minted scrip, less the dividend.
    pub fn broker_export(&mut self, token_id: String, amount: U128, memo: String) -> ExportResult {
        let b = self.caller_broker();
        let name = BROKERS[b].name;
        check_memo(&memo);
        let t = token_index(&token_id)
            .filter(|&t| is_cargo(t))
            .unwrap_or_else(|| fail(err::EXPORT_STOCK, format!("{name} holds no '{token_id}'")));
        let n = amount_in(amount, u128::MAX);
        let now = now_ms();
        let br = &self.brokers[b];
        if n > br.bal[t] {
            fail(err::EXPORT_STOCK, format!("{name} holds only {}", count(t, br.bal[t])));
        }
        let last = br.last_export[t];
        if last > 0 && now < last.saturating_add(pricing::EXPORT_COOLDOWN_MS) {
            let mins = (last + pricing::EXPORT_COOLDOWN_MS - now).div_ceil(60_000);
            fail(err::EXPORT_COOLDOWN, format!("{name} shipped {} within the hour; {mins} min to go", ITEMS[t].many));
        }
        let (_, export_price, _) = cargo_terms(t);
        let (earned, dividend) = pricing::export_split(export_price, n, br.total_shares);
        let increment = pricing::dividend_per_share(dividend, br.total_shares);

        self.burn(Holder::Broker(b), t, n);
        self.mint(Holder::Broker(b), SCRIP, earned);
        let br = &mut self.brokers[b];
        br.acc = crate::add(br.acc, increment);
        br.last_export[t] = now;
        br.last_memo = Some(memo.clone());
        let broker_id = br.account_id.clone();
        mt::emit_burn(vec![BurnLog::one(&broker_id, t, n, Some("export"))]);
        mt::emit_mint(vec![MintLog::one(&broker_id, SCRIP, earned, Some("export"))]);
        let text = format!("{name} shipped {} to the freighter for {}. {memo}", count(t, n), earned + dividend);
        self.record(
            "export",
            &broker_id,
            None,
            text.trim_end().to_string(),
            near_sdk::serde_json::json!({ "broker": BROKERS[b].id, "token_id": ITEMS[t].id, "amount": U128(n), "earned": U128(earned), "dividend": U128(dividend), "memo": memo }),
        );
        self.review_broker(b);
        ExportResult { earned: U128(earned), dividend: U128(dividend) }
    }

    /// The broker sets its stance (80–120): its lever on bids and asks.
    pub fn broker_stance(&mut self, stance: u32, memo: String) -> Empty {
        let b = self.caller_broker();
        check_memo(&memo);
        if !(pricing::STANCE_MIN..=pricing::STANCE_MAX).contains(&stance) {
            fail(err::STANCE_RANGE, format!("Stance runs {} to {}", pricing::STANCE_MIN, pricing::STANCE_MAX));
        }
        let br = &mut self.brokers[b];
        br.stance = stance;
        br.last_memo = Some(memo.clone());
        let broker_id = br.account_id.clone();
        let text = format!("{} set stance {stance}. {memo}", BROKERS[b].name);
        self.record(
            "stance",
            &broker_id,
            None,
            text.trim_end().to_string(),
            near_sdk::serde_json::json!({ "broker": BROKERS[b].id, "stance": stance, "memo": memo }),
        );
        self.review_broker(b);
        Empty {}
    }

    // -------------------------------------------------------------------------------------------------------------
    // Views
    // -------------------------------------------------------------------------------------------------------------

    pub fn brokers(&self) -> Vec<BrokerView> {
        let now = now_ms();
        (0..BROKER_COUNT).map(|b| self.broker_view(b, now)).collect()
    }

    /// Open listings, newest first.
    pub fn listings(&self) -> Vec<ListingView> {
        let mut out: Vec<ListingView> = self.listings.values().map(Self::listing_view).collect();
        out.sort_by(|a, z| z.id.cmp(&a.id));
        out
    }

    /// Top 10 by net worth, best haul and investment.
    /// - Net worth is scrip (accrued dividends included) plus cargo at the best current bid.
    /// - Gear, listed goods and shares aren't counted: they have no bid.
    pub fn leaderboard(&self) -> Leaderboard {
        let bids: [u128; TOKEN_COUNT] = core::array::from_fn(|t| if is_cargo(t) { self.best_bid(t) } else { 0 });
        let (mut worth, mut haul, mut inv) = (Vec::new(), Vec::new(), Vec::new());
        for p in self.players.iter() {
            let mut w = p.bal[SCRIP].saturating_add(self.pending_dividends(p));
            for &t in CARGO.iter() {
                w = w.saturating_add(p.bal[t].saturating_mul(bids[t]));
            }
            let invested = p.shares.iter().fold(0u128, |a, s| a.saturating_add(*s));
            let row = |value: u128| LeaderRow {
                account_id: p.account_id.clone(),
                callsign: p.callsign.clone(),
                value: U128(value),
            };
            worth.push(row(w));
            haul.push(row(p.best_haul));
            inv.push(row(invested));
        }
        Leaderboard { net_worth: top(worth), best_haul: top(haul), investors: top(inv) }
    }

    /// What the default policy (`policy.rs`) would do for this broker now. The agent runner may follow it or not.
    pub fn advice(&self, broker: String) -> AdviceView {
        let b = Self::broker_from_id(&broker);
        let desk = self.desk(b);
        let mv = policy::advise(&desk, now_ms());
        let memo = policy::memo(&desk, &mv);
        match mv {
            Move::Hold => AdviceView { action: "none".into(), token_id: None, amount: None, stance: None, memo },
            Move::Export { token, amount } => AdviceView {
                action: "export".into(),
                token_id: Some(ITEMS[token].id.to_string()),
                amount: Some(U128(amount)),
                stance: None,
                memo,
            },
            Move::Stance(s) => {
                AdviceView { action: "stance".into(), token_id: None, amount: None, stance: Some(s), memo }
            }
        }
    }
}
