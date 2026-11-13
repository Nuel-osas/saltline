//! Raids on-chain (docs/CONTRACT_V2.md → Starting a raid, Ending a raid, Expiry): `start_raid`, `extract`, `die`,
//! manifests, wrecks and the impound.
//!
//! **The trust model, stated plainly:** what happens in the yard is reported by the client. The contract can't see
//! the fight. It proves what it can: the loadout was the caller's and is locked; every container and wreck claimed
//! is in the raid's manifest, once; the weight carried is within the limit; the raid lasted long enough for what it
//! claims; kills, parts and uplinks are within their caps; and the invoice follows from those facts and block time.
//! That the player reached the boat, where they died and what killed them are the client's word.
//!
//! Custody:
//! - Plates, charges and magazines brought on a raid are held by the contract account until the raid ends. Used
//!   ones are burned; unused ones go back to the player (`extract`), into the wreck (`die` by machines), or are
//!   burned (`die` by the Bailiff, or an abandoned raid).
//! - What lies in a wreck is held by the contract account: the cargo and parts are minted there when the player
//!   dies, and whoever carries the wreck out receives them by transfer.
//!
//! Rules this file settles that CONTRACT_V2.md leaves open:
//! - A raid **closes** on extract, on death, when the player starts another (it is abandoned: its gun returns and
//!   its other gear is lost), or RAID_EXPIRY_SECONDS after it started (it timed out, and is abandoned the next time
//!   the player calls anything).
//! - **Weight** is the opened cargo and the parts at their weights, plus 2 for each recovered wreck that holds a
//!   gun. A wreck's loose items add nothing.
//! - **`die` needs 8 s per container opened**, as `extract` does on top of its 45 s, so a death can't claim a full
//!   load in no time.
//! - **Dying with wrecks in hand** leaves them where they were: every wreck the raid had reserved is released.
//! - **A wreck is made** if there is a gun, cargo, parts or unused gear to leave. When all MAX_WRECKS places are
//!   held by open raids there is no room, and what would have been left is destroyed.
//! - **A raid is offered the newest wrecks** it may take: up to WRECKS_PER_RAID that aren't the caller's, haven't
//!   lapsed and aren't in another open raid's manifest. A wreck in a manifest doesn't lapse until that raid ends.
//! - **A gun's `raids`** goes up when its raid ends, in `extract` or `die`. An abandoned raid isn't counted.
//!   Dying doesn't wear the gun; being carried out of a wreck does.

use std::collections::BTreeMap;

use near_sdk::json_types::U128;
use near_sdk::{AccountId, env, near};

use crate::harbormaster::HarbormasterView;
use crate::items::*;
use crate::mt::{self, BurnLog, MintLog, TransferLog};
use crate::nft::WeaponView;
use crate::{
    Container, HELD, Holder, IMPOUNDED, IN_RAID, IN_WRECK, Raid, Saltline, SaltlineExt, Wreck, add, err, fail, now_ms,
};

// -----------------------------------------------------------------------------------------------------------------
// The manifest
// -----------------------------------------------------------------------------------------------------------------

/// What one sealed container holds: a material by the loot odds, and an amount in its range.
pub fn roll_container(rng: &mut Rng) -> (usize, u32) {
    let mut pick = rng.below(LOOT_TOTAL as u64) as u32;
    for &(token, chance, min, max) in CONTAINER_LOOT.iter() {
        if pick < chance {
            return (token, min + rng.below((max - min + 1) as u64) as u32);
        }
        pick -= chance;
    }
    unreachable!("loot chances sum to LOOT_TOTAL")
}

