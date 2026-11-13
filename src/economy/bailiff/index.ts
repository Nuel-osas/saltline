// The Bailiff, the Harbormaster's repossession officer and the game's hunter (docs/CAMPAIGN.md → The Bailiff), in
// the game: `G.bailiff` (campaign/types.ts, BailiffApi) stands them up, and this file runs them: the nav grid and
// line of sight they walk and see by, the player's shots (through ../hooks.ts), the breaker charge
// (`emp:detonated`), footfalls, the HUD chip, and their lines on the Harbormaster's channel under the label BAILIFF.
// `?bailiff=1` stands one up in the shed at the first uplink cut of any run; the missions call `spawn` themselves.
// Anything here that throws is caught: the shooter never depends on the Bailiff.
import "./bailiff.css";
import type { BailiffApi, BailiffHandle, V2, V3 } from "../campaign/types";
import { hooks } from "../hooks";
import { CHANNEL_LABEL, createChannel, type Channel, type TimedChannel } from "../story/radio";
import { bearing, createChip, type Chip } from "./chip";
import { HOLD, TTL, createVoice, type LineId } from "./copy";
import { createModel } from "./model";
import { SPAWN, TUNE, inBlast } from "./rules";
import type { Body, World } from "./types";
import { createUnit, type ShotHit, type Unit } from "./unit";

export { SPAWN, TUNE } from "./rules";

/* eslint-disable @typescript-eslint/no-explicit-any -- the game context is the untyped bundle's G */
type Game = any;

export interface BailiffOptions {
  /** Builds a body at `at` (tests pass a stand-in). `onStep` is told of each footfall. */
  build?: (G: Game, at: V2, onStep: (at: V3) => void) => Body;
  /** The HUD chip (tests pass a stand-in). */
  chip?: Chip;
  now?: () => number;
}

export interface Bailiffs extends BailiffApi {
  /** Every Bailiff of the run, for the smoke test and debugging. */
  readonly units: readonly Unit[];
  /** Where the debug switch and the missions stand one up (rules.ts, SPAWN). */
  readonly spots: typeof SPAWN;
  update(dt: number): void;
  dispose(): void;
}

const hd = (a: V2, b: V2) => Math.hypot(a.x - b.x, a.z - b.z);

/** The dock pass callsign the story puts in G.ext.callsign, or null (the line then says plain "Breacher"). */
function callsignOf(G: Game): string | null {
  const c = G?.ext?.callsign;
  return typeof c === "string" && c.trim() ? c.trim() : null;
}

