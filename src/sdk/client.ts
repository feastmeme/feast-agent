import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  getAddress,
  http,
  isAddress,
  zeroAddress,
  type Account,
  type Address,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
  type WalletClient,
} from "viem";

import { coinAbi, factoryAbi, hookAbi, poolManagerAbi, pricerAbi, routerAbi, v3PoolAbi } from "./abi.ts";
import { chainOf } from "./config.ts";
import { FeastError, REFUSALS_ABI, refusalOf } from "./errors.ts";
import { requestFaucet, type FaucetDrip } from "./faucet.ts";
import { SUPPLY, createParams, randomSalt, type CreateParams } from "./launch-params.ts";
import { coinPicture, pinImage, pinMetadata } from "./metadata.ts";
import type { FeastNetwork, Hop, StockQuote } from "./networks.ts";
import { allowanceSlot, permitTypedData, splitPermitSignature, uint256Word } from "./permit.ts";
import { coinPriceE18, e18ToNumber, priceInPool } from "./price.ts";
import { creationsOf, fillsOf } from "./receipts.ts";
import { feeSplitOf, type FeeSplit, type PoolInfo } from "./split.ts";

/** Calls are simulated and sent with every refusal any contract on the path can raise, so a revert has a name. */
const FACTORY_CALL_ABI = [...factoryAbi, ...REFUSALS_ABI] as const;
const ROUTER_CALL_ABI = [...routerAbi, ...REFUSALS_ABI] as const;

/** Quotes for a wallet-less reader are simulated from this address with a balance granted for the call only. */
const PREVIEW_ACCOUNT = "0x00000000000000000000000000000000000fea57" as const;

export type QuoteAsset = {
  address: Address;
  symbol: string;
  decimals: number;
  /** True for a Binance tokenized stock (bStock); false for WBNB. */
  isStock: boolean;
  /** The address book's facts about the stock, when it has any. */
  stock: StockQuote | null;
};

export type CoinState = {
  address: Address;
  name: string;
  symbol: string;
  creator: Address;
  poolId: Hex;
  supply: bigint;
  metadataHash: Hex;
  quote: QuoteAsset;
  coinIsCurrency0: boolean;
  sqrtPriceX96: bigint;
  /** Quote tokens per coin, scaled by 1e18 (both sides have 18 decimals). */
  priceE18: bigint;
  /** The same as a number, for display. */
  price: number;
  pool: PoolInfo;
};

export type LaunchOptions = {
  name: string;
  symbol: string;
  /** A quote's address or its ticker (`AAPLB`, `WBNB`, …). */
  quote: string;
  /** Points of the 1% fee to buy back and burn, 0–30 (default 10). */
  burn?: number;
  /** Points of the 1% fee for referrers, 0–30 (default 10). */
  referrer?: number;
  description?: string;
  /** A PNG/JPEG/WebP picture; default: an identicon generated from the ticker. */
  image?: Uint8Array;
  /** Skip pinning and use this digest (zero is legal on chain and means "no metadata"). */
  metadataHash?: Hex;
  salt?: Hex;
  /** The whole supply's opening worth in raw quote units; default five shares (stock) or two WBNB. */
  openingValuation?: bigint;
};

export type PreparedLaunch = {
  params: CreateParams;
  predicted: Address;
  quote: QuoteAsset;
  metadata: { cid: string; imageCid: string | null; digest: Hex } | null;
  /** The transaction, ready to sign: `create(params)` on the factory. */
  request: { to: Address; data: Hex; value: bigint };
};

export type LaunchResult = PreparedLaunch & {
  coin: Address;
  poolId: Hex;
  txHash: Hex;
  blockNumber: bigint;
  gasUsed: bigint;
  /** Read back off the coin contract, never taken from the request. */
  onChain: { name: string; symbol: string };
};

export type TradeQuote = {
  side: "buy" | "sell";
  /** What is spent: native wei on a buy, coin units on a sale. */
  amountIn: bigint;
  /** What comes out: coins on a buy, native wei on a sale. */
  amountOut: bigint;
  /** The quote-token leg into (buy) or out of (sale) the Feast pool. */
  quoteLeg: bigint;
  /** The hook's 1% fee on that leg, in the quote token. */
  fee: bigint;
};

