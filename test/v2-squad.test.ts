// @vitest-environment happy-dom
// Live presence (squad/): what is sent, how what arrives is checked, how a figure moves between updates, and the
// module itself with a stand-in for the wire and for the 3D figures.
import { afterEach, describe, expect, it } from "vitest";
import { type Body, squadOn, startSquad } from "../src/economy/v2/squad";
import { HitGate, LIMITS, PVP, Track, cleanCallsign, encode, nearest, rayHitsFigure, sanitize } from "../src/economy/v2/squad/model";
import type { Net, NetHandlers } from "../src/economy/v2/squad/net";

const wire = (over: Record<string, unknown> = {}) => ({ c: "ROOK", x: 1, y: 0, z: 2, w: 0.5, m: 3, k: 0, f: "longshore", ...over });

describe("what arrives from another browser", () => {
  it("is rebuilt field by field", () => {
    expect(sanitize(wire())).toEqual({ c: "ROOK", x: 1, y: 0, z: 2, w: 0.5, m: 3, k: 0, f: "longshore" });
    expect(sanitize({ ...wire(), extra: "x", __proto__: { admin: true } })).toEqual(sanitize(wire()));
  });
  it("is dropped when a position or a turn isn't a number in range", () => {
    for (const bad of [{ x: Number.NaN }, { x: 1e9 }, { z: "2" }, { y: 999 }, { w: Number.POSITIVE_INFINITY }, { x: null }]) expect(sanitize(wire(bad))).toBeNull();
    for (const bad of [null, undefined, 7, "st", []]) expect(sanitize(bad)).toBeNull();
  });
  it("has its smaller faults put right, not believed", () => {
    expect(sanitize(wire({ c: "<img src=x>", f: "railgun", m: 900, k: "yes", w: 7 }))).toMatchObject({ c: "IMG SRCX", f: "issue", m: 0, k: 0 });
    expect(sanitize(wire({ w: 7 }))!.w).toBeCloseTo(7 - 2 * Math.PI, 6);
    expect(cleanCallsign("")).toBe("BREACHER");
    expect(cleanCallsign(42)).toBe("BREACHER");
    expect(cleanCallsign("a very long callsign indeed")).toHaveLength(16);
  });
  it("what this player sends passes its own check", () => {
    const sent = encode({ callsign: "marlo 21", x: 1.23456, y: 0, z: -8.5, yaw: 3.14159, speed: 99, crouched: true, frame: "pilot" });
    expect(sent).toEqual({ c: "MARLO 21", x: 1.23, y: 0, z: -8.5, w: 3.14, m: 14, k: 1, f: "pilot" });
    expect(sanitize(sent)).toEqual(sent);
  });
});

describe("a figure between two updates", () => {
  it("stands on the only update it has, then glides to the next a little behind it", () => {
    const t = new Track();
    expect(t.at(0)).toBeNull();
    t.push(sanitize(wire({ x: 0, z: 0 }))!, 1000);
    expect(t.at(1050)).toMatchObject({ x: 0, z: 0 });
    t.push(sanitize(wire({ x: 1, z: 0 }))!, 1100);
    expect(t.at(1100 + LIMITS.delayMs - 50)!.x).toBeCloseTo(0.5, 5);
    expect(t.at(1100 + LIMITS.delayMs + 500)!.x).toBe(1); // never past the newest update
  });
  it("turns the short way round, and takes a jump at once", () => {
    const t = new Track();
    t.push(sanitize(wire({ w: 3.0 }))!, 0);
    t.push(sanitize(wire({ w: -3.0 }))!, 100);
    expect(Math.abs(t.at(50 + LIMITS.delayMs)!.yaw)).toBeGreaterThan(3); // through π, not back through 0
    t.push(sanitize(wire({ x: 90, z: 90 }))!, 200);
    expect(t.at(201)).toMatchObject({ x: 90, z: 90 });
  });
  it("goes stale when nothing is heard", () => {
    const t = new Track();
    expect(t.stale(0)).toBe(true);
    t.push(sanitize(wire())!, 1000);
    expect(t.stale(1000 + LIMITS.staleMs)).toBe(false);
    expect(t.stale(1001 + LIMITS.staleMs)).toBe(true);
  });
  it("only the nearest are drawn", () => {
    const peers = Array.from({ length: LIMITS.peers + 5 }, (_, i) => {
      const track = new Track();
      track.push(sanitize(wire({ x: i * 3, z: 0 }))!, 0);
      return { id: String(i), track };
    });
    const near = nearest(peers, { x: 0, z: 0 }, 10);
    expect(near).toHaveLength(LIMITS.peers);
    expect(near.map((p) => p.id)).toEqual(peers.slice(0, LIMITS.peers).map((p) => p.id));
  });
});

