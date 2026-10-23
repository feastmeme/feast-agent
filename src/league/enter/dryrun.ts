/**
 * The league entry's dry run (task 961): the real flow and the real cards,
 * wired to the test fakes. A made-up wallet with a made-up Agent ID, a fake
 * chain, feast.meme's routes stubbed in process (the league picture from a
 * fixture, or a 404), a throwaway home under the system's temp folder, and no
 * --yes. Nothing reaches a network; nothing is signed, launched or bought: the
 * one-shot here refuses to run.
 *
 *   npx tsx src/league/enter/dryrun.ts [--avatar served|404] [--lang en|zh]
 */
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { Address } from "viem";
import type { LocalAccount } from "viem/accounts";

import { BawSigner } from "../baw.ts";
import { langOf, short } from "../register/copy.ts";
import { fakeBaw } from "../register/fakes.ts";
import { LeagueSite } from "../register/site.ts";
import { FakeEnterSite, fakeEnterChain, INDEXER, SITE } from "./fakes.ts";
import { enter } from "./flow.ts";

const { values } = parseArgs({ options: { avatar: { type: "string", default: "served" }, lang: { type: "string", default: "en" } } });

// Made up: no one holds this wallet, and the Agent ID is not minted.
const WALLET: Address = "0x000000000000000000000000000000000000a11c";
const AGENT_ID = "demo";

const home = mkdtempSync(join(tmpdir(), "feast-league-enter-dryrun-"));
try {
  const { runner, calls } = fakeBaw({ account: { address: WALLET } as LocalAccount });
  const site = new FakeEnterSite({ wallet: WALLET, agentId: { agentId: AGENT_ID }, avatar: values.avatar === "404" ? { status: 404 } : { status: 200 }, creators: [] });
  const chain = fakeEnterChain({ agentId: AGENT_ID });
  const result = await enter(
    {
      home,
      signer: new BawSigner(runner),
      chain,
      site: new LeagueSite(SITE, site.fetch),
      indexer: INDEXER,
      fetch: site.fetch,
      oneShot: async () => {
        throw new Error("the dry run never sends: it stops at the first card");
      },
    },
    { name: `${AGENT_ID}.ai`, yes: false, lang: langOf(values.lang) },
  );
  const abbreviated = (text: string) => text.replace(/0x[0-9a-fA-F]{40}/g, (a) => short(a));
  console.log(`exit ${result.code}, stage ${result.stage}\n`);
  console.log(result.text);
  console.log("\n--- what was asked ---");
  console.log(`baw: ${calls.map((c) => `${c[0]} ${c[1]}`).join(", ")}`);
  console.log(`chain: ${chain.reads.map(abbreviated).join(", ")}`);
  console.log(`feast.meme and the indexer:\n${site.calls.map((c) => `  ${abbreviated(c)}`).join("\n")}`);
  console.log(`pins: ${site.pins.length}`);
  console.log(`files written under the throwaway home: ${readdirSync(join(home, "agents", "league-entry")).sort().join(", ")}`);
} finally {
  rmSync(home, { recursive: true, force: true });
}
