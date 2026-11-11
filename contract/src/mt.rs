//! NEP-245 multi tokens: every item is a token id in this one contract (`scrip`, `copper`, … `cutter`).
//!
//! near-contract-standards 5.30.1 has no multi-token module, so the core is written here:
//! - transfers: `mt_transfer`, `mt_batch_transfer`;
//! - views: `mt_balance_of`, `mt_batch_balance_of`, `mt_supply`;
//! - the NEP-297 `nep245` events `mt_mint`, `mt_burn` and `mt_transfer`, version 1.0.0.
//!
//! What this contract leaves out of NEP-245, and why:
//! - `mt_transfer_call` and approvals: nothing in the game receives tokens by callback. Passing an approval is
//!   refused rather than ignored.
//! - Holders are registered players. Brokers and the contract hold balances too, but only the game's own calls
//!   move them. The contract pays for storage, so tokens can't be sent to arbitrary accounts.
//! - Dividends accrue to shareholders without a log line, so the balance views count them. They are minted, with an
//!   `mt_mint` event, the next time the player makes a call. `mt_supply` counts minted tokens only.

use near_sdk::json_types::U128;
use near_sdk::serde::Serialize;
use near_sdk::{AccountId, NearToken, env, near};

#[cfg(test)]
use crate::add;
use crate::items::{ITEMS, TOKEN_COUNT, token_index};
use crate::{Holder, Saltline, SaltlineExt, check_memo, err, fail};

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct Nep245Event<'a, T: Serialize> {
    standard: &'static str,
    version: &'static str,
    event: &'a str,
    data: Vec<T>,
}

fn emit<T: Serialize>(event: &str, data: Vec<T>) {
    if data.is_empty() {
        return;
    }
    let ev = Nep245Event { standard: "nep245", version: "1.0.0", event, data };
    env::log_str(&format!("EVENT_JSON:{}", near_sdk::serde_json::to_string(&ev).unwrap_or_default()));
}

#[derive(Serialize, Clone)]
#[serde(crate = "near_sdk::serde")]
pub struct MintLog {
    pub owner_id: AccountId,
    pub token_ids: Vec<String>,
    pub amounts: Vec<U128>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub memo: Option<String>,
}

impl MintLog {
    pub fn new(owner: &AccountId, memo: Option<&str>) -> Self {
        Self { owner_id: owner.clone(), token_ids: vec![], amounts: vec![], memo: memo.map(str::to_string) }
    }
    pub fn one(owner: &AccountId, t: usize, n: u128, memo: Option<&str>) -> Self {
        let mut m = Self::new(owner, memo);
        m.push(t, n);
        m
    }
    pub fn push(&mut self, t: usize, n: u128) {
        if n > 0 {
            self.token_ids.push(ITEMS[t].id.to_string());
            self.amounts.push(U128(n));
        }
    }
    fn is_empty(&self) -> bool {
        self.token_ids.is_empty()
    }
}

/// `mt_burn` has the same shape as `mt_mint` (its optional `authorized_id` is never used here).
pub type BurnLog = MintLog;

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
pub struct TransferLog {
    pub old_owner_id: AccountId,
    pub new_owner_id: AccountId,
    pub token_ids: Vec<String>,
    pub amounts: Vec<U128>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub memo: Option<String>,
}

impl TransferLog {
    pub fn one(from: &AccountId, to: &AccountId, t: usize, n: u128, memo: Option<&str>) -> Self {
        Self {
            old_owner_id: from.clone(),
            new_owner_id: to.clone(),
            token_ids: vec![ITEMS[t].id.to_string()],
            amounts: vec![U128(n)],
            memo: memo.map(str::to_string),
        }
    }
}

pub fn emit_mint(logs: Vec<MintLog>) {
    emit("mt_mint", logs.into_iter().filter(|l| !l.is_empty()).collect());
}

pub fn emit_burn(logs: Vec<BurnLog>) {
    emit("mt_burn", logs.into_iter().filter(|l| !l.is_empty()).collect());
}

pub fn emit_transfer(logs: Vec<TransferLog>) {
    emit("mt_transfer", logs);
}

/// A token id the caller is spending, or E_FUNDS (nobody holds a token that doesn't exist).
fn spend_token(id: &str) -> usize {
    token_index(id).unwrap_or_else(|| fail(err::FUNDS, format!("You hold no '{id}'")))
}

