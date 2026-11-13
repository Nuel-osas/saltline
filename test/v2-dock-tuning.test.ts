// @vitest-environment happy-dom
// The lead tunes items.ts while the lanes build (13 Nov: Ines began buying copper, plate and charge blueprints began
// yielding several, the entry charge got a cap), so the dock must read its numbers from there at run time and never
// repeat them. These tests swap in numbers that are deliberately NOT the real ones, without touching items.ts, and
// check that the screens follow. If a figure is ever typed into the dock, one of these fails.
import { afterEach, describe, expect, it, vi } from "vitest";

/** Not the real rules: here the entry charge stops growing after three extractions (items.ts counts 14), a plate
 *  blueprint yields 5 and a charge blueprint 2. Hoisted, because vi.mock runs before the file's own constants. */
const { COUNTED, PLATES, CHARGES } = vi.hoisted(() => ({ COUNTED: 3, PLATES: 5, CHARGES: 2 }));
vi.mock("../src/economy/v2/items", async (original) => {
  const m = await original<typeof import("../src/economy/v2/items")>();
  return {
    ...m,
    VENDORS: { ...m.VENDORS, ines: { ...m.VENDORS.ines, buys: [...m.VENDORS.ines.buys.filter((x) => x !== "servo"), "servo"] } },
    BLUEPRINTS: { ...m.BLUEPRINTS, plate: { ...m.BLUEPRINTS.plate, yields: PLATES }, charge: { ...m.BLUEPRINTS.charge, yields: CHARGES } },
    invoiceStart: (extractions: number, arrears: number) =>
      m.INVOICE.entry + m.INVOICE.perExtraction * Math.min(extractions, COUNTED) + Math.min(m.INVOICE.carryInMax, Math.floor((arrears * m.INVOICE.carryInPct) / 100)),
  };
});

import { createDock, type Dock, type GameLike } from "../src/economy/v2/dock/dock";
import { createFake } from "../src/economy/v2/dock/fake";
import { invoiceParts } from "../src/economy/v2/dock/loadout";
import { BLUEPRINTS, INVOICE, invoiceStart, VENDORS } from "../src/economy/v2/items";

let docks: Dock[] = [];
async function opened() {
  const menus = document.createElement("div");
  menus.innerHTML = `<section data-s="title"><div class="m-actions"><button data-act="deploy">Deploy</button></div></section>`;
  const ui = document.createElement("div");
  ui.id = "ui";
  ui.append(menus);
  document.body.append(ui);
  const G: GameLike = { events: { on: () => () => {}, emit: () => {} }, game: { state: "title", menus: { root: menus } } };
  const v2 = createFake({ latency: 2 });
  const dock = createDock(G, v2, { host: ui, revealMs: 1 });
  docks.push(dock);
  await dock.open("title");
  await vi.waitFor(() => expect(dock.root.querySelector('.d2-tile[data-serial="S-000041"]')).toBeTruthy());
  return { dock, root: dock.root, fake: v2.fake };
}
const q = (root: ParentNode, sel: string) => {
  const el = root.querySelector<HTMLElement>(sel);
  if (!el) throw new Error(`missing ${sel}`);
  return el;
};
const k = (root: ParentNode, key: string) => {
  const el = [...root.querySelectorAll<HTMLButtonElement>("[data-k]")].find((x) => x.dataset.k === key);
  if (!el) throw new Error(`no control ${key}`);
  return el;
};
const num = (el: Element) => Number((el.textContent ?? "").replace(/[^\d.-]/g, ""));
const settled = (root: ParentNode) => vi.waitFor(() => expect(q(root, ".d2-status").dataset.state).toBe("ok"));

afterEach(() => {
  for (const d of docks) d.dispose();
  docks = [];
  document.body.replaceChildren();
});

