import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { auditSource, sha256Of, type StaticAudit } from "./audit/static.ts";
import { DEFAULT_LIMITS, loosenedBeyond, resolveLimits, type Limits } from "./limits.ts";
import { PRESETS, resolveParams, type PresetId } from "./presets/specs.ts";
import { CAP_REFUSAL, DEFAULT_IDLE_MINUTES, IDLE_MINUTES_MAX, IDLE_MINUTES_MIN, LEAGUE_CAP_BNB, SAFETY_PASS_SECONDS } from "./prompt/constants.ts";
import { readPrompt } from "./prompt/host.ts";
import { ASK_EVERY_DEFAULT, ASK_EVERY_MAX, ASK_EVERY_MIN, ASK_WITH, type AskWith } from "./ask/host.ts";
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
  /**
   * `entry`: the league entry's own agent (task 961), no strategy at all; it runs only `FL enter`'s one-shot requests.
   * `prompt`: the user's own agent decides by the user's prompt (task 963); the runtime keeps the boundary, and with
   * an autopilot trades its preset only after the host has been silent.
   */
  track: "preset" | "script" | "entry" | "prompt";
  /** The preset; on the prompt track, the autopilot's preset, or null. */
  preset: PresetId | null;
  script: { path: string; sha256: string } | null;
  /** The prompt file the user confirmed (prompt track only). The runtime hashes it; it never reads it as instructions. */
  prompt?: { path: string; sha256: string } | null;
  /** The autopilot: the preset trades only after the host has been silent this long (prompt track only). */
  autopilot?: { idleMinutes: number } | null;
  /**
   * Task 975, addendum 4: the runtime asks the player's own AI what to do, every `every` minutes of the host's
   * silence, through its headless CLI (`with`; "none": nobody is asked and the preset keeps the floor as in v5). The
   * preset is then the floor keeper: it trades when the asks fail twice in a row, and 20 minutes before the dinner
   * with the day's floor unmet. Prompt track with an autopilot only; null or absent: no asks.
   */
  ask?: { every: number; with: AskWith; model: string | null } | null;
  params: Record<string, unknown>;
  /** Which parameters came from the user's sentence (the rest are defaults). */
  given: string[];
  limits: Limits;
  /**
   * A preset's or a script's tick. On the prompt track: the autopilot preset's own interval while it trades, or
   * without one the runtime's safety pass (SAFETY_PASS_SECONDS). Never the host's cadence: the host looks when it chooses.
   */
  tickSeconds: number;
  sentence: string | null;
  createdAt: string;
  confirmed: Confirmed | null;
  /**
   * Task 968: an agent `FL enter` started waits for the season: it trades nothing until feast.meme's season opens
   * (`season-gate.ts`), and `FL start` after a restart keeps waiting. Not part of the card: it never needs a new yes.
   */
  league?: { waitForSeason: boolean } | null;
};

export type PlanInput = {
  name: string;
  preset?: string;
  scriptPath?: string;
  /** Prompt mode: the user's strategy file; `preset` is then the autopilot. */
  promptPath?: string;
  /** Prompt mode with an autopilot: the host's silence, in minutes, before the preset trades. */
  idleMinutes?: number;
  /** Task 975, addendum 4: the ask loop (prompt mode with an autopilot only). */
  ask?: { every?: number; with?: string; model?: string | null } | null;
  params?: Record<string, unknown>;
  limits?: Record<string, unknown>;
  tickSeconds?: number;
  sentence?: string;
};

const TICK_MIN = 15;
const TICK_MAX = 3_600;

/**
 * The league's capital cap on a plan's limits (task 963): a budget the user gives above it is refused, and
 * none given is the cap. It only ever tightens L3, which `resolveLimits` allows.
 */
function capped(given: Record<string, unknown>): { ok: true; limits: Record<string, unknown> } | { ok: false } {
  if (!("budgetBnb" in given)) return { ok: true, limits: { ...given, budgetBnb: Math.min(DEFAULT_LIMITS.budgetBnb, LEAGUE_CAP_BNB) } };
  return aboveCap(given.budgetBnb) ? { ok: false } : { ok: true, limits: given };
}
const aboveCap = (raw: unknown) => {
  const value = typeof raw === "string" && /^\d+(\.\d+)?$/.test(raw.trim()) ? Number(raw.trim()) : raw;
  return typeof value === "number" && Number.isFinite(value) && value > LEAGUE_CAP_BNB;
};

