// The Bailiff's body (docs/CAMPAIGN.md → The Bailiff): a 2.6 m dock-enforcement frame. A dark steel skeleton under
// hazard-striped yellow plates (the Assessor's livery, so the two read as one family), a slab head with one lens, a
// writ box bolted to its chest, and one arm ending in a container clamp. Built in code from the game's own materials
// (G.mats), merged per material and per moving part so it costs a few dozen draw calls.
//
// It moves by itself from the pose unit.ts hands it: feet are planted in the world and only move when they step
// (no sliding), the hips ride on the legs and sink at each footfall, the head turns to what it hunts, the clamp arm
// winds up and comes down, and it folds into a crouch or onto a knee.
import type { Body, BodyHit, Pose, V2, V3 } from "./types";

/* eslint-disable @typescript-eslint/no-explicit-any -- THREE and the game context come from the untyped bundle */
type Game = any;

/** Leg segments, the ankle over the sole, the hip joints' half-spacing and height standing (m). */
const L1 = 0.72;
const L2 = 0.72;
const ANKLE = 0.14;
const HIP_X = 0.21;
const HIP_H = 1.38;
const REACH = (L1 + L2) * 0.985;
/** The waist over the hips, the head and shoulders over the waist. */
const WAIST = 0.26;
const HEAD = { y: 0.6, z: 0.1 };
const SHOULDER = { x: 0.64, y: 0.5 };
const LENS = { x: -0.1, y: 0.115, z: 0.3 };
/** The gait: ground covered per step, the share of it a foot spends in the air, and how far ahead a foot lands. */
const STEP = 1.2;
const SWING = 0.8;
const AHEAD = ((2 - SWING) * STEP) / 2;
const STANCE = 0.25;
/** The lens beam: its length and half-angle. */
const BEAM = { length: 13, half: 0.06 };

const AMBER = [1.0, 0.56, 0.14];
const RED = [1.0, 0.1, 0.04];

const smooth = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/** Merges geometries (any mix of indexed and not) into one non-indexed geometry with position, normal and uv. */
function merge(T: any, geos: any[]): any {
  let n = 0;
  const flat = geos.map((g) => {
    const f = g.index ? g.toNonIndexed() : g;
    if (!f.attributes.normal) f.computeVertexNormals();
    n += f.attributes.position.count;
    return f;
  });
  const pos = new Float32Array(n * 3),
    nrm = new Float32Array(n * 3),
    uv = new Float32Array(n * 2);
  let o = 0;
  for (const f of flat) {
    const c = f.attributes.position.count;
    pos.set(f.attributes.position.array, o * 3);
    nrm.set(f.attributes.normal.array, o * 3);
    if (f.attributes.uv) uv.set(f.attributes.uv.array, o * 2);
    o += c;
  }
  const out = new T.BufferGeometry();
  out.setAttribute("position", new T.BufferAttribute(pos, 3));
  out.setAttribute("normal", new T.BufferAttribute(nrm, 3));
  out.setAttribute("uv", new T.BufferAttribute(uv, 2));
  out.computeBoundingSphere();
  out.computeBoundingBox();
  for (const g of geos) g.dispose();
  return out;
}

/** Collects geometry per material, then builds one mesh per material. */
function kit(T: any) {
  const lists = new Map<any, any[]>();
  const add = (mat: any, g: any) => {
    if (!lists.has(mat)) lists.set(mat, []);
    lists.get(mat)!.push(g);
    return g;
  };
  return {
    box(mat: any, w: number, h: number, d: number, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0) {
      const g = new T.BoxGeometry(w, h, d);
      if (rx || ry || rz) g.applyMatrix4(new T.Matrix4().makeRotationFromEuler(new T.Euler(rx, ry, rz)));
      return add(mat, g.translate(x, y, z));
    },
    cyl(mat: any, r0: number, r1: number, h: number, x: number, y: number, z: number, axis: "x" | "y" | "z" = "y", seg = 12) {
      const g = new T.CylinderGeometry(r0, r1, h, seg);
      if (axis === "x") g.rotateZ(Math.PI / 2);
      if (axis === "z") g.rotateX(Math.PI / 2);
      return add(mat, g.translate(x, y, z));
    },
    /** A round bar from a to b. */
    bar(mat: any, a: number[], b: number[], r: number, seg = 6) {
      const A = new T.Vector3(a[0], a[1], a[2]),
        B = new T.Vector3(b[0], b[1], b[2]);
      const g = new T.CylinderGeometry(r, r, A.distanceTo(B), seg);
      g.applyQuaternion(new T.Quaternion().setFromUnitVectors(new T.Vector3(0, 1, 0), B.clone().sub(A).normalize()));
      const m = A.add(B).multiplyScalar(0.5);
      return add(mat, g.translate(m.x, m.y, m.z));
    },
    add,
    build(group: any) {
      for (const [mat, geos] of lists) {
        const mesh = new T.Mesh(merge(T, geos), mat);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        group.add(mesh);
      }
      lists.clear();
    },
  };
}

