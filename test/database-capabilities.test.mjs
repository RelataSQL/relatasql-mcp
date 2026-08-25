import assert from "node:assert/strict";
import test from "node:test";

import {
  parseDatabaseCapabilities,
  supportedEnginesForTool,
  withCapabilityDescriptions,
} from "../dist/database-capabilities.js";

const ENGINES = ["postgres", "mysql", "mssql"];
const CAPABILITIES = [
  "console",
  "schema",
  "rows",
  "ddl",
  "dump",
  "backup",
  "restore",
  "transfer",
  "mcp",
  "copilot_tools",
  "audit",
  "sql_table_analysis",
];
const cells = CAPABILITIES.flatMap((capability) =>
  ENGINES.map((engine) => ({
    engine,
    capability,
    status: "blocked",
    rejectionCode: "TEST_BLOCKED",
    reason: "fixture",
    ownerPlan: "MEGA-2026-003-P1",
    exitCriterion: "fixture",
  })),
);
function replace(engine, capability, value) {
  const index = cells.findIndex(
    (cell) => cell.engine === engine && cell.capability === capability,
  );
  cells[index] = { engine, capability, ...value };
}
replace("postgres", "mcp", { status: "available" });
replace("mysql", "mcp", {
  status: "partial",
  operations: [
    "list_connections",
    "get_schema",
    "get_relations",
    "sample_rows",
    "execute_query",
    "run_transaction_sandbox",
    "request_write_operation",
    "execute_approved_operation",
    "create_dump",
    "backups",
  ],
  reason: "partial",
  ownerPlan: "MEGA-2026-003-P7",
  exitCriterion: "real tests",
});
replace("mssql", "mcp", {
  status: "partial",
  operations: [
    "list_connections",
    "get_schema",
    "get_relations",
    "sample_rows",
    "execute_query",
    "run_transaction_sandbox",
    "request_write_operation",
    "execute_approved_operation",
    "backups",
  ],
  reason: "partial",
  ownerPlan: "MEGA-2026-003-P7",
  exitCriterion: "real tests",
});

const CATALOG = {
  version: 2,
  engines: ENGINES,
  capabilities: CAPABILITIES,
  cells,
};

test("only advertises engines that support the specific public tool", () => {
  const catalog = parseDatabaseCapabilities(CATALOG);
  assert.deepEqual(supportedEnginesForTool(catalog, "get_schema"), ENGINES);
  assert.deepEqual(supportedEnginesForTool(catalog, "execute_query"), [
    "postgres",
    "mysql",
    "mssql",
  ]);
  assert.deepEqual(supportedEnginesForTool(catalog, "list_connections"), [
    "postgres",
    "mysql",
    "mssql",
  ]);
});

test("partial MCP support unlocks only operations explicitly verified", () => {
  const catalog = parseDatabaseCapabilities(CATALOG);
  for (const tool of [
    "get_relations",
    "sample_rows",
    "run_transaction_sandbox",
    "request_write_operation",
    "execute_approved_operation",
  ]) {
    assert.deepEqual(supportedEnginesForTool(catalog, tool), ENGINES);
  }
});

test("tool descriptions state the live engine support", () => {
  const catalog = parseDatabaseCapabilities(CATALOG);
  const tools = withCapabilityDescriptions(
    [
      {
        name: "get_schema",
        description: "Schema",
        inputSchema: { type: "object" },
      },
      {
        name: "list_connections",
        description: "Connections",
        inputSchema: { type: "object" },
      },
    ],
    catalog,
  );
  assert.match(
    tools[0].description,
    /Supported engines: postgres, mysql, mssql\./,
  );
  assert.match(
    tools[1].description,
    /Supported engines: postgres, mysql, mssql\./,
  );
});

test("accepts known additive versions and rejects unknown contracts", () => {
  assert.equal(
    parseDatabaseCapabilities({ ...CATALOG, version: 1 }).version,
    1,
  );
  assert.equal(parseDatabaseCapabilities(CATALOG).version, 2);
  assert.throws(
    () => parseDatabaseCapabilities({ ...CATALOG, version: 3 }),
    /version/i,
  );
  assert.throws(
    () =>
      parseDatabaseCapabilities({
        ...CATALOG,
        cells: cells.filter(
          (cell) => !(cell.engine === "mssql" && cell.capability === "mcp"),
        ),
      }),
    /mssql.*mcp/i,
  );
});
