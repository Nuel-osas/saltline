// The gun card: the dock's hero, used on every screen. A gun is shown as what it is: a frame, the grade it rolled,
// its picture, six stats each sitting somewhere inside the frame's band (the band's ends are printed, so a good
// roll can be seen to be good), its condition, its four mod slots, its serial, its history in one line and what the
// contract says it is worth. Where it is (stash, market, wreck, impound) is stamped on it in plain words.
import { h } from "../../dockside/dom";
import { fmt } from "../../dockside/format";
import { CONDITION, effective, FRAMES, ISSUE, MODS, STAT_KEYS } from "../items";
import type { FrameId, Grade, ModId, Stats, Weapon, WeaponState } from "../types";
import { gunArt } from "./gunart";
import { scripEl } from "./store";

type StatKey = keyof Stats;
const LOWER_IS_BETTER: StatKey[] = ["recoil", "reload"];
export const STAT_LABEL: Record<StatKey, string> = { damage: "Damage", rpm: "Fire rate", mag: "Magazine", recoil: "Recoil", reload: "Reload", range: "Range" };
const STAT_UNIT: Record<StatKey, string> = { damage: "", rpm: "", mag: "", recoil: "%", reload: "%", range: "m" };

export const STATE_WORDS: Record<WeaponState, string> = {
  held: "In the stash",
  raid: "Out on a raid",
  listed: "Listed on the market",
  vendor: "On the rack",
  wreck: "In a wreck",
  impound: "Impounded",
};

/** The same, short enough for a rack tile. */
export const STATE_SHORT: Record<WeaponState, string> = { held: "In stash", raid: "On a raid", listed: "Listed", vendor: "For sale", wreck: "In a wreck", impound: "Impounded" };

export const SLOTS: { slot: "magazine" | "barrel" | "muzzle" | "optic"; short: string }[] = [
  { slot: "magazine", short: "Mag" },
  { slot: "barrel", short: "Barrel" },
  { slot: "muzzle", short: "Muzzle" },
  { slot: "optic", short: "Optic" },
];
export const modInSlot = (mods: readonly ModId[], slot: string): ModId | null => mods.find((m) => MODS[m].slot === slot) ?? null;

/** The frame's short name: "Longshore" from "PAC-9 Longshore". */
export const frameWord = (f: FrameId) => FRAMES[f].name.split(" ").slice(1).join(" ");
export const frameModel = (f: FrameId) => FRAMES[f].name.split(" ")[0];

/** 0–100: how good the value is inside its band (for recoil and reload, lower is better). */
export function bandPct(frame: FrameId, k: StatKey, v: number): number {
  const [lo, hi] = FRAMES[frame].bands[k];
  if (hi === lo) return 100;
  const t = ((v - lo) * 100) / (hi - lo);
  return Math.max(0, Math.min(100, Math.round(LOWER_IS_BETTER.includes(k) ? 100 - t : t)));
}

const times = (n: number) => (n === 1 ? "once" : n === 2 ? "twice" : `${n} times`);

/** `Built by ROOK · 14 extractions · 3 owners · recovered once`. The player's own guns say `Built by YOU`. */
export function historyLine(w: Weapon, me?: string | null): string {
  const parts = [`Built by ${me && w.maker === me ? "YOU" : w.makerCallsign}`];
  parts.push(w.extractions === 0 ? (w.raids === 0 ? "never over the fence" : "no extractions yet") : `${fmt(w.extractions)} extraction${w.extractions === 1 ? "" : "s"}`);
  parts.push(`${fmt(w.owners)} owner${w.owners === 1 ? "" : "s"}`);
  if (w.recovered > 0) parts.push(`recovered ${times(w.recovered)}`);
  return parts.join(" · ");
}

