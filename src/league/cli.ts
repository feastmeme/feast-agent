#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { getAddress, isAddress, type Address } from "viem";

import { approveCall, MAX_UINT160, permit2ApproveCall } from "../sdk/infinity.ts";
import { MAINNET } from "../sdk/networks.ts";
import { applyChange, confirmAgent, loadAgent, planAgent, saveAgent, type AgentConfig } from "./agent.ts";
import { AUDIT_RULES } from "./audit/static.ts";
import { auditFile, auditRefusal, recordModelVerdict } from "./audit/verdict.ts";
import { BawSigner, execRunner } from "./baw.ts";
import { bookView } from "./book.ts";
import { renderCard } from "./card.ts";
import { DEFAULT_MAINNET_RPC, LeagueChain } from "./chain.ts";
import { INDEXER_URL } from "./events.ts";
import { Executor } from "./executor.ts";
import { guard } from "./guard.ts";
import { bnbToWei, weiToBnb } from "./limits.ts";
import { PRESETS, PRESET_IDS } from "./presets/specs.ts";
import { runAgent, statusOf } from "./runtime.ts";
import { agentPaths, appendJsonl, leagueHome, readLedger, removeStop, stopReason, walletLockHolder, writeJsonAtomic, writeStop } from "./store.ts";
import { normalizeIntent } from "./strategy.ts";

const HELP = `feast-league — run a Feast agent with your Binance Agentic Wallet

  plan <name> --preset <${PRESET_IDS.join("|")}> [--set key=value]… [--limit key=value]… [--tick s] [--sentence "…"]
  plan <name> --script <file.mjs> [--limit key=value]… [--tick s] [--sentence "…"]
                                  validate and save an agent, and print its confirmation card
  card <name>                     print the confirmation card again
  start <name> --yes [--detach]   the user said yes: confirm and start (real BNB, no practice mode)
  stop <name> | --all             write the stop file and wait for the agent to halt
  resume <name> [--all] [--detach] remove the stop file (--all: the global one too) and start again
  status <name> [--json]          the book, the limits and the latest notifications
  set <name> [--set k=v]… [--limit k=v]… [--tick s] (--yes | --review)
                                  change a confirmed agent (--review may only tighten)
  review <name>                   the last hour, as JSON, for the optional hourly review
  audit <file.mjs> [--model-verdict pass|refuse --notes "…"]
                                  the script audit: static rules, then the model read's verdict
  buy <name> <coin|FEAST> <bnb>   one guarded buy, through the agent's limits
  sell <name> <coin|FEAST> <fraction|all>
  preview <buy|approve|permit2|sell|claim|create|register> [--coin c] [--bnb x]
                                  preview-only checks: the wallet's answer, nothing executed
  agents                          the agents on this machine
  doctor                          is everything in place?

Home: $FEAST_LEAGUE_HOME (default ~/.feast-league). RPC: $FEAST_MAINNET_RPC_URL (default the Binance dataseed).`;

const BIN = fileURLToPath(new URL("./bin.mjs", import.meta.url));

function kv(list: string[] | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const item of list ?? []) {
    const i = item.indexOf("=");
    if (i <= 0) throw new Error(`"${item}" is not key=value`);
    const key = item.slice(0, i).trim();
    const raw = item.slice(i + 1).trim();
    out[key] = raw === "true" ? true : raw === "false" ? false : raw === "off" ? null : /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw;
  }
  return out;
}

function signerFor(home: string, name: string | null): BawSigner {
  return new BawSigner(execRunner(), (command) => {
    if (name) appendJsonl(agentPaths(home, name).log, { at: new Date().toISOString(), event: "baw.invoke", command });
  });
}

const rpc = () => process.env.FEAST_MAINNET_RPC_URL?.trim() || DEFAULT_MAINNET_RPC;
const print = (json: boolean, data: unknown, human: () => string) => console.log(json ? JSON.stringify(data, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2) : human());

