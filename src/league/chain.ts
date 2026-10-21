import { createPublicClient, http, zeroAddress, type Address, type Hex, type PublicClient, type TransactionReceipt } from "viem";
import { bsc } from "viem/chains";

import { coinAbi, factoryAbi, hookAbi, poolManagerAbi, v3PoolAbi } from "../sdk/abi.ts";
import { poolIdOf, type PoolKey } from "../sdk/infinity.ts";
import type { FeastNetwork, Hop } from "../sdk/networks.ts";
import { E18, coinPriceE18 } from "../sdk/price.ts";
import { permit2Abi } from "../sdk/venue-abi.ts";
import { AGENT_ID } from "./register/message.ts";

/**
 * The runtime's reads of BNB Smart Chain, for everything that touches money
 * (PLAN.md §2.2): registry checks, pool keys, spot prices, balances, allowances,
 * claimables and receipts. The indexer is for discovery; the chain is for money.
 *
 * Default RPC: the Binance dataseed, which serves receipts (the publicnode
 * endpoint refuses them). `FEAST_MAINNET_RPC_URL` overrides it; a keyed URL is
 * never printed.
 */

export const DEFAULT_MAINNET_RPC = "https://bsc-dataseed.binance.org";

/** The Binance Agent ID registry on BSC (SPACE ID's HandleRegistry): one address, one bare name; `handleOf` is the reverse read. */
export const AGENT_ID_REGISTRY: Address = "0x60b9262456de011f7d15a54cdd8c48baaa8b022f";
const handleRegistryAbi = [{ type: "function", name: "handleOf", stateMutability: "view", inputs: [{ name: "owner", type: "address" }], outputs: [{ name: "", type: "string" }] }] as const;

export type AgentIdRead = { state: "read"; id: string | null } | { state: "unreadable"; reason: string };

export type CoinInfo = { coin: Address; quote: Address; creator: Address; poolId: Hex; coinIsCurrency0: boolean; symbol: string; name: string };

type Cached<T> = { at: number; value: T };

export class LeagueChain {
  readonly client: PublicClient;
  private readonly coins = new Map<string, Promise<CoinInfo | null>>();
  private readonly keys = new Map<string, Promise<PoolKey>>();
  private bnbUsdCache: Cached<number> | null = null;
  private readonly quoteBnbCache = new Map<string, Cached<bigint>>();

  constructor(
    readonly network: FeastNetwork,
    rpcUrl: string = DEFAULT_MAINNET_RPC,
    private readonly ttlMs = 30_000,
  ) {
    const chain = { ...bsc, rpcUrls: { default: { http: [rpcUrl] } } };
    this.client = createPublicClient({ chain, transport: http(rpcUrl, { timeout: 20_000, retryCount: 2, retryDelay: 600 }) }) as PublicClient;
  }

  get wrappedNative(): Address {
    return this.network.contracts.wrappedNative;
  }

  /** A coin the Feast factory made — FEAST included — or null for anything else (L15). */
  coinInfo(coin: Address): Promise<CoinInfo | null> {
    const k = coin.toLowerCase();
    let pending = this.coins.get(k);
    if (!pending) {
      pending = (async () => {
        const info = await this.client.readContract({ address: this.network.contracts.factory, abi: factoryAbi, functionName: "getCoin", args: [coin] });
        if (info.quote === zeroAddress) return null;
        const [pool, symbol, name] = await Promise.all([
          this.client.readContract({ address: this.network.contracts.hook, abi: hookAbi, functionName: "poolInfo", args: [info.poolId] }) as Promise<{ coinIsCurrency0: boolean }>,
          this.client.readContract({ address: coin, abi: coinAbi, functionName: "symbol" }),
          this.client.readContract({ address: coin, abi: coinAbi, functionName: "name" }),
        ]);
        return { coin, quote: info.quote, creator: info.creator, poolId: info.poolId, coinIsCurrency0: pool.coinIsCurrency0, symbol, name };
      })();
      this.coins.set(k, pending);
      pending.catch(() => this.coins.delete(k));
    }
    return pending;
  }

