// Gamepad and arrow-key focus for the Dockside: the d-pad or left stick moves focus to the nearest control in that
// direction, A presses, B backs out, LB/RB change tabs. Polled only while the Dockside is open.

const FOCUSABLE = "button:not([disabled]), a[href], input:not([disabled]), summary, [tabindex='0']";

export type Dir = "up" | "down" | "left" | "right";

export function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => {
    if (el.closest("[hidden], [aria-hidden='true'], .dk-tipsrc")) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  });
}

/** Move focus to the nearest focusable in a direction (weighted against drifting sideways). */
export function moveFocus(root: HTMLElement, dir: Dir): boolean {
  const all = focusables(root);
  if (!all.length) return false;
  const cur = document.activeElement as HTMLElement | null;
  if (!cur || !root.contains(cur)) {
    all[0].focus();
    return true;
  }
  const a = cur.getBoundingClientRect();
  const ax = a.left + a.width / 2;
  const ay = a.top + a.height / 2;
  let best: HTMLElement | null = null;
  let score = Infinity;
  for (const el of all) {
    if (el === cur) continue;
    const r = el.getBoundingClientRect();
    const dx = r.left + r.width / 2 - ax;
    const dy = r.top + r.height / 2 - ay;
    const along = dir === "left" ? -dx : dir === "right" ? dx : dir === "up" ? -dy : dy;
    const across = dir === "left" || dir === "right" ? Math.abs(dy) : Math.abs(dx);
    if (along <= 2) continue;
    const s = along + across * 2.4;
    if (s < score) (score = s), (best = el);
  }
  if (!best) return false;
  best.focus();
  best.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  return true;
}

export interface PadHandlers {
  move(dir: Dir): void;
  press(): void;
  back(): void;
  tab(delta: number): void;
}

export function createPad(handlers: PadHandlers) {
  let raf = 0;
  const held = new Map<string, number>();
  const REPEAT = 220;

  function edge(name: string, on: boolean, now: number, repeat = false) {
    if (!on) {
      held.delete(name);
      return false;
    }
    const t = held.get(name);
    if (t == null) {
      held.set(name, now + (repeat ? 380 : 1e9));
      return true;
    }
    if (repeat && now >= t) {
      held.set(name, now + REPEAT);
      return true;
    }
    return false;
  }

  function poll(now: number) {
    raf = requestAnimationFrame(poll);
    let pads: (Gamepad | null)[] = [];
    try {
      pads = navigator.getGamepads ? [...navigator.getGamepads()] : [];
    } catch {
      return;
    }
    const p = pads.find((x) => x && x.connected && x.mapping === "standard");
    if (!p) return;
    const btn = (i: number) => !!p.buttons[i] && (p.buttons[i].pressed || p.buttons[i].value > 0.5);
    const ax = p.axes[0] ?? 0;
    const ay = p.axes[1] ?? 0;
    if (edge("up", btn(12) || ay < -0.6, now, true)) handlers.move("up");
    if (edge("down", btn(13) || ay > 0.6, now, true)) handlers.move("down");
    if (edge("left", btn(14) || ax < -0.6, now, true)) handlers.move("left");
    if (edge("right", btn(15) || ax > 0.6, now, true)) handlers.move("right");
    if (edge("a", btn(0), now)) handlers.press();
    if (edge("b", btn(1), now)) handlers.back();
    if (edge("lb", btn(4), now)) handlers.tab(-1);
    if (edge("rb", btn(5), now)) handlers.tab(1);
  }

  return {
    start() {
      if (!raf && typeof requestAnimationFrame === "function" && typeof navigator !== "undefined" && "getGamepads" in navigator) raf = requestAnimationFrame(poll);
    },
    stop() {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      held.clear();
    },
  };
}
