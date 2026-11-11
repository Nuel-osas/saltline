// @vitest-environment happy-dom
// The salvage module against a stand-in game context (events, HUD, input, player, weapon) and the lane's fake chain.
// No three.js here: the world layer stubs itself out, so this covers the bookkeeping, the chain calls and the cards.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeEconomy, type FakeChainOptions } from "../src/economy/salvage/fake";
import { createSalvage, type Salvage } from "../src/economy/salvage";
import { sealPoint } from "../src/economy/salvage/place";
import { SALVAGE_SPOTS } from "../src/economy/salvage/spots";
import type { Manifest } from "../src/economy/types";

function bus() {
  const m = new Map<string, ((e: unknown) => void)[]>();
  return {
    on(n: string, f: (e: unknown) => void) {
      m.set(n, [...(m.get(n) ?? []), f]);
      return () =>
        m.set(
          n,
          (m.get(n) ?? []).filter((g) => g !== f),
        );
    },
    emit(n: string, e?: unknown) {
      for (const f of m.get(n) ?? []) f(e);
    },
  };
}

function game() {
  const held = new Set<string>();
  const root = document.createElement("div");
  document.body.innerHTML = `<div class="menu"><section data-s="dead"><dl class="m-stats"><div><dt>Time survived</dt><dd>00:41</dd></div></dl></section><section data-s="complete"><dl class="m-stats"><div><dt>Time</dt><dd>04:10</dd></div></dl></section></div>`;
  document.body.append(root);
  const G = {
    events: bus(),
    params: {},
    ext: { speedScale: 1, gear: {} } as Record<string, any>,
    game: { state: "title" },
    input: { down: (k: string) => held.has(k) },
    player: { pos: { x: 0, y: 0, z: 0 }, forward: { x: 0, z: -1 }, alive: true, health: 100, maxHealth: 100 },
    weapon: { magSize: 30, ammo: 30 },
    hud: {
      root,
      prompt: null as string | null,
      progress: 0,
      markers: [] as { id: string; kind: string }[],
      messages: [] as string[],
      setPrompt(t: string | null, p = 0) {
        this.prompt = t;
        this.progress = p;
      },
      setMarkers(list: { id: string; kind: string }[]) {
        this.markers = list;
      },
      message(t: string) {
        this.messages.push(t);
      },
      feed() {},
      radio() {},
    },
    held,
  };
  return G;
}

/** The game's reset: health and magazine read G.ext.gear (game.js ext points). */
function reset(G: ReturnType<typeof game>) {
  G.player.maxHealth = 100 + (G.ext.gear.health || 0);
  G.player.health = G.player.maxHealth;
  G.weapon.magSize = 30 + (G.ext.gear.rounds || 0);
  G.weapon.ammo = G.weapon.magSize;
}

const flush = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
};

/** Stand in front of a spot's seal, facing it. */
function faceSeal(G: ReturnType<typeof game>, spot: number) {
  const s = SALVAGE_SPOTS[spot];
  const p = sealPoint(s);
  const ox = Math.cos(s.yaw),
    oz = -Math.sin(s.yaw);
  G.player.pos = { x: p.x + ox * 1.2, y: 0, z: p.z + oz * 1.2 };
  G.player.forward = { x: -ox, z: -oz };
}

/** Hold E for `secs` seconds of interaction frames. */
function hold(G: ReturnType<typeof game>, secs: number) {
  G.held.add("interact");
  let took = false;
  for (let t = 0; t < secs; t += 0.05) took = G.ext.interact(0.05) || took;
  G.held.delete("interact");
  return took;
}

const MANIFEST: Manifest = {
  runId: 41,
  startedAt: 0,
  containers: [
    { spot: 0, tokenId: "meds", amount: 2 },
    { spot: 4, tokenId: "fuel", amount: 2 },
    { spot: 7, tokenId: "copper", amount: 1 },
  ],
  wrecks: [
    {
      id: 9,
      spot: 12,
      owner: "k.testnet",
      callsign: "K. OSEI",
      items: [{ tokenId: "core", amount: 1 }],
      at: Date.now() - 2 * 3600_000,
    },
  ],
};

