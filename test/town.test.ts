// @vitest-environment happy-dom
// The Dockside's Town tab (src/economy/dockside/town.ts): the three acts, the districts, the client and the
// Harbormaster, drawn from chain.town(), and nothing but "unreachable" when that read fails.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDockside, type Dockside, type GameLike } from "../src/economy/dockside";
import type { Ctx, Read } from "../src/economy/dockside/ctx";
import { createFakeEconomy } from "../src/economy/dockside/fake";
import { createPass } from "../src/economy/dockside/pass";
import { CORE_HOME } from "../src/economy/dockside/stall";
import { createTown, DILEMMA, REVEAL, UNREACHABLE } from "../src/economy/dockside/town";
import { BROKERS } from "../src/economy/items";
import { createMockChain, createMockWallet, MOCK_STORAGE_KEY, type MockChain } from "../src/economy/mock";
import type { Economy, TownView } from "../src/economy/types";

const T0 = 1_800_000_000_000;

const q = <T extends Element = HTMLElement>(root: ParentNode, sel: string) => {
  const el = root.querySelector<T>(sel);
  if (!el) throw new Error(`missing ${sel}`);
  return el as T;
};
const textOf = (root: ParentNode, sel: string) => q(root, sel).textContent ?? "";

/** The tab on its own, with a chain that only needs a network and a contract id for the ledger link. */
function townWith(read: Read<TownView>, chain: { network: "mock" | "testnet"; contractId: string } = { network: "mock", contractId: "saltline.mock" }) {
  const refresh = vi.fn(async () => {});
  const ctx = { chain, reads: { town: read }, refresh } as unknown as Ctx;
  const town = createTown(ctx);
  document.body.append(town.el);
  return { el: town.el, update: town.update, ctx, refresh };
}

async function viewAt(act: 1 | 2 | 3): Promise<TownView> {
  return createMockChain(5, { storage: null, now: () => T0, act }).town();
}

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
});

