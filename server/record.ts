// What the server writes down, where it happens: the dock office handed a sign-in its wallet (server/session.ts), and
// the faucet issued a v2 dock pass (server/faucet.ts). These are the server's own facts; nothing here comes from what
// a browser claims. Each goes to the user's record (server/users.ts) and to the day's counts (server/counts.ts).
//
// The game never depends on it. Each call is given SIDE_JOB_MS and then left behind, whatever it throws is swallowed,
// and with the store off it does nothing: the wallet and the pass go out exactly as they would with no database.
import { countServer, countUser, metricsSalt } from "./counts.js";
import { type Store, quietly, storeFor } from "./store.js";
import { gavePass, sawUser } from "./users.js";

type Env = Record<string, string | undefined>;

/** The longest a sign-in or a dock pass waits for the database before going on without it. */
export const SIDE_JOB_MS = 1000;

export interface RecordDeps {
  /** For tests; the default is the deployment's own store (storeFor). */
  store?: Store;
}

/** POST /api/session answered a sign-in with its wallet. */
export async function sessionIssued(env: Env, s: { userId: string; accountId: string; at: number }, deps: RecordDeps = {}): Promise<void> {
  await quietly(async () => {
    const store = deps.store ?? storeFor(env);
    if (store.kind === "off") return;
    // The record is the studio's own list and needs no salt. The day's set of sign-ins holds hashes, so it does.
    const salt = metricsSalt(env);
    await Promise.all([sawUser(store, { ...s, as: "session" }), countServer(store, { event: "session_issued", at: s.at }), salt ? countUser(store, salt, s) : null]);
  }, SIDE_JOB_MS);
}

/**
 * The faucet issued a v2 dock pass. `userId` is the sign-in it went to, or null for a guest pass (sign-in switched
 * off), which is counted but has no sign-in to keep a record under.
 */
export async function passIssued(env: Env, p: { userId: string | null; accountId: string; callsign: string; at: number }, deps: RecordDeps = {}): Promise<void> {
  await quietly(async () => {
    const store = deps.store ?? storeFor(env);
    if (store.kind === "off") return;
    await Promise.all([p.userId ? gavePass(store, { userId: p.userId, accountId: p.accountId, callsign: p.callsign, at: p.at }) : null, countServer(store, { event: "pass_issued", at: p.at })]);
  }, SIDE_JOB_MS);
}
