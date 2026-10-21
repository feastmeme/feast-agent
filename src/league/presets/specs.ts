import { getAddress, isAddress } from "viem";

import { MAINNET } from "../../sdk/networks.ts";
import type { Limits } from "../limits.ts";

/**
 * The five presets' parameters (PLAN.md §4): every default and range, and the
 * hard limit a parameter is bounded by — a size by L1, a stop-loss by L6, a
 * slippage by L9, a position count by L5.
 */

export type PresetId = "sniper" | "momentum" | "copy" | "launch" | "dca";

type Bound = number | "L1" | "L5" | "L6" | "L9";

export type ParamSpec =
  | { key: string; kind: "number"; default: number; min: number; max: Bound; integer?: boolean; unit?: string; meaning: string }
  | { key: string; kind: "optional-number"; default: null; min: number; max: number; unit?: string; meaning: string }
  | { key: string; kind: "boolean"; default: boolean; meaning: string }
  | { key: string; kind: "enum"; default: string; options: readonly string[]; meaning: string }
  | { key: string; kind: "addresses"; default: null; min: number; max: number; meaning: string }
  | { key: string; kind: "text"; default: string | null; maxLength: number; pattern?: RegExp; meaning: string }
  | { key: string; kind: "quotes"; default: "all"; meaning: string };

export type PresetSpec = {
  id: PresetId;
  title: string;
  /** What it does, in one sentence: the card's first line. */
  does: string;
  tickSeconds: number;
  events: ("coin.created" | "trade" | "price.move")[];
  params: readonly ParamSpec[];
};

const QUOTE_SYMBOLS = ["WBNB", ...MAINNET.stocks.map((s) => s.symbol)] as const;

