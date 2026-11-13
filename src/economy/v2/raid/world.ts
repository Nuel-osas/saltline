// What a raid puts in the yard, adapted from v1's salvage/world.ts: a customs seal on each manifest container (a
// bonded one wears the Harbormaster's own grey placard, two straps and a cold blue lock), the wrecks other players
// left (a toppled crate, their callsign on a board and, when the wreck holds a gun, the gun lying on it with its
// frame and grade stencilled under the callsign), and the parts destroyed machines drop. All generated in code from
// the game's own materials, labels and sparks, added to G.scene and removed again at the next raid.
import { CRATE_X, WRECK_SLOTS, atDoor, wreckPoint, type Point } from "../../salvage/place";
import { lostAgo } from "../../salvage/run";
import { SALVAGE_SPOTS, type SalvageSpot } from "../../salvage/spots";
import { FRAMES } from "../items";
import type { Container, Raid, Wreck as WreckView } from "../types";
import { SHORT } from "./rules";

/* eslint-disable @typescript-eslint/no-explicit-any -- three.js arrives untyped from the game bundle (G.THREE) */
type Obj = any;

export interface RaidWorld {
  /** Seals and wrecks for a raid. `wreckSlots` maps a wreck id to the WRECK_SLOTS index it lies in. */
  build(raid: Raid, wreckSlots: Map<number, number>): void;
  clear(): void;
  cutSeal(spot: number): void;
  recoverWreck(id: number): void;
  /** A part on the ground where a machine fell. */
  addPart(id: number, kind: "servo" | "rotor", at: Point): void;
  removePart(id: number): void;
  /** Sparks at a seal or wreck while E is held. */
  working(at: Point, outX: number, outZ: number): void;
  update(dt: number): void;
}

const STUB: RaidWorld = { build() {}, clear() {}, cutSeal() {}, recoverWreck() {}, addPart() {}, removePart() {}, working() {}, update() {} };

interface Seal {
  spot: number;
  bonded: boolean;
  group: Obj;
  bands: Obj[];
  bandY: number;
  floorY: number;
  leds: Obj[];
  tag: Obj;
  cargo: Obj | null;
  falling: { y: number; vy: number; spin: number } | null;
  box: Obj | null;
}

interface Wreck {
  id: number;
  group: Obj;
  tip: Obj;
  gun: Obj | null;
  box: Obj | null;
  phase: number;
  gone: number;
}

interface Part {
  id: number;
  group: Obj;
  y: number;
  phase: number;
}

