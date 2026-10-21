import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { auditSource, sha256Of, type StaticAudit } from "./audit/static.ts";
import { DEFAULT_LIMITS, loosenedBeyond, resolveLimits, type Limits } from "./limits.ts";
import { PRESETS, resolveParams, type PresetId } from "./presets/specs.ts";
import { agentPaths, checkAgentName, readJson, writeJsonAtomic } from "./store.ts";

/**
 * An agent's definition, `agent.json` (PLAN.md §2.1): the track, the strategy
 * and its parameters, the limits, the tick, the sentence it came from, and the
 * envelope the user confirmed. Nothing starts without a confirmation; a later
 * change made on the hourly review may not loosen anything past the envelope.
 */

export type Confirmed = { at: string; limits: Limits; params: Record<string, unknown>; tickSeconds: number };

export type AgentConfig = {
  version: 1;
  name: string;
  track: "preset" | "script";
  preset: PresetId | null;
  script: { path: string; sha256: string } | null;
  params: Record<string, unknown>;
  /** Which parameters came from the user's sentence (the rest are defaults). */
  given: string[];
  limits: Limits;
  tickSeconds: number;
  sentence: string | null;
  createdAt: string;
  confirmed: Confirmed | null;
};

export type PlanInput = {
  name: string;
  preset?: string;
  scriptPath?: string;
  params?: Record<string, unknown>;
  limits?: Record<string, unknown>;
  tickSeconds?: number;
  sentence?: string;
};

const TICK_MIN = 15;
const TICK_MAX = 3_600;

export function planAgent(input: PlanInput, now = new Date()): { ok: true; agent: AgentConfig; audit: StaticAudit | null } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  try {
    checkAgentName(input.name);
  } catch (error) {
    errors.push((error as Error).message);
  }
  const limits = resolveLimits(input.limits ?? {});
  if (!limits.ok) return { ok: false, errors: [...errors, ...limits.errors] };
  if (Boolean(input.preset) === Boolean(input.scriptPath)) return { ok: false, errors: [...errors, "an agent runs one preset or one script"] };

  let preset: PresetId | null = null;
  let params: Record<string, unknown> = {};
  let script: AgentConfig["script"] = null;
  let audit: StaticAudit | null = null;
  let tick: number;
  if (input.preset) {
    if (!(input.preset in PRESETS)) return { ok: false, errors: [...errors, `unknown preset "${input.preset}"; the presets are ${Object.keys(PRESETS).join(", ")}`] };
    preset = input.preset as PresetId;
    const resolved = resolveParams(preset, input.params ?? {}, limits.limits);
    if (!resolved.ok) return { ok: false, errors: [...errors, ...resolved.errors] };
    params = resolved.params;
    tick = input.tickSeconds ?? PRESETS[preset].tickSeconds;
  } else {
    const path = resolve(input.scriptPath!);
    if (!existsSync(path)) return { ok: false, errors: [...errors, `no script at ${path}`] };
    const source = readFileSync(path, "utf8");
    audit = auditSource(source, { maxTradeBnb: limits.limits.maxTradeBnb });
    script = { path, sha256: sha256Of(source) };
    params = input.params ?? {};
    tick = input.tickSeconds ?? audit.tickSeconds ?? 60;
  }
  if (!Number.isInteger(tick) || tick < TICK_MIN || tick > TICK_MAX) errors.push(`the tick is ${TICK_MIN}–${TICK_MAX} s (got ${tick})`);
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    audit,
    agent: {
      version: 1,
      name: input.name,
      track: preset ? "preset" : "script",
      preset,
      script,
      params,
      given: Object.keys(input.params ?? {}),
      limits: limits.limits,
      tickSeconds: tick,
      sentence: input.sentence?.trim() || null,
      createdAt: now.toISOString(),
      confirmed: null,
    },
  };
}

/** The user said yes: what they saw becomes the envelope. */
export function confirmAgent(agent: AgentConfig, now = new Date()): AgentConfig {
  return { ...agent, confirmed: { at: now.toISOString(), limits: { ...agent.limits }, params: structuredClone(agent.params), tickSeconds: agent.tickSeconds } };
}

/**
 * A change to a running agent. Made by the user (`byReview` false) it is a new
 * confirmation; made on the hourly review it may tighten anything and retune
 * thresholds, but never raise a size, a stop-loss, a slippage or a limit past
 * what the user confirmed.
 */
export function applyChange(
  agent: AgentConfig,
  change: { params?: Record<string, unknown>; limits?: Record<string, unknown>; tickSeconds?: number },
  options: { byReview: boolean },
): { ok: true; agent: AgentConfig } | { ok: false; errors: string[] } {
  if (!agent.confirmed) return { ok: false, errors: ["the agent was never confirmed"] };
  const limits = resolveLimits({ ...agent.limits, ...(change.limits ?? {}) });
  if (!limits.ok) return { ok: false, errors: limits.errors };
  let params = { ...agent.params, ...(change.params ?? {}) };
  if (agent.preset) {
    const resolved = resolveParams(agent.preset, params, limits.limits);
    if (!resolved.ok) return { ok: false, errors: resolved.errors };
    params = resolved.params;
  }
  const tickSeconds = change.tickSeconds ?? agent.tickSeconds;
  if (!Number.isInteger(tickSeconds) || tickSeconds < TICK_MIN || tickSeconds > TICK_MAX) return { ok: false, errors: [`the tick is ${TICK_MIN}–${TICK_MAX} s`] };
  const next: AgentConfig = { ...agent, params, limits: limits.limits, tickSeconds };
  if (options.byReview) {
    const errors = loosenedBeyond(next.limits, agent.confirmed.limits);
    for (const [key, value] of Object.entries(next.params)) {
      const before = agent.confirmed.params[key];
      const raising = typeof value === "number" && typeof before === "number" && value > before;
      if (raising && (/Bnb$/.test(key) || /^(stopLossPct|slippagePct|maxPositions|snipesPerHour|maxBuysPerDay|proportionalPct)$/.test(key))) {
        errors.push(`${key} ${value} is above the ${before} you confirmed: only you can raise it`);
      }
    }
    if (errors.length > 0) return { ok: false, errors };
    return { ok: true, agent: next };
  }
  return { ok: true, agent: confirmAgent(next) };
}

export function loadAgent(home: string, name: string): AgentConfig | null {
  return readJson<AgentConfig>(agentPaths(home, name).agent);
}

export function saveAgent(home: string, agent: AgentConfig): void {
  writeJsonAtomic(agentPaths(home, agent.name).agent, agent);
}

export { DEFAULT_LIMITS };
