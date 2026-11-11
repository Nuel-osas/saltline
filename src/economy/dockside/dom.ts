// A tiny DOM builder for the Dockside. No framework: panels build their nodes once and patch values in place, so
// the split-flap prices and focus survive every refresh.

type Child = Node | string | number | null | undefined | false;
type Attr = string | number | boolean | null | undefined | ((e: Event) => void);

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: Record<string, Attr> | null,
  ...kids: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (attrs)
    for (const k in attrs) {
      const v = attrs[k];
      if (v == null || v === false) continue;
      if (typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
      else if (k === "class") el.className = String(v);
      else el.setAttribute(k, v === true ? "" : String(v));
    }
  append(el, kids);
  return el;
}

export function append(el: Element, kids: Child[]) {
  for (const k of kids) if (k != null && k !== false) el.append(k instanceof Node ? k : String(k));
}

/** Replace an element's children. */
export function fill(el: Element, ...kids: Child[]) {
  el.replaceChildren();
  append(el, kids);
}

/** Set text only when it changed (keeps layout and screen readers quiet). */
export function text(el: Element, s: string) {
  if (el.textContent !== s) el.textContent = s;
}

export function toggle(el: Element, cls: string, on: boolean) {
  el.classList.toggle(cls, on);
}

/** Pop a signed change ("−5", "+190") on a delta badge; it floats and fades (CSS), coloured by direction. */
export function popDelta(el: HTMLElement, change: number) {
  if (!change) return;
  el.textContent = `${change > 0 ? "+" : "−"}${Math.abs(change).toLocaleString("en-US")}`;
  el.dataset.dir = change > 0 ? "1" : "-1";
  el.classList.remove("go");
  void el.offsetWidth;
  el.classList.add("go");
}

export const reducedMotion = () =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
