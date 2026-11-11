# Saltline economy contract

Saltline's salvage economy on NEAR: every item is a NEP-245 token in one contract, the dockside brokers are NPC accounts
with their own balances, and every price comes from one readable file, [`src/pricing.rs`](src/pricing.rs).
The design is in [`docs/ECONOMY.md`](../docs/ECONOMY.md); the wire format is in
[`docs/CONTRACT_API.md`](../docs/CONTRACT_API.md).

| File | What it holds |
| --- | --- |
| `src/lib.rs` | State, `new`, roles (owner, faucet, brokers), the internal ledger, dividends, the event ring, registration |
| `src/mt.rs` | NEP-245 core (`mt_transfer`, `mt_batch_transfer`, `mt_balance_of`, `mt_batch_balance_of`, `mt_supply`) and `nep245` events |
| `src/items.rs` | The item table, run rules, bounds and loot table (data only; `src/economy/items.ts` mirrors it) |
| `src/pricing.rs` | **The pricing rules**: bids, asks, batch pricing, decay, closing and reopening, dividend split |
| `src/policy.rs` | The default broker policy, shown by `advice` and run by `simulate` |
| `src/runs.rs` | `start_run`, `extract`, `die`, manifests, wrecks, the wreck split |
| `src/market.rs` | `sell`, `buy`, `invest`, listings, `broker_export`, `broker_stance`, the `brokers` board, `leaderboard`, `advice` |
| `src/sim.rs` | `simulate`: a week of the market, fast-forwarded in a view |
| `src/town.rs` | The town's arc (docs/STORY.md): deliveries, districts, acts, the reveal and the Harbormaster's strength, under its own storage key |
| `src/tests.rs` | Unit tests on the mocked chain |
| `sandbox/` | One full loop, and the upgrade rehearsal, on a local nearcore sandbox (a separate crate, so `cargo test` stays light) |
| `upgrade.sh` | Deploys new code to saltline.testnet without an init call, after every gate passes (see Upgrading) |

## Build, test, deploy

Toolchain: Rust 1.93.0 (pinned in `rust-toolchain.toml`, as `cargo near new` pins it), cargo-near 0.22.0, near-sdk 5.29.1
(5.30.1 needs rustc 1.95), near-cli-rs 0.30.1.

```sh
cd contract
cargo test                                   # unit tests
cargo near build non-reproducible-wasm       # → target/near/saltline.wasm
(cd sandbox && cargo test -- --nocapture)    # deploys that wasm to a local sandbox and plays a loop
./deploy.sh                                  # testnet: sub-accounts, deploy, new (see below)
```

`cargo test print_a_simulated_week -- --ignored --nocapture` prints a simulated week, six hours a line.

## Where CONTRACT_API.md leaves room

How the contract reads the API, for anyone writing a client against it:

- **`E_FULL`** is an extra error code: 500 profiles or 100 listings. The other codes are as listed.
- **Unknown names** are refused with the nearest code:
  - an unknown broker: `E_NOT_BROKER`;
  - an unknown token: `E_DOESNT_BUY` in `sell`, `E_DOESNT_SELL` in `buy`, `E_NO_GEAR` in `start_run`, `E_FUNDS` in
    `list` and `mt_transfer`, `E_EXPORT_STOCK` in `broker_export`.
- **Optional fields** (`T?`) are sent as `null`, never left out.
- **`simulate`** returns `hours + 1` points. Hour 0 is the market now, and point h is the end of hour h's trading.
  Each point also carries `act`: the simulated traders' sales count as deliveries to a copy of the town.
- **`town`:**
  - `delivered` lists all five cargo, zeros included.
  - A district, act or reveal is announced once, by the sale that causes it: a `district` or `act` event and a
    `recent` line, with the seller as `account` and `callsign`.
  - The Act II line is "The town across the water is lit again." STORY.md gives the others but not that one.
  - Cores sold in the sale that causes the reveal count towards the reveal but don't feed the Harbormaster; the
    ones sold after it do.
- **`invest`** returns the caller's total shares in that broker after the call (one share per scrip ever invested).
- **`broker_export`:** `earned` is what the broker kept, `dividend` is what went to its shareholders, and the gross is
  their sum.
