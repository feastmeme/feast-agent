/**
 * The league entry's fixed numbers (task 961). Each one is the app's: the
 * comment names where feast-app keeps it, so the two can be checked side by side.
 */

/** The agent `FL enter` keeps for itself: its book, its limits, its picture. `plan`, `start`, `resume`, `run` and `set` refuse the name. */
export const ENTRY_AGENT = "league-entry";

/** The league's body coin is the first coin a wallet launched at or after this (feast-app `plans/funnel/agent-seats/body-coins.cjs:18`, `BODY_SINCE`). */
export const BODY_SINCE = "2026-10-23T00:00:00Z";

/** The largest picture the pin route takes (feast-app `src/lib/ipfs/cid.ts:36`): a bigger league picture is not used. */
export const AVATAR_MAX_BYTES = 262_144;

/** A card the user said yes to is acted on for this long after it was printed. */
export const PENDING_MAX_AGE_MS = 10 * 60_000;
