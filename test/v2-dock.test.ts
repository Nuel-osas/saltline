// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDock, type Dock, type GameLike } from "../src/economy/v2/dock/dock";
import { createFake, type FakeV2 } from "../src/economy/v2/dock/fake";
import { gunSvg } from "../src/economy/v2/dock/gunart";
import { bandPct, gunCard, historyLine, issueCard, prepareReveal, revealBuild, REVEAL_STEPS } from "../src/economy/v2/dock/guncard";
import { clampLoadout, invoiceParts } from "../src/economy/v2/dock/loadout";
import { repairCost } from "../src/economy/v2/dock/armoury";
import { saleSplit } from "../src/economy/v2/dock/market";
import { hmBuys, maxSettle } from "../src/economy/v2/dock/ledger";
import { appraise, BLUEPRINTS, CONDITION, effective, FRAMES, HARBORMASTER, INVOICE, invoiceStart, MARKET, MATERIALS, RAID, STAT_KEYS, VENDORS } from "../src/economy/v2/items";
import type { MaterialId, Stats, Weapon } from "../src/economy/v2/types";

// Every expected figure below is worked out from items.ts as it stands (the lead tunes those numbers), or read off
// the screen and checked against what the stand-in then holds. Only the stand-in's own state is typed in: 2,400
// scrip, 1,240 arrears, 9 extractions, 14 copper, 9 electronics, 2 relay cores, 1 plate, 2 charges, 6 magazines.
const n = (v: number) => v.toLocaleString("en-US");
const num = (el: Element) => Number((el.textContent ?? "").replace(/[^\d.-]/g, ""));
/** A stat `t` of the way from the band's low end to its high end. */
const inBand = (k: keyof Stats, t: number) => {
  const [lo, hi] = FRAMES.pilot.bands[k];
  return Math.round(lo + (hi - lo) * t);
};

// ---- a stand-in for the game: its menu cards and event bus, nothing else ----
function fakeGame(state = "title") {
  const menus = document.createElement("div");
  menus.className = "menu";
  menus.innerHTML = `
    <section data-s="title"><div class="m-actions"><button class="btn primary" data-act="deploy">Deploy</button><button class="btn" data-act="settings">Settings</button></div></section>
    <section data-s="dead"><div class="m-actions col"><button class="btn primary" data-act="retry">Retry</button></div></section>
    <section data-s="complete"><div class="m-actions col"><button class="btn primary" data-act="redeploy">Redeploy</button></div></section>`;
  const ui = document.createElement("div");
  ui.id = "ui";
  ui.append(menus);
  document.body.append(ui);
  const emitted: string[] = [];
  const G: GameLike & { game: { state: string; menus: { root: HTMLElement } } } = {
    events: { on: () => () => {}, emit: (n: string) => void emitted.push(n) },
    game: { state, menus: { root: menus } },
  };
  return { G, menus, ui, emitted };
}

let docks: Dock[] = [];
function setup(opts: { registered?: boolean; state?: string } = {}) {
  const game = fakeGame(opts.state);
  const v2: FakeV2 = createFake({ registered: opts.registered ?? true, latency: 2 });
  const dock = createDock(game.G, v2, { host: game.ui, revealMs: 1, gate: { quietMs: 5, askMs: 400 } });
  docks.push(dock);
  return { ...game, v2, fake: v2.fake, dock, root: dock.root };
}
async function opened(opts: Parameters<typeof setup>[0] = {}) {
  const s = setup(opts);
  await s.dock.open("title");
  await vi.waitFor(() => expect(s.root.querySelector('.d2-tile[data-serial="S-000041"]')).toBeTruthy());
  return s;
}
const q = <T extends Element = HTMLElement>(root: ParentNode, sel: string) => {
  const el = root.querySelector<T>(sel);
  if (!el) throw new Error(`missing ${sel}`);
  return el as T;
};
const k = (root: ParentNode, key: string) => {
  const el = [...root.querySelectorAll<HTMLButtonElement>("[data-k]")].find((n) => n.dataset.k === key);
  if (!el) throw new Error(`no control ${key}`);
  return el;
};
const status = (root: ParentNode) => q(root, ".d2-status");
const settled = (root: ParentNode, state = "ok") => vi.waitFor(() => expect(status(root).dataset.state).toBe(state));
const key = (code: string, target: EventTarget = document.body) => target.dispatchEvent(new KeyboardEvent("keydown", { code, bubbles: true, cancelable: true }));

afterEach(() => {
  for (const d of docks) d.dispose();
  docks = [];
  document.body.replaceChildren();
});

const rook = (o: Partial<Weapon> = {}): Weapon => ({
  serial: "S-000041",
  frame: "pilot",
  grade: "A",
  quality: 90,
  // A good roll: high where high is good, low where low is good (recoil, reload).
  stats: { damage: inBand("damage", 0.85), rpm: inBand("rpm", 0.9), mag: inBand("mag", 1), recoil: inBand("recoil", 0.12), reload: inBand("reload", 0.1), range: inBand("range", 0.9) },
  mods: [],
  condition: 82,
  maker: "rook.testnet",
  makerCallsign: "ROOK",
  owner: "me.testnet",
  builtAt: 0,
  raids: 19,
  extractions: 14,
  owners: 3,
  recovered: 1,
  state: "held",
  value: appraise("pilot", "A", 82),
  ...o,
});