export type TradeResult = TradeQuote & {
  txHash: Hex;
  blockNumber: bigint;
  gasUsed: bigint;
  minOut: bigint;
  referrer: Address;
};

export type Payout = {
  coin: Address;
  poolId: Hex;
  quote: Address;
  kind: string;
  seat: "creator" | "referrer" | "house" | "burn";
  account: Address | null;
  amount: string;
  amountAsset: "quote" | "coin";
  blockNumber: number;
  at: string;
  txHash: Hex;
  depth: string;
};

export type PayoutsPage = {
  chainId: number;
  source: string;
  asOf: { block: number; headBlock: number; blocksBehind: number; wallClock: string } & Record<string, unknown>;
  payouts: Payout[];
};

export type FeastClientOptions = {
  network: FeastNetwork;
  /** The signer for launches and trades; reads need none. */
  account?: Account;
  fetch?: typeof fetch;
  /** Milliseconds between receipt polls. */
  pollingInterval?: number;
};

/**
 * A typed client for Feast over viem.
 *
 * Reads work on both networks. Writes (launch, buy, sell) are sent only on the
 * sandbox: on BNB Smart Chain this release prepares calldata (`prepareLaunch`) and
 * quotes, and refuses to send — there is no flag that changes that.
 */
export class FeastClient {
  readonly network: FeastNetwork;
  readonly publicClient: PublicClient;
  readonly account: Account | undefined;
  private readonly wallet: WalletClient | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly pollingInterval: number;

  constructor(options: FeastClientOptions) {
    this.network = options.network;
    this.account = options.account;
    this.fetchImpl = options.fetch ?? fetch;
    this.pollingInterval = options.pollingInterval ?? 1_000;
    const chain = chainOf(this.network);
    // JSON-RPC batching keeps a page of reads to one HTTPS request; the sandbox RPC accepts batches of up to 50.
    const transport = http(this.network.rpcUrl, { batch: { batchSize: 25, wait: 10 }, retryCount: 2, retryDelay: 750 });
    this.publicClient = createPublicClient({ chain, transport, pollingInterval: this.pollingInterval }) as PublicClient;
    this.wallet = this.account ? createWalletClient({ chain, transport, account: this.account }) : undefined;
  }

  // --- reads --------------------------------------------------------------------

  /** The tokens a coin may be paired with: `FeastPricer.quotes()`, named from the chain and the address book. */
  async quotes(): Promise<QuoteAsset[]> {
    const listed = await this.publicClient.readContract({
      address: this.network.contracts.pricer,
      abi: pricerAbi,
      functionName: "quotes",
    });
    const symbols = await Promise.all(
      listed.map((address) =>
        this.publicClient.readContract({ address, abi: coinAbi, functionName: "symbol" }).catch(() => null),
      ),
    );
    return listed.map((address, i) => this.assetOf(address, symbols[i] ?? null));
  }

  /** A quote by address or ticker, from the address book (no chain read). */
  quoteAsset(quote: string): QuoteAsset {
    const wrapped = this.network.contracts.wrappedNative;
    if (isAddress(quote)) return this.assetOf(getAddress(quote), null);
    const wanted = quote.trim().toUpperCase();
    if (wanted === "WBNB" || wanted === "BNB") return this.assetOf(wrapped, "WBNB");
    const stock = this.network.stocks.find((s) => s.symbol === wanted || s.underlying === wanted);
    if (!stock) {
      const known = ["WBNB", ...this.network.stocks.map((s) => s.symbol)].join(", ");
      throw new FeastError(`unknown quote "${quote}" on ${this.network.name}; known: ${known}`, "unknown_quote");
    }
    return this.assetOf(stock.address, stock.symbol);
  }

  private assetOf(address: Address, symbol: string | null): QuoteAsset {
    const stock = this.network.stocks.find((s) => s.address.toLowerCase() === address.toLowerCase()) ?? null;
    const isNative = address.toLowerCase() === this.network.contracts.wrappedNative.toLowerCase();
    return {
      address: getAddress(address),
      symbol: symbol ?? stock?.symbol ?? (isNative ? "WBNB" : `${address.slice(0, 6)}…${address.slice(-4)}`),
      decimals: 18,
      isStock: !isNative,
      stock,
    };
  }

