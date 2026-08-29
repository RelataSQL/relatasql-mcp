import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { RelataApiClient, RelataApiError } from "./relata-api-client.js";
import {
  parseDatabaseCapabilities,
  withCapabilityDescriptions,
  type DatabaseCapabilitiesCatalog,
} from "./database-capabilities.js";

export const RELATASQL_MCP_VERSION = "1.2.0";
const CAPABILITIES_TTL_MS = 5 * 60 * 1000;

const GetSchemaInput = z.object({
  connectionId: z.string().min(1, "connectionId is required"),
});
const GetRelationsInput = GetSchemaInput;
const ExecuteQueryInput = z.object({
  connectionId: z.string().min(1, "connectionId is required"),
  sql: z.string().min(1, "sql is required"),
});
const RunTransactionSandboxInput = z.object({
  connectionId: z.string().min(1, "connectionId is required"),
  sql: z.string().min(1, "sql is required"),
  justification: z.string().min(1, "justification is required"),
});
const SampleRowsInput = z.object({
  connectionId: z.string().min(1, "connectionId is required"),
  schema: z.string().optional(),
  table: z.string().min(1, "table is required"),
  limit: z.number().int().min(1).max(50).optional(),
});
const RequestWriteOperationInput = z.object({
  connectionId: z.string().min(1, "connectionId is required"),
  sql: z.string().min(1, "sql is required"),
  justification: z.string().min(1, "justification is required"),
  operationSummary: z.string().optional(),
});
const CheckWriteApprovalInput = z.object({
  approvalId: z.string().min(1, "approvalId is required"),
});
const SubmitFeedbackInput = z.object({
  objective: z.string().min(1, "objective is required"),
  relataContribution: z.string().min(1, "relataContribution is required"),
  missingFeatures: z.string().min(1, "missingFeatures is required"),
});