/// Deal a manifest around the wrecks already attached to the raid, given as (id, spot):
/// - CONTAINERS distinct spots that no attached wreck lies on, each with a rolled container;
/// - then, for a player in heavy arrears, BONDED more spots holding BONDED_UNITS of a bonded material.
pub fn deal_manifest(rng: &mut Rng, wrecks: &[(u64, u8)], bonded: bool) -> Vec<Container> {
    let mut taken = [false; SPOT_COUNT as usize];
    for &(_, spot) in wrecks {
        if (spot as u32) < SPOT_COUNT {
            taken[spot as usize] = true;
        }
    }
    let mut free: Vec<u8> = (0..SPOT_COUNT as u8).filter(|s| !taken[*s as usize]).collect();
    let mut containers = Vec::with_capacity((CONTAINERS + BONDED) as usize);
    for _ in 0..CONTAINERS.min(free.len() as u32) {
        let spot = free.swap_remove(rng.below(free.len() as u64) as usize);
        let (token, amount) = roll_container(rng);
        containers.push(Container { spot, token: token as u8, amount: amount as u8, bonded: false });
    }
    if bonded {
        for _ in 0..BONDED.min(free.len() as u32) {
            let spot = free.swap_remove(rng.below(free.len() as u64) as usize);
            let token = BONDED_LOOT[rng.below(BONDED_LOOT.len() as u64) as usize];
            containers.push(Container { spot, token: token as u8, amount: BONDED_UNITS as u8, bonded: true });
        }
    }
    containers.sort_by_key(|c| c.spot);
    containers
}

pub(crate) fn expired(raid: &Raid, now: u64) -> bool {
    now >= raid.started_at.saturating_add(RAID_EXPIRY_SECONDS * 1_000)
}

// -----------------------------------------------------------------------------------------------------------------
// JSON shapes
// -----------------------------------------------------------------------------------------------------------------

#[near(serializers = [json])]
#[derive(Clone, Default)]
pub struct Loadout {
    /// A serial, or null for the issue rifle.
    pub weapon: Option<String>,
    pub plates: u32,
    pub charges: u32,
    pub mags: u32,
}

#[near(serializers = [json])]
#[derive(Clone, Default)]
pub struct Parts {
    pub servo: u32,
    pub rotor: u32,
}

#[near(serializers = [json])]
#[derive(Clone, Default)]
pub struct Kills {
    pub gull: u32,
    pub hound: u32,
}

#[near(serializers = [json])]
#[derive(Clone, Default)]
pub struct Used {
    pub plates: u32,
    pub charges: u32,
    pub mags: u32,
}

/// What the game reports when a raid ends.
#[near(serializers = [json])]
#[derive(Clone, Default)]
pub struct Report {
    pub opened: Vec<u32>,
    pub wrecks: Vec<u64>,
    pub parts: Parts,
    pub kills: Kills,
    pub uplinks: u32,
    /// Of the plates, charges and magazines brought (the three issued magazines aren't counted).
    pub used: Used,
}

#[near(serializers = [json])]
pub struct ContainerView {
    pub spot: u32,
    pub token_id: String,
    pub amount: U128,
    pub bonded: bool,
}

#[near(serializers = [json])]
pub struct ItemAmount {
    pub token_id: String,
    pub amount: U128,
}

#[near(serializers = [json])]
pub struct WreckView {
    pub id: u64,
    pub spot: u32,
    pub owner: AccountId,
    pub callsign: String,
    pub weapon: Option<WeaponView>,
    pub items: Vec<ItemAmount>,
    pub at: u64,
    pub expires_at: u64,
}

#[near(serializers = [json])]
pub struct RaidView {
    pub raid_id: u64,
    pub started_at: u64,
    pub loadout: Loadout,
    pub containers: Vec<ContainerView>,
    pub wrecks: Vec<WreckView>,
    pub invoice_start: U128,
    pub harbormaster: HarbormasterView,
}

#[near(serializers = [json])]
pub struct ExtractResult {
    /// Everything the raid brought the caller: cargo, parts and the items out of recovered wrecks.
    pub minted: BTreeMap<String, U128>,
    pub weapon: Option<WeaponView>,
    pub recovered: Vec<WeaponView>,
    pub invoice: U128,
    pub arrears: U128,
}

#[near(serializers = [json])]
pub struct DieResult {
    pub wreck_id: Option<u64>,
    pub impounded: bool,
    pub invoice: U128,
    pub arrears: U128,
}

/// A report, checked against its raid.
struct Checked {
    /// Cargo from the containers opened, and the parts.
    cargo: [u128; TOKEN_COUNT],
    /// Indices into `self.wrecks` of the wrecks picked up.
    wrecks: Vec<usize>,
    opened: u32,
    invoice: u128,
}

fn describe(items: &[u128; TOKEN_COUNT]) -> String {
    let parts: Vec<String> = (0..TOKEN_COUNT).filter(|&t| items[t] > 0).map(|t| count(t, items[t])).collect();
    if parts.is_empty() { "nothing".to_string() } else { parts.join(", ") }
}

