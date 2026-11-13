// A dock worker for the opening film: a figure of human proportion (about seven and a half heads) in oilskins,
// generated in code. A hip-length jacket with a short storm cape over the shoulders, a fitted hood, trousers and
// small rounded boots; the arms hang outside the cape and end in gloved hands, so carrying, waving and coiling read
// in silhouette. Reflective bands (chest, cuffs, ankles) and, on some, a headlamp are what pick a worker out against
// the dawn.
//
// Under the cloth is a plain skeleton of joints (hips, knees, ankles, shoulders, elbows, wrists) placed by a walk
// that plants its feet, by two-bone reaches for the arms and legs, and by a standing sway that shifts the weight
// from foot to foot. Each figure is TWO meshes whatever its pose: the body and the bands. Their parts are rigid
// pieces whose vertices are written into one buffer each frame from the joints.
//
// Local frame: +y up, +z the way the figure faces, +x its left. Metres.
/* eslint-disable @typescript-eslint/no-explicit-any -- three.js comes from the untyped bundle (G.THREE) */
type Obj = any;
export interface V {
  x: number;
  y: number;
  z: number;
}

const HIP_Y = 0.92;
const HIP_X = 0.085;
const THIGH = 0.43;
const SHIN = 0.42;
const ANKLE = 0.075;
const SHOULDER = { x: 0.185, y: 0.5 };
const UPPER = 0.29;
const FORE = 0.26;
const NECK = 0.585;
/** The fraction of a stride a foot spends on the ground. */
const STANCE = 0.62;

export interface Pose {
  /** The stride's phase, 0–1 over two steps: distance walked / stride. */
  phase: number;
  /** 0 standing, 1 walking. */
  walk: number;
  /** Metres for two steps. */
  stride: number;
  /** Forward lean, radians. */
  lean: number;
  /** Lean to the figure's left, radians. */
  tilt: number;
  /** The shoulders' turn to the left, radians. */
  twist: number;
  /** 0 upright, 1 squatting. */
  crouch: number;
  headYaw: number;
  headPitch: number;
  /** How far the arms swing with the walk (1 natural). */
  swing: number;
  /** How much a standing figure shifts its weight from foot to foot (1 natural, 0 held still, as when seated). */
  idle: number;
  /** Wrist targets in the figure's frame, or null for the arm's own swing. */
  handL: V | null;
  handR: V | null;
  /** Sole targets in the figure's frame, or null for the walk's own step. */
  footL: V | null;
  footR: V | null;
  /** The feet's toe-down pitch when a foot is placed by hand. */
  pitchL: number;
  pitchR: number;
}

export interface Figure {
  readonly root: Obj;
  readonly p: Pose;
  /** The wrists, the head and the hips after the last update, in the figure's frame. */
  readonly at: { handL: V; handR: V; head: V; hips: V };
  update(dt: number): void;
  /** A point in the figure's frame, in the world. */
  world(local: V, out: Obj): Obj;
  dispose(): void;
}

export interface FigureOptions {
  /** The oilskin's colour. */
  coat?: number;
  /** 1 is 1.76 m. */
  height?: number;
  /** 1 average; more is broader. */
  bulk?: number;
  /** A headlamp on the hood's brow. */
  headlamp?: boolean;
  /** A hard hat under the hood: its peak shows at the front. */
  hat?: boolean;
  seed?: number;
}

const smooth = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const frac = (x: number) => x - Math.floor(x);

const BONES = ["torso", "head", "armUL", "armFL", "armUR", "armFR", "legUL", "legFL", "legUR", "legFR", "bootL", "bootR"] as const;
type Bone = (typeof BONES)[number];
interface Piece {
  bone: Bone;
  g: Obj;
  c: Obj;
}
interface Skin {
  mesh: Obj;
  geo: Obj;
  bindP: Float32Array;
  bindN: Float32Array;
  pos: Obj;
  nrm: Obj;
  ranges: { bone: Bone; start: number; count: number }[];
}

/** The oilskin: one wet, dark, slightly glossy surface, tinted per vertex (jacket, trousers, boots, gloves). */
let bodyMat: Obj = null;
/** The reflective bands and the headlamp: they give back more light than falls on them, so they are unlit. */
let bandMat: Obj = null;

