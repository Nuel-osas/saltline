// The town across the water (docs/STORY.md → The arc): a low silhouette on the far shore south-east of the quay, and
// its lights. Dark in Act I; the clinic's tight cluster comes on when that district is lit, then the generators' wider
// spread across the whole town (windows, the waterfront lamps, the power station). Lights come on one by one over a
// few seconds when a district relights while the game is open.
//
// Built in code like everything else in the game: one merged mesh for the silhouette and one point cloud for the
// lights, two draw calls. The lights are HDR additive points (fog off; the post haze and bloom act on them), sized in
// screen pixels so they stay points at 700 m.
import type { TownRead } from "./town";

/* eslint-disable @typescript-eslint/no-explicit-any -- THREE and the game context come from the untyped bundle */
type Game = any;

export interface LightsState {
  clinic: boolean;
  generators: boolean;
}

export const DARK: Readonly<LightsState> = Object.freeze({ clinic: false, generators: false });

/**
 * What the far shore shows for a read: the districts that are lit. A chain without town() is the dark start; a failed
 * read is null, and the shore keeps what it shows (a dropped poll isn't a blackout).
 */
export function lightsOf(read: TownRead | null): LightsState | null {
  if (!read || read.status === "failed") return null;
  if (read.status === "missing") return { ...DARK };
  const lit = (id: string) => read.view.districts.some((d) => d.id === id && d.lit === true);
  return { clinic: lit("clinic"), generators: lit("generators") };
}

/**
 * Where the town sits: across the water from the quay (the boat is at x 31, z 21), about 570 m to the SSE, where the
 * backdrop's sea wall (x 398, running south from the lighthouse) ends. It fills the open horizon between the next
 * terminal south and the sea wall, which is what the title camera's last shots along the quay look at.
 */
export const TOWN = { x: 324, z: 503, span: 500, depth: 150 } as const;
const QUAY = { x: 30, z: 14 };

export interface TownLights {
  readonly root: unknown;
  readonly count: { clinic: number; generators: number; tris: number };
  /** Light the districts. `instant` skips the one-by-one switch-on (the first state of a page load). */
  set(s: LightsState, instant?: boolean): void;
  readonly state: LightsState;
  /** 0–1 per district: how far the switch-on has got. */
  readonly level: { clinic: number; generators: number };
  update(dt: number): void;
  dispose(): void;
}

// A small seeded generator, so the town is the same for every player.
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}

/** Linear HDR colours (the bloom picks out anything well above 1). */
const SODIUM = [1.0, 0.5, 0.18];
const WARM = [1.0, 0.7, 0.4];
const COOL = [0.72, 0.86, 1.0];
const GREEN = [0.25, 1.0, 0.45];

