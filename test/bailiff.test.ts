// @vitest-environment happy-dom
// The Bailiff, the hunter (src/economy/bailiff): how its stagger meter grows, when it grabs and how long before it
// can again, where it walks when it has lost the player, what a breaker charge does to it, what it says and how
// often, and what G.bailiff reports. The three.js body and the HUD chip are stand-ins here (types.ts is the seam);
// the rules in time, the shot hook and the event wiring are the real thing.
import { describe, expect, it, vi } from "vitest";
import type { CampaignEvents } from "../src/economy/campaign/types";
import { hooks } from "../src/economy/hooks";
import { SPAWN, createBailiffs } from "../src/economy/bailiff";
import { bearing, createChip } from "../src/economy/bailiff/chip";
import { GRAB_REPEAT_MS, LINES, createVoice, released } from "../src/economy/bailiff/copy";
import { TUNE, inBlast, lostTarget, meterGain, staggerSeconds, staggerThreshold } from "../src/economy/bailiff/rules";
import type { Body, Pose, V3, World } from "../src/economy/bailiff/types";
import { createUnit } from "../src/economy/bailiff/unit";
import { CHANNEL_LABEL } from "../src/economy/story/radio";

// ---- stand-ins ----

/** A body whose ray hits whatever `aim` says: "lens", "body", or null for a miss. */
function fakeBody() {
  const body: Body & { aim: "lens" | "body" | null; poses: Pose[]; last: Pose | null } = {
    aim: null,
    poses: [],
    last: null,
    update(_dt, p) {
      body.last = { ...p };
      body.poses.push(body.last);
    },
    raycast(_o: V3, _d: V3, max: number) {
      if (!body.aim || max < 5) return null;
      return { dist: 5, point: { x: 0, y: 1.8, z: 0 }, normal: { x: 0, y: 0, z: 1 }, lens: body.aim === "lens" };
    },
    lens: (o) => Object.assign(o, { x: body.last?.x ?? 0, y: 2.4, z: body.last?.z ?? 0 }),
    dispose: vi.fn(),
  };
  return body;
}

/** An open floor with a player on it. `wall` hides the player from the lens; `blocked` cells can't be walked. */
function fakeWorld(o: { player?: { x: number; z: number } } = {}) {
  const w = {
    p: { pos: { x: o.player?.x ?? 0, y: 0, z: o.player?.z ?? 20 }, alive: true, health: 100 },
    wall: false,
    emitted: [] as { name: string; e: any }[],
    said: [] as string[],
    shoves: [] as { dx: number; dz: number; metres: number; seconds: number }[],
    plans: 0,
    relays: [
      { id: "a", x: 30, z: 0, live: true },
      { id: "b", x: -6, z: 0, live: true },
    ],
    boatAt: { x: 40, z: 40 },
    of: <K extends keyof CampaignEvents>(name: K) => w.emitted.filter((x) => x.name === name).map((x) => x.e as CampaignEvents[K]),
  };
  const world: World = {
    player: () => w.p,
    los: () => !w.wall,
    walkable: () => true,
    path: (_from, to) => (w.plans++, [{ x: to.x, z: to.z }]),
    ground: () => 0,
    uplinks: () => w.relays,
    boat: () => w.boatAt,
    hurt: (amount) => void (w.p.health -= amount),
    shove: (dx, dz, metres, seconds) => void w.shoves.push({ dx, dz, metres, seconds }),
    sfx: () => {},
    emit: (name, e) => void w.emitted.push({ name, e }),
    say: (id) => void w.said.push(id),
    spark: () => {},
    vec: (p) => ({ ...p }),
  };
  return { w, world };
}

function unitAt(at = { x: 0, z: 0 }, o: Parameters<typeof fakeWorld>[0] & { delay?: number } = {}) {
  const { w, world } = fakeWorld(o);
  const body = fakeBody();
  const unit = createUnit({ id: 7, at, delay: o.delay, world, body });
  /** Runs `seconds` of game time in 60 Hz frames. */
  const run = (seconds: number) => {
    for (let i = 0, n = Math.round(seconds * 60); i < n; i++) unit.update(1 / 60);
  };
  return { w, world, body, unit, run };
}

