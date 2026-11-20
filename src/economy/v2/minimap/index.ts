// minimap/: the yard in a disc under the objective, turning with the player.
//
// The disc shows the yard around the player, 30 m to its edge, with the player's forward always up. The yard is drawn
// once from the level's own collision boxes (so a bigger yard draws itself), shaded by height: waist-high cover,
// a wall or one container, two stacked, higher. On it: the uplinks still to cut (A B C, held at the edge when far),
// the boat (bright and held at the edge once all three are cut), sealed cargo and wrecks in range, and the machines
// that have seen the player, by the same rule as the red markers on screen (sight/rules.ts isThreat): it shows
// nothing the player hasn't already been told.
//
// It reads the game and changes nothing in it: the level's boxes, zones and boat, the player's position and yaw, the
// machines, the raid's targets and the game's objective events. It draws only while a raid is being played, steps
// aside while the first raid's checklist hangs under the objective, and ?minimap=0 leaves it out. State is on G.minimap.
import "./minimap.css";
import { MINI, clampToRing, drawnBoxes, extentOf, marks, tierOf, toDisc, type Box, type Mark, type View } from "./rules";

/* eslint-disable @typescript-eslint/no-explicit-any -- the game context is the untyped bundle's G */
type Game = any;

export interface MinimapState {
  shown: boolean;
  /** The drawing's CPU time per frame (ms, smoothed). */
  costMs: number;
  /** What the last frame drew. */
  marks: number;
  /** The static yard picture: its size in pixels and how many boxes it holds. */
  picture: { w: number; h: number; boxes: number } | null;
}

export interface Minimap {
  readonly state: MinimapState;
  dispose(): void;
}

/** Colours, from the game's tokens (src/ui.css): the ground, the sea, the four height bands, the marks. */
const INK = {
  outside: "#0e1113",
  ground: "#1b2023",
  shed: "#23292d",
  sea: "#0c1820",
  quay: "rgba(232,228,218,0.35)",
  tiers: ["#3b444a", "#5b666d", "#7f8b92", "#a9b3b9"],
  edge: "rgba(11,13,15,0.75)",
  bone: "#e8e4da",
  dim: "rgba(232,228,218,0.55)",
  signal: "#ffb347",
  cargo: "#c9d4d8",
  bonded: "#8fd3ff",
  rust: "#d2622a",
  alarm: "#ff5a40",
  ink: "#0b0d0f",
};

