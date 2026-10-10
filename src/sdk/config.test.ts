import { describe, expect, it } from "vitest";
import { getAddress } from "viem";

import { chainOf, networkFromEnv } from "./config.ts";
import { MAINNET, SANDBOX } from "./networks.ts";

describe("networkFromEnv", () => {
  it("defaults to the sandbox", () => {
    expect(networkFromEnv({}).name).toBe("sandbox");
    expect(networkFromEnv({ FEAST_NETWORK: "" }).chainId).toBe(56096);
  });
  it("selects BNB Smart Chain with FEAST_NETWORK=mainnet", () => {
    const network = networkFromEnv({ FEAST_NETWORK: "Mainnet" });
    expect(network.chainId).toBe(56);
    expect(network.realMoney).toBe(true);
    expect(network.faucetUrl).toBeNull();
  });
  it("takes a per-network RPC override without touching anything else", () => {
    const network = networkFromEnv({ FEAST_NETWORK: "sandbox", FEAST_SANDBOX_RPC_URL: "http://127.0.0.1:8546" });
    expect(network.rpcUrl).toBe("http://127.0.0.1:8546");
    expect(network.contracts).toEqual(SANDBOX.contracts);
  });
  it("never serves one network's reads from the other's override", () => {
    expect(networkFromEnv({ FEAST_NETWORK: "mainnet", FEAST_SANDBOX_RPC_URL: "http://127.0.0.1:8546" }).rpcUrl).toBe(MAINNET.rpcUrl);
    expect(networkFromEnv({ FEAST_NETWORK: "sandbox", FEAST_MAINNET_RPC_URL: "https://example.invalid/key" }).rpcUrl).toBe(SANDBOX.rpcUrl);
  });
  it("refuses a network it does not know", () => {
    expect(() => networkFromEnv({ FEAST_NETWORK: "testnet" })).toThrow(/sandbox" or "mainnet/);
  });
});

describe("the address books", () => {
  it("are well-formed addresses on both networks", () => {
    for (const network of [SANDBOX, MAINNET]) {
      for (const address of Object.values(network.contracts)) expect(getAddress(address)).toBeTruthy();
      for (const stock of network.stocks) {
        expect(getAddress(stock.address)).toBeTruthy();
        // Every buy route ends in the stock itself; every sale route ends in wrapped native.
        expect(stock.buy.at(-1)?.tokenOut.toLowerCase()).toBe(stock.address.toLowerCase());
        expect(stock.sell.at(-1)?.tokenOut.toLowerCase()).toBe(network.contracts.wrappedNative.toLowerCase());
      }
    }
  });
  it("keeps the sandbox off chain 56 and the mainnet on it", () => {
    expect(chainOf(SANDBOX).id).toBe(56096);
    expect(chainOf(MAINNET).id).toBe(56);
    expect(SANDBOX.realMoney).toBe(false);
    expect(MAINNET.trade.kind).toBe("infinity");
    expect(SANDBOX.trade.kind).toBe("sandbox");
  });
  it("pairs the same bStock contracts on both chains, because the sandbox is a fork", () => {
    const aaplSandbox = SANDBOX.stocks.find((s) => s.symbol === "AAPLB");
    const aaplMainnet = MAINNET.stocks.find((s) => s.symbol === "AAPLB");
    expect(aaplSandbox?.address).toBe(aaplMainnet?.address);
  });
});