  /** The address `create` will mint for this salt, name and symbol — asked of the factory itself. */
  async predictCoin(input: { salt: Hex; name: string; symbol: string; supply?: bigint }): Promise<Address> {
    return this.publicClient.readContract({
      address: this.network.contracts.factory,
      abi: factoryAbi,
      functionName: "predictCoin",
      args: [input.salt, input.name, input.symbol, input.supply ?? SUPPLY],
    });
  }

  /** Every coin the factory has made, oldest first. */
  async listCoins(): Promise<readonly Address[]> {
    return this.publicClient.readContract({ address: this.network.contracts.factory, abi: factoryAbi, functionName: "listCoins" });
  }

  /** The hook's ledger for one coin's pool. */
  async poolInfo(poolId: Hex): Promise<PoolInfo> {
    const raw = await this.publicClient.readContract({
      address: this.network.contracts.hook,
      abi: hookAbi,
      functionName: "poolInfo",
      args: [poolId],
    });
    return raw as unknown as PoolInfo;
  }

  private async registry(coin: Address) {
    const info = await this.publicClient.readContract({
      address: this.network.contracts.factory,
      abi: factoryAbi,
      functionName: "getCoin",
      args: [coin],
    });
    if (info.quote === zeroAddress) {
      throw new FeastError(`${coin} is not a coin the Feast factory on ${this.network.name} made`, "unknown_coin");
    }
    return info;
  }

  /** Everything a quote needs about one coin: identity, pool, spot price in the quote token. */
  async coin(address: string): Promise<CoinState> {
    const coin = this.requireAddress(address);
    const info = await this.registry(coin);
    const [name, symbol, pool, slot0, quoteSymbol] = await Promise.all([
      this.publicClient.readContract({ address: coin, abi: coinAbi, functionName: "name" }),
      this.publicClient.readContract({ address: coin, abi: coinAbi, functionName: "symbol" }),
      this.poolInfo(info.poolId),
      this.publicClient.readContract({
        address: this.network.contracts.poolManager,
        abi: poolManagerAbi,
        functionName: "getSlot0",
        args: [info.poolId],
      }),
      this.publicClient.readContract({ address: info.quote, abi: coinAbi, functionName: "symbol" }).catch(() => null),
    ]);
    const [sqrtPriceX96] = slot0;
    const priceE18 = coinPriceE18(sqrtPriceX96, pool.coinIsCurrency0);
    return {
      address: coin,
      name,
      symbol,
      creator: info.creator,
      poolId: info.poolId,
      supply: info.supply,
      metadataHash: info.metadataHash,
      quote: this.assetOf(info.quote, quoteSymbol),
      coinIsCurrency0: pool.coinIsCurrency0,
      sqrtPriceX96,
      priceE18,
      price: e18ToNumber(priceE18),
      pool,
    };
  }

  /** The four-seat fee split and its totals, as the hook's `poolInfo` holds them. */
  async feeSplit(address: string): Promise<FeeSplit> {
    const coin = this.requireAddress(address);
    const info = await this.registry(coin);
    const [pool, quoteSymbol] = await Promise.all([
      this.poolInfo(info.poolId),
      this.publicClient.readContract({ address: info.quote, abi: coinAbi, functionName: "symbol" }).catch(() => null),
    ]);
    const quote = this.assetOf(info.quote, quoteSymbol);
    return feeSplitOf(pool, { poolId: info.poolId, quote: { address: quote.address, symbol: quote.symbol, decimals: 18 } });
  }

