//! Unit tests against the mocked blockchain (`near_sdk::test_utils`). Pricing curves and splits are tested beside
//! their rules in `pricing.rs`; these tests drive the contract's calls.

use std::panic::{AssertUnwindSafe, catch_unwind};

use near_sdk::json_types::U128;
use near_sdk::test_utils::{VMContextBuilder, get_logs};
use near_sdk::{AccountId, NearToken, env, testing_env};

use crate::items::*;
use crate::mt::total_held;
use crate::pricing;
use crate::{BrokerAccounts, Holder, Saltline};

const CONTRACT: &str = "saltline.testnet";
const OWNER: &str = "owner.testnet";
const FAUCET: &str = "faucet.saltline.testnet";
const MOSS_ACC: &str = "moss.saltline.testnet";
const INES_ACC: &str = "ines.saltline.testnet";
const QM_ACC: &str = "qm.saltline.testnet";
const START: u64 = 1_800_000_000_000; // ms

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}

fn context(who: &str, now_ms: u64, deposit: u128) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(acc(CONTRACT))
        .predecessor_account_id(acc(who))
        .signer_account_id(acc(who))
        .block_timestamp(now_ms * 1_000_000)
        .random_seed([7; 32])
        .attached_deposit(NearToken::from_yoctonear(deposit));
    testing_env!(b.build());
}

/// Assert the call is refused with `code`.
fn refuses<R>(code: &str, f: impl FnOnce() -> R) {
    let err = match catch_unwind(AssertUnwindSafe(f)) {
        Ok(_) => panic!("expected a refusal with {code}, but the call went through"),
        Err(e) => e,
    };
    let msg = err
        .downcast_ref::<String>()
        .cloned()
        .or_else(|| err.downcast_ref::<&str>().map(|s| s.to_string()))
        .unwrap_or_default();
    assert!(msg.contains(&format!("{code}:")), "expected {code}, got: {msg}");
}

struct World {
    c: Saltline,
    now: u64,
}

impl World {
    fn new() -> Self {
        context(CONTRACT, START, 0);
        let c = Saltline::new(
            acc(OWNER),
            acc(FAUCET),
            BrokerAccounts { moss: acc(MOSS_ACC), ines: acc(INES_ACC), qm: acc(QM_ACC) },
        );
        World { c, now: START }
    }
    fn as_(&mut self, who: &str) -> &mut Saltline {
        context(who, self.now, 0);
        &mut self.c
    }
    fn wait(&mut self, secs: u64) {
        self.now += secs * 1_000;
    }
    fn register(&mut self, who: &str, callsign: &str) -> u32 {
        self.as_(FAUCET).register(acc(who), callsign.to_string());
        *self.c.player_ix.get(&acc(who)).unwrap()
    }
    /// Test setup only: put tokens straight into a player's hands.
    fn give(&mut self, ix: u32, t: usize, n: u128) {
        self.c.mint(Holder::Player(ix), t, n);
    }
    fn bal(&self, ix: u32, t: usize) -> u128 {
        self.c.player(ix).bal[t]
    }
    fn check_supply(&self) {
        for t in 0..TOKEN_COUNT {
            assert_eq!(self.c.supply[t], total_held(&self.c, t), "supply of {} drifted", ITEMS[t].id);
        }
    }
}

/// Containers from a manifest that fit within the carry limit, lightest first.
fn fit(c: &[crate::runs::ContainerView]) -> (Vec<u32>, [u128; TOKEN_COUNT]) {
    let mut sorted: Vec<&crate::runs::ContainerView> = c.iter().collect();
    sorted.sort_by_key(|x| ITEMS[token_index(&x.token_id).unwrap()].weight as u128 * x.amount.0);
    let (mut spots, mut got, mut weight) = (vec![], [0u128; TOKEN_COUNT], 0u128);
    for x in sorted {
        let t = token_index(&x.token_id).unwrap();
        let w = ITEMS[t].weight as u128 * x.amount.0;
        if weight + w <= CARRY_LIMIT as u128 {
            weight += w;
            spots.push(x.spot);
            got[t] += x.amount.0;
        }
    }
    (spots, got)
}

// -----------------------------------------------------------------------------------------------------------------
// Init and registration
// -----------------------------------------------------------------------------------------------------------------

#[test]
fn init_seeds_brokers_and_logs_the_mint() {
    let w = World::new();
    let logs = get_logs();
    assert!(
        logs.iter()
            .any(|l| l.starts_with("EVENT_JSON:{\"standard\":\"nep245\",\"version\":\"1.0.0\",\"event\":\"mt_mint\""))
    );
    let moss = &w.c.brokers[MOSS];
    assert_eq!(moss.bal[SCRIP], 1_500);
    assert_eq!(moss.bal[COPPER], 9); // 75% of 12
    assert_eq!(moss.bal[CHIPS], 7); // 75% of 10, rounded down
    assert_eq!(w.c.brokers[INES].bal[FUEL], 4);
    assert_eq!(w.c.brokers[QM].bal[CORE], 3);
    assert!(w.c.brokers.iter().all(|b| b.open && b.stance == 100));
    w.check_supply();
}

#[test]
fn init_refuses_a_broker_account_used_twice() {
    context(CONTRACT, START, 0);
    refuses("E_DUPLICATE", || {
        Saltline::new(
            acc(OWNER),
            acc(FAUCET),
            BrokerAccounts { moss: acc(MOSS_ACC), ines: acc(MOSS_ACC), qm: acc(QM_ACC) },
        )
    });
}

