import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { agentPaths, appendJsonl, readJson, writeJsonAtomic } from "../store.ts";
import type { JournalRow } from "./pack.ts";

/**
 * The asks on disk (task 975, addendum 4): the decisions journal, one JSON line per ask in `agents/<name>/asks.jsonl`
 * (its time, the pack's digest, the answer and what became of it), and `ask-state.json` (the last ask, the failures
 * in a row, since when the floor keeper trades, and the AI's memo). Both live in the agent's home; neither holds a
 * wallet address, a key or a path. A restart reads them back, so a failure streak survives it.
 */

export type AskState = {
  lastAskAt: number | null;
  /** Failed asks in a row (a missing CLI, a non-zero exit, a timeout, an answer that is not one). */
  streak: number;
  /** When the floor keeper took over for the failures (the second in a row); null while the asks answer. */
  floorKeeperSince: number | null;
  /** The cause of the streak's first failure, in plain words. */
  cause: string | null;
  /** The AI's own working memory, rewritten by each valid answer. */
  memo: string | null;
  /** The strategy's sha256 the last ask saw, so the next pack can say whether it changed. */
  promptSha: string | null;
  last: { at: number; action: string; reason: string; result: string } | null;
};

export const emptyAskState = (): AskState => ({ lastAskAt: null, streak: 0, floorKeeperSince: null, cause: null, memo: null, promptSha: null, last: null });

const statePath = (home: string, name: string) => join(agentPaths(home, name).dir, "ask-state.json");
export const journalPath = (home: string, name: string) => join(agentPaths(home, name).dir, "asks.jsonl");

export function readAskState(home: string, name: string): AskState {
  try {
    return { ...emptyAskState(), ...(readJson<Partial<AskState>>(statePath(home, name)) ?? {}) };
  } catch {
    return emptyAskState();
  }
}

export const writeAskState = (home: string, name: string, state: AskState) => writeJsonAtomic(statePath(home, name), state);

export const appendJournal = (home: string, name: string, row: JournalRow) => appendJsonl(journalPath(home, name), row);

/** The last `count` rows, oldest first; torn lines skipped. */
export function readJournal(home: string, name: string, count = 12): JournalRow[] {
  const path = journalPath(home, name);
  if (!existsSync(path)) return [];
  const rows: JournalRow[] = [];
  for (const line of readFileSync(path, "utf8").split("\n").slice(-count - 1)) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line) as JournalRow);
    } catch {
      // A torn line is skipped.
    }
  }
  return rows.slice(-count);
}
