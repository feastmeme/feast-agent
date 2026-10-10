#!/usr/bin/env node
import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import { BaseError, type Address } from "viem";

import { BinanceApiError, BinanceNotConfigured } from "../binance/index.ts";
import { FeastError } from "../sdk/index.ts";
import {
  buyCommand,
  contextFromEnv,
  faucetCommand,
  launchCommand,
  payoutsCommand,
  quoteCommand,
  quotesCommand,
  renderLaunch,
  renderPayouts,
  renderQuote,
  renderQuotes,
  renderSplit,
  renderTrade,
  sellCommand,
  splitCommand,
  walletCommand,
} from "./commands.ts";
import { runDemo } from "./demo.ts";
import { binanceCheck } from "./binance-check.ts";
import { amount, json } from "./format.ts";

const HELP = `feast-agent — launch, trade and read Feast coins paired with tokenized stocks

Usage: feast-agent <command> [arguments] [--network sandbox|mainnet] [--json]

  quotes                              the tokens a coin can be paired with (FeastPricer.quotes)
  quote <coin-address | AAPLB>        price in stock units and USD, with Binance's RWA reference price and the gap
  launch --name <n> --symbol <s> --quote <AAPLB|WBNB|0x…> [--burn 10] [--referrer 10]
         [--description <d>] [--dry-run]
  buy <coin> <amount in BNB> [--slippage-bps 100] [--ref <address>]
  sell <coin> <coins | 50% | all> [--slippage-bps 100] [--ref <address>]
  split <coin>                        the four-seat fee split and its totals, from the hook
  payouts <coin> [--limit 20]         settled fee payouts, from the Feast read API
  wallet                              the agent's address and balance
  faucet                              100 test BNB on the sandbox (creates a throwaway key in .env if none)
  demo [--stock AAPLB]                faucet → launch → buy → sell → split, transcript saved to demo/
  binance-check [--record]            one call to each RWA Data endpoint with the configured credentials

Environment: FEAST_NETWORK, FEAST_RPC_URL, FEAST_AGENT_PRIVATE_KEY,
             BINANCE_WEB3_API_KEY, BINANCE_WEB3_API_SECRET (see .env.example).
Mainnet is read-only in this release: launch --dry-run, quote, split and payouts work; nothing is sent.`;

async function main(argv: string[]): Promise<number> {
  // `.env` in the working directory, if there is one; real environment variables win.
  if (existsSync(".env")) process.loadEnvFile(".env");

  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      network: { type: "string" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
      name: { type: "string" },
      symbol: { type: "string" },
      quote: { type: "string" },
      burn: { type: "string" },
      referrer: { type: "string" },
      description: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      "slippage-bps": { type: "string" },
      ref: { type: "string" },
      limit: { type: "string" },
      stock: { type: "string" },
      record: { type: "boolean", default: false },
      out: { type: "string" },
    },
  });
  const [command, ...args] = positionals;
  if (!command || values.help || command === "help") {
    console.log(HELP);
    return command || values.help ? 0 : 1;
  }

  const ctx = contextFromEnv(process.env, { network: values.network });
  const print = (data: unknown, human: () => string) => console.log(values.json ? json(data) : human());
  const need = (value: string | undefined, what: string): string => {
    if (!value) throw new FeastError(`missing ${what}; see feast-agent --help`, "usage");
    return value;
  };
  const tradeOptions = {
    slippageBps: values["slippage-bps"] === undefined ? undefined : Number(values["slippage-bps"]),
    referrer: values.ref as Address | undefined,
  };
  const native = ctx.feast.network.nativeSymbol;

  switch (command) {
    case "quotes": {
      const view = await quotesCommand(ctx);
      print(view, () => `pairable quotes on ${view.network} (chain ${view.chainId}):\n${renderQuotes(view)}`);
      return 0;
    }
    case "quote": {
      const view = await quoteCommand(ctx, need(args[0], "a coin address or a stock ticker"));
      print(view, () => renderQuote(view));
      return 0;
    }
    case "launch": {
      const result = await launchCommand(ctx, {
        name: values.name ?? need(values.symbol, "--symbol"),
        symbol: need(values.symbol, "--symbol"),
        quote: values.quote ?? "AAPLB",
        burn: values.burn === undefined ? undefined : Number(values.burn),
        referrer: values.referrer === undefined ? undefined : Number(values.referrer),
        description: values.description,
        dryRun: values["dry-run"],
      });
      print(result, () => renderLaunch(result));
      return 0;
    }
    case "buy": {
      const coin = need(args[0], "a coin address");
      const result = await buyCommand(ctx, coin, need(args[1], "an amount of BNB"), tradeOptions);
      const quote = (await ctx.feast.coin(coin)).quote.symbol;
      print(result, () => renderTrade(result, native, quote));
      return 0;
    }
    case "sell": {
      const coin = need(args[0], "a coin address");
      const result = await sellCommand(ctx, coin, need(args[1], "an amount (coins, 50% or all)"), tradeOptions);
      const quote = (await ctx.feast.coin(coin)).quote.symbol;
      print(result, () => renderTrade(result, native, quote));
      return 0;
    }
    case "split": {
      const view = await splitCommand(ctx, need(args[0], "a coin address"));
      print(view, () => `fee split of ${view.coin} on ${view.network} (pool ${view.poolId})\n\n${renderSplit(view)}`);
      return 0;
    }
    case "payouts": {
      const page = await payoutsCommand(ctx, need(args[0], "a coin address"), values.limit ? Number(values.limit) : 20);
      print(page, () => renderPayouts(page));
      return 0;
    }
    case "wallet": {
      const view = await walletCommand(ctx);
      print(view, () => `${view.address} on ${view.network} (chain ${view.chainId}): ${amount(view.balance)} ${view.nativeSymbol}`);
      return 0;
    }
    case "faucet": {
      const drip = await faucetCommand(ctx);
      print(drip, () =>
        [
          drip.keyCreated ? `created a throwaway sandbox wallet ${drip.address}; its key is in .env (git-ignored) and was not printed` : `wallet ${drip.address}`,
          `faucet: +${amount(drip.added)} ${native}, balance ${amount(drip.balance)} ${native}`,
        ].join("\n"),
      );
      return 0;
    }
    case "demo": {
      const result = await runDemo(ctx, { stock: values.stock ?? "AAPLB", outDir: values.out ?? "demo" });
      if (values.json) console.log(json(result));
      return 0;
    }
    case "binance-check": {
      const report = await binanceCheck(ctx, { record: values.record });
      print(report, () => report.lines.join("\n"));
      return report.ok ? 0 : 2;
    }
    default:
      console.error(`unknown command "${command}"\n\n${HELP}`);
      return 1;
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    if (error instanceof FeastError || error instanceof BinanceNotConfigured || error instanceof BinanceApiError) {
      console.error(`feast-agent: ${error.message}`);
    } else if (error instanceof BaseError) {
      console.error(`feast-agent: ${error.shortMessage}`);
    } else {
      console.error(error);
    }
    process.exit(1);
  },
);
