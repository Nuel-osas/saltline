//! The upgrade, rehearsed on a local sandbox before it touches v2.saltline.testnet: the new wasm deployed over the
//! old code's state with NO init call.
//!
//! - `the_new_code_reads_the_old_state`: deploy the old code (`res/live.wasm` if ./fetch-live.sh fetched it,
//!   otherwise `res/stage1.wasm`) and call `new`; make state with it (five players with arrears, a gun in every
//!   state: held, listed, in a wreck, impounded, out on an open raid, on a vendor's rack; an item listing, a
//!   settlement, an export); deploy the new release wasm over it; then check that every view the old code had
//!   reads back exactly as before, and that the new calls and the open raid work on the old state.
//! - `upgrade_over_a_copy_of_the_live_state`: import v2.saltline.testnet's code and its whole state into the
//!   sandbox, deploy the new wasm over it, and check every view, for every account and gun found, reads back
//!   exactly as before. Needs ./fetch-live.sh to have run, and the network.
//!
//! Two things are meant to differ, and are checked on their own: `rules` (constants in the code: only the six
//! invoice rates may move), and a token's `metadata.media` (the drawing, new with this code).
//!
//! Run from contract2/sandbox, after building the new wasm (contract2/upgrade.sh does all of this):
//!   (cd .. && cargo near build non-reproducible-wasm) && ./fetch-live.sh
//!   cargo test --test upgrade -- --nocapture --test-threads=1
//!
//! When the first test passes it writes `res/upgrade-passed` with the code hash it upgraded from and the one it
//! upgraded to. contract2/upgrade.sh deploys only a wasm with that hash, over live code with that hash.

use std::collections::BTreeSet;

use near_workspaces::types::{Gas, NearToken};
use near_workspaces::{network::Sandbox, Account, AccountId, Contract, ContractState, Worker};
use serde_json::{json, Value};

const RES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/res");
const NEW_WASM: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../target/near/saltline2.wasm");
const TOKENS: [&str; 15] = [
    "scrip", "copper", "chips", "fuel", "meds", "core", "servo", "rotor", "mag2", "barrel2", "comp", "optic", "plate",
    "charge", "ammo",
];
const MATERIALS: [&str; 7] = ["copper", "chips", "fuel", "meds", "core", "servo", "rotor"];
/// The only numbers in `rules` this upgrade may change, and what they become.
const NEW_RATES: [(&str, u64); 6] =
    [("per_minute", 40), ("seal", 60), ("per_weight", 30), ("uplink", 50), ("gull", 15), ("hound", 35)];

fn weight(token: &str) -> u64 {
    if token == "fuel" {
        2
    } else {
        1
    }
}

/// The old code and a name for it, and the new release wasm.
fn wasms() -> anyhow::Result<(Vec<u8>, &'static str, Vec<u8>)> {
    let (old, name) = match std::fs::read(format!("{RES}/live.wasm")) {
        Ok(live) => (live, "the code live on testnet (res/live.wasm)"),
        Err(_) => (
            std::fs::read(format!("{RES}/stage1.wasm"))
                .map_err(|e| anyhow::anyhow!("no old code to upgrade from: run ./fetch-live.sh ({e})"))?,
            "the stage 1 build (res/stage1.wasm)",
        ),
    };
    let new = std::fs::read(NEW_WASM)
        .map_err(|e| anyhow::anyhow!("build the new wasm first (cargo near build non-reproducible-wasm): {e}"))?;
    assert_ne!(old, new, "the new wasm is the old one: nothing to upgrade");
    Ok((old, name, new))
}

async fn code_hash(contract: &Contract) -> anyhow::Result<String> {
    match contract.view_account().await?.contract_state {
        ContractState::LocalHash(h) => Ok(h.to_string()),
        other => anyhow::bail!("{} has no local code: {other:?}", contract.id()),
    }
}

async fn sub(parent: &Account, name: &str, near: u128) -> anyhow::Result<Account> {
    Ok(parent.create_subaccount(name).initial_balance(NearToken::from_near(near)).transact().await?.into_result()?)
}

async fn now_ms(worker: &Worker<Sandbox>) -> anyhow::Result<u64> {
    Ok(worker.view_block().await?.timestamp() / 1_000_000)
}

