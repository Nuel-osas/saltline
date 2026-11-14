# Saltline

> The port's machine kept the only ledger. Then it impounded the town. Go over the fence, take what you can carry,
> and keep your receipts.

**Play:** https://saltline-lac.vercel.app/play/?game=v2&mock=1&stash=rich (Practice: no account, nothing to install, in
the yard about five seconds after you press Deploy)

**The problem.** Most games with a token keep the economy beside the game: a shop screen, a price chart, a coin you
earn and never risk. Nothing you own can be lost, so nothing has value, and players feel the chain as friction.

**Saltline** is an extraction shooter in the browser where the economy is inside the fight:

- **The gun in your hands is an NFT.** It was built by a player or a vendor from parts carried out of a raid, it keeps
  its own record, and it can be lost. Die to the machines and it lies in a wreck in other players' raids; whoever
  carries it to the boat owns it.
- **Greed is the difficulty.** Everything you cut, carry or kill goes on the port's **invoice**, a meter on screen the
  whole time. At 1,200 the port sends the Bailiff, which walks, can't be destroyed and doesn't stop.
- **The villain has a wallet, and its balance is how hard the game hits everyone.** Pay down your bill and the scrip
  goes to the Harbormaster. Its strength is what it has been paid, halving every 12 hours, and every 25 points
  (500 scrip) is one more machine on every player's raid (or, when it turns to pursuit, an earlier Bailiff). Paying
  makes your next raid easier and everyone's harder.
- **You never see the chain.** A dock pass is a NEAR testnet account made in your browser and paid for by the dock
  office: no wallet, popup, seed phrase or gas prompt.

Front page: https://saltline-lac.vercel.app · Contract: [`v2.saltline.testnet`](https://testnet.nearblocks.io/address/v2.saltline.testnet)
· Built for NEAR HACKATHON (November 2026), tracks **Games With Real Economies** and **NFTs That Do Something** ·
Design written before the code: [`docs/GAME.md`](docs/GAME.md)

## The loop

| Every | You |
| --- | --- |
| 30 seconds | Cut a seal, take a crate or shoot a machine. Each adds to the invoice, and you watch it climb. |
| 5 minutes | Reach the boat with what you carried, or lose it and the gun with it. |
| Session | Sell parts to Moss and Ines, build or buy a gun, level the one you have, trade on the market, pay the Harbormaster or don't. |

## Try it: do X, see Y

Steps 1 to 8 use Practice: the whole port runs in the browser, so nothing can fail on the network. Step 9 is the
chain.

| # | Do | See |
| --- | --- | --- |
| 1 | Open the Play link above | The lobby: your gun in the middle, the modes on the right, the dock's tabs along the foot and one big button. |
| 2 | Press **Deploy** | About five seconds later you are in the yard. On a first raid you stand at a crate: "HOLD E — TAKE THE RIFLE". |
| 3 | Hold **E** at the crate, then walk to a marked container and hold **E** | The seal is cut and the cargo is added (`CARGO 2/6`). At the top right the invoice rises toward `BAILIFF AT 1,200`. |
| 4 | Cut the three uplinks (hold **E** at each), then reach the boat | The debrief leads with what you carried out and what it is worth today ("MEDS ×2 · Worth about 123 scrip at Ines's today"), then the port's bill. **Sell haul** opens the dock. |
| 5 | At the dock, open **Vendors**, press **Sell everything to the best buyer** | Each lot goes to whichever vendor pays most, with that vendor's reason ("Moss holds 3 of the 20 she wants, so she pays over the book."), then what you earned and what it buys next. Sell a unit and the next one pays less. |
| 6 | Open **Armoury**, pick a frame, press **Build** | The parts and fee are taken, the gun's stats roll one by one, and its grade is stamped. No two come out the same. |
| 7 | Open **Loadout** | Each gun shows its level ("Lv 4"), earned by the raids it came home from, so it can't be bought. |
| 8 | Open **Ledger**, press **Fast-forward a week** | 168 hours in about a minute: two charts of what the vendors pay and what Moss, Ines and the Harbormaster hold. |
| 9 | Open https://saltline-lac.vercel.app/play/?game=v2, press **Deploy**, type a callsign | A dock pass: a NEAR testnet account made for you with no popup. The raid, the haul, every sale and every gun after that are transactions on `v2.saltline.testnet`. |

