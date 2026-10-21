import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { AUDIT_RULES, auditSource, sha256Of, type RuleId } from "./static.ts";

/** A well-formed script around a body: only the body varies between cases. */
const script = (body: string, head = "") => `${head}
export const meta = { name: "t", tickSeconds: 60 };
export function onTick(api) {
${body}
}
`;
const rulesHit = (source: string) => [...new Set(auditSource(source, { maxTradeBnb: 0.02 }).hits.filter((h) => h.severity === "refuse").map((h) => h.rule))].sort();
const refusedBy = (source: string, rule: RuleId) => {
  const audit = auditSource(source, { maxTradeBnb: 0.02 });
  expect(audit.verdict, `expected a refusal under ${rule}`).toBe("refuse");
  expect(rulesHit(source)).toContain(rule);
};
const passes = (source: string) => {
  const audit = auditSource(source, { maxTradeBnb: 0.02 });
  expect(audit.hits.filter((h) => h.severity === "refuse"), JSON.stringify(audit.hits)).toEqual([]);
  expect(audit.verdict).toBe("pass");
};

describe("the static rules, as PLAN.md §5.3 lists them", () => {
  it("are A1–A9", () => {
    expect(AUDIT_RULES.map((r) => r.id)).toEqual(["A1", "A2", "A3", "A4", "A5", "A6", "A7", "A8", "A9"]);
  });

  it("a plain strategy passes", () => {
    passes(
      script(`
  const coins = api.read.coins({ sort: "new", limit: 10 });
  for (const c of coins) {
    if (c.holders > 50 && !api.read.position(c.coin)) api.buy({ coin: c.coin, bnb: 0.005, reason: "many holders" });
  }
  for (let i = 0; i < 10; i++) api.log("tick " + i);
  const held = api.read.positions().filter((p) => p.pnlPct !== null && p.pnlPct < -20);
  for (const p of held) api.sell({ coin: p.coin, fraction: 1 });
  api.state.last = api.read.now();
  const url = "https://feast.meme/coin/x";`),
    );
  });
});

describe("A1 no direct wallet or process access", () => {
  it("refuses baw anywhere, in code or in strings", () => {
    refusedBy(script(`const tool = "baw"; api.log(tool);`), "A1");
    refusedBy(script(`api.log("run baw contract-call execute");`), "A1");
    refusedBy(script(`const baw = 1;`), "A1");
  });
  it("refuses child processes, process and workers", () => {
    refusedBy(script(`process.exit(0);`), "A1");
    refusedBy(script(`const p = spawn("ls");`), "A1");
    refusedBy(script(`const w = new Worker("x.js");`), "A1");
    refusedBy(script(`api.log("child_process");`), "A1");
  });
});

describe("A2 no imports of any kind", () => {
  it("refuses static, dynamic and require imports, re-exports and import.meta", () => {
    refusedBy(script(``, `import fs from "node:fs";`), "A2");
    refusedBy(script(`const m = import("node:fs");`), "A2");
    refusedBy(script(`const m = require("fs");`), "A2");
    refusedBy(script(`api.log(import.meta.url);`), "A2");
    refusedBy(script(``, `export * from "./other.mjs";`), "A2");
    refusedBy(script(``, `export { x } from "./other.mjs";`), "A2");
  });
});

describe("A3 no network beyond our endpoints", () => {
  it("refuses network primitives", () => {
    refusedBy(script(`fetch("https://feast.meme");`), "A3");
    refusedBy(script(`const s = new WebSocket("wss://x");`), "A3");
    refusedBy(script(`const x = new XMLHttpRequest();`), "A3");
    refusedBy(script(`navigator.sendBeacon("x");`), "A3");
  });
  it("refuses a URL to any other host, and lets ours be", () => {
    refusedBy(script(`api.log("https://evil.example/collect");`), "A3");
    refusedBy(script(`api.log("wss://relay.example");`), "A3");
    passes(script(`api.log("https://indexer.feast.meme/v1/board");`));
  });
});

describe("A4 no secrets", () => {
  it("refuses key-shaped hex, seed-phrase-shaped words, API-key prefixes and key paths", () => {
    refusedBy(script(`const k = "0x${"ab".repeat(32)}";`), "A4");
    refusedBy(script(`const m = "abandon ability able about above absent absorb abstract absurd abuse access accident";`), "A4");
    refusedBy(script(`const t = "sk-live-0123456789abcdef";`), "A4");
    refusedBy(script(`api.log(".env");`), "A4");
    refusedBy(script(`const PRIVATE_KEY = 1;`), "A4");
  });
});

describe("A5 no dynamic code, no reaching for globals", () => {
  it("refuses eval, Function, globals, prototype chains and with", () => {
    refusedBy(script(`eval("1");`), "A5");
    refusedBy(script(`const f = new Function("return 1");`), "A5");
    refusedBy(script(`const g = globalThis;`), "A5");
    refusedBy(script(`const c = api.constructor;`), "A5");
    refusedBy(script(`const p = ({}).__proto__;`), "A5");
    refusedBy(script(`const r = Reflect.ownKeys({});`), "A5");
    refusedBy(script(`const w = WebAssembly;`), "A5");
  });
});

