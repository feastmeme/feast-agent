import { join } from "node:path";

import { agentPaths, readJson, writeJsonAtomic } from "../store.ts";
import { holdLineDue, holdNoteText, type HoldLine } from "./trade.ts";

/**
 * Where a seat's last published hold line is kept (task 975, run 26): the running loop and `FL answer` read and write
 * the same file, so the 30-minute rule (`trade.ts` holdLineDue) holds across both and across a restart.
 */
export const holdLinePath = (home: string, name: string) => join(agentPaths(home, name).dir, "hold-line.json");

export function readHoldLine(home: string, name: string): HoldLine | null {
  try {
    const kept = readJson<Partial<HoldLine>>(holdLinePath(home, name));
    return kept && typeof kept.text === "string" && typeof kept.at === "number" && Number.isFinite(kept.at) ? { text: kept.text, at: kept.at } : null;
  } catch {
    return null;
  }
}

/**
 * A hold's line, when it is due: handed to `queue` as "held: <why>" (the runtime's own note road, or FL note's), and
 * kept as the seat's last only once `queue` says it was kept. Returns the line published, or null.
 */
export async function publishHoldLine(home: string, name: string, raw: unknown, now: number, queue: (text: string) => boolean | Promise<boolean>): Promise<string | null> {
  const why = holdLineDue(readHoldLine(home, name), raw, now);
  if (!why) return null;
  if (!(await queue(holdNoteText(why)))) return null;
  writeJsonAtomic(holdLinePath(home, name), { text: why, at: now } satisfies HoldLine);
  return why;
}