export function createTownLights(G: Game): TownLights | null {
  const T = G && G.THREE;
  if (!T || !G.scene) return null;
  const r = rng(40917);

  // The shore runs across the line of sight from the quay: u along the shore, v away from the viewer.
  const bearing = Math.atan2(TOWN.x - QUAY.x, TOWN.z - QUAY.z);
  const ax = Math.cos(bearing),
    az = -Math.sin(bearing);
  const bx = Math.sin(bearing),
    bz = Math.cos(bearing);
  const at = (u: number, v: number) => [TOWN.x + ax * u + bx * v, TOWN.z + az * u + bz * v] as const;

  // ---- silhouette ----
  const pos: number[] = [];
  const col: number[] = [];
  let tris = 0;
  /** A box (u0..u1 along the shore, v0..v1 away, y0..y1 up), faces the viewer can see only. */
  function box(u0: number, u1: number, v0: number, v1: number, y0: number, y1: number, shade: number) {
    const c = [0.03 * shade, 0.034 * shade, 0.042 * shade];
    const p = (u: number, v: number, y: number) => {
      const [x, z] = at(u, v);
      return [x, y, z];
    };
    const quad = (a: number[], b: number[], cc: number[], d: number[], k = 1) => {
      for (const q of [a, b, cc, a, cc, d]) pos.push(q[0], q[1], q[2]), col.push(c[0] * k, c[1] * k, c[2] * k);
      tris += 2;
    };
    // front (toward the quay), the two ends, the roof
    quad(p(u0, v0, y0), p(u1, v0, y0), p(u1, v0, y1), p(u0, v0, y1));
    quad(p(u0, v1, y0), p(u0, v0, y0), p(u0, v0, y1), p(u0, v1, y1), 0.85);
    quad(p(u1, v0, y0), p(u1, v1, y0), p(u1, v1, y1), p(u1, v0, y1), 0.85);
    quad(p(u0, v0, y1), p(u1, v0, y1), p(u1, v1, y1), p(u0, v1, y1), 1.15);
  }
  /** A pitched roof over a box, ridge along the shore. */
  function roof(u0: number, u1: number, v0: number, v1: number, y: number, h: number, shade: number) {
    const c = [0.028 * shade, 0.03 * shade, 0.036 * shade];
    const vm = (v0 + v1) / 2;
    const p = (u: number, v: number, yy: number) => {
      const [x, z] = at(u, v);
      return [x, yy, z];
    };
    const tri = (a: number[], b: number[], d: number[]) => {
      for (const q of [a, b, d]) pos.push(q[0], q[1], q[2]), col.push(c[0], c[1], c[2]);
      tris += 1;
    };
    const a0 = p(u0, v0, y),
      a1 = p(u1, v0, y),
      r0 = p(u0, vm, y + h),
      r1 = p(u1, vm, y + h),
      b0 = p(u0, v1, y),
      b1 = p(u1, v1, y);
    tri(a0, a1, r1), tri(a0, r1, r0); // the slope toward the quay
    tri(b1, b0, r0), tri(b1, r0, r1);
    tri(b0, a0, r0), tri(a1, b1, r1); // gables
  }

  // The land rises inland, so each street shows over the one in front of it.
  const half = TOWN.span / 2;
  const rise = (v: number) => Math.max(0, v) * 0.075;
  // The sea wall and the land behind it.
  box(-half - 40, half + 40, -6, TOWN.depth + 40, -1.6, 1.2, 0.9);
  box(-half - 40, half + 40, -8, -6, -1.6, 2.4, 1.2);
  // The hill's face, stepped, behind the last street.
  for (let k = 0; k < 4; k++) box(-half - 40, half + 40, 60 + k * 30, 90 + k * 30, 0, rise(90 + k * 30), 0.8);

  // ---- lights ----
  const lp: number[] = []; // position
  const lc: number[] = []; // colour (HDR)
  const la: number[] = []; // district (0 clinic, 1 generators), delay 0–1, size px, twinkle phase
  const counts = { clinic: 0, generators: 0, tris: 0 };
  function light(u: number, v: number, y: number, c: number[], k: number, district: 0 | 1, size: number) {
    const [x, z] = at(u, v - 0.6);
    lp.push(x, y, z);
    lc.push(c[0] * k, c[1] * k, c[2] * k);
    // The clinic comes on window by window; the generators sweep the town from the power station at the east end.
    const delay = district === 0 ? r() : Math.min(1, Math.max(0, (half - u) / TOWN.span) * 0.75 + r() * 0.25);
    la.push(district, delay, size, r() * 6.283);
    if (district === 0) counts.clinic++;
    else counts.generators++;
  }
  /** Lit windows on a building's front, a share of them. */
  function windows(u0: number, u1: number, v0: number, y0: number, y1: number, share: number, c: number[], k: number) {
    for (let y = y0 + 2.4; y < y1 - 1; y += 3.4)
      for (let u = u0 + 2; u < u1 - 1.5; u += 4.2)
        if (r() < share) light(u + (r() - 0.5), v0, y, c, k * (0.7 + r() * 0.5), 1, 2.4 + r() * 0.8);
  }
  /** A building on the hill: a block, maybe a pitched roof, and its windows. */
  function building(u: number, w: number, v0: number, d: number, h: number, pitched: boolean, share: number) {
    const g = rise(v0);
    box(u, u + w, v0, v0 + d, g - 1, g + h, 0.85 + r() * 0.3);
    if (pitched) roof(u, u + w, v0, v0 + d, g + h, 2.5 + r() * 2.5, 0.9);
    windows(u, u + w, v0, g, g + h, share, r() < 0.7 ? WARM : SODIUM, 30);
  }

  // The power station at the east end, by the sea wall: a hall, three stacks with beacons, a tank.
  const ps = half - 34;
  box(ps - 28, ps + 28, 26, 66, 0, 18, 1);
  for (const du of [-15, 0, 15]) box(ps + du - 2.4, ps + du + 2.4, 42, 46.8, 18, 52, 0.9);
  box(ps - 56, ps - 36, 30, 50, 0, 12, 0.8);
  for (const du of [-22, -10, 2, 14]) light(ps + du, 26, 14, SODIUM, 46, 1, 3.2);
  for (const du of [-15, 0, 15]) light(ps + du, 42, 50, [1, 0.2, 0.12], 34, 1, 2.6);

  // The cannery: a long shed on the water with two chimneys.
  const cn = half - 118;
  box(cn - 38, cn + 38, 6, 32, 0, 11, 1);
  roof(cn - 38, cn + 38, 6, 32, 11, 4, 1);
  box(cn - 22, cn - 18, 18, 22, 11, 40, 0.9);
  box(cn - 30.5, cn - 27, 20, 23.5, 11, 33, 0.9);
  windows(cn - 36, cn + 36, 6, 0, 10, 0.35, SODIUM, 34);

  // The clinic: a five-storey block by the water with a green cross, cool-white wards and warm stores.
  const clinicU = -20;
  // Streets of houses in front, blocks behind, rising up the hill.
  for (let u = -half + 10; u < half - 166; ) {
    const w = 10 + r() * 16;
    const nearClinic = Math.abs(u + w / 2 - clinicU) < 28;
    for (const row of [0, 1, 2, 3]) {
      if (r() < 0.15 || (nearClinic && row < 2)) continue;
      const v0 = 12 + row * 30 + r() * 6,
        d = 10 + r() * 12;
      const tall = row > 0 && r() < 0.28 + row * 0.08;
      const h = tall ? 13 + r() * r() * 26 : 5 + r() * 6;
      building(u, w, v0, d, h, !tall && r() < 0.8, row === 0 ? 0.5 : 0.4);
    }
    u += w + 2 + r() * 5;
  }
  box(clinicU - 19, clinicU + 19, 8, 32, 0, 19, 1.05);
  box(clinicU - 6, clinicU + 6, 14, 26, 19, 23, 1);
  for (let y = 2.6; y < 18; y += 3.4)
    for (let u = clinicU - 17; u < clinicU + 17; u += 3.6)
      if (r() < 0.72) light(u, 8, y, r() < 0.8 ? COOL : WARM, 18 + r() * 10, 0, 2.6 + r() * 0.5);
  light(clinicU, 8, 21.2, GREEN, 40, 0, 4);
  for (const du of [-15, 15]) light(clinicU + du, -2, 5.2, COOL, 30, 0, 3.2); // its entrance lamps

  // The church on the hill, for a skyline that reads as a town.
  const ch = -120;
  box(ch - 7, ch + 7, 96, 116, rise(96) - 1, rise(96) + 14, 1);
  box(ch - 3, ch + 3, 100, 106, rise(96) + 14, rise(96) + 30, 1);
  roof(ch - 3, ch + 3, 100, 106, rise(96) + 30, 13, 1);

  // The waterfront lamps along the sea wall.
  for (let u = -half + 20; u < half - 50; u += 11) if (Math.abs(u - clinicU) > 20) light(u, -2, 5.2, SODIUM, 58, 1, 3.4);

  counts.tris = tris;
  const sg = new T.BufferGeometry();
  sg.setAttribute("position", new T.Float32BufferAttribute(pos, 3));
  sg.setAttribute("color", new T.Float32BufferAttribute(col, 3));
  sg.computeBoundingSphere();
  // Double-sided: only the faces the quay can see are built, wound whichever way they fall.
  const silhouette = new T.Mesh(sg, new T.MeshBasicMaterial({ vertexColors: true, fog: false, side: T.DoubleSide }));
  silhouette.name = "story-town-silhouette";
  silhouette.castShadow = false;
  silhouette.receiveShadow = false;

  const pg = new T.BufferGeometry();
  pg.setAttribute("position", new T.Float32BufferAttribute(lp, 3));
  pg.setAttribute("aColor", new T.Float32BufferAttribute(lc, 3));
  pg.setAttribute("aLight", new T.Float32BufferAttribute(la, 4));
  pg.computeBoundingSphere();
  const uniforms = {
    uOn: { value: new T.Vector2(0, 0) },
    uTime: { value: 0 },
    uScale: { value: 1 },
  };
  const pm = new T.ShaderMaterial({
    uniforms,
    vertexShader: `
attribute vec3 aColor;
attribute vec4 aLight;
uniform vec2 uOn;
uniform float uTime, uScale;
varying vec3 vC;
void main() {
  float on = aLight.x < 0.5 ? uOn.x : uOn.y;
  float lit = smoothstep(aLight.y * 0.8, aLight.y * 0.8 + 0.2, on);
  float flick = 1.0 + 0.06 * sin(uTime * (1.3 + fract(aLight.w) * 1.7) + aLight.w * 9.0);
  vC = aColor * lit * flick;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = lit > 0.001 ? aLight.z * uScale : 0.0;
}`,
    fragmentShader: `
varying vec3 vC;
void main() {
  float d = length(gl_PointCoord - 0.5) * 2.0;
  float a = 1.0 - smoothstep(0.25, 1.0, d);
  if (a <= 0.0) discard;
  gl_FragColor = vec4(vC * a, 1.0);
}`,
    transparent: true,
    depthWrite: false,
    blending: T.AdditiveBlending,
    fog: false,
  });
  const points = new T.Points(pg, pm);
  points.name = "story-town-lights";
  points.frustumCulled = false;
  points.renderOrder = 2;

  const root = new T.Group();
  root.name = "story-town";
  root.add(silhouette, points);
  G.scene.add(root);

  let state: LightsState = { ...DARK };
  const level = { clinic: 0, generators: 0 };
  let scaleT = 0;
  const size = new T.Vector2();
  function rescale() {
    // Points are sized in the render target's pixels: keep them the same share of the frame at any resolution.
    let h = 720;
    try {
      const s = G.render && typeof G.render.stats === "function" ? G.render.stats() : null;
      if (s && Array.isArray(s.res) && s.res[1] > 0) h = s.res[1];
      else if (G.renderer) h = G.renderer.getDrawingBufferSize(size).y;
    } catch {
      /* keep the last scale */
    }
    uniforms.uScale.value = Math.max(0.75, Math.min(3, h / 720));
  }
  rescale();

  const SWITCH_ON = 1 / 3.2; // per second: about three seconds for a district to come on
  return {
    root,
    count: counts,
    get state() {
      return { ...state };
    },
    get level() {
      return { ...level };
    },
    set(s: LightsState, instant = false) {
      state = { clinic: !!s.clinic, generators: !!s.generators };
      if (instant) {
        level.clinic = state.clinic ? 1 : 0;
        level.generators = state.generators ? 1 : 0;
        uniforms.uOn.value.set(level.clinic, level.generators);
      }
    },
    update(dt: number) {
      uniforms.uTime.value += dt;
      const step = dt * SWITCH_ON;
      for (const k of ["clinic", "generators"] as const) {
        const want = state[k] ? 1 : 0;
        level[k] = want > level[k] ? Math.min(want, level[k] + step) : Math.max(want, level[k] - step * 2);
      }
      uniforms.uOn.value.set(level.clinic, level.generators);
      if ((scaleT -= dt) <= 0) ((scaleT = 2), rescale());
    },
    dispose() {
      G.scene.remove(root);
      sg.dispose();
      pg.dispose();
      silhouette.material.dispose();
      pm.dispose();
    },
  };
}
