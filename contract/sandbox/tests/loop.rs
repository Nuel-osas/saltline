//! One full loop on a local nearcore sandbox: deploy the release wasm and call `new`, then register, start_run,
//! extract, sell, broker_export. It also measures the gas `simulate` burns and the storage one player costs.
//!
//! Build the wasm first, then run this from contract/sandbox:
//!   (cd .. && cargo near build non-reproducible-wasm) && cargo test -- --nocapture

use near_workspaces::types::{Gas, NearToken};
use near_workspaces::{Account, Contract, Worker, network::Sandbox};
use serde_json::{Value, json};

const WEIGHT: [(&str, u64); 5] = [("copper", 1), ("meds", 1), ("chips", 1), ("fuel", 2), ("core", 1)];

fn weight(token: &str) -> u64 {
    WEIGHT.iter().find(|(t, _)| *t == token).map(|(_, w)| *w).unwrap()
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

async fn gas_of(contract: &Contract, signer: &Account, method: &str, args: Value, tgas: u64) -> anyhow::Result<(Value, u64)> {
    let out = signer.call(contract.id(), method).args_json(args).gas(Gas::from_tgas(tgas)).transact().await?;
    // The function call's own receipt (the first receipt outcome); `outcome()` is only the transaction's
    // conversion to a receipt, a flat ~0.31 Tgas.
    let burnt = out.receipt_outcomes().first().map(|o| o.gas_burnt.as_gas()).unwrap_or(0);
    println!("  {method}: receipt {}, total {}", tgas_fmt(burnt), tgas_fmt(out.total_gas_burnt.as_gas()));
    let ok = out.into_result().map_err(|e| anyhow::anyhow!("{method} failed: {e:?}"))?;
    let v: Value = ok.json().unwrap_or(Value::Null);
    Ok((v, burnt))
}

fn tgas_fmt(g: u64) -> String {
    format!("{:.2} Tgas", g as f64 / 1e12)
}

fn tgas(g: u64) -> String {
    tgas_fmt(g)
}

#[tokio::test]
async fn one_full_loop_on_the_sandbox() -> anyhow::Result<()> {
    let wasm = std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/../target/near/saltline.wasm"))
        .map_err(|e| anyhow::anyhow!("build the wasm first (cargo near build non-reproducible-wasm): {e}"))?;
    println!("wasm: {} bytes", wasm.len());
    let worker = near_workspaces::sandbox().await?;
    let root = worker.root_account()?;
    let house = sub(&root, "saltline", 60).await?;
    let faucet = sub(&house, "faucet", 5).await?;
    let moss = sub(&house, "moss", 2).await?;
    let ines = sub(&house, "ines", 2).await?;
    let qm = sub(&house, "qm", 2).await?;
    let pilot = sub(&house, "pilot-1", 2).await?;

    let contract = house.deploy(&wasm).await?.into_result()?;
    let (_, g_new) = gas_of(
        &contract,
        contract.as_account(),
        "new",
        json!({ "owner_id": house.id(), "faucet_id": faucet.id(), "brokers": { "moss": moss.id(), "ines": ines.id(), "qm": qm.id() } }),
        100,
    )
    .await?;
    let storage_before = contract.view_account().await?.storage_usage;

    // Register: the faucet only.
    let refused = pilot
        .call(contract.id(), "register")
        .args_json(json!({ "account_id": pilot.id(), "callsign": "pilot-1" }))
        .transact()
        .await?;
    assert!(format!("{:?}", refused.into_result().unwrap_err()).contains("E_NOT_FAUCET"));
    let (profile, g_register) =
        gas_of(&contract, &faucet, "register", json!({ "account_id": pilot.id(), "callsign": "pilot-1" }), 50).await?;
    assert_eq!(profile["callsign"], "PILOT-1");
    let per_player = contract.view_account().await?.storage_usage - storage_before;

    // Start a run.
    let (manifest, g_start) = gas_of(&contract, &pilot, "start_run", json!({ "gear": [] }), 100).await?;
    let run_storage = contract.view_account().await?.storage_usage - storage_before - per_player;
    let run_id = manifest["run_id"].as_u64().unwrap();
    let started = manifest["started_at"].as_u64().unwrap();
    let mut containers: Vec<(u64, String, u64)> = manifest["containers"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| (c["spot"].as_u64().unwrap(), c["token_id"].as_str().unwrap().to_string(), c["amount"].as_str().unwrap().parse().unwrap()))
        .collect();
    containers.sort_by_key(|(_, t, n)| weight(t) * n);
    let (mut opened, mut carried, mut load) = (vec![], vec![], 0);
    for (spot, t, n) in &containers {
        if load + weight(t) * n <= 6 {
            load += weight(t) * n;
            opened.push(*spot);
            carried.push((t.clone(), *n));
        }
    }

    // Too soon, then wait out the minimum on the chain's own clock and extract.
    let early = pilot
        .call(contract.id(), "extract")
        .args_json(json!({ "run_id": run_id, "opened": opened, "wrecks": [] }))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?;
    assert!(format!("{:?}", early.into_result().unwrap_err()).contains("E_TOO_SOON"));
    wait_until(&worker, started + (45 + 8 * opened.len() as u64) * 1_000 + 1_000).await?;
    let (extracted, g_extract) =
        gas_of(&contract, &pilot, "extract", json!({ "run_id": run_id, "opened": opened, "wrecks": [] }), 100).await?;
    println!("extract: {extracted}");

    // Sell one unit of whatever came out first to whichever broker buys it.
    let (token, _) = carried.iter().find(|(t, _)| t != "fuel").cloned().unwrap_or(carried[0].clone());
    let broker = match token.as_str() {
        "copper" | "chips" => "moss",
        "meds" | "fuel" => "ines",
        _ => "qm",
    };
    let (sold, g_sell) =
        gas_of(&contract, &pilot, "sell", json!({ "broker": broker, "token_id": token, "amount": "1" }), 50).await?;
    let balances: Value = contract.view("balances").args_json(json!({ "account_id": pilot.id() })).await?.json()?;
    println!("sold 1 {token} to {broker}: {sold}; balances {balances}");
    assert!(sold["paid"].as_str().unwrap().parse::<u128>()? > 0);

    // A broker export, signed by the broker's own account. Moss starts with 9 copper.
    let (exported, g_export) = gas_of(
        &contract,
        &moss,
        "broker_export",
        json!({ "token_id": "copper", "amount": "2", "memo": "Sandbox check." }),
        50,
    )
    .await?;
    assert_eq!(exported["earned"], "70");
    let refused = pilot
        .call(contract.id(), "broker_export")
        .args_json(json!({ "token_id": "copper", "amount": "1", "memo": "" }))
        .transact()
        .await?;
    assert!(format!("{:?}", refused.into_result().unwrap_err()).contains("E_NOT_BROKER"));

    // simulate: as a view (what the Dockside calls) and as a transaction, to read the gas it burns.
    let week: Value =
        contract.view("simulate").args_json(json!({ "hours": 168, "traders": 30, "seed": 7 })).await?.json()?;
    assert_eq!(week.as_array().unwrap().len(), 169);
    let mut worst = 0;
    for seed in [7u64, 42, 1, 2026] {
        let (_, g) =
            gas_of(&contract, &pilot, "simulate", json!({ "hours": 168, "traders": 30, "seed": seed }), 300).await?;
        println!("simulate 168 h × 30 traders, seed {seed}: {}", tgas(g));
        worst = worst.max(g);
    }
    let (_, g_board) = gas_of(&contract, &pilot, "brokers", json!({}), 300).await?;
    let (_, g_lead) = gas_of(&contract, &pilot, "leaderboard", json!({}), 300).await?;

    println!("gas: new {}, register {}, start_run {}, extract {}, sell {}, broker_export {}", tgas(g_new), tgas(g_register), tgas(g_start), tgas(g_extract), tgas(g_sell), tgas(g_export));
    println!("gas: simulate worst {}, brokers {}, leaderboard (1 player) {}", tgas(worst), tgas(g_board), tgas(g_lead));
    println!("storage: one player {per_player} bytes, one open run {run_storage} bytes, contract total {} bytes", contract.view_account().await?.storage_usage);
    assert!(worst < 300_000_000_000_000, "simulate must fit a 300 Tgas view");
    Ok(())
}
