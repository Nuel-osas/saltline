# The broker agents

Saltline's three dockside brokers are NPCs with their own NEAR wallets. Each is a real testnet account with its own
key, and it signs its own transactions:

| Broker | Account | Buys | Character |
|---|---|---|---|
| Moss | `moss.saltline.testnet` | copper, chips | Hates sitting on stock |
| Ines | `ines.saltline.testnet` | meds, fuel | Keeps a fat float |
| Quartermaster | `qm.saltline.testnet` | core, fuel | Spends fast |

The game contract (`saltline.testnet`) holds their stock and scrip and enforces every rule. An agent has two levers:

- `broker_export({ token_id, amount, memo })` ships stock to the freighter, at most once an hour per item.
- `broker_stance({ stance, memo })` tilts its bids, from 80 to 120.

The memo is the agent's reason. It shows on the ledger and in the Dockside tooltips: "Freighter's in. Shipping 14
coils before they rust."

## A round

For each broker in turn, `brokers.ts` does this:

1. It reads `brokers()` and `advice({ broker })`. The advice is the contract's default policy
   (`contract/src/policy.rs`), and it already knows each item's export cooldown.
2. It decides with that broker's character on top of the advice (`characters.ts`).
3. It writes a one-line memo of at most 90 characters, and signs the call with that broker's key.
4. It prints a line with the broker, status, action, memo, and the tx hash or the reason it held:

```
2026-11-11T13:15:00Z  moss  sent      export 8 copper    "Freighter's in. Shipping 8 coils before they rust."  tx 9ZQ7…
2026-11-11T13:15:00Z  ines  sent      stance 95          "Float's under 1300. Tightening early: stance 95."  tx 4kPq…
2026-11-11T13:15:00Z  qm    skipped   hold               (no key: set BROKER_QM_KEY or add ~/.near-credentials/testnet/qm.saltline.testnet.json)
```

Each broker makes at most one move per round, and an export the advice suggests always comes first.

### The characters

All three ship when the advice says ship. On top of that:

- **Moss** hates sitting on stock.
  - When she's shut, she ships down to a quarter of target. The advice stops at half.
  - While her shed is over target and the freighter won't take it yet, she bids 5 lower each round, down to 80.
    She never bids up into a full shed.
  - Once the shed is clear, she brings her stance back towards 100, if she has at least 700 scrip.
- **Ines** keeps a fat float.
  - Under 1,300 scrip she lowers her stance by 5. The default policy waits until 1,000, and below that she takes
    its 10-point cut.
  - She only bids up when she has more than 3,000 scrip.
- **The Quartermaster** spends fast.
  - When relay cores are flowing (at least 4 on the shelf, the target) and he has 800 scrip or more, he pushes his
    stance up 5, to 120.
  - When the advice says the till is thin, he still takes its cut.

### Fail closed

- **A failed read means no action.** If `brokers()` or a broker's `advice` fails, or the reply doesn't decode, that
  broker holds and its line says `state unknown`. A missing or malformed number is unknown, never 0.
- **Moves are checked against the board.** A move that doesn't add up is a hold: an export of cargo the broker
  doesn't buy, or more than it holds, or a stance outside 80 to 120.
- **The contract names the signer.** A broker whose account on the board isn't `<broker>.<contract>` holds. A bad
  board can never make a local keychain key sign for an account it wasn't meant for.
- **Refusals aren't retried.** A contract refusal (`E_EXPORT_COOLDOWN`, `E_NOT_BROKER`, any `E_…`) is logged and
  skipped, and never re-sent. In `--loop`, the refused move sits out an hour. After `E_NOT_BROKER`, the broker sits
  out the rest of the run.
- **Transient RPC failures** (timeouts, 429s, 5xx) are retried with backoff across the RPCs, through
  `src/economy/chain.ts`. A transaction that may have landed is only ever re-sent as its identical signed bytes. One
  that can't be confirmed is reported as `pending`, never as failed.

## Running it locally

Node 26 runs the TypeScript directly. `ts-hook.mjs` lets Node resolve the repo's `.js` import paths to their `.ts`
files, so there's no build step. `tsx agents/brokers.ts` works as well, without the hook.

```sh
npm ci
node --import ./agents/ts-hook.mjs agents/brokers.ts --dry-run          # decide and print, sign nothing
node --import ./agents/ts-hook.mjs agents/brokers.ts --once             # one real round
node --import ./agents/ts-hook.mjs agents/brokers.ts --loop 10          # a round every 10 minutes, Ctrl-C to stop
node --import ./agents/ts-hook.mjs agents/brokers.ts --once --seed 3    # pin the memo wording
```

