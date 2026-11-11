// The leaderboard: net worth at today's bids, best single haul, and who has put the most into the brokers. Your row
// is lit; if you're not in a top ten, a line says so.
import type { LeaderRow } from "../types";
import { okv, type Ctx } from "./ctx";
import { fill, h } from "./dom";
import { fmt, UNKNOWN } from "./format";

const COLS = [
  { key: "netWorth", title: "Net worth", sub: "scrip + cargo at today's bids" },
  { key: "bestHaul", title: "Best haul", sub: "one run, at the bids it landed on" },
  { key: "investors", title: "Investors", sub: "scrip put into the brokers" },
] as const;

export function createBoard(ctx: Ctx) {
  const cols = COLS.map((c) => {
    const list = h("ol", { class: "dk-lb-list" });
    const foot = h("p", { class: "dk-lb-foot" });
    const el = h("section", { class: "dk-lb-col", "aria-label": c.title }, h("header", { class: "dk-panel-h" }, h("h3", null, c.title), h("span", null, c.sub)), list, foot);
    return { ...c, el, list, foot };
  });
  const el = h("div", { class: "dk-lb" }, ...cols.map((c) => c.el));

  function rowEl(r: LeaderRow, i: number, max: number, me: string | null) {
    const mine = !!me && r.accountId === me;
    return h(
      "li",
      { class: `dk-lb-row${mine ? " mine" : ""}${i === 0 ? " top" : ""}`, "aria-current": mine ? "true" : null },
      h("span", { class: "dk-lb-rank" }, String(i + 1).padStart(2, "0")),
      h("span", { class: "dk-lb-name" }, r.callsign || r.accountId, mine ? h("em", null, "You") : null),
      h("b", { class: "dk-lb-v" }, fmt(r.value)),
      h("i", { class: "dk-lb-bar", style: `width:${max > 0 ? Math.max(2, (r.value / max) * 100) : 0}%`, "aria-hidden": "true" }),
    );
  }

  function update() {
    const read = ctx.reads.leaderboard;
    const lb = okv(read);
    const me = ctx.me();
    for (const c of cols) {
      if (read.s === "unknown") {
        fill(c.list, h("li", { class: "dk-empty unk" }, `${c.title} ${UNKNOWN}: can't read the board right now.`));
        fill(c.foot);
        continue;
      }
      if (!lb) {
        fill(c.list, h("li", { class: "dk-empty" }, "Reading the board…"));
        continue;
      }
      const rows = lb[c.key];
      const max = rows.reduce((m, r) => Math.max(m, r.value), 0);
      fill(c.list, ...(rows.length ? rows.map((r, i) => rowEl(r, i, max, me)) : [h("li", { class: "dk-empty" }, "Nobody yet.")]));
      fill(c.foot, me && !rows.some((r) => r.accountId === me) ? "You're not in the top ten here yet." : "");
    }
  }

  update();
  return { el, update };
}