describe("the gun card", () => {
  it("draws a Weapon: six bars inside the frame's bands with the ends marked, the grade, the serial, the value", () => {
    const w = rook();
    const card = gunCard(w, { me: "me.testnet" });
    expect(card.dataset.grade).toBe("A");
    expect(card.dataset.frame).toBe("pilot");
    expect(q(card, ".d2-grade b").textContent).toBe("A");
    expect(q(card, ".d2-gun-name").textContent).toBe("Pilot");
    expect(q(card, ".d2-serial").textContent).toBe("S-000041");
    const bars = [...card.querySelectorAll<HTMLElement>(".d2-stat")];
    expect(bars.map((b) => b.dataset.stat)).toEqual(STAT_KEYS);
    for (const b of bars) {
      const stat = b.dataset.stat as keyof typeof w.stats;
      const [lo, hi] = FRAMES.pilot.bands[stat];
      expect([+b.dataset.lo!, +b.dataset.hi!]).toEqual([lo, hi]);
      expect(+b.dataset.v!).toBe(w.stats[stat]);
      expect(+b.dataset.v!).toBeGreaterThanOrEqual(lo);
      expect(+b.dataset.v!).toBeLessThanOrEqual(hi);
      const pct = +b.dataset.pct!;
      expect(pct).toBe(bandPct("pilot", stat, w.stats[stat]));
      expect(pct).toBeGreaterThanOrEqual(0);
      expect(pct).toBeLessThanOrEqual(100);
      expect(q(b, ".d2-stat-fill").getAttribute("style")).toBe(`width:${pct}%`);
    }
    // Recoil is better when lower: a roll near the band's low end fills most of the bar, and the bar's ends read
    // worst to best (the high number on the left).
    const recoil = q(card, '.d2-stat[data-stat="recoil"]');
    const [rlo, rhi] = FRAMES.pilot.bands.recoil;
    expect(+recoil.dataset.pct!).toBe(Math.round(100 - ((w.stats.recoil - rlo) * 100) / (rhi - rlo)));
    expect(+recoil.dataset.pct!).toBeGreaterThan(80);
    expect([...recoil.querySelectorAll(".d2-stat-end")].map((e) => e.textContent)).toEqual([String(rhi), String(rlo)]);
    // Damage is better when higher: its ends read low to high.
    expect([...q(card, '.d2-stat[data-stat="damage"]').querySelectorAll(".d2-stat-end")].map((e) => e.textContent)).toEqual(FRAMES.pilot.bands.damage.map(String));
    expect(q(card, ".d2-gun-val").textContent).toContain(n(w.value));
    expect(q(card, ".d2-cond").dataset.cond).toBe("82");
  });

  it("tells the gun's history in one line", () => {
    expect(historyLine(rook(), "me.testnet")).toBe("Built by ROOK · 14 extractions · 3 owners · recovered once");
    expect(historyLine(rook({ maker: "me.testnet", extractions: 1, owners: 1, recovered: 0 }), "me.testnet")).toBe("Built by YOU · 1 extraction · 1 owner");
    expect(historyLine(rook({ raids: 0, extractions: 0, owners: 1, recovered: 2 }))).toBe("Built by ROOK · never over the fence · 1 owner · recovered twice");
    expect(q(gunCard(rook()), ".d2-history").textContent).toBe("Built by ROOK · 14 extractions · 3 owners · recovered once");
  });

  it("says plainly where the gun is: stash, market, wreck, impound", () => {
    const tag = (state: Weapon["state"]) => q(gunCard(rook({ state })), ".d2-state");
    expect(tag("held").textContent).toBe("In the stash");
    expect(tag("listed").textContent).toBe("Listed on the market");
    expect(tag("wreck").textContent).toBe("In a wreck");
    expect(tag("impound").textContent).toBe("Impounded");
    expect(tag("impound").dataset.state).toBe("impound");
  });

  it("shows mods in their slots, what they do to the stats, and wear", () => {
    const w = rook({ mods: ["optic", "barrel2"], condition: 24 });
    const card = gunCard(w);
    expect(q(card, '.d2-slot[data-slot="barrel"]').dataset.mod).toBe("barrel2");
    expect(q(card, '.d2-slot[data-slot="optic"]').dataset.mod).toBe("optic");
    expect(q(card, '.d2-slot[data-slot="muzzle"]').classList.contains("empty")).toBe(true);
    const dmg = q(card, '.d2-stat[data-stat="damage"]');
    expect(+dmg.dataset.eff!).toBe(effective(w).damage);
    expect(q(card, ".d2-cond").dataset.state).toBe("worn");
    expect(q(card, ".d2-cond em").textContent).toBe("Worn");
    // The picture changes with the frame and with what is fitted.
    expect(gunSvg("pilot", ["optic", "barrel2"])).toContain('data-part="optic"');
    expect(gunSvg("pilot", ["optic", "barrel2"])).toContain('data-part="barrel2"');
    expect(gunSvg("pilot")).not.toContain("data-part");
    expect(gunSvg("stevedore")).not.toBe(gunSvg("longshore"));
  });

  it("draws the issue rifle as plain and unsellable", () => {
    const card = issueCard();
    expect(card.classList.contains("issue")).toBe(true);
    expect(card.textContent).toContain("can’t be sold");
    expect(card.textContent).toContain("unsellable");
    expect(card.querySelector(".d2-stat-fill")).toBeNull();
  });

  it("reveals a build in order: six stats, the grade, the serial, the maker, landing on the rolled values", async () => {
    const w = rook({ maker: "me.testnet", serial: "S-000099", raids: 0, extractions: 0, owners: 1, recovered: 0 });
    const card = prepareReveal(gunCard(w, { me: "me.testnet" }));
    expect(card.dataset.grade).toBeUndefined(); // nothing gives the roll away early
    expect(q(card, ".d2-serial").textContent).toBe("");
    expect(card.querySelectorAll(".d2-stat.rolling").length).toBe(6);
    const steps: string[] = [];
    let rollingAtGrade = -1;
    await revealBuild(card, w, {
      ms: 1,
      me: "me.testnet",
      onStep: (s) => {
        steps.push(s);
        if (s === "grade") rollingAtGrade = card.querySelectorAll(".d2-stat.rolling").length;
      },
    });
    expect(steps).toEqual(REVEAL_STEPS);
    expect(steps).toEqual(["damage", "rpm", "mag", "recoil", "reload", "range", "grade", "serial", "maker"]);
    expect(rollingAtGrade).toBe(0);
    expect(card.dataset.grade).toBe("A");
    expect(q(card, ".d2-grade").classList.contains("stamped")).toBe(true);
    expect(q(card, ".d2-serial").textContent).toBe("S-000099");
    expect(q(card, ".d2-history").textContent).toBe("Built by YOU · never over the fence · 1 owner");
    expect(q(card, '.d2-stat[data-stat="damage"] .d2-stat-v').textContent).toBe(String(w.stats.damage));
    expect(q(card, '.d2-stat[data-stat="range"] .d2-stat-v').textContent).toBe(`${w.stats.range}m`);
    expect(q(card, ".d2-gun-val b").textContent).toBe(n(w.value));
  });
});

