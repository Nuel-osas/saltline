// @vitest-environment happy-dom
// The Assessor, Chapter 3's boss (src/economy/boss): who gets one, how many cores, how damage lands, when it calls
// for help, what it says and when the boat comes back. The three.js body, its bolts and the HUD bar are stand-ins
// here (types.ts is the seam); the fight's rules and the game hooks are the real thing.
import { describe, expect, it, vi } from "vitest";
import { VOICE_TTL, createBoss, type Parts } from "../src/economy/boss";
import { LINES, arrival } from "../src/economy/boss/copy";
import { createFight, type Fight, type FightDeps } from "../src/economy/boss/fight";
import { TUNE, assessorFor, coreCount, damageFor } from "../src/economy/boss/rules";
import type { Bar, Body, BodyHit, Bolts, CoreState, Drive, V3 } from "../src/economy/boss/types";
import type { TownReader } from "../src/economy/story/town";
import type { Economy } from "../src/economy/types";
import { FAILED, MISSING, ok, view } from "./story-fixtures";

// ---- stand-ins ----

/** A body whose ray hits whatever `aim` says: a core index, -1 for the body, null for a miss. */
function fakeBody(cores: number) {
  const states: CoreState[] = new Array(cores).fill("live");
  const drives: Drive[] = [];
  const body: Body & { aim: number | null; states: CoreState[]; drives: Drive[]; waves: number } = {
    aim: null,
    states,
    drives,
    waves: 0,
    pos: { x: TUNE.arrive.post.x, y: 0, z: TUNE.arrive.post.z },
    feet: 4,
    lamp: (o) => Object.assign(o, { x: 23.5, y: 6, z: 13 }),
    muzzle: (_i, o) => Object.assign(o, { x: 23.5, y: 8, z: 13 }),
    core: (i, o) => Object.assign(o, { x: 20 + i, y: 9.5, z: 14 }),
    foot: (i, o) => Object.assign(o, { x: i % 2 ? 28 : 19, y: 0, z: i < 2 ? 12 : 17 }),
    raycast(_o: V3, _d: V3, max: number): BodyHit | null {
      if (body.aim === null || max < 5) return null;
      const c = body.aim;
      return { dist: 5, point: { x: 20 + Math.max(0, c), y: 9.5, z: 14 }, normal: { x: 0, y: 0, z: -1 }, core: c };
    },
    setCore: (i, s) => void (states[i] = s),
    shockwave: () => void body.waves++,
    update(_dt, d) {
      drives.push(JSON.parse(JSON.stringify(d)));
      body.pos.x = d.at.x;
      body.pos.z = d.at.z;
    },
    dispose: vi.fn(),
  };
  return body;
}
const fakeBolts = (): Bolts & { fired: number } => {
  const b = { fired: 0, fire: () => void b.fired++, update: () => {}, clear: () => {}, dispose: vi.fn() };
  return b;
};
const fakeBar = (): Bar & { last: any; shown: number } => {
  const b = { last: null as any, shown: 0, show: (n: number) => void (b.shown = n), set: (s: any) => void (b.last = s), hide: vi.fn(), dispose: vi.fn() };
  return b;
};

/** A game context with an event bus, a HUD, a player and the drones' spawn. */
function fakeGame(o: { state?: string } = {}) {
  const handlers = new Map<string, Set<(e: any) => void>>();
  const radio: string[] = [];
  const G: any = {
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
    hud: {
      radio: (t: string) => void radio.push(t),
      warn: vi.fn(),
      message: vi.fn(),
      setObjective: vi.fn(),
      feed: vi.fn(),
    },
    game: { state: o.state ?? "playing" },
    player: {
      pos: { x: 12, y: 0, z: 8.5 },
      eye: { x: 12, y: 1.6, z: 8.5 },
      vel: { x: 0, y: 0, z: 0 },
      alive: true,
      onGround: true,
      damage: vi.fn(),
      addShake: vi.fn(),
    },
    enemies: { spawn: vi.fn(() => ({})), alert: vi.fn() },
    // Nothing in the way of its lamp unless a test says so... except that by default it can't see the player at all,
    // so the arrival and the damage tests aren't interrupted by volleys.
    physics: { raycast: () => null, lineOfSight: () => false },
    weapon: {
      reserve: 20,
      addAmmo(n: number) {
        this.reserve += n;
      },
    },
    ext: {},
  };
  return { G, radio };
}

