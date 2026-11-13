//! The player market (docs/CONTRACT_V2.md → Market): fixed-price listings for guns and for stacks of items.
//!
//! - A listed gun is `listed`: it stays in its owner's name and can't be raided with, transferred, fitted, repaired
//!   or scrapped until the listing is bought or cancelled. Listed items are moved to the contract account.
//! - `buy_listing` takes the price from the buyer: ⌊2%⌋ to the gun's maker, ⌊2%⌋ burned, and the rest to the
//!   seller. For items there is no maker, so both parts are burned. Buying your own listing is refused
//!   (`E_NO_LISTING`).
//! - The last five sale prices for each frame and grade are kept.
//! - At most MAX_LISTINGS listings (`E_FULL`).

use near_sdk::json_types::U128;
use near_sdk::{AccountId, env, near};

use crate::items::*;
use crate::mt::{self, BurnLog, TransferLog};
use crate::nft::WeaponView;
use crate::raids::ItemAmount;
use crate::{Empty, HELD, Holder, LISTED, Listing, Saltline, SaltlineExt, amount_in, err, fail, now_ms};

#[near(serializers = [json])]
pub struct ListingView {
    pub id: u64,
    pub seller: AccountId,
    pub callsign: String,
    pub price: U128,
    pub at: u64,
    pub weapon: Option<WeaponView>,
    pub item: Option<ItemAmount>,
}

#[near(serializers = [json])]
pub struct ListResult {
    pub id: u64,
}

#[near(serializers = [json])]
pub struct BoughtResult {
    pub paid: U128,
    pub weapon: Option<WeaponView>,
}

/// (to the seller, to the maker, burned) out of a sale price.
pub fn sale_split(price: u128) -> (u128, u128, u128) {
    let maker = price * MAKER_PCT / 100;
    let burned = price * (MARKET_FEE_PCT - MAKER_PCT) / 100;
    (price - maker - burned, maker, burned)
}

impl Saltline {
    fn new_listing(&mut self, ix: u32, price: u128, gun: Option<u32>, item: Option<(u8, u128)>) -> u64 {
        if self.listings.len() >= MAX_LISTINGS {
            fail(err::FULL, format!("The board is full: {MAX_LISTINGS} listings"));
        }
        let id = self.next_listing_id;
        self.next_listing_id += 1;
        let (seller_id, callsign) = self.who(ix);
        self.listings.insert(id, Listing { id, seller: ix, seller_id, callsign, price, at: now_ms(), gun, item });
        id
    }

    fn listing_view(&self, l: &Listing) -> ListingView {
        ListingView {
            id: l.id,
            seller: l.seller_id.clone(),
            callsign: l.callsign.clone(),
            price: U128(l.price),
            at: l.at,
            weapon: l.gun.and_then(|n| self.guns.get(&n)).map(|g| self.weapon_view(g)),
            item: l.item.map(|(t, n)| ItemAmount { token_id: TOKENS[t as usize].id.to_string(), amount: U128(n) }),
        }
    }
}

#[near]
impl Saltline {
    /// Put a gun on the market at a fixed price in scrip.
    pub fn list_weapon(&mut self, serial: String, price: U128) -> ListResult {
        let ix = self.caller_player();
        let n = self.own_held(ix, &serial);
        let price = amount_in(price, MAX_PRICE);
        let id = self.new_listing(ix, price, Some(n), None);
        self.gun_mut(n).state = LISTED;
        let (me, callsign) = self.who(ix);
        let text = format!("{callsign} listed a {} for {price}.", self.gun(n).label());
        self.record(
            "listing",
            &me,
            Some(callsign),
            text,
            near_sdk::serde_json::json!({ "action": "list", "id": id, "serial": serial, "price": U128(price) }),
        );
        ListResult { id }
    }

    /// Put a stack of one item on the market: `price` is for the whole lot. The items sit with the contract.
    pub fn list_item(&mut self, token_id: String, amount: U128, price: U128) -> ListResult {
        let ix = self.caller_player();
        let t = token_index(&token_id).unwrap_or_else(|| fail(err::FUNDS, format!("You hold no '{token_id}'")));
        if t == SCRIP {
            fail(err::BAD_AMOUNT, "Scrip can't be listed");
        }
        let n = amount_in(amount, u128::MAX);
        let price = amount_in(price, MAX_PRICE);
        if self.balance(Holder::Player(ix), t) < n {
            fail(err::FUNDS, format!("You don't have {}", count(t, n)));
        }
        let id = self.new_listing(ix, price, None, Some((t as u8, n)));
        self.move_tokens(Holder::Player(ix), Holder::Pool, t, n);
        let (me, callsign) = self.who(ix);
        mt::emit_transfer(vec![TransferLog::one(&me, &env::current_account_id(), t, n, Some("listed"))]);
        let text = format!("{callsign} listed {} for {price}.", count(t, n));
        self.record(
            "listing",
            &me,
            Some(callsign),
            text,
            near_sdk::serde_json::json!({ "action": "list", "id": id, "token_id": TOKENS[t].id, "amount": U128(n), "price": U128(price) }),
        );
        ListResult { id }
    }

