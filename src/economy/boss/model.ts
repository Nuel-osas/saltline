// The Assessor's body (docs/STORY.md → The boss): a gantry crane that walked off its rails. A frame on four
// walking legs, a slewing ring, and on it the upper works: the main girder with the relay cores bolted along its front
// like rivets, the machinery house, the operator's cab, and the inspection lamp hung under the cab. Built in code from
// the game's own materials (G.mats: yellow crane paint, dark and worn steel, hazard stripes), merged per material so
// it costs a few dozen draw calls, and lit by the game's sun, haze and bloom like everything else.
//
// It walks with a procedural gait (diagonal pairs, feet landing on whatever is under them, so it climbs the north
// containers), aims its lamp, lifts a foot to stamp, and slumps over the quay edge when the last core goes dark.
import type { Body, BodyHit, CoreState, V3 } from "./types";

/* eslint-disable @typescript-eslint/no-explicit-any -- THREE and the game context come from the untyped bundle */
type Game = any;

/** Frame height above the feet, hip corners, feet homes, leg segment lengths (m). */
const HIP_H = 6.4;
const HIP = { x: 3.2, z: 2.0 };
const FOOT = { x: 4.3, z: 2.7 };
const L1 = 4.4;
const L2 = 4.3;
/** The kingpost lifts the upper works this far over the frame, and the girder sits this far forward of the slewing
 *  ring (a counterweight balances it behind), so the cores clear the frame's beams from the apron at any heading. */
const KING = 2.4;
const REACH = 1.1;
const ANKLE = 0.45;
const STEP_T = 0.44;
/** The legs, as (side x, side z): diagonal pairs 0+3 and 1+2 step together. */
const LEGS = [
  [-1, -1],
  [1, -1],
  [-1, 1],
  [1, 1],
] as const;
const PAIRS = [
  [0, 3],
  [1, 2],
] as const;

const COLD = [0.62, 0.84, 1.0];
const AMBER = [1.0, 0.6, 0.2];
const RED = [1.0, 0.16, 0.06];

const smooth = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

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
  const rot = (g: any, rx: number, ry: number, rz: number) => {
    if (rx || ry || rz) g.applyMatrix4(new T.Matrix4().makeRotationFromEuler(new T.Euler(rx, ry, rz)));
    return g;
  };
  return {
    box(mat: any, w: number, h: number, d: number, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0) {
      return add(mat, rot(new T.BoxGeometry(w, h, d), rx, ry, rz).translate(x, y, z));
    },
    cyl(mat: any, r0: number, r1: number, h: number, x: number, y: number, z: number, axis: "x" | "y" | "z" = "y", seg = 14) {
      const g = new T.CylinderGeometry(r0, r1, h, seg);
      if (axis === "x") g.rotateZ(Math.PI / 2);
      if (axis === "z") g.rotateX(Math.PI / 2);
      return add(mat, g.translate(x, y, z));
    },
    /** A round bar from a to b. */
    bar(mat: any, a: number[], b: number[], r: number, seg = 6) {
      const A = new T.Vector3(a[0], a[1], a[2]),
        B = new T.Vector3(b[0], b[1], b[2]);
      const len = A.distanceTo(B);
      const g = new T.CylinderGeometry(r, r, len, seg);
      const q = new T.Quaternion().setFromUnitVectors(new T.Vector3(0, 1, 0), B.clone().sub(A).normalize());
      g.applyQuaternion(q);
      const m = A.add(B).multiplyScalar(0.5);
      return add(mat, g.translate(m.x, m.y, m.z));
    },
    add,
    build(group: any, { cast = true, recv = true } = {}) {
      const meshes: any[] = [];
      for (const [mat, geos] of lists) {
        const mesh = new T.Mesh(merge(T, geos), mat);
        mesh.castShadow = cast;
        mesh.receiveShadow = recv;
        group.add(mesh);
        meshes.push(mesh);
      }
      lists.clear();
      return meshes;
    },
  };
}