#[test]
fn registration_is_faucet_only_once_and_checks_callsigns() {
    let mut w = World::new();
    refuses("E_NOT_FAUCET", || w.as_("pilot.testnet").register(acc("pilot.testnet"), "GULL".into()));
    let p = w.as_(FAUCET).register(acc("pilot.testnet"), "Gull-7".into());
    assert_eq!(p.callsign, "GULL-7");
    assert_eq!(p.registered_at, START);
    assert_eq!(w.c.balances(acc("pilot.testnet")).get("scrip"), Some(&U128(STARTER_SCRIP)));
    refuses("E_ALREADY_REGISTERED", || w.as_(FAUCET).register(acc("pilot.testnet"), "OTHER".into()));
    refuses("E_CALLSIGN_TAKEN", || w.as_(FAUCET).register(acc("two.testnet"), "gull-7".into()));
    refuses("E_ALREADY_REGISTERED", || w.as_(FAUCET).register(acc(MOSS_ACC), "MOSS".into()));
    refuses("E_ALREADY_REGISTERED", || w.as_(FAUCET).register(acc(CONTRACT), "HOUSE".into()));
    for bad in ["AB", "SEVENTEEN-CHARS-X", "BAD!", " LEAD", "TRAIL ", "TWO  SPACES", "ÉMILE", ""] {
        refuses("E_BAD_CALLSIGN", || w.as_(FAUCET).register(acc("two.testnet"), bad.into()));
    }
    for good in ["ABC", "SIXTEEN CHARS OK", "a.b_c-d 9"] {
        let id = format!("{}.testnet", good.len() * 7 + good.chars().filter(|c| *c == ' ').count());
        w.as_(FAUCET).register(acc(&id), good.into());
    }
    assert!(w.c.profile(acc("nobody.testnet")).is_none());
}

#[test]
fn the_dock_closes_at_500_passes() {
    let mut w = World::new();
    for i in 0..MAX_PROFILES {
        w.register(&format!("p{i}.testnet"), &format!("PILOT {i}"));
    }
    refuses("E_FULL", || w.as_(FAUCET).register(acc("late.testnet"), "LATE".into()));
}

// -----------------------------------------------------------------------------------------------------------------
// Runs
// -----------------------------------------------------------------------------------------------------------------

#[test]
fn a_full_run_and_every_refusal_on_the_way() {
    let mut w = World::new();
    let me = w.register("pilot.testnet", "GULL");
    w.register("other.testnet", "TERN");
    refuses("E_NOT_REGISTERED", || w.as_("stranger.testnet").start_run(vec![]));

    // Gear: unknown, not owned, listed twice.
    refuses("E_NO_GEAR", || w.as_("pilot.testnet").start_run(vec!["copper".into()]));
    refuses("E_NO_GEAR", || w.as_("pilot.testnet").start_run(vec!["plate".into()]));
    w.give(me, PLATE, 1);
    w.give(me, CUTTER, 1);
    refuses("E_DUPLICATE", || w.as_("pilot.testnet").start_run(vec!["plate".into(), "plate".into()]));

    let m = w.as_("pilot.testnet").start_run(vec!["plate".into(), "cutter".into()]);
    assert_eq!(w.bal(me, PLATE), 0, "gear is burned at the start");
    assert_eq!(w.bal(me, CUTTER), 0);
    assert_eq!(m.containers.len(), CONTAINERS_PER_RUN as usize);
    let mut spots: Vec<u32> = m.containers.iter().map(|c| c.spot).collect();
    spots.dedup();
    assert_eq!(spots.len(), CONTAINERS_PER_RUN as usize, "spots are distinct");
    assert!(spots.iter().all(|s| *s < SPOT_COUNT));
    assert!(m.wrecks.is_empty());
    assert_eq!(w.c.profile(acc("pilot.testnet")).unwrap().active_run, Some(m.run_id));
    assert_eq!(w.c.manifest(m.run_id).unwrap().containers.len(), 8);

    // Too soon to start another, and too soon to extract.
    refuses("E_TOO_SOON", || w.as_("pilot.testnet").start_run(vec![]));
    let (opened, got) = fit(&m.containers);
    assert!(!opened.is_empty());
    let run = m.run_id;
    refuses("E_TOO_SOON", || w.as_("pilot.testnet").extract(run, opened.clone(), vec![]));

    w.wait(MIN_RUN_SECONDS + PER_CONTAINER_SECONDS * opened.len() as u64);
    let not_there = (0..SPOT_COUNT).find(|s| !spots.contains(s)).unwrap();
    refuses("E_NOT_IN_MANIFEST", || w.as_("pilot.testnet").extract(run, vec![not_there], vec![]));
    refuses("E_NOT_IN_MANIFEST", || w.as_("pilot.testnet").extract(run, vec![], vec![99]));
    refuses("E_DUPLICATE", || w.as_("pilot.testnet").extract(run, vec![opened[0], opened[0]], vec![]));
    let everything: Vec<u32> = m.containers.iter().map(|c| c.spot).collect();
    refuses("E_OVER_LIMIT", || w.as_("pilot.testnet").extract(run, everything.clone(), vec![]));
    refuses("E_NO_RUN", || w.as_("other.testnet").extract(run, opened.clone(), vec![]));
    refuses("E_NO_RUN", || w.as_("pilot.testnet").extract(run + 50, opened.clone(), vec![]));
    // A second short of the time its containers need.
    w.now -= 1_000;
    refuses("E_TOO_SOON", || w.as_("pilot.testnet").extract(run, opened.clone(), vec![]));
    w.now += 1_000;

    let out = w.as_("pilot.testnet").extract(run, opened.clone(), vec![]);
    assert!(get_logs().iter().any(|l| l.contains("\"standard\":\"saltline\"") && l.contains("\"event\":\"extract\"")));
    assert!(get_logs().iter().any(|l| l.contains("\"event\":\"mt_mint\"") && l.contains("\"memo\":\"salvage\"")));
    for t in CARGO {
        assert_eq!(w.bal(me, t), got[t], "{}", ITEMS[t].id);
        assert_eq!(out.minted.get(ITEMS[t].id).map(|x| x.0).unwrap_or(0), got[t]);
    }
    assert!(out.haul_value.0 > 0);
    let p = w.c.profile(acc("pilot.testnet")).unwrap();
    assert_eq!((p.runs, p.extractions, p.deaths, p.best_haul, p.active_run), (1, 1, 0, out.haul_value, None));
    assert!(w.c.manifest(run).is_none(), "closed runs are deleted");
    refuses("E_RUN_CLOSED", || w.as_("pilot.testnet").extract(run, opened.clone(), vec![]));
    w.check_supply();

    // A run left open past 30 minutes has timed out.
    w.wait(RUN_GAP_SECONDS);
    let m2 = w.as_("pilot.testnet").start_run(vec![]);
    w.wait(RUN_EXPIRY_SECONDS);
    refuses("E_RUN_CLOSED", || w.as_("pilot.testnet").extract(m2.run_id, vec![], vec![]));
    assert_eq!(w.c.profile(acc("pilot.testnet")).unwrap().active_run, None);

    // Starting a new run abandons the old one.
    let m3 = w.as_("pilot.testnet").start_run(vec![]);
    w.wait(RUN_GAP_SECONDS);
    let m4 = w.as_("pilot.testnet").start_run(vec![]);
    assert!(w.c.manifest(m3.run_id).is_none());
    refuses("E_RUN_CLOSED", || w.as_("pilot.testnet").extract(m3.run_id, vec![], vec![]));
    assert_eq!(w.c.profile(acc("pilot.testnet")).unwrap().active_run, Some(m4.run_id));
}

