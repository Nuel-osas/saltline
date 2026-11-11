// "A week on the docks": chain.simulate(168, 20, seed) played back over about a minute on a canvas drawn here, no
// chart library. One lane per broker with its bids, shuttered stretches hatched, a day ruler, callouts where a
// broker shuts or reopens, a scrub bar, pause and 1×/4×. The data mapping (hours → x, closed bands, events) is pure
// and exported so it can be tested without a canvas.
import { BROKERS } from "../items";
import type { BrokerId, CargoId, SimPoint } from "../types";
import type { Ctx } from "./ctx";
import { fill, h, reducedMotion, text } from "./dom";
import { fmt, UNKNOWN } from "./format";

export const WEEK_HOURS = 168;
export const WEEK_TRADERS = 20;
/** Seconds the whole week takes at 1×. */
export const WEEK_SECONDS = 60;

export const CARGO_COLOR: Record<CargoId, string> = {
  copper: "#d2622a",
  chips: "#a9b6bf",
  meds: "#9cc4d8",
  fuel: "#ffb347",
  core: "#e8e4da",
};
const ALARM = "255, 90, 64";
const SIGNAL = "#ffb347";
const BONE = "#e8e4da";

// ---- pure mapping ----

export interface Band {
  from: number;
  to: number;
}
export interface WeekEvent {
  hour: number;
  broker: BrokerId;
  kind: "close" | "reopen";
  scrip: number;
}

/** Linear map from an hour in [h0, h1] to x in [x0, x1]. */
export function hourToX(hour: number, h0: number, h1: number, x0: number, x1: number): number {
  if (h1 <= h0) return x0;
  return x0 + ((hour - h0) / (h1 - h0)) * (x1 - x0);
}

/** Hours a broker spent shuttered, as [from, to) bands. A band still open at the end runs to the last hour. */
export function closedBands(points: SimPoint[], broker: BrokerId): Band[] {
  const out: Band[] = [];
  let from: number | null = null;
  for (const p of points) {
    const b = p.brokers[broker];
    if (!b) continue;
    if (!b.open && from == null) from = p.hour;
    else if (b.open && from != null) {
      out.push({ from, to: p.hour });
      from = null;
    }
  }
  if (from != null && points.length) out.push({ from, to: points[points.length - 1].hour });
  return out;
}

/** Every shut and reopen, in order (a broker that starts shut has no event at hour 0, just a band). */
export function weekEvents(points: SimPoint[]): WeekEvent[] {
  const out: WeekEvent[] = [];
  for (let i = 1; i < points.length; i++)
    for (const id of Object.keys(BROKERS) as BrokerId[]) {
      const a = points[i - 1].brokers[id];
      const b = points[i].brokers[id];
      if (!a || !b || a.open === b.open) continue;
      out.push({ hour: points[i].hour, broker: id, kind: b.open ? "reopen" : "close", scrip: b.scrip });
    }
  return out;
}

/** The value of a broker's bid at a fractional hour, interpolated between the points either side. */
export function bidAt(points: SimPoint[], broker: BrokerId, cargo: CargoId, hour: number): number | null {
  if (!points.length) return null;
  let lo = 0;
  let hi = points.length - 1;
  if (hour <= points[0].hour) return points[0].brokers[broker]?.bids[cargo] ?? null;
  if (hour >= points[hi].hour) return points[hi].brokers[broker]?.bids[cargo] ?? null;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (points[mid].hour <= hour) lo = mid;
    else hi = mid;
  }
  const a = points[lo].brokers[broker]?.bids[cargo];
  const b = points[hi].brokers[broker]?.bids[cargo];
  if (a == null || b == null) return a ?? b ?? null;
  const f = (hour - points[lo].hour) / (points[hi].hour - points[lo].hour || 1);
  return a + (b - a) * f;
}

/** The point at or just before an hour. */
export function pointAt(points: SimPoint[], hour: number): SimPoint | null {
  let best: SimPoint | null = null;
  for (const p of points) {
    if (p.hour > hour) break;
    best = p;
  }
  return best ?? points[0] ?? null;
}

