import { confirmAgent, loadAgent, planAgent, saveAgent, type AgentConfig, type PlanInput } from "./agent.ts";
import { ASK_EVERY_DEFAULT, askWithFor } from "./ask/host.ts";
import type { HostDetail, Model } from "./headers.ts";
import { DEFAULT_AUTOPILOT } from "./prompt/constants.ts";
import { auditRefusal } from "./audit/verdict.ts";
import { renderCard } from "./card.ts";
import { migrateDefault, type Migration } from "./enter/migrate.ts";
import { promptChanged } from "./prompt/host.ts";
import { statusOf } from "./runtime.ts";
import { scriptCheckPassed } from "./script/check.ts";

/**
 * What `FL start` checks before an agent runs, as one function (task 968): `FL start` and `FL enter` both call it,
 * so there is one copy of the rules. A plan given (`--prompt`) is saved when there is no agent yet or its card
 * changed; an agent never confirmed needs the user's yes; a prompt changed since the yes, or a script whose audit
 * refuses, does not start.
 */

/**
 * A prompt agent's autopilot from the two flags (task 975), for `FL plan`, `FL start --prompt` and `FL enter` alike:
 * neither is the default backup (`steady`), `--autopilot <preset>` names another, `--no-autopilot` is none, and both
 * are refused. `planAgent` keeps no default of its own: a preset or a script agent never gets an autopilot.
 */
export function autopilotChoice(flags: { autopilot?: string; noAutopilot?: boolean }): { ok: true; preset: string | undefined } | { ok: false; error: string } {
  if (flags.autopilot !== undefined && flags.noAutopilot) return { ok: false, error: "choose --autopilot <preset> or --no-autopilot" };
  if (flags.noAutopilot) return { ok: true, preset: undefined };
  return { ok: true, preset: flags.autopilot ?? DEFAULT_AUTOPILOT };
}

/**
 * The ask loop from its flags (task 975, addendum 4): with the autopilot, every `--every` minutes (default 5) the
 * runtime asks the host the CLI names (`--ask-with`, default the host's hint: claude or codex, else none), with its
 * default model unless `--ask-model`. `--no-autopilot` means no asks and no floor keeper, so the flags are refused.
 */
export function askChoice(flags: { noAutopilot?: boolean; every?: number; askWith?: string; askModel?: string; askBaseUrl?: string; askKeyEnv?: string; host: Model; detail?: HostDetail | null }): { ok: true; ask: PlanInput["ask"] } | { ok: false; error: string } {
  const given = flags.every !== undefined || flags.askWith !== undefined || flags.askModel !== undefined || flags.askBaseUrl !== undefined || flags.askKeyEnv !== undefined;
  if (flags.noAutopilot) return given ? { ok: false, error: "--every and --ask-with go with the autopilot: --no-autopilot means no asks and no floor keeper" } : { ok: true, ask: null };
  // Addendum 11: an endpoint named (--ask-base-url) is the openai adapter; OpenCode's host without one is asked by nobody.
  const byDefault = askWithFor(flags.host, flags.detail ?? null);
  const w = flags.askWith ?? (flags.askBaseUrl !== undefined ? "openai" : byDefault === "openai" ? "none" : byDefault);
  return { ok: true, ask: { every: flags.every ?? ASK_EVERY_DEFAULT, with: w, model: flags.askModel ?? null, ...(flags.askBaseUrl !== undefined || flags.askKeyEnv !== undefined ? { baseUrl: flags.askBaseUrl ?? null, keyEnv: flags.askKeyEnv ?? null } : {}) } };
}

/** What makes a new card: the track, the prompt, the preset, the autopilot, the parameters, the limits, the tick. */
export const shapeOf = (a: AgentConfig) => JSON.stringify([a.track, a.prompt ?? null, a.preset, a.autopilot ?? null, a.ask ?? null, a.params, a.limits, a.tickSeconds]);

