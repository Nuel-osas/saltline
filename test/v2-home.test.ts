// @vitest-environment happy-dom
// v2's start screen, the lobby: its rules (home/model.ts) and the screen itself (home/index.ts).
import { afterEach, describe, expect, it } from "vitest";
import { PRACTISED_KEY, START_DONE_KEY, startHome } from "../src/economy/v2/home";
import { type Facts, RANKS, actionFor, defaultMode, rankOf, startStep } from "../src/economy/v2/home/model";
import type { Login } from "../src/economy/v2/login";

const facts = (over: Partial<Facts> = {}): Facts => ({ offline: false, loginOn: true, signedIn: false, extractions: null, practised: false, gun: "Issue rifle", ...over });

describe("rank", () => {
  it("climbs with raids brought home and shows the way to the next rank", () => {
    expect(rankOf(0)).toEqual({ level: 1, name: "Casual", into: 0, need: 1 });
    expect(rankOf(1)).toEqual({ level: 2, name: "Docker", into: 0, need: 2 });
    expect(rankOf(4)).toEqual({ level: 3, name: "Stevedore", into: 1, need: 3 });
    expect(rankOf(9)).toMatchObject({ name: "Breacher", into: 3, need: 4 });
  });
  it("tops out, and treats an unknown count as none", () => {
    expect(rankOf(400)).toEqual({ level: RANKS.length, name: "Pilot", into: 1, need: 1 });
    for (const bad of [null, undefined, Number.NaN, -3]) expect(rankOf(bad as number)).toMatchObject({ level: 1, name: "Casual" });
  });
});

describe("the one big button", () => {
  it("is the next step for a raid: sign in first, then deploy", () => {
    expect(actionFor("raid", facts())).toEqual({ label: "Sign in", caption: "Raid · sign in first", do: "signin" });
    expect(actionFor("raid", facts({ signedIn: true, gun: "Longshore" }))).toEqual({ label: "Deploy", caption: "Raid · with the Longshore", do: "deploy" });
    expect(actionFor("raid", facts({ loginOn: false }))).toMatchObject({ label: "Deploy", do: "deploy" });
  });
  it("is Sign in for every mode until the player has signed in, Practice and the opening included", () => {
    expect(actionFor("practice", facts())).toEqual({ label: "Sign in", caption: "Practice · sign in first", do: "signin" });
    expect(actionFor("film", facts())).toEqual({ label: "Sign in", caption: "The opening · sign in first", do: "signin" });
    for (const mode of ["raid", "practice", "film"] as const) expect(actionFor(mode, facts({ offline: true })).do).toBe("signin");
  });
  it("signed in: opens Practice from the chain game, and plays it from inside Practice", () => {
    const inn = { signedIn: true };
    expect(actionFor("practice", facts(inn))).toMatchObject({ label: "Play practice", do: "practice" });
    expect(actionFor("practice", facts({ ...inn, offline: true }))).toMatchObject({ label: "Deploy", do: "deploy" });
    expect(actionFor("raid", facts({ ...inn, offline: true }))).toMatchObject({ label: "Go on chain", do: "online" });
    expect(actionFor("film", facts(inn))).toMatchObject({ label: "Watch", do: "film" });
    expect(defaultMode(true)).toBe("practice");
    expect(defaultMode(false)).toBe("raid");
  });
});

describe("start here", () => {
  it("walks a new player through four steps, one at a time, and the first is to sign in", () => {
    expect(startStep(facts())).toMatchObject({ n: 1, do: "signin" });
    expect(startStep(facts({ practised: true }))).toMatchObject({ n: 1, do: "signin" });
    expect(startStep(facts({ signedIn: true, extractions: 0 }))).toMatchObject({ n: 2, do: "practice" });
    expect(startStep(facts({ signedIn: true, extractions: 0, practised: true }))).toMatchObject({ n: 3, do: "deploy" });
    expect(startStep(facts({ signedIn: true, extractions: 1 }))).toMatchObject({ n: 4, do: "vendors" });
    expect(startStep(facts({ signedIn: true, extractions: 3 }))).toBeNull();
  });
  it("says nothing when the record couldn't be read, rather than guess", () => {
    expect(startStep(facts({ signedIn: true, extractions: null }))).toBeNull();
  });
  it("in Practice: sign in, then the practice raid, then go on chain", () => {
    expect(startStep(facts({ offline: true, extractions: 0 }))).toMatchObject({ n: 1, do: "signin" });
    expect(startStep(facts({ offline: true, signedIn: true, extractions: 0 }))).toMatchObject({ n: 2, do: "deploy" });
    expect(startStep(facts({ offline: true, signedIn: true, extractions: 2 }))).toMatchObject({ n: 3, do: "online" });
  });
});

