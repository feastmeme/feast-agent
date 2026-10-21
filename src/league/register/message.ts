import { getAddress, recoverTypedDataAddress, type Address, type Hex } from "viem";

/**
 * What an agent signs to join the league (task 941, docs/PLAN-941.md §3).
 *
 * The league page (feast-app task 927, `src/lib/league/message.ts` at its seal
 * `ce268d59`, blob `9f2924fb`) rebuilds the typed data from the fields it is
 * sent and checks the signature over that. So this file mirrors its builder
 * byte for byte — key order, number formats, normalisation — and a golden test
 * holds both the JSON and its digest to what 927's own builder produced.
 *
 * The domain is the one 926 previewed live: `Feast League` / `1` / chain 56, no
 * `verifyingContract`. Since v2 the five fields mean: `name` is the wallet's
 * bare Agent ID as the chain holds it, `strategy` is the public manifesto, and
 * `copies` is always the zero address.
 */

export const LEAGUE_CHAIN_ID = 56;
export const LEAGUE_DOMAIN = { name: "Feast League", version: "1" } as const;

export const REGISTER_TYPES = {
  Register: [
    { name: "wallet", type: "address" },
    { name: "name", type: "string" },
    { name: "strategy", type: "string" },
    { name: "copies", type: "address" },
    { name: "issuedAt", type: "uint256" },
  ],
} as const;

export const ZERO_ADDRESS: Address = "0x0000000000000000000000000000000000000000";

/** A bare Agent ID as the HandleRegistry stores it: no `.ai`, no capitals. */
export const AGENT_ID = /^[a-z0-9]{1,64}$/;
export const MANIFESTO_MAX = 280;

/** The page accepts an `issuedAt` this far behind its clock … */
export const ISSUED_MAX_AGE_SECONDS = 30 * 60;
/** … and this far ahead. */
export const ISSUED_MAX_AHEAD_SECONDS = 5 * 60;
/** A signature older than this is signed again rather than sent: room for the page's clock. */
export const RESIGN_AFTER_SECONDS = 25 * 60;

export type RegisterFields = { wallet: Address; name: string; strategy: string; issuedAt: number };

/** How the Agent ID is written for a person: the page and the wallet add `.ai`. */
export const shownName = (agentId: string) => `${agentId}.ai`;

export type Manifesto = { ok: true; text: string; length: number } | { ok: false; reason: "not-text" | "too-long" | "joiner" | "control"; length: number };

/**
 * The manifesto exactly as the page normalises it: NFKC, every run of
 * whitespace one space, trimmed; at most 280 code points; no control or format
 * characters. The emoji joiner U+200D is a format character, so a joined emoji
 * is refused, and the reason says so. What comes out is what is shown, signed
 * and sent.
 */
export function normalizeManifesto(raw: unknown): Manifesto {
  if (typeof raw !== "string") return { ok: false, reason: "not-text", length: 0 };
  const text = raw.normalize("NFKC").replace(/\s+/gu, " ").trim();
  const length = [...text].length;
  if (text.includes("‍")) return { ok: false, reason: "joiner", length };
  if (/[\p{Cc}\p{Cf}]/u.test(text)) return { ok: false, reason: "control", length };
  if (length > MANIFESTO_MAX) return { ok: false, reason: "too-long", length };
  return { ok: true, text, length };
}

/** The `issuedAt` to sign: now, and always newer than the registration the page keeps. */
export function nextIssuedAt(nowMs: number, keptIssuedAt: number | null): number {
  const now = Math.floor(nowMs / 1_000);
  return keptIssuedAt !== null && keptIssuedAt >= now ? keptIssuedAt + 1 : now;
}

/** The typed data, as viem hashes and recovers it. */
export function registerTypedData(fields: RegisterFields) {
  return {
    domain: { ...LEAGUE_DOMAIN, chainId: LEAGUE_CHAIN_ID },
    types: REGISTER_TYPES,
    primaryType: "Register" as const,
    message: {
      wallet: getAddress(fields.wallet),
      name: fields.name,
      strategy: fields.strategy,
      copies: ZERO_ADDRESS,
      issuedAt: BigInt(fields.issuedAt),
    },
  };
}

/** The typed data as the JSON string `eth_signTypedData_v4` carries: 927's `registerTypedDataJson`, byte for byte. */
export function registerTypedDataJson(fields: RegisterFields): string {
  const typed = registerTypedData(fields);
  return JSON.stringify({
    types: {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
      ],
      Register: REGISTER_TYPES.Register,
    },
    primaryType: typed.primaryType,
    domain: typed.domain,
    message: { ...typed.message, issuedAt: String(fields.issuedAt) },
  });
}

