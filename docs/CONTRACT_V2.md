# Saltline v2: the contract's JSON API

The wire format between `contract2/` and `src/economy/v2/chain.ts`. `docs/GAME.md` says why; this file says what
goes over the wire. The numbers (frames, blueprints, rates, thresholds) are in `src/economy/v2/items.ts`, which the
contract's `items.rs` must match exactly. Change both sides and this file together.

- **Account:** `v2.saltline.testnet`. Vendors sign as `moss.saltline.testnet` and `ines.saltline.testnet`, the
  Harbormaster as `harbormaster.saltline.testnet`, the faucet as `faucet.saltline.testnet`.
- Field names are snake_case on the wire. chain.ts maps them to the camelCase types in `src/economy/v2/types.ts`.
- Every amount and price is a `U128`: a JSON string of an integer. Counts (`u32`), ids (`u64`) and timestamps
  (milliseconds, `u64`) are JSON numbers.
- Optional fields are sent as `null`.
- A refused call panics with `E_CODE: message`, the message short and fit to show a player.
- Calls attach no deposit, except NEP-171 transfers (1 yoctoNEAR). Prepaid gas: 30 Tgas for raid calls, 20 for the
  rest (a new player holds 0.1 NEAR; see `src/economy/chain.ts`).
- Stackable tokens are NEP-245 (ids below). Weapons are NEP-171 in the same contract (token id = serial).

## Tokens

`scrip` · materials `copper chips fuel meds core servo rotor` · mods `mag2 barrel2 comp optic` · consumables
`plate charge ammo` (one `ammo` is one magazine).

## Shapes

- **Stats:** `{ damage: u32, rpm: u32, mag: u32, recoil: u32, reload: u32, range: u32 }`. `recoil` and `reload` are
  percents of the baseline.
- **Weapon:** `{ serial, frame, grade, quality: u32, stats: Stats, mods: [mod_id], condition: u32, maker,
  maker_callsign, owner, built_at, raids: u32, extractions: u32, owners: u32, recovered: u32, state, value: U128 }`.
  - `serial` is `S-` and six digits, counting from `S-000001`.
  - `frame` is `longshore`, `stevedore` or `pilot`. `grade` is `A`–`D`.
  - `state` is `held`, `raid`, `listed`, `vendor`, `wreck` or `impound`.
- **Loadout:** `{ weapon: serial?, plates: u32, charges: u32, mags: u32 }`. `weapon: null` is the issue rifle.
- **Container:** `{ spot: u32, token_id, amount: U128, bonded: bool }`.
- **Wreck:** `{ id, spot: u32, owner, callsign, weapon: Weapon?, items: [{ token_id, amount: U128 }], at, expires_at }`.
- **Harbormaster:** `{ account_id, balance: U128, strength: u32, posture: "patrols" | "pursuit", bonus_drones: u32,
  second_notice_at: U128, bailiff_at: U128, second_bailiff_at: U128, foreclosure_at: U128, last_memo: string? }`.
- **Raid:** `{ raid_id, started_at, loadout: Loadout, containers: [Container], wrecks: [Wreck], invoice_start: U128,
  harbormaster: Harbormaster }`.
- **Report:** `{ opened: [u32 spot], wrecks: [u64 id], parts: { servo: u32, rotor: u32 }, kills: { gull: u32, hound:
  u32 }, uplinks: u32, used: { plates: u32, charges: u32, mags: u32 } }`.
- **Quote:** `{ token_id, price: U128, reason }`.

## Init

`new({ owner_id, faucet_id, harbormaster_id, vendors: { moss, ines } })`

- Each vendor starts with 1,500 scrip and its materials at 75% of target.
- Moss starts with two guns for sale (one Longshore, one Stevedore, rolled at init). Ines starts with 10 plates,
  10 charges and 40 magazines.
- This is the only scrip that exists before the first export. The README says so.

## Views

