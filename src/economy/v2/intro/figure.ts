// A dock worker for the opening film: a figure of human proportion in a hooded oilskin, generated in code. The coat,
// a shoulder cape and the hood hide the anatomy; under them is a plain skeleton of joints (hips, knees, ankles,
// shoulders, elbows, wrists) placed by a walk that plants its feet and by two-bone reaches for the arms and legs.
//
// Each figure is ONE mesh: its parts (coat, hood, limb segments, boots) are rigid pieces whose vertices are written
// into one buffer every frame from the joints, so a worker costs one draw call however it is posed.
//
// Local frame: +y up, +z the way the figure faces, +x its left. Metres.
/* eslint-disable @typescript-eslint/no-explicit-any -- three.js comes from the untyped bundle (G.THREE) */
type Obj = any;
export interface V {
  x: number;
  y: number;
  z: number;
}

const HIP_Y = 0.93;
const HIP_X = 0.095;
const THIGH = 0.44;
const SHIN = 0.44;
const ANKLE = 0.09;
const SHOULDER = { x: 0.205, y: 0.47 };
const UPPER = 0.3;
const FORE = 0.3;
const NECK = 0.56;
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
  /** 1 is 1.78 m. */
  height?: number;
  /** 1 average; more is broader. */
  bulk?: number;
  seed?: number;
}

const smooth = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const frac = (x: number) => x - Math.floor(x);

interface Part {
  start: number;
  count: number;
  m: Obj;
}

/** The oilskin: one wet, dark, slightly glossy surface, tinted per vertex (coat, boots, gloves, the hood's dark). */
let sharedMat: Obj = null;
function material(T: Obj): Obj {
  if (!sharedMat) sharedMat = new T.MeshStandardMaterial({ vertexColors: true, roughness: 0.34, metalness: 0.0, envMapIntensity: 0.8, side: T.DoubleSide });
  return sharedMat;
}

