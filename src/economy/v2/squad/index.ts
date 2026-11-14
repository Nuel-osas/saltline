// Live presence (G.squad): other breachers who are in a raid right now appear in your yard, moving as they move,
// with their callsign over their head.
//
// What this is: you see each other. Each browser tells the others where its player is ten times a second, directly
// (net.ts), and draws a figure for everyone it hears from (the opening film's figures, intro/figure.ts), holding a
// rifle to the shoulder and pointing it where that player looks. The rounds they fire come with the same updates
// and are drawn as the game draws a machine's: a flash at the muzzle, a tracer, a gunshot from where they stand.
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
// `?squad=0`; `?squad=1` forces it on. `?room=name` puts the player in a private yard with whoever shares the link.
import { createFigure, type Figure } from "../intro/figure";
import { hooks } from "../../hooks";
import { HitGate, LIMITS, PVP, type Placed, Rate, Track, cleanDown, encode, nearest, privateRoom, rayHitsFigure, sanitize } from "./model";
import { type Connect, type Net, connect as realConnect } from "./net";
import "./squad.css";

/* eslint-disable @typescript-eslint/no-explicit-any -- the game context is the untyped bundle's G */
type Game = any;
type Obj = any;

export interface SquadOptions {
  /** The room: the chain game and Practice are separate yards. `?room=` in `search` makes it a private one. */
  room: string;
  callsign: () => string;
  /** The frame of the gun in hand, or "issue". */
  frame: () => string;
  /** Players can shoot each other. Only where the player chose it and nothing is at stake: Skirmish. */
  pvp?: boolean;
  /** The page's query string (default: this page's), read for `?room=`. */
  search?: string;
  connect?: Connect;
  /** Registers something this player's shots can hit (hooks.ts); tests give their own. */
  addShotTarget?: (fn: (origin: any, dir: any, max: number) => { dist: number } | null) => () => void;
  /** Builds a peer's figure; tests give a stand-in with no 3D. */
  body?: (G: Game, seed: number) => Body;
  now?: () => number;
}

