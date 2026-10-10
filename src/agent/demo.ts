import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseEther, type Address } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { FeastError, NETWORKS, type LaunchResult, type TradeResult } from "../sdk/index.ts";
import {
  ensureSandboxKey,
  quoteCommand,
  renderLaunch,
  renderQuote,
  renderSplit,
  renderTrade,
  splitCommand,
  type AgentContext,
  type QuoteView,
  type SplitView,
} from "./commands.ts";
import { amount, short } from "./format.ts";

/**
 * `npm run demo:sandbox`: the whole loop on the public sandbox, as one transcript.
 *
 *   faucet → price the stock (Binance) → launch a coin paired with it → buy → sell
 *   → read the four-seat fee split → price the coin → ask the read API for payouts
 *
 * Every figure printed is read back from the chain (or the API that served it);
 * the transcript is saved as markdown under demo/.
 */

class Transcript {
  private readonly parts: string[] = [];
  constructor(private readonly echo: (line: string) => void) {}
  heading(text: string): void {
    this.parts.push(`\n## ${text}\n`);
    this.echo(`\n== ${text}`);
  }
  text(text: string): void {
    this.parts.push(`${text}\n`);
    this.echo(text);
  }
  block(text: string): void {
    this.parts.push(`\n\`\`\`\n${text}\n\`\`\`\n`);
    this.echo(text);
  }
  markdown(text: string): void {
    this.parts.push(`\n${text}\n`);
    this.echo(text);
  }
  toString(): string {
    return this.parts.join("\n").replace(/\n{3,}/g, "\n\n");
  }
}

export type DemoResult = {
  transcriptPath: string;
  coin: Address | null;
  launch: LaunchResult | null;
  buy: TradeResult | null;
  sell: TradeResult | null;
  split: SplitView | null;
  quote: QuoteView | null;
  failedAt: string | null;
};

/** Candidate first-buy sizes, largest first: the opening window caps each wallet's buy in the pool's first two traded blocks. */
const BUY_STEPS = ["0.02", "0.01", "0.005", "0.002", "0.001"];

