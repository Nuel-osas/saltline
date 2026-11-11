// @vitest-environment happy-dom
// The Dockside's Town tab (src/economy/dockside/town.ts): the three acts, the districts, the client and the
// Harbormaster, drawn from chain.town(), and nothing but "unreachable" when that read fails.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDockside, type Dockside, type GameLike } from "../src/economy/dockside";
import type { Ctx, Read } from "../src/economy/dockside/ctx";
import { createFakeEconomy } from "../src/economy/dockside/fake";
import { createTown, DILEMMA, REVEAL, UNREACHABLE } from "../src/economy/dockside/town";
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

describe("Town tab: the acts", () => {
  it("Act I: Lockdown is now, the lights and the client are ahead, and nothing names the client", async () => {
    const { el } = townWith({ s: "ok", v: await viewAt(1) });
    expect(el.dataset.state).toBe("ok");
    expect(el.dataset.act).toBe("1");
    const acts = [...el.querySelectorAll<HTMLElement>(".dk-tw-act")];
    expect(acts.map((a) => a.dataset.state)).toEqual(["now", "next", "next"]);
    expect(acts.map((a) => q(a, ".dk-tw-act-n").textContent)).toEqual(["Lockdown", "Lights on the Water", "The Client"]);
    expect(acts[0].getAttribute("aria-current")).toBe("step");
    expect(textOf(acts[1], ".dk-tw-act-w")).toBe("When the clinic and the generators are lit");
    expect(textOf(acts[2], ".dk-tw-act-w")).toBe("When the lights are on and 8 relay cores have gone to the Quartermaster");
    expect(textOf(el, ".dk-tw-sees")).toBe("The town across the water is dark. Ines is rationing.");
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
    expect(textOf(el, ".dk-tw-hm-s")).toBe("Silent");
    expect(el.textContent).not.toContain(DILEMMA);
    expect(el.textContent).not.toContain(REVEAL);
  });

  it("Act II: the lights are on, with the dates they came on, and the client is 3 cores away", async () => {
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
  });

  it("Act III: the reveal, and the Harbormaster's strength with the drones it fields and the dilemma", async () => {
    const { el } = townWith({ s: "ok", v: await viewAt(3) });
    expect(el.dataset.act).toBe("3");
    expect([...el.querySelectorAll<HTMLElement>(".dk-tw-act")].map((a) => a.dataset.state)).toEqual(["past", "past", "now"]);
    expect(textOf(el, '.dk-tw-act[data-n="3"] .dk-tw-act-w')).toMatch(/^Reached /);
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
  it("is the fifth tab, opens on key 5, and shows the town's act on the tab itself", async () => {
    const { dock, root } = await mockDock(2);
    const tab = q(root, '.dk-tab[data-tab="town"]');
    expect(tab.textContent).toContain("Town");
    await vi.waitFor(() => expect(textOf(tab, ".dk-tab-act")).toBe("II"));
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
    // WREN holds six crates of meds in an Act I town: the clinic is at 9/15.
    localStorage.clear();
    const first = createMockChain(5, { storage: localStorage, act: 1 });
    await createMockWallet(first).claim("WREN");
    const saved = JSON.parse(localStorage.getItem(MOCK_STORAGE_KEY)!);
    saved.accounts[saved.me].balances.meds = 6;
    localStorage.setItem(MOCK_STORAGE_KEY, JSON.stringify(saved));
    const chain = createMockChain(5, { storage: localStorage });
    const { dock, root } = await dockOn(chain, createMockWallet(chain));
    await vi.waitFor(() => expect(textOf(root, ".dk-tab-act")).toBe("I"));
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

  it("shows unreachable when the contract has no town yet (METHOD_NOT_FOUND), not Act I", async () => {
    const chain = createMockChain(5, { storage: null });
    const wallet = createMockWallet(chain);
    await wallet.claim("WREN");
    const err = Object.assign(new Error("town: the contract has no town view yet"), { code: "METHOD_NOT_FOUND" });
    const older = Object.assign(Object.create(chain) as MockChain, { town: () => Promise.reject(err) });
    const { dock, root } = await dockOn(older, wallet);
    dock.tab("town");
    await vi.waitFor(() => expect(q(root, ".dk-town").dataset.state).toBe("unknown"));
    // no act, no counts: the whole body is hidden, not painted as Act I with zeros
    expect(q(root, ".dk-tw-body").hidden).toBe(true);
    expect(q(root, ".dk-town").dataset.act).toBe("0");
    expect(textOf(root, ".dk-tw-notice")).toContain(UNREACHABLE);
  });
});
