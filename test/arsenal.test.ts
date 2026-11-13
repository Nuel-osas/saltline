// The kit (src/economy/arsenal): the rules as plain functions, then the module driven against a stand-in game.
import { describe, expect, it } from "vitest";
import type { PickupKind, V3 } from "../src/economy/campaign/types";
import { createArsenal, type ArsenalOptions } from "../src/economy/arsenal";
import { FEED, TUNE, burstEffect, clampCharges, cooldown, dropFor, inSwing, pickupAmount, planLockers, seeded, stepCharge, throwVelocity } from "../src/economy/arsenal/rules";
import { LOCKER_SPOTS } from "../src/economy/arsenal/spots";

// ---------------------------------------------------------------------------------------------------------------
// A stand-in for the game: events, a player, a weapon, machines that record what is done to them.

type Handler = (e: any) => void;
function fakeGame(over: Record<string, unknown> = {}) {
  const handlers = new Map<string, Handler[]>();
  const sent: { name: string; e: any }[] = [];
  const feed: string[] = [];
  const keys = new Set<string>();
  const G: any = {
    events: {
      on(name: string, fn: Handler) {
        handlers.set(name, [...(handlers.get(name) ?? []), fn]);
        return () => handlers.set(name, (handlers.get(name) ?? []).filter((f) => f !== fn));
      },
      emit(name: string, e: any) {
        sent.push({ name, e });
        for (const fn of handlers.get(name) ?? []) fn(e);
      },
    },
    game: { state: "playing" },
    // Facing +x: the game's forward is (-sin yaw, 0, -cos yaw).
    player: { pos: { x: 0, y: 0, z: 0 }, eye: { x: 0, y: 1.6, z: 0 }, forward: { x: 1, y: 0, z: 0 }, yaw: -Math.PI / 2, alive: true, health: 100, maxHealth: 100, shakes: 0, heal(n: number) {
      this.health = Math.min(this.maxHealth, this.health + n);
    }, addShake() {
      this.shakes++;
    }, addRecoil() {} },
    weapon: { reserve: 150, kicks: 0, addAmmo(n: number) {
      this.reserve += n;
    }, kick() {
      this.kicks++;
    } },
    enemies: { list: [] as any[], TUNE: { hound: { lungeCooldown: 3.5 } }, alerts: 0, alert() {
      this.alerts++;
    } },
    physics: { groundHeight: () => 0, raycast: () => null, nav: { isWalkable: () => true } },
    hud: { feed: (t: string) => feed.push(t) },
    input: { down: (a: string) => keys.has(a) },
    ext: {},
    ...over,
  };
  return { G, sent, feed, keys, emit: (name: string, e?: any) => G.events.emit(name, e) };
}

function machine(type: "gull" | "hound", pos: V3, hp = type === "gull" ? 45 : 140) {
  const m: any = {
    type,
    pos: { ...pos },
    alive: true,
    active: true,
    hp,
    passive: false,
    mode: "engage",
    es: "move",
    esT: 0,
    speed: 3,
    lungeCd: 0,
    hasGoal: true,
    waitT: 0,
    push: { x: 0, y: 0, z: 0 },
    hits: [] as { amount: number; how: unknown }[],
    damage(amount: number, _p: unknown, _d: unknown, _part: unknown, how: unknown) {
      if (!m.alive) return false;
      m.hits.push({ amount, how });
      m.hp -= amount;
      if (m.hp <= 0) m.alive = false;
      return !m.alive;
    },
  };
  return m;
}

const quiet: ArsenalOptions = { rng: () => 0.99 };
/** The kit attached at the title, as main.ts attaches it, with the game then put in play (no run:start yet). */
function make(G: any, opts: ArsenalOptions = quiet) {
  G.game.state = "title";
  const a = createArsenal(G, opts);
  G.game.state = "playing";
  return a;
}
const named =(sent: { name: string; e: any }[], name: string) => sent.filter((s) => s.name === name).map((s) => s.e);