function setup(opts: FakeChainOptions = {}, manifest: Manifest | null = MANIFEST) {
  const G = game();
  const economy = createFakeEconomy(opts);
  if (manifest) {
    const chain = economy.chain;
    const real = chain.startRun.bind(chain);
    // A fixed manifest, registered with the fake so extract and die check against it.
    chain.startRun = async (gear) => {
      const r = await real(gear);
      if (!r.ok) return r;
      chain.runs.set(manifest.runId, manifest);
      return { ...r, manifest };
    };
  }
  const s = createSalvage(G, economy);
  return { G, economy, s };
}

let live: Salvage | null = null;
beforeEach(() => vi.useRealTimers());
afterEach(() => {
  live?.dispose();
  live = null;
});

describe("a run with a manifest", () => {
  it("cuts a seal: cargo carried, the player slowed, cargo:taken emitted", async () => {
    const { G, economy, s } = setup();
    live = s;
    const taken: unknown[] = [];
    G.events.on("cargo:taken", (e) => taken.push(e));
    G.events.emit("run:start", {});
    await flush();
    expect(s.state.status).toBe("live");
    expect(economy.manifest?.runId).toBe(41);

    faceSeal(G, 0);
    expect(G.ext.interact(0.05)).toBe(true);
    expect(G.hud.prompt).toBe("Cut seal · MEDS ×2");
    expect(hold(G, 1.0)).toBe(true);
    expect(s.state.opened).toEqual([]); // 1.6 s to cut; not yet
    hold(G, 0.7);
    expect(s.state.opened).toEqual([0]);
    expect(economy.carried).toEqual({ meds: 2 });
    expect(G.ext.speedScale).toBeCloseTo(0.88);
    expect(taken).toHaveLength(1);
    expect(document.querySelector(".sv-cargo .sv-items")?.textContent).toBe("MEDS ×2");
  });

  it("won't cut a seal from behind the container", async () => {
    const { G, s } = setup();
    live = s;
    G.events.emit("run:start", {});
    await flush();
    const sp = SALVAGE_SPOTS[0];
    const p = sealPoint(sp);
    // 1 m behind the door face, inside the box's footprint, facing the doors from the wrong side.
    G.player.pos = { x: p.x - Math.cos(sp.yaw) * 1, y: 0, z: p.z + Math.sin(sp.yaw) * 1 };
    G.player.forward = { x: Math.cos(sp.yaw), z: -Math.sin(sp.yaw) };
    expect(G.ext.interact(0.05)).toBe(false);
  });

  it("refuses a seal over the carry limit, with a dry message, and leaves it sealed", async () => {
    const { G, economy, s } = setup();
    live = s;
    G.events.emit("run:start", {});
    await flush();
    faceSeal(G, 4);
    hold(G, 1.7); // fuel ×2: 4
    faceSeal(G, 0);
    hold(G, 1.7); // meds ×2: 6, full
    expect(economy.carried).toEqual({ meds: 2, fuel: 2 });
    expect(G.ext.speedScale).toBeCloseTo(0.64);
    faceSeal(G, 7);
    hold(G, 2.5); // copper ×1 would make 7
    expect(s.state.opened).toEqual([4, 0]);
    expect(G.hud.prompt).toBe("Too heavy · COPPER ×1");
    expect(G.hud.messages).toEqual(["Load limit 6. You carry 6."]);
  });

  it("extracts with (runId, opened, wrecks) and fills the debrief", async () => {
    const { G, economy, s } = setup({ txBase: "https://testnet.nearblocks.io/txns/" });
    live = s;
    G.events.emit("run:start", {});
    await flush();
    faceSeal(G, 7);
    hold(G, 1.7);
    // The wreck lies beside spot 12's doors; stand on it and face it.
    const w = s.state.targets.find((t) => t.kind === "wreck")!;
    G.player.pos = { x: w.at.x + w.out.x * 1.2, y: 0, z: w.at.z + w.out.z * 1.2 };
    G.player.forward = { x: -w.out.x, z: -w.out.z };
    expect(G.ext.interact(0.05)).toBe(true);
    expect(G.hud.prompt).toBe("Recover wreck · K. OSEI · CORE ×1");
    hold(G, 1.7);
    expect(s.state.wrecks).toEqual([9]);

    G.events.emit("extraction:reached", {});
    const calls = economy.chain.calls.filter((c) => c.method === "extract");
    expect(calls.map((c) => c.args)).toEqual([[41, [7], [9]]]);
    expect(document.querySelector(".sv-sec")?.textContent).toContain("settling");
    await flush();
    const rows = [...document.querySelectorAll(".sv-sec .sv-row")].map((r) => r.textContent);
    // The finder keeps 70% of a wreck, rounded down: one core makes none.
    expect(rows[0]).toBe("HaulCOPPER ×1");
    expect(rows[1]).toMatch(/^Haul value\d+ scrip$/);
    const a = document.querySelector<HTMLAnchorElement>(".sv-sec a");
    expect(a?.href).toMatch(/^https:\/\/testnet\.nearblocks\.io\/txns\/fake\d+$/);
    expect(G.ext.speedScale).toBe(1);
    expect(economy.manifest).toBeNull();
  });

  it("shows a refused extraction as refused, and a lost answer as pending", async () => {
    for (const [mode, text] of [
      ["refuse", "Refused: Too soon"],
      ["reject", "unconfirmed — check the Dockside"],
    ] as const) {
      const { G, s } = setup({ modes: { extract: mode } });
      G.events.emit("run:start", {});
      await flush();
      G.events.emit("extraction:reached", {});
      await flush();
      expect(document.querySelector(".sv-sec")?.textContent).toContain(text);
      s.dispose();
    }
  });

  it("on death sends die(runId, opened, wrecks, nearest spot) and the dead card says what was lost", async () => {
    const { G, economy, s } = setup();
    live = s;
    G.events.emit("run:start", {});
    await flush();
    faceSeal(G, 0);
    hold(G, 1.7);
    G.player.pos = { x: SALVAGE_SPOTS[5].standX + 0.5, y: 0, z: SALVAGE_SPOTS[5].standZ };
    G.player.alive = false;
    G.events.emit("player:dead", {});
    expect(economy.chain.calls.filter((c) => c.method === "die").map((c) => c.args)).toEqual([[41, [0], [], 5]]);
    await flush();
    const row = document.querySelector('[data-s="dead"] .sv-row');
    expect(row?.textContent).toBe("Cargo lostMEDS ×2 — left as a wreck");
    expect(G.ext.speedScale).toBe(1);
  });

  it("adds no dead-card line when nothing was carried", async () => {
    const { G, economy, s } = setup();
    live = s;
    G.events.emit("run:start", {});
    await flush();
    G.events.emit("player:dead", {});
    await flush();
    expect(economy.chain.calls.filter((c) => c.method === "die")).toHaveLength(1);
    expect(document.querySelector('[data-s="dead"] .sv-row')).toBeNull();
  });
});

