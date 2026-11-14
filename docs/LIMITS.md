# Limits, in full

The README lists the ones that matter to a player. These are all of them.

## Trust

- **Raid results come from the client.** The contract enforces the manifest, the carry limit, minimum raid times
  (45 s + 8 s a container) and one raid at a time, but it can't see the fight. A launch would need a server that
  replays raids and signs the result; until then a modified client could report a raid it didn't play, within those
  limits.
- **The contract account holds a full-access key on testnet.** Inside the contract the owner account can only pause
  it. But the account `v2.saltline.testnet` itself still has a full-access key held by the team, which is how its code
  was upgraded during the hackathon (with every existing view unchanged, rehearsed in a sandbox first:
  `contract2/upgrade.sh`). Before a mainnet launch that key would be removed or handed to a multisig, leaving the
  rules as deployed.
- **Players can shoot each other in Skirmish only.** A hit is the shooter's browser telling the other player's
  browser "I hit you"; the one who was hit decides whether to believe it (in reach, no more than a gun does, no
  faster than a gun fires). That is one browser's word against another's, and a changed client could ignore every
  hit. In Skirmish nothing is at stake. In Practice and in a raid on the chain players see each other and cannot hit
  or be hit, because a death on the chain costs a real gun.

## Accounts and keys

- **Without sign-in (a local run), the guest wallet's key lives in this browser's storage.** Clearing it loses the
  account. Testnet only.
- **With sign-in on, the studio holds the keys.** A player signs in with Google (through Privy). Their NEAR key is
  derived on the server from that sign-in and one server secret, which lets the same sign-in open the same account
  on any device and lets the faucet give one dock pass per sign-in. It also means whoever holds that secret could sign
  as any player: acceptable on testnet only; a launch would move the key to the login provider's own custody.
  Sign-in is off unless the deployment sets `VITE_PRIVY_APP_ID`, `PRIVY_APP_ID` and `WALLET_SECRET`
  (see `.env.example`). It is on at https://saltline-lac.vercel.app since 14 Nov 2026; a local run without those
  settings stays open, with the guest wallet below.
- **The faucet's per-IP limits are kept in memory** on each serverless instance. The lasting guards are one
  registration per account and never funding an account that already exists.

## Other players

- **Seeing other players is presence, not a shared raid.** Breachers in a raid at the same moment appear in each
  other's yard as figures with their callsign ([`src/economy/v2/squad/`](../src/economy/v2/squad)). Each player's
  machines, containers and invoice are still their own.
- **Peer to peer.** The browsers talk to each other directly (WebRTC), having met through public Nostr relays this
  project doesn't run, so players in the same yard can see each other's network address, as in any peer-to-peer
  game. There is no relay server to fall back on, so two players behind strict firewalls may not connect. What
  arrives from another browser is checked field by field. `?squad=0` switches it off.

## The characters

- **Moss, Ines and the Harbormaster act when people play.** Each signs its own moves with its own key, following
  fixed rules in character ([`agents/v2/`](../agents/v2)). A round runs when someone visits, at most once every 10
  minutes per server instance (`server/tick.ts`); there is no scheduler for v2.

## Data

- **The studio keeps a small database of who signed in and how many came, when one is configured.** One record per
  sign-in (Privy id, NEAR account, callsign, first and last seen) and daily counts of visits, sign-ins, passes and
  raids. No email, IP address or key is stored; devices and sign-ins enter the counts only as salted hashes, and the
  counts a browser reports can be inflated by anyone who posts them. The game never depends on it, and it is off
  until the deployment has a database. [`docs/DATA.md`](DATA.md) lists every key.

## Not tested

- Safari, Firefox and gamepads. Touch was exercised in a phone-shaped desktop browser and on the lobby; a raid on a
  real phone has not been played through.
- More than a handful of players at once. The contract caps dock passes at 2,000.
- **Vercel's checkpoint:** a burst of scripted requests can make Vercel show its security checkpoint (HTTP 403) for a
  few minutes. If you see it, wait and reload, or run the game locally.