describe("Town tab: the chapters", () => {
  it("Chapter 1: Proof of Delivery is now, the lights and the client are ahead, and nothing names the client", async () => {
    const { el } = townWith({ s: "ok", v: await viewAt(1) });
    expect(el.dataset.state).toBe("ok");
    expect(el.dataset.act).toBe("1");
    const acts = [...el.querySelectorAll<HTMLElement>(".dk-tw-act")];
    expect(acts.map((a) => a.dataset.state)).toEqual(["now", "next", "next"]);
    expect(acts.map((a) => q(a, ".dk-tw-act-n").textContent)).toEqual(["Proof of Delivery", "Bill of Lading", "Final Notice"]);
    expect(acts.map((a) => q(a, ".dk-tw-act-k").textContent)).toEqual(["Chapter 1Now", "Chapter 2Now", "Chapter 3Now"]); // "Now" shows on the current one only
    expect(el.textContent).not.toMatch(/\bAct\b/);
    expect(textOf(acts[0], ".dk-tw-act-w")).toBe("Since the town was impounded");
    expect(acts[0].getAttribute("aria-current")).toBe("step");
    expect(textOf(acts[1], ".dk-tw-act-w")).toBe("When the clinic and the generators are lit");
    expect(textOf(acts[2], ".dk-tw-act-w")).toBe("When the lights are on and 8 relay cores have gone to the Quartermaster");
    expect(textOf(el, ".dk-tw-sees")).toBe("The town needs its cargo. The Harbormaster needs a signature. The town across the water is dark. Ines is rationing.");
    expect(textOf(el, ".dk-tw-status")).toBe("Dark");
    expect(el.dataset.clinic).toBe("dark");
    expect(el.dataset.gen).toBe("dark");

    // the districts
    const clinic = q(el, '.dk-tw-d[data-d="clinic"]');
    expect(clinic.dataset.lit).toBe("false");
    expect(textOf(clinic, ".dk-tw-dl")).toBe("9/15 meds delivered");
    expect(textOf(clinic, ".dk-tw-lamp")).toBe("Dark");
    expect(clinic.querySelectorAll(".dk-tw-cells i")).toHaveLength(15);
    expect(clinic.querySelectorAll(".dk-tw-cells i.on")).toHaveLength(9);
    const gen = q(el, '.dk-tw-d[data-d="generators"]');
    expect(textOf(gen, ".dk-tw-dl")).toBe("4/10 fuel cells delivered");
    expect(gen.querySelectorAll(".dk-tw-cells i.on")).toHaveLength(4);

    // the client is still a question
    const client = q(el, ".dk-tw-client");
    expect(client.dataset.revealed).toBe("false");
    expect(textOf(client, ".dk-tw-client-l")).toBe("3/8 relay cores to the Quartermaster's client");
    expect(client.querySelectorAll(".dk-tw-pips i.on")).toHaveLength(3);
    expect(client.textContent).not.toContain("Harbormaster");
    // the Harbormaster is silent, and the dilemma isn't told before the reveal
    expect(textOf(el, ".dk-tw-hm-n")).toBe("0");
    expect(textOf(el, ".dk-tw-hm-d")).toBe("+0 drones a wave");
    expect(textOf(el, ".dk-tw-hm-s")).toBe("Billing");
    expect(el.textContent).not.toContain(DILEMMA);
    expect(el.textContent).not.toContain(REVEAL);
  });

  it("Chapter 2: the lights are on, with the dates they came on, and the client is 3 cores away", async () => {
    const v = await viewAt(2);
    const { el } = townWith({ s: "ok", v });
    expect(el.dataset.act).toBe("2");
    const acts = [...el.querySelectorAll<HTMLElement>(".dk-tw-act")];
    expect(acts.map((a) => a.dataset.state)).toEqual(["past", "now", "next"]);
    expect(textOf(acts[1], ".dk-tw-act-w")).toMatch(/^Reached \d{1,2} \w{3} · \d\d:\d\d$/);
    expect(textOf(el, ".dk-tw-status")).toBe("Lights on the water");
    expect(el.dataset.clinic).toBe("lit");
    expect(el.dataset.gen).toBe("lit");
    for (const d of el.querySelectorAll<HTMLElement>(".dk-tw-d")) {
      expect(d.dataset.lit).toBe("true");
      expect(textOf(d, ".dk-tw-lamp")).toBe("Lit");
    }
    expect(textOf(el, '.dk-tw-d[data-d="clinic"] .dk-tw-dl')).toMatch(/^17\/15 meds delivered · lit \d{1,2} \w{3} · \d\d:\d\d$/);
    expect(q(el, '.dk-tw-d[data-d="clinic"]').querySelectorAll(".dk-tw-cells i.on")).toHaveLength(15);
    expect(textOf(el, ".dk-tw-client-l")).toBe("5/8 relay cores to the Quartermaster's client");
    expect(textOf(el, ".dk-tw-client-n")).toBe("He won't name his client. The ledger will, at 8.");
    expect(el.textContent).not.toContain("client is the Harbormaster");
    expect(textOf(el, ".dk-tw-sees .dk-tw-line")).toBe("The lights are back. The Harbormaster has noticed the discrepancy.");
    // Chapter 3's line would give the client away: it isn't shown while that chapter is ahead.
    expect(el.textContent).not.toContain("would like its cores back");
  });

  it("Chapter 3: the reveal, and the Harbormaster's strength with the drones it fields and the dilemma", async () => {
    const { el } = townWith({ s: "ok", v: await viewAt(3) });
    expect(el.dataset.act).toBe("3");
    expect([...el.querySelectorAll<HTMLElement>(".dk-tw-act")].map((a) => a.dataset.state)).toEqual(["past", "past", "now"]);
    expect(textOf(el, '.dk-tw-act[data-n="3"] .dk-tw-act-w')).toMatch(/^Reached /);
    expect(textOf(el, '.dk-tw-act[data-n="1"] .dk-tw-act-w')).toBe("The town was impounded");
    // The chapter's own line, only once it has begun (before, it would name the client).
    expect(textOf(el, ".dk-tw-sees .dk-tw-line")).toBe("The client has been identified. The client would like its cores back.");
    const client = q(el, ".dk-tw-client");
    expect(client.dataset.revealed).toBe("true");
    expect(textOf(client, ".dk-tw-client-h")).toBe(REVEAL);
    expect(textOf(client, ".dk-tw-k")).toMatch(/Revealed \d{1,2} \w{3} · \d\d:\d\d/);
    expect(textOf(el, ".dk-tw-hm-n")).toBe("62");
    expect(textOf(el, ".dk-tw-hm-d")).toBe("+2 drones a wave");
    expect(textOf(el, ".dk-tw-hm-l")).toBe(DILEMMA);
    expect(textOf(el, ".dk-tw-hm-s")).toBe("Rebuilding");
    const meter = q(el, ".dk-tw-meter");
    expect(meter.getAttribute("aria-valuenow")).toBe("62");
    expect(q(el, ".dk-tw-hm-fill").style.width).toBe("62%");
    expect(el.style.getPropertyValue("--hm")).toBe("0.62");
  });

  it("says one drone, not one drones; and a starved Harbormaster after the reveal reads as starved", async () => {
    const v = await viewAt(3);
    const { el, update, ctx } = townWith({ s: "ok", v: { ...v, harbormaster: { strength: 31, recentCores: 3100, bonusDrones: 1 } } });
    expect(textOf(el, ".dk-tw-hm-d")).toBe("+1 drone a wave");
    (ctx.reads as { town: Read<TownView> }).town = { s: "ok", v: { ...v, harbormaster: { strength: 0, recentCores: 0, bonusDrones: 0 } } };
    update();
    expect(textOf(el, ".dk-tw-hm-s")).toBe("Starved");
    expect(textOf(el, ".dk-tw-hm-d")).toBe("+0 drones a wave");
  });

  it("links the open ledger to the contract on the explorer, on testnet", async () => {
    const { el } = townWith({ s: "ok", v: await viewAt(1) }, { network: "testnet", contractId: "saltline.testnet" });
    expect(textOf(el, ".dk-tw-foot")).toContain("Written on the open ledger.");
    const a = q<HTMLAnchorElement>(el, ".dk-tw-link a");
    expect(a.getAttribute("href")).toBe("https://testnet.nearblocks.io/address/saltline.testnet");
    expect(a.textContent).toBe("saltline.testnet on NEAR testnet ↗");
    const offline = townWith({ s: "ok", v: await viewAt(1) });
    expect(offline.el.querySelector(".dk-tw-link a")).toBeNull();
    expect(textOf(offline.el, ".dk-tw-link")).toBe("The mock ledger, offline");
  });
});

