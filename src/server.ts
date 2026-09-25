import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  RelataApiClient,
  RelataApiError,
  SchemaDiscoveryUnsupportedError,
} from "./relata-api-client.js";
import {
  parseDatabaseCapabilities,
  schemaDiscoveryEngines,
  withCapabilityDescriptions,
  type DatabaseCapabilitiesCatalog,
} from "./database-capabilities.js";

export const RELATASQL_MCP_VERSION = "1.3.0";
const CAPABILITIES_TTL_MS = 5 * 60 * 1000;

/** An existing schema or table name: 1 to 128 characters, used verbatim. */
const IDENTIFIER_MAX = 128;
const QUERY_MAX = 120;
const PAGE_MAX = 200;
const CURSOR_MAX = 4096;
const identifier = (field: string) =>
  z
    .string()
    .min(1, `${field} must not be empty`)
    .max(IDENTIFIER_MAX, `${field} is limited to ${IDENTIFIER_MAX} characters`);
const pageLimit = z.number().int().min(1).max(PAGE_MAX);
const cursor = z.string().min(1).max(CURSOR_MAX);

const GetSchemaInput = z.object({
  connectionId: z.string().min(1, "connectionId is required"),
  mode: z.enum(["schemas", "tables", "table"]).optional(),
  schema: identifier("schema").optional(),
  query: z.string().max(QUERY_MAX).optional(),
  table: identifier("table").optional(),
  limit: pageLimit.optional(),
  cursor: cursor.optional(),
});
const GetRelationsInput = z.object({
  connectionId: z.string().min(1, "connectionId is required"),
  schema: identifier("schema").optional(),
  table: identifier("table").optional(),
  direction: z.enum(["outgoing", "incoming", "both"]).optional(),
  limit: pageLimit.optional(),
  cursor: cursor.optional(),
});

/** get_schema/get_relations arguments beyond connectionId. */
const hasDiscoveryArguments = (input: Record<string, unknown>) =>
  Object.entries(input).some(
    ([key, value]) => key !== "connectionId" && value !== undefined,
  );

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
      "Retrieves tables, columns, types, nullability and primary keys for a connection. Requires active per-connection MCP/JIT access. With only connectionId it returns the whole database at once. On databases with many schemas, use the discovery arguments instead: mode \"schemas\" lists schemas with their table counts; schema and/or query list tables page by page; table (with schema) returns one table's columns, keys and incoming/outgoing foreign keys, or where a table with that name exists. Pass schema and table as separate arguments and never join them with a dot. Continue a listing by sending only its nextCursor.",
    inputSchema: {
      type: "object",
      properties: {
        connectionId: {
          type: "string",
          description: "Connection id returned by list_connections.",
        },
        mode: {
          type: "string",
          enum: ["schemas", "tables", "table"],
          description:
            "schemas: list schemas; tables: list tables (the default when schema or query is given); table: one table's detail (the default when table is given). Without mode, a cursor continues the listing it came from.",
        },
        schema: {
          type: "string",
          minLength: 1,
          maxLength: IDENTIFIER_MAX,
          description:
            "Exact schema name. For tables it filters the listing; for a table it defaults to the engine's default schema (public, dbo or the connected MySQL database).",
        },
        query: {
          type: "string",
          maxLength: QUERY_MAX,
          description:
            "Case-insensitive text contained in schema names (mode schemas) or in schema.table (mode tables). Not accepted with table.",
        },
        table: {
          type: "string",
          minLength: 1,
          maxLength: IDENTIFIER_MAX,
          description: "Exact table name, without its schema.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: PAGE_MAX,
          description:
            "Page size of a listing, not accepted with table. Defaults to 100 schemas or 50 tables.",
        },
        cursor: {
          type: "string",
          maxLength: CURSOR_MAX,
          description:
            "page.nextCursor of the previous page. Send it alone to continue the same listing.",
        },
      },
      required: ["connectionId"],
      additionalProperties: false,
    },
  },
  {
    name: "get_relations",
    description:
      "Retrieves foreign-key relationships for a connection. Requires active per-connection MCP/JIT access. With only connectionId it returns every foreign key column by column. With discovery arguments it returns whole foreign keys (composite ones with their columns in order) page by page, filtered by schema and table on the referencing side, the referenced side or both.",
    inputSchema: {
      type: "object",
      properties: {
        connectionId: {
          type: "string",
          description: "Connection id returned by list_connections.",
        },
        schema: {
          type: "string",
          minLength: 1,
          maxLength: IDENTIFIER_MAX,
          description:
            "Exact schema name. With a table and no schema, the engine's default schema.",
        },
        table: {
          type: "string",
          minLength: 1,
          maxLength: IDENTIFIER_MAX,
          description: "Exact table name, without its schema.",
        },
        direction: {
          type: "string",
          enum: ["outgoing", "incoming", "both"],
          description:
            "outgoing: keys defined on the filter; incoming: keys pointing to it; both (default).",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: PAGE_MAX,
          description: "Foreign keys per page. Defaults to 50.",
        },
        cursor: {
          type: "string",
          maxLength: CURSOR_MAX,
          description:
            "page.nextCursor of the previous page. Send it alone to continue the same listing.",
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

  const forgetCapabilities = () => {
    capabilitiesCache = undefined;
  };

  /**
   * Discovery arguments only travel to a backend that explicitly lists
   * schema_discovery_v1. An older backend would ignore them and answer with
   * the whole database, which is not what the agent asked for.
   */
  const assertSchemaDiscovery = async (): Promise<void> => {
    const catalog = await loadCapabilities();
    if (schemaDiscoveryEngines(catalog).length === 0) {
      throw new SchemaDiscoveryUnsupportedError();
    }
  };

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
          const input = GetSchemaInput.parse(rawArgs ?? {});
          if (!hasDiscoveryArguments(input)) {
            return toolJson(await apiClient.getSchema(input.connectionId));
          }
          const { connectionId, schema, query, table, limit } = input;
          const target = schemaDiscoveryTarget(input);
          await assertSchemaDiscovery();
          if (target === "continue") {
            return toolJson(
              await apiClient.continueSchemaListing(connectionId, {
                cursor: input.cursor!,
                schema,
                query,
                limit,
              }),
            );
          }
          if (target === "table") {
            return toolJson(
              await apiClient.describeTable(connectionId, {
                schema,
                table: table!,
              }),
            );
          }
          if (target === "schemas") {
            return toolJson(
              await apiClient.listSchemas(connectionId, {
                query,
                limit,
                cursor: input.cursor,
              }),
            );
          }
          return toolJson(
            await apiClient.listTables(connectionId, {
              schema,
              query,
              limit,
              cursor: input.cursor,
            }),
          );
        }
        case "get_relations": {
          const input = GetRelationsInput.parse(rawArgs ?? {});
          if (!hasDiscoveryArguments(input)) {
            return toolJson(await apiClient.getRelations(input.connectionId));
          }
          await assertSchemaDiscovery();
          const { connectionId, ...params } = input;
          return toolJson(await apiClient.getRelationsPage(connectionId, params));
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
      // A missing route means the capabilities we cached are no longer this
      // backend's (a rollback or a rolling deploy): read them again next time.
      if (error instanceof SchemaDiscoveryUnsupportedError) forgetCapabilities();
      return toolError(describeError(error), errorDetails(error));
    }
  });

  return server;
}

