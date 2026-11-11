// One floating tooltip for the whole Dockside. Anything with data-tip="<id>" shows the hidden element with that id
// (the same element its aria-describedby names), so the reason a broker gives is in the DOM for screen readers and
// tests, and the floating plate is just a copy placed beside the price. Hover or focus shows it; a tap pins it.
import { h } from "./dom";

export interface Tooltip {
  readonly el: HTMLElement;
  hide(): void;
  /** True if a tooltip was open (Esc closes it before it closes the Dockside). */
  dismiss(): boolean;
}

export function createTooltip(root: HTMLElement): Tooltip {
  const el = h("div", { class: "dk-tip", role: "tooltip", "aria-hidden": "true" });
  root.append(el);
  let anchor: HTMLElement | null = null;
  let pinned = false;

  function place() {
    if (!anchor) return;
    const a = anchor.getBoundingClientRect();
    const r = root.getBoundingClientRect();
    const w = el.offsetWidth;
    const hgt = el.offsetHeight;
    const pad = 10;
    let x = a.left + a.width / 2 - w / 2 - r.left;
    x = Math.max(pad, Math.min(r.width - w - pad, x));
    let y = a.top - r.top - hgt - 10;
    let below = false;
    if (y < pad + 50) {
      y = a.bottom - r.top + 10;
      below = true;
    }
    el.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`;
    el.classList.toggle("below", below);
    const nub = Math.max(14, Math.min(w - 14, a.left + a.width / 2 - r.left - x));
    el.style.setProperty("--nub", `${Math.round(nub)}px`);
  }

  function show(target: HTMLElement, pin = false) {
    const id = target.dataset.tip;
    const src = id ? root.querySelector<HTMLElement>(`[id="${id}"]`) : null;
    if (!src) return;
    anchor = target;
    pinned = pin;
    el.replaceChildren(...[...src.childNodes].map((n) => n.cloneNode(true)));
    el.classList.add("on");
    el.setAttribute("aria-hidden", "false");
    place();
  }
  function hide() {
    anchor = null;
    pinned = false;
    el.classList.remove("on");
    el.setAttribute("aria-hidden", "true");
  }

  const tipOf = (e: Event) => (e.target instanceof Element ? (e.target.closest("[data-tip]") as HTMLElement | null) : null);
  root.addEventListener("pointerover", (e) => {
    const t = tipOf(e);
    if (t && (e as PointerEvent).pointerType !== "touch" && t !== anchor) show(t);
  });
  root.addEventListener("pointerout", (e) => {
    const t = tipOf(e);
    const to = (e as PointerEvent).relatedTarget as Node | null;
    if (t && t === anchor && !pinned && !(to && t.contains(to))) hide();
  });
  root.addEventListener("focusin", (e) => {
    const t = tipOf(e);
    if (t) show(t);
    else if (!pinned) hide();
  });
  root.addEventListener("focusout", (e) => {
    if (tipOf(e) === anchor && !pinned) hide();
  });
  root.addEventListener("click", (e) => {
    const t = tipOf(e);
    if (t && t.classList.contains("dk-price")) {
      if (anchor === t && pinned) hide();
      else show(t, true);
    } else if (pinned && !el.contains(e.target as Node)) hide();
  });
  root.addEventListener("scroll", () => anchor && place(), true);

  return {
    el,
    hide,
    dismiss() {
      const was = el.classList.contains("on");
      hide();
      return was;
    },
  };
}
