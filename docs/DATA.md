# Saltline: the database (users and metrics)

What the studio keeps about who plays, where it is kept, and how to read it. The chain is still the record of the
game itself: accounts, guns, raids and scrip live on the contract. This database answers two things the chain can't:
**who signed in** and **how many people came, and how far they got**.

Three rules hold everywhere below.

- **The game never depends on it.** With the database off, slow or failing, sign-in, the dock pass and play behave
  exactly as they do with no database. Anything the server writes while answering a player is given one second and
  then left behind (`server/store.ts` → `quietly`, `server/record.ts`).
- **Unknown is not zero.** A number that couldn't be read is `null` in the API and "unknown" in the table, and so is
  every number for a day before counting began. Only a counter that was read and never added to is `0`.
- **No secret and no raw id goes into the counts.** No email, IP address or key is stored anywhere. Devices and
  sign-ins enter the metrics only as salted hashes.

Code: `server/store.ts` (the database), `server/users.ts`, `server/counts.ts`, `server/record.ts`,
`server/metrics.ts` (`POST /api/metrics`), `server/stats.ts` (`GET /api/stats`), `src/economy/v2/metrics/` (the
browser), `scripts/stats.mjs` (`npm run stats`).

## Where it lives

| Store | When | What it is |
|---|---|---|
| **Upstash Redis** | the deployed game, once its two settings exist | Upstash's REST API, called with plain `fetch`. Commands issued together go as one `POST /pipeline`. A request gets 2 s; nothing is retried. |
| **A JSON file** | `npm run dev` | `.saltline.local/store.json` (in `.gitignore`). The same commands over a file, so no cloud account is needed. It keeps each HyperLogLog as the plain set of its (hashed) members, so its counts are exact rather than estimates. |
| **Memory** | tests | The same again, gone when the test ends. |
| **Off** | nothing configured | Every write is skipped and every read answers unknown. |

Half-set or malformed settings mean off, with the setting's name (never its value) in the log.

The dev server uses the file even when `.env` holds the Upstash settings, so a local run can't write to the deployed
database by accident. `SALTLINE_STORE=upstash` in `.env` opts in.

Every key starts with `saltline:`. On a Vercel preview deployment the prefix is `saltline:preview:` (and
`saltline:development:` under `vercel dev`), read from Vercel's own `VERCEL_ENV`, so a preview that shares the
production database keeps its own numbers.

## Users

One record per sign-in, written by the server when it sees the sign-in itself:

| When | What is written |
|---|---|
| `POST /api/session` hands a sign-in its wallet | account, first seen (once), last seen, `sessions` + 1 |
| the faucet issues a v2 dock pass to a signed-in player (after the chain confirms it) | callsign, pass time (the first one is kept), last seen |
| a signed-in page load proves itself to `POST /api/metrics` (its token verifies) | account, first seen (once), last seen, `visits` + 1 |

| Field | Meaning |
|---|---|
| `accountId` | the NEAR account derived for the sign-in (public on chain) |
| `firstSeen`, `lastSeen` | milliseconds since 1970, UTC |
| `sessions` | times the dock office handed over the wallet: about once per browser the player has used |
| `visits` | signed-in page loads |
| `callsign`, `passAt` | from the dock pass; absent until one is issued through this server |