function statRow(frame: FrameId | null, k: StatKey, rolled: number, eff: number): HTMLElement {
  const lower = LOWER_IS_BETTER.includes(k);
  const band = frame ? FRAMES[frame].bands[k] : null;
  const pct = frame ? bandPct(frame, k, rolled) : 0;
  // The bar runs from the band's worst end to its best, so "further right" always means "better".
  const worst = band ? (lower ? band[1] : band[0]) : null;
  const best = band ? (lower ? band[0] : band[1]) : null;
  const diff = eff - rolled;
  const better = lower ? diff < 0 : diff > 0;
  return h(
    "div",
    { class: `d2-stat${band ? "" : " plain"}`, "data-stat": k, "data-v": rolled, "data-eff": eff, "data-lo": band?.[0] ?? null, "data-hi": band?.[1] ?? null, "data-pct": band ? pct : null },
    h("span", { class: "d2-stat-k" }, STAT_LABEL[k]),
    h("i", { class: "d2-stat-end" }, worst ?? ""),
    h("span", { class: "d2-stat-track" }, band ? h("i", { class: "d2-stat-fill", style: `width:${pct}%` }) : null, band ? h("i", { class: "d2-stat-pin", style: `left:${pct}%` }) : null),
    h("i", { class: "d2-stat-end best" }, best ?? ""),
    h("b", { class: "d2-stat-v" }, `${fmt(eff)}${STAT_UNIT[k]}`),
    diff ? h("em", { class: `d2-stat-d ${better ? "up" : "down"}`, title: better ? "From its mods" : "From wear or its mods" }, `${diff > 0 ? "+" : "−"}${Math.abs(diff)}`) : h("em", { class: "d2-stat-d" }),
    // On a narrow card the two ends are printed together, worst to best, after the figure.
    h("i", { class: "d2-stat-band" }, band ? `${worst}–${best}` : ""),
  );
}

export function conditionEl(condition: number): HTMLElement {
  const state = condition <= 0 ? "dead" : condition < CONDITION.worn ? "worn" : "ok";
  const pips = Array.from({ length: 10 }, (_, i) => h("i", { class: condition > i * 10 ? (condition >= (i + 1) * 10 ? "on" : "half") : "" }));
  return h(
    "div",
    { class: "d2-cond", "data-cond": condition, "data-state": state },
    h("span", { class: "d2-cond-k" }, "Condition"),
    h("span", { class: "d2-cond-pips", "aria-hidden": "true" }, ...pips),
    h("b", null, String(condition)),
    state === "ok" ? null : h("em", null, state === "dead" ? "Scrap only" : "Worn"),
  );
}

export function slotsEl(mods: readonly ModId[]): HTMLElement {
  return h(
    "div",
    { class: "d2-slots" },
    ...SLOTS.map(({ slot, short }) => {
      const m = modInSlot(mods, slot);
      return h("span", { class: `d2-slot${m ? "" : " empty"}`, "data-slot": slot, "data-mod": m, title: m ? `${MODS[m].name}: ${MODS[m].line}` : `${short}: empty` }, h("i", null, short), h("b", null, m ? MODS[m].name : "Empty"));
    }),
  );
}

export const gradeStamp = (grade: Grade) => h("span", { class: "d2-grade", "data-grade": grade, "aria-label": `Grade ${grade}` }, h("b", null, grade), h("i", null, "Grade"));

export interface CardOpts {
  me?: string | null;
  /** A price shown in place of the appraisal's prominence (a listing's or a vendor's). */
  price?: { label: string; amount: number } | null;
  /** The state tag's words, when the caller knows more ("Listed · 1,400"). */
  tag?: string;
  /** Recent sale prices for this frame and grade. null: couldn't be read. Left out: not shown. */
  sales?: number[] | null;
  actions?: (Node | null | false)[];
  selected?: boolean;
  hero?: boolean;
  /** Under the frame's name. */
  line?: string;
}

/** The full card for one gun. */
export function gunCard(w: Weapon, o: CardOpts = {}): HTMLElement {
  const eff = effective(w);
  const acts = (o.actions ?? []).filter(Boolean) as Node[];
  return h(
    "article",
    {
      class: `d2-gun${o.hero ? " hero" : ""}${o.selected ? " sel" : ""}`,
      "data-serial": w.serial,
      "data-frame": w.frame,
      "data-grade": w.grade,
      "data-state": w.state,
      "aria-label": `${FRAMES[w.frame].name}, grade ${w.grade}, ${w.serial}`,
    },
    h(
      "header",
      { class: "d2-gun-h" },
      h("div", { class: "d2-gun-id" }, h("span", { class: "d2-gun-model" }, frameModel(w.frame)), h("h4", { class: "d2-gun-name" }, frameWord(w.frame)), h("span", { class: "d2-gun-line" }, o.line ?? FRAMES[w.frame].line)),
      gradeStamp(w.grade),
    ),
    h("div", { class: "d2-gun-art" }, gunArt(w.frame, w.mods), h("span", { class: "d2-serial" }, w.serial), h("span", { class: "d2-state", "data-state": w.state }, o.tag ?? STATE_WORDS[w.state])),
    h("div", { class: "d2-stats" }, ...STAT_KEYS.map((k) => statRow(w.frame, k, w.stats[k], eff[k]))),
    h("div", { class: "d2-gun-kit" }, conditionEl(w.condition), slotsEl(w.mods)),
    h("p", { class: "d2-history" }, historyLine(w, o.me)),
    o.sales !== undefined
      ? h(
          "p",
          { class: "d2-sales", "data-unknown": o.sales === null ? "1" : null },
          h("span", null, `Last ${frameWord(w.frame)} ${w.grade} sales`),
          o.sales === null ? h("b", { class: "d2-unk" }, "unknown") : h("b", null, o.sales.length ? o.sales.map(fmt).join(" · ") : "none yet"),
        )
      : null,
    h(
      "footer",
      { class: "d2-gun-f" },
      h("div", { class: "d2-gun-val" }, h("span", null, "Appraised"), scripEl(w.value, "val")),
      o.price ? h("div", { class: "d2-gun-price" }, h("span", null, o.price.label), scripEl(o.price.amount, "price")) : null,
      acts.length ? h("div", { class: "d2-gun-acts" }, ...acts) : null,
    ),
  );
}

