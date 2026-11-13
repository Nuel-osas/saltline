//! Unit tests against the mocked blockchain (`near_sdk::test_utils`). They drive the contract's calls the way the
//! game does. A refused call panics; on chain that reverts the call, here the test only looks at the message.

use std::collections::BTreeSet;
use std::panic::{AssertUnwindSafe, catch_unwind};

use near_sdk::json_types::U128;
use near_sdk::test_utils::{VMContextBuilder, get_logs};
use near_sdk::{AccountId, NearToken, testing_env};

use crate::items::*;
use crate::market::sale_split;
use crate::mt::total_held;
use crate::raids::{Kills, Loadout, Parts, RaidView, Report, Used, deal_manifest};
use crate::{HELD, Holder, IMPOUNDED, IN_RAID, IN_WRECK, LISTED, Saltline, VendorAccounts};

const CONTRACT: &str = "v2.saltline.testnet";
const OWNER: &str = "owner.testnet";
const FAUCET: &str = "faucet.saltline.testnet";
const HM: &str = "harbormaster.saltline.testnet";
const MOSS_ACC: &str = "moss.saltline.testnet";
const INES_ACC: &str = "ines.saltline.testnet";
const STRANGER: &str = "stranger.testnet";
const ROOK: &str = "rook.testnet";
const MARLOWE: &str = "marlowe.testnet";
const VANE: &str = "vane.testnet";
const START: u64 = 1_800_000_000_000; // ms
const HOUR: u64 = 3_600;

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}

fn context(who: &str, now_ms: u64, deposit: u128, seed: u8) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(acc(CONTRACT))
        .predecessor_account_id(acc(who))
        .signer_account_id(acc(who))
        .block_timestamp(now_ms * 1_000_000)
        .random_seed([seed; 32])
        .attached_deposit(NearToken::from_yoctonear(deposit));
    testing_env!(b.build());
}

/// The refusal a call ends in (`E_CODE: message`), or None if it went through. The mocked chain wraps a contract
/// panic as `HostError(GuestPanic { panic_msg: "…" })`; this unwraps it.
fn refusal<R>(f: impl FnOnce() -> R) -> Option<String> {
    let err = catch_unwind(AssertUnwindSafe(f)).err()?;
    let msg = err
        .downcast_ref::<String>()
        .cloned()
        .or_else(|| err.downcast_ref::<&str>().map(|s| s.to_string()))
        .unwrap_or_default();
    Some(match msg.split_once("panic_msg: \"") {
        Some((_, rest)) => rest.rsplit_once("\" }").map(|x| x.0).unwrap_or(rest).to_string(),
        None => msg,
    })
}

/// Assert the call is refused with `code`.
fn refuses<R>(code: &str, f: impl FnOnce() -> R) {
    match refusal(f) {
        None => panic!("expected a refusal with {code}, but the call went through"),
        Some(msg) => assert!(msg.starts_with(&format!("{code}: ")), "expected {code}, got: {msg}"),
    }
}

struct World {
    c: Saltline,
    now: u64,
    seed: u8,
}

impl World {
    fn new() -> Self {
        // `testing_env!` carries storage from one context to the next, which is what lets a test make several
        // calls. A new world starts from nothing, so drop whatever an earlier world in this test wrote.
        near_sdk::mock::with_mocked_blockchain(|b| b.take_storage());
        context(CONTRACT, START, 0, 7);
        let c = Saltline::new(
            acc(OWNER),
            acc(FAUCET),
            acc(HM),
            VendorAccounts { moss: acc(MOSS_ACC), ines: acc(INES_ACC) },
        );
        World { c, now: START, seed: 7 }
    }
    fn as_(&mut self, who: &str) -> &mut Saltline {
        context(who, self.now, 0, self.seed);
        &mut self.c
    }
    /// The same, with the 1 yoctoNEAR the transfer standards ask for.
    fn as_yocto(&mut self, who: &str) -> &mut Saltline {
        context(who, self.now, 1, self.seed);
        &mut self.c
    }
    fn wait(&mut self, secs: u64) {
        self.now += secs * 1_000;
        context(STRANGER, self.now, 0, self.seed);
    }
    fn register(&mut self, who: &str, callsign: &str) -> u32 {
        self.as_(FAUCET).register(acc(who), callsign.to_string());
        *self.c.player_ix.get(&acc(who)).unwrap()
    }
    /// Three players: ROOK, MARLOWE, VANE.
    fn crew(&mut self) -> (u32, u32, u32) {
        (self.register(ROOK, "rook"), self.register(MARLOWE, "marlowe"), self.register(VANE, "vane"))
    }
    /// Test setup only: put tokens straight into a player's hands.
    fn give(&mut self, ix: u32, t: usize, n: u128) {
        self.c.mint(Holder::Player(ix), t, n);
    }
    fn bal(&self, ix: u32, t: usize) -> u128 {
        self.c.player(ix).bal[t]
    }
    /// Give `who` a blueprint's inputs and fee, and build it. Returns the serial.
    fn build(&mut self, who: &str, ix: u32, blueprint: &str) -> String {
        let bp = &BLUEPRINTS[blueprint_index(blueprint).unwrap()];
        for &(t, n) in bp.inputs {
            self.give(ix, t, n);
        }
        self.give(ix, SCRIP, bp.fee);
        self.as_(who).build(blueprint.to_string()).weapon.unwrap().serial
    }
    fn start(&mut self, who: &str, weapon: Option<&str>) -> RaidView {
        self.as_(who).start_raid(Loadout { weapon: weapon.map(String::from), ..Default::default() })
    }
    fn gun_state(&self, serial: &str) -> u8 {
        self.c.gun(parse_serial(serial).unwrap()).state
    }
    /// Supply equals holdings for every token, and every gun alive is in exactly one locker.
    fn check(&self) {
        for t in 0..TOKEN_COUNT {
            assert_eq!(self.c.supply[t], total_held(&self.c, t), "supply of {} drifted", TOKENS[t].id);
        }
        assert_eq!(self.c.guns.len(), self.c.guns_built - self.c.guns_destroyed, "guns alive");
        let mut owned = 0;
        for p in self.c.players.iter() {
            for n in &p.guns {
                assert_eq!(self.c.gun(*n).owner, p.account_id, "{} is in the wrong locker", serial_text(*n));
            }
            owned += p.guns.len();
        }
        for v in &self.c.vendors {
            for n in &v.guns {
                assert_eq!(self.c.gun(*n).owner, v.account_id);
            }
            owned += v.guns.len();
        }
        assert_eq!(owned as u32, self.c.guns.len(), "every gun is in one locker");
    }
}

/// The data of each NEP-297 event of this standard and kind the last call logged.
fn events(standard: &str, kind: &str) -> Vec<near_sdk::serde_json::Value> {
    get_logs()
        .iter()
        .filter_map(|l| l.strip_prefix("EVENT_JSON:"))
        .map(|j| near_sdk::serde_json::from_str::<near_sdk::serde_json::Value>(j).unwrap())
        .filter(|v| v["standard"] == standard && v["event"] == kind)
        .map(|v| v["data"][0].clone())
        .collect()
}

/// Containers from a manifest that fit within `limit` weight, lightest first: (spots, cargo, weight).
fn pick(r: &RaidView, limit: u128) -> (Vec<u32>, [u128; TOKEN_COUNT], u128) {
    let weigh = |token_id: &str, n: u128| TOKENS[token_index(token_id).unwrap()].weight as u128 * n;
    let mut sorted: Vec<_> = r.containers.iter().collect();
    sorted.sort_by_key(|x| weigh(&x.token_id, x.amount.0));
    let (mut spots, mut got, mut weight) = (vec![], [0u128; TOKEN_COUNT], 0u128);
    for x in sorted {
        let w = weigh(&x.token_id, x.amount.0);
        if weight + w <= limit {
            weight += w;
            spots.push(x.spot);
            got[token_index(&x.token_id).unwrap()] += x.amount.0;
        }
    }
    (spots, got, weight)
}

fn opened(spots: Vec<u32>) -> Report {
    Report { opened: spots, ..Default::default() }
}

// -----------------------------------------------------------------------------------------------------------------
// The numbers: items.rs against hand-computed cases from src/economy/v2/items.ts
// -----------------------------------------------------------------------------------------------------------------

#[test]
fn the_roll_stays_inside_its_bands_and_repeats_for_a_seed() {
    for frame in 0..FRAME_COUNT {
        let mut seen_lo = [false; STAT_COUNT];
        let mut seen_hi = [false; STAT_COUNT];
        for seed in 0..4_000u64 {
            let stats = roll_stats(&mut Rng::new(seed), frame);
            assert_eq!(stats, roll_stats(&mut Rng::new(seed), frame), "the same seed rolls the same gun");
            for k in 0..STAT_COUNT {
                let (lo, hi) = FRAMES[frame].bands[k];
                assert!((lo..=hi).contains(&stats[k]), "{} {} = {}", FRAMES[frame].id, STAT_KEYS[k], stats[k]);
                seen_lo[k] |= stats[k] == lo;
                seen_hi[k] |= stats[k] == hi;
            }
            assert!(quality(frame, &stats) <= 100);
        }
        assert!(seen_lo.iter().all(|&x| x) && seen_hi.iter().all(|&x| x), "both ends of every band are reachable");
    }
    // Different seeds roll different guns.
    assert_ne!(roll_stats(&mut Rng::new(1), PILOT), roll_stats(&mut Rng::new(2), PILOT));
}

#[test]
fn a_built_gun_is_rolled_from_the_block_seed_and_its_serial() {
    let roll = |seed: u8| {
        let mut w = World::new();
        w.seed = seed;
        let (rook, _, _) = w.crew();
        let a = w.build(ROOK, rook, "pilot");
        let b = w.build(ROOK, rook, "pilot");
        (w.c.gun(parse_serial(&a).unwrap()).stats, w.c.gun(parse_serial(&b).unwrap()).stats)
    };
    let (a1, b1) = roll(7);
    let (a2, b2) = roll(7);
    assert_eq!((a1, b1), (a2, b2), "the same seed and serial give the same gun");
    assert_ne!(a1, b1, "the serial is mixed in: two guns in one block differ");
    assert_ne!(roll(8).0, a1, "another block's seed gives another gun");
}

#[test]
fn quality_grade_and_appraisal_match_items_ts() {
    // Mid-band Longshore: every stat at 50 → quality 50 → C → 750 new.
    let mid = [27, 710, 31, 100, 100, 290];
    assert_eq!(quality(LONGSHORE, &mid), 50);
    assert_eq!(GRADES[grade_of(50)].0, "C");
    assert_eq!(appraise(LONGSHORE, grade_of(50), 100), 750);
    assert_eq!(appraise(LONGSHORE, grade_of(50), 95), 727); // 750 × 100 × (50 + 47) / 10,000 = 727.5
    assert_eq!(appraise(LONGSHORE, grade_of(50), 0), 375);
    // The best Pilot: quality 100 → A → 950 × 220%.
    let best = [58, 380, 16, 115, 100, 460];
    assert_eq!(quality(PILOT, &best), 100);
    assert_eq!(appraise(PILOT, grade_of(100), 100), 2_090);
    assert_eq!(appraise(PILOT, grade_of(100), 85), 1_922); // 950 × 220 × 92 / 10,000 = 1,922.8
    // The worst Pilot: every stat at the wrong end.
    assert_eq!(quality(PILOT, &[44, 300, 12, 140, 120, 380]), 0);
    // A Stevedore with uneven stats: 40 + 58 + 75 + (100 − 25) + (100 − 66) + 20 = 302 → 50.
    assert_eq!(quality(STEVEDORE, &[18, 950, 40, 80, 90, 150]), 50);
    assert_eq!(appraise(STEVEDORE, grade_of(50), 100), 600);
    // Grade boundaries.
    for (q, grade) in [(100, "A"), (80, "A"), (79, "B"), (62, "B"), (61, "C"), (38, "C"), (37, "D"), (0, "D")] {
        assert_eq!(GRADES[grade_of(q)].0, grade, "quality {q}");
    }
    assert_eq!(appraise(STEVEDORE, grade_of(10), 30), 312); // 600 × 80 × 65 / 10,000
    assert_eq!(appraise(LONGSHORE, grade_of(70), 51), 787); // 750 × 140 × 75 / 10,000 = 787.5
}

#[test]
fn the_invoice_matches_items_ts() {
    assert_eq!(invoice_start(0, 0), 150);
    assert_eq!(invoice_start(3, 0), 225);
    assert_eq!(invoice_start(2, 900), 650);
    assert_eq!(invoice_start(0, 5_000), 1_650); // the carry-in caps at 1,500
    assert_eq!(invoice_start(1, 3_001), 1_675);
    assert_eq!(invoice_start(0, 1), 150);
    assert_eq!(invoice_start(0, 3), 151);
    // The entry charge counts at most 14 extractions: it tops out at 500.
    assert_eq!(invoice_start(14, 0), 500);
    assert_eq!(invoice_start(15, 0), 500);
    assert_eq!(invoice_start(400, 9_000), 2_000);
    let total = |start, seconds, seals, weight, uplinks, gulls, hounds| {
        invoice_total(&InvoiceFacts { start, seconds, seals, weight, uplinks, gulls, hounds })
    };
    // 40 a minute, 60 a seal, 30 a unit of weight, 50 an uplink, 15 a gull, 35 a hound.
    assert_eq!(total(150, 300, 4, 5, 1, 6, 2), 150 + 200 + 240 + 150 + 50 + 90 + 70);
    assert_eq!(total(650, 59, 0, 0, 0, 0, 0), 689); // 59 s at 40 a minute is 39.33
    assert_eq!(total(150, 90, 2, 3, 0, 0, 0), 420);
    assert_eq!(total(150, 480, 8, 6, 3, 30, 15), 150 + 320 + 480 + 180 + 150 + 450 + 525);
    // Five minutes, three uplinks, eight gulls and three hounds, nothing carried: well under the Bailiff's 1,200.
    assert_eq!(total(150, 300, 0, 0, 3, 8, 3), 150 + 200 + 150 + 120 + 105);
}

#[test]
fn vendor_export_and_harbormaster_curves() {
    // A vendor pays double at an empty shelf, the bid at target, half at three times the target.
    for &t in MATERIALS.iter() {
        let (b, target) = (TOKENS[t].bid, TOKENS[t].target as u128);
        assert_eq!(bid(t, 0), 2 * b);
        assert_eq!(bid(t, target), b);
        assert_eq!(bid(t, 3 * target), b / 2);
    }
    assert_eq!(bid(COPPER, u128::MAX), 1, "a bid never reaches zero");
    assert_eq!(sale_value(COPPER, 15, 3), 45 + 44 + 43);
    // Goods: inputs at base bids × 135%, per unit made, and more when few are left.
    assert_eq!(good_price(BP_PLATE, 10), 54); // (40 + 80) × 1.35 / 3
    assert_eq!(good_price(BP_CHARGE, 10), 30); // (55 + 80) × 1.35 / 6 = 30.375
    assert_eq!(good_price(BP_AMMO, 40), 13); // 40 × 1.35 / 4 = 13.5
    assert_eq!(good_price(BP_MAG2, 5), 182); // (2 × 40 + 55) × 1.35 = 182.25
    assert_eq!(good_price(BP_PLATE, 5), 54);
    assert_eq!(good_price(BP_PLATE, 4), 58); // 54 × 1.08 = 58.32
    assert_eq!(good_price(BP_PLATE, 1), 71); // 54 × 1.32 = 71.28
    assert_eq!(good_price(BP_PLATE, 0), 75); // 54 × 1.40 = 75.6
    assert_eq!(good_price(BP_BARREL2, 4), 276); // the base is rounded down first: 256 × 1.08 = 276.48
    assert_eq!(goods_cost(BP_PLATE, 6, 3), 54 + 54 + 58);
    assert_eq!(gun_price(750), 937);
    // The export desk: 4% of a unit's worth off for every unit shipped recently.
    assert_eq!(export_price(COPPER, 0), 25);
    assert_eq!(export_value(COPPER, 0, 4), 25 + 24 + 23 + 22);
    assert_eq!(export_price(CORE, 25 * MILLI), 50); // 100 × 100 / 200
    assert_eq!(export_price(COPPER, u128::MAX / 8), 1);
    // The Harbormaster.
    assert_eq!(
        (strength(0), strength(19), strength(20), strength(1_999), strength(2_000), strength(9_999)),
        (0, 0, 1, 99, 100, 100)
    );
    let h = 3_600_000;
    assert_eq!(halve(8_000, 0, 12 * h), 8_000);
    assert_eq!(halve(8_000, 12 * h, 12 * h), 4_000);
    assert_eq!(halve(8_000, 6 * h, 12 * h), 5_656); // 2^-0.5
    assert_eq!(halve(8_000, 24 * h, 12 * h), 2_000);
    assert_eq!(crate::harbormaster::posture_effect(PATROLS, 100), (4, 1_200));
    assert_eq!(crate::harbormaster::posture_effect(PATROLS, 49), (1, 1_200));
    assert_eq!(crate::harbormaster::posture_effect(PURSUIT, 100), (0, 800));
    assert_eq!(sale_split(1_000), (960, 20, 20));
    assert_eq!(sale_split(150), (144, 3, 3));
    assert_eq!(sale_split(49), (49, 0, 0));
}

