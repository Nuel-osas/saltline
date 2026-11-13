// The film's own props at the drop point, generated in code from the game's materials: the supply crate the carriers
// set down, the hand lamp and the coiled line. They are on set only while the film plays. The long rifle crate is not
// here: it is the coach's (../coach/crate.ts), the one every raid starts at, so the film and the raid show one crate.
/* eslint-disable @typescript-eslint/no-explicit-any -- three.js and the game context come from the untyped bundle */
type Obj = any;

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

  return { supply, lamp, coil, mat, box };
}
