import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { getAddress, isAddress, recoverTypedDataAddress, type Address, type Hex } from "viem";
import type { LocalAccount } from "viem/accounts";

import type { BawRunner } from "../baw.ts";
import { AGENT_ID, ISSUED_MAX_AGE_SECONDS, ISSUED_MAX_AHEAD_SECONDS, joinSignature, normalizeManifesto, registerTypedData, ZERO_ADDRESS } from "./message.ts";
import { normalizeXHandle } from "./claims.ts";

/**
 * TEST FAKES, NOT USED AT RUNTIME (docs/PLAN-941.md §10).
 *
 * `fakeBaw`: the Binance Agentic Wallet's documented envelopes, and the live
 * shapes measured on 2026-10-22 (the preview reads back the message part
 * alone). Its `sign-message execute` really signs, with a viem local account.
 *
 * `FakeLeaguePage`: the league page's register and league routes, bound to
 * 927's `route.ts` (its checks in its order, its codes) and `wire.ts` (the
 * league's shape), as API.md of 927 run 5 describes them. It verifies every
 * signature over the typed data it rebuilds from the fields, as the page does.
 */

// --- the wallet -----------------------------------------------------------------------------

export type FakeBawOptions = {
  account: LocalAccount;
  connected?: boolean;
  devMode?: boolean;
  /** How the execute answers: at once, after the App's confirmation (n result polls), or not at all. */
  confirm?: { kind: "direct" } | { kind: "app"; polls: number; then: "COMPLETED" | "REJECTED" | "EXPIRED" | "PENDING_CONFIRMATION" };
  /** The preview flags a risk. */
  risk?: boolean;
  /** The preview reads back other fields than it was sent (a wallet that would sign something else). */
  tamper?: boolean;
  /** The preview is refused by the wallet. */
  refusePreview?: boolean;
  /** r‖s + recovery (the docs), or one 65-byte hex. */
  signatureForm?: "rs" | "full";
  /** Sign with another key than the wallet's. */
  signWith?: LocalAccount;
  settings?: Record<string, unknown>;
};

export function fakeBaw(options: FakeBawOptions): { runner: BawRunner; calls: string[][] } {
  const calls: string[][] = [];
  const previews = new Map<string, unknown>();
  const orders = new Map<string, { polls: number; signature: { signature: string; recovery: string } }>();
  let n = 0;
  const ok = (data: unknown) => ({ stdout: JSON.stringify({ success: true, data }), stderr: "", code: 0 });
  const sign = async (typed: { domain: Record<string, unknown>; types: Record<string, unknown>; primaryType: string; message: Record<string, unknown> }) => {
    const { EIP712Domain: _domain, ...types } = typed.types as Record<string, unknown>;
    const full = await (options.signWith ?? options.account).signTypedData({
      domain: typed.domain,
      types: types as never,
      primaryType: typed.primaryType,
      message: { ...typed.message, issuedAt: BigInt(String(typed.message.issuedAt)) },
    } as never);
    const v = Number.parseInt(full.slice(130), 16);
    return options.signatureForm === "full" ? { signature: full, recovery: "" } : { signature: full.slice(2, 130), recovery: v === 28 ? "01" : "00" };
  };
  const runner: BawRunner = async (args) => {
    calls.push([...args]);
    const command = `${args[0]} ${args[1]}`;
    const value = (flag: string) => args[args.indexOf(flag) + 1] ?? "";
    switch (command) {
      case "wallet status":
        return ok({ status: options.connected === false ? "DISCONNECTED" : "CONNECTED" });
      case "wallet address":
        return ok({ addresses: [{ binanceChainId: "56", address: options.account.address }] });
      case "wallet settings":
        return ok({ devMode: { enabled: options.devMode !== false, expiresAt: null, dailyLimit: 1000, balanceExceeded: false }, developerModeQuotaUsed: 0, ...options.settings });
      case "sign-message preview": {
        if (options.refusePreview) return { stdout: JSON.stringify({ success: false, error: { code: 351805, name: "PREVIEW_FAILED", message: "refused" } }), stderr: "", code: 1 };
        let typed: { message: Record<string, unknown> } = { message: {} };
        try {
          const request = JSON.parse(value("--message")) as { params: [string, string] };
          typed = JSON.parse(request.params[1]) as { message: Record<string, unknown> };
        } catch {
          // Any message is previewed, as the real wallet does; only a Register one could be signed here.
        }
        const requestId = `req-${(n += 1)}`;
        previews.set(requestId, typed);
        const readBack = options.tamper ? { ...typed.message, strategy: `${String(typed.message.strategy)} (and more)` } : typed.message;
        return ok({
          requestId,
          parsedMessage: { messageType: "SignTypedData", preCheckCode: "", version: "V4", message: JSON.stringify(readBack) },
          risks: { addresses: {}, riskDetails: options.risk ? [{ type: "PHISHING" }] : [], riskBehaviors: [] },
          requireConfirmation: options.confirm?.kind === "app",
          expiresAt: Date.now() + 300_000,
        });
      }
      case "sign-message execute": {
        const typed = previews.get(value("--requestId"));
        if (!typed) return { stdout: JSON.stringify({ success: false, error: { code: 1, name: "NOT_FOUND", message: "no such request" } }), stderr: "", code: 1 };
        const signature = await sign(typed as never);
        const orderId = `msg-order-${n}`;
        if (options.confirm?.kind === "app") {
          orders.set(orderId, { polls: 0, signature });
          return ok({ orderId, status: "PENDING_CONFIRMATION", signature: null, signatureRecovery: null, message: "Please confirm in the Binance App" });
        }
        return ok({ orderId, status: "COMPLETED", signature: signature.signature, signatureRecovery: signature.recovery || null, message: null });
      }
      case "sign-message result": {
        const order = orders.get(value("--order-id"));
        const confirm = options.confirm;
        if (!order || confirm?.kind !== "app") return { stdout: JSON.stringify({ success: false, error: { name: "NOT_FOUND" } }), stderr: "", code: 1 };
        order.polls += 1;
        if (order.polls < confirm.polls || confirm.then === "PENDING_CONFIRMATION") return ok({ orderId: value("--order-id"), status: "PENDING_CONFIRMATION", signature: null, signatureRecovery: null });
        if (confirm.then !== "COMPLETED") return ok({ orderId: value("--order-id"), status: confirm.then, signature: null, signatureRecovery: null });
        return ok({ orderId: value("--order-id"), status: "COMPLETED", signature: order.signature.signature, signatureRecovery: order.signature.recovery || null });
      }
      default:
        return { stdout: JSON.stringify({ success: false, error: { name: "UNKNOWN_COMMAND" } }), stderr: "", code: 1 };
    }
  };
  return { runner, calls };
}

