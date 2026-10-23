import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { AVATAR_PNG } from "./fakes.ts";
import { composeMeme, hostPicture } from "./meme.ts";

/** The meme's rules (task 968), as the runtime holds the host's composition to them. Every name here is made up. */

const base = { concept: "a cat that only eats noodles at midnight", name: "Noodle Cat", symbol: "NOOD", description: "A midnight cat with a noodle habit." };
const ok = (over: Partial<typeof base> = {}) => {
  const out = composeMeme({ ...base, ...over });
  if (!out.ok) throw new Error(out.reason);
  return out;
};

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe("the meme's name", () => {
  it('"feed" is added when it is missing, and kept when it is there', () => {
    expect(ok().name).toBe("Noodle Catfeed");
    expect(ok().changed).toContain('name: "feed" was added at the end');
    expect(ok({ name: "Noodlefeed", symbol: "NOODFEED" })).toMatchObject({ name: "Noodlefeed", changed: [] });
    // The host's own capital Feed is written the league's way; its space stays.
    expect(ok({ name: "Noodle Feed" }).name).toBe("Noodle feed");
  });

  it("at most 20 characters, the stem cut and never the suffix", () => {
    const long = ok({ name: "The Extraordinary Midnight Noodle Cat" });
    expect(long.name).toBe("The Extraordinaryfeed".slice(0, 16) + "feed");
    expect(long.name.length).toBeLessThanOrEqual(20);
    expect(long.name.endsWith("feed")).toBe(true);
    expect(long.changed).toContain('name: cut to 20 characters, keeping "feed"');
    expect(ok({ name: "Sixteen Chars Ok feed" }).name.length).toBeLessThanOrEqual(20);
  });

  it("only letters, digits and spaces: the rest is dropped and listed", () => {
    const out = ok({ name: "Noodle🍜 Cat!" });
    expect(out.name).toBe("Noodle Catfeed");
    expect(out.changed).toContain("name: characters other than letters, digits and spaces were dropped");
    // Full-width forms fold to plain ones first (NFKC).
    expect(ok({ name: "Ｎｏｏｄｌｅ" }).name).toBe("Noodlefeed");
  });

  it("an empty stem is refused", () => {
    for (const name of ["", "   ", "🍜🍜", "feed", "FEED"]) expect(composeMeme({ ...base, name })).toEqual({ ok: false, reason: "name-empty" });
  });
});

describe("the meme's symbol", () => {
  it("uppercase, at most 8; FEED after a stem of 1–4; the plain stem otherwise", () => {
    expect(ok({ symbol: "nood" }).symbol).toBe("NOODFEED");
    expect(ok({ symbol: "CAT" }).symbol).toBe("CATFEED");
    expect(ok({ symbol: "N" }).symbol).toBe("NFEED");
    expect(ok({ symbol: "CATFEED" })).toMatchObject({ symbol: "CATFEED" });
    expect(ok({ symbol: "NOODLES" }).symbol).toBe("NOODLES");
    expect(ok({ symbol: "MIDNIGHTNOODLE" })).toMatchObject({ symbol: "MIDNIGHT" });
    expect(ok({ symbol: "MIDNIGHTNOODLE" }).changed).toContain("symbol: cut to 8 characters");
    expect(ok({ symbol: "c-a_t!" }).symbol).toBe("CATFEED");
    for (const s of ["CAT", "NOODLES", "MIDNIGHTNOODLE", "N"]) expect(ok({ symbol: s }).symbol).toMatch(/^[A-Z0-9]{1,8}$/);
  });

  it("an empty symbol is refused", () => {
    for (const symbol of ["", "!!", "🍜"]) expect(composeMeme({ ...base, symbol })).toEqual({ ok: false, reason: "symbol-empty" });
  });
});

describe("the meme's description and concept", () => {
  it("one sentence on one line, at most 140 characters", () => {
    expect(ok().description).toBe(base.description);
    expect(composeMeme({ ...base, description: "x".repeat(141) })).toEqual({ ok: false, reason: "description-too-long" });
    expect(ok({ description: "x".repeat(140) }).description).toHaveLength(140);
    expect(composeMeme({ ...base, description: "line one.\nline two." })).toEqual({ ok: false, reason: "description-lines" });
    expect(composeMeme({ ...base, description: "  " })).toEqual({ ok: false, reason: "description-empty" });
  });

  it("an address or a link is refused: the card would publish it for good", () => {
    expect(composeMeme({ ...base, description: "send to 0x000000000000000000000000000000000000a11c now" })).toEqual({ ok: false, reason: "description-address" });
    for (const description of ["see https://example.test/x", "visit www.example.test", "join noodlecat.xyz today"]) expect(composeMeme({ ...base, description }), description).toEqual({ ok: false, reason: "description-url" });
  });

  it("the concept is at most 120 characters, and not empty", () => {
    expect(composeMeme({ ...base, concept: "y".repeat(121) })).toEqual({ ok: false, reason: "concept-too-long" });
    expect(composeMeme({ ...base, concept: " \n " })).toEqual({ ok: false, reason: "concept-empty" });
    expect(ok({ concept: "y".repeat(120) }).concept).toHaveLength(120);
  });

  it("invisible and bidi characters are taken out of every field", () => {
    const out = ok({ name: "Noo‮dle", description: "A cat​ that eats." });
    expect(out.name).toBe("Noodlefeed");
    expect(out.description).toBe("A cat that eats.");
  });
});

describe("the host's picture (ruling C9: a PNG of at most 262,144 bytes)", () => {
  const dir = () => {
    const d = mkdtempSync(join(tmpdir(), "feast-meme-"));
    dirs.push(d);
    return d;
  };

  it("a PNG is taken, with its sha256", () => {
    const d = dir();
    writeFileSync(join(d, "cat.png"), AVATAR_PNG);
    const got = hostPicture("cat.png", d);
    expect(got).toMatchObject({ ok: true, name: "cat.png", path: join(d, "cat.png") });
  });

  it("a JPEG, a WebP, a GIF, 262,145 bytes, a missing path: each a reason, never a throw", () => {
    const d = dir();
    writeFileSync(join(d, "a.jpg"), new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]));
    writeFileSync(join(d, "a.webp"), Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8 ")]));
    writeFileSync(join(d, "a.gif"), Buffer.from("GIF89a and the rest"));
    writeFileSync(join(d, "big.png"), Buffer.concat([Buffer.from(AVATAR_PNG.subarray(0, 8)), Buffer.alloc(262_145 - 8)]));
    expect(hostPicture(join(d, "a.jpg"))).toEqual({ ok: false, why: "it is a JPEG, not a PNG" });
    expect(hostPicture(join(d, "a.webp"))).toEqual({ ok: false, why: "it is a WebP, not a PNG" });
    expect(hostPicture(join(d, "a.gif"))).toEqual({ ok: false, why: "it is a GIF, not a PNG" });
    expect(hostPicture(join(d, "big.png"))).toEqual({ ok: false, why: "it is over 262,144 bytes" });
    expect(hostPicture(join(d, "none.png"))).toEqual({ ok: false, why: "there is no file at that path" });
    expect(hostPicture(d)).toEqual({ ok: false, why: "it is not a file" });
  });

  it("exactly 262,144 bytes of PNG is taken", () => {
    const d = dir();
    writeFileSync(join(d, "edge.png"), Buffer.concat([Buffer.from(AVATAR_PNG.subarray(0, 8)), Buffer.alloc(262_144 - 8)]));
    expect(hostPicture(join(d, "edge.png")).ok).toBe(true);
  });
});
