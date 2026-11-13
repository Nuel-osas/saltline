// LOADOUT, the dock's first screen: your guns on the rack, the one you're taking in the middle, what else you carry,
// and the two things a Breacher should know before the fence: what is lost if they die, and what the Harbormaster
// has already put on the invoice.
import { h } from "../../dockside/dom";
import { fmt, UNKNOWN } from "../../dockside/format";
import { CONSUMABLES, INVOICE, invoiceStart, RAID } from "../items";
import type { Amounts, ConsumableId, Loadout, Weapon } from "../types";
import { frameWord, gunCard, gunTile, issueCard, issueTile } from "./guncard";
import { emptyLine, head, okv, painter, plural, type Ctx } from "./store";

const KIT: { id: ConsumableId; key: "plates" | "charges" | "mags"; max: number }[] = [
  { id: "plate", key: "plates", max: RAID.maxPlates },
  { id: "charge", key: "charges", max: RAID.maxCharges },
  { id: "ammo", key: "mags", max: RAID.maxMags },
];

/** A gun can go over the fence only from the stash, and only if it still works. */
export const canTake = (w: Weapon) => w.state === "held" && w.condition > 0;

/** The loadout the contract would accept: a gun that is in the stash, and no more gear than is held or allowed.
 *  An unread stash or balance changes nothing it can't check (the contract is the judge then), and adds nothing. */
export function clampLoadout(l: Loadout, weapons: Weapon[] | null, balances: Amounts | null): Loadout {
  const out: Loadout = { weapon: l.weapon ?? null, plates: l.plates | 0, charges: l.charges | 0, mags: l.mags | 0 };
  if (out.weapon && weapons && !weapons.some((w) => w.serial === out.weapon && canTake(w))) out.weapon = null;
  for (const { id, key, max } of KIT) {
    const held = balances ? (balances[id] ?? 0) : out[key];
    out[key] = Math.max(0, Math.min(out[key], max, held));
  }
  return out;
}

/** What makes up the invoice at the fence. Every part is read off items.ts's `invoiceStart` as it stands, so a
 *  change to the rule there (a cap on the entry charge, another share of arrears) shows here without this file
 *  repeating the arithmetic. `capped`: one more extraction would add nothing. */
export function invoiceParts(extractions: number, arrears: number): { entry: number; history: number; carried: number; total: number; capped: boolean } {
  const entry = invoiceStart(0, 0);
  const history = invoiceStart(extractions, 0) - entry;
  const total = invoiceStart(extractions, arrears);
  return { entry, history, carried: total - entry - history, total, capped: extractions > 0 && invoiceStart(extractions + 1, 0) === invoiceStart(extractions, 0) };
}

/** "half your arrears", or the percentage when the rule isn't a half. */
export const carryShare = () => (INVOICE.carryInPct === 50 ? "half your arrears" : `${INVOICE.carryInPct}% of your arrears`);