function fight(cores = 6, o: { callsign?: string | null } = {}) {
  const { G } = fakeGame();
  const body = fakeBody(cores);
  const bolts = fakeBolts();
  const bar = fakeBar();
  const said: string[] = [];
  const deps: FightDeps = { G, body, bolts, bar, rng: () => 0.5, say: (t) => void said.push(t) };
  const f = createFight(deps, { cores, callsign: o.callsign ?? "GULLBAIT" });
  return { f, G, body, bolts, bar, said };
}
const run = (f: Fight, seconds: number, dt = 1 / 30) => {
  for (let t = 0; t < seconds; t += dt) f.update(dt);
};
const shoot = (f: Fight, body: ReturnType<typeof fakeBody>, aim: number, damage = 26) => {
  body.aim = aim;
  const hit = f.raycast({ x: 0, y: 1.6, z: 0 }, { x: 0, y: 0, z: 1 }, 300);
  // combat.playerShot: weak points take 2.2×.
  return hit ? hit.enemy.damage(damage * (hit.part === "weak" ? 2.2 : 1), hit.point) : null;
};
/** Shoots core `i` until it's out; returns the shots it took. */
const breakCore = (f: Fight, body: ReturnType<typeof fakeBody>, i: number) => {
  let n = 0;
  while (f.hp[i] > 0 && n < 100) (shoot(f, body, i), n++);
  return n;
};
/** Runs the walk in, up to the moment it plants itself and fights. */
const arrive = (f: Fight) => {
  for (let i = 0; i < 3000 && f.phase === "arriving"; i++) f.update(1 / 30);
  expect(f.phase).toBe("fighting");
};

// ---- the rules ----

describe("cores from the Harbormaster's strength", () => {
  it("is 3 + floor(strength / 20), from 3 to 8", () => {
    expect([0, 19, 20, 39, 40, 62, 79, 80, 99, 100].map(coreCount)).toEqual([3, 3, 4, 4, 5, 6, 6, 7, 7, 8]);
  });

  it("reads a bad strength as none, never as more cores", () => {
    expect([NaN, -40, Infinity, "80", null, undefined, {}].map(coreCount)).toEqual([3, 3, 3, 3, 3, 3, 3]);
    expect(coreCount(1000)).toBe(8);
  });
});

describe("who gets the Assessor", () => {
  it("builds one only on a good Chapter 3 read", () => {
    expect(assessorFor(ok(view(3, { strength: 62 })))).toEqual({ cores: 6, strength: 62 });
    expect(assessorFor(ok(view(3, { strength: 100 })))?.cores).toBe(8);
    expect(assessorFor(ok(view(3)))?.cores).toBe(3);
  });

  it("builds none in Chapters 1 and 2, on a chain without town(), on a failed read or with no read", () => {
    for (const r of [ok(view(1)), ok(view(2)), MISSING, FAILED, null, undefined]) expect(assessorFor(r)).toBeNull();
  });
});

