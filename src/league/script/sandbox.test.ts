import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";

import { ScriptSandbox } from "./sandbox.ts";

/**
 * The boundary, tested on its own: these scripts would never pass the static
 * audit, so the sandbox is fed them directly, as a script the audit missed would
 * reach it. Every escape must fail inside the child.
 */

const snapshot = {
  now: 1_000,
  balanceBnb: 1,
  limits: {},
  warmup: null,
  coins: [],
  positions: [],
  trades: [],
  holders: {},
  launchesByCreator: {},
  feast: "0x747dC14ec8B21bD9137dAc9148d61A084c18C2A2",
  launched: null,
};
const tick = (body: string) => `export const meta = { name: "t", tickSeconds: 60 };\nexport function onTick(api) {\n${body}\n}\n`;

let running: ScriptSandbox[] = [];
afterEach(() => {
  for (const sandbox of running) sandbox.stop();
  running = [];
});
async function start(source: string) {
  const sandbox = await ScriptSandbox.start(source);
  running.push(sandbox);
  return sandbox;
}
async function onTick(body: string, timeoutMs = 500) {
  const sandbox = await start(tick(body));
  return sandbox.call("onTick", { snapshot, state: {}, params: {} }, timeoutMs);
}

describe("the script sandbox", () => {
  it("runs the round-trip example and returns its request and state", async () => {
    const source = readFileSync(new URL("../../../examples/scripts/round-trip.mjs", import.meta.url), "utf8");
    const sandbox = await start(source);
    expect(sandbox.meta).toMatchObject({ name: "round-trip", tickSeconds: 15 });
    const out = await sandbox.call("onTick", { snapshot, state: {}, params: {} }, 500);
    expect(out).toMatchObject({ ok: true, requests: [{ kind: "buy", coin: snapshot.feast, bnb: 0.002 }], state: { bought: 1_000 } });
  });

  it("refuses to link any import", async () => {
    await expect(ScriptSandbox.start(`import fs from "node:fs";\n${tick("")}`)).rejects.toThrow(/imports are not allowed/);
  });

  it("has no process, no require, no fetch, no timers, no globalThis", async () => {
    for (const body of ["process.exit(1);", "require('fs');", "fetch('https://example.com');", "setTimeout(() => {}, 1);", "globalThis.x = 1;"]) {
      const out = await onTick(body);
      expect(out.ok, body).toBe(false);
    }
  });

  it("cannot reach the Function constructor's code generation, inside or across the realm", async () => {
    for (const body of [
      `const F = ({}).constructor.constructor; F("return process")();`,
      `const F = api.log.constructor; F("return 1")();`,
      `eval("1");`,
      `new Function("return 1")();`,
    ]) {
      const out = await onTick(body);
      expect(out.ok, body).toBe(false);
      if (!out.ok) expect(out.error, body).toMatch(/Code generation|not allowed|EvalError|is not defined|not a function/i);
    }
  });

  it("cannot import dynamically", async () => {
    const out = await onTick(`import("node:child_process");`);
    // A dynamic import with no callback rejects; the request list stays empty either way.
    if (out.ok) expect(out.requests).toEqual([]);
    else expect(out.error).toBeTruthy();
  });

  it("cannot change the intrinsics", async () => {
    const out = await onTick(`Object.prototype.polluted = 1;`);
    expect(out.ok).toBe(false);
    const arr = await onTick(`Array.prototype.push = function () {};`);
    expect(arr.ok).toBe(false);
  });

  it("stops an infinite loop at the time budget", async () => {
    const started = Date.now();
    const out = await onTick(`for (;;) {}`, 200);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toMatch(/timed out|overran/i);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("refuses an asynchronous handler", async () => {
    const sandbox = await start(`export const meta = { name: "t", tickSeconds: 60 };\nexport async function onTick(api) { api.buy({ coin: "FEAST", bnb: 0.001 }); }\n`);
    const out = await sandbox.call("onTick", { snapshot, state: {}, params: {} }, 500);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toMatch(/synchronously/);
  });

  it("caps what one call can ask for", async () => {
    const out = await onTick(`for (let i = 0; i < 500; i++) api.buy({ coin: "FEAST", bnb: 0.001 });`);
    expect(out.ok && out.requests.length).toBe(50);
  });
});