/** An additive cone for the lens beam: bright along its axis, fading with distance, so rain and haze show it. */
function beamMaterial(T: any) {
  return new T.ShaderMaterial({
    uniforms: { uColor: { value: new T.Color(1, 1, 1) }, uGain: { value: 0 } },
    vertexShader: `
      varying vec3 vN; varying vec3 vV; varying vec3 vP;
      void main() {
        vP = position;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vN = normalMatrix * normal; vV = -mv.xyz;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      uniform vec3 uColor; uniform float uGain; varying vec3 vN; varying vec3 vV; varying vec3 vP;
      void main() {
        float f = abs(dot(normalize(vN), normalize(vV)));
        f = f * f * (3.0 - 2.0 * f);
        float t = clamp(vP.z, 0.0, 1.0);
        float k = pow(1.0 - t, 1.6) * smoothstep(0.0, 0.04, t);
        gl_FragColor = vec4(uColor * (uGain * f * k), 1.0);
      }`,
    transparent: true,
    blending: T.AdditiveBlending,
    depthWrite: false,
    side: T.DoubleSide,
    fog: false,
    toneMapped: false,
  });
}

export interface ModelOptions {
  /** A foot came down at `at` (the footfall's sound, dust and shake are the caller's). */
  onStep?: (at: V3) => void;
}

