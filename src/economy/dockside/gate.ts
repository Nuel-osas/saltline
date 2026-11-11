// The first deploy needs a dock pass. Without one the contract refuses start_run ("No dock pass") and the run plays as
// the baseline with no salvage, which a new player would never notice. So the game's DEPLOY, RESTART, RETRY and
// REDEPLOY buttons (and Enter on the title) are caught in the capture phase until this wallet is known to hold a pass:
//
// - a known "yes" goes straight through, untouched;
// - otherwise the press is held and the pass is checked. "Yes" carries on into the run; "no" opens the Dockside's pass
//   card, and a claim there carries on into the run the player asked for;
// - no answer in time counts as "ask", never "skip": the card comes up (a claim is safe to repeat: the faucet refuses
//   an account that already has a pass), and a late "yes" still carries on;
// - a check that fails outright deploys as before. The dock can't be reached, so a pass couldn't be claimed either,
//   and the shooter never waits on the economy.
//
// Carrying on presses the card's own button again, past the gate, so a run starts exactly as the game starts it.
export type DeployAct = "deploy" | "restart" | "retry" | "redeploy";
export const DEPLOY_ACTS: readonly DeployAct[] = ["deploy", "restart", "retry", "redeploy"];

export interface DeployRequest {
  readonly act: DeployAct;
  /** The game state when it was pressed: title, paused, dead or complete. */
  readonly from: string;
  /** checking: no answer yet. no: the dock office says there's no pass. unknown: no answer in time, so ask. */
  status: "checking" | "no" | "unknown";
}

/** What the gate shows while it holds a press: the Dockside, opened on its pass card. */
export interface GateUi {
  show(req: DeployRequest): void;
  hide(): void;
}

export interface DeployGateOptions {
  menus(): HTMLElement | null | undefined;
  state(): string | undefined;
  /** The wallet's account, so a cached answer never outlives the wallet it was about. */
  account(): string | null;
  registered(): Promise<boolean>;
  ui: GateUi;
  /** Marks the next run as played without a pass (salvage stays off and says so). */
  passless(): void;
  /** False while the press should be left to someone else (the Dockside is up and handles its own keys). */
  free?(): boolean;
  /** The game's settings panel is open (Enter belongs to it). */
  panelOpen?(): boolean;
  /** Ms of silence before the gate shows that it's checking (default 250). */
  quietMs?: number;
  /** Ms before a missing answer counts as unknown and the card asks anyway (default 6000). */
  askMs?: number;
  /** Where the listeners go (default window). */
  target?: Window;
}

export interface DeployGate {
  /** True once this wallet is known to hold a pass; null or false checks again on the next press. */
  readonly known: boolean | null;
  /** The press being held, if any. */
  readonly pending: DeployRequest | null;
  /** Someone else learned the answer (the Dockside's own pass card or its checks). */
  learn(registered: boolean | null): void;
  /** Carry on with a held press: the card's own button, past the gate. `passless` plays it without salvage. */
  proceed(req: DeployRequest, opts?: { passless?: boolean }): void;
  /** Drop a held press (the player backed out). */
  cancel(req: DeployRequest): void;
  dispose(): void;
}

const isAct = (s: string | undefined): s is DeployAct => !!s && (DEPLOY_ACTS as readonly string[]).includes(s);

