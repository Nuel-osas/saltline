// The drop point's props, generated in code from the game's own materials: the long issue crate with the rifle in
// it, the supply crate the carriers set down, the hand lamp and the coiled line. They are built once and stay at the
// player's start after the film; the film only moves them.
/* eslint-disable @typescript-eslint/no-explicit-any -- three.js and the game context come from the untyped bundle */
type Obj = any;

/**
 * Where the drop point is, for the lane that makes taking the rifle interactive. `crate` is the long crate's resting
 * place (its centre on the ground, about 2 m in front of the player's start, its open side facing the player);
 * `yaw` is its rotation.y; `rifle` is the rifle lying in it (hide it when the player takes it).
 */
export const DROP: { crate: { x: number; y: number; z: number }; yaw: number; size: { long: number; deep: number; high: number }; rifle: Obj | null; ready: boolean } = {
  crate: { x: -30, y: 0, z: 6 },
  yaw: Math.PI / 2,
  size: { long: 1.24, deep: 0.44, high: 0.34 },
  rifle: null,
  ready: false,
};

export interface LongCrate {
  root: Obj;
  rifle: Obj;
  /** 0 shut, 1 open. */
  setLid(k: number): void;
}

const LONG = DROP.size.long,
  DEEP = DROP.size.deep,
  HIGH = 0.3,
  WALL = 0.022;

