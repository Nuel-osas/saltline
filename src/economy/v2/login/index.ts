// v2's sign-in gate (G.login). On a build where sign-in is switched on (VITE_PRIVY_APP_ID, testnet), nobody deploys
// or opens the dock before signing in: the title shows a sign-on panel where Deploy was. Signing in fetches the
// player's wallet from the dock office (session.ts) and puts it where the guest key was, so the same sign-in is the
// same account on any device.
//
// The lock here is the title's: it hides Deploy and the dock and refuses a start. What actually enforces "one sign-in,
// one dock pass" is the faucet (server/faucet.ts), which gives a pass only to the signed-in player's own account.
import { WALLET_STORAGE_KEY } from "../../wallet";
import { type Auth, type Who, createPrivyAuth, isEmail } from "./auth";
import { fetchWallet } from "./session";
import "./login.css";

/* eslint-disable @typescript-eslint/no-explicit-any -- the game context is the untyped bundle's G */
type Game = any;

export type LoginState = "checking" | "out" | "code" | "working" | "in" | "error";

export interface LoginWallet {
  accountId(): string | null;
  importKey(key: string): string;
}

export interface LoginOptions {
  appId: string;
  sessionUrl: string;
  wallet: LoginWallet;
  /**
   * Where the sign-on form lives. Absent, it stands on the title where Deploy was. True (the lobby, home/), it is a
   * sheet over the game that `open()` shows: the lobby's own Sign in buttons call that.
   */
  sheet?: boolean;
  /** For tests: stands in for Privy. */
  auth?: Auth;
  fetch?: typeof fetch;
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  reload?: () => void;
}

export interface Login {
  state(): LoginState;
  who(): Who | null;
  /** The sign-in token for the faucet, or null when signed out. */
  token(): Promise<string | null>;
  /** Shows the sign-on form (sheet mode), or puts the cursor in it. */
  open(): void;
  close(): void;
  signOut(): Promise<void>;
  stop(): void;
}

/** Which sign-in this browser's wallet belongs to, so a returning player isn't asked the dock office again. */
export const LOGIN_STORAGE_KEY = "saltline.login.v1";

type Child = Node | string | null | false | undefined;
function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string | null> | null, ...kids: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) if (v != null) el.setAttribute(k, v);
  for (const kid of kids) if (kid) el.append(kid);
  return el;
}

const fill = (el: Element, ...kids: Child[]) => el.replaceChildren(...kids.filter((k): k is Node | string => !!k));