#[test]
fn manifests_differ_between_runs_and_cores_are_rare() {
    let mut w = World::new();
    w.register("pilot.testnet", "GULL");
    let mut seen = [0u32; TOKEN_COUNT];
    let mut layouts = std::collections::BTreeSet::new();
    for _ in 0..60 {
        let m = w.as_("pilot.testnet").start_run(vec![]);
        layouts.insert(m.containers.iter().map(|c| c.spot).collect::<Vec<_>>());
        for c in &m.containers {
            seen[token_index(&c.token_id).unwrap()] += 1;
        }
        w.wait(RUN_GAP_SECONDS);
    }
    assert!(layouts.len() > 50, "manifests repeat too often");
    assert!(seen[COPPER] > seen[CORE] * 3, "core should be rare: {seen:?}");
    assert!(seen[CORE] > 0);
}

#[test]
fn death_leaves_a_wreck_and_a_finder_splits_it_70_30() {
    let mut w = World::new();
    let gull = w.register("gull.testnet", "GULL");
    let tern = w.register("tern.testnet", "TERN");
    w.register("skua.testnet", "SKUA");

    let m = w.as_("gull.testnet").start_run(vec![]);
    let (opened, carried) = fit(&m.containers);
    refuses("E_TOO_SOON", || w.as_("gull.testnet").die(m.run_id, opened.clone(), vec![], 3));
    w.wait(PER_CONTAINER_SECONDS * opened.len() as u64);
    refuses("E_BAD_AMOUNT", || w.as_("gull.testnet").die(m.run_id, opened.clone(), vec![], SPOT_COUNT));
    let died = w.as_("gull.testnet").die(m.run_id, opened.clone(), vec![], 3);
    let wreck_id = died.wreck_id.expect("cargo was carried");
    assert_eq!(w.c.profile(acc("gull.testnet")).unwrap().deaths, 1);
    let yard = w.c.wrecks();
    assert_eq!(yard.len(), 1);
    assert_eq!((yard[0].id, yard[0].spot, yard[0].callsign.as_str()), (wreck_id, 3, "GULL"));
    for t in CARGO {
        assert_eq!(w.bal(gull, t), 0, "nothing is minted on a death");
    }

    // The owner is never offered their own wreck.
    w.wait(RUN_GAP_SECONDS);
    let own = w.as_("gull.testnet").start_run(vec![]);
    assert!(own.wrecks.is_empty());

    // Tern is offered it, and it is held for Tern's run.
    let mt = w.as_("tern.testnet").start_run(vec![]);
    assert_eq!(mt.wrecks.iter().map(|x| x.id).collect::<Vec<_>>(), vec![wreck_id]);
    assert!(mt.containers.iter().all(|c| c.spot != 3), "no container is dealt onto a wreck's spot");
    let ms = w.as_("skua.testnet").start_run(vec![]);
    assert!(ms.wrecks.is_empty(), "a wreck in someone's manifest is reserved");

    w.wait(MIN_RUN_SECONDS);
    let out = w.as_("tern.testnet").extract(mt.run_id, vec![], vec![wreck_id]);
    for t in CARGO {
        let (finder, owner) = crate::runs::wreck_split(carried[t]);
        assert_eq!(w.bal(tern, t), finder, "finder's {}", ITEMS[t].id);
        assert_eq!(w.bal(gull, t), owner, "owner's {}", ITEMS[t].id);
        assert_eq!(finder + owner, carried[t]);
        assert_eq!(finder, (7 * carried[t] + 5) / 10, "the finder's 70% rounds half up");
        assert_eq!(out.minted.get(ITEMS[t].id).map(|x| x.0).unwrap_or(0), finder);
    }
    assert!(w.c.wrecks().is_empty(), "a wreck is recovered once");
    w.check_supply();
}

