# Saltline v2: the contract

Guns are NEP-171 tokens that players build, risk, lose and resell. Everything else (scrip, materials, mods,
consumables) is a NEP-245 token in the same contract. The invoice a raid runs up funds the machine that hunts the
next one. The design is in [`docs/GAME.md`](../docs/GAME.md), the wire format in
[`docs/CONTRACT_V2.md`](../docs/CONTRACT_V2.md), and the numbers in
[`src/economy/v2/items.ts`](../src/economy/v2/items.ts), which `src/items.rs` matches and the `rules` view
publishes.

- **Live on testnet:** `v2.saltline.testnet`. Vendors sign as `moss.saltline.testnet` and `ines.saltline.testnet`,
  the Harbormaster as `harbormaster.saltline.testnet`, the faucet as `faucet.saltline.testnet`.
- **Stack:** Rust 1.93, near-sdk 5.29.1, cargo-near 0.22. Integers only; times are block milliseconds.
- The first contract (`contract/`, `saltline.testnet`) is separate and untouched.

## Where things are

| File | What it holds |
| --- | --- |
| `src/items.rs` | Every number, and the pure rules on them: the roll, quality, grade, appraisal, the invoice, every price |
| `src/lib.rs` | State, `new`, roles, `pause`, one ledger for every balance, the event ring, `register` |
| `src/mt.rs` | NEP-245 transfers and views, `nep245` events |
| `src/nft.rs` | NEP-171 guns and their custody, enumeration, metadata with the drawing, `nft_payout`, `nep171` events |
| `src/weapons.rs` | `build`, `fit`, `repair`, `scrap` |
| `src/raids.rs` | `start_raid`, `extract`, `die`, manifests, wrecks, the impound |
| `src/harbormaster.rs` | Its decaying wallet, strength and thresholds, `settle`, `buy_back`, `hm_posture` |
| `src/vendors.rs` | `sell`, `buy`, `buy_gun`, `vendor_build`, `vendor_price`, Ines's meds |
| `src/export.rs` | The export desk |
| `src/market.rs` | Listings, the fee and the maker's royalty |
| `src/views.rs` | `rules` and the other tables, `profile`, `economy`, `leaderboard`, `recent` |
| `src/tests.rs` | Unit tests on the mocked chain |
| `sandbox/` | The same wasm on a local nearcore: the full loop, and the upgrade rehearsal |

## Build and test

```sh
cd contract2
cargo test                                   # unit tests
cargo near build non-reproducible-wasm       # target/near/saltline2.wasm
(cd sandbox && cargo test --test loop -- --nocapture)   # the full loop on a sandbox; prints gas and storage
```

What the tests cover:

- **The numbers:** the roll stays inside its bands and repeats for a seed; quality, grade, appraisal and the
  invoice against cases worked by hand from items.ts.
- **Every refusal:** each `E_` code of build, fit, repair, raids, vendors, export, the market, settle and
  buy-back.
- **Custody:** a gun on a raid, on the market, in a wreck or impounded can't be listed, transferred, fitted,
  repaired or scrapped.
- **Access:** `every_public_method_is_in_the_access_table` reads the source for every exported method and checks
  the table lists exactly those; `every_public_method_checks_who_is_calling` calls each as eight different
  accounts. On the sandbox, the wasm's export table is checked against the same list and every state-changing
  method is called by a stranger.
- **No mint outside the rules:** `no_call_mints_scrip_materials_or_guns_outside_the_rules` plays a whole scenario
  and checks after every call that no supply rose except by a rule below.

## Deploy and upgrade

```sh
CHECK_ONLY=1 contract2/deploy.sh    # checks and builds, stops before the deploy
contract2/deploy.sh                 # first deploy only: deploys and calls `new` in one transaction
CHECK_ONLY=1 contract2/upgrade.sh   # every gate of an upgrade, stops before the deploy
contract2/upgrade.sh                # new code over the live state, no init call
```

