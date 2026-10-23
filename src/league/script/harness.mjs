// The script sandbox's child process (PLAN.md §5.2). The parent starts it as:
//
//   node --permission --allow-fs-read=<this file> --disallow-code-generation-from-strings
//        --experimental-vm-modules --max-old-space-size=128 --no-warnings harness.mjs
//
// with an empty environment and an IPC channel as its only way out: no file but
// this one may be read, nothing may be written, no child process (so no wallet
// CLI), no worker, no addon. The user's script arrives as text over IPC and runs
// as a module inside a vm context with code generation from strings and wasm
// disabled, no `process`, no `fetch`, no timers, frozen intrinsics, and no
// imports (linking refuses every one). Only JSON strings cross the boundary:
// a snapshot goes in, intent requests and the script's state come out.

import vm from "node:vm";
import { randomBytes } from "node:crypto";

const send = process.send.bind(process);
const LOAD_TIMEOUT_MS = 1_000;

let context = null;
let callScript = null;
let inputName = null;
let meta = null;

// The api, defined inside the context, so the script only ever touches objects of its own realm.
const RUNNER = String.raw`(() => {
  "use strict";
  let ns = null;
  const lc = (s) => String(s).toLowerCase();
  return {
    set(namespace) { ns = namespace; },
    // Read the script's own objects here, inside the context and under the timeout: never from the host.
    describe() {
      const m = ns.meta && typeof ns.meta === "object" ? ns.meta : {};
      const meta = {
        name: typeof m.name === "string" ? m.name.slice(0, 60) : "script",
        tickSeconds: typeof m.tickSeconds === "number" ? m.tickSeconds : 60,
        events: Array.isArray(m.events) ? m.events.filter((e) => typeof e === "string").slice(0, 5) : [],
        watch: Array.isArray(m.watch) ? m.watch.filter((w) => typeof w === "string").slice(0, 20) : [],
      };
      const params = ns.params && typeof ns.params === "object" ? JSON.parse(JSON.stringify(ns.params)) : {};
      return JSON.stringify({ meta, params, exports: Object.keys(ns) });
    },
    run(inputJson) {
      const onTick = ns.onTick;
      const onEvent = ns.onEvent;
      const input = JSON.parse(inputJson);
      const s = input.snapshot;
      const out = { requests: [], logs: [] };
      const resolve = (coin) => (typeof coin === "string" && coin.trim().toUpperCase() === "FEAST" ? s.feast : coin);
      const read = Object.freeze({
        now: () => s.now,
        balance: () => s.balanceBnb,
        limits: () => ({ ...s.limits }),
        warmup: () => (s.warmup ? { ...s.warmup } : null),
        coins: (o) => {
          const sort = o && o.sort ? o.sort : "volume";
          const limit = Math.max(0, Math.min(200, Math.floor(o && o.limit !== undefined ? o.limit : 50)));
          const rows = s.coins.slice();
          if (sort === "new") rows.sort((a, b) => b.launchedAt - a.launchedAt);
          else if (sort === "holders") rows.sort((a, b) => b.holders - a.holders);
          else rows.sort((a, b) => b.volume24hBnb - a.volume24hBnb);
          return rows.slice(0, limit);
        },
        coin: (c) => {
          const k = lc(resolve(c));
          return s.coins.find((r) => lc(r.coin) === k) || s.coins.find((r) => r.symbol && r.symbol.toUpperCase() === String(c).toUpperCase()) || null;
        },
        trades: (c, o) => {
          const k = c ? lc(resolve(c)) : null;
          const since = o && o.sinceMs !== undefined ? o.sinceMs : undefined;
          const limit = Math.max(0, Math.min(1000, Math.floor(o && o.limit !== undefined ? o.limit : 200)));
          return s.trades.filter((t) => (k ? lc(t.coin) === k : true) && (since === undefined || t.at >= since)).slice(-limit);
        },
        positions: () => s.positions.map((p) => ({ ...p })),
        position: (c) => {
          const k = lc(resolve(c));
          const p = s.positions.find((x) => lc(x.coin) === k);
          return p ? { ...p } : null;
        },
        holders: (c, since) => (s.holders[lc(resolve(c))] || []).filter((r) => since === undefined || r.at >= since),
        launchesBy: (creator, since) => (s.launchesByCreator[lc(creator)] || []).filter((t) => since === undefined || t >= since).length,
        launched: () => (s.launched ? { ...s.launched } : null),
        stale: () => (s.stale ? { sinceMs: s.stale.sinceMs, reason: s.stale.reason } : null),
      });
      const push = (request) => { if (out.requests.length < 50) out.requests.push(request); return "requested-" + out.requests.length; };
      const api = Object.freeze({
        read,
        buy: (r) => push({ kind: "buy", coin: resolve(r && r.coin), bnb: r && r.bnb, reason: r && r.reason }),
        sell: (r) => push({ kind: "sell", coin: resolve(r && r.coin), fraction: r && r.fraction, reason: r && r.reason }),
        launch: (r) => push({ kind: "launch", name: r && r.name, symbol: r && r.symbol, quote: r && r.quote, description: r && r.description, burn: r && r.burn, referrer: r && r.referrer, reason: r && r.reason }),
        state: input.state,
        params: Object.freeze(input.params),
        log: (text) => { if (out.logs.length < 50) out.logs.push(String(text).slice(0, 500)); },
      });
      const fn = input.fn === "onEvent" ? onEvent : onTick;
      if (typeof fn !== "function") return JSON.stringify({ ok: true, requests: [], logs: [], state: input.state });
      const returned = input.fn === "onEvent" ? fn(api, input.event) : fn(api);
      if (returned && typeof returned.then === "function") throw new Error(input.fn + " must return synchronously");
      return JSON.stringify({ ok: true, requests: out.requests, logs: out.logs, state: api.state });
    },
  };
})()`;