#[test]
fn the_tables_hold_together() {
    assert_eq!(CONTAINER_LOOT.iter().map(|l| l.1).sum::<u32>(), LOOT_TOTAL);
    for (i, t) in TOKENS.iter().enumerate() {
        assert_eq!(token_index(t.id), Some(i));
    }
    for v in VENDORS.iter() {
        assert!(v.buys.iter().all(|&t| is_material(t)));
    }
    // Every mod and consumable has one blueprint, and one vendor that builds it.
    for t in MAG2..=AMMO {
        let b = blueprint_for(t).unwrap();
        assert_eq!(VENDORS.iter().filter(|v| v.builds.contains(&b)).count(), 1, "{}", TOKENS[t].id);
    }
    assert_eq!(serial_text(41), "S-000041");
    assert_eq!(parse_serial("S-000041"), Some(41));
    for bad in ["", "S-41", "s-000041", "S-00004x", "S-000000", "000041", "S-0000000000041"] {
        assert_eq!(parse_serial(bad), None, "{bad}");
    }
    // A manifest: 8 distinct spots, clear of the wrecks attached, with 2 bonded containers only when asked for.
    for seed in 0..500 {
        let bonded = seed % 2 == 0;
        let c = deal_manifest(&mut Rng::new(seed), &[(1, 3), (2, 3), (3, 9)], bonded);
        assert_eq!(c.len(), if bonded { 10 } else { 8 });
        assert_eq!(c.iter().filter(|x| x.bonded).count(), if bonded { 2 } else { 0 });
        assert!(c.windows(2).all(|p| p[0].spot < p[1].spot), "sorted, distinct spots");
        for x in &c {
            assert!((x.spot as u32) < SPOT_COUNT && x.spot != 3 && x.spot != 9);
            if x.bonded {
                assert!(BONDED_LOOT.contains(&(x.token as usize)) && x.amount == 2);
            } else {
                let l = CONTAINER_LOOT.iter().find(|l| l.0 == x.token as usize).unwrap();
                assert!((l.2..=l.3).contains(&(x.amount as u32)));
            }
        }
    }
}

// -----------------------------------------------------------------------------------------------------------------
// Init, registration, limits
// -----------------------------------------------------------------------------------------------------------------

#[test]
fn init_stocks_the_vendors_and_nothing_else() {
    let w = World::new();
    let mints = events("nep245", "mt_mint");
    assert_eq!(mints.len(), 1);
    assert_eq!(events("nep171", "nft_mint").len(), 2);
    let moss = &w.c.vendors[MOSS];
    assert_eq!(moss.bal[SCRIP], 1_500);
    assert_eq!(
        (moss.bal[COPPER], moss.bal[CHIPS], moss.bal[SERVO], moss.bal[ROTOR], moss.bal[CORE]),
        (15, 12, 6, 6, 4)
    );
    let ines = &w.c.vendors[INES];
    assert_eq!(
        (ines.bal[SCRIP], ines.bal[MEDS], ines.bal[FUEL], ines.bal[CHIPS], ines.bal[COPPER]),
        (1_500, 7, 6, 12, 15)
    );
    assert_eq!((ines.bal[PLATE], ines.bal[CHARGE], ines.bal[AMMO]), (10, 10, 40));
    assert_eq!(w.c.supply[SCRIP], 3_000, "the only scrip before the first dock pass and the first export");
    // Moss's rack: a Longshore and a Stevedore, rolled inside their bands.
    let rack = w.c.vendors();
    assert_eq!(rack[0].guns.len(), 2);
    assert_eq!(
        (rack[0].guns[0].weapon.frame.as_str(), rack[0].guns[1].weapon.frame.as_str()),
        ("longshore", "stevedore")
    );
    for g in &rack[0].guns {
        assert_eq!(g.weapon.state, "vendor");
        assert_eq!(g.weapon.maker_callsign, "MOSS");
        assert_eq!(g.price.0, g.weapon.value.0 * 125 / 100);
    }
    assert_eq!(rack[0].guns[0].weapon.serial, "S-000001");
    assert!(rack[1].guns.is_empty());
    assert_eq!(w.c.hm_view(w.now).balance.0, 0);
    w.check();
}

#[test]
fn init_refuses_one_account_in_two_roles() {
    context(CONTRACT, START, 0, 7);
    refuses("E_DUPLICATE", || {
        Saltline::new(acc(OWNER), acc(FAUCET), acc(HM), VendorAccounts { moss: acc(MOSS_ACC), ines: acc(MOSS_ACC) })
    });
    refuses("E_DUPLICATE", || {
        Saltline::new(acc(OWNER), acc(FAUCET), acc(FAUCET), VendorAccounts { moss: acc(MOSS_ACC), ines: acc(INES_ACC) })
    });
}

#[test]
fn register_is_the_faucets_and_mints_the_dock_pass() {
    let mut w = World::new();
    refuses("E_NOT_FAUCET", || w.as_(ROOK).register(acc(ROOK), "rook".into()));
    let p = w.as_(FAUCET).register(acc(ROOK), "rook".into());
    assert_eq!((p.callsign.as_str(), p.arrears.0, p.raids, p.built, p.active_raid), ("ROOK", 0, 0, 0, None));
    assert_eq!(events("nep245", "mt_mint")[0]["amounts"][0], "150");
    assert_eq!(w.bal(0, SCRIP), 150);
    refuses("E_ALREADY_REGISTERED", || w.as_(FAUCET).register(acc(ROOK), "rook2".into()));
    refuses("E_ALREADY_REGISTERED", || w.as_(FAUCET).register(acc(MOSS_ACC), "armourer".into()));
    refuses("E_ALREADY_REGISTERED", || w.as_(FAUCET).register(acc(HM), "villain".into()));
    refuses("E_ALREADY_REGISTERED", || w.as_(FAUCET).register(acc(CONTRACT), "house".into()));
    refuses("E_ALREADY_REGISTERED", || w.as_(FAUCET).register(acc(FAUCET), "tap".into()));
    refuses("E_CALLSIGN_TAKEN", || w.as_(FAUCET).register(acc(MARLOWE), "Rook".into()));
    refuses("E_CALLSIGN_TAKEN", || w.as_(FAUCET).register(acc(MARLOWE), "moss".into()));
    for bad in ["ab", "seventeen-letters", "tab\there", " lead", "trail ", "two  spaces", "émile"] {
        refuses("E_BAD_CALLSIGN", || w.as_(FAUCET).register(acc(MARLOWE), bad.into()));
    }
    assert!(w.c.profile(acc(MARLOWE)).is_none());
    w.check();
}

#[test]
fn the_dock_holds_two_thousand_passes() {
    let mut w = World::new();
    for i in 0..MAX_PROFILES {
        w.as_(FAUCET).register(acc(&format!("p{i}.testnet")), format!("P{i:04}"));
    }
    refuses("E_FULL", || w.as_(FAUCET).register(acc("late.testnet"), "late".into()));
    assert_eq!(w.c.supply[SCRIP], 3_000 + 150 * MAX_PROFILES as u128);
}

// -----------------------------------------------------------------------------------------------------------------
// The armoury
// -----------------------------------------------------------------------------------------------------------------

#[test]
fn build_burns_the_inputs_and_fee_and_rolls_a_gun() {
    let mut w = World::new();
    let (rook, _, _) = w.crew();
    refuses("E_NOT_REGISTERED", || w.as_(STRANGER).build("longshore".into()));
    refuses("E_BAD_AMOUNT", || w.as_(ROOK).build("railgun".into()));
    // Inputs short, then the fee short.
    refuses("E_FUNDS", || w.as_(ROOK).build("longshore".into()));
    w.give(rook, COPPER, 6);
    w.give(rook, CHIPS, 4);
    w.give(rook, SERVO, 1);
    refuses("E_FUNDS", || w.as_(ROOK).build("longshore".into()));
    w.give(rook, SERVO, 1);
    w.c.burn(Holder::Player(rook), SCRIP, 100); // test setup: 50 scrip against a fee of 120
    refuses("E_FUNDS", || w.as_(ROOK).build("longshore".into()));
    w.give(rook, SCRIP, 100);
    let supply = w.c.supply;
    let out = w.as_(ROOK).build("longshore".into());
    let g = out.weapon.unwrap();
    assert!(out.minted.is_empty());
    assert_eq!(
        (g.serial.as_str(), g.frame.as_str(), g.state.as_str(), g.condition),
        ("S-000003", "longshore", "held", 100)
    );
    assert_eq!((g.maker.as_str(), g.maker_callsign.as_str(), g.owner.as_str()), (ROOK, "ROOK", ROOK));
    assert_eq!((g.raids, g.extractions, g.owners, g.recovered), (0, 0, 1, 0));
    let stats = [g.stats.damage, g.stats.rpm, g.stats.mag, g.stats.recoil, g.stats.reload, g.stats.range];
    for k in 0..STAT_COUNT {
        let (lo, hi) = FRAMES[LONGSHORE].bands[k];
        assert!((lo as u32..=hi as u32).contains(&stats[k]));
    }
    let raw = stats.map(|s| s as u16);
    assert_eq!(g.quality, quality(LONGSHORE, &raw));
    assert_eq!(g.grade, GRADES[grade_of(g.quality)].0);
    assert_eq!(g.value.0, appraise(LONGSHORE, grade_of(g.quality), 100));
    assert_eq!(events("nep171", "nft_mint")[0]["token_ids"][0], "S-000003");
    assert_eq!(events("saltline", "build")[0]["text"], format!("ROOK built a {}-grade Longshore, S-000003.", g.grade));
    // Exactly the inputs and the fee left the supply.
    assert_eq!((w.bal(rook, COPPER), w.bal(rook, CHIPS), w.bal(rook, SERVO), w.bal(rook, SCRIP)), (0, 0, 0, 30));
    assert_eq!(supply[COPPER] - w.c.supply[COPPER], 6);
    assert_eq!(supply[SCRIP] - w.c.supply[SCRIP], 120);
    assert_eq!(w.c.profile(acc(ROOK)).unwrap().built, 1);
    assert_eq!(w.c.weapons(acc(ROOK)).len(), 1);
    w.check();
}

#[test]
fn build_makes_mods_and_consumables_by_the_yield() {
    let mut w = World::new();
    let (rook, _, _) = w.crew();
    w.give(rook, COPPER, 10);
    w.give(rook, CHIPS, 10);
    w.give(rook, FUEL, 2);
    let out = w.as_(ROOK).build("ammo".into());
    assert!(out.weapon.is_none());
    assert_eq!(out.minted["ammo"], U128(4));
    assert_eq!((w.bal(rook, AMMO), w.bal(rook, COPPER), w.bal(rook, SCRIP)), (4, 9, 140));
    w.as_(ROOK).build("plate".into());
    w.as_(ROOK).build("charge".into());
    w.as_(ROOK).build("mag2".into());
    assert_eq!((w.bal(rook, PLATE), w.bal(rook, CHARGE), w.bal(rook, MAG2)), (3, 6, 1));
    assert_eq!((w.bal(rook, COPPER), w.bal(rook, CHIPS), w.bal(rook, FUEL)), (9 - 1 - 2, 10 - 1 - 1, 0));
    assert_eq!(w.bal(rook, SCRIP), 140 - 20 - 15 - 30);
    assert_eq!(w.c.profile(acc(ROOK)).unwrap().built, 0, "only guns count as built");
    w.check();
}

#[test]
fn fit_burns_a_mod_into_its_slot() {
    let mut w = World::new();
    let (rook, marlowe, _) = w.crew();
    let gun = w.build(ROOK, rook, "longshore");
    refuses("E_NOT_REGISTERED", || w.as_(STRANGER).fit(gun.clone(), "comp".into()));
    refuses("E_NO_WEAPON", || w.as_(ROOK).fit("S-000999".into(), "comp".into()));
    refuses("E_NO_WEAPON", || w.as_(ROOK).fit("garbage".into(), "comp".into()));
    refuses("E_NOT_OWNER", || w.as_(MARLOWE).fit(gun.clone(), "comp".into()));
    refuses("E_BAD_AMOUNT", || w.as_(ROOK).fit(gun.clone(), "copper".into()));
    refuses("E_BAD_AMOUNT", || w.as_(ROOK).fit(gun.clone(), "stock".into()));
    refuses("E_FUNDS", || w.as_(ROOK).fit(gun.clone(), "comp".into()));
    w.give(rook, COMP, 2);
    w.give(rook, OPTIC, 1);
    w.give(marlowe, COMP, 1);
    let out = w.as_(ROOK).fit(gun.clone(), "comp".into());
    assert_eq!(out.weapon.mods, vec!["comp"]);
    assert_eq!(events("nep245", "mt_burn")[0]["token_ids"][0], "comp");
    refuses("E_SLOT_TAKEN", || w.as_(ROOK).fit(gun.clone(), "comp".into()));
    let out = w.as_(ROOK).fit(gun.clone(), "optic".into());
    assert_eq!(out.weapon.mods, vec!["comp", "optic"]);
    assert_eq!((w.bal(rook, COMP), w.bal(rook, OPTIC)), (1, 0));
    w.check();
}

#[test]
fn repair_pays_moss_and_uses_copper() {
    let mut w = World::new();
    let (rook, _, _) = w.crew();
    let gun = w.build(ROOK, rook, "stevedore");
    let n = parse_serial(&gun).unwrap();
    refuses("E_BAD_AMOUNT", || w.as_(ROOK).repair(gun.clone(), None)); // already at 100
    w.c.gun_mut(n).condition = 55;
    refuses("E_NOT_OWNER", || w.as_(MARLOWE).repair(gun.clone(), None));
    refuses("E_NO_WEAPON", || w.as_(ROOK).repair("S-000404".into(), None));
    refuses("E_BAD_AMOUNT", || w.as_(ROOK).repair(gun.clone(), Some(0)));
    // 45 points are missing: 90 scrip and ⌈45 / 20⌉ = 3 copper. Asking for more is trimmed to that.
    w.give(rook, COPPER, 2);
    refuses("E_FUNDS", || w.as_(ROOK).repair(gun.clone(), None));
    refuses("E_FUNDS", || w.as_(ROOK).repair(gun.clone(), Some(400)));
    w.give(rook, COPPER, 2);
    let scrip = w.bal(rook, SCRIP);
    let moss = w.c.vendors[MOSS].bal[SCRIP];
    let out = w.as_(ROOK).repair(gun.clone(), Some(20));
    assert_eq!((out.cost.0, out.weapon.condition), (40, 75));
    assert_eq!((w.bal(rook, SCRIP), w.bal(rook, COPPER)), (scrip - 40, 3));
    let out = w.as_(ROOK).repair(gun.clone(), None);
    assert_eq!((out.cost.0, out.weapon.condition), (50, 100)); // 25 points, 2 copper
    assert_eq!((w.bal(rook, SCRIP), w.bal(rook, COPPER)), (scrip - 90, 1));
    assert_eq!(w.c.vendors[MOSS].bal[SCRIP], moss + 90, "the scrip is Moss's");
    // A gun at 0 can only be scrapped.
    w.c.gun_mut(n).condition = 0;
    refuses("E_WORN_OUT", || w.as_(ROOK).repair(gun.clone(), None));
    refuses("E_WORN_OUT", || w.start(ROOK, Some(&gun)));
    let scrip = w.bal(rook, SCRIP);
    refuses("E_FUNDS", || {
        w.c.gun_mut(n).condition = 1;
        w.c.burn(Holder::Player(rook), SCRIP, scrip);
        w.as_(ROOK).repair(gun.clone(), Some(1))
    });
    w.check();
}