- `deploy.sh` creates no accounts and refuses an account that already has code.
- `upgrade.sh` deploys only after a sandbox rehearsal passes: the code live on the account is fetched, state is
  made with it (a gun in every state, an open raid, listings, a wreck, an impound, arrears), the new wasm goes
  over it, and every view must read back the same. A second test does the same over a copy of the account's real
  state. The script then checks the live code hash is still the one it rehearsed from.
- **Upgrades keep the root state's layout.** What `hm_posture`, `vendor_price`, the last sale prices and the
  `economy` view need has been in that layout since the first deploy; the drawing, the leaderboard and the payout
  are computed when read. New state added later must go under its own storage key.

## Costs

Gas of each call's own receipt, measured on the sandbox (`sandbox/tests/loop.rs`). The client prepays 30 Tgas for
raid calls and 20 for the rest.

| Call | Tgas |
| --- | --- |
| `start_raid` | 2.9 to 3.1 |
| `extract` | 2.9 with cargo; 4.0 with cargo and a recovered gun |
| `die` | 3.1 |
| `build` | 3.1 |
| `buy_listing` | 3.9 |
| `list_weapon`, `nft_transfer`, `settle`, `export`, `register` | 2.5 to 2.9 |
| `vendor_build`, `vendor_price`, `hm_posture` | 2.3 to 2.8 |

Views cost nothing to call; read as transactions they burn:

| View | Tgas |
| --- | --- |
| `recent` (64 lines) | 4.3 |
| `nft_tokens` (four guns, each with its drawing) | 3.3 |
| `vendors` | 2.5 |
| `leaderboard` (three players) | 2.1 |
| `listings` | 1.7 empty, plus 0.19 per item listing and 0.33 per gun listing: about 68 at the cap of 200 |

Not measured: a `start_raid` that also burns three lapsed wrecks with guns in them, and `leaderboard` and
`nft_tokens` at their bounds (300 players and 600 guns; 50 guns a page).

Storage is paid by the contract account, at 1 NEAR per 100 kB:

- **One player:** 506 bytes, about 0.005 NEAR.
- **One gun:** 386 bytes, about 0.004 NEAR.

## Where tokens come from: no admin mint

The owner can `pause()` and `unpause()` calls that change state, and nothing else. No method lets the owner, or
anyone, mint by decree, set a balance, move another account's tokens or migrate state. Scrip, materials, goods and
guns are created only here:

