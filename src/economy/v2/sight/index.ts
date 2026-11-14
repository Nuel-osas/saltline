// sight/: the yard's machines read at a glance, and a new player's first raid is fair.
//
// A first-time player could not see what was killing them: a hound is a metre-long walker whose only light is a 12 cm
// lens slit, a gull a dark one-metre drone with a 4 cm lens under its belly, and at 25 m in a bright yard or a dark
// shed both are a few grey pixels. This module adds, from outside the bundle:
//   - a signal lamp's glow on each machine's own lens, amber while it patrols and red once it has seen the player,
//     never smaller than a few pixels out to 60 m and hidden by walls like any light (rules.ts lampSize);
//   - a little more light on the machines' shared shell and on the gull's own searchlight beam, so the body is not a
//     black cut-out in the shed or against a dark sky;
//   - a red marker on every machine that has seen the player within 40 m, held at the screen's edge when it is out of
//     view, with its distance;
//   - the fair first raid: machines' hits do nothing until the rifle is in hand and for 3 s after, and half on a
//     player's first raid (rules.ts machineDamage). Only hits dealt inside the machines' own update are touched, so
//     the Bailiff (its own loop), other players in Skirmish, falls and the player's own charge are left as they were.
//
// It wraps two of the bundle's functions at runtime (G.enemies.update and G.player.damage) and changes no tuning.
// ?sight=0 leaves the game exactly as it was, for before/after comparisons. State is on G.sight.
import "./sight.css";
import { SIGHT, hasExtracted, isThreat, lampSize, lampTone, machineDamage, placeMarker } from "./rules";

/* eslint-disable @typescript-eslint/no-explicit-any -- the game context is the untyped bundle's G */
type Game = any;

/** localStorage: set on this browser's first extraction, when the chain's profile cannot be read. */
export const EXTRACTED_KEY = "saltline.sight.extracted";
const MARK = "__sight";
const MARKERS = 6;
/** How far the glow is drawn toward the camera, so the machine's own body does not cover its lamp from behind. */
const LIFT = 0.32;
/** The shell's added light (linear RGB) and the gull searchlight's gain (the bundle's is 0.085). */
const SHELL_LIFT = [0.13, 0.135, 0.14] as const;
const BEAM_GAIN = 0.16;
/** Lamp colours (HDR, before the game's tone mapping and bloom): the lens's own amber and red, a little hotter. */
const TONE = { watch: [4.2, 1.5, 0.12], seen: [5, 0.3, 0.08] } as const;

export interface SightState {
  firstRaid: boolean;
  /** Seconds of play since the player was last without the rifle this raid. */
  sinceUnarmed: number;
  /** Machine damage asked for and dealt this raid, so a run can be checked. */
  asked: number;
  dealt: number;
  lamps: number;
  threats: number;
  /** The lamps' and markers' CPU time per frame (ms, smoothed). */
  costMs: number;
}

export interface Sight {
  readonly state: SightState;
  /** False hides the lamps and markers (the damage rule stays): for measuring what they cost in the same session. */
  visuals: boolean;
  dispose(): void;
}

interface Lamp {
  sprite: any;
  mat: any;
  bone: any;
  local: any;
  seen: number;
  phase: number;
}

const storage = (): Storage | null => {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
};

