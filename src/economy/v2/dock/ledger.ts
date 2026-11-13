// THE LEDGER: your account with the Harbormaster. What you owe and what owing does; SETTLE, with the plain truth
// beside it (every scrip paid goes into the Harbormaster's wallet, and it spends it on machines); that wallet as a
// meter; your impounded guns with the fee, the clock and BUY BACK; and the open economy in four numbers.
import { h } from "../../dockside/dom";
import { fmt, UNKNOWN } from "../../dockside/format";
import { HARBORMASTER, INVOICE } from "../items";
import type { HarbormasterView, Impounded, Profile } from "../types";
import { frameWord, gunCard } from "./guncard";
import { actBtn, countdown, emptyLine, head, numOr, okv, painter, plural, type Ctx } from "./store";

/** The most a settle can take: half the arrears (rounded up), and no more than the scrip in hand. */
export const maxSettle = (arrears: number, scrip: number) => Math.max(0, Math.min(scrip, Math.ceil(arrears / INVOICE.settleRate)));

/** What the Harbormaster's wallet buys, in its own words. */
export function hmBuys(hm: HarbormasterView): string {
  if (hm.posture === "pursuit") return `Bailiff at ${fmt(hm.bailiffAt)}`;
  return hm.bonusDrones > 0 ? `+${hm.bonusDrones} Inspection Unit${hm.bonusDrones === 1 ? "" : "s"} every wave` : "No extra Inspection Units";
}

