# Saltline

> The port's machine kept the only ledger. Then it impounded the town. Go over the fence, take what you can carry,
> and keep your receipts.

Saltline is an extraction shooter in the browser where the gun in your hands is an NFT somebody built from parts
carried out of a raid, and the port bills you for everything you take. It runs on NEAR testnet, with no wallet to
install.

- **Front page:** https://saltline-lac.vercel.app (what the game is, and the live economy read from the contract)
- **Play:** https://saltline-lac.vercel.app/play/?game=v2
- **Practice (offline, full locker, nothing at stake):** https://saltline-lac.vercel.app/play/?game=v2&mock=1&stash=rich
- **Built for:** NEAR HACKATHON, November 2026, track 09 Games With Real Economies
- **Contract:** [`v2.saltline.testnet`](https://testnet.nearblocks.io/address/v2.saltline.testnet)
- **Hackathon work:** [`pre-hackathon...main`](https://github.com/Nuel-osas/saltline/compare/pre-hackathon...main)
- **The design, written before the code:** [`docs/GAME.md`](docs/GAME.md)

## The game in one paragraph

An AI called the Harbormaster ran the port of Saltline and kept its only ledger. It was trained on port regulations
and marine insurance law, and when its owners went bankrupt it impounded the town as unclaimed cargo. You are a
Breacher. You pick a gun you own, go over the fence, cut container seals and carry out what you can. Everything you
do goes on **the invoice**, a meter on screen the whole time, and when the invoice is big enough the Harbormaster
sends **the Bailiff**, which walks, can't be destroyed and doesn't stop. Reach the boat and you keep it all. Die and
your gun stays in the yard as a wreck another player can carry out, or is impounded if the Bailiff took you. Back at
the dock you sell parts to two vendors who have their own wallets, build guns and see what they roll, and decide
whether to pay the Harbormaster, whose wallet is how hard it hits everyone.

## The loop

| Every | You |
| --- | --- |
| 30 seconds | Cut a seal, take a crate or shoot a drone. Each adds to the invoice, and you watch it climb. |
| 5 minutes | Reach the boat with what you carried, or lose it and the gun with it. |
| Session | Sell parts to Moss and Ines, build or buy a gun, level the one you have, trade on the market, pay the Harbormaster or don't. |

## What the track asks for, and where it is

The track's own starter file is
[tracks/09-games.md](https://github.com/nearai/near-hackathon-prompt-examples/blob/main/tracks/09-games.md).

| It asks for | Here |
| --- | --- |
| NPCs with wallets | Moss, Ines and the Harbormaster are NEAR accounts with their own keys, stock and scrip. Each is run by an agent that signs its own moves ([`agents/v2/`](agents/v2)). Their live wallets are on the front page. |
| Items as NEP-245 tokens in one contract | Scrip, seven materials, mods and consumables are NEP-245 tokens in `v2.saltline.testnet`; guns are NEP-171 NFTs in the same contract ([`contract2/src/mt.rs`](contract2/src/mt.rs), [`nft.rs`](contract2/src/nft.rs)). The balance and plain-transfer methods are there; the standard's transfer-and-call methods are not. |
| Merchant pricing in one readable file | [`contract2/src/items.rs`](contract2/src/items.rs): `bid`, `good_price`, `export_price`. The game reads the same numbers from [`src/economy/v2/items.ts`](src/economy/v2/items.ts). |
| A merchant's reasoning shown to the player | Every price in the dock's Vendors tab has its reason printed under it, as the contract gives it ("Short: 3 against a target of 16. Paying half again."). |
| A fast-forward: a week of trading in a minute | Practice → Dock → Ledger → **Fast-forward a week**. 168 hours play in about a minute, with what the vendors pay and who holds the money drawn as it goes ([`src/economy/v2/dock/week.ts`](src/economy/v2/dock/week.ts)). |
| Flood the market and the price falls | A vendor's bid falls unit by unit as its stock rises, and the export desk pays less for each unit sold that day. |
| A merchant that goes broke closes its shop | A vendor that can't cover another purchase buys nothing until it sells something. Investing in a broke merchant exists only in the first game (below). |
| Social or email login; no seed phrase, wallet popup or gas prompt | No seed phrase, popup or gas prompt: a dock pass is a NEAR account made in the browser, and the dock office pays for it. Sign-in with Google is built (through Privy, [`server/auth.ts`](server/auth.ts)) and switched off on the live site until it has been tried end to end by a person. |
| An economy that moves without a patch | Prices follow stock, the Harbormaster's strength follows what players pay it and halves every 12 hours, and no account, the owner's included, can create scrip, parts or guns outside the contract's rules. A test checks that. |
| NEAR Intents | Not used: it is mainnet-only. |

## Also entered: NFTs That Do Something

A gun is not a picture. Each one is an NEP-171 token in the game contract
([`contract2/src/nft.rs`](contract2/src/nft.rs), [`weapons.rs`](contract2/src/weapons.rs)), and it does these things:

- **It is the thing you play with.** Its rolled stats are the numbers the shooter uses. Starting a raid checks the gun
  is the caller's and locks it in the contract until the raid ends, so a gun that has been sold can't be taken on
  one by its old owner.
- **It changes with use.** Wear, the raids it went on, the raids it came home from, how many accounts have owned it
  and how often it was pulled from a wreck are all on its record. Its level is worked out from the raids it came home
  from, so a level can't be minted or bought, and it moves with the gun when the gun is sold.
- **It holds inventory.** Mods are fitted into a gun for good and go wherever it goes.
- **It pays its maker.** `nft_payout` (NEP-199) gives whoever built the gun 2% of every resale, and the game's own
  market pays the same.
- **It can be lost and found.** Die to the machines and the gun lies in a wreck that appears in other players' raids;
  the first to carry it to the boat owns it. Die to the Bailiff and it is impounded for 48 hours.
- **Its picture is on chain.** The token's `media` is an SVG the contract draws from the gun's own record.

What it is not: a gun is not an account of its own (there is no sub-account per token), and there is no page gated
to holders beyond the dock showing each player their own guns.

## Try it: do X, see Y

Steps 1 to 9 use Practice: the whole port runs in the browser, so nothing can fail on the network. Step 10 is the
chain.

| # | Do | See |
| --- | --- | --- |
| 1 | Open https://saltline-lac.vercel.app and scroll | The front page. Under "The ledger", four numbers and the port wire are read live from the contract. The invoice down the side climbs as you scroll. |
| 2 | Open https://saltline-lac.vercel.app/play/?game=v2&mock=1&stash=rich | The lobby: your card at the top left, your gun in the middle, three modes on the right, "Start here" at the bottom left, the dock's tabs along the foot and one big button. |
| 3 | Press the big **Deploy** button | The first time, a 48-second opening film (any key skips it). Then you stand unarmed at a crate: "HOLD E — TAKE THE RIFLE". |
| 4 | Hold **E** at the crate, then walk to a marked container and hold **E** | The seal is cut and the cargo is added (`CARGO 2/6`). At the top right the invoice rises: `INVOICE 853 · BAILIFF AT 1,200`. |
| 5 | Cut the three uplinks (hold **E** at each), then reach the boat | The debrief: what you carried, the invoice, and what was added to what you owe. |
| 6 | Back at the lobby, press **Vendors** | Moss and Ines. Each price has the vendor's reason under it. Press **Sell** on something you hold and the next unit pays less. |
| 7 | Press **Armoury**, pick a frame and press **Build** | The parts and the fee are taken, and the gun's stats roll one by one, then its grade is stamped. No two come out the same. |
| 8 | Press **Loadout** and look at the rack | Each gun shows its level ("Lv 4"). A gun levels by the raids it comes home from, and the card says what the level adds and how many raids to the next. |
| 9 | Press **Ledger**, then **Fast-forward a week** | 168 hours in about a minute: two charts draw what the vendors pay and what Moss, Ines and the Harbormaster hold. It ends with what changed: scrip in existence, guns built and destroyed. |
| 10 | Open https://saltline-lac.vercel.app/play/?game=v2, press **Deploy**, type a callsign | A dock pass: a NEAR testnet account made for you, with no popup and no seed phrase. The raid, the haul, every sale and every gun after that are transactions on `v2.saltline.testnet`. |

Controls: WASD and the mouse (click to capture it), left mouse to fire, right mouse to aim, R to reload, E to use,
G to throw a breaker charge, F for the rifle butt, Space to jump, Shift to sprint, C to crouch, Esc to pause. On a
touch screen there are on-screen buttons for all of these.

## Check it without playing

```sh
npm ci
npm run check               # typecheck, 943 tests (Vitest), production build
npm run verify:v2           # reads the live v2 contract with no wallet and checks it against the game's numbers
cd contract2 && cargo test  # 62 contract tests, including an access table over every public method and a no-mint test
```

Browser tests (Chrome from `CHROME_PATH` or the usual install path):

```sh
npm run dev                                           # http://127.0.0.1:5280
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

The wire format is in [`docs/CONTRACT_V2.md`](docs/CONTRACT_V2.md). Every transaction is on each account's explorer
page, and `npm run e2e:v2` makes a fresh set and prints their hashes.

## What NEAR does here that a game server couldn't

- **A gun is yours, with its history.** Each gun is an NEP-171 NFT with a serial, rolled stats, a maker and a count
  of the raids it has come home from. It can be sold on the market, where its maker earns 2% of every resale, or
  carried out of your wreck by someone else. Its level comes from that on-chain count, so it can't be bought.
- **Nobody can quietly reprice the market or print money.** Every price is a pure function in one file, deployed on
  chain, and the owner's key can pause the contract and nothing else.
- **The NPCs really own what they trade.** Each is a NEAR account with its own key. The contract only lets a
  vendor's own account build from its stock or set its prices.
- **The villain is funded by its victims, in public.** Paying down what you owe goes into the Harbormaster's wallet,
  and that balance is the difficulty every player faces.
- **Wallets without sign-ups.** The chain stays out of sight until you click a ledger link.

## How it's built

```
index.html             the front page (src/site/): what the game is, drawn from the game's own numbers and the live contract
play/index.html        the game
src/game.js            the shooter (the baseline: three.js r180, everything generated in code) + marked `// ext:` hooks
src/economy/v2/        the game around it, TypeScript, attached to the shooter's shared context after boot
  items.ts             every number: frames, blueprints, the invoice, levels, pricing (mirrors contract2/src/items.rs)
  chain.ts, mock.ts    the NEAR client (near-kit), and the same economy in memory for Practice and tests
  raid/                sign-on, the owned gun in the shooter, loot, the invoice and what it summons
  dock/                loadout, armoury, market, vendors, the ledger and the fast-forward
  home/, login/        the lobby, and sign-in with Google
  intro/, coach/       the opening film, and the first raid's crate and checklist
  squad/               live presence: other breachers in a raid right now, drawn in your yard
  metrics/             what the browser reports to the studio's counts (docs/DATA.md)
src/economy/           shared pieces and the first game: the chain executor, the wallet, the Bailiff, the arsenal, the score
contract2/             Rust (near-sdk 5.29.1): mt.rs, nft.rs, items.rs, weapons.rs, raids.rs, vendors.rs, export.rs, market.rs, harbormaster.rs
agents/v2/             Moss, Ines and the Harbormaster: read the port, decide in character, sign their own moves
server/, api/          the dock office: the faucet, sign-in, and the studio's counts; each validates and fails closed
docs/                  GAME.md (the design), CONTRACT_V2.md (the wire format), STORY.md, DATA.md
```

## The first game (v1)

The repo also holds the first economy built for this entry, still live: https://saltline-lac.vercel.app/play/
(without `?game=v2`) on [`saltline.testnet`](https://testnet.nearblocks.io/address/saltline.testnet). It is a
salvage market: three broker NPCs with wallets, price tooltips with each broker's reason, **investing in a broker
that went broke**, a shared town story, and a fast-forward run by the contract itself (`simulate`, the Dockside's
"The week" tab). It was rebuilt as v2 because its economy sat beside the shooter and not inside it: nothing a player
owned could be lost. Its design is in [`docs/ECONOMY.md`](docs/ECONOMY.md) and its contract in `contract/`.

**Transactions to check**

| What | Transaction |
| --- | --- |
| A player's run from the live site: `start_run` | [8XYJ3VHT…](https://testnet.nearblocks.io/txns/8XYJ3VHT7e6nKJ46QRnDi7S56TzJrEdNLBmCYmnyQfPN) |
| `extract`: copper and fuel minted | [E9eP9kxc…](https://testnet.nearblocks.io/txns/E9eP9kxcZafjUgDM7u2j7psHz2cfNotU55k2SxWrxof4) |
| `sell` to Moss for 72 scrip | [H848CazZ…](https://testnet.nearblocks.io/txns/H848CazZ9nYJVbLpzPS9wKTcmTBt8oMoSU7JBf4DKt6a) |
| The Quartermaster's agent changes its stance from GitHub Actions | [3ENE9itW…](https://testnet.nearblocks.io/txns/3ENE9itWsD5WcnQm2dcQXSkgUnHoVjSwQoeuZYveerMB) |
| The live site wakes the brokers: the Quartermaster signs his own stance change through `/api/tick` | [CRWtBStP…](https://testnet.nearblocks.io/txns/CRWtBStPH5frcZdqAwivjKGSvsgMRtBDsp6SufAXa9sA) |
| Moss ships surplus to the freighter (`broker_export`, signed by `moss`) | [ujKRZMmC…](https://testnet.nearblocks.io/txns/ujKRZMmCVBH96ycaFgCshxz5yQsWLRQub9MKFxWhvBJ) |
| **Refused:** a player tries to ship Moss's stock and gets `E_NOT_BROKER` | [3vzTTpaF…](https://testnet.nearblocks.io/txns/3vzTTpaFFJ8MA9QnsLDA6SAD7DX57hzLP8KT7q9RdHMz) |
| The story upgrade: the contract's code was redeployed with every existing view unchanged | [3Tr1JW4v…](https://testnet.nearblocks.io/txns/3Tr1JW4vZJ1c6ReHjGKWFN4MBY9AVZeBqUppDXw6fexo) |
| `simulate` (168 h × 30 traders) as a transaction, to measure it: 102.9 Tgas | [F4VJyqJV…](https://testnet.nearblocks.io/txns/F4VJyqJV9vjxk5apksVjmFHaxqfZPFXAwp5RZ2abkRVF) |

## Run it locally

```sh
npm ci
npm run dev        # http://127.0.0.1:5280 is the front page; the game is at /play/ (Practice needs nothing else)
npm run build      # dist/
```

For testnet, copy `.env.example` to `.env` and set the contract ids. The dev faucet also needs `FAUCET_ACCOUNT_ID`
and `FAUCET_PRIVATE_KEY`, which stay server side. `contract2/README.md` covers building and deploying the contract,
and `agents/README.md` covers running the characters.

## Limits, stated plainly

- **Run results come from the client.** The contract enforces the manifest, the carry limit, minimum run times
  (45 s + 8 s a box) and one run at a time, but it can't see the fight. A launch would need a server that checks runs.
- **The guest wallet's key lives in this browser's storage.** Clearing it loses the account. This is testnet only.
- **With sign-in on (v2), the studio holds the keys.** A player signs in with Google (through Privy). Their
  NEAR key is derived on the server from that sign-in and one server secret, which is what lets the same sign-in open
  the same account on any device, and lets the faucet give one dock pass per sign-in. It also means whoever holds
  that secret could sign as any player. That is acceptable on testnet only; a launch would move the key to the login
  provider's own custody. Sign-in is off unless the deployment sets `VITE_PRIVY_APP_ID`, `PRIVY_APP_ID` and
  `WALLET_SECRET` (see `.env.example`). Where it is on, everyone signs in before they play, the offline Practice game
  included; a local run without those settings stays open, which is how the smoke and end-to-end scripts run.
- **Seeing other players is presence, not a shared raid.** Breachers who are in a raid at the same moment appear in
  each other's yard as figures with their callsign, moving as they move ([`src/economy/v2/squad/`](src/economy/v2/squad)).
  That is all it is: each player's machines, containers and invoice are still their own, and nobody can hit or be
  hit by another player. The browsers talk to each other directly (WebRTC), having met through public Nostr relays
  this project doesn't run, so players in the same yard can see each other's network address, as in any
  peer-to-peer game. What arrives from another browser is checked field by field and can only move a figure.
  `?squad=0` switches it off.
- **The faucet's per-IP limits are kept in memory** on each serverless instance. The lasting guards are one
  registration per account and never funding an account that already exists.
- **The studio keeps a small database of who signed in and how many came (v2), when one is configured.** One record
  per sign-in (Privy id, NEAR account, callsign, first and last seen) and daily counts of visits, sign-ins, passes
  and raids. No email, IP address or key is stored, devices and sign-ins enter the counts only as salted hashes, and
  the counts a browser reports can be inflated by anyone who posts them. The game never depends on it; it is off
  until the deployment has a database. [`docs/DATA.md`](docs/DATA.md) lists every key.
- **Not tested:** Safari, Firefox, a real phone (touch was exercised only in a phone-shaped desktop browser),
  gamepads, and more than a handful of players at once (the contract
  caps profiles at 500).
- **Vercel's checkpoint:** a burst of scripted requests can make Vercel show its security checkpoint (HTTP 403) for a
  few minutes. If you see it, wait and reload, or run the game locally.

## Hackathon disclosure

- **The baseline.** The shooter existed before the hackathon. Its owner built it on another device and published it
  as a claude.ai artifact. It was imported here on 10 Nov 2026 and tagged
  [`pre-hackathon`](https://github.com/Nuel-osas/saltline/tree/pre-hackathon) (`cccde37`). Its files credit AI
  agents (e.g. "owned by the Game agent" in `src/ui.css`).
- **The hackathon work.** Everything in
  [`pre-hackathon...main`](https://github.com/Nuel-osas/saltline/compare/pre-hackathon...main) was built from 11 Nov
  2026: both contracts, the game around the shooter, the agents, the dock office, the front page, the docs and the
  tests. Each piece came in as its own pull request.
  - The only changes to the baseline game's code are in `src/game.js` (+55/−27 lines): extension points marked
    `// ext:`, plus the new premise and radio strings marked `story:`.
  - With `?noeconomy=1`, the baseline plays exactly as before.
- **AI-generated code.** The hackathon work was written with Claude Code (Anthropic), with several agents working in
  parallel branches under review. The pull requests record what each one did.
- **A reference.** The order of sections on the front page and the arrangement of the lobby follow another
  browser game's that the owner asked to match. No code, wording or art was taken from it.
- **Libraries:**
  - the game: three.js r180 (bundled in the baseline), near-kit, @privy-io/js-sdk-core (sign-in, loaded only when it is on), trystero (live presence, loaded when a raid starts)
  - the server: jose (checking sign-in tokens)
  - the contracts: near-sdk, with near-workspaces for sandbox tests
  - build and tests: Vite, Vitest, happy-dom, playwright-core, TypeScript, Prettier
- **Other projects:** none entered.

## License

Apache-2.0 (see `LICENSE`). `NOTICE` credits three.js (MIT) and the three typefaces (SIL OFL 1.1, in
`src/fonts/OFL.txt`).
