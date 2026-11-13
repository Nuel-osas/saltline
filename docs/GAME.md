# Saltline v2: an extraction shooter with a real economy

The design the owner asked for on 13 Nov 2026: break the first design and rebuild it as an extraction shooter
where weapons are NFTs that players buy, risk, lose and resell, and where greed summons the machine that hunts you.
**Nothing here is built until the owner approves this plan.** Once approved, this file replaces `docs/ECONOMY.md`
and `docs/CAMPAIGN.md` as the source of truth; `docs/STORY.md` stays as the world and the voice.

## The game in one paragraph

You are a Breacher. You pick a gun you own, go over the fence into a port run by a machine that has impounded the
town, and take what you can carry. Everything you take goes on **the invoice**, and when the invoice gets big
enough the Harbormaster sends **the Bailiff**, which walks, cannot be destroyed, and does not stop. Reach the boat
and you keep it all. Die and everything you carried, your gun included, stays in the yard for the next player.
Back at the dock you build, repair, buy and sell guns. Every gun in the game was built by a player or a vendor
from parts somebody carried out, and every one that is lost is gone.

## Why the first economy failed

- **It was a trading screen.** Price boards, stock bars and charts beside a shooter, not inside it.
- **Money bought nothing.** Three small boosts. Nothing to want, own or lose.
- **Nothing was at risk.** You could never lose anything you cared about, so nothing had value.
- **The goods were dull.** Copper and medicine sold to brokers is a spreadsheet, not a fantasy.

## Four rules the new design is built on

1. **The gun in your hands is the economy.** It was built from looted parts, it has an owner history, and it can
   be lost.
2. **Risk is what makes value.** You choose what to bring. You can lose it. Someone else can find it.
3. **Greed is the difficulty.** The invoice turns what you take into danger, in plain sight.
4. **The player never sees the chain.** No wallet popups or seed phrases. Ownership is real underneath.

## The loop

```
        ┌────────────────────────── THE DOCK (hub) ──────────────────────────┐
        │  Stash · Loadout · Armoury (build, mod, repair) · Market · Vendors  │
        └───────┬───────────────────────────────────────────────▲────────────┘
     choose what to risk                              keep it all, plus wear
                │                                               │
                ▼                                               │
   ┌──────────────── THE RAID (5–8 minutes) ────────────────┐   │
   │ loot containers · kill machines for parts · cut uplinks │───┘  the boat
   │ every action adds to THE INVOICE → patrols → the Bailiff│
   └───────────────────────────┬─────────────────────────────┘
                               │ death
                               ▼
      your gun and loot become a WRECK in other players' raids,
      or are IMPOUNDED if the Bailiff took you (buy back, or lose it)
```

## What you own

Everything below is a token on NEAR, held by the player's own account.

| Thing | Kind | Comes from | Leaves the game by |
| --- | --- | --- | --- |
| **Scrip** | Currency | Export sales only (see Money) | Fees, ammo, repairs, build fees, the invoice |
| **Materials**: copper, electronics, fuel cells, meds, relay cores, hound servos, gull rotors | Stackable | Containers and destroyed machines, carried out of a raid | Building, repairs, export |
| **Weapons** | **NFT**, one of a kind | Built from materials by a player or a vendor | Lost wrecks, impound not bought back, scrapping |
| **Mods**: barrel, magazine, optic, stock | Stackable by type and tier | Built | Fitted into a weapon for good |
| **Armour plates, breaker charges, ammunition** | Stackable, used up | Built or bought | Use |

## Weapons as NFTs

- **Frames.** Three at launch, all built on the game's generated rifle with different stats and finish:
  - **PAC-9 Longshore**: the carbine. Balanced.
  - **PAC-9K Stevedore**: short. Fast fire, small damage, quick handling.
  - **PAC-9M Pilot**: marksman. Slow, hard-hitting, long range.
- **Every gun is rolled when it is built.** Damage, fire rate, magazine, recoil, reload and range each land inside
  the frame's band, from the chain's own randomness. The roll gives a **grade** from D to A. An A-grade Pilot is
  rare because rolling one costs parts.