// --- the league page ------------------------------------------------------------------------

export type SeatingShape = "run5" | "sealed" | "plan";

export type FakePageOptions = {
  /** Agent IDs by wallet (lower case); "unreadable" for a chain that does not answer. */
  agentIds: Record<string, string | null | "unreadable">;
  /** Who launched each coin (lower case); a function may read a real chain. */
  creatorOf?: (coin: Address) => Promise<string | null | "unreadable">;
  creators?: Record<string, string>;
  /** The coins each wallet launched, newest first (for a registration with no claim). */
  launches?: Record<string, string[]>;
  /** The pre-registration roster: Agent ID → { number, xHandle }. */
  roster?: Record<string, { number: number; xHandle: string }>;
  preSeason?: boolean;
  /** The next seat to give (1,001 to test the waitlist). */
  nextSeat?: number;
  seatingShape?: SeatingShape;
  /** The league's answer for GET /api/league, per view; `me` is computed from the boards when asked. */
  league?: Record<string, unknown> | ((view: string) => Record<string, unknown> | null);
  withMe?: boolean;
  now?: () => number;
};

type Kept = { wallet: string; agentId: string; manifesto: string; issuedAt: number; bodyCoin: string | null; seatNo: number | null; waitlisted: boolean; founding: boolean; foundingNo: number | null; xHandle: string | null; earlyBird: boolean; signature: string };

export class FakeLeaguePage {
  readonly kept = new Map<string, Kept>();
  readonly posts: Record<string, unknown>[] = [];
  /** Knobs, set by a test before a request. */
  next: { status?: 429 | 503; dropAnswer?: boolean; refuse?: { status: number; code: string; field?: string } } = {};
  private server: Server | null = null;
  private seat: number;
  base = "";

  constructor(readonly options: FakePageOptions) {
    this.seat = options.nextSeat ?? 1;
  }

  async start(): Promise<string> {
    this.server = createServer((req, res) => void this.handle(req, res).catch((error: unknown) => this.json(res, 500, { error: { code: "test-bug", message: String(error) } })));
    await new Promise<void>((r) => this.server!.listen(0, "127.0.0.1", r));
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this.base;
  }

  async stop(): Promise<void> {
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
  }

