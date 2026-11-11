// chain.ts through the real near-kit, with only `fetch` stubbed: near-kit signs real transactions and parses
// RPC replies shaped like nearcore's, so this checks the glue the stub-port tests can't.
import { generateKey } from "near-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestnetChain } from "../src/economy/chain";
import { TESTNET_EXPLORER_TX } from "../src/economy/config";

const ZERO_HASH = "11111111111111111111111111111111";
const TX_HASH = "9ZQ7wq3gL8kRrRk3BvTzv7bJ5yR1zH2bWm4cQe6sXyAa";
const RPCS = ["https://rpc-a.example", "https://rpc-b.example"];

type RpcRequest = { url: string; method: string; params: Record<string, unknown> };

const bytes = (v: unknown) => Array.from(new TextEncoder().encode(JSON.stringify(v)));
const rpc = (result: unknown) => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status: 200 });

const block = {
  author: "node.testnet",
  header: {
    height: 100,
    epoch_id: ZERO_HASH,
    next_epoch_id: ZERO_HASH,
    hash: ZERO_HASH,
    prev_hash: ZERO_HASH,
    prev_state_root: ZERO_HASH,
    chunk_receipts_root: ZERO_HASH,
    chunk_headers_root: ZERO_HASH,
    chunk_tx_root: ZERO_HASH,
    outcome_root: ZERO_HASH,
    chunks_included: 1,
    challenges_root: ZERO_HASH,
    timestamp: 1,
    timestamp_nanosec: "1",
    random_value: ZERO_HASH,
    validator_proposals: [],
    chunk_mask: [true],
    gas_price: "100000000",
    total_supply: "1",
    challenges_result: [],
    last_final_block: ZERO_HASH,
    last_ds_final_block: ZERO_HASH,
    next_bp_hash: ZERO_HASH,
    block_merkle_root: ZERO_HASH,
    approvals: [],
    signature: "ed25519:1",
    latest_protocol_version: 88,
  },
  chunks: [],
};

function outcome(signer: string, status: unknown) {
  const exec = (s: unknown) => ({
    id: TX_HASH,
    outcome: { logs: [], receipt_ids: [], gas_burnt: 1, tokens_burnt: "0", executor_id: "saltline.testnet", status: s },
    block_hash: ZERO_HASH,
    proof: [],
  });
  return {
    final_execution_status: "EXECUTED_OPTIMISTIC",
    status,
    transaction: {
      signer_id: signer,
      public_key: "ed25519:1",
      nonce: 6,
      receiver_id: "saltline.testnet",
      actions: [{ FunctionCall: { method_name: "sell", args: "", gas: 1, deposit: "0" } }],
      signature: "ed25519:1",
      hash: TX_HASH,
    },
    transaction_outcome: exec({ SuccessReceiptId: ZERO_HASH }),
    receipts_outcome: [exec(status)],
  };
}

function stubFetch(sendTx: ((n: number, req: RpcRequest) => Response)[], views: Record<string, unknown> = {}) {
  const requests: RpcRequest[] = [];
  let sends = 0;
  vi.stubGlobal("fetch", async (url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as { method: string; params: Record<string, unknown> };
    const req = { url, method: body.method, params: body.params };
    requests.push(req);
    if (body.method === "block") return rpc(block);
    if (body.method === "query" && body.params.request_type === "view_access_key") {
      return rpc({ nonce: 5, permission: "FullAccess", block_height: 100, block_hash: ZERO_HASH });
    }
    if (body.method === "query" && body.params.request_type === "call_function") {
      const v = views[body.params.method_name as string];
      if (v instanceof Response) return v;
      return rpc({ result: bytes(v), logs: [], block_height: 100, block_hash: ZERO_HASH });
    }
    if (body.method === "send_tx") return sendTx[sends++](sends, req);
    throw new Error(`unexpected RPC ${body.method}`);
  });
  return requests;
}