/// Produce blocks until the chain's clock reaches `until_ms`.
async fn wait_until(worker: &Worker<Sandbox>, until_ms: u64) -> anyhow::Result<()> {
    while now_ms(worker).await? < until_ms {
        worker.fast_forward(20).await?;
    }
    Ok(())
}

/// Call `method` as `signer`; returns the result and the block time (ms) its receipt ran at.
async fn call_at(
    worker: &Worker<Sandbox>,
    contract: &Contract,
    signer: &Account,
    method: &str,
    args: Value,
) -> anyhow::Result<(Value, u64)> {
    let out = signer.call(contract.id(), method).args_json(args).gas(Gas::from_tgas(100)).transact().await?;
    let block = out.receipt_outcomes().first().map(|o| o.block_hash);
    let ok = out.into_result().map_err(|e| anyhow::anyhow!("{method} as {} failed: {e:?}", signer.id()))?;
    let at = match block {
        Some(hash) => worker.view_block().block_hash(hash).await?.timestamp() / 1_000_000,
        None => 0,
    };
    Ok((ok.json().unwrap_or(Value::Null), at))
}

async fn call(contract: &Contract, signer: &Account, method: &str, args: Value) -> anyhow::Result<Value> {
    let out = signer.call(contract.id(), method).args_json(args).gas(Gas::from_tgas(100)).transact().await?;
    let ok = out.into_result().map_err(|e| anyhow::anyhow!("{method} as {} failed: {e:?}", signer.id()))?;
    Ok(ok.json().unwrap_or(Value::Null))
}

async fn view(contract: &Contract, method: &str, args: Value) -> anyhow::Result<Value> {
    Ok(contract.view(method).args_json(args).await.map_err(|e| anyhow::anyhow!("view {method}: {e}"))?.json()?)
}

fn amount(v: &Value) -> u128 {
    v.as_str().and_then(|s| s.parse().ok()).unwrap_or_else(|| panic!("not a U128 string: {v}"))
}

fn bal(balances: &Value, token: &str) -> u128 {
    balances.get(token).map(amount).unwrap_or(0)
}

fn report(opened: &[u64], wrecks: &[u64], rotors: u64) -> Value {
    json!({
        "opened": opened, "wrecks": wrecks,
        "parts": { "servo": 0, "rotor": rotors }, "kills": { "gull": rotors, "hound": 0 },
        "uplinks": 0, "used": { "plates": 0, "charges": 0, "mags": 0 }
    })
}

fn loadout(weapon: Option<&str>) -> Value {
    json!({ "loadout": { "weapon": weapon, "plates": 0, "charges": 0, "mags": 0 } })
}

/// Containers from a manifest that fit within `limit` weight, lightest first: (spots, weight).
fn pick(raid: &Value, limit: u64) -> (Vec<u64>, u64) {
    let mut c: Vec<(u64, u64)> = raid["containers"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| (c["spot"].as_u64().unwrap(), weight(c["token_id"].as_str().unwrap()) * amount(&c["amount"]) as u64))
        .collect();
    c.sort_by_key(|x| x.1);
    let (mut spots, mut load) = (vec![], 0);
    for (spot, w) in c {
        if load + w <= limit {
            load += w;
            spots.push(spot);
        }
    }
    (spots, load)
}

/// Drop every token's `media`: the drawing is new with this code, and checked on its own.
fn without_media(mut v: Value) -> Value {
    fn strip(v: &mut Value) {
        match v {
            Value::Object(o) => {
                if let Some(Value::Object(meta)) = o.get_mut("metadata") {
                    meta.insert("media".into(), Value::Null);
                }
                o.values_mut().for_each(strip);
            }
            Value::Array(a) => a.iter_mut().for_each(strip),
            _ => {}
        }
    }
    strip(&mut v);
    v
}

