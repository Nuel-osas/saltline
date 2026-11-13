# Saltline: the campaign

The plan that turns Saltline from one repeated run into a proper game: a five-mission campaign with a beginning,
an escalation, a boss and an ending; a machine that hunts you; a fuller kit; and a score. `docs/STORY.md` is the
world and the voice, `docs/ECONOMY.md` is the economy, and this file is the campaign. Code interfaces are in
`src/economy/campaign/types.ts`. Change this file first when the design changes.

## What was wrong

- **No personal story.** The chapters followed the shared town, so a player saw Chapter 1 until everyone, together,
  had delivered enough. One player could never reach the boss by playing.
- **One loop.** Every run was the same: three uplinks, then the boat.
- **A thin kit.** One rifle, two machines, no pickups, a melee key that did nothing, no music.
- **No ending.**

## What the player gets

Five missions, played in order, each about five minutes. Every mission keeps the game's spine and adds one new
thing:

**infiltrate** (cut the three uplinks, salvage what you can) → **set piece** (the mission's own) → **the boat**.

The economy is still the hub between missions: sell the haul at the Dockside, buy gear for the next one. The shared
town still reaches into every mission: the Harbormaster's strength adds Inspection Units to every wave and cores to
the Assessor, and every sale still moves every price.

| # | Mission | The new thing | Set piece, after the third uplink |
| --- | --- | --- | --- |
| 1 | **Proof of Delivery** | Seals, weight, the boat, pickups | None: straight to the boat |
| 2 | **Chain of Custody** | **The Bailiff**, released at the first uplink | The boat holds off while the Bailiff is on its feet. Drop it, then run. |
| 3 | **Bill of Lading** | A defence | Hold the fuel manifold for 75 seconds while everything comes. The Bailiff arrives at half. |
| 4 | **Force Majeure** | The dark, and two Bailiffs | Bring down three appeal masts. |
| 5 | **Final Notice** | The boss | **The Assessor** (`docs/STORY.md`). Then the ending. |

- **Death** leaves a wreck as now, and the player retries the same mission.
- **Progress** is the player's own, saved in the browser (`saltline.campaign.v1`). Cargo, scrip and gear stay on the
  open ledger as before. No contract change.
- **After mission 5:** the ending and credits, then **Appeals**: any mission can be replayed, against whatever the
  town has fed the Harbormaster.
- **`?mission=m1…m5`** starts at that mission for this visit without touching saved progress (for testers and
  judges). It works on testnet and on the mock.
- **The shared town** (`town()`, the TOWN tab) is unchanged: districts relight with deliveries, eight logged core
  sales are the ledger's public proof of who the Quartermaster's buyer is, and strength rises and decays from then.
  In the campaign the player learns it first-hand at the end of mission 4.
- **The Assessor** now belongs to mission 5 for every player. Its cores stay `3 + floor(strength / 20)`, so it has 3
  when the town has fed the Harbormaster nothing, and up to 8.

## Tone

Machines that are polite and cannot be reasoned with. The Harbormaster's paperwork voice stays (`docs/STORY.md` →
Tone), but from mission 2 the machines are frightening first: the Bailiff does not run and does not stop, the dark
in mission 4 is real, and nothing the machines say is a joke to the people hearing it.

## The Bailiff

The Harbormaster's repossession officer, and the game's hunter. Original design: no likeness to any film machine.

- **Look.** A 2.6 m humanoid dock-enforcement frame: a heavy steel skeleton under hazard-striped plates (the
  Assessor's yellow and black, so they read as one family), a slab head with one lens (amber, red when it can see
  you), a writ box bolted to its chest, one arm ending in a container clamp. Generated in code like everything else.
- **It walks.** 2.6 m/s, always. The player walks at 3.8 and sprints at 6.4, but a full load walks at 2.4: carrying
  everything means it gains on you. It paths around containers on the level's nav grid, re-planning twice a second.
  Without sight of the player for 6 seconds it goes to where it last saw them, then toward the nearest uplink still
  live, then the boat. It never pops in or out in view.