export async function runDemo(ctx: AgentContext, options: { stock: string; outDir: string; echo?: (line: string) => void }): Promise<DemoResult> {
  const echo = options.echo ?? ((line: string) => console.log(line));
  const t = new Transcript(echo);
  const started = new Date();
  const stamp = started.toISOString().replace(/\.\d{3}Z$/, "Z").replace(/:/g, "");
  const network = ctx.feast.network;
  const result: DemoResult = { transcriptPath: "", coin: null, launch: null, buy: null, sell: null, split: null, quote: null, failedAt: null };
  let step = "setup";

  const save = () => {
    mkdirSync(options.outDir, { recursive: true });
    const path = join(options.outDir, `transcript-${stamp}.md`);
    writeFileSync(path, `${t.toString().trim()}\n`);
    result.transcriptPath = path;
    return path;
  };

  if (network.realMoney) throw new FeastError("the demo runs on the sandbox only: set FEAST_NETWORK=sandbox", "demo_mainnet");

  t.markdown(`# feast-agent demo — ${started.toISOString()}`);
  t.text(
    `Network: **${network.chainName}** (chain ${network.chainId}), RPC ${network.rpcUrl === NETWORKS[network.name].rpcUrl ? network.rpcUrl : "from FEAST_RPC_URL (not printed)"}. ` +
      `Every transaction below is on the sandbox, a public fork of BNB Smart Chain where test BNB is free; nothing touches chain 56.`,
  );

  try {
    // 1. Wallet and test BNB --------------------------------------------------------
    step = "faucet";
    t.heading("1. Wallet and test BNB");
    const key = ensureSandboxKey(ctx);
    const wallet = key.address;
    t.text(`Agent wallet: \`${wallet}\`${key.created ? " (a throwaway key was just created in .env, which git ignores; it is not printed)" : ""}.`);
    let balance = await ctx.feast.nativeBalance(wallet);
    if (balance < parseEther("1")) {
      const drip = await ctx.feast.faucet(wallet);
      t.text(`Faucet (${network.faucetUrl}): +${amount(drip.added)} ${network.nativeSymbol}, balance ${amount(drip.balance)} ${network.nativeSymbol}.`);
      balance = drip.balance;
    } else {
      t.text(`Balance ${amount(balance)} ${network.nativeSymbol}: enough, so the faucet is left alone (it allows three drips an hour per address).`);
    }

    // 2. The stock, priced by Binance ------------------------------------------------
    step = "stock";
    const stock = ctx.feast.quoteAsset(options.stock);
    if (!stock.stock) throw new FeastError(`${options.stock} is not a stock token; pick one of ${network.stocks.map((s) => s.symbol).join(", ")}`, "not_a_stock");
    t.heading(`2. The paired stock: ${stock.symbol} (${stock.stock.underlying}, ${stock.stock.name})`);
    const stockView = await quoteCommand(ctx, stock.symbol);
    t.block(renderQuote(stockView));

    // 3. Launch ------------------------------------------------------------------------
    step = "launch";
    const tag = privateKeyToAccount(generatePrivateKey()).address.slice(2, 6).toUpperCase();
    const symbol = `FA${stock.stock.underlying.slice(0, 4)}${tag}`.slice(0, 10);
    const name = `Feast Agent ${stock.stock.underlying} ${tag}`;
    t.heading(`3. Launch $${symbol}, paired with ${stock.symbol}`);
    t.text("The agent pins a generated picture and the metadata through the Feast site's /api/pin, asks the factory where the coin will land (`predictCoin`), builds `CreateParams` exactly as the launch form does, simulates `create`, sends it, and reads the coin back from the factory's `CoinCreated` event.");
    const launched = await ctx.feast.launch({ name, symbol, quote: stock.symbol, burn: 10, referrer: 10 });
    result.launch = launched;
    result.coin = launched.coin;
    t.block(renderLaunch(launched));
    t.text(`Predicted address ${launched.predicted === launched.coin ? "matches" : "DIFFERS FROM"} the minted one. Coin page: ${network.siteUrl}/coin/${launched.coin}`);

    // 4. Buy -----------------------------------------------------------------------------
    step = "buy";
    t.heading("4. Buy");
    const referrer = privateKeyToAccount(generatePrivateKey()).address;
    const boundBefore = await ctx.feast.referrerOf(wallet);
    t.text(
      `A buy spends test BNB: the Feast sandbox router wraps it and walks the v3 route WBNB → … → ${stock.symbol}, then buys the coin in its Feast pool, where the hook takes 1% of the ${stock.symbol} leg. ` +
        (boundBefore
          ? `This wallet is already bound to referrer \`${short(boundBefore)}\` (hook \`referrerOf\`), so the hook pays that referrer whatever the trade names.`
          : `The trade names \`${short(referrer)}\` (a fresh address standing in for a referrer) so the referrer seat earns too.`),
    );
    let size: string | null = null;
    for (const candidate of BUY_STEPS) {
      try {
        await ctx.feast.quoteBuy(launched.coin, parseEther(candidate), { referrer });
        size = candidate;
        break;
      } catch (error) {
        const refusal = error instanceof FeastError ? error.message : String(error);
        t.text(`- ${candidate} ${network.nativeSymbol}: refused in simulation (${refusal.replace(/^the chain refused the call: /, "")})`);
        if (!/PurchaseCapExceeded/.test(refusal)) throw error;
      }
    }
    if (!size) throw new FeastError("every buy size was over the opening cap", "cap");
    const bought = await ctx.feast.buy(launched.coin, parseEther(size), { referrer, slippageBps: 100 });
    result.buy = bought;
    t.block(renderTrade(bought, network.nativeSymbol, stock.symbol));

    // 5. Sell ------------------------------------------------------------------------------
    step = "sell";
    t.heading("5. Sell half");
    t.text("A sale is one EIP-2612 permit signature and one `sellWithPermit` transaction: no approval transaction.");
    const held = await ctx.feast.coinBalance(launched.coin, wallet);
    const sold = await ctx.feast.sell(launched.coin, held / 2n, { slippageBps: 100 });
    result.sell = sold;
    t.block(renderTrade(sold, network.nativeSymbol, stock.symbol));

    // 6. Fee split ---------------------------------------------------------------------------
    step = "split";
    t.heading("6. The fee split, as the hook holds it");
    const split = await splitCommand(ctx, launched.coin);
    result.split = split;
    t.markdown(renderSplit(split));
    const boundAfter = await ctx.feast.referrerOf(wallet);
    t.text(
      boundAfter
        ? `The hook has bound this wallet to referrer \`${boundAfter}\` (\`referrerOf\`): a wallet's first referred trade binds it, so the sale, which named nobody, paid the referrer seat too.`
        : `No referrer is bound to this wallet, so trades that named nobody folded the referrer's points into the creator's.`,
    );

    // 7. The coin, priced -------------------------------------------------------------------
    step = "quote";
    t.heading("7. The coin, priced in the stock and in dollars");
    const coinView = await quoteCommand(ctx, launched.coin);
    result.quote = coinView;
    t.block(renderQuote(coinView));

    // 8. Payouts -----------------------------------------------------------------------------
    step = "payouts";
    t.heading("8. Payouts (Feast public read API)");
    try {
      const page = await ctx.feast.payouts(launched.coin, 10);
      t.text(
        `GET ${network.siteUrl}/api/v1/payouts?coin=${launched.coin}: source ${page.source}, ${page.payouts.length} settled payouts; ` +
          `the index is at block ${page.asOf.block}, ${page.asOf.blocksBehind} blocks behind the head. ` +
          `Fees just accrued are not payouts yet: they settle when the creator claims, the burn seat buys back, or the platform share is released.`,
      );
    } catch (error) {
      t.text(`The read API did not answer: ${error instanceof Error ? error.message : String(error)}`);
    }

    // Summary ----------------------------------------------------------------------------------
    t.heading("Summary");
    t.markdown(
      [
        "| Step | Transaction | Result |",
        "| --- | --- | --- |",
        `| Launch | \`${launched.txHash}\` | $${launched.onChain.symbol} at \`${launched.coin}\`, paired with ${stock.symbol} |`,
        `| Buy | \`${bought.txHash}\` | ${amount(bought.amountIn)} ${network.nativeSymbol} → ${amount(bought.amountOut)} coins (fee ${amount(bought.fee)} ${stock.symbol}) |`,
        `| Sell | \`${sold.txHash}\` | ${amount(sold.amountIn)} coins → ${amount(sold.amountOut)} ${network.nativeSymbol} (fee ${amount(sold.fee)} ${stock.symbol}) |`,
        `| Split | (read) | ${amount(split.accrued)} ${stock.symbol} accrued; seats sum to it: ${split.sumMatches ? "yes" : "NO"} |`,
      ].join("\n"),
    );
    t.text(`Finished in ${((Date.now() - started.getTime()) / 1000).toFixed(1)} s.`);
  } catch (error) {
    result.failedAt = step;
    t.heading(`Stopped at step "${step}"`);
    t.block(error instanceof Error ? error.message : String(error));
    const path = save();
    echo(`\ntranscript saved: ${path}`);
    throw error;
  }
  const path = save();
  echo(`\ntranscript saved: ${path}`);
  return result;
}