export function startSight(G: Game): Sight | null {
  if (typeof location !== "undefined" && new URLSearchParams(location.search).get("sight") === "0") return null;
  const T = G?.THREE;
  if (!T || !G.scene || typeof document === "undefined") return null;

  const state: SightState = { firstRaid: true, sinceUnarmed: Infinity, asked: 0, dealt: 0, lamps: 0, threats: 0, costMs: 0 };
  let visuals = true;
  let playT = 0;
  let lastUnarmed = -Infinity;
  let profileExtractions: number | null = null;
  let inMachines = false;
  let disposed = false;
  let frame = 0;

  // ---- the fair first raid ----------------------------------------------------------------------------------------
  const localFlag = () => storage()?.getItem(EXTRACTED_KEY) === "1";
  const refreshFirstRaid = () => void (state.firstRaid = !hasExtracted(profileExtractions, localFlag()));
  const readProfile = () => {
    const id = G.v2?.wallet?.accountId?.();
    if (!id || !G.v2?.chain?.profile) return;
    Promise.resolve()
      .then(() => G.v2.chain.profile(id))
      .then(
        (p: any) => {
          profileExtractions = p && Number.isFinite(p.extractions) ? p.extractions : null;
          refreshFirstRaid();
        },
        () => void 0, // unreadable: the local note decides
      );
  };
  const fair = (): { armed: boolean | undefined; sinceUnarmed: number; firstRaid: boolean } => ({
    armed: G.coach?.state?.armed,
    sinceUnarmed: playT - lastUnarmed,
    firstRaid: state.firstRaid,
  });

  const offs: (() => void)[] = [];
  const on = (name: string, fn: (e: any) => void) => {
    const off = G.events?.on?.(name, (e: any) => {
      try {
        fn(e);
      } catch (err) {
        console.warn(`[sight] ${name}:`, err);
      }
    });
    if (typeof off === "function") offs.push(off);
  };
  on("run:start", () => {
    lastUnarmed = -Infinity;
    state.asked = state.dealt = 0;
    refreshFirstRaid();
    readProfile();
  });
  on("extraction:reached", () => {
    try {
      storage()?.setItem(EXTRACTED_KEY, "1");
    } catch {
      /* private window: the profile still decides */
    }
    refreshFirstRaid();
  });
  refreshFirstRaid();
  readProfile();

  // ---- lamps --------------------------------------------------------------------------------------------------------
  const group = new T.Group();
  group.name = "sight";
  G.scene.add(group);
  const glow = (() => {
    const c = document.createElement("canvas");
    c.width = c.height = 64;
    const g = c.getContext("2d");
    if (g) {
      // A lit lens in a dark bezel: the lens carries the colour (and, past 1.0, the bloom in the dark); the bezel
      // keeps it apart from a bright sky or a sunlit wall, where a glow alone washes out.
      const r = g.createRadialGradient(32, 32, 0, 32, 32, 32);
      r.addColorStop(0, "rgba(255,255,255,1)");
      r.addColorStop(0.18, "rgba(255,255,255,1)");
      r.addColorStop(0.48, "rgba(150,150,150,1)");
      r.addColorStop(0.6, "rgba(25,25,25,0.85)");
      r.addColorStop(0.8, "rgba(0,0,0,0.4)");
      r.addColorStop(1, "rgba(0,0,0,0)");
      g.fillStyle = r;
      g.fillRect(0, 0, 64, 64);
    }
    const t = new T.CanvasTexture(c);
    if (T.SRGBColorSpace) t.colorSpace = T.SRGBColorSpace;
    return t;
  })();
  const lamps = new Map<any, Lamp>();
  const all: Lamp[] = [];

  /** The lens's centre in its bone's space, from the rig's own lens triangles; the rig's root if it can't be found. */
  function anchor(e: any): { bone: any; local: any } {
    const rig = e.rig;
    let found: { bone: any; local: any } | null = null;
    rig?.group?.traverse?.((o: any) => {
      if (found || !o.isSkinnedMesh || !Array.isArray(o.material)) return;
      const mi = o.material.indexOf(e.lens);
      const g = o.geometry,
        pos = g?.attributes?.position,
        si = g?.attributes?.skinIndex;
      const gr = mi >= 0 ? g?.groups?.find((x: any) => x.materialIndex === mi) : null;
      if (!gr || !pos || !si || !o.skeleton) return;
      const c = new T.Vector3(),
        v = new T.Vector3();
      const votes = new Map<number, number>();
      let n = 0;
      for (let q = gr.start; q < gr.start + gr.count; q++) {
        const k = g.index ? g.index.getX(q) : q;
        c.add(v.fromBufferAttribute(pos, k));
        const b = si.getX(k);
        votes.set(b, (votes.get(b) || 0) + 1);
        n++;
      }
      if (!n) return;
      c.multiplyScalar(1 / n).applyMatrix4(o.bindMatrix);
      let bi = 0,
        best = -1;
      for (const [b, count] of votes) if (count > best) ((best = count), (bi = b));
      const bone = o.skeleton.bones[bi],
        inv = o.skeleton.boneInverses[bi];
      if (bone && inv) found = { bone, local: c.applyMatrix4(inv) };
    });
    return found ?? { bone: rig?.group ?? null, local: new T.Vector3(0, e.type === "hound" ? 0.92 : -0.12, 0.3) };
  }

  function lampFor(e: any): Lamp | null {
    let l = lamps.get(e);
    if (l) return l;
    if (!e?.rig?.group) return null;
    const { bone, local } = anchor(e);
    if (!bone) return null;
    const mat = new T.SpriteMaterial({ map: glow, color: new T.Color(1, 1, 1), transparent: true, depthWrite: false, depthTest: true, blending: T.NormalBlending, fog: false });
    const sprite = new T.Sprite(mat);
    sprite.visible = false;
    sprite.renderOrder = 5;
    sprite.name = "sight-lamp";
    group.add(sprite);
    l = { sprite, mat, bone, local, seen: -1, phase: all.length * 1.7 };
    lamps.set(e, l);
    all.push(l);
    return l;
  }

  // The bodies: a touch of light on the shared shell (only the machines and their wrecks use this material) and a
  // brighter searchlight beam on the gulls. Uniforms only, so nothing recompiles.
  let bodies = false;
  let undoBodies: (() => void) | null = null;
  function liftBodies() {
    const mats = G.enemies?.debug?.mats;
    if (bodies || !mats) return;
    bodies = true;
    const shell = mats.shell,
      beam = mats.cone?.uniforms?.uGain;
    const was = { e: shell?.emissive?.clone?.(), g: beam?.value };
    if (shell?.emissive) shell.emissive.setRGB(SHELL_LIFT[0], SHELL_LIFT[1], SHELL_LIFT[2]);
    if (beam && typeof beam.value === "number") beam.value = BEAM_GAIN;
    undoBodies = () => {
      if (was.e && shell?.emissive) shell.emissive.copy(was.e);
      if (beam && was.g !== undefined) beam.value = was.g;
    };
  }

  // ---- markers ------------------------------------------------------------------------------------------------------
  const layer = document.createElement("div");
  layer.className = "sg-layer";
  layer.setAttribute("aria-hidden", "true");
  const marks = Array.from({ length: MARKERS }, () => {
    const el = document.createElement("div");
    el.className = "sg-mark";
    const pip = document.createElement("i");
    const label = document.createElement("b");
    el.append(pip, label);
    layer.append(el);
    return { el, pip, label, shown: false, text: "", cls: "" };
  });
  for (const m of marks) m.el.style.display = "none";
  document.body.append(layer);
  let marksShown = 0;
  function hideMarks(from = 0) {
    for (let i = from; i < marks.length; i++) {
      const m = marks[i];
      if (m.shown) ((m.shown = false), (m.el.style.display = "none"));
    }
    marksShown = Math.min(marksShown, from);
  }

  // ---- the per-frame pass, run right after the machines move (so lamps and markers sit where they are drawn) --------
  const p = new T.Vector3(),
    cam = new T.Vector3(),
    toward = new T.Vector3(),
    view = new T.Vector3();
  function afterMachines() {
    frame++;
    if (!visuals) {
      if (state.lamps || state.threats) {
        for (const l of all) l.sprite.visible = false;
        hideMarks();
        state.lamps = state.threats = 0;
      }
      return;
    }
    const list: any[] = G.enemies?.list || [];
    const camera = G.camera;
    if (!camera) return;
    camera.updateMatrixWorld();
    cam.setFromMatrixPosition(camera.matrixWorld);
    const fov = typeof camera.getEffectiveFOV === "function" ? camera.getEffectiveFOV() : camera.fov || 70;
    const W = window.innerWidth || 1280,
      H = window.innerHeight || 720;
    const tanY = Math.tan((fov * Math.PI) / 360);
    const player = G.player?.pos;
    let lit = 0,
      used = 0;
    const t = playT;
    for (const e of list) {
      if (!e || !e.alive || !e.active || e.bailiff) continue;
      const l = lampFor(e);
      if (!l) continue;
      l.bone.updateWorldMatrix(true, false);
      p.copy(l.local).applyMatrix4(l.bone.matrixWorld);
      const d = p.distanceTo(cam);
      // The marker first, on the lens itself.
      if (player && used < MARKERS && isThreat(e, player)) {
        view.copy(p).applyMatrix4(camera.matrixWorldInverse);
        const at = placeMarker(view.x, view.y, view.z, tanY, W, H);
        const m = marks[used++];
        const cls = at.on ? "sg-mark on" : "sg-mark edge";
        if (m.cls !== cls) ((m.cls = cls), (m.el.className = cls));
        const text = `${Math.round(d)}m`;
        if (m.text !== text) ((m.text = text), (m.label.textContent = text));
        m.el.style.transform = `translate3d(${at.x.toFixed(1)}px, ${at.y.toFixed(1)}px, 0)`;
        m.pip.style.transform = at.on ? "" : `rotate(${at.angle.toFixed(3)}rad)`;
        if (!m.shown) ((m.shown = true), (m.el.style.display = ""));
      }
      // Then the lamp, drawn a little toward the camera.
      toward.copy(cam).sub(p);
      const len = toward.length();
      if (len > 1e-3) p.addScaledVector(toward, Math.min(LIFT, len * 0.5) / len);
      const tone = lampTone(e.mode);
      const beat = tone === "seen" ? 1 + 0.35 * Math.max(0, Math.sin(t * 10 + l.phase)) : 0.82 + 0.18 * Math.sin(t * 2.6 + l.phase);
      const k = beat * (1 + Math.min(2, +e.flare || 0) * 0.6);
      const c = TONE[tone];
      l.mat.color.setRGB(c[0] * k, c[1] * k, c[2] * k);
      const s = lampSize(d, fov, H);
      l.sprite.position.copy(p);
      l.sprite.scale.set(s, s, 1);
      l.sprite.visible = true;
      l.seen = frame;
      lit++;
    }
    for (const l of all) if (l.seen !== frame && l.sprite.visible) l.sprite.visible = false;
    if (used < marksShown) hideMarks(used);
    marksShown = used;
    state.lamps = lit;
    state.threats = used;
  }

  // ---- wrapping the bundle (again whenever it hands out a new enemies system or player) ----------------------------
  function install() {
    const en = G.enemies;
    if (en && typeof en.update === "function" && !en.update[MARK]) {
      const orig = en.update;
      const wrapped = function (this: unknown, dt: number) {
        if (dt > 0) playT += Math.min(dt, 0.05);
        if (G.coach?.state?.armed === false) lastUnarmed = playT;
        state.sinceUnarmed = playT - lastUnarmed;
        inMachines = true;
        try {
          return orig.call(this ?? en, dt);
        } finally {
          inMachines = false;
          try {
            const c0 = performance.now();
            afterMachines();
            state.costMs += (performance.now() - c0 - state.costMs) * 0.05;
          } catch (err) {
            if (!(wrapped as any).warned) (((wrapped as any).warned = true), console.warn("[sight] frame:", err));
          }
        }
      };
      (wrapped as any)[MARK] = orig;
      en.update = wrapped;
    }
    const pl = G.player;
    if (pl && typeof pl.damage === "function" && !pl.damage[MARK]) {
      const orig = pl.damage;
      const wrapped = function (this: unknown, amount: number, from?: unknown) {
        if (!inMachines) return orig.call(this ?? pl, amount, from);
        const n = machineDamage(amount, fair());
        if (amount > 0) ((state.asked += amount), (state.dealt += n > 0 ? n : 0));
        if (!(n > 0)) return; // absorbed: no hit flash, no shake, no "player:hit"
        return orig.call(this ?? pl, n, from);
      };
      (wrapped as any)[MARK] = orig;
      pl.damage = wrapped;
    }
    liftBodies();
  }

  let raf = 0;
  const loop = () => {
    if (disposed) return;
    try {
      install();
      if (G.game?.state !== "playing") {
        if (marksShown) hideMarks();
        // Lamps stay where they are while paused; on the title the machines are gone and so are their lamps.
        if (G.game?.state === "title") for (const l of all) l.sprite.visible = false;
      }
    } catch (err) {
      console.warn("[sight] install:", err);
    }
    raf = requestAnimationFrame(loop);
  };
  loop();

  const sight: Sight = {
    state,
    get visuals() {
      return visuals;
    },
    set visuals(v: boolean) {
      visuals = !!v;
    },
    dispose() {
      disposed = true;
      cancelAnimationFrame(raf);
      for (const off of offs) off();
      const en = G.enemies,
        pl = G.player;
      if (en?.update?.[MARK]) en.update = en.update[MARK];
      if (pl?.damage?.[MARK]) pl.damage = pl.damage[MARK];
      undoBodies?.();
      G.scene?.remove?.(group);
      for (const l of all) l.mat.dispose();
      glow.dispose();
      layer.remove();
    },
  };
  G.sight = sight;
  return sight;
}

export { SIGHT };
