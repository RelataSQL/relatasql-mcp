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
  operations: ["list_connections", "create_dump", "backups"],
  reason: "partial",
  ownerPlan: "MEGA-2026-003-P7",
  exitCriterion: "real tests",
});
replace("mssql", "mcp", {
  status: "partial",
  operations: ["list_connections"],
  reason: "partial",
  ownerPlan: "MEGA-2026-003-P7",
  exitCriterion: "real tests",
});

const CATALOG = {
  version: 1,
  engines: ENGINES,
  capabilities: CAPABILITIES,
  cells,
};

test("only advertises engines that support the specific public tool", () => {
  const catalog = parseDatabaseCapabilities(CATALOG);
  assert.deepEqual(supportedEnginesForTool(catalog, "get_schema"), ["postgres"]);
  assert.deepEqual(supportedEnginesForTool(catalog, "execute_query"), [
    "postgres",
  ]);
  assert.deepEqual(supportedEnginesForTool(catalog, "list_connections"), [
    "postgres",
    "mysql",
    "mssql",
  ]);
});

test("partial MCP support does not unlock unrelated tools", () => {
  const catalog = parseDatabaseCapabilities(CATALOG);
  for (const tool of [
    "get_relations",
    "sample_rows",
    "run_transaction_sandbox",
    "request_write_operation",
    "execute_approved_operation",
  ]) {
    assert.equal(supportedEnginesForTool(catalog, tool).includes("mysql"), false);
  }
});

test("tool descriptions state the live engine support", () => {
  const catalog = parseDatabaseCapabilities(CATALOG);
  const tools = withCapabilityDescriptions(
    [
      { name: "get_schema", description: "Schema", inputSchema: { type: "object" } },
      {
        name: "list_connections",
        description: "Connections",
        inputSchema: { type: "object" },
      },
    ],
    catalog,
  );
  assert.match(tools[0].description, /Supported engines: postgres\./);
  assert.match(
    tools[1].description,
    /Supported engines: postgres, mysql, mssql\./,
  );
});

test("rejects a version or matrix that cannot be verified", () => {
  assert.throws(
    () => parseDatabaseCapabilities({ ...CATALOG, version: 2 }),
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
