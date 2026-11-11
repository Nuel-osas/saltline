//! Runs on-chain: `start_run`, `extract`, `die`, manifests and wrecks (docs/ECONOMY.md → Runs on-chain).
//!
//! **The trust model, stated plainly:** what happens in the yard is reported by the client. The contract can't see
//! the fight. It checks what it can:
//! - the run is the caller's and still open (30 minutes at most);
//! - every container and wreck claimed is in the run's manifest, and claimed once;
//! - the total weight carried is within the carry limit;
//! - the run lasted long enough for what it claims: 45 s plus 8 s per container to extract, and 8 s per container
//!   before a death;
//! - runs start at most every 30 s.
//!
//! A launch would need a server that checks runs.
//!
//! Rules this file settles:
//! - A run **closes** on extract, on death, when the player starts another (it is abandoned and its cargo lost), or
//!   30 minutes after it started (it has timed out). Closed runs are deleted, so storage holds one run per player
//!   at most.
//! - **Wrecks in a manifest are reserved** for that run until it closes: nobody else is offered them. When storage
//!   is full, the sea takes the oldest wreck no open run holds.
//! - **Dying with a recovered wreck** folds its cargo into the new wreck. "The carried cargo becomes a wreck", so
//!   the earlier owner's claim goes down with it.

use std::collections::BTreeMap;

use near_sdk::json_types::U128;
use near_sdk::{AccountId, env, near};

use crate::items::*;
use crate::mt::{self, BurnLog, MintLog};
use crate::{Container, Holder, Run, Saltline, SaltlineExt, Wreck, err, fail, now_ms, pricing};

// -----------------------------------------------------------------------------------------------------------------
// Randomness
// -----------------------------------------------------------------------------------------------------------------

/// SplitMix64: small, fast and good enough to deal cards. Seeded from `env::random_seed()` for runs, and from the
/// caller's seed in `simulate` (so a seed always replays the same week).
pub struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Self {
        Rng(seed)
    }

    pub fn from_bytes(b: &[u8]) -> Self {
        let mut x = [0u8; 8];
        x.copy_from_slice(&b[..8]);
        Rng(u64::from_le_bytes(x))
    }

    pub fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    /// Uniform in 0..n (n > 0); the modulo bias is under 2⁻⁵⁸ for the small n used here.
    pub fn below(&mut self, n: u64) -> u64 {
        self.next_u64() % n
    }
}

/// What one sealed container holds: a cargo type by the loot odds, and an amount in its range.
pub fn roll_container(rng: &mut Rng) -> (usize, u32) {
    let mut pick = rng.below(LOOT_WEIGHT_TOTAL as u64) as u32;
    for l in LOOT.iter() {
        if pick < l.odds {
            let amount = l.min + rng.below((l.max - l.min + 1) as u64) as u32;
            return (l.token, amount);
        }
        pick -= l.odds;
    }
    unreachable!("loot odds sum to LOOT_WEIGHT_TOTAL")
}

/// Deal a manifest:
/// - up to `WRECKS_PER_RUN` wrecks from `eligible` (id, spot), at distinct spots;
/// - then `CONTAINERS_PER_RUN` distinct salvage spots out of the rest, each with a rolled container.
pub fn deal_manifest(rng: &mut Rng, eligible: &[(u64, u8)]) -> (Vec<Container>, Vec<u64>) {
    let mut pool: Vec<(u64, u8)> = eligible.to_vec();
    let mut wrecks = Vec::new();
    let mut taken = [false; SPOT_COUNT as usize];
    while wrecks.len() < WRECKS_PER_RUN as usize && !pool.is_empty() {
        let (id, spot) = pool.swap_remove(rng.below(pool.len() as u64) as usize);
        if !taken[spot as usize] {
            taken[spot as usize] = true;
            wrecks.push(id);
        }
    }
    let mut free: Vec<u8> = (0..SPOT_COUNT as u8).filter(|s| !taken[*s as usize]).collect();
    let mut containers = Vec::with_capacity(CONTAINERS_PER_RUN as usize);
    for _ in 0..CONTAINERS_PER_RUN.min(free.len() as u32) {
        let spot = free.swap_remove(rng.below(free.len() as u64) as usize);
        let (token, amount) = roll_container(rng);
        containers.push(Container { spot, token: token as u8, amount: amount as u8 });
    }
    containers.sort_by_key(|c| c.spot);
    (containers, wrecks)
}

