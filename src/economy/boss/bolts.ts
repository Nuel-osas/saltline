// The Assessor's heavy bolts: thicker and slower than a Gull's, drawn as one instanced mesh of HDR streaks (the bloom
// does the glow). Each step a bolt checks the world (G.physics.raycast: steel stops it, which is the point of breaking
// line of sight) and the player's capsule, the way the drones' bolts do (src/game.js, the enemies' bolt pool).
import { TUNE } from "./rules";
import type { Bolts, V3 } from "./types";

/* eslint-disable @typescript-eslint/no-explicit-any -- THREE and the game context come from the untyped bundle */
type Game = any;

const MAX = 24;
const LIFE = 1.6;

/** Squared distance between segments p0–p1 and q0–q1. */
export function segSegDist2(p0: V3, p1: V3, q0: V3, q1: V3): number {
  const ux = p1.x - p0.x, uy = p1.y - p0.y, uz = p1.z - p0.z;
  const vx = q1.x - q0.x, vy = q1.y - q0.y, vz = q1.z - q0.z;
  const wx = p0.x - q0.x, wy = p0.y - q0.y, wz = p0.z - q0.z;
  const a = ux * ux + uy * uy + uz * uz,
    b = ux * vx + uy * vy + uz * vz,
    c = vx * vx + vy * vy + vz * vz,
    d = ux * wx + uy * wy + uz * wz,
    e = vx * wx + vy * wy + vz * wz;
  const D = a * c - b * b;
  let s = 0,
    t = 0;
  if (a < 1e-9 && c < 1e-9) return wx * wx + wy * wy + wz * wz;
  if (a < 1e-9) t = Math.min(1, Math.max(0, e / c));
  else if (c < 1e-9) s = Math.min(1, Math.max(0, -d / a));
  else {
    s = D > 1e-9 ? Math.min(1, Math.max(0, (b * e - c * d) / D)) : 0;
    t = (b * s + e) / c;
    if (t < 0) ((t = 0), (s = Math.min(1, Math.max(0, -d / a))));
    else if (t > 1) ((t = 1), (s = Math.min(1, Math.max(0, (b - d) / a))));
  }
  const x = wx + ux * s - vx * t,
    y = wy + uy * s - vy * t,
    z = wz + uz * s - vz * t;
  return x * x + y * y + z * z;
}

export function createBolts(G: Game): Bolts {
  const THREE = G.THREE;
  const list = Array.from({ length: MAX }, () => ({
    on: false,
    life: 0,
    len: 0,
    pos: new THREE.Vector3(),
    dir: new THREE.Vector3(),
    from: new THREE.Vector3(),
  }));
  const geo = new THREE.CylinderGeometry(0.035, 0.07, 1, 6, 1);
  geo.rotateX(Math.PI / 2);
  geo.translate(0, 0, -0.5);
  const base = G.mats?.emissive?.(0xff6a2a, 18);
  const mat = base && base.isMeshBasicMaterial ? base : new THREE.MeshBasicMaterial({ color: new THREE.Color(0xff6a2a).multiplyScalar(18) });
  const mesh = new THREE.InstancedMesh(geo, mat, MAX);
  mesh.name = "assessor-bolts";
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.count = 0;
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  G.scene.add(mesh);

  const end = new THREE.Vector3(),
    feet = new THREE.Vector3(),
    head = new THREE.Vector3(),
    q = new THREE.Quaternion(),
    s = new THREE.Vector3(1, 1, 1),
    m = new THREE.Matrix4(),
    Z = new THREE.Vector3(0, 0, 1);
  const impact = {
    point: new THREE.Vector3(),
    normal: new THREE.Vector3(),
    dist: 0,
    surface: "concrete",
    enemy: null,
    part: null,
    dir: new THREE.Vector3(),
    from: "enemy",
  };

  return {
    fire(from, dir) {
      const b = list.find((x) => !x.on);
      if (!b) return;
      b.on = true;
      b.life = LIFE;
      b.len = 0;
      b.pos.set(from.x, from.y, from.z);
      b.from.copy(b.pos);
      b.dir.set(dir.x, dir.y, dir.z).normalize();
      try {
        G.render?.lightPool?.flash?.(b.pos, 0xff8a3a, 60, 11, 0.07);
      } catch {
        /* optional */
      }
    },
    update(dt) {
      const P = G.player;
      let n = 0;
      for (const b of list) {
        if (!b.on) continue;
        const step = TUNE.volley.speed * dt;
        b.life -= dt;
        let hit: any = null;
        try {
          hit = G.physics.raycast(b.pos, b.dir, step);
        } catch {
          hit = null;
        }
        const reach = hit ? hit.dist : step;
        if (P && P.alive !== false && P.pos) {
          end.copy(b.pos).addScaledVector(b.dir, reach);
          feet.set(P.pos.x, P.pos.y + 0.35, P.pos.z);
          head.set(P.pos.x, P.pos.y + (P.crouching ? 1 : 1.5), P.pos.z);
          if (segSegDist2(b.pos, end, feet, head) < 0.42 * 0.42) {
            P.damage?.(TUNE.volley.damage, b.from);
            b.on = false;
            continue;
          }
        }
        if (hit) {
          impact.point.copy(hit.point);
          impact.normal.copy(hit.normal);
          impact.dist = hit.dist;
          impact.surface = hit.surface;
          impact.dir.copy(b.dir);
          G.events?.emit?.("impact", impact);
          b.on = false;
          continue;
        }
        if (b.life <= 0) {
          b.on = false;
          continue;
        }
        b.pos.addScaledVector(b.dir, step);
        b.len = Math.min(2.4, b.len + step);
        q.setFromUnitVectors(Z, b.dir);
        s.set(1, 1, Math.max(0.3, b.len));
        m.compose(b.pos, q, s);
        mesh.setMatrixAt(n++, m);
      }
      if (n || mesh.count) {
        mesh.count = n;
        mesh.instanceMatrix.needsUpdate = true;
      }
    },
    clear() {
      for (const b of list) b.on = false;
      mesh.count = 0;
    },
    dispose() {
      for (const b of list) b.on = false;
      mesh.removeFromParent();
      geo.dispose();
      if (mat !== base) mat.dispose();
    },
  };
}