/** A game context with an event bus, a HUD radio, a player, open physics and three relays. */
function fakeGame(o: { params?: Record<string, string> } = {}) {
  const handlers = new Map<string, Set<(e: any) => void>>();
  const radio: string[] = [];
  const G: any = {
    params: o.params ?? {},
    events: {
      on(name: string, fn: (e: any) => void) {
        if (!handlers.has(name)) handlers.set(name, new Set());
        handlers.get(name)!.add(fn);
        return () => handlers.get(name)!.delete(fn);
      },
      emit(name: string, e?: unknown) {
        for (const fn of [...(handlers.get(name) ?? [])]) fn(e);
      },
    },
    hud: { radio: (t: string) => (radio.push(t), G.events.emit("radio:line", { text: t })) },
    game: { state: "playing", run: { relays: [{ id: "relay_a", o: { pos: { x: 1.5, z: 7.5 } }, cut: false }] } },
    level: { extraction: { pos: { x: 29, y: 0, z: 20 } } },
    player: { pos: { x: 0, y: 0, z: 30 }, yaw: 0, alive: true, health: 100, damage(n: number) { this.health -= n; }, addShake: vi.fn() },
    physics: {
      lineOfSight: () => true,
      groundHeight: () => 0,
      nav: { isWalkable: () => true, findPath: (_a: any, b: any) => [{ x: b.x, z: b.z }] },
    },
    ext: { callsign: "K. OSEI" },
  };
  const bodies: ReturnType<typeof fakeBody>[] = [];
  const chip = { set: vi.fn(), dispose: vi.fn() };
  let clock = 0;
  const b = createBailiffs(G, { build: () => (bodies.push(fakeBody()), bodies[bodies.length - 1]), chip, now: () => clock });
  const events: { name: string; e: any }[] = [];
  for (const name of ["bailiff:spawned", "bailiff:staggered", "bailiff:recovered", "bailiff:grab", "bailiff:near"]) G.events.on(name, (e: any) => events.push({ name, e }));
  const run = (seconds: number) => {
    for (let i = 0, n = Math.round(seconds * 60); i < n; i++) ((clock += 1000 / 60), b.update(1 / 60));
  };
  return { G, b, bodies, chip, radio, events, run, tick: (ms: number) => void (clock += ms) };
}

// ---- the rules ----

describe("the stagger meter's numbers", () => {
  it("takes 450 first, 200 more each time, and never more than 1,050", () => {
    expect([0, 1, 2, 3, 4, 9].map(staggerThreshold)).toEqual([450, 650, 850, 1050, 1050, 1050]);
  });

  it("lasts 9 s first, a second less each time, and never less than 5", () => {
    expect([0, 1, 2, 3, 4, 5, 9].map(staggerSeconds)).toEqual([9, 8, 7, 6, 5, 5, 5]);
  });

  it("counts a lens hit double, whoever delivers it", () => {
    expect(meterGain(26, false)).toBe(26);
    expect(meterGain(40, true)).toBe(80); // the rifle butt on the lens
    // combat.playerShot hands a weak point 2.2× the round: 26 → 57.2 arrives, and 52 goes on the meter.
    expect(meterGain(26 * TUNE.weakMult, true, true)).toBeCloseTo(52, 9);
    expect(meterGain(-5, false)).toBe(0);
    expect(meterGain(Number.NaN, true)).toBe(0);
  });
});

