// @vitest-environment happy-dom
// The deploy gate (src/economy/dockside/gate.ts) with the real Dockside on the lane's fake economy, against a stand-in
// for the game's menus: its four cards and a click dispatch that starts a run the way game.js does (a bubble listener
// on the menu root, keyed by data-act).
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDockside, type Dockside, type GameLike } from "../src/economy/dockside";
import { createFakeEconomy, type FakeEconomy } from "../src/economy/dockside/fake";

function fakeGame(state: string) {
  const menus = document.createElement("div");
  menus.className = "menu";
  menus.innerHTML = `
    <section data-s="title"><div class="m-actions"><button class="btn primary" data-act="deploy">Deploy</button><button class="btn" data-act="settings">Settings</button></div></section>
    <section data-s="paused"><div class="m-actions col"><button class="btn primary" data-act="resume">Resume</button><button class="btn" data-act="restart">Restart mission</button></div></section>
    <section data-s="dead"><div class="m-actions col"><button class="btn primary" data-act="retry">Retry</button></div></section>
    <section data-s="complete"><div class="m-actions col"><button class="btn primary" data-act="redeploy">Redeploy</button></div></section>`;
  const ui = document.createElement("div");
  ui.id = "ui";
  ui.append(menus);
  document.body.append(ui);
  const started: string[] = [];
  const G: GameLike & { game: { state: string; menus: { root: HTMLElement; panelOpen: boolean } } } = {
    events: { on: () => () => {}, emit: () => {} },
    game: { state, menus: { root: menus, panelOpen: false } },
  };
  // game.js: s.addEventListener("click", …) → e[act]() → U() → the run starts (state goes to intro).
  menus.addEventListener("click", (e) => {
    const act = (e.target as Element).closest<HTMLElement>("button")?.dataset.act;
    if (act && ["deploy", "restart", "retry", "redeploy"].includes(act)) {
      started.push(act);
      G.game.state = "intro";
    }
  });
  const press = (act: string) => menus.querySelector<HTMLButtonElement>(`[data-act="${act}"]`)!.click();
  return { G, menus, ui, started, press };
}

