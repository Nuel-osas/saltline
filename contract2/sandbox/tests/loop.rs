//! The whole loop on a local nearcore sandbox, against the release wasm:
//! deploy and `new`; three players; raids on the chain's own clock until one can build a gun; the gun is listed,
//! bought (the maker is paid), taken on a raid, lost in a wreck, carried out by a third player, and transferred;
//! arrears are settled, a material is exported, the owner pauses. Then every exported method is called by a
//! stranger, and the wasm's export table is checked against the list here. It prints the gas and storage figures
//! contract2/README.md quotes.
//!
//! Build the wasm first, then run this from contract2/sandbox:
//!   (cd .. && cargo near build non-reproducible-wasm) && cargo test -- --nocapture

use std::collections::BTreeSet;

use near_workspaces::types::{Gas, NearToken};
use near_workspaces::{network::Sandbox, Account, Contract, Worker};
use serde_json::{json, Value};

const WASM: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../target/near/saltline2.wasm");

fn weight(token: &str) -> u64 {
    if token == "fuel" {
        2
    } else {
        1
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

fn tgas(g: u64) -> String {
    format!("{:.2} Tgas", g as f64 / 1e12)
}

/// Call `method` as `signer`; returns the result and the gas the function call's own receipt burnt.
async fn call(
    contract: &Contract,
    signer: &Account,
    method: &str,
    args: Value,
    yocto: u128,
) -> anyhow::Result<(Value, u64)> {
    let out = signer
        .call(contract.id(), method)
        .args_json(args)
        .gas(Gas::from_tgas(300))
        .deposit(NearToken::from_yoctonear(yocto))
        .transact()
        .await?;
    // The first receipt outcome is the function call itself; `outcome()` is only the transaction's conversion to
    // a receipt.
    let burnt = out.receipt_outcomes().first().map(|o| o.gas_burnt.as_gas()).unwrap_or(0);
    let ok = out.into_result().map_err(|e| anyhow::anyhow!("{method} failed: {e:?}"))?;
    Ok((ok.json().unwrap_or(Value::Null), burnt))
}

/// The refusal `method` ends in when `signer` calls it, or an error if it went through.
async fn refused(
    contract: &Contract,
    signer: &Account,
    method: &str,
    args: Value,
    yocto: u128,
) -> anyhow::Result<String> {
    let out = signer
        .call(contract.id(), method)
        .args_json(args)
        .gas(Gas::from_tgas(100))
        .deposit(NearToken::from_yoctonear(yocto))
        .transact()
        .await?;
    match out.into_result() {
        Ok(_) => anyhow::bail!("{method} went through for {}", signer.id()),
        Err(e) => Ok(format!("{e:?}")),
    }
}

async fn view(contract: &Contract, method: &str, args: Value) -> anyhow::Result<Value> {
    Ok(contract.view(method).args_json(args).await?.json()?)
}

async fn storage(contract: &Contract) -> anyhow::Result<u64> {
    Ok(contract.view_account().await?.storage_usage)
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

/// The function names a wasm module exports.
fn wasm_exports(wasm: &[u8]) -> BTreeSet<String> {
    fn leb(b: &[u8], at: &mut usize) -> usize {
        let (mut out, mut shift) = (0usize, 0);
        loop {
            let byte = b[*at];
            *at += 1;
            out |= ((byte & 0x7f) as usize) << shift;
            if byte & 0x80 == 0 {
                return out;
            }
            shift += 7;
        }
    }
    assert_eq!(&wasm[..4], b"\0asm");
    let mut at = 8;
    let mut out = BTreeSet::new();
    while at < wasm.len() {
        let id = wasm[at];
        at += 1;
        let size = leb(wasm, &mut at);
        if id == 7 {
            let mut p = at;
            for _ in 0..leb(wasm, &mut p) {
                let len = leb(wasm, &mut p);
                let name = String::from_utf8(wasm[p..p + len].to_vec()).unwrap();
                p += len;
                let kind = wasm[p];
                p += 1;
                leb(wasm, &mut p);
                if kind == 0 {
                    out.insert(name);
                }
            }
        }
        at += size;
    }
    out
}

/// Every method that changes state: its arguments, the yoctoNEAR it wants, and what a stranger is told.
fn calls() -> Vec<(&'static str, Value, u128, &'static str)> {
    let kit = json!({ "weapon": null, "plates": 0, "charges": 0, "mags": 0 });
    let r = report(&[], &[], 0);
    vec![
        (
            "new",
            json!({ "owner_id": "x.near", "faucet_id": "y.near", "harbormaster_id": "z.near", "vendors": { "moss": "m.near", "ines": "i.near" } }),
            0,
            "private",
        ),
        ("pause", json!({}), 0, "E_NOT_OWNER"),
        ("unpause", json!({}), 0, "E_NOT_OWNER"),
        ("register", json!({ "account_id": "x.near", "callsign": "stranger" }), 0, "E_NOT_FAUCET"),
        ("start_raid", json!({ "loadout": kit }), 0, "E_NOT_REGISTERED"),
        ("extract", json!({ "raid_id": 1, "report": r }), 0, "E_NOT_REGISTERED"),
        ("die", json!({ "raid_id": 1, "report": r, "spot": 0, "by": "machines" }), 0, "E_NOT_REGISTERED"),
        ("build", json!({ "blueprint": "ammo" }), 0, "E_NOT_REGISTERED"),
        ("fit", json!({ "serial": "S-000003", "mod": "comp" }), 0, "E_NOT_REGISTERED"),
        ("repair", json!({ "serial": "S-000003", "points": null }), 0, "E_NOT_REGISTERED"),
        ("scrap", json!({ "serial": "S-000003" }), 0, "E_NOT_REGISTERED"),
        ("sell", json!({ "vendor": "moss", "token_id": "copper", "amount": "1" }), 0, "E_NOT_REGISTERED"),
        ("buy", json!({ "vendor": "ines", "token_id": "ammo", "amount": "1" }), 0, "E_NOT_REGISTERED"),
        ("buy_gun", json!({ "vendor": "moss", "serial": "S-000001" }), 0, "E_NOT_REGISTERED"),
        ("export", json!({ "token_id": "copper", "amount": "1" }), 0, "E_NOT_REGISTERED"),
        ("list_weapon", json!({ "serial": "S-000003", "price": "10" }), 0, "E_NOT_REGISTERED"),
        ("list_item", json!({ "token_id": "copper", "amount": "1", "price": "10" }), 0, "E_NOT_REGISTERED"),
        ("buy_listing", json!({ "id": 1 }), 0, "E_NOT_REGISTERED"),
        ("cancel_listing", json!({ "id": 1 }), 0, "E_NOT_REGISTERED"),
        ("settle", json!({ "amount": "1" }), 0, "E_NOT_REGISTERED"),
        ("buy_back", json!({ "serial": "S-000003" }), 0, "E_NOT_REGISTERED"),
        ("nft_transfer", json!({ "receiver_id": "x.near", "token_id": "S-000003" }), 1, "E_NOT_REGISTERED"),
        ("mt_transfer", json!({ "receiver_id": "x.near", "token_id": "scrip", "amount": "1" }), 1, "E_NOT_REGISTERED"),
        (
            "mt_batch_transfer",
            json!({ "receiver_id": "x.near", "token_ids": ["scrip"], "amounts": ["1"] }),
            1,
            "E_NOT_REGISTERED",
        ),
    ]
}

/// Every view, with arguments that find something.
fn views(account: &str) -> Vec<(&'static str, Value)> {
    vec![
        ("paused", json!({})),
        ("rules", json!({})),
        ("materials", json!({})),
        ("frames", json!({})),
        ("blueprints", json!({})),
        ("profile", json!({ "account_id": account })),
        ("balances", json!({ "account_id": account })),
        ("weapons", json!({ "account_id": account })),
        ("weapon", json!({ "serial": "S-000003" })),
        ("vendors", json!({})),
        ("export_prices", json!({})),
        ("listings", json!({})),
        ("wrecks", json!({})),
        ("impound", json!({ "account_id": account })),
        ("harbormaster", json!({})),
        ("raid", json!({ "raid_id": 1 })),
        ("recent", json!({ "limit": 64 })),
        ("mt_balance_of", json!({ "account_id": account, "token_id": "scrip" })),
        ("mt_batch_balance_of", json!({ "account_id": account, "token_ids": ["scrip", "copper"] })),
        ("mt_supply", json!({ "token_id": "scrip" })),
        ("nft_token", json!({ "token_id": "S-000003" })),
        ("nft_total_supply", json!({})),
        ("nft_supply_for_owner", json!({ "account_id": account })),
        ("nft_tokens_for_owner", json!({ "account_id": account, "from_index": "0", "limit": 10 })),
    ]
}

#[tokio::test]
async fn the_whole_loop_on_the_sandbox() -> anyhow::Result<()> {
    let wasm = std::fs::read(WASM)
        .map_err(|e| anyhow::anyhow!("build the wasm first (cargo near build non-reproducible-wasm): {e}"))?;
    println!("wasm: {} bytes", wasm.len());
    let worker = near_workspaces::sandbox().await?;
    let root = worker.root_account()?;
    let house = sub(&root, "v2", 60).await?;
    let faucet = sub(&house, "faucet", 5).await?;
    let hm = sub(&house, "harbormaster", 2).await?;
    let moss = sub(&house, "moss", 2).await?;
    let ines = sub(&house, "ines", 2).await?;
    let rook = sub(&house, "rook", 3).await?;
    let marlowe = sub(&house, "marlowe", 3).await?;
    let vane = sub(&house, "vane", 3).await?;
    let stranger = sub(&root, "stranger", 3).await?;

    // ---- deploy and new ----
    let contract = house.deploy(&wasm).await?.into_result()?;
    let init = json!({
        "owner_id": house.id(), "faucet_id": faucet.id(), "harbormaster_id": hm.id(),
        "vendors": { "moss": moss.id(), "ines": ines.id() }
    });
    let (_, g_new) = call(&contract, contract.as_account(), "new", init.clone(), 0).await?;
    assert!(refused(&contract, contract.as_account(), "new", init, 0).await?.contains("already been initialized"));
    let s_genesis = storage(&contract).await?;
    let rack = view(&contract, "vendors", json!({})).await?;
    assert_eq!(rack[0]["guns"].as_array().unwrap().len(), 2);
    assert_eq!(rack[0]["guns"][0]["weapon"]["serial"], "S-000001");
    assert_eq!(view(&contract, "mt_supply", json!({ "token_id": "scrip" })).await?, "3000");

    // ---- three players ----
    let (profile, g_register) =
        call(&contract, &faucet, "register", json!({ "account_id": rook.id(), "callsign": "rook" }), 0).await?;
    assert_eq!(profile["callsign"], "ROOK");
    let s_player = storage(&contract).await? - s_genesis;
    call(&contract, &faucet, "register", json!({ "account_id": marlowe.id(), "callsign": "marlowe" }), 0).await?;
    call(&contract, &faucet, "register", json!({ "account_id": vane.id(), "callsign": "vane" }), 0).await?;

    // ---- raids on the chain's own clock until ROOK can build a Stevedore: 4 copper, 3 electronics, 3 rotors ----
    let issue = json!({ "loadout": { "weapon": null, "plates": 0, "charges": 0, "mags": 0 } });
    let (mut g_start, mut g_extract, mut s_raid, mut raids) = (0, 0, 0, 0);
    loop {
        let b = view(&contract, "balances", json!({ "account_id": rook.id() })).await?;
        if bal(&b, "copper") >= 5 && bal(&b, "chips") >= 3 && bal(&b, "rotor") >= 3 {
            break;
        }
        raids += 1;
        assert!(raids <= 40, "forty raids should have found the parts: {b}");
        let before = storage(&contract).await?;
        let (raid, g) = call(&contract, &rook, "start_raid", issue.clone(), 0).await?;
        s_raid = storage(&contract).await? - before;
        g_start = g_start.max(g);
        let (spots, load) = pick(&raid, 4);
        let rotors = (6 - load).min(2);
        let args = json!({ "raid_id": raid["raid_id"], "report": report(&spots, &[], rotors) });
        if raids == 1 {
            // Straight away: the kills are more than one every four seconds, and without them it is still too soon.
            let early = json!({ "raid_id": raid["raid_id"], "report": report(&spots, &[], 0) });
            assert!(refused(&contract, &rook, "extract", early, 0).await?.contains("E_TOO_SOON"));
            if rotors > 0 {
                assert!(refused(&contract, &rook, "extract", args.clone(), 0).await?.contains("E_BAD_REPORT"));
            }
        }
        wait_until(&worker, raid["started_at"].as_u64().unwrap() + (45 + 8 * spots.len() as u64) * 1_000 + 1_000)
            .await?;
        let (out, g) = call(&contract, &rook, "extract", args, 0).await?;
        g_extract = g_extract.max(g);
        assert!(amount(&out["invoice"]) >= 150 + 45);
    }
    println!("{raids} raids to gather a Stevedore's parts");

    // ---- build, and the JSON names the client sends ----
    let before = storage(&contract).await?;
    let (built, g_build) = call(&contract, &rook, "build", json!({ "blueprint": "stevedore" }), 0).await?;
    let s_gun = storage(&contract).await? - before;
    let gun = built["weapon"]["serial"].as_str().unwrap().to_string();
    assert_eq!(gun, "S-000003");
    assert_eq!(
        (built["weapon"]["maker_callsign"].as_str(), built["weapon"]["state"].as_str()),
        (Some("ROOK"), Some("held"))
    );
    println!("built: {}", built["weapon"]);
    // `fit` takes its mod under the key `mod` (a Rust keyword on the contract's side).
    let no_mod = refused(&contract, &rook, "fit", json!({ "serial": gun, "mod": "comp" }), 0).await?;
    assert!(no_mod.contains("E_FUNDS"), "{no_mod}");

    // ---- list it; MARLOWE buys it; the maker is paid ----
    let before = storage(&contract).await?;
    let (listed, g_list) = call(&contract, &rook, "list_weapon", json!({ "serial": gun, "price": "100" }), 0).await?;
    let s_listing = storage(&contract).await? - before;
    let busy = refused(&contract, &rook, "scrap", json!({ "serial": gun }), 0).await?;
    assert!(busy.contains("E_WEAPON_BUSY"), "{busy}");
    let rook_before = bal(&view(&contract, "balances", json!({ "account_id": rook.id() })).await?, "scrip");
    let (bought, g_buy_listing) = call(&contract, &marlowe, "buy_listing", json!({ "id": listed["id"] }), 0).await?;
    assert_eq!(
        (bought["paid"].as_str(), bought["weapon"]["owner"].as_str()),
        (Some("100"), Some(marlowe.id().as_str()))
    );
    let rook_after = bal(&view(&contract, "balances", json!({ "account_id": rook.id() })).await?, "scrip");
    assert_eq!(rook_after - rook_before, 96 + 2, "96 as the seller and 2 as the maker");
    assert_eq!(view(&contract, "profile", json!({ "account_id": rook.id() })).await?["royalties"], "2");
    assert_eq!(
        view(&contract, "mt_balance_of", json!({ "account_id": marlowe.id(), "token_id": "scrip" })).await?,
        "50"
    );

    // ---- MARLOWE takes it on a raid and dies; it lies in a wreck ----
    let (raid, g_start_gun) = call(
        &contract,
        &marlowe,
        "start_raid",
        json!({ "loadout": { "weapon": gun, "plates": 0, "charges": 0, "mags": 0 } }),
        0,
    )
    .await?;
    assert_eq!(view(&contract, "weapon", json!({ "serial": gun })).await?["state"], "raid");
    let locked =
        refused(&contract, &marlowe, "nft_transfer", json!({ "receiver_id": vane.id(), "token_id": gun }), 1).await?;
    assert!(locked.contains("E_WEAPON_BUSY"), "{locked}");
    let (spots, _) = pick(&raid, 3);
    wait_until(&worker, raid["started_at"].as_u64().unwrap() + 8 * spots.len() as u64 * 1_000 + 1_000).await?;
    let before = storage(&contract).await?;
    let (died, g_die) = call(
        &contract,
        &marlowe,
        "die",
        json!({ "raid_id": raid["raid_id"], "report": report(&spots, &[], 0), "spot": 3, "by": "machines" }),
        0,
    )
    .await?;
    let s_wreck = storage(&contract).await? as i64 - before as i64;
    let wreck = died["wreck_id"].as_u64().unwrap();
    let yard = view(&contract, "wrecks", json!({})).await?;
    assert_eq!(
        (yard[0]["id"].as_u64(), yard[0]["weapon"]["serial"].as_str(), yard[0]["weapon"]["state"].as_str()),
        (Some(wreck), Some(gun.as_str()), Some("wreck"))
    );

    // ---- VANE's raid finds the wreck and carries the gun out: it is VANE's ----
    let (raid, g_start_wreck) = call(&contract, &vane, "start_raid", issue.clone(), 0).await?;
    assert_eq!(raid["wrecks"][0]["id"].as_u64(), Some(wreck));
    let (spots, _) = pick(&raid, 4);
    wait_until(&worker, raid["started_at"].as_u64().unwrap() + (45 + 8 * spots.len() as u64) * 1_000 + 1_000).await?;
    let (out, g_extract_wreck) = call(
        &contract,
        &vane,
        "extract",
        json!({ "raid_id": raid["raid_id"], "report": report(&spots, &[wreck], 0) }),
        0,
    )
    .await?;
    let got = &out["recovered"][0];
    assert_eq!(
        (got["serial"].as_str(), got["owner"].as_str(), got["state"].as_str()),
        (Some(gun.as_str()), Some(vane.id().as_str()), Some("held"))
    );
    assert_eq!(
        (got["owners"].as_u64(), got["recovered"].as_u64(), got["condition"].as_u64()),
        (Some(3), Some(1), Some(85))
    );
    let token = view(&contract, "nft_token", json!({ "token_id": gun })).await?;
    assert_eq!(token["owner_id"], vane.id().as_str());
    assert_eq!(view(&contract, "nft_supply_for_owner", json!({ "account_id": vane.id() })).await?, "1");
    assert_eq!(view(&contract, "nft_supply_for_owner", json!({ "account_id": marlowe.id() })).await?, "0");
    assert!(view(&contract, "wrecks", json!({})).await?.as_array().unwrap().is_empty());

    // ---- arrears, the Harbormaster, the export desk ----
    let owed = amount(&out["arrears"]);
    assert_eq!(owed, amount(&out["invoice"]) / 4);
    let (settled, g_settle) = call(&contract, &vane, "settle", json!({ "amount": "10" }), 0).await?;
    assert_eq!((amount(&settled["cleared"]), amount(&settled["arrears"])), (20, owed - 20));
    let villain = view(&contract, "harbormaster", json!({})).await?;
    assert_eq!((villain["balance"].as_str(), villain["posture"].as_str()), (Some("10"), Some("patrols")));
    let supply = amount(&view(&contract, "mt_supply", json!({ "token_id": "scrip" })).await?);
    let (exported, g_export) =
        call(&contract, &rook, "export", json!({ "token_id": "copper", "amount": "1" }), 0).await?;
    assert_eq!(exported["paid"], "25");
    // 25 new scrip, less what the Harbormaster's 10 has decayed by in the blocks between the two reads (at most 1).
    let rose = amount(&view(&contract, "mt_supply", json!({ "token_id": "scrip" })).await?) - supply;
    assert!(rose == 25 || rose == 24, "scrip supply rose by {rose}");
    let (sold, g_sell) = call(&contract, &moss, "export", json!({ "token_id": "core", "amount": "1" }), 0).await?;
    assert_eq!(sold["paid"], "100");

    // ---- NEP-171 transfer, and the pause ----
    let (_, g_transfer) =
        call(&contract, &vane, "nft_transfer", json!({ "receiver_id": rook.id(), "token_id": gun }), 1).await?;
    let weapon = view(&contract, "weapon", json!({ "serial": gun })).await?;
    assert_eq!((weapon["owner"].as_str(), weapon["owners"].as_u64()), (Some(rook.id().as_str()), Some(4)));
    call(&contract, &house, "pause", json!({}), 0).await?;
    assert!(refused(&contract, &rook, "start_raid", issue.clone(), 0).await?.contains("E_PAUSED"));
    assert_eq!(view(&contract, "paused", json!({})).await?, true);
    call(&contract, &house, "unpause", json!({}), 0).await?;

    // ---- every exported method: who may call it ----
    let listed: BTreeSet<String> =
        calls().iter().map(|c| c.0.to_string()).chain(views("x").iter().map(|v| v.0.to_string())).collect();
    let mut exported = wasm_exports(&wasm);
    // near-sdk's own two: the NEP-330 source metadata and the embedded ABI. Both are read-only.
    for own in ["contract_source_metadata", "__contract_abi"] {
        exported.remove(own);
    }
    assert_eq!(exported, listed, "the wasm exports exactly the methods this test checks");
    for (method, args, yocto, code) in calls() {
        let said = refused(&contract, &stranger, method, args, yocto).await?;
        assert!(said.contains(code), "{method} called by a stranger: expected {code}, got {said}");
    }
    for (method, args) in views(rook.id().as_str()) {
        view(&contract, method, args).await.map_err(|e| anyhow::anyhow!("view {method}: {e}"))?;
    }

    // ---- the gas of the views, read as transactions; the board grows by five item listings and a gun to price
    // one more of each ----
    let (_, g_listings_0) = call(&contract, &stranger, "listings", json!({}), 0).await?;
    for i in 0..5 {
        // VANE and MARLOWE hold what their raids brought out, whatever it was.
        let seller = if i % 2 == 0 { &vane } else { &marlowe };
        let held = view(&contract, "balances", json!({ "account_id": seller.id() })).await?;
        let token = held.as_object().unwrap().keys().find(|t| *t != "scrip").cloned();
        let Some(token) = token else { continue };
        call(&contract, seller, "list_item", json!({ "token_id": token, "amount": "1", "price": "40" }), 0).await?;
    }
    let (items, g_listings_items) = call(&contract, &stranger, "listings", json!({}), 0).await?;
    let item_count = items.as_array().unwrap().len() as u64;
    assert!(item_count >= 1, "someone had something to list");
    call(&contract, &rook, "list_weapon", json!({ "serial": gun, "price": "500" }), 0).await?;
    let (board, g_listings_gun) = call(&contract, &stranger, "listings", json!({}), 0).await?;
    assert_eq!(board.as_array().unwrap().len() as u64, item_count + 1);
    assert_eq!(board[0]["weapon"]["serial"], gun.as_str(), "newest first");
    let mut view_gas = Vec::new();
    for (method, args) in views(rook.id().as_str()) {
        let (_, g) = call(&contract, &stranger, method, args, 0).await?;
        view_gas.push((method, g));
    }
    view_gas.sort_by_key(|x| std::cmp::Reverse(x.1));

    println!("gas (the call's own receipt):");
    println!("  new {}, register {}", tgas(g_new), tgas(g_register));
    println!(
        "  start_raid {} (issue rifle), {} (own gun), {} (a wreck in the manifest)",
        tgas(g_start),
        tgas(g_start_gun),
        tgas(g_start_wreck)
    );
    println!(
        "  extract {} (cargo), {} (cargo and a recovered gun), die {}",
        tgas(g_extract),
        tgas(g_extract_wreck),
        tgas(g_die)
    );
    println!(
        "  build {}, list_weapon {}, buy_listing {}, nft_transfer {}",
        tgas(g_build),
        tgas(g_list),
        tgas(g_buy_listing),
        tgas(g_transfer)
    );
    println!("  settle {}, export {} (player), {} (vendor)", tgas(g_settle), tgas(g_export), tgas(g_sell));
    println!(
        "  views, dearest first: {}",
        view_gas.iter().take(8).map(|(m, g)| format!("{m} {}", tgas(*g))).collect::<Vec<_>>().join(", ")
    );
    println!(
        "  listings: {} empty, {} for each item listing, {} for a gun listing",
        tgas(g_listings_0),
        tgas((g_listings_items - g_listings_0) / item_count),
        tgas(g_listings_gun - g_listings_items)
    );
    println!("storage (bytes, paid by the contract account):");
    println!("  after new {s_genesis}, one player {s_player}, one open raid {s_raid}, one gun {s_gun}, one listing {s_listing}, one wreck {s_wreck} (the raid it replaces is deleted)");
    println!("  contract total {}", storage(&contract).await?);
    for g in [g_start, g_start_gun, g_start_wreck, g_extract, g_extract_wreck, g_die] {
        assert!(g < 30_000_000_000_000, "raid calls must fit the client's 30 Tgas");
    }
    for g in [g_build, g_list, g_buy_listing, g_settle, g_export, g_transfer] {
        assert!(g < 20_000_000_000_000, "other calls must fit the client's 20 Tgas");
    }
    Ok(())
}
