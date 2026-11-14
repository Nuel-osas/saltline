// v2's start screen: a lobby (G.home) in place of the title card. One screen says who you are, what you hold, what
// you can do and what to do first:
//
//   [player card]              SALTLINE                 [scrip][owed][sign in][⛶][?][⚙]
//                                                        SELECT MODE
//                                                        [Raid]
//                  your gun, over the live yard          [Practice]
//                                                        [The opening]
//   [start here · n of 4]
//                  [armoury][market][vendors][ledger]    [▶ the next step]
//
// The arrangement is the mobile-shooter lobby's; the look, the words and the drawings are this game's own. It draws
// over the title screen and drives it: the big button presses the title's own Deploy, so sign-on, the film and the
// raid start exactly as before. Rules are in model.ts; a number that couldn't be read shows as unknown, never 0.
import type { Dock } from "../dock/dock";
import { gunSvg } from "../dock/gunart";
import { FRAMES, ISSUE } from "../items";
import type { Login } from "../login";
import type { Profile, V2, Weapon } from "../types";
import { type Do, type Facts, type Mode, type PortEvent, actionFor, defaultMode, portRoster, rankOf, startStep } from "./model";
import "./home.css";

/* eslint-disable @typescript-eslint/no-explicit-any -- the game context is the untyped bundle's G */
type Game = any;

export interface HomeOptions {
  v2: V2;
  /** True for the offline game (?mock). */
  offline: boolean;
  /** True for the offline game with fighting on (?mock&pvp): the Skirmish yard. */
  skirmish?: boolean;
  login: () => Login | null;
  dock: () => Dock | null;
  storage?: Pick<Storage, "getItem" | "setItem">;
  go?: (url: string) => void;
}

export interface Home {
  readonly root: HTMLElement;
  mode(): Mode;
  refresh(): Promise<void>;
  stop(): void;
}

export const PRACTISED_KEY = "saltline.home.practised.v1";
export const START_DONE_KEY = "saltline.home.start.v1";

type Child = Node | string | null | false | undefined;
function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string | null> | null, ...kids: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) if (v != null) el.setAttribute(k, v);
  for (const kid of kids) if (kid) el.append(kid);
  return el;
}
const fill = (el: Element, ...kids: Child[]) => el.replaceChildren(...kids.filter((k): k is Node | string => !!k));
const fmt = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? "unknown" : Math.round(n).toLocaleString("en-US"));
const svg = (markup: string, cls: string) => {
  const el = h("span", { class: cls, "aria-hidden": "true" });
  el.innerHTML = markup; // our own drawings only (gunart.ts and the icons below)
  return el;
};

const ICON: Record<string, string> = {
  armoury: '<svg viewBox="0 0 24 24"><path d="M2 9h14l2-2h4v4h-5l-1 2h-4l-1 4H8l1-4H4l-2-2z" fill="currentColor"/></svg>',
  market: '<svg viewBox="0 0 24 24"><path d="M3 3h8l10 10-8 8L3 11V3zm5 3a2 2 0 100 4 2 2 0 000-4z" fill="currentColor" fill-rule="evenodd"/></svg>',
  vendors: '<svg viewBox="0 0 24 24"><path d="M3 7l9-4 9 4v10l-9 4-9-4V7zm9 5l6.5-3M12 12v8M12 12L5.5 9" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>',
  ledger: '<svg viewBox="0 0 24 24"><path d="M5 3h14v18H5V3zm3 5h8M8 12h8M8 16h5" fill="none" stroke="currentColor" stroke-width="2"/></svg>',
  full: '<svg viewBox="0 0 24 24"><path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5" fill="none" stroke="currentColor" stroke-width="2"/></svg>',
  cog: '<svg viewBox="0 0 24 24"><path d="M12 8a4 4 0 100 8 4 4 0 000-8zm0-5l1.5 3 3.2-.9 1 3.1 3.1 1-1 3.2 2.2 2.4-2.6 2 .3 3.3-3.3.2-1.6 2.9L12 20.7 9.2 22.2l-1.6-2.9-3.3-.2.3-3.3-2.6-2 2.2-2.4-1-3.2 3.1-1 1-3.1 3.2.9L12 3z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>',
  play: '<svg viewBox="0 0 24 24"><path d="M6 3l15 9-15 9V3z" fill="currentColor"/></svg>',
  // Two breachers facing each other across a sight.
  skirmish:
    '<svg viewBox="0 0 120 60"><g fill="none" stroke="currentColor" stroke-width="2"><circle cx="60" cy="30" r="13"/><path d="M60 11v10M60 39v10M41 30h10M69 30h10"/></g><g fill="currentColor"><circle cx="20" cy="17" r="5"/><path d="M11 50V33a9 9 0 0118 0v17z"/><circle cx="100" cy="17" r="5"/><path d="M91 50V33a9 9 0 0118 0v17z"/></g></svg>',
  film: '<svg viewBox="0 0 120 60"><rect x="8" y="10" width="104" height="40" fill="none" stroke="currentColor" stroke-width="2"/><path d="M8 20h104M8 40h104M22 10v10M38 10v10M54 10v10M70 10v10M86 10v10M102 10v10M22 40v10M38 40v10M54 40v10M70 40v10M86 40v10M102 40v10" stroke="currentColor" stroke-width="2"/><path d="M53 24l16 6-16 6z" fill="currentColor"/></svg>',
};