// ---------------------------------------------------------------------------------------------------------------

describe("the breaker charge", () => {
  it("lands a level throw 14 m out, inside the fuse", () => {
    const pos = { x: 0, y: TUNE.charge.hand, z: 0 };
    const vel = throwVelocity({ x: 1, y: 0, z: 0 });
    let t = 0;
    while (pos.y > 0 && t < 3) (stepCharge(pos, vel, 1 / 90), (t += 1 / 90));
    expect(pos.x).toBeGreaterThan(13.6);
    expect(pos.x).toBeLessThan(14.4);
    expect(t).toBeLessThan(TUNE.charge.fuse);
    // It climbs before it falls: an arc you can see.
    const up = throwVelocity({ x: 1, y: 0, z: 0 });
    expect(up.y).toBeGreaterThan(3);
  });

  it("destroys gulls and hurts and holds hounds inside 3.5 m, and nothing outside", () => {
    expect(burstEffect("gull", 0)).toEqual({ kind: "destroy" });
    expect(burstEffect("gull", 3.5)).toEqual({ kind: "destroy" });
    expect(burstEffect("gull", 3.51)).toEqual({ kind: "none" });
    expect(burstEffect("hound", 2)).toEqual({ kind: "stun", damage: 80, seconds: 3 });
    expect(burstEffect("hound", 3.6)).toEqual({ kind: "none" });
    expect(burstEffect("assessor", 1)).toEqual({ kind: "none" });
    expect(burstEffect("gull", NaN)).toEqual({ kind: "none" });
  });

  it("bursts on machines by type and distance, and says so on emp:detonated", () => {
    const { G, sent } = fakeGame();
    const a = make(G);
    const near = machine("gull", { x: 2, y: 2, z: 0 });
    const far = machine("gull", { x: 6, y: 2, z: 0 });
    const hound = machine("hound", { x: 0, y: 0, z: 3 });
    const houndFar = machine("hound", { x: 0, y: 0, z: 5 });
    G.enemies.list.push(near, far, hound, houndFar);
    a.detonate({ x: 0, y: 0.5, z: 0 });
    expect(near.alive).toBe(false);
    expect(far.alive).toBe(true);
    expect(far.hits).toEqual([]);
    expect(hound.hp).toBe(60);
    expect(hound.hits).toEqual([{ amount: 80, how: "charge" }]);
    expect(houndFar.hp).toBe(140);
    expect(a.heldFor(hound)).toBeCloseTo(3, 5);
    expect(a.heldFor(houndFar)).toBe(0);
    expect(named(sent, "emp:detonated")).toEqual([{ pos: { x: 0, y: 0.5, z: 0 }, radius: 3.5 }]);
    expect(G.enemies.alerts).toBe(1);
  });

  it("holds a hound still for 3 s with the game's own states, then wakes it", () => {
    const { G } = fakeGame();
    const a = make(G);
    const hound = machine("hound", { x: 1, y: 0, z: 0 });
    G.enemies.list.push(hound);
    a.detonate({ x: 0, y: 0.5, z: 0 });
    expect(hound).toMatchObject({ passive: true, mode: "patrol", hasGoal: false, speed: 0 });
    hound.mode = "engage"; // whatever the game does to it meanwhile is undone the next frame
    hound.hasGoal = true;
    for (let i = 0; i < 29; i++) a.update(0.1);
    expect(hound).toMatchObject({ passive: true, mode: "patrol", hasGoal: false });
    expect(hound.waitT).toBeGreaterThan(0);
    expect(a.heldFor(hound)).toBeGreaterThan(0);
    a.update(0.1);
    a.update(0.1);
    expect(a.heldFor(hound)).toBe(0);
    expect(hound.passive).toBe(false);
    expect(hound.mode).toBe("investigate");
  });

  it("a hound the burst kills is not held", () => {
    const { G } = fakeGame();
    const a = make(G);
    const hound = machine("hound", { x: 1, y: 0, z: 0 }, 70);
    G.enemies.list.push(hound);
    a.detonate({ x: 0, y: 0.5, z: 0 });
    expect(hound.alive).toBe(false);
    expect(a.heldFor(hound)).toBe(0);
  });

  it("is thrown on G, flies its arc and bursts where it lands", () => {
    const { G, sent, keys, emit } = fakeGame();
    const a = make(G);
    emit("run:start", {});
    expect(a.charges()).toBe(2);
    keys.add("charge");
    a.update(1 / 60);
    expect(a.charges()).toBe(1);
    expect(a.flights).toBe(1);
    a.update(1 / 60); // the key is still down: one press, one throw
    expect(a.charges()).toBe(1);
    for (let i = 0; i < 90 && a.flights; i++) a.update(1 / 60);
    expect(a.flights).toBe(0);
    const [burst] = named(sent, "emp:detonated");
    expect(burst.radius).toBe(3.5);
    expect(burst.pos.x).toBeGreaterThan(13.5);
    expect(burst.pos.x).toBeLessThan(15);
    expect(burst.pos.y).toBeLessThan(0.3);
  });

  it("bursts on a wall in its way, and on its fuse in the open air", () => {
    const wall = fakeGame();
    wall.G.physics.raycast = (o: V3, d: V3, max: number) => (d.x > 0 && o.x < 5 && o.x + d.x * max >= 5 ? { dist: (5 - o.x) / d.x } : null);
    const a = make(wall.G);
    a.setCharges(1);
    expect(a.throwCharge()).toBe(true);
    for (let i = 0; i < 90 && a.flights; i++) a.update(1 / 60);
    expect(named(wall.sent, "emp:detonated")[0].pos.x).toBeCloseTo(4.94, 1);

    const air = fakeGame();
    air.G.physics.groundHeight = () => -50;
    const b = make(air.G);
    b.setCharges(1);
    b.throwCharge();
    let t = 0;
    while (b.flights && t < 3) (b.update(1 / 60), (t += 1 / 60));
    expect(t).toBeGreaterThan(1.15);
    expect(t).toBeLessThan(1.3);
  });

  it("waits between throws, and won't throw with none", () => {
    const { G } = fakeGame();
    const a = make(G);
    a.setCharges(3);
    expect(a.throwCharge()).toBe(true);
    expect(a.throwCharge()).toBe(false);
    a.update(TUNE.charge.cooldown / 2);
    expect(a.throwCharge()).toBe(false);
    a.update(TUNE.charge.cooldown / 2 + 0.01);
    expect(a.throwCharge()).toBe(true);
    expect(a.charges()).toBe(1);
    a.setCharges(0);
    const inAir = a.flights;
    a.update(0.01);
    a.update(TUNE.charge.cooldown);
    expect(a.throwCharge()).toBe(false);
    expect(a.flights).toBeLessThanOrEqual(inAir);
    expect(a.charges()).toBe(0);
  });

  it("caps the charges at three and never goes below none", () => {
    expect(clampCharges(7)).toBe(3);
    expect(clampCharges(-2)).toBe(0);
    expect(clampCharges(NaN)).toBe(0);
    expect(clampCharges(2.9)).toBe(2);
    const { G } = fakeGame();
    const a = make(G);
    a.setCharges(2);
    a.addCharges(1);
    expect(a.charges()).toBe(3);
    a.addCharges(1);
    expect(a.charges()).toBe(3);
    a.addCharges(-9);
    expect(a.charges()).toBe(0);
    a.setCharges(99);
    expect(a.charges()).toBe(3);
  });
});