/**
 * Which discovery call a get_schema call asks for. A table means its detail;
 * mode schemas lists schemas; a cursor without a mode continues whichever
 * listing it came from (only the backend can read the cursor, so it decides);
 * anything else lists tables. Contradictory combinations are rejected like
 * any other invalid argument.
 */
function schemaDiscoveryTarget(input: {
  mode?: "schemas" | "tables" | "table";
  schema?: string;
  query?: string;
  table?: string;
  limit?: number;
  cursor?: string;
}): "schemas" | "tables" | "table" | "continue" {
  const invalid = (message: string) =>
    new z.ZodError([{ code: "custom", path: ["mode"], message }]);
  const target =
    input.mode ??
    (input.table !== undefined
      ? "table"
      : input.cursor !== undefined
        ? "continue"
        : "tables");
  if (target === "table") {
    if (input.table === undefined) {
      throw invalid('mode "table" needs table');
    }
    if (input.cursor !== undefined) {
      throw invalid('mode "table" is not paged; do not send cursor');
    }
    // A detail is one exact table: a search text or a page size would be
    // silently ignored, and the agent would believe it filtered something.
    if (input.query !== undefined || input.limit !== undefined) {
      throw invalid(
        'mode "table" reads one table; it takes only schema and table, not query or limit',
      );
    }
  } else if (input.table !== undefined) {
    throw invalid(`mode "${target}" does not take table`);
  }
  if (target === "schemas" && input.schema !== undefined) {
    throw invalid('mode "schemas" does not take schema');
  }
  return target;
}

function toolJson(payload: unknown) {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(payload, null, 2) },
    ],
  };
}

function toolError(message: string, details: Record<string, unknown> = {}) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ error: message, ...details }, null, 2),
      },
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
    const code = backendErrorCode(error);
    return `RelataSQL API error (${error.status}${code ? `, ${code}` : ""}): ${error.message}`;
  }
  if (error instanceof Error) return error.message;
  return "Unknown error";
}

/** The backend's stable error code, when its body carries one. */
function backendErrorCode(error: RelataApiError): string | undefined {
  const body = error.body;
  if (body && typeof body === "object" && "code" in body) {
    const code = (body as { code: unknown }).code;
    if (typeof code === "string" && code.length > 0) return code;
  }
  return undefined;
}

/**
 * Structured fields an agent can act on: the backend code and, for a table
 * that is not where it was asked for, where tables with that name exist.
 */
function errorDetails(error: unknown): Record<string, unknown> {
  if (error instanceof SchemaDiscoveryUnsupportedError) {
    return { code: "SCHEMA_DISCOVERY_UNSUPPORTED" };
  }
  if (!(error instanceof RelataApiError)) return {};
  const code = backendErrorCode(error);
  const body = error.body as { candidates?: unknown } | null;
  return {
    ...(code && { code }),
    ...(body &&
      typeof body === "object" &&
      Array.isArray(body.candidates) && { candidates: body.candidates }),
  };
}