/** The wallet's `--message`: an `eth_signTypedData_v4` request whose first parameter is the wallet itself. */
export function signRequestMessage(fields: RegisterFields): string {
  return JSON.stringify({ method: "eth_signTypedData_v4", params: [getAddress(fields.wallet), registerTypedDataJson(fields)] });
}

/**
 * The wallet's signature as one 65-byte hex. The Agentic Wallet answers r‖s
 * (128 hex, no `0x`) and `signatureRecovery` "00" or "01"; a whole 65-byte
 * signature is taken as it is. Anything else is null: never sent.
 */
export function joinSignature(signature: unknown, recovery: unknown): Hex | null {
  if (typeof signature !== "string") return null;
  const bare = signature.trim().replace(/^0x/i, "");
  if (/^[0-9a-fA-F]{130}$/.test(bare)) {
    const v = Number.parseInt(bare.slice(128), 16);
    if (v === 0 || v === 1) return `0x${bare.slice(0, 128)}${(v + 27).toString(16)}`;
    return v === 27 || v === 28 ? (`0x${bare}` as Hex) : null;
  }
  if (!/^[0-9a-fA-F]{128}$/.test(bare)) return null;
  if (recovery !== "00" && recovery !== "01" && recovery !== 0 && recovery !== 1) return null;
  return `0x${bare}${recovery === "01" || recovery === 1 ? "1c" : "1b"}`;
}

/** The self-check before anything is sent: the signature recovers this wallet over these fields. */
export async function signatureMatches(fields: RegisterFields, signature: Hex): Promise<boolean> {
  try {
    const signer = await recoverTypedDataAddress({ ...registerTypedData(fields), signature });
    return signer.toLowerCase() === fields.wallet.toLowerCase();
  } catch {
    return false;
  }
}

/**
 * Does the wallet's preview describe exactly this message? Every field the page
 * checks must be ours. Measured on mainnet (2026-10-22): `parsedMessage.message`
 * is the JSON of the `message` part alone — wallet, name, strategy, copies,
 * issuedAt — with no domain; the domain is the one this file built into the
 * request. A reading that does carry a domain must carry ours.
 */
export function previewDescribes(parsed: unknown, fields: RegisterFields): { ok: true } | { ok: false; reason: string } {
  const p = (parsed ?? {}) as Record<string, unknown>;
  if (p.messageType !== undefined && p.messageType !== "SignTypedData") return { ok: false, reason: `the wallet reads it as ${String(p.messageType)}, not typed data` };
  if (typeof p.preCheckCode === "string" && p.preCheckCode !== "") return { ok: false, reason: `the wallet's pre-check said ${p.preCheckCode}` };
  let typed: unknown = p.message;
  if (typeof typed === "string") {
    try {
      typed = JSON.parse(typed);
    } catch {
      return { ok: false, reason: "the wallet's reading of the message is not JSON" };
    }
  }
  if (typeof typed !== "object" || typed === null) return { ok: false, reason: "the wallet's reading has no message" };
  const t = typed as { domain?: Record<string, unknown>; primaryType?: unknown; message?: Record<string, unknown> } & Record<string, unknown>;
  if (t.domain !== undefined) {
    if (t.domain.name !== LEAGUE_DOMAIN.name || String(t.domain.version) !== LEAGUE_DOMAIN.version || Number(t.domain.chainId) !== LEAGUE_CHAIN_ID) return { ok: false, reason: "the domain is not Feast League / 1 / 56" };
    if ("verifyingContract" in t.domain && t.domain.verifyingContract !== undefined) return { ok: false, reason: "the domain names a contract" };
  }
  if (t.primaryType !== undefined && t.primaryType !== "Register") return { ok: false, reason: `the message type is ${String(t.primaryType)}` };
  const m = (t.message ?? t) as Record<string, unknown>;
  const same =
    String(m.wallet).toLowerCase() === fields.wallet.toLowerCase() &&
    m.name === fields.name &&
    m.strategy === fields.strategy &&
    String(m.copies).toLowerCase() === ZERO_ADDRESS &&
    String(m.issuedAt) === String(fields.issuedAt);
  return same ? { ok: true } : { ok: false, reason: "the fields the wallet would sign are not the ones shown" };
}