#[test]
fn scrap_destroys_the_gun_for_two_copper_and_one_electronics() {
    let mut w = World::new();
    let (rook, _, _) = w.crew();
    let gun = w.build(ROOK, rook, "pilot");
    refuses("E_NOT_OWNER", || w.as_(MARLOWE).scrap(gun.clone()));
    let out = w.as_(ROOK).scrap(gun.clone());
    assert_eq!((out.minted["copper"], out.minted["chips"]), (U128(2), U128(1)));
    assert_eq!(events("nep171", "nft_burn")[0]["token_ids"][0], gun);
    assert_eq!((w.bal(rook, COPPER), w.bal(rook, CHIPS)), (2, 1));
    assert!(w.c.weapon(gun.clone()).is_none());
    assert!(w.c.nft_token(gun.clone()).is_none());
    assert_eq!((w.c.guns_built, w.c.guns_destroyed), (3, 1));
    refuses("E_NO_WEAPON", || w.as_(ROOK).scrap(gun.clone()));
    w.check();
}

// -----------------------------------------------------------------------------------------------------------------
// Raids
// -----------------------------------------------------------------------------------------------------------------

#[test]
fn start_raid_refuses_a_bad_loadout() {
    let mut w = World::new();
    let (rook, marlowe, _) = w.crew();
    let gun = w.build(ROOK, rook, "longshore");
    let theirs = w.build(MARLOWE, marlowe, "stevedore");
    let kit = |plates, charges, mags| Loadout { weapon: None, plates, charges, mags };
    refuses("E_NOT_REGISTERED", || w.start(STRANGER, None));
    refuses("E_BAD_AMOUNT", || w.as_(ROOK).start_raid(kit(2, 0, 0)));
    refuses("E_BAD_AMOUNT", || w.as_(ROOK).start_raid(kit(0, 4, 0)));
    refuses("E_BAD_AMOUNT", || w.as_(ROOK).start_raid(kit(0, 0, 9)));
    refuses("E_FUNDS", || w.as_(ROOK).start_raid(kit(1, 0, 0)));
    refuses("E_FUNDS", || w.as_(ROOK).start_raid(kit(0, 1, 0)));
    refuses("E_FUNDS", || w.as_(ROOK).start_raid(kit(0, 0, 1)));
    refuses("E_NO_WEAPON", || w.start(ROOK, Some("S-000777")));
    refuses("E_NO_WEAPON", || w.start(ROOK, Some("the good one")));
    refuses("E_NOT_OWNER", || w.start(ROOK, Some(&theirs)));
    refuses("E_NOT_OWNER", || w.start(ROOK, Some("S-000001"))); // on Moss's rack
    let listing = w.as_(ROOK).list_weapon(gun.clone(), U128(500)).id;
    refuses("E_WEAPON_BUSY", || w.start(ROOK, Some(&gun)));
    w.as_(ROOK).cancel_listing(listing);
    w.c.gun_mut(parse_serial(&gun).unwrap()).condition = 0;
    refuses("E_WORN_OUT", || w.start(ROOK, Some(&gun)));
    assert_eq!(w.c.profile(acc(ROOK)).unwrap().raids, 0);
    w.check();
}

#[test]
fn start_raid_locks_the_loadout_and_deals_a_manifest() {
    let mut w = World::new();
    let (rook, _, _) = w.crew();
    let gun = w.build(ROOK, rook, "longshore");
    w.give(rook, PLATE, 1);
    w.give(rook, CHARGE, 3);
    w.give(rook, AMMO, 5);
    let r = w.as_(ROOK).start_raid(Loadout { weapon: Some(gun.clone()), plates: 1, charges: 2, mags: 4 });
    assert_eq!((r.raid_id, r.started_at, r.invoice_start.0), (1, w.now, 150));
    assert_eq!(
        (r.loadout.weapon.as_deref(), r.loadout.plates, r.loadout.charges, r.loadout.mags),
        (Some(gun.as_str()), 1, 2, 4)
    );
    assert_eq!(r.containers.len(), 8);
    assert!(r.containers.windows(2).all(|p| p[0].spot < p[1].spot));
    assert!(
        r.containers.iter().all(|c| !c.bonded && c.spot < SPOT_COUNT && is_material(token_index(&c.token_id).unwrap()))
    );
    assert!(r.wrecks.is_empty());
    assert_eq!(
        (r.harbormaster.posture.as_str(), r.harbormaster.bailiff_at.0, r.harbormaster.strength),
        ("patrols", 1_200, 0)
    );
    // The gun is locked, the kit is with the contract.
    assert_eq!(w.gun_state(&gun), IN_RAID);
    assert_eq!(w.c.weapon(gun.clone()).unwrap().raids, 0, "a raid goes on the gun's record when it ends");
    assert_eq!((w.bal(rook, PLATE), w.bal(rook, CHARGE), w.bal(rook, AMMO)), (0, 1, 1));
    assert_eq!((w.c.pool[PLATE], w.c.pool[CHARGE], w.c.pool[AMMO]), (1, 2, 4));
    assert_eq!(events("nep245", "mt_transfer")[0]["new_owner_id"], CONTRACT);
    let p = w.c.profile(acc(ROOK)).unwrap();
    assert_eq!((p.raids, p.active_raid), (1, Some(1)));
    assert_eq!(w.c.raid(1).unwrap().containers.len(), 8);
    assert!(w.c.raid(2).is_none());
    assert_eq!(events("saltline", "raid_start").len(), 1);
    // 30 s between raids, start to start.
    w.wait(29);
    refuses("E_TOO_SOON", || w.start(ROOK, None));
    w.check();
}

#[test]
fn heavy_arrears_add_bonded_containers_and_carry_onto_the_invoice() {
    let mut w = World::new();
    let (rook, _, _) = w.crew();
    w.c.player_mut(rook).arrears = 999;
    let r = w.start(ROOK, None);
    assert_eq!((r.containers.len(), r.invoice_start.0), (8, 150 + 499));
    w.wait(30);
    w.c.player_mut(rook).arrears = 1_000;
    let r = w.start(ROOK, None);
    assert_eq!((r.containers.len(), r.invoice_start.0), (10, 650));
    let bonded: Vec<_> = r.containers.iter().filter(|c| c.bonded).collect();
    assert_eq!(bonded.len(), 2);
    assert!(bonded.iter().all(|c| c.amount.0 == 2 && ["core", "servo", "chips"].contains(&c.token_id.as_str())));
    w.wait(30);
    w.c.player_mut(rook).arrears = 9_000;
    w.c.player_mut(rook).extractions = 4;
    assert_eq!(w.start(ROOK, None).invoice_start.0, 150 + 100 + 1_500);
}

#[test]
fn a_new_raid_abandons_the_open_one() {
    let mut w = World::new();
    let (rook, _, _) = w.crew();
    let gun = w.build(ROOK, rook, "longshore");
    w.give(rook, AMMO, 3);
    w.as_(ROOK).start_raid(Loadout { weapon: Some(gun.clone()), plates: 0, charges: 0, mags: 3 });
    w.wait(30);
    // The same gun goes straight back out: the old raid's kit is lost, the gun is not.
    let r2 = w.start(ROOK, Some(&gun));
    assert_eq!(events("nep245", "mt_burn")[0]["memo"], "abandoned");
    assert_eq!((w.c.pool[AMMO], w.bal(rook, AMMO), w.c.supply[AMMO]), (0, 0, 40));
    assert!(w.c.raid(1).is_none());
    refuses("E_RAID_CLOSED", || w.as_(ROOK).extract(1, Report::default()));
    let g = w.c.weapon(gun.clone()).unwrap();
    assert_eq!((g.state.as_str(), g.raids, g.condition), ("raid", 0, 100));
    assert_eq!(w.c.profile(acc(ROOK)).unwrap().active_raid, Some(r2.raid_id));
    w.check();
}

#[test]
fn a_raid_times_out_and_the_gun_comes_home() {
    let mut w = World::new();
    let (rook, _, _) = w.crew();
    let gun = w.build(ROOK, rook, "longshore");
    w.give(rook, AMMO, 2);
    w.give(rook, COMP, 1);
    let r = w.as_(ROOK).start_raid(Loadout { weapon: Some(gun.clone()), plates: 0, charges: 0, mags: 2 });
    w.wait(RAID_EXPIRY_SECONDS);
    refuses("E_RAID_CLOSED", || w.as_(ROOK).extract(r.raid_id, Report::default()));
    refuses("E_RAID_CLOSED", || w.as_(ROOK).die(r.raid_id, Report::default(), 0, "machines".into()));
    // The views already show it home, and the owner's next call of any kind makes it so.
    let mut w = World::new();
    let (rook, _, _) = w.crew();
    let gun2 = w.build(ROOK, rook, "longshore");
    assert_eq!(gun, gun2);
    w.give(rook, AMMO, 2);
    w.give(rook, COMP, 1);
    w.as_(ROOK).start_raid(Loadout { weapon: Some(gun.clone()), plates: 0, charges: 0, mags: 2 });
    w.wait(RAID_EXPIRY_SECONDS);
    assert_eq!(w.c.weapon(gun.clone()).unwrap().state, "held");
    assert_eq!(w.c.profile(acc(ROOK)).unwrap().active_raid, None);
    assert!(w.c.raid(1).is_none());
    assert_eq!(w.gun_state(&gun), IN_RAID);
    w.as_(ROOK).fit(gun.clone(), "comp".into());
    assert_eq!(w.gun_state(&gun), HELD);
    assert_eq!((w.c.pool[AMMO], w.bal(rook, AMMO)), (0, 0), "the kit is lost");
    w.check();
}

#[test]
fn extract_checks_the_report() {
    let mut w = World::new();
    let (rook, _, _) = w.crew();
    w.give(rook, AMMO, 2);
    w.give(rook, CHARGE, 1);
    let r = w.as_(ROOK).start_raid(Loadout { weapon: None, plates: 0, charges: 1, mags: 2 });
    let id = r.raid_id;
    let in_manifest: Vec<u32> = r.containers.iter().map(|c| c.spot).collect();
    let outside = (0..SPOT_COUNT).find(|s| !in_manifest.contains(s)).unwrap();
    let (spots, _, _) = pick(&r, 3);
    let first = spots[0];
    w.wait(600);
    refuses("E_NOT_REGISTERED", || w.as_(STRANGER).extract(id, Report::default()));
    refuses("E_NO_RAID", || w.as_(ROOK).extract(0, Report::default()));
    refuses("E_NO_RAID", || w.as_(ROOK).extract(99, Report::default()));
    refuses("E_NO_RAID", || w.as_(MARLOWE).extract(id, Report::default())); // not theirs
    refuses("E_NOT_IN_MANIFEST", || w.as_(ROOK).extract(id, opened(vec![outside])));
    refuses("E_NOT_IN_MANIFEST", || w.as_(ROOK).extract(id, opened(vec![SPOT_COUNT + 4])));
    refuses("E_DUPLICATE", || w.as_(ROOK).extract(id, opened(vec![first, first])));
    refuses("E_NOT_IN_MANIFEST", || w.as_(ROOK).extract(id, Report { wrecks: vec![5], ..Default::default() }));
    let bad = |f: &dyn Fn(&mut Report)| {
        let mut r = Report::default();
        f(&mut r);
        r
    };
    for report in [
        bad(&|r| r.uplinks = 4),
        bad(&|r| r.kills = Kills { gull: 31, hound: 0 }),
        bad(&|r| r.kills = Kills { gull: 0, hound: 16 }),
        bad(&|r| r.parts = Parts { servo: 1, rotor: 0 }),
        bad(&|r| {
            r.kills = Kills { gull: 2, hound: 1 };
            r.parts = Parts { servo: 1, rotor: 3 }
        }),
        bad(&|r| r.used = Used { plates: 1, charges: 0, mags: 0 }),
        bad(&|r| r.used = Used { plates: 0, charges: 2, mags: 0 }),
        bad(&|r| r.used = Used { plates: 0, charges: 0, mags: 3 }),
    ] {
        refuses("E_BAD_REPORT", || w.as_(ROOK).extract(id, report.clone()));
    }
    // Over the carry limit: every container, or six parts on top of one.
    refuses("E_OVER_LIMIT", || w.as_(ROOK).extract(id, opened(in_manifest.clone())));
    refuses("E_OVER_LIMIT", || {
        w.as_(ROOK).extract(
            id,
            Report {
                opened: vec![first],
                kills: Kills { gull: 6, hound: 0 },
                parts: Parts { servo: 0, rotor: 6 },
                ..Default::default()
            },
        )
    });
    assert_eq!(w.c.profile(acc(ROOK)).unwrap().active_raid, Some(id), "still open after every refusal");
}

#[test]
fn extract_and_die_are_timed() {
    let mut w = World::new();
    w.crew();
    let r = w.start(ROOK, None);
    let id = r.raid_id;
    let (spots, _, _) = pick(&r, 4);
    let n = spots.len() as u64;
    assert!(n >= 2);
    // die needs 8 s per container opened.
    w.wait(8 * n - 1);
    refuses("E_TOO_SOON", || w.as_(ROOK).die(id, opened(spots.clone()), 0, "machines".into()));
    // Kills: one every four seconds of raid at most. 8n − 1 seconds allow 2n − 1.
    let kills = Report { kills: Kills { gull: 2 * n as u32, hound: 0 }, ..Default::default() };
    refuses("E_BAD_REPORT", || w.as_(ROOK).die(id, kills.clone(), 0, "machines".into()));
    // extract needs 45 s on top.
    w.wait(45);
    refuses("E_TOO_SOON", || w.as_(ROOK).extract(id, opened(spots.clone())));
    refuses("E_BAD_REPORT", || {
        w.as_(ROOK).extract(id, Report { kills: Kills { gull: 30, hound: 15 }, ..Default::default() })
    });
    w.wait(1);
    let out = w.as_(ROOK).extract(id, opened(spots.clone()));
    assert_eq!(out.invoice.0, 150 + (8 * n + 45) as u128 * 40 / 60 + 60 * n as u128 + 30 * pick(&r, 4).2);
    refuses("E_RAID_CLOSED", || w.as_(ROOK).extract(id, Report::default()));
    refuses("E_RAID_CLOSED", || w.as_(ROOK).die(id, Report::default(), 0, "machines".into()));
}

#[test]
fn extract_mints_the_haul_returns_the_kit_and_bills_the_invoice() {
    let mut w = World::new();
    let (rook, _, _) = w.crew();
    let gun = w.build(ROOK, rook, "longshore");
    w.give(rook, PLATE, 1);
    w.give(rook, CHARGE, 3);
    w.give(rook, AMMO, 6);
    let r = w.as_(ROOK).start_raid(Loadout { weapon: Some(gun.clone()), plates: 1, charges: 3, mags: 6 });
    let (spots, got, weight) = pick(&r, 4);
    let seconds = MIN_SECONDS + PER_CONTAINER_SECONDS * spots.len() as u64 + 60;
    w.wait(seconds);
    let supply = w.c.supply;
    let report = Report {
        opened: spots.clone(),
        wrecks: vec![],
        parts: Parts { servo: 1, rotor: 1 },
        kills: Kills { gull: 4, hound: 2 },
        uplinks: 1,
        used: Used { plates: 1, charges: 1, mags: 4 },
    };
    let out = w.as_(ROOK).extract(r.raid_id, report);
    // The invoice, by hand: 150 at the fence, 40 a minute, 60 a seal, 30 a unit of weight, 50 an uplink, 15 a gull,
    // 35 a hound.
    let carried = weight + 2;
    let invoice = 150 + seconds as u128 * 40 / 60 + 60 * spots.len() as u128 + 30 * carried + 50 + 4 * 15 + 2 * 35;
    assert_eq!(out.invoice.0, invoice);
    assert_eq!(out.arrears.0, invoice * 25 / 100);
    // Cargo and parts are new tokens, in the caller's hands.
    let mut expect = got;
    expect[SERVO] += 1;
    expect[ROTOR] += 1;
    for &t in MATERIALS.iter() {
        assert_eq!(w.bal(rook, t), expect[t], "{}", TOKENS[t].id);
        assert_eq!(w.c.supply[t] - supply[t], expect[t]);
        assert_eq!(out.minted.get(TOKENS[t].id).map(|n| n.0).unwrap_or(0), expect[t]);
    }
    // Used kit is burned, the rest is back.
    assert_eq!((w.bal(rook, PLATE), w.bal(rook, CHARGE), w.bal(rook, AMMO)), (0, 2, 2));
    assert_eq!((w.c.pool[PLATE], w.c.pool[CHARGE], w.c.pool[AMMO]), (0, 0, 0));
    assert_eq!(supply[AMMO] - w.c.supply[AMMO], 4);
    // The gun is home, worn by 5.
    let g = out.weapon.unwrap();
    assert_eq!((g.state.as_str(), g.condition, g.raids, g.extractions, g.owners), ("held", 95, 1, 1, 1));
    assert!(out.recovered.is_empty());
    let p = w.c.profile(acc(ROOK)).unwrap();
    assert_eq!((p.extractions, p.deaths, p.active_raid, p.arrears.0), (1, 0, None, invoice / 4));
    assert!(w.c.raid(r.raid_id).is_none());
    assert_eq!(events("saltline", "extract")[0]["invoice"], invoice.to_string());
    // The next raid starts with the entry charge, 25 for the extraction and half the arrears.
    w.wait(30);
    assert_eq!(w.start(ROOK, None).invoice_start.0, 150 + 25 + invoice / 4 / 2);
    w.check();
}

