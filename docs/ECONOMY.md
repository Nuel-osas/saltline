# Saltline economy: salvage rights

Saltline's NEAR HACKATHON entry, track 09 (Games With Real Economies). Work started on 11 Nov 2026. The game as
imported before then is tagged `pre-hackathon`; everything in this document is new work. This file is the agreement
between the work lanes: change it first when the design changes.

## The pitch, in one line

You haul cargo out of a port overrun by its own security drones and sell it to dockside brokers. The prices you get
come from every other player's runs. The brokers are NPCs with their own NEAR wallets who can go broke.

**The visible consequence:** you drag a crate of copper coil to the dock under fire, and Moss pays you 41 scrip, down
from 78 an hour ago. Her stall says why: "Sitting on 34 coils against a target of 12. Paying half." Then her price
ticks down again while you watch, because someone else just sold.

**The chain stays out of sight.** No seed phrases, wallet popups or gas prompts during play. A player picks a callsign
and plays. The ledger is one click away for anyone who wants to check it.

## The loop on paper

| Every | The player |
|---|---|
| **30 seconds** | Fights drones. Picks a sealed container from the run's cargo manifest, holds E to cut its seal under fire, and takes the cargo. Each unit makes them slower. Decides whether one more crate is worth it. |
| **5 minutes** (a run) | Cuts the three relays and reaches the boat with the cargo they're carrying. If they die, the cargo stays in the yard as a **wreck** with their callsign on it, and the next player through can recover it. |
| **A session** (15–40 minutes) | Sells at the Dockside. Watches the prices move. Buys gear for the next run (armour plate, extended mag, seal cutter). Invests scrip to reopen a broker who went broke and takes a share of its margin. Lists cargo for other players to buy. Checks the leaderboard. |
| **Across days** | The economy keeps moving without them: brokers ship surplus to freighters, reprice, go broke and reopen as players invest. Prices on any given day come from what every player has done. |

Why it's sticky: every run is a gamble between greed and the boat. Death has a cost that turns into someone else's
find, and the market is a puzzle with other people in it.

## The economy

### Items (NEP-245 multi tokens, all in one contract)

| Token id | Name | Kind | Weight | Base price | Export price | Target stock |
|---|---|---|---|---|---|---|
| `scrip` | Dock scrip | currency | 0 | – | – | – |
| `copper` | Copper coil | cargo | 1 | 60 | 35 | 12 |
| `meds` | Cold-chain meds | cargo | 1 | 90 | 55 | 8 |
| `chips` | Boxed electronics | cargo | 1 | 75 | 45 | 10 |
| `fuel` | Fuel cells | cargo | 2 | 110 | 70 | 6 |
| `core` | Relay core | cargo (rare) | 1 | 160 | 100 | 4 |
| `plate` | Armour plate | gear | – | 80 (ask) | – | – |
| `mag` | Extended mag | gear | – | 50 (ask) | – | – |
| `cutter` | Seal cutter | gear | – | 65 (ask) | – | – |

- **Amounts:** integers throughout. Scrip has no decimals and is used as a plain count. The contract stores `u128`.
- **Gear** is equipped at the start of a run and burned by it. The player picks it in the Dockside's hold, which
  writes `economy.equipped`; the salvage code passes that list to `start_run`. Effects:
  - plate: +40 max health for the run
  - mag: +15 rounds per magazine
  - cutter: seals and relays cut 40% faster
- **Carry limit:** 6 weight. Each unit of weight carried scales move speed by `1 − 0.06 × weight`, so a full load
  moves at 64%.

### Brokers: NPCs with wallets

Each broker is a real NEAR account with its own key, held by the agent runner (`agents/`), never by the game client.
Its inventory and scrip sit in the contract under its own account id, like any player's.

| Broker | Account | Buys | Sells | Character |
|---|---|---|---|---|
| Moss | `moss.<contract>` | copper, chips | cutter | Scrap metal, thinks in tonnes, hates waste |
| Ines | `ines.<contract>` | meds, fuel | plate | Cold chain and fuel, cautious, holds cash |
| Quartermaster | `qm.<contract>` | core, fuel | mag | Buys relay cores for "the client", pays well, spends fast |

### Pricing rules (`contract/src/pricing.rs`, the one readable file)

These are integer functions of the broker's state. Each returns the price and a one-line reason that the Dockside
shows in a tooltip.

- **Bid (what a broker pays per unit):**
  `bid = base × 2 × target / (target + stock) × stance / 100`
  - The bid is 2× base at zero stock, base at the target, and half base at three times the target.
  - `stance` is the broker's own lever: 80–120, set by its agent.
- **Ask (what gear costs):** `ask = base × (100 + recent_sales) / 100 × stance / 100`.
  - `recent_sales` is units sold in roughly the last 6 hours, decaying with a half-life of about 6 hours.
  - It is computed lazily from a stored value and a timestamp.