export function createFigure(G: Obj, opts: FigureOptions = {}): Figure {
  const T = G.THREE;
  bodyMat ??= new T.MeshStandardMaterial({ vertexColors: true, roughness: 0.36, metalness: 0, envMapIntensity: 0.8, side: T.DoubleSide });
  bandMat ??= new T.MeshBasicMaterial({ vertexColors: true, toneMapped: true, side: T.DoubleSide });
  const bulk = opts.bulk ?? 1;
  const coatC = new T.Color(opts.coat ?? 0x0e1112);
  const legC = new T.Color(0x0a0b0c);
  const darkC = new T.Color(0x030303);
  const bootC = new T.Color(0x070707);
  const gloveC = new T.Color(0x2b261c);
  const hatC = new T.Color(0x5e4d10);
  const bandC = new T.Color(0.62, 0.58, 0.36);
  const lampC = new T.Color(4.2, 3.6, 2.4);

  // ---- the pieces, each in its bone's frame ----
  const body: Piece[] = [];
  const bands: Piece[] = [];
  const lathe = (pts: number[][], sz: number, seg = 16) => {
    const g = new T.LatheGeometry(
      pts.map(([r, y]) => new T.Vector2(r * bulk, y)),
      seg,
    );
    g.scale(1, 1, sz);
    return g;
  };
  /** A limb segment along +y from 0 to `len`, tapered, with a ball at its root to fill the joint. */
  const limb = (bone: Bone, len: number, r0: number, r1: number, c: Obj) => {
    body.push({ bone, g: new T.CylinderGeometry(r1 * bulk, r0 * bulk, len, 9, 1).translate(0, len / 2, 0), c });
    body.push({ bone, g: new T.SphereGeometry(r0 * bulk * 1.03, 9, 6), c });
  };
  /** A reflective band round a limb, `y` along it. */
  const band = (bone: Bone, r: number, y: number, h = 0.032, sz = 1) => bands.push({ bone, g: new T.CylinderGeometry(r * bulk, r * bulk, h, 12, 1, true).scale(1, 1, sz).translate(0, y, 0), c: bandC });

  // The jacket: shoulders, a waist, a hem at the hip. A short storm cape sits on the shoulders; the arms hang clear.
  body.push({ bone: "torso", g: lathe([[0.2, -0.19], [0.202, -0.08], [0.178, 0.06], [0.16, 0.17], [0.176, 0.3], [0.198, 0.42], [0.188, 0.5], [0.115, 0.558], [0.066, 0.6]], 0.64), c: coatC });
  body.push({ bone: "torso", g: lathe([[0.238, 0.385], [0.23, 0.47], [0.16, 0.548], [0.07, 0.605]], 0.68), c: coatC });
  band("torso", 0.19, 0.335, 0.042, 0.655);
  // The head under a fitted hood: narrower than the shoulders, a dark opening where the face is, a neck.
  const hs = opts.hat ? 1.09 : 1;
  body.push({ bone: "head", g: new T.SphereGeometry(0.114 * hs, 14, 10).scale(1, 1.12, 1.1).translate(0, 0.125, -0.008), c: coatC });
  body.push({ bone: "head", g: new T.SphereGeometry(0.086, 12, 8).scale(0.86, 1.04, 0.5).translate(0, 0.115, 0.078 * hs), c: darkC });
  body.push({ bone: "head", g: new T.CylinderGeometry(0.066, 0.1, 0.1, 10, 1).translate(0, 0.0, -0.006), c: coatC });
  if (opts.hat) body.push({ bone: "head", g: new T.CylinderGeometry(0.118, 0.125, 0.016, 14, 1).scale(1, 1, 1.25).translate(0, 0.19, 0.04), c: hatC });
  if (opts.headlamp) bands.push({ bone: "head", g: new T.SphereGeometry(0.021, 8, 6).translate(0, 0.205, 0.118 * hs), c: lampC });
  for (const s of ["L", "R"] as const) {
    limb(`armU${s}`, UPPER, 0.062, 0.05, coatC);
    limb(`armF${s}`, FORE, 0.05, 0.041, coatC);
    body.push({ bone: `armF${s}`, g: new T.SphereGeometry(0.043, 8, 6).scale(0.8, 1.4, 1.02).translate(0, FORE + 0.048, 0), c: gloveC });
    band(`armF${s}`, 0.049, FORE - 0.04);
    limb(`legU${s}`, THIGH, 0.084, 0.062, legC);
    limb(`legF${s}`, SHIN, 0.06, 0.044, legC);
    band(`legF${s}`, 0.051, SHIN - 0.085);
    // A small rounded boot: a shaft at the ankle and a toe ahead of it.
    body.push({ bone: `boot${s}`, g: new T.SphereGeometry(0.058, 10, 7).scale(0.9, 0.78, 2.0).translate(0, -ANKLE + 0.046, 0.048), c: bootC });
    body.push({ bone: `boot${s}`, g: new T.CylinderGeometry(0.047, 0.052, 0.1, 9, 1).translate(0, 0.0, -0.004), c: bootC });
  }

  // ---- one buffer for the body and one for the bands ----
  function skin(pieces: Piece[], mat: Obj, shadow: boolean): Skin {
    pieces.sort((a, b) => BONES.indexOf(a.bone) - BONES.indexOf(b.bone));
    let total = 0;
    for (const p of pieces) total += p.g.attributes.position.count;
    const bindP = new Float32Array(total * 3),
      bindN = new Float32Array(total * 3),
      col = new Float32Array(total * 3);
    const index: number[] = [];
    const ranges: Skin["ranges"] = [];
    let o = 0;
    for (const { bone, g, c } of pieces) {
      const n = g.attributes.position.count;
      bindP.set(g.attributes.position.array, o * 3);
      bindN.set(g.attributes.normal.array, o * 3);
      for (let i = 0; i < n; i++) ((col[(o + i) * 3] = c.r), (col[(o + i) * 3 + 1] = c.g), (col[(o + i) * 3 + 2] = c.b));
      const idx = g.index.array;
      for (let i = 0; i < idx.length; i++) index.push(idx[i] + o);
      const last = ranges[ranges.length - 1];
      if (last && last.bone === bone) last.count += n;
      else ranges.push({ bone, start: o, count: n });
      o += n;
      g.dispose();
    }
    const geo = new T.BufferGeometry();
    const pos = new T.BufferAttribute(new Float32Array(total * 3), 3);
    const nrm = new T.BufferAttribute(new Float32Array(total * 3), 3);
    pos.setUsage(T.DynamicDrawUsage);
    nrm.setUsage(T.DynamicDrawUsage);
    geo.setAttribute("position", pos);
    geo.setAttribute("normal", nrm);
    geo.setAttribute("color", new T.BufferAttribute(col, 3));
    geo.setAttribute("uv", new T.BufferAttribute(new Float32Array(total * 2), 2));
    geo.setIndex(index);
    geo.boundingSphere = new T.Sphere(new T.Vector3(0, 0.9, 0), 1.7);
    geo.boundingBox = new T.Box3(new T.Vector3(-1.2, -0.2, -1.2), new T.Vector3(1.2, 2.2, 1.2));
    const mesh = new T.Mesh(geo, mat);
    mesh.castShadow = shadow;
    mesh.receiveShadow = shadow;
    return { mesh, geo, bindP, bindN, pos, nrm, ranges };
  }
  const skins = [skin(body, bodyMat, true), skin(bands, bandMat, false)];
  skins[0].mesh.name = "worker";
  skins[1].mesh.name = "worker-bands";
  const root = new T.Group();
  root.name = "intro-figure";
  root.scale.setScalar(opts.height ?? 1);
  root.add(skins[0].mesh, skins[1].mesh);
  const M = Object.fromEntries(BONES.map((b) => [b, new T.Matrix4()])) as Record<Bone, Obj>;

  const p: Pose = { phase: 0, walk: 0, stride: 1.3, lean: 0, tilt: 0, twist: 0, crouch: 0, headYaw: 0, headPitch: 0, swing: 1, idle: 1, handL: null, handR: null, footL: null, footR: null, pitchL: 0, pitchR: 0 };
  const at = { handL: { x: 0, y: 0, z: 0 }, handR: { x: 0, y: 0, z: 0 }, head: { x: 0, y: 1.6, z: 0 }, hips: { x: 0, y: HIP_Y, z: 0 } };

  // ---- scratch ----
  const v = () => new T.Vector3();
  const A = v(),
    B = v(),
    C = v(),
    D = v(),
    dir = v(),
    pole = v(),
    mid = v(),
    end = v();
  const Y = new T.Vector3(0, 1, 0);
  const q = new T.Quaternion(),
    qt = new T.Quaternion(),
    qh = new T.Quaternion();
  const e = new T.Euler();
  const one = new T.Vector3(1, 1, 1);
  const torso = M.torso;
  const seedT = (opts.seed ?? 1) * 1.37;
  let time = 0;

  /** Two bones from `a` toward `t`: writes the middle joint to `mid` and the reachable end to `end`. */
  function reach(a: Obj, t: Obj, l1: number, l2: number, poleDir: Obj) {
    dir.subVectors(t, a);
    let d = dir.length();
    const max = (l1 + l2) * 0.998,
      min = Math.abs(l1 - l2) + 0.02;
    if (d < 1e-5) (dir.set(0, -1, 0), (d = min));
    dir.multiplyScalar(1 / d);
    d = Math.min(max, Math.max(min, d));
    end.copy(a).addScaledVector(dir, d);
    const k = (l1 * l1 - l2 * l2 + d * d) / (2 * d);
    const h = Math.sqrt(Math.max(0, l1 * l1 - k * k));
    pole.copy(poleDir).addScaledVector(dir, -poleDir.dot(dir));
    if (pole.lengthSq() < 1e-6) pole.set(0, 0, 1).addScaledVector(dir, -dir.z);
    pole.normalize();
    mid.copy(a).addScaledVector(dir, k).addScaledVector(pole, h);
  }
  /** A segment's frame: at `a`, its +y toward `b`. */
  function bone(name: Bone, a: Obj, b: Obj) {
    dir.subVectors(b, a).normalize();
    q.setFromUnitVectors(Y, dir);
    M[name].compose(a, q, one);
  }

  /** One foot's step from the walk: where its sole is in the figure's frame, and its toe-down pitch. */
  function step(side: number, off: number, out: Obj): number {
    const ph = frac(p.phase + off);
    const L = p.stride;
    let z: number,
      lift = 0,
      pitch: number;
    if (ph < STANCE) {
      z = L * (STANCE / 2 - ph); // planted: it goes back exactly as the body goes forward
      pitch = ph < 0.1 ? -0.22 * (1 - ph / 0.1) : 0.5 * smooth((ph - 0.44) / (STANCE - 0.44));
    } else {
      const u = (ph - STANCE) / (1 - STANCE);
      z = lerp(-L * (STANCE / 2), L * (STANCE / 2), smooth(u));
      lift = Math.sin(Math.PI * Math.min(1, u * 1.08)) * (0.07 + 0.035 * L);
      pitch = lerp(0.5, -0.22, smooth(u * 1.15));
    }
    const w = p.walk;
    out.set(side * lerp(0.105, 0.08, w), lift * w, lerp(side * 0.03, z, w));
    return pitch * w;
  }

  function update(dt: number) {
    time += dt;
    const w = p.walk;
    const still = (1 - w) * p.idle;
    // Standing: the weight goes from one foot to the other and back, and the chest rises with the breath.
    const shift = (Math.sin(time * 0.43 + seedT) + 0.35 * Math.sin(time * 0.97 + seedT * 2.1)) * 0.034 * still;
    const breath = Math.sin(time * 1.55 + seedT) * 0.012;

    // ---- the hips ride on the legs: lowest as a heel comes down, over the standing foot ----
    const bob = -0.026 * w * Math.cos(4 * Math.PI * p.phase);
    const hipsY = HIP_Y - 0.34 * p.crouch + bob - 0.012 * (1 - w) - Math.abs(shift) * 0.35;
    const hipsX = 0.03 * w * Math.sin(2 * Math.PI * (p.phase - 0.06)) + shift;
    const hipsZ = -0.1 * p.crouch;
    const gaitTwist = 0.1 * w * Math.sin(2 * Math.PI * (p.phase - 0.25)) * Math.min(1, p.swing);
    A.set(hipsX, hipsY, hipsZ);
    e.set(p.lean + 0.03 * w + breath, p.twist - gaitTwist + shift * 1.2, -p.tilt - shift * 1.6 + 0.02 * w * Math.sin(2 * Math.PI * (p.phase - 0.06)), "YXZ");
    qt.setFromEuler(e);
    torso.compose(A, qt, one);
    at.hips.x = hipsX;
    at.hips.y = hipsY;
    at.hips.z = hipsZ;

    // ---- the head, under its hood: it stays level as the body leans, and drifts a little by itself ----
    B.set(0, NECK, 0).applyMatrix4(torso);
    e.set(p.headPitch - p.lean * 0.55 + 0.05 * w * Math.cos(4 * Math.PI * p.phase), p.headYaw + gaitTwist * 0.7 - shift * 1.2 + Math.sin(time * 0.31 + seedT * 3) * 0.07 * still, shift * 1.2, "YXZ");
    qh.setFromEuler(e);
    q.copy(qt).multiply(qh);
    M.head.compose(B, q, one);
    C.set(0, 0.125, 0).applyQuaternion(q).add(B);
    at.head.x = C.x;
    at.head.y = C.y;
    at.head.z = C.z;

    // ---- legs ----
    for (const s of [1, -1]) {
      const n = s > 0 ? "L" : "R";
      const set = s > 0 ? p.footL : p.footR;
      let pitch: number;
      if (set) (C.set(set.x, set.y, set.z), (pitch = s > 0 ? p.pitchL : p.pitchR));
      else pitch = step(s, s > 0 ? 0 : 0.5, C);
      C.y += ANKLE + 0.12 * Math.max(0, Math.sin(pitch)); // the heel lifts round the ball of the foot
      A.set(hipsX + s * HIP_X, hipsY, hipsZ);
      D.set(s * 0.16, 0.05, 1);
      reach(A, C, THIGH, SHIN, D);
      bone(`legU${n}`, A, mid);
      bone(`legF${n}`, mid, end);
      e.set(pitch, s * 0.12 * (1 - w), 0, "YXZ");
      q.setFromEuler(e);
      M[`boot${n}`].compose(end, q, one);
    }

    // ---- arms ----
    for (const s of [1, -1]) {
      const n = s > 0 ? "L" : "R";
      const set = s > 0 ? p.handL : p.handR;
      A.set(s * SHOULDER.x * bulk, SHOULDER.y, 0).applyMatrix4(torso);
      if (set) C.set(set.x, set.y, set.z);
      else {
        // The arm opposite the forward leg comes forward; the elbow gives as it does.
        const th = s * 0.44 * w * p.swing * Math.sin(2 * Math.PI * (p.phase - 0.25)) + 0.07;
        const len = (UPPER + FORE) * (0.972 - 0.06 * Math.max(0, Math.sin(th)));
        C.set(s * 0.07, -Math.cos(th) * len, Math.sin(th) * len + 0.02)
          .applyQuaternion(qt)
          .add(A);
      }
      D.set(s * 0.45, -0.25, -1);
      reach(A, C, UPPER, FORE, D);
      bone(`armU${n}`, A, mid);
      bone(`armF${n}`, mid, end);
      const h = s > 0 ? at.handL : at.handR;
      h.x = end.x;
      h.y = end.y;
      h.z = end.z;
    }

    // ---- write every piece's vertices from its bone ----
    for (const sk of skins) {
      const P = sk.pos.array as Float32Array,
        N = sk.nrm.array as Float32Array,
        bp = sk.bindP,
        bn = sk.bindN;
      for (const r of sk.ranges) {
        const m = M[r.bone].elements;
        for (let i = r.start * 3, n = (r.start + r.count) * 3; i < n; i += 3) {
          const x = bp[i],
            y = bp[i + 1],
            z = bp[i + 2];
          P[i] = m[0] * x + m[4] * y + m[8] * z + m[12];
          P[i + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
          P[i + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
          const a = bn[i],
            b = bn[i + 1],
            c = bn[i + 2];
          N[i] = m[0] * a + m[4] * b + m[8] * c;
          N[i + 1] = m[1] * a + m[5] * b + m[9] * c;
          N[i + 2] = m[2] * a + m[6] * b + m[10] * c;
        }
      }
      sk.pos.needsUpdate = true;
      sk.nrm.needsUpdate = true;
    }
  }

  update(0);
  return {
    root,
    p,
    at,
    update,
    world(local, out) {
      return root.localToWorld(out.set(local.x, local.y, local.z));
    },
    dispose() {
      root.removeFromParent();
      for (const sk of skins) sk.geo.dispose();
    },
  };
}