- `--dry-run` works without keys. It shows each decision and who would sign it.
- **Exit codes:**
  - 0: every broker acted, held or was skipped for a known reason.
  - 1: bad arguments or config.
  - 2: some broker's state or outcome was unknown.

### Keys

For each broker, the agent looks for a key in this order:

1. The env variable `BROKER_MOSS_KEY`, `BROKER_INES_KEY` or `BROKER_QM_KEY`, holding an ed25519 secret key
   (`ed25519:…`). It can come from `.env`, which is never committed.
2. Otherwise, the legacy near-cli keychain file `~/.near-credentials/testnet/<broker>.saltline.testnet.json`. This
   is the file `near account import-account … save-to-legacy-keychain` writes.

- An env key that is set but malformed is refused. The agent doesn't fall back to the keychain, so a typo never
  signs with a different key than the one you meant.
- A broker without a key is skipped with a line that says where to put one. The other brokers still run.
- **Keys are never printed.** Every line passes through `redact()`, which hides anything shaped like a NEAR key and
  every loaded key verbatim.

**Optional env:**

| Variable | Default |
|---|---|
| `CONTRACT_ID` | `saltline.testnet` |
| `NEAR_RPC` | comma-separated https RPCs: FastNEAR, then `rpc.testnet.near.org` |
| `NEAR_NETWORK` | `testnet`, the only network it accepts |

### The optional LLM voice

Set `NEAR_AI_API_KEY` and NEAR AI Cloud rewrites each signed memo in the broker's voice.