- **Serial, maker, history.** Each gun carries a serial number, the callsign that built it, and counters the
  contract updates: raids, extractions, owners, and whether it was ever pulled out of a wreck. The card reads like
  a history: `Built by ROOK · 14 extractions · 3 owners · recovered once`.
- **Condition.** 100 when built. It drops with every raid and faster if it sat in a wreck. Under 30 its stats
  suffer. Repairs cost scrip and copper. At 0 it can only be scrapped for parts.
- **Mods.** Four slots. A fitted mod changes the stats and stays with the gun when it is sold.
- **The issue rifle.** Every player always has one plain rifle that can't be sold or lost, so nobody is ever
  locked out. It is the worst gun in the game.
- **It is a standard NFT.** NEP-171, with its picture stored on chain (a generated drawing with the serial and
  grade), so it shows in any NEAR wallet and can be listed on any NEAR marketplace.
- **Maker royalty.** Whoever built a gun earns 2% every time it is resold, for as long as it exists.

## Risk: what happens to what you bring

| Outcome | Your gun and gear | Your loot |
| --- | --- | --- |
| **You reach the boat** | Kept, with wear | Yours |
| **Machines kill you** | It stays in a **wreck** where you fell. Your wreck appears in other players' raids. The first to carry it to the boat owns it. | In the wreck too |
| **The Bailiff kills you** | **Impounded.** For 48 hours you can buy it back from the Harbormaster for 40% of its value. After that it is destroyed. | Lost |
| **Nobody recovers the wreck in 24 hours** | Destroyed | Destroyed |

- The issue rifle is never lost.
- Armour and charges you used are gone either way; unused ones follow the gun.
- A recovered gun records it: `recovered from ROOK's wreck`.

## The invoice

The Harbormaster bills you for everything, and the bill is the danger.

**What adds to it**

| Action | Added |
| --- | --- |
| Entering | 150, plus 25 for each raid you have extracted from before (500 at most) |
| Each minute on site | 40 |
| Cutting a container seal | 60 |
| Each unit of cargo taken | 30 per unit of weight |
| Cutting an uplink | 50 |
| Destroying a gull / a hound | 15 / 35 |

**What it brings**

| Invoice reaches | The Harbormaster |
| --- | --- |
| 600 | **Second notice.** More Inspection Units on patrol. |
| 1,200 | **Final demand.** The Bailiff is sent. |
| 2,400 | A second Bailiff. |
| 4,000 | **Foreclosure.** The Assessor walks to the boat. |

- The three uplinks and the machines they bring cost little; greed costs most. A minimal raid ends near 800 and a
  careful full load near 1,130, just under the Bailiff. One more crate, a few more minutes or a wreck's gun tips it
  over. A careful player hears about the Bailiff and rarely meets it. A greedy one always does.
- The meter is on the HUD the whole time: `INVOICE 1,040 · BAILIFF AT 1,200`.
- **After the raid** the invoice is on your account as **arrears**. Half of your arrears (up to 1,500) are already
  on the meter when your next raid starts.
- **You can pay it.** Paying 1 scrip at the dock clears 2 of arrears. Every scrip paid goes into **the
  Harbormaster's own wallet**.
- **That wallet is its strength.** What it was paid in the last 12 hours sets how many extra machines every player
  faces. Paying your bill makes your next raid easier and everyone's raids harder.
- **Carrying arrears has an upside.** Above 1,000 in arrears the manifest adds **bonded containers** with better
  parts. Being wanted pays, if you survive it.

## Money

Scrip has value only if it is hard to make and easy to spend.

