/**
 * A public note for every trade the runtime makes (task 1020, the owner's ruling C for league-v5.1.4): the site shows
 * each trade with its reason even for an agent whose host never runs `FL note`. One line, "bought <coin> for <size>
 * BNB: <why>" or "sold …", the why being the player's AI's own one line (an answer's `why`, `--why` on FL buy, FL sell
 * and FL answer) or a fixed line of the runtime's; with no why, the line without its colon part. Never an address, a
 * transaction hash or the host: anything shaped like a hex address or hash is taken out of the coin and the why.
 */

/** A why, as the answer's schema and `--why` take it: plain text, at most this many characters. */
export const WHY_MAX = 140;

/** The floor keeper's line (the autopilot preset under a prompt agent). */
export const KEEPER_WHY = "keeper: meeting today's activity floor";
/** The hard stop-loss's (L6) line. */
export const STOP_LOSS_WHY = "the hard stop-loss (L6)";

/** Hex runs from four digits up, with a 6+4 shortening's tail: addresses, hashes and their short forms. */
const HEX = /0x[0-9a-f]{4,}(?:…[0-9a-f]{2,})?/gi;
/** Terminal escapes, control characters and the invisible or direction-changing ones. */
const ANSI = /\u001b\[[0-9;?]*[ -\/]*[@-~]/g;
const UNSEEN = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/gu;

/** One line of plain text, at most `max` characters (an ellipsis when cut). */
function clean(value: string, max: number): string {
  const flat = value.replace(ANSI, "").replace(UNSEEN, " ").replace(/\s+/gu, " ").trim();
  const chars = [...flat];
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : flat;
}

/** A why as the note carries it: cleaned to one line, hex runs taken out, at most WHY_MAX characters; null when nothing is left. */
export function cleanWhy(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const text = clean(raw.replace(HEX, ""), WHY_MAX);
  return text.length > 0 ? text : null;
}

const size = (bnb: number) => (Number.isFinite(bnb) && bnb > 0 ? String(Number(bnb.toFixed(6))) : "0");

export function tradeNoteText(trade: { side: "buy" | "sell"; symbol: string | null; bnb: number; why: string | null }): string {
  const coin = clean((trade.symbol ?? "").replace(HEX, ""), 24) || "a coin";
  const head = `${trade.side === "buy" ? "bought" : "sold"} ${coin} for ${size(trade.bnb)} BNB`;
  const why = cleanWhy(trade.why);
  return why ? `${head}: ${why}` : head;
}

/**
 * The why of a trade, by who asked for it: the player's AI or the host (`manual`: its own why, or none), the floor
 * keeper (a prompt agent's autopilot preset), a preset agent's preset, the hard stop-loss; a script says none.
 */
export function tradeWhy(intent: { source: string; why?: string | null; reason?: string }, agent: { track: string; preset: string | null }): string | null {
  if (intent.source === "manual") return cleanWhy(intent.why);
  if (intent.source === "preset") return agent.track === "prompt" ? KEEPER_WHY : agent.preset ? `the ${agent.preset} preset` : null;
  if (intent.source === "runtime") return /\bL6\b/.test(intent.reason ?? "") ? STOP_LOSS_WHY : null;
  return null;
}
