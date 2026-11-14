// @vitest-environment happy-dom
// Live presence (squad/): what is sent, how what arrives is checked, how a figure moves between updates, and the
// module itself with a stand-in for the wire and for the 3D figures.
import { afterEach, describe, expect, it } from "vitest";
import { type Body, squadOn, startSquad } from "../src/economy/v2/squad";
import { LIMITS, Track, cleanCallsign, encode, nearest, sanitize } from "../src/economy/v2/squad/model";
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

  function world() {
    document.body.innerHTML = `<div id="ui"></div>`;
    let clock = 0;
    const sent: unknown[] = [];
    let handlers: NetHandlers | null = null;
    let left = 0;
    const bodies: { seed: number; at: unknown; label: string; gone: boolean }[] = [];
    const G: any = { game: { state: "playing" }, player: { pos: { x: 0, y: 0, z: 0 }, yaw: 0 } };
    const squad = startSquad(G, {
      room: "test",
      callsign: () => "ME",
      frame: () => "issue",
      now: () => clock,
      connect: async (_room, h) => ((handlers = h), { send: (s) => void sent.push(s), leave: () => void left++ } satisfies Net),
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
    return { squad, G, sent, bodies, step, say: (id: string, raw: unknown) => handlers!.onState(id, raw), leave: (id: string) => handlers!.onLeave(id), left: () => left, chip: () => document.querySelector<HTMLElement>(".sq-chip")! };
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

  it("is off for an automated browser and with ?squad=0, and ?squad=1 forces it on", () => {
    expect(squadOn("", false)).toBe(true);
    expect(squadOn("", true)).toBe(false);
    expect(squadOn("?squad=0", false)).toBe(false);
    expect(squadOn("?game=v2&squad=1", true)).toBe(true);
  });
});
