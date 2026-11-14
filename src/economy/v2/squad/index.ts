// Live presence (G.squad): other breachers who are in a raid right now appear in your yard, moving as they move,
// with their callsign over their head.
//
// What this is: you see each other. Each browser tells the others where its player is ten times a second, directly
// (net.ts), and draws a figure for everyone it hears from (the opening film's figures, intro/figure.ts).
// What this is not: a shared raid. Your machines, your containers and your invoice are still yours alone; another
// breacher can't hit you, be hit, or take what you cut. Nothing here touches the chain.
//
// It is off for an automated browser (the smoke and end-to-end runs must not reach out to public relays) and with
// `?squad=0`; `?squad=1` forces it on.
import { createFigure, type Figure } from "../intro/figure";
import { LIMITS, Track, encode, nearest, sanitize } from "./model";
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
  connect?: Connect;
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

  const playing = () => G.game?.state === "playing";

  function connectOnce() {
    if (net || joining || stopped) return;
    joining = true;
    join(opts.room, {
      onState(peerId, raw) {
        const s = sanitize(raw);
        if (!s || typeof peerId !== "string" || peerId.length > 80) return;
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
    })
      .then((n) => (stopped ? n.leave() : (net = n)))
      .catch((e) => console.info("[squad] couldn't reach the other breachers:", (e as Error)?.message ?? e))
      .finally(() => (joining = false));
  }

  function drop(id: string) {
    const p = peers.get(id);
    if (!p) return;
    p.body?.dispose();
    peers.delete(id);
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
    const text = names.length ? `Live · ${names.length} ${names.length === 1 ? "breacher" : "breachers"} in your yard: ${names.slice(0, 4).join(", ")}${names.length > 4 ? "…" : ""}` : "";
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
      net?.leave();
      net = null;
      chip.remove();
    },
  };
  G.squad = squad;
  return squad;
}