export function startMinimap(G: Game): Minimap | null {
  if (typeof document === "undefined") return null;
  if (new URLSearchParams(location.search).get("minimap") === "0") return null;

  const state: MinimapState = { shown: false, costMs: 0, marks: 0, picture: null };
  const hudRoot: HTMLElement | null = G?.hud?.root instanceof HTMLElement ? G.hud.root : document.querySelector<HTMLElement>("#ui .hud");
  if (!hudRoot) return null;

  const box = document.createElement("div");
  box.className = "mm";
  box.setAttribute("aria-hidden", "true");
  const canvas = document.createElement("canvas");
  box.appendChild(canvas);
  hudRoot.appendChild(box);
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  // ---- the static yard, drawn once per level ----------------------------------------------------------------------
  let picture: { canvas: HTMLCanvasElement; x0: number; z0: number; w: number; h: number } | null = null;
  let builtFor: unknown = null;
  let builtBoxes = -1;

  function build() {
    const L = G.level;
    const boxes: Box[] = G.physics?.boxes || [];
    if (!L || !boxes.length) return;
    if (builtFor === L && builtBoxes === boxes.length) return;
    builtFor = L;
    builtBoxes = boxes.length;
    const zones: { min: [number, number]; max: [number, number] }[] = Array.isArray(L.zones) ? L.zones : [];
    const ext = extentOf(boxes, zones);
    if (!ext) return;
    const P = MINI.ppm;
    const w = Math.ceil((ext.x1 - ext.x0) * P);
    const h = Math.ceil((ext.z1 - ext.z0) * P);
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const g = c.getContext("2d");
    if (!g) return;
    g.setTransform(P, 0, 0, P, -ext.x0 * P, -ext.z0 * P);
    // The ground, then the sea past the quay edge (where the game's apron ends).
    g.fillStyle = INK.ground;
    g.fillRect(ext.x0, ext.z0, ext.x1 - ext.x0, ext.z1 - ext.z0);
    const quayX = quayEdge();
    if (quayX !== null && quayX < ext.x1) {
      g.fillStyle = INK.sea;
      g.fillRect(quayX, ext.z0, ext.x1 - quayX, ext.z1 - ext.z0);
      g.strokeStyle = INK.quay;
      g.lineWidth = 1.5 / P;
      g.beginPath();
      g.moveTo(quayX, ext.z0);
      g.lineTo(quayX, ext.z1);
      g.stroke();
    }
    // Indoors (the shed) a shade lighter, so its walls read as a building.
    for (const b of L.interiorBoxes || []) {
      g.fillStyle = INK.shed;
      g.fillRect(b.min.x, b.min.z, b.max.x - b.min.x, b.max.z - b.min.z);
    }
    const drawn = drawnBoxes(boxes);
    const thin = 1.2 / P; // a fence or a wall is never thinner than about a pixel and a bit
    for (const b of drawn) {
      let x = b.min.x, z = b.min.z, bw = b.max.x - b.min.x, bh = b.max.z - b.min.z;
      if (bw < thin) (x -= (thin - bw) / 2), (bw = thin);
      if (bh < thin) (z -= (thin - bh) / 2), (bh = thin);
      g.fillStyle = INK.tiers[tierOf(b.max.y)];
      g.fillRect(x, z, bw, bh);
      if (bw > 3 * thin && bh > 3 * thin) {
        g.strokeStyle = INK.edge;
        g.lineWidth = 1 / P;
        g.strokeRect(x, z, bw, bh);
      }
    }
    picture = { canvas: c, x0: ext.x0, z0: ext.z0, w: ext.x1 - ext.x0, h: ext.z1 - ext.z0 };
    state.picture = { w, h, boxes: drawn.length };
  }

  /** Where the ground ends and the sea starts: the right edge of the game's apron, or none. */
  function quayEdge(): number | null {
    try {
      const apron = G.scene?.getObjectByName?.("apron");
      if (!apron || !G.THREE) return null;
      const bb = new G.THREE.Box3().setFromObject(apron);
      return Number.isFinite(bb.max.x) ? bb.max.x : null;
    } catch {
      return null;
    }
  }

  // ---- what the raid has cut and opened, from the game's own events ------------------------------------------------
  const cut = new Set<string>();
  let boatOpen = false;
  const offs: (() => void)[] = [];
  const on = (name: string, fn: (e: any) => void) => {
    const off = G.events?.on?.(name, fn);
    if (typeof off === "function") offs.push(off);
  };
  on("run:start", () => {
    cut.clear();
    boatOpen = false;
  });
  on("objective:done", (e) => {
    if (e && typeof e.id === "string") cut.add(e.id);
  });
  on("objective:all", () => {
    boatOpen = true;
  });

  // ---- sizing and placing --------------------------------------------------------------------------------------------
  let size = 0;
  let dpr = 1;
  function fit() {
    const s = Math.round(box.clientWidth);
    const d = Math.min(window.devicePixelRatio || 1, 2);
    if (s === size && d === dpr) return;
    size = s;
    dpr = d;
    canvas.width = Math.max(1, Math.round(s * d));
    canvas.height = Math.max(1, Math.round(s * d));
  }
  /** Hang the disc under the objective block, wherever its text ends. */
  function place() {
    const obj = hudRoot!.querySelector<HTMLElement>(".h-obj");
    const root = hudRoot!.getBoundingClientRect();
    const r = obj && obj.classList.contains("has") ? obj.getBoundingClientRect() : null;
    const top = r && r.height > 0 ? r.bottom - root.top + 14 : null;
    box.style.top = top === null ? "" : `${Math.round(top)}px`;
  }

  // ---- drawing -----------------------------------------------------------------------------------------------------
  let targets: any[] = [];
  let targetsT = 0;
  let placeT = 0;
  let last = performance.now();

  function draw(dt: number) {
    const pl = G.player;
    const pos = pl?.pos;
    if (!pos || !picture) return;
    targetsT -= dt;
    if (targetsT <= 0) {
      targetsT = MINI.targetsEvery;
      try {
        targets = G.raid?.state?.targets ?? [];
      } catch {
        targets = [];
      }
    }
    const R = size / 2;
    const view: View = { x: pos.x, z: pos.z, yaw: Number(pl.yaw) || 0, k: R / MINI.range };
    const g = ctx!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, size, size);
    g.save();
    g.beginPath();
    g.arc(R, R, R - 1, 0, Math.PI * 2);
    g.clip();
    g.fillStyle = INK.outside;
    g.fillRect(0, 0, size, size);
    // The yard, turned so the player's forward is up.
    g.translate(R, R);
    g.rotate(view.yaw);
    g.scale(view.k, view.k);
    g.translate(-view.x, -view.z);
    g.imageSmoothingEnabled = true;
    g.drawImage(picture.canvas, picture.x0, picture.z0, picture.w, picture.h);
    g.restore();

    // What the player is looking at: a faint wedge ahead.
    g.save();
    g.translate(R, R);
    const wedge = g.createRadialGradient(0, 0, 0, 0, 0, R * 0.62);
    wedge.addColorStop(0, "rgba(232,228,218,0.20)");
    wedge.addColorStop(1, "rgba(232,228,218,0)");
    g.fillStyle = wedge;
    g.beginPath();
    g.moveTo(0, 0);
    g.arc(0, 0, R * 0.62, -Math.PI / 2 - 0.55, -Math.PI / 2 + 0.55);
    g.closePath();
    g.fill();
    g.restore();

    const list = marks({
      relays: (G.level?.objectives || []).map((o: any) => ({ id: String(o.id), pos: o.pos })),
      cut,
      boat: G.level?.extraction ?? null,
      boatOpen,
      targets,
      machines: (G.enemies?.list || []).filter((e: any) => e && e.alive && e.active && !e.bailiff),
      player: pos,
    });
    // Seals and wrecks under the uplinks and the boat, threats on top.
    const order: Record<Mark["kind"], number> = { seal: 0, bonded: 0, wreck: 0, "boat-shut": 1, boat: 2, relay: 3, "threat-air": 4, threat: 4 };
    list.sort((a, b) => order[a.kind] - order[b.kind]);
    let drawnMarks = 0;
    for (const m of list) {
      const p = toDisc(view, m.x, m.z);
      const inner = R - 9;
      if (!m.pinned && Math.hypot(p.x, p.y) > inner) continue;
      const at = clampToRing(p, inner);
      mark(g, m, R + at.x, R + at.y, at.edge);
      drawnMarks++;
    }
    state.marks = drawnMarks;

    // North (−z, as on the compass) on the rim.
    const n = toDisc(view, view.x, view.z - 1);
    const nl = Math.hypot(n.x, n.y) || 1;
    const nx = R + (n.x / nl) * (R - 9);
    const ny = R + (n.y / nl) * (R - 9);
    g.beginPath();
    g.arc(nx, ny, size < 130 ? 6 : 7, 0, Math.PI * 2);
    g.fillStyle = "rgba(11,13,15,0.85)";
    g.fill();
    g.font = `700 ${size < 130 ? 9 : 10}px "Big Shoulders Display", Impact, sans-serif`;
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillStyle = INK.bone;
    g.fillText("N", nx, ny + 0.5);

    // The player: an arrow at the centre, always pointing up.
    g.save();
    g.translate(R, R);
    const a = size < 130 ? 5.5 : 7;
    g.beginPath();
    g.moveTo(0, -a * 1.25);
    g.lineTo(a, a);
    g.lineTo(0, a * 0.45);
    g.lineTo(-a, a);
    g.closePath();
    g.fillStyle = INK.bone;
    g.strokeStyle = INK.ink;
    g.lineWidth = 1.5;
    g.fill();
    g.stroke();
    g.restore();

    // The rim.
    g.beginPath();
    g.arc(R, R, R - 1, 0, Math.PI * 2);
    g.strokeStyle = "rgba(232,228,218,0.32)";
    g.lineWidth = 1.5;
    g.stroke();
  }

  function mark(g: CanvasRenderingContext2D, m: Mark, x: number, y: number, edge: boolean) {
    const small = size < 130;
    g.lineWidth = 1.5;
    g.strokeStyle = INK.ink;
    switch (m.kind) {
      case "seal":
      case "bonded": {
        const s = small ? 3 : 3.5;
        g.fillStyle = m.kind === "bonded" ? INK.bonded : INK.cargo;
        g.fillRect(x - s, y - s, s * 2, s * 2);
        g.strokeRect(x - s, y - s, s * 2, s * 2);
        break;
      }
      case "wreck":
        diamond(g, x, y, small ? 3.5 : 4.5, INK.rust, INK.ink);
        break;
      case "boat-shut":
        g.beginPath();
        g.arc(x, y, small ? 4 : 5, 0, Math.PI * 2);
        g.strokeStyle = INK.dim;
        g.lineWidth = 1.2;
        g.stroke();
        break;
      case "boat":
        diamond(g, x, y, edge ? 5 : 6.5, INK.bone, INK.ink);
        break;
      case "relay": {
        const r = edge ? (small ? 5 : 6) : small ? 6.5 : 8;
        diamond(g, x, y, r, INK.signal, INK.ink);
        if (m.label && !edge) {
          g.fillStyle = INK.ink;
          g.font = `700 ${small ? 8 : 10}px "Big Shoulders Display", Impact, sans-serif`;
          g.textAlign = "center";
          g.textBaseline = "middle";
          g.fillText(m.label, x, y + 0.5);
        }
        break;
      }
      case "threat":
        g.beginPath();
        g.arc(x, y, edge ? 3 : small ? 3.5 : 4.5, 0, Math.PI * 2);
        g.fillStyle = INK.alarm;
        g.fill();
        g.stroke();
        break;
      case "threat-air":
        diamond(g, x, y, edge ? 3.5 : small ? 4 : 5, "rgba(11,13,15,0.6)", INK.alarm, 2);
        break;
    }
  }

  function diamond(g: CanvasRenderingContext2D, x: number, y: number, r: number, fill: string, stroke: string, lw = 1.5) {
    g.beginPath();
    g.moveTo(x, y - r);
    g.lineTo(x + r, y);
    g.lineTo(x, y + r);
    g.lineTo(x - r, y);
    g.closePath();
    g.fillStyle = fill;
    g.fill();
    g.strokeStyle = stroke;
    g.lineWidth = lw;
    g.stroke();
  }

  // ---- the loop ----------------------------------------------------------------------------------------------------
  let raf = 0;
  let disposed = false;
  let warned = false;
  const loop = () => {
    if (disposed) return;
    const now = performance.now();
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    try {
      const playing = G.game?.state === "playing";
      if (playing !== state.shown) {
        state.shown = playing;
        box.classList.toggle("on", playing);
      }
      if (playing) {
        const t0 = performance.now();
        build();
        fit();
        placeT -= dt;
        if (placeT <= 0) {
          placeT = 0.5;
          place();
        }
        draw(dt);
        state.costMs = state.costMs * 0.95 + (performance.now() - t0) * 0.05;
      }
    } catch (err) {
      if (!warned) (warned = true), console.warn("[minimap] frame:", err);
    }
    raf = requestAnimationFrame(loop);
  };
  loop();

  const api: Minimap = {
    state,
    dispose() {
      disposed = true;
      cancelAnimationFrame(raf);
      for (const off of offs) off();
      box.remove();
    },
  };
  G.minimap = api;
  return api;
}