pub(crate) fn expired(run: &Run, now: u64) -> bool {
    now >= run.started_at.saturating_add(RUN_EXPIRY_SECONDS * 1_000)
}

// -----------------------------------------------------------------------------------------------------------------
// JSON shapes
// -----------------------------------------------------------------------------------------------------------------

#[near(serializers = [json])]
pub struct ContainerView {
    pub spot: u32,
    pub token_id: String,
    pub amount: U128,
}

#[near(serializers = [json])]
pub struct WreckItem {
    pub token_id: String,
    pub amount: U128,
}

#[near(serializers = [json])]
pub struct WreckView {
    pub id: u64,
    pub spot: u32,
    pub owner: AccountId,
    pub callsign: String,
    pub items: Vec<WreckItem>,
    pub at: u64,
}

#[near(serializers = [json])]
pub struct ManifestView {
    pub run_id: u64,
    pub started_at: u64,
    pub containers: Vec<ContainerView>,
    pub wrecks: Vec<WreckView>,
}

#[near(serializers = [json])]
pub struct ExtractResult {
    pub minted: BTreeMap<String, U128>,
    pub haul_value: U128,
}

#[near(serializers = [json])]
pub struct DieResult {
    pub wreck_id: Option<u64>,
}

pub(crate) fn wreck_view(w: &Wreck) -> WreckView {
    WreckView {
        id: w.id,
        spot: w.spot as u32,
        owner: w.owner_id.clone(),
        callsign: w.callsign.clone(),
        items: w
            .items
            .iter()
            .map(|&(t, n)| WreckItem { token_id: ITEMS[t as usize].id.to_string(), amount: U128(n as u128) })
            .collect(),
        at: w.at,
    }
}

fn describe(items: &[u128; TOKEN_COUNT]) -> String {
    let parts: Vec<String> =
        CARGO.iter().filter(|&&t| items[t] > 0).map(|&t| format!("{} {}", items[t], ITEMS[t].id)).collect();
    if parts.is_empty() { "nothing".to_string() } else { parts.join(", ") }
}

/// What the run claims to carry, checked against its manifest.
struct Claim {
    /// Cargo from the containers opened.
    containers: [u128; TOKEN_COUNT],
    /// Indices into `self.wrecks` of the wrecks picked up.
    wrecks: Vec<usize>,
    opened: usize,
}

impl Saltline {
    /// The caller's open run, or the matching refusal.
    fn open_run(&self, ix: u32, run_id: u64, now: u64) -> &Run {
        if run_id == 0 || run_id >= self.next_run_id {
            fail(err::NO_RUN, format!("No run {run_id}"));
        }
        let run =
            self.runs.get(&run_id).unwrap_or_else(|| fail(err::RUN_CLOSED, format!("Run {run_id} is already closed")));
        if run.player != ix {
            fail(err::NO_RUN, format!("Run {run_id} isn't yours"));
        }
        if expired(run, now) {
            fail(err::RUN_CLOSED, format!("Run {run_id} timed out"));
        }
        run
    }

