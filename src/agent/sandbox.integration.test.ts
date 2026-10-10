import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { generatePrivateKey } from "viem/accounts";

import { contextFromEnv } from "./commands.ts";
import { runDemo } from "./demo.ts";

/**
 * The whole loop against the public sandbox: faucet → launch → buy → sell → split.
 * Skipped unless FEAST_AGENT_SANDBOX=1; uses FEAST_AGENT_PRIVATE_KEY when set,
 * otherwise a key made in memory for this run and funded by the faucet.
 */
const live = process.env.FEAST_AGENT_SANDBOX === "1";

describe.skipIf(!live)("sandbox, live", () => {
  it(
    "launches a stock-paired coin, trades it both ways, and reads a split that sums to what accrued",
    async () => {
      const env: Record<string, string | undefined> = { ...process.env, FEAST_NETWORK: "sandbox" };
      if (!env.FEAST_AGENT_PRIVATE_KEY) env.FEAST_AGENT_PRIVATE_KEY = generatePrivateKey();
      const ctx = contextFromEnv(env);
      const outDir = mkdtempSync(join(tmpdir(), "feast-agent-demo-"));
      const result = await runDemo(ctx, { stock: "AAPLB", outDir, echo: () => {} });

      expect(result.failedAt).toBeNull();
      expect(result.launch?.predicted).toBe(result.coin);
      expect(result.launch?.onChain.symbol).toBe(result.launch?.params.symbol);
      expect(result.buy?.amountOut).toBeGreaterThan(0n);
      expect(result.sell?.amountOut).toBeGreaterThan(0n);
      expect(result.split?.sumMatches).toBe(true);
      expect(result.split?.accrued).toBe((result.buy?.fee ?? 0n) + (result.sell?.fee ?? 0n));
      expect(readFileSync(result.transcriptPath, "utf8")).toContain(result.coin ?? "missing");
    },
    180_000,
  );
});
