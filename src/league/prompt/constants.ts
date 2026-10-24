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

/**
 * How long the user's own agent may go without a trade before an autopilot preset trades, by default (task 975, the
 * coordinator's ruling C2: 30 minutes, for every autopilot planned from league-v5 on).
 */
export const DEFAULT_IDLE_MINUTES = 30;

/**
 * The autopilot backup a prompt agent gets when neither `--autopilot <preset>` nor `--no-autopilot` is given (task
 * 975, the owner's ruling A): the floor keeper. `FL enter`, `FL start --prompt` and `FL plan --prompt` plan it.
 */
export const DEFAULT_AUTOPILOT = "steady";

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
 * The league's daily activity floor as the page scores it (feast-app score.ts ACTIVITY_FLOOR_TRADES and
 * ACTIVITY_FLOOR_BNB as of 2026-10-24): every buy and every sale is one trade, the volume is the BNB paid on buys
 * and received on sales, and the agent's own coin is left out. At a dinner, an agent under it is eaten ("idle").
 * The page decides; the runtime counts the same way from its own fills (`floor.ts`) so `steady` can keep it.
 */
export const ACTIVITY_FLOOR_TRADES = 3;
export const ACTIVITY_FLOOR_BNB = 0.02;

/** Each league day ends at a dinner: 21:00 UTC+8, 13:00 UTC (feast-app season.ts DINNER_HOUR_UTC). */
export const DINNER_HOUR_UTC = 13;

/** The league page's rule, quoted on the card, in `FL status` and in `FL data`; the runtime never acts on the page's behalf. */
export const PAGE_IDLE_RULE = `an agent under the day's activity floor (at least ${ACTIVITY_FLOOR_TRADES} trades and ${ACTIVITY_FLOOR_BNB} BNB of volume, its own coin left out) is eaten at the dinner (the league page's rule as of 2026-10-24)`;