#[test]
fn dying_with_a_recovered_wreck_folds_it_into_the_new_one() {
    let mut w = World::new();
    w.register("gull.testnet", "GULL");
    w.register("tern.testnet", "TERN");
    let m = w.as_("gull.testnet").start_run(vec![]);
    let light = m.containers.iter().find(|c| c.token_id != "fuel").unwrap().spot;
    w.wait(PER_CONTAINER_SECONDS);
    let first = w.as_("gull.testnet").die(m.run_id, vec![light], vec![], 5).wreck_id.unwrap();
    let mt = w.as_("tern.testnet").start_run(vec![]);
    w.wait(1);
    let second = w.as_("tern.testnet").die(mt.run_id, vec![], vec![first], 9).wreck_id.unwrap();
    let yard = w.c.wrecks();
    assert_eq!(yard.len(), 1);
    assert_eq!((yard[0].id, yard[0].callsign.as_str(), yard[0].spot), (second, "TERN", 9));
}

#[test]
fn the_yard_keeps_the_newest_24_wrecks() {
    let mut w = World::new();
    for i in 0..30 {
        let id = format!("p{i}.testnet");
        w.register(&id, &format!("PILOT {i}"));
        let m = w.as_(&id).start_run(vec![]);
        let light = m.containers.iter().find(|c| c.token_id != "fuel").unwrap().spot;
        w.wait(PER_CONTAINER_SECONDS);
        w.as_(&id).die(m.run_id, vec![light], vec![], i % SPOT_COUNT);
    }
    let yard = w.c.wrecks();
    assert_eq!(yard.len(), MAX_WRECKS);
    assert_eq!(yard[0].callsign, "PILOT 29", "newest first");
    assert_eq!(yard[MAX_WRECKS - 1].callsign, "PILOT 6", "the oldest six went to the sea");
}

// -----------------------------------------------------------------------------------------------------------------
// Market
// -----------------------------------------------------------------------------------------------------------------

#[test]
fn selling_a_batch_pays_less_per_unit_as_stock_rises() {
    let mut w = World::new();
    let me = w.register("pilot.testnet", "GULL");
    w.give(me, COPPER, 6);
    let first_bid = pricing::bid_for(COPPER, 9, 100);
    let paid = w.as_("pilot.testnet").sell("moss".into(), "copper".into(), U128(6)).paid.0;
    assert_eq!(paid, pricing::sale_value(COPPER, 9, 100, 6));
    assert!(paid < 6 * first_bid);
    assert_eq!(w.bal(me, SCRIP), STARTER_SCRIP + paid);
    assert_eq!(w.c.brokers[MOSS].bal[COPPER], 15);
    let board = w.c.brokers();
    assert_eq!(board[MOSS].bids[0].token_id, "copper");
    assert_eq!(board[MOSS].bids[0].price.0, pricing::bid_for(COPPER, 15, 100));
    assert!(board[MOSS].bids[0].reason.starts_with("Sitting on 15 coils against a target of 12."));
    assert!(w.c.recent(1)[0].text.starts_with("GULL sold 6 coils to Moss for"));

    refuses("E_NOT_BROKER", || w.as_("pilot.testnet").sell("bosun".into(), "copper".into(), U128(1)));
    refuses("E_DOESNT_BUY", || w.as_("pilot.testnet").sell("moss".into(), "fuel".into(), U128(1)));
    refuses("E_DOESNT_BUY", || w.as_("pilot.testnet").sell("moss".into(), "gold".into(), U128(1)));
    refuses("E_BAD_AMOUNT", || w.as_("pilot.testnet").sell("moss".into(), "copper".into(), U128(0)));
    refuses("E_BAD_AMOUNT", || w.as_("pilot.testnet").sell("moss".into(), "copper".into(), U128(MAX_BATCH + 1)));
    refuses("E_FUNDS", || w.as_("pilot.testnet").sell("moss".into(), "copper".into(), U128(1)));
    w.check_supply();
}

#[test]
fn buying_gear_raises_the_ask_and_it_decays_back() {
    let mut w = World::new();
    let me = w.register("pilot.testnet", "GULL");
    w.give(me, SCRIP, 1_000);
    refuses("E_DOESNT_SELL", || w.as_("pilot.testnet").buy("moss".into(), "plate".into(), U128(1)));
    let cost = w.as_("pilot.testnet").buy("moss".into(), "cutter".into(), U128(3)).cost.0;
    assert_eq!(cost, 65 + 65 + 66);
    assert_eq!(w.bal(me, CUTTER), 3);
    assert_eq!(w.c.brokers[MOSS].bal[SCRIP], 1_500 + cost);
    let ask_now = w.c.brokers()[MOSS].asks[0].price.0;
    assert_eq!(ask_now, 66); // 65 × 1.03
    w.wait(6 * 3_600);
    let ask_later = w.as_("anyone.testnet").brokers()[MOSS].asks[0].price.0;
    assert_eq!(ask_later, 65); // 1.5 units left: 65 × 1.015 = 65.98 → 65
    refuses("E_FUNDS", || w.as_("pilot.testnet").buy("moss".into(), "cutter".into(), U128(100)));
    w.check_supply();
}