- **Dividends** accrue without a transaction:
  - `balances` and `mt_balance_of` include them in `scrip`, because they are spendable;
  - they are minted (an `mt_mint` with memo `dividend`) at the holder's next call;
  - `mt_supply` counts minted tokens only.
- **`recent(limit)`** returns at most 64 events. Events carry no tx hash: a contract can't read its own.
- **`saltline` events** are NEP-297 `{ standard: "saltline", version: "1.0.0", event, data: [{ …, account, text }] }`.
- **NEP-245:** `mt_transfer_call` and approvals are not implemented; passing an approval is refused. Transfers go
  between registered players only.
- **Runs:**
  - the 30 s gap between runs is measured start to start;
  - a run times out after 30 minutes;
  - a recovered wreck's whole weight counts towards the carry limit;
  - dying with a recovered wreck folds it into the new one.
- **The closing rule and the wreck split** follow the lead's rulings of 11 Nov 2026. See `pricing::should_close` and
  `runs::wreck_split`.

## Trust model, stated plainly

- **Run results come from the client.** The contract can't see the fight. It checks what it can:
  - the run is the caller's, open, and under 30 minutes old;
  - every container and wreck claimed is in that run's manifest, claimed once;
  - the total weight is within the carry limit (6);
  - the run lasted at least 45 s + 8 s per container opened to extract, and 8 s per container to die;
  - runs start at most every 30 s.

  A modified client can still claim the best legal haul from every manifest it is dealt. A launch would need a server
  that checks runs; this hackathon build does not have one.
- **Loot comes from `env::random_seed()`** at `start_run`, mixed with the run id and the account. Validators could
  in principle bias it; for cargo worth a few scrip that is an accepted risk.
- **Registration is the faucet's job.** Only `faucet.<contract>` can call `register`, once per account, up to 500
  profiles. The faucet server rate-limits by account and IP; if its key leaked, an attacker could fill the 500 passes.
- **Brokers sign their own calls** (`broker_export`, `broker_stance`) with their own keys, held by the agent runner.
  The contract bounds what they can do: exports at most hourly per item and never more than they hold, stance 80–120.
- **Nobody can change prices** without redeploying the contract: there is no owner override of any rule.
- The contract account holds a full-access key (it deployed itself). Redeploying is visible on chain.

## Numbers

Measured on 11 Nov 2026. Gas is the function call's own receipt, from `sandbox/` on nearcore 2.13.4.

| What | Value | How |
| --- | --- | --- |
| Release wasm | 356,979 bytes (≈ 3.6 NEAR of storage on the contract account); 347,580 before the story | `cargo near build non-reproducible-wasm` |
| `simulate` 168 h × 30 traders | **109.2–110.8 Tgas** over seeds 7, 42, 1 and 2026 (101.2–102.9 before it tracked the act) | sandbox, called as a transaction |
| `register`, `start_run`, `extract`, `sell`, `broker_export` | 2.2, 2.4, 2.5, 2.5, 2.1 Tgas | sandbox |
| `sell` that lights both districts and reveals the client at once (four events) | 3.4 Tgas | sandbox `upgrade.rs`, from a patched town |
| `brokers`, `leaderboard` (1 player), `town` | 1.7, 1.5, 1.6 Tgas | sandbox |
| The town's state | 187–211 bytes under the key `town` (more once districts are lit) | `Town`'s Borsh size |
| Storage per player | 502 bytes (27-character account) to 596 bytes (64-character implicit account, 16-character callsign) | sandbox `storage_usage` delta; unit test `storage_per_player_is_measured` |
| Storage per open run | 196–255 bytes, freed when the run closes | the same |

**The view gas limit:**
- An RPC node's `max_gas_burnt_view` defaults to the protocol's `max_gas_burnt`. That is 1 PGas on testnet at
  protocol 88, as read from `EXPERIMENTAL_protocol_config`. `client_config` shows no override on
  rpc.testnet.near.org or test.rpc.fastnear.com.
- `simulate` was sized to stay under 300 Tgas, so it also works on RPCs that set the older 300 Tgas override.
- At about 110 Tgas, a full week fits with more than twice that to spare. Neither the hours nor the traders had to
  be cut.

