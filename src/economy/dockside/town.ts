// The Town: the story's home in the Dockside (docs/STORY.md, "The Open Ledger"). The town across the water is drawn
// as a skyline whose windows come on with its districts; under it the three chapters as a timeline, the two districts'
// deliveries, the Quartermaster's client and the Harbormaster's strength. It is all one read, chain.town(). When that
// read fails, or the contract has no town yet, the numbers go and the tab says the Dock Office ledger is unreachable:
// never a zero, never a guessed act.
//
// The client is a secret until the ledger names him, so nothing here says "Harbormaster" about the Quartermaster's
// buyer, or what a core does once sold, before `client.revealed`.
import { CHAPTERS } from "../story/copy";
import type { District, TownView } from "../types";
import { okv, type Ctx } from "./ctx";
import { fill, h, text, toggle } from "./dom";
import { accountUrl, fmt, stamp } from "./format";

export const UNREACHABLE = "The Dock Office ledger is unreachable";
export const DILEMMA = "Every core sold to the Quartermaster rebuilds it. Every player fights what it fields.";
export const REVEAL = "The Quartermaster's client is the Harbormaster.";
export const MOTTO = "We let one machine keep the books once. Never again.";

interface ActCopy {
  n: 1 | 2 | 3;
  /** "Chapter 1": the act's label, and `chip` its short form on the Town tab. */
  label: string;
  chip: string;
  /** The chapter's title, after a shipping document (docs/STORY.md → Chapters). */
  name: string;
  /** The chapter card's line. Shown once the chapter has begun: the third's would name the client early. */
  line: string;
  /** What every player sees once the chapter has begun (docs/STORY.md → Chapters). */
  sees: string;
  /** What starts it, shown while it's still ahead. */
  needs: string;
}

const SEES: Record<1 | 2 | 3, Pick<ActCopy, "sees" | "needs">> = {
  1: { sees: "The town across the water is dark. Ines is rationing.", needs: "" },
  2: {
    sees: "The clinic and the generators are lit. The lights are back across the water.",
    needs: "When the clinic and the generators are lit",
  },
  3: {
    sees: "The Harbormaster is buying its own cores back through a broker, to rebuild.",
    needs: "When the lights are on and 8 relay cores have gone to the Quartermaster",
  },
};

/** The town's acts as chapters; the titles and lines are the story's own (story/copy.ts). */
export const ACTS: ActCopy[] = CHAPTERS.map((c) => ({
  n: c.n,
  label: `Chapter ${c.n}`,
  chip: `Ch ${c.n}`,
  name: c.title,
  line: c.line,
  ...SEES[c.n],
}));

const DISTRICT_COPY: Record<District["id"], { name: string; unit: string; note: string; lit: string }> = {
  clinic: { name: "The clinic", unit: "meds", note: "Every crate of meds sold at the dock counts.", lit: "The clinic's lights are back on." },
  generators: { name: "The generators", unit: "fuel cells", note: "Every fuel cell sold at the dock counts.", lit: "The generators are turning again." },
};

/** When an act began, if the ledger says: Act II when the second district lit, Act III at the reveal. */
export function actReachedAt(t: TownView, act: 1 | 2 | 3): number | null {
  if (act === 2) {
    if (t.act < 2) return null;
    const times = t.districts.map((d) => d.litAt);
    return times.length && times.every((x) => x != null) ? Math.max(...(times as number[])) : null;
  }
  if (act === 3) return t.client.revealed ? t.client.revealedAt : null;
  return null;
}

export const dronesLine = (n: number) => `+${n} drone${n === 1 ? "" : "s"} a wave`;

// ---- the skyline: the town across the water, drawn here (the game downloads no art) ----

const SVGNS = "http://www.w3.org/2000/svg";
function s<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>, ...kids: (Node | string)[]): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVGNS, tag);
  for (const k in attrs) el.setAttribute(k, String(attrs[k]));
  for (const c of kids) el.append(c);
  return el;
}

const VW = 720;
const VH = 240;
const HZ = 156; // the horizon: the sea wall on the far side

