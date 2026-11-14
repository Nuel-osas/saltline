// POST /api/metrics on Vercel: the browser's beacon. A Node.js function using the Web-standard `fetch` export, as
// api/faucet.ts is. The work is in server/metrics.ts; what is stored and what is not is in docs/DATA.md.
//
// Env: the database (UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN, or Vercel's KV_REST_API_URL +
// KV_REST_API_TOKEN) and optionally METRICS_SALT; PRIVY_APP_ID and WALLET_SECRET for checking a sign-in. With no
// database it answers 204 and counts nothing.
import { handleMetrics } from "../server/metrics.js";

type Env = Record<string, string | undefined>;

const env = (): Env => (globalThis as { process?: { env?: Env } }).process?.env ?? {};

export default {
  fetch(request: Request): Promise<Response> {
    return handleMetrics(request, env());
  },
};