/// Every view the old code had (bar `rules`), for these accounts, guns and raids. A view that fails fails the test.
async fn snapshot(
    contract: &Contract,
    accounts: &BTreeSet<String>,
    serials: &[String],
    raids: &[u64],
) -> anyhow::Result<Vec<(String, Value)>> {
    let mut out = Vec::new();
    for method in [
        "materials",
        "frames",
        "blueprints",
        "vendors",
        "export_prices",
        "listings",
        "wrecks",
        "harbormaster",
        "paused",
        "nft_total_supply",
    ] {
        out.push((method.to_string(), view(contract, method, json!({})).await?));
    }
    out.push(("recent(64)".into(), view(contract, "recent", json!({ "limit": 64 })).await?));
    for t in TOKENS {
        out.push((format!("mt_supply({t})"), view(contract, "mt_supply", json!({ "token_id": t })).await?));
    }
    for a in accounts {
        for method in ["profile", "balances", "weapons", "impound", "nft_supply_for_owner"] {
            out.push((format!("{method}({a})"), view(contract, method, json!({ "account_id": a })).await?));
        }
        let owned = view(contract, "nft_tokens_for_owner", json!({ "account_id": a })).await?;
        out.push((format!("nft_tokens_for_owner({a})"), without_media(owned)));
        let batch = view(contract, "mt_batch_balance_of", json!({ "account_id": a, "token_ids": TOKENS })).await?;
        out.push((format!("mt_batch_balance_of({a})"), batch));
    }
    for s in serials {
        out.push((format!("weapon({s})"), view(contract, "weapon", json!({ "serial": s })).await?));
        let token = view(contract, "nft_token", json!({ "token_id": s })).await?;
        out.push((format!("nft_token({s})"), without_media(token)));
    }
    for id in raids {
        out.push((format!("raid({id})"), view(contract, "raid", json!({ "raid_id": id })).await?));
    }
    Ok(out)
}

fn assert_same(before: &[(String, Value)], after: &[(String, Value)]) {
    assert_eq!(before.len(), after.len());
    for ((name, b), (name_after, a)) in before.iter().zip(after) {
        assert_eq!(name, name_after);
        assert_eq!(b, a, "{name} changed across the upgrade");
    }
}

/// `rules` may differ only in the invoice's six rates, and those must be the new ones afterwards.
fn check_rules(before: &Value, after: &Value) {
    for (group, values) in after.as_object().unwrap() {
        for (key, value) in values.as_object().unwrap() {
            let moved = NEW_RATES.iter().any(|r| group == "invoice" && r.0 == key);
            if !moved {
                assert_eq!(&before[group][key], value, "rules.{group}.{key} changed across the upgrade");
            }
        }
    }
    assert_eq!(before.as_object().unwrap().len(), after.as_object().unwrap().len(), "rules lost or gained a group");
    for (key, rate) in NEW_RATES {
        assert_eq!(after["invoice"][key], rate, "rules.invoice.{key}");
    }
}

/// A material the account holds that it could part with.
async fn spare(contract: &Contract, who: &Account) -> anyhow::Result<Option<String>> {
    let b = view(contract, "balances", json!({ "account_id": who.id() })).await?;
    Ok(MATERIALS.iter().find(|m| bal(&b, m) > 0).map(|m| m.to_string()))
}