| Method | Args | Returns |
| --- | --- | --- |
| `rules` | – | The `RAID`, `INVOICE`, `HARBORMASTER`, `MARKET` and `CONDITION` numbers of items.ts, snake_case, amounts as U128 |
| `materials` | – | `[{ id, name, weight: u32, bid: U128, export: U128, target: u32 }]` |
| `frames` | – | `[{ id, name, bands: { damage: [lo, hi], … }, base: U128 }]` |
| `blueprints` | – | `[{ id, kind, inputs: { "<material>": U128 }, fee: U128, yields: u32 }]` |
| `profile` | `{ account_id }` | `null` or `{ account_id, callsign, registered_at, raids, extractions, deaths, arrears: U128, active_raid: u64?, built: u32, royalties: U128 }` |
| `balances` | `{ account_id }` | `{ "<token_id>": U128 }`, non-zero only |
| `weapons` | `{ account_id }` | `[Weapon]`: every gun the account owns, in any state |
| `weapon` | `{ serial }` | `Weapon` or `null` |
| `vendors` | – | `[{ id, account_id, name, open, scrip: U128, stock: { "<material>": U128 }, bids: [Quote], goods: [{ token_id, price: U128, stock: U128, reason }], guns: [{ weapon: Weapon, price: U128 }], last_memo: string? }]` |
| `export_prices` | – | `[Quote]`: what the export desk pays per unit now |
| `listings` | – | `[{ id, seller, callsign, price: U128, at, weapon: Weapon?, item: { token_id, amount: U128 }? }]`, newest first |
| `wrecks` | – | `[Wreck]`, newest first, expired ones left out |
| `impound` | `{ account_id }` | `[{ weapon: Weapon, fee: U128, expires_at }]` |
| `harbormaster` | – | `Harbormaster`, with its balance decayed to now |
| `raid` | `{ raid_id }` | `Raid` or `null` |
| `recent` | `{ limit }` | `[{ kind, at, account, callsign?, text }]`, newest first, 64 kept |
| `economy` | – | `{ scrip_supply: U128, minted_24h: U128, burned_24h: U128, players: u32, weapons_built: u32, weapons_alive: u32, weapons_destroyed: u32, last_sales: [{ frame, grade, prices: [U128] }] }` |
| `leaderboard` | – | `{ net_worth: [Row], extractions: [Row], makers: [Row] }`; Row = `{ account_id, callsign, value: U128 }`, top 10 |
| NEP-245 | `mt_balance_of`, `mt_batch_balance_of`, `mt_supply` | As the standard |
| NEP-171 | `nft_token`, `nft_tokens`, `nft_tokens_for_owner`, `nft_supply_for_owner`, `nft_total_supply`, `nft_metadata`, `nft_payout` | As the standards. A token's `metadata.media` is an SVG data URI drawn by the contract (frame, grade, serial); `extra` is the Weapon as JSON. `nft_payout` gives the maker 2%. |

## Calls

| Method | Args | Who | Returns |
| --- | --- | --- | --- |
| `register` | `{ account_id, callsign }` | The faucet | Profile. Mints 150 scrip. |
| `start_raid` | `{ loadout: Loadout }` | A registered player | `Raid` |
| `extract` | `{ raid_id, report: Report }` | The raid's player | `{ minted: { "<token_id>": U128 }, weapon: Weapon?, recovered: [Weapon], invoice: U128, arrears: U128 }` |
| `die` | `{ raid_id, report: Report, spot: u32, by: "machines" \| "bailiff" }` | The raid's player | `{ wreck_id: u64?, impounded: bool, invoice: U128, arrears: U128 }` |
| `build` | `{ blueprint }` | Player | `{ weapon: Weapon?, minted: { "<token_id>": U128 } }` |
| `fit` | `{ serial, mod }` | The gun's owner | `{ weapon: Weapon }` |
| `repair` | `{ serial, points: u32? }` | The gun's owner | `{ weapon: Weapon, cost: U128 }` |
| `scrap` | `{ serial }` | The gun's owner | `{ minted: { "<token_id>": U128 } }` |
| `sell` | `{ vendor, token_id, amount: U128 }` | Player | `{ paid: U128 }` |
| `buy` | `{ vendor, token_id, amount: U128 }` | Player | `{ cost: U128 }` |
| `buy_gun` | `{ vendor, serial }` | Player | `{ weapon: Weapon, cost: U128 }` |
| `export` | `{ token_id, amount: U128 }` | Player or vendor | `{ paid: U128 }`: newly minted scrip |
| `list_weapon` | `{ serial, price: U128 }` | The gun's owner | `{ id }` |
| `list_item` | `{ token_id, amount: U128, price: U128 }` | Player | `{ id }` |
| `buy_listing` | `{ id }` | Player | `{ paid: U128, weapon: Weapon? }` |
| `cancel_listing` | `{ id }` | The seller | `{}` |
| `settle` | `{ amount: U128 }` | Player | `{ cleared: U128, arrears: U128 }` |
| `buy_back` | `{ serial }` | The impounded gun's owner | `{ weapon: Weapon, cost: U128 }` |
| `vendor_build` | `{ blueprint, memo }` | A vendor's account | `{ weapon: Weapon?, minted: { … } }`: built from its own stock, no fee |
| `vendor_price` | `{ serial?, token_id?, price: U128, memo }` | A vendor's account | `{}` |
| `hm_posture` | `{ posture, memo }` | The Harbormaster's account | `Harbormaster` |
| NEP-171 | `nft_transfer` | The owner, only while `held` | As the standard |
| NEP-245 | `mt_transfer`, `mt_batch_transfer` | The holder | As the standard |