/** A broker's bid range across the week, padded and rounded out to tens. */
export function bidRange(points: SimPoint[], broker: BrokerId): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (const p of points)
    for (const c of BROKERS[broker].buys) {
      const v = p.brokers[broker]?.bids[c];
      if (v == null) continue;
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
  if (!Number.isFinite(lo)) return [0, 100];
  const pad = Math.max(5, (hi - lo) * 0.12);
  return [Math.max(0, Math.floor((lo - pad) / 10) * 10), Math.ceil((hi + pad) / 10) * 10];
}

export const clock = (hour: number) => {
  const hr = Math.max(0, hour);
  return `Day ${Math.floor(hr / 24) + 1} · ${String(Math.floor(hr % 24)).padStart(2, "0")}:00`;
};

// ---- drawing ----

interface Lane {
  id: BrokerId;
  name: string;
  cargos: CargoId[];
  bands: Band[];
  range: [number, number];
}
export interface WeekModel {
  points: SimPoint[];
  h0: number;
  h1: number;
  lanes: Lane[];
  events: WeekEvent[];
}

export function buildModel(points: SimPoint[]): WeekModel {
  const ids = Object.keys(BROKERS) as BrokerId[];
  return {
    points,
    h0: points[0]?.hour ?? 0,
    h1: points[points.length - 1]?.hour ?? WEEK_HOURS,
    lanes: ids.map((id) => ({ id, name: BROKERS[id].name, cargos: BROKERS[id].buys, bands: closedBands(points, id), range: bidRange(points, id) })),
    events: weekEvents(points),
  };
}

const F_DISPLAY = "'Big Shoulders Display', Impact, sans-serif";
const F_LABEL = "'Barlow Condensed', 'Arial Narrow', sans-serif";
const F_MONO = "'IBM Plex Mono', ui-monospace, monospace";