describe("the lobby", () => {
  afterEach(() => (document.body.innerHTML = ""));

  function world(opts: { offline?: boolean; login?: Partial<Login> | null; profile?: unknown; fail?: boolean } = {}) {
    document.body.innerHTML = `<div id="app"><div class="menu open" data-screen="title"><section class="m-screen" data-s="title"><div class="m-title-main"><div class="m-actions"><button data-act="deploy">Deploy</button><button data-act="settings">Settings</button><button class="st-replay">Intro</button></div></div></section><div class="panel" hidden></div></div></div>`;
    const pressed: string[] = [];
    for (const b of document.querySelectorAll<HTMLElement>(".m-actions button")) b.addEventListener("click", () => pressed.push(b.dataset.act ?? b.className));
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    const went: string[] = [];
    const opened: string[] = [];
    const login: Login | null =
      opts.login === null ? null : ({ state: () => "out", who: () => null, token: async () => null, open: () => void opened.push("signin"), close: () => {}, signOut: async () => {}, stop: () => {}, ...opts.login } as Login);
    const docked: string[] = [];
    const dock = { gate: "in", open: async () => void docked.push("open"), setTab: (t: string) => void docked.push(t) };
    const chain = {
      profile: async () => {
        if (opts.fail) throw new Error("rpc down");
        return opts.profile === undefined ? null : opts.profile;
      },
      balances: async () => ({ scrip: 2550 }),
      weapons: async () => [{ serial: "S-000026", frame: "longshore", grade: "A", condition: 92 }],
    };
    const v2: any = { chain, wallet: { accountId: () => "ab".repeat(32) }, loadout: { weapon: "S-000026", plates: 0, charges: 0, mags: 0 }, raid: null };
    const handlers = new Map<string, () => void>();
    const G: any = { events: { on: (k: string, f: () => void) => handlers.set(k, f), off: () => {} } };
    const home = startHome(G, { v2, offline: !!opts.offline, login: () => login, dock: () => dock as never, storage, go: (u) => void went.push(u) });
    const text = (sel: string) => home.root.querySelector(sel)?.textContent ?? "";
    return { home, G, pressed, went, opened, docked, store, text, handlers };
  }
  const settle = async () => {
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  };

  it("stands over the title, below the settings panel, with every part of the layout", async () => {
    const w = world();
    await settle();
    expect(document.getElementById("app")!.classList.contains("hm-on")).toBe(true);
    expect(w.home.root.previousElementSibling?.getAttribute("data-s")).toBe("title");
    expect(w.home.root.nextElementSibling?.classList.contains("panel")).toBe(true);
    for (const part of [".hm-card", ".hm-word", ".hm-tools", ".hm-hero", ".hm-modes", ".hm-start", ".hm-tabs", ".hm-play"]) expect(w.home.root.querySelector(part)).not.toBeNull();
    expect(w.home.root.querySelectorAll(".hm-tile")).toHaveLength(3);
    expect(w.home.root.querySelectorAll(".hm-tab")).toHaveLength(4);
  });

  it("signed out: a guest card, and every way in asks for a sign-in, Practice included", async () => {
    const w = world();
    await settle();
    expect(w.text(".hm-card")).toContain("Guest");
    expect(w.text(".hm-play")).toContain("Sign in");
    expect(w.text(".hm-start")).toContain("1 of 4");
    w.home.root.querySelector<HTMLElement>(".hm-play")!.click();
    w.home.root.querySelector<HTMLElement>(".hm-signin")!.click();
    w.home.root.querySelector<HTMLElement>(".hm-tab")!.click(); // the dock needs a sign-in too
    w.home.root.querySelector<HTMLElement>(".hm-start-b")!.click();
    w.home.root.querySelector<HTMLElement>('.hm-tile[data-mode="practice"]')!.click();
    expect(w.text(".hm-play")).toContain("Practice · sign in first");
    w.home.root.querySelector<HTMLElement>(".hm-play")!.click();
    expect(w.opened).toEqual(["signin", "signin", "signin", "signin", "signin"]);
    expect(w.pressed).toEqual([]);
    expect(w.went).toEqual([]);
    expect(w.store.has(PRACTISED_KEY)).toBe(false);
  });

  it("signed in: the record, the gun going over the fence, and Deploy presses the title's own button", async () => {
    const w = world({ login: { state: () => "in", who: () => ({ id: "did:privy:x", label: "m•••••e@example.com" }) }, profile: { callsign: "ROOK", extractions: 4, arrears: 1150 } });
    await settle();
    expect(w.text(".hm-card")).toContain("ROOK");
    expect(w.text(".hm-card")).toContain("Stevedore");
    expect(w.text(".hm-tools")).toContain("2,550");
    expect(w.text(".hm-tools")).toContain("1,150");
    expect(w.text(".hm-tools")).toContain("m•••••e@example.com");
    expect(w.text(".hm-hero")).toContain("Longshore");
    expect(w.text(".hm-hero")).toContain("S-000026 · grade A · condition 92%");
    expect(w.text(".hm-play")).toContain("Raid · with the Longshore");
    w.home.root.querySelector<HTMLElement>(".hm-play")!.click();
    expect(w.pressed).toEqual(["deploy"]);
    w.home.root.querySelector<HTMLElement>(".hm-tab:nth-child(2)")!.click();
    await settle();
    expect(w.docked).toEqual(["open", "market"]);
  });

  it("signed in, Practice opens the offline game and remembers it was tried", async () => {
    const w = world({ login: { state: () => "in" }, profile: { callsign: "ROOK", extractions: 0, arrears: 0 } });
    await settle();
    expect(w.text(".hm-start")).toContain("2 of 4");
    w.home.root.querySelector<HTMLElement>('.hm-tile[data-mode="practice"]')!.click();
    w.home.root.querySelector<HTMLElement>(".hm-play")!.click();
    expect(w.went).toEqual(["/?game=v2&mock=1&stash=rich"]);
    expect(w.store.get(PRACTISED_KEY)).toBe("1");
  });

  it("inside Practice, a signed-out player still has to sign in before the raid starts", async () => {
    const w = world({ offline: true, profile: { callsign: "BREACHER", extractions: 0, arrears: 0 } });
    await settle();
    expect(w.text(".hm-play")).toContain("Sign in");
    w.home.root.querySelector<HTMLElement>(".hm-play")!.click();
    expect(w.opened).toEqual(["signin"]);
    expect(w.pressed).toEqual([]);
  });

  it("picking a mode changes the big button; the opening plays the film", async () => {
    const w = world({ login: { state: () => "in" }, profile: { callsign: "ROOK", extractions: 0, arrears: 0 } });
    await settle();
    w.home.root.querySelector<HTMLElement>('.hm-tile[data-mode="film"]')!.click();
    expect(w.home.mode()).toBe("film");
    expect(w.home.root.querySelector('.hm-tile[data-mode="film"]')!.getAttribute("aria-checked")).toBe("true");
    w.home.root.querySelector<HTMLElement>(".hm-play")!.click();
    expect(w.pressed).toEqual(["st-replay"]);
  });

  it("a record that can't be read shows as unknown, never as zero, and offers no step", async () => {
    const w = world({ login: { state: () => "in" }, fail: true });
    await settle();
    expect(w.text(".hm-card")).toContain("Reading your record");
    expect(w.home.root.querySelector(".hm-chip")).toBeNull();
    expect(w.home.root.querySelector<HTMLElement>(".hm-start")!.hidden).toBe(true);
  });

  it("the guide can be put away for good; a build with sign-in off plays Practice straight away", async () => {
    const w = world({ offline: true, login: null, profile: { callsign: "BREACHER", extractions: 0, arrears: 0 } });
    await settle();
    expect(w.home.root.querySelector(".hm-signin")).toBeNull();
    expect(w.text(".hm-play")).toContain("Deploy");
    expect(w.home.mode()).toBe("practice");
    w.home.root.querySelector<HTMLElement>(".hm-start-x")!.click();
    expect(w.store.get(START_DONE_KEY)).toBe("done");
    expect(w.home.root.querySelector<HTMLElement>(".hm-start")!.hidden).toBe(true);
  });

  it("stop() takes the lobby away and gives the title back", async () => {
    const w = world();
    await settle();
    w.home.stop();
    expect(document.querySelector(".hm")).toBeNull();
    expect(document.getElementById("app")!.classList.contains("hm-on")).toBe(false);
  });
});
