// The rifle crate at the drop point: a long open crate two metres in front of where the player starts, its lid
// thrown back with the gun's name stencilled inside it, and the rifle lying in it. The rifle is the view model's own
// meshes and materials (so it wears the frame's finish the raid has just set), laid on its side; four boxes stand in
// where there is no view model. All generated in code from the game's materials and added to G.scene.
//
// The film lane builds the same prop for the opening (src/economy/v2/intro, `DROP.crate`). When that module is in
// the build its position is used and its crate is left standing: only the rifle and the work light are ours.
import type { CrateGun } from "./copy";

/* eslint-disable @typescript-eslint/no-explicit-any -- three.js arrives untyped from the game bundle (G.THREE) */
type Obj = any;

/** Metres in front of the player's start. */
export const CRATE_AHEAD = 2;

export interface CratePlace {
  x: number;
  y: number;
  z: number;
  /** The crate's open front faces this way: back toward the player's start. */
  yaw: number;
  /** The film lane's prop already stands here. */
  theirs: boolean;
}

const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * Where the crate stands: `drop` (the film lane's DROP.crate) if it gives a usable point, else CRATE_AHEAD metres in
 * front of the player's start, facing back at it. `ground` is the floor's height there.
 */
export function placeCrate(start: { pos?: { x: number; y?: number; z: number }; yaw?: number } | null | undefined, drop?: unknown, ground: (x: number, z: number) => number = () => 0): CratePlace {
  const yaw = num(start?.yaw) ? start!.yaw! : 0;
  const d = drop as { x?: unknown; y?: unknown; z?: unknown; yaw?: unknown; pos?: { x?: unknown; y?: unknown; z?: unknown } } | null | undefined;
  const at = d && typeof d === "object" ? (d.pos && typeof d.pos === "object" ? d.pos : d) : null;
  if (at && num(at.x) && num(at.z)) return { x: at.x, y: num(at.y) ? at.y : ground(at.x, at.z), z: at.z, yaw: num(d!.yaw) ? d!.yaw : yaw, theirs: true };
  const sx = num(start?.pos?.x) ? start!.pos!.x : 0,
    sz = num(start?.pos?.z) ? start!.pos!.z : 0;
  const x = sx - Math.sin(yaw) * CRATE_AHEAD,
    z = sz - Math.cos(yaw) * CRATE_AHEAD;
  return { x, y: ground(x, z), z, yaw, theirs: false };
}

export interface CrateWorld {
  /** Stands the crate (or only its rifle, on the film lane's) and lays the gun in it. */
  build(place: CratePlace, gun: CrateGun): void;
  /** The rifle leaves the crate. */
  take(): void;
  clear(): void;
  update(dt: number): void;
  /** Whether the rifle is still lying there. */
  readonly full: boolean;
  /** For the opening film, which shoves this same crate across the concrete: the standing crate, to move. */
  readonly root?: Obj | null;
  /** For the opening film, which kicks it open: the lid, from 0 (shut) to 1 (thrown back, as every raid finds it). */
  setLid?(k: number): void;
}

export const STUB_CRATE: CrateWorld = { build() {}, take() {}, clear() {}, update() {}, full: false };

// The crate, in metres. Low enough that the rifle shows over its near wall from where the player starts.
const L = 1.3,
  W = 0.46,
  H = 0.22,
  WALL = 0.028,
  SKID = 0.05,
  BED = 0.1;
/** The work light's strength (three.js point light units). */
const GLOW = 3;

export function createCrateWorld(G: any): CrateWorld {
  const T = G && G.THREE;
  if (!T || !G.scene) return STUB_CRATE;
  const mat = (name: string, fallback: number, rough = 0.7) => {
    try {
      const m = G.mats.get(name);
      if (m) return m;
    } catch {
      /* fall through to a plain material */
    }
    return new T.MeshStandardMaterial({ color: fallback, roughness: rough });
  };
  const M = {
    wood: mat("wood_pallet", 0x8a6a48),
    steel: mat("steel_dark", 0x2b2e31, 0.5),
    // Packing straw: pale, so the black rifle reads against it from across the lane.
    bed: new T.MeshStandardMaterial({ color: 0x8a7a55, roughness: 1, metalness: 0 }),
    gun: new T.MeshStandardMaterial({ color: 0x16181a, roughness: 0.5, metalness: 0.6 }),
    lamp: null as Obj,
  };
  const lampColor = new T.Color(0xffb347);
  const box = (w: number, h: number, d: number, m: Obj, x: number, y: number, z: number, shadow = false) => {
    const o = new T.Mesh(new T.BoxGeometry(w, h, d), m);
    o.position.set(x, y, z);
    o.castShadow = shadow;
    o.receiveShadow = true;
    return o;
  };

  let root: Obj | null = null;
  let rifle: Obj | null = null;
  let lamp: Obj | null = null;
  let body: Obj | null = null;
  let lidOf: Obj | null = null;
  /** One of the renderer's pooled point lights, held while the rifle lies there: the crate stands in a container's shadow. */
  let glow: { light: Obj; release(): void } | null = null;
  let clock = 0;
  let fade = 1;
  const dark = () => {
    try {
      glow?.release();
    } catch {
      /* the pool went away with the renderer */
    }
    glow = null;
  };

  /** The view model's rifle, without its hands, glass or muzzle flash: the same meshes, drawn in the world. */
  function rifleProp(gun: CrateGun): Obj {
    const g = new T.Group();
    let n = 0;
    const copy = (c: Obj) => {
      const o = new T.Mesh(c.geometry, c.material);
      o.castShadow = false;
      o.receiveShadow = true;
      n++;
      return o;
    };
    try {
      for (const c of G.weapon?.root?.children ?? []) {
        const name = c.material?.name;
        if (c.isMesh && typeof name === "string" && name.startsWith("pac9_")) g.add(copy(c));
        else if (!c.isMesh) {
          // The magazine sits in its own group (it leaves the gun on a reload): its body, without the top round.
          const mag = (c.children ?? []).find((k: Obj) => k.material?.name === "pac9_polymer_tan");
          if (mag) {
            const o = copy(mag);
            o.position.copy(c.position);
            g.add(o);
          }
        }
      }
    } catch {
      n = 0;
    }
    if (n >= 3) return g;
    // No view model to copy: a rifle's outline in four boxes, its furniture in the frame's finish.
    const f = new T.Group();
    const furniture = new T.MeshStandardMaterial({ color: gun.finish, roughness: 0.7, metalness: 0 });
    f.add(box(0.05, 0.07, 0.42, M.gun, 0, 0, 0), box(0.03, 0.03, 0.34, M.gun, 0, 0.01, -0.36), box(0.04, 0.17, 0.07, furniture, 0, -0.11, -0.04), box(0.045, 0.09, 0.24, furniture, 0, -0.015, 0.32));
    return f;
  }

  function label(text: string, w: number): Obj | null {
    try {
      const made = G.mats.label(text, { color: "yellow", font: "stencil", distress: 0.18 });
      const o = new T.Mesh(new T.PlaneGeometry(1, 1), made.material);
      o.scale.set(w, w / (made.aspect || 4), 1);
      o.renderOrder = 2;
      return o;
    } catch {
      return null;
    }
  }

  function clear() {
    if (!root) return;
    G.scene.remove(root);
    try {
      if (body) G.physics.removeBox(body);
    } catch {
      /* the physics module went away; nothing to undo */
    }
    M.lamp?.dispose?.();
    M.lamp = null;
    dark();
    root = rifle = lamp = body = lidOf = null;
  }

  return {
    build(place, gun) {
      clear();
      root = new T.Group();
      root.name = "coach-crate";
      root.position.set(place.x, place.y, place.z);
      root.rotation.y = place.yaw;
      const floor = place.theirs ? 0 : SKID;
      if (!place.theirs) {
        const shell = new T.Group();
        shell.add(box(0.07, SKID, W, M.steel, -L * 0.32, SKID / 2, 0), box(0.07, SKID, W, M.steel, L * 0.32, SKID / 2, 0));
        shell.add(box(L, WALL, W, M.wood, 0, SKID + WALL / 2, 0, true));
        for (const s of [-1, 1]) {
          shell.add(box(L, H, WALL, M.wood, 0, SKID + H / 2, (s * (W - WALL)) / 2, true));
          shell.add(box(WALL, H, W - 2 * WALL, M.wood, (s * (L - WALL)) / 2, SKID + H / 2, 0, true));
          // Steel corners, and the two latches hanging open on the near wall.
          for (const e of [-1, 1]) shell.add(box(0.04, H + 0.012, 0.04, M.steel, (s * (L - 0.03)) / 2, SKID + H / 2, (e * (W - 0.03)) / 2));
          shell.add(box(0.07, 0.085, 0.014, M.steel, s * L * 0.3, SKID + H - 0.07, W / 2 + 0.008));
        }
        shell.add(box(L - 2 * WALL, BED - WALL, W - 2 * WALL, M.bed, 0, SKID + WALL + (BED - WALL) / 2, 0));
        // The lid, thrown back on its hinges: the gun's name is stencilled inside it, facing the player.
        const lid = new T.Group();
        lid.position.set(0, SKID + H, -W / 2);
        lid.rotation.x = -1.92;
        lid.add(box(L, WALL, W, M.wood, 0, 0, W / 2, true));
        for (const s of [-1, 1]) lid.add(box(0.05, WALL + 0.01, W, M.steel, s * L * 0.3, 0, W / 2));
        const name = label(gun.label, gun.label.length > 14 ? 0.86 : 0.6);
        if (name) {
          name.rotation.x = Math.PI / 2;
          name.position.set(0, -WALL / 2 - 0.004, W / 2);
          lid.add(name);
        }
        shell.add(lid);
        lidOf = lid;
        root.add(shell);
        try {
          root.updateWorldMatrix(true, true);
          const b = new T.Box3().setFromCenterAndSize(new T.Vector3(0, SKID + H / 2, 0), new T.Vector3(L, H + SKID, W)).applyMatrix4(root.matrixWorld);
          body = G.physics.addBox(b.min, b.max, { surface: "wood" });
        } catch {
          body = null;
        }
      }
      // The rifle on its left side along the crate, grip toward the player, muzzle to their left.
      rifle = rifleProp(gun);
      rifle.rotation.set(0.05, Math.PI / 2, -Math.PI / 2 + 0.1, "YXZ");
      rifle.position.set(0.1, floor + BED + 0.045, -0.035);
      root.add(rifle);
      // A work light along the far wall: the amber this yard uses for what can be taken.
      try {
        M.lamp = G.mats.emissive(0xffb347, 1).clone();
      } catch {
        M.lamp = new T.MeshBasicMaterial({ color: 0xffb347 });
      }
      lamp = box(L * 0.62, 0.012, 0.012, M.lamp, 0, floor + H - 0.03, -W / 2 + WALL + 0.008);
      root.add(lamp);
      clock = 0;
      fade = 1;
      G.scene.add(root);
      try {
        glow = G.render?.lightPool?.acquire?.() ?? null;
        if (glow?.light) {
          root.updateWorldMatrix(true, false);
          glow.light.position.copy(new T.Vector3(0, floor + H + 0.5, 0.12).applyMatrix4(root.matrixWorld));
          glow.light.color.setRGB(1, 0.8, 0.56);
          glow.light.distance = 3.2;
        }
      } catch {
        glow = null;
      }
    },
    take() {
      if (rifle) ((rifle.visible = false), root?.remove(rifle), (rifle = null));
    },
    clear,
    update(dt) {
      if (!root || !lamp || !M.lamp) return;
      clock += dt;
      // It breathes while the rifle is there, and goes out once the crate is empty.
      fade = rifle ? 1 : Math.max(0, fade - dt * 2.2);
      const k = fade * (0.78 + 0.22 * Math.sin(clock * 3.1));
      M.lamp.color?.copy?.(lampColor).multiplyScalar(0.3 + k * 3.4);
      if (glow?.light) glow.light.intensity = GLOW * fade * (0.92 + 0.08 * Math.sin(clock * 3.1));
      if (!rifle && fade <= 0) ((lamp.visible = false), dark());
    },
    get full() {
      return !!rifle;
    },
    get root() {
      return root;
    },
    setLid(k) {
      if (lidOf) lidOf.rotation.x = -1.92 * Math.min(1.2, Math.max(0, k));
    },
  };
}
