# Saltline

> The port's security net has gone feral. Cut its three uplinks. Reach the boat. Bring back what you can carry.

Saltline is a first-person shooter in the browser with a player-driven economy on NEAR. You haul cargo out of a
container terminal overrun by its own security drones and sell it at the dock. The three brokers who buy it are NPCs
with their own NEAR accounts. Their prices come from what every player has sold, their reasons are on the price
tag, and they can go broke.

- **Play:** https://saltline-lac.vercel.app (NEAR testnet; no wallet or install needed)
- **Built for:** NEAR HACKATHON, November 2026, track 09 Games With Real Economies
- **Contract:** [`saltline.testnet`](https://testnet.nearblocks.io/address/saltline.testnet)
- **Hackathon work:** [`pre-hackathon...main`](https://github.com/Nuel-osas/saltline/compare/pre-hackathon...main)

## Try it: do X, see Y

| # | Do | See |
| --- | --- | --- |
| 1 | Open https://saltline-lac.vercel.app | The title screen. The small dock board at the top right shows the brokers' live prices, read from the contract. |
| 2 | Press **DEPLOY** | A "Sign on" card. Type a callsign and press **Claim pass and deploy**. |
| 3 | Wait a moment | The pass is stamped "150 scrip" and the run starts. There's no wallet popup and no seed phrase: the faucet created a NEAR testnet account for you and registered your callsign. |
| 4 | Listen to the radio, then look at the bottom left and the compass | "Manifest's in. 8 sealed boxes…" Eight containers are marked, with a cargo readout (`CARGO 0/6`). |
| 5 | Walk to a marked container and hold **E** | The seal is cut and the cargo is added (e.g. `MEDS ×1`). `PACE` drops: each unit of weight slows you by 6%. |
| 6 | Cut relays A, B and C (hold **E** at each), then reach the boat | The debrief shows **Haul**, **Haul value** and a **Ledger** link to your `extract` transaction on nearblocks. The cargo is now NEP-245 tokens in your account. |
| 7 | Press **DOCKSIDE** on the debrief | Three broker stalls. Hover a price to see the broker's reason, e.g. "Short: 9 coils against a target of 12. Paying over base." |
| 8 | Press **SELL 1** on cargo you hold | The split-flap price rolls down, your scrip rolls up, and your sale appears on the ledger ticker at the bottom. Every other player's sales move the same prices. |
| 9 | Open the **THE WEEK** tab | A simulated week of the market (the contract's free `simulate` view) plays in about a minute. Shaded bands are brokers that went broke and shut. |
| 10 | Die with cargo once | The dead card says `Cargo lost: … left as a wreck`. Your wreck appears in other players' runs with your callsign on it. Whoever recovers it keeps 70%, and 30% comes back to you, which the Dockside reports under **While you were away**. |

Controls: WASD and the mouse (click to capture it), left mouse to fire, right mouse to aim, R to reload, E to use, Space
to jump, Shift to sprint, C to crouch, Esc to pause. There are on-screen controls on touch screens.

## Check it without playing

```sh
npm ci
npm run check              # typecheck, 231 tests (Vitest), production build
npm run verify:testnet     # reads the live contract, no wallet needed: each broker's prices and reasons, its agent's last
                           # note, the ledger, the leaderboard, a simulated week, the faucet's balance
cd contract && cargo test  # 35 contract tests (pricing, closing and reopening, runs, wrecks, market, limits, simulate)
```

**Offline:** run `npm run dev`, then open http://127.0.0.1:5280/?mock=1. The whole economy runs in memory, with simulated
players, so every screen works without the chain.

**Browser smoke test:** run `npm run dev -- --port 5290`, then `node scripts/smoke-salvage.mjs`. It makes 17 checks:
manifest, seal, weight, wreck, extract, death, 60 fps, and the baseline unchanged with `?noeconomy=1`. It uses Chrome
from `CHROME_PATH` or the usual install path.

## On chain (NEAR testnet)

**Accounts**

| Account | What it is |
| --- | --- |
| [`saltline.testnet`](https://testnet.nearblocks.io/address/saltline.testnet) | The game contract: NEP-245 items, runs, wrecks, the market, the ledger and `simulate` |
| [`faucet.saltline.testnet`](https://testnet.nearblocks.io/address/faucet.saltline.testnet) | Registers new players and funds each with 0.1 testnet NEAR for gas |
| [`moss`](https://testnet.nearblocks.io/address/moss.saltline.testnet), [`ines`](https://testnet.nearblocks.io/address/ines.saltline.testnet), [`qm`](https://testnet.nearblocks.io/address/qm.saltline.testnet) `.saltline.testnet` | The three brokers. Each signs its own moves with its own key, from a GitHub Actions schedule every 15 minutes (`.github/workflows/brokers.yml`). |

**Transactions to check**

| What | Transaction |
| --- | --- |
| A player's run from the live site: `start_run` | [8XYJ3VHT…](https://testnet.nearblocks.io/txns/8XYJ3VHT7e6nKJ46QRnDi7S56TzJrEdNLBmCYmnyQfPN) |
| `extract`: copper and fuel minted | [E9eP9kxc…](https://testnet.nearblocks.io/txns/E9eP9kxcZafjUgDM7u2j7psHz2cfNotU55k2SxWrxof4) |
| `sell` to Moss for 72 scrip | [H848CazZ…](https://testnet.nearblocks.io/txns/H848CazZ9nYJVbLpzPS9wKTcmTBt8oMoSU7JBf4DKt6a) |
| The Quartermaster's agent changes its stance from GitHub Actions | [3ENE9itW…](https://testnet.nearblocks.io/txns/3ENE9itWsD5WcnQm2dcQXSkgUnHoVjSwQoeuZYveerMB) |
| Moss ships surplus to the freighter (`broker_export`, signed by `moss`) | [ujKRZMmC…](https://testnet.nearblocks.io/txns/ujKRZMmCVBH96ycaFgCshxz5yQsWLRQub9MKFxWhvBJ) |
| **Refused:** a player tries to ship Moss's stock and gets `E_NOT_BROKER` | [3vzTTpaF…](https://testnet.nearblocks.io/txns/3vzTTpaFFJ8MA9QnsLDA6SAD7DX57hzLP8KT7q9RdHMz) |
| `simulate` (168 h × 30 traders) as a transaction, to measure it: 102.9 Tgas | [F4VJyqJV…](https://testnet.nearblocks.io/txns/F4VJyqJV9vjxk5apksVjmFHaxqfZPFXAwp5RZ2abkRVF) |

## What NEAR does here that a game server couldn't

- **Nobody can quietly reprice the market.** Every price comes from plain integer rules in one file,
  [`contract/src/pricing.rs`](contract/src/pricing.rs), deployed on chain. Changing them, even by the developer, is a
  visible redeploy.
- **The NPCs really own what they trade.** Each broker is a NEAR account with its own key, stock and scrip. The
  contract only lets its own account ship its stock or change its stance, and each move carries the agent's stated
  reason on the ledger.
- **Players own their haul.** Cargo, gear and scrip are NEP-245 tokens in one contract, held by the player's own
  account. Players can trade them with each other on the player market, or with any NEP-245 tool.
- **Wallets without sign-ups.** Each player gets a NEAR implicit account whose key lives in their browser. The faucet
  funds it, and every call is signed in the background. The chain stays out of sight until you click a ledger link.

## How it's built

```
src/game.js            the shooter (the baseline: three.js r180, everything generated in code) + 7 marked `// ext:` hooks
src/economy/           the economy layer, TypeScript, attached to the game's shared context after boot
  chain.ts, wallet.ts  NEAR client (near-kit): call queue, retries without double spends, guest wallet
  mock.ts              the same economy in memory, for offline play and tests
  salvage/             in the run: sealed containers, carried weight, wrecks, HUD, debrief rows
  dockside/            between runs: dock pass, stalls, hold, ledger, player market, board, the week, away slip
contract/              Rust (near-sdk 5.29.1): mt.rs (NEP-245), pricing.rs, policy.rs, runs.rs, market.rs, sim.rs
agents/                the broker agents: read the board, decide in character, sign their own moves
server/faucet.ts       the dock pass faucet (api/faucet.ts on Vercel): validates, rate-limits, fails closed
docs/                  ECONOMY.md (the design, written before the code) and CONTRACT_API.md (the wire format)
```

- **The loop:** every 30 seconds you fight and cut seals. A run takes about 5 minutes: cut three relays and reach the
  boat. A session is selling, buying gear, investing in a broker that went broke, and checking the board.
  `docs/ECONOMY.md` has the design.
- **Pricing:** a broker bids `base × 2 × target / (target + stock) × stance / 100`, so dumps get worse prices unit by
  unit. It closes when it can't cover one more unit above its float of 100. Players reopen it by investing (it
  reopens at 400 scrip) and earn 10% of its exports as dividends.

## Run it locally

```sh
npm ci
npm run dev        # http://127.0.0.1:5280 (offline mock unless .env names a contract)
npm run build      # dist/
```

For testnet, copy `.env.example` to `.env` and set `VITE_CONTRACT_ID=saltline.testnet`. The dev faucet also needs
`FAUCET_ACCOUNT_ID` and `FAUCET_PRIVATE_KEY`, which stay server side. `contract/README.md` covers building and
deploying the contract, and `agents/README.md` covers running the brokers.

## Limits, stated plainly

- **Run results come from the client.** The contract enforces the manifest, the carry limit, minimum run times
  (45 s + 8 s a box) and one run at a time, but it can't see the fight. A launch would need a server that checks runs.
- **The guest wallet's key lives in this browser's storage.** Clearing it loses the account. This is testnet only.
- **The faucet's per-IP limits are kept in memory** on each serverless instance. The lasting guards are one
  registration per account and never funding an account that already exists.
- **Not tested:** Safari, Firefox, touch devices, gamepads, and more than a handful of players at once (the contract
  caps profiles at 500).

## Hackathon disclosure

- **The baseline.** The shooter existed before the hackathon. Its owner built it on another device and published it
  as a claude.ai artifact. It was imported here on 10 Nov 2026 and tagged
  [`pre-hackathon`](https://github.com/Nuel-osas/saltline/tree/pre-hackathon) (`cccde37`). Its files credit AI
  agents (e.g. "owned by the Game agent" in `src/ui.css`).
- **The hackathon work.** Everything in
  [`pre-hackathon...main`](https://github.com/Nuel-osas/saltline/compare/pre-hackathon...main) was built from 11 Nov
  2026: the contract, the economy layer, the agents, the faucet, the docs and the tests. Each piece came in as its
  own pull request.
  - The only changes to the baseline game are 7 extension points in `src/game.js`, each marked `// ext:` (+10/−3
    lines).
  - With `?noeconomy=1`, the baseline plays exactly as before.
- **AI-generated code.** The hackathon work was written with Claude Code (Anthropic), with several agents working in
  parallel branches under review. The pull requests record what each one did.
- **Libraries:**
  - the game and economy: three.js r180 (bundled in the baseline), near-kit
  - the contract: near-sdk, with near-workspaces for its sandbox tests
  - build and tests: Vite, Vitest, happy-dom, playwright-core, TypeScript, Prettier
- **Other projects:** none entered.

## License

Apache-2.0 (see `LICENSE`). `NOTICE` credits three.js (MIT) and the three typefaces (SIL OFL 1.1, in
`src/fonts/OFL.txt`).