export function createBailiffs(G: Game, opts: BailiffOptions = {}): Bailiffs {
  const now = opts.now ?? (() => performance.now());
  const T3 = G.THREE;
  const vec = (p: V3): V3 => (T3 ? new T3.Vector3(p.x, p.y, p.z) : { x: p.x, y: p.y, z: p.z });
  const warned = new Set<string>();
  function guard<T>(where: string, fn: () => T): T | undefined {
    try {
      return fn();
    } catch (e) {
      if (!warned.has(where)) (warned.add(where), console.warn(`[bailiff] ${where} failed; the game plays on`, e));
      return undefined;
    }
  }

  const units: Unit[] = [];
  const handles: BailiffHandle[] = [];
  let nextId = 0;
  const chip = opts.chip ?? createChip(typeof document === "undefined" ? null : (G.hud?.root ?? document.getElementById("ui")));
  const build = opts.build ?? ((g: Game, at: V2, onStep: (at: V3) => void) => createModel(g, at, { onStep }));

  // ---- its voice: the Harbormaster's channel, each line waiting briefly for a quiet radio or dropped ----
  // One channel for every voice: a second one would relabel the story's lines as Control's (story/radio.ts).
  const own: Channel | null = G.story?.channel ? null : createChannel(G);
  const channel: Channel & Partial<TimedChannel> = G.story?.channel ?? own!;
  const voice = createVoice(now);
  let waiting: { id: LineId; text: string; until: number }[] = [];
  function say(id: LineId) {
    const text = voice.ask(id, callsignOf(G));
    if (text) waiting.push({ id, text, until: now() + TTL[id] });
  }
  function speak() {
    if (!waiting.length) return;
    const t = now();
    waiting = waiting.filter((w) => w.until >= t);
    if (!waiting.length || (guard("busy", () => channel.busy?.()) ?? false)) return;
    const next = waiting.shift()!;
    guard("say", () => channel.say({ who: "harbormaster", text: next.text }, HOLD[next.id]));
  }
  const comms = () => (typeof document === "undefined" ? null : (document.querySelector<HTMLElement>("#ui > .comms") ?? document.querySelector<HTMLElement>(".comms")));

  // ---- the player is thrown by a grab: moved through the game's own collision, so walls stop them ----
  let shoves: { dx: number; dz: number; left: number; rate: number }[] = [];
  const push = T3 ? new T3.Vector3() : { x: 0, y: 0, z: 0, set() {} };
  function moveShoves(dt: number) {
    const p = G.player;
    if (!shoves.length || !p?.pos || p.alive === false) return void (shoves = []);
    for (const s of shoves) {
      const step = Math.min(s.left, s.rate * dt);
      s.left -= step;
      if (G.physics?.moveCapsule && T3) {
        push.set(s.dx * s.rate, 0, s.dz * s.rate);
        G.physics.moveCapsule(p.pos, push, step / s.rate);
      } else ((p.pos.x += s.dx * step), (p.pos.z += s.dz * step));
    }
    shoves = shoves.filter((s) => s.left > 1e-4);
  }

  const world: World = {
    player: () => G.player ?? null,
    los: (a, b) => !!G.physics.lineOfSight(a, b),
    walkable: (x, z) => !!G.physics.nav.isWalkable(x, z),
    path: (from, to) => G.physics.nav.findPath(from, to),
    ground: (x, z, maxY) => G.physics.groundHeight(x, z, maxY),
    uplinks: () => (G.game?.run?.relays ?? []).map((r: any) => ({ id: String(r.id), x: r.o.pos.x, z: r.o.pos.z, live: !r.cut })),
    boat: () => {
      const b = G.level?.extraction?.pos;
      return b ? { x: b.x, z: b.z } : null;
    },
    hurt: (amount, from) => G.player?.damage?.(amount, vec(from)),
    shove: (dx, dz, metres, seconds) => void shoves.push({ dx, dz, left: metres, rate: metres / Math.max(0.05, seconds) }),
    sfx: (name, o) => void guard("sfx", () => G.audio?.play?.(name, o)),
    emit: (name, payload) => G.events?.emit?.(name, payload),
    say,
    spark(point, normal, lens) {
      G.fx?.sparks?.(vec(point), vec(normal), lens ? 16 : 7);
      if (lens) G.render?.lightPool?.flash?.(vec(point), 0xffb050, 40, 6, 0.08);
      G.audio?.play?.("ricochet", { pos: point, pitch: lens ? 1.3 : 0.8, gain: 0.7 });
    },
    vec,
  };

  /** A footfall: the sound, a kick of dust, and the camera shakes inside 10 m. */
  function onStep(at: V3) {
    guard("step", () => {
      G.audio?.play?.("hound_step", { pos: at, pitch: 0.5, gain: 1, ref: 7, jitter: 0.05 });
      G.audio?.play?.("impact_metal", { pos: at, pitch: 0.42, gain: 0.5, ref: 7, jitter: 0.05 });
      if (T3) G.fx?.dust?.(new T3.Vector3(at.x, at.y + 0.04, at.z), new T3.Vector3(0, 1, 0), 0.7, 0.4, 0.39, 0.36);
      const p = G.player;
      if (p?.pos && typeof p.addShake === "function") {
        const d = hd(p.pos, at);
        if (d < TUNE.shake) p.addShake(0.05 + 0.15 * (1 - d / TUNE.shake));
      }
    });
  }

  /** The nearest walkable spot to `at`, searching rings out to 3 m; `at` itself if the grid has nothing. */
  function snap(at: V2): V2 {
    const ok = (x: number, z: number) => guard("walkable", () => world.walkable(x, z)) ?? true;
    if (ok(at.x, at.z)) return { x: at.x, z: at.z };
    for (let r = 0.5; r <= 3; r += 0.5)
      for (let a = 0; a < 12; a++) {
        const x = at.x + Math.cos((a / 12) * 6.2832) * r,
          z = at.z + Math.sin((a / 12) * 6.2832) * r;
        if (ok(x, z)) return { x, z };
      }
    return { x: at.x, z: at.z };
  }

  const api: Bailiffs = {
    spawn({ at, delay }) {
      const spot = snap(at);
      const body = build(G, spot, onStep);
      const unit = createUnit({
        id: ++nextId,
        at: spot,
        delay,
        world,
        body,
        onRemove(u) {
          const i = units.indexOf(u);
          if (i >= 0) (units.splice(i, 1), handles.splice(i, 1));
        },
      });
      units.push(unit);
      handles.push(unit.handle);
      return unit.handle;
    },
    list: handles,
    units,
    spots: SPAWN,
    anyStanding: () => units.some((u) => u.handle.standing),
    nearest() {
      const p = G.player?.pos;
      let best: Unit | null = null,
        bd = Infinity;
      for (const u of units) {
        if (!u.appeared) continue;
        const d = p ? hd(p, u.handle.pos) : Infinity;
        if (!best || d < bd) ((best = u), (bd = d));
      }
      return best ? { handle: best.handle, dist: bd } : null;
    },
    clear() {
      for (const u of [...units]) guard("remove", () => u.dispose());
      units.length = 0;
      handles.length = 0;
      waiting = [];
      shoves = [];
      guard("chip", () => chip.set(null));
    },
    update(dt) {
      const st = G.game?.state;
      if (st !== "playing" && st !== "dead") return;
      guard("shove", () => moveShoves(dt));
      for (const u of [...units]) guard("update", () => u.update(dt));
      speak();
      guard("chip", () => {
        const near = api.nearest();
        const p = G.player;
        if (!near || !p?.pos || near.dist > TUNE.near.chip) return chip.set(null);
        const u = units.find((x) => x.handle === near.handle)!;
        chip.set({ dist: near.dist, bearing: bearing(p.pos, p.yaw ?? 0, near.handle.pos), sees: u.sees, down: u.down });
      });
    },
    dispose() {
      api.clear();
      for (const off of offs) off();
      offShot();
      chip.dispose();
      own?.dispose();
    },
  };

  // ---- the player's shots: the nearest hit among them (../hooks.ts picks the nearest among every target) ----
  const offShot = hooks(G).addShotTarget((origin: any, dir: any, max: number) => {
    let best: ShotHit | null = null;
    for (const u of units) {
      const h = guard("raycast", () => u.raycast(origin, dir, best ? best.dist : max));
      if (h && (!best || h.dist < best.dist)) best = h;
    }
    return best;
  });

  // ---- the debug switch: ?bailiff=1 stands one up in the shed at the first cut of any run ----
  const debug = !!G.params && typeof G.params === "object" && "bailiff" in G.params && G.params.bailiff !== "0";
  let released = false;
  /** True if the player can't see a Bailiff standing at `at` (or it's too far to matter). */
  function unseen(at: V2): boolean {
    const p = G.player;
    if (!p?.pos) return true;
    const eye = p.eye ?? { x: p.pos.x, y: p.pos.y + 1.6, z: p.pos.z };
    return ![0.5, 1.4, 2.4].some((y) => guard("los", () => world.los(eye, { x: at.x, y, z: at.z })) ?? false);
  }
  function release() {
    if (released || units.length) return;
    released = true;
    const spots: V2[] = [SPAWN.shed, ...SPAWN.shedAlt];
    const p = G.player?.pos;
    const far = [...spots].sort((a, b) => (p ? hd(p, b) - hd(p, a) : 0))[0];
    api.spawn({ at: spots.find(unseen) ?? far });
  }

  const offs: (() => void)[] = [];
  const on = (name: string, fn: (e: any) => void) => {
    const off = G.events?.on?.(name, (e: any) => guard(name, () => fn(e)));
    if (typeof off === "function") offs.push(off);
  };
  on("run:start", () => {
    api.clear();
    voice.reset();
    released = false;
  });
  // The run is over: the boat, or back to the title. A death leaves it standing over the player until the retry.
  on("extraction:reached", () => api.clear());
  on("game:state", (e: { state?: string }) => {
    if (e?.state === "title" || e?.state === "complete") api.clear();
  });
  on("player:dead", () => {
    for (const u of units) u.halt();
    waiting = [];
  });
  on("emp:detonated", (e: { pos?: V3; radius?: number }) => {
    if (!e?.pos) return;
    for (const u of [...units]) if (u.appeared && inBlast(u.handle.pos, e.pos, e.radius ?? 0)) u.drop("charge");
  });
  on("objective:done", () => {
    if (debug && G.game?.state === "playing") release();
  });
  // Its lines go out on the Harbormaster's channel; when one starts, the box takes the Bailiff's label. Registered
  // after the channel's own listener, so this runs second.
  on("radio:line", (e: { text?: string }) => {
    const box = comms();
    if (!box) return;
    const mine = !!e && typeof e.text === "string" && voice.owns(e.text);
    box.classList.toggle("bf-voice", mine);
    const label = box.querySelector(".comms-who");
    if (mine && label) label.textContent = CHANNEL_LABEL.bailiff;
  });

  return api;
}

/** Starts the Bailiff beside a booted game (main.ts), and drives it on animation frames. */
export function startBailiff(G: Game): Bailiffs | null {
  try {
    const b = createBailiffs(G);
    G.bailiff = b;
    let last = performance.now();
    const loop = (t: number) => {
      const dt = Math.min(0.05, Math.max(0, (t - last) / 1000));
      last = t;
      b.update(dt);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
    return b;
  } catch (e) {
    console.warn("[bailiff] off:", e);
    return null;
  }
}
