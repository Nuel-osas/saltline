// THE ARMOURY (Moss's bench): blueprints with their inputs against what you hold, and the bench itself. BUILD is the
// moment the game is about: the six stats sweep and land one at a time, the grade stamps down, the serial is
// engraved, and the card reads "Built by YOU". An existing gun on the bench can be fitted, repaired or scrapped.
import { h } from "../../dockside/dom";
import { fmt, UNKNOWN } from "../../dockside/format";
import { BLUEPRINTS, CONDITION, CONSUMABLES, FRAMES, FRAME_IDS, MODS, MOD_IDS, TOKEN_NAMES } from "../items";
import type { BlueprintId, ConsumableId, FrameId, MaterialId, ModId, Weapon } from "../types";
import { frameWord, gunCard, gunTile, modInSlot, prepareReveal, revealBuild, SLOTS, STATE_WORDS } from "./guncard";
import { actBtn, emptyLine, head, okv, painter, plural, SHORT, type Ctx } from "./store";

const GROUPS: { title: string; ids: BlueprintId[] }[] = [
  { title: "Frames", ids: FRAME_IDS },
  { title: "Mods", ids: MOD_IDS },
  { title: "Kit", ids: ["plate", "charge", "ammo"] },
];
const bpName = (id: BlueprintId) => (id in FRAMES ? FRAMES[id as FrameId].name : TOKEN_NAMES[id as ModId | ConsumableId]);
const bpLine = (id: BlueprintId) => (id in FRAMES ? FRAMES[id as FrameId].line : id in MODS ? MODS[id as ModId].line : CONSUMABLES[id as ConsumableId].line);

const GRADE_LINE: Record<string, string> = {
  A: "An A. Moss doesn't say anything for a while.",
  B: "A good one. It will sell, if you can stand to.",
  C: "Honest work. It will do the job.",
  D: "It shoots. That is the kind thing to say.",
};

/** What a repair to 100 costs: scrip to Moss and copper burned (docs/CONTRACT_V2.md → Fit, repair, scrap). */
export function repairCost(condition: number): { points: number; scrip: number; copper: number } {
  const points = Math.max(0, 100 - condition);
  return { points, scrip: points * CONDITION.scripPerPoint, copper: Math.ceil(points / CONDITION.pointsPerCopper) };
}

type Bench = { mode: "gun"; serial: string | null } | { mode: "build"; frame: FrameId; card: HTMLElement; weapon: Weapon | null; landed: boolean };