const FREEZE = String.raw`(() => {
  for (const C of [Object, Array, Function, String, Number, Boolean, Symbol, Map, Set, WeakMap, WeakSet, Date, Promise, RegExp, Error, TypeError, RangeError, BigInt, Math, JSON]) {
    Object.freeze(C);
    if (C.prototype) Object.freeze(C.prototype);
  }
  delete globalThis.globalThis;
})()`;

async function load(source) {
  // microtaskMode "afterEvaluate": promise jobs the script queues drain inside each timed call, never after it.
  context = vm.createContext({}, { name: "feast-script", codeGeneration: { strings: false, wasm: false }, microtaskMode: "afterEvaluate" });
  const runner = vm.runInContext(RUNNER, context);
  vm.runInContext(FREEZE, context);
  const module = new vm.SourceTextModule(source, { context, identifier: "strategy.mjs" });
  await module.link(() => {
    throw new Error("imports are not allowed in a strategy script");
  });
  await module.evaluate({ timeout: LOAD_TIMEOUT_MS });
  if (module.status === "errored") throw module.error;
  runner.set(module.namespace);
  // The runner and the input travel under random global names, defined non-enumerable on a global object nobody can name.
  const token = randomBytes(12).toString("hex");
  const runName = `__run_${token}`;
  const describeName = `__describe_${token}`;
  inputName = `__in_${token}`;
  Object.defineProperty(context, runName, { value: (json) => runner.run(json), enumerable: false });
  Object.defineProperty(context, describeName, { value: () => runner.describe(), enumerable: false });
  callScript = new vm.Script(`${runName}(${inputName})`);
  // Only a JSON string comes back across the boundary.
  const described = JSON.parse(String(new vm.Script(`${describeName}()`).runInContext(context, { timeout: LOAD_TIMEOUT_MS })));
  meta = described.meta;
  return { meta: described.meta, params: described.params, exports: described.exports };
}

/** One call into the script, under the vm's timeout: the input is a string, the answer is a string. */
function call(fn, inputJson, timeoutMs) {
  const payload = JSON.stringify({ ...JSON.parse(inputJson), fn });
  Object.defineProperty(context, inputName, { value: payload, configurable: true, enumerable: false, writable: false });
  return callScript.runInContext(context, { timeout: timeoutMs });
}

process.on("message", async (message) => {
  try {
    if (message?.type === "load") {
      const loaded = await load(String(message.source));
      send({ type: "loaded", ...loaded });
    } else if (message?.type === "call") {
      const result = call(message.fn === "onEvent" ? "onEvent" : "onTick", String(message.input), Number(message.timeoutMs) || 1_000);
      send({ type: "result", id: message.id, result: String(result) });
    }
  } catch (error) {
    send({ type: "error", id: message?.id ?? null, error: String(error?.message ?? error).slice(0, 500) });
  }
});
send({ type: "ready" });
