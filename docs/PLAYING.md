# How to play Saltline

**Play:** https://saltline-lac.vercel.app/play/?game=v2 · sign in with Google, nothing to install.

- [The game in one minute](#the-game-in-one-minute)
- [Your first raid](#your-first-raid)
- [The invoice](#the-invoice)
- [When you die](#when-you-die)
- [The dock](#the-dock)
- [Guns](#guns)
- [Progression](#progression)
- [The endgame](#the-endgame)
- [What you gain](#what-you-gain)

## The game in one minute

A machine called the Harbormaster runs the port of Saltline and has impounded the town. You are a **Breacher**: you
go over the fence with a gun, cut container seals, carry out what you can and get to the boat.

Everything you take goes on **the invoice**, a meter at the top right. The more you take and the longer you stay,
the higher it climbs, and when it is high enough the Harbormaster sends **the Bailiff**, which walks, can't be
destroyed and doesn't stop. Greed is the difficulty.

**Reach the boat** and the haul is yours. **Die**, and the gun you brought is left in the yard for another player to
carry out. Back at **the dock** you sell what you carried, build and buy guns, and decide whether to pay the
Harbormaster's bill.

| Every | You |
| --- | --- |
| 30 seconds | Cut a seal, take cargo or shoot a machine, and watch the invoice climb. |
| 5 minutes | Reach the boat with what you carried, or lose it and your gun. |
| Session | Sell, build or buy a gun, level the one you have, trade, pay the Harbormaster or don't. |

## Your first raid

Pick a mode in the lobby:

| Mode | What it is |
| --- | --- |
| **Practice** | The whole game in your browser with a full locker. Nothing is kept and nothing is at stake. Start here. |
| **Raid** | The real thing, on NEAR testnet. Your gun, your haul and your bill are on the chain. |
| **Skirmish** | The practice yard with other players in it, who can shoot you. Add `&room=yourname` to its address for a private yard with friends. |
| **The opening** | The 48-second film: why you were sent, the crate and the rifle. |

Then:

1. **Press Deploy.** About five seconds later you are in the yard.
2. **Take the rifle.** On your first raids it lies in a crate in front of you: hold **E** (or **USE** on a phone).
   Machines can't hurt you until it is in your hands, and until you first reach the boat they do half damage.
3. **Cut seals.** Walk to a marked container and hold **E**. The cargo goes in your pack (`CARGO 2/6`): you can carry
   6 weight, and each unit slows you a little.
4. **Cut the 3 uplinks** (A, B and C on the compass). The boat won't come until all three are cut.
5. **Get to the boat.** The debrief tells you what you carried out and what it is worth today.

**Machines.** Gulls fly, hounds run. A machine's lamp is amber while it patrols and turns **red** once it has seen
you, and a red marker shows how far away it is. Destroying one adds to the invoice and can drop a part (servos from
hounds, rotors from gulls), ammunition or medicine.

**Controls.** WASD and the mouse (click to capture it), left mouse to fire, right mouse to aim, R to reload, E to
use, G for a breaker charge, F for the rifle butt, Shift to sprint, C to crouch, Esc to pause. On a phone there are
on-screen buttons for all of these.

## The invoice

**What adds to it**

| Action | Added |
| --- | --- |
| Entering | 150, plus 25 for each raid you've brought home before (500 at most) |
| Each minute in the yard | 40 |
| Cutting a seal | 60 |
| Each unit of weight you carry | 30 |
| Cutting an uplink | 50 |
| Destroying a gull / a hound | 15 / 35 |

**What it brings**

| The invoice reaches | The Harbormaster |
| --- | --- |
| 600 | **Second notice.** More machines on patrol. |
| 1,200 | **Final demand.** The Bailiff is sent. |
| 2,400 | A second Bailiff. |
| 4,000 | **Foreclosure.** The Assessor plants itself between you and the boat. |

A careful raid ends around 800 to 1,100, just under the Bailiff. One more crate or a few more minutes tips it over.

**After the raid** a quarter of the final invoice becomes **arrears** (a tenth if you died), and half your arrears
are already on the meter when your next raid starts. You can pay it down at the dock: each scrip clears 2. Every
scrip you pay goes to the Harbormaster (see [the endgame](#the-endgame) for why that matters to everyone).

## When you die

| Killed by | Your gun | Your cargo |
| --- | --- | --- |
| **The machines** | Left in a **wreck** in the yard. It appears in other players' raids for 24 hours, and the first to carry it to the boat owns it. Then it is destroyed. | In the wreck too |
| **The Bailiff** | **Impounded** for 48 hours. Buy it back at the dock for 40% of its value, or it is destroyed. | Lost |

The **issue rifle** is never lost: everyone always has one, so nobody is locked out. It is also the worst gun in the
game. Armour plates and charges you used are gone either way.

## The dock

Open it from the lobby's tabs or the debrief's **Sell haul** button.

| Tab | What you do there |
| --- | --- |
| **Vendors** | Sell what you carried out. **Sell everything to the best buyer** sends each lot to whoever pays most and shows why. **Moss** (the armourer) buys copper, electronics, servos, rotors and relay cores, sells the guns and mods she builds, and repairs guns. **Ines** (the quartermaster) buys meds, fuel, electronics and copper, and sells armour plates, breaker charges and magazines. The **export desk** buys anything for new scrip. |
| **Armoury** | Build guns and mods from parts. |
| **Loadout** | Choose the gun you take over the fence, and what you bring: an armour plate (+40 health), up to 3 breaker charges, and extra magazines (3 come free). |
| **Market** | Buy and sell guns, mods and parts with other players at fixed prices. |
| **Ledger** | Your history, what you owe, and **Fast-forward a week** to watch the economy move. |

**Prices move.** A vendor pays more for what it is short of and less as its shelf fills, so each unit you sell pays a
little less than the last; the export desk pays less for each unit exported that day. A vendor that runs out of
scrip buys nothing until it sells something. Every price comes with the vendor's reason.

**Money.** You get 150 scrip with your dock pass. After that, scrip comes from selling and exporting what you carry
out. It leaves through build fees, magazines, repairs, the market fee, the Harbormaster's bill and buy-backs.

## Guns

Every gun except the issue rifle is an NFT you own, built from parts somebody carried out of a raid.

**Frames**

| Frame | Plays like | Built from |
| --- | --- | --- |
| **PAC-9 Longshore** | The carbine: balanced | 6 copper, 4 electronics, 2 servos + 120 scrip |
| **PAC-9K Stevedore** | Short: fast fire, small damage, quick handling | 4 copper, 3 electronics, 3 rotors + 90 scrip |
| **PAC-9M Pilot** | Marksman: slow, hard-hitting, long range | 5 copper, 5 electronics, 2 servos, 1 relay core + 180 scrip |

- **Every build is rolled.** Damage, fire rate, magazine, recoil, reload and range each land somewhere in the frame's
  range, and the roll gives a **grade from D to A**. No two guns are the same, and an A-grade Pilot is rare.
- **Condition.** A gun loses 5 condition each raid and 15 when it is carried out of a wreck. Under 30 it handles badly
  (−15% damage, +20% recoil). Moss repairs it for 2 scrip a point plus copper. A gun at 0 can only be scrapped for
  parts.
- **Mods** go in four slots and stay with the gun when it is sold:

| Mod | Effect | Built from |
| --- | --- | --- |
| Extended magazine | +10 rounds a magazine | 2 copper, 1 electronics + 30 |
| Long barrel | +12% damage, +15% range, −6% fire rate | 3 copper, 1 servo + 40 |
| Compensator | −25% recoil | 2 copper, 1 rotor + 30 |
| Optic | Tighter aim, +5% range | 3 electronics, 1 rotor + 50 |

- **Its record.** Each gun carries its serial, who built it, and what it has been through: raids, raids brought home,
  owners, wrecks it was pulled from. The card reads like a history: `Built by ROOK · 14 extractions · 3 owners ·
  recovered once`.

## Progression

**Gun levels.** A gun levels up from the raids it comes home from. Each level makes it 2% better in your hands (more
damage, less recoil, a faster reload). A level can't be bought, and it goes with the gun when it is sold.

| Level | Name | Raids home | Bonus |
| --- | --- | --- | --- |
| 1 | New | 0 | — |
| 2 | Broken in | 1 | +2% |
| 3 | Seasoned | 3 | +4% |
| 4 | Veteran | 6 | +6% |
| 5 | Storied | 10 | +8% |
| 6 | Notorious | 15 | +10% |

**Your rank** comes from the raids you've brought home. It is status only: it changes nothing in a raid.

| Rank | Casual | Docker | Stevedore | Breacher | Foreman | Pilot |
| --- | --- | --- | --- | --- | --- | --- |
| Raids home | 0 | 1 | 3 | 6 | 10 | 15 |

## The endgame

There is no last level. The endgame is the economy: what you own, what you've built, and how hard you make the port
for everyone else. Ways to play it:

- **Take a gun all the way.** Bring one gun home 15 times and it becomes **Notorious**. An A-grade Notorious gun with
  all four mods is the best gun in the game, and its record proves how it got there. Lose it once and it is someone
  else's.
- **Become a gunsmith.** Build guns, keep rolling for A grades, and sell the good ones. Whoever built a gun earns
  **2% of every sale of it, for as long as it exists**, so a well-made gun keeps paying its maker as it changes hands.
- **Salvage.** Go in light and hunt other players' wrecks. Carry a dead player's gun to the boat and it is yours.
- **Trade.** Buy from a vendor that is overstocked and cheap, and sell on the market or to a vendor that is short.
- **Live as an outlaw.** Carry 1,000 or more in arrears and every raid gets **2 bonded containers** with the best parts
  (relay cores, servos), along with a hotter start and the Bailiff never far away.
- **Face the Assessor.** Push one raid's invoice to 4,000 and the Assessor plants itself in front of the boat. Its
  glowing cores are its only weak points, it calls in machines as it takes damage, and the boat won't come until
  the last core is dark.
- **Decide how hard the port is for everyone.** The Harbormaster's strength is what players have paid it, halving
  every 12 hours. Every 25 points (500 scrip) is one more machine on every player's raid, or, when it turns to
  pursuit, an earlier Bailiff for everyone. Paying your bill makes your own next raid easier and everyone else's
  harder. Not paying makes yours harder.
- **Top the boards.** The contract keeps three: most raids brought home (shown in the lobby), net worth (scrip plus
  the guns in hand) and top makers (royalties earned).
- **Fight your friends.** Open Skirmish with `&room=yourname`, share the link, and drop each other with nothing at
  stake.

## What you gain

**Today, on testnet, nothing with cash value.** Scrip and guns are real tokens, but testnet tokens are worth nothing.
What you get is the game, and ownership that already works the way it would with real money:

- **A gun that's yours.** It sits in your own NEAR account, not in a game server's database. The contract has no
  admin function that creates or takes scrip, parts or guns: only its published rules move them. (On testnet the team
  can still upgrade the contract's code; that key goes before mainnet.)
- **The right to sell it** on the market, at a price you set, to another player.
- **Income from what you build:** 2% of every sale of a gun you made, for as long as it exists. This already happened
  on testnet: see [`docs/PROOF.md`](PROOF.md).
- **A record that can't be faked.** Raids survived, owners and wrecks are written on the gun; a level can't be bought.
- **Other players' guns to win** from their wrecks.
- **No crypto hassle.** One Google sign-in, an account that follows you to any device, and no wallet, seed phrase or
  gas fees.

**On mainnet** (the plan in [`docs/GAME.md`](GAME.md)), guns would sell for NEAR or USDC on the open market and the
maker's 2% would be real income. One thing has to come first: today your own browser reports how a raid went, so a
modified client could fake raids. Before real money, a server has to check raid results. The README says this
plainly, and [`docs/LIMITS.md`](LIMITS.md) lists every limit.

**Why it matters.** In most games the studio owns everything you "own": it can be deleted or changed whenever they
like, and it can't leave the game. Here the gun is yours, the rules are public, and it can really be lost. That risk
is what makes it worth something.