describe("the run never waits on the chain", () => {
  it("plays the baseline while the manifest is pending", async () => {
    const { G, economy, s } = setup({ modes: { startRun: "hang" } }, null);
    live = s;
    G.events.emit("run:start", {});
    await flush();
    expect(s.state.status).toBe("pending");
    faceSeal(G, 0);
    G.held.add("interact");
    expect(G.ext.interact(0.05)).toBe(false); // the relay loop clears the prompt as always
    expect(G.ext.speedScale).toBe(1);
    expect(document.querySelector(".sv-cargo .sv-items")?.textContent).toBe("Manifest pending");
    G.events.emit("extraction:reached", {});
    G.events.emit("player:dead", {});
    await flush();
    expect(economy.chain.calls.map((c) => c.method)).toEqual(["startRun"]);
    expect(document.querySelector(".sv-sec")).toBeNull();
  });

  it("ignores a manifest that arrives after the run ended", async () => {
    const { G, economy, s } = setup({ delayMs: 20 });
    live = s;
    G.events.emit("run:start", {});
    G.events.emit("player:dead", {});
    await new Promise((r) => setTimeout(r, 60));
    expect(economy.manifest).toBeNull();
    expect(economy.chain.calls.map((c) => c.method)).toEqual(["startRun"]);
  });

  it("refuses a malformed manifest and plays the baseline", async () => {
    const bad = { ...MANIFEST, containers: [{ spot: 99, tokenId: "meds", amount: 1 }] } as Manifest;
    const { G, economy, s } = setup({}, bad);
    live = s;
    G.events.emit("run:start", {});
    await flush();
    expect(s.state.status).toBe("off");
    expect(economy.manifest).toBeNull();
    expect(G.hud.messages[0]).toMatch(/No manifest/);
    expect(document.querySelector(".sv-cargo.on")).toBeNull();
  });
});