describe("the rifle butt", () => {
  const eye = { x: 0, y: 1.6, z: 0 };
  const yaw = -Math.PI / 2; // facing +x
  const at = (deg: number, d: number, y = 0.6) => ({ x: Math.cos((deg * Math.PI) / 180) * d, y, z: Math.sin((deg * Math.PI) / 180) * d });

  it("reaches 2.3 m in a 60° cone", () => {
    expect(inSwing(eye, yaw, at(0, 2.3))).toBe(true);
    expect(inSwing(eye, yaw, at(0, 2.31))).toBe(false);
    expect(inSwing(eye, yaw, at(29, 2))).toBe(true);
    expect(inSwing(eye, yaw, at(-29, 2))).toBe(true);
    expect(inSwing(eye, yaw, at(31, 2))).toBe(false);
    expect(inSwing(eye, yaw, at(-31, 2))).toBe(false);
    expect(inSwing(eye, yaw, at(180, 1.5))).toBe(false);
    expect(inSwing(eye, yaw, at(90, 1))).toBe(false);
    // Something on top of the player is hit wherever it stands; a gull well overhead is not.
    expect(inSwing(eye, yaw, at(180, 0.4))).toBe(true);
    expect(inSwing(eye, yaw, at(0, 1.5, 4))).toBe(false);
  });

  it("hits the hound in front for 70, knocks it back and breaks its wind-up; the one behind is untouched", () => {
    const { G, sent } = fakeGame();
    const a = make(G);
    const front = machine("hound", { x: 1.8, y: 0, z: 0 });
    const behind = machine("hound", { x: -1.8, y: 0, z: 0 });
    front.es = "wind";
    front.esT = 0.2;
    G.enemies.list.push(front, behind);
    expect(a.swing()).toBe(true);
    expect(front.hp).toBe(70);
    expect(front.hits).toEqual([{ amount: 70, how: "melee" }]);
    expect(behind.hits).toEqual([]);
    expect(front.push.x).toBeGreaterThan(5);
    expect(Math.abs(front.push.z)).toBeLessThan(1e-6);
    expect(front).toMatchObject({ es: "recover", speed: 0, lungeCd: 3.5 });
    expect(named(sent, "weapon:melee")).toHaveLength(1);
    expect(named(sent, "player:hitEnemy")).toHaveLength(1);
    expect(G.weapon.kicks).toBe(1);
  });

  it("waits 0.45 s between swings, and swings on the melee action", () => {
    const { G, sent, keys } = fakeGame();
    const a = make(G);
    expect(a.swing()).toBe(true);
    expect(a.swing()).toBe(false);
    a.update(0.44);
    expect(a.swing()).toBe(false);
    a.update(0.02);
    expect(a.swing()).toBe(true);
    a.update(1);
    keys.add("melee");
    a.update(1 / 60);
    a.update(1 / 60);
    expect(named(sent, "weapon:melee")).toHaveLength(3);
    const c = cooldown(0.45);
    expect(c.ready()).toBe(true);
    c.fire();
    c.tick(0.4);
    expect(c.ready()).toBe(false);
    c.tick(0.05);
    expect(c.ready()).toBe(true);
  });

  it("sends other shot targets the rifle's ray, cut to its reach", () => {
    const { G, sent } = fakeGame();
    const calls: { max: number }[] = [];
    const taken: unknown[][] = [];
    const bailiff = { alive: true, damage: (...args: unknown[]) => (taken.push(args), false) };
    G.ext.raycast = (_o: V3, _d: V3, max: number) => (calls.push({ max }), { dist: 1.9, part: "body", enemy: bailiff });
    const a = make(G);
    a.swing();
    expect(calls).toEqual([{ max: 2.3 }]);
    expect(taken).toHaveLength(1);
    expect(taken[0][0]).toBe(70);
    expect(taken[0][4]).toBe("melee");
    expect(named(sent, "player:hitEnemy")[0].enemy).toBe(bailiff);
  });
});

