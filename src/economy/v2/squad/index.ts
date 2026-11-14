// Live presence (G.squad): other breachers who are in a raid right now appear in your yard, moving as they move,
// with their callsign over their head.
//
// What this is: you see each other. Each browser tells the others where its player is ten times a second, directly
// (net.ts), and draws a figure for everyone it hears from (the opening film's figures, intro/figure.ts).
// What this is not: a shared raid. Your machines, your containers and your invoice are still yours alone, and nothing
// here touches the chain.
//
// Shooting each other is on in Skirmish and nowhere else (`pvp`). Skirmish is the offline practice game in a yard of
// its own, which the player picks in the lobby, so nobody learning in Practice is shot by a stranger. A hit is the
// shooter's browser telling the other player's browser "I hit you", and the one who was hit decides whether to
// believe it (model.ts HitGate). That is one browser's word against another's. In Skirmish nothing real is at stake,
// so a liar gains nothing. In a raid on the chain a death costs a real gun, so there players can see each other and
// no more, until a hit can be trusted.
//
// It is off for an automated browser (the smoke and end-to-end runs must not reach out to public relays) and with
// `?squad=0`; `?squad=1` forces it on.
import { createFigure, type Figure } from "../intro/figure";
import { hooks } from "../../hooks";
import { HitGate, LIMITS, PVP, Track, encode, nearest, rayHitsFigure, sanitize } from "./model";
import { type Connect, type Net, connect as realConnect } from "./net";
import "./squad.css";

/* eslint-disable @typescript-eslint/no-explicit-any -- the game context is the untyped bundle's G */
type Game = any;
type Obj = any;

export interface SquadOptions {
  /** The room: the chain game and Practice are separate yards. */
  room: string;
  callsign: () => string;
  /** The frame of the gun in hand, or "issue". */
  frame: () => string;
  /** Players can shoot each other. Only where the player chose it and nothing is at stake: Skirmish. */
  pvp?: boolean;
  connect?: Connect;
  /** Registers something this player's shots can hit (hooks.ts); tests give their own. */
  addShotTarget?: (fn: (origin: any, dir: any, max: number) => { dist: number } | null) => () => void;
  /** Builds a peer's figure; tests give a stand-in with no 3D. */
  body?: (G: Game, seed: number) => Body;
  now?: () => number;
}

export interface Body {
  place(p: { x: number; y: number; z: number; yaw: number; speed: number; crouched: boolean }, dt: number): void;
  label(text: string): void;
  dispose(): void;
}

export interface Squad {
  /** Callsigns of the breachers drawn in your yard right now. */
  here(): string[];
  readonly connected: boolean;
  /** One step: sends this player's state when it is due and moves every figure. The module calls it each frame. */
  update(dt: number): void;
  stop(): void;
}

/** Whether presence runs on this page load. */
export function squadOn(search: string, automated: boolean): boolean {
  const q = new URLSearchParams(search).get("squad");
  if (q === "0") return false;
  if (q === "1") return true;
  return !automated;
}

const COATS = [0xd9a441, 0x3f7fb5, 0xb5523f, 0x4f9a6a, 0x8a6bb8, 0xc9c2b0, 0xd97a2b, 0x2f8f8f];
const hash = (s: string) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
};

/** A peer in the world: one of the film's figures, and a callsign that floats over it. */
function figureBody(G: Game, seed: number): Body {
  const T = G.THREE;
  const fig: Figure = createFigure(G, { coat: COATS[seed % COATS.length], headlamp: true, seed });
  fig.root.name = "squad";
  G.scene.add(fig.root);
  let tag: Obj = null;
  let text = "";
  return {
    place(p, dt) {
      const r = fig.root;
      r.position.set(p.x, p.y, p.z);
      r.rotation.y = p.yaw + Math.PI; // the game's yaw 0 looks down −z; a figure's heading 0 faces +z
      fig.p.walk = Math.max(0, Math.min(1, p.speed / 2.5));
      fig.p.phase += (p.speed * dt) / Math.max(0.6, fig.p.stride || 1.4);
      fig.p.crouch = p.crouched ? 0.8 : 0;
      fig.update(dt);
    },
    label(next) {
      if (next === text) return;
      text = next;
      if (tag) (fig.root.remove(tag), tag.material.map.dispose(), tag.material.dispose());
      const c = document.createElement("canvas");
      c.width = 512;
      c.height = 96;
      const g = c.getContext("2d");
      if (!g) return;
      g.font = "700 54px 'Barlow Condensed', 'Arial Narrow', sans-serif";
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.fillStyle = "rgba(0,0,0,.86)";
      const w = Math.min(500, g.measureText(next).width + 44);
      g.fillRect((512 - w) / 2, 10, w, 76);
      g.fillStyle = "#ffb347";
      g.fillText(next, 256, 50, 470);
      tag = new T.Sprite(new T.SpriteMaterial({ map: new T.CanvasTexture(c), transparent: true, depthWrite: false }));
      tag.scale.set(1.5, 0.28, 1);
      tag.position.set(0, 2.08, 0);
      fig.root.add(tag);
    },
    dispose() {
      if (tag) (tag.material.map.dispose(), tag.material.dispose());
      G.scene.remove(fig.root);
      fig.dispose();
    },
  };
}