    /// Buy a listing: 96% of the price to the seller, 2% to the gun's maker (burned for items), 2% burned.
    pub fn buy_listing(&mut self, id: u64) -> BoughtResult {
        let ix = self.caller_player();
        let l = self.listings.get(&id).unwrap_or_else(|| fail(err::NO_LISTING, format!("No listing {id}")));
        if l.seller == ix {
            fail(err::NO_LISTING, "That's your own listing; cancel it instead");
        }
        let (seller, seller_id, seller_callsign, price, gun, item) =
            (l.seller, l.seller_id.clone(), l.callsign.clone(), l.price, l.gun, l.item);
        let h = Holder::Player(ix);
        if self.balance(h, SCRIP) < price {
            fail(err::FUNDS, format!("That listing costs {price} scrip"));
        }
        if gun.is_some() {
            self.room_for_gun(h);
        }
        self.listings.remove(&id);
        let (me, callsign) = self.who(ix);
        let (to_seller, royalty, burned) = sale_split(price);
        let mut moves = vec![TransferLog::one(&me, &seller_id, SCRIP, to_seller, Some("market sale"))];
        self.move_tokens(h, Holder::Player(seller), SCRIP, to_seller);

        let (weapon, what, burned) = match (gun, item) {
            (Some(n), _) => {
                let maker = self.gun(n).maker.clone();
                // The maker is a player or a vendor; either way the account can't leave the contract.
                let maker_h = self.holder_of(&maker).unwrap_or_else(|| fail(err::NO_WEAPON, "The maker is unknown"));
                self.move_tokens(h, maker_h, SCRIP, royalty);
                if let Holder::Player(m) = maker_h {
                    let p = self.player_mut(m);
                    p.royalties = p.royalties.saturating_add(royalty);
                }
                moves.push(TransferLog::one(&me, &maker, SCRIP, royalty, Some("maker's royalty")));
                let g = self.gun(n);
                let slot = g.frame as usize * GRADE_COUNT + g.grade();
                let label = g.label();
                self.give_gun(n, h, "bought on the market");
                self.gun_mut(n).state = HELD;
                let sales = &mut self.last_sales[slot];
                sales.push(price);
                if sales.len() > SALES_KEPT {
                    sales.remove(0);
                }
                (Some(self.weapon_of(n)), format!("a {label}"), burned)
            }
            (None, Some((t, n))) => {
                self.move_tokens(Holder::Pool, h, t as usize, n);
                moves.push(TransferLog::one(&env::current_account_id(), &me, t as usize, n, Some("market sale")));
                (None, count(t as usize, n), burned + royalty)
            }
            (None, None) => fail(err::NO_LISTING, format!("Listing {id} is empty")),
        };
        self.burn(h, SCRIP, burned);
        mt::emit_transfer(moves);
        mt::emit_burn(vec![BurnLog::one(&me, SCRIP, burned, Some("market fee"))]);
        let text = format!("{callsign} bought {seller_callsign}'s {what} for {price}.")
            .replace(&format!("{seller_callsign}'s a "), &format!("{seller_callsign}'s "));
        self.record(
            "market_sale",
            &me,
            Some(callsign),
            text,
            near_sdk::serde_json::json!({
                "id": id, "seller": seller_id, "paid": U128(price), "to_seller": U128(to_seller),
                "royalty": U128(if gun.is_some() { royalty } else { 0 }), "burned": U128(burned),
                "serial": gun.map(serial_text)
            }),
        );
        BoughtResult { paid: U128(price), weapon }
    }

    /// Take a listing down and get the gun or the items back. The seller only.
    pub fn cancel_listing(&mut self, id: u64) -> Empty {
        let ix = self.caller_player();
        let l = self.listings.get(&id).unwrap_or_else(|| fail(err::NO_LISTING, format!("No listing {id}")));
        if l.seller != ix {
            fail(err::NOT_OWNER, format!("Listing {id} isn't yours"));
        }
        let (gun, item) = (l.gun, l.item);
        self.listings.remove(&id);
        let (me, callsign) = self.who(ix);
        let what = if let Some(n) = gun {
            self.gun_mut(n).state = HELD;
            format!("a {}", self.gun(n).label())
        } else if let Some((t, n)) = item {
            self.move_tokens(Holder::Pool, Holder::Player(ix), t as usize, n);
            mt::emit_transfer(vec![TransferLog::one(
                &env::current_account_id(),
                &me,
                t as usize,
                n,
                Some("listing cancelled"),
            )]);
            count(t as usize, n)
        } else {
            "nothing".to_string()
        };
        let text = format!("{callsign} took {what} off the market.");
        self.record(
            "listing",
            &me,
            Some(callsign),
            text,
            near_sdk::serde_json::json!({ "action": "cancel", "id": id }),
        );
        Empty {}
    }

    /// Every listing, newest first.
    pub fn listings(&self) -> Vec<ListingView> {
        let mut out: Vec<ListingView> = self.listings.values().map(|l| self.listing_view(l)).collect();
        out.sort_by(|a, b| b.id.cmp(&a.id));
        out
    }
}