export function createArmoury(ctx: Ctx) {
  const bpEl = h("section", { class: "d2-bps", "aria-label": "Blueprints" });
  const benchEl = h("section", { class: "d2-bench", "aria-label": "The bench" });
  const stashEl = h("section", { class: "d2-stash", "aria-label": "Your guns and parts" });
  const el = h("div", { class: "d2-armoury" }, bpEl, benchEl, stashEl);
  let bench: Bench = { mode: "gun", serial: null };
  let confirmScrap: string | null = null;
  let made: string | null = null;

  const mine = () => okv(ctx.reads.weapons);
  /** Whether the inputs and fee are in hand: null when the balance couldn't be read. */
  function canBuild(id: BlueprintId): boolean | null {
    const b = BLUEPRINTS[id];
    let ok = true;
    for (const [m, n] of Object.entries(b.inputs) as [MaterialId, number][]) {
      const held = ctx.holding(m);
      if (held == null) return null;
      if (held < n) ok = false;
    }
    const scrip = ctx.holding("scrip");
    if (scrip == null) return null;
    return ok && scrip >= b.fee;
  }

  // ---- BUILD ----
  function ghost(frame: FrameId): Weapon {
    const bands = FRAMES[frame].bands;
    const mid = (k: keyof typeof bands) => Math.round((bands[k][0] + bands[k][1]) / 2);
    return {
      serial: "",
      frame,
      grade: "C",
      quality: 50,
      stats: { damage: mid("damage"), rpm: mid("rpm"), mag: mid("mag"), recoil: mid("recoil"), reload: mid("reload"), range: mid("range") },
      mods: [],
      condition: 100,
      maker: ctx.me() ?? "",
      makerCallsign: ctx.callsign() ?? "YOU",
      owner: ctx.me() ?? "",
      builtAt: Date.now(),
      raids: 0,
      extractions: 0,
      owners: 1,
      recovered: 0,
      state: "held",
      value: 0,
    };
  }

  async function build(id: BlueprintId) {
    const b = BLUEPRINTS[id];
    made = null;
    confirmScrap = null;
    if (b.kind !== "weapon") {
      await ctx.act({
        key: `build:${id}`,
        settling: `Settling: Moss is making ${b.yields > 1 ? `${b.yields} ${SHORT[id as ModId].toLowerCase()}` : `the ${bpName(id).toLowerCase()}`}…`,
        run: () => ctx.chain.build(id),
        done: () => (made = `Built ${b.yields} × ${bpName(id)}. ${b.kind === "mod" ? "Put a gun on the bench to fit it." : "It's in your kit."}`),
      });
      ctx.render();
      return;
    }
    const frame = id as FrameId;
    const before = bench;
    // The bench shows the frame at once, every bar sweeping, while the build settles.
    const waiting = prepareReveal(gunCard(ghost(frame), { hero: true, me: ctx.me(), tag: "On the bench" }));
    waiting.querySelector(".d2-grade")?.classList.add("unset");
    bench = { mode: "build", frame, card: waiting, weapon: null, landed: false };
    ctx.render();
    let reveal: Promise<void> | null = null;
    const r = await ctx.act({
      key: `build:${id}`,
      settling: `Settling: Moss is building a ${frameWord(frame)}. The roll is the chain's, not hers…`,
      run: () => ctx.chain.build(id),
      done(r) {
        const w = r.weapon;
        if (!w) return `Built a ${frameWord(frame)}.`;
        // The result is in: the same bench, now landing on the gun that was rolled.
        const card = prepareReveal(gunCard(w, { hero: true, me: ctx.me() }));
        const state: Bench = { mode: "build", frame, card, weapon: w, landed: false };
        bench = state;
        paintBench(true);
        reveal = revealBuild(card, w, { ms: ctx.revealMs, me: ctx.me(), onStep: (s) => ctx.emit(s === "grade" ? "ui:click" : "ui:hover") }).then(() => {
          state.landed = true;
          if (bench === state) paintBench(true);
          // The receipt names the grade only once the card has shown it.
          ctx.note("ok", `Built ${w.grade === "A" ? "an" : "a"} ${w.grade}-grade ${frameWord(frame)}, ${w.serial}. Built by you.`);
        });
        return `The build settled. Reading the roll…`;
      },
    });
    if (!r?.weapon) {
      if (bench.mode === "build" && !bench.weapon) bench = before;
      ctx.render();
      return;
    }
    await reveal;
  }

  // ---- the bench with a gun on it: fit, repair, scrap ----
  function work(w: Weapon): HTMLElement {
    if (w.state !== "held") return h("div", { class: "d2-work" }, head("On the bench"), emptyLine(`${STATE_WORDS[w.state]}. It has to be in your stash before Moss will touch it.`));
    const rc = repairCost(w.condition);
    const scrip = ctx.holding("scrip");
    const copper = ctx.holding("copper");
    const short = scrip == null || copper == null ? `Your balance is ${UNKNOWN}` : scrip < rc.scrip ? `${fmt(rc.scrip - scrip)} scrip short` : copper < rc.copper ? "Not enough copper" : null;
    const fits = SLOTS.map(({ slot, short: label }) => {
      const fitted = modInSlot(w.mods, slot);
      const options = MOD_IDS.filter((m) => MODS[m].slot === slot);
      return h(
        "div",
        { class: "d2-fit", "data-slot": slot },
        h("span", { class: "d2-fit-k" }, label),
        fitted
          ? h("span", { class: "d2-fit-on" }, h("b", null, MODS[fitted].name), h("i", null, "fitted for good"))
          : h(
              "span",
              { class: "d2-fit-opts" },
              ...options.map((m) => {
                const held = ctx.holding(m);
                return actBtn(ctx, {
                  k: `fit:${w.serial}:${m}`,
                  label: h("span", null, `Fit ${MODS[m].name.toLowerCase()}`, h("i", null, held == null ? UNKNOWN : `hold ${held}`)),
                  cls: "fit",
                  disabled: !held,
                  why: held ? MODS[m].line : held === 0 ? "You don't hold one. Build it, or buy it from Moss." : null,
                  onclick: () =>
                    void ctx.act({
                      key: `fit:${w.serial}:${m}`,
                      settling: `Settling: fitting the ${MODS[m].name.toLowerCase()} to ${w.serial}…`,
                      run: () => ctx.chain.fit(w.serial, m),
                      done: () => `${MODS[m].name} fitted to ${w.serial}. ${MODS[m].line}.`,
                    }),
                });
              }),
            ),
      );
    });
    return h(
      "div",
      { class: "d2-work" },
      head("Mod slots", "a fitted mod stays with the gun"),
      ...fits,
      head("Repair", "scrip to Moss, copper burned"),
      rc.points === 0
        ? emptyLine("Nothing to repair. It is as it left the bench.")
        : h(
            "div",
            { class: "d2-repair", "data-scrip": rc.scrip, "data-copper": rc.copper },
            h("p", null, `${rc.points} points to 100: `, h("b", null, `${fmt(rc.scrip)} scrip`), " and ", h("b", null, `${rc.copper} copper`), "."),
            actBtn(ctx, {
              k: `repair:${w.serial}`,
              label: `Repair · ${fmt(rc.scrip)} scrip`,
              cls: "solid",
              disabled: !!short,
              why: short,
              onclick: () =>
                void ctx.act({
                  key: `repair:${w.serial}`,
                  settling: `Settling: Moss is repairing ${w.serial}…`,
                  run: () => ctx.chain.repair(w.serial),
                  done: (r) => `${w.serial} repaired to ${r.weapon?.condition ?? 100}. Cost ${r.cost == null ? UNKNOWN : `${fmt(r.cost)} scrip`}.`,
                }),
            }),
            short ? h("span", { class: "d2-why" }, short) : null,
          ),
      head("Scrap", "gone for good"),
      confirmScrap === w.serial
        ? h(
            "div",
            { class: "d2-confirm", role: "alertdialog", "aria-label": "Scrap this gun?" },
            h("p", null, `Scrap ${w.serial}? It is destroyed and can't be brought back. You get ${CONDITION.scrap.copper} copper coil and ${CONDITION.scrap.chips} boxed electronics.`),
            h(
              "div",
              { class: "d2-confirm-b" },
              actBtn(ctx, {
                k: `scrap:${w.serial}`,
                label: "Scrap it",
                cls: "danger",
                onclick: () =>
                  void ctx
                    .act({
                      key: `scrap:${w.serial}`,
                      settling: `Settling: ${w.serial} is going under the press…`,
                      run: () => ctx.chain.scrap(w.serial),
                      done: () => `${w.serial} scrapped: ${CONDITION.scrap.copper} copper and ${CONDITION.scrap.chips} electronics back in your stash.`,
                    })
                    .then((r) => {
                      confirmScrap = null;
                      if (r) bench = { mode: "gun", serial: null };
                      ctx.render();
                    }),
              }),
              h("button", { class: "d2-b", type: "button", "data-k": "scrap:cancel", "data-cancel": "1", onclick: () => ((confirmScrap = null), ctx.render()) }, "Keep it"),
            ),
          )
        : h(
            "div",
            { class: "d2-scrap" },
            h("p", null, `Back to parts: ${CONDITION.scrap.copper} copper, ${CONDITION.scrap.chips} electronics.`),
            h("button", { class: "d2-b ghost", type: "button", "data-k": `scrap-ask:${w.serial}`, onclick: () => ((confirmScrap = w.serial), ctx.render()) }, "Scrap for parts"),
          ),
    );
  }

  const paintBps = painter(
    bpEl,
    () => [ctx.reads.balances, ctx.busy() ? "busy" : ""],
    () => [
      head("Moss's blueprints", "parts and fee are burned"),
      h(
        "div",
        { class: "d2-bp-list", "data-scroll": "bps" },
        ...GROUPS.flatMap((g) => [
          h("h4", { class: "d2-bp-g" }, g.title),
          ...g.ids.map((id) => {
            const b = BLUEPRINTS[id];
            const can = canBuild(id);
            const scrip = ctx.holding("scrip");
            return h(
              "div",
              { class: "d2-bp", "data-bp": id, "data-kind": b.kind, "data-can": can == null ? "?" : can ? "1" : "0" },
              h("div", { class: "d2-bp-n" }, h("b", null, bpName(id), b.yields > 1 ? h("em", null, ` × ${b.yields}`) : null), h("i", null, bpLine(id))),
              h(
                "div",
                { class: "d2-needs" },
                ...(Object.entries(b.inputs) as [MaterialId, number][]).map(([m, n]) => {
                  const held = ctx.holding(m);
                  return h("span", { class: "d2-need", "data-tok": m, "data-ok": held == null ? "?" : held >= n ? "1" : "0", title: TOKEN_NAMES[m] }, h("i", null, SHORT[m]), h("b", null, String(n)), h("em", null, `/${held == null ? "?" : held}`));
                }),
                h("span", { class: "d2-need fee", "data-tok": "scrip", "data-ok": scrip == null ? "?" : scrip >= b.fee ? "1" : "0" }, h("i", null, "Fee"), h("b", null, fmt(b.fee))),
              ),
              actBtn(ctx, { k: `build:${id}`, label: "Build", cls: "solid", disabled: can !== true, why: can === false ? "You're short of parts or scrip." : can == null ? `Your stash is ${UNKNOWN}.` : null, onclick: () => void build(id) }),
            );
          }),
        ]),
      ),
    ],
  );

  let benchSig = "";
  function paintBench(force = false) {
    const weapons = mine();
    let sig: string;
    if (bench.mode === "build") sig = JSON.stringify(["build", bench.frame, bench.weapon?.serial ?? null, bench.landed, ctx.busy()]);
    else {
      // The bench holds the gun that was picked; with none picked, the first one in the stash.
      const held = weapons?.filter((w) => w.state === "held") ?? [];
      let picked = bench.serial;
      if (picked && weapons && !weapons.some((w) => w.serial === picked)) {
        picked = null;
        bench = { mode: "gun", serial: null };
      }
      const serial = picked ?? held[0]?.serial ?? null;
      sig = JSON.stringify(["gun", serial, weapons?.find((w) => w.serial === serial), ctx.reads.weapons.s, ctx.reads.balances, confirmScrap, made, ctx.busy() ? "busy" : ""]);
    }
    if (!force && sig === benchSig) return;
    benchSig = sig;
    const active = document.activeElement as HTMLElement | null;
    const k = active && benchEl.contains(active) ? active.dataset.k : undefined;
    if (bench.mode === "build") {
      const w = bench.weapon;
      benchEl.dataset.mode = bench.landed ? "landed" : "rolling";
      const state = bench;
      benchEl.replaceChildren(
        head(bench.landed ? "Off the bench" : "On the bench", w && bench.landed ? w.serial : "the chain rolls every stat"),
        // The line over the card keeps its place from the first sweep to the last stamp, so nothing jumps.
        bench.landed && w
          ? h(
              "div",
              { class: "d2-bench-top d2-bench-after", "data-grade": w.grade },
              h("p", { class: "d2-bench-line" }, GRADE_LINE[w.grade]),
              h(
                "div",
                { class: "d2-confirm-b" },
                h("button", { class: "d2-b solid", type: "button", "data-k": "bench:keep", onclick: () => ((bench = { mode: "gun", serial: w.serial }), ctx.render()) }, "Fit it out"),
                actBtn(ctx, { k: `build:${state.frame}`, label: "Roll another", disabled: canBuild(state.frame) !== true, onclick: () => void build(state.frame) }),
              ),
            )
          : h("div", { class: "d2-bench-top" }, h("p", { class: "d2-bench-line dim" }, w ? "Landing. Six stats, then the grade, then the serial." : "Moss is at the lathe. Every stat lands somewhere inside its band.")),
        h("div", { class: "d2-bench-card" }, bench.card),
      );
    } else {
      delete benchEl.dataset.mode;
      const held = weapons?.filter((w) => w.state === "held") ?? [];
      const serial = bench.serial ?? held[0]?.serial ?? null;
      const w = weapons?.find((x) => x.serial === serial) ?? null;
      const kids: (Node | null)[] = [
        head("The bench", w ? w.serial : null),
        made ? h("p", { class: "d2-made" }, made) : null,
        w
          ? h("div", { class: "d2-bench-gun" }, gunCard(w, { me: ctx.me() }), work(w))
          : emptyLine(weapons ? "Nothing on the bench. Build a frame, or buy a gun and bring it here." : ctx.reads.weapons.s === "loading" ? "Opening your locker…" : `Your guns: ${UNKNOWN}.`, ctx.reads.weapons.s === "unknown"),
      ];
      benchEl.replaceChildren(...(kids.filter(Boolean) as Node[]));
    }
    if (k != null) [...benchEl.querySelectorAll<HTMLElement>("[data-k]")].find((n) => n.dataset.k === k)?.focus({ preventScroll: true });
  }

  const paintStash = painter(
    stashEl,
    () => [ctx.reads.weapons, ctx.reads.balances, bench.mode === "gun" ? bench.serial : "build"],
    () => {
      const weapons = mine();
      const b = okv(ctx.reads.balances);
      const held = weapons?.filter((w) => w.state === "held") ?? [];
      const on = bench.mode === "gun" ? (bench.serial ?? held[0]?.serial ?? null) : null;
      const parts = (["copper", "chips", "servo", "rotor", "core", "fuel", "meds", "mag2", "barrel2", "comp", "optic"] as const).filter((id) => !b || (b[id] ?? 0) > 0 || BLUEPRINTS.longshore.inputs[id as MaterialId] != null);
      return [
        head("Your guns", weapons ? plural(weapons.length, "gun") : null),
        h(
          "div",
          { class: "d2-rack-list", "data-scroll": "stash" },
          ...(weapons
            ? weapons.map((w) => gunTile(w, { k: `bench:${w.serial}`, selected: on === w.serial, onclick: () => ((bench = { mode: "gun", serial: w.serial }), (confirmScrap = null), (made = null), ctx.render()) }))
            : [emptyLine(ctx.reads.weapons.s === "loading" ? "Opening your locker…" : `Your guns: ${UNKNOWN}.`, ctx.reads.weapons.s === "unknown")]),
        ),
        head("Parts you hold"),
        b
          ? h("dl", { class: "d2-parts" }, ...parts.map((id) => h("div", { "data-tok": id, class: (b[id] ?? 0) > 0 ? "" : "none" }, h("dt", null, SHORT[id]), h("dd", null, fmt(b[id] ?? 0)))))
          : emptyLine(ctx.reads.balances.s === "loading" ? "Counting…" : `Your parts: ${UNKNOWN}.`, ctx.reads.balances.s === "unknown"),
      ];
    },
  );

  return {
    el,
    update() {
      paintBps();
      paintBench();
      paintStash();
    },
    /** For tests and the screenshot script: build as the button does. */
    build,
  };
}
