// The kit you can see: ammo tins, med injectors and breaker charges on the ground or on a supply locker's shelf, the
// charge in flight with its trail, and its burst (a blue-white flash, arcs and a ring across the ground). All of it is
// generated in code from the game's own materials and stencil labels, added to G.scene and removed at the next run.
// No game.js edits. Without three.js (the tests) it is a stub that draws nothing.
import type { PickupKind, V3 } from "../campaign/types";
import type { LockerSpot } from "./spots";

/* eslint-disable @typescript-eslint/no-explicit-any -- three.js arrives untyped from the game bundle (G.THREE) */
type Obj = any;

export interface PickupView {
  /** Moves it (a drop falling to the ground). */
  place(pos: V3): void;
  remove(): void;
}
export interface LockerView {
  /** Where its pickup sits, in the world. */
  readonly shelf: V3;
  /** Its pickup was taken: the shelf is bare and the lamp goes out. */
  empty(): void;
  remove(): void;
}
export interface FlightView {
  place(pos: V3, t: number): void;
  remove(): void;
}

export interface ArsenalWorld {
  pickup(kind: PickupKind, pos: V3): PickupView;
  locker(spot: LockerSpot, kind: PickupKind): LockerView;
  flight(pos: V3): FlightView;
  burst(pos: V3, radius: number): void;
  /** A held hound crackles. */
  crackle(pos: V3): void;
  update(dt: number): void;
  clear(): void;
}

const NO_PICKUP: PickupView = { place() {}, remove() {} };
const NO_FLIGHT: FlightView = { place() {}, remove() {} };
export const STUB_WORLD: ArsenalWorld = {
  pickup: () => NO_PICKUP,
  locker: (s) => ({ shelf: { x: s.x, y: s.y + 1, z: s.z }, empty() {}, remove() {} }),
  flight: () => NO_FLIGHT,
  burst() {},
  crackle() {},
  update() {},
  clear() {},
};

/** Each kind's light: amber for rounds, green for the injector, the charge's own blue-white. */
export const GLOW: Record<PickupKind, number> = { ammo: 0xffb347, med: 0x6dffb0, charge: 0x8fd4ff };
const TAG: Record<PickupKind, string> = { ammo: "AMMO", med: "MED", charge: "CHARGE" };
const BURST = 0xa8dcff;

/** Locker: 0.9 wide, 0.5 deep, 1.9 tall; the shelf the pickup sits on. */
const LOCKER = { w: 0.9, d: 0.5, h: 1.9, shelf: 1.02 };