    /// Check a claim against the manifest: in it, once each, within the carry limit.
    fn check_claim(&self, run: &Run, opened: &[u32], wrecks: &[u64]) -> Claim {
        let mut containers = [0u128; TOKEN_COUNT];
        let mut weight: u64 = 0;
        let mut seen_spots: Vec<u32> = Vec::new();
        for &spot in opened {
            let c = run.containers.iter().find(|c| c.spot as u32 == spot).unwrap_or_else(|| {
                fail(err::NOT_IN_MANIFEST, format!("No sealed container at spot {spot} on this run"))
            });
            if seen_spots.contains(&spot) {
                fail(err::DUPLICATE, format!("Spot {spot} listed twice"));
            }
            seen_spots.push(spot);
            containers[c.token as usize] += c.amount as u128;
            weight += c.amount as u64 * ITEMS[c.token as usize].weight as u64;
        }
        let mut picked: Vec<usize> = Vec::new();
        let mut seen_wrecks: Vec<u64> = Vec::new();
        for &id in wrecks {
            if !run.wrecks.contains(&id) {
                fail(err::NOT_IN_MANIFEST, format!("Wreck {id} isn't on this run"));
            }
            if seen_wrecks.contains(&id) {
                fail(err::DUPLICATE, format!("Wreck {id} listed twice"));
            }
            seen_wrecks.push(id);
            // Reserved for this run, so it is still in the yard; fail closed if it somehow isn't.
            let at = self
                .wrecks
                .iter()
                .position(|w| w.id == id && w.reserved_by == Some(run.id))
                .unwrap_or_else(|| fail(err::NOT_IN_MANIFEST, format!("Wreck {id} is gone")));
            for &(t, n) in &self.wrecks[at].items {
                weight += n as u64 * ITEMS[t as usize].weight as u64;
            }
            picked.push(at);
        }
        if weight > CARRY_LIMIT as u64 {
            fail(err::OVER_LIMIT, format!("That's {weight} weight; the limit is {CARRY_LIMIT}"));
        }
        Claim { containers, wrecks: picked, opened: opened.len() }
    }

    /// Close a run: release the wrecks it still holds, delete it, clear the player's active run.
    pub(crate) fn close_run(&mut self, run_id: u64) {
        if let Some(run) = self.runs.remove(&run_id) {
            for w in self.wrecks.iter_mut().filter(|w| w.reserved_by == Some(run_id)) {
                w.reserved_by = None;
                w.reserved_until = 0;
            }
            let p = self.player_mut(run.player);
            if p.active_run == Some(run_id) {
                p.active_run = None;
            }
        }
    }

    /// Remove wrecks by index into `self.wrecks` (highest first, so the rest stay valid).
    fn take_wrecks(&mut self, mut at: Vec<usize>) -> Vec<Wreck> {
        at.sort_unstable_by(|a, b| b.cmp(a));
        at.into_iter().map(|i| self.wrecks.remove(i)).collect()
    }

    /// The best current bid for a cargo across the brokers that buy it (open or not): the value used for hauls and
    /// net worth.
    pub(crate) fn best_bid(&self, t: usize) -> u128 {
        (0..BROKER_COUNT)
            .filter(|&b| buys(b, t))
            .map(|b| pricing::bid_for(t, self.brokers[b].bal[t], self.brokers[b].stance))
            .max()
            .unwrap_or(0)
    }

    pub(crate) fn manifest_view(&self, run: &Run) -> ManifestView {
        ManifestView {
            run_id: run.id,
            started_at: run.started_at,
            containers: run
                .containers
                .iter()
                .map(|c| ContainerView {
                    spot: c.spot as u32,
                    token_id: ITEMS[c.token as usize].id.to_string(),
                    amount: U128(c.amount as u128),
                })
                .collect(),
            wrecks: run
                .wrecks
                .iter()
                .filter_map(|id| self.wrecks.iter().find(|w| w.id == *id))
                .map(wreck_view)
                .collect(),
        }
    }
}

