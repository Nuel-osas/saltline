// THE FAST-FORWARD: a week of the port in a minute, so anyone can watch the economy move (Practice only).
//
// The chain can't be hurried, but Practice runs on the offline port (mock.ts), whose clock can. One step moves that
// clock an hour and lets the hour happen: the other breachers raid, die, build, trade and settle, Moss and Ines buy,
// build and reprice, the export desk's prices recover, and the Harbormaster's wallet fills and halves. After each
// step the same views the dock reads are sampled, and two charts draw what the vendors pay and what the three
// wallets hold. Nothing here is scripted: the lines are whatever the rules produce from this port's state.
//
// A sample that couldn't be read is a gap in the line, never a zero.
import { h } from "../../dockside/dom";
import { fmt } from "../../dockside/format";
import { MATERIALS } from "../items";
import type { Chain2, MaterialId } from "../types";
import type { Ctx } from "./store";

/** The offline port's clock (mock.ts): `debug.advance` moves it, `ambient` lets that time happen. */
export interface PortClock {
  ambient(seconds: number): void;
  debug: { advance(hours: number): void };
}
export const canFastForward = (chain: Chain2): chain is Chain2 & PortClock =>
  chain.network === "mock" && typeof (chain as Partial<PortClock>).ambient === "function" && typeof (chain as Partial<PortClock>).debug?.advance === "function";

/** The materials whose price is drawn: the two common parts, the heavy one and the rare one. */
export const PRICED: readonly MaterialId[] = ["copper", "chips", "fuel", "core"];

export interface WeekSample {
  /** Hours since the fast-forward began. */
  hour: number;
  /** The best price a vendor pays for each drawn material; a material no open vendor buys is absent. */
  bids: Partial<Record<MaterialId, number>>;
  moss: number;
  ines: number;
  /** How many of the two vendors can't cover another purchase. */
  shut: number;
  harbormaster: number;
  posture: string;
  supply: number;
  gunsBuilt: number;
  gunsDestroyed: number;
}

/** One reading of the port. Null when any view fails: a partial reading would draw a false line. */
export async function sampleNow(chain: Chain2, hour: number): Promise<WeekSample | null> {
  try {
    const [vendors, hm, eco] = await Promise.all([chain.vendors(), chain.harbormaster(), chain.economy()]);
    const bids: WeekSample["bids"] = {};
    for (const v of vendors) {
      if (!v.open) continue;
      for (const q of v.bids) if (PRICED.includes(q.tokenId as MaterialId)) bids[q.tokenId as MaterialId] = Math.max(bids[q.tokenId as MaterialId] ?? 0, q.price);
    }
    const scrip = (id: string) => vendors.find((v) => v.id === id)?.scrip;
    const moss = scrip("moss");
    const ines = scrip("ines");
    if (moss == null || ines == null) return null;
    return { hour, bids, moss, ines, shut: vendors.filter((v) => !v.open).length, harbormaster: hm.balance, posture: hm.posture, supply: eco.scripSupply, gunsBuilt: eco.weaponsBuilt, gunsDestroyed: eco.weaponsDestroyed };
  } catch {
    return null;
  }
}

export interface WeekOptions {
  /** Simulated hours to run (a week). Each step is one hour: the offline port plays at most an hour at a time. */
  hours?: number;
  /** Real milliseconds a step takes: 168 one-hour steps at 357 ms is a minute. */
  stepMs?: number;
  onSample?: (sample: WeekSample | null, hour: number) => void;
  signal?: { aborted: boolean };
  sleep?: (ms: number) => Promise<void>;
}

/** Runs the week. Answers every reading in order, the starting one first; a failed reading is null in its place. */
export async function runWeek(chain: Chain2 & PortClock, opts: WeekOptions = {}): Promise<(WeekSample | null)[]> {
  const hours = opts.hours ?? 168;
  const step = 1;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const out: (WeekSample | null)[] = [];
  const read = async (hour: number) => {
    const s = await sampleNow(chain, hour);
    out.push(s);
    opts.onSample?.(s, hour);
  };
  await read(0);
  for (let hour = step; hour <= hours; hour += step) {
    if (opts.signal?.aborted) break;
    chain.debug.advance(step);
    chain.ambient(step * 3600);
    await read(hour);
    await sleep(opts.stepMs ?? 357);
  }
  return out;
}

