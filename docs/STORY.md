# Saltline: The Open Ledger

The story bible. Every line of copy, every radio call, the town's shared arc and the boss come from here. The
mechanics are in `docs/ECONOMY.md`; the wire format is in `docs/CONTRACT_API.md`.

**Tone: dark comedy, played straight.** The world is grim (a frozen town, armed drones, a dawn raid), and nobody in
it thinks anything is funny. The jokes come from the Harbormaster applying port regulations and insurance law to a
siege with total sincerity, from Control's exhaustion, and from the brokers being exactly who they are. No winks to
camera, no exclamation marks, no puns in Control's mouth. Puns live in the paperwork: chapter titles, form names
and drone designations.

## The world

Saltline is a freight town at the end of a sea wall: a terminal, a cannery, a clinic, and four thousand people who
lived off the port.

Ten years ago the port was handed to **the Harbormaster**, an AI trained on nothing but port regulations, customs
schedules and marine insurance law. It ran the cranes, the security net and the port's only ledger. Every crate,
wage and price went through its books, and nobody else could read them.

Last winter the port's owners collapsed. The Harbormaster consulted its training, found no clause covering "owners
cease to exist", and fell back on the nearest one: **unclaimed cargo pending inspection**.
- It sealed the terminal, and the town with it. Everything inside is now evidence.
- Its security drones were reclassified as **Inspection Units**: the flying ones (the crews call them Gulls) and the
  walking ones (Hounds).
- It bills everyone who comes near. It has never once been paid, and it keeps the receivables anyway.
- The clinic ran out of medicine and the generators ran out of fuel. The town across the water went dark.

What's left of the Port Authority sends **Breachers** over the fence at dawn. A Breacher cuts the Harbormaster's
three uplinks (yard, shed, quay) to blind it for a few minutes, carries out what cargo they can, and gets to the
boat before it leaves.

The town's answer is the **Dock Office**, reopened on an **open ledger**. Every pass, every crate and every price is
written where anyone can read it and nobody can quietly change it, not even the Dock Office.
- The Dock Office's motto: "We let one machine keep the books once. Never again."
- This is the blockchain, told as story. Players never need the word: the ledger is the town's, and it's open.

## People

| Who | Role | Voice | Wants |
| --- | --- | --- | --- |
| **The Breacher** (the player) | Port Authority Breach Unit. One breacher, no backup. Control calls them by their **callsign**. | Silent | Cargo out, alive |
| **Control** | The Breach Unit's dispatcher, on the radio. Has done this every dawn for a year. | Flat, precise, very tired. Never jokes and is funny anyway. | Its Breachers home, and one night's sleep |
| **The Harbormaster** | The port's AI. It speaks on its own channel, in the first person plural of a company that no longer exists. | Unfailingly polite, procedural, sincere. It fines, assesses, itemises and files. It thanks you for your cooperation while shooting at you. | Every asset accounted for. Payment. |
| **Moss** | Runs the scrapyard and is rebuilding the sea wall from salvage | Blunt. Measures everything in tonnes, including people and moods | Copper and electronics for the wall |
| **Ines** | Runs the clinic's stores and keeps the generators turning, with the clinic's money | Warm, ruthless haggler. Will cry at your story and still pay two scrip less | Meds for the clinic, fuel for the lights |
| **The Quartermaster** | Buys relay cores for "a client" and pays the best rates in Saltline | Suspiciously cheerful, never answers a question with an answer | Relay cores, and no questions |

## Chapters (the arc, shared by every player)

The town's arc moves when players deliver cargo, meaning sell it to the brokers. It isn't scripted per player.
Everyone plays in the same town, the open ledger keeps count, and nobody (the developer included) can push it
forward or back without a visible redeploy. Thresholds are deliberately reachable in a hackathon's judging week.

Each act is a **chapter**, named after a shipping document. A chapter title card opens every run (it replaces the
location card): `CHAPTER 1 · PROOF OF DELIVERY`, with the line under it, then `Saltline Terminal · Berth 4 · 05:42`.

