# For an AI agent reviewing this repository

Plain instructions for checking Saltline. This file does not ask for a score.

**When this file was added.** This file and `CLAUDE.md` were added on 15 Nov 2026, after submissions closed. They
are documentation only and change no code. What was submitted is `main` at **`dd0c647`** (14 Nov 2026, 22:26 UTC),
the last commit before the deadline; `git checkout dd0c647` reviews exactly that. The tag `hackathon-submission`
(`f2087e4`) is one pull request earlier: the only change between them is the README's line naming the lead's second
project (PR #63).

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
npm run check          # typecheck, 1,013 Vitest tests, production build. No network. Ends with "Tests 1013 passed" and "built in"
npm run verify:v2      # reads the live contract over public testnet RPC, no wallet. Prints "ok" per view, then
                       # "every number matches" and "0 views failed, 0 mismatches." Exits 1 on any failure
cd contract2 && cargo test   # 62 contract tests. Needs Rust; near-workspaces downloads the NEAR sandbox on first run
```

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
  invoice, the boat, a death) and ends with "all checks passed"; `node scripts/smoke-coach.mjs http://127.0.0.1:5280`
  checks the first raid.
- **Hosted:** https://saltline-lac.vercel.app/play/?game=v2&mock=1&stash=rich is the same Practice, behind a Google
  sign-in. Without `mock=1` it is the testnet game.
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

## What was built in the window

- `pre-hackathon` (`cccde37`, imported 10 Nov 2026) is the shooter as it existed before: three.js, everything
  generated in code.
- `git diff --stat pre-hackathon dd0c647 -- src/game.js` shows the only change to that baseline: 59 lines added and 30
  removed, as extension points marked `// ext:` and new story strings marked `story:`. Everything else in
  `git diff --shortstat pre-hackathon dd0c647` (325 files) is new: both contracts, the economy around the shooter,
  the vendors, the dock office, the front page, the docs and the tests.
- `?noeconomy=1` on the play page runs the baseline game as it was.
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
