import { createTransport, http, type EIP1193RequestFn, type Transport } from "viem";

/**
 * The chain's RPC with a fallback (task 975, addendum 8, gap G5). `FEAST_MAINNET_RPC_URL` (or the Binance dataseed)
 * stays first; behind it, the other Binance dataseeds and publicnode, last because it refuses receipts. An endpoint
 * is passed over only on a transport failure (no answer, a timeout, an HTTP error such as a 429 or a 5xx, a "limit
 * exceeded"), then rests 60 s before it is tried again; an answer the node gave (a revert, a bad parameter) is the
 * answer, whichever endpoint gave it. The primary's URL is never logged or shown: it may carry a key.
 */

export const FALLBACK_RPCS = ["https://bsc-dataseed1.binance.org", "https://bsc-dataseed2.binance.org", "https://bsc-rpc.publicnode.com"] as const;
export const RPC_COOLDOWN_MS = 60_000;

/**
 * The endpoints in order: the primary, then each fallback that is not the primary itself. None behind a primary on
 * this machine (a local node or a fork must never fall over to mainnet's public RPC), and none when
 * `FEAST_MAINNET_RPC_FALLBACK=off`.
 */
export function rpcEndpoints(primary: string, env: Record<string, string | undefined> = process.env): string[] {
  if (env.FEAST_MAINNET_RPC_FALLBACK?.trim().toLowerCase() === "off" || isLocal(primary)) return [primary];
  const same = (a: string, b: string) => a.replace(/\/+$/, "").toLowerCase() === b.replace(/\/+$/, "").toLowerCase();
  return [primary, ...FALLBACK_RPCS.filter((f) => !same(f, primary))];
}

const isLocal = (url: string) => {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "localhost" || host === "::1" || host === "[::1]" || /^127\./.test(host) || host === "0.0.0.0" || host.endsWith(".localhost");
  } catch {
    return true;
  }
};

/** How an endpoint is named in a log line: the primary as such, a fallback by its host. */
export const endpointLabel = (urls: readonly string[], i: number) => (i === 0 ? "primary" : (() => { try { return new URL(urls[i]!).host; } catch { return `fallback ${i}`; } })());

/** A failure of the way to the node, not an answer from it. */
export function transportFailure(error: unknown): boolean {
  const e = error as { name?: unknown; code?: unknown; status?: unknown; cause?: unknown; message?: unknown } | null;
  if (!e || typeof e !== "object") return false;
  if (e.name === "HttpRequestError" || e.name === "TimeoutError" || e.name === "SocketClosedError") return true;
  // -32005: limit exceeded; -32603 with a gateway's words; a status the gateway set.
  if (e.code === -32005 || e.code === 429) return true;
  if (typeof e.status === "number" && (e.status === 429 || e.status >= 500)) return true;
  if (/fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|socket hang up|rate limit|too many requests/i.test(String(e.message ?? ""))) return true;
  return e.cause ? transportFailure(e.cause) : false;
}

export type RpcState = { endpoint: string; onFallback: boolean; resting: number };
type Request = (args: { method: string; params?: unknown }) => Promise<unknown>;

export type FallbackOptions = {
  timeoutMs?: number;
  now?: () => number;
  /** Told when the endpoint in use changes (labels only, never a URL with a key). */
  onSwitch?: (change: { from: string; to: string; reason: string }) => void;
  /** Tests: a request function per URL instead of viem's http. */
  make?: (url: string) => Request;
};

export function fallbackRpc(urls: readonly string[], o: FallbackOptions = {}): { transport: Transport; state: () => RpcState; request: Request } {
  const now = o.now ?? Date.now;
  const resting = new Map<number, number>();
  let current = 0;
  const requests = urls.map((url) => o.make?.(url) ?? (http(url, { timeout: o.timeoutMs ?? 20_000, retryCount: 0 })({ retryCount: 0 }).request as unknown as Request));
  const request: Request = async (args) => {
    const t = now();
    const awake = urls.map((_, i) => i).filter((i) => (resting.get(i) ?? 0) <= t);
    // Every endpoint resting: try them all anyway, in order (no answer is worse than a tired one).
    const order = awake.length > 0 ? awake : urls.map((_, i) => i);
    let last: unknown = null;
    for (const i of order) {
      try {
        const answer = await requests[i]!(args);
        if (i !== current) {
          o.onSwitch?.({ from: endpointLabel(urls, current), to: endpointLabel(urls, i), reason: last ? String((last as Error).message ?? last).slice(0, 120).replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "<url>") : "back" });
          current = i;
        }
        return answer;
      } catch (error) {
        if (!transportFailure(error)) throw error;
        resting.set(i, now() + RPC_COOLDOWN_MS);
        last = error;
      }
    }
    throw last;
  };
  const transport = (() =>
    createTransport({ key: "feast-fallback", name: "Feast fallback", type: "feast-fallback", request: request as unknown as EIP1193RequestFn, retryCount: 1, retryDelay: 600 })) as unknown as Transport;
  return { transport, request, state: () => ({ endpoint: endpointLabel(urls, current), onFallback: current !== 0, resting: [...resting.values()].filter((until) => until > now()).length }) };
}