describe("pickups", () => {
  const full = { health: 100, maxHealth: 100, reserve: TUNE.pickup.reserveCap, charges: 3 };

  it("gives 30 rounds, 35 health or one charge, and refuses what can't be carried", () => {
    expect(pickupAmount("ammo", { ...full, reserve: 150 })).toBe(30);
    expect(pickupAmount("ammo", { ...full, reserve: 225 })).toBe(15);
    expect(pickupAmount("ammo", full)).toBe(0);
    expect(pickupAmount("med", { ...full, health: 40 })).toBe(35);
    expect(pickupAmount("med", { ...full, health: 90 })).toBe(10);
    expect(pickupAmount("med", full)).toBe(0);
    expect(pickupAmount("med", { ...full, health: 120, maxHealth: 120 })).toBe(0);
    expect(pickupAmount("charge", { ...full, charges: 2 })).toBe(1);
    expect(pickupAmount("charge", full)).toBe(0);
    expect(FEED.ammo(30)).toBe("+30 ROUNDS");
    expect(FEED.med(35)).toBe("+35 HEALTH");
    expect(FEED.charge(1)).toBe("+1 BREAKER CHARGE");
  });

  it("are taken by walking within 1.2 m: rounds, health and a charge, each with a feed line and an event", () => {
    const { G, sent, feed } = fakeGame();
    const a = make(G);
    G.player.health = 50;
    a.setCharges(1);
    a.spawnPickup("ammo", { x: 5, z: 0 });
    a.spawnPickup("med", { x: 10, z: 0 });
    a.spawnPickup("charge", { x: 15, z: 0 });
    G.player.pos.x = 3.7; // 1.3 m short of the tin
    a.update(0.016);
    expect(a.pickups).toHaveLength(3);
    G.player.pos.x = 3.9;
    a.update(0.016);
    expect(G.weapon.reserve).toBe(180);
    G.player.pos.x = 10;
    a.update(0.016);
    expect(G.player.health).toBe(85);
    G.player.pos.x = 15;
    a.update(0.016);
    expect(a.charges()).toBe(2);
    expect(a.pickups).toHaveLength(0);
    expect(named(sent, "pickup:taken")).toEqual([
      { kind: "ammo", amount: 30 },
      { kind: "med", amount: 35 },
      { kind: "charge", amount: 1 },
    ]);
    expect(feed).toEqual(["<b>+30</b> ROUNDS", "<b>+35</b> HEALTH", "<b>+1</b> BREAKER CHARGE"]);
  });

  it("stay on the ground at full health, a full reserve and three charges, until there's room", () => {
    const { G, sent } = fakeGame();
    const a = make(G);
    G.weapon.reserve = TUNE.pickup.reserveCap;
    a.setCharges(3);
    for (const kind of ["ammo", "med", "charge"] as PickupKind[]) a.spawnPickup(kind, { x: 0.5, z: 0 });
    a.update(0.016);
    expect(a.pickups).toHaveLength(3);
    expect(named(sent, "pickup:taken")).toEqual([]);
    G.player.health = 99;
    G.weapon.reserve -= 1;
    a.setCharges(2);
    a.update(0.016);
    expect(a.pickups).toHaveLength(0);
    expect(named(sent, "pickup:taken")).toEqual([
      { kind: "ammo", amount: 1 },
      { kind: "med", amount: 1 },
      { kind: "charge", amount: 1 },
    ]);
  });

  it("drop from dead machines at the spec's odds", () => {
    expect(dropFor("hound", 0)).toBe("ammo");
    expect(dropFor("hound", 0.349)).toBe("ammo");
    expect(dropFor("hound", 0.35)).toBeNull();
    expect(dropFor("gull", 0.119)).toBe("ammo");
    expect(dropFor("gull", 0.12)).toBe("med");
    expect(dropFor("gull", 0.199)).toBe("med");
    expect(dropFor("gull", 0.2)).toBeNull();
    expect(dropFor("assessor", 0)).toBeNull();
    const rnd = seeded(20261113);
    const n = 20000;
    const got = { hound: { ammo: 0, med: 0 }, gull: { ammo: 0, med: 0 } };
    for (let i = 0; i < n; i++)
      for (const type of ["hound", "gull"] as const) {
        const d = dropFor(type, rnd());
        if (d === "ammo" || d === "med") got[type][d]++;
      }
    expect(got.hound.ammo / n).toBeCloseTo(0.35, 1);
    expect(got.hound.med).toBe(0);
    expect(got.gull.ammo / n).toBeCloseTo(0.12, 1);
    expect(got.gull.med / n).toBeCloseTo(0.08, 1);
  });

  it("land under a dead machine, from the module's seeded rolls", () => {
    const rolls = [0.1, 0.5, 0.9, 0.15, 0.5, 0.99];
    const { G, emit } = fakeGame();
    const a = make(G, { rng: () => rolls.shift() ?? 0.99 });
    emit("enemy:killed", { type: "gull", pos: { x: 4, y: 6, z: 2 } }); // 0.10: ammo
    emit("enemy:killed", { type: "hound", pos: { x: 8, y: 0, z: 2 } }); // 0.90: nothing (0.5 was the gull's bearing)
    emit("enemy:killed", { type: "gull", pos: { x: 12, y: 5, z: 2 } }); // 0.15: med
    emit("enemy:killed", { type: "gull", pos: { x: 16, y: 5, z: 2 } }); // 0.99: nothing
    expect(a.pickups.map((p) => p.kind)).toEqual(["ammo", "med"]);
    expect(a.pickups[0]).toMatchObject({ x: 4, y: 6, z: 2, locker: null });
    for (let i = 0; i < 120; i++) a.update(1 / 60); // it falls to the ground
    expect(a.pickups[0].y).toBe(0);
    expect(a.pickups[1].y).toBe(0);
  });

  it("don't drop into the water or onto a roof", () => {
    const { G, emit } = fakeGame();
    G.physics.nav.isWalkable = () => false;
    const a = make(G, { rng: () => 0 });
    emit("enemy:killed", { type: "hound", pos: { x: 8, y: 0, z: 2 } });
    expect(a.pickups).toHaveLength(0);
    G.physics.nav.isWalkable = () => true;
    G.physics.groundHeight = () => 2.6;
    emit("enemy:killed", { type: "gull", pos: { x: 8, y: 6, z: 2 } });
    expect(a.pickups).toHaveLength(0);
  });
});

