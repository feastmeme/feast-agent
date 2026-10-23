import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Address } from "viem";
import { afterEach, describe, expect, it } from "vitest";

import { coinPicture } from "../sdk/metadata.ts";
import { MAINNET } from "../sdk/networks.ts";
import { Executor } from "./executor.ts";

// Synthetic: never a real wallet.
const WALLET: Address = "0x000000000000000000000000000000000000a11c";
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

/** `/api/pin`: takes the picture, then refuses the metadata, so `prepareLaunch` stops before any chain read. */
function pinRoute() {
  const pictures: Uint8Array[] = [];
  const fetch = (async (_url: string, init: RequestInit) => {
    if (init.body instanceof FormData) {
      pictures.push(new Uint8Array(await (init.body.get("file") as Blob).arrayBuffer()));
      return Response.json({ cid: "bafkreiimage", digest: `0x${"11".repeat(32)}` });
    }
    return Response.json({ error: "stop here" }, { status: 500 });
  }) as unknown as typeof globalThis.fetch;
  const executor = new Executor({ signer: null as never, chain: null as never, wallet: WALLET, network: MAINNET, rpcUrl: "http://127.0.0.1:9", stopReason: () => null, log: () => {}, fetch });
  return { executor, pictures };
}

describe("the launch picture, from the request to the pin (task 961)", () => {
  it("passes the file's bytes when its sha256 is the one on the request", async () => {
    const dir = mkdtempSync(join(tmpdir(), "feast-league-image-"));
    dirs.push(dir);
    const bytes = coinPicture("a league picture", 64);
    const path = join(dir, "avatar.png");
    writeFileSync(path, bytes);
    const { executor, pictures } = pinRoute();
    const out = await executor.prepareLaunch({ name: "maplegrin.ai", symbol: "MAPLEGRIN", quote: "WBNB", image: { path, sha256: sha(bytes) } });
    expect(out.ok).toBe(false);
    expect(pictures).toHaveLength(1);
    expect(sha(pictures[0]!)).toBe(sha(bytes));
  });

  it("refuses a file whose sha256 is not the one on the request, before anything is pinned", async () => {
    const dir = mkdtempSync(join(tmpdir(), "feast-league-image-"));
    dirs.push(dir);
    const path = join(dir, "avatar.png");
    writeFileSync(path, coinPicture("changed after the card", 64));
    const { executor, pictures } = pinRoute();
    const out = await executor.prepareLaunch({ name: "maplegrin.ai", symbol: "MAPLEGRIN", quote: "WBNB", image: { path, sha256: sha(coinPicture("what the card showed", 64)) } });
    expect(out).toMatchObject({ ok: false, reason: expect.stringMatching(/sha256/) });
    expect(pictures).toEqual([]);
  });

  it("without a picture, pins the ticker's identicon as before", async () => {
    const { executor, pictures } = pinRoute();
    await executor.prepareLaunch({ name: "maplegrin.ai", symbol: "MAPLEGRIN", quote: "WBNB" });
    expect(sha(pictures[0]!)).toBe(sha(coinPicture("MAPLEGRIN")));
  });
});