impl Saltline {
    /// The caller's open raid, or the matching refusal.
    fn open_raid(&self, ix: u32, raid_id: u64, now: u64) -> &Raid {
        if raid_id == 0 || raid_id >= self.next_raid_id {
            fail(err::NO_RAID, format!("No raid {raid_id}"));
        }
        let raid = self
            .raids
            .get(&raid_id)
            .unwrap_or_else(|| fail(err::RAID_CLOSED, format!("Raid {raid_id} is already closed")));
        if raid.player != ix {
            fail(err::NO_RAID, format!("Raid {raid_id} isn't yours"));
        }
        if expired(raid, now) {
            fail(err::RAID_CLOSED, format!("Raid {raid_id} timed out"));
        }
        raid
    }

    /// Check a report against its raid (CONTRACT_V2.md → Ending a raid) and price the invoice.
    fn check_report(&self, raid: &Raid, r: &Report, now: u64) -> Checked {
        let mut cargo = [0u128; TOKEN_COUNT];
        let mut weight: u64 = 0;
        let mut seen = [false; SPOT_COUNT as usize];
        for &spot in &r.opened {
            let c = raid.containers.iter().find(|c| c.spot as u32 == spot).unwrap_or_else(|| {
                fail(err::NOT_IN_MANIFEST, format!("No sealed container at spot {spot} on this raid"))
            });
            if seen[c.spot as usize] {
                fail(err::DUPLICATE, format!("Spot {spot} listed twice"));
            }
            seen[c.spot as usize] = true;
            cargo[c.token as usize] += c.amount as u128;
            weight += c.amount as u64 * TOKENS[c.token as usize].weight as u64;
        }
        let mut picked: Vec<usize> = Vec::new();
        let mut seen_wrecks: Vec<u64> = Vec::new();
        for &id in &r.wrecks {
            if !raid.wrecks.contains(&id) {
                fail(err::NOT_IN_MANIFEST, format!("Wreck {id} isn't on this raid"));
            }
            if seen_wrecks.contains(&id) {
                fail(err::DUPLICATE, format!("Wreck {id} listed twice"));
            }
            seen_wrecks.push(id);
            // Reserved for this raid, so it is still in the yard; fail closed if it somehow isn't.
            let at = self
                .wrecks
                .iter()
                .position(|w| w.id == id && w.reserved_by == Some(raid.id))
                .unwrap_or_else(|| fail(err::NOT_IN_MANIFEST, format!("Wreck {id} is gone")));
            if self.wrecks[at].gun.is_some() {
                weight += GUN_WEIGHT as u64;
            }
            picked.push(at);
        }

        let seconds = now.saturating_sub(raid.started_at) / 1_000;
        if r.uplinks > MAX_UPLINKS {
            fail(err::BAD_REPORT, format!("There are only {MAX_UPLINKS} uplinks"));
        }
        if r.kills.gull > MAX_KILLS_GULL || r.kills.hound > MAX_KILLS_HOUND {
            fail(err::BAD_REPORT, format!("At most {MAX_KILLS_GULL} gulls and {MAX_KILLS_HOUND} hounds count"));
        }
        let kills = (r.kills.gull + r.kills.hound) as u64;
        if kills > seconds / SECONDS_PER_KILL {
            fail(
                err::BAD_REPORT,
                format!("{kills} machines in {seconds} s is more than one every {SECONDS_PER_KILL} s"),
            );
        }
        if r.parts.servo > r.kills.hound || r.parts.rotor > r.kills.gull {
            fail(err::BAD_REPORT, "More parts than machines destroyed");
        }
        if r.used.plates > raid.plates as u32 || r.used.charges > raid.charges as u32 || r.used.mags > raid.mags as u32
        {
            fail(err::BAD_REPORT, "More gear used than was brought");
        }
        cargo[SERVO] += r.parts.servo as u128;
        cargo[ROTOR] += r.parts.rotor as u128;
        weight +=
            r.parts.servo as u64 * TOKENS[SERVO].weight as u64 + r.parts.rotor as u64 * TOKENS[ROTOR].weight as u64;
        if weight > CARRY_LIMIT as u64 {
            fail(err::OVER_LIMIT, format!("That's {weight} weight; the limit is {CARRY_LIMIT}"));
        }
        let opened = r.opened.len() as u32;
        let invoice = invoice_total(&InvoiceFacts {
            start: raid.invoice_start,
            seconds,
            seals: opened,
            weight: weight as u32,
            uplinks: r.uplinks,
            gulls: r.kills.gull,
            hounds: r.kills.hound,
        });
        Checked { cargo, wrecks: picked, opened, invoice }
    }

