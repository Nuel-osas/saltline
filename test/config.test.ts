import { describe, expect, it } from "vitest";
import { ConfigError, resolveConfig } from "../src/economy/config";

describe("config", () => {
  it("picks the mock without a contract id or with ?mock, and testnet otherwise", () => {
    expect(resolveConfig({}, "").mode).toBe("mock");
    expect(resolveConfig({ VITE_CONTRACT_ID: "saltline.testnet" }, "?mock").mode).toBe("mock");
    expect(resolveConfig({ VITE_CONTRACT_ID: "saltline.testnet" }, "?mock=42").mockSeed).toBe(42);
    expect(resolveConfig({ VITE_CONTRACT_ID: "saltline.testnet" }, "?mock=0").mode).toBe("testnet");
    const t = resolveConfig({ VITE_CONTRACT_ID: "saltline.testnet", VITE_NEAR_NETWORK: "testnet" }, "?seed=3");
    expect(t).toMatchObject({ mode: "testnet", contractId: "saltline.testnet", rpcUrls: ["https://test.rpc.fastnear.com", "https://rpc.testnet.near.org"] });
    expect(resolveConfig({ VITE_CONTRACT_ID: "saltline.testnet", VITE_NEAR_RPC: "https://a.example, https://b.example" }, "").rpcUrls).toEqual([
      "https://a.example",
      "https://b.example",
    ]);
  });
  it("refuses any network but testnet, a malformed contract id and a plain-http RPC", () => {
    expect(() => resolveConfig({ VITE_NEAR_NETWORK: "mainnet" }, "")).toThrow(ConfigError);
    expect(() => resolveConfig({ VITE_CONTRACT_ID: "Not An Account" }, "")).toThrow(ConfigError);
    expect(() => resolveConfig({ VITE_CONTRACT_ID: "saltline.testnet", VITE_NEAR_RPC: "http://rpc.example" }, "")).toThrow(ConfigError);
  });
});
