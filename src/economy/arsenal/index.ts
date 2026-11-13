// The kit (docs/CAMPAIGN.md → The kit), in the game: the breaker charge on G, the rifle butt on the melee action the
// baseline bound and never used, and the pickups that feed both (ammo tins, med injectors, charges) in supply lockers
// and under dead machines. It is G.arsenal (campaign/types.ts → ArsenalApi) for the campaign runner and the missions.
//
// Two `// ext:` hooks in src/game.js let it work: the `charge` action on KeyG in the keymap, and weapon.kick(), a
// shove on the view model's recoil springs. Everything else goes through what the game already exposes. Anything
// here that throws is caught: the shooter never depends on the kit.
import type { ArsenalApi, PickupKind, V2, V3 } from "../campaign/types";
import { createArsenalHud, type ArsenalHud } from "./hud";
import { FEED, TUNE, burstEffect, centreOf, clampCharges, cooldown, dist3, dropFor, inSwing, pickupAmount, planLockers, stepCharge, throwVelocity } from "./rules";
import { LOCKER_SPOTS, type LockerSpot } from "./spots";
import { STUB_WORLD, createArsenalWorld, type ArsenalWorld, type FlightView, type LockerView, type PickupView } from "./world";

/* eslint-disable @typescript-eslint/no-explicit-any -- the game context is the untyped bundle's G */
type Game = any;

export interface ArsenalOptions {
  /** The three.js side and the HUD (tests pass stand-ins or leave them out). */
  world?: ArsenalWorld;
  hud?: ArsenalHud;
  /** Rolls the drops; by default a fork of the game's seeded generator. */
  rng?: () => number;
  table?: readonly LockerSpot[];
}

export interface PickupInfo {
  kind: PickupKind;
  x: number;
  y: number;
  z: number;
  /** The locker it sits in, or null on the ground. */
  locker: number | null;
}
export interface LockerInfo {
  id: number;
  x: number;
  z: number;
  yaw: number;
  kind: PickupKind;
  taken: boolean;
}

export interface Arsenal extends ArsenalApi {
  /** Throws a charge along the player's aim. False if there is none, it's cooling down or nobody is playing. */
  throwCharge(): boolean;
  /** Swings the rifle butt. False inside the cooldown. */
  swing(): boolean;
  /** Bursts a charge here, now. */
  detonate(pos: V3): void;
  /** Seconds a machine is still held for (0 if it isn't). */
  heldFor(enemy: unknown): number;
  readonly pickups: readonly PickupInfo[];
  readonly lockers: readonly LockerInfo[];
  /** Charges in the air. */
  readonly flights: number;
  update(dt: number): void;
  dispose(): void;
}

interface Pickup {
  kind: PickupKind;
  pos: V3;
  view: PickupView | null;
  locker: Locker | null;
  /** A drop still falling: its speed and where it lands. */
  vy: number;
  rest: number;
}
interface Locker {
  spot: LockerSpot;
  kind: PickupKind;
  view: LockerView;
  taken: boolean;
}
interface Flight {
  pos: V3;
  vel: V3;
  t: number;
  view: FlightView;
}
interface Hold {
  left: number;
  /** What its `passive` flag was before the hold. */
  passive: boolean;
  tick: number;
}

const FEED_HTML = (text: string) => text.replace(/^(\+\d+)/, "<b>$1</b>");