export function startLogin(G: Game, opts: LoginOptions): Login {
  const app = document.getElementById("app");
  const storage = opts.storage ?? localStorage;
  const reload = opts.reload ?? (() => location.reload());
  let state: LoginState = "checking";
  let who: Who | null = null;
  let auth: Auth | null = opts.auth ?? null;
  let email = "";
  let note = "";
  let stopped = false;

  const panel = h("section", { class: "lg", "aria-label": "Sign on", "data-state": state });
  // Sheet mode: the form sits in a dialog over the game, closed until someone asks to sign in.
  const shut = h("button", { class: "lg-shut", type: "button", "aria-label": "Close" }, "×");
  const sheet = opts.sheet ? h("div", { class: "lg-sheet", role: "dialog", "aria-modal": "true", "aria-label": "Sign on", hidden: "" }, h("div", { class: "lg-box" }, shut, panel)) : null;
  const open = () => {
    if (sheet) sheet.hidden = false;
    panel.querySelector<HTMLElement>("input, button")?.focus();
  };
  const close = () => {
    if (sheet) sheet.hidden = true;
  };
  shut.onclick = close;
  if (sheet) {
    sheet.addEventListener("click", (e) => e.target === sheet && close());
    sheet.addEventListener("keydown", (e) => e.key === "Escape" && close());
    (app ?? document.body).append(sheet);
  }
  const locked = () => state !== "in";

  // ---- the lock: the title's, and a start that slips past it ----
  const ext = (G.ext ??= {});
  const innerBeforeRun = ext.beforeRun;
  ext.beforeRun = (go: () => void) => {
    if (locked()) return focusPanel(), true; // held: the run doesn't start
    return typeof innerBeforeRun === "function" ? innerBeforeRun(go) : false;
  };
  const refuse = (e: Event) => {
    if (!locked()) return;
    const t = e.target as Element | null;
    if (!t?.closest?.('[data-act="deploy"], .d2-entry, .st-replay')) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    focusPanel();
  };
  document.addEventListener("click", refuse, true);
  // Typing an email must not drive the game's menu.
  for (const type of ["keydown", "keyup", "keypress"] as const) panel.addEventListener(type, (e) => e.stopPropagation());

  const focusPanel = open;

  function mount() {
    if (sheet) return true;
    const actions = document.querySelector('.m-screen[data-s="title"] .m-actions');
    if (!actions) return false;
    actions.before(panel);
    return true;
  }
  // The title is usually there already; if not, look again for a few seconds. Never mount twice.
  let tries = 0;
  let mounting = 0;
  if (!mount()) mounting = window.setInterval(() => (mount() || ++tries > 40) && clearInterval(mounting), 150);

  // ---- drawing ----
  function set(next: LoginState, message = "") {
    state = next;
    note = message;
    app?.classList.toggle("lg-locked", locked());
    panel.dataset.state = state;
    draw();
    if (state === "in") close();
    G.events?.emit?.("login:state", { state, who });
  }

  const noteEl = () => (note ? h("p", { class: "lg-note", role: "status" }, note) : null);

  function draw() {
    if (state === "in") {
      const out = h("button", { class: "lg-link", type: "button" }, "Sign out");
      out.onclick = () => void signOut();
      return panel.replaceChildren(h("p", { class: "lg-in" }, h("i", null), "Signed on as ", h("b", null, who?.label ?? "your account"), out));
    }
    if (state === "checking" || state === "working") {
      return panel.replaceChildren(h("p", { class: "lg-k" }, "Sign on"), h("p", { class: "lg-wait" }, state === "checking" ? "Checking your pass…" : "The dock office is working…"));
    }
    if (state === "error") {
      const again = h("button", { class: "btn primary", type: "button" }, "Try again");
      again.onclick = () => void begin();
      const out = h("button", { class: "lg-link", type: "button" }, "Sign out");
      out.onclick = () => void signOut();
      return panel.replaceChildren(h("p", { class: "lg-k" }, "Sign on"), h("p", { class: "lg-note", role: "alert" }, note || "Something went wrong."), h("div", { class: "lg-row" }, again, out));
    }
    if (state === "code") {
      const code = h("input", { class: "lg-input lg-code", type: "text", inputmode: "numeric", autocomplete: "one-time-code", maxlength: "6", placeholder: "000000", "aria-label": "The six-digit code" });
      const go = h("button", { class: "btn primary", type: "submit" }, "Sign on");
      const form = h("form", { class: "lg-row", novalidate: "" }, code, go);
      form.onsubmit = (e) => (e.preventDefault(), void signIn(code.value));
      const other = h("button", { class: "lg-link", type: "button" }, "Use another email");
      other.onclick = () => set("out");
      fill(panel, h("p", { class: "lg-k" }, "Sign on"), h("p", { class: "lg-line" }, "We sent a six-digit code to ", h("b", null, email), "."), form, noteEl(), other);
      return code.focus();
    }
    // "out": the email form
    const input = h("input", { class: "lg-input", type: "email", autocomplete: "email", placeholder: "you@example.com", "aria-label": "Your email", value: email });
    const send = h("button", { class: "btn primary", type: "submit" }, "Send code");
    const form = h("form", { class: "lg-row", novalidate: "" }, input, send);
    form.onsubmit = (e) => (e.preventDefault(), void sendCode(input.value));
    const google = h("button", { class: "btn lg-google", type: "button" }, "Continue with Google");
    google.onclick = () => void withGoogle();
    const offline = h("a", { class: "lg-link", href: `${location.pathname}?game=v2&mock=1` }, "Or try it offline, without an account");
    fill(
      panel,
      h("p", { class: "lg-k" }, "Sign on"),
      h("p", { class: "lg-line" }, "One sign-in, one dock pass. No wallet to install, and it follows you to any device."),
      form,
      h("div", { class: "lg-row" }, google),
      noteEl(),
      offline,
    );
  }

  // ---- the steps ----
  async function ready(): Promise<Auth> {
    auth ??= await createPrivyAuth(opts.appId);
    return auth;
  }

  async function sendCode(raw: string) {
    email = raw.trim();
    if (!isEmail(email)) return set("out", "That doesn't look like an email address.");
    set("working");
    try {
      await (await ready()).sendCode(email);
      set("code");
    } catch (e) {
      set("out", (e as Error).message);
    }
  }

  async function signIn(code: string) {
    set("working");
    try {
      who = await (await ready()).signIn(email, code);
    } catch (e) {
      return set("code", (e as Error).message);
    }
    await enter();
  }

  async function withGoogle() {
    set("working");
    try {
      await (await ready()).google(); // the page leaves for Google
    } catch (e) {
      set("out", (e as Error).message);
    }
  }

  /** Signed in: make sure this browser holds that sign-in's wallet, then open the game. */
  async function enter() {
    if (!who || !auth) return set("out");
    const known = (() => {
      try {
        return JSON.parse(storage.getItem(LOGIN_STORAGE_KEY) ?? "null") as { id?: string; accountId?: string } | null;
      } catch {
        return null;
      }
    })();
    if (known?.id === who.id && known.accountId === opts.wallet.accountId()) return set("in");
    set("working");
    try {
      const token = await auth.token();
      if (!token) throw new Error("Your sign-in has expired. Sign in again.");
      const wallet = await fetchWallet(opts.sessionUrl, token, opts.fetch);
      const before = opts.wallet.accountId();
      opts.wallet.importKey(wallet.privateKey); // the key it replaces is kept (wallet.ts REPLACED_STORAGE_KEY)
      storage.setItem(LOGIN_STORAGE_KEY, JSON.stringify({ id: who.id, accountId: wallet.accountId }));
      // The rest of the game started with the guest account. A fresh page starts with the right one.
      if (before !== wallet.accountId) return reload();
      set("in");
    } catch (e) {
      set("error", (e as Error).message);
    }
  }

  async function signOut() {
    set("working");
    try {
      await (await ready()).signOut();
    } catch {
      // signed out here either way: the wallet goes below
    }
    // The key comes back from the dock office at the next sign-in; it shouldn't stay on a shared computer.
    storage.removeItem(LOGIN_STORAGE_KEY);
    storage.removeItem(WALLET_STORAGE_KEY);
    reload();
  }

  async function begin() {
    set("checking");
    try {
      who = await (await ready()).start();
    } catch (e) {
      return set("error", `Couldn't reach the sign-in service. ${(e as Error).message ?? ""}`.trim());
    }
    if (stopped) return;
    if (who) await enter();
    else set("out");
  }

  set("checking");
  void begin();

  const login: Login = {
    state: () => state,
    who: () => who,
    token: async () => (state === "in" || state === "working" ? ((await auth?.token()) ?? null) : null),
    open,
    close,
    signOut,
    stop() {
      stopped = true;
      clearInterval(mounting);
      document.removeEventListener("click", refuse, true);
      ext.beforeRun = innerBeforeRun;
      app?.classList.remove("lg-locked");
      panel.remove();
      sheet?.remove();
    },
  };
  G.login = login;
  return login;
}
