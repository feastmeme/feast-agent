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
import { BawError, BawSigner, execRunner } from "./baw.ts";
import { bookView } from "./book.ts";
import { renderCard } from "./card.ts";
import { DEFAULT_MAINNET_RPC, LeagueChain } from "./chain.ts";
import { INDEXER_URL } from "./events.ts";
import { refuseEarly } from "./early.ts";
import { Executor } from "./executor.ts";
import { bnbToWei, weiToBnb } from "./limits.ts";
import { PRESETS, PRESET_IDS } from "./presets/specs.ts";
import { BODY_COIN_QUOTE, BODY_COIN_SPLIT, bodyCoinNames } from "./register/claims.ts";
import {
  agentIdUnreadable,
  alreadyLaunchedLine,
  bodyCoinProblem,
  checkCard,
  duration,
  langOf,
  launchCard,
  launchedLine,
  launchFailedLine,
  launchPresetOwnLine,
  manifestoProblem,
  nextStepLine,
  noAgentIdCard,
  noAnswerLine,
  preregLine,
  previewMismatch,
  queuedLaunchLine,
  refusalLine,
  registerCard,
  seatedLine,
  sessionNotice,
  signingLine,
  utc8,
  walletNotReady,
  walletUnreadable,
  xHandleProblem,
  type Lang,
  type SessionCode,
} from "./register/copy.ts";
import { check, prepare, readLeagueRecord, submit, type FlowDeps } from "./register/flow.ts";
import { ENTRY_AGENT } from "./enter/constants.ts";
import { enter, entryOneShot } from "./enter/flow.ts";
import { normalizeManifesto, previewDescribes, signRequestMessage } from "./register/message.ts";
import { LeagueSite, seatingOfKept, siteFromEnv } from "./register/site.ts";
import { runAgent, statusOf } from "./runtime.ts";
import { standingLines } from "./season-card.ts";
import { sessionView } from "./session.ts";
import { agentPaths, appendJsonl, checkAgentName, leagueHome, readLedger, removeStop, stopReason, unreadNotifications, walletLockHolder, writeJsonAtomic, writeStop } from "./store.ts";
import type { IntentRequest } from "./strategy.ts";