**What storage costs the contract account:**

| | Cost |
| --- | --- |
| A player | about 0.006 NEAR |
| Its open run, while open | about 0.0025 NEAR |
| 500 players with a run each (≈ 425 KB) | ≈ 4.3 NEAR |
| 100 listings, 24 wrecks and the 64-event ticker (≈ 45 KB, estimated from their Borsh sizes) | ≈ 0.5 NEAR |
| The code (356,979 bytes) | ≈ 3.6 NEAR |

At its bounds, the contract needs about 8.4 NEAR of storage.

Not measured: `leaderboard` and `brokers` with 500 players. Each reads at most 500 profiles; estimated from
NEAR's storage-read costs, that is about 30–40 Tgas.

## Testnet

`saltline.testnet` exists, with its full-access key in `~/.near-credentials/testnet/saltline.testnet.json`. The
contract is deployed there and holds live players, so new code goes out with `./upgrade.sh` (below), never
`./deploy.sh` again: `new` would refuse to run over existing state anyway.

```sh
cd contract
./deploy.sh          # faucet (12 NEAR), moss, ines, qm (1.5 NEAR each); build; deploy; new(...)
./testnet-loop.sh    # pilot-1 (1 NEAR): register → start_run → wait → extract → sell → simulate → broker_export
```

What `deploy.sh` runs, verified against near-cli-rs 0.30.1's `--help`:

```sh
near account create-account fund-myself faucet.saltline.testnet '12 NEAR' autogenerate-new-keypair \
  save-to-legacy-keychain sign-as saltline.testnet network-config testnet sign-with-legacy-keychain send
#   … the same for moss., ines. and qm. with '1.5 NEAR'
cargo near build non-reproducible-wasm
near contract deploy saltline.testnet use-file target/near/saltline.wasm with-init-call new \
  json-args '{"owner_id":"saltline.testnet","faucet_id":"faucet.saltline.testnet","brokers":{"moss":"moss.saltline.testnet","ines":"ines.saltline.testnet","qm":"qm.saltline.testnet"}}' \
  prepaid-gas '100.0 Tgas' attached-deposit '0 NEAR' network-config testnet sign-with-legacy-keychain send
```

**Afterwards:**
- About 12.5 NEAR stays on `saltline.testnet`, of which about 3.5 NEAR is locked by the code. The rest covers
  storage up to the bounds above.
- New keys go to `~/.near-credentials/testnet/` only. The broker agents and the faucet server read them from `.env`.
- Redeploying code with a different state layout needs a migration or a fresh account. There is no migration code.

## Upgrading

The contract on saltline.testnet holds players, so new code goes out as a code deploy with **no init call** and no
migration. That works only while the root struct `Saltline` keeps its Borsh layout. New state goes under its own
storage key instead, as the town does (`town`, see `src/town.rs`).

```sh
cd contract
CHECK_ONLY=1 ./upgrade.sh   # every gate below, then stop
./upgrade.sh                # every gate, then the deploy
```

`upgrade.sh` deploys only if all of these pass, in order:
1. `cargo test`.
2. `cargo near build non-reproducible-wasm`.
3. `sandbox/fetch-live.sh`, which downloads the code live on saltline.testnet to `sandbox/res/` (gitignored).
4. `sandbox/tests/upgrade.rs`, the rehearsal. It upgrades the live code to the new wasm twice, over fresh state made
   by the old code and over a copy of saltline.testnet's real state, and checks every view reads back the same and
   `town` starts at Act I.
5. The wasm hasn't changed since the rehearsal, and saltline.testnet still runs the code the rehearsal upgraded
   from.

Then it runs the deploy and reads back the code hash, `town` and `rules`:

```sh
near contract deploy saltline.testnet use-file target/near/saltline.wasm without-init-call \
  network-config testnet sign-with-legacy-keychain send
```

To run the rehearsal alone: `(cd sandbox && ./fetch-live.sh && cargo test --test upgrade -- --nocapture
--test-threads=1)`, after building the wasm. It needs the testnet RPC. A changed root layout fails it with
"Cannot deserialize the contract state". That was checked on 11 Nov 2026 by adding a field and reverting it.