#[test]
fn a_broker_closes_investors_reopen_it_and_share_the_dividend() {
    let mut w = World::new();
    let gull = w.register("gull.testnet", "GULL");
    let tern = w.register("tern.testnet", "TERN");
    w.give(gull, COPPER, 300);
    w.give(gull, CHIPS, 2);

    // Too big a dump is refused whole, with how much Moss can take.
    refuses("E_BROKER_BROKE", || w.as_("gull.testnet").sell("moss".into(), "copper".into(), U128(100)));
    let can = pricing::units_covered(COPPER, 9, 100, 1_500, 100);
    assert!(can > 0 && can < 100);
    w.as_("gull.testnet").sell("moss".into(), "copper".into(), U128(can));
    let moss = &w.c.brokers[MOSS];
    assert!(!moss.open, "Moss can't cover one more coil, so she shuts");
    assert!(moss.bal[SCRIP] >= pricing::FLOAT, "never below the float");
    assert!(w.c.recent(5).iter().any(|e| e.kind == "close"));
    refuses("E_BROKER_CLOSED", || w.as_("gull.testnet").sell("moss".into(), "chips".into(), U128(1)));
    refuses("E_BROKER_CLOSED", || w.as_("gull.testnet").buy("moss".into(), "cutter".into(), U128(1)));

    // Two investors bring her back over the reopen line.
    let scrip = w.c.brokers[MOSS].bal[SCRIP];
    let first = pricing::REOPEN_LINE - scrip - 50;
    let r1 = w.as_("gull.testnet").invest("moss".into(), U128(first));
    assert!(!r1.reopened);
    assert_eq!(r1.shares.0, first);
    w.give(tern, SCRIP, 400);
    let r2 = w.as_("tern.testnet").invest("moss".into(), U128(150));
    assert!(r2.reopened);
    assert!(w.c.brokers[MOSS].open);
    assert!(w.c.recent(3).iter().any(|e| e.kind == "reopen"));
    let total = first + 150;
    assert_eq!(w.c.brokers[MOSS].total_shares, total);
    let board = w.c.brokers();
    assert_eq!(board[MOSS].shares.len(), 2);
    assert_eq!(board[MOSS].shares[0].callsign, "GULL", "largest holder first");

    // Moss ships surplus; 10% goes to her shareholders, pro rata.
    let stock = w.c.brokers[MOSS].bal[COPPER];
    let before = w.c.brokers[MOSS].bal[SCRIP];
    let ex = w.as_(MOSS_ACC).broker_export("copper".into(), U128(stock - 12), "Waste is waste.".into());
    let gross = 35 * (stock - 12);
    assert_eq!(ex.dividend.0, gross / 10);
    assert_eq!(ex.earned.0 + ex.dividend.0, gross);
    assert_eq!(w.c.brokers[MOSS].bal[SCRIP], before + ex.earned.0);
    assert_eq!(w.c.brokers[MOSS].last_memo.as_deref(), Some("Waste is waste."));

    // Dividends show in balances at once and are minted into the ledger at the holder's next call.
    let gull_due = ex.dividend.0 * first / total;
    let tern_due = ex.dividend.0 * 150 / total;
    let gull_scrip = w.bal(gull, SCRIP);
    assert_eq!(w.c.balances(acc("gull.testnet")).get("scrip").unwrap().0, gull_scrip + gull_due);
    assert_eq!(w.c.mt_balance_of(acc("tern.testnet"), "scrip".into()).0, w.bal(tern, SCRIP) + tern_due);
    w.as_("gull.testnet").sell("moss".into(), "chips".into(), U128(1));
    assert!(get_logs().iter().any(|l| l.contains("\"memo\":\"dividend\"")));
    assert_eq!(w.bal(gull, SCRIP), gull_scrip + gull_due + pricing::bid_for(CHIPS, 7, 100));
    assert!(gull_due + tern_due <= ex.dividend.0 && ex.dividend.0 - (gull_due + tern_due) < 2);
    // Paid once: a second call pays nothing more.
    let after = w.bal(gull, SCRIP);
    w.as_("gull.testnet").sell("moss".into(), "chips".into(), U128(1));
    assert_eq!(w.bal(gull, SCRIP), after + pricing::bid_for(CHIPS, 8, 100));
    // Ledger supply equals the sum of settled balances; Tern's dividend is still only accrued.
    w.check_supply();
    assert_eq!(w.c.leaderboard().investors[0].callsign, "GULL");
}

#[test]
fn a_broker_closes_below_float_plus_its_top_bid_and_can_export_its_way_back() {
    let mut w = World::new();
    let me = w.register("pilot.testnet", "GULL");
    w.give(me, COPPER, 1_000);
    // Feed Moss copper one coil at a time. Each sale is allowed while it keeps the float; she shuts as soon as
    // she couldn't pay her top bid (chips, untouched at 88) and keep it.
    let mut sales = 0;
    while w.c.brokers[MOSS].open {
        let before = w.c.brokers[MOSS].bal[SCRIP];
        assert!(before >= pricing::FLOAT + w.c.top_bid(MOSS), "open only while it covers its top bid");
        w.as_("pilot.testnet").sell("moss".into(), "copper".into(), U128(1));
        sales += 1;
    }
    let moss = &w.c.brokers[MOSS];
    assert!(moss.bal[SCRIP] >= pricing::FLOAT, "never below the float");
    assert!(moss.bal[SCRIP] < pricing::FLOAT + w.c.top_bid(MOSS));
    assert_eq!(w.c.top_bid(MOSS), pricing::bid_for(CHIPS, 7, 100), "the top bid is chips, not the flooded copper");
    assert!(
        pricing::can_cover(moss.bal[SCRIP], pricing::bid_for(COPPER, moss.bal[COPPER], 100)),
        "a coil was still affordable"
    );
    assert!(sales > 20);
    refuses("E_BROKER_CLOSED", || w.as_("pilot.testnet").sell("moss".into(), "copper".into(), U128(1)));

    // A closed broker can still ship to the freighter, and the scrip reopens it.
    let stock = w.c.brokers[MOSS].bal[COPPER];
    w.as_(MOSS_ACC).broker_export("copper".into(), U128(stock - 6), "Shut and short of float.".into());
    assert!(w.c.brokers[MOSS].bal[SCRIP] >= pricing::REOPEN_LINE);
    assert!(w.c.brokers[MOSS].open);
    let kinds: Vec<String> = w.c.recent(4).into_iter().map(|e| e.kind).collect();
    assert_eq!(&kinds[..2], &["reopen".to_string(), "export".to_string()]);
    w.check_supply();
}