/** The issue rifle's card: plain, unsellable, never lost, and the worst gun in the game. */
export function issueCard(o: { hero?: boolean; selected?: boolean } = {}): HTMLElement {
  return h(
    "article",
    { class: `d2-gun issue${o.hero ? " hero" : ""}${o.selected ? " sel" : ""}`, "data-serial": "issue", "data-frame": "issue", "data-state": "held", "aria-label": `${ISSUE.name}, the issue rifle` },
    h(
      "header",
      { class: "d2-gun-h" },
      h("div", { class: "d2-gun-id" }, h("span", { class: "d2-gun-model" }, "PAC-9"), h("h4", { class: "d2-gun-name" }, "Issue"), h("span", { class: "d2-gun-line" }, "Port Authority property. Everyone gets one. Nobody wants it.")),
      h("span", { class: "d2-grade none", "aria-label": "No grade" }, h("b", null, "–"), h("i", null, "No grade")),
    ),
    h("div", { class: "d2-gun-art" }, gunArt("issue"), h("span", { class: "d2-serial" }, "No serial"), h("span", { class: "d2-state", "data-state": "issue" }, "Always yours")),
    h("div", { class: "d2-stats" }, ...STAT_KEYS.map((k) => statRow(null, k, ISSUE.stats[k], ISSUE.stats[k]))),
    h("div", { class: "d2-gun-kit" }, h("div", { class: "d2-cond plain" }, h("span", { class: "d2-cond-k" }, "Condition"), h("b", null, "Doesn’t wear")), h("div", { class: "d2-slots" }, h("span", { class: "d2-slot empty wide" }, h("i", null, "Mods"), h("b", null, "Takes none")))),
    h("p", { class: "d2-history" }, "Issued at the gate · can’t be sold · can’t be lost"),
    h("footer", { class: "d2-gun-f" }, h("div", { class: "d2-gun-val" }, h("span", null, "Appraised"), h("span", { class: "d2-scrip val" }, h("b", null, "0"), h("i", null, "unsellable")))),
  );
}

export interface TileOpts {
  selected?: boolean;
  /** The line under the name (default: serial and where it is). */
  sub?: string;
  /** The figure on the right (default: the appraisal). */
  figure?: Node | null;
  onclick?: () => void;
  disabled?: boolean;
  k?: string;
}

/** The small card for a rack: enough to recognise the gun and pick it. */
export function gunTile(w: Weapon, o: TileOpts = {}): HTMLElement {
  return h(
    o.onclick ? "button" : "div",
    {
      class: `d2-tile${o.selected ? " sel" : ""}`,
      type: o.onclick ? "button" : null,
      "data-serial": w.serial,
      "data-frame": w.frame,
      "data-grade": w.grade,
      "data-state": w.state,
      "data-k": o.k ?? null,
      "aria-pressed": o.onclick ? String(!!o.selected) : null,
      disabled: o.disabled || null,
      onclick: o.onclick ?? null,
    },
    h("span", { class: "d2-tile-g", "data-grade": w.grade }, w.grade),
    h("span", { class: "d2-tile-n" }, h("b", null, frameWord(w.frame)), h("i", null, o.sub ?? `${w.serial} · ${STATE_SHORT[w.state]}`)),
    h("span", { class: "d2-tile-art" }, gunArt(w.frame, w.mods)),
    h("span", { class: "d2-tile-c", "data-state": w.condition <= 0 ? "dead" : w.condition < CONDITION.worn ? "worn" : "ok" }, h("i", { style: `width:${w.condition}%` })),
    h("span", { class: "d2-tile-v" }, o.figure ?? fmt(w.value)),
  );
}

