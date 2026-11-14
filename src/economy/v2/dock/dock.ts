// The dock: Saltline v2's hub. It opens from the title, dead and debrief cards (never mid-raid), sits over the live
// scene like the game's own cards and never captures the pointer. Esc closes back to the card it came from; DEPLOY
// starts a raid by pressing that card's own button, so a raid starts exactly as the game starts it. A first-time
// player pressing the game's DEPLOY gets the dock pass card first (the v1 gate, unchanged), then the raid.
//
// createDock(G, v2) builds it. It reads the chain through v2.chain, polls while open, and every action shows that it
// is settling, then its result.
import "./dock.css";
import { h, reducedMotion, text } from "../../dockside/dom";
import { ago, fmt, UNKNOWN } from "../../dockside/format";
import { createDeployGate, type DeployAct, type DeployGate, type DeployGateOptions, type DeployRequest } from "../../dockside/gate";
import { focusables, moveFocus, type Dir } from "../../dockside/pad";
import type { TokenId, TxResult, V2 } from "../types";
import { createArmoury } from "./armoury";
import { createLedger } from "./ledger";
import { createLoadout } from "./loadout";
import { createMarket } from "./market";
import { createPass } from "./pass";
import { emptyReads, MAY_SETTLE, okv, READ_KEYS, type ActSpec, type Ctx, type NoteState, type ReadKey } from "./store";
import { createVendors } from "./vendors";

export interface GameLike {
  events?: { on(name: string, fn: (e: never) => void): unknown; emit(name: string, e?: unknown): void };
  game?: { state?: string; menus?: { root?: HTMLElement; panelOpen?: boolean } };
}

export type Origin = "title" | "dead" | "complete";
export type Tab = "loadout" | "armoury" | "market" | "vendors" | "ledger";
export const TABS: { id: Tab; label: string }[] = [
  { id: "loadout", label: "Loadout" },
  { id: "armoury", label: "Armoury" },
  { id: "market", label: "Market" },
  { id: "vendors", label: "Vendors" },
  { id: "ledger", label: "Ledger" },
];
const ORIGINS: Origin[] = ["title", "dead", "complete"];
const DEPLOY_FROM: string[] = [...ORIGINS, "paused"];
/** The card button DEPLOY presses. */
const DEPLOY_ACT: Record<Origin, string> = { title: "deploy", dead: "retry", complete: "redeploy" };
const CLAIM_LABEL: Record<DeployAct, string> = { deploy: "Claim pass and deploy", redeploy: "Claim pass and redeploy", retry: "Claim pass and retry", restart: "Claim pass and restart" };
const DEPLOY_LEDE = "Sign on before you go over the fence. Your pass carries your guns, your wrecks and what you owe.";

/** Ms between reads of each view while the dock is open. */
const POLL: Record<ReadKey, number> = { profile: 9000, balances: 7000, weapons: 9000, vendors: 7000, exportPrices: 7000, listings: 7000, impound: 12000, harbormaster: 7000, recent: 4500, economy: 12000 };
/** What each tab is drawn from (the header and the ticker's reads are always kept fresh). */
const NEEDS: Record<Tab, ReadKey[]> = {
  loadout: ["weapons"],
  armoury: ["weapons"],
  market: ["listings", "weapons", "economy"],
  // The listings and guns name the next step after a sale (a gun that can now be bought).
  vendors: ["vendors", "exportPrices", "listings"],
  ledger: ["impound", "economy"],
};
const ALWAYS: ReadKey[] = ["profile", "balances", "harbormaster", "recent"];

export interface DockOptions {
  /** Where the overlay mounts (default #ui, else body). */
  host?: HTMLElement;
  gate?: Pick<DeployGateOptions, "quietMs" | "askMs">;
  /** Ms per step of the build reveal (default 420; 0 under reduced motion). */
  revealMs?: number;
}

export interface Dock {
  readonly root: HTMLElement;
  readonly isOpen: boolean;
  readonly gate: "closed" | "checking" | "pass" | "unknown" | "in";
  readonly tab: Tab;
  readonly ctx: Ctx;
  readonly deployGate: DeployGate;
  open(from?: Origin): Promise<void>;
  close(): void;
  deploy(): void;
  setTab(t: Tab): void;
  refresh(...keys: ReadKey[]): Promise<void>;
  dispose(): void;
}