  private json(res: ServerResponse, status: number, body: unknown) {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  }
  private refuse(res: ServerResponse, status: number, code: string, field?: string) {
    this.json(res, status, { error: { code, message: `(${code})`, ...(field ? { field } : {}) } });
  }

  private publicAgent(k: Kept) {
    return { wallet: k.wallet, agentId: k.agentId, name: k.agentId, manifesto: k.manifesto, issuedAt: k.issuedAt, scheme: "eip712", signature: k.signature, bodyCoin: k.bodyCoin, season: 1, seatNo: k.seatNo, waitlisted: k.waitlisted, founding: k.founding, foundingNo: k.foundingNo, xHandle: k.xHandle, earlyBird: k.earlyBird };
  }

  private seating(k: Kept) {
    const shape = this.options.seatingShape ?? "run5";
    if (k.seatNo === null) return shape === "plan" ? { pending: "no-body-coin" } : { seating: { state: "pending", reason: "no-body-coin" } };
    const place = k.waitlisted ? k.seatNo - 1_000 : null;
    if (shape === "plan") return { seat: { no: k.seatNo, founding: k.founding, waitlisted: k.waitlisted } };
    if (shape === "sealed") return { seating: { state: "seated", seatNo: k.seatNo, founding: k.founding, waitlisted: k.waitlisted } };
    return { seating: { state: "seated", seatNo: k.seatNo, waitlisted: k.waitlisted, place, founding: k.founding, foundingNo: k.foundingNo } };
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", "http://fake");
    if (req.method === "GET" && url.pathname === "/api/league/register") {
      const wallet = (url.searchParams.get("wallet") ?? "").toLowerCase();
      const k = this.kept.get(wallet);
      return this.json(res, 200, { agent: k ? this.publicAgent(k) : null });
    }
    if (req.method === "GET" && url.pathname === "/api/league") {
      const view = url.searchParams.get("view") ?? "today";
      const league = typeof this.options.league === "function" ? this.options.league(view) : this.options.league ?? null;
      if (!league) return this.refuse(res, 503, "upstream-unavailable");
      const me = url.searchParams.get("me")?.toLowerCase() ?? null;
      if (!me || !this.options.withMe) return this.json(res, 200, league);
      const boards = (league.boards ?? { earners: [], backed: [] }) as { earners: { wallet: string; eatenDay: number | null }[]; backed: { wallet: string; eatenDay: number | null }[] };
      const earners = boards.earners.find((r) => r.wallet === me) ?? null;
      const backed = boards.backed.find((r) => r.wallet === me) ?? null;
      const day = earners?.eatenDay ?? backed?.eatenDay ?? null;
      return this.json(res, 200, { ...league, me: { wallet: me, earners, backed, eaten: day !== null ? { day, reason: "drop" } : null } });
    }
    if (req.method !== "POST" || url.pathname !== "/api/league/register") return this.refuse(res, 404, "not-found");

    // 927's route.ts, in its order.
    if (this.next.status === 429) return (this.next = {}), this.refuse(res, 429, "rate-limited");
    if (!/^application\/json\b/i.test(req.headers["content-type"] ?? "")) return this.refuse(res, 415, "bad-request");
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
    } catch {
      return this.refuse(res, 400, "bad-request");
    }
    this.posts.push(body);
    if (this.next.refuse) {
      const r = this.next.refuse;
      this.next = {};
      return this.refuse(res, r.status, r.code, r.field);
    }
    const wallet = typeof body.wallet === "string" && /^0x[0-9a-fA-F]{40}$/.test(body.wallet) ? body.wallet.toLowerCase() : null;
    if (!wallet) return this.refuse(res, 400, "invalid-fields", "wallet");
    if (typeof body.name !== "string" || !AGENT_ID.test(body.name)) return this.refuse(res, 400, "invalid-fields", "name");
    const manifesto = normalizeManifesto(body.strategy ?? "");
    if (!manifesto.ok) return this.refuse(res, 400, "invalid-fields", "strategy");
    if (body.copies !== undefined && body.copies !== null && body.copies !== "" && body.copies !== ZERO_ADDRESS) return this.refuse(res, 400, "invalid-fields", "copies");
    if (typeof body.issuedAt !== "number" || !Number.isSafeInteger(body.issuedAt) || body.issuedAt <= 0) return this.refuse(res, 400, "invalid-fields", "issuedAt");
    if ((body.scheme ?? "eip712") !== "eip712") return this.refuse(res, 400, "invalid-fields", "scheme");
    let claimed: string | null = null;
    if (body.bodyCoin !== undefined && body.bodyCoin !== null && body.bodyCoin !== "") {
      if (typeof body.bodyCoin !== "string" || !isAddress(body.bodyCoin, { strict: false })) return this.refuse(res, 400, "invalid-fields", "bodyCoin");
      claimed = body.bodyCoin.toLowerCase();
    }
    const now = Math.floor((this.options.now ?? Date.now)() / 1_000);
    if (body.issuedAt < now - ISSUED_MAX_AGE_SECONDS || body.issuedAt > now + ISSUED_MAX_AHEAD_SECONDS) return this.refuse(res, 400, "stale");
    if (this.next.status === 503) return (this.next = {}), this.refuse(res, 503, "unavailable");

