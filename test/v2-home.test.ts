// @vitest-environment happy-dom
// v2's start screen, the lobby: its rules (home/model.ts) and the screen itself (home/index.ts).
import { afterEach, describe, expect, it } from "vitest";
import { PRACTISED_KEY, START_DONE_KEY, startHome } from "../src/economy/v2/home";
import { type Facts, type PortEvent, RAID_LAPSE_MS, RANKS, actionFor, defaultMode, portRoster, rankOf, startStep } from "../src/economy/v2/home/model";
import type { Login } from "../src/economy/v2/login";

const facts = (over: Partial<Facts> = {}): Facts => ({ offline: false, skirmish: false, loginOn: true, signedIn: false, extractions: null, practised: false, gun: "Issue rifle", ...over });

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

  it("Skirmish is its own yard: the button goes there, deploys once there, and Practice leads back out", () => {
    const inn = { signedIn: true };
    expect(actionFor("skirmish", facts())).toEqual({ label: "Sign in", caption: "Skirmish · sign in first", do: "signin" });
    expect(actionFor("skirmish", facts(inn))).toEqual({ label: "Play skirmish", caption: "Live · players can shoot you", do: "skirmish" });
    expect(actionFor("skirmish", facts({ ...inn, offline: true }))).toMatchObject({ label: "Play skirmish", do: "skirmish" }); // in Practice: not this yard
    expect(actionFor("skirmish", facts({ ...inn, offline: true, skirmish: true, gun: "Issue rifle" }))).toEqual({ label: "Deploy", caption: "Skirmish · with the Issue rifle", do: "deploy" });
    expect(actionFor("practice", facts({ ...inn, offline: true, skirmish: true }))).toMatchObject({ label: "Play practice", do: "practice" });
    expect(actionFor("raid", facts({ ...inn, offline: true, skirmish: true }))).toMatchObject({ do: "online" });
    expect(defaultMode(true, true)).toBe("skirmish");
    expect(defaultMode(false, true)).toBe("raid"); // on the chain there is no skirmish
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

describe("the port roster", () => {
  const NOW = 1_800_000_000_000;
  const ev = (kind: string, account: string, minsAgo: number, text = ""): PortEvent => ({ kind, at: NOW - minsAgo * 60_000, account, callsign: account.toUpperCase(), text });

  it("someone is in the yard when the last word on their raid is that it started", () => {
    const r = portRoster([ev("raid_start", "rook", 9), ev("raid_start", "cutwater", 3), ev("raid_start", "marlo", 20), ev("extract", "marlo", 12, "got out")], NOW);
    expect(r.inYard).toEqual([
      { callsign: "ROOK", minutes: 9 },
      { callsign: "CUTWATER", minutes: 3 },
    ]);
  });
  it("a raid that ended, lapsed, or is the reader's own isn't listed", () => {
    const lapsed = RAID_LAPSE_MS / 60_000 + 1;
    const r = portRoster([ev("raid_start", "dead", 8), ev("wreck", "dead", 5), ev("raid_start", "taken", 8), ev("impound", "taken", 2), ev("raid_start", "gone", lapsed), ev("raid_start", "me", 4)], NOW, "me");
    expect(r.inYard).toEqual([]);
  });
  it("lists the last three to reach the boat, newest first, in the ledger's words", () => {
    const r = portRoster([ev("extract", "a", 50, "A got out"), ev("extract", "b", 5, "B got out with 2 chips"), ev("extract", "c", 20, "C got out"), ev("extract", "d", 90, "D got out"), ev("sale", "e", 1, "sold")], NOW);
    expect(r.back.map((b) => b.callsign)).toEqual(["B", "C", "A"]);
    expect(r.back[0]).toEqual({ callsign: "B", text: "B got out with 2 chips", minutes: 5 });
  });
  it("an empty record is an empty port, and a missing callsign shows the account", () => {
    expect(portRoster([], NOW)).toEqual({ inYard: [], back: [] });
    expect(portRoster([{ kind: "raid_start", at: NOW - 60_000, account: "abcdef0123456789", text: "" }], NOW).inYard[0].callsign).toBe("abcdef…");
  });
});

describe("the lobby", () => {
  afterEach(() => (document.body.innerHTML = ""));

  function world(opts: { offline?: boolean; skirmish?: boolean; login?: Partial<Login> | null; profile?: unknown; fail?: boolean; wire?: PortEvent[] | "down" } = {}) {
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
      recent: async () => {
        if (opts.wire === "down") throw new Error("rpc down");
        return opts.wire ?? [];
      },
      leaderboard: async () => ({ netWorth: [], makers: [], extractions: [{ accountId: "rook.testnet", callsign: "ROOK", value: 12 }] }),
      weapons: async () => [{ serial: "S-000026", frame: "longshore", grade: "A", condition: 92 }],
    };
    const v2: any = { chain, wallet: { accountId: () => "ab".repeat(32) }, loadout: { weapon: "S-000026", plates: 0, charges: 0, mags: 0 }, raid: null };
    const handlers = new Map<string, () => void>();
    const G: any = { events: { on: (k: string, f: () => void) => handlers.set(k, f), off: () => {} } };
    const home = startHome(G, { v2, offline: !!opts.offline, skirmish: !!opts.skirmish, login: () => login, dock: () => dock as never, storage, go: (u) => void went.push(u) });
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
    expect(w.home.root.querySelectorAll(".hm-tile")).toHaveLength(4);
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
    // "Start here" says to sign in, which the big button already does: it points at it, not a second button.
    expect(w.home.root.querySelector(".hm-start-b")).toBeNull();
    expect(w.text(".hm-start")).toContain("Press SIGN IN to go");
    w.home.root.querySelector<HTMLElement>('.hm-tile[data-mode="practice"]')!.click();
    expect(w.text(".hm-play")).toContain("Practice · sign in first");
    w.home.root.querySelector<HTMLElement>(".hm-play")!.click();
    expect(w.opened).toEqual(["signin", "signin", "signin", "signin"]);
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

  it("Skirmish is picked in the lobby: from the chain game or Practice it goes to its own yard, and deploys once there", async () => {
    const w = world({ login: { state: () => "in" }, profile: { callsign: "ROOK", extractions: 0, arrears: 0 } });
    await settle();
    const tile = w.home.root.querySelector<HTMLElement>('.hm-tile[data-mode="skirmish"]')!;
    expect(tile.textContent).toContain("Live PvP");
    expect(tile.textContent).toContain("They can shoot you");
    tile.click();
    expect(w.text(".hm-play")).toContain("Play skirmish");
    w.home.root.querySelector<HTMLElement>(".hm-play")!.click();
    expect(w.went).toEqual(["/?game=v2&mock=1&stash=rich&pvp=1"]);
    expect(w.pressed).toEqual([]);

    const practice = world({ offline: true, login: null, profile: { callsign: "BREACHER", extractions: 0, arrears: 0 } });
    await settle();
    expect(practice.home.mode()).toBe("practice"); // Practice never opens on the fighting yard
    expect(practice.text('.hm-tile[data-mode="practice"]')).toContain("You are here");
    practice.home.root.querySelector<HTMLElement>('.hm-tile[data-mode="skirmish"]')!.click();
    practice.home.root.querySelector<HTMLElement>(".hm-play")!.click();
    expect(practice.went).toEqual(["/?game=v2&mock=1&stash=rich&pvp=1"]);

    const yard = world({ offline: true, skirmish: true, login: null, profile: { callsign: "BREACHER", extractions: 0, arrears: 0 } });
    await settle();
    expect(yard.home.mode()).toBe("skirmish");
    expect(yard.text('.hm-tile[data-mode="skirmish"]')).toContain("You are here");
    expect(yard.text(".hm-play")).toContain("Deploy");
    yard.home.root.querySelector<HTMLElement>(".hm-play")!.click();
    expect(yard.pressed).toEqual(["deploy"]);
    yard.home.root.querySelector<HTMLElement>('.hm-tile[data-mode="practice"]')!.click();
    yard.home.root.querySelector<HTMLElement>(".hm-play")!.click();
    expect(yard.went).toEqual(["/?game=v2&mock=1&stash=rich"]);
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

  it("shows the other players: who is in the yard, who just got back, and the top of the board", async () => {
    const now = Date.now();
    const w = world({ wire: [{ kind: "raid_start", at: now - 4 * 60_000, account: "cut.testnet", callsign: "CUTWATER", text: "" }, { kind: "extract", at: now - 9 * 60_000, account: "rook.testnet", callsign: "ROOK", text: "Rook reached the boat with 2 relay cores." }] });
    await settle();
    const port = w.text(".hm-port");
    expect(port).toContain("In the yard now · 1");
    expect(port).toContain("CUTWATER");
    expect(port).toContain("4 min in");
    expect(port).toContain("Rook reached the boat with 2 relay cores.");
    expect(port).toContain("1 · ROOK");
  });

  it("a port whose record can't be read says unknown, never that nobody is there", async () => {
    const w = world({ wire: "down" });
    await settle();
    expect(w.text(".hm-port")).toContain("didn't answer");
    expect(w.text(".hm-port")).not.toContain("Nobody is over the fence");
  });

  it("stop() takes the lobby away and gives the title back", async () => {
    const w = world();
    await settle();
    w.home.stop();
    expect(document.querySelector(".hm")).toBeNull();
    expect(document.getElementById("app")!.classList.contains("hm-on")).toBe(false);
  });
});
