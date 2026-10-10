import { existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { isAddress, parseEther, parseUnits, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { BinanceWeb3Client, skillRwaDynamic, stockReference, type SkillRwaDynamic, type StockReference } from "../binance/index.ts";
import {
  FeastClient,
  FeastError,
  networkFromEnv,
  type FeeSplit,
  type LaunchOptions,
  type LaunchResult,
  type PayoutsPage,
  type PreparedLaunch,
  type QuoteAsset,
  type Seat,
  type StockQuote,
  type TradeResult,
} from "../sdk/index.ts";
import { gap } from "../sdk/price.ts";
import { SEATS } from "../sdk/split.ts";
import { amount, pct, sig, table, usd } from "./format.ts";

/**
 * The agent's verbs, as functions that return data. The CLI prints them, the MCP
 * server hands them to a model, and the demo strings them together — one
 * implementation, three surfaces.
 */

export type Env = Record<string, string | undefined>;

export type AgentContext = {
  feast: FeastClient;
  binance: BinanceWeb3Client;
  env: Env;
};

export function contextFromEnv(env: Env = process.env, overrides: { network?: string } = {}): AgentContext {
  const network = networkFromEnv({ ...env, ...(overrides.network ? { FEAST_NETWORK: overrides.network } : {}) });
  const key = env.FEAST_AGENT_PRIVATE_KEY?.trim();
  if (key && !/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new FeastError("FEAST_AGENT_PRIVATE_KEY must be 0x followed by 64 hex characters", "bad_key");
  }
  const account = key ? privateKeyToAccount(key as Hex) : undefined;
  return { feast: new FeastClient({ network, account }), binance: BinanceWeb3Client.fromEnv(env), env };
}

// --- wallet & faucet ----------------------------------------------------------------

/**
 * A throwaway sandbox key, written into `.env` (git-ignored) and never printed.
 * Refuses on mainnet, and refuses to overwrite a key that is already there.
 */
export function ensureSandboxKey(ctx: AgentContext, envPath = ".env"): { address: Address; created: boolean } {
  if (ctx.feast.network.realMoney) {
    throw new FeastError("refusing to create a key for a real-money network; bring your own wallet", "mainnet_key");
  }
  if (ctx.feast.account) return { address: ctx.feast.account.address, created: false };
  const key = generatePrivateKey();
  const line = `FEAST_AGENT_PRIVATE_KEY=${key}`;
  const existing = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
  if (/^FEAST_AGENT_PRIVATE_KEY=\S+/m.test(existing)) {
    throw new FeastError(`${envPath} already holds FEAST_AGENT_PRIVATE_KEY; load it instead of creating another`, "key_exists");
  }
  const next = /^FEAST_AGENT_PRIVATE_KEY=\s*$/m.test(existing)
    ? existing.replace(/^FEAST_AGENT_PRIVATE_KEY=\s*$/m, line)
    : `${existing}${existing && !existing.endsWith("\n") ? "\n" : ""}${line}\n`;
  writeFileSync(envPath, next, { mode: 0o600 });
  chmodSync(envPath, 0o600);
  ctx.env.FEAST_AGENT_PRIVATE_KEY = key;
  const account = privateKeyToAccount(key);
  ctx.feast = new FeastClient({ network: ctx.feast.network, account });
  return { address: account.address, created: true };
}

export async function walletCommand(ctx: AgentContext) {
  const account = ctx.feast.account;
  if (!account) throw new FeastError("no wallet: set FEAST_AGENT_PRIVATE_KEY, or run `feast-agent faucet` on the sandbox to create one", "no_account");
  const balance = await ctx.feast.nativeBalance();
  return { network: ctx.feast.network.name, chainId: ctx.feast.network.chainId, address: account.address, balance, nativeSymbol: ctx.feast.network.nativeSymbol };
}

export async function faucetCommand(ctx: AgentContext) {
  const key = ensureSandboxKey(ctx);
  const drip = await ctx.feast.faucet(key.address);
  return { ...drip, keyCreated: key.created };
}

// --- quotes & quote ------------------------------------------------------------------

export async function quotesCommand(ctx: AgentContext) {
  const quotes = await ctx.feast.quotes();
  return { network: ctx.feast.network.name, chainId: ctx.feast.network.chainId, quotes };
}

export function renderQuotes(view: Awaited<ReturnType<typeof quotesCommand>>): string {
  return table(
    ["Quote", "Tracks", "Address"],
    view.quotes.map((q: QuoteAsset) => [q.symbol, q.stock ? `${q.stock.underlying} (${q.stock.name})` : q.isStock ? "?" : "BNB", q.address]),
  );
}

export type QuoteView = {
  network: string;
  chainId: number;
  coin: null | {
    address: Address;
    name: string;
    symbol: string;
    supply: bigint;
    /** Quote tokens per coin. */
    priceInQuote: number;
    quoteSymbol: string;
  };
  stock: StockQuote | null;
  /** The paired token's USD price from its PancakeSwap v3 pool (on-chain, no API). */
  dex: { usd: number; via: Address[] } | null;
  /** What the Binance Web3 API's RWA Data endpoints say about the paired token. */
  binance: StockReference | null;
  /** The keyless Binance Wallet Skill's answer, asked only when the API is not configured. */
  skill: SkillRwaDynamic | null;
  /** The coin's USD price, and which price of the paired token it used. */
  coinUsd: number | null;
  coinUsdSource: "binance-rwa" | "binance-skill" | "dex" | null;
  marketCapUsd: number | null;
  /** Binance's on-chain token price vs the same token's pool price on this chain. */
  dexVsBinance: number | null;
};

/** Price a coin (by address) or a stock token (by ticker) in stock units and USD. */
export async function quoteCommand(ctx: AgentContext, target: string): Promise<QuoteView> {
  const { feast } = ctx;
  const base = { network: feast.network.name, chainId: feast.network.chainId };
  let coin: QuoteView["coin"] = null;
  let quote: QuoteAsset;
  if (isAddress(target)) {
    const state = await feast.coin(target);
    coin = { address: state.address, name: state.name, symbol: state.symbol, supply: state.supply, priceInQuote: state.price, quoteSymbol: state.quote.symbol };
    quote = state.quote;
  } else {
    quote = feast.quoteAsset(target);
  }

  const stock = quote.stock;
  let dex: QuoteView["dex"] = null;
  let binance: StockReference | null = null;
  let skill: SkillRwaDynamic | null = null;
  if (stock) {
    // The sandbox forks BNB Smart Chain, so its bStock contracts ARE the chain-56 ones and Binance prices them there.
    [dex, binance] = await Promise.all([feast.stockUsdPrice(stock).catch(() => null), stockReference(ctx.binance, stock.address)]);
    if (binance.state !== "ok" && ctx.env.FEAST_AGENT_NO_SKILL !== "1") {
      skill = await skillRwaDynamic(stock.address).catch(() => null);
    }
  } else {
    const bnb = await feast.bnbUsdPrice().catch(() => null);
    dex = bnb === null ? null : { usd: bnb, via: [feast.network.contracts.usdtNativePool] };
  }

  const binanceUsd = binance?.state === "ok" ? binance.tokenPriceUsd : null;
  const skillUsd = skill?.tokenPriceUsd ?? null;
  const quoteUsd = binanceUsd ?? skillUsd ?? dex?.usd ?? null;
  const coinUsd = coin && quoteUsd !== null ? coin.priceInQuote * quoteUsd : null;
  return {
    ...base,
    coin,
    stock,
    dex,
    binance,
    skill,
    coinUsd,
    coinUsdSource: binanceUsd !== null ? "binance-rwa" : skillUsd !== null ? "binance-skill" : dex ? "dex" : null,
    marketCapUsd: coin && coinUsd !== null ? Number(coin.supply / 10n ** 18n) * coinUsd : null,
    dexVsBinance: (binanceUsd ?? skillUsd) !== null && dex ? gap(dex.usd, (binanceUsd ?? skillUsd) as number) : null,
  };
}

export function renderQuote(view: QuoteView): string {
  const lines: string[] = [];
  const quoteName = view.stock ? `${view.stock.symbol} (${view.stock.underlying}, ${view.stock.name})` : "WBNB";
  if (view.coin) {
    lines.push(`${view.coin.name} ($${view.coin.symbol}) ${view.coin.address} on ${view.network}, paired with ${quoteName}`);
    lines.push(`  coin price:        ${sig(view.coin.priceInQuote, 4)} ${view.coin.quoteSymbol} per coin (pool spot)`);
    lines.push(`  coin price (USD):  ${usd(view.coinUsd)}  via ${view.coinUsdSource ?? "n/a"}`);
    lines.push(`  market cap (USD):  ${usd(view.marketCapUsd, 6)}  (${amount(view.coin.supply)} coins)`);
  } else {
    lines.push(`${quoteName} on ${view.network}`);
  }
  if (view.stock) {
    lines.push(`  ${view.stock.symbol} on-chain (PancakeSwap v3 pool): ${view.dex ? usd(view.dex.usd, 6) : "n/a"}`);
    const b = view.binance;
    if (!b || b.state !== "ok") {
      lines.push(
        !b || b.state === "not_configured"
          ? `  ${b?.message ?? "Binance Web3 API not configured."}`
          : `  Binance Web3 API (RWA Data) unavailable: ${b.message}`,
      );
      const k = view.skill;
      if (k) {
        lines.push(`  Binance Wallet Skill (keyless, binance-tokenized-securities-info):`);
        lines.push(`    ${k.symbol} token price:   ${usd(k.tokenPriceUsd, 6)} (${k.sharesMultiplier === null ? "?" : sig(k.sharesMultiplier, 7)} ${k.ticker} shares per token → ${usd(k.impliedSharePriceUsd, 6)} a share)`);
        lines.push(`    ${k.ticker} share price:    ${k.stockPriceUsd === null ? "not published right now (null outside US trading hours)" : usd(k.stockPriceUsd, 6)}`);
        lines.push(`    gap, token vs share:  ${k.gap === null ? "n/a until a share price is published" : pct(k.gap, 3)}`);
        lines.push(`    gap, pool vs Binance: ${pct(view.dexVsBinance, 3)}`);
      }
    } else {
      lines.push(`  Binance RWA token price:         ${usd(b.tokenPriceUsd, 6)} (${b.platformId}, updated ${new Date(b.tokenPriceUpdatedAt).toISOString()})`);
      lines.push(`  Binance RWA reference (${view.stock.underlying} share): ${usd(b.referencePriceUsd, 6)}${b.underlyingReferenceUsd !== null ? ` (underlying-market: ${usd(b.underlyingReferenceUsd, 6)})` : ""}`);
      lines.push(`  gap, token vs reference:         ${pct(b.gap, 3)}`);
      lines.push(`  gap, pool vs Binance token price: ${pct(view.dexVsBinance, 3)}`);
      lines.push(`  ${view.stock.underlying} market: ${b.marketStatus ?? "n/a"}${b.marketOpen === null ? "" : b.marketOpen ? " (open)" : " (closed)"}`);
    }
  } else if (view.dex) {
    lines.push(`  BNB (USDT/WBNB pool): ${usd(view.dex.usd, 6)}`);
  }
  if (view.stock && view.network === "sandbox" && view.dexVsBinance !== null) {
    lines.push(`  (the sandbox's pools are a fork of BSC that moves only with sandbox trades, so its pool price drifts from the live one Binance reports)`);
  }
  return lines.join("\n");
}

// --- launch ----------------------------------------------------------------------------

export async function launchCommand(ctx: AgentContext, options: LaunchOptions & { dryRun?: boolean }): Promise<PreparedLaunch | LaunchResult> {
  if (options.dryRun) {
    const creator = ctx.feast.account?.address ?? ("0x000000000000000000000000000000000000fea5" as Address);
    return ctx.feast.prepareLaunch({ ...options, metadataHash: options.metadataHash ?? (`0x${"00".repeat(32)}` as Hex) }, creator);
  }
  return ctx.feast.launch(options);
}

export function renderLaunch(result: PreparedLaunch | LaunchResult): string {
  const p = result.params;
  const lines = [
    `${"txHash" in result ? "launched" : "prepared (not sent)"}: ${p.name} ($${p.symbol}) paired with ${result.quote.symbol}`,
    `  coin:        ${"coin" in result ? result.coin : `${result.predicted} (predicted by the factory)`}`,
  ];
  if ("txHash" in result) {
    lines.push(`  tx:          ${result.txHash} (block ${result.blockNumber}, gas ${result.gasUsed})`);
    lines.push(`  pool id:     ${result.poolId}`);
    lines.push(`  on chain:    name "${result.onChain.name}", symbol "${result.onChain.symbol}"`);
  }
  lines.push(`  split:       creator ${80 - p.selfBurnBps / 100 - p.referrerBps / 100} · burn ${p.selfBurnBps / 100} · referrer ${p.referrerBps / 100} · platform 20 (points of the 1% fee)`);
  lines.push(`  opening:     tick ${p.startTick}, sqrtPriceX96 ${p.sqrtPriceX96}, liquidity ${p.liquidity}`);
  lines.push(`  metadata:    ${result.metadata ? `ipfs://${result.metadata.cid} (picture ipfs://${result.metadata.imageCid})` : `digest ${p.metadataHash}`}`);
  if (!("txHash" in result)) lines.push(`  calldata:    to ${result.request.to}, ${(result.request.data.length - 2) / 2} bytes, selector ${result.request.data.slice(0, 10)}`);
  return lines.join("\n");
}

// --- trade -------------------------------------------------------------------------------

export async function buyCommand(ctx: AgentContext, coin: string, bnb: string, options: { slippageBps?: number; referrer?: Address } = {}) {
  return ctx.feast.buy(coin, parseEther(bnb), options);
}

/** `50%`, `all`, or a number of whole coins. */
export async function resolveSellAmount(ctx: AgentContext, coin: string, spec: string): Promise<bigint> {
  if (!isAddress(coin)) throw new FeastError(`"${coin}" is not an address`, "bad_address");
  const trimmed = spec.trim().toLowerCase();
  if (trimmed === "all" || trimmed.endsWith("%")) {
    const balance = await ctx.feast.coinBalance(coin);
    const percent = trimmed === "all" ? 100 : Number(trimmed.slice(0, -1));
    if (!(percent > 0 && percent <= 100)) throw new FeastError("a percentage is between 0 and 100", "bad_amount");
    return (balance * BigInt(Math.round(percent * 100))) / 10_000n;
  }
  return parseUnits(trimmed, 18);
}

export async function sellCommand(ctx: AgentContext, coin: string, spec: string, options: { slippageBps?: number; referrer?: Address } = {}) {
  const coins = await resolveSellAmount(ctx, coin, spec);
  return ctx.feast.sell(coin, coins, options);
}

export function renderTrade(result: TradeResult, native: string, quoteSymbol: string): string {
  const spent = result.side === "buy" ? `${amount(result.amountIn)} ${native}` : `${amount(result.amountIn)} coins`;
  const got = result.side === "buy" ? `${amount(result.amountOut)} coins` : `${amount(result.amountOut)} ${native}`;
  return [
    `${result.side === "buy" ? "bought" : "sold"}: ${spent} → ${got}`,
    `  tx:        ${result.txHash} (block ${result.blockNumber}, gas ${result.gasUsed})`,
    `  pool leg:  ${amount(result.quoteLeg)} ${quoteSymbol}, hook fee ${amount(result.fee)} ${quoteSymbol}`,
    `  min out:   ${amount(result.minOut)}`,
  ].join("\n");
}

// --- split & payouts ---------------------------------------------------------------------

export type SplitView = FeeSplit & { network: string; sumMatches: boolean; share: Record<Seat, number | null> };

export async function splitCommand(ctx: AgentContext, coin: string): Promise<SplitView> {
  const split = await ctx.feast.feeSplit(coin);
  const sum = SEATS.reduce((total, seat) => total + split.seats[seat].earned, 0n);
  const share = Object.fromEntries(
    SEATS.map((seat) => [seat, split.accrued > 0n ? Number((split.seats[seat].earned * 1_000_000n) / split.accrued) / 1_000_000 : null]),
  ) as Record<Seat, number | null>;
  return { ...split, network: ctx.feast.network.name, sumMatches: sum === split.accrued, share };
}

export function renderSplit(view: SplitView): string {
  const q = view.quote.symbol;
  const rows = SEATS.map((seat) => {
    const s = view.seats[seat];
    return [
      seat,
      `${s.points}`,
      view.share[seat] === null ? "n/a" : `${((view.share[seat] ?? 0) * 100).toFixed(2)}%`,
      `${amount(s.earned)} ${q}`,
      s.settled === null ? "per referrer" : `${amount(s.settled)} ${q}`,
      s.pending === null ? "per referrer" : `${amount(s.pending)} ${q}`,
    ];
  });
  rows.push(["total", "100", view.accrued > 0n ? "100%" : "n/a", `${amount(view.accrued)} ${q}`, "", ""]);
  return [
    table(["Seat", "Points", "Share of fees so far", "Earned", "Settled", "Pending"], rows),
    "",
    `accrued ${view.accrued} base units of ${q}; seats sum to it: ${view.sumMatches ? "yes" : "NO"}`,
    "Points are the seat's cut of the 1% fee as set at launch; a trade nobody referred folds the referrer's points into the creator's, which is why the realised shares can differ from the points.",
  ].join("\n");
}

export async function payoutsCommand(ctx: AgentContext, coin: string, limit = 20): Promise<PayoutsPage> {
  return ctx.feast.payouts(coin, limit);
}

export function renderPayouts(page: PayoutsPage): string {
  const head = `source ${page.source}, indexed to block ${page.asOf.block} (${page.asOf.blocksBehind} behind the head)`;
  if (page.payouts.length === 0) return `${head}\nno settled payouts for this coin yet (accrued fees appear here once claimed, burned or released)`;
  return `${head}\n${table(
    ["When", "Seat", "Kind", "Amount", "Tx"],
    page.payouts.map((p) => [p.at, p.seat, p.kind, `${amount(BigInt(p.amount))} ${p.amountAsset}`, p.txHash]),
  )}`;
}
