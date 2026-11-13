// The Assessor's HUD bar: its name, its health (the cores' together, with a pip per core) and the lamp's assessment
// of the player. It lives inside the game's HUD root (game.js `.hud`), so it hides with the HUD on pause and death.
import { ASSESSOR_BAR } from "./copy";
import type { Bar } from "./types";

export function createBar(host: HTMLElement | null, doc: Document = document): Bar {
  const root = doc.createElement("div");
  root.className = "as-bar";
  root.setAttribute("aria-hidden", "true");
  root.innerHTML =
    '<div class="as-row"><b class="as-name"></b><span class="as-cores"></span></div>' +
    '<div class="as-track"><i class="as-lag"></i><i class="as-fill"></i></div>' +
    '<div class="as-assess"><span class="as-k">Assessment</span><span class="as-meter"><i></i></span><b class="as-pct">0%</b></div>';
  (root.querySelector(".as-name") as HTMLElement).textContent = ASSESSOR_BAR;
  const pips = root.querySelector(".as-cores") as HTMLElement;
  const fill = root.querySelector(".as-fill") as HTMLElement;
  const lag = root.querySelector(".as-lag") as HTMLElement;
  const assess = root.querySelector(".as-assess") as HTMLElement;
  const meter = root.querySelector(".as-meter i") as HTMLElement;
  const pct = root.querySelector(".as-pct") as HTMLElement;
  host?.appendChild(root);

  let last = { health: -1, live: "", assess: -1, lock: false };
  let lagV = 1;
  let lagAt = 0;
  return {
    show(cores) {
      pips.innerHTML = "<i></i>".repeat(cores);
      last = { health: -1, live: "", assess: -1, lock: false };
      lagV = 1;
      root.classList.add("on");
    },
    set(s) {
      const h = Math.max(0, Math.min(1, s.health));
      if (Math.abs(h - last.health) > 0.0005) {
        fill.style.transform = `scaleX(${h.toFixed(4)})`;
        if (h < last.health) lagAt = performance.now();
        last.health = h;
      }
      // The chunk just lost lingers a beat, then drains.
      if (lagV > h && performance.now() - lagAt > 450) {
        lagV = Math.max(h, lagV - 0.012);
        lag.style.transform = `scaleX(${lagV.toFixed(4)})`;
      } else if (lagV < h) lagV = h;
      const live = s.live.map((x) => (x ? 1 : 0)).join("");
      if (live !== last.live) {
        last.live = live;
        [...pips.children].forEach((el, i) => el.classList.toggle("out", !s.live[i]));
      }
      const a = Math.round(Math.max(0, Math.min(1, s.assess)) * 100);
      if (a !== last.assess || s.lock !== last.lock) {
        last.assess = a;
        last.lock = s.lock;
        meter.style.transform = `scaleX(${(a / 100).toFixed(3)})`;
        pct.textContent = s.lock ? "Complete" : `${a}%`;
        assess.classList.toggle("on", a > 0 || s.lock);
        assess.classList.toggle("lock", s.lock);
        assess.classList.toggle("hot", a >= 60);
      }
    },
    hide() {
      root.classList.remove("on");
    },
    dispose() {
      root.remove();
    },
  };
}