#[test]
fn only_the_broker_exports_and_at_most_hourly() {
    let mut w = World::new();
    let me = w.register("pilot.testnet", "GULL");
    w.give(me, COPPER, 20);
    w.as_("pilot.testnet").sell("moss".into(), "copper".into(), U128(20));

    refuses("E_NOT_BROKER", || w.as_("pilot.testnet").broker_export("copper".into(), U128(1), "".into()));
    refuses("E_NOT_BROKER", || w.as_(FAUCET).broker_export("copper".into(), U128(1), "".into()));
    refuses("E_EXPORT_STOCK", || w.as_(INES_ACC).broker_export("copper".into(), U128(1), "".into()));
    refuses("E_EXPORT_STOCK", || w.as_(MOSS_ACC).broker_export("scrip".into(), U128(1), "".into()));
    refuses("E_EXPORT_STOCK", || w.as_(MOSS_ACC).broker_export("copper".into(), U128(30), "".into()));
    refuses("E_BAD_AMOUNT", || w.as_(MOSS_ACC).broker_export("copper".into(), U128(0), "".into()));
    refuses("E_BAD_AMOUNT", || w.as_(MOSS_ACC).broker_export("copper".into(), U128(1), "x".repeat(MAX_MEMO + 1)));

    let ex = w.as_(MOSS_ACC).broker_export("copper".into(), U128(10), "Too many coils.".into());
    assert_eq!((ex.earned.0, ex.dividend.0), (350, 0), "no shareholders, no dividend");
    assert_eq!(w.c.mt_supply("copper".into()).unwrap().0, total_held(&w.c, COPPER));
    assert!(get_logs().iter().any(|l| l.contains("\"event\":\"mt_burn\"")));
    w.wait(59 * 60);
    refuses("E_EXPORT_COOLDOWN", || w.as_(MOSS_ACC).broker_export("copper".into(), U128(1), "".into()));
    // Chips have their own clock.
    w.as_(MOSS_ACC).broker_export("chips".into(), U128(1), "".into());
    w.wait(60);
    w.as_(MOSS_ACC).broker_export("copper".into(), U128(1), "".into());

    // Stance: the broker's own lever, 80–120.
    refuses("E_NOT_BROKER", || w.as_("pilot.testnet").broker_stance(90, "".into()));
    refuses("E_STANCE_RANGE", || w.as_(MOSS_ACC).broker_stance(79, "".into()));
    refuses("E_STANCE_RANGE", || w.as_(MOSS_ACC).broker_stance(121, "".into()));
    w.as_(MOSS_ACC).broker_stance(80, "Tight week.".into());
    assert_eq!(w.c.brokers()[MOSS].stance, 80);
    assert!(w.c.brokers()[MOSS].bids[0].reason.ends_with("Tight-fisted today: stance 80."));
    w.check_supply();
}

#[test]
fn listings_escrow_buy_and_cancel() {
    let mut w = World::new();
    let gull = w.register("gull.testnet", "GULL");
    let tern = w.register("tern.testnet", "TERN");
    w.give(gull, COPPER, 5);
    w.give(gull, MAG, 1);

    refuses("E_BAD_AMOUNT", || w.as_("gull.testnet").list("scrip".into(), U128(1), U128(1)));
    refuses("E_FUNDS", || w.as_("gull.testnet").list("gold".into(), U128(1), U128(1)));
    refuses("E_BAD_AMOUNT", || w.as_("gull.testnet").list("copper".into(), U128(1), U128(0)));
    refuses("E_BAD_AMOUNT", || w.as_("gull.testnet").list("copper".into(), U128(1), U128(MAX_LISTING_PRICE + 1)));
    refuses("E_FUNDS", || w.as_("gull.testnet").list("copper".into(), U128(6), U128(10)));

    let id = w.as_("gull.testnet").list("copper".into(), U128(3), U128(70)).id;
    assert_eq!(w.bal(gull, COPPER), 2);
    assert_eq!(w.c.mt_balance_of(acc(CONTRACT), "copper".into()).0, 3, "held in escrow by the contract");
    let board = w.c.listings();
    assert_eq!((board[0].id, board[0].callsign.as_str(), board[0].amount.0, board[0].price.0), (id, "GULL", 3, 70));

    refuses("E_NO_LISTING", || w.as_("gull.testnet").buy_listing(id));
    refuses("E_FUNDS", || w.as_("tern.testnet").buy_listing(id));
    w.give(tern, SCRIP, 100);
    let paid = w.as_("tern.testnet").buy_listing(id).paid.0;
    assert_eq!(paid, 210);
    assert_eq!(w.bal(tern, COPPER), 3);
    assert_eq!(w.bal(tern, SCRIP), 250 - 210);
    assert_eq!(w.bal(gull, SCRIP), STARTER_SCRIP + 210);
    assert!(w.c.listings().is_empty());
    refuses("E_NO_LISTING", || w.as_("tern.testnet").buy_listing(id));

    let id2 = w.as_("gull.testnet").list("mag".into(), U128(1), U128(40)).id;
    refuses("E_NO_LISTING", || w.as_("tern.testnet").cancel_listing(id2));
    w.as_("gull.testnet").cancel_listing(id2);
    assert_eq!(w.bal(gull, MAG), 1);
    assert_eq!(w.c.pool, [0; TOKEN_COUNT]);
    refuses("E_NO_LISTING", || w.as_("gull.testnet").cancel_listing(id2));
    w.check_supply();

    // The board holds 100 listings.
    w.give(gull, COPPER, MAX_LISTINGS as u128);
    for _ in 0..MAX_LISTINGS {
        w.as_("gull.testnet").list("copper".into(), U128(1), U128(50));
    }
    refuses("E_FULL", || w.as_("gull.testnet").list("copper".into(), U128(1), U128(50)));
}