describe("Town tab: a failed or missing read", () => {
  it("hides every number and says the Dock Office ledger is unreachable, never zeros", () => {
    const { el, refresh } = townWith({ s: "unknown", error: "town: the contract has no town view yet" });
    expect(el.dataset.state).toBe("unknown");
    expect(q(el, ".dk-tw-body").hidden).toBe(true);
    const notice = q(el, ".dk-tw-notice");
    expect(notice.hidden).toBe(false);
    expect(textOf(notice, "h3")).toBe(UNREACHABLE);
    expect(notice.textContent).not.toMatch(/\d/);
    q<HTMLButtonElement>(notice, "button").click();
    expect(refresh).toHaveBeenCalledWith("town");
  });

  it("says it's reading while the first read is out", () => {
    const { el } = townWith({ s: "loading" });
    expect(el.dataset.state).toBe("loading");
    expect(q(el, ".dk-tw-body").hidden).toBe(true);
    expect(textOf(el, ".dk-tw-notice")).toContain("Reading the Dock Office ledger");
  });
});

// ---- in the Dockside itself ----

function fakeGame() {
  const menus = document.createElement("div");
  menus.className = "menu";
  menus.innerHTML = `<section data-s="title"><div class="m-actions"><button class="btn primary" data-act="deploy">Deploy</button></div></section>`;
  const ui = document.createElement("div");
  ui.id = "ui";
  ui.append(menus);
  document.body.append(ui);
  const G: GameLike = { events: { on: () => () => {}, emit: () => {} }, game: { state: "title", menus: { root: menus } } };
  return { G, ui };
}

let docks: Dockside[] = [];
afterEach(() => {
  for (const d of docks) {
    d.close();
    d.deployGate.dispose();
  }
  docks = [];
});

async function dockOn(chain: MockChain | Economy["chain"], wallet: Economy["wallet"]) {
  const { G, ui } = fakeGame();
  const dock = createDockside(G, { chain, wallet, manifest: null, carried: {} }, { host: ui });
  docks.push(dock);
  await dock.open("title");
  await vi.waitFor(() => expect(dock.gate).toBe("in"));
  return { dock, root: dock.root };
}

async function mockDock(act: 1 | 2 | 3) {
  const chain = createMockChain(5, { storage: null, act });
  const wallet = createMockWallet(chain);
  await wallet.claim("WREN");
  return { chain, ...(await dockOn(chain, wallet)) };
}

