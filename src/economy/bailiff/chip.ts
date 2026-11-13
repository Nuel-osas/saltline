// The Bailiff's HUD chip: `BAILIFF 14 m` and an arrow to it, shown while one is within 30 m. It lives inside the
// game's HUD root (game.js `.hud`), under the compass, so it hides with the HUD on pause and death.
import { CHIP_LABEL } from "./copy";

export interface ChipState {
  /** Metres to the nearest one. */
  dist: number;
  /** Radians clockwise from the way the player faces to where it is (0 ahead, π/2 to the right). */
  bearing: number;
  /** Its lens has the player. */
  sees: boolean;
  /** Seconds left on its knee, or 0 while it stands. */
  down: number;
}

export interface Chip {
  set(s: ChipState | null): void;
  dispose(): void;
}

/** The bearing from a player at `from` facing `yaw` (the game's forward is (−sin yaw, 0, −cos yaw)) to `to`. */
export function bearing(from: { x: number; z: number }, yaw: number, to: { x: number; z: number }): number {
  const dx = to.x - from.x,
    dz = to.z - from.z;
  const ahead = -Math.sin(yaw) * dx - Math.cos(yaw) * dz;
  const right = Math.cos(yaw) * dx - Math.sin(yaw) * dz;
  return Math.atan2(right, ahead);
}

export function createChip(host: HTMLElement | null, doc: Document = document): Chip {
  const root = doc.createElement("div");
  root.className = "bf-chip";
  root.setAttribute("aria-hidden", "true");
  root.innerHTML = '<i class="bf-arrow"></i><b class="bf-name"></b><span class="bf-dist"></span><em class="bf-tag"></em>';
  (root.querySelector(".bf-name") as HTMLElement).textContent = CHIP_LABEL;
  const arrow = root.querySelector(".bf-arrow") as HTMLElement;
  const dist = root.querySelector(".bf-dist") as HTMLElement;
  const tag = root.querySelector(".bf-tag") as HTMLElement;
  host?.appendChild(root);
  let last = { on: false, text: "", deg: 1e9, sees: false, tag: "" };
  return {
    set(s) {
      if (!s) {
        if (last.on) (root.classList.remove("on"), (last.on = false));
        return;
      }
      if (!last.on) (root.classList.add("on"), (last.on = true));
      const text = `${Math.max(0, Math.round(s.dist))} m`;
      if (text !== last.text) dist.textContent = last.text = text;
      const deg = Math.round((s.bearing * 180) / Math.PI / 3) * 3;
      if (deg !== last.deg) ((last.deg = deg), (arrow.style.transform = `rotate(${deg}deg)`));
      const t = s.down > 0 ? `Down ${Math.ceil(s.down)}s` : "";
      if (t !== last.tag) ((tag.textContent = last.tag = t), root.classList.toggle("down", !!t));
      const sees = s.sees && !t;
      if (sees !== last.sees) ((last.sees = sees), root.classList.toggle("sees", sees));
    },
    dispose() {
      root.remove();
    },
  };
}