#[test]
fn dying_to_machines_leaves_a_wreck_with_the_gun_cargo_and_unused_kit() {
    let mut w = World::new();
    let (rook, _, _) = w.crew();
    let gun = w.build(ROOK, rook, "longshore");
    w.give(rook, CHARGE, 2);
    w.give(rook, AMMO, 3);
    let r = w.as_(ROOK).start_raid(Loadout { weapon: Some(gun.clone()), plates: 0, charges: 2, mags: 3 });
    let id = r.raid_id;
    let (spots, got, weight) = pick(&r, 5);
    w.wait(100);
    refuses("E_BAD_REPORT", || w.as_(ROOK).die(id, Report::default(), 16, "machines".into()));
    refuses("E_BAD_REPORT", || w.as_(ROOK).die(id, Report::default(), 3, "gravity".into()));
    refuses("E_NO_RAID", || w.as_(MARLOWE).die(id, Report::default(), 3, "machines".into()));
    refuses("E_NOT_IN_MANIFEST", || {
        w.as_(ROOK).die(id, Report { wrecks: vec![1], ..Default::default() }, 3, "machines".into())
    });
    let supply = w.c.supply;
    let report = Report {
        opened: spots.clone(),
        kills: Kills { gull: 1, hound: 0 },
        parts: Parts { servo: 0, rotor: 1 },
        used: Used { plates: 0, charges: 1, mags: 3 },
        ..Default::default()
    };
    let out = w.as_(ROOK).die(id, report, 3, "machines".into());
    let invoice = 150 + 100 * 40 / 60 + 60 * spots.len() as u128 + 30 * (weight + 1) + 15;
    assert_eq!((out.wreck_id, out.impounded, out.invoice.0, out.arrears.0), (Some(1), false, invoice, invoice / 10));
    // Nothing reached the player; the wreck holds the gun, the cargo, the rotor and the unused charge.
    for &t in MATERIALS.iter() {
        assert_eq!(w.bal(rook, t), 0);
    }
    let wrecks = w.c.wrecks();
    assert_eq!(wrecks.len(), 1);
    let wr = &wrecks[0];
    assert_eq!((wr.id, wr.spot, wr.owner.as_str(), wr.callsign.as_str()), (1, 3, ROOK, "ROOK"));
    assert_eq!((wr.at, wr.expires_at), (w.now, w.now + 24 * HOUR * 1_000));
    let weapon = wr.weapon.as_ref().unwrap();
    assert_eq!(
        (weapon.serial.as_str(), weapon.state.as_str(), weapon.owner.as_str(), weapon.condition),
        (gun.as_str(), "wreck", ROOK, 100)
    );
    let mut expect = got;
    expect[ROTOR] += 1;
    expect[CHARGE] = 1;
    assert_eq!((weapon.raids, weapon.extractions), (1, 0), "the raid is on its record; dying wears nothing");
    for t in 0..TOKEN_COUNT {
        let in_wreck = wr.items.iter().find(|i| i.token_id == TOKENS[t].id).map(|i| i.amount.0).unwrap_or(0);
        assert_eq!(in_wreck, expect[t], "{} in the wreck", TOKENS[t].id);
        assert_eq!(w.c.pool[t], expect[t], "{} held by the contract", TOKENS[t].id);
    }
    assert_eq!(supply[CHARGE] - w.c.supply[CHARGE], 1);
    assert_eq!(supply[AMMO] - w.c.supply[AMMO], 3);
    assert_eq!(w.c.weapons(acc(ROOK)).len(), 1, "still the owner's until someone carries it out");
    let p = w.c.profile(acc(ROOK)).unwrap();
    assert_eq!((p.deaths, p.extractions, p.active_raid, p.arrears.0), (1, 0, None, invoice / 10));
    assert!(events("saltline", "wreck")[0]["text"].as_str().unwrap().starts_with("ROOK went down at spot 3."));
    w.check();
}

#[test]
fn dying_with_the_issue_rifle_and_nothing_carried_leaves_no_wreck() {
    let mut w = World::new();
    w.crew();
    let r = w.start(ROOK, None);
    w.wait(20);
    let out = w.as_(ROOK).die(r.raid_id, Report::default(), 9, "machines".into());
    assert_eq!((out.wreck_id, out.impounded), (None, false));
    assert_eq!(out.arrears.0, (150 + 20 * 40 / 60) / 10);
    assert!(w.c.wrecks().is_empty());
    // With nothing but the Bailiff to blame, nothing is impounded either.
    w.wait(30);
    let r = w.start(ROOK, None);
    let out = w.as_(ROOK).die(r.raid_id, Report::default(), 9, "bailiff".into());
    assert_eq!((out.wreck_id, out.impounded), (None, false));
    assert_eq!(w.c.profile(acc(ROOK)).unwrap().deaths, 2);
    w.check();
}

#[test]
fn a_wreck_is_carried_out_and_changes_hands() {
    let mut w = World::new();
    let (rook, marlowe, _) = w.crew();
    let gun = w.build(ROOK, rook, "pilot");
    w.give(rook, AMMO, 2);
    let r = w.as_(ROOK).start_raid(Loadout { weapon: Some(gun.clone()), plates: 0, charges: 0, mags: 2 });
    let (spots, left, _) = pick(&r, 6);
    w.wait(120);
    let wreck = w.as_(ROOK).die(r.raid_id, opened(spots), 5, "machines".into()).wreck_id.unwrap();

    // ROOK's own next raid isn't offered ROOK's wreck.
    w.wait(30);
    assert!(w.start(ROOK, None).wrecks.is_empty());
    // MARLOWE's is, and it is reserved: VANE's raid isn't offered it meanwhile.
    let r = w.start(MARLOWE, None);
    assert_eq!(r.wrecks.len(), 1);
    assert_eq!((r.wrecks[0].id, r.wrecks[0].spot), (wreck, 5));
    assert!(r.containers.iter().all(|c| c.spot != 5), "no container under the wreck");
    assert!(w.start(VANE, None).wrecks.is_empty());
    let (spots, got, weight) = pick(&r, 4);
    w.wait(200);
    // The gun weighs 2: a full load of cargo on top is over the limit.
    let (heavy, _, heavy_weight) = pick(&r, 6);
    if heavy_weight > 4 {
        refuses("E_OVER_LIMIT", || {
            w.as_(MARLOWE)
                .extract(r.raid_id, Report { opened: heavy.clone(), wrecks: vec![wreck], ..Default::default() })
        });
    }
    refuses("E_DUPLICATE", || {
        w.as_(MARLOWE).extract(r.raid_id, Report { wrecks: vec![wreck, wreck], ..Default::default() })
    });
    let supply = w.c.supply;
    let out =
        w.as_(MARLOWE).extract(r.raid_id, Report { opened: spots.clone(), wrecks: vec![wreck], ..Default::default() });
    assert_eq!(out.invoice.0, 150 + 200 * 40 / 60 + 60 * spots.len() as u128 + 30 * (weight + 2));
    assert_eq!(out.recovered.len(), 1);
    let g = &out.recovered[0];
    assert_eq!((g.serial.as_str(), g.owner.as_str(), g.state.as_str()), (gun.as_str(), MARLOWE, "held"));
    assert_eq!((g.owners, g.recovered, g.condition, g.maker.as_str()), (2, 1, 85, ROOK));
    assert!(out.weapon.is_none());
    assert_eq!(events("nep171", "nft_transfer")[0]["new_owner_id"], MARLOWE);
    assert_eq!(events("saltline", "recover").len(), 1);
    // The wreck's items came out of the contract's keeping; only MARLOWE's own cargo is new.
    for t in 0..TOKEN_COUNT {
        assert_eq!(
            w.bal(marlowe, t),
            got[t] + left[t] + if t == AMMO { 2 } else { 0 } + if t == SCRIP { 150 } else { 0 }
        );
        assert_eq!(w.c.supply[t] - supply[t], got[t], "{}", TOKENS[t].id);
        assert_eq!(w.c.pool[t], 0);
    }
    assert!(w.c.wrecks().is_empty());
    assert!(w.c.weapons(acc(ROOK)).is_empty());
    assert_eq!(w.c.weapons(acc(MARLOWE)).len(), 1);
    // It is MARLOWE's to use now.
    w.as_(MARLOWE).list_weapon(gun.clone(), U128(900));
    w.check();
}

#[test]
fn a_raid_is_offered_the_three_newest_wrecks() {
    let mut w = World::new();
    let (rook, _, _) = w.crew();
    w.give(rook, AMMO, 4);
    // Four wrecks, oldest first; two of them at the same spot.
    for (id, spot) in [(1u64, 1u32), (2, 4), (3, 4), (4, 9)] {
        let r = w.as_(ROOK).start_raid(Loadout { weapon: None, plates: 0, charges: 0, mags: 1 });
        w.wait(30);
        assert_eq!(w.as_(ROOK).die(r.raid_id, Report::default(), spot, "machines".into()).wreck_id, Some(id));
    }
    let r = w.start(MARLOWE, None);
    assert_eq!(r.wrecks.iter().map(|x| x.id).collect::<Vec<_>>(), vec![4, 3, 2]);
    assert_eq!(r.containers.len(), 8);
    assert!(r.containers.iter().all(|c| c.spot != 4 && c.spot != 9));
    // Those three are MARLOWE's until that raid ends: VANE is offered the one left, and ROOK none of their own.
    assert_eq!(w.start(VANE, None).wrecks.iter().map(|x| x.id).collect::<Vec<_>>(), vec![1]);
    assert!(w.start(ROOK, None).wrecks.is_empty());
    // A wreck in a manifest doesn't lapse until that raid ends, and can still be carried out.
    w.wait(RAID_EXPIRY_SECONDS - 60);
    w.c.wrecks.iter_mut().for_each(|x| x.expires_at = w.now); // test setup: all four are past their time
    assert!(w.c.wrecks().is_empty(), "left out of the yard's list");
    let out = w.as_(MARLOWE).extract(r.raid_id, Report { wrecks: vec![4, 2], ..Default::default() });
    assert_eq!(out.minted["ammo"], U128(2));
    assert_eq!(w.c.wrecks.iter().map(|x| x.id).collect::<Vec<_>>(), vec![1, 3], "3 is free again, and lapsed");
    w.check();
}

#[test]
fn dying_releases_the_wrecks_a_raid_held() {
    let mut w = World::new();
    let (rook, _, _) = w.crew();
    w.give(rook, AMMO, 1);
    let r = w.as_(ROOK).start_raid(Loadout { weapon: None, plates: 0, charges: 0, mags: 1 });
    w.wait(10);
    let wreck = w.as_(ROOK).die(r.raid_id, Report::default(), 2, "machines".into()).wreck_id.unwrap();
    let r = w.start(MARLOWE, None);
    assert_eq!(r.wrecks.len(), 1);
    assert_eq!(w.c.wrecks[0].reserved_by, Some(r.raid_id));
    w.wait(10);
    // MARLOWE dies holding it: it stays where it was, free for the next raid.
    let out = w.as_(MARLOWE).die(r.raid_id, Report { wrecks: vec![wreck], ..Default::default() }, 7, "machines".into());
    assert_eq!(out.wreck_id, None);
    assert_eq!((w.c.wrecks.len(), w.c.wrecks[0].reserved_by, w.c.wrecks[0].spot), (1, None, 2));
    assert_eq!(w.start(VANE, None).wrecks.len(), 1);
    w.check();
}

#[test]
fn the_bailiff_impounds_the_gun_and_destroys_the_rest() {
    let mut w = World::new();
    let (rook, _, _) = w.crew();
    let gun = w.build(ROOK, rook, "longshore");
    let n = parse_serial(&gun).unwrap();
    w.give(rook, AMMO, 4);
    w.give(rook, PLATE, 1);
    let r = w.as_(ROOK).start_raid(Loadout { weapon: Some(gun.clone()), plates: 1, charges: 0, mags: 4 });
    let (spots, _, weight) = pick(&r, 6);
    w.wait(300);
    let supply = w.c.supply;
    let value = w.c.gun(n).value();
    let out = w.as_(ROOK).die(r.raid_id, opened(spots.clone()), 4, "bailiff".into());
    let invoice = 150 + 300 * 40 / 60 + 60 * spots.len() as u128 + 30 * weight;
    assert_eq!((out.wreck_id, out.impounded, out.invoice.0, out.arrears.0), (None, true, invoice, invoice / 10));
    // No cargo was ever minted, and the whole kit is gone.
    for &t in MATERIALS.iter() {
        assert_eq!(w.c.supply[t], supply[t]);
    }
    assert_eq!((supply[AMMO] - w.c.supply[AMMO], supply[PLATE] - w.c.supply[PLATE]), (4, 1));
    assert!(w.c.wrecks().is_empty());
    // The gun: 48 hours, at 40% of its appraisal.
    let held = w.c.impound(acc(ROOK));
    assert_eq!(held.len(), 1);
    assert_eq!((held[0].weapon.serial.as_str(), held[0].weapon.state.as_str()), (gun.as_str(), "impound"));
    assert_eq!((held[0].fee.0, held[0].expires_at), (value * 40 / 100, w.now + 48 * HOUR * 1_000));
    assert_eq!(events("saltline", "impound")[0]["fee"], (value * 40 / 100).to_string());
    assert!(w.c.impound(acc(MARLOWE)).is_empty());

    // Buying it back pays the Harbormaster.
    refuses("E_NOT_OWNER", || w.as_(MARLOWE).buy_back(gun.clone()));
    refuses("E_NO_WEAPON", || w.as_(ROOK).buy_back("S-000050".into()));
    refuses("E_FUNDS", || w.as_(ROOK).buy_back(gun.clone()));
    let fee = held[0].fee.0;
    w.give(rook, SCRIP, fee);
    let scrip = w.bal(rook, SCRIP);
    let back = w.as_(ROOK).buy_back(gun.clone());
    assert_eq!((back.cost.0, back.weapon.state.as_str(), back.weapon.owners), (fee, "held", 1));
    assert_eq!(w.bal(rook, SCRIP), scrip - fee);
    assert_eq!(w.c.harbormaster().balance.0, fee);
    assert!(w.c.impound(acc(ROOK)).is_empty());
    refuses("E_NOT_IMPOUNDED", || w.as_(ROOK).buy_back(gun.clone()));
    w.check();
}

#[test]
fn an_impound_lapses_after_48_hours() {
    let mut w = World::new();
    let (rook, _, _) = w.crew();
    let gun = w.build(ROOK, rook, "stevedore");
    let r = w.start(ROOK, Some(&gun));
    w.wait(60);
    w.as_(ROOK).die(r.raid_id, Report::default(), 4, "bailiff".into());
    w.give(rook, SCRIP, 5_000);
    w.wait(48 * HOUR - 1);
    assert_eq!(w.c.impound(acc(ROOK)).len(), 1);
    w.wait(1);
    // Gone from every view at once; burned by the owner's next call.
    assert!(w.c.impound(acc(ROOK)).is_empty());
    assert!(w.c.weapon(gun.clone()).is_none());
    assert!(w.c.weapons(acc(ROOK)).is_empty());
    assert_eq!(w.c.nft_supply_for_owner(acc(ROOK)).0, 0);
    assert_eq!(w.c.guns_destroyed, 0);
    w.as_(ROOK).settle(U128(1));
    assert_eq!(events("nep171", "nft_burn")[0]["token_ids"][0], gun);
    refuses("E_NO_WEAPON", || w.as_(ROOK).buy_back(gun.clone()));
    assert_eq!((w.c.guns_destroyed, w.c.guns.len()), (1, 2));
    assert!(w.c.player(rook).impounded.is_empty() && w.c.player(rook).guns.is_empty());
    w.check();
}