export const PRESETS: Record<PresetId, PresetSpec> = {
  sniper: {
    id: "sniper",
    title: "New-coin sniper",
    does: "buys a brand-new coin within seconds of its launch, in small size, and exits by a hard stop-loss, a take-profit or a time stop",
    tickSeconds: 15,
    events: ["coin.created", "trade"],
    params: [
      { key: "buyBnb", kind: "number", default: 0.005, min: 0.001, max: "L1", unit: "BNB", meaning: "size of each snipe" },
      { key: "maxAgeSeconds", kind: "number", default: 90, min: 10, max: 900, integer: true, unit: "s", meaning: "only coins launched less than this long ago" },
      { key: "quotes", kind: "quotes", default: "all", meaning: "which pairs to snipe: all, or a list such as WBNB,BNCB" },
      { key: "requireMetadata", kind: "boolean", default: true, meaning: "skip coins launched without metadata" },
      { key: "maxCreatorLaunches24h", kind: "number", default: 3, min: 1, max: 50, integer: true, meaning: "skip creators who launched more than this in 24 h" },
      { key: "snipesPerHour", kind: "number", default: 3, min: 1, max: 20, integer: true, meaning: "at most this many entries an hour" },
      { key: "slippagePct", kind: "number", default: 8, min: 1, max: "L9", unit: "%", meaning: "slippage bound" },
      { key: "stopLossPct", kind: "number", default: 25, min: 5, max: "L6", unit: "%", meaning: "hard stop: sell all this far below entry" },
      { key: "takeProfitPct", kind: "number", default: 100, min: 10, max: 1000, unit: "%", meaning: "take profit this far above entry" },
      { key: "takeProfitSellPct", kind: "number", default: 100, min: 10, max: 100, unit: "%", meaning: "share of the position sold at the take-profit" },
      { key: "timeStopMinutes", kind: "number", default: 30, min: 1, max: 1440, integer: true, unit: "min", meaning: "sell what is left after this long" },
    ],
  },
  momentum: {
    id: "momentum",
    title: "Momentum",
    does: "enters coins whose volume and holder count are growing, and exits when that is exhausted",
    tickSeconds: 60,
    events: ["trade", "price.move"],
    params: [
      { key: "lookbackMinutes", kind: "number", default: 15, min: 5, max: 240, integer: true, unit: "min", meaning: "the entry window" },
      { key: "minVolumeBnb", kind: "number", default: 0.5, min: 0.01, max: 100, unit: "BNB", meaning: "volume in the window" },
      { key: "minNewHolders", kind: "number", default: 10, min: 1, max: 1000, integer: true, meaning: "holder-count growth in the window" },
      { key: "minPriceChangePct", kind: "number", default: 10, min: 0, max: 500, unit: "%", meaning: "price rise in the window" },
      { key: "minAgeMinutes", kind: "number", default: 10, min: 0, max: 10080, integer: true, unit: "min", meaning: "skip a coin's first minutes" },
      { key: "maxAgeHours", kind: "number", default: 72, min: 1, max: 720, integer: true, unit: "h", meaning: "skip coins older than this" },
      { key: "buyBnb", kind: "number", default: 0.01, min: 0.001, max: "L1", unit: "BNB", meaning: "size of each entry" },
      { key: "maxPositions", kind: "number", default: 3, min: 1, max: "L5", integer: true, meaning: "momentum positions at once" },
      { key: "exhaustionWindowMinutes", kind: "number", default: 5, min: 1, max: 60, integer: true, unit: "min", meaning: "the exhaustion window" },
      { key: "exhaustionRatio", kind: "number", default: 0.3, min: 0.05, max: 1, meaning: "exit when the volume rate falls below this × the entry rate" },
      { key: "trailingStopPct", kind: "number", default: 15, min: 3, max: 50, unit: "%", meaning: "exit this far below the peak since entry" },
      { key: "stopLossPct", kind: "number", default: 20, min: 5, max: "L6", unit: "%", meaning: "stop-loss below entry" },
      { key: "timeStopHours", kind: "number", default: 24, min: 1, max: 168, integer: true, unit: "h", meaning: "exit after this long" },
      { key: "slippagePct", kind: "number", default: 3, min: 0.1, max: "L9", unit: "%", meaning: "slippage bound" },
    ],
  },
  copy: {
    id: "copy",
    title: "Copy the top agents",
    does: "follows the buys of the wallets you name, after a delay and at your size, and exits with them",
    tickSeconds: 15,
    events: ["trade"],
    params: [
      { key: "source", kind: "enum", default: "wallets", options: ["wallets", "leaderboard"], meaning: "whom to follow: a wallet list (the league leaderboard is not open yet)" },
      { key: "wallets", kind: "addresses", default: null, min: 1, max: 20, meaning: "the wallets to follow" },
      { key: "topN", kind: "number", default: 5, min: 1, max: 20, integer: true, meaning: "how many leaders to follow (leaderboard source)" },
      { key: "delaySeconds", kind: "number", default: 5, min: 0, max: 600, integer: true, unit: "s", meaning: "wait before copying" },
      { key: "sizeMode", kind: "enum", default: "fixed", options: ["fixed", "proportional"], meaning: "fixed size, or a share of the leader's" },
      { key: "buyBnb", kind: "number", default: 0.005, min: 0.001, max: "L1", unit: "BNB", meaning: "fixed size" },
      { key: "proportionalPct", kind: "number", default: 10, min: 1, max: 100, unit: "%", meaning: "share of the leader's size, capped by the per-trade limit" },
      { key: "minLeaderBuyBnb", kind: "number", default: 0.01, min: 0, max: 10, unit: "BNB", meaning: "ignore leader buys smaller than this" },
      { key: "maxChasePct", kind: "number", default: 10, min: 0, max: 100, unit: "%", meaning: "skip if the price rose more than this since the leader's fill" },
      { key: "copySells", kind: "boolean", default: true, meaning: "sell a copied coin when its leader sells it" },
      { key: "stopLossPct", kind: "number", default: 30, min: 5, max: "L6", unit: "%", meaning: "stop-loss below entry" },
      { key: "timeStopHours", kind: "number", default: 48, min: 1, max: 720, integer: true, unit: "h", meaning: "exit after this long" },
      { key: "slippagePct", kind: "number", default: 5, min: 0.1, max: "L9", unit: "%", meaning: "slippage bound" },
    ],
  },
  launch: {
    id: "launch",
    title: "Launch and run",
    does: "launches one coin themed by your prompt, holds an opening buy, and buys it back with the creator's fee share",
    tickSeconds: 300,
    events: [],
    params: [
      { key: "name", kind: "text", default: null, maxLength: 32, meaning: "the coin's name" },
      { key: "symbol", kind: "text", default: null, maxLength: 10, pattern: /^[A-Z0-9]{1,10}$/, meaning: "the ticker, 1–10 letters or digits" },
      { key: "description", kind: "text", default: "", maxLength: 280, meaning: "one line about the coin" },
      { key: "image", kind: "text", default: "generated", maxLength: 400, meaning: "a picture file, or generated" },
      { key: "quote", kind: "enum", default: "WBNB", options: QUOTE_SYMBOLS, meaning: "the pair" },
      { key: "burnPoints", kind: "number", default: 20, min: 0, max: 30, integer: true, meaning: "points of the 1% fee bought back and burned" },
      { key: "referrerPoints", kind: "number", default: 10, min: 0, max: 30, integer: true, meaning: "points of the 1% fee for referrers" },
      { key: "openingBuyBnb", kind: "number", default: 0.005, min: 0, max: "L1", unit: "BNB", meaning: "bought right after the launch, and held" },
      { key: "buybackEveryMinutes", kind: "number", default: 60, min: 15, max: 1440, integer: true, unit: "min", meaning: "how often to claim and buy back" },
      { key: "minClaimBnb", kind: "number", default: 0.0005, min: 0, max: 1, unit: "BNB", meaning: "skip smaller claims (gas)" },
      { key: "buybackPct", kind: "number", default: 100, min: 0, max: 100, unit: "%", meaning: "share of each claim spent on the buyback" },
    ],
  },
  dca: {
    id: "dca",
    title: "DCA / dip-buy blue chips",
    does: "buys FEAST (or the coins with the most holders) on a schedule, with an extra buy on a dip",
    tickSeconds: 3600,
    events: ["price.move"],
    params: [
      { key: "targets", kind: "enum", default: "FEAST", options: ["FEAST", "topHolders"], meaning: "what to buy" },
      { key: "topN", kind: "number", default: 3, min: 1, max: 10, integer: true, meaning: "how many of the most-held coins (topHolders)" },
      { key: "buyOnStart", kind: "boolean", default: true, meaning: "first buy as soon as it starts" },
      { key: "everyMinutes", kind: "number", default: 1440, min: 60, max: 10080, integer: true, unit: "min", meaning: "how often to buy" },
      { key: "buyBnb", kind: "number", default: 0.005, min: 0.001, max: "L1", unit: "BNB", meaning: "size of each scheduled buy" },
      { key: "dipPct", kind: "number", default: 15, min: 0, max: 80, unit: "%", meaning: "extra buy this far below the 24 h high (0: none)" },
      { key: "dipBuyBnb", kind: "number", default: 0.005, min: 0.001, max: "L1", unit: "BNB", meaning: "size of a dip buy" },
      { key: "maxBuysPerDay", kind: "number", default: 2, min: 1, max: 24, integer: true, meaning: "at most this many buys a day" },
      { key: "takeProfitPct", kind: "optional-number", default: null, min: 10, max: 1000, unit: "%", meaning: "sell all this far above entry (off by default: DCA holds)" },
      { key: "slippagePct", kind: "number", default: 1, min: 0.1, max: "L9", unit: "%", meaning: "slippage bound" },
    ],
  },
};