export function createRaidWorld(G: any): RaidWorld {
  const T = G && G.THREE;
  if (!T || !G.scene || !G.mats || typeof G.mats.get !== "function") return STUB;

  const mat = (name: string, fallback: number) => {
    try {
      return G.mats.get(name);
    } catch {
      return new T.MeshStandardMaterial({ color: fallback, roughness: 0.7 });
    }
  };
  const glow = (color: number, k: number) => {
    try {
      return G.mats.emissive(color, k).clone();
    } catch {
      return new T.MeshBasicMaterial({ color: new T.Color(color).multiplyScalar(k) });
    }
  };

  const M = {
    placard: mat("paint_yellow", 0xd9a521),
    bonded: new T.MeshStandardMaterial({ color: 0x1c2630, roughness: 0.55, metalness: 0.35 }),
    strap: new T.MeshStandardMaterial({ color: 0xc8611a, roughness: 0.82, metalness: 0 }),
    bondStrap: new T.MeshStandardMaterial({ color: 0x8fa3b3, roughness: 0.45, metalness: 0.6 }),
    steel: mat("steel_dark", 0x2b2e31),
    tag: mat("plastic_red", 0xa82a1c),
    led: glow(0xff2a14, 1),
    bondLed: glow(0x58c8ff, 1),
    ledDead: new T.MeshStandardMaterial({ color: 0x1d1a19, roughness: 0.5 }),
    tarp: mat("tarp", 0x3b4a3c),
    wood: mat("wood_pallet", 0x8a6a48),
    strobe: glow(0xff4a1c, 1),
    gun: new T.MeshStandardMaterial({ color: 0x16181a, roughness: 0.5, metalness: 0.6 }),
    furniture: new T.MeshStandardMaterial({ color: 0x6b5236, roughness: 0.7, metalness: 0 }),
    part: glow(0xffb347, 1),
    scorch: new T.MeshBasicMaterial({ map: scorchTexture(T), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }),
  };
  const ledColor = new T.Color(0xff2a14);
  const bondColor = new T.Color(0x58c8ff);
  const strobeColor = new T.Color(0xff4a1c);
  const partColor = new T.Color(0xffb347);
  const Gm = {
    placard: new T.BoxGeometry(0.014, 0.44, 0.62),
    bondPlacard: new T.BoxGeometry(0.02, 0.56, 0.86),
    strap: new T.BoxGeometry(0.014, 0.05, 2.34),
    crateStrap: new T.BoxGeometry(0.014, 0.05, 1.14),
    seal: new T.BoxGeometry(0.06, 0.15, 0.1),
    bondSeal: new T.BoxGeometry(0.09, 0.2, 0.16),
    tag: new T.BoxGeometry(0.004, 0.085, 0.05),
    led: new T.BoxGeometry(0.012, 0.024, 0.024),
    bondLed: new T.BoxGeometry(0.014, 0.03, 0.1),
    plane: new T.PlaneGeometry(1, 1),
    board: new T.BoxGeometry(0.03, 0.42, 1.0),
    gunBoard: new T.BoxGeometry(0.03, 0.6, 1.0),
    tarp: new T.BoxGeometry(1.25, 0.018, 1.05),
    beacon: new T.CylinderGeometry(0.03, 0.04, 0.22, 10),
    tip: new T.SphereGeometry(0.04, 12, 8),
    servo: new T.CylinderGeometry(0.09, 0.09, 0.16, 12),
    rotor: new T.BoxGeometry(0.42, 0.02, 0.06),
    hub: new T.CylinderGeometry(0.05, 0.05, 0.08, 10),
    ring: new T.RingGeometry(0.2, 0.26, 20),
  };

  const mesh = (geo: Obj, m: Obj, x: number, y: number, z: number, shadow = true) => {
    const o = new T.Mesh(geo, m);
    o.position.set(x, y, z);
    o.castShadow = shadow;
    o.receiveShadow = true;
    return o;
  };
  /** A canvas label (the game's own stencil/sans renderer) on a plane facing local +x, `w` metres wide. */
  const label = (text: string, opts: object, w: number, x: number, y: number, z: number) => {
    let L: { material: Obj; aspect: number };
    try {
      L = G.mats.label(text, opts);
    } catch {
      return null;
    }
    const o = new T.Mesh(Gm.plane, L.material);
    o.scale.set(w, w / (L.aspect || 4), 1);
    o.rotation.y = Math.PI / 2;
    o.position.set(x, y, z);
    o.renderOrder = 2;
    return o;
  };
  const crate = (seed: number) => {
    try {
      const c = G.props && G.props.build("crate_wood", { seed });
      if (c) return c;
    } catch {
      /* fall through to a plain box */
    }
    return mesh(new T.BoxGeometry(1.1, 1, 0.9).translate(0, 0.5, 0), M.wood, 0, 0, 0);
  };
  const collide = (o: Obj, surface: string) => {
    try {
      o.updateWorldMatrix(true, true);
      const b = new T.Box3().setFromObject(o);
      return G.physics.addBox(b.min, b.max, { surface });
    } catch {
      return null;
    }
  };
  const uncollide = (box: Obj) => {
    try {
      if (box) G.physics.removeBox(box);
    } catch {
      /* the physics module went away; nothing to undo */
    }
  };
  const root = new T.Group();
  root.name = "raid";
  G.scene.add(root);
  let seals: Seal[] = [];
  let wrecks: Wreck[] = [];
  let parts: Part[] = [];
  let clock = 0;

  function buildSeal(s: SalvageSpot, c: Container): Seal {
    const g = new T.Group();
    const at = atDoor(s, 0, 0, 0);
    g.position.set(at.x, 0, at.z);
    g.rotation.y = s.yaw;
    let face = 0,
      bandY = 1.14,
      plateY = 1.62,
      plateZ = 0.62,
      floorY = 0,
      box = null;
    if (s.open) {
      floorY = 0.172; // the container's timber floor (game.js)
      const k = crate(s.id * 13 + 5);
      k.position.set(CRATE_X, floorY, 0);
      k.rotation.y = Math.PI / 2;
      g.add(k);
      face = CRATE_X + 0.45;
      bandY = floorY + 0.36;
      plateY = floorY + 0.7;
      plateZ = 0;
    }
    const b = c.bonded;
    // The placard hangs from its top edge, so a broken seal can leave it askew.
    const tag = new T.Group();
    tag.position.set(face + 0.03, plateY + (b ? 0.28 : 0.22), plateZ);
    tag.add(mesh(b ? Gm.bondPlacard : Gm.placard, b ? M.bonded : M.placard, 0, b ? -0.28 : -0.22, 0));
    const ink = b ? "white" : "black";
    const cargo = label(`${SHORT[c.tokenId]} ×${c.amount}`, { color: ink, font: "stencil", distress: 0.12 }, b ? 0.66 : 0.52, 0.012, b ? -0.36 : -0.265, 0);
    const small = label(b ? "BONDED · HARBORMASTER" : "CUSTOMS HOLD · B4", { color: b ? "yellow" : "black", font: b ? "stencil" : "sans", distress: 0.1 }, b ? 0.74 : 0.38, 0.012, b ? -0.12 : -0.07, 0);
    if (cargo) tag.add(cargo);
    if (small) tag.add(small);
    g.add(tag);

    const bands: Obj[] = [];
    const leds: Obj[] = [];
    for (const dy of b ? [0, 0.42] : [0]) {
      const band = new T.Group();
      band.position.set(face, bandY + dy, 0);
      band.add(mesh(s.open ? Gm.crateStrap : Gm.strap, b ? M.bondStrap : M.strap, 0.045, 0, 0, false));
      band.add(mesh(b ? Gm.bondSeal : Gm.seal, M.steel, 0.075, 0, 0));
      if (!b) band.add(mesh(Gm.tag, M.tag, 0.108, -0.085, 0.05, false));
      const led = mesh(b ? Gm.bondLed : Gm.led, b ? M.bondLed : M.led, b ? 0.124 : 0.108, 0.035, 0, false);
      band.add(led);
      g.add(band);
      bands.push(band);
      leds.push(led);
    }
    root.add(g);
    if (s.open) box = collide(g.children[0], "wood");
    return { spot: s.id, bonded: b, group: g, bands, bandY, floorY, leds, tag, cargo, falling: null, box };
  }

  /** A rifle's outline in four boxes, lying on the wreck: enough to read as a gun from across the lane. */
  function gunProp() {
    const g = new T.Group();
    g.add(mesh(new T.BoxGeometry(0.42, 0.07, 0.05), M.gun, 0, 0, 0));
    g.add(mesh(new T.BoxGeometry(0.34, 0.03, 0.03), M.gun, 0.36, 0.01, 0));
    g.add(mesh(new T.BoxGeometry(0.07, 0.17, 0.04), M.furniture, 0.04, -0.11, 0));
    g.add(mesh(new T.BoxGeometry(0.24, 0.09, 0.045), M.furniture, -0.32, -0.015, 0));
    return g;
  }

  function buildWreck(s: SalvageSpot, w: WreckView, slot: number): Wreck {
    const g = new T.Group();
    const at = wreckPoint(s, slot);
    g.position.set(at.x, 0, at.z);
    g.rotation.y = s.yaw + (WRECK_SLOTS[slot]?.[1] ?? 1) * 0.11;
    const scorch = new T.Mesh(Gm.plane, M.scorch);
    scorch.rotation.x = -Math.PI / 2;
    scorch.scale.set(3.2, 3.2, 1);
    scorch.position.set(-0.2, 0.012, 0);
    scorch.renderOrder = 1;
    g.add(scorch);
    const heap = new T.Group();
    heap.rotation.y = 0.2;
    const under = crate(w.id * 7 + 11);
    under.scale.setScalar(0.5);
    under.position.set(-0.25, 0, -0.62);
    under.rotation.y = 0.9;
    const c = crate(w.id * 7 + 3);
    c.rotation.x = 0.38;
    c.position.set(-0.15, 0.167, 0.1);
    const tarp = mesh(Gm.tarp, M.tarp, -0.2, 1.06, 0.52);
    tarp.rotation.set(0.6, 0.15, 0.05);
    heap.add(under, c, tarp);
    g.add(heap);
    // The callsign board, leaning on the crate, facing the way in. A wreck holding a gun says which.
    const board = new T.Group();
    board.position.set(0.62, w.weapon ? 0.38 : 0.3, 0.05);
    board.rotation.z = 0.24;
    board.add(mesh(w.weapon ? Gm.gunBoard : Gm.board, M.steel, 0, 0, 0));
    const top = w.weapon ? 0.15 : 0.055;
    const cs = label(w.callsign || "UNKNOWN", { color: "white", font: "stencil", distress: 0.3 }, 0.8, 0.017, top, 0);
    if (cs) board.add(cs);
    let gun: Obj | null = null;
    if (w.weapon) {
      const name = FRAMES[w.weapon.frame].name.replace(/^PAC-\S+\s+/, "").toUpperCase();
      const gl = label(`${name} · ${w.weapon.grade}`, { color: "yellow", font: "stencil", distress: 0.2 }, 0.84, 0.017, -0.02, 0);
      if (gl) board.add(gl);
      gun = gunProp();
      gun.position.set(0.02, 1.2, 0.3);
      gun.rotation.set(0.5, 1.2, 0.25);
      g.add(gun);
    }
    const ago = label(lostAgo(w.at), { color: "white", font: "sans", distress: 0.15 }, 0.42, 0.017, w.weapon ? -0.2 : -0.12, 0);
    if (ago) board.add(ago);
    g.add(board);
    const beacon = mesh(Gm.beacon, M.tag, 0.5, 0.11, 0.86);
    const tip = mesh(Gm.tip, M.strobe.clone(), 0.5, 0.25, 0.86, false);
    g.add(beacon, tip);
    root.add(g);
    return { id: w.id, group: g, tip, gun, box: collide(c, "wood"), phase: (w.id % 7) * 0.37, gone: 0 };
  }

  return {
    build(raid, wreckSlots) {
      this.clear();
      for (const c of raid.containers) {
        const s = SALVAGE_SPOTS[c.spot];
        if (s) seals.push(buildSeal(s, c));
      }
      for (const w of raid.wrecks) {
        const s = SALVAGE_SPOTS[w.spot];
        if (s) wrecks.push(buildWreck(s, w, wreckSlots.get(w.id) ?? 0));
      }
    },
    clear() {
      for (const s of seals) (root.remove(s.group), uncollide(s.box));
      for (const w of wrecks) (root.remove(w.group), uncollide(w.box), w.tip.material.dispose());
      for (const p of parts) root.remove(p.group);
      seals = [];
      wrecks = [];
      parts = [];
    },
    cutSeal(spot) {
      const s = seals.find((e) => e.spot === spot);
      if (!s || s.falling) return;
      for (const led of s.leds) led.material = M.ledDead;
      s.falling = { y: s.bandY, vy: 0.6, spin: (spot % 2 ? 1 : -1) * 2.4 };
      try {
        const L = G.mats.label("SEAL BROKEN", { color: "red", font: "stencil", distress: 0.25 });
        if (s.cargo && L && L.material) {
          s.cargo.material = L.material;
          s.cargo.scale.set(0.5, 0.5 / (L.aspect || 4), 1);
        }
      } catch {
        /* keep the cargo label */
      }
      s.tag.rotation.x = (spot % 2 ? 1 : -1) * 0.14;
    },
    recoverWreck(id) {
      const w = wrecks.find((e) => e.id === id);
      if (!w || w.gone) return;
      w.gone = 0.0001;
      if (w.gun) w.gun.visible = false; // the gun leaves with the player
    },
    addPart(id, kind, at) {
      const g = new T.Group();
      g.position.set(at.x, at.y, at.z);
      const m = M.part.clone();
      if (kind === "servo") {
        const body = mesh(Gm.servo, M.steel, 0, 0, 0);
        body.rotation.z = Math.PI / 2;
        g.add(body, mesh(Gm.hub, m, 0.1, 0, 0, false));
        g.children[1].rotation.z = Math.PI / 2;
      } else {
        g.add(mesh(Gm.rotor, M.steel, 0, 0, 0), mesh(Gm.rotor, M.steel, 0, 0, 0), mesh(Gm.hub, m, 0, 0, 0, false));
        g.children[1].rotation.y = Math.PI / 2;
      }
      const ring = new T.Mesh(Gm.ring, m);
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = -0.3;
      g.add(ring);
      root.add(g);
      parts.push({ id, group: g, y: at.y, phase: (id % 5) * 0.6 });
    },
    removePart(id) {
      const p = parts.find((e) => e.id === id);
      if (!p) return;
      root.remove(p.group);
      parts = parts.filter((e) => e !== p);
    },
    working(at, outX, outZ) {
      try {
        const p = new T.Vector3(at.x + outX * 0.06, at.y, at.z + outZ * 0.06);
        const d = new T.Vector3(outX + (Math.random() - 0.5) * 0.8, 0.5 + Math.random() * 0.6, outZ + (Math.random() - 0.5) * 0.8).normalize();
        G.fx && G.fx.sparks && G.fx.sparks(p, d, 2);
      } catch {
        /* no sparks is fine */
      }
    },
    update(dt) {
      clock += dt;
      // Customs seals blink red together every 1.4 s; a bonded lock holds a cold blue and dips, so the two never
      // read alike across the yard.
      M.led.color.copy(ledColor).multiplyScalar(clock % 1.4 < 0.14 ? 9 : 0.35);
      M.bondLed.color.copy(bondColor).multiplyScalar(3.2 + 2.2 * Math.sin(clock * 2.6));
      for (const s of seals) {
        const f = s.falling;
        if (!f) continue;
        const rest = s.floorY + 0.03;
        if (f.y > rest) {
          f.vy -= 9.8 * dt;
          f.y = Math.max(rest, f.y + f.vy * dt);
          s.bands.forEach((band, i) => {
            band.position.y = Math.max(rest, f.y + (i ? 0.02 : 0));
            band.position.x += dt * (0.35 + i * 0.2);
            band.rotation.x += f.spin * dt * (i ? -0.8 : 1);
            band.rotation.z = Math.min(1.5, band.rotation.z + dt * 3);
            if (f.y === rest) band.rotation.x = Math.round(band.rotation.x / Math.PI) * Math.PI;
          });
        }
      }
      for (const w of wrecks) {
        if (w.gone) {
          w.gone += dt;
          w.tip.visible = false;
          continue;
        }
        const t = (clock + w.phase) % 1.6;
        const on = t < 0.07 || (t > 0.16 && t < 0.23);
        w.tip.material.color.copy(strobeColor).multiplyScalar(on ? 14 : 0.25);
      }
      for (const p of parts) {
        p.group.position.y = p.y + 0.06 * Math.sin(clock * 2.4 + p.phase);
        p.group.rotation.y += dt * 1.6;
        const m = p.group.children[p.group.children.length - 1].material;
        m.color.copy(partColor).multiplyScalar(2.2 + 1.4 * Math.sin(clock * 5 + p.phase));
      }
    },
  };
}

/** A soft scorch for under a wreck: a radial alpha fade generated on a canvas. */
function scorchTexture(T: Obj) {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const x = c.getContext("2d")!;
  const g = x.createRadialGradient(64, 64, 4, 64, 64, 63);
  g.addColorStop(0, "rgba(6,5,4,0.85)");
  g.addColorStop(0.5, "rgba(10,8,6,0.55)");
  g.addColorStop(1, "rgba(12,10,8,0)");
  x.fillStyle = g;
  x.fillRect(0, 0, 128, 128);
  const t = new T.CanvasTexture(c);
  t.colorSpace = T.SRGBColorSpace;
  return t;
}
