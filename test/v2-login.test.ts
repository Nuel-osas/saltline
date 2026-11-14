// @vitest-environment happy-dom
// v2's sign-in in the browser: the gate on the title (login/index.ts), the wallet hand-over (login/session.ts) and the
// labels shown for a signed-in player (login/auth.ts). Privy itself is stood in for; server/auth is in v2-auth.test.ts.
import { generateKey } from "near-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Auth, type Who, isEmail, maskEmail, whoIs } from "../src/economy/v2/login/auth";
import { LOGIN_STORAGE_KEY, type Login, startLogin } from "../src/economy/v2/login";
import { fetchWallet, sessionUrlFor, withToken } from "../src/economy/v2/login/session";
import { WALLET_STORAGE_KEY, implicitAccountId } from "../src/economy/wallet";

const ALICE: Who = { id: "did:privy:cmalice000000000000000001", label: "a•••e@example.com" };
const KEY = generateKey().secretKey;
const ACCOUNT = implicitAccountId(KEY);
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = async (login: Login, want: string) => {
  for (let i = 0; i < 50 && login.state() !== want; i++) await tick();
  expect(login.state()).toBe(want);
};

function world(opts: { signedIn?: Who | null; account?: string; known?: unknown; session?: () => Response; auth?: Partial<Auth> } = {}) {
  document.body.innerHTML = `<div id="app"><section class="m-screen" data-s="title"><div class="m-actions"><button class="btn primary" data-act="deploy">Deploy</button><button class="btn d2-entry">Dock</button></div></section></div>`;
  const store = new Map<string, string>();
  if (opts.known) store.set(LOGIN_STORAGE_KEY, JSON.stringify(opts.known));
  store.set(WALLET_STORAGE_KEY, "{guest}");
  const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
  let account = opts.account ?? "ee".repeat(32);
  const imported: string[] = [];
  const wallet = { accountId: () => account, importKey: (k: string) => (imported.push(k), (account = implicitAccountId(k))) };
  const sent: string[] = [];
  const asked: { url: string; auth: string | null }[] = [];
  let signedIn = opts.signedIn ?? null;
  const auth: Auth = {
    start: async () => signedIn,
    sendCode: async (email) => void sent.push(email),
    signIn: async (_email, code) => {
      if (code !== "123456") throw new Error("That code didn't work. Check it, or send a new one.");
      return (signedIn = ALICE);
    },
    google: async () => {},
    token: async () => (signedIn ? "tok_" + "a".repeat(40) : null),
    signOut: async () => void (signedIn = null),
    ...opts.auth,
  };
  const held: string[] = [];
  const G: any = { ext: { beforeRun: (go: () => void) => (held.push("raid"), go(), false) }, events: { emit: () => {} } };
  const reload = vi.fn();
  const doFetch = (async (url: string, init?: RequestInit) => {
    asked.push({ url, auth: new Headers(init?.headers).get("authorization") });
    return opts.session ? opts.session() : json(200, { ok: true, accountId: ACCOUNT, privateKey: KEY });
  }) as typeof fetch;
  const login = startLogin(G, { appId: "cmtestappid0000000000000a", sessionUrl: "/api/session", wallet, auth, fetch: doFetch, storage, reload });
  const app = document.getElementById("app")!;
  const panel = () => document.querySelector<HTMLElement>(".lg")!;
  return { login, G, app, panel, store, imported, sent, asked, held, reload };
}

afterEach(() => (document.body.innerHTML = ""));