export const PRESET_IDS = Object.keys(PRESETS) as PresetId[];

function boundOf(bound: Bound, limits: Limits): number {
  if (typeof bound === "number") return bound;
  return { L1: limits.maxTradeBnb, L5: limits.maxOpenPositions, L6: limits.backstopStopLossPct, L9: limits.maxSlippagePct }[bound];
}

function parseNumber(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string" && /^-?\d+(\.\d+)?$/.test(raw.trim())) return Number(raw.trim());
  return null;
}

/** Defaults filled in, every value checked against its range and its limit. */
export function resolveParams(preset: PresetId, given: Record<string, unknown>, limits: Limits): { ok: true; params: Record<string, unknown> } | { ok: false; errors: string[] } {
  const spec = PRESETS[preset];
  if (!spec) return { ok: false, errors: [`unknown preset "${preset}"; the presets are ${PRESET_IDS.join(", ")}`] };
  const errors: string[] = [];
  const known = new Set(spec.params.map((p) => p.key));
  for (const key of Object.keys(given)) if (!known.has(key)) errors.push(`${preset} has no parameter "${key}"`);
  const params: Record<string, unknown> = {};
  for (const p of spec.params) {
    const has = Object.hasOwn(given, p.key) && given[p.key] !== undefined;
    const raw = has ? given[p.key] : p.default;
    switch (p.kind) {
      case "number": {
        const value = parseNumber(raw);
        const hi = boundOf(p.max, limits);
        if (value === null) errors.push(`${p.key} must be a number`);
        else if (p.integer && !Number.isInteger(value)) errors.push(`${p.key} must be a whole number`);
        else if (value < p.min || value > hi) errors.push(`${p.key} ${value} is outside ${p.min}–${hi}${typeof p.max === "string" ? ` (bounded by ${p.max})` : ""}`);
        else params[p.key] = value;
        break;
      }
      case "optional-number": {
        if (raw === null || raw === "off" || raw === undefined) {
          params[p.key] = null;
          break;
        }
        const value = parseNumber(raw);
        if (value === null || value < p.min || value > p.max) errors.push(`${p.key} must be off or within ${p.min}–${p.max}`);
        else params[p.key] = value;
        break;
      }
      case "boolean": {
        const value = raw === true || raw === "true" || raw === "yes" ? true : raw === false || raw === "false" || raw === "no" ? false : null;
        if (value === null) errors.push(`${p.key} must be true or false`);
        else params[p.key] = value;
        break;
      }
      case "enum": {
        const value = typeof raw === "string" ? raw.trim() : "";
        const match = p.options.find((o) => o.toLowerCase() === value.toLowerCase());
        if (!match) errors.push(`${p.key} must be one of ${p.options.join(", ")}`);
        else params[p.key] = match;
        break;
      }
      case "addresses": {
        const list = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(/[\s,]+/).filter(Boolean) : [];
        const bad = list.filter((a) => typeof a !== "string" || !isAddress(a, { strict: false }));
        if (raw === null || list.length === 0) errors.push(`${p.key}: name at least ${p.min} wallet to follow`);
        else if (bad.length > 0) errors.push(`${p.key}: not addresses: ${bad.length}`);
        else if (list.length > p.max) errors.push(`${p.key}: at most ${p.max} wallets`);
        else params[p.key] = [...new Set(list.map((a) => getAddress(a as string)))];
        break;
      }
      case "text": {
        const value = typeof raw === "string" ? raw.trim() : raw === null ? null : String(raw);
        if (value === null || value === "") {
          if (p.default === null) errors.push(`${p.key} is needed`);
          else params[p.key] = value ?? p.default;
        } else if (value.length > p.maxLength) errors.push(`${p.key} is at most ${p.maxLength} characters`);
        else if (p.pattern && !p.pattern.test(value)) errors.push(`${p.key} "${value}" does not fit ${p.meaning}`);
        else params[p.key] = value;
        break;
      }
      case "quotes": {
        const value = typeof raw === "string" ? raw.trim().toUpperCase() : "";
        if (value === "ALL") {
          params[p.key] = "all";
          break;
        }
        const list = value.split(/[\s,]+/).filter(Boolean);
        const bad = list.filter((q) => !(QUOTE_SYMBOLS as readonly string[]).includes(q));
        if (list.length === 0 || bad.length > 0) errors.push(`${p.key} must be all, or a list of ${QUOTE_SYMBOLS.join(", ")}`);
        else params[p.key] = list;
        break;
      }
    }
  }
  // Cross-checks the ranges cannot say.
  if (preset === "copy" && params.source === "leaderboard") {
    errors.push("source leaderboard: the league leaderboard is not open yet; follow a wallet list (source wallets)");
  }
  if (preset === "momentum" && typeof params.maxPositions === "number" && params.maxPositions > limits.maxOpenPositions) {
    errors.push(`maxPositions is bounded by L5 (${limits.maxOpenPositions})`);
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, params };
}
