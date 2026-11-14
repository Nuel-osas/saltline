// Sign-in with Privy, through its plain-JavaScript kit (@privy-io/js-sdk-core): an email code, or Google. The kit is
// loaded only when sign-in is switched on, so the offline game and the first game never download it.
//
// Checked against the installed kit's types (0.79.5) and docs.privy.io, 13 Nov 2026:
// - `new Privy({ appId, storage: new LocalStorage() })`, then `initialize()`; `user.get()` answers `{ user }`.
// - Email: `auth.email.sendCode(email)`, then `auth.email.loginWithCode(email, code)`.
// - Google: `auth.oauth.generateURL("google", redirectURI)` answers `{ url }`; Google sends the player back with
//   `privy_oauth_code` and `privy_oauth_state` in the address, which `auth.oauth.loginWithCode(code, state)` takes.
// - `getAccessToken()` answers the token the server checks (server/auth.ts), refreshed by the kit when it is stale.
//
// Only the app id is used here. It is public: every Privy app ships it to the browser.

/** Who is signed in: Privy's user id, and a short label safe to show on screen. */
export interface Who {
  id: string;
  label: string;
}

export interface Auth {
  /** Starts the kit, finishes a Google sign-in if the address carries one, and answers who is signed in (or null). */
  start(): Promise<Who | null>;
  sendCode(email: string): Promise<void>;
  signIn(email: string, code: string): Promise<Who>;
  /** Leaves the page for Google; `start()` finishes the sign-in when the player comes back. */
  google(): Promise<void>;
  token(): Promise<string | null>;
  signOut(): Promise<void>;
}

interface PrivyUser {
  id?: unknown;
  linked_accounts?: { type?: unknown; address?: unknown; email?: unknown }[];
}

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,24}$/;
export const isEmail = (s: string) => EMAIL.test(s.trim());

/** "marlowe@example.com" → "m•••••e@example.com": enough to recognise, not enough to read over a shoulder. */
export function maskEmail(email: string): string {
  const [name, domain] = email.split("@");
  if (!name || !domain) return "your account";
  return `${name[0]}${"•".repeat(Math.max(1, Math.min(6, name.length - 2)))}${name.length > 1 ? name[name.length - 1] : ""}@${domain}`;
}

/** The label for a Privy user: their masked email if they have one, else which kind of account they used. */
export function whoIs(user: PrivyUser | null | undefined): Who | null {
  if (!user || typeof user.id !== "string" || !user.id) return null;
  const accounts = Array.isArray(user.linked_accounts) ? user.linked_accounts : [];
  for (const a of accounts) {
    const email = a.type === "email" ? a.address : a.type === "google_oauth" ? a.email : null;
    if (typeof email === "string" && email.includes("@")) return { id: user.id, label: maskEmail(email) };
  }
  return { id: user.id, label: "your account" };
}

/** Privy's own words for a failure when it has some, else ours. */
const reason = (e: unknown, fallback: string) => {
  const m = (e as { message?: unknown })?.message;
  return typeof m === "string" && m.length > 0 && m.length < 160 ? m : fallback;
};

export async function createPrivyAuth(appId: string): Promise<Auth> {
  const { default: Privy, LocalStorage } = await import("@privy-io/js-sdk-core");
  const privy = new Privy({ appId, storage: new LocalStorage() });

  /** Who is signed in, or null. With nobody signed in the kit throws ("No tokens found in storage") rather than answering empty. */
  const current = async (): Promise<Who | null> => {
    try {
      if (!(await privy.getAccessToken())) return null;
      return whoIs(((await privy.user.get()) as { user?: PrivyUser | null } | null)?.user);
    } catch {
      return null;
    }
  };

  return {
    async start() {
      await privy.initialize();
      const q = new URLSearchParams(location.search);
      const code = q.get("privy_oauth_code");
      const state = q.get("privy_oauth_state");
      if (code && state) {
        // Whatever happens, the one-use code leaves the address so a reload can't replay it.
        for (const k of ["privy_oauth_code", "privy_oauth_state", "privy_oauth_provider"]) q.delete(k);
        history.replaceState(null, "", `${location.pathname}${q.size ? `?${q}` : ""}${location.hash}`);
        const session = (await privy.auth.oauth.loginWithCode(code, state)) as { user?: PrivyUser };
        return whoIs(session.user) ?? (await current());
      }
      return current();
    },
    async sendCode(email) {
      if (!isEmail(email)) throw new Error("That doesn't look like an email address.");
      try {
        await privy.auth.email.sendCode(email.trim());
      } catch (e) {
        throw new Error(reason(e, "Couldn't send the code. Try again."));
      }
    },
    async signIn(email, code) {
      if (!/^\d{6}$/.test(code.trim())) throw new Error("The code is six digits.");
      let session: { user?: PrivyUser };
      try {
        session = (await privy.auth.email.loginWithCode(email.trim(), code.trim())) as { user?: PrivyUser };
      } catch (e) {
        throw new Error(reason(e, "That code didn't work. Check it, or send a new one."));
      }
      const who = whoIs(session.user) ?? (await current());
      if (!who) throw new Error("The sign-in didn't take. Try again.");
      return who;
    },
    async google() {
      let url: unknown;
      try {
        url = ((await privy.auth.oauth.generateURL("google", `${location.origin}${location.pathname}${location.search}`)) as { url?: unknown }).url;
      } catch (e) {
        throw new Error(reason(e, "Google sign-in isn't switched on for this game yet. Use your email."));
      }
      if (typeof url !== "string" || !/^https:\/\//.test(url)) throw new Error("Google sign-in isn't switched on for this game yet. Use your email.");
      location.assign(url);
    },
    token: () => privy.getAccessToken(),
    async signOut() {
      await privy.auth.logout();
    },
  };
}
