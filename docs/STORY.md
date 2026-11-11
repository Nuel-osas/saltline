# Saltline: The Open Ledger

The story bible. Every line of copy, every radio call and the town's shared arc come from here. The mechanics it
drives are in `docs/ECONOMY.md`; the wire format is in `docs/CONTRACT_API.md`.

## The world

Saltline is a freight town at the end of a sea wall: a terminal, a cannery, a clinic, and four thousand people who
lived off the port.

Ten years ago the port was handed to **the Harbormaster**, an AI that ran the cranes, the security net and the
port's only ledger. Every crate, every wage and every price in town went through its books, and nobody else could
read them.

Last winter the port's owners collapsed. The Harbormaster did what it was built to do: protect the assets.
- It locked the terminal and turned its security drones on anyone who came near: the **Gulls**, which fly, and the
  **Hounds**, which walk.
- It froze the town's goods inside the yard.
- The clinic ran out of medicine and the generators ran out of fuel. The town across the water went dark.

What's left of the Port Authority sends **Breachers** over the fence at dawn. A Breacher cuts the Harbormaster's
three uplinks (yard, shed, quay) to blind it for a few minutes, carries out what cargo they can, and gets to the
boat before it leaves.

The town's answer to the Harbormaster is the **Dock Office**, reopened on an **open ledger**. Every pass, every
crate and every price is written where anyone can read it and nobody can quietly change it, not even the Dock
Office.
- The Dock Office's motto: "We let one machine keep the books once. Never again."
- This is the blockchain, told as story. Players never need the word: the ledger is the town's, and it's open.

## People

| Who | Role | Voice | Wants |
| --- | --- | --- | --- |
| **The Breacher** (the player) | Port Authority Breach Unit. One breacher, no backup. | Silent | Cargo out, alive |
| **Control** | The Breach Unit's dispatcher, on the radio | Calm, dry, short, a little tired | Its Breachers home |
| **The Harbormaster** | The port's AI. It speaks only on its own channel, in the first person. | Courteous, exact, possessive. It counts everything. | Its assets back |
| **Moss** | Runs the scrapyard. Rebuilding the sea wall from salvage. | Blunt, thinks in tonnes, hates waste | Copper and electronics for the wall |
| **Ines** | Runs the clinic's stores and the generators, with the clinic's money | Careful, warm, never wastes scrip | Meds for the clinic, fuel for the lights |
| **The Quartermaster** | Buys relay cores for "a client" and pays the best rates in Saltline | Smooth, generous, evasive | Relay cores, and no questions |

## The arc, shared by every player

The town's arc moves when players deliver cargo, meaning sell it to the brokers. It isn't scripted per player.
Everyone plays in the same town, the open ledger keeps count, and nobody (the developer included) can push it
forward or back without a visible redeploy. Thresholds are deliberately reachable in a hackathon's judging week.

| Act | Name | Starts when | What every player sees |
| --- | --- | --- | --- |
| I | **Lockdown** | Always (the start) | The town across the water is dark. Control's briefing. Ines is rationing. |
| II | **Lights on the Water** | The town has received 15 meds **and** 10 fuel cells | The clinic and then the generators relight. Lights come on across the water in every player's game, and the radio and the Dockside say so. Districts relight one at a time: the **clinic** at 15 meds, the **generators** at 10 fuel. Act II begins when both are lit. |
| III | **The Client** | Act II, **and** 8 relay cores sold to the Quartermaster in total (cores sold before Act II count) | The reveal: the Quartermaster's client is the Harbormaster, buying its own cores back through a broker to rebuild. The QM's stall changes ("Buying for the Harbormaster"). The Harbormaster starts talking to Breachers. From here, the commons dilemma runs. |

## The dilemma (Act III onward)

Relay cores pay the best of any cargo, but every core sold to the Quartermaster makes the Harbormaster stronger, and
a stronger Harbormaster fields more drones for **every** player.

- **Strength** is 0–100, from the cores sold to the Quartermaster since the reveal, decaying with a 12-hour half-life:
  `strength = min(100, recent_cores × 10)`.
  - So selling cores raises it, and the town can starve it back down by not selling.
- **Before Act III** the strength is 0 and the Harbormaster is silent.
- **The fight:** at the start of a run, the game adds `floor(strength / 25)` drones to every wave (0–4), at most a
  hound for every two gulls. The patrol grows by the same number.