describe("supply lockers", () => {
  it("stand on a table of at least 12 distinct spots over the yard, the shed and the quay", () => {
    expect(LOCKER_SPOTS.length).toBeGreaterThanOrEqual(12);
    expect(new Set(LOCKER_SPOTS.map((s) => s.id)).size).toBe(LOCKER_SPOTS.length);
    for (const zone of ["yard", "shed", "quay"]) expect(LOCKER_SPOTS.some((s) => s.zone === zone)).toBe(true);
    for (const a of LOCKER_SPOTS) for (const b of LOCKER_SPOTS) if (a !== b) expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeGreaterThanOrEqual(6);
    for (const s of LOCKER_SPOTS) expect(Math.abs(Math.sin(2 * s.yaw))).toBeLessThan(0.01); // quarter turns: the collider is exact
  });

  it("are dealt the same for a seed, all on different spots, spread over the zones", () => {
    const a = planLockers(42, 6);
    expect(planLockers(42, 6)).toEqual(a);
    expect(a).toHaveLength(6);
    expect(new Set(a.map((l) => l.spot.id)).size).toBe(6);
    for (const zone of ["yard", "shed", "quay"]) expect(a.filter((l) => l.spot.zone === zone)).toHaveLength(2);
    expect(a.map((l) => l.kind).sort()).toEqual(["ammo", "ammo", "ammo", "charge", "med", "med"]);
    const different = [1, 2, 3, 4, 5].some((seed) => JSON.stringify(planLockers(seed, 6).map((l) => l.spot.id)) !== JSON.stringify(a.map((l) => l.spot.id)));
    expect(different).toBe(true);
    for (let seed = 0; seed < 200; seed++) expect(new Set(planLockers(seed, 6).map((l) => l.spot.id)).size).toBe(6);
    expect(planLockers(7, 99)).toHaveLength(LOCKER_SPOTS.length);
    expect(planLockers(7, 0)).toEqual([]);
  });

  it("are placed by the module, each holding one pickup, and replaced by the next placing", () => {
    const { G } = fakeGame();
    const a = make(G);
    a.placeLockers(42, 6);
    expect(a.lockers).toHaveLength(6);
    expect(a.lockers.map((l) => l.id)).toEqual(planLockers(42, 6).map((l) => l.spot.id));
    expect(a.pickups.filter((p) => p.locker !== null)).toHaveLength(6);
    a.placeLockers(43, 4);
    expect(a.lockers).toHaveLength(4);
    expect(a.pickups).toHaveLength(4);
    // Walking up to one takes what's on its shelf and leaves the locker standing, empty.
    const l = a.lockers.find((x) => x.kind === "ammo")!;
    G.player.pos.x = l.x + Math.sin(l.yaw) * 0.7;
    G.player.pos.z = l.z + Math.cos(l.yaw) * 0.7;
    a.update(0.016);
    expect(G.weapon.reserve).toBe(180);
    expect(a.lockers.find((x) => x.id === l.id)!.taken).toBe(true);
    expect(a.pickups).toHaveLength(3);
  });
});