describe("the dock follows items.ts when its numbers are tuned", () => {
  it("is running on the swapped numbers", () => {
    expect(BLUEPRINTS.plate.yields).toBe(PLATES);
    expect(BLUEPRINTS.charge.yields).toBe(CHARGES);
    expect(VENDORS.ines.buys).toContain("servo");
    expect(invoiceStart(40, 0)).toBe(invoiceStart(COUNTED, 0));
  });

  it("shows a capped entry charge as capped, with parts that still add up", async () => {
    expect(invoiceParts(9, 1240)).toEqual({
      entry: INVOICE.entry,
      history: INVOICE.perExtraction * COUNTED,
      carried: invoiceStart(0, 1240) - invoiceStart(0, 0),
      total: invoiceStart(9, 1240),
      capped: true,
    });
    expect(invoiceParts(COUNTED - 1, 0).capped).toBe(false);
    expect(invoiceParts(0, 0).capped).toBe(false);
    const { root } = await opened(); // the stand-in's player has 9 extractions and 1,240 in arrears
    await vi.waitFor(() => expect(q(root, ".d2-fence").dataset.gap).toBeTruthy());
    const total = invoiceStart(9, 1240);
    expect(q(root, ".d2-fence").dataset.start).toBe(String(total));
    const rows = q(root, ".d2-fence-rows");
    expect(rows.dataset.history).toBe(String(INVOICE.perExtraction * COUNTED)); // not 25 × 9
    expect(+rows.dataset.entry! + +rows.dataset.history! + +rows.dataset.carried!).toBe(total);
    expect(rows.textContent).toContain("9 extractions on file (capped)");
  });

  it("lets a vendor buy whatever items.ts says she buys", async () => {
    const { dock, root, fake } = await opened();
    dock.setTab("vendors");
    await vi.waitFor(() => expect(root.querySelector(".d2-bid")).toBeTruthy());
    k(root, "door:ines").click();
    expect([...root.querySelectorAll<HTMLElement>('.d2-bid[data-to="ines"]')].map((b) => b.dataset.tok)).toEqual([...VENDORS.ines.buys]);
    const bid = num(q(root, '.d2-bid[data-to="ines"][data-tok="servo"] .d2-scrip b'));
    const before = fake.balances.scrip!;
    k(root, "sell:ines:servo:1").click();
    await settled(root);
    expect(fake.balances.servo).toBe(4);
    expect(fake.balances.scrip).toBe(before + bid);
  });

  it("shows and delivers a blueprint's yield, and sells kit by the unit", async () => {
    const { dock, root, fake } = await opened();
    dock.setTab("armoury");
    await vi.waitFor(() => expect(root.querySelector('.d2-bp[data-bp="plate"]')).toBeTruthy());
    expect(q(root, '.d2-bp[data-bp="plate"] .d2-bp-n b').textContent).toBe(`Armour plate × ${PLATES}`);
    expect(q(root, '.d2-bp[data-bp="charge"] .d2-bp-n b').textContent).toBe(`Breaker charge × ${CHARGES}`);
    expect(q(root, '.d2-bp[data-bp="ammo"] .d2-bp-n b').textContent).toBe(`Magazine × ${BLUEPRINTS.ammo.yields}`);
    k(root, "build:plate").click();
    await settled(root);
    expect(fake.balances.plate).toBe(1 + PLATES);
    expect(q(root, ".d2-status").textContent).toContain(`Built ${PLATES} × Armour plate`);
    // At Ines's counter the price is for one, and one arrives.
    dock.setTab("vendors");
    await vi.waitFor(() => expect(root.querySelector(".d2-bid")).toBeTruthy());
    k(root, "door:ines").click();
    const price = num(q(root, '.d2-good[data-tok="charge"] .d2-scrip b'));
    const before = fake.balances.scrip!;
    k(root, "buy:ines:charge").click();
    await settled(root);
    expect(fake.balances.charge).toBe(2 + 1);
    expect(fake.balances.scrip).toBe(before - price);
  });
});
