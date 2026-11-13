// @vitest-environment happy-dom
// The coach (src/economy/v2/coach): the rifle in its crate, the first raid's checklist and the once-ever moments.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FRAMES, INVOICE, ISSUE } from "../src/economy/v2/items";
import type { Weapon } from "../src/economy/v2/types";
import type { YardTarget } from "../src/economy/v2/raid";
import { FINISH } from "../src/economy/v2/raid/rules";
import { COACH_KEY, Checklist, TUNE, loadCoach, type ChecklistView } from "../src/economy/v2/coach/checklist";
import { MOMENT, ORDER, crateGun, deathLine, deviceOf, lineText, stepLine, type Device, type StepId } from "../src/economy/v2/coach/copy";
import { CRATE_AHEAD, placeCrate, type CrateWorld } from "../src/economy/v2/coach/crate";
import { TAKE_SECONDS, createCoach } from "../src/economy/v2/coach";

const text = (id: StepId, device: Device = "kbm") => {
  const line = stepLine(id, device);
  return line ? lineText(line) : null;
};

// ---------------------------------------------------------------------------------------------------------------
describe("the lines", () => {
  it("are the nine of a first raid, in order, for keyboard and mouse", () => {
    expect(ORDER.map((id) => text(id))).toEqual([
      "TAKE THE RIFLE — hold E at the crate",
      "MOVE — W A S D · LOOK — mouse",
      "A SEALED CONTAINER — follow the marker, hold E to cut the seal",
      "EVERYTHING GOES ON THE INVOICE — at 1,200 it sends the Bailiff",
      "CARGO SLOWS YOU — 6 is the limit",
      "FIRE — left mouse · AIM — right mouse · RELOAD — R",
      "G — BREAKER CHARGE · F — RIFLE BUTT",
      "CUT THE THREE UPLINKS — hold E at each",
      "THE BOAT — quay ladder, south end",
    ]);
  });

  it("name a gamepad's buttons, and say the charge has none", () => {
    expect(text("rifle", "pad")).toBe("TAKE THE RIFLE — hold Y at the crate");
    expect(text("move", "pad")).toBe("MOVE — left stick · LOOK — right stick");
    expect(text("seal", "pad")).toBe("A SEALED CONTAINER — follow the marker, hold Y to cut the seal");
    expect(text("fire", "pad")).toBe("FIRE — RT · AIM — LT · RELOAD — X");
    expect(text("kit", "pad")).toBe("RB — RIFLE BUTT · BREAKER CHARGE — G on the keyboard");
    expect(text("uplinks", "pad")).toBe("CUT THE THREE UPLINKS — hold Y at each");
  });

  it("name the touch buttons, and have no kit line where there is no button for it", () => {
    expect(text("rifle", "touch")).toBe("TAKE THE RIFLE — hold USE at the crate");
    expect(text("move", "touch")).toBe("MOVE — left thumb · LOOK — right thumb");
    expect(text("fire", "touch")).toBe("FIRE — FIRE · AIM — AIM · RELOAD — RLD");
    expect(text("uplinks", "touch")).toBe("CUT THE THREE UPLINKS — hold USE at each");
    expect(text("kit", "touch")).toBeNull();
  });

  it("read the input the way the game's own prompt does: touch, then a gamepad while the mouse isn't captured", () => {
    expect(deviceOf({ touch: false, gamepad: false, locked: true })).toBe("kbm");
    expect(deviceOf({ touch: true, gamepad: true, locked: false })).toBe("touch");
    expect(deviceOf({ touch: false, gamepad: true, locked: false })).toBe("pad");
    expect(deviceOf({ touch: false, gamepad: true, locked: true })).toBe("kbm");
    expect(deviceOf(null)).toBe("kbm");
  });

  it("the invoice line names the threshold this raid's Harbormaster set", () => {
    expect(lineText(stepLine("invoice", "kbm", { bailiffAt: 1080 })!)).toBe("EVERYTHING GOES ON THE INVOICE — at 1,080 it sends the Bailiff");
  });

  it("the moments and the first death's card", () => {
    expect(lineText(MOMENT.bailiff.line("kbm"))).toBe("IT CAN'T BE DESTROYED — drop it with fire or a charge, then run");
    expect(lineText(MOMENT.wreck.line("kbm"))).toBe("ANOTHER BREACHER'S WRECK — hold E to take what they lost");
    expect(lineText(MOMENT.wreck.line("touch"))).toBe("ANOTHER BREACHER'S WRECK — hold USE to take what they lost");
    expect(deathLine(null, "machines")).toMatch(/^THE ISSUE RIFLE IS NEVER LOST/);
    expect(deathLine({ frame: "pilot", serial: "S-000023" }, "machines")).toBe("PILOT S-000023 STAYS WHERE YOU FELL — whoever carries it to the boat keeps it. Build or buy the next one at the DOCK.");
    expect(deathLine({ frame: "pilot", serial: "S-000023" }, "bailiff")).toBe("PILOT S-000023 IS IMPOUNDED — buy it back at the DOCK within 48 hours.");
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("the checklist", () => {
  const playing = { device: "kbm" as Device, playing: true };
  /** Runs the clocks for `seconds`, and returns every line that was lit on the way (each once per showing). */
  const run = (list: Checklist, seconds: number, o = playing) => {
    const seen: StepId[] = [];
    let v: ChecklistView = list.view;
    for (let t = 0; t < seconds - 1e-9; t += 0.05) {
      v = list.tick(0.05, o);
      if (v.step && !v.ticked && seen[seen.length - 1] !== v.step) seen.push(v.step);
    }
    return { seen, v };
  };
  const fresh = (o: { signed?: boolean; device?: Device; taught?: StepId[] } = {}) => {
    const taught: StepId[] = [];
    const list = new Checklist(o.taught ?? [], (id) => taught.push(id));
    list.begin({ signed: o.signed ?? true, device: o.device ?? "kbm" });
    return { list, taught };
  };
  /** Gets the list as far as `id` being lit, doing each line before it the way a player would. */
  const reach = (list: Checklist, id: StepId) => {
    const acts: Record<StepId, () => void> = {
      rifle: () => list.did("rifle"),
      move: () => list.walk(TUNE.walk),
      seal: () => (list.did("seal"), list.carry(2)),
      invoice: () => void run(list, TUNE.read),
      cargo: () => void run(list, TUNE.read),
      fire: () => list.did("kill"),
      kit: () => list.did("kit"),
      uplinks: () => list.did("uplinks"),
      boat: () => list.did("boat"),
    };
    for (const s of ORDER) {
      expect(run(list, 0.1).v).toMatchObject({ step: s, ticked: false });
      if (s === id) return;
      acts[s]();
      expect(run(list, 0.1).v).toMatchObject({ step: s, ticked: true });
      run(list, TUNE.tick);
    }
  };

  it("lights the nine lines in order through a whole raid, one at a time", () => {
    const { list } = fresh();
    const lit: (StepId | null)[] = [];
    const note = () => {
      const v = list.tick(0.05, playing);
      if (v.step && lit[lit.length - 1] !== v.step) lit.push(v.step);
    };
    const until = (id: StepId) => {
      for (let i = 0; i < 400 && list.view.step !== id; i++) note();
      expect(list.view.step).toBe(id);
    };
    until("rifle");
    list.did("rifle");
    until("move");
    list.walk(6);
    until("seal");
    list.did("seal");
    list.carry(1);
    until("invoice");
    until("cargo");
    until("fire");
    list.did("kill");
    until("kit");
    list.did("kit");
    until("uplinks");
    list.did("uplinks");
    until("boat");
    list.did("boat");
    for (let i = 0; i < 40; i++) note();
    expect(lit).toEqual([...ORDER]);
    expect(list.view.step).toBeNull();
    expect(list.view.steps.every((s) => s.done)).toBe(true);
  });

  it("a done line holds its tick before the next comes up", () => {
    const { list } = fresh();
    run(list, 0.1);
    list.did("rifle");
    expect(run(list, 0.05).v).toMatchObject({ step: "rifle", ticked: true });
    expect(run(list, TUNE.tick - 0.2).v).toMatchObject({ step: "rifle", ticked: true });
    expect(run(list, 0.3).v).toMatchObject({ step: "move", ticked: false });
  });

  it("1. the rifle: nothing else is lit until it is taken", () => {
    const { list } = fresh();
    list.walk(40);
    list.did("alert");
    list.did("seal");
    expect(run(list, 30).seen).toEqual(["rifle"]);
  });

  it("2. MOVE is done after walking 6 m", () => {
    const { list } = fresh();
    reach(list, "move");
    expect(TUNE.walk).toBe(6);
    list.walk(5.8);
    expect(run(list, 3).v).toMatchObject({ step: "move", ticked: false });
    list.walk(0.3);
    expect(run(list, 0.1).v).toMatchObject({ step: "move", ticked: true });
  });

  it("3. A SEALED CONTAINER is done when a seal is cut", () => {
    const { list } = fresh();
    reach(list, "seal");
    expect(run(list, 20).v).toMatchObject({ step: "seal", ticked: false });
    list.did("seal");
    expect(run(list, 0.1).v).toMatchObject({ step: "seal", ticked: true });
  });

  it("4. THE INVOICE is done after 4 s on screen", () => {
    const { list } = fresh();
    reach(list, "invoice");
    expect(TUNE.read).toBe(4);
    expect(run(list, TUNE.read - 0.5).v).toMatchObject({ step: "invoice", ticked: false });
    expect(run(list, 1).v).toMatchObject({ step: "invoice", ticked: true });
  });

  it("5. CARGO waits for the first cargo, then is done after 4 s", () => {
    const { list } = fresh();
    reach(list, "invoice");
    list.carry(0);
    run(list, TUNE.read + TUNE.tick + 0.2);
    expect(run(list, 6).v.step).toBeNull();
    list.carry(1);
    expect(run(list, TUNE.read - 0.5).v).toMatchObject({ step: "cargo", ticked: false });
    expect(run(list, 1).v).toMatchObject({ step: "cargo", ticked: true });
  });

  it("6. FIRE comes up after the first seal, and is done on the first kill or reload", () => {
    for (const how of ["kill", "reload"] as const) {
      const { list } = fresh();
      reach(list, "fire");
      expect(run(list, 30).v).toMatchObject({ step: "fire", ticked: false });
      list.did(how);
      expect(run(list, 0.1).v).toMatchObject({ step: "fire", ticked: true });
    }
  });

  it("6. FIRE jumps the queue the moment a machine notices the player, then the list picks up where it was", () => {
    const { list } = fresh();
    reach(list, "seal");
    list.did("alert");
    expect(run(list, 0.1).v).toMatchObject({ step: "fire", ticked: false });
    list.did("kill");
    run(list, 0.1);
    expect(run(list, TUNE.tick + 0.1).v).toMatchObject({ step: "seal", ticked: false });
    // …and FIRE is not lit a second time when its turn comes.
    list.did("seal");
    list.carry(1);
    expect(run(list, 30).seen).toEqual(["invoice", "cargo", "kit"]);
  });

  it("7. THE KIT is done when either is used, or after 20 s", () => {
    const a = fresh().list;
    reach(a, "kit");
    a.did("kit");
    expect(run(a, 0.1).v).toMatchObject({ step: "kit", ticked: true });
    const b = fresh().list;
    reach(b, "kit");
    expect(TUNE.kit).toBe(20);
    expect(run(b, TUNE.kit - 0.5).v).toMatchObject({ step: "kit", ticked: false });
    expect(run(b, 1).v).toMatchObject({ step: "kit", ticked: true });
  });

  it("8. THE UPLINKS at the third, 9. THE BOAT at extraction", () => {
    const { list } = fresh();
    reach(list, "uplinks");
    expect(run(list, 60).v).toMatchObject({ step: "uplinks", ticked: false });
    list.did("uplinks");
    run(list, 0.1);
    expect(run(list, TUNE.tick + 0.1).v).toMatchObject({ step: "boat", ticked: false });
    list.did("boat");
    expect(run(list, 0.1).v).toMatchObject({ step: "boat", ticked: true });
  });

  it("never shows a line for something the player has already done", () => {
    const { list } = fresh();
    run(list, 0.1);
    list.walk(8); // wandered off before taking the rifle
    list.did("rifle");
    list.did("kit");
    list.did("reload");
    list.did("seal");
    list.carry(2);
    expect(run(list, 30).seen).toEqual(["invoice", "cargo", "uplinks"]);
  });

  it("only one line is ever lit, and its clock stops while the game isn't in play", () => {
    const { list } = fresh();
    reach(list, "invoice");
    const paused = { device: "kbm" as Device, playing: false };
    expect(run(list, 30, paused).v).toMatchObject({ step: "invoice", ticked: false });
  });

  it("a raid off the books has no seal, invoice or cargo line; touch has no kit line", () => {
    expect(fresh({ signed: false }).list.view.steps.map((s) => s.id)).toEqual(["rifle", "move", "fire", "kit", "uplinks", "boat"]);
    const off = fresh({ signed: false }).list;
    run(off, 0.1);
    off.did("rifle");
    expect(run(off, 2).seen).toEqual(["move"]);
    off.walk(6);
    expect(run(off, 2).seen).toEqual(["fire"]);
    const touch = fresh({ device: "touch" }).list;
    expect(run(touch, 0.1, { device: "touch", playing: true }).v.steps.map((s) => s.id)).not.toContain("kit");
  });

  it("what was taught is told once, and a retry asks only for the raid's own three again", () => {
    const { list, taught } = fresh();
    reach(list, "kit");
    expect(taught).toEqual(["move", "seal", "invoice", "cargo", "fire"]);
    const retry = new Checklist(taught);
    retry.begin({ signed: true, device: "kbm" });
    run(retry, 0.1);
    retry.did("rifle");
    retry.did("seal");
    retry.carry(1);
    expect(run(retry, 60).seen).toEqual(["kit", "uplinks"]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("the crate's place and its rifle", () => {
  it("stands 2 m in front of the player's start, facing back at it", () => {
    const p = placeCrate({ pos: { x: -32, y: 0, z: 6 }, yaw: -Math.PI / 2 }, undefined, () => 0.02);
    expect(CRATE_AHEAD).toBe(2);
    expect(p.x).toBeCloseTo(-30);
    expect(p.z).toBeCloseTo(6);
    expect(p).toMatchObject({ y: 0.02, yaw: -Math.PI / 2, theirs: false });
    const north = placeCrate({ pos: { x: 0, z: 0 }, yaw: 0 });
    expect(north.x).toBeCloseTo(0);
    expect(north.z).toBeCloseTo(-2);
  });

  it("uses the film lane's DROP.crate when that module gives a point, and its own place when it doesn't", () => {
    const start = { pos: { x: -32, y: 0, z: 6 }, yaw: -Math.PI / 2 };
    expect(placeCrate(start, { x: -29.5, y: 0.1, z: 6.4, yaw: 1 })).toEqual({ x: -29.5, y: 0.1, z: 6.4, yaw: 1, theirs: true });
    expect(placeCrate(start, { pos: { x: -29, z: 5 } }, () => 0)).toMatchObject({ x: -29, y: 0, z: 5, yaw: -Math.PI / 2, theirs: true });
    for (const bad of [null, undefined, {}, { x: "1", z: 2 }, { x: NaN, z: 0 }, "crate", 4]) expect(placeCrate(start, bad)).toMatchObject({ theirs: false });
  });

  it("is the gun the raid was signed with, in its frame's finish, or the issue rifle", () => {
    expect(crateGun(null)).toEqual({ label: ISSUE.name.toUpperCase(), finish: FINISH.issue, issue: true });
    for (const frame of ["longshore", "stevedore", "pilot"] as const) expect(crateGun({ frame, grade: "B" })).toEqual({ label: `${FRAMES[frame].name} · B`.toUpperCase(), finish: FINISH[frame], issue: false });
    expect(new Set([FINISH.issue, FINISH.longshore, FINISH.stevedore, FINISH.pilot]).size).toBe(4);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("the coach in a raid", () => {
  const gun = (frame: Weapon["frame"]): Weapon =>
    ({ serial: "S-000041", frame, grade: "B", quality: 50, stats: { damage: 20, rpm: 900, mag: 36, recoil: 100, reload: 100, range: 200 }, mods: [], condition: 100, maker: "m", makerCallsign: "MOSS", owner: "o", builtAt: 0, raids: 0, extractions: 0, owners: 1, recovered: 0, state: "raid", value: 700 }) as Weapon;

  function memoryStore() {
    const data = new Map<string, string>();
    return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), data };
  }

  /** A game with the pieces the coach touches: the events, the shooter's rifle, the raid's slot, the HUD and menus. */
  function game(o: { noRaid?: boolean } = {}) {
    document.body.innerHTML = `
      <div id="ui">
        <div class="hud"><div class="h-obj"></div><div class="h-ammo"></div><div class="rd-inv"><div class="rd-inv-head"><span class="h-k">Invoice</span></div></div></div>
        <div class="menu">
          <section data-s="title"><div class="m-actions"><button data-act="deploy"></button><button data-act="settings"></button></div></section>
          <section data-s="dead"><div class="m-actions"><button data-act="retry"></button></div></section>
          <section data-s="complete"><div class="m-actions"><button data-act="redeploy"></button><button class="btn d2-entry"></button></div></section>
        </div>
      </div>`;
    const handlers = new Map<string, Set<(e: unknown) => void>>();
    const events = {
      on(name: string, fn: (e: unknown) => void) {
        if (!handlers.has(name)) handlers.set(name, new Set());
        handlers.get(name)!.add(fn);
        return () => handlers.get(name)!.delete(fn);
      },
      emit(name: string, e: unknown = {}) {
        for (const fn of [...(handlers.get(name) ?? [])]) fn(e);
      },
    };
    const weapon = {
      root: { visible: false },
      debug: { noFire: false },
      setVisible(v: boolean) {
        this.root.visible = !!v;
      },
      kick: vi.fn(),
      snap: vi.fn(),
    };
    const slot: YardTarget[] = [];
    const state = { mode: "signed" as "signed" | "offbooks", gun: null as Weapon | null, opened: [] as number[], weight: 0, targets: [] as { kind: string; at: { x: number; y: number; z: number } }[] };
    const raid = {
      state,
      lead: vi.fn(),
      addTarget(t: YardTarget) {
        slot.push(t);
        return () => void (slot.includes(t) && slot.splice(slot.indexOf(t), 1));
      },
    };
    const G: any = {
      ext: { speedScale: 1, gear: {} },
      events,
      weapon,
      input: { touch: false, gamepad: false, locked: true },
      player: { pos: { x: -32, y: 0, z: 6 }, forward: { x: 1, z: 0 }, alive: true, ads: 0 },
      level: { playerStart: { pos: { x: -32, y: 0, z: 6 }, yaw: -Math.PI / 2 } },
      game: { state: "title", menus: { screen: "title" } },
      hud: { root: document.querySelector(".hud"), radio: vi.fn() },
      audio: { play: vi.fn() },
      physics: { groundHeight: () => 0 },
      v2: { raid: { harbormaster: { bailiffAt: INVOICE.bailiff } } },
    };
    if (!o.noRaid) G.raid = raid;
    /** The game's own start: run:start, then the rifle shown, then the state changes. */
    const start = () => {
      events.emit("run:start", { retries: 0 });
      weapon.setVisible(true);
      G.game.state = "playing";
      G.game.menus.screen = "none";
      events.emit("game:state", { state: "playing" });
    };
    const end = (how: "dead" | "complete") => {
      events.emit(how === "dead" ? "player:dead" : "extraction:reached", {});
      G.game.state = how;
      G.game.menus.screen = how;
      events.emit("game:state", { state: how });
    };
    return { G, events, weapon, slot, state, raid, start, end };
  }
  const world = () => {
    const build = vi.fn((_place: unknown, _gun: unknown) => {});
    const take = vi.fn(() => {});
    const w: CrateWorld = { build, take, clear() {}, update() {}, full: true };
    return Object.assign(w, { build, take });
  };
  const panel = () => document.querySelector(".co-panel")!;
  const spin = (c: { update(dt: number): void }, seconds: number) => {
    for (let t = 0; t < seconds - 1e-9; t += 0.05) c.update(0.05);
  };

  let clock = 0;
  const now = () => clock;
  beforeEach(() => {
    clock = 0;
  });

  it("a raid starts with empty hands until the rifle is taken from the crate", () => {
    const g = game();
    const w = world();
    const c = createCoach(g.G, { world: w, store: memoryStore(), now });
    g.start();
    c.update(0.016);
    expect(g.G.ext.unarmed).toBe(true);
    expect(g.weapon.root.visible).toBe(false); // game.js gates firing on the rifle being drawn
    expect(g.weapon.debug.noFire).toBe(true);
    expect(g.G.hud.root.classList.contains("co-unarmed")).toBe(true);
    expect(c.state).toMatchObject({ armed: false, coached: true, instant: false, step: "rifle" });
    // One target, in the raid's own slot, 2 m ahead.
    expect(g.slot).toHaveLength(1);
    expect(g.slot[0]).toMatchObject({ key: "rifle", verb: "Take the rifle", seconds: TAKE_SECONDS, at: { x: -30, z: 6 } });
    expect(TAKE_SECONDS).toBe(0.6);
    expect(w.build).toHaveBeenCalledTimes(1);

    g.slot[0].taken(); // the raid calls this when E has been held long enough
    expect(c.state.armed).toBe(true);
    expect(g.G.ext.unarmed).toBe(false);
    expect(g.weapon.root.visible).toBe(true);
    expect(g.G.hud.root.classList.contains("co-unarmed")).toBe(false);
    expect(w.take).toHaveBeenCalledTimes(1);
    expect(g.G.audio.play.mock.calls.map((a: unknown[]) => a[0])).toEqual(["ui_click", "reload_magin"]);
    // It comes up from below the frame, and can fire once it is nearly level.
    expect(g.G.ext.draw).toBe(1);
    // Control's line waits out the raid's first second: the fence's greeting has the radio then.
    expect(g.G.hud.radio).not.toHaveBeenCalled();
    spin(c, 1.5);
    expect(g.G.ext.draw).toBe(0);
    expect(g.weapon.debug.noFire).toBe(false);
    expect(g.G.audio.play.mock.calls.map((a: unknown[]) => a[0])).toContain("reload_bolt");
    expect(g.G.hud.radio).toHaveBeenCalledTimes(1);
    expect(g.G.hud.radio.mock.calls[0][0]).toMatch(/^Issue rifle\./);
    spin(c, 3);
    expect(g.G.hud.radio).toHaveBeenCalledTimes(1);
  });

  it("the game showing the rifle (a resume, a late start) doesn't arm empty hands", () => {
    const g = game();
    const c = createCoach(g.G, { world: world(), store: memoryStore(), now });
    g.start();
    g.weapon.setVisible(true);
    c.update(0.016);
    expect(g.weapon.root.visible).toBe(false);
  });

  it("lays the loadout's gun in the crate, or the issue rifle", () => {
    const g = game();
    const w = world();
    const c = createCoach(g.G, { world: w, store: memoryStore(), now });
    g.state.gun = gun("stevedore");
    g.start();
    expect(w.build.mock.calls[0][1]).toEqual({ label: "PAC-9K STEVEDORE · B", finish: FINISH.stevedore, issue: false });
    c.take();
    spin(c, 1.5);
    expect(g.G.hud.radio.mock.calls[0][0]).toMatch(/^Stevedore S-000041\./);
    g.end("complete");
    g.state.gun = null;
    g.start();
    expect(w.build.mock.calls[1][1]).toEqual({ label: "PAC-9 ISSUE", finish: FINISH.issue, issue: true });
  });

  it("on a retry after a death the rifle is taken at the press; after the boat it is held again", () => {
    const g = game();
    const c = createCoach(g.G, { world: world(), store: memoryStore(), now });
    g.start();
    expect(g.slot[0].seconds).toBe(TAKE_SECONDS);
    g.end("dead");
    expect(g.slot).toHaveLength(0); // the crate leaves the slot with the raid
    expect(g.G.ext.unarmed).toBe(false);
    g.start();
    expect(g.slot[0].seconds).toBe(0);
    expect(c.state).toMatchObject({ instant: true, armed: false });
    c.take();
    g.end("complete");
    g.start();
    expect(g.slot[0].seconds).toBe(TAKE_SECONDS);
    expect(c.state.instant).toBe(false);
  });

  it("shows one line at a time, in the panel under the objective", () => {
    const g = game();
    const c = createCoach(g.G, { world: world(), store: memoryStore(), now });
    g.start();
    c.update(0.05);
    expect(panel().parentElement).toBe(document.querySelector(".h-obj"));
    expect(panel().classList.contains("on")).toBe(true);
    expect(panel().querySelector(".h-k")!.textContent).toBe("First raid");
    expect(panel().querySelectorAll(".co-line")).toHaveLength(1);
    expect(c.state.text).toBe("TAKE THE RIFLE — hold E at the crate");
    expect([...panel().querySelectorAll("kbd")].map((k) => k.textContent)).toEqual(["E"]);
    c.take();
    c.update(0.05);
    expect(panel().querySelector(".co-line")!.classList.contains("ticked")).toBe(true);
    spin(c, TUNE.tick + 0.2);
    expect(panel().querySelectorAll(".co-line")).toHaveLength(1);
    expect(c.state.text).toBe("MOVE — W A S D · LOOK — mouse");
    expect([...panel().querySelectorAll(".co-pips i")].map((i) => i.className)).toEqual(["done", "", "", "", "", "", "", "", ""]);
    // The input changes under it: the same line, in the other hands' words.
    g.G.input.touch = true;
    c.update(0.05);
    expect(c.state.text).toBe("MOVE — left thumb · LOOK — right thumb");
    expect(panel().querySelectorAll(".co-line")).toHaveLength(1);
  });

  it("ticks through a raid from what the game reports: walking, the seal, the invoice's arrow, a kill, the kit, the uplinks, the boat", () => {
    const g = game();
    const c = createCoach(g.G, { world: world(), store: memoryStore(), now });
    const next = (id: StepId) => {
      for (let i = 0; i < 600 && !(c.state.step === id && !c.state.ticked); i++) c.update(0.05);
      expect(c.state).toMatchObject({ step: id, ticked: false });
    };
    g.start();
    next("rifle");
    c.take();
    next("move");
    for (let i = 0; i < 13; i++) ((g.G.player.pos.x += 0.5), c.update(0.05)); // 6.5 m, a stride at a time
    next("seal");
    expect(g.raid.lead).toHaveBeenLastCalledWith(true);
    g.G.player.pos.x += 40; // a respawn or a test's teleport is not walking
    g.state.opened = [3];
    g.state.weight = 2;
    next("invoice");
    expect(g.raid.lead).toHaveBeenLastCalledWith(false);
    expect(document.querySelector(".rd-inv")!.classList.contains("co-point")).toBe(true);
    expect(document.querySelector(".rd-inv .co-arrow")).not.toBeNull();
    next("cargo");
    expect(document.querySelector(".rd-inv")!.classList.contains("co-point")).toBe(false);
    expect(document.querySelector(".co-arrow")).toBeNull();
    next("fire");
    g.events.emit("enemy:killed", { type: "hound" });
    next("kit");
    g.events.emit("weapon:melee", {});
    next("uplinks");
    g.events.emit("objective:done", { index: 1, total: 3 });
    g.events.emit("objective:done", { index: 2, total: 3 });
    spin(c, 3);
    expect(c.state.step).toBe("uplinks");
    g.events.emit("objective:done", { index: 3, total: 3 });
    next("boat");
    g.end("complete");
    c.update(0.05);
    expect(panel().classList.contains("on")).toBe(false);
    expect(c.state).toMatchObject({ coached: false, step: null, done: true });
  });

  it("gets out of the way in a fight: dim while the player is being hit, and while aiming", () => {
    const g = game();
    const c = createCoach(g.G, { world: world(), store: memoryStore(), now });
    g.start();
    c.update(0.05);
    expect(panel().classList.contains("dim")).toBe(false);
    g.events.emit("player:hit", {});
    c.update(0.05);
    expect(panel().classList.contains("dim")).toBe(true);
    clock += 3000;
    c.update(0.05);
    expect(panel().classList.contains("dim")).toBe(false);
    g.G.player.ads = 1;
    c.update(0.05);
    expect(panel().classList.contains("dim")).toBe(true);
  });

  it("never returns after a first raid reaches the boat, until HOW TO PLAY turns it back on", () => {
    const g = game();
    const store = memoryStore();
    const c = createCoach(g.G, { world: world(), store, now });
    const how = document.querySelector<HTMLButtonElement>(".co-howto")!;
    expect(how.previousElementSibling?.getAttribute("data-act")).toBe("settings");
    expect(how.getAttribute("aria-pressed")).toBe("true");
    g.start();
    c.take();
    g.end("dead"); // a death is not a completed raid: the next one is still coached
    g.start();
    expect(c.state.coached).toBe(true);
    c.take();
    g.end("complete");
    expect(loadCoach(store).done).toBe(true);
    expect(how.getAttribute("aria-pressed")).toBe("false");
    g.start();
    spin(c, 2);
    expect(c.state).toMatchObject({ coached: false, armed: false, step: null }); // the crate is still how a raid starts
    expect(panel().classList.contains("on")).toBe(false);
    c.take();
    g.end("complete");
    c.dispose();

    // Another visit: still off. HOW TO PLAY: on for the next raid, with every line to be taught again.
    const again = game();
    const c2 = createCoach(again.G, { world: world(), store, now });
    again.start();
    spin(c2, 1);
    expect(c2.state.coached).toBe(false);
    c2.take();
    again.end("complete");
    again.G.game.state = "title";
    again.events.emit("game:state", { state: "title" });
    const how2 = document.querySelector<HTMLButtonElement>(".co-howto")!;
    expect(how2.getAttribute("aria-pressed")).toBe("false");
    how2.click();
    expect(how2.getAttribute("aria-pressed")).toBe("true");
    expect(loadCoach(store)).toMatchObject({ done: false, taught: [] });
    again.start();
    spin(c2, 0.2);
    expect(c2.state).toMatchObject({ coached: true, step: "rifle" });
    expect(c2.state.text).toBe("TAKE THE RIFLE — hold E at the crate");
  });

  it("the first Bailiff and the first wreck in sight each say their line once, ever, alone on the panel", () => {
    const g = game();
    const store = memoryStore();
    const c = createCoach(g.G, { world: world(), store, now });
    g.start();
    g.events.emit("bailiff:spawned", { id: 1 });
    spin(c, 1);
    expect(c.state).toMatchObject({ moment: null, step: "rifle" }); // not to empty hands
    c.take();
    spin(c, 1);
    expect(c.state.moment).toBe("bailiff");
    expect(c.state.text).toBe("IT CAN'T BE DESTROYED — drop it with fire or a charge, then run");
    expect(panel().classList.contains("moment")).toBe(true);
    expect(panel().querySelector(".h-k")!.textContent).toBe("The Bailiff");
    expect(panel().querySelectorAll(".co-line")).toHaveLength(1);
    // A wreck comes into sight while it is up: it waits its turn.
    g.state.targets = [{ kind: "wreck", at: { x: g.G.player.pos.x + 6, y: 0.55, z: g.G.player.pos.z } }];
    spin(c, 3);
    expect(c.state.moment).toBe("bailiff");
    expect(panel().querySelectorAll(".co-line")).toHaveLength(1);
    spin(c, 6);
    expect(c.state.moment).toBe("wreck");
    expect(c.state.text).toBe("ANOTHER BREACHER'S WRECK — hold E to take what they lost");
    spin(c, 9);
    expect(c.state).toMatchObject({ moment: null, step: "move" });
    expect(panel().classList.contains("moment")).toBe(false);
    // Again in the same raid, in the next, and on another visit: nothing.
    g.events.emit("bailiff:spawned", { id: 2 });
    spin(c, 2);
    expect(c.state.moment).toBeNull();
    g.end("dead");
    g.start();
    c.take();
    g.events.emit("bailiff:spawned", { id: 3 });
    spin(c, 3);
    expect(c.state.moment).toBeNull();
    c.dispose();
    const later = game();
    const c2 = createCoach(later.G, { world: world(), store, now });
    later.state.targets = [{ kind: "wreck", at: { x: -26, y: 0.55, z: 6 } }];
    later.start();
    c2.take();
    later.events.emit("bailiff:spawned", { id: 4 });
    spin(c2, 3);
    expect(c2.state.moment).toBeNull();
    expect(c2.state.seen).toEqual(expect.arrayContaining(["bailiff", "wreck"]));
  });

  it("a wreck behind the player, or far off, has not been seen", () => {
    const g = game();
    const c = createCoach(g.G, { world: world(), store: memoryStore(), now });
    g.state.targets = [
      { kind: "wreck", at: { x: g.G.player.pos.x - 6, y: 0.55, z: g.G.player.pos.z } },
      { kind: "wreck", at: { x: g.G.player.pos.x + 30, y: 0.55, z: g.G.player.pos.z } },
      { kind: "seal", at: { x: g.G.player.pos.x + 4, y: 1, z: g.G.player.pos.z } },
    ];
    g.start();
    c.take();
    spin(c, 3);
    expect(c.state.moment).toBeNull();
    expect(c.state.seen).not.toContain("wreck");
  });

  it("the moments are said after the first raid too, when the checklist is long gone", () => {
    const g = game();
    const store = memoryStore();
    store.setItem(COACH_KEY, JSON.stringify({ v: 1, done: true, taught: [], seen: [] }));
    const c = createCoach(g.G, { world: world(), store, now });
    g.start();
    c.take();
    spin(c, 1);
    expect(panel().classList.contains("on")).toBe(false);
    g.events.emit("bailiff:spawned", { id: 1 });
    spin(c, 1);
    expect(panel().classList.contains("on")).toBe(true);
    expect(c.state.text).toMatch(/^IT CAN'T BE DESTROYED/);
    spin(c, 9);
    expect(panel().classList.contains("on")).toBe(false);
  });

  it("the first death's card says what became of the gun, once", async () => {
    const g = game();
    const store = memoryStore();
    const c = createCoach(g.G, { world: world(), store, now });
    g.state.gun = gun("pilot");
    g.start();
    c.take();
    clock = 5000;
    g.events.emit("bailiff:grab", { id: 1 });
    g.end("dead");
    await Promise.resolve();
    const card = document.querySelector('[data-s="dead"] .co-card')!;
    expect(card.textContent).toBe("PILOT S-000041 IS IMPOUNDED — buy it back at the DOCK within 48 hours.");
    expect(card.nextElementSibling?.className).toBe("m-actions");
    g.start();
    expect(document.querySelector(".co-card")).toBeNull();
    c.take();
    g.end("dead");
    await Promise.resolve();
    expect(document.querySelector(".co-card")).toBeNull();
    expect(loadCoach(store).seen).toContain("death");
  });

  it("the first debrief points at the DOCK button, once", () => {
    const g = game();
    const c = createCoach(g.G, { world: world(), store: memoryStore(), now });
    g.start();
    c.take();
    g.events.emit("extraction:reached", {});
    g.G.game.state = "complete";
    c.update(0.05);
    expect(document.querySelector(".co-dock")).toBeNull(); // the card isn't up yet
    g.G.game.menus.screen = "complete";
    c.update(0.05);
    const line = document.querySelector('[data-s="complete"] .co-dock')!;
    expect(line.textContent).toBe("SELL AND BUILD AT THE DOCK");
    expect(line.nextElementSibling?.classList.contains("d2-entry")).toBe(true);
    expect(line.nextElementSibling?.classList.contains("co-pointed")).toBe(true);
    g.start();
    expect(document.querySelector(".co-dock")).toBeNull();
    expect(document.querySelector(".co-pointed")).toBeNull();
    c.take();
    g.end("complete");
    c.update(0.05);
    expect(document.querySelector(".co-dock")).toBeNull();
  });

  describe("a failing coach leaves the raid playing", () => {
    const armed = (g: ReturnType<typeof game>) => {
      expect(g.G.ext.unarmed).toBeFalsy();
      expect(g.G.ext.draw).toBeFalsy();
      expect(g.weapon.debug.noFire).toBe(false);
      expect(g.weapon.root.visible).toBe(true);
      expect(g.slot).toHaveLength(0);
    };
    beforeEach(() => void vi.spyOn(console, "warn").mockImplementation(() => {}));

    it("a crate that can't be built: the raid starts with the rifle in hand", () => {
      const g = game();
      const w = world();
      w.build.mockImplementation(() => {
        throw new Error("no scene");
      });
      const c = createCoach(g.G, { world: w, store: memoryStore(), now });
      expect(() => g.start()).not.toThrow();
      expect(() => spin(c, 1)).not.toThrow();
      armed(g);
      // …and every raid after it.
      g.end("dead");
      expect(() => g.start()).not.toThrow();
      armed(g);
    });

    it("a panel that throws mid-raid: empty hands are filled at once", () => {
      const g = game();
      const c = createCoach(g.G, { world: world(), store: memoryStore(), now });
      g.start();
      c.update(0.05);
      expect(g.G.ext.unarmed).toBe(true);
      Object.defineProperty(g.G, "input", {
        get() {
          throw new Error("input went away");
        },
      });
      expect(() => spin(c, 1)).not.toThrow();
      armed(g);
    });

    it("a raid that has no slot to put the crate in: nothing is taken away", () => {
      const g = game({ noRaid: true });
      const w = world();
      const c = createCoach(g.G, { world: w, store: memoryStore(), now });
      g.start();
      spin(c, 1);
      expect(w.build).not.toHaveBeenCalled();
      expect(g.G.ext.unarmed).toBeFalsy();
      expect(g.weapon.root.visible).toBe(true);
      expect(c.state.armed).toBe(true);
    });

    it("storage that refuses: the raid is coached, and remembered for this page only", () => {
      const g = game();
      const store = {
        getItem() {
          throw new Error("denied");
        },
        setItem() {
          throw new Error("denied");
        },
      };
      const c = createCoach(g.G, { world: world(), store, now });
      g.start();
      c.take();
      spin(c, 2);
      expect(c.state).toMatchObject({ armed: true, coached: true });
      g.end("complete");
      g.start();
      expect(c.state.coached).toBe(false);
    });
  });
});
