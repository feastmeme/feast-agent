import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import type { Hex } from "viem";

import { FeastError } from "./errors.ts";

/**
 * A coin's face and metadata, pinned to IPFS through the Feast site's public
 * `/api/pin` route — the same route the launch form uses.
 *
 * The chain stores only a 32-byte digest: the sha256 of the metadata JSON, which
 * is the digest of its CIDv1 (raw). The JSON names the picture by `ipfs://<cid>`.
 * So a launch pins the picture, then the metadata naming it, then signs `create`
 * with the digest the pin returned — pin before sign, so the digest on chain
 * addresses a document that already exists.
 */

export type Pinned = { cid: string; digest: Hex };

export type CoinMetadata = {
  name: string;
  symbol: string;
  description: string;
  /** `ipfs://<cid>` of the picture. */
  image: string;
};

type FetchLike = typeof fetch;

type PinPayload = { cid?: unknown; digest?: unknown; error?: unknown };

function parsePayload(text: string): PinPayload | null {
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" ? (value as PinPayload) : null;
  } catch {
    return null;
  }
}

async function pinResponse(response: Response, what: string): Promise<Pinned> {
  const text = await response.text();
  const payload = parsePayload(text);
  if (!response.ok || typeof payload?.cid !== "string" || typeof payload?.digest !== "string") {
    const said = typeof payload?.error === "string" ? payload.error : text.slice(0, 200);
    throw new FeastError(`pinning the ${what} failed (HTTP ${response.status}): ${said}`, "pin_failed");
  }
  return { cid: payload.cid, digest: payload.digest as Hex };
}

/** Pin a PNG/JPEG/WebP picture. */
export async function pinImage(siteUrl: string, bytes: Uint8Array, fetchImpl: FetchLike = fetch): Promise<Pinned> {
  const form = new FormData();
  form.append("file", new Blob([Buffer.from(bytes)], { type: "image/png" }), "face.png");
  const response = await fetchImpl(`${siteUrl}/api/pin`, { method: "POST", body: form });
  return pinResponse(response, "picture");
}

/** Pin the metadata document; its digest is what `create` carries as `metadataHash`. */
export async function pinMetadata(siteUrl: string, metadata: CoinMetadata, fetchImpl: FetchLike = fetch): Promise<Pinned> {
  const response = await fetchImpl(`${siteUrl}/api/pin`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(metadata),
  });
  return pinResponse(response, "metadata");
}

// --- a deterministic picture, so an agent can launch without an image file ----

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = (CRC_TABLE[(c ^ b) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/**
 * A 256×256 PNG generated from the ticker: a symmetric 8×8 identicon in a colour
 * taken from sha256(ticker). Same ticker, same picture.
 */
export function coinPicture(seed: string, size = 256): Uint8Array {
  const hash = createHash("sha256").update(seed).digest();
  const at = (i: number) => hash[i % hash.length] ?? 0;
  const fg = [at(0), at(1), at(2)].map((v) => 64 + (v % 160));
  const bg = [250, 246, 238];
  const cells = 8;
  const cell = size / cells;
  const on = (x: number, y: number) => {
    const mx = x < cells / 2 ? x : cells - 1 - x;
    return ((at(3 + y * 4 + mx) >> (mx % 8)) & 1) === 1;
  };
  const raw = new Uint8Array(size * (1 + size * 3));
  for (let y = 0; y < size; y++) {
    const row = y * (1 + size * 3);
    raw[row] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const inner = x >= cell / 2 && y >= cell / 2 && x < size - cell / 2 && y < size - cell / 2;
      const lit = inner && on(Math.floor(x / cell), Math.floor(y / cell));
      const colour = lit ? fg : bg;
      raw.set(colour, row + 1 + x * 3);
    }
  }
  const header = new Uint8Array(13);
  const hv = new DataView(header.buffer);
  hv.setUint32(0, size);
  hv.setUint32(4, size);
  header[8] = 8; // bit depth
  header[9] = 2; // truecolour
  const signature = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const parts = [signature, chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", new Uint8Array())];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/** sha256 of some bytes as 0x-hex: the digest a raw-leaf CIDv1 carries. */
export function sha256Hex(bytes: Uint8Array): Hex {
  return `0x${createHash("sha256").update(bytes).digest("hex")}` as Hex;
}
