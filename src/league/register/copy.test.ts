import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getAddress } from "viem";
import { describe, expect, it } from "vitest";

import * as copy from "./copy.ts";
import { checkCard, launchCard, registerCard, RISK_EN, RISK_ZH, seatedLine, seasonLine, refusalLine } from "./copy.ts";
import { parseLeague } from "./site.ts";
import { leagueWire } from "./fakes.ts";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const COIN = getAddress("0x00000000000000000000000000000000000ffeed");
const ROOT = join(import.meta.dirname, "../../..");
const PACKET = join(homedir(), "vault/feast/agent-league/judgement-league-rules-20261021.md");

describe("the risk text (packet §6; the go's Q7)", () => {
  it("is the packet's, byte for byte: en as it is, zh with full-width ， and ；", () => {
    expect(sha(RISK_EN)).toBe("8d1e1140d579dc518186677fc76b3f53b080d6685c3d73cbb8ab3726a93937b8");
    expect(sha(RISK_ZH)).toBe("8a2f8577e29fafafcdc58c52f278e1d628f47256cfddb8024e9a022e7fde6ad0");
    expect(RISK_ZH).not.toMatch(/[,;]/);
  });

  it.skipIf(!existsSync(PACKET))("matches the packet file itself, where it exists", () => {
    const lines = readFileSync(PACKET, "utf8").split("\n");
    const zh = lines.find((l) => l.startsWith("> 参加联赛"))!.slice(2);
    const en = lines.find((l) => l.startsWith("> You trade with your own wallet"))!.slice(2);
    expect(RISK_EN).toBe(en);
    expect(RISK_ZH).toBe(zh.replaceAll(",", "，").replaceAll(";", "；"));
  });

  it("is the same text in the skill, its references and the README, in both languages", () => {
    for (const file of ["skills/feast-league/SKILL.md", "skills/feast-league/references/setup.md", "skills/feast-league/references/register.md", "README.md"]) {
      const text = readFileSync(join(ROOT, file), "utf8");
      expect(text, file).toContain(RISK_EN);
      expect(text, file).toContain(RISK_ZH);
    }
  });

  it("sits on the registration card, where a person decides to join", () => {
    const view = { agentId: "maplegrin", bodyCoin: { coin: COIN, symbol: "MAPLEGRIN" }, manifesto: "m", length: 1, xHandle: null, issuedAt: 1792675500, replaces: null };
    expect(registerCard(view, "en")).toContain(`Before you take part\n${RISK_EN}`);
    expect(registerCard(view, "zh")).toContain(`参赛前请读\n${RISK_ZH}`);
  });
});

describe("the words", () => {
  const every = Object.values(copy)
    .filter((v) => typeof v === "string")
    .join("\n");
  const samples = [
    every,
    checkCard({ agentId: "maplegrin", plan: { kind: "launch" }, coin: null, kept: null, keptSeating: null, keptUnreadable: false, league: null, now: 0 }, "en"),
    checkCard({ agentId: "maplegrin", plan: { kind: "launch" }, coin: null, kept: null, keptSeating: null, keptUnreadable: false, league: null, now: 0 }, "zh"),
    launchCard({ agentId: "maplegrin", name: "maplegrin.ai", symbol: "MAPLEGRIN", quote: "WBNB", description: null }, "en"),
    launchCard({ agentId: "maplegrin", name: "maplegrin.ai", symbol: "MAPLEGRIN", quote: "WBNB", description: null }, "zh"),
  ];

  it("promise nothing: no yield, no guarantee, no 'safe'", () => {
    for (const text of samples) {
      const outsideRisk = text.replace(RISK_EN, "").replace(RISK_ZH, "");
      expect(outsideRisk).not.toMatch(/guarantee|yield|\bAPY\b|risk-free|\bsafe\b|稳赚|保本|保证|收益率|无风险/i);
    }
  });

  it("name Binance products as facts and nothing else of theirs", () => {
    for (const text of samples) expect(text).not.toMatch(/Binance (Wallet|Smart Wallet|logo)|币安/);
  });
});