export function startSquad(G: Game, opts: SquadOptions): Squad {
  const now = opts.now ?? (() => performance.now());
  const join = opts.connect ?? realConnect;
  const makeBody = opts.body ?? figureBody;
  const peers = new Map<string, { id: string; track: Track; body: Body | null }>();
  const chip = document.createElement("div");
  chip.className = "sq-chip";
  chip.hidden = true;
  document.getElementById("ui")?.append(chip);
  let net: Net | null = null;
  let joining = false;
  let stopped = false;
  let sendIn = 0;
  let last = { x: 0, z: 0 };
  let shown = "";
  const pvp = !!opts.pvp;
  const gate = new HitGate();
  /** When this player last told each breacher they were hit, and who is down (and until when nothing from them is drawn). */
  const lastHitOn = new Map<string, number>();
  const downUntil = new Map<string, number>();
  const note = document.createElement("div");
  note.className = "sq-note";
  note.hidden = true;
  document.getElementById("ui")?.append(note);
  let noteUntil = 0;
  const say = (text: string) => {
    note.textContent = text;
    note.hidden = false;
    noteUntil = now() + 2600;
  };

  const playing = () => G.game?.state === "playing";

  function connectOnce() {
    if (net || joining || stopped) return;
    joining = true;
    join(opts.room, {
      onState(peerId, raw) {
        const s = sanitize(raw);
        if (!s || typeof peerId !== "string" || peerId.length > 80) return;
        if ((downUntil.get(peerId) ?? 0) > now()) return; // just dropped: they are drawn again when they are back in a raid
        downUntil.delete(peerId);
        let p = peers.get(peerId);
        if (!p) {
          if (peers.size >= LIMITS.peers * 4) return; // a room far past what is drawn: stop taking new names
          p = { id: peerId, track: new Track(), body: null };
          peers.set(peerId, p);
        }
        p.track.push(s, now());
      },
      onLeave(peerId) {
        drop(peerId);
      },
      // Another player says their shot met this one. This browser decides (HitGate); only in Skirmish.
      onHit(peerId, raw) {
        const p = peers.get(peerId);
        const pl = G.player;
        if (!pvp || !playing() || !p || !pl?.pos || p.track.stale(now())) return;
        const from = p.track.state!;
        const damage = gate.accept(peerId, raw, now(), Math.hypot(from.x - pl.pos.x, from.z - pl.pos.z));
        if (!damage) return;
        const src = G.THREE?.Vector3 ? new G.THREE.Vector3(from.x, from.y + 1.4, from.z) : { x: from.x, y: from.y + 1.4, z: from.z };
        pl.damage?.(damage, src);
        say(`Hit by ${from.c}`);
        if (Number(pl.health) <= 0) (net?.ko(peerId), say(`Dropped by ${from.c}`));
      },
      // A breacher says this player's hit dropped them. Believed only from someone this player has just hit: the
      // figure goes, so a player who could say it freely could make themselves impossible to see or shoot.
      onKo(peerId) {
        const p = peers.get(peerId);
        const hitAt = lastHitOn.get(peerId);
        if (!pvp || !p?.track.state || hitAt === undefined || now() - hitAt > PVP.koWithinMs) return;
        say(`You dropped ${p.track.state.c}`);
        lastHitOn.delete(peerId);
        downUntil.set(peerId, now() + PVP.downMs);
        drop(peerId);
      },
    })
      .then((n) => (stopped ? n.leave() : (net = n)))
      .catch((e) => console.info("[squad] couldn't reach the other breachers:", (e as Error)?.message ?? e))
      .finally(() => (joining = false));
  }

  // This player's shots: the nearest drawn breacher the ray meets is told, with what the gun in hand does.
  const removeTarget = pvp
    ? (opts.addShotTarget ?? ((fn) => hooks(G).addShotTarget(fn)))((origin, dir, max) => {
        if (!playing() || !net) return null;
        let best: { dist: number; head: boolean; id: string; name: string } | null = null;
        for (const p of peers.values()) {
          const at = p.body ? p.track.at(now()) : null;
          const h: { dist: number; head: boolean } | null = at ? rayHitsFigure(origin, dir, best ? best.dist : max, at) : null;
          if (h) best = { ...h, id: p.id, name: p.track.state!.c };
        }
        if (!best) return null;
        net.hit(best.id, Math.min(PVP.maxDamage, Math.round((Number(G.weapon?.damage) || 20) * (best.head ? PVP.headMult : 1))));
        lastHitOn.set(best.id, now());
        say(best.head ? `Headshot · ${best.name}` : `Hit · ${best.name}`);
        return { dist: best.dist };
      })
    : null;

  function drop(id: string) {
    const p = peers.get(id);
    if (!p) return;
    p.body?.dispose();
    peers.delete(id);
    lastHitOn.delete(id);
  }

  function update(dt: number) {
    if (stopped) return;
    const t = now();
    const pl = G.player;
    if (playing() && pl?.pos) {
      connectOnce();
      sendIn -= dt;
      if (net && sendIn <= 0) {
        sendIn = 1 / LIMITS.sendHz;
        const speed = Math.hypot(pl.pos.x - last.x, pl.pos.z - last.z) * LIMITS.sendHz;
        last = { x: pl.pos.x, z: pl.pos.z };
        net.send(encode({ callsign: opts.callsign(), x: pl.pos.x, y: pl.pos.y || 0, z: pl.pos.z, yaw: pl.yaw || 0, speed, crouched: !!pl.crouching, frame: opts.frame() }));
      }
    }
    // Everyone still heard from, nearest first; the rest lose their figure, and the silent are forgotten.
    for (const p of [...peers.values()]) if (p.track.stale(t)) drop(p.id);
    const me = { x: pl?.pos?.x ?? 0, z: pl?.pos?.z ?? 0 };
    const draw = playing() ? nearest([...peers.values()], me, t) : [];
    const drawn = new Set(draw);
    for (const p of peers.values()) {
      if (!drawn.has(p)) {
        if (p.body) (p.body.dispose(), (p.body = null));
        continue;
      }
      const at = p.track.at(t);
      if (!at) continue;
      p.body ??= makeBody(G, hash(p.id));
      p.body.label(p.track.state!.c);
      p.body.place(at, dt);
    }
    const names = draw.map((p) => p.track.state!.c);
    if (!note.hidden && t > noteUntil) note.hidden = true;
    // In Skirmish the line shows even when the yard is empty, so a player waiting for someone knows fighting is on.
    const text = names.length
      ? `Live${pvp ? " · PvP" : ""} · ${names.length} ${names.length === 1 ? "breacher" : "breachers"} in your yard: ${names.slice(0, 4).join(", ")}${names.length > 4 ? "…" : ""}`
      : pvp && playing() && net
        ? "Live · PvP · nobody else in the yard yet"
        : "";
    if (text !== shown) ((shown = text), (chip.textContent = text), (chip.hidden = !text));
  }

  let frame = 0;
  let prev = now();
  const loop = () => {
    if (stopped) return;
    const t = now();
    update(Math.min(0.1, Math.max(0, (t - prev) / 1000)));
    prev = t;
    frame = requestAnimationFrame(loop);
  };
  if (!opts.now) frame = requestAnimationFrame(loop);

  const squad: Squad = {
    here: () => [...peers.values()].filter((p) => p.body).map((p) => p.track.state!.c),
    get connected() {
      return !!net;
    },
    update,
    stop() {
      stopped = true;
      cancelAnimationFrame(frame);
      for (const id of [...peers.keys()]) drop(id);
      removeTarget?.();
      net?.leave();
      net = null;
      chip.remove();
      note.remove();
    },
  };
  G.squad = squad;
  return squad;
}
