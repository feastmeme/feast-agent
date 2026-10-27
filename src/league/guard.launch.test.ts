import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { guard, type BookView, type GuardInput, type Intent } from "./guard.ts";
import { DEFAULT_LIMITS, bnbToWei } from "./limits.ts";

/** Run 26 (item 3, the v5.1.4 review): launches against L3. Made-up values; guard.test.ts is left as it is. */

const NOW = 1_800_000_000_000;
const view = (atWork: number): BookView => ({ openPositions: 1, hasPosition: false, exposureWei: bnbToWei(atWork), spent24hWei: 0n, realizedLoss24hWei: 0n, lastEntryAt: null, paused: null, drawdownWei: 0n });
const launch: Intent = { id: "l1", kind: "launch", launch: { name: "maplegrin.ai", symbol: "MAPLE", quote: "WBNB" }, reason: "t", source: "preset", createdAt: NOW } as Intent;
const input = (atWork: number, over: Partial<GuardInput> = {}): GuardInput => ({ intent: launch, limits: DEFAULT_LIMITS, now: NOW, wallet: { connected: true, devMode: true, quotaLeftUsd: 1_000, balanceWei: bnbToWei(1) }, bnbUsd: 600, stopped: false, coinIsFeast: true, book: view(atWork), othersAtWorkWei: 0n, warmup: null, ...over });

describe("a launch and the cap on BNB at work (L3)", () => {
  it("the SDK's launch request sends no BNB (value 0n)", () => {
    const sdk = readFileSync(join(import.meta.dirname, "..", "sdk", "client.ts"), "utf8");
    expect(sdk).toContain("request: { to: this.network.contracts.factory, data, value: 0n }");
  });

  it("a launch that sends nothing passes whatever is at work; one that sends BNB must fit the cap, the wallet's other agents counted", () => {
    expect(guard(input(0.149)).ok).toBe(true);
    expect(guard(input(0.149, { launchValueWei: 0n })).ok).toBe(true);
    expect(guard(input(0.1, { launchValueWei: bnbToWei(0.02) }))).toMatchObject({ ok: true, sizeWei: bnbToWei(0.02) });
    const over = guard(input(0.14, { launchValueWei: bnbToWei(0.02) }));
    expect(over).toMatchObject({ ok: false, limit: "L3" });
    expect(guard(input(0.1, { launchValueWei: bnbToWei(0.02), othersAtWorkWei: bnbToWei(0.04) }))).toMatchObject({ ok: false, limit: "L3" });
  });
});
