// The opening film's stage: every shot is a camera move through the live scene, with a cast of generated dock
// workers (figure.ts) and the drop point's props (props.ts). film.ts owns the clock and the overlay; this file frames
// film time `t` and nothing else, so any moment can be shown by seeking to it.
//
// The drop point is laid out in the player's own frame (so many metres ahead of the start, so many to the right), so
// it follows the level's start wherever that is. The water and the yard are shot in the level's own coordinates.
/* eslint-disable @typescript-eslint/no-explicit-any -- three.js and the game context come from the untyped bundle */
import { createModel } from "../../bailiff/model";
import type { Body, Pose as BailiffPose } from "../../bailiff/types";
import { type Figure, createFigure } from "./figure";
import type { Stage } from "./film";
import { DROP, createProps } from "./props";
import { LENS_AT, MARKS, MARKS_OFF, SHOTS, locate } from "./timeline";

type Obj = any;

export interface FilmStage extends Stage {
  /** After a film that held a raid: keep the camera at the player's start until the raid begins. */
  park(on: boolean): void;
  /** True while parked (the camera is the stage's). */
  parked(dt: number): boolean;
  dispose(): void;
}

const smooth = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const clamp01 = (t: number) => (t < 0 ? 0 : t > 1 ? 1 : t);
/** Keys [[time, value], …]: the value at `t`, eased between keys. */
function key(t: number, ks: number[][]): number {
  if (t <= ks[0][0]) return ks[0][1];
  for (let i = 1; i < ks.length; i++) {
    if (t < ks[i][0]) {
      const a = ks[i - 1],
        b = ks[i];
      return a[1] + (b[1] - a[1]) * smooth((t - a[0]) / (b[0] - a[0]));
    }
  }
  return ks[ks.length - 1][1];
}
/** A Catmull-Rom point through rows of [x, y, z, …] at u in 0–1. */
function spline(rows: number[][], u: number, off: number, out: Obj): Obj {
  const L = rows.length - 1;
  const s = clamp01(u) * L;
  const i = Math.min(L - 1, Math.floor(s));
  const k = s - i;
  const a = rows[Math.max(0, i - 1)],
    b = rows[i],
    c = rows[i + 1],
    d = rows[Math.min(L, i + 2)];
  const f = (j: number) => 0.5 * (2 * b[j] + (-a[j] + c[j]) * k + (2 * a[j] - 5 * b[j] + 4 * c[j] - d[j]) * k * k + (-a[j] + 3 * b[j] - 3 * c[j] + d[j]) * k * k * k);
  return out.set(f(off), f(off + 1), f(off + 2));
}

const PARK_SECONDS = 12;