/** What changed across the readings, in the plain numbers the panel prints. */
export function weekSummary(samples: readonly (WeekSample | null)[]) {
  const got = samples.filter((s): s is WeekSample => !!s);
  if (got.length < 2) return null;
  const first = got[0];
  const last = got[got.length - 1];
  let shutHours = 0;
  let postureChanges = 0;
  for (let i = 0; i < got.length; i++) {
    if (got[i].shut > 0) shutHours++;
    if (i && got[i].posture !== got[i - 1].posture) postureChanges++;
  }
  const range = (id: MaterialId) => {
    const xs = got.map((s) => s.bids[id]).filter((x): x is number => x != null);
    return xs.length ? { lo: Math.min(...xs), hi: Math.max(...xs) } : null;
  };
  return {
    hours: last.hour - first.hour,
    supply: last.supply - first.supply,
    gunsBuilt: last.gunsBuilt - first.gunsBuilt,
    gunsDestroyed: last.gunsDestroyed - first.gunsDestroyed,
    shutHours,
    postureChanges,
    ranges: Object.fromEntries(PRICED.map((id) => [id, range(id)])) as Record<MaterialId, { lo: number; hi: number } | null>,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// The panel.

interface Series {
  name: string;
  /** A fixed slot: colour and dash go with the thing drawn, not with its place in a list. */
  slot: 0 | 1 | 2 | 3;
  at(s: WeekSample): number | undefined;
}
const DASH = ["", "7 4", "2 4", "9 3 2 3"];
const NS = "http://www.w3.org/2000/svg";
const svgEl = (tag: string, attrs: Record<string, string | number>) => {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
};

/** One line chart on one scale. Gaps (a failed reading, or a material nobody is buying) break the line. */
function chart(title: string, unit: string, series: Series[], total: number) {
  const W = 520;
  const H = 150;
  const PAD = { l: 34, r: 8, t: 8, b: 18 };
  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, class: "d2-week-svg", role: "img", "aria-label": title });
  const legend = h("ul", { class: "d2-week-legend" });
  const tip = h("p", { class: "d2-week-tip", "aria-hidden": "true" });
  const el = h("figure", { class: "d2-week-chart" }, h("figcaption", null, h("b", null, title), h("i", null, unit)), svg, legend, tip);
  let samples: (WeekSample | null)[] = [];
  const x = (hour: number) => PAD.l + ((W - PAD.l - PAD.r) * hour) / total;

  function draw(next: (WeekSample | null)[]) {
    samples = next;
    const values = samples.flatMap((s) => (s ? series.map((k) => k.at(s)).filter((v): v is number => v != null) : []));
    const top = Math.max(10, ...values) * 1.08;
    const y = (v: number) => PAD.t + (H - PAD.t - PAD.b) * (1 - v / top);
    svg.replaceChildren();
    for (const frac of [0, 0.5, 1]) {
      const gy = y(top * frac * 0.926);
      svg.append(svgEl("line", { x1: PAD.l, x2: W - PAD.r, y1: gy, y2: gy, class: "d2-week-grid" }));
      const t = svgEl("text", { x: PAD.l - 5, y: gy + 3, class: "d2-week-axis", "text-anchor": "end" });
      t.textContent = fmt(Math.round(top * frac * 0.926));
      svg.append(t);
    }
    for (let day = 0; day <= total / 24; day++) {
      const t = svgEl("text", { x: x(day * 24), y: H - 4, class: "d2-week-axis", "text-anchor": day === 0 ? "start" : day * 24 >= total ? "end" : "middle" });
      t.textContent = day === 0 ? "now" : `day ${day}`;
      svg.append(t);
    }
    legend.replaceChildren();
    for (const k of series) {
      let d = "";
      let pen = false;
      let last: number | undefined;
      for (const s of samples) {
        const v = s ? k.at(s) : undefined;
        if (s == null || v == null) {
          pen = false;
          continue;
        }
        d += `${pen ? "L" : "M"}${x(s.hour).toFixed(1)} ${y(v).toFixed(1)}`;
        pen = true;
        last = v;
      }
      if (d) svg.append(svgEl("path", { d, class: "d2-week-line", "data-slot": k.slot, "stroke-dasharray": DASH[k.slot] }));
      const key = svgEl("svg", { viewBox: "0 0 26 6", class: "d2-week-key" });
      key.append(svgEl("line", { x1: 0, x2: 26, y1: 3, y2: 3, class: "d2-week-line", "data-slot": k.slot, "stroke-dasharray": DASH[k.slot] }));
      legend.append(h("li", null, key as unknown as Node, h("span", null, k.name), h("b", null, last == null ? "unknown" : fmt(Math.round(last)))));
    }
  }

  // Hover: the reading under the pointer, in words.
  svg.addEventListener("pointermove", (e) => {
    const box = svg.getBoundingClientRect();
    const hour = Math.round((((e.clientX - box.left) / box.width) * W - PAD.l) / ((W - PAD.l - PAD.r) / total));
    const s = samples.find((q) => q?.hour === hour);
    if (!s) return void (tip.textContent = "");
    tip.textContent = `Day ${Math.floor(hour / 24) + 1}, hour ${hour % 24}: ${series.map((k) => `${k.name} ${k.at(s) == null ? "not buying" : fmt(Math.round(k.at(s)!))}`).join(" · ")}`;
  });
  svg.addEventListener("pointerleave", () => (tip.textContent = ""));
  return { el, draw };
}