describe("the sign-in gate", () => {
  it("locks the title until someone signs in: the panel stands where Deploy was, and a start is held", async () => {
    const w = world();
    await settle(w.login, "out");
    expect(w.app.classList.contains("lg-locked")).toBe(true);
    expect(w.panel().nextElementSibling?.classList.contains("m-actions")).toBe(true);
    expect(w.panel().querySelector("input[type=email]")).not.toBeNull();
    let started = false;
    expect(w.G.ext.beforeRun(() => (started = true))).toBe(true); // held
    expect(started).toBe(false);
    expect(w.held).toEqual([]);
    expect(await w.login.token()).toBeNull();
  });

  it("a click on Deploy or the dock goes nowhere while locked", async () => {
    const w = world();
    await settle(w.login, "out");
    const seen: string[] = [];
    for (const sel of ['[data-act="deploy"]', ".d2-entry"]) {
      const b = document.querySelector<HTMLElement>(sel)!;
      b.addEventListener("click", () => seen.push(sel));
      b.click();
    }
    expect(seen).toEqual([]);
  });

  it("email, then the code, then the wallet from the dock office; the page reloads onto the new account", async () => {
    const w = world();
    await settle(w.login, "out");
    w.panel().querySelector<HTMLInputElement>("input")!.value = "  marlowe@example.com ";
    w.panel().querySelector<HTMLFormElement>("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
    await settle(w.login, "code");
    expect(w.sent).toEqual(["marlowe@example.com"]);
    w.panel().querySelector<HTMLInputElement>("input")!.value = "123456";
    w.panel().querySelector<HTMLFormElement>("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
    for (let i = 0; i < 50 && !w.reload.mock.calls.length; i++) await tick();
    expect(w.asked).toEqual([{ url: "/api/session", auth: "Bearer tok_" + "a".repeat(40) }]);
    expect(w.imported).toEqual([KEY]);
    expect(JSON.parse(w.store.get(LOGIN_STORAGE_KEY)!)).toEqual({ id: ALICE.id, accountId: ACCOUNT });
    expect(w.reload).toHaveBeenCalledTimes(1);
  });

  it("a wrong code, or a bad email, says so and sends nothing further", async () => {
    const w = world();
    await settle(w.login, "out");
    w.panel().querySelector<HTMLInputElement>("input")!.value = "not-an-email";
    w.panel().querySelector<HTMLFormElement>("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
    await tick();
    expect(w.login.state()).toBe("out");
    expect(w.panel().textContent).toContain("doesn't look like an email");
    expect(w.sent).toEqual([]);
    w.panel().querySelector<HTMLInputElement>("input")!.value = "marlowe@example.com";
    w.panel().querySelector<HTMLFormElement>("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
    await settle(w.login, "code");
    w.panel().querySelector<HTMLInputElement>("input")!.value = "000000";
    w.panel().querySelector<HTMLFormElement>("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
    await settle(w.login, "code");
    expect(w.panel().textContent).toContain("didn't work");
    expect(w.asked).toEqual([]);
  });

  it("a returning player whose browser already holds their wallet goes straight in, without asking the dock office", async () => {
    const w = world({ signedIn: ALICE, account: ACCOUNT, known: { id: ALICE.id, accountId: ACCOUNT } });
    await settle(w.login, "in");
    expect(w.asked).toEqual([]);
    expect(w.app.classList.contains("lg-locked")).toBe(false);
    expect(w.panel().textContent).toContain(ALICE.label);
    let started = false;
    expect(w.G.ext.beforeRun(() => (started = true))).toBe(false); // the raid's own start runs
    expect(started).toBe(true);
    expect(await w.login.token()).toBe("tok_" + "a".repeat(40));
  });

  it("signed in on a browser that holds another wallet: it fetches the right one before opening", async () => {
    const w = world({ signedIn: ALICE, known: { id: "did:privy:someoneelse0000000000001", accountId: "ee".repeat(32) } });
    for (let i = 0; i < 50 && !w.reload.mock.calls.length; i++) await tick();
    expect(w.imported).toEqual([KEY]);
    expect(w.reload).toHaveBeenCalledTimes(1);
  });

  it("stays locked and says why when the dock office refuses the sign-in", async () => {
    const w = world({ signedIn: ALICE, session: () => json(401, { ok: false, error: "Your sign-in has expired. Sign in again." }) });
    await settle(w.login, "error");
    expect(w.app.classList.contains("lg-locked")).toBe(true);
    expect(w.panel().textContent).toContain("Your sign-in has expired");
    expect(w.imported).toEqual([]);
  });

  it("signing out takes the wallet off this browser and reloads", async () => {
    const w = world({ signedIn: ALICE, account: ACCOUNT, known: { id: ALICE.id, accountId: ACCOUNT } });
    await settle(w.login, "in");
    [...w.panel().querySelectorAll("button")].find((b) => b.textContent === "Sign out")!.click();
    for (let i = 0; i < 50 && !w.reload.mock.calls.length; i++) await tick();
    expect(w.store.has(WALLET_STORAGE_KEY)).toBe(false);
    expect(w.store.has(LOGIN_STORAGE_KEY)).toBe(false);
    expect(w.reload).toHaveBeenCalledTimes(1);
  });

  it("stop() takes the lock and the panel away", async () => {
    const w = world();
    await settle(w.login, "out");
    w.login.stop();
    expect(document.querySelector(".lg")).toBeNull();
    expect(w.app.classList.contains("lg-locked")).toBe(false);
    expect(w.G.ext.beforeRun(() => {})).toBe(false);
  });
});

describe("the wallet hand-over", () => {
  it("fetchWallet sends the token and takes only a well-formed key for the account named", async () => {
    const seen: (string | null)[] = [];
    const ok = (async (_u: string, init?: RequestInit) => (seen.push(new Headers(init?.headers).get("authorization")), json(200, { ok: true, accountId: ACCOUNT, privateKey: KEY }))) as typeof fetch;
    expect(await fetchWallet("/api/session", "tok", ok)).toEqual({ accountId: ACCOUNT, privateKey: KEY });
    expect(seen).toEqual(["Bearer tok"]);
    const answer = (status: number, body: unknown) => (async () => json(status, body)) as unknown as typeof fetch;
    await expect(fetchWallet("/s", "t", answer(200, { ok: true, accountId: "ff".repeat(32), privateKey: KEY }))).rejects.toThrow("different account");
    await expect(fetchWallet("/s", "t", answer(200, { ok: true, accountId: ACCOUNT, privateKey: "ed25519:nope" }))).rejects.toThrow("isn't a key");
    await expect(fetchWallet("/s", "t", answer(200, { ok: false }))).rejects.toThrow("answered 200");
    await expect(fetchWallet("/s", "t", answer(401, { ok: false, error: "Sign in first." }))).rejects.toThrow("Sign in first.");
    await expect(fetchWallet("/s", "t", (async () => Promise.reject(new Error("offline"))) as unknown as typeof fetch)).rejects.toThrow("Couldn't reach the dock office");
  });

  it("withToken signs the faucet's requests and no one else's", async () => {
    const seen: [string, string | null][] = [];
    const base = (async (u: string, init?: RequestInit) => (seen.push([u, new Headers(init?.headers).get("authorization")]), json(200, {}))) as typeof fetch;
    const f = withToken("/api/faucet", async () => "tok", base);
    await f("/api/faucet", { method: "POST", headers: { "content-type": "application/json" } });
    await f("https://rpc.testnet.near.org", { method: "POST" });
    await withToken("/api/faucet", async () => null, base)("/api/faucet", { method: "POST" });
    expect(seen).toEqual([
      ["/api/faucet", "Bearer tok"],
      ["https://rpc.testnet.near.org", null],
      ["/api/faucet", null],
    ]);
    expect(sessionUrlFor("/api/faucet")).toBe("/api/session");
    expect(sessionUrlFor("https://x.example/api/faucet")).toBe("https://x.example/api/session");
  });
});

describe("who is signed in", () => {
  it("shows a masked email, whichever way they signed in", () => {
    expect(maskEmail("marlowe@example.com")).toBe("m•••••e@example.com");
    expect(maskEmail("al@example.com")).toBe("a•l@example.com");
    expect(maskEmail("nope")).toBe("your account");
    expect(whoIs({ id: "did:privy:x", linked_accounts: [{ type: "email", address: "marlowe@example.com" }] })).toEqual({ id: "did:privy:x", label: "m•••••e@example.com" });
    expect(whoIs({ id: "did:privy:x", linked_accounts: [{ type: "google_oauth", email: "rook@gmail.com" }] })?.label).toBe("r••k@gmail.com");
    expect(whoIs({ id: "did:privy:x", linked_accounts: [{ type: "wallet", address: "0xabc" }] })?.label).toBe("your account");
    expect(whoIs({ linked_accounts: [] })).toBeNull();
    expect(whoIs(null)).toBeNull();
  });

  it("knows an email address when it sees one", () => {
    for (const good of ["a@b.co", " marlowe@example.com ", "first.last+tag@sub.example.org"]) expect(isEmail(good)).toBe(true);
    for (const bad of ["", "not-an-email", "a@b", "a b@c.com", "@x.com"]) expect(isEmail(bad)).toBe(false);
  });
});
