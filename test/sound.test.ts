// @vitest-environment happy-dom
// The trade sounds (src/economy/dockside/sound.ts): the synthesis, the mute and volume rules (?noaudio, volume 0, the
// game's silent stub), and that the Dockside plays them only on a confirmed trade. No real audio here: a stand-in
// context records what would have played.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDockside, type Dockside, type GameLike } from "../src/economy/dockside";
import { createFakeEconomy } from "../src/economy/dockside/fake";
import { chimeSamples, createChimes, gameChimes, gameMuted, gameVolume, SETTINGS_KEY, type ChimeContext } from "../src/economy/dockside/sound";

function fakeCtx(state = "running") {
  const started: { gain: number; length: number }[] = [];
  const ctx: ChimeContext & { started: typeof started; buffers: number } = {
    state,
    sampleRate: 48000,
    destination: { id: "out" },
    started,
    buffers: 0,
    createBuffer(_ch, length) {
      ctx.buffers++;
      const data = new Float32Array(length);
      return { getChannelData: () => data, length } as never;
    },
    createBufferSource() {
      const src = {
        buffer: null as unknown,
        to: null as unknown,
        connect(n: unknown) {
          src.to = n;
          return n;
        },
        start() {
          started.push({ gain: (src.to as { gain: { value: number } }).gain.value, length: (src.buffer as { length: number }).length });
        },
      };
      return src;
    },
    createGain() {
      return { gain: { value: 1 }, connect: (n: unknown) => n };
    },
  };
  return ctx;
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("the chimes themselves", () => {
  it("are made here, short, finite and never clip", () => {
    for (const kind of ["cash", "soft"] as const) {
      const s = chimeSamples(kind, 48000);
      let peak = 0;
      for (const v of s) {
        expect(Number.isFinite(v)).toBe(true);
        peak = Math.max(peak, Math.abs(v));
      }
      expect(peak).toBeGreaterThan(0.85);
      expect(peak).toBeLessThanOrEqual(0.9 + 1e-6);
      expect(Math.abs(s[s.length - 1])).toBeLessThan(1e-3); // fades out, no click
    }
    expect(chimeSamples("cash", 48000).length / 48000).toBeCloseTo(0.75, 2);
    expect(chimeSamples("soft", 48000).length / 48000).toBeCloseTo(0.34, 2);
    expect(chimeSamples("cash", 44100)).toEqual(chimeSamples("cash", 44100)); // the same every time
  });
});

describe("volume and mute", () => {
  it("plays at the game's volume, the sale louder than the purchase", async () => {
    const ctx = fakeCtx();
    const c = createChimes({ ctx: () => ctx, volume: () => 0.5, muted: () => false });
    expect(c.play("cash")).toBe(true);
    await wait(70);
    expect(c.play("soft")).toBe(true);
    expect(ctx.started.map((s) => s.gain)).toEqual([0.5 * 0.42, 0.5 * 0.22]);
    expect(c.played).toEqual({ cash: 1, soft: 1 });
    await wait(70);
    c.play("cash");
    expect(ctx.buffers).toBe(2); // each is synthesized once
  });

  it("stays silent at volume 0, with ?noaudio, and with no running audio", () => {
    const ctx = fakeCtx();
    const getCtx = vi.fn(() => ctx);
    expect(createChimes({ ctx: getCtx, volume: () => 0, muted: () => false }).play("cash")).toBe(false);
    expect(createChimes({ ctx: getCtx, volume: () => 0.8, muted: () => true }).play("cash")).toBe(false);
    expect(getCtx).not.toHaveBeenCalled(); // not even the context is touched
    expect(createChimes({ ctx: () => null, volume: () => 0.8, muted: () => false }).play("cash")).toBe(false);
    expect(createChimes({ ctx: () => fakeCtx("closed"), volume: () => 0.8, muted: () => false }).play("cash")).toBe(false);
    expect(ctx.started).toEqual([]);
  });

  it("reads the game's own settings: the live slider, else what Settings saved, else the default", () => {
    expect(gameVolume({ game: { menus: { settings: { volume: 0.3 } } } })).toBe(0.3);
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ volume: 0 }));
    expect(gameVolume({})).toBe(0);
    localStorage.setItem(SETTINGS_KEY, "{broken");
    expect(gameVolume({})).toBe(0.8);
    localStorage.removeItem(SETTINGS_KEY);
    expect(gameVolume({})).toBe(0.8);
    expect(gameVolume({ game: { menus: { settings: { volume: 7 } } } })).toBe(1);
  });

  it("mutes with ?noaudio=1 (as the game reads it) and with the game's silent audio", () => {
    expect(gameMuted({ params: { noaudio: "1" } })).toBe(true);
    expect(gameMuted({ params: {} })).toBe(false);
    expect(gameMuted({ params: {}, audio: { silent: true } })).toBe(true);
    const ctx = fakeCtx();
    const G = { params: { noaudio: "1" }, audio: { ctx }, game: { menus: { settings: { volume: 0.8 } } } };
    expect(gameChimes(G).play("cash")).toBe(false);
    G.params = {} as never;
    expect(gameChimes(G).play("cash")).toBe(true);
    G.game.menus.settings.volume = 0;
    expect(gameChimes(G).play("cash")).toBe(false);
    expect(ctx.started).toHaveLength(1);
  });
});

