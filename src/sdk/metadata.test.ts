import { describe, expect, it, vi } from "vitest";

import { FeastError } from "./errors.ts";
import { coinPicture, PIN_TIMEOUT_MS, pinImage, pinMetadata, sha256Hex } from "./metadata.ts";

describe("coinPicture", () => {
  it("is a PNG whose first chunk is IHDR, as the pin route's sniffer requires", () => {
    const png = coinPicture("BELL");
    expect(Array.from(png.subarray(0, 8))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(new TextDecoder().decode(png.subarray(12, 16))).toBe("IHDR");
    expect(png.length).toBeLessThan(1024 * 1024);
  });
  it("is the same picture for the same ticker and a different one for another", () => {
    expect(sha256Hex(coinPicture("BELL"))).toBe(sha256Hex(coinPicture("BELL")));
    expect(sha256Hex(coinPicture("BELL"))).not.toBe(sha256Hex(coinPicture("GONG")));
  });
});

describe("pinMetadata", () => {
  it("posts the document as JSON and returns the digest create will carry", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ cid: "bafkrei…", digest: `0x${"ab".repeat(32)}` })));
    const pinned = await pinMetadata("https://sandbox.feast.meme", { name: "Bell", symbol: "BELL", description: "", image: "ipfs://x" }, fetchMock);
    expect(pinned.digest).toBe(`0x${"ab".repeat(32)}`);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://sandbox.feast.meme/api/pin");
    expect(JSON.parse(String(init.body))).toMatchObject({ symbol: "BELL", image: "ipfs://x" });
  });
  it("refuses to launch faceless when the pin fails", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: "Too many requests" }), { status: 429 }));
    await expect(pinMetadata("https://x", { name: "a", symbol: "A", description: "", image: "ipfs://x" }, fetchMock)).rejects.toThrow(FeastError);
  });
});

describe("the pins have a timeout (task 961)", () => {
  const hanging = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true })));

  it("pinImage gives up after its timeout, with a plain error", async () => {
    const started = Date.now();
    await expect(pinImage("https://x", coinPicture("BELL"), hanging as unknown as typeof fetch, 50)).rejects.toThrow(/picture.*did not answer within/);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("pinMetadata gives up after its timeout, with a plain error", async () => {
    await expect(pinMetadata("https://x", { name: "a", symbol: "A", description: "", image: "ipfs://x" }, hanging as unknown as typeof fetch, 50)).rejects.toThrow(/metadata.*did not answer within/);
  });

  it("both carry a 30 s signal by default", async () => {
    const seen: AbortSignal[] = [];
    const answer = vi.fn(async (_url: string, init: RequestInit) => (seen.push(init.signal!), new Response(JSON.stringify({ cid: "c", digest: `0x${"ab".repeat(32)}` }))));
    await pinImage("https://x", coinPicture("BELL"), answer as unknown as typeof fetch);
    await pinMetadata("https://x", { name: "a", symbol: "A", description: "", image: "ipfs://x" }, answer as unknown as typeof fetch);
    expect(seen).toHaveLength(2);
    for (const signal of seen) expect(signal).toBeInstanceOf(AbortSignal);
    expect(PIN_TIMEOUT_MS).toBe(30_000);
  });
});