const MODES: { id: Mode; label: string; line: string; tag?: string }[] = [
  { id: "raid", label: "Raid", line: "Over the fence with your own gun. What you carry out is yours, on the chain.", tag: "On chain" },
  { id: "practice", label: "Practice", line: "The whole port in memory, with a full locker. Nothing is at stake." },
  { id: "skirmish", label: "Skirmish", line: "The practice yard with other players in it. They can shoot you, and you them.", tag: "Live PvP" },
  { id: "film", label: "The opening", line: "Why you were sent, the crate, and the rifle. 48 seconds.", tag: "New" },
];

export function startHome(G: Game, opts: HomeOptions): Home {
  const { v2 } = opts;
  const app = document.getElementById("app");
  const storage = opts.storage ?? localStorage;
  const go = opts.go ?? ((url: string) => location.assign(url));
  const read = (k: string) => {
    try {
      return storage.getItem(k);
    } catch {
      return null;
    }
  };
  const skirmish = opts.offline && !!opts.skirmish;
  let mode: Mode = defaultMode(opts.offline, skirmish);
  let profile: Profile | null | undefined; // undefined: not read yet or the read failed; null: no dock pass
  let scrip: number | null = null;
  let guns: Weapon[] | null = null;
  // The other players: undefined until read, null when the read failed (shown as unknown, never as "nobody").
  let wire: PortEvent[] | null | undefined;
  let board: { callsign: string; value: number }[] | null | undefined;
  let stopped = false;

  // ---- the pieces ----
  const card = h("button", { class: "hm-card", type: "button" });
  const tools = h("div", { class: "hm-tools" });
  const hero = h("button", { class: "hm-hero", type: "button", "aria-label": "Your gun. Open the loadout." });
  const tiles = h("div", { class: "hm-tiles", role: "radiogroup", "aria-label": "Select mode" });
  const port = h("aside", { class: "hm-port", "aria-label": "At the port" });
  const start = h("aside", { class: "hm-start", "aria-label": "Start here" });
  const tabs = h("nav", { class: "hm-tabs", "aria-label": "The dock" });
  const play = h("button", { class: "hm-play", type: "button" });
  const root = h(
    "div",
    { class: "hm", "aria-label": "Lobby" },
    h("div", { class: "hm-smoke", "aria-hidden": "true" }),
    h("header", { class: "hm-top" }, card, h("p", { class: "hm-word" }, h("b", null, "B4"), "Saltline"), tools),
    port,
    hero,
    h(
      "aside",
      { class: "hm-modes" },
      h("p", { class: "hm-eye" }, "Select mode"),
      h("p", { class: "hm-lede" }, skirmish ? "You are in Skirmish: the practice yard, with other players in it who can shoot you. Nothing is kept." : opts.offline ? "You are in Practice: the port runs in this browser and nothing is kept. Go on chain to own what you carry out." : "Sign in once to play. Practice risks nothing. A raid is the real thing: your gun, your haul and your invoice are on NEAR."),
      tiles,
    ),
    start,
    tabs,
    play,
  );

  // ---- what it knows ----
  const login = () => opts.login();
  const signedIn = () => (login() ? login()!.state() === "in" : true);
  const gun = (): { name: string; frame: Weapon["frame"] | "issue"; line: string } => {
    const serial = v2.loadout?.weapon ?? null;
    const w = serial ? guns?.find((g) => g.serial === serial) : null;
    if (!w) return { name: "Issue rifle", frame: "issue", line: `${ISSUE.name} · issued at the gate · can't be lost` };
    const name = FRAMES[w.frame].name.split(" ").slice(1).join(" ");
    return { name, frame: w.frame, line: `${w.serial} · grade ${w.grade} · condition ${w.condition}%` };
  };
  const facts = (): Facts => ({
    offline: opts.offline,
    skirmish,
    loginOn: !!login(),
    signedIn: signedIn(),
    extractions: profile === undefined ? null : (profile?.extractions ?? 0),
    practised: read(PRACTISED_KEY) === "1",
    gun: gun().name,
  });

  // ---- what it does ----
  const pressTitle = (sel: string) => document.querySelector<HTMLElement>(`.menu ${sel}`)?.click();
  function openDock(tab: "loadout" | "armoury" | "market" | "vendors" | "ledger") {
    if (!signedIn()) return login()?.open();
    const dock = opts.dock();
    if (!dock) return;
    void dock.open("title" as never).then(() => dock.gate === "in" && dock.setTab(tab));
  }
  function act(what: Do) {
    if (what === "signin") return login()?.open();
    if (what === "deploy") return pressTitle('[data-act="deploy"]');
    if (what === "film") return pressTitle(".st-replay");
    if (what === "vendors") return openDock("vendors");
    if (what === "practice") {
      try {
        storage.setItem(PRACTISED_KEY, "1");
      } catch {
        // the step just shows again next time
      }
      return go(`${location.pathname}?game=v2&mock=1&stash=rich`);
    }
    if (what === "skirmish") return go(`${location.pathname}?game=v2&mock=1&stash=rich&pvp=1`);
    if (what === "online") return go(`${location.pathname}?game=v2`);
  }

  // ---- drawing ----
  function draw() {
    const f = facts();
    const l = login();
    const who = l?.who() ?? null;
    const rank = rankOf(profile?.extractions);
    const name = profile?.callsign ?? (opts.offline ? (skirmish ? "Skirmish" : "Practice") : f.signedIn ? "No dock pass yet" : "Guest");
    fill(
      card,
      h("span", { class: "hm-ava", "aria-hidden": "true" }, (profile?.callsign ?? "?").slice(0, 1).toUpperCase()),
      h(
        "span",
        { class: "hm-id" },
        h("b", null, name),
        h("span", { class: "hm-lv" }, h("i", null, `Lv ${rank.level}`), h("span", { class: "hm-xp" }, h("u", { style: `width:${Math.round((rank.into / rank.need) * 100)}%` })), h("em", null, `${rank.into}/${rank.need}`)),
        h("span", { class: "hm-rank" }, profile === undefined && f.signedIn && !opts.offline ? "Reading your record…" : `${rank.name} · ${fmt(profile?.extractions ?? 0)} raids home`),
      ),
    );
    card.setAttribute("aria-label", `${name}. ${rank.name}, level ${rank.level}. Open the ledger.`);

    const chip = (value: string, unit: string, tab: "ledger", cls = "") => {
      const b = h("button", { class: `hm-chip ${cls}`, type: "button" }, h("b", null, value), h("i", null, unit));
      b.onclick = () => openDock(tab);
      return b;
    };
    const icon = (key: string, label: string, on: () => void) => {
      const b = h("button", { class: "hm-icon", type: "button", "aria-label": label, title: label });
      b.append(key === "?" ? "?" : svg(ICON[key], "hm-i"));
      b.onclick = on;
      return b;
    };
    const signIn = h("button", { class: "hm-signin", type: "button" }, "Sign in");
    signIn.onclick = () => l?.open();
    const account = who ? h("details", { class: "hm-acct" }, h("summary", null, who.label)) : null;
    if (account) {
      const out = h("button", { type: "button" }, "Sign out");
      out.onclick = () => void l?.signOut();
      account.append(out);
    }
    fill(
      tools,
      profile ? chip(fmt(scrip), "scrip", "ledger") : null,
      profile ? chip(fmt(profile.arrears), "owed", "ledger", profile.arrears > 0 ? "owe" : "") : null,
      l && !f.signedIn ? signIn : account,
      icon("full", "Full screen", () => void (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen?.())?.catch?.(() => {})),
      icon("?", "Controls", () => pressTitle('[data-act="controls"]') ?? pressTitle('[data-act="settings"]')),
      icon("cog", "Settings", () => pressTitle('[data-act="settings"]')),
    );

    const g = gun();
    const art = svg(gunSvg(g.frame), "hm-gun d2-art");
    art.dataset.frame = g.frame;
    fill(hero, h("span", { class: "hm-hero-k" }, "Your gun"), art, h("span", { class: "hm-hero-n" }, g.name), h("span", { class: "hm-hero-l" }, g.line), h("span", { class: "hm-hero-c" }, "Change"));

    const a = actionFor(mode, f);
    fill(
      tiles,
      ...MODES.map((m) => {
        const needsSignIn = f.loginOn && !f.signedIn;
        const here = f.offline && (m.id === "skirmish") === f.skirmish;
        const note = needsSignIn
          ? "Sign in"
          : m.id === "raid"
            ? f.offline ? "Leave practice" : ""
            : m.id === "practice"
              ? here ? "You are here" : "No stake"
              : m.id === "skirmish"
                ? here ? "You are here" : "No stake"
                : "48 s";
        const drawn = m.id === "film" || m.id === "skirmish";
        const tileArt = drawn ? svg(ICON[m.id], "hm-tile-art") : svg(gunSvg(m.id === "practice" ? "issue" : g.frame), "hm-tile-art d2-art");
        if (!drawn) tileArt.dataset.frame = m.id === "practice" ? "issue" : g.frame;
        const t = h(
          "button",
          { class: "hm-tile", type: "button", role: "radio", "aria-checked": String(mode === m.id), "data-mode": m.id },
          tileArt,
          m.tag ? h("span", { class: "hm-tag" }, m.tag) : null,
          h("span", { class: "hm-tile-line" }, m.line),
          h("span", { class: "hm-strip" }, h("b", null, m.label), h("i", null, note)),
        );
        t.onclick = () => ((mode = m.id), draw());
        return t;
      }),
    );
    fill(play, svg(ICON.play, "hm-play-i"), h("span", { class: "hm-play-t" }, h("b", null, a.label), h("i", null, a.caption)));
    play.onclick = () => act(a.do);

    // The port: who else is here. Anyone can read it, signed in or not.
    const ago = (m: number) => (m < 1 ? "now" : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h`);
    const rows = (items: Child[], none: string) => (items.length ? h("ul", null, ...items) : h("p", { class: "hm-port-none" }, none));
    if (wire === null) {
      fill(port, h("p", { class: "hm-eye" }, "At the port"), h("p", { class: "hm-port-none", "data-unknown": "1" }, "The port's record didn't answer. Unknown, not empty."));
    } else {
      const r = portRoster(wire ?? [], Date.now(), v2.wallet.accountId());
      fill(
        port,
        h("p", { class: "hm-eye" }, "At the port"),
        opts.offline ? h("p", { class: "hm-port-none" }, "Practice: these breachers are simulated. Go on chain for the real ones.") : null,
        h("p", { class: "hm-port-k" }, h("i", { class: r.inYard.length ? "on" : "" }), `In the yard now · ${wire === undefined ? "…" : r.inYard.length}`),
        rows(r.inYard.slice(0, 4).map((p) => h("li", null, h("b", null, p.callsign), h("span", null, `${ago(p.minutes)} in`))), wire === undefined ? "Reading the port's record…" : "Nobody is over the fence right now."),
        h("p", { class: "hm-port-k" }, "Just back"),
        rows(r.back.map((p) => h("li", { class: "hm-port-back" }, h("b", null, p.callsign), h("span", null, ago(p.minutes)), h("em", null, p.text))), wire === undefined ? "…" : "Nobody has reached the boat lately."),
        board && board.length ? h("p", { class: "hm-port-k" }, "Most raids home") : null,
        board && board.length ? h("ol", null, ...board.slice(0, 3).map((p, i) => h("li", null, h("b", null, `${i + 1} · ${p.callsign}`), h("span", null, fmt(p.value))))) : null,
      );
    }

    const step = read(START_DONE_KEY) === "done" ? null : startStep(f);
    start.hidden = !step;
    if (step) {
      // When the step is what the big button already does, it points at that button instead of being a second one.
      const same = step.do === a.do;
      const doIt = same ? h("p", { class: "hm-start-h" }, `Press ${a.label.toUpperCase()} to go`) : h("button", { class: "hm-start-b", type: "button" }, step.button);
      if (!same) doIt.onclick = () => act(step.do);
      const x = h("button", { class: "hm-start-x", type: "button", "aria-label": "Hide this guide" }, "×");
      x.onclick = () => {
        try {
          storage.setItem(START_DONE_KEY, "done");
        } catch {
          // it shows again next time
        }
        draw();
      };
      fill(start, h("p", { class: "hm-start-k" }, `Start here · ${step.n} of 4`), h("p", { class: "hm-start-t" }, step.text), doIt, x);
    }
  }

  fill(
    tabs,
    ...(["armoury", "market", "vendors", "ledger"] as const).map((t) => {
      const b = h("button", { class: "hm-tab", type: "button" }, svg(ICON[t], "hm-i"), h("span", null, t));
      b.onclick = () => openDock(t);
      return b;
    }),
  );
  hero.onclick = () => openDock("loadout");
  card.onclick = () => openDock("ledger");

  /** Reads the player's record. A failed read leaves "unknown" on screen; it is never shown as zero. */
  /** The other players, from the contract's record. Public: it is read whether or not anyone is signed in. */
  async function readPort() {
    const quiet = <T>(fn: () => Promise<T>): Promise<T | null> => Promise.resolve().then(fn).catch(() => null);
    const [events, leaders] = await Promise.all([quiet(() => v2.chain.recent(40)), quiet(() => v2.chain.leaderboard())]);
    wire = events;
    board = leaders ? leaders.extractions.map((p) => ({ callsign: p.callsign, value: Number(p.value) })).filter((p) => p.value > 0) : null;
  }

  async function refresh() {
    if (stopped) return;
    await readPort();
    const me = v2.wallet.accountId();
    if (!me || !signedIn()) {
      profile = signedIn() ? undefined : null;
      scrip = null;
      guns = null;
      return draw();
    }
    try {
      profile = await v2.chain.profile(me);
    } catch {
      profile = undefined;
    }
    if (profile) {
      const [bal, held] = await Promise.all([v2.chain.balances(me).catch(() => null), v2.chain.weapons(me).catch(() => null)]);
      scrip = bal ? ((bal as Record<string, number>).scrip ?? 0) : null;
      guns = held;
    }
    draw();
  }

  // ---- mounting: over the title screen, under the settings panel ----
  function mount() {
    const title = document.querySelector('.menu .m-screen[data-s="title"]');
    if (!title) return false;
    title.after(root);
    app?.classList.add("hm-on");
    return true;
  }
  // The title is usually there already; if not, look again for a few seconds. Never mount twice.
  let tries = 0;
  let mounting = 0;
  if (!mount()) mounting = window.setInterval(() => (mount() || ++tries > 40) && clearInterval(mounting), 150);
  draw();
  void refresh();
  const again = setInterval(() => !document.hidden && root.offsetParent !== null && void refresh(), 20_000);
  const onState = () => void refresh();
  G.events?.on?.("login:state", onState);

  const home: Home = {
    root,
    mode: () => mode,
    refresh,
    stop() {
      stopped = true;
      clearInterval(mounting);
      clearInterval(again);
      G.events?.off?.("login:state", onState);
      app?.classList.remove("hm-on");
      root.remove();
    },
  };
  G.home = home;
  return home;
}