describe("the lost-sight routine", () => {
  const uplinks = [
    { id: "a", x: 30, z: 0, live: true },
    { id: "b", x: -6, z: 0, live: true },
    { id: "c", x: 2, z: 0, live: false },
  ];
  const base = { from: { x: 0, z: 0 }, lastSeen: { x: 5, z: 5 }, checkedLastSeen: false, uplinks, checked: new Set<string>(), boat: { x: 40, z: 40 } };

  it("goes to where it last saw them first", () => {
    expect(lostTarget(base)).toEqual({ kind: "lastSeen", x: 5, z: 5 });
  });

  it("then to the nearest uplink still live, skipping the cut ones and the ones it has checked", () => {
    expect(lostTarget({ ...base, checkedLastSeen: true })).toEqual({ kind: "uplink", id: "b", x: -6, z: 0 });
    expect(lostTarget({ ...base, checkedLastSeen: true, checked: new Set(["b"]) })).toEqual({ kind: "uplink", id: "a", x: 30, z: 0 });
    expect(lostTarget({ ...base, lastSeen: null })).toMatchObject({ kind: "uplink", id: "b" }); // it never saw them
  });

  it("then to the boat, and holds where it is with nowhere to go", () => {
    expect(lostTarget({ ...base, checkedLastSeen: true, checked: new Set(["a", "b"]) })).toEqual({ kind: "boat", x: 40, z: 40 });
    expect(lostTarget({ ...base, checkedLastSeen: true, uplinks: [], boat: null })).toEqual({ kind: "hold", x: 0, z: 0 });
  });

  it("is walked in that order by a Bailiff that can't see the player", () => {
    const { w, unit, run } = unitAt({ x: 0, z: 0 }, { player: { x: 0, z: 12 } });
    run(TUNE.rise + 0.5);
    expect(unit.target).toMatchObject({ kind: "player", x: 0, z: 12 });
    // The player slips behind a wall and runs. For 6 s it still follows them.
    w.wall = true;
    w.p.pos.x = 60;
    run(TUNE.lostAfter - 0.5);
    expect(unit.target).toMatchObject({ kind: "player" });
    expect(w.said).not.toContain("lost");
    run(1);
    expect(unit.target).toMatchObject({ kind: "lastSeen", x: 0, z: 12 });
    expect(w.said.filter((s) => s === "lost")).toHaveLength(1);
    // It reaches the spot, then works through the live uplinks nearest first, then the boat, where it waits.
    const seen: string[] = [];
    for (let i = 0; i < 90 * 60; i++) {
      unit.update(1 / 60);
      const k = unit.target!.kind + (unit.target!.kind === "uplink" ? ":" + (unit.target as any).id : "");
      if (seen[seen.length - 1] !== k) seen.push(k);
    }
    expect(seen).toEqual(["lastSeen", "uplink:b", "uplink:a", "boat"]);
    expect(Math.hypot(unit.handle.pos.x - 40, unit.handle.pos.z - 40)).toBeLessThan(TUNE.arrive);
    // Sight of them again and it is back on the player at once.
    w.wall = false;
    run(0.3);
    expect(unit.target).toMatchObject({ kind: "player", x: 60 });
  });
});

// ---- one Bailiff ----