- **It can't be destroyed.** Hits spark off and fill a stagger meter (lens hits count double). Full, it drops to a
  knee with its lens dark, then stands again. The first stagger takes 450 damage and lasts 9 s; each one after takes
  200 more (up to 1,050) and lasts 1 s less (down to 5 s). A breaker charge staggers it at once.
- **Its grab.** Within 2.2 m: a 0.6 s wind-up (the clamp rises, the lens flares, a tone), then 55 damage and a 4 m
  shove, then 2.5 s before it can grab again.
- **Presence.** Heavy footfalls that shake the camera inside 10 m, a servo whine, a lens beam in the rain, a HUD chip
  (`BAILIFF 14 m`, with direction) inside 30 m, and its own layer in the score.
- **Lines** (the Harbormaster's channel, labelled `BAILIFF`):
  - Released: "Breacher {callsign}. You are in arrears. An officer has been dispatched to collect."
  - First time within 12 m: "Please remain where you are."
  - Winding up a grab: "You are being repossessed."
  - Staggered, as it drops: "Service has been interrupted."
  - Standing again: "Service of the writ will now resume."
  - Losing sight for long: "Your location has been noted. It is in the schedule."

## The kit

- **Breaker charge** (G). A thrown charge: a 14 m arc, bursting on impact or after 1.2 s, 7 m across.
  - Gulls in it are destroyed. Hounds take 80 and freeze for 3 s. A Bailiff staggers. The Assessor's cores in it
    take 120.
  - Each mission starts with 2 (`MissionDef.charges`); a pickup adds 1, up to 3.
- **Rifle butt** (F, V or middle mouse: bound since the baseline, never implemented). 2.3 m reach, a 60° cone, 70
  damage, 0.45 s between swings. It knocks a hound back and breaks its lunge wind-up. Sparks off a Bailiff for 40
  stagger.
- **Pickups.** Ammo tins (+30 rounds), med injectors (+35 health), breaker charges (+1).
  - Six supply lockers a mission, at seeded spots from a table of checked ground positions.
  - Drops: a hound leaves ammo 35% of the time; a gull leaves ammo 12% and a med injector 8%.
  - Walk over one to take it. A line on the HUD feed says what it was.

## The score

Synthesized in the browser, through the game's own audio context and its `music` bus, following its volume
setting and `?noaudio`. Nothing is downloaded. States, crossfading over about 1.5 s:

| State | When | Sound |
| --- | --- | --- |
| `title` | The title screen and the Dockside | A slow pad and a far foghorn motif |
| `infiltrate` | In a run, nothing alerted | A sparse low pulse |
| `combat` | Machines alerted or shots in the last 6 s | Drums and a bass ostinato |
| `stalker` | A standing Bailiff within 25 m (over the others) | A low two-note motif and a heartbeat that quickens as it closes |
| `setpiece` | A mission's set piece | The combat layer, driven harder |
| `boss` | The Assessor | Everything, with its own theme |
| `clear` | The boat is free | A short resolve |
| `debrief` | The debrief and dead cards | A warm pad; a cold one for death |
| `ending` | The ending and credits | The theme, whole |

## Presentation

- **Title.** A campaign strip under the wordmark: `MISSION 2 OF 5 · CHAIN OF CUSTODY`. DEPLOY starts it. A DOCKET
  button opens the mission board: five rows, each with its number, title, line, best rating and time, and whether it
  is cleared, current or locked. Any unlocked mission can be picked.
- **Briefing.** Three cards before each mission (the opening's five before mission 1), skippable, shown the first
  time and whenever a mission is picked from the docket.
- **Mission card** at the start of the run, where the chapter card was: `MISSION 2 · CHAIN OF CUSTODY`, its line,
  then `Saltline Terminal · Berth 4 · 05:42`.
- **Objective.** The HUD's objective line follows the mission: the uplinks, then the set piece (with progress where
  it has some), then the boat.
- **Debrief.** Control's line for the mission, `NEXT · MISSION 3 · BILL OF LADING`, and the main button becomes NEXT
  MISSION, with DOCKSIDE beside it. The dead card's button reads RETRY MISSION.
- **Ending.** After mission 5's debrief: four cards over the water, then credits, then the docket with APPEALS open.

## The missions

`{callsign}` is the dock pass callsign, or "Breacher". Control's and the Harbormaster's general lines
(`docs/STORY.md` → Radio) still play at their moments. Lines below are added by the mission.

### 1 · Proof of Delivery

- **Card line:** "The town needs its cargo. The Harbormaster needs a signature."
- **Briefing:** the opening's five cards (`docs/STORY.md`).
- **Play:** as the game is now. Lockers and drops are introduced. No set piece.
- **Debrief (Control):** "First haul's on the ledger. Ines is already arguing about the price. Get some sleep."

### 2 · Chain of Custody

- **Card line:** "Something has been sent to collect."
- **Briefing:**
  1. "The clinic's consignment made it out. The Harbormaster has noticed the discrepancy."
  2. "It has issued a writ of repossession, and it has built something to serve it."
  3. "The crews call it the Bailiff. It does not run. It does not stop. Do not let it reach you."
- **Play:** the Bailiff stands up in the shed at the first uplink cut and hunts for the rest of the run.
- **Set piece:** after the third cut the boat holds off while the Bailiff is on its feet. Drop it, then make the
  ladder before it stands. Objective line: `PUT THE BAILIFF DOWN, THEN RUN`.
- **Lines:**
  - First cut (Control): "{callsign}, something big just stood up in the shed. It's walking. Toward you."
  - First stagger (Control): "It's down. It won't stay down. Move."
  - Third cut (Control): "Boat won't come in with that thing on its feet. Put it down, then run."
- **Debrief (Control):** "It got up after you left. It's standing on the quay, facing the town. It hasn't moved
  since."

### 3 · Bill of Lading

- **Card line:** "Seventy-five seconds of fuel. Everything it has."
- **Briefing:**
  1. "The generators across the water have four hours of fuel left."
  2. "The port's fuel main still runs under the quay. Open it, and hold the manifold while the town's tanks fill."
  3. "The Harbormaster has classified this as theft of utilities. It is sending everything."
- **Set piece:** after the third cut a manifold on the quay is marked. Standing within 8 m of it fills the tanks:
  75 seconds in all, and the count pauses whenever the player steps out. Waves come from three sides every 12–15 s,
  growing. At half, a Bailiff walks in from the yard. Objective line: `HOLD THE MANIFOLD · 41%`.
- **Lines:**
  - Third cut (Control): "Manifold's by the quay crane. Stand on it and stay on it. I'll count."
  - 25% (Control): "Quarter."
  - 50% (Control): "Half. Bailiff's on the quay road."
  - 75% (Control): "Three quarters. Don't you dare step off."
  - Full (Control): "Tanks are full. Lights stay on tonight. Boat, now."
  - As it starts (Harbormaster): "Unmetered consumption detected. A utilities surcharge has been applied. Per second."
- **Debrief (Control):** "The generators are running on your fuel. The town can see its own streets."

### 4 · Force Majeure

- **Card line:** "Lights out. Two officers. Three masts."
- **Briefing:**
  1. "The Harbormaster has declared force majeure. It has cut every light in the port."
  2. "It is broadcasting an appeal from three masts. We don't know who is listening."
  3. "Bring the masts down in the dark. It has built a second Bailiff. They hunt as a pair."
- **Play:** a blackout. The scene is dark and storm-lit (exposure down, heavier rain, lightning); machines carry
  lamps, and the player's rifle light and muzzle flash matter. One Bailiff from the start, a second from the yard at
  the second cut.
- **Set piece:** after the third cut three masts rise (yard, shed roof, quay). Each has a junction box to shoot out
  (400 damage). Each one down calls a pair of Inspection Units. Objective line: `BRING DOWN THE MASTS · 1/3`.
- **Lines:**
  - Start (Control): "I can't see you on any camera. You're on your own lamps."
  - Second cut (Control): "Second Bailiff, from the yard. They're splitting up to box you in."
  - Third cut (Control): "Masts are live. Yard, shed roof, quay. Shoot the junction boxes."
  - Masts (Control): "One down." / "Two." / "That's the appeal gone. Boat."
  - Start (Harbormaster): "Conditions beyond our control have been declared. All courtesies are suspended."
  - A mast down (Harbormaster): "That mast carried our correspondence. Your invoice now includes postage."
- **Debrief (Control):** "We traced the appeal. It wasn't calling for help. It was ordering parts. Relay cores.
  From our own Quartermaster."

### 5 · Final Notice

- **Card line:** "The client would like its cores back."
- **Briefing:**
  1. "Every relay core the town sold the Quartermaster went to one buyer."
  2. "The Harbormaster has built itself a body, and it is walking to the quay to deliver its findings in person."
  3. "Shoot out its cores. Every one the town sold it is one more you have to break."
- **Set piece:** the Assessor, as built (`docs/STORY.md` → The boss), now for every player. No Bailiff in this one.
- **Debrief (Control):** "It's scrap. The whole town watched it fall. Come home, {callsign}."
- **Ending cards:**
  1. "The Assessor is scrap on the quay, and the tide is taking it."
  2. "The Harbormaster has gone quiet. Its last message was a single form: Notice of Appeal."
  3. "The town keeps its own ledger now. Every crate is written where anyone can read it."
  4. "It can wait. Interest accrues. So does Saltline."
- **Credits,** then the docket: "The Harbormaster has appealed. Replay any mission against what the town has fed
  it."

## How it is built

```
src/economy/hooks.ts            shared registries over game.js's single-slot hooks: shot targets, boat gates
src/economy/campaign/
  types.ts                      the interfaces every lane builds against
  index.ts, runner.ts           picks the mission at run start, runs its script, tracks the phase, saves progress
  missions.ts                   the five missions as data (titles, lines, briefings, loadouts)
  progress.ts                   saltline.campaign.v1
  m1.ts … m5.ts                 each mission's script (MissionScript)
  ui/                           title strip, docket, debrief and dead additions, ending, credits
src/economy/bailiff/            the Bailiff: body, walk, pathing, stagger, grab, lines, HUD chip
src/economy/arsenal/            breaker charge, rifle butt, pickups and lockers, HUD pips
src/economy/score/              the score
```

- **A mission script** (`MissionScript`) is called by the runner: `start`, `relayCut`, `allCut`, `update`, `blocked`
  (true while its set piece holds the boat), `dispose`. It speaks through the story's radio channel, spawns machines
  through `G.enemies.spawn` (see how the Assessor calls its pair in `src/economy/boss/fight.ts`), and registers shot
  targets and gates through `hooks.ts`.
- **Events** (on `G.events`): `mission:start`, `mission:phase`, `mission:objective`, `mission:complete`,
  `mission:failed`, `campaign:progress`, `bailiff:spawned`, `bailiff:staggered`, `bailiff:recovered`,
  `bailiff:grab`, `bailiff:near`, `emp:detonated`, `pickup:taken`, `score:state`. Payloads are in `types.ts`.
- **Everything is guarded.** A campaign failure leaves a plain run; `?noeconomy=1` still plays the baseline.
- **Checks.** Each piece has unit tests and a headless smoke test on the mock (`?mock=1&mission=mN`), and
  `npm run check` stays green.
