// The ways in. On the title, a small dock board in the open top-right corner of the scene: today's prices and your
// scrip, and a click opens the Dockside (it sits apart from the title's action row so that row keeps its shape). On
// the dead and debrief cards, a DOCKSIDE button under the card's own.
import { BROKERS, ITEMS, RULES } from "../items";
import type { BrokerId, BrokerView } from "../types";
import { okv, type Reads } from "./ctx";
import { h, text, toggle } from "./dom";
import { fmt } from "./format";

export type Origin = "title" | "dead" | "complete";

export interface Entries {
  readonly buttons: Map<Origin, HTMLButtonElement>;
  inject(): void;
  update(registered: boolean | null): void;
}

export function createEntries(getMenus: () => HTMLElement | null | undefined, reads: Reads, open: (o: Origin) => void): Entries {
  const buttons = new Map<Origin, HTMLButtonElement>();
  const ids = Object.keys(BROKERS) as BrokerId[];
  const last: Partial<Record<BrokerId, number>> = {};
  const dir: Partial<Record<BrokerId, number>> = {};

  const scripT = h("span", { class: "dk-dock-s" });
  const rows = ids.map((id) => {
    const what = h("span", { class: "dk-dock-c" });
    const price = h("b");
    const tr = h("i", { "data-dir": "0" }, "");
    const el = h("span", { class: "dk-dock-r", "data-b": id }, h("span", { class: "dk-dock-n" }, BROKERS[id].name === "Quartermaster" ? "QM" : BROKERS[id].name), what, price, tr);
    return { id, el, what, price, tr };
  });
  const go = h("span", { class: "dk-dock-go" });
  const board = h(
    "button",
    { class: "dk-dock", type: "button", "data-dk": "title", "aria-label": "Open the Dockside market", onclick: () => open("title") },
    h("span", { class: "dk-dock-h" }, h("b", null, "Dockside"), scripT),
    h("span", { class: "dk-dock-rows" }, ...rows.map((r) => r.el)),
    go,
  );

  function inject() {
    const menus = getMenus();
    if (!menus) return;
    if (!board.isConnected) {
      const title = menus.querySelector<HTMLElement>('[data-s="title"]');
      if (title) {
        title.append(board);
        buttons.set("title", board);
      }
    }
    for (const o of ["dead", "complete"] as const) {
      if (buttons.get(o)?.isConnected) continue;
      const host = menus.querySelector<HTMLElement>(`[data-s="${o}"] .m-actions`);
      if (!host) continue;
      const b = h("button", { class: "btn dk-entry", type: "button", "data-dk": o, onclick: () => open(o) }, h("span", null, "Dockside"), h("b", { class: "dk-entry-n" }));
      host.append(b);
      buttons.set(o, b);
    }
  }

  function update(registered: boolean | null) {
    const bal = okv(reads.balances);
    const scrip = registered && bal ? fmt(bal.scrip ?? 0) : "";
    text(scripT, scrip ? `${scrip} scrip` : "");
    for (const o of ["dead", "complete"] as const) {
      const n = buttons.get(o)?.querySelector(".dk-entry-n");
      if (n) text(n, scrip);
    }
    const brokers: BrokerView[] | null = okv(reads.brokers);
    toggle(board, "unk", !brokers);
    for (const r of rows) {
      const v = brokers?.find((b) => b.id === r.id);
      const q = v?.bids[0];
      if (!v || !q) {
        text(r.what, brokers ? "" : "");
        text(r.price, "–");
        r.tr.dataset.dir = "0";
        text(r.tr, "");
        continue;
      }
      toggle(r.el, "shut", !v.open);
      text(r.what, v.open ? ITEMS[q.tokenId].name.split(" ")[0] : "Shuttered");
      text(r.price, v.open ? String(q.price) : "");
      const prev = last[r.id];
      if (prev != null && prev !== q.price) dir[r.id] = q.price > prev ? 1 : -1;
      last[r.id] = q.price;
      const d = v.open ? (dir[r.id] ?? 0) : 0;
      r.tr.dataset.dir = String(d);
      text(r.tr, d > 0 ? "▲" : d < 0 ? "▼" : "");
    }
    text(go, registered === false ? `Claim a dock pass · ${RULES.starterScrip} scrip` : "Sell your haul · gear up");
  }

  return { buttons, inject, update };
}
