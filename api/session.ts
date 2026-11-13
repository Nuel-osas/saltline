// POST /api/session on Vercel: a Node.js function using the Web-standard `fetch` export, as api/faucet.ts is.
// The work is in server/session.ts.
//
// Env: PRIVY_APP_ID (the Privy app's public id) and WALLET_SECRET (a long random server-only secret that players'
// keys are derived from; changing it changes every player's account). With neither set, sign-in is off and this
// answers 404; with only one, 503.
import { handleSession } from "../server/session.js";

type Env = Record<string, string | undefined>;

const env = (): Env => (globalThis as { process?: { env?: Env } }).process?.env ?? {};

export default {
  fetch(request: Request): Promise<Response> {
    return handleSession(request, env());
  },
};
