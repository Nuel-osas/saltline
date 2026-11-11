// POST /api/tick on Vercel: wakes the broker agents when people play. The work is in server/tick.ts.
// Env: BROKER_MOSS_KEY, BROKER_INES_KEY, BROKER_QM_KEY (sensitive), CONTRACT_ID, NEAR_NETWORK = testnet, optional NEAR_RPC.
import { handleTick } from "../server/tick.js";

type Env = Record<string, string | undefined>;

const env = (): Env => (globalThis as { process?: { env?: Env } }).process?.env ?? {};

export default {
  fetch(request: Request): Promise<Response> {
    return handleTick(request, env());
  },
};