  /** Settled fee payouts for a coin, newest first, from the Feast public read API (`/api/v1/payouts`). */
  async payouts(address: string, limit = 20): Promise<PayoutsPage> {
    const coin = this.requireAddress(address);
    const url = `${this.network.siteUrl}/api/v1/payouts?coin=${coin}&limit=${Math.min(Math.max(limit, 1), 50)}`;
    const response = await this.fetchImpl(url, { headers: { accept: "application/json" } });
    const text = await response.text();
    if (!response.ok) {
      throw new FeastError(`the Feast read API refused ${url} (HTTP ${response.status}): ${text.slice(0, 200)}`, "api_failed");
    }
    const page = JSON.parse(text) as PayoutsPage;
    if (page.chainId !== this.network.chainId) {
      throw new FeastError(`the read API answered for chain ${page.chainId}, not ${this.network.chainId}`, "wrong_chain");
    }
    return page;
  }

  /**
   * A stock token's on-chain dollar price, from its PancakeSwap v3 pool: against USDT
   * directly, or against WBNB and then BNB's USDT pool. BSC's USDT is treated as $1.
   */
  async stockUsdPrice(stock: StockQuote): Promise<{ usd: number; via: Address[] }> {
    const { usdt, wrappedNative, usdtNativePool } = this.network.contracts;
    const poolPrice = async (pool: Address, token: Address) => {
      const [slot0, token0, token1] = await Promise.all([
        this.publicClient.readContract({ address: pool, abi: v3PoolAbi, functionName: "slot0" }),
        this.publicClient.readContract({ address: pool, abi: v3PoolAbi, functionName: "token0" }),
        this.publicClient.readContract({ address: pool, abi: v3PoolAbi, functionName: "token1" }),
      ]);
      const other = token0.toLowerCase() === token.toLowerCase() ? token1 : token0;
      return { price: priceInPool(slot0[0], token0, token), other };
    };
    const first = await poolPrice(stock.pricePool, stock.address);
    if (first.other.toLowerCase() === usdt.toLowerCase()) return { usd: first.price, via: [stock.pricePool] };
    if (first.other.toLowerCase() === wrappedNative.toLowerCase()) {
      const bnb = await poolPrice(usdtNativePool, wrappedNative);
      return { usd: first.price * bnb.price, via: [stock.pricePool, usdtNativePool] };
    }
    throw new FeastError(`${stock.symbol}'s price pool pairs it with ${first.other}, which is neither USDT nor WBNB`, "unpriceable");
  }

  /**
   * The referrer the hook has bound to a wallet, or null. A wallet's first trade that
   * names a referrer binds it, and from then on the hook pays that referrer on every
   * trade the wallet makes, whatever later trades name.
   */
  async referrerOf(wallet: Address): Promise<Address | null> {
    const bound = await this.publicClient.readContract({
      address: this.network.contracts.hook,
      abi: hookAbi,
      functionName: "referrerOf",
      args: [wallet],
    });
    return bound === zeroAddress ? null : bound;
  }

  /** BNB's dollar price from the USDT/WBNB PancakeSwap v3 pool the address book names. */
  async bnbUsdPrice(): Promise<number> {
    const { usdtNativePool, wrappedNative } = this.network.contracts;
    const [slot0, token0] = await Promise.all([
      this.publicClient.readContract({ address: usdtNativePool, abi: v3PoolAbi, functionName: "slot0" }),
      this.publicClient.readContract({ address: usdtNativePool, abi: v3PoolAbi, functionName: "token0" }),
    ]);
    return priceInPool(slot0[0], token0, wrappedNative);
  }

  async nativeBalance(owner?: Address): Promise<bigint> {
    return this.publicClient.getBalance({ address: owner ?? this.requireAccount().address });
  }

  async coinBalance(coin: Address, owner?: Address): Promise<bigint> {
    return this.publicClient.readContract({
      address: coin,
      abi: coinAbi,
      functionName: "balanceOf",
      args: [owner ?? this.requireAccount().address],
    });
  }

  // --- sandbox faucet -------------------------------------------------------------

  async faucet(address?: Address): Promise<FaucetDrip> {
    return requestFaucet(this.network, address ?? this.requireAccount().address, this.fetchImpl);
  }

  // --- launch -------------------------------------------------------------------

