// The player market: cargo and gear other players have posted (buy the lot), your own listings (cancel), and a
// form to post one. The dock holds listed goods until they sell or you cancel.
import { CARGO, GEAR, ITEMS } from "../items";
import type { CargoId, GearId, Listing } from "../types";
import { createSlot, okv, type Ctx } from "./ctx";
import { fill, h, text } from "./dom";
import { ago, fmt, UNKNOWN } from "./format";

type Tradable = CargoId | GearId;

export function createMarket(ctx: Ctx) {
  const slot = createSlot();
  const board = h("div", { class: "dk-mk-list", role: "list" });
  const mine = h("div", { class: "dk-mk-list mine", role: "list" });
  const items = h("div", { class: "dk-chips wrap", role: "group", "aria-label": "Item to list" });
  const amountN = h("output", { class: "dk-step-n" });
  const priceN = h("output", { class: "dk-step-n" });
  const hint = h("p", { class: "dk-mk-hint" });
  const post = h("button", { class: "dk-b solid wide", type: "button", onclick: () => doList() }, "Post listing");
  let pickTok: Tradable | null = null;
  let amount = 1;
  let price = 0;
  const busy = () => slot.state === "pending";
  slot.onChange = () => update();

  const stepper = (label: string, out: HTMLElement, dec: () => void, inc: () => void) =>
    h(
      "div",
      { class: "dk-step" },
      h("span", { class: "dk-step-k" }, label),
      h("button", { class: "dk-b sq", type: "button", "aria-label": `Less ${label.toLowerCase()}`, onclick: dec }, "−"),
      out,
      h("button", { class: "dk-b sq", type: "button", "aria-label": `More ${label.toLowerCase()}`, onclick: inc }, "+"),
    );

  const el = h(
    "section",
    { class: "dk-market", "aria-label": "Player market" },
    h(
      "div",
      { class: "dk-mk-col" },
      h("header", { class: "dk-panel-h" }, h("h3", null, "On the board"), h("span", null, "other players · buy the lot")),
      board,
    ),
    h(
      "div",
      { class: "dk-mk-col side" },
      h("header", { class: "dk-panel-h" }, h("h3", null, "Your listings"), h("span", null, "held by the dock")),
      mine,
      h("header", { class: "dk-panel-h" }, h("h3", null, "Post a listing")),
      items,
      stepper("Amount", amountN, () => setAmount(amount - 1), () => setAmount(amount + 1)),
      stepper("Each", priceN, () => setPrice(price - 1), () => setPrice(price + 1)),
      hint,
      post,
      slot.el,
    ),
  );

  const bal = () => okv(ctx.reads.balances);
  const held = (t: Tradable) => bal()?.[t] ?? 0;
  const suggest = (t: Tradable) => {
    const bs = okv(ctx.reads.brokers);
    if (!bs) return ITEMS[t].base;
    const qs = bs.flatMap((b) => [...b.bids, ...b.asks]).filter((q) => q.tokenId === t).map((q) => q.price);
    return qs.length ? Math.max(...qs) : ITEMS[t].base;
  };
  const setAmount = (n: number) => {
    amount = Math.max(1, Math.min(pickTok ? held(pickTok) : 1, n));
    update();
  };
  const setPrice = (n: number) => {
    price = Math.max(1, Math.min(9999, n));
    update();
  };

  function doList() {
    if (!pickTok || amount < 1 || price < 1) return;
    const t = pickTok;
    const n = amount;
    const p = price;
    void ctx.act(slot, {
      pending: `Settling… posting ${n} ${t} at ${p}`,
      call: () => ctx.chain.list(t, n, p),
      done: () => `Posted ${n} ${t} at ${p} each`,
      refresh: ["listings", "balances", "recent"],
    });
  }

  function row(l: Listing, own: boolean) {
    const total = l.amount * l.price;
    const scrip = bal()?.scrip;
    const btn = own
      ? h("button", { class: "dk-b ghost", type: "button", disabled: busy(), onclick: () => cancel(l) }, "Cancel")
      : h("button", { class: "dk-b", type: "button", disabled: busy() || scrip == null || scrip < total, onclick: () => buyIt(l) }, `Buy · ${fmt(total)}`);
    return h(
      "div",
      { class: `dk-mk-row${own ? " own" : ""}`, role: "listitem" },
      h("span", { class: "dk-mk-item" }, h("b", null, ITEMS[l.tokenId].name), ` ×${l.amount}`),
      h("span", { class: "dk-mk-price" }, h("b", null, fmt(l.price)), " each"),
      h("span", { class: "dk-mk-who" }, own ? "you" : l.callsign, h("time", null, ` · ${ago(l.at)}`)),
      btn,
    );
  }
  function buyIt(l: Listing) {
    void ctx.act(slot, {
      pending: `Settling… buying ${l.amount} ${l.tokenId} from ${l.callsign}`,
      call: () => ctx.chain.buyListing(l.id),
      done: () => `Bought ${l.amount} ${l.tokenId} for ${fmt(l.amount * l.price)}`,
      refresh: ["listings", "balances", "recent"],
    });
  }
  function cancel(l: Listing) {
    void ctx.act(slot, {
      pending: `Settling… taking ${l.tokenId} off the board`,
      call: () => ctx.chain.cancelListing(l.id),
      done: () => `Back in your hold: ${l.amount} ${l.tokenId}`,
      refresh: ["listings", "balances"],
    });
  }

  function update() {
    const read = ctx.reads.listings;
    const me = ctx.me();
    const list = okv(read);
    if (read.s === "unknown") {
      fill(board, h("p", { class: "dk-empty unk" }, `Listings ${UNKNOWN}: the board can't be read right now.`));
      fill(mine, h("p", { class: "dk-empty unk" }, UNKNOWN));
    } else if (!list) {
      fill(board, h("p", { class: "dk-empty" }, "Reading the board…"));
    } else {
      const others = list.filter((l) => l.seller !== me).sort((a, b) => b.at - a.at);
      const own = list.filter((l) => l.seller === me);
      fill(board, ...(others.length ? others.map((l) => row(l, false)) : [h("p", { class: "dk-empty" }, "Nothing posted. Sell to a broker, or post your own.")]));
      fill(mine, ...(own.length ? own.map((l) => row(l, true)) : [h("p", { class: "dk-empty" }, "None posted.")]));
    }

    const b = bal();
    const can = [...CARGO, ...GEAR].filter((t) => (b?.[t] ?? 0) > 0);
    if (pickTok && !can.includes(pickTok)) pickTok = null;
    if (!pickTok && can.length) {
      pickTok = can[0];
      amount = 1;
      price = suggest(pickTok);
    }
    const key = can.join(",") + "|" + (b ? "ok" : "x");
    if (items.dataset.k !== key) {
      items.dataset.k = key;
      fill(
        items,
        ...(b == null
          ? [h("p", { class: "dk-empty unk" }, `Hold ${UNKNOWN}`)]
          : can.length
            ? can.map((t) =>
                h(
                  "button",
                  {
                    class: "dk-chip",
                    type: "button",
                    "data-t": t,
                    onclick: () => {
                      pickTok = t;
                      amount = 1;
                      price = suggest(t);
                      update();
                    },
                  },
                  `${t} ×${b[t]}`,
                ),
              )
            : [h("p", { class: "dk-empty" }, "Nothing in your hold to post.")]),
      );
    }
    for (const c of items.querySelectorAll<HTMLButtonElement>("button")) c.setAttribute("aria-pressed", String(c.dataset.t === pickTok));
    text(amountN, pickTok ? String(amount) : "–");
    text(priceN, pickTok ? String(price) : "–");
    text(
      hint,
      pickTok
        ? `Total ${fmt(amount * price)} · a broker ${ITEMS[pickTok].kind === "gear" ? "asks" : "pays"} ${suggest(pickTok)} for one right now`
        : "Pick something you hold.",
    );
    post.disabled = busy() || !pickTok || b == null;
  }

  update();
  return { el, update };
}
