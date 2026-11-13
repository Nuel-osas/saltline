// POST /api/tick on Vercel: wakes the broker agents when people play. The work is in server/tick.ts.
// POST /api/tick?game=v2 wakes v2's characters (Moss, Ines, the Harbormaster) instead.
// Env: BROKER_MOSS_KEY, BROKER_INES_KEY, BROKER_QM_KEY (sensitive), CONTRACT_ID, NEAR_NETWORK = testnet, optional NEAR_RPC.
// For v2: BROKER_MOSS_KEY and BROKER_INES_KEY again, HARBORMASTER_KEY (sensitive), CONTRACT_ID_V2.
import { handleTick } from "../server/tick.js";

type Env = Record<string, string | undefined>;

const env = (): Env => (globalThis as { process?: { env?: Env } }).process?.env ?? {};

export default {
  fetch(request: Request): Promise<Response> {
    return handleTick(request, env());
  },
};