const HELP = `feast-league — run a Feast agent with your Binance Agentic Wallet

  plan <name> --preset <${PRESET_IDS.join("|")}> [--set key=value]… [--limit key=value]… [--tick s] [--sentence "…"]
  plan <name> --script <file.mjs> [--limit key=value]… [--tick s] [--sentence "…"]
                                  validate and save an agent, and print its confirmation card
  card <name>                     print the confirmation card again
  start <name> --yes [--detach]   the user said yes: confirm and start (real BNB, no practice mode)
  stop <name> | --all             write the stop file and wait for the agent to halt
  resume <name> [--all] [--detach] remove the stop file (--all: the global one too) and start again
  status <name> [--json] [--lang en|zh] [--no-league]
                                  the book, the limits, what is new since the last status, and the league
  set <name> [--set k=v]… [--limit k=v]… [--tick s] (--yes | --review)
                                  change a confirmed agent (--review may only tighten)
  review <name>                   the last hour, as JSON, for the optional hourly review
  audit <file.mjs> [--model-verdict pass|refuse --notes "…"]
                                  the script audit: static rules, then the model read's verdict
  buy <name> <coin|FEAST> <bnb>   one guarded buy, through the agent's limits
  sell <name> <coin|FEAST> <fraction|all>
  enter --name <id>.ai [--yes] [--lang en|zh] [--json]
                                  the league entry, once: launch the body coin and buy today's coin; never starts trading
                                  (--name is the wallet's Agent ID here; each card needs its own --yes)
  register <name> --check [--body-coin 0x…] [--lang en|zh]
                                  the league registration check: Agent ID, body coin, seat (reads only)
  register <name> --manifesto "…" [--body-coin 0x…] [--x handle] [--pending] [--lang en|zh] [--yes]
                                  the registration card; with --yes (the user's word): sign (no gas) and send to the league page
  launch <name> [--name "…"] [--symbol T] [--quote WBNB|<stock>] [--description "…"] [--lang en|zh] [--yes]
                                  the body coin's card; with --yes: one launch through the agent's limits
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
      check: { type: "boolean", default: false },
      manifesto: { type: "string" },
      "body-coin": { type: "string" },
      x: { type: "string" },
      pending: { type: "boolean", default: false },
      lang: { type: "string" },
      name: { type: "string" },
      symbol: { type: "string" },
      quote: { type: "string" },
      description: { type: "string" },
      "no-league": { type: "boolean", default: false },
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
  /** league-entry is FL enter's own agent: the season's commands never plan, start or change it. */
  const notEntry = (name: string) => {
    if (name === ENTRY_AGENT) throw new Error(`${ENTRY_AGENT} is FL enter's; plan your season agent under another name`);
    return name;
  };

  switch (command) {
    case "plan": {
      const name = notEntry(need(args[0], "an agent name"));
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
      const name = notEntry(need(args[0], "an agent name"));
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
        // league-entry's own stop file could not be cleared (resume refuses the name); the global one already halts it.
        if (values.all && name === ENTRY_AGENT) continue;
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
      const lang = langOf(values.lang);
      const unread = unreadNotifications(home, name, true);
      const league = values["no-league"] ? null : await leagueStanding(home, lang).catch(() => null);
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
        unread,
        league: league?.data ?? null,
      };
      print(json, data, () =>
        [
          `${name}: ${s.running ? "running" : "not running"}${s.stop ? ` (stop file: ${s.stop})` : ""}; ${s.agent!.track === "preset" ? `preset ${s.agent!.preset}` : s.agent!.track === "entry" ? "the league entry (FL enter)" : "script"}`,
          `positions: ${data.positions.length ? data.positions.map((p) => `${p.symbol} ${p.costBnb} BNB${p.armed ? "" : " (exit not armed)"}`).join(", ") : "none"}`,
          `spent in 24 h: ${data.spent24hBnb} BNB; the league in all: ${data.leagueSpentBnb} BNB of ${s.agent!.limits.budgetBnb}; realized ${data.realizedBnb} BNB; gas ${data.gasBnb} BNB`,
          ...(data.paused ? [`paused: ${data.paused}`] : []),
          ...(data.warmup ? [`warm-up: ${data.warmup.trades} of 5 trades`] : []),
          ...(unread.length > 0 ? ["new since the last status:", ...unreadShown(unread).map((n) => (typeof n === "string" ? n : noticeLine(n, lang)))] : ["latest:", ...s.notifications.slice(-8).map((n) => noticeLine(n, lang))]),
          ...(league ? ["", ...league.lines] : []),
        ].join("\n"),
      );
      return 0;
    }
    case "set": {
      const name = notEntry(need(args[0], "an agent name"));
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
    case "enter":
      return enterCommand(home, values, json);
    case "register":
      return registerCommand(home, checkAgentName(need(args[0], "an agent name")), values, json);
    case "launch":
      return launchCommand(home, checkAgentName(need(args[0], "an agent name")), values, json);
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

/** 280 characters, zh and en mixed, for the preview of the Register message. */
const PREVIEW_MANIFESTO = (() => {
  const text = [..."预览检查 preview-check 只咬刚出生的新币，小口快吃。 ".repeat(10).normalize("NFKC").replace(/\s+/gu, " ")].slice(0, 280).join("").trim();
  return normalizeManifesto(text).ok ? text : "preview-check";
})();

type Values = Record<string, string | boolean | string[] | undefined>;
const str = (v: unknown) => (typeof v === "string" ? v : undefined);

/** Every unread notice that matters is shown; of the trade lines, the last 20 and a count of the rest. Nothing is marked seen unshown. */
function unreadShown(unread: unknown[]): (unknown | string)[] {
  const routine = (n: unknown) => (n as { kind?: string }).kind === "trade" || (n as { kind?: string }).kind === "started";
  const kept = unread.filter((n) => !routine(n));
  const trades = unread.filter(routine);
  const dropped = Math.max(0, trades.length - 20);
  const shown = new Set([...kept, ...trades.slice(-20)]);
  return [...(dropped > 0 ? [`  (${dropped} older trade lines: feast-league status --json lists them)`] : []), ...unread.filter((n) => shown.has(n))];
}

/** One notification as the status card shows it; a session notice in the user's language. */
function noticeLine(n: unknown, lang: Lang): string {
  const entry = n as { at: string; kind: string; text: string; code?: SessionCode; endsAt?: string | null };
  const text = entry.kind === "session" && entry.code ? sessionNotice(entry.code, entry.endsAt ? Date.parse(entry.endsAt) : null, lang) : entry.text;
  return `  ${entry.at} ${entry.kind}: ${text}`;
}

/** The league block of `status` (PLAN-941 §6). Best effort: it never fails `status`. */
async function leagueStanding(home: string, lang: Lang): Promise<{ lines: string[]; data: Record<string, unknown> }> {
  const site = new LeagueSite(siteFromEnv(), fetch, 8_000);
  const me = await Promise.race([signerFor(home, null).address(), new Promise<null>((r) => setTimeout(() => r(null), 5_000))]).catch(() => null);
  const record = readLeagueRecord(home);
  let agentId = record?.agentId ?? null;
  let seating = record?.seating ?? null;
  const kept = me ? await site.kept(me) : null;
  if (kept?.state === "read" && kept.agent) {
    agentId = kept.agent.agentId ?? agentId;
    seating = seatingOfKept(kept.agent);
  }
  const today = await site.league("today", me);
  const season = today && (today.state === "season" || today.state === "over") ? await site.league("season", me) : null;
  const lines = standingLines({ agentId, seating, today, season, now: Date.now() }, lang);
  // The page's own rows, without the wallet's address: printed output keeps the home's rule.
  const own = today?.me ? { earners: today.me.earners ? { ...today.me.earners, wallet: undefined } : null, backed: today.me.backed ? { ...today.me.backed, wallet: undefined } : null, eaten: today.me.eaten } : (today?.me ?? null);
  return { lines, data: { state: today?.state ?? "unreadable", season: today?.season ?? null, agentId, seating, me: own } };
}

/** `feast-league enter` (task 961): the league entry, one card at a time; `src/league/enter/flow.ts` is the whole of it. */
async function enterCommand(home: string, values: Values, json: boolean): Promise<number> {
  const signer = signerFor(home, ENTRY_AGENT);
  const result = await enter(
    { home, signer, chain: new LeagueChain(MAINNET, rpc()), site: new LeagueSite(siteFromEnv()), oneShot: entryOneShot({ home, signer, rpcUrl: rpc() }) },
    { name: str(values.name), yes: values.yes === true, lang: langOf(values.lang) },
  );
  print(json, { ok: result.ok, stage: result.stage, ...result.data, card: result.text }, () => result.text);
  return result.code;
}

/** `feast-league register` (PLAN-941 §1): the check, the card, and after the user's yes the signature and the answer. */
async function registerCommand(home: string, name: string, values: Values, json: boolean): Promise<number> {
  const lang = langOf(values.lang);
  const signer = signerFor(home, name);
  const paths = agentPaths(home, name);
  const deps: FlowDeps = {
    home,
    name,
    signer,
    chain: new LeagueChain(MAINNET, rpc()),
    site: new LeagueSite(siteFromEnv()),
    log: (event, fields) => appendJsonl(paths.log, { at: new Date().toISOString(), event, ...fields }),
  };
  const say = (data: Record<string, unknown>, text: string, code: number) => (print(json, { ...data, card: text }, () => text), code);
  let found: Awaited<ReturnType<typeof check>>;
  try {
    found = await check(deps, { named: str(values["body-coin"]) ?? null });
  } catch (error) {
    const reason = error instanceof BawError ? error.message : (error as Error).message;
    return say({ ok: false, stage: "check", result: "wallet-unreadable", reason }, walletUnreadable(reason, lang), 2);
  }
  if (found.kind === "not-ready") return say({ ok: false, stage: "check", result: found.kind, reason: found.reason }, walletNotReady(found.reason, lang), 2);
  if (found.kind === "no-agent-id") return say({ ok: false, stage: "check", result: found.kind }, noAgentIdCard(lang), 2);
  if (found.kind === "agent-id-unreadable") return say({ ok: false, stage: "check", result: found.kind }, agentIdUnreadable(lang), 2);

  const summary = {
    agentId: found.agentId,
    bodyCoin: found.plan.kind === "coin" ? { coin: found.plan.coin, symbol: found.coin?.symbol ?? null, why: found.plan.why, others: found.plan.others } : null,
    plan: found.plan.kind,
    registration: found.keptUnreadable ? "unreadable" : found.keptSeating,
    league: found.league ? { state: found.league.state, season: found.league.season, seats: found.league.seats } : null,
    launch: { ...found.launch, quote: BODY_COIN_QUOTE },
  };
  const manifesto = str(values.manifesto);
  if (values.check || manifesto === undefined) return say({ ok: true, stage: "check", ...summary }, checkCard({ agentId: found.agentId, plan: found.plan, coin: found.coin, kept: found.kept, keptSeating: found.keptSeating, keptUnreadable: found.keptUnreadable, league: found.league, now: Date.now() }, lang), 0);

  const prepared = prepare(found, { manifesto, xHandle: str(values.x) ?? null, pending: values.pending === true }, Date.now());
  if (!prepared.ok) {
    const p = prepared.problem;
    const text = p.kind === "manifesto" ? manifestoProblem(p.reason, p.length, lang) : p.kind === "x-handle" ? xHandleProblem(p.given, lang) : bodyCoinProblem(p.plan, lang);
    return say({ ok: false, stage: "prepare", problem: p.kind, ...summary }, text, 2);
  }
  const card = registerCard(prepared.prepared.view, lang);
  const shown = { agentId: found.agentId, manifesto: prepared.prepared.fields.strategy, issuedAt: prepared.prepared.fields.issuedAt, bodyCoin: prepared.prepared.bodyCoin?.coin ?? null, xHandle: prepared.prepared.xHandle };
  if (!values.yes) return say({ ok: true, stage: "card", answer: { kind: "not-sent" }, ...shown }, `${card}\n\n${lang === "zh" ? "没有发送：需要用户说「好」（--yes）。" : "Not sent: this needs the user's yes (--yes)."}`, 2);

  const outcome = await submit(deps, prepared.prepared, { onPending: () => process.stderr.write(`${signingLine("pending", lang)}\n`) });
  if (outcome.kind === "not-signed") {
    const why = outcome.why;
    const text = why.kind === "declined" ? signingLine("declined", lang) : why.kind === "expired" ? signingLine("expired", lang) : why.kind === "not-ready" ? walletNotReady(why.reason, lang) : previewMismatch(why.reason, lang);
    return say({ ok: false, stage: "sign", answer: { kind: "not-sent", why: why.kind } }, text, 2);
  }
  if (outcome.kind === "local-check-failed") return say({ ok: false, stage: "sign", answer: { kind: "not-sent", why: "local-check" } }, signingLine("local-check", lang, outcome.reason), 2);
  if (outcome.kind === "too-old") return say({ ok: false, stage: "sign", answer: { kind: "not-sent", why: "too-old" } }, signingLine("expired", lang), 2);
  const answer = outcome.answer;
  if (answer.kind === "kept") {
    const season = answer.agent?.season ?? found.league?.season.number ?? 1;
    const lines = [seatedLine(answer.seating, found.agentId, season, lang), preregLine(answer.prereg, prepared.prepared.xHandle, found.agentId, lang), nextStepLine(found.league, Date.now(), lang)].filter((l): l is string => l !== null);
    if (outcome.reconciled) lines.unshift(noAnswerLine(true, lang));
    const seating = answer.seating;
    return say({ ok: true, stage: "answer", answer: { kind: seating.kind, ...(seating.kind === "seated" ? { seatNo: seating.seatNo, founding: seating.founding, foundingNo: seating.foundingNo, waitlisted: seating.waitlisted, place: seating.place } : { reason: seating.reason }), prereg: answer.prereg, reconciled: outcome.reconciled } }, lines.join("\n"), 0);
  }
  if (answer.kind === "refused") return say({ ok: false, stage: "answer", answer: { kind: "refused", status: answer.status, code: answer.code, field: answer.field } }, refusalLine(answer.code, answer.field, found.agentId, lang), 2);
  return say({ ok: false, stage: "answer", answer: { kind: "no-answer", reason: answer.reason, reconciled: outcome.reconciled } }, noAnswerLine(outcome.reconciled, lang), 2);
}

const QUOTES = ["WBNB", ...MAINNET.stocks.map((s) => s.symbol)];

/** `feast-league launch` (PLAN-941 §1.5): the body coin's card, and after the user's yes one launch through the agent's limits. */
async function launchCommand(home: string, name: string, values: Values, json: boolean): Promise<number> {
  const lang = langOf(values.lang);
  const say = (data: Record<string, unknown>, text: string, code: number) => (print(json, { ...data, card: text }, () => text), code);
  const agent = loadAgent(home, name);
  if (!agent?.confirmed) throw new Error(`no confirmed agent "${name}": the launch goes through its hard limits, so plan it and confirm it first`);
  if (agent.preset === "launch") return say({ ok: false, stage: "card" }, launchPresetOwnLine(lang), 2);
  const launched = statusOf(home, name).book?.launched;
  if (launched) return say({ ok: false, stage: "card", coin: launched.coin }, alreadyLaunchedLine(launched.coin, lang), 2);

  // The Agent ID names the coin and titles the card; best effort when a name and a ticker are given.
  let agentId: string | null = null;
  try {
    const id = await new LeagueChain(MAINNET, rpc()).agentIdOf(await signerFor(home, name).address());
    agentId = id.state === "read" ? id.id : null;
  } catch {
    agentId = null;
  }
  const derived = agentId ? bodyCoinNames(agentId) : null;
  const coinName = (str(values.name) ?? derived?.name ?? "").trim();
  const symbol = (str(values.symbol) ?? derived?.symbol ?? "").trim().toUpperCase();
  if (!coinName || !symbol) throw new Error("give the coin's --name and --symbol: this wallet's Agent ID could not be read to derive them");
  if (coinName.length > 32) throw new Error(`a coin's name is at most 32 characters (got ${coinName.length})`);
  if (!/^[A-Z0-9]{1,10}$/.test(symbol)) throw new Error("a ticker is 1–10 letters or digits");
  const quote = (str(values.quote) ?? BODY_COIN_QUOTE).trim().toUpperCase();
  if (!QUOTES.includes(quote)) throw new Error(`the pair is WBNB or a listed tokenized stock: ${QUOTES.join(", ")}`);
  const description = (str(values.description) ?? readLeagueRecord(home)?.manifesto ?? "").trim().slice(0, 280) || null;

  const card = launchCard({ agentId, name: coinName, symbol, quote, description }, lang);
  const shown = { name: coinName, symbol, quote, description, burn: BODY_COIN_SPLIT.burn, referrer: BODY_COIN_SPLIT.referrer };
  if (!values.yes) return say({ ok: true, stage: "card", ...shown }, `${card}\n\n${lang === "zh" ? "没有发币：需要用户说「好」（--yes）。" : "Not launched: this needs the user's yes (--yes)."}`, 2);

  const request: IntentRequest = { kind: "launch", name: coinName, symbol, quote, description: description ?? undefined, burn: BODY_COIN_SPLIT.burn, referrer: BODY_COIN_SPLIT.referrer, reason: "the league's body coin" };
  const early = refuseEarly(home, agent, request);
  if (early) {
    appendJsonl(agentPaths(home, name).log, { at: new Date().toISOString(), event: "intent.refused", source: "manual", limit: early.limit, message: early.message, before: "any wallet call" });
    return say({ ok: false, stage: "limits", refused: early }, launchFailedLine(`${early.limit}: ${early.message}`, lang), 2);
  }
  if (statusOf(home, name).running) {
    const paths = agentPaths(home, name);
    mkdirSync(paths.inbox, { recursive: true });
    writeJsonAtomic(join(paths.inbox, `${Date.now()}-launch.json`), { type: "intent", request });
    return say({ ok: true, stage: "queued", ...shown }, queuedLaunchLine(name, lang), 0);
  }
  const outcome = await runAgent({ home, name, signer: signerFor(home, name), rpcUrl: rpc(), only: [request] });
  const after = statusOf(home, name);
  if (after.book?.launched) return say({ ok: true, stage: "launched", coin: after.book.launched.coin, txHash: after.book.launched.txHash ?? null, ...shown }, launchedLine(symbol, after.book.launched.coin, after.book.launched.txHash ?? null, lang), 0);
  const failure = [...after.notifications].reverse().find((n) => (n as { kind: string }).kind === "failure") as { text?: string } | undefined;
  return say({ ok: false, stage: "launch", exit: outcome.exit, reason: outcome.reason }, launchFailedLine(`${outcome.exit}: ${failure?.text ?? outcome.reason}`, lang), 2);
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
    // The league's Register message as task 941 sends it (bare name, a 280-character zh/en manifesto, copies zero). Preview only: never signed here.
    const fields = { wallet, name: "previewcheck", strategy: PREVIEW_MANIFESTO, issuedAt: Math.floor(Date.now() / 1_000) };
    const answer = (await signer.signMessagePreview(signRequestMessage(fields))) as Record<string, unknown>;
    const data = (answer.data ?? {}) as Record<string, unknown>;
    const result = {
      accepted: answer.success === true && typeof data.requestId === "string",
      readsBack: previewDescribes(data.parsedMessage, fields).ok,
      manifestoLength: [...fields.strategy].length,
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
    const session = sessionView(settings);
    const left = session.end === null ? null : session.end - Date.now();
    checks.push({
      what: "session",
      ok: left === null || left > 0,
      detail: left === null ? "unknown" : left > 0 ? `ends in ${duration(left, "en")} (${session.source}), at ${utc8(session.end!)} UTC+8` : "ended: scan again (baw auth signin)",
    });
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