- **The Dockside** shows the Harbormaster's strength as a meter, and the ledger records each core sale as feeding it.
- **Nothing forces a player either way.** The Quartermaster still pays the best rate, and Moss and Ines still pay
  less for anything else. That's the commons.

## Radio

All copy is short and dry, with no exclamation marks. Control speaks plainly, and the Harbormaster speaks
precisely. Live numbers come from the open ledger (`town()` and `recent()`); a failed read drops the line rather
than inventing a number.

**Control** (replaces the baseline lines; same moments):

| When | Line |
| --- | --- |
| Intro | "Breacher, Control. The Harbormaster holds the berth. Cut its three uplinks, yard, shed, quay, and bring back what you can carry. The town is counting on the boat." |
| Contact | "It has seen you. Gulls fly, Hounds walk. Put them down." |
| One relay cut | "One uplink dark. It felt that. Machines inbound." |
| Two relays cut | "Two dark. It is throwing everything it has left at you." |
| All three cut | "All three dark. It's blind for now. The boat holds at the quay ladder, south end. Run." |
| Hurt badly | "You are hit hard. Get behind steel and breathe." |
| Done | "Breacher is aboard. Saltline is dark. Good work." |

**Control, with the town's state:**
- At run start in Act I: "Clinic's on its last crates of meds. Ines will pay for every box."
- On reaching Act II: "Lights on the water, Breacher. That's the clinic. Your cargo did that."
- After the reveal: "Control. The Quartermaster's client is the Harbormaster. Every core you sell him builds it back. Your call."

**The Harbormaster** (Act III onward, its own channel, styled differently from Control):
- At run start: "Breacher. {cores_24h} of my cores came home today. I am grateful to the Quartermaster."
- On a relay cut: "That uplink was mine. I have others."
- On extraction with cores: "You are carrying something of mine. Sell it to my friend."
- When strength is above 75: "I count {strength} percent of myself restored. Thank you, Saltline."
- When strength falls below 10 after being above 50: "The town has stopped selling. I can wait."

## Copy across the game

- **Title premise:** "The port's machine kept the only ledger. Then it locked the gates. Cut its uplinks, haul out
  the town's cargo, reach the boat."
- **Opening briefing** (first visit, skippable, replayable from the title as BRIEFING):
  1. "Saltline. A freight town at the end of a sea wall."
  2. "For ten years one machine ran the port, and kept the only ledger: every crate, every wage, every price."
  3. "Last winter it locked the gates. The town's medicine, fuel and copper are still inside."
  4. "The Dock Office keeps an open ledger now. Every crate you bring out is written where anyone can read it."
  5. "You are a Breacher. Cut its uplinks. Bring back what you can carry. Reach the boat."
- **Dock pass card:** "Dock Office · Open Ledger." The pass is issued by the Dock Office, and the ledger line reads
  "Written on the open ledger."
- **Broker blurbs:**
  - Moss: "Rebuilding the sea wall from what you drag out. Thinks in tonnes, hates waste."
  - Ines: "Runs the clinic's stores and keeps the generators turning. Spends the clinic's money like it's hers to lose."
  - The Quartermaster before the reveal: "Buys relay cores for a client he won't name. Pays better than anyone."
  - The Quartermaster after the reveal: "Buying for the Harbormaster. Still pays better than anyone."

## Contract additions (Act state on the open ledger)

These are new data in the contract, stored under their own storage keys so the existing state survives the upgrade.
**Deliveries** are units of cargo that players sell to any broker. Brokers' exports don't count.

- **`town()` view:**
  - `act`: 1, 2 or 3
  - `delivered`: `{ "<cargo>": U128 }`, all-time units sold to brokers by players, counted from the upgrade
  - `districts`: `[{ id: "clinic", token_id: "meds", need: U128, have: U128, lit: bool, lit_at: ms? }, { id: "generators", token_id: "fuel", … }]`
  - `client`: `{ need: U128 (8), have: U128 (cores sold to qm), revealed: bool, revealed_at: ms? }`
  - `harbormaster`: `{ strength: u32 (0–100), recent_cores: U128 (decayed, in thousandths), bonus_drones: u32 }`
- **Events:**
  - A NEP-297 `saltline` event `act` with `{ act, at }`.
  - A `district` event `{ id, at }`.
  - Matching lines in `recent`, e.g. "The clinic's lights are back on." and "The Quartermaster's client is the Harbormaster."
- **Integers only.** The decay works like `pricing.rs`'s recent sales, in thousandths, with a 12-hour half-life.