export const TOOL_DEFINITIONS = [
  {
    name: "list_connections",
    description:
      "Retrieves all database connections visible to the authenticated RelataSQL user. Call this first to obtain a connectionId. Each connection reports engine, per-connection MCP/JIT access state, and supported MCP operations. If access is INACTIVE or EXPIRED, ask the user to enable it in RelataSQL Settings > MCP before touching that connection.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "get_schema",
    description:
      "Retrieves tables, columns, types, nullability and primary keys for a connection. Requires active per-connection MCP/JIT access. Use it before writing SQL when the structure is not already known.",
    inputSchema: {
      type: "object",
      properties: {
        connectionId: {
          type: "string",
          description: "Connection id returned by list_connections.",
        },
      },
      required: ["connectionId"],
      additionalProperties: false,
    },
  },
  {
    name: "get_relations",
    description:
      "Retrieves foreign-key relationships for a connection. Requires active per-connection MCP/JIT access. Use after get_schema when joins or dependency analysis need table relationships.",
    inputSchema: {
      type: "object",
      properties: {
        connectionId: {
          type: "string",
          description: "Connection id returned by list_connections.",
        },
      },
      required: ["connectionId"],
      additionalProperties: false,
    },
  },
  {
    name: "sample_rows",
    description:
      "Returns a small, backend-capped sample from one table. Read-only and subject to active per-connection MCP/JIT access. Useful for understanding real data shape before querying.",
    inputSchema: {
      type: "object",
      properties: {
        connectionId: {
          type: "string",
          description: "Connection id returned by list_connections.",
        },
        schema: {
          type: "string",
          description:
            "Optional schema name. Defaults according to the selected database engine.",
        },
        table: { type: "string", description: "Table name to sample." },
        limit: {
          type: "number",
          description: "Maximum rows to return. Defaults to 10, max 50.",
        },
      },
      required: ["connectionId", "table"],
      additionalProperties: false,
    },
  },
  {
    name: "execute_query",
    description:
      "Executes SQL that RelataSQL proves read-only for the selected PostgreSQL, MySQL or SQL Server connection. Classification happens before opening the database socket and reads use the strongest read-only transaction available. For mutations use request_write_operation instead.",
    inputSchema: {
      type: "object",
      properties: {
        connectionId: {
          type: "string",
          description: "Connection id returned by list_connections.",
        },
        sql: {
          type: "string",
          description: "Dialect-appropriate read-only SQL for the selected engine.",
        },
      },
      required: ["connectionId", "sql"],
      additionalProperties: false,
    },
  },
  {
    name: "run_transaction_sandbox",
    description:
      "Runs supported SQL in a transaction RelataSQL always rolls back. PostgreSQL and SQL Server support rollback-safe operations according to their capabilities; MySQL is intentionally fail-closed and only accepts operations whose rollback safety can be proven. Requires active MCP/JIT access.",
    inputSchema: {
      type: "object",
      properties: {
        connectionId: {
          type: "string",
          description: "Target connection id.",
        },
        sql: { type: "string", description: "SQL operation to simulate." },
        justification: {
          type: "string",
          description: "Reason for the simulation, retained in audit telemetry.",
        },
      },
      required: ["connectionId", "sql", "justification"],
      additionalProperties: false,
    },
  },
  {
    name: "request_write_operation",
    description:
      "Creates a human approval request for a write or destructive SQL operation. The exact SQL is persisted by RelataSQL and cannot be changed at execution time. After this call, tell the user the approvalId and wait for physical approval in RelataSQL before checking and executing it.",
    inputSchema: {
      type: "object",
      properties: {
        connectionId: { type: "string", description: "Target connection id." },
        sql: {
          type: "string",
          description: "Exact SQL mutation requiring human approval.",
        },
        justification: {
          type: "string",
          description: "Why the mutation is required.",
        },
        operationSummary: {
          type: "string",
          description: "Optional short title shown in the approval UI.",
        },
      },
      required: ["connectionId", "sql", "justification"],
      additionalProperties: false,
    },
  },
  {
    name: "check_write_approval",
    description:
      "Checks approval and one-shot usage state for a previously requested write operation.",
    inputSchema: {
      type: "object",
      properties: {
        approvalId: {
          type: "string",
          description: "Approval id returned by request_write_operation.",
        },
      },
      required: ["approvalId"],
      additionalProperties: false,
    },
  },
  {
    name: "execute_approved_operation",
    description:
      "Executes a previously approved write by approvalId only. This tool never accepts SQL. RelataSQL loads the persisted SQL, verifies APPROVED + UNUSED, enforces current access and authorization, and allows one execution.",
    inputSchema: {
      type: "object",
      properties: {
        approvalId: {
          type: "string",
          description: "Approved id returned by request_write_operation.",
        },
      },
      required: ["approvalId"],
      additionalProperties: false,
    },
  },
  {
    name: "submit_agent_feedback",
    description:
      "End-of-task product feedback for RelataSQL. Call once after database work is complete. Do not include credentials, sensitive data or PII; summarize the objective, how RelataSQL helped, and capabilities that were missing.",
    inputSchema: {
      type: "object",
      properties: {
        objective: { type: "string" },
        relataContribution: { type: "string" },
        missingFeatures: { type: "string" },
      },
      required: ["objective", "relataContribution", "missingFeatures"],
      additionalProperties: false,
    },
  },
] as const;