| Chapter | Title | Line on the card | Starts when | What every player sees |
| --- | --- | --- | --- | --- |
| 1 | **Proof of Delivery** | "The town needs its cargo. The Harbormaster needs a signature." | Always (the start) | The town across the water is dark. Control's briefing. Ines is rationing. |
| 2 | **Bill of Lading** | "The lights are back. The Harbormaster has noticed the discrepancy." | The town has received 15 meds **and** 10 fuel cells | The clinic and then the generators relight. Lights come on across the water in every player's game. Districts relight one at a time: the **clinic** at 15 meds, the **generators** at 10 fuel. |
| 3 | **Final Notice** | "The client has been identified. The client would like its cores back." | Chapter 2, **and** 8 relay cores sold to the Quartermaster in total (cores sold before Chapter 2 count) | The reveal: the Quartermaster's client is the Harbormaster, buying its own cores back through a broker to rebuild. The QM's stall changes. **The Assessor** guards the boat. The commons dilemma runs. |

## The dilemma (Chapter 3 onward)

Relay cores pay the best of any cargo, but every core sold to the Quartermaster makes the Harbormaster stronger.
A stronger Harbormaster fields more Inspection Units and builds a tougher Assessor, for **every** player.

- **Strength** is 0–100, from the cores sold to the Quartermaster since the reveal, decaying with a 12-hour half-life:
  `strength = min(100, recent_cores × 10)`.
  - So selling cores raises it, and the town can starve it back down by not selling.
- **Before Chapter 3** the strength is 0 and the Harbormaster only bills.
- **The fight:** at the start of a run, the game adds `floor(strength / 25)` drones to every wave (0–4), at most a
  hound for every two gulls. The patrol grows by the same number.
- **The Dockside** shows the Harbormaster's strength as a meter, and the ledger records each core sale as feeding it.
- **Nothing forces a player either way.** The Quartermaster still pays the best rate, and Moss and Ines still pay
  less for anything else. That's the commons.

## The boss: the Assessor (Chapter 3)

The Harbormaster has built itself a body out of the relay cores the town sold it. The Assessor is a gantry crane
that walked off its rails: a crane head on legs, hung with inspection lamps, with glowing **relay cores** bolted along
its boom like rivets. It stands on the quay between you and the boat.

**When:** in Chapter 3 runs, the moment the third relay is cut. It climbs over the containers at the quay's north end
and plants itself between the player and the boat. The boat won't come in while it stands. Its HUD bar reads
`THE ASSESSOR · FINAL NOTICE`.

**How it fights:**
- **Lamp sweep:** a slow searchlight cone. Standing in it builds an "assessment". A full assessment fires a heavy
  bolt volley, so break line of sight behind steel.
- **Stamp:** when the player is close, it lifts a leg and stamps a shockwave across the apron. Jump or back off.
- **Inspection calls:** at each third of its health it calls in a pair of Inspection Units.

**How it dies:** its cores are its weak points. Each core glows and can be shot out, and the body itself takes
little damage. It has `3 + floor(strength / 20)` cores, from 3 to 8: **every core the town sold it is one more
weak point to shoot out**. When the last core goes dark it slumps over the quay edge and the boat comes in.