function detach(home: string, name: string, extra: string[] = []): number {
  const paths = agentPaths(home, name);
  mkdirSync(paths.dir, { recursive: true });
  const outFd = openSync(join(paths.dir, "runtime.out"), "a", 0o600);
  const child = spawn(process.execPath, [BIN, "run", name, ...extra], { detached: true, stdio: ["ignore", outFd, outFd], env: { ...process.env, FEAST_LEAGUE_HOME: home } });
  child.unref();
  return child.pid ?? 0;
}

async function waitForExit(home: string, name: string, seconds: number): Promise<boolean> {
  const until = Date.now() + seconds * 1_000;
  while (Date.now() < until) {
    if (!statusOf(home, name).running) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return !statusOf(home, name).running;
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      preset: { type: "string" },
      script: { type: "string" },
      set: { type: "string", multiple: true },
      limit: { type: "string", multiple: true },
      tick: { type: "string" },
      sentence: { type: "string" },
      yes: { type: "boolean", default: false },
      review: { type: "boolean", default: false },
      detach: { type: "boolean", default: false },
      all: { type: "boolean", default: false },
      wait: { type: "string" },
      json: { type: "boolean", default: false },
      "model-verdict": { type: "string" },
      notes: { type: "string" },
      "max-runtime": { type: "string" },
      coin: { type: "string" },
      bnb: { type: "string" },
      home: { type: "string" },
      "clear-pause": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const [command, ...args] = positionals;
  if (!command || values.help) {
    console.log(HELP);
    return command ? 0 : 1;
  }
  const home = values.home ?? leagueHome();
  const json = values.json;
  const need = (value: string | undefined, what: string) => {
    if (!value) throw new Error(`missing ${what}; see feast-league --help`);
    return value;
  };

  switch (command) {
    case "plan": {
      const name = need(args[0], "an agent name");
      const planned = planAgent({
        name,
        preset: values.preset,
        scriptPath: values.script,
        params: kv(values.set),
        limits: kv(values.limit),
        tickSeconds: values.tick ? Number(values.tick) : undefined,
        sentence: values.sentence,
      });
      if (!planned.ok) {
        print(json, { ok: false, errors: planned.errors }, () => `not planned:\n- ${planned.errors.join("\n- ")}`);
        return 2;
      }
      const existing = loadAgent(home, name);
      if (existing && statusOf(home, name).running) throw new Error(`agent "${name}" is running; stop it, or change it with feast-league set`);
      saveAgent(home, planned.agent);
      if (planned.audit) auditFile(home, planned.agent.script!.path, { maxTradeBnb: planned.agent.limits.maxTradeBnb });
      print(json, { ok: true, agent: planned.agent, audit: planned.audit, card: renderCard(planned.agent, planned.audit) }, () => renderCard(planned.agent, planned.audit));
      return 0;
    }
    case "card": {
      const agent = loadAgent(home, need(args[0], "an agent name"));
      if (!agent) throw new Error("no such agent");
      console.log(renderCard(agent));
      return 0;
    }
    case "start":
    case "resume":
    case "run": {
      const name = need(args[0], "an agent name");
      let agent = loadAgent(home, name);
      if (!agent) throw new Error(`no agent "${name}": plan it first`);
      if (command === "resume") {
        removeStop(agentPaths(home, name).stop);
        if (existsSync(join(home, "STOP"))) {
          if (!values.all) throw new Error("the global stop file is present too (feast-league stop --all wrote it); resume with --all to remove it");
          removeStop(join(home, "STOP"));
        }
      }
      if (command !== "run" && !agent.confirmed) {
        if (!values.yes) {
          console.log(`${renderCard(agent)}\n\nNot started: this needs the user's explicit yes (--yes).`);
          return 2;
        }
        agent = confirmAgent(agent);
        saveAgent(home, agent);
      }
      if (agent.track === "script") {
        const why = auditRefusal(home, agent.script!.path);
        if (why) {
          print(json, { ok: false, refused: why }, () => `not started: ${why}`);
          return 2;
        }
      }
      const extra = values["max-runtime"] ? ["--max-runtime", values["max-runtime"]] : [];
      if (command === "resume" && statusOf(home, name).running) {
        // Running already (an L14 pause stops entries, not the runtime): the user's resume clears the pause in place.
        const paths = agentPaths(home, name);
        mkdirSync(paths.inbox, { recursive: true });
        writeJsonAtomic(join(paths.inbox, `${Date.now()}-unpause.json`), { type: "unpause" });
        console.log(`"${name}" is running; its pause is cleared`);
        return 0;
      }
      if (values.detach && command !== "run") {
        const holder = walletLockHolder(home);
        if (holder) throw new Error(`the wallet is in use by agent "${holder.agent}"; stop it first`);
        const pid = detach(home, name, command === "resume" ? [...extra, "--clear-pause"] : extra);
        console.log(`started "${name}" in the background (pid ${pid}); feast-league status ${name}`);
        return 0;
      }
      const outcome = await runAgent({
        home,
        name,
        signer: signerFor(home, name),
        rpcUrl: rpc(),
        maxRuntimeMs: values["max-runtime"] ? Number(values["max-runtime"]) * 1_000 : undefined,
        clearPause: command === "resume" || values["clear-pause"],
      });
      console.log(`${name}: ${outcome.exit} — ${outcome.reason}`);
      return outcome.exit === "error" ? 1 : outcome.exit === "refused" ? 2 : 0;
    }
    case "stop": {
      const names = values.all ? (existsSync(join(home, "agents")) ? readdirSync(join(home, "agents")) : []) : [need(args[0], "an agent name (or --all)")];
      if (values.all) writeStop(join(home, "STOP"), "stop requested by the user");
      for (const name of names) {
        writeStop(agentPaths(home, name).stop, "stop requested by the user");
        const exited = await waitForExit(home, name, values.wait ? Number(values.wait) : 150);
        console.log(`${name}: ${exited ? "halted" : "the stop file is written; the runtime has not exited yet (it finishes recording a sent transaction first)"}`);
      }
      return 0;
    }
    case "status": {
      const name = need(args[0], "an agent name");
      const s = statusOf(home, name);
      if (!s.agent) throw new Error("no such agent");
      const view = s.book ? bookView(s.book, undefined, Date.now()) : null;
      const data = {
        name,
        running: s.running,
        stop: s.stop,
        track: s.agent.track,
        preset: s.agent.preset,
        confirmed: s.agent.confirmed?.at ?? null,
        limits: s.agent.limits,
        positions: s.book ? Object.values(s.book.positions).map((p) => ({ coin: p.coin, symbol: p.symbol, coins: p.coins, costBnb: weiToBnb(p.costWei), armed: p.armed, ownLaunch: p.ownLaunch })) : [],
        spent24hBnb: view ? weiToBnb(view.spent24hWei) : 0,
        leagueSpentBnb: weiToBnb(readLedger(home).spentWei),
        realizedBnb: s.book ? weiToBnb(s.book.realizedTotalWei) : 0,
        gasBnb: s.book ? weiToBnb(s.book.gasWei) : 0,
        counters: s.book?.counters ?? null,
        paused: s.book?.paused ?? null,
        warmup: s.book?.warmup ?? null,
        notifications: s.notifications,
      };
      print(json, data, () =>
        [
          `${name}: ${s.running ? "running" : "not running"}${s.stop ? ` (stop file: ${s.stop})` : ""}; ${s.agent!.track === "preset" ? `preset ${s.agent!.preset}` : "script"}`,
          `positions: ${data.positions.length ? data.positions.map((p) => `${p.symbol} ${p.costBnb} BNB${p.armed ? "" : " (exit not armed)"}`).join(", ") : "none"}`,
          `spent in 24 h: ${data.spent24hBnb} BNB; the league in all: ${data.leagueSpentBnb} BNB of ${s.agent!.limits.budgetBnb}; realized ${data.realizedBnb} BNB; gas ${data.gasBnb} BNB`,
          ...(data.paused ? [`paused: ${data.paused}`] : []),
          ...(data.warmup ? [`warm-up: ${data.warmup.trades} of 5 trades`] : []),
          "latest:",
          ...s.notifications.slice(-8).map((n) => `  ${(n as { at: string }).at} ${(n as { kind: string }).kind}: ${(n as { text: string }).text}`),
        ].join("\n"),
      );
      return 0;
    }
    case "set": {
      const name = need(args[0], "an agent name");
      const agent = loadAgent(home, name);
      if (!agent) throw new Error("no such agent");
      if (!values.yes && !values.review) throw new Error("a change needs --yes (the user's word) or --review (the hourly review, which may only tighten)");
      const changed = applyChange(agent, { params: kv(values.set), limits: kv(values.limit), tickSeconds: values.tick ? Number(values.tick) : undefined }, { byReview: values.review });
      if (!changed.ok) {
        print(json, { ok: false, errors: changed.errors }, () => `not changed:\n- ${changed.errors.join("\n- ")}`);
        return 2;
      }
      saveAgent(home, changed.agent);
      const paths = agentPaths(home, name);
      mkdirSync(paths.inbox, { recursive: true });
      writeJsonAtomic(join(paths.inbox, `${Date.now()}-reload.json`), { type: "reload" });
      appendJsonl(paths.log, { at: new Date().toISOString(), event: "agent.changed", by: values.review ? "review" : "user", params: kv(values.set), limits: kv(values.limit) });
      print(json, { ok: true, agent: changed.agent }, () => `changed "${name}"${values.review ? " (review)" : ""}`);
      return 0;
    }
    case "review": {
      const name = need(args[0], "an agent name");
      const s = statusOf(home, name);
      if (!s.agent) throw new Error("no such agent");
      const paths = agentPaths(home, name);
      const since = Date.now() - 3_600_000;
      const lines = existsSync(paths.log) ? readFileSync(paths.log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { at: string; event: string }) : [];
      const hour = lines.filter((l) => Date.parse(l.at) >= since);
      console.log(
        JSON.stringify(
          {
            name,
            preset: s.agent.preset,
            params: s.agent.params,
            limits: s.agent.limits,
            envelope: s.agent.confirmed,
            lastHour: {
              trades: hour.filter((l) => l.event === "buy.filled" || l.event === "sell.filled"),
              refusals: hour.filter((l) => l.event === "intent.refused"),
              failures: hour.filter((l) => l.event === "intent.failed"),
            },
            book: s.book ? { positions: Object.keys(s.book.positions).length, realizedBnb: weiToBnb(s.book.realizedTotalWei), paused: s.book.paused } : null,
            rule: "the review may tighten anything and retune thresholds with `feast-league set <name> --review`; it may not raise a size, a stop-loss, a slippage or a limit past the envelope",
          },
          (_k, v) => (typeof v === "bigint" ? v.toString() : v),
          2,
        ),
      );
      return 0;
    }
    case "audit": {
      const file = need(args[0], "a script file");
      const verdict = values["model-verdict"];
      const record = verdict
        ? recordModelVerdict(home, file, verdict === "pass" ? "pass" : "refuse", values.notes ?? "")
        : auditFile(home, file, { maxTradeBnb: 0.02 });
      print(json, record, () =>
        [
          `${record.file}`,
          `sha256 ${record.sha256}`,
          `static rules: ${record.static.verdict.toUpperCase()}`,
          ...record.static.hits.map((h) => `  ${h.severity === "refuse" ? "✗" : "!"} ${h.rule} line ${h.line}:${h.column} — ${h.message}`),
          ...(record.static.verdict === "pass" ? [`model read: ${record.model ? `${record.model.verdict.toUpperCase()} (${record.model.at})` : "not yet: read it against the checklist, then record the verdict with --model-verdict"}`] : []),
          "",
          "The rules: " + AUDIT_RULES.map((r) => `${r.id} ${r.rule.split(":")[0]}`).join("; "),
        ].join("\n"),
      );
      return record.static.verdict === "pass" ? 0 : 2;
    }
    case "buy":
    case "sell": {
      const name = need(args[0], "an agent name");
      const agent = loadAgent(home, name);
      if (!agent?.confirmed) throw new Error(`no confirmed agent "${name}"`);
      const coin = need(args[1], "a coin (an address or FEAST)");
      const amount = need(args[2], command === "buy" ? "an amount of BNB" : "a fraction (0–1) or all");
      const request =
        command === "buy"
          ? { kind: "buy" as const, coin, bnb: Number(amount), reason: "manual buy" }
          : { kind: "sell" as const, coin, fraction: amount === "all" ? 1 : Number(amount), reason: "manual sale" };
      // The limits that need no wallet are checked before anything is asked of the wallet.
      const early = refuseEarly(home, agent, request);
      if (early) {
        appendJsonl(agentPaths(home, name).log, { at: new Date().toISOString(), event: "intent.refused", source: "manual", limit: early.limit, message: early.message, before: "any wallet call" });
        print(json, { ok: false, refused: early }, () => `refused by ${early.limit}: ${early.message} (nothing was asked of the wallet)`);
        return 2;
      }
      if (statusOf(home, name).running) {
        const paths = agentPaths(home, name);
        mkdirSync(paths.inbox, { recursive: true });
        writeJsonAtomic(join(paths.inbox, `${Date.now()}-${command}.json`), { type: "intent", request });
        console.log(`queued for the running agent "${name}"; feast-league status ${name}`);
        return 0;
      }
      const outcome = await runAgent({ home, name, signer: signerFor(home, name), rpcUrl: rpc(), only: [request] });
      console.log(`${name}: ${outcome.exit} — ${outcome.reason}`);
      return outcome.exit === "finished" ? 0 : 2;
    }
    case "preview":
      return previewCheck(home, need(args[0], "a check"), values.coin, values.bnb, json);
    case "agents": {
      const dir = join(home, "agents");
      const names = existsSync(dir) ? readdirSync(dir) : [];
      for (const name of names) {
        const s = statusOf(home, name);
        console.log(`${name}\t${s.agent?.track ?? "?"}\t${s.agent?.preset ?? s.agent?.script?.path ?? ""}\t${s.running ? "running" : "stopped"}${s.stop ? " (stop file)" : ""}`);
      }
      return 0;
    }
    case "doctor":
      return doctor(home, json);
    default:
      console.error(`unknown command "${command}"\n\n${HELP}`);
      return 1;
  }
}

/** A guard pass with an optimistic wallet: what it refuses, it refuses without asking the wallet anything. */
function refuseEarly(home: string, agent: AgentConfig, request: { kind: "buy"; coin: string; bnb: number; reason: string } | { kind: "sell"; coin: string; fraction: number; reason: string }) {
  const feast = MAINNET.platformCoin!.address;
  const normal = normalizeIntent(request, { snapshot: { feast, now: Date.now(), limits: agent.limits }, source: "manual", slippagePct: Math.min(3, agent.limits.maxSlippagePct), ttlMs: 120_000 });
  if ("error" in normal) return { limit: "L15", message: normal.error };
  const book = statusOf(home, agent.name).book;
  const view = book ? bookView(book, normal.intent.coin, Date.now()) : { openPositions: 0, hasPosition: false, exposureWei: 0n, spent24hWei: 0n, realizedLoss24hWei: 0n, trades1h: 0, lastEntryAt: null, paused: null, drawdownWei: 0n };
  const verdict = guard({
    intent: normal.intent,
    limits: agent.limits,
    now: Date.now(),
    wallet: { connected: true, devMode: true, quotaLeftUsd: Number.POSITIVE_INFINITY, balanceWei: 10n ** 30n },
    bnbUsd: 0,
    stopped: stopReason(home, agent.name) !== null,
    coinIsFeast: true,
    book: view,
    walletSpentWei: readLedger(home).spentWei,
    claimFundsWei: book?.claimFundsWei ?? 0n,
    warmup: agent.track === "script" ? book?.warmup ?? null : null,
  });
  return verdict.ok ? null : { limit: verdict.limit, message: verdict.message };
}

/** The preview-only checks of PLAN.md §8.2: the wallet's answer to each call shape. Nothing is executed. */
async function previewCheck(home: string, check: string, coinArg: string | undefined, bnbArg: string | undefined, json: boolean): Promise<number> {
  const name = "preview-checks";
  const paths = agentPaths(home, name);
  mkdirSync(paths.dir, { recursive: true });
  const signer = signerFor(home, name);
  const wallet = await signer.address();
  const chain = new LeagueChain(MAINNET, rpc());
  const log = (event: string, fields: Record<string, unknown>) =>
    appendJsonl(paths.log, JSON.parse(JSON.stringify({ at: new Date().toISOString(), event, check, ...fields }, (_k, v) => (typeof v === "bigint" ? v.toString() : v)).split(wallet).join("self").split(wallet.toLowerCase()).join("self")));
  const executor = new Executor({ signer, chain, wallet, network: MAINNET, rpcUrl: rpc(), stopReason: () => stopReason(home, name), log });
  const trade = MAINNET.trade.kind === "infinity" ? MAINNET.trade : null!;
  const feast = MAINNET.platformCoin!.address;
  const coin = coinArg && isAddress(coinArg) ? getAddress(coinArg) : feast;
  const report = (result: unknown) => {
    const text = JSON.stringify(result, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2).split(wallet).join("self").split(wallet.toLowerCase()).join("self");
    console.log(json ? text : `${check}: ${text}`);
  };
  await executor.learn(coin);

  if (check === "register") {
    // The league page's registration (task 927): EIP-712 with no verifyingContract. Preview only: never signed.
    const typed = {
      types: {
        EIP712Domain: [
          { name: "name", type: "string" },
          { name: "version", type: "string" },
          { name: "chainId", type: "uint256" },
        ],
        Register: [
          { name: "wallet", type: "address" },
          { name: "name", type: "string" },
          { name: "strategy", type: "string" },
          { name: "copies", type: "address" },
          { name: "issuedAt", type: "uint256" },
        ],
      },
      primaryType: "Register",
      domain: { name: "Feast League", version: "1", chainId: 56 },
      message: { wallet, name: "preview-check", strategy: "dca", copies: "0x0000000000000000000000000000000000000000", issuedAt: String(Math.floor(Date.now() / 1_000)) },
    };
    const message = JSON.stringify({ method: "eth_signTypedData_v4", params: [wallet, JSON.stringify(typed)] });
    const answer = (await signer.signMessagePreview(message)) as Record<string, unknown>;
    const data = (answer.data ?? {}) as Record<string, unknown>;
    const result = {
      accepted: answer.success === true && typeof data.requestId === "string",
      error: answer.error ?? null,
      parsedMessage: data.parsedMessage ?? null,
      risks: data.risks ?? null,
      requireConfirmation: data.requireConfirmation ?? null,
      executed: false,
    };
    log("preview.register", result);
    report(result);
    return 0;
  }

  let call;
  if (check === "buy") {
    const prepared = await executor.prepareBuy(coin, bnbToWei(bnbArg ? Number(bnbArg) : 0.001), 3);
    if (!prepared.ok) return report({ ok: false, reason: prepared.reason }), 2;
    call = prepared.value.call;
  } else if (check === "approve") call = approveCall(coin, trade.permit2);
  else if (check === "permit2") call = permit2ApproveCall(trade.permit2, coin, trade.router, MAX_UINT160, (await chain.chainTime()) + 30n * 24n * 3600n);
  else if (check === "sell") {
    const held = await chain.tokenBalance(coin, wallet);
    const prepared = await executor.prepareSell(coin, held > 0n ? held / 10n : 1n, 3);
    if (!prepared.ok) return report({ ok: false, reason: prepared.reason }), 2;
    call = prepared.value.call;
  } else if (check === "claim") {
    // The wallet's own launch, found on the board by its creator; held in memory only.
    const response = await fetch(`${INDEXER_URL}/v1/board?limit=100`);
    const rows = ((await response.json()) as { data?: { coin: string; creator: string }[] }).data ?? [];
    const mine = rows.find((r) => r.creator.toLowerCase() === wallet.toLowerCase());
    if (!mine) return report({ ok: false, reason: "this wallet has launched no coin" }), 2;
    const prepared = await executor.prepareClaim(getAddress(mine.coin));
    if (!prepared.ok) return report({ ok: false, reason: prepared.reason }), 2;
    if (!prepared.value) return report({ ok: true, note: "the wallet's own coin owes it nothing to claim right now; a claim would be a no-op" }), 0;
    call = prepared.value.call;
  } else if (check === "create") {
    const prepared = await executor.prepareLaunch({ name: "Preview Check", symbol: "PRVW", quote: "WBNB", burn: 20, referrer: 10, metadataHash: `0x${"00".repeat(32)}` });
    if (!prepared.ok) return report({ ok: false, reason: prepared.reason }), 2;
    call = prepared.value.call;
  } else throw new Error(`unknown check "${check}"`);
  const result = await executor.previewOnly(check, call);
  report({ ...result, executed: false });
  return 0;
}

async function doctor(home: string, json: boolean): Promise<number> {
  const checks: { what: string; ok: boolean; detail: string }[] = [];
  checks.push({ what: "node", ok: Number(process.versions.node.split(".")[0]) >= 22, detail: process.version });
  checks.push({ what: "home", ok: true, detail: home });
  const signer = signerFor(home, null);
  try {
    const status = await signer.status();
    checks.push({ what: "wallet", ok: status.connected, detail: status.connected ? "connected" : `${status.status}: sign in with baw auth signin` });
    const settings = await signer.settings();
    checks.push({ what: "developer mode", ok: settings.devModeEnabled && !settings.balanceExceeded, detail: settings.devModeEnabled ? (settings.balanceExceeded ? "on, but the balance is above its limit" : `on until ${settings.devModeExpiresAt ? new Date(settings.devModeExpiresAt * 1_000).toISOString() : "?"}`) : "off: turn it on in the Binance App" });
    checks.push({ what: "session", ok: true, detail: settings.sessionExpireTime ? `ends ${settings.sessionExpireTime}` : "unknown" });
  } catch (error) {
    checks.push({ what: "wallet", ok: false, detail: `the baw CLI did not answer: ${(error as Error).message}` });
  }
  try {
    const r = await fetch(`${INDEXER_URL}/api/indexer/status`);
    const body = (await r.json()) as { verdict?: string; blocksBehind?: number };
    checks.push({ what: "indexer", ok: body.verdict === "serving", detail: `${body.verdict}, ${body.blocksBehind} blocks behind` });
  } catch (error) {
    checks.push({ what: "indexer", ok: false, detail: (error as Error).message });
  }
  try {
    const chain = new LeagueChain(MAINNET, rpc());
    const block = await chain.client.getBlockNumber();
    checks.push({ what: "BNB Smart Chain", ok: true, detail: `block ${block}` });
  } catch (error) {
    checks.push({ what: "BNB Smart Chain", ok: false, detail: (error as Error).message });
  }
  print(json, checks, () => checks.map((c) => `${c.ok ? "ok " : "NO "} ${c.what}: ${c.detail}`).join("\n"));
  return checks.every((c) => c.ok) ? 0 : 2;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(`feast-league: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  },
);

export { PRESETS };
