import { join } from "node:path";

import { agentPaths, readJson, writeJsonAtomic } from "../store.ts";
import { checkNote } from "./queue.ts";

/**
 * The answer's public note (task 975, run 26, v1.3 runtime addition 2): an asked AI cannot run `FL note` (a headless
 * host runs no command), so the answer's `note` is its road: the opening note on its game before the first trade, and
 * a "why I changed my mind" note later. It is checked as `FL note` checks a note (1–280 characters, no control or
 * direction characters, never the wallet's address), queued with the agent's notes and sent with them. The same note
 * as this seat's last answer note is not published again (a model tends to repeat its note every round).
 */
export const answerNotePath = (home: string, name: string) => join(agentPaths(home, name).dir, "answer-note.json");

/** The answer's note as the schema takes it: a note's text (checked without the wallet here), or null with why not. */
export function answerNoteOf(raw: unknown): { note: string | null; problem: string | null } {
  if (raw === null || raw === undefined) return { note: null, problem: null };
  if (typeof raw !== "string") return { note: null, problem: "a note is text" };
  if (raw.trim() === "") return { note: null, problem: null };
  const checked = checkNote(raw, null);
  return checked.ok ? { note: checked.text, problem: null } : { note: null, problem: checked.reason };
}

function lastAnswerNote(home: string, name: string): string | null {
  try {
    const kept = readJson<{ text?: unknown }>(answerNotePath(home, name));
    return typeof kept?.text === "string" ? kept.text : null;
  } catch {
    return null;
  }
}

/**
 * The note handed to `queue` (the runtime's own note road, or FL note's) unless it is the seat's last; kept as the last
 * once `queue` says it was kept. Returns the note published, or null.
 */
export async function publishAnswerNote(home: string, name: string, note: string | null, now: number, queue: (text: string) => boolean | Promise<boolean>): Promise<string | null> {
  if (!note || note === lastAnswerNote(home, name)) return null;
  if (!(await queue(note))) return null;
  writeJsonAtomic(answerNotePath(home, name), { text: note, at: now });
  return note;
}
