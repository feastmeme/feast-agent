import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { maxUint256, parseEventLogs, type Address, type Hex, type TransactionReceipt } from "viem";

import { hookAbi } from "../sdk/abi.ts";
import { FeastClient } from "../sdk/client.ts";
import { MAX_UINT160, approveCall, buyCall, claimCreatorCall, permit2ApproveCall, sellCall, type Call, type TradePlan } from "../sdk/infinity.ts";
import type { FeastNetwork } from "../sdk/networks.ts";
import { E18 } from "../sdk/price.ts";
import { quoteBuy, quoteBuyInQuote, quoteSell } from "../sdk/quoter.ts";
import { creationsOf, hookFillsOf, nativeLegsOf } from "../sdk/receipts.ts";
import { BawError, redactAddresses, type Signer } from "./baw.ts";
import type { CoinInfo, LeagueChain } from "./chain.ts";
import { withHostHeaders } from "./headers.ts";
import { callRefusal, gatePreview, summarizePreview, type Targets } from "./gate.ts";

/**
 * From an approved intent to a checked receipt (PLAN.md §2.5–2.7).
 *
 * Every action takes the same path, one at a time: the call allowlist, the stop
 * file, the wallet's transaction lock, `contract-call preview`, the gate, the
 * stop file again (a stop between preview and execute wins), `execute`, and the
 * receipt — whose fills are read from the hook's own events for this wallet and
 * this coin, never taken from the request. The executor keeps no state of its
 * own; the runtime books what it returns.
 */

/**
 * Where a send stopped. `execute` means the wallet's answer was lost (it threw, timed out or was
 * unreadable), so the transaction may have gone out; `declined` means the wallet answered that it
 * did not broadcast. The runtime keeps the first, with `receipt` and `confirmation`, as an outcome
 * not known yet.
 */
export type Stage = "allowlist" | "stopped" | "busy" | "preview" | "gate" | "execute" | "declined" | "confirmation" | "receipt" | "reverted" | "mismatch" | "prepare";

export type SendOutcome =
  | { ok: true; txHash: Hex; receipt: TransactionReceipt; gasWei: bigint }
  | { ok: false; stage: Stage; reason: string; txHash?: Hex; sent: boolean };

export type ExecutorDeps = {
  signer: Signer;
  chain: LeagueChain;
  /** The wallet, read from `baw wallet address` at start; held in memory only. */
  wallet: Address;
  network: FeastNetwork;
  rpcUrl: string;
  stopReason: () => string | null;
  log: (event: string, fields: Record<string, unknown>) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  receiptTimeoutMs?: number;
  lockWaitMs?: number;
  /** A trade's deadline, from the chain's clock: short, so a delayed signal never fills late. */
  deadlineSeconds?: number;
  /** What a launch pins its picture and metadata through (the Feast site's `/api/pin`); tests pass a fake. */
  fetch?: typeof fetch;
};

export type PreparedBuy = { call: Call; info: CoinInfo; quotedOut: bigint; minOut: bigint; impactPct: number; sizeWei: bigint; payIn: "native" | "quote" };
export type PreparedSell = { call: Call; info: CoinInfo; coinsIn: bigint; quotedOut: bigint; minOut: bigint; quotedBy: "quoter" | "spot" };
export type Prepared<T> = { ok: true; value: T } | { ok: false; reason: string };

/** The hook's 1% on the quote leg of a buy, in pips. */
const HOOK_FEE_PIPS = 10_000n;
const PIPS = 1_000_000n;

const slipFloor = (amount: bigint, slippagePct: number) => (amount * BigInt(10_000 - Math.round(slippagePct * 100))) / 10_000n;
const say = (error: unknown) => redactAddresses(error instanceof Error ? (error as { shortMessage?: string }).shortMessage ?? error.message : String(error)).slice(0, 400);

export class Executor {
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly approvable = new Set<string>();
  readonly router: Address;
  readonly permit2: Address;
  readonly mixedQuoter: Address;