export function createModel(G: Game, at: V2, opts: ModelOptions = {}): Body {
  const T = G.THREE;
  const mats = G.mats;
  const mat = (name: string) => mats.get(name, { triplanar: true });
  const M = {
    yellow: mat("paint_yellow"),
    dark: mat("steel_dark"),
    worn: mat("steel_worn"),
    hazard: mat("hazard_stripes"),
    rubber: mat("rubber"),
    rust: mat("steel_rust"),
  };
  const lensMat = new T.MeshBasicMaterial({ color: new T.Color(0.02, 0.02, 0.02), toneMapped: true });
  const beaconMat = new T.MeshBasicMaterial({ color: new T.Color(0.05, 0.03, 0.01), toneMapped: true });
  const slotMat = mats.emissive(0x8fd3ff, 2.2);

  // Everything hangs off `rig` (identity), so one updateMatrixWorld covers the body and the world-space legs.
  const rig = new T.Group();
  rig.name = "bailiff";
  G.scene.add(rig);
  const root = new T.Group();
  rig.add(root);
  const hips = new T.Group();
  root.add(hips);
  const chest = new T.Group();
  chest.position.y = WAIST;
  hips.add(chest);
  const head = new T.Group();
  head.position.set(0, HEAD.y, HEAD.z);
  chest.add(head);

  // ---- hips: the pelvis block, the hip joints, a hazard belt, the waist column and its pistons ----
  {
    const k = kit(T);
    k.box(M.dark, 0.5, 0.24, 0.34, 0, 0.02, 0);
    k.box(M.worn, 0.26, 0.26, 0.06, 0, -0.03, 0.19);
    k.box(M.hazard, 0.56, 0.07, 0.38, 0, 0.16, 0);
    for (const s of [-1, 1]) {
      k.cyl(M.worn, 0.15, 0.15, 0.16, s * 0.3, 0, 0, "x", 14);
      k.box(M.dark, 0.06, 0.28, 0.3, s * 0.39, -0.04, 0);
      k.bar(M.worn, [s * 0.16, 0.12, -0.1], [s * 0.2, 0.44, -0.12], 0.03);
      k.bar(M.worn, [s * 0.13, 0.12, 0.12], [s * 0.17, 0.42, 0.14], 0.022);
    }
    k.cyl(M.dark, 0.11, 0.13, 0.3, 0, 0.26, -0.02, "y", 12);
    k.cyl(M.rust, 0.14, 0.14, 0.05, 0, 0.14, -0.02, "y", 12);
    k.build(hips);
  }

  // ---- chest: the ribcage, plates front and back, the power pack, the shoulder yoke and pauldrons, the writ box ----
  {
    const k = kit(T);
    // A dark ribcage of steel slats, a yellow collar plate across the top of it, a hazard band at the waist.
    k.box(M.dark, 0.7, 0.5, 0.44, 0, 0.3, 0);
    for (let i = 0; i < 5; i++) k.box(M.worn, 0.62, 0.028, 0.04, 0, 0.15 + i * 0.062, 0.232);
    k.box(M.yellow, 0.92, 0.17, 0.16, 0, 0.5, 0.2, -0.3, 0, 0);
    k.box(M.hazard, 0.74, 0.08, 0.1, 0, 0.07, 0.21);
    // Its back: the power pack, two stacks, and the plate with its number.
    k.box(M.dark, 0.52, 0.42, 0.2, 0, 0.32, -0.32);
    k.box(M.yellow, 0.6, 0.2, 0.06, 0, 0.44, -0.44);
    k.box(M.rust, 0.44, 0.14, 0.05, 0, 0.2, -0.43);
    for (const s of [-1, 1]) {
      k.cyl(M.worn, 0.05, 0.055, 0.3, s * 0.17, 0.66, -0.33, "y", 8);
      k.cyl(M.dark, 0.062, 0.062, 0.04, s * 0.17, 0.8, -0.33, "y", 8);
      // Pauldrons: a yellow slab with a hazard edge over each shoulder joint.
      k.box(M.yellow, 0.36, 0.15, 0.48, s * 0.62, 0.64, 0, 0, 0, -s * 0.22);
      k.box(M.hazard, 0.38, 0.06, 0.5, s * 0.66, 0.545, 0, 0, 0, -s * 0.22);
      k.cyl(M.worn, 0.13, 0.13, 0.2, s * 0.58, 0.5, 0, "x", 14);
    }
    k.box(M.dark, 1.14, 0.14, 0.3, 0, 0.54, 0);
    k.box(M.dark, 0.54, 0.12, 0.48, 0, 0.62, 0.02);
    k.cyl(M.worn, 0.09, 0.09, 0.14, 0, 0.67, HEAD.z - 0.04, "y", 10);
    // The writ box, bolted over where a heart would be: a steel case, a lit slot, the paper it serves.
    const W = { x: 0.17, y: 0.31, z: 0.305 };
    k.box(M.worn, 0.32, 0.24, 0.12, W.x, W.y, W.z);
    k.box(M.dark, 0.36, 0.035, 0.14, W.x, W.y + 0.13, W.z);
    for (const [bx, by] of [
      [-0.13, -0.09],
      [0.13, -0.09],
      [-0.13, 0.09],
      [0.13, 0.09],
    ])
      k.cyl(M.dark, 0.02, 0.02, 0.03, W.x + bx, W.y + by, W.z + 0.065, "z", 6);
    k.add(slotMat, new T.BoxGeometry(0.2, 0.022, 0.012).translate(W.x, W.y + 0.04, W.z + 0.062));
    k.build(chest);
    try {
      const lab = mats.label("WRIT", { color: "black", font: "stencil", distress: 0.3 });
      const p = new T.Mesh(new T.PlaneGeometry(Math.min(0.2, 0.07 * (lab.aspect || 3)), 0.07), lab.material);
      p.position.set(W.x, W.y - 0.05, W.z + 0.0615);
      chest.add(p);
      const lab2 = mats.label("BAILIFF 02", { color: "black", font: "stencil", distress: 0.35 });
      const w2 = Math.min(0.54, 0.11 * (lab2.aspect || 5));
      const p2 = new T.Mesh(new T.PlaneGeometry(w2, 0.11), lab2.material);
      p2.position.set(0, 0.44, -0.4715);
      p2.rotation.y = Math.PI;
      chest.add(p2);
    } catch {
      /* labels are decoration */
    }
  }
  // The beacon on its left pauldron: a dock machine's amber lamp.
  const beacon = new T.Mesh(new T.SphereGeometry(0.05, 10, 8), beaconMat);
  beacon.position.set(0.62, 0.8, -0.12);
  chest.add(beacon);
  {
    const k = kit(T);
    k.cyl(M.dark, 0.022, 0.03, 0.1, 0.62, 0.73, -0.12, "y", 6);
    k.build(chest);
  }

  // ---- head: a slab with a cap, and one lens set off-centre ----
  const lens = new T.Mesh(new T.SphereGeometry(0.046, 16, 12), lensMat);
  lens.position.set(LENS.x, LENS.y, LENS.z - 0.012);
  lens.scale.set(1, 1, 0.45);
  head.add(lens);
  {
    const k = kit(T);
    // A wide dark slab under a yellow cap with a peak (an officer's cap, in crane paint). No face: a slot across
    // the front, and the one lens set to one side of it.
    k.box(M.dark, 0.5, 0.23, 0.42, 0, 0.115, 0);
    k.box(M.yellow, 0.56, 0.07, 0.56, 0, 0.265, 0.05);
    k.box(M.hazard, 0.56, 0.04, 0.06, 0, 0.228, 0.3);
    k.box(M.worn, 0.5, 0.05, 0.03, 0, 0.19, 0.212);
    k.box(M.worn, 0.5, 0.06, 0.03, 0, 0.035, 0.212);
    k.cyl(M.dark, 0.07, 0.078, 0.1, LENS.x, LENS.y, 0.245, "z", 16);
    k.cyl(M.worn, 0.078, 0.078, 0.02, LENS.x, LENS.y, 0.287, "z", 16);
    // Where a second lens was never fitted: a blanked socket, and vents.
    k.cyl(M.rust, 0.04, 0.04, 0.02, 0.13, LENS.y, 0.212, "z", 10);
    for (let i = 0; i < 3; i++) k.box(M.worn, 0.012, 0.07, 0.01, 0.02 + i * 0.03, LENS.y, 0.212);
    for (const s of [-1, 1]) k.box(M.worn, 0.03, 0.14, 0.22, s * 0.262, 0.12, -0.04);
    k.build(head);
  }

  // ---- arms: the clamp arm on its right (−x), a plain fist on its left ----
  const armR = new T.Group(),
    foreR = new T.Group(),
    jawA = new T.Group(),
    jawB = new T.Group(),
    armL = new T.Group(),
    foreL = new T.Group();
  const UP_R = 0.56,
    FORE_R = 0.64,
    UP_L = 0.5;
  armR.position.set(-SHOULDER.x - 0.1, SHOULDER.y, 0);
  foreR.position.y = -UP_R;
  armL.position.set(SHOULDER.x + 0.1, SHOULDER.y, 0);
  foreL.position.y = -UP_L;
  chest.add(armR, armL);
  armR.add(foreR);
  armL.add(foreL);
  jawA.position.set(0, -FORE_R, 0.12);
  jawB.position.set(0, -FORE_R, -0.12);
  foreR.add(jawA, jawB);
  {
    const k = kit(T);
    k.box(M.dark, 0.2, 0.5, 0.2, 0, -0.28, 0);
    k.box(M.worn, 0.24, 0.2, 0.26, 0, -0.17, 0);
    k.box(M.hazard, 0.25, 0.07, 0.27, 0, -0.33, 0);
    k.bar(M.worn, [0, -0.04, -0.14], [0, -0.5, -0.13], 0.032);
    k.cyl(M.worn, 0.115, 0.115, 0.26, 0, -UP_R, 0, "x", 14);
    k.build(armR);
    k.box(M.dark, 0.2, 0.5, 0.22, 0, -0.3, 0);
    k.box(M.hazard, 0.25, 0.22, 0.27, 0, -0.4, 0);
    k.bar(M.worn, [0.06, -0.06, 0.13], [0.06, -0.52, 0.13], 0.028);
    k.bar(M.worn, [-0.06, -0.06, 0.13], [-0.06, -0.52, 0.13], 0.028);
    k.box(M.dark, 0.3, 0.12, 0.34, 0, -0.58, 0);
    k.cyl(M.worn, 0.05, 0.05, 0.36, 0, -FORE_R, 0, "x", 8);
    k.build(foreR);
    // The clamp: two jaws that hook inward, like a spreader's corner lock grown to hold a man.
    for (const [jaw, s] of [
      [jawA, 1],
      [jawB, -1],
    ] as const) {
      k.box(M.yellow, 0.26, 0.34, 0.07, 0, -0.17, s * 0.02);
      k.box(M.hazard, 0.27, 0.1, 0.075, 0, -0.08, s * 0.02);
      k.box(M.dark, 0.26, 0.08, 0.16, 0, -0.36, -s * 0.045);
      k.box(M.worn, 0.22, 0.05, 0.04, 0, -0.36, -s * 0.13);
      k.build(jaw);
    }
    k.box(M.dark, 0.17, 0.46, 0.17, 0, -0.26, 0);
    k.box(M.worn, 0.21, 0.2, 0.23, 0, -0.16, 0);
    k.cyl(M.worn, 0.1, 0.1, 0.22, 0, -UP_L, 0, "x", 12);
    k.build(armL);
    k.box(M.dark, 0.16, 0.42, 0.17, 0, -0.24, 0);
    k.box(M.hazard, 0.2, 0.1, 0.21, 0, -0.4, 0);
    k.box(M.dark, 0.2, 0.2, 0.24, 0, -0.56, 0.02);
    k.box(M.worn, 0.21, 0.06, 0.25, 0, -0.62, 0.02);
    k.build(foreL);
  }

  // ---- legs: solved in the world from each hip joint to its planted foot ----
  const legs = [1, -1].map((s) => {
    const thigh = new T.Group(),
      shin = new T.Group(),
      foot = new T.Group();
    rig.add(thigh, shin, foot);
    const k = kit(T);
    k.box(M.dark, 0.16, L1 - 0.06, 0.18, 0, -L1 / 2, 0);
    k.box(M.worn, 0.21, 0.36, 0.24, 0, -0.27, 0.02);
    k.bar(M.worn, [0, -0.08, -0.13], [0, -L1 + 0.08, -0.11], 0.03);
    k.cyl(M.worn, 0.11, 0.11, 0.25, 0, -L1, 0, "x", 14);
    k.box(M.yellow, 0.2, 0.17, 0.08, 0, -L1, 0.11);
    k.build(thigh);
    k.box(M.dark, 0.14, L2 - 0.08, 0.16, 0, -L2 / 2, 0);
    k.box(M.worn, 0.19, 0.32, 0.08, 0, -0.32, 0.09);
    k.box(M.hazard, 0.2, 0.1, 0.2, 0, -L2 + 0.13, 0);
    k.bar(M.worn, [0, -0.1, -0.1], [0, -L2 + 0.08, -0.09], 0.024);
    k.cyl(M.worn, 0.08, 0.08, 0.2, 0, -L2, 0, "x", 10);
    k.build(shin);
    k.box(M.dark, 0.26, 0.1, 0.56, 0, 0.09, 0.1);
    k.box(M.rubber, 0.28, 0.04, 0.6, 0, 0.02, 0.1);
    k.box(M.yellow, 0.27, 0.07, 0.16, 0, 0.165, 0.29);
    k.box(M.dark, 0.2, 0.12, 0.14, 0, 0.15, -0.1);
    k.build(foot);
    return {
      s,
      thigh,
      shin,
      foot,
      plant: new T.Vector3(at.x, 0, at.z),
      pos: new T.Vector3(at.x, 0, at.z),
      from: new T.Vector3(),
      yaw: 0,
      fromYaw: 0,
      /** −1 planted; else 0–1 through a swing. */
      swing: -1,
      /** The walk's phase when the swing began, or −1 for a step on the spot. */
      start: -1,
      lift: 0.2,
      pitch: 0,
    };
  });

  // ---- the lens beam and its light ----
  const coneMat = beamMaterial(T);
  const cone = new T.Mesh(new T.ConeGeometry(1, 1, 24, 1, true).translate(0, -0.5, 0).rotateX(-Math.PI / 2), coneMat);
  cone.frustumCulled = false;
  cone.renderOrder = 6;
  cone.visible = false;
  rig.add(cone);
  // Nothing shows, lights or sounds until its first pose: a Bailiff spawned with a delay isn't in the world yet.
  rig.visible = false;
  let light: any = null;
  let servo: any = null;
  function wake() {
    rig.visible = true;
    try {
      light = G.render?.lightPool?.acquire?.() ?? null;
      if (light?.light) ((light.light.distance = 7), (light.light.intensity = 0));
    } catch {
      light = null;
    }
    try {
      servo = G.audio?.loop?.("hound_servo", { pos: [at.x, 1.6, at.z], gain: 0.5 }) ?? null;
      servo?.setPitch?.(0.4);
    } catch {
      servo = null;
    }
  }

  // ---- hit volumes: boxes in each part's own frame, and the lens as a small sphere ----
  type Vol = { obj: any; min: number[]; max: number[] };
  const vols: Vol[] = [
    { obj: chest, min: [-0.62, 0, -0.44], max: [0.62, 0.72, 0.4] },
    { obj: hips, min: [-0.42, -0.18, -0.2], max: [0.42, 0.3, 0.24] },
    { obj: head, min: [-0.28, 0, -0.22], max: [0.28, 0.3, 0.3] },
    { obj: armR, min: [-0.13, -UP_R - 0.1, -0.14], max: [0.13, 0.08, 0.14] },
    { obj: foreR, min: [-0.15, -FORE_R - 0.4, -0.2], max: [0.15, 0, 0.2] },
    { obj: armL, min: [-0.12, -UP_L - 0.1, -0.13], max: [0.12, 0.08, 0.13] },
    { obj: foreL, min: [-0.11, -0.68, -0.12], max: [0.11, 0, 0.14] },
  ];
  for (const l of legs) {
    vols.push({ obj: l.thigh, min: [-0.12, -L1 - 0.1, -0.12], max: [0.12, 0, 0.16] });
    vols.push({ obj: l.shin, min: [-0.1, -L2, -0.1], max: [0.1, 0, 0.13] });
    vols.push({ obj: l.foot, min: [-0.14, 0, -0.18], max: [0.14, 0.2, 0.4] });
  }
  const inv = new T.Matrix4(),
    lo = new T.Vector3(),
    ld = new T.Vector3(),
    wp = new T.Vector3(),
    v0 = new T.Vector3(),
    v1 = new T.Vector3(),
    v2 = new T.Vector3(),
    hip = new T.Vector3(),
    ankle = new T.Vector3(),
    knee = new T.Vector3(),
    q0 = new T.Quaternion(),
    q1 = new T.Quaternion(),
    qYaw = new T.Quaternion(),
    DOWN = new T.Vector3(0, -1, 0),
    UP = new T.Vector3(0, 1, 0),
    Z = new T.Vector3(0, 0, 1);

  function rayBox(o: V3, d: V3, v: Vol, max: number): { t: number; axis: number; sign: number } | null {
    inv.copy(v.obj.matrixWorld).invert();
    lo.set(o.x, o.y, o.z).applyMatrix4(inv);
    ld.set(d.x, d.y, d.z).transformDirection(inv);
    let t0 = 0,
      t1 = max,
      axis = -1,
      sign = 0;
    for (let a = 0; a < 3; a++) {
      const oa = lo.getComponent(a),
        da = ld.getComponent(a);
      if (Math.abs(da) < 1e-9) {
        if (oa < v.min[a] || oa > v.max[a]) return null;
        continue;
      }
      let n = (v.min[a] - oa) / da,
        f = (v.max[a] - oa) / da,
        s = -1;
      if (n > f) ((s = 1), ([n, f] = [f, n]));
      if (n > t0) ((t0 = n), (axis = a), (sign = s));
      if (f < t1) t1 = f;
      if (t0 > t1) return null;
    }
    return axis < 0 ? null : { t: t0, axis, sign };
  }

  const ground = (x: number, z: number, maxY: number): number => {
    try {
      return G.physics.groundHeight(x, z, maxY);
    } catch {
      return 0;
    }
  };

  // ---- state ----
  let time = 0;
  let started = false;
  let phase = 0;
  let lastStep = -1;
  let walk = 0; // 0 standing … 1 at full pace
  let dip = 0; // the hips' sink after a footfall
  let hipY = 0.7;
  let headYaw = 0,
    headPitch = 0;
  let puffT = 0;
  const last = { x: at.x, z: at.z };
  const dir = { x: 0, z: 1 };
  const col = [0.02, 0.02, 0.02];
  let glow = 0;

  function home(l: (typeof legs)[number], p: Pose, out: any, ahead = 0) {
    const c = Math.cos(p.yaw),
      s = Math.sin(p.yaw);
    return out.set(p.x + c * l.s * STANCE + dir.x * ahead, 0, p.z - s * l.s * STANCE + dir.z * ahead);
  }

  function land(l: (typeof legs)[number], p: Pose) {
    l.swing = -1;
    l.start = -1;
    l.plant.copy(l.pos);
    l.plant.y = ground(l.plant.x, l.plant.z, p.y + 0.6);
    l.pos.copy(l.plant);
    l.yaw = p.yaw;
    l.pitch = 0;
  }

  function solveLeg(l: (typeof legs)[number], p: Pose, kneel: number) {
    hip.set(l.s * HIP_X, 0, 0);
    hips.localToWorld(hip);
    ankle.set(l.pos.x, l.pos.y + ANKLE + Math.abs(Math.sin(l.pitch)) * 0.12, l.pos.z);
    v0.subVectors(ankle, hip);
    let d = v0.length();
    d = Math.max(Math.abs(L1 - L2) + 0.08, Math.min(L1 + L2 - 0.005, d));
    v0.normalize();
    const a = (L1 * L1 - L2 * L2 + d * d) / (2 * d);
    const h = Math.sqrt(Math.max(0, L1 * L1 - a * a));
    // Knees bend forward; the kneeling leg's goes forward and down to the ground.
    const down = l.s < 0 ? kneel : 0;
    v1.set(Math.sin(p.yaw) + Math.cos(p.yaw) * l.s * 0.12, -1.4 * down, Math.cos(p.yaw) - Math.sin(p.yaw) * l.s * 0.12);
    v1.addScaledVector(v0, -v1.dot(v0)).normalize();
    knee.copy(hip).addScaledVector(v0, a).addScaledVector(v1, h);
    qYaw.setFromAxisAngle(UP, p.yaw);
    l.thigh.position.copy(hip);
    l.thigh.quaternion.setFromUnitVectors(DOWN, v2.subVectors(knee, hip).normalize()).multiply(qYaw);
    l.shin.position.copy(knee);
    v2.copy(hip).addScaledVector(v0, d).sub(knee).normalize();
    l.shin.quaternion.setFromUnitVectors(DOWN, v2).multiply(qYaw);
    l.foot.position.copy(l.pos);
    l.foot.rotation.set(l.pitch, l.yaw, 0, "YXZ");
  }

  function update(dt: number, p: Pose) {
    time += dt;
    if (!started) {
      started = true;
      wake();
      for (const l of legs) {
        home(l, p, l.plant);
        l.plant.y = ground(l.plant.x, l.plant.z, p.y + 0.6);
        l.pos.copy(l.plant);
        l.yaw = p.yaw;
      }
      last.x = p.x;
      last.z = p.z;
    }
    const mx = p.x - last.x,
      mz = p.z - last.z;
    const moved = Math.hypot(mx, mz);
    last.x = p.x;
    last.z = p.z;
    if (moved > 1e-4) ((dir.x = mx / moved), (dir.z = mz / moved));
    const upright = p.up >= 0.999 && p.kneel <= 0.001;
    const walking = upright && p.speed > 0.25 && moved > 1e-5;
    walk += ((walking ? Math.min(1, p.speed / 2.6) : 0) - walk) * Math.min(1, dt * 6);

    // ---- the gait: one foot at a time, each landing ahead of where the hips will be ----
    if (walking) {
      if (lastStep < 0) phase = Math.ceil(phase); // from a stand, the first step starts at once
      phase += moved / STEP;
      const k = Math.floor(phase);
      const l = legs[k % 2],
        o = legs[1 - (k % 2)];
      if (k !== lastStep && l.swing < 0 && o.swing < 0) {
        lastStep = k;
        l.swing = 0;
        l.start = phase;
        l.from.copy(l.plant);
        l.fromYaw = l.yaw;
        l.lift = 0.2;
      }
    } else lastStep = -1;
    for (const l of legs) {
      const o = legs[l === legs[0] ? 1 : 0];
      if (l.swing < 0) {
        l.pos.copy(l.plant);
        // Standing: a foot out of place (a pivot, a stop mid-stride) steps home, one at a time.
        if (!walking && upright && o.swing < 0) {
          home(l, p, v0);
          const off = Math.hypot(v0.x - l.plant.x, v0.z - l.plant.z);
          if (off > 0.3 || (off > 0.12 && Math.abs(wrap(p.yaw - l.yaw)) > 0.5)) {
            l.swing = 0;
            l.start = -1;
            l.from.copy(l.plant);
            l.fromYaw = l.yaw;
            l.lift = 0.12;
          }
        }
        continue;
      }
      const before = l.swing;
      const byTime = before + dt / (l.start < 0 ? 0.36 : 0.62);
      l.swing = l.start < 0 ? byTime : Math.max(byTime, (phase - l.start) / SWING);
      const u = Math.min(1, l.swing);
      // Where it will come down: ahead of the hips by the rest of the swing's travel and the stride's lead.
      home(l, p, v0, l.start < 0 ? 0 : (1 - u) * SWING * STEP * walk + AHEAD * Math.max(0.35, walk));
      const e = smooth(u);
      l.pos.x = lerp(l.from.x, v0.x, e);
      l.pos.z = lerp(l.from.z, v0.z, e);
      const gy = lerp(l.from.y, ground(v0.x, v0.z, p.y + 0.6), e);
      l.pos.y = gy + Math.sin(u * Math.PI) * l.lift;
      l.yaw = l.fromYaw + wrap(p.yaw - l.fromYaw) * e;
      l.pitch = l.start < 0 ? 0 : 0.5 * Math.sin(u * Math.PI) * (u < 0.55 ? 1 : -0.7);
      if (u >= 1) {
        land(l, p);
        dip = Math.min(0.09, dip + (l.start < 0 ? 0.03 : 0.06));
        try {
          opts.onStep?.({ x: l.plant.x, y: l.plant.y, z: l.plant.z });
        } catch {
          /* decoration */
        }
      }
    }
    dip *= Math.exp(-7 * dt);

    // On a knee, the clamp-side foot slides back so that knee comes down under the hip.
    const kn = p.kneel;
    if (kn > 0) {
      const r = legs[1];
      if (r.swing < 0) {
        r.pos.x = r.plant.x - Math.sin(p.yaw) * 0.5 * kn;
        r.pos.z = r.plant.z - Math.cos(p.yaw) * 0.5 * kn;
        r.pitch = 0.9 * kn;
      }
    } else if (legs[1].swing < 0) legs[1].pitch = 0;

    // ---- the hips ride on the legs ----
    const crouch = 1 - p.up;
    const sw = Math.sin(Math.PI * phase),
      cw = Math.cos(Math.PI * phase);
    const air = Math.max(0, ...legs.map((l) => (l.swing >= 0 && l.start >= 0 ? Math.sin(Math.min(1, l.swing) * Math.PI) : 0)));
    let wantY = p.y + lerp(HIP_H, 0.7, crouch) - 0.64 * kn + (0.035 * air - 0.02) * walk - dip + Math.sin(time * 1.7) * 0.006;
    const fwd = -0.16 * crouch + 0.1 * kn;
    const sway = -0.055 * sw * walk;
    const hx = p.x + Math.sin(p.yaw) * fwd + Math.cos(p.yaw) * sway,
      hz = p.z + Math.cos(p.yaw) * fwd - Math.sin(p.yaw) * sway;
    // No leg is asked to reach further than it can: the hips sink instead.
    for (const l of legs) {
      const jx = hx + Math.cos(p.yaw) * l.s * HIP_X,
        jz = hz - Math.sin(p.yaw) * l.s * HIP_X;
      const flat = Math.hypot(l.pos.x - jx, l.pos.z - jz);
      if (flat < REACH * 0.98) wantY = Math.min(wantY, l.pos.y + ANKLE + Math.sqrt(REACH * REACH - flat * flat));
    }
    hipY = started && time > dt ? lerp(hipY, wantY, Math.min(1, dt * 18)) : wantY;
    hipY = Math.min(hipY, wantY + 0.05);
    root.position.set(p.x, 0, p.z);
    root.rotation.set(0, p.yaw, 0);
    const shake = kn > 0.5 ? Math.sin(time * 41) * 0.006 : 0;
    hips.position.set(sway + shake, hipY, fwd);
    hips.rotation.set(0.5 * crouch + 0.1 * kn + 0.03 * walk, 0.11 * cw * walk, 0.045 * sw * walk + 0.05 * kn, "YXZ");

    // ---- chest, head ----
    const wind = p.raise,
      hit = p.strike;
    chest.rotation.set(
      0.06 + 0.62 * crouch + 0.52 * kn - 0.16 * wind + 0.3 * hit + 0.02 * Math.sin(Math.PI * phase * 2) * walk,
      -0.14 * cw * walk - 0.3 * wind + 0.35 * hit,
      -0.03 * sw * walk - 0.07 * kn,
      "YXZ",
    );
    let wantYaw = Math.sin(time * 0.9) * 0.35 * (1 - crouch) * (1 - kn),
      wantPitch = 0.1 + 0.55 * crouch + 0.6 * kn;
    if (p.look && kn < 0.3 && crouch < 0.5) {
      head.getWorldPosition(wp);
      const lx = p.look.x - wp.x,
        ly = p.look.y - wp.y,
        lz = p.look.z - wp.z;
      wantYaw = Math.max(-1.2, Math.min(1.2, wrap(Math.atan2(lx, lz) - p.yaw - chest.rotation.y - hips.rotation.y)));
      wantPitch = Math.max(-0.5, Math.min(0.75, Math.atan2(-ly, Math.hypot(lx, lz)) - chest.rotation.x - hips.rotation.x));
    }
    headYaw += (wantYaw - headYaw) * Math.min(1, dt * 5);
    headPitch += (wantPitch - headPitch) * Math.min(1, dt * 6);
    head.rotation.set(headPitch, headYaw, 0, "YXZ");

    // ---- arms: the clamp hangs heavy, rises to strike, comes down; on a knee it props the body ----
    const swingR = 0.12 * cw * walk,
      swingL = -0.26 * cw * walk;
    armR.rotation.set(lerp(lerp(0.06 + swingR - 0.5 * crouch - 0.62 * kn, -2.55, wind), -1.25, hit), 0, lerp(-0.1, -0.3, wind) + 0.12 * hit);
    foreR.rotation.set(lerp(lerp(-0.16 - 0.5 * crouch - 0.2 * kn, -0.75, wind), -0.2, hit), 0, 0);
    const open = lerp(0.12 + 0.3 * crouch, 0.85, wind) * (1 - hit) + 0.02 * hit;
    jawA.rotation.x = -open;
    jawB.rotation.x = open;
    armL.rotation.set(0.05 + swingL - 0.35 * crouch - 0.2 * kn + 0.4 * wind - 0.5 * hit, 0, 0.09 + 0.1 * wind);
    foreL.rotation.set(-0.22 - 0.5 * crouch - 0.5 * kn - 0.5 * wind, 0, 0);

    rig.updateMatrixWorld(true);
    for (const l of legs) solveLeg(l, p, kn);
    rig.updateMatrixWorld(true);

    // ---- the lens, its beam and its light ----
    const want = p.lens === "dark" ? [0, 0, 0] : p.lens === "red" ? RED : AMBER;
    const lit = p.lens === "dark" ? 0 : 1;
    glow += (lit - glow) * Math.min(1, dt * (lit ? 5 : 9));
    for (let i = 0; i < 3; i++) col[i] += (want[i] - col[i]) * Math.min(1, dt * 7);
    // It flickers as it comes on, and flares through the wind-up.
    const flick = glow > 0.02 && glow < 0.9 ? (Math.sin(time * 57) > -0.2 ? 1 : 0.25) : 1;
    const power = glow * flick * (4 + 9 * p.flare + (p.lens === "red" ? 2.5 : 0));
    lensMat.color.setRGB(0.015 + col[0] * power, 0.015 + col[1] * power, 0.015 + col[2] * power);
    lens.getWorldPosition(wp);
    head.getWorldQuaternion(q0);
    v1.copy(Z).applyQuaternion(q0);
    const len = BEAM.length,
      rad = Math.tan(BEAM.half) * len;
    cone.position.copy(wp).addScaledVector(v1, 0.04);
    cone.quaternion.copy(q1.setFromUnitVectors(Z, v1));
    cone.scale.set(rad, rad, len);
    cone.visible = glow * flick > 0.02;
    coneMat.uniforms.uColor.value.setRGB(col[0], col[1], col[2]);
    coneMat.uniforms.uGain.value = glow * flick * (0.17 + 0.3 * p.flare + (p.lens === "red" ? 0.06 : 0));
    if (light?.light) {
      light.light.position.copy(wp).addScaledVector(v1, 0.9);
      light.light.color.setRGB(col[0], col[1], col[2]);
      light.light.intensity += (glow * (5 + 16 * p.flare) - light.light.intensity) * 0.3;
    }
    const blink = p.state === "windup" ? 1 : Math.sin(time * 6.5) > 0.55 ? 1 : 0.06;
    const bk = p.lens === "dark" ? 0.03 : 7 * blink;
    if (p.state === "windup") beaconMat.color.setRGB(1 * bk, 0.1 * bk, 0.04 * bk);
    else beaconMat.color.setRGB(1 * bk, 0.55 * bk, 0.1 * bk);

    // ---- down: it sparks and smokes at the neck ----
    if (kn > 0.6 && (puffT -= dt) <= 0) {
      puffT = 0.45 + Math.random() * 0.5;
      head.getWorldPosition(wp);
      try {
        G.fx?.sparks?.(wp.clone(), UP, 5);
        G.fx?.smoke?.(wp.clone(), { size: 0.5, life: 1.6, rise: 0.8, count: 1, alpha: 0.3 });
      } catch {
        /* decoration */
      }
    }
    try {
      servo?.setPos?.([p.x, hipY + 0.4, p.z]);
      servo?.setGain?.(kn > 0.5 ? 0.12 : 0.45 + 0.5 * walk + 0.4 * p.raise + 0.5 * (1 - p.up));
      servo?.setPitch?.(kn > 0.5 ? 0.3 : 0.42 + 0.14 * walk + 0.35 * p.raise + 0.2 * Math.sin(Math.min(1, p.up) * Math.PI));
    } catch {
      /* sound is never load-bearing */
    }
  }

  return {
    update,
    lens(out) {
      lens.getWorldPosition(wp);
      out.x = wp.x;
      out.y = wp.y;
      out.z = wp.z;
      return out;
    },
    raycast(o, d, max) {
      let best: BodyHit | null = null;
      // The lens: a sphere a little bigger than the glass, so its housing catches the near misses.
      lens.getWorldPosition(wp);
      const ox = o.x - wp.x,
        oy = o.y - wp.y,
        oz = o.z - wp.z;
      const b = ox * d.x + oy * d.y + oz * d.z;
      const disc = b * b - (ox * ox + oy * oy + oz * oz - 0.11 * 0.11);
      if (disc >= 0) {
        const t = -b - Math.sqrt(disc);
        if (t > 0 && t < max) {
          const px = o.x + d.x * t,
            py = o.y + d.y * t,
            pz = o.z + d.z * t;
          const l = Math.hypot(px - wp.x, py - wp.y, pz - wp.z) || 1;
          best = { dist: t, point: { x: px, y: py, z: pz }, normal: { x: (px - wp.x) / l, y: (py - wp.y) / l, z: (pz - wp.z) / l }, lens: true };
        }
      }
      for (const v of vols) {
        // A box has to be clearly nearer than the lens to hide it: the lens sits proud of the face plate.
        const h = rayBox(o, d, v, best ? best.dist - (best.lens ? 0.1 : 0) : max);
        if (!h || h.t <= 0 || (best && h.t >= best.dist - (best.lens ? 0.1 : 0))) continue;
        const n = v0.set(0, 0, 0);
        n.setComponent(h.axis, h.sign);
        n.transformDirection(v.obj.matrixWorld);
        best = { dist: h.t, point: { x: o.x + d.x * h.t, y: o.y + d.y * h.t, z: o.z + d.z * h.t }, normal: { x: n.x, y: n.y, z: n.z }, lens: false };
      }
      return best;
    },
    dispose() {
      try {
        light?.release?.();
        servo?.stop?.(0.3);
      } catch {
        /* already gone */
      }
      rig.traverse((c: any) => {
        if (c.isMesh) c.geometry?.dispose?.();
      });
      rig.removeFromParent();
      for (const m of [coneMat, lensMat, beaconMat]) m.dispose();
    },
  };
}
