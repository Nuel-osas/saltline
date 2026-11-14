// THE VENDORS: first the haul (haul.ts): one line on what to do, who pays most for each lot and why, and one button
// that sells it all, lot by lot through the chain; then what it made and the one thing that scrip unlocks. Below it,
// the people, not price boards: Moss the armourer (what she pays for parts, each with her reason; the guns
// and mods she has built; her last note), Ines the quartermaster (plates, charges, magazines), and the export desk,
// where the freighter pays in new scrip and pays less for every crate already aboard.
import { h } from "../../dockside/dom";
import { fmt, UNKNOWN } from "../../dockside/format";
import { CONSUMABLES, MATERIALS, MODS, TOKEN_NAMES, VENDOR_PRICING, VENDORS } from "../items";
import type { ConsumableId, MaterialId, ModId, Quote, TxResult, Vendor, VendorGood, VendorId } from "../types";
import { gunCard } from "./guncard";
import { BUYER, haulOf, nextStep, planSale, type HaulPlan, type Lot } from "./haul";
import { actBtn, emptyLine, head, okv, painter, scripEl, SHORT, type Ctx } from "./store";

type Who = VendorId | "export";

const PEOPLE: Record<Who, { name: string; role: string; line: string }> = {
  moss: { name: "Moss", role: "Armourer", line: "Builds every gun she sells from parts somebody carried out. Pays for the parts she's short of." },
  ines: { name: "Ines", role: "Quartermaster", line: "Plates, charges and magazines, made from what Breachers bring her. Counts everything twice." },
  export: { name: "The export desk", role: "Freighter agent", line: "Buys anything for the freighter and pays in new scrip. Nobody at the window. The price list is the law." },
};

/** The stencil portraits, drawn here: Moss with her goggles up, Ines under her cap, and the freighter at the quay. */
function portrait(who: Who): HTMLElement {
  const el = document.createElement("div");
  el.className = "d2-face";
  el.dataset.who = who;
  const bust = '<path class="pf-b" d="M8 124 Q12 92 44 84 L52 82 V70 H68 V82 L76 84 Q108 92 112 124 Z"/><ellipse class="pf-b" cx="60" cy="50" rx="20" ry="24"/>';
  const art: Record<Who, string> = {
    moss:
      bust +
      '<path class="pf-b" d="M40 44 Q38 22 60 22 Q82 22 80 44 Q72 30 60 30 Q48 30 40 44 Z"/><circle class="pf-b" cx="74" cy="20" r="8"/>' +
      '<rect class="pf-a" x="39" y="33" width="42" height="5"/><circle class="pf-c" cx="50" cy="35" r="7"/><circle class="pf-c" cx="70" cy="35" r="7"/><circle class="pf-a" cx="50" cy="35" r="4"/><circle class="pf-a" cx="70" cy="35" r="4"/>' +
      '<path class="pf-c" d="M40 86 L48 124 H56 L46 84 Z M80 86 L72 124 H64 L74 84 Z"/><path class="pf-a" d="M46 104 H74 V124 H46 Z"/>',
    ines:
      bust +
      '<path class="pf-a" d="M38 40 Q38 20 60 20 Q82 20 82 40 Z"/><path class="pf-a" d="M36 40 H98 Q100 46 92 46 H36 Z"/><rect class="pf-c" x="38" y="38" width="44" height="3"/>' +
      '<path class="pf-b" d="M40 46 Q36 66 44 74 L46 56 Z M80 46 Q84 66 76 74 L74 56 Z"/>' +
      '<path class="pf-c" d="M52 82 L60 96 L68 82 L64 80 L60 88 L56 80 Z"/><rect class="pf-a" x="78" y="96" width="20" height="26" rx="1"/><path class="pf-c" d="M82 104 H94 M82 110 H94 M82 116 H90" stroke-width="2" fill="none"/>',
    export:
      '<path class="pf-b" d="M4 92 H116 L104 116 H16 Z"/><rect class="pf-b" x="84" y="64" width="18" height="28"/><rect class="pf-a" x="88" y="50" width="9" height="14"/>' +
      '<rect class="pf-a" x="18" y="76" width="18" height="14"/><rect class="pf-b" x="38" y="76" width="18" height="14"/><rect class="pf-a" x="58" y="76" width="18" height="14"/><rect class="pf-b" x="28" y="60" width="18" height="14"/><rect class="pf-a" x="48" y="60" width="18" height="14"/>' +
      '<path class="pf-c" d="M0 120 Q10 114 20 120 T40 120 T60 120 T80 120 T100 120 T120 120" stroke-width="2.5" fill="none"/>',
  };
  el.innerHTML = `<svg viewBox="0 0 120 124" aria-hidden="true">${art[who]}</svg>`;
  return el;
}