#[test]
fn a_wreck_nobody_recovers_is_burned_after_24_hours() {
    let mut w = World::new();
    let (rook, _, _) = w.crew();
    let gun = w.build(ROOK, rook, "longshore");
    w.give(rook, AMMO, 2);
    let r = w.as_(ROOK).start_raid(Loadout { weapon: Some(gun.clone()), plates: 0, charges: 0, mags: 2 });
    let (spots, got, _) = pick(&r, 6);
    w.wait(100);
    w.as_(ROOK).die(r.raid_id, opened(spots), 1, "machines".into());
    let supply = w.c.supply;
    w.wait(24 * HOUR - 1);
    assert_eq!(w.c.wrecks().len(), 1);
    assert!(w.c.weapon(gun.clone()).is_some());
    w.wait(1);
    // Left out of the views at once, and not offered to a raid.
    assert!(w.c.wrecks().is_empty());
    assert!(w.c.weapon(gun.clone()).is_none());
    assert!(w.c.weapons(acc(ROOK)).is_empty());
    assert_eq!(w.c.wrecks.len(), 1, "still stored until something touches the list");
    let r = w.start(MARLOWE, None);
    assert!(r.wrecks.is_empty());
    // That call burned it: the gun, the cargo and the magazines.
    assert_eq!(w.c.wrecks.len(), 0);
    assert_eq!((w.c.guns_destroyed, w.c.guns.len()), (1, 2));
    for &t in MATERIALS.iter() {
        assert_eq!(supply[t] - w.c.supply[t], got[t]);
    }
    assert_eq!(supply[AMMO] - w.c.supply[AMMO], 2);
    assert!(w.c.pool.iter().all(|&n| n == 0));
    assert!(w.c.player(rook).guns.is_empty());
    w.check();
}

#[test]
fn expiry_does_bounded_work_and_the_yard_holds_forty_wrecks() {
    let mut w = World::new();
    let (rook, _, _) = w.crew();
    w.give(rook, AMMO, 60);
    let die = |w: &mut World| {
        let r = w.as_(ROOK).start_raid(Loadout { weapon: None, plates: 0, charges: 0, mags: 1 });
        w.wait(30);
        w.as_(ROOK).die(r.raid_id, Report::default(), 6, "machines".into()).wreck_id.unwrap()
    };
    for i in 1..=MAX_WRECKS as u64 {
        assert_eq!(die(&mut w), i);
    }
    assert_eq!((w.c.wrecks.len(), w.c.pool[AMMO]), (40, 40));
    // The forty-first takes the oldest one's place.
    assert_eq!(die(&mut w), 41);
    assert_eq!((w.c.wrecks.len(), w.c.wrecks[0].id, w.c.pool[AMMO]), (40, 2, 40));
    assert_eq!(w.c.wrecks().first().unwrap().id, 41, "newest first");
    // A day later all forty have lapsed. Each call that touches the yard burns three, no more.
    w.wait(24 * HOUR);
    assert!(w.c.wrecks().is_empty());
    w.start(MARLOWE, None);
    assert_eq!((w.c.wrecks.len(), w.c.pool[AMMO]), (37, 37));
    w.wait(30);
    w.start(MARLOWE, None);
    assert_eq!(w.c.wrecks.len(), 34);
    w.check();
}

#[test]
fn a_gun_in_custody_cannot_be_used() {
    let mut w = World::new();
    let (rook, marlowe, _) = w.crew();
    w.give(rook, COMP, 5);
    w.give(rook, COPPER, 5);
    w.give(rook, SCRIP, 500);
    let busy = |w: &mut World, gun: &str, state: u8| {
        assert_eq!(w.gun_state(gun), state);
        refuses("E_WEAPON_BUSY", || w.as_(ROOK).list_weapon(gun.into(), U128(100)));
        refuses("E_WEAPON_BUSY", || w.as_yocto(ROOK).nft_transfer(acc(MARLOWE), gun.into(), None, None));
        refuses("E_WEAPON_BUSY", || w.as_(ROOK).scrap(gun.into()));
        refuses("E_WEAPON_BUSY", || w.as_(ROOK).fit(gun.into(), "comp".into()));
        refuses("E_WEAPON_BUSY", || w.as_(ROOK).repair(gun.into(), Some(1)));
        if state != IN_RAID {
            refuses("E_WEAPON_BUSY", || {
                w.wait(31);
                w.start(ROOK, Some(gun))
            });
        }
        if state != IMPOUNDED {
            refuses("E_NOT_IMPOUNDED", || w.as_(ROOK).buy_back(gun.into()));
        }
        assert_eq!(w.gun_state(gun), state);
        assert_eq!(w.c.gun(parse_serial(gun).unwrap()).owner, acc(ROOK));
    };
    // In a raid.
    let a = w.build(ROOK, rook, "longshore");
    w.c.gun_mut(parse_serial(&a).unwrap()).condition = 90;
    let r = w.start(ROOK, Some(&a));
    busy(&mut w, &a, IN_RAID);
    // In a wreck.
    w.wait(31);
    w.as_(ROOK).die(r.raid_id, Report::default(), 0, "machines".into());
    busy(&mut w, &a, IN_WRECK);
    // In the impound.
    let b = w.build(ROOK, rook, "stevedore");
    w.c.gun_mut(parse_serial(&b).unwrap()).condition = 90;
    let r = w.start(ROOK, Some(&b));
    w.wait(5);
    w.as_(ROOK).die(r.raid_id, Report::default(), 0, "bailiff".into());
    busy(&mut w, &b, IMPOUNDED);
    // On the market.
    let c = w.build(ROOK, rook, "stevedore");
    w.c.gun_mut(parse_serial(&c).unwrap()).condition = 90;
    w.as_(ROOK).list_weapon(c.clone(), U128(700));
    busy(&mut w, &c, LISTED);
    // On a vendor's rack: nobody's to use.
    refuses("E_NOT_OWNER", || w.as_(ROOK).scrap("S-000001".into()));
    refuses("E_NOT_REGISTERED", || w.as_yocto(MOSS_ACC).nft_transfer(acc(ROOK), "S-000001".into(), None, None));
    let _ = marlowe;
    w.check();
}

// -----------------------------------------------------------------------------------------------------------------
// Arrears and the Harbormaster
// -----------------------------------------------------------------------------------------------------------------

#[test]
fn settle_pays_the_harbormaster_and_clears_twice_as_much() {
    let mut w = World::new();
    let (rook, _, _) = w.crew();
    refuses("E_NOT_REGISTERED", || w.as_(STRANGER).settle(U128(10)));
    refuses("E_NOTHING_OWED", || w.as_(ROOK).settle(U128(10)));
    w.c.player_mut(rook).arrears = 1_005;
    refuses("E_BAD_AMOUNT", || w.as_(ROOK).settle(U128(0)));
    refuses("E_FUNDS", || w.as_(ROOK).settle(U128(151)));
    let out = w.as_(ROOK).settle(U128(100));
    assert_eq!((out.paid.0, out.cleared.0, out.arrears.0), (100, 200, 805));
    assert_eq!((w.bal(rook, SCRIP), w.c.hm.bal[SCRIP]), (50, 100));
    assert_eq!(events("nep245", "mt_transfer")[0]["new_owner_id"], HM);
    // Offering more than is owed takes only ⌈arrears ÷ 2⌉.
    w.give(rook, SCRIP, 1_000);
    let out = w.as_(ROOK).settle(U128(1_000));
    assert_eq!((out.paid.0, out.cleared.0, out.arrears.0), (403, 805, 0));
    assert_eq!(w.bal(rook, SCRIP), 50 + 1_000 - 403);
    refuses("E_NOTHING_OWED", || w.as_(ROOK).settle(U128(1)));
    let hm = w.c.harbormaster();
    assert_eq!((hm.balance.0, hm.strength, hm.bonus_drones), (503, 25, 1));
    assert_eq!(
        (hm.second_notice_at.0, hm.bailiff_at.0, hm.second_bailiff_at.0, hm.foreclosure_at.0),
        (600, 1_200, 2_400, 4_000)
    );
    assert_eq!((hm.account_id.as_str(), hm.posture.as_str(), hm.last_memo), (HM, "patrols", None));
    w.check();
}

#[test]
fn the_harbormasters_balance_halves_every_twelve_hours_and_the_loss_is_burned() {
    let mut w = World::new();
    let (rook, _, _) = w.crew();
    w.give(rook, SCRIP, 10_000);
    w.c.player_mut(rook).arrears = 20_000;
    w.as_(ROOK).settle(U128(2_000));
    let hm = w.c.harbormaster();
    assert_eq!((hm.balance.0, hm.strength, hm.bonus_drones), (2_000, 100, 4));
    let supply = w.c.shown_supply(SCRIP);
    w.wait(12 * HOUR);
    let hm = w.c.harbormaster();
    assert_eq!((hm.balance.0, hm.strength, hm.bonus_drones), (1_000, 50, 2));
    // The views already count the decay as burned, before any call logs it.
    assert_eq!(w.c.mt_balance_of(acc(HM), "scrip".into()).0, 1_000);
    assert_eq!(w.c.balances(acc(HM))["scrip"], U128(1_000));
    assert_eq!(w.c.mt_supply("scrip".into()).unwrap().0, supply - 1_000);
    assert_eq!(w.c.supply[SCRIP], supply, "not burned in the ledger yet");
    w.wait(12 * HOUR);
    assert_eq!(w.c.harbormaster().balance.0, 500);
    // The next payment burns what decayed, with an event.
    w.as_(ROOK).settle(U128(100));
    let burn = &events("nep245", "mt_burn")[0];
    assert_eq!((burn["owner_id"].as_str().unwrap(), burn["amounts"][0].as_str().unwrap()), (HM, "1500"));
    assert_eq!((w.c.hm.bal[SCRIP], w.c.supply[SCRIP]), (600, supply - 1_500));
    assert_eq!(w.c.harbormaster().balance.0, 600);
    w.wait(200 * HOUR);
    assert_eq!((w.c.harbormaster().balance.0, w.c.harbormaster().strength), (0, 0));
    w.check();
}

#[test]
fn paying_often_does_not_bleed_the_harbormaster() {
    // 720 payments of 1 scrip a minute for 12 hours on top of 2,000. Decayed exactly that is 2,000 / 2 + 519.6.
    // Rounding the whole-scrip balance down at every payment would leave about 800. The curve's straight-line
    // steps make a wallet touched every minute decay about 1.5% slow instead, which is the bound checked here.
    let mut w = World::new();
    let (rook, _, _) = w.crew();
    w.give(rook, SCRIP, 10_000);
    w.c.player_mut(rook).arrears = 100_000;
    w.as_(ROOK).settle(U128(2_000));
    for _ in 0..720 {
        w.wait(60);
        w.as_(ROOK).settle(U128(1));
    }
    let balance = w.c.harbormaster().balance.0;
    assert!((1_519..=1_545).contains(&balance), "balance {balance}");
    assert_eq!(w.c.hm.bal[SCRIP], w.c.hm.micro / MICRO);
    w.check();
}

// -----------------------------------------------------------------------------------------------------------------
// Vendors and the export desk
// -----------------------------------------------------------------------------------------------------------------

#[test]
fn selling_to_a_vendor_pays_its_bid_unit_by_unit() {
    let mut w = World::new();
    let (rook, _, _) = w.crew();
    w.give(rook, COPPER, 10);
    w.give(rook, MEDS, 3);
    refuses("E_NOT_REGISTERED", || w.as_(STRANGER).sell("moss".into(), "copper".into(), U128(1)));
    refuses("E_NOT_VENDOR", || w.as_(ROOK).sell("qm".into(), "copper".into(), U128(1)));
    refuses("E_DOESNT_BUY", || w.as_(ROOK).sell("moss".into(), "meds".into(), U128(1)));
    refuses("E_DOESNT_BUY", || w.as_(ROOK).sell("ines".into(), "servo".into(), U128(1)));
    refuses("E_DOESNT_BUY", || w.as_(ROOK).sell("moss".into(), "scrip".into(), U128(1)));
    refuses("E_DOESNT_BUY", || w.as_(ROOK).sell("moss".into(), "ammo".into(), U128(1)));
    refuses("E_BAD_AMOUNT", || w.as_(ROOK).sell("moss".into(), "copper".into(), U128(0)));
    refuses("E_BAD_AMOUNT", || w.as_(ROOK).sell("moss".into(), "copper".into(), U128(51)));
    refuses("E_FUNDS", || w.as_(ROOK).sell("moss".into(), "copper".into(), U128(11)));
    // Moss holds 15 copper against a target of 20: 45, then 44, then 43.
    let out = w.as_(ROOK).sell("moss".into(), "copper".into(), U128(3));
    assert_eq!(out.paid.0, 132);
    assert_eq!((w.bal(rook, SCRIP), w.bal(rook, COPPER)), (282, 7));
    assert_eq!((w.c.vendors[MOSS].bal[SCRIP], w.c.vendors[MOSS].bal[COPPER]), (1_368, 18));
    assert_eq!(events("saltline", "sale")[0]["text"], "ROOK sold 3 copper to Moss for 132.");
    let view = &w.c.vendors()[0];
    assert_eq!(
        (view.id.as_str(), view.account_id.as_str(), view.name.as_str(), view.open),
        ("moss", MOSS_ACC, "Moss", true)
    );
    assert_eq!((view.scrip.0, view.stock["copper"]), (1_368, U128(18)));
    assert_eq!((view.bids[0].token_id.as_str(), view.bids[0].price.0), ("copper", 42));
    w.check();
}

#[test]
fn a_vendor_keeps_its_float() {
    let mut w = World::new();
    let (rook, _, _) = w.crew();
    w.give(rook, COPPER, 5);
    w.c.burn(Holder::Vendor(MOSS), SCRIP, 1_350); // test setup: Moss is down to 150
    refuses("E_VENDOR_BROKE", || w.as_(ROOK).sell("moss".into(), "copper".into(), U128(2))); // 89 + 100 > 150
    assert_eq!(w.as_(ROOK).sell("moss".into(), "copper".into(), U128(1)).paid.0, 45);
    assert_eq!(w.c.vendors[MOSS].bal[SCRIP], 105);
    refuses("E_VENDOR_BROKE", || w.as_(ROOK).sell("moss".into(), "copper".into(), U128(1)));
    let view = &w.c.vendors()[0];
    assert!(!view.open, "it can't cover anything it buys");
    assert!(view.bids[0].reason.starts_with("Can't pay"));
    // Selling something refills the till: a player buys a gun off the rack.
    w.give(rook, SCRIP, 3_000);
    w.as_(ROOK).buy_gun("moss".into(), "S-000002".into());
    assert!(w.c.vendors()[0].open);
    w.check();
}

