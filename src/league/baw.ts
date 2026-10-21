import { execFile } from "node:child_process";
import { getAddress, isAddress, type Address, type Hex } from "viem";

import { previewDescribes, signRequestMessage, type RegisterFields } from "./register/message.ts";

/**
 * The Binance Agentic Wallet, through its `baw` CLI (PLAN.md §2.8).
 *
 * The runtime's whole surface on the wallet is the allowlist below, checked
 * before anything is spawned: reading its status, address, settings and
 * transaction lock, and Developer Mode's `contract-call preview → execute`. It
 * never sends, revokes, swaps or changes a setting — settings are App-only
 * anyway. `sign-message preview` serves the read-only checks. Its `execute` and
 * `result` serve one message only, the league's Register (task 941): `call()`
 * refuses them for any request id or order id this signer did not get from its
 * own `signRegistration` preview, and no method takes a raw message to sign.
 *
 * Arguments go to `execFile` as an array: no shell, nothing interpolated.
 */

export const BAW_ALLOWLIST: readonly string[] = [
  "wallet status",
  "wallet address",
  "wallet settings",
  "wallet tx-lock",
  "wallet balance",
  "contract-call preview",
  "contract-call execute",
  "sign-message preview",
  "sign-message execute",
  "sign-message result",
];

export type BawRunner = (args: readonly string[]) => Promise<{ stdout: string; stderr: string; code: number }>;

export class BawError extends Error {
  override name = "BawError";
  constructor(
    message: string,
    readonly code: string | number | null,
    readonly errorName: string | null,
  ) {
    super(message);
  }
}

/** Addresses out of anything the wallet said that may end up in a log. */
export function redactAddresses(text: string): string {
  return text.replace(/0x[0-9a-fA-F]{40}/g, "0x…");
}

export function execRunner(binary = process.env.FEAST_LEAGUE_BAW?.trim() || "baw", timeoutMs = 90_000): BawRunner {
  return (args) =>
    new Promise((resolve) => {
      execFile(binary, [...args], { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, encoding: "utf8" }, (error, stdout, stderr) => {
        const code = error ? (typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === "number" ? Number((error as { code: number }).code) : 1) : 0;
        resolve({ stdout: stdout ?? "", stderr: stderr ?? (error ? String(error.message) : ""), code });
      });
    });
}

export type WalletSettings = {
  devModeEnabled: boolean;
  /** Unix seconds, or null. */
  devModeExpiresAt: number | null;
  devModeDailyLimitUsd: number | null;
  devModeQuotaUsedUsd: number | null;
  balanceExceeded: boolean;
  sessionExpireTime: string | null;
  inactiveSignOutTime: string | null;
  /** The fixed end of this sign-in (measured 2026-10-22: about 7 days after it), unlike the two above, which every read pushes 48 h ahead. */
  signInMaxTime?: string | null;
  abnormalTxnHandling: string | null;
};

export type ExecuteResult = { status: string; txHash: Hex | null; orderId: string | null; message: string | null };

/** What a Register signature came to (docs/PLAN-941.md §1.7). */
export type SignOutcome =
  | { kind: "signed"; signature: string; recovery: string | null }
  | { kind: "declined" }
  | { kind: "expired" }
  | { kind: "mismatch"; reason: string }
  | { kind: "refused"; reason: string }
  | { kind: "not-ready"; reason: "signed-out" | "devmode" };

export type SignOptions = { onPending?: () => void; waitMs?: number; pollMs?: number; sleep?: (ms: number) => Promise<void> };

/** What registration needs from a wallet. */
export interface RegistrationSigner {
  status(): Promise<{ connected: boolean; status: string }>;
  address(): Promise<Address>;
  settings(): Promise<WalletSettings>;
  signRegistration(fields: RegisterFields, options?: SignOptions): Promise<SignOutcome>;
}

/** What the executor needs from a wallet: the real one through `baw`, or a fake in tests. */
export interface Signer {
  status(): Promise<{ connected: boolean; status: string }>;
  address(): Promise<Address>;
  settings(): Promise<WalletSettings>;
  txLock(): Promise<"UNLOCKED" | "LOCKED">;
  preview(call: { from: Address; to: Address; value: bigint; data: Hex }): Promise<unknown>;
  execute(requestId: string): Promise<ExecuteResult>;
  signMessagePreview(message: string): Promise<unknown>;
}

type Envelope = { success?: boolean; data?: unknown; error?: { code?: number | string; name?: string; message?: string } };

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
/** A time as Unix seconds: the docs show seconds; live, on 2026-10-21, `devMode.expiresAt` was an ISO date. Both are read. */
const unixSeconds = (v: unknown): number | null => {
  const n = num(v);
  if (n !== null) return n > 1e12 ? Math.floor(n / 1_000) : n;
  if (typeof v === "string" && Number.isFinite(Date.parse(v))) return Math.floor(Date.parse(v) / 1_000);
  return null;
};