/** The town's blocks, from a fixed seed so every player sees the same town. */
function blocks() {
  let x = 0x5a17;
  const r = () => ((x = (Math.imul(x, 1103515245) + 12345) >>> 0) / 4294967296);
  const out: { x: number; w: number; h: number; kind: "t" | "c" | "g" }[] = [];
  let at = 150;
  let clinic = false;
  let hall = false;
  while (at < VW - 6) {
    if (!clinic && at > 230) {
      clinic = true;
      out.push({ x: 262, w: 60, h: 66, kind: "c" });
      at = 326;
      continue;
    }
    if (!hall && at > 520) {
      hall = true;
      out.push({ x: 552, w: 72, h: 34, kind: "g" });
      at = 628;
      continue;
    }
    const w = 16 + Math.floor(r() * 26);
    const mid = 1 - Math.min(1, Math.abs(at + w / 2 - 430) / 300);
    const hgt = Math.round(20 + r() * 34 + mid * 46);
    out.push({ x: at, w, h: hgt, kind: "t" });
    at += w + (r() < 0.3 ? 2 + Math.floor(r() * 5) : 0);
  }
  return { list: out, r };
}

function skyline(): SVGSVGElement {
  const { list, r } = blocks();
  const defs = s(
    "defs",
    {},
    s(
      "linearGradient",
      { id: "dk-tw-sky", x1: 0, y1: 0, x2: 0, y2: 1 },
      s("stop", { offset: "0", "stop-color": "#090c0f" }),
      s("stop", { offset: ".7", "stop-color": "#151d23" }),
      s("stop", { offset: "1", "stop-color": "#24303a" }),
    ),
    s("radialGradient", { id: "dk-tw-red", cx: ".5", cy: ".5", r: ".5" }, s("stop", { offset: "0", "stop-color": "#ff5a40", "stop-opacity": ".5" }), s("stop", { offset: "1", "stop-color": "#ff5a40", "stop-opacity": "0" })),
    s("radialGradient", { id: "dk-tw-glow", cx: ".5", cy: "1", r: ".6" }, s("stop", { offset: "0", "stop-color": "#ffb347", "stop-opacity": ".55" }), s("stop", { offset: "1", "stop-color": "#ffb347", "stop-opacity": "0" })),
    s("linearGradient", { id: "dk-tw-sea", x1: 0, y1: 0, x2: 0, y2: 1 }, s("stop", { offset: "0", "stop-color": "#0d1215" }), s("stop", { offset: "1", "stop-color": "#050708" })),
    s("linearGradient", { id: "dk-tw-fade", x1: 0, y1: 0, x2: 0, y2: 1 }, s("stop", { offset: "0", "stop-color": "#fff", "stop-opacity": ".9" }), s("stop", { offset: ".75", "stop-color": "#fff", "stop-opacity": "0" })),
    s("mask", { id: "dk-tw-mask" }, s("rect", { x: 0, y: HZ, width: VW, height: VH - HZ, fill: "url(#dk-tw-fade)" })),
    s("filter", { id: "dk-tw-blur", x: "-20%", y: "-20%", width: "140%", height: "140%" }, s("feGaussianBlur", { stdDeviation: "1.1 2.2" })),
  );
  const town = s("g", { class: "town" });
  const lights = s("g", { class: "lights" });
  const mirror = s("g", { class: "mirror", mask: "url(#dk-tw-mask)", filter: "url(#dk-tw-blur)" });
  for (const b of list) {
    const top = HZ - b.h;
    town.append(s("rect", { x: b.x, y: top, width: b.w, height: b.h, class: `blk ${b.kind}` }));
    if (b.kind === "c") {
      // the clinic's sign: a cross on the roof
      town.append(s("rect", { x: b.x + b.w / 2 - 2, y: top - 16, width: 4, height: 13, class: "sign" }), s("rect", { x: b.x + b.w / 2 - 6.5, y: top - 11.5, width: 13, height: 4, class: "sign" }));
    }
    if (b.kind === "g") {
      // the generator hall's two stacks, each with a lamp
      for (const [dx, sh] of [
        [12, 44],
        [30, 56],
      ])
        town.append(s("rect", { x: b.x + dx, y: top - sh, width: 7, height: sh, class: "blk g" }), s("circle", { cx: b.x + dx + 3.5, cy: top - sh - 3, r: 2.2, class: "lamp" }));
    }
    const cols = Math.floor((b.w - 6) / 7);
    const rows = Math.floor((b.h - 8) / 9);
    const x0 = b.x + (b.w - (cols * 7 - 4)) / 2;
    for (let i = 0; i < cols; i++)
      for (let j = 0; j < rows; j++) {
        const roll = r();
        const on = b.kind === "c" || b.kind === "g" ? roll < 0.85 : roll < 0.52;
        const candle = b.kind === "t" && roll > 0.965;
        const cls = `w ${b.kind}${on ? " on" : ""}${candle ? " candle" : ""}`;
        const x = x0 + i * 7;
        const y = top + 6 + j * 9;
        const delay = `transition-delay:${Math.floor(r() * 1600)}ms`;
        lights.append(s("rect", { x, y, width: 3, height: 4, class: cls, style: delay }));
        if (on || candle) {
          // its reflection: flipped about the sea wall, squashed, stretched into a streak
          const ry = HZ + (HZ - (y + 4)) * 0.55;
          mirror.append(s("rect", { x: x - 0.5, y: ry, width: 4, height: 9, class: cls, style: delay }));
        }
      }
  }
  const labels = s(
    "g",
    { class: "lbls" },
    s("text", { x: 292, y: HZ - 92, class: "lbl c", "text-anchor": "middle" }, "CLINIC"),
    s("text", { x: 599, y: HZ - 46, class: "lbl g", "text-anchor": "start" }, "GENERATORS"),
  );
  const ripples = s("g", { class: "rip" });
  for (let k = 0; k < 7; k++) {
    const y = HZ + 8 + k * k * 1.6 + k * 4;
    ripples.append(s("rect", { x: -40 + ((k * 97) % 60), y, width: VW + 80, height: 1, class: `rl r${k % 3}` }));
  }
  // our side: the pier at Berth 4, and the port's cranes. In Act III their lamps are the Harbormaster's eyes.
  const cranes = s("g", { class: "cranes" });
  const crane = (x: number, top: number, boom: number, sc: number) => {
    const leg = VH - 10 - top;
    cranes.append(
      s("rect", { x, y: top, width: 5 * sc, height: leg, class: "cr" }),
      s("rect", { x: x + 34 * sc, y: top, width: 5 * sc, height: leg, class: "cr" }),
      s("rect", { x: x - 10 * sc, y: top - 6 * sc, width: (44 + boom) * sc, height: 6 * sc, class: "cr" }),
      s("rect", { x: x + 4 * sc, y: top + 6 * sc, width: 14 * sc, height: 10 * sc, class: "cr" }),
      s("path", { d: `M${x + 19 * sc} ${top - 6 * sc} L${x + 19 * sc} ${top - 34 * sc} L${x + (44 + boom) * sc - 10 * sc} ${top - 6 * sc}`, class: "stay" }),
      s("circle", { cx: x + 19 * sc, cy: top - 37 * sc, r: 3.6 * sc, class: "eye" }),
    );
  };
  crane(54, 108, 52, 0.66);
  crane(118, 66, 92, 1);
  // a few stars over the town, and the pier's edge with its bollards in the foreground
  const stars = s("g", { class: "stars" });
  for (let k = 0; k < 46; k++) stars.append(s("circle", { cx: Math.floor(r() * VW), cy: Math.floor(r() * (HZ - 70)), r: r() < 0.15 ? 0.9 : 0.55, class: `st s${k % 3}` }));
  const pier = s("g", { class: "pier" }, s("rect", { x: 0, y: VH - 10, width: VW, height: 10, class: "quay" }));
  for (let x = 24; x < VW; x += 96) pier.append(s("rect", { x, y: VH - 16, width: 7, height: 7, rx: 2, class: "quay" }));
  return s(
    "svg",
    { class: "dk-tw-sky", viewBox: `0 0 ${VW} ${VH}`, preserveAspectRatio: "xMidYMax slice", role: "img", "aria-hidden": "true" },
    defs,
    s("rect", { x: 0, y: 0, width: VW, height: HZ, fill: "url(#dk-tw-sky)" }),
    stars,
    s("ellipse", { cx: 440, cy: HZ, rx: 330, ry: 90, fill: "url(#dk-tw-glow)", class: "glow" }),
    // Act III: the Harbormaster's red haze over the port, as strong as it is
    s("ellipse", { cx: 140, cy: 70, rx: 230, ry: 120, fill: "url(#dk-tw-red)", class: "red" }),
    town,
    lights,
    labels,
    s("rect", { x: 0, y: HZ, width: VW, height: VH - HZ, fill: "url(#dk-tw-sea)" }),
    s("rect", { x: 0, y: HZ - 1, width: VW, height: 2, class: "wall" }),
    mirror,
    ripples,
    cranes,
    pier,
  );
}