describe("the damage model", () => {
  it("lets a core take a hit whole and the body almost none", () => {
    expect(damageFor("core", 57.2)).toBe(57.2);
    expect(damageFor("body", 26)).toBeCloseTo(26 * TUNE.bodyShare);
    expect(damageFor("body", 26)).toBeLessThan(2);
    expect(damageFor("core", -5)).toBe(0);
    expect(damageFor("core", NaN)).toBe(0);
  });

  it("puts a core out in six rifle hits on the weak point", () => {
    const { f, body } = fight();
    arrive(f);
    expect(breakCore(f, body, 0)).toBe(6);
    expect(f.hp[0]).toBe(0);
    expect(body.states[0]).toBe("dark");
  });

  it("reports a core hit as a weak point and its last hit as a kill, like a drone's", () => {
    const { f, body } = fight();
    arrive(f);
    body.aim = 2;
    const hit = f.raycast({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, 300)!;
    expect(hit.part).toBe("weak");
    expect(hit.enemy.type).toBe("relay core");
    expect(hit.enemy.damage(57.2, hit.point)).toBe(false);
    for (let i = 0; i < 4; i++) shoot(f, body, 2);
    expect(shoot(f, body, 2)).toBe(true);
    // A dark core is no longer a weak point: the shot lands on the body.
    expect(f.raycast({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, 300)!.part).toBe("body");
  });

  it("barely feels the body: a full reserve into it puts no core out", () => {
    const { f, body } = fight();
    arrive(f);
    const before = f.health;
    for (let i = 0; i < 180; i++) expect(shoot(f, body, -1)).toBe(false);
    expect(f.hp.every((h) => h > 0)).toBe(true);
    expect(before - f.health).toBeLessThan(0.15);
    // Even past what a core holds, the body alone never puts one out.
    for (let i = 0; i < 400; i++) shoot(f, body, -1);
    expect(f.hp.every((h) => h > 0)).toBe(true);
    expect(f.phase).toBe("fighting");
  });

  it("doesn't take shots that a nearer wall or drone stopped", () => {
    const { f, body } = fight();
    arrive(f);
    body.aim = 0;
    expect(f.raycast({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, 3)).toBeNull();
  });

  it("goes down when the last core goes dark, and only then", () => {
    const { f, body } = fight(3);
    arrive(f);
    breakCore(f, body, 0);
    breakCore(f, body, 1);
    expect(f.phase).toBe("fighting");
    breakCore(f, body, 2);
    expect(f.phase).toBe("dying");
    expect(f.raycast({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, 300)).toBeNull();
    run(f, TUNE.slump + 0.1);
    expect(f.phase).toBe("dead");
    expect(body.drives.at(-1)!.slump).toBe(1);
  });
});

describe("the boat", () => {
  it("is blocked from the moment it arrives until it's down and the boat is back in", () => {
    const { f, body } = fight(3);
    expect(f.blocked()).toBe(true);
    arrive(f);
    expect(f.blocked()).toBe(true);
    for (let i = 0; i < 3; i++) breakCore(f, body, i);
    expect(f.blocked()).toBe(true); // slumping
    run(f, TUNE.slump + 0.2);
    expect(f.blocked()).toBe(true); // the boat is coming in
    expect(f.boat).toBeGreaterThanOrEqual(0);
    run(f, TUNE.boatIn + 0.2);
    expect(f.boat).toBe(1);
    expect(f.blocked()).toBe(false);
  });
});

describe("Inspection Units", () => {
  it("calls a pair at each third of its health, once each", () => {
    const { f, G, body } = fight(6);
    arrive(f);
    breakCore(f, body, 0);
    expect(f.calls).toBe(0);
    breakCore(f, body, 1);
    expect(f.calls).toBe(1); // 4 of 6 left: two thirds
    expect(G.enemies.spawn.mock.calls.map((c: any[]) => c[0])).toEqual(["gull", "hound"]);
    breakCore(f, body, 2);
    expect(f.calls).toBe(1);
    breakCore(f, body, 3);
    expect(f.calls).toBe(2); // 2 of 6 left: one third
    breakCore(f, body, 4);
    breakCore(f, body, 5);
    expect(f.calls).toBe(2); // none at zero: it's down
    expect(G.enemies.spawn).toHaveBeenCalledTimes(4);
  });

  it("calls at the thirds with a core count that doesn't divide by three", () => {
    const { f, body } = fight(8);
    arrive(f);
    for (let i = 0; i < 8; i++) breakCore(f, body, i);
    expect(f.calls).toBe(2);
  });
});

describe("its lines", () => {
  it("says each of its beats once, verbatim from STORY.md", () => {
    const { f, body, said } = fight(3, { callsign: "GULLBAIT" });
    expect(said).toEqual([
      "Breacher GULLBAIT. We have assessed your conduct. The Assessor will now deliver our findings in person.",
    ]);
    arrive(f);
    breakCore(f, body, 0);
    expect(said.at(-1)).toBe(LINES.firstCore);
    breakCore(f, body, 1);
    expect(said.at(-1)).toBe(LINES.lastCore);
    breakCore(f, body, 2);
    expect(said.at(-1)).toBe(LINES.defeat);
    run(f, 10);
    f.playerDied(); // after it's down, a death isn't its doing
    expect(said).toEqual([arrival("GULLBAIT"), LINES.firstCore, LINES.lastCore, LINES.defeat]);
    expect(new Set(said).size).toBe(said.length);
  });

  it("says plain Breacher without a callsign", () => {
    expect(arrival(null)).toBe("Breacher. We have assessed your conduct. The Assessor will now deliver our findings in person.");
  });

  it("logs the player's remains once if they die to it", () => {
    const { f, said } = fight();
    arrive(f);
    f.playerDied();
    f.playerDied();
    expect(said.filter((t) => t === LINES.death)).toHaveLength(1);
    expect(LINES.defeat.endsWith("Cla")).toBe(true);
  });
});

describe("its attacks", () => {
  it("assesses a player in its beam and fires a volley at a full assessment", () => {
    const { f, G, bolts } = fight();
    // A player in the open on the apron in front of it, in its sight.
    G.player.pos = { x: 23.5, y: 0, z: 2 };
    G.player.eye = { x: 23.5, y: 1.6, z: 2 };
    G.physics.lineOfSight = () => true;
    arrive(f);
    run(f, 1.5);
    expect(f.assess).toBeGreaterThan(0.2);
    run(f, 4);
    expect(bolts.fired).toBe(TUNE.volley.bolts);
    expect(f.beam).toBe("cool");
    expect(f.assess).toBe(0);
  });

  it("drains the assessment fast when the player breaks line of sight", () => {
    const { f, G, bolts } = fight();
    G.player.pos = { x: 23.5, y: 0, z: 2 };
    G.player.eye = { x: 23.5, y: 1.6, z: 2 };
    G.physics.lineOfSight = () => true;
    arrive(f);
    run(f, 1.5);
    const a = f.assess;
    expect(a).toBeGreaterThan(0.45);
    G.physics.lineOfSight = () => false;
    run(f, 1);
    expect(f.assess).toBeLessThan(a - 0.4);
    run(f, 6);
    expect(bolts.fired).toBe(0);
  });

  it("stamps a player who comes close, and a jump clears the wave", () => {
    const { f, G, body } = fight();
    arrive(f);
    G.player.pos = { x: 22, y: 0, z: 13 };
    run(f, 1.2);
    expect(body.waves).toBe(1);
    run(f, 1.5);
    expect(G.player.damage).toHaveBeenCalledWith(TUNE.stamp.damage, expect.anything());

    const b = fight();
    arrive(b.f);
    b.G.player.pos = { x: 22, y: 1, z: 13 }; // in the air as the wave passes
    b.G.player.onGround = false;
    run(b.f, 2.6);
    expect(b.body.waves).toBeGreaterThan(0);
    expect(b.G.player.damage).not.toHaveBeenCalled();
  });
});

// ---- the boss in the game: the hooks, the chapters, a bad read ----

function economyFor(town: () => unknown): Economy {
  return { chain: { town } as any, wallet: { accountId: () => null } as any, manifest: null, carried: {} };
}
const reader = (r: any): TownReader => ({ last: r, read: () => Promise.resolve(r) });
function boss(read: any, o: { cores?: number } = {}) {
  const { G, radio } = fakeGame();
  G.ext.callsign = "GULLBAIT";
  let made: (Parts & { body: ReturnType<typeof fakeBody> }) | null = null;
  const b = createBoss(G, economyFor(() => null), {
    town: reader(read),
    build: (_G, cores) => (made = { body: fakeBody(cores), bolts: fakeBolts(), bar: fakeBar() }),
  });
  return { b, G, radio, made: () => made, cores: o.cores };
}
const flush = () => new Promise((ok) => setTimeout(ok, 0));
async function thirdCut(G: any) {
  G.events.emit("run:start", {});
  await flush();
  G.events.emit("objective:all", {});
  await flush();
}

describe("the boss in the game", () => {
  it("does nothing in Chapters 1 and 2: no boss, the boat open, shots pass", async () => {
    for (const act of [1, 2] as const) {
      const { b, G, made } = boss(ok(view(act)));
      await thirdCut(G);
      expect(b.fight).toBeNull();
      expect(made()).toBeNull();
      expect(G.ext.extractBlocked()).toBe(false);
      expect(G.ext.raycast({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, 300)).toBeNull();
      b.dispose();
    }
  });

  it("plays the run as before when town() is missing or the read failed", async () => {
    for (const r of [MISSING, FAILED]) {
      const { b, G, made } = boss(r);
      await thirdCut(G);
      expect(b.fight).toBeNull();
      expect(made()).toBeNull();
      expect(G.ext.extractBlocked()).toBe(false);
      b.dispose();
    }
  });

  it("plays the run as before when town() throws", async () => {
    const { G } = fakeGame();
    const b = createBoss(G, economyFor(() => Promise.reject(new Error("rpc down"))), { build: () => ({ body: fakeBody(3), bolts: fakeBolts(), bar: fakeBar() }) });
    await thirdCut(G);
    expect(b.read?.status).toBe("failed");
    expect(b.fight).toBeNull();
    expect(G.ext.extractBlocked()).toBe(false);
    b.dispose();
  });

  it("arrives at the third cut in Chapter 3, holds the boat, takes shots and lets the boat in once down", async () => {
    const { b, G, radio, made } = boss(ok(view(3, { strength: 62 })));
    G.events.emit("run:start", {});
    await flush();
    expect(b.fight).toBeNull();
    expect(G.ext.extractBlocked()).toBe(false);
    G.events.emit("objective:all", {});
    await flush();
    expect(b.fight?.cores).toBe(6);
    expect(made()!.bar).toBeTruthy();
    expect(G.weapon.reserve).toBe(TUNE.reserve);
    expect(G.ext.extractBlocked()).toBe(true);
    // The arrival line goes out once the radio is free, with the callsign.
    b.update(1 / 30);
    expect(radio).toContain(arrival("GULLBAIT"));
    // A shot through the hook lands on a core.
    for (let t = 0; t < 30; t += 1 / 30) b.update(1 / 30);
    const body = made()!.body;
    body.aim = 0;
    const hit = G.ext.raycast({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, 300);
    expect(hit.part).toBe("weak");
    for (let i = 0; i < 6; i++) while (b.fight!.hp[i] > 0) (body.aim = i, G.ext.raycast({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, 300).enemy.damage(57.2));
    expect(G.ext.extractBlocked()).toBe(true);
    for (let t = 0; t < TUNE.slump + TUNE.boatIn + 1; t += 1 / 30) b.update(1 / 30);
    expect(G.ext.extractBlocked()).toBe(false);
    // A new run clears it away.
    G.events.emit("run:start", {});
    await flush();
    expect(b.fight).toBeNull();
    expect(body.dispose).toHaveBeenCalled();
    expect(made()!.bar.dispose).toHaveBeenCalled(); // its bar leaves the HUD, not just hides
    b.dispose();
    expect(G.ext.raycast).toBeUndefined();
    expect(G.ext.extractBlocked).toBeUndefined();
  });

  it("waits for a quiet radio before it speaks", async () => {
    const { b, G, radio } = boss(ok(view(3)));
    const comms = document.createElement("div");
    comms.className = "comms on";
    document.body.append(comms);
    try {
      await thirdCut(G);
      b.update(1 / 30);
      expect(radio).toEqual([]); // Control is still on
      comms.classList.remove("on");
      b.update(1 / 30);
      expect(radio).toEqual([arrival("GULLBAIT")]);
    } finally {
      comms.remove();
      b.dispose();
    }
  });

  it("drops a line that waited too long for the radio", async () => {
    let now = 1_000;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
    const { b, G, radio } = boss(ok(view(3)));
    const comms = document.createElement("div");
    comms.className = "comms on";
    document.body.append(comms);
    try {
      await thirdCut(G);
      b.update(1 / 30);
      now += VOICE_TTL.arrival + 1;
      comms.classList.remove("on");
      b.update(1 / 30);
      expect(radio).toEqual([]);
    } finally {
      comms.remove();
      clock.mockRestore();
      b.dispose();
    }
  });

  it("drops beats still waiting for the radio once it's down: only the defeat goes out", async () => {
    const { b, G, radio, made } = boss(ok(view(3)));
    const comms = document.createElement("div");
    comms.className = "comms on";
    document.body.append(comms);
    try {
      await thirdCut(G);
      const body = made()!.body;
      for (let i = 0; i < 3; i++)
        while (b.fight!.hp[i] > 0) (body.aim = i, G.ext.raycast({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, 300).enemy.damage(57.2));
      b.update(1 / 30);
      expect(radio).toEqual([]);
      comms.classList.remove("on");
      b.update(1 / 30);
      expect(radio).toEqual([LINES.defeat]);
    } finally {
      comms.remove();
      b.dispose();
    }
  });

  it("doesn't arrive twice, or outside a run", async () => {
    const { b, G } = boss(ok(view(3)));
    await thirdCut(G);
    const first = b.fight;
    G.events.emit("objective:all", {});
    await flush();
    expect(b.fight).toBe(first);
    G.events.emit("game:state", { state: "title" });
    expect(b.fight).toBeNull();
    b.dispose();
  });
});