export function createDeployGate(opts: DeployGateOptions): DeployGate {
  const win = opts.target ?? window;
  const quietMs = opts.quietMs ?? 250;
  const askMs = opts.askMs ?? 6000;
  let known: boolean | null = null;
  let knownFor: string | null = null;
  let pending: (DeployRequest & { button: HTMLButtonElement | null }) | null = null;
  let bypass = false;

  const cached = () => (knownFor !== null && knownFor === opts.account() ? known : null);
  function learn(reg: boolean | null) {
    known = reg;
    knownFor = reg === null ? null : opts.account();
  }
  const timers: ReturnType<typeof setTimeout>[] = [];
  const clearTimers = () => timers.splice(0).forEach(clearTimeout);

  function check(): Promise<boolean | null> {
    let p: Promise<boolean>;
    try {
      p = Promise.resolve(opts.registered());
    } catch (e) {
      p = Promise.reject(e);
    }
    // Anything but a boolean is a non-answer: unknown, which asks.
    return p.then((r) => (r === true || r === false ? r : null));
  }

  function hold(act: DeployAct, button: HTMLButtonElement | null, from: string) {
    if (pending) return; // one press at a time; a second click while checking is the same request
    const req = { act, from, status: "checking" as DeployRequest["status"], button };
    pending = req;
    let answered = false;
    timers.push(
      setTimeout(() => !answered && pending === req && opts.ui.show(req), quietMs),
      setTimeout(() => {
        if (answered || pending !== req) return;
        req.status = "unknown";
        opts.ui.show(req);
      }, askMs),
    );
    check().then(
      (reg) => {
        answered = true;
        clearTimers();
        if (reg !== null) learn(reg);
        if (pending !== req) return; // settled already: the player claimed, played without, or backed out
        if (reg === true) {
          opts.ui.hide();
          go(req, false);
          return;
        }
        req.status = reg === false ? "no" : "unknown";
        opts.ui.show(req);
      },
      (e) => {
        answered = true;
        clearTimers();
        if (pending !== req) return;
        // Already asking (the answer came too late): leave the card up, the player has a way on from there.
        if (req.status === "unknown") return;
        console.info("[dockside] couldn't check the dock pass; deploying as before", e);
        opts.ui.hide();
        go(req, false);
      },
    );
  }

  function go(req: DeployRequest & { button: HTMLButtonElement | null }, passless: boolean) {
    if (pending !== req) return;
    pending = null;
    clearTimers();
    // The game moved on while the press was held (it can't from a card, but never start a run from the wrong place).
    if ((opts.state() ?? req.from) !== req.from) return;
    const btn = req.button?.isConnected
      ? req.button
      : (opts.menus()?.querySelector<HTMLButtonElement>(`[data-s="${req.from}"] [data-act="${req.act}"]`) ?? null);
    if (!btn) return;
    if (passless) opts.passless();
    bypass = true;
    try {
      btn.click();
    } finally {
      bypass = false;
    }
  }

  function onClick(e: MouseEvent) {
    if (bypass) return;
    const menus = opts.menus();
    const btn = (e.target as Element | null)?.closest?.<HTMLButtonElement>("button[data-act]");
    if (!menus || !btn || !menus.contains(btn) || !isAct(btn.dataset.act)) return;
    if (cached() === true || (opts.free && !opts.free())) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    hold(btn.dataset.act, btn, opts.state() ?? "title");
  }

  // The title's own "Enter deploys" listens on the window; this one runs first.
  function onKey(e: KeyboardEvent) {
    if (e.code !== "Enter" && e.code !== "NumpadEnter") return;
    if (bypass || cached() === true || (opts.free && !opts.free())) return;
    if (opts.state() !== "title" || opts.panelOpen?.()) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === "BUTTON" || t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    const btn = opts.menus()?.querySelector<HTMLButtonElement>('[data-s="title"] [data-act="deploy"]') ?? null;
    if (!btn) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    hold("deploy", btn, "title");
  }

  win.addEventListener("click", onClick, true);
  win.addEventListener("keydown", onKey, true);
  // Ask once up front, so a returning player's first press goes straight through.
  check().then(
    (r) => r !== null && learn(r),
    () => {},
  );

  return {
    get known() {
      return cached();
    },
    get pending() {
      return pending;
    },
    learn,
    proceed(req, o = {}) {
      if (pending === req) go(pending, !!o.passless);
    },
    cancel(req) {
      if (pending !== req) return;
      pending = null;
      clearTimers();
    },
    dispose() {
      clearTimers();
      pending = null;
      win.removeEventListener("click", onClick, true);
      win.removeEventListener("keydown", onKey, true);
    },
  };
}
