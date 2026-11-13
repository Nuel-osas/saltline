// The Assessor's fight in time (docs/STORY.md → The boss): it arrives over the north containers and plants itself
// between the player and the boat; its lamp sweeps and builds an assessment that ends in a bolt volley; it stamps
// when the player comes close; it calls a pair of Inspection Units at each third of its health; its cores are the
// only real weak points, and the last one dark brings it down and lets the boat in.
//
// This file holds the rules in time and nothing that draws: the body, its bolts and the HUD bar come in through
// types.ts, so the tests drive it with stand-ins.
import { LINES, arrival, type LineId } from "./copy";
import { TUNE, damageFor } from "./rules";
import type { Bar, Body, Bolts, Drive, Phase, V3 } from "./types";

/* eslint-disable @typescript-eslint/no-explicit-any -- the game context is the untyped bundle's G */
type Game = any;

export interface FightDeps {
  G: Game;
  body: Body;
  bolts: Bolts;
  bar: Bar;
  /** Speaks on the Harbormaster's channel (the caller decides when the radio is free). */
  say(text: string, seconds: number, id: LineId): void;
  rng(): number;
  /** Plays a sound from the game's synth bank (G.audio.play), if there is one. */
  sfx?(name: string, opts?: Record<string, unknown>): void;
}

/** What the player's shot hits, shaped like the drones' raycast so combat.playerShot handles it the same way. */
export interface ShotHit {
  dist: number;
  point: V3;
  normal: V3;
  part: "weak" | "body";
  enemy: { type: string; boss: true; alive: boolean; pos: V3; damage(amount: number, point?: V3): boolean };
}

export interface Fight {
  readonly phase: Phase;
  readonly cores: number;
  /** Each core's health. */
  readonly hp: readonly number[];
  /** 0–1: the cores' health together. */
  readonly health: number;
  /** 0–1: the lamp's assessment of the player. */
  readonly assess: number;
  readonly beam: "sweep" | "lock" | "volley" | "cool";
  readonly said: ReadonlySet<LineId>;
  /** Inspection calls made. */
  readonly calls: number;
  /** 0 the boat is holding off, 1 it's back at the ladder. */
  readonly boat: number;
  /** True while the boat won't come in. */
  blocked(): boolean;
  /** Core i's world position (for scripted aiming in the smoke test). */
  core(i: number): V3;
  /** Its body (for debugging). */
  readonly body: Body;
  /** G.ext.raycast: the player's shot against the Assessor. */
  raycast(origin: V3, dir: V3, max: number): ShotHit | null;
  update(dt: number): void;
  playerDied(): void;
  dispose(): void;
}

/** The walk in: over the containers at the quay's north end, through the crane's portal, to the post. */
export const PATH: readonly { x: number; z: number }[] = [
  TUNE.arrive.from,
  { x: 22, z: -22 },
  { x: 23.5, z: -10 },
  TUNE.arrive.post,
];
const PATH_LEN = PATH.slice(1).reduce((n, p, i) => n + Math.hypot(p.x - PATH[i].x, p.z - PATH[i].z), 0);

function pathAt(d: number): { x: number; z: number; yaw: number } {
  let left = Math.max(0, d);
  for (let i = 1; i < PATH.length; i++) {
    const a = PATH[i - 1],
      b = PATH[i];
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    const yaw = Math.atan2(b.x - a.x, b.z - a.z);
    if (left <= len || i === PATH.length - 1) {
      const k = Math.min(1, left / len);
      return { x: a.x + (b.x - a.x) * k, z: a.z + (b.z - a.z) * k, yaw };
    }
    left -= len;
  }
  return { ...PATH[PATH.length - 1], yaw: 0 };
}

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const hdist = (a: V3, x: number, z: number) => Math.hypot(a.x - x, a.z - z);
const v3 = (x = 0, y = 0, z = 0): V3 => ({ x, y, z });
const smooth = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