export function planAgent(input: PlanInput, now = new Date()): { ok: true; agent: AgentConfig; audit: StaticAudit | null } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  try {
    checkAgentName(input.name);
  } catch (error) {
    errors.push((error as Error).message);
  }
  const cap = capped(input.limits ?? {});
  if (!cap.ok) return { ok: false, errors: [...errors, CAP_REFUSAL] };
  const limits = resolveLimits(cap.limits);
  if (!limits.ok) return { ok: false, errors: [...errors, ...limits.errors] };
  if (input.promptPath !== undefined) return planPrompt(input, limits.limits, errors, now);
  if (Boolean(input.preset) === Boolean(input.scriptPath)) return { ok: false, errors: [...errors, "an agent runs one preset or one script"] };
  if (input.idleMinutes !== undefined) return { ok: false, errors: [...errors, "--idle-minutes is for a prompt agent's autopilot"] };

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
      prompt: null,
      autopilot: null,
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

/** A prompt agent: the prompt's path and sha256, and at most one preset as its autopilot, never a script. */
function planPrompt(input: PlanInput, limits: Limits, errors: string[], now: Date): { ok: true; agent: AgentConfig; audit: null } | { ok: false; errors: string[] } {
  if (input.scriptPath) return { ok: false, errors: [...errors, "a prompt agent takes at most one preset, as its autopilot, and never a script"] };
  const prompt = readPrompt(input.promptPath!);
  if (!prompt.ok) return { ok: false, errors: [...errors, prompt.error] };
  let preset: PresetId | null = null;
  let params: Record<string, unknown> = {};
  let tick = SAFETY_PASS_SECONDS;
  let autopilot: AgentConfig["autopilot"] = null;
  let ask: AgentConfig["ask"] = null;
  if (input.preset) {
    if (!(input.preset in PRESETS)) return { ok: false, errors: [...errors, `unknown preset "${input.preset}"; the presets are ${Object.keys(PRESETS).join(", ")}`] };
    preset = input.preset as PresetId;
    const resolved = resolveParams(preset, input.params ?? {}, limits);
    if (!resolved.ok) return { ok: false, errors: [...errors, ...resolved.errors] };
    params = resolved.params;
    tick = input.tickSeconds ?? PRESETS[preset].tickSeconds;
    const idle = input.idleMinutes ?? DEFAULT_IDLE_MINUTES;
    if (!Number.isInteger(idle) || idle < IDLE_MINUTES_MIN || idle > IDLE_MINUTES_MAX) errors.push(`the idle threshold is ${IDLE_MINUTES_MIN}–${IDLE_MINUTES_MAX} whole minutes (got ${idle})`);
    autopilot = { idleMinutes: idle };
    if (input.ask) {
      const every = input.ask.every ?? ASK_EVERY_DEFAULT;
      const w = input.ask.with ?? "none";
      const model = input.ask.model ?? null;
      if (!Number.isInteger(every) || every < ASK_EVERY_MIN || every > ASK_EVERY_MAX) errors.push(`--every is ${ASK_EVERY_MIN}–${ASK_EVERY_MAX} whole minutes (got ${every})`);
      if (!(ASK_WITH as readonly string[]).includes(w)) errors.push(`--ask-with is one of ${ASK_WITH.join(", ")}`);
      // A model's name goes on the child's argv: a plain token, never a flag.
      if (model !== null && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(model)) errors.push("--ask-model is a model's name: letters, digits, dots, dashes, colons");
      ask = { every, with: w as AskWith, model };
    }
  } else {
    if (input.idleMinutes !== undefined) errors.push("--idle-minutes needs --autopilot <preset>: without one, nothing trades on its own");
    if (input.ask) errors.push("--every and --ask-with go with the autopilot: --no-autopilot means no asks and no floor keeper");
    if (input.tickSeconds !== undefined) errors.push("a prompt agent without an autopilot has no tick: your agent decides when to look");
    if (Object.keys(input.params ?? {}).length > 0) errors.push("a prompt agent without an autopilot has no parameters: the prompt is the strategy");
  }
  if (!Number.isInteger(tick) || tick < TICK_MIN || tick > TICK_MAX) errors.push(`the tick is ${TICK_MIN}–${TICK_MAX} s (got ${tick})`);
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    audit: null,
    agent: {
      version: 1,
      name: input.name,
      track: "prompt",
      preset,
      script: null,
      prompt: { path: prompt.path, sha256: prompt.sha256 },
      autopilot,
      ...(ask ? { ask } : {}),
      params,
      given: Object.keys(input.params ?? {}),
      limits,
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
  if (change.limits && "budgetBnb" in change.limits && aboveCap(change.limits.budgetBnb)) return { ok: false, errors: [CAP_REFUSAL] };
  if (agent.track === "prompt" && !agent.preset) {
    if (Object.keys(change.params ?? {}).length > 0) return { ok: false, errors: ["a prompt agent without an autopilot has no parameters: the prompt is the strategy"] };
    if (change.tickSeconds !== undefined) return { ok: false, errors: ["a prompt agent without an autopilot has no tick: your agent decides when to look"] };
  }
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
    if (tickSeconds < agent.confirmed.tickSeconds) errors.push(`a tick of ${tickSeconds} s is faster than the ${agent.confirmed.tickSeconds} s you confirmed`);
    if (agent.track === "script") {
      if (Object.keys(change.params ?? {}).length > 0) errors.push("a review may not change a script's parameters");
    } else errors.push(...reviewLoosens(next.params, agent.confirmed.params));
    if (errors.length > 0) return { ok: false, errors };
    return { ok: true, agent: next };
  }
  return { ok: true, agent: confirmAgent(next) };
}