export type StartCheck =
  | { kind: "not-planned"; errors: string[] }
  | { kind: "no-agent" }
  /** Its card changed while it runs: stop it first. */
  | { kind: "running"; agent: AgentConfig }
  /** Never confirmed, and no yes given: the card, and nothing starts. */
  | { kind: "needs-yes"; agent: AgentConfig; card: string }
  | { kind: "refused"; why: string }
  /** `strategy` (run 26): what the start did with an unedited earlier default (`enter/migrate.ts`). */
  | { kind: "ready"; agent: AgentConfig; replanned: boolean; confirmedNow: boolean; strategy?: Migration };

export function prepareStart(
  home: string,
  name: string,
  options: {
    plan: PlanInput | null;
    yes: boolean;
    /** `run` starts only what was confirmed, and confirms nothing. */
    confirm: boolean;
    /** Task 968: set the season gate on the agent (never part of its card). */
    league?: AgentConfig["league"];
    /** Run 21: manual mode on (true) or off (false); undefined keeps what the agent has. Never part of its card's shape. */
    manual?: boolean;
    /** Task 1020: the default strategy's style `FL enter` copied; undefined keeps what the agent has. Never part of its card's shape. */
    persona?: AgentConfig["persona"];
    now?: Date;
  },
): StartCheck {
  let agent = loadAgent(home, name);
  // Run 26 (amendment C): an unedited earlier default moves to the current one, its card with it, before anything else
  // reads the file; never under a running loop. Its failure is the old file left as it was.
  let strategy: Migration = { kind: "none" };
  if (agent && !statusOf(home, name).running) {
    try {
      strategy = migrateDefault(home, agent, options.now);
      if (strategy.kind === "migrated") agent = strategy.agent;
    } catch {
      strategy = { kind: "none" };
    }
  }
  let replanned = false;
  if (options.plan) {
    const planned = planAgent(options.plan, options.now);
    if (!planned.ok) return { kind: "not-planned", errors: planned.errors };
    if (!agent || shapeOf(agent) !== shapeOf(planned.agent)) {
      if (agent && statusOf(home, name).running) return { kind: "running", agent };
      // The season gate stays with the agent through a new card: a restart before the start still waits.
      const league = options.league !== undefined ? options.league : agent?.league;
      const manual = options.manual !== undefined ? options.manual : (agent?.manual ?? undefined);
      // The default's style names the copied text: a new prompt (another file, or the copy edited) drops it.
      const samePrompt = agent?.prompt?.sha256 !== undefined && agent.prompt.sha256 === planned.agent.prompt?.sha256;
      const persona = options.persona !== undefined ? options.persona : samePrompt ? (agent?.persona ?? undefined) : undefined;
      agent = { ...planned.agent, ...(league !== undefined ? { league } : {}), ...(manual ? { manual: true } : {}), ...(persona ? { persona } : {}) };
      saveAgent(home, agent);
      replanned = true;
    }
  }
  if (!agent) return { kind: "no-agent" };
  if (options.league !== undefined && JSON.stringify(agent.league ?? null) !== JSON.stringify(options.league)) {
    agent = { ...agent, league: options.league };
    saveAgent(home, agent);
  }
  if (options.persona !== undefined && (agent.persona ?? null) !== options.persona) {
    const { persona: _was, ...rest } = agent;
    agent = options.persona ? { ...rest, persona: options.persona } : rest;
    saveAgent(home, agent);
  }
  if (options.manual !== undefined && (agent.manual === true) !== options.manual) {
    const { manual: _was, ...rest } = agent;
    agent = options.manual ? { ...rest, manual: true } : rest;
    saveAgent(home, agent);
  }
  let confirmedNow = false;
  if (options.confirm && !agent.confirmed) {
    if (!options.yes) return { kind: "needs-yes", agent, card: renderCard(agent, null, { warmupPassed: agent.track === "script" && scriptCheckPassed(home, agent.script!.sha256) }) };
    agent = confirmAgent(agent, options.now);
    saveAgent(home, agent);
    confirmedNow = true;
  }
  if (agent.track === "prompt" && promptChanged(agent)) return { kind: "refused", why: `the prompt changed since you confirmed it (or is gone): FL start ${name} --prompt ${agent.prompt?.path ?? "<file>"} shows the new card` };
  if (agent.track === "script") {
    const why = auditRefusal(home, agent.script!.path);
    if (why) return { kind: "refused", why };
  }
  return { kind: "ready", agent, replanned, confirmedNow, strategy };
}