export function createFigure(G: Obj, opts: FigureOptions = {}): Figure {
  const T = G.THREE;
  const bulk = opts.bulk ?? 1;
  const coatC = new T.Color(opts.coat ?? 0x161a19);
  const darkC = new T.Color(0x070808);
  const bootC = new T.Color(0x0b0c0c);

  // ---- the parts, each in its own frame ----
  const geos: { g: Obj; c: Obj }[] = [];
  const parts: Record<string, Part> = {};
  let total = 0;
  const part = (name: string, pieces: { g: Obj; c: Obj }[]) => {
    const start = total;
    for (const p of pieces) {
      geos.push(p);
      total += p.g.attributes.position.count;
    }
    parts[name] = { start, count: total - start, m: new T.Matrix4() };
  };
  const lathe = (pts: number[][], sz: number, seg = 14) => {
    const g = new T.LatheGeometry(
      pts.map(([r, y]) => new T.Vector2(r * bulk, y)),
      seg,
    );
    g.scale(1, 1, sz);
    return g;
  };
  /** A limb segment along +y from 0 to `len`, with a ball at its root to fill the joint. */
  const seg = (len: number, r0: number, r1: number, c: Obj, tip = 0) => {
    const out = [
      { g: new T.CylinderGeometry(r1 * bulk, r0 * bulk, len, 8, 1).translate(0, len / 2, 0), c },
      { g: new T.SphereGeometry(r0 * bulk * 1.04, 8, 6), c },
    ];
    if (tip) out.push({ g: new T.SphereGeometry(tip, 8, 6).scale(0.85, 1.25, 1).translate(0, len + tip * 0.6, 0), c: darkC });
    return out;
  };

  // The coat hangs from the shoulders to the knee, a little wider at the hem; the cape sits over the shoulders.
  part("coat", [
    { g: lathe([[0.31, -0.53], [0.29, -0.34], [0.25, -0.05], [0.228, 0.18], [0.24, 0.38], [0.228, 0.5], [0.12, 0.57]], 0.7), c: coatC },
    { g: lathe([[0.325, 0.2], [0.315, 0.33], [0.26, 0.5], [0.11, 0.6]], 0.76), c: coatC },
  ]);
  // The hood: a shell drawn forward over a dark hollow where a face would be, and a drape down onto the cape.
  part("hood", [
    { g: new T.SphereGeometry(0.152, 14, 10).scale(1.04, 1.2, 1.24).translate(0, 0.16, -0.012), c: coatC },
    { g: new T.SphereGeometry(0.112, 12, 8).scale(0.92, 1.1, 0.7).translate(0, 0.135, 0.105), c: darkC },
    { g: new T.CylinderGeometry(0.15, 0.255 * bulk, 0.21, 12, 1).scale(1, 1, 0.86).translate(0, 0.035, -0.012), c: coatC },
  ]);
  for (const s of ["L", "R"]) {
    part("armU" + s, seg(UPPER, 0.07, 0.06, coatC));
    part("armF" + s, seg(FORE, 0.058, 0.05, coatC, 0.048));
    part("legU" + s, seg(THIGH, 0.088, 0.07, bootC));
    part("legF" + s, seg(SHIN, 0.068, 0.058, bootC));
    part("boot" + s, [{ g: new T.BoxGeometry(0.105, 0.115, 0.275).translate(0, -0.035, 0.062), c: bootC }]);
  }

  // ---- one buffer for all of it ----
  const bindP = new Float32Array(total * 3),
    bindN = new Float32Array(total * 3),
    col = new Float32Array(total * 3);
  const index: number[] = [];
  let o = 0;
  for (const { g, c } of geos) {
    const n = g.attributes.position.count;
    bindP.set(g.attributes.position.array, o * 3);
    bindN.set(g.attributes.normal.array, o * 3);
    for (let i = 0; i < n; i++) ((col[(o + i) * 3] = c.r), (col[(o + i) * 3 + 1] = c.g), (col[(o + i) * 3 + 2] = c.b));
    const idx = g.index.array;
    for (let i = 0; i < idx.length; i++) index.push(idx[i] + o);
    o += n;
    g.dispose();
  }
  const geo = new T.BufferGeometry();
  const posA = new T.BufferAttribute(new Float32Array(total * 3), 3);
  const nrmA = new T.BufferAttribute(new Float32Array(total * 3), 3);
  posA.setUsage(T.DynamicDrawUsage);
  nrmA.setUsage(T.DynamicDrawUsage);
  geo.setAttribute("position", posA);
  geo.setAttribute("normal", nrmA);
  geo.setAttribute("color", new T.BufferAttribute(col, 3));
  geo.setAttribute("uv", new T.BufferAttribute(new Float32Array(total * 2), 2));
  geo.setIndex(index);
  geo.boundingSphere = new T.Sphere(new T.Vector3(0, 0.9, 0), 1.7);
  geo.boundingBox = new T.Box3(new T.Vector3(-1.2, -0.2, -1.2), new T.Vector3(1.2, 2.2, 1.2));
  const mesh = new T.Mesh(geo, material(T));
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.name = "worker";
  const root = new T.Group();
  root.name = "intro-figure";
  root.scale.setScalar(opts.height ?? 1);
  root.add(mesh);

  const p: Pose = { phase: 0, walk: 0, stride: 1.3, lean: 0, tilt: 0, twist: 0, crouch: 0, headYaw: 0, headPitch: 0, swing: 1, handL: null, handR: null, footL: null, footR: null, pitchL: 0, pitchR: 0 };
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
    qh = new T.Quaternion();
  const e = new T.Euler();
  const one = new T.Vector3(1, 1, 1);
  const torso = new T.Matrix4();
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
  function bone(name: string, a: Obj, b: Obj) {
    dir.subVectors(b, a).normalize();
    q.setFromUnitVectors(Y, dir);
    parts[name].m.compose(a, q, one);
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
    out.set(side * lerp(0.1, 0.082, w), lift * w, lerp(side * 0.025, z, w));
    return pitch * w;
  }

  function update(dt: number) {
    time += dt;
    const w = p.walk;
    const breath = Math.sin(time * 1.3 + seedT) * 0.006;
    const sway = Math.sin(time * 0.6 + seedT * 2) * 0.012 * (1 - w);

    // ---- the hips ride on the legs: lowest as a heel comes down, over the standing foot ----
    const bob = -0.026 * w * Math.cos(4 * Math.PI * p.phase);
    const hipsY = HIP_Y - 0.34 * p.crouch + bob - 0.012 * (1 - w);
    const hipsX = 0.03 * w * Math.sin(2 * Math.PI * (p.phase - 0.06)) + sway;
    const hipsZ = -0.1 * p.crouch;
    const gaitTwist = 0.1 * w * Math.sin(2 * Math.PI * (p.phase - 0.25)) * Math.min(1, p.swing);
    A.set(hipsX, hipsY, hipsZ);
    e.set(p.lean + 0.03 * w + breath, p.twist - gaitTwist, -p.tilt + hipsX * 0.6, "YXZ");
    q.setFromEuler(e);
    torso.compose(A, q, one);
    parts.coat.m.copy(torso);
    at.hips.x = hipsX;
    at.hips.y = hipsY;
    at.hips.z = hipsZ;

    // ---- the head, under its hood ----
    B.set(0, NECK, 0).applyMatrix4(torso);
    e.set(p.headPitch - p.lean * 0.55 + 0.05 * w * Math.cos(4 * Math.PI * p.phase), p.headYaw + gaitTwist * 0.7, 0, "YXZ");
    qh.setFromEuler(e);
    q.multiply(qh);
    parts.hood.m.compose(B, q, one);
    C.set(0, 0.14, 0).applyQuaternion(q).add(B);
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
      C.y += ANKLE + 0.13 * Math.max(0, Math.sin(pitch)); // the heel lifts round the ball of the foot
      A.set(hipsX + s * HIP_X, hipsY, hipsZ);
      D.set(s * 0.18, 0.05, 1);
      reach(A, C, THIGH, SHIN, D);
      bone("legU" + n, A, mid);
      bone("legF" + n, mid, end);
      e.set(pitch, 0, 0);
      q.setFromEuler(e);
      parts["boot" + n].m.compose(end, q, one);
    }

    // ---- arms ----
    for (const s of [1, -1]) {
      const n = s > 0 ? "L" : "R";
      const set = s > 0 ? p.handL : p.handR;
      A.set(s * SHOULDER.x * bulk, SHOULDER.y, 0).applyMatrix4(torso);
      if (set) C.set(set.x, set.y, set.z);
      else {
        // The arm opposite the forward leg comes forward; the elbow gives as it does.
        const th = s * 0.42 * w * p.swing * Math.sin(2 * Math.PI * (p.phase - 0.25)) + 0.06;
        const len = (UPPER + FORE) * (0.965 - 0.05 * Math.max(0, Math.sin(th)));
        C.set(s * 0.075, -Math.cos(th) * len, Math.sin(th) * len + 0.02)
          .applyQuaternion(q.setFromRotationMatrix(torso))
          .add(A);
      }
      D.set(s * 0.45, -0.25, -1);
      reach(A, C, UPPER, FORE, D);
      bone("armU" + n, A, mid);
      bone("armF" + n, mid, end);
      const h = s > 0 ? at.handL : at.handR;
      h.x = end.x;
      h.y = end.y;
      h.z = end.z;
    }

    // ---- write every part's vertices from its frame ----
    const P = posA.array as Float32Array,
      N = nrmA.array as Float32Array;
    for (const name in parts) {
      const pt = parts[name];
      const m = pt.m.elements;
      for (let i = pt.start * 3, n = (pt.start + pt.count) * 3; i < n; i += 3) {
        const x = bindP[i],
          y = bindP[i + 1],
          z = bindP[i + 2];
        P[i] = m[0] * x + m[4] * y + m[8] * z + m[12];
        P[i + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
        P[i + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
        const a = bindN[i],
          b = bindN[i + 1],
          c = bindN[i + 2];
        N[i] = m[0] * a + m[4] * b + m[8] * c;
        N[i + 1] = m[1] * a + m[5] * b + m[9] * c;
        N[i + 2] = m[2] * a + m[6] * b + m[10] * c;
      }
    }
    posA.needsUpdate = true;
    nrmA.needsUpdate = true;
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
      geo.dispose();
    },
  };
}
