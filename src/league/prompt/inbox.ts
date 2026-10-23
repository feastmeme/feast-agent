import { randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";

import { clean } from "../enter/copy.ts";
import { agentPaths, writeJsonAtomic } from "../store.ts";
import type { IntentRequest } from "../strategy.ts";

/**
 * A request from the CLI to a running agent, and its answer (task 963). `FL buy`
 * and `FL sell` into a running runtime used to print "queued" and nothing more;
 * now the request carries an id, the runtime logs what became of it under that
 * id (`request.outcome` in `log.jsonl`: filled with its transaction, refused with
 * the limit's own line, failed, or not known yet), and the command waits for it.
 */

export const WAIT_MS = 90_000;

export type RequestOutcome = { requestId: string; outcome: "filled" | "refused" | "failed" | "unknown" | "stale" | "nothing" | "dropped"; [k: string]: unknown };

/** Put a request in the running agent's inbox; its id, and where its log stood, to wait from. */
export function sendRequest(home: string, name: string, request: IntentRequest, now = Date.now()): { requestId: string; from: number } {
  const paths = agentPaths(home, name);
  mkdirSync(paths.inbox, { recursive: true });
  const requestId = randomUUID();
  const from = existsSync(paths.log) ? statSync(paths.log).size : 0;
  writeJsonAtomic(join(paths.inbox, `${now}-${request.kind}-${requestId.slice(0, 8)}.json`), { type: "intent", requestId, request });
  return { requestId, from };
}

/** Wait for the request's outcome line in the log, from where the log stood when it was sent; null at the timeout. */
export async function waitForOutcome(home: string, name: string, sent: { requestId: string; from: number }, options: { timeoutMs?: number; pollMs?: number } = {}): Promise<RequestOutcome | null> {
  const path = agentPaths(home, name).log;
  const until = Date.now() + (options.timeoutMs ?? WAIT_MS);
  let offset = sent.from;
  let rest = "";
  for (;;) {
    if (existsSync(path)) {
      const size = statSync(path).size;
      if (size > offset) {
        const fd = openSync(path, "r");
        const buffer = Buffer.alloc(size - offset);
        try {
          readSync(fd, buffer, 0, buffer.length, offset);
        } finally {
          closeSync(fd);
        }
        offset = size;
        const lines = (rest + buffer.toString("utf8")).split("\n");
        rest = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.includes(sent.requestId)) continue;
          try {
            const entry = JSON.parse(line) as { event?: string } & RequestOutcome;
            if (entry.event === "request.outcome" && entry.requestId === sent.requestId) return entry;
          } catch {
            // A torn line is read again whole on the next pass.
          }
        }
      }
    }
    if (Date.now() >= until) return null;
    await new Promise((r) => setTimeout(r, options.pollMs ?? 250));
  }
}

/** The outcome as one line, and the command's exit: 0 filled, 2 not done by a rule, 1 failed or not known. */
export function outcomeLine(outcome: RequestOutcome | null, name: string): { code: 0 | 1 | 2; text: string } {
  // The request may still run: a buy is good for 2 minutes in the queue, and a sent transaction's receipt is awaited for 2 more.
  if (!outcome) return { code: 1, text: `no outcome within ${WAIT_MS / 1_000} s: the request is still with the running agent and may yet fill. Do not send it again; feast-league status ${name} shows the trade when it lands` };
  const str = (v: unknown) => clean(typeof v === "string" ? v : v === null || v === undefined ? "" : String(v), 200);
  switch (outcome.outcome) {
    case "filled":
      return { code: 0, text: `filled: ${outcome.kind === "sell" ? "sold" : "bought"} ${str(outcome.symbol) || "the coin"} for ${String(outcome.bnb)} BNB, transaction ${str(outcome.txHash)}` };
    case "refused":
      return { code: 2, text: outcome.limit ? `refused by ${str(outcome.limit)}: ${str(outcome.message)}` : `refused: ${str(outcome.message)}` };
    case "failed":
      return { code: 1, text: `failed at ${str(outcome.stage)}: ${str(outcome.reason)}` };
    case "unknown":
      return { code: 1, text: `sent, and its outcome is not known yet (${str(outcome.txHash) || "no hash"}): the runtime keeps checking; feast-league status ${name}` };
    case "stale":
      return { code: 2, text: "dropped: the request went stale before its turn" };
    case "nothing":
      return { code: 2, text: "nothing to sell: the agent holds none of that coin" };
    default:
      return { code: 2, text: `dropped: ${str(outcome.reason) || "the runtime did not act on it"}` };
  }
}