describe("the module", () => {
  afterEach(() => (document.body.innerHTML = ""));

  function world(pvp = false) {
    document.body.innerHTML = `<div id="ui"></div>`;
    let clock = 0;
    const sent: unknown[] = [];
    const hits: [string, number][] = [];
    const kos: string[] = [];
    let handlers: NetHandlers | null = null;
    let left = 0;
    const bodies: { seed: number; at: unknown; label: string; gone: boolean }[] = [];
    const hurt: number[] = [];
    let shotTarget: ((o: unknown, d: unknown, max: number) => { dist: number } | null) | null = null;
    const G: any = { game: { state: "playing" }, weapon: { damage: 30 }, player: { pos: { x: 0, y: 0, z: 0 }, yaw: 0, health: 100, damage(n: number) { hurt.push(n); this.health -= n; } } };
    const squad = startSquad(G, {
      room: "test",
      callsign: () => "ME",
      frame: () => "issue",
      now: () => clock,
      pvp,
      addShotTarget: (fn) => ((shotTarget = fn), () => void (shotTarget = null)),
      connect: async (_room, h) => ((handlers = h), { send: (s) => void sent.push(s), hit: (id, d) => void hits.push([id, d]), ko: (id) => void kos.push(id), leave: () => void left++ } satisfies Net),
      body: (_G, seed) => {
        const b = { seed, at: null as unknown, label: "", gone: false };
        bodies.push(b);
        return { place: (p) => void (b.at = p), label: (t) => void (b.label = t), dispose: () => void (b.gone = true) } satisfies Body;
      },
    });
    const step = async (ms: number) => {
      clock += ms;
      squad.update(ms / 1000);
      await Promise.resolve();
      await Promise.resolve();
    };
    return { squad, G, sent, hits, kos, hurt, shoot: (o: unknown, d: unknown, max = 500) => shotTarget?.(o, d, max) ?? null, armed: () => !!shotTarget, hitMe: (id: string, raw: unknown) => handlers!.onHit(id, raw), koMe: (id: string) => handlers!.onKo(id), note: () => document.querySelector<HTMLElement>(".sq-note")!, bodies, step, say: (id: string, raw: unknown) => handlers!.onState(id, raw), leave: (id: string) => handlers!.onLeave(id), left: () => left, chip: () => document.querySelector<HTMLElement>(".sq-chip")! };
  }

  it("joins when a raid is on, and sends this player's place ten times a second", async () => {
    const w = world();
    await w.step(16);
    expect(w.squad.connected).toBe(true);
    for (let i = 0; i < 10; i++) await w.step(100);
    expect(w.sent.length).toBeGreaterThanOrEqual(9);
    expect(w.sent.length).toBeLessThanOrEqual(11);
    expect(w.sent[0]).toMatchObject({ c: "ME", x: 0, z: 0, f: "issue" });
  });

  it("draws a breacher it hears from, with their callsign, and says so on the HUD", async () => {
    const w = world();
    await w.step(16);
    w.say("peer-a", wire({ c: "cutwater", x: 4, z: 6 }));
    await w.step(16);
    expect(w.bodies).toHaveLength(1);
    expect(w.bodies[0].label).toBe("CUTWATER");
    expect(w.bodies[0].at).toMatchObject({ x: 4, z: 6 });
    expect(w.squad.here()).toEqual(["CUTWATER"]);
    expect(w.chip().hidden).toBe(false);
    expect(w.chip().textContent).toBe("Live · 1 breacher in your yard: CUTWATER");
  });

  it("ignores rubbish, and forgets a breacher who leaves or falls silent", async () => {
    const w = world();
    await w.step(16);
    w.say("peer-x", { x: "nope" });
    w.say("peer-a", wire());
    w.say("peer-b", wire({ c: "ROOK 2", x: 9 }));
    await w.step(16);
    expect(w.bodies).toHaveLength(2);
    w.leave("peer-a");
    await w.step(16);
    expect(w.bodies[0].gone).toBe(true);
    await w.step(LIMITS.staleMs + 50); // peer-b says nothing more
    expect(w.bodies[1].gone).toBe(true);
    expect(w.squad.here()).toEqual([]);
    expect(w.chip().hidden).toBe(true);
  });

  it("sends nothing and draws nobody outside a raid, and stop() leaves the room", async () => {
    const w = world();
    w.G.game.state = "title";
    await w.step(500);
    expect(w.squad.connected).toBe(false);
    expect(w.sent).toEqual([]);
    w.G.game.state = "playing";
    await w.step(16);
    w.say("peer-a", wire());
    await w.step(16);
    expect(w.bodies).toHaveLength(1);
    w.G.game.state = "complete";
    await w.step(16);
    expect(w.bodies[0].gone).toBe(true);
    w.squad.stop();
    expect(w.left()).toBe(1);
    expect(document.querySelector(".sq-chip")).toBeNull();
  });

  it("where players can only see each other, a shot passes through and a claimed hit does nothing", async () => {
    const w = world(false);
    await w.step(16);
    w.say("peer-a", wire({ x: 0, z: -5 }));
    await w.step(16);
    expect(w.armed()).toBe(false);
    w.hitMe("peer-a", { d: 40 });
    expect(w.hurt).toEqual([]);
  });

  it("in Practice a shot that meets a breacher tells them, with what the gun does; a head hit does more", async () => {
    const w = world(true);
    await w.step(16);
    w.say("peer-a", wire({ c: "ROOK", x: 0, z: -5 }));
    await w.step(16);
    const body = w.shoot({ x: 0, y: 1.1, z: 0 }, { x: 0, y: 0, z: -1 });
    expect(body!.dist).toBeCloseTo(5 - 0.42, 2);
    expect(w.hits).toEqual([["peer-a", 30]]);
    expect(w.note().textContent).toBe("Hit · ROOK");
    w.shoot({ x: 0, y: 1.63, z: 0 }, { x: 0, y: 0, z: -1 });
    expect(w.hits[1]).toEqual(["peer-a", Math.round(30 * PVP.headMult)]);
    expect(w.shoot({ x: 0, y: 1.1, z: 0 }, { x: 1, y: 0, z: 0 })).toBeNull(); // aimed elsewhere
    expect(w.shoot({ x: 0, y: 1.1, z: 0 }, { x: 0, y: 0, z: -1 }, 3)).toBeNull(); // a wall is nearer
    expect(w.hits).toHaveLength(2);
  });

  it("in Practice a believed hit hurts this player, a drop is answered, and a lie is ignored", async () => {
    const w = world(true);
    await w.step(16);
    w.say("peer-a", wire({ c: "ROOK", x: 3, z: 0 }));
    await w.step(16);
    w.hitMe("peer-a", { d: 40 });
    expect(w.hurt).toEqual([40]);
    expect(w.note().textContent).toBe("Hit by ROOK");
    w.hitMe("peer-a", { d: 99999 }); // more than any gun does: cut to the most a hit can do
    expect(w.hurt[1]).toBe(PVP.maxDamage);
    expect(w.kos).toEqual(["peer-a"]); // 100 − 40 − 95: dropped
    w.hitMe("nobody", { d: 40 }); // not someone this browser is hearing from
    w.hitMe("peer-a", { d: "lots" });
    w.hitMe("peer-a", null);
    expect(w.hurt).toHaveLength(2);
    w.koMe("peer-a"); // this player never hit them: not believed, and they stay in view
    expect(w.note().textContent).not.toBe("You dropped ROOK");
    expect(w.squad.here()).toEqual(["ROOK"]);
  });

  it("in Practice a breacher this player dropped leaves the yard until they are back in a raid", async () => {
    const w = world(true);
    await w.step(16);
    w.say("peer-a", wire({ c: "ROOK", x: 0, z: -5 }));
    await w.step(16);
    const aim = [{ x: 0, y: 1.1, z: 0 }, { x: 0, y: 0, z: -1 }] as const;
    expect(w.shoot(...aim)).not.toBeNull();
    w.koMe("peer-a");
    expect(w.note().textContent).toBe("You dropped ROOK");
    expect(w.squad.here()).toEqual([]);
    expect(w.bodies[0].gone).toBe(true);
    expect(w.shoot(...aim)).toBeNull(); // nobody stands there now
    w.say("peer-a", wire({ c: "ROOK", x: 0, z: -5 })); // an update that was already on its way
    await w.step(16);
    expect(w.squad.here()).toEqual([]);
    await w.step(PVP.downMs);
    w.say("peer-a", wire({ c: "ROOK", x: 9, z: 9 })); // back in a raid
    await w.step(16);
    expect(w.squad.here()).toEqual(["ROOK"]);
    // A drop claimed long after the last hit isn't believed.
    expect(w.shoot({ x: 9, y: 1.1, z: 0 }, { x: 0, y: 0, z: 1 })).not.toBeNull();
    await w.step(PVP.koWithinMs + 1);
    w.say("peer-a", wire({ c: "ROOK", x: 9, z: 9 }));
    w.koMe("peer-a");
    await w.step(16);
    expect(w.squad.here()).toEqual(["ROOK"]);
  });

  it("is off for an automated browser and with ?squad=0, and ?squad=1 forces it on", () => {
    expect(squadOn("", false)).toBe(true);
    expect(squadOn("", true)).toBe(false);
    expect(squadOn("?squad=0", false)).toBe(false);
    expect(squadOn("?game=v2&squad=1", true)).toBe(true);
  });
});