#[test]
fn buying_goods_and_guns_from_vendors() {
    let mut w = World::new();
    let (rook, _, _) = w.crew();
    refuses("E_NOT_VENDOR", || w.as_(ROOK).buy("nobody".into(), "ammo".into(), U128(1)));
    refuses("E_DOESNT_SELL", || w.as_(ROOK).buy("moss".into(), "ammo".into(), U128(1)));
    refuses("E_DOESNT_SELL", || w.as_(ROOK).buy("ines".into(), "meds".into(), U128(1)));
    refuses("E_DOESNT_SELL", || w.as_(ROOK).buy("ines".into(), "comp".into(), U128(1)));
    refuses("E_NO_STOCK", || w.as_(ROOK).buy("moss".into(), "comp".into(), U128(1)));
    refuses("E_NO_STOCK", || w.as_(ROOK).buy("ines".into(), "plate".into(), U128(11)));
    refuses("E_BAD_AMOUNT", || w.as_(ROOK).buy("ines".into(), "ammo".into(), U128(0)));
    refuses("E_FUNDS", || w.as_(ROOK).buy("ines".into(), "plate".into(), U128(3))); // 162 against 150
    let out = w.as_(ROOK).buy("ines".into(), "ammo".into(), U128(4));
    assert_eq!(out.cost.0, 52);
    assert_eq!((w.bal(rook, AMMO), w.bal(rook, SCRIP)), (4, 98));
    assert_eq!((w.c.vendors[INES].bal[AMMO], w.c.vendors[INES].bal[SCRIP]), (36, 1_552));
    // List price down to five on the shelf; each unit under five costs 8% more.
    w.give(rook, SCRIP, 5_000);
    assert_eq!(w.as_(ROOK).buy("ines".into(), "plate".into(), U128(5)).cost.0, 5 * 54);
    let goods = &w.c.vendors()[1].goods;
    assert_eq!((goods[0].token_id.as_str(), goods[0].price.0, goods[0].stock.0), ("plate", 54, 5));
    assert_eq!(w.as_(ROOK).buy("ines".into(), "plate".into(), U128(2)).cost.0, 54 + 58);
    let goods = &w.c.vendors()[1].goods;
    assert_eq!((goods[0].price.0, goods[0].stock.0), (62, 3)); // 54 × 1.16 = 62.64
    assert_eq!(
        (goods[1].token_id.as_str(), goods[1].price.0, goods[2].token_id.as_str(), goods[2].price.0),
        ("charge", 30, "ammo", 13)
    );

    // A gun off Moss's rack: 125% of its appraisal.
    refuses("E_NO_WEAPON", || w.as_(ROOK).buy_gun("moss".into(), "S-000009".into()));
    refuses("E_DOESNT_SELL", || w.as_(ROOK).buy_gun("ines".into(), "S-000001".into()));
    let rack = &w.c.vendors()[0].guns;
    let (price, value) = (rack[0].price.0, rack[0].weapon.value.0);
    assert_eq!(price, value * 125 / 100);
    let scrip = w.bal(rook, SCRIP);
    let moss = w.c.vendors[MOSS].bal[SCRIP];
    let out = w.as_(ROOK).buy_gun("moss".into(), "S-000001".into());
    assert_eq!(
        (out.cost.0, out.weapon.state.as_str(), out.weapon.owner.as_str(), out.weapon.owners),
        (price, "held", ROOK, 2)
    );
    assert_eq!(out.weapon.maker_callsign, "MOSS");
    assert_eq!((w.bal(rook, SCRIP), w.c.vendors[MOSS].bal[SCRIP]), (scrip - price, moss + price));
    assert_eq!(w.c.vendors()[0].guns.len(), 1);
    refuses("E_DOESNT_SELL", || w.as_(MARLOWE).buy_gun("moss".into(), "S-000001".into()));
    let poor = w.register("poor.testnet", "poor");
    refuses("E_FUNDS", || w.as_("poor.testnet").buy_gun("moss".into(), "S-000002".into()));
    let _ = poor;
    w.check();
}

#[test]
fn ines_meds_go_to_the_clinic() {
    let mut w = World::new();
    let (rook, _, _) = w.crew();
    w.give(rook, MEDS, 10);
    let meds = |w: &World| {
        let ines = &w.c.vendors()[1];
        (ines.stock["meds"].0, ines.bids[0].token_id.clone(), ines.bids[0].price.0)
    };
    // 7 at the start against a target of 10: the bid is 60 × 2 × 10 / 17.
    assert_eq!(meds(&w), (7, "meds".to_string(), 70));
    // Twelve hours on the clinic has used half: 3.5 left, shown as 3, and the bid is back up.
    w.wait(12 * HOUR);
    assert_eq!(meds(&w), (3, "meds".to_string(), 92));
    assert_eq!(w.c.mt_balance_of(acc(INES_ACC), "meds".into()).0, 3);
    assert_eq!(w.c.balances(acc(INES_ACC))["meds"], U128(3));
    assert_eq!(w.c.mt_supply("meds".into()).unwrap().0, 3 + 10);
    assert_eq!(w.c.vendors[INES].bal[MEDS], 7, "not burned in the ledger until a call touches it");
    // A sale burns what the clinic used, then adds to what is left: 92 for the first, 85 for the second.
    let out = w.as_(ROOK).sell("ines".into(), "meds".into(), U128(2));
    assert_eq!(out.paid.0, 92 + 85);
    let burn = &events("nep245", "mt_burn")[0];
    assert_eq!(
        (burn["owner_id"].as_str().unwrap(), burn["amounts"][0].as_str().unwrap(), burn["memo"].as_str().unwrap()),
        (INES_ACC, "4", "used by the clinic")
    );
    assert_eq!((w.c.vendors[INES].bal[MEDS], w.c.clinic.0), (5, 5_500_000));
    assert_eq!(meds(&w).0, 5);
    // Her other stock doesn't decay, and neither does anyone else's meds.
    w.wait(12 * HOUR);
    assert_eq!((meds(&w).0, w.c.vendors()[1].stock["fuel"].0, w.bal(rook, MEDS)), (2, 6, 8));
    // Shipping her meds counts what is left, not what the ledger last said.
    let paid = w.as_(INES_ACC).export("meds".into(), U128(1)).paid.0;
    assert_eq!(paid, 40);
    assert_eq!((w.c.vendors[INES].bal[MEDS], w.c.clinic.0, meds(&w).0), (1, 1_750_000, 1));
    let mut w2 = World::new();
    w2.wait(24 * HOUR); // 7 → 1.75
    refuses("E_FUNDS", || w2.as_(INES_ACC).export("meds".into(), U128(2)));
}

#[test]
fn the_export_desk_mints_scrip_at_a_falling_price() {
    let mut w = World::new();
    let (rook, _, _) = w.crew();
    w.give(rook, COPPER, 60);
    w.give(rook, AMMO, 1);
    refuses("E_NOT_REGISTERED", || w.as_(STRANGER).export("copper".into(), U128(1)));
    refuses("E_NOT_REGISTERED", || w.as_(HM).export("copper".into(), U128(1)));
    refuses("E_NOT_REGISTERED", || w.as_(FAUCET).export("copper".into(), U128(1)));
    refuses("E_DOESNT_BUY", || w.as_(ROOK).export("ammo".into(), U128(1)));
    refuses("E_DOESNT_BUY", || w.as_(ROOK).export("scrip".into(), U128(1)));
    refuses("E_BAD_AMOUNT", || w.as_(ROOK).export("copper".into(), U128(0)));
    refuses("E_BAD_AMOUNT", || w.as_(ROOK).export("copper".into(), U128(51)));
    refuses("E_FUNDS", || w.as_(ROOK).export("core".into(), U128(1)));
    let supply = w.c.supply;
    assert_eq!(w.c.export_prices()[0].price.0, 25);
    let out = w.as_(ROOK).export("copper".into(), U128(4));
    assert_eq!(out.paid.0, 25 + 24 + 23 + 22);
    assert_eq!(w.c.supply[SCRIP] - supply[SCRIP], 94, "newly minted");
    assert_eq!(supply[COPPER] - w.c.supply[COPPER], 4, "the copper is burned");
    assert_eq!(events("nep245", "mt_mint")[0]["memo"], "export");
    let quote = &w.c.export_prices()[0];
    assert_eq!((quote.token_id.as_str(), quote.price.0), ("copper", 21)); // 25 × 100 / 116
    assert_eq!(w.c.export_prices()[4].price.0, 100, "other materials are untouched");
    // Twelve hours on, half the volume has faded: 25 × 100 / 108.
    w.wait(12 * HOUR);
    assert_eq!(w.c.export_prices()[0].price.0, 23);
    assert_eq!(w.as_(ROOK).export("copper".into(), U128(1)).paid.0, 23);
    // A vendor ships its own stock.
    let moss = w.c.vendors[MOSS].bal[SCRIP];
    let paid = w.as_(MOSS_ACC).export("core".into(), U128(2)).paid.0;
    assert_eq!(paid, 100 + 96);
    assert_eq!((w.c.vendors[MOSS].bal[SCRIP], w.c.vendors[MOSS].bal[CORE]), (moss + 196, 2));
    assert_eq!(events("saltline", "export")[0]["text"], "Moss shipped 2 core on the freighter for 196.");
    // Flooding the desk never pays nothing, and never pays more than the base.
    let mut last = u128::MAX;
    for _ in 0..5 {
        let paid = w.as_(ROOK).export("copper".into(), U128(10)).paid.0;
        assert!(paid >= 10 && paid < last && paid <= 250);
        last = paid;
    }
    w.check();
}

// -----------------------------------------------------------------------------------------------------------------
// The market
// -----------------------------------------------------------------------------------------------------------------

#[test]
fn a_gun_sale_pays_the_seller_the_maker_and_the_fire() {
    let mut w = World::new();
    let (rook, marlowe, vane) = w.crew();
    let gun = w.build(ROOK, rook, "pilot");
    // ROOK builds it and gives it to MARLOWE, who lists it; VANE buys. ROOK is owed the royalty.
    w.as_yocto(ROOK).nft_transfer(acc(MARLOWE), gun.clone(), None, Some("a gift".into()));
    refuses("E_NOT_OWNER", || w.as_(ROOK).list_weapon(gun.clone(), U128(1_000)));
    refuses("E_BAD_AMOUNT", || w.as_(MARLOWE).list_weapon(gun.clone(), U128(0)));
    refuses("E_BAD_AMOUNT", || w.as_(MARLOWE).list_weapon(gun.clone(), U128(MAX_PRICE + 1)));
    let id = w.as_(MARLOWE).list_weapon(gun.clone(), U128(1_000)).id;
    assert_eq!(w.gun_state(&gun), LISTED);
    let board = w.c.listings();
    assert_eq!(
        (board.len(), board[0].id, board[0].seller.as_str(), board[0].callsign.as_str(), board[0].price.0),
        (1, id, MARLOWE, "MARLOWE", 1_000)
    );
    assert_eq!(board[0].weapon.as_ref().unwrap().state, "listed");
    assert!(board[0].item.is_none());
    refuses("E_NO_LISTING", || w.as_(VANE).buy_listing(99));
    refuses("E_NO_LISTING", || w.as_(MARLOWE).buy_listing(id));
    refuses("E_FUNDS", || w.as_(VANE).buy_listing(id));
    w.give(vane, SCRIP, 850);
    let supply = w.c.supply[SCRIP];
    let grade = w.c.gun(parse_serial(&gun).unwrap()).grade();
    let out = w.as_(VANE).buy_listing(id);
    let sold = out.weapon.unwrap();
    assert_eq!((out.paid.0, sold.owner.as_str(), sold.state.as_str(), sold.owners), (1_000, VANE, "held", 3));
    assert_eq!((w.bal(vane, SCRIP), w.bal(marlowe, SCRIP), w.bal(rook, SCRIP)), (0, 150 + 960, 150 + 20));
    assert_eq!(supply - w.c.supply[SCRIP], 20, "2% burned");
    assert_eq!(w.c.profile(acc(ROOK)).unwrap().royalties.0, 20);
    assert_eq!(w.c.profile(acc(MARLOWE)).unwrap().royalties.0, 0);
    assert_eq!(w.c.last_sales[PILOT * GRADE_COUNT + grade], vec![1_000]);
    assert_eq!(events("saltline", "market_sale")[0]["royalty"], "20");
    assert!(w.c.listings().is_empty());
    refuses("E_NO_LISTING", || w.as_(ROOK).buy_listing(id));
    // Six more sales of the same gun: the last five prices are kept, oldest first.
    w.give(vane, SCRIP, 10_000);
    w.give(marlowe, SCRIP, 10_000);
    let (mut seller, mut buyer) = (VANE, MARLOWE);
    for price in [100u128, 200, 300, 400, 500, 600] {
        let id = w.as_(seller).list_weapon(gun.clone(), U128(price)).id;
        w.as_(buyer).buy_listing(id);
        (seller, buyer) = (buyer, seller);
    }
    assert_eq!(w.c.last_sales[PILOT * GRADE_COUNT + grade], vec![200, 300, 400, 500, 600]);
    assert_eq!(w.c.profile(acc(ROOK)).unwrap().royalties.0, 20 + 2 + 4 + 6 + 8 + 10 + 12);
    w.check();
}

#[test]
fn a_vendor_built_gun_pays_its_royalty_to_the_vendor() {
    let mut w = World::new();
    let (rook, _, vane) = w.crew();
    w.give(rook, SCRIP, 3_000);
    w.give(vane, SCRIP, 3_000);
    w.as_(ROOK).buy_gun("moss".into(), "S-000001".into());
    let id = w.as_(ROOK).list_weapon("S-000001".into(), U128(500)).id;
    let moss = w.c.vendors[MOSS].bal[SCRIP];
    w.as_(VANE).buy_listing(id);
    assert_eq!(w.c.vendors[MOSS].bal[SCRIP], moss + 10);
    w.check();
}

#[test]
fn items_are_listed_in_escrow_and_the_whole_fee_is_burned() {
    let mut w = World::new();
    let (rook, marlowe, _) = w.crew();
    w.give(rook, CORE, 3);
    refuses("E_BAD_AMOUNT", || w.as_(ROOK).list_item("scrip".into(), U128(10), U128(10)));
    refuses("E_FUNDS", || w.as_(ROOK).list_item("gold".into(), U128(1), U128(10)));
    refuses("E_FUNDS", || w.as_(ROOK).list_item("core".into(), U128(4), U128(10)));
    refuses("E_BAD_AMOUNT", || w.as_(ROOK).list_item("core".into(), U128(0), U128(10)));
    refuses("E_BAD_AMOUNT", || w.as_(ROOK).list_item("core".into(), U128(1), U128(0)));
    let a = w.as_(ROOK).list_item("core".into(), U128(2), U128(150)).id;
    let b = w.as_(ROOK).list_item("core".into(), U128(1), U128(49)).id;
    assert_eq!((w.bal(rook, CORE), w.c.pool[CORE]), (0, 3));
    let board = w.c.listings();
    assert_eq!((board[0].id, board[1].id), (b, a), "newest first");
    let item = board[1].item.as_ref().unwrap();
    assert_eq!((item.token_id.as_str(), item.amount.0), ("core", 2));
    assert!(board[1].weapon.is_none());
    // The seller can take it down; nobody else can.
    refuses("E_NOT_OWNER", || w.as_(MARLOWE).cancel_listing(b));
    refuses("E_NO_LISTING", || w.as_(ROOK).cancel_listing(77));
    w.as_(ROOK).cancel_listing(b);
    assert_eq!((w.bal(rook, CORE), w.c.pool[CORE]), (1, 2));
    // 150 for the lot: 144 to the seller, 6 burned (no maker for items).
    let supply = w.c.supply[SCRIP];
    let out = w.as_(MARLOWE).buy_listing(a);
    assert!(out.weapon.is_none());
    assert_eq!((out.paid.0, w.bal(marlowe, CORE), w.bal(marlowe, SCRIP), w.bal(rook, SCRIP)), (150, 2, 0, 294));
    assert_eq!(supply - w.c.supply[SCRIP], 6);
    assert_eq!(w.c.pool[CORE], 0);
    w.check();
}

#[test]
fn the_board_and_a_locker_are_bounded() {
    let mut w = World::new();
    let (rook, marlowe, _) = w.crew();
    w.give(rook, COPPER, 300);
    for _ in 0..MAX_LISTINGS {
        w.as_(ROOK).list_item("copper".into(), U128(1), U128(40));
    }
    refuses("E_FULL", || w.as_(ROOK).list_item("copper".into(), U128(1), U128(40)));
    let gun = w.build(ROOK, rook, "stevedore");
    refuses("E_FULL", || w.as_(ROOK).list_weapon(gun.clone(), U128(40)));
    assert_eq!(w.c.listings().len(), 200);
    // A locker holds 50 guns: no build, purchase or transfer puts a 51st in it.
    for _ in 1..MAX_GUNS_PER_OWNER {
        w.build(ROOK, rook, "stevedore");
    }
    assert_eq!(w.c.weapons(acc(ROOK)).len(), 50);
    assert_eq!(w.c.nft_tokens_for_owner(acc(ROOK), Some(U128(45)), None).len(), 5);
    refuses("E_FULL", || w.build(ROOK, rook, "stevedore"));
    w.give(rook, SCRIP, 5_000);
    refuses("E_FULL", || w.as_(ROOK).buy_gun("moss".into(), "S-000001".into()));
    let theirs = w.build(MARLOWE, marlowe, "stevedore");
    refuses("E_FULL", || w.as_yocto(MARLOWE).nft_transfer(acc(ROOK), theirs.clone(), None, None));
}

#[test]
fn at_most_five_thousand_guns_exist() {
    let mut w = World::new();
    let per = MAX_GUNS_PER_OWNER as u32;
    for i in 0..MAX_GUNS / per {
        let who = format!("p{i}.testnet");
        let ix = w.register(&who, &format!("P{i:04}"));
        let me = acc(&who);
        context(&who, w.now, 0, 7);
        // Test setup: straight through the one function that makes guns. Moss's two are already there.
        for _ in 0..(if i == 0 { per - 2 } else { per }) {
            w.c.mint_gun(Holder::Player(ix), STEVEDORE, &me, "P", HELD);
        }
    }
    assert_eq!(w.c.guns.len(), MAX_GUNS);
    let (rook, _, _) = w.crew();
    refuses("E_FULL", || w.build(ROOK, rook, "longshore"));
    assert_eq!(w.c.nft_total_supply().0, 5_000);
}

