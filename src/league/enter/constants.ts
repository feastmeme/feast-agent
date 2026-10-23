/**
 * The league entry's fixed numbers (task 961). Each one is the app's: the
 * comment names where feast-app keeps it, so the two can be checked side by side.
 */

/** The agent `FL enter` keeps for itself: its book, its limits, its picture. `plan`, `start`, `resume`, `run` and `set` refuse the name. */
export const ENTRY_AGENT = "league-entry";

/** The league's body coin is the first coin a wallet launched at or after this (feast-app `plans/funnel/agent-seats/body-coins.cjs:18`, `BODY_SINCE`). */
export const BODY_SINCE = "2026-10-23T00:00:00Z";

/** Step 1 opens: only a buy of today's coin at or after this counts (feast-app task 960, `STEP1_OPEN`; its §4). */
export const STEP1_OPEN = "2026-10-24T12:00:00Z";

/** The entry buy is worth at least this many USDT when it is bought (feast-app `README.md:146`). */
export const ENTRY_USDT = 5;

/** The buy is sized this much above ENTRY_USDT, so a small move of the BNB price between the card and the buy still leaves it worth 5 USDT. */
export const BUFFER = 1.02;

/** The largest picture the pin route takes (feast-app `src/lib/ipfs/cid.ts:36`): a bigger league picture is not used. */
export const AVATAR_MAX_BYTES = 262_144;

/** A card the user said yes to is acted on for this long after it was printed. */
export const PENDING_MAX_AGE_MS = 10 * 60_000;