#[tokio::test]
async fn the_new_code_reads_the_old_state() -> anyhow::Result<()> {
    let (old, old_name, new) = wasms()?;
    let worker = near_workspaces::sandbox().await?;
    let root = worker.root_account()?;
    let house = sub(&root, "v2", 60).await?;
    let faucet = sub(&house, "faucet", 5).await?;
    let hm = sub(&house, "harbormaster", 2).await?;
    let moss = sub(&house, "moss", 2).await?;
    let ines = sub(&house, "ines", 2).await?;
    let mut crew = Vec::new();
    for name in ["rook", "marlowe", "vane", "dora", "ash"] {
        crew.push(sub(&house, name, 3).await?);
    }
    let (rook, marlowe, vane, dora, ash) = (&crew[0], &crew[1], &crew[2], &crew[3], &crew[4]);

    // ---- the old code makes the state ----
    let contract = house.deploy(&old).await?.into_result()?;
    let old_hash = code_hash(&contract).await?;
    if let Ok(live) = std::fs::read_to_string(format!("{RES}/live.code_hash")) {
        if old_name.contains("live") {
            assert_eq!(old_hash, live.trim(), "res/live.wasm doesn't hash to res/live.code_hash");
        }
    }
    println!("upgrading from {old_name}, {} bytes, code hash {old_hash}", old.len());
    call(
        &contract,
        contract.as_account(),
        "new",
        json!({
            "owner_id": house.id(), "faucet_id": faucet.id(), "harbormaster_id": hm.id(),
            "vendors": { "moss": moss.id(), "ines": ines.id() }
        }),
    )
    .await?;
    for p in &crew {
        let callsign = p.id().as_str().split('.').next().unwrap();
        call(&contract, &faucet, "register", json!({ "account_id": p.id(), "callsign": callsign })).await?;
    }

    // Raids, a round at a time for everyone still short of a Stevedore's parts (4 copper, 3 electronics, 3 rotors).
    let mut rounds = 0;
    loop {
        let mut short = Vec::new();
        for p in &crew {
            let b = view(&contract, "balances", json!({ "account_id": p.id() })).await?;
            if bal(&b, "copper") < 4 || bal(&b, "chips") < 3 || bal(&b, "rotor") < 3 {
                short.push(p);
            }
        }
        if short.is_empty() {
            break;
        }
        rounds += 1;
        assert!(rounds <= 30, "thirty rounds should have found the parts");
        let (mut open, mut latest) = (Vec::new(), 0);
        for p in short {
            let raid = call(&contract, p, "start_raid", loadout(None)).await?;
            let (spots, load) = pick(&raid, 4);
            let until = raid["started_at"].as_u64().unwrap() + (45 + 8 * spots.len() as u64) * 1_000 + 1_000;
            latest = latest.max(until);
            open.push((p, raid["raid_id"].clone(), spots, (6 - load).min(2)));
        }
        wait_until(&worker, latest).await?;
        for (p, raid_id, spots, rotors) in open {
            call(&contract, p, "extract", json!({ "raid_id": raid_id, "report": report(&spots, &[], rotors) })).await?;
        }
    }
    println!("{rounds} rounds of raids on the old code");

    // A gun each, then one in every state.
    let mut serials = vec!["S-000001".to_string(), "S-000002".to_string()];
    for p in &crew {
        let built = call(&contract, p, "build", json!({ "blueprint": "stevedore" })).await?;
        serials.push(built["weapon"]["serial"].as_str().unwrap().to_string());
    }
    let gun = |i: usize| serials[2 + i].clone();
    // ROOK: held. ROOK also pays some arrears and ships a unit, so the two decaying books are in use.
    call(&contract, rook, "settle", json!({ "amount": "10" })).await?;
    if let Some(t) = spare(&contract, rook).await? {
        call(&contract, rook, "export", json!({ "token_id": t, "amount": "1" })).await?;
    }
    // MARLOWE: listed, and an item listing beside it.
    let listing = call(&contract, marlowe, "list_weapon", json!({ "serial": gun(1), "price": "50" })).await?;
    if let Some(t) = spare(&contract, marlowe).await? {
        call(&contract, marlowe, "list_item", json!({ "token_id": t, "amount": "1", "price": "30" })).await?;
    }
    // VANE: dead to the machines, the gun in a wreck. DORA: taken by the Bailiff, the gun impounded.
    let raid = call(&contract, vane, "start_raid", loadout(Some(&gun(2)))).await?;
    let died = json!({ "raid_id": raid["raid_id"], "report": report(&[], &[], 0), "spot": 5, "by": "machines" });
    let wreck = call(&contract, vane, "die", died).await?["wreck_id"].as_u64().unwrap();
    let raid = call(&contract, dora, "start_raid", loadout(Some(&gun(3)))).await?;
    let died = json!({ "raid_id": raid["raid_id"], "report": report(&[], &[], 0), "spot": 9, "by": "bailiff" });
    assert_eq!(call(&contract, dora, "die", died).await?["impounded"], true);
    // ASH: out on a raid with the gun when the upgrade lands, VANE's wreck in the manifest.
    let open = call(&contract, ash, "start_raid", loadout(Some(&gun(4)))).await?;
    let open_id = open["raid_id"].as_u64().unwrap();
    assert_eq!(open["wrecks"][0]["id"].as_u64(), Some(wreck));
    worker.fast_forward(3).await?;

    let states: Vec<String> = {
        let mut s = Vec::new();
        for serial in &serials {
            let w = view(&contract, "weapon", json!({ "serial": serial })).await?;
            s.push(w["state"].as_str().unwrap().to_string());
        }
        s
    };
    assert_eq!(states, ["vendor", "vendor", "held", "listed", "wreck", "impound", "raid"], "a gun in every state");
    for p in &crew {
        let profile = view(&contract, "profile", json!({ "account_id": p.id() })).await?;
        assert!(amount(&profile["arrears"]) > 0, "{} owes the Harbormaster", p.id());
    }

    let mut accounts: BTreeSet<String> = crew.iter().map(|p| p.id().to_string()).collect();
    for a in [&house, &faucet, &hm, &moss, &ines] {
        accounts.insert(a.id().to_string());
    }
    let rules_before = view(&contract, "rules", json!({})).await?;
    let before = snapshot(&contract, &accounts, &serials, &[open_id]).await?;
    let storage_before = contract.view_account().await?.storage_usage;
    let mut lacking = Vec::new();
    for new_method in ["economy", "leaderboard", "nft_metadata", "nft_tokens"] {
        if view(&contract, new_method, json!({})).await.is_err() {
            lacking.push(new_method);
        }
    }
    println!("views the old code doesn't have: {lacking:?}");

    // ---- the upgrade: new code, no init call ----
    house.deploy(&new).await?.into_result()?;
    let new_hash = code_hash(&contract).await?;
    assert_ne!(new_hash, old_hash);
    let after = snapshot(&contract, &accounts, &serials, &[open_id]).await?;
    assert_same(&before, &after);
    check_rules(&rules_before, &view(&contract, "rules", json!({})).await?);
    println!("{} views read back the same over the new code", after.len());

    // ---- the new views, over state the old code wrote ----
    let economy = view(&contract, "economy", json!({})).await?;
    assert_eq!((economy["players"].as_u64(), economy["weapons_built"].as_u64()), (Some(5), Some(7)));
    assert_eq!((economy["weapons_alive"].as_u64(), economy["weapons_destroyed"].as_u64()), (Some(7), Some(0)));
    assert_eq!(economy["scrip_supply"], view(&contract, "mt_supply", json!({ "token_id": "scrip" })).await?);
    assert!(amount(&economy["minted_24h"]) >= 3_000 + 5 * 150, "the old code's mints are in the day's total");
    assert!(amount(&economy["burned_24h"]) >= 5 * 90, "and its build fees");
    assert!(economy["last_sales"].as_array().unwrap().is_empty());
    let board = view(&contract, "leaderboard", json!({})).await?;
    assert_eq!((board["scanned"].as_u64(), board["players"].as_u64()), (Some(5), Some(5)));
    assert_eq!(board["net_worth"].as_array().unwrap().len(), 5);
    assert_eq!(board["net_worth"][0]["account_id"], rook.id().as_str(), "ROOK has the one gun in hand");
    assert_eq!(board["extractions"].as_array().unwrap().len(), 5);
    assert!(board["makers"].as_array().unwrap().is_empty());
    assert_eq!(view(&contract, "nft_metadata", json!({})).await?["spec"], "nft-1.0.0");
    let tokens = view(&contract, "nft_tokens", json!({})).await?;
    assert_eq!(tokens.as_array().unwrap().len(), 7);
    for t in tokens.as_array().unwrap() {
        let media = t["metadata"]["media"].as_str().unwrap();
        assert!(media.starts_with("data:image/svg+xml;base64,") && media.len() <= 1_500, "{media}");
    }
    let payout =
        view(&contract, "nft_payout", json!({ "token_id": gun(0), "balance": "1000", "max_len_payout": 5 })).await?;
    assert_eq!(payout["payout"][rook.id().as_str()], "1000", "ROOK made it and owns it");

    // ---- the open raid ends on the new code, at the new rates, and brings VANE's gun out ----
    let started = open["started_at"].as_u64().unwrap();
    wait_until(&worker, started + 46_000).await?;
    let args = json!({ "raid_id": open_id, "report": report(&[], &[wreck], 0) });
    let (out, at) = call_at(&worker, &contract, ash, "extract", args).await?;
    let seconds = ((at - started) / 1_000) as u128;
    assert_eq!(
        amount(&out["invoice"]),
        amount(&open["invoice_start"]) + seconds * 40 / 60 + 2 * 30,
        "{seconds} s, a gun carried"
    );
    assert_eq!((out["weapon"]["state"].as_str(), out["weapon"]["raids"].as_u64()), (Some("held"), Some(1)));
    let got = &out["recovered"][0];
    assert_eq!((got["serial"].as_str(), got["owner"].as_str()), (Some(gun(2).as_str()), Some(ash.id().as_str())));
    assert_eq!(
        (got["owners"].as_u64(), got["recovered"].as_u64(), got["state"].as_str()),
        (Some(2), Some(1), Some("held"))
    );

    // ---- the old listing sells on the new code: the price is kept, the maker is paid ----
    let bought = call(&contract, ash, "buy_listing", json!({ "id": listing["id"] })).await?;
    assert_eq!((bought["paid"].as_str(), bought["weapon"]["owner"].as_str()), (Some("50"), Some(ash.id().as_str())));
    let economy = view(&contract, "economy", json!({})).await?;
    assert_eq!(economy["last_sales"][0]["prices"], json!(["50"]));
    assert_eq!(economy["last_sales"][0]["frame"], "stevedore");
    let board = view(&contract, "leaderboard", json!({})).await?;
    assert_eq!(board["makers"][0], json!({ "account_id": marlowe.id(), "callsign": "MARLOWE", "value": "1" }));
    // ASH holds three guns now (their own, VANE's from the wreck, MARLOWE's off the market), each worth 400 or more.
    let rows = board["net_worth"].as_array().unwrap();
    let ash_row = rows.iter().find(|r| r["account_id"] == ash.id().as_str()).expect("ASH is on the board");
    assert!(amount(&ash_row["value"]) >= 1_200, "{ash_row}");

    // ---- the vendors' and the Harbormaster's own calls ----
    let built =
        call(&contract, &moss, "vendor_build", json!({ "blueprint": "stevedore", "memo": "Short guns sell." })).await?;
    assert_eq!(
        (built["weapon"]["serial"].as_str(), built["weapon"]["state"].as_str()),
        (Some("S-000008"), Some("vendor"))
    );
    call(&contract, &moss, "vendor_price", json!({ "serial": "S-000008", "price": "999", "memo": "Firm." })).await?;
    call(&contract, &ines, "vendor_price", json!({ "token_id": "ammo", "price": "15", "memo": "Up a little." }))
        .await?;
    let stalls = view(&contract, "vendors", json!({})).await?;
    assert_eq!((stalls[0]["guns"][2]["price"].as_str(), stalls[0]["last_memo"].as_str()), (Some("999"), Some("Firm.")));
    assert_eq!(
        (stalls[1]["goods"][2]["token_id"].as_str(), stalls[1]["goods"][2]["price"].as_str()),
        (Some("ammo"), Some("15"))
    );
    let villain =
        call(&contract, &hm, "hm_posture", json!({ "posture": "pursuit", "memo": "Send it sooner." })).await?;
    let strength = villain["strength"].as_u64().unwrap();
    assert_eq!((villain["posture"].as_str(), villain["bonus_drones"].as_u64()), (Some("pursuit"), Some(0)));
    assert_eq!(amount(&villain["bailiff_at"]), 1_200 - 4 * strength as u128);
    let refused = rook
        .call(contract.id(), "hm_posture")
        .args_json(json!({ "posture": "patrols", "memo": "" }))
        .transact()
        .await?;
    assert!(format!("{:?}", refused.into_result().unwrap_err()).contains("E_NOT_HARBORMASTER"));

    // ---- and the dock carries on: a new player, a new raid, the impound still there ----
    let late = sub(&house, "late", 2).await?;
    call(&contract, &faucet, "register", json!({ "account_id": late.id(), "callsign": "late" })).await?;
    let raid = call(&contract, &late, "start_raid", loadout(None)).await?;
    assert_eq!(raid["harbormaster"]["posture"], "pursuit");
    let held = view(&contract, "impound", json!({ "account_id": dora.id() })).await?;
    assert_eq!(held[0]["weapon"]["serial"], gun(3).as_str());
    assert_eq!(view(&contract, "nft_total_supply", json!({})).await?, "8");

    let storage_after = contract.view_account().await?.storage_usage;
    println!("code: {old_hash} → {new_hash}");
    println!(
        "storage: {storage_before} bytes before the upgrade, {storage_after} after (the new code is {} bytes larger)",
        new.len() as i64 - old.len() as i64
    );
    std::fs::write(format!("{RES}/upgrade-passed"), format!("live={old_hash}\nnew={new_hash}\n"))?;
    Ok(())
}

