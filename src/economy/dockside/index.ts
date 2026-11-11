// The Dockside: the between-runs market. It opens from the title, debrief and dead cards (never mid-run), sits over
// the live scene like the game's own cards, and never captures the pointer. Closing returns to the card it came
// from; Deploy goes back into a run through that card's own button, with the gear picked in the hold.
//
// createDockside(G, economy) builds it, adds a DOCKSIDE button to the three cards and returns a small handle.
// It reads the chain through economy.chain, polls while open, and every action shows settling → result.
import "./dockside.css";
import type { GearId } from "../types";
import { addWrecks, awayLines, createAwayCard, loadSeen, noteNews, saveSeen, seenFrom, type AwayReads } from "./away";
import { createBoard } from "./board";
import { createEntries, type Origin } from "./entry";
import { okv, runAct, type Ctx, type EconomyWithGear, type ReadKey, type Reads } from "./ctx";
import { fill, h, reducedMotion, text } from "./dom";
import { fmt, UNKNOWN } from "./format";
import { createDeployGate, type DeployAct, type DeployGate, type DeployGateOptions, type DeployRequest } from "./gate";
import { createHold } from "./hold";
import { createMarket } from "./market";
import { createPad, focusables, moveFocus, type Dir } from "./pad";
import { createPass } from "./pass";
import { gameChimes, type Chimes } from "./sound";
import { createStall } from "./stall";
import { createTicker } from "./ticker";
import { createTooltip } from "./tooltip";
import { ACTS, createTown } from "./town";
import { createWeek } from "./week";

export interface GameLike {
  events?: { on(name: string, fn: (e: never) => void): unknown; emit(name: string, e?: unknown): void };
  game?: { state?: string; menus?: { root?: HTMLElement; screen?: string; panelOpen?: boolean } };
}

export type { Origin };
export type Tab = "stalls" | "market" | "board" | "week" | "town";
const TABS: { id: Tab; label: string }[] = [
  { id: "stalls", label: "Stalls" },
  { id: "market", label: "Market" },
  { id: "board", label: "Board" },
  { id: "week", label: "The week" },
  { id: "town", label: "Town" },
];
/** The card button Deploy presses, so a run starts exactly as the game starts it. */
const DEPLOY_ACT: Record<Origin, string> = { title: "deploy", dead: "retry", complete: "redeploy" };
const ORIGINS: Origin[] = ["title", "dead", "complete"];
/** Where a held deploy can open the pass card from: the three cards, and the pause card's Restart. */
const DEPLOY_FROM: string[] = [...ORIGINS, "paused"];
const DEPLOY_LEDE = "Sign on before you go over the fence. Your pass carries your cargo, your wrecks and your name on the board.";
const CLAIM_LABEL: Record<DeployAct, string> = {
  deploy: "Claim pass and deploy",
  redeploy: "Claim pass and redeploy",
  retry: "Claim pass and retry",
  restart: "Claim pass and restart",
};

const POLL: Record<ReadKey, number> = { brokers: 4000, recent: 4000, balances: 8000, profile: 60000, listings: 10000, leaderboard: 12000, town: 8000 };
/** A town that can't be read (or a contract without one yet) is asked again less often. */
const TOWN_RETRY = 30000;

export interface DocksideOptions {
  /** Where the overlay mounts (default #ui, else body). */
  host?: HTMLElement;
  /** The deploy gate's timings (tests shorten them). */
  gate?: Pick<DeployGateOptions, "quietMs" | "askMs">;
  /** The trade sounds (default: on the game's own audio, volume and mute). */
  chimes?: Chimes;
}

export interface Dockside {
  readonly root: HTMLElement;
  readonly isOpen: boolean;
  readonly gate: "closed" | "checking" | "pass" | "unknown" | "in";
  open(from?: Origin): Promise<void>;
  close(): void;
  deploy(): void;
  tab(t: Tab): void;
  refresh(...keys: ReadKey[]): Promise<void>;
  /** The fast-forward panel (for the screenshot script). */
  readonly week: ReturnType<typeof createWeek>;
  /** Holds the game's deploy buttons until the wallet has a dock pass (gate.ts). */
  readonly deployGate: DeployGate;
  /** The trade sounds (sound.ts). */
  readonly chimes: Chimes;
}