  /**
   * The wallet's Binance Agent ID as the chain holds it: bare a–z 0–9, or null
   * when it has none (`handleOf` answers ""). A read that failed is
   * "unreadable", never "none". Only BSC has the registry.
   */
  async agentIdOf(wallet: Address): Promise<AgentIdRead> {
    if (this.network.chainId !== 56) return { state: "unreadable", reason: `the Agent ID registry is on BSC, not chain ${this.network.chainId}` };
    try {
      const id = await this.client.readContract({ address: AGENT_ID_REGISTRY, abi: handleRegistryAbi, functionName: "handleOf", args: [wallet] });
      return { state: "read", id: typeof id === "string" && AGENT_ID.test(id) ? id : null };
    } catch (error) {
      return { state: "unreadable", reason: String((error as Error).message).split("\n")[0]!.slice(0, 200) };
    }
  }

  /** Who the factory says launched a coin; null for a coin the factory never made; unreadable when the chain did not answer. */
  async creatorOf(coin: Address): Promise<Address | null | "unreadable"> {
    try {
      const info = await this.coinInfo(coin);
      return info ? info.creator : null;
    } catch {
      return "unreadable";
    }
  }

  async isFeastCoin(coin: Address): Promise<boolean> {
    return (await this.coinInfo(coin)) !== null;
  }

  /** The coin's pool key from the factory, held to the id the registry gave: a key that hashes elsewhere is refused. */
  poolKey(coin: Address): Promise<PoolKey> {
    const k = coin.toLowerCase();
    let pending = this.keys.get(k);
    if (!pending) {
      pending = (async () => {
        const [key, info] = await Promise.all([
          this.client.readContract({ address: this.network.contracts.factory, abi: factoryAbi, functionName: "poolKeyFor", args: [coin] }) as Promise<PoolKey>,
          this.coinInfo(coin),
        ]);
        if (!info) throw new Error(`${coin} is not a coin the Feast factory made`);
        if (poolIdOf(key).toLowerCase() !== info.poolId.toLowerCase()) throw new Error(`the factory's pool key for ${coin} does not hash to its registered pool id`);
        return key;
      })();
      this.keys.set(k, pending);
      pending.catch(() => this.keys.delete(k));
    }
    return pending;
  }

  /** The address book's v3 hops for a quote: wrapped native → quote on a buy, quote → wrapped native on a sale. */
  hops(quote: Address, side: "buy" | "sell"): Hop[] {
    if (quote.toLowerCase() === this.wrappedNative.toLowerCase()) return [];
    const stock = this.network.stocks.find((s) => s.address.toLowerCase() === quote.toLowerCase());
    if (!stock) throw new Error(`no route for quote ${quote} in the address book`);
    return side === "buy" ? stock.buy : stock.sell;
  }

  /** Quote tokens per coin, ×1e18, at the pool's spot price. */
  async spotQuotePerCoinE18(coin: Address): Promise<bigint> {
    const info = await this.coinInfo(coin);
    if (!info) throw new Error(`${coin} is not a coin the Feast factory made`);
    const [sqrtPriceX96] = await this.client.readContract({ address: this.network.contracts.poolManager, abi: poolManagerAbi, functionName: "getSlot0", args: [info.poolId] });
    return coinPriceE18(sqrtPriceX96, info.coinIsCurrency0);
  }

  async bnbUsd(now = Date.now()): Promise<number> {
    if (this.bnbUsdCache && now - this.bnbUsdCache.at < this.ttlMs) return this.bnbUsdCache.value;
    const { usdtNativePool, wrappedNative } = this.network.contracts;
    const [slot0, token0] = await Promise.all([
      this.client.readContract({ address: usdtNativePool, abi: v3PoolAbi, functionName: "slot0" }),
      this.client.readContract({ address: usdtNativePool, abi: v3PoolAbi, functionName: "token0" }),
    ]);
    const s = Number(slot0[0]) / 2 ** 96;
    const p = s * s;
    const usd = token0.toLowerCase() === wrappedNative.toLowerCase() ? p : 1 / p;
    this.bnbUsdCache = { at: now, value: usd };
    return usd;
  }

