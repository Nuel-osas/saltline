// The ledger ticker: chain.recent(20) crawling along the bottom bar like a port's departure crawl. New lines jump
// the queue so they show within seconds; your own lines are lit; each links to its transaction when the chain has
// an explorer. It pauses under the pointer or focus. With reduced motion (or no layout, as in tests) it is a
// still, scrollable row.
import type { LedgerEvent } from "../types";
import { okv, type Ctx } from "./ctx";
import { h, reducedMotion, text } from "./dom";
import { accountUrl, ago, UNKNOWN } from "./format";

const SPEED = 46; // px per second

const keyOf = (e: LedgerEvent) => `${e.at}|${e.account}|${e.kind}|${e.text}`;

export function createTicker(ctx: Ctx) {
  const track = h("div", { class: "dk-tk-track" });
  const view = h("div", { class: "dk-tk-view" }, track);
  const credit = h("span", { class: "dk-tk-credit" });
  const el = h(
    "div",
    { class: "dk-tk", role: "log", "aria-label": "Dock ledger", "aria-live": "off" },
    h("span", { class: "dk-tk-k" }, h("i", { "aria-hidden": "true" }), "Ledger"),
    view,
    credit,
  );

  let events: LedgerEvent[] = [];
  const seen = new Set<string>();
  const fresh: LedgerEvent[] = [];
  let cursor = 0;
  let offset = 0;
  let paused = false;
  let running = false;
  let raf = 0;
  let last = 0;
  let still = false;
  let first = true;

  for (const ev of ["pointerenter", "focusin"]) el.addEventListener(ev, () => (paused = true));
  el.addEventListener("pointerleave", () => (paused = el.contains(document.activeElement)));
  el.addEventListener("focusout", () => (paused = false));

  function item(e: LedgerEvent, isNew: boolean) {
    const mine = !!ctx.me() && e.account === ctx.me();
    const url = e.txHash ? ctx.chain.txUrl(e.txHash) : null;
    const kids = [
      h("i", { class: "dk-tk-dot", "data-kind": e.kind, "aria-hidden": "true" }),
      mine ? h("em", null, "You") : null,
      h("span", { class: "dk-tk-t" }, e.text),
      h("time", { "data-at": e.at }, ` · ${ago(e.at)}`),
    ];
    const cls = `dk-tk-i${mine ? " mine" : ""}${isNew ? " new" : ""}`;
    return url ? h("a", { class: cls, href: url, target: "_blank", rel: "noopener" }, ...kids) : h("span", { class: cls }, ...kids);
  }

  function renderStill() {
    track.style.transform = "";
    track.replaceChildren(...events.map((e) => item(e, false)));
  }

  function next(): HTMLElement | null {
    const f = fresh.shift();
    if (f) return item(f, true);
    if (!events.length) return null;
    const e = events[cursor % events.length];
    cursor = (cursor + 1) % events.length;
    return item(e, false);
  }

  function frame(t: number) {
    if (!running) return;
    raf = requestAnimationFrame(frame);
    const dt = Math.min(0.05, last ? (t - last) / 1000 : 0);
    last = t;
    const vw = view.clientWidth;
    if (!vw) return;
    if (!paused) offset -= SPEED * dt;
    // Drop what has left on the left; keep the right filled.
    let guard = 0;
    while (track.firstElementChild && guard++ < 40) {
      const w = (track.firstElementChild as HTMLElement).offsetWidth;
      if (!w || offset + w > 0) break;
      offset += w;
      track.firstElementChild.remove();
    }
    guard = 0;
    while (track.scrollWidth + offset < vw + 200 && guard++ < 40) {
      const n = next();
      if (!n) break;
      track.append(n);
    }
    track.style.transform = `translate3d(${offset.toFixed(1)}px,0,0)`;
  }

  function update() {
    const read = ctx.reads.recent;
    const net = ctx.chain.network;
    const url = accountUrl(net, ctx.chain.contractId);
    credit.replaceChildren(
      url ? h("a", { href: url, target: "_blank", rel: "noopener" }, "on NEAR testnet") : h("span", null, net === "testnet" ? "on NEAR testnet" : "on the mock ledger"),
    );
    if (read.s === "unknown") {
      el.classList.add("unk");
      if (!track.querySelector(".dk-tk-unk")) track.replaceChildren(h("span", { class: "dk-tk-i dk-tk-unk" }, `Ledger ${UNKNOWN}: can't read the chain right now. Retrying.`));
      track.style.transform = "";
      offset = 0;
      return;
    }
    if (el.classList.contains("unk")) {
      el.classList.remove("unk");
      track.replaceChildren();
    }
    const list = okv(read);
    if (!list) return;
    for (const t of track.querySelectorAll<HTMLElement>("time[data-at]")) text(t, ` · ${ago(+t.dataset.at!)}`);
    const incoming = list.filter((e) => !seen.has(keyOf(e)));
    for (const e of list) seen.add(keyOf(e));
    events = list;
    // No layout yet (or none at all, as in tests): show the lines still; the crawl picks up from there.
    if (still || !view.clientWidth) return renderStill();
    if (first) {
      first = false;
      cursor = 0;
      return;
    }
    // Newest first, ahead of the loop.
    fresh.push(...incoming);
  }

  return {
    el,
    update,
    start() {
      still = reducedMotion() || typeof requestAnimationFrame !== "function";
      el.classList.toggle("still", still);
      if (still) return renderStill();
      if (running) return;
      running = true;
      last = 0;
      raf = requestAnimationFrame(frame);
    },
    stop() {
      running = false;
      cancelAnimationFrame(raf);
    },
  };
}