// -----------------------------------------------------------------------------------------------------------------
// The token standards
// -----------------------------------------------------------------------------------------------------------------

#[test]
fn nft_transfer_moves_a_held_gun_between_players() {
    let mut w = World::new();
    let (rook, _, _) = w.crew();
    let gun = w.build(ROOK, rook, "longshore");
    refuses("E_BAD_AMOUNT", || w.as_(ROOK).nft_transfer(acc(MARLOWE), gun.clone(), None, None)); // no yocto
    refuses("E_BAD_AMOUNT", || w.as_yocto(ROOK).nft_transfer(acc(MARLOWE), gun.clone(), Some(1), None));
    refuses("E_NOT_REGISTERED", || w.as_yocto(STRANGER).nft_transfer(acc(MARLOWE), gun.clone(), None, None));
    refuses("E_NOT_REGISTERED", || w.as_yocto(ROOK).nft_transfer(acc(STRANGER), gun.clone(), None, None));
    refuses("E_NOT_REGISTERED", || w.as_yocto(ROOK).nft_transfer(acc(MOSS_ACC), gun.clone(), None, None));
    refuses("E_NOT_OWNER", || w.as_yocto(MARLOWE).nft_transfer(acc(VANE), gun.clone(), None, None));
    refuses("E_DUPLICATE", || w.as_yocto(ROOK).nft_transfer(acc(ROOK), gun.clone(), None, None));
    refuses("E_NO_WEAPON", || w.as_yocto(ROOK).nft_transfer(acc(MARLOWE), "S-123456".into(), None, None));
    w.as_yocto(ROOK).nft_transfer(acc(MARLOWE), gun.clone(), None, None);
    let ev = &events("nep171", "nft_transfer")[0];
    assert_eq!(
        (
            ev["old_owner_id"].as_str().unwrap(),
            ev["new_owner_id"].as_str().unwrap(),
            ev["token_ids"][0].as_str().unwrap()
        ),
        (ROOK, MARLOWE, gun.as_str())
    );
    let token = w.c.nft_token(gun.clone()).unwrap();
    assert_eq!((token.token_id.as_str(), token.owner_id.as_str()), (gun.as_str(), MARLOWE));
    let meta = token.metadata.unwrap();
    assert!(meta.title.unwrap().contains(&gun));
    let extra: near_sdk::serde_json::Value = near_sdk::serde_json::from_str(&meta.extra.unwrap()).unwrap();
    assert_eq!(
        (extra["serial"].as_str().unwrap(), extra["owners"].as_u64().unwrap(), extra["maker"].as_str().unwrap()),
        (gun.as_str(), 2, ROOK)
    );
    assert_eq!((w.c.nft_supply_for_owner(acc(ROOK)).0, w.c.nft_supply_for_owner(acc(MARLOWE)).0), (0, 1));
    assert_eq!(w.c.nft_supply_for_owner(acc(MOSS_ACC)).0, 2);
    assert_eq!(w.c.nft_supply_for_owner(acc(STRANGER)).0, 0);
    assert_eq!(w.c.nft_tokens_for_owner(acc(MARLOWE), None, None)[0].token_id, gun);
    assert!(w.c.nft_tokens_for_owner(acc(MARLOWE), Some(U128(1)), Some(5)).is_empty());
    assert_eq!(w.c.nft_total_supply().0, 3);
    assert!(w.c.nft_token("S-000404".into()).is_none());
    w.check();
}

#[test]
fn mt_transfer_moves_tokens_between_players() {
    let mut w = World::new();
    let (rook, marlowe, _) = w.crew();
    w.give(rook, COPPER, 5);
    refuses("E_BAD_AMOUNT", || w.as_(ROOK).mt_transfer(acc(MARLOWE), "copper".into(), U128(1), None, None));
    refuses("E_NOT_REGISTERED", || {
        w.as_yocto(STRANGER).mt_transfer(acc(MARLOWE), "copper".into(), U128(1), None, None)
    });
    refuses("E_NOT_REGISTERED", || w.as_yocto(ROOK).mt_transfer(acc(MOSS_ACC), "copper".into(), U128(1), None, None));
    refuses("E_NOT_REGISTERED", || w.as_yocto(MOSS_ACC).mt_transfer(acc(ROOK), "copper".into(), U128(1), None, None));
    refuses("E_NOT_REGISTERED", || w.as_yocto(HM).mt_transfer(acc(ROOK), "scrip".into(), U128(1), None, None));
    refuses("E_FUNDS", || w.as_yocto(ROOK).mt_transfer(acc(MARLOWE), "copper".into(), U128(6), None, None));
    refuses("E_FUNDS", || w.as_yocto(ROOK).mt_transfer(acc(MARLOWE), "gold".into(), U128(1), None, None));
    refuses("E_DUPLICATE", || w.as_yocto(ROOK).mt_transfer(acc(ROOK), "copper".into(), U128(1), None, None));
    refuses("E_BAD_AMOUNT", || {
        w.as_yocto(ROOK).mt_transfer(acc(MARLOWE), "copper".into(), U128(1), Some((acc(VANE), 1)), None)
    });
    w.as_yocto(ROOK).mt_batch_transfer(
        acc(MARLOWE),
        vec!["copper".into(), "scrip".into()],
        vec![U128(2), U128(50)],
        None,
        None,
    );
    assert_eq!(
        (w.bal(rook, COPPER), w.bal(marlowe, COPPER), w.bal(rook, SCRIP), w.bal(marlowe, SCRIP)),
        (3, 2, 100, 200)
    );
    assert_eq!(
        w.c.mt_batch_balance_of(acc(MARLOWE), vec!["copper".into(), "scrip".into(), "gold".into()]),
        vec![U128(2), U128(200), U128(0)]
    );
    assert_eq!(w.c.mt_supply("copper".into()), Some(U128(15 + 15 + 5)));
    assert_eq!(w.c.mt_supply("gold".into()), None);
    assert_eq!(w.c.balances(acc(MARLOWE)).len(), 2);
    assert!(w.c.balances(acc(STRANGER)).is_empty());
    w.check();
}

#[test]
fn the_ledger_keeps_the_last_sixty_four_lines() {
    let mut w = World::new();
    let (rook, _, _) = w.crew();
    w.give(rook, COPPER, 200);
    assert!(w.c.recent(10).is_empty());
    for i in 0..70u64 {
        w.wait(1);
        w.as_(ROOK).list_item("copper".into(), U128(1), U128(10 + i as u128));
    }
    let lines = w.c.recent(100);
    assert_eq!(lines.len(), 64);
    assert_eq!(
        (lines[0].kind.as_str(), lines[0].text.as_str(), lines[0].at),
        ("listing", "ROOK listed 1 copper for 79.", w.now)
    );
    assert_eq!(lines[63].text, "ROOK listed 1 copper for 16.");
    assert_eq!((lines[0].account.as_str(), lines[0].callsign.as_deref()), (ROOK, Some("ROOK")));
    assert_eq!(w.c.recent(3).len(), 3);
    let ev = &events("saltline", "listing")[0];
    assert_eq!((ev["account"].as_str().unwrap(), ev["action"].as_str().unwrap()), (ROOK, "list"));
}

#[test]
fn the_tables_are_published_as_the_client_expects() {
    let w = World::new();
    let rules = w.c.rules();
    // Each group holds exactly the snake_case keys of the same-named constant in items.ts, as JSON numbers.
    let keys = |group: &str| rules[group].as_object().unwrap().keys().cloned().collect::<BTreeSet<String>>();
    let named = |names: &[&str]| names.iter().map(|s| s.to_string()).collect::<BTreeSet<String>>();
    assert_eq!(
        keys("raid"),
        named(&[
            "spot_count",
            "containers",
            "bonded",
            "wrecks",
            "carry_limit",
            "gun_weight",
            "slow_per_weight",
            "min_seconds",
            "per_container_seconds",
            "seconds_between_raids",
            "issued_mags",
            "max_mags",
            "max_charges",
            "max_plates",
            "plate_health",
            "max_kills",
            "max_uplinks",
            "seconds_per_kill",
            "wreck_hours",
            "impound_hours",
            "buy_back_pct",
            "starter_scrip",
        ])
    );
    assert_eq!(
        keys("invoice"),
        named(&[
            "entry",
            "per_extraction",
            "max_extractions_counted",
            "per_minute",
            "seal",
            "per_weight",
            "uplink",
            "gull",
            "hound",
            "second_notice",
            "bailiff",
            "second_bailiff",
            "foreclosure",
            "arrears_on_extract",
            "arrears_on_death",
            "carry_in_pct",
            "carry_in_max",
            "settle_rate",
            "bonded_at",
        ])
    );
    assert_eq!(
        keys("harbormaster"),
        named(&["scrip_per_strength", "half_life_hours", "strength_per_drone", "bailiff_drop_per_strength"])
    );
    assert_eq!(keys("market"), named(&["fee_pct", "maker_pct", "max_listings"]));
    assert_eq!(
        keys("condition"),
        named(&["per_raid", "recovered", "worn", "scrip_per_point", "points_per_copper", "scrap"])
    );
    assert_eq!(
        keys("vendor_pricing"),
        named(&["goods_pct", "scarce_pct", "scarce_under", "gun_pct", "float", "meds_half_life_hours"])
    );
    assert_eq!(rules.as_object().unwrap().len(), 7, "those six and the contract's own `limits`");
    assert_eq!(rules["raid"]["carry_limit"], 6);
    assert_eq!(rules["raid"]["max_kills"], near_sdk::serde_json::json!({ "gull": 30, "hound": 15 }));
    assert_eq!(rules["raid"]["max_uplinks"], 3);
    assert_eq!(rules["raid"]["starter_scrip"], 150);
    assert_eq!(rules["raid"]["slow_per_weight"], 0.06);
    assert_eq!(rules["invoice"]["bailiff"], 1_200);
    assert_eq!(rules["invoice"]["max_extractions_counted"], 14);
    assert_eq!(rules["invoice"]["arrears_on_extract"], 25);
    assert_eq!(rules["harbormaster"]["scrip_per_strength"], 20);
    assert_eq!(rules["market"]["max_listings"], 200);
    assert_eq!(rules["condition"]["scrap"], near_sdk::serde_json::json!({ "copper": 2, "chips": 1 }));
    assert_eq!(rules["vendor_pricing"]["scarce_pct"], 8);
    assert_eq!(rules["limits"]["raid_expiry_seconds"], 1_800);
    fn all_numbers(v: &near_sdk::serde_json::Value) -> bool {
        match v {
            near_sdk::serde_json::Value::Object(o) => o.values().all(all_numbers),
            other => other.is_number(),
        }
    }
    assert!(all_numbers(&rules), "every number in rules is a JSON number");
    let json = |v: &dyn Fn() -> near_sdk::serde_json::Value| v();
    let materials = json(&|| near_sdk::serde_json::to_value(w.c.materials()).unwrap());
    assert_eq!(materials.as_array().unwrap().len(), 7);
    assert_eq!(
        materials[3],
        near_sdk::serde_json::json!({ "id": "fuel", "name": "Fuel cell", "weight": 2, "bid": "80", "export": "55", "target": 8 })
    );
    let frames = json(&|| near_sdk::serde_json::to_value(w.c.frames()).unwrap());
    assert_eq!(frames[2]["bands"]["damage"], near_sdk::serde_json::json!([44, 58]));
    assert_eq!((frames[2]["id"].as_str().unwrap(), frames[2]["base"].as_str().unwrap()), ("pilot", "950"));
    let blueprints = json(&|| near_sdk::serde_json::to_value(w.c.blueprints()).unwrap());
    assert_eq!(blueprints.as_array().unwrap().len(), 10);
    assert_eq!(
        blueprints[7],
        near_sdk::serde_json::json!({ "id": "plate", "kind": "consumable", "inputs": { "copper": "1", "fuel": "1" }, "fee": "20", "yields": 3 })
    );
    assert_eq!(blueprints[8]["yields"], 6);
    assert_eq!(
        blueprints[9],
        near_sdk::serde_json::json!({ "id": "ammo", "kind": "consumable", "inputs": { "copper": "1" }, "fee": "10", "yields": 4 })
    );
    // A weapon on the wire: serial, snake_case, value as a string, optional fields as null.
    let weapon = near_sdk::serde_json::to_value(w.c.weapon("S-000001".into()).unwrap()).unwrap();
    for key in [
        "serial",
        "frame",
        "grade",
        "quality",
        "stats",
        "mods",
        "condition",
        "maker",
        "maker_callsign",
        "owner",
        "built_at",
        "raids",
        "extractions",
        "owners",
        "recovered",
        "state",
        "value",
    ] {
        assert!(!weapon[key].is_null(), "{key}");
    }
    assert!(weapon["value"].is_string() && weapon["stats"]["damage"].is_u64());
    let hm = near_sdk::serde_json::to_value(w.c.harbormaster()).unwrap();
    assert!(hm["last_memo"].is_null() && hm["balance"].is_string());
}

// -----------------------------------------------------------------------------------------------------------------
// Pause, access, and the mint rules
// -----------------------------------------------------------------------------------------------------------------

/// Who may call a method.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Who {
    /// A view: anyone, free.
    View,
    /// `new`: the contract account, once.
    Init,
    Owner,
    Faucet,
    Player,
    PlayerOrVendor,
}

/// Every public method of the contract, and who may call it. `every_public_method_is_in_the_access_table` checks
/// this list against the source.
const ACCESS: [(&str, Who); 48] = [
    ("new", Who::Init),
    ("pause", Who::Owner),
    ("unpause", Who::Owner),
    ("register", Who::Faucet),
    ("start_raid", Who::Player),
    ("extract", Who::Player),
    ("die", Who::Player),
    ("build", Who::Player),
    ("fit", Who::Player),
    ("repair", Who::Player),
    ("scrap", Who::Player),
    ("sell", Who::Player),
    ("buy", Who::Player),
    ("buy_gun", Who::Player),
    ("list_weapon", Who::Player),
    ("list_item", Who::Player),
    ("buy_listing", Who::Player),
    ("cancel_listing", Who::Player),
    ("settle", Who::Player),
    ("buy_back", Who::Player),
    ("nft_transfer", Who::Player),
    ("mt_transfer", Who::Player),
    ("mt_batch_transfer", Who::Player),
    ("export", Who::PlayerOrVendor),
    ("paused", Who::View),
    ("rules", Who::View),
    ("materials", Who::View),
    ("frames", Who::View),
    ("blueprints", Who::View),
    ("profile", Who::View),
    ("balances", Who::View),
    ("weapons", Who::View),
    ("weapon", Who::View),
    ("vendors", Who::View),
    ("export_prices", Who::View),
    ("listings", Who::View),
    ("wrecks", Who::View),
    ("impound", Who::View),
    ("harbormaster", Who::View),
    ("raid", Who::View),
    ("recent", Who::View),
    ("mt_balance_of", Who::View),
    ("mt_batch_balance_of", Who::View),
    ("mt_supply", Who::View),
    ("nft_token", Who::View),
    ("nft_total_supply", Who::View),
    ("nft_supply_for_owner", Who::View),
    ("nft_tokens_for_owner", Who::View),
];

const SOURCES: [&str; 10] = [
    include_str!("lib.rs"),
    include_str!("mt.rs"),
    include_str!("nft.rs"),
    include_str!("weapons.rs"),
    include_str!("raids.rs"),
    include_str!("harbormaster.rs"),
    include_str!("vendors.rs"),
    include_str!("export.rs"),
    include_str!("market.rs"),
    include_str!("views.rs"),
];

/// Every `pub fn` inside a `#[near] impl Saltline` block: (name, takes `&mut self` or is `new`).
fn public_methods() -> Vec<(String, bool)> {
    let mut out = Vec::new();
    for src in SOURCES {
        let lines: Vec<&str> = src.lines().collect();
        let mut exported = false;
        for (i, line) in lines.iter().enumerate() {
            if line.starts_with("impl ") {
                exported = i > 0 && lines[i - 1].trim() == "#[near]";
            }
            if let Some(rest) = line.strip_prefix("    pub fn ")
                && exported
            {
                let name = rest.split('(').next().unwrap().to_string();
                let sig: String = lines[i..(i + 3).min(lines.len())].join(" ");
                out.push((name.clone(), sig.contains("&mut self") || name == "new"));
            }
        }
    }
    out
}