describe("A6 bounded loops, no timers", () => {
  it("refuses while, do-while, an unbounded or too-long for, recursion and timers", () => {
    refusedBy(script(`while (true) {}`), "A6");
    refusedBy(script(`do {} while (false);`), "A6");
    refusedBy(script(`for (;;) {}`), "A6");
    refusedBy(script(`for (let i = 0; i < 100000; i++) {}`), "A6");
    refusedBy(script(`for (let i = 0; i < n; i++) {}`), "A6");
    refusedBy(`export const meta = { name: "t", tickSeconds: 60 };\nfunction again(n) { return again(n + 1); }\nexport function onTick(api) { again(1); }\n`, "A6");
    refusedBy(script(`setTimeout(() => {}, 1);`), "A6");
    refusedBy(script(`setInterval(() => {}, 1);`), "A6");
    refusedBy(script(`queueMicrotask(() => {});`), "A6");
  });
});

describe("A7 shape", () => {
  it("refuses other exports, a tick outside 15–3600 s, top-level side effects, no handler, a huge file, a non-ASCII identifier, a parse error", () => {
    refusedBy(script(``, `export const extra = 1;`), "A7");
    refusedBy(`export const meta = { name: "t", tickSeconds: 5 };\nexport function onTick(api) {}\n`, "A7");
    refusedBy(script(``, `api.log("loaded");`), "A7");
    refusedBy(`export const meta = { name: "t", tickSeconds: 60 };\n`, "A7");
    refusedBy(script(`// ${"x".repeat(70_000)}`), "A7");
    refusedBy(script(`const bàw = 1;`), "A7");
    refusedBy(script(`const x = ;`), "A7");
  });
  it("accepts params and onEvent alongside", () => {
    passes(`export const meta = { name: "t", tickSeconds: 900 };\nexport const params = { size: 0.002 };\nexport function onTick(api) {}\nexport function onEvent(api, event) { api.log(event.type); }\n`);
  });
});

describe("A8 only the runtime's functions", () => {
  it("refuses any api member outside buy, sell, launch, read.*, state, params, log, and computed access on api", () => {
    refusedBy(script(`api.signer.send();`), "A8");
    refusedBy(script(`api.read.wallet();`), "A8");
    refusedBy(script(`const k = "buy"; api[k]({});`), "A8");
    refusedBy(script(`const { exec } = api;`), "A8");
    passes(script(`const { read, buy } = api; buy({ coin: "FEAST", bnb: 0.001 }); read.now();`));
  });
});

describe("A9 sizes (a warning, not a refusal)", () => {
  it("warns of a literal size above the per-trade limit", () => {
    const audit = auditSource(script(`api.buy({ coin: "FEAST", bnb: 0.5 });`), { maxTradeBnb: 0.02 });
    expect(audit.verdict).toBe("pass");
    expect(audit.hits.some((h) => h.rule === "A9" && h.severity === "warn")).toBe(true);
  });
});

describe("obfuscation does not hide a forbidden word", () => {
  it("folds concatenated strings and reads computed keys", () => {
    refusedBy(script(`api.log("ba" + "w");`), "A1");
    refusedBy(script(`const g = this["glob" + "alThis"];`), "A5");
    refusedBy(script(`const x = ({})["constructor"]["constructor"];`), "A5");
    refusedBy(script(`const m = import("child_" + "process");`), "A2");
    refusedBy(script("const u = `ws${'s'}://relay.example`;"), "A3");
    refusedBy(script(`const s = "pro" + "cess";`), "A1");
  });
  it("refuses identifiers spelled with escapes", () => {
    refusedBy(script(`const \\u0062aw = 1;`), "A7");
  });
});

describe("the example scripts", () => {
  const read = (name: string) => readFileSync(new URL(`../../../examples/scripts/${name}`, import.meta.url), "utf8");

  it("round-trip.mjs passes", () => {
    passes(read("round-trip.mjs"));
  });

  it("calls-baw.mjs is refused for calling the wallet directly (A1) and importing child_process (A2), with line numbers", () => {
    const audit = auditSource(read("calls-baw.mjs"), { maxTradeBnb: 0.02 });
    expect(audit.verdict).toBe("refuse");
    expect(rulesHit(read("calls-baw.mjs"))).toEqual(expect.arrayContaining(["A1", "A2"]));
    expect(audit.hits.every((h) => h.line > 0)).toBe(true);
  });

  it("a verdict is bound to the file's exact bytes", () => {
    const a = read("round-trip.mjs");
    expect(sha256Of(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(sha256Of(a)).not.toBe(sha256Of(`${a} `));
    expect(auditSource(a).sha256).toBe(sha256Of(a));
  });
});