function spaced(g: CanvasRenderingContext2D, px: number) {
  if ("letterSpacing" in g) (g as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = `${px}px`;
}

export function drawWeek(g: CanvasRenderingContext2D, m: WeekModel, t: number, W: number, H: number) {
  g.clearRect(0, 0, W, H);
  const narrow = W < 560;
  const L = narrow ? 8 : 14;
  const R = narrow ? 40 : 56;
  const TOP = 30;
  const GAP = narrow ? 8 : 12;
  const n = m.lanes.length;
  const laneH = (H - TOP - GAP * (n - 1) - 4) / n;
  const x0 = L;
  const x1 = W - R;
  const X = (hr: number) => hourToX(hr, m.h0, m.h1, x0, x1);
  const tx = X(t);

  // ruler: day blocks, six-hour ticks
  g.font = `600 11px ${F_LABEL}`;
  spaced(g, 2.2);
  g.textBaseline = "middle";
  for (let d = Math.floor(m.h0 / 24); d * 24 < m.h1; d++) {
    const a = X(Math.max(m.h0, d * 24));
    const b = X(Math.min(m.h1, (d + 1) * 24));
    g.fillStyle = d % 2 ? "rgba(232,228,218,.035)" : "rgba(232,228,218,.07)";
    g.fillRect(a, 4, b - a, 18);
    g.fillStyle = d * 24 <= t ? "rgba(232,228,218,.82)" : "rgba(232,228,218,.38)";
    g.fillText(narrow ? `D${d + 1}` : `DAY ${d + 1}`, a + 6, 13);
    g.fillStyle = "rgba(232,228,218,.16)";
    g.fillRect(a, TOP, 1, H - TOP);
    for (let q = 1; q < 4; q++) {
      const x = X(d * 24 + q * 6);
      if (x < b) g.fillRect(x, 18, 1, 4);
    }
  }

  m.lanes.forEach((lane, i) => {
    const y0 = TOP + i * (laneH + GAP);
    const head = 24;
    const py0 = y0 + head;
    const py1 = y0 + laneH - 6;
    const [lo, hi] = lane.range;
    const Y = (v: number) => py1 - ((v - lo) / (hi - lo || 1)) * (py1 - py0);
    const p = pointAt(m.points, t);
    const b = p?.brokers[lane.id];

    // plate
    g.fillStyle = "rgba(11,13,15,.72)";
    g.fillRect(x0, y0, x1 - x0, laneH);
    g.fillStyle = "rgba(232,228,218,.14)";
    g.fillRect(x0, y0, x1 - x0, 1);

    // grid
    g.font = `500 10px ${F_MONO}`;
    spaced(g, 0);
    g.textBaseline = "middle";
    for (let k = 0; k <= 2; k++) {
      const v = lo + ((hi - lo) * k) / 2;
      const y = Y(v);
      g.fillStyle = "rgba(232,228,218,.06)";
      g.fillRect(x0, Math.round(y), x1 - x0, 1);
      g.fillStyle = "rgba(141,154,163,.55)";
      g.fillText(String(Math.round(v)), x0 + 6, y - 7);
    }

    // shuttered bands, revealed up to the playhead
    g.save();
    g.beginPath();
    g.rect(x0, py0 - 4, Math.max(0, tx - x0), py1 - py0 + 8);
    g.clip();
    for (const band of lane.bands) {
      const a = X(band.from);
      const z = X(band.to);
      g.fillStyle = `rgba(${ALARM}, .1)`;
      g.fillRect(a, py0 - 4, z - a, py1 - py0 + 8);
      g.strokeStyle = `rgba(${ALARM}, .22)`;
      g.lineWidth = 1;
      g.beginPath();
      for (let s = a - (py1 - py0); s < z; s += 7) {
        g.moveTo(s, py1 + 4);
        g.lineTo(s + (py1 - py0) + 8, py0 - 4);
      }
      g.stroke();
      g.fillStyle = `rgba(${ALARM}, .9)`;
      g.fillRect(a, py0 - 4, z - a, 2);
    }
    g.restore();

    // bid lines: solid while open, dashed and dim while shut
    const shutAt = (hr: number) => lane.bands.some((bd) => hr >= bd.from && hr < bd.to);
    for (const c of lane.cargos) {
      const col = CARGO_COLOR[c];
      g.lineWidth = 2;
      g.lineJoin = "round";
      let prev: { x: number; y: number; shut: boolean } | null = null;
      for (const pt of m.points) {
        if (pt.hour > t) break;
        const v = pt.brokers[lane.id]?.bids[c];
        if (v == null) continue;
        const cur = { x: X(pt.hour), y: Y(v), shut: shutAt(pt.hour) };
        if (prev) seg(g, prev, cur, col, prev.shut);
        prev = cur;
      }
      const vt = bidAt(m.points, lane.id, c, t);
      if (prev && vt != null) seg(g, prev, { x: tx, y: Y(vt) }, col, prev.shut);
    }

    // callouts
    let lastX = -1e9;
    let stack = 0;
    for (const ev of m.events) {
      if (ev.broker !== lane.id || ev.hour > t) continue;
      const x = X(ev.hour);
      stack = x - lastX < 92 ? (stack + 1) % 3 : 0;
      lastX = x;
      const fresh = t - ev.hour < 10;
      const col = ev.kind === "close" ? `rgba(${ALARM}, 1)` : SIGNAL;
      g.fillStyle = col;
      g.globalAlpha = fresh ? 1 : 0.7;
      g.fillRect(Math.round(x), py0 - 4, 1.5, py1 - py0 + 8);
      const label = ev.kind === "close" ? "SHUTS" : "REOPENS";
      g.font = `700 11px ${F_LABEL}`;
      spaced(g, 1.6);
      const w = g.measureText(label).width + 12;
      const fy = py0 + 2 + stack * 18;
      const fx = Math.min(x + 1, x1 - w);
      g.fillRect(fx, fy, w, 15);
      g.fillStyle = "#0b0d0f";
      g.textBaseline = "middle";
      g.fillText(label, fx + 6, fy + 8);
      if (fresh && !narrow) {
        const k = 1 - (t - ev.hour) / 10;
        g.strokeStyle = col;
        g.globalAlpha = 0.6 * k;
        g.lineWidth = 1.5;
        g.beginPath();
        g.arc(x, py0 + (py1 - py0) / 2, 6 + (1 - k) * 22, 0, Math.PI * 2);
        g.stroke();
      }
      g.globalAlpha = 1;
    }

    // heads + price tags in the right gutter
    const tags: { y: number; v: number; col: string }[] = [];
    for (const c of lane.cargos) {
      const vt = bidAt(m.points, lane.id, c, t);
      if (vt == null) continue;
      const y = Y(vt);
      g.fillStyle = CARGO_COLOR[c];
      g.beginPath();
      g.arc(tx, y, 3.2, 0, Math.PI * 2);
      g.fill();
      tags.push({ y, v: Math.round(vt), col: CARGO_COLOR[c] });
    }
    tags.sort((a, b) => a.y - b.y);
    for (let k = 1; k < tags.length; k++) if (tags[k].y - tags[k - 1].y < 15) tags[k].y = tags[k - 1].y + 15;
    g.font = `500 11px ${F_MONO}`;
    spaced(g, 0);
    for (const tg of tags) {
      g.fillStyle = tg.col;
      g.fillRect(x1 + 2, tg.y - 7, R - 4, 14);
      g.fillStyle = "#0b0d0f";
      g.fillText(String(tg.v), x1 + 6, tg.y);
    }

    // lane head: name, legend, state
    g.textBaseline = "middle";
    g.font = `800 15px ${F_DISPLAY}`;
    spaced(g, 1.5);
    g.fillStyle = BONE;
    g.fillText(lane.name.toUpperCase(), x0 + 8, y0 + 13);
    let lx = x0 + 16 + g.measureText(lane.name.toUpperCase()).width;
    g.font = `600 11px ${F_LABEL}`;
    spaced(g, 1.8);
    for (const c of lane.cargos) {
      g.fillStyle = CARGO_COLOR[c];
      g.fillRect(lx, y0 + 9, 8, 8);
      g.fillStyle = "rgba(232,228,218,.72)";
      g.fillText(c.toUpperCase(), lx + 13, y0 + 13);
      lx += 22 + g.measureText(c.toUpperCase()).width;
    }
    if (b) {
      const st = b.open ? "OPEN" : "SHUT";
      g.font = `700 11px ${F_LABEL}`;
      spaced(g, 2);
      const sw = g.measureText(st).width + 12;
      const fl = narrow ? "" : `FLOAT ${fmt(b.scrip)}`;
      g.font = `500 10px ${F_MONO}`;
      spaced(g, 0);
      const fw = fl ? g.measureText(fl).width + 10 : 0;
      const sx = x1 - sw - 6;
      if (fl) {
        g.fillStyle = "rgba(141,154,163,.9)";
        g.fillText(fl, sx - fw, y0 + 13);
      }
      g.fillStyle = b.open ? "rgba(232,228,218,.12)" : `rgba(${ALARM}, .9)`;
      g.fillRect(sx, y0 + 6, sw, 15);
      g.font = `700 11px ${F_LABEL}`;
      spaced(g, 2);
      g.fillStyle = b.open ? BONE : "#0b0d0f";
      g.fillText(st, sx + 6, y0 + 14);
    }
  });

  // playhead
  g.fillStyle = SIGNAL;
  g.fillRect(Math.round(tx) - 1, 24, 2, H - 24);
  g.font = `600 11px ${F_LABEL}`;
  spaced(g, 1.6);
  const lab = clock(t).toUpperCase();
  const lw = g.measureText(lab).width + 12;
  const lx = Math.max(x0, Math.min(x1 - lw, tx - lw / 2));
  g.fillRect(lx, 2, lw, 18);
  g.fillStyle = "#0b0d0f";
  g.textBaseline = "middle";
  g.fillText(lab, lx + 6, 12);
  spaced(g, 0);
}

function seg(g: CanvasRenderingContext2D, a: { x: number; y: number }, b: { x: number; y: number }, col: string, shut: boolean) {
  g.strokeStyle = col;
  g.globalAlpha = shut ? 0.35 : 1;
  g.setLineDash(shut ? [3, 4] : []);
  g.beginPath();
  g.moveTo(a.x, a.y);
  g.lineTo(b.x, b.y);
  g.stroke();
  g.setLineDash([]);
  g.globalAlpha = 1;
}

// ---- the panel ----

export function createWeek(ctx: Ctx) {
  const canvas = h("canvas", { class: "dk-wk-cv", tabindex: "0", role: "img", "aria-label": "A week of broker bids" });
  const wrap = h("div", { class: "dk-wk-plot" }, canvas);
  const status = h("p", { class: "dk-wk-status", role: "status" });
  const playBtn = h("button", { class: "dk-b solid dk-wk-play", type: "button", "aria-label": "Play", onclick: () => toggle() }, h("i", { class: "dk-ico", "data-ico": "play" }));
  const speeds = [1, 4].map((s) => h("button", { class: "dk-seg-b", type: "button", "aria-pressed": String(s === 1), "data-s": s, onclick: () => setSpeed(s) }, `${s}×`));
  const scrub = h("input", { class: "dk-scrub", type: "range", min: "0", max: String(WEEK_HOURS), step: "0.25", value: "0", "aria-label": "Scrub the week" });
  const readout = h("output", { class: "dk-wk-clock" }, clock(0));
  const again = h("button", { class: "dk-b ghost", type: "button", onclick: () => reseed() }, "Another week");
  const seedT = h("span", { class: "dk-wk-seed" });
  const log = h("ol", { class: "dk-wk-log", "aria-label": "What happened" });
  const el = h(
    "section",
    { class: "dk-week", "aria-label": "A week on the docks" },
    h(
      "header",
      { class: "dk-wk-h" },
      h("div", null, h("h3", { class: "dk-wk-title" }, "A week on the docks"), h("p", { class: "dk-wk-sub" }, `${WEEK_HOURS} hours, ${WEEK_TRADERS} traders, the same pricing rules. Run as a free view call: no wallet, nothing spent.`, " ", seedT)),
      again,
    ),
    h("div", { class: "dk-wk-ctl" }, playBtn, h("div", { class: "dk-seg", role: "group", "aria-label": "Speed" }, ...speeds), scrub, readout),
    h(
      "div",
      { class: "dk-wk-body" },
      wrap,
      h(
        "aside",
        { class: "dk-wk-side" },
        h("div", { class: "dk-hk" }, h("span", null, "Callouts")),
        log,
        status,
        h(
          "dl",
          { class: "dk-wk-key" },
          h("div", null, h("dt", { class: "k-shut", "aria-hidden": "true" }), h("dd", null, "Shuttered: not buying")),
          h("div", null, h("dt", { class: "k-dash", "aria-hidden": "true" }), h("dd", null, "What it would pay while shut")),
          h("div", null, h("dt", { class: "k-tag", "aria-hidden": "true" }), h("dd", null, "Bid at the playhead")),
        ),
      ),
    ),
  );

  let model: WeekModel | null = null;
  let t = 0;
  let playing = false;
  let speed = 1;
  let seed = 4207;
  let raf = 0;
  let last = 0;
  let visible = false;
  let loading = false;
  let shown = -1;

  const rate = () => ((model ? model.h1 - model.h0 : WEEK_HOURS) / WEEK_SECONDS) * speed;

  async function load() {
    if (loading) return;
    loading = true;
    model = null;
    status.dataset.state = "pending";
    text(status, "Running the week… (a free view call)");
    text(seedT, `Seed ${seed}.`);
    fill(log);
    shown = -1;
    try {
      const pts = await ctx.chain.simulate(WEEK_HOURS, WEEK_TRADERS, seed);
      if (!Array.isArray(pts) || pts.length < 2) throw new Error("empty");
      model = buildModel(pts);
      scrub.min = String(model.h0);
      scrub.max = String(model.h1);
      t = model.h0;
      status.dataset.state = "idle";
      text(status, "");
      if (visible) play(!reducedMotion());
      if (reducedMotion()) t = model.h1;
    } catch {
      status.dataset.state = "unknown";
      fill(status, `The week couldn't be run: result ${UNKNOWN}. `, h("button", { class: "dk-b ghost", type: "button", onclick: () => load() }, "Try again"));
    } finally {
      loading = false;
      draw();
    }
  }
  function reseed() {
    seed = (seed * 1103515245 + 12345) % 100000;
    void load();
  }
  function setSpeed(s: number) {
    speed = s;
    for (const b of speeds) b.setAttribute("aria-pressed", String(+b.dataset.s! === s));
  }
  function play(on: boolean) {
    if (!model) return;
    if (on && t >= model.h1) t = model.h0;
    playing = on;
    playBtn.setAttribute("aria-label", on ? "Pause" : t >= model.h1 ? "Replay" : "Play");
    (playBtn.firstChild as HTMLElement).dataset.ico = on ? "pause" : t >= model.h1 ? "replay" : "play";
    if (on && !raf) {
      last = 0;
      raf = requestAnimationFrame(frame);
    }
  }
  const toggle = () => play(!playing);

  function frame(now: number) {
    raf = 0;
    if (!visible || !model) return;
    const dt = last ? Math.min(0.1, (now - last) / 1000) : 0;
    last = now;
    if (playing) {
      t = Math.min(model.h1, t + dt * rate());
      if (t >= model.h1) play(false);
    }
    draw();
    if (playing) raf = requestAnimationFrame(frame);
  }

  function sizeCanvas() {
    const r = wrap.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(r.width));
    const hh = Math.max(1, Math.round(r.height));
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(hh * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(hh * dpr);
    }
    return { w, h: hh, dpr };
  }

  function draw() {
    scrub.value = String(t);
    text(readout, clock(t));
    if (model) {
      const hits = model.events.filter((e) => e.hour <= t);
      if (hits.length !== shown) {
        shown = hits.length;
        fill(
          log,
          ...(hits.length
            ? hits
                .slice()
                .reverse()
                .map((e, i) =>
                  h(
                    "li",
                    { class: `dk-wk-ev ${e.kind}${i === 0 ? " latest" : ""}` },
                    h("time", null, clock(e.hour)),
                    h("b", null, `${BROKERS[e.broker].name} ${e.kind === "close" ? "shuts" : "reopens"}`),
                    h("span", null, e.kind === "close" ? `Float down to ${fmt(e.scrip)}. Players' cargo goes elsewhere.` : `Investors put the float back to ${fmt(e.scrip)}.`),
                  ),
                )
            : [h("li", { class: "dk-empty" }, "Nothing yet. Every broker is trading.")]),
        );
      }
    }
    const g = canvas.getContext ? canvas.getContext("2d") : null;
    if (!g || !model) return;
    const { w, h: hh, dpr } = sizeCanvas();
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawWeek(g, model, t, w, hh);
  }

  scrub.addEventListener("input", () => {
    t = +scrub.value;
    if (playing) play(false);
    draw();
  });
  canvas.addEventListener("keydown", (e) => {
    if (!model) return;
    if (e.code === "Space") toggle();
    else if (e.code === "ArrowRight") t = Math.min(model.h1, t + 6);
    else if (e.code === "ArrowLeft") t = Math.max(model.h0, t - 6);
    else return;
    e.preventDefault();
    draw();
  });
  if (typeof ResizeObserver === "function") new ResizeObserver(() => visible && draw()).observe(wrap);

  return {
    el,
    show() {
      visible = true;
      if (!model && !loading) void load();
      else if (model) {
        draw();
        if (playing) {
          last = 0;
          raf = raf || requestAnimationFrame(frame);
        }
      }
    },
    hide() {
      visible = false;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    },
    /** For the screenshot script and tests. */
    seek(hour: number, pause = true) {
      t = hour;
      if (pause) play(false);
      draw();
    },
    get model() {
      return model;
    },
    update() {},
  };
}