// -----------------------------------------------------------------------------------------------------------------
// NEP-245, the ledger ring and the leaderboard
// -----------------------------------------------------------------------------------------------------------------

#[test]
fn nep245_transfers_between_players() {
    let mut w = World::new();
    let gull = w.register("gull.testnet", "GULL");
    let tern = w.register("tern.testnet", "TERN");
    w.give(gull, CORE, 2);
    context("gull.testnet", w.now, 0);
    refuses("E_BAD_AMOUNT", || w.c.mt_transfer(acc("tern.testnet"), "core".into(), U128(1), None, None));
    context("gull.testnet", w.now, 1);
    refuses("E_NOT_REGISTERED", || w.c.mt_transfer(acc("nobody.testnet"), "core".into(), U128(1), None, None));
    refuses("E_NOT_REGISTERED", || w.c.mt_transfer(acc(MOSS_ACC), "core".into(), U128(1), None, None));
    refuses("E_FUNDS", || w.c.mt_transfer(acc("tern.testnet"), "core".into(), U128(3), None, None));
    refuses("E_FUNDS", || w.c.mt_transfer(acc("tern.testnet"), "gold".into(), U128(1), None, None));
    refuses("E_DUPLICATE", || w.c.mt_transfer(acc("gull.testnet"), "core".into(), U128(1), None, None));
    refuses("E_BAD_AMOUNT", || {
        w.c.mt_transfer(acc("tern.testnet"), "core".into(), U128(1), Some((acc("x.testnet"), 1)), None)
    });
    context("gull.testnet", w.now, 1);
    w.c.mt_transfer(acc("tern.testnet"), "core".into(), U128(1), None, Some("for the run".into()));
    let log = get_logs().into_iter().find(|l| l.contains("mt_transfer")).unwrap();
    assert_eq!(
        log,
        "EVENT_JSON:{\"standard\":\"nep245\",\"version\":\"1.0.0\",\"event\":\"mt_transfer\",\"data\":[{\"old_owner_id\":\"gull.testnet\",\"new_owner_id\":\"tern.testnet\",\"token_ids\":[\"core\"],\"amounts\":[\"1\"],\"memo\":\"for the run\"}]}"
    );
    context("gull.testnet", w.now, 1);
    w.c.mt_batch_transfer(
        acc("tern.testnet"),
        vec!["core".into(), "scrip".into()],
        vec![U128(1), U128(50)],
        None,
        None,
    );
    assert_eq!((w.bal(gull, CORE), w.bal(tern, CORE)), (0, 2));
    assert_eq!(
        w.c.mt_batch_balance_of(acc("tern.testnet"), vec!["core".into(), "scrip".into(), "gold".into()]),
        vec![U128(2), U128(200), U128(0)]
    );
    assert_eq!(w.c.mt_supply("gold".into()), None);
    w.check_supply();
}

#[test]
fn the_ticker_keeps_the_last_64_events() {
    let mut w = World::new();
    for i in 0..70u32 {
        w.as_(MOSS_ACC).broker_stance(80 + i % 40, format!("note {i}"));
    }
    let all = w.c.recent(1_000);
    assert_eq!(all.len(), RECENT_KEPT as usize);
    assert_eq!(all[0].text, "Moss set stance 109. note 69");
    assert_eq!(all[63].text, "Moss set stance 86. note 6");
    assert_eq!(w.c.recent(3).len(), 3);
    assert_eq!(w.c.recent(0).len(), 0);
}

#[test]
fn the_leaderboard_ranks_the_top_ten() {
    let mut w = World::new();
    for i in 0..12u32 {
        let ix = w.register(&format!("p{i}.testnet"), &format!("PILOT {i}"));
        w.give(ix, SCRIP, i as u128 * 10);
        w.give(ix, CORE, if i == 3 { 5 } else { 0 });
    }
    let board = w.c.leaderboard();
    assert_eq!(board.net_worth.len(), LEADERBOARD_ROWS);
    assert_eq!(board.net_worth[0].callsign, "PILOT 3", "five cores at the Quartermaster's bid");
    assert_eq!(board.net_worth[1].callsign, "PILOT 11");
    assert!(board.net_worth.windows(2).all(|r| r[0].value.0 >= r[1].value.0));
    assert!(board.best_haul.is_empty() && board.investors.is_empty());
}

