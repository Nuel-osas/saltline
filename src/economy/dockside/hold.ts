// Your hold: scrip on a flap counter, cargo, gear, and which gear goes on you for the next run. Equipping writes
// economy.equipped, which the salvage code hands to startRun. Only gear you hold can be equipped.
import { CARGO, GEAR, ITEMS, RULES } from "../items";
import type { BrokerView, CargoId, GearId } from "../types";
import { okv, type Ctx } from "./ctx";
import { h, popDelta, text, toggle } from "./dom";
import { createFlap } from "./flap";
import { accountUrl, fmt, shortAccount, UNKNOWN } from "./format";

const EFFECT: Record<GearId, string> = {
  plate: `+${RULES.gear.plateHealth} health`,
  mag: `+${RULES.gear.magRounds} rounds a mag`,
  cutter: `Cuts seals ${Math.round(RULES.gear.cutterSpeed * 100)}% faster`,
};

/** Cargo valued at the best bid from an open broker; null when the brokers couldn't be read. */
export function holdWorth(hold: Partial<Record<string, number>>, brokers: BrokerView[] | null): number | null {
  if (!brokers) return null;
  let total = hold.scrip ?? 0;
  for (const c of CARGO) {
    const n = hold[c] ?? 0;
    if (!n) continue;
    const bids = brokers.filter((b) => b.open).flatMap((b) => b.bids.filter((q) => q.tokenId === c).map((q) => q.price));
    total += n * (bids.length ? Math.max(...bids) : 0);
  }
  return total;
}

export function createHold(ctx: Ctx) {
  const scrip = createFlap({ cells: 4, className: "dk-hflap", onStep: ctx.flapTick });
  const scripUnk = h("span", { class: "dk-unknown big" }, UNKNOWN);
  const scripDelta = h("b", { class: "dk-delta big", "aria-hidden": "true" });
  let lastScrip: number | null = null;
  const who = h("span", { class: "dk-hold-who" });
  const worth = h("p", { class: "dk-hold-worth" });
  const cargo = CARGO.map((c) => {
    const n = h("b");
    const el = h("li", { class: "dk-hrow" }, h("span", { class: "dk-hrow-n" }, ITEMS[c].name), h("span", { class: "dk-hrow-s" }, `wt ${ITEMS[c].weight}`), n);
    return { c, el, n };
  });
  const gear = GEAR.map((g) => {
    const n = h("b");
    const btn = h(
      "button",
      { class: "dk-equip", type: "button", "aria-pressed": "false", "aria-label": `Equip ${ITEMS[g].name} for the next run`, onclick: () => equip(g) },
      h("i", { "aria-hidden": "true" }),
      h("span", null, "Equip"),
    );
    const el = h("li", { class: "dk-hrow gear" }, h("span", { class: "dk-hrow-n" }, ITEMS[g].name), h("span", { class: "dk-hrow-s" }, EFFECT[g]), n, btn);
    return { g, el, n, btn };
  });
  const next = h("p", { class: "dk-next" });
  const acct = h("p", { class: "dk-hold-acct" });
  const el = h(
    "section",
    { class: "dk-hold", "aria-label": "Your hold" },
    h("header", { class: "dk-panel-h" }, h("h3", null, "Your hold"), who),
    h("div", { class: "dk-hold-scrip" }, scrip.el, scripUnk, h("span", { class: "dk-hold-unit" }, "scrip"), scripDelta),
    worth,
    h("div", { class: "dk-hk" }, h("span", null, "Cargo"), h("span", null, `carry ${RULES.carryLimit}`)),
    h("ul", { class: "dk-hlist" }, ...cargo.map((x) => x.el)),
    h("div", { class: "dk-hk" }, h("span", null, "Gear"), h("span", null, "for the next run")),
    h("ul", { class: "dk-hlist" }, ...gear.map((x) => x.el)),
    next,
    acct,
  );

  const equipped = () => (ctx.economy.equipped ??= []);
  function equip(g: GearId) {
    const list = equipped();
    const i = list.indexOf(g);
    if (i >= 0) list.splice(i, 1);
    else {
      const n = okv(ctx.reads.balances)?.[g] ?? 0;
      if (n < 1) return;
      list.push(g);
    }
    ctx.sound("click");
    update();
  }

  function update() {
    const bal = okv(ctx.reads.balances);
    const prof = okv(ctx.reads.profile);
    text(who, prof?.callsign ?? "");
    const s = bal ? (bal.scrip ?? 0) : null;
    scrip.el.hidden = s == null;
    scripUnk.hidden = s != null || ctx.reads.balances.s === "loading";
    if (s != null) {
      if (lastScrip != null && s !== lastScrip) popDelta(scripDelta, s - lastScrip);
      lastScrip = s;
      void scrip.set(String(s), scrip.value !== "");
    }
    const w = bal ? holdWorth(bal, okv(ctx.reads.brokers)) : null;
    text(worth, w == null ? `Worth ${UNKNOWN} at today's bids` : `Worth ${fmt(w)} at today's best bids`);

    for (const x of cargo) {
      const n = bal ? (bal[x.c as CargoId] ?? 0) : null;
      text(x.n, n == null ? UNKNOWN : `×${n}`);
      toggle(x.el, "none", n === 0);
      toggle(x.el, "unk", n == null);
    }
    // Gear you no longer hold (a run burned it) drops off the list; an unknown balance keeps the pick.
    if (bal) ctx.economy.equipped = equipped().filter((g) => (bal[g] ?? 0) > 0);
    const list = equipped();
    for (const x of gear) {
      const n = bal ? (bal[x.g] ?? 0) : null;
      const on = list.includes(x.g);
      text(x.n, n == null ? UNKNOWN : `×${n}`);
      toggle(x.el, "none", n === 0);
      toggle(x.el, "on", on);
      x.btn.setAttribute("aria-pressed", String(on));
      text(x.btn.lastChild as HTMLElement, on ? "Equipped" : "Equip");
      x.btn.disabled = !on && (n == null || n < 1);
    }
    text(next, list.length ? `Next run: ${list.map((g) => ITEMS[g].name).join(" + ")}` : "Next run: no gear");
    toggle(next, "set", list.length > 0);

    const id = ctx.me();
    const url = id ? accountUrl(ctx.chain.network, id) : null;
    acct.replaceChildren(
      h("span", null, id ? shortAccount(id) : "no account yet"),
      " · ",
      url ? h("a", { href: url, target: "_blank", rel: "noopener" }, "NEAR testnet ↗") : h("span", null, ctx.chain.network === "testnet" ? "NEAR testnet" : "mock ledger"),
    );
  }

  update();
  return { el, update };
}