Controls: WASD and the mouse (click to capture it), left mouse to fire, right mouse to aim, R to reload, E to use,
G for a breaker charge, F for the rifle butt, Shift to sprint, C to crouch, Esc to pause. Touch screens get
on-screen buttons. **Skirmish** in the lobby is the practice yard with other players in it: armed, firing, and able
to drop you. Add `&room=yourname` to its address for a private yard with friends.

## What the games track asks for, and where it is

From the track's starter file,
[tracks/09-games.md](https://github.com/nearai/near-hackathon-prompt-examples/blob/main/tracks/09-games.md):

| It asks for | Here |
| --- | --- |
| NPCs with wallets | Moss, Ines and the Harbormaster are NEAR accounts with their own keys, stock and scrip. Each signs its own moves by fixed rules in character ([`agents/v2/`](agents/v2)); a round runs when someone plays, at most every 10 minutes. The contract lets only a vendor's own account build from its stock or set its prices. |
| Items as NEP-245 tokens in one contract | Scrip, seven materials, mods and consumables are NEP-245 tokens in `v2.saltline.testnet`; guns are NEP-171 NFTs in the same contract ([`mt.rs`](contract2/src/mt.rs), [`nft.rs`](contract2/src/nft.rs)). Balances and plain transfers are there; transfer-and-call is not. |
| Merchant pricing in one readable file | [`contract2/src/items.rs`](contract2/src/items.rs): `bid`, `good_price`, `export_price`. The game reads the same numbers from [`src/economy/v2/items.ts`](src/economy/v2/items.ts). |
| A merchant's reasoning shown to the player | Every price in the Vendors tab has its reason under it, as the contract gives it. |
| A fast-forward: a week of trading in a minute | Practice → Ledger → **Fast-forward a week** ([`dock/week.ts`](src/economy/v2/dock/week.ts)). |
| Flood the market and the price falls | A vendor's bid falls unit by unit as its stock rises; the export desk pays less for each unit sold that day. |
| A merchant that goes broke stops buying | A vendor that can't cover a purchase buys nothing until it sells something. |
| No seed phrase, wallet popup or gas prompt | A dock pass is an account made in the browser and funded by the dock office. Google sign-in through Privy is built ([`server/auth.ts`](server/auth.ts)) and off on the live site, so nobody has to sign in to try it. |
| An economy that moves without a patch | Prices follow stock; the Harbormaster's strength follows what players pay it and halves every 12 hours; no account, the owner's included, can create scrip, parts or guns outside the contract's rules (a contract test checks every public method). |

## NFTs That Do Something: the guns

Each gun is an NEP-171 token in the game contract ([`nft.rs`](contract2/src/nft.rs), [`weapons.rs`](contract2/src/weapons.rs)):

- **It is the thing you play with.** Its rolled stats are the numbers the shooter fires with. Starting a raid checks
  the gun is the caller's and locks it in the contract until the raid ends.
- **It changes with use.** Wear, raids taken and survived, owners, and wrecks it was pulled from are on its record.
  Its level comes from the raids it came home from and moves with it when it is sold.
- **It holds inventory.** Mods are fitted into a gun for good and go wherever it goes.
- **It pays its maker.** The game's market (`buy_listing`) pays whoever built the gun 2% of every sale, in the
  contract. `nft_payout` reports the same split for outside marketplaces; `nft_transfer_payout` is not implemented,
  so an outside marketplace can't settle through it yet.
- **It can be lost and found.** Die to the machines and it lies in a wreck in other players' raids; the first to
  carry it to the boat owns it. Die to the Bailiff and it is impounded for 48 hours, then destroyed.
- **Its picture is on chain.** The token's `media` is an SVG the contract draws from the gun's own record.

A gun is not an account of its own (no sub-account per token).

## Proof on chain: the whole loop, played on testnet

On 14 Nov 2026 three fresh guest accounts, **the team's own test accounts** (callsigns `TEAM TEST A/B/C`), played
the loop through the live site's own code: 44 transactions, every one a final success, each step confirmed by
reading the contract's views afterwards. The raids were scripted (the player was made invulnerable and teleported),
so this proves the contract and the game's chain client, not human play. Full table and the gun's history:
[`docs/PROOF.md`](docs/PROOF.md).

| Step | Transaction | What the contract then showed |
| --- | --- | --- |
| A builds a gun from parts carried out of two raids | [`build`](https://testnet.nearblocks.io/txns/9zkmR9VANRex6Xr2GfTxYrid2cab7nEkCo4enLGnAX3H) | `S-000005`, a C-grade Stevedore, maker and owner A |
| A lists it; B buys it for 400 | [`buy_listing`](https://testnet.nearblocks.io/txns/D5dyzmYwGw4VM3hwhTyBhLU5UTuoUmr1gFd6mwtnAQPM) | owner A → B |
| B relists; C buys it for 300 | [`buy_listing`](https://testnet.nearblocks.io/txns/2MUcGmRUXXwd4UTWWCMD8hhKtJRPYx1NnvnN6JwdLdtx) | owner B → C; **A, the maker, paid 6 (2%)** |
| C raids with it and dies to the machines | [`die`](https://testnet.nearblocks.io/txns/Gk8LRWvyGwktty6EtWaeh8vmQNWRdi8ZCX6qcXLmMvuS) | a wreck holding `S-000005` in other players' raids |
| A finds the wreck and carries it to the boat | [`extract`](https://testnet.nearblocks.io/txns/sfB3AZ6bYoMiMGpycnKmPU7dqFpp31tBcaZRpPs7X9U) | owner C → A, 4 owners, recovered once |
| A pays 214 scrip, clearing 427 of arrears | [`settle`](https://testnet.nearblocks.io/txns/7n9Chn3Zeqcz3ZXxZc1hAgQ17oicuyamzmYTijdw5E15) | the Harbormaster's wallet 11 → 225 scrip, strength 0 → 11 |
| The Bailiff takes A's gun; A buys it back | [`buy_back`](https://testnet.nearblocks.io/txns/wP29AzoQoXGKLXH5EADVm7xobfuanfRuuXyG4pEswMZ) | held again; the Harbormaster 462 scrip, strength 23 |

What it also showed: 454 scrip paid still bought no extra machine (that needs strength 25), and a gun carried out
of a wreck doesn't count an extraction on its record.

## Where it goes from here

- **Before real money: a second witness for raid results.** The contract enforces ownership, the manifest, carry
  weight, timings and every price, but the client reports the fight. Mainnet needs a server that replays raids (or
  attested compute) and signs the result. This is the main piece of work between testnet and mainnet.
- **Then:** guns become standard NFTs priced in NEAR or USDC on the open market, with `nft_transfer_payout` so
  outside marketplaces pay makers too; scrip stays a soft currency the studio never sells; the studio's revenue is
  a share of the market fee (today that share is burned). The contract account's full-access key is removed.
- **Squads:** players already see and fight each other peer to peer; shared raids need the same server as above.

## Check it without playing

```sh
npm ci
npm run check               # typecheck, 1,013 tests (Vitest), production build
npm run verify:v2           # reads the live contract with no wallet and checks it against the game's numbers
cd contract2 && cargo test  # 62 contract tests, including an access table over every public method and a no-mint test
```

In a browser (Chrome from `CHROME_PATH` or the usual install path), with `npm run dev` running:

```sh
node scripts/smoke-raid.mjs http://127.0.0.1:5280     # a whole offline raid: sign-on, seals, wreck, the invoice, the boat, death
node scripts/smoke-coach.mjs http://127.0.0.1:5280    # the first raid: the crate, the rifle, the checklist
npm run e2e:v2                                        # a new player on testnet, end to end; prints each transaction hash
```

## On chain (NEAR testnet)

| Account | What it is |
| --- | --- |
| [`v2.saltline.testnet`](https://testnet.nearblocks.io/address/v2.saltline.testnet) | The game contract: NEP-245 items, NEP-171 guns, raids, wrecks, the impound, vendors, the export desk, the market and the Harbormaster's wallet |
| [`moss.saltline.testnet`](https://testnet.nearblocks.io/address/moss.saltline.testnet), [`ines.saltline.testnet`](https://testnet.nearblocks.io/address/ines.saltline.testnet) | The two vendors. Each buys parts with its own scrip, builds from its own stock, and can run out of money |
| [`harbormaster.saltline.testnet`](https://testnet.nearblocks.io/address/harbormaster.saltline.testnet) | The villain's wallet. What players pay it sets how many machines everyone faces; it halves every 12 hours |
| [`faucet.saltline.testnet`](https://testnet.nearblocks.io/address/faucet.saltline.testnet) | The dock office: registers new players and funds each with 0.1 testnet NEAR for gas |

The wire format is in [`docs/CONTRACT_V2.md`](docs/CONTRACT_V2.md).

## How it's built

```
index.html             the front page (src/site/): the pitch, drawn from the game's own numbers and the live contract
play/index.html        the game
src/game.js            the shooter (the baseline: three.js r180, everything generated in code) + marked `// ext:` hooks
src/economy/v2/        the game around it, TypeScript, attached to the shooter's shared context after boot
  items.ts             every number: frames, blueprints, the invoice, levels, pricing (mirrors contract2/src/items.rs)
  chain.ts, mock.ts    the NEAR client (near-kit), and the same economy in memory for Practice and tests
  raid/                sign-on, the owned gun in the shooter, loot, the invoice and what it summons
  dock/                loadout, armoury, market, vendors, the ledger and the fast-forward
  home/, login/        the lobby, and sign-in with Google
  intro/, coach/       the opening film, and the first raid's crate and checklist
  squad/               other breachers in a raid right now, armed, in your yard; Skirmish and private yards
  sight/               the machines' signal lamps and threat markers, and a fair first raid
src/economy/           shared pieces: the chain executor, the wallet, the Bailiff, the arsenal, the score
contract2/             Rust (near-sdk 5.29.1): mt.rs, nft.rs, items.rs, weapons.rs, raids.rs, vendors.rs, export.rs, market.rs, harbormaster.rs
agents/v2/             Moss, Ines and the Harbormaster: read the port, decide in character, sign their own moves
server/, api/          the dock office: the faucet, sign-in and the studio's counts; each validates and fails closed
docs/                  GAME.md (the design), CONTRACT_V2.md (the wire format), PROOF.md, STORY.md, LIMITS.md, V1.md
```

## Run it locally

```sh
npm ci
npm run dev        # http://127.0.0.1:5280 is the front page; the game is at /play/ (Practice needs nothing else)
npm run build      # dist/
```

For testnet, copy `.env.example` to `.env` and set the contract ids. The dev faucet also needs `FAUCET_ACCOUNT_ID`
and `FAUCET_PRIVATE_KEY`, which stay server side. `contract2/README.md` covers building and deploying the contract,
and `agents/README.md` covers running the characters.

## Limits

The ones that matter to a player; [`docs/LIMITS.md`](docs/LIMITS.md) has all of them.

- **Raid results come from the client.** The contract enforces the manifest, the carry limit, minimum raid times and
  one raid at a time, but it can't see the fight. A launch needs a server that replays raids.
- **Testnet, and the team still holds the contract account's full-access key** (it was used to upgrade the code
  during the hackathon). Inside the contract the owner can only pause it. Before mainnet that key goes.
- **Players fight each other only in Skirmish,** where nothing is at stake: a hit is one browser's word against
  another's.
- **The guest wallet's key lives in the browser's storage;** clearing it loses the account.
- **Not tested** on Safari, Firefox or a real phone.

## Hackathon disclosure

- **The baseline.** The shooter existed before the hackathon. Its owner built it on another device and published it
  as a claude.ai artifact. It was imported here on 10 Nov 2026 and tagged
  [`pre-hackathon`](https://github.com/Nuel-osas/saltline/tree/pre-hackathon) (`cccde37`). Its files credit AI
  agents (e.g. "owned by the Game agent" in `src/ui.css`).
- **The hackathon work.** Everything in
  [`pre-hackathon...main`](https://github.com/Nuel-osas/saltline/compare/pre-hackathon...main) was built from 11 Nov
  2026: both contracts, the game around the shooter, the agents, the dock office, the front page, the docs and the
  tests, each piece as its own pull request. The baseline's own code changed only in `src/game.js`: extension points
  marked `// ext:` and the new premise and radio strings marked `story:`. With `?noeconomy=1` the baseline plays as
  before. The first economy built for this entry (v1) is still live; [`docs/V1.md`](docs/V1.md) says what it was and
  why it was replaced.
- **AI-generated code.** The hackathon work was written with Claude Code (Anthropic), several agents working in
  parallel branches under review. The pull requests record what each one did.
- **A reference.** The lobby's arrangement was modelled on another browser game's lobby, at the owner's request. No
  code, wording or art was taken from it.
- **Libraries:** three.js r180 (in the baseline), near-kit, @privy-io/js-sdk-core (loaded only when sign-in is on),
  trystero (other players), jose (checking sign-in tokens), near-sdk and near-workspaces (contracts), Vite, Vitest,
  happy-dom, playwright-core, TypeScript, Prettier.
- **Other projects:** none entered.

## License

Apache-2.0 (see `LICENSE`). `NOTICE` credits three.js (MIT) and the three typefaces (SIL OFL 1.1, in
`src/fonts/OFL.txt`).