- **Batches:** a sale of n units is priced one unit at a time, with stock rising between units. Big dumps get worse
  prices.
- **Cash:** a sale that would take a broker's scrip below the float (100) is refused.
- **Closing:** after any trade or export, a broker **closes** when its scrip can no longer cover one more unit at its
  highest current bid while staying at or above the float (`scrip < float + max_bid`). A closed broker refuses sales
  and purchases, but can still export, which is how it can recover on its own.
- **Reopening:** players `invest` scrip. When the broker's scrip reaches the reopen line (400), through investment or
  an export, it reopens.
  Investors hold shares in proportion to what they put in.
- **Export (a broker's only income besides gear):** a broker ships stock above target to the freighter at the export
  price. It is paid in newly minted scrip, minus a 10% dividend split between its shareholders.
  - Only the broker's own account can call it, at most once an hour per item.
  - This is the economy's main scrip source; gear purchases and dock fees are its sinks.
- **The trap brokers can fall into:** bidding above the export price loses money on every unit. A broker flooded with
  copper earns less on each coil, and a broker that overpays goes broke.

### Runs on-chain

- **`start_run({ gear })`**
  - Burns the equipped gear.
  - Records the run: player, start time (block timestamp) and a loot seed from `env::random_seed()`.
  - Returns the run's **manifest**: up to 8 sealed containers out of the level's salvage spots, each with its cargo,
    plus up to 3 wrecks left by other players.
  - One run per player at a time. Starting a new one abandons the old one, and the abandoned run's cargo is lost.
- **`extract({ run_id, opened, wrecks })`** (on reaching the boat)
  - Checks: the run is the player's and still open; every index is in the manifest and listed once; the total weight
    is within the carry limit; the run is at least 45 seconds old plus 8 seconds per container opened.
  - Then mints the cargo to the player.
  - For a recovered wreck, the finder gets 70% of each item, rounded half up, and the player who died gets the rest:
    1 → 1/0, 2 → 1/1, 3 → 2/1, 6 → 4/2. (Rounding down left a 1-unit wreck worth nothing to the finder while it
    still weighed down their run.)
- **`die({ run_id, opened, wrecks, spot })`**
  - The carried cargo becomes a wreck at that salvage spot, with the player's callsign.
  - The contract keeps the newest 24 wrecks, and the oldest is lost to the sea.
- **Trust, honestly stated:** run results come from the client. The contract enforces the manifest, the carry limit
  and the minimum times, and rate-limits runs. It can't see the fight. A launch would need a server that checks runs.
  The README says so.

### Market calls

| Call | Who | What |
|---|---|---|
| `sell({ broker, token_id, amount })` | player | Cargo to the broker, scrip to the player, at the bid. Fails closed if the broker is closed or can't cover it. |
| `buy({ broker, token_id, amount })` | player | Gear for scrip, at the ask. |
| `invest({ broker, amount })` | player | Scrip into a broker for shares, which can reopen it. |
| `list({ token_id, amount, price })` / `buy_listing({ id })` / `cancel_listing({ id })` | player | The player market: cargo listed by players for players. Kept in escrow by the contract. |
| `broker_export({ token_id, amount, memo })` | broker account | Ship surplus to the freighter. `memo` is the agent's reason, shown on the ledger. |
| `broker_stance({ stance, memo })` | broker account | Set the bid stance (80–120). |
| `register({ account_id, callsign })` | faucet account | Create the player's profile and mint 150 starter scrip. Once per account. |

Every state change emits a NEP-297 event: the standard `nep245` `mt_mint`, `mt_burn` and `mt_transfer`, plus a
`saltline` standard for `run_start`, `extract`, `wreck`, `sale`, `purchase`, `invest`, `close`, `reopen`, `export`,
`stance` and `listing`.

### Views

- `profile(account_id)`
- `balances(account_id)`
- `brokers()`: each broker's stock, scrip, open state, stance, and bids and asks with their reasons
- `manifest(run_id)`
- `wrecks()`
- `listings()`
- `recent(limit)`: the last events, for the Dockside ticker
- `leaderboard()`: net worth at current bids, top hauls and top investors
- `simulate({ hours, traders, seed })`: the fast-forward. It copies the market into memory and runs simulated
  players and broker policies hour by hour with the same `pricing.rs`. It returns a series per broker: bids, stock,
  scrip and open or closed state.
  - It is a view call, so it's free and needs no wallet.
  - The Dockside plays a 168-hour week back in about a minute.

## Wallets and accounts

- **Guest wallet:** the default, ready now.
  - On first play the game makes an ed25519 key in the browser (`localStorage["saltline.wallet.v1"]`). The account is
    the matching implicit account (64 hex characters).
  - "Claim your dock pass" sends `{ accountId, callsign }` to `/api/faucet`. The faucet server holds the faucet
    account's key and sends 0.1 testnet NEAR, which creates the implicit account (a session burns about 0.005 NEAR of gas). It then calls `register`.
  - The faucet fails closed and rate-limits by account and by IP.
  - Every later call is signed in the browser with no prompt.
  - Settings has "Back up wallet", which exports the key.
- **Privy (email or Google):** added when a Privy App ID is supplied.
  - Privy makes the NEAR wallet, and calls are signed through `signRawHash` behind the same `Wallet` interface.
  - The faucet works the same way.
- **Bring your own NEAR wallet:** optional, through `@hot-labs/near-connect`. Sign-in adds a function-call access key
  limited to the game contract, so play stays popup-free.
- **Network:** testnet throughout. The prize account is mainnet and separate.

## What NEAR does here that a plain server couldn't

- **No owner can tilt it.** The pricing rules are a deployed contract, and nobody, the developer included, changes
  prices without a visible redeploy.
- **The brokers are real accounts with real balances.** They sign their own trades, and anyone can audit what they
  bought and why.
- **Players own their haul:** their cargo and gear are NEP-245 tokens in their own accounts, and they can trade them
  with each other without the game's server.
- **Wallets without signups:** implicit accounts plus access keys give every player a real wallet that signs in the
  background.

## Code layout

```
contract/                 Rust, near-sdk 5.x, built with cargo-near
  src/lib.rs              state, init, roles (owner, faucet)
  src/mt.rs               NEP-245 core (mt_transfer, mt_batch_transfer, mt_balance_of, mt_batch_balance_of, mt_supply) + events
  src/items.rs            the item table above (data)
  src/pricing.rs          the pricing rules (the one readable file)
  src/runs.rs             start_run, extract, die, manifests, wrecks
  src/market.rs           sell, buy, invest, listings, broker calls
  src/sim.rs              simulate
agents/                   the broker agents: each signs its own calls with its own key from .env
server/faucet.ts          the faucet handler (a Vercel function, and middleware in dev)
src/economy/              the game side, in TypeScript
  types.ts                the shared interfaces (written first; lanes code against it)
  main.ts                 boots after game.js and attaches to window.__G
  wallet.ts, chain.ts     keys, signing, calls queue, views, event polling
  mock.ts                 an in-memory chain with the same interface (tests and offline play)
  salvage/                in-run: manifest, sealed containers, weight, wrecks, HUD, debrief rows
    spots.ts              the 16 salvage spots, generated from the level by scripts/gen-spots.mjs
  dockside/               between runs: stalls, tooltips, ticker, leaderboard, invest, listings, fast-forward chart
src/game.js               the baseline game; only small, marked extension points are added (see below)
```

### Extension points in `src/game.js`

Each is marked with a `// ext:` comment so the diff against `pre-hackathon` stays easy to read:

1. **Interaction:** the relay loop `ue()` gives other interactables a turn before it clears the single prompt slot.
   This is `G.ext.interact(dt)`, which returns true when it took the prompt.
2. **Move speed:** the player's speeds are scaled by `G.ext.speedScale` (default 1).
3. **Run gear:** max health and magazine size read `G.ext.gear` at reset.
4. **Run lifecycle:** `run:start` is emitted after the reset `H()`. The existing events cover kills, relays, death
   and extraction.

The hooks live on `G.ext`, set up at boot as `{ speedScale: 1, gear: {} }`; with those defaults (and with
`?noeconomy`) the game plays exactly as the baseline. `G.ext.gear` holds the run's bonuses as numbers, so the item
table stays in TypeScript: `health` (added to max health, 40 for a plate), `rounds` (added to the magazine, 15 for a
mag) and `cutTime` (multiplies relay and seal cut times, 0.6 with a cutter: 40% less time). Health and magazine are
read at the reset, before `run:start`, so the salvage module keeps `G.ext.gear` in step with `economy.equipped`
between runs.

## Following the baseline's patterns

- Modules are `create(G)` returning `{ update(dt) }`.
- They talk through the `noun:verb` event bus (`G.events.on/emit`). New events: `economy:ready`, `run:manifest`,
  `cargo:taken`, `cargo:dropped`, `wreck:found`, `dock:open`.
- Callers are defensive: an economy failure never stops the shooter.
- Everything is generated in code: labels through `G.mats.label`, sounds through the synth, no downloaded art.
- Interface copy follows the game's voice: port-authority signage, short and dry.

## Checks

- **Contract:** `cargo test` (unit tests on pricing, runs and market), plus a sandbox or testnet run of a full loop.
- **Client:** `npm run check` (typecheck, vitest, build).
- **Browser:** a headless smoke test that plays a run on the mock chain and on testnet: deploy, crack, extract, sell,
  then read the balance. `scripts/smoke-salvage.mjs` covers the in-run half (cut, carry, die, extract) and checks that
  `?noeconomy` still plays the baseline.
