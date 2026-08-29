#!/usr/bin/env node
import "dotenv/config";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { RelataApiClient } from "./relata-api-client.js";
import { createRelataMcpServer } from "./server.js";

const apiKey = process.env.RELATASQL_API_KEY?.trim() ?? "";
if (!apiKey) {
  console.error(
    "[relatasql-mcp] FATAL: RELATASQL_API_KEY is required for stdio mode. Set it in your environment or .env file.",
  );
  process.exit(1);
}

const apiBaseUrl =
  process.env.RELATASQL_API_URL?.trim() || "https://api.relatasql.com";

async function main(): Promise<void> {
  const apiClient = new RelataApiClient(apiBaseUrl, apiKey);
  const server = createRelataMcpServer(apiClient);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `[relatasql-mcp] ready. API base: ${apiBaseUrl}. Awaiting requests on stdio.`,
  );
}

main().catch((error) => {
  console.error("[relatasql-mcp] FATAL:", error);
  process.exit(1);
});