describe("gear", () => {
  it("applies equipped gear at the reset, sends it to startRun and clears it once burned", async () => {
    const { G, economy, s } = setup();
    live = s;
    economy.equipped = ["plate", "mag", "cutter"];
    s.update(0.016);
    expect(G.ext.gear).toEqual({ health: 40, rounds: 15 });
    reset(G);
    G.events.emit("run:start", {});
    expect(G.ext.gear.cutTime).toBeCloseTo(0.6); // the cutter is live for this run
    expect(economy.chain.calls[0]).toEqual({ method: "startRun", args: [["plate", "mag", "cutter"]] });
    await flush();
    expect(G.player.maxHealth).toBe(140);
    expect(G.weapon.magSize).toBe(45);
    expect(economy.equipped).toEqual([]);
    s.update(0.016);
    expect(G.ext.gear).toEqual({ cutTime: 0.6 }); // a restart would not get the plate and mag again
    // The cutter cuts seals in 0.96 s.
    faceSeal(G, 7);
    hold(G, 1.0);
    expect(s.state.opened).toEqual([7]);
  });

  it("takes the gear back when the chain refuses the run, and keeps it equipped", async () => {
    const { G, economy, s } = setup({ modes: { startRun: "refuse" } });
    live = s;
    economy.equipped = ["plate", "mag", "cutter"];
    s.update(0.016);
    reset(G);
    G.events.emit("run:start", {});
    await flush();
    expect(G.player.maxHealth).toBe(100);
    expect(G.player.health).toBe(100);
    expect(G.weapon.magSize).toBe(30);
    expect(G.weapon.ammo).toBe(30);
    expect(G.ext.gear.cutTime).toBeUndefined();
    expect(economy.equipped).toEqual(["plate", "mag", "cutter"]);
  });

  it("starts a run when attached mid-run, with no gear", async () => {
    const G = game();
    G.game.state = "playing";
    const economy = createFakeEconomy();
    economy.equipped = ["plate"];
    live = createSalvage(G, economy);
    expect(economy.chain.calls[0]).toEqual({ method: "startRun", args: [[]] });
    await flush();
    expect(live.state.status).toBe("live");
  });
});

describe("markers", () => {
  it("adds the remaining salvage to the game's markers, floating only the nearest two", async () => {
    const { G, s } = setup();
    live = s;
    G.hud.setMarkers([{ id: "relay_a", kind: "relay" }] as never);
    G.events.emit("run:start", {});
    await flush();
    const ids = G.hud.markers.map((m) => m.id);
    expect(ids[0]).toBe("relay_a");
    expect(ids).toHaveLength(1 + 3 + 1);
    expect(G.hud.markers.filter((m) => !/far/.test(m.kind) && m.kind !== "relay")).toHaveLength(2);
    // A relay cut rebuilds the game's list; ours stay.
    G.hud.setMarkers([{ id: "relay_b", kind: "relay" }] as never);
    expect(G.hud.markers.map((m) => m.id)[0]).toBe("relay_b");
    expect(G.hud.markers).toHaveLength(5);
  });
});