export function createRelataMcpServer(
  apiClient: RelataApiClient,
  initialCatalog?: DatabaseCapabilitiesCatalog,
): Server {
  let capabilitiesCache:
    | { catalog: DatabaseCapabilitiesCatalog; expiresAt: number }
    | undefined = initialCatalog
    ? {
        catalog: initialCatalog,
        expiresAt: Date.now() + CAPABILITIES_TTL_MS,
      }
    : undefined;
  let capabilitiesInFlight: Promise<DatabaseCapabilitiesCatalog> | undefined;

  const loadCapabilities = async (): Promise<DatabaseCapabilitiesCatalog> => {
    const now = Date.now();
    if (capabilitiesCache && capabilitiesCache.expiresAt > now) {
      return capabilitiesCache.catalog;
    }
    if (capabilitiesInFlight) return capabilitiesInFlight;

    capabilitiesInFlight = apiClient
      .getDatabaseCapabilities()
      .then(parseDatabaseCapabilities)
      .then((catalog) => {
        capabilitiesCache = {
          catalog,
          expiresAt: Date.now() + CAPABILITIES_TTL_MS,
        };
        return catalog;
      })
      .finally(() => {
        capabilitiesInFlight = undefined;
      });
    return capabilitiesInFlight;
  };

  const server = new Server(
    { name: "relatasql-mcp", version: RELATASQL_MCP_VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const catalog = await loadCapabilities();
    return { tools: withCapabilityDescriptions(TOOL_DEFINITIONS, catalog) };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: rawArgs } = request.params;
    try {
      switch (name) {
        case "list_connections":
          return toolJson(await apiClient.listConnections());
        case "get_schema": {
          const { connectionId } = GetSchemaInput.parse(rawArgs ?? {});
          return toolJson(await apiClient.getSchema(connectionId));
        }
        case "get_relations": {
          const { connectionId } = GetRelationsInput.parse(rawArgs ?? {});
          return toolJson(await apiClient.getRelations(connectionId));
        }
        case "sample_rows": {
          const { connectionId, schema, table, limit } = SampleRowsInput.parse(
            rawArgs ?? {},
          );
          return toolJson(
            await apiClient.sampleRows(connectionId, { schema, table, limit }),
          );
        }
        case "execute_query": {
          const { connectionId, sql } = ExecuteQueryInput.parse(rawArgs ?? {});
          return toolJson(await apiClient.executeQuery(connectionId, sql));
        }
        case "run_transaction_sandbox": {
          const { connectionId, sql, justification } =
            RunTransactionSandboxInput.parse(rawArgs ?? {});
          return toolJson(
            await apiClient.runTransactionSandbox(connectionId, {
              sql,
              justification,
            }),
          );
        }
        case "request_write_operation": {
          const { connectionId, sql, justification, operationSummary } =
            RequestWriteOperationInput.parse(rawArgs ?? {});
          return toolJson(
            await apiClient.requestWriteApproval(connectionId, {
              sql,
              justification,
              operationSummary,
            }),
          );
        }
        case "check_write_approval": {
          const { approvalId } = CheckWriteApprovalInput.parse(rawArgs ?? {});
          return toolJson(await apiClient.checkWriteApproval(approvalId));
        }
        case "execute_approved_operation": {
          const { approvalId } = CheckWriteApprovalInput.parse(rawArgs ?? {});
          return toolJson(await apiClient.executeApprovedOperation(approvalId));
        }
        case "submit_agent_feedback": {
          const feedback = SubmitFeedbackInput.parse(rawArgs ?? {});
          await apiClient.submitTelemetry(feedback);
          return toolJson({
            status: "saved",
            message: "Telemetry saved. Thank you for helping improve RelataSQL!",
          });
        }
        default:
          return toolError(`Unknown tool: ${name}`);
      }
    } catch (error) {
      return toolError(describeError(error));
    }
  });

  return server;
}

function toolJson(payload: unknown) {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(payload, null, 2) },
    ],
  };
}

function toolError(message: string) {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify({ error: message }, null, 2) },
    ],
    isError: true,
  };
}

function describeError(error: unknown): string {
  if (error instanceof z.ZodError) {
    return `Invalid arguments: ${error.issues
      .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
      .join("; ")}`;
  }
  if (error instanceof RelataApiError) {
    return `RelataSQL API error (${error.status}): ${error.message}`;
  }
  if (error instanceof Error) return error.message;
  return "Unknown error";
}
