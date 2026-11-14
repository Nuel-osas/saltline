// @vitest-environment happy-dom
// The Vendors tab's SELL EVERYTHING: one line on what to do, each lot's best buyer and why, one button; the sales go
// through the chain one at a time and each answer is checked (a refusal stops, no answer is pending). And the
// debrief's SELL HAUL, which opens the dock there.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDock, type Dock, type GameLike } from "../src/economy/v2/dock/dock";
import { createFake, type FakeV2 } from "../src/economy/v2/dock/fake";
import { haulOf, nextStep } from "../src/economy/v2/dock/haul";

const n = (v: number) => v.toLocaleString("en-US");
const num = (el: Element) => Number((el.textContent ?? "").replace(/[^\d.-]/g, ""));

// ---- the dock, on the dev stand-in ----
function fakeGame(state = "complete") {
  const menus = document.createElement("div");
  menus.className = "menu";
  menus.innerHTML = `
    <section data-s="title"><div class="m-actions"><button class="btn primary" data-act="deploy">Deploy</button></div></section>
    <section data-s="dead"><div class="m-actions col"><button class="btn primary" data-act="retry">Retry</button></div></section>
    <section data-s="complete"><dl class="m-stats"><div><dt>Time</dt><dd>01:39</dd></div></dl><div class="m-actions col"><button class="btn primary" data-act="redeploy">Redeploy</button></div></section>`;
  const ui = document.createElement("div");
  ui.id = "ui";
  ui.append(menus);
  document.body.append(ui);
  const G: GameLike & { game: { state: string; menus: { root: HTMLElement } } } = { events: { on: () => () => {}, emit: () => {} }, game: { state, menus: { root: menus } } };
  return { G, menus, ui };
}
let docks: Dock[] = [];
function setup(edit?: (v2: FakeV2) => void) {
  const game = fakeGame();
  const v2: FakeV2 = createFake({ registered: true, latency: 2 });
  edit?.(v2);
  const dock = createDock(game.G, v2, { host: game.ui, revealMs: 1, gate: { quietMs: 5, askMs: 400 } });
  docks.push(dock);
  return { ...game, v2, fake: v2.fake, dock, root: dock.root };
}
const q = <T extends Element = HTMLElement>(root: ParentNode, sel: string) => {
  const el = root.querySelector<T>(sel);
  if (!el) throw new Error(`missing ${sel}`);
  return el as T;
};
afterEach(() => {
  for (const d of docks) d.dispose();
  docks = [];
  document.body.replaceChildren();
});