describe("Town tab in the Dockside", () => {
  it("is the fifth tab, opens on key 5, and shows the town's chapter on the tab itself", async () => {
    const { dock, root } = await mockDock(2);
    const tab = q(root, '.dk-tab[data-tab="town"]');
    expect(tab.textContent).toContain("Town");
    await vi.waitFor(() => expect(textOf(tab, ".dk-tab-act")).toBe("Ch 2"));
    expect(q(tab, ".dk-tab-act").dataset.act).toBe("2");
    q<HTMLButtonElement>(root, '.dk-tab[data-tab="stalls"]').focus();
    q(root, '.dk-tab[data-tab="stalls"]').dispatchEvent(new KeyboardEvent("keydown", { code: "Digit5", bubbles: true }));
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "Digit5", bubbles: true }));
    await vi.waitFor(() => expect(root.dataset.tab).toBe("town"));
    expect(q(root, '[data-pane="town"]').hidden).toBe(false);
    expect(q(root, ".dk-town").dataset.act).toBe("2");
    dock.tab("stalls");
  });

  it("moves when your own sale lights a district", async () => {
    // WREN holds six crates of meds in a Chapter 1 town: the clinic is at 9/15.
    localStorage.clear();
    const first = createMockChain(5, { storage: localStorage, act: 1 });
    await createMockWallet(first).claim("WREN");
    const saved = JSON.parse(localStorage.getItem(MOCK_STORAGE_KEY)!);
    saved.accounts[saved.me].balances.meds = 6;
    localStorage.setItem(MOCK_STORAGE_KEY, JSON.stringify(saved));
    const chain = createMockChain(5, { storage: localStorage });
    const { dock, root } = await dockOn(chain, createMockWallet(chain));
    await vi.waitFor(() => expect(textOf(root, ".dk-tab-act")).toBe("Ch 1"));
    const all = q<HTMLButtonElement>(root, '.dk-stall[data-broker="ines"] .dk-q[data-tok="meds"] [data-a="sellall"]');
    await vi.waitFor(() => expect(all.disabled).toBe(false));
    all.click();
    dock.tab("town");
    await vi.waitFor(() => expect(q(root, '.dk-tw-d[data-d="clinic"]').dataset.lit).toBe("true"));
    expect(textOf(root, '.dk-tw-d[data-d="clinic"] .dk-tw-dl')).toMatch(/^15\/15 meds delivered · lit /);
    expect(q(root, ".dk-town").dataset.clinic).toBe("lit");
    expect(textOf(root, ".dk-tw-status")).toBe("The clinic is lit");
    expect(q(root, ".dk-town").dataset.act).toBe("1"); // the generators are still dark
  });

  it("runs the town's lines along the open ledger as news, and the reveal as a warning", async () => {
    const { root } = await mockDock(3);
    await vi.waitFor(() => expect(root.querySelectorAll(".dk-tk-i.town").length).toBe(4));
    expect(textOf(root, ".dk-tk-k")).toBe("Open ledger");
    const hm = [...root.querySelectorAll<HTMLElement>(".dk-tk-i.town.hm")];
    expect(hm).toHaveLength(1);
    expect(hm[0].textContent).toContain(REVEAL);
    expect(q(hm[0], ".dk-tk-dot").dataset.kind).toBe("act");
    const texts = [...root.querySelectorAll(".dk-tk-i.town .dk-tk-t")].map((t) => t.textContent);
    expect(texts).toContain("The clinic's lights are back on.");
    expect(texts).toContain("The town across the water is lit again.");
  });

  it("doesn't touch the stalls on a chain without a town view", async () => {
    const eco = createFakeEconomy({ registered: true, latency: 2 });
    const { root } = await dockOn(eco.chain, eco.wallet);
    await vi.waitFor(() => expect(q(root, '.dk-stall[data-broker="qm"]').dataset.open).toBe("open"));
    expect(q(root, '.dk-stall[data-broker="qm"]').dataset.client).toBeUndefined();
    expect(textOf(root, '.dk-stall[data-broker="qm"] .dk-blurb')).toBe(BROKERS.qm.blurb);
  });

  it("shows unreachable on a chain without a town view, and the stalls carry on", async () => {
    const eco = createFakeEconomy({ registered: true, latency: 2 });
    const { dock, root } = await dockOn(eco.chain, eco.wallet);
    dock.tab("town");
    await vi.waitFor(() => expect(q(root, ".dk-town").dataset.state).toBe("unknown"));
    expect(textOf(root, ".dk-tw-notice h3")).toBe(UNREACHABLE);
    expect(q(root, ".dk-tw-body").hidden).toBe(true);
    expect(q(root, ".dk-tab-act").hidden).toBe(true);
    dock.tab("stalls");
    await vi.waitFor(() => expect(q(root, '.dk-stall[data-broker="moss"]').dataset.open).toBe("open"));
  });

  it("shows unreachable when the contract has no town yet (METHOD_NOT_FOUND), not Chapter 1", async () => {
    const chain = createMockChain(5, { storage: null });
    const wallet = createMockWallet(chain);
    await wallet.claim("WREN");
    const err = Object.assign(new Error("town: the contract has no town view yet"), { code: "METHOD_NOT_FOUND" });
    const older = Object.assign(Object.create(chain) as MockChain, { town: () => Promise.reject(err) });
    const { dock, root } = await dockOn(older, wallet);
    dock.tab("town");
    await vi.waitFor(() => expect(q(root, ".dk-town").dataset.state).toBe("unknown"));
    // no act, no counts: the whole body is hidden, not painted as Chapter 1 with zeros
    expect(q(root, ".dk-tw-body").hidden).toBe(true);
    expect(q(root, ".dk-town").dataset.act).toBe("0");
    expect(textOf(root, ".dk-tw-notice")).toContain(UNREACHABLE);
  });
});