let docks: Dockside[] = [];
function setup(opts: { registered?: boolean; state?: string; latency?: number; hang?: boolean } = {}) {
  const game = fakeGame(opts.state ?? "title");
  const eco: FakeEconomy = createFakeEconomy({ registered: opts.registered ?? false, latency: opts.latency ?? 4 });
  if (opts.hang) vi.spyOn(eco.wallet, "registered").mockImplementation(() => new Promise<boolean>(() => {}));
  const dock = createDockside(game.G, eco, { host: game.ui, gate: { quietMs: 10, askMs: 80 } });
  docks.push(dock);
  return { ...game, eco, dock, root: dock.root };
}
const q = <T extends Element = HTMLElement>(root: ParentNode, sel: string) => {
  const el = root.querySelector<T>(sel);
  if (!el) throw new Error(`missing ${sel}`);
  return el as T;
};
function claim(root: HTMLElement, callsign: string) {
  const input = q<HTMLInputElement>(root, ".dk-cs-in");
  input.value = callsign;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  q(root, ".dk-pass-form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
}

afterEach(() => {
  for (const d of docks) {
    d.close();
    d.deployGate.dispose();
  }
  docks = [];
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe("the deploy gate", () => {
  it("lets a registered player's press straight through", async () => {
    const { dock, started, press } = setup({ registered: true });
    await vi.waitFor(() => expect(dock.deployGate.known).toBe(true));
    press("deploy");
    expect(started).toEqual(["deploy"]); // synchronously: nothing held, nothing opened
    expect(dock.isOpen).toBe(false);
  });

  it("holds an unregistered press and opens the dock pass card, then a claim carries on into that run", async () => {
    const { dock, root, eco, started, press } = setup({ registered: false });
    await vi.waitFor(() => expect(dock.deployGate.known).toBe(false));
    press("deploy");
    expect(started).toEqual([]);
    await vi.waitFor(() => expect(dock.gate).toBe("pass"));
    const pass = q(root, ".dk-pass");
    expect(pass.textContent).toContain("Sign on before you go over the fence. Your pass carries your cargo, your wrecks and your name on the board.");
    expect(q(root, ".dk-claim").textContent).toBe("Claim pass and deploy");
    expect(q(root, ".dk-skip").textContent).toContain("Play without a pass");

    claim(root, "wren");
    await vi.waitFor(() => expect(q(root, ".dk-pass-status").dataset.state).toBe("ok"));
    expect(q(root, ".dk-pass-status").textContent).toContain("Over the fence");
    expect(started).toEqual([]); // the stamp lands first
    await vi.waitFor(() => expect(started).toEqual(["deploy"]), { timeout: 3000 });
    expect(dock.isOpen).toBe(false);
    expect(eco.passless).toBeFalsy();
    // from now on the gate knows: the next press goes straight through
    expect(dock.deployGate.known).toBe(true);
  });

  it("treats an unknown pass status as ask, never skip", async () => {
    const { dock, root, eco, started, press } = setup({ registered: false, hang: true });
    expect(dock.deployGate.known).toBe(null);
    press("deploy");
    expect(started).toEqual([]);
    await vi.waitFor(() => expect(dock.gate).toBe("checking"));
    await vi.waitFor(() => expect(dock.gate).toBe("pass"));
    expect(q(root, ".dk-pass-status").dataset.state).toBe("unknown");
    expect(q(root, ".dk-pass-status").textContent).toContain("unknown");
    // they may hold a pass already: the way on is the normal run, not the passless one
    q<HTMLButtonElement>(root, ".dk-skip").click();
    expect(started).toEqual(["deploy"]);
    expect(eco.passless).toBeFalsy();
  });

  it("'Play without a pass' deploys the baseline once, and the next press asks again", async () => {
    const { dock, root, eco, started, press, G } = setup({ registered: false, state: "dead" });
    press("retry");
    await vi.waitFor(() => expect(dock.gate).toBe("pass"));
    expect(q(root, ".dk-claim").textContent).toBe("Claim pass and retry");
    expect(q(root, ".dk-skip").textContent).toContain("no salvage this run");
    q<HTMLButtonElement>(root, ".dk-skip").click();
    expect(started).toEqual(["retry"]);
    expect(eco.passless).toBe(true);
    expect(dock.isOpen).toBe(false);

    // the run starts and salvage takes the flag (salvage.test.ts covers that side); back on the dead card…
    eco.passless = false;
    G.game.state = "dead";
    press("retry");
    expect(started).toEqual(["retry"]);
    await vi.waitFor(() => expect(dock.gate).toBe("pass"));
  });

  it("deploys as before when the pass can't be checked at all", async () => {
    const { dock, eco, started, press } = setup({ registered: false });
    eco.chain.failing.add("registered");
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    press("deploy");
    await vi.waitFor(() => expect(started).toEqual(["deploy"]));
    expect(dock.gate).not.toBe("pass");
    expect(eco.passless).toBeFalsy();
    expect(info).toHaveBeenCalled();
  });

  it("backing out of the card starts nothing", async () => {
    const { dock, started, press } = setup({ registered: false });
    press("deploy");
    await vi.waitFor(() => expect(dock.gate).toBe("pass"));
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "Escape", key: "Escape", bubbles: true }));
    expect(dock.isOpen).toBe(false);
    expect(dock.deployGate.pending).toBe(null);
    expect(started).toEqual([]);
  });

  it("holds the title's Enter-to-deploy and the pause card's Restart too", async () => {
    const t = setup({ registered: false });
    document.body.dispatchEvent(new KeyboardEvent("keydown", { code: "Enter", key: "Enter", bubbles: true }));
    await vi.waitFor(() => expect(t.dock.gate).toBe("pass"));
    expect(t.started).toEqual([]);
    t.dock.close();
    t.dock.deployGate.dispose();
    document.body.replaceChildren();

    const p = setup({ registered: false, state: "paused" });
    p.press("restart");
    await vi.waitFor(() => expect(p.dock.gate).toBe("pass"));
    expect(p.root.dataset.from).toBe("paused");
    expect(q(p.root, ".dk-claim").textContent).toBe("Claim pass and restart");
    claim(p.root, "kite");
    await vi.waitFor(() => expect(p.started).toEqual(["restart"]), { timeout: 3000 });
  });

  it("leaves the cards' other buttons alone", async () => {
    const { dock, menus, press } = setup({ registered: false });
    const settings = vi.fn();
    menus.querySelector('[data-act="settings"]')!.addEventListener("click", settings);
    press("settings");
    expect(settings).toHaveBeenCalledTimes(1);
    expect(dock.deployGate.pending).toBe(null);
  });
});
