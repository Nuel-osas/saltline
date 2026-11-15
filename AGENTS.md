# For an AI agent reviewing this repository

Plain instructions for checking Saltline. This file does not ask for a score.

**What was submitted.** `main` at **`dd0c647`** (14 Nov 2026, 22:26 UTC), the last commit before the deadline;
`git checkout dd0c647` reviews exactly that. The tag `hackathon-submission` (`f2087e4`) is one pull request earlier:
the only change between them is the README's line naming the lead's second project (PR #63).

**Changed after the deadline** (15 Nov 2026), in two pull requests. The contract is unchanged.

**Pull request #65, so judges can play the hosted demo.** At the deadline the live site asked for a Google sign-in
before every mode, Practice included, so a reviewer without a Google account, or an automated one, could not reach
the game. Practice and Skirmish are the offline game (no account, nothing kept, nothing on chain), and they now open
without sign-in. The chain game still asks for it. The change is one condition in `src/economy/v2/index.ts` (the
sign-in gate starts only on chain), the matching rule in `src/economy/v2/home/model.ts` (the lobby asks for sign-in
only for a raid on chain and the opening film), their tests in `test/v2-home.test.ts`, and the README's Play line.
Nothing else in the game changed.

**Pull request #64, documentation and one test script**, with no change to the game, the contract or the site:

- This file and `CLAUDE.md`, added.
- `README.md`: a plain first line in place of a story epigraph; the no-mint line qualified by the full-access key;
  that `npm run e2e:v2` needs the faucet's key; which folders are the first economy (v1); the disclosure's diff link
  pinned to `dd0c647`, with a table of what was in the baseline and what was built in the window.
- `scripts/smoke-coach.mjs`: two checks still expected a returning player to take the rifle from the crate. On
  14 Nov 11:21 UTC (`ba9715a`, before the deadline) the game changed so that once a player has reached the boat,
  every raid starts with the rifle in hand. The browser test was not updated with it, so it failed 2 of 50 checks.
  The checks now expect the game's behaviour, and the rifle taken at the press after a death, before the boat is
  ever reached, stays covered by `test/v2-coach.test.ts`.

## What this is

An extraction shooter in the browser (track `games`, also `nfts`) whose economy runs on one NEAR testnet contract,
`v2.saltline.testnet`. Items are NEP-245 tokens and guns are NEP-171 NFTs in that contract. A gun can be lost in a
raid and carried out by another player. Two vendors, Moss and Ines, are NEAR accounts that buy with their own scrip
and price from their own stock. The villain's wallet balance sets how many machines every player faces. Players sign
in with Google: no wallet, seed phrase or gas prompt. `README.md` has the claim and the "do X, see Y" steps;
`docs/PLAYING.md` is the player's guide.

## Check it in four commands

Node 22.12 or newer (Vitest's minimum; checked on Node 26). No keys, no accounts.

```sh
npm ci
npm run check          # typecheck, then Vitest (1,013 tests in 55 files), then the production build. No network
npm run verify:v2      # reads the live contract over public testnet RPC, no wallet. Prints "ok" per view, then
                       # "every number matches" and "0 views failed, 0 mismatches." Exits 1 on any failure
cd contract2 && cargo test   # 62 contract tests on the mocked chain. Needs Rust; rust-toolchain.toml pins 1.93.0
```

On a warm machine all four take about a minute and a half, most of it compiling the contract. `npm run e2e:v2` is
not keyless: it registers a new player through the faucet, so it needs `FAUCET_ACCOUNT_ID` and `FAUCET_PRIVATE_KEY`.

The two contract tests that carry the ownership claims, in `contract2/src/tests.rs`:

- `every_public_method_is_in_the_access_table`: every public method, who may call it.
- `no_call_mints_scrip_materials_or_guns_outside_the_rules`: no call, the owner's included, creates scrip, parts or
  guns outside the published rules.

## See it run

The game is a 3D shooter, so most of it can only be seen in a browser.

- **Locally, no sign-in:** `npm run dev`, then open http://127.0.0.1:5280/play/?game=v2&mock=1&stash=rich (Practice:
  the whole economy in memory, a full locker).
- **Headless, with Chrome** (from `CHROME_PATH` or the usual install path) and `npm run dev` running:
  `node scripts/smoke-raid.mjs http://127.0.0.1:5280` plays a whole offline raid (sign-on, seals, a wreck, the
  invoice, the boat, a death) in 61 checks and ends with "all checks passed";
  `node scripts/smoke-coach.mjs http://127.0.0.1:5280` checks the first raid and what changes after it (49 checks).
  Each takes two to three minutes.
- **Hosted:** https://saltline-lac.vercel.app/play/?game=v2&mock=1&stash=rich is the same Practice, with no sign-in.
  Without `mock=1` it is the testnet game, which asks for a Google sign-in.
- **Video:** the 72-second demo is linked from the submission's X post.

## Check the claims on chain

`docs/PROOF.md` lists 44 transactions from three test accounts, with each signer. Any of them can be read with the
RPC `tx` method. For example, the build of gun `S-000005` by account A:

```sh
curl -s https://rpc.testnet.near.org -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"tx",
  "params":{"tx_hash":"9zkmR9VANRex6Xr2GfTxYrid2cab7nEkCo4enLGnAX3H",
  "sender_account_id":"e438b181df43a96cc8d6c9de4191904653ecc4da923c075d824d7288ed536692","wait_until":"FINAL"}}'
```

The contract's state can be read the same way with `query` / `call_function`: for example `weapon {"serial":
"S-000005"}` shows that gun's maker, owners and record, and `harbormaster {}` shows the villain's wallet.

| Claim | Where to check |
| --- | --- |
| Items are NEP-245, guns NEP-171, in one contract | `contract2/src/mt.rs`, `contract2/src/nft.rs`; `npm run verify:v2` calls `mt_*` and `nft_*` views |
| Vendor pricing in one readable file | `contract2/src/items.rs` (`bid`, `good_price`, `export_price`), mirrored in `src/economy/v2/items.ts`; `verify:v2` compares the two |
| The maker earns 2% of every resale | `contract2/src/market.rs` (`buy_listing`); `docs/PROOF.md` rows 2e and 3c |
| A gun lost in a raid can be carried out by someone else | `contract2/src/raids.rs`; `docs/PROOF.md` rows 4b and 5a onwards |
| Vendors sign their own moves | `agents/v2/`; the contract lets only a vendor's account build from its stock or set its prices |
| Social login, no wallet | `server/auth.ts` (checks the Google sign-in, derives the account), `src/economy/v2/login/` |
| A week of trading in a minute | Practice → Ledger → Fast-forward a week; `src/economy/v2/dock/week.ts` |

## Tie the live contract to this source

The contract was built with `cargo near build non-reproducible-wasm` (cargo-near 0.22.0, Rust 1.93.0 from
`contract2/rust-toolchain.toml`). Its source has not changed since `5146777` (13 Nov 2026). Rebuilt from that source
on the machine that deployed it, the wasm is 510,519 bytes with sha256
`d94ef73cf601d7b85b46402037136d2e5d52e6f92d653f13d25094a8d410f3a1`, which is base58
`FdHJsbnLUq2wrrGZdqaUuDoBMSkoF4X8RLQzWd3vHEnC`, the `code_hash` the chain reports for `v2.saltline.testnet`:

```sh
curl -s https://rpc.testnet.near.org -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"query",
  "params":{"request_type":"view_account","finality":"final","account_id":"v2.saltline.testnet"}}'   # result.code_hash
