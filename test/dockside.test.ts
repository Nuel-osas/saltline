// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDockside, type Dockside, type GameLike } from "../src/economy/dockside";
import { createFakeEconomy, type FakeEconomy } from "../src/economy/dockside/fake";
import { checkCallsign } from "../src/economy/dockside/format";
import { buildModel, bidAt, closedBands, hourToX, weekEvents } from "../src/economy/dockside/week";
import type { BrokerId, SimPoint } from "../src/economy/types";

// ---- a stand-in for the game: its menu cards and event bus, nothing else ----
function fakeGame(state = "title") {
  const menus = document.createElement("div");
  menus.className = "menu";
  menus.innerHTML = `
    <section data-s="title"><div class="m-actions"><button class="btn primary" data-act="deploy">Deploy</button></div></section>
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

let docks: Dockside[] = [];
async function setup(opts: { registered?: boolean; state?: string; latency?: number } = {}) {
  const game = fakeGame(opts.state);
  const eco: FakeEconomy = createFakeEconomy({ registered: opts.registered ?? true, latency: opts.latency ?? 4 });
  const dock = createDockside(game.G, eco, { host: game.ui });
  docks.push(dock);
  return { ...game, eco, dock, root: dock.root };
}
async function openIn(dock: Dockside) {
  await dock.open("title");
  await vi.waitFor(() => expect(dock.gate).toBe("in"));
}
const q = <T extends Element = HTMLElement>(root: ParentNode, sel: string) => {
  const el = root.querySelector<T>(sel);
  if (!el) throw new Error(`missing ${sel}`);
  return el as T;
};
const row = (root: ParentNode, b: BrokerId, tok: string) => q(root, `.dk-stall[data-broker="${b}"] .dk-q[data-tok="${tok}"]`);
const priceOf = (root: ParentNode, b: BrokerId, tok: string) => q(row(root, b, tok), ".dk-flap").dataset.value;

afterEach(() => {
  for (const d of docks) d.close();
  docks = [];
  document.body.replaceChildren();
});

describe("Dockside: rendering from the chain", () => {
  it("draws the three stalls with their prices, and Ines shuttered", async () => {
    const { dock, root } = await setup();
    await openIn(dock);
    await vi.waitFor(() => expect(priceOf(root, "moss", "copper")).toBe("40"));
    const stalls = [...root.querySelectorAll<HTMLElement>(".dk-stall")];
    expect(stalls.map((s) => s.dataset.broker)).toEqual(["moss", "ines", "qm"]);
    expect(stalls.map((s) => q(s, ".dk-bname").textContent)).toEqual(["Moss", "Ines", "Quartermaster"]);
    expect(stalls.map((s) => s.dataset.open)).toEqual(["open", "shut", "open"]);
    expect(q(root, '.dk-stall[data-broker="ines"] .dk-shutter').classList.contains("down")).toBe(true);
    // bids for what each broker buys, asks for the gear it sells
    expect(priceOf(root, "moss", "chips")).toBe("84");
    expect(priceOf(root, "moss", "cutter")).toBe("66");
    expect(priceOf(root, "qm", "core")).toBe("247");
    // the float gauge and the hold
    expect(q(root, '.dk-stall[data-broker="moss"] .dk-g-float .dk-g-n').textContent).toBe("1,240");
    await vi.waitFor(() => expect(q(root, ".dk-hold-scrip .dk-flap").dataset.value).toBe("412"));
    expect(q(root, ".dk-me b").textContent).toBe("412");
  });

  it("puts the broker's reason and the agent's last note behind every price", async () => {
    const { dock, root, eco } = await setup();
    await openIn(dock);
    await vi.waitFor(() => expect(priceOf(root, "qm", "core")).toBe("247"));
    const views = await eco.chain.brokers();
    for (const v of views)
      for (const quote of [...v.bids, ...v.asks]) {
        const btn = q<HTMLButtonElement>(row(root, v.id, quote.tokenId), ".dk-price");
        const tip = q(root, `[id="${btn.getAttribute("aria-describedby")}"]`);
        expect(tip.textContent).toContain(quote.reason);
        expect(tip.textContent).toContain(v.lastMemo!);
      }
    // focusing a price shows the floating copy
    const btn = q<HTMLButtonElement>(row(root, "moss", "copper"), ".dk-price");
    btn.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    const floating = q(root, ".dk-tip");
    expect(floating.classList.contains("on")).toBe(true);
    expect(floating.textContent).toContain("Moss pays · Copper coil");
    expect(floating.textContent).toContain(views[0].bids[0].reason);
  });
});

describe("Dockside: failed reads", () => {
  it("shows unknown, never 0, when the brokers, balances and ledger can't be read", async () => {
    const { dock, root, eco } = await setup();
    eco.chain.failing.add("brokers");
    eco.chain.failing.add("balances");
    eco.chain.failing.add("recent");
    await openIn(dock);
    await vi.waitFor(() => expect(q(root, '.dk-stall[data-broker="moss"]').dataset.open).toBe("unknown"));
    await vi.waitFor(() => expect(q(root, ".dk-me b").textContent).toBe("unknown"));

    const copper = row(root, "moss", "copper");
    expect(q(copper, ".dk-flap").hidden).toBe(true);
    expect(q(copper, ".dk-unknown").hidden).toBe(false);
    expect(q(copper, ".dk-unknown").textContent).toBe("unknown");
    expect(q(copper, ".dk-q-sub").textContent).toBe("stock unknown · you unknown");
    expect(q(root, '.dk-stall[data-broker="moss"] .dk-g-float .dk-g-n').textContent).toBe("unknown");
    // the hold: no zero scrip, no zero cargo
    expect(q(root, ".dk-hold-scrip .dk-flap").hidden).toBe(true);
    expect(q(root, ".dk-hold-scrip .dk-unknown").hidden).toBe(false);
    for (const b of root.querySelectorAll(".dk-hlist b")) expect(b.textContent).toBe("unknown");
    // selling is off while the price is unknown
    for (const b of copper.querySelectorAll("button.dk-b")) expect((b as HTMLButtonElement).disabled).toBe(true);
    await vi.waitFor(() => expect(q(root, ".dk-tk").textContent).toContain("Ledger unknown"));

    // the chain comes back: the values return
    eco.chain.failing.clear();
    await dock.refresh("brokers", "balances");
    expect(priceOf(root, "moss", "copper")).toBe("40");
    expect(q(root, ".dk-me b").textContent).toBe("412");
  });

  it("shows the pass status as unknown when the dock office can't be reached", async () => {
    const { dock, root, eco } = await setup({ registered: false });
    eco.chain.failing.add("registered");
    await dock.open("title");
    await vi.waitFor(() => expect(dock.gate).toBe("unknown"));
    expect(q(root, ".dk-gate").textContent).toContain("unknown");
  });
});

describe("Dockside: selling", () => {
  it("goes settling → sold → the price drops on the board", async () => {
    const { dock, root } = await setup({ latency: 30 });
    await openIn(dock);
    await vi.waitFor(() => expect(priceOf(root, "moss", "copper")).toBe("40"));
    const slot = q(root, '.dk-stall[data-broker="moss"] .dk-slot');
    expect(slot.dataset.state).toBe("idle");

    q<HTMLButtonElement>(row(root, "moss", "copper"), '[data-a="sell1"]').click();
    expect(slot.dataset.state).toBe("pending");
    expect(slot.textContent).toContain("Settling…");
    // nothing else freezes: only this stall's buttons wait
    expect(q<HTMLButtonElement>(row(root, "moss", "copper"), '[data-a="sell1"]').disabled).toBe(true);
    expect(q<HTMLButtonElement>(row(root, "qm", "core"), '[data-a="sell1"]').disabled).toBe(false);

    await vi.waitFor(() => expect(slot.dataset.state).toBe("ok"));
    expect(slot.textContent).toContain("Sold 1 copper · +40 scrip");
    await vi.waitFor(() => expect(priceOf(root, "moss", "copper")).toBe("39"));
    expect(q(row(root, "moss", "copper"), ".dk-tr").dataset.dir).toBe("-1");
    expect(q(row(root, "moss", "copper"), ".dk-q-sub").textContent).toBe("stock 23/12 · you 4");
    await vi.waitFor(() => expect(q(root, ".dk-hold-scrip .dk-flap").dataset.value).toBe("452"));
  });

  it("shows the dock's refusal as an error, and a dropped call as unknown rather than failed", async () => {
    const { dock, root, eco } = await setup();
    await openIn(dock);
    await vi.waitFor(() => expect(priceOf(root, "moss", "copper")).toBe("40"));
    const slot = q(root, '.dk-stall[data-broker="moss"] .dk-slot');
    eco.chain.failing.add("sell");
    q<HTMLButtonElement>(row(root, "moss", "copper"), '[data-a="sell1"]').click();
    await vi.waitFor(() => expect(slot.dataset.state).toBe("unknown"));
    expect(slot.textContent).toContain("may still settle");
    eco.chain.failing.clear();
    eco.chain.state.brokers.moss.open = false; // shut between the read and the call
    q<HTMLButtonElement>(row(root, "moss", "copper"), '[data-a="sell1"]').click();
    await vi.waitFor(() => expect(slot.dataset.state).toBe("error"));
    expect(slot.textContent).toContain("Moss is shut until someone invests");
  });
});

describe("Dockside: investing", () => {
  it("reopens a shuttered stall and shows your share", async () => {
    const { dock, root } = await setup();
    await openIn(dock);
    const ines = q(root, '.dk-stall[data-broker="ines"]');
    await vi.waitFor(() => expect(ines.dataset.open).toBe("shut"));
    expect(q(ines, ".dk-shutter-t").textContent).toBe("Float 62 of 400 to reopen");
    const reopen = q<HTMLButtonElement>(ines, ".dk-chip[data-need]");
    expect(reopen.textContent).toBe("Reopen 338");
    expect(reopen.getAttribute("aria-pressed")).toBe("true");
    const go = q<HTMLButtonElement>(ines, ".dk-invest .dk-b.solid");
    expect(go.textContent).toBe("Invest 338");
    go.click();
    expect(q(ines, ".dk-slot").dataset.state).toBe("pending");
    await vi.waitFor(() => expect(ines.dataset.open).toBe("open"));
    expect(q(ines, ".dk-slot").textContent).toContain("Invested 338 · Ines reopens");
    expect(q(ines, ".dk-shutter").classList.contains("down")).toBe(false);
    // 338 of 378 shares
    expect(q(ines, ".dk-share").textContent).toBe("Your share 89% · 2 investors");
    await vi.waitFor(() => expect(q(root, ".dk-hold-scrip .dk-flap").dataset.value).toBe("74"));
  });
});

describe("Dockside: player market and leaderboard", () => {
  it("posts a listing, cancels it, and buys someone else's", async () => {
    const { dock, root } = await setup();
    await openIn(dock);
    dock.tab("market");
    await vi.waitFor(() => expect(root.querySelectorAll(".dk-mk-list:not(.mine) .dk-mk-row").length).toBe(5));
    // post 2 copper at 45
    q<HTMLButtonElement>(root, '.dk-market .dk-chip[data-t="copper"]').click();
    q<HTMLButtonElement>(root, '.dk-market [aria-label="More amount"]').click();
    for (let i = 0; i < 5; i++) q<HTMLButtonElement>(root, '.dk-market [aria-label="More each"]').click();
    expect(q(root, ".dk-mk-hint").textContent).toContain("Total 90");
    q<HTMLButtonElement>(root, ".dk-market .dk-b.wide").click();
    const slot = q(root, ".dk-market .dk-slot");
    expect(slot.dataset.state).toBe("pending");
    await vi.waitFor(() => expect(root.querySelectorAll(".dk-mk-list.mine .dk-mk-row").length).toBe(1));
    expect(q(root, ".dk-mk-list.mine").textContent).toContain("Copper coil ×2");
    await vi.waitFor(() => expect(q(root, ".dk-hlist b").textContent).toBe("×3"));
    // cancel it: the copper comes back
    q<HTMLButtonElement>(root, ".dk-mk-list.mine .dk-b").click();
    await vi.waitFor(() => expect(root.querySelectorAll(".dk-mk-list.mine .dk-mk-row").length).toBe(0));
    await vi.waitFor(() => expect(q(root, ".dk-hlist b").textContent).toBe("×5"));
    // buy HOOK's relay core for 205
    const hook = [...root.querySelectorAll<HTMLElement>(".dk-mk-row")].find((r) => r.textContent!.includes("HOOK"))!;
    q<HTMLButtonElement>(hook, ".dk-b").click();
    await vi.waitFor(() => expect(slot.textContent).toContain("Bought 1 core for 205"));
    await vi.waitFor(() => expect(q(root, ".dk-hold-scrip .dk-flap").dataset.value).toBe("207"));
  });

  it("lights your row on the leaderboard", async () => {
    const { dock, root } = await setup();
    await openIn(dock);
    dock.tab("board");
    await vi.waitFor(() => expect(root.querySelectorAll(".dk-lb-row").length).toBeGreaterThan(10));
    const mine = [...root.querySelectorAll<HTMLElement>(".dk-lb-row.mine")];
    expect(mine.length).toBeGreaterThan(0);
    for (const r of mine) expect(r.textContent).toContain("WREN");
    expect(root.querySelectorAll('.dk-lb-row[aria-current="true"]').length).toBe(mine.length);
  });
});

describe("Dockside: the dock pass card", () => {
  it("checks callsigns the way the contract does", () => {
    expect(checkCallsign("wren")).toEqual({ ok: true, callsign: "WREN" });
    expect(checkCallsign("  k. osei_2-b ")).toEqual({ ok: true, callsign: "K. OSEI_2-B" });
    expect(checkCallsign("ab")).toMatchObject({ ok: false, error: "At least 3 characters." });
    expect(checkCallsign("x".repeat(17))).toMatchObject({ ok: false, error: "16 characters at most." });
    expect(checkCallsign("x".repeat(16)).ok).toBe(true);
    expect(checkCallsign("wren!")).toMatchObject({ ok: false });
    expect((checkCallsign("wren!") as { error: string }).error).toContain("“!”");
    expect(checkCallsign("émile").ok).toBe(false);
    expect(checkCallsign("   ").ok).toBe(false);
  });

  it("refuses a bad callsign without calling the chain, then claims a good one", async () => {
    const { dock, root, eco } = await setup({ registered: false });
    const claim = vi.spyOn(eco.wallet, "claim");
    await dock.open("title");
    await vi.waitFor(() => expect(dock.gate).toBe("pass"));
    expect(q(root, ".dk-pass").textContent).toContain("Your dock pass comes with 150 scrip.");
    expect(q(root, ".dk-what").textContent).toContain("mock ledger");

    const input = q<HTMLInputElement>(root, ".dk-cs-in");
    const form = q<HTMLFormElement>(root, ".dk-pass-form");
    const submit = () => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    const hint = q(root, ".dk-cs-hint");

    input.value = "ab";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    submit();
    expect(hint.dataset.state).toBe("error");
    expect(hint.textContent).toBe("At least 3 characters.");
    expect(claim).not.toHaveBeenCalled();

    input.value = "wren#1";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(hint.dataset.state).toBe("error");
    submit();
    expect(claim).not.toHaveBeenCalled();

    input.value = "wren";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(input.value).toBe("WREN");
    expect(q(root, ".dk-pc-name").textContent).toBe("WREN");
    expect(hint.dataset.state).toBe("ok");
    submit();
    expect(claim).toHaveBeenCalledWith("WREN");
    expect(q(root, ".dk-pass-status").dataset.state).toBe("pending");
    await vi.waitFor(() => expect(q(root, ".dk-pass-status").dataset.state).toBe("ok"));
    await vi.waitFor(() => expect(dock.gate).toBe("in"), { timeout: 3000 });
    await vi.waitFor(() => expect(q(root, ".dk-hold-scrip .dk-flap").dataset.value).toBe("150"));
  });

  it("shows the dock office's refusal", async () => {
    const { dock, root } = await setup({ registered: false });
    await dock.open("title");
    await vi.waitFor(() => expect(dock.gate).toBe("pass"));
    const input = q<HTMLInputElement>(root, ".dk-cs-in");
    input.value = "hook";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    q(root, ".dk-pass-form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(q(root, ".dk-pass-status").dataset.state).toBe("error"));
    expect(q(root, ".dk-pass-status").textContent).toBe("Callsign taken.");
    expect(q<HTMLButtonElement>(root, ".dk-claim").disabled).toBe(false);
  });
});

describe("Dockside: ways in and out", () => {
  it("adds a way in to the title, dead and debrief cards, and never opens mid-run", async () => {
    const { dock, menus, G } = await setup();
    expect(menus.querySelector('[data-s="title"] .dk-dock')).not.toBeNull();
    expect(menus.querySelector('[data-s="dead"] .dk-entry')).not.toBeNull();
    expect(menus.querySelector('[data-s="complete"] .dk-entry')).not.toBeNull();
    G.game.state = "playing";
    await dock.open();
    expect(dock.isOpen).toBe(false);
  });

  it("Deploy closes the Dockside and presses the card's own button, with the gear picked", async () => {
    const { dock, root, menus, eco, G } = await setup({ state: "dead" });
    const retry = vi.fn();
    menus.querySelector('[data-act="retry"]')!.addEventListener("click", retry);
    q<HTMLButtonElement>(menus, '[data-s="dead"] .dk-entry').click();
    await vi.waitFor(() => expect(dock.gate).toBe("in"));
    expect(G.events).toBeTruthy();
    await vi.waitFor(() => expect(q(root, ".dk-hrow.gear .dk-equip").hasAttribute("disabled")).toBe(false));
    q<HTMLButtonElement>(root, ".dk-hrow.gear .dk-equip").click(); // armour plate
    expect(eco.equipped).toEqual(["plate"]);
    expect(q(root, ".dk-next").textContent).toBe("Next run: Armour plate");
    q<HTMLButtonElement>(root, ".dk-deploy").click();
    expect(dock.isOpen).toBe(false);
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("Esc closes the Dockside", async () => {
    const { dock } = await setup();
    await openIn(dock);
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "Escape", key: "Escape", bubbles: true }));
    expect(dock.isOpen).toBe(false);
  });
});

// ---- the fast-forward chart's data mapping ----
function week(spec: Record<BrokerId, (h: number) => boolean>, hours = 10): SimPoint[] {
  return Array.from({ length: hours + 1 }, (_, hour) => ({
    hour,
    brokers: {
      moss: { open: spec.moss(hour), scrip: 500 - hour, bids: { copper: 60 - hour, chips: 75 }, stock: {} },
      ines: { open: spec.ines(hour), scrip: 300, bids: { meds: 90, fuel: 110 + hour * 2 }, stock: {} },
      qm: { open: spec.qm(hour), scrip: 200, bids: { core: 160, fuel: 120 }, stock: {} },
    },
  }));
}

describe("A week on the docks: data mapping", () => {
  const pts = week({ moss: (h) => h < 3 || h > 5, ines: (h) => h >= 3, qm: (h) => h < 9 });

  it("maps hours to x across the plot", () => {
    expect(hourToX(0, 0, 168, 10, 178)).toBe(10);
    expect(hourToX(168, 0, 168, 10, 178)).toBe(178);
    expect(hourToX(84, 0, 168, 10, 178)).toBe(94);
    expect(hourToX(24, 0, 168, 0, 700)).toBeCloseTo(100);
    expect(hourToX(5, 5, 5, 3, 9)).toBe(3); // an empty span doesn't divide by zero
  });

  it("finds the shuttered bands, including one open at the start and one still shut at the end", () => {
    expect(closedBands(pts, "moss")).toEqual([{ from: 3, to: 6 }]);
    expect(closedBands(pts, "ines")).toEqual([{ from: 0, to: 3 }]);
    expect(closedBands(pts, "qm")).toEqual([{ from: 9, to: 10 }]);
    expect(closedBands(week({ moss: () => true, ines: () => true, qm: () => true }), "moss")).toEqual([]);
  });

  it("lists every shut and reopen in order, with the float at the time", () => {
    expect(weekEvents(pts).map((e) => `${e.broker}:${e.kind}@${e.hour}`)).toEqual(["moss:close@3", "ines:reopen@3", "moss:reopen@6", "qm:close@9"]);
    expect(weekEvents(pts)[0].scrip).toBe(497);
  });

  it("interpolates a bid between hours and builds one lane per broker", () => {
    expect(bidAt(pts, "moss", "copper", 2.5)).toBeCloseTo(57.5);
    expect(bidAt(pts, "ines", "fuel", 0)).toBe(110);
    expect(bidAt(pts, "ines", "fuel", 99)).toBe(130);
    const m = buildModel(pts);
    expect(m.h0).toBe(0);
    expect(m.h1).toBe(10);
    expect(m.lanes.map((l) => l.id)).toEqual(["moss", "ines", "qm"]);
    expect(m.lanes[0].bands).toEqual([{ from: 3, to: 6 }]);
    const [lo, hi] = m.lanes[0].range;
    expect(lo).toBeLessThanOrEqual(50);
    expect(hi).toBeGreaterThanOrEqual(75);
  });

  it("the fake's own week has a story in it: a shutdown and a reopening", async () => {
    const eco = createFakeEconomy({ latency: 0 });
    const pts = await eco.chain.simulate(168, 20, 4207);
    expect(pts).toHaveLength(169);
    const kinds = new Set(weekEvents(pts).map((e) => e.kind));
    expect(kinds).toEqual(new Set(["close", "reopen"]));
  });
});