/** The value after a flag given exactly once; empty when it is missing or repeated. */
const after = (args: readonly string[], flag: string) => {
  const i = args.indexOf(flag);
  return i >= 0 && args.lastIndexOf(flag) === i ? (args[i + 1] ?? "") : "";
};
const ID = /^[\w.:=+/-]{1,256}$/;

export class BawSigner implements Signer, RegistrationSigner {
  /** Every command the signer ran, by name only (no arguments, so no addresses). */
  readonly invocations: string[] = [];
  /** Request ids of this signer's own Register previews, and until when they may be executed. */
  private readonly registerRequests = new Map<string, number>();
  /** Order ids of this signer's own Register signatures awaiting the App. */
  private readonly registerOrders = new Set<string>();

  constructor(
    private readonly run: BawRunner = execRunner(),
    private readonly onInvoke: (command: string) => void = () => {},
    readonly chainId = "56",
    private readonly clock: () => number = Date.now,
  ) {}

  /** Run one allowlisted command and return its `data`, or the wallet's own error. */
  async call(command: string, args: readonly string[]): Promise<{ envelope: Envelope; data: unknown }> {
    if (!BAW_ALLOWLIST.includes(command)) throw new BawError(`"baw ${command}" is not a command the league runtime may run`, null, "NOT_ALLOWED");
    if (command === "sign-message execute") {
      const id = after(args, "--requestId");
      const until = this.registerRequests.get(id);
      if (until === undefined || this.clock() > until) throw new BawError("only this signer's own league Register preview may be signed", null, "NOT_ALLOWED");
      this.registerRequests.delete(id);
    }
    if (command === "sign-message result" && !this.registerOrders.has(after(args, "--order-id"))) throw new BawError("only this signer's own league Register signature may be fetched", null, "NOT_ALLOWED");
    this.invocations.push(command);
    this.onInvoke(command);
    const out = await this.run([...command.split(" "), ...args, "--json"]);
    let envelope: Envelope;
    try {
      envelope = JSON.parse(out.stdout) as Envelope;
    } catch {
      const said = redactAddresses((out.stdout || out.stderr).trim()).slice(0, 300);
      throw new BawError(`baw ${command} did not answer in JSON (exit ${out.code}): ${said}`, out.code, "UNPARSEABLE");
    }
    return { envelope, data: envelope.data };
  }

  private async ok(command: string, args: readonly string[]): Promise<unknown> {
    const { envelope, data } = await this.call(command, args);
    if (envelope.success === false || envelope.error) {
      const e = envelope.error ?? {};
      throw new BawError(`baw ${command}: ${e.name ?? "error"} ${e.code ?? ""} ${redactAddresses(e.message ?? "")}`.trim(), e.code ?? null, e.name ?? null);
    }
    return data;
  }

  async status(): Promise<{ connected: boolean; status: string }> {
    const data = (await this.ok("wallet status", [])) as { status?: string } | undefined;
    const status = data?.status ?? "UNKNOWN";
    return { connected: status === "CONNECTED", status };
  }

  async address(): Promise<Address> {
    const data = (await this.ok("wallet address", [])) as { addresses?: { binanceChainId?: string; address?: string }[] } | undefined;
    const entry = data?.addresses?.find((a) => String(a.binanceChainId) === this.chainId);
    if (!entry?.address || !isAddress(entry.address)) throw new BawError(`the wallet has no address on chain ${this.chainId}`, null, "NO_ADDRESS");
    return getAddress(entry.address);
  }

  async settings(): Promise<WalletSettings> {
    const d = ((await this.ok("wallet settings", [])) ?? {}) as Record<string, unknown>;
    const dev = (d.devMode ?? {}) as Record<string, unknown>;
    return {
      devModeEnabled: dev.enabled === true,
      devModeExpiresAt: unixSeconds(dev.expiresAt),
      devModeDailyLimitUsd: num(dev.dailyLimit),
      devModeQuotaUsedUsd: num(d.developerModeQuotaUsed),
      balanceExceeded: dev.balanceExceeded === true,
      sessionExpireTime: str(d.sessionExpireTime),
      inactiveSignOutTime: str(d.inactiveSignOutTime),
      signInMaxTime: str(d.signInMaxTime),
      abnormalTxnHandling: str(d.abnormalTxnHandling),
    };
  }

  async txLock(): Promise<"UNLOCKED" | "LOCKED"> {
    const data = (await this.ok("wallet tx-lock", ["--binanceChainId", this.chainId])) as { status?: string } | undefined;
    return data?.status === "UNLOCKED" ? "UNLOCKED" : "LOCKED";
  }

  /** The preview's whole answer, success or refusal: the gate reads it. */
  async preview(call: { from: Address; to: Address; value: bigint; data: Hex }): Promise<unknown> {
    const { envelope } = await this.call("contract-call preview", [
      "--binanceChainId",
      this.chainId,
      "--from",
      call.from,
      "--to",
      call.to,
      "--value",
      call.value.toString(),
      "--inputData",
      call.data,
    ]);
    return envelope;
  }

