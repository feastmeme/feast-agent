#!/usr/bin/env node
import { existsSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Address } from "viem";
import { z } from "zod";

import {
  buyCommand,
  contextFromEnv,
  launchCommand,
  payoutsCommand,
  quoteCommand,
  quotesCommand,
  renderLaunch,
  renderQuote,
  renderSplit,
  renderTrade,
  sayError,
  sellCommand,
  splitCommand,
  walletCommand,
  type AgentContext,
} from "./commands.ts";
import { json } from "./format.ts";

/**
 * The agent's verbs as MCP tools over stdio, so a Claude or Codex session can
 * launch, trade and read Feast coins. Same functions as the CLI, same rules:
 * transactions are sent on the sandbox only, with the key in
 * FEAST_AGENT_PRIVATE_KEY; mainnet answers reads and refuses writes.
 *
 *   claude mcp add feast-agent -- npx tsx /path/to/feast-agent/src/agent/mcp.ts
 */

if (existsSync(".env")) process.loadEnvFile(".env");

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "a 0x-prefixed 20-byte address");

/** Each tool answers with a readable summary and the full data as JSON (bigints as strings). */
function answer(summary: string, data: unknown) {
  return { content: [{ type: "text" as const, text: `${summary}\n\n${json(data)}` }] };
}

export function buildServer(ctx: AgentContext): McpServer {
  const guarded = async (run: () => Promise<{ content: Array<{ type: "text"; text: string }> }>) => {
    try {
      return await run();
    } catch (error) {
      return { isError: true, content: [{ type: "text" as const, text: sayError(ctx, error) }] };
    }
  };
  const server = new McpServer({ name: "feast-agent", version: "0.1.0" });
  const network = ctx.feast.network;
  const native = network.nativeSymbol;

  server.registerTool(
    "feast_quotes",
    { title: "Pairable quotes", description: `The tokens a Feast coin can be paired with on ${network.chainName}: tokenized stocks (bStocks) and WBNB.` },
    () => guarded(async () => {
      const view = await quotesCommand(ctx);
      return answer(view.quotes.map((q) => `${q.symbol} ${q.address}`).join("\n"), view);
    }),
  );

  server.registerTool(
    "feast_quote",
    {
      title: "Price a coin or a stock token",
      description:
        "Price a Feast coin (by address) or a bStock (by ticker such as AAPLB) in the stock and in USD, with the Binance Web3 API's RWA reference price and the gap.",
      inputSchema: { target: z.string().describe("a coin address, or a stock ticker such as AAPLB") },
    },
    ({ target }) => guarded(async () => {
      const view = await quoteCommand(ctx, target);
      return answer(renderQuote(view), view);
    }),
  );

  server.registerTool(
    "feast_launch",
    {
      title: "Launch a coin",
      description: "Launch a Feast coin paired with a stock token (sandbox only). dryRun prepares the calldata without sending.",
      inputSchema: {
        name: z.string().max(32),
        symbol: z.string().regex(/^[A-Za-z0-9]{1,10}$/),
        quote: z.string().default("AAPLB").describe("a stock ticker (AAPLB, NVDAB, …), WBNB, or a quote address"),
        burn: z.number().int().min(0).max(30).default(10).describe("points of the 1% fee bought back and burned"),
        referrer: z.number().int().min(0).max(30).default(10).describe("points of the 1% fee paid to referrers"),
        description: z.string().max(500).optional(),
        dryRun: z.boolean().default(false),
      },
    },
    (input) => guarded(async () => {
      const result = await launchCommand(ctx, input);
      return answer(renderLaunch(result), result);
    }),
  );

  server.registerTool(
    "feast_buy",
    {
      title: "Buy a coin",
      description: `Buy a Feast coin with ${native} through the Feast router (sandbox only).`,
      inputSchema: {
        coin: address,
        amount: z.string().describe(`how much ${native} to spend, e.g. "0.01"`),
        slippageBps: z.number().int().min(0).max(5000).default(100),
        referrer: address.optional(),
      },
    },
    ({ coin, amount, slippageBps, referrer }) => guarded(async () => {
      // The quote's name is read BEFORE the trade: a read failing after a mined trade must not hide its hash.
      const quote = (await ctx.feast.coin(coin)).quote.symbol;
      const result = await buyCommand(ctx, coin, amount, { slippageBps, referrer: referrer as Address | undefined });
      return answer(renderTrade(result, native, quote), result);
    }),
  );

  server.registerTool(
    "feast_sell",
    {
      title: "Sell a coin",
      description: "Sell a Feast coin for the chain's native coin with one permit signature (sandbox only).",
      inputSchema: {
        coin: address,
        amount: z.string().describe('whole coins, a percentage such as "50%", or "all"'),
        slippageBps: z.number().int().min(0).max(5000).default(100),
      },
    },
    ({ coin, amount, slippageBps }) => guarded(async () => {
      const quote = (await ctx.feast.coin(coin)).quote.symbol;
      const result = await sellCommand(ctx, coin, amount, { slippageBps });
      return answer(renderTrade(result, native, quote), result);
    }),
  );

  server.registerTool(
    "feast_split",
    {
      title: "Fee split",
      description: "The four-seat split of a coin's 1% trading fee (creator, burn, referrer, platform) and its totals, read from the Feast hook.",
      inputSchema: { coin: address },
    },
    ({ coin }) => guarded(async () => {
      const view = await splitCommand(ctx, coin);
      return answer(renderSplit(view), view);
    }),
  );

  server.registerTool(
    "feast_payouts",
    {
      title: "Payouts",
      description: "Settled fee payouts for a coin, newest first, from the Feast public read API.",
      inputSchema: { coin: address, limit: z.number().int().min(1).max(50).default(20) },
    },
    ({ coin, limit }) => guarded(async () => {
      const page = await payoutsCommand(ctx, coin, limit);
      return answer(`${page.payouts.length} payouts (index ${page.asOf.blocksBehind} blocks behind)`, page);
    }),
  );

  server.registerTool(
    "feast_wallet",
    { title: "Agent wallet", description: "The agent's address and native balance." },
    () => guarded(async () => {
      const view = await walletCommand(ctx);
      return answer(`${view.address}: ${view.balance} wei of ${view.nativeSymbol}`, view);
    }),
  );

  return server;
}

// Run as a stdio server when executed directly (not when imported by a test).
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("mcp.ts")) {
  const server = buildServer(contextFromEnv(process.env));
  await server.connect(new StdioServerTransport());
}