| Scrip enters by | Scrip leaves by |
| --- | --- |
| **Exports.** The export desk buys materials for the freighter and pays in new scrip. Each material's price falls as more of it is exported that day and recovers overnight. | **Build fees** (burned) |
| **The dock pass.** 150 scrip, once per player. | **Ammunition** (burned) |
| | **Repairs**: the scrip goes to Moss, the copper is burned |
| | **Market fee**: 4% of every sale (2% to the gun's maker, 2% burned) |
| | **The invoice** (to the Harbormaster, which spends it on machines) |
| | **Impound buy-backs** (to the Harbormaster) |

- **No one can mint.** There is no admin function that creates scrip, materials or guns. The only ways in are the
  rules above, in the contract.
- **The economy is public.** A view anyone can call returns the scrip supply, what was minted and burned in the
  last day, guns alive and destroyed, and the last sale price of each frame and grade.

**A raid, in numbers (targets for tuning)**

| | Scrip |
| --- | --- |
| Loot from a careful raid (4–6 weight) | 250–450 |
| Ammunition (4 magazines) | −48 |
| Repair after a raid | −20 to −40 |
| A plate and two charges | −114 |
| Building a Longshore (parts plus fee) | about 750 |
| Dying with a C-grade Longshore | −750, and someone else gains it |

A good player nets about 150–250 a raid. A dead one loses a gun. That gap is what makes a gun worth buying.

## The market

- **Fixed-price listings** for guns, mods and materials. The gun is held by the contract while listed.
- **A gun's card** shows its frame, grade, rolled stats against the frame's band, condition, mods, serial, maker
  and history, with the last five sale prices for that frame and grade.
- **Fees:** 4% of the sale. 2% to the maker, 2% burned.
- **Priced in scrip** on testnet. The same listing can be priced in NEAR, which is the path to mainnet (below).

## Characters with wallets

Each is a NEAR account with its own key, stock and scrip, run by an agent that signs its own moves. Each can run
out of money.

| Who | Business | What its agent decides |
| --- | --- | --- |
| **Moss, the armourer** | Buys parts. **Builds guns and mods from her own stock** and sells them. Repairs. | Which frame to build next from what she holds and what has been selling; her prices |
| **Ines, the quartermaster** | Sells plates, charges and ammunition, made from the fuel, electronics and copper she buys. Buys meds for the clinic, which uses them up. | What to stock; her prices |
| **The export desk** | Buys materials for the freighter. The only source of new scrip. | Nothing: its prices are the fixed curve in the contract |
| **The Harbormaster** | Collects invoices and impound fees. Spends them on machines. | How to spend its wallet: more patrol units, a faster Bailiff dispatch, or saving toward the Assessor |

The Harbormaster is the headline: **the villain has a wallet, and its difficulty is its balance.**

## Ways to play the economy

- **Raider:** go in, carry out, sell.
- **Gunsmith:** buy parts, roll guns, sell the good grades, earn royalties on every resale.
- **Trader:** buy low from a vendor who is overstocked, sell on the market.
- **Salvager:** go in light, find other players' wrecks, carry their guns out.
- **Outlaw:** carry heavy arrears for the bonded containers, and live with the Bailiff.

## Story

The world, the Harbormaster's billing voice and Control stay (`docs/STORY.md`). The invoice makes its lines
literal: "A trespass surcharge of 150 scrip has been added to your account" now adds 150 to a real meter.

Story is told the way extraction shooters tell it: through **contracts**. The five missions already designed
(`docs/CAMPAIGN.md`) become a chain of contracts from Control. Each one teaches a part of the game and unlocks a
frame or blueprints: the first Bailiff, the fuel manifold, the blackout, the Assessor. The contract chain is phase
2; the briefing, the radio and the Bailiff are in phase 1.

Live players in the same raid are not in this plan. Players meet through wrecks, the market and the Harbormaster
they all fund.

## On chain

- **One contract** on a new account, so the first version stays live until v2 is ready.
  - Stackable items: NEP-245. Weapons: NEP-171 with metadata and enumeration, implemented in the same contract so a
    raid can lock and move gear in one step.
  - `nft_payout` reports the maker's royalty, so outside marketplaces can honour it.
- **Custody.** Starting a raid locks the loadout in the contract. The boat returns it with wear and mints the
  loot. Death moves it into a wreck or the impound. A wreck not recovered in 24 hours is burned.
- **The invoice** is recorded when the raid ends, from what the contract can check: seals opened, cargo, uplinks,
  time, and kills up to a cap.
- **Events** for every mint, burn, transfer, build, sale, wreck, impound and payment, so the whole economy can be
  rebuilt from the chain.
- **No admin mint, no admin price.** The owner key can pause the contract and nothing else. Stated in the README
  and checked by a test.

## Trust: what is and isn't proven

- **Enforced by the contract:** who owns what, the loadout lock, the manifest (what a raid can contain), carry
  weight, minimum raid time, one raid at a time, every price, fee and royalty, wreck and impound timers.
- **Reported by the game client:** that you reached the boat, where you died, how many machines you destroyed. A
  modified client could lie about these.
- **What bounds the damage:** a raid can never mint more than its manifest; kills are capped; raids are
  rate-limited; a new account starts with nothing worth stealing.
- **Before real money:** raid results need a second witness (a server replaying the raid, or attested compute).
  This is the main piece of work between testnet and mainnet, and the README will say so.
- **Known abuse:** two accounts can pass a gun through a staged wreck. It costs them a raid and gains nothing the
  market wouldn't give them.

## The path to real value

- **Testnet now.** Scrip and guns are real tokens with no money value.
- **Mainnet:** guns are standard NFTs priced in NEAR or USDC on the open market. Scrip stays a soft in-game
  currency that the developer never sells. Revenue is a share of the market fee.
- **NEAR Intents** let a buyer pay for a gun with any asset on any chain. It is mainnet-only, so it is a later
  step.

## v1 to v2

| Kept | Replaced | Dropped |
| --- | --- | --- |
| The shooter, the terminal, the look | The Dockside's price boards → Stash, Loadout, Armoury, Market | Investing in brokers and dividends |
| The guest wallet, faucet and background signing | Gear burned each run → gear you own and risk | The week chart |
| Containers, seals, carry weight, the boat | Brokers → vendors who build things | The town's acts and the client reveal (the Harbormaster's wallet replaces them) |
| Wrecks (now holding guns) | Shared "strength" from core sales → the Harbormaster's wallet | The five-mission campaign as a separate mode (it returns as contracts) |
| The Bailiff, the kit and the score built today | The chapter story → the invoice and contracts | |
| The Assessor (at foreclosure) | | |
| The broker pricing curve (for vendors and exports) | | |