describe("rising and walking", () => {
  it("rises for 2 s with its lens dark at first, then walks at 2.6 m/s and plans twice a second", () => {
    const { w, body, unit, run } = unitAt({ x: 0, z: 0 }, { player: { x: 0, z: 40 } });
    run(0.5);
    expect(unit.handle.state).toBe("rising");
    expect(body.last).toMatchObject({ state: "rising", lens: "dark", speed: 0 });
    expect(body.last!.up).toBeGreaterThan(0);
    expect(body.last!.up).toBeLessThan(0.3);
    expect(w.of("bailiff:spawned")).toEqual([{ id: 7, pos: { x: 0, y: 0, z: 0 } }]);
    run(TUNE.rise - 0.5 + 0.02);
    expect(unit.handle.state).toBe("walking");
    expect(unit.handle.pos.z).toBe(0);
    const plans = w.plans;
    run(4);
    // 4 s at 2.6 m/s, less the moment it takes to get up to pace.
    expect(unit.handle.pos.z).toBeGreaterThan(2.6 * 4 - 0.8);
    expect(unit.handle.pos.z).toBeLessThanOrEqual(2.6 * 4 + 0.01);
    expect(body.last).toMatchObject({ lens: "red", up: 1, kneel: 0 });
    expect(body.last!.speed).toBeCloseTo(TUNE.speed, 5);
    expect(w.plans - plans).toBe(8);
  });

  it("waits out its delay before it appears", () => {
    const { w, body, unit, run } = unitAt({ x: 0, z: 0 }, { delay: 3 });
    run(2.9);
    expect(unit.appeared).toBe(false);
    expect(unit.handle.standing).toBe(false);
    expect(body.poses).toHaveLength(0);
    expect(w.of("bailiff:spawned")).toHaveLength(0);
    expect(unit.raycast({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, 100)).toBeNull();
    run(0.2);
    expect(unit.appeared).toBe(true);
    expect(unit.handle.standing).toBe(true);
    expect(w.of("bailiff:spawned")).toHaveLength(1);
  });

  it("stays off cells it can't walk", () => {
    const { world, unit, run } = unitAt({ x: 0, z: 0 }, { player: { x: 0, z: 30 } });
    world.walkable = (_x, z) => z < 5; // a wall across its way, and no path round it
    run(TUNE.rise + 6);
    expect(unit.handle.pos.z).toBeLessThan(5);
    expect(unit.handle.pos.z).toBeGreaterThan(4.5);
  });

  it("tells the score and the HUD it is near, twice a second inside 30 m", () => {
    const { w, unit, run } = unitAt({ x: 0, z: 0 }, { player: { x: 0, z: 100 } });
    run(TUNE.rise + 3);
    expect(w.of("bailiff:near")).toHaveLength(0);
    w.p.pos.z = unit.handle.pos.z + 28;
    w.emitted.length = 0;
    run(3);
    const near = w.of("bailiff:near");
    expect(near.length).toBeGreaterThanOrEqual(5);
    expect(near.length).toBeLessThanOrEqual(7);
    expect(near.every((n) => n.id === 7 && n.standing && n.dist <= 30)).toBe(true);
    // Its first-contact line, the first time it is within 12 m.
    expect(w.said).not.toContain("near");
    w.p.pos.z = unit.handle.pos.z + 11;
    run(0.1);
    w.p.pos.z = unit.handle.pos.z + 40;
    run(0.1);
    w.p.pos.z = unit.handle.pos.z + 11;
    run(0.1);
    expect(w.said.filter((s) => s === "near")).toHaveLength(1);
  });
});

describe("the stagger", () => {
  it("fills from hits, drops it at 450 for 9 s, then stands it up again", () => {
    const { w, body, unit, run } = unitAt({ x: 0, z: 0 }, { player: { x: 0, z: 60 } });
    run(TUNE.rise + 0.5);
    body.aim = "body";
    const shot = () => unit.raycast({ x: 0, y: 1.6, z: 9 }, { x: 0, y: 0, z: -1 }, 100)!;
    const h = shot();
    expect(h).toMatchObject({ dist: 5, part: "body", enemy: { type: "bailiff", alive: true } });
    for (let i = 0; i < 17; i++) expect(shot().enemy.damage(26, undefined, undefined, "body")).toBe(false); // it never dies
    expect(unit.meter).toBe(442);
    expect(unit.handle.state).toBe("walking");
    expect(unit.threshold).toBe(450);
    shot().enemy.damage(26);
    expect(unit.handle.state).toBe("staggered");
    expect(unit.handle.standing).toBe(false);
    expect(unit.meter).toBe(0);
    expect(w.of("bailiff:staggered")).toEqual([{ id: 7, seconds: 9, by: "damage" }]);
    expect(w.said).toContain("staggered");
    // Down: its lens is dark, it doesn't move, and shots add nothing.
    const z = unit.handle.pos.z;
    run(4);
    shot().enemy.damage(500);
    expect(unit.meter).toBe(0);
    expect(body.last).toMatchObject({ state: "staggered", lens: "dark", kneel: 1, speed: 0 });
    expect(unit.handle.pos.z).toBe(z);
    expect(unit.down).toBeCloseTo(5, 1);
    run(4.9);
    expect(unit.handle.state).toBe("staggered");
    expect(w.of("bailiff:recovered")).toHaveLength(0);
    run(0.2);
    expect(unit.handle.state).toBe("rising");
    expect(unit.handle.standing).toBe(true);
    expect(w.of("bailiff:recovered")).toEqual([{ id: 7 }]);
    expect(w.said).toContain("recovered");
    run(TUNE.stand + 0.1);
    expect(unit.handle.state).toBe("walking");
    expect(unit.threshold).toBe(650);
  });

  it("takes a lens hit as double", () => {
    const { body, unit, run } = unitAt({ x: 0, z: 0 }, { player: { x: 0, z: 60 } });
    run(TUNE.rise + 0.5);
    body.aim = "lens";
    const h = unit.raycast({ x: 0, y: 1.6, z: 9 }, { x: 0, y: 0, z: -1 }, 100)!;
    expect(h.part).toBe("weak");
    h.enemy.damage(26 * TUNE.weakMult, undefined, undefined, "weak"); // as combat.playerShot calls it
    expect(unit.meter).toBeCloseTo(52, 9);
    unit.hit(40, true); // as the arsenal's rifle butt would
    expect(unit.meter).toBeCloseTo(132, 9);
    unit.hit(40);
    expect(unit.meter).toBeCloseTo(172, 9);
  });

  it("gets harder to drop and quicker to stand, to 1,050 and 5 s", () => {
    const { w, unit, run } = unitAt({ x: 0, z: 0 }, { player: { x: 0, z: 500 } });
    run(TUNE.rise + 0.1);
    const seconds: number[] = [];
    const needed: number[] = [];
    for (let i = 0; i < 6; i++) {
      needed.push(unit.threshold);
      unit.hit(unit.threshold - 1);
      expect(unit.handle.state).not.toBe("staggered");
      unit.hit(1);
      expect(unit.handle.state).toBe("staggered");
      seconds.push(w.of("bailiff:staggered").at(-1)!.seconds);
      run(seconds[i] + TUNE.stand + 0.2);
      expect(unit.handle.state).toBe("walking");
    }
    expect(needed).toEqual([450, 650, 850, 1050, 1050, 1050]);
    expect(seconds).toEqual([9, 8, 7, 6, 5, 5]);
  });

  it("drops at once when the script says so, for as long as it says", () => {
    const { w, unit, run } = unitAt();
    run(TUNE.rise + 0.1);
    unit.handle.stagger(3);
    expect(unit.handle.state).toBe("staggered");
    expect(w.of("bailiff:staggered")).toEqual([{ id: 7, seconds: 3, by: "script" }]);
    run(2.9);
    expect(unit.handle.state).toBe("staggered");
    run(0.2);
    expect(unit.handle.state).toBe("rising");
    // With no length given it takes the next one on the schedule: the second stagger, 8 s.
    run(TUNE.stand + 0.1);
    unit.handle.stagger();
    expect(w.of("bailiff:staggered").at(-1)).toEqual({ id: 7, seconds: 8, by: "script" });
  });
});

describe("the grab", () => {
  it("winds up for 0.6 s inside 2.2 m, takes 55 and throws the player 4 m, then can't grab for 2.5 s", () => {
    const { w, body, unit, run } = unitAt({ x: 0, z: 0 }, { player: { x: 0, z: 2.3 } });
    run(TUNE.rise);
    expect(unit.handle.state).not.toBe("windup"); // 2.3 m: out of reach until it steps in
    let frames = 0;
    while (unit.handle.state !== "windup" && frames++ < 120) unit.update(1 / 60);
    expect(unit.handle.state).toBe("windup");
    expect(Math.hypot(w.p.pos.x - unit.handle.pos.x, w.p.pos.z - unit.handle.pos.z)).toBeLessThanOrEqual(TUNE.grab.range);
    expect(w.said).toContain("grab");
    run(0.5);
    expect(unit.handle.state).toBe("windup");
    expect(w.p.health).toBe(100);
    expect(body.last!.raise).toBe(1);
    expect(body.last!.flare).toBeGreaterThan(0.7);
    run(0.12);
    expect(unit.handle.state).toBe("recovering");
    expect(w.p.health).toBe(45);
    expect(w.of("bailiff:grab")).toEqual([{ id: 7, damage: 55 }]);
    expect(w.shoves).toHaveLength(1);
    expect(w.shoves[0]).toMatchObject({ metres: 4 });
    expect(w.shoves[0].dz).toBeCloseTo(1, 5); // straight away from it
    expect(w.shoves[0].dx).toBeCloseTo(0, 5);
    // The player doesn't move (a wall behind them): it can't grab again until the 2.5 s are up.
    run(2.3);
    expect(unit.handle.state).toBe("recovering");
    expect(w.of("bailiff:grab")).toHaveLength(1);
    run(0.25);
    expect(["walking", "windup"]).toContain(unit.handle.state);
    run(0.7);
    expect(w.of("bailiff:grab")).toHaveLength(2);
    expect(w.p.health).toBe(-10);
  });

  it("closes on air if the player gets clear in the wind-up, and still pays the recovery", () => {
    const { w, unit, run } = unitAt({ x: 0, z: 0 }, { player: { x: 0, z: 2 } });
    run(TUNE.rise + 0.05);
    expect(unit.handle.state).toBe("windup");
    w.p.pos.z = 2 + 3.8 * 0.5; // half a second at a walk
    run(TUNE.grab.windup);
    expect(unit.handle.state).toBe("recovering");
    expect(w.p.health).toBe(100);
    expect(w.of("bailiff:grab")).toHaveLength(0);
    expect(w.shoves).toHaveLength(0);
  });

  it("doesn't reach through a wall or onto a double stack", () => {
    const a = unitAt({ x: 0, z: 0 }, { player: { x: 0, z: 1.5 } });
    a.w.wall = true;
    a.run(TUNE.rise + 2);
    expect(a.w.of("bailiff:grab")).toHaveLength(0);
    const b = unitAt({ x: 0, z: 0 }, { player: { x: 0, z: 1.5 } });
    b.w.p.pos.y = 5.2;
    b.run(TUNE.rise + 2);
    expect(b.w.of("bailiff:grab")).toHaveLength(0);
  });

  it("a stagger breaks the wind-up", () => {
    const { w, unit, run } = unitAt({ x: 0, z: 0 }, { player: { x: 0, z: 2 } });
    run(TUNE.rise + 0.3);
    expect(unit.handle.state).toBe("windup");
    unit.drop("charge");
    run(1);
    expect(w.p.health).toBe(100);
    expect(unit.handle.state).toBe("staggered");
  });
});

// ---- its lines ----

describe("its lines", () => {
  it("are the spec's, word for word", () => {
    expect(released("K. OSEI")).toBe("Breacher K. OSEI. You are in arrears. An officer has been dispatched to collect.");
    expect(released(null)).toBe("Breacher. You are in arrears. An officer has been dispatched to collect.");
    expect(LINES).toEqual({
      near: "Please remain where you are.",
      grab: "You are being repossessed.",
      staggered: "Service has been interrupted.",
      recovered: "Service of the writ will now resume.",
      lost: "Your location has been noted. It is in the schedule.",
    });
    expect(CHANNEL_LABEL.bailiff).toBe("Bailiff");
  });

  it("play at most once a run, except the grab's, which may come again after 20 s", () => {
    let t = 0;
    const v = createVoice(() => t);
    expect(v.ask("near")).toBe(LINES.near);
    expect(v.ask("near")).toBeNull();
    expect(v.ask("staggered")).toBe(LINES.staggered);
    expect(v.ask("staggered")).toBeNull();
    expect(v.ask("grab")).toBe(LINES.grab);
    t = GRAB_REPEAT_MS - 1;
    expect(v.ask("grab")).toBeNull();
    t = GRAB_REPEAT_MS + 1;
    expect(v.ask("grab")).toBe(LINES.grab);
    t += 60_000;
    expect(v.ask("near")).toBeNull();
    expect(v.owns(LINES.near)).toBe(true);
    expect(v.owns("Three uplinks, yard, shed, quay.")).toBe(false);
    v.reset(); // a new run
    expect(v.owns(LINES.near)).toBe(false);
    expect(v.ask("near")).toBe(LINES.near);
  });
});

// ---- G.bailiff ----

describe("G.bailiff", () => {
  it("stands them up, lists them, and knows the nearest and whether any is standing", () => {
    const { G, b, events, run } = fakeGame();
    expect(b.list).toHaveLength(0);
    expect(b.anyStanding()).toBe(false);
    expect(b.nearest()).toBeNull();
    const far = b.spawn({ at: { x: 0, z: -40 } });
    const near = b.spawn({ at: { x: 0, z: 10 } });
    const late = b.spawn({ at: { x: 0, z: 29 }, delay: 30 });
    expect(b.list).toEqual([far, near, late]);
    expect(new Set(b.list.map((h) => h.id)).size).toBe(3);
    run(0.1);
    expect(events.filter((e) => e.name === "bailiff:spawned").map((e) => e.e.id)).toEqual([far.id, near.id]);
    expect(b.anyStanding()).toBe(true);
    // The nearest of those in the world: the one waiting out its delay isn't.
    expect(b.nearest()).toMatchObject({ handle: near });
    expect(b.nearest()!.dist).toBeCloseTo(20, 5);
    near.stagger();
    expect(b.anyStanding()).toBe(true); // the far one still stands
    far.stagger();
    expect(b.anyStanding()).toBe(false);
    run(9.1);
    expect(b.anyStanding()).toBe(true);
    G.player.pos.z = -45;
    expect(b.nearest()!.handle).toBe(far);
    far.remove();
    expect(b.list).toEqual([near, late]);
    expect(b.nearest()!.handle).toBe(near);
  });

  it("drops at once to a breaker charge inside its radius, and not outside it", () => {
    const { G, b, events, run } = fakeGame();
    const h = b.spawn({ at: { x: 0, z: 0 } });
    run(TUNE.rise + 0.1);
    expect(inBlast({ x: 0, z: 0 }, { x: 3.4, z: 0 }, 3.5)).toBe(true);
    expect(inBlast({ x: 0, z: 0 }, { x: 3.6, z: 0 }, 3.5)).toBe(false);
    expect(inBlast({ x: 0, z: 0 }, { x: 0, z: 0 }, Number.NaN)).toBe(false);
    G.events.emit("emp:detonated", { pos: { x: h.pos.x + 3.6, y: 0, z: h.pos.z }, radius: 3.5 });
    expect(h.state).not.toBe("staggered");
    G.events.emit("emp:detonated", { pos: { x: h.pos.x + 3.4, y: 2, z: h.pos.z }, radius: 3.5 });
    expect(h.state).toBe("staggered");
    expect(h.standing).toBe(false);
    expect(events.filter((e) => e.name === "bailiff:staggered").map((e) => e.e)).toEqual([{ id: h.id, seconds: 9, by: "charge" }]);
  });

  it("takes the player's shots through the shared hook", () => {
    const { G, b, bodies, run } = fakeGame();
    const h = b.spawn({ at: { x: 0, z: 0 } });
    run(TUNE.rise + 0.1);
    expect(hooks(G).shotTargets).toBe(1);
    expect(G.ext.raycast({ x: 0, y: 1.6, z: 9 }, { x: 0, y: 0, z: -1 }, 100)).toBeNull();
    bodies[0].aim = "lens";
    const hit = G.ext.raycast({ x: 0, y: 1.6, z: 9 }, { x: 0, y: 0, z: -1 }, 100);
    expect(hit).toMatchObject({ dist: 5, part: "weak", enemy: { type: "bailiff" } });
    expect(G.ext.raycast({ x: 0, y: 1.6, z: 9 }, { x: 0, y: 0, z: -1 }, 4)).toBeNull(); // a wall is nearer
    for (let i = 0; i < 9; i++) hit.enemy.damage(26 * TUNE.weakMult, hit.point, null, "weak");
    expect(h.state).toBe("staggered"); // 9 lens hits × 52 = 468
  });

  it("speaks on the Harbormaster's channel, each line once a run, and clears on a new run", () => {
    const { G, b, bodies, chip, radio, run, tick } = fakeGame();
    const h = b.spawn({ at: { x: 0, z: 0 } });
    run(0.2);
    expect(radio).toEqual(["Breacher K. OSEI. You are in arrears. An officer has been dispatched to collect."]);
    run(TUNE.rise);
    h.stagger(1);
    run(0.1);
    h.stagger(1); // already down: nothing more to say
    run(1.5 + TUNE.stand);
    h.stagger(1);
    run(1.5 + TUNE.stand);
    expect(radio.filter((t) => t === LINES.staggered)).toHaveLength(1);
    expect(radio.filter((t) => t === LINES.recovered)).toHaveLength(1);
    expect(chip.set).toHaveBeenCalled();
    // A new run: they are gone, bodies and all, and the lines may play again.
    G.events.emit("run:start", { retries: 1 });
    expect(b.list).toHaveLength(0);
    expect(b.anyStanding()).toBe(false);
    expect(b.nearest()).toBeNull();
    expect(bodies[0].dispose).toHaveBeenCalledTimes(1);
    expect(chip.set).toHaveBeenLastCalledWith(null);
    expect(G.ext.raycast({ x: 0, y: 1.6, z: 9 }, { x: 0, y: 0, z: -1 }, 100)).toBeNull();
    tick(1000);
    b.spawn({ at: { x: 0, z: 0 } });
    run(0.2);
    expect(radio.filter((t) => t.startsWith("Breacher K. OSEI. You are in arrears."))).toHaveLength(2);
  });

  it("clears when the run ends at the boat or the title, and stops where it stands when the player dies", () => {
    const { G, b, bodies, run } = fakeGame();
    b.spawn({ at: { x: 0, z: 0 } });
    run(TUNE.rise + 1);
    const z = b.list[0].pos.z;
    expect(z).toBeGreaterThan(0);
    G.events.emit("player:dead", {});
    G.game.state = "dead";
    run(2);
    expect(b.list).toHaveLength(1); // it stands over them until the retry
    expect(b.list[0].pos.z).toBe(z);
    G.events.emit("game:state", { state: "title" });
    expect(b.list).toHaveLength(0);
    expect(bodies[0].dispose).toHaveBeenCalled();
    b.spawn({ at: { x: 0, z: 0 } });
    G.events.emit("extraction:reached", {});
    expect(b.list).toHaveLength(0);
  });

  it("?bailiff=1 stands one up in the shed at the first cut, and only the first", () => {
    const off = fakeGame();
    off.G.events.emit("objective:done", { id: "relay_a", index: 0, total: 3 });
    expect(off.b.list).toHaveLength(0);
    const { G, b } = fakeGame({ params: { bailiff: "1" } });
    G.physics.lineOfSight = () => false; // the player can't see into the shed
    G.events.emit("objective:done", { id: "relay_a", index: 0, total: 3 });
    expect(b.list).toHaveLength(1);
    expect({ x: b.list[0].pos.x, z: b.list[0].pos.z }).toEqual(SPAWN.shed);
    G.events.emit("objective:done", { id: "relay_b", index: 1, total: 3 });
    expect(b.list).toHaveLength(1);
    // A player who can see the shed floor gets the first alternate they can't see.
    const seen = fakeGame({ params: { bailiff: "1" } });
    seen.G.physics.lineOfSight = (_eye: V3, at: V3) => at.x === SPAWN.shed.x;
    seen.G.events.emit("objective:done", { id: "relay_b", index: 0, total: 3 });
    expect({ x: seen.b.list[0].pos.x, z: seen.b.list[0].pos.z }).toEqual(SPAWN.shedAlt[0]);
  });
});

describe("the HUD chip", () => {
  it("reads BAILIFF, the distance and a bearing, and hides with none near", () => {
    const host = document.createElement("div");
    const chip = createChip(host);
    const el = host.querySelector(".bf-chip") as HTMLElement;
    expect(el.classList.contains("on")).toBe(false);
    chip.set({ dist: 13.6, bearing: Math.PI / 2, sees: true, down: 0 });
    expect(el.classList.contains("on")).toBe(true);
    expect(el.querySelector(".bf-name")!.textContent).toBe("BAILIFF");
    expect(el.querySelector(".bf-dist")!.textContent).toBe("14 m");
    expect((el.querySelector(".bf-arrow") as HTMLElement).style.transform).toBe("rotate(90deg)");
    expect(el.classList.contains("sees")).toBe(true);
    chip.set({ dist: 4, bearing: 0, sees: true, down: 6.2 });
    expect(el.querySelector(".bf-tag")!.textContent).toBe("Down 7s");
    expect(el.classList.contains("down")).toBe(true);
    expect(el.classList.contains("sees")).toBe(false);
    chip.set(null);
    expect(el.classList.contains("on")).toBe(false);
    chip.dispose();
    expect(host.querySelector(".bf-chip")).toBeNull();
  });

  it("points the way in the game's frame (forward is −z at yaw 0)", () => {
    expect(bearing({ x: 0, z: 0 }, 0, { x: 0, z: -10 })).toBeCloseTo(0, 9); // ahead
    expect(bearing({ x: 0, z: 0 }, 0, { x: 10, z: 0 })).toBeCloseTo(Math.PI / 2, 9); // to the right
    expect(Math.abs(bearing({ x: 0, z: 0 }, 0, { x: 0, z: 10 }))).toBeCloseTo(Math.PI, 9); // behind
    expect(bearing({ x: 0, z: 0 }, Math.PI / 2, { x: -10, z: 0 })).toBeCloseTo(0, 9); // turned to face −x
  });
});
