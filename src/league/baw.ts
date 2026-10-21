import { execFile } from "node:child_process";
import { getAddress, isAddress, type Address, type Hex } from "viem";

/**
 * The Binance Agentic Wallet, through its `baw` CLI (PLAN.md §2.8).
 *
 * The runtime's whole surface on the wallet is the allowlist below, checked
 * before anything is spawned: reading its status, address, settings and
 * transaction lock, and Developer Mode's `contract-call preview → execute`. It
 * never sends, revokes, swaps or changes a setting — settings are App-only
 * anyway. `sign-message preview` is allowed for one read-only check; its
 * `execute` is not, so nothing can ever be signed through it here.
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
  abnormalTxnHandling: string | null;
};

export type ExecuteResult = { status: string; txHash: Hex | null; orderId: string | null; message: string | null };

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

export class BawSigner implements Signer {
  /** Every command the signer ran, by name only (no arguments, so no addresses). */
  readonly invocations: string[] = [];

  constructor(
    private readonly run: BawRunner = execRunner(),
    private readonly onInvoke: (command: string) => void = () => {},
    readonly chainId = "56",
  ) {}

  /** Run one allowlisted command and return its `data`, or the wallet's own error. */
  async call(command: string, args: readonly string[]): Promise<{ envelope: Envelope; data: unknown }> {
    if (!BAW_ALLOWLIST.includes(command)) throw new BawError(`"baw ${command}" is not a command the league runtime may run`, null, "NOT_ALLOWED");
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

  /** Preview only: `sign-message execute` is not on the allowlist, so nothing is ever signed here. */
  async signMessagePreview(message: string): Promise<unknown> {
    const { envelope } = await this.call("sign-message preview", ["--binanceChainId", this.chainId, "--signType", "EIP712", "--message", message]);
    return envelope;
  }
}