describe("The story's copy on the stalls and the pass", () => {
  it("uses docs/STORY.md's broker blurbs", () => {
    expect(BROKERS.moss.blurb).toBe("Rebuilding the sea wall from what you drag out. Measures everything in tonnes, including you.");
    expect(BROKERS.ines.blurb).toBe("Runs the clinic's stores and the generators. Will cry at your story and still pay two scrip less.");
    expect(BROKERS.qm.blurb).toBe("Buys relay cores for a client he won't name. Pays better than anyone. Smiles a lot.");
    expect(BROKERS.qm.blurbRevealed).toBe("Buying for the Harbormaster. Still pays better than anyone. Still smiling.");
  });

  it("issues the dock pass from the Dock Office, on the open ledger", () => {
    const chain = createMockChain(5, { storage: null });
    const pass = createPass({ chain, wallet: createMockWallet(chain), onDone: () => {} });
    expect(textOf(pass.el, ".m-k")).toBe("Dock Office · Open Ledger");
    expect(textOf(pass.el, ".dk-pc-ledger")).toBe("Written on the open ledger");
    expect(textOf(pass.el, ".dk-pc-meta")).toMatch(/^Dock Office · issued /);
    expect(pass.el.textContent).not.toContain("Port Authority");
  });
});

/** A mock town at `act`, with WREN holding `hold`, through a reload of the saved state (as the browser would). */
async function dockWithHold(act: 1 | 2 | 3, hold: Record<string, number>) {
  localStorage.clear();
  const first = createMockChain(5, { storage: localStorage, act });
  await createMockWallet(first).claim("WREN");
  const saved = JSON.parse(localStorage.getItem(MOCK_STORAGE_KEY)!);
  Object.assign(saved.accounts[saved.me].balances, hold);
  localStorage.setItem(MOCK_STORAGE_KEY, JSON.stringify(saved));
  const chain = createMockChain(5, { storage: localStorage });
  return { chain, ...(await dockOn(chain, createMockWallet(chain))) };
}
const qm = (root: ParentNode) => q(root, '.dk-stall[data-broker="qm"]');
const tipOf = (root: ParentNode, broker: string, tok: string) => {
  const btn = q(root, `.dk-stall[data-broker="${broker}"] .dk-q[data-tok="${tok}"] .dk-price`);
  return q(root, `[id="${btn.getAttribute("aria-describedby")}"]`).textContent ?? "";
};