  async execute(requestId: string): Promise<ExecuteResult> {
    if (!/^[\w.:=+/-]{1,256}$/.test(requestId)) throw new BawError("a preview's request id has an unexpected shape", null, "BAD_REQUEST_ID");
    const d = ((await this.ok("contract-call execute", ["--requestId", requestId])) ?? {}) as Record<string, unknown>;
    const hash = str(d.txHash);
    return {
      status: str(d.status) ?? "UNKNOWN",
      txHash: hash && /^0x[0-9a-fA-F]{64}$/.test(hash) ? (hash as Hex) : null,
      orderId: str(d.orderId),
      message: str(d.message),
    };
  }

  /** Preview only: what it previews can never be executed (`call()` refuses any request id it did not get from `signRegistration`). */
  async signMessagePreview(message: string): Promise<unknown> {
    const { envelope } = await this.call("sign-message preview", ["--binanceChainId", this.chainId, "--signType", "EIP712", "--message", message]);
    return envelope;
  }

  /**
   * Sign the league's Register message (docs/PLAN-941.md §5.3): the wallet is
   * signed in and in Developer Mode; its preview reads back exactly these
   * fields and flags no risk; then execute, and, if the App must confirm, ask
   * for the result every `pollMs` for up to `waitMs`. The message is built here
   * from the fields, never taken raw.
   */
  async signRegistration(fields: RegisterFields, options: SignOptions = {}): Promise<SignOutcome> {
    const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const status = await this.status();
    if (!status.connected) return { kind: "not-ready", reason: "signed-out" };
    if (!(await this.settings()).devModeEnabled) return { kind: "not-ready", reason: "devmode" };

    const { envelope } = await this.call("sign-message preview", ["--binanceChainId", this.chainId, "--signType", "EIP712", "--message", signRequestMessage(fields)]);
    if (envelope.success === false || envelope.error) {
      const e = envelope.error ?? {};
      return { kind: "refused", reason: redactAddresses(`${e.name ?? "error"} ${e.code ?? ""} ${e.message ?? ""}`.trim()) };
    }
    const d = (envelope.data ?? {}) as { requestId?: unknown; parsedMessage?: unknown; risks?: { riskDetails?: unknown[]; riskBehaviors?: unknown[] }; expiresAt?: unknown };
    if (typeof d.requestId !== "string" || !ID.test(d.requestId)) return { kind: "refused", reason: "the preview gave no request id" };
    const described = previewDescribes(d.parsedMessage, fields);
    if (!described.ok) return { kind: "mismatch", reason: described.reason };
    const flagged = [...(d.risks?.riskDetails ?? []), ...(d.risks?.riskBehaviors ?? [])];
    if (flagged.length > 0) return { kind: "mismatch", reason: `the wallet flagged a risk: ${redactAddresses(JSON.stringify(flagged)).slice(0, 200)}` };
    const expires = typeof d.expiresAt === "number" && Number.isFinite(d.expiresAt) ? d.expiresAt : Number.POSITIVE_INFINITY;
    this.registerRequests.set(d.requestId, Math.min(expires, this.clock() + 10 * 60_000));

    const answer = (raw: unknown): SignOutcome | "pending" => {
      const a = (raw ?? {}) as Record<string, unknown>;
      if (a.status === "COMPLETED" && typeof a.signature === "string") return { kind: "signed", signature: a.signature, recovery: str(a.signatureRecovery) };
      if (a.status === "PENDING_CONFIRMATION") return "pending";
      if (a.status === "REJECTED") return { kind: "declined" };
      if (a.status === "EXPIRED") return { kind: "expired" };
      return { kind: "refused", reason: `the wallet answered ${String(a.status ?? "nothing")}` };
    };
    let executed: unknown;
    try {
      executed = await this.ok("sign-message execute", ["--requestId", d.requestId]);
    } catch (error) {
      return { kind: "refused", reason: error instanceof BawError ? error.message : String(error) };
    }
    const first = answer(executed);
    if (first !== "pending") return first;
    const orderId = str((executed as Record<string, unknown>).orderId);
    if (!orderId || !ID.test(orderId)) return { kind: "refused", reason: "the wallet asked for the App's confirmation but gave no order id" };
    this.registerOrders.add(orderId);
    options.onPending?.();
    const until = this.clock() + (options.waitMs ?? 10 * 60_000);
    try {
      // A failed poll is asked again: the user may be approving in the App right now. Three in a row end the wait.
      let failures = 0;
      while (this.clock() < until) {
        await sleep(options.pollMs ?? 5_000);
        let raw: unknown;
        try {
          raw = await this.ok("sign-message result", ["--order-id", orderId]);
          failures = 0;
        } catch (error) {
          failures += 1;
          if (failures >= 3) return { kind: "refused", reason: `the wallet's result could not be read: ${error instanceof BawError ? error.message : String(error)}` };
          continue;
        }
        const next = answer(raw);
        if (next !== "pending") return next;
      }
      return { kind: "expired" };
    } finally {
      this.registerOrders.delete(orderId);
    }
  }
}