  /**
   * Everything `launch` sends, without sending it: pin the metadata (unless a digest
   * is given), ask the factory where the coin will land, build `CreateParams`, encode
   * `create`. Safe on mainnet: nothing is signed.
   */
  async prepareLaunch(options: LaunchOptions, creator?: Address): Promise<PreparedLaunch> {
    const signer = creator ?? this.requireAccount().address;
    const quote = this.quoteAsset(options.quote);
    const symbol = options.symbol.trim().toUpperCase();
    const name = options.name.trim() || symbol;
    if (!/^[A-Z0-9]{1,10}$/.test(symbol)) throw new FeastError("a ticker is 1–10 letters or digits", "bad_symbol");
    if (name.length > 32) throw new FeastError("a coin's name is at most 32 characters", "bad_name");

    let metadata: PreparedLaunch["metadata"] = null;
    let metadataHash = options.metadataHash;
    if (!metadataHash) {
      // PIN BEFORE SIGN: the digest the transaction carries must address a document that already exists.
      const image = await pinImage(this.network.siteUrl, options.image ?? coinPicture(symbol), this.fetchImpl);
      const pinned = await pinMetadata(
        this.network.siteUrl,
        {
          name,
          symbol,
          image: `ipfs://${image.cid}`,
          description: options.description ?? `${name} ($${symbol}), paired with ${quote.symbol}. Launched by feast-agent.`,
        },
        this.fetchImpl,
      );
      metadata = { cid: pinned.cid, imageCid: image.cid, digest: pinned.digest };
      metadataHash = pinned.digest;
    }

    const salt = options.salt ?? randomSalt();
    // The factory is asked, not a local port: which side of the pool the coin sorts to sets every opening number.
    const predicted = await this.predictCoin({ salt, name, symbol });
    const params = createParams(
      {
        name,
        symbol,
        quote: quote.address,
        creator: signer,
        burn: options.burn ?? 10,
        referrer: options.referrer ?? 10,
        salt,
        metadataHash,
        openingValuation: options.openingValuation,
      },
      predicted,
      this.network.contracts.wrappedNative,
    );
    const data = encodeFunctionData({ abi: factoryAbi, functionName: "create", args: [params] });
    return { params, predicted, quote, metadata, request: { to: this.network.contracts.factory, data, value: 0n } };
  }

  /** Launch a coin: `prepareLaunch`, then simulate, send and read back what the chain made. */
  async launch(options: LaunchOptions): Promise<LaunchResult> {
    this.assertWritable();
    const account = this.requireAccount();
    const prepared = await this.prepareLaunch(options, account.address);
    const { request } = await this.simulate(() =>
      this.publicClient.simulateContract({
        account,
        address: this.network.contracts.factory,
        abi: FACTORY_CALL_ABI,
        functionName: "create",
        args: [prepared.params],
      }),
    );
    const txHash = await this.requireWallet().writeContract(request);
    const receipt = await this.receipt(txHash);
    const created = creationsOf(receipt, { factory: this.network.contracts.factory, creator: account.address });
    const [event] = created;
    if (created.length !== 1 || !event) {
      throw new FeastError(`transaction ${txHash} was mined but holds ${created.length} creations by this factory for this creator`, "no_creation");
    }
    const coin = event.args.coin;
    const [name, symbol] = await Promise.all([
      this.publicClient.readContract({ address: coin, abi: coinAbi, functionName: "name" }),
      this.publicClient.readContract({ address: coin, abi: coinAbi, functionName: "symbol" }),
    ]);
    return {
      ...prepared,
      coin,
      poolId: event.args.poolId,
      txHash,
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed,
      onChain: { name, symbol },
    };
  }

  // --- trade --------------------------------------------------------------------

  /** The router's hops for a coin's quote: wrapped native → quote on a buy, quote → wrapped native on a sale. */
  routeFor(quote: Address, side: "buy" | "sell"): Hop[] {
    if (quote.toLowerCase() === this.network.contracts.wrappedNative.toLowerCase()) return [];
    const stock = this.network.stocks.find((s) => s.address.toLowerCase() === quote.toLowerCase());
    if (!stock) throw new FeastError(`no route for quote ${quote} in the ${this.network.name} address book`, "no_route");
    return side === "buy" ? stock.buy : stock.sell;
  }