    const fields = { wallet: getAddress(wallet), name: body.name, strategy: manifesto.text, issuedAt: body.issuedAt };
    const signature = joinSignature(body.signature, body.signatureRecovery);
    let signer: string | null = null;
    try {
      signer = signature ? (await recoverTypedDataAddress({ ...registerTypedData(fields), signature: signature as Hex })).toLowerCase() : null;
    } catch {
      signer = null;
    }
    if (signer !== wallet) return this.refuse(res, 401, "bad-signature");

    const id = this.options.agentIds[wallet];
    if (id === "unreadable") return this.refuse(res, 503, "upstream-unavailable");
    if (id === null || id === undefined) return this.refuse(res, 400, "no-agent-id");
    if (id !== body.name) return this.refuse(res, 400, "agent-id-mismatch");

    let bodyCoin: string | null = null;
    if (claimed) {
      const creator = this.options.creatorOf ? await this.options.creatorOf(getAddress(claimed)) : (this.options.creators?.[claimed] ?? null);
      if (creator === "unreadable") return this.refuse(res, 503, "upstream-unavailable");
      if (creator === null || creator.toLowerCase() !== wallet) return this.refuse(res, 400, "body-coin-not-yours");
      bodyCoin = claimed;
    } else bodyCoin = this.options.launches?.[wallet]?.[0]?.toLowerCase() ?? null;

    const before = this.kept.get(wallet);
    if (before && body.issuedAt <= before.issuedAt) return this.refuse(res, 409, "replayed");
    if ([...this.kept.values()].some((k) => k.agentId === id && k.wallet !== wallet)) return this.refuse(res, 409, "name-taken");
    const k: Kept = before
      ? { ...before, manifesto: manifesto.text, issuedAt: body.issuedAt, signature: String(body.signature), bodyCoin: before.seatNo !== null ? before.bodyCoin : bodyCoin }
      : { wallet, agentId: id, manifesto: manifesto.text, issuedAt: body.issuedAt, bodyCoin, seatNo: null, waitlisted: false, founding: false, foundingNo: null, xHandle: null, earlyBird: false, signature: String(body.signature) };
    if (k.seatNo === null && k.bodyCoin) {
      k.seatNo = this.seat++;
      k.waitlisted = k.seatNo > 1_000;
    }
    const rostered = this.options.roster?.[id];
    if (k.seatNo !== null && !k.founding && rostered && rostered.number <= 100 && this.options.preSeason !== false) {
      k.founding = true;
      k.foundingNo = rostered.number;
    }
    let prereg = "unclaimed";
    const handle = normalizeXHandle(body.xHandle);
    if (handle) {
      if (rostered && rostered.xHandle.toLowerCase() === handle.toLowerCase()) {
        prereg = "matched";
        k.xHandle = rostered.xHandle;
        k.earlyBird = true;
      } else prereg = "none";
    }
    this.kept.set(wallet, k);
    if (this.next.dropAnswer) {
      this.next = {};
      req.socket.destroy();
      return;
    }
    return this.json(res, 201, { agent: this.publicAgent(k), ...this.seating(k), prereg });
  }
}

/** A league answer as 927's `wire.ts` shapes it, for the fake page and the status card's tests. */
export function leagueWire(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    schemaVersion: 2,
    state: "coming-soon",
    view: "today",
    season: { number: 1, day: null, countdownTo: null },
    window: null,
    asOf: null,
    seats: { taken: 412, cap: 1000, founding: 37, foundingCap: 100, foundingPending: 63, waitlist: 0 },
    roster: { count: 312 },
    boards: { earners: [], backed: [] },
    counts: { earners: 0, backed: 0 },
    arena: { set: [], crowd: 0, events: [] },
    dinner: null,
    registry: "read",
    ...over,
  };
}