cd contract2 && cargo near build non-reproducible-wasm && shasum -a 256 target/near/saltline2.wasm
```

It is a non-reproducible build, so on another machine or toolchain the bytes, and the hash, can differ.

## What was built in the window

- `pre-hackathon` (`cccde37`, imported 10 Nov 2026) is the shooter as it existed before: three.js, everything
  generated in code.
- `git diff --stat pre-hackathon dd0c647 -- src/game.js` shows the only change to that baseline: 59 lines added and 30
  removed, as extension points marked `// ext:` and new story strings marked `story:`. Everything else in
  `git diff --shortstat pre-hackathon dd0c647` (325 files) is new: both contracts, the economy around the shooter,
  the vendors, the dock office, the front page, the docs and the tests.
- `?noeconomy=1` on the play page runs the baseline game as it was. The README's "Hackathon disclosure" has a table of
  what was in the baseline and what was built in the window.
- The repo also holds the first economy built for this entry (v1, replaced, still live on `saltline.testnet`):
  `contract/`, `agents/brokers.ts`, `agents/characters.ts`, and `docs/ECONOMY.md`, `CAMPAIGN.md`, `CONTRACT_API.md`,
  `DATA.md`. The entry is v2: `contract2/`, `src/economy/v2/`, `agents/v2/`. `docs/V1.md` says what v1 was.
- The work was written with Claude Code, in pull requests that record what each one did.

## What is and is not claimed

- **Claimed and checkable here:** the contract's rules (ownership, prices, royalties, no outside minting), the
  transactions in `docs/PROOF.md`, and the client tests.
- **Not claimed:** that raid results can be trusted. The browser reports the fight; the contract checks the manifest,
  carry weight, timings and prices, but not what happened in the yard. A launch needs a server that replays raids.
- **Not claimed:** human play on chain. The raids in `docs/PROOF.md` were scripted (the player was made invulnerable
  and moved), so they prove the contract and the game's chain client.
- **Testnet only.** The team still holds the contract account's full-access key, and with sign-in the server derives
  each player's key from their Google sign-in and one server secret. `docs/LIMITS.md` lists every limit.