describe("in the Dockside", () => {
  let dock: Dockside | null = null;
  afterEach(() => {
    dock?.close();
    dock?.deployGate.dispose();
    dock = null;
    document.body.replaceChildren();
  });

  async function setup() {
    const ui = document.createElement("div");
    document.body.append(ui);
    const ctx = fakeCtx();
    const G: GameLike & Record<string, unknown> = {
      events: { on: () => () => {}, emit: () => {} },
      game: { state: "title", menus: { root: ui } },
      params: {},
      audio: { ctx },
    };
    const eco = createFakeEconomy({ registered: true, latency: 4 });
    dock = createDockside(G, eco, { host: ui });
    await dock.open("title");
    await vi.waitFor(() => expect(dock!.gate).toBe("in"));
    const btn = (b: string, tok: string, a: string) => dock!.root.querySelector<HTMLButtonElement>(`.dk-stall[data-broker="${b}"] .dk-q[data-tok="${tok}"] [data-a="${a}"]`)!;
    await vi.waitFor(() => expect(btn("moss", "copper", "sell1").disabled).toBe(false));
    return { ctx, eco, btn, slot: (b: string) => dock!.root.querySelector<HTMLElement>(`.dk-stall[data-broker="${b}"] .dk-slot`)! };
  }

  it("rings on a confirmed sale and ticks on a confirmed purchase", async () => {
    const { ctx, btn, slot } = await setup();
    btn("moss", "copper", "sell1").click();
    expect(ctx.started).toHaveLength(0); // not while it's settling
    await vi.waitFor(() => expect(slot("moss").dataset.state).toBe("ok"));
    expect(dock!.chimes.played).toEqual({ cash: 1, soft: 0 });
    await vi.waitFor(() => expect(btn("qm", "mag", "buy1").disabled).toBe(false));
    btn("qm", "mag", "buy1").click();
    await vi.waitFor(() => expect(slot("qm").dataset.state).toBe("ok"));
    expect(dock!.chimes.played).toEqual({ cash: 1, soft: 1 });
    expect(ctx.started.map((s) => s.gain)).toEqual([0.8 * 0.42, 0.8 * 0.22]);
  });

  it("stays quiet on a refusal and on an unknown result", async () => {
    const { eco, btn, slot } = await setup();
    eco.chain.failing.add("sell"); // dropped: unknown, may still land
    btn("moss", "copper", "sell1").click();
    await vi.waitFor(() => expect(slot("moss").dataset.state).toBe("unknown"));
    eco.chain.failing.clear();
    eco.chain.state.brokers.moss.open = false; // refused
    btn("moss", "copper", "sell1").click();
    await vi.waitFor(() => expect(slot("moss").dataset.state).toBe("error"));
    expect(dock!.chimes.played).toEqual({ cash: 0, soft: 0 });
  });
});
