import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";

import { contextFromEnv } from "./commands.ts";
import { buildServer } from "./mcp.ts";

async function connected() {
  const server = buildServer(contextFromEnv({ FEAST_NETWORK: "sandbox" }));
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientSide);
  return client;
}

describe("MCP server", () => {
  it("exposes the agent's verbs as tools", async () => {
    const client = await connected();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      ["feast_buy", "feast_launch", "feast_payouts", "feast_quote", "feast_quotes", "feast_sell", "feast_split", "feast_wallet"].sort(),
    );
    const launch = tools.find((t) => t.name === "feast_launch");
    expect(Object.keys((launch?.inputSchema as { properties: object }).properties)).toEqual(
      expect.arrayContaining(["name", "symbol", "quote", "burn", "referrer", "dryRun"]),
    );
  });
  it("answers a refusal as a tool error, not a crash", async () => {
    const client = await connected();
    const result = await client.callTool({ name: "feast_quote", arguments: { target: "NOPE" } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/unknown quote/);
  });
  it("refuses a malformed address before anything runs", async () => {
    const client = await connected();
    const result = await client.callTool({ name: "feast_split", arguments: { coin: "0x123" } });
    expect(result.isError).toBe(true);
  });
  it("refuses wallet reads without a key", async () => {
    const client = await connected();
    const result = await client.callTool({ name: "feast_wallet", arguments: {} });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/FEAST_AGENT_PRIVATE_KEY/);
  });
});