export function createDockside(G: GameLike, economy: EconomyWithGear, opts: DocksideOptions = {}): Dockside {
  const eco = economy as EconomyWithGear & { equipped: GearId[] };
  eco.equipped ??= [];
  const { chain, wallet } = eco;
  const reads: Reads = {
    brokers: { s: "loading" },
    balances: { s: "loading" },
    profile: { s: "loading" },
    listings: { s: "loading" },
    recent: { s: "loading" },
    leaderboard: { s: "loading" },
    town: { s: "loading" },
  };
  const emit = (n: string, e: unknown = {}) => {
    try {
      G.events?.emit(n, e);
    } catch {
      /* the game's bus never stops the Dockside */
    }
  };
  let lastTick = 0;
  let registered: boolean | null = null;
  let isOpen = false;
  let gate: Dockside["gate"] = "closed";
  let origin: Origin | "paused" = "title";
  let tab: Tab = "stalls";
  /** The game's deploy press this visit is holding, when the Dockside opened on its pass card for it. */
  let deployReq: DeployRequest | null = null;
  /** True once this visit's "while you were away" diff is taken: from then on, what's read is what they've seen. */
  let seenLive = false;
  let awayToken = 0;
  let away: { el: HTMLElement; ok: HTMLButtonElement } | null = null;

  // ---- the shared context ----
  const inflight: Partial<Record<ReadKey, Promise<void>>> = {};
  const due: Partial<Record<ReadKey, number>> = {};
  const fetchers: Record<ReadKey, () => Promise<unknown>> = {
    brokers: () => chain.brokers(),
    balances: () => {
      const me = wallet.accountId();
      return me ? chain.balances(me) : Promise.reject(new Error("no account"));
    },
    profile: () => {
      const me = wallet.accountId();
      return me ? chain.profile(me) : Promise.resolve(null);
    },
    listings: () => chain.listings(),
    recent: () => chain.recent(20),
    leaderboard: () => chain.leaderboard(),
    // Optional on the Chain: a client without it reads as unknown, the same as a failed read.
    town: () => (chain.town ? chain.town() : Promise.reject(new Error("town: this chain has no town view"))),
  };
  /** `own`: the read follows the player's own action, so it counts as seen even if they've closed the Dockside since. */
  function load(key: ReadKey, fresh = false, own = false): Promise<void> {
    const cur = inflight[key];
    if (cur) return fresh ? cur.then(() => load(key, false, own)) : cur;
    const p = fetchers[key]()
      .then(
        (v) => {
          (reads as Record<ReadKey, unknown>)[key] = { s: "ok", v };
          if (seenLive && (isOpen || own)) noteSeen({ [key]: v });
        },
        (e) => void ((reads as Record<ReadKey, unknown>)[key] = { s: "unknown", error: String(e) }),
      )
      .finally(() => {
        delete inflight[key];
        due[key] = Date.now() + (key === "town" && reads.town.s === "unknown" ? TOWN_RETRY : POLL[key]);
        paint(key);
      });
    inflight[key] = p;
    return p;
  }

  const chimes = opts.chimes ?? gameChimes(G);
  const ctx: Ctx = {
    economy: eco,
    chain,
    wallet,
    reads,
    me: () => wallet.accountId(),
    refresh: (...keys) => Promise.all(keys.map((k) => load(k, true, true))).then(() => {}),
    act: (slot, spec) => runAct(ctx, slot, spec),
    sound: (k) => emit(k === "click" ? "ui:click" : "ui:hover"),
    chime: (k) => void chimes.play(k),
    flapTick() {
      const now = performance.now();
      if (!isOpen || now - lastTick < 60) return;
      lastTick = now;
      emit("ui:hover");
    },
    render: () => paint(),
  };

  // ---- the frame ----
  const root = h("div", { class: "dk", role: "dialog", "aria-modal": "true", "aria-label": "Dockside", hidden: true, "data-gate": "closed", "data-tab": tab });
  const grain = h("div", { class: "dk-grain", "aria-hidden": "true" });
  const tabsEl = h(
    "nav",
    { class: "dk-tabs", role: "tablist", "aria-label": "Dockside" },
    ...TABS.map((t, i) =>
      h(
        "button",
        { class: "dk-tab", role: "tab", type: "button", "data-tab": t.id, "aria-selected": String(t.id === tab), onclick: () => setTab(t.id) },
        h("kbd", null, String(i + 1)),
        t.label,
        // The Town tab carries the town's act, so a change shows from any tab.
        t.id === "town" ? h("span", { class: "dk-tab-act", hidden: true }) : null,
      ),
    ),
  );
  const meT = h("span", { class: "dk-me" });
  const closeBtn = h("button", { class: "btn small dk-close", type: "button", onclick: () => close() }, "Close", h("kbd", null, "Esc"));
  const deployBtn = h("button", { class: "btn primary dk-deploy", type: "button", onclick: () => deploy() }, "Deploy");
  const top = h(
    "header",
    { class: "dk-top" },
    h(
      "div",
      { class: "dk-brand" },
      h("span", { class: "m-tag" }, "B4"),
      h("h2", { class: "dk-word" }, "Dockside"),
      h("span", { class: "dk-brand-sub" }, "Berth 4 market · prices set by every run"),
    ),
    tabsEl,
    h("div", { class: "dk-top-r" }, meT, closeBtn, deployBtn),
  );

  const stalls = (["moss", "ines", "qm"] as const).map((id, i) => createStall(ctx, id, i));
  const hold = createHold(ctx);
  const market = createMarket(ctx);
  const board = createBoard(ctx);
  const week = createWeek(ctx);
  const ticker = createTicker(ctx);
  const town = createTown(ctx);
  const tooltip = createTooltip(root);
  const panes: Record<Tab, HTMLElement> = {
    stalls: h("div", { class: "dk-pane", "data-pane": "stalls", role: "tabpanel" }, h("div", { class: "dk-stalls" }, ...stalls.map((s) => s.el))),
    market: h("div", { class: "dk-pane", "data-pane": "market", role: "tabpanel", hidden: true }, market.el),
    board: h("div", { class: "dk-pane", "data-pane": "board", role: "tabpanel", hidden: true }, board.el),
    week: h("div", { class: "dk-pane", "data-pane": "week", role: "tabpanel", hidden: true }, week.el),
    town: h("div", { class: "dk-pane", "data-pane": "town", role: "tabpanel", hidden: true }, town.el),
  };
  const main = h("main", { class: "dk-main" }, ...Object.values(panes), h("aside", { class: "dk-side" }, hold.el));
  const gateEl = h("div", { class: "dk-gate" });
  const awayEl = h("div", { class: "dk-away-wrap" });
  const bot = h("footer", { class: "dk-bot" }, ticker.el);
  root.append(h("div", { class: "dk-veil", "aria-hidden": "true" }), grain, top, main, bot, gateEl, awayEl, tooltip.el);
  (opts.host ?? document.getElementById("ui") ?? document.body).append(root);
  makeGrain(grain);

  function paint(key?: ReadKey) {
    if (!key || key === "brokers" || key === "balances" || key === "profile") {
      for (const s of stalls) s.update();
      hold.update();
      market.update();
      paintMe();
    }
    if (!key || key === "listings") market.update();
    if (!key || key === "leaderboard") board.update();
    if (!key || key === "recent") ticker.update();
    if (!key || key === "town") {
      town.update();
      if (key) for (const s of stalls) s.update(); // the Quartermaster's stall changes at the reveal
      paintAct();
    }
  }
  const actChip = tabsEl.querySelector<HTMLElement>(".dk-tab-act")!;
  function paintAct() {
    const t = okv(reads.town);
    actChip.hidden = !t;
    if (t) {
      text(actChip, ACTS[t.act - 1].numeral);
      actChip.dataset.act = String(t.act);
    }
  }
  function paintMe() {
    const b = okv(reads.balances);
    const p = okv(reads.profile);
    fill(meT, p?.callsign ? h("span", null, p.callsign) : null, h("b", null, b ? fmt(b.scrip ?? 0) : reads.balances.s === "loading" ? "…" : UNKNOWN), " scrip");
    entries.update(registered);
  }

  // ---- tabs ----
  function setTab(t: Tab) {
    if (t !== tab) emit("ui:click");
    tab = t;
    root.dataset.tab = t;
    for (const b of tabsEl.querySelectorAll<HTMLElement>(".dk-tab")) b.setAttribute("aria-selected", String(b.dataset.tab === t));
    for (const [id, el] of Object.entries(panes)) el.hidden = id !== t;
    tooltip.hide();
    if (t === "week") week.show();
    else week.hide();
    if (gate === "in") {
      if (t === "market") void load("listings");
      if (t === "board") void load("leaderboard");
    }
  }

  // ---- gate: pass card, checking, unknown ----
  async function checkGate() {
    setGate("checking");
    void load("recent");
    let reg: boolean | null;
    try {
      reg = await wallet.registered();
    } catch {
      reg = null;
    }
    if (!isOpen) return;
    registered = reg;
    deployGate.learn(reg);
    if (reg === true) return enter();
    if (reg === false) {
      const pass = createPass({
        chain,
        wallet,
        onDone: () => {
          signedOn();
          if (isOpen) enter();
        },
        onSound: () => emit("ui:click"),
      });
      gateEl.replaceChildren(pass.el);
      setGate("pass");
      setTimeout(() => pass.focus(), 60);
      return;
    }
    gateEl.replaceChildren(
      h(
        "section",
        { class: "dk-gate-card", role: "alertdialog", "aria-labelledby": "dk-gu-h" },
        h("div", { class: "m-k" }, "Dock office"),
        h("h2", { class: "dk-pass-h", id: "dk-gu-h" }, "No answer"),
        h("p", { class: "dk-pass-lede" }, `Your pass status is ${UNKNOWN}: the dock office can't be reached right now. Nothing has been charged.`),
        h("div", { class: "m-actions col" }, h("button", { class: "btn primary", type: "button", onclick: () => void checkGate() }, "Try again"), h("button", { class: "btn", type: "button", onclick: () => close() }, "Back")),
      ),
    );
    setGate("unknown");
    focusFirst();
  }
  function setGate(g: Dockside["gate"]) {
    gate = g;
    root.dataset.gate = g;
    if (g === "checking") gateEl.replaceChildren(h("p", { class: "dk-checking", role: "status" }, h("i"), "Checking your dock pass…"));
    main.inert = g !== "in";
    tabsEl.inert = g !== "in";
  }
  function enter() {
    setGate("in");
    gateEl.replaceChildren();
    const keys: ReadKey[] = ["brokers", "balances", "profile", "recent", "town"];
    if (tab === "market") keys.push("listings");
    if (tab === "board") keys.push("leaderboard");
    for (const k of keys) void load(k, true);
    paint();
    setTab(tab);
    focusFirst();
    void checkAway();
  }

  // ---- while you were away (away.ts): what changed since they last looked, once per visit ----
  const store = (): Storage | null => {
    try {
      return window.localStorage ?? null;
    } catch {
      return null;
    }
  };
  /** Folds what was just read into the snapshot of what they've seen. */
  function noteSeen(r: Partial<AwayReads>) {
    const me = wallet.accountId();
    if (me) saveSeen(store(), seenFrom(loadSeen(store(), me), r, me, Date.now()));
  }
  async function checkAway() {
    const me = wallet.accountId();
    if (!me) return;
    const token = ++awayToken;
    // Nothing this visit has read was folded in yet (seenLive went false when the overlay opened).
    const prev = loadSeen(store(), me);
    const got = <T>(f: () => Promise<T>): Promise<T | null> => {
      try {
        return Promise.resolve(f()).catch(() => null);
      } catch {
        return Promise.resolve(null);
      }
    };
    const [balances, brokers, recent, leaderboard, profile, wrecks] = await Promise.all([
      got(() => chain.balances(me)),
      got(() => chain.brokers()),
      got(() => chain.recent(64)),
      got(() => chain.leaderboard()),
      got(() => chain.profile(me)),
      got(() => chain.wrecks()),
    ]);
    // Closed before the reads came back: nothing was seen, so the snapshot stays for next time.
    if (token !== awayToken || !isOpen || gate !== "in") return;
    const now: AwayReads = { balances, brokers, recent, leaderboard, profile, wrecks };
    const lines = awayLines(prev, now, me);
    saveSeen(store(), { ...seenFrom(prev, now, me, Date.now()), news: [] }); // the caught lines are told now
    seenLive = true;
    if (!lines.length || !prev) return;
    hideAway(true);
    away = createAwayCard(lines, prev.at, () => hideAway());
    awayEl.replaceChildren(away.el);
    root.dataset.away = "on";
    // Scrip came in while they were gone: the till rings as the slip lands.
    if (lines.some((l) => l.kind === "scrip")) setTimeout(() => isOpen && away && ctx.chime("cash"), reducedMotion() ? 0 : 320);
    const ok = away.ok;
    setTimeout(() => {
      if (isOpen && away?.ok === ok)
        try {
          ok.focus({ preventScroll: true });
        } catch {
          /* best effort */
        }
    }, 60);
  }
  function hideAway(now = false) {
    if (!away) return;
    const el = away.el;
    const had = el.contains(document.activeElement);
    away = null;
    delete root.dataset.away;
    if (now || reducedMotion()) el.remove();
    else {
      el.classList.add("out");
      setTimeout(() => el.remove(), 240);
    }
    if (had && isOpen) focusFirst();
  }
  /** After a death: their new wreck goes into the snapshot, so a recovery before their next look can say what came home. */
  async function noteWrecks() {
    const me = wallet.accountId();
    if (!me || !loadSeen(store(), me)) return;
    let w;
    try {
      w = await chain.wrecks();
    } catch {
      return;
    }
    const seen = loadSeen(store(), me);
    if (seen) saveSeen(store(), addWrecks(seen, w));
  }
  /** While the Dockside is shut, lines about them are caught before they scroll out of the chain's last 64. */
  async function noteLedger() {
    const me = wallet.accountId();
    if (!me || !loadSeen(store(), me)) return;
    let r;
    try {
      r = await chain.recent(64);
    } catch {
      return;
    }
    const seen = loadSeen(store(), me);
    if (seen && !isOpen) saveSeen(store(), noteNews(seen, r));
  }

  /** A pass was issued here: everything that asks "registered?" hears yes, and the title's board stops asking. */
  function signedOn() {
    registered = true;
    deployGate.learn(true);
    entries.update(true);
  }

  // ---- the deploy gate: the game's deploy buttons, held until there's a pass (gate.ts) ----
  const deployGate = createDeployGate({
    menus: () => G.game?.menus?.root,
    state: () => G.game?.state,
    account: () => wallet.accountId(),
    registered: () => wallet.registered(),
    panelOpen: () => !!G.game?.menus?.panelOpen,
    free: () => !isOpen,
    passless: () => void (eco.passless = true),
    quietMs: opts.gate?.quietMs,
    askMs: opts.gate?.askMs,
    ui: {
      show(req) {
        if (!isOpen) {
          if (!DEPLOY_FROM.includes(req.from)) return;
          deployReq = req;
          show(req.from as Origin | "paused");
        } else if (deployReq !== req) return; // open for something else: the gate leaves presses alone then
        if (req.status === "checking") setGate("checking");
        else passFor(req);
      },
      hide() {
        if (!isOpen || !deployReq) return;
        deployReq = null; // the gate carries on itself; closing mustn't drop its press
        close();
      },
    },
  });

  /** The pass card for a held deploy: claim and carry on into that run, or play this one without salvage. */
  function passFor(req: DeployRequest) {
    const carryOn = (passless: boolean) => {
      if (deployReq !== req) return; // backed out while the stamp landed
      deployReq = null;
      close();
      deployGate.proceed(req, { passless });
    };
    const unsure = req.status === "unknown";
    const pass = createPass({
      chain,
      wallet,
      lede: DEPLOY_LEDE,
      claimLabel: CLAIM_LABEL[req.act],
      doneNote: "Over the fence…",
      notice: unsure ? `Your pass status is ${UNKNOWN}: the dock office is slow to answer. If you already hold a pass, deploy anyway.` : undefined,
      onSound: () => emit("ui:click"),
      onDone: () => {
        signedOn();
        carryOn(false);
      },
      // Unknown: they may hold a pass already, so the way on is the normal run (salvage if the pass is on file).
      skip: unsure
        ? { label: "Deploy anyway", note: "salvage if your pass is on file", onSkip: () => carryOn(false) }
        : { label: "Play without a pass", note: "no salvage this run", onSkip: () => carryOn(true) },
    });
    gateEl.replaceChildren(pass.el);
    setGate("pass");
    setTimeout(() => pass.focus(), 60);
  }

  // ---- open / close / deploy ----
  let poll: ReturnType<typeof setInterval> | null = null;
  const pad = createPad({
    move: (d) => moveFocus(root, d),
    press: () => (document.activeElement as HTMLElement | null)?.click?.(),
    back: () => back(),
    tab: (n) => gate === "in" && setTab(TABS[(TABS.findIndex((t) => t.id === tab) + n + TABS.length) % TABS.length].id),
  });

  async function open(from?: Origin) {
    if (isOpen) return;
    const state = G.game?.state ?? "title";
    const o = from ?? (ORIGINS.includes(state as Origin) ? (state as Origin) : null);
    if (!o || (G.game?.state && !ORIGINS.includes(G.game.state as Origin))) return; // never mid-run
    show(o);
    await checkGate();
  }

  /** The overlay comes up over the card it was opened from. */
  function show(o: Origin | "paused") {
    origin = o;
    isOpen = true;
    // Nothing read from here on counts as seen until this visit's away diff is taken (checkGate reads the ledger first).
    seenLive = false;
    root.hidden = false;
    root.classList.remove("out");
    document.getElementById("app")?.classList.add("dk-on");
    void root.offsetWidth;
    root.classList.add("on");
    root.dataset.from = o;
    emit("dock:open", { from: o });
    window.addEventListener("keydown", onKey, true);
    poll = setInterval(tickPoll, 1000);
    ticker.start();
    pad.start();
  }

  function close() {
    if (!isOpen) return;
    isOpen = false;
    // Backing out of the pass card drops the held press: the game stays on its card.
    if (deployReq) deployGate.cancel(deployReq);
    deployReq = null;
    awayToken++;
    hideAway(true);
    awayEl.replaceChildren(); // a slip still fading out goes too
    tooltip.hide();
    week.hide();
    ticker.stop();
    pad.stop();
    if (poll) clearInterval(poll);
    poll = null;
    window.removeEventListener("keydown", onKey, true);
    root.classList.remove("on");
    root.classList.add("out");
    document.getElementById("app")?.classList.remove("dk-on");
    setTimeout(() => !isOpen && ((root.hidden = true), root.classList.remove("out")), reducedMotion() ? 0 : 260);
    gate = "closed";
    root.dataset.gate = "closed";
    emit("dock:close", { from: origin });
    const back = origin === "paused" ? null : entries.buttons.get(origin);
    if (back)
      try {
        back.focus({ preventScroll: true });
      } catch {
        /* best effort */
      }
  }

  function deploy() {
    const o = origin;
    close();
    const act = o === "paused" ? "restart" : DEPLOY_ACT[o];
    const btn = G.game?.menus?.root?.querySelector<HTMLButtonElement>(`[data-s="${o}"] [data-act="${act}"]`);
    btn?.click();
  }

  function back() {
    if (tooltip.dismiss()) return;
    if (away) return hideAway();
    close();
  }

  function tickPoll() {
    if (!isOpen || document.hidden) return;
    const now = Date.now();
    // The ledger runs along the bottom even on the pass card: the dock is busy before you sign on.
    if (gate !== "in") {
      if ((due.recent ?? 0) <= now) void load("recent");
      return;
    }
    const need: ReadKey[] = ["brokers", "recent", "balances", "profile", "town"];
    if (tab === "market") need.push("listings");
    if (tab === "board") need.push("leaderboard");
    for (const k of need) if ((due[k] ?? 0) <= now) void load(k);
  }

  function focusFirst() {
    setTimeout(() => {
      if (!isOpen) return;
      const target = gate === "in" ? (away?.ok ?? tabsEl.querySelector<HTMLElement>(`[data-tab="${tab}"]`)) : focusables(gateEl)[0];
      try {
        target?.focus({ preventScroll: true });
      } catch {
        /* best effort */
      }
    }, 40);
  }

  // ---- keys: Esc backs out; Enter never reaches the title's "Enter deploys"; arrows move focus ----
  function onKey(e: KeyboardEvent) {
    if (!isOpen) return;
    const t = e.target as HTMLElement | null;
    const inRoot = !!t && root.contains(t);
    const typing = !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA");
    if (e.code === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      back();
      return;
    }
    if (!inRoot) {
      // Keys aimed at the page underneath (the title's Enter-to-deploy, the game's bindings) stop here.
      if (e.code === "Enter" || e.code === "NumpadEnter" || e.code === "Space") e.stopPropagation();
      if (e.code.startsWith("Arrow") || e.code === "Tab") {
        e.preventDefault();
        e.stopPropagation();
        focusFirst();
      }
      return;
    }
    if (e.code === "Tab") return trap(e);
    if (typing || t?.classList.contains("dk-scrub") || t?.tagName === "CANVAS") return;
    if (gate === "in" && /^Digit[1-5]$/.test(e.code)) {
      setTab(TABS[+e.code.slice(5) - 1].id);
      e.preventDefault();
      return;
    }
    const dirs: Record<string, Dir> = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right" };
    if (dirs[e.code] && moveFocus(root, dirs[e.code])) e.preventDefault();
  }
  // Clicks and keys inside never reach the game's own window listeners.
  root.addEventListener("keydown", (e) => {
    if (e.code === "Enter" || e.code === "NumpadEnter" || e.code === "Space") e.stopPropagation();
  });
  function trap(e: KeyboardEvent) {
    const all = focusables(root);
    if (!all.length) return;
    const first = all[0];
    const last = all[all.length - 1];
    if (e.shiftKey && document.activeElement === first) (last.focus(), e.preventDefault());
    else if (!e.shiftKey && document.activeElement === last) (first.focus(), e.preventDefault());
  }
  // The game's menu sounds, on our own buttons.
  root.addEventListener("click", (e) => {
    if ((e.target as Element).closest?.("button")) emit("ui:click");
  });
  root.addEventListener("mouseover", (e) => {
    const b = (e.target as Element).closest?.("button");
    if (b && e.relatedTarget && !b.contains(e.relatedTarget as Node)) emit("ui:hover");
  });

  // ---- the ways in: a dock board on the title, a DOCKSIDE button on the dead and debrief cards ----
  const entries = createEntries(() => G.game?.menus?.root, reads, (o) => void open(o));
  entries.inject();
  G.events?.on("game:state", ((e: { state?: string }) => {
    if (isOpen && e?.state && !ORIGINS.includes(e.state as Origin)) close();
    if (e?.state && ORIGINS.includes(e.state as Origin)) void quiet();
    // The die call takes a moment to land; look for the new wreck once it has.
    if (e?.state === "dead") setTimeout(() => void noteWrecks(), 5000);
  }) as never);

  // While a card is up and the Dockside is shut, keep the title's dock board fresh (slowly, and never mid-run).
  async function quiet() {
    if (isOpen) return;
    const st = G.game?.state;
    if (st && !ORIGINS.includes(st as Origin)) return;
    entries.inject();
    try {
      if (registered !== true) registered = await wallet.registered();
      deployGate.learn(registered);
    } catch {
      registered = null;
    }
    await Promise.all([load("brokers"), registered ? load("balances") : Promise.resolve(), noteLedger(), st === "dead" ? noteWrecks() : Promise.resolve()]);
    entries.update(registered);
  }
  void quiet();
  setInterval(() => void quiet(), 20000);

  return {
    root,
    get isOpen() {
      return isOpen;
    },
    get gate() {
      return gate;
    },
    open,
    close,
    deploy,
    tab: setTab,
    refresh: ctx.refresh,
    week,
    deployGate,
    chimes,
  };
}

/** Film grain for the overlay, made here (the game downloads no art). */
function makeGrain(el: HTMLElement) {
  try {
    const c = document.createElement("canvas");
    c.width = c.height = 160;
    const g = c.getContext("2d");
    if (!g) return;
    const img = g.createImageData(160, 160);
    for (let i = 0; i < img.data.length; i += 4) {
      const v = Math.random() * 255;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
      img.data[i + 3] = 26 + Math.random() * 30;
    }
    g.putImageData(img, 0, 0);
    el.style.backgroundImage = `url(${c.toDataURL()})`;
  } catch {
    /* no canvas, no grain */
  }
}