describe("the cards (PLAN-941 §1)", () => {
  const league = parseLeague(leagueWire());
  const now = Date.parse("2026-10-22T13:05:00Z");

  it("A1: the check, in both languages", () => {
    const view = { agentId: "maplegrin", plan: { kind: "launch" as const }, coin: null, kept: null, keptSeating: null, keptUnreadable: false, league, now };
    expect(checkCard(view, "en")).toBe(
      [
        "Feast league: registration check",
        "",
        "| | |",
        "| --- | --- |",
        "| Agent ID | maplegrin.ai (read from BNB Smart Chain) |",
        "| Body coin | none yet: every agent launches one coin, its body |",
        "| Registration | not registered yet |",
        "| Season 1 | coming soon · 412 of 1,000 seats taken |",
        "",
        "Next: launch the body coin (one transaction), then sign the registration (no gas).",
      ].join("\n"),
    );
    expect(checkCard(view, "zh")).toContain("| 第 1 季 | 即将开赛 · 1,000 个席位已占 412 个 |");
    expect(checkCard(view, "zh")).toContain("下一步：先发身体币（一笔交易），再签名报名（不花 gas）。");
    const seated = { ...view, plan: { kind: "coin" as const, coin: COIN, why: "fixed" as const, others: [], launchedAt: null }, coin: { coin: COIN, symbol: "MAPLEGRIN" }, keptSeating: { kind: "seated" as const, seatNo: 61, founding: true, foundingNo: 42, waitlisted: false, place: null } };
    expect(checkCard(seated, "en")).toContain("| Body coin | MAPLEGRIN · 0x0000…feed, fixed for this season |");
    expect(checkCard(seated, "en")).toContain("| Registration | seat 61 of 1,000 · founding seat #42 |");
  });

  it("D: the registration card, with the replaced registration and a pending one", () => {
    const view = { agentId: "maplegrin", bodyCoin: { coin: COIN, symbol: "MAPLEGRIN" }, manifesto: "Small bites.", length: 12, xHandle: "maple_grin", issuedAt: 1792675500, replaces: { issuedAt: 1792674000, seated: true } };
    const en = registerCard(view, "en");
    expect(en).toContain("| Manifesto | \"Small bites.\" (12/280) |");
    expect(en).toContain("| X account | @maple_grin, for the early-bird match (not signed) |");
    expect(en).toContain("| Replaces | your registration of ");
    expect(en).toContain("; the seat stays |");
    expect(en.endsWith("Say yes to sign it and send it.")).toBe(true);
    const zh = registerCard({ ...view, bodyCoin: null }, "zh");
    expect(zh).toContain("| 身体币 | 没有：有了身体币才有席位 |");
    expect(zh).toContain("没有身体币也可以先登记，但不会有席位；席位按先后给。");
  });

  it("F: every seat says what it is", () => {
    expect(seatedLine({ kind: "seated", seatNo: 61, founding: true, foundingNo: 42, waitlisted: false, place: null }, "maplegrin", 1, "en")).toBe("Registered: seat 61 of 1,000, and a founding seat (#42 of 100). maplegrin.ai is in Season 1.");
    expect(seatedLine({ kind: "seated", seatNo: 412, founding: false, foundingNo: null, waitlisted: false, place: null }, "maplegrin", 1, "zh")).toBe("报名成功：第 412 号席位（共 1,000）。maplegrin.ai 进入第 1 季。");
    expect(seatedLine({ kind: "seated", seatNo: 1_012, founding: false, foundingNo: null, waitlisted: true, place: 12 }, "maplegrin", 1, "en")).toBe("The 1,000 seats are taken. maplegrin.ai is on the waitlist, place 12.");
    expect(seatedLine({ kind: "pending", reason: "no-body-coin" }, "maplegrin", 1, "en")).toContain("seats go in order");
  });

  it("every refusal code has its own sentence in both languages", () => {
    const codes = ["invalid-fields", "bad-request", "stale", "no-agent-id", "agent-id-mismatch", "body-coin-not-yours", "bad-signature", "replayed", "name-taken", "rate-limited", "unavailable", "upstream-unavailable"];
    for (const lang of ["en", "zh"] as const) {
      const lines = codes.map((code) => refusalLine(code, null, "maplegrin", lang));
      expect(new Set(lines.filter((_, i) => !["bad-request", "upstream-unavailable"].includes(codes[i]!))).size).toBe(codes.length - 2);
      for (const line of lines) expect(line).not.toMatch(/\(\w+-\w+\)/);
    }
  });

  it("the season line in each state", () => {
    const at = (state: string, extra = {}) => parseLeague(leagueWire({ state, ...extra }));
    expect(seasonLine(at("coming-soon"), now, "en")).toBe("Season 1 · coming soon");
    expect(seasonLine(at("warm-up", { season: { number: 1, day: null, countdownTo: "2026-10-24T17:05:00.000Z" } }), now, "en")).toBe("Warm-up: Season 1 starts in 2 d 4 h. The boards rank, and nobody is paid or eaten yet.");
    expect(seasonLine(at("season", { season: { number: 1, day: 3, countdownTo: "2026-10-22T18:17:00.000Z" } }), now, "zh")).toBe("第 1 季，第 3 天（共 7 天） · 下一顿开饭还有 5 小时 12 分（21:00 UTC+8）");
    expect(seasonLine(at("over"), now, "en")).toBe("Season 1 is over.");
    expect(seasonLine(null, now, "en")).toBe("The league couldn't be read just now. Your agent isn't affected.");
  });
});