  /** BNB per quote token, ×1e18: 1 for WBNB; a stock token through its price pool (against USDT, or WBNB). */
  async quoteBnbE18(quote: Address, now = Date.now()): Promise<bigint> {
    if (quote.toLowerCase() === this.wrappedNative.toLowerCase()) return E18;
    const cached = this.quoteBnbCache.get(quote.toLowerCase());
    if (cached && now - cached.at < this.ttlMs) return cached.value;
    const stock = this.network.stocks.find((s) => s.address.toLowerCase() === quote.toLowerCase());
    if (!stock) throw new Error(`no price pool for quote ${quote} in the address book`);
    const [slot0, token0, token1] = await Promise.all([
      this.client.readContract({ address: stock.pricePool, abi: v3PoolAbi, functionName: "slot0" }),
      this.client.readContract({ address: stock.pricePool, abi: v3PoolAbi, functionName: "token0" }),
      this.client.readContract({ address: stock.pricePool, abi: v3PoolAbi, functionName: "token1" }),
    ]);
    const isToken0 = token0.toLowerCase() === quote.toLowerCase();
    const other = isToken0 ? token1 : token0;
    const s = Number(slot0[0]) / 2 ** 96;
    const inOther = isToken0 ? s * s : 1 / (s * s);
    let bnbPerQuote: number;
    if (other.toLowerCase() === this.wrappedNative.toLowerCase()) bnbPerQuote = inOther;
    else if (other.toLowerCase() === this.network.contracts.usdt.toLowerCase()) bnbPerQuote = inOther / (await this.bnbUsd(now));
    else throw new Error(`${stock.symbol}'s price pool pairs it with neither WBNB nor USDT`);
    const value = BigInt(Math.floor(bnbPerQuote * 1e18));
    this.quoteBnbCache.set(quote.toLowerCase(), { at: now, value });
    return value;
  }

  /** What `coins` of a coin are worth at spot, BNB in wei. */
  async markWei(coin: Address, coins: bigint): Promise<bigint> {
    const info = await this.coinInfo(coin);
    if (!info) throw new Error(`${coin} is not a coin the Feast factory made`);
    const [price, quoteBnb] = await Promise.all([this.spotQuotePerCoinE18(coin), this.quoteBnbE18(info.quote)]);
    return (coins * price * quoteBnb) / (E18 * E18);
  }

  /** A quote-token amount in BNB wei. */
  async quoteToBnbWei(quote: Address, amount: bigint): Promise<bigint> {
    return (amount * (await this.quoteBnbE18(quote))) / E18;
  }

  balance(owner: Address): Promise<bigint> {
    return this.client.getBalance({ address: owner });
  }

  tokenBalance(token: Address, owner: Address): Promise<bigint> {
    return this.client.readContract({ address: token, abi: coinAbi, functionName: "balanceOf", args: [owner] });
  }

  allowance(token: Address, owner: Address, spender: Address): Promise<bigint> {
    return this.client.readContract({ address: token, abi: coinAbi, functionName: "allowance", args: [owner, spender] });
  }

  async permit2Allowance(permit2: Address, owner: Address, token: Address, spender: Address): Promise<{ amount: bigint; expiration: number }> {
    const [amount, expiration] = (await this.client.readContract({ address: permit2, abi: permit2Abi, functionName: "allowance", args: [owner, token, spender] })) as readonly [bigint, number, number];
    return { amount, expiration: Number(expiration) };
  }

  claimable(key: PoolKey, account: Address): Promise<bigint> {
    return this.client.readContract({ address: this.network.contracts.hook, abi: hookAbi, functionName: "claimable", args: [key, account] });
  }

  async chainTime(): Promise<bigint> {
    return (await this.client.getBlock({ blockTag: "latest" })).timestamp;
  }

  receipt(hash: Hex, timeoutMs: number): Promise<TransactionReceipt> {
    return this.client.waitForTransactionReceipt({ hash, timeout: timeoutMs, pollingInterval: 1_500 });
  }
}
