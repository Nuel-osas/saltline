// One Bailiff in time (docs/CAMPAIGN.md → The Bailiff): it rises, walks the nav grid after the player at one pace,
// works through the lost-sight routine when it can't see them, winds up and grabs inside its reach, and drops to a
// knee when its stagger meter fills. It can't be destroyed.
//
// This file holds the rules in time and nothing that draws or sounds: the body and the game come in through
// types.ts, so the tests drive it with stand-ins.
import type { BailiffHandle, BailiffState } from "../campaign/types";
import { TUNE, lostTarget, meterGain, staggerSeconds, staggerThreshold, type LostTarget } from "./rules";
import type { Body, Lens, Pose, V2, V3, World } from "./types";

export type StaggerBy = "damage" | "charge" | "script";

/** What the player's shot hits, shaped like the drones' raycast so combat.playerShot handles it the same way. */
export interface ShotHit {
  dist: number;
  point: V3;
  normal: V3;
  part: "weak" | "body";
  enemy: { type: string; bailiff: true; alive: boolean; pos: V3; damage(amount: number, point?: V3, dir?: V3, part?: string): boolean };
}

export interface Unit {
  readonly handle: BailiffHandle;
  /** False while its `delay` runs: it isn't in the world yet. */
  readonly appeared: boolean;
  readonly removed: boolean;
  /** The stagger meter, and what it has to reach. */
  readonly meter: number;
  readonly threshold: number;
  /** Staggers so far. */
  readonly staggers: number;
  /** True while its lens has the player. */
  readonly sees: boolean;
  /** Seconds left on its knee, or 0. */
  readonly down: number;
  /** Where it is walking to, for the tests and the smoke test. */
  readonly target: (V2 & { kind: "player" | LostTarget["kind"] }) | null;
  readonly yaw: number;
  /** Where its lens is (the smoke test aims at it). */
  readonly lens: V3;
  /** The player's shot against it. */
  raycast(origin: V3, dir: V3, max: number): ShotHit | null;
  /** Adds to the meter as a hit would (the arsenal's rifle butt). */
  hit(amount: number, lens?: boolean): void;
  /** Drops it to a knee now. */
  drop(by: StaggerBy, seconds?: number): void;
  /** The player is dead: it stops where it stands. */
  halt(): void;
  update(dt: number): void;
  dispose(): void;
}

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const smooth = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
const hd = (a: V2, b: V2) => Math.hypot(a.x - b.x, a.z - b.z);

