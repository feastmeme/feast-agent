import { createPublicClient, HttpRequestError, TimeoutError } from "viem";
import { bsc } from "viem/chains";
import { describe, expect, it } from "vitest";

import { FALLBACK_RPCS, fallbackRpc, RPC_COOLDOWN_MS, rpcEndpoints, transportFailure } from "./rpc.ts";

/**
 * Task 975, addendum 8 (gap G5): the chain's RPC with a fallback, on fake endpoints (no network): the primary first,
 * the next on a transport failure, 60 s of rest for an endpoint that failed, an answer from the node never failed over.
 */

const PRIMARY = "https://rpc.example/with-a-key";
const blockAnswer = (n: number) => `0x${n.toString(16)}`;

function endpoints(behaviour: Record<string, (method: string) => unknown>) {
  const asked: string[] = [];
  const make = (url: string) => async ({ method }: { method: string }) => {
    asked.push(url);
    const out = behaviour[url]?.(method);
    if (out instanceof Error) throw out;
    return out;
  };
  return { asked, make };
}
const down = (url: string) => new HttpRequestError({ url, status: 503, details: "Service Unavailable" });

describe("the endpoints", () => {
  it("the primary first, then the Binance dataseeds, publicnode last; none behind a local primary or with the switch off", () => {
    expect(rpcEndpoints(PRIMARY, {})).toEqual([PRIMARY, ...FALLBACK_RPCS]);
    expect(rpcEndpoints("https://bsc-dataseed1.binance.org/", {})).toEqual(["https://bsc-dataseed1.binance.org/", "https://bsc-dataseed2.binance.org", "https://bsc-rpc.publicnode.com"]);
    expect(rpcEndpoints("http://127.0.0.1:8545", {})).toEqual(["http://127.0.0.1:8545"]);
    expect(rpcEndpoints("http://localhost:8545", {})).toEqual(["http://localhost:8545"]);
    expect(rpcEndpoints(PRIMARY, { FEAST_MAINNET_RPC_FALLBACK: "off" })).toEqual([PRIMARY]);
  });

  it("a transport failure is told from the node's answer", () => {
    expect(transportFailure(down(PRIMARY))).toBe(true);
    expect(transportFailure(new TimeoutError({ body: {}, url: PRIMARY }))).toBe(true);
    expect(transportFailure({ code: -32005, message: "limit exceeded" })).toBe(true);
    expect(transportFailure({ code: 3, message: "execution reverted" })).toBe(false);
    expect(transportFailure({ code: -32602, message: "invalid params" })).toBe(false);
  });
});

describe("the fallback", () => {
  it("the primary down: the next answers, the switch is told by label (never the primary's URL); 60 s later the primary is tried again", async () => {
    let t = 0;
    let primaryUp = false;
    const e = endpoints({ [PRIMARY]: () => (primaryUp ? blockAnswer(7) : down(PRIMARY)), [FALLBACK_RPCS[0]]: () => blockAnswer(6) });
    const switches: unknown[] = [];
    const rpc = fallbackRpc(rpcEndpoints(PRIMARY, {}), { now: () => t, make: e.make, onSwitch: (c) => switches.push(c) });
    const client = createPublicClient({ chain: bsc, transport: rpc.transport });
    expect(await client.getBlockNumber({ cacheTime: 0 })).toBe(6n);
    expect(rpc.state()).toEqual({ endpoint: "bsc-dataseed1.binance.org", onFallback: true, resting: 1 });
    expect(JSON.stringify(switches)).not.toContain("with-a-key");
    expect(switches[0]).toMatchObject({ from: "primary", to: "bsc-dataseed1.binance.org" });
    // Resting: the primary is not asked again within the minute.
    e.asked.length = 0;
    t += RPC_COOLDOWN_MS - 1;
    primaryUp = true;
    expect(await client.getBlockNumber({ cacheTime: 0 })).toBe(6n);
    expect(e.asked).toEqual([FALLBACK_RPCS[0]]);
    // After it, the primary first again, and back on it.
    t += 2;
    expect(await client.getBlockNumber({ cacheTime: 0 })).toBe(7n);
    expect(rpc.state()).toMatchObject({ endpoint: "primary", onFallback: false, resting: 0 });
    expect(switches.at(-1)).toMatchObject({ from: "bsc-dataseed1.binance.org", to: "primary", reason: "back" });
  });

  it("the node's own answer (a revert) is the answer: no other endpoint is asked", async () => {
    const reverted = Object.assign(new Error("execution reverted"), { code: 3 });
    const e = endpoints({ [PRIMARY]: () => reverted, [FALLBACK_RPCS[0]]: () => "0x1" });
    const rpc = fallbackRpc(rpcEndpoints(PRIMARY, {}), { now: () => 0, make: e.make });
    await expect(rpc.request({ method: "eth_call" })).rejects.toThrow("execution reverted");
    expect(e.asked).toEqual([PRIMARY]);
  });

  it("every endpoint down: each is asked once, the last failure comes back; all resting, all are tried again", async () => {
    const urls = rpcEndpoints(PRIMARY, {});
    const e = endpoints(Object.fromEntries(urls.map((u) => [u, () => down(u)])));
    const rpc = fallbackRpc(urls, { now: () => 0, make: e.make });
    await expect(rpc.request({ method: "eth_blockNumber" })).rejects.toBeInstanceOf(HttpRequestError);
    expect(e.asked).toEqual(urls);
    e.asked.length = 0;
    await expect(rpc.request({ method: "eth_blockNumber" })).rejects.toBeInstanceOf(HttpRequestError);
    expect(e.asked).toEqual(urls);
  });
});