#[near]
impl Saltline {
    /// Start a run: burn the equipped gear and deal a manifest. Abandons any run still open.
    pub fn start_run(&mut self, gear: Vec<String>) -> ManifestView {
        let ix = self.caller_player();
        let now = now_ms();
        let p = self.player(ix);
        let ready_at = p.last_run_at.saturating_add(RUN_GAP_SECONDS * 1_000);
        if p.runs > 0 && now < ready_at {
            fail(
                err::TOO_SOON,
                format!("Under {RUN_GAP_SECONDS} s since your last run. {} s to go", (ready_at - now).div_ceil(1_000)),
            );
        }
        let mut kit: Vec<usize> = Vec::new();
        for g in &gear {
            let t = token_index(g)
                .filter(|&t| is_gear(t))
                .unwrap_or_else(|| fail(err::NO_GEAR, format!("'{g}' isn't gear")));
            if kit.contains(&t) {
                fail(err::DUPLICATE, format!("{} listed twice", ITEMS[t].name));
            }
            if p.bal[t] == 0 {
                fail(err::NO_GEAR, format!("You have no {}", ITEMS[t].one));
            }
            kit.push(t);
        }
        let account = p.account_id.clone();
        let callsign = p.callsign.clone();
        if let Some(old) = p.active_run {
            self.close_run(old);
        }

        let mut burned = BurnLog::new(&account, Some("equipped"));
        for &t in &kit {
            self.burn(Holder::Player(ix), t, 1);
            burned.push(t, 1);
        }
        mt::emit_burn(vec![burned]);

        let id = self.next_run_id;
        self.next_run_id += 1;
        let mut seed_input = env::random_seed_array().to_vec();
        seed_input.extend_from_slice(&id.to_le_bytes());
        seed_input.extend_from_slice(account.as_bytes());
        let mut rng = Rng::from_bytes(&env::sha256_array(&seed_input));
        let eligible: Vec<(u64, u8)> =
            self.wrecks.iter().filter(|w| w.owner != ix && !w.reserved(now)).map(|w| (w.id, w.spot)).collect();
        let (containers, wreck_ids) = deal_manifest(&mut rng, &eligible);
        let until = now.saturating_add(RUN_EXPIRY_SECONDS * 1_000);
        for w in self.wrecks.iter_mut().filter(|w| wreck_ids.contains(&w.id)) {
            w.reserved_by = Some(id);
            w.reserved_until = until;
        }
        let run = Run { id, player: ix, started_at: now, containers, wrecks: wreck_ids };
        let view = self.manifest_view(&run);
        self.runs.insert(id, run);
        let p = self.player_mut(ix);
        p.active_run = Some(id);
        p.runs += 1;
        p.last_run_at = now;

        let kit_names: Vec<&str> = kit.iter().map(|&t| ITEMS[t].one).collect();
        let text = if kit.is_empty() {
            format!("{callsign} went over the fence light.")
        } else {
            format!("{callsign} went over the fence with {}.", kit_names.join(" and "))
        };
        let gear_ids: Vec<&str> = kit.iter().map(|&t| ITEMS[t].id).collect();
        self.record(
            "run_start",
            &account,
            Some(callsign),
            text,
            near_sdk::serde_json::json!({ "run_id": id, "gear": gear_ids }),
        );
        view
    }

    /// Reach the boat: mint what was carried. A recovered wreck pays 70% to the finder and 30% to whoever died.
    pub fn extract(&mut self, run_id: u64, opened: Vec<u32>, wrecks: Vec<u64>) -> ExtractResult {
        let ix = self.caller_player();
        let now = now_ms();
        let run = self.open_run(ix, run_id, now);
        let claim = self.check_claim(run, &opened, &wrecks);
        let min_ms = (MIN_RUN_SECONDS + PER_CONTAINER_SECONDS * claim.opened as u64) * 1_000;
        let elapsed = now.saturating_sub(run.started_at);
        if elapsed < min_ms {
            fail(
                err::TOO_SOON,
                format!("Too quick: {} s for {} containers needs {} s", elapsed / 1_000, claim.opened, min_ms / 1_000),
            );
        }

        let finder_id = self.player(ix).account_id.clone();
        let callsign = self.player(ix).callsign.clone();
        let mut mine = claim.containers;
        let mut owner_logs: Vec<MintLog> = Vec::new();
        let recovered = self.take_wrecks(claim.wrecks);
        let mut from_wrecks: Vec<String> = Vec::new();
        for w in &recovered {
            let mut owner_log = MintLog::new(&w.owner_id, Some("wreck recovered"));
            for &(t, n) in &w.items {
                let (finder, owner) = pricing::wreck_split(n as u128);
                mine[t as usize] += finder;
                if owner > 0 {
                    self.mint(Holder::Player(w.owner), t as usize, owner);
                    owner_log.push(t as usize, owner);
                }
            }
            owner_logs.push(owner_log);
            from_wrecks.push(w.callsign.clone());
        }

        let mut minted = BTreeMap::new();
        let mut log = MintLog::new(&finder_id, Some("salvage"));
        let mut haul: u128 = 0;
        for &t in CARGO.iter() {
            if mine[t] > 0 {
                self.mint(Holder::Player(ix), t, mine[t]);
                log.push(t, mine[t]);
                minted.insert(ITEMS[t].id.to_string(), U128(mine[t]));
                haul = haul.saturating_add(mine[t].saturating_mul(self.best_bid(t)));
            }
        }
        let mut logs = vec![log];
        logs.extend(owner_logs);
        mt::emit_mint(logs);

        self.close_run(run_id);
        let p = self.player_mut(ix);
        p.extractions += 1;
        p.best_haul = p.best_haul.max(haul);

        let mut text = format!("{callsign} made the boat with {}. Haul worth {haul}.", describe(&mine));
        if !from_wrecks.is_empty() {
            text = format!("{} Brought back {}'s wreck.", text.trim_end(), from_wrecks.join(" and "));
        }
        let wreck_ids: Vec<u64> = recovered.iter().map(|w| w.id).collect();
        self.record(
            "extract",
            &finder_id,
            Some(callsign),
            text,
            near_sdk::serde_json::json!({ "run_id": run_id, "minted": minted, "haul_value": U128(haul), "wrecks": wreck_ids }),
        );
        ExtractResult { minted, haul_value: U128(haul) }
    }