function makeChain() {
  const key = generateKey();
  const accountId = Array.from(key.publicKey.data, (b) => b.toString(16).padStart(2, "0")).join("");
  const chain = createTestnetChain({
    config: { contractId: "saltline.testnet", rpcUrls: RPCS, explorerTxUrl: TESTNET_EXPLORER_TX },
    keys: () => ({ accountId, privateKey: key.secretKey as `ed25519:${string}` }),
    exec: { retries: 3, backoffMs: 1, sleep: async () => undefined },
  });
  return { chain, accountId };
}

afterEach(() => vi.unstubAllGlobals());

describe("chain.ts on real near-kit", () => {
  it("decodes a view's bytes and converts its U128s", async () => {
    stubFetch([], { balances: { scrip: "150", core: "2" } });
    const { chain } = makeChain();
    expect(await chain.balances("rook.testnet")).toEqual({ scrip: 150, core: 2 });
  });

  it("reads views at optimistic finality, where its own calls land", async () => {
    const requests = stubFetch([], { balances: { scrip: "1" } });
    const { chain } = makeChain();
    await chain.balances("rook.testnet");
    const view = requests.find((r) => r.method === "query" && r.params.request_type === "call_function");
    expect(view?.params.finality).toBe("optimistic");
  });

  it("retries a view after an HTTP 503 on the next RPC", async () => {
    let first = true;
    const requests = stubFetch([], {
      get balances() {
        if (first) {
          first = false;
          return new Response("busy", { status: 503 });
        }
        return { scrip: "9" };
      },
    });
    const { chain } = makeChain();
    expect(await chain.balances("rook.testnet")).toEqual({ scrip: 9 });
    const views = requests.filter((r) => r.method === "query");
    expect(views.map((r) => r.url)).toEqual(RPCS);
  });

  it("rejects town with METHOD_NOT_FOUND on a contract without it, from the reply testnet sends today", async () => {
    // Recorded 11 Nov 2026: `town` on saltline.testnet through test.rpc.fastnear.com and rpc.testnet.near.org.
    const notThere = rpc({
      block_hash: "G3RKRFV5jQqyuzZ6Cx96LPjyJvBt8WwYubH6UMK9yNZ",
      block_height: 277245246,
      error: "wasm execution failed with error: MethodResolveError(MethodNotFound)",
      logs: [],
    });
    const requests = stubFetch([], { town: notThere });
    const { chain } = makeChain();
    await expect(chain.town()).rejects.toMatchObject({ code: "METHOD_NOT_FOUND", message: "town: the contract has no town view yet" });
    // one ask, no retries: it isn't going to appear on the next RPC
    expect(requests.filter((r) => r.method === "query")).toHaveLength(1);
  });

  it("re-sends the identical signed bytes after a 503, then maps the contract's panic", async () => {
    const requests = stubFetch([
      () => new Response("busy", { status: 503 }),
      () =>
        rpc(
          outcome("signer", {
            Failure: { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: "Smart contract panicked: E_BROKER_CLOSED: Moss is shut until someone invests" } } } },
          }),
        ),
    ]);
    const { chain } = makeChain();
    const r = await chain.sell("moss", "copper", 2);
    expect(r).toMatchObject({ ok: false, code: "E_BROKER_CLOSED", error: "Moss is shut until someone invests" });
    expect(r.txHash).toMatch(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/);
    const sends = requests.filter((q) => q.method === "send_tx");
    expect(sends).toHaveLength(2);
    expect(sends[1].params.signed_tx_base64).toBe(sends[0].params.signed_tx_base64);
    expect(sends.map((s) => s.url)).toEqual(RPCS);
  });

  it("returns the decoded reply and the tx hash on success", async () => {
    stubFetch([() => rpc(outcome("signer", { SuccessValue: btoa(JSON.stringify({ paid: "141" })) }))]);
    const { chain } = makeChain();
    const r = await chain.sell("moss", "copper", 3);
    expect(r).toMatchObject({ ok: true, paid: 141 });
    expect(chain.txUrl(r.txHash!)).toBe(`https://testnet.nearblocks.io/txns/${r.txHash}`);
  });
});
