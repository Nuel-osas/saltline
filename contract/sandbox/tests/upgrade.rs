//! The story upgrade, rehearsed on a local sandbox before it touches saltline.testnet.
//!
//! - `upgrade_keeps_every_view_and_starts_the_town_at_act_one`: deploy the code that is live now (`res/live.wasm`)
//!   and call `new`; make state (two players, runs, an extraction, a sale, an investment, a listing, a wreck, an
//!   export, and a run left open); deploy the new release wasm over it with no init call; then check that every view
//!   reads back exactly as before, that `town` starts at Act I, and that the open run and new sales still work.
//! - `upgrade_over_a_copy_of_the_live_state`: import saltline.testnet's code and its whole state into the sandbox,
//!   deploy the new wasm over it, and check every view, for every player found, reads back exactly as before.
//!
//! Run from contract/sandbox, after building the new wasm and fetching the live one (contract/upgrade.sh does this):
//!   (cd .. && cargo near build non-reproducible-wasm) && ./fetch-live.sh
//!   cargo test --test upgrade -- --nocapture --test-threads=1
//!
//! When the first test passes it writes `res/upgrade-passed` with the code hash it upgraded from and the one it
//! upgraded to. contract/upgrade.sh deploys only a wasm with that hash, over live code with that hash.

use std::collections::{BTreeMap, BTreeSet};

use near_workspaces::types::{Gas, NearToken};
use near_workspaces::{network::Sandbox, Account, AccountId, Contract, ContractState, Worker};
use serde_json::{json, Value};

const RES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/res");
const NEW_WASM: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../target/near/saltline.wasm");
const TOKENS: [&str; 9] = ["scrip", "copper", "meds", "chips", "fuel", "core", "plate", "mag", "cutter"];
const WEIGHT: [(&str, u64); 5] = [("copper", 1), ("meds", 1), ("chips", 1), ("fuel", 2), ("core", 1)];

fn weight(token: &str) -> u64 {
    WEIGHT.iter().find(|(t, _)| *t == token).map(|(_, w)| *w).unwrap()
}

fn read(path: &str, hint: &str) -> anyhow::Result<Vec<u8>> {
    std::fs::read(path).map_err(|e| anyhow::anyhow!("{path}: {e}. {hint}"))
}

/// The live code and its chain-reported hash (from ./fetch-live.sh), and the new release wasm.
fn wasms() -> anyhow::Result<(Vec<u8>, String, Vec<u8>)> {
    let live = read(&format!("{RES}/live.wasm"), "Run ./fetch-live.sh first")?;
    let live_hash = std::fs::read_to_string(format!("{RES}/live.code_hash"))?.trim().to_string();
    let new = read(NEW_WASM, "Build it first: (cd .. && cargo near build non-reproducible-wasm)")?;
    assert_ne!(live, new, "the new wasm is the live one: nothing to upgrade");
    Ok((live, live_hash, new))
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
        worker.fast_forward(50).await?;
    }
    Ok(())
}

/// Call `method` as `signer`; returns the result and the gas the function call's own receipt burnt.
async fn call(
    contract: &Contract,
    signer: &Account,
    method: &str,
    args: Value,
    tgas: u64,
) -> anyhow::Result<(Value, u64)> {
    let out = signer.call(contract.id(), method).args_json(args).gas(Gas::from_tgas(tgas)).transact().await?;
    let burnt = out.receipt_outcomes().first().map(|o| o.gas_burnt.as_gas()).unwrap_or(0);
    let ok = out.into_result().map_err(|e| anyhow::anyhow!("{method} failed: {e:?}"))?;
    Ok((ok.json().unwrap_or(Value::Null), burnt))
}

fn tgas(g: u64) -> String {
    format!("{:.2} Tgas", g as f64 / 1e12)
}

async fn view(contract: &Contract, method: &str, args: Value) -> anyhow::Result<Value> {
    Ok(contract.view(method).args_json(args).await?.json()?)
}