export interface Body {
  place(p: Placed, dt: number): void;
  label(text: string): void;
  /** Where a round leaves the muzzle, in the world (and the rifle kicks); null if there is no rifle to fire. */
  muzzle(): { x: number; y: number; z: number } | null;
  /** A round has struck the figure. */
  flinch(): void;
  /** The figure falls where it stands and lies there. */
  fall(): void;
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
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const smooth = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

/** The rifle every breacher carries, in its own frame: the butt at the origin, the barrel along +z. Metres. */
const RIFLE: readonly { w: number; h: number; l: number; y: number; z: number; tilt?: number }[] = [
  { w: 0.045, h: 0.1, l: 0.2, y: -0.02, z: 0.1 }, // stock
  { w: 0.058, h: 0.085, l: 0.3, y: 0.015, z: 0.35 }, // receiver
  { w: 0.034, h: 0.15, l: 0.065, y: -0.09, z: 0.4, tilt: 0.25 }, // magazine
  { w: 0.032, h: 0.095, l: 0.04, y: -0.065, z: 0.235, tilt: -0.35 }, // grip
  { w: 0.052, h: 0.06, l: 0.27, y: 0.015, z: 0.635 }, // handguard
  { w: 0.022, h: 0.022, l: 0.2, y: 0.025, z: 0.86 }, // barrel
  { w: 0.034, h: 0.042, l: 0.07, y: 0.08, z: 0.38 }, // sight
];
const MUZZLE = { x: 0, y: 0.025, z: 0.97 };
/** Where the hands hold it, in its frame: the right on the grip, the left under the handguard (wrists). */
const GRIP_R = { x: 0, y: -0.085, z: 0.2 };
const GRIP_L = { x: 0, y: -0.045, z: 0.5 };
let rifleGeo: Obj[] | null = null;
let rifleMat: Obj = null;

/** A peer in the world: one of the film's figures holding a rifle to the shoulder, and a callsign over it. */
function figureBody(G: Game, seed: number): Body {
  const T = G.THREE;
  const fig: Figure = createFigure(G, { coat: COATS[seed % COATS.length], headlamp: true, seed });
  fig.root.name = "squad";
  fig.root.rotation.order = "YXZ"; // the heading, then a fall forward about the figure's own left-right axis
  G.scene.add(fig.root);
  rifleGeo ??= RIFLE.map((r) => {
    const g = new T.BoxGeometry(r.w, r.h, r.l);
    if (r.tilt) g.rotateX(r.tilt);
    return g.translate(0, r.y, r.z);
  });
  rifleMat ??= new T.MeshStandardMaterial({ color: 0x1b1d1f, roughness: 0.48, metalness: 0.55 });
  const gun = new T.Group();
  gun.name = "squad-rifle";
  for (const g of rifleGeo) {
    const m = new T.Mesh(g, rifleMat);
    m.castShadow = true;
    gun.add(m);
  }
  fig.root.add(gun);
  const handR = { x: 0, y: 0, z: 0 };
  const handL = { x: 0, y: 0, z: 0 };
  /** A point in the rifle's frame, in the figure's: turned by the rifle's pitch about x, then moved to where it sits. */
  const onGun = (l: { x: number; y: number; z: number }, out: { x: number; y: number; z: number }) => {
    const b = gun.rotation.x;
    out.x = gun.position.x + l.x;
    out.y = gun.position.y + l.y * Math.cos(b) - l.z * Math.sin(b);
    out.z = gun.position.z + l.y * Math.sin(b) + l.z * Math.cos(b);
    return out;
  };
  let tag: Obj = null;
  let text = "";
  let flinch = 0;
  let kick = 0;
  let falling = -1;
  let foot = 0;
  const cam = new T.Vector3();
  const near = () => (G.camera?.getWorldPosition ? G.camera.getWorldPosition(cam).distanceTo(fig.root.position) : Infinity);
  return {
    place(p, dt) {
      const r = fig.root;
      r.position.set(p.x, p.y, p.z);
      r.rotation.y = p.yaw + Math.PI; // the game's yaw 0 looks down −z; a figure's heading 0 faces +z
      flinch = Math.max(0, flinch - dt * 4.5);
      kick = Math.max(0, kick - dt * 14);
      const P = fig.p;
      if (falling >= 0) {
        // Dropped: the knees go, then the body pitches forward onto the ground, and stays.
        falling += dt;
        const t = clamp(falling / 0.8, 0, 1);
        P.walk = 0;
        P.idle = 0;
        P.crouch = 0.75 * smooth(t * 2.2);
        P.lean = 0.25 * t;
        r.rotation.x = (Math.PI / 2 - 0.12) * t * t;
        r.position.y = p.y + 0.13 * t;
      } else {
        P.walk = clamp(p.speed / 2.5, 0, 1);
        P.phase += (p.speed * dt) / Math.max(0.6, P.stride || 1.4);
        P.crouch = p.crouched ? 0.8 : 0;
        // A rifleman's stance: the left shoulder forward, the head turned back to look down the sights.
        P.twist = -0.35;
        P.headYaw = 0.33;
        P.headPitch = clamp(-p.pitch * 0.8, -0.8, 0.8);
        P.lean = 0.07 - 0.32 * flinch;
        P.tilt = 0.12 * flinch;
        P.swing = 0;
        r.rotation.x = 0;
        // A footstep each time a foot comes down (twice a stride), quieter with distance and when crouched. The
        // game's step sound has no position, so distance is all it can tell.
        const step = Math.floor(P.phase * 2);
        if (step !== foot) {
          foot = step;
          const d = near();
          if (P.walk > 0.25 && d < 18) G.audio?.play?.("step_concrete", { gain: 0.42 * (1 - d / 18) * (p.crouched ? 0.5 : 1), pitch: 0.92, jitter: 0.07 });
        }
      }
      // The butt sits in the right shoulder; the rifle points where they look, and jumps when a round goes or one lands.
      const h = fig.at.hips;
      gun.position.set(-0.11 + h.x * 0.6, h.y + 0.5 - 0.02 * flinch, -0.03 + h.z - 0.04 * kick);
      gun.rotation.x = clamp(-p.pitch, -1.2, 1.2) - 0.06 * kick - 0.3 * flinch;
      P.handR = onGun(GRIP_R, handR);
      P.handL = onGun(GRIP_L, handL);
      fig.update(dt);
      // The callsign fades with distance, and goes once they are down.
      if (tag) {
        const d = near();
        tag.material.opacity = falling >= 0 ? 0 : clamp(1 - (d - 28) / 22, 0, 1);
        tag.visible = tag.material.opacity > 0.02;
      }
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
    muzzle() {
      if (falling >= 0) return null;
      kick = 1;
      fig.root.updateMatrixWorld(true);
      return gun.localToWorld(new T.Vector3(MUZZLE.x, MUZZLE.y, MUZZLE.z));
    },
    flinch() {
      flinch = 1;
    },
    fall() {
      if (falling < 0) falling = 0;
    },
    dispose() {
      if (tag) (tag.material.map.dispose(), tag.material.dispose());
      G.scene.remove(fig.root);
      fig.dispose();
    },
  };
}

interface Peer {
  id: string;
  track: Track;
  body: Body | null;
  /** When each round they fired is drawn (this browser's clock). */
  shots: number[];
  /** Dropped: where they fell, when updates from them mean they are back, and when the figure leaves. */
  down: { at: Placed | null; standAfter: number; leaveAt: number } | null;
}

export function startSquad(G: Game, opts: SquadOptions): Squad {
  const now = opts.now ?? (() => performance.now());
  const join = opts.connect ?? realConnect;
  const makeBody = opts.body ?? figureBody;
  const room = privateRoom(opts.room, opts.search ?? (typeof location === "undefined" ? "" : location.search));
  const peers = new Map<string, Peer>();
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
  /** Rounds this player has fired since the last update went out. */
  let fired = 0;
  const pvp = !!opts.pvp;
  const gate = new HitGate();
  const shotRate = new Rate(PVP.maxShotsPerSecond);
  /** When this player last told each breacher they were hit, and when each last said they were down. */
  const lastHitOn = new Map<string, number>();
  const lastDown = new Map<string, number>();

  // The kill feed: two or three short lines at the top right that fade, as "ROOK dropped HALYARD".
  const feedEl = document.createElement("div");
  feedEl.className = "sq-feed";
  document.getElementById("ui")?.append(feedEl);
  const feed = (...parts: { t: string; name?: boolean }[]) => {
    const line = document.createElement("div");
    line.className = "sq-fl";
    for (const p of parts) {
      const el = document.createElement(p.name ? "b" : "span");
      el.textContent = p.t;
      line.append(el);
    }
    feedEl.append(line);
    while (feedEl.children.length > 3) feedEl.firstElementChild?.remove();
    setTimeout(() => line.classList.add("out"), 4200);
    setTimeout(() => line.remove(), 4800);
  };

  const playing = () => G.game?.state === "playing";
  const onFire = () => void (playing() && fired++);
  G.events?.on?.("weapon:fire", onFire);

  function connectOnce() {
    if (net || joining || stopped) return;
    joining = true;
    join(room, {
      onState(peerId, raw) {
        const s = sanitize(raw);
        if (!s || typeof peerId !== "string" || peerId.length > 80) return;
        const t = now();
        let p = peers.get(peerId);
        if (p?.down) {
          if (t < p.down.standAfter) return; // just dropped: their last updates in flight don't stand them up
          // Heard from again after that: back in a raid (or never really down). Stand them up where they are now.
          p.body?.dispose();
          peers.delete(peerId);
          p = undefined;
        }
        if (!p) {
          if (peers.size >= LIMITS.peers * 4) return; // a room far past what is drawn: stop taking new names
          p = { id: peerId, track: new Track(), body: null, shots: [], down: null };
          peers.set(peerId, p);
        }
        p.track.push(s, t);
        // The rounds fired since their last update, spread over the tenth of a second they came from; no more a
        // second than any gun fires, whatever the update says.
        for (let i = 0; i < s.s; i++) if (p.body && shotRate.take(peerId, t)) p.shots.push(t + 20 + (i * 1000) / LIMITS.sendHz / s.s);
      },
      onLeave(peerId) {
        if (!peers.get(peerId)?.down) drop(peerId); // a dropped figure lies where it fell for its time either way
      },
      // Another player says their shot met this one. This browser decides (HitGate); only in Skirmish.
      onHit(peerId, raw) {
        const p = peers.get(peerId);
        const pl = G.player;
        if (!pvp || !playing() || !p || p.down || !pl?.pos || p.track.stale(now())) return;
        const from = p.track.state!;
        const damage = gate.accept(peerId, raw, now(), Math.hypot(from.x - pl.pos.x, from.z - pl.pos.z));
        if (!damage) return;
        const src = G.THREE?.Vector3 ? new G.THREE.Vector3(from.x, from.y + 1.4, from.z) : { x: from.x, y: from.y + 1.4, z: from.z };
        pl.damage?.(damage, src); // the game's own: the red flash, the arrow toward them, the sound
        if (Number(pl.health) <= 0) {
          net?.ko(peerId);
          net?.down(peerId);
          feed({ t: from.c, name: true }, { t: " dropped " }, { t: "you", name: true });
        }
      },
      // A breacher says this player's hit dropped them. Believed only from someone this player has just hit: the
      // figure goes, so a player who could say it freely could make themselves impossible to see or shoot.
      onKo(peerId) {
        const p = peers.get(peerId);
        const hitAt = lastHitOn.get(peerId);
        if (!pvp || !p?.track.state || p.down || hitAt === undefined || now() - hitAt > PVP.koWithinMs) return;
        G.hud?.hitmarker?.("kill");
        layDown(p, [{ t: "You", name: true }, { t: " dropped " }, { t: p.track.state.c, name: true }]);
      },
      // A breacher tells everyone they were dropped, and by whom. Each browser lays the figure down and says so; if
      // updates keep coming from them after that, it wasn't true, and they stand straight back up (onState).
      onDown(peerId, raw) {
        const p = peers.get(peerId);
        const t = now();
        if (!pvp || !p?.track.state || p.down || t - (lastDown.get(peerId) ?? -Infinity) < PVP.downEveryMs) return;
        lastDown.set(peerId, t);
        const by = cleanDown(raw);
        const killer = by ? peers.get(by)?.track.state : undefined;
        const victim = p.track.state.c;
        const mine = !killer && t - (lastHitOn.get(peerId) ?? -Infinity) <= PVP.koWithinMs;
        if (mine) G.hud?.hitmarker?.("kill");
        layDown(
          p,
          killer
            ? [{ t: killer.c, name: true }, { t: " dropped " }, { t: victim, name: true }]
            : mine
              ? [{ t: "You", name: true }, { t: " dropped " }, { t: victim, name: true }]
              : [{ t: victim, name: true }, { t: " is down" }],
        );
      },
    })
      .then((n) => (stopped ? n.leave() : (net = n)))
      .catch((e) => console.info("[squad] couldn't reach the other breachers:", (e as Error)?.message ?? e))
      .finally(() => (joining = false));
  }

  /** A breacher was dropped: the figure falls where it stood, lies there a few seconds, then leaves. */
  function layDown(p: Peer, line: { t: string; name?: boolean }[]) {
    const t = now();
    p.down = { at: p.track.at(t), standAfter: t + PVP.downMs, leaveAt: t + PVP.lieMs };
    p.shots = [];
    lastHitOn.delete(p.id);
    p.body?.fall();
    feed(...line);
  }

  /** This player's round struck a breacher (the game chose them as the nearest thing on the ray): tell them. */
  function strike(id: string, head: boolean) {
    const p = peers.get(id);
    if (!pvp || !playing() || !net || !p || p.down) return;
    net.hit(id, Math.min(PVP.maxDamage, Math.round((Number(G.weapon?.damage) || 20) * (head ? PVP.headMult : 1))));
    lastHitOn.set(id, now());
    p.body?.flinch();
  }

  // This player's shots: the nearest drawn breacher the ray meets. What comes back is a hit the game treats as it
  // treats a machine's (game.js playerShot): its hit marker, its sparks and its impact sound, and `damage` called on
  // the one it chose as nearest, which is when the breacher is told.
  const removeTarget = pvp
    ? (opts.addShotTarget ?? ((fn) => hooks(G).addShotTarget(fn)))((origin, dir, max) => {
        if (!playing() || !net) return null;
        let best: { dist: number; head: boolean; id: string } | null = null;
        for (const p of peers.values()) {
          const at = p.body && !p.down ? p.track.at(now()) : null;
          const h: { dist: number; head: boolean } | null = at ? rayHitsFigure(origin, dir, best ? best.dist : max, at) : null;
          if (h) best = { ...h, id: p.id };
        }
        if (!best) return null;
        const V = G.THREE?.Vector3;
        const v3 = (x: number, y: number, z: number) => (V ? new V(x, y, z) : { x, y, z });
        const point = v3(origin.x + dir.x * best.dist, origin.y + dir.y * best.dist, origin.z + dir.z * best.dist);
        const { id, head } = best;
        return {
          dist: best.dist,
          point,
          normal: v3(-dir.x, -dir.y, -dir.z),
          part: head ? "weak" : "body",
          enemy: { type: "breacher", squad: true, alive: true, pos: point, damage: () => (strike(id, head), false) },
        };
      })
    : null;

  /** One round from a breacher, as the game draws a machine's: flash, tracer, light, a gunshot from where they stand. */
  function shotFx(p: Peer, at: Placed) {
    const V = G.THREE?.Vector3;
    const m = p.body?.muzzle();
    if (!V || !m) return;
    const cp = Math.cos(at.pitch);
    const dir = new V(-Math.sin(at.yaw) * cp, Math.sin(at.pitch), -Math.cos(at.yaw) * cp);
    const eye = new V(at.x, at.y + (at.crouched ? 1.15 : 1.6), at.z);
    let hit: Obj = null;
    try {
      hit = G.physics?.raycast?.(eye, dir, 200) ?? null;
    } catch {
      hit = null;
    }
    let dist = typeof hit?.dist === "number" ? hit.dist : 200;
    // A round that passes through this player ends at them (their own browser said whether it hit).
    const pl = G.player;
    let atMe = false;
    if (pl?.pos && pl.alive !== false) {
      const cx = pl.pos.x - eye.x,
        cy = pl.pos.y + 1 - eye.y,
        cz = pl.pos.z - eye.z;
      const along = cx * dir.x + cy * dir.y + cz * dir.z;
      if (along > 0 && along < dist && Math.hypot(cx - dir.x * along, cy - dir.y * along, cz - dir.z * along) < 0.5) ((dist = along), (atMe = true));
    }
    const mz = new V(m.x, m.y, m.z);
    const end = eye.clone().addScaledVector(dir, dist);
    try {
      G.fx?.muzzleFlash?.(mz, dir, { scale: 0.9 });
      G.fx?.tracer?.(mz, end, { color: 0xffc070, speed: 260, width: 0.03 });
      G.render?.lightPool?.flash?.(mz, 0xffb060, 22, 7, 0.05);
      G.audio?.play?.("hound_fire", { pos: { x: mz.x, y: mz.y, z: mz.z }, gain: 1, jitter: 0.04 });
      // Where it lands: the game's puff, sound and, past this player's head, the whiz of a near miss.
      if (pvp && hit?.point && !atMe) G.events?.emit?.("impact", { point: hit.point, normal: hit.normal, dist: hit.dist, surface: hit.surface, enemy: null, dir, from: "enemy" });
    } catch (e) {
      console.warn("[squad] shot", e);
    }
  }

  function drop(id: string) {
    const p = peers.get(id);
    if (!p) return;
    p.body?.dispose();
    peers.delete(id);
    lastHitOn.delete(id);
    shotRate.forget(id);
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
        const shots = Math.min(LIMITS.shotsPerUpdate, fired);
        fired = 0;
        net.send(encode({ callsign: opts.callsign(), x: pl.pos.x, y: pl.pos.y || 0, z: pl.pos.z, yaw: pl.yaw || 0, pitch: pl.pitch || 0, speed, crouched: !!pl.crouching, frame: opts.frame(), shots }));
      }
    } else fired = 0;
    // The dropped lie where they fell until their time is up; everyone else still heard from is drawn, nearest
    // first; the rest lose their figure, and the silent are forgotten.
    for (const p of [...peers.values()]) if (p.down ? t >= p.down.leaveAt : p.track.stale(t)) drop(p.id);
    const me = { x: pl?.pos?.x ?? 0, z: pl?.pos?.z ?? 0 };
    const standing = [...peers.values()].filter((p) => !p.down);
    const draw = playing() ? nearest(standing, me, t) : [];
    const drawn = new Set(draw);
    for (const p of peers.values()) {
      if (p.down) {
        if (p.body && p.down.at && playing()) p.body.place(p.down.at, dt);
        else if (p.body) (p.body.dispose(), (p.body = null));
        continue;
      }
      if (!drawn.has(p)) {
        if (p.body) (p.body.dispose(), (p.body = null));
        p.shots = [];
        continue;
      }
      const at = p.track.at(t);
      if (!at) continue;
      p.body ??= makeBody(G, hash(p.id));
      p.body.label(p.track.state!.c);
      p.body.place(at, dt);
      while (p.shots.length && p.shots[0] <= t) (p.shots.shift(), shotFx(p, at));
    }
    const names = draw.map((p) => p.track.state!.c);
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
    here: () => [...peers.values()].filter((p) => p.body && !p.down).map((p) => p.track.state!.c),
    get connected() {
      return !!net;
    },
    update,
    stop() {
      stopped = true;
      cancelAnimationFrame(frame);
      for (const id of [...peers.keys()]) drop(id);
      removeTarget?.();
      G.events?.off?.("weapon:fire", onFire);
      net?.leave();
      net = null;
      chip.remove();
      feedEl.remove();
    },
  };
  G.squad = squad;
  return squad;
}