#[tokio::test]
async fn upgrade_over_a_copy_of_the_live_state() -> anyhow::Result<()> {
    let id: AccountId = std::env::var("CONTRACT_ID").unwrap_or_else(|_| "v2.saltline.testnet".into()).parse()?;
    let Ok(live_hash) = std::fs::read_to_string(format!("{RES}/live.code_hash")) else {
        println!("SKIPPED: no res/live.code_hash. Run ./fetch-live.sh to rehearse over {id}'s real state.");
        return Ok(());
    };
    let new = std::fs::read(NEW_WASM)?;
    let testnet = near_workspaces::testnet().await?;
    let worker = near_workspaces::sandbox().await?;
    // Code, state and a sandbox key for the account; 50 NEAR so the larger code's storage is covered.
    let contract =
        worker.import_contract(&id, &testnet).with_data().initial_balance(NearToken::from_near(50)).transact().await?;
    assert_eq!(code_hash(&contract).await?, live_hash.trim(), "testnet's code changed since ./fetch-live.sh");

    // Every account the views name, and every gun.
    let mut accounts = BTreeSet::from([id.to_string()]);
    let recent = view(&contract, "recent", json!({ "limit": 64 })).await?;
    for e in recent.as_array().unwrap() {
        accounts.insert(e["account"].as_str().unwrap().to_string());
    }
    for v in view(&contract, "vendors", json!({})).await?.as_array().unwrap() {
        accounts.insert(v["account_id"].as_str().unwrap().to_string());
    }
    accounts.insert(view(&contract, "harbormaster", json!({})).await?["account_id"].as_str().unwrap().to_string());
    for l in view(&contract, "listings", json!({})).await?.as_array().unwrap() {
        accounts.insert(l["seller"].as_str().unwrap().to_string());
    }
    for w in view(&contract, "wrecks", json!({})).await?.as_array().unwrap() {
        accounts.insert(w["owner"].as_str().unwrap().to_string());
    }
    let alive = amount(&view(&contract, "nft_total_supply", json!({})).await?) as u32;
    let mut serials = Vec::new();
    for n in 1..=alive + 40 {
        let serial = format!("S-{n:06}");
        let w = view(&contract, "weapon", json!({ "serial": serial })).await?;
        if !w.is_null() {
            accounts.insert(w["owner"].as_str().unwrap().to_string());
            accounts.insert(w["maker"].as_str().unwrap().to_string());
            serials.push(serial);
        }
    }
    let mut raids = Vec::new();
    for a in &accounts {
        let profile = view(&contract, "profile", json!({ "account_id": a })).await?;
        raids.extend(profile["active_raid"].as_u64());
    }
    let rules_before = view(&contract, "rules", json!({})).await?;
    let before = snapshot(&contract, &accounts, &serials, &raids).await?;
    let profiles = before.iter().filter(|(n, v)| n.starts_with("profile(") && !v.is_null()).count();
    println!(
        "{id}: {} accounts named in its views, {profiles} with a profile, {} guns found of {alive} alive, {} open raids",
        accounts.len(),
        serials.len(),
        raids.len()
    );

    contract.as_account().deploy(&new).await?.into_result()?;
    let after = snapshot(&contract, &accounts, &serials, &raids).await?;
    assert_same(&before, &after);
    check_rules(&rules_before, &view(&contract, "rules", json!({})).await?);
    let economy = view(&contract, "economy", json!({})).await?;
    assert_eq!(economy["weapons_alive"].as_u64(), Some(alive as u64));
    let board = view(&contract, "leaderboard", json!({})).await?;
    assert_eq!(board["scanned"], board["players"]);
    assert_eq!(view(&contract, "nft_tokens", json!({})).await?.as_array().unwrap().len(), serials.len().min(50));
    println!("{} views read back the same over the new code; economy {economy}", after.len());
    Ok(())
}
