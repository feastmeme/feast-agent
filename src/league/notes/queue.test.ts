import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { confirmAgent, planAgent, saveAgent } from "../agent.ts";
import { FakeFeast, SITE, WALLET, type Answer } from "../data/fakes.ts";
import { hostPath } from "../prompt/host.ts";
import { checkNote, flushNotes, noteCommand, notesPath, readNotes } from "./queue.ts";

const NOW = Date.parse("2026-10-27T05:00:00Z");
const TX = `0x${"ab".repeat(32)}`;
let homes: string[] = [];
afterEach(() => {
  for (const h of homes) rmSync(h, { recursive: true, force: true });
  homes = [];
});

function world(notes: Answer = { status: 404, body: {} }) {
  const home = mkdtempSync(join(tmpdir(), "feast-league-notes-"));
  homes.push(home);
  const planned = planAgent({ name: "demo", preset: "dca" });
  if (!planned.ok) throw new Error(planned.errors.join("; "));
  saveAgent(home, confirmAgent(planned.agent));
  const feast = new FakeFeast({ notes });
  const clock = { now: NOW };
  const deps = { home, name: "demo", site: SITE, fetch: feast.fetch, wallet: async () => WALLET, now: () => clock.now, timeoutMs: 200 };
  return { home, feast, clock, deps, note: (text: string, tx?: string) => noteCommand(deps, { text, tx }) };
}

describe("a note's text", () => {
  it("1–280 characters as the page counts them, line breaks folded; control, bidi and the wallet's address refused", () => {
    expect(checkNote("bought C01: volume tripled\nin an hour", WALLET)).toEqual({ ok: true, text: "bought C01: volume tripled in an hour" });
    expect(checkNote("x".repeat(280), WALLET).ok).toBe(true);
    expect(checkNote("x".repeat(281), WALLET)).toEqual({ ok: false, reason: "a note is 1–280 characters (got 281)" });
    expect(checkNote("   ", WALLET)).toEqual({ ok: false, reason: "a note is 1–280 characters (got 0)" });
    expect(checkNote("red \u001b[31m alert", WALLET)).toEqual({ ok: false, reason: "a note has no control or direction characters" });
    expect(checkNote("left ‮ right", WALLET).ok).toBe(false);
    expect(checkNote(`sent to ${WALLET}`, WALLET)).toEqual({ ok: false, reason: "a note never carries the wallet's address" });
    expect(checkNote(`sent to ${WALLET.slice(2).toUpperCase()}`, WALLET).ok).toBe(false);
    // A coin's address is fine.
    expect(checkNote("bought 0x00000000000000000000000000000000000c0d01", WALLET).ok).toBe(true);
  });
});

describe("FL note: kept, sent, refused", () => {
  it("a 404 (no route yet): kept on this machine, then sent on a later flush once the page answers 201", async () => {
    const w = world();
    const out = await w.note("bought C01 on the volume", TX);
    expect(out.code).toBe(0);
    expect(out.text).toBe("kept on this machine; sent when feast.meme takes notes");
    expect(readNotes(w.home, "demo")).toMatchObject([{ text: "bought C01 on the volume", tx: TX, state: "queued" }]);
    w.feast.options.notes = { status: 201, body: { ok: true } };
    const flushed = await flushNotes(w.home, "demo", WALLET, { site: SITE, fetch: w.feast.fetch, now: () => NOW + 60_000 });
    expect(flushed).toMatchObject({ sent: 1, kept: 0, refused: 0 });
    expect(readNotes(w.home, "demo")).toMatchObject([{ state: "sent" }]);
    expect(w.feast.posts).toHaveLength(2);
    expect(w.feast.posts[1]).toEqual({ id: expect.any(String), wallet: WALLET, ts: new Date(NOW).toISOString(), text: "bought C01 on the volume", tx: TX });
  });

  it("a 500 and a timeout: kept; a 400: refused with its status and never sent again", async () => {
    const down = world({ status: 500, body: {} });
    expect((await down.note("one")).text).toBe("kept on this machine; sent when feast.meme takes notes");
    const slow = world("timeout");
    const started = Date.now();
    const out = await slow.note("two");
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(out).toMatchObject({ code: 0, text: "kept on this machine; sent when feast.meme takes notes" });
    const bad = world({ status: 400, body: { error: "bad-text" } });
    const refused = await bad.note("three");
    expect(refused.code).toBe(0);
    expect(refused.text).toBe("feast.meme refused this note (HTTP 400); it stays on this machine and is never sent again");
    expect(readNotes(bad.home, "demo")).toMatchObject([{ state: "refused", status: 400 }]);
    bad.feast.options.notes = { status: 201, body: {} };
    await flushNotes(bad.home, "demo", WALLET, { site: SITE, fetch: bad.feast.fetch, now: () => NOW });
    expect(bad.feast.posts).toHaveLength(1);
  });

  it("the queue file never holds the wallet's address; only the POST body carries it", async () => {
    const w = world({ status: 201, body: {} });
    await w.note("bought C01", TX);
    await w.note("sold C01");
    const file = readFileSync(notesPath(w.home, "demo"), "utf8");
    expect(file.toLowerCase().includes(WALLET.slice(2).toLowerCase())).toBe(false);
    expect(JSON.stringify(w.feast.posts).toLowerCase()).toContain(WALLET.slice(2).toLowerCase());
    // Append-only: the note, then its sent mark.
    expect(file.trim().split("\n")).toHaveLength(4);
  });

  it("bad input is one line and exit 2; nothing is written", async () => {
    const w = world();
    expect(await w.note("x".repeat(281))).toMatchObject({ code: 2, text: "a note is 1–280 characters (got 281)" });
    expect(await w.note("fine", "0x1234")).toMatchObject({ code: 2, text: "--tx must be a transaction hash: 0x and 64 hex digits" });
    expect(existsSync(notesPath(w.home, "demo"))).toBe(false);
    expect(w.feast.posts).toEqual([]);
  });

  it("is an action by the host: it writes host.json", async () => {
    const w = world();
    await w.note("watching C01");
    expect(JSON.parse(readFileSync(hostPath(w.home, "demo"), "utf8"))).toEqual({ at: new Date(NOW).toISOString(), what: "note" });
  });

  it("the wallet unreadable: a note with no full address is kept for later; one with an address waits", async () => {
    const w = world({ status: 201, body: {} });
    const deps = { ...w.deps, wallet: async () => null };
    expect(await noteCommand(deps, { text: "plain words" })).toMatchObject({ code: 0, text: "kept on this machine; sent when feast.meme takes notes" });
    expect(w.feast.posts).toEqual([]);
    expect((await noteCommand(deps, { text: "bought 0x00000000000000000000000000000000000c0d01" })).code).toBe(1);
  });

  it("a flush sends the oldest first, at most its share, and stops at a route that is not there", async () => {
    const w = world();
    for (const t of ["a", "b", "c"]) await w.note(t);
    w.feast.options.notes = { status: 201, body: {} };
    const out = await flushNotes(w.home, "demo", WALLET, { site: SITE, fetch: w.feast.fetch, now: () => NOW, max: 2 });
    expect(out).toMatchObject({ sent: 2, kept: 1 });
    expect(w.feast.posts.slice(-2).map((p) => (p as { text: string }).text)).toEqual(["a", "b"]);
  });
});
