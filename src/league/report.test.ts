import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { fit, logTail, REPORT_EVERY_MS, REPORT_MAX_BYTES, saveReport, scrub, sendReport, type ReportBundle } from "./report.ts";
import { agentPaths } from "./store.ts";

/** Task 975, run 22: `FL report`'s bundle, its scrub, its size, its file and its door. No network. */

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});
const home = () => {
  const d = mkdtempSync(join(tmpdir(), "feast-league-975-report-"));
  dirs.push(d);
  return join(d, "home");
};
const WALLET = "0x000000000000000000000000000000000000A11C";
const HASH = `0x${"ab".repeat(32)}`;
const bundle = (o: Partial<ReportBundle> = {}): ReportBundle => ({ agentId: "maplegrin", agent: "maplegrin", runtime: "league-v5.1.3", host: "binance", doctor: [], status: {}, logTail: [], at: "x", ...o });

describe("the scrub", () => {
  it("addresses and hashes to 6+4; token, key and password fields replaced; keys by their shape; a URL's key; the named secrets; the homes", () => {
    const out = scrub(
      {
        wallet: WALLET,
        tx: HASH,
        said: `bought from ${WALLET} in ${HASH}; rpc https://rpc.example/v1?key=abc123def&x=1, https://u:pw@node.example/rpc, https://bnb.node.example/v2/AbCdEf0123456789XyZw0123/x, Bearer eyJhbGciOiJIUzI1NiJ9.x.y, sk-live00000000, AIzaSyA0000000000000000000000000`,
        notes: { token: "tok-notes-0001", sessionToken: "x", apiKey: "y", password: "z", authorization: "Bearer q" },
        path: "/p0/player/.feast-league/agents/maplegrin/log.jsonl",
        other: "/p0/player/strategy.md",
        rpc: "https://rpc.example/secret-path-0001",
        ok: true,
      },
      { homes: [{ path: "/p0/player/.feast-league", as: "<league-home>" }, { path: "/p0/player", as: "~" }], secrets: ["https://rpc.example/secret-path-0001", "tok-notes-0001"] },
    );
    expect(out.wallet).toBe("0x0000…a11c");
    expect(out.tx).toBe("0xabab…abab");
    expect(out.said).toBe("bought from 0x0000…a11c in 0xabab…abab; rpc https://rpc.example/v1, https://node.example/rpc, https://bnb.node.example/v2/<redacted>/x, Bearer <redacted>, <redacted>, <redacted>");
    expect(out.notes).toEqual({ token: "<redacted>", sessionToken: "<redacted>", apiKey: "<redacted>", password: "<redacted>", authorization: "<redacted>" });
    expect(out.path).toBe("<league-home>/agents/maplegrin/log.jsonl");
    expect(out.other).toBe("~/strategy.md");
    expect(out.rpc).toBe("<redacted>");
    expect(out.ok).toBe(true);
    expect(JSON.stringify(out)).not.toMatch(/0x[0-9a-fA-F]{40}|player|tok-notes|abc123def|pw@/);
  });
});

describe("the bundle", () => {
  it("the last 200 log lines; at most 64 KB, the oldest lines cut first; saved at mode 0600", () => {
    const h = home();
    mkdirSync(agentPaths(h, "maplegrin").dir, { recursive: true });
    for (let i = 0; i < 300; i++) appendFileSync(agentPaths(h, "maplegrin").log, `${JSON.stringify({ event: "tick", i, pad: "x".repeat(400) })}\n`);
    const tail = logTail(h, "maplegrin");
    expect(tail).toHaveLength(200);
    expect((tail[0] as { i: number }).i).toBe(100);
    const { bundle: b, json } = fit(bundle({ logTail: tail }));
    expect(Buffer.byteLength(json)).toBeLessThanOrEqual(REPORT_MAX_BYTES);
    expect(b.logTail.length).toBeLessThan(200);
    expect((b.logTail.at(-1) as { i: number }).i).toBe(299);
    const path = saveReport(h, "maplegrin", json, Date.parse("2026-01-01T00:00:00Z"));
    expect(path).toBe(join(h, "reports", "maplegrin-2026-01-01T00-00-00-000Z.json"));
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ agentId: "maplegrin", runtime: "league-v5.1.3", host: "binance" });
  });
});

describe("the door: POST /api/league/report", () => {
  const SITE = "https://feast.test";
  it("the notes bearer, the bundle as the body; once per 10 minutes per agent; no session, no route, a refusal: said, nothing kept", async () => {
    const h = home();
    const asked: { url: string; auth: string | null; body: string }[] = [];
    const answer = { status: 202, body: { id: "rep-1" } as unknown };
    const f = (async (url: string, init?: RequestInit) => (asked.push({ url, auth: new Headers(init?.headers).get("authorization"), body: String(init?.body) }), new Response(JSON.stringify(answer.body), { status: answer.status }))) as unknown as typeof fetch;
    const json = JSON.stringify(bundle());
    const T = Date.parse("2026-01-01T00:00:00Z");
    expect(await sendReport({ home: h, name: "maplegrin", site: SITE, fetch: f, json, token: null, now: T })).toEqual({ kind: "no-session" });
    expect(asked).toEqual([]);
    answer.status = 404;
    answer.body = { error: { code: "not_found" } };
    expect(await sendReport({ home: h, name: "maplegrin", site: SITE, fetch: f, json, token: "tok-r", now: T })).toEqual({ kind: "no-route" });
    answer.status = 413;
    answer.body = { error: { code: "too_large", message: "over 64 KB" } };
    expect(await sendReport({ home: h, name: "maplegrin", site: SITE, fetch: f, json, token: "tok-r", now: T })).toEqual({ kind: "refused", status: 413, reason: "over 64 KB" });
    answer.status = 202;
    answer.body = { id: "\u001b[31mred" };
    expect(await sendReport({ home: h, name: "x-escape", site: SITE, fetch: f, json, token: "tok-r", now: T })).toEqual({ kind: "sent", id: null });
    answer.body = { id: "rep-1" };
    expect(await sendReport({ home: h, name: "maplegrin", site: SITE, fetch: f, json, token: "tok-r", now: T })).toEqual({ kind: "sent", id: "rep-1" });
    expect(asked.at(-1)).toEqual({ url: `${SITE}/api/league/report`, auth: "Bearer tok-r", body: json });
    expect(await sendReport({ home: h, name: "maplegrin", site: SITE, fetch: f, json, token: "tok-r", now: T + REPORT_EVERY_MS - 1 })).toEqual({ kind: "throttled", next: T + REPORT_EVERY_MS });
    expect((await sendReport({ home: h, name: "another", site: SITE, fetch: f, json, token: "tok-r", now: T + 1 })).kind).toBe("sent");
    expect((await sendReport({ home: h, name: "maplegrin", site: SITE, fetch: f, json, token: "tok-r", now: T + REPORT_EVERY_MS })).kind).toBe("sent");
  });
});