describe("a shot and a figure", () => {
  const at = { x: 0, y: 0, z: -10 };
  it("meets the chest, the legs or the head, at the right distance", () => {
    const chest = rayHitsFigure({ x: 0, y: 1.08, z: 0 }, { x: 0, y: 0, z: -1 }, 100, at)!;
    expect(chest.dist).toBeCloseTo(10 - 0.42, 6);
    expect(chest.head).toBe(false);
    expect(rayHitsFigure({ x: 0, y: 1.63, z: 0 }, { x: 0, y: 0, z: -1 }, 100, at)!.head).toBe(true);
    expect(rayHitsFigure({ x: 0, y: 0.45, z: 0 }, { x: 0, y: 0, z: -1 }, 100, at)!.head).toBe(false);
  });
  it("misses beside it, over it, behind the shooter and past the nearest wall", () => {
    expect(rayHitsFigure({ x: 1, y: 1.08, z: 0 }, { x: 0, y: 0, z: -1 }, 100, at)).toBeNull();
    expect(rayHitsFigure({ x: 0, y: 2.4, z: 0 }, { x: 0, y: 0, z: -1 }, 100, at)).toBeNull();
    expect(rayHitsFigure({ x: 0, y: 1.08, z: 0 }, { x: 0, y: 0, z: 1 }, 100, at)).toBeNull();
    expect(rayHitsFigure({ x: 0, y: 1.08, z: 0 }, { x: 0, y: 0, z: -1 }, 5, at)).toBeNull();
  });
});