export function createProps(G: Obj) {
  const T = G.THREE;
  const mat = (name: string) => {
    try {
      return G.mats.get(name, { triplanar: true });
    } catch {
      return new T.MeshStandardMaterial({ color: 0x30362f, roughness: 0.7 });
    }
  };
  const box = (m: Obj, w: number, h: number, d: number, x: number, y: number, z: number, shadow = true) => {
    const o = new T.Mesh(new T.BoxGeometry(w, h, d), m);
    o.position.set(x, y, z);
    o.castShadow = shadow;
    o.receiveShadow = true;
    return o;
  };
  /** Stencilled text (the game's own label renderer) on a plane `w` metres wide, facing +z. */
  const label = (text: string, w: number, opts: object = {}) => {
    try {
      const L = G.mats.label(text, { color: "white", font: "stencil", distress: 0.3, ...opts });
      const o = new T.Mesh(new T.PlaneGeometry(1, 1), L.material);
      o.scale.set(w, w / (L.aspect || 4), 1);
      o.renderOrder = 2;
      return o;
    } catch {
      return null;
    }
  };

  /**
   * The issue rifle as it lies in the crate: on its side along +x, muzzle to the player's left, sights to the back.
   * Generated from plain shapes in the game's gun finishes, so it reads as a rifle from above in any light.
   */
  function rifle(): Obj {
    const g = new T.Group();
    g.name = "intro-rifle";
    const dark = mat("gunmetal"),
      black = mat("polymer_black"),
      tan = mat("polymer_tan");
    const b = (m: Obj, w: number, d: number, x: number, z: number, h = 0.04, ry = 0) => {
      const o = box(m, w, h, d, x, h / 2, z, false);
      o.rotation.y = ry;
      g.add(o);
    };
    b(dark, 0.27, 0.078, 0.02, 0, 0.046); // receiver
    b(black, 0.25, 0.058, -0.235, 0.004, 0.042); // handguard
    b(dark, 0.21, 0.02, -0.455, -0.008, 0.02); // barrel
    b(dark, 0.055, 0.03, -0.575, -0.008, 0.028); // muzzle
    b(black, 0.2, 0.062, 0.25, 0.012, 0.04, -0.06); // stock
    b(black, 0.024, 0.115, 0.36, 0.022, 0.044); // butt
    b(black, 0.042, 0.1, 0.105, 0.085, 0.036, 0.3); // grip
    b(tan, 0.052, 0.15, -0.05, 0.105, 0.03, -0.12); // magazine
    b(dark, 0.19, 0.022, 0.0, -0.05, 0.03); // rail
    b(dark, 0.02, 0.03, -0.33, -0.036, 0.03); // front sight
    return g;
  }

  /** Local frame: +x along its length, +z its front (the side the player sees), hinged along the back. */
  function longCrate(): LongCrate {
    const root = new T.Group();
    root.name = "intro-crate";
    const green = mat("paint_green"),
      steel = mat("steel_dark"),
      worn = mat("steel_worn"),
      lining = mat("cardboard"),
      rope = mat("rope");
    root.add(box(green, LONG, WALL, DEEP, 0, WALL / 2 + 0.012, 0));
    root.add(box(green, LONG, HIGH, WALL, 0, HIGH / 2 + 0.012, DEEP / 2 - WALL / 2));
    root.add(box(green, LONG, HIGH, WALL, 0, HIGH / 2 + 0.012, -DEEP / 2 + WALL / 2));
    for (const s of [1, -1]) {
      root.add(box(green, WALL, HIGH, DEEP - WALL * 2, s * (LONG / 2 - WALL / 2), HIGH / 2 + 0.012, 0));
      root.add(box(steel, 0.03, HIGH + 0.01, 0.03, s * (LONG / 2 - 0.012), HIGH / 2 + 0.012, DEEP / 2 - 0.012, false));
      root.add(box(steel, 0.03, HIGH + 0.01, 0.03, s * (LONG / 2 - 0.012), HIGH / 2 + 0.012, -DEEP / 2 + 0.012, false));
      root.add(box(worn, 0.05, 0.075, 0.014, s * 0.36, HIGH - 0.03, DEEP / 2 + 0.007, false)); // front latches
      const h = new T.Mesh(new T.TorusGeometry(0.07, 0.012, 5, 10, Math.PI), rope);
      h.position.set(s * (LONG / 2 + 0.004), HIGH * 0.62, 0);
      h.rotation.set(Math.PI, Math.PI / 2, 0);
      root.add(h);
    }
    root.add(box(worn, 0.014, 0.08, 0.06, -LONG / 2 - 0.007, HIGH - 0.03, 0, false)); // the end latch Moss kicks
    root.add(box(steel, LONG, 0.03, 0.05, 0, 0.015, DEEP / 2 - 0.06, false), box(steel, LONG, 0.03, 0.05, 0, 0.015, -DEEP / 2 + 0.06, false)); // skids
    // The lining: a pale bed, so the dark rifle reads against it in any light.
    root.add(box(mat("paint_white"), LONG - WALL * 2 - 0.004, 0.11, DEEP - WALL * 2 - 0.004, 0, 0.012 + WALL + 0.055, 0, false));
    const front = label("PAC-9 · RIFLE, ISSUE", 0.62);
    if (front) (front.position.set(0, HIGH * 0.5, DEEP / 2 + 0.002), root.add(front));

    const gun = rifle();
    gun.position.set(0.09, 0.012 + WALL + 0.11, -0.01);
    root.add(gun);

    const lid = new T.Group();
    lid.position.set(0, HIGH + 0.012, -DEEP / 2);
    lid.add(box(green, LONG + 0.012, 0.04, DEEP + 0.012, 0, 0.02, DEEP / 2));
    lid.add(box(lining, LONG - 0.08, 0.012, DEEP - 0.08, 0, -0.004, DEEP / 2, false));
    const top = label("PORT AUTHORITY", 0.74);
    if (top) (top.rotation.set(-Math.PI / 2, 0, 0), top.position.set(0, 0.0415, DEEP / 2), lid.add(top));
    const inside = label("PROPERTY OF THE PORT AUTHORITY", 0.98, { color: "red", distress: 0.2 });
    if (inside) (inside.rotation.set(Math.PI / 2, 0, 0), inside.position.set(0, -0.0105, DEEP / 2 + 0.03), lid.add(inside));
    for (const s of [1, -1]) lid.add(box(steel, 0.03, 0.045, DEEP + 0.014, s * (LONG / 2 - 0.012), 0.02, DEEP / 2, false));
    root.add(lid);
    return {
      root,
      rifle: gun,
      setLid(k) {
        lid.rotation.x = -1.92 * k;
      },
    };
  }

  /** The crate two workers carry: the game's own wooden crate, at a size two people can lift. */
  function supply(): Obj {
    const g = new T.Group();
    g.name = "intro-supply";
    let c: Obj = null;
    try {
      c = G.props?.build?.("crate_wood", { seed: 41 }) ?? null;
    } catch {
      c = null;
    }
    if (!c) c = box(mat("wood_pallet"), 1.1, 1, 0.9, 0, 0.5, 0);
    // Along +z (the way it is carried), 0.72 long and half a metre high.
    const b = new T.Box3().setFromObject(c);
    const size = b.getSize(new T.Vector3());
    c.scale.set(0.5 / (size.x || 1), 0.5 / (size.y || 1), 0.72 / (size.z || 1));
    c.position.y -= b.min.y * c.scale.y;
    g.add(c);
    const rope = mat("rope");
    for (const s of [1, -1]) {
      const h = new T.Mesh(new T.TorusGeometry(0.11, 0.014, 5, 10, Math.PI), rope);
      h.position.set(0, 0.43, s * 0.365);
      h.rotation.set(0, 0, 0);
      g.add(h);
    }
    return g;
  }

  /** A caged hand lamp: its glow is its own; the light it throws is a pooled light the stage moves with it. */
  function lamp(): { root: Obj; glow: Obj } {
    const root = new T.Group();
    root.name = "intro-lamp";
    const steel = mat("steel_dark");
    const glowMat = new T.MeshBasicMaterial({ color: new T.Color(1, 0.6, 0.22).multiplyScalar(5), toneMapped: true });
    const glow = new T.Mesh(new T.CylinderGeometry(0.036, 0.036, 0.1, 10), glowMat);
    glow.position.y = -0.11;
    root.add(glow);
    const cap = new T.Mesh(new T.CylinderGeometry(0.05, 0.056, 0.03, 10), steel);
    cap.position.y = -0.045;
    const base = new T.Mesh(new T.CylinderGeometry(0.056, 0.05, 0.035, 10), steel);
    base.position.y = -0.178;
    const bail = new T.Mesh(new T.TorusGeometry(0.045, 0.006, 4, 10, Math.PI), steel);
    bail.position.y = -0.03;
    root.add(cap, base, bail);
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + 0.4;
      root.add(box(steel, 0.006, 0.11, 0.006, Math.cos(a) * 0.046, -0.11, Math.sin(a) * 0.046, false));
    }
    return { root, glow };
  }

  /** A coil of mooring line on the ground. */
  function coil(): Obj {
    const g = new T.Group();
    g.name = "intro-coil";
    const rope = mat("rope");
    for (let i = 0; i < 4; i++) {
      const t = new T.Mesh(new T.TorusGeometry(0.2 - i * 0.012, 0.022, 5, 16), rope);
      t.rotation.x = Math.PI / 2 + (i % 2 ? 0.05 : -0.04);
      t.position.set((i % 2) * 0.012, 0.024 + i * 0.04, (i % 3) * 0.01);
      t.castShadow = true;
      g.add(t);
    }
    return g;
  }

  return { longCrate, supply, lamp, coil, mat, box };
}
