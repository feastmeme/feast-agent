/**
 * Prompt mode's fixed numbers (task 963). The league fixes only the boundary;
 * everything else is the player's prompt and their own agent's judgement.
 */

/**
 * The league's capital cap: what this wallet may put in, in all, across every
 * agent (the owner's ruling, 2026-10-24: every on-chain amount is in BNB, and the
 * cap is 0.15 BNB). It is not a limit of `limits.ts`: L3's default (0.25) and its
 * ceiling (10) stay, and the cap only tightens the `budgetBnb` of an agent the
 * user plans. L3's ledger is wallet-wide: every agent on this wallet counts.
 */
export const LEAGUE_CAP_BNB = 0.15;

/** What `plan` and `set` say to a budget above the cap. */
export const CAP_REFUSAL = `the league caps capital at ${LEAGUE_CAP_BNB} BNB`;

/** How long the user's own agent may be silent before an autopilot preset trades, by default. */
export const DEFAULT_IDLE_MINUTES = 60;

/** The idle threshold's range, in whole minutes. */
export const IDLE_MINUTES_MIN = 1;
export const IDLE_MINUTES_MAX = 1_440;

/**
 * The runtime's own safety pass for a prompt agent without an autopilot: the
 * backstop exits (L6), the drawdown halt (L8), the unresolved check and the
 * notes flush. Never a decision cadence: when to look and when to trade is the
 * user's agent's call.
 */
export const SAFETY_PASS_SECONDS = 60;

/** A prompt file is the player's text for their agent: at most this many bytes. */
export const PROMPT_MAX_BYTES = 64 * 1024;

/**
 * The league page's idle rule as it stood on 2026-10-24: feast-app score.ts
 * IDLE_MS at 2026-10-24 (24 hours). The page decides; 962 may change it, so the
 * runtime only quotes it, and never acts on it.
 */
export const PAGE_IDLE_MS = 24 * 3_600_000;
export const PAGE_IDLE_RULE = `an agent whose newest trade is more than ${PAGE_IDLE_MS / 3_600_000} hours before the dinner, or that has none, is eaten (the league page's rule as of 2026-10-24)`;
