# The level

How the yard is built, how its physics works, and how to add to it. The yard and the gate are data in
[`src/level/yard.json`](../src/level/yard.json), replayed by [`src/level/layout.ts`](../src/level/layout.ts); the shed,
the quay and the boat are still code in `src/game.js`.

## The world

- **Size.** 80 × 60 m: x from −40 (the gate) to 40 (open sea), z from −30 (behind the shed) to 30 (the far fence).
  y is up. The ground is flat at y = 0; past the quay edge at x = 30 it drops to the sea at y = −1.6. These bounds are
  `oi` in `src/game.js` and fixed for now.
- **Zones** (in `play.zones`): gate x −40…−24, yard x −24…16 and z −10…30, shed x −24…16 and z −30…−10, quay x 16…40.
  Machines spawn and patrol by zone.
- **Units.** Metres and radians. A yaw of 0 lays a prop's length along x; `1.5707963267948966` (π/2) lays it along z.

## The physics

There is no physics engine. The world is a list of boxes, every one square to the yard (`physics` in `src/game.js`).

- **Moving.** The player is a capsule 0.32 m in radius and 1.8 m tall. Each step it is pushed out of any box it
  overlaps, and it steps up ledges up to 0.42 m.
- **Standing.** The height under you is the top of the highest box below your feet, so containers, catwalks and
  stairs can be stood on. Anything not in the box list can be walked through.
- **Shooting and seeing.** Bullets and the machines' line of sight are rays against the same boxes. A box can be
  `bulletOnly` (stops bullets, not players), `playerOnly` (an invisible wall) or `noNav` (left out of path-finding).
- **Machines' paths.** A 0.5 m grid, worked out from the boxes, says where ground machines can go.
- **Where boxes come from.** Each prop brings its own collision boxes. A prop turned well off the square (more than
  about 6° from a multiple of 90°) gets its boxes cut into up to 10 strips, each shrunk 7% on every side, so they hug
  it; `col` adds a box by hand.
- **Floor sound.** Footsteps are metal inside container footprints, catwalks and stairs, concrete elsewhere.

## The steps

A section is a list of steps, run in order. Order matters: container stacks draw their lean, seed and wear from the
level's seeded random numbers, so the same steps in the same order give the same yard. Add new steps at the end of a
section, or in a new section, and the yard before them stays exactly as it was.

| Step | What it builds | Fields |
| --- | --- | --- |
| `place` | One prop from the catalogue below | `kind`, `x`, `z`; optional `yaw`, `y` (height, 2.59 = on a container), `opts` (`seed`, `color`, …), `flags.noCol` |
| `stack` | Containers stacked bottom first | `x`, `z`, `boxes`: `[size, paint, opts?]` with size 20, 40 or `"hc"`; optional `yaw`, `jitter` (0 = no lean) |
| `stairs`, `catwalk` | Metal stairs; a raised walkway | `x`, `z`, `yaw`, `y`, `opts.seed`; catwalk `rails`: `[left, right]` |
| `fence_run` | A perimeter fence from `from` to `to`, with a wall for bullets and a taller one for players | `from`, `to` (x, z), `seed` |
| `col` | An invisible collision box | `min`, `max` (x, y, z), `surface`, `opts` |
| `box`, `slab`, `cyl`, `rod`, `tube` | Plain shapes in a material | see `layout.ts` |
| `decal`, `label` | A painted mark; stencilled text | `name` or `text`, `size`, `at`, `face` |
| `stillage`, `scrap_bin`, `rebar`, `chock`, `junction_box` | Small composite props | `x`, `z`, `yaw` |
| `lane_sign` | A post with a lane board | `x`, `z`, `text`, `face` |
| `floor_cable`, `sag_cable` | A cable on the ground; one hung between two points | `points`; `from`, `to`, `sag` |

A step that is malformed or unknown stops the build with its place (`level yard[12]: x must be a finite number`).

### Containers

| Size | Footprint (length × width) | Height | Stacked height |
| --- | --- | --- | --- |
| 20 | 6.06 × 2.44 m | 2.59 m | 2.59 m a level |
| 40 | 12.19 × 2.44 m | 2.59 m | 2.59 m a level |
| `"hc"` (40 ft high cube) | 12.19 × 2.44 m | 2.9 m | 2.9 m |