  /** What a buy of `amountIn` native wei would bring, simulated against the chain (sandbox router). */
  async quoteBuy(address: string, amountIn: bigint, options: { referrer?: Address } = {}): Promise<TradeQuote> {
    const coin = this.requireAddress(address);
    const router = this.sandboxRouter();
    const info = await this.registry(coin);
    const from = this.account?.address ?? PREVIEW_ACCOUNT;
    const { result } = await this.simulate(() =>
      this.publicClient.simulateContract({
        account: from,
        address: router,
        abi: ROUTER_CALL_ABI,
        functionName: "buy",
        args: [coin, this.routeFor(info.quote, "buy"), 0n, options.referrer ?? zeroAddress],
        value: amountIn,
        stateOverride: this.account ? undefined : [{ address: from, balance: amountIn + 10n ** 18n }],
      }),
    );
    const [coinOut, quoteIn, fee] = result;
    return { side: "buy", amountIn, amountOut: coinOut, quoteLeg: quoteIn, fee };
  }

  /** What a sale of `coinIn` would bring, simulated as if the permit were already granted. Nothing is signed. */
  async quoteSell(address: string, coinIn: bigint, options: { referrer?: Address } = {}): Promise<TradeQuote> {
    const coin = this.requireAddress(address);
    const router = this.sandboxRouter();
    const owner = this.requireAccount().address;
    const info = await this.registry(coin);
    const { result } = await this.simulate(() =>
      this.publicClient.simulateContract({
        account: owner,
        address: router,
        abi: ROUTER_CALL_ABI,
        functionName: "sell",
        args: [coin, coinIn, this.routeFor(info.quote, "sell"), 0n, options.referrer ?? zeroAddress],
        stateOverride: [{ address: coin, stateDiff: [{ slot: allowanceSlot(owner, router), value: uint256Word(coinIn) }] }],
      }),
    );
    const [out, quoteOut, fee] = result;
    return { side: "sell", amountIn: coinIn, amountOut: out, quoteLeg: quoteOut, fee };
  }

  /** Buy `amountIn` native wei worth of a coin through the router: quote, bound by slippage, send, read the receipt. */
  async buy(address: string, amountIn: bigint, options: { slippageBps?: number; referrer?: Address } = {}): Promise<TradeResult> {
    this.assertWritable();
    const account = this.requireAccount();
    const coin = this.requireAddress(address);
    const router = this.sandboxRouter();
    const quoted = await this.quoteBuy(coin, amountIn, options);
    const minOut = withSlippage(quoted.amountOut, options.slippageBps ?? 100);
    const referrer = options.referrer ?? zeroAddress;
    const info = await this.registry(coin);
    const { request } = await this.simulate(() =>
      this.publicClient.simulateContract({
        account,
        address: router,
        abi: ROUTER_CALL_ABI,
        functionName: "buy",
        args: [coin, this.routeFor(info.quote, "buy"), minOut, referrer],
        value: amountIn,
      }),
    );
    const txHash = await this.requireWallet().writeContract(request);
    return this.tradeOutcome(txHash, { side: "buy", coin, router, amountIn, minOut, referrer });
  }

  /** Sell `coinIn` coins: one EIP-2612 permit signature, then `sellWithPermit` — no approval transaction. */
  async sell(address: string, coinIn: bigint, options: { slippageBps?: number; referrer?: Address } = {}): Promise<TradeResult> {
    this.assertWritable();
    const account = this.requireAccount();
    const coin = this.requireAddress(address);
    const router = this.sandboxRouter();
    const quoted = await this.quoteSell(coin, coinIn, options);
    const minOut = withSlippage(quoted.amountOut, options.slippageBps ?? 100);
    const referrer = options.referrer ?? zeroAddress;
    const info = await this.registry(coin);
    const [coinName, nonce, head] = await Promise.all([
      this.publicClient.readContract({ address: coin, abi: coinAbi, functionName: "name" }),
      this.publicClient.readContract({ address: coin, abi: coinAbi, functionName: "nonces", args: [account.address] }),
      this.publicClient.getBlock({ blockTag: "latest" }),
    ]);
    // The chain's clock, not this computer's: a fork's clock can run ahead of the wall.
    const deadline = head.timestamp + 30n * 60n;
    if (!account.signTypedData) throw new FeastError("this account cannot sign typed data", "cannot_sign");
    const signature = await account.signTypedData(
      permitTypedData({
        coin,
        coinName,
        chainId: this.network.chainId,
        owner: account.address,
        spender: router,
        value: coinIn,
        nonce,
        deadline,
      }),
    );
    const { v, r, s } = splitPermitSignature(signature);
    const { request } = await this.simulate(() =>
      this.publicClient.simulateContract({
        account,
        address: router,
        abi: ROUTER_CALL_ABI,
        functionName: "sellWithPermit",
        args: [coin, coinIn, this.routeFor(info.quote, "sell"), minOut, referrer, deadline, v, r, s],
      }),
    );
    const txHash = await this.requireWallet().writeContract(request);
    return this.tradeOutcome(txHash, { side: "sell", coin, router, amountIn: coinIn, minOut, referrer });
  }