/** Where the last SELL EVERYTHING got to. Only confirmed sales count towards `paid`; no answer is pending, never failed. */
type SaleRun =
  | { s: "idle" }
  | { s: "running"; i: number; n: number; paid: number }
  | { s: "done"; paid: number; sold: Lot[]; unknownPaid: number }
  | { s: "pending"; paid: number; sold: Lot[]; lot: Lot }
  | { s: "refused"; paid: number; sold: Lot[]; lot: Lot; error: string }
  | { s: "stopped"; paid: number; sold: Lot[] };

const lotName = (l: { tokenId: MaterialId; amount: number }) => `${TOKEN_NAMES[l.tokenId]} ×${fmt(l.amount)}`;

export function createVendors(ctx: Ctx) {
  const el = h("div", { class: "d2-vendors" });
  let who: Who = "moss";
  let run: SaleRun = { s: "idle" };

  /**
   * SELL EVERYTHING: one sale per lot, one at a time, each through the chain (sell or exportGoods) and each answer
   * checked before the next is sent. A refusal stops the run with what was sold; no answer stops it as pending.
   */
  async function sellAll(plan: HaulPlan) {
    if (ctx.busy() || run.s === "running") return;
    let paid = 0;
    let unknownPaid = 0;
    const sold: Lot[] = [];
    for (const [i, lot] of plan.lots.entries()) {
      run = { s: "running", i, n: plan.lots.length, paid };
      let res: (TxResult & { paid?: number }) | undefined;
      let sent = false;
      const r = await ctx.act({
        key: "sellall",
        settling: `Settling ${i + 1} of ${plan.lots.length}: ${lot.to === "export" ? `loading ${lotName(lot).toLowerCase()} onto the freighter` : `selling ${lotName(lot).toLowerCase()} to ${BUYER[lot.to].name}`}…`,
        run: async () => {
          sent = true;
          res = await (lot.to === "export" ? ctx.chain.exportGoods(lot.tokenId, lot.amount) : ctx.chain.sell(lot.to, lot.tokenId, lot.amount));
          return res;
        },
        done: (x) => `${BUYER[lot.to].name} paid ${x.paid == null ? UNKNOWN : `${fmt(x.paid)} scrip`} for ${lotName(lot).toLowerCase()}.`,
        refresh: ["vendors", "exportPrices", "economy", "listings"],
      });
      if (!sent) {
        // Another action was settling: nothing of this lot was sent.
        run = { s: "stopped", paid, sold };
        break;
      }
      if (!r) {
        run = res && !res.ok && !res.pending ? { s: "refused", paid, sold, lot, error: res.error || "no reason given" } : { s: "pending", paid, sold, lot };
        break;
      }
      sold.push(lot);
      // What the chain says it paid, an integer; an answer without it is counted as a sale of unknown value, not 0.
      if (typeof r.paid === "number" && Number.isSafeInteger(r.paid) && r.paid >= 0) paid += r.paid;
      else unknownPaid++;
      if (i === plan.lots.length - 1) run = { s: "done", paid, sold, unknownPaid };
    }
    if (run.s === "done") ctx.note("ok", `Sold ${plan.lots.length === 1 ? "the lot" : `all ${plan.lots.length} lots`} for ${fmt(paid)} scrip${run.unknownPaid ? " and an amount unknown" : ""}.`);
    ctx.render();
    paint(true);
  }

  /** What a finished run says: the scrip it made, then the one thing that scrip unlocks. */
  function result(r: Exclude<SaleRun, { s: "idle" } | { s: "running" }>) {
    const gain = h("p", { class: "d2-haul-gain", "data-state": r.s }, h("b", null, `+${fmt(r.paid)}`), h("i", null, "scrip"));
    if (r.s === "pending") {
      const to = r.lot.to === "export" ? "the export desk" : BUYER[r.lot.to].name;
      return [gain, h("p", { class: "d2-haul-line warn", "data-state": "pending" }, `No answer yet on ${lotName(r.lot).toLowerCase()} to ${to}. It may still settle: check your stash before selling again.`)];
    }
    if (r.s === "refused") {
      return [gain, h("p", { class: "d2-haul-line warn", "data-state": "refused" }, `${BUYER[r.lot.to].name} turned down ${lotName(r.lot).toLowerCase()}: ${r.error.replace(/\.$/, "")}. The rest is still yours.`)];
    }
    if (r.s === "stopped") return [gain, h("p", { class: "d2-haul-line warn" }, "Stopped: another sale was settling. Press again to sell the rest.")];
    const step = nextStep({ balances: okv(ctx.reads.balances), vendors: okv(ctx.reads.vendors), listings: okv(ctx.reads.listings), me: ctx.me() });
    return [
      gain,
      r.unknownPaid ? h("p", { class: "d2-haul-line warn" }, `${r.unknownPaid === 1 ? "One sale" : `${r.unknownPaid} sales`} landed without saying what it paid: check your scrip.`) : null,
      step
        ? h(
            "div",
            { class: "d2-haul-next" },
            h("p", null, step.text),
            step.go
              ? actBtn(ctx, {
                  k: "haul:next",
                  label: step.go.label,
                  cls: "solid",
                  onclick: () => {
                    if (step.go!.who) who = step.go!.who;
                    ctx.go(step.go!.tab);
                    ctx.render();
                  },
                })
              : null,
          )
        : null,
    ];
  }

  /** The first thing on the tab: what to do, who pays most for each lot and why, and one button that sells it all. */
  function haulPanel() {
    const bal = ctx.reads.balances;
    const items = haulOf(okv(bal));
    const plan = planSale(items, okv(ctx.reads.vendors), okv(ctx.reads.exportPrices));
    const loading = bal.s === "loading" || ctx.reads.vendors.s === "loading" || ctx.reads.exportPrices.s === "loading";
    const finished = run.s !== "idle" && run.s !== "running" ? run : null;
    const body: (Node | null)[] = [];
    if (bal.s === "unknown") body.push(emptyLine(`Your stash: ${UNKNOWN}. Nothing can be sold until it can be read.`, true));
    else if (finished && !items.length) body.push(...result(finished));
    else if (!items.length) body.push(h("p", { class: "d2-haul-line" }, loading ? "Reading your stash…" : "Nothing to sell. Carry cargo out of a raid, then sell it here."));
    else if (!plan) body.push(emptyLine(loading ? "Reading the counters…" : `Who pays most: ${UNKNOWN}. The counters can't be read right now, so nothing is sold blind.`, !loading));
    else {
      if (finished) body.push(...result(finished));
      body.push(
        h(
          "ul",
          { class: "d2-lots" },
          ...plan.lots.map((l) =>
            h(
              "li",
              { class: "d2-lot", "data-tok": l.tokenId, "data-to": l.to },
              h("b", { class: "d2-lot-n" }, lotName(l)),
              h("span", { class: "d2-lot-to" }, `→ ${BUYER[l.to].name}`),
              scripEl(l.total, "d2-lot-p"),
              h("p", { class: "d2-lot-why" }, l.reason),
            ),
          ),
          ...plan.unsold.map((u) => h("li", { class: "d2-lot none", "data-tok": u.tokenId }, h("b", { class: "d2-lot-n" }, lotName(u)), h("span", { class: "d2-lot-to" }, "nobody buying today"))),
        ),
        plan.lots.length
          ? actBtn(ctx, {
              k: "sellall",
              cls: "primary d2-sellall",
              disabled: run.s === "running",
              label: run.s === "running" ? `Selling ${run.i + 1} of ${run.n}…` : h("span", null, "Sell everything to the best buyer", h("i", null, ` · about ${fmt(plan.total)} scrip`)),
              onclick: () => void sellAll(plan),
            })
          : null,
      );
    }
    const lede = items.length && plan?.lots.length ? "Sell what you carried out. Each lot goes to whoever pays most today." : finished?.s === "done" ? "Sold, each lot to the counter that paid most." : "What you carried out, and who pays most for it.";
    return h("section", { class: "d2-haul", "aria-label": "Sell your haul" }, head("Sell your haul", "prices fall as each counter fills"), h("p", { class: "d2-haul-lede" }, lede), ...body);
  }

  const sellRow = (to: Who, q: Quote, open: boolean) => {
    const id = q.tokenId as MaterialId;
    const held = ctx.holding(id);
    const base = to === "export" ? MATERIALS[id].export : MATERIALS[id].bid;
    const verb = to === "export" ? "Export" : "Sell";
    const go = (n: number) =>
      void ctx.act({
        key: `sell:${to}:${id}:${n}`,
        settling: to === "export" ? `Settling: loading ${n} ${SHORT[id].toLowerCase()} onto the freighter…` : `Settling: selling ${n} ${SHORT[id].toLowerCase()} to ${PEOPLE[to].name}…`,
        run: () => (to === "export" ? ctx.chain.exportGoods(id, n) : ctx.chain.sell(to, id, n)),
        done: (r) => `${to === "export" ? "The freighter" : PEOPLE[to].name} paid ${r.paid == null ? UNKNOWN : `${fmt(r.paid)} scrip`} for ${n} ${TOKEN_NAMES[id].toLowerCase()}.`,
        refresh: ["vendors", "exportPrices", "economy"],
      });
    const why = !open ? `${PEOPLE[to].name} can't cover another purchase until she sells something.` : held === 0 ? "You hold none." : null;
    return h(
      "li",
      { class: "d2-bid", "data-tok": id, "data-to": to },
      h("div", { class: "d2-bid-n" }, h("b", null, TOKEN_NAMES[id]), h("i", { class: held == null ? "unk" : "", "data-unknown": held == null ? "1" : null }, held == null ? `you hold ${UNKNOWN}` : `you hold ${fmt(held)}`)),
      h("div", { class: "d2-bid-p", "data-dir": q.price > base ? "up" : q.price < base ? "down" : "flat" }, scripEl(q.price), h("em", null, q.price === base ? (to === "export" ? "at list" : "her usual") : q.price > base ? `${fmt(q.price - base)} over ${to === "export" ? "list" : "her usual"}` : `${fmt(base - q.price)} under ${to === "export" ? "list" : "her usual"}`)),
      // The reason is printed as the chain gives it: the agents write them in the third person ("Ines holds the 10 she
      // wants"), so putting them in quotation marks made a vendor talk about herself by name.
      h("p", { class: "d2-bid-why" }, q.reason),
      h(
        "div",
        { class: "d2-bid-b" },
        actBtn(ctx, { k: `sell:${to}:${id}:1`, label: `${verb} 1`, disabled: !held || !open, why, onclick: () => go(1) }),
        held && held > 1 ? actBtn(ctx, { k: `sell:${to}:${id}:${held}`, label: `${verb} all ${held}`, disabled: !open, why, onclick: () => go(held) }) : null,
      ),
    );
  };

  const goodRow = (v: Vendor, g: VendorGood) => {
    const scrip = ctx.holding("scrip");
    const held = ctx.holding(g.tokenId);
    const short = scrip == null ? `Your scrip is ${UNKNOWN}` : scrip < g.price ? `${fmt(g.price - scrip)} scrip short` : null;
    const line = g.tokenId in MODS ? MODS[g.tokenId as ModId].line : CONSUMABLES[g.tokenId as ConsumableId].line;
    return h(
      "li",
      { class: "d2-good", "data-tok": g.tokenId, "data-stock": g.stock },
      h("div", { class: "d2-bid-n" }, h("b", null, TOKEN_NAMES[g.tokenId]), h("i", null, `${line} · ${g.stock ? `${g.stock} on the shelf` : "sold out"}${held == null ? "" : ` · you hold ${held}`}`)),
      h("div", { class: "d2-bid-p" }, scripEl(g.price)),
      h("p", { class: "d2-bid-why" }, g.reason),
      h(
        "div",
        { class: "d2-bid-b" },
        actBtn(ctx, {
          k: `buy:${v.id}:${g.tokenId}`,
          label: "Buy 1",
          cls: "solid",
          disabled: !g.stock || !!short,
          why: !g.stock ? "Sold out." : short,
          onclick: () =>
            void ctx.act({
              key: `buy:${v.id}:${g.tokenId}`,
              settling: `Settling: buying ${TOKEN_NAMES[g.tokenId].toLowerCase()} from ${v.name}…`,
              run: () => ctx.chain.buy(v.id, g.tokenId, 1),
              done: (r) => `Bought 1 ${TOKEN_NAMES[g.tokenId].toLowerCase()} from ${v.name} for ${r.cost == null ? UNKNOWN : `${fmt(r.cost)} scrip`}.`,
              refresh: ["vendors"],
            }),
        }),
      ),
    );
  };

  function person(w: Who, v: Vendor | null, note: string | null) {
    const p = PEOPLE[w];
    return h(
      "header",
      { class: "d2-person", "data-who": w },
      portrait(w),
      h(
        "div",
        { class: "d2-person-t" },
        h("span", { class: "d2-person-role" }, p.role, v ? h("em", { class: v.open ? "" : "shut" }, v.open ? "Open" : "Out of scrip") : null),
        h("h3", { class: "d2-person-name" }, p.name),
        h("p", { class: "d2-person-line" }, p.line),
        note ? h("blockquote", { class: "d2-memo" }, h("span", null, w === "export" ? "Posted at the window" : `${p.name}'s last note`), h("p", null, note)) : null,
        v ? h("p", { class: "d2-till" }, "Her till: ", h("b", null, fmt(v.scrip)), ` scrip. She can't pay out below ${fmt(VENDOR_PRICING.float)}.`) : null,
      ),
    );
  }

  function shop(v: Vendor) {
    const scrip = ctx.holding("scrip");
    return [
      person(v.id, v, v.lastMemo),
      h(
        "div",
        { class: "d2-shop" },
        h("section", { class: "d2-shop-col", "aria-label": `What ${v.name} pays` }, head(`What ${v.name} pays for parts`, "the price falls as her shelf fills"), h("ul", { class: "d2-bids" }, ...v.bids.map((q) => sellRow(v.id, q, v.open)))),
        h(
          "section",
          { class: "d2-shop-col", "aria-label": `What ${v.name} sells` },
          v.guns.length ? head(`Guns ${v.name} built`, `${v.guns.length} on the rack`) : null,
          v.guns.length
            ? h(
                "div",
                { class: "d2-shop-guns" },
                ...v.guns.map((g) => {
                  const short = scrip == null ? `Your scrip is ${UNKNOWN}` : scrip < g.price ? `${fmt(g.price - scrip)} scrip short` : null;
                  return gunCard(g.weapon, {
                    me: ctx.me(),
                    tag: `On ${v.name}'s rack`,
                    price: { label: `${v.name} asks`, amount: g.price },
                    actions: [
                      actBtn(ctx, {
                        k: `buygun:${g.weapon.serial}`,
                        label: "Buy",
                        cls: "solid",
                        disabled: !!short,
                        why: short,
                        onclick: () =>
                          void ctx.act({
                            key: `buygun:${g.weapon.serial}`,
                            settling: `Settling: buying ${g.weapon.serial} from ${v.name}…`,
                            run: () => ctx.chain.buyGun(v.id, g.weapon.serial),
                            done: (r) => `${g.weapon.serial} is yours, for ${r.cost == null ? UNKNOWN : `${fmt(r.cost)} scrip`}. ${v.name} built it; it will say so for as long as it exists.`,
                            refresh: ["vendors"],
                          }),
                      }),
                      short ? h("span", { class: "d2-why" }, short) : null,
                    ],
                  });
                }),
              )
            : null,
          head(v.id === "moss" ? "Mods off her bench" : "On her shelves"),
          v.goods.length ? h("ul", { class: "d2-bids" }, ...v.goods.map((g) => goodRow(v, g))) : emptyLine("Nothing on the shelves today."),
        ),
      ),
    ];
  }

  function exportDesk(quotes: Quote[] | null) {
    return [
      person("export", null, "Rates fall with every crate loaded and recover overnight. All sales final. The freighter does not wait."),
      h(
        "div",
        { class: "d2-shop one" },
        h(
          "section",
          { class: "d2-shop-col", "aria-label": "What the freighter pays" },
          head("What the freighter pays today", "the only place new scrip comes from"),
          quotes
            ? h("ul", { class: "d2-bids wide" }, ...quotes.map((q) => sellRow("export", q, true)))
            : emptyLine(ctx.reads.exportPrices.s === "loading" ? "Reading the price list…" : `Today's export prices: ${UNKNOWN}. Nothing can be exported until they can be read.`, ctx.reads.exportPrices.s === "unknown"),
        ),
      ),
    ];
  }

  const paint = painter(
    el,
    () => [ctx.reads.vendors, ctx.reads.exportPrices, ctx.reads.balances, ctx.reads.listings, who, run, ctx.busy() ? "busy" : ""],
    () => {
      const vendors = okv(ctx.reads.vendors);
      const v = who === "export" ? null : (vendors?.find((x) => x.id === who) ?? null);
      return [
        haulPanel(),
        h(
          "nav",
          { class: "d2-doors", "aria-label": "Who to see" },
          ...(["moss", "ines", "export"] as Who[]).map((w) => {
            const vv = w === "export" ? null : vendors?.find((x) => x.id === w);
            return h(
              "button",
              { class: "d2-door", type: "button", "data-k": `door:${w}`, "data-who": w, "aria-pressed": String(who === w), onclick: () => ((who = w), ctx.render()) },
              portrait(w),
              h("span", { class: "d2-door-t" }, h("b", null, PEOPLE[w].name), h("i", null, w === "export" ? PEOPLE[w].role : `${VENDORS[w].role}${vv && !vv.open ? " · out of scrip" : ""}`)),
            );
          }),
        ),
        h(
          "div",
          { class: "d2-counter", "data-who": who, "data-scroll": "counter" },
          ...(who === "export"
            ? exportDesk(okv(ctx.reads.exportPrices))
            : v
              ? shop(v)
              : [person(who, null, null), emptyLine(ctx.reads.vendors.s === "loading" ? `${PEOPLE[who].name} is coming to the counter…` : `${PEOPLE[who].name}'s prices: ${UNKNOWN}. The counter can't be reached right now.`, ctx.reads.vendors.s === "unknown")]),
        ),
      ];
    },
  );

  return {
    el,
    update: paint,
    see(w: Who) {
      who = w;
      ctx.render();
    },
    /** A new visit to the dock: the last run's result is from before, unless it is still going. */
    fresh() {
      if (run.s !== "running") run = { s: "idle" };
    },
  };
}
