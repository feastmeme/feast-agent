import { getAddress } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";

import { contextFromEnv } from "../../agent/commands.ts";
import { SANDBOX } from "../../sdk/networks.ts";
import { LeagueChain } from "../chain.ts";
import { BODY_COIN_SPLIT, bodyCoinNames, bodyCoinPlan } from "./claims.ts";
import { FakeLeaguePage } from "./fakes.ts";
import { nextIssuedAt, registerTypedData } from "./message.ts";
import { LeagueSite } from "./site.ts";

/**
 * Registration against the public sandbox (docs/PLAN-941.md §10): a body coin
 * launched there by a key made in memory and funded by the faucet; its claim
 * checked against the sandbox factory, by the decision tree and by the fake
 * page; the Register message signed by that key and seated.
 *
 * What the sandbox cannot give: the Binance Agentic Wallet (no `baw` on chain
 * 56096) and the Agent ID registry (it has no code there), so the Agent ID is
 * the fake page's, and the key signs in the wallet's place. Skipped unless
 * FEAST_AGENT_SANDBOX=1.
 */
const live = process.env.FEAST_AGENT_SANDBOX === "1";

describe.skipIf(!live)("registration on the sandbox, live", () => {
  it(
    "launches a body coin, finds it on the sandbox chain, claims it, and is seated; another coin is refused",
    async () => {
      const key = generatePrivateKey();
      const account = privateKeyToAccount(key);
      const ctx = contextFromEnv({ ...process.env, FEAST_NETWORK: "sandbox", FEAST_AGENT_PRIVATE_KEY: key });
      await ctx.feast.faucet(account.address);
      const agentId = `sandbox${account.address.slice(2, 8).toLowerCase()}`;
      const names = bodyCoinNames(agentId);
      const launched = await ctx.feast.launch({ name: names.name, symbol: names.symbol, quote: "AAPLB", burn: BODY_COIN_SPLIT.burn, referrer: BODY_COIN_SPLIT.referrer });

      const chain = new LeagueChain(SANDBOX, SANDBOX.rpcUrl);
      expect((await chain.creatorOf(launched.coin))?.toString().toLowerCase()).toBe(account.address.toLowerCase());
      expect(await chain.agentIdOf(account.address)).toMatchObject({ state: "unreadable" });
      const plan = await bodyCoinPlan({ wallet: account.address, named: null, kept: null, bookLaunch: launched.coin, indexed: [], preset: "dca", creatorOf: (c) => chain.creatorOf(c) });
      expect(plan).toMatchObject({ kind: "coin", coin: getAddress(launched.coin), why: "book" });

      const page = new FakeLeaguePage({ agentIds: { [account.address.toLowerCase()]: agentId }, creatorOf: async (c) => chain.creatorOf(c) });
      const site = new LeagueSite(await page.start());
      try {
        const fields = { wallet: account.address, name: agentId, strategy: "A body coin from the sandbox.", issuedAt: nextIssuedAt(Date.now(), null) };
        const signature = await account.signTypedData(registerTypedData(fields));
        const body = { wallet: account.address.toLowerCase(), name: agentId, strategy: fields.strategy, copies: null, issuedAt: fields.issuedAt, scheme: "eip712" as const, signature };
        expect(await site.register({ ...body, bodyCoin: "0x00000000000000000000000000000000000c0c0a" })).toMatchObject({ kind: "refused", code: "body-coin-not-yours" });
        expect(await site.register({ ...body, bodyCoin: launched.coin.toLowerCase() })).toMatchObject({ kind: "kept", seating: { kind: "seated", seatNo: 1 } });
      } finally {
        await page.stop();
      }
    },
    240_000,
  );
});
