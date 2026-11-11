// Which chain the economy talks to, read once at boot from Vite's env and the page URL.
//
// - `?mock` in the URL, or no VITE_CONTRACT_ID, picks the offline mock (mock.ts). `?mock=42` seeds it with 42.
// - Otherwise it's NEAR testnet. Any other network is refused: this build never touches mainnet.
//
// The URLs below were checked on 11 Nov 2026:
// - docs.near.org/api/rpc/providers lists FastNEAR's testnet RPC as https://test.rpc.fastnear.com.
// - docs.near.org/protocol/network/networks lists https://rpc.testnet.near.org (status endpoint) and the testnet
//   explorer https://testnet.nearblocks.io. NEAR announced the near.org RPCs as deprecated and heavily rate limited
//   (near.org/blog/deprecation-of-near-org-and-pagoda-co-rpc-endpoints), so it is the fallback, not the default.
//   Both RPCs answered a `status` call with chain_id "testnet".
// - Transactions on the explorer live at /txns/<hash> (seen on indexed testnet.nearblocks.io pages; the site
//   blocks scripted fetches, so it was not opened from here).

export const TESTNET_RPC_URLS = ["https://test.rpc.fastnear.com", "https://rpc.testnet.near.org"] as const;
export const TESTNET_EXPLORER_TX = "https://testnet.nearblocks.io/txns/";
export const MOCK_CONTRACT_ID = "saltline.mock";
export const FAUCET_PATH = "/api/faucet";

export interface EconomyConfig {
  mode: "mock" | "testnet";
  network: "testnet";
  /** The game contract (MOCK_CONTRACT_ID on the mock). */
  contractId: string;
  /** Tried in order; chain.ts rotates to the next one on a transient failure. */
  rpcUrls: string[];
  /** Prefix for a transaction hash on the explorer. */
  explorerTxUrl: string;
  faucetUrl: string;
  /** The mock's seed (only used in mock mode). */
  mockSeed: number;
}

export class ConfigError extends Error {
  override name = "ConfigError";
}

// NEAR account ids: 2–64 chars, lowercase parts of [a-z0-9] joined by single - or _, parts separated by dots.
const ACCOUNT_ID = /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

function rpcList(raw: string | undefined): string[] {
  if (!raw || !raw.trim()) return [...TESTNET_RPC_URLS];
  const urls = raw
    .split(",")
    .map((u) => u.trim())
    .filter(Boolean);
  for (const u of urls) {
    let parsed: URL;
    try {
      parsed = new URL(u);
    } catch {
      throw new ConfigError(`VITE_NEAR_RPC: not a URL: ${u}`);
    }
    const local = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost";
    if (parsed.protocol !== "https:" && !(local && parsed.protocol === "http:")) {
      throw new ConfigError(`VITE_NEAR_RPC: use https (${u})`);
    }
  }
  return urls;
}

function mockFlag(search: string): { on: boolean; seed: number } {
  const params = new URLSearchParams(search);
  if (!params.has("mock")) return { on: false, seed: 1 };
  const v = (params.get("mock") ?? "").trim().toLowerCase();
  if (v === "0" || v === "false" || v === "off") return { on: false, seed: 1 };
  const n = Number(v);
  return { on: true, seed: v !== "" && Number.isSafeInteger(n) && n >= 0 ? n : 1 };
}

/** Pure, so it can be tested: `env` is import.meta.env, `search` is location.search. */
export function resolveConfig(env: Record<string, unknown>, search: string): EconomyConfig {
  const str = (k: string) => (typeof env[k] === "string" ? (env[k] as string).trim() : "");
  const network = str("VITE_NEAR_NETWORK") || "testnet";
  if (network !== "testnet") throw new ConfigError(`VITE_NEAR_NETWORK=${network}: only testnet is supported`);
  const contractId = str("VITE_CONTRACT_ID");
  const mock = mockFlag(search);
  const base = {
    network: "testnet" as const,
    rpcUrls: rpcList(str("VITE_NEAR_RPC")),
    explorerTxUrl: TESTNET_EXPLORER_TX,
    faucetUrl: str("VITE_FAUCET_URL") || FAUCET_PATH,
    mockSeed: mock.seed,
  };
  if (mock.on || !contractId) return { ...base, mode: "mock", contractId: MOCK_CONTRACT_ID };
  if (!ACCOUNT_ID.test(contractId)) throw new ConfigError(`VITE_CONTRACT_ID is not a NEAR account id: ${contractId}`);
  return { ...base, mode: "testnet", contractId };
}

/** The config for this page load. */
export function readConfig(): EconomyConfig {
  const search = typeof location === "undefined" ? "" : location.search;
  return resolveConfig(import.meta.env as Record<string, unknown>, search);
}