export function createFight(deps: FightDeps, opts: { cores: number; callsign: string | null }): Fight {
  const { G, body, bolts, bar } = deps;
  const N = opts.cores;
  const T = TUNE;
  const hp = new Array<number>(N).fill(T.coreHp);
  const flash = new Array<number>(N).fill(0);
  const said = new Set<LineId>();
  const callsDone = new Set<number>();
  let phase: Phase = "arriving";
  let t = 0; // time in the phase
  let yaw = 0;
  let aim = v3(T.arrive.post.x, 1, T.arrive.post.z);
  let beam: Fight["beam"] = "sweep";
  let beamT = 0;
  let sweepT = 0;
  let assess = 0;
  let los = false;
  let losT = 0;
  let shots = 0;
  let gapT = 0;
  let stamp: { foot: number; t: number; slammed: boolean } | null = null;
  let stampCd = 2;
  const waves: { x: number; z: number; t: number; hit: boolean }[] = [];
  let boatT = 0;
  let calls = 0;
  let disposed = false;
  const sfx = (name: string, o?: Record<string, unknown>) => {
    try {
      deps.sfx?.(name, o);
    } catch {
      /* sound is never load-bearing */
    }
  };

  const tmp = v3(),
    tmp2 = v3();
  const drive: Drive = {
    phase,
    at: { x: T.arrive.from.x, z: T.arrive.from.z },
    yaw: 0,
    beam: { on: 0, dir: v3(0, -0.4, 1), length: 20, heat: 0, lock: false },
    stamp: null,
    slump: 0,
  };

  const say = (id: LineId, text: string, seconds: number) => {
    if (said.has(id)) return;
    said.add(id);
    deps.say(text, seconds, id);
  };
  const live = () => hp.filter((h) => h > 0).length;
  const health = () => hp.reduce((n, h) => n + Math.max(0, h), 0) / (N * T.coreHp);
  const player = () => G?.player ?? null;
  const playerAlive = () => {
    const p = player();
    return !!p && p.alive !== false && !!p.pos;
  };

  // ---- arrival ----
  say("arrival", arrival(opts.callsign), 5.2);
  bar.show(N);
  try {
    G?.hud?.setObjective?.("Shoot out the Assessor's cores");
  } catch {
    /* optional */
  }
  sfx("foghorn", { pos: { x: T.arrive.from.x, y: 8, z: T.arrive.from.z }, pitch: 0.62, gain: 1, jitter: 0 });

  // ---- damage ----
  function call(i: number) {
    if (callsDone.has(i)) return;
    callsDone.add(i);
    calls++;
    const p = player();
    const at = body.pos;
    const target = p?.pos;
    const side = i % 2 === 0 ? 1 : -1;
    const gullPos = { x: at.x + side * 4, y: 10, z: at.z };
    const foot = body.foot(i % Math.max(1, body.feet), v3());
    const houndPos = { x: foot.x + (target ? Math.sign(target.x - foot.x) * 1.5 : 1.5), y: 0, z: foot.z + 1.5 };
    const T3 = G?.THREE;
    const vec = (q: V3) => (T3 ? new T3.Vector3(q.x, q.y, q.z) : { ...q });
    for (const [type, pos] of [
      ["gull", gullPos],
      ["hound", houndPos],
    ] as const) {
      try {
        G?.enemies?.spawn?.(type, vec(pos), { state: "alert", target: target ?? undefined });
      } catch (e) {
        console.warn("[boss] call failed", e);
      }
    }
    try {
      if (target) G?.enemies?.alert?.(target, 60);
      G?.hud?.warn?.("Inspection Units", 3);
    } catch {
      /* the HUD is optional */
    }
    sfx("alert", { pos: gullPos, pitch: 0.7, variant: 1, gain: 1 });
  }

  function hitCore(i: number, amount: number): boolean {
    if (!(i >= 0 && i < N) || hp[i] <= 0 || (phase !== "arriving" && phase !== "fighting")) return false;
    const before = health();
    const liveBefore = live();
    hp[i] = Math.max(0, hp[i] - damageFor("core", amount));
    flash[i] = T.hitFlash;
    body.setCore(i, hp[i] > 0 ? "hit" : "dark");
    const broke = hp[i] <= 0;
    const after = health();
    if (broke) {
      const left = live();
      try {
        G?.hud?.feed?.(`<b>RELAY CORE</b> dark · ${left} left`);
      } catch {
        /* optional */
      }
      sfx("relay_cut", { pos: body.core(i, v3()), gain: 1 });
      sfx("explosion", { pos: body.core(i, v3()), pitch: 1.35, gain: 0.55 });
      if (liveBefore === N) say("firstCore", LINES.firstCore, 4.6);
      if (left === 1) say("lastCore", LINES.lastCore, 3.4);
      if (left === 0) die();
    }
    T.calls.forEach((th, k) => {
      if (before > th && after <= th && phase !== "dying") call(k);
    });
    return broke;
  }

  /** A body hit: a small share reaches the live core nearest the hit. */
  function hitBody(amount: number, point: V3 | undefined) {
    if (phase !== "arriving" && phase !== "fighting") return;
    let best = -1,
      bd = Infinity;
    for (let i = 0; i < N; i++) {
      if (hp[i] <= 0) continue;
      const c = body.core(i, tmp);
      const d = point ? Math.hypot(c.x - point.x, c.y - point.y, c.z - point.z) : i;
      if (d < bd) ((bd = d), (best = i));
    }
    if (best < 0) return;
    const share = damageFor("body", amount);
    const before = health();
    hp[best] = Math.max(0.01, hp[best] - share); // the body alone never puts a core out
    const after = health();
    T.calls.forEach((th, k) => {
      if (before > th && after <= th) call(k);
    });
  }

  function die() {
    phase = "dying";
    t = 0;
    stamp = null;
    waves.length = 0;
    bolts.clear();
    beam = "cool";
    say("defeat", LINES.defeat, 2.4);
    sfx("hound_die", { pos: body.pos, pitch: 0.42, gain: 1, jitter: 0 });
    sfx("explosion", { pos: { x: body.pos.x, y: 8, z: body.pos.z }, pitch: 0.75, gain: 1 });
    try {
      G?.hud?.setObjective?.("Get to the boat");
    } catch {
      /* optional */
    }
  }

  // ---- the player's shots ----
  const T3 = G?.THREE;
  const vec = (q: V3) => (T3 ? new T3.Vector3(q.x, q.y, q.z) : { x: q.x, y: q.y, z: q.z });
  function raycast(origin: V3, dir: V3, max: number): ShotHit | null {
    if (disposed || (phase !== "arriving" && phase !== "fighting")) return null;
    const h = body.raycast(origin, dir, max);
    if (!h || !(h.dist < max)) return null;
    const point = vec(h.point);
    if (h.core >= 0 && h.core < N && hp[h.core] > 0) {
      const i = h.core;
      return {
        dist: h.dist,
        point,
        normal: vec(h.normal),
        part: "weak",
        enemy: { type: "relay core", boss: true, alive: true, pos: point, damage: (amount) => hitCore(i, amount) },
      };
    }
    return {
      dist: h.dist,
      point,
      normal: vec(h.normal),
      part: "body",
      enemy: {
        type: "assessor",
        boss: true,
        alive: true,
        pos: point,
        damage: (amount, at) => (hitBody(amount, at ?? point), false),
      },
    };
  }

  // ---- the lamp ----
  function updateLamp(dt: number, fighting: boolean) {
    const p = player();
    const lamp = body.lamp(tmp);
    const L = T.lamp;
    sweepT += dt;
    let target: V3;
    if (fighting && p?.pos) {
      const px = p.pos.x,
        pz = p.pos.z;
      const dx = px - body.pos.x,
        dz = pz - body.pos.z;
      const len = Math.hypot(dx, dz) || 1;
      // The sway is an angle, not a distance: up close it mustn't swing the beam off a player standing still.
      const s = beam === "lock" ? 0 : Math.min(L.sweep, 0.12 * len) * Math.sin((sweepT * 2 * Math.PI) / L.period);
      target = v3(px + (-dz / len) * s, 1.0, pz + (dx / len) * s);
    } else {
      // Walking in: it sweeps the quay ahead of itself.
      const ahead = 14;
      const s = 5 * Math.sin(sweepT * 1.3);
      target = v3(body.pos.x + Math.sin(yaw) * ahead + Math.cos(yaw) * s, 0.5, body.pos.z + Math.cos(yaw) * ahead - Math.sin(yaw) * s);
    }
    const speed = beam === "lock" ? 26 : beam === "volley" ? 9 : L.aimSpeed;
    const ax = target.x - aim.x,
      ay = target.y - aim.y,
      az = target.z - aim.z;
    const ad = Math.hypot(ax, ay, az);
    const step = Math.min(ad, speed * dt);
    if (ad > 1e-6) ((aim.x += (ax / ad) * step), (aim.y += (ay / ad) * step), (aim.z += (az / ad) * step));

    const bx = aim.x - lamp.x,
      by = aim.y - lamp.y,
      bz = aim.z - lamp.z;
    const bl = Math.hypot(bx, by, bz) || 1;
    const dir = drive.beam.dir;
    ((dir.x = bx / bl), (dir.y = by / bl), (dir.z = bz / bl));
    let length = L.range;
    try {
      const hit = G?.physics?.raycast?.(lamp, dir, L.range);
      if (hit && hit.dist > 0) length = hit.dist;
    } catch {
      /* no physics: the beam runs its full length */
    }
    drive.beam.length = length;

    let inBeam = false;
    if (fighting && playerAlive()) {
      const eye = p.eye ?? { x: p.pos.x, y: p.pos.y + 1.5, z: p.pos.z };
      const cx = p.pos.x - lamp.x,
        cy = p.pos.y + 1.1 - lamp.y,
        cz = p.pos.z - lamp.z;
      const cd = Math.hypot(cx, cy, cz);
      const cos = (cx * dir.x + cy * dir.y + cz * dir.z) / (cd || 1);
      if ((losT -= dt) <= 0) {
        losT = 0.1;
        try {
          los = !!G?.physics?.lineOfSight?.(lamp, eye);
        } catch {
          los = false;
        }
      }
      inBeam = cd < L.range && cos > Math.cos(L.halfAngle) && los;
    }

    if (!fighting) {
      assess = 0;
      drive.beam.on = phase === "arriving" ? 0.85 : 0;
    } else if (beam === "sweep") {
      const drain = los ? L.decay : L.decayHidden;
      assess = Math.max(0, Math.min(1, assess + (inBeam ? dt / L.fillSeconds : -drain * dt)));
      drive.beam.on = 1;
      if (assess >= 1 && playerAlive()) {
        beam = "lock";
        beamT = L.lock;
        sfx("telegraph", { pos: lamp, pitch: 0.42, gain: 1, variant: 0, jitter: 0 });
      }
    } else if (beam === "lock") {
      drive.beam.on = 1;
      if ((beamT -= dt) <= 0) {
        beam = "volley";
        shots = T.volley.bolts;
        gapT = 0;
      }
    } else if (beam === "volley") {
      drive.beam.on = 1;
      gapT -= dt;
      while (gapT <= 0 && shots > 0) {
        gapT += T.volley.gap;
        fire(T.volley.bolts - shots);
        shots--;
      }
      if (shots <= 0) {
        beam = "cool";
        beamT = L.cooldown;
        assess = 0;
      }
    } else {
      drive.beam.on = 0.35;
      if ((beamT -= dt) <= 0) beam = "sweep";
    }
    drive.beam.heat = beam === "lock" || beam === "volley" ? 1 : beam === "cool" ? 0 : assess;
    drive.beam.lock = beam === "lock" || beam === "volley";
  }

  function fire(k: number) {
    const p = player();
    if (!p?.pos) return;
    const from = body.muzzle(k, tmp2);
    const tx = p.pos.x,
      ty = p.pos.y + 1.1,
      tz = p.pos.z;
    const d = Math.hypot(tx - from.x, ty - from.y, tz - from.z) || 1;
    const lead = (d / T.volley.speed) * 0.5;
    const vx = p.vel?.x ?? 0,
      vz = p.vel?.z ?? 0;
    const sp = T.volley.spread;
    const dir = v3(
      (tx + vx * lead - from.x) / d + (deps.rng() - 0.5) * 2 * sp,
      (ty - from.y) / d + (deps.rng() - 0.5) * sp,
      (tz + vz * lead - from.z) / d + (deps.rng() - 0.5) * 2 * sp,
    );
    const l = Math.hypot(dir.x, dir.y, dir.z) || 1;
    ((dir.x /= l), (dir.y /= l), (dir.z /= l));
    bolts.fire(from, dir);
    sfx("hound_fire", { pos: from, pitch: 0.72, gain: 1, jitter: 0.05 });
  }

  // ---- the stamp ----
  function updateStamp(dt: number, fighting: boolean) {
    const p = player();
    stampCd -= dt;
    if (!stamp && fighting && stampCd <= 0 && beam !== "lock" && beam !== "volley" && playerAlive()) {
      let near = hdist(p.pos, body.pos.x, body.pos.z) < T.stamp.near;
      let foot = 0,
        fd = Infinity;
      for (let i = 0; i < body.feet; i++) {
        const f = body.foot(i, tmp);
        const d = hdist(p.pos, f.x, f.z);
        if (d < fd) ((fd = d), (foot = i));
      }
      near = near || fd < T.stamp.nearFoot;
      if (near) {
        stamp = { foot, t: 0, slammed: false };
        sfx("telegraph", { pos: body.foot(foot, tmp), pitch: 0.36, gain: 0.9, variant: 1, jitter: 0 });
      }
    }
    drive.stamp = null;
    if (stamp) {
      stamp.t += dt;
      const up = T.stamp.telegraph;
      const lift = stamp.t < up ? smooth(stamp.t / up) : Math.max(0, 1 - (stamp.t - up) / 0.1);
      drive.stamp = { foot: stamp.foot, lift };
      if (!stamp.slammed && stamp.t >= up + 0.1) {
        stamp.slammed = true;
        const f = body.foot(stamp.foot, tmp);
        waves.push({ x: f.x, z: f.z, t: 0, hit: false });
        body.shockwave(f.x, f.z);
        sfx("explosion", { pos: f, pitch: 0.55, gain: 0.95 });
        sfx("impact_metal", { pos: f, pitch: 0.4, gain: 1 });
        if (p?.pos && typeof p.addShake === "function") {
          const d = hdist(p.pos, f.x, f.z);
          p.addShake(Math.max(0.15, 0.7 * (1 - d / 20)));
        }
        stampCd = T.stamp.cooldown;
      }
      if (stamp.t > up + 0.4) stamp = null;
    }
    for (let i = waves.length - 1; i >= 0; i--) {
      const w = waves[i];
      w.t += dt;
      const r = w.t * T.stamp.speed;
      if (r > T.stamp.radius + T.stamp.band) {
        waves.splice(i, 1);
        continue;
      }
      if (w.hit || !playerAlive()) continue;
      const d = hdist(p.pos, w.x, w.z);
      const onApron = p.pos.y < T.stamp.apron && p.onGround !== false;
      if (onApron && Math.abs(d - r) < T.stamp.band / 2 + 0.25) {
        w.hit = true;
        p.damage?.(T.stamp.damage, { x: w.x, y: 0.5, z: w.z });
        const k = T.stamp.knock / (d || 1);
        if (p.vel) ((p.vel.x += (p.pos.x - w.x) * k), (p.vel.z += (p.pos.z - w.z) * k), (p.vel.y = Math.max(p.vel.y ?? 0, 3.5)));
      }
    }
  }

  function update(dt: number) {
    if (disposed || !(dt > 0)) return;
    dt = Math.min(dt, 0.05);
    t += dt;
    for (let i = 0; i < N; i++)
      if (flash[i] > 0 && (flash[i] -= dt) <= 0 && hp[i] > 0) body.setCore(i, "live");

    const p = player();
    if (phase === "arriving") {
      const A = T.arrive;
      const d = Math.max(0, t - A.rumble) * A.speed;
      const at = pathAt(d);
      drive.at.x = at.x;
      drive.at.z = at.z;
      yaw += wrap(at.yaw - yaw) * Math.min(1, dt * 2);
      if (t < A.rumble && p?.addShake && Math.floor((t - dt) * 3) !== Math.floor(t * 3)) p.addShake(0.12);
      if (d >= PATH_LEN && t - A.rumble - PATH_LEN / A.speed >= A.settle) {
        phase = "fighting";
        t = 0;
        aim = v3(p?.pos?.x ?? aim.x, 1, p?.pos?.z ?? aim.z);
      }
      updateLamp(dt, false);
    } else if (phase === "fighting") {
      if (p?.pos) {
        const want = Math.atan2(p.pos.x - body.pos.x, p.pos.z - body.pos.z);
        const diff = wrap(want - yaw);
        yaw = wrap(yaw + Math.sign(diff) * Math.min(Math.abs(diff), T.turnRate * dt));
      }
      updateLamp(dt, true);
      updateStamp(dt, true);
    } else if (phase === "dying") {
      drive.slump = smooth(t / T.slump);
      drive.beam.on = t < 0.9 && Math.sin(t * 47) > 0 ? 1 - t : 0;
      drive.beam.heat = 1;
      if (t >= T.slump) {
        phase = "dead";
        t = 0;
        sfx("container_bang", { pos: body.pos, pitch: 0.7, gain: 1 });
        sfx("foghorn", { pos: { x: 40, y: 3, z: 26 }, pitch: 1, gain: 0.8, jitter: 0 });
      }
    } else {
      drive.slump = 1;
      drive.beam.on = 0;
      boatT += dt;
    }
    if (phase !== "fighting") updateStamp(dt, false);
    bolts.update(dt);
    drive.phase = phase;
    drive.yaw = yaw;
    body.update(dt, drive);
    if (phase === "dead" && boatT > T.boatIn + 1.5) bar.hide();
    else
      bar.set({
        health: health(),
        live: hp.map((h) => h > 0),
        assess: phase === "fighting" ? (beam === "lock" || beam === "volley" ? 1 : assess) : 0,
        lock: beam === "lock" || beam === "volley",
      });
  }

  return {
    get phase() {
      return phase;
    },
    cores: N,
    get hp() {
      return hp;
    },
    get health() {
      return health();
    },
    get assess() {
      return assess;
    },
    get beam() {
      return beam;
    },
    said,
    get calls() {
      return calls;
    },
    get boat() {
      return phase === "dead" ? Math.min(1, boatT / T.boatIn) : 0;
    },
    blocked() {
      return !disposed && !(phase === "dead" && boatT >= T.boatIn);
    },
    raycast,
    core: (i: number) => body.core(i, v3()),
    body,
    update,
    playerDied() {
      if (phase === "arriving" || phase === "fighting") say("death", LINES.death, 5);
      stamp = null;
      bolts.clear();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      bolts.dispose();
      body.dispose();
      bar.dispose();
    },
  };
}
