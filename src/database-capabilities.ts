export const DATABASE_CAPABILITIES_VERSION = 2 as const;
export const SUPPORTED_DATABASE_CAPABILITIES_VERSIONS = [1, 2] as const;
type DatabaseCapabilitiesVersion =
  (typeof SUPPORTED_DATABASE_CAPABILITIES_VERSIONS)[number];

type Engine = "postgres" | "mysql" | "mssql";
type CapabilityStatus = "available" | "partial" | "blocked" | "not_offered";

type CapabilityCell = {
  engine: Engine;
  capability: string;
  status: CapabilityStatus;
  operations?: string[];
};

export type DatabaseCapabilitiesCatalog = {
  version: DatabaseCapabilitiesVersion;
  engines: Engine[];
  capabilities: string[];
  cells: CapabilityCell[];
};

type ToolDefinition = {
  name: string;
  description?: string;
  inputSchema: unknown;
};

const ENGINES: readonly Engine[] = ["postgres", "mysql", "mssql"];
const STATUSES: readonly CapabilityStatus[] = [
  "available",
  "partial",
  "blocked",
  "not_offered",
];

const TOOL_MCP_OPERATION: Readonly<Record<string, string | null>> = {
  list_connections: "list_connections",
  get_schema: "get_schema",
  get_relations: "get_relations",
  sample_rows: "sample_rows",
  execute_query: "execute_query",
  run_transaction_sandbox: "run_transaction_sandbox",
  request_write_operation: "request_write_operation",
  check_write_approval: null,
  execute_approved_operation: "execute_approved_operation",
  submit_agent_feedback: null,
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function parseDatabaseCapabilities(
  value: unknown,
): DatabaseCapabilitiesCatalog {
  if (
    !isRecord(value) ||
    !SUPPORTED_DATABASE_CAPABILITIES_VERSIONS.includes(
      value.version as DatabaseCapabilitiesVersion,
    )
  ) {
    throw new Error(
      `Unsupported database capabilities version: ${String(isRecord(value) ? value.version : undefined)}`,
    );
  }
  if (
    !Array.isArray(value.capabilities) ||
    !value.capabilities.includes("mcp")
  ) {
    throw new Error("Database capabilities do not include MCP");
  }
  if (!Array.isArray(value.cells)) {
    throw new Error("Database capability cells are missing");
  }

  const cells = value.cells.map((candidate): CapabilityCell => {
    if (!isRecord(candidate))
      throw new Error("Invalid database capability cell");
    const engine = candidate.engine as Engine;
    const status = candidate.status as CapabilityStatus;
    if (!ENGINES.includes(engine)) {
      throw new Error(`Unknown database engine: ${String(engine)}`);
    }
    if (typeof candidate.capability !== "string") {
      throw new Error(`Invalid capability for ${engine}`);
    }
    if (!STATUSES.includes(status)) {
      throw new Error(`Invalid capability status for ${engine}`);
    }
    if (
      candidate.operations !== undefined &&
      (!Array.isArray(candidate.operations) ||
        !candidate.operations.every(
          (operation) => typeof operation === "string",
        ))
    ) {
      throw new Error(`Invalid capability operations for ${engine}`);
    }
    return candidate as CapabilityCell;
  });

  for (const engine of ENGINES) {
    const matches = cells.filter(
      (cell) => cell.engine === engine && cell.capability === "mcp",
    );
    if (matches.length !== 1) {
      throw new Error(
        `Database capabilities require exactly one ${engine} mcp cell`,
      );
    }
  }

  return {
    version: value.version as DatabaseCapabilitiesVersion,
    engines: [...ENGINES],
    capabilities: [...value.capabilities] as string[],
    cells,
  };
}

export function supportedEnginesForTool(
  catalog: DatabaseCapabilitiesCatalog,
  toolName: string,
): Engine[] {
  const operation = TOOL_MCP_OPERATION[toolName];
  if (operation === undefined) {
    throw new Error(`Unknown MCP tool capability: ${toolName}`);
  }
  if (operation === null) return [...ENGINES];

  return ENGINES.filter((engine) => {
    const cell = catalog.cells.find(
      (candidate) =>
        candidate.engine === engine && candidate.capability === "mcp",
    );
    if (!cell) return false;
    if (cell.status === "available") return true;
    return cell.status === "partial" && cell.operations?.includes(operation);
  });
}

export function withCapabilityDescriptions<T extends ToolDefinition>(
  tools: readonly T[],
  catalog: DatabaseCapabilitiesCatalog,
): Array<T & { description: string }> {
  return tools.map((tool) => {
    const engines = supportedEnginesForTool(catalog, tool.name);
    const support = `Supported engines: ${engines.join(", ")}.`;
    return {
      ...tool,
      description: `${tool.description?.trim() ?? ""} ${support}`.trim(),
    };
  });
}