/** An additive shader for the beam, the ground spot and the rings. */
function glowMaterial(T: any, kind: "cone" | "spot" | "ring") {
  const frag = {
    cone: `
      float f = abs(dot(normalize(vN), normalize(vV)));
      f = f * f * (3.0 - 2.0 * f);
      float t = clamp(vP.z, 0.0, 1.0);
      float k = pow(1.0 - t, 1.5) * smoothstep(0.0, 0.05, t);
      gl_FragColor = vec4(uColor * (uGain * f * k), 1.0);`,
    spot: `
      float d = length(vP.xy);
      float k = smoothstep(1.0, 0.35, d) * (0.6 + 0.4 * smoothstep(1.0, 0.0, d));
      gl_FragColor = vec4(uColor * (uGain * k), 1.0);`,
    ring: `
      float d = length(vP.xz);
      float k = smoothstep(0.80, 0.97, d) * smoothstep(1.0, 0.97, d) + 0.35 * smoothstep(0.55, 0.97, d) * step(d, 1.0);
      gl_FragColor = vec4(uColor * (uGain * k), 1.0);`,
  }[kind];
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
      void main() {${frag}
      }`,
    transparent: true,
    blending: T.AdditiveBlending,
    depthWrite: false,
    side: T.DoubleSide,
    fog: false,
    toneMapped: false,
  });
}

export function createModel(G: Game, cores: number, start: { x: number; z: number }): Body {
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
  const glass = mats.emissive(0x8fd3ff, 1.1);

  const root = new T.Group();
  root.name = "assessor";
  G.scene.add(root);

  // ---- the frame (doesn't slew) ----
  const frame = new T.Group();
  root.add(frame);
  {
    const k = kit(T);
    for (const sx of [-1, 1]) {
      k.box(M.yellow, 0.85, 0.95, 2 * HIP.z + 0.9, sx * HIP.x, 0.1, 0);
      for (const sz of [-1, 1]) {
        k.box(M.hazard, 0.88, 0.98, 0.34, sx * HIP.x, 0.1, sz * (HIP.z + 0.46));
        k.cyl(M.dark, 0.56, 0.56, 1.02, sx * HIP.x, -0.2, sz * HIP.z, "x", 16);
        k.cyl(M.worn, 0.3, 0.3, 1.1, sx * HIP.x, -0.2, sz * HIP.z, "x", 10);
      }
      k.box(M.worn, 1.1, 0.55, 0.8, sx * 2.1, 0.85, 1.1);
      k.box(M.dark, 0.7, 0.4, 1.2, sx * 2.0, 0.78, -1.0);
    }
    for (const sz of [-1, 1]) k.box(M.yellow, 2 * HIP.x - 0.85, 0.75, 0.7, 0, 0.15, sz * HIP.z);
    k.box(M.dark, 6.2, 0.16, 3.0, 0, 0.5, 0);
    k.cyl(M.dark, 1.5, 1.6, 0.42, 0, 0.72, 0, "y", 28);
    k.cyl(M.rust, 1.62, 1.62, 0.1, 0, 0.55, 0, "y", 28);
    // The kingpost lifts the upper works clear of the frame, so the cores show from the apron.
    k.cyl(M.dark, 0.85, 1.1, KING - 0.9, 0, 0.9 + (KING - 0.9) / 2, 0, "y", 20);
    k.cyl(M.yellow, 0.95, 0.95, 0.22, 0, KING - 0.12, 0, "y", 20);
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      k.box(M.worn, 0.08, KING - 1.1, 0.5, Math.cos(a) * 0.95, 0.9 + (KING - 0.9) / 2, Math.sin(a) * 0.95, 0, -a, 0);
    }
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + 0.4;
      k.bar(M.worn, [Math.cos(a) * 0.9, 0.55, Math.sin(a) * 0.9], [Math.cos(a) * 2.6, 0.55, Math.sin(a) * 1.6], 0.07);
    }
    k.build(frame);
  }

  // ---- the upper works (slew to face the player) ----
  const slew = new T.Group();
  slew.position.y = KING;
  frame.add(slew);
  const upper = new T.Group();
  upper.position.z = REACH;
  slew.add(upper);
  {
    // The counterweight behind the slewing ring.
    const k = kit(T);
    k.box(M.dark, 3.2, 1.3, 1.3, 0, 0.75, -1.25);
    k.box(M.hazard, 3.22, 0.24, 1.32, 0, 0.2, -1.25);
    k.box(M.worn, 1.2, 0.2, 2.6, 0, 0.1, -0.1);
    k.build(slew);
  }
  const coreX: number[] = [];
  const spread = Math.min(4.6, 0.64 * (cores - 1));
  for (let i = 0; i < cores; i++) coreX.push(cores === 1 ? 0 : -spread + (2 * spread * i) / (cores - 1));
  const GIRDER = { y0: 0.35, y1: 1.6, z: 0.58, half: 5.7 };
  const coreY = (GIRDER.y0 + GIRDER.y1) / 2;
  const lampPivot = new T.Group();
  lampPivot.position.set(0, -1.2, 2.62);
  upper.add(lampPivot);
  const lensMat = new T.MeshBasicMaterial({ color: new T.Color(1, 1, 1), toneMapped: true });
  const sideLensMat = mats.emissive(0xdff0ff, 5);
  const beaconMat = new T.MeshBasicMaterial({ color: new T.Color(1, 0.1, 0.05).multiplyScalar(6), toneMapped: true });
  {
    const k = kit(T);
    // Turntable and the main girder, with stiffeners, end caps and a walkway rail along the top.
    k.box(M.dark, 2.3, 0.36, 2.3, 0, 0.17, 0);
    k.box(M.yellow, 2 * GIRDER.half, GIRDER.y1 - GIRDER.y0, 2 * GIRDER.z, 0, coreY, 0);
    for (let x = -GIRDER.half + 0.6; x <= GIRDER.half - 0.5; x += 0.95)
      for (const sz of [-1, 1]) k.box(M.dark, 0.08, GIRDER.y1 - GIRDER.y0 + 0.02, 0.06, x, coreY, sz * (GIRDER.z + 0.02));
    for (const sx of [-1, 1]) k.box(M.hazard, 0.42, GIRDER.y1 - GIRDER.y0 + 0.04, 2 * GIRDER.z + 0.04, sx * (GIRDER.half - 0.2), coreY, 0);
    for (const sz of [-1, 1]) {
      k.bar(M.worn, [-GIRDER.half + 0.3, GIRDER.y1 + 0.95, sz * 0.5], [GIRDER.half - 0.3, GIRDER.y1 + 0.95, sz * 0.5], 0.03);
      k.bar(M.worn, [-GIRDER.half + 0.3, GIRDER.y1 + 0.5, sz * 0.5], [GIRDER.half - 0.3, GIRDER.y1 + 0.5, sz * 0.5], 0.022);
      for (let x = -GIRDER.half + 0.3; x <= GIRDER.half - 0.2; x += 1.27)
        k.bar(M.worn, [x, GIRDER.y1, sz * 0.5], [x, GIRDER.y1 + 0.97, sz * 0.5], 0.028);
    }
    k.box(M.dark, 2 * GIRDER.half - 0.6, 0.05, 1.0, 0, GIRDER.y1 + 0.03, 0);
    // The machinery house, louvres, stack and mast.
    k.box(M.yellow, 3.4, 1.7, 2.5, 0, GIRDER.y1 + 0.85, -0.2);
    k.box(M.dark, 3.62, 0.16, 2.72, 0, GIRDER.y1 + 1.78, -0.2);
    for (const sx of [-1, 1]) for (let i = 0; i < 5; i++) k.box(M.dark, 0.05, 0.08, 1.5, sx * 1.72, GIRDER.y1 + 0.55 + i * 0.17, -0.25);
    k.box(M.hazard, 3.42, 0.22, 2.52, 0, GIRDER.y1 + 0.12, -0.2);
    k.cyl(M.worn, 0.17, 0.2, 1.3, 1.15, GIRDER.y1 + 2.4, -0.95, "y", 10);
    k.cyl(M.dark, 0.22, 0.22, 0.12, 1.15, GIRDER.y1 + 3.08, -0.95, "y", 10);
    k.cyl(M.worn, 0.05, 0.05, 2.4, -1.25, GIRDER.y1 + 3.0, -0.75, "y", 6);
    k.add(beaconMat, new T.SphereGeometry(0.11, 10, 8).translate(-1.25, GIRDER.y1 + 4.25, -0.75));
    // The cab hangs under the girder's front, on four struts, windows lit from inside: the Harbormaster is in.
    for (const sx of [-0.75, 0.75]) for (const sz of [0.75, 1.95]) k.bar(M.dark, [sx, GIRDER.y0, Math.min(sz, 0.55)], [sx, -0.3, sz], 0.07);
    k.box(M.dark, 1.9, 1.3, 1.6, 0, -0.95, 1.45);
    k.box(M.yellow, 2.0, 0.16, 1.7, 0, -0.27, 1.45);
    k.box(M.hazard, 2.0, 0.18, 1.7, 0, -1.62, 1.45);
    k.add(glass, new T.BoxGeometry(1.55, 0.5, 0.04).translate(0, -0.7, 2.26));
    for (const sx of [-1, 1]) k.add(glass, new T.BoxGeometry(0.04, 0.44, 1.0).translate(sx * 0.96, -0.7, 1.55));
    // The lamp's yoke, from the cab's front.
    for (const sx of [-1, 1]) k.bar(M.worn, [sx * 0.62, -1.2, 2.2], [sx * 0.62, -1.2, 2.62], 0.06);
    k.box(M.dark, 1.4, 0.3, 0.12, 0, -1.2, 2.2);
    // Inspection lamps hung under the girder.
    for (const x of [-4.4, -2.5, 2.5, 4.4]) {
      k.bar(M.dark, [x, GIRDER.y0, 0.2], [x, GIRDER.y0 - 0.55, 0.35], 0.035);
      k.cyl(M.dark, 0.2, 0.26, 0.36, x, GIRDER.y0 - 0.7, 0.4, "y", 12);
      k.add(sideLensMat, new T.CircleGeometry(0.22, 14).rotateX(Math.PI / 2 + 0.5).translate(x, GIRDER.y0 - 0.89, 0.46));
    }
    // Bolt throwers at the girder ends.
    for (const sx of [-1, 1]) {
      k.box(M.dark, 0.75, 0.6, 1.0, sx * 4.95, GIRDER.y0 - 0.25, 0.75);
      for (const dx of [-0.17, 0.17]) k.cyl(M.worn, 0.09, 0.1, 1.0, sx * 4.95 + dx, GIRDER.y0 - 0.25, 1.65, "z", 8);
      k.box(M.hazard, 0.77, 0.12, 1.02, sx * 4.95, GIRDER.y0 + 0.02, 0.75);
    }
    // Core sockets: a backplate, a housing ring and four bolts each.
    for (const x of coreX) {
      k.box(M.worn, 0.9, 0.98, 0.06, x, coreY, GIRDER.z + 0.02);
      k.cyl(M.dark, 0.4, 0.42, 0.24, x, coreY, GIRDER.z + 0.14, "z", 18);
      for (const [bx, by] of [
        [-0.36, -0.36],
        [0.36, -0.36],
        [-0.36, 0.36],
        [0.36, 0.36],
      ])
        k.cyl(M.worn, 0.045, 0.045, 0.08, x + bx, coreY + by, GIRDER.z + 0.08, "z", 6);
    }
    k.build(upper);
    // The lamp head (aims on its own).
    const l = kit(T);
    l.cyl(M.dark, 0.5, 0.42, 0.78, 0, 0, 0, "z", 20);
    l.cyl(M.worn, 0.56, 0.56, 0.12, 0, 0, 0.38, "z", 20);
    l.cyl(M.worn, 0.12, 0.12, 1.36, 0, 0, 0, "x", 8);
    for (let i = 0; i < 6; i++) l.box(M.dark, 0.04, 0.5, 0.3, 0, 0, -0.3, 0, 0, (i / 6) * Math.PI);
    l.add(lensMat, new T.CircleGeometry(0.46, 24).translate(0, 0, 0.445));
    l.build(lampPivot, { cast: true, recv: false });
  }
  // Stencils: the paperwork names its makers.
  try {
    const lab = mats.label("FINAL NOTICE", { color: "black", font: "stencil", distress: 0.35 });
    const h = 0.42,
      w = Math.min(2.2, h * (lab.aspect || 5));
    for (const sx of [-1, 1]) {
      const p = new T.Mesh(new T.PlaneGeometry(w, h), lab.material);
      p.position.set(sx * 1.715, GIRDER.y1 + 1.25, -0.2);
      p.rotation.y = (sx * Math.PI) / 2;
      upper.add(p);
    }
    const lab2 = mats.label("ASSESSOR 01", { color: "black", font: "stencil", distress: 0.35 });
    const w2 = Math.min(4.2, 0.6 * (lab2.aspect || 6));
    const p2 = new T.Mesh(new T.PlaneGeometry(w2, 0.6), lab2.material);
    p2.position.set(0, coreY, -GIRDER.z - 0.01);
    p2.rotation.y = Math.PI;
    upper.add(p2);
  } catch {
    /* labels are decoration */
  }

  // ---- the cores ----
  const coreMats: any[] = [];
  const coreMeshes: any[] = [];
  const coreState: { s: CoreState; t: number }[] = [];
  const coreGeo = new T.SphereGeometry(0.3, 18, 12);
  for (let i = 0; i < cores; i++) {
    const m = new T.MeshBasicMaterial({ color: new T.Color(1, 0.6, 0.16), toneMapped: true });
    const mesh = new T.Mesh(coreGeo, m);
    mesh.position.set(coreX[i], coreY, GIRDER.z + 0.24);
    mesh.scale.set(1, 1, 0.8);
    upper.add(mesh);
    coreMats.push(m);
    coreMeshes.push(mesh);
    coreState.push({ s: "live", t: 0 });
  }

  // ---- the legs ----
  const legs = LEGS.map(([sx, sz]) => {
    const thigh = new T.Group(),
      shin = new T.Group(),
      foot = new T.Group();
    root.add(thigh, shin, foot);
    const a = kit(T);
    a.box(M.yellow, 0.8, L1 - 0.9, 0.8, 0, L1 / 2, 0);
    a.box(M.hazard, 0.84, 0.5, 0.84, 0, 0.7, 0);
    a.cyl(M.dark, 0.48, 0.48, 0.96, 0, L1, 0, "x", 16);
    for (const s of [-1, 1]) a.bar(M.dark, [s * 0.42, 0.7, -0.3], [s * 0.42, L1 - 0.6, 0.3], 0.045);
    a.cyl(M.worn, 0.14, 0.14, L1 - 1.6, 0, L1 / 2, sx * sz > 0 ? 0.55 : -0.55, "y", 8);
    a.build(thigh);
    const b = kit(T);
    b.box(M.yellow, 0.64, L2 - 1.5, 0.64, 0, (L2 - 1.5) / 2 + 0.3, 0);
    b.box(M.hazard, 0.68, 0.9, 0.68, 0, L2 - 0.75, 0);
    b.cyl(M.dark, 0.36, 0.36, 0.86, 0, L2, 0, "x", 14);
    b.cyl(M.worn, 0.11, 0.11, L2 - 1.8, 0.0, L2 / 2, sx * sz > 0 ? -0.42 : 0.42, "y", 8);
    b.box(M.rust, 0.5, 0.5, 0.5, 0, 0.1, 0);
    b.build(shin);
    const c = kit(T);
    c.box(M.dark, 1.3, 0.32, 1.3, 0, 0.26, 0);
    c.box(M.rubber, 1.44, 0.1, 1.44, 0, 0.05, 0);
    c.box(M.hazard, 1.32, 0.1, 1.32, 0, 0.47, 0);
    c.cyl(M.worn, 0.3, 0.36, 0.3, 0, ANKLE, 0, "y", 12);
    c.build(foot);
    const home = { x: start.x + sx * FOOT.x, z: start.z + sz * FOOT.z };
    const plant = new T.Vector3(home.x, 0, home.z);
    return {
      sx,
      sz,
      thigh,
      shin,
      foot,
      plant,
      pos: plant.clone(),
      from: plant.clone(),
      to: plant.clone(),
      peak: 0,
      t: -1,
      box: null as any,
    };
  });

  // ---- the beam, its spot on the ground, the shockwave rings ----
  const coneGeo = new T.ConeGeometry(1, 1, 28, 1, true).translate(0, -0.5, 0).rotateX(-Math.PI / 2);
  const coneMat = glowMaterial(T, "cone");
  const cone = new T.Mesh(coneGeo, coneMat);
  cone.frustumCulled = false;
  cone.renderOrder = 6;
  G.scene.add(cone);
  const spotMat = glowMaterial(T, "spot");
  const spot = new T.Mesh(new T.CircleGeometry(1, 40), spotMat);
  spot.frustumCulled = false;
  spot.renderOrder = 5;
  G.scene.add(spot);
  const ringGeo = new T.RingGeometry(0.0, 1.0, 72, 1).rotateX(-Math.PI / 2);
  const rings = [0, 1, 2, 3].map(() => {
    const m = glowMaterial(T, "ring");
    const mesh = new T.Mesh(ringGeo, m);
    mesh.visible = false;
    mesh.frustumCulled = false;
    mesh.renderOrder = 5;
    G.scene.add(mesh);
    return { mesh, m, t: -1, warn: false };
  });
  let light: any = null;
  try {
    light = G.render?.lightPool?.acquire?.() ?? null;
    if (light?.light) light.light.distance = 14;
  } catch {
    light = null;
  }
  let servo: any = null;
  try {
    servo = G.audio?.loop?.("hound_servo", { pos: [start.x, 8, start.z], gain: 0.7 }) ?? null;
    servo?.setPitch?.(0.42);
  } catch {
    servo = null;
  }

  // ---- hit volumes ----
  type Vol = { obj: any; min: number[]; max: number[] };
  const vols: Vol[] = [
    { obj: upper, min: [-GIRDER.half, GIRDER.y0, -GIRDER.z], max: [GIRDER.half, GIRDER.y1, GIRDER.z] },
    { obj: upper, min: [-1.75, GIRDER.y1, -1.5], max: [1.75, GIRDER.y1 + 1.85, 1.1] },
    { obj: upper, min: [-0.95, -1.7, 0.6], max: [0.95, -0.2, 2.3] },
    { obj: upper, min: [-5.35, GIRDER.y0 - 0.55, 0.25], max: [-4.55, GIRDER.y0, 2.15] },
    { obj: upper, min: [4.55, GIRDER.y0 - 0.55, 0.25], max: [5.35, GIRDER.y0, 2.15] },
    { obj: lampPivot, min: [-0.56, -0.56, -0.45], max: [0.56, 0.56, 0.45] },
    // The frame, beam by beam: the front cross beam must not hide the cores behind a box that isn't there.
    { obj: frame, min: [-HIP.x - 0.45, -0.75, -HIP.z - 0.65], max: [-HIP.x + 0.45, 0.6, HIP.z + 0.65] },
    { obj: frame, min: [HIP.x - 0.45, -0.75, -HIP.z - 0.65], max: [HIP.x + 0.45, 0.6, HIP.z + 0.65] },
    { obj: frame, min: [-HIP.x, -0.23, -HIP.z - 0.36], max: [HIP.x, 0.53, -HIP.z + 0.36] },
    { obj: frame, min: [-HIP.x, -0.23, HIP.z - 0.36], max: [HIP.x, 0.53, HIP.z + 0.36] },
    { obj: frame, min: [-1.6, 0.4, -1.6], max: [1.6, 0.95, 1.6] },
    { obj: frame, min: [-1.05, 0.95, -1.05], max: [1.05, KING, 1.05] },
    { obj: slew, min: [-1.6, 0.1, -1.9], max: [1.6, 1.4, -0.6] },
  ];
  for (const leg of legs) {
    vols.push({ obj: leg.thigh, min: [-0.45, 0, -0.45], max: [0.45, L1, 0.45] });
    vols.push({ obj: leg.shin, min: [-0.36, 0, -0.36], max: [0.36, L2, 0.36] });
    vols.push({ obj: leg.foot, min: [-0.72, 0, -0.72], max: [0.72, 0.65, 0.72] });
  }
  const inv = new T.Matrix4(),
    lo = new T.Vector3(),
    ld = new T.Vector3(),
    wp = new T.Vector3(),
    q0 = new T.Quaternion(),
    q1 = new T.Quaternion(),
    v0 = new T.Vector3(),
    v1 = new T.Vector3(),
    v2 = new T.Vector3(),
    Z = new T.Vector3(0, 0, 1),
    Y = new T.Vector3(0, 1, 0),
    basis = new T.Matrix4();

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

  // ---- ground under a foot ----
  function groundAt(x: number, z: number): number {
    let y = 0;
    for (const b of G.physics?.boxes ?? []) {
      if (b.playerOnly || b.bulletOnly || b.max.y > 8 || b.max.y - b.min.y < 0.2) continue;
      if (b.max.x - b.min.x < 0.9 || b.max.z - b.min.z < 0.9) continue;
      if (x >= b.min.x && x <= b.max.x && z >= b.min.z && z <= b.max.z && b.max.y > y) y = b.max.y;
    }
    return y;
  }

  // ---- state ----
  const body = new T.Vector3(start.x, HIP_H, start.z);
  const pos = { x: start.x, y: 0, z: start.z };
  const vel = new T.Vector3();
  const last = { x: start.x, z: start.z };
  let pitch = 0,
    roll = 0,
    time = 0,
    deadSmoke = 0,
    slumpFx = 0;
  let turnPair = 0;
  for (const leg of legs) leg.plant.y = leg.pos.y = groundAt(leg.plant.x, leg.plant.z);

  function stepSound(p: V3, heavy: number) {
    try {
      G.audio?.play?.("hound_step", { pos: { x: p.x, y: p.y, z: p.z }, pitch: 0.42, gain: 1, ref: 9, jitter: 0.06 });
      G.audio?.play?.("impact_metal", { pos: { x: p.x, y: p.y, z: p.z }, pitch: 0.42, gain: 0.55 * heavy, ref: 8, jitter: 0.05 });
      G.fx?.dust?.(new T.Vector3(p.x, p.y + 0.05, p.z), Y, 1.6, 0.42, 0.4, 0.37);
      const P = G.player;
      if (P?.pos && P.addShake) {
        const d = Math.hypot(P.pos.x - p.x, P.pos.z - p.z);
        if (d < 28) P.addShake(0.16 * heavy * (1 - d / 28));
      }
    } catch {
      /* decoration */
    }
  }

  function solveLeg(leg: (typeof legs)[number], hip: any, ankle: any) {
    v0.subVectors(ankle, hip);
    let d = v0.length();
    d = Math.max(Math.abs(L1 - L2) + 0.05, Math.min(L1 + L2 - 0.02, d));
    v0.normalize();
    const a = (L1 * L1 - L2 * L2 + d * d) / (2 * d);
    const h = Math.sqrt(Math.max(0, L1 * L1 - a * a));
    // Knees bend outward and up, like a crab's.
    v1.set(leg.sx, 0.7, 0).applyQuaternion(frame.quaternion);
    v1.addScaledVector(v0, -v1.dot(v0)).normalize();
    const knee = v2.copy(hip).addScaledVector(v0, a).addScaledVector(v1, h);
    leg.thigh.position.copy(hip);
    leg.thigh.quaternion.setFromUnitVectors(Y, wp.subVectors(knee, hip).normalize());
    leg.shin.position.copy(knee);
    const end = wp.copy(hip).addScaledVector(v0, d);
    leg.shin.quaternion.setFromUnitVectors(Y, end.sub(knee).normalize());
  }

  function placeLight(on: number, color: number[], at: any, n: any) {
    if (!light?.light) return;
    light.light.position.copy(at).addScaledVector(n, 1.4);
    light.light.color.setRGB(color[0], color[1], color[2]);
    light.light.intensity += (on * 55 - light.light.intensity) * 0.3;
  }

  return {
    pos,
    feet: legs.length,
    lamp(out) {
      lampPivot.getWorldPosition(wp);
      wp.addScaledVector(v0.set(0, 0, 0.5).applyQuaternion(lampPivot.getWorldQuaternion(q0)), 1);
      out.x = wp.x;
      out.y = wp.y;
      out.z = wp.z;
      return out;
    },
    muzzle(i, out) {
      wp.set(i % 2 === 0 ? -4.95 : 4.95, GIRDER.y0 - 0.25, 2.2);
      upper.localToWorld(wp);
      out.x = wp.x;
      out.y = wp.y;
      out.z = wp.z;
      return out;
    },
    core(i, out) {
      coreMeshes[i]?.getWorldPosition(wp);
      out.x = wp.x;
      out.y = wp.y;
      out.z = wp.z;
      return out;
    },
    foot(i, out) {
      const p = legs[i]?.plant;
      out.x = p?.x ?? pos.x;
      out.y = p?.y ?? 0;
      out.z = p?.z ?? pos.z;
      return out;
    },
    raycast(o, d, max) {
      let best: BodyHit | null = null;
      for (let i = 0; i < cores; i++) {
        if (coreState[i].s === "dark") continue;
        coreMeshes[i].getWorldPosition(wp);
        // Ray against a sphere a little bigger than the core: its housing catches the near misses.
        const ox = o.x - wp.x,
          oy = o.y - wp.y,
          oz = o.z - wp.z;
        const b = ox * d.x + oy * d.y + oz * d.z;
        const c = ox * ox + oy * oy + oz * oz - 0.42 * 0.42;
        const disc = b * b - c;
        if (disc < 0) continue;
        const t = -b - Math.sqrt(disc);
        if (t > 0 && t < max && (!best || t < best.dist)) {
          const px = o.x + d.x * t,
            py = o.y + d.y * t,
            pz = o.z + d.z * t;
          const l = Math.hypot(px - wp.x, py - wp.y, pz - wp.z) || 1;
          best = {
            dist: t,
            point: { x: px, y: py, z: pz },
            normal: { x: (px - wp.x) / l, y: (py - wp.y) / l, z: (pz - wp.z) / l },
            core: i,
          };
        }
      }
      vols.forEach((v, k) => {
        const h = rayBox(o, d, v, best ? best.dist : max);
        if (!h || h.t <= 0 || (best && h.t >= best.dist)) return;
        const n = v0.set(0, 0, 0);
        n.setComponent(h.axis, h.sign);
        n.transformDirection(v.obj.matrixWorld);
        best = {
          dist: h.t,
          point: { x: o.x + d.x * h.t, y: o.y + d.y * h.t, z: o.z + d.z * h.t },
          normal: { x: n.x, y: n.y, z: n.z },
          core: -1,
          part: k,
        };
      });
      return best;
    },
    setCore(i, s) {
      const c = coreState[i];
      if (!c || c.s === "dark") return;
      if (s === "dark") {
        c.s = "dark";
        c.t = 0;
        coreMeshes[i].getWorldPosition(wp);
        upper.getWorldDirection(v1);
        try {
          G.fx?.sparks?.(wp.clone(), v1.clone(), 26);
          G.fx?.explosion?.(wp.clone(), 0.55);
          G.fx?.debris?.(wp.clone(), { normal: v1.clone(), count: 10, size: 0.08, speed: 6, mat: "steel_dark" });
          G.render?.lightPool?.flash?.(wp.clone(), 0xffb050, 120, 12, 0.18);
        } catch {
          /* decoration */
        }
      } else {
        c.s = s;
        c.t = 0;
      }
    },
    shockwave(x, z) {
      const r = rings.find((q) => q.t < 0 && !q.warn) ?? rings[0];
      r.t = 0;
      r.mesh.position.set(x, groundAt(x, z) + 0.06, z);
      r.mesh.visible = true;
      try {
        const p = new T.Vector3(x, 0.1, z);
        G.fx?.dust?.(p, Y, 3.2, 0.4, 0.38, 0.35);
        G.fx?.smoke?.(p, { size: 2.6, life: 2.2, rise: 0.4, count: 5, alpha: 0.35 });
        G.render?.lightPool?.flash?.(new T.Vector3(x, 1.2, z), 0xffc070, 70, 14, 0.12);
      } catch {
        /* decoration */
      }
    },
    update(dt, drive) {
      time += dt;
      const s = drive.slump;
      // Where the body is going, and how fast.
      const vx = (drive.at.x - last.x) / Math.max(dt, 1e-3),
        vz = (drive.at.z - last.z) / Math.max(dt, 1e-3);
      vel.x += (vx - vel.x) * Math.min(1, dt * 6);
      vel.z += (vz - vel.z) * Math.min(1, dt * 6);
      last.x = drive.at.x;
      last.z = drive.at.z;
      body.x = drive.at.x;
      body.z = drive.at.z;
      pos.x = body.x;
      pos.z = body.z;

      // ---- the gait: diagonal pairs, a pair only steps while the other is planted ----
      const moving = Math.hypot(vel.x, vel.z) > 0.15 && drive.phase === "arriving";
      const stepping = legs.some((l) => l.t >= 0);
      if (!stepping && drive.phase !== "dying" && drive.phase !== "dead") {
        let worst = -1,
          err = 0;
        for (let p = 0; p < 2; p++) {
          const pair = PAIRS[(turnPair + p) % 2];
          let e = 0;
          for (const i of pair) {
            const l = legs[i];
            const hx = body.x + l.sx * FOOT.x + (moving ? vel.x * 0.45 : 0),
              hz = body.z + l.sz * FOOT.z + (moving ? vel.z * 0.45 : 0);
            e = Math.max(e, Math.hypot(l.plant.x - hx, l.plant.z - hz));
          }
          if (e > err) ((err = e), (worst = (turnPair + p) % 2));
        }
        if (worst >= 0 && err > (moving ? 1.0 : 0.35)) {
          turnPair = 1 - worst;
          for (const i of PAIRS[worst]) {
            const l = legs[i];
            l.from.copy(l.plant);
            l.to.set(body.x + l.sx * FOOT.x + (moving ? vel.x * 0.5 : 0), 0, body.z + l.sz * FOOT.z + (moving ? vel.z * 0.5 : 0));
            l.to.y = groundAt(l.to.x, l.to.z);
            const mid = groundAt((l.from.x + l.to.x) / 2, (l.from.z + l.to.z) / 2);
            l.peak = Math.max(l.from.y, l.to.y, mid) + 1.0;
            l.t = 0;
          }
        }
      }
      for (const l of legs) {
        if (l.t < 0) {
          l.pos.copy(l.plant);
          continue;
        }
        l.t += dt / STEP_T;
        const k = smooth(Math.min(1, l.t));
        l.pos.lerpVectors(l.from, l.to, k);
        const arc = Math.sin(Math.min(1, l.t) * Math.PI);
        const base = lerp(l.from.y, l.to.y, k);
        l.pos.y = base + arc * Math.max(0.6, l.peak - base);
        if (l.t >= 1) {
          l.t = -1;
          l.plant.copy(l.to);
          l.pos.copy(l.plant);
          stepSound(l.plant, 1);
        }
      }
      // A stamp lifts one foot high, then slams it back where it stood.
      if (drive.stamp) {
        const l = legs[drive.stamp.foot];
        if (l) {
          const lift = drive.stamp.lift;
          l.pos.copy(l.plant);
          l.pos.y += lift * 2.8;
          l.pos.x += l.sx * lift * 0.5;
        }
      }
      // The slump: the water-side legs buckle outward.
      if (s > 0)
        for (const l of legs)
          if (l.sx > 0) {
            l.pos.copy(l.plant);
            l.pos.x += 1.7 * s;
          }

      // ---- the frame rides on its feet ----
      const fy = legs.reduce((n, l) => n + l.plant.y, 0) / legs.length;
      const bob = drive.phase === "arriving" ? Math.abs(Math.sin(time * 7.2)) * 0.12 * Math.min(1, Math.hypot(vel.x, vel.z) / 3) : Math.sin(time * 1.3) * 0.05;
      const lean = drive.stamp ? drive.stamp.lift * 0.35 : 0;
      body.y = lerp(body.y, fy + HIP_H - lean - 3.4 * s + bob, Math.min(1, dt * 5));
      const left = (legs[0].plant.y + legs[2].plant.y) / 2,
        right = (legs[1].plant.y + legs[3].plant.y) / 2,
        back = (legs[0].plant.y + legs[1].plant.y) / 2,
        front = (legs[2].plant.y + legs[3].plant.y) / 2;
      const stampTilt = drive.stamp ? drive.stamp.lift * 0.06 : 0;
      const wantRoll = Math.max(-0.3, Math.min(0.3, Math.atan2(right - left, 2 * FOOT.x))) - 0.42 * s + (drive.stamp ? -legs[drive.stamp.foot].sx * stampTilt : 0);
      const wantPitch = Math.max(-0.3, Math.min(0.3, Math.atan2(front - back, 2 * FOOT.z))) * -1 + 0.12 * s + (drive.stamp ? legs[drive.stamp.foot].sz * stampTilt : 0);
      roll = lerp(roll, wantRoll, Math.min(1, dt * 3));
      pitch = lerp(pitch, wantPitch, Math.min(1, dt * 3));
      frame.position.copy(body);
      frame.rotation.set(pitch, 0, roll, "YXZ");
      slew.rotation.set(0, drive.yaw, 0);
      upper.rotation.set(0.28 * s, 0, 0);
      root.updateMatrixWorld(true);

      // ---- legs ----
      for (const l of legs) {
        wp.set(l.sx * HIP.x, -0.2, l.sz * HIP.z);
        frame.localToWorld(wp);
        v2.set(l.pos.x, l.pos.y + ANKLE, l.pos.z);
        const hip = wp.clone();
        solveLeg(l, hip, v2.clone());
        l.foot.position.copy(l.pos);
        l.foot.rotation.set(0, 0, l.sx > 0 ? -0.5 * s : 0);
      }

      // ---- the lamp ----
      const B = drive.beam;
      const heat = B.heat;
      const col = B.lock ? RED : heat < 0.6 ? COLD.map((c, i) => lerp(c, AMBER[i], heat / 0.6)) : AMBER.map((c, i) => lerp(c, RED[i], (heat - 0.6) / 0.4));
      v1.set(B.dir.x, B.dir.y, B.dir.z).normalize();
      upper.getWorldQuaternion(q0);
      q1.setFromUnitVectors(Z, v1);
      lampPivot.quaternion.copy(q0.invert().multiply(q1));
      lampPivot.updateMatrixWorld(true);
      const on = Math.max(0, Math.min(1, B.on)) * (B.lock ? 1.5 : 1);
      lensMat.color.setRGB(col[0], col[1], col[2]).multiplyScalar((drive.phase === "dead" ? 0.04 : 1.5) + 12 * on);
      const L = Math.max(1, B.length);
      const rad = Math.tan(0.17) * L;
      lampPivot.getWorldPosition(wp);
      wp.addScaledVector(v1, 0.46);
      cone.position.copy(wp);
      cone.quaternion.copy(q1);
      cone.scale.set(rad, rad, L);
      cone.visible = on > 0.01;
      coneMat.uniforms.uColor.value.setRGB(col[0], col[1], col[2]);
      coneMat.uniforms.uGain.value = 0.55 * on;
      // The spot where the beam lands, and a light there.
      const hit = v2.copy(wp).addScaledVector(v1, L);
      let n = Y;
      try {
        const h = G.physics.raycast(wp, v1, L + 0.5);
        if (h?.normal) n = v0.set(h.normal.x, h.normal.y, h.normal.z);
      } catch {
        /* the ground is up */
      }
      const ux = v1.x - n.x * v1.dot(n),
        uy = v1.y - n.y * v1.dot(n),
        uz = v1.z - n.z * v1.dot(n);
      const ul = Math.hypot(ux, uy, uz);
      spot.visible = on > 0.01 && B.length < 45;
      if (spot.visible) {
        const U = new T.Vector3(ux, uy, uz).divideScalar(ul || 1);
        if (ul < 1e-3) U.set(1, 0, 0);
        const V = new T.Vector3().crossVectors(n, U);
        basis.makeBasis(U, V, n);
        spot.quaternion.setFromRotationMatrix(basis);
        const stretch = Math.min(4, 1 / Math.max(0.25, Math.abs(v1.dot(n))));
        spot.position.copy(hit).addScaledVector(n, 0.04);
        spot.scale.set(rad * stretch, rad, 1);
        spotMat.uniforms.uColor.value.setRGB(col[0], col[1], col[2]);
        spotMat.uniforms.uGain.value = 0.9 * on;
      }
      placeLight(on, col, hit, n);

      // ---- cores ----
      for (let i = 0; i < cores; i++) {
        const c = coreState[i];
        c.t += dt;
        const m = coreMats[i].color;
        if (c.s === "live") {
          const k = 2.6 + 0.9 * Math.sin(time * 3.1 + i * 1.7);
          m.setRGB(1 * k, 0.42 * k, 0.07 * k);
        } else if (c.s === "hit") m.setRGB(20, 17, 12);
        else {
          const k = Math.max(0.03, 1.6 * Math.exp(-c.t * 1.4));
          m.setRGB(1 * k, 0.22 * k, 0.07 * k);
          if (c.t < 3 && Math.floor((c.t - dt) * 4) !== Math.floor(c.t * 4)) {
            coreMeshes[i].getWorldPosition(wp);
            try {
              G.fx?.smoke?.(wp.clone(), { size: 0.8, life: 2.2, rise: 1.0, count: 1, alpha: 0.4 });
            } catch {
              /* decoration */
            }
          }
        }
      }
      beaconMat.color.setRGB(1, 0.1, 0.05).multiplyScalar(drive.phase === "dead" || drive.phase === "dying" ? 0.2 : Math.sin(time * 4) > 0 ? 9 : 0.6);

      // ---- rings: the stamp's warning, then its shockwave ----
      const warn = rings[3];
      warn.warn = true;
      if (drive.stamp && drive.stamp.lift > 0.02) {
        const l = legs[drive.stamp.foot];
        warn.mesh.visible = true;
        warn.mesh.position.set(l.plant.x, l.plant.y + 0.05, l.plant.z);
        const sc = 2.4 + 0.3 * Math.sin(time * 18);
        warn.mesh.scale.set(sc, 1, sc);
        warn.m.uniforms.uColor.value.setRGB(1, 0.2, 0.08);
        warn.m.uniforms.uGain.value = 1.2 * drive.stamp.lift;
      } else warn.mesh.visible = false;
      for (const r of rings) {
        if (r.warn || r.t < 0) continue;
        r.t += dt;
        const R = r.t * 13;
        if (R > 11.5) {
          r.t = -1;
          r.mesh.visible = false;
          continue;
        }
        r.mesh.scale.set(R, 1, R);
        r.m.uniforms.uColor.value.setRGB(1, 0.72, 0.4);
        r.m.uniforms.uGain.value = 1.4 * Math.pow(1 - R / 11.5, 0.7);
      }

      // ---- the slump's sparks and smoke ----
      if (drive.phase === "dying" || drive.phase === "dead") {
        if (s > slumpFx + 0.22 && slumpFx < 1) {
          slumpFx = s;
          try {
            const i = Math.floor(Math.random() * cores);
            coreMeshes[i].getWorldPosition(wp);
            G.fx?.explosion?.(wp.clone(), 0.8);
            G.fx?.sparks?.(wp.clone(), Y, 30);
            G.audio?.play?.("explosion", { pos: { x: wp.x, y: wp.y, z: wp.z }, pitch: 0.9, gain: 0.7 });
          } catch {
            /* decoration */
          }
        }
        if ((deadSmoke -= dt) <= 0) {
          deadSmoke = 0.2;
          wp.set(1.15, GIRDER.y1 + 3.1, -0.95);
          upper.localToWorld(wp);
          try {
            G.fx?.smoke?.(wp.clone(), { size: 2.2, life: 4.5, rise: 1.6, count: 1, alpha: 0.32, color: 0x26292c });
          } catch {
            /* decoration */
          }
        }
      }

      // ---- planted feet are steel the player can't walk through ----
      const planted = drive.phase !== "arriving";
      const P = G.player;
      for (const l of legs) {
        if (planted && !l.box && l.t < 0 && G.physics?.addBox) {
          const inside = P?.pos && Math.abs(P.pos.x - l.plant.x) < 1.2 && Math.abs(P.pos.z - l.plant.z) < 1.2;
          if (!inside)
            l.box = G.physics.addBox([l.plant.x - 0.75, l.plant.y, l.plant.z - 0.75], [l.plant.x + 0.75, l.plant.y + 3.2, l.plant.z + 0.75], {
              surface: "metal",
              tag: "assessor",
              playerOnly: true,
            });
        }
      }
      try {
        servo?.setPos?.([body.x, body.y, body.z]);
        servo?.setGain?.(drive.phase === "dead" ? 0 : moving ? 1 : 0.55);
        servo?.setPitch?.(moving ? 0.5 : 0.4);
      } catch {
        /* sound is never load-bearing */
      }
    },
    dispose() {
      for (const l of legs) if (l.box) G.physics?.removeBox?.(l.box);
      try {
        light?.release?.();
        servo?.stop?.(0.3);
      } catch {
        /* already gone */
      }
      for (const o of [root, cone, spot, ...rings.map((r) => r.mesh)]) {
        o.traverse?.((c: any) => {
          if (c.isMesh) c.geometry?.dispose?.();
        });
        o.removeFromParent();
      }
      for (const m of [coneMat, spotMat, lensMat, beaconMat, ...coreMats, ...rings.map((r) => r.m)]) m.dispose();
    },
  };
}