/**
 * Which way each preset parameter loosens. A review may move a parameter only
 * the tighter way, or either way if it is neutral; anything not listed here
 * may not be changed by a review at all.
 */
const LOOSER: Record<string, "higher" | "lower" | "neutral"> = {
  // Sizes, counts, windows and tolerances: higher is looser.
  buyBnb: "higher",
  dipBuyBnb: "higher",
  openingBuyBnb: "higher",
  maxPositions: "higher",
  snipesPerHour: "higher",
  maxBuysPerDay: "higher",
  proportionalPct: "higher",
  maxCreatorLaunches24h: "higher",
  maxAgeSeconds: "higher",
  maxAgeHours: "higher",
  slippagePct: "higher",
  stopLossPct: "higher",
  trailingStopPct: "higher",
  timeStopMinutes: "higher",
  timeStopHours: "higher",
  maxChasePct: "higher",
  buybackPct: "higher",
  topN: "higher",
  // steady (task 975): its day's targets and its rush make it trade more; its spacing, less.
  minDailyTrades: "higher",
  minDailyVolumeBnb: "higher",
  maxEntriesPerDay: "higher",
  rushMinutes: "higher",
  // Entry thresholds and spacing: lower is looser.
  minVolumeBnb: "lower",
  minNewHolders: "lower",
  minPriceChangePct: "lower",
  minAgeMinutes: "lower",
  minLeaderBuyBnb: "lower",
  everyMinutes: "lower",
  buybackEveryMinutes: "lower",
  delaySeconds: "lower",
  dipPct: "lower",
  exhaustionRatio: "lower",
  minClaimBnb: "lower",
  spacingMinutes: "lower",
  // Shapes of a signal, not its strength.
  lookbackMinutes: "neutral",
  exhaustionWindowMinutes: "neutral",
  takeProfitPct: "neutral",
  takeProfitSellPct: "neutral",
};

function reviewLoosens(next: Record<string, unknown>, confirmed: Record<string, unknown>): string[] {
  const errors: string[] = [];
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  for (const [key, value] of Object.entries(next)) {
    const before = confirmed[key];
    if (same(value, before)) continue;
    const direction = LOOSER[key];
    if (typeof value === "number" && typeof before === "number" && direction) {
      if (direction === "higher" && value > before) errors.push(`${key} ${value} is above the ${before} you confirmed: only you can raise it`);
      if (direction === "lower" && value < before) errors.push(`${key} ${value} is below the ${before} you confirmed: only you can lower it`);
      continue;
    }
    if (key === "takeProfitPct" && (value === null || before === null)) continue;
    if (key === "wallets" && Array.isArray(value) && Array.isArray(before)) {
      const allowed = new Set(before.map((w) => String(w).toLowerCase()));
      if (value.every((w) => allowed.has(String(w).toLowerCase()))) continue;
      errors.push("a review may drop followed wallets, never add one");
      continue;
    }
    if (key === "quotes") {
      const narrowed = Array.isArray(value) && (before === "all" || (Array.isArray(before) && value.every((q) => (before as unknown[]).includes(q))));
      if (narrowed) continue;
      errors.push("a review may narrow the pairs, never widen them");
      continue;
    }
    if (key === "requireMetadata" && value === true) continue;
    errors.push(`a review may not change ${key}: only you can`);
  }
  return errors;
}

export function loadAgent(home: string, name: string): AgentConfig | null {
  return readJson<AgentConfig>(agentPaths(home, name).agent);
}

export function saveAgent(home: string, agent: AgentConfig): void {
  writeJsonAtomic(agentPaths(home, agent.name).agent, agent);
}

export { DEFAULT_LIMITS };