  constructor(private readonly deps: ExecutorDeps) {
    if (deps.network.trade.kind !== "infinity") throw new Error("the league trades on BNB Smart Chain through the Universal Router");
    this.router = deps.network.trade.router;
    this.permit2 = deps.network.trade.permit2;
    this.mixedQuoter = deps.network.trade.mixedQuoter;
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  targets(): Targets {
    return {
      router: this.router,
      factory: this.deps.network.contracts.factory,
      hook: this.deps.network.contracts.hook,
      permit2: this.permit2,
      approvable: (token) => this.approvable.has(token.toLowerCase()),
    };
  }

  /** A coin the factory made, and its quote token, become approvable for Permit2. */
  private async known(coin: Address): Promise<CoinInfo | null> {
    const info = await this.deps.chain.coinInfo(coin);
    if (info) {
      this.approvable.add(info.coin.toLowerCase());
      this.approvable.add(info.quote.toLowerCase());
    }
    return info;
  }

  private label(call: Call): string {
    const to = call.to.toLowerCase();
    if (to === this.router.toLowerCase()) return "router";
    if (to === this.permit2.toLowerCase()) return "permit2";
    if (to === this.deps.network.contracts.factory.toLowerCase()) return "factory";
    if (to === this.deps.network.contracts.hook.toLowerCase()) return "hook";
    return "token";
  }

  /** The one path every transaction takes. */
  async send(what: string, call: Call): Promise<SendOutcome> {
    const fail = (stage: Stage, reason: string, extra: { txHash?: Hex; sent?: boolean } = {}): SendOutcome => {
      this.deps.log("send.failed", { what, stage, reason, txHash: extra.txHash });
      return { ok: false, stage, reason, txHash: extra.txHash, sent: extra.sent ?? false };
    };
    const refused = callRefusal(call, this.targets());
    if (refused) return fail("allowlist", refused);
    const stop = this.deps.stopReason();
    if (stop) return fail("stopped", stop);

    // One pending transaction per chain: wait for the wallet to be free.
    const lockDeadline = this.now() + (this.deps.lockWaitMs ?? 60_000);
    for (;;) {
      let lock: "UNLOCKED" | "LOCKED";
      try {
        lock = await this.deps.signer.txLock();
      } catch (error) {
        return fail("busy", `the wallet's transaction lock could not be read: ${say(error)}`);
      }
      if (lock === "UNLOCKED") break;
      if (this.now() >= lockDeadline) return fail("busy", "the wallet is busy: a transaction is pending or waits for a confirmation in the Binance App");
      await this.sleep(3_000);
      const again = this.deps.stopReason();
      if (again) return fail("stopped", again);
    }

    let answer: unknown;
    try {
      answer = await this.deps.signer.preview({ from: this.deps.wallet, to: call.to, value: call.value, data: call.data });
    } catch (error) {
      return fail("preview", say(error));
    }
    const summary = summarizePreview(answer);
    this.deps.log("preview", {
      what,
      to: this.label(call),
      valueWei: call.value,
      requestId: summary.requestId,
      simulationCode: summary.simulationCode,
      simulationError: summary.simulationError,
      risks: summary.risks,
      flaggedAddresses: summary.flaggedAddresses,
      requireConfirmation: summary.requireConfirmation,
      transactionType: summary.transactionType,
      error: summary.error,
    });
    const gate = gatePreview(summary, this.now());
    if (!gate.ok) return fail("gate", gate.reason);

    const late = this.deps.stopReason();
    if (late) return fail("stopped", `${late} (after the preview; nothing executed)`);

    let executed;
    try {
      executed = await this.deps.signer.execute(summary.requestId!);
    } catch (error) {
      return fail("execute", error instanceof BawError ? error.message : say(error));
    }
    this.deps.log("execute", { what, status: executed.status, txHash: executed.txHash });
    if (executed.status === "PENDING_CONFIRMATION") {
      return fail("confirmation", "the wallet asks for a confirmation in the Binance App: approve or reject it there (it was not expected; nothing more is sent until the wallet is free)");
    }
    if (executed.status !== "BROADCASTED") return fail("declined", `execute answered ${executed.status}${executed.message ? `: ${executed.message}` : ""}`);
    const txHash = executed.txHash;
    if (!txHash) return fail("execute", "execute answered BROADCASTED with no transaction hash");

    let receipt: TransactionReceipt;
    try {
      receipt = await this.deps.chain.receipt(txHash, this.deps.receiptTimeoutMs ?? 120_000);
    } catch (error) {
      return fail("receipt", `no receipt for ${txHash}: ${say(error)}`, { txHash, sent: true });
    }
    if (receipt.status !== "success") return fail("reverted", `${txHash} reverted`, { txHash, sent: true });
    const gasWei = receipt.gasUsed * (receipt.effectiveGasPrice ?? 0n);
    this.deps.log("receipt", { what, txHash, block: receipt.blockNumber, gasUsed: receipt.gasUsed, gasWei });
    return { ok: true, txHash, receipt, gasWei };
  }

  /**
   * Preview only (PLAN.md §8.2): the same allowlist, stop file and lock, then the
   * wallet's preview and what the gate would say of it. There is no execute on
   * this path at all, so nothing can be sent from it.
   */
  async previewOnly(what: string, call: Call): Promise<{ ok: true; summary: ReturnType<typeof summarizePreview>; gate: ReturnType<typeof gatePreview> } | { ok: false; stage: Stage; reason: string }> {
    const refused = callRefusal(call, this.targets());
    if (refused) return { ok: false, stage: "allowlist", reason: refused };
    const stop = this.deps.stopReason();
    if (stop) return { ok: false, stage: "stopped", reason: stop };
    try {
      if ((await this.deps.signer.txLock()) !== "UNLOCKED") return { ok: false, stage: "busy", reason: "the wallet is busy" };
      const answer = await this.deps.signer.preview({ from: this.deps.wallet, to: call.to, value: call.value, data: call.data });
      const summary = summarizePreview(answer);
      const gate = gatePreview(summary, this.now());
      this.deps.log("preview.only", { what, to: this.label(call), valueWei: call.value, ...summary, gate });
      return { ok: true, summary, gate };
    } catch (error) {
      return { ok: false, stage: "preview", reason: say(error) };
    }
  }

  /** Make a token approvable for Permit2 (a coin the factory made, or a pool's quote), for the preview-only checks. */
  async learn(coin: Address): Promise<CoinInfo | null> {
    return this.known(coin);
  }

  private async deadline(): Promise<bigint> {
    return (await this.deps.chain.chainTime()) + BigInt(this.deps.deadlineSeconds ?? 300);
  }

  /** A buy of `sizeWei` native wei (or, paid in the quote, `sizeWei` of the quote token), quoted as the wallet. */
  async prepareBuy(coin: Address, sizeWei: bigint, slippagePct: number, payIn: "native" | "quote" = "native"): Promise<Prepared<PreparedBuy>> {
    try {
      const info = await this.known(coin);
      if (!info) return { ok: false, reason: `${coin} is not a coin the Feast factory made` };
      const poolKey = await this.deps.chain.poolKey(coin);
      const hops = payIn === "quote" ? [] : this.deps.chain.hops(info.quote, "buy");
      const request = {
        client: this.deps.chain.client,
        mixedQuoter: this.mixedQuoter,
        wrappedNative: this.deps.network.contracts.wrappedNative,
        coin,
        quote: info.quote,
        poolKey,
        hops,
        amountIn: sizeWei,
        hookData: "0x" as Hex,
        account: this.deps.wallet,
      };
      const [quoted, spot, deadline] = await Promise.all([
        payIn === "quote" ? quoteBuyInQuote(request) : quoteBuy(request),
        this.deps.chain.spotQuotePerCoinE18(coin),
        this.deadline(),
      ]);
      // Impact: the coins the quote gives against the coins the leg would buy at spot, after the hook's 1%.
      const spotOut = spot > 0n ? (quoted.legQuote * (PIPS - HOOK_FEE_PIPS) * E18) / (PIPS * spot) : 0n;
      const impactPct = spotOut > 0n && quoted.out < spotOut ? Number(((spotOut - quoted.out) * 1_000_000n) / spotOut) / 10_000 : 0;
      const minOut = slipFloor(quoted.out, slippagePct);
      const plan: TradePlan = {
        wrappedNative: this.deps.network.contracts.wrappedNative,
        quote: info.quote,
        coin,
        hops,
        poolKey,
        amountIn: sizeWei,
        minOut,
        hookData: "0x",
        payIn,
      };
      return { ok: true, value: { call: buyCall(this.router, plan, deadline), info, quotedOut: quoted.out, minOut, impactPct, sizeWei, payIn } };
    } catch (error) {
      return { ok: false, reason: `the buy could not be prepared: ${say(error)}` };
    }
  }

  /** A sale of up to `coins`, capped by what the wallet holds; quoted by the venue, or from spot if the quoter refuses. */
  async prepareSell(coin: Address, coins: bigint, slippagePct: number): Promise<Prepared<PreparedSell>> {
    try {
      const info = await this.known(coin);
      if (!info) return { ok: false, reason: `${coin} is not a coin the Feast factory made` };
      const held = await this.deps.chain.tokenBalance(coin, this.deps.wallet);
      const coinsIn = coins < held ? coins : held;
      if (coinsIn <= 0n) return { ok: false, reason: "the wallet holds none of this coin" };
      const poolKey = await this.deps.chain.poolKey(coin);
      const hops = this.deps.chain.hops(info.quote, "sell");
      let quotedOut: bigint;
      let quotedBy: "quoter" | "spot" = "quoter";
      try {
        quotedOut = (
          await quoteSell({
            client: this.deps.chain.client,
            mixedQuoter: this.mixedQuoter,
            wrappedNative: this.deps.network.contracts.wrappedNative,
            coin,
            quote: info.quote,
            poolKey,
            hops,
            amountIn: coinsIn,
            hookData: "0x",
            account: this.deps.wallet,
          })
        ).out;
      } catch (error) {
        // The plan's fallback (§8.2): the floor from spot less the hook's 1%; the wallet's simulation re-checks it.
        const mark = await this.deps.chain.markWei(coin, coinsIn);
        quotedOut = (mark * (PIPS - HOOK_FEE_PIPS)) / PIPS;
        quotedBy = "spot";
        this.deps.log("quote.fallback", { coin, reason: say(error) });
      }
      const minOut = slipFloor(quotedOut, slippagePct);
      const plan: TradePlan = {
        wrappedNative: this.deps.network.contracts.wrappedNative,
        quote: info.quote,
        coin,
        hops,
        poolKey,
        amountIn: coinsIn,
        minOut,
        hookData: "0x",
      };
      return { ok: true, value: { call: sellCall(this.router, plan, await this.deadline()), info, coinsIn, quotedOut, minOut, quotedBy } };
    } catch (error) {
      return { ok: false, reason: `the sale could not be prepared: ${say(error)}` };
    }
  }

  /**
   * Arming a token: what Permit2 needs so the router can move it — the token's
   * approval of Permit2 (once) and Permit2's allowance for the router (30 days).
   * Only the calls still needed are returned.
   */
  async armCalls(token: Address): Promise<Prepared<{ label: string; call: Call }[]>> {
    try {
      const info = await this.known(token);
      if (!info && !this.approvable.has(token.toLowerCase())) return { ok: false, reason: `${token} is not a Feast coin or a pool's quote token` };
      const [erc20, p2, now] = await Promise.all([
        this.deps.chain.allowance(token, this.deps.wallet, this.permit2),
        this.deps.chain.permit2Allowance(this.permit2, this.deps.wallet, token, this.router),
        this.deps.chain.chainTime(),
      ]);
      const calls: { label: string; call: Call }[] = [];
      if (erc20 < maxUint256 / 2n) calls.push({ label: "approve Permit2", call: approveCall(token, this.permit2) });
      const week = 7n * 24n * 3600n;
      if (p2.amount < MAX_UINT160 / 2n || BigInt(p2.expiration) < now + week) {
        calls.push({ label: "Permit2 allowance for the router", call: permit2ApproveCall(this.permit2, token, this.router, MAX_UINT160, now + 30n * 24n * 3600n) });
      }
      return { ok: true, value: calls };
    } catch (error) {
      return { ok: false, reason: `the token could not be armed: ${say(error)}` };
    }
  }

  /**
   * A launch: the existing SDK path (metadata pinned through the site unless a digest is given). A picture
   * named on the request is read here and pinned only if its bytes are still the ones the card showed;
   * without one, the SDK draws the ticker's identicon.
   */
  async prepareLaunch(launch: { name: string; symbol: string; quote: string; description?: string; burn?: number; referrer?: number; metadataHash?: Hex; image?: { path: string; sha256: string } }): Promise<Prepared<{ call: Call; predicted: Address; quote: Address }>> {
    try {
      let image: Uint8Array | undefined;
      if (launch.image) {
        const bytes = new Uint8Array(readFileSync(launch.image.path));
        if (createHash("sha256").update(bytes).digest("hex") !== launch.image.sha256) return { ok: false, reason: "the launch picture is not the one the card showed (its sha256 differs): nothing was pinned" };
        image = bytes;
      }
      // The SDK pins at the network's site: that request carries the host's and the release's headers (task 975).
      const feast = new FeastClient({ network: { ...this.deps.network, rpcUrl: this.deps.rpcUrl }, fetch: withHostHeaders(this.deps.fetch ?? fetch, [this.deps.network.siteUrl]) });
      const prepared = await feast.prepareLaunch(
        { name: launch.name, symbol: launch.symbol, quote: launch.quote, description: launch.description, burn: launch.burn, referrer: launch.referrer, metadataHash: launch.metadataHash, image },
        this.deps.wallet,
      );
      return { ok: true, value: { call: { to: prepared.request.to, data: prepared.request.data, value: prepared.request.value }, predicted: prepared.predicted, quote: prepared.quote.address } };
    } catch (error) {
      return { ok: false, reason: `the launch could not be prepared: ${say(error)}` };
    }
  }

  /** The creator's claim on a pool, if it is owed anything. */
  async prepareClaim(coin: Address): Promise<Prepared<{ call: Call; claimable: bigint; quote: Address } | null>> {
    try {
      const info = await this.known(coin);
      if (!info) return { ok: false, reason: `${coin} is not a coin the Feast factory made` };
      const key = await this.deps.chain.poolKey(coin);
      const claimable = await this.deps.chain.claimable(key, this.deps.wallet);
      if (claimable === 0n) return { ok: true, value: null };
      return { ok: true, value: { call: claimCreatorCall(this.deps.network.contracts.hook, key), claimable, quote: info.quote } };
    } catch (error) {
      return { ok: false, reason: `the claim could not be prepared: ${say(error)}` };
    }
  }

  // --- what a receipt says happened, for this wallet ---------------------------------------

  /** A buy's fills: the hook's Trade events paid by this wallet for this coin, and the router's wrap of exactly the size. */
  verifyBuy(receipt: TransactionReceipt, prepared: PreparedBuy): { ok: true; coinsOut: bigint; quoteIn: bigint; fee: bigint } | { ok: false; reason: string } {
    const fills = hookFillsOf(receipt, { hook: this.deps.network.contracts.hook, payer: this.deps.wallet, coin: prepared.info.coin });
    if (fills.buy.fills === 0) return { ok: false, reason: "the receipt holds no hook Trade for this wallet buying this coin" };
    if (prepared.payIn === "native") {
      const legs = nativeLegsOf(receipt, { wrappedNative: this.deps.network.contracts.wrappedNative, router: this.router });
      if (legs.wrapped !== prepared.sizeWei) return { ok: false, reason: `the router wrapped ${legs.wrapped} wei, not the ${prepared.sizeWei} asked` };
    }
    return { ok: true, coinsOut: fills.buy.coinAmount, quoteIn: fills.buy.quoteAmount, fee: fills.buy.fee };
  }

  verifySell(receipt: TransactionReceipt, prepared: PreparedSell): { ok: true; coinsIn: bigint; bnbOutWei: bigint } | { ok: false; reason: string } {
    const fills = hookFillsOf(receipt, { hook: this.deps.network.contracts.hook, payer: this.deps.wallet, coin: prepared.info.coin });
    if (fills.sell.fills === 0) return { ok: false, reason: "the receipt holds no hook Trade for this wallet selling this coin" };
    const legs = nativeLegsOf(receipt, { wrappedNative: this.deps.network.contracts.wrappedNative, router: this.router });
    return { ok: true, coinsIn: fills.sell.coinAmount, bnbOutWei: legs.unwrapped };
  }

  verifyLaunch(receipt: TransactionReceipt): { ok: true; coin: Address; poolId: Hex } | { ok: false; reason: string } {
    const created = creationsOf(receipt, { factory: this.deps.network.contracts.factory, creator: this.deps.wallet });
    const [event] = created;
    if (created.length !== 1 || !event) return { ok: false, reason: `the receipt holds ${created.length} coin creations by this wallet` };
    return { ok: true, coin: event.args.coin, poolId: event.args.poolId };
  }

  verifyClaim(receipt: TransactionReceipt): bigint {
    return parseEventLogs({ abi: hookAbi, logs: receipt.logs, eventName: "CreatorPaid", strict: false })
      .filter((log) => log.address.toLowerCase() === this.deps.network.contracts.hook.toLowerCase() && log.args.creator?.toLowerCase() === this.deps.wallet.toLowerCase())
      .reduce((sum, log) => sum + (log.args.amount ?? 0n), 0n);
  }
}