#[near]
impl Saltline {
    /// NEP-245 transfer between registered players. Attach exactly 1 yoctoNEAR, as the standard requires.
    #[payable]
    pub fn mt_transfer(
        &mut self,
        receiver_id: AccountId,
        token_id: String,
        amount: U128,
        approval: Option<(AccountId, u64)>,
        memo: Option<String>,
    ) {
        self.mt_batch_transfer(receiver_id, vec![token_id], vec![amount], approval.map(|a| vec![Some(a)]), memo)
    }

    /// NEP-245 batch transfer: every (token, amount) pair moves from the caller to `receiver_id`, or none do.
    #[payable]
    pub fn mt_batch_transfer(
        &mut self,
        receiver_id: AccountId,
        token_ids: Vec<String>,
        amounts: Vec<U128>,
        approvals: Option<Vec<Option<(AccountId, u64)>>>,
        memo: Option<String>,
    ) {
        if env::attached_deposit() != NearToken::from_yoctonear(1) {
            fail(err::BAD_AMOUNT, "Attach exactly 1 yoctoNEAR to transfer");
        }
        if approvals.is_some_and(|a| a.iter().any(Option::is_some)) {
            fail(err::BAD_AMOUNT, "Approvals aren't supported here");
        }
        if token_ids.is_empty() || token_ids.len() != amounts.len() || token_ids.len() > TOKEN_COUNT {
            fail(err::BAD_AMOUNT, "Give one amount per token, at most one of each token");
        }
        if let Some(m) = &memo {
            check_memo(m);
        }
        let from = self.caller_player();
        let to = match self.holder_of(&receiver_id) {
            Some(Holder::Player(ix)) => ix,
            _ => fail(err::NOT_REGISTERED, format!("{receiver_id} has no dock pass")),
        };
        if from == to {
            fail(err::DUPLICATE, "Sender and receiver are the same");
        }
        let mut log = TransferLog {
            old_owner_id: env::predecessor_account_id(),
            new_owner_id: receiver_id,
            token_ids: vec![],
            amounts: vec![],
            memo,
        };
        let mut seen = [false; TOKEN_COUNT];
        for (id, amount) in token_ids.iter().zip(amounts) {
            let t = spend_token(id);
            if seen[t] {
                fail(err::DUPLICATE, format!("{id} listed twice"));
            }
            seen[t] = true;
            if amount.0 == 0 {
                fail(err::BAD_AMOUNT, "Amount must be at least 1");
            }
            self.move_tokens(Holder::Player(from), Holder::Player(to), t, amount.0);
            log.token_ids.push(ITEMS[t].id.to_string());
            log.amounts.push(amount);
        }
        emit_transfer(vec![log]);
    }

    /// NEP-245 balance. Unknown tokens and unknown accounts hold 0. Accrued dividends count as scrip.
    pub fn mt_balance_of(&self, account_id: AccountId, token_id: String) -> U128 {
        let h = self.holder_of(&account_id);
        U128(match (h, token_index(&token_id)) {
            (Some(h), Some(t)) => self.spendable(h, t),
            _ => 0,
        })
    }

    pub fn mt_batch_balance_of(&self, account_id: AccountId, token_ids: Vec<String>) -> Vec<U128> {
        let h = self.holder_of(&account_id);
        token_ids
            .iter()
            .map(|id| {
                U128(match (h, token_index(id)) {
                    (Some(h), Some(t)) => self.spendable(h, t),
                    _ => 0,
                })
            })
            .collect()
    }

    /// NEP-245 total supply of a token (minted and not burned), or null for a token that doesn't exist.
    pub fn mt_supply(&self, token_id: String) -> Option<U128> {
        token_index(&token_id).map(|t| U128(self.supply[t]))
    }
}

/// Sum of a token over every holder: used by the tests to check supply is conserved.
#[cfg(test)]
pub(crate) fn total_held(c: &Saltline, t: usize) -> u128 {
    let mut sum = c.pool[t];
    for b in &c.brokers {
        sum = add(sum, b.bal[t]);
    }
    for p in c.players.iter() {
        sum = add(sum, p.bal[t]);
    }
    sum
}