export function createDock(G: GameLike, v2: V2, opts: DockOptions = {}): Dock {
  const { chain, wallet } = v2;
  v2.loadout ??= { weapon: null, plates: 0, charges: 0, mags: 0 };
  const reads = emptyReads();
  let isOpen = false;
  let gate: Dock["gate"] = "closed";
  let origin: Origin | "paused" = "title";
  let tab: Tab = "loadout";
  let registered: boolean | null = null;
  let deployReq: DeployRequest | null = null;
  let busyKey: string | null = null;
  let noteTimer: ReturnType<typeof setTimeout> | null = null;

  const emit = (n: string, e: unknown = {}) => {
    try {
      G.events?.emit(n, e);
    } catch {
      /* the game's bus never stops the dock */
    }
  };

  // ---- reads ----
  const inflight: Partial<Record<ReadKey, Promise<void>>> = {};
  const due: Partial<Record<ReadKey, number>> = {};
  const account = () => {
    const me = wallet.accountId();
    return me ? Promise.resolve(me) : Promise.reject(new Error("no account"));
  };
  const fetchers: Record<ReadKey, () => Promise<unknown>> = {
    profile: () => account().then((me) => chain.profile(me)),
    balances: () => account().then((me) => chain.balances(me)),
    weapons: () => account().then((me) => chain.weapons(me)),
    impound: () => account().then((me) => chain.impound(me)),
    vendors: () => chain.vendors(),
    exportPrices: () => chain.exportPrices(),
    listings: () => chain.listings(),
    harbormaster: () => chain.harbormaster(),
    recent: () => chain.recent(24),
    economy: () => chain.economy(),
  };
  function load(key: ReadKey, fresh = false): Promise<void> {
    const cur = inflight[key];
    if (cur) return fresh ? cur.then(() => load(key)) : cur;
    let p: Promise<unknown>;
    try {
      p = fetchers[key]();
    } catch (e) {
      p = Promise.reject(e);
    }
    const run = p
      .then(
        (v) => void ((reads as Record<ReadKey, unknown>)[key] = { s: "ok", v }),
        // A failed read is unknown. It is never drawn as zero, and what was read before is not kept as if current.
        (e) => void ((reads as Record<ReadKey, unknown>)[key] = { s: "unknown", error: String(e) }),
      )
      .finally(() => {
        delete inflight[key];
        due[key] = Date.now() + POLL[key];
        paint();
      });
    inflight[key] = run;
    return run;
  }
  const refresh = (...keys: ReadKey[]) => Promise.all((keys.length ? keys : READ_KEYS).map((k) => load(k, true))).then(() => {});

  // ---- actions: settling, then a result ----
  function note(state: NoteState, msg: string) {
    statusEl.dataset.state = state;
    text(statusT, msg);
    statusEl.classList.remove("pop");
    void statusEl.offsetWidth;
    statusEl.classList.add("pop");
    if (noteTimer) clearTimeout(noteTimer);
    noteTimer = null;
    if (state === "ok") noteTimer = setTimeout(() => statusEl.dataset.state === "ok" && ((statusEl.dataset.state = "idle"), text(statusT, "")), 9000);
  }
  async function act<T extends TxResult>(spec: ActSpec<T>): Promise<T | null> {
    if (busyKey) return null;
    busyKey = spec.key;
    note("settling", spec.settling);
    paint();
    let r: T | null = null;
    let threw = false;
    try {
      r = await spec.run();
    } catch {
      threw = true;
    }
    busyKey = null;
    const keys: ReadKey[] = [...new Set<ReadKey>(["balances", "weapons", "profile", ...(spec.refresh ?? [])])];
    if (threw || !r || r.pending) {
      // No answer: it may have landed. Never "failed", and the stash is read again so the player can see.
      note("pending", MAY_SETTLE);
      void refresh(...keys);
      paint();
      return null;
    }
    if (!r.ok) {
      note("error", r.error ? `${r.error}.`.replace(/\.\.$/, ".") : "The dock refused that.");
      paint();
      return null;
    }
    note("ok", spec.done(r));
    emit("stash:changed", {});
    emit("ui:click");
    await refresh(...keys, "recent");
    paint();
    return r;
  }

  const ctx: Ctx = {
    v2,
    chain,
    wallet,
    reads,
    me: () => wallet.accountId(),
    callsign: () => okv(reads.profile)?.callsign ?? null,
    holding(id: TokenId) {
      const b = okv(reads.balances);
      return b ? (b[id] ?? 0) : null;
    },
    busy: (key?: string) => (key == null ? busyKey !== null : busyKey === key),
    refresh,
    act,
    note,
    render: () => paint(),
    go: (t) => setTab(t),
    emit,
    revealMs: opts.revealMs ?? (reducedMotion() ? 0 : 420),
  };

  // ---- the frame ----
  const root = h("div", { class: "d2", role: "dialog", "aria-modal": "true", "aria-label": "The dock", hidden: true, "data-gate": "closed", "data-tab": tab });
  const tabsEl = h(
    "nav",
    { class: "d2-tabs", role: "tablist", "aria-label": "The dock" },
    ...TABS.map((t, i) =>
      h("button", { class: "d2-tab", role: "tab", type: "button", "data-tab": t.id, "aria-selected": String(t.id === tab), onclick: () => setTab(t.id) }, h("kbd", null, String(i + 1)), h("span", null, t.label), t.id === "ledger" ? h("b", { class: "d2-tab-flag", hidden: true }) : null),
    ),
  );
  const meT = h("div", { class: "d2-me" });
  const closeBtn = h("button", { class: "btn small d2-close", type: "button", onclick: () => close() }, "Close", h("kbd", null, "Esc"));
  const deployBtn = h("button", { class: "btn primary d2-deploy", type: "button", onclick: () => deploy() }, "Deploy");
  const top = h(
    "header",
    { class: "d2-top" },
    h("div", { class: "d2-brand" }, h("span", { class: "m-tag" }, "B4"), h("h2", { class: "d2-word" }, "The Dock"), h("span", { class: "d2-brand-sub" }, "Berth 4 · Breachers’ side")),
    tabsEl,
    h("div", { class: "d2-top-r" }, meT, closeBtn, deployBtn),
  );

  const screens = {
    loadout: createLoadout(ctx, () => deploy()),
    armoury: createArmoury(ctx),
    market: createMarket(ctx),
    vendors: createVendors(ctx),
    ledger: createLedger(ctx),
  };
  const panes = Object.fromEntries(TABS.map((t) => [t.id, h("div", { class: "d2-pane", "data-pane": t.id, role: "tabpanel", hidden: t.id !== tab }, screens[t.id].el)])) as unknown as Record<Tab, HTMLElement>;
  const main = h("main", { class: "d2-main" }, ...Object.values(panes));
  const gateEl = h("div", { class: "d2-gate" });
  const statusT = h("span", { class: "d2-status-t" });
  const statusEl = h("p", { class: "d2-status", role: "status", "aria-live": "polite", "data-state": "idle" }, h("i", { "aria-hidden": "true" }), statusT);
  const tickTrack = h("div", { class: "d2-tk-track" });
  const ticker = h("div", { class: "d2-tk", role: "log", "aria-label": "The open ledger", "aria-live": "off" }, h("span", { class: "d2-tk-k" }, h("i", { "aria-hidden": "true" }), "Open ledger"), h("div", { class: "d2-tk-view" }, tickTrack));
  const bot = h("footer", { class: "d2-bot" }, ticker, statusEl);
  root.append(h("div", { class: "d2-veil", "aria-hidden": "true" }), top, main, bot, gateEl);
  (opts.host ?? document.getElementById("ui") ?? document.body).append(root);

  // ---- painting ----
  let tickSig = "";
  function paintTicker() {
    const r = reads.recent;
    const events = okv(r);
    const sig = JSON.stringify([r.s, events?.map((e) => [e.at, e.text])]);
    if (sig === tickSig) return;
    tickSig = sig;
    ticker.classList.toggle("unk", r.s === "unknown");
    if (!events) {
      tickTrack.replaceChildren(h("span", { class: "d2-tk-i unk", "data-unknown": r.s === "unknown" ? "1" : null }, r.s === "unknown" ? `The ledger's latest lines: ${UNKNOWN}` : "Reading the ledger…"));
      tickTrack.style.animation = "none";
      return;
    }
    const me = wallet.accountId();
    const items = (dup: boolean) =>
      events.map((e) => h("span", { class: `d2-tk-i${e.account === me ? " mine" : ""}`, "data-kind": e.kind, "aria-hidden": dup ? "true" : null }, h("i", { class: "d2-tk-dot", "data-kind": e.kind }), h("span", { class: "d2-tk-t" }, e.text), h("time", null, ago(e.at))));
    if (!events.length) {
      tickTrack.replaceChildren(h("span", { class: "d2-tk-i" }, "Nothing on the ledger yet."));
      tickTrack.style.animation = "none";
      return;
    }
    // The crawl is two copies end to end, moved by one copy's width: a loop with no jump.
    tickTrack.replaceChildren(...items(false), ...items(true));
    tickTrack.style.animation = "";
    tickTrack.style.animationDuration = `${Math.max(30, events.length * 6)}s`;
  }
  function paintMe() {
    const p = okv(reads.profile);
    const scrip = ctx.holding("scrip");
    const arrears = p ? p.arrears : null;
    meT.replaceChildren(
      h("span", { class: "d2-me-cs" }, p?.callsign ?? ""),
      h("span", { class: "d2-me-n", "data-me": "scrip", "data-unknown": scrip == null && reads.balances.s === "unknown" ? "1" : null }, h("b", null, scrip == null ? (reads.balances.s === "loading" ? "…" : UNKNOWN) : fmt(scrip)), h("i", null, "scrip")),
      h("span", { class: `d2-me-n owe${arrears ? " has" : ""}`, "data-me": "arrears", "data-unknown": arrears == null && reads.profile.s === "unknown" ? "1" : null }, h("b", null, arrears == null ? (reads.profile.s === "loading" ? "…" : UNKNOWN) : fmt(arrears)), h("i", null, "owed")),
    );
    const flag = tabsEl.querySelector<HTMLElement>(".d2-tab-flag")!;
    const imp = okv(reads.impound);
    flag.hidden = !imp?.length;
    if (imp?.length) text(flag, String(imp.length));
    for (const [o, b] of entryButtons) {
      const n = b.querySelector(".d2-entry-n");
      // The title's row is tight, so its button is the one word; the cards have room for what's in the purse.
      if (n) text(n, o !== "title" && registered && scrip != null ? `${fmt(scrip)} scrip` : "");
    }
  }
  function paint() {
    paintMe();
    paintTicker();
    if (gate === "in" && isOpen) screens[tab].update();
  }

  // ---- tabs ----
  function setTab(t: Tab) {
    if (t !== tab) emit("ui:click");
    tab = t;
    root.dataset.tab = t;
    for (const b of tabsEl.querySelectorAll<HTMLElement>(".d2-tab")) b.setAttribute("aria-selected", String(b.dataset.tab === t));
    for (const [id, el] of Object.entries(panes)) el.hidden = id !== t;
    if (gate === "in" && isOpen) {
      emit("dock:open", { tab: t });
      for (const k of NEEDS[t]) void load(k);
      screens[t].update();
    }
  }

  // ---- the gate: checking, the pass card, no answer ----
  function setGate(g: Dock["gate"]) {
    gate = g;
    root.dataset.gate = g;
    if (g === "checking") gateEl.replaceChildren(h("p", { class: "d2-checking", role: "status" }, h("i"), "Checking your dock pass…"));
    main.inert = g !== "in";
    tabsEl.inert = g !== "in";
  }
  function signedOn() {
    registered = true;
    deployGate.learn(true);
  }
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
        { class: "d2-gate-card", role: "alertdialog", "aria-labelledby": "d2-gu-h" },
        h("div", { class: "m-k" }, "Dock Office"),
        h("h2", { class: "d2-pass-h", id: "d2-gu-h" }, "No answer"),
        h("p", { class: "d2-pass-lede", "data-unknown": "1" }, `Your pass status is ${UNKNOWN}: the dock office can't be reached right now. Nothing has been charged.`),
        h("div", { class: "m-actions col" }, h("button", { class: "btn primary", type: "button", onclick: () => void checkGate() }, "Try again"), h("button", { class: "btn", type: "button", onclick: () => close() }, "Back")),
      ),
    );
    setGate("unknown");
    focusFirst();
  }
  function enter() {
    setGate("in");
    gateEl.replaceChildren();
    emit("dock:open", { tab });
    for (const k of new Set([...ALWAYS, ...NEEDS[tab], "impound" as ReadKey])) void load(k, true);
    paint();
    focusFirst();
  }

  // ---- the game's DEPLOY, held until there's a pass (dockside/gate.ts) ----
  const deployGate = createDeployGate({
    menus: () => G.game?.menus?.root,
    state: () => G.game?.state,
    account: () => wallet.accountId(),
    registered: () => wallet.registered(),
    panelOpen: () => !!G.game?.menus?.panelOpen,
    free: () => !isOpen,
    // A raid without a pass is the game's to run: the contract refuses start_raid, and nothing carried out is kept.
    passless: () => {},
    quietMs: opts.gate?.quietMs,
    askMs: opts.gate?.askMs,
    ui: {
      show(req) {
        if (!isOpen) {
          if (!DEPLOY_FROM.includes(req.from)) return;
          deployReq = req;
          show(req.from as Origin | "paused");
        } else if (deployReq !== req) return;
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
  function passFor(req: DeployRequest) {
    const carryOn = (passless: boolean) => {
      if (deployReq !== req) return;
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
      skip: unsure
        ? { label: "Deploy anyway", note: "your gear counts if your pass is on file", onSkip: () => carryOn(false) }
        : { label: "Play without a pass", note: "nothing you carry out is kept", onSkip: () => carryOn(true) },
    });
    gateEl.replaceChildren(pass.el);
    setGate("pass");
    setTimeout(() => pass.focus(), 60);
  }

  // ---- open, close, deploy ----
  let poll: ReturnType<typeof setInterval> | null = null;
  const playable = () => !G.game?.state || ORIGINS.includes(G.game.state as Origin);

  async function open(from?: Origin) {
    if (isOpen) return;
    const state = G.game?.state ?? "title";
    const o = from ?? (ORIGINS.includes(state as Origin) ? (state as Origin) : null);
    if (!o || !playable()) return; // never mid-raid
    screens.vendors.fresh();
    show(o);
    await checkGate();
  }
  function show(o: Origin | "paused") {
    origin = o;
    isOpen = true;
    root.hidden = false;
    root.classList.remove("out");
    document.getElementById("app")?.classList.add("d2-on");
    void root.offsetWidth;
    root.classList.add("on");
    root.dataset.from = o;
    window.addEventListener("keydown", onKey, true);
    poll = setInterval(tickPoll, 1000);
  }
  function close() {
    if (!isOpen) return;
    isOpen = false;
    if (deployReq) deployGate.cancel(deployReq); // backing out of the pass card drops the held press
    deployReq = null;
    if (poll) clearInterval(poll);
    poll = null;
    window.removeEventListener("keydown", onKey, true);
    root.classList.remove("on");
    root.classList.add("out");
    document.getElementById("app")?.classList.remove("d2-on");
    setTimeout(() => !isOpen && ((root.hidden = true), root.classList.remove("out")), reducedMotion() ? 0 : 260);
    gate = "closed";
    root.dataset.gate = "closed";
    emit("dock:closed", {});
    const back = origin === "paused" ? null : entryButtons.get(origin);
    if (back)
      try {
        back.focus({ preventScroll: true });
      } catch {
        /* best effort */
      }
  }
  function deploy() {
    if (!isOpen || gate !== "in") return;
    const o = origin;
    close();
    const act = o === "paused" ? "restart" : DEPLOY_ACT[o];
    G.game?.menus?.root?.querySelector<HTMLButtonElement>(`[data-s="${o}"] [data-act="${act}"]`)?.click();
  }
  function tickPoll() {
    if (!isOpen || (typeof document !== "undefined" && document.hidden)) return;
    const now = Date.now();
    const need: ReadKey[] = gate === "in" ? [...ALWAYS, ...NEEDS[tab]] : ["recent"];
    for (const k of need) if ((due[k] ?? 0) <= now) void load(k);
    if (gate === "in") screens[tab].update(); // countdowns move on their own
  }
  function focusFirst() {
    setTimeout(() => {
      if (!isOpen) return;
      const target = gate === "in" ? tabsEl.querySelector<HTMLElement>(`[data-tab="${tab}"]`) : focusables(gateEl)[0];
      try {
        target?.focus({ preventScroll: true });
      } catch {
        /* best effort */
      }
    }, 40);
  }

  // ---- keys: Esc backs out; 1–5 change tab; arrows move focus; Enter never reaches the title's "Enter deploys" ----
  function back() {
    const confirm = root.querySelector<HTMLButtonElement>("[data-cancel]");
    if (confirm) return confirm.click(); // an open "are you sure" is what Esc answers first
    close();
  }
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
        return;
      }
    }
    if (e.code === "Tab" && inRoot) return trap(e);
    if (typing) return;
    const digit = /^(?:Digit|Numpad)([1-5])$/.exec(e.code);
    if (gate === "in" && digit && !e.metaKey && !e.ctrlKey && !e.altKey) {
      setTab(TABS[+digit[1] - 1].id);
      tabsEl.querySelector<HTMLElement>(`[data-tab="${tab}"]`)?.focus({ preventScroll: true });
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    const dirs: Record<string, Dir> = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right" };
    if (inRoot && dirs[e.code] && moveFocus(root, dirs[e.code])) e.preventDefault();
  }
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
  root.addEventListener("mouseover", (e) => {
    const b = (e.target as Element).closest?.("button");
    if (b && e.relatedTarget && !b.contains(e.relatedTarget as Node)) emit("ui:hover");
  });

  // ---- the ways in: a DOCK button on the title, dead and debrief cards ----
  const entryButtons = new Map<Origin, HTMLButtonElement>();
  function inject() {
    const menus = G.game?.menus?.root;
    if (!menus) return;
    for (const o of ORIGINS) {
      if (entryButtons.get(o)?.isConnected) continue;
      const host = menus.querySelector<HTMLElement>(`[data-s="${o}"] .m-actions`);
      if (!host) continue;
      const b = h("button", { class: "btn d2-entry", type: "button", "data-d2": o, onclick: () => void open(o) }, h("span", null, "Dock"), h("b", { class: "d2-entry-n" }));
      // On the title it sits right after DEPLOY; on the cards it goes under their own button.
      const deployB = o === "title" ? host.querySelector('[data-act="deploy"]') : null;
      if (deployB) deployB.after(b);
      else host.append(b);
      entryButtons.set(o, b);
    }
  }
  inject();
  const offState = G.events?.on("game:state", ((e: { state?: string }) => {
    if (isOpen && e?.state && !DEPLOY_FROM.includes(e.state)) close();
    if (e?.state && ORIGINS.includes(e.state as Origin)) {
      inject();
      void quiet();
    }
  }) as never);

  /** While a card is up and the dock is shut: learn whether there's a pass, and keep the button's scrip current. */
  async function quiet() {
    if (isOpen || !playable()) return;
    inject();
    try {
      if (registered !== true) registered = await wallet.registered();
      deployGate.learn(registered);
    } catch {
      registered = null;
    }
    if (registered) await load("balances");
    paintMe();
  }
  void quiet();
  const quietTimer = setInterval(() => void quiet(), 30000);

  return {
    root,
    ctx,
    deployGate,
    get isOpen() {
      return isOpen;
    },
    get gate() {
      return gate;
    },
    get tab() {
      return tab;
    },
    open,
    close,
    deploy,
    setTab,
    refresh,
    dispose() {
      close();
      clearInterval(quietTimer);
      if (noteTimer) clearTimeout(noteTimer);
      deployGate.dispose();
      if (typeof offState === "function") (offState as () => void)();
      for (const b of entryButtons.values()) b.remove();
      root.remove();
    },
  };
}