    /// Go down in the yard: what was carried becomes a wreck at `spot`, with the player's callsign on it.
    pub fn die(&mut self, run_id: u64, opened: Vec<u32>, wrecks: Vec<u64>, spot: u32) -> DieResult {
        let ix = self.caller_player();
        let now = now_ms();
        let run = self.open_run(ix, run_id, now);
        if spot >= SPOT_COUNT {
            fail(err::BAD_AMOUNT, format!("Spot {spot} is past the last salvage spot ({})", SPOT_COUNT - 1));
        }
        let claim = self.check_claim(run, &opened, &wrecks);
        let min_ms = PER_CONTAINER_SECONDS * claim.opened as u64 * 1_000;
        if now.saturating_sub(run.started_at) < min_ms {
            fail(err::TOO_SOON, format!("Too quick: {} containers take {} s to cut", claim.opened, min_ms / 1_000));
        }

        let mut carried = claim.containers;
        for w in self.take_wrecks(claim.wrecks) {
            for (t, n) in w.items {
                carried[t as usize] += n as u128;
            }
        }
        self.close_run(run_id);
        let p = self.player_mut(ix);
        p.deaths += 1;
        let owner_id = p.account_id.clone();
        let callsign = p.callsign.clone();

        let items: Vec<(u8, u32)> =
            CARGO.iter().filter(|&&t| carried[t] > 0).map(|&t| (t as u8, carried[t] as u32)).collect();
        let mut wreck_id = None;
        let text;
        if items.is_empty() {
            text = format!("{callsign} went down at spot {spot} carrying nothing.");
        } else {
            // Make room: the sea takes the oldest wreck no open run is holding.
            let mut room = self.wrecks.len() < MAX_WRECKS;
            if !room && let Some(i) = self.wrecks.iter().position(|w| !w.reserved(now)) {
                self.wrecks.remove(i);
                room = true;
            }
            if room {
                let id = self.next_wreck_id;
                self.next_wreck_id += 1;
                self.wrecks.push(Wreck {
                    id,
                    spot: spot as u8,
                    owner: ix,
                    owner_id: owner_id.clone(),
                    callsign: callsign.clone(),
                    items,
                    at: now,
                    reserved_by: None,
                    reserved_until: 0,
                });
                wreck_id = Some(id);
                text = format!("{callsign} went down at spot {spot}. {} left in the yard.", describe(&carried));
            } else {
                text = format!("{callsign} went down at spot {spot}. The sea took {}.", describe(&carried));
            }
        }
        self.record(
            "wreck",
            &owner_id,
            Some(callsign),
            text,
            near_sdk::serde_json::json!({ "run_id": run_id, "spot": spot, "wreck_id": wreck_id }),
        );
        DieResult { wreck_id }
    }

    pub fn manifest(&self, run_id: u64) -> Option<ManifestView> {
        self.runs.get(&run_id).map(|r| self.manifest_view(r))
    }

    /// Wrecks in the yard, newest first.
    pub fn wrecks(&self) -> Vec<WreckView> {
        self.wrecks.iter().rev().map(wreck_view).collect()
    }
}
