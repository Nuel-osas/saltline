# Contract JSON API

The exact wire format between `contract/` and `src/economy/chain.ts`. `docs/ECONOMY.md` says why; this file says
what goes over the wire. Change both sides and this file together.

- Field names are snake_case on the wire. chain.ts maps them to the camelCase types in `src/economy/types.ts`.
- Every amount and price is a `U128`: a JSON string of an integer, e.g. `"150"`.
- Every timestamp is milliseconds since the epoch, as a JSON number (`u64` block timestamp ÷ 1e6).
- Run ids, wreck ids and listing ids are JSON numbers (`u64`).
- Token ids: `scrip copper meds chips fuel core plate mag cutter`. Broker ids: `moss ines qm`.
- A refused call panics with a short player-facing message starting `E_`, for example `E_BROKER_CLOSED: Moss is
  shut until someone invests`. chain.ts shows the text after the colon.
- Calls attach no deposit. Gas is 100 Tgas for `start_run`, `extract` and `die`, and 50 Tgas for the rest.

## Init

`new({ owner_id, faucet_id, brokers: { moss, ines, qm } })`

- `brokers` maps each broker id to the account that will sign for it.
- Each broker is seeded with 1,500 scrip and stock at 75% of target for each cargo it buys.

## Views

| Method | Args | Returns |
|---|---|---|
| `items` | – | `[{ id, name, kind, weight, base: U128, export: U128?, target: u32? }]` (the table in ECONOMY.md) |
| `rules` | – | `{ spot_count, containers_per_run, wrecks_per_run, carry_limit, min_run_seconds, per_container_seconds, finder_share_pct, starter_scrip: U128 }` |
| `profile` | `{ account_id }` | `null` or `{ account_id, callsign, registered_at, runs, extractions, deaths, best_haul: U128, active_run: u64? }` |
| `balances` | `{ account_id }` | `{ "<token_id>": U128 }`, with only non-zero balances listed |
| `mt_balance_of` / `mt_batch_balance_of` / `mt_supply` | as in NEP-245 | as in NEP-245 |
| `brokers` | – | `[{ id, account_id, name, open, scrip: U128, stance: u32, stock: { "<cargo>": U128 }, bids: [Quote], asks: [Quote], shares: [{ account_id, callsign, shares: U128 }], last_memo: string? }]` |
| `manifest` | `{ run_id }` | `null` or `Manifest` |
| `wrecks` | – | `[Wreck]`, newest first, up to 24 |
| `listings` | – | `[{ id, seller, callsign, token_id, amount: U128, price: U128, at }]` |
| `recent` | `{ limit }` | `[{ kind, at, account, callsign?, text }]`, newest first, up to 64 kept |
| `leaderboard` | – | `{ net_worth: [Row], best_haul: [Row], investors: [Row] }`; Row = `{ account_id, callsign, value: U128 }`, top 10 each |
| `simulate` | `{ hours: u32 ≤ 168, traders: u32 ≤ 30, seed: u64 }` | `[{ hour, brokers: { "<broker>": { open, scrip: U128, bids: { "<cargo>": U128 }, stock: { "<cargo>": U128 } } } }]`, one point per hour |
| `advice` | `{ broker }` | `{ action: "none" or "export" or "stance", token_id?, amount: U128?, stance: u32?, memo }` (the default policy, used by the agent runner) |

- **Quote:** `{ token_id, price: U128, reason }`.
- **Manifest:** `{ run_id, started_at, containers: [{ spot: u32, token_id, amount: U128 }], wrecks: [Wreck] }`.
- **Wreck:** `{ id, spot: u32, owner, callsign, items: [{ token_id, amount: U128 }], at }`.

## Calls

| Method | Args | Who | Returns |
|---|---|---|---|
| `register` | `{ account_id, callsign }` | the faucet account | `Profile` |
| `start_run` | `{ gear: [token_id] }` | a registered player | `Manifest` |
| `extract` | `{ run_id, opened: [u32 spot], wrecks: [u64 id] }` | the run's player | `{ minted: { "<cargo>": U128 }, haul_value: U128 }` |
| `die` | `{ run_id, opened: [u32], wrecks: [u64], spot: u32 }` | the run's player | `{ wreck_id: u64? }` (null when nothing was carried) |
| `sell` | `{ broker, token_id, amount: U128 }` | player | `{ paid: U128 }` |
| `buy` | `{ broker, token_id, amount: U128 }` | player | `{ cost: U128 }` |
| `invest` | `{ broker, amount: U128 }` | player | `{ shares: U128, reopened: bool }` |
| `list` | `{ token_id, amount: U128, price: U128 }` | player | `{ id }` |
| `buy_listing` | `{ id }` | player | `{ paid: U128 }` |
| `cancel_listing` | `{ id }` | the seller | `{}` |
| `broker_export` | `{ token_id, amount: U128, memo }` | the broker's account | `{ earned: U128, dividend: U128 }` |
| `broker_stance` | `{ stance: u32, memo }` | the broker's account | `{}` |
| NEP-245 `mt_transfer` / `mt_batch_transfer` | as in NEP-245 (1 yoctoNEAR deposit, as the standard requires) | holder | as in NEP-245 |

### Callsigns

Callsigns are 3–16 characters from `A–Z 0–9 - . _ space`, stored upper-case, and unique.

### Errors

| Code | Meaning |
|---|---|
| `E_NOT_REGISTERED` | Not registered |
| `E_ALREADY_REGISTERED` | Already registered |
| `E_CALLSIGN_TAKEN` | Callsign taken |
| `E_BAD_CALLSIGN` | Bad callsign |
| `E_NOT_FAUCET` | Only the faucet account can call this |
| `E_NOT_BROKER` | Only the broker's own account can call this |
| `E_NO_RUN` | No such run |
| `E_RUN_CLOSED` | The run is already closed |
| `E_TOO_SOON` | Too soon: under 30 s between runs, or a run that ended faster than the minimum |
| `E_NOT_IN_MANIFEST` | Not in this run's manifest |
| `E_OVER_LIMIT` | Over the carry limit |
| `E_DUPLICATE` | Listed twice |
| `E_BROKER_CLOSED` | The broker is closed |
| `E_BROKER_BROKE` | The broker can't cover the sale |
| `E_DOESNT_BUY` | The broker doesn't buy this |
| `E_DOESNT_SELL` | The broker doesn't sell this |
| `E_FUNDS` | Not enough scrip or items |
| `E_NO_GEAR` | Equipping gear you don't have |
| `E_EXPORT_COOLDOWN` | An export within the hour |
| `E_EXPORT_STOCK` | Exporting more than the broker holds |
| `E_STANCE_RANGE` | Stance outside 80–120 |
| `E_NO_LISTING` | No such listing |
| `E_BAD_AMOUNT` | Zero or too large |
