// POST /api/faucet on Vercel: a Node.js function using the Web-standard `fetch` export
// (vercel.com/docs/functions/runtimes/node-js, checked 11 Nov 2026). The work is in server/faucet.ts.
//
// Env comes from the project's server-side environment variables: FAUCET_ACCOUNT_ID, FAUCET_PRIVATE_KEY,
// CONTRACT_ID (or VITE_CONTRACT_ID), NEAR_NETWORK (or VITE_NEAR_NETWORK) = testnet, and optionally NEAR_RPC.
// CONTRACT_ID_V2 names v2's contract for claims that say `game: "v2"`; without it those answer 503.
import { handleFaucet } from "../server/faucet.js";

type Env = Record<string, string | undefined>;

const env = (): Env => (globalThis as { process?: { env?: Env } }).process?.env ?? {};

export default {
  fetch(request: Request): Promise<Response> {
    return handleFaucet(request, env());
  },
};
