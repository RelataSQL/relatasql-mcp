#!/usr/bin/env node
import "dotenv/config";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { RelataApiClient, RelataApiError } from "./relata-api-client.js";

// ---------- Startup validation ----------
// The API key is mandatory. Crashing immediately (rather than
// failing on the first tool call) gives the operator a clear
// signal while the process is still attached to their terminal.
const apiKey = process.env.RELATASQL_API_KEY;
if (!apiKey || apiKey.trim().length === 0) {
  console.error(
    "[relatasql-mcp] FATAL: RELATASQL_API_KEY is required. Set it in your environment or .env file.",
  );
  process.exit(1);
}

const apiBaseUrl =
  process.env.RELATASQL_API_URL?.trim() || "http://localhost:3000";

const apiClient = new RelataApiClient(apiBaseUrl, apiKey);

// ---------- Zod schemas for tool inputs ----------
// Kept as plain ZodObjects so we can derive both the JSON Schema
// shipped to the client (via zodToJsonSchemaLike below) and the
// runtime-parsed payloads in the CallTool handler from a single
// source of truth.
const GetSchemaInput = z.object({
  connectionId: z
    .string()
    .min(1, "connectionId is required")
    .describe(
      "The id of the RelataSQL connection to inspect. Obtain this from list_connections first.",
    ),
});

const ExecuteQueryInput = z.object({
  connectionId: z
    .string()
    .min(1, "connectionId is required")
    .describe(
      "The id of the RelataSQL connection to query. Obtain this from list_connections first.",
    ),
  sql: z
    .string()
    .min(1, "sql is required")
    .describe(
      "A raw SQL query to execute against the connection. Use dialect-appropriate syntax for the engine reported by get_schema.",
    ),
});

// MCP tool definitions ship JSON Schema, not Zod. We write them
// inline here (rather than pulling in zod-to-json-schema) so the
// dependency surface stays: sdk + zod + dotenv. That's it.
const TOOL_DEFINITIONS = [
  {
    name: "list_connections",
    description:
      "Retrieves all available database connections for the authenticated user. Call this first to get the connectionId. Each connection includes id, name, engine (postgres/mysql/mssql), host, port, databaseName and workspaceId. The connectionId returned here is required as input for every other tool in this server.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "get_schema",
    description:
      "Retrieves the database schema (tables, columns, types, primary keys) for a specific connectionId. Essential for writing accurate SQL queries — always call this before execute_query if you don't already know the table structure. Returns a list of tables, each with its columns, dataType, isNullable and isPrimaryKey flags.",
    inputSchema: {
      type: "object",
      properties: {
        connectionId: {
          type: "string",
          description:
            "The id of the RelataSQL connection to inspect. Obtain this from list_connections first.",
        },
      },
      required: ["connectionId"],
      additionalProperties: false,
    },
  },
  {
    name: "execute_query",
    description:
      "Executes a raw SQL query against the specified connectionId and returns the result rows. Use dialect-appropriate syntax for the engine reported by get_schema (postgres, mysql, mssql). Returns an object with columns (array of column names), rows (array of row arrays) and rowCount. Prefer parametrized, read-only queries unless the user explicitly asks for a mutation.",
    inputSchema: {
      type: "object",
      properties: {
        connectionId: {
          type: "string",
          description:
            "The id of the RelataSQL connection to query. Obtain this from list_connections first.",
        },
        sql: {
          type: "string",
          description:
            "A raw SQL query to execute against the connection. Use dialect-appropriate syntax for the engine reported by get_schema.",
        },
      },
      required: ["connectionId", "sql"],
      additionalProperties: false,
    },
  },
] as const;

// ---------- Server wiring ----------
const server = new Server(
  {
    name: "relatasql-mcp",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: TOOL_DEFINITIONS };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: rawArgs } = request.params;

  // Graceful degradation: every failure path inside the handler
  // comes back as a tool result with isError: true so the LLM
  // client can read the message, correct itself, and retry. We
  // never throw out of this handler — an uncaught throw would
  // surface as a protocol error the model can't inspect.
  try {
    switch (name) {
      case "list_connections": {
        const connections = await apiClient.listConnections();
        return toolJson(connections);
      }
      case "get_schema": {
        const { connectionId } = GetSchemaInput.parse(rawArgs ?? {});
        const schema = await apiClient.getSchema(connectionId);
        return toolJson(schema);
      }
      case "execute_query": {
        const { connectionId, sql } = ExecuteQueryInput.parse(rawArgs ?? {});
        const result = await apiClient.executeQuery(connectionId, sql);
        return toolJson(result);
      }
      default:
        return toolError(`Unknown tool: ${name}`);
    }
  } catch (err) {
    return toolError(describeError(err));
  }
});

// ---------- Error / response helpers ----------
function toolJson(payload: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
}

function toolError(message: string) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ error: message }, null, 2),
      },
    ],
    isError: true,
  };
}

function describeError(err: unknown): string {
  if (err instanceof z.ZodError) {
    return `Invalid arguments: ${err.issues
      .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
      .join("; ")}`;
  }
  if (err instanceof RelataApiError) {
    return `RelataSQL API error (${err.status}): ${err.message}`;
  }
  if (err instanceof Error) {
    return err.message;
  }
  return "Unknown error";
}

// ---------- Transport ----------
async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Stdout is reserved for the MCP wire protocol — any logging
  // that goes to stdout corrupts the JSON-RPC stream. Always log
  // to stderr.
  console.error(
    `[relatasql-mcp] ready. API base: ${apiBaseUrl}. Awaiting requests on stdio.`,
  );
}

main().catch((err) => {
  console.error("[relatasql-mcp] FATAL:", err);
  process.exit(1);
});
