// GET /api/stats on Vercel: the studio's numbers, for whoever holds the admin token. A Node.js function using the
// Web-standard `fetch` export, as api/faucet.ts is. The work is in server/stats.ts.
//
// Env: STATS_ADMIN_TOKEN (16+ characters, server side only; without it this answers 404) and the database
// (UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN, or Vercel's KV_REST_API_URL + KV_REST_API_TOKEN).
import { handleStats } from "../server/stats.js";

type Env = Record<string, string | undefined>;

const env = (): Env => (globalThis as { process?: { env?: Env } }).process?.env ?? {};

export default {
  fetch(request: Request): Promise<Response> {
    return handleStats(request, env());
  },
};
