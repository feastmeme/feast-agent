import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";

import { contextFromEnv, ensureSandboxKey } from "./commands.ts";

const tmpEnv = () => join(mkdtempSync(join(tmpdir(), "feast-agent-")), ".env");

describe("ensureSandboxKey", () => {
  it("creates a throwaway key in .env (mode 600) and returns only the address", () => {
    const path = tmpEnv();
    writeFileSync(path, "FEAST_NETWORK=sandbox\nFEAST_AGENT_PRIVATE_KEY=\nBINANCE_WEB3_API_KEY=\n");
    const ctx = contextFromEnv({ FEAST_NETWORK: "sandbox" });
    const made = ensureSandboxKey(ctx, path);
    expect(made.created).toBe(true);
    const text = readFileSync(path, "utf8");
    const key = text.match(/^FEAST_AGENT_PRIVATE_KEY=(0x[0-9a-f]{64})$/m)?.[1];
    expect(key).toBeDefined();
    expect(privateKeyToAccount(key as `0x${string}`).address).toBe(made.address);
    // The other lines are kept, and the file is readable by its owner only.
    expect(text).toMatch(/^FEAST_NETWORK=sandbox$/m);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(ctx.feast.account?.address).toBe(made.address);
  });
  it("never overwrites a key that is already there", () => {
    const path = tmpEnv();
    writeFileSync(path, `FEAST_AGENT_PRIVATE_KEY=0x${"11".repeat(32)}\n`);
    expect(() => ensureSandboxKey(contextFromEnv({}), path)).toThrow(/already holds/);
  });
  it("uses the key in the environment rather than making one", () => {
    const key = `0x${"22".repeat(32)}` as const;
    const ctx = contextFromEnv({ FEAST_AGENT_PRIVATE_KEY: key });
    expect(ensureSandboxKey(ctx, tmpEnv())).toEqual({ address: privateKeyToAccount(key).address, created: false });
  });
  it("refuses to make a key for mainnet", () => {
    expect(() => ensureSandboxKey(contextFromEnv({ FEAST_NETWORK: "mainnet" }), tmpEnv())).toThrow(/real-money/);
  });
});

describe("contextFromEnv", () => {
  it("refuses a malformed key without echoing it", () => {
    let message = "";
    try {
      contextFromEnv({ FEAST_AGENT_PRIVATE_KEY: "0xnot-a-key-1234" });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/64 hex characters/);
    expect(message).not.toContain("not-a-key-1234");
  });
  it("has no Binance credentials unless both variables are set", () => {
    expect(contextFromEnv({ BINANCE_WEB3_API_KEY: "k" }).binance.configured).toBe(false);
    expect(contextFromEnv({ BINANCE_WEB3_API_KEY: "k", BINANCE_WEB3_API_SECRET: "s" }).binance.configured).toBe(true);
  });
});