describe("which claimed hits are believed", () => {
  it("a hit from someone in reach, doing what a gun can", () => {
    const g = new HitGate();
    expect(g.accept("a", { d: 30 }, 0, 12)).toBe(30);
    expect(g.accept("a", { d: 30.6 }, 10, 12)).toBe(31);
    expect(g.accept("a", { d: 5000 }, 20, 12)).toBe(PVP.maxDamage);
  });
  it("not one from out of reach, from nowhere, or that isn't a number", () => {
    const g = new HitGate();
    expect(g.accept("a", { d: 30 }, 0, PVP.maxRange + 1)).toBe(0);
    expect(g.accept("a", { d: 30 }, 0, null)).toBe(0);
    for (const bad of [null, {}, { d: "30" }, { d: -4 }, { d: Number.NaN }, { d: 0 }]) expect(g.accept("a", bad, 0, 5)).toBe(0);
  });
  it("and no faster than a gun fires, per player", () => {
    const g = new HitGate();
    let believed = 0;
    for (let i = 0; i < 60; i++) if (g.accept("a", { d: 20 }, i * 5, 5)) believed++; // 60 claims in 0.3 s
    expect(believed).toBe(PVP.maxHitsPerSecond);
    expect(g.accept("b", { d: 20 }, 300, 5)).toBe(20); // another player has their own count
    expect(g.accept("a", { d: 20 }, 1400, 5)).toBe(20); // a second later, believed again
  });
});