## Rules the contract enforces

**Building.** `build` burns the blueprint's inputs and fee from the caller.
- A weapon's six stats are each drawn inside the frame's band from `env::random_seed()` mixed with the serial.
- `quality`, `grade` and `value` follow items.ts exactly (`quality`, `gradeOf`, `appraise`).
- The maker is the caller.

**Fit, repair, scrap.**
- `fit`: one mod per slot; the mod token is burned into the gun.
- `repair`: 2 scrip per point (paid to Moss) and 1 copper per 20 points, rounded up (burned).
- `scrap`: burns the gun and mints 2 copper and 1 electronics.
- All three need the gun `held`.

**Starting a raid.**
- One raid at a time, 30 s after the last. An open raid is abandoned by a new one: its gun returns and its other
  gear is lost.
- The loadout's gun must be `held` by the caller with condition above 0; it becomes `raid`. Plates (0–1), charges
  (0–3) and magazines (0–8) are taken from the caller's balance.
- `invoice_start` = 150 + 25 × extractions + min(1,500, arrears ÷ 2).
- The manifest: 8 of the 16 spots, each a material from the loot table. If arrears ≥ 1,000, 2 more spots are
  bonded containers (2 units of core, servo or electronics). Up to 3 live wrecks that aren't the caller's and aren't
  reserved by another open raid are attached and reserved.

**Ending a raid** (`extract` and `die`). The contract checks the report:
- Every opened spot is in the manifest, once. Every wreck is one of the raid's, once.
- `uplinks` ≤ 3. Kills ≤ 30 gulls and 15 hounds, and total kills ≤ raid seconds ÷ 4.
- `parts.servo` ≤ `kills.hound`, `parts.rotor` ≤ `kills.gull`. `used` ≤ what was brought.
- Carry weight ≤ 6: opened cargo and parts at their weights, plus 2 for each recovered gun.
- `extract` needs the raid to be at least 45 s + 8 s per container opened old.
- The **invoice** is `invoice_start` + 60 per minute of block time + 80 per container opened + 40 per unit of
  weight carried + 200 per uplink + 40 per gull + 120 per hound.

**`extract`.**
- Mints the cargo and parts.
- Returns the gun as `held` with condition −5 and `raids` and `extractions` +1, and returns unused plates, charges
  and magazines.
- Each recovered wreck's gun changes owner to the caller (`owners` +1, `recovered` +1, condition −15, `held`), and
  its items are minted to the caller.
- Arrears rise by 25% of the invoice.

**`die`.**
- `by: "machines"`: the gun, the cargo and parts carried, and unused gear go into a new wreck at `spot`, live for
  24 hours. With the issue rifle and nothing carried, no wreck is made.
- `by: "bailiff"`: the gun is impounded for 48 hours at a fee of 40% of its appraisal; everything else is
  destroyed.
- Arrears rise by 10% of the invoice. Wrecks the raid had reserved are released.

**Expiry.** A wreck past 24 hours or an impound past 48 hours is burned the next time anything touches the list it
is on (lazy, bounded work per call). At most 40 wrecks are kept; the oldest is burned to make room.