describe("a run", () => {
  it("starts with 2 charges and 6 lockers while there's no campaign, and leaves both to it when there is", () => {
    const solo = fakeGame();
    const a = make(solo.G);
    solo.emit("run:start", {});
    expect(a.charges()).toBe(2);
    expect(a.lockers).toHaveLength(6);

    const run = fakeGame({ campaign: {} });
    const b = make(run.G);
    run.emit("run:start", {});
    expect(b.charges()).toBe(0);
    expect(b.lockers).toHaveLength(0);
  });

  it("clear() removes every pickup, locker, flight and hold, and so do the run's start and end", () => {
    const { G, emit } = fakeGame();
    const a = make(G);
    const fill = () => {
      emit("run:start", {});
      a.spawnPickup("ammo", { x: 30, z: 30 });
      const hound = machine("hound", { x: 1, y: 0, z: 0 });
      G.enemies.list = [hound];
      a.detonate({ x: 0, y: 0.5, z: 0 });
      a.throwCharge();
      expect([a.pickups.length, a.lockers.length, a.flights, a.heldFor(hound) > 0]).toEqual([7, 6, 1, true]);
      return hound;
    };
    let hound = fill();
    a.clear();
    expect([a.pickups.length, a.lockers.length, a.flights, a.heldFor(hound)]).toEqual([0, 0, 0, 0]);
    expect(hound.passive).toBe(false);
    for (const state of ["dead", "complete", "title"]) {
      hound = fill();
      emit("game:state", { state });
      expect([a.pickups.length, a.lockers.length, a.flights, a.heldFor(hound)]).toEqual([0, 0, 0, 0]);
    }
    fill();
    emit("run:start", {});
    expect([a.pickups.length, a.lockers.length, a.flights]).toEqual([6, 6, 0]);
  });

  it("gives a run already under way its kit when it attaches late", () => {
    const { G } = fakeGame();
    const a = createArsenal(G, quiet); // the game is already "playing"
    expect(a.charges()).toBe(2);
    expect(a.lockers).toHaveLength(6);
  });

  it("does nothing while the game isn't being played", () => {
    const { G, keys } = fakeGame();
    const a = make(G);
    a.setCharges(2);
    G.game.state = "paused";
    keys.add("charge");
    keys.add("melee");
    a.update(0.016);
    expect(a.charges()).toBe(2);
    expect(a.throwCharge()).toBe(false);
    expect(a.swing()).toBe(false);
  });
});
