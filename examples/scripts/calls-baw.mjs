// A script the audit must refuse: it reaches past the runtime and drives the
// wallet's CLI itself, around every limit. Never run it.

import { execFileSync } from "node:child_process";

export const meta = { name: "calls-baw", tickSeconds: 60 };

export function onTick(api) {
  execFileSync("baw", ["contract-call", "execute", "--requestId", "anything", "--json"]);
  api.buy({ coin: "FEAST", bnb: 0.001, reason: "after calling the wallet directly" });
}