/// Call `method` as `who` with arguments that would be valid for a player in good standing.
fn invoke(w: &mut World, who: &str, method: &str) {
    let gun = "S-000003".to_string();
    let c = if matches!(method, "nft_transfer" | "mt_transfer" | "mt_batch_transfer") {
        w.as_yocto(who)
    } else {
        w.as_(who)
    };
    match method {
        "new" => {
            Saltline::new(
                acc(OWNER),
                acc(FAUCET),
                acc(HM),
                VendorAccounts { moss: acc(MOSS_ACC), ines: acc(INES_ACC) },
            );
        }
        "pause" => drop(c.pause()),
        "unpause" => drop(c.unpause()),
        "register" => drop(c.register(acc("new.testnet"), "newcomer".into())),
        "start_raid" => drop(c.start_raid(Loadout::default())),
        "extract" => drop(c.extract(1, Report::default())),
        "die" => drop(c.die(1, Report::default(), 0, "machines".into())),
        "build" => drop(c.build("ammo".into())),
        "fit" => drop(c.fit(gun, "comp".into())),
        "repair" => drop(c.repair(gun, Some(1))),
        "scrap" => drop(c.scrap(gun)),
        "sell" => drop(c.sell("moss".into(), "copper".into(), U128(1))),
        "buy" => drop(c.buy("ines".into(), "ammo".into(), U128(1))),
        "buy_gun" => drop(c.buy_gun("moss".into(), "S-000001".into())),
        "list_weapon" => drop(c.list_weapon(gun, U128(10))),
        "list_item" => drop(c.list_item("copper".into(), U128(1), U128(10))),
        "buy_listing" => drop(c.buy_listing(1)),
        "cancel_listing" => drop(c.cancel_listing(1)),
        "settle" => drop(c.settle(U128(1))),
        "buy_back" => drop(c.buy_back(gun)),
        "nft_transfer" => c.nft_transfer(acc(MARLOWE), gun, None, None),
        "mt_transfer" => c.mt_transfer(acc(MARLOWE), "copper".into(), U128(1), None, None),
        "mt_batch_transfer" => c.mt_batch_transfer(acc(MARLOWE), vec!["copper".into()], vec![U128(1)], None, None),
        "export" => drop(c.export("copper".into(), U128(1))),
        "paused" => drop(c.paused()),
        "rules" => drop(c.rules()),
        "materials" => drop(c.materials()),
        "frames" => drop(c.frames()),
        "blueprints" => drop(c.blueprints()),
        "profile" => drop(c.profile(acc(ROOK))),
        "balances" => drop(c.balances(acc(ROOK))),
        "weapons" => drop(c.weapons(acc(ROOK))),
        "weapon" => drop(c.weapon(gun)),
        "vendors" => drop(c.vendors()),
        "export_prices" => drop(c.export_prices()),
        "listings" => drop(c.listings()),
        "wrecks" => drop(c.wrecks()),
        "impound" => drop(c.impound(acc(ROOK))),
        "harbormaster" => drop(c.harbormaster()),
        "raid" => drop(c.raid(1)),
        "recent" => drop(c.recent(10)),
        "mt_balance_of" => drop(c.mt_balance_of(acc(ROOK), "scrip".into())),
        "mt_batch_balance_of" => drop(c.mt_batch_balance_of(acc(ROOK), vec!["scrip".into()])),
        "mt_supply" => drop(c.mt_supply("scrip".into())),
        "nft_token" => drop(c.nft_token(gun)),
        "nft_total_supply" => drop(c.nft_total_supply()),
        "nft_supply_for_owner" => drop(c.nft_supply_for_owner(acc(ROOK))),
        "nft_tokens_for_owner" => drop(c.nft_tokens_for_owner(acc(ROOK), None, None)),
        other => panic!("no call written for {other}: add it to invoke() and ACCESS"),
    }
}

#[test]
fn every_public_method_is_in_the_access_table() {
    let in_source: BTreeSet<String> = public_methods().into_iter().map(|m| m.0).collect();
    let in_table: BTreeSet<String> = ACCESS.iter().map(|m| m.0.to_string()).collect();
    assert_eq!(in_source, in_table, "ACCESS must list exactly the methods the contract exports");
    assert_eq!(in_table.len(), ACCESS.len(), "no method twice");
    // A method is a view in the table exactly when it can't change state.
    for (name, mutates) in public_methods() {
        let who = ACCESS.iter().find(|m| m.0 == name).unwrap().1;
        assert_eq!(who != Who::View, mutates, "{name}: a view takes &self; anything else is access-controlled");
    }
    // `new` is the contract account's, once.
    let lib = SOURCES[0];
    let at = lib.find("    pub fn new(").unwrap();
    assert!(lib[..at].trim_end().ends_with("#[init]\n    #[private]"), "new must be #[init] and #[private]");
    // Nothing is exported that could mint or set a price by decree.
    for (name, _) in public_methods() {
        for word in ["mint", "admin", "set_", "grant", "airdrop", "migrate", "upgrade", "withdraw"] {
            assert!(!name.contains(word), "{name} looks like an admin method");
        }
    }
}

#[test]
fn every_public_method_checks_who_is_calling() {
    let callers = [STRANGER, OWNER, FAUCET, MOSS_ACC, INES_ACC, HM, CONTRACT, ROOK];
    for (method, who) in ACCESS {
        for caller in callers {
            // A fresh world for each pair: a refused call leaves the mocked state half-changed.
            let mut w = World::new();
            let (rook, _, _) = w.crew();
            w.build(ROOK, rook, "longshore"); // S-000003, in ROOK's hands
            w.give(rook, COPPER, 5);
            w.c.player_mut(rook).arrears = 100;
            let (code, allowed) = match who {
                Who::View => ("", true),
                Who::Init => continue,
                Who::Owner => ("E_NOT_OWNER", caller == OWNER),
                Who::Faucet => ("E_NOT_FAUCET", caller == FAUCET),
                Who::Player => ("E_NOT_REGISTERED", caller == ROOK),
                Who::PlayerOrVendor => ("E_NOT_REGISTERED", [ROOK, MOSS_ACC, INES_ACC].contains(&caller)),
            };
            let got = refusal(|| invoke(&mut w, caller, method));
            match (who, allowed, got) {
                (Who::View, _, got) => assert!(got.is_none(), "{method} as {caller} must answer: {got:?}"),
                (_, false, Some(msg)) => {
                    assert!(msg.starts_with(&format!("{code}: ")), "{method} as {caller}: expected {code}, got {msg}")
                }
                (_, false, None) => panic!("{method} as {caller} went through; expected {code}"),
                // Let in: it went through, or was refused for something other than who is calling.
                (_, true, Some(msg)) => assert!(!msg.starts_with(code), "{method} as {caller} was refused: {msg}"),
                (_, true, None) => {}
            }
        }
    }
}

#[test]
fn the_owner_can_pause_and_nothing_else() {
    let mut w = World::new();
    let (rook, _, _) = w.crew();
    w.build(ROOK, rook, "longshore");
    w.give(rook, COPPER, 5);
    refuses("E_NOT_OWNER", || w.as_(ROOK).pause());
    refuses("E_NOT_OWNER", || w.as_(FAUCET).pause());
    refuses("E_NOT_OWNER", || w.as_(CONTRACT).pause());
    w.as_(OWNER).pause();
    assert!(w.c.paused());
    // Every call that changes state is refused, whoever makes it; every view still answers.
    for (method, who) in ACCESS {
        let caller = match who {
            Who::View => STRANGER,
            Who::Init | Who::Owner => continue,
            Who::Faucet => FAUCET,
            Who::Player => ROOK,
            Who::PlayerOrVendor => MOSS_ACC,
        };
        let got = refusal(|| invoke(&mut w, caller, method));
        if who == Who::View {
            assert!(got.is_none(), "{method} must answer while paused: {got:?}");
        } else {
            assert!(got.as_deref().is_some_and(|m| m.starts_with("E_PAUSED: ")), "{method} while paused: {got:?}");
        }
    }
    refuses("E_NOT_OWNER", || w.as_(ROOK).unpause());
    w.as_(OWNER).unpause();
    w.as_(ROOK).build("ammo".into());
    w.check();
}

/// What a call may add to the supply of a token: nothing, unless a rule in CONTRACT_V2.md says so.
fn may_mint(method: &str, t: usize, n: u128) -> bool {
    match method {
        "register" => t == SCRIP && n == STARTER_SCRIP,
        "export" => t == SCRIP && n <= 100 * MAX_BATCH,
        // Cargo and parts, within the carry limit.
        "extract" | "die" => is_material(t) && n <= CARRY_LIMIT as u128,
        "scrap" => SCRAP.contains(&(t, n)),
        "build" => blueprint_for(t).is_some_and(|b| BLUEPRINTS[b].yields as u128 == n),
        _ => false,
    }
}

/// Run one call and check what it did to every supply against the rules.
fn watched<R>(
    w: &mut World,
    seen: &mut BTreeSet<&'static str>,
    method: &'static str,
    f: impl FnOnce(&mut World) -> R,
) -> R {
    let (supply, built) = (w.c.supply, w.c.guns_built);
    let out = f(w);
    for t in 0..TOKEN_COUNT {
        if w.c.supply[t] > supply[t] {
            let n = w.c.supply[t] - supply[t];
            assert!(may_mint(method, t, n), "{method} minted {n} {}", TOKENS[t].id);
        }
    }
    let guns = w.c.guns_built - built;
    assert!(guns == 0 || (method == "build" && guns == 1), "{method} made {guns} guns");
    w.check();
    seen.insert(method);
    out
}

#[test]
fn no_call_mints_scrip_materials_or_guns_outside_the_rules() {
    let mut w = World::new();
    let mut seen = BTreeSet::new();
    let s = &mut seen;
    // Genesis: 1,500 scrip a vendor, their stock, two guns. Nothing else exists.
    assert_eq!((w.c.supply[SCRIP], w.c.guns_built), (3_000, 2));
    for who in [ROOK, MARLOWE, VANE] {
        watched(&mut w, s, "register", |w| w.as_(FAUCET).register(acc(who), who[..4].to_string()));
    }
    assert_eq!(w.c.supply[SCRIP], 3_450);

    // Raids until ROOK can build a Stevedore: nothing but what the manifests hold reaches anyone.
    let mut raids = 0;
    while w.bal(0, COPPER) < 6 || w.bal(0, CHIPS) < 4 || w.bal(0, ROTOR) < 3 {
        w.wait(30);
        let r = watched(&mut w, s, "start_raid", |w| w.start(ROOK, None));
        let (spots, _, weight) = pick(&r, 4);
        let secs = MIN_SECONDS + PER_CONTAINER_SECONDS * spots.len() as u64;
        w.wait(secs);
        let rotors = (CARRY_LIMIT as u128 - weight).min(2) as u32;
        let report = Report {
            opened: spots,
            kills: Kills { gull: rotors, hound: 0 },
            parts: Parts { servo: 0, rotor: rotors },
            ..Default::default()
        };
        watched(&mut w, s, "extract", |w| w.as_(ROOK).extract(r.raid_id, report));
        raids += 1;
        assert!(raids < 60, "sixty raids should have found the parts");
    }
    watched(&mut w, s, "sell", |w| w.as_(ROOK).sell("moss".into(), "copper".into(), U128(1)));
    watched(&mut w, s, "export", |w| w.as_(ROOK).export("copper".into(), U128(1)));
    watched(&mut w, s, "export", |w| w.as_(INES_ACC).export("meds".into(), U128(2)));
    watched(&mut w, s, "buy", |w| w.as_(ROOK).buy("ines".into(), "ammo".into(), U128(2)));
    let gun = watched(&mut w, s, "build", |w| w.as_(ROOK).build("stevedore".into())).weapon.unwrap().serial;
    w.give(0, COPPER, 3); // test setup, outside `watched`
    w.give(0, ROTOR, 1);
    w.give(0, SCRIP, 400);
    watched(&mut w, s, "build", |w| w.as_(ROOK).build("comp".into()));
    watched(&mut w, s, "build", |w| w.as_(ROOK).build("ammo".into()));
    watched(&mut w, s, "fit", |w| w.as_(ROOK).fit(gun.clone(), "comp".into()));

    // The gun goes round: a raid, a wreck, a recovery, the impound, a buy-back, the market, a transfer, the scrapyard.
    w.wait(30);
    let r = watched(&mut w, s, "start_raid", |w| {
        w.as_(ROOK).start_raid(Loadout { weapon: Some(gun.clone()), plates: 0, charges: 0, mags: 2 })
    });
    let (spots, _, _) = pick(&r, 6);
    w.wait(100);
    watched(&mut w, s, "die", |w| w.as_(ROOK).die(r.raid_id, opened(spots), 2, "machines".into()));
    let r = watched(&mut w, s, "start_raid", |w| w.start(MARLOWE, None));
    w.wait(60);
    let report = Report { wrecks: vec![r.wrecks[0].id], ..Default::default() };
    watched(&mut w, s, "extract", |w| w.as_(MARLOWE).extract(r.raid_id, report));
    w.give(1, COPPER, 1);
    watched(&mut w, s, "repair", |w| w.as_(MARLOWE).repair(gun.clone(), Some(5)));
    w.wait(30);
    let r = watched(&mut w, s, "start_raid", |w| w.start(MARLOWE, Some(&gun)));
    w.wait(60);
    watched(&mut w, s, "die", |w| w.as_(MARLOWE).die(r.raid_id, Report::default(), 2, "bailiff".into()));
    w.give(1, SCRIP, 2_000);
    watched(&mut w, s, "buy_back", |w| w.as_(MARLOWE).buy_back(gun.clone()));
    watched(&mut w, s, "settle", |w| w.as_(MARLOWE).settle(U128(5)));
    let id = watched(&mut w, s, "list_weapon", |w| w.as_(MARLOWE).list_weapon(gun.clone(), U128(300))).id;
    watched(&mut w, s, "cancel_listing", |w| w.as_(MARLOWE).cancel_listing(id));
    let id = watched(&mut w, s, "list_weapon", |w| w.as_(MARLOWE).list_weapon(gun.clone(), U128(300))).id;
    w.give(2, SCRIP, 5_000);
    watched(&mut w, s, "buy_listing", |w| w.as_(VANE).buy_listing(id));
    let id = watched(&mut w, s, "list_item", |w| w.as_(ROOK).list_item("ammo".into(), U128(1), U128(20))).id;
    watched(&mut w, s, "buy_listing", |w| w.as_(VANE).buy_listing(id));
    watched(&mut w, s, "buy_gun", |w| w.as_(VANE).buy_gun("moss".into(), "S-000001".into()));
    watched(&mut w, s, "nft_transfer", |w| w.as_yocto(VANE).nft_transfer(acc(ROOK), gun.clone(), None, None));
    watched(&mut w, s, "mt_transfer", |w| {
        w.as_yocto(VANE).mt_transfer(acc(ROOK), "scrip".into(), U128(10), None, None)
    });
    watched(&mut w, s, "mt_batch_transfer", |w| {
        w.as_yocto(VANE).mt_batch_transfer(
            acc(ROOK),
            vec!["scrip".into(), "ammo".into()],
            vec![U128(10), U128(1)],
            None,
            None,
        )
    });
    watched(&mut w, s, "scrap", |w| w.as_(ROOK).scrap(gun.clone()));
    watched(&mut w, s, "pause", |w| w.as_(OWNER).pause());
    watched(&mut w, s, "unpause", |w| w.as_(OWNER).unpause());
    // Time alone mints nothing: a day and a half of expiry and decay only burns.
    let supply = w.c.supply;
    w.wait(36 * HOUR);
    watched(&mut w, s, "start_raid", |w| w.start(ROOK, None));
    watched(&mut w, s, "settle", |w| w.as_(MARLOWE).settle(U128(1)));
    assert!((0..TOKEN_COUNT).all(|t| w.c.supply[t] <= supply[t]));

    // Every method that can change state was watched at least once.
    for (method, who) in ACCESS {
        assert!(who == Who::View || who == Who::Init || seen.contains(method), "{method} was never exercised");
    }
    // And the owner, the faucet and the Harbormaster hold nothing they weren't paid by a rule.
    assert!(w.c.balances(acc(OWNER)).is_empty() && w.c.balances(acc(FAUCET)).is_empty());
    assert!(w.c.balances(acc(CONTRACT)).is_empty(), "nothing is left in escrow");
}