export function issueTile(o: TileOpts = {}): HTMLElement {
  return h(
    "button",
    { class: `d2-tile issue${o.selected ? " sel" : ""}`, type: "button", "data-serial": "issue", "data-k": o.k ?? null, "aria-pressed": String(!!o.selected), onclick: o.onclick ?? null },
    h("span", { class: "d2-tile-g none" }, "–"),
    h("span", { class: "d2-tile-n" }, h("b", null, "Issue rifle"), h("i", null, "Can’t be lost or sold")),
    h("span", { class: "d2-tile-art" }, gunArt("issue")),
    h("span", { class: "d2-tile-c plain" }),
    h("span", { class: "d2-tile-v dim" }, "plain"),
  );
}

// ---------------------------------------------------------------------------------------------------------------
// The build reveal: the six bars sweep and land one at a time, the grade stamps down, the serial is engraved, and
// the card says who built it.

export const REVEAL_STEPS: string[] = [...STAT_KEYS, "grade", "serial", "maker"];

const sleep = (ms: number) => (ms > 0 ? new Promise<void>((r) => setTimeout(r, ms)) : Promise.resolve());

/** Puts a card into its rolling state: every bar sweeping, no grade, no serial, no maker yet. */
export function prepareReveal(card: HTMLElement) {
  card.classList.add("reveal");
  card.dataset.step = "rolling";
  // Nothing on the card gives the roll away early: the grade (and its gilt) and the appraisal wait their turn.
  card.dataset.rolled = card.dataset.grade ?? "";
  delete card.dataset.grade;
  const val = card.querySelector<HTMLElement>(".d2-gun-val .d2-scrip b");
  if (val) {
    val.dataset.final = val.textContent ?? "";
    val.textContent = "· · ·";
  }
  for (const s of card.querySelectorAll<HTMLElement>(".d2-stat")) s.classList.add("rolling");
  const frame = card.dataset.frame as FrameId;
  const spin = setInterval(() => {
    const rolling = card.querySelectorAll<HTMLElement>(".d2-stat.rolling");
    if (!rolling.length) return clearInterval(spin);
    for (const s of rolling) {
      const [lo, hi] = FRAMES[frame].bands[s.dataset.stat as StatKey];
      const v = s.querySelector(".d2-stat-v");
      if (v) v.textContent = String(lo + Math.floor(Math.random() * (hi - lo + 1)));
    }
  }, 70);
  setTimeout(() => clearInterval(spin), 60_000);
  const serial = card.querySelector<HTMLElement>(".d2-serial");
  if (serial) serial.textContent = "";
  const hist = card.querySelector<HTMLElement>(".d2-history");
  if (hist) hist.textContent = "On the bench…";
  return card;
}

export interface RevealOpts {
  /** Ms per step; 0 lands everything at once. */
  ms: number;
  me?: string | null;
  onStep?: (step: string) => void;
}

/** Lands a prepared card on the gun that was built, in order: six stats, the grade, the serial, the maker. */
export async function revealBuild(card: HTMLElement, w: Weapon, o: RevealOpts): Promise<void> {
  const eff = effective(w);
  for (const k of STAT_KEYS) {
    await sleep(o.ms);
    const s = card.querySelector<HTMLElement>(`.d2-stat[data-stat="${k}"]`);
    if (s) {
      s.classList.remove("rolling");
      s.classList.add("landed");
      const v = s.querySelector(".d2-stat-v");
      if (v) v.textContent = `${fmt(eff[k])}${STAT_UNIT[k]}`;
    }
    card.dataset.step = k;
    o.onStep?.(k);
  }
  await sleep(o.ms * 1.4);
  card.dataset.grade = w.grade;
  card.querySelector(".d2-grade")?.classList.add("stamped");
  const val = card.querySelector<HTMLElement>(".d2-gun-val .d2-scrip b");
  if (val) val.textContent = fmt(w.value);
  card.dataset.step = "grade";
  o.onStep?.("grade");
  await sleep(o.ms * 1.6);
  const serial = card.querySelector<HTMLElement>(".d2-serial");
  if (serial) {
    serial.classList.add("engraving");
    for (let i = 1; i <= w.serial.length; i++) {
      serial.textContent = w.serial.slice(0, i);
      await sleep(o.ms / 6);
    }
    serial.classList.remove("engraving");
    serial.classList.add("engraved");
  }
  card.dataset.step = "serial";
  o.onStep?.("serial");
  await sleep(o.ms);
  const hist = card.querySelector<HTMLElement>(".d2-history");
  if (hist) {
    hist.textContent = historyLine(w, o.me);
    hist.classList.add("landed");
  }
  card.dataset.step = "maker";
  card.classList.add("revealed");
  o.onStep?.("maker");
}