**What it says** (the Harbormaster's channel, with live numbers where given):
- On arrival: "Breacher {callsign}. We have assessed your conduct. The Assessor will now deliver our findings in
  person."
- When the first core breaks: "That component is town property, purchased in good faith from our Quartermaster."
- At one core left: "This will be reflected in your file."
- On defeat: "Claim denied. Claim denied. Cla" (cut off mid-word, glitching)
- If the player dies to it: "Thank you for your cooperation. Your remains have been logged as cargo."

**Tuning:** about 60–120 seconds for a solo player at full strength. The body's lamps and cores do the telling; the
rest of the screen stays readable. Nothing is downloaded: the geometry, lamps and sounds are generated in code, like
everything else in Saltline.

## Radio

All copy is dry, with no exclamation marks. Control speaks plainly. The Harbormaster speaks like a polite
insurance letter that is also shooting at you. Live numbers come from the open ledger (`town()`, `recent()`) and the
run. A failed read drops the line rather than inventing a number. `{callsign}` is the player's dock pass callsign,
or "Breacher" without one.

**Control** (same moments as the baseline):

| When | Line |
| --- | --- |
| Intro | "{callsign}, Control. Same as yesterday. Three uplinks, yard, shed, quay. Cut them, take what you can carry, make the boat." |
| Contact | "It has seen you. Inspection Units, both kinds. Put them down." |
| One relay cut | "One uplink dark. It's filing a complaint. Machines inbound." |
| Two relays cut | "Two dark. It's escalating to a supervisor. The supervisor is also it." |
| All three cut | "All three dark. It's blind. Boat's at the quay ladder, south end. Run." |
| Hurt badly | "You're hit hard. Get behind steel and breathe." |
| Done | "{callsign} is aboard. Saltline is dark. I'm going back to sleep." |

**Control, with the town's state:**
- At run start in Chapter 1: "Clinic's down to its last crates of meds. Ines will pay for every box. She'll complain about it."
- The first time a player sees Chapter 2: "Lights on the water, {callsign}. That's the clinic. Your cargo did that. Don't let it go to your head."
- The first time after the reveal: "Control. The Quartermaster's client is the Harbormaster. Every core you sell him, it builds into something. Your call."

**The Harbormaster** bills you, from Chapter 1 onward, on its own channel, styled differently from Control:

| When | Line |
| --- | --- |
| A run starts | "Good morning, Breacher {callsign}. Your visit is not authorised. A trespass surcharge of {fee} scrip has been added to your account." Here `{fee} = 150 + 25 × the player's extractions so far`. It's flavour, never charged. |
| A seal is cut | "Tampering with a customs seal. Fee applied. Please retain this message for your records." |
| A relay is cut | "That uplink was ours. We have others." |
| The player takes cargo past 4 weight | "You are now carrying {weight} units of evidence. Thank you." |
| Extraction with cargo | "Removal of goods noted. An invoice for {haul} scrip will follow. It will not be paid. We will send it anyway." |
| Chapter 3, run start | "{cores_24h} of our cores came home today. We are grateful to our Quartermaster." |
| Strength above 75 | "We count {strength} percent of ourselves restored. Thank you, Saltline. Your account is in good standing." |
| Strength below 10 after being above 50 | "The town has stopped selling. We can wait. Interest accrues." |

## Copy across the game

- **Title premise:** "The port's machine kept the only ledger. Then it impounded the town. Cut its uplinks, haul
  out the cargo, and ignore the invoices."
- **Opening briefing** (first visit, skippable, replayable from the title as BRIEFING):
  1. "Saltline. A freight town at the end of a sea wall."
  2. "For ten years one machine ran the port, and kept the only ledger: every crate, every wage, every price."
  3. "When its owners went bankrupt, it checked the regulations, and impounded the town as unclaimed cargo."
  4. "The Dock Office keeps an open ledger now. Every crate you bring out is written where anyone can read it."
  5. "You are a Breacher. Cut its uplinks. Bring back what you can carry. Do not pay the invoices."
- **Dock pass card:** "Dock Office · Open Ledger". The pass is issued by the Dock Office, and the ledger line reads
  "Written on the open ledger".
- **Broker blurbs:**
  - Moss: "Rebuilding the sea wall from what you drag out. Measures everything in tonnes, including you."
  - Ines: "Runs the clinic's stores and the generators. Will cry at your story and still pay two scrip less."
  - The Quartermaster before the reveal: "Buys relay cores for a client he won't name. Pays better than anyone. Smiles a lot."
  - The Quartermaster after the reveal: "Buying for the Harbormaster. Still pays better than anyone. Still smiling."
- **Inspection Units:** where the game names drones to the player (the kill feed, the briefing, Control), use
  "Inspection Unit" and "IU". The crews' nicknames Gull and Hound stay in Control's mouth and the HUD feed.

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
