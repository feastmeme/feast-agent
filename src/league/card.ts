import type { AgentConfig } from "./agent.ts";
import { hostHow, hostShown } from "./ask/host.ts";
import type { StaticAudit } from "./audit/static.ts";
import { LIMIT_SPECS, WARMUP_SIZE_BNB, WARMUP_TRADES } from "./limits.ts";
import { PRESETS } from "./presets/specs.ts";
import { ACTIVITY_FLOOR_BNB, ACTIVITY_FLOOR_TRADES, LEAGUE_CAP_BNB, PAGE_IDLE_RULE } from "./prompt/constants.ts";
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

/** What `steady` spends, from its parameters: a floor day's buys and the most in a day; its open positions sit inside L3's cap. */
function steadySpend(params: Record<string, unknown>): string {
  const buy = Number(params.buyBnb);
  const entries = Number(params.maxEntriesPerDay);
  const typical = Math.min(entries, Math.ceil(Number(params.minDailyTrades) / 2)) * buy;
  const bnb = (x: number) => Number(x.toFixed(6));
  return `Its spend: about ${bnb(typical)} BNB of buys on a day it trades for the floor, at most ${bnb(entries * buy)} BNB (${entries} × ${buy} BNB), each sold again; what it holds counts toward the same ${LEAGUE_CAP_BNB} BNB cap on BNB at work as your agent's own buys.`;
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
    if (agent.manual) {
      // Run 21: no loop runs it, so nothing of the autopilot, the asks or the stop-loss watcher is said to run.
      lines.push(`Manual mode: no loop and no daemon run this agent. You drive it one command at a time (FL data ${agent.name}, FL buy ${agent.name} <coin> <bnb>, FL sell ${agent.name} <coin> <fraction>, FL note ${agent.name} "…"), each within the hard limits below. Nothing trades on its own: no autopilot, no floor keeper and no stop-loss watcher (the hard stop-loss L6 needs the loop). The day's floor (${ACTIVITY_FLOOR_TRADES} trades and ${ACTIVITY_FLOOR_BNB} BNB) is yours to make by hand. FL start ${agent.name} switches it to the loop on a machine that stays on.`);
    } else if (agent.preset && agent.autopilot) {
      const spec = PRESETS[agent.preset];
      // Task 975: the backup, on by default; ruling C6 (only a trade holds it back) and C7 (steady keeps its exits).
      const back = spec.keepsExits
        ? "Once your agent trades, it opens nothing new; the take-profit, stop-loss and time stop of the positions it opened stay armed (your agent may sell them sooner with FL sell)."
        : "It steps back as soon as your agent trades; positions it opened are then your agent's to manage.";
      if (agent.ask && agent.ask.with !== "none") {
        // Task 975, addendum 4: the runtime asks the player's own AI on a timer; the preset is the floor keeper underneath.
        // Run 19: the same names as the closing lines and FL status (the card said Codex for every other host).
        const host = hostShown(agent.ask.with);
        lines.push(`Ask loop: every ${agent.ask.every} min with no FL buy or FL sell from your agent, the runtime asks ${host} (${hostHow(agent.ask.with)}, ${agent.ask.model ? `model ${agent.ask.model}` : "its default model"}) what to do now, handing it your prompt, the market, the book, the league and its own journal; it makes the one buy, sell or hold the answer names, within the hard limits below. A note or a read does not hold it back. --every N changes how often (FL every ${agent.name} N later); --ask-with none stops the asks.`);
        lines.push(`Floor keeper: the ${agent.preset} preset (${spec.title}) trades only when ${host} cannot be reached twice in a row, and 20 minutes before dinner while the day's floor is unmet: it ${spec.does}. ${back} --no-autopilot turns off both the asks and the floor keeper.`);
      } else lines.push(`Autopilot backup: on. If your agent makes no FL buy or FL sell for ${agent.autopilot.idleMinutes} min, the ${agent.preset} preset (${spec.title}) trades until your agent trades again: it ${spec.does}. A note or a read does not hold it back. ${back} --no-autopilot turns it off.`);
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
    lines.push(`Audit: static rules ${audit?.verdict ?? "see FL audit"}; the model read must pass too before it starts.`);
    if (options.warmupPassed) lines.push(`Warm-up: passed by FL script check (sha ${short(agent.script!.sha256)}). It trades at its own sizes, within the limits; any edit is a new file, a new audit, a new check.`);
    else lines.push(`Warm-up: its first ${WARMUP_TRADES} trades run at ${WARMUP_SIZE_BNB} BNB; two failures in a row, or any limit hit, stop it and tell you.`);
  }
  if (agent.track !== "entry") lines.push(`League cap: at most ${l.maxAtWorkBnb} BNB at work in open positions at any time, wallet-wide (every agent on this wallet counts); a sale frees room; no limit on how often you trade.`);
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
    if (agent.manual) lines.push("Watching: nothing watches your positions in manual mode; each FL buy and FL sell checks the hard limits when you run it.");
    else lines.push("Watching: the runtime watches your positions for the hard stop-loss; when to look and when to trade is your agent's call.");
    if (agent.preset && !agent.manual) lines.push(`Autopilot cadence: only while it trades, a tick every ${agent.tickSeconds} s${events}${agent.preset && PRESETS[agent.preset].keepsExits ? "; while your agent trades, the same tick for its own exits only" : ""}.`);
  } else lines.push(`Cadence: a tick every ${agent.tickSeconds} s${events}.`);
  lines.push("Signing: your Binance Agentic Wallet, Developer Mode contract calls — preview, then execute — one transaction at a time.");
  lines.push(`Worst case: at most ${l.maxAtWorkBnb} BNB at work in open positions at any time; entries pause after ${l.maxDailyLossBnb} BNB of realized loss in 24 h, and the agent halts ${l.maxDrawdownBnb} BNB below its peak.`);
  lines.push("");
  lines.push(agent.manual ? "Every FL buy and FL sell you run trades real BNB from your wallet. There is no practice mode." : "This trades real BNB from your wallet as soon as you say yes. There is no practice mode.");
  lines.push(agent.manual ? `Nothing runs between your commands. To stop it for good: say "stop", or run \`FL stop ${agent.name}\` (a stop file refuses every FL buy and FL sell until FL resume ${agent.name}).` : `To stop: say "stop", or run \`FL stop ${agent.name}\` (or create the file STOP in the agent's folder).`);
  return lines.join("\n");
}