export function createLoadout(ctx: Ctx, deploy: () => void) {
  const el = h("div", { class: "d2-loadout" });

  function set(patch: Partial<Loadout>) {
    ctx.v2.loadout = clampLoadout({ ...ctx.v2.loadout, ...patch }, okv(ctx.reads.weapons), okv(ctx.reads.balances));
    ctx.render();
  }

  function rack(weapons: Weapon[] | null, picked: string | null) {
    const tiles: Node[] = [];
    if (weapons) {
      for (const w of weapons) {
        const ok = canTake(w);
        tiles.push(
          gunTile(w, {
            k: `pick:${w.serial}`,
            selected: picked === w.serial,
            disabled: !ok,
            sub: ok ? undefined : w.state === "held" ? `${w.serial} · Scrap only` : undefined,
            onclick: () => set({ weapon: w.serial }),
          }),
        );
      }
    } else tiles.push(emptyLine(ctx.reads.weapons.s === "loading" ? "Opening your locker…" : `Your guns: ${UNKNOWN}. The locker can't be read right now.`, ctx.reads.weapons.s === "unknown"));
    tiles.push(issueTile({ k: "pick:issue", selected: picked === null, onclick: () => set({ weapon: null }) }));
    const n = weapons?.length ?? null;
    return h("section", { class: "d2-rack", "aria-label": "Your guns" }, head("Your rack", n == null ? null : plural(n, "gun")), h("div", { class: "d2-rack-list", "data-scroll": "rack" }, ...tiles));
  }

  function kit(l: Loadout, balances: Amounts | null) {
    return h(
      "div",
      { class: "d2-kit" },
      head("Carry", "used up, or lost with the gun"),
      ...KIT.map(({ id, key, max }) => {
        const held = balances ? (balances[id] ?? 0) : null;
        const v = l[key];
        const cap = Math.min(max, held ?? v);
        return h(
          "div",
          { class: "d2-step", "data-kit": id },
          h(
            "div",
            { class: "d2-step-n" },
            h("b", null, CONSUMABLES[id].name, h("span", { class: `d2-step-held${held == null ? " unk" : ""}`, "data-unknown": held == null ? "1" : null }, held == null ? `hold ${UNKNOWN}` : `hold ${fmt(held)}`)),
            h("i", null, id === "ammo" ? `${RAID.issuedMags} issued, up to ${max} more` : CONSUMABLES[id].line),
          ),
          h(
            "div",
            { class: "d2-stepper" },
            h("button", { class: "d2-b sq", type: "button", "data-k": `kit:${id}:-`, "aria-label": `One fewer ${CONSUMABLES[id].name}`, disabled: v <= 0 || null, onclick: () => set({ [key]: v - 1 } as Partial<Loadout>) }, "−"),
            h("output", { class: "d2-step-v", "aria-label": `${CONSUMABLES[id].name} taken` }, String(v)),
            h("button", { class: "d2-b sq", type: "button", "data-k": `kit:${id}:+`, "aria-label": `One more ${CONSUMABLES[id].name}`, disabled: v >= cap || null, onclick: () => set({ [key]: v + 1 } as Partial<Loadout>) }, "+"),
          ),
        );
      }),
    );
  }

  function risk(w: Weapon | null) {
    return h(
      "div",
      { class: `d2-risk${w ? "" : " safe"}`, "data-risk": w ? w.serial : "issue" },
      h("span", { class: "d2-risk-k" }, "At risk"),
      h("p", { class: "d2-risk-t" }, w ? `If you die: this ${frameWord(w.frame)} and everything you carry` : "If you die: only what you carry. The issue rifle always comes back."),
      h("p", { class: "d2-risk-s" }, w ? `Machines: a wreck, ${RAID.wreckHours} h, finders keepers. The Bailiff: the impound, ${RAID.impoundHours} h.` : "Nothing to lose, and the worst gun in the yard."),
    );
  }

  function fence() {
    const p = ctx.reads.profile;
    const hm = okv(ctx.reads.harbormaster);
    const prof = okv(p);
    const parts = prof ? invoiceParts(prof.extractions, prof.arrears) : null;
    const start = parts ? parts.total : null;
    const bailiff = hm?.bailiffAt ?? null;
    const gap = start != null && bailiff != null ? bailiff - start : null;
    const scale = Math.max((bailiff ?? INVOICE.bailiff) * 1.12, (start ?? 0) * 1.05);
    const at = (n: number) => `${Math.min(100, (n / scale) * 100).toFixed(1)}%`;
    return h(
      "div",
      { class: "d2-fence", "data-start": start, "data-gap": gap },
      h("span", { class: "d2-risk-k" }, "On the invoice at the fence"),
      h(
        "div",
        { class: "d2-fence-n" },
        start == null ? h("b", { class: "d2-unk", "data-unknown": "1" }, UNKNOWN) : h("b", null, fmt(start)),
        h(
          "span",
          { class: gap != null && gap <= 200 ? "hot" : "" },
          gap == null ? `Bailiff: ${bailiff == null ? UNKNOWN : `at ${fmt(bailiff)}`}` : gap <= 0 ? "The Bailiff is sent the moment you cross" : `${fmt(gap)} from the Bailiff`,
        ),
      ),
      h(
        "div",
        { class: "d2-meter", "aria-hidden": "true" },
        start != null ? h("i", { class: "d2-meter-fill", style: `width:${at(start)}` }) : null,
        hm ? h("i", { class: "d2-meter-mark", style: `left:${at(hm.secondNoticeAt)}`, "data-l": "2nd notice" }) : null,
        bailiff != null ? h("i", { class: "d2-meter-mark bailiff", style: `left:${at(bailiff)}`, "data-l": `Bailiff ${fmt(bailiff)}` }) : null,
      ),
      prof && parts
        ? h(
            "p",
            { class: "d2-fence-rows", "data-entry": parts.entry, "data-history": parts.history, "data-carried": parts.carried },
            h("span", null, h("b", null, fmt(parts.entry)), " entry"),
            h("span", null, h("b", null, `+${fmt(parts.history)}`), ` ${plural(prof.extractions, "extraction")} on file${parts.capped ? " (capped)" : ""}`),
            h("span", null, h("b", null, `+${fmt(parts.carried)}`), ` ${carryShare()}`),
          )
        : null,
    );
  }

  const paint = painter(
    el,
    () => [ctx.reads.weapons, ctx.reads.balances, ctx.reads.profile, ctx.reads.harbormaster, ctx.v2.loadout, ctx.me()],
    () => {
      const weapons = okv(ctx.reads.weapons);
      const balances = okv(ctx.reads.balances);
      // What the raid will take is always what the contract would accept, as far as it can be read.
      const l = (ctx.v2.loadout = clampLoadout(ctx.v2.loadout ?? { weapon: null, plates: 0, charges: 0, mags: 0 }, weapons, balances));
      const w = l.weapon ? (weapons?.find((x) => x.serial === l.weapon) ?? null) : null;
      return [
        rack(weapons, w ? w.serial : null),
        h("section", { class: "d2-taking", "aria-label": "The gun you're taking" }, head("Taking over the fence", w ? w.serial : "No serial"), w ? gunCard(w, { hero: true, me: ctx.me() }) : issueCard({ hero: true })),
        h(
          "section",
          { class: "d2-side", "aria-label": "What you carry and what it risks" },
          kit(l, balances),
          risk(w),
          fence(),
          h("button", { class: "btn primary d2-go", type: "button", "data-k": "deploy", onclick: deploy }, "Deploy"),
        ),
      ];
    },
  );

  return { el, update: paint };
}