/// Every view the contract had before the story, for these accounts. A view that fails fails the test.
async fn snapshot(contract: &Contract, accounts: &BTreeSet<String>) -> anyhow::Result<Vec<(String, Value)>> {
    let mut out = Vec::new();
    for method in ["brokers", "leaderboard", "listings", "wrecks", "items", "rules"] {
        out.push((method.to_string(), view(contract, method, json!({})).await?));
    }
    out.push(("recent(64)".into(), view(contract, "recent", json!({ "limit": 64 })).await?));
    for t in TOKENS {
        out.push((format!("mt_supply({t})"), view(contract, "mt_supply", json!({ "token_id": t })).await?));
    }
    for broker in ["moss", "ines", "qm"] {
        out.push((format!("advice({broker})"), view(contract, "advice", json!({ "broker": broker })).await?));
    }
    for a in accounts {
        for method in ["profile", "balances"] {
            out.push((format!("{method}({a})"), view(contract, method, json!({ "account_id": a })).await?));
        }
        let batch = view(contract, "mt_batch_balance_of", json!({ "account_id": a, "token_ids": TOKENS })).await?;
        out.push((format!("mt_batch_balance_of({a})"), batch));
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

/// Containers from a manifest that fit within the carry limit (6), lightest first: (spots, [(token, amount)]).
fn fit(manifest: &Value) -> (Vec<u64>, Vec<(String, u64)>) {
    let mut c: Vec<(u64, String, u64)> = manifest["containers"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| {
            let n = c["amount"].as_str().unwrap().parse().unwrap();
            (c["spot"].as_u64().unwrap(), c["token_id"].as_str().unwrap().to_string(), n)
        })
        .collect();
    c.sort_by_key(|(_, t, n)| weight(t) * n);
    let (mut spots, mut carried, mut load) = (vec![], vec![], 0);
    for (spot, t, n) in c {
        if load + weight(&t) * n <= 6 {
            load += weight(&t) * n;
            spots.push(spot);
            carried.push((t, n));
        }
    }
    (spots, carried)
}

fn buyer(token: &str) -> &'static str {
    match token {
        "copper" | "chips" => "moss",
        "meds" | "fuel" => "ines",
        _ => "qm",
    }
}

fn check_town_at_act_one(town: &Value) {
    assert_eq!(town["act"], 1);
    for cargo in ["copper", "meds", "chips", "fuel", "core"] {
        assert_eq!(town["delivered"][cargo], "0", "{cargo}");
    }
    assert_eq!(
        town["districts"],
        json!([
            { "id": "clinic", "token_id": "meds", "need": "15", "have": "0", "lit": false, "lit_at": null },
            { "id": "generators", "token_id": "fuel", "need": "10", "have": "0", "lit": false, "lit_at": null }
        ])
    );
    assert_eq!(town["client"], json!({ "need": "8", "have": "0", "revealed": false, "revealed_at": null }));
    assert_eq!(town["harbormaster"], json!({ "strength": 0, "recent_cores": "0", "bonus_drones": 0 }));
}

#[tokio::test]
async fn upgrade_keeps_every_view_and_starts_the_town_at_act_one() -> anyhow::Result<()> {
    let (live, live_hash, new) = wasms()?;
    println!("live wasm {} bytes ({live_hash}), new wasm {} bytes", live.len(), new.len());
    let worker = near_workspaces::sandbox().await?;
    let root = worker.root_account()?;
    let house = sub(&root, "saltline", 60).await?;
    let faucet = sub(&house, "faucet", 5).await?;
    let moss = sub(&house, "moss", 2).await?;
    let ines = sub(&house, "ines", 2).await?;
    let qm = sub(&house, "qm", 2).await?;
    let gull = sub(&house, "gull", 2).await?;
    let tern = sub(&house, "tern", 2).await?;

    // 1. The live code, initialised as deploy.sh does.
    let contract = house.deploy(&live).await?.into_result()?;
    assert_eq!(code_hash(&contract).await?, live_hash, "res/live.wasm isn't the code fetch-live.sh saw on chain");
    let brokers = json!({ "moss": moss.id(), "ines": ines.id(), "qm": qm.id() });
    call(
        &contract,
        contract.as_account(),
        "new",
        json!({ "owner_id": house.id(), "faucet_id": faucet.id(), "brokers": brokers }),
        100,
    )
    .await?;
    assert!(contract.view("town").args_json(json!({})).await.is_err(), "the live code has no town");

    // 2. State, by the old code: register, run, extract, sell; plus an investment, a listing, a wreck, an export.
    for (p, callsign) in [(&gull, "gull"), (&tern, "tern")] {
        call(&contract, &faucet, "register", json!({ "account_id": p.id(), "callsign": callsign }), 50).await?;
    }
    let (m_gull, _) = call(&contract, &gull, "start_run", json!({ "gear": [] }), 100).await?;
    let (m_tern, _) = call(&contract, &tern, "start_run", json!({ "gear": [] }), 100).await?;
    let (gull_spots, carried) = fit(&m_gull);
    let (tern_spots, _) = fit(&m_tern);
    // Extracting needs 45 s + 8 s per container opened; dying needs 8 s per container.
    let gull_ready = m_gull["started_at"].as_u64().unwrap() + (45 + 8 * gull_spots.len() as u64) * 1_000;
    let tern_ready = m_tern["started_at"].as_u64().unwrap() + 8 * tern_spots.len() as u64 * 1_000;
    wait_until(&worker, gull_ready.max(tern_ready) + 1_000).await?;
    let run = m_gull["run_id"].as_u64().unwrap();
    call(&contract, &gull, "extract", json!({ "run_id": run, "opened": gull_spots, "wrecks": [] }), 100).await?;
    let tern_run = m_tern["run_id"].as_u64().unwrap();
    let (died, _) = call(
        &contract,
        &tern,
        "die",
        json!({ "run_id": tern_run, "opened": tern_spots, "wrecks": [], "spot": 0 }),
        100,
    )
    .await?;
    assert!(died["wreck_id"].is_u64(), "Tern carried something down: {died}");
    let (token, _) = carried[0].clone();
    let (_, g_sell_old) =
        call(&contract, &gull, "sell", json!({ "broker": buyer(&token), "token_id": token, "amount": "1" }), 50)
            .await?;
    call(&contract, &gull, "invest", json!({ "broker": "moss", "amount": "10" }), 50).await?;
    let mut held: BTreeMap<String, u64> = BTreeMap::new();
    for (t, n) in &carried {
        *held.entry(t.clone()).or_default() += n;
    }
    *held.get_mut(&token).unwrap() -= 1;
    let listed = held.iter().find(|(_, n)| **n > 0).map(|(t, _)| t.clone());
    if let Some(t) = &listed {
        call(&contract, &gull, "list", json!({ "token_id": t, "amount": "1", "price": "50" }), 50).await?;
    }
    call(&contract, &moss, "broker_export", json!({ "token_id": "copper", "amount": "2", "memo": "Before." }), 50)
        .await?;
    // A run left open across the upgrade (runs start at most every 30 s, measured start to start).
    let (open_run, _) = call(&contract, &gull, "start_run", json!({ "gear": [] }), 100).await?;

    let accounts: BTreeSet<String> = [&gull, &tern, &moss, &ines, &qm, contract.as_account()]
        .iter()
        .map(|a| a.id().to_string())
        .chain(["nobody.test.near".to_string()])
        .collect();
    let before = snapshot(&contract, &accounts).await?;
    let storage_before = contract.view_account().await?.storage_usage;
    let board = &before.iter().find(|(n, _)| n == "listings").unwrap().1;
    assert_eq!(board.as_array().unwrap().len(), listed.iter().count());

    // 3. The new code over it, with no init call.
    let contract = house.deploy(&new).await?.into_result()?;
    let new_hash = code_hash(&contract).await?;
    assert_ne!(new_hash, live_hash);

    // 4. Every view reads back exactly as before, and the town starts at Act I.
    let after = snapshot(&contract, &accounts).await?;
    assert_same(&before, &after);
    check_town_at_act_one(&view(&contract, "town", json!({})).await?);
    let (_, g_town) = call(&contract, &gull, "town", json!({}), 50).await?;

    // 5. Calls still work: the run left open closes on the new code, and a sale is a delivery.
    let open_id = open_run["run_id"].as_u64().unwrap();
    let (spots, carried) = fit(&open_run);
    wait_until(&worker, open_run["started_at"].as_u64().unwrap() + (45 + 8 * spots.len() as u64) * 1_000 + 1_000)
        .await?;
    call(&contract, &gull, "extract", json!({ "run_id": open_id, "opened": spots, "wrecks": [] }), 100).await?;
    let (token, _) = carried[0].clone();
    let (_, g_sell_new) =
        call(&contract, &gull, "sell", json!({ "broker": buyer(&token), "token_id": token, "amount": "1" }), 50)
            .await?;
    let town = view(&contract, "town", json!({})).await?;
    assert_eq!(town["delivered"][&token], "1", "{town}");
    assert_eq!(town["act"], 1);
    let storage_after = contract.view_account().await?.storage_usage;

    // 6. The dearest sale there is: one that lights both districts, starts Act II and reveals the client (four
    //    events and four ledger lines). A town one sale from all of it is patched in as Borsh (town.rs → Town):
    //    meds 15 and fuel 10 delivered, 8 cores sold to the Quartermaster, nothing lit yet. Any sale then sets it off.
    let mut town_bytes = Vec::new();
    for delivered in [0u128, 0, 15, 0, 10, 0, 0, 0, 0] {
        town_bytes.extend(delivered.to_le_bytes());
    }
    town_bytes.extend([0u8, 0]); // lit_at: [None, None]
    town_bytes.extend(8u128.to_le_bytes()); // client_cores
    town_bytes.push(0); // revealed_at: None
    town_bytes.extend(0u128.to_le_bytes()); // recent_cores_milli
    town_bytes.extend(0u64.to_le_bytes()); // recent_at
    worker.patch_state(contract.id(), b"town", &town_bytes).await?;
    let mut held: BTreeMap<String, u64> = BTreeMap::new();
    for (t, n) in &carried {
        *held.entry(t.clone()).or_default() += n;
    }
    *held.get_mut(&token).unwrap() -= 1;
    let next = held.iter().find(|(_, n)| **n > 0).map(|(t, _)| t.clone()).expect("a run carries at least 3 units");
    let (_, g_sell_reveal) =
        call(&contract, &gull, "sell", json!({ "broker": buyer(&next), "token_id": next, "amount": "1" }), 50).await?;
    let town = view(&contract, "town", json!({})).await?;
    assert_eq!((town["act"].as_u64(), &town["client"]["revealed"]), (Some(3), &json!(true)), "{town}");
    let lines: Vec<(String, String)> = view(&contract, "recent", json!({ "limit": 5 }))
        .await?
        .as_array()
        .unwrap()
        .iter()
        .map(|e| (e["kind"].as_str().unwrap().to_string(), e["text"].as_str().unwrap().to_string()))
        .collect();
    let expect = [
        ("act", "The Quartermaster's client is the Harbormaster."),
        ("act", "The town across the water is lit again."),
        ("district", "The generators are running. Lights on the water."),
        ("district", "The clinic's lights are back on."),
    ];
    for (i, (kind, text)) in expect.iter().enumerate() {
        assert_eq!((lines[i].0.as_str(), lines[i].1.as_str()), (*kind, *text));
    }
    assert_eq!(lines[4].0, "sale");

    println!("code: {live_hash} → {new_hash}");
    println!(
        "gas: sell {} on the live code, {} after the upgrade, {} for the sale that lights both districts and reveals; town {}",
        tgas(g_sell_old),
        tgas(g_sell_new),
        tgas(g_sell_reveal),
        tgas(g_town)
    );
    println!(
        "storage: {storage_before} bytes before the upgrade, {storage_after} after (new code, an extract, a sale, the town key)"
    );
    std::fs::write(format!("{RES}/upgrade-passed"), format!("live={live_hash}\nnew={new_hash}\n"))?;
    Ok(())
}

#[tokio::test]
async fn upgrade_over_a_copy_of_the_live_state() -> anyhow::Result<()> {
    let id: AccountId = std::env::var("CONTRACT_ID").unwrap_or_else(|_| "saltline.testnet".into()).parse()?;
    let (_, live_hash, new) = wasms()?;
    let testnet = near_workspaces::testnet().await?;
    let worker = near_workspaces::sandbox().await?;
    // Code, state and a sandbox key for the account; 50 NEAR so the larger code's storage is covered.
    let contract =
        worker.import_contract(&id, &testnet).with_data().initial_balance(NearToken::from_near(50)).transact().await?;
    assert_eq!(code_hash(&contract).await?, live_hash, "testnet's code changed since ./fetch-live.sh");
    let town_before = contract.view("town").args_json(json!({})).await.ok().map(|v| v.json::<Value>()).transpose()?;

    // Every account the views name: players in the ticker, the boards, shareholders, sellers and wreck owners.
    let mut accounts = BTreeSet::new();
    let recent = view(&contract, "recent", json!({ "limit": 64 })).await?;
    let board = view(&contract, "leaderboard", json!({})).await?;
    let brokers = view(&contract, "brokers", json!({})).await?;
    let listings = view(&contract, "listings", json!({})).await?;
    let wrecks = view(&contract, "wrecks", json!({})).await?;
    for e in recent.as_array().unwrap() {
        accounts.insert(e["account"].as_str().unwrap().to_string());
    }
    for rows in board.as_object().unwrap().values() {
        accounts.extend(rows.as_array().unwrap().iter().map(|r| r["account_id"].as_str().unwrap().to_string()));
    }
    for b in brokers.as_array().unwrap() {
        accounts.insert(b["account_id"].as_str().unwrap().to_string());
        accounts.extend(b["shares"].as_array().unwrap().iter().map(|s| s["account_id"].as_str().unwrap().to_string()));
    }
    accounts.extend(listings.as_array().unwrap().iter().map(|l| l["seller"].as_str().unwrap().to_string()));
    accounts.extend(wrecks.as_array().unwrap().iter().map(|w| w["owner"].as_str().unwrap().to_string()));
    let before = snapshot(&contract, &accounts).await?;
    let profiles = before.iter().filter(|(n, v)| n.starts_with("profile(") && !v.is_null()).count();
    assert!(profiles > 0, "the live state should have players in it");
    println!(
        "{id}: {} accounts named in its views, {profiles} with a profile; {} ledger lines",
        accounts.len(),
        recent.as_array().unwrap().len()
    );

    contract.as_account().deploy(&new).await?.into_result()?;
    let after = snapshot(&contract, &accounts).await?;
    assert_same(&before, &after);
    let town = view(&contract, "town", json!({})).await?;
    match town_before {
        // Already upgraded once: the town carries over too.
        Some(t) => assert_eq!(t["act"], town["act"]),
        None => check_town_at_act_one(&town),
    }
    println!("{profiles} profiles and every view read back the same over the new code; town act {}", town["act"]);
    Ok(())
}