**Arrears.**
- `settle` takes up to ⌈arrears ÷ 2⌉ scrip from the caller, gives it to the Harbormaster's balance and clears twice
  that.
- `buy_back` pays the impound fee to the Harbormaster and returns the gun `held`.

**The Harbormaster.**
- Its balance halves every 12 hours (decayed lazily, the lost part burned).
- `strength` = min(100, balance ÷ 20).
- `patrols`: `bonus_drones` = strength ÷ 25, and the thresholds are 600 / 1,200 / 2,400 / 4,000.
- `pursuit`: no bonus drones, and the Bailiff's threshold is 1,200 − 4 × strength.

**Vendors.**
- `sell`: the vendor pays its bid per unit, priced one unit at a time as its stock rises: `bid × 2 × target ÷
  (target + stock)`. It refuses (`E_VENDOR_BROKE`) a sale that would take its scrip under 100.
- `buy` and `buy_gun`: the player pays the vendor's price.
  - Default price for goods: the inputs' value at base bids × 135%, more when it holds few.
  - Default price for a gun: its appraisal × 125%.
  - `vendor_price` overrides either.
- `vendor_build` uses the vendor's own materials, pays no fee, and can build only what `VENDORS` in items.ts lists
  for it.

**Export.** `export` burns the material and mints scrip at `export × 100 ÷ (100 + 4 × units of that material
exported recently)`, one unit at a time. "Recently" halves every 12 hours.

**Market.**
- A listed gun is `listed` (held by the contract); listed items are held in escrow.
- `buy_listing` moves the price from the buyer: 96% to the seller, 2% to the gun's maker (burned for items), 2%
  burned.
- The last five sale prices per frame and grade are kept.
- At most 200 listings (`E_FULL`).

**NEP-171.** `nft_transfer` works only while the gun is `held`, bumps `owners`, and emits `nft_transfer`.
Approvals and `nft_transfer_call` are not implemented.

**No admin mint.** The owner can `pause()` and `unpause()` calls, and nothing else. No method mints scrip,
materials or guns outside the rules above. A test checks every public method's access.

**Limits.** 2,000 profiles, 5,000 guns, 200 listings, 40 wrecks (`E_FULL` where a limit refuses).

## Events

NEP-297. `nep245`: `mt_mint`, `mt_burn`, `mt_transfer`. `nep171`: `nft_mint`, `nft_transfer`, `nft_burn`.
`saltline` (version `2.0.0`), one per kind in `recent`: `raid_start`, `extract`, `wreck`, `impound`, `recover`,
`buy_back`, `build`, `fit`, `repair`, `scrap`, `sale`, `purchase`, `export`, `listing`, `market_sale`, `settle`,
`posture`, `vendor_build`, `vendor_price`. Each `recent` line is one plain sentence in the dock's voice, for example
`ROOK built a B-grade Pilot, S-000041.` or `MARLOWE's Longshore S-000017 is in a wreck by the shed.`

## Errors

`E_NOT_REGISTERED`, `E_ALREADY_REGISTERED`, `E_CALLSIGN_TAKEN`, `E_BAD_CALLSIGN`, `E_NOT_FAUCET`, `E_NOT_VENDOR`,
`E_NOT_HARBORMASTER`, `E_NOT_OWNER`, `E_PAUSED`, `E_NO_RAID`, `E_RAID_CLOSED`, `E_TOO_SOON`, `E_NOT_IN_MANIFEST`,
`E_OVER_LIMIT`, `E_DUPLICATE`, `E_BAD_REPORT`, `E_NO_WEAPON`, `E_WEAPON_BUSY` (not `held`), `E_WORN_OUT`,
`E_SLOT_TAKEN`, `E_FUNDS`, `E_VENDOR_BROKE`, `E_DOESNT_BUY`, `E_DOESNT_SELL`, `E_NO_STOCK`, `E_NO_LISTING`,
`E_NOT_IMPOUNDED`, `E_NOTHING_OWED`, `E_BAD_AMOUNT`, `E_FULL`.

## Trust

The contract proves ownership, custody, the manifest, weight, timings and every price. The game client reports
that the player reached the boat, where they died, what killed them, and how many machines they destroyed; the
caps above bound what a false report can gain. `docs/GAME.md` → Trust says what mainnet would need.