// -----------------------------------------------------------------------------------------------------------------
// Advice and simulate
// -----------------------------------------------------------------------------------------------------------------

#[test]
fn advice_follows_the_default_policy() {
    let mut w = World::new();
    let a = w.as_("anyone.testnet").advice("moss".into());
    assert_eq!((a.action.as_str(), a.token_id, a.amount, a.stance), ("none", None, None, None));
    let me = w.register("pilot.testnet", "GULL");
    w.give(me, COPPER, 20);
    w.as_("pilot.testnet").sell("moss".into(), "copper".into(), U128(20));
    let a = w.c.advice("moss".into());
    assert_eq!((a.action.as_str(), a.token_id.as_deref(), a.amount), ("export", Some("copper"), Some(U128(17))));
    assert!(a.memo.contains("Waste is waste."));
    refuses("E_NOT_BROKER", || w.c.advice("bosun".into()));
}

fn sim_json(c: &Saltline, hours: u32, traders: u32, seed: u64) -> String {
    near_sdk::serde_json::to_string(&c.simulate(hours, traders, seed)).unwrap()
}

#[test]
fn simulate_is_deterministic_for_a_seed() {
    let mut w = World::new();
    w.as_("anyone.testnet");
    let a = sim_json(&w.c, 48, 10, 42);
    let b = sim_json(&w.c, 48, 10, 42);
    assert_eq!(a, b);
    assert_ne!(a, sim_json(&w.c, 48, 10, 43));
    assert_eq!(w.c.simulate(5, 0, 1).len(), 6, "hour 0 plus one point per hour");
    refuses("E_BAD_AMOUNT", || w.c.simulate(0, 1, 1));
    refuses("E_BAD_AMOUNT", || w.c.simulate(169, 1, 1));
    refuses("E_BAD_AMOUNT", || w.c.simulate(1, 31, 1));
}

#[test]
fn a_simulated_week_moves_prices_and_a_broker_closes_and_reopens() {
    let mut w = World::new();
    w.as_("anyone.testnet");
    let week = w.c.simulate(168, 30, 7);
    assert_eq!(week.len(), 169);
    let brokers = |p: &crate::sim::SimPoint| {
        [&p.brokers.moss, &p.brokers.ines, &p.brokers.qm].map(|b| (b.open, b.bids.clone(), b.scrip.0))
    };
    let start = brokers(&week[0]);
    assert!(week.iter().any(|p| brokers(p).iter().zip(start.iter()).any(|(a, b)| a.1 != b.1)), "bids move");
    let mut closed_then_reopened = false;
    for b in 0..BROKER_COUNT {
        let opens: Vec<bool> = week.iter().map(|p| brokers(p)[b].0).collect();
        if let Some(shut) = opens.iter().position(|o| !o) {
            closed_then_reopened |= opens[shut..].iter().any(|o| *o);
        }
    }
    assert!(closed_then_reopened, "under 30 traders a broker should close and be reopened within the week");
    // Every point keeps the float.
    assert!(week.iter().all(|p| brokers(p).iter().all(|b| b.2 >= pricing::FLOAT)));
}

// -----------------------------------------------------------------------------------------------------------------
// Storage per player (the contract pays for it)
// -----------------------------------------------------------------------------------------------------------------

fn persist(c: &mut Saltline) {
    c.players.flush();
    c.player_ix.flush();
    c.callsigns.flush();
    c.runs.flush();
    c.recent.flush();
    c.listings.flush();
    env::state_write(c);
}

#[test]
fn storage_per_player_is_measured() {
    let mut w = World::new();
    // Fill the ticker ring first: once it holds 64 events, new ones overwrite old ones and add no keys.
    for i in 0..RECENT_KEPT {
        w.as_(MOSS_ACC).broker_stance(100, format!("{i}"));
    }
    // An implicit account (64 hex characters, what a guest wallet makes) with the longest callsign.
    let implicit = "a".repeat(64);
    // testing_env! restarts the storage counter, so each measurement stays inside one context.
    context(FAUCET, w.now, 0);
    persist(&mut w.c);
    let before = env::storage_usage();
    w.c.register(acc(&implicit), "SIXTEEN CHARS OK".into());
    persist(&mut w.c);
    let profile = env::storage_usage() - before;

    context(&implicit, w.now, 0);
    persist(&mut w.c);
    let before = env::storage_usage();
    w.c.start_run(vec![]);
    persist(&mut w.c);
    let run = env::storage_usage() as i64 - before as i64;
    println!("storage: profile {profile} bytes, open run {run} bytes");
    assert!(profile < 800, "{profile}");
    assert!(run < 300, "{run}");
}

#[test]
#[ignore = "prints a week for reading: cargo test print_a_simulated_week -- --ignored --nocapture"]
fn print_a_simulated_week() {
    let mut w = World::new();
    w.as_("anyone.testnet");
    let week = w.c.simulate(168, 30, 7);
    for p in week.iter().step_by(6) {
        let f = |b: &crate::sim::SimBroker| {
            format!(
                "{}{:>6} {:?} {:?}",
                if b.open { "O" } else { "x" },
                b.scrip.0,
                b.bids.values().map(|v| v.0).collect::<Vec<_>>(),
                b.stock.values().map(|v| v.0).collect::<Vec<_>>()
            )
        };
        println!("h{:>3} moss {} | ines {} | qm {}", p.hour, f(&p.brokers.moss), f(&p.brokers.ines), f(&p.brokers.qm));
    }
}