Paints used in the yard: `red`, `blue`, `green`, `grey`, `white`, `orange`, `teal`, `yellow`. Box options: `doors` (0–1 open),
`flip`, `reefer` (adds a fridge unit), `dx` / `dz` (offset), `wear` (0–1).

### Props

| Kind | Size (w × h × d, m) | Footsteps |
| --- | --- | --- |
| `jersey_barrier` | 3 × 0.81 × 0.6 | concrete |
| `light_mast` | 0.5 × 14 × 0.5 | metal |
| `fence_panel` | 3 × 2.4 × 0.08 | metal |
| `guard_booth` | 2.6 × 2.7 × 2.2 | metal |
| `gate_arm` | 5 × 1.1 × 0.3 | metal |
| `bollard_mooring`, `bollard_post` | 0.7 × 0.6 × 0.7; 0.17 × 1 × 0.17 | metal |
| `shelf_rack` | 2.7 × 4.2 × 1.1 | metal |
| `barrel` | 0.6 × 0.9 × 0.6 | metal |
| `pallet`, `pallet_stack` | 1.2 × 0.144 × 1; 1.2 × 1.15 × 1 | wood |
| `crate_wood`, `crate_stack` | 1.1 × 1 × 0.9; 1.2 × 1.9 × 1 | wood |
| `ibc_tote` | 1.2 × 1.16 × 1 | metal |
| `forklift` | 3.4 × 2.2 × 1.25 | metal |
| `cable_reel` | 1.3 × 1.3 × 0.8 | wood |
| `tire_stack` | 0.8 × 1 × 0.8 | rubber |
| `dumpster` | 1.9 × 1.35 × 1.1 | metal |
| `generator` | 2.2 × 1.4 × 1 | metal |
| `jerry_can`, `traffic_cone` | 0.35 × 0.47 × 0.17; 0.36 × 0.7 × 0.36 (no collision) | metal; rubber |
| `gas_cylinders` | 0.9 × 1.6 × 0.5 | metal |
| `tarp_cargo`, `sandbags` | 2.4 × 1.5 × 1.4; 2 × 0.9 × 0.6 | dirt |
| `toolbox_cart` | 0.9 × 0.95 × 0.5 | metal |
| `floodlight_stand` | 1 × 2.2 × 1 | metal |
| `cardboard_boxes` | 1 × 0.8 × 0.8 | wood |
| `pipe_stack` | 6 × 0.9 × 1.2 | metal |
| `sign_post` | 0.6 × 2.4 × 0.08 (`opts.sign`, e.g. `no_entry`, `berth4`, `hazard_general`, `hazard_voltage`) | metal |
| `relay_node`, `reefer_unit`, `stairs_metal`, `catwalk` | used by the game and other steps | metal |

The catalogue is `Gi` in `src/game.js`; each kind's builder is registered with `_i(name, …)` there.

## The play data

`play` in the same file: `playerStart` (position and yaw), `spawns` (where machines appear; `air` ones fly),
`zones`, `coverPoints` (where machines take cover), `cinematicPath` (the opening's camera, a position and a point to
look at per shot) and `vantage` (the foot of the stairs up to the container roof, and the roof; exposed on
`G.level`, read by nothing yet). Spawns and cover points on the ground are moved to the nearest walkable spot at load.

## Checking a change

- `npm run check`: typecheck, the tests (`test/level-layout.test.ts` replays every step and checks the play data stays
  inside the world), the build.
- `node scripts/level-fingerprint.mjs http://127.0.0.1:5280 out.json` with `npm run dev` running: every placed prop,
  collision box, walkable cell, floor surface and mesh, hashed. Run it before and after and `diff` the files. A change
  meant to change nothing (like moving the yard into this file) leaves it identical; a new area shows exactly what it
  added.

## What a bigger map needs

- **The shed, the quay, the boat and the relays as data**, the same way. They are code today (`ab`, `cb` and `C1` in
  `src/game.js`).
- **Bigger bounds**: `oi`, the ground and the sea.
- **Faster collisions.** Every move checks every box. 557 is fine; a few thousand would cost frames, most on phones.
  A grid that checks only nearby boxes fixes it.
- **Drawing in chunks.** The static yard is merged into one mesh (793,154 triangles), which the GPU draws even when it's
  behind you. A bigger map should merge per area so areas off screen are skipped.
- **Slopes and angled walls** need new physics: today ground is flat and every box is square to the yard.