    /// Close a raid: release the wrecks it still holds, delete it, clear the player's active raid.
    fn close_raid(&mut self, raid_id: u64) -> Option<Raid> {
        let raid = self.raids.remove(&raid_id)?;
        for w in self.wrecks.iter_mut().filter(|w| w.reserved_by == Some(raid_id)) {
            w.reserved_by = None;
            w.reserved_until = 0;
        }
        let p = self.player_mut(raid.player);
        if p.active_raid == Some(raid_id) {
            p.active_raid = None;
        }
        Some(raid)
    }

    /// Abandon a raid (a new one started, or it timed out): its gun returns as it was, its other gear is lost.
    pub(crate) fn abandon(&mut self, raid_id: u64) {
        let Some(raid) = self.close_raid(raid_id) else { return };
        self.burn_kit(&raid, raid.plates as u128, raid.charges as u128, raid.mags as u128, "abandoned");
        if let Some(n) = raid.gun
            && let Some(g) = self.guns.get_mut(&n)
            && g.state == IN_RAID
        {
            g.state = HELD;
        }
    }

    /// Burn plates, charges and magazines out of a raid's kit (held by the contract account).
    fn burn_kit(&mut self, _raid: &Raid, plates: u128, charges: u128, mags: u128, memo: &str) {
        let mut log = BurnLog::new(&env::current_account_id(), Some(memo));
        for (t, n) in [(PLATE, plates), (CHARGE, charges), (AMMO, mags)] {
            if n > 0 {
                self.burn(Holder::Pool, t, n);
                log.push(t, n);
            }
        }
        mt::emit_burn(vec![log]);
    }

    /// Remove wrecks by index into `self.wrecks` (highest first, so the rest stay valid).
    fn take_wrecks(&mut self, mut at: Vec<usize>) -> Vec<Wreck> {
        at.sort_unstable_by(|a, b| b.cmp(a));
        at.into_iter().map(|i| self.wrecks.remove(i)).collect()
    }

    /// Burn a wreck's gun and items.
    fn destroy_wreck(&mut self, w: Wreck, memo: &str) {
        let mut log = BurnLog::new(&env::current_account_id(), Some(memo));
        for &(t, n) in &w.items {
            self.burn(Holder::Pool, t as usize, n as u128);
            log.push(t as usize, n as u128);
        }
        mt::emit_burn(vec![log]);
        if let Some(n) = w.gun {
            self.burn_gun(n, memo);
        }
    }

    /// Lazy expiry: burn wrecks past their 24 hours that no open raid holds, at most SWEEP_PER_CALL a call.
    pub(crate) fn sweep_wrecks(&mut self, now: u64) {
        for _ in 0..SWEEP_PER_CALL {
            let Some(i) = self.wrecks.iter().position(|w| w.dead(now)) else { break };
            let w = self.wrecks.remove(i);
            self.destroy_wreck(w, "wreck lapsed");
        }
    }

    pub(crate) fn wreck_view(&self, w: &Wreck) -> WreckView {
        WreckView {
            id: w.id,
            spot: w.spot as u32,
            owner: w.owner_id.clone(),
            callsign: w.callsign.clone(),
            weapon: w.gun.and_then(|n| self.guns.get(&n)).map(|g| self.weapon_view(g)),
            items: w
                .items
                .iter()
                .map(|&(t, n)| ItemAmount { token_id: TOKENS[t as usize].id.to_string(), amount: U128(n as u128) })
                .collect(),
            at: w.at,
            expires_at: w.expires_at,
        }
    }