// ---- the panel ----

export function createTown(ctx: Ctx) {
  // the acts
  const acts = ACTS.map((a) => {
    const when = h("span", { class: "dk-tw-act-w" });
    const el = h(
      "li",
      { class: "dk-tw-act", "data-n": a.n, "data-state": "next" },
      h("span", { class: "dk-tw-act-k" }, h("i", { "aria-hidden": "true" }), a.label, h("em", null, "Now")),
      h("b", { class: "dk-tw-act-n" }, a.name),
      when,
    );
    return { a, el, when };
  });
  const sees = h("p", { class: "dk-tw-sees" });

  // the skyline and its districts
  const status = h("b", { class: "dk-tw-status" });
  const view = h("div", { class: "dk-tw-view" }, skyline(), h("div", { class: "dk-tw-cap" }, h("span", null, "Across the water"), status));
  const districts = (["clinic", "generators"] as const).map((id) => {
    const c = DISTRICT_COPY[id];
    const lamp = h("span", { class: "dk-tw-lamp" }, h("i", { "aria-hidden": "true" }), h("span"));
    const cells = h("span", { class: "dk-tw-cells", "aria-hidden": "true" });
    const count = h("b", { class: "dk-tw-count" });
    const line = h("span", { class: "dk-tw-dl" });
    const el = h(
      "div",
      { class: "dk-tw-d", "data-d": id, "data-lit": "false" },
      h("div", { class: "dk-tw-d-h" }, h("h4", null, c.name), lamp),
      h("div", { class: "dk-tw-d-bar" }, cells, count),
      h("p", { class: "dk-tw-d-t" }, line, h("span", { class: "dk-tw-note" }, c.note)),
    );
    return { id, el, lamp, cells, count, line };
  });

  // the client
  const clientK = h("div", { class: "dk-tw-k" });
  const clientH = h("h4", { class: "dk-tw-client-h" });
  const pips = h("span", { class: "dk-tw-pips", "aria-hidden": "true" });
  const clientLine = h("p", { class: "dk-tw-client-l" });
  const clientNote = h("p", { class: "dk-tw-client-n" });
  const client = h("section", { class: "dk-tw-client", "aria-label": "The client", "data-revealed": "false" }, clientK, clientH, pips, clientLine, clientNote);

  // the Harbormaster
  const hmState = h("span", { class: "dk-tw-hm-s" });
  const strength = h("b", { class: "dk-tw-hm-n" });
  const drones = h("span", { class: "dk-tw-hm-d" });
  const fillBar = h("i", { class: "dk-tw-hm-fill" });
  const meter = h(
    "div",
    { class: "dk-tw-meter", role: "meter", "aria-label": "The Harbormaster's strength", "aria-valuemin": "0", "aria-valuemax": "100" },
    h("span", { class: "dk-tw-meter-bar" }, fillBar, ...[25, 50, 75].map((v) => h("i", { class: "dk-tw-tick", style: `left:${v}%` }))),
    h("span", { class: "dk-tw-scale", "aria-hidden": "true" }, ...[0, 1, 2, 3, 4].map((n) => h("span", { style: `left:${n * 25}%` }, n === 0 ? "0" : `+${n}`))),
  );
  const hmLine = h("p", { class: "dk-tw-hm-l" });
  const hmNote = h("p", { class: "dk-tw-hm-x" });
  const hm = h(
    "section",
    { class: "dk-tw-hm", "aria-label": "The Harbormaster" },
    h("div", { class: "dk-tw-k" }, h("span", null, "The Harbormaster"), hmState),
    h("div", { class: "dk-tw-hm-row" }, h("span", { class: "dk-tw-hm-big" }, strength, h("small", null, "/100")), drones),
    meter,
    hmLine,
    hmNote,
  );

  // the open ledger
  const link = h("span", { class: "dk-tw-link" });
  const foot = h(
    "footer",
    { class: "dk-tw-foot" },
    h("i", { class: "dk-tw-dot", "aria-hidden": "true" }),
    h("p", null, h("b", null, "Written on the open ledger."), " Every delivery counts for every player, and nobody can quietly change the count, not even the Dock Office."),
    link,
  );

  const body = h(
    "div",
    { class: "dk-tw-body" },
    h("header", { class: "dk-tw-head" }, h("ol", { class: "dk-tw-acts", "aria-label": "The town's chapters" }, ...acts.map((x) => x.el)), sees),
    h("div", { class: "dk-tw-left" }, view, h("div", { class: "dk-tw-ds" }, ...districts.map((d) => d.el))),
    h("div", { class: "dk-tw-right" }, client, hm),
    foot,
  );
  const notice = h("div", { class: "dk-tw-notice", role: "status" });
  const el = h("section", { class: "dk-town", "aria-label": "The town", "data-state": "loading", "data-act": "0" }, body, notice);

  let linked = "";
  function paintLink() {
    const url = accountUrl(ctx.chain.network, ctx.chain.contractId);
    const key = `${ctx.chain.network}|${ctx.chain.contractId}`;
    if (linked === key) return;
    linked = key;
    fill(
      link,
      url
        ? h("a", { href: url, target: "_blank", rel: "noopener" }, `${ctx.chain.contractId} on NEAR testnet ↗`)
        : h("span", null, ctx.chain.network === "testnet" ? "NEAR testnet" : "The mock ledger, offline"),
    );
  }

  function update() {
    paintLink();
    const read = ctx.reads.town;
    const t = okv(read);
    el.dataset.state = read.s === "loading" ? "loading" : t ? "ok" : "unknown";
    body.hidden = !t;
    notice.hidden = !!t;
    if (!t) {
      el.dataset.act = "0";
      if (read.s === "loading") fill(notice, h("p", { class: "dk-tw-wait" }, h("i"), "Reading the Dock Office ledger…"));
      else if (!notice.querySelector(".dk-tw-unreach"))
        fill(
          notice,
          h(
            "div",
            { class: "dk-tw-unreach" },
            h("div", { class: "m-k" }, "Dock Office · Open Ledger"),
            h("h3", null, UNREACHABLE),
            h("p", null, "The town's numbers are unknown until it answers. Nothing here is shown as zero."),
            h("button", { class: "dk-b", type: "button", onclick: () => void ctx.refresh("town") }, "Try again"),
          ),
        );
      return;
    }
    el.dataset.act = String(t.act);
    const lit = (id: District["id"]) => t.districts.find((d) => d.id === id)?.lit === true;
    el.dataset.clinic = lit("clinic") ? "lit" : "dark";
    el.dataset.gen = lit("generators") ? "lit" : "dark";
    el.style.setProperty("--hm", String(t.harbormaster.strength / 100));

    // the chapters
    for (const x of acts) {
      const state = x.a.n < t.act ? "past" : x.a.n === t.act ? "now" : "next";
      x.el.dataset.state = state;
      x.el.setAttribute("aria-current", state === "now" ? "step" : "false");
      const at = actReachedAt(t, x.a.n);
      text(x.when, x.a.n === 1 ? (t.act === 1 ? "Since the town was impounded" : "The town was impounded") : state === "next" ? x.a.needs : at != null ? `Reached ${stamp(at)}` : "Reached");
    }
    const now = ACTS[t.act - 1];
    if (sees.dataset.act !== String(t.act)) {
      sees.dataset.act = String(t.act);
      fill(sees, h("span", { class: "dk-tw-line" }, now.line), " ", now.sees);
    }
    text(status, t.act >= 2 ? "Lights on the water" : lit("clinic") ? "The clinic is lit" : lit("generators") ? "The generators are turning" : "Dark");

    // districts
    for (const d of districts) {
      const v = t.districts.find((x) => x.id === d.id);
      d.el.hidden = !v;
      if (!v) continue;
      const c = DISTRICT_COPY[d.id];
      d.el.dataset.lit = String(v.lit);
      text(d.lamp.lastChild as HTMLElement, v.lit ? "Lit" : "Dark");
      text(d.count, `${fmt(v.have)}/${fmt(v.need)}`);
      text(d.line, `${fmt(v.have)}/${fmt(v.need)} ${c.unit} delivered${v.lit && v.litAt != null ? ` · lit ${stamp(v.litAt)}` : ""}`);
      const n = Math.max(1, Math.min(v.need, 40));
      if (d.cells.childElementCount !== n) d.cells.replaceChildren(...Array.from({ length: n }, () => h("i")));
      const filled = Math.min(n, Math.floor((v.have / Math.max(1, v.need)) * n));
      [...d.cells.children].forEach((cell, i) => toggle(cell, "on", i < filled));
      d.el.setAttribute("aria-label", `${c.name}: ${v.have} of ${v.need} ${c.unit} delivered, ${v.lit ? "lit" : "dark"}`);
    }

    // the client
    const cl = t.client;
    client.dataset.revealed = String(cl.revealed);
    if (cl.revealed) {
      fill(clientK, h("span", null, "The client"), h("em", null, cl.revealedAt != null ? `Revealed ${stamp(cl.revealedAt)}` : "Revealed"));
      text(clientH, REVEAL);
      text(clientLine, `Buying its own cores back through a broker, to rebuild. ${fmt(cl.have)} relay cores have gone to it.`);
      text(clientNote, "The Quartermaster still pays better than anyone.");
    } else {
      fill(clientK, h("span", null, "The client"), h("em", null, "Unnamed"));
      text(clientH, "Who is the Quartermaster buying for?");
      text(clientLine, `${fmt(cl.have)}/${fmt(cl.need)} relay cores to the Quartermaster's client`);
      text(clientNote, t.act >= 2 ? `He won't name his client. The ledger will, at ${fmt(cl.need)}.` : "He won't name his client. The ledger will, once the lights are back on.");
    }
    const np = Math.max(1, Math.min(cl.need, 16));
    if (pips.childElementCount !== np) pips.replaceChildren(...Array.from({ length: np }, () => h("i")));
    [...pips.children].forEach((p, i) => toggle(p, "on", i < Math.min(np, cl.have)));

    // the Harbormaster
    const hmv = t.harbormaster;
    text(hmState, cl.revealed ? (hmv.strength > 0 ? "Rebuilding" : "Starved") : "Billing");
    text(strength, String(hmv.strength));
    text(drones, dronesLine(hmv.bonusDrones));
    fillBar.style.width = `${hmv.strength}%`;
    meter.setAttribute("aria-valuenow", String(hmv.strength));
    meter.setAttribute("aria-valuetext", `${hmv.strength} of 100, ${dronesLine(hmv.bonusDrones)}`);
    text(hmLine, cl.revealed ? DILEMMA : "It holds the town as unclaimed cargo and bills every Breacher who comes near. It has never been paid.");
    text(hmNote, cl.revealed ? "Unfed, it halves every 12 hours. Starve it, and every wave gets lighter." : "Blind for minutes at a time while the Breachers keep cutting its uplinks.");
  }

  update();
  return { el, update };
}
