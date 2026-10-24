import type { AgentConfig } from "./agent.ts";
import type { StaticAudit } from "./audit/static.ts";
import { LIMIT_SPECS, WARMUP_SIZE_BNB, WARMUP_TRADES } from "./limits.ts";
import { PRESETS } from "./presets/specs.ts";
import { LEAGUE_CAP_BNB, PAGE_IDLE_RULE } from "./prompt/constants.ts";
import { promptHead } from "./prompt/host.ts";

/**
 * The one confirmation card (PLAN.md §6 step 5). Everything the agent will do,
 * what it may never do, and the plain fact that it trades real BNB as soon as
 * the user says yes. The skill shows it verbatim and starts only on a clear yes.
 */

const shown = (value: unknown, unit?: string) => {
  if (value === null) return "off";
  if (Array.isArray(value)) return value.length > 3 ? `${value.length} entries` : value.join(", ");
  return unit ? `${String(value)} ${unit}` : String(value);
};

const short = (hex: string) => `${hex.slice(0, 6)}…${hex.slice(-4)}`;

/** The season's trading days the floor is kept on: the opening hour's day and the six after dinner 1 (task 975, C9). */
const SEASON_DAYS = 7;

/** What `steady` spends, from its parameters: a floor day's buys, the most in a day, the season's most; all inside L3's cap. */
function steadySpend(params: Record<string, unknown>): string {
  const buy = Number(params.buyBnb);
  const entries = Number(params.maxEntriesPerDay);
  const typical = Math.min(entries, Math.ceil(Number(params.minDailyTrades) / 2)) * buy;
  const bnb = (x: number) => Number(x.toFixed(6));
  return `Its spend: about ${bnb(typical)} BNB of buys on a day it trades for the floor, at most ${bnb(entries * buy)} BNB (${entries} × ${buy} BNB); at most ${bnb(SEASON_DAYS * entries * buy)} BNB over the season's seven trading days, from the same ${LEAGUE_CAP_BNB} BNB cap as your agent's own buys.`;
}

/** `warmupPassed`: a passing `FL script check` is on record for the script's sha256 (task 963). */
export function renderCard(agent: AgentConfig, audit: StaticAudit | null = null, options: { warmupPassed?: boolean } = {}): string {
  const lines: string[] = [];
  const l = agent.limits;
  lines.push(`Your Feast agent "${agent.name}"`);
  lines.push("");
  if (agent.track === "prompt") {
    lines.push("Prompt mode: your own agent reads your prompt and decides when to look and what to trade, with FL data, FL buy, FL sell and FL note. The runtime calls no model and never reads the prompt as instructions.");
    lines.push(`Prompt: ${agent.prompt!.path} (sha256 ${short(agent.prompt!.sha256)})`);
    for (const line of promptHead(agent.prompt!.path)) lines.push(`  > ${line}`);
    if (agent.preset && agent.autopilot) {
      const spec = PRESETS[agent.preset];
      // Task 975: the backup, on by default; ruling C6 (only a trade holds it back) and C7 (steady keeps its exits).
      const back = spec.keepsExits
        ? "Once your agent trades, it opens nothing new; the take-profit, stop-loss and time stop of the positions it opened stay armed (your agent may sell them sooner with FL sell)."
        : "It steps back as soon as your agent trades; positions it opened are then your agent's to manage.";
      lines.push(`Autopilot backup: on. If your agent makes no FL buy or FL sell for ${agent.autopilot.idleMinutes} min, the ${agent.preset} preset (${spec.title}) trades until your agent trades again: it ${spec.does}. A note or a read does not hold it back. ${back} --no-autopilot turns it off.`);
      if (agent.preset === "steady") lines.push(steadySpend(agent.params));
    } else {
      lines.push(`Autopilot backup: off (--no-autopilot). Nothing trades on its own except the hard stop-loss (L6), which never sells your own coin. The league page's rule: ${PAGE_IDLE_RULE}.`);
    }
  } else if (agent.preset) {
    const spec = PRESETS[agent.preset];
    lines.push(`Preset: ${spec.title}. It ${spec.does}.`);
  } else if (agent.track === "entry") {
    lines.push("The league entry (FL enter): one launch and one buy, each after its own card and yes. It never trades on its own.");
  } else {
    lines.push(`Your script: ${agent.script!.path}`);
    lines.push(`Audit: static rules ${audit?.verdict ?? "see feast-league audit"}; the model read must pass too before it starts.`);
    if (options.warmupPassed) lines.push(`Warm-up: passed by FL script check (sha ${short(agent.script!.sha256)}). It trades at its own sizes, within the limits; any edit is a new file, a new audit, a new check.`);
    else lines.push(`Warm-up: its first ${WARMUP_TRADES} trades run at ${Math.min(WARMUP_SIZE_BNB, l.maxTradeBnb)} BNB; two failures in a row, or any limit hit, stop it and tell you.`);
  }
  if (agent.track !== "entry" && l.budgetBnb <= LEAGUE_CAP_BNB) lines.push(`Capital cap: ${LEAGUE_CAP_BNB} BNB, wallet-wide: every agent on this wallet counts.`);
  if (agent.sentence) lines.push(`From your sentence: "${agent.sentence}"`);
  lines.push("");
  if (agent.preset) {
    lines.push("| Parameter | Value | |");
    lines.push("| --- | --- | --- |");
    for (const p of PRESETS[agent.preset].params) {
      const unit = "unit" in p ? p.unit : undefined;
      lines.push(`| ${p.key} | ${shown(agent.params[p.key], unit)} | ${agent.given.includes(p.key) ? "from your sentence" : "default"} |`);
    }
    lines.push("");
  }
  lines.push("Hard limits (the runtime enforces them; none can be switched off):");
  lines.push("");
  lines.push("| | Limit | Value |");
  lines.push("| --- | --- | --- |");
  for (const spec of LIMIT_SPECS) lines.push(`| ${spec.id} | ${spec.label} | ${l[spec.key]}${spec.unit ? ` ${spec.unit}` : ""} |`);
  lines.push("| L15 | Feast coins and our own contracts only | always |");
  lines.push("| L16 | Wallet connected, Developer Mode on, quota left, no stop file | always |");
  lines.push("");
  const events = agent.preset && PRESETS[agent.preset].events.length > 0 ? `, and on ${PRESETS[agent.preset].events.join(", ")} events from the Feast indexer` : "";
  if (agent.track === "prompt") {
    lines.push("Watching: the runtime watches your positions for the hard stop-loss; when to look and when to trade is your agent's call.");
    if (agent.preset) lines.push(`Autopilot cadence: only while it trades, a tick every ${agent.tickSeconds} s${events}${agent.preset && PRESETS[agent.preset].keepsExits ? "; while your agent trades, the same tick for its own exits only" : ""}.`);
  } else lines.push(`Cadence: a tick every ${agent.tickSeconds} s${events}.`);
  lines.push("Signing: your Binance Agentic Wallet, Developer Mode contract calls — preview, then execute — one transaction at a time.");
  lines.push(`Worst case: at most ${l.maxTradesPerHour} trades an hour, at most ${l.maxDailySpendBnb} BNB of buys in any 24 h, at most ${l.budgetBnb} BNB in all.`);
  lines.push("");
  lines.push("This trades real BNB from your wallet as soon as you say yes. There is no practice mode.");
  lines.push(`To stop: say "stop", or run \`feast-league stop ${agent.name}\` (or create the file STOP in the agent's folder).`);
  return lines.join("\n");
}