    pub(crate) fn raid_view(&self, raid: &Raid) -> RaidView {
        RaidView {
            raid_id: raid.id,
            started_at: raid.started_at,
            loadout: Loadout {
                weapon: raid.gun.map(serial_text),
                plates: raid.plates as u32,
                charges: raid.charges as u32,
                mags: raid.mags as u32,
            },
            containers: raid
                .containers
                .iter()
                .map(|c| ContainerView {
                    spot: c.spot as u32,
                    token_id: TOKENS[c.token as usize].id.to_string(),
                    amount: U128(c.amount as u128),
                    bonded: c.bonded,
                })
                .collect(),
            wrecks: raid
                .wrecks
                .iter()
                .filter_map(|id| self.wrecks.iter().find(|w| w.id == *id))
                .map(|w| self.wreck_view(w))
                .collect(),
            invoice_start: U128(raid.invoice_start),
            harbormaster: self.hm_view(now_ms()),
        }
    }
}

#[near]
impl Saltline {
    /// Go over the fence: lock the loadout, deal a manifest, reserve its wrecks. Abandons any raid still open.
    pub fn start_raid(&mut self, loadout: Loadout) -> RaidView {
        let ix = self.caller_player();
        let now = now_ms();
        let p = self.player(ix);
        let ready_at = p.last_raid_at.saturating_add(SECONDS_BETWEEN_RAIDS * 1_000);
        if p.raids > 0 && now < ready_at {
            let wait = (ready_at - now).div_ceil(1_000);
            fail(err::TOO_SOON, format!("Under {SECONDS_BETWEEN_RAIDS} s since your last raid. {wait} s to go"));
        }
        if loadout.plates > MAX_PLATES || loadout.charges > MAX_CHARGES || loadout.mags > MAX_MAGS {
            fail(
                err::BAD_AMOUNT,
                format!("A raid takes at most {MAX_PLATES} plate, {MAX_CHARGES} charges and {MAX_MAGS} magazines"),
            );
        }
        let (me, callsign) = self.who(ix);
        let (extractions, arrears) = (p.extractions, p.arrears);
        if let Some(old) = p.active_raid {
            self.abandon(old);
        }

        // The gun: the caller's, in hand, and not worn out. None is the issue rifle.
        let gun = loadout.weapon.as_deref().map(|serial| {
            let n = self.own_held(ix, serial);
            if self.gun(n).condition == 0 {
                fail(err::WORN_OUT, format!("{serial} is worn out. It can only be scrapped"));
            }
            n
        });
        // The kit: held by the contract until the raid ends.
        let h = Holder::Player(ix);
        let pool_id = env::current_account_id();
        let brought =
            [(PLATE, loadout.plates as u128), (CHARGE, loadout.charges as u128), (AMMO, loadout.mags as u128)];
        for (t, n) in brought {
            if self.balance(h, t) < n {
                fail(err::FUNDS, format!("You don't have {}", count(t, n)));
            }
        }
        let mut kit = TransferLog::new(&me, &pool_id, Some("raid kit"));
        for (t, n) in brought {
            if n > 0 {
                self.move_tokens(h, Holder::Pool, t, n);
                kit.push(t, n);
            }
        }
        mt::emit_transfer(vec![kit]);
        if let Some(n) = gun {
            let g = self.gun_mut(n);
            g.state = IN_RAID;
        }

        self.sweep_wrecks(now);
        let id = self.next_raid_id;
        self.next_raid_id += 1;
        let mut seed = env::random_seed_array().to_vec();
        seed.extend_from_slice(&id.to_le_bytes());
        seed.extend_from_slice(me.as_bytes());
        let mut rng = Rng::from_bytes(&env::sha256_array(&seed));
        // The newest wrecks that aren't the caller's, haven't lapsed and aren't in another open raid's manifest.
        let attached: Vec<(u64, u8)> = self
            .wrecks
            .iter()
            .rev()
            .filter(|w| w.owner != ix && now < w.expires_at && !w.reserved(now))
            .take(WRECKS_PER_RAID as usize)
            .map(|w| (w.id, w.spot))
            .collect();
        let containers = deal_manifest(&mut rng, &attached, arrears >= BONDED_AT);
        let wreck_ids: Vec<u64> = attached.iter().map(|w| w.0).collect();
        let until = now.saturating_add(RAID_EXPIRY_SECONDS * 1_000);
        for w in self.wrecks.iter_mut().filter(|w| wreck_ids.contains(&w.id)) {
            w.reserved_by = Some(id);
            w.reserved_until = until;
        }
        let raid = Raid {
            id,
            player: ix,
            started_at: now,
            gun,
            plates: loadout.plates as u8,
            charges: loadout.charges as u8,
            mags: loadout.mags as u8,
            containers,
            wrecks: wreck_ids,
            invoice_start: invoice_start(extractions, arrears),
        };
        let view = self.raid_view(&raid);
        let invoice = raid.invoice_start;
        self.raids.insert(id, raid);
        let p = self.player_mut(ix);
        p.active_raid = Some(id);
        p.raids += 1;
        p.last_raid_at = now;

        let with = match gun {
            Some(n) => format!("a {}", self.gun(n).label()),
            None => "the issue rifle".to_string(),
        };
        let text = format!("{callsign} went over the fence with {with}. {invoice} on the invoice.");
        self.record(
            "raid_start",
            &me,
            Some(callsign),
            text,
            near_sdk::serde_json::json!({ "raid_id": id, "weapon": gun.map(serial_text), "invoice_start": U128(invoice) }),
        );
        view
    }

