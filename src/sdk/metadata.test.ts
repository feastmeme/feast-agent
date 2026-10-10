import { describe, expect, it, vi } from "vitest";

import { FeastError } from "./errors.ts";
import { coinPicture, pinMetadata, sha256Hex } from "./metadata.ts";

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