export function createUnit(opts: { id: number; at: V2; delay?: number; world: World; body: Body; onRemove?: (u: Unit) => void }): Unit {
  const { id, world, body } = opts;
  const T = TUNE;
  const pos: V3 = { x: opts.at.x, y: 0, z: opts.at.z };
  try {
    pos.y = world.ground(pos.x, pos.z, 1.2);
  } catch {
    pos.y = 0;
  }
  let delay = Math.max(0, opts.delay ?? 0);
  let appeared = false;
  let removed = false;
  let halted = false;
  let state: BailiffState = "rising";
  let t = 0; // seconds in the state
  let riseFor: number = T.rise;
  let fromKnee = false;
  let yaw = 0;
  let speed = 0;
  // the meter
  let meter = 0;
  let staggers = 0;
  let downFor = 0;
  // sight
  let sees = false;
  let sightT = 0;
  let unseen = 0;
  let everSeen = false;
  let lastSeen: V2 | null = null;
  let checkedLastSeen = false;
  const checked = new Set<string>();
  let lostSaid = false;
  // the walk
  let path: V2[] | null = null;
  let wp = 0;
  let planT = 0;
  let stuckT = 0;
  let target: Unit["target"] = null;
  // the grab
  let cooldown = 0;
  let struck = 0; // seconds since the clamp came down
  let nearT = 0;
  let nearSaid = false;
  const lensAt: V3 = { x: pos.x, y: pos.y + 2.4, z: pos.z };
  const chest: V3 = { x: 0, y: 0, z: 0 };
  const pose: Pose = { x: pos.x, y: pos.y, z: pos.z, yaw, state, speed: 0, up: 0, kneel: 0, raise: 0, strike: 0, lens: "dark", flare: 0, look: null };
  const look: V3 = { x: 0, y: 0, z: 0 };

  const player = () => {
    const p = world.player();
    return p && p.pos && p.alive !== false ? p : null;
  };
  const eyeOf = (p: { pos: V3; eye?: V3 }): V3 => p.eye ?? { x: p.pos.x, y: p.pos.y + 1.6, z: p.pos.z };
  const set = (s: BailiffState) => ((state = s), (t = 0));

  function appear() {
    appeared = true;
    set("rising");
    riseFor = T.rise;
    fromKnee = false;
    const p = player();
    if (p) yaw = Math.atan2(p.pos.x - pos.x, p.pos.z - pos.z);
    world.emit("bailiff:spawned", { id, pos: { x: pos.x, y: pos.y, z: pos.z } });
    world.sfx("container_bang", { pos: { ...pos }, pitch: 0.8, gain: 1 });
    world.sfx("alert", { pos: { ...lensAt }, pitch: 0.5, gain: 0.9, variant: 1 });
    world.say("released");
  }

  function drop(by: StaggerBy, seconds?: number) {
    if (!appeared || removed) return;
    if (state === "staggered") {
      // Already down: a longer call keeps it there, nothing else changes.
      if (seconds !== undefined && seconds > downFor - t) downFor = t + seconds;
      return;
    }
    downFor = seconds !== undefined && seconds > 0 ? seconds : staggerSeconds(staggers);
    staggers++;
    meter = 0;
    speed = 0;
    set("staggered");
    world.emit("bailiff:staggered", { id, seconds: downFor, by });
    world.sfx("hound_die", { pos: { ...lensAt }, pitch: 0.5, gain: 1, jitter: 0 });
    world.sfx("relay_cut", { pos: { ...lensAt }, pitch: 0.7, gain: 0.9 });
    world.say("staggered");
  }

  function hit(amount: number, lens = false, scaled = false) {
    if (!appeared || removed || state === "staggered") return;
    meter += meterGain(amount, lens, scaled);
    if (meter >= staggerThreshold(staggers)) drop("damage");
  }

  function see(dt: number) {
    const p = player();
    if ((sightT -= dt) <= 0) {
      sightT = 0.1;
      body.lens(lensAt);
      let now = false;
      if (p && state !== "staggered" && !halted) {
        const eye = eyeOf(p);
        if (Math.hypot(eye.x - lensAt.x, eye.y - lensAt.y, eye.z - lensAt.z) <= T.sight) {
          try {
            now = world.los(lensAt, eye);
          } catch {
            now = false;
          }
        }
      }
      sees = now;
      // Where it last saw them is where they were when it looked, not where they have got to since.
      if (now && p) lastSeen = { x: p.pos.x, z: p.pos.z };
    }
    if (sees && p) {
      everSeen = true;
      unseen = 0;
      checkedLastSeen = false;
      checked.clear();
      lostSaid = false;
    } else if (state !== "staggered") unseen += dt;
  }

  /** Where it is going: the player while it has had sight of them lately, else the lost-sight routine. */
  function aim(): Unit["target"] {
    const p = player();
    if (p && unseen < T.lostAfter) return { kind: "player", x: p.pos.x, z: p.pos.z };
    if (!lostSaid && everSeen) {
      lostSaid = true;
      world.say("lost");
    }
    let to = lostTarget({ from: pos, lastSeen, checkedLastSeen, uplinks: world.uplinks(), checked, boat: world.boat() });
    // Tick off what it has reached, and move on at once.
    for (let i = 0; i < 6 && to.kind !== "hold" && hd(pos, to) < T.arrive; i++) {
      if (to.kind === "lastSeen") checkedLastSeen = true;
      else if (to.kind === "uplink" && to.id) checked.add(to.id);
      else break; // the boat: it waits there
      to = lostTarget({ from: pos, lastSeen, checkedLastSeen, uplinks: world.uplinks(), checked, boat: world.boat() });
    }
    return to;
  }

  function plan(to: V2) {
    planT = T.replan;
    let found: V2[] | null = null;
    try {
      found = world.path(pos, to);
    } catch {
      found = null;
    }
    path = found && found.length ? found : null;
    wp = 0;
    if (path && path.length > 1 && hd(path[0], pos) < 0.6) wp = 1;
  }

  function walk(dt: number) {
    const to = aim();
    target = to;
    if (!to) return void (speed = 0);
    if ((planT -= dt) <= 0) plan(to);
    let next: V2 = to;
    if (path) {
      while (wp < path.length - 1 && hd(path[wp], pos) < 0.6) wp++;
      next = path[Math.min(wp, path.length - 1)];
      // The last waypoint is where the player was at the plan; walk at where they are now.
      if (wp >= path.length - 1 && to.kind === "player") next = to;
    }
    const dx = next.x - pos.x,
      dz = next.z - pos.z;
    const d = Math.hypot(dx, dz);
    const goal = hd(pos, to);
    // It stops short of whoever it is collecting from, and on the spot it was sent to.
    const there = to.kind === "player" ? goal < 1.3 : to.kind === "hold" || goal < 0.5;
    let want = 0;
    if (!there && d > 0.05) {
      const err = wrap(Math.atan2(dx, dz) - yaw);
      yaw = wrap(yaw + Math.sign(err) * Math.min(Math.abs(err), T.turn * dt));
      want = Math.abs(err) > T.pivot ? 0 : T.speed;
    } else if (to.kind === "player" && goal > 0.05) {
      const err = wrap(Math.atan2(to.x - pos.x, to.z - pos.z) - yaw);
      yaw = wrap(yaw + Math.sign(err) * Math.min(Math.abs(err), T.turn * dt));
    }
    speed = want > speed ? Math.min(want, speed + T.accel * dt) : Math.max(want, speed - T.accel * 1.6 * dt);
    if (speed <= 0 || d <= 0.05) return;
    const step = Math.min(d, speed * dt);
    let nx = pos.x + (dx / d) * step,
      nz = pos.z + (dz / d) * step;
    if (!world.walkable(nx, nz)) {
      // Slide along whichever axis is clear, like the hounds; a moment stuck asks for a new plan.
      if (world.walkable(nx, pos.z)) nz = pos.z;
      else if (world.walkable(pos.x, nz)) nx = pos.x;
      else ((nx = pos.x), (nz = pos.z));
      stuckT += dt;
      if (stuckT > 0.4) ((stuckT = 0), (planT = 0));
    } else stuckT = 0;
    pos.x = nx;
    pos.z = nz;
    try {
      const g = world.ground(nx, nz, pos.y + 0.5);
      pos.y += (g - pos.y) * Math.min(1, dt * 12);
    } catch {
      /* it keeps its height */
    }
  }

  function inReach(range: number): boolean {
    const p = player();
    if (!p) return false;
    const dy = p.pos.y - pos.y;
    if (hd(p.pos, pos) > range || dy > T.grab.reachUp || dy < -1.5) return false;
    chest.x = pos.x;
    chest.y = pos.y + 1.9;
    chest.z = pos.z;
    try {
      return world.los(chest, { x: p.pos.x, y: p.pos.y + 1.1, z: p.pos.z });
    } catch {
      return false;
    }
  }

  function face(dt: number) {
    const p = player();
    if (!p) return;
    const err = wrap(Math.atan2(p.pos.x - pos.x, p.pos.z - pos.z) - yaw);
    yaw = wrap(yaw + Math.sign(err) * Math.min(Math.abs(err), T.turn * 1.5 * dt));
  }

  function close() {
    const p = player();
    set("recovering");
    cooldown = T.grab.recovery;
    struck = 0;
    world.sfx("impact_metal", { pos: { ...pos, y: pos.y + 1.4 }, pitch: 0.5, gain: 1 });
    if (!p || !inReach(T.grab.connect)) return; // the clamp closes on air
    const dx = p.pos.x - pos.x,
      dz = p.pos.z - pos.z;
    const d = Math.hypot(dx, dz);
    // A player standing on its feet is thrown the way it faces.
    const ux = d > 0.05 ? dx / d : Math.sin(yaw),
      uz = d > 0.05 ? dz / d : Math.cos(yaw);
    world.hurt(T.grab.damage, { x: pos.x, y: pos.y + 1.8, z: pos.z });
    world.shove(ux, uz, T.grab.shove, T.grab.shoveSeconds);
    world.emit("bailiff:grab", { id, damage: T.grab.damage });
    world.sfx("container_bang", { pos: { ...pos }, pitch: 1.2, gain: 1 });
  }

  function update(dt: number) {
    if (removed || !(dt > 0)) return;
    dt = Math.min(dt, 0.05);
    if (!appeared) {
      if ((delay -= dt) > 0) return;
      appear();
    }
    t += dt;
    cooldown = Math.max(0, cooldown - dt);
    struck += dt;
    see(dt);
    const p = player();

    if (halted) speed = 0;
    else if (state === "rising") {
      speed = 0;
      if (t >= riseFor) set("walking");
    } else if (state === "walking") {
      walk(dt);
      if (cooldown <= 0 && inReach(T.grab.range)) {
        set("windup");
        speed = 0;
        world.sfx("telegraph", { pos: { ...lensAt }, pitch: 0.5, gain: 1, variant: 0, jitter: 0 });
        world.say("grab");
      }
    } else if (state === "windup") {
      speed = 0;
      face(dt);
      if (t >= T.grab.windup) close();
    } else if (state === "recovering") {
      if (t < T.grab.hold) ((speed = 0), face(dt));
      else walk(dt);
      if (t >= T.grab.recovery) set("walking");
    } else if (state === "staggered") {
      speed = 0;
      if (t >= downFor) {
        set("rising");
        riseFor = T.stand;
        fromKnee = true;
        planT = 0;
        world.emit("bailiff:recovered", { id });
        world.sfx("alert", { pos: { ...lensAt }, pitch: 0.45, gain: 0.8, variant: 0 });
        world.say("recovered");
      }
    }

    // Its presence: the score and the HUD hear of it twice a second inside 30 m.
    if (p) {
      const dist = hd(p.pos, pos);
      if (!nearSaid && !halted && state !== "staggered" && state !== "rising" && dist <= T.near.line) ((nearSaid = true), world.say("near"));
      if ((nearT -= dt) <= 0) {
        nearT = T.near.every;
        if (dist <= T.near.chip) world.emit("bailiff:near", { id, dist, standing: state !== "staggered" });
      }
    }

    // ---- the pose ----
    const down = state === "staggered";
    const rising = state === "rising";
    let lens: Lens = down ? "dark" : sees ? "red" : "amber";
    if (rising && !fromKnee && t < riseFor * 0.55) lens = "dark";
    if (rising && fromKnee && t < riseFor * 0.3) lens = "dark";
    pose.x = pos.x;
    pose.y = pos.y;
    pose.z = pos.z;
    pose.yaw = yaw;
    pose.state = state;
    pose.speed = speed;
    pose.up = rising && !fromKnee ? smooth(t / riseFor) : 1;
    pose.kneel = down ? smooth(t / 0.5) : rising && fromKnee ? 1 - smooth(t / riseFor) : 0;
    pose.raise = state === "windup" ? smooth(t / (T.grab.windup * 0.75)) : 0;
    pose.strike = state === "recovering" ? Math.max(0, 1 - struck / T.grab.hold) : 0;
    pose.flare = state === "windup" ? Math.min(1, t / T.grab.windup) : 0;
    pose.lens = lens;
    if (p && !down && (sees || unseen < 2.5)) {
      const e = eyeOf(p);
      look.x = e.x;
      look.y = e.y;
      look.z = e.z;
      pose.look = look;
    } else pose.look = null;
    body.update(dt, pose);
  }

  // With no delay it is in the world from the moment it is spawned: a script that asks anyStanding() straight after
  // spawn() gets the right answer.
  if (delay <= 0) appear();

  const handle: BailiffHandle = {
    id,
    pos,
    get state() {
      return state;
    },
    get standing() {
      return appeared && !removed && state !== "staggered";
    },
    stagger(seconds?: number) {
      drop("script", seconds);
    },
    remove() {
      unit.dispose();
    },
  };

  const unit: Unit = {
    handle,
    get appeared() {
      return appeared;
    },
    get removed() {
      return removed;
    },
    get meter() {
      return meter;
    },
    get threshold() {
      return staggerThreshold(staggers);
    },
    get staggers() {
      return staggers;
    },
    get sees() {
      return sees;
    },
    get down() {
      return state === "staggered" ? Math.max(0, downFor - t) : 0;
    },
    get target() {
      return target;
    },
    get yaw() {
      return yaw;
    },
    get lens() {
      return body.lens(lensAt);
    },
    raycast(origin, dir, max) {
      if (!appeared || removed) return null;
      const h = body.raycast(origin, dir, max);
      if (!h || !(h.dist < max)) return null;
      const point = world.vec(h.point);
      const lens = h.lens;
      return {
        dist: h.dist,
        point,
        normal: world.vec(h.normal),
        part: lens ? "weak" : "body",
        enemy: {
          type: "bailiff",
          bailiff: true,
          alive: true,
          pos: point,
          // It never dies: every hit sparks off and goes on the meter.
          damage: (amount, _at, _dir, part) => {
            try {
              world.spark(h.point, h.normal, lens);
            } catch {
              /* decoration */
            }
            hit(amount, lens, lens && part === "weak");
            return false;
          },
        },
      };
    },
    hit: (amount, lens = false) => hit(amount, lens),
    drop,
    halt() {
      halted = true;
      speed = 0;
      if (state === "windup") set("walking");
    },
    update,
    dispose() {
      if (removed) return;
      removed = true;
      try {
        body.dispose();
      } finally {
        opts.onRemove?.(unit);
      }
    },
  };
  return unit;
}