## Build plan

**Phase 1: by 14 Nov, 16:00 UTC.** Built on the branch `game/v2` against a new contract account. `main` and the
live site stay on the working build until v2 passes its checks.

| Lane | Delivers |
| --- | --- |
| **Contract** | Weapons as NFTs, building, mods, condition and repair, the loadout lock, wrecks and impound with gear, the market with fee and royalty, the invoice, arrears and the Harbormaster's wallet, vendor builds, the public economy view. Unit tests, a sandbox run, then testnet. |
| **Chain client and offline mock** | The same interface for testnet and for offline play |
| **In the raid** | The equipped gun's stats in the shooter, condition, parts dropped by machines, gear in wrecks, the invoice meter and its thresholds calling the Bailiff and the Assessor |
| **The dock** | Stash and loadout, the Armoury, the Market with gun cards, the vendors, the arrears panel |
| **Merged in** | The Bailiff, the kit and the score (built today) |
| **Last** | End-to-end tests on testnet, the README, the video, the switch of the live site |

**Phase 2: after the deadline.** The contract chain with the five missions; an insurance pool run by Ines; bids
and auctions; more frames with their own models; live squads; witnessed raid results for mainnet.

**If phase 1 isn't verified by the cutoff,** the working build tagged `stable-13nov` is submitted instead.

## Needed from the owner

1. **Yes or changes** to this plan.
2. **About 8 testnet NEAR** moved from `saltline.testnet` to a new contract account for v2.
3. **Ears on the new score.** The game already had a quiet music bed; the score built today replaces it.
