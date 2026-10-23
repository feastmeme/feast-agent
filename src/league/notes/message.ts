import { getAddress, recoverTypedDataAddress, type Address, type Hex } from "viem";

import { LEAGUE_CHAIN_ID, LEAGUE_DOMAIN } from "../register/message.ts";

/**
 * What a wallet signs to open its notes session for a season (the owner's
 * ruling, 2026-10-24; the route is task 964's `/api/league/notes/session`):
 * one EIP-712 message on the league's own domain (`Feast League` / `1` /
 * chain 56, the Register message's), with four fields.
 *
 *   NoteSession(address wallet, string agentId, uint256 season, bytes32 nonce)
 *
 * `agentId` is the bare Agent ID as the chain holds it (no `.ai`); `nonce` is
 * 32 random bytes, so no two sessions sign the same message. The page rebuilds
 * the typed data from the fields it is sent and recovers the wallet.
 */

export const NOTE_SESSION_TYPES = {
  NoteSession: [
    { name: "wallet", type: "address" },
    { name: "agentId", type: "string" },
    { name: "season", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

export type NoteSessionFields = { wallet: Address; agentId: string; season: number; nonce: Hex };

export function noteSessionTypedData(fields: NoteSessionFields) {
  return {
    domain: { ...LEAGUE_DOMAIN, chainId: LEAGUE_CHAIN_ID },
    types: NOTE_SESSION_TYPES,
    primaryType: "NoteSession" as const,
    message: { wallet: getAddress(fields.wallet), agentId: fields.agentId, season: BigInt(fields.season), nonce: fields.nonce },
  };
}

/** The typed data as the JSON string `eth_signTypedData_v4` carries; `season` as a decimal string. */
export function noteSessionTypedDataJson(fields: NoteSessionFields): string {
  const typed = noteSessionTypedData(fields);
  return JSON.stringify({
    types: {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
      ],
      NoteSession: NOTE_SESSION_TYPES.NoteSession,
    },
    primaryType: typed.primaryType,
    domain: typed.domain,
    message: { ...typed.message, season: String(fields.season) },
  });
}

/** The wallet's `--message`: an `eth_signTypedData_v4` request whose first parameter is the wallet itself. */
export function noteSessionSignRequest(fields: NoteSessionFields): string {
  return JSON.stringify({ method: "eth_signTypedData_v4", params: [getAddress(fields.wallet), noteSessionTypedDataJson(fields)] });
}

/** The wallet's preview reads back exactly these four fields, on the league's domain, as a NoteSession. */
export function noteSessionPreviewDescribes(parsed: unknown, fields: NoteSessionFields): { ok: true } | { ok: false; reason: string } {
  const p = (parsed ?? {}) as Record<string, unknown>;
  if (p.messageType !== "SignTypedData") return { ok: false, reason: `the wallet reads it as ${String(p.messageType ?? "nothing")}, not typed data` };
  if (p.version !== undefined && p.version !== "V4") return { ok: false, reason: `the wallet reads it as typed data ${String(p.version)}, not V4` };
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
  if (t.primaryType !== undefined && t.primaryType !== "NoteSession") return { ok: false, reason: `the message type is ${String(t.primaryType)}` };
  const m = (t.message ?? t) as Record<string, unknown>;
  const keys = Object.keys(m).sort().join(",");
  const same =
    keys === "agentId,nonce,season,wallet" &&
    String(m.wallet).toLowerCase() === fields.wallet.toLowerCase() &&
    m.agentId === fields.agentId &&
    String(m.season) === String(fields.season) &&
    String(m.nonce).toLowerCase() === fields.nonce.toLowerCase();
  return same ? { ok: true } : { ok: false, reason: "the fields the wallet would sign are not the ones shown" };
}

/** The self-check before anything is sent: the signature recovers this wallet over these fields. */
export async function noteSessionSignatureMatches(fields: NoteSessionFields, signature: Hex): Promise<boolean> {
  try {
    const signer = await recoverTypedDataAddress({ ...noteSessionTypedData(fields), signature });
    return signer.toLowerCase() === fields.wallet.toLowerCase();
  } catch {
    return false;
  }
}
