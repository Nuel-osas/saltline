// A broker's stall: a kiosk with a painted sign, a split-flap price board, float and stock gauges, and a roller
// shutter that comes down when the broker goes broke. Bids carry the broker's own reason in a tooltip.
import { BROKERS, ITEMS } from "../items";
import type { BrokerId, BrokerView, CargoId, GearId, TokenId } from "../types";
import { createSlot, okv, type Ctx } from "./ctx";
import { h, popDelta, text, toggle } from "./dom";
import { createFlap, type Flap } from "./flap";
import { accountUrl, FLOAT_CLOSE, FLOAT_REOPEN, fmt, fmtOr, itemName, pct, UNKNOWN } from "./format";

const FLOAT_SCALE = 2000;

interface Row {
  tok: TokenId;
  kind: "bid" | "ask";
  el: HTMLElement;
  flap: Flap;
  unknown: HTMLElement;
  trend: HTMLElement;
  delta: HTMLElement;
  sub: HTMLElement;
  tip: HTMLElement;
  btns: HTMLButtonElement[];
  last: number | null;
  was: number | null;
  dir: -1 | 0 | 1;
}

export interface Stall {
  readonly el: HTMLElement;
  update(): void;
}

export function createStall(ctx: Ctx, id: BrokerId, index: number): Stall {
  const meta = BROKERS[id];
  const slot = createSlot();
  let invOpen = false;

  // ---- sign ----
  const lamp = h("span", { class: "dk-lamp", "data-state": "loading" }, h("i"), h("span", null, "…"));
  const acct = h("span", { class: "dk-acct" });
  const sign = h(
    "header",
    { class: "dk-sign" },
    h("i", { class: "dk-awning", "aria-hidden": "true" }),
    h("div", { class: "dk-sign-row" }, h("span", { class: "dk-stallno" }, `Stall 0${index + 1}`), lamp),
    h("h3", { class: "dk-bname" }, meta.name),
    h("p", { class: "dk-blurb" }, meta.blurb),
  );

  // ---- price board ----
  const rows: Row[] = [];
  const mkRow = (tok: TokenId, kind: "bid" | "ask"): Row => {
    const tipId = `dk-tip-${id}-${tok}`;
    const flap = createFlap({ cells: 3, className: "dk-pflap", onStep: ctx.flapTick });
    const unknown = h("span", { class: "dk-unknown" }, UNKNOWN);
    const trend = h("i", { class: "dk-tr", "data-dir": "0", "aria-hidden": "true" });
    const delta = h("b", { class: "dk-delta", "aria-hidden": "true" });
    const price = h("button", { class: "dk-price", type: "button", "data-tip": tipId, "aria-describedby": tipId }, flap.el, unknown, trend, delta);
    const sub = h("span", { class: "dk-q-sub" });
    const tip = h("div", { id: tipId, class: "dk-tipsrc", hidden: true });
    const btns: HTMLButtonElement[] =
      kind === "bid"
        ? [
            h("button", { class: "dk-b", type: "button", "data-a": "sell1", onclick: () => sell(tok as CargoId, 1) }, "Sell 1"),
            h("button", { class: "dk-b", type: "button", "data-a": "sellall", onclick: () => sell(tok as CargoId, held(tok) ?? 0) }, "All"),
          ]
        : [h("button", { class: "dk-b", type: "button", "data-a": "buy1", onclick: () => buy(tok as GearId) }, "Buy 1")];
    const el = h(
      "div",
      { class: `dk-q dk-q-${kind}`, "data-tok": tok },
      h("span", { class: "dk-q-n" }, itemName(tok)),
      price,
      sub,
      h("span", { class: "dk-q-acts" }, ...btns),
      tip,
    );
    return { tok, kind, el, flap, unknown, trend, delta, sub, tip, btns, last: null, was: null, dir: 0 };
  };
  for (const c of meta.buys) rows.push(mkRow(c, "bid"));
  for (const g of meta.sells) rows.push(mkRow(g, "ask"));

  const shutterFloat = h("b");
  const shutterBar = h("i");
  const invest = createInvest();
  const shutter = h(
    "div",
    { class: "dk-shutter", "aria-hidden": "true" },
    h("div", { class: "dk-slats", "aria-hidden": "true" }),
    h(
      "div",
      { class: "dk-shutter-in" },
      h("strong", { class: "dk-stencil" }, "Shuttered"),
      h("p", { class: "dk-shutter-t" }, "Float ", shutterFloat, ` of ${FLOAT_REOPEN} to reopen`),
      h("span", { class: "dk-meter" }, shutterBar),
      invest.el,
      h("p", { class: "dk-shutter-n" }, "Investors take a share of every freighter dividend."),
    ),
  );
  const board = h(
    "div",
    { class: "dk-board" },
    h("div", { class: "dk-board-k" }, h("span", null, "Paying"), h("span", null, "per unit")),
    ...rows.filter((r) => r.kind === "bid").map((r) => r.el),
    h("div", { class: "dk-board-k" }, h("span", null, "Selling")),
    ...rows.filter((r) => r.kind === "ask").map((r) => r.el),
    shutter,
  );

  // ---- gauges ----
  const floatN = h("b", { class: "dk-g-n" });
  const floatFill = h("i", { class: "dk-g-fill" });
  const stockEls = meta.buys.map((c) => {
    const n = h("b", { class: "dk-g-n" });
    const fill = h("i", { class: "dk-g-fill" });
    const el = h(
      "div",
      { class: "dk-g" },
      h("span", { class: "dk-g-k" }, c),
      h("span", { class: "dk-g-bar" }, fill, h("i", { class: "dk-g-mark", style: "left:50%", title: "target" })),
      n,
    );
    return { c, el, n, fill };
  });
  const gauges = h(
    "div",
    { class: "dk-gauges" },
    h(
      "div",
      { class: "dk-g dk-g-float" },
      h("span", { class: "dk-g-k" }, "Float"),
      h(
        "span",
        { class: "dk-g-bar" },
        floatFill,
        h("i", { class: "dk-g-mark warn", style: `left:${(FLOAT_CLOSE / FLOAT_SCALE) * 100}%`, title: "shuts below" }),
        h("i", { class: "dk-g-mark", style: `left:${(FLOAT_REOPEN / FLOAT_SCALE) * 100}%`, title: "reopens at" }),
      ),
      floatN,
    ),
    h("div", { class: "dk-g-head" }, h("span", null, "Stock"), h("span", null, "target ▏")),
    ...stockEls.map((s) => s.el),
  );

  // ---- footer: shares, invest drawer, receipt ----
  const shareT = h("span", { class: "dk-share" });
  const invBtn = h("button", { class: "dk-b ghost", type: "button", "aria-expanded": "false", onclick: () => setInv(!invOpen) }, "Invest");
  const drawer = h("div", { class: "dk-drawer", hidden: true });
  const foot = h("footer", { class: "dk-stall-f" }, h("div", { class: "dk-share-row" }, shareT, invBtn), drawer, slot.el, acct);
  const el = h("article", { class: "dk-stall", "data-broker": id, "data-open": "loading", "aria-label": `${meta.name}'s stall` }, sign, board, gauges, foot);

  function setInv(on: boolean) {
    invOpen = on;
    invBtn.setAttribute("aria-expanded", String(on));
    drawer.hidden = !on;
    if (on) drawer.append(invest.el);
    else shutter.querySelector(".dk-shutter-in")!.insertBefore(invest.el, shutter.querySelector(".dk-shutter-n"));
  }

  // ---- data ----
  const view = (): BrokerView | null => okv(ctx.reads.brokers)?.find((b) => b.id === id) ?? null;
  const bal = () => okv(ctx.reads.balances);
  const held = (tok: TokenId) => {
    const b = bal();
    return b ? (b[tok] ?? 0) : null;
  };
  const busy = () => slot.state === "pending";
  slot.onChange = () => update();

  function sell(c: CargoId, n: number) {
    if (n <= 0) return;
    void ctx.act(slot, {
      pending: `Settling… ${n} ${c} to ${meta.name}`,
      call: () => ctx.chain.sell(id, c, n),
      done: (r) => `Sold ${n} ${c} · +${r.paid != null ? fmt(r.paid) : UNKNOWN} scrip`,
      // a sale is a delivery: it moves the town
      refresh: ["brokers", "balances", "recent", "town"],
      chime: "cash",
    });
  }
  function buy(g: GearId) {
    void ctx.act(slot, {
      pending: `Settling… buying ${g}`,
      call: () => ctx.chain.buy(id, g, 1),
      done: (r) => `Bought 1 ${g} · −${r.cost != null ? fmt(r.cost) : UNKNOWN} scrip`,
      refresh: ["brokers", "balances", "recent"],
      chime: "soft",
    });
  }

  function createInvest() {
    let amount = 100;
    const chips = h("div", { class: "dk-chips", role: "group", "aria-label": "Amount" });
    const go = h("button", { class: "dk-b solid", type: "button", onclick: () => doInvest() }, "Invest");
    const box = h("div", { class: "dk-invest" }, chips, go);
    const render = (need: number | null, mine: number | null) => {
      const opts = [50, 100, 250];
      if (need != null && need > 0 && !opts.includes(need)) opts.push(need);
      const keys = opts.join(",");
      if (chips.dataset.k !== keys) {
        chips.dataset.k = keys;
        chips.replaceChildren(
          ...opts.map((v) =>
            h("button", { class: "dk-chip", type: "button", "data-v": v, "data-need": v === need ? "1" : null, onclick: () => ((amount = v), update()) }, v === need ? `Reopen ${v}` : String(v)),
          ),
        );
        if (need != null && need > 0) amount = need;
      }
      for (const b of chips.querySelectorAll<HTMLButtonElement>("button")) {
        b.setAttribute("aria-pressed", String(+b.dataset.v! === amount));
        b.disabled = busy() || mine == null || mine < +b.dataset.v!;
      }
      text(go, `Invest ${amount}`);
      go.disabled = busy() || mine == null || mine < amount;
    };
    const doInvest = () => {
      const v = view();
      const reopening = v && !v.open && v.scrip + amount >= FLOAT_REOPEN;
      const n = amount;
      void ctx.act(slot, {
        pending: `Settling… ${n} scrip into ${meta.name}`,
        call: () => ctx.chain.invest(id, n),
        done: () => `Invested ${n}${reopening ? ` · ${meta.name} reopens` : ""}`,
        refresh: ["brokers", "balances", "recent", "leaderboard"],
        chime: "soft",
      }).then((r) => {
        if (r?.ok && invOpen) setInv(false);
      });
    };
    return { el: box, render };
  }

  // ---- paint ----
  function update() {
    const read = ctx.reads.brokers;
    const v = view();
    const state = read.s === "loading" ? "loading" : !v ? "unknown" : v.open ? "open" : "shut";
    el.dataset.open = state;
    toggle(el, "pending", busy());
    lamp.dataset.state = state;
    text(lamp.lastChild as HTMLElement, state === "open" ? "Open" : state === "shut" ? "Shuttered" : state === "loading" ? "…" : "Unknown");
    if (v && acct.dataset.id !== v.accountId) {
      acct.dataset.id = v.accountId;
      const url = accountUrl(ctx.chain.network, v.accountId);
      acct.replaceChildren(url ? h("a", { href: url, target: "_blank", rel: "noopener" }, `${v.accountId} ↗`) : v.accountId);
      acct.title = `${meta.name} trades from an account of its own and signs its own calls`;
    }
    shutter.setAttribute("aria-hidden", String(state !== "shut"));
    toggle(shutter, "down", state === "shut");

    const mine = held("scrip");
    for (const r of rows) {
      const q = v ? (r.kind === "bid" ? v.bids : v.asks).find((x) => x.tokenId === r.tok) : null;
      const price = q ? q.price : null;
      r.unknown.hidden = price != null || read.s === "loading";
      r.flap.el.hidden = price == null;
      if (price != null) {
        if (r.last != null && price !== r.last) {
          r.dir = price > r.last ? 1 : -1;
          r.was = r.last;
          r.el.classList.remove("moved", "up", "down");
          void r.el.offsetWidth;
          r.el.classList.add("moved", r.dir > 0 ? "up" : "down");
          popDelta(r.delta, price - r.last);
        }
        r.last = price;
        void r.flap.set(String(price), r.flap.value !== "");
      }
      r.trend.dataset.dir = String(price == null ? 0 : r.dir);
      text(r.trend, r.dir > 0 ? "▲" : r.dir < 0 ? "▼" : "–");
      const h1 = held(r.tok);
      const stock = r.kind === "bid" && v ? (v.stock[r.tok as CargoId] ?? 0) : null;
      const target = ITEMS[r.tok].target;
      text(
        r.sub,
        r.kind === "bid"
          ? `stock ${stock != null ? `${stock}/${target}` : UNKNOWN} · you ${h1 == null ? UNKNOWN : h1}`
          : `you hold ${h1 == null ? UNKNOWN : h1}`,
      );
      const open = v?.open === true;
      if (r.kind === "bid") {
        r.btns[0].disabled = busy() || !open || !h1;
        r.btns[1].disabled = busy() || !open || !h1 || h1 < 2;
        text(r.btns[1], h1 && h1 > 1 ? `All ${h1}` : "All");
      } else r.btns[0].disabled = busy() || !open || mine == null || price == null || mine < price;
      for (const b of r.btns) toggle(b, "busy", busy());
      r.el.setAttribute("aria-label", `${itemName(r.tok)}: ${price == null ? UNKNOWN : price} scrip`);
      paintTip(r, v, q?.reason ?? null, price);
    }

    // gauges
    text(floatN, v ? fmt(v.scrip) : UNKNOWN);
    floatFill.style.width = v ? `${Math.min(100, (v.scrip / FLOAT_SCALE) * 100)}%` : "0%";
    toggle(floatFill, "low", !!v && v.scrip < FLOAT_REOPEN);
    for (const s of stockEls) {
      const stock = v ? (v.stock[s.c] ?? 0) : null;
      const target = ITEMS[s.c].target ?? 1;
      text(s.n, stock == null ? UNKNOWN : `${stock}`);
      s.fill.style.width = stock == null ? "0%" : `${Math.min(100, (stock / (target * 2)) * 100)}%`;
      toggle(s.fill, "over", stock != null && stock > target * 1.5);
      toggle(s.el, "unk", stock == null);
    }
    toggle(floatN, "unk", !v);

    // shutter + shares
    text(shutterFloat, v ? fmt(v.scrip) : UNKNOWN);
    shutterBar.style.width = v ? `${Math.min(100, (v.scrip / FLOAT_REOPEN) * 100)}%` : "0%";
    const me = ctx.me();
    const total = v ? v.shares.reduce((s, x) => s + x.shares, 0) : 0;
    const my = v && me ? (v.shares.find((x) => x.accountId === me)?.shares ?? 0) : 0;
    text(
      shareT,
      !v ? "Investors " + UNKNOWN : my > 0 ? `Your share ${pct(my, total)}% · ${v.shares.length} investor${v.shares.length === 1 ? "" : "s"}` : v.shares.length ? `${v.shares.length} investor${v.shares.length === 1 ? "" : "s"} · ${fmt(total)} in` : "No investors yet",
    );
    toggle(shareT, "mine", my > 0);
    invBtn.hidden = state !== "open";
    if (state !== "open" && invOpen) setInv(false);
    invest.render(v && !v.open ? Math.max(0, FLOAT_REOPEN - v.scrip) : null, mine);
  }

  function paintTip(r: Row, v: BrokerView | null, reason: string | null, price: number | null) {
    const k = `${v?.open}|${reason}|${price}|${r.was}|${v?.lastMemo}|${v?.stance}|${JSON.stringify(v?.stock)}`;
    if (r.tip.dataset.k === k) return;
    r.tip.dataset.k = k;
    const stock = r.kind === "bid" && v ? (v.stock[r.tok as CargoId] ?? 0) : null;
    r.tip.replaceChildren(
      h("div", { class: "dk-tip-k" }, `${meta.name} ${r.kind === "bid" ? "pays" : "asks"} · ${itemName(r.tok)}`),
      h("p", { class: "dk-tip-r" }, reason ? `“${reason}”` : `Reason ${UNKNOWN}: the stall couldn't be read.`),
      h(
        "dl",
        { class: "dk-tip-m" },
        h("div", null, h("dt", null, "Now"), h("dd", null, fmtOr(price))),
        r.was != null ? h("div", null, h("dt", null, "Was"), h("dd", null, fmt(r.was))) : null,
        stock != null ? h("div", null, h("dt", null, "Stock"), h("dd", null, `${stock} / ${ITEMS[r.tok].target}`)) : null,
        h("div", null, h("dt", null, "Stance"), h("dd", null, v ? String(v.stance) : UNKNOWN)),
      ),
      h("div", { class: "dk-tip-k2" }, "Agent's last note"),
      h("p", { class: "dk-tip-memo" }, v?.lastMemo ?? (v ? "Nothing on the books yet." : UNKNOWN)),
    );
  }

  update();
  return { el, update };
}