- **The service:** NEAR AI Cloud's OpenAI-compatible API at `https://cloud-api.near.ai/v1`, through `POST
  /chat/completions`.
- **The model:** `Qwen/Qwen3.6-35B-A3B-FP8` by default, one of its private (TEE) models. `NEAR_AI_MODEL` overrides
  it.

**The LLM never moves money.**

- The move is fixed by the deterministic policy before the LLM is asked, and the LLM only ever returns text.
- A rewrite is thrown away, in favour of the templated memo, if it:
  - runs over 90 characters or the contract's 160 bytes
  - spans more than one line
  - contains markup
  - contains a number that isn't in the facts it was given
- Holds aren't sent to the LLM.

Without the key, the memos come from templates in `characters.ts`, chosen by a seed. The seed is the current
15-minute slot, or `--seed`, so tests are stable.

## The cron

`.github/workflows/brokers.yml` is scheduled to run one round (`--once`) every 15 minutes, and can be run on demand from the Actions tab. GitHub hasn't fired the schedule on this repo so far, so the live site also wakes the brokers when people play: `POST /api/tick` (`server/tick.ts`) runs the same round on Vercel at most once every 10 minutes, with the keys in Vercel's sensitive env.
**Run workflow** has a dry-run box. The workflow uses:

- `contents: read` permissions only
- Node 26.4.0, with actions pinned by commit
- `npm ci --ignore-scripts`
- a 10-minute job timeout
- one round at a time, so two runs never race for a broker's nonce

**Repository secrets** to add, under Settings → Secrets and variables → Actions:

| Secret | What |
|---|---|
| `BROKER_MOSS_KEY` | ed25519 secret key for `moss.saltline.testnet` |
| `BROKER_INES_KEY` | ed25519 secret key for `ines.saltline.testnet` |
| `BROKER_QM_KEY` | ed25519 secret key for `qm.saltline.testnet` |
| `NEAR_AI_API_KEY` | optional: the LLM voice |

The optional repository variables are `CONTRACT_ID`, `NEAR_RPC` and `NEAR_AI_MODEL`.

- A missing broker secret skips that broker with a warning.
- A run goes red only when some broker's state or outcome is unknown.

## The trust model

**The agents can only do what the contract allows their accounts to do.**

- **The contract enforces every rule.** A broker account can call `broker_export` and `broker_stance`, for its own
  desk only (`E_NOT_BROKER` otherwise). Exports are capped by stock and by the hourly cooldown, and stances by the
  80 to 120 range. Prices, closing, reopening and dividends follow `pricing.rs`, whatever the agent wants.
- **A leaked broker key can't drain the economy.** It can ship that broker's stock to the freighter, at most once an
  hour per item and at the fixed export price, which pays the broker. It can move the broker's stance within 80 to
  120. It can't mint scrip any other way, move a player's goods, or touch the other brokers.
- **It can spend the account's testnet NEAR on gas.** So each broker account should hold only gas money.
- **Ideally, use a function-call access key** limited to `saltline.testnet`. A full-access key can also move the
  account's NEAR.
- **Anyone can audit the brokers.** Every export and stance change is a signed transaction from the broker's own
  account, with its memo on the ledger (the `export` and `stance` events, and `last_memo` in `brokers()`).
- **The LLM, when on, writes words only.** It can't change an action, an amount or a stance, and a memo that cites
  a number the move doesn't contain is never signed.

## v2: the characters with wallets

Saltline v2 (`docs/GAME.md`) has three characters, each a testnet account that signs its own moves on the v2
contract (`v2.saltline.testnet`). `agents/v2/characters.ts` holds their rules; `agents/v2/run.ts` runs a round with
the same runner as above (fail closed, one move a round, refusals logged and never re-sent, keys never printed).

| Who | Account | Calls it may sign | What it can't do |
|---|---|---|---|
| **Moss**, the armourer | `moss.saltline.testnet` | `vendor_build` (guns and mods, from her own parts), `vendor_price` (her own guns), `export` (her own stock) | Build without the parts, touch a player's gun, change what she pays for parts (the contract's curve does), mint scrip any way but the export desk |
| **Ines**, the quartermaster | `ines.saltline.testnet` | `vendor_build` (plates, charges, magazines), `export` | The same; and she can't build guns or mods (`E_DOESNT_SELL`) |
| **The Harbormaster** | `harbormaster.saltline.testnet` | `hm_posture` (`patrols` or `pursuit`) | Anything else. It can't bill, fine, mint or take. Its strength is its balance, which only players' payments fill and which halves every 12 hours |

### Their rules

One move a round each, the first rule that fits. A move that doesn't add up against the board is a hold.

**Moss** (blunt, measures everything in tonnes, hates waste):

1. A fresh A or B still at the default price (125% of appraisal) is priced up: A at 150%, B at 135%.
2. With fewer than 4 guns for sale and the parts for one, she builds the frame her rack lacks. With every frame
   racked, she builds the one with the most sales on the market (`economy().lastSales`), and with no sales to go
   on, a Longshore.
3. A gun unsold over 6 hours is marked down 10%, once for each 6 hours it has sat, never under 90% of appraisal.
4. With 3 or more guns racked, she makes a mod she has fewer than 2 of.
5. Materials held over twice their target go to the freighter, at most 6 units a round.

**Ines** (warm, a ruthless haggler, careful with the clinic's money):

1. A shelf under 6 plates, 8 charges or 24 magazines is restocked when she has the parts, the shortest shelf first.
2. With under 600 scrip, fuel or electronics held over twice their target go to the freighter, at most 6 a round.
3. Otherwise she holds.

Neither ships while the desk pays under half the book price for that material (`EXPORT_MIN_PCT`).

**The Harbormaster** (polite, procedural, sincere):

1. It reads the last 20 raid endings in `recent`: `extract` lines against `wreck` and `impound` lines.
2. `pursuit` when extractions are more than twice the deaths and its strength is at least 25; otherwise `patrols`.
3. It signs only when the posture changes: "Recoveries are below forecast. Collections have been prioritised."

### Running them

```
node --import ./agents/ts-hook.mjs agents/v2/run.ts --once --dry-run    # decide and print, sign nothing
node --import ./agents/ts-hook.mjs agents/v2/run.ts --once              # one round
node --import ./agents/ts-hook.mjs agents/v2/run.ts --loop 10           # a round every 10 minutes
```

| Variable | What |
|---|---|
| `BROKER_MOSS_KEY`, `BROKER_INES_KEY` | The same accounts and secrets as v1's Moss and Ines |
| `HARBORMASTER_KEY` | ed25519 secret key for `harbormaster.saltline.testnet` |
| `CONTRACT_ID_V2` | default `v2.saltline.testnet` |
| `NEAR_RPC`, `NEAR_NETWORK`, `NEAR_AI_API_KEY`, `NEAR_AI_MODEL` | as above |

- Without an env key, the keychain file `~/.near-credentials/testnet/<account>.json` is used. A character with no
  key is skipped; the others still run.
- A character moves only when every view its rules read came back: `vendors` and `export_prices` for both vendors,
  `economy` for Moss too, `harbormaster` and `recent` for the Harbormaster.
- One exception: while the deployed contract has no `economy` view (`METHOD_NOT_FOUND`), Moss reads "no sales" and
  still moves. Any other failure of that read holds her.
- `export` takes no memo on the contract, so an export's memo is in the agent's log line only.
- On the live site, `POST /api/tick?game=v2` (`server/tick.ts`) runs one v2 round when people play, at most every
  10 minutes, on a clock separate from v1's. It answers 503 when none of the three keys is set.
- A leaked key can do only what the table above lists for that account, plus spend its gas.
