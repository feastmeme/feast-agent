import { confirmAgent, loadAgent, planAgent, saveAgent, type AgentConfig, type PlanInput } from "./agent.ts";
import { DEFAULT_AUTOPILOT } from "./prompt/constants.ts";
import { auditRefusal } from "./audit/verdict.ts";
import { renderCard } from "./card.ts";
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

/** What makes a new card: the track, the prompt, the preset, the autopilot, the parameters, the limits, the tick. */
export const shapeOf = (a: AgentConfig) => JSON.stringify([a.track, a.prompt ?? null, a.preset, a.autopilot ?? null, a.params, a.limits, a.tickSeconds]);

export type StartCheck =
  | { kind: "not-planned"; errors: string[] }
  | { kind: "no-agent" }
  /** Its card changed while it runs: stop it first. */
  | { kind: "running"; agent: AgentConfig }
  /** Never confirmed, and no yes given: the card, and nothing starts. */
  | { kind: "needs-yes"; agent: AgentConfig; card: string }
  | { kind: "refused"; why: string }
  | { kind: "ready"; agent: AgentConfig; replanned: boolean; confirmedNow: boolean };

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
    now?: Date;
  },
): StartCheck {
  let agent = loadAgent(home, name);
  let replanned = false;
  if (options.plan) {
    const planned = planAgent(options.plan, options.now);
    if (!planned.ok) return { kind: "not-planned", errors: planned.errors };
    if (!agent || shapeOf(agent) !== shapeOf(planned.agent)) {
      if (agent && statusOf(home, name).running) return { kind: "running", agent };
      // The season gate stays with the agent through a new card: a restart before the start still waits.
      const league = options.league !== undefined ? options.league : agent?.league;
      agent = league !== undefined ? { ...planned.agent, league } : planned.agent;
      saveAgent(home, agent);
      replanned = true;
    }
  }
  if (!agent) return { kind: "no-agent" };
  if (options.league !== undefined && JSON.stringify(agent.league ?? null) !== JSON.stringify(options.league)) {
    agent = { ...agent, league: options.league };
    saveAgent(home, agent);
  }
  let confirmedNow = false;
  if (options.confirm && !agent.confirmed) {
    if (!options.yes) return { kind: "needs-yes", agent, card: renderCard(agent, null, { warmupPassed: agent.track === "script" && scriptCheckPassed(home, agent.script!.sha256) }) };
    agent = confirmAgent(agent, options.now);
    saveAgent(home, agent);
    confirmedNow = true;
  }
  if (agent.track === "prompt" && promptChanged(agent)) return { kind: "refused", why: `the prompt changed since you confirmed it (or is gone): feast-league start ${name} --prompt ${agent.prompt?.path ?? "<file>"} shows the new card` };
  if (agent.track === "script") {
    const why = auditRefusal(home, agent.script!.path);
    if (why) return { kind: "refused", why };
  }
  return { kind: "ready", agent, replanned, confirmedNow };
}
