// Who has signed in (docs/DATA.md → Users). One record per sign-in, keyed by the Privy user id, in the store
// (server/store.ts):
//
//   user:<privy id>   a hash: accountId, firstSeen, lastSeen, sessions, visits, callsign, passAt
//   users             a sorted set of every Privy id, scored by when it was first seen: the count, and newest-first
//
// What is not here: an email address, a name, an IP, or any key. The server never has the player's email (checking a
// sign-in needs Privy's public keys only, and Privy's own API is never called), so it cannot store one.
//
// Every id passed in has already been through verifyToken (server/auth.ts), which is what makes it safe to use as a
// key. Like the store, nothing here throws: a write that didn't land answers false, a read that failed answers null.
import type { Store } from "./store.js";

export interface UserRecord {
  /** The Privy user id (did:privy:…). */
  id: string;
  /** The NEAR account derived for this sign-in. */
  accountId: string | null;
  /** Milliseconds since 1970 (UTC). null: not on the record. */
  firstSeen: number | null;
  lastSeen: number | null;
  /** Times the dock office handed this sign-in its wallet (POST /api/session): once per browser, roughly. */
  sessions: number;
  /** Signed-in page loads that proved who they were to POST /api/metrics. */
  visits: number;
  /** From the dock pass. */
  callsign: string | null;
  passAt: number | null;
}

const USERS = "users";
const userKey = (id: string) => `user:${id}`;

/** A sign-in was seen: the dock office handed over its wallet ("session"), or a signed-in page load came in ("visit"). */
export async function sawUser(store: Store, u: { userId: string; accountId: string; at: number; as: "session" | "visit" }): Promise<boolean> {
  const key = userKey(u.userId);
  const done = await Promise.all([
    store.hset(key, { firstSeen: String(u.at) }, { ifAbsent: true }),
    store.hset(key, { accountId: u.accountId, lastSeen: String(u.at) }),
    store.hincrby(key, u.as === "session" ? "sessions" : "visits", 1),
    store.zadd(USERS, u.at, u.userId, { ifAbsent: true }),
  ]);
  return done.every(Boolean);
}

/** The faucet issued this sign-in its dock pass. The first pass time is kept if it is ever issued again. */
export async function gavePass(store: Store, p: { userId: string; accountId: string; callsign: string; at: number }): Promise<boolean> {
  const key = userKey(p.userId);
  const done = await Promise.all([
    store.hset(key, { firstSeen: String(p.at), passAt: String(p.at) }, { ifAbsent: true }),
    store.hset(key, { accountId: p.accountId, callsign: p.callsign, lastSeen: String(p.at) }),
    store.zadd(USERS, p.at, p.userId, { ifAbsent: true }),
  ]);
  return done.every(Boolean);
}

/** How many sign-ins are on record. null: unknown (the store is off or didn't answer). */
export const countUsers = (store: Store): Promise<number | null> => store.zcount(USERS, "-inf", "+inf");

const time = (v: string | undefined): number | null => (v !== undefined && /^\d{1,16}$/.test(v) ? Number(v) : null);
// A counter nobody has added to isn't in the hash, and that is a true zero: the hash itself was read.
const tally = (v: string | undefined): number => (v !== undefined && /^\d{1,15}$/.test(v) ? Number(v) : 0);

/** The newest sign-ins first. null when any part of the read failed: half a list would pass for the whole. */
export async function listUsers(store: Store, limit = 50): Promise<UserRecord[] | null> {
  const n = Math.max(1, Math.min(200, Math.floor(limit) || 1));
  const ids = await store.zrange(USERS, 0, n - 1, { rev: true });
  if (!ids) return null;
  const rows = await Promise.all(ids.map((id) => store.hgetall(userKey(id))));
  const out: UserRecord[] = [];
  for (const [i, h] of rows.entries()) {
    if (!h) return null;
    out.push({ id: ids[i], accountId: h.accountId ?? null, firstSeen: time(h.firstSeen), lastSeen: time(h.lastSeen), sessions: tally(h.sessions), visits: tally(h.visits), callsign: h.callsign ?? null, passAt: time(h.passAt) });
  }
  return out;
}
