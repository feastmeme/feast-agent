import { describe, expect, it } from "vitest";

import { parseRef, REF_PROBLEM } from "./ref.ts";

/** Task 975, addendum 12: `FL enter --ref`, bare or out of the pasted line, in the site's own code form. */

describe("parseRef", () => {
  it("a bare code, case-folded and trimmed, as the site folds it; a wallet, lower-cased", () => {
    expect(parseRef("h7kmq2")).toEqual({ ok: true, ref: "H7KMQ2" });
    expect(parseRef("  H7KMQ2X9 ")).toEqual({ ok: true, ref: "H7KMQ2X9" });
    expect(parseRef("0x000000000000000000000000000000000000A11C")).toEqual({ ok: true, ref: "0x000000000000000000000000000000000000a11c" });
  });

  it("out of the pasted line: a link with ?ref=<code> (or &ref=), or ref: <code> (a full-width colon too)", () => {
    expect(parseRef("Join the Feast league: https://feast.meme/league/agent.md?ref=H7KMQ2 and follow it")).toEqual({ ok: true, ref: "H7KMQ2" });
    expect(parseRef("https://feast.meme/league?lang=zh&ref=h7kmq2#start")).toEqual({ ok: true, ref: "H7KMQ2" });
    expect(parseRef("Read feast.meme/league/agent.md and enter me. ref: H7KMQ2")).toEqual({ ok: true, ref: "H7KMQ2" });
    expect(parseRef("读 feast.meme/league/agent.md 帮我报名（ref：h7kmq2）。")).toEqual({ ok: true, ref: "H7KMQ2" });
    expect(parseRef("ref=H7KMQ2")).toEqual({ ok: true, ref: "H7KMQ2" });
  });

  it("absent: no code, nothing sent", () => {
    expect(parseRef(undefined)).toEqual({ ok: true, ref: null });
    expect(parseRef("")).toEqual({ ok: true, ref: null });
    expect(parseRef("   ")).toEqual({ ok: true, ref: null });
  });

  it("malformed: refused (a letter outside the site's alphabet, too short, too long, a command, markup, the zero address)", () => {
    for (const bad of ["H7KMQ0", "H7KMQI", "ABC", "H7KMQ2H7K", "ref: ; rm -rf ~", "?ref=<script>", "0x0000000000000000000000000000000000000000", "0x1234", "join the league"]) expect(parseRef(bad), bad).toEqual({ ok: false, reason: REF_PROBLEM });
  });
});