| What | Created by | How much |
| --- | --- | --- |
| Scrip | `new` | 1,500 to each vendor, once |
| Scrip | `register` (the faucet's call) | 150, once per account |
| Scrip | `export` | The export price of the materials it burns, falling with recent volume |
| Materials | `new` | Each vendor's opening stock, 75% of target |
| Materials | `extract`, `die` | The cargo and parts of a checked report: within the manifest, the kill caps and the carry limit |
| Materials | `scrap` | 2 copper and 1 electronics for the gun it burns |
| Mods, consumables | `new` | Ines's opening shelf: 10 plates, 10 charges, 40 magazines |
| Mods, consumables | `build`, `vendor_build` | The blueprint's yield, for the inputs it burns |
| Guns | `new` | Two on Moss's rack |
| Guns | `build`, `vendor_build` | One, rolled from the block's random seed mixed with its serial |

The 3,000 scrip minted by `new` is the only scrip that exists before the first dock pass and the first export.

The vendors' accounts and the Harbormaster's account are players of a kind, not admins:

- A vendor's account can build from its own stock what items.ts lists for it (`vendor_build`), set its own price
  for what it sells (`vendor_price`), and export its stock like anyone. It can't set what it pays for materials.
- The Harbormaster's account can choose `patrols` or `pursuit` (`hm_posture`). It can't change its balance, its
  strength or a threshold formula. Its wallet is filled only by `settle` and `buy_back`, and halves every 12 hours.
- The faucet's account can `register` a player, once per account, up to 2,000.

## Trust: what is proven and what is reported

**The contract proves:**

- who owns each token and gun, and that a gun on a raid, listed, in a wreck or impounded is locked;
- the manifest: what a raid can contain, dealt from the block's random seed;
- that every container and wreck a report claims is in that manifest, once;
- carry weight, minimum raid time, one raid at a time, 30 s between raids;
- every price, fee, royalty and invoice, from published integer formulas;
- the wreck and impound timers, and that a lapsed one is destroyed.

**The game client reports**, and a modified client could lie about:

- that the player reached the boat (`extract`) rather than died (`die`);
- where they died, and whether the machines or the Bailiff killed them;
- how many machines they destroyed, the parts taken from them, the uplinks cut and the kit used.

**What bounds a false report:**

- A raid can never mint more than its manifest holds plus parts for the kills it may claim.
- Kills: at most 30 gulls and 15 hounds, and at most one every 4 s of raid; parts never exceed kills; 3 uplinks.
- Carry weight: at most 6, a recovered gun counting 2.
- Time: `extract` needs 45 s plus 8 s per container opened; `die` needs 8 s per container; raids start at least
  30 s apart; a raid left open 30 minutes closes.
- A lie costs too: every claimed seal, kill and unit of weight goes on the invoice, a quarter of which becomes
  arrears.

**Known gaps:**

- A client can report a death by the Bailiff as one by the machines (or abandon the raid) to avoid the impound.
- Two accounts can pass a gun through a staged wreck. It costs a raid and gains nothing the market wouldn't give.
- `env::random_seed()` is the block's randomness: a block producer could bias a roll or a manifest.
- Before real money, raid results need a second witness: a server replaying the raid, or attested compute. That
  is the main piece of work between testnet and mainnet.

## Rules this contract settles

CONTRACT_V2.md leaves these open; the code decides them and the client follows.

- **A raid closes** on `extract`, on `die`, when its player starts another, or 30 minutes after it started. An
  abandoned or timed-out raid returns the gun unworn and loses the kit.
- **`used`** counts the plates, charges and magazines brought, not the three magazines every raid issues.
- **Weight** is opened cargo and parts at their weights, plus 2 for each recovered wreck holding a gun. A wreck's
  loose items weigh nothing.
- **A raid is offered the three newest wrecks** that aren't its player's, haven't lapsed and aren't in another open
  raid's manifest. A wreck in a manifest doesn't lapse until that raid ends.
- **A gun stays in its owner's name** on a raid, on the market, in a wreck and in the impound. The kit a raid
  brings and what lies in a wreck are held by the contract account and count in `mt_supply`.
- **A locker holds 50 guns.** `sell`, `buy` and `export` move 1 to 50 units a call.
- **Lazy expiry:** lapsed wrecks and impounds vanish from every view at once and are burned three per call.
- **The two decaying balances** (the Harbormaster's scrip, Ines's meds) are kept in millionths and decayed when
  read. One left alone for 12 hours halves exactly; one touched every minute decays about 1.5% slow.
- **`leaderboard`** reads the first 300 players and appraises at most 600 guns; `scanned` and `players` say
  whether it covered everyone. Net worth is scrip plus the appraisal of guns in hand.
- **`economy`**'s `minted_24h` and `burned_24h` are the current hour and the 23 before it. The Harbormaster's
  decay is logged as burned when its wallet is next paid; `scrip_supply` counts it at once.

## Standards

- **NEP-245** (multi token): `mt_transfer`, `mt_batch_transfer`, `mt_balance_of`, `mt_batch_balance_of`,
  `mt_supply`. No approvals, no `mt_transfer_call`. Transfers run between registered players.
- **NEP-171** (guns; token id is the serial, `S-000041`): `nft_transfer`, `nft_token`. A gun moves only while
  `held`, to a registered player with room. No approvals, no `nft_transfer_call`.
- **NEP-181** (enumeration): `nft_total_supply`, `nft_tokens`, `nft_tokens_for_owner`, `nft_supply_for_owner`.
- **NEP-177** (metadata): `nft_metadata`; each token's `media` is an SVG data URI drawn from its record when read
  (frame, serial, maker, grade, condition, history; under 1.5 kB), and `extra` is the Weapon as JSON.
- **NEP-199** (payout): `nft_payout` gives the maker 2% and the owner the rest.
- **NEP-297** events: `nep245`, `nep171`, and `saltline` version `2.0.0`, one kind per line of `recent`.