  private async tradeOutcome(
    txHash: Hex,
    bound: { side: "buy" | "sell"; coin: Address; router: Address; amountIn: bigint; minOut: bigint; referrer: Address },
  ): Promise<TradeResult> {
    const receipt = await this.receipt(txHash);
    const fills = fillsOf(receipt, { router: bound.router, trader: this.requireAccount().address, coin: bound.coin });
    const [fill] = fills;
    if (fills.length !== 1 || !fill) {
      throw new FeastError(`transaction ${txHash} was mined but holds ${fills.length} router fills for this trader and coin`, "no_fill");
    }
    const { buy, bnb, quote, coinAmount, fee } = fill.args;
    if (buy !== (bound.side === "buy")) throw new FeastError(`transaction ${txHash} filled the other side`, "wrong_side");
    return {
      side: bound.side,
      amountIn: bound.side === "buy" ? bnb : coinAmount,
      amountOut: bound.side === "buy" ? coinAmount : bnb,
      quoteLeg: quote,
      fee,
      txHash,
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed,
      minOut: bound.minOut,
      referrer: bound.referrer,
    };
  }

  // --- plumbing -----------------------------------------------------------------

  private async simulate<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      const refusal = refusalOf(error);
      throw new FeastError(`the chain refused the call: ${refusal.message}`, "refused", refusal);
    }
  }

  private async receipt(hash: Hex): Promise<TransactionReceipt> {
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash, pollingInterval: this.pollingInterval, timeout: 180_000 });
    if (receipt.status !== "success") throw new FeastError(`transaction ${hash} reverted`, "reverted", receipt);
    return receipt;
  }

  private sandboxRouter(): Address {
    if (this.network.trade.kind !== "sandbox") {
      throw new FeastError(
        `${this.network.chainName} trades through PancakeSwap Infinity's Universal Router, which this release does not drive; ` +
          `use the Feast read API's /api/v1/quote for prices`,
        "router_unsupported",
      );
    }
    return this.network.trade.router;
  }

  private assertWritable(): void {
    if (this.network.realMoney) {
      throw new FeastError(
        `refusing to send a transaction on ${this.network.chainName} (chain ${this.network.chainId}): this release sends transactions only on the sandbox. ` +
          `On mainnet, prepareLaunch (CLI: launch --dry-run) shows the calldata without sending it.`,
        "mainnet_writes_disabled",
      );
    }
  }

  private requireAccount(): Account {
    if (!this.account) throw new FeastError("no signer: set FEAST_AGENT_PRIVATE_KEY (a throwaway sandbox key)", "no_account");
    return this.account;
  }

  private requireWallet(): WalletClient {
    if (!this.wallet) throw new FeastError("no signer: set FEAST_AGENT_PRIVATE_KEY (a throwaway sandbox key)", "no_account");
    return this.wallet;
  }

  private requireAddress(value: string): Address {
    if (!isAddress(value)) throw new FeastError(`"${value}" is not an address`, "bad_address");
    return getAddress(value);
  }
}

/** `amount` less `bps` basis points, floored. */
export function withSlippage(amount: bigint, bps: number): bigint {
  if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) throw new FeastError("slippage is 0–10000 basis points", "bad_slippage");
  return (amount * BigInt(10_000 - bps)) / 10_000n;
}