export function weekPanel(ctx: Ctx, opts: Pick<WeekOptions, "hours" | "stepMs" | "sleep"> = {}): { el: HTMLElement } {
  const el = h("section", { class: "d2-week", "aria-label": "Fast-forward a week" });
  const chain = ctx.chain;
  if (!canFastForward(chain)) {
    const link = h("a", { href: `${location.pathname}?game=v2&mock=1&stash=rich` }, "Open Practice");
    el.append(h("p", { class: "d2-week-off" }, h("b", null, "Fast-forward a week"), " runs in Practice, where the port's clock can be moved. The chain's can't. ", link));
    return { el };
  }
  const HOURS = opts.hours ?? 168;
  const prices = chart(
    "What the vendors pay",
    "scrip a unit, best bid",
    PRICED.map((id, i) => ({ name: MATERIALS[id].name, slot: i as 0 | 1 | 2 | 3, at: (s) => s.bids[id] })),
    HOURS,
  );
  const wallets = chart(
    "Who holds the money",
    "scrip",
    [
      { name: "Moss", slot: 0, at: (s) => s.moss },
      { name: "Ines", slot: 1, at: (s) => s.ines },
      { name: "The Harbormaster", slot: 3, at: (s) => s.harbormaster },
    ],
    HOURS,
  );
  const go = h("button", { class: "btn primary d2-week-go", type: "button" }, "Fast-forward a week");
  const status = h("p", { class: "d2-week-status", role: "status" }, "A week of raids, trades and repricing, played in about a minute. Nothing is scripted.");
  const body = h("div", { class: "d2-week-body", hidden: "" }, prices.el, wallets.el);
  el.append(h("div", { class: "d2-week-bar" }, h("div", null, h("h3", null, "Fast-forward a week"), status), go), body);

  let running: { aborted: boolean } | null = null;
  go.onclick = async () => {
    if (running) return void (running.aborted = true);
    const signal = (running = { aborted: false });
    const samples: (WeekSample | null)[] = [];
    body.hidden = false;
    go.textContent = "Stop";
    await runWeek(chain, {
      ...opts,
      hours: HOURS,
      signal,
      onSample(s, hour) {
        samples.push(s);
        prices.draw(samples);
        wallets.draw(samples);
        status.textContent = `Day ${Math.min(7, Math.floor(hour / 24) + 1)} of 7 · hour ${hour % 24}${s ? "" : " · this hour couldn't be read"}`;
        if (hour % 6 === 0) void ctx.refresh("vendors", "harbormaster", "economy", "recent", "exportPrices"); // the rest of the dock moves with it
      },
    });
    const sum = weekSummary(samples);
    status.textContent = sum
      ? `${signal.aborted ? "Stopped" : "A week"} later (${sum.hours} hours): scrip in existence ${sum.supply >= 0 ? "+" : "−"}${fmt(Math.abs(sum.supply))}, ${fmt(sum.gunsBuilt)} guns built, ${fmt(sum.gunsDestroyed)} destroyed, a vendor out of money for ${fmt(sum.shutHours)} hours, the Harbormaster changed its mind ${sum.postureChanges === 1 ? "once" : `${fmt(sum.postureChanges)} times`}.`
      : "The week couldn't be read.";
    go.textContent = "Run another week";
    running = null;
    void ctx.refresh("vendors", "harbormaster", "economy", "recent", "exportPrices");
  };
  return { el };
}