    /// Reach the boat: mint the cargo and parts, hand back the gun (worn) and unused kit, and take ownership of
    /// every wreck carried out. A quarter of the invoice becomes arrears.
    pub fn extract(&mut self, raid_id: u64, report: Report) -> ExtractResult {
        let ix = self.caller_player();
        let now = now_ms();
        let c = {
            let raid = self.open_raid(ix, raid_id, now);
            let c = self.check_report(raid, &report, now);
            let min_ms = (MIN_SECONDS + PER_CONTAINER_SECONDS * c.opened as u64) * 1_000;
            let elapsed = now.saturating_sub(raid.started_at);
            if elapsed < min_ms {
                fail(
                    err::TOO_SOON,
                    format!("Too quick: {} s for {} containers needs {} s", elapsed / 1_000, c.opened, min_ms / 1_000),
                );
            }
            c
        };
        let raid = self.close_raid(raid_id).unwrap_or_else(|| fail(err::RAID_CLOSED, "Raid already closed"));
        let (me, callsign) = self.who(ix);
        let h = Holder::Player(ix);
        let pool_id = env::current_account_id();

        // Cargo and parts: new tokens.
        let mut gained = c.cargo;
        let mut salvage = MintLog::new(&me, Some("salvage"));
        for t in 0..TOKEN_COUNT {
            if c.cargo[t] > 0 {
                self.mint(h, t, c.cargo[t]);
                salvage.push(t, c.cargo[t]);
            }
        }
        mt::emit_mint(vec![salvage]);

        // The kit: used gear is gone, the rest comes home.
        let u = &report.used;
        self.burn_kit(&raid, u.plates as u128, u.charges as u128, u.mags as u128, "used on the raid");
        let mut back = TransferLog::new(&pool_id, &me, Some("raid kit returned"));
        for (t, brought, used) in [
            (PLATE, raid.plates as u32, u.plates),
            (CHARGE, raid.charges as u32, u.charges),
            (AMMO, raid.mags as u32, u.mags),
        ] {
            let left = (brought - used) as u128;
            if left > 0 {
                self.move_tokens(Holder::Pool, h, t, left);
                back.push(t, left);
            }
        }

        // The gun comes home worn.
        let weapon = raid.gun.map(|n| {
            let g = self.gun_mut(n);
            g.state = HELD;
            g.condition = g.condition.saturating_sub(CONDITION_PER_RAID);
            g.raids += 1;
            g.extractions += 1;
            self.weapon_of(n)
        });

        // Wrecks carried out: their guns change owner, their items come out of the contract's keeping.
        let mut recovered = Vec::new();
        let mut recoveries = Vec::new();
        for w in self.take_wrecks(c.wrecks) {
            for &(t, n) in &w.items {
                self.move_tokens(Holder::Pool, h, t as usize, n as u128);
                back.push(t as usize, n as u128);
                gained[t as usize] += n as u128;
            }
            if let Some(n) = w.gun {
                self.room_for_gun(h);
                self.give_gun(n, h, "recovered from a wreck");
                let g = self.gun_mut(n);
                g.state = HELD;
                g.recovered += 1;
                g.condition = g.condition.saturating_sub(CONDITION_RECOVERED);
                g.hold_until = 0;
                recoveries.push((w.id, w.owner_id.clone(), w.callsign.clone(), self.gun(n).label()));
                recovered.push(self.weapon_of(n));
            }
        }
        mt::emit_transfer(vec![back]);

        let p = self.player_mut(ix);
        p.extractions += 1;
        p.arrears = add(p.arrears, c.invoice * ARREARS_ON_EXTRACT_PCT / 100);
        let arrears = p.arrears;

        let minted: BTreeMap<String, U128> =
            (0..TOKEN_COUNT).filter(|&t| gained[t] > 0).map(|t| (TOKENS[t].id.to_string(), U128(gained[t]))).collect();
        let text = format!("{callsign} made the boat with {}. The invoice came to {}.", describe(&gained), c.invoice);
        self.record(
            "extract",
            &me,
            Some(callsign.clone()),
            text,
            near_sdk::serde_json::json!({ "raid_id": raid_id, "minted": minted, "invoice": U128(c.invoice), "arrears": U128(arrears) }),
        );
        for (wreck_id, from, from_callsign, label) in recoveries {
            let text = format!("{callsign} carried {from_callsign}'s {label} out of the yard. It is {callsign}'s now.");
            self.record(
                "recover",
                &me,
                Some(callsign.clone()),
                text,
                near_sdk::serde_json::json!({ "raid_id": raid_id, "wreck_id": wreck_id, "from": from }),
            );
        }
        ExtractResult { minted, weapon, recovered, invoice: U128(c.invoice), arrears: U128(arrears) }
    }