**Not stored:** an email address or name (the server never has one: a sign-in is checked with Privy's public keys
only, Privy's API is never called and the app secret is never used), an IP address, any private key or token.

A refused sign-in, a refused or already-held pass, a pass still unconfirmed, the first game's passes and guest passes
(sign-in off) write no record. Players who got their pass before the database was switched on appear the next time
they load the game signed in, without a pass time: the chain has it, this database doesn't.

## Metrics

### From the browser

`src/economy/v2/metrics/` sends `{ "e": "<event>", "d": "<device id>" }` to `POST /api/metrics`.

| Event | Sent when | Counted as |
|---|---|---|
| `visit` | once per tab session, when a person shows up | the day's visits; the device in the day's devices |
| `signin` | once per tab session, when the sign-in gate opens. Carries the sign-in token | only if the server verifies the token: the day's verified sign-ins, the funnel's "signed in", and the user's record |
| `pass` | once per tab session, the first time the dock opens or a raid is signed (both need a dock pass) | the funnel's "got a pass" |
| `dock_open` | each time the dock opens (not each tab inside it) | the day's dock opens |
| `raid_start` | the game's `raid:started`: the contract signed a raid | raids started; the funnel's "started a raid" |
| `raid_extract` | `raid:extracted` with `ok`: the contract confirmed the extraction | raids extracted; the funnel's "extracted" |
| `raid_death` | `raid:died` | raids died |
| `practice_start` | `run:start` in Practice (the offline game) | practice starts. In Practice none of the five rows above is sent |
| `heartbeat` | once a minute while the tab is visible | keeps the device in "online now"; counts nothing else |

The first game (v1) sends nothing: only v2 has this module.

### On the server, where it happens

Not taken from any browser: `session_issued` when `/api/session` hands over a wallet (also a verified sign-in for
the day), and `pass_issued` when the faucet issues a v2 dock pass, signed-in or guest. "Passes" in the stats is this
server count, not the browser's `pass`.

### Who gets counted

The aim is players, not page loads. Five checks stand between a request and a count:

1. **Someone is actually there.** The browser module sends nothing until the page is visible and has had one
   trusted input: a key, click, touch or wheel that the browser itself raised (`isTrusted`, which a script's
   `dispatchEvent` can't set). Events before that wait in a queue of 16. A headless visit, a prerender or a
   background tab that is never looked at sends nothing.
2. **Not a crawler or a script.** The server drops requests whose user agent is a crawler, a link preview, a
   headless browser or a command-line client, and requests with no user agent. (So the repo's own smoke and
   end-to-end runs, which use headless Chrome, count for nothing.)
3. **Exactly one event.** One name from the list above, one 32-hex device id, no other field, at most 256 bytes.
   Anything else is dropped.
4. **Within the rate limits**, kept in memory per server instance: 240 beacons a minute per client address, 40 per
   device.
5. **A sign-in proves itself.** `signin` counts only with a token the server can verify.

The endpoint answers 204 to everything, dropped or counted, so it tells a caller nothing.

What this does not stop: a script that sends a browser's user agent can post `visit`, `raid_start` and the rest and
inflate those counts, within the rate limits. Sign-ins, sessions, passes and the user list can't be inflated that
way, and the chain remains the truth about raids.

### Privacy

- **No IP address is written anywhere.** It is used for the rate limit, in the function's memory, and dropped.
- **The device id** is 16 random bytes made in the browser and kept in its `localStorage` (`saltline.device.v1`). It
  is derived from nothing: not a fingerprint, not the wallet, not the sign-in. Clearing site data makes a new one.
- **In the metrics, a device or a sign-in is only ever** `HMAC-SHA256(salt, kind + ":" + id)` cut to 128 bits, and it
  goes into HyperLogLogs (which can be counted, not listed) and the online set. The raw Privy id appears only as the
  key of that player's own user record.
- **The salt** is `METRICS_SALT`. Without one it is derived from `WALLET_SECRET` as
  `HMAC-SHA256(WALLET_SECRET, "saltline:v2:metrics-salt")`: one-way, so the salt can't be turned back into the secret
  and signs nothing. A `METRICS_SALT` that is set but shorter than 16 characters closes the door (nothing is counted)
  rather than falling back. With no salt at all nothing is counted. Changing the salt changes every hash: that day's
  devices and sign-ins may be counted twice, and nothing else breaks.
- **In the browser:** `saltline.device.v1` in `localStorage`, and `saltline.metrics.sent.v1` in `sessionStorage`
  (which of visit / signin / pass this tab has already sent). No cookie is set.

## Every key

All under the prefix above (`saltline:` in production).

| Key | Type | Holds | Kept |
|---|---|---|---|
| `user:<privy id>` | hash | `accountId`, `firstSeen`, `lastSeen`, `sessions`, `visits`, `callsign`, `passAt` | until deleted |
| `users` | sorted set | every Privy id, scored by first seen: the count, and newest-first | until deleted |
| `m:day:<YYYY-MM-DD>` | hash | the UTC day's counters: `visit`, `signin`, `pass`, `dock_open`, `raid_start`, `raid_extract`, `raid_death`, `practice_start`, `session_issued`, `pass_issued` | 90 days |
| `m:day:<day>:devices` | HyperLogLog | hashed devices heard from that day | 90 days |
| `m:day:<day>:users` | HyperLogLog | hashed sign-ins the server verified that day | 90 days |
| `m:day:<day>:did:signin` · `:did:pass` · `:did:raid_start` · `:did:raid_extract` | HyperLogLog | hashed devices that reached that funnel step that day | 90 days |
| `m:online` | sorted set | hashed device → when it was last heard from. Entries older than 10 minutes are removed whenever a visit arrives | 10 minutes |
| `m:since` | string | when counting began (ms). Days before it read as unknown | until deleted |

Cost: an event is three or four Redis commands in one round trip (a verified sign-in about nine), a heartbeat is
one, and reading the stats is about 55 in one round trip. Upstash's free plan allows 500,000 commands a month
(upstash.com/docs/redis/overall/pricing, read 14 Nov 2026).

To remove one player: `DEL saltline:user:<privy id>` and `ZREM saltline:users <privy id>` in the Upstash console.
Their hashes in the daily sets can't be picked out, and expire with the day.

## Reading the numbers

`GET /api/stats` with `authorization: Bearer <STATS_ADMIN_TOKEN>`:

- **404** when no `STATS_ADMIN_TOKEN` is configured (or it is under 16 characters): the page isn't there.
- **401** when the token is missing or wrong. Compared in constant time; 30 asks per 10 minutes per client address.
- **200** otherwise, never cached:

```jsonc
{
  "ok": true,
  "at": "2026-11-14T12:00:00.000Z",
  "store": "upstash",                              // or "file", "memory", "off"
  "recordingSince": "2026-11-14T09:30:00.000Z",    // null: nothing counted yet
  "onlineNow": 3,                                  // devices heard from in the last 2 minutes
  "totalUsers": 41,
  "today": { "day": "2026-11-14", "visits": 120, "devices": 87, "signIns": 30, "sessions": 22, "passes": 19,
             "raidsStarted": 64, "raidsExtracted": 25, "raidsDied": 31, "dockOpens": 140, "practiceStarts": 52 },
  "days": [ /* the 14 days before today, newest first, the same fields; null where unknown */ ],
  "funnel": { "days": 15, "visited": 87, "signedIn": 30, "gotPass": 21, "startedRaid": 18, "extracted": 11 }
}
```

- `signIns` is distinct sign-ins the server verified that day; `sessions` is wallets handed over; `passes` is dock
  passes the faucet issued.
- The funnel is distinct devices at each step over today and the 14 days before it. "Got a pass" means a device
  whose account was seen holding one, so it includes players whose pass is older than the window.
- `?users=N` (1 to 200) adds `users`: the newest N sign-ins, with their Privy id, account, callsign and times.

From a terminal:

```sh
npm run stats                                               # asks STATS_URL, default the local dev server
npm run stats -- --url https://saltline-lac.vercel.app/api/stats
npm run stats -- --users 20                                 # also the 20 newest sign-ins
npm run stats -- --json                                     # the raw answer
```

`STATS_ADMIN_TOKEN` and `STATS_URL` are read from the environment, else from `.env`. The token is sent in the header
and never printed. The script refuses a non-https address unless it is this machine.

There is no dashboard page yet.

## Switching the database on

Nothing is kept until the deployment has these. All are server side: no `VITE_` prefix.

| Setting | Needed | What it is |
|---|---|---|
| `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` | yes | the Upstash Redis database's REST address and token. `KV_REST_API_URL` + `KV_REST_API_TOKEN` (the names Vercel's integration uses) are accepted as the same pair |
| `STATS_ADMIN_TOKEN` | to read stats | 16+ characters. `openssl rand -hex 32` |
| `METRICS_SALT` | no | 16+ characters. Without it the salt is derived from `WALLET_SECRET` (above) |
| `SALTLINE_STORE` | no | `off` to switch the database off without removing its settings; `file` and `upstash` are for local dev |

1. **Create the database.** Either in Vercel (the project → Storage → Create Database → Upstash → Redis; pick the
   free plan and the region nearest the functions; connect it to the project), or at console.upstash.com (Create
   Database → Redis) and copy `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` from its REST API box into the
   Vercel project's environment variables.
2. **Check the names.** In the project's Settings → Environment Variables there should be either the `UPSTASH_…`
   pair or the `KV_REST_API_…` pair, for Production. If the integration was connected to Preview too, previews write
   under their own prefix.
3. **Add `STATS_ADMIN_TOKEN`** for Production, marked Sensitive. Keep a copy in your own `.env` (never committed).
4. **Redeploy.** Environment variables reach only new deployments.
5. **Check it.** `npm run stats -- --url https://saltline-lac.vercel.app/api/stats` should print `store: upstash`.
   Open the v2 game (`?game=v2` where the deployment doesn't default to it), press a key, and run it again: one
   visit, one device, one online. If it prints `store: off`, the function's log names the setting that is missing or
   malformed.

To switch it off again: set `SALTLINE_STORE=off` (or remove the two database settings) and redeploy.

## Limits, stated plainly

- **Not yet run against a real Upstash database.** The adapter was written from Upstash's REST documentation and is
  tested against a stand-in that speaks those documented shapes. The first real request happens when the settings
  above are added.
- **Browser counts are what browsers report** (see "Who gets counted").
- **Rate limits are per server instance**, in memory, like the faucet's.
- **A day is a UTC day.** There are no all-time totals beyond the user count, and no per-country or per-device-type
  breakdown.
- **Days roll off after 90.** The stats API shows the last 15.
- **Ad blockers** that block `/api/metrics` hide that player from the browser counts. Their sign-in, session and pass
  are still counted on the server.