export function createArsenalWorld(G: any): ArsenalWorld {
  const T = G && G.THREE;
  if (!T || !G.scene || !G.mats || typeof G.mats.get !== "function" || typeof document === "undefined") return STUB_WORLD;

  const mat = (name: string, fallback: number) => {
    try {
      return G.mats.get(name);
    } catch {
      return new T.MeshStandardMaterial({ color: fallback, roughness: 0.7 });
    }
  };
  const lit = (color: number, k: number) => {
    try {
      return G.mats.emissive(color, k).clone();
    } catch {
      return new T.MeshBasicMaterial({ color: new T.Color(color).multiplyScalar(k) });
    }
  };
  /** A soft round falloff, drawn once: the halo under a pickup, the charge's corona, the burst's flash. */
  const soft = (() => {
    const c = document.createElement("canvas");
    c.width = c.height = 64;
    const g = c.getContext("2d");
    if (g) {
      const r = g.createRadialGradient(32, 32, 0, 32, 32, 32);
      r.addColorStop(0, "rgba(255,255,255,1)");
      r.addColorStop(0.25, "rgba(255,255,255,0.55)");
      r.addColorStop(0.6, "rgba(255,255,255,0.12)");
      r.addColorStop(1, "rgba(255,255,255,0)");
      g.fillStyle = r;
      g.fillRect(0, 0, 64, 64);
    }
    return new T.CanvasTexture(c);
  })();
  const additive = (color: number, k: number, map: Obj | null = soft) =>
    new T.MeshBasicMaterial({
      color: new T.Color(color).multiplyScalar(k),
      map,
      transparent: true,
      depthWrite: false,
      blending: T.AdditiveBlending,
      side: T.DoubleSide,
      fog: false,
    });

  const M = {
    olive: mat("paint_green", 0x4a5a3a),
    yellow: mat("paint_yellow", 0xd9a521),
    white: mat("paint_white", 0xd8d6cf),
    dark: mat("steel_dark", 0x2b2e31),
    worn: mat("steel_worn", 0x6c7175),
    galv: mat("steel_galv", 0x9aa0a4),
    brass: mat("brass", 0xb08d3c),
    polymer: mat("polymer_black", 0x1a1b1d),
    hazard: mat("hazard_stripes", 0xd9a521),
    spent: new T.MeshStandardMaterial({ color: 0x15171a, roughness: 0.6 }),
  };
  const Gm = {
    plane: new T.PlaneGeometry(1, 1),
    box: new T.BoxGeometry(1, 1, 1),
    cyl: new T.CylinderGeometry(1, 1, 1, 14),
    ring: new T.RingGeometry(0.93, 1, 56),
    sphere: new T.SphereGeometry(1, 20, 12),
  };
  const box = (m: Obj, w: number, h: number, d: number, x: number, y: number, z: number, shadow = true) => {
    const o = new T.Mesh(Gm.box, m);
    o.scale.set(w, h, d);
    o.position.set(x, y, z);
    o.castShadow = shadow;
    o.receiveShadow = true;
    return o;
  };
  const cyl = (m: Obj, r: number, h: number, x: number, y: number, z: number) => {
    const o = new T.Mesh(Gm.cyl, m);
    o.scale.set(r, h, r);
    o.position.set(x, y, z);
    o.castShadow = true;
    o.receiveShadow = true;
    return o;
  };
  /** A stencil label (the game's own renderer) on a plane `w` metres wide, facing local +z. */
  const label = (text: string, opts: object, w: number, x: number, y: number, z: number) => {
    try {
      const L = G.mats.label(text, opts);
      const o = new T.Mesh(Gm.plane, L.material);
      o.scale.set(w, w / (L.aspect || 4), 1);
      o.position.set(x, y, z);
      o.renderOrder = 2;
      return o;
    } catch {
      return null;
    }
  };
  const add = (g: Obj, ...xs: (Obj | null)[]) => {
    for (const x of xs) if (x) g.add(x);
    return g;
  };

  // ---- the three props, each standing on its local origin ----
  function model(kind: PickupKind): Obj {
    const g = new T.Group();
    if (kind === "ammo") {
      // A steel ammunition tin: olive, a yellow band, a latched lid and a folded handle.
      add(
        g,
        box(M.olive, 0.3, 0.17, 0.155, 0, 0.085, 0),
        box(M.olive, 0.312, 0.022, 0.167, 0, 0.181, 0),
        box(M.yellow, 0.302, 0.03, 0.157, 0, 0.118, 0, false),
        box(M.dark, 0.13, 0.012, 0.02, 0, 0.198, 0),
        box(M.dark, 0.012, 0.014, 0.02, -0.065, 0.192, 0),
        box(M.dark, 0.012, 0.014, 0.02, 0.065, 0.192, 0),
        box(M.galv, 0.03, 0.05, 0.012, 0, 0.15, 0.083),
        label("7.62", { color: "yellow", font: "stencil", distress: 0.2 }, 0.13, -0.06, 0.06, 0.0785),
        label("30 RDS", { color: "white", font: "sans", distress: 0.2 }, 0.1, 0.085, 0.055, 0.0785),
      );
      const back = label("7.62", { color: "yellow", font: "stencil", distress: 0.2 }, 0.13, 0.06, 0.06, -0.0785);
      if (back) ((back.rotation.y = Math.PI), g.add(back));
      g.add(box(lit(GLOW.ammo, 2.2), 0.05, 0.012, 0.004, 0.1, 0.15, 0.0795, false));
    } else if (kind === "med") {
      // A field injector in its case: white, a green cross that glows, the pen clipped on top.
      add(
        g,
        box(M.white, 0.26, 0.1, 0.17, 0, 0.05, 0),
        box(M.white, 0.268, 0.02, 0.178, 0, 0.11, 0),
        box(M.galv, 0.03, 0.035, 0.01, -0.07, 0.085, 0.09),
        box(M.galv, 0.03, 0.035, 0.01, 0.07, 0.085, 0.09),
      );
      const pen = cyl(M.polymer, 0.017, 0.2, 0, 0.137, -0.045);
      pen.rotation.z = Math.PI / 2;
      const cap = cyl(lit(GLOW.med, 1.6), 0.0175, 0.03, 0.085, 0.137, -0.045);
      cap.rotation.z = Math.PI / 2;
      const cross = lit(GLOW.med, 2.4);
      add(
        g,
        pen,
        cap,
        box(cross, 0.085, 0.004, 0.026, 0, 0.1215, 0.03, false),
        box(cross, 0.026, 0.004, 0.085, 0, 0.1215, 0.03, false),
        box(cross, 0.07, 0.022, 0.003, 0, 0.055, 0.0865, false),
        box(cross, 0.022, 0.07, 0.003, 0, 0.055, 0.0865, false),
      );
    } else {
      // The breaker charge: a capped steel canister with a lit band and a pull ring.
      const band = lit(GLOW.charge, 3);
      add(
        g,
        cyl(M.dark, 0.062, 0.2, 0, 0.1, 0),
        cyl(M.galv, 0.068, 0.03, 0, 0.015, 0),
        cyl(M.galv, 0.068, 0.03, 0, 0.185, 0),
        cyl(band, 0.064, 0.022, 0, 0.1, 0),
        cyl(M.brass, 0.02, 0.03, 0, 0.215, 0),
        box(M.hazard, 0.004, 0.05, 0.06, 0.0625, 0.06, 0, false),
      );
      const ring = new T.Mesh(new T.TorusGeometry(0.024, 0.004, 6, 14), M.galv);
      ring.position.set(0.03, 0.235, 0);
      ring.rotation.y = 0.4;
      g.add(ring);
    }
    return g;
  }

  const root = new T.Group();
  root.name = "arsenal";
  G.scene.add(root);

  interface Lit {
    kind: PickupKind;
    /** The halo on the ground (or the lamp glow in a locker) and the floating tag. */
    halo: Obj | null;
    tag: Obj | null;
    at: Obj;
    /** Tag: metres above `at`, and the nearest distance it shows at (a locker's own stencil reads up close). */
    lift: number;
    near: number;
    phase: number;
    gone: boolean;
  }
  let lights: Lit[] = [];
  const tagMats = new Map<PickupKind, { material: Obj; aspect: number }>();
  function tagFor(kind: PickupKind) {
    let t = tagMats.get(kind);
    if (!t) {
      try {
        const L = G.mats.label(TAG[kind], { color: "white", font: "stencil", distress: 0 });
        const material = new T.MeshBasicMaterial({
          map: L.material.map,
          color: new T.Color(GLOW[kind]).lerp(new T.Color(0xffffff), 0.45).multiplyScalar(1.5),
          transparent: true,
          depthWrite: false,
          depthTest: true,
          fog: false,
        });
        t = { material, aspect: L.aspect || 3 };
        tagMats.set(kind, t);
      } catch {
        return null;
      }
    }
    // The stencil on a dark plate (the HUD's plate colour), so it reads against sky, steel or pallets alike.
    const o = new T.Group();
    const text = new T.Mesh(Gm.plane, t.material.clone());
    text.renderOrder = 7;
    const plate = new T.Mesh(Gm.plane, new T.MeshBasicMaterial({ color: 0x0b0d0f, transparent: true, depthWrite: false, fog: false }));
    plate.scale.set(1.16, 1.5, 1);
    plate.position.z = -0.002;
    plate.renderOrder = 6;
    o.add(plate, text);
    o.userData = { aspect: t.aspect, text: text.material, plate: plate.material };
    return o;
  }
  function light(kind: PickupKind, at: Obj, lift: number, near: number, halo: Obj | null): Lit {
    const tag = tagFor(kind);
    if (tag) root.add(tag);
    const l: Lit = { kind, halo, tag, at, lift, near, phase: Math.random() * 6.28, gone: false };
    lights.push(l);
    return l;
  }
  function unlight(l: Lit) {
    l.gone = true;
    if (l.tag) (root.remove(l.tag), l.tag.userData.text.dispose(), l.tag.userData.plate.dispose());
    if (l.halo) (l.halo.parent?.remove(l.halo), l.halo.material.dispose());
    lights = lights.filter((x) => x !== l);
  }

  // ---- pickups on the ground ----
  function pickup(kind: PickupKind, pos: V3): PickupView {
    const g = model(kind);
    g.position.set(pos.x, pos.y, pos.z);
    g.rotation.y = (pos.x * 12.9898 + pos.z * 78.233) % 6.283; // a settled, not a placed, angle
    const halo = new T.Mesh(Gm.plane, additive(GLOW[kind], kind === "ammo" ? 0.8 : 0.5));
    halo.rotation.x = -Math.PI / 2;
    halo.scale.set(1.5, 1.5, 1);
    halo.position.set(0, 0.012, 0);
    halo.renderOrder = 3;
    g.add(halo);
    root.add(g);
    const l = light(kind, g, 0.62, 0, halo);
    return {
      place(p) {
        g.position.set(p.x, p.y, p.z);
      },
      remove() {
        unlight(l);
        root.remove(g);
      },
    };
  }

  // ---- supply lockers ----
  function locker(spot: LockerSpot, kind: PickupKind): LockerView {
    const { w, d, h, shelf } = LOCKER;
    const g = new T.Group();
    g.position.set(spot.x, spot.y, spot.z);
    g.rotation.y = spot.yaw;
    const t = 0.025;
    add(
      g,
      box(M.dark, w, 0.08, d, 0, 0.04, 0), // plinth
      box(M.yellow, w, h - 0.08, t, 0, 0.08 + (h - 0.08) / 2, -d / 2 + t / 2), // back
      box(M.yellow, t, h - 0.08, d, -w / 2 + t / 2, 0.08 + (h - 0.08) / 2, 0),
      box(M.yellow, t, h - 0.08, d, w / 2 - t / 2, 0.08 + (h - 0.08) / 2, 0),
      box(M.yellow, w, t, d, 0, h - t / 2, 0), // top
      box(M.worn, w - 2 * t, 0.02, d - t, 0, shelf - 0.01, t / 2), // the shelf
      box(M.dark, w - 2 * t, 0.62, 0.012, 0, shelf + 0.31, -d / 2 + t + 0.006, false), // a dark back to the open bay
      box(M.yellow, w - 2 * t, shelf - 0.11, t, 0, 0.08 + (shelf - 0.11) / 2, d / 2 - t / 2), // the shut lower door
      box(M.hazard, w - 2 * t, 0.06, 0.004, 0, shelf - 0.075, d / 2 + 0.002, false),
      box(M.dark, 0.03, 0.12, 0.02, 0.3, 0.55, d / 2 + 0.01), // its handle
      box(M.yellow, w - 2 * t, h - shelf - 0.64, t, 0, (h + shelf + 0.62) / 2, d / 2 - t / 2), // the header
      label("SUPPLY", { color: "black", font: "stencil", distress: 0.18 }, 0.56, 0, (h + shelf + 0.62) / 2 + 0.005, d / 2 + 0.003),
      label(`B4 · L${String(spot.id + 1).padStart(2, "0")}`, { color: "black", font: "sans", distress: 0.2 }, 0.3, -0.2, 0.36, d / 2 + 0.003),
      label(TAG[kind], { color: "black", font: "stencil", distress: 0.2 }, kind === "charge" ? 0.42 : 0.3, 0.12, 0.72, d / 2 + 0.003),
    );
    // The bay's door, swung wide on its left hinge.
    const door = new T.Group();
    door.position.set(-w / 2, shelf + 0.31, d / 2);
    door.rotation.y = -1.95;
    door.add(box(M.yellow, w - 2 * t, 0.62, 0.018, (w - 2 * t) / 2, 0, 0));
    door.add(box(M.dark, 0.02, 0.1, 0.03, w - 0.1, 0, 0.02));
    g.add(door);
    // The lamp under the header and its light on the bay's back wall.
    const lamp = box(lit(GLOW[kind], 2.6), w - 0.16, 0.016, 0.03, 0, shelf + 0.605, d / 2 - 0.06, false);
    const wash = new T.Mesh(Gm.plane, additive(GLOW[kind], 0.42));
    wash.scale.set(w * 1.5, 1.0, 1);
    wash.position.set(0, shelf + 0.3, -d / 2 + t + 0.016);
    wash.renderOrder = 3;
    g.add(lamp, wash);
    const item = model(kind);
    item.position.set(0, shelf, 0.03);
    item.rotation.y = kind === "ammo" ? 0.22 : -0.3;
    g.add(item);
    root.add(g);

    // A collider on its footprint, so players and hounds walk round it (yaw is always a quarter turn).
    const sideways = Math.abs(Math.sin(spot.yaw)) > 0.5;
    const hx = (sideways ? d : w) / 2,
      hz = (sideways ? w : d) / 2;
    let solid: Obj = null;
    try {
      solid = G.physics.addBox(new T.Vector3(spot.x - hx, spot.y, spot.z - hz), new T.Vector3(spot.x + hx, spot.y + h, spot.z + hz), { surface: "metal" });
    } catch {
      solid = null;
    }
    const sin = Math.sin(spot.yaw),
      cos = Math.cos(spot.yaw);
    const at = new T.Object3D();
    at.position.set(spot.x + sin * 0.03, spot.y + shelf, spot.z + cos * 0.03);
    const l = light(kind, at, h - shelf + 0.42, 5, wash);
    let lampOn = true;
    return {
      shelf: { x: at.position.x, y: at.position.y, z: at.position.z },
      empty() {
        if (!lampOn) return;
        lampOn = false;
        g.remove(item);
        unlight(l);
        lamp.material.dispose();
        lamp.material = M.spent;
      },
      remove() {
        if (lampOn) unlight(l);
        root.remove(g);
        try {
          if (solid) G.physics.removeBox(solid);
        } catch {
          /* the physics module went away; nothing to undo */
        }
      },
    };
  }

  // ---- the charge in flight ----
  const TRAIL = 18;
  function flight(pos: V3): FlightView {
    const g = new T.Group();
    const body = model("charge");
    body.position.y = -0.1;
    const spin = new T.Group();
    spin.add(body);
    const corona = new T.Mesh(Gm.plane, additive(GLOW.charge, 1.6));
    corona.scale.set(0.9, 0.9, 1);
    corona.renderOrder = 5;
    g.add(spin, corona);
    g.position.set(pos.x, pos.y, pos.z);
    root.add(g);
    const pts = new Float32Array(TRAIL * 3);
    const cols = new Float32Array(TRAIL * 4);
    for (let i = 0; i < TRAIL; i++) pts.set([pos.x, pos.y, pos.z], i * 3);
    // Pale blue fading to nothing along its length; plain blending, so it shows against the dawn sky as well.
    for (let i = 0; i < TRAIL; i++) cols.set([0.8, 0.93, 1, Math.pow(1 - i / (TRAIL - 1), 1.4) * 0.9], i * 4);
    const geo = new T.BufferGeometry();
    geo.setAttribute("position", new T.BufferAttribute(pts, 3));
    geo.setAttribute("color", new T.BufferAttribute(cols, 4));
    const line = new T.Line(geo, new T.LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, fog: false }));
    line.frustumCulled = false;
    line.renderOrder = 5;
    root.add(line);
    return {
      place(p, t) {
        g.position.set(p.x, p.y, p.z);
        spin.rotation.set(t * 11, t * 3, t * 7);
        corona.quaternion.copy(G.camera.quaternion);
        const blink = 0.75 + 0.25 * Math.sin(t * 40);
        corona.scale.setScalar(0.9 * blink);
        pts.copyWithin(3, 0, (TRAIL - 1) * 3);
        pts[0] = p.x;
        pts[1] = p.y;
        pts[2] = p.z;
        geo.attributes.position.needsUpdate = true;
      },
      remove() {
        root.remove(g, line);
        geo.dispose();
        line.material.dispose();
        corona.material.dispose();
      },
    };
  }

  // ---- the burst ----
  interface Burst {
    t: number;
    radius: number;
    flash: Obj;
    dome: Obj;
    ring: Obj;
    mark: Obj;
    arcs: Obj;
    pos: V3;
    ground: number;
  }
  let bursts: Burst[] = [];
  const ARCS = 9,
    SEG = 7;
  function jag(b: Burst) {
    const a = b.arcs.geometry.attributes.position;
    const arr = a.array as Float32Array;
    let n = 0;
    for (let i = 0; i < ARCS; i++) {
      const yaw = Math.random() * 6.283,
        up = (Math.random() - 0.25) * 1.1,
        len = b.radius * (0.55 + Math.random() * 0.45);
      const dx = Math.cos(yaw) * Math.cos(up),
        dy = Math.sin(up),
        dz = Math.sin(yaw) * Math.cos(up);
      let px = b.pos.x,
        py = b.pos.y,
        pz = b.pos.z;
      for (let s = 1; s <= SEG; s++) {
        const k = (s / SEG) * len,
          j = 0.32 * (s < SEG ? 1 : 0.4);
        const qx = b.pos.x + dx * k + (Math.random() - 0.5) * j,
          qy = Math.max(b.ground + 0.03, b.pos.y + dy * k + (Math.random() - 0.5) * j),
          qz = b.pos.z + dz * k + (Math.random() - 0.5) * j;
        arr.set([px, py, pz, qx, qy, qz], n);
        n += 6;
        px = qx;
        py = qy;
        pz = qz;
      }
    }
    a.needsUpdate = true;
  }
  function burst(pos: V3, radius: number) {
    let ground = 0;
    try {
      ground = G.physics.groundHeight(pos.x, pos.z, pos.y + 0.5);
    } catch {
      ground = 0;
    }
    const flash = new T.Mesh(Gm.plane, additive(BURST, 5));
    flash.position.set(pos.x, pos.y, pos.z);
    flash.renderOrder = 7;
    const dome = new T.Mesh(Gm.sphere, additive(BURST, 0.5, null));
    dome.position.set(pos.x, pos.y, pos.z);
    dome.renderOrder = 6;
    const ring = new T.Mesh(Gm.ring, additive(BURST, 3, null));
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(pos.x, ground + 0.03, pos.z);
    ring.renderOrder = 4;
    const mark = new T.Mesh(Gm.ring, additive(BURST, 0.9, null));
    mark.rotation.x = -Math.PI / 2;
    mark.position.set(pos.x, ground + 0.025, pos.z);
    mark.scale.setScalar(radius);
    mark.renderOrder = 4;
    const geo = new T.BufferGeometry();
    geo.setAttribute("position", new T.BufferAttribute(new Float32Array(ARCS * SEG * 6), 3));
    const arcs = new T.LineSegments(geo, new T.LineBasicMaterial({ color: new T.Color(0xd8f0ff).multiplyScalar(3), transparent: true, depthWrite: false, blending: T.AdditiveBlending, fog: false }));
    arcs.frustumCulled = false;
    arcs.renderOrder = 7;
    const b: Burst = { t: 0, radius, flash, dome, ring, mark, arcs, pos: { ...pos }, ground };
    jag(b);
    root.add(flash, dome, ring, mark, arcs);
    bursts.push(b);
    const at = new T.Vector3(pos.x, pos.y, pos.z);
    try {
      G.render?.lightPool?.flash?.(at, BURST, 90, radius * 4, 0.16);
      G.fx?.sparks?.(at, new T.Vector3(0, 1, 0), 26);
    } catch {
      /* the effects are never load-bearing */
    }
  }
  function endBurst(b: Burst) {
    root.remove(b.flash, b.dome, b.ring, b.mark, b.arcs);
    for (const o of [b.flash, b.dome, b.ring, b.mark, b.arcs]) o.material.dispose();
    b.arcs.geometry.dispose();
  }

  const up = new T.Vector3(0, 1, 0);
  const tmp = new T.Vector3();
  let clock = 0;
  return {
    pickup,
    locker,
    flight,
    burst,
    crackle(pos) {
      try {
        tmp.set(pos.x + (Math.random() - 0.5) * 0.5, pos.y + 0.45 + Math.random() * 0.4, pos.z + (Math.random() - 0.5) * 0.5);
        G.fx?.sparks?.(tmp, up, 3);
        G.render?.lightPool?.flash?.(tmp, BURST, 10, 4, 0.05);
      } catch {
        /* optional */
      }
    },
    update(dt) {
      clock += dt;
      const cam = G.camera;
      for (const l of lights) {
        const pulse = 0.82 + 0.18 * Math.sin(clock * 2.4 + l.phase);
        if (l.halo) l.halo.material.opacity = pulse;
        if (!l.tag || !cam) continue;
        const p = l.at.position;
        const dist = Math.hypot(cam.position.x - p.x, cam.position.y - p.y, cam.position.z - p.z);
        // The tag grows with distance so it still reads at 15 m, and bows out up close and far off.
        const k = Math.max(1, Math.min(3.2, dist / 4.5));
        const w = (l.kind === "charge" ? 0.5 : 0.36) * k;
        l.tag.scale.set(w, w / (l.tag.userData.aspect || 3), 1);
        l.tag.position.set(p.x, p.y + l.lift + 0.05 * k, p.z);
        l.tag.quaternion.copy(cam.quaternion);
        const fade = Math.min(1, Math.max(0, (dist - l.near) / 2.5)) * Math.min(1, Math.max(0, (34 - dist) / 8)) * Math.min(1, Math.max(0, (dist - 1.2) / 1.2));
        l.tag.userData.text.opacity = fade * (0.86 + 0.14 * pulse);
        l.tag.userData.plate.opacity = fade * 0.5;
        l.tag.visible = fade > 0.02;
      }
      for (const b of bursts) {
        b.t += dt;
        const t = b.t;
        // The flash is over in a sixth of a second; the ring runs out to the edge and its mark lingers.
        const f = Math.max(0, 1 - t / 0.16);
        b.flash.visible = f > 0;
        b.flash.scale.setScalar(b.radius * (1.1 + t * 6));
        b.flash.material.opacity = f * f;
        if (cam) b.flash.quaternion.copy(cam.quaternion);
        const d = Math.min(1, t / 0.22);
        b.dome.scale.setScalar(b.radius * (0.25 + 0.75 * (1 - (1 - d) * (1 - d))));
        b.dome.material.opacity = Math.max(0, 1 - t / 0.3) * 0.7;
        b.dome.visible = t < 0.3;
        const r = Math.min(1, t / 0.28);
        b.ring.scale.setScalar(Math.max(0.05, b.radius * (1 - (1 - r) * (1 - r))));
        b.ring.material.opacity = Math.max(0, 1 - t / 0.5);
        b.ring.visible = t < 0.5;
        b.mark.visible = t > 0.2;
        b.mark.material.opacity = Math.max(0, 1 - (t - 0.2) / 1.3) * 0.8;
        b.arcs.visible = t < 0.24 && Math.floor(t * 60) % 2 === 0;
        if (t < 0.24 && Math.floor(t * 30) !== Math.floor((t - dt) * 30)) jag(b);
      }
      if (bursts.some((b) => b.t > 1.5)) {
        for (const b of bursts) if (b.t > 1.5) endBurst(b);
        bursts = bursts.filter((b) => b.t <= 1.5);
      }
    },
    clear() {
      for (const b of bursts) endBurst(b);
      bursts = [];
      // Pickups, lockers and flights are removed by their owners (index.ts); anything left is dropped here.
      for (const l of [...lights]) unlight(l);
      while (root.children.length) root.remove(root.children[0]);
    },
  };
}