describe("SELL EVERYTHING", () => {
  async function vendorsTab(edit?: (v2: FakeV2) => void) {
    const s = setup(edit);
    s.dock.setTab("vendors");
    await s.dock.open("complete");
    await vi.waitFor(() => expect(s.root.querySelector(".d2-sellall")).toBeTruthy());
    return s;
  }
  /** Wraps the chain's sale calls: records each one and that only one is ever out at a time. */
  function watch(s: ReturnType<typeof setup>, answer?: (i: number) => "ok" | "refuse" | "pending") {
    const sent: string[] = [];
    let out = 0;
    let most = 0;
    for (const m of ["sell", "exportGoods"] as const) {
      const real = (s.v2.chain[m] as (...a: unknown[]) => Promise<unknown>).bind(s.v2.chain);
      (s.v2.chain as unknown as Record<string, unknown>)[m] = async (...a: unknown[]) => {
        const mode = answer?.(sent.length) ?? "ok";
        sent.push(`${m}:${a.join(":")}`);
        if (mode !== "ok") s.fake.next = mode;
        out++;
        most = Math.max(most, out);
        try {
          return await real(...a);
        } finally {
          out--;
        }
      };
    }
    return { sent, most: () => most };
  }

  it("shows one line on what to do, then each lot's best buyer and why, and one button with the total", async () => {
    const { root, fake } = await vendorsTab();
    expect(q(root, ".d2-haul-lede").textContent).toBe("Sell what you carried out. Each lot goes to whoever pays most today.");
    expect(root.querySelector(".d2-haul")?.compareDocumentPosition(q(root, ".d2-counter")) ?? 0).toBe(Node.DOCUMENT_POSITION_FOLLOWING); // above the tables
    const lots = [...root.querySelectorAll<HTMLElement>(".d2-lot:not(.none)")];
    const held = haulOf(fake.balances).reduce((s, it) => s + it.amount, 0);
    expect(lots.length).toBeGreaterThan(1);
    for (const l of lots) {
      expect(q(l, ".d2-lot-to").textContent).toMatch(/^→ (Moss|Ines|The export desk)$/);
      expect(q(l, ".d2-lot-why").textContent!.length).toBeGreaterThan(3);
    }
    const servo = q(root, '.d2-lot[data-tok="servo"][data-to="moss"] .d2-lot-why');
    expect(servo.textContent).toBe("No servos, no Longshores. I'm paying over the odds."); // Moss's own reason, as the chain gives it
    const total = lots.reduce((s, l) => s + num(q(l, ".d2-lot-p b")), 0);
    expect(q(root, ".d2-sellall").textContent).toBe(`Sell everything to the best buyer · about ${n(total)} scrip`);
    expect(held).toBeGreaterThan(0);
  });

  it("sells lot by lot through the chain, one call out at a time, then says what it made and the next step", async () => {
    const s = await vendorsTab();
    const w = watch(s);
    const before = s.fake.balances.scrip!;
    const lots = s.root.querySelectorAll(".d2-lot:not(.none)").length;
    q<HTMLButtonElement>(s.root, ".d2-sellall").click();
    await vi.waitFor(() => expect(s.root.querySelector(".d2-haul-gain")).toBeTruthy(), { timeout: 4000 });
    expect(w.sent.length).toBe(lots);
    expect(w.most()).toBe(1);
    const gained = s.fake.balances.scrip! - before;
    expect(gained).toBeGreaterThan(0);
    expect(q(s.root, ".d2-haul-gain").textContent).toBe(`+${n(gained)}scrip`); // what the chain paid, not the estimate
    expect(haulOf(s.fake.balances)).toEqual([]);
    expect(q(s.root, ".d2-status").textContent).toBe(`Sold all ${lots} lots for ${n(gained)} scrip.`);
    await vi.waitFor(() => expect(s.root.querySelector(".d2-haul-next p")).toBeTruthy());
    const r = s.dock.ctx.reads;
    const step = nextStep({ balances: r.balances.s === "ok" ? r.balances.v : null, vendors: r.vendors.s === "ok" ? r.vendors.v : null, listings: r.listings.s === "ok" ? r.listings.v : null, me: s.fake.me });
    expect(q(s.root, ".d2-haul-next p").textContent).toBe(step!.text);
    expect(step!.text).toMatch(/^You can afford a [A-D]-grade \w+ for [\d,]+ scrip on /);
  });

  it("stops at a refused sale: says who turned it down and why, counts only what sold, and the rest stays", async () => {
    const s = await vendorsTab();
    const w = watch(s, (i) => (i === 1 ? "refuse" : "ok"));
    const before = s.fake.balances.scrip!;
    q<HTMLButtonElement>(s.root, ".d2-sellall").click();
    await vi.waitFor(() => expect(s.root.querySelector('.d2-haul-line[data-state="refused"]')).toBeTruthy(), { timeout: 4000 });
    expect(w.sent.length).toBe(2); // nothing sent after the refusal
    expect(q(s.root, ".d2-haul-gain").textContent).toBe(`+${n(s.fake.balances.scrip! - before)}scrip`);
    expect(q(s.root, '.d2-haul-line[data-state="refused"]').textContent).toContain("turned down");
    expect(q(s.root, '.d2-haul-line[data-state="refused"]').textContent).toContain("The dock is closed for inspection");
    expect(haulOf(s.fake.balances).length).toBeGreaterThan(0);
    expect(s.root.querySelector(".d2-sellall")).toBeTruthy(); // the rest can be sold again
  });

  it("an unanswered sale is pending, never failed and never done", async () => {
    const s = await vendorsTab();
    const w = watch(s, (i) => (i === 0 ? "pending" : "ok"));
    q<HTMLButtonElement>(s.root, ".d2-sellall").click();
    await vi.waitFor(() => expect(s.root.querySelector('.d2-haul-line[data-state="pending"]')).toBeTruthy(), { timeout: 4000 });
    expect(w.sent.length).toBe(1);
    const line = q(s.root, '.d2-haul-line[data-state="pending"]').textContent!;
    expect(line).toContain("may still settle");
    expect(line).not.toMatch(/fail/i);
    expect(q(s.root, ".d2-haul-gain").dataset.state).toBe("pending");
    expect(s.root.querySelector(".d2-haul-next")).toBeNull(); // no "here is what it buys" on a sale nobody confirmed
    expect(q(s.root, ".d2-status").dataset.state).toBe("pending");
  });

  it("sells nothing blind: with the counters unread, who pays most is unknown and there is no button", async () => {
    const s = setup((v2) => v2.fake.failViews.add("vendors"));
    s.dock.setTab("vendors");
    await s.dock.open("complete");
    await vi.waitFor(() => expect(s.root.querySelector(".d2-haul .d2-empty.unk")).toBeTruthy());
    expect(q(s.root, ".d2-haul .d2-empty").textContent).toBe("Who pays most: unknown. The counters can't be read right now, so nothing is sold blind.");
    expect(s.root.querySelector(".d2-sellall")).toBeNull();
  });
});

describe("the debrief's SELL HAUL", () => {
  it("is the card's one primary button when there is cargo to sell, first, and opens the dock on the vendors", async () => {
    const s = setup();
    const sell = q<HTMLButtonElement>(s.menus, '[data-d2="complete"]');
    await vi.waitFor(() => expect(sell.textContent).toBe("Sell haul"));
    const redeploy = q(s.menus, '[data-act="redeploy"]');
    expect(sell.classList.contains("primary")).toBe(true);
    expect(redeploy.classList.contains("primary")).toBe(false); // REDEPLOY steps back
    expect(s.menus.querySelectorAll('[data-s="complete"] .btn.primary').length).toBe(1);
    expect(sell.nextElementSibling).toBe(redeploy);
    sell.click();
    await vi.waitFor(() => expect(s.dock.gate).toBe("in"));
    expect(s.dock.tab).toBe("vendors");
    await vi.waitFor(() => expect(s.root.querySelector(".d2-sellall")).toBeTruthy());
  });

  it("stays the plain DOCK button under REDEPLOY when there is nothing to sell", async () => {
    const s = setup((v2) => {
      for (const k of Object.keys(v2.fake.balances)) if (k !== "scrip") delete (v2.fake.balances as Record<string, number>)[k];
    });
    await vi.waitFor(() => expect(q(s.menus, '[data-d2="complete"] .d2-entry-n').textContent).toContain("scrip"));
    const dock = q(s.menus, '[data-d2="complete"]');
    expect(dock.textContent).toContain("Dock");
    expect(dock.classList.contains("primary")).toBe(false);
    expect(q(s.menus, '[data-act="redeploy"]').classList.contains("primary")).toBe(true);
  });
});