export function createLedger(ctx: Ctx) {
  const el = h("div", { class: "d2-ledger" });
  let pay: number | null = null;

  function account(p: Profile | null, hm: HarbormasterView | null) {
    const scrip = ctx.holding("scrip");
    if (!p)
      return h(
        "section",
        { class: "d2-acct", "aria-label": "Your account" },
        head("Your account"),
        emptyLine(ctx.reads.profile.s === "loading" ? "Pulling your file…" : `What you owe: ${UNKNOWN}. The Harbormaster's office isn't answering. Nothing has been charged.`, ctx.reads.profile.s === "unknown"),
      );
    const carried = Math.min(INVOICE.carryInMax, Math.floor((p.arrears * INVOICE.carryInPct) / 100));
    const bonded = p.arrears >= INVOICE.bondedAt;
    const max = scrip == null ? null : maxSettle(p.arrears, scrip);
    const amount = max == null ? null : Math.max(0, Math.min(pay ?? max, max));
    const clears = amount == null ? null : Math.min(p.arrears, amount * INVOICE.settleRate);
    const after = hm && amount != null ? Math.min(100, Math.floor((hm.balance + amount) / HARBORMASTER.scripPerStrength)) : null;
    const chip = (label: string, n: number) => h("button", { class: "d2-seg-b", type: "button", "data-k": `pay:${label}`, "aria-pressed": String(amount === n), disabled: max == null || n < 1 || null, onclick: () => ((pay = n), ctx.render()) }, label);
    return h(
      "section",
      { class: "d2-acct", "aria-label": "Your account", "data-arrears": p.arrears },
      head("Your account", `${p.callsign} · ${plural(p.raids, "raid")}`),
      h("div", { class: `d2-owed${p.arrears ? "" : " clear"}` }, h("span", null, "Arrears"), h("b", null, fmt(p.arrears)), h("i", null, p.arrears ? "owed to the Harbormaster" : "nothing owed")),
      h(
        "ul",
        { class: "d2-does" },
        h("li", { "data-on": carried > 0 ? "1" : "0" }, h("b", null, `+${fmt(carried)}`), h("span", null, `already on the invoice when your next raid starts (half your arrears, up to ${fmt(INVOICE.carryInMax)})`)),
        h(
          "li",
          { "data-on": bonded ? "1" : "0", class: "bonded" },
          h("b", null, bonded ? "Bonded" : fmt(INVOICE.bondedAt)),
          h("span", null, bonded ? `containers are on your manifest: better parts, while you owe ${fmt(INVOICE.bondedAt)} or more` : `in arrears puts bonded containers on your manifest. You are ${fmt(INVOICE.bondedAt - p.arrears)} short of being wanted.`),
        ),
      ),
      p.arrears
        ? h(
            "div",
            { class: "d2-settle", "data-pay": amount, "data-clears": clears },
            h("div", { class: "d2-settle-h" }, h("span", null, "Settle"), h("i", null, `1 scrip clears ${INVOICE.settleRate} of arrears`)),
            max == null
              ? emptyLine(`Your scrip is ${UNKNOWN}, so nothing can be paid yet.`, true)
              : h(
                  "div",
                  { class: "d2-settle-row" },
                  h("div", { class: "d2-seg" }, chip("A quarter", Math.floor(max / 4)), chip("Half", Math.floor(max / 2)), chip("All of it", max)),
                  h("p", { class: "d2-settle-n" }, "Pay ", h("b", null, fmt(amount!)), " scrip · clears ", h("b", null, fmt(clears!))),
                ),
            h("p", { class: "d2-truth" }, "Every scrip you pay goes into the Harbormaster's wallet. It spends it on machines.", after != null && hm && amount ? h("span", null, ` This payment takes its strength from ${hm.strength} to ${after}.`) : null),
            actBtn(ctx, {
              k: "settle",
              label: amount ? `Settle ${fmt(amount)} scrip` : "Settle",
              cls: "solid wide",
              disabled: !amount,
              why: max === 0 ? "You have no scrip to pay with." : null,
              onclick: () =>
                void ctx
                  .act({
                    key: "settle",
                    settling: `Settling: paying the Harbormaster ${fmt(amount!)} scrip…`,
                    run: () => ctx.chain.settle(amount!),
                    done: (r) => `Paid. ${r.cleared == null ? UNKNOWN : fmt(r.cleared)} of arrears cleared; you now owe ${r.arrears == null ? UNKNOWN : fmt(r.arrears)}. The Harbormaster thanks you for your prompt payment.`,
                    refresh: ["harbormaster", "economy"],
                  })
                  .then(() => ((pay = null), ctx.render())),
            }),
          )
        : h("p", { class: "d2-truth clear" }, "Your account is clear. The Harbormaster has nothing of yours to spend."),
    );
  }

  function wallet(hm: HarbormasterView | null) {
    if (!hm)
      return h(
        "section",
        { class: "d2-hm", "aria-label": "The Harbormaster's wallet" },
        head("The Harbormaster's wallet"),
        emptyLine(ctx.reads.harbormaster.s === "loading" ? "Auditing…" : `Its balance: ${UNKNOWN}. Its strength: ${UNKNOWN}. Assume the worst.`, ctx.reads.harbormaster.s === "unknown"),
      );
    const ticks = [1, 2, 3, 4].map((n) => h("i", { style: `left:${n * HARBORMASTER.strengthPerDrone}%`, class: hm.strength >= n * HARBORMASTER.strengthPerDrone ? "on" : "" }, hm.posture === "patrols" ? `+${n}` : ""));
    return h(
      "section",
      { class: "d2-hm", "aria-label": "The Harbormaster's wallet", "data-posture": hm.posture, "data-balance": hm.balance, "data-strength": hm.strength },
      head("The Harbormaster's wallet", `halves every ${HARBORMASTER.halfLifeHours} hours`),
      h("div", { class: "d2-hm-n" }, h("b", { class: "d2-hm-bal" }, fmt(hm.balance)), h("span", null, "scrip, paid in by Breachers")),
      h("div", { class: "d2-hm-meter", role: "img", "aria-label": `Strength ${hm.strength} of 100` }, h("span", { class: "d2-hm-fill", style: `width:${hm.strength}%` }), ...ticks),
      h(
        "dl",
        { class: "d2-hm-rows" },
        h("div", null, h("dt", null, "Strength"), h("dd", null, `${hm.strength} / 100`)),
        h("div", null, h("dt", null, "Posture"), h("dd", { class: "posture" }, hm.posture === "patrols" ? "Patrols" : "Pursuit")),
        h("div", { class: "buys" }, h("dt", null, "What it buys now"), h("dd", null, hmBuys(hm))),
        h("div", null, h("dt", null, "Bailiff sent at"), h("dd", null, fmt(hm.bailiffAt))),
      ),
      hm.lastMemo ? h("blockquote", { class: "d2-memo hm" }, h("span", null, "Its agent's last note"), h("p", null, hm.lastMemo)) : null,
    );
  }

  function impoundRow(i: Impounded) {
    const scrip = ctx.holding("scrip");
    const w = i.weapon;
    const short = scrip == null ? `Your scrip is ${UNKNOWN}` : scrip < i.fee ? `${fmt(i.fee - scrip)} scrip short` : null;
    const left = countdown(i.expiresAt);
    return h(
      "div",
      { class: "d2-imp", "data-serial": w.serial },
      h("p", { class: "d2-imp-clock", "data-left": left }, h("b", null, left), h("span", null, left === "gone" ? "It has been destroyed." : `until this ${frameWord(w.frame)} is destroyed`)),
      gunCard(w, {
        me: ctx.me(),
        tag: "Impounded",
        price: { label: "Release fee", amount: i.fee },
        actions: [
          actBtn(ctx, {
            k: `buyback:${w.serial}`,
            label: "Buy back",
            cls: "solid",
            disabled: !!short,
            why: short,
            onclick: () =>
              void ctx.act({
                key: `buyback:${w.serial}`,
                settling: `Settling: paying the release fee on ${w.serial}…`,
                run: () => ctx.chain.buyBack(w.serial),
                done: (r) => `${w.serial} is released, for ${r.cost == null ? UNKNOWN : `${fmt(r.cost)} scrip`}. The fee went into the Harbormaster's wallet.`,
                refresh: ["impound", "harbormaster"],
              }),
          }),
          short ? h("span", { class: "d2-why" }, short) : null,
        ],
      }),
    );
  }

  const paint = painter(
    el,
    () => [ctx.reads.profile, ctx.reads.harbormaster, ctx.reads.impound, ctx.reads.economy, ctx.reads.balances, pay, ctx.busy() ? "busy" : "", Math.floor(Date.now() / 60000)],
    () => {
      const p = okv(ctx.reads.profile);
      const hm = okv(ctx.reads.harbormaster);
      const imp = okv(ctx.reads.impound);
      const eco = okv(ctx.reads.economy);
      const unk = ctx.reads.economy.s === "unknown";
      const stat = (k: string, label: string, v: string | null, sub?: string) =>
        h("div", { "data-eco": k, "data-unknown": v == null && unk ? "1" : null }, h("dt", null, label), h("dd", { class: v == null ? "d2-unk" : "" }, v ?? (unk ? UNKNOWN : "…")), sub ? h("span", null, sub) : null);
      return [
        h("div", { class: "d2-ledger-cols", "data-scroll": "ledger" }, account(p, hm), wallet(hm),
          h(
            "section",
            { class: "d2-impound", "aria-label": "The impound" },
            head("The impound", imp ? plural(imp.length, "gun") : null),
            imp
              ? imp.length
                ? h("div", { class: "d2-imp-list" }, ...imp.map(impoundRow))
                : emptyLine("Nothing of yours is in the impound. Keep it that way: stay ahead of the Bailiff.")
              : emptyLine(ctx.reads.impound.s === "loading" ? "Checking the cage…" : `Your impounded guns: ${UNKNOWN}.`, ctx.reads.impound.s === "unknown"),
          ),
        ),
        h(
          "dl",
          { class: "d2-eco", "aria-label": "The open economy" },
          h("div", { class: "d2-eco-k" }, h("dt", null, "The open economy"), h("dd", null, "anyone can check these")),
          stat("supply", "Scrip in existence", eco ? fmt(eco.scripSupply) : null),
          stat("flow", "Minted · burned today", eco ? `+${fmt(eco.minted24h)} · −${fmt(eco.burned24h)}` : null),
          stat("alive", "Guns alive", eco ? fmt(eco.weaponsAlive) : null, eco ? `of ${numOr(eco.weaponsBuilt)} built` : undefined),
          stat("destroyed", "Guns destroyed", eco ? fmt(eco.weaponsDestroyed) : null, "lost, scrapped or left in the impound"),
        ),
      ];
    },
  );

  return { el, update: paint };
}