    /// Go down in the yard.
    /// - `by: "machines"`: the gun, the cargo and parts carried and the unused kit become a wreck at `spot`.
    /// - `by: "bailiff"`: the gun is impounded for 48 hours; everything else is destroyed.
    ///
    /// A tenth of the invoice becomes arrears.
    pub fn die(&mut self, raid_id: u64, report: Report, spot: u32, by: String) -> DieResult {
        let ix = self.caller_player();
        let now = now_ms();
        let bailiff = match by.as_str() {
            "machines" => false,
            "bailiff" => true,
            _ => fail(err::BAD_REPORT, "by is 'machines' or 'bailiff'"),
        };
        if spot >= SPOT_COUNT {
            fail(err::BAD_REPORT, format!("Spot {spot} is past the last salvage spot ({})", SPOT_COUNT - 1));
        }
        let c = {
            let raid = self.open_raid(ix, raid_id, now);
            let c = self.check_report(raid, &report, now);
            let min_ms = PER_CONTAINER_SECONDS * c.opened as u64 * 1_000;
            if now.saturating_sub(raid.started_at) < min_ms {
                fail(err::TOO_SOON, format!("Too quick: {} containers take {} s to cut", c.opened, min_ms / 1_000));
            }
            c
        };
        let raid = self.close_raid(raid_id).unwrap_or_else(|| fail(err::RAID_CLOSED, "Raid already closed"));
        let (me, callsign) = self.who(ix);
        let pool_id = env::current_account_id();
        let u = &report.used;
        let left = [
            (PLATE, (raid.plates as u32 - u.plates) as u128),
            (CHARGE, (raid.charges as u32 - u.charges) as u128),
            (AMMO, (raid.mags as u32 - u.mags) as u128),
        ];

        // The raid counts on the gun's record however it ended. Dying wears nothing.
        if let Some(n) = raid.gun {
            self.gun_mut(n).raids += 1;
        }
        let mut wreck_id = None;
        let mut impounded = false;
        if bailiff {
            // Everything but the gun is destroyed.
            self.burn_kit(&raid, raid.plates as u128, raid.charges as u128, raid.mags as u128, "seized by the Bailiff");
            if let Some(n) = raid.gun {
                let until = now.saturating_add(IMPOUND_HOURS * HOUR_MS);
                let g = self.gun_mut(n);
                let fee = g.value() * BUY_BACK_PCT / 100;
                g.state = IMPOUNDED;
                g.hold_until = until;
                g.fee = fee;
                let label = g.label();
                self.player_mut(ix).impounded.push((n, until));
                impounded = true;
                let text = format!(
                    "The Bailiff took {callsign}'s {label}. {fee} scrip buys it back within {IMPOUND_HOURS} hours."
                );
                self.record(
                    "impound",
                    &me,
                    Some(callsign.clone()),
                    text,
                    near_sdk::serde_json::json!({ "raid_id": raid_id, "serial": serial_text(n), "fee": U128(fee), "expires_at": until }),
                );
            } else {
                let text = format!("The Bailiff caught {callsign} at spot {spot}. Nothing worth impounding.");
                self.record(
                    "wreck",
                    &me,
                    Some(callsign.clone()),
                    text,
                    near_sdk::serde_json::json!({ "raid_id": raid_id, "spot": spot, "wreck_id": null, "by": "bailiff" }),
                );
            }
        } else {
            self.burn_kit(&raid, u.plates as u128, u.charges as u128, u.mags as u128, "used on the raid");
            let mut carried = c.cargo;
            for (t, n) in left {
                carried[t] += n;
            }
            let label = raid.gun.map(|n| self.gun(n).label());
            let text;
            if raid.gun.is_none() && carried.iter().all(|&n| n == 0) {
                text = format!("{callsign} went down at spot {spot} with nothing to leave.");
            } else {
                // Make room: lapsed wrecks first, then the oldest wreck no open raid is holding.
                self.sweep_wrecks(now);
                let mut room = self.wrecks.len() < MAX_WRECKS;
                if !room && let Some(i) = self.wrecks.iter().position(|w| !w.reserved(now)) {
                    let w = self.wrecks.remove(i);
                    self.destroy_wreck(w, "the sea took it");
                    room = true;
                }
                let left_behind = match &label {
                    Some(l) => format!("a {l} and {}", describe(&carried)),
                    None => describe(&carried),
                };
                if room {
                    // The cargo and parts exist from here on, in the contract's keeping.
                    let mut cargo = MintLog::new(&pool_id, Some("left in a wreck"));
                    for t in 0..TOKEN_COUNT {
                        if c.cargo[t] > 0 {
                            self.mint(Holder::Pool, t, c.cargo[t]);
                            cargo.push(t, c.cargo[t]);
                        }
                    }
                    mt::emit_mint(vec![cargo]);
                    let expires_at = now.saturating_add(WRECK_HOURS * HOUR_MS);
                    if let Some(n) = raid.gun {
                        let g = self.gun_mut(n);
                        g.state = IN_WRECK;
                        g.hold_until = expires_at;
                    }
                    let id = self.next_wreck_id;
                    self.next_wreck_id += 1;
                    self.wrecks.push(Wreck {
                        id,
                        spot: spot as u8,
                        owner: ix,
                        owner_id: me.clone(),
                        callsign: callsign.clone(),
                        gun: raid.gun,
                        items: (0..TOKEN_COUNT)
                            .filter(|&t| carried[t] > 0)
                            .map(|t| (t as u8, carried[t] as u32))
                            .collect(),
                        at: now,
                        expires_at,
                        reserved_by: None,
                        reserved_until: 0,
                    });
                    wreck_id = Some(id);
                    text = format!("{callsign} went down at spot {spot}. {left_behind} left in a wreck.");
                } else {
                    // No room in the yard: the unused kit and the gun are destroyed, the cargo never exists.
                    self.burn_kit(&raid, left[0].1, left[1].1, left[2].1, "the sea took it");
                    if let Some(n) = raid.gun {
                        self.burn_gun(n, "the sea took it");
                    }
                    text = format!("{callsign} went down at spot {spot}. The sea took {left_behind}.");
                }
            }
            self.record(
                "wreck",
                &me,
                Some(callsign.clone()),
                text,
                near_sdk::serde_json::json!({ "raid_id": raid_id, "spot": spot, "wreck_id": wreck_id, "by": "machines" }),
            );
        }

        let p = self.player_mut(ix);
        p.deaths += 1;
        p.arrears = add(p.arrears, c.invoice * ARREARS_ON_DEATH_PCT / 100);
        let arrears = p.arrears;
        DieResult { wreck_id, impounded, invoice: U128(c.invoice), arrears: U128(arrears) }
    }

    /// An open raid's manifest, or null once it has closed.
    pub fn raid(&self, raid_id: u64) -> Option<RaidView> {
        self.raids.get(&raid_id).filter(|r| !expired(r, now_ms())).map(|r| self.raid_view(r))
    }

    /// Wrecks in the yard, newest first. Ones past their 24 hours are left out.
    pub fn wrecks(&self) -> Vec<WreckView> {
        let now = now_ms();
        self.wrecks.iter().rev().filter(|w| now < w.expires_at).map(|w| self.wreck_view(w)).collect()
    }
}