describe("the ways in and out", () => {
  it("puts a DOCK button on the title, dead and debrief cards", () => {
    const { menus } = setup();
    for (const o of ["title", "dead", "complete"]) expect(menus.querySelector(`[data-s="${o}"] [data-d2="${o}"]`)?.textContent).toContain("Dock");
    // On the title it sits straight after DEPLOY.
    expect(q(menus, '[data-s="title"] [data-act="deploy"]').nextElementSibling?.getAttribute("data-d2")).toBe("title");
  });

  it("opens from a card on LOADOUT, announces itself, and Esc closes back to that card", async () => {
    const { dock, menus, root, emitted } = setup();
    q<HTMLButtonElement>(menus, '[data-d2="title"]').click();
    await vi.waitFor(() => expect(dock.gate).toBe("in"));
    expect(dock.isOpen).toBe(true);
    expect(root.hidden).toBe(false);
    expect(dock.tab).toBe("loadout");
    expect(emitted).toContain("dock:open");
    key("Escape", window);
    expect(dock.isOpen).toBe(false);
    expect(emitted).toContain("dock:closed");
    expect(document.activeElement).toBe(q(menus, '[data-d2="title"]'));
  });

  it("never opens mid-raid, and closes if a raid starts", async () => {
    const { dock, G } = setup({ state: "playing" });
    await dock.open();
    expect(dock.isOpen).toBe(false);
    q<HTMLButtonElement>(G.game.menus.root, '[data-d2="title"]').click();
    expect(dock.isOpen).toBe(false);
  });

  it("changes tab on the number keys", async () => {
    const { dock, root } = await opened();
    key("Digit3");
    expect(dock.tab).toBe("market");
    expect(q(root, '[data-pane="market"]').hidden).toBe(false);
    expect(q(root, '[data-pane="loadout"]').hidden).toBe(true);
    key("Digit5");
    expect(dock.tab).toBe("ledger");
    key("Digit1");
    expect(dock.tab).toBe("loadout");
  });

  it("DEPLOY in the header starts a raid by pressing the game's own button", async () => {
    const { dock, root, menus } = await opened();
    let pressed = 0;
    q(menus, '[data-s="title"] [data-act="deploy"]').addEventListener("click", () => pressed++);
    q<HTMLButtonElement>(root, ".d2-deploy").click();
    expect(pressed).toBe(1);
    expect(dock.isOpen).toBe(false);
  });

  it("gives a first-time player the dock pass card before the raid, then carries on into it", async () => {
    const { dock, root, menus, fake } = setup({ registered: false });
    let pressed = 0;
    const deploy = q<HTMLButtonElement>(menus, '[data-s="title"] [data-act="deploy"]');
    deploy.addEventListener("click", () => pressed++);
    deploy.click();
    expect(pressed).toBe(0); // held at the gate
    await vi.waitFor(() => expect(root.querySelector(".d2-pass")).toBeTruthy());
    expect(dock.gate).toBe("pass");
    const input = q<HTMLInputElement>(root, ".d2-cs-in");
    input.value = "wren";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    q(root, ".d2-pass-form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(pressed).toBe(1), { timeout: 4000 });
    expect(fake.profile?.callsign).toBe("WREN");
    expect(dock.isOpen).toBe(false);
  });
});

describe("LOADOUT", () => {
  it("clamps a loadout to what is held and what a raid allows", () => {
    const guns = [rook(), rook({ serial: "S-2", state: "listed" }), rook({ serial: "S-3", condition: 0 })];
    expect(clampLoadout({ weapon: "S-000041", plates: 5, charges: 9, mags: 20 }, guns, { plate: 3, charge: 2, ammo: 40 })).toEqual({ weapon: "S-000041", plates: RAID.maxPlates, charges: 2, mags: RAID.maxMags });
    expect(clampLoadout({ weapon: "S-2", plates: 1, charges: 0, mags: 0 }, guns, {}).weapon).toBeNull(); // listed
    expect(clampLoadout({ weapon: "S-3", plates: 1, charges: 0, mags: 0 }, guns, {})).toEqual({ weapon: null, plates: 0, charges: 0, mags: 0 }); // worn out, and no plate held
    // An unread balance adds nothing and removes nothing it can't check.
    expect(clampLoadout({ weapon: "S-000041", plates: 1, charges: 2, mags: 3 }, null, null)).toEqual({ weapon: "S-000041", plates: 1, charges: 2, mags: 3 });
  });

  it("shows the guns as cards, the issue rifle always, and writes the pick to G.v2.loadout", async () => {
    const { root, v2 } = await opened();
    const tiles = [...root.querySelectorAll<HTMLElement>(".d2-rack .d2-tile")].map((t) => t.dataset.serial);
    expect(tiles).toEqual(["S-000041", "S-000017", "S-000052", "S-000063", "S-000029", "issue"]);
    expect(v2.loadout.weapon).toBeNull();
    expect(q(root, ".d2-taking .d2-gun").classList.contains("issue")).toBe(true);
    expect(q(root, ".d2-risk-t").textContent).toBe("If you die: only what you carry. The issue rifle always comes back.");
    // A listed gun and an impounded one can't be taken.
    expect(q<HTMLButtonElement>(root, '.d2-rack .d2-tile[data-serial="S-000063"]').disabled).toBe(true);
    expect(q<HTMLButtonElement>(root, '.d2-rack .d2-tile[data-serial="S-000029"]').disabled).toBe(true);
    k(root, "pick:S-000017").click();
    expect(v2.loadout.weapon).toBe("S-000017");
    expect(q(root, ".d2-taking .d2-gun").dataset.serial).toBe("S-000017");
    expect(q(root, ".d2-risk-t").textContent).toBe("If you die: this Longshore and everything you carry");
    k(root, "pick:issue").click();
    expect(v2.loadout.weapon).toBeNull();
  });

  it("limits plates, charges and magazines by what is held and by the raid's rules", async () => {
    const { root, v2 } = await opened(); // holds 1 plate, 2 charges, 6 magazines
    const fill = (id: string) => {
      let presses = 0;
      while (!k(root, `kit:${id}:+`).disabled && presses < 20) (k(root, `kit:${id}:+`).click(), presses++);
      return presses;
    };
    const want = { plates: Math.min(1, RAID.maxPlates), charges: Math.min(2, RAID.maxCharges), mags: Math.min(6, RAID.maxMags) };
    expect(fill("plate")).toBe(want.plates);
    expect(fill("charge")).toBe(want.charges);
    expect(fill("ammo")).toBe(want.mags);
    expect(v2.loadout).toEqual({ weapon: null, ...want });
    // Every "more" is now refused, by the stash or by the raid's cap, whichever is lower.
    for (const id of ["plate", "charge", "ammo"]) expect(k(root, `kit:${id}:+`).disabled).toBe(true);
    k(root, "kit:ammo:-").click();
    expect(v2.loadout).toEqual({ weapon: null, ...want, mags: want.mags - 1 });
  });

  it("breaks the invoice at the fence into parts that follow items.ts, whatever its rule is", () => {
    for (const [extractions, arrears] of [
      [0, 0],
      [9, 1240],
      [40, 0],
      [200, 90_000],
    ]) {
      const p = invoiceParts(extractions, arrears);
      expect(p.total).toBe(invoiceStart(extractions, arrears));
      expect(p.entry + p.history + p.carried).toBe(p.total);
      expect(p.entry).toBe(invoiceStart(0, 0));
      expect(p.carried).toBeLessThanOrEqual(INVOICE.carryInMax);
      // "capped" says exactly this: one more extraction on file would add nothing.
      expect(p.capped).toBe(extractions > 0 && invoiceStart(extractions + 1, 0) === invoiceStart(extractions, 0));
    }
  });

  it("says what is already on the invoice at the fence and how far that is from the Bailiff", async () => {
    const { root, fake } = await opened();
    const start = invoiceStart(fake.profile!.extractions, fake.profile!.arrears);
    await vi.waitFor(() => expect(q(root, ".d2-fence").dataset.gap).toBeTruthy());
    expect(q(root, ".d2-fence").dataset.start).toBe(String(start));
    expect(q(root, ".d2-fence-n b").textContent).toBe(n(start));
    const gap = fake.harbormaster.bailiffAt - start;
    expect(q(root, ".d2-fence").dataset.gap).toBe(String(gap));
    expect(q(root, ".d2-fence-n span").textContent).toBe(gap > 0 ? `${n(gap)} from the Bailiff` : "The Bailiff is sent the moment you cross");
    // The parts printed under the meter add up to the figure above them.
    const rows = q(root, ".d2-fence-rows");
    expect(+rows.dataset.entry! + +rows.dataset.history! + +rows.dataset.carried!).toBe(start);
  });
});

describe("ARMOURY", () => {
  it("shows each blueprint's inputs against what is held", async () => {
    const { dock, root } = await opened();
    dock.setTab("armoury");
    await vi.waitFor(() => expect(root.querySelector('.d2-bp[data-bp="pilot"]')).toBeTruthy());
    // Every blueprint in items.ts has a row, with one chip per input showing what it needs, and its fee.
    for (const [id, b] of Object.entries(BLUEPRINTS)) {
      const row = q(root, `.d2-bp[data-bp="${id}"]`);
      for (const [m, need] of Object.entries(b.inputs)) expect(q(row, `.d2-need[data-tok="${m}"] b`).textContent).toBe(String(need));
      expect(q(row, ".d2-need.fee b").textContent).toBe(n(b.fee));
      expect(row.querySelectorAll(".d2-need").length).toBe(Object.keys(b.inputs).length + 1);
    }
    // Against what is held: the stand-in holds 14 copper.
    const copper = q(root, '.d2-bp[data-bp="pilot"] .d2-need[data-tok="copper"]');
    expect(copper.textContent).toBe(`Copper${BLUEPRINTS.pilot.inputs.copper}/14`);
    expect(copper.dataset.ok).toBe(BLUEPRINTS.pilot.inputs.copper! <= 14 ? "1" : "0");
    expect(q(root, '.d2-bp[data-bp="pilot"]').dataset.can).toBe("1");
  });

  it("BUILD rolls a gun: the bars land, the grade stamps, the serial is engraved, Built by YOU", async () => {
    const { dock, root, fake, emitted } = await opened();
    dock.setTab("armoury");
    await vi.waitFor(() => expect(root.querySelector('.d2-bp[data-bp="pilot"]')).toBeTruthy());
    fake.nextGrade = "A";
    k(root, "build:pilot").click();
    // While it settles the bench shows the frame with every bar sweeping, and says so.
    expect(q(root, ".d2-bench").dataset.mode).toBe("rolling");
    expect(root.querySelectorAll(".d2-bench .d2-stat.rolling").length).toBe(6);
    expect(status(root).dataset.state).toBe("settling");
    await vi.waitFor(() => expect(q(root, ".d2-bench").dataset.mode).toBe("landed"), { timeout: 3000 });
    const built = fake.weapons[0];
    const card = q(root, ".d2-bench .d2-gun");
    expect(card.dataset.serial).toBe(built.serial);
    expect(card.dataset.grade).toBe("A");
    expect(card.dataset.step).toBe("maker");
    expect(q(card, ".d2-serial").textContent).toBe(built.serial);
    expect(q(card, ".d2-history").textContent).toContain("Built by YOU");
    for (const s of STAT_KEYS) expect(+q(card, `.d2-stat[data-stat="${s}"]`).dataset.v!).toBe(built.stats[s]);
    expect(status(root).textContent).toContain(`Built an A-grade Pilot, ${built.serial}`);
    expect(emitted).toContain("stash:changed");
    // The inputs and the fee were burned.
    const held: Record<string, number> = { copper: 14, chips: 9, servo: 5, core: 2, rotor: 4, fuel: 3, meds: 4 };
    for (const [m, need] of Object.entries(BLUEPRINTS.pilot.inputs)) expect(fake.balances[m as MaterialId]).toBe(held[m] - need);
    expect(fake.balances.scrip).toBe(2400 - BLUEPRINTS.pilot.fee);
  });

  it("fits a mod into its slot", async () => {
    const { dock, root, fake } = await opened();
    dock.setTab("armoury");
    await vi.waitFor(() => expect(root.querySelector(".d2-bench .d2-gun")).toBeTruthy());
    k(root, "bench:S-000017").click();
    k(root, "fit:S-000017:comp").click();
    await settled(root);
    expect(fake.weapons.find((w) => w.serial === "S-000017")!.mods).toEqual(["comp"]);
    expect(fake.balances.comp).toBe(0);
    await vi.waitFor(() => expect(q(root, '.d2-bench .d2-slot[data-slot="muzzle"]').dataset.mod).toBe("comp"));
    expect(q(root, '.d2-fit[data-slot="muzzle"]').textContent).toContain("fitted for good");
  });

  it("repairs a worn gun, with the cost shown first", async () => {
    const { dock, root, fake } = await opened();
    dock.setTab("armoury");
    await vi.waitFor(() => expect(root.querySelector(".d2-bench .d2-gun")).toBeTruthy());
    k(root, "bench:S-000052").click(); // condition 24
    const cost = { points: 76, scrip: 76 * CONDITION.scripPerPoint, copper: Math.ceil(76 / CONDITION.pointsPerCopper) };
    expect(repairCost(24)).toEqual(cost);
    expect(repairCost(100)).toEqual({ points: 0, scrip: 0, copper: 0 });
    expect(q(root, ".d2-repair").dataset.scrip).toBe(String(cost.scrip));
    expect(q(root, ".d2-repair").dataset.copper).toBe(String(cost.copper));
    expect(q(root, ".d2-repair").textContent).toContain(`${n(cost.scrip)} scrip`);
    k(root, "repair:S-000052").click();
    await settled(root);
    expect(fake.weapons.find((w) => w.serial === "S-000052")!.condition).toBe(100);
    expect(fake.balances.scrip).toBe(2400 - cost.scrip);
    expect(fake.balances.copper).toBe(14 - cost.copper);
    expect(status(root).textContent).toContain(`S-000052 repaired to 100. Cost ${n(cost.scrip)} scrip.`);
  });

  it("scraps a gun only after it is confirmed", async () => {
    const { dock, root, fake } = await opened();
    dock.setTab("armoury");
    await vi.waitFor(() => expect(root.querySelector(".d2-bench .d2-gun")).toBeTruthy());
    k(root, "bench:S-000052").click();
    k(root, "scrap-ask:S-000052").click();
    expect(q(root, ".d2-confirm").textContent).toContain("Scrap S-000052?");
    expect(fake.calls).not.toContain("scrap");
    key("Escape", window); // Esc answers the question, not the dock
    expect(root.querySelector(".d2-confirm")).toBeNull();
    expect(dock.isOpen).toBe(true);
    k(root, "scrap-ask:S-000052").click();
    k(root, "scrap:S-000052").click();
    await settled(root);
    expect(fake.weapons.some((w) => w.serial === "S-000052")).toBe(false);
    expect(fake.balances.copper).toBe(14 + (CONDITION.scrap.copper ?? 0));
    expect(fake.balances.chips).toBe(9 + (CONDITION.scrap.chips ?? 0));
  });
});

describe("MARKET", () => {
  async function market() {
    const s = await opened();
    s.dock.setTab("market");
    await vi.waitFor(() => expect(s.root.querySelector(".d2-mkt-grid .d2-gun")).toBeTruthy());
    return s;
  }

  it("shows other players' guns with prices and recent sales, filtered by frame and grade", async () => {
    const { root } = await market();
    expect(root.querySelectorAll(".d2-mkt-grid .d2-gun").length).toBe(7);
    await vi.waitFor(() => expect(q(root, '.d2-mkt-grid .d2-gun[data-frame="longshore"][data-grade="B"] .d2-sales b').textContent).toBe("1,010 · 980 · 1,120 · 1,060 · 990"));
    k(root, "f:Frame:pilot").click();
    expect([...root.querySelectorAll<HTMLElement>(".d2-mkt-grid .d2-gun")].map((g) => g.dataset.frame)).toEqual(["pilot", "pilot"]);
    k(root, "f:Grade:A").click();
    expect(root.querySelectorAll(".d2-mkt-grid .d2-gun").length).toBe(1);
    expect(q(root, ".d2-mkt-grid .d2-gun-price").textContent).toContain("2,650");
  });

  it("buys a gun: the scrip leaves, the gun arrives", async () => {
    const { root, fake } = await market();
    const card = q(root, '.d2-mkt-grid .d2-gun[data-frame="stevedore"][data-grade="B"]');
    const serial = card.dataset.serial!;
    q<HTMLButtonElement>(card, ".d2-gun-acts .d2-b").click();
    expect(status(root).dataset.state).toBe("settling");
    await settled(root);
    expect(fake.balances.scrip).toBe(2400 - 890);
    expect(fake.weapons[0].serial).toBe(serial);
    expect(fake.weapons[0].owners).toBe(2);
    await vi.waitFor(() => expect(root.querySelector(`.d2-mkt-grid .d2-gun[data-serial="${serial}"]`)).toBeNull());
    // A gun that costs more than the purse can't be bought, and says why.
    const dear = q(root, '.d2-mkt-grid .d2-gun[data-frame="pilot"][data-grade="A"]');
    expect(q<HTMLButtonElement>(dear, ".d2-gun-acts .d2-b").disabled).toBe(true);
    expect(q(dear, ".d2-why").textContent).toBe("1,140 scrip short");
  });

  it("lists a gun with the fee and the maker's 2% shown before it is listed", async () => {
    const { root, fake } = await market();
    // The split follows items.ts's MARKET: the maker's share, the rest of the fee burned, the remainder to the
    // seller, in whole scrip with nothing lost to rounding.
    for (const price of [1, 49, 999, 1500, 2500]) {
      const s = saleSplit(price);
      expect(s.maker).toBe(Math.floor((price * MARKET.makerPct) / 100));
      expect(s.burned).toBe(Math.floor((price * (MARKET.feePct - MARKET.makerPct)) / 100));
      expect(s.fee).toBe(s.maker + s.burned);
      expect(s.maker + s.burned + s.seller).toBe(price);
    }
    k(root, "list:S-000041").click(); // built by ROOK
    const input = k(root, "list:price") as unknown as HTMLInputElement;
    expect(input.value).toBe(String(fake.weapons.find((w) => w.serial === "S-000041")!.value)); // the appraisal is the starting guide
    input.value = "2500";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    const want = saleSplit(2500);
    const split = q(root, ".d2-split");
    expect([split.dataset.fee, split.dataset.maker, split.dataset.burned, split.dataset.seller]).toEqual([want.fee, want.maker, want.burned, want.seller].map(String));
    expect(split.textContent).toContain(`Maker's ${MARKET.makerPct}% (ROOK)−${n(want.maker)}`);
    expect(split.textContent).toContain(`You receive${n(want.seller)}`);
    expect(q(root, ".d2-guides").textContent).toContain("2,480 · 2,710 · 2,390");
    k(root, "list:go").click();
    await settled(root);
    expect(fake.weapons.find((w) => w.serial === "S-000041")!.state).toBe("listed");
    await vi.waitFor(() => expect(root.querySelectorAll(".d2-mine .d2-mine-row").length).toBe(2));
  });

  it("cancels your own listing", async () => {
    const { root, fake } = await market();
    const row = q(root, ".d2-mine .d2-mine-row");
    expect(row.textContent).toContain("520");
    q<HTMLButtonElement>(row, ".d2-b").click();
    await settled(root);
    expect(fake.weapons.find((w) => w.serial === "S-000063")!.state).toBe("held");
    await vi.waitFor(() => expect(root.querySelector(".d2-mine .d2-mine-row")).toBeNull());
  });
});

describe("VENDORS", () => {
  async function vendors() {
    const s = await opened();
    s.dock.setTab("vendors");
    await vi.waitFor(() => expect(s.root.querySelector(".d2-bid")).toBeTruthy());
    return s;
  }

  it("shows Moss as a character: her note, what she pays and why, the guns she built", async () => {
    const { root } = await vendors();
    expect(q(root, ".d2-person-name").textContent).toBe("Moss");
    expect(q(root, ".d2-memo p").textContent).toContain("Servos are short");
    expect(q(root, '.d2-bid[data-tok="servo"] .d2-bid-why').textContent).toBe("“No servos, no Longshores. I'm paying over the odds.”");
    expect(root.querySelectorAll(".d2-shop-guns .d2-gun").length).toBe(2);
    expect(q(root, ".d2-shop-guns .d2-history").textContent).toContain("Built by MOSS");
  });

  it("sells parts to Moss and buys kit from Ines", async () => {
    const { root, fake } = await vendors();
    const before = fake.balances.scrip!;
    // What Moss says she pays is what she pays.
    const bid = num(q(root, '.d2-bid[data-to="moss"][data-tok="servo"] .d2-scrip b'));
    expect(bid).toBeGreaterThan(0);
    k(root, "sell:moss:servo:1").click();
    await settled(root);
    expect(fake.balances.servo).toBe(4);
    expect(fake.balances.scrip).toBe(before + bid);
    expect(status(root).textContent).toContain(`Moss paid ${n(bid)} scrip for 1 hound servo.`);
    k(root, "door:ines").click();
    expect(q(root, ".d2-person-name").textContent).toBe("Ines");
    // Ines's price is for one unit, and one unit is what arrives.
    const price = num(q(root, '.d2-good[data-tok="plate"] .d2-scrip b'));
    expect(price).toBeGreaterThan(0);
    k(root, "buy:ines:plate").click();
    await settled(root);
    expect(fake.balances.plate).toBe(2);
    expect(fake.balances.scrip).toBe(before + bid - price);
    expect(status(root).textContent).toContain(`Bought 1 armour plate from Ines for ${n(price)} scrip.`);
  });

  it("offers a sale for every material a vendor buys in items.ts", async () => {
    const { root } = await vendors();
    for (const who of ["moss", "ines"] as const) {
      k(root, `door:${who}`).click();
      const shown = [...root.querySelectorAll<HTMLElement>(`.d2-bid[data-to="${who}"]`)].map((b) => b.dataset.tok);
      expect(shown).toEqual([...VENDORS[who].buys]);
    }
  });

  it("the export desk pays less for every unit already aboard", async () => {
    const { root, fake } = await vendors();
    k(root, "door:export").click();
    await vi.waitFor(() => expect(root.querySelector('.d2-bid[data-to="export"][data-tok="copper"]')).toBeTruthy());
    const price = () => num(q(root, '.d2-bid[data-to="export"][data-tok="copper"] .d2-scrip b'));
    const first = price();
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThan(MATERIALS.copper.export); // 9 are already aboard today, so it is under list
    const before = fake.balances.scrip!;
    k(root, "sell:export:copper:1").click();
    await settled(root);
    expect(fake.balances.scrip).toBe(before + first); // paid what the window said
    await vi.waitFor(() => expect(price()).toBeLessThan(first)); // and the next one is worth less
  });
});

describe("THE LEDGER", () => {
  async function ledger() {
    const s = await opened();
    s.dock.setTab("ledger");
    await vi.waitFor(() => expect(s.root.querySelector(".d2-imp")).toBeTruthy());
    return s;
  }

  it("shows the arrears and what they do, the Harbormaster's wallet, and the economy in four numbers", async () => {
    const { root, fake } = await ledger();
    expect(q(root, ".d2-owed b").textContent).toBe("1,240");
    expect(q(root, ".d2-does").textContent).toContain(`+${n(invoiceStart(0, 1240) - invoiceStart(0, 0))}`);
    expect(q(root, ".d2-does .bonded").dataset.on).toBe(1240 >= INVOICE.bondedAt ? "1" : "0");
    expect(q(root, ".d2-truth").textContent).toContain("Every scrip you pay goes into the Harbormaster's wallet. It spends it on machines.");
    expect(q(root, ".d2-hm-bal").textContent).toBe("1,180");
    // What its wallet buys, in both postures, from items.ts's own rates.
    const hm = fake.harbormaster;
    expect(hm.strength).toBe(Math.min(100, Math.floor(1180 / HARBORMASTER.scripPerStrength)));
    expect(q(root, ".d2-hm-rows .buys dd").textContent).toBe(hmBuys(hm));
    const drones = Math.min(4, Math.floor(hm.strength / HARBORMASTER.strengthPerDrone));
    expect(hmBuys(hm)).toBe(drones ? `+${drones} Inspection Unit${drones === 1 ? "" : "s"} every wave` : "No extra Inspection Units");
    expect(hmBuys({ ...hm, posture: "pursuit", bailiffAt: 960 })).toBe("Bailiff at 960");
    await vi.waitFor(() => expect(q(root, '[data-eco="supply"] dd').textContent).toBe("48,250"));
    expect(root.querySelectorAll(".d2-eco [data-eco]").length).toBe(4);
    expect(q(root, '[data-eco="flow"] dd').textContent).toBe("+6,420 · −5,130");
  });

  it("SETTLE clears twice what is paid, and the Harbormaster's balance rises by it", async () => {
    const { root, fake } = await ledger();
    const max = Math.ceil(1240 / INVOICE.settleRate); // the most a settle takes: what clears the lot
    expect(maxSettle(1240, 2400)).toBe(max);
    expect(maxSettle(1240, 100)).toBe(100); // never more than the purse
    expect(maxSettle(0, 2400)).toBe(0);
    const pay = Math.floor(max / 2);
    const cleared = Math.min(1240, pay * INVOICE.settleRate);
    const owed = 1240 - cleared;
    k(root, "pay:Half").click();
    expect(q(root, ".d2-settle").dataset.pay).toBe(String(pay));
    expect(q(root, ".d2-settle").dataset.clears).toBe(String(cleared));
    k(root, "settle").click();
    await settled(root);
    expect(fake.profile!.arrears).toBe(owed);
    expect(fake.balances.scrip).toBe(2400 - pay);
    expect(fake.harbormaster.balance).toBe(1180 + pay); // every scrip paid is in its wallet
    expect(status(root).textContent).toContain(`${n(cleared)} of arrears cleared; you now owe ${n(owed)}.`);
    await vi.waitFor(() => expect(q(root, ".d2-hm-bal").textContent).toBe(n(1180 + pay)));
    expect(q(root, ".d2-owed b").textContent).toBe(n(owed));
    expect(q(root, ".d2-does .bonded").dataset.on).toBe(owed >= INVOICE.bondedAt ? "1" : "0");
  });

  it("buys an impounded gun back for its fee", async () => {
    const { root, fake } = await ledger();
    const imp = q(root, '.d2-imp[data-serial="S-000029"]');
    const fee = Math.floor((appraise("pilot", "B", 71) * RAID.buyBackPct) / 100);
    expect(q(imp, ".d2-gun-price").textContent).toContain(fee.toLocaleString("en-US"));
    expect(q(imp, ".d2-imp-clock b").textContent).toMatch(/^31 h \d\d min$/);
    k(root, "buyback:S-000029").click();
    await settled(root);
    expect(fake.balances.scrip).toBe(2400 - fee);
    expect(fake.harbormaster.balance).toBe(1180 + fee);
    expect(fake.weapons[0].serial).toBe("S-000029");
    expect(fake.weapons[0].state).toBe("held");
    await vi.waitFor(() => expect(root.querySelector(".d2-imp")).toBeNull());
  });
});

describe("unknown, pending and refused", () => {
  it("shows a failed read as unknown, never as 0", async () => {
    const s = setup();
    for (const v of ["balances", "harbormaster", "economy", "listings"]) s.fake.failViews.add(v);
    await s.dock.open("title");
    const { root, dock } = s;
    await vi.waitFor(() => expect(root.querySelector('.d2-tile[data-serial="S-000041"]')).toBeTruthy());
    await vi.waitFor(() => expect(q(root, '[data-me="scrip"]').dataset.unknown).toBe("1"));
    expect(q(root, '[data-me="scrip"] b').textContent).toBe("unknown");
    expect(q(root, '.d2-step[data-kit="plate"] .d2-step-held').textContent).toBe("hold unknown");
    expect(k(root, "kit:plate:+").disabled).toBe(true); // can't add what can't be counted
    expect(q(root, ".d2-fence-n span").textContent).toBe("Bailiff: unknown");
    dock.setTab("ledger");
    await vi.waitFor(() => expect(root.querySelector(".d2-hm .d2-empty.unk")).toBeTruthy());
    expect(q(root, ".d2-hm").textContent).toContain("Its balance: unknown");
    expect(root.querySelector(".d2-hm-bal")).toBeNull();
    await vi.waitFor(() => expect(q(root, '[data-eco="supply"] dd').textContent).toBe("unknown"));
    expect(q(root, ".d2-settle").textContent).toContain("Your scrip is unknown");
    dock.setTab("market");
    await vi.waitFor(() => expect(q(root, ".d2-mkt-main .d2-empty").dataset.unknown).toBe("1"));
    expect(q(root, ".d2-mkt-main .d2-empty").textContent).toContain("The market's listings: unknown");
    dock.setTab("armoury");
    await vi.waitFor(() => expect(q(root, '.d2-bp[data-bp="pilot"]').dataset.can).toBe("?"));
    expect(k(root, "build:pilot").disabled).toBe(true);
  });

  it("shows a call with no answer as one that may still settle, never as failed", async () => {
    const s = await opened();
    s.dock.setTab("ledger");
    await vi.waitFor(() => expect(s.root.querySelector(".d2-imp")).toBeTruthy());
    for (const mode of ["pending", "throw"] as const) {
      s.fake.next = mode;
      k(s.root, "pay:A quarter").click();
      k(s.root, "settle").click();
      await settled(s.root, "pending");
      expect(status(s.root).textContent).toContain("may still settle");
      expect(status(s.root).textContent).not.toMatch(/fail/i);
      await vi.waitFor(() => expect(k(s.root, "settle").disabled).toBe(false)); // nothing freezes
    }
    // The first one had landed after all (a quarter of the most a settle takes): the stash was read again, so the
    // screen shows it. The second never left, so it changed nothing.
    const quarter = Math.floor(Math.ceil(1240 / INVOICE.settleRate) / 4);
    const owed = 1240 - quarter * INVOICE.settleRate;
    expect(s.fake.profile!.arrears).toBe(owed);
    await vi.waitFor(() => expect(q(s.root, ".d2-owed b").textContent).toBe(n(owed)));
  });

  it("says why when the contract refuses a call", async () => {
    const s = await opened();
    s.dock.setTab("ledger");
    await vi.waitFor(() => expect(s.root.querySelector(".d2-imp")).toBeTruthy());
    s.fake.next = "refuse";
    k(s.root, "settle").click();
    await settled(s.root, "error");
    expect(status(s.root).textContent).toBe("The dock is closed for inspection.");
    expect(s.fake.profile!.arrears).toBe(1240);
  });

  it("runs a ticker of the ledger's recent lines", async () => {
    const { root } = await opened();
    await vi.waitFor(() => expect(root.querySelectorAll(".d2-tk-i").length).toBeGreaterThan(5));
    expect(q(root, ".d2-tk").textContent).toContain("ROOK built an A-grade Pilot, S-000077.");
  });
});