export function createArsenal(G: Game, opts: ArsenalOptions = {}): Arsenal {
  const world = opts.world ?? createArsenalWorld(G);
  const hud = opts.hud ?? createArsenalHud(G);
  const table = opts.table ?? LOCKER_SPOTS;
  const rng: () => number =
    opts.rng ??
    (() => {
      try {
        const f = G.rng?.fork?.();
        if (typeof f === "function") return f;
      } catch {
        /* fall through */
      }
      return Math.random;
    })();
  const C = TUNE.charge,
    B = TUNE.butt;

  const warned = new Set<string>();
  function guard<T>(where: string, fn: () => T): T | undefined {
    try {
      return fn();
    } catch (e) {
      if (!warned.has(where)) (warned.add(where), console.warn(`[arsenal] ${where} failed; the game plays on`, e));
      return undefined;
    }
  }
  const T3 = G?.THREE;
  const vec = (p: V3) => (T3 ? new T3.Vector3(p.x, p.y, p.z) : { ...p });
  const sfx = (name: string, o?: Record<string, unknown>) => {
    try {
      G.audio?.play?.(name, o);
    } catch {
      /* sound is never load-bearing */
    }
  };
  const emit = (name: string, e: unknown) => guard(`emit ${name}`, () => G.events?.emit?.(name, e));
  const playing = () => G.game?.state === "playing";
  const player = () => {
    const p = G.player;
    return p && p.alive !== false && p.pos ? p : null;
  };
  const groundAt = (x: number, z: number, below: number): number => guard("ground", () => G.physics?.groundHeight?.(x, z, below)) ?? 0;
  const walkable = (x: number, z: number): boolean => {
    const nav = G.physics?.nav;
    return !nav || typeof nav.isWalkable !== "function" || !!nav.isWalkable(x, z);
  };

  let charges = 0;
  const throwCd = cooldown(C.cooldown);
  const swingCd = cooldown(B.cooldown);
  let pickups: Pickup[] = [];
  let lockers: Locker[] = [];
  let flights: Flight[] = [];
  const holds = new Map<any, Hold>();
  let flash = 0;
  let was = { charge: false, melee: false };

  // ---- charges ----
  function setCharges(n: number) {
    charges = clampCharges(n);
    hud.setCharges(charges, !throwCd.ready());
  }

  // ---- the hold on a hound ----
  // The baseline has no stun. A hound that is `passive` and on `patrol` with no goal stands and waits (its own
  // patrol pause), ignores what it sees and what hits it, and holds no fire token; so the hold is those existing
  // states, asserted each frame for its length, and then it is provoked the way a shot provokes it.
  function hold(e: any, seconds: number) {
    const h = holds.get(e) ?? { left: 0, passive: !!e.passive, tick: 0 };
    h.left = Math.max(h.left, seconds);
    holds.set(e, h);
    guard("release", () => G.enemies?.debug?.ctx?.releaseToken?.(e));
    e.es = "move";
    e.speed = 0;
    if (e.sY) e.sY.v -= 1.2; // it sags on its legs
    keepHeld(e, h);
  }
  function keepHeld(e: any, h: Hold) {
    e.passive = true;
    e.mode = "patrol";
    e.hasGoal = false;
    e.path = null;
    e.waitT = Math.max(Number(e.waitT) || 0, h.left + 0.5);
  }
  function release(e: any, h: Hold, wake: boolean) {
    holds.delete(e);
    e.passive = h.passive;
    if (!wake || !e.alive) return;
    e.waitT = 0;
    const p = player();
    if (p && !guard("provoke", () => (G.enemies?.debug?.ctx?.provoke ? (G.enemies.debug.ctx.provoke(e), true) : false))) {
      e.mode = "investigate";
      e.modeT = 10;
      e.lastKnown?.copy?.(p.pos);
    }
  }
  function updateHolds(dt: number) {
    for (const [e, h] of holds) {
      if (!e.alive || e.active === false) {
        release(e, h, false);
        continue;
      }
      h.left -= dt;
      if (h.left <= 0) {
        release(e, h, true);
        continue;
      }
      keepHeld(e, h);
      // It twitches and spits while it's held: its body springs, its lens, a few sparks.
      h.tick -= dt;
      if (h.tick <= 0) {
        h.tick = 0.09 + Math.random() * 0.16;
        if (e.sR) e.sR.v += (Math.random() - 0.5) * 5;
        if (e.sP) e.sP.v += (Math.random() - 0.5) * 3;
        e.flare = Math.random() < 0.45 ? 1 : 0;
        if (Math.random() < 0.5) world.crackle(e.pos);
      }
    }
  }
  function clearHolds() {
    for (const [e, h] of [...holds]) release(e, h, false);
  }

  // ---- the burst ----
  function detonate(pos: V3) {
    const at = { x: pos.x, y: pos.y, z: pos.z };
    for (const e of [...((G.enemies?.list as any[]) ?? [])]) {
      if (!e || !e.alive || !e.pos) continue;
      const mid = centreOf(e.type, e.pos);
      const d = dist3(mid, at);
      const effect = burstEffect(e.type, d);
      if (effect.kind === "none") continue;
      const away = { x: (mid.x - at.x) / (d || 1), y: (mid.y - at.y) / (d || 1) + 0.2, z: (mid.z - at.z) / (d || 1) };
      const amount = effect.kind === "destroy" ? 9999 : effect.damage;
      const killed = guard("burst damage", () => e.damage(amount, vec(mid), vec(away), "body", "charge")) === true;
      if (!killed && effect.kind === "stun") guard("hold", () => hold(e, effect.seconds));
      emit("player:hitEnemy", { enemy: e, part: "body", killed, weak: false });
    }
    guard("burst fx", () => world.burst(at, C.radius));
    // A dry electrical crack over a short low thump: the bank's relay cut and its explosion, re-pitched.
    sfx("relay_cut", { pos: at, pitch: 1.7, gain: 1, jitter: 0.03 });
    sfx("explosion", { pos: at, pitch: 1.75, gain: 0.42 });
    sfx("impact_glass", { pos: at, pitch: 0.7, gain: 0.8 });
    const p = G.player;
    if (p?.eye || p?.pos) {
      const d = dist3(p.eye ?? p.pos, at);
      guard("shake", () => p.addShake?.(Math.max(0, 0.55 * (1 - d / 16))));
      flash = Math.max(flash, Math.max(0, 0.7 * (1 - d / 13)));
    }
    guard("alert", () => G.enemies?.alert?.(vec(at), 25));
    emit("emp:detonated", { pos: at, radius: C.radius });
  }

  // ---- the throw ----
  function throwCharge(): boolean {
    const p = player();
    if (!p || !playing() || !throwCd.ready()) return false;
    if (charges <= 0) {
      hud.pulse("empty");
      sfx("ui_click", { gain: 0.5, pitch: 0.7 });
      throwCd.fire();
      return false;
    }
    const f: V3 = p.forward ? { x: p.forward.x, y: p.forward.y, z: p.forward.z } : { x: -Math.sin(p.yaw || 0), y: 0, z: -Math.cos(p.yaw || 0) };
    // From the left hand, a little ahead of the shoulder; from the eye if a wall is that close.
    const flat = Math.hypot(f.x, f.z) || 1;
    const left = { x: f.z / flat, z: -f.x / flat };
    let from: V3 = { x: p.pos.x + f.x * 0.4 + left.x * 0.22, y: p.pos.y + C.hand + f.y * 0.4, z: p.pos.z + f.z * 0.4 + left.z * 0.22 };
    const eye: V3 = p.eye ? { x: p.eye.x, y: p.eye.y, z: p.eye.z } : { x: p.pos.x, y: p.pos.y + 1.6, z: p.pos.z };
    const reach = dist3(eye, from);
    const dir = { x: (from.x - eye.x) / reach, y: (from.y - eye.y) / reach, z: (from.z - eye.z) / reach };
    if (guard("hand ray", () => G.physics?.raycast?.(vec(eye), vec(dir), reach + 0.15))) from = { x: eye.x, y: eye.y - 0.15, z: eye.z };
    charges--;
    throwCd.fire();
    hud.setCharges(charges, true);
    flights.push({ pos: from, vel: throwVelocity(f), t: 0, view: guard("flight", () => world.flight(from)) ?? STUB_WORLD.flight(from) });
    sfx("jump", { gain: 0.8, pitch: 1.45 });
    guard("toss", () => G.weapon?.kick?.(0.6, -3.5, -2.5, 5));
    return true;
  }
  function updateFlights(dt: number) {
    if (!flights.length) return;
    const done: Flight[] = [];
    for (const f of flights) {
      let left = dt;
      let burstAt: V3 | null = null;
      while (left > 1e-6 && !burstAt) {
        const h = Math.min(left, 1 / 90);
        left -= h;
        const prev = { ...f.pos };
        stepCharge(f.pos, f.vel, h);
        f.t += h;
        const dx = f.pos.x - prev.x,
          dy = f.pos.y - prev.y,
          dz = f.pos.z - prev.z;
        const len = Math.hypot(dx, dy, dz) || 1e-6;
        const o = vec(prev),
          d = vec({ x: dx / len, y: dy / len, z: dz / len });
        // The nearest of a wall, a machine or another shot target (the Assessor, the Bailiff) along this step.
        let near = len + 0.08;
        let hit = false;
        const wall = guard("ray", () => G.physics?.raycast?.(o, d, near));
        if (wall && typeof wall.dist === "number" && wall.dist <= near) ((near = wall.dist), (hit = true));
        const mech = guard("enemy ray", () => G.enemies?.raycast?.(o, d, near));
        if (mech && typeof mech.dist === "number" && mech.dist <= near) ((near = mech.dist), (hit = true));
        const other = guard("target ray", () => G.ext?.raycast?.(o, d, near));
        if (other && typeof other.dist === "number" && other.dist <= near) ((near = other.dist), (hit = true));
        if (hit) {
          const back = Math.max(0, near - 0.06);
          burstAt = { x: prev.x + (dx / len) * back, y: prev.y + (dy / len) * back, z: prev.z + (dz / len) * back };
          break;
        }
        const ground = groundAt(f.pos.x, f.pos.z, prev.y + 0.3);
        if (f.pos.y <= ground + 0.07) burstAt = { x: f.pos.x, y: ground + 0.12, z: f.pos.z };
        else if (f.t >= C.fuse) burstAt = { ...f.pos };
      }
      if (burstAt) {
        done.push(f);
        f.view.remove();
        const at = burstAt;
        guard("detonate", () => detonate(at));
      } else f.view.place(f.pos, f.t);
    }
    if (done.length) flights = flights.filter((f) => !done.includes(f));
  }

  // ---- the rifle butt ----
  function swing(): boolean {
    const p = player();
    if (!p || !playing() || !swingCd.ready()) return false;
    swingCd.fire();
    const yaw = p.yaw || 0;
    const flat = { x: -Math.sin(yaw), y: 0, z: -Math.cos(yaw) };
    const eye: V3 = p.eye ? { x: p.eye.x, y: p.eye.y, z: p.eye.z } : { x: p.pos.x, y: p.pos.y + 1.6, z: p.pos.z };
    emit("weapon:melee", {}); // the bank's swing
    // The stock comes round: the rifle turns across the view, rolls and drives forward, and the camera takes it.
    guard("shove", () => G.weapon?.kick?.(-9, 7, 24, -13));
    guard("punch", () => (p.addShake?.(0.2), p.addRecoil?.(0.012, -0.016)));

    let landed = false;
    const report = (enemy: any, point: V3, part: string, dist: number, killed: boolean) => {
      landed = true;
      const dir = vec(flat);
      emit("impact", { point: vec(point), normal: vec({ x: -flat.x, y: 0, z: -flat.z }), dist, surface: "enemy", enemy, part, dir, from: "player", killed, melee: true });
      emit("player:hitEnemy", { enemy, part, killed, weak: false, melee: true });
    };
    for (const e of [...((G.enemies?.list as any[]) ?? [])]) {
      if (!e || !e.alive || !e.pos) continue;
      const mid = centreOf(e.type, e.pos);
      if (!inSwing(eye, yaw, mid)) continue;
      const killed = guard("butt damage", () => e.damage(B.damage, vec(mid), vec(flat), "body", "melee")) === true;
      if (e.type === "hound" && !killed) {
        // Its own push carries it back (it decays at 5/s), and a wind-up or a lunge ends in its recovery.
        if (e.push) ((e.push.x += flat.x * B.knockback * 5), (e.push.z += flat.z * B.knockback * 5));
        if (e.es === "wind" || e.es === "lunge") {
          e.es = "recover";
          e.esT = 0.55;
          e.speed = 0;
          e.lungeCd = Number(G.enemies?.TUNE?.hound?.lungeCooldown) || 3.5;
        }
      }
      report(e, mid, "body", Math.hypot(mid.x - eye.x, mid.z - eye.z), killed);
    }
    // Anything else that takes the player's shots (hooks.ts: the Assessor, the Bailiff) gets the same ray the rifle
    // would send, cut to the stock's reach, and reacts as it sees fit.
    const f3: V3 = p.forward ? { x: p.forward.x, y: p.forward.y, z: p.forward.z } : flat;
    const hit = guard("target ray", () => G.ext?.raycast?.(vec(eye), vec(f3), B.reach)) as any;
    if (hit && typeof hit.dist === "number" && hit.dist <= B.reach && hit.enemy && typeof hit.enemy.damage === "function") {
      const point = hit.point ?? { x: eye.x + f3.x * hit.dist, y: eye.y + f3.y * hit.dist, z: eye.z + f3.z * hit.dist };
      const killed = guard("target damage", () => hit.enemy.damage(B.damage, point, vec(f3), hit.part ?? "body", "melee")) === true;
      report(hit.enemy, point, hit.part ?? "body", hit.dist, killed);
    }
    if (landed) {
      sfx("impact_metal", { pos: { x: eye.x + flat.x, y: eye.y - 0.4, z: eye.z + flat.z }, gain: 0.9, pitch: 0.78 });
      guard("punch", () => p.addShake?.(0.22));
    }
    return true;
  }

  // ---- pickups ----
  const carrying = () => {
    const p = G.player ?? {};
    return { health: Number(p.health) || 0, maxHealth: Number(p.maxHealth) || 100, reserve: Number(G.weapon?.reserve) || 0, charges };
  };
  function addPickup(kind: PickupKind, pos: V3, rest: number, locker: Locker | null) {
    const view = locker ? null : (guard("pickup view", () => world.pickup(kind, pos)) ?? null);
    pickups.push({ kind, pos, view, locker, vy: 0, rest });
  }
  function spawnPickup(kind: PickupKind, at: V2) {
    const y = groundAt(at.x, at.z, (G.player?.pos?.y ?? 0) + 1.2);
    addPickup(kind, { x: at.x, y, z: at.z }, y, null);
  }
  function take(p: Pickup, amount: number) {
    if (p.kind === "ammo") guard("ammo", () => G.weapon?.addAmmo?.(amount));
    else if (p.kind === "med") guard("heal", () => G.player?.heal?.(amount));
    else (setCharges(charges + amount), hud.pulse("gain"));
    guard("feed", () => G.hud?.feed?.(FEED_HTML(FEED[p.kind](amount))));
    sfx("ui_click", { gain: 0.9, pitch: p.kind === "med" ? 1.25 : 0.9 });
    sfx(p.kind === "ammo" ? "reload_magin" : p.kind === "med" ? "land" : "reload_bolt", { gain: 0.75, pitch: p.kind === "med" ? 1.7 : 1.15 });
    if (p.locker) ((p.locker.taken = true), guard("locker", () => p.locker!.view.empty()));
    else p.view?.remove();
    pickups = pickups.filter((x) => x !== p);
    emit("pickup:taken", { kind: p.kind, amount });
  }
  function updatePickups(dt: number) {
    const who = player();
    for (const p of [...pickups]) {
      if (p.pos.y > p.rest) {
        p.vy -= 9.81 * dt;
        p.pos.y = Math.max(p.rest, p.pos.y + p.vy * dt);
        if (p.pos.y <= p.rest) ((p.vy = 0), sfx("shell_bounce", { pos: p.pos, gain: 0.8, pitch: 0.55 }));
        p.view?.place(p.pos);
      }
      if (!who) continue;
      if (Math.hypot(who.pos.x - p.pos.x, who.pos.z - p.pos.z) > TUNE.pickup.take || Math.abs(who.pos.y - p.pos.y) > 2.2) continue;
      const amount = pickupAmount(p.kind, carrying());
      if (amount > 0) take(p, amount);
    }
  }

  /** A dead machine's drop lands on walkable ground under it, or just beside it; nowhere if there is none. */
  function landing(pos: V3, type: string): V3 | null {
    const spread = type === "hound" ? 0.8 : 0; // clear of the wreck
    const a0 = rng() * 6.283;
    for (const r of [spread, spread + 0.7, spread + 1.5, spread + 2.5])
      for (let k = 0; k < (r === 0 ? 1 : 8); k++) {
        const a = a0 + (k * 6.283) / 8;
        const x = pos.x + Math.cos(a) * r,
          z = pos.z + Math.sin(a) * r;
        if (!walkable(x, z)) continue;
        const y = groundAt(x, z, 1);
        if (y > 0.5) continue; // a container's roof is not the ground
        return { x, y, z };
      }
    return null;
  }
  function drop(e: { type?: string; pos?: V3; enemy?: any }) {
    const type = e?.type ?? e?.enemy?.type;
    const pos = e?.pos ?? e?.enemy?.pos;
    if (!type || !pos || !playing()) return;
    const kind = dropFor(type, rng());
    if (!kind) return;
    const land = landing({ x: pos.x, y: pos.y, z: pos.z }, type);
    if (!land) return;
    addPickup(kind, { x: land.x, y: Math.max(land.y, pos.y), z: land.z }, land.y, null);
  }

  // ---- lockers ----
  function removeLockers() {
    for (const l of lockers) guard("locker remove", () => l.view.remove());
    pickups = pickups.filter((p) => !p.locker);
    lockers = [];
  }
  function placeLockers(seed: number, count: number) {
    removeLockers();
    for (const plan of planLockers(seed, count, table)) {
      const view = guard("locker", () => world.locker(plan.spot, plan.kind)) ?? STUB_WORLD.locker(plan.spot, plan.kind);
      const l: Locker = { spot: plan.spot, kind: plan.kind, view, taken: false };
      lockers.push(l);
      addPickup(plan.kind, { ...view.shelf }, view.shelf.y, l);
    }
  }

  function clear() {
    for (const p of pickups) guard("pickup remove", () => p.view?.remove());
    pickups = [];
    removeLockers();
    for (const f of flights) guard("flight remove", () => f.view.remove());
    flights = [];
    clearHolds();
    flash = 0;
    hud.flash(0);
    guard("world clear", () => world.clear());
  }

  // ---- a run ----
  function startRun() {
    clear();
    throwCd.reset();
    swingCd.reset();
    was = { charge: false, melee: false };
    // Until the campaign runner sets the mission up (it calls setCharges and placeLockers itself).
    if (!G.campaign) {
      setCharges(TUNE.defaults.charges);
      placeLockers(Math.floor(rng() * 0x7fffffff), TUNE.defaults.lockers);
    } else hud.setCharges(charges, false);
  }

  const offs: (() => void)[] = [];
  const on = (name: string, fn: (e: any) => void) => {
    const off = G.events?.on?.(name, (e: any) => guard(name, () => fn(e)));
    if (typeof off === "function") offs.push(off);
  };
  on("run:start", startRun);
  on("enemy:killed", drop);
  on("game:state", (e: { state?: string }) => {
    if (e?.state === "title" || e?.state === "dead" || e?.state === "complete") clear();
  });
  hud.setCharges(charges, false);
  // Attached mid-run (an ?autostart run starts before the economy loads): this run gets its kit too.
  const st = G.game?.state;
  if (st === "intro" || st === "playing" || st === "paused") guard("late start", startRun);

  return {
    charges: () => charges,
    setCharges,
    addCharges: (n: number) => setCharges(charges + (Number.isFinite(n) ? n : 0)),
    spawnPickup,
    placeLockers,
    clear,
    throwCharge,
    swing,
    detonate,
    heldFor: (e) => Math.max(0, holds.get(e)?.left ?? 0),
    get pickups() {
      return pickups.map((p) => ({ kind: p.kind, x: p.pos.x, y: p.pos.y, z: p.pos.z, locker: p.locker ? p.locker.spot.id : null }));
    },
    get lockers() {
      return lockers.map((l) => ({ id: l.spot.id, x: l.spot.x, z: l.spot.z, yaw: l.spot.yaw, kind: l.kind, taken: l.taken }));
    },
    get flights() {
      return flights.length;
    },
    update(dt: number) {
      guard("world", () => world.update(dt));
      if (flash > 0) ((flash = flash < 0.01 ? 0 : flash * Math.exp(-9 * dt)), hud.flash(flash));
      if (!playing()) return;
      throwCd.tick(dt);
      swingCd.tick(dt);
      // The input module clears `pressed` inside the game's own frame, so the edges are found here from `down`.
      const input = G.input;
      const now = { charge: !!guard("input", () => input?.down?.("charge")), melee: !!guard("input", () => input?.down?.("melee")) };
      if (now.charge && !was.charge) guard("throw", throwCharge);
      if (now.melee && !was.melee) guard("swing", swing);
      was = now;
      guard("flights", () => updateFlights(dt));
      guard("holds", () => updateHolds(dt));
      guard("pickups", () => updatePickups(dt));
      hud.setCharges(charges, !throwCd.ready());
    },
    dispose() {
      clear();
      for (const off of offs) off();
      hud.dispose();
    },
  };
}

/** Starts the kit beside a booted game (main.ts) as G.arsenal, and drives it on animation frames. */
export function startArsenal(G: Game): Arsenal | null {
  try {
    const a = createArsenal(G);
    G.arsenal = a;
    let last = performance.now();
    const loop = (now: number) => {
      const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
      last = now;
      a.update(dt);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
    return a;
  } catch (e) {
    console.warn("[arsenal] off:", e);
    return null;
  }
}