describe("The Quartermaster after the reveal", () => {
  it("before it: his own blurb, no tag, no dilemma on his core bid", async () => {
    const { root } = await mockDock(2);
    await vi.waitFor(() => expect(textOf(root, ".dk-tab-act")).toBe("Ch 2"));
    await vi.waitFor(() => expect(qm(root).dataset.open).toBe("open"));
    expect(qm(root).dataset.client).toBeUndefined();
    expect(q(qm(root), ".dk-hm-tag").hidden).toBe(true);
    expect(textOf(qm(root), ".dk-blurb")).toBe("Buys relay cores for a client he won't name. Pays better than anyone. Smiles a lot.");
    expect(tipOf(root, "qm", "core")).not.toContain(DILEMMA);
  });

  it("after it: a red tag on his awning, his after-reveal blurb, and the dilemma behind his core bid only", async () => {
    const { root } = await mockDock(3);
    await vi.waitFor(() => expect(qm(root).dataset.client).toBe("harbormaster"));
    const tag = q(qm(root), ".dk-hm-tag");
    expect(tag.hidden).toBe(false);
    expect(tag.textContent).toBe("Buying for the Harbormaster");
    expect(textOf(qm(root), ".dk-blurb")).toBe("Buying for the Harbormaster. Still pays better than anyone. Still smiling.");
    await vi.waitFor(() => expect(tipOf(root, "qm", "core")).toContain(DILEMMA));
    expect(tipOf(root, "qm", "fuel")).not.toContain(DILEMMA);
    // the other brokers are as they were
    for (const b of ["moss", "ines"]) {
      expect(q(root, `.dk-stall[data-broker="${b}"]`).dataset.client).toBeUndefined();
      expect(q(root, `.dk-stall[data-broker="${b}"] .dk-hm-tag`).hidden).toBe(true);
    }
    expect(textOf(root, '.dk-stall[data-broker="moss"] .dk-blurb')).toBe(BROKERS.moss.blurb);
  });

  it("selling him a core says where it goes, while it settles and with the result; fuel says nothing", async () => {
    const { root } = await dockWithHold(3, { core: 3, fuel: 1 });
    await vi.waitFor(() => expect(qm(root).dataset.client).toBe("harbormaster"));
    const warn = q(qm(root), ".dk-hm-warn");
    const slot = q(qm(root), ".dk-slot");
    expect(warn.hidden).toBe(true);
    const sell1 = q<HTMLButtonElement>(qm(root), '.dk-q[data-tok="core"] [data-a="sell1"]');
    await vi.waitFor(() => expect(sell1.disabled).toBe(false));
    sell1.click();
    // settling: the receipt says so, and the warning is already up
    expect(slot.dataset.state).toBe("pending");
    expect(warn.hidden).toBe(false);
    expect(warn.textContent).toBe(CORE_HOME);
    await vi.waitFor(() => expect(slot.dataset.state).toBe("ok"));
    expect(slot.textContent).toContain("Sold 1 core");
    expect(warn.hidden).toBe(false);
    expect(warn.textContent).toBe("That core goes home to the Harbormaster.");
    // not a modal: nothing else on the Dockside is blocked
    expect(root.querySelector('[role="alertdialog"], [aria-modal="true"] [aria-modal="true"]')).toBeNull();

    const all = q<HTMLButtonElement>(qm(root), '.dk-q[data-tok="core"] [data-a="sellall"]');
    await vi.waitFor(() => expect(all.disabled).toBe(false));
    all.click();
    await vi.waitFor(() => expect(slot.textContent).toContain("Sold 2 core"));
    expect(warn.textContent).toBe("Those 2 cores go home to the Harbormaster.");

    const fuel = q<HTMLButtonElement>(qm(root), '.dk-q[data-tok="fuel"] [data-a="sell1"]');
    await vi.waitFor(() => expect(fuel.disabled).toBe(false));
    fuel.click();
    await vi.waitFor(() => expect(slot.textContent).toContain("Sold 1 fuel"));
    expect(warn.hidden).toBe(true);
  });

  it("no warning before the reveal, and none for a sale the dock refused", async () => {
    const before = await dockWithHold(2, { core: 2 });
    await vi.waitFor(() => expect(textOf(before.root, ".dk-tab-act")).toBe("Ch 2"));
    const s1 = q<HTMLButtonElement>(qm(before.root), '.dk-q[data-tok="core"] [data-a="sell1"]');
    await vi.waitFor(() => expect(s1.disabled).toBe(false));
    s1.click();
    await vi.waitFor(() => expect(q(qm(before.root), ".dk-slot").dataset.state).toBe("ok"));
    expect(q(qm(before.root), ".dk-hm-warn").hidden).toBe(true);
    before.dock.close();
    document.body.replaceChildren();

    const after = await dockWithHold(3, { core: 1 });
    await vi.waitFor(() => expect(qm(after.root).dataset.client).toBe("harbormaster"));
    // the core went elsewhere between the read and the call: the dock refuses, and nothing went home
    after.chain.sell = async () => ({ ok: false, error: "You've only got 0 relay cores.", code: "E_FUNDS" });
    const b = q<HTMLButtonElement>(qm(after.root), '.dk-q[data-tok="core"] [data-a="sell1"]');
    await vi.waitFor(() => expect(b.disabled).toBe(false));
    b.click();
    await vi.waitFor(() => expect(q(qm(after.root), ".dk-slot").dataset.state).toBe("error"));
    expect(q(qm(after.root), ".dk-hm-warn").hidden).toBe(true);
  });
});