export function createStage(G: Obj): FilmStage {
  const T = G.THREE;
  const cam = G.camera;
  const props = createProps(G);
  const start = G.level?.playerStart ?? { pos: { x: -32, y: 0, z: 6 }, yaw: -Math.PI / 2 };
  const yaw0 = Number(start.yaw) || 0;
  const O = { x: start.pos.x, y: start.pos.y || 0, z: start.pos.z };
  const fw = { x: -Math.sin(yaw0), z: -Math.cos(yaw0) };
  const rt = { x: -fw.z, z: fw.x };
  /** A point `f` metres ahead of the player's start and `r` to its right. */
  const at = (f: number, r: number, y = 0, out: Obj = new T.Vector3()) => out.set(O.x + fw.x * f + rt.x * r, O.y + y, O.z + fw.z * f + rt.z * r);
  /** rotation.y for something whose +z should point `f` ahead and `r` right. */
  const face = (f: number, r: number) => Math.atan2(fw.x * f + rt.x * r, fw.z * f + rt.z * r);
  const sfx = (name: string, o: Record<string, unknown> = {}) => {
    try {
      G.audio?.play?.(name, o);
    } catch {
      /* sound is never load-bearing */
    }
  };

  // ---- the drop point: built once, kept after the film ----
  const drop = new T.Group();
  drop.name = "intro-drop";
  G.scene.add(drop);
  const crate = props.longCrate();
  const supply = props.supply();
  const lamp = props.lamp();
  const coil = props.coil();
  drop.add(crate.root, supply, lamp.root, coil);
  const CRATE_YAW = face(-1, 0) + 0.05;
  const CRATE_FROM = { f: 4.1, r: 0.05 },
    CRATE_TO = { f: 2, r: 0 };
  const SUPPLY_AT = { f: 6.75, r: -2.2 };
  const colliders: Obj[] = [];
  function settle() {
    at(CRATE_TO.f, CRATE_TO.r, 0, crate.root.position);
    crate.root.rotation.set(0, CRATE_YAW, 0);
    crate.setLid(1);
    at(SUPPLY_AT.f, SUPPLY_AT.r, 0, supply.position);
    supply.rotation.set(0, face(-0.27, -1), 0);
    at(SUPPLY_AT.f, SUPPLY_AT.r, 0.5 + 0.196, lamp.root.position);
    lamp.root.rotation.set(0, 0, 0);
    at(3.2, -2.75, 0, coil.position);
    drop.visible = true;
  }
  settle();
  DROP.crate = { x: crate.root.position.x, y: crate.root.position.y, z: crate.root.position.z };
  DROP.yaw = CRATE_YAW;
  DROP.rifle = crate.rifle;
  DROP.ready = true;
  try {
    for (const o of [crate.root, supply]) {
      o.updateWorldMatrix(true, true);
      const b = new T.Box3().setFromObject(o);
      if (o === crate.root) b.max.y = O.y + DROP.size.high; // the shut height: the open lid is no wall
      const c = G.physics?.addBox?.(b.min, b.max, { surface: "wood", tag: "intro", noNav: true });
      if (c) colliders.push(c);
    }
  } catch {
    /* without colliders the props are scenery */
  }

  // ---- the cast and the film's own props: made in begin(), gone in end() ----
  interface Cast {
    moss: Figure;
    lampy: Figure;
    coiler: Figure;
    front: Figure;
    rear: Figure;
    bow: Figure;
    stern: Figure;
    all: Figure[];
    line: Obj;
    arm: Obj;
    glints: Obj;
    bailiff: Body | null;
    light: Obj;
    marks: HTMLElement[];
  }
  let cast: Cast | null = null;
  let layer: HTMLElement | null = null;
  let shot = -1;
  let fired = new Set<string>();
  let saved: { fov: number; boat: Obj; boatRot: Obj; lampParent: Obj } | null = null;
  let parkT = 0;
  let offState: (() => void) | null = null;

  const A = new T.Vector3(),
    B = new T.Vector3(),
    C = new T.Vector3(),
    P = new T.Vector3(),
    Lk = new T.Vector3();
  const Yax = new T.Vector3(0, 1, 0);
  let clock = 0;

  /** A polyline over the ground a figure walks: where it is `s` metres along, and which way it is going. */
  function path(pts: Obj[]) {
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + pts[i].distanceTo(pts[i - 1]));
    const len = cum[cum.length - 1];
    const pos = (s: number, out: Obj) => {
      s = Math.min(len, Math.max(0, s));
      let i = 1;
      while (i < pts.length - 1 && cum[i] < s) i++;
      return out.lerpVectors(pts[i - 1], pts[i], (s - cum[i - 1]) / Math.max(1e-6, cum[i] - cum[i - 1]));
    };
    const a = new T.Vector3(),
      b = new T.Vector3();
    /** rotation.y along the path at `s`, looking a little ahead so corners are turned, not snapped. */
    const heading = (s: number) => {
      pos(s - 0.35, a);
      pos(s + 0.45, b);
      if (a.distanceToSquared(b) < 1e-6) (pos(len - 0.5, a), pos(len, b));
      return Math.atan2(b.x - a.x, b.z - a.z);
    };
    return { len, pos, heading };
  }
  /** A point in the world, in a figure's own frame (for its hands and feet). */
  const local = (fig: Figure, world: Obj) => {
    fig.root.updateMatrixWorld(true);
    const v = fig.root.worldToLocal(C.copy(world));
    return { x: v.x, y: v.y, z: v.z };
  };
  /** The camera for this frame, with a breath of hand-held drift. */
  function shoot(pos: Obj, look: Obj, fov: number, drift = 1) {
    const t = clock;
    cam.position.set(pos.x + Math.sin(t * 0.83) * 0.016 * drift, pos.y + Math.sin(t * 1.07 + 1.7) * 0.012 * drift, pos.z + Math.sin(t * 0.71 + 0.6) * 0.016 * drift);
    cam.lookAt(look.x + Math.sin(t * 0.47 + 2) * 0.03 * drift, look.y + Math.sin(t * 0.59) * 0.022 * drift, look.z);
    cam.rotation.z += Math.sin(t * 0.37) * 0.004 * drift;
    if (Math.abs(cam.fov - fov) > 0.01) ((cam.fov = fov), cam.updateProjectionMatrix());
    const post = G.render?.post;
    if (post) post.fade = 0;
  }
  const once = (id: string, fn: () => void) => {
    if (fired.has(id)) return;
    fired.add(id);
    fn();
  };

  // ---- the walks at the drop point (set up in begin, once the level's frame is known) ----
  const carryPath = path([at(8.7, 4.9), at(7.7, 1.2), at(SUPPLY_AT.f, SUPPLY_AT.r)]);
  const mossPath = path([at(4.72, 0.02), at(3.7, -0.12), at(2.78, -0.08)]);
  const lampPath = path([at(5.3, 2.6), at(4.4, 2.45), at(3.45, 2.0)]);
  const MOSS_WALK = [1.3, 3.3];
  const KICK = 3.62;

  function begin(marksLayer: HTMLElement) {
    layer = marksLayer;
    clock = 0;
    shot = -1;
    fired = new Set();
    parkT = 0;
    const boat = G.backdrop?.boat;
    saved = { fov: cam.fov, boat: boat ? boat.position.clone() : null, boatRot: boat ? boat.rotation.clone() : null, lampParent: lamp.root.parent };
    const fig = (coat: number, o: object = {}) => {
      const f = createFigure(G, { coat, ...o });
      G.scene.add(f.root);
      f.root.visible = false;
      return f;
    };
    const moss = fig(0x2b2409, { bulk: 1.1, height: 1.02, seed: 1 }); // a dirty yellow oilskin: the one you can pick out
    const lampy = fig(0x0c0f10, { seed: 2, height: 0.98 });
    const coiler = fig(0x0e1412, { seed: 3, bulk: 1.05 });
    const front = fig(0x0b0d10, { seed: 4 });
    const rear = fig(0x100e0c, { seed: 5, bulk: 1.06, height: 1.03 });
    const bow = fig(0x0b0e0f, { seed: 6 });
    const stern = fig(0x0f100c, { seed: 7, bulk: 1.05 });
    // The coiler's line: from the working hand down to the coil at their feet.
    const rope = props.mat("rope");
    const line = new T.Mesh(new T.CylinderGeometry(0.014, 0.014, 1, 5).translate(0, 0.5, 0), rope);
    const arm = new T.Mesh(new T.TorusGeometry(0.15, 0.022, 5, 12), rope);
    arm.scale.set(1, 1.5, 1);
    G.scene.add(line, arm);
    line.visible = arm.visible = false;

    // Sealed containers catch the light: a handful of glints over the stacks.
    const spots: number[] = [];
    const ph: number[] = [];
    for (const c of G.level?.placed ?? []) {
      if (!/^container/.test(String(c.name)) || c.y > 0.5 || c.x < -24 || c.x > 26 || c.z < -9 || c.z > 22) continue;
      if (spots.length >= 14 * 3) break;
      const yaw = Number(c.yaw) || 0;
      const half = c.name === "container20" ? 3.03 : 6.08;
      spots.push(c.x + Math.cos(yaw) * half, (c.y || 0) + 1.35, c.z - Math.sin(yaw) * half);
      ph.push((spots.length / 3) * 0.37);
    }
    const gg = new T.BufferGeometry();
    gg.setAttribute("position", new T.Float32BufferAttribute(spots, 3));
    gg.setAttribute("aPh", new T.Float32BufferAttribute(ph, 1));
    const glints = new T.Points(
      gg,
      new T.ShaderMaterial({
        uniforms: { uT: { value: 0 }, uGain: { value: 0 } },
        vertexShader: `attribute float aPh; uniform float uT; uniform float uGain; varying float vK;
          void main() { vK = pow(max(0.0, sin(uT * 2.3 - aPh * 6.0)), 10.0) * uGain;
            vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * mv; gl_PointSize = (60.0 + 260.0 * vK) / max(1.0, -mv.z) * 6.0; }`,
        fragmentShader: `varying float vK; void main() { vec2 p = gl_PointCoord - 0.5; float d = length(p);
            float star = max(0.0, 1.0 - d * 2.0); star = star * star * star + 0.5 * max(0.0, 1.0 - abs(p.y) * 30.0) * max(0.0, 1.0 - abs(p.x) * 2.0);
            gl_FragColor = vec4(vec3(1.0, 0.82, 0.55) * star * vK * 2.2, 1.0); }`,
        transparent: true,
        blending: T.AdditiveBlending,
        depthWrite: false,
        depthTest: true,
        toneMapped: false,
      }),
    );
    glints.frustumCulled = false;
    glints.visible = false;
    glints.renderOrder = 5;
    G.scene.add(glints);

    // What waits in the shed: the Bailiff's own body, standing still. It shows nothing until its first pose.
    let bailiff: Body | null = null;
    try {
      bailiff = createModel(G, { x: -3.6, z: -18.2 });
    } catch (e) {
      console.warn("[intro] no Bailiff for the shed", e);
    }
    let light: Obj = null;
    try {
      light = G.render?.lightPool?.acquire?.() ?? null;
      if (light?.light) ((light.light.distance = 7.5), light.light.color.setRGB(1, 0.62, 0.26), (light.light.intensity = 0));
    } catch {
      light = null;
    }
    const marks = MARKS.map((m, i) => {
      const el = marksLayer.ownerDocument.createElement("div");
      el.className = "in-mark";
      el.innerHTML = `<i></i><span><b>${String.fromCharCode(65 + i)}</b>${m.label}</span>`;
      marksLayer.appendChild(el);
      return el;
    });
    cast = { moss, lampy, coiler, front, rear, bow, stern, all: [moss, lampy, coiler, front, rear, bow, stern], line, arm, glints, bailiff, light, marks };

    try {
      G.score?.hold?.("infiltrate");
    } catch {
      /* the title's music plays on */
    }
    if (!offState) {
      const off = G.events?.on?.("game:state", (e: Obj) => e?.state !== "title" && (parkT = 0));
      offState = typeof off === "function" ? off : null;
    }
  }

  /** What is on set in shot `i`. */
  function enter(i: number) {
    if (!cast || !saved) return;
    shot = i;
    const id = SHOTS[i]?.id;
    const dropScene = id === "drop" || id === "crate";
    for (const f of [cast.moss, cast.lampy, cast.coiler, cast.front, cast.rear]) f.root.visible = dropScene;
    cast.line.visible = cast.arm.visible = dropScene;
    cast.bow.root.visible = cast.stern.root.visible = id === "water";
    cast.glints.visible = id === "objective";
    drop.visible = id !== "water";
    const boat = G.backdrop?.boat;
    if (boat && id !== "water" && saved.boat) (boat.position.copy(saved.boat), boat.rotation.copy(saved.boatRot));
    if (!dropScene) {
      settle();
      if (cast.light?.light) cast.light.light.intensity = 0;
    }
    if (id !== "objective") for (const m of cast.marks) m.classList.remove("on");
  }

  // ---- shot 1: the water ----
  const SEA_FROM = { x: 80, z: 57 },
    SEA_TO = { x: 43.5, z: 28.5 };
  function water(tl: number, dt: number) {
    const c = cast!;
    const boat = G.backdrop?.boat;
    const u = tl / SHOTS[0].seconds;
    const k = lerp(u, smooth(u), 0.35) * 0.96;
    const dx = SEA_TO.x - SEA_FROM.x,
      dz = SEA_TO.z - SEA_FROM.z;
    const d = Math.hypot(dx, dz);
    const ux = dx / d,
      uz = dz / d;
    const bx = SEA_FROM.x + dx * k,
      bz = SEA_FROM.z + dz * k;
    const sea = Number(G.ground?.seaHeight?.(bx, bz)) || -1.6;
    if (boat) {
      boat.position.x = bx;
      boat.position.z = bz;
      // Its bow is its +x; it rides a little bow-up and rolls with the chop.
      boat.rotation.set(Math.sin(clock * 1.9) * 0.035, Math.atan2(-uz, ux), 0.06 + Math.sin(clock * 2.6 + 1) * 0.022);
      boat.updateMatrixWorld(true);
      // Two aboard, low in the boat: one at the tiller, one forward, watching the quay come up.
      const seats: [Figure, number, number, number][] = [
        [c.stern, -2.35, 0.42, -0.5],
        [c.bow, 0.55, -0.38, 0.35],
      ];
      for (const [f, x, z, turn] of seats) {
        boat.localToWorld(P.set(x, 0.3, z));
        f.root.position.copy(P);
        f.root.rotation.y = Math.atan2(ux, uz) + turn * 0.3;
        f.p.crouch = 0.92;
        f.p.lean = 0.3 + Math.sin(clock * 1.9 + x) * 0.04;
        f.p.walk = 0;
        f.p.headYaw = -turn * 0.5 + Math.sin(clock * 0.4 + x) * 0.15;
        f.p.headPitch = -0.12;
        f.p.footL = { x: 0.13, y: 0.0, z: 0.34 };
        f.p.footR = { x: -0.13, y: 0.0, z: 0.3 };
        f.p.handL = { x: 0.2, y: 0.52, z: 0.36 };
        f.p.handR = f === c.stern ? { x: -0.42, y: 0.62, z: -0.12 } : { x: -0.2, y: 0.5, z: 0.38 };
        f.update(dt);
      }
      // Its wake.
      if (Math.floor(clock * 9) !== Math.floor((clock - dt) * 9)) {
        try {
          G.fx?.splash?.(new T.Vector3(bx - ux * 4.6 + (Math.random() - 0.5) * 0.9, sea + 0.02, bz - uz * 4.6 + (Math.random() - 0.5) * 0.9), 0.55);
        } catch {
          /* decoration */
        }
      }
    }
    // Low over the water, behind and off its quarter, falling back as it runs in.
    const back = lerp(8.5, 12.5, smooth(u));
    const side = lerp(3.6, 2.2, u);
    P.set(bx - ux * back - uz * side, sea + lerp(0.95, 1.25, u) + Math.sin(clock * 1.15) * 0.05, bz - uz * back + ux * side);
    Lk.set(bx + ux * 10, sea + lerp(2.4, 3.4, u), bz + uz * 10);
    shoot(P, Lk, 40, 2.2);
    once("horn", () => sfx("foghorn", { pos: [cam.position.x - 60, 8, cam.position.z - 40], ref: 300, pitch: 0.78, gain: 0.5, jitter: 0 }));
  }

  // ---- shots 2 and 3: the drop point. One clock (`td`) runs through both, so the cut joins moving people. ----
  function people(td: number, dt: number) {
    const c = cast!;
    const t3 = td - SHOTS[1].seconds; // seconds into the crate shot (negative before it)

    // The long crate: where Moss's boot leaves it, then a slide across the wet concrete that dies away.
    const slide = clamp01((t3 - 0.72) / 1.7);
    const e = 1 - Math.pow(1 - slide, 3);
    at(lerp(CRATE_FROM.f, CRATE_TO.f, e), lerp(CRATE_FROM.r, CRATE_TO.r, e), 0, crate.root.position);
    crate.root.rotation.y = CRATE_YAW - 0.05 + 0.05 * e + Math.sin(slide * 9) * 0.012 * (1 - slide);
    const x = t3 - KICK;
    crate.setLid(x <= 0 ? 0 : 1 - Math.exp(-5.5 * x) * Math.cos(8.5 * x));
    if (slide > 0 && slide < 0.85 && Math.floor(clock * 14) !== Math.floor((clock - dt) * 14)) {
      try {
        G.fx?.splash?.(A.copy(crate.root.position).add(B.set(-fw.x * 0.25, 0.02, -fw.z * 0.25)), 0.35 * (1 - slide));
      } catch {
        /* decoration */
      }
    }

    // ---- Moss: a boot up on the crate, the shove, the walk round to its end, the kick ----
    {
      const f = c.moss;
      const p = f.p;
      const walkU = clamp01((t3 - MOSS_WALK[0]) / (MOSS_WALK[1] - MOSS_WALK[0]));
      const s = mossPath.len * lerp(walkU, smooth(walkU), 0.7);
      const speed = t3 > MOSS_WALK[0] && t3 < MOSS_WALK[1] ? 1 : 0;
      mossPath.pos(s, f.root.position);
      const turned = smooth((t3 - (MOSS_WALK[1] - 0.45)) / 0.6);
      const walkYaw = walkU > 0 ? mossPath.heading(s) : face(-1, 0);
      const endYaw = face(-1, 0.06);
      f.root.rotation.y = walkYaw + Math.atan2(Math.sin(endYaw - walkYaw), Math.cos(endYaw - walkYaw)) * turned;
      p.stride = 1.42;
      p.phase = s / p.stride;
      p.walk = speed * smooth(walkU / 0.12) * smooth((1 - walkU) / 0.14);
      p.swing = 0.8;
      if (t3 < MOSS_WALK[0]) {
        // The boot on the crate, a forearm on that knee; then the shove.
        const push = key(t3, [[0.5, 0], [0.92, 1], [1.3, 0]]);
        const down = smooth((t3 - 0.95) / 0.35);
        p.footR = { x: -0.11, y: lerp(0.36, 0, down) + Math.sin(down * Math.PI) * 0.08, z: lerp(lerp(0.52, 0.98, push), 0.06, down) };
        p.footL = { x: 0.1, y: 0, z: -0.04 };
        p.lean = 0.2 + 0.16 * push - 0.14 * down;
        p.handR = down < 0.3 ? { x: -0.15, y: 0.78, z: 0.4 + 0.1 * push } : null;
        p.handL = null;
        p.headYaw = t3 < 0 ? 0.3 * Math.sin(td * 0.55 + 1) : 0;
        p.headPitch = t3 < 0 ? 0.05 : 0.25 * push;
        p.twist = 0.12;
      } else if (t3 < MOSS_WALK[1]) {
        p.footL = p.footR = p.handL = p.handR = null;
        p.lean = 0.07;
        p.twist = 0;
        p.headYaw = 0.25 * Math.sin(walkU * Math.PI);
        p.headPitch = 0.22;
      } else {
        // Square to the crate's end: wind up, kick the latch, stand over what's in it, then look at the newcomer.
        const k = t3 - MOSS_WALK[1];
        const wind = key(k, [[0, 0], [0.2, 1], [0.34, 0]]);
        const hit = key(k, [[0.2, 0], [0.35, 1], [0.6, 1], [0.95, 0]]);
        p.footL = { x: 0.11, y: 0, z: -0.02 };
        p.footR = { x: -0.1, y: 0.1 * wind + 0.16 * hit, z: -0.32 * wind + 0.46 * hit };
        p.pitchR = 0.5 * wind - 0.35 * hit;
        p.lean = 0.04 - 0.12 * hit + 0.1 * smooth((k - 1) / 0.8);
        p.twist = -0.1 * hit;
        const gesture = key(t3, [[4.3, 0], [4.8, 1], [5.6, 1], [6.3, 0]]);
        p.handR = gesture > 0.01 ? { x: -0.3 - 0.06 * gesture, y: lerp(0.62, 0.86, gesture), z: lerp(0.06, 0.34, gesture) } : null;
        p.handL = null;
        p.headPitch = lerp(0.46, 0.2, smooth((t3 - 8.1) / 0.8));
        p.headYaw = 0.12 * Math.sin(t3 * 0.5);
      }
      f.update(dt);
      if (t3 > 0.7) once("shove", () => (sfx("container_bang", { pos: [cam.position.x + fw.x * 2, 0.5, cam.position.z + fw.z * 2], pitch: 1.7, gain: 0.3 }), sfx("step_water", { gain: 0.6 })));
      if (t3 > KICK) once("kick", () => (sfx("impact_wood", { gain: 0.9, pitch: 0.8 }), sfx("reload_bolt", { gain: 0.8, pitch: 0.85 })));
    }

    // ---- the two with the supply crate: in step with its weight, across the lane, then down with it ----
    {
      const s = Math.min(carryPath.len, 0.34 + 0.69 * td);
      const moving = clamp01((carryPath.len - s) / 0.45);
      const set = td - (carryPath.len - 0.34) / 0.69; // seconds since they stopped
      const lower = key(set, [[0.25, 0], [1.5, 1]]);
      const rise = smooth((set - 1.9) / 1.1);
      const yawC = carryPath.heading(s);
      const ux = Math.sin(yawC),
        uz = Math.cos(yawC);
      carryPath.pos(s, P);
      const carried = 0.42 * (1 - lower) + 0.012 * Math.sin((s / 0.98) * Math.PI * 4) * moving;
      const held = set < 2;
      if (held) {
        supply.position.set(P.x, O.y + carried, P.z);
        supply.rotation.set(0, yawC, Math.sin(s * 3.1) * 0.02 * moving);
      } else {
        at(SUPPLY_AT.f, SUPPLY_AT.r, 0, supply.position);
        supply.rotation.set(0, yawC, 0);
      }
      const pair: [Figure, number, number][] = [
        [c.front, 0.36 + 0.36, 0],
        [c.rear, -(0.36 + 0.37), 0.47],
      ];
      for (const [f, ahead, ph] of pair) {
        const p = f.p;
        f.root.position.set(P.x + ux * ahead, O.y, P.z + uz * ahead);
        f.root.rotation.y = yawC + (held ? 0 : (ahead > 0 ? 2.4 : -0.5) * rise);
        p.stride = 0.98;
        p.phase = s / p.stride + ph;
        p.walk = moving;
        p.swing = 0;
        p.crouch = 0.62 * lower * (1 - rise);
        p.lean = (ahead > 0 ? 0.1 : -0.03) + 0.5 * lower * (1 - rise);
        p.tilt = 0.02 * Math.sin((s / p.stride) * Math.PI * 2 + ph * 6);
        p.headPitch = 0.1 + 0.2 * lower * (1 - rise);
        p.headYaw = held ? 0 : 0.3 * rise;
        if (held) {
          // Both hands on the rope handle at their end of it.
          const hy = supply.position.y + 0.5;
          const end = Math.sign(ahead) * 0.39;
          for (const side of [1, -1]) {
            A.set(supply.position.x + ux * end - uz * side * -0.17, hy, supply.position.z + uz * end + ux * side * -0.17);
            const h = local(f, A);
            if (side > 0) p.handL = h;
            else p.handR = h;
          }
        } else p.handL = p.handR = null;
        p.footL = p.footR = null;
        f.update(dt);
      }
    }

    // ---- the lamp: waved slowly overhead to bring the boat's people in, then carried over to light the crate ----
    {
      const f = c.lampy;
      const p = f.p;
      const go = clamp01((t3 - 0.2) / 2.5);
      const s = lampPath.len * lerp(go, smooth(go), 0.7);
      lampPath.pos(s, f.root.position);
      const toCrate = face(-1.45, -2);
      const walkYaw = go > 0 ? lampPath.heading(s) : face(-1, -0.18);
      const turned = smooth((go - 0.8) / 0.2);
      f.root.rotation.y = walkYaw + Math.atan2(Math.sin(toCrate - walkYaw), Math.cos(toCrate - walkYaw)) * turned;
      p.stride = 1.25;
      p.phase = s / p.stride;
      p.walk = go > 0 && go < 1 ? smooth(go / 0.12) * smooth((1 - go) / 0.15) : 0;
      const w = td * Math.PI * 2 * 0.42;
      const wave = 1 - smooth((t3 + 0.5) / 0.9);
      const hold = smooth((go - 0.75) / 0.25);
      const wx = -0.2 + 0.36 * Math.sin(w),
        wy = 1.9 + 0.05 * Math.cos(2 * w);
      const cx = -0.3,
        cy = 1.02,
        cz = 0.24;
      const hx = -0.2,
        hy = 1.2 + Math.sin(td * 0.9) * 0.012,
        hz = 0.5;
      const lx = lerp(cx, hx, hold),
        ly = lerp(cy, hy, hold),
        lz = lerp(cz, hz, hold);
      p.handR = { x: lerp(lx, wx, wave), y: lerp(ly, wy, wave), z: lerp(lz, 0.1, wave) };
      p.handL = null;
      p.swing = 0.6;
      p.tilt = 0.07 * Math.sin(w) * wave;
      p.twist = 0.1 * Math.sin(w) * wave;
      p.lean = 0.02 + 0.1 * hold;
      p.headPitch = 0.3 * hold - 0.08 * wave;
      p.headYaw = 0.2 * Math.sin(td * 0.37) * wave;
      f.update(dt);
      // The lamp hangs from that hand; its light goes with it.
      f.world(f.at.handR, lamp.root.position);
      lamp.root.position.y -= 0.03;
      lamp.root.rotation.set(Math.sin(w) * 0.25 * wave, 0, Math.cos(w) * 0.3 * wave + Math.sin(f.p.phase * Math.PI * 2) * 0.1 * p.walk);
      if (c.light?.light) {
        c.light.light.position.copy(lamp.root.position).y -= 0.12;
        c.light.light.intensity = (5.5 + Math.sin(clock * 23) * 0.25 + Math.sin(clock * 7.3) * 0.3) * (0.8 + 0.5 * hold);
      }
    }

    // ---- the line: wound hand over elbow, one turn after another ----
    {
      const f = c.coiler;
      const p = f.p;
      at(3.05, -3.25, 0, f.root.position);
      f.root.rotation.y = face(-0.75, 0.75);
      const w = td * Math.PI * 2 * 0.72;
      p.walk = 0;
      p.handL = { x: 0.2, y: 1.1, z: 0.3 };
      p.handR = { x: -0.06 + 0.2 * Math.cos(w), y: 0.98 + 0.25 * Math.sin(w), z: 0.33 + 0.06 * Math.sin(w) };
      p.twist = 0.09 * Math.cos(w);
      p.tilt = 0.03 * Math.sin(w);
      p.lean = 0.1 + 0.03 * Math.sin(w + 1);
      p.headPitch = 0.3;
      p.headYaw = key(td, [[5.5, 0], [6.4, -0.75], [8.6, -0.75], [9.4, 0], [14, 0], [15, 0.7], [20, 0.7]]);
      p.footL = { x: 0.14, y: 0, z: 0.1 };
      p.footR = { x: -0.13, y: 0, z: -0.12 };
      f.update(dt);
      f.world(f.at.handR, A);
      at(3.2, -2.75, 0.1, B);
      c.line.position.copy(A);
      c.line.quaternion.setFromUnitVectors(Yax, C.subVectors(B, A).normalize());
      c.line.scale.set(1, A.distanceTo(B), 1);
      // The turns already made hang from the other forearm.
      f.world(f.at.handL, A);
      c.arm.position.set(A.x, A.y - 0.16, A.z);
      c.arm.rotation.set(0, f.root.rotation.y + 0.3, 0);
    }
  }

  function dropShot(tl: number, dt: number) {
    people(tl, dt);
    // From the gate, low, looking down the lane into the dawn: everyone is a shape against it.
    const u = smooth(tl / SHOTS[1].seconds);
    at(lerp(-4.0, -3.05, u), lerp(-1.25, -0.85, u), lerp(1.16, 1.3, u), P);
    at(4.8, lerp(0.5, 0.2, u), 1.1, Lk);
    shoot(P, Lk, 37, 1.6);
    once("halyard", () => sfx("halyard", { gain: 0.5 }));
  }

  function crateShot(tl: number, dt: number) {
    people(SHOTS[1].seconds + tl, dt);
    // From where the player will stand: the crate comes to the lens, then the lens goes to what is in it.
    at(key(tl, [[0, -0.9], [3.6, -0.6], [11.5, 0.86]]), key(tl, [[0, 0.95], [3.6, 0.85], [11.5, 0.3]]), key(tl, [[0, 0.42], [3.6, 0.55], [11.5, 1.42]]), P);
    at(key(tl, [[0, 3.6], [2.4, 2.4], [11.5, 2.04]]), key(tl, [[0, -0.2], [3.6, -0.15], [11.5, 0]]), key(tl, [[0, 0.75], [3.6, 0.6], [11.5, 0.16]]), Lk);
    shoot(P, Lk, key(tl, [[0, 42], [3.6, 42], [11.5, 33]]), 1.2);
    // The lamp's light is brought over the open crate, so the rifle is lit by something in the scene.
    const c = cast!;
    if (c.light?.light) {
      const over = smooth((tl - KICK) / 1.6);
      at(CRATE_TO.f - 0.25, 0.25, 0.85, A);
      c.light.light.position.lerp(A, over);
      c.light.light.intensity *= 1 + 0.9 * over;
    }
  }

  // ---- shot 4: the objective. From the crane, down over the yard, to the shed door. ----
  const FLY = [
    // x, y, z, then where it looks
    [47, 37, 27, 14, 0, 0],
    [32, 29, 22, 6, 0, -4],
    [14, 17.5, 11.5, -2, 1, -11],
    [1.5, 8.5, 3.5, -3, 2, -15],
    [-3.3, 2.5, -4.4, -3.4, 2.5, -17],
    [-3.5, 2.2, -8.4, -3.6, 2.9, -18.2],
  ];
  const BAILIFF_AT = { x: -3.6, z: -18.2 };
  function objective(tl: number, dt: number) {
    const c = cast!;
    const u = tl / SHOTS[3].seconds;
    const k = lerp(u, smooth(u), 0.55);
    spline(FLY, k, 0, P);
    spline(FLY, k, 3, Lk);
    shoot(P, Lk, lerp(46, 38, smooth(u)), 0.8);

    // The uplinks, one by one, each with its tone.
    const w = layer?.clientWidth || window.innerWidth,
      h = layer?.clientHeight || window.innerHeight;
    cam.updateMatrixWorld(true);
    const objs: Obj[] = G.level?.objectives ?? [];
    MARKS.forEach((m, i) => {
      const el = c.marks[i];
      const o = objs.find((x) => x.id === m.id) ?? objs[i];
      const on = !!o && tl >= m.at && tl < MARKS_OFF;
      if (on) {
        A.set(o.pos.x, (o.pos.y || 0) + 1.5, o.pos.z).project(cam);
        const vis = A.z < 1 && Math.abs(A.x) < 1.05 && Math.abs(A.y) < 1.05;
        el.style.transform = `translate(${((A.x * 0.5 + 0.5) * w).toFixed(1)}px, ${((-A.y * 0.5 + 0.5) * h).toFixed(1)}px)`;
        el.classList.toggle("on", vis);
        once("mark" + i, () => sfx("objective", { gain: 0.5, pitch: 0.9 + i * 0.12 }));
      } else el.classList.remove("on");
    });

    // Sealed containers catch the light as the camera comes down over them.
    c.glints.material.uniforms.uT.value = tl;
    c.glints.material.uniforms.uGain.value = key(tl, [[4.2, 0], [5, 1], [7.6, 1], [8.6, 0]]);

    // In the shed: something tall, standing still, and one lens that opens.
    if (c.bailiff) {
      const open = tl >= LENS_AT;
      const pose: BailiffPose = {
        x: BAILIFF_AT.x,
        y: 0.03,
        z: BAILIFF_AT.z,
        yaw: 0.12,
        state: "walking",
        speed: 0,
        up: 1,
        kneel: 0,
        raise: 0,
        strike: 0,
        lens: open ? "amber" : "dark",
        flare: open ? key(tl, [[LENS_AT, 0.9], [LENS_AT + 0.7, 0.25], [LENS_AT + 2.9, 0.4]]) : 0,
        look: open ? { x: cam.position.x, y: cam.position.y, z: cam.position.z } : null,
      };
      c.bailiff.update(dt, pose);
      if (open) once("lens", () => (sfx("telegraph", { gain: 0.8, pitch: 0.55 }), sfx("alert", { gain: 0.35, pitch: 0.5 })));
    }
  }

  function frame(t: number, dt: number) {
    if (!cast) return;
    clock += dt;
    const w = locate(t);
    if (w.index !== shot) enter(w.index);
    switch (w.shot?.id) {
      case "water":
        return water(w.local, dt);
      case "drop":
        return dropShot(w.local, dt);
      case "crate":
        return crateShot(w.local, dt);
      case "objective":
        return objective(w.local, dt);
      case "title":
        once("slam", () => (sfx("container_bang", { gain: 0.9, pitch: 0.55 }), sfx("foghorn", { pos: [cam.position.x + 120, 8, cam.position.z + 60], ref: 300, gain: 0.45, pitch: 0.6, jitter: 0 })));
        return playerView();
    }
  }

  /** The player's own view from the start: where the film cuts to. */
  function playerView() {
    P.set(O.x, O.y + 1.62, O.z);
    at(10, 0, 1.5, Lk);
    shoot(P, Lk, saved?.fov ?? 50, 0);
  }

  function end() {
    const c = cast;
    cast = null;
    if (c) {
      for (const f of c.all) f.dispose();
      for (const o of [c.line, c.arm, c.glints]) {
        o.removeFromParent();
        o.geometry?.dispose?.();
      }
      c.glints.material.dispose();
      try {
        c.bailiff?.dispose();
      } catch {
        /* already gone */
      }
      try {
        c.light?.release?.();
      } catch {
        /* already back in the pool */
      }
      for (const m of c.marks) m.remove();
    }
    if (saved) {
      const boat = G.backdrop?.boat;
      if (boat && saved.boat) (boat.position.copy(saved.boat), boat.rotation.copy(saved.boatRot));
      if (Math.abs(cam.fov - saved.fov) > 0.01) ((cam.fov = saved.fov), cam.updateProjectionMatrix());
      saved = null;
    }
    settle();
    shot = -1;
    layer = null;
    try {
      G.score?.hold?.(null);
    } catch {
      /* the score follows the game by itself */
    }
  }

  return {
    begin,
    frame,
    end,
    park(on) {
      parkT = on ? PARK_SECONDS : 0;
    },
    parked(dt) {
      if (parkT <= 0 || G.game?.state !== "title") return ((parkT = 0), false);
      parkT -= dt;
      playerView();
      return true;
    },
    dispose() {
      end();
      offState?.();
      offState = null;
      for (const c of colliders) {
        try {
          G.physics?.removeBox?.(c);
        } catch {
          /* the physics module went away */
        }
      }
      drop.removeFromParent();
      DROP.ready = false;
      DROP.rifle = null;
    },
  };
}
